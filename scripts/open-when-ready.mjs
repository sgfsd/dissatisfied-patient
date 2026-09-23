/* Открывает браузер, как только локальный сервер начнёт отвечать.
   Запускается из start.cmd параллельно с сервером: так пользователю не
   нужно угадывать момент и вручную набирать адрес.

   Готовность проверяется по /api/health, и это не случайно: запрос открывает
   базу, а вместе с ней выполняются миграции и печатается код первого
   запуска — в то самое окно, где работает сервер, ещё до открытия браузера.

   Флаг --print печатает адрес, но браузер не открывает (проверка готовности). */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const deadlineMs = 180_000;
const args = process.argv.slice(2);
const printOnly = args.includes('--print');

function readPort() {
  if (process.env.PORT) return Number(process.env.PORT);
  for (const file of ['.env.local', '.env']) {
    try {
      const raw = fs.readFileSync(path.join(root, file), 'utf8');
      const m = raw.match(/^\s*PORT\s*=\s*(\d+)\s*$/m);
      if (m) return Number(m[1]);
    } catch {
      /* файла нет — смотрим следующий */
    }
  }
  return 3000;
}

const url = args.find((a) => !a.startsWith('-')) || `http://localhost:${readPort()}`;

function openBrowser(target) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

async function waitForServer() {
  const deadline = Date.now() + deadlineMs;
  const probe = new URL('/api/health', url).href;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(probe, { method: 'GET' });
      // Любой ответ (в том числе 404) означает, что сервер уже слушает порт.
      if (res.status < 500) return true;
    } catch {
      /* ещё поднимается */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

if (await waitForServer()) {
  const opened = printOnly ? false : openBrowser(url);
  console.log(opened ? `  Открываю ${url}` : `  Тренажёр готов: ${url}`);
} else {
  console.log(`\n  Сервер не ответил за 3 минуты. Откройте вручную: ${url}\n`);
}
