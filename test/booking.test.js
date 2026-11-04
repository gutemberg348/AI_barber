import test from 'node:test';
import assert from 'node:assert/strict';
import { BookingService, localTime } from '../src/booking.js';
import { ApiError } from '../src/barbershop.js';
import { config, memoryStore, fakeApi, phone, bookingArgs, prepareAndPresent } from './helpers.js';

function setup(t) {
  const store = memoryStore(); t.after(() => store.close());
  const api = fakeApi();
  return { store, api, booking: new BookingService({ store, api, config: config() }) };
}

test('resumo pede confirmação simples sem código e só grava após aceite; preço vem do catálogo', async t => {
  const { booking, store, api } = setup(t);
  const result = await prepareAndPresent(booking, 'preparar_agendamento', bookingArgs, phone);
  assert.match(result.directReply, /Julio/); assert.match(result.directReply, /30,00/);
  assert.equal(api.calls.filter(c => c.action === 'agendar').length, 0);
  assert.match(result.directReply, /Responda SIM ou CONFIRMAR/);
  assert.doesNotMatch(result.directReply, /CONFIRMAR [A-F0-9]{6}/);
  await booking.command('CONFIRMAR ERRADO', phone);
  assert.equal(api.calls.filter(c => c.action === 'agendar').length, 0);
  const pending = store.get('pending', phone);
  const reply = await booking.command('Sim!', phone);
  assert.match(reply, /Reserva #123 registrada/);
  const call = api.calls.find(c => c.action === 'agendar');
  assert.equal(call.body.telefone, phone); assert.equal(call.key, pending.id);
  // Repetição antes de gravar a resposta (ex.: reinício) recupera resultado local.
  assert.equal(await booking.command(`CONFIRMAR ${pending.code}`, phone), reply);
  assert.equal(api.calls.filter(c => c.action === 'agendar').length, 1);
});

test('telefone não pode ser fornecido pelo modelo, nem ferramenta de escrita direta', async t => {
  const { booking, api } = setup(t);
  await assert.rejects(prepareAndPresent(booking, 'preparar_agendamento', { ...bookingArgs, telefone: 'outro' }, phone));
  await assert.rejects(booking.tool('agendar', bookingArgs, phone));
  await booking.tool('agendamentos', { pagina: 1 }, phone);
  assert.equal(api.calls[0].body.telefone, phone);
});

test('não prepara vaga inexistente e invalida confirmação antiga ao devolver grade atual', async t => {
  const { booking, store, api } = setup(t);
  await assert.rejects(prepareAndPresent(booking, 'preparar_agendamento', { ...bookingArgs, servicos: [999] }, phone));
  await prepareAndPresent(booking, 'preparar_agendamento', bookingArgs, phone);
  const previous = store.get('pending', phone);
  const unavailable = await prepareAndPresent(booking, 'preparar_agendamento', { ...bookingArgs, hora: '10:00' }, phone);
  assert.match(unavailable.directReply, /indisponível/);
  assert.match(unavailable.directReply, /09:00/);
  assert.doesNotMatch(unavailable.directReply, /10:00/);
  assert.equal(store.get('pending', phone), null);
  assert.match(await booking.command(`CONFIRMAR ${previous.code}`, phone), /Não há pedido/);
  assert.equal(api.calls.some(c => c.action === 'agendar'), false);
  await assert.rejects(prepareAndPresent(booking, 'preparar_agendamento', { ...bookingArgs, data: '2099-02-31' }, phone));
  await assert.rejects(prepareAndPresent(booking, 'preparar_agendamento', { ...bookingArgs, servicos: [2, 2] }, phone));
});

test('expiração e desistência não escrevem no site', async t => {
  const { booking, store, api } = setup(t);
  await prepareAndPresent(booking, 'preparar_agendamento', bookingArgs, phone);
  const op = store.get('pending', phone); op.expiresAt = 1; store.set('pending', phone, op);
  assert.match(await booking.command(`CONFIRMAR ${op.code}`, phone), /expirou/);
  await prepareAndPresent(booking, 'preparar_agendamento', bookingArgs, phone);
  await booking.command('DESISTIR', phone);
  assert.equal(store.get('pending', phone), null);
  assert.equal(api.calls.filter(c => c.action === 'agendar').length, 0);
});

test('timeout persiste chave e corpo e impede operação concorrente até recuperar resultado', async t => {
  const { booking, store, api } = setup(t);
  await prepareAndPresent(booking, 'preparar_agendamento', bookingArgs, phone);
  const pending = store.get('pending', phone);
  const original = api.request.bind(api);
  let first = true;
  let recovering = false;
  const postAttempts = [];
  api.request = async (...args) => {
    if (recovering && args[0] !== 'agendar') assert.fail('Recuperação incerta deve repetir POST sem consultar a vaga ocupada pela própria reserva');
    if (args[0] === 'agendar') {
      postAttempts.push({ body: structuredClone(args[1]), key: args[2] });
      if (first) { first = false; throw new ApiError('timeout', 0, true); }
    }
    return original(...args);
  };
  assert.match(await booking.command(`CONFIRMAR ${pending.code}`, phone), /CONFIRMAR/);
  assert.equal(store.get('pending', phone).state, 'executing');
  assert.match((await prepareAndPresent(booking, 'preparar_cancelamento', { agendamento_id: 123 }, phone)).directReply, /CONFIRMAR/);
  assert.match(await booking.command('DESISTIR', phone), /CONFIRMAR/);
  recovering = true;
  assert.match(await booking.command(`CONFIRMAR ${pending.code}`, phone), /Reserva #123 registrada/);
  const call = api.calls.find(c => c.action === 'agendar');
  assert.equal(call.key, pending.id); assert.deepEqual(call.body, pending.payload);
  assert.deepEqual(postAttempts, [
    { body: pending.payload, key: pending.id },
    { body: pending.payload, key: pending.id },
  ]);
  assert.equal(store.get('pending', phone).state, 'completed');
});

test('confirmações naturais aceitam só o pedido preparado, sem interpretar perguntas como aceite', async t => {
  for (const text of ['confirmar', 'confirmo', 'pode marcar', 'pode confirmar!', 'sim pode agendar']) {
    await t.test(text, async t => {
      const { booking, store, api } = setup(t);
      assert.equal(await booking.command('sim', phone), null, 'Um sim solto não inicia pedido');
      await prepareAndPresent(booking, 'preparar_agendamento', bookingArgs, phone);
      assert.equal(await booking.command('sim, mas troca para amanhã', phone), null);
      assert.equal(api.calls.some(c => c.action === 'agendar'), false);
      assert.match(await booking.command(text, phone), /Reserva #123 registrada/);
      assert.equal(api.calls.filter(c => c.action === 'agendar').length, 1);
      assert.equal(store.get('pending', phone).state, 'completed');
    });
  }
});

test('qualquer aceite antes do resumo entregue devolve o resumo sem consultar nem gravar', async t => {
  for (const text of ['sim', 'confirmar', 'pode marcar']) {
    await t.test(text, async t => {
      const { booking, store, api } = setup(t);
      const prepared = await booking.tool('preparar_agendamento', bookingArgs, phone);
      const pending = store.get('pending', phone);
      assert.equal(pending.confirmationShownAt, undefined);
      const before = api.calls.length;
      assert.equal(await booking.command(text, phone), prepared.directReply);
      assert.equal(api.calls.length, before, 'Nenhum POST antes do resumo entregue');
      // Histórico gerado também não é evidência de entrega pelo WhatsApp.
      store.set('history', phone, { messages: [{ role: 'assistant', content: prepared.directReply }], updatedAt: Date.now() });
      assert.equal(await booking.command(text, phone), prepared.directReply);
      assert.equal(api.calls.length, before);
      booking.markSummaryDelivered(phone, prepared.directReply);
      assert.ok(store.get('pending', phone).confirmationShownAt);
      assert.match(await booking.command(text, phone), /Reserva #123 registrada/);
      assert.equal(api.calls.filter(c => c.action === 'agendar').length, 1);
    });
  }
});

test('confirmação recebida antes da entrega e confirmação após pergunta intermediária não gravam', async t => {
  const { booking, store, api } = setup(t);
  const prepared = await booking.tool('preparar_agendamento', bookingArgs, phone);
  booking.markSummaryDelivered(phone, prepared.directReply);
  const shownAt = store.get('pending', phone).confirmationShownAt;
  assert.equal(await booking.command('confirmar', phone, { receivedAt: shownAt - 1 }), prepared.directReply);
  store.set('history', phone, { messages: [{ role: 'assistant', content: 'Quer consultar outro barbeiro?' }], updatedAt: Date.now() });
  assert.equal(await booking.command('confirmar', phone), prepared.directReply, 'CONFIRMAR também não pode pular o contexto');
  assert.equal(api.calls.some(c => c.action === 'agendar'), false);
});

test('não descarta apenas o pedido sem confirmar e uma resposta a outra pergunta exige rever resumo', async t => {
  const { booking, store, api } = setup(t);
  await prepareAndPresent(booking, 'preparar_agendamento', bookingArgs, phone);
  assert.match(await booking.command('Não.', phone), /Pedido descartado/);
  assert.equal(store.get('pending', phone), null);
  await prepareAndPresent(booking, 'preparar_agendamento', bookingArgs, phone);
  store.set('history', phone, { messages: [{ role: 'assistant', content: 'Quer ver os serviços da tesoura?' }], updatedAt: Date.now() });
  const summary = await booking.command('sim', phone);
  assert.match(summary, /Posso confirmar/);
  assert.equal(api.calls.some(c => c.action === 'agendar'), false);
  store.set('history', phone, { messages: [{ role: 'assistant', content: summary }], updatedAt: Date.now() });
  assert.match(await booking.command('sim', phone), /Reserva #123 registrada/);
});

test('500 guarda diagnóstico seguro e recuperação repete exatamente chave e corpo sem código', async t => {
  const { booking, store, api } = setup(t);
  const logs = []; booking.logger = { warn(data) { logs.push(data); } };
  await prepareAndPresent(booking, 'preparar_agendamento', bookingArgs, phone);
  const pending = store.get('pending', phone);
  const original = api.request.bind(api); const posts = []; let fail = true;
  api.request = async (action, body, key) => {
    if (action === 'agendar') {
      posts.push({ body: structuredClone(body), key });
      if (fail) throw new ApiError('erro_interno', 500, true);
    }
    return original(action, body, key);
  };
  const failure = await booking.command('confirmar', phone);
  assert.match(failure, /Pedido anterior aguardando resultado/);
  assert.match(failure, /Cliente Teste · Julio/);
  assert.match(failure, /Corte · R\$\s30,00/);
  assert.match(failure, /24\/10\/2099 às 09:00/);
  assert.match(failure, /Responda SIM ou CONFIRMAR/);
  assert.doesNotMatch(failure, /Ainda não reservado|site está com erro/);
  assert.doesNotMatch(failure, new RegExp(pending.code));
  const uncertain = store.get('pending', phone);
  assert.equal(uncertain.lastError.status, 500);
  assert.equal(uncertain.lastError.code, 'erro_interno');
  assert.equal(uncertain.state, 'executing');
  assert.deepEqual(logs, [{ event: 'booking_failed', action: 'agendar', apiCode: 'erro_interno', httpStatus: 500, uncertain: true }]);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(phone));
  fail = false;
  assert.match(await booking.command('confirmar', phone), /Reserva #123 registrada/);
  assert.deepEqual(posts, [{ body: pending.payload, key: pending.id }, { body: pending.payload, key: pending.id }]);
});

test('consultar vaga ocupada durante resultado incerto não apaga a operação original', async t => {
  const { booking, store, api } = setup(t);
  const pending = { state: 'executing', id: 'mesma-chave', code: 'ABC123', action: 'agendar', payload: bookingArgs };
  store.set('pending', phone, pending);
  const result = await booking.tool('conferir_horario', { barbeiro_id: 1, servicos: [2], data: bookingArgs.data, hora: '10:00' }, phone);
  assert.match(result.directReply, /09:00/);
  assert.deepEqual(store.get('pending', phone), pending);
  assert.equal(api.calls.some(c => ['agendar', 'cancelar'].includes(c.action)), false);
});

test('cancelamento consulta titular e confirma separadamente', async t => {
  const { booking, store, api } = setup(t);
  await prepareAndPresent(booking, 'preparar_cancelamento', { agendamento_id: 123 }, phone);
  const op = store.get('pending', phone);
  assert.equal(api.calls[0].body.telefone, phone);
  assert.equal(api.calls.some(c => c.action === 'cancelar'), false);
  assert.match(await booking.command(`CONFIRMAR ${op.code}`, phone), /Cancelamento registrado/);
  assert.deepEqual(api.calls.at(-1).body, { agendamento_id: 123, telefone: phone });
});

test('vaga ocupada entre preparar e confirmar impede POST e devolve grade nova', async t => {
  const { booking, store, api } = setup(t);
  await prepareAndPresent(booking, 'preparar_agendamento', bookingArgs, phone);
  const op = store.get('pending', phone);
  const original = api.request.bind(api);
  const requests = [];
  api.request = async (action, ...args) => {
    requests.push(action);
    if (action === 'disponibilidade') return availableAt('10:00', '11:00');
    return original(action, ...args);
  };
  const metadata = {};
  const reply = await booking.command(`CONFIRMAR ${op.code}`, phone, metadata);
  assert.match(reply, /indisponível/);
  assert.match(reply, /10:00\n11:00/);
  assert.doesNotMatch(reply, /09:00|registrada/);
  assert.equal(requests.includes('agendar'), false);
  assert.equal(api.calls.some(c => c.action === 'agendar'), false);
  assert.deepEqual(metadata.scheduleQuery, { barbeiro_id: bookingArgs.barbeiro_id, servicos: bookingArgs.servicos, data: bookingArgs.data });
  assert.match(metadata.scheduleNotice, /não foi reservado/);
  assert.equal(store.get('pending', phone), null);
});

test('preparo com período inválido descarta confirmação anterior e sugere próximas vagas sem POST', async t => {
  const { booking, store, api } = setup(t);
  await prepareAndPresent(booking, 'preparar_agendamento', bookingArgs, phone);
  const previous = store.get('pending', phone);
  const requested = { ...bookingArgs, data: '2099-11-05' };
  const original = api.request.bind(api);
  const requests = [];
  api.request = async (action, body, key) => {
    requests.push({ action, body });
    if (action === 'disponibilidade') {
      if (body.data_inicio) throw new ApiError('periodo_invalido', 422);
      return { sucesso: true, dias: [{ data: '2099-10-26', horarios: [{ hora: '10:00' }, { hora: '11:00' }] }] };
    }
    return original(action, body, key);
  };
  const result = await prepareAndPresent(booking, 'preparar_agendamento', requested, phone);
  assert.match(result.directReply, /fora da agenda liberada/i);
  assert.match(result.directReply, /26\/10\/2099\n\n10:00\n11:00/);
  assert.doesNotMatch(result.directReply, /Esse horário ficou indisponível|está sem vagas|CONFIRMAR|registrada/);
  assert.deepEqual(result.scheduleQuery, { barbeiro_id: requested.barbeiro_id, servicos: requested.servicos, data: requested.data });
  assert.match(result.scheduleNotice, /não foi reservado/);
  assert.equal(store.get('pending', phone), null);
  assert.equal(requests.some(call => call.action === 'disponibilidade' && !call.body.data_inicio), true);
  assert.equal(requests.some(call => call.action === 'agendar'), false);
  assert.match(await booking.command(`CONFIRMAR ${previous.code}`, phone), /Não há pedido/);
  assert.equal(api.calls.some(call => call.action === 'agendar'), false);
});

test('período que sai da janela antes de confirmar invalida código e oferece grade atual sem POST', async t => {
  const { booking, store, api } = setup(t);
  await prepareAndPresent(booking, 'preparar_agendamento', bookingArgs, phone);
  const pending = store.get('pending', phone);
  const original = api.request.bind(api);
  const requests = [];
  api.request = async (action, body, key) => {
    requests.push({ action, body });
    if (action === 'disponibilidade') {
      if (body.data_inicio) throw new ApiError('periodo_invalido', 422);
      return { sucesso: true, dias: [{ data: '2099-10-26', horarios: [{ hora: '10:30' }] }] };
    }
    return original(action, body, key);
  };
  const metadata = {};
  const reply = await booking.command(`CONFIRMAR ${pending.code}`, phone, metadata);
  assert.match(reply, /fora da agenda liberada/i);
  assert.match(reply, /26\/10\/2099\n\n10:30/);
  assert.doesNotMatch(reply, /Esse horário ficou indisponível|está sem vagas|CONFIRMAR|registrada/);
  assert.deepEqual(metadata.scheduleQuery, { barbeiro_id: bookingArgs.barbeiro_id, servicos: bookingArgs.servicos, data: bookingArgs.data });
  assert.match(metadata.scheduleNotice, /não foi reservado/);
  assert.equal(store.get('pending', phone), null);
  assert.equal(requests.some(call => call.action === 'disponibilidade' && !call.body.data_inicio), true);
  assert.equal(requests.some(call => call.action === 'agendar'), false);
  assert.match(await booking.command(`CONFIRMAR ${pending.code}`, phone), /Não há pedido/);
  assert.equal(api.calls.some(call => call.action === 'agendar'), false);
});

test('corrida após GET livre e antes do POST trata 409 e consulta uma grade nova', async t => {
  const { booking, store, api } = setup(t);
  await prepareAndPresent(booking, 'preparar_agendamento', bookingArgs, phone);
  const op = store.get('pending', phone);
  const original = api.request.bind(api);
  const requests = [];
  let occupied = false;
  api.request = async (action, ...args) => {
    requests.push(action);
    if (action === 'disponibilidade') return availableAt(occupied ? '10:00' : '09:00');
    if (action === 'agendar') {
      occupied = true; // Outro cliente gravou depois da última leitura.
      throw new ApiError('horario_indisponivel', 409);
    }
    return original(action, ...args);
  };
  const reply = await booking.command(`CONFIRMAR ${op.code}`, phone);
  assert.match(reply, /indisponível/);
  assert.match(reply, /10:00/);
  assert.doesNotMatch(reply, /09:00|registrada/);
  assert.deepEqual(requests, ['disponibilidade', 'agendar', 'catalogo', 'disponibilidade']);
  assert.equal(store.get('pending', phone), null);
});

function availableAt(...hours) {
  return { sucesso: true, dias: [{ data: bookingArgs.data, horarios: hours.map(hora => ({ hora })) }] };
}

test('falha ou resposta incompleta da revalidação preserva prepared e não faz POST', async t => {
  const cases = [
    ['falha de rede', () => { throw new ApiError('conexao_indisponivel', 0); }],
    ['dias ausentes', () => ({ sucesso: true })],
    ['dia solicitado ausente', () => ({ sucesso: true, dias: [] })],
    ['horarios ausentes', () => ({ sucesso: true, dias: [{ data: bookingArgs.data }] })],
    ['hora inválida', () => availableAt('hora_invalida')],
  ];
  for (const [name, result] of cases) {
    await t.test(name, async subtest => {
      const { booking, store, api } = setup(subtest);
      await prepareAndPresent(booking, 'preparar_agendamento', bookingArgs, phone);
      const pending = store.get('pending', phone);
      const calls = [];
      api.request = async action => { calls.push(action); return result(); };
      const reply = await booking.command(`CONFIRMAR ${pending.code}`, phone);
      assert.match(reply, /Não consegui conferir a vaga/);
      assert.doesNotMatch(reply, /indisponível|sem vagas|registrada/);
      assert.deepEqual(calls, ['disponibilidade']);
      assert.deepEqual(store.get('pending', phone), pending);
      assert.equal(store.get('pending', phone).state, 'prepared');
    });
  }
});

test('duas conversas disputam a mesma vaga: gravação atômica permite uma reserva e a outra recebe grade', async t => {
  const { booking, store, api } = setup(t);
  const otherPhone = '21999991234';
  await prepareAndPresent(booking, 'preparar_agendamento', bookingArgs, phone);
  await prepareAndPresent(booking, 'preparar_agendamento', { ...bookingArgs, nome: 'Outro Cliente' }, otherPhone);
  const first = store.get('pending', phone);
  const second = store.get('pending', otherPhone);
  const original = api.request.bind(api);
  let releaseReads;
  const bothRead = new Promise(resolve => { releaseReads = resolve; });
  let reads = 0;
  let owner = null;
  const attempts = [];
  api.request = async (action, body, key) => {
    if (action === 'disponibilidade') {
      if (reads < 2) {
        reads++;
        if (reads === 2) releaseReads();
        await bothRead; // Ambos observam a vaga livre antes de qualquer POST.
        return availableAt('09:00', '10:00');
      }
      return availableAt('10:00');
    }
    if (action === 'agendar') {
      attempts.push({ body: structuredClone(body), key });
      if (owner) throw new ApiError('horario_indisponivel', 409);
      owner = body.telefone; // Simula decisão atômica no servidor da agenda.
    }
    return original(action, body, key);
  };
  const responses = await Promise.all([
    booking.command(`CONFIRMAR ${first.code}`, phone),
    booking.command(`CONFIRMAR ${second.code}`, otherPhone),
  ]);
  assert.equal(responses.filter(reply => /Reserva #123 registrada/.test(reply)).length, 1);
  const conflict = responses.find(reply => /indisponível/.test(reply));
  assert.ok(conflict);
  assert.match(conflict, /10:00/);
  assert.doesNotMatch(conflict, /09:00/);
  assert.equal(attempts.length, 2);
  assert.equal(new Set(attempts.map(attempt => attempt.key)).size, 2);
  assert.deepEqual(new Set(attempts.map(attempt => attempt.body.telefone)), new Set([phone, otherPhone]));
  assert.equal(api.calls.filter(call => call.action === 'agendar').length, 1);
  assert.equal(store.get('pending', owner).state, 'completed');
  assert.equal(store.get('pending', owner === phone ? otherPhone : phone), null);
});

test('data relativa usa fuso da agenda, inclusive virada do dia', () => {
  assert.equal(localTime('America/Sao_Paulo', new Date('2026-10-24T01:30:00Z')), '2026-10-23 22:30');
});
