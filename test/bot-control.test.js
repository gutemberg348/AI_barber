import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPauseTime, savePauseSettings, applyScheduledPause, botEnabled, pauseSettings } from '../src/bot-control.js';
import { MessageProcessor } from '../src/messages.js';
import { buildApp } from '../src/app.js';
import { config, memoryStore, logger, phone, idle, fakeApi } from './helpers.js';

const timezone = 'America/Sao_Paulo';
const before = Date.parse('2026-11-04T21:59:00Z');
const due = Date.parse('2026-11-04T22:00:00Z');

test('hora de pausa considera o fuso da barbearia e escolhe a próxima ocorrência', () => {
  assert.equal(nextPauseTime('19:00', timezone, before), '2026-11-04T22:00:00.000Z');
  assert.equal(nextPauseTime('19:00', timezone, due), '2026-11-05T22:00:00.000Z');
  assert.equal(nextPauseTime('19:00', 'America/Cayenne', before), '2026-11-04T22:00:00.000Z');
  assert.equal(nextPauseTime('19:00', 'UTC', before), '2026-11-05T19:00:00.000Z');
});

test('pausa única persistida ocorre no horário sem painel aberto e pode ser religada', t => {
  const store = memoryStore(); t.after(() => store.close());
  savePauseSettings(store, { enabled: true, time: '19:00', repeat: 'once' }, timezone, before);
  assert.equal(botEnabled(store, timezone, before), true);
  assert.equal(applyScheduledPause(store, timezone, due), true);
  assert.equal(store.get('system', 'bot-enabled'), false);
  assert.equal(pauseSettings(store).enabled, false);
  assert.equal(pauseSettings(store).lastPausedAt, new Date(due).toISOString());
  store.set('system', 'bot-enabled', true);
  assert.equal(botEnabled(store, timezone, due + 30000), true);
});

test('pausa diária agenda próximo dia, não religa sozinha e recupera horário vencido', t => {
  const store = memoryStore(); t.after(() => store.close());
  savePauseSettings(store, { enabled: true, time: '19:00', repeat: 'daily' }, timezone, before);
  // O servidor voltou depois do horário que estava salvo no banco.
  assert.equal(applyScheduledPause(store, timezone, due + 3600000), true);
  assert.equal(pauseSettings(store).nextPauseAt, '2026-11-05T22:00:00.000Z');
  assert.equal(botEnabled(store, timezone, due + 7200000), false);
  store.set('system', 'bot-enabled', true);
  assert.equal(botEnabled(store, timezone, due + 7200000), true);
  assert.equal(botEnabled(store, timezone, due + 86400000), false);
});

test('cancelar programação não muda interruptor nem pausa em horário antigo', t => {
  const store = memoryStore(); t.after(() => store.close());
  savePauseSettings(store, { enabled: true, time: '19:00', repeat: 'once' }, timezone, before);
  savePauseSettings(store, { enabled: false, time: '19:00', repeat: 'once' }, timezone, before);
  assert.equal(botEnabled(store, timezone, due), true);
  assert.equal(pauseSettings(store).nextPauseAt, null);
});

test('programação exige autenticação, valida parâmetros e retorna no painel', async t => {
  const store = memoryStore(); const c = config();
  const whatsapp = { status: () => ({ connected: true, botEnabled: true }), qrCode: async () => null };
  const app = await buildApp({ config: c, store, whatsapp, api: fakeApi(), logger });
  t.after(async () => { await app.close(); store.close(); });
  const url = '/api/v1/bot/schedule'; const headers = { authorization: `Bearer ${c.ADMIN_API_TOKEN}` };
  assert.equal((await app.inject({ method: 'PUT', url, payload: { enabled: true, time: '19:00', repeat: 'daily' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PUT', url, headers, payload: { enabled: true, time: '25:00', repeat: 'daily' } })).statusCode, 400);
  const saved = await app.inject({ method: 'PUT', url, headers, payload: { enabled: true, time: '19:00', repeat: 'daily' } });
  assert.equal(saved.statusCode, 200); assert.equal(saved.json().schedule.time, '19:00');
  const overview = await app.inject({ url: '/api/v1/panel/overview', headers });
  assert.equal(overview.json().schedule.enabled, true);
  const font = await app.inject('/painel/fonts/InterVariable.woff2');
  assert.equal(font.statusCode, 200); assert.match(font.headers['content-type'], /font\/woff2/);
  assert.equal(font.rawPayload.subarray(0, 4).toString(), 'wOF2');
});

test('atingir horário durante resposta bloqueia envio mesmo sem atualização do painel', async t => {
  const store = memoryStore(); t.after(() => store.close()); const c = config(); const sent = [];
  const luna = { async reply() {
    store.set('system', 'bot-pause', { enabled: true, time: '19:00', repeat: 'once', nextPauseAt: new Date(Date.now() - 1000).toISOString() });
    return 'Resposta em processamento';
  }, remember() {} };
  const processor = new MessageProcessor({ store, luna, config: c, logger });
  processor.setTransport(async text => sent.push(text));
  processor.accept({ id: 'schedule-mid-reply', jid: `55${phone}@s.whatsapp.net`, phone, text: 'Oi', createdAt: Date.now() });
  await idle(processor);
  assert.equal(sent.length, 0);
  assert.equal(store.get('system', 'bot-enabled'), false);
  assert.equal(store.get('inbound', 'schedule-mid-reply').state, 'reply_ready');
});
