import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { authenticate, requireRole } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.js';
import { isAlreadyExists } from '../db/firestore.js';
import {
  canTransition,
  createMembership,
  findProducerByEmail,
  findProducerByPhone,
  isActiveBooth,
  upsertProducerByEmail,
  type MembershipStatus,
  type ProductEntry,
} from '../services/producers.js';
import { normalizeEmail } from '../services/identity.js';
import { normalizePhone } from './sms.js';
import { byDateDesc } from '../utils/sort.js';
import { toDate } from '../utils/dates.js';
import type { FarmersMarket, ProductTypeConfig } from '../services/markets.js';
import { applicationsOpen, marketCategories, marketFees, marketLegal, marketPaymentLinks, marketProductTypes } from '../services/markets.js';
import {
  MARKET_ID_RE,
  SUBMISSION_LIMITS,
  acquireStaffLock,
  applicationSubmitSchema,
  approvalLockId,
  buildApplicationConfig,
  claimApplicationKey,
  computeSeasonTotal,
  fillPaymentUrl,
  firstSeasonDate,
  flattenItems,
  isLegacyApplication,
  isLiveApplication,
  producerIdentityLockId,
  projectApplicationListItem,
  releaseApplicationKey,
  releaseStaffLock,
  summarizeSeason,
  type ApplicationSubmitInput,
  type SeasonTotal,
  type StaffLock,
} from '../services/applications.js';
import {
  DRAFT_ID_RE,
  UPLOAD_LIMITS,
  UploadError,
  saveApplicationUpload,
  utcDay,
  type UploadMeta,
} from '../services/application-uploads.js';
import {
  currentSeason,
  findMembership,
  insuranceExpiryInstant,
  listMembershipsForProducer,
  membershipFromData,
  membershipViewFor,
  type MembershipStaffView,
} from '../services/seasons.js';
import { markPurposeTokenUsed, mintPurposeToken, purposeTokenUrl, resolvePurposeToken } from '../services/purpose-tokens.js';
import { AGREEMENT_TOKEN_DAYS, sendAcceptance } from '../services/invites.js';

const E164_RE = /^\+[1-9]\d{6,14}$/;
const MONTH_KEYS = new Set(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
const DAY_MS = 24 * 60 * 60 * 1000;

/** First zod issue as a one-line message; a bare "Required"-style default gets its field path in front. */
function issueMessage(issues: z.ZodIssue[]): string {
  const issue = issues[0]!;
  const generic = /^(Required|Invalid|Expected|String must|Number must|Array must)/.test(issue.message);
  return generic && issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}

async function loadMarket(db: FastifyInstance['db'], id: string): Promise<FarmersMarket | null> {
  const doc = await db.collection('farmers_markets').doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...(doc.data() as Record<string, unknown>) } as FarmersMarket;
}

const queueQuerySchema = z.object({
  market_id: z.string().optional(),
  season: z.string().optional(),
  status: z.enum(['new', 'under_review', 'approved', 'declined', 'withdrawn']).optional(),
  fee: z.enum(['unpaid', 'paid', 'waived']).optional(),
  category: z.string().optional(),
  returning: z.enum(['true', 'false']).optional(),
  q: z.string().optional(),
});

const str = (max: number) => z.string().trim().max(max);

const applicationActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('review') }),
  z.object({ action: z.literal('withdraw') }),
  z.object({ action: z.literal('note'), notes: str(5000) }),
  z.object({ action: z.literal('fee'), status: z.enum(['paid', 'waived', 'unpaid']), reference: str(120).optional() }),
  z.object({ action: z.literal('decline'), reason: str(2000) }),
  z.object({
    action: z.literal('approve'),
    fee_plan: z.enum(['seasonal', 'daily']),
    spaces: z.union([z.literal(1), z.literal(2)]),
    electric: z.boolean(),
    pay_in_full: z.boolean(),
    booth_kind: z.enum(['stall', 'food_truck']).default('stall'),
    usual_booth_id: z.string().min(1).nullable().default(null),
    trial_period: z.boolean().default(false),
    note: str(2000).default(''),
    send: z.boolean().default(true),
  }),
]);

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});

/**
 * Permit rules (contract §3.1): every selected product type whose rule is
 * `required` needs a permit that is uploaded or promised; a
 * `required_unless_food_freedom` type also accepts the Food Freedom answer.
 * Returns an error message or null.
 */
function checkPermits(types: ProductTypeConfig[], selected: ProductEntry[], permits: ApplicationSubmitInput['permits']): string | null {
  for (const entry of selected) {
    const type = types.find((t) => t.key === entry.type)!;
    const permit = permits[entry.type];
    if (type.permit_upload === 'required') {
      if (!permit || (permit.status !== 'uploaded' && permit.status !== 'will_provide')) {
        return `A permit is required for ${type.label}: upload it or say you will provide it before your first market`;
      }
    } else if (type.permit_upload === 'required_unless_food_freedom') {
      if (!permit || (permit.status !== 'uploaded' && permit.status !== 'will_provide' && permit.status !== 'food_freedom')) {
        return `${type.label}: upload a permit, say you will provide one, or confirm the products are Food Freedom labeled`;
      }
    }
  }
  return null;
}

/**
 * Tells staff about something that is not an error response but needs a human
 * (a flood cap was reached). `buildApp()` supplies it; it is throttled per
 * message by the alert pipeline and never throws. Absent (a route mounted on
 * its own in a test, or `notifyOnError: false`) nothing is sent.
 */
export type AlertStaff = (message: string, source: string) => Promise<void>;

export interface ApplicationRouteOptions {
  alertStaff?: AlertStaff;
}

export async function applicationRoutes(app: FastifyInstance, opts: ApplicationRouteOptions = {}) {
  const adminOnly = [authenticate(app), requireRole('admin')];
  const alertStaff: AlertStaff = opts.alertStaff ?? (async () => {});

  // ─────────────────────────── public ───────────────────────────

  // GET /api/applications/config?market=
  app.get('/config', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = z.object({ market: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/) }).safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: issueMessage(parsed.error.issues) });
    const market = await loadMarket(app.db, parsed.data.market);
    if (!market || market.active !== true) return reply.status(404).send({ error: 'Market not found' });
    return buildApplicationConfig(app.db, market, new Date());
  });

  // POST /api/applications/uploads (multipart: market, draft_id, kind, file)
  //
  // Fix X2: a file is only accepted for a market that exists, is active and is
  // taking applications right now, so the endpoint is closed outside a season's
  // window. The per-IP limit, the per-draft cap and the global daily cap
  // (application-uploads.ts) bound what one caller, one draft and everyone
  // together can store.
  app.post('/uploads', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (request, reply) => {
    if (!request.isMultipart()) return reply.status(400).send({ error: 'Send multipart/form-data with market, draft_id, kind and file' });
    const fields: Record<string, string> = {};
    let file: { filename: string; mimetype: string; buffer: Buffer } | null = null;
    let extraFiles = 0;
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (file) {
            extraFiles += 1;
            part.file.resume();
            continue;
          }
          const buffer = await part.toBuffer();
          file = { filename: part.filename, mimetype: part.mimetype, buffer };
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: 'The file is larger than 10 MB' });
      throw err;
    }
    if (!file) return reply.status(400).send({ error: 'file is required' });
    if (extraFiles > 0) return reply.status(400).send({ error: 'Send one file at a time' });
    if (!fields.draft_id || !DRAFT_ID_RE.test(fields.draft_id)) return reply.status(400).send({ error: 'draft_id must be a UUID' });
    if (!fields.kind) return reply.status(400).send({ error: 'kind is required' });
    if (!fields.market || !MARKET_ID_RE.test(fields.market)) return reply.status(400).send({ error: 'market is required' });

    const now = new Date();
    const market = await loadMarket(app.db, fields.market);
    if (!market || market.active !== true) return reply.status(404).send({ error: 'Market not found' });
    if (!applicationsOpen(market, now)) return reply.status(409).send({ error: 'Applications are closed for this market' });

    try {
      const saved = await saveApplicationUpload({
        db: app.db,
        storage: app.storage,
        draft_id: fields.draft_id,
        kind: fields.kind,
        filename: file.filename,
        mime: file.mimetype,
        buffer: file.buffer,
        ip: request.ip,
        now,
      });
      return reply.status(201).send(saved);
    } catch (err) {
      if (err instanceof UploadError) {
        if (err.status === 503) {
          await alertStaff(
            `Application uploads reached the daily cap of ${UPLOAD_LIMITS.daily_global} files; more are refused until 00:00 UTC`,
            'api:applications/uploads',
          );
        }
        return reply.status(err.status).send({ error: err.message });
      }
      throw err;
    }
  });

  // POST /api/applications (public)
  app.post('/', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const parsed = applicationSubmitSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: issueMessage(parsed.error.issues) });
    const input = parsed.data;
    const now = new Date();

    const market = await loadMarket(app.db, input.market_id);
    if (!market || market.active !== true) return reply.status(404).send({ error: 'Market not found' });
    if (!applicationsOpen(market, now)) return reply.status(409).send({ error: 'Applications are closed for this market' });
    const season = market.season!.label;

    // A prefill link must be live, for this market.
    let prefillProducerId: string | null = null;
    if (input.prefill_token) {
      const resolved = await resolvePurposeToken(app.db, input.prefill_token, 'application', now);
      if (resolved.status !== 'ok' || resolved.token.market_id !== market.id) {
        return reply.status(410).send({ error: 'This link has expired. You can still apply without it.' });
      }
      prefillProducerId = resolved.token.producer_id;
    }

    const legal = marketLegal(market);
    if (legal.rules_version !== '' && input.rules_version !== legal.rules_version) {
      return reply.status(400).send({ error: 'Please re-read the current rules' });
    }
    // The consent that is stored as evidence must be consent to the wording the market
    // publishes NOW: a version the client made up, or one from a form loaded before the
    // text changed, is refused (fix X3c).
    if (legal.sms_consent_version !== '' && input.sms_consent_version !== legal.sms_consent_version) {
      return reply.status(409).send({
        error: 'The text message consent wording has changed. Please reload the form, review it and submit again.',
        code: 'sms_consent_changed',
      });
    }

    const email = normalizeEmail(input.contact.email);
    if (!email) return reply.status(400).send({ error: 'Invalid email' });
    const mobile = normalizePhone(input.contact.mobile);
    if (!E164_RE.test(mobile)) return reply.status(400).send({ error: 'Enter a valid mobile number' });

    // Categories, product types, permits.
    const categories = marketCategories(market);
    const categoryKeys = new Set(categories.map((c) => c.key));
    const types = marketProductTypes(market);
    const unknownCategory = input.categories.find((k) => !categoryKeys.has(k));
    if (unknownCategory) return reply.status(400).send({ error: `Unknown category '${unknownCategory}'` });

    const products: (ProductEntry & { category: string })[] = [];
    for (const entry of input.products) {
      const type = types.find((t) => t.key === entry.type);
      if (!type) return reply.status(400).send({ error: `Unknown product type '${entry.type}'` });
      const category = type.category_keys.find((k) => input.categories.includes(k));
      if (!category) return reply.status(400).send({ error: `${type.label} is not listed under a category you selected` });
      products.push({ ...entry, category });
    }
    const permitError = checkPermits(types, input.products, input.permits);
    if (permitError) return reply.status(400).send({ error: permitError });

    // Only the permits of selected types are kept.
    const permits: ApplicationSubmitInput['permits'] = {};
    for (const entry of input.products) {
      const p = input.permits[entry.type];
      if (p) permits[entry.type] = p;
    }

    const badMonth = input.booth.months.find((m) => !MONTH_KEYS.has(m));
    if (badMonth) return reply.status(400).send({ error: `Unknown month '${badMonth}'` });

    if (input.booth.stall_preference.length > 0) {
      const boothSnap = await app.db.collection('booths').where('market_id', '==', market.id).get();
      const active = new Set(boothSnap.docs.filter((d) => (d.data() as Rec).active !== false).map((d) => d.id));
      const unknown = input.booth.stall_preference.find((id) => !active.has(id));
      if (unknown) return reply.status(400).send({ error: 'One of the stalls you picked is not available' });
    }

    const fees = marketFees(market);
    const links = marketPaymentLinks(market);
    const marketCount = summarizeSeason(market).summary.market_count;

    /** What the first, accepted POST of a submission answered; a repeat of it gets the same body. */
    const originalResult = (applicationId: string, a: Rec) => {
      const fee = rec(a.fee);
      return {
        id: applicationId,
        status: 'new' as const,
        fee: {
          amount: typeof fee.amount === 'number' ? fee.amount : fees.application_fee,
          currency: typeof fee.currency === 'string' ? fee.currency : fees.currency,
          url: fillPaymentUrl(links.application_fee_url, email),
        },
        season_total: a.season_total as SeasonTotal,
      };
    };
    /** True when the stored application IS this submission: live, same season, same draft, same address. */
    const isThisSubmission = (a: Rec) =>
      isLiveApplication(a) && a.season === season && a.market_id === market.id && a.draft_id === input.draft_id && normalizeEmail(String(rec(a.contact).email ?? '')) === email;
    const duplicate = () => reply.status(409).send({ error: 'We already have an application for this email this season' });

    // One live application per email, market and season; a repeat of the same draft is the same
    // submission and is answered BEFORE the uploads are looked at (they are attached by now, fix X3a).
    // This scan is the friendly read-side answer and covers applications older than the key
    // documents; the key claimed below is what makes it atomic.
    const existingSnap = await app.db.collection('applications').where('market_id', '==', market.id).get();
    const today = utcDay(now);
    let submittedToday = 0;
    for (const d of existingSnap.docs) {
      const a = d.data() as Rec;
      const submittedAt = toDate(a.submitted_at);
      if (submittedAt && utcDay(submittedAt) === today) submittedToday += 1;
    }
    for (const d of existingSnap.docs) {
      const a = d.data() as Rec;
      if (a.season !== season || !isLiveApplication(a)) continue;
      if (normalizeEmail(String(rec(a.contact).email ?? '')) !== email) continue;
      if (isThisSubmission(a)) return reply.status(201).send(originalResult(d.id, a));
      // The other application's id is nobody else's business: anyone can type an email address here.
      return duplicate();
    }

    // Flood backstop (fix X2): a market takes at most SUBMISSION_LIMITS.daily_per_market new
    // applications per UTC day, whoever sends them. A repeat of an accepted submission and a
    // duplicate were answered above and never count against it.
    if (submittedToday >= SUBMISSION_LIMITS.daily_per_market) {
      await alertStaff(
        `Applications for market ${market.id} reached the daily cap of ${SUBMISSION_LIMITS.daily_per_market}; more are refused until 00:00 UTC`,
        'api:applications',
      );
      return reply.status(503).send({ error: 'We cannot accept more applications today. Please try again tomorrow, or contact the market manager.' });
    }

    // Uploads: every referenced id must exist, belong to this draft and be unattached. An upload
    // that is attached to this very submission means a concurrent copy of this request won the
    // race a moment ago: answer what it answered.
    const uploadIds = new Set<string>();
    for (const p of Object.values(permits)) if (p.upload_id) uploadIds.add(p.upload_id);
    if (input.insurance.certificate_upload_id) uploadIds.add(input.insurance.certificate_upload_id);
    const uploadNotFound = () => reply.status(400).send({ error: 'One of the uploaded files could not be found; please upload it again' });
    for (const uploadId of uploadIds) {
      const doc = await app.db.collection('application_uploads').doc(uploadId).get();
      const data = doc.data() as Rec | undefined;
      if (!doc.exists || !data || data.draft_id !== input.draft_id) return uploadNotFound();
      if (data.application_id) {
        const owner = typeof data.application_id === 'string' ? await app.db.collection('applications').doc(data.application_id).get() : null;
        const ownerData = owner?.exists ? (owner.data() as Rec) : null;
        if (owner && ownerData && isThisSubmission(ownerData)) return reply.status(201).send(originalResult(owner.id, ownerData));
        return uploadNotFound();
      }
    }

    const season_total = computeSeasonTotal(
      fees,
      { rate: input.booth.rate, spaces: input.booth.spaces, electric: input.booth.electric, pay_in_full: input.booth.pay_in_full },
      marketCount,
    );
    const id = uuid();

    // The atomic guard (fix X3d): the key of (market, season, email) is create()d before the
    // application. Of two submissions for one address arriving together, one stops here.
    const keyArgs = { market_id: market.id, season, email, application_id: id };
    const claim = await claimApplicationKey(app.db, { ...keyArgs, now });
    if (!claim.ok) {
      if (claim.holder && isThisSubmission(claim.holder)) return reply.status(201).send(originalResult(claim.holder_id, claim.holder));
      if (claim.holder) return duplicate();
      return reply.status(409).send({ error: 'Your application is already being submitted. Please wait a moment and try again.' });
    }

    const doc = {
      market_id: market.id,
      season,
      status: 'new' as const,
      draft_id: input.draft_id,
      prefill_token: input.prefill_token,
      prefill_producer_id: prefillProducerId,
      contact: { ...input.contact, email, mobile },
      sms_consent: { status: 'opted_in' as const, at: now, text_version: input.sms_consent_version, ip: request.ip },
      returning: input.returning,
      categories: input.categories,
      products,
      permits,
      booth: input.booth,
      season_total,
      payment_methods: input.payment_methods,
      insurance: input.insurance,
      acknowledgements: {
        rules: { version: input.rules_version, at: now },
        weekly_report: true,
        farm_visits: true,
        marketing: true,
        products_listed_only: true,
        own_booth_only: true,
      },
      signature: { name: input.signature_name, signed_at: now, ip: request.ip },
      fee: { status: 'unpaid' as const, amount: fees.application_fee, currency: fees.currency, paid_at: null, marked_by: null, reference: null },
      review: { notes: '', trial_period: false, decline_reason: null, reviewed_by: null, reviewed_at: null },
      producer_id: null,
      membership_id: null,
      upload_ids: [...uploadIds],
      submitted_at: now,
      source: 'web' as const,
      created_at: now,
      updated_at: now,
      ip: request.ip,
      user_agent: String(request.headers['user-agent'] ?? '').slice(0, 500),
      schema_version: 2 as const,
    };
    try {
      await app.db.collection('applications').doc(id).create(doc);
    } catch (err) {
      // The application was not written: let go of the key so the applicant can try again at once.
      await releaseApplicationKey(app.db, keyArgs);
      if (isAlreadyExists(err)) return reply.status(409).send({ error: 'Please try again' });
      throw err;
    }

    for (const uploadId of uploadIds) {
      await app.db.collection('application_uploads').doc(uploadId).update({ application_id: id, attached_at: now });
    }
    if (input.prefill_token) await markPurposeTokenUsed(app.db, input.prefill_token, now, { application_id: id });

    return reply.status(201).send({
      id,
      status: 'new' as const,
      fee: { amount: fees.application_fee, currency: fees.currency, url: fillPaymentUrl(links.application_fee_url, email) },
      season_total,
    });
  });

  // GET /api/applications/prefill/:token (public)
  app.get<{ Params: { token: string } }>('/prefill/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const now = new Date();
    const resolved = await resolvePurposeToken(app.db, request.params.token, 'application', now);
    if (resolved.status === 'unknown') return reply.status(404).send({ error: 'Unknown link' });
    if (resolved.status !== 'ok') return reply.status(410).send({ error: 'This link has expired' });
    const token = resolved.token;

    const producerDoc = await app.db.collection('producers').doc(token.producer_id).get();
    if (!producerDoc.exists) return reply.status(404).send({ error: 'Unknown link' });
    const p = producerDoc.data() as Rec;
    const market = await loadMarket(app.db, token.market_id);
    const season = token.season || (market ? currentSeason(market, now) : '');

    // Phase 2's products were plain strings; show them as one produce entry.
    const rawProducts = Array.isArray(p.products) ? (p.products as unknown[]) : [];
    const products: ProductEntry[] = [];
    const legacyItems = rawProducts.filter((x): x is string => typeof x === 'string');
    if (legacyItems.length > 0) products.push({ type: 'produce', items: legacyItems, practices: [], description: '', details: {} });
    for (const x of rawProducts) if (x && typeof x === 'object') products.push(x as ProductEntry);

    const memberships = (await listMembershipsForProducer(app.db, token.producer_id))
      .filter((m) => m.market_id === token.market_id && m.season !== season)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    const last = memberships[0] ?? null;
    let usualBoothLabel: string | null = null;
    if (last?.usual_booth_id) {
      const booth = await app.db.collection('booths').doc(last.usual_booth_id).get();
      if (booth.exists) usualBoothLabel = String((booth.data() as Rec).label ?? '') || null;
    }

    const emails = Array.isArray(p.emails) ? (p.emails as unknown[]) : [];
    return {
      market_id: token.market_id,
      season,
      expires_at: token.expires_at,
      producer: {
        business_name: String(p.business_name ?? ''),
        contact_name: String(p.contact_name ?? ''),
        email: typeof p.email === 'string' ? p.email : typeof emails[0] === 'string' ? (emails[0] as string) : null,
        phone: typeof p.phone === 'string' ? p.phone : null,
        website: String(p.website ?? ''),
        social: String(p.social ?? ''),
        address: p.address && typeof p.address === 'object' ? p.address : null,
        description_public: String(p.description_public ?? ''),
        years_in_operation: typeof p.years_in_operation === 'number' ? p.years_in_operation : null,
        outlets: String(p.outlets ?? ''),
        agricultural_practices: typeof p.agricultural_practices === 'string' ? p.agricultural_practices : null,
        categories: Array.isArray(p.categories) ? (p.categories as unknown[]).map(String) : [],
        products,
        payment_methods: Array.isArray(p.payment_methods) ? (p.payment_methods as unknown[]).map(String) : [],
      },
      last_membership: last
        ? {
            season: last.season,
            fee_plan: last.fee_plan,
            spaces: last.spaces,
            electric: last.electric,
            pay_in_full: last.pay_in_full,
            usual_booth_label: usualBoothLabel,
          }
        : null,
    };
  });

  // ─────────────────────────── staff (admin) ───────────────────────────

  // GET /api/applications
  app.get('/', { preHandler: adminOnly }, async (request, reply) => {
    const parsed = queueQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: issueMessage(parsed.error.issues) });
    const q = parsed.data;

    // One equality filter at the DB: status when given, else market_id when given, else none.
    let query: FirebaseFirestore.Query = app.db.collection('applications');
    if (q.status) query = query.where('status', '==', q.status);
    else if (q.market_id) query = query.where('market_id', '==', q.market_id);
    const snapshot = await query.get();

    let season = q.season;
    if (!season && q.market_id) {
      const market = await loadMarket(app.db, q.market_id);
      if (market) season = currentSeason(market, new Date());
    }

    let items = snapshot.docs.map((d) => projectApplicationListItem(d.id, d.data() as Rec));
    if (q.market_id) items = items.filter((i) => i.market_id === q.market_id);
    if (season && season !== 'all') items = items.filter((i) => i.season === season);
    if (q.fee) items = items.filter((i) => i.fee_status === q.fee);
    if (q.category) items = items.filter((i) => i.categories.includes(q.category!));
    if (q.returning) items = items.filter((i) => i.is_returning === (q.returning === 'true'));
    if (q.q) {
      const needle = q.q.toLowerCase();
      items = items.filter((i) => [i.business_name, i.contact_name, i.email].some((v) => v.toLowerCase().includes(needle)));
    }
    return { applications: byDateDesc(items, 'submitted_at') };
  });

  // GET /api/applications/:id
  app.get<{ Params: { id: string } }>('/:id', { preHandler: adminOnly }, async (request, reply) => {
    const doc = await app.db.collection('applications').doc(request.params.id).get();
    if (!doc.exists) return reply.status(404).send({ error: 'Application not found' });
    const data = doc.data() as Rec;
    const application = { id: doc.id, ...data, schema_version: isLegacyApplication(data) ? 1 : 2 };
    if (isLegacyApplication(data)) {
      return { application, uploads: [], producer: null, prior_memberships: [] };
    }

    const uploadSnap = typeof data.draft_id === 'string' ? await app.db.collection('application_uploads').where('draft_id', '==', data.draft_id).get() : { docs: [] };
    const uploads: UploadMeta[] = uploadSnap.docs.map((d) => {
      const u = d.data() as Rec;
      return {
        id: d.id,
        kind: u.kind as UploadMeta['kind'],
        mime: String(u.mime ?? ''),
        bytes: typeof u.bytes === 'number' ? u.bytes : 0,
        original_name: String(u.original_name ?? ''),
        uploaded_at: toDate(u.uploaded_at) ?? new Date(0),
        application_id: typeof u.application_id === 'string' ? u.application_id : null,
      };
    });

    // The producer this application belongs to (approved, prefilled, or recognised by email).
    let producerId: string | null = typeof data.producer_id === 'string' ? data.producer_id : null;
    if (!producerId && typeof data.prefill_producer_id === 'string') producerId = data.prefill_producer_id;
    if (!producerId) producerId = await findProducerByEmail(app.db, String(rec(data.contact).email ?? ''));
    let producer: { id: string; business_name: string } | null = null;
    let prior: MembershipStaffView[] = [];
    if (producerId) {
      const pd = await app.db.collection('producers').doc(producerId).get();
      if (pd.exists) {
        producer = { id: pd.id, business_name: String((pd.data() as Rec).business_name ?? '') };
        const market = typeof data.market_id === 'string' && MARKET_ID_RE.test(data.market_id) ? await loadMarket(app.db, data.market_id) : null;
        prior = (await listMembershipsForProducer(app.db, pd.id))
          .filter((m) => m.market_id === data.market_id)
          .sort((a, b) => b.season.localeCompare(a.season))
          .map((m) => membershipViewFor(request.authUser!, m, { timezone: market?.timezone || 'UTC' }));
      }
    }
    return { application, uploads, producer, prior_memberships: prior };
  });

  // GET /api/applications/:id/uploads/:upload_id/url
  app.get<{ Params: { id: string; upload_id: string } }>('/:id/uploads/:upload_id/url', { preHandler: adminOnly }, async (request, reply) => {
    const { id, upload_id } = request.params;
    const appDoc = await app.db.collection('applications').doc(id).get();
    if (!appDoc.exists) return reply.status(404).send({ error: 'Application not found' });
    const uploadDoc = await app.db.collection('application_uploads').doc(upload_id).get();
    if (!uploadDoc.exists) return reply.status(404).send({ error: 'Upload not found' });
    const upload = uploadDoc.data() as Rec;
    const appData = appDoc.data() as Rec;

    // The application's own uploads, or the logo / insurance certificate of the producer it belongs to.
    let allowed = upload.application_id === id;
    const producerId = typeof appData.producer_id === 'string' ? appData.producer_id : null;
    if (!allowed && producerId) {
      const producer = await app.db.collection('producers').doc(producerId).get();
      if (producer.exists && (producer.data() as Rec).logo_upload_id === upload_id) allowed = true;
      if (!allowed) {
        const memberships = await listMembershipsForProducer(app.db, producerId);
        allowed = memberships.some((m) => m.insurance.upload_id === upload_id);
      }
    }
    if (!allowed) return reply.status(404).send({ error: 'Upload not found' });

    const expiresInMs = 15 * 60_000;
    const url = await app.storage.signedReadUrl({
      path: String(upload.storage_path),
      expiresInMs,
      filename: String(upload.original_name ?? 'upload'),
    });
    return { url, expires_at: new Date(Date.now() + expiresInMs) };
  });

  // PATCH /api/applications/:id
  app.patch<{ Params: { id: string } }>('/:id', { preHandler: adminOnly }, async (request, reply) => {
    const ref = app.db.collection('applications').doc(request.params.id);
    const doc = await ref.get();
    if (!doc.exists) return reply.status(404).send({ error: 'Application not found' });
    const before = doc.data() as Rec;
    const user = request.authUser!;

    const parsed = applicationActionSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: issueMessage(parsed.error.issues) });
    const input = parsed.data;
    const now = new Date();
    const status = String(before.status ?? 'new');
    const open = status === 'new' || status === 'under_review';
    const target = { collection: 'applications', id: doc.id };
    const reread = async () => ({ id: doc.id, ...((await ref.get()).data() as Rec) });

    if (input.action === 'note') {
      await ref.update({ 'review.notes': input.notes, updated_at: now });
      await writeAudit(app.db, {
        actor_id: user.id,
        actor_role: user.role,
        action: 'application.transition',
        target,
        after: { notes_length: input.notes.length },
        note: 'note',
      });
      return { application: await reread() };
    }

    if (input.action === 'fee') {
      const paid = input.status === 'paid';
      const update: Rec = {
        'fee.status': input.status,
        'fee.paid_at': paid ? now : null,
        'fee.marked_by': input.status === 'unpaid' ? null : user.id,
        updated_at: now,
      };
      if (input.reference !== undefined) update['fee.reference'] = input.reference || null;
      await ref.update(update);
      await writeAudit(app.db, {
        actor_id: user.id,
        actor_role: user.role,
        action: 'application.fee',
        target,
        before: { status: rec(before.fee).status ?? 'unpaid' },
        after: { status: input.status },
      });
      return { application: await reread() };
    }

    if (!open) return reply.status(409).send({ error: `Application already ${status}` });

    if (input.action === 'review') {
      if (status === 'under_review') return reply.status(409).send({ error: 'Application is already under review' });
      await ref.update({ status: 'under_review', updated_at: now });
      await writeAudit(app.db, {
        actor_id: user.id,
        actor_role: user.role,
        action: 'application.transition',
        target,
        before: { status },
        after: { status: 'under_review' },
      });
      return { application: await reread() };
    }

    if (input.action === 'withdraw') {
      await ref.update({ status: 'withdrawn', 'review.reviewed_by': user.id, 'review.reviewed_at': now, updated_at: now });
      await writeAudit(app.db, {
        actor_id: user.id,
        actor_role: user.role,
        action: 'application.transition',
        target,
        before: { status },
        after: { status: 'withdrawn' },
      });
      return { application: await reread() };
    }

    if (input.action === 'decline') {
      await ref.update({
        status: 'declined',
        'review.decline_reason': input.reason,
        'review.reviewed_by': user.id,
        'review.reviewed_at': now,
        updated_at: now,
      });
      await writeAudit(app.db, {
        actor_id: user.id,
        actor_role: user.role,
        action: 'application.decline',
        target,
        before: { status },
        after: { status: 'declined' },
        note: input.reason,
      });
      return { application: await reread() };
    }

    // ── approve ──
    if (isLegacyApplication(before)) {
      return reply.status(409).send({ error: 'This application was submitted on the earlier application form; ask the applicant to apply again' });
    }
    const market = await loadMarket(app.db, String(before.market_id));
    if (!market) return reply.status(404).send({ error: 'Market not found' });
    const season = String(before.season);
    const contact = rec(before.contact);
    const contactEmail = String(contact.email);
    const contactMobile = String(contact.mobile);

    if (input.usual_booth_id) {
      if (!(await isActiveBooth(app.db, market.id, input.usual_booth_id))) {
        return reply.status(400).send({ error: 'usual_booth_id must be an active booth of this market' });
      }
    }

    // The acceptance message carries the Hold Harmless link. Until the market has
    // published that text the link opens an agreement nobody can sign, so do not
    // send it: add the text first, or approve without sending.
    if (input.send && marketLegal(market).hold_harmless_markdown.trim().length === 0) {
      return reply.status(409).send({
        error: 'Add the Hold Harmless text under Legal texts before sending acceptance messages, or approve without sending.',
        code: 'hold_harmless_missing',
      });
    }

    // One approval of this application at a time, and one producer per address (fix X3e).
    // Both locks are `workflow_locks` documents taken with create(): of two approvals arriving
    // together exactly one gets past each. Without them both requests read status 'new', both
    // scan `producers`, find nobody, and each creates a producer for the same applicant.
    //   - `application_approve__<id>` guards this application. It is released when the approval
    //     is refused or fails (so it can be retried at once) and kept once it succeeds.
    //   - `producer_identity__<sha256(email)>` guards "resolve or create the producer of this
    //     address" across applications (the same new applicant applying to two markets) and is
    //     released as soon as the producer exists.
    // A lock whose holder died is taken over after the engine's CLAIM_TTL_MS.
    const approvalLock = approvalLockId(doc.id);
    const identityLock = producerIdentityLockId(contactEmail);
    const inProgress = () => reply.status(409).send({ error: 'Approval already in progress', code: 'approval_in_progress' });
    const heldApproval = await acquireStaffLock(app.db, approvalLock, user.id, now);
    if (!heldApproval.acquired) return inProgress();
    let heldIdentity: StaffLock = { acquired: false };
    let approved = false;
    try {
      // Decided on a fresh read under the lock: another approval may have finished since this request loaded the application.
      const fresh = (await ref.get()).data() as Rec | undefined;
      const freshStatus = String(fresh?.status ?? 'new');
      if (!fresh || (freshStatus !== 'new' && freshStatus !== 'under_review')) {
        return reply.status(409).send({ error: `Application already ${freshStatus}` });
      }

      heldIdentity = await acquireStaffLock(app.db, identityLock, user.id, now);
      if (!heldIdentity.acquired) return inProgress();

      // Who is this? A prefilled application names its producer; otherwise match by email (never by name).
      let knownProducerId: string | null = null;
      if (typeof before.prefill_producer_id === 'string') {
        const d = await app.db.collection('producers').doc(before.prefill_producer_id).get();
        if (d.exists) knownProducerId = d.id;
      }
      if (!knownProducerId) knownProducerId = await findProducerByEmail(app.db, contactEmail);

      // No producer, membership, token or message is written before these two refusals.
      const phoneHolder = await findProducerByPhone(app.db, contactMobile);
      if (phoneHolder && phoneHolder !== knownProducerId) {
        return reply.status(409).send({ error: 'Another producer already uses this mobile number', producer_id: phoneHolder });
      }
      const existingMembership = knownProducerId ? await findMembership(app.db, knownProducerId, market.id, season) : null;
      if (existingMembership && existingMembership.status !== 'inactive') {
        return reply.status(409).send({ error: `This producer already has a ${season} membership`, membership_id: existingMembership.id });
      }

      const consent = rec(before.sms_consent);
      const products = (Array.isArray(before.products) ? before.products : []).map((p) => {
        const { category: _category, ...entry } = rec(p);
        return entry as unknown as ProductEntry;
      });
      const address = rec(contact.address);
      const upserted = await upsertProducerByEmail(app.db, {
        email: contactEmail,
        business_name: String(contact.business_name),
        contact_name: String(contact.name),
        phone: contactMobile,
        source: 'application',
        ...(knownProducerId ? { producer_id: knownProducerId } : {}),
        profile: {
          website: String(contact.website ?? ''),
          social: String(contact.social ?? ''),
          address: Object.keys(address).length > 0 ? { street: String(address.street ?? ''), city: String(address.city ?? ''), state: String(address.state ?? ''), zip: String(address.zip ?? '') } : null,
          description_public: String(contact.description ?? ''),
          years_in_operation: typeof contact.years_in_operation === 'number' ? contact.years_in_operation : null,
          outlets: String(contact.outlets ?? ''),
          agricultural_practices: (contact.agricultural_practices as never) ?? null,
          categories: Array.isArray(before.categories) ? (before.categories as unknown[]).map(String) : [],
          products,
          payment_methods: Array.isArray(before.payment_methods) ? (before.payment_methods as unknown[]).map(String) : [],
          last_application_id: doc.id,
          sms_consent: {
            status: 'opted_in',
            at: toDate(consent.at) ?? now,
            source: 'application',
            text_version: String(consent.text_version ?? ''),
            ip: String(consent.ip ?? ''),
          },
        },
      });
      const producerId = upserted.producer_id;
      // The producer exists now: the next approval for this address will find it by email.
      await releaseStaffLock(app.db, identityLock, heldIdentity);
      heldIdentity = { acquired: false };

      const producerDoc = await app.db.collection('producers').doc(producerId).get();
      await writeAudit(app.db, {
        actor_id: user.id,
        actor_role: user.role,
        action: upserted.created ? 'producer.create' : 'producer.update',
        target: { collection: 'producers', id: producerId },
        after: producerDoc.data(),
      });

      // The per-season membership (D33): created atomically, a 2026 row is never touched.
      const insurance = rec(before.insurance);
      const certificateId = typeof insurance.certificate_upload_id === 'string' ? insurance.certificate_upload_id : null;
      const expiresOn = typeof insurance.expires_on === 'string' ? insurance.expires_on : null;
      const newMembership = {
        producer_id: producerId,
        market_id: market.id,
        season,
        status: 'approved' as MembershipStatus,
        fee_plan: input.fee_plan,
        spaces: input.spaces,
        electric: input.electric,
        pay_in_full: input.pay_in_full,
        booth_kind: input.booth_kind,
        usual_booth_id: input.usual_booth_id,
        trial_period: input.trial_period,
        approved_items: flattenItems(before.products),
        application_id: doc.id,
        // The calendar date is the stored truth; the instant is derived from it, exactly as PATCH .../insurance does (fix X11).
        insurance: {
          status: certificateId ? ('on_file' as const) : ('missing' as const),
          expires_on: expiresOn,
          expires_at: expiresOn ? insuranceExpiryInstant(expiresOn, market.timezone) : null,
          upload_id: certificateId,
        },
        source: 'application' as const,
        actor: user.id,
        note: input.note || null,
      };

      let membershipId: string;
      if (existingMembership) {
        // An inactive membership of this very season: bring it back rather than create a second document.
        membershipId = existingMembership.id;
        if (!canTransition(existingMembership.status, 'approved')) {
          return reply.status(409).send({ error: `This producer already has a ${season} membership`, membership_id: existingMembership.id });
        }
        await app.db
          .collection('producer_memberships')
          .doc(membershipId)
          .update({
            status: 'approved',
            fee_plan: newMembership.fee_plan,
            spaces: newMembership.spaces,
            electric: newMembership.electric,
            pay_in_full: newMembership.pay_in_full,
            booth_kind: newMembership.booth_kind,
            usual_booth_id: newMembership.usual_booth_id,
            trial_period: newMembership.trial_period,
            approved_items: newMembership.approved_items,
            application_id: doc.id,
            insurance: { ...newMembership.insurance, verified_by: null, verified_at: null, note: '' },
            hold_harmless: null,
            approved_at: now,
            approved_by: user.id,
            history: [...existingMembership.history, { from: 'inactive', to: 'approved', at: now, by: user.id, note: input.note || null }],
            updated_at: now,
          });
      } else {
        const created = await createMembership(app.db, newMembership, now);
        if (!created.created) {
          return reply.status(409).send({ error: `This producer already has a ${season} membership`, membership_id: created.id });
        }
        membershipId = created.id;
      }
      await writeAudit(app.db, {
        actor_id: user.id,
        actor_role: user.role,
        action: 'membership.create',
        target: { collection: 'producer_memberships', id: membershipId },
        after: { producer_id: producerId, market_id: market.id, season, status: 'approved', application_id: doc.id },
      });

      // The Hold Harmless link: a 60-day, single-use agreement token for this membership.
      const agreement = await mintPurposeToken(app.db, {
        purpose: 'agreement',
        producer_id: producerId,
        market_id: market.id,
        season,
        membership_id: membershipId,
        expires_at: new Date(now.getTime() + AGREEMENT_TOKEN_DAYS * DAY_MS),
        now,
        created_by: user.id,
      });

      await ref.update({
        status: 'approved',
        producer_id: producerId,
        membership_id: membershipId,
        'review.trial_period': input.trial_period,
        'review.reviewed_by': user.id,
        'review.reviewed_at': now,
        updated_at: now,
      });
      approved = true;
      await writeAudit(app.db, {
        actor_id: user.id,
        actor_role: user.role,
        action: 'application.approve',
        target,
        before: { status },
        after: { status: 'approved', producer_id: producerId, membership_id: membershipId, season },
      });

      // Messages are best-effort: the approval stands whatever happens to them. Inside the market's
      // quiet hours the email goes and the text is held (`skipped_quiet_hours`, with `quiet_until`).
      let sends: { sms: string; email: boolean; quiet_until: Date | null } = { sms: 'skipped_not_requested', email: false, quiet_until: null };
      if (input.send) {
        const fees = marketFees(market);
        const totals = computeSeasonTotal(
          fees,
          { rate: input.fee_plan, spaces: input.spaces, electric: input.electric, pay_in_full: input.pay_in_full },
          summarizeSeason(market).summary.market_count,
        );
        try {
          sends = await sendAcceptance({
            db: app.db,
            env: app.env,
            market,
            season,
            applicationId: doc.id,
            membershipId,
            producerId,
            producer: (producerDoc.data() ?? {}) as Rec,
            contactName: String(contact.name),
            contactEmail,
            agreementToken: agreement.token,
            agreementUrl: purposeTokenUrl(app.env.APP_URL, 'agreement', agreement.token),
            totals,
            boothFeeUrl: marketPaymentLinks(market).booth_fee_url,
            insuranceHelpUrl: marketLegal(market).insurance_help_url,
            insuranceRequirementsText: marketLegal(market).insurance_requirements_text,
            firstDate: firstSeasonDate(market),
            actor: user.id,
            now,
          });
          const sentMessageId = sends.sms === 'sent' || sends.sms === 'simulated' ? `acceptance:${doc.id}` : null;
          if (sentMessageId) await app.db.collection('link_tokens').doc(agreement.token).update({ sent_message_id: sentMessageId });
        } catch (err) {
          app.log.error(err, 'Acceptance send failed');
          sends = { sms: 'failed', email: false, quiet_until: null };
        }
      }

      const membershipDoc = await app.db.collection('producer_memberships').doc(membershipId).get();
      return {
        application: await reread(),
        producer: { id: producerId, ...((await app.db.collection('producers').doc(producerId).get()).data() as Rec) },
        membership: membershipViewFor(user, membershipFromData(membershipId, membershipDoc.data() as Rec), { timezone: market.timezone }),
        sends,
      };
    } finally {
      await releaseStaffLock(app.db, identityLock, heldIdentity);
      // Refused or failed: free the application for another try. Approved: the lock stays, like every engine lock.
      if (!approved) await releaseStaffLock(app.db, approvalLock, heldApproval);
    }
  });
}
