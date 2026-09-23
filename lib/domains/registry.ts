/* ============================================================
   Реестр учебных доменов. Домен — параметр движка: у каждого своя
   схема карточки кейса и свой применимый стандарт оценки.
   Добавление домена = новый файл в этой папке + строка в списке ниже.
   ============================================================ */

import type { SessionFormat, TrainingDomainDef, TrainingDomainKey } from '../types';
import { conflictDomain } from './conflict';
import { badNewsDomain } from './badNews';
import { consentDomain } from './consent';
import { motivationDomain } from './motivation';
import { errorDisclosureDomain } from './errorDisclosure';
import { familyDomain } from './family';
import { barriersDomain } from './barriers';
import { callCenterDomain } from './callCenter';
import { receptionDomain } from './reception';

const registry: TrainingDomainDef[] = [
  conflictDomain,
  callCenterDomain,
  receptionDomain,
  badNewsDomain,
  consentDomain,
  motivationDomain,
  errorDisclosureDomain,
  familyDomain,
  barriersDomain,
];

export const DOMAIN_REGISTRY: Readonly<Record<TrainingDomainKey, TrainingDomainDef>> = Object.freeze(
  Object.fromEntries(registry.map((domain) => [domain.key, domain])) as Record<TrainingDomainKey, TrainingDomainDef>
);

const aliases = new Map<string, TrainingDomainKey>();
for (const domain of registry) {
  aliases.set(domain.key.toLowerCase(), domain.key);
  for (const alias of domain.aliases) aliases.set(alias.toLowerCase(), domain.key);
}

export function domainByKey(key?: string | null): TrainingDomainDef | undefined {
  if (!key) return undefined;
  const canonical = aliases.get(key.trim().toLowerCase());
  return canonical ? DOMAIN_REGISTRY[canonical] : undefined;
}

export function domainCase(domainKey: string | undefined, caseIdOrTitle: string) {
  return domainByKey(domainKey)?.cases.find((item) => item.id === caseIdOrTitle || item.title === caseIdOrTitle);
}

export function domainByRubricId(rubricId?: string | null): TrainingDomainDef | undefined {
  return rubricId ? registry.find((domain) => domain.rubricId === rubricId) : undefined;
}

export function supportsFormat(domain: TrainingDomainDef, format: SessionFormat): boolean {
  return domain.formats.includes(format);
}

/** Домены в порядке показа: сначала два приоритетных, затем остальные. */
export const TRAINING_DOMAINS: readonly TrainingDomainDef[] = registry;
export const TRAINING_DOMAIN_KEYS = registry.map((domain) => domain.key);

/** Домены, где сцена идёт в выбранном формате — для выбора «случайной сцены». */
export function domainsForFormat(format: SessionFormat): TrainingDomainDef[] {
  return registry.filter((domain) => domain.formats.includes(format));
}
