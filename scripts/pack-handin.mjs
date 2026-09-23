/* ============================================================
   Архив проекта для сдачи (вуз, кафедра) — БЕЗ ключа.

   В архив идут ровно те файлы, что попали бы в git (с учётом .gitignore).
   Не идут: .env, node_modules, .next, .node и data/ — база с учётными
   записями и сохранённый ключ остаются у вас.

   На новом компьютере: распаковать → start.cmd. При первом запуске он сам
   попросит ключ AI-провайдера и сохранит его зашифрованным под учётную
   запись Windows этого компьютера (см. scripts/setup-key.mts).

   Запуск: npm run pack:handin  →  handin/vera-practice-<дата>.zip
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const outDir = path.join(root, 'handin');
const stamp = new Date().toISOString().slice(0, 10);
const outFile = path.join(outDir, `vera-practice-${stamp}.zip`);

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((file) => !file.startsWith('handin/') && fs.existsSync(path.join(root, file)));

// Секреты в архив не попадают, даже если .gitignore кто-то ослабит.
const SECRET = /(^|\/)\.env(\..+)?$|(^|\/)data\//;
const packed = files.filter((file) => file === '.env.example' || !SECRET.test(file));

/* ---------- Минимальный ZIP (deflate, имена в UTF-8) без зависимостей ---------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const chunks = [];
const central = [];
let offset = 0;
for (const file of packed) {
  const data = fs.readFileSync(path.join(root, file));
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  const name = Buffer.from(`vera-practice/${file.replace(/\\/g, '/')}`, 'utf8');
  const crc = crc32(data);
  const { time, day } = dosTime(fs.statSync(path.join(root, file)).mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // версия для распаковки
  local.writeUInt16LE(0x0800, 6); // имена в UTF-8
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  chunks.push(local, name, compressed);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt16LE(time, 12);
  entry.writeUInt16LE(day, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(compressed.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);
  offset += local.length + name.length + compressed.length;
}
const centralSize = central.reduce((sum, b) => sum + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(packed.length, 8);
end.writeUInt16LE(packed.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, Buffer.concat([...chunks, ...central, end]));

console.log(`✓ ${path.relative(root, outFile)} — ${packed.length} файл(ов), ${(fs.statSync(outFile).size / 1024).toFixed(0)} КБ`);
console.log('  Ключа в архиве нет: при первом запуске start.cmd попросит его один раз.');
