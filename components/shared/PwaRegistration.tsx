'use client';

import { useEffect } from 'react';

/**
 * Service worker — только в собранной версии. В `next dev` чанки меняются
 * под теми же адресами, и кэш SW отдавал бы старый код после каждой правки;
 * поэтому в разработке уже зарегистрированный SW, наоборот, снимается.
 */
export default function PwaRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') {
      void navigator.serviceWorker.getRegistrations().then((list) => list.forEach((r) => void r.unregister()));
      return;
    }
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);

  return null;
}
