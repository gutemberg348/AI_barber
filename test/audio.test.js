import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import OpenAI from 'openai';
import { AudioTranscriber } from '../src/audio.js';
import { incomingMessage, MessageProcessor } from '../src/messages.js';
import { BookingService } from '../src/booking.js';
import { Luna } from '../src/luna.js';
import { config, memoryStore, phone, idle, logger, fakeApi, bookingArgs } from './helpers.js';

const message = (id = 'audio-1', media = {}) => ({
  key: { id, remoteJid: `55${phone}@s.whatsapp.net`, fromMe: false },
  messageTimestamp: Math.floor(Date.now() / 1000),
  message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 10, fileLength: 8,
    mediaKey: Buffer.alloc(32, 1), url: 'https://mmg.whatsapp.net/audio-test', ...media } },
});
const voice = async (id = 'audio-1', media = {}) => incomingMessage(message(id, media), {}, config());
const download = async () => Readable.from([Buffer.from('OggS-test')]);

test('áudio normalizado persiste apenas os metadados necessários e preserva chave binária após reinício', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const original = message('wrapped', { contextInfo: { quotedMessage: { conversation: 'não copiar' } }, waveform: Buffer.alloc(200) });
  original.message = { ephemeralMessage: { message: original.message } };
  const item = await incomingMessage(original, {}, config());
  assert.equal(item.unsupported, false);
  store.set('inbound', item.id, item);
  const saved = store.get('inbound', item.id);
  assert.deepEqual(saved.audio.message.audioMessage.mediaKey, Buffer.alloc(32, 1));
  assert.equal(saved.audio.message.audioMessage.seconds, 10);
  assert.equal(saved.audio.message.audioMessage.contextInfo, undefined);
  assert.equal(saved.audio.message.audioMessage.waveform, undefined);
  assert.equal(saved.phone, phone);
});

test('SDK envia multipart com OGG, modelo configurado e idioma português sem incluir dados da agenda', async () => {
  let calls = 0;
  const client = new OpenAI({ apiKey: 'test-key', maxRetries: 0, fetch: async (url, options) => {
    if (String(url) === 'data:,') return new Response(''); // Sondagem local de FormData feita pelo SDK.
    calls++;
    assert.equal(String(url), 'https://api.openai.com/v1/audio/transcriptions');
    const request = new Request(url, options);
    const form = await request.formData();
    assert.equal(form.get('model'), 'gpt-transcribe');
    assert.equal(form.get('languages[]'), 'pt');
    assert.equal(form.has('language'), false);
    const file = form.get('file');
    assert.equal(file.name, 'mensagem.ogg');
    assert.equal(file.type, 'audio/ogg');
    assert.equal(await file.text(), 'OggS-test');
    assert.equal(form.has('telefone'), false);
    return Response.json({ text: 'Quero um corte com Júlio amanhã.' });
  } });
  const service = new AudioTranscriber({ config: config(), client });
  assert.equal(await service.transcribe((await voice()).audio, download), 'Quero um corte com Júlio amanhã.');
  assert.equal(calls, 1);
});

test('limites declarados, desativação e formato inválido impedem download e cobrança de transcrição', async () => {
  for (const [extra, media, code] of [
    [{ WHATSAPP_AUDIO_ENABLED: 'false' }, {}, 'audio_disabled'],
    [{}, { seconds: 301 }, 'audio_too_long'],
    [{}, { fileLength: 10485761 }, 'audio_too_large'],
    [{}, { mimetype: 'application/octet-stream' }, 'audio_format'],
  ]) {
    const service = new AudioTranscriber({ config: config(extra), client: {} });
    await assert.rejects(service.transcribe((await voice('limit', media)).audio, () => assert.fail('Não baixar mídia rejeitada.')), { code });
  }
});

test('dicas de áudio usam só termos do catálogo e a etapa da conversa, sem sugerir opções ao ouvir a data', async () => {
  const requests = [];
  const service = new AudioTranscriber({ config: config(), client: { audio: { transcriptions: { async create(args) {
    requests.push(args); return { text: requests.length === 1 ? 'Eduardo.' : '[inaudível]' };
  } } } } });
  const history = { catalog: { barbeiros: [{ nome: 'Eduardo' }, { nome: '<inválido>' }] },
    messages: [{ role: 'user', content: 'texto particular' }, { role: 'assistant', content: 'Com quem você prefere?' }] };
  const audio = (await voice()).audio;
  assert.equal(await service.transcribe(audio, download, history), 'Eduardo.');
  assert.deepEqual(requests[0].keywords, ['Eduardo']);
  assert.doesNotMatch(requests[0].prompt, /texto particular/);
  history.messages.push({ role: 'assistant', content: 'Para qual dia?' });
  await assert.rejects(service.transcribe(audio, download, history), { code: 'audio_empty' });
  assert.equal(requests[1].keywords, undefined);
  assert.match(requests[1].prompt, /dia desejado/);
});

test('limite real de bytes interrompe stream mesmo com tamanho declarado menor; silêncio não vira pedido', async () => {
  let calls = 0;
  const service = new AudioTranscriber({ config: config({ WHATSAPP_AUDIO_MAX_BYTES: 1024 }), client: { audio: { transcriptions: { async create() { calls++; return { text: '   ' }; } } } } });
  const audio = (await voice()).audio;
  const stream = Readable.from([Buffer.alloc(700), Buffer.alloc(700)]);
  await assert.rejects(service.transcribe(audio, async () => stream), { code: 'audio_too_large' });
  assert.equal(stream.destroyed, true);
  assert.equal(calls, 0);
  await assert.rejects(service.transcribe(audio, download), { code: 'audio_empty' });
  assert.equal(calls, 1);
});

test('download parado tem prazo e cancela o sinal sem enviar áudio para a OpenAI', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const service = new AudioTranscriber({ config: config(), client: {} });
  const audio = (await voice()).audio;
  const task = service.transcribe(audio, async (_, receivedSignal) => { signal = receivedSignal; return new Promise(() => {}); });
  const rejected = assert.rejects(task, { code: 'audio_download_timeout' });
  t.mock.timers.tick(20001);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('áudio entra na mesma fila do texto e reenvio/reinício não repete transcrição', async t => {
  const store = memoryStore(); t.after(() => store.close()); const c = config(); let transcriptions = 0;
  const requests = [];
  const luna = { async reply(text) { requests.push(text); return `Resposta: ${text}`; }, remember() {} };
  const transcriber = { async transcribe(audio) { transcriptions++; assert.equal(audio.message.audioMessage.ptt, true); return 'Quero corte com Julio'; } };
  const processor = new MessageProcessor({ store, config: c, luna, logger, transcriber });
  processor.setTransport(async () => { throw new Error('offline'); }, download);
  const item = await voice();
  processor.accept(item); processor.accept({ ...item });
  processor.accept({ id: 'texto', jid: item.jid, phone, text: 'amanhã', createdAt: Date.now() });
  await idle(processor);
  assert.deepEqual(requests, ['Quero corte com Julio', 'amanhã']);
  assert.equal(transcriptions, 1);
  assert.equal(store.get('inbound', item.id).audio, undefined);
  const sent = [];
  const restarted = new MessageProcessor({ store, config: c, luna, logger, transcriber });
  restarted.setTransport(async (jid, reply) => sent.push(reply), download); await idle(restarted);
  assert.equal(transcriptions, 1);
  assert.deepEqual(sent, ['Resposta: Quero corte com Julio', 'Resposta: amanhã']);
  assert.equal(store.count('inbound'), 0);
});

test('bot pausado ou número não identificado não baixa nem transcreve áudio', async t => {
  for (const mode of ['global', 'cliente', 'sem-numero']) {
    await t.test(mode, async t => {
      const store = memoryStore(); t.after(() => store.close()); const c = config();
      if (mode === 'global') store.set('system', 'bot-enabled', false);
      if (mode === 'cliente') store.set('paused', phone, true);
      const processor = new MessageProcessor({ store, config: c, logger, luna: { remember() {}, async reply() { assert.fail('Não chamar o agente.'); } }, transcriber: { async transcribe() { assert.fail('Não transcrever.'); } } });
      processor.setTransport(async () => {}, () => assert.fail('Não baixar.'));
      const item = await voice(); if (mode === 'sem-numero') item.phone = null;
      processor.accept(item); await idle(processor);
    });
  }
});

test('falha de transcrição pede reenvio sem chamar agente nem expor erro, token ou texto do SDK', async t => {
  const store = memoryStore(); t.after(() => store.close()); const sent = []; const logs = [];
  const processor = new MessageProcessor({ store, config: config(), luna: { remember() {}, async reply() { assert.fail('Sem transcrição não interpretar pedido.'); } }, logger: { warn(value) { logs.push(value); } },
    transcriber: { async transcribe() { throw new Error('segredo-do-sdk'); } } });
  processor.setTransport(async (jid, reply) => sent.push(reply), download);
  processor.accept(await voice()); await idle(processor);
  assert.match(sent[0], /reenviar ou escrever/);
  assert.doesNotMatch(JSON.stringify({ sent, logs }), /segredo-do-sdk|11999991234/);
  assert.equal(store.get('pending', phone), null);
});

test('pedido por áudio prepara resumo; só um aceite posterior ao envio permite gravar no site', async t => {
  const store = memoryStore(); t.after(() => store.close()); const c = config(); const api = fakeApi();
  const booking = new BookingService({ store, config: c, api });
  const luna = new Luna({ store, config: c, booking, client: { responses: { async create() {
    return { output: [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'preparar_agendamento', arguments: JSON.stringify(bookingArgs) }] };
  } } } });
  const replies = [];
  const processor = new MessageProcessor({ store, config: c, luna, logger, transcriber: { async transcribe(audio) {
    return audio.key.id === 'pedido' ? 'Sou Cliente Teste, quero corte com Julio em 24/10/2099 às 09:00' : 'SIM';
  } } });
  processor.setTransport(async (jid, reply) => replies.push(reply), download);
  processor.accept(await voice('pedido')); await idle(processor);
  assert.match(replies[0], /Confira os dados/);
  assert.match(replies[0], /Posso confirmar/);
  assert.equal(api.calls.some(call => call.action === 'agendar'), false);
  const before = await voice('aceite-antigo');
  before.createdAt = store.get('pending', phone).confirmationShownAt - 1;
  processor.accept(before); await idle(processor);
  assert.equal(api.calls.some(call => call.action === 'agendar'), false);
  const after = await voice('aceite-novo');
  after.createdAt = store.get('pending', phone).confirmationShownAt + 1;
  processor.accept(after); await idle(processor);
  assert.equal(api.calls.filter(call => call.action === 'agendar').length, 1);
  assert.match(replies.at(-1), /registrada/);
});
