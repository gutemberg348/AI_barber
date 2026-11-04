import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Store } from '../src/store.js';
import { sqliteAuthState } from '../src/auth-state.js';
import { config, memoryStore } from './helpers.js';

test('estado durável criptografado sobrevive a reinício, suporta buffers e rejeita chave errada', () => {
  const dir = mkdtempSync(join(tmpdir(), 'luna-test-'));
  const path = join(dir, 'test.sqlite');
  let store;
  try {
    store = new Store(path, 'b'.repeat(64));
    store.set('pending', '11999991234', { id: 'operacao-duravel', key: Buffer.from([1, 2, 3]) });
    const raw = store.db.prepare("SELECT * FROM state WHERE scope='pending'").get();
    assert.doesNotMatch(JSON.stringify(raw), /11999991234|operacao-duravel/);
    store.close(); store = null;
    assert.throws(() => new Store(path, 'a'.repeat(64)), { code: 'ENCRYPTION_KEY_MISMATCH' });
    store = new Store(path, 'b'.repeat(64));
    assert.equal(store.get('pending', '11999991234').id, 'operacao-duravel');
    assert.deepEqual(store.get('pending', '11999991234').key, Buffer.from([1, 2, 3]));
  } finally {
    store?.close();
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !dir.includes('luna-test-')) throw new Error('Diretório de teste inválido');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('estado auth Baileys persiste credenciais e chaves no SQLite', async t => {
  const store = memoryStore(); t.after(() => store.close());
  const auth = sqliteAuthState(store);
  auth.saveCreds();
  await auth.state.keys.set({ session: { abc: Buffer.from('key') } });
  const reloaded = sqliteAuthState(store);
  assert.deepEqual(reloaded.state.creds.noiseKey, auth.state.creds.noiseKey);
  assert.deepEqual((await reloaded.state.keys.get('session', ['abc'])).abc, Buffer.from('key'));
  await reloaded.state.keys.set({ session: { abc: null } });
  assert.equal((await reloaded.state.keys.get('session', ['abc'])).abc, null);
});

test('transação reverte histórico/resposta juntos em caso de erro', t => {
  const store = memoryStore(); t.after(() => store.close());
  assert.throws(() => store.transaction(() => { store.set('inbound', 'id', { reply: 'ok' }); throw new Error('fail'); }));
  assert.equal(store.get('inbound', 'id'), null);
});

test('configuração exige segredo forte e HTTPS fora de localhost', () => {
  assert.throws(() => config({ ADMIN_API_TOKEN: 'short' }));
  assert.throws(() => config({ BARBEARIA_API_URL: 'http://site.example/admin/api_ia.php' }));
  assert.throws(() => config({ BARBEARIA_API_URL: 'https://user:secret@site.example/api' }));
  assert.throws(() => config({ BARBEARIA_API_URL: 'https://site.example/api?token=123' }));
  assert.equal(config({ BARBEARIA_API_URL: 'http://localhost/barbearia/admin/api_ia.php' }).HOST, '127.0.0.1');
});
