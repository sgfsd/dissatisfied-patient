import { generateScenario } from '../lib/scenarios/generate';
import { producePatientLine } from '../lib/scenarios/actor';
import { complaintCategoriesFor } from '../lib/scenarios/axes';
import { domainByKey } from '../lib/domains';
import { personaById } from '../lib/personas';
import type { HiddenMotive, MessageDTO, PatientEmotion } from '../lib/types';

const args = process.argv.slice(2);
const value = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const defaultModels = 'openai/gpt-4o-mini,deepseek/deepseek-v4-flash,mistralai/mistral-small-3.2-24b-instruct,z-ai/glm-4.7-flash';
const models = (value('--models') ?? defaultModels).split(',').map((item: string) => item.trim()).filter(Boolean);
const repeats = Math.max(1, Number(value('--repeats') ?? 1));

const motive = {
  kind: 'fear', label: 'Страх за ребёнка',
  description: 'Пациент боится пропустить опасное состояние и ждёт понятного маршрута.',
  revealAtExchange: 2,
};

const persona = personaById('anna58');
const cases = [
  { domainKey: 'call-center', caseId: 'triage-adult', doctor: 'Понимаю, что вам страшно. Давящая боль и холодный пот могут быть опасными: немедленно звоните 112, не садитесь за руль. Вы сейчас один? Назовите адрес, я остаюсь на линии.', facts: { emergency: true, visualContact: false, task: 'triage' } },
  { domainKey: 'call-center', caseId: 'registration', doctor: 'Уточню фамилию, дату рождения и номер направления. Могу предложить вторник 14:20 или филиал на Лесной в четверг утром. Какой вариант вам удобнее? Повторите дату записи.', facts: { visualContact: false, task: 'registration' } },
  { domainKey: 'bad-news', caseId: 'oncology', doctor: 'Скажите, что вы уже поняли из обследований и готовы ли услышать результат. Биопсия подтвердила злокачественную опухоль. Я вижу, как тяжело это слышать; сделаем паузу и обсудим ближайший план.', facts: { diagnosis: 'biopsy confirms malignant process' } },
];

function category(domainKey: string, caseId: string) {
  const domain = domainByKey(domainKey)!;
  const item = domain.cases.find((candidate) => candidate.id === caseId)!;
  return { domain, item, category: complaintCategoriesFor(domainKey as never).find((candidate) => candidate.title === item.title)! };
}

function baseTranscript(doctor: string): MessageDTO[] {
  return [
    { id: 'p1', speaker: 'patient', text: 'Мне очень страшно, я не понимаю, насколько это срочно.', emotion: 'anxious', source: 'opener', audioUrl: null, idx: 0, createdAt: 0 },
    { id: 'd1', speaker: 'doctor', text: doctor, emotion: null, source: 'typed', audioUrl: null, idx: 1, createdAt: 0 },
  ];
}

function scoreScenario(text: string, domainKey: string, seed: string): number {
  let score = Number(text.length >= 80 && text.length <= 900);
  score += Number(text.includes(seed) || /112|холодн|биопси|направлен|запис|боль/i.test(text));
  score += Number(!/модель|тренажёр|оценк|сценарий|список/i.test(text));
  if (domainKey === 'call-center') score += Number(!/смотрит|видит|кивает|жест|экран|взгляд/i.test(text));
  return score;
}

function scoreActor(text: string, domainKey: string, doctor: string): number {
  let score = Number(text.length >= 15 && text.length <= 600);
  score += Number(!/модель|тренажёр|оценк|балл|промпт/i.test(text));
  score += Number(/112|один|адрес|боль|результат|опухол|запис|вторник|понимаю|страш/i.test(text));
  score += Number(text.split(/\s+/).length <= 65);
  if (domainKey === 'call-center') score += Number(!/смотрит|видит|кивает|жест|экран|взгляд/i.test(text));
  score += Number(doctor.length > 0);
  return score;
}

async function main() {
  const rows: Array<{ model: string; scenario: number; actor: number; errors: number; ms: number }> = [];
  for (const model of models) {
    let scenario = 0; let actor = 0; let errors = 0;
    const started = Date.now();
    for (let repeat = 0; repeat < repeats; repeat += 1) for (const test of cases) {
      try {
        const { domain, item, category: cat } = category(test.domainKey, test.caseId);
        const generated = await generateScenario({ domainSlug: test.domainKey as never, domainTitle: domain.card.title, category: cat, moodLabel: 'тревога', persona, motive, recentSummary: 'нет', exchangesLimit: 3, requestId: `task_s_${model}_${repeat}_${test.caseId}`, domainKey: test.domainKey, caseId: test.caseId, caseFacts: test.facts, model });
        scenario += scoreScenario(generated.openerText, test.domainKey, cat.seeds[0]);
        const reply = await producePatientLine({ personaKey: persona.key, domainTitle: domain.card.title, complaintSeed: cat.brief, openerText: generated.openerText, openerEmotion: generated.openerEmotion, hiddenMotive: motive, actingNotes: generated.actingNotes, twist: generated.twist, actorTurnIndex: 1, transcript: baseTranscript(test.doctor), exchangesLimit: 3, requestId: `task_a_${model}_${repeat}_${test.caseId}`, domainKey: test.domainKey, caseFacts: test.facts, model });
        actor += scoreActor(reply.text, test.domainKey, test.doctor);
        console.log(`${model} ${test.caseId}: scenario ${scoreScenario(generated.openerText, test.domainKey, cat.seeds[0])}/3, actor ${scoreActor(reply.text, test.domainKey, test.doctor)}/5`);
      } catch (error) { errors += 1; console.log(`${model} ${test.caseId}: ERROR ${error instanceof Error ? error.message : String(error)}`); }
    }
    rows.push({ model, scenario, actor, errors, ms: Date.now() - started });
  }
  console.log('\nTask-specific summary (higher is better; no general benchmark score)');
  for (const row of rows) console.log(`${row.model}: scenario=${row.scenario}/${cases.length * repeats * 3}, actor=${row.actor}/${cases.length * repeats * 5}, errors=${row.errors}, avg=${Math.round(row.ms / (cases.length * repeats * 2))}ms/call`);
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
