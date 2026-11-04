import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { knowledgeInstructions, panelSessions } from '../src/panel.js';
import { Luna } from '../src/luna.js';
import { BookingService } from '../src/booking.js';
import { MessageProcessor } from '../src/messages.js';
import { config, logger, memoryStore, fakeApi, phone, idle } from './helpers.js';

const lesson = { id: '12345678-1234-4234-8234-123456789012', title: 'Como chegar', content: 'Estamos ao lado da praça.', category: 'informacoes', enabled: true };
async function setup(t) {
  const store = memoryStore(); const c = config();
  const whatsapp = { status: () => ({ state: 'connected', connected: true, botEnabled: store.get('system', 'bot-enabled') !== false }), qrCode: async () => ({ qr: 'private-qr', qrDataUrl: 'data:image/png;base64,AA==', expiresAt: new Date().toISOString() }), connect() {}, disconnect() {}, logout() {} };
  const app = await buildApp({ config: c, store, whatsapp, logger, api: fakeApi() });
  t.after(async () => { await app.close(); store.close(); });
  const headers = { authorization: `Bearer ${c.ADMIN_API_TOKEN}` };
  return { store, app, headers, c };
}
test('painel serve somente assets públicos e exige autenticação para dados, QR e ensinamentos', async t => {
  const { app, c } = await setup(t);
  for (const url of ['/', '/painel', '/painel/', '/painel/app.js', '/painel/style.css', '/painel/icon.svg']) {
    const result = await app.inject(url); assert.equal(result.statusCode, 200); assert.doesNotMatch(result.body, new RegExp(c.ADMIN_API_TOKEN));
  }
  for (const url of ['/api/v1/panel/overview', '/api/v1/panel/teachings', '/api/v1/whatsapp/qrcode', '/.env', '/src/server.js']) assert.equal((await app.inject(url)).statusCode, 401);
  const page = await app.inject('/painel'); assert.match(page.headers['content-security-policy'], /script-src 'self'/); assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
});
test('login usa cookie HttpOnly; mutação exige cabeçalho e logout invalida sessão', async t => {
  const { app, headers, store } = await setup(t);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/panel/session', payload: {} })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/v1/panel/session', headers, payload: {} });
  assert.equal(login.statusCode, 200); assert.match(login.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  const cookie = login.headers['set-cookie'].split(';')[0];
  const auth = { cookie, 'x-luna-panel': '1' };
  assert.equal((await app.inject({ url: '/api/v1/panel/overview', headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/v1/whatsapp/qrcode', headers: auth })).json().qr, 'private-qr');
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/bot', headers: { cookie }, payload: { enabled: false } })).statusCode, 403);
  const paused = await app.inject({ method: 'PUT', url: '/api/v1/bot', headers: auth, payload: { enabled: false } });
  assert.equal(paused.json().botEnabled, false); assert.equal(store.get('system', 'bot-enabled'), false);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/panel/session', headers: auth })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/v1/panel/overview', headers: auth })).statusCode, 401);
});
test('cookie de produção exige HTTPS e sessão expirada é recusada', () => {
  const sessions = panelSessions({ NODE_ENV: 'production' }); let cookie;
  sessions.create({ header(name, value) { cookie = value; } });
  assert.match(cookie, /^__Host-luna_panel=/); assert.match(cookie, /; Secure$/);
  const request = { headers: { cookie: cookie.split(';')[0] } };
  assert.equal(sessions.valid(request), true);
  const original = Date.now;
  try { Date.now = () => original() + 9 * 3600000; assert.equal(sessions.valid(request), false); }
  finally { Date.now = original; }
});
test('ensinamentos persistem, aplicam somente ativos e impedem sobrescrita concorrente', async t => {
  const { app, headers, store } = await setup(t);
  const initial = await app.inject({ url: '/api/v1/panel/teachings', headers }); assert.deepEqual(initial.json().lessons, []);
  const update = await app.inject({ method: 'PUT', url: '/api/v1/panel/teachings', headers, payload: { revision: 0, lessons: [lesson] } });
  assert.equal(update.statusCode, 200); assert.equal(update.json().revision, 1); assert.match(knowledgeInstructions(store), /ao lado da praça/);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/panel/teachings', headers, payload: { revision: 0, lessons: [] } })).statusCode, 409);
  assert.equal(store.get('system', 'knowledge').lessons.length, 1);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/panel/teachings', headers, payload: { revision: 1, lessons: [{ ...lesson, enabled: false }] } })).statusCode, 200);
  assert.equal(knowledgeInstructions(store), '');
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/panel/teachings', headers, payload: { revision: 2, lessons: [{ ...lesson, content: '' }] } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/panel/teachings', headers, payload: { revision: 2, lessons: [lesson, lesson] } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/panel/teachings', headers, payload: { revision: 2, lessons: [] } })).statusCode, 200);
  assert.equal(store.get('system', 'knowledge').lessons.length, 0);
});
test('visão geral usa contagens reais sem expor conversas, clientes ou segredos', async t => {
  const { app, headers, store, c } = await setup(t);
  store.set('history', phone, { updatedAt: Date.now(), messages: [{ role: 'user', content: 'Mensagem privada de cliente' }] });
  store.set('pending', phone, { state: 'executing', payload: { nome: 'Nome privado', telefone: phone } });
  const result = await app.inject({ url: '/api/v1/panel/overview', headers });
  assert.equal(result.json().counts.conversations, 1); assert.equal(result.json().counts.uncertain, 1);
  for (const secret of [phone, 'Mensagem privada', 'Nome privado', c.ADMIN_API_TOKEN, c.BARBEARIA_API_TOKEN]) assert.ok(!result.body.includes(secret));
});
test('Luna incorpora alterações dos ensinamentos nas próximas respostas sem reiniciar', async t => {
  const store = memoryStore(); t.after(() => store.close()); const c = config(); const instructions = [];
  const luna = new Luna({ store, config: c, booking: new BookingService({ store, config: c, api: fakeApi() }), client: { responses: { async create(params) { instructions.push(params.instructions); return { status: 'completed', output: [], output_text: 'Tudo certo! 💈' }; } } } });
  await luna.reply('Como você conversa?', phone);
  store.set('system', 'knowledge', { revision: 1, lessons: [lesson] });
  await luna.reply('Como você conversa?', phone);
  store.set('system', 'knowledge', { revision: 2, lessons: [{ ...lesson, enabled: false }] });
  await luna.reply('Como você conversa?', phone);
  assert.ok(!instructions[0].includes(lesson.content)); assert.ok(instructions[1].includes(lesson.content)); assert.ok(!instructions[2].includes(lesson.content));
  assert.match(instructions[1], /não autorizam pular a confirmação/);
});
test('pausa durante resposta em processamento impede envio e preserva resposta para retomada', async t => {
  const store = memoryStore(); t.after(() => store.close()); const sent = [];
  const luna = { async reply() { store.set('system', 'bot-enabled', false); return 'Resposta pronta'; }, remember() {} };
  const processor = new MessageProcessor({ store, luna, config: config(), logger });
  const transport = async (...args) => { sent.push(args); };
  processor.setTransport(transport);
  processor.accept({ id: 'panel-pause-test', jid: `55${phone}@s.whatsapp.net`, phone, text: 'Oi', createdAt: Date.now() });
  await idle(processor); assert.equal(sent.length, 0); assert.equal(store.get('inbound', 'panel-pause-test').state, 'reply_ready');
  store.set('system', 'bot-enabled', true); processor.setTransport(transport); await idle(processor);
  assert.equal(sent.length, 1);
});
