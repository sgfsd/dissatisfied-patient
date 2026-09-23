import { AiError } from './ai/errors';
import { errorResponse } from './errors';

/** Единый формат ошибок API: { error: { code, message } } — см. lib/errors.ts. */
export const apiError = errorResponse;

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new AiError('bad_request', 'Тело запроса не является JSON');
  }
}
