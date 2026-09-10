import { jsonChat } from '../ai/jsonChat';
import { asEnum, asString } from '../ai/json';
import { AiError } from '../ai/errors';
import { PATIENT_EMOTION_LABELS, type HiddenMotive, type MessageDTO, type PatientEmotion, type TwistPlan } from '../types';
import { personaById } from '../personas';

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
}

const EMO = Object.keys(PATIENT_EMOTION_LABELS).join(' | ');

/**
 * Ответная реплика «живого» пациента. Модель видит скрытый мотив и режиссуру,
 * но остаётся в роли: реагирует на то, что врач РЕАЛЬНО сказал.
 */
export async function producePatientLine(input: ProduceLineInput): Promise<ActorReply> {
  const p = personaById(input.personaKey);
  const doctorLast = input.transcript.filter((m) => m.speaker === 'doctor').slice(-1)[0]?.text ?? '';
  const lastPatientIdx = input.transcript.filter((m) => m.speaker === 'patient').length;

  const system = [
    `Ты — ${p.firstName}, ${p.age} лет (${p.gender === 'f' ? 'женщина' : 'мужчина'}), на приёме в сцене «${input.domainTitle}».`,
    `Характер: ${p.temper}. Манера речи: ${p.speechStyle}.`,
    '',
    'Ты — живой собеседник в тренировочном диалоге для врача. Ты НЕ модель: у тебя нет задач, ты не оцениваешь врача и не даёшь ему советов. Ты просто человек, который разговаривает с врачом.',
    '',
    'СИТУАЦИЯ (с чего начался разговор):',
    `- Повод: ${input.complaintSeed}`,
    `- Что ты уже сказал(а) в начале: «${input.openerText}»`,
    '',
    'ЧТО У ТЕБЯ ВНУТРИ (врач этого не знает, и ты это прямо не проговариваешь):',
    `${input.hiddenMotive.kind} — ${input.hiddenMotive.description}`,
    '',
    `РЕЖИССУРА ПОВЕДЕНИЯ: ${input.actingNotes}`,
    input.twist
      ? `ТВИСТ: на твоей ${input.twist.exchangeIndex}-й ответной реплике поведение должно сдвинуться: ${input.twist.shift}. Как сыграть: ${input.twist.hint}`
      : 'ТВИСТА НЕТ: эмоциональная дуга идёт естественно от слов врача.',
    '',
    'ПРАВИЛА РЕПЛИКИ:',
    '1. Отвечай ТОЛЬКО на то, что врач сказал только что. Не игнорируй его слова и не повторяй заученное.',
    '2. Одна устная реплика: 1–3 предложения, живая разговорная русская речь. Без канцелярита, без списков, без кавычек-разъяснений.',
    '3. Твоя эмоция может сдвигаться от слов врача: если врач назвал твоё состояние и предложил конкретный шаг — ты можешь стать спокойнее; если отвечает шаблонно, оборонительно или свысока — нарастай.',
    '4. Не произноси вслух диагноз своего состояния («я сейчас злюсь, потому что боюсь»). Только в момент твиста можно впервые проговорить настоящую тревогу — и то по-человечески, а не как формулировку из карточки.',
    '5. Не задавай врачу вопросов «а что бы вы сделали?» — это тренировка врача, а не собеседование.',
    '6. Ты не знаешь, что это симуляция: никаких слов о тренажёре, модели, оценке, баллах.',
  ].join('\n');

  // Компактный пересказ диалога: последние реплики (вся сцена не нужна, хватает хвоста).
  const tail = input.transcript.slice(-8);
  const dialogue = tail
    .map((m) => `${m.speaker === 'patient' ? `${p.firstName}` : 'ВРАЧ'}: ${m.text}`)
    .join('\n');

  const user = [
    `Ты — ${p.firstName}. Сейчас твой ход (после реплики врача). Это твоя ${input.actorTurnIndex}-я ответная реплика из возможных.`,
    '',
    `ХОДЫ ДО ЭТОГО (последние):\n${dialogue || '—'}`,
    '',
    `ТОЛЬКО ЧТО СКАЗАЛ ВРАЧ: «${doctorLast}»`,
    '',
    `Верни JSON: {"text": "твоя реплика", "emotion": "одно из: ${EMO}"}. Эмоция — твоё актуальное состояние в конце реплики.`,
  ].join('\n');

  const raw = await jsonChat<Record<string, unknown>>({
    system,
    user,
    json: true,
    temperature: 0.7,
    maxTokens: 400,
    requestId: input.requestId,
    retryOnInvalid: true,
  });

  const text = asString(raw.text, 'text', false).replace(/\s+/g, ' ').trim();
  const emotion = asEnum<PatientEmotion>(raw.emotion, Object.keys(PATIENT_EMOTION_LABELS) as PatientEmotion[], 'emotion');
  if (text.length > 600) throw new AiError('invalid_json', 'реплика пациента слишком длинная');
  return { text, emotion };
}
