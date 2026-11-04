import test from 'node:test';
import assert from 'node:assert/strict';
import { visitReply } from '../src/visits.js';
import { Luna } from '../src/luna.js';
import { BookingService, localTime } from '../src/booking.js';
import { config, memoryStore, fakeApi, phone } from './helpers.js';

const appointment = { id: 1, barbeiro: 'Julio', status: 'pendente', data: '2099-10-24', hora: '09:00', hora_fim: '09:30' };
const now = '2099-10-24 08:00';
const apiWith = appointments => ({ async request(action, body) {
  assert.equal(action, 'agendamentos');
  assert.equal(body.telefone, phone);
  return { agendamentos: appointments, tem_mais: false };
} });

test('visita informa reserva ativa do próprio telefone e respeita dia e hora', async () => {
  const api = apiWith([appointment]);
  const present = await visitReply(api, phone, { data: appointment.data, hora: '09:00' }, now);
  assert.match(present.directReply, /já tem horário marcado/);
  assert.match(present.directReply, /24\/10\/2099 às 09:00 · Julio/);
  const anotherHour = await visitReply(api, phone, { data: appointment.data, hora: '10:00' }, now);
  assert.match(anotherHour.directReply, /Não encontrei horário marcado para 24\/10\/2099 às 10:00/);
  assert.match(anotherHour.directReply, /precisa agendar/);
  const anotherDay = await visitReply(api, phone, { data: '2099-10-25', hora: null }, now);
  assert.match(anotherDay.directReply, /Não encontrei horário marcado para 25\/10\/2099/);
  assert.match(anotherDay.directReply, /Você tem reserva em 24\/10\/2099/);
  assert.doesNotMatch(anotherDay.directReply, /Te esperamos/);
});

test('sem reserva ativa orienta agendar; canceladas, concluídas e passadas não contam', async () => {
  for (const appointments of [[], [
    { ...appointment, status: 'cancelado' },
    { ...appointment, id: 2, status: 'concluido' },
    { ...appointment, id: 3, hora: '07:00', hora_fim: '07:30' },
  ]]) {
    const reply = await visitReply(apiWith(appointments), phone, { data: null, hora: null }, now);
    assert.match(reply.directReply, /Precisa agendar antes de ir. Quer marcar/);
    assert.doesNotMatch(reply.directReply, /já tem horário marcado|Te esperamos/);
  }
});

test('consulta todas as páginas antes de afirmar ausência de reserva', async () => {
  const calls = [];
  const api = { async request(action, args) {
    calls.push({ action, args });
    return args.pagina === 1 ? { agendamentos: [{ ...appointment, status: 'cancelado' }], tem_mais: true }
      : { agendamentos: [appointment], tem_mais: false };
  } };
  const reply = await visitReply(api, phone, { data: null, hora: null }, now);
  assert.match(reply.directReply, /já tem horário marcado/);
  assert.deepEqual(calls.map(call => call.args.pagina), [1, 2]);
});

test('falha, resposta malformada e paginação incompleta não viram ausência de reserva', async () => {
  for (const api of [
    { async request() { throw new Error('offline'); } },
    { async request() { return {}; } },
    { async request() { return { agendamentos: [appointment], tem_mais: true }; } },
  ]) await assert.rejects(visitReply(api, phone, { data: null, hora: null }, now));
});

test('pedido incerto sem reserva correspondente pede recuperação sem prometer nova marcação', async () => {
  const reply = await visitReply(apiWith([]), phone, { data: null, hora: null }, now, true);
  assert.match(reply.directReply, /aguarda resultado.*Responda CONFIRMAR/);
  assert.doesNotMatch(reply.directReply, /Quer marcar|Te esperamos/);
});

test('posso ir consulta o site novamente em cada mensagem sem modelo nem escrita', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); const api = fakeApi(); const original = api.request.bind(api); let empty = false;
  api.request = async (action, args, key) => {
    const result = await original(action, args, key);
    return action === 'agendamentos' && empty ? { ...result, agendamentos: [] } : result;
  };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }),
    client: { responses: { async create() { assert.fail('A consulta simples não depende da IA'); } } } });
  const first = await luna.reply('Oi, posso ir?', phone);
  assert.match(first, /já tem horário marcado/);
  luna.remember(phone, 'Posso ir?', first);
  empty = true;
  const second = await luna.reply('Posso passar aí hoje?', phone);
  assert.match(second, /Precisa agendar antes de ir/);
  assert.deepEqual(api.calls.map(call => call.action), ['agendamentos', 'agendamentos']);
  assert.equal(store.get('pending', phone), null);
});

test('tô indo confere hoje; amanhã e hora são preservados e reserva de outro dia não libera visita', async t => {
  const store = memoryStore(); t.after(() => store.close()); const c = config(); const queries = [];
  const booking = { async command() { return null; }, async tool(name, query, authenticatedPhone) {
    assert.equal(name, 'orientar_visita'); assert.equal(authenticatedPhone, phone);
    queries.push(query); return { directReply: 'Consultado 💈' };
  } };
  const luna = new Luna({ config: c, store, booking, client: {} });
  await luna.reply('Tô indo', phone);
  await luna.reply('Posso ir amanhã às 10h?', phone);
  const today = localTime(c.BARBEARIA_TIMEZONE).slice(0, 10);
  const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  assert.deepEqual(queries, [{ data: today, hora: null }, { data: tomorrow.toISOString().slice(0, 10), hora: '10:00' }]);
});

test('visita após resumo preparado não confirma nem altera o pedido', async t => {
  const store = memoryStore(); t.after(() => store.close()); const c = config(); const api = fakeApi();
  const operation = { state: 'prepared', id: 'original', summary: 'Resumo ainda sem aceite' };
  store.set('pending', phone, operation);
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client: {} });
  await luna.reply('Posso ir?', phone);
  assert.deepEqual(store.get('pending', phone), operation);
  assert.deepEqual(api.calls.map(call => call.action), ['agendamentos']);
});

test('erro ao conferir visita não libera ida nem afirma que não tem reserva', async t => {
  const store = memoryStore(); t.after(() => store.close()); const c = config();
  const api = { async request() { throw new Error('offline'); } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client: {} });
  const reply = await luna.reply('Posso ir agora?', phone);
  assert.match(reply, /Não consegui conferir seu agendamento/);
  assert.doesNotMatch(reply, /Não encontrei|pode vir|Precisa agendar/);
});

test('dia complexo passa pela IA mas não permite resposta sem consultar a reserva', async t => {
  const store = memoryStore(); t.after(() => store.close()); const c = config(); const api = fakeApi(); let calls = 0;
  const client = { responses: { async create() {
    calls++;
    return calls === 1 ? { status: 'completed', output: [], output_text: 'Pode vir!' }
      : { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'orientar_visita', arguments: JSON.stringify({ data: '2099-10-24', hora: null }) }] };
  } } };
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client });
  assert.match(await luna.reply('Posso ir dia 24/10/2099?', phone), /já tem horário marcado/);
  assert.equal(calls, 2);
  assert.deepEqual(api.calls.map(call => call.action), ['agendamentos']);
});
