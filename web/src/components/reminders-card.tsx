'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

interface Reminder {
  id: string;
  title: string;
  frequency: 'daily' | 'weekly';
  schedule_days: string;
  time: string;
  active: boolean;
}

function formatTime12h(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}

export function RemindersCard() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [title, setTitle] = useState('');
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('weekly');
  const [days, setDays] = useState<string[]>([]);
  const [time, setTime] = useState('08:00');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getReminders()
      .then((data: any) => setReminders(data.reminders || []))
      .catch(err => console.error('Failed to load reminders:', err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleDay = (day: string) =>
    setDays(prev => (prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]));

  const resetForm = () => {
    setTitle(''); setFrequency('weekly'); setDays([]); setTime('08:00'); setError(null);
  };

  const submit = async () => {
    setError(null);
    if (!title.trim()) return setError('Describe what to remind you about.');
    if (frequency === 'weekly' && days.length === 0) return setError('Pick at least one day.');
    setSaving(true);
    try {
      await api.createReminder({
        title: title.trim(),
        frequency,
        schedule_days: frequency === 'weekly' ? WEEKDAYS.filter(d => days.includes(d)).join(', ') : undefined,
        time,
      });
      resetForm();
      setShowForm(false);
      load();
    } catch (err: any) {
      setError(err?.message || 'Failed to create reminder.');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (r: Reminder) => {
    setBusyId(r.id);
    try {
      await api.updateReminder(r.id, { active: !r.active });
      load();
    } catch (err) {
      console.error('Failed to update reminder:', err);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      await api.deleteReminder(id);
      load();
    } catch (err) {
      console.error('Failed to delete reminder:', err);
    } finally {
      setBusyId(null);
    }
  };

  const inputCls = 'w-full h-10 rounded-lg border border-earth-200 bg-white px-3 text-sm text-earth-900 outline-none focus:border-green-600';

  return (
    <div className="mb-6 bg-white border border-earth-100 rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-earth-900 m-0">Reminders</h2>
          <p className="text-sm text-earth-500 mt-1 mb-0">
            Recurring reminders sent to you by text or push (Central time). You can also manage these by texting FarmLink.
          </p>
        </div>
        {!showForm && (
          <button onClick={() => setShowForm(true)}
            className="shrink-0 text-[13px] font-semibold bg-[#2A5E33] text-white border-none rounded-lg px-3.5 h-9 cursor-pointer hover:opacity-90 transition-opacity">
            + New
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-earth-500 py-4">Loading...</div>
      ) : reminders.length === 0 && !showForm ? (
        <div className="text-sm text-earth-500 py-4">No reminders yet.</div>
      ) : (
        <div className="mt-4 space-y-2">
          {reminders.map(r => (
            <div key={r.id} className="flex items-center gap-3 border border-earth-100 rounded-xl px-4 py-3"
              style={{ opacity: r.active ? 1 : 0.55 }}>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-earth-900 truncate">{r.title}</div>
                <div className="text-xs text-earth-500 mt-0.5">
                  {r.frequency === 'daily' ? 'Daily' : r.schedule_days} at {formatTime12h(r.time)}
                </div>
              </div>
              <button onClick={() => toggleActive(r)} disabled={busyId === r.id}
                className="text-[12px] font-semibold rounded-lg px-2.5 h-8 cursor-pointer border-none"
                style={{ background: r.active ? '#FBEFE6' : '#EBF4E6', color: r.active ? '#C9622F' : '#2A5E33' }}>
                {busyId === r.id ? '...' : r.active ? 'Pause' : 'Resume'}
              </button>
              <button onClick={() => remove(r.id)} disabled={busyId === r.id}
                className="text-[12px] font-semibold rounded-lg px-2.5 h-8 cursor-pointer border-none"
                style={{ background: '#FBEDEB', color: '#BC4639' }}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="mt-4 border border-earth-100 rounded-xl p-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold text-earth-600 uppercase tracking-wide mb-1.5">Remind me to...</label>
            <input className={inputCls} value={title} onChange={e => setTitle(e.target.value)}
              placeholder="e.g., Update inventory for the weekend market" maxLength={255} />
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <label className="block text-xs font-semibold text-earth-600 uppercase tracking-wide mb-1.5">Repeats</label>
              <select className={inputCls} value={frequency} onChange={e => setFrequency(e.target.value as 'daily' | 'weekly')}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs font-semibold text-earth-600 uppercase tracking-wide mb-1.5">Time</label>
              <input type="time" className={inputCls} value={time} onChange={e => setTime(e.target.value)} />
            </div>
          </div>
          {frequency === 'weekly' && (
            <div>
              <label className="block text-xs font-semibold text-earth-600 uppercase tracking-wide mb-1.5">On day(s)</label>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map(day => (
                  <button key={day} onClick={() => toggleDay(day)}
                    className="text-[12px] font-semibold rounded-lg px-2.5 h-8 cursor-pointer border transition-colors"
                    style={{
                      background: days.includes(day) ? '#2A5E33' : 'white',
                      color: days.includes(day) ? 'white' : '#6b6258',
                      borderColor: days.includes(day) ? '#2A5E33' : '#E4DFD3',
                    }}>
                    {day.slice(0, 3)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-[13px] text-red-700">{error}</div>
          )}
          <div className="flex gap-2 pt-1">
            <button onClick={() => { setShowForm(false); resetForm(); }}
              className="flex-1 h-10 rounded-lg border border-earth-200 bg-white text-sm font-semibold text-earth-600 cursor-pointer">
              Cancel
            </button>
            <button onClick={submit} disabled={saving}
              className="flex-1 h-10 rounded-lg border-none text-sm font-semibold text-white cursor-pointer"
              style={{ background: '#2A5E33', opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving...' : 'Save Reminder'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
