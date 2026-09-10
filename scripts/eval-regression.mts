/* ============================================================
   Регресс AI-оценщика: прогоняет эталонные диалоги из
   regression-cases.mts через настоящий evaluateDialogue (та же
   схема, что и в проде — temperature 0) и сверяет баллы с
   ожидаемыми диапазонами.

   Запуск:  npm run regression
   Опции:   --case=<подстрока>   только кейсы, где key содержит подстроку
            --limit=<N>          первые N кейсов
            --workers=<N>        параллельных вызовов (по умолчанию 1)

   Выход:  0 — все кейсы в ожиданиях; 1 — есть расхождения.
   ============================================================ */

import { evaluateDialogue, type EvalVerdict } from '../lib/evaluation/evaluator';
import { rubricForCategory } from '../lib/evaluation/rubric';
import { personaById } from '../lib/personas';
import { AiError } from '../lib/ai/errors';
import type { EvalMessage } from '../lib/evaluation/evaluator';
import { REGRESSION_CASES, moodOf, type RegressionCase } from './regression-cases';
import type { PatientEmotion } from '../lib/types';

/* ---------- опции CLI ---------- */

const args = process.argv.slice(2);
const opt = (flag: string) => {
  const hit = args.find((a) => a.startsWith(flag));
  return hit ? hit.split('=')[1] : undefined;
};
const caseFilter = opt('--case');
const limit = opt('--limit') ? Number(opt('--limit')) : Infinity;
const workers = Math.max(1, Number(opt('--workers') ?? 1));

/* ---------- построение EvaluateParams из кейса ---------- */

function toEvalMessages(c: RegressionCase): EvalMessage[] {
  const out: EvalMessage[] = [{ speaker: 'patient', text: c.opener.text, emotion: c.opener.emotion }];
  for (const turn of c.dialogue) {
    out.push({ speaker: 'doctor', text: turn.doctor, emotion: null });
    if (turn.patient) out.push({ speaker: 'patient', text: turn.patient.text, emotion: turn.patient.emotion });
  }
  return out;
}

function buildParams(c: RegressionCase) {
  const persona = personaById(c.personaKey);
  const params = {
    domainTitle: c.domain,
    categoryTitle: c.category,
    personaKey: c.personaKey,
    patientFirst: persona.firstName,
    patientAge: persona.age,
    moodLabel: c.moodLabel ?? moodOf(c.opener.emotion),
    complaintSeed: c.complaint,
    openerText: c.opener.text,
    hiddenMotive: c.motive,
    messages: toEvalMessages(c),
    requestId: `regr_${c.key}`,
  };
  if (c.actingNotes) (params as { actingNotes?: string }).actingNotes = c.actingNotes;
  return params;
}

/* ---------- проверка вердикта ---------- */

interface CheckReport {
  ok: boolean;
  lines: string[];
}

function checkVerdict(c: RegressionCase, v: EvalVerdict | null, err: unknown): CheckReport {
  const lines: string[] = [];
  if (err || !v) {
    const msg = err instanceof AiError ? `AiError ${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    return { ok: false, lines: [`  упал вызов оценщика: ${msg}`] };
  }

  const expectBy = new Map(c.criteria.map((x) => [x.name, x]));
  let ok = true;
  const parts: string[] = [];

  for (const crit of v.criteria) {
    const exp = expectBy.get(crit.name);
    if (!exp) {
      lines.push(`  критерий «${crit.name}» не указан в ожиданиях кейса`);
      ok = false;
      continue;
    }
    const inBand = crit.score >= exp.min && crit.score <= exp.max;
    if (!inBand) {
      lines.push(`  «${crit.name}»: ${crit.score}/${crit.maxScore} вне ожидания ${exp.min}–${exp.max}`);
      ok = false;
    }
    parts.push(`${crit.score}/${crit.maxScore} «${short(crit.name)}»${inBand ? '' : ' !'}`);
    // Пустая цитата при ненулевом балле — нарушение требования «сначала цитата».
    if (!crit.evidenceQuote && crit.score > 0) {
      lines.push(`  «${crit.name}»: балл ${crit.score}, но цитата-доказательство пустая`);
      ok = false;
    }
  }

  // полнота: оценщик должен вернуть ровно критерии рубрики (гарантируется парсером, проверяем на всякий случай)
  const names = new Set(v.criteria.map((x) => x.name));
  for (const exp of c.criteria) {
    if (!names.has(exp.name)) {
      lines.push(`  критерий «${exp.name}» отсутствует в ответе`);
      ok = false;
    }
  }
  if (v.criteria.length !== c.criteria.length) {
    lines.push(`  число критериев ${v.criteria.length} ≠ ${c.criteria.length}`);
    ok = false;
  }

  const total = v.criteria.reduce((s, x) => s + x.score, 0);
  const [tmin, tmax] = c.total;
  if (total < tmin || total > tmax) {
    lines.push(`  сумма ${total}/12 вне ожидания ${tmin}–${tmax}`);
    ok = false;
  }
  parts.push(`Σ ${total}`);

  if (!v.overallSummary || v.overallSummary.length < 40) {
    lines.push('  overall_summary пуст или короче 40 символов');
    ok = false;
  }

  const safetyNow = Boolean(v.safetyFlag);
  if (c.expectSafety && !safetyNow) {
    lines.push('  ожидался safety_flag — его нет');
    ok = false;
  }
  if (!c.expectSafety && safetyNow) {
    lines.push(`  safety_flag не ожидался, а он есть: ${v.safetyFlag}`);
    ok = false;
  }

  const hasInj = v.flags.some((f) => /injection/i.test(f));
  if (c.expectInjectionFlag && !hasInj) {
    lines.push('  ожидался флаг prompt_injection — его нет');
    ok = false;
  }
  if (!c.expectInjectionFlag && hasInj) {
    lines.push(`  флаг injection не ожидался: ${v.flags.join(', ')}`);
    ok = false;
  }

  return { ok, lines: [`  ${parts.join(' · ')}`, ...lines] };
}

function short(s: string): string {
  return s.length > 26 ? `${s.slice(0, 24)}…` : s;
}

/* ---------- запуск с пулом ---------- */

async function main() {
  console.log('Vera Practice — регресс AI-оценщика');
  console.log('====================================');
  console.log(`Кейсов в наборе: ${REGRESSION_CASES.length} · workers=${workers} · фильтр=${caseFilter ?? 'все'}\n`);

  const cases = REGRESSION_CASES
    .filter((c) => !caseFilter || c.key.includes(caseFilter))
    .slice(0, limit === Infinity ? undefined : limit);

  const t0 = Date.now();
  let failures = 0;
  let idx = 0;

  // простой пул: workers одновременных задач
  const queue = [...cases];
  async function worker(): Promise<void> {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      idx += 1;
      const no = String(idx).padStart(2, '0');
      let verdict: EvalVerdict | null = null;
      let err: unknown = null;
      try {
        verdict = await evaluateDialogue(buildParams(c));
      } catch (e) {
        err = e;
      }
      const report = checkVerdict(c, verdict, err);
      const mark = report.ok ? '✓' : '✗';
      if (!report.ok) failures += 1;
      console.log(`${mark} ${no}/${cases.length} ${c.key}  «${c.title}»`);
      console.log(report.lines.join('\n'));
      if (report.ok) console.log('');
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, cases.length) }, () => worker()));

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(failures === 0
    ? `\nВсе ${cases.length} кейсов в ожидаемых диапазонах за ${secs}с.`
    : `\nРасхождений: ${failures} из ${cases.length} за ${secs}с.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('Регресс-скрипт упал:', e);
  process.exit(2);
});
