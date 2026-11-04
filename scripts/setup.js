import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const content = template
  .replace('ADMIN_API_TOKEN=', `ADMIN_API_TOKEN=${randomBytes(32).toString('hex')}`)
  .replace('DATA_ENCRYPTION_KEY=', `DATA_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`);
try {
  await writeFile('.env', content, { flag: 'wx', mode: 0o600 });
  await mkdir('data', { recursive: true, mode: 0o700 });
  console.log('.env criado. Preencha OPENAI_API_KEY e BARBEARIA_API_TOKEN. Segredos não são exibidos no terminal.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env já existe e foi preservado.');
}
