import type { Metadata, Viewport } from 'next';
import './globals.css';
import AuthGate from '@/components/shared/AuthGate';
import PwaRegistration from '@/components/shared/PwaRegistration';

/* Страницы рендерятся на каждый запрос, а не один раз при сборке: собранная
   версия на кафедре живёт долго, и так любые серверные данные страницы
   (каталог разделов и т. п.) всегда совпадают с кодом, который сейчас запущен. */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Vera Practice — тренажёр клинической коммуникации',
  description:
    'Голосовой тренажёр для врачей и студентов-медиков: приём, телефонная линия колл-центра и полная консультация от регистратуры до выписки с разбором по признанным стандартам.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Vera Practice',
  appleWebApp: { capable: true, title: 'Vera Practice', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#f6f2ea',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Fraunces:ital,opsz,wght@1,9..144,500;1,9..144,600;0,9..144,500&display=swap"
          rel="stylesheet"
        />
        <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%23cf6246'/%3E%3Ctext x='16' y='22' font-size='16' font-family='Georgia' font-style='italic' text-anchor='middle' fill='white'%3EV%3C/text%3E%3C/svg%3E" />
      </head>
      <body><PwaRegistration /><AuthGate>{children}</AuthGate></body>
    </html>
  );
}
