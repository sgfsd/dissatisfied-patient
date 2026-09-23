/* ============================================================
   Сторож секретов: ключ провайдера не должен попасть в git.

   Что проверяется:
   1. в репозиторий не попадают файлы-секреты (.env*, кроме .env.example,
      data/ с базой и data/settings.json);
   2. ни в одном файле, который уйдёт в git, нет ключа из ВАШЕГО локального
      .env / data/settings.json (сравнение по точному значению);
   3. нет строк, похожих на ключи вообще (sk-…, Bearer …, AI_API_KEY=значение).

   Запуск:
     npm run check:secrets              — файлы, которые попадут в коммит
                                          (отслеживаемые + новые, не из .gitignore)
     node scripts/check-secrets.mjs --staged   — только подготовленные к коммиту
                                                 (так его вызывает pre-commit)
     node scripts/check-secrets.mjs --history  — плюс вся история git: запустите
                                                 перед первым push на GitHub

   Подключить как pre-commit один раз на машине:
     git config core.hooksPath .githooks
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const stagedOnly = args.has('--staged');
const withHistory = args.has('--history');

function git(...argv) {
  return execFileSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Значения секретов из локальных файлов — то, что точно нельзя публиковать. */
function localSecrets() {
  const secrets = new Map();
  for (const file of ['.env', '.env.local']) {
    let raw = '';
    try { raw = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?(AI_API_KEY|ADMIN_PASSWORD)\s*=\s*(.*)$/);
      if (!m) continue;
      const value = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
      if (value.length >= 8) secrets.set(value, `${m[1]} из ${file}`);
    }
  }
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'data', 'settings.json'), 'utf8'));
    if (typeof saved.apiKey === 'string' && saved.apiKey.length >= 8) secrets.set(saved.apiKey, 'ключ из data/settings.json');
  } catch { /* ключ не вводили через кабинет */ }
  return secrets;
}

const PATTERNS = [
  { name: 'похоже на API-ключ (sk-…)', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'похоже на Bearer-токен', re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/g },
  { name: 'AI_API_KEY со значением', re: /^\s*AI_API_KEY\s*=\s*["']?[^\s"'#]{8,}/gm },
];

const FORBIDDEN = [
  { re: /(^|\/)\.env(\..+)?$/, why: 'файл окружения с секретами' },
  { re: /(^|\/)data\//, why: 'папка данных: база, кэш и data/settings.json' },
  { re: /\.(db|db-wal|db-shm|sqlite)$/, why: 'файл базы данных' },
];
const ALLOWED = new Set(['.env.example']);

const mask = (s) => (s.length <= 10 ? '•'.repeat(s.length) : `${s.slice(0, 4)}…${s.slice(-2)}`);
const findings = [];

function scanText(label, text, secrets) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [value, source] of secrets) {
      if (line.includes(value)) findings.push(`${label}:${i + 1} — найден ${source} (${mask(value)})`);
    }
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      for (const hit of line.matchAll(re)) findings.push(`${label}:${i + 1} — ${name}: ${mask(hit[0])}`);
    }
  });
}

function candidateFiles() {
  if (stagedOnly) return git('diff', '--cached', '--name-only', '--diff-filter=ACMR').split('\n').filter(Boolean);
  return git('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean);
}

function readCandidate(file) {
  if (stagedOnly) {
    try { return git('show', `:${file}`); } catch { return null; }
  }
  try {
    const buf = fs.readFileSync(path.join(root, file));
    return buf.includes(0) ? null : buf.toString('utf8'); // двоичные файлы пропускаем
  } catch {
    return null;
  }
}

const secrets = localSecrets();
const files = candidateFiles();
const self = 'scripts/check-secrets.mjs';

for (const file of files) {
  const normalized = file.replace(/\\/g, '/');
  if (!ALLOWED.has(normalized)) {
    const bad = FORBIDDEN.find(({ re }) => re.test(normalized));
    if (bad) findings.push(`${normalized} — ${bad.why}: такой файл нельзя добавлять в git`);
  }
  if (normalized === self || normalized === 'package-lock.json') continue;
  const text = readCandidate(file);
  if (text) scanText(normalized, text, secrets);
}

if (withHistory) {
  // Только точные значения ваших ключей: шаблоны по всей истории дали бы шум.
  const log = git('log', '--all', '-p', '--no-color', '--no-ext-diff');
  for (const [value, source] of secrets) {
    if (log.includes(value)) findings.push(`история git — найден ${source} (${mask(value)}): нужна чистка истории и новый ключ`);
  }
}

const scope = stagedOnly ? 'подготовленные к коммиту файлы' : 'файлы, которые попадут в git';
if (findings.length) {
  console.error(`\n✗ Сторож секретов: проблем — ${findings.length} (${scope})\n`);
  for (const line of findings) console.error(`  • ${line}`);
  console.error('\n  Уберите секрет из файла (ключ живёт только в .env или в кабинете преподавателя).');
  console.error('  Если ключ уже был опубликован — отзовите его у провайдера и выпустите новый.\n');
  process.exit(1);
}
console.log(
  `✓ Сторож секретов: чисто — ${files.length} файл(ов)${withHistory ? ' и вся история git' : ''}` +
    `${secrets.size ? `, сверено с ${secrets.size} локальным(и) секретом(ами)` : ''}.`,
);
