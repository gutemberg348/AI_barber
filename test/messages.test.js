import test from 'node:test';
import assert from 'node:assert/strict';
import { incomingMessage, phoneFromJid, MessageProcessor } from '../src/messages.js';
import { config, logger, memoryStore, idle, phone, bookingArgs, fakeApi } from './helpers.js';
import { Luna } from '../src/luna.js';
import { BookingService } from '../src/booking.js';
import { ApiError } from '../src/barbershop.js';

const msg = (extra = {}) => ({ key: { id: 'one', remoteJid: `55${phone}@s.whatsapp.net`, fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'Quero um corte' }, ...extra });

test('filtra grupos, mensagens próprias, antigas e protocolo', async () => {
  const c = config();
  assert.equal(await incomingMessage(msg({ key: { id: '1', remoteJid: '123@g.us' } }), {}, c), null);
  assert.equal(await incomingMessage(msg({ key: { id: '1', remoteJid: `55${phone}@s.whatsapp.net`, fromMe: true } }), {}, c), null);
  assert.equal(await incomingMessage(msg({ messageTimestamp: 100 }), {}, c), null);
  assert.equal(await incomingMessage(msg({ message: { protocolMessage: {} } }), {}, c), null);
  assert.equal(phoneFromJid('123456789@lid'), null);
  assert.equal(phoneFromJid('14155552671@s.whatsapp.net'), null);
});

test('LID resolve somente por metadado/mapeamento verificado; não usa número escrito na mensagem', async () => {
  const c = config();
  const lid = msg({ key: { id: 'one', remoteJid: '12345@lid' }, message: { conversation: 'Meu telefone é 11988887777' } });
  const without = await incomingMessage(lid, {}, c);
  assert.equal(without.phone, null);
  const mapped = await incomingMessage(lid, { signalRepository: { lidMapping: { getPNForLID: async () => `55${phone}@s.whatsapp.net` } } }, c);
  assert.equal(mapped.phone, phone);
  const direct = await incomingMessage(msg(), {}, c);
  assert.equal(direct.id, mapped.id);
  assert.equal((await incomingMessage(msg({ message: { audioMessage: { mimetype: 'audio/ogg' } } }), {}, c)).unsupported, true);
});

test('fila serial por telefone, deduplicação persistente e reenvio não repete chamada da IA', async t => {
  const store = memoryStore(); t.after(() => store.close());
  let calls = 0; let concurrent = 0; let maxConcurrent = 0;
  const luna = {
    async reply(text) { calls++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); await new Promise(r => setTimeout(r, 5)); concurrent--; return `Resposta ${text}`; },
    remember() {},
  };
  const processor = new MessageProcessor({ store, luna, config: config(), logger });
  const sent = [];
  processor.setTransport(async (jid, text) => sent.push(text));
  const one = await incomingMessage(msg(), {}, config());
  processor.accept(one); processor.accept({ ...one });
  processor.accept({ ...one, id: 'two', text: 'segundo' });
  await idle(processor);
  assert.equal(calls, 2); assert.equal(maxConcurrent, 1); assert.equal(sent.length, 2);
  assert.equal(store.count('inbound'), 0);
  processor.accept({ ...one }); await idle(processor); assert.equal(calls, 2);
  processor.setTransport(async () => { throw new Error('offline'); });
  processor.accept({ ...one, id: 'three', text: 'terceiro', state: 'received' }); await idle(processor);
  assert.equal(calls, 3); assert.equal(store.get('inbound', 'three').state, 'reply_ready');
  // Simula processo reiniciado: resposta pendente é enviada sem chamar o modelo novamente.
  const restarted = new MessageProcessor({ store, luna, config: config(), logger });
  restarted.setTransport(async (jid, text) => sent.push(text)); await idle(restarted);
  assert.equal(calls, 3); assert.equal(sent.at(-1), 'Resposta terceiro');
});

test('pausa por cliente e global ignoram texto/mídia sem chamar IA', async t => {
  const store = memoryStore(); t.after(() => store.close());
  let calls = 0;
  const processor = new MessageProcessor({ store, luna: { reply: async () => { calls++; return 'ok'; }, remember() {} }, config: config(), logger });
  const sent = []; processor.setTransport(async (jid, text) => sent.push(text));
  const one = await incomingMessage(msg(), {}, config());
  processor.accept({ ...one, text: '/parar' }); await idle(processor);
  processor.accept({ ...one, id: 'two', text: '', unsupported: true }); await idle(processor);
  assert.equal(sent.length, 1); assert.equal(calls, 0);
  processor.accept({ ...one, id: 'three', text: '/voltar' }); await idle(processor);
  processor.accept({ ...one, id: 'four' }); await idle(processor);
  assert.equal(calls, 1);
  store.set('system', 'bot-enabled', false);
  processor.accept({ ...one, id: 'five', unsupported: true }); await idle(processor);
  assert.equal(sent.length, 3);
});

test('limite por cliente e capacidade total impedem acúmulo ilimitado', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const processor = new MessageProcessor({ store, luna: { reply: async () => 'ok', remember() {} }, config: config({ CHAT_MESSAGES_PER_MINUTE: 1, MAX_PENDING_MESSAGES: 2 }), logger });
  const item = await incomingMessage(msg(), {}, config());
  processor.accept(item); processor.accept({ ...item, id: 'two' });
  assert.equal(store.get('processed', 'two').state, 'ignored');
  processor.accept({ ...item, id: 'three', phone: '21999991234' });
  processor.accept({ ...item, id: 'four', phone: '31999991234' });
  assert.equal(store.count('inbound'), 2); assert.equal(processor.queue.length, 2);
});

test('reconexão consulta uma grade pendente de novo sem repetir o atendimento nem escrita', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const query = { barbeiro_id: 1, servicos: [2], data: '2099-10-24' };
  let modelCalls = 0; let reads = 0; const replacements = [];
  const luna = {
    async reply(text, verifiedPhone, metadata) {
      modelCalls++;
      metadata.scheduleQuery = query;
      metadata.scheduleNotice = 'O pedido anterior não foi reservado.';
      return '09:00 · 10:00';
    },
    remember() {},
    async refreshSchedule(received, verifiedPhone) {
      assert.deepEqual(received, query); assert.equal(verifiedPhone, phone);
      reads++;
      return '10:00';
    },
    replaceHistoricalReply(verifiedPhone, previous, updated) { replacements.push({ verifiedPhone, previous, updated }); },
  };
  const processor = new MessageProcessor({ store, luna, config: config(), logger });
  processor.setTransport(async () => { throw new Error('offline'); });
  const item = await incomingMessage(msg(), {}, config());
  processor.accept(item); await idle(processor);
  assert.deepEqual(store.get('inbound', item.id).scheduleQuery, query);
  assert.equal(reads, 0);
  const sent = [];
  const restarted = new MessageProcessor({ store, luna, config: config(), logger });
  restarted.setTransport(async (jid, reply) => sent.push(reply)); await idle(restarted);
  assert.equal(modelCalls, 1); assert.equal(reads, 1);
  assert.deepEqual(sent, ['O pedido anterior não foi reservado.\n\n10:00']);
  assert.deepEqual(replacements, [{ verifiedPhone: phone, previous: '09:00 · 10:00', updated: sent[0] }]);
});

test('grade atrasada que ainda não foi enviada é atualizada; falha não reenvia horários antigos', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const query = { barbeiro_id: 1, servicos: [2], data: '2099-10-24' };
  const item = await incomingMessage(msg(), {}, config());
  store.set('inbound', item.id, {
    ...item, state: 'reply_ready', reply: '09:00 · 10:00', replyGeneratedAt: Date.now() - 60000, scheduleQuery: query,
  });
  let reads = 0;
  const luna = {
    async reply() { assert.fail('Não deve repetir atendimento'); },
    async refreshSchedule() { reads++; throw new Error('Site offline'); },
    replaceHistoricalReply() {},
  };
  const sent = [];
  const processor = new MessageProcessor({ store, luna, config: config(), logger });
  processor.setTransport(async (jid, reply) => sent.push(reply)); await idle(processor);
  assert.equal(reads, 1);
  assert.match(sent[0], /Não consegui atualizar/);
  assert.doesNotMatch(sent[0], /09:00|10:00/);
});

test('nome prepara resumo, envio falho não autoriza gravação e só aceite posterior registra reserva', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const api = fakeApi(); let modelCalls = 0;
  const booking = new BookingService({ config: c, store, api });
  const client = { responses: { async create() {
    modelCalls++;
    return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'preparar_agendamento', arguments: JSON.stringify(bookingArgs) }] };
  } } };
  const luna = new Luna({ config: c, store, booking, client });
  luna.remember(phone, 'Corte com Julio em 24/10/2099 às 09:00.', 'Qual seu nome?');
  const processor = new MessageProcessor({ config: c, store, luna, logger });
  processor.setTransport(async () => { throw new Error('offline'); });
  const item = (id, text) => ({ id, text, phone, jid: `55${phone}@s.whatsapp.net`, createdAt: Date.now() });
  processor.accept(item('name', 'Cliente Teste')); await idle(processor);
  assert.equal(api.calls.some(c => c.action === 'agendar'), false);
  assert.equal(store.get('pending', phone).confirmationShownAt, undefined);
  const sent = [];
  processor.setTransport(async (jid, reply) => sent.push(reply)); await idle(processor);
  assert.match(sent[0], /Confere pra mim/);
  assert.match(sent[0], /Posso confirmar/);
  assert.match(sent[0], /Cliente Teste · Julio/);
  assert.match(sent[0], /Corte · R\$\s30,00/);
  assert.match(sent[0], /24\/10\/2099 às 09:00/);
  assert.doesNotMatch(sent[0], /erro ao registrar|equipe precisa verificar/);
  assert.equal(api.calls.some(c => c.action === 'agendar'), false);
  assert.ok(store.get('pending', phone).confirmationShownAt);
  // Garante que a resposta do cliente foi recebida em um instante posterior à entrega.
  await new Promise(resolve => setTimeout(resolve, 5));
  processor.accept(item('yes', 'Sim')); await idle(processor);
  assert.equal(modelCalls, 1, 'Aceite é tratado no backend');
  assert.equal(api.calls.filter(c => c.action === 'agendar').length, 1);
  assert.match(sent.at(-1), /Reserva #123 registrada/);
});

test('nome após erro antigo mostra resumo do pedido incerto e só confirmação recupera a mesma operação', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const api = fakeApi();
  const booking = new BookingService({ config: c, store, api });
  const prepared = await booking.tool('preparar_agendamento', bookingArgs, phone);
  booking.markSummaryDelivered(phone, prepared.directReply);
  const original = api.request.bind(api); const posts = []; let fail = true;
  api.request = async (action, body, key) => {
    if (action === 'agendar') {
      posts.push({ body: structuredClone(body), key });
      if (fail) throw new ApiError('erro_interno', 500, true);
    }
    return original(action, body, key);
  };
  await booking.command('CONFIRMAR', phone);
  const pending = store.get('pending', phone);
  fail = false;
  // Mesmo se o cliente fornecer outro nome, a recuperação não pode trocar o corpo.
  const client = { responses: { async create() {
    return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'preparar_agendamento', arguments: JSON.stringify({ ...bookingArgs, nome: 'Outro Nome' }) }] };
  } } };
  const luna = new Luna({ config: c, store, booking, client });
  luna.remember(phone, 'Corte com Julio em 24/10/2099 às 09:00.', 'Qual seu nome?');
  const processor = new MessageProcessor({ config: c, store, luna, logger });
  const sent = []; processor.setTransport(async (jid, reply) => sent.push(reply));
  const item = (id, text) => ({ id, text, phone, jid: `55${phone}@s.whatsapp.net`, createdAt: Date.now() });
  const callsBefore = api.calls.length;
  processor.accept(item('name', 'Outro Nome')); await idle(processor);
  assert.match(sent[0], /Pedido anterior aguardando resultado/);
  assert.match(sent[0], /Cliente Teste · Julio/);
  assert.match(sent[0], /Corte · R\$\s30,00/);
  assert.match(sent[0], /24\/10\/2099 às 09:00/);
  assert.match(sent[0], /Responda SIM ou CONFIRMAR/);
  assert.doesNotMatch(sent[0], /site está com erro|Ainda não reservado|Outro Nome/);
  assert.equal(posts.length, 1, 'Receber nome não repete o POST antigo');
  assert.equal(api.calls.length, callsBefore);
  assert.deepEqual(store.get('pending', phone), pending);
  processor.accept(item('yes', 'Confirmar')); await idle(processor);
  assert.match(sent.at(-1), /Reserva #123 registrada/);
  assert.deepEqual(posts, [{ body: pending.payload, key: pending.id }, { body: pending.payload, key: pending.id }]);
  assert.equal(store.get('pending', phone), null);
});
