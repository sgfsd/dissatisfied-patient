import { NextResponse } from 'next/server';
import { apiError, readJson } from '@/lib/api-utils';
import { continueSession } from '@/lib/session/service';

/**
 * POST /api/sessions/[id]/turn
 * body: { doctorText: string, source: 'stt' | 'typed' }
 * Ответ: PatientTurnOutcome | { kind: 'eval_ready' }
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await readJson<{ doctorText?: string; source?: string }>(req);
    const doctorText = typeof body.doctorText === 'string' ? body.doctorText : '';
    const source = body.source === 'typed' ? 'typed' : body.source === 'stt' ? 'stt' : 'typed';
    const outcome = await continueSession(id, doctorText, source);
    return NextResponse.json({ outcome });
  } catch (e) {
    return apiError(e);
  }
}
