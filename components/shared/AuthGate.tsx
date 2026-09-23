'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api } from './utils';
import LoginScreen from '@/components/login/LoginScreen';

/** Пользователь в том виде, в каком его отдаёт GET /api/auth/me. */
export interface AuthUser {
  id: string;
  role: 'supervisor' | 'trainee';
  displayName: string | null;
  username: string;
  disabled: number;
  requestQuota: number;
}

const AuthContext = createContext<AuthUser | null>(null);

/** Текущий пользователь внутри AuthGate (null — только до входа). */
export function useAuthUser(): AuthUser | null {
  return useContext(AuthContext);
}

/**
 * Гейт входа для всего приложения: проверяет сессию на каждой смене
 * страницы, показывает экран входа и раздаёт пользователя через контекст,
 * чтобы экраны не запрашивали /api/auth/me каждый сам.
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'login'>('loading');

  useEffect(() => {
    let live = true;
    api<{ user: AuthUser }>('/api/auth/me')
      .then((r) => {
        if (!live) return;
        setUser(r.user);
        setState('ready');
      })
      .catch(() => {
        if (live) setState('login');
      });
    return () => {
      live = false;
    };
  }, [path]);

  const homeFor = useCallback((next: AuthUser) => (next.role === 'supervisor' ? '/teacher' : '/'), []);

  // Уже вошли, а открыта страница входа — уводим на главную роли, а не показываем пустоту.
  useEffect(() => {
    if (state === 'ready' && user && path === '/login') router.replace(homeFor(user));
  }, [state, user, path, router, homeFor]);

  if (state === 'loading') {
    return (
      <div className="vp-auth-loading">
        <div className="vp-loader" aria-label="Проверяем вход" />
      </div>
    );
  }
  if (state === 'login') {
    return (
      <LoginScreen
        onLogin={(next) => {
          setUser(next);
          setState('ready');
          if (path === '/login') router.push(homeFor(next));
        }}
      />
    );
  }
  return <AuthContext.Provider value={user}>{children}</AuthContext.Provider>;
}
