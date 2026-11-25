'use client';

import { useEffect } from 'react';

/** Registers the service worker so the app is installable and works offline.
 *  On first load, unregisters any stale SW and clears all caches to recover
 *  from bad cache states, then re-registers the fresh SW. */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    const run = async () => {
      try {
        // Nuke all existing service workers and caches first
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const reg of registrations) {
          await reg.unregister();
        }
        // Clear all caches
        const cacheNames = await caches.keys();
        for (const name of cacheNames) {
          await caches.delete(name);
        }
        // Re-register fresh
        await navigator.serviceWorker.register('/sw.js');
      } catch (err) {
        console.warn('Service worker setup failed:', err);
      }
    };

    if (document.readyState === 'complete') run();
    else window.addEventListener('load', run);
    return () => window.removeEventListener('load', run);
  }, []);

  return null;
}
