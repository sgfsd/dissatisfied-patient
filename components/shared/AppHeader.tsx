'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import KeySetup from '@/components/settings/KeySetup';
import './appHeader.css';

export default function AppHeader() {
  const path = usePathname();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
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
            <Link className={`vp-nav-link${path === '/' ? ' is-active' : ''}`} href="/">Тренажёр</Link>
            <Link className={`vp-nav-link${path === '/history' ? ' is-active' : ''}`} href="/history">История</Link>
          </nav>

          <button
            type="button"
            className="vp-key-btn"
            onClick={() => setSettingsOpen(true)}
            title="Ключ и адрес AI-провайдера"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <circle cx="7.2" cy="7.2" r="3.7" />
              <path d="M9.9 9.9 16.4 16.4M13.4 13.4l1.9-1.9M15.6 15.6l1.7-1.7" />
            </svg>
            Подключение
          </button>
        </div>
      </header>

      {settingsOpen && <KeySetup mode="modal" onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
