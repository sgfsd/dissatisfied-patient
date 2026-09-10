import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config';
import { getProvider } from './ai/provider';
import { AiError } from './ai/errors';

/* Озвучка (TTS) и распознавание (STT) — тонкие сервисы поверх провайдера.
   TTS кэшируется на диск по хэшу текста+голоса+модели+инструкции, чтобы
   не жечь лимиты и не платить повторно за одинаковые реплики. */

export interface SpeechOpts {
  voice: string;
  model?: string;
  /** Короткая инструкция «актёрской игры» (тембр, эмоция) — если провайдер умеет. */
  instructions?: string;
}

export function speechCacheKey(text: string, opts: SpeechOpts): string {
  const { voice, model, instructions } = opts;
  const base = `${model ?? config.ttsModel}|${voice}|${instructions ?? ''}|${text}`;
  return crypto.createHash('sha256').update(base).digest('hex').slice(0, 32);
}

/** Гарантирует наличие mp3 в кэше; возвращает ключ файла. */
export async function ensureSpeech(text: string, opts: SpeechOpts): Promise<string> {
  const m = opts.model ?? config.ttsModel;
  const key = speechCacheKey(text, { ...opts, model: m });
  const file = `${config.ttsCacheDir}/${key}.mp3`;
  if (fs.existsSync(file)) return key;
  const buf = await getProvider().tts({
    model: m,
    text,
    voice: opts.voice,
    ...(opts.instructions ? { instructions: opts.instructions } : {}),
  });
  fs.writeFileSync(file, buf);
  return key;
}

/** Прогнать mp3 через распознавание и вернуть текст. */
export async function transcribe(audio: Buffer, mime: string): Promise<string> {
  if (!audio.length) throw new AiError('bad_request', 'Пустая аудиозапись');
  return getProvider().stt({ audio, mime, language: 'ru' });
}

export function audioUrlForKey(key: string): string {
  return `/api/audio/${key}`;
}

/** Проверить наличие файла озвучки (для resume-режима). */
export function hasSpeech(key: string): boolean {
  return fs.existsSync(`${config.ttsCacheDir}/${key}.mp3`);
}
