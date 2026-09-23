import { NextResponse } from 'next/server';
import { authError, requireUser } from '@/lib/auth';
import { getQuota } from '@/lib/accounts';
export async function GET(req: Request) { try { const user = await requireUser(req); return NextResponse.json(getQuota(user)); } catch (e) { return authError(e); } }
