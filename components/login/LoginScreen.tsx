'use client';
/* Экран входа и первого запуска преподавателя (создание самого первого аккаунта). */

import { FormEvent, useState } from 'react';
import { api, friendlyError } from '@/components/shared/utils';
import type { AuthUser } from '@/components/shared/AuthGate';

export default function LoginScreen({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bootstrap, setBootstrap] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ user: AuthUser }>(bootstrap ? '/api/auth/bootstrap' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bootstrap ? { adminPassword, username, password, displayName } : { username, password }),
      });
      onLogin(r.user);
    } catch (x) {
      setError(friendlyError(x));
      setBusy(false);
    }
  }

  return (
    <main className="vp-login">
      <section className="vp-login-card vp-in">
        <div className="vp-brand-mark">V</div>
        <p className="eyebrow">Vera Practice</p>
        <h1>{bootstrap ? 'Создать аккаунт преподавателя' : 'С возвращением'}</h1>
        <p className="vp-login-lead">Тренажёр клинической коммуникации для практики без лишнего напряжения.</p>
        <form onSubmit={submit}>
          <label>
            Логин
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </label>
          {bootstrap && (
            <label>
              Имя преподавателя
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </label>
          )}
          <label>
            Пароль
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={bootstrap ? 'new-password' : 'current-password'}
              minLength={12}
              required
            />
          </label>
          {bootstrap && (
            <label>
              Код запуска
              <input
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                autoComplete="off"
                required
              />
            </label>
          )}
          {error && (
            <p className="vp-error" role="alert">
              {error}
            </p>
          )}
          <button className="vp-btn vp-btn--lg" disabled={busy}>
            {busy ? 'Проверяем…' : bootstrap ? 'Создать и войти' : 'Войти'}
          </button>
        </form>
        <button
          type="button"
          className="vp-login-switch"
          onClick={() => {
            setBootstrap((v) => !v);
            setError('');
          }}
        >
          {bootstrap ? 'Уже есть аккаунт' : 'Первый запуск преподавателя'}
        </button>
      </section>
    </main>
  );
}
