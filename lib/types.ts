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
  opener: { text: string; emotion: PatientEmotion; audioUrl: string };
  status: 'active' | 'done';
  createdAt: number;
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

/** Ответ «живого» пациента на реплику врача. */
export interface PatientTurnOutcome {
  kind: 'patient';
  text: string;
  emotion: PatientEmotion;
  audioUrl: string;
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
}

export const CATEGORY_SLUGS: Record<string, string> = {
  'Терапия': 'therapy',
  'Хирургия': 'surgery',
  'Педиатрия': 'pediatrics',
  'Амбулатория': 'outpatient',
  'Стационар': 'inpatient',
};

export const DOMAIN_ORDER = ['Амбулатория', 'Стационар', 'Терапия', 'Хирургия', 'Педиатрия'] as const;
