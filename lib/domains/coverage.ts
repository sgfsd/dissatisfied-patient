/* ============================================================
   Покрытие опроса: что врач спросил и что пропустил.

   Считается движком, а не моделью. Источник истины — скрытая карточка
   кейса: у каждого факта есть `cues`, подстроки вопроса, по которым факт
   считается запрошенным. Это даёт две вещи:
   — оценка сбора анамнеза без «правильной ветки» диалога;
   — управление раскрытием: пациент отвечает ровно на то, о чём спросили.
   ============================================================ */

import {
  PROBE_LABELS,
  type CaseCard,
  type CaseFact,
  type CoverageGroup,
  type CoverageItem,
  type CoverageReport,
  type ProbeDomain,
} from '../types';

/** Нормализация под сравнение: нижний регистр, ё→е, пунктуация → пробелы. */
export function normalizeProbeText(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

/* Совпадение по основе слова: cue пишется стемом («аллерги», «как давно»),
   поэтому сравнение — подстрочное по нормализованному тексту. */
function cueHit(haystack: string, cue: string): boolean {
  const needle = normalizeProbeText(cue).trim();
  return needle.length > 2 && haystack.includes(needle);
}

/** Какие факты карточки затронуты конкретной репликой врача. */
export function factsProbedBy(card: CaseCard, doctorLine: string): CaseFact[] {
  const line = normalizeProbeText(doctorLine);
  return card.facts.filter((fact) => fact.cues.some((cue) => cueHit(line, cue)));
}

/** Факты, которые пациент уже мог сообщить к этому моменту диалога. */
export function revealedFacts(card: CaseCard, doctorLines: string[]): CaseFact[] {
  const seen = new Set<string>();
  const out: CaseFact[] = [];
  for (const fact of card.facts) {
    if (fact.volunteered) {
      seen.add(fact.id);
      out.push(fact);
    }
  }
  for (const line of doctorLines) {
    for (const fact of factsProbedBy(card, line)) {
      if (seen.has(fact.id)) continue;
      seen.add(fact.id);
      out.push(fact);
    }
  }
  return out;
}

function anchorScore(ratio: number, criticalMissed: number): { score: number; maxScore: number } {
  const maxScore = 3;
  if (criticalMissed > 0) return { score: ratio >= 0.6 ? 1 : 0, maxScore };
  if (ratio >= 0.8) return { score: 3, maxScore };
  if (ratio >= 0.6) return { score: 2, maxScore };
  if (ratio >= 0.35) return { score: 1, maxScore };
  return { score: 0, maxScore };
}

/**
 * Полный отчёт по карточке и репликам врача.
 * Факты, которые пациент выдаёт сам (`volunteered`), в знаменатель не идут:
 * заслуги врача в них нет.
 */
export function computeCoverage(card: CaseCard, doctorLines: string[]): CoverageReport {
  const lines = doctorLines.map((line) => ({ raw: line, norm: normalizeProbeText(line) }));
  const scored = card.facts.filter((fact) => !fact.volunteered);

  const items: CoverageItem[] = scored.map((fact) => {
    const hit = lines.find((line) => fact.cues.some((cue) => cueHit(line.norm, cue)));
    return {
      id: fact.id,
      probe: fact.probe,
      label: fact.label,
      asked: Boolean(hit),
      critical: Boolean(fact.critical),
      quote: hit ? hit.raw.slice(0, 240) : null,
    };
  });

  const groupOrder: ProbeDomain[] = [];
  const groupMap = new Map<ProbeDomain, CoverageGroup>();
  for (const item of items) {
    if (!groupMap.has(item.probe)) {
      groupOrder.push(item.probe);
      groupMap.set(item.probe, { probe: item.probe, label: PROBE_LABELS[item.probe], asked: 0, total: 0 });
    }
    const group = groupMap.get(item.probe)!;
    group.total += 1;
    if (item.asked) group.asked += 1;
  }

  // Критичные факты весят вдвое: пропущенная аллергия дороже пропущенной работы.
  const weight = (item: CoverageItem) => (item.critical ? 2 : 1);
  const totalWeight = items.reduce((sum, item) => sum + weight(item), 0);
  const askedWeight = items.reduce((sum, item) => sum + (item.asked ? weight(item) : 0), 0);
  const ratio = totalWeight > 0 ? askedWeight / totalWeight : 0;
  const criticalMissed = items.filter((item) => item.critical && !item.asked).map((item) => item.label);
  const { score, maxScore } = anchorScore(ratio, criticalMissed.length);

  const asked = items.filter((item) => item.asked).length;
  const missedLabels = items.filter((item) => !item.asked).map((item) => item.label);
  const summary = [
    `Спрошено ${asked} из ${items.length} значимых пунктов (${Math.round(ratio * 100)}% с учётом веса критичных).`,
    criticalMissed.length ? `Пропущено критично важное: ${criticalMissed.join('; ')}.` : 'Критичные пункты закрыты.',
    missedLabels.length ? `Не прозвучало: ${missedLabels.slice(0, 12).join('; ')}.` : 'Пропусков нет.',
  ].join(' ');

  return {
    items,
    groups: groupOrder.map((probe) => groupMap.get(probe)!),
    asked,
    total: items.length,
    criticalMissed,
    score,
    maxScore,
    summary,
  };
}

/** Текст карточки для режиссёра сцены и системного промта актёра. */
export function cardToPrompt(card: CaseCard): string {
  const byProbe = new Map<ProbeDomain, CaseFact[]>();
  for (const fact of card.facts) {
    if (!byProbe.has(fact.probe)) byProbe.set(fact.probe, []);
    byProbe.get(fact.probe)!.push(fact);
  }
  return [
    `СУТЬ КЕЙСА: ${card.headline}`,
    `С ЧЕМ ОБРАЩАЕТСЯ: ${card.presenting}`,
    '',
    'ФАКТЫ (правда о тебе; сообщай только то, о чём спросили):',
    ...[...byProbe.entries()].map(([probe, facts]) =>
      `• ${PROBE_LABELS[probe]}: ${facts
        .map((fact) => `${fact.value}${fact.volunteered ? ' [говоришь сам(а)]' : ''}`)
        .join('; ')}`
    ),
    card.redFlags.length ? `\nТРЕВОЖНЫЕ ПРИЗНАКИ (называй правдиво, если спросили именно о них): ${card.redFlags.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
