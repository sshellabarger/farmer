'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import type { BoothAssignmentsView, BoothDoc, BoothTextStatus, BoothTextsBlocked, MarketDateBoothViews } from '@/lib/phase4-types';
import type { MarketDateStatusView, ReminderSent } from '@/lib/types';
import { canAccessMarket, useStaffGuard } from '@/components/staff-guard';
import { StatusChip } from '@/components/status-chip';
import { CheckboxField, ConfirmButton, Notice } from '@/components/form';
import { AssignGrid, type AssignOption } from '@/components/booth-grid';
import { AdminShell, EmptyRow, LoadingScreen, TableCard, Td, Th, formatDateLabel, weekdayLabel } from '@/components/admin-shell';

/**
 * Staff check-in timeline for one market date (contract §6.1). Every
 * timestamp shown here comes either straight from the API as a label, or is
 * formatted market-local with `Intl.DateTimeFormat({ timeZone })` — never
 * the browser's own locale/offset APIs, which would render it in the
 * visitor's own timezone instead of the market's.
 *
 * Booth assignments (Phase 4): every date has the panel for the NEXT market
 * (built from this date's check-ins). The first market date of a season also
 * has an "Opening day" panel that assigns the date itself, starting from the
 * seasonal vendors - it is shown first while that market is still ahead.
 */

/** The status response with the Phase 4 fix assignments views (see phase4-types.ts). */
type StatusView = Omit<MarketDateStatusView, 'assignments'> & MarketDateBoothViews;

export default function MarketDateStatusPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <MarketDateStatusRoute />
    </Suspense>
  );
}

function MarketDateStatusRoute() {
  const { ready, isAdmin, user } = useStaffGuard();
  const params = useSearchParams();
  const id = params.get('id') || '';

  const [status, setStatus] = useState<StatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');

  const reload = useCallback(async () => {
    if (!id) return;
    setError('');
    try {
      const s = await api.getMarketDateBoothStatus(id);
      setStatus(s);
    } catch (err: any) {
      setError(err?.message || 'Could not load this market date');
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

  if (!ready) return <LoadingScreen />;
  if (!id) {
    return (
      <AdminShell title="Check-ins">
        <Notice kind="error">No market date id in the URL.</Notice>
      </AdminShell>
    );
  }
  if (loading && !status) return <LoadingScreen label="Loading check-ins…" />;
  if (!status) {
    return (
      <AdminShell title="Check-ins">
        <Notice kind="error">{error || 'Market date not found.'}</Notice>
      </AdminShell>
    );
  }

  const { date, market } = status;
  const canEdit = canAccessMarket(user, market.id);
  const canClose = isAdmin && date.status === 'collecting' && Date.parse(date.end_at) < Date.now() && !date.actions.deadline_processed_at;

  // The season opener assigns itself. Before opening day that panel is the one staff work in, so it comes first;
  // afterwards it is history and the "next market" panel leads.
  const opener = status.opener_assignments ?? null;
  const openerFirst = !!opener && !opener.target_started;
  const openerCard = opener ? (
    <AssignmentsCard
      dateId={date.id}
      timeZone={market.timezone}
      view={opener}
      canEdit={canEdit}
      onReload={reload}
      onError={setError}
      onFlash={flashMsg}
    />
  ) : null;

  return (
    <AdminShell
      title={`${weekdayLabel(date.date)}, ${formatDateLabel(date.date)}`}
      subtitle={
        <>
          {market.name} · <Link href={`/admin/markets/detail?id=${encodeURIComponent(market.id)}`} className="text-green-700">Back to market</Link>
        </>
      }
      actions={<StatusChip status={date.status} />}
    >
      {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}
      {flash && <div className="mb-4"><Notice kind="success">{flash}</Notice></div>}
      {!status.in_window && !date.actions.deadline_processed_at && (
        <div className="mb-4">
          <Notice kind="warning">This date is older than the automatic window — close it by hand.</Notice>
        </div>
      )}

      <div className="space-y-6">
        <TimelineCard status={status} />
        <RecipientsCard
          status={status}
          canEdit={canEdit}
          onResend={async (producerId) => {
            try {
              const r = await api.resendCheckin(date.id, producerId);
              flashMsg(`Link resent — ${r.sms.status}${r.sms.error ? `: ${r.sms.error}` : ''}`);
              await reload();
            } catch (err: any) {
              setError(err?.message || 'Could not resend the link');
            }
          }}
        />
        <ExcludedCard status={status} />
        <DeadlineCard status={status} />
        {openerFirst && openerCard}
        {status.assignments ? (
          <AssignmentsCard
            dateId={date.id}
            timeZone={market.timezone}
            view={status.assignments}
            canEdit={canEdit}
            onReload={reload}
            onError={setError}
            onFlash={flashMsg}
          />
        ) : (
          <Card title="Assignments">
            <p className="text-sm text-earth-400 m-0">Booth assignments are not available from the server yet.</p>
          </Card>
        )}
        {!openerFirst && openerCard}
        <MessagesCard status={status} />
        {canClose && (
          <CloseCard
            onClose={async (notify) => {
              try {
                await api.closeMarketDate(date.id, { notify });
                flashMsg('Date closed');
                await reload();
              } catch (err: any) {
                setError(err?.message || 'Could not close this date');
              }
            }}
          />
        )}
      </div>
    </AdminShell>
  );
}

/* ─── Helpers ─── */

/** Market-local instant, e.g. "Tue, Sep 22, 12:00 PM". Never the viewer's own timezone. */
function formatInstant(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

function offsetLabel(minutes: number): string {
  const days = minutes / 1440;
  if (Number.isInteger(days) && days >= 1) return `${days} day${days === 1 ? '' : 's'} after`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'} after`;
  return `${minutes} min after`;
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'no_phone': return 'no phone number';
    case 'invalid_phone': return 'invalid phone';
    case 'opted_out': return 'opted out';
    case 'inactive_producer': return 'inactive producer';
    default: return reason.replace(/_/g, ' ');
  }
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6">
      <h3 className="text-base font-bold text-earth-800 mb-4 mt-0">{title}</h3>
      {children}
    </div>
  );
}

/* ─── Timeline ─── */

function TimelineCard({ status }: { status: StatusView }) {
  const { date, market, schedule, next_due } = status;
  const tz = market.timezone;

  type Item = { label: string; scheduledAt: string; effectiveAt: string; deferred: boolean; chip: string; note?: string };
  const items: Item[] = [];

  items.push({
    label: 'Check-in text',
    scheduledAt: schedule.checkin_at,
    effectiveAt: schedule.checkin_effective_at,
    deferred: schedule.checkin_at !== schedule.checkin_effective_at,
    chip: date.actions.checkin_sent_at ? 'done' : next_due.action === 'checkin' ? 'pending' : 'pending',
    note: date.actions.checkin_sent_at
      ? `Sent to ${date.actions.checkin_recipients ?? 0} · ${date.actions.checkin_failed ?? 0} failed`
      : undefined,
  });

  const remindersSent = new Map<number, ReminderSent>((date.actions.reminders_sent || []).map((r) => [r.offset_min, r]));
  schedule.reminders.forEach((r) => {
    const sent = remindersSent.get(r.offset_min);
    let chip = 'pending';
    let note: string | undefined;
    if (sent) {
      chip = sent.skipped === 'superseded' ? 'superseded' : 'done';
      note = sent.skipped === 'superseded' ? 'Superseded by a later reminder' : `Sent to ${sent.recipients} · ${sent.failed} failed`;
    } else if (!r.reachable) {
      chip = 'unreachable';
      note = 'Deadline passes before this offset';
    } else if (next_due.action === 'reminder' && next_due.offset_min === r.offset_min) {
      chip = 'pending';
    }
    items.push({
      label: `Reminder (${offsetLabel(r.offset_min)})`,
      scheduledAt: r.at,
      effectiveAt: r.effective_at,
      deferred: r.at !== r.effective_at,
      chip,
      note,
    });
  });

  items.push({
    label: 'Deadline',
    scheduledAt: schedule.deadline_at,
    effectiveAt: schedule.deadline_at,
    deferred: false,
    chip: date.actions.deadline_processed_at ? 'done' : 'pending',
    note: date.actions.deadline_processed_at
      ? `${date.deadline_responded_count ?? 0} of ${date.deadline_recipient_count ?? 0} responded`
      : undefined,
  });

  items.push({
    label: 'Staff summary',
    scheduledAt: schedule.deadline_at,
    effectiveAt: schedule.summary_effective_at,
    deferred: schedule.deadline_at !== schedule.summary_effective_at,
    chip: date.actions.summary_sent_at ? 'done' : date.actions.summary_skipped ? 'unreachable' : 'pending',
    note: date.actions.summary_sent_at
      ? 'Sent'
      : date.actions.summary_skipped === 'no_recipients'
        ? 'Skipped — no recipients'
        : date.actions.summary_skipped === 'notify_false'
          ? 'Skipped — closed without notifying staff'
          : undefined,
  });

  return (
    <Card title="Timeline">
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 rounded-xl border border-earth-100 bg-earth-15 px-3 py-2.5">
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm text-earth-800">{item.label}</div>
              <div className="text-[12px] text-text-muted">
                Scheduled {formatInstant(item.scheduledAt, tz)}
                {item.deferred && <> · effective {formatInstant(item.effectiveAt, tz)} (deferred by quiet hours)</>}
              </div>
              {item.note && <div className="text-[12px] text-text-soft mt-0.5">{item.note}</div>}
            </div>
            <StatusChip status={item.chip} />
          </div>
        ))}
        {next_due.action !== 'none' && (
          <p className="text-xs text-earth-500 mt-2 mb-0">
            Next due: {next_due.action}{next_due.offset_min !== undefined ? ` (${offsetLabel(next_due.offset_min)})` : ''}
            {next_due.at ? ` at ${formatInstant(next_due.at, tz)}` : ''}
          </p>
        )}
      </div>
    </Card>
  );
}

/* ─── Recipients ─── */

function RecipientsCard({
  status,
  canEdit,
  onResend,
}: {
  status: StatusView;
  canEdit: boolean;
  onResend: (producerId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const tz = status.market.timezone;

  const respondedChip = (r: StatusView['recipients'][number]) => {
    if (!r.responded) return 'no_response';
    return r.late ? 'late' : 'responded';
  };

  return (
    <Card title={`Recipients (${status.counts.recipients})`}>
      <TableCard minWidth={860}>
        <thead>
          <tr className="border-b border-border-light">
            <Th>Producer</Th>
            <Th>Phone</Th>
            <Th>Responded</Th>
            <Th>Submitted</Th>
            <Th>Attending next</Th>
            <Th>Link sent</Th>
            <Th>Reminders</Th>
            {canEdit && <Th />}
          </tr>
        </thead>
        <tbody>
          {status.recipients.length === 0 ? (
            <EmptyRow colSpan={canEdit ? 8 : 7}>No eligible recipients for this date.</EmptyRow>
          ) : (
            status.recipients.map((r) => (
              <tr key={r.producer_id} className="border-b border-border-light last:border-none">
                <Td>
                  <Link href={`/admin/producers/detail?id=${encodeURIComponent(r.producer_id)}`} className="font-semibold text-green-700 no-underline hover:underline">
                    {r.business_name}
                  </Link>
                </Td>
                <Td><span className="font-mono text-[12px]">{r.phone}</span></Td>
                <Td><StatusChip status={respondedChip(r)} /></Td>
                <Td><span className="text-[12px]">{r.checkin ? formatInstant(r.checkin.submitted_at, tz) : '—'}</span></Td>
                <Td>{r.checkin ? (r.checkin.attending_next === null ? '—' : r.checkin.attending_next ? 'Yes' : 'No') : '—'}</Td>
                <Td>
                  <span className="text-[12px]">{r.link_sends} sent</span>
                  {r.last_status && <div><StatusChip status={r.last_status} /></div>}
                </Td>
                <Td><span className="text-[12px]">{r.reminders_sent}</span></Td>
                {canEdit && (
                  <Td className="text-right">
                    <ConfirmButton
                      label="Resend check-in link"
                      confirmLabel="Resend"
                      danger={false}
                      busy={busy === r.producer_id}
                      onConfirm={async () => {
                        setBusy(r.producer_id);
                        await onResend(r.producer_id);
                        setBusy(null);
                      }}
                    />
                  </Td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </TableCard>
    </Card>
  );
}

/* ─── Excluded ─── */

function ExcludedCard({ status }: { status: StatusView }) {
  return (
    <Card title={`Excluded (${status.counts.excluded})`}>
      <TableCard minWidth={480}>
        <thead>
          <tr className="border-b border-border-light">
            <Th>Producer</Th>
            <Th>Reason</Th>
          </tr>
        </thead>
        <tbody>
          {status.excluded.length === 0 ? (
            <EmptyRow colSpan={2}>Every active producer has a usable phone number.</EmptyRow>
          ) : (
            status.excluded.map((e) => (
              <tr key={e.producer_id} className="border-b border-border-light last:border-none">
                <Td>
                  <Link href={`/admin/producers/detail?id=${encodeURIComponent(e.producer_id)}`} className="font-semibold text-green-700 no-underline hover:underline">
                    {e.business_name}
                  </Link>
                </Td>
                <Td>{reasonLabel(e.reason)}</Td>
              </tr>
            ))
          )}
        </tbody>
      </TableCard>
    </Card>
  );
}

/* ─── After the deadline ─── */

function DeadlineCard({ status }: { status: StatusView }) {
  const { date } = status;
  if (!date.actions.deadline_processed_at) {
    return (
      <Card title="After the deadline">
        <p className="text-sm text-earth-400 m-0">The deadline has not been processed yet.</p>
      </Card>
    );
  }
  const nonResponders = date.non_responders || [];
  const spotNotHeld = date.spot_not_held || [];
  const nameOf = (producerId: string) => status.recipients.find((r) => r.producer_id === producerId)?.business_name || producerId;

  return (
    <Card title="After the deadline">
      <p className="text-sm text-earth-700 mt-0 mb-3">
        {date.deadline_responded_count ?? 0} of {date.deadline_recipient_count ?? 0} responded.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="text-xs font-semibold text-earth-500 mb-1.5">No response</div>
          {nonResponders.length === 0 ? (
            <p className="text-sm text-earth-400 m-0">Everyone responded.</p>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-wrap gap-1.5">
              {nonResponders.map((id) => (
                <li key={id}>
                  <Link href={`/admin/producers/detail?id=${encodeURIComponent(id)}`} className="no-underline">
                    <StatusChip status="no_response" title={nameOf(id)} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="text-xs font-semibold text-earth-500 mb-1.5">Spot not held</div>
          {spotNotHeld.length === 0 ? (
            <p className="text-sm text-earth-400 m-0">Every spot is held.</p>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-wrap gap-1.5">
              {spotNotHeld.map((id) => (
                <li key={id}>
                  <Link href={`/admin/producers/detail?id=${encodeURIComponent(id)}`} className="no-underline">
                    <StatusChip status="spot_not_held" title={nameOf(id)} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ─── Assignments (Phase 4: booth drafts, approval and booth texts) ─── */

const UNASSIGNED_REASON: Record<string, string> = {
  no_power_stall: 'no powered stall is free',
  no_pair: 'second space not available (no free neighbouring booth)',
  full: 'every booth is taken',
  no_food_truck_slot: 'no food truck slot',
  not_placed: 'not placed yet - a booth is free',
};

const SKIPPED_REASON: Record<string, string> = {
  no_next_date: 'there is no later market date to assign',
  no_booths: 'the market has no active booths yet',
  no_attendees: 'nobody checked in as attending',
};

const CAN_ADD_REASON: Record<string, string> = {
  not_attending: 'said not attending',
  no_answer: 'no answer',
  daily_plan: 'daily plan',
};

const BLOCKED_TEXT: Record<BoothTextsBlocked, string> = {
  conflict: 'Booth texts are on hold: two vendors share a booth. Nobody is texted until that is fixed.',
  cancelled: 'Booth texts are on hold: the market these booths are for was cancelled. Nothing is sent for a cancelled date.',
  started: 'No booth texts are sent any more: the market these booths are for has already started.',
};

const TEXT_STATUS_LABEL: Record<BoothTextStatus, string> = {
  none: 'not approved',
  pending: 'pending',
  sent: 'sent',
  failed: 'failed',
  blocked: 'on hold',
  excluded: 'cannot be texted',
  skipped: 'not sent',
};

const TEXT_STATUS_COLOR: Record<BoothTextStatus, { bg: string; text: string }> = {
  none: { bg: '#F3F4F6', text: '#6B7280' },
  pending: { bg: '#DBEAFE', text: '#1E40AF' },
  sent: { bg: '#D1FAE5', text: '#065F46' },
  failed: { bg: '#FEE2E2', text: '#991B1B' },
  blocked: { bg: '#FEF3C7', text: '#92400E' },
  excluded: { bg: '#F3F4F6', text: '#6B7280' },
  skipped: { bg: '#FEF3C7', text: '#92400E' },
};

function TextStatusChip({ status }: { status: BoothTextStatus }) {
  const c = TEXT_STATUS_COLOR[status];
  return (
    <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap" style={{ background: c.bg, color: c.text }}>
      {TEXT_STATUS_LABEL[status]}
    </span>
  );
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function AssignmentsCard({
  dateId,
  timeZone,
  view: a,
  canEdit,
  onReload,
  onError,
  onFlash,
}: {
  dateId: string;
  timeZone: string;
  view: BoothAssignmentsView;
  canEdit: boolean;
  onReload: () => Promise<void>;
  onError: (msg: string) => void;
  onFlash: (msg: string) => void;
}) {
  const tz = timeZone;
  const cycle = a.cycle;
  const isOpener = cycle === 'opener';
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState<string | null>(null);
  const [pending, setPending] = useState<{ boothId: string; producerId: string; secondId: string } | null>(null);
  /** After approval a change is confirmed first: the vendors it touches are texted. */
  const [confirm, setConfirm] = useState<{ producer_id: string; booth_ids: string[] }[] | null>(null);

  const boothById = new Map(a.booths.map((b) => [b.booth.id, b]));
  const heldBy = (producerId: string): string[] => a.booths.filter((b) => b.assignment?.producer_id === producerId).map((b) => b.booth.id);
  const labelOf = (id: string) => boothById.get(id)?.booth.label || id;
  const vendors = new Map<string, { business_name: string; spaces: 1 | 2 }>();
  for (const v of a.attending) vendors.set(v.producer_id, v);
  for (const v of a.can_add) vendors.set(v.producer_id, v);
  for (const b of a.booths) {
    if (b.assignment && !vendors.has(b.assignment.producer_id)) vendors.set(b.assignment.producer_id, { business_name: b.assignment.business_name, spaces: 1 });
  }
  const nameOf = (producerId: string) => vendors.get(producerId)?.business_name || producerId;

  const assignedVendors = new Set(a.booths.filter((b) => b.assignment).map((b) => b.assignment!.producer_id));
  const approved = !!a.approved_at;
  const drafted = !!a.drafted_at;
  const hasDraft = !!a.assignments_draft_at;
  // Changes stay open after approval and after the texts went out, until the market they are for has started.
  const editsLocked = !canEdit || !hasDraft || (approved && a.target_started);
  const canDraft = canEdit && !approved && a.target_date !== null && !a.target_started && a.draft_open;
  const addedByStaff = a.attending.filter((v) => v.added_by_staff);

  // Everyone on the list, then everyone staff may add by hand.
  const options: AssignOption[] = [
    ...a.attending.map((v) => ({
      producer_id: v.producer_id,
      business_name: v.added_by_staff ? `${v.business_name} (added by staff)` : v.business_name,
      spaces: v.spaces,
      held: heldBy(v.producer_id).map(labelOf),
    })),
    ...a.can_add.map((v) => ({
      producer_id: v.producer_id,
      business_name: `+ ${v.business_name} (${CAN_ADD_REASON[v.reason] || v.reason.replace(/_/g, ' ')})`,
      spaces: v.spaces,
      held: [] as string[],
    })),
  ];

  const fail = (err: any, fallback: string) => onError(err?.message || fallback);

  const draft = async () => {
    setBusy(true);
    try {
      const res = await api.draftBoothAssignments(dateId, { cycle, redraft: drafted });
      await onReload();
      const warned = res.draft.warnings.length;
      onFlash(`${drafted ? 'Assignments redrafted' : 'Assignments drafted'}${warned ? ` - ${warned} vendor${warned === 1 ? '' : 's'} to look at (power)` : ''}`);
    } catch (err: any) {
      fail(err, 'Could not draft assignments');
    } finally {
      setBusy(false);
    }
  };

  const save = async (changes: { producer_id: string; booth_ids: string[] }[]) => {
    setBusy(true);
    try {
      const res = await api.updateBoothAssignments(dateId, { cycle, changes });
      await onReload();
      onFlash(
        res.warning === 'approved'
          ? 'Saved. Each vendor whose booth changed is texted on the next engine run (outside quiet hours).'
          : 'Assignments saved',
      );
    } catch (err: any) {
      fail(err, 'Could not save the change');
      await onReload();
    } finally {
      setBusy(false);
    }
  };

  /** Turn "these producers should now hold exactly these booths" into the PATCH changes; after approval, ask first. */
  const send = async (moves: Map<string, string[]>) => {
    const changes = Array.from(moves.entries())
      .filter(([pid, ids]) => {
        const before = heldBy(pid);
        return before.length !== ids.length || before.some((id) => !ids.includes(id));
      })
      .map(([producer_id, booth_ids]) => ({ producer_id, booth_ids }));
    if (changes.length === 0) return;
    if (approved) {
      setConfirm(changes);
      return;
    }
    await save(changes);
  };

  /** Place `producerId` ('' to empty the booth) on `boothId`, plus an optional second booth. */
  const place = async (boothId: string, producerId: string, secondId?: string) => {
    const moves = new Map<string, string[]>();
    const take = (id: string) => {
      // Whoever holds the booth now loses it (in the same change, so it is never double booked).
      const holder = boothById.get(id)?.assignment?.producer_id;
      if (holder && holder !== producerId) {
        const current = moves.get(holder) ?? heldBy(holder);
        moves.set(holder, current.filter((x) => x !== id));
      }
    };
    take(boothId);
    if (secondId) take(secondId);
    if (producerId) moves.set(producerId, secondId ? [boothId, secondId] : [boothId]);
    await send(moves);
  };

  const onSelect = (booth: BoothDoc, producerId: string) => {
    if (!producerId) {
      void place(booth.id, '');
      return;
    }
    const v = vendors.get(producerId);
    if (v && v.spaces === 2) {
      // A two-space vendor needs a second booth: default to the free neighbour in the row.
      const row = a.booths.filter((b) => b.booth.row === booth.row && b.booth.id !== booth.id && b.booth.active).sort((x, y) => x.booth.order - y.booth.order);
      const neighbours = row.filter((b) => Math.abs(b.booth.order - booth.order) === 1);
      const free = neighbours.find((b) => !b.assignment || b.assignment.producer_id === producerId) ?? neighbours[0] ?? row[0];
      setPending({ boothId: booth.id, producerId, secondId: free?.booth.id ?? '' });
      return;
    }
    void place(booth.id, producerId);
  };

  const approve = async () => {
    setBusy(true);
    try {
      const res = await api.approveBoothAssignments(dateId, { cycle });
      await onReload();
      const t = res.texts;
      if (t.deferred_until) onFlash(`Approved. Booth texts wait for quiet hours to end: ${formatInstant(t.deferred_until, tz)}.`);
      else if (t.attempted) onFlash(`Approved. Texts: ${t.sent} sent, ${t.failed} failed, ${t.excluded} not texted.`);
      else onFlash('Approved.');
    } catch (err: any) {
      fail(err, 'Could not approve the assignments');
    } finally {
      setBusy(false);
    }
  };

  const resend = async (producerId: string) => {
    setResending(producerId);
    try {
      const res = await api.resendBoothText(dateId, producerId, cycle);
      await onReload();
      onFlash(`Booth text resent - ${res.sms.status}${res.sms.error ? `: ${res.sms.error}` : ''}`);
    } catch (err: any) {
      fail(err, 'Could not resend the booth text');
    } finally {
      setResending(null);
    }
  };

  const textStatus = (): string => {
    if (!approved) return 'Not approved. No booth texts have gone out.';
    if (a.booth_texts_blocked) return BLOCKED_TEXT[a.booth_texts_blocked];
    if (a.booth_texts_due_at) {
      if (a.booth_texts_too_late) return 'Quiet hours end when this market starts, so the texts still owed will NOT be sent. Please call those vendors.';
      if (Date.parse(a.booth_texts_due_at) > Date.now()) return `Booth texts wait for quiet hours to end: ${formatInstant(a.booth_texts_due_at, tz)}.`;
      return 'Booth texts go out on the next engine run (within a few minutes).';
    }
    const c = a.text_counts;
    const parts = [`${c.sent} sent`];
    if (c.failed) parts.push(`${c.failed} failed`);
    if (c.excluded) parts.push(`${c.excluded} cannot be texted`);
    if (c.skipped) parts.push(`${c.skipped} not sent`);
    return `${a.booth_texts_sent_at ? `Booth texts went out ${formatInstant(a.booth_texts_sent_at, tz)}` : 'Booth texts'}: ${parts.join(', ')}.`;
  };

  const secondChoices = pending
    ? a.booths.filter((b) => b.booth.active && b.booth.id !== pending.boothId && boothById.get(pending.boothId)?.booth.row === b.booth.row)
    : [];

  const targetLabel = a.target_date ? a.target_date.date_label : '';

  return (
    <Card title={isOpener ? 'Opening day assignments' : 'Assignments'}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <div className="text-sm font-semibold text-earth-800">
            {a.target_date ? <>{isOpener ? 'Booths for opening day, ' : 'Booths for '}{targetLabel}</> : 'No later market date to assign'}
            <span className="text-text-muted font-normal"> - season {a.season}</span>
          </div>
          <div className="text-xs text-earth-500 mt-0.5">
            {isOpener
              ? 'Opening day: the list starts from seasonal vendors. Add daily-plan vendors by hand. '
              : 'Built from the vendors who said they are attending next. Anyone else in this season can be added by hand. '}
            {a.assignments_draft_at ? `Drafted ${formatInstant(a.assignments_draft_at, tz)}.` : drafted ? 'Drafting ran but placed no one.' : isOpener ? 'Not drafted yet - press Draft to start.' : 'Not drafted yet.'}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {approved && <StatusChip status="approved" />}
          {a.booth_texts_sent_at && <StatusChip status="sent" />}
          {canDraft &&
            (hasDraft ? (
              <ConfirmButton
                label="Redraft"
                confirmLabel="Redraft (keeps manual moves)"
                danger={false}
                busy={busy}
                onConfirm={draft}
              />
            ) : (
              <button
                type="button"
                onClick={draft}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border disabled:opacity-40"
                style={{ borderColor: '#E4DFD3', color: '#21512C', background: '#fff' }}
              >
                {busy ? 'Working...' : 'Draft assignments'}
              </button>
            ))}
          {canEdit && !approved && hasDraft && (
            <ConfirmButton
              label="Approve..."
              confirmLabel={`Approve and text ${assignedVendors.size} vendor${assignedVendors.size === 1 ? '' : 's'} their booth?`}
              danger={false}
              busy={busy}
              disabled={a.summary.conflicts > 0 || assignedVendors.size === 0 || a.target_cancelled || a.target_started}
              onConfirm={approve}
            />
          )}
        </div>
      </div>

      {a.drafts_skipped && !hasDraft && (
        <div className="mb-3"><Notice kind="warning">Drafting was skipped: {SKIPPED_REASON[a.drafts_skipped] || a.drafts_skipped.replace(/_/g, ' ')}.{a.drafts_skipped === 'no_attendees' ? ' Press Draft to start an empty list and add vendors by hand.' : ''}</Notice></div>
      )}
      {a.target_cancelled && !approved && (
        <div className="mb-3">
          <Notice kind="warning">
            {isOpener
              ? 'This market date was cancelled, so its assignments cannot be approved.'
              : `The market these booths are for (${targetLabel}) was cancelled. Redraft to assign the next market date instead.`}
          </Notice>
        </div>
      )}
      {a.target_started && !approved && hasDraft && (
        <div className="mb-3"><Notice kind="warning">The market these booths are for has already started, so they can no longer be approved or texted.</Notice></div>
      )}
      {a.summary.conflicts > 0 && (
        <div className="mb-3">
          <Notice kind="error">
            {a.summary.conflicts} booth{a.summary.conflicts === 1 ? ' is' : 's are'} double booked:{' '}
            {a.conflicts.map((c) => `${c.booth_label} (${c.producers.map((p) => p.business_name).join(' and ')})`).join('; ')}.{' '}
            {approved ? 'No booth text goes out until this is fixed.' : 'Fix this before approving.'} Give one of them another booth; the grid shows
            only one vendor per booth.
          </Notice>
        </div>
      )}
      {approved && a.booth_texts_blocked && a.booth_texts_blocked !== 'conflict' && (
        <div className="mb-3"><Notice kind="warning">{BLOCKED_TEXT[a.booth_texts_blocked]}</Notice></div>
      )}
      {approved && !a.booth_texts_blocked && a.booth_texts_too_late && (
        <div className="mb-3"><Notice kind="error">Quiet hours end when this market starts, so the booth texts still owed will NOT be sent. Please call those vendors.</Notice></div>
      )}
      {approved && canEdit && !a.target_started && (
        <div className="mb-3">
          <Notice kind="info">
            These assignments are approved. You can still change them: each vendor whose booth changes is texted the new booth once, and a vendor you
            remove is told they no longer have one. Texts go out on the next engine run, never during quiet hours.
          </Notice>
        </div>
      )}
      {approved && a.target_started && (
        <div className="mb-3"><Notice kind="info">This market has started, so its assignments are locked.</Notice></div>
      )}
      {a.warnings.length > 0 && (
        <div className="mb-3">
          <Notice kind="warning">
            Needs electricity but holds no powered booth:{' '}
            {a.warnings.map((w, i) => (
              <span key={w.producer_id}>
                {i > 0 ? '; ' : ''}
                {w.business_name} ({joinLabels(w.booth_ids.map(labelOf))})
              </span>
            ))}
            . The vendor was left where they usually stand - move them if they need a powered stall.
          </Notice>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4 text-xs">
        <span className="px-2 py-1 rounded-full bg-earth-50 border border-earth-100">{assignedVendors.size} vendor{assignedVendors.size === 1 ? '' : 's'} placed</span>
        <span className="px-2 py-1 rounded-full bg-earth-50 border border-earth-100">{a.summary.unassigned} unplaced</span>
        <span className="px-2 py-1 rounded-full bg-earth-50 border border-earth-100">{a.summary.booths_free} of {a.summary.booths_total} booths free</span>
        {addedByStaff.length > 0 && (
          <span className="px-2 py-1 rounded-full bg-earth-50 border border-earth-100">{addedByStaff.length} added by staff</span>
        )}
      </div>

      {pending && (
        <div className="mb-4 p-3 rounded-xl border border-earth-100 bg-earth-15 max-w-xl space-y-3">
          <div className="text-sm font-semibold text-earth-800">
            {nameOf(pending.producerId)} has two spaces. Second space next to {labelOf(pending.boothId)}:
          </div>
          <select
            value={pending.secondId}
            onChange={(e) => setPending({ ...pending, secondId: e.target.value })}
            className="w-full px-3 py-2 border border-earth-200 rounded-xl text-sm bg-white"
            aria-label="Second space"
          >
            {secondChoices.map((b) => (
              <option key={b.booth.id} value={b.booth.id}>
                {b.booth.label}
                {b.assignment && b.assignment.producer_id !== pending.producerId ? ` - now ${b.assignment.business_name}` : ''}
              </option>
            ))}
          </select>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setPending(null)} className="px-3 py-1.5 rounded-xl text-xs font-semibold border border-earth-200 bg-white text-earth-700 cursor-pointer">Cancel</button>
            <button
              type="button"
              disabled={!pending.secondId || busy}
              onClick={async () => {
                const p = pending;
                setPending(null);
                await place(p.boothId, p.producerId, p.secondId);
              }}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold text-white border-none cursor-pointer disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #21512C, #3D7A47)' }}
            >
              Place both spaces
            </button>
          </div>
        </div>
      )}

      {confirm && (
        <div className="mb-4 p-3 rounded-xl border border-amber-200 bg-amber-50 max-w-xl space-y-3" role="alertdialog" aria-label="Confirm the change">
          <div className="text-sm font-semibold text-earth-800">These assignments are approved. Save this change and text the vendor?</div>
          <ul className="m-0 pl-4 text-sm text-earth-700 space-y-1">
            {confirm.map((c) => (
              <li key={c.producer_id}>
                <span className="font-semibold">{nameOf(c.producer_id)}</span>{' '}
                {c.booth_ids.length > 0
                  ? `will be texted the new booth: ${joinLabels(c.booth_ids.map(labelOf))}.`
                  : 'will be texted that they no longer have a booth for this date (if they were already told one).'}
              </li>
            ))}
          </ul>
          <p className="text-xs text-earth-500 m-0">Texts go out on the next engine run, never during quiet hours. A vendor who cannot be texted is listed below.</p>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setConfirm(null)} className="px-3 py-1.5 rounded-xl text-xs font-semibold border border-earth-200 bg-white text-earth-700 cursor-pointer">Cancel</button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const changes = confirm;
                setConfirm(null);
                await save(changes);
              }}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold text-white border-none cursor-pointer disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #21512C, #3D7A47)' }}
            >
              Save and text
            </button>
          </div>
        </div>
      )}

      <AssignGrid booths={a.booths} options={options} disabled={editsLocked || busy || confirm !== null} onSelect={onSelect} />
      {canEdit && !hasDraft && a.target_date && (
        <p className="text-xs text-earth-500 mt-2 mb-0">
          {a.draft_open
            ? 'Draft the assignments first; then any booth can be changed, and any vendor of this season added, from the lists above.'
            : 'This market has not happened yet. After it, its check-ins decide who is assigned for the next market; the draft opens then.'}
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-5">
        <div>
          <div className="text-xs font-semibold text-earth-500 mb-1.5">Not placed ({a.unassigned.length})</div>
          {a.unassigned.length === 0 ? (
            <p className="text-sm text-earth-400 m-0">Everyone on the list has a booth.</p>
          ) : (
            <ul className="m-0 p-0 list-none space-y-1">
              {a.unassigned.map((u, i) => (
                <li key={`${u.producer_id}-${i}`} className="text-sm">
                  <Link href={`/admin/producers/detail?id=${encodeURIComponent(u.producer_id)}`} className="font-semibold text-green-700 no-underline hover:underline">{u.business_name}</Link>
                  <span className="text-text-muted text-xs"> - {UNASSIGNED_REASON[u.reason] || u.reason.replace(/_/g, ' ')}</span>
                </li>
              ))}
            </ul>
          )}
          {addedByStaff.length > 0 && (
            <>
              <div className="text-xs font-semibold text-earth-500 mb-1.5 mt-3">Added by staff ({addedByStaff.length})</div>
              <ul className="m-0 p-0 list-none space-y-1">
                {addedByStaff.map((v) => (
                  <li key={v.producer_id} className="text-sm">
                    <Link href={`/admin/producers/detail?id=${encodeURIComponent(v.producer_id)}`} className="text-green-700 no-underline hover:underline">{v.business_name}</Link>
                    <span className="text-text-muted text-xs"> - {joinLabels(v.booth_ids.map(labelOf)) || 'no booth'}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        {isOpener ? (
          <div className="sm:col-span-2">
            <div className="text-xs font-semibold text-earth-500 mb-1.5">Not on the list - add by hand ({a.can_add.length})</div>
            {a.can_add.length === 0 ? (
              <p className="text-sm text-earth-400 m-0">Every active vendor of this season is on the list.</p>
            ) : (
              <ul className="m-0 p-0 list-none space-y-1">
                {a.can_add.map((u) => (
                  <li key={u.producer_id} className="text-sm">
                    <Link href={`/admin/producers/detail?id=${encodeURIComponent(u.producer_id)}`} className="text-green-700 no-underline hover:underline">{u.business_name}</Link>
                    <span className="text-text-muted text-xs"> - {CAN_ADD_REASON[u.reason] || u.reason.replace(/_/g, ' ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <>
            <div>
              <div className="text-xs font-semibold text-earth-500 mb-1.5">Not attending ({a.not_attending.length})</div>
              {a.not_attending.length === 0 ? (
                <p className="text-sm text-earth-400 m-0">Nobody.</p>
              ) : (
                <ul className="m-0 p-0 list-none space-y-1">
                  {a.not_attending.map((u) => (
                    <li key={u.producer_id} className="text-sm">
                      <Link href={`/admin/producers/detail?id=${encodeURIComponent(u.producer_id)}`} className="text-green-700 no-underline hover:underline">{u.business_name}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="text-xs font-semibold text-earth-500 mb-1.5">No answer ({a.no_answer.length})</div>
              {a.no_answer.length === 0 ? (
                <p className="text-sm text-earth-400 m-0">Everyone answered.</p>
              ) : (
                <ul className="m-0 p-0 list-none space-y-1">
                  {a.no_answer.map((u) => (
                    <li key={u.producer_id} className="text-sm">
                      <Link href={`/admin/producers/detail?id=${encodeURIComponent(u.producer_id)}`} className="text-green-700 no-underline hover:underline">{u.business_name}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      <div className="mt-5 pt-4 border-t border-earth-100">
        <div className="text-xs font-semibold text-earth-500 mb-1.5">Booth texts</div>
        <p className="text-sm text-earth-700 m-0 mb-3">{textStatus()}</p>
        {approved && a.texts.length > 0 && (
          <TableCard minWidth={640}>
            <thead>
              <tr className="border-b border-border-light">
                <Th>Vendor</Th>
                <Th>Text</Th>
                <Th>Status</Th>
                <Th>Last sent</Th>
                {canEdit && <Th />}
              </tr>
            </thead>
            <tbody>
              {a.texts.map((t) => (
                <tr key={t.producer_id} className="border-b border-border-light last:border-none">
                  <Td>
                    <Link href={`/admin/producers/detail?id=${encodeURIComponent(t.producer_id)}`} className="font-semibold text-green-700 no-underline hover:underline">
                      {t.business_name}
                    </Link>
                  </Td>
                  <Td>
                    <span className="text-[12px]">
                      {t.type === 'release' ? `No booth any more (was ${joinLabels(t.booth_labels) || 'assigned'})` : `Booth ${joinLabels(t.booth_labels)}`}
                    </span>
                  </Td>
                  <Td>
                    <TextStatusChip status={t.status} />
                    {t.status === 'excluded' && t.reason && <div className="text-[11px] text-text-muted mt-0.5">{reasonLabel(t.reason)}</div>}
                    {t.status === 'skipped' && <div className="text-[11px] text-text-muted mt-0.5">could not be texted earlier - resend</div>}
                  </Td>
                  <Td><span className="text-[12px]">{t.last_message ? formatInstant(t.last_message.created_at, tz) : '—'}</span></Td>
                  {canEdit && (
                    <Td className="text-right">
                      {t.can_resend && (
                        <ConfirmButton
                          label="Resend"
                          confirmLabel="Send this text again"
                          danger={false}
                          busy={resending === t.producer_id}
                          onConfirm={() => resend(t.producer_id)}
                        />
                      )}
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </TableCard>
        )}
        {a.messages.length > 0 && (
          <details className="mt-3">
            <summary className="text-xs font-semibold text-earth-500 cursor-pointer">Every booth text sent for this date ({a.messages.length})</summary>
            <div className="mt-2">
              <TableCard minWidth={560}>
                <thead>
                  <tr className="border-b border-border-light">
                    <Th>To</Th>
                    <Th>Text</Th>
                    <Th>Status</Th>
                    <Th>When</Th>
                  </tr>
                </thead>
                <tbody>
                  {a.messages.map((m) => (
                    <tr key={m.id} className="border-b border-border-light last:border-none">
                      <Td><span className="font-mono text-[12px]">{m.to}</span></Td>
                      <Td><span className="text-[12px]">{m.type === 'release' ? 'Release notice' : `Booth ${joinLabels(m.booth_labels)}`}</span></Td>
                      <Td><StatusChip status={m.status} /></Td>
                      <Td><span className="text-[12px]">{formatInstant(m.created_at, tz)}</span></Td>
                    </tr>
                  ))}
                </tbody>
              </TableCard>
            </div>
          </details>
        )}
      </div>
    </Card>
  );
}

/* ─── Messages ─── */

function MessagesCard({ status }: { status: StatusView }) {
  const tz = status.market.timezone;
  return (
    <Card title={`Messages (${status.messages.length})`}>
      <TableCard minWidth={640}>
        <thead>
          <tr className="border-b border-border-light">
            <Th>Kind</Th>
            <Th>To</Th>
            <Th>Status</Th>
            <Th>When</Th>
          </tr>
        </thead>
        <tbody>
          {status.messages.length === 0 ? (
            <EmptyRow colSpan={4}>No messages yet for this date.</EmptyRow>
          ) : (
            status.messages.map((m) => (
              <tr key={m.id} className="border-b border-border-light last:border-none">
                <Td><span className="text-[12px]">{m.kind.replace(/_/g, ' ')}</span></Td>
                <Td><span className="font-mono text-[12px]">{m.to}</span></Td>
                <Td><StatusChip status={m.status} /></Td>
                <Td><span className="text-[12px]">{formatInstant(m.created_at, tz)}</span></Td>
              </tr>
            ))
          )}
        </tbody>
      </TableCard>
    </Card>
  );
}

/* ─── Close date ─── */

function CloseCard({ onClose }: { onClose: (notify: boolean) => Promise<void> }) {
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);

  return (
    <Card title="Close date">
      <p className="text-xs text-earth-500 mt-0 mb-3">
        Processes the deadline by hand: records non-responders and spots not held. Use this for a date the automatic
        window has already passed.
      </p>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <CheckboxField label="Text the summary to staff" checked={notify} onChange={setNotify} />
        <ConfirmButton
          label="Close date"
          confirmLabel="Close this date"
          busy={busy}
          onConfirm={async () => {
            setBusy(true);
            await onClose(notify);
            setBusy(false);
          }}
        />
      </div>
    </Card>
  );
}
