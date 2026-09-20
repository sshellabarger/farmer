'use client';

import { useEffect } from 'react';

/** Registers the service worker so the app is installable, works offline and
 *  can receive web push. Cache invalidation is handled by the service worker
 *  itself (it purges caches with a different name on activate). */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    const run = async () => {
      try {
        await navigator.serviceWorker.register('/sw.js');
      } catch (err) {
        console.warn('Service worker registration failed:', err);
      }
    };

    if (document.readyState === 'complete') run();
    else window.addEventListener('load', run);
    return () => window.removeEventListener('load', run);
  }, []);

  return null;
}
