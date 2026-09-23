import type { MetadataRoute } from 'next';

/* Standalone-режим для варианта «добавить на главный экран». Основной способ
   получить вид приложения на общих компьютерах кафедры — полноэкранный режим
   внутри браузера (см. useFullscreen); установка PWA остаётся опцией. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Vera Practice — тренажёр клинической коммуникации',
    short_name: 'Vera Practice',
    description:
      'Голосовой тренажёр клинической коммуникации: приём, колл-центр и полная консультация с разбором по признанным стандартам.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#f6f2ea',
    theme_color: '#f6f2ea',
    lang: 'ru',
    dir: 'ltr',
    categories: ['education', 'medical'],
    icons: [
      { src: '/icon.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
