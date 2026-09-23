import { NextResponse } from 'next/server';
import { authError, requireUser } from '@/lib/auth';
import { publicCatalog } from '@/lib/domains';

/** GET /api/catalog — разделы и кейсы без скрытых карточек (см. lib/domains/catalog.ts). */
export async function GET(req: Request) {
  try {
    await requireUser(req);
    return NextResponse.json({ domains: publicCatalog() });
  } catch (e) {
    return authError(e);
  }
}
