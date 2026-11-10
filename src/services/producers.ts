import type { Firestore } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { isAlreadyExists } from '../db/firestore.js';
import { nameKey, normalizeEmail } from './identity.js';
import { membershipDocId, type BoothKind, type FeePlan } from './seasons.js';

/**
 * Producers, memberships and applications: zod shapes (SPEC §2.3–2.5) plus
 * the membership state machine and the identity-based producer upsert used
 * by the applications approve flow (never match by name alone — §7.9).
 *
 * Phase 4: memberships belong to one season (D33; see seasons.ts), the
 * producer document carries the profile fields the application collects
 * (contract §2.3), and `createMembership` is the one writer of a new
 * per-season membership document.
 */

export type MembershipStatus = 'applied' | 'under_review' | 'approved' | 'active' | 'inactive';
export type { FeePlan } from './seasons.js';
export type ProducerSource = 'application' | 'import' | 'admin';

const E164_RE = /^\+[1-9]\d{6,14}$/;
const phoneSchema = z.string().regex(E164_RE, 'Phone must be E.164, e.g. +15015550100');

const KEY = /^[a-z][a-z0-9_]{1,31}$/;
const str = (max: number) => z.string().trim().max(max);

export const AGRICULTURAL_PRACTICES = ['certified_organic', 'certified_naturally_grown', 'no_chemicals', 'conventional', 'not_applicable'] as const;
export type AgriculturalPractice = (typeof AGRICULTURAL_PRACTICES)[number];

export const addressSchema = z.object({ street: str(200), city: str(100), state: str(40), zip: str(12) });
export type Address = z.infer<typeof addressSchema>;

export const productEntrySchema = z.object({
  type: z.string().regex(KEY),
  items: z.array(str(80)).min(1).max(100),
  practices: z.array(z.string().regex(KEY)).max(40).default([]),
  description: str(2000).default(''),
  // Keys are the product type's detail-field keys (lower_snake): a free-form key could collide with Firestore's reserved field names.
  details: z
    .record(z.string().regex(KEY), z.union([str(500), z.number().finite(), z.boolean()]))
    .refine((d) => Object.keys(d).length <= 20, 'at most 20 details')
    .default({}),
});
export type ProductEntry = z.infer<typeof productEntrySchema>;

/** Accepted fee-plan spellings on a write: Phase 2's weekly/season/both and Phase 4's daily/seasonal. Stored as `seasonal | daily`. */
const feePlanInput = z.enum(['weekly', 'season', 'both', 'seasonal', 'daily']);

export const createProducerSchema = z.object({
  business_name: z.string().min(1),
  contact_name: z.string().optional(),
  phone: phoneSchema.optional(),
  email: z.string().email().optional(),
  emails: z.array(z.string().email()).optional(),
  aliases: z.array(z.string()).optional(),
  products: z.array(z.string()).optional(),
  category: z.string().optional(),
  notes: z.string().optional(),
  memberships: z
    .array(
      z.object({
        market_id: z.string(),
        status: z.enum(['applied', 'under_review', 'approved', 'active', 'inactive']).default('approved'),
        fee_plan: feePlanInput.optional(),
      }),
    )
    .optional(),
});
export type CreateProducerInput = z.infer<typeof createProducerSchema>;

export const updateProducerSchema = z.object({
  business_name: z.string().min(1).optional(),
  contact_name: z.string().optional(),
  phone: phoneSchema.optional(),
  email: z.string().email().optional(),
  emails: z.array(z.string().email()).optional(),
  aliases: z.array(z.string()).optional(),
  // Phase 4 (contract §2.3): products are structured entries now; Phase 2's string[] still reads.
  products: z.array(productEntrySchema).max(50).optional(),
  category: z.string().optional(),
  notes: z.string().optional(),
  active: z.boolean().optional(),
  website: str(300).optional(),
  social: str(300).optional(),
  address: addressSchema.nullable().optional(),
  description_public: str(3000).optional(),
  years_in_operation: z.number().int().min(0).max(150).nullable().optional(),
  outlets: str(1000).optional(),
  agricultural_practices: z.enum(AGRICULTURAL_PRACTICES).nullable().optional(),
  categories: z.array(z.string().regex(KEY)).max(12).optional(),
  payment_methods: z.array(z.enum(['cash', 'card', 'check', 'wic', 'snap'])).max(5).optional(),
  logo_upload_id: z.string().uuid().nullable().optional(),
});
export type UpdateProducerInput = z.infer<typeof updateProducerSchema>;

/** Allowed forward transitions for a producer's membership at a market (SPEC §4.3). */
export const MEMBERSHIP_TRANSITIONS: Record<MembershipStatus, MembershipStatus[]> = {
  applied: ['under_review', 'approved', 'inactive'],
  under_review: ['applied', 'approved', 'inactive'],
  approved: ['active', 'inactive'],
  active: ['inactive'],
  inactive: ['active', 'approved'],
};

export function canTransition(from: MembershipStatus, to: MembershipStatus): boolean {
  return MEMBERSHIP_TRANSITIONS[from]?.includes(to) ?? false;
}

/* ── Producer upsert ── */

/** The profile fields an application copies onto a producer (contract §2.3). */
export interface ProducerProfileInput {
  website: string;
  social: string;
  address: Address | null;
  description_public: string;
  years_in_operation: number | null;
  outlets: string;
  agricultural_practices: AgriculturalPractice | null;
  categories: string[];
  products: ProductEntry[];
  payment_methods: string[];
  last_application_id: string | null;
  /** The consent recorded on the application (replaces the generic consent stamp). */
  sms_consent: { status: 'opted_in'; at: Date; source: 'application'; text_version: string; ip: string } | null;
  logo_upload_id?: string | null;
}

export interface UpsertProducerByEmailArgs {
  email: string;
  business_name: string;
  contact_name?: string;
  phone?: string | null;
  source: ProducerSource;
  /** Phase 4: merge into this producer (when it exists) instead of matching by email; a prefilled application names its producer. */
  producer_id?: string;
  /** Phase 4: when given, the application's profile overwrites the producer's (the newest application is the newest truth). */
  profile?: ProducerProfileInput;
}

export interface UpsertProducerByEmailResult {
  producer_id: string;
  created: boolean;
}

function profileFields(profile: ProducerProfileInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    website: profile.website,
    social: profile.social,
    address: profile.address,
    description_public: profile.description_public,
    years_in_operation: profile.years_in_operation,
    outlets: profile.outlets,
    agricultural_practices: profile.agricultural_practices,
    categories: profile.categories,
    products: profile.products,
    payment_methods: profile.payment_methods,
    last_application_id: profile.last_application_id,
  };
  if (profile.logo_upload_id !== undefined) fields.logo_upload_id = profile.logo_upload_id;
  return fields;
}

/** The producer holding a phone number, or null. One equality filter. */
export async function findProducerByPhone(db: Firestore, phone: string): Promise<string | null> {
  const snap = await db.collection('producers').where('phone', '==', phone).limit(1).get();
  return snap.empty ? null : snap.docs[0]!.id;
}

/** The producer whose `emails[]` contains the (normalised) email, or null. */
export async function findProducerByEmail(db: Firestore, email: string): Promise<string | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const snapshot = await db.collection('producers').get();
  const match = snapshot.docs.find((doc) => ((doc.data().emails as string[] | undefined) ?? []).includes(normalized));
  return match ? match.id : null;
}

/**
 * Producer identity resolution for a single incoming row (an application, an
 * admin form, or a future import touch-up): match BY EMAIL, never by name.
 * Scans `producers` once, finds the first doc whose `emails[]` contains the
 * normalized email, and either merges into it or creates a new producer.
 */
export async function upsertProducerByEmail(
  db: Firestore,
  args: UpsertProducerByEmailArgs,
): Promise<UpsertProducerByEmailResult> {
  const email = normalizeEmail(args.email);
  if (!email) throw new Error(`upsertProducerByEmail: invalid email '${args.email}'`);

  const now = new Date();
  const snapshot = await db.collection('producers').get();
  const named = args.producer_id ? snapshot.docs.find((doc) => doc.id === args.producer_id) : undefined;
  const match =
    named ??
    snapshot.docs.find((doc) => {
      const emails = (doc.data().emails as string[] | undefined) ?? [];
      return emails.includes(email);
    });

  const consent = (): Record<string, unknown> =>
    args.profile?.sms_consent
      ? { ...args.profile.sms_consent }
      : { status: 'opted_in', at: now, source: args.source };

  if (match) {
    const data = match.data();
    const emails = new Set<string>((data.emails as string[] | undefined) ?? []);
    emails.add(email);

    const canonical = ((data.business_name as string) ?? '').trim();
    const incomingName = args.business_name.trim();
    const aliases = new Set<string>((data.aliases as string[] | undefined) ?? []);
    if (incomingName && incomingName !== canonical) aliases.add(incomingName);

    const updates: Record<string, unknown> = {
      emails: [...emails].sort(),
      aliases: [...aliases].sort(),
      updated_at: now,
    };
    if (args.profile) {
      // An application is the producer's own, newest statement of who they are and which number may be texted.
      Object.assign(updates, profileFields(args.profile));
      if (args.phone) updates.phone = args.phone;
      if (args.contact_name) updates.contact_name = args.contact_name;
    } else {
      if (!data.phone && args.phone) updates.phone = args.phone;
      if (!data.contact_name && args.contact_name) updates.contact_name = args.contact_name;
    }
    if (args.phone) updates.sms_consent = consent();

    await match.ref.set(updates, { merge: true });
    return { producer_id: match.id, created: false };
  }

  const id = uuid();
  const producer = {
    business_name: args.business_name,
    name_key: nameKey(args.business_name),
    contact_name: args.contact_name ?? '',
    phone: args.phone ?? null,
    email,
    emails: [email],
    aliases: [] as string[],
    products: [] as unknown[],
    category: '',
    documents: [] as unknown[],
    sms_consent: args.phone ? consent() : { status: 'unknown' as const, at: null, source: args.source },
    sms_opt_out_at: null,
    user_id: null,
    legacy_farm_id: null,
    notes: '',
    // Phase 4 profile fields (contract §2.3).
    website: '',
    social: '',
    address: null,
    description_public: '',
    years_in_operation: null,
    outlets: '',
    agricultural_practices: null,
    categories: [] as string[],
    payment_methods: [] as string[],
    logo_upload_id: null,
    last_application_id: null,
    ...(args.profile ? profileFields(args.profile) : {}),
    source: args.source,
    active: true,
    created_at: now,
    updated_at: now,
  };
  await db.collection('producers').doc(id).set(producer);
  return { producer_id: id, created: true };
}

/** True when `boothId` is an active booth of `marketId` (booths are Phase 4 documents owned by the booth routes). */
export async function isActiveBooth(db: Firestore, marketId: string, boothId: string): Promise<boolean> {
  const doc = await db.collection('booths').doc(boothId).get();
  const b = doc.data() as Record<string, unknown> | undefined;
  return doc.exists && !!b && b.market_id === marketId && b.active !== false;
}

/* ── What staff see of a producer (Phase 4 fix X8) ── */

/**
 * The one way a producer document leaves the API on a staff route. Admins
 * get every field. A market manager does not get:
 *   - `notes` (admin notes, as before);
 *   - `address` (the street address the application collected);
 *   - `sms_consent.ip` (the address the consent was given from: evidence,
 *     kept for admins; the status, date, source and wording version stay).
 */
export function producerViewFor(viewer: { role: string }, id: string, data: Record<string, unknown>): Record<string, unknown> {
  const view: Record<string, unknown> = { id, ...data };
  if (viewer.role === 'admin') return view;
  delete view.notes;
  delete view.address;
  const consent = view.sms_consent;
  if (consent && typeof consent === 'object' && !Array.isArray(consent)) {
    const { ip: _ip, ...rest } = consent as Record<string, unknown>;
    view.sms_consent = rest;
  }
  return view;
}

/** Accepted fee-plan spellings on a membership write (Phase 2 and Phase 4 vocabulary). */
export const feePlanInputSchema = feePlanInput;

/* ── Per-season membership writer (contract §2.6) ── */

export interface NewMembershipInput {
  producer_id: string;
  market_id: string;
  season: string;
  status: MembershipStatus;
  fee_plan: FeePlan;
  spaces: 1 | 2;
  electric: boolean;
  pay_in_full: boolean;
  booth_kind: BoothKind;
  usual_booth_id: string | null;
  trial_period: boolean;
  approved_items: string[];
  application_id: string | null;
  /** `expires_on` is the last valid day (market-local, 'YYYY-MM-DD'); `expires_at` is the instant derived from it (`insuranceExpiryInstant`). */
  insurance?: { status: 'missing' | 'on_file'; expires_on: string | null; expires_at: Date | null; upload_id: string | null };
  source: 'application' | 'admin' | 'import';
  actor: string;
  note: string | null;
}

export function buildMembershipDoc(input: NewMembershipInput, now: Date): Record<string, unknown> {
  const settled = input.status === 'approved' || input.status === 'active';
  return {
    producer_id: input.producer_id,
    market_id: input.market_id,
    season: input.season,
    status: input.status,
    fee_plan: input.fee_plan,
    spaces: input.spaces,
    electric: input.electric,
    pay_in_full: input.pay_in_full,
    booth_kind: input.booth_kind,
    usual_booth_id: input.usual_booth_id,
    trial_period: input.trial_period,
    approved_at: settled ? now : null,
    approved_by: settled ? input.actor : null,
    insurance: {
      status: input.insurance?.status ?? 'missing',
      expires_on: input.insurance?.expires_on ?? null,
      expires_at: input.insurance?.expires_at ?? null,
      upload_id: input.insurance?.upload_id ?? null,
      verified_by: null,
      verified_at: null,
      note: '',
    },
    hold_harmless: null,
    approved_items: input.approved_items,
    item_requests: [] as unknown[],
    application_id: input.application_id,
    history: [{ from: null, to: input.status, at: now, by: input.actor, note: input.note }],
    source: input.source,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Create the membership of `(producer, market, season)` with the atomic
 * `create()`: two admins approving at once cannot both win. `created: false`
 * means a document with that id already exists (the caller maps it to 409).
 */
export async function createMembership(
  db: Firestore,
  input: NewMembershipInput,
  now: Date,
): Promise<{ id: string; created: boolean; doc: Record<string, unknown> }> {
  const id = membershipDocId(input.producer_id, input.market_id, input.season);
  const doc = buildMembershipDoc(input, now);
  try {
    await db.collection('producer_memberships').doc(id).create(doc);
  } catch (err) {
    if (isAlreadyExists(err)) return { id, created: false, doc };
    throw err;
  }
  return { id, created: true, doc };
}
