import { jsonChat } from '../ai/jsonChat';
import { asEnum, asString, asStringArray } from '../ai/json';
import { AiError } from '../ai/errors';
import type { PatientEmotion, TwistPlan } from '../types';
import { PATIENT_EMOTION_LABELS } from '../types';
import { MOOD_EMOTION } from '../types';
import type { DomainSlug, ComplaintCategory, MotiveDef } from './axes';
import type { Persona } from '../personas';

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
  const system = [
    'Ты — сценарист тренажёра коммуникативных навыков для врачей. Твоя задача — один разговорный эпизод приёма: недовольный пациент изливает жалобу врачу.',
    '',
    'Жёсткие правила:',
    '1. Речь пациента — живая устная русская речь, 2–4 предложения. Никакой «литературщины», канцелярита, никаких списков. Естественные паузы, сбивчивость, повторы — допустимы, но не карикатурно.',
    '2. Пациент обращается к врачу на «вы». В реплике не должно быть приветствия «здравствуйте» и представления — разговор уже начался, человек выплёскивает наболевшее.',
    '3. Обязательно вплети минимум две конкретные детали из предложенного повода (время, названия, суммы, слова персонала). Без конкретики сцена звучит шаблонно.',
    '4. Категорически избегай клише и общих мест: «я хочу, чтобы меня услышали», «мне никто не помогает», «вы должны меня понять». Если в подсказке указаны недавние сцены пользователя — не повторяй их поводы, эмоции и речевые обороты.',
    '5. Эмоция, заданная как стартовая, должна читаться в тоне, но не называться пациентом вслух («я в ярости» — запрещено).',
    '6. Пациент НЕ знает про свой «скрытый мотив» как про диагноз — это твоя режиссёрская подоплёка для развития диалога. В открывающей реплике мотив лишь пунктиром проглядывает через поведение.',
    '7. acting_notes — режиссёрские указания актёру (системному промту «живого пациента») на 4–7 предложений: как персона разговаривает, что её заводит, что снижает напряжение, как ведёт себя стартовая эмоция, где и как может вскрыться мотив. Это внутренний документ — писать его от третьего лица, без обращения к модели.',
  ].join('\n');

  const user = [
    `ДОМЕН: ${input.domainTitle}`,
    `ПОВОД ЖАЛОБЫ: ${input.category.title}. Суть: ${input.category.brief}. Конкретика (выбери и развей 1–2): ${input.category.seeds.join('; ')}.`,
    `СТАРТОВАЯ ЭМОЦИЯ: ${input.moodLabel}.`,
    `ПАЦИЕНТ: ${persona.firstName}, ${persona.age} лет (${persona.gender === 'f' ? 'женщина' : 'мужчина'}). Характер: ${persona.temper}. Манера речи: ${persona.speechStyle}.`,
    `СКРЫТЫЙ МОТИВ (игроку не показывается): ${input.motive.kind} — ${input.motive.description}`,
    `ДЛИНА СЦЕНЫ: ${input.exchangesLimit} ответных реплик врача; твист может произойти на одном из обменов 1..${input.exchangesLimit}.`,
    `НЕДАВНИЕ СЦЕНЫ ЭТОГО ПОЛЬЗОВАТЕЛЯ (не повторяй формулировки и не строй ту же драматургию): ${input.recentSummary || 'пока нет'}`,
    '',
    OUTPUT_SHAPE.replace('LIMIT', String(input.exchangesLimit)),
  ].join('\n');

  const raw = await jsonChat<Record<string, unknown>>({
    model: undefined, // chatModel из env
    system,
    user,
    json: true,
    temperature: 0.85,
    maxTokens: 1200,
    requestId: input.requestId,
    retryOnInvalid: true,
  });

  const openerText = asString(raw.opener_text, 'opener_text', false).replace(/\s+/g, ' ').trim();
  const openerEmotion = asEnum<PatientEmotion>(
    MOOD_EMOTION[input.moodLabel] ?? raw.opener_emotion,
    Object.keys(PATIENT_EMOTION_LABELS) as PatientEmotion[],
    'opener_emotion'
  );
  const actingNotes = asString(raw.acting_notes, 'acting_notes', false);

  let twist: TwistPlan | null = null;
  if (raw.twist && typeof raw.twist === 'object') {
    const t = raw.twist as Record<string, unknown>;
    const exchangeIndex = Math.max(1, Math.min(input.exchangesLimit, Number(t.exchange_index ?? 1)));
    const shift = asString(t.shift, 'twist.shift', false);
    const hint = asString(t.hint, 'twist.hint', false);
    twist = { exchangeIndex, shift, hint };
  }

  if (openerText.length > 900) throw new AiError('invalid_json', 'opener_text слишком длинный');

  return { openerText, openerEmotion, actingNotes, twist };
}
