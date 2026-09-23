import { authError, requireTeacher } from '@/lib/auth';
import { exportGroupCsv } from '@/lib/accounts';

/** GET /api/teacher/export?groupId= — CSV с результатами группы для журнала. */
export async function GET(req: Request) {
  try {
    const user = await requireTeacher(req);
    const groupId = new URL(req.url).searchParams.get('groupId');
    const csv = exportGroupCsv(user, groupId);
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="vera-practice-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return authError(e);
  }
}
