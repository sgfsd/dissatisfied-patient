import { jsonChat } from '../ai/jsonChat';
import { asEnum, asString } from '../ai/json';
import { AiError } from '../ai/errors';
import {
  PATIENT_EMOTION_LABELS,
  type CaseCard,
  type CaseFact,
  type HiddenMotive,
  type MessageDTO,
  type PatientEmotion,
  type StageDef,
  type TwistPlan,
} from '../types';
import { personaById } from '../personas';
import { cardToPrompt, domainByKey, factsProbedBy, revealedFacts } from '../domains';

export interface ActorReply {
  text: string;
  emotion: PatientEmotion;
}

export interface ProduceLineInput {
  /** Как зовут пациента, возраст, пол — берём из персоны. */
  personaKey: string;
  domainTitle: string;
  complaintSeed: string;
  openerText: string;
  openerEmotion: PatientEmotion;
  hiddenMotive: HiddenMotive;
  actingNotes: string;
  twist: TwistPlan | null;
  /** Номер текущей реплики пациента после ответа врача: 1, 2, ... */
  actorTurnIndex: number;
  /** Полный диалог, компактный (пациент/врач), включая только что сказанное врачом. */
  transcript: MessageDTO[];
  exchangesLimit: number;
  requestId: string;
  domainKey?: string;
  caseFacts?: Record<string, unknown>;
  /** Скрытая карточка кейса: полный набор фактов, которые знает пациент. */
  card?: CaseCard;
  /** Текущий этап длинной консультации. */
  stage?: StageDef | null;
  model?: string;
}

const EMO = Object.keys(PATIENT_EMOTION_LABELS).join(' | ');

function factLine(fact: CaseFact): string {
  return `- ${fact.label}: ${fact.value}`;
}

/**
 * Ответная реплика «живого» пациента. Модель видит скрытый мотив, карточку
 * кейса и режиссуру, но остаётся в роли: реагирует на то, что врач РЕАЛЬНО
 * сказал, и раскрывает факты только в ответ на конкретные вопросы.
 */
export async function producePatientLine(input: ProduceLineInput): Promise<ActorReply> {
  const p = personaById(input.personaKey);
  const doctorLines = input.transcript.filter((m) => m.speaker === 'doctor').map((m) => m.text);
  const doctorLast = doctorLines.slice(-1)[0] ?? '';
  const domain = domainByKey(input.domainKey ?? input.domainTitle);
  const channel = domain?.card.channel ?? 'visual';

  /* Управление раскрытием: движок сам определяет, о чём врач только что
     спросил, и о чём спрашивал ранее. Модель не решает, что «пора» выдать —
     это убирает главный источник нереалистичности (пациент-суфлёр). */
  const probedNow = input.card ? factsProbedBy(input.card, doctorLast) : [];
  const knownBefore = input.card ? revealedFacts(input.card, doctorLines.slice(0, -1)) : [];
  const freshFacts = probedNow.filter((fact) => !knownBefore.some((known) => known.id === fact.id));

  const system = [
    `Ты — ${p.firstName}, ${p.age} лет (${p.gender === 'f' ? 'женщина' : 'мужчина'}), в сцене «${input.domainTitle}».`,
    `Характер: ${p.temper}. Манера речи: ${p.speechStyle}.`,
    '',
    'Ты — живой собеседник в тренировочном диалоге для специалиста. Ты НЕ модель: у тебя нет задач, ты не оцениваешь собеседника и не даёшь ему советов. Ты просто человек, который разговаривает.',
    '',
    'СИТУАЦИЯ (с чего начался разговор):',
    `- Повод: ${input.complaintSeed}`,
    `- Что ты уже сказал(а) в начале: «${input.openerText}»`,
    '',
    'ЧТО У ТЕБЯ ВНУТРИ (собеседник этого не знает, и ты это прямо не проговариваешь):',
    `${input.hiddenMotive.kind} — ${input.hiddenMotive.description}`,
    '',
    input.card ? `СКРЫТАЯ КАРТОЧКА (это правда о тебе):\n${cardToPrompt(input.card)}` : '',
    '',
    `РЕЖИССУРА ПОВЕДЕНИЯ: ${input.actingNotes}`,
    input.stage ? `ТЕКУЩИЙ ЭТАП РАЗГОВОРА: ${input.stage.title}. ${input.stage.goal ?? ''}` : '',
    input.caseFacts ? `НЕИЗМЕННЫЕ ФАКТЫ КЕЙСА: ${JSON.stringify(input.caseFacts)}` : '',
    input.twist
      ? `ТВИСТ: на твоей ${input.twist.exchangeIndex}-й ответной реплике поведение должно сдвинуться: ${input.twist.shift}. Как сыграть: ${input.twist.hint}`
      : 'ТВИСТА НЕТ: эмоциональная дуга идёт естественно от слов собеседника.',
    '',
    'ПРАВИЛА РЕПЛИКИ:',
    '1. Отвечай ТОЛЬКО на то, что собеседник сказал только что. Не игнорируй его слова и не повторяй заученное.',
    '2. Одна устная реплика: 1–3 предложения, живая разговорная русская речь. Без канцелярита, без списков, без кавычек-разъяснений.',
    '3. Твоя эмоция может сдвигаться от слов собеседника: если он назвал твоё состояние и предложил конкретный шаг — ты можешь стать спокойнее; если отвечает шаблонно, оборонительно или свысока — нарастай.',
    '4. Не произноси вслух диагноз своего состояния («я сейчас злюсь, потому что боюсь»). Только в момент твиста можно впервые проговорить настоящую тревогу — и то по-человечески.',
    '5. Не задавай собеседнику вопросов «а что бы вы сделали?» — это тренировка специалиста, а не собеседование. Свои вопросы задавать можно и нужно, если они естественны для человека в твоей ситуации.',
    '6. Ты не знаешь, что это симуляция: никаких слов о тренажёре, модели, оценке, баллах.',
    input.card
      ? '7. РАСКРЫТИЕ ФАКТОВ — главное правило. Ты НЕ выкладываешь карточку по своей инициативе. Отвечай правдиво и полно на то, о чём спросили, и молчи об остальном. Если спросили общо («как дела?») — не начинай перечислять симптомы и анамнез. Если о чём-то не спросили за весь разговор — собеседник просто этого не узнает. Ты никогда не врёшь и не отрицаешь факт, о котором спросили прямо.'
      : '7. Не выкладывай всё сразу: человек в разговоре отвечает на заданный вопрос, а не читает справку о себе.',
    channel === 'voice-only'
      ? '8. Это телефонный разговор без визуального контакта. Не описывай взгляд, жест, внешность, экран или то, что собеседник якобы видит. Всё важное проговаривай словами. При тревожных симптомах отвечай правдиво на заданные вопросы.'
      : '8. Не предполагай, что собеседник видит невербальные сигналы; выражай важное словами.',
  ]
    .filter(Boolean)
    .join('\n');

  // Компактный пересказ диалога: последние реплики (вся сцена не нужна, хватает хвоста).
  const tail = input.transcript.slice(-8);
  const dialogue = tail
    .map((m) => `${m.speaker === 'patient' ? `${p.firstName}` : 'СОБЕСЕДНИК'}: ${m.text}`)
    .join('\n');

  const user = [
    `Ты — ${p.firstName}. Сейчас твой ход (после реплики собеседника). Это твоя ${input.actorTurnIndex}-я ответная реплика.`,
    '',
    `ХОДЫ ДО ЭТОГО (последние):\n${dialogue || '—'}`,
    '',
    `ТОЛЬКО ЧТО СКАЗАЛ СОБЕСЕДНИК: «${doctorLast}»`,
    '',
    input.card && freshFacts.length
      ? `О ЭТОМ ТЕБЯ СПРОСИЛИ ВПЕРВЫЕ — сообщи именно это, своими словами, без зачитывания списком:\n${freshFacts.map(factLine).join('\n')}`
      : '',
    input.card && !freshFacts.length
      ? 'НОВЫХ ВОПРОСОВ ПО КАРТОЧКЕ НЕ ЗАДАНО: не выдавай новых сведений о себе. Отреагируй по-человечески на то, что услышал(а) — согласись, уточни, посомневайся, покажи чувство.'
      : '',
    input.card && knownBefore.length
      ? `УЖЕ СКАЗАНО РАНЬШЕ (не повторяй без нужды): ${knownBefore.map((fact) => fact.label).join(', ')}.`
      : '',
    '',
    `Верни JSON: {"text": "твоя реплика", "emotion": "одно из: ${EMO}"}. Эмоция — твоё актуальное состояние в конце реплики.`,
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await jsonChat<Record<string, unknown>>({
    model: input.model,
    system,
    user,
    json: true,
    temperature: 0.7,
    maxTokens: 400,
    requestId: input.requestId,
    retryOnInvalid: true,
  });

  const text = asString(raw.text, 'text', false).replace(/\s+/g, ' ').trim();
  // Незнакомая эмоция («calm», «happy») не повод терять ход: берём прежнее
  // состояние собеседника — лицо аватара просто не сменит выражение.
  const emotions = Object.keys(PATIENT_EMOTION_LABELS) as PatientEmotion[];
  const lastEmotion = [...input.transcript].reverse().find((m) => m.speaker === 'patient' && m.emotion)?.emotion;
  const emotion = emotions.includes(raw.emotion as PatientEmotion)
    ? asEnum<PatientEmotion>(raw.emotion, emotions, 'emotion')
    : lastEmotion ?? input.openerEmotion;
  if (text.length > 600) throw new AiError('invalid_json', 'реплика пациента слишком длинная');
  return { text, emotion };
}
