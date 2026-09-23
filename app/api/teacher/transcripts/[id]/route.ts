import { NextResponse } from 'next/server';
import { authError, requireTeacher } from '@/lib/auth';
import { sessionTranscript } from '@/lib/accounts';
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) { try { return NextResponse.json(sessionTranscript(await requireTeacher(req), (await params).id)); } catch (e) { return authError(e); } }
