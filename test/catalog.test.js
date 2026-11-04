import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichCatalog, haircutListReply, serviceListReply, serviceMatchKey, barberListReply } from '../src/catalog.js';
import { BookingService } from '../src/booking.js';
import { config, fakeApi, memoryStore, phone, bookingArgs } from './helpers.js';

const catalog = {
  sucesso: true,
  barbeiros: [
    { id: 1, nome: 'Julio', servicos: [{ id: 10, nome: 'Corte', preco: '30.00', duracao_minutos: 30 }] },
    { id: 2, nome: 'Pedro', servicos: [{ id: 20, nome: 'Corte de cabelo', preco: '35.00', duracao_minutos: 40 }] },
    { id: 3, nome: 'Rafael', servicos: [{ id: 30, nome: 'Core', preco: '28.00', duracao_minutos: 25 }] },
  ],
};

test('reconhece os cortes dos três barbeiros mantendo identidade, preço e duração', () => {
  const before = structuredClone(catalog);
  const result = enrichCatalog(catalog);
  assert.deepEqual(catalog, before);
  assert.deepEqual(result.barbeiros, before.barbeiros);
  const options = result.comparacao_cortes.opcoes;
  assert.deepEqual(options.map(o => [o.barbeiro_id, o.servico_id, o.preco, o.duracao_minutos]), [
    [1, 10, '30.00', 30], [2, 20, '35.00', 40], [3, 30, '28.00', 25],
  ]);
  assert.equal(options[2].possivel_erro_de_digitacao, true);
  assert.equal(options[0].possivel_erro_de_digitacao, false);
});

test('não inclui combos, infantil, degradê, sobrancelha ou coloração como corte genérico', () => {
  const names = ['Corte + barba', 'Corte infantil', 'Corte degradê', 'Coloração', 'Sobrancelha', 'Core + barba', 'Corte feminino', 'Corte premium'];
  const result = enrichCatalog({ barbeiros: [{ id: 1, nome: 'Julio', servicos: names.map((nome, id) => ({ id, nome })) }] });
  assert.equal(result.comparacao_cortes.opcoes.length, 0);
  assert.equal(result.barbeiros[0].servicos.length, names.length);
});

test('variações de caixa, espaço e acento não impedem a comparação', () => {
  const result = enrichCatalog({ barbeiros: [{ id: 1, servicos: [{ id: 1, nome: '  CÓRTE   DE CABELO  ' }, { id: 2, nome: 'Corte Masculino' }] }] });
  assert.equal(result.comparacao_cortes.opcoes.length, 2);
});

test('ferramenta retorna comparação; ao trocar barbeiro só aceita o ID do novo profissional', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const api = fakeApi(); const original = api.request.bind(api);
  api.request = async (action, ...args) => action === 'catalogo' ? structuredClone(catalog) : original(action, ...args);
  const booking = new BookingService({ store, api, config: config() });
  assert.equal((await booking.tool('catalogo', {}, phone)).comparacao_cortes.opcoes.length, 3);
  await assert.rejects(booking.tool('preparar_agendamento', { ...bookingArgs, barbeiro_id: 2, servicos: [10] }, phone), { code: 'dados_invalidos' });
  const prepared = await booking.tool('preparar_agendamento', { ...bookingArgs, barbeiro_id: 2, servicos: [20] }, phone);
  assert.match(prepared.directReply, /Pedro/); assert.match(prepared.directReply, /35,00/);
  const pending = store.get('pending', phone);
  assert.equal(pending.payload.barbeiro_id, 2); assert.deepEqual(pending.payload.servicos, [20]);
  assert.equal(api.calls.some(c => c.action === 'agendar'), false);
});

const fullCatalog = {
  sucesso: true, barbeiros: [
    { id: 5, nome: 'Julio', servicos: [
      { id: 2, nome: 'Corte', preco: '35.00', duracao_minutos: 45 },
      { id: 3, nome: 'Corte com Tesoura', preco: '40.00', duracao_minutos: 60 },
      { id: 4, nome: 'Corte + barba', preco: '65.00', duracao_minutos: 90 },
      { id: 6, nome: 'Pezinho tesoura', preco: '10.00', duracao_minutos: 10 },
    ] },
    { id: 7, nome: 'Eduardo', servicos: [
      { id: 28, nome: 'Corte de cabelo', preco: '30.00', duracao_minutos: 45 },
      { id: 29, nome: 'Corte com Tesoura', preco: '35.00', duracao_minutos: 45 },
      { id: 30, nome: 'Corte degradê', preco: '38.00', duracao_minutos: 50 },
      { id: 31, nome: 'Barba', preco: '30.00', duracao_minutos: 30 },
    ] },
  ],
};

test('todas as modalidades aparecem sem transformar tesoura ou combo em corte comum', () => {
  const source = structuredClone(fullCatalog);
  const result = enrichCatalog(source);
  assert.deepEqual(source, fullCatalog);
  assert.deepEqual(result.comparacao_cortes.opcoes.map(o => o.servico_id), [2, 28]);
  assert.deepEqual(result.modalidades_cortes.opcoes.map(o => [o.barbeiro_id, o.servico_id, o.preco]), [
    [5, 2, '35.00'], [5, 3, '40.00'], [5, 4, '65.00'], [7, 28, '30.00'], [7, 29, '35.00'], [7, 30, '38.00'],
  ]);
  assert.notEqual(serviceMatchKey('Corte com Tesoura'), serviceMatchKey('Corte'));
  assert.notEqual(serviceMatchKey('Corte + barba'), serviceMatchKey('Corte'));
  const reply = haircutListReply(source);
  assert.match(reply, /Corte de cabelo:\n\nJulio fica R\$\s35,00 💈\nEduardo fica R\$\s30,00 💈/);
  assert.match(reply, /Corte com Tesoura:\n\nJulio fica R\$\s40,00 💈\nEduardo fica R\$\s35,00 💈/);
  assert.match(reply, /Corte \+ barba:\n\nJulio fica R\$\s65,00/);
  assert.match(reply, /Corte degradê:\n\nEduardo fica R\$\s38,00/);
  assert.doesNotMatch(reply, /Pezinho|\nBarba:/);
  assert.match(reply, /💈$/);
});

test('listar cortes consulta valores novos e filtra por profissional sem gravar reservas', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const source = structuredClone(fullCatalog); const actions = [];
  const api = { async request(action) { actions.push(action); assert.equal(action, 'catalogo'); return structuredClone(source); } };
  const booking = new BookingService({ store, api, config: config() });
  const first = await booking.tool('listar_cortes', { barbeiro_id: 5 }, phone);
  assert.match(first.directReply, /Corte com Tesoura:\n\nJulio fica R\$\s40,00/);
  assert.doesNotMatch(first.directReply, /Eduardo|degradê/);
  assert.equal(first.catalog.modalidades_cortes.opcoes.length, 6);
  source.barbeiros[0].servicos[1].preco = '45.00';
  const next = await booking.tool('listar_cortes', { barbeiro_id: null }, phone);
  assert.match(next.directReply, /Corte com Tesoura:\n\nJulio fica R\$\s45,00/);
  assert.deepEqual(actions, ['catalogo', 'catalogo']);
  assert.equal(store.get('pending', phone), null);
  await assert.rejects(booking.tool('listar_cortes', { barbeiro_id: 99 }, phone), { code: 'dados_invalidos' });
});

test('agendar tesoura usa preço, duração e ID próprios do profissional escolhido', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const actions = [];
  const api = { async request(action, params) {
    actions.push(action);
    if (action === 'catalogo') return fullCatalog;
    assert.equal(action, 'disponibilidade');
    assert.deepEqual(params.servicos, [29]);
    assert.equal(params.barbeiro_id, 7);
    return { dias: [{ data: bookingArgs.data, horarios: [{ hora: '09:00' }] }] };
  } };
  const booking = new BookingService({ store, api, config: config() });
  const prepared = await booking.tool('preparar_agendamento', { ...bookingArgs, barbeiro_id: 7, servicos: [29] }, phone);
  assert.match(prepared.directReply, /Eduardo/);
  assert.match(prepared.directReply, /Corte com Tesoura · R\$\s35,00/);
  assert.deepEqual(store.get('pending', phone).payload.servicos, [29]);
  assert.deepEqual(actions, ['catalogo', 'disponibilidade']);
});

test('lista geral mostra todos os serviços sem classificar ou limitar pelos nomes dos cortes', async t => {
  const source = structuredClone(fullCatalog);
  source.barbeiros[0].servicos.push(
    { id: 50, nome: 'Hidratação a partir/', preco: '20.00', duracao_minutos: 25 },
    { id: 51, nome: 'Luzes', preco: '65.00', duracao_minutos: 120 },
    { id: 52, nome: 'Tratamento exclusivo novo', preco: '17.50', duracao_minutos: 20 },
  );
  const reply = serviceListReply(source, 5);
  for (const service of source.barbeiros[0].servicos) assert.ok(reply.includes(service.nome), `Faltou ${service.nome}`);
  assert.match(reply, /Hidratação a partir\/ — R\$\s20,00/);
  assert.match(reply, /Tratamento exclusivo novo — R\$\s17,50/);
  assert.match(reply, /Pezinho tesoura — R\$\s10,00/);
  assert.doesNotMatch(reply, /Eduardo/);
  assert.match(reply, /Qual você quer marcar\?/);
  const all = serviceListReply(source);
  assert.match(all, /Serviços com Julio/);
  assert.match(all, /Serviços com Eduardo/);
  assert.match(all, /Barba — R\$\s30,00/);
  const store = memoryStore(); t.after(() => store.close());
  const calls = [];
  const booking = new BookingService({ store, config: config(), api: { async request(action) { calls.push(action); return source; } } });
  const result = await booking.tool('listar_servicos', { barbeiro_id: 5 }, phone);
  assert.equal(result.directReply, reply);
  assert.deepEqual(result.catalog.barbeiros, source.barbeiros);
  assert.deepEqual(calls, ['catalogo']);
  assert.equal(store.get('pending', phone), null, 'Listar o catálogo não seleciona serviços para reserva');
  await assert.rejects(booking.tool('listar_servicos', { barbeiro_id: 999 }, phone), { code: 'dados_invalidos' });
});

test('serviços sem corte podem ser consultados, preparados juntos e confirmados com todos os IDs', async t => {
  const source = { barbeiros: [{ id: 5, nome: 'Julio', servicos: [
    { id: 10, nome: 'Barba', preco: '35.00', duracao_minutos: 45 },
    { id: 11, nome: 'Sobrancelha', preco: '7.00', duracao_minutos: 15 },
    { id: 12, nome: 'Hidratação', preco: '20.00', duracao_minutos: 25 },
    { id: 13, nome: 'Luzes', preco: '65.00', duracao_minutos: 120 },
    { id: 14, nome: 'Serviço novo da casa', preco: '19.00', duracao_minutos: 30 },
  ] }] };
  for (const selectedIds of [[10], [10, 11], [12, 13, 14]]) {
    await t.test(selectedIds.join(','), async t => {
      const store = memoryStore(); t.after(() => store.close());
      const calls = [];
      const selected = source.barbeiros[0].servicos.filter(s => selectedIds.includes(s.id));
      const total = selected.reduce((sum, s) => sum + Number(s.preco), 0);
      const duration = selected.reduce((sum, s) => sum + s.duracao_minutos, 0);
      const api = { async request(action, params, key) {
        calls.push({ action, params, key });
        if (action === 'catalogo') return source;
        assert.deepEqual(params.servicos, selectedIds, 'A consulta e a gravação precisam carregar a combinação completa');
        assert.equal(params.barbeiro_id, 5);
        if (action === 'disponibilidade') return { duracao_minutos: duration, dias: [{ data: bookingArgs.data, horarios: [{ hora: '09:00' }] }] };
        assert.equal(action, 'agendar');
        assert.equal(params.telefone, phone);
        return { agendamento: { id: 888, barbeiro: 'Julio', data: params.data, hora: params.hora, valor_total: total.toFixed(2), status: 'pendente' } };
      } };
      const booking = new BookingService({ store, api, config: config() });
      const query = { barbeiro_id: 5, servicos: selectedIds, data: bookingArgs.data };
      const grade = await booking.tool('grade_horarios', query, phone);
      assert.match(grade.directReply, /09:00/);
      assert.deepEqual(grade.scheduleQuery.servicos, selectedIds);
      const summary = await booking.tool('preparar_agendamento', { ...bookingArgs, ...query }, phone);
      for (const service of selected) assert.ok(summary.directReply.includes(service.nome));
      assert.ok(summary.directReply.includes(total.toFixed(2).replace('.', ',')));
      assert.doesNotMatch(summary.directReply, /Corte/);
      assert.equal(calls.some(c => c.action === 'agendar'), false);
      const pending = store.get('pending', phone);
      booking.markSummaryDelivered(phone, summary.directReply);
      const reply = await booking.command('sim', phone);
      assert.match(reply, /Reserva #888 registrada/);
      const post = calls.find(c => c.action === 'agendar');
      assert.equal(post.key, pending.id);
      assert.deepEqual(post.params.servicos, selectedIds);
    });
  }
});

test('listar barbeiros consulta todos os nomes atuais com emoji e não cria reserva ou promete vagas', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const source = structuredClone(fullCatalog); const calls = [];
  const api = { async request(action) { calls.push(action); assert.equal(action, 'catalogo'); return source; } };
  const booking = new BookingService({ store, config: config(), api });
  const listed = await booking.tool('listar_barbeiros', {}, phone);
  assert.equal(listed.directReply, barberListReply(source));
  for (const barber of source.barbeiros) assert.ok(listed.directReply.includes(`${barber.nome} 💈\n`));
  assert.match(listed.directReply, /Com quem você prefere\? 💈$/);
  assert.doesNotMatch(listed.directReply, /qual serviço|tem vaga|horário livre/i);
  assert.equal(store.get('pending', phone), null);
  assert.deepEqual(listed.catalog.barbeiros, source.barbeiros);
  source.barbeiros.push({ id: 20, nome: 'Novo profissional', servicos: [] });
  const updated = await booking.tool('listar_barbeiros', {}, phone);
  assert.match(updated.directReply, /Novo profissional 💈/);
  assert.deepEqual(calls, ['catalogo', 'catalogo']);
});
