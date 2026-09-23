import { NextResponse } from 'next/server';
import { authError, readBody, requireTeacher } from '@/lib/auth';
import { deleteGroup, renameGroup } from '@/lib/accounts';

/** PATCH /api/teacher/groups/[id] — переименовать группу. body: { name } */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTeacher(req);
    renameGroup(user, (await params).id, (await readBody(req)).name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return authError(e);
  }
}

/** DELETE /api/teacher/groups/[id] — удалить пустую группу. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTeacher(req);
    deleteGroup(user, (await params).id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return authError(e);
  }
}
