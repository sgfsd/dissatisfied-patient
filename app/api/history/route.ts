import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';
import { history } from '@/lib/session/service';

/** GET /api/history — завершённые прогоны текущего пользователя. */
export async function GET() {
  try {
    return NextResponse.json(history());
  } catch (e) {
    return apiError(e);
  }
}
