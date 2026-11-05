import test from 'node:test';
import assert from 'node:assert/strict';
import { appointmentPhoneVariants } from '../src/phone.js';
import { BarbershopApi } from '../src/barbershop.js';
import { BookingService } from '../src/booking.js';
import { Luna } from '../src/luna.js';
import { config, memoryStore } from './helpers.js';

// Número sintético para reproduzir cadastro com nono dígito e canal sem ele.
const oldPhone = '8791234567';
const currentPhone = '87991234567';
const appointment = { id: 321, barbeiro: 'Julio', status: 'pendente', data: '2099-11-05', hora: '12:45', hora_fim: '14:15' };
const result = appointments => ({ sucesso: true, agendamentos: appointments, tem_mais: false });

test('variantes preservam DDD e não inventam versões para fixos ou LID', () => {
  assert.deepEqual(appointmentPhoneVariants(oldPhone), [oldPhone, currentPhone]);
  assert.deepEqual(appointmentPhoneVariants(currentPhone), [currentPhone, oldPhone]);
  assert.deepEqual(appointmentPhoneVariants('55' + oldPhone), [oldPhone, currentPhone]);
  assert.deepEqual(appointmentPhoneVariants('8731234567'), ['8731234567']);
  assert.deepEqual(appointmentPhoneVariants('12345@lid'), ['12345@lid']);
});

test('consulta GET do site localiza reserva com nono dígito mesmo quando canal omite', async () => {
  const calls = [];
  const api = new BarbershopApi(config(), { fetchImpl: async (url, options) => {
    const phone = url.searchParams.get('telefone');
    calls.push({ phone, method: options.method, action: url.searchParams.get('acao') });
    return Response.json(result(phone === currentPhone ? [appointment] : []));
  } });
  const response = await api.request('agendamentos', { telefone: oldPhone, pagina: 1 });
  assert.equal(response.agendamentos[0].id, appointment.id);
  assert.deepEqual(calls, [oldPhone, currentPhone].map(phone => ({ phone, method: 'GET', action: 'agendamentos' })));
});

test('une formatos sem duplicar e mantém a paginação de ambos', async () => {
  const calls = [];
  const api = new BarbershopApi(config(), { fetchImpl: async url => {
    const phone = url.searchParams.get('telefone'), page = Number(url.searchParams.get('pagina'));
    calls.push({ phone, page });
    return Response.json({ ...result(page === 1 ? [appointment] : [{ ...appointment, id: 322, hora: '15:00' }]), tem_mais: page === 1 && phone === currentPhone });
  } });
  const first = await api.request('agendamentos', { telefone: currentPhone, pagina: 1 });
  assert.equal(first.agendamentos.length, 1); assert.equal(first.tem_mais, true);
  const second = await api.request('agendamentos', { telefone: currentPhone, pagina: 2 });
  assert.equal(second.agendamentos.length, 1); assert.equal(second.tem_mais, false);
  assert.deepEqual(calls.map(item => item.page), [1, 1, 2, 2]);
});

test('erro em um formato não vira ausência de reserva e POST mantém telefone/corpo originais', async () => {
  let posted;
  const api = new BarbershopApi(config(), { fetchImpl: async (url, options) => {
    if (options.method === 'POST') { posted = options; return Response.json({ sucesso: true, agendamento: { id: 1 } }, { status: 201 }); }
    return url.searchParams.get('telefone') === oldPhone ? Response.json(result([]))
      : Response.json({ sucesso: false, codigo: 'nao_autorizado' }, { status: 401 });
  } });
  await assert.rejects(api.request('agendamentos', { telefone: oldPhone, pagina: 1 }), { code: 'nao_autorizado' });
  const body = { telefone: oldPhone, nome: 'Cliente teste' };
  await api.request('agendar', body, 'chave-original-123456');
  assert.deepEqual(JSON.parse(posted.body), body);
  assert.equal(posted.headers['Idempotency-Key'], 'chave-original-123456');
});

test('frase do incidente consulta API atual sem memória do WhatsApp e sem nova reserva', async t => {
  const store = memoryStore(); t.after(() => store.close()); const c = config(); const calls = [];
  const api = new BarbershopApi(c, { fetchImpl: async (url, options) => {
    calls.push(options.method);
    assert.equal(url.searchParams.get('acao'), 'agendamentos');
    return Response.json(result(url.searchParams.get('telefone') === currentPhone ? [appointment] : []));
  } });
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }),
    client: { responses: { async create() { assert.fail('Não precisa da IA nem de mensagens antigas para conferir reserva.'); } } } });
  const reply = await luna.reply('Tenho um agendamento pra 12:45 vai ser esse horário mesmo?', oldPhone);
  assert.match(reply, /Encontrei seu agendamento no site/);
  assert.match(reply, /05\/11\/2099 às 12:45 · Julio/);
  assert.doesNotMatch(reply, /Quer marcar|Precisa agendar/);
  assert.deepEqual(calls, ['GET', 'GET']);
  assert.equal(store.get('pending', oldPhone), null);
});

test('cliente diz que já marcou: ausência na API esclarece divergência sem mandar marcar de novo', async t => {
  const store = memoryStore(); t.after(() => store.close()); const c = config();
  const api = new BarbershopApi(c, { fetchImpl: async () => Response.json(result([])) });
  const luna = new Luna({ config: c, store, booking: new BookingService({ store, api, config: c }), client: {} });
  const reply = await luna.reply('Tenho uma reserva para 12:45, está certo?', oldPhone);
  assert.match(reply, /consulta do site/);
  assert.match(reply, /mesmo número/);
  assert.doesNotMatch(reply, /Quer marcar|Precisa agendar|não tem reserva/);
});
