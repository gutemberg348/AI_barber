import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageProcessor } from '../src/messages.js';
import { Luna } from '../src/luna.js';
import { BookingService } from '../src/booking.js';
import { config, logger, memoryStore, fakeApi, idle, phone, bookingArgs } from './helpers.js';

function setup(t) {
  const store = memoryStore(); t.after(() => store.close());
  const api = fakeApi(); const settings = config(); const modelCalls = [];
  const client = { responses: { async create(params) {
    modelCalls.push(structuredClone(params));
    return { status: 'completed', output: [], output_text: 'Com qual barbeiro?' };
  } } };
  const booking = new BookingService({ store, api, config: settings });
  const luna = new Luna({ store, booking, config: settings, client });
  const processor = new MessageProcessor({ store, luna, config: settings, logger });
  const sent = [];
  processor.setTransport(async (jid, text) => sent.push({ jid, text }));
  const item = (id, text, sender = phone) => ({ id, text, phone: sender, jid: `55${sender}@s.whatsapp.net`, createdAt: Date.now() });
  return { store, api, luna, booking, processor, sent, modelCalls, item };
}

test('/iniciar limpa contexto e confirmação só do remetente e funciona durante pausa individual', async t => {
  const { store, api, booking, processor, sent, modelCalls, item } = setup(t);
  const history = {
    messages: [{ role: 'user', content: 'Quero continuar o pedido antigo com Julio' }], updatedAt: Date.now(),
    catalog: { barbeiros: [{ id: 1, nome: 'Julio', servicos: [] }] },
    scheduleSelection: { barbeiro_id: 1, servicos: [2], data: null },
  };
  store.set('history', phone, history);
  await booking.tool('preparar_agendamento', bookingArgs, phone);
  store.set('paused', phone, true);
  const otherPhone = '21999991234';
  store.set('history', otherPhone, history);
  store.set('pending', otherPhone, { state: 'prepared', code: 'OTHER' });
  store.set('auth', 'creds', { marker: 'sessao_preservada' });
  const callsBefore = api.calls.length;
  processor.accept(item('reset', '  /INICIAR  ')); await idle(processor);
  assert.equal(sent[0].text, 'Fala, meu irmão! Tudo bem? 💈');
  assert.equal(modelCalls.length, 0); assert.equal(api.calls.length, callsBefore);
  assert.equal(store.get('pending', phone), null); assert.equal(store.get('paused', phone), null);
  assert.equal(store.get('history', phone).messages.length, 2);
  assert.equal(store.get('history', phone).catalog, undefined);
  assert.equal(store.get('history', phone).scheduleSelection, undefined);
  assert.doesNotMatch(JSON.stringify(store.get('history', phone)), /pedido antigo/);
  assert.deepEqual(store.get('history', otherPhone), history);
  assert.equal(store.get('pending', otherPhone).code, 'OTHER');
  assert.equal(store.get('auth', 'creds').marker, 'sessao_preservada');
  processor.accept(item('next', 'Quero um corte')); await idle(processor);
  assert.equal(modelCalls.length, 1);
  assert.doesNotMatch(JSON.stringify(modelCalls[0].input), /pedido antigo/);
  assert.deepEqual(modelCalls[0].input.map(m => m.content), ['  /INICIAR  ', sent[0].text, 'Quero um corte']);
});

test('/iniciar não cancela reserva concluída nem apaga deduplicação', async t => {
  const { store, booking, api, processor, item } = setup(t);
  const result = await booking.tool('preparar_agendamento', bookingArgs, phone);
  booking.markSummaryDelivered(phone, result.directReply);
  const pending = store.get('pending', phone);
  await booking.command(`CONFIRMAR ${pending.code}`, phone);
  assert.equal(store.get('pending', phone).state, 'completed');
  const callsBefore = api.calls.length;
  const reset = item('reset', '/iniciar');
  processor.accept(reset); await idle(processor);
  assert.equal(store.get('pending', phone), null);
  assert.equal(api.calls.length, callsBefore);
  assert.equal(api.calls.some(call => call.action === 'cancelar'), false);
  assert.equal(store.get('processed', 'reset').state, 'sent');
  const history = store.get('history', phone);
  processor.accept(reset); await idle(processor);
  assert.deepEqual(store.get('history', phone), history);
});

test('/iniciar preserva pedido incerto e orienta recuperar resultado antes do reset', async t => {
  const { store, processor, sent, modelCalls, api, item } = setup(t);
  const pending = { state: 'executing', code: 'ABC123', id: 'mesma-chave', payload: { telefone: phone } };
  store.set('pending', phone, pending);
  store.set('history', phone, { messages: [{ role: 'user', content: 'Pedido que pode ter sido gravado' }], updatedAt: Date.now() });
  processor.accept(item('reset', '/iniciar')); await idle(processor);
  assert.match(sent[0].text, /Responda CONFIRMAR/);
  assert.doesNotMatch(sent[0].text, /ABC123/);
  assert.doesNotMatch(sent[0].text, /Tudo bem/);
  assert.deepEqual(store.get('pending', phone), pending);
  assert.match(JSON.stringify(store.get('history', phone)), /Pedido que pode ter sido gravado/);
  assert.equal(modelCalls.length, 0); assert.equal(api.calls.length, 0);
});

test('/iniciar remove respostas antigas pendentes e não as reenvia ao reconectar', async t => {
  const { store, processor, sent, item } = setup(t);
  processor.setTransport(null);
  const reset = item('reset', '/iniciar');
  processor.accept(reset);
  const old = { ...item('old', 'Quais horários?'), state: 'reply_ready', reply: 'GRADE ANTIGA', replyGeneratedAt: Date.now() };
  store.set('inbound', old.id, old); processor.enqueue(old);
  processor.setTransport(async (jid, text) => sent.push({ jid, text })); await idle(processor);
  assert.equal(sent.length, 1); assert.equal(sent[0].text, 'Fala, meu irmão! Tudo bem? 💈');
  assert.equal(store.get('inbound', 'old'), null);
  assert.equal(store.get('processed', 'old').state, 'ignored');
  processor.setTransport(processor.send); await idle(processor);
  assert.equal(sent.length, 1);
});

test('/iniciar respeita pausa global do administrador', async t => {
  const { store, processor, sent, item } = setup(t);
  const history = { messages: [{ role: 'user', content: 'Pedido antigo' }], updatedAt: Date.now() };
  store.set('history', phone, history);
  store.set('system', 'bot-enabled', false);
  processor.accept(item('reset', '/iniciar')); await idle(processor);
  assert.equal(sent.length, 0);
  assert.deepEqual(store.get('history', phone), history);
  assert.equal(store.get('system', 'bot-enabled'), false);
});
