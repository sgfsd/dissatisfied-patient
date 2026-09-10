import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';
import { evaluateSession } from '@/lib/session/service';

/** POST /api/sessions/[id]/evaluate — полный разбор диалога, результат сохраняется. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const evaluation = await evaluateSession(id);
    return NextResponse.json({ evaluation });
  } catch (e) {
    return apiError(e);
  }
}
