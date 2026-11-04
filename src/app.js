import { timingSafeEqual, createHash } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { integrationStatus } from './config.js';
import { panelSessions, publicPanelRoutes, registerPanel } from './panel.js';
import { applyScheduledPause, botEnabled, savePauseSettings } from './bot-control.js';

const digest = text => createHash('sha256').update(text).digest();

export async function buildApp({ config, whatsapp, api, store, logger }) {
  const app = Fastify({ loggerInstance: logger, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 16384, trustProxy: false });
  await app.register(helmet, { contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
    upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null,
  } } });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  const sessions = panelSessions(config);
  const pauseTimer = setInterval(() => {
    try { applyScheduledPause(store, config.BARBEARIA_TIMEZONE); }
    catch { logger.error({ event: 'scheduled_pause_failed' }, 'Falha ao aplicar pausa programada'); }
  }, 1000);
  pauseTimer.unref();
  app.addHook('onClose', async () => clearInterval(pauseTimer));
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.routeOptions.url === '/healthz' || publicPanelRoutes.has(request.routeOptions.url)) return;
    // A rota de login valida e-mail/senha (ou Bearer legado) no próprio handler.
    if (request.routeOptions.url === '/api/v1/panel/session' && request.method === 'POST') return;
    const expected = `Bearer ${config.ADMIN_API_TOKEN}`;
    const supplied = request.headers.authorization ?? '';
    if (timingSafeEqual(digest(supplied), digest(expected))) return;
    if (sessions.valid(request)) {
      if (!['GET', 'HEAD'].includes(request.method) && request.headers['x-luna-panel'] !== '1') return reply.code(403).send({ error: 'origem_invalida' });
      return;
    }
    return reply.code(401).send({ error: 'nao_autorizado' });
  });
  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ event: 'http_failed', route: request.routeOptions.url }, 'Falha no endpoint');
    reply.code(status).send({ error: status === 400 ? 'requisicao_invalida' : status === 429 ? 'limite_de_requisicoes' : status === 500 ? 'erro_interno' : 'requisicao_recusada' });
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  const fullStatus = () => {
    const integration = integrationStatus(config);
    const connection = { ...whatsapp.status(), botEnabled: botEnabled(store, config.BARBEARIA_TIMEZONE) };
    return { ...connection, ...integration,
      ready: connection.connected && connection.botEnabled && integration.openaiConfigured && integration.barbershopConfigured,
      readinessScope: 'connection_and_configuration',
    };
  };
  await registerPanel(app, { config, store, fullStatus, sessions });
  app.get('/readyz', async (request, reply) => {
    const status = fullStatus();
    return reply.code(status.ready ? 200 : 503).send(status);
  });
  app.get('/api/v1/whatsapp/status', async () => fullStatus());
  app.get('/api/v1/whatsapp/qrcode', async (request, reply) => {
    const qr = await whatsapp.qrCode();
    if (!qr) return reply.code(409).send({ error: 'qr_indisponivel', ...whatsapp.status() });
    return { ...qr, state: whatsapp.status().state };
  });
  app.get('/api/v1/whatsapp/qrcode.png', async (request, reply) => {
    const qr = await whatsapp.qrCode();
    if (!qr) return reply.code(409).send({ error: 'qr_indisponivel' });
    return reply.type('image/png').send(Buffer.from(qr.qrDataUrl.split(',')[1], 'base64'));
  });
  for (const action of ['connect', 'disconnect', 'logout']) {
    app.post(`/api/v1/whatsapp/${action}`, { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async () => whatsapp[action]());
  }
  app.put('/api/v1/bot', {
    schema: { body: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'], additionalProperties: false } },
  }, async request => {
    applyScheduledPause(store, config.BARBEARIA_TIMEZONE);
    store.set('system', 'bot-enabled', request.body.enabled);
    return fullStatus();
  });
  app.put('/api/v1/bot/schedule', {
    schema: { body: { type: 'object', required: ['enabled', 'time', 'repeat'], additionalProperties: false,
      properties: { enabled: { type: 'boolean' }, time: { type: 'string', pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' }, repeat: { type: 'string', enum: ['once', 'daily'] } } } },
  }, async request => {
    const schedule = savePauseSettings(store, request.body, config.BARBEARIA_TIMEZONE);
    return { schedule, status: fullStatus(), timezone: config.BARBEARIA_TIMEZONE };
  });
  app.get('/api/v1/integrations', async () => ({
    ...integrationStatus(config), model: config.OPENAI_MODEL, barbershop: config.BARBEARIA_NOME,
    timezone: config.BARBEARIA_TIMEZONE,
  }));
  app.get('/api/v1/integrations/barbershop/check', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const catalog = await api.request('catalogo');
      return { ok: true, timezone: catalog.timezone, professionals: catalog.barbeiros?.length ?? 0 };
    } catch {
      return reply.code(502).send({ ok: false, error: 'integracao_indisponivel' });
    }
  });
  return app;
}
