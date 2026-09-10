import fs from 'node:fs';
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

/**
 * GET /api/audio/[key] — mp3 из кэша озвучки.
 * key — sha256-хэш (32 hex-символа); путь защищён от подмены.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  if (!/^[a-f0-9]{32}$/.test(key)) {
    return NextResponse.json({ error: { code: 'bad_request', message: 'Некорректный ключ аудио' } }, { status: 400 });
  }
  const file = `${config.ttsCacheDir}/${key}.mp3`;
  if (!fs.existsSync(file)) {
    return NextResponse.json({ error: { code: 'not_found', message: 'Аудио не найдено' } }, { status: 404 });
  }
  const data = fs.readFileSync(file);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(data.length),
    },
  });
}
