import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleReply } from '../src/schedule.js';
import { ApiError } from '../src/barbershop.js';
import { BookingService } from '../src/booking.js';
import { config, memoryStore, phone } from './helpers.js';

const date = '2099-10-24';
const catalog = {
  sucesso: true,
  barbeiros: [
    { id: 1, nome: 'Julio', servicos: [{ id: 11, nome: 'Corte', preco: '30.00' }] },
    { id: 2, nome: 'Pedro', servicos: [{ id: 22, nome: 'Corte de cabelo', preco: '40.00' }] },
    { id: 3, nome: 'Rafael', servicos: [{ id: 33, nome: 'Core', preco: '25.00' }] },
  ],
};
const day = (data, times) => ({ data, horarios: times.map(hora => ({ hora })) });
const args = { barbeiro_id: 1, servicos: [11], data: date };
function apiFixture({ main = [], others = {}, future = [], otherFuture = {}, broken = [], brokenFuture = [], invalidDate, source = catalog } = {}) {
  const calls = [];
  return { calls, async request(action, params) {
    calls.push({ action, params });
    if (action === 'catalogo') return structuredClone(source);
    assert.equal(action, 'disponibilidade', 'A grade nunca deve gravar reservas');
    if (broken.includes(params.barbeiro_id)) throw new ApiError('conexao_indisponivel');
    if (params.data_inicio && params.data_inicio === invalidDate) throw new ApiError('periodo_invalido', 422);
    if (!params.data_inicio && brokenFuture.includes(params.barbeiro_id)) throw new ApiError('conexao_indisponivel');
    return { sucesso: true, dias: params.data_inicio
      ? [day(params.data_inicio, params.barbeiro_id === 1 ? main : others[params.barbeiro_id] ?? [])]
      : params.barbeiro_id === 1 ? future : otherFuture[params.barbeiro_id] ?? [] };
  } };
}

test('grade do dia mostra todos os horários reais, ordenados e sem duplicatas', async () => {
  const api = apiFixture({ main: ['14:00', '09:00', '10:30', '09:00', '15:30', '16:00'] });
  const { directReply } = await scheduleReply(api, args);
  assert.match(directReply, /Julio/);
  assert.match(directReply, /24\/10\/2099/);
  assert.match(directReply, /09:00\n10:30\n14:00\n15:30\n16:00/);
  assert.match(directReply, /Qual horário\?/);
  assert.equal((directReply.match(/09:00/g) ?? []).length, 1);
  assert.equal(api.calls.length, 2, 'Não consulta outros barbeiros se o escolhido tem vaga');
  assert.deepEqual(api.calls[1].params, { barbeiro_id: 1, servicos: [11], data_inicio: date, data_fim: date });
});

test('dia lotado oferece outros barbeiros com seus próprios IDs e o próximo dia realmente livre', async () => {
  const api = apiFixture({ others: { 2: ['10:00'], 3: ['11:30'] }, future: [
    day('2099-10-27', ['13:00']), day('2099-10-25', []), day('2099-10-26', ['09:30']), day('2099-10-23', ['08:00']),
  ] });
  const { directReply } = await scheduleReply(api, args);
  assert.match(directReply, /Julio está sem vagas/);
  assert.match(directReply, /Pedro[^\n]*R\$\s40,00\n[^\n]*24\/10\/2099\n\n10:00/);
  assert.match(directReply, /Rafael[^\n]*R\$\s25,00\n[^\n]*24\/10\/2099\n\n11:30/);
  assert.match(directReply, /Julio[^\n]*\n[^\n]*26\/10\/2099\n\n09:30/);
  assert.doesNotMatch(directReply, /25\/10|27\/10|08:00/);
  assert.deepEqual(api.calls.find(c => c.params?.barbeiro_id === 2).params.servicos, [22]);
  assert.deepEqual(api.calls.find(c => c.params?.barbeiro_id === 3).params.servicos, [33]);
});

test('sem alternativas no dia, mostra a grade completa do próximo dia e mantém a escolha com o cliente', async () => {
  const api = apiFixture({ future: [day('2099-10-28', ['08:30', '09:00', '10:00', '11:00', '14:00'])] });
  const { directReply } = await scheduleReply(api, args);
  assert.match(directReply, /28\/10\/2099/);
  assert.match(directReply, /08:30\n09:00\n10:00\n11:00\n14:00/);
  assert.match(directReply, /Qual horário\?/);
  assert.doesNotMatch(directReply, /Quer ver todos|\(\+\d+ horários\)/);
  assert.doesNotMatch(directReply, /registrada|confirmada/);
});

test('sem vagas na janela não inventa próximo dia', async () => {
  const { directReply } = await scheduleReply(apiFixture(), args);
  assert.match(directReply, /[Ss]em (?:alternativas livres|vagas)/);
  assert.doesNotMatch(directReply, /Próximo dia com/);
});

test('erro na consulta não é apresentado como falta de vaga', async () => {
  await assert.rejects(scheduleReply(apiFixture({ broken: [1] }), args), { code: 'conexao_indisponivel' });
  const { directReply } = await scheduleReply(apiFixture({ broken: [2], others: { 3: ['11:00'] } }), args);
  assert.match(directReply, /Não consegui conferir todas/);
  assert.match(directReply, /Rafael/);
  assert.doesNotMatch(directReply, /Pedro está sem vagas/);
});

test('não troca por combo ou modalidade ambígua e não mistura IDs', async () => {
  const source = structuredClone(catalog);
  source.barbeiros[1].servicos[0].nome = 'Corte + barba';
  source.barbeiros[2].servicos.push({ id: 34, nome: 'Corte de cabelo', preco: '35.00' });
  const api = apiFixture({ source });
  await scheduleReply(api, args);
  assert.equal(api.calls.some(c => [2, 3].includes(c.params?.barbeiro_id)), false);
  await assert.rejects(scheduleReply(api, { ...args, servicos: [22] }), { code: 'dados_invalidos' });
});

test('ferramenta expõe a grade sem preparar ou gravar reserva', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const booking = new BookingService({ store, api: apiFixture({ main: ['09:00'] }), config: config() });
  assert.match((await booking.tool('grade_horarios', args, phone)).directReply, /09:00/);
  assert.equal(store.get('pending', phone), null);
  await assert.rejects(booking.tool('grade_horarios', { ...args, data: '2099-02-31' }, phone));
});

test('duas consultas ao mesmo dia refletem mudanças e não reutilizam a grade anterior', async () => {
  const times = ['09:00', '10:00'];
  const api = apiFixture({ main: times });
  const first = await scheduleReply(api, args);
  assert.match(first.directReply, /09:00\n10:00/);
  times.shift(); // Outra pessoa ocupou 09:00 durante a conversa.
  const second = await scheduleReply(api, args);
  assert.doesNotMatch(second.directReply, /09:00/);
  assert.match(second.directReply, /10:00/);
  assert.deepEqual(second.scheduleQuery, args);
  assert.equal(api.calls.filter(c => c.action === 'disponibilidade').length, 2);
});

test('resposta ausente ou horário corrompido não vira grade vazia', async () => {
  for (const result of [{}, { dias: [] }, { dias: [day(date, ['25:00'])] }, { dias: [{ data: date }] }]) {
    const api = { request: async action => action === 'catalogo' ? catalog : result };
    await assert.rejects(scheduleReply(api, args), { code: 'resposta_invalida' });
  }
});

test('pedido sem dia consulta a janela e mostra o primeiro dia com vaga, preservando data null para reenvio', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const api = apiFixture({ future: [
    day('2099-10-28', ['14:00']), day(date, []), day('2099-10-26', ['11:00', '09:00', '10:00', '09:00']),
  ] });
  const booking = new BookingService({ store, api, config: config() });
  const query = { ...args, data: null };
  const { directReply, scheduleQuery } = await booking.tool('grade_horarios', query, phone);
  assert.match(directReply, /Julio/);
  assert.match(directReply, /26\/10\/2099/);
  assert.match(directReply, /09:00\n10:00\n11:00/);
  assert.doesNotMatch(directReply, /28\/10\/2099|14:00/);
  assert.deepEqual(scheduleQuery, query);
  assert.equal(store.get('pending', phone), null);
  assert.equal(api.calls.length, 2, 'Uma vaga do escolhido basta para responder sem consultar outros profissionais');
  assert.deepEqual(api.calls[1].params, { barbeiro_id: 1, servicos: [11] });
});

test('sem vaga do escolhido nem alternativas no dia, sugere a primeira vaga futura de outro barbeiro', async () => {
  const api = apiFixture({ otherFuture: { 2: [
    day('2099-10-28', ['14:00']), day('2099-10-27', ['10:30', '11:00']), day('2099-10-23', ['08:00']),
  ] } });
  const { directReply } = await scheduleReply(api, args);
  assert.match(directReply, /Julio está sem vagas/);
  assert.match(directReply, /Pedro[^\n]*R\$\s40,00\n[^\n]*27\/10\/2099\n\n10:30\n11:00/);
  assert.doesNotMatch(directReply, /28\/10\/2099|23\/10\/2099|08:00|14:00/);
  const futureCall = api.calls.find(c => c.params?.barbeiro_id === 2 && !c.params.data_inicio);
  assert.deepEqual(futureCall.params, { barbeiro_id: 2, servicos: [22] });
  assert.doesNotMatch(directReply, /registrada|confirmada/);
});

test('pedido sem dia encontra outro barbeiro quando o escolhido não tem vagas na janela', async () => {
  const api = apiFixture({ otherFuture: { 3: [day('2099-10-26', ['10:00', '11:00'])] } });
  const { directReply, scheduleQuery } = await scheduleReply(api, { ...args, data: null });
  assert.match(directReply, /Rafael[^\n]*R\$\s25,00\n[^\n]*26\/10\/2099\n\n10:00\n11:00/);
  assert.equal(scheduleQuery.data, null);
  assert.equal(api.calls.some(c => c.params?.data_inicio), false, 'Sem dia escolhido não se inventa uma data para consultar');
  assert.deepEqual(api.calls.find(c => c.params?.barbeiro_id === 3).params.servicos, [33]);
});

test('data fora da janela informa o limite e sugere dias realmente livres, mesmo quando a data pedida é futura', async t => {
  for (const requested of ['2099-10-20', '2099-11-05']) {
    await t.test(requested, async () => {
      const source = { ...catalog, janela: { inicio: date, fim: '2099-10-30', limite_dias: 7 } };
      const api = apiFixture({ source, future: [day(date, []), day('2099-10-26', ['09:30', '10:00'])] });
      const { directReply, scheduleQuery } = await scheduleReply(api, { ...args, data: requested });
      assert.match(directReply, /fora da agenda liberada/i);
      assert.match(directReply, /24\/10\/2099/);
      assert.match(directReply, /30\/10\/2099/);
      assert.match(directReply, /26\/10\/2099\n\n09:30\n10:00/);
      assert.doesNotMatch(directReply, /Julio está sem vagas em/);
      assert.equal(api.calls.some(c => c.params?.data_inicio === requested), false);
      assert.deepEqual(scheduleQuery, { ...args, data: requested });
    });
  }
});

test('periodo_invalido retornado pelo site também busca vagas na janela, sem tratar o erro como lotação', async () => {
  const api = apiFixture({ invalidDate: date, future: [day('2099-10-26', ['09:30'])] });
  const { directReply } = await scheduleReply(api, args);
  assert.match(directReply, /fora da agenda liberada/i);
  assert.match(directReply, /26\/10\/2099\n\n09:30/);
  assert.doesNotMatch(directReply, /Julio está sem vagas em/);
  assert.equal(api.calls.some(c => c.params?.barbeiro_id === 1 && c.params.data_inicio === date), true);
  assert.equal(api.calls.some(c => c.params?.barbeiro_id === 1 && !c.params.data_inicio), true);
});

test('falha parcial na busca futura preserva alternativas válidas e não afirma agenda lotada do profissional que falhou', async () => {
  const api = apiFixture({ brokenFuture: [2], otherFuture: { 3: [day('2099-10-27', ['11:00'])] } });
  const { directReply } = await scheduleReply(api, args);
  assert.match(directReply, /Não consegui conferir todas/);
  assert.match(directReply, /Rafael[^\n]*R\$\s25,00\n[^\n]*27\/10\/2099\n\n11:00/);
  assert.doesNotMatch(directReply, /Pedro está sem vagas|Sem alternativas livres/);
});

test('comparar barbeiros consulta todos no dia mesmo com vaga do escolhido e preserva intenção no reenvio', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const api = apiFixture({ main: ['09:00'], others: { 2: ['10:00'], 3: ['11:00'] } });
  const booking = new BookingService({ store, api, config: config() });
  const query = { ...args, comparar_barbeiros: true };
  const { directReply, scheduleQuery } = await booking.tool('grade_horarios', query, phone);
  assert.match(directReply, /Julio[^\n]*R\$\s30,00\n[^\n]*24\/10\/2099\n\n09:00/);
  assert.match(directReply, /Pedro[^\n]*R\$\s40,00\n[^\n]*24\/10\/2099\n\n10:00/);
  assert.match(directReply, /Rafael[^\n]*R\$\s25,00\n[^\n]*24\/10\/2099\n\n11:00/);
  assert.match(directReply, /Qual opção/);
  assert.deepEqual(scheduleQuery, query);
  const reads = api.calls.filter(c => c.action === 'disponibilidade');
  assert.deepEqual(reads.map(c => ({ id: c.params.barbeiro_id, servicos: c.params.servicos })), [
    { id: 1, servicos: [11] }, { id: 2, servicos: [22] }, { id: 3, servicos: [33] },
  ]);
  assert.equal(reads.every(c => c.params.data_inicio === date && c.params.data_fim === date), true);
  assert.equal(store.get('pending', phone), null);
});

test('comparar sem dia busca o primeiro dia com vaga de cada barbeiro', async () => {
  const api = apiFixture({
    future: [day('2099-10-26', ['09:00'])],
    otherFuture: { 2: [day('2099-10-27', ['10:00'])], 3: [day(date, []), day('2099-10-28', ['11:00'])] },
  });
  const query = { ...args, data: null, comparar_barbeiros: true };
  const { directReply, scheduleQuery } = await scheduleReply(api, query);
  assert.match(directReply, /Julio[^\n]*\n[^\n]*26\/10\/2099\n\n09:00/);
  assert.match(directReply, /Pedro[^\n]*\n[^\n]*27\/10\/2099\n\n10:00/);
  assert.match(directReply, /Rafael[^\n]*\n[^\n]*28\/10\/2099\n\n11:00/);
  assert.deepEqual(scheduleQuery, query);
  assert.equal(api.calls.some(c => c.params?.data_inicio), false);
});
