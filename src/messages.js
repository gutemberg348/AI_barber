import { jidNormalizedUser, normalizeMessageContent } from '@whiskeysockets/baileys';
import { botEnabled } from './bot-control.js';
import { audioFailureReply } from './audio.js';
import { contactControl, recordContact } from './contacts.js';

export function phoneFromJid(jid) {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  const phone = jidNormalizedUser(jid).split('@')[0];
  // A API do site aceita apenas números brasileiros. Nunca inferir telefone de um LID.
  return /^55\d{10,11}$/.test(phone) ? phone.slice(2) : null;
}

export async function incomingMessage(message, socket, config) {
  const jid = message.key?.remoteJid;
  if (!message.key?.id || message.key.fromMe || !jid || !/@(?:s\.whatsapp\.net|lid)$/.test(jid)) return null;
  const timestamp = Number(message.messageTimestamp) * 1000;
  if (!Number.isFinite(timestamp) || timestamp < Date.now() - config.MESSAGE_MAX_AGE_SECONDS * 1000 || timestamp > Date.now() + 60000) return null;
  const content = normalizeMessageContent(message.message);
  if (!content || content.protocolMessage || content.reactionMessage || content.senderKeyDistributionMessage) return null;
  let phone = phoneFromJid(jid) ?? phoneFromJid(message.key.remoteJidAlt);
  if (!phone && jid.endsWith('@lid')) {
    phone = phoneFromJid(await socket.signalRepository?.lidMapping?.getPNForLID(jid));
  }
  const text = content.conversation ?? content.extendedTextMessage?.text;
  const media = content.audioMessage || content.imageMessage || content.videoMessage || content.documentMessage || content.stickerMessage;
  if (!text && !media) return null;
  const audio = !text && content.audioMessage ? {
    key: { id: message.key.id, remoteJid: jid, fromMe: false, ...(message.key.remoteJidAlt ? { remoteJidAlt: message.key.remoteJidAlt } : {}) },
    message: { audioMessage: {
      url: content.audioMessage.url, directPath: content.audioMessage.directPath,
      mediaKey: content.audioMessage.mediaKey ? Buffer.from(content.audioMessage.mediaKey) : undefined,
      fileSha256: content.audioMessage.fileSha256 ? Buffer.from(content.audioMessage.fileSha256) : undefined,
      fileEncSha256: content.audioMessage.fileEncSha256 ? Buffer.from(content.audioMessage.fileEncSha256) : undefined,
      fileLength: Number(content.audioMessage.fileLength ?? 0), seconds: Number(content.audioMessage.seconds ?? 0),
      mimetype: content.audioMessage.mimetype, ptt: Boolean(content.audioMessage.ptt),
    } },
  } : null;
  return { id: `${phone ?? jid}:${message.key.id}`, jid, phone, text: text ?? '', unsupported: !text && !audio, ...(audio ? { audio } : {}), createdAt: Date.now() };
}

export class MessageProcessor {
  constructor({ store, luna, config, logger, transcriber }) {
    Object.assign(this, { store, luna, config, logger, transcriber });
    this.queue = [];
    this.queued = new Set();
    this.busy = new Set();
    this.active = 0;
    this.send = null;
    this.running = false;
  }
  setTransport(send, downloadAudio) {
    this.send = send;
    if (!send) this.downloadAudio = null;
    else if (downloadAudio) this.downloadAudio = downloadAudio;
    this.running = Boolean(send);
    if (send) {
      for (const item of this.store.entries('inbound')) {
        if (!['sent', 'ignored'].includes(item.state) && this.queue.length < this.config.MAX_PENDING_MESSAGES) this.enqueue(item);
      }
      this.pump();
    }
  }
  accept(item) {
    if (!item || this.store.get('inbound', item.id) || this.store.get('processed', item.id)) return;
    // Não acumula uma fila ilimitada durante indisponibilidade.
    if (this.store.count('inbound') >= this.config.MAX_PENDING_MESSAGES) {
      this.logger.warn({ event: 'queue_full' }, 'Fila cheia; mensagem ignorada');
      return;
    }
    item.state = 'received';
    if (item.phone) {
      const rate = this.store.get('rate', item.phone) ?? { start: Date.now(), count: 0 };
      if (Date.now() - rate.start >= 60000) { rate.start = Date.now(); rate.count = 0; }
      rate.count++;
      this.store.set('rate', item.phone, rate);
      if (rate.count > this.config.CHAT_MESSAGES_PER_MINUTE) {
        item.state = 'ignored';
        this.finish(item);
        return;
      }
      const contact = recordContact(this.store, item.phone);
      item.contactRevision = contact?.revision ?? 0;
    }
    this.store.set('inbound', item.id, item);
    this.enqueue(item);
    this.pump();
  }
  enqueue(item) {
    if (this.queued.has(item.id)) return;
    this.queue.push(item);
    this.queued.add(item.id);
  }
  finish(item) {
    this.store.transaction(() => {
      this.store.delete('inbound', item.id);
      this.store.set('processed', item.id, { state: item.state, completedAt: Date.now() });
    });
  }
  pump() {
    while (this.running && this.active < this.config.MAX_CONCURRENT_CHATS) {
      const index = this.queue.findIndex(m => !this.busy.has(m.phone ?? m.jid));
      if (index === -1) return;
      const [item] = this.queue.splice(index, 1);
      const key = item.phone ?? item.jid;
      this.busy.add(key);
      this.active++;
      this.process(item).catch(() => {
        this.logger.error({ event: 'message_failed' }, 'Falha ao processar mensagem; estado preservado');
      }).finally(() => {
        this.active--;
        this.busy.delete(key);
        this.queued.delete(item.id);
        this.pump();
      });
    }
  }
  restartConversation(item) {
    const pending = this.store.get('pending', item.phone);
    // Um timeout pode ter ocorrido depois de gravar no site. Não perder a chave de recuperação.
    if (pending?.state === 'executing') {
      return 'Seu último pedido ainda está sem resultado. Responda CONFIRMAR para conferir antes de reiniciar. Você pode continuar perguntando sobre serviços e horários.';
    }
    const oldReplies = this.store.entries('inbound').filter(message =>
      message.phone === item.phone && message.id !== item.id && message.state === 'reply_ready');
    this.store.transaction(() => {
      for (const scope of ['history', 'pending', 'paused']) this.store.delete(scope, item.phone);
      // Impede que uma resposta da conversa antiga volte após uma falha de envio.
      for (const message of oldReplies) {
        this.store.delete('inbound', message.id);
        this.store.set('processed', message.id, { state: 'ignored', completedAt: Date.now() });
      }
    });
    const discarded = new Set(oldReplies.map(message => message.id));
    this.queue = this.queue.filter(message => !discarded.has(message.id));
    for (const id of discarded) this.queued.delete(id);
    return 'Olá! Tudo bem? 💈';
  }
  discardForContact(item) {
    const contact = item.phone ? contactControl(this.store, item.phone) : null;
    if (contact?.enabled !== false && (item.contactRevision ?? 0) === (contact?.revision ?? 0)) return false;
    // A pausa invalida respostas antigas, inclusive se já foi retomado durante a geração.
    // Reservas/operações pendentes permanecem intactas.
    item.state = 'ignored';
    this.finish(item);
    return true;
  }
  async process(item) {
    if (this.discardForContact(item)) return;
    if (item.state !== 'reply_ready') {
      let command = item.text.trim().toLowerCase();
      if (!botEnabled(this.store, this.config.BARBEARIA_TIMEZONE) || (item.phone && this.store.get('paused', item.phone) && !['/voltar', '/parar', '/iniciar'].includes(command))) {
        item.state = 'ignored';
        this.finish(item);
        return;
      }
      if (item.audio && item.phone && !item.unsupported && Date.now() - item.createdAt <= 3600000) {
        try {
          if (!this.transcriber) throw new Error('audio_unavailable');
          item.text = await this.transcriber.transcribe(item.audio, this.downloadAudio);
        } catch (error) {
          item.audioReply = audioFailureReply(error, this.config);
          // Não registrar exceções do SDK, mídia, telefone ou transcrição.
          this.logger.warn({ event: 'audio_transcription_failed' }, 'Não foi possível interpretar o áudio');
        }
        delete item.audio;
        // Após reinício, reutiliza a transcrição concluída antes de executar o agente.
        this.store.set('inbound', item.id, item);
        command = item.text.trim().toLowerCase();
      }
      if (this.discardForContact(item)) return;
      if (Date.now() - item.createdAt > 3600000) {
        item.reply = 'A conexão caiu. Pode mandar seu pedido de novo?';
      } else if (!item.phone) {
        item.reply = `Não consegui identificar seu número. Use o site: ${this.config.BARBEARIA_SITE_URL}`;
      } else if (item.audioReply) {
        item.reply = item.audioReply;
      } else if (item.unsupported) {
        item.reply = 'Pode enviar seu pedido por texto ou áudio? Não consigo interpretar esse tipo de mensagem. 💈';
      } else {
        if (command === '/iniciar') {
          item.reply = this.restartConversation(item);
        } else if (command === '/parar') {
          this.store.set('paused', item.phone, true);
          item.reply = 'Atendimento pausado. Envie /voltar para retomar.';
        } else if (command === '/voltar') {
          this.store.delete('paused', item.phone);
          item.reply = 'Voltei! Como posso ajudar? 💈';
        } else if (this.store.get('paused', item.phone) || !botEnabled(this.store, this.config.BARBEARIA_TIMEZONE)) {
          item.state = 'ignored';
          this.finish(item);
          return;
        } else if (item.text.length > 4000) {
          item.reply = 'Pode resumir seu pedido em até 4.000 caracteres?';
        } else {
          try {
            const metadata = { receivedAt: item.createdAt };
            item.reply = await this.luna.reply(item.text, item.phone, metadata);
            if (metadata.scheduleQuery) item.scheduleQuery = metadata.scheduleQuery;
            if (metadata.scheduleNotice) item.scheduleNotice = metadata.scheduleNotice;
            if (metadata.catalog) item.catalog = metadata.catalog;
            if (metadata.scheduleSelection) item.scheduleSelection = metadata.scheduleSelection;
          }
          catch {
            this.logger.warn({ event: 'luna_failed' }, 'Consulta da Luna falhou');
            item.reply = 'Não consegui concluir esta etapa agora. Podemos tentar novamente por aqui? 💈';
          }
        }
      }
      if (this.discardForContact(item)) return;
      item.state = 'reply_ready';
      item.replyGeneratedAt = Date.now();
      // Resposta e histórico persistem juntos, antes de enviar ao WhatsApp.
      this.store.transaction(() => {
        this.store.set('inbound', item.id, item);
        if (item.phone) this.luna.remember(item.phone, item.text.slice(0, 4000), item.reply, {
          catalog: item.catalog, scheduleQuery: item.scheduleQuery, scheduleSelection: item.scheduleSelection,
        });
      });
    }
    if (this.discardForContact(item)) return;
    if (!this.running || !this.send || !botEnabled(this.store, this.config.BARBEARIA_TIMEZONE)) return;
    // Uma grade enfileirada pode ter mudado durante a queda da conexão.
    // Reconsultar apenas disponibilidade: nunca reexecutar o agendamento.
    if (item.scheduleQuery && (item.sendAttempted || Date.now() - (item.replyGeneratedAt ?? 0) > 30000)) {
      const previous = item.reply;
      try { item.reply = await this.luna.refreshSchedule(item.scheduleQuery, item.phone); }
      catch { item.reply = 'Não consegui atualizar os horários. Pode pedir a grade novamente?'; }
      if (item.scheduleNotice) item.reply = `${item.scheduleNotice}\n\n${item.reply}`;
      item.replyGeneratedAt = Date.now();
      this.store.transaction(() => {
        this.store.set('inbound', item.id, item);
        this.luna.replaceHistoricalReply(item.phone, previous, item.reply);
      });
    }
    if (this.discardForContact(item)) return;
    if (!this.running || !this.send || !botEnabled(this.store, this.config.BARBEARIA_TIMEZONE)) return;
    try {
      item.sendAttempted = true;
      this.store.set('inbound', item.id, item);
      await this.send(item.jid, item.reply);
      if (item.phone) this.luna.markReplyDelivered?.(item.phone, item.reply);
      item.state = 'sent';
      this.finish(item);
    } catch {
      // Será retomado na reconexão ou pelo temporizador do servidor, sem refazer a reserva.
      this.logger.warn({ event: 'whatsapp_send_failed' }, 'Resposta guardada para reenvio');
    }
  }
  async drain() {
    this.running = false;
    while (this.active > 0) await new Promise(resolve => setTimeout(resolve, 100));
  }
}
