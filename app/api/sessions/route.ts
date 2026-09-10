import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';
import { startSession } from '@/lib/session/service';

/** POST /api/sessions — создать новую сцену. body: { domain?, category? } */
export async function POST(req: Request) {
  try {
    let domain: string | null = null;
    let category: string | null = null;
    try {
      const body = await req.json();
      domain = typeof body?.domain === 'string' ? body.domain : null;
      category = typeof body?.category === 'string' ? body.category : null;
    } catch { /* без тела — случайная сцена */ }
    const session = await startSession(domain, category);
    return NextResponse.json({ session });
  } catch (e) {
    return apiError(e);
  }
}
