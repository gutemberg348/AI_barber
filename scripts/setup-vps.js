import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function setupVps(target = '.env') {
  const template = await readFile(new URL('../.env.production.example', import.meta.url), 'utf8');
  const contents = template
    .replace(/^ADMIN_API_TOKEN=$/m, `ADMIN_API_TOKEN=${randomBytes(32).toString('hex')}`)
    .replace(/^DATA_ENCRYPTION_KEY=$/m, `DATA_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`);
  try {
    await writeFile(target, contents, { flag: 'wx', mode: 0o600 });
    return { created: true };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { created: false };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await setupVps();
  console.log(result.created
    ? '.env de produção criado. Preencha OPENAI_API_KEY e BARBEARIA_API_TOKEN. Chaves de acesso e criptografia geradas sem exibir segredos.'
    : '.env existente preservado. Confira OPENAI_API_KEY e BARBEARIA_API_TOKEN; não troque a chave de criptografia de um banco existente.');
  console.log('Domínio: https://ia.goodstyler.com/painel. API do site: https://goodstyler.com/admin/api_ia.php.');
}
