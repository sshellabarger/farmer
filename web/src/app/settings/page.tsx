'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { Header } from '@/components/header';
import { ChatWidget } from '@/components/chat-widget';
import { useRouter } from 'next/navigation';

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

interface DeliverySlot {
  day: string;
  time_window: string;
  areas?: string[];
}

const emptyAddress: Address = { street: '', city: '', state: '', zip: '' };

export default function SettingsPage() {
  const { user, farm, market, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<'profile' | 'farm' | 'market'>('profile');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);

  // User fields
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [userLogo, setUserLogo] = useState('');

  // Farm fields
  const [farmName, setFarmName] = useState('');
  const [farmLocation, setFarmLocation] = useState('');
  const [farmSpecialty, setFarmSpecialty] = useState('');
  const [farmPhone, setFarmPhone] = useState('');
  const [farmEmail, setFarmEmail] = useState('');
  const [farmDescription, setFarmDescription] = useState('');
  const [farmLogo, setFarmLogo] = useState('');
  const [farmPhysical, setFarmPhysical] = useState<Address>(emptyAddress);
  const [farmBilling, setFarmBilling] = useState<Address>(emptyAddress);
  const [farmContacts, setFarmContacts] = useState<Contact[]>([]);
  const [farmDeliverySchedule, setFarmDeliverySchedule] = useState<DeliverySlot[]>([]);
  const [farmBillingSame, setFarmBillingSame] = useState(true);

  // Market fields
  const [marketName, setMarketName] = useState('');
  const [marketLocation, setMarketLocation] = useState('');
  const [marketType, setMarketType] = useState('grocery');
  const [marketDeliveryPref, setMarketDeliveryPref] = useState('either');
  const [marketPhone, setMarketPhone] = useState('');
  const [marketEmail, setMarketEmail] = useState('');
  const [marketDescription, setMarketDescription] = useState('');
  const [marketLogo, setMarketLogo] = useState('');
  const [marketPhysical, setMarketPhysical] = useState<Address>(emptyAddress);
  const [marketBilling, setMarketBilling] = useState<Address>(emptyAddress);
  const [marketContacts, setMarketContacts] = useState<Contact[]>([]);
  const [marketBillingSame, setMarketBillingSame] = useState(true);

  const loadProfile = useCallback(async () => {
    try {
      const data = await api.getProfile();
      if (data.user) {
        setUserName(data.user.name || '');
        setUserEmail(data.user.email || '');
        setUserLogo(data.user.logo_url || '');
      }
      if (data.farm) {
        setFarmName(data.farm.name || '');
        setFarmLocation(data.farm.location || '');
        setFarmSpecialty(data.farm.specialty || '');
        setFarmPhone(data.farm.phone || '');
        setFarmEmail(data.farm.email || '');
        setFarmDescription(data.farm.description || '');
        setFarmLogo(data.farm.logo_url || '');
        const pa = data.farm.physical_address;
        if (pa && typeof pa === 'object') setFarmPhysical(pa);
        const ba = data.farm.billing_address;
        if (ba && typeof ba === 'object') {
          setFarmBilling(ba);
          setFarmBillingSame(false);
        }
        const contacts = data.farm.contacts;
        if (Array.isArray(contacts) && contacts.length > 0) setFarmContacts(contacts);
        const ds = data.farm.delivery_schedule;
        if (Array.isArray(ds) && ds.length > 0) setFarmDeliverySchedule(ds);
      }
      if (data.market) {
        setMarketName(data.market.name || '');
        setMarketLocation(data.market.location || '');
        setMarketType(data.market.type || 'grocery');
        setMarketDeliveryPref(data.market.delivery_pref || 'either');
        setMarketPhone(data.market.phone || '');
        setMarketEmail(data.market.email || '');
        setMarketDescription(data.market.description || '');
        setMarketLogo(data.market.logo_url || '');
        const pa = data.market.physical_address;
        if (pa && typeof pa === 'object') setMarketPhysical(pa);
        const ba = data.market.billing_address;
        if (ba && typeof ba === 'object') {
          setMarketBilling(ba);
          setMarketBillingSame(false);
        }
        const contacts = data.market.contacts;
        if (Array.isArray(contacts) && contacts.length > 0) setMarketContacts(contacts);
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

  // Auto-select the right tab
  useEffect(() => {
    if (farm && !market) setTab('farm');
    else if (market && !farm) setTab('market');
  }, [farm, market]);

  const flash = (msg: string) => {
    setSaved(msg);
    setTimeout(() => setSaved(''), 2500);
  };

  const handleLogoUpload = async (
    file: File,
    setter: (url: string) => void,
  ) => {
    try {
      const data = await api.uploadImage(file);
      setter(data.url);
    } catch {
      alert('Failed to upload logo');
    }
  };

  const saveUser = async () => {
    setSaving(true);
    try {
      await api.updateUser({
        name: userName,
        email: userEmail || null,
        logo_url: userLogo || null,
      });
      flash('Profile saved!');
    } catch (e: any) {
      alert(e.message);
    }
    setSaving(false);
  };

  const saveFarm = async () => {
    setSaving(true);
    try {
      await api.updateFarm({
        name: farmName,
        location: farmLocation,
        specialty: farmSpecialty || null,
        phone: farmPhone || null,
        email: farmEmail || null,
        description: farmDescription || null,
        logo_url: farmLogo || null,
        physical_address: farmPhysical.street ? farmPhysical : null,
        billing_address: farmBillingSame ? null : (farmBilling.street ? farmBilling : null),
        contacts: farmContacts,
        delivery_schedule: farmDeliverySchedule,
      });
      flash('Farm profile saved!');
    } catch (e: any) {
      alert(e.message);
    }
    setSaving(false);
  };

  const saveMarket = async () => {
    setSaving(true);
    try {
      await api.updateMarket({
        name: marketName,
        location: marketLocation,
        type: marketType,
        delivery_pref: marketDeliveryPref,
        phone: marketPhone || null,
        email: marketEmail || null,
        description: marketDescription || null,
        logo_url: marketLogo || null,
        physical_address: marketPhysical.street ? marketPhysical : null,
        billing_address: marketBillingSame ? null : (marketBilling.street ? marketBilling : null),
        contacts: marketContacts,
      });
      flash('Market profile saved!');
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

  const tabs = [
    { key: 'profile' as const, label: 'Account' },
    ...(farm ? [{ key: 'farm' as const, label: 'Farm' }] : []),
    ...(market ? [{ key: 'market' as const, label: 'Market' }] : []),
  ];

  return (
    <>
      <Header />
      <ChatWidget />
      <div className="max-w-[800px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <h1 className="text-xl sm:text-2xl font-extrabold text-earth-900 mb-1">Settings</h1>
        <p className="text-sm text-earth-500 mb-6">Manage your profile, addresses, and contacts</p>

        {/* Saved flash */}
        {saved && (
          <div className="mb-4 px-4 py-2 bg-green-50 border border-green-200 text-green-700 rounded-xl text-sm font-semibold animate-pulse">
            {saved}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-earth-100 rounded-xl p-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 py-2 px-3 rounded-lg text-sm font-semibold border-none cursor-pointer transition-all ${
                tab === t.key
                  ? 'bg-white text-earth-900 shadow-sm'
                  : 'bg-transparent text-earth-500 hover:text-earth-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Account Tab ── */}
        {tab === 'profile' && (
          <div className="space-y-6">
            <SectionCard title="Account Details">
              <div className="flex flex-col sm:flex-row gap-4 sm:gap-6 items-start">
                <LogoUpload url={userLogo} onUpload={(f) => handleLogoUpload(f, setUserLogo)} onRemove={() => setUserLogo('')} label="Avatar" />
                <div className="flex-1 w-full space-y-3">
                  <Field label="Name" value={userName} onChange={setUserName} />
                  <Field label="Email" type="email" value={userEmail} onChange={setUserEmail} />
                  <Field label="Phone" value={user?.phone || ''} disabled />
                </div>
              </div>
            </SectionCard>
            <SaveBar saving={saving} onSave={saveUser} />
          </div>
        )}

        {/* ── Farm Tab ── */}
        {tab === 'farm' && farm && (
          <div className="space-y-6">
            <SectionCard title="Farm Details">
              <div className="flex flex-col sm:flex-row gap-4 sm:gap-6 items-start">
                <LogoUpload url={farmLogo} onUpload={(f) => handleLogoUpload(f, setFarmLogo)} onRemove={() => setFarmLogo('')} label="Logo" />
                <div className="flex-1 w-full space-y-3">
                  <Field label="Farm Name" value={farmName} onChange={setFarmName} />
                  <Field label="Location" value={farmLocation} onChange={setFarmLocation} />
                  <Field label="Specialty" value={farmSpecialty} onChange={setFarmSpecialty} placeholder="e.g., Organic Vegetables" />
                  <TextArea label="Description" value={farmDescription} onChange={setFarmDescription} placeholder="Tell buyers about your farm..." />
                </div>
              </div>
            </SectionCard>

            <SectionCard title="Contact Information">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Phone" type="tel" value={farmPhone} onChange={setFarmPhone} />
                <Field label="Email" type="email" value={farmEmail} onChange={setFarmEmail} />
              </div>
            </SectionCard>

            <SectionCard title="Physical Address">
              <AddressForm address={farmPhysical} onChange={setFarmPhysical} />
            </SectionCard>

            <SectionCard title="Billing Address">
              <label className="flex items-center gap-2 mb-3 text-sm text-earth-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={farmBillingSame}
                  onChange={(e) => setFarmBillingSame(e.target.checked)}
                  className="rounded"
                />
                Same as physical address
              </label>
              {!farmBillingSame && (
                <AddressForm address={farmBilling} onChange={setFarmBilling} />
              )}
            </SectionCard>

            <SectionCard title="Delivery Schedule">
              <p className="text-sm text-earth-500 mb-3">Set the days and times you deliver or are available for pickup.</p>
              <DeliveryScheduleEditor schedule={farmDeliverySchedule} onChange={setFarmDeliverySchedule} />
            </SectionCard>

            <SectionCard title="Additional Contacts">
              <ContactList contacts={farmContacts} onChange={setFarmContacts} />
            </SectionCard>

            <SaveBar saving={saving} onSave={saveFarm} />
          </div>
        )}

        {/* ── Market Tab ── */}
        {tab === 'market' && market && (
          <div className="space-y-6">
            <SectionCard title="Market Details">
              <div className="flex flex-col sm:flex-row gap-4 sm:gap-6 items-start">
                <LogoUpload url={marketLogo} onUpload={(f) => handleLogoUpload(f, setMarketLogo)} onRemove={() => setMarketLogo('')} label="Logo" />
                <div className="flex-1 w-full space-y-3">
                  <Field label="Market Name" value={marketName} onChange={setMarketName} />
                  <Field label="Location" value={marketLocation} onChange={setMarketLocation} />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <SelectField
                      label="Type"
                      value={marketType}
                      onChange={setMarketType}
                      options={[
                        { value: 'grocery', label: 'Grocery' },
                        { value: 'restaurant', label: 'Restaurant' },
                        { value: 'co-op', label: 'Co-op' },
                        { value: 'farmers_market', label: "Farmers Market" },
                      ]}
                    />
                    <SelectField
                      label="Delivery Preference"
                      value={marketDeliveryPref}
                      onChange={setMarketDeliveryPref}
                      options={[
                        { value: 'pickup', label: 'Pickup' },
                        { value: 'delivery', label: 'Delivery' },
                        { value: 'either', label: 'Either' },
                      ]}
                    />
                  </div>
                  <TextArea label="Description" value={marketDescription} onChange={setMarketDescription} placeholder="Tell farms about your market..." />
                </div>
              </div>
            </SectionCard>

            <SectionCard title="Contact Information">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Phone" type="tel" value={marketPhone} onChange={setMarketPhone} />
                <Field label="Email" type="email" value={marketEmail} onChange={setMarketEmail} />
              </div>
            </SectionCard>

            <SectionCard title="Physical Address">
              <AddressForm address={marketPhysical} onChange={setMarketPhysical} />
            </SectionCard>

            <SectionCard title="Billing Address">
              <label className="flex items-center gap-2 mb-3 text-sm text-earth-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={marketBillingSame}
                  onChange={(e) => setMarketBillingSame(e.target.checked)}
                  className="rounded"
                />
                Same as physical address
              </label>
              {!marketBillingSame && (
                <AddressForm address={marketBilling} onChange={setMarketBilling} />
              )}
            </SectionCard>

            <SectionCard title="Additional Contacts">
              <ContactList contacts={marketContacts} onChange={setMarketContacts} />
            </SectionCard>

            <SaveBar saving={saving} onSave={saveMarket} />
          </div>
        )}
      </div>
    </>
  );
}

// ── Subcomponents ──────────────────────────────────────────────

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

function LogoUpload({
  url,
  onUpload,
  onRemove,
  label,
}: {
  url: string;
  onUpload: (file: File) => void;
  onRemove: () => void;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 shrink-0">
      <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-2xl border-2 border-dashed border-earth-200 bg-earth-50 flex items-center justify-center overflow-hidden">
        {url ? (
          <img src={url} alt={label} className="w-full h-full object-cover" />
        ) : (
          <span className="text-earth-300 text-3xl">+</span>
        )}
      </div>
      <div className="flex gap-1">
        <label className="text-xs font-semibold text-farm-600 cursor-pointer hover:text-farm-700">
          {url ? 'Change' : `Add ${label}`}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUpload(file);
              e.target.value = '';
            }}
          />
        </label>
        {url && (
          <button
            onClick={onRemove}
            className="text-xs text-red-500 hover:text-red-600 bg-transparent border-none cursor-pointer"
          >
            Remove
          </button>
        )}
      </div>
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
      <Field label="Street" value={address.street} onChange={(v) => update('street', v)} placeholder="123 Farm Road" />
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
            <Field label="Name" value={c.name} onChange={(v) => updateContact(i, 'name', v)} placeholder="John Doe" />
            <Field label="Role" value={c.role} onChange={(v) => updateContact(i, 'role', v)} placeholder="e.g., Manager, Driver" />
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

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_LABELS: Record<string, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
};

function DeliveryScheduleEditor({
  schedule,
  onChange,
}: {
  schedule: DeliverySlot[];
  onChange: (s: DeliverySlot[]) => void;
}) {
  const addSlot = () => {
    // Find first day not yet in schedule
    const usedDays = schedule.map((s) => s.day);
    const nextDay = DAYS.find((d) => !usedDays.includes(d)) || 'monday';
    onChange([...schedule, { day: nextDay, time_window: '6am-10am', areas: [] }]);
  };

  const updateSlot = (index: number, field: keyof DeliverySlot, value: unknown) => {
    const updated = [...schedule];
    updated[index] = { ...updated[index], [field]: value };
    onChange(updated);
  };

  const removeSlot = (index: number) => {
    onChange(schedule.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-3">
      {schedule.length === 0 && (
        <div className="text-sm text-earth-400 py-2">
          No delivery days configured. Add your delivery schedule so markets know when to expect orders.
        </div>
      )}
      {schedule.map((slot, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2 p-3 bg-earth-50 rounded-xl border border-earth-100 relative">
          <button
            onClick={() => removeSlot(i)}
            className="absolute top-2 right-2 w-6 h-6 rounded-full bg-red-50 text-red-400 hover:text-red-600 hover:bg-red-100 border-none cursor-pointer text-xs font-bold flex items-center justify-center"
          >
            x
          </button>
          <div className="w-full sm:w-auto">
            <label className="block text-xs font-semibold text-earth-500 mb-1">Day</label>
            <div className="flex flex-wrap gap-1">
              {DAYS.map((day) => (
                <button
                  key={day}
                  onClick={() => updateSlot(i, 'day', day)}
                  className={`px-2 py-1 rounded-lg text-xs font-semibold border cursor-pointer transition-all ${
                    slot.day === day
                      ? 'bg-farm-600 text-white border-farm-600'
                      : 'bg-white text-earth-500 border-earth-200 hover:border-farm-300'
                  }`}
                >
                  {DAY_LABELS[day]}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 min-w-[120px]">
            <label className="block text-xs font-semibold text-earth-500 mb-1">Time Window</label>
            <select
              value={slot.time_window}
              onChange={(e) => updateSlot(i, 'time_window', e.target.value)}
              className="w-full px-3 py-2 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 bg-white"
            >
              <option value="5am-8am">5am - 8am (Early Morning)</option>
              <option value="6am-10am">6am - 10am (Morning)</option>
              <option value="8am-12pm">8am - 12pm (Late Morning)</option>
              <option value="10am-2pm">10am - 2pm (Midday)</option>
              <option value="12pm-4pm">12pm - 4pm (Afternoon)</option>
              <option value="2pm-6pm">2pm - 6pm (Late Afternoon)</option>
            </select>
          </div>
          <div className="flex-1 min-w-[150px]">
            <label className="block text-xs font-semibold text-earth-500 mb-1">Delivery Areas (optional)</label>
            <input
              type="text"
              value={(slot.areas || []).join(', ')}
              onChange={(e) => updateSlot(i, 'areas', e.target.value.split(',').map((a) => a.trim()).filter(Boolean))}
              placeholder="e.g., Little Rock, Scott"
              className="w-full px-3 py-2 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500"
            />
          </div>
        </div>
      ))}
      <button
        onClick={addSlot}
        className="w-full py-2.5 border-2 border-dashed border-earth-200 rounded-xl text-sm font-semibold text-earth-500 hover:text-farm-600 hover:border-farm-300 bg-transparent cursor-pointer transition-colors"
      >
        + Add Delivery Day
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
        style={{ background: 'linear-gradient(135deg, #2d5016, #4a7c28)' }}
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  );
}
