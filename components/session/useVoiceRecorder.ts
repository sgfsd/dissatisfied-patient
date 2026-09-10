'use client';
/* Запись голоса врача с микрофона + уровень громкости для индикатора. */

import { useCallback, useEffect, useRef, useState } from 'react';

export type RecorderState = 'idle' | 'recording' | 'unsupported' | 'denied';

const MAX_SECONDS = 45;

interface RecorderApi {
  state: RecorderState;
  level: number;    // 0..1 — текущая громкость (для анимации)
  seconds: number;  // длительность текущей записи
  error: string | null;
  /** Начать запись. Возвращает true, если запись реально пошла. */
  start: () => Promise<boolean>;
  /** Остановить и вернуть blob (webm/opus) или null, если записи не было. */
  stop: () => Promise<Blob | null>;
  cancel: () => void;
}

export function isRecordingSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(navigator.mediaDevices?.getUserMedia) && typeof window.MediaRecorder !== 'undefined';
}

export function useVoiceRecorder(): RecorderApi {
  const [state, setState] = useState<RecorderState>('idle');
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const meterTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);

  const cleanupTimer = useCallback(() => {
    if (meterTimer.current) { clearInterval(meterTimer.current); meterTimer.current = null; }
  }, []);

  const teardown = useCallback(() => {
    cleanupTimer();
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    streamRef.current = null;
    const ctx = ctxRef.current;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
    ctxRef.current = null;
    analyserRef.current = null;
    setSeconds(0);
    setLevel(0);
  }, [cleanupTimer]);

  const start = useCallback(async (): Promise<boolean> => {
    setError(null);
    if (!isRecordingSupported()) { setState('unsupported'); setError('Запись голоса недоступна в этом браузере — напишите ответ текстом.'); return false; }
    if (state === 'recording') return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      streamRef.current = stream;

      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) =>
        window.MediaRecorder.isTypeSupported(m)
      );
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };

      // анализатор для индикатора громкости
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) {
        const ctx = new Ctor();
        ctxRef.current = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        const src = ctx.createMediaStreamSource(stream);
        src.connect(analyser); // не подключаем к динамикам — только измерение
        analyserRef.current = analyser;
      }

      await new Promise<void>((resolve) => {
        rec.onstart = () => resolve();
        rec.start(300);
      });

      startedAtRef.current = Date.now();
      const buf = new Uint8Array(512);
      meterTimer.current = setInterval(() => {
        setSeconds(Math.min(MAX_SECONDS, (Date.now() - startedAtRef.current) / 1000));
        const a = analyserRef.current;
        if (a) {
          a.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
          const rms = Math.sqrt(sum / buf.length);
          setLevel(Math.max(0, Math.min(1, Math.pow(rms, 0.7) * 2.4)));
        }
        if (Date.now() - startedAtRef.current >= MAX_SECONDS * 1000) { void stop(); }
      }, 120);

      setState('recording');
      return true;
    } catch (e) {
      setState('denied');
      setError('Не удалось получить доступ к микрофону. Разрешите доступ или напишите ответ текстом.');
      void e;
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const stop = useCallback(async () => {
    const rec = recRef.current;
    if (!rec || rec.state === 'inactive') return null;
    teardown();
    setState('idle');
    const blob = await new Promise<Blob>((resolve) => {
      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm';
        resolve(new Blob(chunksRef.current, { type }));
      };
      rec.stop();
    });
    recRef.current = null;
    return blob.size > 0 ? blob : null;
  }, [teardown]);

  const cancel = useCallback(() => {
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null;
      try { rec.stop(); } catch { /* noop */ }
    }
    recRef.current = null;
    chunksRef.current = [];
    teardown();
    setState('idle');
  }, [teardown]);

  // размонтирование — всё остановить
  useEffect(() => () => { cancel(); }, [cancel]);

  return { state, level, seconds, error, start, stop, cancel };
}
