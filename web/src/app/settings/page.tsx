'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { Header } from '@/components/header';
import { useRouter } from 'next/navigation';
import { enablePush, pushConfigured } from '@/lib/firebase-push';
import { RemindersCard } from '@/components/reminders-card';

interface Address {
  street: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
}

interface Contact {
  name: string;
  role: string;
  phone?: string;
  email?: string;
}

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
// Generic form kit, kept for the market/producer/sponsor screens to come.

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6">
      <h3 className="text-base font-bold text-earth-800 mb-4">{title}</h3>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-earth-500 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100 disabled:bg-earth-50 disabled:text-earth-400"
      />
    </div>
  );
}

function TextArea({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-earth-500 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="w-full px-3 py-2 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100 resize-none"
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-earth-500 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100 bg-white"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function AddressForm({
  address,
  onChange,
}: {
  address: Address;
  onChange: (a: Address) => void;
}) {
  const update = (field: keyof Address, value: string) => {
    onChange({ ...address, [field]: value });
  };

  return (
    <div className="space-y-3">
      <Field label="Street" value={address.street} onChange={(v) => update('street', v)} placeholder="123 Main Street" />
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Field label="City" value={address.city} onChange={(v) => update('city', v)} />
        <Field label="State" value={address.state} onChange={(v) => update('state', v)} />
        <Field label="ZIP" value={address.zip} onChange={(v) => update('zip', v)} />
      </div>
    </div>
  );
}

function ContactList({
  contacts,
  onChange,
}: {
  contacts: Contact[];
  onChange: (c: Contact[]) => void;
}) {
  const addContact = () => {
    onChange([...contacts, { name: '', role: '', phone: '', email: '' }]);
  };

  const updateContact = (index: number, field: keyof Contact, value: string) => {
    const updated = [...contacts];
    updated[index] = { ...updated[index], [field]: value };
    onChange(updated);
  };

  const removeContact = (index: number) => {
    onChange(contacts.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-4">
      {contacts.length === 0 && (
        <p className="text-sm text-earth-400">No additional contacts. Add people who should receive notifications or manage this account.</p>
      )}
      {contacts.map((c, i) => (
        <div key={i} className="p-3 sm:p-4 bg-earth-50 rounded-xl border border-earth-100 space-y-3 relative">
          <button
            onClick={() => removeContact(i)}
            className="absolute top-2 right-2 w-7 h-7 rounded-full bg-red-50 text-red-400 hover:text-red-600 hover:bg-red-100 border-none cursor-pointer text-sm font-bold flex items-center justify-center"
            title="Remove contact"
          >
            x
          </button>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pr-8">
            <Field label="Name" value={c.name} onChange={(v) => updateContact(i, 'name', v)} placeholder="Full name" />
            <Field label="Role" value={c.role} onChange={(v) => updateContact(i, 'role', v)} placeholder="e.g., Market manager" />
            <Field label="Phone" type="tel" value={c.phone || ''} onChange={(v) => updateContact(i, 'phone', v)} />
            <Field label="Email" type="email" value={c.email || ''} onChange={(v) => updateContact(i, 'email', v)} />
          </div>
        </div>
      ))}
      <button
        onClick={addContact}
        className="w-full py-2.5 border-2 border-dashed border-earth-200 rounded-xl text-sm font-semibold text-earth-500 hover:text-farm-600 hover:border-farm-300 bg-transparent cursor-pointer transition-colors"
      >
        + Add Contact
      </button>
    </div>
  );
}

function SaveBar({ saving, onSave }: { saving: boolean; onSave: () => void }) {
  return (
    <div className="flex justify-end pt-2 pb-8">
      <button
        onClick={onSave}
        disabled={saving}
        className="px-6 py-2.5 rounded-xl font-semibold text-sm text-white border-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        style={{ background: 'linear-gradient(135deg, #21512C, #3D7A47)' }}
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  );
}

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
