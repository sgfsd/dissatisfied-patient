import { NextResponse } from 'next/server';
import { AiError } from './ai/errors';

/** Единый формат ошибок API: { error: { code, message } }. */
export function apiError(e: unknown): NextResponse {
  if (e instanceof AiError) {
    const status =
      e.code === 'rate_limited' ? 429 :
      e.code === 'bad_request' ? 400 :
      e.code === 'refusal' ? 502 :
      e.code === 'timeout' ? 504 : 502;
    return NextResponse.json({ error: { code: e.code, message: e.message } }, { status });
  }
  const msg = e instanceof Error ? e.message : 'Неизвестная ошибка';
  console.error('[api]', msg, e);
  return NextResponse.json({ error: { code: 'unknown', message: 'Внутренняя ошибка сервиса' } }, { status: 500 });
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new AiError('bad_request', 'Тело запроса не является JSON');
  }
}
