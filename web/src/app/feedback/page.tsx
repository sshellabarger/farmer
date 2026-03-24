'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { Header } from '@/components/header';
import { ChatWidget } from '@/components/chat-widget';
import { useRouter } from 'next/navigation';

interface FeedbackItem {
  id: string;
  user_id: string;
  user_name: string;
  user_role: string;
  type: 'feature_request' | 'bug_report';
  status: string;
  priority: string;
  title: string;
  description: string;
  admin_notes?: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  open: { bg: '#fef3c7', text: '#92400e' },
  under_review: { bg: '#dbeafe', text: '#1e40af' },
  planned: { bg: '#e0e7ff', text: '#3730a3' },
  in_progress: { bg: '#fce7f3', text: '#9d174d' },
  resolved: { bg: '#d1fae5', text: '#065f46' },
  closed: { bg: '#f3f4f6', text: '#6b7280' },
};

const PRIORITY_COLORS: Record<string, { bg: string; text: string }> = {
  low: { bg: '#f0fdf4', text: '#166534' },
  medium: { bg: '#fefce8', text: '#854d0e' },
  high: { bg: '#fff7ed', text: '#c2410c' },
  critical: { bg: '#fef2f2', text: '#dc2626' },
};

function StatusBadge({ value, colors }: { value: string; colors: Record<string, { bg: string; text: string }> }) {
  const c = colors[value] || { bg: '#f3f4f6', text: '#6b7280' };
  return (
    <span
      className="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: c.bg, color: c.text }}
    >
      {value.replace(/_/g, ' ')}
    </span>
  );
}

export default function FeedbackPage() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [filterType, setFilterType] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');

  // Form state
  const [formType, setFormType] = useState<'feature_request' | 'bug_report'>('feature_request');
  const [formTitle, setFormTitle] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  // Admin edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStatus, setEditStatus] = useState('');
  const [editPriority, setEditPriority] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const isAdmin = user?.role === 'admin';

  const loadFeedback = useCallback(async () => {
    try {
      const params: Record<string, string> = {};
      if (filterType) params.type = filterType;
      if (filterStatus) params.status = filterStatus;
      const data = await api.getFeedback(params);
      setFeedback(data.feedback || []);
    } catch (err) {
      console.error('Failed to load feedback:', err);
    } finally {
      setLoading(false);
    }
  }, [filterType, filterStatus]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login');
      return;
    }
    if (isAuthenticated) {
      loadFeedback();
    }
  }, [isLoading, isAuthenticated, router, loadFeedback]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formTitle.trim() || !formDesc.trim()) return;

    setSubmitting(true);
    setSuccessMsg('');
    try {
      await api.createFeedback({ type: formType, title: formTitle.trim(), description: formDesc.trim() });
      setSuccessMsg(formType === 'feature_request' ? 'Feature request submitted!' : 'Bug report submitted!');
      setFormTitle('');
      setFormDesc('');
      setShowForm(false);
      loadFeedback();
    } catch (err) {
      console.error('Failed to submit feedback:', err);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAdminSave(id: string) {
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {};
      if (editStatus) updates.status = editStatus;
      if (editPriority) updates.priority = editPriority;
      updates.admin_notes = editNotes || null;

      await api.updateFeedback(id, updates);
      setEditingId(null);
      loadFeedback();
    } catch (err) {
      console.error('Failed to update feedback:', err);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this feedback item?')) return;
    try {
      await api.deleteFeedback(id);
      loadFeedback();
    } catch (err) {
      console.error('Failed to delete feedback:', err);
    }
  }

  if (isLoading || (!isAuthenticated && !isLoading)) {
    return (
      <div className="min-h-screen" style={{ background: '#faf8f5' }}>
        <Header />
        <div className="flex items-center justify-center h-64">
          <div className="animate-pulse text-[#8a7e72]">Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: '#faf8f5' }}>
      <Header />

      <div className="max-w-[900px] mx-auto px-4 sm:px-6 py-8">
        {/* Title + submit button */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="font-display text-2xl sm:text-3xl font-extrabold" style={{ color: '#1a3409' }}>
              Feedback
            </h1>
            <p className="text-sm mt-1" style={{ color: '#8a7e72' }}>
              Request features or report issues to help us improve FarmLink
            </p>
          </div>
          <button
            onClick={() => { setShowForm(!showForm); setSuccessMsg(''); }}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white cursor-pointer border-none transition-all"
            style={{ background: 'linear-gradient(135deg, #2d5016, #4a7c28)' }}
          >
            {showForm ? 'Cancel' : '+ New Feedback'}
          </button>
        </div>

        {/* Success message */}
        {successMsg && (
          <div
            className="mb-5 px-4 py-3 rounded-xl text-sm font-semibold"
            style={{ background: '#d1fae5', color: '#065f46' }}
          >
            {successMsg}
          </div>
        )}

        {/* Submit form */}
        {showForm && (
          <div
            className="mb-6 rounded-2xl p-5 sm:p-6 border"
            style={{ background: '#fff', borderColor: '#e8e0d6' }}
          >
            <h2 className="font-display text-lg font-bold mb-4" style={{ color: '#2d5016' }}>
              Submit Feedback
            </h2>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              {/* Type selector */}
              <div className="flex gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="type"
                    checked={formType === 'feature_request'}
                    onChange={() => setFormType('feature_request')}
                    className="accent-[#2d5016]"
                  />
                  <span className="text-sm font-medium" style={{ color: '#3d3428' }}>Feature Request</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="type"
                    checked={formType === 'bug_report'}
                    onChange={() => setFormType('bug_report')}
                    className="accent-[#2d5016]"
                  />
                  <span className="text-sm font-medium" style={{ color: '#3d3428' }}>Bug Report</span>
                </label>
              </div>

              {/* Title */}
              <input
                type="text"
                placeholder={formType === 'feature_request' ? 'What feature would you like?' : 'Brief description of the issue'}
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                maxLength={255}
                required
                className="w-full px-4 py-2.5 rounded-xl border text-sm outline-none"
                style={{ borderColor: '#e8e0d6', color: '#3d3428' }}
              />

              {/* Description */}
              <textarea
                placeholder={formType === 'feature_request'
                  ? 'Describe the feature and how it would help your workflow...'
                  : 'Steps to reproduce, what happened vs. what you expected...'}
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                required
                rows={4}
                className="w-full px-4 py-2.5 rounded-xl border text-sm outline-none resize-y"
                style={{ borderColor: '#e8e0d6', color: '#3d3428' }}
              />

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={submitting || !formTitle.trim() || !formDesc.trim()}
                  className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ background: 'linear-gradient(135deg, #2d5016, #4a7c28)' }}
                >
                  {submitting ? 'Submitting...' : 'Submit'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-5">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="px-3 py-1.5 rounded-lg border text-xs font-medium cursor-pointer"
            style={{ borderColor: '#e8e0d6', color: '#3d3428', background: '#fff' }}
          >
            <option value="">All Types</option>
            <option value="feature_request">Feature Requests</option>
            <option value="bug_report">Bug Reports</option>
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="px-3 py-1.5 rounded-lg border text-xs font-medium cursor-pointer"
            style={{ borderColor: '#e8e0d6', color: '#3d3428', background: '#fff' }}
          >
            <option value="">All Statuses</option>
            <option value="open">Open</option>
            <option value="under_review">Under Review</option>
            <option value="planned">Planned</option>
            <option value="in_progress">In Progress</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
        </div>

        {/* Feedback list */}
        {loading ? (
          <div className="text-center py-12 text-[#8a7e72]">Loading feedback...</div>
        ) : feedback.length === 0 ? (
          <div
            className="text-center py-12 rounded-2xl border"
            style={{ background: '#fff', borderColor: '#e8e0d6' }}
          >
            <p className="text-lg mb-2" style={{ color: '#3d3428' }}>No feedback yet</p>
            <p className="text-sm" style={{ color: '#8a7e72' }}>
              Be the first to submit a feature request or report an issue!
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {feedback.map((item) => (
              <div
                key={item.id}
                className="rounded-2xl border p-4 sm:p-5 transition-all"
                style={{ background: '#fff', borderColor: '#e8e0d6' }}
              >
                {/* Header row */}
                <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{
                      background: item.type === 'feature_request' ? '#e0e7ff' : '#fef2f2',
                      color: item.type === 'feature_request' ? '#3730a3' : '#dc2626',
                    }}>
                      {item.type === 'feature_request' ? 'Feature' : 'Bug'}
                    </span>
                    <StatusBadge value={item.status} colors={STATUS_COLORS} />
                    <StatusBadge value={item.priority} colors={PRIORITY_COLORS} />
                    {item.source === 'sms' && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">via SMS</span>
                    )}
                  </div>
                  <span className="text-[11px]" style={{ color: '#8a7e72' }}>
                    {new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                </div>

                {/* Title + description */}
                <h3 className="text-sm font-bold mb-1" style={{ color: '#1a3409' }}>{item.title}</h3>
                <p className="text-sm leading-relaxed mb-2" style={{ color: '#3d3428' }}>{item.description}</p>

                {/* Submitter (admin view) */}
                {isAdmin && (
                  <p className="text-[11px] mb-2" style={{ color: '#8a7e72' }}>
                    Submitted by {item.user_name} ({item.user_role})
                  </p>
                )}

                {/* Admin notes display */}
                {isAdmin && item.admin_notes && editingId !== item.id && (
                  <div className="mt-2 px-3 py-2 rounded-lg text-xs" style={{ background: '#f5f0eb', color: '#3d3428' }}>
                    <span className="font-semibold">Admin notes:</span> {item.admin_notes}
                  </div>
                )}

                {/* Admin edit panel */}
                {isAdmin && editingId === item.id && (
                  <div className="mt-3 pt-3 border-t flex flex-col gap-3" style={{ borderColor: '#e8e0d6' }}>
                    <div className="flex flex-wrap gap-3">
                      <select
                        value={editStatus}
                        onChange={(e) => setEditStatus(e.target.value)}
                        className="px-3 py-1.5 rounded-lg border text-xs font-medium"
                        style={{ borderColor: '#e8e0d6', color: '#3d3428', background: '#fff' }}
                      >
                        <option value="">Status...</option>
                        <option value="open">Open</option>
                        <option value="under_review">Under Review</option>
                        <option value="planned">Planned</option>
                        <option value="in_progress">In Progress</option>
                        <option value="resolved">Resolved</option>
                        <option value="closed">Closed</option>
                      </select>
                      <select
                        value={editPriority}
                        onChange={(e) => setEditPriority(e.target.value)}
                        className="px-3 py-1.5 rounded-lg border text-xs font-medium"
                        style={{ borderColor: '#e8e0d6', color: '#3d3428', background: '#fff' }}
                      >
                        <option value="">Priority...</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="critical">Critical</option>
                      </select>
                    </div>
                    <textarea
                      placeholder="Admin notes (internal)..."
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      rows={2}
                      className="w-full px-3 py-2 rounded-lg border text-xs outline-none resize-y"
                      style={{ borderColor: '#e8e0d6', color: '#3d3428' }}
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => setEditingId(null)}
                        className="px-4 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border"
                        style={{ borderColor: '#e8e0d6', color: '#3d3428', background: '#fff' }}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleAdminSave(item.id)}
                        disabled={saving}
                        className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white cursor-pointer border-none disabled:opacity-50"
                        style={{ background: '#2d5016' }}
                      >
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Admin action buttons */}
                {isAdmin && editingId !== item.id && (
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => {
                        setEditingId(item.id);
                        setEditStatus(item.status);
                        setEditPriority(item.priority);
                        setEditNotes(item.admin_notes || '');
                      }}
                      className="px-3 py-1 rounded-lg text-[11px] font-semibold cursor-pointer border"
                      style={{ borderColor: '#e8e0d6', color: '#2d5016', background: '#fff' }}
                    >
                      Review
                    </button>
                    <button
                      onClick={() => handleDelete(item.id)}
                      className="px-3 py-1 rounded-lg text-[11px] font-semibold cursor-pointer border"
                      style={{ borderColor: '#fecaca', color: '#dc2626', background: '#fff' }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <ChatWidget />
    </div>
  );
}
