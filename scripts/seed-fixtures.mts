/* ============================================================
   Демо-наполнение истории: 3 завершённые сессии с оценками.
   Нужно, чтобы экраны «Разбор» и «История» можно было посмотреть
   без живых AI-вызовов. Записи помечаются в выводе; удалить их
   можно строкой ниже или очисткой data/.

   Запуск: npm run seed
   ============================================================ */

import {
  bumpExchanges, createScenario, createSession, getDb, insertMessage,
  saveEvaluation, setSessionStatus, uid,
} from '../lib/db';

interface SeedMsg {
  speaker: 'patient' | 'doctor';
  text: string;
  emotion: string | null;
  source: string;
}

interface SeedEval {
  total: number;
  criteria: { name: string; framework: string; score: number; maxScore: number; evidenceQuote: string; explanation: string }[];
  summary: string;
  safetyFlag: string | null;
  flags: string[];
}

async function seedSession(opts: {
  domain: string;
  category: string;
  categorySlug: string;
  personaKey: string;
  patientFirst: string;
  patientAge: number;
  mood: string;
  opener: { text: string; emotion: string };
  messages: SeedMsg[];
  eval: SeedEval;
}) {
  const scenarioId = uid();
  const sessionId = uid();
  const t = Date.now() - Math.floor(Math.random() * 40) * 3600_000; // 0–40 ч назад
  createScenario({
    id: scenarioId, domain: opts.domain, category: opts.category,
    category_slug: opts.categorySlug,
    complaint_seed: `${opts.category}: демонстрационный сценарий (seed)`,
    mood_label: opts.mood, persona_key: opts.personaKey,
    patient_first: opts.patientFirst, patient_age: opts.patientAge,
    opener_text: opts.opener.text, opener_emotion: opts.opener.emotion,
    exchanges_limit: 3,
    hidden_motive_json: JSON.stringify({
      kind: 'demo', label: 'Демонстрация', description: 'Сцена создана скриптом npm run seed для показа интерфейса.',
      revealAtExchange: 2,
    }),
    twist_json: null, acting_notes: '',
    created_at: t,
  });
  createSession(sessionId, scenarioId, 'local');
  const msgs: SeedMsg[] = [{ speaker: 'patient', text: opts.opener.text, emotion: opts.opener.emotion, source: 'opener' }, ...opts.messages];
  msgs.forEach((m, i) => {
    insertMessage({
      id: uid(), session_id: sessionId, speaker: m.speaker, text: m.text,
      emotion: m.emotion, source: m.source, idx: i, created_at: t + i * 45_000,
    });
    if (m.speaker === 'doctor') bumpExchanges(sessionId);
  });
  const e = opts.eval;
  saveEvaluation({
    id: uid(), sessionId, model: 'gpt-4o (демо)',
    overallSummary: e.summary, safetyFlag: e.safetyFlag, flags: e.flags,
    criteria: e.criteria,
  });
  // saveEvaluation уже ставит status='done'; возвращаемся в это же состояние явно
  setSessionStatus(sessionId, 'done');
  return { sessionId, scenarioId, total: e.total };
}

const TE = 'NURSE';
const CC = 'Calgary–Cambridge Guide';
const BC = 'Beauchamp & Childress';

async function main() {
  const clean = process.argv.includes('--clean');
  if (clean) {
    const db = getDb();
    db.exec(`DELETE FROM criteria_results; DELETE FROM evaluations;
             DELETE FROM messages; DELETE FROM sessions; DELETE FROM scenarios;
             DELETE FROM combo_log; DELETE FROM users;`);
    console.log('БД очищена (sessions/scenarios/messages/evaluations).');
  }
  const existing = getDb().prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
  if (existing.n > 0 && !process.argv.includes('--force')) {
    console.log(`В БД уже есть ${existing.n} сессий. Для добавления демо поверх запустите: npm run seed -- --force`);
    return;
  }

  const rows: { sessionId: string; total: number }[] = [];

  /* ---------- Демо 1: сильная консультация, очередь (11/12) ---------- */
  rows.push(
    await seedSession({
      domain: 'Амбулатория', category: 'Очередь и организация приёма',
      categorySlug: 'outpatient-ochered-i-organizaciya-priema',
      personaKey: 'anna58', patientFirst: 'Анна', patientAge: 58,
      mood: 'раздражение',
      opener: {
        text: 'Я записана на 10:20, а позвали меня только в 13:40. Я отпросилась с работы, у меня там отчёт горит, а я три часа сижу в этом коридоре — и никто даже не подошёл, не сказал ничего.',
        emotion: 'irritated',
      },
      messages: [
        { speaker: 'doctor', emotion: null, source: 'typed', text: 'Анна, слышу, как это выбило вас из колеи: вы отпросились с работы ради визита, а прождали три часа без единого объяснения. Это действительно несправедливо, и я понимаю, почему вы злитесь. Давайте я сейчас подниму вашу карту и проверю, в чём была задержка. На сколько вы были записаны?' },
        { speaker: 'patient', emotion: 'upset', source: 'actor', text: 'Записана была на 10:20, к терапевту. Я уже думала — уйти или нет. Если бы кто-то просто вышел и сказал «подождите ещё», было бы проще.' },
        { speaker: 'doctor', emotion: null, source: 'typed', text: 'Понимаю: отсутствие информации — самое тяжёлое. Вы имели полное право чувствовать себя брошенной. Я посмотрел карту — визит не потерян, просто с утра приём шёл с задержками. Сейчас я вас приму, а замечание по организации передам в регистратуру. Что вас беспокоит?' },
        { speaker: 'patient', emotion: 'neutral', source: 'actor', text: 'Спасибо… Давление скачет последнюю неделю, голова тяжёлая, я из-за этого и записалась.' },
        { speaker: 'doctor', emotion: null, source: 'stt', text: 'Хорошо, что вы пришли сейчас. Я измерю давление, сравню с прежними цифрами и разберёмся, что делать. Вы принимаете что-то от давления или начали новое лекарство? После осмотра дам конкретный план и, если нужно, направление на обследование.' },
      ],
      eval: {
        total: 11,
        summary: 'Сильная консультация: эмоция названа и привязана к конкретике ожидания, врач не ушёл в оборону, собрал нужные детали и дал конкретный план. Единственное, чего не хватило для максимума, — уточнить, как именно задержка повлияла на планы пациентки на день.',
        safetyFlag: null, flags: [],
        criteria: [
          { name: 'Распознавание эмоции', framework: TE, score: 3, maxScore: 3, evidenceQuote: '«слышу, как это выбило вас из колеи: …прождали три часа без единого объяснения»', explanation: 'Эмоция названа точно и связана с конкретной ситуацией: работа, три часа, отсутствие объяснений.' },
          { name: 'Уважение и отсутствие обороны', framework: BC, score: 3, maxScore: 3, evidenceQuote: '«вы имели полное право чувствовать себя брошенной»', explanation: 'Ни оправданий, ни перекладывания вины; врач взял организационный вопрос на себя.' },
          { name: 'Прояснение ситуации', framework: CC, score: 2, maxScore: 2, evidenceQuote: '«На сколько вы были записаны? …Что вас беспокоит?»', explanation: 'Активные уточняющие вопросы вместо выводов на пустом месте.' },
          { name: 'Конкретный следующий шаг', framework: CC, score: 2, maxScore: 2, evidenceQuote: '«Измерю давление… дам конкретный план и, если нужно, направление»', explanation: 'Названы конкретные действия с объяснением.' },
          { name: 'Признание неудобства', framework: 'NURSE (Respect) + справедливость', score: 1, maxScore: 2, evidenceQuote: '«замечание по организации передам в регистратуру»', explanation: 'Неудобство признано и врач предложил обратную связь, но без явного предложения сгладить последствия для самой пациентки (например, компенсировать ожидание приоритетом).' },
        ],
      },
    })
  );

  /* ---------- Демо 2: слабая консультация, хроническая боль (4/12) ---------- */
  rows.push(
    await seedSession({
      domain: 'Терапия', category: 'Хроническая боль',
      categorySlug: 'terapiya-hronicheskaya-bol',
      personaKey: 'sergey41', patientFirst: 'Сергей', patientAge: 41,
      mood: 'злость',
      opener: {
        text: 'Полгода хожу и жалуюсь на спину, а мне говорят «поболит и пройдёт». Я уже боюсь, что у меня там что-то серьёзное, а вы меня за ипохондрика держите!',
        emotion: 'angry',
      },
      messages: [
        { speaker: 'doctor', emotion: null, source: 'typed', text: 'Понимаю. Но вы же видите, какой у нас поток сегодня, мы не виноваты. Всех принимаем по очереди. Присядьте, подождите, вас позовут.' },
        { speaker: 'patient', emotion: 'angry', source: 'actor', text: 'Я не про очередь. Я про то, что меня полгода не воспринимают всерьёз! У меня спина болит так, что я спать не могу.' },
        { speaker: 'doctor', emotion: null, source: 'typed', text: 'Ну, если бы вы раньше сделали МРТ и приходили вовремя, может, и не болело бы. Ладно, раздевайтесь, посмотрю.' },
        { speaker: 'patient', emotion: 'cold', source: 'actor', text: 'Знаете что, я к такому врачу больше не приду. Вы меня же во всём и обвиняете.' },
        { speaker: 'doctor', emotion: null, source: 'stt', text: 'Ну и зря. Сами себе хуже сделаете. На дверь посмотрите, время приёма.' },
      ],
      eval: {
        total: 4,
        summary: 'Слабая консультация. Вместо ответа на боль врач оправдывается и обвиняет пациента в позднем обращении. Формальное «понимаю» не засчитано: оно не связано с тем, что сказал пациент. Единственный плюс — врач в итоге предложил осмотр.',
        safetyFlag: null, flags: [],
        criteria: [
          { name: 'Распознавание эмоции', framework: TE, score: 0, maxScore: 3, evidenceQuote: '«Понимаю. Но вы же видите, какой у нас поток»', explanation: 'Формальное «понимаю» без отклика на страх и боль; сразу переход к оправданиям.' },
          { name: 'Уважение и отсутствие обороны', framework: BC, score: 1, maxScore: 3, evidenceQuote: '«если бы вы раньше сделали МРТ… приходили вовремя»', explanation: 'Прямое обвинение пациента и обесценивание его жалобы.' },
          { name: 'Прояснение ситуации', framework: CC, score: 1, maxScore: 2, evidenceQuote: '«раздевайтесь, посмотрю»', explanation: 'Прояснения почти нет; единственный шаг — осмотр, но без уточнения характера боли.' },
          { name: 'Конкретный следующий шаг', framework: CC, score: 1, maxScore: 2, evidenceQuote: '«раздевайтесь, посмотрю»', explanation: 'Осмотр назван, но без плана и объяснения.' },
          { name: 'Эмоциональная поддержка', framework: TE, score: 1, maxScore: 2, evidenceQuote: '«мы не виноваты»', explanation: 'Поддержки нет; фраза про «поток» оставляет пациента один на один с проблемой.' },
        ],
      },
    })
  );

  /* ---------- Демо 3: клинически небезопасный совет + флаг (2/12) ---------- */
  rows.push(
    await seedSession({
      domain: 'Хирургия', category: 'Осложнения после операции',
      categorySlug: 'hirurgiya-oslozhneniya-posle-operacii',
      personaKey: 'timur45', patientFirst: 'Тимур', patientAge: 45,
      mood: 'холодная вежливость',
      opener: {
        text: 'Пять дней назад выписали после операции, а сегодня вечером — 38 и два, шов красный и горячий. Я позвонил в отделение, мне сказали «сами виноваты». Теперь вам звоню.',
        emotion: 'cold',
      },
      messages: [
        { speaker: 'doctor', emotion: null, source: 'typed', text: '38 и два — это нормальная реакция после операции, у всех так бывает. Не накручивайте себя. Примите парацетамол и полежите.' },
        { speaker: 'patient', emotion: 'irritated', source: 'actor', text: 'Нормальная? Шов красный, вокруг горячий, и мне хуже с каждым часом. Вы уверены?' },
        { speaker: 'doctor', emotion: null, source: 'typed', text: 'Уверен. Температура после операции — защитная реакция. Пейте больше воды, и всё пройдёт. Не надо никуда ехать.' },
        { speaker: 'patient', emotion: 'angry', source: 'actor', text: 'А если это инфекция? Мне что, ждать, пока хуже станет?' },
        { speaker: 'doctor', emotion: null, source: 'stt', text: 'Сказал же — норма. Если так переживаете, приходите в четверг на перевязку. Но не раньше.' },
      ],
      eval: {
        total: 2,
        summary: 'Коммуникация слабая, и главное — ответ клинически небезопасен: лихорадка 38,2 с гиперемией шва на пятый день после операции требует очной оценки, а не «пейте воду и ждите четверга». Это зафиксировано отдельным флагом безопасности.',
        safetyFlag: 'Врач рекомендовал не обращаться за помощью при лихорадке 38,2 и гиперемии послеоперационного шва — признаки возможной инфекции требуют очного осмотра, а не парацетамола.',
        flags: [],
        criteria: [
          { name: 'Распознавание эмоции', framework: TE, score: 0, maxScore: 3, evidenceQuote: '«Не накручивайте себя»', explanation: 'Тревога пациента обесценена, названа «накручиванием».' },
          { name: 'Уважение и отсутствие обороны', framework: BC, score: 1, maxScore: 3, evidenceQuote: '«Уверен. …Не надо никуда ехать»', explanation: 'Давление и отказ воспринимать опасения; тон приказной.' },
          { name: 'Прояснение ситуации', framework: CC, score: 0, maxScore: 2, evidenceQuote: '', explanation: 'Врач не задал ни одного уточняющего вопроса о состоянии шва и динамике.' },
          { name: 'Конкретный следующий шаг', framework: CC, score: 1, maxScore: 2, evidenceQuote: '«приходите в четверг на перевязку»', explanation: 'Шаг назван, но с опасной отсрочкой в несколько дней.' },
          { name: 'Честность без ложных обещаний', framework: BC, score: 0, maxScore: 2, evidenceQuote: '«всё пройдёт»', explanation: 'Ложная гарантия при невозможности оценить состояние дистанционно.' },
        ],
      },
    })
  );

  console.log('Демо-сессии добавлены (npm run seed -- --clean — очистить БД и повторить):');
  for (const r of rows) console.log(`  /s/${r.sessionId}  — итог ${r.total}/12`);
  console.log(`\nВсего демо: ${rows.length}. Удалить вручную можно, стерев папку data/.`);
}

main().catch((e) => { console.error('Seed упал:', e); process.exit(1); });
