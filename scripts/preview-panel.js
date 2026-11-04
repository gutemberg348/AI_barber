// Prévia isolada para desenvolvimento: banco em memória, sem WhatsApp ou APIs reais.
import pino from 'pino';
import QRCode from 'qrcode';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';

const config = loadConfig({ NODE_ENV: 'test', ADMIN_API_TOKEN: 'luna-preview-local-only-1234567890',
  DATA_ENCRYPTION_KEY: 'd'.repeat(64), OPENAI_API_KEY: 'preview-only', BARBEARIA_API_TOKEN: 'p'.repeat(64), BARBEARIA_NOME: 'Good Style · prévia' });
const store = new Store(':memory:', config.DATA_ENCRYPTION_KEY);
let state = 'disconnected'; let expiresAt = null;
const status = () => ({ state, connected: state === 'connected', qrAvailable: state === 'qr', qrExpiresAt: expiresAt, botEnabled: store.get('system', 'bot-enabled') !== false });
const whatsapp = {
  status,
  async connect() { state = 'qr'; expiresAt = new Date(Date.now() + 60000).toISOString(); return status(); },
  async disconnect() { state = 'disconnected'; return status(); },
  async logout() { state = 'logged_out'; return status(); },
  async qrCode() {
    if (state !== 'qr') return null;
    if (Date.parse(expiresAt) <= Date.now()) expiresAt = new Date(Date.now() + 60000).toISOString();
    return { qr: 'PREVIA SEM CONEXAO REAL', qrDataUrl: await QRCode.toDataURL('PREVIA SEM CONEXAO REAL'), expiresAt };
  },
};
const app = await buildApp({ config, store, whatsapp, logger: pino({ level: 'silent' }), api: { async request() { return { timezone: 'America/Sao_Paulo', barbeiros: [] }; } } });
await app.listen({ host: '127.0.0.1', port: 3467 });
console.log('Prévia isolada: http://127.0.0.1:3467/painel (sem dados ou conexões reais).');
async function stop() { await app.close(); store.close(); process.exit(0); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
