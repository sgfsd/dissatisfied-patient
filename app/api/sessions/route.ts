import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';
import { startSession } from '@/lib/session/service';
import { AuthError, readBody, requireUser } from '@/lib/auth';
import type { StartInput } from '@/lib/session/service';

/**
 * POST /api/sessions — создать новую сцену.
 * body: { domain?, caseId?, category?, mode?: 'practice'|'exam', format?: 'short'|'long', assignmentId? }
 * Без domain и caseId сцена выбирается случайно с антиповтором.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = await readBody(req);
    for (const name of ['domain', 'category', 'caseId', 'assignmentId', 'mode', 'format']) {
      if (body[name] != null && (typeof body[name] !== 'string' || (body[name] as string).length > 120)) throw new AuthError(400, `invalid_${name}`);
    }
    const session = await startSession(user, body as StartInput);
    return NextResponse.json({ session });
  } catch (e) {
    return apiError(e);
  }
}
