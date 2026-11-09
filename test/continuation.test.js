import test from 'node:test';
import assert from 'node:assert/strict';
import { Luna } from '../src/luna.js';
import { BookingService } from '../src/booking.js';
import { MessageProcessor } from '../src/messages.js';
import { config, memoryStore, fakeApi, phone, bookingArgs, idle, logger } from './helpers.js';

const toolCall = (name, args, n = 1) => ({ output: [{ type: 'function_call', id: `fc${n}`, call_id: `call${n}`, name, arguments: JSON.stringify(args) }] });

test('agenda meu horário inicia marcação e preserva segunda de manhã nas próximas etapas', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const api = fakeApi(); let calls = 0;
  const request = 'Agenda meu horário pra segunda de manhã';
  const client = { responses: { async create(params) {
    calls++;
    assert.doesNotMatch(params.instructions, /O cliente quer conferir uma reserva\/visita/);
    assert.ok(params.input.some(item => item.role === 'user' && item.content === request));
    if (calls === 1) return toolCall('listar_barbeiros', {});
    if (calls === 2) return toolCall('listar_servicos', { barbeiro_id: 1 });
    assert.equal(calls, 3);
    // Data escolhida apenas para testar o encadeamento, sem depender do relógio.
    return toolCall('grade_horarios', { barbeiro_id: 1, servicos: [2], data: bookingArgs.data, comparar_barbeiros: false });
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  for (const [text, expected] of [[request, /Julio/], ['Julio', /Corte/], ['Corte', /09:00/]]) {
    const metadata = {};
    const reply = await luna.reply(text, phone, metadata);
    assert.match(reply, expected);
    assert.doesNotMatch(reply, /use o site|não consegui concluir|qual dia/i);
    luna.remember(phone, text, reply, metadata);
  }
  assert.equal(calls, 3);
  assert.equal(api.calls.some(call => ['agendamentos', 'agendar', 'cancelar'].includes(call.action)), false);
  assert.equal(store.get('pending', phone), null);
});

test('pedidos de marcação com meu horário não caem na consulta de reserva existente', async t => {
  for (const text of ['Pode marcar meu horário para amanhã?', 'Quero agendar meu horário', 'Agende meu horário', 'Marca meu horário para segunda', 'Coloca meu horário para amanhã']) {
    await t.test(text, async t => {
      const store = memoryStore(); t.after(() => store.close()); const c = config(); const api = fakeApi();
      const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client: { responses: { async create() { return toolCall('listar_barbeiros', {}); } } } });
      assert.match(await luna.reply(text, phone), /Julio/);
      assert.deepEqual(api.calls.map(call => call.action), ['catalogo']);
    });
  }
});

test('reserva existente na agenda continua consultando o site sem iniciar outra', async t => {
  const store = memoryStore(); t.after(() => store.close()); const c = config(); const api = fakeApi();
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client: { responses: { async create() { assert.fail('Consulta existente não depende do modelo.'); } } } });
  assert.match(await luna.reply('Meu horário está na agenda?', phone), /Encontrei seu agendamento no site/);
  assert.equal(api.calls.every(call => call.action === 'agendamentos'), true);
});

test('pergunta curta que menciona horário permite continuar sem cair no limite de correções', async t => {
  for (const question of ['Com qual barbeiro deseja agendar seu horário? 💈', 'Qual serviço deseja para esse horário? 💈', 'Para qual dia deseja agendar seu horário? 💈']) {
    await t.test(question, async t => {
      const store = memoryStore(); t.after(() => store.close()); const c = config(); const api = fakeApi(); let calls = 0;
      const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client: { responses: { async create() { calls++; return { status: 'completed', output: [], output_text: question }; } } } });
      assert.equal(await luna.reply('Quero agendar', phone), question);
      assert.equal(calls, 1);
      assert.equal(api.calls.length, 0);
    });
  }
});

test('pergunta com vaga inventada continua bloqueada e limite não manda abandonar o WhatsApp', async t => {
  const store = memoryStore(); t.after(() => store.close()); const c = config(); const api = fakeApi(); let calls = 0; const logs = [];
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), logger: { warn(value) { logs.push(value); } }, client: { responses: { async create() { calls++; return { status: 'completed', output: [], output_text: 'Qual serviço deseja no horário livre de 09:00?' }; } } } });
  const reply = await luna.reply('Quero marcar', phone);
  assert.equal(calls, 6);
  assert.match(reply, /tentar novamente por aqui/);
  assert.doesNotMatch(reply, /09:00|https:|use o site/i);
  assert.deepEqual(logs, [{ event: 'luna_turn_limit', rounds: 6 }]);
  assert.equal(store.get('pending', phone), null);
});

test('falha temporária preserva o pedido para continuar no WhatsApp ao tentar novamente', async t => {
  const store = memoryStore(); t.after(() => store.close()); const c = config(); const api = fakeApi(); let calls = 0;
  const request = 'Agenda meu horário pra segunda de manhã';
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client: { responses: { async create(params) {
    calls++;
    if (calls === 1) throw new Error('falha_temporaria_simulada');
    assert.ok(params.input.some(item => item.role === 'user' && item.content === request));
    assert.equal(params.input.at(-1).content, 'Tente novamente');
    return toolCall('listar_barbeiros', {});
  } } } });
  const sent = []; const processor = new MessageProcessor({ store, luna, config: c, logger });
  processor.setTransport(async (jid, reply) => sent.push(reply));
  for (const [index, text] of [request, 'Tente novamente'].entries()) {
    processor.accept({ id: `continuacao-${index}`, jid: `55${phone}@s.whatsapp.net`, phone, text, createdAt: Date.now() });
    await idle(processor);
  }
  assert.match(sent[0], /tentar novamente por aqui/);
  assert.doesNotMatch(sent[0], /https:|use o site/i);
  assert.match(sent[1], /Julio/);
  assert.equal(calls, 2);
  assert.equal(store.get('pending', phone), null);
});
