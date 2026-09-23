import { NextResponse } from "next/server";
import { authError, readBody, requireUser, requireTeacher } from "@/lib/auth";
import { createAssignment, listAssignments } from "@/lib/accounts";
export async function GET(req: Request) {
  try {
    return NextResponse.json({
      assignments: listAssignments(await requireUser(req)),
    });
  } catch (e) {
    return authError(e);
  }
}
export async function POST(req: Request) {
  try {
    const user = await requireTeacher(req);
    const body = await readBody(req);
    return NextResponse.json(
      {
        assignment: createAssignment(
          user,
          typeof body.groupId === "string" ? body.groupId : "",
          body.title,
          body.cases,
        ),
      },
      { status: 201 },
    );
  } catch (e) {
    return authError(e);
  }
}
