import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';
import { history } from '@/lib/session/service';
import { requireUser } from '@/lib/auth';

/** GET /api/history — завершённые прогоны текущего пользователя. */
export async function GET(req: Request) {
  try {
    return NextResponse.json(history(await requireUser(req)));
  } catch (e) {
    return apiError(e);
  }
}
