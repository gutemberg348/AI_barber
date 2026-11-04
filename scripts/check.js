import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

for (const dir of ['src', 'scripts', 'test', 'public']) {
  for (const entry of readdirSync(dir, { recursive: true })) {
    if (!entry.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', `${dir}/${entry}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log('Sintaxe JavaScript validada.');
