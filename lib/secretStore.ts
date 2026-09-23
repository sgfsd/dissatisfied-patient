import { execFileSync } from 'node:child_process';

/* ============================================================
   Хранение ключа AI-провайдера на диске.

   Ключ вводится один раз при установке (консоль start.cmd или кабинет
   преподавателя) и сохраняется в data/settings.json НЕ открытым текстом:
   на Windows он шифруется через DPAPI — тем же механизмом, которым
   Windows хранит сохранённые пароли. Расшифровать его может только та
   же учётная запись Windows на том же компьютере, поэтому скопированная
   папка или архив ключа не раскрывают. Ввод при запуске не нужен.

   Честная граница: программа, запущенная под той же учётной записью,
   ключ расшифровать может — иначе не смог бы и сам тренажёр. От этого
   защищает только отдельная учётная запись Windows под сервис.

   Вне Windows DPAPI нет — там ключ хранится как есть, с правами 0600.
   ============================================================ */

export type StoredSecret = { scheme: 'dpapi-user' | 'plain'; data: string };

/** Привязка к приложению: чужая программа не расшифрует блоб «по ошибке». */
const ENTROPY = 'vera-practice/provider-key/v1';

/* Секрет передаётся через переменную окружения, а не в командной строке:
   командные строки процессов видны любому в диспетчере задач. Результат
   расшифровки возвращается в base64 — без сюрпризов с кодовой страницей консоли. */
const PROTECT =
  "Add-Type -AssemblyName System.Security; $e=[Text.Encoding]::UTF8.GetBytes($env:VERA_ENTROPY); " +
  "$b=[Text.Encoding]::UTF8.GetBytes($env:VERA_SECRET); " +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser'))";
const UNPROTECT =
  "Add-Type -AssemblyName System.Security; $e=[Text.Encoding]::UTF8.GetBytes($env:VERA_ENTROPY); " +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:VERA_SECRET),$e,'CurrentUser'))";

function powershell(script: string, secret: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, VERA_SECRET: secret, VERA_ENTROPY: ENTROPY },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Доступно ли шифрование под учётную запись (только Windows). */
export const secretProtectionAvailable = process.platform === 'win32';

/** Зашифровать ключ для хранения на диске. */
export function protectSecret(value: string): StoredSecret {
  if (secretProtectionAvailable) {
    try {
      return { scheme: 'dpapi-user', data: powershell(PROTECT, value) };
    } catch (e) {
      // Например, PowerShell заблокирован политикой: сервис должен работать и так.
      console.warn('[secret] шифрование DPAPI недоступно, ключ сохранён без шифрования:', e instanceof Error ? e.message : e);
    }
  }
  return { scheme: 'plain', data: value };
}

/**
 * Расшифровать сохранённый ключ. Бросает ошибку, если блоб зашифрован под
 * другой учётной записью Windows или на другом компьютере.
 */
export function unprotectSecret(stored: StoredSecret): string {
  if (stored.scheme === 'plain') return stored.data;
  if (!secretProtectionAvailable) throw new Error('Ключ зашифрован DPAPI — расшифровать его можно только на Windows');
  return Buffer.from(powershell(UNPROTECT, stored.data), 'base64').toString('utf8');
}

export function isStoredSecret(value: unknown): value is StoredSecret {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<StoredSecret>;
  return (v.scheme === 'dpapi-user' || v.scheme === 'plain') && typeof v.data === 'string';
}
