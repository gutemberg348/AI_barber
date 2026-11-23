import test from 'node:test';
import assert from 'node:assert/strict';
import { BookingService } from '../src/booking.js';
import { Luna } from '../src/luna.js';
import { selectedMenuServices, serviceListReply } from '../src/catalog.js';
import { incomingMessage } from '../src/messages.js';
import { config, memoryStore, phone } from './helpers.js';

const barber = { id: 3, nome: 'Julio', servicos: [
  'Sobrancelha', 'Corte', 'Corte com Tesoura', 'Luzes   Apartir/', 'Pezinho', 'Pezinho tesoura',
].map((nome, i) => ({ id: 10 + i, nome, preco: '10.00' })) };
const source = { barbeiros: [barber] };
const choice = 'Sobrancelha + corte + luzes + pezinho';
const ids = [10, 11, 13, 14];

test('menu simples e citado preservam os quatro serviços e consultam juntos o dia escolhido', async t => {
  for (const quoted of [false, true]) await t.test(quoted ? 'citado após outra pergunta' : 'última mensagem', async t => {
    const store = memoryStore(); t.after(() => store.close());
    const c = config(); const reads = [];
    const api = { async request(action, params) {
      if (action === 'catalogo') return source;
      assert.equal(action, 'disponibilidade'); reads.push(params);
      return { dias: [{ data: params.data_inicio, horarios: [{ hora: '12:45' }] }] };
    } };
    const booking = new BookingService({ config: c, store, api });
    const luna = new Luna({ config: c, store, booking, client: { responses: { create: assert.fail } } });
    const list = (await booking.tool('listar_servicos', { barbeiro_id: 3 }, phone)).directReply;
    luna.remember(phone, 'Com Julio', list, { catalog: source });
    if (quoted) luna.remember(phone, 'E luzes?', 'O catálogo informa o valor inicial.');
    const msg = await incomingMessage({
      key: { id: 'resposta-menu', remoteJid: '55' + phone + '@s.whatsapp.net' }, messageTimestamp: Date.now() / 1000,
      message: { extendedTextMessage: { text: choice, ...(quoted ? { contextInfo: { quotedMessage: { conversation: list } } } : {}) } },
    }, {}, c);
    const metadata = { quotedHash: msg.quotedHash };
    const reply = await luna.reply(msg.text, phone, metadata);
    assert.match(reply, /4 serviços com Julio/); assert.match(reply, /qual dia/i);
    assert.deepEqual(metadata.scheduleSelection.servicos, ids);
    assert.deepEqual(reads, []);
    luna.remember(phone, msg.text, reply, metadata);
    const next = {};
    const repeat = await luna.reply(choice, phone, next);
    assert.notEqual(repeat, reply); assert.doesNotMatch(repeat, /Serviços com Julio 💈/);
    luna.remember(phone, choice, repeat, next);
    assert.match(await luna.reply('Amanhã', phone), /12:45/);
    assert.equal(reads.length, 1); assert.deepEqual(reads[0].servicos, ids);
    assert.equal(store.get('pending', phone), null);
  });
});

test('uma modalidade ambígua, dúvida de preço ou serviço desconhecido não vira escolha parcial', () => {
  for (const text of ['Corte + inexistente', 'Quanto custa corte e luzes?', 'Pezinho ou pezinho tesoura', 'Não quero corte']) {
    assert.equal(selectedMenuServices(text, barber), null);
  }
  const ambiguous = { ...barber, servicos: [...barber.servicos, { id: 99, nome: 'Luzes a partir' }] };
  assert.equal(selectedMenuServices(choice, ambiguous), null);
  assert.deepEqual(selectedMenuServices('Corte com tesoura e pezinho tesoura', barber).servicos, [12, 15]);
});

test('com dia já informado segue para a grade e corrige ferramenta que omitiu três serviços', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const c = config(); let received;
  const luna = new Luna({ store, config: c, booking: { command: async () => null, async tool(name, args) {
    assert.equal(name, 'grade_horarios'); received = args; return { directReply: 'Grade do site', scheduleQuery: args };
  } }, client: { responses: { async create({ tools }) {
    assert.ok(!tools.some(tool => tool.name === 'listar_servicos'));
    return { output: [{ type: 'function_call', id: 'f1', call_id: 'c1', name: 'grade_horarios',
      arguments: JSON.stringify({ barbeiro_id: 3, servicos: [11], data: '2099-10-24' }) }] };
  } } } });
  luna.remember(phone, 'Quero marcar para 24/10/2099', serviceListReply(source, 3), { catalog: source });
  assert.equal(await luna.reply(choice, phone), 'Grade do site');
  assert.deepEqual(received.servicos, ids); assert.equal(received.data, '2099-10-24');
});
