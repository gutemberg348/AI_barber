import test from 'node:test';
import assert from 'node:assert/strict';
import { Luna, lunaTools } from '../src/luna.js';
import { BookingService, localTime } from '../src/booking.js';
import { config, memoryStore, fakeApi, phone, bookingArgs, catalog } from './helpers.js';

test('Responses API consulta ferramenta e devolve seu resultado na próxima chamada sem tokens', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const api = fakeApi(); const c = config();
  const calls = [];
  const client = { responses: { async create(params) {
    calls.push(structuredClone(params));
    return calls.length === 1
      ? { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'catalogo', arguments: '{}' }] }
      : { status: 'completed', output: [], output_text: 'O corte com Julio custa R$ 30,00.' };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  assert.match(await luna.reply('Quanto custa o corte?', phone), /30,00/);
  assert.equal(calls.length, 2); assert.equal(calls[0].store, false);
  assert.equal(calls[0].max_output_tokens, c.OPENAI_MAX_OUTPUT_TOKENS);
  assert.equal(calls[1].input.at(-1).type, 'function_call_output');
  assert.match(calls[1].input.at(-1).output, /Julio/);
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(c.BARBEARIA_API_TOKEN));
  assert.equal(lunaTools.some(t => t.parameters.properties.telefone), false);
  assert.equal(lunaTools.some(t => t.name === 'disponibilidade'), false, 'Toda exibição de vagas deve usar a grade atualizável');
  for (const tool of lunaTools) {
    assert.deepEqual(tool.parameters.required, Object.keys(tool.parameters.properties), 'O modo strict exige todas as propriedades');
    assert.equal(tool.parameters.additionalProperties, false);
  }
});

test('grade do modelo carrega consulta para reenvio e atualiza histórico sem chamar IA novamente', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const api = fakeApi(); const c = config(); let calls = 0;
  const query = { barbeiro_id: 1, servicos: [2], data: bookingArgs.data };
  const client = { responses: { async create() {
    calls++;
    return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'grade_horarios', arguments: JSON.stringify(query) }] };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const metadata = {};
  const first = await luna.reply('Quais horários em 24/10/2099?', phone, metadata);
  assert.deepEqual(metadata.scheduleQuery, query);
  luna.remember(phone, 'Quais horários em 24/10/2099?', first, metadata);
  const original = api.request.bind(api);
  api.request = async (action, ...args) => action === 'disponibilidade'
    ? { dias: [{ data: query.data, horarios: [{ hora: '10:00' }] }] }
    : original(action, ...args);
  const fresh = await luna.refreshSchedule(metadata.scheduleQuery, phone);
  assert.doesNotMatch(fresh, /09:00/);
  assert.match(fresh, /10:00/);
  assert.equal(calls, 1);
  luna.replaceHistoricalReply(phone, first, fresh);
  assert.equal(store.get('history', phone).messages.at(-1).content, fresh);
  assert.equal(store.get('pending', phone), null);
});

test('modelo só prepara; confirmação usa backend sem chamar modelo e memória isola telefones', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const api = fakeApi(); const c = config(); let count = 0;
  const client = { responses: { async create(params) {
    count++;
    assert.ok(params.instructions.includes(JSON.stringify(catalog.barbeiros)), 'O primeiro pedido completo já recebe o catálogo real antes do preparo');
    return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'preparar_agendamento', arguments: JSON.stringify(bookingArgs) }] };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const request = 'Sou Cliente Teste, quero um corte com Julio em 24/10/2099 às 09:00.';
  const summary = await luna.reply(request, phone);
  assert.match(summary, /CONFIRMAR/); assert.equal(api.calls.some(c => c.action === 'agendar'), false);
  luna.remember(phone, request, summary);
  luna.markReplyDelivered(phone, summary);
  assert.equal(store.get('history', '21999991234'), null);
  const op = store.get('pending', phone);
  const reply = await luna.reply(`CONFIRMAR ${op.code}`, phone);
  assert.match(reply, /Reserva #123/); assert.equal(count, 1);
  luna.remember(phone, `CONFIRMAR ${op.code}`, reply);
  assert.equal(store.get('pending', phone), null);
});

test('reenvio de próximas vagas refaz consulta sem data e comparação sem repetir IA ou gravar reserva', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const api = fakeApi(); const c = config(); let modelCalls = 0; let occupied = false;
  const original = api.request.bind(api);
  api.request = async (action, ...args) => {
    if (action !== 'disponibilidade') return original(action, ...args);
    assert.deepEqual(args[0], { barbeiro_id: 1, servicos: [2] });
    return { dias: [
      { data: '2099-10-24', horarios: occupied ? [] : [{ hora: '09:00' }] },
      { data: '2099-10-26', horarios: [{ hora: '10:00' }] },
    ] };
  };
  const query = { barbeiro_id: 1, servicos: [2], data: null, comparar_barbeiros: true };
  const client = { responses: { async create() {
    modelCalls++;
    return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'grade_horarios', arguments: JSON.stringify(query) }] };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const metadata = {};
  const first = await luna.reply('Quais os próximos horários com qualquer um?', phone, metadata);
  assert.deepEqual(metadata.scheduleQuery, query);
  assert.match(first, /24\/10\/2099/);
  luna.remember(phone, 'Quais os próximos horários com qualquer um?', first);
  occupied = true;
  const updated = await luna.refreshSchedule(metadata.scheduleQuery, phone);
  assert.doesNotMatch(updated, /24\/10\/2099|09:00/);
  assert.match(updated, /26\/10\/2099/);
  assert.match(updated, /10:00/);
  luna.replaceHistoricalReply(phone, first, updated);
  assert.equal(store.get('history', phone).messages.at(-1).content, updated);
  assert.equal(modelCalls, 1);
  assert.equal(store.get('pending', phone), null);
  assert.equal(api.calls.some(call => ['agendar', 'cancelar'].includes(call.action)), false);
});

test('horários escritos pelo modelo são descartados e substituídos pela grade atual do site', async t => {
  for (const oldSlot of ['09:00', '9h', '9h30']) {
    await t.test(oldSlot, async t => {
      const store = memoryStore(); t.after(() => store.close());
      const c = config(); const calls = []; const reads = [];
      const query = { barbeiro_id: 1, servicos: [2], data: bookingArgs.data };
      const api = { async request(action, params) {
        reads.push({ action, params });
        if (action === 'catalogo') return catalog;
        assert.equal(action, 'disponibilidade');
        return { dias: [{ data: query.data, horarios: [{ hora: '10:00' }] }] };
      } };
      const client = { responses: { async create(params) {
        calls.push(structuredClone(params));
        if (calls.length === 1) return { status: 'completed', output: [], output_text: `Hoje tem ${oldSlot}.` };
        return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'grade_horarios', arguments: JSON.stringify(query) }] };
      } } };
      const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
      luna.remember(phone, 'Quais horários em 24/10/2099?', '09:00\n09:30');
      const metadata = {};
      const reply = await luna.reply('Pode consultar os horários novamente?', phone, metadata);
      assert.equal(calls.length, 2);
      assert.match(reply, /10:00/);
      assert.equal(reply.includes(oldSlot), false);
      assert.doesNotMatch(reply, /09:00|09:30/);
      assert.deepEqual(metadata.scheduleQuery, query);
      assert.deepEqual(reads.map(read => read.action), ['catalogo', 'disponibilidade']);
      assert.equal(store.get('pending', phone), null);
    });
  }
});

test('modelo que insiste em horários sem ferramenta não envia vagas inventadas nem cria pedido', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const api = fakeApi(); const c = config(); let calls = 0;
  const client = { responses: { async create() {
    calls++;
    return { status: 'completed', output: [], output_text: 'Hoje tem 09:00 e 10:00.' };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const metadata = {};
  const reply = await luna.reply('Quais horários estão livres?', phone, metadata);
  assert.equal(calls, 6, 'A correção tem limite e não fica repetindo a IA indefinidamente');
  assert.doesNotMatch(reply, /09:00|10:00/);
  assert.match(reply, /não consegui|tente|tenta/i);
  assert.deepEqual(metadata, {});
  assert.equal(api.calls.length, 0);
  assert.equal(store.get('pending', phone), null);
});

test('dia relativo explícito impede consultar a data errada e permite corrigir a ferramenta', async t => {
  for (const [text, offset] of [['Hoje', 0], ['pra amanhã', 1], ['para depois de amanhã', 2]]) {
    await t.test(text, async t => {
      const store = memoryStore(); t.after(() => store.close());
      const c = config({ BARBEARIA_TIMEZONE: 'America/Sao_Paulo' });
      const day = new Date(`${localTime(c.BARBEARIA_TIMEZONE).slice(0, 10)}T12:00:00Z`);
      day.setUTCDate(day.getUTCDate() + offset);
      const expectedDate = day.toISOString().slice(0, 10);
      const reads = []; const calls = [];
      const query = { barbeiro_id: 1, servicos: [2], data: expectedDate };
      const api = { async request(action, params) {
        reads.push({ action, params });
        if (action === 'catalogo') return catalog;
        assert.equal(action, 'disponibilidade');
        assert.equal(params.data_inicio, expectedDate);
        assert.equal(params.data_fim, expectedDate);
        return { dias: [{ data: expectedDate, horarios: [{ hora: '10:00' }] }] };
      } };
      const client = { responses: { async create(params) {
        calls.push(structuredClone(params));
        if (calls.length === 2) {
          assert.equal(reads.length, 0, 'A chamada com data incorreta não chega à API');
          const rejection = params.input.at(-1);
          assert.equal(rejection.type, 'function_call_output');
          assert.equal(JSON.parse(rejection.output).sucesso, false);
        }
        return { output: [{ type: 'function_call', id: `fc${calls.length}`, call_id: `call${calls.length}`, name: 'grade_horarios', arguments: JSON.stringify({ ...query, data: calls.length === 1 ? '2000-01-01' : expectedDate }) }] };
      } } };
      const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
      const metadata = {};
      const reply = await luna.reply(text, phone, metadata);
      assert.equal(calls.length, 2);
      assert.match(reply, /10:00/);
      assert.deepEqual(metadata.scheduleQuery, query);
      assert.equal(store.get('pending', phone), null);
    });
  }
});

test('dia relativo explícito também impede preparar reserva na data errada', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const expectedDate = localTime(c.BARBEARIA_TIMEZONE).slice(0, 10);
  const reads = []; let calls = 0;
  const api = { async request(action, params) {
    reads.push({ action, params });
    if (action === 'catalogo') return catalog;
    assert.equal(action, 'disponibilidade', 'Este teste nunca deve efetivar reserva');
    assert.equal(params.data_inicio, expectedDate);
    return { dias: [{ data: expectedDate, horarios: [{ hora: '09:00' }] }] };
  } };
  const client = { responses: { async create(params) {
    calls++;
    if (calls === 2) {
      assert.equal(reads.length, 0);
      assert.equal(store.get('pending', phone), null);
      assert.equal(JSON.parse(params.input.at(-1).output).sucesso, false);
    }
    return { output: [{ type: 'function_call', id: `fc${calls}`, call_id: `call${calls}`, name: 'preparar_agendamento', arguments: JSON.stringify({ ...bookingArgs, data: calls === 1 ? '2000-01-01' : expectedDate }) }] };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  luna.remember(phone, 'Sou Cliente Teste, quero corte com Julio às 09:00.', 'Pra qual dia?');
  const reply = await luna.reply('Hoje', phone);
  assert.equal(calls, 2);
  assert.match(reply, /CONFIRMAR/);
  const pending = store.get('pending', phone);
  assert.equal(pending.state, 'prepared');
  assert.equal(pending.payload.data, expectedDate);
  assert.deepEqual(reads.map(read => read.action), ['catalogo', 'disponibilidade']);
});

test('modelo não pode afirmar falha de consulta antes de tentar buscar os horários', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const api = fakeApi(); const c = config(); let calls = 0;
  const query = { barbeiro_id: 1, servicos: [2], data: bookingArgs.data };
  const client = { responses: { async create() {
    calls++;
    if (calls === 1) return { status: 'completed', output: [], output_text: 'Não consegui consultar os horários agora.' };
    assert.equal(api.calls.length, 0);
    return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'grade_horarios', arguments: JSON.stringify(query) }] };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const metadata = {};
  const reply = await luna.reply('Quais horários tem com Julio em 24/10/2099?', phone, metadata);
  assert.equal(calls, 2);
  assert.match(reply, /09:00/);
  assert.doesNotMatch(reply, /Não consegui consultar/);
  assert.deepEqual(metadata.scheduleQuery, query);
  assert.deepEqual(api.calls.map(call => call.action), ['catalogo', 'disponibilidade']);
  assert.equal(store.get('pending', phone), null);
});

test('falha real na leitura permite explicar indisponibilidade da consulta sem inventar horários', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const reads = []; let calls = 0;
  const query = { barbeiro_id: 1, servicos: [2], data: bookingArgs.data };
  const api = { async request(action) {
    reads.push(action);
    if (action === 'catalogo') return catalog;
    assert.equal(action, 'disponibilidade');
    throw new Error('offline');
  } };
  const failureReply = 'Não consegui consultar os horários agora. Tenta de novo em instantes.';
  const client = { responses: { async create(params) {
    calls++;
    if (calls === 1) return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'grade_horarios', arguments: JSON.stringify(query) }] };
    assert.equal(JSON.parse(params.input.at(-1).output).sucesso, false);
    return { status: 'completed', output: [], output_text: failureReply };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const metadata = {};
  const reply = await luna.reply('Quais horários tem com Julio em 24/10/2099?', phone, metadata);
  assert.equal(reply, failureReply);
  assert.equal(calls, 2);
  assert.deepEqual(reads, ['catalogo', 'disponibilidade']);
  assert.deepEqual(metadata, {});
  assert.equal(store.get('pending', phone), null);
});

test('consulta de reservas do remetente permite informar o horário retornado sem exigir grade de vagas', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const api = fakeApi(); const c = config(); let calls = 0;
  const appointmentReply = 'Sua reserva #123 com Julio é em 24/10/2099 às 09:00.';
  const client = { responses: { async create(params) {
    calls++;
    if (calls === 1) return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'agendamentos', arguments: '{"pagina":1}' }] };
    const result = JSON.parse(params.input.at(-1).output);
    assert.equal(result.agendamentos[0].hora, '09:00');
    return { status: 'completed', output: [], output_text: appointmentReply };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const reply = await luna.reply('Qual o horário do meu agendamento?', phone);
  assert.equal(reply, appointmentReply);
  assert.equal(calls, 2);
  assert.deepEqual(api.calls.map(call => ({ action: call.action, body: call.body })), [
    { action: 'agendamentos', body: { telefone: phone, pagina: 1 } },
  ]);
  assert.equal(store.get('pending', phone), null);
});

test('catálogo consultado mantém os IDs reais entre mensagens sem virar cache de horários', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const calls = []; const reads = [];
  const source = { sucesso: true, barbeiros: [{ id: 5, nome: 'Julio', servicos: [{ id: 72, nome: 'Corte', preco: '35.00', duracao_minutos: 30 }] }] };
  const query = { barbeiro_id: 5, servicos: [72], data: bookingArgs.data };
  const api = { async request(action, params) {
    reads.push({ action, params });
    if (action === 'catalogo') return source;
    assert.equal(action, 'disponibilidade');
    assert.equal(params.barbeiro_id, 5);
    assert.deepEqual(params.servicos, [72]);
    return { dias: [{ data: query.data, horarios: [{ hora: '10:00' }] }] };
  } };
  const client = { responses: { async create(params) {
    calls.push(structuredClone(params));
    if (calls.length === 1) return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'catalogo', arguments: '{}' }] };
    if (calls.length === 2) return { status: 'completed', output: [], output_text: 'O corte com Julio fica R$ 35,00.' };
    return { output: [{ type: 'function_call', id: 'fc2', call_id: 'call2', name: 'grade_horarios', arguments: JSON.stringify(query) }] };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const firstMetadata = {};
  const first = await luna.reply('Quanto custa o corte?', phone, firstMetadata);
  assert.deepEqual(firstMetadata.catalog.barbeiros, source.barbeiros);
  luna.remember(phone, 'Quanto custa o corte?', first, firstMetadata);
  assert.deepEqual(store.get('history', phone).catalog, firstMetadata.catalog);
  const nextMetadata = {};
  const next = await luna.reply('Quero marcar com Julio no dia 24/10/2099. Quais horários?', phone, nextMetadata);
  assert.equal(calls.length, 3);
  const suppliedContext = calls[2].instructions + calls[2].input.map(item => typeof item.content === 'string' ? item.content : '').join('\n');
  assert.ok(suppliedContext.includes(JSON.stringify(firstMetadata.catalog)), 'Os IDs consultados acompanham a próxima mensagem');
  assert.match(next, /10:00/);
  assert.deepEqual(nextMetadata.scheduleQuery, query);
  assert.equal(reads.filter(read => read.action === 'disponibilidade').length, 1, 'O catálogo guardado não substitui nova consulta de vagas');
  luna.remember(phone, 'Quero marcar com Julio no dia 24/10/2099. Quais horários?', next, nextMetadata);
  assert.deepEqual(store.get('history', phone).catalog, firstMetadata.catalog, 'Um turno sem novo catálogo preserva os IDs ainda válidos');
  assert.equal(store.get('history', '21999991234'), null);
});

test('IDs inválidos são corrigidos com catálogo atual antes de consultar ou preparar horário', async t => {
  for (const tool of ['grade_horarios', 'preparar_agendamento']) {
    await t.test(tool, async t => {
      const store = memoryStore(); t.after(() => store.close());
      const c = config(); const reads = []; let calls = 0;
      const source = { sucesso: true, barbeiros: [{ id: 5, nome: 'Julio', servicos: [{ id: 72, nome: 'Corte', preco: '35.00', duracao_minutos: 30 }] }] };
      const query = { barbeiro_id: 5, servicos: [72], data: bookingArgs.data };
      const validArgs = tool === 'preparar_agendamento' ? { ...query, nome: 'Cliente Teste', hora: '09:00' } : query;
      const api = { async request(action, params) {
        reads.push({ action, params });
        if (action === 'catalogo') return source;
        assert.equal(action, 'disponibilidade', 'Nenhum POST deve acontecer durante a recuperação dos IDs');
        assert.equal(params.barbeiro_id, 5);
        assert.deepEqual(params.servicos, [72]);
        return { dias: [{ data: query.data, horarios: [{ hora: '09:00' }] }] };
      } };
      const client = { responses: { async create(params) {
        calls++;
        if (calls === 2) {
          const error = JSON.parse(params.input.at(-1).output);
          assert.equal(error.sucesso, false);
          assert.equal(error.codigo, 'dados_invalidos');
          assert.deepEqual(error.catalogo.barbeiros, source.barbeiros);
          assert.equal(store.get('pending', phone), null);
          assert.equal(reads.some(read => read.action === 'disponibilidade'), false);
        }
        return { output: [{ type: 'function_call', id: `fc${calls}`, call_id: `call${calls}`, name: tool, arguments: JSON.stringify(calls === 1 ? { ...validArgs, barbeiro_id: 1, servicos: [2] } : validArgs) }] };
      } } };
      const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
      const metadata = {};
      const reply = await luna.reply('Quero esse corte com Julio em 24/10/2099.', phone, metadata);
      assert.equal(calls, 2);
      assert.deepEqual(metadata.catalog.barbeiros, source.barbeiros);
      assert.match(reply, /09:00/);
      assert.doesNotMatch(reply, /Não consegui consultar|não aceitou esses dados/);
      assert.deepEqual(reads.map(read => read.action), ['catalogo', 'catalogo', 'catalogo', 'disponibilidade']);
      if (tool === 'grade_horarios') {
        assert.deepEqual(metadata.scheduleQuery, query);
        assert.equal(store.get('pending', phone), null);
      } else {
        const pending = store.get('pending', phone);
        assert.equal(pending.state, 'prepared');
        assert.equal(pending.payload.barbeiro_id, 5);
        assert.deepEqual(pending.payload.servicos, [72]);
      }
    });
  }
});

test('catálogo expirado não reaparece no contexto nem é herdado por uma conversa nova', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const calls = []; const api = fakeApi();
  const stale = { barbeiros: [{ id: 91, nome: 'Profissional Antigo', servicos: [{ id: 92, nome: 'Corte', preco: '1.00' }] }] };
  store.set('history', phone, { messages: [{ role: 'assistant', content: 'Contexto antigo.' }], catalog: stale, updatedAt: Date.now() - (c.HISTORY_TTL_HOURS + 1) * 3600000 });
  const client = { responses: { async create(params) {
    calls.push(structuredClone(params));
    return { status: 'completed', output: [], output_text: 'Oi! Tudo bem?' };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const reply = await luna.reply('Oi', phone);
  assert.doesNotMatch(calls[0].instructions, /Profissional Antigo/);
  assert.deepEqual(calls[0].input, [{ role: 'user', content: 'Oi' }]);
  luna.remember(phone, 'Oi', reply);
  assert.equal(store.get('history', phone).catalog, undefined);
  assert.equal(api.calls.length, 0);
});

test('dia curto imediatamente após grade reconsulta os mesmos serviços e comparação sem chamar IA', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const reads = [];
  const source = { sucesso: true, barbeiros: [
    { id: 5, nome: 'Julio', servicos: [{ id: 72, nome: 'Corte', preco: '35.00' }] },
    { id: 7, nome: 'Eduardo', servicos: [{ id: 28, nome: 'Corte de cabelo', preco: '30.00' }] },
  ] };
  const api = { async request(action, params) {
    if (action === 'catalogo') return source;
    assert.equal(action, 'disponibilidade');
    reads.push(params);
    return { dias: [{ data: params.data_inicio, horarios: [{ hora: params.barbeiro_id === 5 ? '11:00' : '14:00' }] }] };
  } };
  const client = { responses: { async create() { assert.fail('Uma mudança só de dia depois da grade não precisa de IA'); } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const previousQuery = { barbeiro_id: 5, servicos: [72], data: null, comparar_barbeiros: true };
  luna.remember(phone, 'Quero corte com qualquer um.', 'Grade antiga: 09:00', { scheduleQuery: previousQuery });
  assert.deepEqual(store.get('history', phone).scheduleQuery, previousQuery);
  for (const [text, offset] of [['Hoje', 0], ['amanhã', 1]]) {
    const day = new Date(`${localTime(c.BARBEARIA_TIMEZONE).slice(0, 10)}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() + offset);
    const expectedDate = day.toISOString().slice(0, 10);
    const metadata = {};
    const before = reads.length;
    const reply = await luna.reply(text, phone, metadata);
    assert.match(reply, /11:00/);
    assert.match(reply, /14:00/);
    assert.doesNotMatch(reply, /09:00/);
    assert.deepEqual(metadata.scheduleQuery, { ...previousQuery, data: expectedDate });
    assert.deepEqual(reads.slice(before), [
      { barbeiro_id: 5, servicos: [72], data_inicio: expectedDate, data_fim: expectedDate },
      { barbeiro_id: 7, servicos: [28], data_inicio: expectedDate, data_fim: expectedDate },
    ]);
    luna.remember(phone, text, reply, metadata);
  }
  assert.equal(store.get('pending', phone), null);
});

test('mensagem intermediária sem grade limpa a consulta anterior para permitir trocar barbeiro', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const reads = []; let modelCalls = 0;
  const source = { sucesso: true, barbeiros: [
    { id: 5, nome: 'Julio', servicos: [{ id: 72, nome: 'Corte', preco: '35.00' }] },
    { id: 7, nome: 'Eduardo', servicos: [{ id: 28, nome: 'Corte de cabelo', preco: '30.00' }] },
  ] };
  const expectedDate = localTime(c.BARBEARIA_TIMEZONE).slice(0, 10);
  const query = { barbeiro_id: 7, servicos: [28], data: expectedDate };
  const api = { async request(action, params) {
    if (action === 'catalogo') return source;
    assert.equal(action, 'disponibilidade');
    reads.push(params);
    assert.equal(params.barbeiro_id, 7, 'Não pode reutilizar o barbeiro da grade anterior à troca');
    return { dias: [{ data: expectedDate, horarios: [{ hora: '14:00' }] }] };
  } };
  const client = { responses: { async create() {
    modelCalls++;
    return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'grade_horarios', arguments: JSON.stringify(query) }] };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  luna.remember(phone, 'Quero com Julio.', 'Grade antiga: 09:00', { catalog: source, scheduleQuery: { barbeiro_id: 5, servicos: [72], data: bookingArgs.data } });
  luna.remember(phone, 'Agora quero com Eduardo.', 'Pra qual dia?');
  assert.equal(store.get('history', phone).scheduleQuery, undefined);
  assert.deepEqual(store.get('history', phone).catalog, source);
  const metadata = {};
  const reply = await luna.reply('Hoje', phone, metadata);
  assert.equal(modelCalls, 1);
  assert.match(reply, /Eduardo/);
  assert.match(reply, /14:00/);
  assert.deepEqual(metadata.scheduleQuery, query);
  assert.deepEqual(reads, [{ barbeiro_id: 7, servicos: [28], data_inicio: expectedDate, data_fim: expectedDate }]);
  assert.equal(store.get('pending', phone), null);
});

test('pedido sem dia pergunta a data e aproveita a escolha validada quando o cliente responde amanhã', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const reads = []; let calls = 0;
  const day = new Date(`${localTime(c.BARBEARIA_TIMEZONE).slice(0, 10)}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  const expectedDate = day.toISOString().slice(0, 10);
  const api = { async request(action, params) {
    reads.push({ action, params });
    if (action === 'catalogo') return catalog;
    assert.equal(action, 'disponibilidade', 'O fluxo só deve consultar');
    assert.equal(params.data_inicio, expectedDate, 'A data inventada pelo modelo não pode chegar ao site');
    return { dias: [{ data: expectedDate, horarios: [{ hora: '09:00' }] }] };
  } };
  const client = { responses: { async create() {
    calls++;
    assert.equal(calls, 1, 'A resposta curta com o dia usa a seleção já validada');
    return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'grade_horarios', arguments: JSON.stringify({ barbeiro_id: 1, servicos: [2], data: '2099-10-24' }) }] };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const metadata = {};
  const question = await luna.reply('Quero marcar um corte com Julio.', phone, metadata);
  assert.match(question, /qual dia/i);
  assert.equal(metadata.scheduleQuery, undefined, 'Uma pergunta não pode virar grade ao ser reenviada');
  assert.deepEqual(reads.map(read => read.action), ['catalogo']);
  luna.remember(phone, 'Quero marcar um corte com Julio.', question, metadata);
  const nextMetadata = {};
  const grade = await luna.reply('Amanhã', phone, nextMetadata);
  assert.match(grade, /09:00/);
  assert.deepEqual(nextMetadata.scheduleQuery, { barbeiro_id: 1, servicos: [2], data: expectedDate });
  assert.equal(calls, 1);
  assert.equal(store.get('pending', phone), null);
});

test('pedido de sugestões sem dia consulta a janela em vez da data inventada pelo modelo', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const reads = [];
  const api = { async request(action, params) {
    reads.push({ action, params });
    if (action === 'catalogo') return catalog;
    assert.equal(action, 'disponibilidade');
    assert.deepEqual(params, { barbeiro_id: 1, servicos: [2] });
    return { dias: [{ data: bookingArgs.data, horarios: [{ hora: '10:00' }] }] };
  } };
  const client = { responses: { async create() {
    return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'grade_horarios', arguments: JSON.stringify({ barbeiro_id: 1, servicos: [2], data: '2000-01-01' }) }] };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const metadata = {};
  const reply = await luna.reply('Quero um corte com Julio, quais os próximos horários?', phone, metadata);
  assert.match(reply, /10:00/);
  assert.equal(metadata.scheduleQuery.data, null);
  assert.deepEqual(reads.map(read => read.action), ['catalogo', 'disponibilidade']);
  assert.equal(store.get('pending', phone), null);
});

test('hora já informada é conferida sem reenviar a grade nem pedir para escolher de novo', async t => {
  for (const [text, hora] of [
    ['Quero corte com Julio em 24/10/2099 às 9h.', '09:00'],
    ['Em 24/10/2099, corte com Julio às 09:00.', '09:00'],
    ['Em 24/10/2099, corte com Julio às 09:30.', '09:30'],
  ]) {
    await t.test(text, async t => {
      const store = memoryStore(); t.after(() => store.close());
      const c = config(); const api = fakeApi(); let calls = 0;
      const original = api.request.bind(api);
      api.request = async (action, ...args) => {
        const result = await original(action, ...args);
        return action === 'disponibilidade' ? { dias: [{ data: bookingArgs.data, horarios: [{ hora }] }] } : result;
      };
      const client = { responses: { async create(params) {
        calls++;
        if (calls === 1) return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'grade_horarios', arguments: JSON.stringify({ barbeiro_id: 1, servicos: [2], data: bookingArgs.data }) }] };
        const checked = JSON.parse(params.input.at(-1).output);
        assert.equal(checked.disponivel, true);
        assert.equal(checked.horario_consultado.hora, hora);
        return { output: [], output_text: 'Qual seu nome?', status: 'completed' };
      } } };
      const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
      const metadata = {};
      const reply = await luna.reply(text, phone, metadata);
      assert.equal(reply, 'Qual seu nome?');
      assert.equal(metadata.scheduleQuery, undefined);
      assert.equal(store.get('pending', phone), null);
      assert.deepEqual(api.calls.map(call => call.action), ['catalogo', 'catalogo', 'disponibilidade']);
    });
  }
});

test('horário informado sem vaga devolve alternativas atuais em vez de aceitar a escolha', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const api = fakeApi(); const original = api.request.bind(api);
  api.request = async (action, ...args) => action === 'disponibilidade'
    ? { dias: [{ data: bookingArgs.data, horarios: [{ hora: '10:00' }] }] }
    : original(action, ...args);
  const client = { responses: { async create() {
    return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'grade_horarios', arguments: JSON.stringify({ barbeiro_id: 1, servicos: [2], data: bookingArgs.data }) }] };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const metadata = {};
  const reply = await luna.reply('Corte com Julio em 24/10/2099 às 9h.', phone, metadata);
  assert.match(reply, /ficou indisponível/);
  assert.match(reply, /10:00/);
  assert.doesNotMatch(reply, /09:00/);
  assert.equal(store.get('pending', phone), null);
  assert.equal(metadata.scheduleQuery.data, bookingArgs.data);
});

test('pedido com hora mas sem dia mantém a hora quando o cliente informa a data e depois o nome', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const api = fakeApi(); const original = api.request.bind(api);
  const day = new Date(`${localTime(c.BARBEARIA_TIMEZONE).slice(0, 10)}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  const data = day.toISOString().slice(0, 10);
  api.request = async (action, ...args) => action === 'disponibilidade'
    ? { dias: [{ data, horarios: [{ hora: '09:00' }] }] }
    : original(action, ...args);
  let calls = 0;
  const client = { responses: { async create(params) {
    calls++;
    if (calls === 3) return { output: [], output_text: 'Qual seu nome?', status: 'completed' };
    const prepare = calls === 4;
    const args = prepare ? { ...bookingArgs, nome: 'Bruno', data } : { barbeiro_id: 1, servicos: [2], data };
    return { output: [{ type: 'function_call', id: `fc${calls}`, call_id: `call${calls}`, name: prepare ? 'preparar_agendamento' : 'grade_horarios', arguments: JSON.stringify(args) }] };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const firstMetadata = {};
  const question = await luna.reply('Quero corte com Julio às 9h.', phone, firstMetadata);
  assert.match(question, /qual dia/i);
  assert.equal(firstMetadata.scheduleSelection.hora, '09:00');
  luna.remember(phone, 'Quero corte com Julio às 9h.', question, firstMetadata);
  const next = await luna.reply('Amanhã', phone);
  assert.equal(next, 'Qual seu nome?');
  luna.remember(phone, 'Amanhã', next);
  const summary = await luna.reply('Bruno', phone);
  assert.match(summary, /CONFIRMAR/);
  const pending = store.get('pending', phone);
  assert.equal(pending.payload.data, data);
  assert.equal(pending.payload.hora, '09:00');
  assert.equal(pending.payload.nome, 'Bruno');
  assert.equal(api.calls.some(call => call.action === 'agendar'), false);
});

test('listagem de modalidades é enviada sem resumir tesoura e mantém catálogo para a próxima escolha', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); let modelCalls = 0;
  const source = { barbeiros: [{ id: 5, nome: 'Julio', servicos: [
    { id: 2, nome: 'Corte', preco: '35.00' }, { id: 3, nome: 'Corte com Tesoura', preco: '40.00' },
  ] }] };
  const api = { async request(action) { assert.equal(action, 'catalogo'); return source; } };
  const client = { responses: { async create() {
    modelCalls++;
    return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'listar_cortes', arguments: '{"barbeiro_id":null}' }] };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const metadata = {};
  const reply = await luna.reply('Quais cortes tem e quanto custa?', phone, metadata);
  assert.match(reply, /Corte de cabelo:\n\nJulio fica R\$\s35,00/);
  assert.match(reply, /Corte com Tesoura:\n\nJulio fica R\$\s40,00/);
  assert.equal(modelCalls, 1);
  luna.remember(phone, 'Quais cortes tem e quanto custa?', reply, metadata);
  assert.equal(store.get('history', phone).catalog.modalidades_cortes.opcoes[1].servico_id, 3);
  assert.equal(store.get('pending', phone), null);
});

test('pedido incerto não bloqueia respostas de serviços nem consome ou repete a reserva', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const api = fakeApi(); let calls = 0;
  const pending = { state: 'executing', action: 'agendar', id: 'chave-original', code: '05A0D9', payload: { ...bookingArgs, telefone: phone } };
  store.set('pending', phone, pending);
  const client = { responses: { async create(params) {
    calls++;
    assert.match(params.instructions, /Responda normalmente/);
    return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'listar_cortes', arguments: '{"barbeiro_id":1}' }] };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  const reply = await luna.reply('Quais serviços Julio tem?', phone);
  assert.match(reply, /Serviços com Julio/);
  assert.doesNotMatch(reply, /CONFIRMAR|05A0D9|resultado do pedido/);
  assert.equal(calls, 1);
  assert.deepEqual(store.get('pending', phone), pending);
  assert.deepEqual(api.calls.map(c => c.action), ['catalogo']);
});

test('pergunta geral depois de escolher Julio nunca usa lista restrita de cortes', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); let calls = 0;
  const source = { barbeiros: [{ id: 5, nome: 'Julio', servicos: [
    { id: 2, nome: 'Corte', preco: '35.00' }, { id: 3, nome: 'Corte com Tesoura', preco: '40.00' },
    { id: 4, nome: 'Barba', preco: '35.00' }, { id: 5, nome: 'Hidratação', preco: '20.00' },
    { id: 6, nome: 'Sobrancelha', preco: '7.00' }, { id: 7, nome: 'Serviço exclusivo', preco: '15.00' },
  ] }] };
  const client = { responses: { async create() {
    calls++;
    // Mesmo uma escolha incorreta da ferramenta pelo modelo é corrigida pelo backend.
    return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'listar_cortes', arguments: '{"barbeiro_id":5}' }] };
  } } };
  const api = { async request(action) { assert.equal(action, 'catalogo'); return source; } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ config: c, store, api }), client });
  luna.remember(phone, 'Julio', 'Qual serviço você quer com o Julio?');
  const metadata = {};
  const reply = await luna.reply('Quais serviços tem?', phone, metadata);
  assert.match(reply, /Serviços com Julio/);
  for (const service of source.barbeiros[0].servicos) assert.ok(reply.includes(service.nome));
  assert.equal(calls, 1);
  assert.equal(metadata.catalog.barbeiros[0].servicos.length, 6);
  assert.equal(store.get('pending', phone), null);
});

test('pedido de horários sem escolhas recebe profissionais e depois todos os serviços do escolhido', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const reads = []; let calls = 0;
  const source = { barbeiros: [
    { id: 5, nome: 'Julio', servicos: [{ id: 2, nome: 'Corte', preco: '35.00' }, { id: 3, nome: 'Barba', preco: '35.00' }, { id: 4, nome: 'Hidratação', preco: '20.00' }] },
    { id: 7, nome: 'Eduardo', servicos: [{ id: 28, nome: 'Corte', preco: '30.00' }] },
  ] };
  const api = { async request(action) { reads.push(action); assert.equal(action, 'catalogo'); return source; } };
  const client = { responses: { async create() {
    calls++;
    return { output: [{ type: 'function_call', id: `fc${calls}`, call_id: `call${calls}`,
      name: calls === 1 ? 'listar_barbeiros' : 'listar_servicos', arguments: calls === 1 ? '{}' : '{"barbeiro_id":5}' }] };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ config: c, store, api }), client });
  const firstMetadata = {};
  const first = await luna.reply('Que horas tem disponível?', phone, firstMetadata);
  assert.match(first, /Julio 💈/);
  assert.match(first, /Eduardo 💈/);
  assert.doesNotMatch(first, /qual serviço/i);
  luna.remember(phone, 'Que horas tem disponível?', first, firstMetadata);
  const secondMetadata = {};
  const second = await luna.reply('Julio', phone, secondMetadata);
  for (const service of source.barbeiros[0].servicos) assert.ok(second.includes(service.nome));
  assert.doesNotMatch(second, /Eduardo/);
  assert.match(second, /💈$/);
  assert.equal(calls, 2, 'Listas prontas não passam por outra resposta que omita itens');
  assert.deepEqual(reads, ['catalogo', 'catalogo']);
  assert.equal(store.get('pending', phone), null);
});
