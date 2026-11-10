'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import type { BoothDoc, InsuranceCalendarDate, ProductEntry } from '@/lib/phase4-types';
import {
  MEMBERSHIP_TRANSITIONS,
  type Checkin,
  type FeePlan,
  type InsuranceStatus,
  type Market,
  type Membership,
  type MembershipStatus,
  type Producer,
} from '@/lib/types';
import { canAccessMarket, useStaffGuard } from '@/components/staff-guard';
import { StatusChip } from '@/components/status-chip';
import { CheckboxField, ConfirmButton, DateField, Field, ListEditor, Notice, PrimaryButton, SaveBar, SecondaryButton, SelectField, TextArea } from '@/components/form';
import { AdminShell, EmptyRow, LoadingScreen, TableCard, Td, Th, formatStamp } from '@/components/admin-shell';
import { normalizePhone } from '@/lib/phone';

export default function ProducerDetailPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <ProducerDetail />
    </Suspense>
  );
}

/** Phase 2 stored weekly / season / both; the API now speaks seasonal / daily. Accept either. */
function planOf(raw: string): FeePlan {
  return raw === 'seasonal' || raw === 'season' || raw === 'both' ? 'seasonal' : 'daily';
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

interface InviteOutcome {
  marketId: string;
  url: string;
  email: string;
  sms: string;
  /** An earlier invitation had its missing text or email sent now. */
  completed: boolean;
  quietUntil: string | null;
}

/** A text outcome in plain words; a text held for the market's quiet hours says until when. */
function textOutcome(status: string, quietUntil?: string | null): string {
  if (status === 'skipped_quiet_hours') return `held for quiet hours${quietUntil ? ` until ${formatStamp(quietUntil)}` : ''}`;
  return status.replace(/_/g, ' ');
}

function ProducerDetail() {
  const { ready, isAdmin, user } = useStaffGuard();
  const params = useSearchParams();
  const id = params.get('id') || '';

  const [producer, setProducer] = useState<Producer | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [seasonByMarket, setSeasonByMarket] = useState<Record<string, string>>({});
  const [invite, setInvite] = useState<{ token_url: string; sent_at: string } | null>(null);
  const [summary, setSummary] = useState<{ count: number; last_submitted_at: string | null } | null>(null);
  const [checkins, setCheckins] = useState<Checkin[]>([]);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [booths, setBooths] = useState<Record<string, BoothDoc[]>>({});
  /** Market ids where this producer already has a live application this season. */
  const [appliedMarkets, setAppliedMarkets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [inviteOutcome, setInviteOutcome] = useState<InviteOutcome | null>(null);
  const [inviteConflict, setInviteConflict] = useState<{ marketId: string; quietUntil: string | null } | null>(null);
  const [inviting, setInviting] = useState(false);

  const reload = useCallback(async () => {
    if (!id) return;
    setError('');
    try {
      const [p, m, c, mk] = await Promise.all([
        api.getProducer(id),
        api.getMemberships({ producer_id: id }).catch(() => ({ memberships: [] })),
        api.getCheckins({ producer_id: id }).catch(() => ({ checkins: [] })),
        api.getMarkets().catch(() => ({ markets: [] as Market[] })),
      ]);
      setProducer(p.producer);
      setSummary(p.checkins_summary);
      setSeasonByMarket(p.current_season_by_market || {});
      setInvite(p.invite ?? null);
      // Prefer the memberships endpoint (scoped per role); fall back to the
      // producer payload's list.
      const all = (m.memberships && m.memberships.length > 0 ? m.memberships : p.memberships) || [];
      setMemberships(all);
      setCheckins([...(c.checkins || [])].sort((a, b) => b.submitted_at.localeCompare(a.submitted_at)));
      setMarkets([...(mk.markets || [])].sort((a, b) => a.name.localeCompare(b.name)));

      // Booths per market the producer belongs to (for the usual-booth select).
      const marketIds = Array.from(new Set(all.map((x) => x.market_id)));
      const entries = await Promise.all(
        marketIds.map(async (mid) => [mid, (await api.getBooths(mid).catch(() => ({ booths: [] as BoothDoc[] }))).booths || []] as const),
      );
      setBooths(Object.fromEntries(entries));

      // Admins: which markets already have a live application from this producer this season.
      if (user?.role === 'admin') {
        const live: string[] = [];
        await Promise.all(
          marketIds.map(async (mid) => {
            const season = (p.current_season_by_market || {})[mid];
            const r = await api.getApplicationsV2({ market_id: mid, season }).catch(() => ({ applications: [] }));
            if (r.applications.some((a) => a.producer_id === id && a.status !== 'declined' && a.status !== 'withdrawn')) live.push(mid);
          }),
        );
        setAppliedMarkets(live);
      }
    } catch (err: any) {
      setError(err?.message || 'Could not load the producer');
    } finally {
      setLoading(false);
    }
  }, [id, user?.role]);

  useEffect(() => {
    if (ready) reload();
  }, [ready, reload]);

  const flashMsg = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(''), 3000);
  };

  const runWrite = async (fn: () => Promise<unknown>, okMsg = 'Saved') => {
    setError('');
    try {
      await fn();
      await reload();
      flashMsg(okMsg);
      return true;
    } catch (err: any) {
      setError(err?.message || 'The change did not save');
      return false;
    }
  };

  /** The market's current season: the API's answer, else the newest season this producer has there. */
  const currentSeasonOf = useCallback(
    (marketId: string): string => {
      if (seasonByMarket[marketId]) return seasonByMarket[marketId];
      const seasons = memberships.filter((m) => m.market_id === marketId).map((m) => m.season).filter(Boolean);
      return seasons.sort().pop() || '';
    },
    [seasonByMarket, memberships],
  );

  const sendInvite = async (marketId: string, force: boolean) => {
    if (!producer) return;
    setInviting(true);
    setError('');
    setInviteConflict(null);
    try {
      const r = await api.inviteProducer(producer.id, marketId, force);
      setInviteOutcome({ marketId, url: r.url, email: r.invite.email_status, sms: r.invite.sms_status, completed: r.completed === true, quietUntil: r.quiet_until ?? null });
      await copyText(r.url);
      await reload();
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 409 && (err.body.code === 'already_invited' || /already invited/i.test(err.message))) {
        setInviteConflict({ marketId, quietUntil: typeof err.body.quiet_until === 'string' ? err.body.quiet_until : null });
      } else setError(err?.message || 'Could not send the invitation');
    } finally {
      setInviting(false);
    }
  };

  if (!ready) return <LoadingScreen />;
  if (!id) {
    return (
      <AdminShell title="Producer">
        <Notice kind="error">No producer id in the URL. <Link href="/admin/producers" className="font-semibold">Back to producers</Link></Notice>
      </AdminShell>
    );
  }
  if (loading && !producer) return <LoadingScreen label="Loading producer..." />;
  if (!producer) {
    return (
      <AdminShell title="Producer">
        <Notice kind="error">{error || 'Producer not found.'} <Link href="/admin/producers" className="font-semibold">Back to producers</Link></Notice>
      </AdminShell>
    );
  }

  const marketName = (mid: string) => markets.find((m) => m.id === mid)?.name || mid;

  // Markets this producer could be invited to re-apply at: a membership exists
  // there, but none in the current season, and no live application.
  const inviteMarkets = isAdmin
    ? Array.from(new Set(memberships.map((m) => m.market_id))).filter((mid) => {
        const season = currentSeasonOf(mid);
        const hasCurrent = memberships.some((m) => m.market_id === mid && m.season === season && m.status !== 'inactive');
        return !hasCurrent && !appliedMarkets.includes(mid) && markets.find((x) => x.id === mid)?.season?.label;
      })
    : [];

  return (
    <AdminShell
      title={producer.business_name}
      subtitle={
        <>
          {producer.contact_name || 'No contact name'} · {producer.source} · <Link href="/admin/producers" className="text-green-700">All producers</Link>
        </>
      }
      actions={
        <>
          {!producer.active && <StatusChip status="inactive" />}
          {inviteMarkets.map((mid) => (
            <SecondaryButton key={mid} small onClick={() => sendInvite(mid, false)} disabled={inviting}>
              {inviting ? 'Inviting...' : `Invite to re-apply${inviteMarkets.length > 1 ? ` (${marketName(mid)})` : ''}`}
            </SecondaryButton>
          ))}
        </>
      }
    >
      {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}
      {flash && <div className="mb-4"><Notice kind="success">{flash}</Notice></div>}
      {inviteOutcome && (
        <div className="mb-4">
          <Notice kind="success">
            {inviteOutcome.completed ? 'Invitation completed' : 'Invitation'} for {marketName(inviteOutcome.marketId)}: email {inviteOutcome.email.replace(/_/g, ' ')}, text{' '}
            {textOutcome(inviteOutcome.sms, inviteOutcome.quietUntil)}.
            {inviteOutcome.sms === 'skipped_quiet_hours' && ' Invite again after quiet hours to send the text; the email is not repeated.'} The link was copied:{' '}
            <span className="font-mono text-[12px] break-all">{inviteOutcome.url}</span>
          </Notice>
        </div>
      )}
      {inviteConflict && (
        <div className="mb-4">
          <Notice kind="warning">
            {producer.business_name} was already invited for {marketName(inviteConflict.marketId)}.{' '}
            {inviteConflict.quietUntil && `The text is held for quiet hours until ${formatStamp(inviteConflict.quietUntil)}; invite again after that to send it. `}
            <ConfirmButton label="Resend the invitation" confirmLabel="Resend" danger={false} busy={inviting} onConfirm={() => sendInvite(inviteConflict.marketId, true)} />
          </Notice>
        </div>
      )}
      {invite && (
        <div className="mb-4 text-sm text-earth-700">
          Invited to re-apply {formatStamp(invite.sent_at)}.{' '}
          <button
            type="button"
            onClick={async () => flashMsg((await copyText(invite.token_url)) ? 'Link copied' : 'Could not copy the link')}
            className="bg-transparent border-none text-green-700 font-semibold cursor-pointer p-0 hover:underline"
          >
            Copy the application link
          </button>
        </div>
      )}

      <div className="space-y-6">
        <ProfileSection producer={producer} isAdmin={isAdmin} onSave={(data) => runWrite(() => api.updateProducer(producer.id, data), 'Producer saved')} />

        <MembershipsSection
          producer={producer}
          memberships={memberships}
          markets={markets}
          booths={booths}
          currentSeasonOf={currentSeasonOf}
          isAdmin={isAdmin}
          canAct={(marketId) => canAccessMarket(user, marketId)}
          marketName={marketName}
          onTransition={(m, to) => runWrite(() => api.updateMembership(m.id, { status: to }), `${marketName(m.market_id)}: ${to.replace(/_/g, ' ')}`)}
          onPatch={(m, data) => runWrite(() => api.updateMembership(m.id, data), 'Membership saved')}
          onAdd={(market_id, status) => runWrite(() => api.createMembership({ producer_id: producer.id, market_id, status }), `Added to ${marketName(market_id)}`)}
          onInsurance={(m, data) => runWrite(() => api.updateInsurance(m.id, data), 'Insurance saved')}
          onItems={(m, data) => runWrite(() => api.membershipItems(m.id, data), 'Items saved')}
          onAgreementLink={async (m, send) => {
            try {
              const r = await api.sendAgreementLink(m.id, send);
              if (send) await reload();
              return r;
            } catch (err: any) {
              const until = err instanceof ApiError && err.body.code === 'quiet_hours' && typeof err.body.quiet_until === 'string' ? err.body.quiet_until : null;
              setError(`${err?.message || 'Could not create the agreement link'}${until ? ` Quiet hours end ${formatStamp(until)}.` : ''}`);
              return null;
            }
          }}
          onError={setError}
        />

        <CheckinsSection checkins={checkins} summary={summary} isAdmin={isAdmin} marketName={marketName} />
      </div>
    </AdminShell>
  );
}

/* ─── Profile ─── */

function productRows(products: Producer['products']): { type: string; items: string; practices: string }[] {
  return (products || []).map((p) => {
    if (typeof p === 'string') return { type: '-', items: p, practices: '' };
    const entry = p as ProductEntry;
    return { type: entry.type.replace(/_/g, ' '), items: entry.items.join(', '), practices: (entry.practices || []).map((x) => x.replace(/_/g, ' ')).join(', ') };
  });
}

function ProfileSection({ producer, isAdmin, onSave }: { producer: Producer; isAdmin: boolean; onSave: (d: Parameters<typeof api.updateProducer>[1]) => Promise<boolean> }) {
  const [businessName, setBusinessName] = useState(producer.business_name);
  const [contactName, setContactName] = useState(producer.contact_name || '');
  const [phone, setPhone] = useState(producer.phone || '');
  const [email, setEmail] = useState(producer.email || '');
  const [category, setCategory] = useState(producer.category || '');
  const [notes, setNotes] = useState(producer.notes || '');
  const [active, setActive] = useState(producer.active);
  const [aliases, setAliases] = useState<string[]>(producer.aliases || []);
  const [emails, setEmails] = useState<string[]>(producer.emails || []);
  const [website, setWebsite] = useState(producer.website || '');
  const [social, setSocial] = useState(producer.social || '');
  const [street, setStreet] = useState(producer.address?.street || '');
  const [city, setCity] = useState(producer.address?.city || '');
  const [state, setState] = useState(producer.address?.state || '');
  const [zip, setZip] = useState(producer.address?.zip || '');
  const [description, setDescription] = useState(producer.description_public || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setBusinessName(producer.business_name);
    setContactName(producer.contact_name || '');
    setPhone(producer.phone || '');
    setEmail(producer.email || '');
    setCategory(producer.category || '');
    setNotes(producer.notes || '');
    setActive(producer.active);
    setAliases(producer.aliases || []);
    setEmails(producer.emails || []);
    setWebsite(producer.website || '');
    setSocial(producer.social || '');
    setStreet(producer.address?.street || '');
    setCity(producer.address?.city || '');
    setState(producer.address?.state || '');
    setZip(producer.address?.zip || '');
    setDescription(producer.description_public || '');
  }, [producer]);

  const renamed = businessName.trim() !== producer.business_name;

  const save = async () => {
    setSaving(true);
    const hasAddress = [street, city, state, zip].some((x) => x.trim());
    const data: Parameters<typeof api.updateProducer>[1] = {
      business_name: businessName.trim(),
      contact_name: contactName.trim(),
      phone: phone.trim() ? normalizePhone(phone) : null,
      email: email.trim() ? email.trim().toLowerCase() : null,
      category: category.trim(),
      active,
      aliases: aliases.filter((a) => a !== businessName.trim()),
      emails,
      website: website.trim(),
      social: social.trim(),
      address: hasAddress ? { street: street.trim(), city: city.trim(), state: state.trim(), zip: zip.trim() } : null,
      description_public: description.trim(),
    };
    if (isAdmin) data.notes = notes;
    await onSave(data);
    setSaving(false);
  };

  const readOnly = !isAdmin;
  const rows = productRows(producer.products);

  return (
    <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6">
      <h3 className="text-base font-bold text-earth-800 mb-4 mt-0">Profile</h3>
      {readOnly && <div className="mb-3"><Notice kind="info">Producer records are edited by SJCA administrators.</Notice></div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Field label="Business name" value={businessName} onChange={setBusinessName} disabled={readOnly} />
          {renamed && <div className="text-[11px] text-earth-500 mt-1">Renaming keeps &ldquo;{producer.business_name}&rdquo; as an alias automatically.</div>}
        </div>
        <Field label="Contact name" value={contactName} onChange={setContactName} disabled={readOnly} />
        <Field label="Phone" type="tel" value={phone} onChange={setPhone} disabled={readOnly} placeholder={readOnly ? '' : '(501) 555-0100'} />
        <Field label="Primary email" type="email" value={email} onChange={setEmail} disabled={readOnly} />
        <Field label="Category" value={category} onChange={setCategory} disabled={readOnly} />
        <div className="flex items-end pb-2">
          <CheckboxField label="Active" checked={active} onChange={setActive} disabled={readOnly} />
        </div>
        <Field label="Website" value={website} onChange={setWebsite} disabled={readOnly} placeholder="https://" />
        <Field label="Social media" value={social} onChange={setSocial} disabled={readOnly} />
      </div>

      <div className="text-xs font-semibold text-earth-500 mt-4 mb-2">Address</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="col-span-2"><Field label="Street" value={street} onChange={setStreet} disabled={readOnly} /></div>
        <Field label="City" value={city} onChange={setCity} disabled={readOnly} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="State" value={state} onChange={setState} disabled={readOnly} />
          <Field label="ZIP" value={zip} onChange={setZip} disabled={readOnly} />
        </div>
      </div>

      <div className="mt-4">
        <TextArea label="Public description" value={description} onChange={readOnly ? () => {} : setDescription} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
        <ListEditor
          label="Aliases"
          hint="Other names this producer has used on forms."
          items={aliases}
          onChange={setAliases}
          placeholder="Add an alias"
          disabled={readOnly}
        />
        <ListEditor
          label="Emails"
          hint="Every address ever seen; applications are matched by email."
          items={emails}
          onChange={setEmails}
          placeholder="name@example.com"
          type="email"
          disabled={readOnly}
        />
      </div>

      {(producer.categories?.length ?? 0) > 0 && (
        <div className="mt-4">
          <div className="text-xs font-semibold text-earth-500 mb-1.5">Categories</div>
          <div className="flex flex-wrap gap-1.5">
            {producer.categories!.map((c) => (
              <span key={c} className="text-[12px] px-2 py-0.5 rounded-full bg-earth-50 border border-earth-100">{c.replace(/_/g, ' ')}</span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="text-xs font-semibold text-earth-500 mb-1.5">Products (from the most recent application)</div>
        <TableCard minWidth={520}>
          <thead>
            <tr className="border-b border-border-light">
              <Th>Type</Th>
              <Th>Items</Th>
              <Th>Practices</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={3}>No products on file.</EmptyRow>
            ) : (
              rows.map((r, i) => (
                <tr key={i} className="border-b border-border-light last:border-none">
                  <Td><span className="capitalize">{r.type}</span></Td>
                  <Td>{r.items}</Td>
                  <Td><span className="text-[12px]">{r.practices || '-'}</span></Td>
                </tr>
              ))
            )}
          </tbody>
        </TableCard>
      </div>

      {isAdmin && (
        <div className="mt-4">
          <TextArea label="Notes (admin only)" value={notes} onChange={setNotes} />
        </div>
      )}

      <div className="mt-4 text-[12px] text-text-muted flex flex-wrap gap-x-4 gap-y-1">
        <span>SMS consent: <strong className="capitalize">{producer.sms_consent?.status?.replace(/_/g, ' ') || 'unknown'}</strong>{producer.sms_consent?.source ? ` (${producer.sms_consent.source})` : ''}</span>
        {producer.sms_opt_out_at && <span>Opted out {formatStamp(producer.sms_opt_out_at)}</span>}
        <span>Created {formatStamp(producer.created_at)}</span>
      </div>

      {!readOnly && <SaveBar saving={saving} onSave={save} />}
    </div>
  );
}

/* ─── Memberships ─── */

type MembershipPatch = Parameters<typeof api.updateMembership>[1];
type ItemsPayload = Parameters<typeof api.membershipItems>[1];
type InsurancePayload = Parameters<typeof api.updateInsurance>[1];
type AgreementResult = { url: string; expires_at: string; sms: string };

function MembershipsSection({
  producer,
  memberships,
  markets,
  booths,
  currentSeasonOf,
  isAdmin,
  canAct,
  marketName,
  onTransition,
  onPatch,
  onAdd,
  onInsurance,
  onItems,
  onAgreementLink,
  onError,
}: {
  producer: Producer;
  memberships: Membership[];
  markets: Market[];
  booths: Record<string, BoothDoc[]>;
  currentSeasonOf: (marketId: string) => string;
  isAdmin: boolean;
  canAct: (marketId: string) => boolean;
  marketName: (id: string) => string;
  onTransition: (m: Membership, to: MembershipStatus) => Promise<boolean>;
  onPatch: (m: Membership, data: MembershipPatch) => Promise<boolean>;
  onAdd: (marketId: string, status: MembershipStatus) => Promise<boolean>;
  onInsurance: (m: Membership, data: InsurancePayload) => Promise<boolean>;
  onItems: (m: Membership, data: ItemsPayload) => Promise<boolean>;
  onAgreementLink: (m: Membership, send: boolean) => Promise<AgreementResult | null>;
  onError: (msg: string) => void;
}) {
  const [addMarket, setAddMarket] = useState('');
  const [addStatus, setAddStatus] = useState<MembershipStatus>('approved');
  const [adding, setAdding] = useState(false);

  const isCurrent = (m: Membership) => !!m.season && m.season === currentSeasonOf(m.market_id);
  const current = memberships.filter(isCurrent).sort((a, b) => marketName(a.market_id).localeCompare(marketName(b.market_id)));
  const past = memberships.filter((m) => !isCurrent(m));
  const pastSeasons = Array.from(new Set(past.map((m) => m.season || 'earlier'))).sort().reverse();

  // A market with no membership in its current season can take a new one.
  const available = markets.filter((mk) => !memberships.some((m) => m.market_id === mk.id && isCurrent(m)));

  useEffect(() => {
    if (!addMarket && available.length > 0) setAddMarket(available[0].id);
    if (addMarket && !available.some((m) => m.id === addMarket)) setAddMarket(available[0]?.id || '');
  }, [available, addMarket]);

  return (
    <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6">
      <h3 className="text-base font-bold text-earth-800 mb-1 mt-0">Memberships</h3>
      <p className="text-xs text-earth-500 mt-0 mb-4">
        Every producer re-applies each season, so each membership belongs to one season. Only the current season gets texts and booths.
      </p>

      {current.length === 0 ? (
        <p className="text-sm text-earth-400 m-0">{producer.business_name} has no membership in the current season{memberships.length > 0 ? ' (previous seasons below)' : ''}.</p>
      ) : (
        <div className="space-y-3">
          {current.map((m) => (
            <MembershipCard
              key={m.id}
              m={m}
              allowed={canAct(m.market_id)}
              isAdmin={isAdmin}
              marketName={marketName(m.market_id)}
              booths={booths[m.market_id] || []}
              onTransition={onTransition}
              onPatch={onPatch}
              onInsurance={onInsurance}
              onItems={onItems}
              onAgreementLink={onAgreementLink}
              onError={onError}
            />
          ))}
        </div>
      )}

      {past.length > 0 && (
        <details className="mt-5">
          <summary className="cursor-pointer text-sm font-semibold text-earth-700">Previous seasons ({past.length})</summary>
          <div className="mt-3 space-y-3">
            {pastSeasons.map((season) => (
              <div key={season}>
                <div className="text-xs font-semibold text-earth-500 mb-1.5">{season}</div>
                <div className="space-y-1.5">
                  {past
                    .filter((m) => (m.season || 'earlier') === season)
                    .map((m) => (
                      <div key={m.id} className="rounded-lg border border-earth-100 bg-earth-15 px-3 py-2 flex items-center gap-2 flex-wrap text-sm">
                        <Link href={`/admin/markets/detail?id=${encodeURIComponent(m.market_id)}`} className="font-semibold text-green-700 no-underline hover:underline">{marketName(m.market_id)}</Link>
                        <StatusChip status={m.status} />
                        <StatusChip status={planOf(m.fee_plan)} />
                        <span className="text-[12px] text-text-muted">{m.spaces ?? 1} space{(m.spaces ?? 1) === 1 ? '' : 's'}{m.electric ? ' - power' : ''}</span>
                        <span className="text-[12px] text-text-muted">{m.approved_at ? `approved ${formatStamp(m.approved_at)}` : 'not approved'}</span>
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {isAdmin && available.length > 0 && (
        <div className="mt-4 pt-4 border-t border-earth-100 grid grid-cols-1 sm:grid-cols-[1fr_180px_auto] gap-2 items-end">
          <SelectField label="Add a current-season membership" value={addMarket} onChange={setAddMarket} options={available.map((m) => ({ value: m.id, label: m.name }))} />
          <SelectField label="Starting status" value={addStatus} onChange={(v) => setAddStatus(v as MembershipStatus)} options={['approved', 'active', 'applied', 'under_review'].map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))} />
          <PrimaryButton
            onClick={async () => {
              if (!addMarket) return;
              setAdding(true);
              await onAdd(addMarket, addStatus);
              setAdding(false);
            }}
            disabled={adding || !addMarket}
          >
            {adding ? 'Adding...' : 'Add'}
          </PrimaryButton>
        </div>
      )}
    </div>
  );
}

const selectClass = 'px-2 py-1.5 rounded-lg border text-xs font-medium cursor-pointer bg-white';
const selectStyle = { borderColor: '#E4DFD3', color: '#3d3428' };

function MembershipCard({
  m,
  allowed,
  isAdmin,
  marketName,
  booths,
  onTransition,
  onPatch,
  onInsurance,
  onItems,
  onAgreementLink,
  onError,
}: {
  m: Membership;
  allowed: boolean;
  isAdmin: boolean;
  marketName: string;
  booths: BoothDoc[];
  onTransition: (m: Membership, to: MembershipStatus) => Promise<boolean>;
  onPatch: (m: Membership, data: MembershipPatch) => Promise<boolean>;
  onInsurance: (m: Membership, data: InsurancePayload) => Promise<boolean>;
  onItems: (m: Membership, data: ItemsPayload) => Promise<boolean>;
  onAgreementLink: (m: Membership, send: boolean) => Promise<AgreementResult | null>;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const next = MEMBERSHIP_TRANSITIONS[m.status] || [];
  const plan = planOf(m.fee_plan);
  const spaces = m.spaces === 2 ? 2 : 1;
  const activeBooths = booths.filter((b) => b.active).sort((a, b) => a.row.localeCompare(b.row) || a.order - b.order);
  const usual = booths.find((b) => b.id === m.usual_booth_id);

  const patch = async (key: string, data: MembershipPatch) => {
    setBusy(key);
    await onPatch(m, data);
    setBusy(null);
  };

  return (
    <div className="rounded-xl border border-earth-100 bg-earth-15 p-3 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/admin/markets/detail?id=${encodeURIComponent(m.market_id)}`} className="font-semibold text-green-700 no-underline hover:underline">{marketName}</Link>
            <span className="text-[12px] font-semibold text-earth-600">{m.season}</span>
            <StatusChip status={m.status} />
            {m.trial_period && <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">trial period</span>}
            <span className="text-[11px] text-text-muted">{m.source}</span>
          </div>
          <div className="text-[12px] text-text-muted mt-0.5">
            {m.approved_at ? `Approved ${formatStamp(m.approved_at)}` : 'Not yet approved'}
            {m.history?.length > 0 && ` · ${m.history.length} change${m.history.length === 1 ? '' : 's'}`}
            {m.application_id && (
              <>
                {' · '}
                <Link href={`/admin/applications/detail?id=${encodeURIComponent(m.application_id)}`} className="text-green-700">application</Link>
              </>
            )}
          </div>
        </div>
        {allowed && next.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            {next.map((to) => (
              <button
                key={to}
                type="button"
                onClick={async () => {
                  setBusy(`t:${to}`);
                  await onTransition(m, to);
                  setBusy(null);
                }}
                disabled={busy !== null}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border capitalize disabled:opacity-40"
                style={to === 'inactive' ? { borderColor: '#fecaca', color: '#dc2626', background: '#fff' } : { borderColor: '#E4DFD3', color: '#21512C', background: '#fff' }}
              >
                {busy === `t:${to}` ? '...' : `-> ${to.replace(/_/g, ' ')}`}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Booth and fee terms */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {allowed ? (
          <>
            <select value={plan} onChange={(e) => patch('plan', { fee_plan: e.target.value as FeePlan })} disabled={busy !== null} className={selectClass} style={selectStyle} aria-label="Fee plan">
              <option value="seasonal">seasonal</option>
              <option value="daily">daily</option>
            </select>
            <select value={String(spaces)} onChange={(e) => patch('spaces', { spaces: e.target.value === '2' ? 2 : 1 })} disabled={busy !== null} className={selectClass} style={selectStyle} aria-label="Spaces">
              <option value="1">1 space</option>
              <option value="2">2 spaces</option>
            </select>
            <select value={m.booth_kind === 'food_truck' ? 'food_truck' : 'stall'} onChange={(e) => patch('kind', { booth_kind: e.target.value === 'food_truck' ? 'food_truck' : 'stall' })} disabled={busy !== null} className={selectClass} style={selectStyle} aria-label="Booth kind">
              <option value="stall">stall</option>
              <option value="food_truck">food truck</option>
            </select>
            <select value={m.usual_booth_id || ''} onChange={(e) => patch('usual', { usual_booth_id: e.target.value || null })} disabled={busy !== null} className={selectClass} style={selectStyle} aria-label="Usual booth">
              <option value="">no usual booth</option>
              {activeBooths.map((b) => (
                <option key={b.id} value={b.id}>{b.label}{b.power ? ' (power)' : ''}</option>
              ))}
              {m.usual_booth_id && !activeBooths.some((b) => b.id === m.usual_booth_id) && <option value={m.usual_booth_id}>{usual?.label || m.usual_booth_id} (retired)</option>}
            </select>
            <CheckboxField label="Electricity" checked={!!m.electric} onChange={(c) => patch('electric', { electric: c })} disabled={busy !== null} />
            {plan === 'seasonal' && <CheckboxField label="Paid in full" checked={!!m.pay_in_full} onChange={(c) => patch('pif', { pay_in_full: c })} disabled={busy !== null} />}
            <CheckboxField label="Trial" checked={!!m.trial_period} onChange={(c) => patch('trial', { trial_period: c })} disabled={busy !== null} />
          </>
        ) : (
          <div className="text-[12px] text-text-muted flex items-center gap-2 flex-wrap">
            <StatusChip status={plan} />
            <span>{spaces} space{spaces === 1 ? '' : 's'}</span>
            {m.electric && <span>power</span>}
            {usual && <span>usual booth {usual.label}</span>}
          </div>
        )}
      </div>

      <InsuranceBlock m={m} allowed={allowed} isAdmin={isAdmin} onInsurance={onInsurance} onError={onError} />
      <AgreementBlock m={m} allowed={allowed} onAgreementLink={onAgreementLink} />
      <ItemsBlock m={m} allowed={allowed} isAdmin={isAdmin} onItems={onItems} />
    </div>
  );
}

/**
 * The last day the certificate is valid, as the server gives it (`expires_on`,
 * a calendar date in the market's own calendar). Never `expires_at.slice(0, 10)`:
 * that instant is the first moment of the NEXT day, so its UTC date is one day
 * late, and saving it back moved the date forward on every save.
 */
function expiresOn(m: Membership): string {
  return (m.insurance as (Membership['insurance'] & InsuranceCalendarDate) | undefined)?.expires_on || '';
}

function effectiveInsurance(m: Membership): InsuranceStatus {
  const ins = m.insurance;
  if (!ins) return 'missing';
  if (ins.status === 'on_file' && ins.expires_at && Date.parse(ins.expires_at) <= Date.now()) return 'expired';
  return ins.status;
}

function InsuranceBlock({
  m,
  allowed,
  isAdmin,
  onInsurance,
  onError,
}: {
  m: Membership;
  allowed: boolean;
  isAdmin: boolean;
  onInsurance: (m: Membership, data: InsurancePayload) => Promise<boolean>;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<InsuranceStatus>(m.insurance?.status ?? 'missing');
  const [expires, setExpires] = useState(expiresOn(m));
  const [note, setNote] = useState(m.insurance?.note || '');
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    setStatus(m.insurance?.status ?? 'missing');
    setExpires(expiresOn(m));
    setNote(m.insurance?.note || '');
  }, [m.insurance]);

  const eff = effectiveInsurance(m);
  const uploadId = m.insurance?.upload_id || null;

  // Open the certificate through a short-lived signed URL; the blank window is opened first so popup blockers allow it.
  const openCertificate = async () => {
    if (!m.application_id || !uploadId) return;
    setOpening(true);
    const win = window.open('about:blank', '_blank');
    try {
      const { url } = await api.getApplicationUploadUrl(m.application_id, uploadId);
      if (win) {
        win.opener = null;
        win.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (err: any) {
      win?.close();
      onError(err?.message || 'Could not open the certificate');
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="rounded-lg border border-earth-100 bg-white p-2.5">
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Insurance</span>
        <StatusChip status={eff} />
        {expiresOn(m) && <span className="text-[12px] text-text-muted">valid through {expiresOn(m)}</span>}
        {m.insurance?.note && <span className="text-[12px] text-text-soft">{m.insurance.note}</span>}
        <span className="ml-auto flex items-center gap-2">
          {isAdmin && uploadId && m.application_id && (
            <SecondaryButton small onClick={openCertificate} disabled={opening}>{opening ? 'Opening...' : 'Open certificate'}</SecondaryButton>
          )}
          {allowed && !editing && <SecondaryButton small onClick={() => setEditing(true)}>Update insurance...</SecondaryButton>}
        </span>
      </div>
      {editing && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <SelectField
            label="Status"
            value={status}
            onChange={(v) => setStatus(v as InsuranceStatus)}
            options={[
              { value: 'missing', label: 'Missing' },
              { value: 'on_file', label: 'On file' },
              { value: 'expired', label: 'Expired' },
              { value: 'waived', label: 'Waived' },
            ]}
          />
          <DateField label="Valid through (last day)" value={expires} onChange={setExpires} />
          <Field label="Note" value={note} onChange={setNote} />
          <div className="flex gap-2">
            <PrimaryButton
              small
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                const ok = await onInsurance(m, { status, expires_on: expires || null, upload_id: m.insurance?.upload_id ?? null, note: note.trim() });
                setSaving(false);
                if (ok) setEditing(false);
              }}
            >
              {saving ? 'Saving...' : 'Save'}
            </PrimaryButton>
            <SecondaryButton small onClick={() => setEditing(false)} disabled={saving}>Cancel</SecondaryButton>
          </div>
        </div>
      )}
    </div>
  );
}

function AgreementBlock({
  m,
  allowed,
  onAgreementLink,
}: {
  m: Membership;
  allowed: boolean;
  onAgreementLink: (m: Membership, send: boolean) => Promise<AgreementResult | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url: string; sms: string; sent: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const hh = m.hold_harmless;

  const run = async (send: boolean) => {
    setBusy(true);
    setCopied(false);
    const r = await onAgreementLink(m, send);
    setBusy(false);
    if (r) {
      setResult({ url: r.url, sms: r.sms, sent: send });
      if (!send) setCopied(await copyText(r.url));
    }
  };

  return (
    <div className="rounded-lg border border-earth-100 bg-white p-2.5">
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Hold Harmless</span>
        {hh ? (
          <>
            <StatusChip status="signed" />
            <span className="text-[12px] text-text-soft">{hh.name}, {formatStamp(hh.signed_at)}{hh.version ? `, version ${hh.version}` : ''}</span>
          </>
        ) : (
          <>
            <StatusChip status="unsigned" />
            {allowed && m.status !== 'inactive' && (
              <span className="ml-auto flex items-center gap-2">
                <SecondaryButton small onClick={() => run(false)} disabled={busy}>Copy link</SecondaryButton>
                <ConfirmButton label="Send agreement link" confirmLabel="Text the link" danger={false} busy={busy} onConfirm={() => run(true)} />
              </span>
            )}
          </>
        )}
      </div>
      {result && (
        <div className="mt-2 text-[12px] text-text-soft">
          {result.sent ? `Text: ${textOutcome(result.sms)}. ` : copied ? 'Link copied. ' : ''}
          <span className="font-mono break-all">{result.url}</span>
        </div>
      )}
    </div>
  );
}

/** Reviewing a vendor's request is open to the market's staff; adding items directly is an admin action (the server answers 403 otherwise). */
function ItemsBlock({ m, allowed, isAdmin, onItems }: { m: Membership; allowed: boolean; isAdmin: boolean; onItems: (m: Membership, data: ItemsPayload) => Promise<boolean> }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const requests = (m.item_requests || []).filter((r) => r.status === 'pending');

  if ((m.approved_items?.length ?? 0) === 0 && requests.length === 0 && !allowed) return null;

  const add = async () => {
    const items = draft.split(',').map((x) => x.trim()).filter(Boolean);
    if (items.length === 0) return;
    setBusy('add');
    const ok = await onItems(m, { action: 'add', items });
    setBusy(null);
    if (ok) setDraft('');
  };

  return (
    <div className="rounded-lg border border-earth-100 bg-white p-2.5 space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Approved items</div>
      {(m.approved_items?.length ?? 0) === 0 ? (
        <p className="text-[12px] text-earth-400 m-0">None listed.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {m.approved_items.map((item, i) => (
            <span key={`${item}-${i}`} className="text-[12px] px-2 py-0.5 rounded-full bg-earth-50 border border-earth-100">{item}</span>
          ))}
        </div>
      )}
      {requests.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Requests to add items</div>
          {requests.map((r) => (
            <div key={r.id} className="flex items-center gap-2 flex-wrap text-sm rounded-lg bg-amber-50 border border-amber-100 px-2.5 py-1.5">
              <span className="font-medium">{r.items.join(', ')}</span>
              {r.note && <span className="text-[12px] text-text-soft">{r.note}</span>}
              <span className="text-[11px] text-text-muted">{r.source}, {formatStamp(r.requested_at)}</span>
              {allowed && (
                <span className="ml-auto flex items-center gap-2">
                  <PrimaryButton
                    small
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy(`a:${r.id}`);
                      await onItems(m, { action: 'approve', request_id: r.id });
                      setBusy(null);
                    }}
                  >
                    Approve
                  </PrimaryButton>
                  <SecondaryButton
                    small
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy(`d:${r.id}`);
                      await onItems(m, { action: 'decline', request_id: r.id });
                      setBusy(null);
                    }}
                  >
                    Decline
                  </SecondaryButton>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {allowed && isAdmin && (
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void add();
              }
            }}
            placeholder="Add items, separated by commas"
            aria-label="Add approved items"
            className="flex-1 px-3 py-1.5 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100"
          />
          <SecondaryButton small onClick={add} disabled={busy !== null || !draft.trim()}>{busy === 'add' ? 'Adding...' : 'Add'}</SecondaryButton>
        </div>
      )}
    </div>
  );
}

/* ─── Check-ins ─── */

function CheckinsSection({
  checkins,
  summary,
  isAdmin,
  marketName,
}: {
  checkins: Checkin[];
  summary: { count: number; last_submitted_at: string | null } | null;
  isAdmin: boolean;
  marketName: (id: string) => string;
}) {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? checkins : checkins.slice(0, 10);
  const dateOf = (c: Checkin) => c.market_date_id.slice(c.market_id.length + 1);
  const yesNo = (v: boolean | null) => (v === null ? '—' : v ? 'Yes' : 'No');
  const money = (c: Checkin) => {
    const s = c.estimated_sales;
    if (!s) return '—';
    if (s.value === null) return s.raw || '—';
    return `$${s.value.toLocaleString()}${s.kind === 'range' ? ' (mid)' : ''}`;
  };

  return (
    <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="text-base font-bold text-earth-800 m-0">Recent check-ins</h3>
        <span className="text-[12px] text-text-muted">
          {summary ? `${summary.count} total · last ${formatStamp(summary.last_submitted_at)}` : ''}
        </span>
      </div>
      <TableCard minWidth={isAdmin ? 1020 : 900}>
        <thead>
          <tr className="border-b border-border-light">
            <Th>Market day</Th>
            <Th>Source</Th>
            <Th>Submitted</Th>
            {isAdmin && <Th>Sales</Th>}
            <Th>Transactions</Th>
            <Th>Attending next</Th>
            <Th>Bringing</Th>
            <Th>Sold out</Th>
            <Th>Unsold</Th>
            <Th>Feedback</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow colSpan={isAdmin ? 10 : 9}>No check-ins yet.</EmptyRow>
          ) : (
            rows.map((c) => (
              <tr key={c.id} className="border-b border-border-light last:border-none">
                <Td>
                  <Link href={`/admin/market-dates?id=${encodeURIComponent(c.market_date_id)}`} className="font-mono text-[12px] text-green-700 no-underline hover:underline">
                    {dateOf(c)}
                  </Link>
                  <div className="text-[11px] text-text-muted">{marketName(c.market_id)}{c.flags?.length ? ` · ${c.flags.join(', ')}` : ''}</div>
                </Td>
                <Td>
                  <StatusChip status={c.source} />
                  {c.partial && <div className="text-[11px] text-text-muted mt-0.5">text only</div>}
                </Td>
                <Td><span className="text-[12px]">{formatStamp(c.submitted_at)}</span></Td>
                {isAdmin && <Td><span className="font-mono text-[12px]">{money(c)}</span></Td>}
                <Td>{c.transactions_estimate?.value ?? (c.transactions_estimate?.raw || '—')}</Td>
                <Td>{yesNo(c.attending_next)}</Td>
                <Td><span className="text-[12px]">{c.bringing_next?.length ? c.bringing_next.join(', ') : c.bringing_next_raw || '—'}</span></Td>
                <Td><span className="text-[12px]">{c.sold_out_items?.length ? c.sold_out_items.join(', ') : c.sold_out_raw || '—'}</span></Td>
                <Td><span className="text-[12px]">{c.unsold_items?.length ? c.unsold_items.join(', ') : c.unsold_raw || '—'}</span></Td>
                <Td><span className="text-[12px]">{c.feedback || '—'}</span></Td>
              </tr>
            ))
          )}
        </tbody>
      </TableCard>
      {checkins.length > 10 && (
        <div className="mt-3">
          <SecondaryButton small onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `Show all ${checkins.length}`}</SecondaryButton>
        </div>
      )}
    </div>
  );
}
