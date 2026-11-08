'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import type { ApplicationDoc, BoothDoc, UploadMeta } from '@/lib/phase4-types';
import type { ApplicationAction, FeePlan, Market, Membership } from '@/lib/types';
import { useStaffGuard } from '@/components/staff-guard';
import { StatusChip } from '@/components/status-chip';
import { CheckboxField, ConfirmButton, Field, Notice, PrimaryButton, SecondaryButton, SelectField, TextArea } from '@/components/form';
import { AdminShell, LoadingScreen, formatStamp } from '@/components/admin-shell';
import { ApplicationView, formatMoney, previewSeasonTotal } from '@/components/application-view';

export default function ApplicationDetailPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <ApplicationDetail />
    </Suspense>
  );
}

type Mode = 'none' | 'approve' | 'decline';

interface ApprovalOutcome {
  producerId: string | null;
  membershipId: string | null;
  sends: { sms: string; email: boolean } | null;
}

function ApplicationDetail() {
  const { ready } = useStaffGuard({ adminOnly: true });
  const params = useSearchParams();
  const id = params.get('id') || '';

  const [application, setApplication] = useState<ApplicationDoc | null>(null);
  const [uploads, setUploads] = useState<UploadMeta[]>([]);
  const [producer, setProducer] = useState<{ id: string; business_name: string } | null>(null);
  const [prior, setPrior] = useState<Membership[]>([]);
  const [market, setMarket] = useState<Market | null>(null);
  const [booths, setBooths] = useState<BoothDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>('none');
  const [outcome, setOutcome] = useState<ApprovalOutcome | null>(null);

  const reload = useCallback(async () => {
    if (!id) return;
    setError('');
    try {
      const d = await api.getApplicationV2(id);
      setApplication(d.application);
      setUploads(d.uploads || []);
      setProducer(d.producer);
      setPrior(d.prior_memberships || []);
      const [m, b] = await Promise.all([
        api.getMarket(d.application.market_id).catch(() => null),
        api.getBooths(d.application.market_id).catch(() => ({ booths: [] as BoothDoc[] })),
      ]);
      setMarket(m ? m.market : null);
      setBooths(b.booths || []);
    } catch (err: any) {
      setError(err?.message || 'Could not load the application');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (ready) reload();
  }, [ready, reload]);

  const flashMsg = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(''), 4000);
  };

  /** Run one PATCH action, then refresh. */
  const act = async (data: ApplicationAction, okMsg: string): Promise<boolean> => {
    if (!application) return false;
    setBusy(true);
    setError('');
    try {
      const res = await api.patchApplication(application.id, data);
      if (data.action === 'approve') {
        setOutcome({
          producerId: res.producer?.id ?? res.application.producer_id,
          membershipId: res.membership?.id ?? res.application.membership_id,
          sends: res.sends ?? null,
        });
      }
      if (data.action !== 'note' && data.action !== 'fee') setMode('none');
      await reload();
      flashMsg(okMsg);
      return true;
    } catch (err: any) {
      setError(err?.message || 'The change did not save');
      return false;
    } finally {
      setBusy(false);
    }
  };

  /**
   * Open an upload through a short-lived signed URL. The blank window is
   * opened first, synchronously, so the browser's popup blocker allows it.
   */
  const openUpload = async (uploadId: string) => {
    if (!application) return;
    const win = window.open('about:blank', '_blank');
    try {
      const { url } = await api.getApplicationUploadUrl(application.id, uploadId);
      if (win) {
        win.opener = null;
        win.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (err: any) {
      win?.close();
      setError(err?.message || 'Could not open the file');
    }
  };

  if (!ready) return <LoadingScreen />;
  if (!id) {
    return (
      <AdminShell title="Application">
        <Notice kind="error">No application id in the URL. <Link href="/admin/applications" className="font-semibold">Back to applications</Link></Notice>
      </AdminShell>
    );
  }
  if (loading && !application) return <LoadingScreen label="Loading application..." />;
  if (!application) {
    return (
      <AdminShell title="Application">
        <Notice kind="error">{error || 'Application not found.'} <Link href="/admin/applications" className="font-semibold">Back to applications</Link></Notice>
      </AdminShell>
    );
  }

  const a = application;
  const open = a.status === 'new' || a.status === 'under_review';
  const producerId = a.producer_id || producer?.id || outcome?.producerId || null;

  return (
    <AdminShell
      title={a.contact.business_name}
      subtitle={
        <>
          {market?.name || a.market_id} - season {a.season} - submitted {formatStamp(a.submitted_at)} -{' '}
          <Link href="/admin/applications" className="text-green-700">All applications</Link>
        </>
      }
      actions={<StatusChip status={a.status} />}
      width={1000}
    >
      {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}
      {flash && <div className="mb-4"><Notice kind="success">{flash}</Notice></div>}

      {a.status === 'approved' && (
        <div className="mb-4">
          <Notice kind="success">
            Approved.{' '}
            {producerId && (
              <Link href={`/admin/producers/detail?id=${encodeURIComponent(producerId)}`} className="font-semibold text-green-700">
                Open the producer
              </Link>
            )}
            {outcome?.sends && (
              <>
                {' '}
                Acceptance text: <strong>{outcome.sends.sms.replace(/_/g, ' ')}</strong>; acceptance email: <strong>{outcome.sends.email ? 'sent' : 'not sent'}</strong>.
              </>
            )}
          </Notice>
        </div>
      )}
      {a.status === 'declined' && a.review.decline_reason && (
        <div className="mb-4"><Notice kind="warning">Declined: {a.review.decline_reason}</Notice></div>
      )}
      {prior.length > 0 && (
        <div className="mb-4">
          <Notice kind="info">
            {producer?.business_name || 'This producer'} has been a vendor before:{' '}
            {prior.map((m) => `${m.season} (${m.status})`).join(', ')}.
            {producerId && (
              <>
                {' '}
                <Link href={`/admin/producers/detail?id=${encodeURIComponent(producerId)}`} className="font-semibold">View producer</Link>
              </>
            )}
          </Notice>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6 mb-6">
        <h3 className="text-base font-bold text-earth-800 mt-0 mb-3">Review</h3>
        {mode === 'none' && (
          <div className="flex flex-wrap items-center gap-2">
            {a.status === 'new' && <PrimaryButton small onClick={() => act({ action: 'review' }, 'Review started')} disabled={busy}>{busy ? 'Working...' : 'Start review'}</PrimaryButton>}
            {open && <PrimaryButton small onClick={() => setMode('approve')} disabled={busy}>Approve...</PrimaryButton>}
            {open && <SecondaryButton small onClick={() => setMode('decline')} disabled={busy}>Decline...</SecondaryButton>}
            {open && (
              <ConfirmButton
                label="Withdraw"
                confirmLabel="Mark withdrawn"
                busy={busy}
                onConfirm={async () => { await act({ action: 'withdraw' }, 'Application withdrawn'); }}
              />
            )}
            {!open && <span className="text-sm text-text-muted">This application is {a.status}. No further review actions.</span>}
          </div>
        )}
        {mode === 'approve' && (
          <ApproveDialog
            application={a}
            market={market}
            booths={booths}
            busy={busy}
            onCancel={() => setMode('none')}
            onApprove={(data) => act(data, 'Approved. The membership is created and the acceptance is on its way.')}
          />
        )}
        {mode === 'decline' && <DeclineDialog busy={busy} onCancel={() => setMode('none')} onDecline={(reason) => act({ action: 'decline', reason }, 'Application declined')} />}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <FeeCard application={a} busy={busy} onSet={(status, reference) => act({ action: 'fee', status, reference: reference || undefined }, `Fee marked ${status}`)} />
        <NotesCard application={a} onSave={(notes) => act({ action: 'note', notes }, 'Notes saved')} />
      </div>

      <ApplicationView application={a} uploads={uploads} market={market} onOpenUpload={openUpload} />
    </AdminShell>
  );
}

/* ─── Approve dialog ─── */

function ApproveDialog({
  application: a,
  market,
  booths,
  busy,
  onCancel,
  onApprove,
}: {
  application: ApplicationDoc;
  market: Market | null;
  booths: BoothDoc[];
  busy: boolean;
  onCancel: () => void;
  onApprove: (data: Extract<ApplicationAction, { action: 'approve' }>) => Promise<boolean>;
}) {
  const [feePlan, setFeePlan] = useState<FeePlan>(a.booth.rate);
  const [spaces, setSpaces] = useState<1 | 2>(a.booth.spaces);
  const [electric, setElectric] = useState(a.booth.electric);
  const [payInFull, setPayInFull] = useState(a.booth.pay_in_full);
  const [boothKind, setBoothKind] = useState<'stall' | 'food_truck'>(a.booth.food_truck ? 'food_truck' : 'stall');
  const [usualBooth, setUsualBooth] = useState('');
  const [trial, setTrial] = useState(false);
  const [note, setNote] = useState('');
  const [send, setSend] = useState(true);

  const activeBooths = booths.filter((b) => b.active && b.kind === boothKind);
  const fees = market?.fees;
  const preview = fees ? previewSeasonTotal(fees, { rate: feePlan, spaces, electric, pay_in_full: payInFull }, a.season_total.market_count) : null;
  const currency = fees?.currency || a.season_total.currency || 'USD';

  const boothOptions = [
    { value: '', label: 'No usual booth yet' },
    ...[...activeBooths]
      .sort((x, y) => x.row.localeCompare(y.row) || x.order - y.order)
      .map((b) => ({ value: b.id, label: `${b.label} (${b.row}${b.power ? ', power' : ''})` })),
  ];

  const preferred = a.booth.stall_preference.length > 0 ? a.booth.stall_preference.join(', ') : '';

  return (
    <div className="p-3 rounded-xl border border-earth-100 bg-earth-15 space-y-3 max-w-xl">
      <div className="text-sm font-semibold text-earth-800">Approve for the {a.season} season</div>
      <p className="text-xs text-earth-500 m-0">
        Defaults come from the applicant&apos;s booth request. Approving creates a {a.season} membership (status approved); it becomes active when the Hold Harmless is signed.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <SelectField label="Fee plan" value={feePlan} onChange={(v) => setFeePlan(v as FeePlan)} options={[{ value: 'seasonal', label: 'Seasonal' }, { value: 'daily', label: 'Daily' }]} />
        <SelectField label="Spaces" value={String(spaces)} onChange={(v) => setSpaces(v === '2' ? 2 : 1)} options={[{ value: '1', label: '1 space' }, { value: '2', label: '2 spaces' }]} />
        <SelectField
          label="Booth kind"
          value={boothKind}
          onChange={(v) => {
            setBoothKind(v === 'food_truck' ? 'food_truck' : 'stall');
            setUsualBooth('');
          }}
          options={[{ value: 'stall', label: 'Stall' }, { value: 'food_truck', label: 'Food truck' }]}
        />
        <div>
          <SelectField label="Usual booth" value={usualBooth} onChange={setUsualBooth} options={boothOptions} />
          {preferred && <div className="text-[11px] text-earth-500 mt-1">They asked for: {preferred}</div>}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <CheckboxField label="Electricity" checked={electric} onChange={setElectric} />
        {feePlan === 'seasonal' && <CheckboxField label="Pays the season fee in full" checked={payInFull} onChange={setPayInFull} />}
        <CheckboxField label="Trial period" hint="Flag a new vendor for review after a few markets." checked={trial} onChange={setTrial} />
      </div>
      <div className="rounded-lg border border-earth-100 bg-white px-3 py-2 text-sm">
        {preview ? (
          <>
            Booth fee total: <strong>{formatMoney(preview.total, currency)}</strong>
            {preview.basis === 'per_market' ? ' per market' : ` for ${preview.marketCount} markets`}
            {preview.basis === 'season' && ` - ${preview.installments} installment${preview.installments === 1 ? '' : 's'}`}
          </>
        ) : (
          <>Fee amounts are not available for this market.</>
        )}
      </div>
      <TextArea label="Note (optional)" value={note} onChange={setNote} />
      <CheckboxField label="Send the acceptance text and email" checked={send} onChange={setSend} />
      <div className="flex gap-2 justify-end">
        <SecondaryButton small onClick={onCancel} disabled={busy}>Cancel</SecondaryButton>
        <PrimaryButton
          small
          disabled={busy}
          onClick={() =>
            onApprove({
              action: 'approve',
              fee_plan: feePlan,
              spaces,
              electric,
              pay_in_full: feePlan === 'seasonal' && payInFull,
              booth_kind: boothKind,
              usual_booth_id: usualBooth || null,
              trial_period: trial,
              note: note.trim(),
              send,
            })
          }
        >
          {busy ? 'Approving...' : 'Approve'}
        </PrimaryButton>
      </div>
    </div>
  );
}

/* ─── Decline dialog ─── */

function DeclineDialog({ busy, onCancel, onDecline }: { busy: boolean; onCancel: () => void; onDecline: (reason: string) => Promise<boolean> }) {
  const [reason, setReason] = useState('');
  return (
    <div className="p-3 rounded-xl border border-earth-100 bg-earth-15 space-y-3 max-w-xl">
      <TextArea label="Reason" value={reason} onChange={setReason} placeholder="Kept in the record. Declining does not send a message." />
      <div className="flex gap-2 justify-end">
        <SecondaryButton small onClick={onCancel} disabled={busy}>Cancel</SecondaryButton>
        <PrimaryButton small disabled={busy || reason.trim().length === 0} onClick={() => onDecline(reason.trim())}>
          {busy ? 'Declining...' : 'Decline'}
        </PrimaryButton>
      </div>
    </div>
  );
}

/* ─── Fee ─── */

function FeeCard({
  application: a,
  busy,
  onSet,
}: {
  application: ApplicationDoc;
  busy: boolean;
  onSet: (status: 'paid' | 'waived' | 'unpaid', reference: string) => Promise<boolean>;
}) {
  const [reference, setReference] = useState(a.fee.reference || '');
  useEffect(() => setReference(a.fee.reference || ''), [a.fee.reference]);

  return (
    <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6">
      <h3 className="text-base font-bold text-earth-800 mt-0 mb-3">Application fee</h3>
      <div className="flex items-center gap-2 mb-3 text-sm">
        <StatusChip status={a.fee.status} />
        <span className="font-semibold">{formatMoney(a.fee.amount, a.fee.currency || 'USD')}</span>
        {a.fee.paid_at && <span className="text-text-muted">{formatStamp(a.fee.paid_at)}</span>}
      </div>
      <Field label="Reference (optional)" value={reference} onChange={setReference} placeholder="Zeffy receipt or note" />
      <div className="flex flex-wrap gap-2 mt-3">
        {a.fee.status !== 'paid' && <PrimaryButton small onClick={() => onSet('paid', reference.trim())} disabled={busy}>Mark paid</PrimaryButton>}
        {a.fee.status !== 'waived' && <SecondaryButton small onClick={() => onSet('waived', reference.trim())} disabled={busy}>Waive</SecondaryButton>}
        {a.fee.status !== 'unpaid' && <SecondaryButton small onClick={() => onSet('unpaid', reference.trim())} disabled={busy}>Mark unpaid</SecondaryButton>}
      </div>
    </div>
  );
}

/* ─── Notes ─── */

function NotesCard({ application: a, onSave }: { application: ApplicationDoc; onSave: (notes: string) => Promise<boolean> }) {
  const [notes, setNotes] = useState(a.review.notes || '');
  useEffect(() => setNotes(a.review.notes || ''), [a.review.notes]);

  return (
    <div
      className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6"
      onBlur={(e) => {
        // Save once focus leaves the card, and only when the text changed.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        if (notes !== (a.review.notes || '')) void onSave(notes);
      }}
    >
      <h3 className="text-base font-bold text-earth-800 mt-0 mb-3">Notes (admin only)</h3>
      <TextArea label="Review notes" value={notes} onChange={setNotes} placeholder="Saved when you click away." />
    </div>
  );
}
