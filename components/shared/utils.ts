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
  provider_unreachable: 'Сервис озвучки недоступен — проверьте сеть и попробуйте ещё раз',
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

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError('provider_unreachable', FRIENDLY.provider_unreachable, 0);
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* пустое тело */ }
  if (!res.ok) {
    const code = (body as { error?: { code?: string; message?: string } })?.error?.code ?? 'unknown';
    const message = (body as { error?: { message?: string } })?.error?.message ?? FRIENDLY[code] ?? FRIENDLY.unknown;
    throw new ApiError(code, message, res.status);
  }
  return body as T;
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
