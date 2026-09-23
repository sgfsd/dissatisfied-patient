/* ============================================================
   Ограничение частоты попыток входа.

   Тренажёр живёт на одном сервере кафедры, поэтому счётчик держится в
   памяти процесса: внешний Redis тут был бы лишней зависимостью.

   Важная особенность среды: студенты работают за общими компьютерами и
   часто сидят за одним NAT, то есть приходят с одного адреса. Жёсткий
   лимит по IP запер бы всю группу из-за чужой опечатки, поэтому лимиты
   разные: по логину — строгий (это защита конкретного аккаунта от
   подбора), по адресу — мягкий (это защита от перебора логинов пачкой).
   ============================================================ */

type Bucket = { failures: number; firstAt: number; blockedUntil: number };

export type LimitPolicy = {
  /** Сколько неудач проходит без задержки. */
  free: number;
  /** Потолок блокировки, мс. */
  maxBlockMs: number;
};

/** Подбор пароля к известному логину: пускаем недалеко. */
export const ACCOUNT_POLICY: LimitPolicy = { free: 5, maxBlockMs: 15 * 60 * 1000 };
/** Перебор логинов с одной машины: терпим опечатки соседей по классу. */
export const ADDRESS_POLICY: LimitPolicy = { free: 30, maxBlockMs: 2 * 60 * 1000 };

const WINDOW_MS = 15 * 60 * 1000;

const buckets = new Map<string, Bucket>();
/* Синглтон, переживающий hot-reload Next.js dev. */
const g = globalThis as unknown as { __veraRateLimit?: Map<string, Bucket> };
const store = (): Map<string, Bucket> => (g.__veraRateLimit ??= buckets);

function sweep(now: number): void {
  const map = store();
  if (map.size < 512) return;
  for (const [key, bucket] of map) {
    if (now - bucket.firstAt > WINDOW_MS && now > bucket.blockedUntil) map.delete(key);
  }
}

/** Клиент запроса: за обратным прокси берём первый адрес из X-Forwarded-For. */
export function clientKey(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local';
  return ip.slice(0, 64);
}

/** Сколько секунд ждать; 0 — можно пробовать. */
export function retryAfter(key: string): number {
  const bucket = store().get(key);
  if (!bucket) return 0;
  const left = bucket.blockedUntil - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

export function registerFailure(key: string, policy: LimitPolicy = ACCOUNT_POLICY): void {
  const now = Date.now();
  sweep(now);
  const map = store();
  const bucket = map.get(key);
  if (!bucket || now - bucket.firstAt > WINDOW_MS) {
    map.set(key, { failures: 1, firstAt: now, blockedUntil: 0 });
    return;
  }
  bucket.failures += 1;
  if (bucket.failures > policy.free) {
    // 2^n секунд после превышения: 2, 4, 8, 16… но не дольше потолка политики.
    const penalty = Math.min(policy.maxBlockMs, 2 ** (bucket.failures - policy.free) * 1000);
    bucket.blockedUntil = now + penalty;
  }
}

export function registerSuccess(key: string): void {
  store().delete(key);
}
