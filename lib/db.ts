import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import { config, ensureReady } from "./config";

/* ============================================================
   Слой данных. SQLite через better-sqlite3, синхронно.
   Схема проектируется так, чтобы позже добавить роли
   супервизора/наблюдателя и агрегаты по группе без миграции ядра.
   ============================================================ */

type DB = Database.Database;

function openDb(): DB {
  ensureReady();
  const file = path.join(config.dataDir, "vera.db");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/* Синглтон, переживающий hot-reload Next.js dev */
const g = globalThis as unknown as { __veraDb?: DB };
export function getDb(): DB {
  if (!g.__veraDb) g.__veraDb = openDb();
  return g.__veraDb;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  role          TEXT NOT NULL DEFAULT 'trainee'
                CHECK (role IN ('trainee','observer','supervisor','admin')),
  display_name  TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scenarios (
  id                 TEXT PRIMARY KEY,
  domain             TEXT NOT NULL,
  category           TEXT NOT NULL,
  category_slug      TEXT NOT NULL,
  complaint_seed     TEXT NOT NULL,
  mood_label         TEXT NOT NULL,
  persona_key        TEXT NOT NULL,
  patient_first      TEXT NOT NULL,
  patient_age        INTEGER NOT NULL,
  opener_text        TEXT NOT NULL,
  opener_emotion     TEXT NOT NULL,
  exchanges_limit    INTEGER NOT NULL,
  hidden_motive_json TEXT NOT NULL,
  twist_json         TEXT,
  acting_notes       TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES scenarios(id),
  user_id         TEXT REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','evaluating','done','aborted')),
  exchanges_done  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  speaker    TEXT NOT NULL CHECK (speaker IN ('patient','doctor','system')),
  text       TEXT NOT NULL,
  emotion    TEXT,
  source     TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, idx);

CREATE TABLE IF NOT EXISTS evaluations (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  model           TEXT NOT NULL,
  overall_summary TEXT NOT NULL,
  safety_flag     TEXT,
  flags_json      TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS criteria_results (
  id            TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
  name          TEXT NOT NULL,
  framework     TEXT NOT NULL,
  score         INTEGER NOT NULL,
  max_score     INTEGER NOT NULL,
  evidence_quote TEXT NOT NULL,
  explanation   TEXT NOT NULL,
  position      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_criteria_eval ON criteria_results(evaluation_id);

-- Трекинг использованных осей: не повторяем свежие комбинации пользователю
CREATE TABLE IF NOT EXISTS combo_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  domain     TEXT NOT NULL,
  category   TEXT NOT NULL,
  mood       TEXT NOT NULL,
  persona    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_combo_user ON combo_log(user_id, created_at);
`;

function migrate(db: DB) {
  db.exec(SCHEMA);
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
      request_quota INTEGER NOT NULL DEFAULT 100 CHECK(request_quota >= 0)
    );
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES accounts(user_id),
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
    CREATE TABLE IF NOT EXISTS account_groups (
      id TEXT PRIMARY KEY,
      teacher_id TEXT NOT NULL REFERENCES accounts(user_id),
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_memberships (
      group_id TEXT NOT NULL REFERENCES account_groups(id),
      student_id TEXT NOT NULL REFERENCES accounts(user_id),
      PRIMARY KEY(group_id, student_id)
    );
    CREATE INDEX IF NOT EXISTS idx_memberships_student ON group_memberships(student_id);
    CREATE TABLE IF NOT EXISTS request_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES accounts(user_id),
      kind TEXT NOT NULL,
      request_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, kind, request_key)
    );
    CREATE INDEX IF NOT EXISTS idx_request_ledger_user ON request_ledger(user_id);
    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES account_groups(id),
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assignment_cases (
      assignment_id TEXT NOT NULL REFERENCES assignments(id),
      case_id TEXT NOT NULL REFERENCES scenarios(id),
      position INTEGER NOT NULL,
      PRIMARY KEY(assignment_id, case_id),
      UNIQUE(assignment_id, position)
    );
    CREATE TABLE IF NOT EXISTS assignment_attempts (
      assignment_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      student_id TEXT NOT NULL REFERENCES accounts(user_id),
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY(assignment_id, case_id, student_id),
      FOREIGN KEY(assignment_id, case_id) REFERENCES assignment_cases(assignment_id, case_id)
    );
    CREATE TABLE IF NOT EXISTS catalog_assignment_cases (
      assignment_id TEXT NOT NULL REFERENCES assignments(id),
      domain_key TEXT NOT NULL,
      case_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY(assignment_id, domain_key, case_id),
      UNIQUE(assignment_id, position)
    );
    CREATE TABLE IF NOT EXISTS catalog_assignment_attempts (
      assignment_id TEXT NOT NULL,
      domain_key TEXT NOT NULL,
      case_id TEXT NOT NULL,
      student_id TEXT NOT NULL REFERENCES accounts(user_id),
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY(assignment_id, domain_key, case_id, student_id),
      FOREIGN KEY(assignment_id, domain_key, case_id)
        REFERENCES catalog_assignment_cases(assignment_id, domain_key, case_id)
    );
  `);
  addColumns(db, "scenarios", {
    domain_key: "TEXT",
    case_id: "TEXT",
    channel: "TEXT NOT NULL DEFAULT 'visual'",
    case_facts_json: "TEXT NOT NULL DEFAULT '{}'",
    stage_plan_json: "TEXT NOT NULL DEFAULT '[]'",
    rubric_id: "TEXT",
    seed: "TEXT",
    // Снимок скрытой карточки кейса: сцена должна воспроизводиться и после
    // того, как формулировки кейса в реестре поменяются.
    case_card_json: "TEXT",
  });
  addColumns(db, "sessions", {
    mode: "TEXT NOT NULL DEFAULT 'practice'",
    format: "TEXT NOT NULL DEFAULT 'short'",
    stage_index: "INTEGER NOT NULL DEFAULT 0",
    deadline_at: "INTEGER",
    assignment_id: "TEXT",
    assignment_case_id: "TEXT",
    assignment_metadata_json: "TEXT",
    model_snapshot_json: "TEXT NOT NULL DEFAULT '{}'",
  });
  // Покрытие опроса считается движком по карточке кейса и хранится рядом
  // с вердиктом: отчёт должен воспроизводиться без повторного вызова модели.
  addColumns(db, "evaluations", { coverage_json: "TEXT" });
  /* Индексы под агрегаты кабинета преподавателя и под учёт лимитов: без них
     сводка по группе сканирует sessions и request_ledger целиком. */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user_created ON sessions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_assignment ON sessions(assignment_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_user_kind ON request_ledger(user_id, kind);
    CREATE INDEX IF NOT EXISTS idx_groups_teacher ON account_groups(teacher_id);
    CREATE INDEX IF NOT EXISTS idx_scenarios_domain ON scenarios(domain_key, case_id);
  `);

  // Локальный пользователь-«стажёр» по умолчанию; роль закладываем на будущее.
  db.prepare(
    `INSERT OR IGNORE INTO users (id, role, display_name, created_at)
     VALUES ('local', 'trainee', 'Вы', ?)`,
  ).run(Date.now());

  db.exec(`
    CREATE TABLE IF NOT EXISTS service_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  closeAbandonedSessions(db);
  ensureBootstrapCode(db);
}

/* ---------- Код первого запуска ----------

   На свежей машине преподавателю нужно как-то создать самый первый аккаунт.
   Требовать для этого правку .env неудобно (и на кафедре просто не случится),
   а открывать регистрацию всем в локальной сети нельзя. Поэтому при первом
   старте, пока в базе нет ни одного преподавателя, сервер печатает разовый
   код в консоль — ту самую, которую нельзя закрывать, пока работает сервис.
   Код виден только тому, кто сидит за сервером; после создания аккаунта он
   стирается. Если ADMIN_PASSWORD задан в окружении, работает и он.          */

function ensureBootstrapCode(db: DB): void {
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role IN ('supervisor','admin')")
    .get() as { n: number };
  if (n > 0) {
    db.prepare("DELETE FROM service_meta WHERE key = 'bootstrap_code'").run();
    return;
  }

  /* Код перевыпускается на каждом старте, пока преподавателя нет. Хранится
     только хэш, показать старый код второй раз невозможно — а перезапуск
     сервера случается легко. Заодно старый код перестаёт действовать. */
  // Без похожих друг на друга символов: код диктуют и вводят руками.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  const code = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  db.prepare(
    `INSERT INTO service_meta (key, value, created_at) VALUES ('bootstrap_code', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
  ).run(createHash("sha256").update(code).digest("hex"), Date.now());
  const line = "═".repeat(58);
  console.log(
    [
      "",
      line,
      "  ПЕРВЫЙ ЗАПУСК: аккаунта преподавателя ещё нет.",
      "  Откройте приложение, нажмите «Первый запуск преподавателя»",
      "  и введите этот код запуска:",
      "",
      `        ${code}`,
      "",
      "  Код действует до создания первого аккаунта и больше не",
      "  понадобится. Никому его не передавайте.",
      line,
      "",
    ].join("\n"),
  );
}

/**
 * Проверить код первого запуска, не гася его. Гасится он только после того,
 * как аккаунт реально создан (clearBootstrapCode): иначе опечатка в логине
 * сжигала бы код, и повторить можно было бы лишь после перезапуска сервера.
 */
export function bootstrapCodeMatches(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const row = getDb().prepare("SELECT value FROM service_meta WHERE key = 'bootstrap_code'").get() as
    | { value: string }
    | undefined;
  if (!row) return false;
  const given = createHash("sha256").update(value.trim().toUpperCase()).digest();
  const expected = Buffer.from(row.value, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Погасить код первого запуска — после создания первого преподавателя. */
export function clearBootstrapCode(): void {
  getDb().prepare("DELETE FROM service_meta WHERE key = 'bootstrap_code'").run();
}

/** Нужен ли ещё первый запуск: нет ни одного преподавателя. */
export function bootstrapNeeded(): boolean {
  const { n } = getDb()
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role IN ('supervisor','admin')")
    .get() as { n: number };
  return n === 0;
}

/** Сколько часов «висящая» сессия считается живой. */
const ABANDONED_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * Сессии, брошенные посреди диалога (закрыли вкладку, ушли с пары), навсегда
 * оставались active и портили статистику «в работе». На старте помечаем
 * старые как aborted: данные и реплики сохраняются, теряется только
 * возможность продолжить — она всё равно уже не нужна.
 *
 * Статус evaluating не трогаем: такой диалог уже завершён полностью и
 * ждёт только разбора (например, провайдер был недоступен). Пометка
 * aborted навсегда закрыла бы студенту доступ к отчёту за сделанную работу.
 */
export function closeAbandonedSessions(db: DB = getDb()): number {
  const result = db
    .prepare(
      `UPDATE sessions SET status = 'aborted', updated_at = ?
       WHERE status = 'active' AND updated_at < ?`,
    )
    .run(Date.now(), Date.now() - ABANDONED_AFTER_MS);
  return result.changes;
}

/** SQLite has no portable ADD COLUMN IF NOT EXISTS, so inspect first. */
function addColumns(
  db: DB,
  table: string,
  columns: Record<string, string>,
): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

/** Короткие читаемые идентификаторы. */
export function uid(len = 12): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  const rnd = new Uint32Array(len);
  if (typeof crypto !== "undefined" && crypto.getRandomValues)
    crypto.getRandomValues(rnd);
  else
    for (let i = 0; i < len; i++) rnd[i] = (Math.random() * 0xffffffff) >>> 0;
  for (let i = 0; i < len; i++) s += alphabet[rnd[i] % alphabet.length];
  return s;
}

/* ---------- Хранилище: репозитории ---------- */

export type ScenarioRow = {
  id: string;
  domain: string;
  category: string;
  category_slug: string;
  complaint_seed: string;
  mood_label: string;
  persona_key: string;
  patient_first: string;
  patient_age: number;
  opener_text: string;
  opener_emotion: string;
  exchanges_limit: number;
  hidden_motive_json: string;
  twist_json: string | null;
  acting_notes: string;
  domain_key?: string | null;
  case_id?: string | null;
  channel?: string;
  case_facts_json?: string;
  stage_plan_json?: string;
  rubric_id?: string | null;
  seed?: string | null;
  case_card_json?: string | null;
  created_at: number;
};

export function createScenario(r: ScenarioRow) {
  getDb()
    .prepare(
      `INSERT INTO scenarios (id, domain, category, category_slug, complaint_seed, mood_label,
         persona_key, patient_first, patient_age, opener_text, opener_emotion, exchanges_limit,
         hidden_motive_json, twist_json, acting_notes, domain_key, case_id, channel,
         case_facts_json, stage_plan_json, rubric_id, seed, case_card_json, created_at)
       VALUES (@id, @domain, @category, @category_slug, @complaint_seed, @mood_label,
         @persona_key, @patient_first, @patient_age, @opener_text, @opener_emotion, @exchanges_limit,
         @hidden_motive_json, @twist_json, @acting_notes, @domain_key, @case_id, @channel,
         @case_facts_json, @stage_plan_json, @rubric_id, @seed, @case_card_json, @created_at)`,
    )
    .run({
      ...r,
      domain_key: r.domain_key ?? null,
      case_id: r.case_id ?? null,
      channel: r.channel ?? "visual",
      case_facts_json: r.case_facts_json ?? "{}",
      stage_plan_json: r.stage_plan_json ?? "[]",
      rubric_id: r.rubric_id ?? null,
      seed: r.seed ?? null,
      case_card_json: r.case_card_json ?? null,
    });
}

export function getScenario(id: string): ScenarioRow | undefined {
  return getDb().prepare(`SELECT * FROM scenarios WHERE id = ?`).get(id) as
    ScenarioRow | undefined;
}

export type SessionRow = {
  id: string;
  scenario_id: string;
  user_id: string | null;
  status: string;
  exchanges_done: number;
  mode: "practice" | "exam";
  format: "short" | "long";
  stage_index: number;
  deadline_at: number | null;
  assignment_id: string | null;
  assignment_case_id: string | null;
  assignment_metadata_json: string | null;
  model_snapshot_json: string;
  created_at: number;
  updated_at: number;
};

export function createSession(
  id: string,
  scenarioId: string,
  userId: string,
  options?: {
    mode?: "practice" | "exam";
    format?: "short" | "long";
    deadlineAt?: number | null;
    assignmentId?: string | null;
    assignmentCaseId?: string | null;
    assignmentDomainKey?: string | null;
    assignmentMetadata?: unknown;
    modelSnapshot?: unknown;
  },
): void {
  const now = Date.now();
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (id, scenario_id, user_id, status, exchanges_done, mode, format,
         stage_index, deadline_at, assignment_id, assignment_case_id, assignment_metadata_json,
         model_snapshot_json, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 0, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      scenarioId,
      userId,
      options?.mode ?? "practice",
      options?.format ?? "short",
      options?.deadlineAt ?? null,
      options?.assignmentId ?? null,
      options?.assignmentCaseId ?? null,
      options?.assignmentMetadata == null
        ? null
        : JSON.stringify(options.assignmentMetadata),
      JSON.stringify(options?.modelSnapshot ?? {}),
      now,
      now,
    );
    if (
      options?.assignmentId &&
      options.assignmentCaseId &&
      options.assignmentDomainKey
    ) {
      const assigned = db
        .prepare(
          `SELECT 1 FROM assignments a
        JOIN group_memberships m ON m.group_id = a.group_id
        JOIN catalog_assignment_cases c ON c.assignment_id = a.id
        WHERE a.id = ? AND m.student_id = ? AND c.domain_key = ? AND c.case_id = ?`,
        )
        .get(
          options.assignmentId,
          userId,
          options.assignmentDomainKey,
          options.assignmentCaseId,
        );
      if (!assigned) throw new Error("assignment_case_not_found");
      db.prepare(
        `INSERT INTO catalog_assignment_attempts
        (assignment_id, domain_key, case_id, student_id, session_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        options.assignmentId,
        options.assignmentDomainKey,
        options.assignmentCaseId,
        userId,
        id,
        now,
      );
    } else if (options?.assignmentId && options.assignmentCaseId) {
      const assigned = db
        .prepare(
          `SELECT 1 FROM assignments a
        JOIN group_memberships m ON m.group_id = a.group_id
        JOIN assignment_cases c ON c.assignment_id = a.id
        WHERE a.id = ? AND m.student_id = ? AND c.case_id = ?`,
        )
        .get(options.assignmentId, userId, options.assignmentCaseId);
      if (!assigned) throw new Error("assignment_case_not_found");
      db.prepare(
        `INSERT INTO assignment_attempts
        (assignment_id, case_id, student_id, session_id, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(options.assignmentId, options.assignmentCaseId, userId, id, now);
    }
  }).immediate();
}

export function getSession(id: string): SessionRow | undefined {
  return getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
    SessionRow | undefined;
}

export function setSessionStatus(id: string, status: SessionRow["status"]) {
  getDb()
    .prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, Date.now(), id);
}

export function bumpExchanges(id: string) {
  getDb()
    .prepare(
      `UPDATE sessions SET exchanges_done = exchanges_done + 1, updated_at = ? WHERE id = ?`,
    )
    .run(Date.now(), id);
}

export function listSessions(userId: string, limit = 50): SessionRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, limit) as SessionRow[];
}

export type MessageRow = {
  id: string;
  session_id: string;
  speaker: string;
  text: string;
  emotion: string | null;
  source: string;
  idx: number;
  created_at: number;
};

export function insertMessage(m: MessageRow) {
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, speaker, text, emotion, source, idx, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.id,
      m.session_id,
      m.speaker,
      m.text,
      m.emotion,
      m.source,
      m.idx,
      m.created_at,
    );
}

/** Ответ врача и счётчик обменов фиксируются вместе — одной транзакцией. */
export function recordDoctorTurn(m: MessageRow, stageIndex: number | null): void {
  const db = getDb();
  db.transaction(() => {
    insertMessage(m);
    db.prepare(
      `UPDATE sessions SET exchanges_done = exchanges_done + 1,
         stage_index = COALESCE(?, stage_index), updated_at = ? WHERE id = ?`,
    ).run(stageIndex, Date.now(), m.session_id);
  }).immediate();
}

/**
 * Откатить ответ врача, если собеседник так и не ответил (сбой провайдера).
 * Иначе ход «сгорал»: реплика врача оставалась без ответа, счётчик уходил
 * вперёд, а повтор добавлял в транскрипт вторую такую же реплику.
 */
export function revertDoctorTurn(sessionId: string, messageId: string, stageIndex: number): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM messages WHERE id = ? AND session_id = ?`).run(messageId, sessionId);
    db.prepare(
      `UPDATE sessions SET exchanges_done = MAX(0, exchanges_done - 1), stage_index = ?, updated_at = ?
       WHERE id = ?`,
    ).run(stageIndex, Date.now(), sessionId);
  }).immediate();
}

export function listMessages(sessionId: string): MessageRow[] {
  return getDb()
    .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY idx ASC`)
    .all(sessionId) as MessageRow[];
}

export function nextMessageIdx(sessionId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(MAX(idx), -1) AS m FROM messages WHERE session_id = ?`,
    )
    .get(sessionId) as { m: number };
  return row.m + 1;
}

export function recordCombo(c: {
  id: string;
  userId: string;
  sessionId: string;
  domain: string;
  category: string;
  mood: string;
  persona: string;
}) {
  getDb()
    .prepare(
      `INSERT INTO combo_log (id, user_id, session_id, domain, category, mood, persona, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.id,
      c.userId,
      c.sessionId,
      c.domain,
      c.category,
      c.mood,
      c.persona,
      Date.now(),
    );
}

/** Свежие использованные комбинации — чтобы не повторять оси подряд. */
export function recentCombos(userId: string, limit = 10) {
  const rows = getDb()
    .prepare(
      `SELECT domain, category, mood, persona FROM combo_log
       WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, limit) as {
    domain: string;
    category: string;
    mood: string;
    persona: string;
  }[];
  return rows;
}

export function saveEvaluation(e: {
  id: string;
  sessionId: string;
  model: string;
  overallSummary: string;
  safetyFlag: string | null;
  flags: string[];
  coverage?: unknown;
  criteria: {
    name: string;
    framework: string;
    score: number;
    maxScore: number;
    evidenceQuote: string;
    explanation: string;
  }[];
}): boolean {
  const db = getDb();
  const tx = db.transaction((): boolean => {
    if (
      db
        .prepare(`SELECT 1 FROM evaluations WHERE session_id = ?`)
        .get(e.sessionId)
    )
      return false;
    db.prepare(
      `INSERT INTO evaluations (id, session_id, model, overall_summary, safety_flag, flags_json, coverage_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.id,
      e.sessionId,
      e.model,
      e.overallSummary,
      e.safetyFlag,
      JSON.stringify(e.flags),
      e.coverage == null ? null : JSON.stringify(e.coverage),
      Date.now(),
    );
    const ins = db.prepare(
      `INSERT INTO criteria_results
         (id, evaluation_id, name, framework, score, max_score, evidence_quote, explanation, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    e.criteria.forEach((c, i) =>
      ins.run(
        uid(),
        e.id,
        c.name,
        c.framework,
        c.score,
        c.maxScore,
        c.evidenceQuote,
        c.explanation,
        i,
      ),
    );
    db.prepare(
      `UPDATE sessions SET status = 'done', updated_at = ? WHERE id = ?`,
    ).run(Date.now(), e.sessionId);
    return true;
  });
  return tx.immediate();
}

export type EvaluationRow = {
  id: string;
  model: string;
  overall_summary: string;
  safety_flag: string | null;
  flags_json: string;
  coverage_json: string | null;
  created_at: number;
};

export function getEvaluationBySession(sessionId: string): {
  evaluation: EvaluationRow;
  criteria: {
    name: string;
    framework: string;
    score: number;
    max_score: number;
    evidence_quote: string;
    explanation: string;
  }[];
} | null {
  const db = getDb();
  const evaluation = db
    .prepare(`SELECT * FROM evaluations WHERE session_id = ?`)
    .get(sessionId) as EvaluationRow | undefined;
  if (!evaluation) return null;
  const criteria = db
    .prepare(
      `SELECT name, framework, score, max_score, evidence_quote, explanation
       FROM criteria_results WHERE evaluation_id = ? ORDER BY position ASC`,
    )
    .all(evaluation.id) as {
    name: string;
    framework: string;
    score: number;
    max_score: number;
    evidence_quote: string;
    explanation: string;
  }[];
  return { evaluation, criteria };
}

export type HistoryQueryRow = {
  session_id: string;
  domain: string;
  category: string;
  category_slug: string;
  mood_label: string;
  patient_first: string;
  created_at: number;
  exchanges_done: number;
  total_score: number | null;
  max_score: number | null;
  overall_summary: string | null;
  has_safety_flag: number;
  status: string;
  mode: string | null;
  format: string | null;
};

/** Список завершённых прогонов с итогами оценки — для страницы истории. */
export function historyForUser(userId: string, limit = 60): HistoryQueryRow[] {
  return getDb()
    .prepare(
      `SELECT s.id AS session_id, sc.domain, sc.category, sc.category_slug, sc.mood_label,
              sc.patient_first, s.created_at, s.exchanges_done, s.mode, s.format,
              (SELECT SUM(c.score) FROM criteria_results c WHERE c.evaluation_id = e.id) AS total_score,
              (SELECT SUM(c.max_score) FROM criteria_results c WHERE c.evaluation_id = e.id) AS max_score,
              e.overall_summary,
              CASE WHEN e.safety_flag IS NOT NULL AND e.safety_flag != '' THEN 1 ELSE 0 END AS has_safety_flag,
              s.status
       FROM sessions s
       JOIN scenarios sc ON sc.id = s.scenario_id
       LEFT JOIN evaluations e ON e.session_id = s.id
       WHERE s.user_id = ? AND s.status = 'done'
       ORDER BY s.created_at DESC
       LIMIT ?`,
    )
    .all(userId, limit) as HistoryQueryRow[];
}

/* ---------- История прогресса студента ---------- */

export type ProgressSessionRow = {
  sessionId: string;
  createdAt: number;
  domain: string;
  domainKey: string | null;
  category: string;
  mode: string;
  format: string;
  exchangesDone: number;
  totalScore: number | null;
  maxScore: number | null;
  safetyFlag: string | null;
  coverageJson: string | null;
  overallSummary: string | null;
};

/** Завершённые прогоны студента по возрастанию даты — основа графиков.
    При переполнении лимита отбрасываются самые старые, а не самые свежие. */
export function progressSessions(userId: string, limit = 500): ProgressSessionRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM (
         SELECT s.id AS sessionId, s.created_at AS createdAt, sc.domain, sc.domain_key AS domainKey,
                sc.category, s.mode, s.format, s.exchanges_done AS exchangesDone,
                t.total AS totalScore, t.max_total AS maxScore,
                e.safety_flag AS safetyFlag, e.coverage_json AS coverageJson,
                e.overall_summary AS overallSummary
         FROM sessions s
         JOIN scenarios sc ON sc.id = s.scenario_id
         JOIN evaluations e ON e.session_id = s.id
         LEFT JOIN (
           SELECT evaluation_id, SUM(score) AS total, SUM(max_score) AS max_total
           FROM criteria_results GROUP BY evaluation_id
         ) t ON t.evaluation_id = e.id
         WHERE s.user_id = ? AND s.status = 'done'
         ORDER BY s.created_at DESC
         LIMIT ?
       ) ORDER BY createdAt ASC`,
    )
    .all(userId, limit) as ProgressSessionRow[];
}

export type ProgressCriterionRow = {
  sessionId: string;
  createdAt: number;
  name: string;
  framework: string;
  score: number;
  maxScore: number;
};

/** Все оценки по критериям в хронологии — из них считается динамика.
    Как и выше, при переполнении лимита теряются старые оценки, а не свежие. */
export function progressCriteria(userId: string, limit = 5000): ProgressCriterionRow[] {
  return getDb()
    .prepare(
      `SELECT sessionId, createdAt, name, framework, score, maxScore FROM (
         SELECT s.id AS sessionId, s.created_at AS createdAt, c.name, c.framework,
                c.score AS score, c.max_score AS maxScore, c.position AS position
         FROM criteria_results c
         JOIN evaluations e ON e.id = c.evaluation_id
         JOIN sessions s ON s.id = e.session_id
         WHERE s.user_id = ? AND s.status = 'done'
         ORDER BY s.created_at DESC, c.position DESC
         LIMIT ?
       ) ORDER BY createdAt ASC, sessionId ASC, position ASC`,
    )
    .all(userId, limit) as ProgressCriterionRow[];
}

/* ---------- Агрегаты для кабинета преподавателя ---------- */

/* Студент может состоять в нескольких группах одного преподавателя, поэтому
   принадлежность проверяется через EXISTS, а не JOIN: иначе одна и та же
   сессия попала бы в агрегат дважды. */
const TEACHER_SCOPE = `EXISTS (
  SELECT 1 FROM group_memberships m JOIN account_groups g ON g.id = m.group_id
  WHERE m.student_id = s.user_id AND g.teacher_id = @teacher
    AND (@group IS NULL OR g.id = @group)
)`;

export type GroupOverview = {
  students: number;
  sessions: number;
  done: number;
  exams: number;
  longFormat: number;
  safetyFlags: number;
  avgPercent: number | null;
};

export function groupOverview(teacherId: string, groupId?: string | null): GroupOverview {
  const db = getDb();
  const params = { teacher: teacherId, group: groupId ?? null };
  const students = db
    .prepare(
      `SELECT COUNT(DISTINCT m.student_id) AS n FROM group_memberships m
       JOIN account_groups g ON g.id = m.group_id
       WHERE g.teacher_id = @teacher AND (@group IS NULL OR g.id = @group)`,
    )
    .get(params) as { n: number };
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS sessions,
         SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN s.mode = 'exam' THEN 1 ELSE 0 END) AS exams,
         SUM(CASE WHEN s.format = 'long' THEN 1 ELSE 0 END) AS longFormat,
         SUM(CASE WHEN e.safety_flag IS NOT NULL AND e.safety_flag != '' THEN 1 ELSE 0 END) AS safetyFlags,
         AVG(CASE WHEN t.max_total > 0 THEN 100.0 * t.total / t.max_total END) AS avgPercent
       FROM sessions s
       LEFT JOIN evaluations e ON e.session_id = s.id
       LEFT JOIN (
         SELECT evaluation_id, SUM(score) AS total, SUM(max_score) AS max_total
         FROM criteria_results GROUP BY evaluation_id
       ) t ON t.evaluation_id = e.id
       WHERE ${TEACHER_SCOPE}`,
    )
    .get(params) as Omit<GroupOverview, 'students'>;
  return {
    students: students.n,
    sessions: row.sessions ?? 0,
    done: row.done ?? 0,
    exams: row.exams ?? 0,
    longFormat: row.longFormat ?? 0,
    safetyFlags: row.safetyFlags ?? 0,
    avgPercent: row.avgPercent === null ? null : Math.round(row.avgPercent),
  };
}

export type CriterionStat = {
  name: string;
  framework: string;
  attempts: number;
  avgScore: number;
  maxScore: number;
  percent: number;
  zeroShare: number;
};

/** По каким критериям группа проседает чаще всего — слабые впереди. */
export function groupCriterionStats(teacherId: string, groupId?: string | null): CriterionStat[] {
  const rows = getDb()
    .prepare(
      `SELECT c.name, c.framework,
              COUNT(*) AS attempts,
              AVG(1.0 * c.score) AS avgScore,
              MAX(c.max_score) AS maxScore,
              AVG(CASE WHEN c.score = 0 THEN 1.0 ELSE 0.0 END) AS zeroShare
       FROM criteria_results c
       JOIN evaluations e ON e.id = c.evaluation_id
       JOIN sessions s ON s.id = e.session_id
       WHERE ${TEACHER_SCOPE}
       GROUP BY c.name, c.framework
       HAVING attempts > 0
       ORDER BY (AVG(1.0 * c.score) / MAX(c.max_score)) ASC, attempts DESC`,
    )
    .all({ teacher: teacherId, group: groupId ?? null }) as {
    name: string;
    framework: string;
    attempts: number;
    avgScore: number;
    maxScore: number;
    zeroShare: number;
  }[];
  return rows.map((row) => ({
    ...row,
    avgScore: Math.round(row.avgScore * 100) / 100,
    percent: row.maxScore > 0 ? Math.round((row.avgScore / row.maxScore) * 100) : 0,
    zeroShare: Math.round(row.zeroShare * 100),
  }));
}

export type DomainStat = { domain: string; attempts: number; percent: number | null };

export function groupDomainStats(teacherId: string, groupId?: string | null): DomainStat[] {
  const rows = getDb()
    .prepare(
      `SELECT sc.domain AS domain, COUNT(*) AS attempts,
              AVG(CASE WHEN t.max_total > 0 THEN 100.0 * t.total / t.max_total END) AS percent
       FROM sessions s
       JOIN scenarios sc ON sc.id = s.scenario_id
       LEFT JOIN evaluations e ON e.session_id = s.id
       LEFT JOIN (
         SELECT evaluation_id, SUM(score) AS total, SUM(max_score) AS max_total
         FROM criteria_results GROUP BY evaluation_id
       ) t ON t.evaluation_id = e.id
       WHERE ${TEACHER_SCOPE}
       GROUP BY sc.domain
       ORDER BY attempts DESC`,
    )
    .all({ teacher: teacherId, group: groupId ?? null }) as {
    domain: string;
    attempts: number;
    percent: number | null;
  }[];
  return rows.map((row) => ({ ...row, percent: row.percent === null ? null : Math.round(row.percent) }));
}

export type StudentStat = {
  studentId: string;
  attempts: number;
  done: number;
  percent: number | null;
  safetyFlags: number;
  lastActivity: number | null;
  weakest: string | null;
  /** Израсходовано платных обращений к провайдеру. */
  spent: number;
};

export function groupStudentStats(teacherId: string, groupId?: string | null): StudentStat[] {
  const db = getDb();
  const params = { teacher: teacherId, group: groupId ?? null };
  const rows = db
    .prepare(
      `SELECT s.user_id AS studentId, COUNT(*) AS attempts,
              SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END) AS done,
              AVG(CASE WHEN t.max_total > 0 THEN 100.0 * t.total / t.max_total END) AS percent,
              SUM(CASE WHEN e.safety_flag IS NOT NULL AND e.safety_flag != '' THEN 1 ELSE 0 END) AS safetyFlags,
              MAX(s.created_at) AS lastActivity
       FROM sessions s
       LEFT JOIN evaluations e ON e.session_id = s.id
       LEFT JOIN (
         SELECT evaluation_id, SUM(score) AS total, SUM(max_score) AS max_total
         FROM criteria_results GROUP BY evaluation_id
       ) t ON t.evaluation_id = e.id
       WHERE ${TEACHER_SCOPE} AND s.user_id IS NOT NULL
       GROUP BY s.user_id`,
    )
    .all(params) as Omit<StudentStat, 'weakest' | 'spent'>[];
  const weakest = db.prepare(
    `SELECT c.name FROM criteria_results c
     JOIN evaluations e ON e.id = c.evaluation_id
     JOIN sessions s ON s.id = e.session_id
     WHERE s.user_id = ?
     GROUP BY c.name
     ORDER BY (AVG(1.0 * c.score) / MAX(c.max_score)) ASC, COUNT(*) DESC
     LIMIT 1`,
  );
  const spent = db.prepare('SELECT COUNT(*) AS n FROM request_ledger WHERE user_id = ?');
  return rows.map((row) => ({
    ...row,
    percent: row.percent === null ? null : Math.round(row.percent),
    weakest: (weakest.get(row.studentId) as { name: string } | undefined)?.name ?? null,
    spent: (spent.get(row.studentId) as { n: number }).n,
  }));
}

export type TeacherSessionRow = {
  sessionId: string;
  studentId: string | null;
  domain: string;
  category: string;
  mode: string;
  format: string;
  status: string;
  createdAt: number;
  exchangesDone: number;
  totalScore: number | null;
  maxScore: number | null;
  safetyFlag: string | null;
};

/** Сессии студентов преподавателя (или одного студента) для списка и транскриптов. */
export function teacherSessions(
  teacherId: string,
  options: { groupId?: string | null; studentId?: string | null; limit?: number } = {},
): TeacherSessionRow[] {
  return getDb()
    .prepare(
      `SELECT s.id AS sessionId, s.user_id AS studentId, sc.domain, sc.category,
              s.mode, s.format, s.status, s.created_at AS createdAt, s.exchanges_done AS exchangesDone,
              t.total AS totalScore, t.max_total AS maxScore, e.safety_flag AS safetyFlag
       FROM sessions s
       JOIN scenarios sc ON sc.id = s.scenario_id
       LEFT JOIN evaluations e ON e.session_id = s.id
       LEFT JOIN (
         SELECT evaluation_id, SUM(score) AS total, SUM(max_score) AS max_total
         FROM criteria_results GROUP BY evaluation_id
       ) t ON t.evaluation_id = e.id
       WHERE ${TEACHER_SCOPE} AND (@student IS NULL OR s.user_id = @student)
       ORDER BY s.created_at DESC
       LIMIT @limit`,
    )
    .all({
      teacher: teacherId,
      group: options.groupId ?? null,
      student: options.studentId ?? null,
      limit: options.limit ?? 200,
    }) as TeacherSessionRow[];
}

/* ---------- Утилиты хранения файлов (кэш TTS, аплоады) ---------- */

export function ttsCachePath(hash: string): string {
  return path.join(config.ttsCacheDir, `${hash}.mp3`);
}

export function uploadPath(filename: string): string {
  return path.join(config.uploadsDir, path.basename(filename));
}

export function dbStats() {
  const db = getDb();
  const q = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    sessions: q("SELECT COUNT(*) AS n FROM sessions"),
    done: q("SELECT COUNT(*) AS n FROM sessions WHERE status='done'"),
    messages: q("SELECT COUNT(*) AS n FROM messages"),
    scenarios: q("SELECT COUNT(*) AS n FROM scenarios"),
  };
}
