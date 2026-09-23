'use client';
/* Прогресс студента: динамика результата, разбор по критериям, покрытие
   расспроса и выгрузка истории. Данные считаются из сохранённых разборов,
   обращений к модели здесь нет. */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import AppHeader from '@/components/shared/AppHeader';
import { api, formatShortDate, friendlyError, plural } from '@/components/shared/utils';
import type { ProgressDTO, ProgressSession } from '@/lib/progress';
import './progress.css';

const toneOf = (percent: number) => (percent >= 75 ? 'high' : percent >= 45 ? 'mid' : 'low');
/* Рубрика у каждого домена своя, поэтому критериев набирается несколько
   десятков. Показываем самые слабые, остальные — по запросу. */
const CRITERIA_PREVIEW = 10;

export default function ProgressScreen() {
  const [data, setData] = useState<ProgressDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allCriteria, setAllCriteria] = useState(false);

  useEffect(() => {
    let alive = true;
    void api<ProgressDTO>('/api/progress')
      .then((dto) => alive && setData(dto))
      .catch((e) => alive && setError(friendlyError(e)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <div className="vp-progress">
        <AppHeader />
        <main className="vp-shell">
          <p className="vp-error" role="alert">
            {error}
          </p>
        </main>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="vp-progress">
        <AppHeader />
        <main className="vp-shell">
          <div className="vp-skeleton-head" aria-label="Загружаем прогресс">
            <span className="vp-skel vp-skel--line" style={{ width: '38%' }} />
            <span className="vp-skel vp-skel--title" />
          </div>
          <div className="vp-skeleton-tiles">
            {Array.from({ length: 4 }, (_, i) => (
              <span key={i} className="vp-skel vp-skel--tile" />
            ))}
          </div>
        </main>
      </div>
    );
  }

  const { summary } = data;
  const empty = summary.sessions === 0;
  const visibleCriteria = allCriteria ? data.criteria : data.criteria.slice(0, CRITERIA_PREVIEW);

  return (
    <div className="vp-progress">
      <AppHeader />

      <main className="vp-shell">
        <header className="vp-prog-head vp-in">
          <div>
            <p className="eyebrow">Личный прогресс</p>
            <h1>
              {data.student.displayName ?? data.student.username}
              {summary.deltaPercent !== null && summary.deltaPercent !== 0 && (
                <span className={`vp-delta is-${summary.deltaPercent > 0 ? 'up' : 'down'}`}>
                  {summary.deltaPercent > 0 ? '+' : ''}
                  {summary.deltaPercent} п.п.
                </span>
              )}
            </h1>
            <p className="vp-prog-sub">
              {empty
                ? 'История появится после первого завершённого разбора.'
                : `${summary.sessions} ${plural(summary.sessions, 'сцена', 'сцены', 'сцен')} · ${summary.activeDays} ${plural(summary.activeDays, 'день', 'дня', 'дней')} практики · с ${formatShortDate(summary.firstAt!)} по ${formatShortDate(summary.lastAt!)}`}
            </p>
          </div>

          {!empty && (
            <div className="vp-prog-actions vp-noprint">
              <a className="vp-btn vp-btn--ghost vp-btn--sm" href="/api/progress/export?format=csv" download>
                Скачать CSV
              </a>
              <a className="vp-btn vp-btn--ghost vp-btn--sm" href="/api/progress/export?format=json" download>
                JSON
              </a>
              <button type="button" className="vp-btn vp-btn--sm" onClick={() => window.print()}>
                Отчёт в PDF
              </button>
            </div>
          )}
        </header>

        {empty ? (
          <div className="vp-prog-empty vp-in">
            <p>Пока нечего показывать: пройдите сцену и дождитесь разбора.</p>
            <Link className="vp-btn" href="/">
              Начать первую сцену
            </Link>
          </div>
        ) : (
          <>
            <section className="vp-prog-tiles vp-in">
              <Tile
                value={summary.avgPercent === null ? '—' : `${summary.avgPercent}%`}
                label="средний результат"
                tone={summary.avgPercent === null ? undefined : toneOf(summary.avgPercent)}
              />
              <Tile value={summary.bestPercent === null ? '—' : `${summary.bestPercent}%`} label="лучший результат" />
              <Tile value={summary.doctorTurns} label={plural(summary.doctorTurns, 'реплика', 'реплики', 'реплик')} />
              <Tile
                value={summary.safetyFlags}
                label={plural(summary.safetyFlags, 'флаг безопасности', 'флага безопасности', 'флагов безопасности')}
                tone={summary.safetyFlags > 0 ? 'low' : 'high'}
              />
            </section>

            <section className="vp-card vp-in">
              <div className="vp-sec-head">
                <h2>Динамика результата</h2>
                <p>Каждая точка — завершённая сцена; наведите, чтобы увидеть, какая именно</p>
              </div>
              <TrendChart sessions={data.sessions.filter((s) => s.maxScore > 0)} />
            </section>

            {(data.highlights.length > 0 || data.focus.length > 0) && (
              <section className="vp-prog-notes vp-in">
                {data.highlights.length > 0 && (
                  <article className="vp-note vp-note--good">
                    <p className="eyebrow">Сильные стороны</p>
                    <ul>
                      {data.highlights.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </article>
                )}
                {data.focus.length > 0 && (
                  <article className="vp-note vp-note--focus">
                    <p className="eyebrow">Над чем работать</p>
                    <ul>
                      {data.focus.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </article>
                )}
              </section>
            )}

            <section className="vp-card vp-in">
              <div className="vp-sec-head">
                <h2>Критерии</h2>
                <p>Слабые впереди. Стрелка — динамика между ранними и поздними попытками</p>
              </div>
              <div className="vp-crit-rows">
                {visibleCriteria.map((criterion) => (
                  <div className="vp-crit-row" key={criterion.name}>
                    <div className="vp-crit-row-main">
                      <span className="vp-crit-row-name">{criterion.name}</span>
                      <span className="vp-crit-row-fw">{criterion.framework}</span>
                    </div>
                    <Sparkline values={criterion.trail} />
                    <span className="vp-crit-row-bar">
                      <i className={`is-${toneOf(criterion.percent)}`} style={{ width: `${criterion.percent}%` }} />
                    </span>
                    <span className="vp-crit-row-num">{criterion.percent}%</span>
                    <span className={`vp-crit-row-delta${criterion.delta === null ? '' : criterion.delta > 0 ? ' is-up' : criterion.delta < 0 ? ' is-down' : ''}`}>
                      {criterion.delta === null ? '—' : `${criterion.delta > 0 ? '+' : ''}${criterion.delta}`}
                    </span>
                  </div>
                ))}
              </div>
              {data.criteria.length > CRITERIA_PREVIEW && (
                <button
                  type="button"
                  className="vp-more vp-noprint"
                  onClick={() => setAllCriteria((value) => !value)}
                  aria-expanded={allCriteria}
                >
                  {allCriteria
                    ? 'Свернуть'
                    : `Показать все ${data.criteria.length} ${plural(data.criteria.length, 'критерий', 'критерия', 'критериев')}`}
                </button>
              )}
            </section>

            {data.coverage && (
              <section className="vp-card vp-in">
                <div className="vp-sec-head">
                  <h2>Что вы спрашиваете, а что пропускаете</h2>
                  <p>
                    По {data.coverage.sessions} {plural(data.coverage.sessions, 'сцене', 'сценам', 'сценам')} со скрытой
                    карточкой: закрыто {data.coverage.asked} из {data.coverage.total} пунктов
                  </p>
                </div>
                <div className="vp-probe-grid">
                  {data.probes.map((probe) => (
                    <div className="vp-probe" key={probe.probe}>
                      <span className="vp-probe-label">{probe.label}</span>
                      <span className="vp-probe-bar">
                        <i className={`is-${toneOf(probe.percent)}`} style={{ width: `${probe.percent}%` }} />
                      </span>
                      <span className="vp-probe-num">
                        {probe.asked}/{probe.total}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="vp-card vp-in">
              <div className="vp-sec-head">
                <h2>Разделы практики</h2>
                <p>Где вы тренировались и с каким результатом</p>
              </div>
              <div className="vp-domain-grid">
                {data.domains.map((domain) => (
                  <div className="vp-domain-cell" key={domain.title}>
                    <b>{domain.title}</b>
                    <span className={`vp-domain-pct is-${toneOf(domain.percent)}`}>{domain.percent}%</span>
                    <small>
                      {domain.attempts} {plural(domain.attempts, 'прогон', 'прогона', 'прогонов')} · последний{' '}
                      {formatShortDate(domain.lastAt)}
                    </small>
                  </div>
                ))}
              </div>
            </section>

            <section className="vp-card vp-in">
              <div className="vp-sec-head">
                <h2>Все прогоны</h2>
                <p>От свежих к ранним</p>
              </div>
              <div className="vp-prog-list">
                {[...data.sessions].reverse().map((session) => (
                  <Link className="vp-prog-row" key={session.sessionId} href={`/s/${session.sessionId}`}>
                    <span className="vp-prog-date">{formatShortDate(session.createdAt)}</span>
                    <span className="vp-prog-what">
                      <b>{session.domain}</b>
                      <small>{session.category}</small>
                    </span>
                    <span className="vp-prog-tags">
                      {session.mode === 'exam' && <i className="vp-tag vp-tag--exam">экзамен</i>}
                      {session.format === 'long' && <i className="vp-tag vp-tag--long">полный приём</i>}
                      {session.coverage && (
                        <i className="vp-tag">
                          расспрос {session.coverage.asked}/{session.coverage.total}
                        </i>
                      )}
                      {session.hasSafetyFlag && <i className="vp-tag vp-tag--danger">безопасность</i>}
                    </span>
                    <span className={`vp-prog-score is-${toneOf(session.percent)}`}>
                      {session.totalScore}
                      <i>/{session.maxScore}</i>
                    </span>
                  </Link>
                ))}
              </div>
            </section>

            <footer className="vp-prog-foot">
              Отчёт сформирован {new Date(data.generatedAt).toLocaleString('ru-RU')} · Vera Practice · критерии опираются
              на NURSE, Calgary–Cambridge, SPIKES и принципы Beauchamp&nbsp;&amp;&nbsp;Childress
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

function Tile({ value, label, tone }: { value: number | string; label: string; tone?: 'high' | 'mid' | 'low' }) {
  return (
    <div className={`vp-prog-tile${tone ? ` is-${tone}` : ''}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/* ---------- График динамики ---------- */

function TrendChart({ sessions }: { sessions: ProgressSession[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const W = 720;
  const H = 240;
  const PAD = { top: 18, right: 16, bottom: 28, left: 34 };

  const points = useMemo(() => {
    if (!sessions.length) return [];
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const step = sessions.length > 1 ? innerW / (sessions.length - 1) : 0;
    return sessions.map((session, i) => ({
      session,
      x: PAD.left + (sessions.length > 1 ? i * step : innerW / 2),
      y: PAD.top + innerH - (session.percent / 100) * innerH,
    }));
  }, [sessions]);

  if (!points.length) return <p className="vp-empty">Нет завершённых разборов.</p>;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${points[points.length - 1].x.toFixed(1)} ${H - PAD.bottom} L${points[0].x.toFixed(1)} ${H - PAD.bottom} Z`;
  const active = hover === null ? null : points[hover];

  return (
    <div className="vp-chart">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Динамика результата по ${points.length} сценам`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="vp-trend" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--coral)" stopOpacity="0.26" />
            <stop offset="100%" stopColor="var(--coral)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0, 25, 50, 75, 100].map((tick) => {
          const y = PAD.top + (H - PAD.top - PAD.bottom) * (1 - tick / 100);
          return (
            <g key={tick}>
              <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} className="vp-chart-grid" />
              <text x={PAD.left - 8} y={y + 4} className="vp-chart-tick" textAnchor="end">
                {tick}
              </text>
            </g>
          );
        })}

        <path d={area} fill="url(#vp-trend)" />
        <path d={line} className="vp-chart-line" />

        {points.map((point, i) => (
          <g key={point.session.sessionId}>
            <circle
              cx={point.x}
              cy={point.y}
              r={hover === i ? 6 : 4}
              className={`vp-chart-dot is-${toneOf(point.session.percent)}${point.session.hasSafetyFlag ? ' is-flagged' : ''}`}
            />
            {/* Прозрачная мишень пошире — попасть мышью в точку радиусом 4 тяжело. */}
            <rect
              x={point.x - 14}
              y={PAD.top}
              width={28}
              height={H - PAD.top - PAD.bottom}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          </g>
        ))}
      </svg>

      <div className="vp-chart-caption" aria-live="polite">
        {active ? (
          <>
            <b>{active.session.percent}%</b> · {active.session.domain} — {active.session.category} ·{' '}
            {formatShortDate(active.session.createdAt)}
          </>
        ) : (
          <span className="vp-chart-hint">
            от {formatShortDate(points[0].session.createdAt)} до{' '}
            {formatShortDate(points[points.length - 1].session.createdAt)}
          </span>
        )}
      </div>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="vp-spark vp-spark--empty" aria-hidden="true" />;
  const W = 68;
  const H = 22;
  const step = W / (values.length - 1);
  const d = values
    .map((value, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${(H - (value / 100) * H).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="vp-spark" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
