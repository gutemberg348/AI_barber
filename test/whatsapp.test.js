import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { WhatsAppManager } from '../src/whatsapp.js';
import { config, logger, memoryStore } from './helpers.js';

function setup(t) {
  const store = memoryStore();
  const sockets = [];
  const processor = { setTransport(send) { this.send = send; }, accept() {} };
  const manager = new WhatsAppManager({ store, config: config(), processor, logger,
    socketFactory(options) {
      const socket = { ev: new EventEmitter(), options, end() {}, async logout() {}, async sendMessage() {} };
      sockets.push(socket); return socket;
    },
  });
  t.after(async () => { await manager.disconnect(); store.close(); });
  return { manager, store, sockets, processor };
}

test('connect é idempotente; QR expira e desaparece ao conectar; disconnect preserva credenciais', async t => {
  const { manager, store, sockets, processor } = setup(t);
  await Promise.all([manager.connect(), manager.connect()]);
  assert.equal(sockets.length, 1);
  sockets[0].ev.emit('creds.update');
  await manager.onUpdate({ qr: 'example-qr-payload' }, sockets[0]);
  assert.equal(manager.status().qrAvailable, true);
  assert.match((await manager.qrCode()).qrDataUrl, /^data:image\/png;base64,/);
  manager.qr.expiresAt = 1; assert.equal(await manager.qrCode(), null);
  await manager.onUpdate({ connection: 'open' }, sockets[0]);
  assert.equal(manager.status().connected, true); assert.equal(manager.status().qrAvailable, false);
  assert.equal(typeof processor.send, 'function');
  await manager.disconnect();
  assert.equal(manager.status().connected, false); assert.ok(store.get('auth', 'creds'));
  sockets[0].ev.emit('connection.update', { connection: 'open' });
  assert.equal(manager.status().connected, false);
});

test('restartRequired agenda reconexão; logout limpa sessão e não reconecta', async t => {
  const { manager, store, sockets } = setup(t);
  await manager.connect(); sockets[0].ev.emit('creds.update');
  await manager.onUpdate({ connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } } }, sockets[0]);
  assert.equal(manager.state, 'reconnecting'); assert.ok(manager.retryTimer);
  await manager.connect();
  assert.equal(sockets.length, 2);
  await manager.onUpdate({ connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } }, sockets[1]);
  assert.equal(manager.state, 'logged_out'); assert.equal(store.get('auth', 'creds'), null); assert.equal(manager.manualStop, true);
});

test('conexão substituída exige intervenção em vez de loop de reconexão', async t => {
  const { manager, sockets } = setup(t);
  await manager.connect();
  await manager.onUpdate({ connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionReplaced } } } }, sockets[0]);
  assert.equal(manager.state, 'error'); assert.equal(manager.manualStop, true);
});
