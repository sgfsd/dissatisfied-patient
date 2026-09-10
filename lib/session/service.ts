import {
  bumpExchanges, createScenario, createSession, getEvaluationBySession, getScenario,
  getSession, historyForUser, insertMessage, listMessages, nextMessageIdx, recordCombo,
  recentCombos, saveEvaluation, setSessionStatus, uid,
  type HistoryQueryRow, type MessageRow, type ScenarioRow, type SessionRow,
} from '../db';
import { config } from '../config';
import { AiError } from '../ai/errors';
import { PATIENT_EMOTION_LABELS, type EvaluationDTO, type HiddenMotive,
  type MessageDTO, type MessageSource, type PatientEmotion, type PatientTurnOutcome,
  type SessionPublicDTO, type TwistPlan } from '../types';
import { type EvalMessage } from '../evaluation/evaluator';
import { personaById } from '../personas';
import { DOMAINS, MOTIVES, MOODS, complaintCategoriesFor, domainBySlug, type DomainSlug, type MotiveDef } from '../scenarios/axes';
import { generateScenario } from '../scenarios/generate';
import { producePatientLine } from '../scenarios/actor';
import { ensureSpeech, hasSpeech, speechCacheKey } from '../speech';
import { evaluateDialogue } from '../evaluation/evaluator';

const LOCAL_USER = 'local';

/* ---------- помощники ---------- */

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
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
    hiddenMotive: parseJson<HiddenMotive>(r.hidden_motive_json, { kind: '', label: '', description: '', revealAtExchange: null }),
    twist: parseJson<TwistPlan | null>(r.twist_json, null),
    actingNotes: r.acting_notes,
  };
}

function messageToDTO(m: MessageRow, personaKey: string): MessageDTO {
  const persona = personaById(personaKey);
  let audioUrl: string | null = null;
  if (m.speaker === 'patient' && m.text) {
    const instructions = speechInstructions(personaKey, (m.emotion as PatientEmotion | null) ?? undefined);
    const key = speechCacheKey(m.text, { voice: persona.voice, model: config.ttsModel, instructions });
    // Ссылку на аудио отдаём только если mp3 реально лежит в кэше: иначе клиент
    // получит мёртвый URL (404) и реплей/автопроигрывание сломаются беззвучно.
    if (hasSpeech(key)) audioUrl = `/api/audio/${key}`;
  }
  return {
    id: m.id, speaker: m.speaker as MessageDTO['speaker'], text: m.text,
    emotion: (m.emotion as PatientEmotion | null) ?? null,
    source: m.source as MessageSource, audioUrl, idx: m.idx, createdAt: m.created_at,
  };
}

/* Инструкция тембра для TTS: базовый голос персоны + эмоция реплики. */
export function speechInstructions(personaKey: string, emotion?: PatientEmotion): string {
  const p = personaById(personaKey);
  const emo = emotion ? ` Эмоция реплики: ${PATIENT_EMOTION_LABELS[emotion]}.` : '';
  return `${p.voiceBase}.${emo}`;
}

/* ---------- выбор осей с антиповтором ---------- */

function pickPersona(domainPool: string[], recent: ReturnType<typeof recentCombos>, mood: string): string {
  const lastPersonas = recent.slice(0, 3).map((r) => r.persona);
  // тяжёлые эмоции лучше ложатся на «взрослых» персонажей — но не жёстко
  const heavy = /агрессия|злость|холодная/.test(mood);
  let pool = domainPool;
  const shortlist = pool.filter((k) => !lastPersonas.includes(k));
  if (shortlist.length) pool = shortlist;
  const candidates = heavy ? pool.filter((k) => personaById(k).age >= 38) : pool;
  const src = candidates.length ? candidates : pool;
  return src[Math.floor(Math.random() * src.length)];
}

function pickMood(recent: ReturnType<typeof recentCombos>): string {
  const lastMoods = recent.slice(0, 2).map((r) => r.mood);
  const avail = MOODS.filter((m) => !lastMoods.includes(m));
  return (avail.length ? avail : MOODS)[Math.floor(Math.random() * (avail.length ? avail.length : MOODS.length))];
}

function pickMotive(): MotiveDef {
  return MOTIVES[Math.floor(Math.random() * MOTIVES.length)];
}

/* ---------- публичный API сервиса ---------- */

export type StartResult = SessionPublicDTO & { personaVoice: string; personaGender: 'f' | 'm' };

/** Создать новую сцену: оси → генератор → TTS открывающей реплики → запись в БД. */
export async function startSession(domainSlug?: string | null, categoryTitle?: string | null): Promise<StartResult> {
  const domain =
    (domainSlug && domainBySlug(domainSlug)) || DOMAINS[Math.floor(Math.random() * DOMAINS.length)];
  const recent = recentCombos(LOCAL_USER, 10);
  const recentKeys = new Set(recent.slice(0, 6).map((r) => `${r.domain}|${r.category}|${r.mood}`));

  const categories = complaintCategoriesFor(domain.slug);
  // Явный выбор категории пользователем — уважаем и не заменяем «антиповтором».
  if (categoryTitle) {
    const explicit = categories.find((c) => c.title === categoryTitle);
    if (!explicit) {
      throw new AiError('bad_request', `Категория «${categoryTitle}» недоступна в разделе «${domain.title}»`);
    }
    const category = explicit;
    return startWithPick(domain, category, recent);
  }
  const fresh = categories.filter((c) => !recentKeys.has(`${domain.slug}|${c.title}`));
  const poolCats = fresh.length ? fresh : categories;
  const category = poolCats[Math.floor(Math.random() * poolCats.length)];
  return startWithPick(domain, category, recent);
}

async function startWithPick(
  domain: ReturnType<typeof domainBySlug> & object,
  category: ReturnType<typeof complaintCategoriesFor>[number],
  recent: ReturnType<typeof recentCombos>
): Promise<StartResult> {
  const recentKeys = new Set(recent.slice(0, 6).map((r) => `${r.domain}|${r.category}|${r.mood}`));

  const mood = pickMood(recent);
  const personaKey = pickPersona(domain.personaPool, recent, mood);
  const persona = personaById(personaKey);
  const motive = pickMotive();

  const recentSummary =
    recent
      .slice(0, 5)
      .map((r) => `${r.domain} / ${r.category} / ${r.mood}`)
      .join('; ') || 'нет';

  const scenarioId = uid();
  const sessionId = uid();
  const requestId = `scn_${sessionId}`;

  const pick = await generateScenario({
    domainSlug: domain.slug,
    domainTitle: domain.title,
    category,
    moodLabel: mood,
    persona,
    motive,
    recentSummary,
    exchangesLimit: config.exchanges,
    requestId,
  });

  const now = Date.now();
  createScenario({
    id: scenarioId, domain: domain.title, category: category.title, category_slug: `${domain.slug}-${slugify(category.title)}`,
    complaint_seed: `${category.title}: ${category.seeds[Math.floor(Math.random() * category.seeds.length)]}`,
    mood_label: mood, persona_key: personaKey, patient_first: persona.firstName, patient_age: persona.age,
    opener_text: pick.openerText, opener_emotion: pick.openerEmotion,
    exchanges_limit: config.exchanges,
    hidden_motive_json: JSON.stringify({
      kind: motive.kind, label: motive.label, description: motive.description, revealAtExchange: motive.revealAtExchange,
    } as HiddenMotive),
    twist_json: pick.twist ? JSON.stringify(pick.twist) : null,
    acting_notes: pick.actingNotes,
    created_at: now,
  });

  createSession(sessionId, scenarioId, LOCAL_USER);

  // Открывающая реплика пациента
  const openerMsgId = uid();
  const openerText = pick.openerText;
  const instructions = speechInstructions(personaKey, pick.openerEmotion);
  const audioKey = await ensureSpeech(openerText, { voice: persona.voice, instructions });
  insertMessage({
    id: openerMsgId, session_id: sessionId, speaker: 'patient', text: openerText,
    emotion: pick.openerEmotion, source: 'opener', idx: 0, created_at: now,
  });

  recordCombo({
    id: uid(), userId: LOCAL_USER, sessionId,
    domain: domain.title, category: category.title, mood, persona: personaKey,
  });

  return {
    sessionId, scenarioId,
    domain: domain.title, category: category.title, categorySlug: `${domain.slug}-${slugify(category.title)}`,
    moodLabel: mood, patientFirst: persona.firstName, patientAge: persona.age, personaKey,
    exchangesLimit: config.exchanges, exchangesDone: 0,
    opener: { text: openerText, emotion: pick.openerEmotion, audioUrl: `/api/audio/${audioKey}` },
    status: 'active', createdAt: now,
    personaVoice: persona.voice, personaGender: persona.gender,
  };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/** Зарегистрировать ответ врача и получить реакцию пациента (или сигнал к оценке). */
export async function continueSession(
  sessionId: string,
  doctorText: string,
  source: MessageSource
): Promise<PatientTurnOutcome | { kind: 'eval_ready' }> {
  const session = getSession(sessionId);
  if (!session) throw new AiError('bad_request', 'Сессия не найдена');
  if (session.status !== 'active') throw new AiError('bad_request', 'Сессия уже завершена');
  const scenario = getScenario(session.scenario_id);
  if (!scenario) throw new AiError('unknown', 'Сценарий не найден');

  const text = doctorText.trim().replace(/\s+/g, ' ');
  if (!text) throw new AiError('bad_request', 'Пустой ответ врача');
  if (text.length > 4000) throw new AiError('bad_request', 'Ответ слишком длинный');

  const messages = listMessages(sessionId);
  insertMessage({
    id: uid(), session_id: sessionId, speaker: 'doctor', text,
    emotion: null, source, idx: nextMessageIdx(sessionId), created_at: Date.now(),
  });
  bumpExchanges(sessionId);
  const done = session.exchanges_done + 1;

  if (done >= scenario.exchanges_limit) {
    setSessionStatus(sessionId, 'evaluating');
    return { kind: 'eval_ready' };
  }

  // «Живой пациент» отвечает
  const ctx = scenarioFromRow(scenario);
  const persona = personaById(ctx.personaKey);
  const dtoMessages: MessageDTO[] = messages
    .concat({ id: '', session_id: sessionId, speaker: 'doctor', text, emotion: null, source, idx: done + 50, created_at: 0 })
    .map((m) => ({
      id: m.id, speaker: m.speaker as MessageDTO['speaker'], text: m.text,
      emotion: (m.emotion as PatientEmotion | null) ?? null,
      source: m.source as MessageSource,
      audioUrl: null, idx: m.idx, createdAt: m.created_at,
    }));

  const actorTurnIndex = done; // 1-я ответная реплика пациента = после первого ответа врача
  const reply = await producePatientLine({
    personaKey: ctx.personaKey,
    domainTitle: scenario.domain,
    complaintSeed: ctx.complaintSeed,
    openerText: ctx.openerText,
    openerEmotion: ctx.openerEmotion,
    hiddenMotive: ctx.hiddenMotive,
    actingNotes: ctx.actingNotes,
    twist: ctx.twist,
    actorTurnIndex,
    transcript: dtoMessages,
    exchangesLimit: ctx.exchangesLimit,
    requestId: `ptn_${sessionId}_${done}`,
  });

  const instructions = speechInstructions(ctx.personaKey, reply.emotion);
  const audioKey = await ensureSpeech(reply.text, { voice: persona.voice, instructions });
  const idx = nextMessageIdx(sessionId);
  insertMessage({
    id: uid(), session_id: sessionId, speaker: 'patient', text: reply.text,
    emotion: reply.emotion, source: 'actor', idx, created_at: Date.now(),
  });

  return {
    kind: 'patient', text: reply.text, emotion: reply.emotion,
    audioUrl: `/api/audio/${audioKey}`,
    isFinalPatientLine: done + 1 >= scenario.exchanges_limit,
  };
}

/** Полный разбор диалога AI-оценщиком; результат сохраняется гранулярно. */
export async function evaluateSession(sessionId: string): Promise<EvaluationDTO> {
  const session = getSession(sessionId);
  if (!session) throw new AiError('bad_request', 'Сессия не найдена');
  const scenario = getScenario(session.scenario_id);
  if (!scenario) throw new AiError('unknown', 'Сценарий не найден');
  const rows = listMessages(sessionId);
  const persona = personaById(scenario.persona_key);
  const ctx = scenarioFromRow(scenario);

  const evalMessages: EvalMessage[] = rows
    .filter((m) => m.speaker === 'patient' || m.speaker === 'doctor')
    .map((m) => ({
      speaker: m.speaker as 'patient' | 'doctor',
      text: m.text,
      emotion: (m.emotion as PatientEmotion | null) ?? null,
    }));

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
    requestId: `eval_${sessionId}`,
  });

  const evalId = uid();
  saveEvaluation({
    id: evalId, sessionId,
    model: config.evalModel,
    overallSummary: verdict.overallSummary,
    safetyFlag: verdict.safetyFlag,
    flags: verdict.flags,
    criteria: verdict.criteria.map((c) => ({
      name: c.name, framework: c.framework, score: c.score, maxScore: c.maxScore,
      evidenceQuote: c.evidenceQuote, explanation: c.explanation,
    })),
  });
  void persona;
  return getEvaluationDTO(sessionId)!;
}

function getEvaluationDTO(sessionId: string): EvaluationDTO | null {
  const row = getEvaluationBySession(sessionId);
  if (!row) return null;
  const { evaluation, criteria } = row;
  const totalScore = criteria.reduce((s, c) => s + c.score, 0);
  const maxScore = criteria.reduce((s, c) => s + c.max_score, 0);
  return {
    evaluationId: evaluation.id,
    model: evaluation.model,
    criteria: criteria.map((c) => ({
      id: '', name: c.name, framework: c.framework, score: c.score, maxScore: c.max_score,
      evidenceQuote: c.evidence_quote, explanation: c.explanation,
    })),
    overallSummary: evaluation.overall_summary,
    safetyFlag: evaluation.safety_flag,
    flags: parseJson<string[]>(evaluation.flags_json, []),
    createdAt: evaluation.created_at,
    totalScore, maxScore,
  };
}

/** Возобновление: текущее состояние сессии с сообщениями и (если была) оценкой. */
export function resumeSession(sessionId: string) {
  const session = getSession(sessionId);
  if (!session) throw new AiError('bad_request', 'Сессия не найдена');
  const scenario = getScenario(session.scenario_id)!;
  const ctx = scenarioFromRow(scenario);
  const rows = listMessages(sessionId);
  const messages = rows.map((m) => messageToDTO(m, scenario.persona_key));
  const evaluation = session.status === 'done' ? getEvaluationDTO(sessionId) : null;

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
      opener: messages.find((m) => m.speaker === 'patient' && m.source === 'opener') ?? null,
      status: session.status as 'active' | 'done',
      createdAt: session.created_at,
    } as SessionPublicDTO,
    messages,
    evaluation,
  };
}

export function history(): { rows: HistoryRowLike[]; stats: { total: number; done: number } } {
  const raw = historyForUser(LOCAL_USER, 80);
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
    overallSummary: r.overall_summary ?? '',
    hasSafetyFlag: Boolean(r.has_safety_flag),
  }));
  return { rows, stats: { total: raw.length, done: raw.filter((r) => r.status === 'done').length } };
}

type HistoryRowLike = {
  sessionId: string; domain: string; category: string; categorySlug: string; moodLabel: string;
  patientFirst: string; createdAt: number; exchangesDone: number;
  totalScore: number; maxScore: number; overallSummary: string; hasSafetyFlag: boolean;
};
export type { HistoryRowLike };
