'use client';
/* История прогонов: список завершённых сцен с баллами, переход в разбор. */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AppHeader from '@/components/shared/AppHeader';
import { api, friendlyError, formatShortDate, plural } from '@/components/shared/utils';
import './history.css';

interface HistoryRowLike {
  sessionId: string; domain: string; category: string; moodLabel: string;
  patientFirst: string; createdAt: number; exchangesDone: number;
  totalScore: number; maxScore: number; overallSummary: string; hasSafetyFlag: boolean;
}

export default function HistoryScreen() {
  const [rows, setRows] = useState<HistoryRowLike[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { rows: all } = await api<{ rows: HistoryRowLike[]; stats: { total: number; done: number } }>('/api/history');
        if (alive) setRows(all.filter((r) => r.maxScore > 0));
      } catch (e) {
        if (alive) setError(friendlyError(e));
      }
    })();
    return () => { alive = false; };
  }, []);

  const done = rows ?? [];
  const avgPct = done.length
    ? Math.round(done.reduce((s, r) => s + (r.maxScore ? (r.totalScore / r.maxScore) : 0), 0) / done.length * 100)
    : 0;

  return (
    <div className="vp-history">
      <AppHeader />
      <main className="vp-shell">
        <header className="vp-history-head vp-in">
          <p className="eyebrow">Журнал</p>
          <h1>История прогонов</h1>
          <p className="vp-history-sub">Каждая завершённая сцена — здесь. Открывайте разбор, чтобы вспомнить, что получилось.</p>
        </header>

        {done.length > 0 && (
          <div className="vp-hstats vp-in">
            <div className="vp-hstat"><b>{done.length}</b><span>{plural(done.length, 'сцена', 'сцены', 'сцен')} пройдено</span></div>
            <div className="vp-hstat"><b>{avgPct}%</b><span>средний результат</span></div>
            <div className="vp-hstat"><b>{done.reduce((s, r) => s + r.exchangesDone, 0)}</b><span>ответов дано</span></div>
          </div>
        )}

        {error && <p className="vp-error-inline" role="alert">{error}</p>}

        {done.length === 0 && !error && (
          <div className="vp-hempty vp-in">
            <p>Пока нет ни одного завершённого разбора.</p>
            <Link className="vp-btn" href="/">Пройти первую сцену</Link>
          </div>
        )}

        <div className="vp-hlist">
          {done.map((r, i) => {
            const pct = r.maxScore > 0 ? Math.round((r.totalScore / r.maxScore) * 100) : 0;
            return (
              <Link key={r.sessionId} href={`/s/${r.sessionId}`} className="vp-hrow vp-in" style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}>
                <div className="vp-hrow-date">{formatShortDate(r.createdAt)}</div>
                <div className="vp-hrow-mid">
                  <p className="vp-hrow-title">{r.domain} · {r.category}</p>
                  <p className="vp-hrow-sub">
                    {r.patientFirst} · эмоция «{r.moodLabel}» · {r.exchangesDone} {plural(r.exchangesDone, 'ответ', 'ответа', 'ответов')}
                    {r.hasSafetyFlag && <span className="vp-hrow-flag">требует внимания</span>}
                  </p>
                </div>
                <div className="vp-hrow-score">
                  <b>{r.totalScore}<i>/{r.maxScore}</i></b>
                  <span className={pct >= 75 ? 'is-high' : pct >= 45 ? 'is-mid' : 'is-low'}>{pct}%</span>
                </div>
              </Link>
            );
          })}
        </div>
      </main>
    </div>
  );
}
