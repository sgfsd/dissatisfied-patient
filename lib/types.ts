/* ============================================================
   Общие типы Vera Practice
   ============================================================ */

/** Эмоциональные состояния пациента, которые умеет показывать аватар. */
export type PatientEmotion =
  | 'neutral'
  | 'irritated'
  | 'angry'
  | 'aggressive'
  | 'upset'
  | 'sarcastic'
  | 'cold'
  | 'anxious'
  | 'sad';

export const PATIENT_EMOTION_LABELS: Record<PatientEmotion, string> = {
  neutral: 'спокойствие',
  irritated: 'раздражение',
  angry: 'злость',
  aggressive: 'агрессия',
  upset: 'слёзы, растерянность',
  sarcastic: 'сарказм',
  cold: 'ледяная вежливость',
  anxious: 'тревога',
  sad: 'подавленность',
};

export const MOOD_EMOTION: Record<string, PatientEmotion> = {
  раздражение: 'irritated',
  злость: 'angry',
  агрессия: 'aggressive',
  'слёзы и растерянность': 'upset',
  сарказм: 'sarcastic',
  'холодная вежливость': 'cold',
  тревога: 'anxious',
  растерянность: 'anxious',
};

/** Кто говорит в диалоге. */
export type Speaker = 'patient' | 'doctor' | 'system';

/** Откуда взялся текст реплики пациента или врача. */
export type MessageSource =
  | 'opener'      // открывающая жалоба из сценария
  | 'actor'       // «живой» ответ пациента, сгенерированный моделью
  | 'stt'         // речь врача, распознанная
  | 'typed';      // врач ввёл текст руками

export interface MessageDTO {
  id: string;
  speaker: Speaker;
  text: string;
  emotion: PatientEmotion | null;
  source: MessageSource;
  /** Если у реплики пациента есть озвучка — путь к mp3 (GET /api/audio/<key>.mp3). */
  audioUrl: string | null;
  idx: number;
  createdAt: number;
}

/** Скрытый мотив — пользователю в интерфейсе не показывается. */
export interface HiddenMotive {
  kind: string;
  label: string; // короткая подпись для внутренних целей/истории
  description: string;
  revealAtExchange: number | null; // на каком обмене может вскрыться
}

/** Твист сцены (внутренний, пользователю не показывается). */
export interface TwistPlan {
  exchangeIndex: number; // после какого ответа врача происходит сдвиг
  shift: string;         // как меняется поведение/эмоция
  hint: string;          // подсказка актёру, как сыграть
}

/** Полный «сценарий» сессии — то, что генерирует модель. Частично скрытое. */
export interface ScenarioDoc {
  domain: string;          // «Терапия» / «Хирургия» / ...
  category: string;        // «Очередь и организация приёма»
  categorySlug: string;
  complaintSeed: string;   // завязка (видна пациенту)
  moodLabel: string;       // стартовая эмоция (видна)
  personaKey: string;
  patientFirst: string;
  patientAge: number;
  /** Открывающая реплика пациента — звучит и показывается субтитрами. */
  opener: { text: string; emotion: PatientEmotion };
  exchangesLimit: number;  // сколько ответов врача ожидается
  hiddenMotive: HiddenMotive;
  twist: TwistPlan | null;
  actingNotes: string;     // инструкция для «актёра» (не видна пользователю)
}

/** Клиентский срез сцены — без скрытого мотива, твиста и актёрских указаний. */
export interface SessionPublicDTO {
  sessionId: string;
  scenarioId: string;
  domain: string;
  category: string;
  categorySlug: string;
  moodLabel: string;
  patientFirst: string;
  patientAge: number;
  personaKey: string;
  exchangesLimit: number;
  exchangesDone: number;
  /** audioUrl — null, если озвучка не удалась: реплика показывается текстом. */
  opener: { text: string; emotion: PatientEmotion; audioUrl: string | null };
  status: 'active' | 'evaluating' | 'done' | 'aborted';
  createdAt: number;
  /* Метаданные движка: домен, кейс, канал, режим и этапы — их добавляет publicMetadata. */
  domainKey?: string;
  caseId?: string | null;
  channel?: ScenarioChannel;
  framework?: string | null;
  mode?: SessionMode;
  format?: SessionFormat;
  stageIndex?: number;
  stages?: StageDef[];
  deadlineAt?: number | null;
  assignmentId?: string | null;
  /** Потолок одной голосовой записи, секунды (RECORD_MAX_SECONDS). */
  recordMaxSeconds?: number;
}

/** Элемент рубрики — привязан к признанному стандарту коммуникации. */
export interface CriterionDef {
  id: string;
  name: string;
  framework: string;          // NURSE / Calgary–Cambridge / Beauchamp & Childress / SPIKES
  scale: 2 | 3;
  /** Что проверяется. Точная формулировка для LLM. */
  verify: string;
}

/** Учебные домены нового реестра. Старые отделения разрешаются через aliases. */
export type TrainingDomainKey =
  | 'conflict'
  | 'bad-news'
  | 'consent-ethics'
  | 'motivation'
  | 'error-disclosure'
  | 'family'
  | 'barriers'
  | 'call-center'
  | 'reception';

export type ScenarioChannel = 'visual' | 'voice-only';

/** Режим прохождения: практика — сколько угодно раз, экзамен — один заход. */
export type SessionMode = 'practice' | 'exam';
/** Формат: короткая сцена или полная консультация «регистратура → выписка». */
export type SessionFormat = 'short' | 'long';

export interface DomainCardSchema {
  title: string;
  short: string;
  accent: string;
  channel: ScenarioChannel;
  framework: string;
}

/* ---------- Скрытая карточка кейса ---------- */

/**
 * Домен опроса. Единая таксономия для двух вещей сразу: покрытия анамнеза
 * в длинной консультации и идентификации звонящего в колл-центре. Оценка
 * «что спросил — что пропустил» считается по ней детерминированно, без LLM.
 */
export type ProbeDomain =
  | 'identity'
  | 'reason'
  | 'onset'
  | 'character'
  | 'severity'
  | 'timing'
  | 'triggers'
  | 'associated'
  | 'red-flags'
  | 'history'
  | 'medication'
  | 'allergy'
  | 'family-history'
  | 'social'
  | 'ice'
  | 'logistics';

export const PROBE_LABELS: Record<ProbeDomain, string> = {
  identity: 'Идентификация собеседника',
  reason: 'Повод обращения',
  onset: 'Начало: когда и с чего',
  character: 'Характер жалобы',
  severity: 'Выраженность',
  timing: 'Динамика и длительность',
  triggers: 'Что усиливает и что облегчает',
  associated: 'Сопутствующие симптомы',
  'red-flags': 'Тревожные признаки',
  history: 'Перенесённые болезни и операции',
  medication: 'Принимаемые препараты',
  allergy: 'Аллергии и непереносимость',
  'family-history': 'Семейный анамнез',
  social: 'Быт, работа, привычки',
  ice: 'Представления, тревоги и ожидания',
  logistics: 'Маршрут, документы, запись',
};

/**
 * Один скрытый факт из карточки. Пациент сообщает его правдиво, но только
 * когда врач действительно об этом спросил: совпадение ищется по `cues`
 * в репликах врача. Авторского дерева диалога нет — есть факты и правила.
 */
export interface CaseFact {
  id: string;
  probe: ProbeDomain;
  /** Как факт называется в отчёте: «аллергия на пенициллин». */
  label: string;
  /** Что именно пациент говорит, если спросили. */
  value: string;
  /** Подстроки вопроса врача, по которым факт считается запрошенным. */
  cues: string[];
  /** Пропуск такого факта — существенная ошибка сбора. */
  critical?: boolean;
  /** Пациент выдаёт сам, без вопроса (входит в открывающую жалобу). */
  volunteered?: boolean;
}

/** Полная скрытая карточка кейса: то, что знает ИИ-пациент, но не знает врач. */
export interface CaseCard {
  /** Внутренняя сводка для «режиссёра» сцены. */
  headline: string;
  /** С чем человек обращается — видно сразу. */
  presenting: string;
  facts: CaseFact[];
  /** Признаки, которые обязаны быть отработаны, если врач до них добрался. */
  redFlags: string[];
  /** Что должно прозвучать в плане — ориентир для оценщика. */
  expectedPlan: string[];
  /** Сеть безопасности: при каких признаках вернуться/вызвать помощь. */
  safetyNet: string[];
}

export interface DomainCaseDef {
  id: string;
  title: string;
  brief: string;
  seeds: string[];
  caseFacts?: Record<string, string | number | boolean | string[]>;
  /** Скрытая карточка: анамнез длинной консультации или данные звонящего. */
  card?: CaseCard;
  /** Персонажи, которым кейс подходит по возрасту и роли. */
  personaPool?: string[];
}

export interface StageDef {
  id: string;
  title: string;
  required: boolean;
  /** Что именно должно произойти на этапе — подсказка актёру и оценщику. */
  goal?: string;
}

export interface StagePlanCapability {
  enabled: boolean;
  stages: StageDef[];
}

export interface CalibrationExample {
  title: string;
  patient: string;
  clinician: string;
  assessment: string;
}

export interface TrainingDomainDef {
  key: TrainingDomainKey;
  aliases: string[];
  card: DomainCardSchema;
  rubricId: string;
  rubric: CriterionDef[];
  stagePlan: StagePlanCapability;
  cases: DomainCaseDef[];
  calibration: CalibrationExample[];
  /** Какие форматы доступны. Длинная консультация — только там, где есть карточка. */
  formats: SessionFormat[];
  /**
   * Критерий, который считается движком детерминированно по карточке кейса,
   * а не моделью: покрытие опроса. Модели он не показывается как задание.
   */
  coverageCriterion?: CriterionDef;
  /** Сколько ответов врача в длинном формате. */
  longExchanges?: number;
}

/* ---------- Публичный каталог разделов ---------- */

/**
 * То, что о кейсе можно показывать в браузере. Скрытая карточка, рубрика,
 * калибровочные эталоны и сиды генератора сюда сознательно не входят:
 * всё, что попадает в клиентский бандл, студент может прочитать в DevTools.
 */
export interface PublicCase {
  id: string;
  title: string;
  brief: string;
  /** Сколько фактов в скрытой карточке (сами факты не отдаются); null — карточки нет. */
  factCount: number | null;
}

export interface PublicDomain {
  key: TrainingDomainKey;
  title: string;
  short: string;
  accent: string;
  channel: ScenarioChannel;
  framework: string;
  formats: SessionFormat[];
  /** Названия этапов разговора. */
  stages: string[];
  cases: PublicCase[];
}

/* ---------- Покрытие опроса ---------- */

export interface CoverageItem {
  id: string;
  probe: ProbeDomain;
  label: string;
  asked: boolean;
  critical: boolean;
  /** Реплика врача, в которой вопрос прозвучал. */
  quote: string | null;
}

export interface CoverageGroup {
  probe: ProbeDomain;
  label: string;
  asked: number;
  total: number;
}

export interface CoverageReport {
  items: CoverageItem[];
  groups: CoverageGroup[];
  asked: number;
  total: number;
  criticalMissed: string[];
  score: number;
  maxScore: number;
  /** Короткая сводка текстом — идёт в промт оценщика и в отчёт. */
  summary: string;
}


/** Ответ «живого» пациента на реплику врача. */
export interface PatientTurnOutcome {
  kind: 'patient';
  text: string;
  emotion: PatientEmotion;
  /** null — озвучка не удалась, реплика показывается только текстом. */
  audioUrl: string | null;
  isFinalPatientLine: boolean;
}
export interface EvalReadyOutcome {
  kind: 'eval_ready';
}

/* ----- Результаты оценки ----- */

export interface CriterionResult {
  id: string;
  name: string;
  framework: string;
  score: number;
  maxScore: number;
  evidenceQuote: string;
  explanation: string;
}

export interface EvaluationDTO {
  evaluationId: string;
  model: string;
  criteria: CriterionResult[];
  overallSummary: string;
  safetyFlag: string | null;
  flags: string[];
  createdAt: number;
  /** Производные: суммарный балл. */
  totalScore: number;
  maxScore: number;
  /** Покрытие опроса — только там, где у кейса есть скрытая карточка. */
  coverage: CoverageReport | null;
}

/** Запись для страницы истории. */
export interface HistoryRow {
  sessionId: string;
  domain: string;
  category: string;
  categorySlug: string;
  moodLabel: string;
  patientFirst: string;
  createdAt: number;
  status: 'done';
  exchangesDone: number;
  totalScore: number;
  maxScore: number;
  overallSummary: string;
  hasSafetyFlag: boolean;
  mode: SessionMode;
  format: SessionFormat;
}
