import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import { getDb, getSession, type SessionRow } from './db';
import { AuthError, errorResponse } from './errors';

export { AuthError };
/** Ответ-ошибка в едином формате API; понимает AuthError, AiError и прочие. */
export const authError = errorResponse;

const scrypt = promisify(nodeScrypt);
const COOKIE = 'vera_account';
const MAX_AGE = 7 * 24 * 60 * 60;
export type AccountUser = { id: string; role: 'trainee' | 'supervisor'; displayName: string | null; username: string; disabled: number; requestQuota: number };
/** Хост, к которому реально подключился браузер (с учётом обратного прокси). */
function requestHost(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  return forwarded || req.headers.get('host');
}

/**
 * Защита от межсайтовых запросов.
 *
 * Сравнивать Origin с `new URL(req.url).origin` нельзя: в собранном Next
 * `req.url` всегда localhost, каким бы адресом ни пользовался браузер.
 * На кафедре сервис открывают по http://<ip-сервера>:3000 — при сравнении
 * с req.url любой POST от студента отлетал бы с 403. Правильный ориентир —
 * заголовок Host: именно к нему браузер и подключился.
 */
export function assertOrigin(req: Request): void {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') throw new AuthError(403, 'invalid_origin');

  const origin = req.headers.get('origin');
  if (!origin) {
    // Современные браузеры всегда шлют Origin на небезопасных методах.
    // Пропускаем только явное подтверждение same-origin от самого браузера.
    if (site === 'same-origin') return;
    throw new AuthError(403, 'invalid_origin');
  }

  const host = requestHost(req);
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AuthError(403, 'invalid_origin');
  }
  if (!host || originHost !== host) throw new AuthError(403, 'invalid_origin');
}
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new AuthError(415, 'json_required');
  if (Number(req.headers.get('content-length')) > 16384) throw new AuthError(413, 'body_too_large');
  const text = await req.text();
  if (Buffer.byteLength(text) > 16384) throw new AuthError(413, 'body_too_large');
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new AuthError(400, 'invalid_json'); }
}
export function textField(value: unknown, name: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AuthError(400, `invalid_${name}`);
  return value.trim();
}
export async function hashPassword(password: unknown): Promise<string> {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new AuthError(400, 'password_length_12_256');
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: unknown, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [algorithm, salt, hex] = stored.split(':');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(hex ?? '')) return false;
  const key = await scrypt(password, salt, 64) as Buffer;
  return timingSafeEqual(key, Buffer.from(hex, 'hex'));
}
export function secretMatches(value: unknown, secret: string): boolean {
  return typeof value === 'string' && timingSafeEqual(createHash('sha256').update(value).digest(), createHash('sha256').update(secret).digest());
}
export const USER_SELECT = `SELECT u.id, u.role, u.display_name AS displayName, a.username, a.disabled, a.request_quota AS requestQuota FROM users u JOIN accounts a ON a.user_id = u.id`;
export function activeUser(id: string): AccountUser {
  const user = getDb().prepare(`${USER_SELECT} WHERE u.id = ?`).get(id) as AccountUser | undefined;
  if (!user || user.disabled || !['trainee', 'supervisor'].includes(user.role)) throw new AuthError(401, 'unauthorized');
  return user;
}
export async function requireUser(req?: Request): Promise<AccountUser> {
  if (req && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) assertOrigin(req);
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new AuthError(401, 'unauthorized');
  const row = getDb().prepare('SELECT user_id FROM auth_tokens WHERE token_hash = ? AND expires_at > ?')
    .get(createHash('sha256').update(token).digest('hex'), Date.now()) as { user_id: string } | undefined;
  if (!row) throw new AuthError(401, 'unauthorized');
  return activeUser(row.user_id);
}
export async function requireTeacher(req?: Request): Promise<AccountUser> {
  const user = await requireUser(req);
  if (user.role !== 'supervisor') throw new AuthError(403, 'teacher_required');
  return user;
}
export function authorizeSession(user: AccountUser, id: string, write = false): SessionRow {
  user = activeUser(user.id);
  const session = getSession(id);
  if (!session) throw new AuthError(404, 'session_not_found');
  if (session.user_id === user.id) return session;
  if (!write && user.role === 'supervisor' && getDb().prepare(`SELECT 1 FROM group_memberships m JOIN account_groups g ON g.id = m.group_id WHERE g.teacher_id = ? AND m.student_id = ?`).get(user.id, session.user_id)) return session;
  throw new AuthError(404, 'session_not_found');
}
/**
 * Флаг Secure ставится по фактическому протоколу запроса, а не по NODE_ENV.
 * Собранный прод на кафедре открывают по http://<ip-сервера>:3000 — при
 * безусловном Secure браузер молча выбрасывал бы cookie, и войти не смог бы
 * никто. По HTTPS (в том числе за обратным прокси) флаг ставится как прежде;
 * FORCE_SECURE_COOKIE=1 включает его принудительно.
 */
function cookieSecure(req?: Request): boolean {
  if (process.env.FORCE_SECURE_COOKIE === '1') return true;
  if (!req) return false;
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto) return proto === 'https';
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}
export async function issueLogin(userId: string, req?: Request): Promise<void> {
  activeUser(userId);
  const token = randomBytes(32).toString('hex');
  const db = getDb();
  db.prepare('DELETE FROM auth_tokens WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO auth_tokens VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), userId, Date.now() + MAX_AGE * 1000);
  (await cookies()).set(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: cookieSecure(req), path: '/', maxAge: MAX_AGE });
}
export async function logout(req?: Request): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) getDb().prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(createHash('sha256').update(token).digest('hex'));
  jar.set(COOKIE, '', { httpOnly: true, sameSite: 'strict', secure: cookieSecure(req), path: '/', maxAge: 0 });
}
