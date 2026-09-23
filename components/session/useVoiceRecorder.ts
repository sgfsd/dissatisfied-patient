'use client';
/* Запись голоса врача с микрофона + уровень громкости для индикатора. */

import { useCallback, useEffect, useRef, useState } from 'react';

export type RecorderState = 'idle' | 'recording' | 'unsupported' | 'denied';

/** Потолок записи по умолчанию; сервер присылает свой в session.recordMaxSeconds. */
export const DEFAULT_RECORD_MAX_SECONDS = 45;

interface RecorderOptions {
  /** Через сколько секунд запись останавливается сама. */
  maxSeconds?: number;
  /**
   * Запись остановилась по лимиту времени. Сюда приходит готовая запись —
   * раньше она терялась: хук останавливал рекордер, а blob никто не забирал.
   */
  onAutoStop?: (blob: Blob | null) => void;
}

interface RecorderApi {
  state: RecorderState;
  level: number;    // 0..1 — текущая громкость (для анимации)
  seconds: number;  // длительность текущей записи
  maxSeconds: number;
  error: string | null;
  /** Начать запись. Возвращает true, если запись реально пошла. */
  start: () => Promise<boolean>;
  /** Остановить и вернуть blob (webm/opus или mp4) или null, если записи не было. */
  stop: () => Promise<Blob | null>;
  cancel: () => void;
}

export function isRecordingSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(navigator.mediaDevices?.getUserMedia) && typeof window.MediaRecorder !== 'undefined';
}

/**
 * Почему голос недоступен — чтобы кнопка не была молча серой. Самый частый
 * случай на кафедре: сайт открыт по http://<ip-сервера>, а браузер даёт
 * микрофон только по HTTPS или на localhost.
 */
export function recordingBlockedReason(): string | null {
  if (typeof window === 'undefined' || isRecordingSupported()) return null;
  if (window.isSecureContext === false)
    return 'Голосовой ответ доступен только по HTTPS или на самом компьютере-сервере. Пока отвечайте текстом.';
  return 'Этот браузер не умеет записывать голос — отвечайте текстом.';
}

export function useVoiceRecorder(options: RecorderOptions = {}): RecorderApi {
  const maxSeconds = options.maxSeconds ?? DEFAULT_RECORD_MAX_SECONDS;
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
  const startingRef = useRef(false);
  const onAutoStopRef = useRef(options.onAutoStop);
  onAutoStopRef.current = options.onAutoStop;

  const cleanupTimer = useCallback(() => {
    if (meterTimer.current) { clearInterval(meterTimer.current); meterTimer.current = null; }
  }, []);

  /** Отпустить микрофон и анализатор. Рекордер останавливается отдельно. */
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

  const stop = useCallback(async (): Promise<Blob | null> => {
    const rec = recRef.current;
    recRef.current = null;
    cleanupTimer();
    if (!rec || rec.state === 'inactive') { teardown(); setState('idle'); return null; }
    /* Сначала останавливаем рекордер и ждём последний кусок данных, потом
       отпускаем микрофон: обратный порядок может оборвать хвост записи. */
    const blob = await new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' }));
      try { rec.stop(); } catch { resolve(new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })); }
    });
    teardown();
    setState('idle');
    chunksRef.current = [];
    return blob.size > 0 ? blob : null;
  }, [cleanupTimer, teardown]);

  const start = useCallback(async (): Promise<boolean> => {
    setError(null);
    if (!isRecordingSupported()) { setState('unsupported'); setError('Запись голоса недоступна в этом браузере — напишите ответ текстом.'); return false; }
    if (recRef.current) return true;
    // Двойной клик по микрофону не должен открыть второй поток, пока первый ещё запрашивается.
    if (startingRef.current) return false;
    startingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      streamRef.current = stream;

      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) =>
        window.MediaRecorder.isTypeSupported(m)
      );
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
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
      recRef.current = rec;

      startedAtRef.current = Date.now();
      const buf = new Uint8Array(512);
      meterTimer.current = setInterval(() => {
        const elapsed = (Date.now() - startedAtRef.current) / 1000;
        setSeconds(Math.min(maxSeconds, elapsed));
        const a = analyserRef.current;
        if (a) {
          a.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
          const rms = Math.sqrt(sum / buf.length);
          setLevel(Math.max(0, Math.min(1, Math.pow(rms, 0.7) * 2.4)));
        }
        if (elapsed >= maxSeconds) {
          void stop().then((blob) => onAutoStopRef.current?.(blob));
        }
      }, 120);

      setState('recording');
      return true;
    } catch {
      // Микрофон мог успеть открыться (упал уже конструктор MediaRecorder) — отпускаем.
      recRef.current = null;
      teardown();
      setState('denied');
      setError('Не удалось получить доступ к микрофону. Разрешите доступ или напишите ответ текстом.');
      return false;
    } finally {
      startingRef.current = false;
    }
  }, [maxSeconds, stop, teardown]);

  const cancel = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null;
      try { rec.stop(); } catch { /* noop */ }
    }
    chunksRef.current = [];
    teardown();
    setState('idle');
  }, [teardown]);

  // размонтирование — всё остановить
  useEffect(() => () => { cancel(); }, [cancel]);

  return { state, level, seconds, maxSeconds, error, start, stop, cancel };
}
