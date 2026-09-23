import { NextResponse } from 'next/server';
import { authError, readBody, requireTeacher } from '@/lib/auth';
import { createGroup, listGroups } from '@/lib/accounts';
export async function GET(req: Request) { try { return NextResponse.json({ groups: listGroups(await requireTeacher(req)) }); } catch (e) { return authError(e); } }
export async function POST(req: Request) { try { const user = await requireTeacher(req); return NextResponse.json({ group: createGroup(user, (await readBody(req)).name) }, { status: 201 }); } catch (e) { return authError(e); } }
