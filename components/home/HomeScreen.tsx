'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import AppHeader from '@/components/shared/AppHeader';
import { AvatarRig } from '@/components/avatar/AvatarRig';
import { personaById } from '@/lib/personas';
import { COMPLAINT_CATEGORIES, DOMAINS, type ComplaintCategory, type DomainDef } from '@/lib/scenarios/axes';
import { api, friendlyError } from '@/components/shared/utils';
import type { SessionPublicDTO } from '@/lib/types';
import './home.css';

interface StartPayload { session: SessionPublicDTO & { personaVoice?: string } }

export default function HomeScreen() {
  const router = useRouter();
  const [domain, setDomain] = useState<DomainDef | null>(null);
  const [category, setCategory] = useState<ComplaintCategory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const categories = domain ? COMPLAINT_CATEGORIES[domain.slug] : [];

  async function start(skipSelection: boolean) {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = {};
      if (!skipSelection && domain) body.domain = domain.slug;
      if (!skipSelection && category) body.category = category.title;
      const { session } = await api<StartPayload>('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      router.push(`/s/${session.sessionId}`);
    } catch (e) {
      setError(friendlyError(e));
      setBusy(false);
    }
  }

  return (
    <div className="vp-home">
      <AppHeader />

      <main>
        <section className="vp-hero vp-shell">
          <div className="vp-hero-copy vp-in">
            <p className="eyebrow">Тренажёр для врачей и студентов-медиков</p>
            <h1 className="vp-hero-title">
              Разговор, который
              <br />
              <em className="display-serif">не идёт по сценарию</em>
            </h1>
            <p className="vp-hero-sub">
              Недовольный пациент не спрашивает, по какому алгоритму вы работаете.
              Здесь вы отвечаете живому собеседнику голосом — а после каждого прогона
              получаете разбор по критериям NURSE, Calgary–Cambridge и принципам Beauchamp&nbsp;Childress.
            </p>
            <ol className="vp-steps">
              <li><span>1</span>Выберите повод для приёма</li>
              <li><span>2</span>Выслушайте и ответьте голосом</li>
              <li><span>3</span>Получите разбор по стандартам</li>
            </ol>
          </div>

          <div className="vp-hero-visual vp-in">
            <div className="vp-hero-card">
              <div className="vp-hero-avatar">
                <AvatarRig persona={personaById('galina73')} emotion="neutral" className="vp-avatar" />
              </div>
              <p className="vp-hero-cap">
                Пациент реагирует на каждое ваше слово — мимикой, тоном и репликами.
              </p>
            </div>
          </div>
        </section>

        <section className="vp-pick vp-shell vp-in">
          <div className="vp-pick-head">
            <div>
              <p className="eyebrow">Шаг 1</p>
              <h2>Выберите повод для приёма</h2>
            </div>
            <button type="button" className="vp-btn vp-btn--ghost vp-btn--sm" disabled={busy} onClick={() => start(true)}>
              Случайная сцена
            </button>
          </div>

          <div className="vp-domains" role="listbox" aria-label="Разделы медицины">
            {DOMAINS.map((d) => (
              <button
                key={d.slug}
                type="button"
                role="option"
                aria-selected={domain?.slug === d.slug}
                className={`vp-domain dm-${d.accent}${domain?.slug === d.slug ? ' is-active' : ''}`}
                onClick={() => { setDomain((cur) => (cur?.slug === d.slug ? cur : d)); setCategory(null); }}
              >
                <span className="vp-domain-title">{d.title}</span>
                <span className="vp-domain-short">{d.short}</span>
              </button>
            ))}
          </div>

          {domain && (
            <div className="vp-categories vp-in" key={domain.slug}>
              <p className="vp-cat-label">Что случилось у пациента:</p>
              <div className="vp-cat-grid" role="radiogroup" aria-label="Категории жалоб">
                {categories.map((c) => (
                  <button
                    key={c.title}
                    type="button"
                    role="radio"
                    aria-checked={category?.title === c.title}
                    className={`vp-cat${category?.title === c.title ? ' is-active' : ''}`}
                    onClick={() => setCategory(c)}
                  >
                    <span className="vp-cat-name">{c.title}</span>
                    <span className="vp-cat-brief">{c.brief}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <p className="vp-error" role="alert">{error}</p>}

          <div className="vp-start-row">
            <button
              type="button"
              className="vp-btn vp-btn--lg"
              disabled={busy || !domain || !category}
              onClick={() => start(false)}
            >
              {busy ? 'Готовим сцену…' : 'Начать консультацию'}
            </button>
            <p className="vp-hint">
              Система запоминает пройденные сочетания «повод × эмоция × персонаж»
              и подбирает новые, чтобы не было повторов-штампов.
            </p>
          </div>
        </section>
      </main>

      <footer className="vp-footer">
        Vera Practice · локальный тренажёр · голос никуда не уходит: распознавание, озвучка и разбор выполняются на сервере проекта
      </footer>
    </div>
  );
}
