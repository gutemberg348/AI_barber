import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { contactPhone, contactControl, recordContact, saveContact, listedContacts } from '../src/contacts.js';
import { MessageProcessor } from '../src/messages.js';
import { config, logger, memoryStore, fakeApi, phone, idle } from './helpers.js';

const item = (id, text = 'Olá', sender = phone) => ({ id, text, phone: sender, jid: `55${sender}@s.whatsapp.net`, createdAt: Date.now() });
async function setup(t) {
  const store = memoryStore(); const c = config();
  const app = await buildApp({ config: c, store, logger, api: fakeApi(), whatsapp: { status: () => ({ connected: true, state: 'connected' }) } });
  t.after(async () => { await app.close(); store.close(); });
  return { store, c, app, headers: { authorization: `Bearer ${c.ADMIN_API_TOKEN}` } };
}

test('API de contatos exige autenticação, valida número/corpo e persiste o interruptor sem expor histórico', async t => {
  const { app, store, headers } = await setup(t);
  assert.equal((await app.inject('/api/v1/panel/contacts')).statusCode, 401);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/panel/contacts/${phone}`, payload: { enabled: false } })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/v1/panel/session', headers, payload: {} });
  const cookie = login.headers['set-cookie'].split(';')[0];
  assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/panel/contacts/${phone}`, headers: { cookie }, payload: { enabled: false } })).statusCode, 403);
  for (const [number, payload] of [['123', { enabled: false }], [phone, { enabled: 'false' }], [phone, { enabled: false, token: 'não permitir' }]]) {
    assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/panel/contacts/${number}`, headers, payload })).statusCode, 400);
  }
  const created = await app.inject({ method: 'PUT', url: `/api/v1/panel/contacts/${encodeURIComponent('+55 (11) 99999-1234')}`, headers: { cookie, 'x-luna-panel': '1' }, payload: { enabled: false, name: 'Cliente de teste' } });
  assert.equal(created.statusCode, 200); assert.equal(created.json().phone, phone); assert.equal(created.json().enabled, false);
  store.set('history', phone, { messages: [{ content: 'Conteúdo privado' }], updatedAt: Date.now() });
  const result = await app.inject({ url: '/api/v1/panel/contacts', headers });
  assert.equal(result.json().contacts[0].name, 'Cliente de teste');
  assert.doesNotMatch(result.body, /Conteúdo privado|messages|payload|token/);
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('normalização não confunde DDI/DDD e reúne formatos com e sem nono dígito', () => {
  assert.equal(contactPhone('+55 (87) 99123-4567'), '87991234567');
  assert.equal(contactPhone('87 9123-4567'), '87991234567');
  assert.equal(contactPhone('(55) 99999-1234'), '55999991234');
  assert.equal(contactPhone('55 (55) 99999-1234'), '55999991234');
  for (const value of ['123@lid', '123', '+1 4155552671', '11999991234abc']) assert.equal(contactPhone(value), null);
});

test('número novo aparece automaticamente e novos eventos preservam nome e pausa do administrador', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const processor = new MessageProcessor({ store, config: config(), logger, luna: { remember() {}, async reply() { return 'Olá'; } } });
  processor.setTransport(async () => {});
  processor.accept(item('primeiro')); await idle(processor);
  assert.equal(listedContacts(store)[0].phone, phone);
  assert.equal(listedContacts(store)[0].enabled, true);
  saveContact(store, phone, { enabled: false, name: 'Atendimento pessoal' });
  processor.accept(item('segundo')); await idle(processor);
  assert.equal(listedContacts(store)[0].name, 'Atendimento pessoal');
  assert.equal(listedContacts(store)[0].enabled, false);
  assert.equal(store.count('contacts'), 1);
});

test('pausa do painel silencia texto, áudio e comandos, mas mantém outras conversas e operações intactas', async t => {
  const store = memoryStore(); t.after(() => store.close()); const sent = []; const model = [];
  saveContact(store, phone, { enabled: false });
  store.set('pending', phone, { state: 'executing', id: 'chave-original', payload: { nome: 'Cliente' } });
  const processor = new MessageProcessor({ store, config: config(), logger,
    luna: { remember() {}, async reply(text, sender) { model.push(sender); return 'Resposta'; } },
    transcriber: { async transcribe() { assert.fail('Não transcrever enquanto está em atendimento manual.'); } } });
  processor.setTransport(async (jid, reply) => sent.push({ jid, reply }));
  for (const [index, text] of ['Oi', '/voltar', '/iniciar', 'SIM'].entries()) processor.accept(item(`pausado-${index}`, text));
  processor.accept({ ...item('audio', ''), audio: {} });
  processor.accept(item('outro', 'Oi', '21988887777'));
  await idle(processor);
  assert.deepEqual(model, ['21988887777']); assert.equal(sent.length, 1);
  assert.equal(contactControl(store, phone).enabled, false);
  assert.equal(store.get('pending', phone).id, 'chave-original');
});

test('pausa durante geração cancela envio mesmo se o administrador retomar antes do modelo terminar', async t => {
  const store = memoryStore(); t.after(() => store.close()); const sent = [];
  const processor = new MessageProcessor({ store, config: config(), logger, luna: { remember() {}, async reply() {
    saveContact(store, phone, { enabled: false }); saveContact(store, phone, { enabled: true }); return 'Resposta antiga';
  } } });
  processor.setTransport(async (jid, reply) => sent.push(reply));
  processor.accept(item('gerando')); await idle(processor);
  assert.equal(sent.length, 0);
  assert.equal(store.get('processed', 'gerando').state, 'ignored');
});

test('pausa durante transcrição não deixa o texto reconhecido chegar ao agente', async t => {
  const store = memoryStore(); t.after(() => store.close()); const sent = [];
  const processor = new MessageProcessor({ store, config: config(), logger, transcriber: { async transcribe() {
    saveContact(store, phone, { enabled: false }); return 'SIM';
  } }, luna: { remember() {}, async reply() { assert.fail('Não executar o agente após a pausa.'); } } });
  processor.setTransport(async (jid, reply) => sent.push(reply));
  processor.accept({ ...item('ouvindo', ''), audio: {} }); await idle(processor);
  assert.equal(sent.length, 0);
});

test('retomar após reinício não despeja respostas anteriores; novas mensagens voltam a ser atendidas', async t => {
  const store = memoryStore(); t.after(() => store.close()); const c = config(); let calls = 0;
  const luna = { remember() {}, async reply(text) { calls++; return text; } };
  const processor = new MessageProcessor({ store, config: c, logger, luna });
  processor.setTransport(async () => { throw new Error('offline'); });
  processor.accept(item('antigo', 'Mensagem antiga')); await idle(processor);
  assert.equal(store.get('inbound', 'antigo').state, 'reply_ready');
  saveContact(store, phone, { enabled: false }); saveContact(store, phone, { enabled: true });
  const sent = []; const restarted = new MessageProcessor({ store, config: c, logger, luna });
  restarted.setTransport(async (jid, reply) => sent.push(reply)); await idle(restarted);
  assert.equal(sent.length, 0);
  restarted.accept(item('novo', 'Mensagem nova')); await idle(restarted);
  assert.deepEqual(sent, ['Mensagem nova']); assert.equal(calls, 2);
});

test('pausa vale para as variantes do celular; retomada também limpa pausa do cliente sem ligar o agente geral', async t => {
  const store = memoryStore(); t.after(() => store.close());
  saveContact(store, '87991234567', { enabled: false });
  assert.equal(contactControl(store, '8791234567').enabled, false);
  recordContact(store, '8791234567'); assert.equal(store.count('contacts'), 1);
  store.set('system', 'bot-enabled', false);
  store.set('paused', '8791234567', true);
  saveContact(store, '8791234567', { enabled: true });
  assert.equal(store.get('paused', '8791234567'), null);
  assert.equal(listedContacts(store)[0].enabled, true);
  assert.equal(store.get('system', 'bot-enabled'), false);
  store.set('paused', '87991234567', true);
  assert.equal(listedContacts(store)[0].enabled, false);
});
