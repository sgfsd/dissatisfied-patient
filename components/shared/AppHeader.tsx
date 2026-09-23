'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from './utils';
import { useFullscreen } from './useFullscreen';
import { useAuthUser } from './AuthGate';
import './appHeader.css';

type Quota = { limit: number; used: number; remaining: number };

export default function AppHeader() {
  const path = usePathname();
  const user = useAuthUser();
  const [quota, setQuota] = useState<Quota | null>(null);
  const { active, supported, toggle } = useFullscreen();

  useEffect(() => {
    void api<Quota>('/api/auth/quota')
      .then(setQuota)
      .catch(() => undefined);
  }, []);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.href = '/login';
  }

  const low = quota ? quota.remaining <= Math.max(3, Math.round(quota.limit * 0.1)) : false;

  return (
    <header className="vp-app-header">
      <Link className="vp-brand" href="/" aria-label="Vera Practice — на главную">
        <span className="vp-brand-mark">V</span>
        <span className="vp-brand-text">
          Vera&nbsp;Practice
          <small>тренажёр клинической коммуникации</small>
        </span>
      </Link>

      <div className="vp-header-right">
        <nav className="vp-nav" aria-label="Разделы">
          <Link className={`vp-nav-link${path === '/' ? ' is-active' : ''}`} href="/">
            Тренажёр
          </Link>
          <Link className={`vp-nav-link${path === '/progress' ? ' is-active' : ''}`} href="/progress">
            Прогресс
          </Link>
          <Link className={`vp-nav-link${path === '/history' ? ' is-active' : ''}`} href="/history">
            История
          </Link>
          {user?.role === 'supervisor' && (
            <Link className={`vp-nav-link${path.startsWith('/teacher') ? ' is-active' : ''}`} href="/teacher">
              Преподаватель
            </Link>
          )}
        </nav>

        {quota && (
          <span className={`vp-quota${low ? ' is-low' : ''}`} title="Остаток обращений к AI на этом аккаунте">
            {quota.remaining}/{quota.limit}
          </span>
        )}

        {supported && (
          <button
            type="button"
            className="vp-header-icon"
            onClick={() => void toggle()}
            aria-label={active ? 'Выйти из полноэкранного режима' : 'Открыть на весь экран'}
            title={active ? 'Выйти из полноэкранного режима' : 'Открыть на весь экран'}
          >
            {active ? '⤡' : '⤢'}
          </button>
        )}

        {user && (
          <div className="vp-user">
            <span>{user.displayName ?? user.username}</span>
            <button type="button" onClick={() => void logout()}>
              Выйти
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
