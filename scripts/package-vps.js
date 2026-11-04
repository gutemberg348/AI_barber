import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['Dockerfile', 'compose.yaml', '.dockerignore', '.env.example', '.env.production.example',
  'package.json', 'package-lock.json', 'README.md', 'src', 'public', 'prompts', 'scripts', 'deploy',
  'docs/DEPLOY_VPS.md', 'docs/PAINEL.md', 'docs/API_IA.md', 'docs/CORRIGIR_CONFIRMACAO_SITE.md'];
for (const file of ['scripts/preparar-vps.sh', 'scripts/configurar-nginx.sh']) {
  if ((await readFile(resolve(root, file), 'utf8')).includes('\r')) throw new Error(`Use finais de linha LF em ${file}.`);
}
await mkdir(resolve(root, 'release'), { recursive: true });
const archive = resolve(root, 'release/luna-vps.tar.gz');
execFileSync('tar', ['-czf', archive, ...files], { cwd: root, stdio: 'pipe' });
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
if (entries.some(entry => /(^|\/)(?:\.env|data|node_modules)(?:\/|$)/.test(entry))) {
  throw new Error('Arquivo privado detectado no pacote. Não envie o pacote.');
}
if (!entries.includes('scripts/configurar-nginx.sh') || !entries.includes('compose.yaml')) throw new Error('Pacote incompleto.');
console.log('Pacote pronto: release/luna-vps.tar.gz. Sem .env, chaves, banco ou node_modules.');
