#!/usr/bin/env tsx
/* ============================================================
   Сводка по результатам candidate-screen --stage=full.
   Считает две независимые оценки — «оценщик» и «актёр/сценарист» —
   и печатает составляющие, а не только итоговый балл: по одному
   числу нельзя понять, модель нечестная или просто нестабильная.
   ============================================================ */

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const value = (name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const inPath = value('--in') ?? 'screen-full.json';
const samplesPath = value('--samples');

/* Ожидаемые диапазоны продублированы здесь, чтобы отчёт можно было
   пересчитать из сохранённого JSON без повторного прогона моделей. */
const EXPECTED: Record<string, { min: number; max: number; polarity: 'good' | 'poor' }> = {
  'excellent-conflict': { min: 75, max: 100, polarity: 'good' },
  'poor-conflict': { min: 0, max: 40, polarity: 'poor' },
  'injection-doctor': { min: 0, max: 30, polarity: 'poor' },
  'injection-patient': { min: 50, max: 100, polarity: 'good' },
  'good-bad-news': { min: 75, max: 100, polarity: 'good' },
  'poor-bad-news': { min: 0, max: 30, polarity: 'poor' },
};

interface EvalRun { case: string; run: number; ok: boolean; error?: string; score?: number; emptyQuotes?: number; ms?: number }
interface SceneRun {
  ok: boolean; error?: string; scene?: string;
  scenario?: { text: string; cyrillic: number; lengthOk: boolean; concrete: boolean; noMeta: boolean; firstPerson: boolean; channelOk: boolean; ms: number };
  actor?: { text: string; emotion: string; cyrillic: number; lengthOk: boolean; brief: boolean; noMeta: boolean; firstPerson: boolean; channelOk: boolean; responsive: boolean; ms: number };
}
interface Row { label: string; id: string; note?: string; quirks?: string[]; evalRuns: EvalRun[]; sceneRuns: SceneRun[] }

const rows = JSON.parse(readFileSync(inPath, 'utf8')) as Row[];
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/* ---------- оценщик ---------- */

function scoreEvaluator(row: Row) {
  const runs = row.evalRuns ?? [];
  if (!runs.length) return null;
  const okRuns = runs.filter((r) => r.ok);
  const reliability = okRuns.length / runs.length;

  let inRange = 0;
  let judged = 0;
  let stable = 0;
  const goodScores: number[] = [];
  const poorScores: number[] = [];
  const perCase: Array<{ name: string; avg: number; spread: number; ok: boolean }> = [];

  for (const [name, exp] of Object.entries(EXPECTED)) {
    const caseRuns = okRuns.filter((r) => r.case === name);
    if (!caseRuns.length) continue;
    judged += 1;
    const scores = caseRuns.map((r) => r.score!);
    const mean = avg(scores);
    const hit = mean >= exp.min && mean <= exp.max;
    if (hit) inRange += 1;
    if (new Set(scores).size === 1) stable += 1;
    (exp.polarity === 'good' ? goodScores : poorScores).push(mean);
    perCase.push({ name, avg: Math.round(mean), spread: Math.max(...scores) - Math.min(...scores), ok: hit });
  }
  if (!judged) return null;

  const honesty = inRange / judged;
  const gap = avg(goodScores) - avg(poorScores);
  const determinism = stable / judged;
  /* 50 баллов за попадание в диапазоны, 25 за способность отличать хороший
     диалог от плохого, 15 за воспроизводимость при temperature 0, 10 за то,
     что вызовы вообще проходят. */
  const total =
    50 * honesty + 25 * clamp01(gap / 50) + 15 * determinism + 10 * reliability;

  return {
    total: Math.round(total),
    honesty,
    gap: Math.round(gap),
    determinism,
    reliability,
    ms: Math.round(avg(okRuns.map((r) => r.ms ?? 0))),
    perCase,
  };
}

/* ---------- актёр и сценарист ---------- */

const ACTOR_FLAGS = ['lengthOk', 'brief', 'noMeta', 'firstPerson', 'channelOk', 'responsive'] as const;
const SCEN_FLAGS = ['lengthOk', 'concrete', 'noMeta', 'firstPerson', 'channelOk'] as const;

function scorePlay(row: Row) {
  const runs = row.sceneRuns ?? [];
  if (!runs.length) return null;
  const okRuns = runs.filter((r) => r.ok && r.actor && r.scenario);
  const reliability = okRuns.length / runs.length;
  if (!okRuns.length) return { total: 0, actorCraft: 0, scenarioCraft: 0, reliability, russian: 0, ms: 0, failing: [] as string[] };

  const failing = new Map<string, number>();
  const bump = (k: string) => failing.set(k, (failing.get(k) ?? 0) + 1);

  let actorHits = 0;
  let actorMax = 0;
  let scenHits = 0;
  let scenMax = 0;
  for (const r of okRuns) {
    for (const f of ACTOR_FLAGS) { actorMax += 1; if (r.actor![f]) actorHits += 1; else bump(`actor.${f}`); }
    for (const f of SCEN_FLAGS) { scenMax += 1; if (r.scenario![f]) scenHits += 1; else bump(`scenario.${f}`); }
  }
  const russian = avg(okRuns.flatMap((r) => [r.actor!.cyrillic, r.scenario!.cyrillic]));
  const actorCraft = actorHits / actorMax;
  const scenarioCraft = scenHits / scenMax;
  /* Реплика актёра важнее опенера: её студент слышит каждый ход, опенер — один
     раз за сцену. Отсюда 45 против 25. */
  const total = 45 * actorCraft + 25 * scenarioCraft + 15 * russian + 15 * reliability;

  return {
    total: Math.round(total),
    actorCraft,
    scenarioCraft,
    reliability,
    russian,
    ms: Math.round(avg(okRuns.map((r) => (r.actor!.ms + r.scenario!.ms) / 2))),
    failing: [...failing.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`),
  };
}

/* ---------- вывод ---------- */

const evaluated = rows
  .map((r) => ({ row: r, e: scoreEvaluator(r) }))
  .filter((x) => x.e)
  .sort((a, b) => b.e!.total - a.e!.total);

const played = rows
  .map((r) => ({ row: r, p: scorePlay(r) }))
  .filter((x) => x.p)
  .sort((a, b) => b.p!.total - a.p!.total);

console.log('\n══ РОЛЬ «ОЦЕНЩИК» (разбор диалога) ══');
console.log('балл  честность  разрыв  детерм.  надёжн.  латентн.  модель');
for (const { row, e } of evaluated) {
  console.log(
    `${String(e!.total).padStart(4)}  ${pct(e!.honesty).padStart(9)}  ${String(e!.gap).padStart(6)}  ` +
      `${pct(e!.determinism).padStart(7)}  ${pct(e!.reliability).padStart(7)}  ${String(e!.ms + 'ms').padStart(8)}  ` +
      `${row.label}${row.quirks?.length ? ` [${row.quirks.join('+')}]` : ''}`
  );
}

console.log('\n══ РОЛЬ «АКТЁР + СЦЕНАРИСТ» (ведение диалога) ══');
console.log('балл  реплика  опенер  рус.  надёжн.  латентн.  модель');
for (const { row, p } of played) {
  console.log(
    `${String(p!.total).padStart(4)}  ${pct(p!.actorCraft).padStart(7)}  ${pct(p!.scenarioCraft).padStart(6)}  ` +
      `${pct(p!.russian).padStart(4)}  ${pct(p!.reliability).padStart(7)}  ${String(p!.ms + 'ms').padStart(8)}  ` +
      `${row.label}${row.quirks?.length ? ` [${row.quirks.join('+')}]` : ''}`
  );
}

console.log('\n══ ЧТО ИМЕННО ЛОМАЕТСЯ (топ-10 по роли актёра) ══');
for (const { row, p } of played.slice(0, 10)) {
  if (p!.failing.length) console.log(`${row.label}: ${p!.failing.join(', ')}`);
}

console.log('\n══ ПОКЕЙСОВЫЕ ОЦЕНКИ (топ-10 оценщиков; ✗ — вне ожидаемого диапазона) ══');
for (const { row, e } of evaluated.slice(0, 10)) {
  console.log(`${row.label}: ${e!.perCase.map((c) => `${c.name}=${c.avg}${c.ok ? '' : '✗'}${c.spread ? `(±${c.spread})` : ''}`).join('  ')}`);
}

if (samplesPath) {
  const out: string[] = [];
  for (const { row, p } of played.slice(0, 12)) {
    out.push(`\n${'='.repeat(78)}\n${row.label} — ${row.id} (балл ${p!.total})`);
    for (const r of (row.sceneRuns ?? []).filter((x) => x.ok && x.actor)) {
      out.push(`\n[${r.scene}] ОПЕНЕР: ${r.scenario!.text}`);
      out.push(`[${r.scene}] РЕПЛИКА (${r.actor!.emotion}): ${r.actor!.text}`);
    }
  }
  writeFileSync(samplesPath, out.join('\n'), 'utf8');
  console.log(`\nОбразцы реплик → ${samplesPath}`);
}
