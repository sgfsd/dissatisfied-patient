'use client';
/* Экран сцены: «живой» пациент на сцене, ответы голосом или текстом,
   тематизированные состояния ожидания, разбор супервизора в конце. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AvatarRig, type AvatarHandle } from '@/components/avatar/AvatarRig';
import { buildWordTimeline } from '@/components/avatar/visemes';
import { personaById } from '@/lib/personas';
import { PATIENT_EMOTION_LABELS, type EvaluationDTO, type MessageDTO, type SessionPublicDTO } from '@/lib/types';
import { api, friendlyError } from '@/components/shared/utils';
import { isRecordingSupported, useVoiceRecorder } from './useVoiceRecorder';
import ResultsScreen from '@/components/results/ResultsScreen';
import './session.css';

type ClientSession = Omit<SessionPublicDTO, 'status'> & { status: string };
interface ResumeData {
  session: ClientSession;
  messages: MessageDTO[];
  evaluation: EvaluationDTO | null;
}
interface TurnPayload { outcome: { kind: 'patient'; text: string; emotion: MessageDTO['emotion']; audioUrl: string; isFinalPatientLine: boolean } | { kind: 'eval_ready' } }

type Phase = 'loading' | 'error' | 'dialogue' | 'eval' | 'report';
type Sub = 'patient' | 'doctor' | 'busy' | 'rec' | 'stt';

const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(1, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function SessionScreen({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const avatarRef = useRef<AvatarHandle>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const [data, setData] = useState<ResumeData | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [sub, setSub] = useState<Sub>('doctor');
  const [error, setError] = useState<string | null>(null);

  // ввод врача
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'voice' | 'typed'>('voice');
  const draftRef = useRef('');
  const inputModeRef = useRef<'voice' | 'typed'>('voice');
  draftRef.current = draft;
  inputModeRef.current = mode;

  // живая реплика пациента (субтитры-«караоке»)
  const [speech, setSpeech] = useState<{ text: string; active: boolean } | null>(null);
  const [wordIdx, setWordIdx] = useState(-1);
  const wordIdxRef = useRef(-1);

  const [avatarEmotion, setAvatarEmotion] = useState<NonNullable<MessageDTO['emotion']>>('neutral');
  const playingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const rec = useVoiceRecorder();

  const doctorCount = useMemo(() => data?.messages.filter((m) => m.speaker === 'doctor').length ?? 0, [data]);
  const limit = data?.session.exchangesLimit ?? 0;
  const canAnswer = doctorCount < limit;

  const lastPatientMsg = useMemo(
    () => (data ? [...data.messages].reverse().find((m) => m.speaker === 'patient') : null),
    [data]
  );

  /* ---------- загрузка / продолжение сессии ---------- */
  const load = useCallback(async () => {
    try {
      const r = await api<ResumeData>(`/api/sessions/${sessionId}`);
      if (!mountedRef.current) return;
      setData(r);
      const s = r.session.status;
      if (s === 'done' && r.evaluation) { setPhase('report'); return; }
      if (s === 'evaluating') { setPhase('eval'); void runEvaluation(); return; }
      setPhase('dialogue');
      const last = r.messages[r.messages.length - 1];
      if (last && last.speaker === 'patient' && last.emotion) setAvatarEmotion(last.emotion);
      // свежая сцена — открывающая реплика звучит сразу
      const dc = r.messages.filter((m) => m.speaker === 'doctor').length;
      if (dc === 0 && last && last.speaker === 'patient' && last.audioUrl) {
        window.setTimeout(() => { void playMessage(last); }, 350);
      } else {
        setSub('doctor');
      }
    } catch (e) {
      if (mountedRef.current) { setError(friendlyError(e)); setPhase('error'); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  const runEvaluation = useCallback(async () => {
    try {
      const ev = await api<EvaluationDTO>(`/api/sessions/${sessionId}/evaluate`, { method: 'POST' });
      if (!mountedRef.current) return;
      setData((d) => (d ? { ...d, session: { ...d.session, status: 'done' }, evaluation: ev } : d));
      setPhase('report');
    } catch (e) {
      if (mountedRef.current) { setError(friendlyError(e)); setPhase('error'); }
    }
  }, [sessionId]);

  /* ---------- воспроизведение реплики пациента ---------- */
  const playMessage = useCallback(async (m: MessageDTO) => {
    if (!m.audioUrl || playingRef.current) return;
    playingRef.current = true;
    if (m.emotion) setAvatarEmotion(m.emotion);
    setSub('patient');
    wordIdxRef.current = -1;
    setWordIdx(-1);
    setSpeech({ text: m.text, active: true });
    try {
      await avatarRef.current?.speak(m.audioUrl, m.text);
    } catch {
      // файл озвучки мог исчезнуть между загрузкой сцены и кликом —
      // тихо выходим, состояние сбрасывает finally ниже
    } finally {
      if (mountedRef.current) {
        setSpeech(null);
        setWordIdx(-1);
        wordIdxRef.current = -1;
        playingRef.current = false;
        setSub('doctor');
        scrollFeed();
      }
    }
  }, []);

  const scrollFeed = () => {
    requestAnimationFrame(() => {
      const el = feedRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  useEffect(scrollFeed, [data, speech]);

  const onSpeechProgress = useCallback((t01: number) => {
    const s = speechRefText.current;
    if (!s) return;
    const words = wordTimelineRef.current;
    if (!words.length) return;
    let i = 0;
    while (i < words.length - 1 && words[i + 1].start <= t01) i++;
    if (i !== wordIdxRef.current) { wordIdxRef.current = i; setWordIdx(i); }
  }, []);

  const speechRefText = useRef<string | null>(null);
  const wordTimelineRef = useRef<ReturnType<typeof buildWordTimeline>>([]);
  if (speech) {
    if (speechRefText.current !== speech.text) {
      speechRefText.current = speech.text;
      wordTimelineRef.current = buildWordTimeline(speech.text);
    }
  } else {
    speechRefText.current = null;
    wordTimelineRef.current = [];
  }

  /* ---------- отправка ответа врача ---------- */
  const sendTurn = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean || sub !== 'doctor') return;
    setError(null);
    setSub('busy');
    try {
      const source = inputModeRef.current === 'voice' && text === recognizedRef.current ? 'stt' : 'typed';
      const { outcome } = await api<TurnPayload>(`/api/sessions/${sessionId}/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doctorText: clean, source }),
      });
      if (!mountedRef.current) return;

      // локально добавляем реплику врача
      const now = Date.now();
      const doctorMsg: MessageDTO = {
        id: `d-${now}`, speaker: 'doctor', text: clean, emotion: null,
        source, audioUrl: null, idx: 9000 + doctorCount, createdAt: now,
      };
      setData((d) => d ? { ...d, messages: [...d.messages, doctorMsg] } : d);
      setDraft('');
      setMode('voice');
      recognizedRef.current = null;

      if (outcome.kind === 'eval_ready') {
        setPhase('eval');
        void runEvaluation();
        return;
      }
      const patientMsg: MessageDTO = {
        id: `p-${now + 1}`, speaker: 'patient', text: outcome.text,
        emotion: outcome.emotion, source: 'actor', audioUrl: outcome.audioUrl,
        idx: 9001 + doctorCount, createdAt: now + 1,
      };
      setData((d) => (d ? { ...d, messages: [...d.messages, patientMsg] } : d));
      await playMessage(patientMsg);
    } catch (e) {
      if (mountedRef.current) {
        setSub('doctor');
        setError(friendlyError(e));
      }
    }
  }, [sessionId, sub, doctorCount, playMessage, runEvaluation]);

  const recognizedRef = useRef<string | null>(null);

  const sendDraft = () => { void sendTurn(draft); };

  /* ---------- голос: запись → распознавание ---------- */
  async function onRecordStart() {
    setError(null);
    const ok = await rec.start();
    if (!mountedRef.current) return;
    // окно записи показываем, только если микрофон реально открылся
    setSub(ok ? 'rec' : 'doctor');
  }
  async function onRecordStop() {
    const blob = await rec.stop();
    if (!blob) { setSub('doctor'); return; }
    setSub('stt');
    try {
      const { text } = await api<{ text: string }>('/api/stt', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      if (!mountedRef.current) return;
      const t = (text || '').trim();
      if (!t) { setError('Речь не распознана — повторите запись или напишите ответ текстом.'); setSub('doctor'); return; }
      recognizedRef.current = t;
      setDraft(t);
      setMode('voice');
      setSub('doctor');
      requestAnimationFrame(() => textAreaRef.current?.focus());
    } catch (e) {
      if (mountedRef.current) { setError(friendlyError(e)); setSub('doctor'); }
    }
  }
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (sub === 'doctor') {
      // авто-стоп записи по таймауту (защита в хуке)
      if (rec.state === 'recording' && rec.seconds >= 44) void onRecordStop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.seconds, rec.state, sub]);

  const segments = useMemo(() => {
    if (!speech) return null;
    let n = -1;
    return speech.text.split(/(\s+)/).map((w) => {
      if (!w.trim()) return { t: w, wi: -1 };
      n += 1;
      return { t: w, wi: n };
    });
  }, [speech]);

  // авто-высота поля ввода
  useEffect(() => {
    const el = textAreaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(180, el.scrollHeight)}px`;
    }
  }, [draft, sub]);

  const persona = data ? personaById(data.session.personaKey) : null;

  if (phase === 'loading') {
    return <div className="vp-scene-loading"><div className="vp-loader" aria-label="Загружаем сцену" /></div>;
  }
  if (phase === 'error') {
    return (
      <div className="vp-scene-error vp-in">
        <p className="eyebrow">Ошибка</p>
        <h1>Сцена не открылась</h1>
        <p>{error ?? 'Что-то пошло не так.'}</p>
        <div className="vp-scene-error-actions">
          <button type="button" className="vp-btn vp-btn--dark" onClick={() => { setError(null); setPhase('loading'); void load(); }}>Повторить</button>
          <Link className="vp-btn vp-btn--ghost" href="/">В приёмную</Link>
        </div>
      </div>
    );
  }

  if (phase === 'report' && data?.evaluation) {
    return <ResultsScreen session={data.session} messages={data.messages} evaluation={data.evaluation} />;
  }

  if (!data || !persona) return null;

  const emotionLabel = PATIENT_EMOTION_LABELS[avatarEmotion] ?? 'спокойствие';
  const finalTurn = doctorCount >= limit - 1;

  return (
    <div className="vp-scene">
      {/* верхняя панель */}
      <div className="vp-scene-top">
        <Link className="vp-scene-back" href="/" aria-label="В приёмную">
          ← <span>В приёмную</span>
        </Link>
        <div className="vp-scene-title">
          <span className="vp-scene-cat">{data.session.domain} · {data.session.category}</span>
          <span className="vp-scene-persona">
            {data.session.patientFirst}, {data.session.patientAge} · эмоция «{emotionLabel}»
          </span>
        </div>
        <div className="vp-scene-turns" aria-label="Прогресс диалога">
          {Array.from({ length: limit }, (_, i) => (
            <i key={i} className={`vp-dot${i < doctorCount ? ' is-done' : ''}`} />
          ))}
          <span>{doctorCount}/{limit} {doctorCount === 1 ? 'ответ' : 'ответов'}</span>
        </div>
      </div>

      <div className="vp-scene-main">
        {/* ——— сцена с пациентом ——— */}
        <div className="vp-stage-col">
          <div className="vp-stage">
            <div className="vp-avatar-wrap vp-avatar-wrap--scene">
              <AvatarRig
                ref={avatarRef}
                persona={persona}
                emotion={avatarEmotion}
                attentive
                listening={sub === 'doctor'}
                thinking={sub === 'busy'}
                className="vp-avatar"
                onSpeechProgress={onSpeechProgress}
              />
            </div>

            {/* субтитры текущей реплики (подсветка слова — «караоке») */}
            {speech && segments && (
              <div className="vp-subtitle vp-in" aria-live="polite">
                <p>
                  {segments.map((s, i) => (
                    <span key={i} className={s.wi >= 0 && s.wi <= wordIdx ? 'is-on' : undefined}>{s.t}</span>
                  ))}
                </p>
              </div>
            )}

            {/* статус-строка на сцене */}
            <div className="vp-stage-status">
              {sub === 'patient' && <span className="vp-typing"><i /><i /><i /> пациент говорит</span>}
              {sub === 'busy' && <span className="vp-typing"><i /><i /><i /> пациент обдумывает ответ</span>}
              {sub === 'doctor' && !speech && (
                <span className="vp-status-soft">слушает вас…</span>
              )}
              {sub === 'stt' && <span className="vp-typing"><i /><i /><i /> распознаём вашу речь</span>}
            </div>

            {/* повтор последней реплики — чип в углу сцены, чтобы сцена не меняла высоту */}
            {sub === 'doctor' && lastPatientMsg && lastPatientMsg.audioUrl && (
              <button type="button" className="vp-replay vp-replay--chip" onClick={() => void playMessage(lastPatientMsg)}>
                <PlayIcon /> Повторить реплику пациента
              </button>
            )}
            {finalTurn && sub === 'doctor' && (
              <p className="vp-final-hint vp-final-hint--stage">Это последний ответ — дальше супервизор разберёт весь диалог.</p>
            )}
          </div>
        </div>

        {/* ——— правая колонка: диалог и ввод ——— */}
        <aside className="vp-panel">
          <div className="vp-feed" ref={feedRef}>
            {data.messages.map((m, i) => {
              const isDoctor = m.speaker === 'doctor';
              return (
                <div key={`${m.id}-${i}`} className={`vp-msg ${isDoctor ? 'is-doctor' : 'is-patient'} vp-in`}>
                  {!isDoctor && <span className="vp-msg-who">{data.session.patientFirst}</span>}
                  <p className="vp-msg-text">{m.text}</p>
                  {!isDoctor && m.audioUrl && (
                    <button type="button" className="vp-msg-play" aria-label="Повторить" onClick={() => void playMessage(m)}>
                      <PlayIcon small />
                    </button>
                  )}
                </div>
              );
            })}
            {sub !== 'doctor' && sub !== 'rec' && (
              <div className="vp-feed-wait"><i /><i /><i /></div>
            )}
          </div>

          {/* панель ввода / записи / распознавания */}
          <div className="vp-composer">
            {sub === 'rec' && (
              <div className="vp-rec vp-in">
                <div className="vp-rec-bar">
                  <span className="vp-rec-dot" />
                  <span className="vp-rec-timer">{fmtTime(rec.seconds)}</span>
                  <div className="vp-meter" aria-hidden>
                    {Array.from({ length: 24 }, (_, i) => (
                      <i key={i} style={{ height: `${Math.min(100, Math.max(6, rec.level * 100 * (0.5 + 0.5 * Math.sin(i * 1.7)) + rec.level * 60))}%` }} />
                    ))}
                  </div>
                  <button type="button" className="vp-rec-stop" onClick={() => void onRecordStop()} aria-label="Закончить запись">■</button>
                  <button type="button" className="vp-btn vp-btn--ghost vp-btn--xs" onClick={() => { rec.cancel(); setSub('doctor'); }}>Отмена</button>
                </div>
                <p className="vp-rec-caption">Говорите так, как ответили бы на приёме. Запись остановится сама через 45 секунд.</p>
              </div>
            )}

            {sub === 'stt' && (
              <div className="vp-stt vp-in">
                <div className="vp-stt-spinner" />
                <p>Распознаём речь…</p>
              </div>
            )}

            {sub === 'doctor' && (
              <div className="vp-input vp-in">
                <textarea
                  ref={textAreaRef}
                  className="vp-textarea"
                  rows={2}
                  placeholder="Напишите ответ врача — или нажмите «Голосом»"
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); setMode('typed'); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (draft.trim()) sendDraft(); }
                  }}
                  aria-label="Ответ врача"
                />
                {error && <p className="vp-error-inline" role="alert">{error}</p>}
                <div className="vp-input-row">
                  <button
                    type="button"
                    className="vp-mic"
                    onClick={onRecordStart}
                    disabled={!isRecordingSupported() || !canAnswer}
                    aria-label="Записать голосом"
                    title="Ответить голосом"
                  >
                    <MicIcon />
                    <span>Голосом</span>
                  </button>
                  <button
                    type="button"
                    className="vp-btn vp-btn--dark"
                    disabled={!draft.trim() || !canAnswer}
                    onClick={sendDraft}
                  >
                    Ответить
                  </button>
                </div>
                <p className="vp-keyhint">Enter — отправить · Shift+Enter — новая строка</p>
              </div>
            )}

            {sub === 'busy' && (
              <div className="vp-busy vp-in">
                <p>Отправляем ваш ответ…</p>
              </div>
            )}
            {sub === 'patient' && (
              <div className="vp-busy vp-in"><p>Пациент говорит — дождитесь конца реплики.</p></div>
            )}
          </div>
        </aside>
      </div>

      {/* ——— промежуточный экран супервизора ——— */}
      {phase === 'eval' && (
        <div className="vp-eval-overlay" role="status">
          <div className="vp-eval-card vp-in">
            <div className="vp-eval-orb"><i /><i /><i /></div>
            <p className="eyebrow">Завершение сцены</p>
            <h2>Супервизор разбирает консультацию</h2>
            <p className="vp-eval-sub">
              Сопоставляет ваши ответы с критериями NURSE, Calgary–Cambridge и принципами
              Beauchamp &amp; Childress. Обычно это занимает 15–40 секунд.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- мелкие иконки ---------- */
function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}
function PlayIcon({ small }: { small?: boolean }) {
  return (
    <svg width={small ? 12 : 14} height={small ? 12 : 14} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5.5v13l11-6.5-11-6.5z" />
    </svg>
  );
}
