import test from 'node:test';
import assert from 'node:assert/strict';
import { BarbershopApi } from '../src/barbershop.js';
import { buildApp } from '../src/app.js';
import { config, logger, memoryStore, catalog } from './helpers.js';

test('cliente injeta Bearer no header e serializa ações GET do contrato', async () => {
  const calls = [];
  const api = new BarbershopApi(config(), { fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json(catalog);
  } });
  await api.request('disponibilidade', { barbeiro_id: 1, servicos: [1, 2], data_inicio: null });
  assert.equal(calls[0].url.searchParams.get('servicos'), '1,2');
  assert.equal(calls[0].url.searchParams.has('data_inicio'), false);
  assert.equal(calls[0].url.searchParams.has('token'), false);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${'c'.repeat(64)}`);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.headers['Cache-Control'], 'no-cache, no-store');
});

test('timeout e 503 repetem exatamente chave/corpo antes de recuperar sucesso', async () => {
  const calls = [];
  const api = new BarbershopApi(config(), { sleep: async () => {}, fetchImpl: async (url, options) => {
    calls.push(options);
    if (calls.length === 1) throw new Error('timeout');
    if (calls.length === 2) return Response.json({ sucesso: false, codigo: 'tente_novamente' }, { status: 503, headers: { 'retry-after': '1' } });
    return Response.json({ sucesso: true, agendamento: { id: 1 } }, { status: 201 });
  } });
  const result = await api.request('agendar', { telefone: '11999991234' }, 'fixed-key-123456789');
  assert.equal(result.agendamento.id, 1);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(c => c.body)).size, 1);
  assert.equal(new Set(calls.map(c => c.headers['Idempotency-Key'])).size, 1);
});

test('401 não gera retries; POST não segue sem chave; falha ambígua é identificada', async () => {
  let calls = 0;
  const api = new BarbershopApi(config(), { sleep: async () => {}, fetchImpl: async () => {
    calls++; return Response.json({ sucesso: false, codigo: 'nao_autorizado' }, { status: 401 });
  } });
  await assert.rejects(api.request('catalogo'), { code: 'nao_autorizado', uncertain: false });
  assert.equal(calls, 1);
  await assert.rejects(api.request('agendar'), { code: 'idempotencia_obrigatoria' });
  const broken = new BarbershopApi(config(), { sleep: async () => {}, fetchImpl: async () => { throw new Error('timeout'); } });
  await assert.rejects(broken.request('agendar', {}, 'stable-key-123456'), { uncertain: true });
});

test('resposta inválida após escrita não afirma falha definitiva', async () => {
  const api = new BarbershopApi(config(), { sleep: async () => {}, fetchImpl: async () => new Response('<html>proxy</html>') });
  await assert.rejects(api.request('agendar', {}, 'stable-key-123456'), { code: 'resposta_invalida', uncertain: true });
});

test('500 do PHP preserva código e status e repete a mesma operação sem afirmar sucesso', async () => {
  const calls = [];
  const api = new BarbershopApi(config(), { sleep: async () => {}, fetchImpl: async (url, options) => {
    calls.push({ action: url.searchParams.get('acao'), body: options.body, key: options.headers['Idempotency-Key'] });
    return Response.json({ sucesso: false, codigo: 'erro_interno', erro: 'Verifique a migração.' }, { status: 500 });
  } });
  await assert.rejects(api.request('agendar', { nome: 'Cliente Teste' }, 'same-key-12345678'), { code: 'erro_interno', status: 500, uncertain: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls, Array(3).fill({ action: 'agendar', body: '{"nome":"Cliente Teste"}', key: 'same-key-12345678' }));
});

test('API protege status/QR/controle, retorna PNG, não vaza token e expõe prontidão separada', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const status = { state: 'qr', connected: false, qrAvailable: true, botEnabled: true };
  const whatsapp = {
    status: () => status,
    qrCode: async () => ({ qr: 'sensitive-qr', qrDataUrl: 'data:image/png;base64,iVBORw==', expiresAt: new Date().toISOString() }),
    connect: async () => status, disconnect: async () => status, logout: async () => status,
  };
  const app = await buildApp({ config: config(), store, whatsapp, logger, api: { request: async () => catalog } });
  t.after(() => app.close());
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  for (const url of ['/api/v1/whatsapp/status', '/api/v1/whatsapp/qrcode', '/readyz']) {
    const reply = await app.inject(url); assert.equal(reply.statusCode, 401); assert.doesNotMatch(reply.body, /sensitive-qr/);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/whatsapp/connect' })).statusCode, 401);
  const headers = { authorization: `Bearer ${'a'.repeat(64)}` };
  const qr = await app.inject({ url: '/api/v1/whatsapp/qrcode', headers });
  assert.equal(qr.statusCode, 200); assert.equal(qr.json().qr, 'sensitive-qr'); assert.equal(qr.headers['cache-control'], 'no-store');
  const png = await app.inject({ url: '/api/v1/whatsapp/qrcode.png', headers });
  assert.match(png.headers['content-type'], /image\/png/);
  const ready = await app.inject({ url: '/readyz', headers });
  assert.equal(ready.statusCode, 503); assert.equal(ready.json().ready, false);
  assert.doesNotMatch(ready.body, /cccccccc|aaaaaaaa/);
  const invalid = await app.inject({ method: 'PUT', url: '/api/v1/bot', headers, payload: {} });
  assert.equal(invalid.statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/bot', headers, payload: { enabled: false } })).statusCode, 200);
  assert.equal(store.get('system', 'bot-enabled'), false);
  whatsapp.qrCode = async () => null;
  assert.equal((await app.inject({ url: '/api/v1/whatsapp/qrcode', headers })).statusCode, 409);
});
