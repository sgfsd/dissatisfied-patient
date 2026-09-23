/* ============================================================
   Проверка матчера покрытия опроса — без обращений к AI и без денег.

   Считает покрытие на регрессионных диалогах, ловит ложные срабатывания
   на репликах, которые вопросами не являются, и проверяет, что живые
   формулировки студента в разных падежах действительно засчитываются.

   Запуск: npm run check:coverage
   Выход:  0 — всё сошлось; 1 — есть расхождения.
   ============================================================ */

import { computeCoverage, domainCase, factsProbedBy } from '../lib/domains';
import { REGRESSION_CASES } from './regression-cases';

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

/* ---------- 1. Покрытие на регрессионных диалогах ---------- */

console.log('\nПокрытие на регрессионных кейсах');
const expected: Record<string, [min: number, max: number]> = {
  'reception-thorough': [3, 3],
  'reception-shortcut': [0, 0],
  'call-center-registration': [2, 3],
  'call-center-child-missed': [0, 0],
  'call-center-results-refusal': [0, 1],
};

for (const [key, [min, max]] of Object.entries(expected)) {
  const c = REGRESSION_CASES.find((x) => x.key === key);
  const card = c?.caseId ? domainCase(c.domainKey, c.caseId)?.card : undefined;
  if (!c || !card) {
    check(false, key, 'кейс или карточка не найдены');
    continue;
  }
  const cov = computeCoverage(card, c.dialogue.map((turn) => turn.doctor));
  check(
    cov.score >= min && cov.score <= max,
    `${key}: ${cov.score}/${cov.maxScore}, спрошено ${cov.asked}/${cov.total}`,
    cov.score >= min && cov.score <= max ? '' : `ожидали ${min}–${max}`
  );
  if (cov.items.filter((item) => !item.asked).length) {
    console.log(`      не спрошено: ${cov.items.filter((i) => !i.asked).map((i) => i.label).join('; ')}`);
  }
}

/* ---------- 2. Ложные срабатывания ---------- */

const chest = domainCase('reception', 'chest-pain')!.card!;
console.log('\nРеплики, которые вопросами не являются');
for (const line of [
  'Ну это остеохондроз, у вас работа сидячая.',
  'Сейчас сдадим кровь и сделаем ЭКГ.',
  'Подождите в коридоре, вас позовут.',
  'Я выпишу вам мазь и справку.',
  'Не переживайте, всё будет хорошо.',
]) {
  const hits = factsProbedBy(chest, line).map((f) => f.label);
  check(hits.length === 0, `«${line.slice(0, 46)}…»`, hits.length ? `ложно засчитано: ${hits.join(', ')}` : '');
}

/* ---------- 3. Живые формулировки в разных падежах ---------- */

const registration = domainCase('call-center', 'registration')!.card!;
console.log('\nФормулировки студента должны засчитываться');
const phrasings: Array<[line: string, card: typeof chest, factId: string]> = [
  ['Назовите вашу дату рождения.', registration, 'birth'],
  ['Скажите год рождения, пожалуйста.', registration, 'birth'],
  ['Какой у вас контактный телефон?', registration, 'phone'],
  ['Это запись для вас или для кого-то другого?', registration, 'whose'],
  ['А как вы сами думаете, с чем это связано?', chest, 'idea'],
  ['Чего вы больше всего опасаетесь?', chest, 'concern'],
  ['Чего вы ждёте от сегодняшнего приёма?', chest, 'expectation'],
  ['Какие у вас ожидания от визита?', chest, 'expectation'],
  ['Принимаете ли вы какие-то лекарства постоянно?', chest, 'medication'],
  ['Есть ли аллергия на препараты?', chest, 'allergy'],
  ['Были ли инфаркты у родственников?', chest, 'family'],
  ['Чем вы болели раньше?', chest, 'history'],
  ['Куда отдаёт эта боль?', chest, 'radiation'],
  ['Сколько длится один приступ?', chest, 'timing'],
  ['Бывает ли боль в покое?', chest, 'rest'],
  ['Кем вы работаете?', chest, 'work'],
];
for (const [line, card, factId] of phrasings) {
  const hits = factsProbedBy(card, line).map((f) => f.id);
  check(hits.includes(factId), `«${line}»`, hits.includes(factId) ? '' : `не попало в «${factId}» (попало: ${hits.join(', ') || 'ничего'})`);
}

console.log(failures ? `\n✗ расхождений: ${failures}\n` : '\n✓ матчер покрытия в порядке\n');
process.exit(failures ? 1 : 0);
