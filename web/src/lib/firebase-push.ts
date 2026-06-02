'use client';

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getMessaging, getToken, isSupported } from 'firebase/messaging';

// Public Firebase web config (client identifiers, safe to embed).
const firebaseConfig = {
  apiKey: 'AIzaSyCv6xt0rB7NHPsUBoXXs8Suaf8gjhQbdaI',
  authDomain: 'arkansaslocalfoodnetwork.firebaseapp.com',
  projectId: 'arkansaslocalfoodnetwork',
  storageBucket: 'arkansaslocalfoodnetwork.firebasestorage.app',
  messagingSenderId: '1009574720950',
  appId: '1:1009574720950:web:3f16ccd9ae650e48d53d17',
};

// Public Web Push (VAPID) key — safe to embed in the client. The matching private
// key stays in Firebase and is used by FCM server-side; it is NOT included here.
const VAPID_KEY =
  process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY ||
  'BNGb2Ivvg2rPs3jtP2tfdWydcEqbYEeQOKM-aixnU3qG1DSphD5CBJCeoqPGlVHjETW-flfRpLkC95q9CvSxEMc';

function getApp(): FirebaseApp {
  return getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
}

export function pushConfigured(): boolean {
  return !!VAPID_KEY;
}

export interface EnablePushResult {
  ok: boolean;
  reason?: string;
  token?: string;
}

/**
 * Request notification permission and obtain an FCM web-push token, bound to the
 * app's existing service worker. Returns the token to register with the backend.
 */
export async function enablePush(): Promise<EnablePushResult> {
  if (typeof window === 'undefined') return { ok: false, reason: 'Unavailable.' };
  if (!(await isSupported().catch(() => false))) {
    return { ok: false, reason: 'Notifications aren’t supported on this browser/device.' };
  }
  if (!VAPID_KEY) {
    return { ok: false, reason: 'Push notifications aren’t configured yet.' };
  }
  if (!('serviceWorker' in navigator)) {
    return { ok: false, reason: 'Service workers unavailable.' };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, reason: 'Notification permission was not granted.' };
  }

  try {
    const messaging = getMessaging(getApp());
    const swReg = await navigator.serviceWorker.ready;
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
    if (!token) return { ok: false, reason: 'Could not obtain a push token.' };
    return { ok: true, token };
  } catch (err: any) {
    return { ok: false, reason: err?.message || 'Failed to enable push.' };
  }
}
