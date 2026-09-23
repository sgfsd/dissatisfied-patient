import { NextResponse } from 'next/server';
import { authError, requireTeacher } from '@/lib/auth';
import { teacherStats } from '@/lib/accounts';

/** GET /api/teacher/stats?groupId= — агрегаты по группе для кабинета преподавателя. */
export async function GET(req: Request) {
  try {
    const user = await requireTeacher(req);
    const groupId = new URL(req.url).searchParams.get('groupId');
    return NextResponse.json(teacherStats(user, groupId));
  } catch (e) {
    return authError(e);
  }
}
