import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { BufferJSON } from '@whiskeysockets/baileys';

// SQLite guarda somente estado operacional, nunca substitui a agenda do site.
export class Store {
  constructor(path, key) {
    this.key = Buffer.from(key, 'hex');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state (scope TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
        updated INTEGER NOT NULL, PRIMARY KEY(scope,id));`);
    const marker = this.db.prepare("SELECT value FROM state WHERE scope='meta' AND id='key-check'").get();
    try {
      if (marker) this.decode(marker.value, 'meta:key-check');
      else this.db.prepare('INSERT INTO state VALUES (?,?,?,?)').run('meta', 'key-check', this.encode({ ok: true }, 'meta:key-check'), Date.now());
    } catch {
      this.db.close();
      throw Object.assign(new Error('Chave de criptografia não corresponde ao banco.'), { code: 'ENCRYPTION_KEY_MISMATCH' });
    }
  }
  hash(value) { return createHmac('sha256', this.key).update(value).digest('hex'); }
  encode(value, aad) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value, BufferJSON.replacer)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  decode(value, aad) {
    const buffer = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, buffer.subarray(0, 12));
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(buffer.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString(), BufferJSON.reviver);
  }
  get(scope, id) {
    const key = this.hash(id);
    const row = this.db.prepare('SELECT value FROM state WHERE scope=? AND id=?').get(scope, key);
    return row ? this.decode(row.value, `${scope}:${key}`) : null;
  }
  set(scope, id, value) {
    const key = this.hash(id);
    this.db.prepare('INSERT INTO state VALUES (?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET value=excluded.value, updated=excluded.updated')
      .run(scope, key, this.encode(value, `${scope}:${key}`), Date.now());
  }
  delete(scope, id) { this.db.prepare('DELETE FROM state WHERE scope=? AND id=?').run(scope, this.hash(id)); }
  clear(scope) { this.db.prepare('DELETE FROM state WHERE scope=?').run(scope); }
  entries(scope) {
    return this.db.prepare('SELECT id,value FROM state WHERE scope=? ORDER BY updated').all(scope)
      .map(row => this.decode(row.value, `${scope}:${row.id}`));
  }
  count(scope) { return this.db.prepare('SELECT COUNT(*) AS count FROM state WHERE scope=?').get(scope).count; }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  prune(days) {
    // Operações incertas e credenciais jamais expiram automaticamente.
    this.db.prepare("DELETE FROM state WHERE scope IN ('history','processed','rate') AND updated < ?")
      .run(Date.now() - days * 86400000);
  }
  close() { this.db.close(); }
}
