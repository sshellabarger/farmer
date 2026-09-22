import type { Firestore } from 'firebase-admin/firestore';
import type { FastifyBaseLogger } from 'fastify';
import { v4 as uuid } from 'uuid';
import type { Env } from '../config/env.js';
import { trySendSms, type SmsKind } from './sms.js';
import { checkinUrl, findOpenCheckin, recordAttendingNext, staffForMarket, toDate } from './open-checkin.js';

/**
 * Phase 3 inbound handler (SPEC §7.4, Phase 3 contract §5.1).
 *
 * Order: (1) log every inbound text to `messages`; (2) look up a matching
 * `users` row (staff) and a matching `producers` row; (3) STOP/START always
 * reply, on either kind of match, even to an unknown number; (4) for a known
 * producer — HELP (with a check-in link when one is open), YES/NO against an
 * open check-in, otherwise forward the text to market staff plus a once-per-
 * 24h courtesy reply; (5) for everyone else (no producer match — including a
 * known staff user or a wholly unknown number) the Phase 1 stopgap behaviour
 * is unchanged: HELP, then a one-line "service has changed" reply at most
 * once per 24 h, never a loop.
 *
 * Every outbound reply goes through `trySendSms`, which logs it to
 * `messages` and never throws: voip.ms retries non-200 webhook responses,
 * which would reprocess the inbound text.
 */

export const STOP_KEYWORDS = new Set(['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
export const START_KEYWORDS = new Set(['START', 'UNSTOP']);
export const HELP_KEYWORDS = new Set(['HELP']);
export const YES_KEYWORDS = new Set(['YES', 'Y', 'YEAH', 'YEP', 'YUP']);
export const NO_KEYWORDS = new Set(['NO', 'N', 'NOPE', 'NAH']);

export const REPLIES = {
  unsubscribed: "You're unsubscribed from SJCA Markets texts. Reply START to resubscribe.",
  resubscribed: "You're resubscribed to SJCA Markets texts.",
  help: 'SJCA Markets: farmers market texts from St. Joseph Center of Arkansas. Reply STOP to opt out, START to rejoin.',
  help_with_link: (market: string, link: string) => `SJCA Markets: your ${market} check-in link is ${link}\nReply STOP to opt out.`,
  attending_yes: (market: string, link: string) =>
    `Got it - you're marked as attending the next ${market}. Please add what you're bringing and the rest of your check-in here: ${link}`,
  attending_no: (market: string, link: string) => `Got it - you're marked as not attending the next ${market}. You can change that here: ${link}`,
  received: 'Thanks - your message has been passed to SJCA Markets staff.',
  received_with_link: (link: string) => `Thanks - your message has been passed to SJCA Markets staff. Your check-in link: ${link}`,
  // unchanged: unknown numbers (and any non-producer match) keep today's behaviour
  closed: "Thanks. FarmLink's ordering service has closed and is becoming the SJCA farmers market manager. A team member will follow up.",
} as const;

export type OutboundKind = Extract<SmsKind, 'opt_out_confirm' | 'opt_in_confirm' | 'help' | 'auto_reply' | 'forwarded_inbound'>;

// Only one "service has changed" / courtesy auto-reply per phone per window.
const AUTO_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

// A forwarded text's body is capped at 300 chars total, ASCII ellipsis.
const FORWARD_BODY_MAX = 300;

/** `body.trim().toUpperCase()` with trailing punctuation/whitespace stripped. */
export function normalizeKeyword(body: string): string {
  return body.trim().toUpperCase().replace(/[.!?,\s]+$/, '');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * True if an outbound *courtesy* reply (`kind: 'auto_reply'`) went out to
 * this phone within the window. Deliberately excludes `checkin_link`,
 * `checkin_reminder` and `forwarded_inbound` rows: a workflow text or a
 * forwarded message must not suppress the acknowledgement. A `simulated` row
 * (console provider) counts the same as `sent`.
 */
async function repliedRecently(db: Firestore, phone: string, now: Date): Promise<boolean> {
  // One equality filter at the DB, the rest in memory (repo convention; no
  // composite index needed).
  const snap = await db.collection('messages').where('to', '==', phone).get();
  const cutoff = now.getTime() - AUTO_REPLY_WINDOW_MS;
  return snap.docs.some((d) => {
    const m = d.data();
    if (m.direction !== 'outbound') return false;
    if (m.kind !== 'auto_reply') return false;
    if (m.status !== 'sent' && m.status !== 'simulated') return false;
    const at = toDate(m.created_at);
    return !!at && at.getTime() >= cutoff;
  });
}

/** The producer's first `active` membership market id, sorted by market id, or null. */
async function firstActiveMembershipMarketId(db: Firestore, producerId: string): Promise<string | null> {
  const snap = await db.collection('producer_memberships').where('producer_id', '==', producerId).get();
  const activeMarketIds = snap.docs
    .map((d) => d.data() as Record<string, unknown>)
    .filter((m) => m.status === 'active')
    .map((m) => String(m.market_id ?? ''))
    .filter((id) => id.length > 0)
    .sort((a, b) => a.localeCompare(b));
  return activeMarketIds[0] ?? null;
}

async function marketNameOf(db: Firestore, marketId: string): Promise<string> {
  if (!marketId) return '';
  const doc = await db.collection('farmers_markets').doc(marketId).get();
  if (!doc.exists) return '';
  const data = doc.data() as Record<string, unknown> | undefined;
  return typeof data?.name === 'string' ? data.name : '';
}

export async function handleInboundText({
  db,
  env,
  log,
  from,
  body,
  providerMessageId,
}: {
  db: Firestore;
  env: Env;
  log: FastifyBaseLogger;
  from: string;
  body: string;
  providerMessageId: string;
}): Promise<void> {
  const now = new Date();

  // (1) Log the inbound text. This is the only record of it.
  const inboundMessageId = uuid();
  await db.collection('messages').doc(inboundMessageId).set({
    direction: 'inbound',
    from,
    to: env.VOIPMS_DID ?? '',
    body,
    provider: 'voipms',
    provider_message_id: providerMessageId,
    status: 'received',
    status_at: now,
    error: null,
    kind: 'inbound',
    segments: 1,
    created_at: now,
  });

  // (2) Lookups.
  const userSnap = await db.collection('users').where('phone', '==', from).limit(1).get();
  const userRef = userSnap.empty ? null : userSnap.docs[0].ref;
  const userData = userSnap.empty ? null : userSnap.docs[0].data();
  const userId = userSnap.empty ? null : userSnap.docs[0].id;

  const producerSnap = await db.collection('producers').where('phone', '==', from).limit(1).get();
  const producerRef = producerSnap.empty ? null : producerSnap.docs[0].ref;
  const producerData = producerSnap.empty ? null : producerSnap.docs[0].data();
  const producerId = producerSnap.empty ? null : producerSnap.docs[0].id;

  const keyword = normalizeKeyword(body);
  const firstWord = keyword.split(/\s+/)[0] ?? '';

  const reply = async (
    text: string,
    kind: OutboundKind,
    opts: { user_id?: string | null; producer_id?: string | null; market_date_id?: string | null } = {},
  ) => {
    const result = await trySendSms({
      db,
      env,
      to: from,
      body: text,
      kind,
      user_id: opts.user_id ?? userId,
      producer_id: opts.producer_id ?? producerId,
      market_date_id: opts.market_date_id ?? null,
    });
    if (!result.ok) log.warn({ to: from, kind, error: result.error }, 'Inbound auto-reply failed to send');
  };

  // (3) Keywords that apply to either kind of match (or neither). STOP/START
  // always get their confirmation (carrier norms), even when the number is
  // unknown or already opted out.
  if (STOP_KEYWORDS.has(keyword)) {
    if (userRef) await userRef.update({ sms_opt_out_at: now, updated_at: now }).catch((err: unknown) => log.error(err, 'Failed to record opt-out (user)'));
    if (producerRef) {
      await producerRef
        .update({ sms_opt_out_at: now, sms_consent: { status: 'opted_out', at: now, source: 'sms' }, updated_at: now })
        .catch((err: unknown) => log.error(err, 'Failed to record opt-out (producer)'));
    }
    await reply(REPLIES.unsubscribed, 'opt_out_confirm');
    return;
  }

  if (START_KEYWORDS.has(keyword)) {
    if (userRef) await userRef.update({ sms_opt_out_at: null, updated_at: now }).catch((err: unknown) => log.error(err, 'Failed to clear opt-out (user)'));
    if (producerRef) {
      await producerRef
        .update({ sms_opt_out_at: null, sms_consent: { status: 'opted_in', at: now, source: 'sms' }, updated_at: now })
        .catch((err: unknown) => log.error(err, 'Failed to clear opt-out (producer)'));
    }
    await reply(REPLIES.resubscribed, 'opt_in_confirm');
    return;
  }

  // (4) A known producer gets the check-in workflow treatment.
  if (producerRef && producerData && producerId) {
    const open = await findOpenCheckin(db, producerId, now);
    const marketId = open?.market_id ?? (await firstActiveMembershipMarketId(db, producerId)) ?? '';
    const marketName = await marketNameOf(db, marketId);
    const link = open ? checkinUrl(env.APP_URL, open.token) : null;

    if (HELP_KEYWORDS.has(keyword)) {
      const text = open && link ? REPLIES.help_with_link(marketName, link) : REPLIES.help;
      await reply(text, 'help');
      return;
    }

    if (open && link && YES_KEYWORDS.has(firstWord)) {
      await recordAttendingNext(db, open, true, body.trim(), now);
      await reply(REPLIES.attending_yes(marketName, link), 'auto_reply', { market_date_id: open.market_date_id });
      return;
    }

    if (open && link && NO_KEYWORDS.has(firstWord)) {
      await recordAttendingNext(db, open, false, body.trim(), now);
      await reply(REPLIES.attending_no(marketName, link), 'auto_reply', { market_date_id: open.market_date_id });
      return;
    }

    // Anything else from a known producer: forward once per inbound to the
    // market's staff (skipping a staff phone equal to the sender), then the
    // once-per-24h courtesy reply.
    const staff = await staffForMarket(db, marketId);
    const forwardBody = truncate(
      marketName ? `Text from ${producerData.business_name as string} (${marketName}): ${body}` : `Text from ${producerData.business_name as string}: ${body}`,
      FORWARD_BODY_MAX,
    );
    for (const s of staff) {
      if (s.phone === from) continue;
      const result = await trySendSms({
        db,
        env,
        to: s.phone,
        body: forwardBody,
        kind: 'forwarded_inbound',
        user_id: s.user_id,
        producer_id: producerId,
        extra: { inbound_message_id: inboundMessageId },
        // At most one forward per inbound row per staff member (Phase 3 fix).
        dedupe_key: `forwarded_inbound:${inboundMessageId}:${s.user_id}`,
      });
      if (!result.ok && !result.duplicate) log.warn({ to: s.phone, kind: 'forwarded_inbound', error: result.error }, 'Inbound forward failed to send');
    }

    if (producerData.sms_opt_out_at) return;
    if (await repliedRecently(db, from, now)) return;
    const courtesy = open && link ? REPLIES.received_with_link(link) : REPLIES.received;
    await reply(courtesy, 'auto_reply');
    return;
  }

  // (5) No producer match (a known staff user, or a wholly unknown number):
  // today's Phase 1 stopgap behaviour, unchanged.
  if (HELP_KEYWORDS.has(keyword)) {
    await reply(REPLIES.help, 'help');
    return;
  }

  if (userData?.sms_opt_out_at) return;
  if (await repliedRecently(db, from, now)) return;
  await reply(REPLIES.closed, 'auto_reply');
}
