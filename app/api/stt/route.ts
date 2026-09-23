import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';
import { AiError } from '@/lib/ai/errors';
import { transcribe } from '@/lib/speech';
import { AuthError, requireUser } from '@/lib/auth';
import { reserveRequest } from '@/lib/accounts';
import { getProvider } from '@/lib/ai/provider';

export const runtime = 'nodejs';

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const AUDIO_TYPES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
]);

/**
 * POST /api/stt — распознавание речи врача.
 * Тело: сырые байты аудио (webm/opus, ogg, mp4, mp3 или wav); формат — в Content-Type.
 * Заголовок Idempotency-Key обязателен: повтор с тем же ключом не списывает лимит дважды.
 * Ответ: { text }
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const requestKey = req.headers.get('idempotency-key');
    if (!requestKey) throw new AiError('bad_request', 'Требуется заголовок Idempotency-Key');
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestKey)) throw new AiError('bad_request', 'Некорректный Idempotency-Key');
    const contentLength = Number(req.headers.get('content-length') || 0);
    if (contentLength > MAX_AUDIO_BYTES) throw new AiError('bad_request', 'Запись слишком большая');
    const mime = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? 'audio/webm';
    if (!AUDIO_TYPES.has(mime)) throw new AiError('bad_request', 'Неподдерживаемый формат аудио');
    // Тело читаем до списания лимита: пустая или огромная запись не должна стоить попытки.
    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length) throw new AiError('bad_request', 'Пустая запись');
    if (buf.length > MAX_AUDIO_BYTES) throw new AiError('bad_request', 'Запись слишком большая');
    getProvider(); // ключ задан? Иначе лимит списался бы без обращения к провайдеру
    if (!reserveRequest(user, 'stt', requestKey)) throw new AuthError(409, 'duplicate_request');
    const text = await transcribe(buf, mime);
    return NextResponse.json({ text });
  } catch (e) {
    return apiError(e);
  }
}
