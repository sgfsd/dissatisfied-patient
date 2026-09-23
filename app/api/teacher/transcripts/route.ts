import { NextResponse } from 'next/server';
import { authError, requireTeacher, textField } from '@/lib/auth';
import { studentSessions } from '@/lib/accounts';
export async function GET(req: Request) {
  try {
    const user = await requireTeacher(req);
    const studentId = textField(new URL(req.url).searchParams.get('studentId'), 'studentId');
    return NextResponse.json({ sessions: studentSessions(user, studentId) });
  } catch (e) { return authError(e); }
}
