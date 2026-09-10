import { NextResponse } from 'next/server';
import { apiError, readJson } from '@/lib/api-utils';
import { AiError } from '@/lib/ai/errors';
import { probeCredentials } from '@/lib/ai/provider';
import {
  clearProviderSettings,
  config,
  maskKey,
  providerConfigured,
  providerSettingsSource,
  saveProviderSettings,
} from '@/lib/config';

/* Настройки подключения к AI-провайдеру. Ключ хранится на сервере
   (data/settings.json, папка в .gitignore) и в браузер не отдаётся —
   наружу уходит только маска вида «sk-…fz0r». */

export const runtime = 'nodejs';

/** GET /api/settings — настроено ли подключение и какой ключ используется. */
export async function GET() {
  return NextResponse.json({
    configured: providerConfigured(),
    keyHint: maskKey(config.apiKey),
    baseUrl: config.baseUrl,
    source: providerSettingsSource(),
  });
}

/** POST /api/settings — сохранить ключ. body: { apiKey, baseUrl? } */
export async function POST(req: Request) {
  try {
    const body = await readJson<{ apiKey?: unknown; baseUrl?: unknown }>(req);
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const baseUrl = (typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '') || config.baseUrl;

    if (!apiKey) throw new AiError('bad_request', 'Вставьте ключ API');
    if (/\s/.test(apiKey)) throw new AiError('bad_request', 'В ключе есть пробел или перенос строки — скопируйте его заново');
    if (apiKey.length < 12) throw new AiError('bad_request', 'Ключ выглядит обрезанным — скопируйте его целиком');
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new AiError('bad_request', 'Адрес провайдера должен начинаться с http:// или https://');
    }

    /* Проверяем ключ до сохранения: опечатка должна всплыть сразу, а не при
       запуске первой сцены. Отказ провайдера (401/403) — не сохраняем;
       молчание сети — сохраняем, но честно предупреждаем. */
    let verified = false;
    let warning: string | null = null;
    try {
      await probeCredentials(baseUrl, apiKey);
      verified = true;
    } catch (e) {
      if (e instanceof AiError && e.code === 'bad_request') {
        throw new AiError('bad_request', 'Провайдер отклонил ключ. Проверьте, что он скопирован целиком и не истёк.');
      }
      warning = 'Ключ сохранён, но проверить его не удалось: провайдер не ответил. Если сцена не запустится — вернитесь сюда и проверьте адрес и ключ.';
    }

    saveProviderSettings({ apiKey, baseUrl });
    return NextResponse.json({ ok: true, verified, warning, keyHint: maskKey(apiKey), baseUrl });
  } catch (e) {
    return apiError(e);
  }
}

/** DELETE /api/settings — забыть ключ, введённый через интерфейс. */
export async function DELETE() {
  clearProviderSettings();
  return NextResponse.json({ ok: true, configured: providerConfigured() });
}
