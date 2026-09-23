/* ============================================================
   История прогресса студента.

   Разовый разбор показывает, как прошла одна сцена. Учебная ценность
   появляется, когда видно движение: где студент вырос, где топчется на
   месте, какие критерии проседают из раза в раз. Всё считается из уже
   сохранённых разборов — ни одного обращения к модели здесь нет, поэтому
   страница прогресса бесплатна и открывается мгновенно.
   ============================================================ */

import {
  progressCriteria,
  progressSessions,
  type ProgressCriterionRow,
  type ProgressSessionRow,
} from './db';
import { domainByKey } from './domains';
import { PROBE_LABELS, type CoverageReport, type ProbeDomain } from './types';
import type { AccountUser } from './auth';

export interface ProgressSession {
  sessionId: string;
  createdAt: number;
  domain: string;
  domainKey: string | null;
  category: string;
  mode: 'practice' | 'exam';
  format: 'short' | 'long';
  exchangesDone: number;
  totalScore: number;
  maxScore: number;
  percent: number;
  hasSafetyFlag: boolean;
  safetyFlag: string | null;
  coverage: { asked: number; total: number; percent: number } | null;
  summary: string;
}

export interface ProgressCriterion {
  name: string;
  framework: string;
  attempts: number;
  avgScore: number;
  maxScore: number;
  percent: number;
  /** Динамика: ранняя половина попыток против поздней, в процентных пунктах. */
  delta: number | null;
  /** Последние значения в хронологии — для спарклайна. */
  trail: number[];
}

export interface ProgressDomain {
  domainKey: string | null;
  title: string;
  attempts: number;
  percent: number;
  lastAt: number;
}

export interface ProgressProbe {
  probe: ProbeDomain;
  label: string;
  asked: number;
  total: number;
  percent: number;
}

export interface ProgressDTO {
  generatedAt: number;
  student: { id: string; displayName: string | null; username: string };
  summary: {
    sessions: number;
    practice: number;
    exams: number;
    longFormat: number;
    avgPercent: number | null;
    bestPercent: number | null;
    lastPercent: number | null;
    deltaPercent: number | null;
    safetyFlags: number;
    doctorTurns: number;
    firstAt: number | null;
    lastAt: number | null;
    activeDays: number;
  };
  sessions: ProgressSession[];
  criteria: ProgressCriterion[];
  domains: ProgressDomain[];
  /** Покрытие опроса: только по сценам с карточкой кейса. */
  probes: ProgressProbe[];
  coverage: { asked: number; total: number; percent: number; sessions: number } | null;
  /** Короткие текстовые выводы — их же печатает отчёт. */
  highlights: string[];
  focus: string[];
}

const pct = (value: number, of: number) => (of > 0 ? Math.round((value / of) * 100) : 0);
/** Русское склонение: «3 оценки», а не «3 оценок». */
const plural = (n: number, one: string, few: string, many: string) => {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  return last === 1 ? one : many;
};
const avg = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function parseCoverage(raw: string | null): CoverageReport | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CoverageReport;
    return Array.isArray(parsed?.items) ? parsed : null;
  } catch {
    return null;
  }
}

function toSession(row: ProgressSessionRow): ProgressSession {
  const total = row.totalScore ?? 0;
  const max = row.maxScore ?? 0;
  const coverage = parseCoverage(row.coverageJson);
  return {
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    domain: row.domain,
    domainKey: row.domainKey,
    category: row.category,
    mode: row.mode === 'exam' ? 'exam' : 'practice',
    format: row.format === 'long' ? 'long' : 'short',
    exchangesDone: row.exchangesDone,
    totalScore: total,
    maxScore: max,
    percent: pct(total, max),
    hasSafetyFlag: Boolean(row.safetyFlag),
    safetyFlag: row.safetyFlag,
    coverage: coverage
      ? { asked: coverage.asked, total: coverage.total, percent: pct(coverage.asked, coverage.total) }
      : null,
    // Развёрнутый вывод по экзамену остаётся у преподавателя (см. redactExamEvaluation).
    summary: row.mode === 'exam' ? '' : row.overallSummary ?? '',
  };
}

/**
 * Динамика по критерию. Сравниваем раннюю половину попыток с поздней:
 * это устойчивее к одной неудачной сцене, чем «первая против последней»,
 * и при этом честно показывает направление движения.
 */
function criterionTrend(rows: ProgressCriterionRow[]): ProgressCriterion {
  const first = rows[0];
  const percents = rows.map((row) => pct(row.score, row.maxScore));
  let delta: number | null = null;
  if (rows.length >= 4) {
    const half = Math.floor(rows.length / 2);
    delta = Math.round(avg(percents.slice(half)) - avg(percents.slice(0, half)));
  }
  return {
    name: first.name,
    framework: first.framework,
    attempts: rows.length,
    avgScore: Math.round(avg(rows.map((row) => row.score)) * 100) / 100,
    maxScore: Math.max(...rows.map((row) => row.maxScore)),
    percent: Math.round(avg(percents)),
    delta,
    trail: percents.slice(-12),
  };
}

export function buildProgress(user: AccountUser): ProgressDTO {
  const rawSessions = progressSessions(user.id);
  const rawCriteria = progressCriteria(user.id);
  const sessions = rawSessions.map(toSession);
  const scored = sessions.filter((session) => session.maxScore > 0);
  const percents = scored.map((session) => session.percent);

  /* Динамика в целом — та же логика половин, что и по критериям. */
  let deltaPercent: number | null = null;
  if (percents.length >= 4) {
    const half = Math.floor(percents.length / 2);
    deltaPercent = Math.round(avg(percents.slice(half)) - avg(percents.slice(0, half)));
  }

  const byCriterion = new Map<string, ProgressCriterionRow[]>();
  for (const row of rawCriteria) {
    if (!byCriterion.has(row.name)) byCriterion.set(row.name, []);
    byCriterion.get(row.name)!.push(row);
  }
  const criteria = [...byCriterion.values()]
    .map(criterionTrend)
    .sort((a, b) => a.percent - b.percent);

  const byDomain = new Map<string, ProgressSession[]>();
  for (const session of sessions) {
    const key = session.domainKey ?? session.domain;
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key)!.push(session);
  }
  const domains: ProgressDomain[] = [...byDomain.entries()]
    .map(([key, list]) => ({
      domainKey: list[0].domainKey,
      title: domainByKey(key)?.card.title ?? list[0].domain,
      attempts: list.length,
      percent: Math.round(avg(list.filter((s) => s.maxScore > 0).map((s) => s.percent))),
      lastAt: Math.max(...list.map((s) => s.createdAt)),
    }))
    .sort((a, b) => b.attempts - a.attempts);

  /* Покрытие опроса складывается по всем сценам с карточкой: так видно,
     какие домены расспроса студент обходит стороной из раза в раз. */
  const probeTotals = new Map<ProbeDomain, { asked: number; total: number }>();
  let coverageAsked = 0;
  let coverageTotal = 0;
  let coverageSessions = 0;
  for (const row of rawSessions) {
    const coverage = parseCoverage(row.coverageJson);
    if (!coverage) continue;
    coverageSessions += 1;
    coverageAsked += coverage.asked;
    coverageTotal += coverage.total;
    for (const item of coverage.items) {
      const bucket = probeTotals.get(item.probe) ?? { asked: 0, total: 0 };
      bucket.total += 1;
      if (item.asked) bucket.asked += 1;
      probeTotals.set(item.probe, bucket);
    }
  }
  const probes: ProgressProbe[] = [...probeTotals.entries()]
    .map(([probe, value]) => ({
      probe,
      label: PROBE_LABELS[probe],
      asked: value.asked,
      total: value.total,
      percent: pct(value.asked, value.total),
    }))
    .sort((a, b) => a.percent - b.percent);

  const days = new Set(sessions.map((session) => new Date(session.createdAt).toDateString()));
  const safetyFlags = sessions.filter((session) => session.hasSafetyFlag).length;

  /* Короткие выводы для отчёта: сильные стороны и над чем работать. */
  const highlights: string[] = [];
  const focus: string[] = [];
  const strong = [...criteria].filter((c) => c.attempts >= 2 && c.percent >= 75).slice(-3).reverse();
  for (const item of strong)
    highlights.push(
      `${item.name} — устойчиво ${item.percent}% за ${item.attempts} ${plural(item.attempts, 'оценку', 'оценки', 'оценок')}.`,
    );
  if (deltaPercent !== null && deltaPercent > 4)
    highlights.push(
      `Общий результат вырос на ${deltaPercent} ${plural(deltaPercent, 'процентный пункт', 'процентных пункта', 'процентных пунктов')} ко второй половине прогонов.`,
    );
  const improving = criteria.filter((c) => c.delta !== null && c.delta > 8).slice(0, 2);
  for (const item of improving) highlights.push(`${item.name}: рост на ${item.delta} п.п.`);

  for (const item of criteria.filter((c) => c.attempts >= 2 && c.percent < 55).slice(0, 3))
    focus.push(`${item.name} — в среднем ${item.percent}%, основа: ${item.framework}.`);
  for (const item of probes.filter((p) => p.percent < 50).slice(0, 2))
    focus.push(`Расспрос «${item.label}» закрыт лишь в ${item.percent}% случаев.`);
  if (safetyFlags > 0)
    focus.push(`Флагов клинической безопасности: ${safetyFlags}. Разберите эти сцены отдельно.`);
  if (!focus.length && scored.length)
    focus.push('Явных провалов нет — берите более сложные домены и длинный формат.');

  return {
    generatedAt: Date.now(),
    student: { id: user.id, displayName: user.displayName, username: user.username },
    summary: {
      sessions: sessions.length,
      practice: sessions.filter((session) => session.mode === 'practice').length,
      exams: sessions.filter((session) => session.mode === 'exam').length,
      longFormat: sessions.filter((session) => session.format === 'long').length,
      avgPercent: percents.length ? Math.round(avg(percents)) : null,
      bestPercent: percents.length ? Math.max(...percents) : null,
      lastPercent: percents.length ? percents[percents.length - 1] : null,
      deltaPercent,
      safetyFlags,
      doctorTurns: sessions.reduce((sum, session) => sum + session.exchangesDone, 0),
      firstAt: sessions.length ? sessions[0].createdAt : null,
      lastAt: sessions.length ? sessions[sessions.length - 1].createdAt : null,
      activeDays: days.size,
    },
    sessions,
    criteria,
    domains,
    probes,
    coverage: coverageSessions
      ? {
          asked: coverageAsked,
          total: coverageTotal,
          percent: pct(coverageAsked, coverageTotal),
          sessions: coverageSessions,
        }
      : null,
    highlights,
    focus,
  };
}

/* ---------- Выгрузка ---------- */

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** CSV для журнала и Excel: разделитель «;», BOM для кириллицы. */
export function progressToCsv(dto: ProgressDTO): string {
  const lines: string[] = [];
  lines.push(['Дата', 'Раздел', 'Кейс', 'Режим', 'Формат', 'Ответов', 'Балл', 'Максимум', 'Процент', 'Покрытие опроса', 'Флаг безопасности'].join(';'));
  for (const session of dto.sessions) {
    lines.push(
      [
        new Date(session.createdAt).toLocaleString('ru-RU'),
        session.domain,
        session.category,
        session.mode === 'exam' ? 'экзамен' : 'практика',
        session.format === 'long' ? 'полный приём' : 'короткая сцена',
        session.exchangesDone,
        session.totalScore,
        session.maxScore,
        `${session.percent}%`,
        session.coverage ? `${session.coverage.asked}/${session.coverage.total}` : '',
        session.safetyFlag ?? '',
      ]
        .map(csvCell)
        .join(';'),
    );
  }
  lines.push('');
  lines.push(['Критерий', 'Основа', 'Оценок', 'Средний балл', 'Максимум', 'Процент', 'Динамика, п.п.'].join(';'));
  for (const criterion of dto.criteria) {
    lines.push(
      [
        criterion.name,
        criterion.framework,
        criterion.attempts,
        criterion.avgScore,
        criterion.maxScore,
        `${criterion.percent}%`,
        criterion.delta === null ? '' : criterion.delta,
      ]
        .map(csvCell)
        .join(';'),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
