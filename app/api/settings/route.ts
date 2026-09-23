import { NextResponse } from 'next/server';
import { apiError, readJson } from '@/lib/api-utils';
import { AiError } from '@/lib/ai/errors';
import { authError, requireTeacher } from '@/lib/auth';
import { probeCredentials } from '@/lib/ai/provider';
import {
  clearProviderSettings,
  config,
  maskKey,
  providerConfigured,
  providerSettingsSource,
  saveProviderSettings,
  validateProviderUrl,
} from '@/lib/config';

/* Настройки подключения к AI-провайдеру. Ключ хранится только на этом
   компьютере (data/settings.json, зашифрован под учётную запись Windows)
   и в браузер не отдаётся — наружу уходит только маска вида «sk-…abcd». */

export const runtime = 'nodejs';

/**
 * GET /api/settings — настроено ли подключение и какой ключ используется.
 * source: saved — введён при установке или в кабинете; env — из окружения (разработка).
 * encrypted — ключ на диске зашифрован (DPAPI).
 */
export async function GET(req: Request) {
  try {
    await requireTeacher(req);
    const { source, protection } = providerSettingsSource();
    return NextResponse.json({
      configured: providerConfigured(),
      keyHint: maskKey(config.apiKey),
      baseUrl: config.baseUrl,
      source,
      encrypted: protection === 'dpapi-user',
    });
  } catch (e) { return authError(e); }
}

/** POST /api/settings — сохранить ключ. body: { apiKey, baseUrl? } */
export async function POST(req: Request) {
  try {
    await requireTeacher(req);
    const body = await readJson<{ apiKey?: unknown; baseUrl?: unknown }>(req);
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    let baseUrl: string;
    try {
      baseUrl = validateProviderUrl((typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '') || config.baseUrl);
    } catch (e) {
      throw new AiError('bad_request', e instanceof Error ? e.message : 'Некорректный адрес провайдера');
    }

    if (!apiKey) throw new AiError('bad_request', 'Вставьте ключ API');
    if (/\s/.test(apiKey)) throw new AiError('bad_request', 'В ключе есть пробел или перенос строки — скопируйте его заново');
    if (apiKey.length < 12) throw new AiError('bad_request', 'Ключ выглядит обрезанным — скопируйте его целиком');
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

/** DELETE /api/settings — забыть сохранённый ключ (окружение и .env не трогаются). */
export async function DELETE(req: Request) {
  try {
    await requireTeacher(req);
    clearProviderSettings();
    return NextResponse.json({ ok: true, configured: providerConfigured() });
  } catch (e) { return authError(e); }
}
