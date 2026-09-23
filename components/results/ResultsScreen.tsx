'use client';
/* Экран разбора: критерии со шкалами, цитаты-доказательства, покрытие опроса,
   флаг безопасности, итоговая рекомендация и переходы к следующим сценам. */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import AppHeader from '@/components/shared/AppHeader';
import type {
  CoverageReport,
  CriterionResult,
  EvaluationDTO,
  MessageDTO,
  SessionPublicDTO,
} from '@/lib/types';
import { api, friendlyError, formatShortDate, plural } from '@/components/shared/utils';
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
    prompt_injection: 'в ответе была попытка повлиять на работу оценщика — она исключена из оценки',
    injection: 'в ответе была попытка повлиять на работу оценщика — она исключена из оценки',
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
  const isExam = session.mode === 'exam';

  async function retrySame() {
    setBusy(true);
    setError(null);
    try {
      const { session: next } = await api<{ session: { sessionId: string } }>('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          session.domainKey ? { domain: session.domainKey, caseId: session.caseId } : {},
        ),
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
        <header className="vp-report-head vp-in">
          <div className="vp-report-head-left">
            <p className="eyebrow">{isExam ? 'Результат экзамена' : 'Разбор сцены'}</p>
            <h1>{verdict}</h1>
            <p className="vp-report-meta">
              {session.domain} · {session.category}
              <span className="vp-meta-sep">·</span>
              {session.patientFirst}, {session.patientAge}
              <span className="vp-meta-sep">·</span>
              {docMsgs} {plural(docMsgs, 'ответ', 'ответа', 'ответов')}
              {session.format === 'long' && (
                <>
                  <span className="vp-meta-sep">·</span>полный приём
                </>
              )}
            </p>
          </div>

          <div
            className={`vp-score-donut is-${toneOf(evaluation.totalScore, evaluation.maxScore)}`}
            style={{ ['--p' as string]: `${pct * 3.6}deg` }}
          >
            <div className="vp-score-donut-in">
              <b>
                {evaluation.totalScore}
                <i>/{evaluation.maxScore}</i>
              </b>
              <span>{pct}%</span>
            </div>
          </div>
        </header>

        {error && (
          <p className="vp-error-inline" role="alert">
            {error}
          </p>
        )}

        {/* ——— клиническая безопасность: показывается всегда, в том числе на экзамене ——— */}
        {evaluation.safetyFlag ? (
          <div className="vp-alert vp-alert--danger vp-in" role="alert">
            <b>Клиническая безопасность.</b> {evaluation.safetyFlag}
            <span className="vp-alert-note">
              Это отдельный сигнал: он не входит в коммуникативные баллы и разбирается как
              клиническая ошибка.
            </span>
          </div>
        ) : (
          <div className="vp-alert vp-alert--ok vp-in" role="note">
            <b>Клиническая безопасность.</b> Небезопасных советов и пропущенных экстренных
            маршрутов не зафиксировано.
          </div>
        )}

        {evaluation.flags.length > 0 && (
          <div className="vp-alert vp-alert--warn vp-in" role="note">
            {evaluation.flags.map((f) => (
              <p key={f}>• {flagText(f)}</p>
            ))}
          </div>
        )}

        {!isExam && evaluation.coverage && <CoveragePanel coverage={evaluation.coverage} />}

        {!isExam && (
          <section className="vp-crit vp-in">
            <div className="vp-sec-head">
              <h2>Оценка по критериям</h2>
              <p>Каждый критерий опирается на признанный стандарт коммуникации</p>
            </div>
            <div className="vp-crit-list">
              {evaluation.criteria.map((c) => (
                <CriterionCard key={c.name} c={c} />
              ))}
            </div>
          </section>
        )}

        {!isExam && (
          <section className="vp-summary vp-in">
            <p className="eyebrow">Общий вывод</p>
            <p className="vp-summary-text">{evaluation.overallSummary}</p>
          </section>
        )}

        {isExam && (
          <section className="vp-summary vp-in">
            <p className="eyebrow">Экзамен</p>
            <p className="vp-summary-text">
              Результат зафиксирован и передан преподавателю. Развёрнутый разбор по критериям
              доступен в режиме практики — пройдите похожий кейс без ограничений и сравните.
            </p>
          </section>
        )}

        {!isExam && (
          <details className="vp-transcript vp-in">
            <summary>
              Показать диалог целиком ({messages.length} {plural(messages.length, 'реплика', 'реплики', 'реплик')})
            </summary>
            <div className="vp-transcript-body">
              {messages.map((m, i) => (
                <p key={i} className={m.speaker === 'doctor' ? 'is-doc' : 'is-pat'}>
                  <b>{m.speaker === 'doctor' ? 'Вы' : session.patientFirst}:</b> {m.text}
                </p>
              ))}
            </div>
          </details>
        )}

        <section className="vp-report-actions vp-in">
          {!isExam && (
            <button type="button" className="vp-btn" disabled={busy} onClick={() => void retrySame()}>
              {busy ? 'Готовим сцену…' : 'Пройти этот кейс заново'}
            </button>
          )}
          <button type="button" className="vp-btn vp-btn--ghost" onClick={() => router.push('/')}>
            Выбрать другой кейс
          </button>
          <button type="button" className="vp-btn vp-btn--ghost" onClick={() => router.push('/history')}>
            История прогонов
          </button>
        </section>

        <footer className="vp-report-foot">
          Разбор выполнен моделью {evaluation.model} · {session.framework ?? 'NURSE, Calgary–Cambridge, Beauchamp & Childress'} ·
          сцена от {formatShortDate(evaluation.createdAt)}
        </footer>
      </main>
    </div>
  );
}

/* ---------- Покрытие опроса ---------- */

function CoveragePanel({ coverage }: { coverage: CoverageReport }) {
  const missed = coverage.items.filter((item) => !item.asked);
  const asked = coverage.items.filter((item) => item.asked);
  const [open, setOpen] = useState<'missed' | 'asked'>('missed');
  const list = open === 'missed' ? missed : asked;

  return (
    <section className="vp-coverage vp-in">
      <div className="vp-sec-head">
        <h2>Что вы спросили и что упустили</h2>
        <p>
          Считается по скрытой карточке кейса, а не моделью: у собеседника был полный набор фактов, и
          он сообщал их только в ответ на ваши вопросы
        </p>
      </div>

      <div className="vp-cov-top">
        <div className={`vp-cov-score is-${toneOf(coverage.score, coverage.maxScore)}`}>
          <b>
            {coverage.asked}
            <i>/{coverage.total}</i>
          </b>
          <span>пунктов закрыто</span>
        </div>
        <div className="vp-cov-groups">
          {coverage.groups.map((group) => {
            const ratio = group.total > 0 ? group.asked / group.total : 0;
            return (
              <div className="vp-cov-group" key={group.probe}>
                <span className="vp-cov-group-name">{group.label}</span>
                <span className="vp-cov-bar" aria-hidden="true">
                  <i className={`is-${toneOf(group.asked, group.total)}`} style={{ width: `${ratio * 100}%` }} />
                </span>
                <span className="vp-cov-group-num">
                  {group.asked}/{group.total}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {coverage.criticalMissed.length > 0 && (
        <p className="vp-cov-critical">
          <b>Критично пропущено:</b> {coverage.criticalMissed.join('; ')}. Такие пункты весят вдвое —
          пока они не закрыты, балл за полноту сбора ограничен.
        </p>
      )}

      <div className="vp-cov-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={open === 'missed'}
          className={open === 'missed' ? 'is-active' : undefined}
          onClick={() => setOpen('missed')}
        >
          Не спросили ({missed.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={open === 'asked'}
          className={open === 'asked' ? 'is-active' : undefined}
          onClick={() => setOpen('asked')}
        >
          Спросили ({asked.length})
        </button>
      </div>

      {list.length ? (
        <ul className="vp-cov-list">
          {list.map((item) => (
            <li key={item.id} className={item.critical ? 'is-critical' : undefined}>
              <span className="vp-cov-item-label">
                {item.label}
                {item.critical && <i className="vp-cov-chip">критично</i>}
              </span>
              {item.quote && <span className="vp-cov-item-quote">«{item.quote}»</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="vp-empty">
          {open === 'missed' ? 'Вы закрыли все пункты карточки.' : 'Ни один пункт карточки не прозвучал.'}
        </p>
      )}
    </section>
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
        <span className="vp-crit-score">
          {c.score}
          <i>/{c.maxScore}</i>
        </span>
      </div>
      <div className="vp-crit-bar" role="img" aria-label={`${c.score} из ${c.maxScore}`}>
        <i style={{ width: `${ratio * 100}%` }} />
      </div>
      {c.evidenceQuote ? (
        <p className="vp-crit-evidence">«{c.evidenceQuote}»</p>
      ) : (
        <p className="vp-crit-evidence vp-crit-evidence--empty">
          Подходящей фразы в ваших репликах не нашлось
        </p>
      )}
      <p className="vp-crit-expl">{c.explanation}</p>
    </article>
  );
}
