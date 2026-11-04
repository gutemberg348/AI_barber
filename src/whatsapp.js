import makeWASocket, { Browsers, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { sqliteAuthState } from './auth-state.js';
import { incomingMessage } from './messages.js';

export class WhatsAppManager {
  constructor({ store, config, processor, logger, socketFactory = makeWASocket }) {
    Object.assign(this, { store, config, processor, logger, socketFactory });
    this.socket = null;
    this.state = 'disconnected';
    this.changedAt = new Date().toISOString();
    this.qr = null;
    this.retryCount = 0;
    this.manualStop = true;
    this.generation = 0;
    this.lastDisconnectCode = null;
    this.connectedAt = null;
  }
  change(state) { this.state = state; this.changedAt = new Date().toISOString(); }
  status() {
    return {
      state: this.state, connected: this.state === 'connected', changedAt: this.changedAt,
      connectedAt: this.connectedAt, qrAvailable: Boolean(this.qr && this.qr.expiresAt > Date.now()),
      qrExpiresAt: this.qr ? new Date(this.qr.expiresAt).toISOString() : null,
      lastDisconnectCode: this.lastDisconnectCode,
      botEnabled: this.store.get('system', 'bot-enabled') !== false,
    };
  }
  async qrCode() {
    const current = this.qr;
    if (!current || current.expiresAt <= Date.now()) return null;
    const image = await QRCode.toDataURL(current.value, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
    if (this.qr !== current || current.expiresAt <= Date.now()) return null;
    return { qr: current.value, qrDataUrl: image, expiresAt: new Date(current.expiresAt).toISOString() };
  }
  async printTerminalQr(current) {
    const rendered = await QRCode.toString(current.value, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
    if (this.qr !== current || current.expiresAt <= Date.now()) return;
    process.stdout.write('\nLuna — conecte o WhatsApp da barbearia\nAbra WhatsApp > Aparelhos conectados > Conectar um aparelho.\nLeia o QR Code abaixo (ele será atualizado quando necessário):\n\n' + rendered + '\n');
  }
  async connect() {
    if (this.socket || ['connecting', 'qr', 'connected'].includes(this.state)) return this.status();
    clearTimeout(this.retryTimer);
    this.manualStop = false;
    const generation = ++this.generation;
    this.qr = null;
    this.change('connecting');
    const auth = sqliteAuthState(this.store);
    try {
      const socket = this.socketFactory({
        auth: auth.state, browser: Browsers.ubuntu('Luna'),
        // Baileys pode registrar material sensível em logs internos. Não os encaminhamos.
        logger: pino({ level: 'silent' }), markOnlineOnConnect: false,
        syncFullHistory: false, shouldSyncHistoryMessage: () => false,
        qrTimeout: 60000, connectTimeoutMs: 30000,
        getMessage: async () => undefined,
      });
      this.socket = socket;
      socket.ev.on('creds.update', () => {
        if (generation === this.generation) auth.saveCreds();
      });
      socket.ev.on('connection.update', update => {
        if (generation !== this.generation || this.socket !== socket) return;
        this.onUpdate(update, socket).catch(() => this.logger.error({ event: 'connection_update_failed' }, 'Falha ao atualizar conexão'));
      });
      socket.ev.on('messages.upsert', event => {
        if (event.type !== 'notify' || generation !== this.generation) return;
        // Preserva a ordem do lote; cada telefone tem fila própria.
        this.incomingChain = (this.incomingChain ?? Promise.resolve()).then(async () => {
          for (const message of event.messages) {
            if (generation !== this.generation) break;
            const incoming = await incomingMessage(message, socket, this.config);
            this.processor.accept(incoming);
          }
        }).catch(() => this.logger.warn({ event: 'incoming_failed' }, 'Mensagem não pôde ser interpretada'));
      });
    } catch {
      this.socket = null;
      this.change('error');
      throw new Error('Falha ao iniciar WhatsApp.');
    }
    return this.status();
  }
  async onUpdate(update, socket) {
    if (update.qr) {
      this.qr = { value: update.qr, expiresAt: Date.now() + 60000 };
      this.change('qr');
      if (this.config.WHATSAPP_PRINT_QR) {
        this.printTerminalQr(this.qr).catch(() => this.logger.warn({ event: 'terminal_qr_failed' }, 'Não foi possível exibir o QR no terminal; use o endpoint de QR'));
      }
    }
    if (update.connection === 'open') {
      this.qr = null;
      this.retryCount = 0;
      this.connectedAt = new Date().toISOString();
      this.lastDisconnectCode = null;
      this.change('connected');
      this.processor.setTransport(async (jid, text) => {
        if (this.socket !== socket || this.state !== 'connected') throw new Error('WhatsApp desconectado');
        await socket.sendMessage(jid, { text });
      });
      this.logger.info({ event: 'whatsapp_connected' }, 'WhatsApp conectado');
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode ?? 0;
      this.lastDisconnectCode = code;
      this.qr = null;
      this.socket = null;
      this.connectedAt = null;
      this.processor.setTransport(null);
      if (code === DisconnectReason.loggedOut) {
        this.store.clear('auth');
        this.change('logged_out');
        this.manualStop = true;
        return;
      }
      if ([DisconnectReason.connectionReplaced, DisconnectReason.badSession, DisconnectReason.multideviceMismatch, DisconnectReason.forbidden].includes(code)) {
        this.change('error');
        this.manualStop = true;
        return;
      }
      if (this.manualStop) { this.change('disconnected'); return; }
      if (this.retryCount >= 10) { this.change('error'); this.retryCount = 0; return; }
      this.change('reconnecting');
      const delay = code === DisconnectReason.restartRequired ? 500 : Math.min(30000, 1000 * 2 ** this.retryCount++);
      this.retryTimer = setTimeout(() => this.connect().catch(() => this.logger.warn({ event: 'reconnect_failed' }, 'Reconexão falhou')), delay);
      this.retryTimer.unref?.();
    }
  }
  async disconnect() {
    this.manualStop = true;
    ++this.generation;
    clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = null;
    this.qr = null;
    this.connectedAt = null;
    this.processor.setTransport(null);
    this.change('disconnected');
    socket?.end(undefined);
    return this.status();
  }
  async logout() {
    if (this.socket) await this.socket.logout();
    await this.disconnect();
    this.store.clear('auth');
    this.change('logged_out');
    return this.status();
  }
}
