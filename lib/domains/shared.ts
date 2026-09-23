/* ============================================================
   Общие кирпичи реестра доменов: короткие конструкторы критериев,
   этапов, кейсов, карточек и калибровок. Каждый домен описывается
   декларативно, ядро про них ничего не знает.
   ============================================================ */

import type {
  CalibrationExample,
  CaseCard,
  CaseFact,
  CriterionDef,
  DomainCaseDef,
  ProbeDomain,
  StageDef,
  StagePlanCapability,
} from '../types';

export const criterion = (
  id: string,
  name: string,
  framework: string,
  scale: 2 | 3,
  verify: string
): CriterionDef => ({ id, name, framework, scale, verify });

/** Универсальные критерии, общие для нескольких доменов. */
export const common = {
  contact: criterion(
    'contact',
    'Контакт и уважение',
    'Calgary-Cambridge / NURSE',
    2,
    '0: игнорирует переживание или давит; 1: корректен, но шаблонен; 2: адресно признаёт переживание и сохраняет уважительный контакт.'
  ),
  explore: criterion(
    'explore',
    'Прояснение',
    'Calgary-Cambridge',
    2,
    '0: делает выводы без вопросов; 1: уточняет частично; 2: задаёт конкретные вопросы и проверяет понимание или ожидания.'
  ),
  plan: criterion(
    'plan',
    'Следующий шаг',
    'Calgary-Cambridge',
    2,
    '0: шага нет; 1: общий или односторонний план; 2: конкретный, выполнимый и согласованный следующий шаг.'
  ),
};

/** Критерий покрытия опроса — считается движком, модели не отдаётся. */
export const coverageCriterion = (name: string, framework: string, verify: string): CriterionDef =>
  criterion('coverage', name, framework, 3, verify);

export function stages(...rows: Array<[title: string, goal: string]>): StagePlanCapability {
  const list: StageDef[] = rows.map(([title, goal], i) => ({
    id: `stage-${i + 1}`,
    title,
    required: true,
    goal,
  }));
  return { enabled: true, stages: list };
}

type CaseRow = [
  id: string,
  title: string,
  brief: string,
  seeds: string[],
  caseFacts?: DomainCaseDef['caseFacts'],
  card?: CaseCard,
  personaPool?: string[],
];

export function cases(rows: CaseRow[]): DomainCaseDef[] {
  return rows.map(([id, title, brief, seeds, caseFacts, card, personaPool]) => ({
    id,
    title,
    brief,
    seeds,
    caseFacts,
    card,
    personaPool,
  }));
}

export function calibration(rows: Array<[string, string, string, string]>): CalibrationExample[] {
  return rows.map(([title, patient, clinician, assessment]) => ({ title, patient, clinician, assessment }));
}

/** Факт карточки: `fact(id, probe, label, value, cues, { critical, volunteered })`. */
export function fact(
  id: string,
  probe: ProbeDomain,
  label: string,
  value: string,
  cues: string[],
  flags: { critical?: boolean; volunteered?: boolean } = {}
): CaseFact {
  return { id, probe, label, value, cues, ...flags };
}

export function card(input: {
  headline: string;
  presenting: string;
  facts: CaseFact[];
  redFlags?: string[];
  expectedPlan?: string[];
  safetyNet?: string[];
}): CaseCard {
  return {
    headline: input.headline,
    presenting: input.presenting,
    facts: input.facts,
    redFlags: input.redFlags ?? [],
    expectedPlan: input.expectedPlan ?? [],
    safetyNet: input.safetyNet ?? [],
  };
}

/* ---------- Наборы cues, которые повторяются во всех клинических карточках ----------

   Русский язык склоняется, а совпадение ищется подстрокой, поэтому cue — это
   основа слова, а не словарная форма: «рождени» ловит и «дата рождения», и
   «дату рождения», и «год рождения». Многословные cue пишутся без местоимений
   («сами думаете», а не «как вы сами думаете») по той же причине.
   Слишком общие основы («работа», «кровь») запрещены: они дают ложные
   срабатывания на «работа сидячая» и «сдайте кровь».                          */

export const CUES = {
  name: ['зовут', 'ваше имя', 'фамили', 'отчеств', 'представьтесь', 'назовите себя', 'как к вам обращ'],
  birth: ['рождени', 'сколько лет', 'ваш возраст', 'родились', 'родилась', 'полных лет'],
  policy: ['полис', 'омс', 'дмс', 'страхов', 'снилс', 'номер карты'],
  contact: ['телефон', 'связаться', 'контактный', 'перезвон'],
  reason: ['вас беспокоит', 'с чем пришли', 'что случилось', 'жалуетесь', 'что привело', 'чем могу помочь', 'слушаю вас', 'по какому вопросу'],
  onset: ['как давно', 'когда начал', 'когда появил', 'с какого времени', 'давно это', 'когда это'],
  character: ['какая боль', 'как болит', 'характер', 'опишите', 'жгуч', 'ноющ', 'давящ', 'колющ', 'на что похоже'],
  severity: ['по шкале', 'насколько сильно', 'сколько баллов', 'терпим', 'насколько выражен', 'насколько интенсивн'],
  timing: ['постоянно или', 'приступ', 'как часто', 'сколько длит', 'сколько продолж', 'бывает ли ночью', 'когда усиливается', 'в течение дня'],
  triggers: ['что усиливает', 'что облегчает', 'от чего легче', 'после чего', 'связано ли с', 'проходит ли', 'помогает ли', 'чем снимаете'],
  associated: ['еще что то беспокоит', 'еще что нибудь', 'температур', 'тошнот', 'рвот', 'одышк', 'слабость', 'другие симптом', 'сопутств'],
  history: ['чем болели', 'болели раньше', 'хронически', 'операци', 'госпитализ', 'на учете', 'какие заболевания', 'обследовались', 'перенесенн'],
  medication: ['лекарств', 'что принимаете', 'принимаете ли', 'принимали ли', 'препарат', 'таблетк', 'лечились'],
  allergy: ['аллерги', 'непереносим', 'реакция на лекарств'],
  familyHistory: ['родственник', 'в семье', 'у родителей', 'наследствен', 'у близких', 'у матери', 'у отца'],
  social: ['работаете', 'чем занимаетесь', 'курите', 'курение', 'алкогол', 'с кем живете', 'физическ', 'питани', 'стресс', 'высыпаетесь'],
  ice: ['сами думаете', 'опасаетесь', 'вас пугает', 'боитесь', 'тревожит', 'ожидани', 'ждете от', 'что для вас важно', 'предполагаете', 'связываете', 'чего бы вы хотели'],
  teachBack: ['повторите', 'своими словами', 'что вы поняли', 'перескажите'],
} satisfies Record<string, string[]>;
