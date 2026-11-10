import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { requireStaff, canAccessMarket, type ScopedUser } from '../middleware/market-scope.js';
import { writeAudit } from '../services/audit.js';
import { marketDateFromData } from '../services/market-dates.js';
import type { MarketDateDoc } from '../services/market-dates.js';
import type { FarmersMarket } from '../services/markets.js';
import {
  computeSchedule,
  listRecipients,
  sendCheckinLink,
  processDeadline,
  draftNow,
  approveAssignments,
  resendBoothText,
  SCAN_WINDOW_MS,
} from '../services/checkin-workflow.js';
import { applyAssignmentChanges, buildAssignmentsView, findSeasonOpener } from '../services/booth-assignments.js';
import type { AssignmentsView, CycleMode, Textability } from '../services/booth-assignments.js';
import { currentSeason, findMembership } from '../services/seasons.js';
import { listBooths } from '../services/booths.js';
import { LINK_TOKEN_GRACE_MIN } from '../services/link-tokens.js';
import { toDate } from '../utils/dates.js';
import { byDateDesc } from '../utils/sort.js';

/**
 * Staff market-date routes (contract §4.2): status, resend, close, and the
 * Phase 4 booth assignments. Every assignments route takes `cycle`: `next`
 * (the default - this date's check-ins assign the next market) or `opener`
 * (the season's first market date assigns itself; see booth-assignments.ts).
 */

async function loadMarket(db: FastifyInstance['db'], id: string): Promise<FarmersMarket | null> {
  const doc = await db.collection('farmers_markets').doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...(doc.data() as Record<string, unknown>) } as FarmersMarket;
}

async function loadDate(db: FastifyInstance['db'], id: string): Promise<MarketDateDoc | null> {
  const doc = await db.collection('market_dates').doc(id).get();
  if (!doc.exists) return null;
  return marketDateFromData(doc.id, doc.data() as Record<string, unknown>);
}

function toMillisSafe(value: unknown): number {
  return toDate(value)?.getTime() ?? 0;
}

type NextDue = { action: 'checkin' | 'reminder' | 'deadline' | 'summary' | 'drafts' | 'booth_texts' | 'none'; at: Date | null; offset_min?: number };

/**
 * The step the engine takes next for this date. `boothTextsDue` comes from the
 * assignments views (when the owed booth texts of each cycle may go out; null
 * when none are owed or they are held).
 */
function computeNextDue(
  date: MarketDateDoc,
  schedule: ReturnType<typeof computeSchedule>,
  now: Date,
  hasBooths: boolean,
  boothTextsDue: { next: Date | null; opener: Date | null },
): NextDue {
  const regular = ((): NextDue => {
    // The deadline ends the producer-facing texts, exactly as in the engine: once it has passed or been
    // processed (an admin close can process it early) neither the check-in text nor a reminder is "next",
    // even for a slot the engine never recorded because it was idle across it.
    const deadlineOver = !!date.actions.deadline_processed_at || schedule.deadline_at.getTime() <= now.getTime();
    if (!deadlineOver) {
      if (!date.actions.checkin_sent_at) return { action: 'checkin', at: schedule.checkin_effective_at };
      const sentOffsets = new Set(date.actions.reminders_sent.map((r) => r.offset_min));
      for (const r of schedule.reminders) {
        if (sentOffsets.has(r.offset_min) || !r.reachable) continue;
        return { action: 'reminder', at: r.effective_at, offset_min: r.offset_min };
      }
    }
    if (!date.actions.deadline_processed_at) {
      return { action: 'deadline', at: schedule.deadline_at };
    }
    if (date.actions.summary_sent_at == null && date.actions.summary_skipped == null) {
      return { action: 'summary', at: schedule.summary_effective_at };
    }
    // A market with no booths set up has nothing to draft (the engine would only record `no_booths`),
    // so it is not announced as a pending step; this also keeps Phase 3 markets reading `none`.
    if (!date.actions.drafts_generated_at && hasBooths) {
      return { action: 'drafts', at: schedule.drafts_at };
    }
    if (boothTextsDue.next) return { action: 'booth_texts', at: boothTextsDue.next };
    return { action: 'none', at: null };
  })();
  // A season opener's own booth texts go out before its market, i.e. before any of the steps above.
  const opener = boothTextsDue.opener;
  if (opener && (regular.action === 'none' || !regular.at || opener.getTime() <= regular.at.getTime())) {
    return { action: 'booth_texts', at: opener };
  }
  return regular;
}

const resendQuerySchema = z.object({ producer_id: z.string().min(1) });
const closeBodySchema = z.object({ notify: z.boolean().default(false) });
const cycleSchema = z.enum(['next', 'opener']).default('next');
const draftBodySchema = z.object({ redraft: z.boolean().default(false), cycle: cycleSchema });
const changesBodySchema = z.object({
  changes: z
    .array(z.object({ producer_id: z.string().min(1), booth_ids: z.array(z.string().min(1)).max(2) }))
    .min(1, 'changes is required')
    .max(100),
  cycle: cycleSchema,
});
const approveBodySchema = z.object({ cycle: cycleSchema });
const resendTextQuerySchema = z.object({ producer_id: z.string().min(1), cycle: cycleSchema });
const SKIP_MESSAGES: Record<'no_next_date' | 'no_booths' | 'no_attendees', string> = {
  no_next_date: 'No upcoming market date to assign',
  no_booths: 'No booths are set up for this market',
  no_attendees: 'No vendors have said they are attending the next market',
};
const BLOCKED_MESSAGES: Record<'conflict' | 'cancelled' | 'started', string> = {
  conflict: 'Two vendors share a booth; resolve it before any booth text goes out',
  cancelled: 'The market these booths are for was cancelled; no booth texts are sent for it',
  started: 'The market these booths are for has already started; no booth texts are sent for it',
};
const NOT_TEXTABLE_MESSAGES: Record<string, string> = {
  no_phone: 'This producer has no phone number',
  invalid_phone: 'This producer has an invalid phone number',
  opted_out: 'This producer has opted out of texts',
  inactive_producer: 'This producer is inactive',
  not_a_current_vendor: 'This producer has no active membership at this market this season',
};

/** Who can be texted right now, for the per-vendor text status of the assignments view. */
async function loadTextability(db: FastifyInstance['db'], marketId: string, now: Date): Promise<Textability> {
  const { recipients, excluded } = await listRecipients(db, marketId, { now });
  return { recipients: new Set(recipients.map((r) => r.producer_id)), excluded: new Map(excluded.map((e) => [e.producer_id, e.reason])) };
}

/** The assignments view of one cycle, from a fresh read of the date. */
async function freshView(db: FastifyInstance['db'], market: FarmersMarket, date: MarketDateDoc, now: Date, cycle: CycleMode): Promise<AssignmentsView> {
  const fresh = (await loadDate(db, date.id)) ?? date;
  return buildAssignmentsView(db, market, fresh, now, { cycle, textable: await loadTextability(db, market.id, now) });
}

export async function marketDateRoutes(app: FastifyInstance) {
  // GET /api/market-dates/:id/status
  app.get<{ Params: { id: string } }>('/:id/status', { preHandler: [authenticate(app), requireStaff()] }, async (request, reply) => {
    const scoped = request.authUser! as unknown as ScopedUser;
    const date = await loadDate(app.db, request.params.id);
    if (!date) return reply.status(404).send({ error: 'Market date not found' });
    const market = await loadMarket(app.db, date.market_id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });
    if (!canAccessMarket(scoped, market.id)) return reply.status(403).send({ error: 'Forbidden: market not assigned' });

    const now = new Date();
    const schedule = computeSchedule(market, date);
    const { recipients, excluded } = await listRecipients(app.db, market.id, { now });

    const [checkinsSnap, messagesSnap, tokensSnap] = await Promise.all([
      app.db.collection('checkins').where('market_date_id', '==', date.id).get(),
      app.db.collection('messages').where('market_date_id', '==', date.id).get(),
      app.db.collection('link_tokens').where('market_date_id', '==', date.id).get(),
    ]);

    const checkinsByProducer = new Map<string, Record<string, unknown>>();
    for (const d of checkinsSnap.docs) checkinsByProducer.set(String((d.data() as Record<string, unknown>).producer_id ?? ''), d.data() as Record<string, unknown>);

    const messages = messagesSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }) as Record<string, unknown> & { id: string });
    const tokens = tokensSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }) as Record<string, unknown> & { id: string });

    const deadlineProcessedAt = date.actions.deadline_processed_at;

    const recipientRows = recipients.map((r) => {
      const checkin = checkinsByProducer.get(r.producer_id);
      const linkMsgs = messages.filter((m) => m.kind === 'checkin_link' && m.producer_id === r.producer_id);
      const reminderMsgs = messages.filter((m) => m.kind === 'checkin_reminder' && m.producer_id === r.producer_id);
      const producerTokens = tokens
        .filter((t) => t.producer_id === r.producer_id)
        .sort((a, b) => toMillisSafe(b.created_at) - toMillisSafe(a.created_at));
      const latestToken = producerTokens[0];
      const lastMsg = [...linkMsgs, ...reminderMsgs].sort((a, b) => toMillisSafe(b.created_at) - toMillisSafe(a.created_at))[0];
      const firstLinkMsg = [...linkMsgs].sort((a, b) => toMillisSafe(a.created_at) - toMillisSafe(b.created_at))[0];

      const responded = !!checkin;
      const submittedAt = checkin ? toDate(checkin.submitted_at) : null;
      const late = !!(responded && deadlineProcessedAt && submittedAt && submittedAt.getTime() > deadlineProcessedAt.getTime());

      return {
        producer_id: r.producer_id,
        business_name: r.business_name,
        contact_name: r.contact_name,
        phone: r.phone,
        responded,
        late,
        checkin: checkin
          ? {
              submitted_at: submittedAt,
              source: checkin.source,
              partial: checkin.partial,
              attending_next: (checkin.attending_next as boolean | null | undefined) ?? null,
            }
          : null,
        link_sent_at: firstLinkMsg ? toDate(firstLinkMsg.created_at) : null,
        link_sends: linkMsgs.length,
        reminders_sent: reminderMsgs.length,
        last_status: lastMsg ? (lastMsg.status as string) : null,
        token_expires_at: latestToken ? toDate(latestToken.expires_at) : null,
      };
    });

    // The booth assignments: the cycle every date has (its check-ins assign the next market) and, for the
    // season's first market date, the opener's own cycle (it assigns itself). The opener panel is offered
    // while that market is still ahead, and afterwards only if it was ever used.
    const textable: Textability = {
      recipients: new Set(recipients.map((r) => r.producer_id)),
      excluded: new Map(excluded.map((e) => [e.producer_id, e.reason])),
    };
    const assignments = await buildAssignmentsView(app.db, market, date, now, { cycle: 'next', textable });
    const isOpener = (await findSeasonOpener(app.db, market))?.id === date.id;
    const showOpener = date.actions.opener != null || (isOpener && date.status !== 'cancelled' && date.start_at.getTime() > now.getTime());
    const openerAssignments = showOpener ? await buildAssignmentsView(app.db, market, date, now, { cycle: 'opener', textable }) : null;

    const nextDue = computeNextDue(date, schedule, now, (await listBooths(app.db, market.id)).length > 0, {
      next: assignments.booth_texts_due_at,
      opener: openerAssignments?.booth_texts_due_at ?? null,
    });
    const inWindow = now.getTime() - date.end_at.getTime() <= SCAN_WINDOW_MS;
    const respondedCount = recipientRows.filter((r) => r.responded).length;

    return {
      date,
      market: { id: market.id, name: market.name, timezone: market.timezone, workflow: market.workflow, quiet_hours: market.quiet_hours },
      schedule,
      next_due: nextDue,
      in_window: inWindow,
      recipients: recipientRows,
      excluded,
      counts: {
        recipients: recipients.length,
        responded: respondedCount,
        non_responders: recipients.length - respondedCount,
        excluded: excluded.length,
      },
      assignments,
      /** Phase 4 fix: the season opener's own assignments (null on every other date). */
      opener_assignments: openerAssignments,
      is_season_opener: isOpener,
      messages: byDateDesc(
        messages.filter((m) => m.kind === 'checkin_link' || m.kind === 'checkin_reminder' || m.kind === 'deadline_summary'),
        'created_at',
      ).map((m) => ({
        id: m.id,
        kind: m.kind,
        to: m.to,
        producer_id: (m.producer_id as string | null | undefined) ?? null,
        user_id: (m.user_id as string | null | undefined) ?? null,
        status: m.status,
        segments: m.segments,
        created_at: toDate(m.created_at),
      })),
    };
  });

  // POST /api/market-dates/:id/resend-checkin?producer_id=
  app.post<{ Params: { id: string } }>(
    '/:id/resend-checkin',
    { preHandler: [authenticate(app), requireStaff()] },
    async (request, reply) => {
      const scoped = request.authUser! as unknown as ScopedUser;
      const user = request.authUser!;
      const date = await loadDate(app.db, request.params.id);
      if (!date) return reply.status(404).send({ error: 'Market date not found' });
      const market = await loadMarket(app.db, date.market_id);
      if (!market) return reply.status(404).send({ error: 'Market not found' });
      if (!canAccessMarket(scoped, market.id)) return reply.status(403).send({ error: 'Forbidden: market not assigned' });

      const parsed = resendQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
      const { producer_id } = parsed.data;

      const producerDoc = await app.db.collection('producers').doc(producer_id).get();
      if (!producerDoc.exists) return reply.status(404).send({ error: 'Producer not found' });
      const producer = producerDoc.data() as Record<string, unknown>;

      if (date.status !== 'collecting') {
        return reply.status(409).send({ error: 'This date is no longer collecting check-ins', reason: 'not_collecting' });
      }
      const schedule = computeSchedule(market, date);
      const now = new Date();
      if (schedule.deadline_at.getTime() + LINK_TOKEN_GRACE_MIN * 60_000 <= now.getTime()) {
        return reply.status(409).send({ error: 'The check-in window for this date has closed', reason: 'past_grace' });
      }

      // Only the market's current season counts (decision D33): a 2026 membership does not open a 2027 check-in.
      const membership = await findMembership(app.db, producer_id, market.id, currentSeason(market, now));
      if (!membership || membership.status !== 'active') {
        return reply.status(409).send({ error: 'This producer has no active membership at this market', reason: 'no_active_membership' });
      }
      if (producer.active === false) {
        return reply.status(409).send({ error: 'This producer is inactive', reason: 'inactive_producer' });
      }
      const phone = typeof producer.phone === 'string' ? producer.phone.trim() : '';
      const E164_RE = /^\+[1-9]\d{6,14}$/;
      if (!phone) return reply.status(409).send({ error: 'This producer has no phone number', reason: 'no_phone' });
      if (!E164_RE.test(phone)) return reply.status(409).send({ error: 'This producer has an invalid phone number', reason: 'invalid_phone' });
      if (producer.sms_opt_out_at) return reply.status(409).send({ error: 'This producer has opted out of texts', reason: 'opted_out' });

      const recipient = {
        producer_id,
        business_name: String(producer.business_name ?? ''),
        contact_name: String(producer.contact_name ?? ''),
        phone,
      };
      const send = await sendCheckinLink(app.db, app.env, market, date, recipient, {
        now,
        kind: 'checkin_link',
        created_by: user.id,
        sent_by: user.id,
      });

      await writeAudit(app.db, {
        actor_id: user.id,
        actor_role: user.role,
        action: 'market_date.checkin.resend',
        target: { collection: 'market_dates', id: date.id },
        after: { producer_id, message_id: send.message_id, status: send.status },
      });

      return {
        sms: { status: send.status, ...(send.error ? { error: send.error } : {}) },
        token_expires_at: (await app.db.collection('link_tokens').doc(send.token).get()).data()?.expires_at ?? null,
        message_id: send.message_id,
      };
    },
  );

  // POST /api/market-dates/:id/close
  app.post<{ Params: { id: string } }>('/:id/close', { preHandler: [authenticate(app), requireRole('admin')] }, async (request, reply) => {
    const user = request.authUser!;
    const date = await loadDate(app.db, request.params.id);
    if (!date) return reply.status(404).send({ error: 'Market date not found' });
    const market = await loadMarket(app.db, date.market_id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });

    const parsed = closeBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    const { notify } = parsed.data;

    const now = new Date();
    if (date.status !== 'collecting' || date.end_at.getTime() >= now.getTime() || date.actions.deadline_processed_at) {
      return reply.status(409).send({ error: 'This date cannot be closed' });
    }

    const result = await processDeadline(app.db, app.env, market, date, { now, notify, actor: user.id });
    if (!result.processed) {
      return reply.status(409).send({
        error: result.summary === 'in_progress' ? 'The engine is processing this deadline right now; refresh the status page' : 'This date was already processed',
      });
    }

    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'market_date.close',
      target: { collection: 'market_dates', id: date.id },
      after: { non_responders: result.non_responders, notify },
    });

    const updated = await loadDate(app.db, date.id);
    return { result, date: updated };
  });

  // ── Phase 4: booth assignments (contract §3.4) ───────────────────────────

  // POST /api/market-dates/:id/assignments/draft
  app.post<{ Params: { id: string } }>('/:id/assignments/draft', { preHandler: [authenticate(app), requireStaff()] }, async (request, reply) => {
    const scoped = request.authUser! as unknown as ScopedUser;
    const user = request.authUser!;
    const date = await loadDate(app.db, request.params.id);
    if (!date) return reply.status(404).send({ error: 'Market date not found' });
    const market = await loadMarket(app.db, date.market_id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });
    if (!canAccessMarket(scoped, market.id)) return reply.status(403).send({ error: 'Forbidden: market not assigned' });

    const parsed = draftBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    if (date.status === 'cancelled') return reply.status(409).send({ error: 'This date was cancelled' });
    const { cycle, redraft } = parsed.data;

    const now = new Date();
    const outcome = await draftNow(app.db, market, date, { now, actor: user.id, redraft, cycle });
    switch (outcome.status) {
      case 'approved':
        return reply.status(409).send({ error: 'Assignments are approved; redraft is closed', reason: 'approved' });
      case 'already_drafted':
        return reply.status(409).send({ error: 'Already drafted', reason: 'already_drafted' });
      case 'in_progress':
        return reply.status(409).send({ error: 'The engine is drafting this date right now; refresh the page', reason: 'in_progress' });
      case 'not_opener':
        return reply.status(409).send({ error: 'This date is not the first market date of the season', reason: 'not_opener' });
      case 'not_ended':
        return reply.status(409).send({
          error: 'This market has not ended yet; the next market is assigned from its check-ins once it has',
          reason: 'not_ended',
        });
      case 'season_mismatch':
        return reply.status(409).send({
          error: 'This opening day belongs to a season the market is not in yet; set the season on the market before drafting it',
          reason: 'season_mismatch',
        });
      case 'skipped':
        return reply.status(409).send({ error: SKIP_MESSAGES[outcome.reason], reason: outcome.reason });
      default:
        break;
    }

    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'market_date.assignments.draft',
      target: { collection: 'market_dates', id: date.id },
      after: {
        cycle,
        redraft,
        target_date_id: outcome.draft.target_date_id,
        vendors_placed: outcome.draft.vendors_placed,
        vendors_unassigned: outcome.draft.vendors_unassigned,
        superseded: outcome.draft.superseded,
      },
    });

    return { draft: outcome.draft, assignments: await freshView(app.db, market, date, now, cycle) };
  });

  // PATCH /api/market-dates/:id/assignments
  // Allowed before approval, after approval and after the booth texts went out (Phase 4 fix): a change
  // after approval that creates no double booking is saved, and the engine then texts each vendor whose
  // booths changed exactly once (and a vendor taken off the date a release notice), outside quiet hours.
  app.patch<{ Params: { id: string } }>('/:id/assignments', { preHandler: [authenticate(app), requireStaff()] }, async (request, reply) => {
    const scoped = request.authUser! as unknown as ScopedUser;
    const user = request.authUser!;
    const date = await loadDate(app.db, request.params.id);
    if (!date) return reply.status(404).send({ error: 'Market date not found' });
    const market = await loadMarket(app.db, date.market_id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });
    if (!canAccessMarket(scoped, market.id)) return reply.status(403).send({ error: 'Forbidden: market not assigned' });

    const parsed = changesBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    const { cycle, changes } = parsed.data;

    const now = new Date();
    const result = await applyAssignmentChanges(app.db, market, date, changes, user.id, now, cycle);
    if (!result.ok) {
      return reply.status(result.status).send({
        error: result.error,
        ...(result.code ? { code: result.code, reason: result.code } : {}),
        ...(result.booth_id ? { booth_id: result.booth_id, booth_label: result.booth_label } : {}),
      });
    }

    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'market_date.assignments.update',
      target: { collection: 'market_dates', id: date.id },
      after: { cycle, target_date_id: result.target_date_id, changes, changed: result.changed },
    });

    const assignments = await freshView(app.db, market, date, now, cycle);
    return assignments.approved_at ? { assignments, warning: 'approved' } : { assignments };
  });

  // POST /api/market-dates/:id/assignments/approve
  app.post<{ Params: { id: string } }>('/:id/assignments/approve', { preHandler: [authenticate(app), requireStaff()] }, async (request, reply) => {
    const scoped = request.authUser! as unknown as ScopedUser;
    const user = request.authUser!;
    const date = await loadDate(app.db, request.params.id);
    if (!date) return reply.status(404).send({ error: 'Market date not found' });
    const market = await loadMarket(app.db, date.market_id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });
    if (!canAccessMarket(scoped, market.id)) return reply.status(403).send({ error: 'Forbidden: market not assigned' });
    if (date.status === 'cancelled') return reply.status(409).send({ error: 'This date was cancelled' });

    const parsed = approveBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    const { cycle } = parsed.data;

    const now = new Date();
    const outcome = await approveAssignments(app.db, app.env, market, date, { now, user_id: user.id, cycle });
    if (outcome.status !== 'approved') {
      switch (outcome.status) {
        case 'no_draft':
          return reply.status(409).send({ error: 'There is no draft to approve yet', reason: 'no_draft' });
        case 'conflicts':
          return reply.status(409).send({ error: 'Two vendors share a booth; resolve it before approving', reason: 'conflicts' });
        case 'target_cancelled':
          return reply.status(409).send({
            error: 'The market these booths are for was cancelled; redraft to assign the next market date',
            reason: 'target_cancelled',
            code: 'target_cancelled',
          });
        case 'target_started':
          return reply.status(409).send({
            error: 'The market these booths are for has already started; its assignments can no longer be approved',
            reason: 'target_started',
            code: 'target_started',
          });
        case 'already_approved':
          return reply.status(409).send({ error: 'Assignments are already approved', reason: 'already_approved' });
        default:
          return reply.status(409).send({ error: 'Another approval is in progress; refresh the page', reason: 'in_progress' });
      }
    }

    const t = outcome.texts;
    const texts = {
      attempted: t.status === 'sent',
      sent: t.status === 'sent' ? t.sent : 0,
      failed: t.status === 'sent' ? t.failed : 0,
      excluded: t.status === 'sent' ? t.excluded : 0,
      deferred_until: t.status === 'deferred' ? t.deferred_until : null,
    };
    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'market_date.assignments.approve',
      target: { collection: 'market_dates', id: date.id },
      after: { cycle, texts },
    });

    return { assignments: await freshView(app.db, market, date, now, cycle), texts };
  });

  // POST /api/market-dates/:id/assignments/resend-text?producer_id=[&cycle=]
  // One vendor's booth text again, on purpose (no dedupe key): for a text the provider failed, a vendor
  // who could not be texted when the texts went out, or one who asks. Never inside quiet hours.
  app.post<{ Params: { id: string } }>('/:id/assignments/resend-text', { preHandler: [authenticate(app), requireStaff()] }, async (request, reply) => {
    const scoped = request.authUser! as unknown as ScopedUser;
    const user = request.authUser!;
    const date = await loadDate(app.db, request.params.id);
    if (!date) return reply.status(404).send({ error: 'Market date not found' });
    const market = await loadMarket(app.db, date.market_id);
    if (!market) return reply.status(404).send({ error: 'Market not found' });
    if (!canAccessMarket(scoped, market.id)) return reply.status(403).send({ error: 'Forbidden: market not assigned' });

    const parsed = resendTextQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    const { producer_id, cycle } = parsed.data;

    const now = new Date();
    const outcome = await resendBoothText(app.db, app.env, market, date, { now, producer_id, user_id: user.id, cycle });
    switch (outcome.status) {
      case 'not_approved':
        return reply.status(409).send({ error: 'These assignments are not approved yet; no booth text has gone out', code: 'not_approved', reason: 'not_approved' });
      case 'quiet_hours':
        return reply.status(409).send({
          error: 'Quiet hours: booth texts cannot be sent right now',
          code: 'quiet_hours',
          reason: 'quiet_hours',
          allowed_at: outcome.allowed_at,
        });
      case 'blocked':
        return reply.status(409).send({ error: BLOCKED_MESSAGES[outcome.reason], code: outcome.reason, reason: outcome.reason });
      case 'nothing_to_send':
        return reply.status(409).send({ error: 'This vendor has no booth text for this date', code: 'nothing_to_send', reason: 'nothing_to_send' });
      case 'pending':
        return reply.status(409).send({ error: 'This booth text is already on its way; it goes out with the next engine run', code: 'pending', reason: 'pending' });
      case 'not_textable':
        return reply.status(409).send({
          error: NOT_TEXTABLE_MESSAGES[outcome.reason] ?? 'This producer cannot be texted',
          code: 'not_textable',
          reason: outcome.reason,
        });
      default:
        break;
    }

    await writeAudit(app.db, {
      actor_id: user.id,
      actor_role: user.role,
      action: 'market_date.assignments.resend_text',
      target: { collection: 'market_dates', id: date.id },
      after: { cycle, producer_id, type: outcome.type, message_id: outcome.message_id, status: outcome.sms },
    });

    return {
      sms: { status: outcome.sms, ...(outcome.error ? { error: outcome.error } : {}) },
      type: outcome.type,
      message_id: outcome.message_id,
      assignments: await freshView(app.db, market, date, now, cycle),
    };
  });
}
