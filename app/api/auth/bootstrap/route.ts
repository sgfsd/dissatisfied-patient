import { NextResponse } from 'next/server';
import { authError, issueLogin, readBody, secretMatches, assertOrigin } from '@/lib/auth';
import { errorJson } from '@/lib/errors';
import { ACCOUNT_POLICY, clientKey, registerFailure, registerSuccess, retryAfter } from '@/lib/rateLimit';
import { bootstrapCodeMatches, bootstrapNeeded, clearBootstrapCode } from '@/lib/db';
import { createAccount } from '@/lib/accounts';

export const runtime = 'nodejs';

/**
 * POST /api/auth/bootstrap — создать самый первый аккаунт преподавателя.
 * Принимает либо код запуска, напечатанный сервером в консоль при первом
 * старте, либо ADMIN_PASSWORD из окружения, если он задан.
 */
export async function POST(req: Request) {
  try {
    assertOrigin(req);
    if (!bootstrapNeeded()) return errorJson(409, 'bootstrap_closed');

    const gate = `bootstrap:${clientKey(req)}`;
    const wait = retryAfter(gate);
    if (wait > 0) {
      return errorJson(429, 'too_many_attempts', `Слишком много попыток. Повторите через ${wait} с.`, {
        'Retry-After': String(wait),
      });
    }

    const body = await readBody(req);
    const envSecret = process.env.ADMIN_PASSWORD;
    const ok =
      (envSecret ? secretMatches(body.adminPassword, envSecret) : false) ||
      bootstrapCodeMatches(body.adminPassword);
    if (!ok) {
      registerFailure(gate, ACCOUNT_POLICY);
      return errorJson(401, 'invalid_secret');
    }
    registerSuccess(gate);

    // Сначала аккаунт (он же проверяет логин и пароль), потом гасим код.
    const user = await createAccount(body, 'supervisor');
    clearBootstrapCode();
    await issueLogin(user.id, req);
    return NextResponse.json({ user });
  } catch (e) {
    return authError(e);
  }
}
