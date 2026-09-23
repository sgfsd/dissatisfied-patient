/* ============================================================
   Публичный каталог разделов — единственное, что о реестре доменов
   уходит в браузер. Клиентские компоненты не должны импортировать
   реестр напрямую: вместе с ним в общий JS-чанк попадают скрытые
   карточки кейсов, ожидаемые планы и эталоны оценщика, а статические
   чанки отдаются без входа. Страницы передают каталог пропсом,
   внешний клиент берёт его из GET /api/catalog.
   ============================================================ */

import type { PublicDomain } from '../types';
import { TRAINING_DOMAINS } from './registry';

export function publicCatalog(): PublicDomain[] {
  return TRAINING_DOMAINS.map((domain) => ({
    key: domain.key,
    title: domain.card.title,
    short: domain.card.short,
    accent: domain.card.accent,
    channel: domain.card.channel,
    framework: domain.card.framework,
    formats: [...domain.formats],
    stages: domain.stagePlan.stages.map((stage) => stage.title),
    cases: domain.cases.map((item) => ({
      id: item.id,
      title: item.title,
      brief: item.brief,
      factCount: item.card ? item.card.facts.length : null,
    })),
  }));
}
