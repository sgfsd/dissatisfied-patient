import { NextResponse } from 'next/server';
import { assertOrigin, authError, logout } from '@/lib/auth';
export async function POST(req: Request) { try { assertOrigin(req); await logout(req); return NextResponse.json({ ok: true }); } catch (e) { return authError(e); } }
