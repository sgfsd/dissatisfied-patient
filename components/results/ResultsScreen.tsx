'use client';
/* Экран разбора: критерии со шкалами, цитаты-доказательства, флаги,
   итоговая рекомендация и переходы к следующим сценам. */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import AppHeader from '@/components/shared/AppHeader';
import { CATEGORY_SLUGS, type EvaluationDTO, type MessageDTO, type SessionPublicDTO } from '@/lib/types';
import { api, friendlyError, formatShortDate } from '@/components/shared/utils';
import type { CriterionResult } from '@/lib/types';
import './results.css';

interface Props {
  session: Omit<SessionPublicDTO, 'status'> & { status: string };
  messages: MessageDTO[];
  evaluation: EvaluationDTO;
}

const toneOf = (score: number, max: number) => {
  const r = max > 0 ? score / max : 0;
  return r >= 0.75 ? 'high' : r >= 0.45 ? 'mid' : 'low';
};

function flagText(f: string): string {
  const map: Record<string, string> = {
    prompt_injection: 'зафиксирована попытка повлиять на работу оценщика',
    injection: 'зафиксирована попытка повлиять на работу оценщика',
    refusal: 'модель отказалась отвечать',
  };
  return map[f] ?? f;
}

export default function ResultsScreen({ session, messages, evaluation }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pct = evaluation.maxScore > 0 ? Math.round((evaluation.totalScore / evaluation.maxScore) * 100) : 0;
  const verdict = pct >= 75 ? 'Сильная консультация' : pct >= 45 ? 'Уверенная середина' : 'Есть над чем работать';
  const docMsgs = useMemo(() => messages.filter((m) => m.speaker === 'doctor').length, [messages]);

  async function retrySame() {
    setBusy(true);
    setError(null);
    try {
      const slug = CATEGORY_SLUGS[session.domain];
      const { session: next } = await api<{ session: { sessionId: string } }>('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slug ? { domain: slug, category: session.category } : {}),
      });
      router.push(`/s/${next.sessionId}`);
    } catch (e) {
      setBusy(false);
      setError(friendlyError(e));
    }
  }

  return (
    <div className="vp-report">
      <AppHeader />

      <main className="vp-shell">
        {/* ——— шапка разбора ——— */}
        <header className="vp-report-head vp-in">
          <div className="vp-report-head-left">
            <p className="eyebrow">Разбор сцены</p>
            <h1>{verdict}</h1>
            <p className="vp-report-meta">
              {session.domain} · {session.category}
              <span className="vp-meta-sep">·</span>
              {session.patientFirst}, {session.patientAge}
              <span className="vp-meta-sep">·</span>
              {docMsgs} {docMsgs === 1 ? 'ответ' : 'ответов'} врача
            </p>
          </div>

          <div className={`vp-score-donut is-${toneOf(evaluation.totalScore, evaluation.maxScore)}`} style={{ ['--p' as string]: `${pct * 3.6}deg` }}>
            <div className="vp-score-donut-in">
              <b>{evaluation.totalScore}<i>/{evaluation.maxScore}</i></b>
              <span>{pct}%</span>
            </div>
          </div>
        </header>

        {error && <p className="vp-error-inline" role="alert">{error}</p>}

        {/* ——— алерты ——— */}
        {evaluation.safetyFlag && (
          <div className="vp-alert vp-alert--danger vp-in" role="alert">
            <b>Безопасность пациента.</b> {evaluation.safetyFlag}
          </div>
        )}
        {evaluation.flags.length > 0 && (
          <div className="vp-alert vp-alert--warn vp-in" role="note">
            {evaluation.flags.map((f) => <p key={f}>• {flagText(f)}</p>)}
          </div>
        )}

        {/* ——— критерии ——— */}
        <section className="vp-crit vp-in">
          <div className="vp-sec-head">
            <h2>Оценка по критериям</h2>
            <p>Каждый критерий опирается на признанный стандарт коммуникации</p>
          </div>
          <div className="vp-crit-list">
            {evaluation.criteria.map((c) => <CriterionCard key={c.name} c={c} />)}
          </div>
        </section>

        {/* ——— общий вывод ——— */}
        <section className="vp-summary vp-in">
          <p className="eyebrow">Общий вывод</p>
          <p className="vp-summary-text">{evaluation.overallSummary}</p>
        </section>

        {/* ——— диалог ——— */}
        <details className="vp-transcript vp-in">
          <summary>Показать диалог целиком ({messages.length} реплик)</summary>
          <div className="vp-transcript-body">
            {messages.map((m, i) => (
              <p key={i} className={m.speaker === 'doctor' ? 'is-doc' : 'is-pat'}>
                <b>{m.speaker === 'doctor' ? 'Вы' : session.patientFirst}:</b> {m.text}
              </p>
            ))}
          </div>
        </details>

        {/* ——— действия ——— */}
        <section className="vp-report-actions vp-in">
          <button type="button" className="vp-btn" disabled={busy} onClick={() => void retrySame()}>
            {busy ? 'Готовим сцену…' : 'Пройти похожую сцену'}
          </button>
          <button type="button" className="vp-btn vp-btn--ghost" onClick={() => router.push('/')}>Выбрать другую</button>
          <button type="button" className="vp-btn vp-btn--ghost" onClick={() => router.push('/history')}>История прогонов</button>
        </section>

        <footer className="vp-report-foot">
          Разбор выполнен моделью {evaluation.model} · критерии: NURSE, Calgary–Cambridge, принципы Beauchamp &amp; Childress · сцена от {formatShortDate(evaluation.createdAt)}
        </footer>
      </main>
    </div>
  );
}

function CriterionCard({ c }: { c: CriterionResult }) {
  const ratio = c.maxScore > 0 ? c.score / c.maxScore : 0;
  const tone = toneOf(c.score, c.maxScore);
  return (
    <article className={`vp-crit-card is-${tone}`}>
      <div className="vp-crit-top">
        <div>
          <h3>{c.name}</h3>
          <span className="vp-fw-tag">{c.framework}</span>
        </div>
        <span className="vp-crit-score">{c.score}<i>/{c.maxScore}</i></span>
      </div>
      <div className="vp-crit-bar" role="img" aria-label={`${c.score} из ${c.maxScore}`}>
        <i style={{ width: `${ratio * 100}%` }} />
      </div>
      <p className="vp-crit-evidence">«{c.evidenceQuote}»</p>
      <p className="vp-crit-expl">{c.explanation}</p>
    </article>
  );
}
