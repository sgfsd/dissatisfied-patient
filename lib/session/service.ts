import {
  createScenario,
  createSession,
  getScenario,
  getSession,
  historyForUser,
  insertMessage,
  listMessages,
  nextMessageIdx,
  recordCombo,
  recordDoctorTurn,
  recentCombos,
  revertDoctorTurn,
  saveEvaluation,
  setSessionStatus,
  uid,
  getDb,
  type MessageRow,
  type ScenarioRow,
  type SessionRow,
} from "../db";
import { config } from "../config";
import { AiError } from "../ai/errors";
import {
  PATIENT_EMOTION_LABELS,
  type CaseCard,
  type EvaluationDTO,
  type HiddenMotive,
  type MessageDTO,
  type MessageSource,
  type PatientEmotion,
  type PatientTurnOutcome,
  type SessionFormat,
  type SessionMode,
  type SessionPublicDTO,
  type StageDef,
  type TrainingDomainDef,
  type TwistPlan,
} from "../types";
import { type EvalMessage } from "../evaluation/evaluator";
import { personaById } from "../personas";
import {
  CALM_MOODS,
  MOODS,
  MOTIVES,
  personaPoolFor,
  type ComplaintCategory,
  type MotiveDef,
} from "../scenarios/axes";
import {
  computeCoverage,
  domainByKey,
  domainsForFormat,
  TRAINING_DOMAINS,
} from "../domains";
import { AuthError, authorizeSession, type AccountUser } from "../auth";
import { countRequests, reserveRequest } from "../accounts";
import { generateScenario } from "../scenarios/generate";
import { producePatientLine } from "../scenarios/actor";
import { audioUrlForKey, ensureSpeech, hasSpeech, speechCacheKey, type SpeechOpts } from "../speech";
import { evaluateDialogue } from "../evaluation/evaluator";
import { evaluationDTO, redactExamEvaluation } from "./evaluationDto";
import { getProvider } from "../ai/provider";

const EXAM_DURATION_MS = 30 * 60 * 1000;
/* Сколько раз можно запросить разбор одной сессии: защита от цикла повторов
   при падающем провайдере. Успешный разбор кэшируется и попытку не тратит. */
const EVAL_ATTEMPT_LIMIT = 3;
/* Сколько раз можно повторить один и тот же ход, если собеседник не ответил
   из-за сбоя провайдера. Каждая попытка списывается из лимита. */
const TURN_ATTEMPT_LIMIT = 3;

/* ---------- работа «в полёте» ----------
   Сервер один (SQLite, одна машина кафедры), поэтому блокировки держим в
   памяти процесса. Синглтоны переживают hot-reload Next.js dev. */
const g = globalThis as unknown as {
  __veraTurns?: Set<string>;
  __veraEvaluations?: Map<string, Promise<EvaluationDTO>>;
};
/** Сессии, по которым прямо сейчас идёт ход собеседника. */
const turnsInFlight = (g.__veraTurns ??= new Set());
/** Разборы в работе: повторный запрос ждёт тот же результат, а не платит второй раз. */
const evaluationsInFlight = (g.__veraEvaluations ??= new Map());

/* ---------- помощники ---------- */

/**
 * Озвучка — оформление реплики, а не её суть. Сбой TTS не должен ронять
 * уже оплаченную генерацию: реплика уходит текстом (audioUrl = null).
 * Раньше такой сбой после создания экзаменационной сессии сжигал
 * единственную попытку и оставлял сессию без открывающей реплики.
 */
async function trySpeech(text: string, opts: SpeechOpts): Promise<string | null> {
  try {
    return await ensureSpeech(text, opts);
  } catch (e) {
    console.warn("[tts] озвучка не удалась, реплика уйдёт текстом:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Ключ провайдера задан? Проверяется ДО списания лимита: без ключа обращения
 * к провайдеру не будет, и студент не должен платить за ошибку настройки.
 */
function assertProviderReady(): void {
  getProvider();
}

/** Что из разбора видит студент: на экзамене — только итог (см. redactExamEvaluation). */
function evaluationFor(session: SessionRow, dto: EvaluationDTO): EvaluationDTO {
  return session.mode === "exam" ? redactExamEvaluation(dto) : dto;
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** План этапов сцены. Старые записи хранили просто строки — поддерживаем оба вида. */
function stagePlanOf(scenario: ScenarioRow): StageDef[] {
  const raw = parseJson<unknown>(scenario.stage_plan_json ?? null, []);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, i): StageDef[] => {
    if (typeof item === "string")
      return [{ id: `stage-${i + 1}`, title: item, required: true }];
    if (item && typeof item === "object" && typeof (item as StageDef).title === "string")
      return [item as StageDef];
    return [];
  });
}

function stageIndex(done: number, limit: number, stages: StageDef[]): number {
  if (!stages.length) return 0;
  return Math.min(stages.length - 1, Math.floor((done * stages.length) / Math.max(1, limit)));
}

function exchangesFor(domain: TrainingDomainDef | undefined, format: SessionFormat): number {
  if (format === "long") return domain?.longExchanges ?? config.longExchanges;
  return config.exchanges;
}

function cardOf(scenario: ScenarioRow): CaseCard | null {
  const inline = parseJson<CaseCard | null>(scenario.case_card_json ?? null, null);
  if (inline?.facts?.length) return inline;
  const domain = domainByKey(scenario.domain_key);
  const item = domain?.cases.find((candidate) => candidate.id === scenario.case_id);
  return item?.card ?? null;
}

function owned(user: AccountUser, id: string): SessionRow {
  return authorizeSession(user, id, true);
}

function expire(session: SessionRow): SessionRow {
  if (
    session.status === "active" &&
    session.deadline_at !== null &&
    Date.now() >= session.deadline_at
  ) {
    setSessionStatus(session.id, "aborted");
    return { ...session, status: "aborted" };
  }
  return session;
}

function publicMetadata(session: SessionRow, scenario: ScenarioRow) {
  return {
    domainKey: scenario.domain_key ?? domainByKey(scenario.domain)?.key ?? "conflict",
    caseId: scenario.case_id,
    channel: (scenario.channel ?? "visual") as "visual" | "voice-only",
    framework: domainByKey(scenario.domain_key)?.card.framework ?? null,
    mode: session.mode,
    format: session.format,
    stageIndex: session.stage_index,
    stages: stagePlanOf(scenario),
    deadlineAt: session.deadline_at,
    assignmentId: session.assignment_id,
    recordMaxSeconds: config.recordMaxSeconds,
  };
}

function scenarioFromRow(r: ScenarioRow) {
  return {
    domain: r.domain,
    category: r.category,
    categorySlug: r.category_slug,
    complaintSeed: r.complaint_seed,
    moodLabel: r.mood_label,
    personaKey: r.persona_key,
    patientFirst: r.patient_first,
    patientAge: r.patient_age,
    openerText: r.opener_text,
    openerEmotion: r.opener_emotion as PatientEmotion,
    exchangesLimit: r.exchanges_limit,
    hiddenMotive: parseJson<HiddenMotive>(r.hidden_motive_json, {
      kind: "",
      label: "",
      description: "",
      revealAtExchange: null,
    }),
    twist: parseJson<TwistPlan | null>(r.twist_json, null),
    actingNotes: r.acting_notes,
  };
}

function messageToDTO(m: MessageRow, personaKey: string, channel: string): MessageDTO {
  const persona = personaById(personaKey);
  let audioUrl: string | null = null;
  if (m.speaker === "patient" && m.text) {
    const instructions = speechInstructions(
      personaKey,
      (m.emotion as PatientEmotion | null) ?? undefined,
      channel,
    );
    const key = speechCacheKey(m.text, {
      voice: persona.voice,
      model: config.ttsModel,
      instructions,
      speed: speechSpeed((m.emotion as PatientEmotion | null) ?? undefined),
    });
    // Ссылку на аудио отдаём только если mp3 реально лежит в кэше: иначе клиент
    // получит мёртвый URL (404) и реплей/автопроигрывание сломаются беззвучно.
    if (hasSpeech(key)) audioUrl = audioUrlForKey(key);
  }
  return {
    id: m.id,
    speaker: m.speaker as MessageDTO["speaker"],
    text: m.text,
    emotion: (m.emotion as PatientEmotion | null) ?? null,
    source: m.source as MessageSource,
    audioUrl,
    idx: m.idx,
    createdAt: m.created_at,
  };
}

/* ---------- Инструкция для TTS ---------- */

/** Насколько «разогнана» речь под эмоцию: темп, громкость, характер срыва. */
const EMOTION_DIRECTION: Record<PatientEmotion, string> = {
  neutral: "ровный спокойный темп, короткие естественные паузы между мыслями",
  irritated:
    "темп чуть быстрее обычного, отрывистые фразы, нажим на ударные слова, воздух через нос перед фразой",
  angry:
    "громче и быстрее, жёсткие согласные, фраза идёт одним напором и обрывается, дыхание слышно",
  aggressive:
    "почти на срыве: резкие скачки громкости, давление в голосе, короткие рубленые фразы, ни одной ласковой интонации",
  upset:
    "голос дрожит и садится, речь рвётся на середине фразы, вдохи слышны, к концу фразы почти шёпот",
  sarcastic:
    "нарочито спокойно и медленно, растянутые гласные на ключевых словах, лёгкая усмешка в голосе, интонация вверх там, где смысл вниз",
  cold: "ровно, тихо, без эмоциональной окраски, отчётливые паузы, вежливость как дистанция",
  anxious:
    "тараторит, проглатывает окончания, часто набирает воздух, интонация вверх почти на каждой фразе",
  sad: "медленно и тихо, длинные паузы, к концу фразы голос гаснет",
};

/* Темп речи под эмоцию: тревога тараторит, подавленность тянет. Инструкции
   модель TTS выполняет неровно, а параметр speed — жёстко, поэтому работают
   оба: текстовая режиссура плюс числовой темп. */
const EMOTION_SPEED: Record<PatientEmotion, number> = {
  neutral: 1,
  irritated: 1.07,
  angry: 1.12,
  aggressive: 1.16,
  upset: 0.93,
  sarcastic: 0.95,
  cold: 0.97,
  anxious: 1.13,
  sad: 0.89,
};

export function speechSpeed(emotion?: PatientEmotion): number {
  return EMOTION_SPEED[emotion ?? "neutral"];
}

/* Инструкция тембра для TTS: базовый голос персоны + эмоция реплики + канал. */
export function speechInstructions(
  personaKey: string,
  emotion?: PatientEmotion,
  channel = "visual",
): string {
  const p = personaById(personaKey);
  const emo = emotion ?? "neutral";
  return [
    `Роль: ${p.voiceBase}.`,
    `Манера: ${p.speechStyle}.`,
    `Эмоция этой реплики — ${PATIENT_EMOTION_LABELS[emo]}: ${EMOTION_DIRECTION[emo]}.`,
    "Это живая устная речь в разговоре, а не чтение текста вслух. Никакой дикторской, новостной или рекламной интонации.",
    "Ставь дыхание и микропаузы там, где человек их делает: перед важным словом, после запятой, на стыке мыслей. Внутри фразы темп может меняться.",
    "Интонация фразы должна идти от смысла: вопрос — вверх, упрёк — с нажимом, признание — тише. Не выравнивай все фразы под один шаблон.",
    "Допустимы редкие естественные запинки и повторы одного слова, если они соответствуют эмоции. Не добавляй новых слов, вздохов, смеха и звуков, которых нет в тексте.",
    channel === "voice-only"
      ? "Это телефонный разговор: говори чуть ближе к микрофону, немного собраннее, иногда чуть громче, как человек, который старается, чтобы его было слышно."
      : "Это разговор лицом к лицу: голос свободный, без телефонной сдавленности.",
    "Сохраняй смысл и все факты реплики без изменений.",
  ].join(" ");
}

/* ---------- выбор осей с антиповтором ---------- */

function pickPersona(
  pool: string[],
  recent: ReturnType<typeof recentCombos>,
  mood: string,
): string {
  const lastPersonas = recent.slice(0, 3).map((r) => r.persona);
  const heavy = /агрессия|злость|холодная/.test(mood);
  let candidates = pool;
  const fresh = candidates.filter((k) => !lastPersonas.includes(k));
  if (fresh.length) candidates = fresh;
  const aged = heavy ? candidates.filter((k) => personaById(k).age >= 38) : candidates;
  const src = aged.length ? aged : candidates;
  return src[Math.floor(Math.random() * src.length)];
}

function pickMood(recent: ReturnType<typeof recentCombos>, pool: string[]): string {
  const lastMoods = recent.slice(0, 2).map((r) => r.mood);
  const avail = pool.filter((m) => !lastMoods.includes(m));
  const src = avail.length ? avail : pool;
  return src[Math.floor(Math.random() * src.length)];
}

function pickMotive(domainKey: string): MotiveDef {
  // Для плановой консультации «проверка границ» и «перенос стресса» уместны реже,
  // чем стыд и давление обстоятельств — они дают материал для сбора анамнеза.
  const pool =
    domainKey === "reception"
      ? MOTIVES.filter((m) => ["fear", "shame", "time-pressure", "past-negative", "control"].includes(m.kind))
      : MOTIVES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/* ---------- публичный API сервиса ---------- */

export type StartResult = SessionPublicDTO & {
  personaVoice: string;
  personaGender: "f" | "m";
};

export type StartInput = {
  domain?: string | null;
  category?: string | null;
  caseId?: string | null;
  mode?: SessionMode;
  format?: SessionFormat;
  assignmentId?: string | null;
};

/** Создать новую сцену: домен и кейс → оси → генератор → TTS опенера → БД. */
export async function startSession(
  user: AccountUser,
  input: StartInput = {},
): Promise<StartResult> {
  if (input.mode && !["practice", "exam"].includes(input.mode))
    throw new AuthError(400, "invalid_mode");
  if (input.format && !["short", "long"].includes(input.format))
    throw new AuthError(400, "invalid_format");

  const assignmentId = input.assignmentId ?? null;
  const mode: SessionMode = input.mode ?? (assignmentId ? "exam" : "practice");
  if ((mode === "exam" && !assignmentId) || (assignmentId && mode !== "exam"))
    throw new AuthError(400, "assignment_required_for_exam");

  /* Домен: явный выбор, иначе случайный из поддерживающих формат. */
  const requested = input.domain ? domainByKey(input.domain) : undefined;
  if (input.domain && !requested) throw new AuthError(400, "invalid_domain");

  const domain =
    requested ??
    (() => {
      const pool = domainsForFormat(input.format ?? "short");
      const src = pool.length ? pool : [...TRAINING_DOMAINS];
      return src[Math.floor(Math.random() * src.length)];
    })();

  /* Формат: уважаем выбор, но не даём просить недоступный у домена. */
  const format: SessionFormat =
    input.format && domain.formats.includes(input.format)
      ? input.format
      : domain.formats.includes("short")
        ? "short"
        : domain.formats[0];
  if (input.format && !domain.formats.includes(input.format))
    throw new AuthError(400, "format_not_supported");

  const cases = domain.cases;
  const recent = recentCombos(user.id, 10);

  /* Кейс: по id, по заголовку, иначе с антиповтором. */
  let selected =
    (input.caseId && cases.find((item) => item.id === input.caseId)) ||
    (input.category && cases.find((item) => item.title === input.category)) ||
    undefined;
  if ((input.caseId || input.category) && !selected)
    throw new AiError(
      "bad_request",
      `Кейс «${input.caseId ?? input.category}» недоступен в разделе «${domain.card.title}»`,
    );
  if (!selected) {
    const usedTitles = new Set(recent.slice(0, 6).map((r) => r.category));
    const fresh = cases.filter((item) => !usedTitles.has(item.title));
    const pool = fresh.length ? fresh : cases;
    selected = pool[Math.floor(Math.random() * pool.length)];
  }
  if (!selected) throw new AiError("unknown", "В домене нет ни одного кейса");

  if (assignmentId) {
    if (user.role !== "trainee") throw new AuthError(403, "student_required");
    const db = getDb();
    if (
      !db
        .prepare(
          `SELECT 1 FROM assignments a
             JOIN group_memberships m ON m.group_id = a.group_id
             JOIN catalog_assignment_cases c ON c.assignment_id = a.id
             WHERE a.id = ? AND m.student_id = ? AND c.domain_key = ? AND c.case_id = ?`,
        )
        .get(assignmentId, user.id, domain.key, selected.id)
    )
      throw new AuthError(404, "assignment_case_not_found");
    if (
      db
        .prepare(
          `SELECT 1 FROM catalog_assignment_attempts
             WHERE assignment_id = ? AND domain_key = ? AND case_id = ? AND student_id = ?`,
        )
        .get(assignmentId, domain.key, selected.id, user.id)
    )
      throw new AuthError(409, "attempt_already_used");
  }

  const category: ComplaintCategory = {
    title: selected.title,
    brief: selected.brief,
    seeds: [...selected.seeds],
  };

  const moodPool = domain.key === "reception" ? CALM_MOODS : MOODS;
  const mood = pickMood(recent, moodPool);
  const personaKey = pickPersona(personaPoolFor(selected), recent, mood);
  const persona = personaById(personaKey);
  const motive = pickMotive(domain.key);

  const recentSummary =
    recent
      .slice(0, 5)
      .map((r) => `${r.domain} / ${r.category} / ${r.mood}`)
      .join("; ") || "нет";

  const scenarioId = uid();
  const sessionId = uid();
  /* Лимит списывается ДО обращения к провайдеру и во всех режимах, не только
     на экзамене: генерация сцены и озвучка опенера — это уже потраченные
     деньги. Неудачный вызов провайдера лимит тоже расходует, иначе повтор
     в цикле обходит контроль расхода. */
  assertProviderReady();
  reserveRequest(user, "scenario", sessionId);
  const seed = category.seeds[Math.floor(Math.random() * category.seeds.length)];
  const caseFacts = { ...(selected.caseFacts ?? {}), seed };
  const exchangesLimit = exchangesFor(domain, format);

  const pick = await generateScenario({
    domainSlug: domain.key,
    domainTitle: domain.card.title,
    category,
    moodLabel: mood,
    persona,
    motive,
    recentSummary,
    exchangesLimit,
    requestId: `scn_${sessionId}`,
    domainKey: domain.key,
    caseId: selected.id,
    caseFacts,
    card: selected.card,
    format,
  });

  const now = Date.now();
  const stagePlan = format === "long" ? domain.stagePlan.stages : [];
  createScenario({
    id: scenarioId,
    domain: domain.card.title,
    category: category.title,
    category_slug: `${domain.key}-${slugify(category.title)}`,
    complaint_seed: `${category.title}: ${seed}`,
    mood_label: mood,
    persona_key: personaKey,
    patient_first: persona.firstName,
    patient_age: persona.age,
    opener_text: pick.openerText,
    opener_emotion: pick.openerEmotion,
    exchanges_limit: exchangesLimit,
    hidden_motive_json: JSON.stringify({
      kind: motive.kind,
      label: motive.label,
      description: motive.description,
      revealAtExchange: motive.revealAtExchange,
    } as HiddenMotive),
    twist_json: pick.twist ? JSON.stringify(pick.twist) : null,
    acting_notes: pick.actingNotes,
    domain_key: domain.key,
    case_id: selected.id,
    channel: domain.card.channel,
    case_facts_json: JSON.stringify(caseFacts),
    case_card_json: selected.card ? JSON.stringify(selected.card) : null,
    stage_plan_json: JSON.stringify(stagePlan),
    rubric_id: domain.rubricId,
    seed,
    created_at: now,
  });

  try {
    createSession(sessionId, scenarioId, user.id, {
      mode,
      format,
      deadlineAt: mode === "exam" ? now + EXAM_DURATION_MS : null,
      assignmentId,
      assignmentDomainKey: assignmentId ? domain.key : null,
      assignmentCaseId: assignmentId ? selected.id : null,
      assignmentMetadata: assignmentId
        ? { assignmentId, domainKey: domain.key, caseId: selected.id }
        : null,
      modelSnapshot: {
        chat: config.chatModel,
        evaluation: config.evalModel,
        tts: config.ttsModel,
      },
    });
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint/.test(error.message))
      throw new AuthError(409, "attempt_already_used");
    if (error instanceof Error && error.message === "assignment_case_not_found")
      throw new AuthError(404, error.message);
    throw error;
  }

  /* Открывающая реплика пишется сразу после сессии, до озвучки: сессия
     без первой реплики — битая, а озвучка может и не получиться. */
  insertMessage({
    id: uid(),
    session_id: sessionId,
    speaker: "patient",
    text: pick.openerText,
    emotion: pick.openerEmotion,
    source: "opener",
    idx: 0,
    created_at: now,
  });
  const audioKey = await trySpeech(pick.openerText, {
    voice: persona.voice,
    instructions: speechInstructions(personaKey, pick.openerEmotion, domain.card.channel),
    speed: speechSpeed(pick.openerEmotion),
  });

  recordCombo({
    id: uid(),
    userId: user.id,
    sessionId,
    domain: domain.card.title,
    category: category.title,
    mood,
    persona: personaKey,
  });

  return {
    sessionId,
    scenarioId,
    domain: domain.card.title,
    category: category.title,
    categorySlug: `${domain.key}-${slugify(category.title)}`,
    moodLabel: mood,
    patientFirst: persona.firstName,
    patientAge: persona.age,
    personaKey,
    exchangesLimit,
    exchangesDone: 0,
    opener: {
      text: pick.openerText,
      emotion: pick.openerEmotion,
      audioUrl: audioKey ? audioUrlForKey(audioKey) : null,
    },
    status: "active",
    createdAt: now,
    personaVoice: persona.voice,
    personaGender: persona.gender,
    ...publicMetadata(getSession(sessionId)!, getScenario(scenarioId)!),
  };
}

/**
 * Зарегистрировать ответ врача и получить реакцию пациента (или сигнал к оценке).
 *
 * Ход атомарен с точки зрения студента: если собеседник не смог ответить
 * (сбой провайдера), реплика врача откатывается и ход можно повторить —
 * он не «сгорает» и не задваивается в транскрипте.
 */
export async function continueSession(
  user: AccountUser,
  sessionId: string,
  doctorText: string,
  source: MessageSource,
): Promise<PatientTurnOutcome | { kind: "eval_ready" }> {
  const session = expire(owned(user, sessionId));
  if (session.status === "aborted")
    throw new AiError("timeout", "Время экзамена истекло — сессия закрыта");
  if (session.status !== "active")
    throw new AiError("bad_request", "Сессия уже завершена");
  const scenario = getScenario(session.scenario_id);
  if (!scenario) throw new AiError("unknown", "Сценарий не найден");

  const text = doctorText.trim().replace(/\s+/g, " ");
  if (!text) throw new AiError("bad_request", "Пустой ответ врача");
  if (text.length > 4000) throw new AiError("bad_request", "Ответ слишком длинный");

  /* Один ход за раз. Между чтением сессии выше и этой строкой нет await,
     поэтому второй запрос (двойной клик, вторая вкладка) не прочитает тот
     же счётчик и не отправит собеседнику две реплики подряд. */
  if (turnsInFlight.has(sessionId)) throw new AuthError(409, "turn_in_progress");
  turnsInFlight.add(sessionId);
  try {
    return await runTurn(user, session, scenario, text, source);
  } finally {
    turnsInFlight.delete(sessionId);
  }
}

async function runTurn(
  user: AccountUser,
  session: SessionRow,
  scenario: ScenarioRow,
  text: string,
  source: MessageSource,
): Promise<PatientTurnOutcome | { kind: "eval_ready" }> {
  const sessionId = session.id;
  const done = session.exchanges_done + 1;
  const exchangesLimit = scenario.exchanges_limit;
  const isFinal = done >= exchangesLimit;
  const stages = stagePlanOf(scenario);
  const nextStage = stages.length ? stageIndex(done, exchangesLimit, stages) : null;
  const currentStage = nextStage === null ? null : stages[nextStage];

  /* Последний ответ врача собеседнику не отправляется — он только запускает
     разбор, поэтому и лимит не тратит. Остальные ходы платные; ключ с
     номером попытки позволяет повторить ход после сбоя провайдера. */
  if (!isFinal) {
    assertProviderReady();
    const turnKey = `${sessionId}_${done}`;
    const attempt = countRequests(user, "turn", turnKey);
    if (attempt >= TURN_ATTEMPT_LIMIT) throw new AuthError(429, "turn_attempts_exhausted");
    if (!reserveRequest(user, "turn", attempt === 0 ? turnKey : `${turnKey}#${attempt}`))
      throw new AuthError(409, "duplicate_request");
  }

  const messages = listMessages(sessionId);
  const doctorMessage: MessageRow = {
    id: uid(),
    session_id: sessionId,
    speaker: "doctor",
    text,
    emotion: null,
    source,
    idx: nextMessageIdx(sessionId),
    created_at: Date.now(),
  };
  recordDoctorTurn(doctorMessage, nextStage);

  if (isFinal) {
    setSessionStatus(sessionId, "evaluating");
    return { kind: "eval_ready" };
  }

  // «Живой пациент» отвечает
  const ctx = scenarioFromRow(scenario);
  const persona = personaById(ctx.personaKey);
  const dtoMessages: MessageDTO[] = [...messages, doctorMessage].map((m) => ({
    id: m.id,
    speaker: m.speaker as MessageDTO["speaker"],
    text: m.text,
    emotion: (m.emotion as PatientEmotion | null) ?? null,
    source: m.source as MessageSource,
    audioUrl: null,
    idx: m.idx,
    createdAt: m.created_at,
  }));

  const actingNotes = currentStage
    ? [
        ctx.actingNotes,
        `Разговор идёт по плану: ${stages.map((stage) => stage.title).join(" → ")}.`,
        `Сейчас этап «${currentStage.title}»${currentStage.goal ? `: ${currentStage.goal}` : ""} — но инициатива за специалистом, сам этапы не объявляй.`,
      ].join("\n")
    : ctx.actingNotes;

  let reply: Awaited<ReturnType<typeof producePatientLine>>;
  try {
    reply = await producePatientLine({
      personaKey: ctx.personaKey,
      domainTitle: scenario.domain,
      complaintSeed: ctx.complaintSeed,
      openerText: ctx.openerText,
      openerEmotion: ctx.openerEmotion,
      hiddenMotive: ctx.hiddenMotive,
      actingNotes,
      twist: ctx.twist,
      actorTurnIndex: done,
      transcript: dtoMessages,
      exchangesLimit,
      domainKey: scenario.domain_key ?? undefined,
      caseFacts: parseJson<Record<string, unknown>>(scenario.case_facts_json ?? null, {}),
      card: cardOf(scenario) ?? undefined,
      stage: currentStage,
      requestId: `ptn_${sessionId}_${done}`,
    });
  } catch (error) {
    revertDoctorTurn(sessionId, doctorMessage.id, session.stage_index);
    throw error;
  }

  const audioKey = await trySpeech(reply.text, {
    voice: persona.voice,
    instructions: speechInstructions(ctx.personaKey, reply.emotion, scenario.channel ?? "visual"),
    speed: speechSpeed(reply.emotion),
  });
  if (expire(owned(user, sessionId)).status === "aborted")
    throw new AiError("timeout", "Время экзамена истекло");
  insertMessage({
    id: uid(),
    session_id: sessionId,
    speaker: "patient",
    text: reply.text,
    emotion: reply.emotion,
    source: "actor",
    idx: nextMessageIdx(sessionId),
    created_at: Date.now(),
  });

  return {
    kind: "patient",
    text: reply.text,
    emotion: reply.emotion,
    audioUrl: audioKey ? audioUrlForKey(audioKey) : null,
    isFinalPatientLine: done + 1 >= exchangesLimit,
  };
}

/**
 * Полный разбор диалога AI-оценщиком; результат сохраняется гранулярно.
 * Повторный запрос во время разбора (вторая вкладка, двойной эффект
 * React в dev) ждёт тот же результат, а не получает 409 и не платит дважды.
 */
export async function evaluateSession(
  user: AccountUser,
  sessionId: string,
): Promise<EvaluationDTO> {
  const session = expire(owned(user, sessionId));
  const stored = evaluationDTO(sessionId);
  if (stored) return evaluationFor(session, stored);
  if (session.status === "active")
    throw new AiError("bad_request", "Сессия ещё не завершена");
  if (session.status === "aborted")
    throw new AiError("bad_request", "Сессия прервана по таймауту");

  let job = evaluationsInFlight.get(sessionId);
  if (!job) {
    job = runEvaluation(user, session);
    evaluationsInFlight.set(sessionId, job);
    // Запись снимается в любом исходе; ошибка при этом уходит вызывающим ниже.
    void job.catch(() => undefined).finally(() => evaluationsInFlight.delete(sessionId));
  }
  return evaluationFor(session, await job);
}

async function runEvaluation(user: AccountUser, session: SessionRow): Promise<EvaluationDTO> {
  const sessionId = session.id;
  /* Разбор оплачивается попытками. Ключ с номером попытки нужен потому, что
     сорвавшийся вызов провайдера иначе навсегда закрыл бы студенту доступ к
     собственному отчёту: успешный разбор кэшируется и повторно не платится. */
  assertProviderReady();
  const attempt = countRequests(user, "evaluation", sessionId);
  if (attempt >= EVAL_ATTEMPT_LIMIT) throw new AuthError(429, "evaluation_attempts_exhausted");
  if (!reserveRequest(user, "evaluation", attempt === 0 ? sessionId : `${sessionId}#${attempt}`))
    throw new AuthError(409, "duplicate_request");
  const scenario = getScenario(session.scenario_id);
  if (!scenario) throw new AiError("unknown", "Сценарий не найден");

  const rows = listMessages(sessionId);
  const ctx = scenarioFromRow(scenario);
  const evalMessages: EvalMessage[] = rows
    .filter((m) => m.speaker === "patient" || m.speaker === "doctor")
    .map((m) => ({
      speaker: m.speaker as "patient" | "doctor",
      text: m.text,
      emotion: (m.emotion as PatientEmotion | null) ?? null,
    }));

  const card = cardOf(scenario);
  const doctorLines = evalMessages
    .filter((message) => message.speaker === "doctor")
    .map((message) => message.text);
  const coverage = card ? computeCoverage(card, doctorLines) : null;

  const verdict = await evaluateDialogue({
    domainTitle: scenario.domain,
    categoryTitle: scenario.category,
    personaKey: scenario.persona_key,
    patientFirst: scenario.patient_first,
    patientAge: scenario.patient_age,
    moodLabel: scenario.mood_label,
    complaintSeed: ctx.complaintSeed,
    openerText: ctx.openerText,
    hiddenMotive: ctx.hiddenMotive,
    actingNotes: ctx.actingNotes,
    messages: evalMessages,
    domainKey: scenario.domain_key ?? undefined,
    caseFacts: parseJson<Record<string, unknown>>(scenario.case_facts_json ?? null, {}),
    rubricId: scenario.rubric_id ?? undefined,
    card: card ?? undefined,
    coverage: coverage ?? undefined,
    stages: stagePlanOf(scenario),
    format: session.format,
    requestId: `eval_${sessionId}`,
  });

  saveEvaluation({
    id: uid(),
    sessionId,
    model: config.evalModel,
    overallSummary: verdict.overallSummary,
    safetyFlag: verdict.safetyFlag,
    flags: verdict.flags,
    coverage: verdict.coverage,
    criteria: verdict.criteria.map((c) => ({
      name: c.name,
      framework: c.framework,
      score: c.score,
      maxScore: c.maxScore,
      evidenceQuote: c.evidenceQuote,
      explanation: c.explanation,
    })),
  });
  return evaluationDTO(sessionId)!;
}

/** Возобновление: текущее состояние сессии с сообщениями и (если была) оценкой. */
export function resumeSession(user: AccountUser, sessionId: string) {
  const session = expire(owned(user, sessionId));
  const scenario = getScenario(session.scenario_id)!;
  const channel = scenario.channel ?? "visual";
  const rows = listMessages(sessionId);
  const messages = rows.map((m) => messageToDTO(m, scenario.persona_key, channel));
  const stored = session.status === "done" ? evaluationDTO(sessionId) : null;
  const evaluation = stored ? evaluationFor(session, stored) : null;

  return {
    session: {
      sessionId,
      scenarioId: session.scenario_id,
      domain: scenario.domain,
      category: scenario.category,
      categorySlug: scenario.category_slug,
      moodLabel: scenario.mood_label,
      patientFirst: scenario.patient_first,
      patientAge: scenario.patient_age,
      personaKey: scenario.persona_key,
      exchangesLimit: scenario.exchanges_limit,
      exchangesDone: session.exchanges_done,
      opener:
        messages.find((m) => m.speaker === "patient" && m.source === "opener") ?? null,
      status: session.status as SessionPublicDTO["status"],
      createdAt: session.created_at,
      ...publicMetadata(session, scenario),
    } as SessionPublicDTO,
    messages,
    evaluation,
  };
}

export function history(user: AccountUser): {
  rows: HistoryRowLike[];
  stats: { total: number; done: number };
} {
  const raw = historyForUser(user.id, 80);
  const rows: HistoryRowLike[] = raw.map((r) => ({
    sessionId: r.session_id,
    domain: r.domain,
    category: r.category,
    categorySlug: r.category_slug,
    moodLabel: r.mood_label,
    patientFirst: r.patient_first,
    createdAt: r.created_at,
    exchangesDone: r.exchanges_done,
    totalScore: r.total_score ?? 0,
    maxScore: r.max_score ?? 0,
    overallSummary: r.overall_summary ?? "",
    hasSafetyFlag: Boolean(r.has_safety_flag),
    mode: (r.mode ?? "practice") as SessionMode,
    format: (r.format ?? "short") as SessionFormat,
  }));
  return {
    rows,
    stats: {
      total: raw.length,
      done: raw.filter((r) => r.status === "done").length,
    },
  };
}

type HistoryRowLike = {
  sessionId: string;
  domain: string;
  category: string;
  categorySlug: string;
  moodLabel: string;
  patientFirst: string;
  createdAt: number;
  exchangesDone: number;
  totalScore: number;
  maxScore: number;
  overallSummary: string;
  hasSafetyFlag: boolean;
  mode: SessionMode;
  format: SessionFormat;
};
export type { HistoryRowLike };
