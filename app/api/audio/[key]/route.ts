import fs from 'node:fs';
import { authError, requireUser } from '@/lib/auth';
import { errorJson } from '@/lib/errors';
import { ttsCachePath } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * GET /api/audio/[key] — mp3 из кэша озвучки.
 * key — sha256-хэш (32 hex-символа); путь защищён от подмены.
 *
 * Требует входа: это реплики пациента из учебных сессий, отдавать их
 * анонимно незачем. Кэш браузера помечен private по той же причине.
 * Поддерживает Range: Safari без частичных ответов медиа не проигрывает.
 */
export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  try {
    await requireUser(req);
  } catch (e) {
    return authError(e);
  }
  const { key } = await ctx.params;
  if (!/^[a-f0-9]{32}$/.test(key)) return errorJson(400, 'bad_request', 'Некорректный ключ аудио');
  const file = ttsCachePath(key);
  if (!fs.existsSync(file)) return errorJson(404, 'not_found', 'Аудио не найдено');

  const data = fs.readFileSync(file);
  const headers: Record<string, string> = {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
  if (range && (range[1] || range[2])) {
    const size = data.length;
    // «bytes=-500» — последние 500 байт; «bytes=100-» — от 100 до конца.
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    }
    const chunk = data.subarray(start, end + 1);
    return new Response(new Uint8Array(chunk), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(chunk.length) },
    });
  }

  return new Response(new Uint8Array(data), {
    headers: { ...headers, 'Content-Length': String(data.length) },
  });
}
