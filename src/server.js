import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import pino from 'pino';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { BarbershopApi } from './barbershop.js';
import { BookingService } from './booking.js';
import { Luna } from './luna.js';
import { MessageProcessor } from './messages.js';
import { WhatsAppManager } from './whatsapp.js';
import { buildApp } from './app.js';

async function main() {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'token', 'apiKey', 'qr'] });
  await mkdir(dirname(config.DATABASE_PATH), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(config.DATABASE_PATH, { realpath: false, retries: 0 });
  let store, whatsapp, app, processor, retryTimer, pruneTimer;
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(retryTimer);
    clearInterval(pruneTimer);
    // Falhas de rede longas não impedem o supervisor de encerrar; o estado permite retomar.
    const deadline = setTimeout(() => process.exit(1), 20000);
    deadline.unref();
    await app?.close();
    await whatsapp?.disconnect();
    await processor?.drain();
    store?.close();
    await release();
    clearTimeout(deadline);
  }
  try {
    store = new Store(config.DATABASE_PATH, config.DATA_ENCRYPTION_KEY);
    const boundSite = store.get('system', 'site-url');
    if (boundSite && boundSite !== config.BARBEARIA_API_URL) {
      throw Object.assign(new Error('Use outro DATABASE_PATH ao trocar de site, para isolar reservas pendentes.'), { code: 'SITE_CHANGED_USE_NEW_DATABASE_PATH' });
    }
    store.set('system', 'site-url', config.BARBEARIA_API_URL);
    const api = new BarbershopApi(config);
    const booking = new BookingService({ store, api, config, logger });
    const luna = new Luna({ config, store, booking });
    processor = new MessageProcessor({ store, luna, config, logger });
    whatsapp = new WhatsAppManager({ store, config, processor, logger });
    app = await buildApp({ config, whatsapp, api, store, logger });
    await app.listen({ host: config.HOST, port: config.PORT });
    store.prune(config.RETENTION_DAYS);
    pruneTimer = setInterval(() => store.prune(config.RETENTION_DAYS), 3600000);
    retryTimer = setInterval(() => {
      if (processor.send && whatsapp.status().connected) processor.setTransport(processor.send);
    }, 30000);
    pruneTimer.unref(); retryTimer.unref();
    if (config.WHATSAPP_AUTO_CONNECT) await whatsapp.connect();
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
    logger.info({ event: 'started', port: config.PORT }, 'Luna pronta para configuração/conexão via API');
  } catch (error) {
    await stop();
    throw error;
  }
}

main().catch(error => {
  // Nunca imprimir erros arbitrários de SDKs que possam incluir URLs/tokens/corpos.
  const configError = error.message?.startsWith('Configuração inválida:');
  console.error(configError ? error.message : `Não foi possível iniciar o serviço (${error.code ?? 'verifique configuração, porta, banco e logs'}).`);
  process.exitCode = 1;
});
