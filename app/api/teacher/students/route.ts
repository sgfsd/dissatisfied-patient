import { NextResponse } from 'next/server';
import { authError, readBody, requireTeacher } from '@/lib/auth';
import { createAccount, listStudents } from '@/lib/accounts';
export async function GET(req: Request) { try { return NextResponse.json({ students: listStudents(await requireTeacher(req), new URL(req.url).searchParams.get('groupId') ?? undefined) }); } catch (e) { return authError(e); } }
export async function POST(req: Request) { try { const user = await requireTeacher(req); const body = await readBody(req); return NextResponse.json({ student: await createAccount(body, 'trainee', typeof body.groupId === 'string' ? body.groupId : undefined, user) }, { status: 201 }); } catch (e) { return authError(e); } }
