'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { Header } from '@/components/header';
import { useRouter } from 'next/navigation';
import { enablePush, pushConfigured } from '@/lib/firebase-push';
import { RemindersCard } from '@/components/reminders-card';
import { SectionCard, Field, SaveBar } from '@/components/form';

export default function SettingsPage() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);

  // User fields
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');

  const loadProfile = useCallback(async () => {
    try {
      const data = await api.getProfile();
      if (data.user) {
        setUserName(data.user.name || '');
        setUserEmail(data.user.email || '');
      }
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login');
      return;
    }
    if (isAuthenticated) loadProfile();
  }, [isAuthenticated, isLoading, router, loadProfile]);

  const flash = (msg: string) => {
    setSaved(msg);
    setTimeout(() => setSaved(''), 2500);
  };

  const saveUser = async () => {
    setSaving(true);
    try {
      await api.updateUser({
        name: userName,
        email: userEmail || null,
      });
      flash('Profile saved!');
    } catch (e: any) {
      alert(e.message);
    }
    setSaving(false);
  };

  if (isLoading || loading) {
    return (
      <>
        <Header />
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-earth-400 text-lg">Loading...</div>
        </div>
      </>
    );
  }

  return (
    <>
      <Header />
      <div className="max-w-[800px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <h1 className="text-xl sm:text-2xl font-extrabold text-earth-900 mb-1">Settings</h1>
        <p className="text-sm text-earth-500 mb-6">Manage your account, notifications and reminders</p>

        {/* Saved flash */}
        {saved && (
          <div className="mb-4 px-4 py-2 bg-green-50 border border-green-200 text-green-700 rounded-xl text-sm font-semibold animate-pulse">
            {saved}
          </div>
        )}

        {/* ── Notifications ── */}
        <NotificationsCard />

        {/* ── Reminders ── */}
        <RemindersCard />

        {/* ── Account ── */}
        <div className="space-y-6">
          <SectionCard title="Account Details">
            <div className="space-y-3">
              <Field label="Name" value={userName} onChange={setUserName} />
              <Field label="Email" type="email" value={userEmail} onChange={setUserEmail} />
              <Field label="Phone" value={user?.phone || ''} disabled />
            </div>
          </SectionCard>
          <SaveBar saving={saving} onSave={saveUser} />
        </div>
      </div>
    </>
  );
}

// ── Subcomponents ──────────────────────────────────────────────
// The generic form kit (SectionCard, Field, SaveBar, …) now lives in
// components/form.tsx and is shared with the market/producer screens.

/* ─── Notifications (PWA push) ─── */
function NotificationsCard() {
  const [status, setStatus] = useState<'idle' | 'enabling' | 'enabled' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [envInfo, setEnvInfo] = useState({ ios: false, standalone: true, ready: false });
  const configured = pushConfigured();

  useEffect(() => {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    const ios = /iphone|ipad|ipod/i.test(ua);
    const standalone =
      (typeof window !== 'undefined' && (window.navigator as any).standalone === true) ||
      (typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches);
    setEnvInfo({ ios, standalone, ready: true });
  }, []);

  // iPhone web push only works inside the installed (Home Screen) app.
  const needsInstall = envInfo.ready && envInfo.ios && !envInfo.standalone;

  const enable = async () => {
    setStatus('enabling');
    setMsg('');
    const res = await enablePush();
    if (!res.ok || !res.token) {
      setStatus('error');
      setMsg(res.reason || 'Could not enable notifications.');
      return;
    }
    try {
      await api.registerPush(res.token);
      setStatus('enabled');
      setMsg('Push notifications are on for this device — reminders and alerts will arrive here as well as by text.');
    } catch (e: any) {
      setStatus('error');
      setMsg(e?.message || 'Could not save your device for notifications.');
    }
  };

  return (
    <div className="mb-6 bg-white border border-earth-100 rounded-2xl p-5">
      <h2 className="text-base font-bold text-earth-900 m-0">Push Notifications</h2>
      <p className="text-sm text-earth-500 mt-1">
        Get reminders and alerts as free push notifications on this device. Text messages stay on either way.
      </p>

      {!configured ? (
        <div className="mt-3 text-[13px] text-earth-500">Push isn’t fully set up yet — coming soon.</div>
      ) : needsInstall ? (
        <div className="mt-4 p-4 rounded-xl bg-farm-50 border border-farm-100">
          <div className="text-[14px] font-semibold text-farm-700 mb-2">📲 Install the app first</div>
          <p className="text-[13px] text-earth-600 m-0 mb-2">
            On iPhone, notifications only work from the installed app. It takes 10 seconds:
          </p>
          <ol className="text-[13px] text-earth-600 m-0 pl-5 leading-relaxed">
            <li>Tap the <strong>Share</strong> icon at the bottom of Safari (the box with an ↑ arrow)</li>
            <li>Scroll down and tap <strong>“Add to Home Screen”</strong></li>
            <li>Open <strong>SJCA Markets</strong> from your Home Screen</li>
            <li>Go to <strong>Settings → Push Notifications</strong> and tap <strong>Enable</strong></li>
          </ol>
          <p className="text-[12px] text-earth-400 m-0 mt-2">Requires iOS 16.4 or later.</p>
        </div>
      ) : (
        <button
          onClick={enable}
          disabled={status === 'enabling' || status === 'enabled'}
          className="mt-4 h-11 px-5 rounded-xl text-white border-none font-sans font-semibold text-[14px] cursor-pointer disabled:opacity-50"
          style={{ background: 'linear-gradient(135deg, #2A5E33 0%, #3D7A47 100%)' }}
        >
          {status === 'enabled' ? '✓ Notifications On' : status === 'enabling' ? 'Enabling…' : 'Enable Notifications'}
        </button>
      )}

      {msg && (
        <div className="mt-3 text-[13px] font-medium" style={{ color: status === 'error' ? '#BC4639' : '#2A5E33' }}>{msg}</div>
      )}
    </div>
  );
}
