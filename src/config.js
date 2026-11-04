import { z } from 'zod';
import { resolve } from 'node:path';

const integer = (fallback, min, max) => z.coerce.number().int().min(min).max(max).default(fallback);
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: integer(3000, 1, 65535),
  ADMIN_API_TOKEN: z.string().min(32).regex(/^\S+$/),
  DATA_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  DATABASE_PATH: z.string().default('./data/luna.sqlite'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().min(1).default('gpt-4.1-mini'),
  LUNA_PROMPT_PATH: z.string().default('./prompts/luna.md'),
  OPENAI_MAX_OUTPUT_TOKENS: integer(1200, 200, 8000),
  BARBEARIA_API_URL: z.string().url().default('https://goodstyler.com/admin/api_ia.php'),
  BARBEARIA_API_TOKEN: z.string().default(''),
  BARBEARIA_SITE_URL: z.string().url().default('https://goodstyler.com'),
  BARBEARIA_NOME: z.string().max(100).default('Good Style'),
  BARBEARIA_DONO: z.string().trim().min(1).max(100).default('Julio'),
  BARBEARIA_TIMEZONE: z.string().default('America/Sao_Paulo'),
  API_TIMEOUT_MS: integer(15000, 100, 60000),
  WHATSAPP_AUTO_CONNECT: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  WHATSAPP_PRINT_QR: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  MESSAGE_MAX_AGE_SECONDS: integer(300, 30, 3600),
  MAX_CONCURRENT_CHATS: integer(4, 1, 20),
  MAX_PENDING_MESSAGES: integer(100, 1, 1000),
  CHAT_MESSAGES_PER_MINUTE: integer(12, 1, 60),
  HISTORY_TTL_HOURS: integer(24, 1, 168),
  RETENTION_DAYS: integer(30, 1, 365),
});

export function loadConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Configuração inválida: ${result.error.issues.map(i => i.path.join('.')).join(', ')}. Execute npm run setup e revise .env.`);
  }
  const config = result.data;
  const url = new URL(config.BARBEARIA_API_URL);
  const site = new URL(config.BARBEARIA_SITE_URL);
  for (const target of [url, site]) {
    if (target.username || target.password || target.hash || target.search) throw new Error('URLs não podem conter credenciais, fragmento ou query string.');
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Use URL HTTP(S).');
    if (target.protocol !== 'https:' && (config.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) {
      throw new Error('HTTPS obrigatório; HTTP somente para localhost em desenvolvimento.');
    }
  }
  new Intl.DateTimeFormat('pt-BR', { timeZone: config.BARBEARIA_TIMEZONE }).format();
  if (config.BARBEARIA_API_TOKEN && !/^\S{32,}$/.test(config.BARBEARIA_API_TOKEN)) throw new Error('BARBEARIA_API_TOKEN inválido.');
  config.DATABASE_PATH = resolve(config.DATABASE_PATH);
  return Object.freeze(config);
}

export function integrationStatus(config) {
  return { openaiConfigured: Boolean(config.OPENAI_API_KEY), barbershopConfigured: Boolean(config.BARBEARIA_API_TOKEN) };
}
