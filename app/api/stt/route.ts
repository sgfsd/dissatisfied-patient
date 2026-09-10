import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';
import { AiError } from '@/lib/ai/errors';
import { transcribe } from '@/lib/speech';

/**
 * POST /api/stt — распознавание речи врача.
 * Тело: сырые байты аудио (webm/opus или mp3). Content-Type указывает формат.
 * Ответ: { text }
 */
export async function POST(req: Request) {
  try {
    const mime = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? 'audio/webm';
    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length) throw new AiError('bad_request', 'Пустая запись');
    const text = await transcribe(buf, mime);
    return NextResponse.json({ text });
  } catch (e) {
    return apiError(e);
  }
}
