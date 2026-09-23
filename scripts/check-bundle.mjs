/* ============================================================
   Проверка собранного клиента: в браузерные чанки не должны попадать
   скрытые карточки кейсов, эталоны оценщика и серверный конфиг.

   Статические файлы .next/static отдаются без входа, поэтому всё, что
   в них лежит, может прочитать любой, кто открыл адрес тренажёра.
   Запускать после `npm run build`:  npm run check:bundle
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), '.next', 'static');
if (!fs.existsSync(dir)) {
  console.error('Сборки нет — сначала npm run build');
  process.exit(2);
}

/* Имена полей серверных структур: в минифицированном коде имена свойств
   сохраняются, так что их появление — надёжный признак утечки. */
const MARKERS = ['expectedPlan', 'safetyNet', 'redFlags', 'volunteered', 'calibration', 'AI_API_KEY', 'better-sqlite3'];

function* walk(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

const leaks = [];
let count = 0;
for (const file of walk(dir)) {
  count += 1;
  const text = fs.readFileSync(file, 'utf8');
  for (const marker of MARKERS) if (text.includes(marker)) leaks.push(`${path.relative(process.cwd(), file)} — «${marker}»`);
}

if (leaks.length) {
  console.error(`✗ В браузерные чанки попали серверные данные (${leaks.length}):`);
  for (const line of leaks) console.error(`  • ${line}`);
  console.error('  Скорее всего, клиентский компонент импортирует lib/domains, lib/db или lib/config.');
  process.exit(1);
}
console.log(`✓ Клиентские чанки чистые: ${count} файл(ов), скрытых карточек и серверного конфига нет.`);
