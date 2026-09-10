import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config, ensureReady } from './config';

/* ============================================================
   Слой данных. SQLite через better-sqlite3, синхронно.
   Схема проектируется так, чтобы позже добавить роли
   супервизора/наблюдателя и агрегаты по группе без миграции ядра.
   ============================================================ */

type DB = Database.Database;

function openDb(): DB {
  ensureReady();
  const file = path.join(config.dataDir, 'vera.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
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
  // Локальный пользователь-«стажёр» по умолчанию; роль закладываем на будущее.
  db.prepare(
    `INSERT OR IGNORE INTO users (id, role, display_name, created_at)
     VALUES ('local', 'trainee', 'Вы', ?)`
  ).run(Date.now());
}

/** Короткие читаемые идентификаторы. */
export function uid(len = 12): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const rnd = new Uint32Array(len);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(rnd);
  else for (let i = 0; i < len; i++) rnd[i] = (Math.random() * 0xffffffff) >>> 0;
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
  created_at: number;
};

export function createScenario(r: ScenarioRow) {
  getDb()
    .prepare(
      `INSERT INTO scenarios (id, domain, category, category_slug, complaint_seed, mood_label,
        persona_key, patient_first, patient_age, opener_text, opener_emotion, exchanges_limit,
        hidden_motive_json, twist_json, acting_notes, created_at)
       VALUES (@id, @domain, @category, @category_slug, @complaint_seed, @mood_label,
        @persona_key, @patient_first, @patient_age, @opener_text, @opener_emotion, @exchanges_limit,
        @hidden_motive_json, @twist_json, @acting_notes, @created_at)`
    )
    .run(r);
}

export function getScenario(id: string): ScenarioRow | undefined {
  return getDb().prepare(`SELECT * FROM scenarios WHERE id = ?`).get(id) as ScenarioRow | undefined;
}

export type SessionRow = {
  id: string;
  scenario_id: string;
  user_id: string | null;
  status: string;
  exchanges_done: number;
  created_at: number;
  updated_at: number;
};

export function createSession(id: string, scenarioId: string, userId: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, scenario_id, user_id, status, exchanges_done, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 0, ?, ?)`
    )
    .run(id, scenarioId, userId, now, now);
}

export function getSession(id: string): SessionRow | undefined {
  return getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
}

export function setSessionStatus(id: string, status: SessionRow['status']) {
  getDb().prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), id);
}

export function bumpExchanges(id: string) {
  getDb()
    .prepare(`UPDATE sessions SET exchanges_done = exchanges_done + 1, updated_at = ? WHERE id = ?`)
    .run(Date.now(), id);
}

export function listSessions(userId: string, limit = 50): SessionRow[] {
  return getDb()
    .prepare(`SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(m.id, m.session_id, m.speaker, m.text, m.emotion, m.source, m.idx, m.created_at);
}

export function listMessages(sessionId: string): MessageRow[] {
  return getDb()
    .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY idx ASC`)
    .all(sessionId) as MessageRow[];
}

export function nextMessageIdx(sessionId: string): number {
  const row = getDb()
    .prepare(`SELECT COALESCE(MAX(idx), -1) AS m FROM messages WHERE session_id = ?`)
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(c.id, c.userId, c.sessionId, c.domain, c.category, c.mood, c.persona, Date.now());
}

/** Свежие использованные комбинации — чтобы не повторять оси подряд. */
export function recentCombos(userId: string, limit = 10) {
  const rows = getDb()
    .prepare(
      `SELECT domain, category, mood, persona FROM combo_log
       WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(userId, limit) as { domain: string; category: string; mood: string; persona: string }[];
  return rows;
}

export function saveEvaluation(e: {
  id: string;
  sessionId: string;
  model: string;
  overallSummary: string;
  safetyFlag: string | null;
  flags: string[];
  criteria: {
    name: string;
    framework: string;
    score: number;
    maxScore: number;
    evidenceQuote: string;
    explanation: string;
  }[];
}) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO evaluations (id, session_id, model, overall_summary, safety_flag, flags_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(e.id, e.sessionId, e.model, e.overallSummary, e.safetyFlag, JSON.stringify(e.flags), Date.now());
    const ins = db.prepare(
      `INSERT INTO criteria_results
         (id, evaluation_id, name, framework, score, max_score, evidence_quote, explanation, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    e.criteria.forEach((c, i) =>
      ins.run(uid(), e.id, c.name, c.framework, c.score, c.maxScore, c.evidenceQuote, c.explanation, i)
    );
    db.prepare(`UPDATE sessions SET status = 'done', updated_at = ? WHERE id = ?`).run(Date.now(), e.sessionId);
  });
  tx();
}

export function getEvaluationBySession(sessionId: string): {
  evaluation: {
    id: string;
    model: string;
    overall_summary: string;
    safety_flag: string | null;
    flags_json: string;
    created_at: number;
  };
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
    .get(sessionId) as {
    id: string;
    model: string;
    overall_summary: string;
    safety_flag: string | null;
    flags_json: string;
    created_at: number;
  } | undefined;
  if (!evaluation) return null;
  const criteria = db
    .prepare(
      `SELECT name, framework, score, max_score, evidence_quote, explanation
       FROM criteria_results WHERE evaluation_id = ? ORDER BY position ASC`
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
};

/** Список завершённых прогонов с итогами оценки — для страницы истории. */
export function historyForUser(userId: string, limit = 60): HistoryQueryRow[] {
  return getDb()
    .prepare(
      `SELECT s.id AS session_id, sc.domain, sc.category, sc.category_slug, sc.mood_label,
              sc.patient_first, s.created_at, s.exchanges_done,
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
       LIMIT ?`
    )
    .all(userId, limit) as HistoryQueryRow[];
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
    sessions: q('SELECT COUNT(*) AS n FROM sessions'),
    done: q("SELECT COUNT(*) AS n FROM sessions WHERE status='done'"),
    messages: q('SELECT COUNT(*) AS n FROM messages'),
    scenarios: q('SELECT COUNT(*) AS n FROM scenarios'),
  };
}
