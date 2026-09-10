'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api, friendlyError } from '@/components/shared/utils';
import './settings.css';

/* Экран настройки подключения к AI-провайдеру.
   Два режима: 'screen' — первый запуск, когда ключа ещё нет (занимает всю
   страницу), и 'modal' — сменить ключ позже, из шапки. Ключ уходит только
   на свой сервер и хранится там; обратно в браузер возвращается маска. */

const DEFAULT_BASE_URL = 'https://api.proxyapi.ru/openai/v1';

interface SettingsState {
  configured: boolean;
  keyHint: string | null;
  baseUrl: string;
  source: 'ui' | 'env' | 'none';
}

export default function KeySetup({ mode, onClose }: { mode: 'screen' | 'modal'; onClose?: () => void }) {
  const router = useRouter();
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [reveal, setReveal] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [current, setCurrent] = useState<SettingsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<SettingsState>('/api/settings')
      .then((s) => {
        if (!alive) return;
        setCurrent(s);
        if (s.baseUrl) setBaseUrl(s.baseUrl);
      })
      .catch(() => {
        /* предзаполнение не критично — форма работает и без него */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (mode !== 'modal') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      const res = await api<{ warning: string | null }>('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key, baseUrl }),
      });
      setKey('');
      router.refresh();
      if (res.warning) {
        setWarning(res.warning);
        setBusy(false);
      } else {
        onClose?.();
      }
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  }

  async function forget() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/settings', { method: 'DELETE' });
      setWarning('Ключ удалён. Если он был прописан в файле .env, приложение вернётся к нему.');
      router.refresh();
    } catch (err) {
      setError(friendlyError(err));
    }
    setBusy(false);
  }

  const configured = Boolean(current?.configured);

  const form = (
    <>
      <p className="eyebrow">Подключение</p>
      <h1 className="vp-key-title">{configured ? 'Ключ доступа' : 'Подключите AI-провайдера'}</h1>
      <p className="vp-key-lead">
        {configured ? (
          <>
            Сейчас используется ключ <code>{current?.keyHint}</code>
            {current?.source === 'env' ? ' из файла .env' : ''}. Ключ, введённый здесь, его переопределит.
          </>
        ) : (
          <>
            Сцена, озвучка пациента и разбор ответа работают через OpenAI-совместимый сервис.
            Вставьте ключ — он сохранится на этом компьютере и в браузер не попадёт.
          </>
        )}
      </p>

      <form className="vp-key-form" onSubmit={submit}>
        <label className="vp-key-field">
          <span className="vp-key-label">Ключ API</span>
          <span className="vp-key-box">
            <input
              type={reveal ? 'text' : 'password'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
              spellCheck={false}
              autoFocus={mode === 'screen'}
              disabled={busy}
            />
            <button
              type="button"
              className="vp-key-reveal"
              onClick={() => setReveal((v) => !v)}
              tabIndex={-1}
              aria-label={reveal ? 'Скрыть ключ' : 'Показать ключ'}
            >
              {reveal ? 'скрыть' : 'показать'}
            </button>
          </span>
        </label>

        <button type="button" className="vp-key-adv" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
          {advanced ? 'Свернуть адрес' : 'Другой провайдер'}
        </button>

        {advanced && (
          <label className="vp-key-field">
            <span className="vp-key-label">Базовый адрес (OpenAI-совместимый, без хвостового слэша)</span>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={DEFAULT_BASE_URL}
              spellCheck={false}
              disabled={busy}
            />
          </label>
        )}

        {error && <p className="vp-key-error" role="alert">{error}</p>}
        {warning && <p className="vp-key-warning" role="status">{warning}</p>}

        <div className="vp-key-actions">
          <button type="submit" className="vp-btn vp-key-submit" disabled={busy || !key.trim()}>
            {busy ? 'Проверяю ключ…' : configured ? 'Сохранить' : 'Сохранить и начать'}
          </button>
          {mode === 'modal' && (
            <button type="button" className="vp-btn vp-btn--ghost" onClick={onClose} disabled={busy}>
              Закрыть
            </button>
          )}
        </div>
      </form>

      <p className="vp-key-foot">
        Ключ лежит на сервере в файле <code>data/settings.json</code> — эта папка не попадает в git.
        {current?.source === 'ui' && (
          <>
            {' '}
            <button type="button" className="vp-key-forget" onClick={forget} disabled={busy}>
              Забыть ключ
            </button>
          </>
        )}
      </p>
    </>
  );

  if (mode === 'screen') {
    return (
      <div className="vp-key vp-key--screen">
        <div className="vp-key-card">
          <div className="vp-key-brand">
            <span className="vp-key-mark">V</span>
            <span className="vp-key-brand-text">
              Vera&nbsp;Practice
              <small>тренажёр клинической коммуникации</small>
            </span>
          </div>
          {form}
        </div>
      </div>
    );
  }

  return (
    <div className="vp-key-overlay" role="dialog" aria-modal="true" aria-label="Подключение к AI-провайдеру" onClick={onClose}>
      <div className="vp-key-card vp-key-card--modal" onClick={(e) => e.stopPropagation()}>
        {form}
      </div>
    </div>
  );
}
