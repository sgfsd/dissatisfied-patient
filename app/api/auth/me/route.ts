import { NextResponse } from 'next/server';
import { authError, requireUser } from '@/lib/auth';
export async function GET(req: Request) { try { return NextResponse.json({ user: await requireUser(req) }); } catch (e) { return authError(e); } }
