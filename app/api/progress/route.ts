import { NextResponse } from 'next/server';
import { authError, requireUser } from '@/lib/auth';
import { buildProgress } from '@/lib/progress';

/** GET /api/progress — история прогресса текущего студента. Без обращений к AI. */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    return NextResponse.json(buildProgress(user), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return authError(e);
  }
}
