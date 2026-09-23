import { jsonChat } from '../ai/jsonChat';
import { asEnum, asString } from '../ai/json';
import { AiError } from '../ai/errors';
import type { CaseCard, PatientEmotion, SessionFormat, TwistPlan } from '../types';
import { PATIENT_EMOTION_LABELS } from '../types';
import { MOOD_EMOTION } from '../types';
import type { DomainSlug, ComplaintCategory, MotiveDef } from './axes';
import type { Persona } from '../personas';
import { cardToPrompt, domainByKey, domainCase } from '../domains';

export interface ScenarioPick {
  openerText: string;
  openerEmotion: PatientEmotion;
  actingNotes: string;
  twist: TwistPlan | null;
}

export interface GenerateInput {
  domainSlug: DomainSlug;
  domainTitle: string;
  category: ComplaintCategory;
  moodLabel: string; // стартовая эмоция (ось №2)
  persona: Persona;
  motive: MotiveDef;
  recentSummary: string;
  exchangesLimit: number;
  requestId: string;
  domainKey?: string;
  caseId?: string;
  caseFacts?: Record<string, unknown>;
  /** Скрытая карточка кейса — для длинной консультации и телефонных звонков. */
  card?: CaseCard;
  format?: SessionFormat;
  model?: string;
}

const EMOTION_OPTIONS = Object.keys(PATIENT_EMOTION_LABELS).join(' | ');

const OUTPUT_SHAPE = `Поле opener_emotion — одно из: ${EMOTION_OPTIONS}.
Поле twist: null, если твиста не будет, либо объект {"exchange_index": число от 1 до ${'LIMIT'}, "shift": "как меняется поведение и эмоция пациента", "hint": "что именно провоцирует сдвиг и как его сыграть"}.
Обязательные поля: opener_text, opener_emotion, acting_notes, twist.`;

/**
 * Один вызов LLM: по осям (домен+повод+эмоция+мотив+персона) собирает
 * «блюпринт» сцены. Возвращает структуру, валидированную по схеме.
 */
export async function generateScenario(input: GenerateInput): Promise<ScenarioPick> {
  const persona = input.persona;
  const domain = domainByKey(input.domainKey ?? input.domainSlug);
  const selectedCase = input.caseId ? domainCase(domain?.key, input.caseId) : undefined;
  const channel = domain?.card.channel ?? 'visual';
  const facts = input.caseFacts ?? selectedCase?.caseFacts;
  const card = input.card ?? selectedCase?.card;
  const long = input.format === 'long';
  const volunteered = card?.facts.filter((item) => item.volunteered) ?? [];

  const system = [
    'Ты — сценарист тренажёра профессиональной медицинской коммуникации. Создай один реалистичный разговорный эпизод строго в указанном домене и кейсе.',
    '',
    'Жёсткие правила:',
    '1. Речь собеседника — живая устная русская речь, 2–4 предложения. Никакой «литературщины», канцелярита, никаких списков. Естественные паузы, сбивчивость, повторы — допустимы, но не карикатурно.',
    long
      ? '2. Это начало приёма: человек только вошёл и коротко говорит, с чем пришёл. Приветствие допустимо, но инициатива знакомства — за специалистом, не за пациентом.'
      : '2. Собеседник обращается к специалисту на «вы». В реплике не должно быть приветствия «здравствуйте» и представления — разговор уже начался, человек выплёскивает наболевшее.',
    '3. Обязательно вплети минимум две конкретные детали из предложенного повода (время, названия, суммы, слова персонала). Без конкретики сцена звучит шаблонно.',
    '4. Категорически избегай клише и общих мест: «я хочу, чтобы меня услышали», «мне никто не помогает», «вы должны меня понять». Если в подсказке указаны недавние сцены пользователя — не повторяй их поводы, эмоции и речевые обороты.',
    '5. Эмоция, заданная как стартовая, должна читаться в тоне, но не называться собеседником вслух («я в ярости» — запрещено).',
    '6. Собеседник НЕ знает про свой «скрытый мотив» как про диагноз — это твоя режиссёрская подоплёка. В открывающей реплике мотив лишь пунктиром проглядывает через поведение.',
    '7. acting_notes — режиссёрские указания актёру (системному промту «живого пациента») на 4–7 предложений: как персона разговаривает, что её заводит, что снижает напряжение, как ведёт себя стартовая эмоция, где и как может вскрыться мотив. Это внутренний документ — писать его от третьего лица, без обращения к модели.',
    card
      ? '8. КАРТОЧКА КЕЙСА НЕПРИКОСНОВЕННА. В открывающей реплике можно использовать ТОЛЬКО те сведения, которые помечены как «говорит сам». Остальные факты карточки — скрытые: специалист должен их вытянуть вопросами, поэтому в опенере их быть не должно. Не придумывай фактов, противоречащих карточке.'
      : '8. Не придумывай медицинских фактов, противоречащих поводу сцены.',
    `9. Канал разговора: ${channel}. ${channel === 'voice-only' ? 'Контакта глазами, жестов, экрана и других визуальных данных нет. Всё необходимое уточняется и проговаривается вслух; нельзя писать «показывает», «видит», «смотрит». Для триажа не ставь диагноз по телефону, но обязательно сохраняй экстренные красные флаги.' : 'Не полагайся на внешность или аватар: важны слова и действия собеседника.'}`,
  ].join('\n');

  const user = [
    `ДОМЕН: ${input.domainTitle}`,
    domain ? `ФРЕЙМВОРК: ${domain.card.framework}. ЭТАПЫ: ${domain.stagePlan.stages.map((s) => s.title).join(' → ')}.` : '',
    `ПОВОД: ${input.category.title}. Суть: ${input.category.brief}. Конкретика (выбери и развей 1–2): ${input.category.seeds.join('; ')}.`,
    `СТАРТОВАЯ ЭМОЦИЯ: ${input.moodLabel}.`,
    `СОБЕСЕДНИК: ${persona.firstName}, ${persona.age} лет (${persona.gender === 'f' ? 'женщина' : 'мужчина'}). Характер: ${persona.temper}. Манера речи: ${persona.speechStyle}.`,
    `СКРЫТЫЙ МОТИВ (игроку не показывается): ${input.motive.kind} — ${input.motive.description}`,
    card ? `СКРЫТАЯ КАРТОЧКА КЕЙСА:\n${cardToPrompt(card)}` : '',
    card
      ? `В ОПЕНЕРЕ РАЗРЕШЕНО ИСПОЛЬЗОВАТЬ ТОЛЬКО ЭТО: ${volunteered.map((item) => item.value).join(' | ') || card.presenting}`
      : '',
    facts ? `ТЕХНИЧЕСКИЕ ФАКТЫ КЕЙСА: ${JSON.stringify(facts)}` : '',
    `ДЛИНА СЦЕНЫ: ${input.exchangesLimit} ответных реплик специалиста; твист может произойти на одном из обменов 1..${input.exchangesLimit}.`,
    long
      ? 'ФОРМАТ: полная консультация от регистратуры до завершения приёма. Твист здесь не обязателен — если его нет, верни null.'
      : '',
    `НЕДАВНИЕ СЦЕНЫ ЭТОГО ПОЛЬЗОВАТЕЛЯ (не повторяй формулировки и не строй ту же драматургию): ${input.recentSummary || 'пока нет'}`,
    '',
    OUTPUT_SHAPE.replace('LIMIT', String(input.exchangesLimit)),
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await jsonChat<Record<string, unknown>>({
    model: input.model, // production uses chatModel from env
    system,
    user,
    json: true,
    temperature: 0.85,
    maxTokens: 1200,
    requestId: input.requestId,
    retryOnInvalid: true,
  });

  const openerText = asString(raw.opener_text, 'opener_text', false).replace(/\s+/g, ' ').trim();
  // Эмоция — оформление, а не содержание: незнакомое значение от модели не
  // должно ронять уже оплаченную генерацию сцены.
  const emotions = Object.keys(PATIENT_EMOTION_LABELS) as PatientEmotion[];
  const suggested = MOOD_EMOTION[input.moodLabel] ?? raw.opener_emotion;
  const openerEmotion = emotions.includes(suggested as PatientEmotion)
    ? asEnum<PatientEmotion>(suggested, emotions, 'opener_emotion')
    : 'neutral';
  const actingNotes = asString(raw.acting_notes, 'acting_notes', false);

  let twist: TwistPlan | null = null;
  if (raw.twist && typeof raw.twist === 'object') {
    const t = raw.twist as Record<string, unknown>;
    const index = Number(t.exchange_index);
    const exchangeIndex = Math.max(1, Math.min(input.exchangesLimit, Number.isFinite(index) ? Math.round(index) : 1));
    const shift = asString(t.shift, 'twist.shift', false);
    const hint = asString(t.hint, 'twist.hint', false);
    twist = { exchangeIndex, shift, hint };
  }

  if (openerText.length > 900) throw new AiError('invalid_json', 'opener_text слишком длинный');

  return { openerText, openerEmotion, actingNotes, twist };
}
