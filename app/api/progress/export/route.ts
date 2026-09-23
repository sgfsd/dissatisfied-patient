import { authError, requireUser } from '@/lib/auth';
import { buildProgress, progressToCsv } from '@/lib/progress';

/**
 * GET /api/progress/export?format=csv|json — скачать свою историю прогресса.
 * CSV — для журнала и Excel, JSON — для портфолио и переноса.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const format = new URL(req.url).searchParams.get('format') === 'json' ? 'json' : 'csv';
    const dto = buildProgress(user);
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `vera-progress-${user.username}-${stamp}.${format}`;
    const body = format === 'json' ? JSON.stringify(dto, null, 2) : progressToCsv(dto);
    return new Response(body, {
      headers: {
        'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return authError(e);
  }
}
