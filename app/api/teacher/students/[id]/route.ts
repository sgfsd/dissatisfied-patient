import { NextResponse } from 'next/server';
import { authError, readBody, requireTeacher } from '@/lib/auth';
import { resetUsage, updateStudent } from '@/lib/accounts';

/**
 * PATCH /api/teacher/students/[id]
 * body: { disabled?, requestQuota?, password?, displayName?, resetUsage? }
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTeacher(req);
    const id = (await params).id;
    const body = await readBody(req);
    await updateStudent(user, id, body);
    if (body.resetUsage === true) resetUsage(user, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return authError(e);
  }
}
