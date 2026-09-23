'use client';

/* ============================================================
   Полноэкранный режим — «приложение, а не вкладка».

   Учебные компьютеры на кафедре: установка PWA там не всегда уместна,
   поэтому надёжный дефолт — обычный Fullscreen API внутри браузера.
   Выбор запоминается в localStorage и восстанавливается при первом
   же жесте пользователя: запрос полного экрана без жеста браузеры
   отклоняют, поэтому мы не пытаемся вызвать его на загрузке страницы.
   ============================================================ */

import { useCallback, useEffect, useState } from 'react';

const PREF_KEY = 'vera-fullscreen';

function fullscreenSupported(): boolean {
  return typeof document !== 'undefined' && Boolean(document.documentElement.requestFullscreen);
}

/** Установлено как PWA — тогда рамок браузера нет и кнопка не нужна. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

export function useFullscreen() {
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(fullscreenSupported() && !isStandalone());
    const sync = () => setActive(Boolean(document.fullscreenElement));
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const enter = useCallback(async () => {
    if (!fullscreenSupported() || document.fullscreenElement) return;
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      window.localStorage.setItem(PREF_KEY, '1');
    } catch {
      /* браузер отказал (нет жеста или политика) — остаёмся в обычном виде */
    }
  }, []);

  const exit = useCallback(async () => {
    window.localStorage.setItem(PREF_KEY, '0');
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        /* уже вышли */
      }
    }
  }, []);

  const toggle = useCallback(async () => {
    if (document.fullscreenElement) await exit();
    else await enter();
  }, [enter, exit]);

  /* Восстановление выбора: ждём первый клик или нажатие клавиши. */
  useEffect(() => {
    if (!fullscreenSupported() || isStandalone()) return;
    if (window.localStorage.getItem(PREF_KEY) !== '1') return;
    const restore = () => {
      void enter();
      window.removeEventListener('pointerdown', restore);
      window.removeEventListener('keydown', restore);
    };
    window.addEventListener('pointerdown', restore, { once: true });
    window.addEventListener('keydown', restore, { once: true });
    return () => {
      window.removeEventListener('pointerdown', restore);
      window.removeEventListener('keydown', restore);
    };
  }, [enter]);

  return { active, supported, enter, exit, toggle };
}
