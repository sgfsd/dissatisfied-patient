import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';
import { resumeSession } from '@/lib/session/service';

/** GET /api/sessions/[id] — состояние сессии для продолжения/просмотра. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return NextResponse.json(resumeSession(id));
  } catch (e) {
    return apiError(e);
  }
}
