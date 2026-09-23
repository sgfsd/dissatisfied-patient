import { NextResponse } from 'next/server';
import { authError, requireTeacher } from '@/lib/auth';
import { deleteAssignment } from '@/lib/accounts';

/** DELETE /api/teacher/assignments/[id] — удалить задание без начатых попыток. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTeacher(req);
    deleteAssignment(user, (await params).id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return authError(e);
  }
}
