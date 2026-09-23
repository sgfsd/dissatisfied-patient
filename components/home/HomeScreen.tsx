"use client";
/* Приёмная: выбор домена и кейса, режим (практика/экзамен), запуск сцены.
   Формат не выбирается вручную — он свойство домена: короткая сцена или
   полная консультация «регистратура → выписка». */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import AppHeader from "@/components/shared/AppHeader";
import { AvatarRig } from "@/components/avatar/AvatarRig";
import { personaById } from "@/lib/personas";
import type { PublicCase, PublicDomain, SessionPublicDTO } from "@/lib/types";
import { api, friendlyError, plural } from "@/components/shared/utils";
import "./home.css";

interface StartPayload {
  session: SessionPublicDTO & { personaVoice?: string };
}
type Assignment = {
  id: string;
  title: string;
  cases: Array<{ domainKey: string; caseId: string }>;
};
type Quota = { limit: number; used: number; remaining: number };

const CHANNEL_LABEL: Record<string, string> = {
  visual: "Кабинет",
  "voice-only": "Только голос",
};

/** catalog — публичная проекция реестра (lib/domains/catalog.ts), без скрытых карточек. */
export default function HomeScreen({ catalog }: { catalog: PublicDomain[] }) {
  const router = useRouter();
  const domains = catalog;
  const [domain, setDomain] = useState<PublicDomain | null>(null);
  const [selectedCase, setSelectedCase] = useState<PublicCase | null>(null);
  const [mode, setMode] = useState<"practice" | "exam">("practice");
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const format = domain?.formats.includes("long") && !domain.formats.includes("short") ? "long" : "short";
  const cases = domain?.cases ?? [];

  const matchingAssignments = useMemo(
    () =>
      domain && selectedCase
        ? assignments.filter((a) =>
            a.cases.some((c) => c.domainKey === domain.key && c.caseId === selectedCase.id),
          )
        : [],
    [assignments, domain, selectedCase],
  );

  useEffect(() => {
    void api<{ assignments: Assignment[] }>("/api/teacher/assignments")
      .then((r) => setAssignments(r.assignments))
      .catch(() => undefined);
    void api<Quota>("/api/auth/quota")
      .then(setQuota)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (mode === "exam" && !matchingAssignments.length) setMode("practice");
  }, [mode, matchingAssignments.length]);

  async function start(options: {
    random?: boolean;
    assignmentId?: string;
    domainKey?: string;
    caseId?: string;
  }) {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = {};
      const targetDomain = options.domainKey ?? (options.random ? undefined : domain?.key);
      const targetCase = options.caseId ?? (options.random ? undefined : selectedCase?.id);
      if (targetDomain) body.domain = targetDomain;
      if (targetCase) body.caseId = targetCase;
      if (options.assignmentId) {
        body.assignmentId = options.assignmentId;
        body.mode = "exam";
      } else {
        body.mode = options.random ? "practice" : mode;
        if (mode === "exam" && matchingAssignments[0] && !options.random) {
          body.assignmentId = matchingAssignments[0].id;
        }
      }
      const { session } = await api<StartPayload>("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      router.push(`/s/${session.sessionId}`);
    } catch (e) {
      setError(friendlyError(e));
      setBusy(false);
    }
  }

  const assignedCaseList = assignments.flatMap((assignment) =>
    assignment.cases.map((item) => {
      const found = domains.find((d) => d.key === item.domainKey);
      return {
        assignmentId: assignment.id,
        assignmentTitle: assignment.title,
        domain: found,
        item: found?.cases.find((c) => c.id === item.caseId),
      };
    }),
  );

  return (
    <div className="vp-home">
      <AppHeader />

      <main>
        <section className="vp-hero vp-shell">
          <div className="vp-hero-copy vp-in">
            <p className="eyebrow">Тренажёр клинической коммуникации</p>
            <h1 className="vp-hero-title">
              Разговор, который
              <br />
              <em className="display-serif">не идёт по сценарию</em>
            </h1>
            <p className="vp-hero-sub">
              Приём, телефонная линия колл-центра или полная консультация от регистратуры до
              выписки. Собеседник отвечает на ваши формулировки, а не на выбранный вариант, и
              рассказывает о себе только то, о чём вы спросили. После прогона — разбор по NURSE,
              Calgary–Cambridge, SPIKES и принципам Beauchamp&nbsp;&amp;&nbsp;Childress.
            </p>
            <ol className="vp-steps">
              <li>
                <span>1</span>Выберите раздел и кейс
              </li>
              <li>
                <span>2</span>Ведите разговор голосом или текстом
              </li>
              <li>
                <span>3</span>Получите разбор с цитатами из ваших слов
              </li>
            </ol>
          </div>

          <div className="vp-hero-visual vp-in">
            <div className="vp-hero-card">
              <div className="vp-hero-avatar">
                <AvatarRig persona={personaById("galina73")} emotion="neutral" className="vp-avatar" />
              </div>
              <p className="vp-hero-cap">
                Пациент реагирует на каждое ваше слово — мимикой, тоном и репликами.
              </p>
            </div>
          </div>
        </section>

        {assignedCaseList.length > 0 && (
          <section className="vp-assigned vp-shell vp-in">
            <div className="vp-pick-head">
              <div>
                <p className="eyebrow">Назначено преподавателем</p>
                <h2>Экзаменационные кейсы</h2>
              </div>
              <p className="vp-hint">
                Один заход, ограничение по времени, переиграть нельзя. Разбор по критериям
                увидит преподаватель.
              </p>
            </div>
            <div className="vp-assigned-grid">
              {assignedCaseList.map(({ assignmentId, assignmentTitle, domain: d, item }) =>
                d && item ? (
                  <article key={`${assignmentId}:${d.key}:${item.id}`} className={`vp-assigned-card dm-${d.accent}`}>
                    <p className="vp-assigned-title">{assignmentTitle}</p>
                    <h3>{item.title}</h3>
                    <p className="vp-assigned-meta">
                      {d.title} · {CHANNEL_LABEL[d.channel]}
                    </p>
                    <button
                      type="button"
                      className="vp-btn vp-btn--dark vp-btn--sm"
                      disabled={busy}
                      onClick={() => void start({ assignmentId, domainKey: d.key, caseId: item.id })}
                    >
                      Начать экзамен
                    </button>
                  </article>
                ) : null,
              )}
            </div>
          </section>
        )}

        <section className="vp-pick vp-shell vp-in">
          <div className="vp-pick-head">
            <div>
              <p className="eyebrow">Шаг 1</p>
              <h2>Выберите раздел практики</h2>
            </div>
            <button
              type="button"
              className="vp-btn vp-btn--ghost vp-btn--sm"
              disabled={busy}
              onClick={() => void start({ random: true })}
            >
              Случайная сцена
            </button>
          </div>

          <div className="vp-domains" role="listbox" aria-label="Разделы практики">
            {domains.map((d) => (
              <button
                key={d.key}
                type="button"
                role="option"
                aria-selected={domain?.key === d.key}
                className={`vp-domain dm-${d.accent}${domain?.key === d.key ? " is-active" : ""}`}
                onClick={() => {
                  setDomain((cur) => (cur?.key === d.key ? cur : d));
                  setSelectedCase(null);
                }}
              >
                <span className="vp-domain-title">{d.title}</span>
                <span className="vp-domain-short">{d.short}</span>
                <span className="vp-domain-tags">
                  {d.channel === "voice-only" && <i className="vp-tag vp-tag--phone">Телефон</i>}
                  {d.formats.includes("long") && <i className="vp-tag vp-tag--long">Полный приём</i>}
                  <i className="vp-tag">
                    {d.cases.length} {plural(d.cases.length, "кейс", "кейса", "кейсов")}
                  </i>
                </span>
              </button>
            ))}
          </div>

          {domain && (
            <div className="vp-categories vp-in" key={domain.key}>
              <p className="vp-cat-label">
                {domain.key === "call-center"
                  ? "Что за звонок:"
                  : domain.key === "reception"
                    ? "С чем пришёл пациент:"
                    : "Что случилось у пациента:"}
              </p>
              <div className="vp-cat-grid" role="radiogroup" aria-label="Кейсы раздела">
                {cases.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={selectedCase?.id === c.id}
                    className={`vp-cat${selectedCase?.id === c.id ? " is-active" : ""}`}
                    onClick={() => setSelectedCase(c)}
                  >
                    <span className="vp-cat-name">{c.title}</span>
                    <span className="vp-cat-brief">{c.brief}</span>
                    {c.factCount !== null && (
                      <span className="vp-cat-card">
                        скрытая карточка: {c.factCount}{" "}
                        {plural(c.factCount, "факт", "факта", "фактов")}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {domain && (
            <p className="vp-domain-note">
              Стандарт оценки: <b>{domain.framework}</b>.{" "}
              {format === "long"
                ? `Полная консультация: ${domain.stages.join(" → ")}.`
                : `Сцена идёт коротким диалогом: ${domain.stages.length} ${plural(domain.stages.length, "этап", "этапа", "этапов")} внутри разговора.`}
            </p>
          )}

          {error && (
            <p className="vp-error" role="alert">
              {error}
            </p>
          )}

          <div className="vp-start-row">
            <div className="vp-mode-pick">
              <label>
                Режим
                <select value={mode} onChange={(e) => setMode(e.target.value as "practice" | "exam")}>
                  <option value="practice">Практика — можно пересдавать</option>
                  <option value="exam" disabled={!matchingAssignments.length}>
                    Экзамен{!matchingAssignments.length ? " (кейс не назначен)" : " — один заход"}
                  </option>
                </select>
              </label>
            </div>
            <button
              type="button"
              className="vp-btn vp-btn--lg"
              disabled={busy || !domain || !selectedCase}
              onClick={() => void start({})}
            >
              {busy
                ? "Готовим сцену…"
                : format === "long"
                  ? "Начать приём"
                  : domain?.channel === "voice-only"
                    ? "Принять звонок"
                    : "Начать разговор"}
            </button>
            <p className="vp-hint">
              Система помнит пройденные сочетания «кейс × эмоция × персонаж» и подбирает новые,
              чтобы сцены не повторялись.
              {quota ? ` Осталось запросов: ${quota.remaining} из ${quota.limit}.` : ""}
            </p>
          </div>
        </section>
      </main>

      <footer className="vp-footer">
        Vera Practice · голос и разбор обрабатываются на сервере вуза: ключ провайдера не попадает
        в браузер, а записи не уходят третьим лицам
      </footer>
    </div>
  );
}
