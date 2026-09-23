/* ============================================================
   Демо-наполнение: история прогонов студента без единого обращения к AI.

   Нужно для двух вещей: показать экраны «Разбор», «История» и «Прогресс»
   на защите, и проверять вёрстку на реальных объёмах данных. Сцены
   собираются из настоящего реестра доменов, рубрики берутся оттуда же,
   а покрытие расспроса считается тем же движком, что и в проде, — поэтому
   демо-строки структурно неотличимы от боевых.

   Запуск:
     npx tsx scripts/seed-demo.mts --student=ivanov --count=16
     npx tsx scripts/seed-demo.mts --clean        # убрать только демо-строки

   Работать лучше на отдельной базе: DATA_DIR=data-demo npx tsx ...
   ============================================================ */

import {
  bumpExchanges,
  createScenario,
  createSession,
  getDb,
  insertMessage,
  saveEvaluation,
  setSessionStatus,
  uid,
} from '../lib/db';
import { computeCoverage, TRAINING_DOMAINS } from '../lib/domains';
import { personaById, PERSONAS } from '../lib/personas';
import type { CaseCard, TrainingDomainDef } from '../lib/types';

const SEED_MARK = 'demo-seed';

const arg = (name: string, fallback = '') => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/* ---------- Реплики врача ----------
   Чтобы покрытие расспроса считалось по-настоящему, строим реплики из тех
   же cue, что лежат в карточке кейса: берём нужную долю фактов и задаём по
   ним вопросы. Доля растёт от сцены к сцене — так в графике появляется
   осмысленная динамика, а не шум.                                        */

function doctorLines(card: CaseCard | undefined, skill: number): string[] {
  const opening = [
    'Здравствуйте, меня зовут Ирина Сергеевна, я врач-терапевт. Уточню, это вы записаны на приём? Расскажите, что вас привело.',
    'Слышу, как вам это неприятно, и понимаю почему. Давайте разберёмся по порядку.',
  ];
  if (!card) {
    return [
      ...opening,
      'Что для вас сейчас важнее всего решить?',
      'Давайте договоримся так: я уточню статус и перезвоню вам сегодня до 17:00.',
    ];
  }
  const askable = card.facts.filter((fact) => !fact.volunteered);
  const take = Math.round(askable.length * skill);
  const lines = [...opening];
  for (let i = 0; i < take; i += 3) {
    const chunk = askable.slice(i, i + 3);
    // Первый cue факта — как раз то, что спросил бы человек вслух.
    lines.push(`${chunk.map((fact) => fact.cues[0]).join(', ')}?`);
  }
  lines.push(
    'Скажу прямо, что я думаю и что предлагаю сделать сегодня. Повторите, пожалуйста, своими словами, что мы решили.',
  );
  lines.push('Если станет хуже — не ждите приёма, звоните 103.');
  return lines;
}

/* ---------- Одна сцена ---------- */

function seedSession(options: {
  domain: TrainingDomainDef;
  studentId: string;
  createdAt: number;
  skill: number;
  mode: 'practice' | 'exam';
  withSafetyFlag: boolean;
}) {
  const { domain, studentId, createdAt, skill, mode } = options;
  const item = pick(domain.cases);
  const format = domain.formats.includes('long') ? 'long' : 'short';
  const personaKey = item.personaPool?.length ? pick(item.personaPool) : pick(PERSONAS).key;
  const persona = personaById(personaKey);
  const scenarioId = uid();
  const sessionId = uid();

  const lines = doctorLines(item.card, skill);
  const coverage = item.card ? computeCoverage(item.card, lines) : null;
  const stages = format === 'long' ? domain.stagePlan.stages : [];

  createScenario({
    id: scenarioId,
    domain: domain.card.title,
    category: item.title,
    category_slug: `${domain.key}-${item.id}`,
    complaint_seed: `${item.title}: ${item.seeds[0]}`,
    mood_label: 'раздражение',
    persona_key: personaKey,
    patient_first: persona.firstName,
    patient_age: persona.age,
    opener_text: item.card?.presenting ?? item.brief,
    opener_emotion: 'irritated',
    exchanges_limit: format === 'long' ? 12 : 3,
    hidden_motive_json: JSON.stringify({
      kind: 'demo',
      label: 'Демонстрация',
      description: 'Сцена создана скриптом seed-demo для показа интерфейса.',
      revealAtExchange: 2,
    }),
    twist_json: null,
    acting_notes: '',
    domain_key: domain.key,
    case_id: item.id,
    channel: domain.card.channel,
    case_facts_json: JSON.stringify(item.caseFacts ?? {}),
    case_card_json: item.card ? JSON.stringify(item.card) : null,
    stage_plan_json: JSON.stringify(stages),
    rubric_id: domain.rubricId,
    seed: SEED_MARK,
    created_at: createdAt,
  });

  createSession(sessionId, scenarioId, studentId, { mode, format });

  insertMessage({
    id: uid(),
    session_id: sessionId,
    speaker: 'patient',
    text: item.card?.presenting ?? item.brief,
    emotion: 'irritated',
    source: 'opener',
    idx: 0,
    created_at: createdAt,
  });
  lines.forEach((text, i) => {
    insertMessage({
      id: uid(),
      session_id: sessionId,
      speaker: 'doctor',
      text,
      emotion: null,
      source: 'typed',
      idx: i * 2 + 1,
      created_at: createdAt + (i * 2 + 1) * 40_000,
    });
    bumpExchanges(sessionId);
    insertMessage({
      id: uid(),
      session_id: sessionId,
      speaker: 'patient',
      text: 'Ну… хорошо, раз вы так говорите.',
      emotion: i > lines.length / 2 ? 'neutral' : 'irritated',
      source: 'actor',
      idx: i * 2 + 2,
      created_at: createdAt + (i * 2 + 2) * 40_000,
    });
  });

  /* Баллы по настоящей рубрике домена: навык плюс небольшой разброс. */
  type SeedCriterion = {
    name: string;
    framework: string;
    score: number;
    maxScore: number;
    evidenceQuote: string;
    explanation: string;
  };
  const criteria: SeedCriterion[] = domain.rubric.map((def): SeedCriterion => {
    const noise = (Math.random() - 0.5) * 0.45;
    const score = Math.round(clamp(skill + noise, 0, 1) * def.scale);
    return {
      name: def.name,
      framework: def.framework,
      score,
      maxScore: def.scale,
      evidenceQuote: score > 0 ? lines[Math.min(1, lines.length - 1)] : '',
      explanation:
        score === def.scale
          ? 'Якорь выполнен полностью: сказано конкретно и по делу.'
          : score === 0
            ? 'Подходящей фразы в репликах не нашлось.'
            : 'Сделано частично — не хватило конкретики.',
    };
  });
  if (coverage && domain.coverageCriterion) {
    criteria.push({
      name: domain.coverageCriterion.name,
      framework: domain.coverageCriterion.framework,
      score: coverage.score,
      maxScore: coverage.maxScore,
      evidenceQuote: coverage.items.find((entry) => entry.asked && entry.quote)?.quote ?? '',
      explanation: coverage.summary,
    });
  }

  saveEvaluation({
    id: uid(),
    sessionId,
    model: 'minimax/minimax-01 (демо)',
    overallSummary:
      skill > 0.75
        ? 'Разговор выстроен: контакт установлен, расспрос полный, план согласован.'
        : 'Основа есть, но расспрос неполный и план назван слишком общо.',
    safetyFlag: options.withSafetyFlag
      ? 'В кейсе были признаки экстренного состояния, но однозначного маршрута за неотложной помощью не прозвучало.'
      : null,
    flags: [],
    coverage,
    criteria,
  });
  setSessionStatus(sessionId, 'done');
  // created_at сессии выставляем задним числом — графику нужна хронология.
  getDb()
    .prepare('UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?')
    .run(createdAt, createdAt, sessionId);
  return sessionId;
}

/* ---------- Точка входа ---------- */

function clean(): void {
  const db = getDb();
  const removed = db.transaction(() => {
    const scenarios = db
      .prepare('SELECT id FROM scenarios WHERE seed = ?')
      .all(SEED_MARK) as { id: string }[];
    const sessions = scenarios.flatMap(
      (scenario) =>
        db.prepare('SELECT id FROM sessions WHERE scenario_id = ?').all(scenario.id) as { id: string }[],
    );
    for (const session of sessions) {
      const evaluation = db.prepare('SELECT id FROM evaluations WHERE session_id = ?').get(session.id) as
        | { id: string }
        | undefined;
      if (evaluation) db.prepare('DELETE FROM criteria_results WHERE evaluation_id = ?').run(evaluation.id);
      db.prepare('DELETE FROM evaluations WHERE session_id = ?').run(session.id);
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.id);
      db.prepare('DELETE FROM combo_log WHERE session_id = ?').run(session.id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    }
    for (const scenario of scenarios) db.prepare('DELETE FROM scenarios WHERE id = ?').run(scenario.id);
    return sessions.length;
  }).immediate();
  console.log(`Удалено демо-сцен: ${removed}`);
}

function main(): void {
  if (process.argv.includes('--clean')) {
    clean();
    return;
  }

  const username = arg('student');
  const db = getDb();
  const student = username
    ? (db.prepare('SELECT user_id AS id FROM accounts WHERE username = ?').get(username.toLowerCase()) as
        | { id: string }
        | undefined)
    : undefined;
  if (username && !student) {
    console.error(`Студент «${username}» не найден. Создайте аккаунт в кабинете преподавателя.`);
    process.exit(1);
  }
  const studentId = student?.id ?? 'local';
  if (!student) {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, role, display_name, created_at) VALUES ('local', 'trainee', 'Демо-студент', ?)`,
    ).run(Date.now());
  }

  const count = clamp(Number(arg('count', '16')) || 16, 1, 120);
  const day = 24 * 3600_000;
  const ids: string[] = [];

  for (let i = 0; i < count; i++) {
    // Навык растёт от 0.35 к 0.85 — на графике видно обучение, а не случайность.
    const skill = 0.35 + (0.5 * i) / Math.max(1, count - 1);
    ids.push(
      seedSession({
        domain: pick(TRAINING_DOMAINS),
        studentId,
        createdAt: Date.now() - (count - i) * day - Math.floor(Math.random() * 6) * 3600_000,
        skill,
        mode: i > 0 && i % 7 === 0 ? 'exam' : 'practice',
        // Один ранний провал по безопасности — чтобы флаг было видно в отчёте.
        withSafetyFlag: i === 2,
      }),
    );
  }

  console.log(`Создано демо-сцен: ${ids.length} для пользователя ${studentId}`);
  console.log('Убрать: npx tsx scripts/seed-demo.mts --clean');
}

main();
