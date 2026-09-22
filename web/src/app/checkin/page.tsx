'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import type { CheckinSubmitInput, CheckinTokenView } from '@/lib/types';
import { Icon } from '@/components/icons';
import { Notice } from '@/components/form';
import { formatDateLabel, weekdayLabel } from '@/components/admin-shell';
import { CheckinForm } from '@/components/checkin-form';
import { FARMLINK_NUMBER_DISPLAY, smsHref } from '@/lib/constants';

export default function CheckinPage() {
  return (
    <Suspense fallback={<Shell><LoadingCard /></Shell>}>
      <CheckinRoute />
    </Suspense>
  );
}

function CheckinRoute() {
  const params = useSearchParams();
  const token = params.get('t') || '';
  return <CheckinInner token={token} />;
}

function CheckinInner({ token }: { token: string }) {
  const [view, setView] = useState<CheckinTokenView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState<'unknown' | 'expired' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [done, setDone] = useState<{ date_label: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotFound(null);
    try {
      const v = await api.getCheckinByToken(token);
      setView(v);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound('unknown');
      else if (err instanceof ApiError && err.status === 410) setNotFound('expired');
      else setError(err instanceof Error ? err.message : 'Something went wrong loading this link.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setNotFound('unknown');
      return;
    }
    load();
  }, [token, load]);

  const submit = async (values: CheckinSubmitInput) => {
    setSubmitting(true);
    setSubmitError('');
    try {
      await api.submitCheckin(token, values);
      if (view) setDone({ date_label: view.date_label });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound('unknown');
      else if (err instanceof ApiError && err.status === 410) setNotFound('expired');
      else setSubmitError(err instanceof Error ? err.message : 'Could not save your check-in.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <Shell><LoadingCard /></Shell>;
  }

  if (notFound === 'unknown') {
    return (
      <Shell>
        <Card>
          <Notice kind="error">
            We don&rsquo;t recognise this link. Text us at {FARMLINK_NUMBER_DISPLAY} and we&rsquo;ll help.
          </Notice>
        </Card>
      </Shell>
    );
  }

  if (notFound === 'expired') {
    return (
      <Shell>
        <Card>
          <Notice kind="error">
            This link has expired. Text us at {FARMLINK_NUMBER_DISPLAY} if you still need to check in.
          </Notice>
        </Card>
      </Shell>
    );
  }

  if (error || !view) {
    return (
      <Shell>
        <Card>
          <Notice kind="error">{error || 'Something went wrong loading this link.'}</Notice>
        </Card>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <Card>
          <div className="text-center py-2">
            <div className="text-3xl mb-2">✓</div>
            <p className="text-[15px] text-text m-0 mb-2">
              Thanks, {view.producer_name} — your check-in for {done.date_label} is saved.
            </p>
            <p className="text-sm text-earth-500 m-0">
              Need to change something? Open this link again before {view.deadline_label}.
            </p>
          </div>
        </Card>
        <TextUsLink />
      </Shell>
    );
  }

  return (
    <Shell>
      <Card>
        <div className="mb-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-earth-500 mb-1">
            {view.producer_name}
          </div>
          <h1 className="font-display text-xl font-extrabold m-0" style={{ color: '#1B3F24' }}>
            {view.market_name}
          </h1>
          <p className="text-sm text-earth-500 mt-1 mb-0">
            {weekdayLabel(view.date)}, {formatDateLabel(view.date)}
          </p>
          <p className="text-sm mt-2 mb-0" style={{ color: view.past_deadline ? '#B91C1C' : '#3d3428' }}>
            {view.past_deadline
              ? `The deadline was ${view.deadline_label} — you can still send your answers`
              : `Due by ${view.deadline_label}`}
          </p>
        </div>

        {submitError && (
          <div className="mb-4">
            <Notice kind="error">{submitError}</Notice>
          </div>
        )}

        <CheckinForm
          marketName={view.market_name}
          questions={view.questions.extra_questions}
          initial={view.existing}
          submitting={submitting}
          onSubmit={submit}
        />
      </Card>
      <TextUsLink />
    </Shell>
  );
}

/* ─── Chrome ─── */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#faf8f5' }}>
      <div className="border-b border-border-light" style={{ background: 'rgba(250,248,244,0.9)' }}>
        <div className="max-w-[560px] mx-auto px-4 h-[56px] flex items-center gap-2.5">
          <div
            className="w-[30px] h-[30px] rounded-[9px] flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #21512C 0%, #3D7A47 100%)' }}
          >
            <Icon name="leaf" size={16} className="text-white" />
          </div>
          <span className="font-display font-semibold text-[17px] text-text tracking-tight">SJCA Markets</span>
        </div>
      </div>
      <main className="flex-1 px-4 py-8">
        <div className="max-w-[560px] mx-auto space-y-4">{children}</div>
      </main>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6">{children}</div>;
}

function LoadingCard() {
  return (
    <Card>
      <div className="animate-pulse text-earth-400 text-sm py-6 text-center">Loading your check-in…</div>
    </Card>
  );
}

function TextUsLink() {
  return (
    <a
      href={smsHref('Hi SJCA Markets!')}
      className="flex items-center justify-center gap-2 px-4 py-3 rounded-2xl no-underline bg-green-50/70 border border-green-100 text-green-700 text-[13.5px] font-semibold"
    >
      <Icon name="msg" size={15} />
      Prefer to text? Reply to our message or text us at {FARMLINK_NUMBER_DISPLAY}
    </a>
  );
}
