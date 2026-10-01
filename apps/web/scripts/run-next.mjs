// Запуск Next.js с настройками из корневого .env: порт портала задаётся WEB_PORT (по умолчанию 3000),
// адрес API для проксирования — API_PORT / API_ORIGIN. Так порт можно сменить, если 3000 занят другим проектом.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const mode = process.argv[2];
if (mode !== 'dev' && mode !== 'start') {
  console.error('Использование: node scripts/run-next.mjs dev|start');
  process.exit(1);
}
const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    /* повреждённый .env не должен мешать запуску — используются значения по умолчанию */
  }
}
const port = process.env.WEB_PORT || '3000';
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, mode, '-p', port], { stdio: 'inherit', env: process.env });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
