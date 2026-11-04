import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setupVps } from '../scripts/setup-vps.js';
import { loadConfig } from '../src/config.js';

test('preparação VPS gera segredos válidos, usa API correta e preserva arquivo existente', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'luna-deploy-test-'));
  try {
    const target = join(dir, '.env');
    assert.equal((await setupVps(target)).created, true);
    const text = await readFile(target, 'utf8');
    const env = Object.fromEntries(text.split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => {
      const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
    }));
    const config = loadConfig(env);
    assert.equal(config.NODE_ENV, 'production');
    assert.match(config.ADMIN_API_TOKEN, /^[a-f0-9]{64}$/);
    assert.match(config.DATA_ENCRYPTION_KEY, /^[a-f0-9]{64}$/);
    assert.notEqual(config.ADMIN_API_TOKEN, config.DATA_ENCRYPTION_KEY);
    assert.equal(config.BARBEARIA_API_URL, 'https://goodstyler.com/admin/api_ia.php');
    assert.equal(config.WHATSAPP_PRINT_QR, false);
    assert.equal(config.OPENAI_API_KEY, ''); assert.equal(config.BARBEARIA_API_TOKEN, '');
    assert.equal((await setupVps(target)).created, false);
    assert.equal(await readFile(target, 'utf8'), text, 'Não pode substituir chave de banco existente');
  } finally {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !dir.includes('luna-deploy-test-')) throw new Error('Pasta temporária inválida');
    await rm(dir, { recursive: true });
  }
});
