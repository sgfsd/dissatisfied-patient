import { NextResponse } from 'next/server';
import { AuthError, authError, readBody, requireTeacher } from '@/lib/auth';
import { setMembership } from '@/lib/accounts';
export async function POST(req: Request) { try { const user = await requireTeacher(req); const body = await readBody(req); if (typeof body.groupId !== 'string' || typeof body.studentId !== 'string' || typeof body.add !== 'boolean') throw new AuthError(400, 'invalid_membership'); setMembership(user, body.groupId, body.studentId, body.add); return NextResponse.json({ ok: true }); } catch (e) { return authError(e); } }
