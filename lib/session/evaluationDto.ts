import { getEvaluationBySession } from '../db';
import type { CoverageReport, EvaluationDTO } from '../types';

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/**
 * Сохранённый разбор сессии в едином формате API — одном и том же для
 * студента (GET /api/sessions/:id) и преподавателя (транскрипт).
 */
export function evaluationDTO(sessionId: string): EvaluationDTO | null {
  const row = getEvaluationBySession(sessionId);
  if (!row) return null;
  const { evaluation, criteria } = row;
  return {
    evaluationId: evaluation.id,
    model: evaluation.model,
    criteria: criteria.map((c, i) => ({
      id: `${evaluation.id}-${i}`,
      name: c.name,
      framework: c.framework,
      score: c.score,
      maxScore: c.max_score,
      evidenceQuote: c.evidence_quote,
      explanation: c.explanation,
    })),
    overallSummary: evaluation.overall_summary,
    safetyFlag: evaluation.safety_flag,
    flags: parseJson<string[]>(evaluation.flags_json, []),
    createdAt: evaluation.created_at,
    totalScore: criteria.reduce((s, c) => s + c.score, 0),
    maxScore: criteria.reduce((s, c) => s + c.max_score, 0),
    coverage: parseJson<CoverageReport | null>(evaluation.coverage_json, null),
  };
}

/**
 * Экзамен для студента: итог, флаг безопасности и служебные флаги — да,
 * развёрнутый разбор — нет, он остаётся у преподавателя. Скрывается на
 * сервере, а не только в интерфейсе: иначе разбор читался бы в DevTools.
 */
export function redactExamEvaluation(dto: EvaluationDTO): EvaluationDTO {
  return { ...dto, criteria: [], overallSummary: '', coverage: null };
}
