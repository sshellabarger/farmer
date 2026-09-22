import type { FastifyInstance } from 'fastify';
import { resolveCheckinToken, markTokenUsed } from '../services/link-tokens.js';
import { checkinSubmitSchema, validateExtraAnswers, upsertFormCheckin, toFormValues } from '../services/checkins-submit.js';
import { computeSchedule, formatLocalStamp } from '../services/checkin-workflow.js';
import { parseDate, weekdayOf } from '../utils/tz.js';
import type { FarmersMarket } from '../services/markets.js';

/**
 * The public, no-login check-in link (Phase 3 contract §4.1). Never mints a
 * JWT: producers reach this purely by the token in the URL.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_LABELS: Record<string, string> = {
  sunday: 'Sunday',
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
};

/** 'YYYY-MM-DD' → 'Saturday, Sep 19, 2026' (calendar-date formatting, zone-independent). */
function formatDateLabel(date: string): string {
  const { y, m, d } = parseDate(date);
  return `${WEEKDAY_LABELS[weekdayOf(date)]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

export async function checkinPublicRoutes(app: FastifyInstance) {
  // GET /api/checkin/:token
  app.get('/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const now = new Date();
    const resolved = await resolveCheckinToken(app.db, token, now);
    if (resolved.status === 'unknown') return reply.status(404).send({ error: 'Unknown link' });
    if (resolved.status === 'expired') return reply.status(410).send({ error: 'This link has expired' });

    const { token: t, date } = resolved;
    const [marketDoc, producerDoc] = await Promise.all([
      app.db.collection('farmers_markets').doc(t.market_id).get(),
      app.db.collection('producers').doc(t.producer_id).get(),
    ]);
    if (!marketDoc.exists || !producerDoc.exists) return reply.status(410).send({ error: 'This link has expired' });
    const market = { id: marketDoc.id, ...(marketDoc.data() as Record<string, unknown>) } as FarmersMarket;
    const producer = producerDoc.data() as Record<string, unknown>;

    const schedule = computeSchedule(market, date);
    const existingDoc = await app.db.collection('checkins').doc(`${date.id}_${t.producer_id}`).get();
    let existing: (ReturnType<typeof toFormValues> & { submitted_at: unknown; source: unknown; partial: unknown }) | null = null;
    if (existingDoc.exists) {
      const data = existingDoc.data() as Record<string, unknown>;
      existing = { ...toFormValues(data), submitted_at: data.submitted_at, source: data.source, partial: data.partial };
    }

    return {
      producer_name: (producer.business_name as string) ?? '',
      contact_name: (producer.contact_name as string) ?? '',
      market_id: market.id,
      market_name: market.name,
      market_date_id: date.id,
      date: date.date,
      date_label: formatDateLabel(date.date),
      start_time: date.start_time,
      end_time: date.end_time,
      deadline_at: schedule.deadline_at,
      deadline_label: formatLocalStamp(schedule.deadline_at, market.timezone),
      past_deadline: schedule.deadline_at.getTime() <= now.getTime(),
      expires_at: t.expires_at,
      questions: { extra_questions: date.extra_questions },
      existing,
    };
  });

  // POST /api/checkin/:token
  app.post('/:token', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const now = new Date();
    const resolved = await resolveCheckinToken(app.db, token, now);
    if (resolved.status === 'unknown') return reply.status(404).send({ error: 'Unknown link' });
    if (resolved.status === 'expired') return reply.status(410).send({ error: 'This link has expired' });
    const { token: t, date } = resolved;

    const parsed = checkinSubmitSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    const input = parsed.data;

    const extraError = validateExtraAnswers(date.extra_questions, input.extra_answers);
    if (extraError) return reply.status(400).send({ error: extraError });

    const doc = await upsertFormCheckin(app.db, {
      market_date_id: date.id,
      market_id: date.market_id,
      producer_id: t.producer_id,
      token_id: t.token,
      input,
      now,
    });
    await markTokenUsed(app.db, t.token, now);

    return {
      ok: true as const,
      checkin: { ...toFormValues(doc as unknown as Record<string, unknown>), submitted_at: doc.submitted_at, submissions: doc.submissions },
    };
  });
}
