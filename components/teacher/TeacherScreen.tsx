'use client';
/* Кабинет преподавателя: ростер, агрегаты по группе (где проседают),
   назначение экзаменов и транскрипт конкретной сессии конкретного студента. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import AppHeader from '@/components/shared/AppHeader';
import { api, formatDateTime, friendlyError, plural } from '@/components/shared/utils';
import type { EvaluationDTO, PublicDomain } from '@/lib/types';
import './teacher.css';

type Group = { id: string; name: string; createdAt: number };
type Student = {
  id: string;
  displayName: string | null;
  username: string;
  disabled: number;
  requestQuota: number;
};
type Assignment = {
  id: string;
  groupId: string;
  title: string;
  cases: Array<{ domainKey: string; caseId: string }>;
};
type CriterionStat = {
  name: string;
  framework: string;
  attempts: number;
  avgScore: number;
  maxScore: number;
  percent: number;
  zeroShare: number;
};
type StudentStat = {
  studentId: string;
  displayName: string | null;
  username: string | null;
  attempts: number;
  done: number;
  percent: number | null;
  safetyFlags: number;
  lastActivity: number | null;
  weakest: string | null;
  spent: number;
};
type SessionRow = {
  sessionId: string;
  studentId: string | null;
  student: string | null;
  domain: string;
  category: string;
  mode: string;
  format: string;
  status: string;
  createdAt: number;
  totalScore: number | null;
  maxScore: number | null;
  safetyFlag: string | null;
};
type Stats = {
  overview: {
    students: number;
    sessions: number;
    done: number;
    exams: number;
    longFormat: number;
    safetyFlags: number;
    avgPercent: number | null;
  };
  criteria: CriterionStat[];
  domains: Array<{ domain: string; attempts: number; percent: number | null }>;
  students: StudentStat[];
  sessions: SessionRow[];
};
type ProviderState = {
  configured: boolean;
  keyHint: string | null;
  baseUrl: string;
  source: 'saved' | 'env' | 'none';
  encrypted: boolean;
};
type Transcript = {
  session: {
    id: string;
    mode: string;
    format: string;
    status: string;
    createdAt: number;
    domain: string;
    category: string;
    patientFirst: string;
  };
  messages: Array<{ speaker: string; text: string; emotion: string | null; idx: number }>;
  evaluation: EvaluationDTO | null;
};

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Подпись сессии без итогового балла: ещё идёт, ждёт разбора или прервана. */
function statusLabel(status: string): string {
  if (status === 'active') return 'в работе';
  if (status === 'evaluating') return 'ждёт разбора';
  if (status === 'aborted') return 'прервана';
  return '—';
}

/** catalog — публичная проекция реестра (lib/domains/catalog.ts). */
export default function TeacherScreen({ catalog }: { catalog: PublicDomain[] }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState('');
  const [students, setStudents] = useState<Student[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [newGroup, setNewGroup] = useState('');
  const [student, setStudent] = useState({ displayName: '', username: '', password: '' });
  const [assignment, setAssignment] = useState({ title: '', cases: [] as string[] });

  const load = useCallback(async (id?: string) => {
    setError('');
    try {
      const [g, a] = await Promise.all([
        api<{ groups: Group[] }>('/api/teacher/groups'),
        api<{ assignments: Assignment[] }>('/api/teacher/assignments'),
      ]);
      setGroups(g.groups);
      setAssignments(a.assignments);
      const target = id || groupId || g.groups[0]?.id || '';
      setGroupId(target);
      if (!target) {
        setStudents([]);
        setStats(null);
        return;
      }
      const [s, st] = await Promise.all([
        api<{ students: Student[] }>(`/api/teacher/students?groupId=${target}`),
        api<Stats>(`/api/teacher/stats?groupId=${target}`),
      ]);
      setStudents(s.students);
      setStats(st);
    } catch (e) {
      setError(friendlyError(e));
    }
    // groupId сознательно не в зависимостях: он же и обновляется внутри
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** action может вернуть id группы, на которую переключиться после
      действия: иначе перезагрузка ушла бы со старым groupId из замыкания. */
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await action();
      setNotice(message);
      await load(typeof next === 'string' ? next : groupId);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  const groupAssignments = useMemo(
    () => assignments.filter((a) => a.groupId === groupId),
    [assignments, groupId],
  );
  const caseTitle = useCallback((domainKey: string, caseId: string) => {
    const domain = catalog.find((d) => d.key === domainKey);
    const item = domain?.cases.find((c) => c.id === caseId);
    return item ? `${domain!.title}: ${item.title}` : `${domainKey}/${caseId}`;
  }, [catalog]);

  return (
    <div className="vp-teacher">
      <AppHeader />
      <main className="vp-shell">
        <div className="vp-teacher-head">
          <div>
            <p className="eyebrow">Кабинет преподавателя</p>
            <h1>Группа и практика</h1>
          </div>
          <div className="vp-teacher-actions">
            <select
              value={groupId}
              onChange={(e) => void load(e.target.value)}
              aria-label="Группа"
              disabled={!groups.length}
            >
              {groups.length ? (
                groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))
              ) : (
                <option value="">Групп пока нет</option>
              )}
            </select>
            <input
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              placeholder="Новая группа"
              aria-label="Название новой группы"
            />
            <button
              className="vp-btn vp-btn--dark vp-btn--xs"
              disabled={busy || !newGroup.trim()}
              onClick={() =>
                void run(async () => {
                  const created = await api<{ group: Group }>('/api/teacher/groups', json({ name: newGroup }));
                  setNewGroup('');
                  return created.group.id;
                }, 'Группа создана')
              }
            >
              Создать
            </button>
            {groupId && (
              <>
                <a
                  className="vp-btn vp-btn--ghost vp-btn--xs"
                  href={`/api/teacher/export?groupId=${groupId}`}
                  download
                >
                  Выгрузить CSV
                </a>
                <button
                  className="vp-btn vp-btn--ghost vp-btn--xs"
                  disabled={busy}
                  onClick={() => {
                    const next = window.prompt(
                      'Новое название группы',
                      groups.find((g) => g.id === groupId)?.name ?? '',
                    );
                    if (next?.trim()) void run(() => api(`/api/teacher/groups/${groupId}`, json({ name: next }, 'PATCH')), 'Группа переименована');
                  }}
                >
                  Переименовать
                </button>
                <button
                  className="vp-btn vp-btn--ghost vp-btn--xs"
                  disabled={busy || students.length > 0}
                  title={students.length ? 'Удалить можно только пустую группу' : 'Удалить пустую группу'}
                  onClick={() => {
                    if (window.confirm('Удалить эту группу?'))
                      void run(async () => {
                        await api(`/api/teacher/groups/${groupId}`, { method: 'DELETE' });
                        // пустая строка: load() возьмёт первую оставшуюся группу
                        return '';
                      }, 'Группа удалена');
                  }}
                >
                  Удалить
                </button>
              </>
            )}
          </div>
        </div>

        {error && <p className="vp-error">{error}</p>}
        {notice && <p className="vp-notice">{notice}</p>}

        {stats && (
          <section className="vp-tiles vp-in">
            <Tile value={stats.overview.students} label="студентов в группе" />
            <Tile value={stats.overview.sessions} label="прогонов всего" />
            <Tile
              value={stats.overview.avgPercent === null ? '—' : `${stats.overview.avgPercent}%`}
              label="средний балл группы"
              tone={
                stats.overview.avgPercent === null
                  ? undefined
                  : stats.overview.avgPercent >= 70
                    ? 'ok'
                    : stats.overview.avgPercent >= 45
                      ? 'mid'
                      : 'low'
              }
            />
            <Tile value={stats.overview.exams} label="экзаменационных попыток" />
            <Tile value={stats.overview.longFormat} label="полных приёмов" />
            <Tile
              value={stats.overview.safetyFlags}
              label={plural(stats.overview.safetyFlags, 'флаг безопасности', 'флага безопасности', 'флагов безопасности')}
              tone={stats.overview.safetyFlags > 0 ? 'low' : 'ok'}
            />
          </section>
        )}

        <section className="vp-teacher-grid">
          {/* ——— Где проседает группа ——— */}
          <article className="vp-span-2">
            <p className="eyebrow">Агрегат по критериям</p>
            <h2>Где группа проседает чаще всего</h2>
            {stats?.criteria.length ? (
              <div className="vp-crit-stats">
                {stats.criteria.map((c) => (
                  <div className="vp-crit-stat" key={c.name}>
                    <div className="vp-crit-stat-head">
                      <span className="vp-crit-stat-name">{c.name}</span>
                      <span className="vp-crit-stat-num">
                        {c.avgScore} / {c.maxScore}
                      </span>
                    </div>
                    <span className="vp-crit-stat-bar">
                      <i
                        className={c.percent >= 70 ? 'is-ok' : c.percent >= 45 ? 'is-mid' : 'is-low'}
                        style={{ width: `${c.percent}%` }}
                      />
                    </span>
                    <span className="vp-crit-stat-meta">
                      {c.framework} · {c.attempts} {plural(c.attempts, 'оценка', 'оценки', 'оценок')} · ноль
                      баллов в {c.zeroShare}% случаев
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="vp-empty">Разборы появятся после первых завершённых сцен.</p>
            )}
            {stats?.domains.length ? (
              <div className="vp-domain-stats">
                {stats.domains.map((d) => (
                  <span key={d.domain} className="vp-domain-stat">
                    {d.domain}
                    <b>{d.percent === null ? '—' : `${d.percent}%`}</b>
                    <i>{d.attempts}</i>
                  </span>
                ))}
              </div>
            ) : null}
          </article>

          {/* ——— Ростер ——— */}
          <article>
            <p className="eyebrow">Ростер</p>
            <h2>
              Студенты <span>{students.length}</span>
            </h2>
            {students.length ? (
              students.map((s) => {
                const stat = stats?.students.find((row) => row.studentId === s.id);
                return (
                  <div className="vp-roster-row" key={s.id}>
                    <span className="vp-roster-main">
                      <b>{s.displayName ?? s.username}</b>
                      <small>
                        {s.username} · израсходовано {stat?.spent ?? 0} из {s.requestQuota}
                        {stat ? ` · ${stat.attempts} ${plural(stat.attempts, 'прогон', 'прогона', 'прогонов')}` : ''}
                        {stat?.percent !== null && stat?.percent !== undefined ? ` · ${stat.percent}%` : ''}
                        {stat?.safetyFlags ? ` · ⚑ ${stat.safetyFlags}` : ''}
                      </small>
                      {stat?.weakest && <small className="vp-roster-weak">слабее всего: {stat.weakest}</small>}
                      {stat?.lastActivity && (
                        <small className="vp-roster-weak">последний вход: {formatDateTime(stat.lastActivity)}</small>
                      )}
                    </span>
                    <span className="vp-roster-controls">
                      <input
                        type="number"
                        min={0}
                        defaultValue={s.requestQuota}
                        aria-label={`Лимит запросов для ${s.username}`}
                        onBlur={(e) => {
                          const next = Number(e.target.value);
                          if (!Number.isSafeInteger(next) || next < 0 || next === s.requestQuota) return;
                          void run(
                            () =>
                              api(`/api/teacher/students/${s.id}`, {
                                ...json({ requestQuota: next }),
                                method: 'PATCH',
                              }),
                            'Лимит обновлён',
                          );
                        }}
                      />
                      <button
                        className="vp-btn vp-btn--ghost vp-btn--xs"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => api(`/api/teacher/students/${s.id}`, json({ disabled: !s.disabled }, 'PATCH')),
                            s.disabled ? 'Доступ включён' : 'Доступ отключён',
                          )
                        }
                      >
                        {s.disabled ? 'Включить' : 'Отключить'}
                      </button>
                      <button
                        className="vp-btn vp-btn--ghost vp-btn--xs"
                        disabled={busy}
                        title="Обнулить израсходованный лимит"
                        onClick={() => {
                          if (window.confirm(`Обнулить израсходованный лимит для ${s.username}?`))
                            void run(
                              () => api(`/api/teacher/students/${s.id}`, json({ resetUsage: true }, 'PATCH')),
                              'Расход обнулён',
                            );
                        }}
                      >
                        Сбросить расход
                      </button>
                      <button
                        className="vp-btn vp-btn--ghost vp-btn--xs"
                        disabled={busy}
                        onClick={() => {
                          const next = window.prompt(`Новый пароль для ${s.username} (минимум 12 символов)`);
                          if (!next) return;
                          if (next.length < 12) {
                            setError('Пароль должен быть не короче 12 символов.');
                            return;
                          }
                          void run(
                            () => api(`/api/teacher/students/${s.id}`, json({ password: next }, 'PATCH')),
                            'Пароль изменён, старые входы сброшены',
                          );
                        }}
                      >
                        Пароль
                      </button>
                    </span>
                  </div>
                );
              })
            ) : (
              <p className="vp-empty">В этой группе пока нет студентов.</p>
            )}

            <div className="vp-teacher-form">
              <p className="vp-form-label">Добавить студента</p>
              <input
                value={student.displayName}
                onChange={(e) => setStudent({ ...student, displayName: e.target.value })}
                placeholder="Имя и фамилия"
                aria-label="Имя студента"
              />
              <input
                value={student.username}
                onChange={(e) => setStudent({ ...student, username: e.target.value })}
                placeholder="Логин (латиницей)"
                aria-label="Логин студента"
                autoComplete="off"
              />
              <input
                type="password"
                value={student.password}
                onChange={(e) => setStudent({ ...student, password: e.target.value })}
                placeholder="Пароль, минимум 12 символов"
                aria-label="Пароль студента"
                autoComplete="new-password"
              />
              <button
                className="vp-btn vp-btn--dark vp-btn--xs"
                disabled={
                  busy ||
                  !groupId ||
                  !student.displayName.trim() ||
                  !student.username.trim() ||
                  student.password.length < 12
                }
                onClick={() =>
                  void run(async () => {
                    await api('/api/teacher/students', json({ ...student, groupId }));
                    setStudent({ displayName: '', username: '', password: '' });
                  }, 'Студент добавлен')
                }
              >
                Создать аккаунт
              </button>
              <p className="vp-form-hint">
                Пароль выдайте студенту лично. Ключ AI-провайдера остаётся на этом компьютере:
                студенты ничего не вставляют и не платят.
              </p>
            </div>
          </article>

          {/* ——— Экзамены ——— */}
          <article>
            <p className="eyebrow">Каталог экзаменов</p>
            <h2>
              Задания <span>{groupAssignments.length}</span>
            </h2>
            {groupAssignments.length ? (
              groupAssignments.map((a) => (
                <div className="vp-session-row" key={a.id}>
                  <span className="vp-roster-main">
                    <b>{a.title}</b>
                    <small>{a.cases.map((c) => caseTitle(c.domainKey, c.caseId)).join(' · ')}</small>
                  </span>
                  <button
                    className="vp-btn vp-btn--ghost vp-btn--xs"
                    disabled={busy}
                    title="Удалить можно, пока никто не начал"
                    onClick={() => {
                      if (window.confirm(`Удалить задание «${a.title}»?`))
                        void run(
                          () => api(`/api/teacher/assignments/${a.id}`, { method: 'DELETE' }),
                          'Задание удалено',
                        );
                    }}
                  >
                    Удалить
                  </button>
                </div>
              ))
            ) : (
              <p className="vp-empty">Заданий пока нет.</p>
            )}

            <div className="vp-teacher-form">
              <p className="vp-form-label">Новое задание</p>
              <input
                value={assignment.title}
                onChange={(e) => setAssignment({ ...assignment, title: e.target.value })}
                placeholder="Название экзамена"
                aria-label="Название экзамена"
              />
              <select
                multiple
                size={8}
                value={assignment.cases}
                onChange={(e) =>
                  setAssignment({
                    ...assignment,
                    cases: Array.from(e.target.selectedOptions, (option) => option.value),
                  })
                }
                aria-label="Кейсы экзамена"
              >
                {catalog.map((domain) => (
                  <optgroup key={domain.key} label={domain.title}>
                    {domain.cases.map((item) => (
                      <option key={`${domain.key}:${item.id}`} value={`${domain.key}:${item.id}`}>
                        {item.title}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button
                className="vp-btn vp-btn--dark vp-btn--xs"
                disabled={busy || !groupId || !assignment.title.trim() || !assignment.cases.length}
                onClick={() =>
                  void run(async () => {
                    await api(
                      '/api/teacher/assignments',
                      json({
                        groupId,
                        title: assignment.title,
                        cases: assignment.cases.map((value) => {
                          const [domainKey, caseId] = value.split(':');
                          return { domainKey, caseId };
                        }),
                      }),
                    );
                    setAssignment({ title: '', cases: [] });
                  }, 'Задание назначено группе')
                }
              >
                Назначить группе
              </button>
              <p className="vp-form-hint">
                Экзамен — один заход на кейс, 30 минут, без права переиграть. Студент видит балл,
                развёрнутый разбор остаётся у вас.
              </p>
            </div>
          </article>

          {/* ——— Подключение AI ——— */}
          <ProviderCard />

          {/* ——— Сессии ——— */}
          <article className="vp-span-2">
            <p className="eyebrow">Журнал группы</p>
            <h2>Последние сессии</h2>
            {stats?.sessions.length ? (
              <div className="vp-session-table">
                {stats.sessions.map((s) => (
                  <button
                    type="button"
                    className="vp-session-line"
                    key={s.sessionId}
                    onClick={() =>
                      void api<Transcript>(`/api/teacher/transcripts/${s.sessionId}`)
                        .then(setTranscript)
                        .catch((e) => setError(friendlyError(e)))
                    }
                  >
                    <span className="vp-session-when">{formatDateTime(s.createdAt)}</span>
                    <span className="vp-session-who">{s.student ?? '—'}</span>
                    <span className="vp-session-what">
                      {s.domain} · {s.category}
                    </span>
                    <span className="vp-session-tags">
                      {s.mode === 'exam' && <i className="vp-tag vp-tag--exam">Экзамен</i>}
                      {s.format === 'long' && <i className="vp-tag vp-tag--long">Полный приём</i>}
                      {s.safetyFlag && <i className="vp-tag vp-tag--danger">Безопасность</i>}
                    </span>
                    <span className="vp-session-score">
                      {s.maxScore ? `${s.totalScore}/${s.maxScore}` : statusLabel(s.status)}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="vp-empty">Транскрипты появятся после первых занятий.</p>
            )}
          </article>
        </section>
      </main>

      {transcript && <TranscriptDialog data={transcript} onClose={() => setTranscript(null)} />}
    </div>
  );
}

/* Ключ провайдера один на весь сервис и живёт на сервере. Студенты его не
   видят и ничего не вставляют — менять может только преподаватель. */
function ProviderCard() {
  const [state, setState] = useState<ProviderState | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const reload = useCallback(() => {
    void api<ProviderState>('/api/settings')
      .then(setState)
      .catch((e) => setError(friendlyError(e)));
  }, []);
  useEffect(reload, [reload]);

  async function save() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await api<{ warning: string | null; verified: boolean }>('/api/settings', json({ apiKey }));
      setApiKey('');
      setMessage(res.warning ?? (res.verified ? 'Ключ проверен у провайдера и сохранён.' : 'Ключ сохранён.'));
      reload();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article>
      <p className="eyebrow">Подключение AI</p>
      <h2>Ключ провайдера</h2>
      {state ? (
        <p className="vp-provider-state">
          {state.configured ? (
            <>
              Подключено: <b>{state.keyHint}</b>
              <small>
                {state.baseUrl} ·{' '}
                {state.source === 'env'
                  ? 'из переменных окружения (режим разработки)'
                  : state.encrypted
                    ? 'хранится на этом компьютере в зашифрованном виде'
                    : 'хранится на этом компьютере'}
              </small>
            </>
          ) : (
            <>
              Ключ не задан — сцены запускаться не будут.
              <small>Вставьте ключ провайдера: он сохранится только на этом компьютере, зашифрованным.</small>
            </>
          )}
        </p>
      ) : (
        !error && <p className="vp-empty">Проверяем подключение…</p>
      )}

      <div className="vp-teacher-form">
        <p className="vp-form-label">Заменить ключ</p>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
          aria-label="Ключ AI-провайдера"
          autoComplete="off"
        />
        <button className="vp-btn vp-btn--dark vp-btn--xs" disabled={busy || apiKey.trim().length < 12} onClick={() => void save()}>
          {busy ? 'Проверяем…' : 'Сохранить'}
        </button>
        {error && <p className="vp-error">{error}</p>}
        {message && <p className="vp-notice">{message}</p>}
        <p className="vp-form-hint">
          Один ключ на весь вуз: расход виден по лимитам студентов, отключить одного можно не
          затрагивая остальных. Озвучка кэшируется на диске, поэтому повторные реплики бесплатны.
        </p>
      </div>
    </article>
  );
}

function Tile({ value, label, tone }: { value: number | string; label: string; tone?: 'ok' | 'mid' | 'low' }) {
  return (
    <div className={`vp-tile${tone ? ` is-${tone}` : ''}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function TranscriptDialog({ data, onClose }: { data: Transcript; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const total = data.evaluation?.totalScore ?? null;
  const max = data.evaluation?.maxScore ?? null;

  return (
    <div className="vp-modal" role="dialog" aria-modal="true" aria-label="Транскрипт сессии">
      <div className="vp-modal-card vp-in">
        <header>
          <div>
            <p className="eyebrow">Транскрипт</p>
            <h2>
              {data.session.domain} · {data.session.category}
            </h2>
            <p className="vp-modal-meta">
              {formatDateTime(data.session.createdAt)} · {data.session.mode === 'exam' ? 'экзамен' : 'практика'} ·{' '}
              {data.session.format === 'long' ? 'полный приём' : 'короткая сцена'}
              {total !== null && max ? ` · ${total}/${max}` : ''}
            </p>
          </div>
          <button type="button" className="vp-modal-close" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </header>

        {data.evaluation?.safetyFlag && (
          <p className="vp-alert vp-alert--danger">
            <b>Клиническая безопасность.</b> {data.evaluation.safetyFlag}
          </p>
        )}

        <div className="vp-modal-body">
          <div className="vp-modal-transcript">
            {data.messages.map((m) => (
              <p key={m.idx} className={m.speaker === 'doctor' ? 'is-doc' : 'is-pat'}>
                <b>{m.speaker === 'doctor' ? 'Студент' : data.session.patientFirst}:</b> {m.text}
              </p>
            ))}
          </div>
          {data.evaluation && (
            <div className="vp-modal-criteria">
              {data.evaluation.criteria.map((c) => (
                <div key={c.name} className="vp-modal-criterion">
                  <span>
                    <b>{c.name}</b>
                    <i>
                      {c.score}/{c.maxScore}
                    </i>
                  </span>
                  {c.evidenceQuote && <q>{c.evidenceQuote}</q>}
                  <small>{c.explanation}</small>
                </div>
              ))}
              <p className="vp-modal-summary">{data.evaluation.overallSummary}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
