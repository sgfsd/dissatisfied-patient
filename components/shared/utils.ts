/* Общие клиентские помощники: типизированный fetch и форматирование. */

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const FRIENDLY: Record<string, string> = {
  bad_request: 'Некорректный запрос',
  not_found: 'Не найдено',
  network: 'Нет связи с сервером тренажёра — проверьте сеть и попробуйте ещё раз',
  provider_unreachable: 'AI-сервис недоступен — попробуйте ещё раз через минуту',
  timeout: 'Сервис отвечает слишком долго — попробуйте ещё раз',
  rate_limited: 'Сервис перегружен — подождите минуту и повторите',
  invalid_json: 'Модель вернула некорректный ответ — попробуйте ещё раз',
  refusal: 'Модель отказалась отвечать — попробуйте иначе сформулировать',
  unknown: 'Что-то пошло не так — попробуйте ещё раз',
};

export function friendlyError(e: unknown): string {
  if (e instanceof ApiError) return e.message || (FRIENDLY[e.code] ?? FRIENDLY.unknown);
  if (e instanceof Error) return e.message;
  return FRIENDLY.unknown;
}

/** Разобрать тело ошибки. Основной формат API — { error: { code, message } }. */
function parseError(body: unknown): { code?: string; message?: string } {
  const error = (body as { error?: unknown; code?: unknown } | null)?.error;
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return {
      code: typeof code === 'string' ? code : undefined,
      message: typeof message === 'string' ? message : undefined,
    };
  }
  // Запасной вариант — плоский { error: "текст", code }.
  const flat = body as { code?: unknown } | null;
  return {
    code: typeof flat?.code === 'string' ? flat.code : undefined,
    message: typeof error === 'string' ? error : undefined,
  };
}

/** Типизированный fetch к API тренажёра: бросает ApiError с кодом и готовым текстом. */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError('network', FRIENDLY.network, 0);
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* пустое тело */ }
  if (!res.ok) {
    const parsed = parseError(body);
    const code = parsed.code ?? 'unknown';
    throw new ApiError(code, parsed.message ?? FRIENDLY[code] ?? FRIENDLY.unknown, res.status);
  }
  return body as T;
}

/**
 * Случайный ключ идемпотентности. crypto.randomUUID есть только в безопасном
 * контексте (HTTPS или localhost), а на кафедре тренажёр открывают по
 * http://<ip-сервера> — там работает лишь crypto.getRandomValues.
 */
export function randomKey(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `сегодня, ${time}`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + `, ${time}`;
}

export function formatShortDate(ts: number): string {
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (d > 1 && d < 5) return few;
  if (d === 1) return one;
  return many;
}
