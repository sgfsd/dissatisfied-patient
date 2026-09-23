import { randomUUID } from "node:crypto";
import {
  getDb,
  getScenario,
  groupCriterionStats,
  groupDomainStats,
  groupOverview,
  groupStudentStats,
  listMessages,
  teacherSessions,
} from "./db";
import {
  activeUser,
  AuthError,
  authorizeSession,
  hashPassword,
  textField,
  USER_SELECT,
  type AccountUser,
} from "./auth";
import { domainByKey } from "./domains";
import { config } from "./config";
import { evaluationDTO } from "./session/evaluationDto";

function teacher(user: AccountUser): AccountUser {
  const current = activeUser(user.id);
  if (current.role !== "supervisor")
    throw new AuthError(403, "teacher_required");
  return current;
}
export function requireGroup(user: AccountUser, groupId: string): void {
  teacher(user);
  if (
    !getDb()
      .prepare("SELECT 1 FROM account_groups WHERE id = ? AND teacher_id = ?")
      .get(groupId, user.id)
  )
    throw new AuthError(404, "group_not_found");
}
export function requireStudent(user: AccountUser, studentId: string): void {
  teacher(user);
  if (
    !getDb()
      .prepare(
        `SELECT 1 FROM group_memberships m JOIN account_groups g ON g.id = m.group_id JOIN users u ON u.id = m.student_id WHERE g.teacher_id = ? AND m.student_id = ? AND u.role = 'trainee'`,
      )
      .get(user.id, studentId)
  )
    throw new AuthError(404, "student_not_found");
}
export function quotaValue(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 1000000
  )
    throw new AuthError(400, "invalid_quota");
  return value;
}
export async function createAccount(
  input: Record<string, unknown>,
  role: "trainee" | "supervisor",
  groupId?: string,
  owner?: AccountUser,
): Promise<AccountUser> {
  const username = textField(input.username, "username", 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username))
    throw new AuthError(400, "invalid_username");
  const displayName = textField(input.displayName, "displayName");
  const hash = await hashPassword(input.password);
  const id = randomUUID();
  const db = getDb();
  db.transaction(() => {
    if (role === "supervisor") {
      if (
        db
          .prepare("SELECT 1 FROM users WHERE role IN ('supervisor','admin')")
          .get()
      )
        throw new AuthError(409, "bootstrap_closed");
    } else {
      if (!owner || !groupId) throw new AuthError(403, "teacher_required");
      requireGroup(owner, groupId);
    }
    if (db.prepare("SELECT 1 FROM accounts WHERE username = ?").get(username))
      throw new AuthError(409, "username_taken");
    db.prepare(
      "INSERT INTO users (id, role, display_name, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, role, displayName, Date.now());
    db.prepare(
      "INSERT INTO accounts (user_id, username, password_hash, request_quota) VALUES (?, ?, ?, ?)",
    ).run(id, username, hash, role === "supervisor" ? 100000 : config.defaultRequestQuota);
    if (groupId)
      db.prepare("INSERT INTO group_memberships VALUES (?, ?)").run(
        groupId,
        id,
      );
  }).immediate();
  return activeUser(id);
}
export function listGroups(user: AccountUser) {
  teacher(user);
  return getDb()
    .prepare(
      "SELECT id, name, created_at AS createdAt FROM account_groups WHERE teacher_id = ? ORDER BY created_at DESC",
    )
    .all(user.id);
}
export function createGroup(user: AccountUser, name: unknown) {
  teacher(user);
  const group = {
    id: randomUUID(),
    name: textField(name, "name"),
    createdAt: Date.now(),
  };
  getDb()
    .prepare("INSERT INTO account_groups VALUES (?, ?, ?, ?)")
    .run(group.id, user.id, group.name, group.createdAt);
  return group;
}
export function listStudents(user: AccountUser, groupId?: string) {
  teacher(user);
  if (groupId) requireGroup(user, groupId);
  return getDb()
    .prepare(
      `${USER_SELECT} WHERE u.role = 'trainee' AND EXISTS (SELECT 1 FROM group_memberships m JOIN account_groups g ON g.id = m.group_id WHERE m.student_id = u.id AND g.teacher_id = ? ${groupId ? "AND g.id = ?" : ""}) ORDER BY a.username`,
    )
    .all(...(groupId ? [user.id, groupId] : [user.id]));
}
export function setMembership(
  user: AccountUser,
  groupId: string,
  studentId: string,
  add: boolean,
): void {
  getDb()
    .transaction(() => {
      requireGroup(user, groupId);
      requireStudent(user, studentId);
      getDb()
        .prepare(
          add
            ? "INSERT OR IGNORE INTO group_memberships VALUES (?, ?)"
            : "DELETE FROM group_memberships WHERE group_id = ? AND student_id = ?",
        )
        .run(groupId, studentId);
    })
    .immediate();
}
export async function updateStudent(
  user: AccountUser,
  studentId: string,
  input: Record<string, unknown>,
): Promise<void> {
  /* Хеширование пароля асинхронное, а транзакция better-sqlite3 —
     синхронная, поэтому хеш считаем до входа в транзакцию. */
  const passwordHash =
    input.password !== undefined ? await hashPassword(input.password) : null;
  const displayName =
    input.displayName !== undefined ? textField(input.displayName, "displayName") : null;

  getDb()
    .transaction(() => {
      requireStudent(user, studentId);
      const db = getDb();
      if (input.disabled !== undefined) {
        if (typeof input.disabled !== "boolean")
          throw new AuthError(400, "invalid_disabled");
        db.prepare("UPDATE accounts SET disabled = ? WHERE user_id = ?").run(
          Number(input.disabled),
          studentId,
        );
        // Отключение должно действовать сразу: гасим активные сессии входа.
        if (input.disabled)
          db.prepare("DELETE FROM auth_tokens WHERE user_id = ?").run(studentId);
      }
      if (input.requestQuota !== undefined)
        db.prepare("UPDATE accounts SET request_quota = ? WHERE user_id = ?").run(
          quotaValue(input.requestQuota),
          studentId,
        );
      if (passwordHash) {
        db.prepare("UPDATE accounts SET password_hash = ? WHERE user_id = ?").run(
          passwordHash,
          studentId,
        );
        // Смена пароля разлогинивает везде — иначе старый доступ остаётся жив.
        db.prepare("DELETE FROM auth_tokens WHERE user_id = ?").run(studentId);
      }
      if (displayName)
        db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(displayName, studentId);
    })
    .immediate();
}

/** Сбросить израсходованный лимит студента, не меняя его величину. */
export function resetUsage(user: AccountUser, studentId: string): void {
  requireStudent(user, studentId);
  getDb().prepare("DELETE FROM request_ledger WHERE user_id = ?").run(studentId);
}

export function renameGroup(user: AccountUser, groupId: string, name: unknown): void {
  const next = textField(name, "name");
  getDb()
    .transaction(() => {
      requireGroup(user, groupId);
      getDb().prepare("UPDATE account_groups SET name = ? WHERE id = ?").run(next, groupId);
    })
    .immediate();
}

/**
 * Удалить группу. Только пустую: за студентами и заданиями стоят сессии и
 * попытки, и каскадное удаление уничтожило бы историю оценок.
 */
export function deleteGroup(user: AccountUser, groupId: string): void {
  getDb()
    .transaction(() => {
      requireGroup(user, groupId);
      const db = getDb();
      const { n: students } = db
        .prepare("SELECT COUNT(*) AS n FROM group_memberships WHERE group_id = ?")
        .get(groupId) as { n: number };
      if (students) throw new AuthError(409, "group_not_empty");
      const { n: assignments } = db
        .prepare("SELECT COUNT(*) AS n FROM assignments WHERE group_id = ?")
        .get(groupId) as { n: number };
      if (assignments) throw new AuthError(409, "group_has_assignments");
      db.prepare("DELETE FROM account_groups WHERE id = ?").run(groupId);
    })
    .immediate();
}

/** Удалить задание. Уже начатые попытки блокируют удаление: это оценки. */
export function deleteAssignment(user: AccountUser, assignmentId: string): void {
  getDb()
    .transaction(() => {
      const db = getDb();
      const row = db
        .prepare(
          `SELECT a.group_id AS groupId FROM assignments a
           JOIN account_groups g ON g.id = a.group_id
           WHERE a.id = ? AND g.teacher_id = ?`,
        )
        .get(assignmentId, user.id) as { groupId: string } | undefined;
      teacher(user);
      if (!row) throw new AuthError(404, "assignment_not_found");
      // Попытки старого формата (assignment_attempts) тоже держат задание:
      // без этой проверки DELETE падал бы на внешнем ключе с ошибкой 500.
      const { n } = db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM catalog_assignment_attempts WHERE assignment_id = @id)
                + (SELECT COUNT(*) FROM assignment_attempts WHERE assignment_id = @id) AS n`,
        )
        .get({ id: assignmentId }) as { n: number };
      if (n) throw new AuthError(409, "assignment_has_attempts");
      db.prepare("DELETE FROM catalog_assignment_cases WHERE assignment_id = ?").run(assignmentId);
      db.prepare("DELETE FROM assignment_cases WHERE assignment_id = ?").run(assignmentId);
      db.prepare("DELETE FROM assignments WHERE id = ?").run(assignmentId);
    })
    .immediate();
}

/** Выгрузка результатов группы для журнала: CSV с разделителем «;». */
export function exportGroupCsv(user: AccountUser, groupId?: string | null): string {
  teacher(user);
  if (groupId) requireGroup(user, groupId);
  const students = new Map(
    (
      listStudents(user, groupId ?? undefined) as Array<{
        id: string;
        displayName: string | null;
        username: string;
      }>
    ).map((student) => [student.id, student]),
  );
  const rows = teacherSessions(user.id, { groupId: groupId ?? null, limit: 5000 });
  const header = [
    "Студент",
    "Логин",
    "Дата",
    "Раздел",
    "Кейс",
    "Режим",
    "Формат",
    "Статус",
    "Балл",
    "Максимум",
    "Процент",
    "Флаг безопасности",
  ];
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = rows.map((row) => {
    const student = students.get(row.studentId ?? "");
    const percent =
      row.maxScore && row.totalScore !== null ? Math.round((row.totalScore / row.maxScore) * 100) : "";
    return [
      student?.displayName ?? "",
      student?.username ?? "",
      new Date(row.createdAt).toLocaleString("ru-RU"),
      row.domain,
      row.category,
      row.mode === "exam" ? "экзамен" : "практика",
      row.format === "long" ? "полный приём" : "короткая сцена",
      row.status,
      row.totalScore ?? "",
      row.maxScore ?? "",
      percent,
      row.safetyFlag ?? "",
    ]
      .map(escape)
      .join(";");
  });
  // BOM — чтобы Excel открыл UTF-8 без «кракозябр».
  return `﻿${[header.join(";"), ...lines].join("\r\n")}\r\n`;
}
/**
 * Виды платных обращений к провайдеру. Каждое списывается из лимита студента,
 * поэтому расход виден по kind: сколько ушло на сцены, реплики, распознавание
 * речи и разборы.
 */
export const REQUEST_KINDS = {
  scenario: 'Генерация сцены',
  turn: 'Реплика собеседника',
  stt: 'Распознавание речи',
  evaluation: 'Разбор супервизора',
} as const;
export type RequestKind = keyof typeof REQUEST_KINDS;

/** Atomic, lifetime quota reservation. false means this request key already exists; do not execute it again. Failed provider calls still consume quota. */
export function reserveRequest(
  user: AccountUser,
  kind: RequestKind | string,
  requestKey: string,
): boolean {
  kind = textField(kind, "kind", 64);
  requestKey = textField(requestKey, "requestKey", 128);
  return getDb()
    .transaction(() => {
      const current = activeUser(user.id);
      const db = getDb();
      if (
        db
          .prepare(
            "SELECT 1 FROM request_ledger WHERE user_id = ? AND kind = ? AND request_key = ?",
          )
          .get(user.id, kind, requestKey)
      )
        return false;
      const { n } = db
        .prepare("SELECT COUNT(*) AS n FROM request_ledger WHERE user_id = ?")
        .get(user.id) as { n: number };
      if (n >= current.requestQuota) throw new AuthError(429, "quota_exceeded");
      db.prepare("INSERT INTO request_ledger VALUES (?, ?, ?, ?, ?)").run(
        randomUUID(),
        user.id,
        kind,
        requestKey,
        Date.now(),
      );
      return true;
    })
    .immediate();
}
/** Сколько раз пользователь уже обращался за этим видом по данному объекту. */
export function countRequests(user: AccountUser, kind: RequestKind | string, keyPrefix: string): number {
  const { n } = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM request_ledger WHERE user_id = ? AND kind = ? AND (request_key = ? OR request_key LIKE ?)",
    )
    .get(user.id, kind, keyPrefix, `${keyPrefix}#%`) as { n: number };
  return n;
}

export function getQuota(user: AccountUser) {
  const current = activeUser(user.id);
  const db = getDb();
  const { used } = db
    .prepare("SELECT COUNT(*) AS used FROM request_ledger WHERE user_id = ?")
    .get(user.id) as { used: number };
  const rows = db
    .prepare(
      "SELECT kind, COUNT(*) AS n FROM request_ledger WHERE user_id = ? GROUP BY kind ORDER BY n DESC",
    )
    .all(user.id) as { kind: string; n: number }[];
  return {
    limit: current.requestQuota,
    used,
    remaining: Math.max(0, current.requestQuota - used),
    byKind: rows.map((row) => ({
      kind: row.kind,
      label: REQUEST_KINDS[row.kind as RequestKind] ?? row.kind,
      count: row.n,
    })),
  };
}
export function studentSessions(user: AccountUser, studentId: string) {
  requireStudent(user, studentId);
  return teacherSessions(user.id, { studentId, limit: 200 });
}
/** Агрегаты по группе: где проседает группа и кто требует внимания. */
export function teacherStats(user: AccountUser, groupId?: string | null) {
  teacher(user);
  if (groupId) requireGroup(user, groupId);
  const students = listStudents(user, groupId ?? undefined) as Array<{
    id: string;
    displayName: string | null;
    username: string;
  }>;
  const byId = new Map(students.map((student) => [student.id, student]));
  return {
    overview: groupOverview(user.id, groupId ?? null),
    criteria: groupCriterionStats(user.id, groupId ?? null),
    domains: groupDomainStats(user.id, groupId ?? null),
    students: groupStudentStats(user.id, groupId ?? null).map((row) => ({
      ...row,
      displayName: byId.get(row.studentId)?.displayName ?? null,
      username: byId.get(row.studentId)?.username ?? null,
    })),
    sessions: teacherSessions(user.id, { groupId: groupId ?? null, limit: 60 }).map((row) => ({
      ...row,
      student: byId.get(row.studentId ?? '')?.displayName ?? null,
    })),
  };
}
export function sessionTranscript(user: AccountUser, sessionId: string) {
  teacher(user);
  const session = authorizeSession(user, sessionId, false);
  const scenario = getScenario(session.scenario_id);
  return {
    session: {
      id: session.id,
      mode: session.mode,
      format: session.format,
      status: session.status,
      createdAt: session.created_at,
      exchangesDone: session.exchanges_done,
      studentId: session.user_id,
      domain: scenario?.domain ?? '',
      category: scenario?.category ?? '',
      patientFirst: scenario?.patient_first ?? '',
    },
    messages: listMessages(sessionId).map((message) => ({
      speaker: message.speaker,
      text: message.text,
      emotion: message.emotion,
      idx: message.idx,
    })),
    evaluation: evaluationDTO(sessionId),
  };
}
export function createAssignment(
  user: AccountUser,
  groupId: string,
  title: unknown,
  casesInput: unknown,
) {
  const name = textField(title, "title");
  const cases = Array.isArray(casesInput)
    ? casesInput.map((item) => {
        if (
          typeof item === "object" &&
          item !== null &&
          typeof (item as { domainKey?: unknown }).domainKey === "string" &&
          typeof (item as { caseId?: unknown }).caseId === "string"
        )
          return item as { domainKey: string; caseId: string };
        if (typeof item === "string") {
          const [domainKey, caseId] = item.split(":");
          return { domainKey, caseId };
        }
        return null;
      })
    : [];
  if (
    !cases.length ||
    cases.length > 100 ||
    cases.some(
      (c) =>
        !c ||
        !domainByKey(c.domainKey)?.cases.some((item) => item.id === c.caseId),
    ) ||
    new Set(cases.map((c) => `${c?.domainKey}:${c?.caseId}`)).size !==
      cases.length
  )
    throw new AuthError(400, "invalid_cases");
  const id = randomUUID();
  getDb()
    .transaction(() => {
      requireGroup(user, groupId);
      getDb()
        .prepare("INSERT INTO assignments VALUES (?, ?, ?, ?)")
        .run(id, groupId, name, Date.now());
      cases.forEach((item, position) =>
        getDb()
          .prepare("INSERT INTO catalog_assignment_cases VALUES (?, ?, ?, ?)")
          .run(id, item!.domainKey, item!.caseId, position),
      );
    })
    .immediate();
  return { id, groupId, title: name, cases };
}
export function listAssignments(user: AccountUser) {
  user = activeUser(user.id);
  const rows = getDb()
    .prepare(
      `SELECT a.id, a.group_id AS groupId, a.title, a.created_at AS createdAt FROM assignments a JOIN account_groups g ON g.id = a.group_id WHERE ${user.role === "supervisor" ? "g.teacher_id = ?" : "EXISTS (SELECT 1 FROM group_memberships m WHERE m.group_id = g.id AND m.student_id = ?)"} ORDER BY a.created_at DESC`,
    )
    .all(user.id) as {
    id: string;
    groupId: string;
    title: string;
    createdAt: number;
  }[];
  return rows.map((row) => ({
    ...row,
    cases: getDb()
      .prepare(
        "SELECT domain_key AS domainKey, case_id AS caseId FROM catalog_assignment_cases WHERE assignment_id = ? ORDER BY position",
      )
      .all(row.id),
    caseIds: (
      getDb()
        .prepare(
          "SELECT case_id FROM assignment_cases WHERE assignment_id = ? ORDER BY position",
        )
        .all(row.id) as { case_id: string }[]
    ).map((c) => c.case_id),
  }));
}
