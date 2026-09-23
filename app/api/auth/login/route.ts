import { NextResponse } from 'next/server';
import {
  activeUser,
  authError,
  assertOrigin,
  issueLogin,
  readBody,
  verifyPassword,
  AuthError,
} from '@/lib/auth';
import {
  ACCOUNT_POLICY,
  ADDRESS_POLICY,
  clientKey,
  registerFailure,
  registerSuccess,
  retryAfter,
} from '@/lib/rateLimit';
import { getDb } from '@/lib/db';
import { errorJson } from '@/lib/errors';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    assertOrigin(req);
    const body = await readBody(req);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';

    /* Считаем попытки и по логину, и по адресу: первое защищает конкретный
       аккаунт от подбора пароля, второе — от перебора логинов с одной машины.
       Политики разные: см. комментарий в lib/rateLimit.ts. */
    const accountKey = `user:${username}`;
    const addressKey = `ip:${clientKey(req)}`;
    const keys = [accountKey, addressKey];
    const wait = Math.max(retryAfter(accountKey), retryAfter(addressKey));
    if (wait > 0) {
      return errorJson(429, 'too_many_attempts', `Слишком много попыток входа. Повторите через ${wait} с.`, {
        'Retry-After': String(wait),
      });
    }

    const row = getDb()
      .prepare(
        'SELECT user_id AS id, password_hash AS passwordHash, disabled FROM accounts WHERE username = ?',
      )
      .get(username) as { passwordHash: string; id: string; disabled: number } | undefined;

    if (!row || row.disabled || !(await verifyPassword(body.password, row.passwordHash))) {
      registerFailure(accountKey, ACCOUNT_POLICY);
      registerFailure(addressKey, ADDRESS_POLICY);
      throw new AuthError(401, 'invalid_credentials');
    }

    for (const key of keys) registerSuccess(key);
    await issueLogin(row.id, req);
    return NextResponse.json({ user: activeUser(row.id) });
  } catch (e) {
    return authError(e);
  }
}
