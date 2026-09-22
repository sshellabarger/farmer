import type { Firestore } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { nameKey, normalizeEmail } from './identity.js';

/**
 * Producers, memberships and applications: zod shapes (SPEC §2.3–2.5) plus
 * the membership state machine and the identity-based producer upsert used
 * by the applications approve flow (never match by name alone — §7.9).
 */

export type MembershipStatus = 'applied' | 'under_review' | 'approved' | 'active' | 'inactive';
export type FeePlan = 'weekly' | 'season' | 'both';
export type ProducerSource = 'application' | 'import' | 'admin';

const E164_RE = /^\+[1-9]\d{6,14}$/;
const phoneSchema = z.string().regex(E164_RE, 'Phone must be E.164, e.g. +15015550100');

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
        fee_plan: z.enum(['weekly', 'season', 'both']).optional(),
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
  products: z.array(z.string()).optional(),
  category: z.string().optional(),
  notes: z.string().optional(),
  active: z.boolean().optional(),
});
export type UpdateProducerInput = z.infer<typeof updateProducerSchema>;

const EXTRA_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const applicationSchema = z.object({
  email: z.string().email(),
  business_name: z.string().min(1).max(200),
  contact_person: z.string().min(1).max(200),
  phone: z.string().min(10),
  markets_applied: z.array(z.string()).min(1),
  extra: z
    .record(z.union([z.string().max(2000), z.boolean(), z.array(z.string().max(500)).max(50)]))
    .default({})
    .refine((extra) => Object.keys(extra).length <= 50, { message: 'extra: at most 50 keys' })
    .refine((extra) => Object.keys(extra).every((k) => EXTRA_KEY_RE.test(k)), {
      message: 'extra: keys must match /^[a-z][a-z0-9_]{0,63}$/',
    }),
});
export type ApplicationInput = z.infer<typeof applicationSchema>;

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

export interface UpsertProducerByEmailArgs {
  email: string;
  business_name: string;
  contact_name?: string;
  phone?: string | null;
  source: ProducerSource;
}

export interface UpsertProducerByEmailResult {
  producer_id: string;
  created: boolean;
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
  const match = snapshot.docs.find((doc) => {
    const emails = (doc.data().emails as string[] | undefined) ?? [];
    return emails.includes(email);
  });

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
    if (!data.phone && args.phone) updates.phone = args.phone;
    if (!data.contact_name && args.contact_name) updates.contact_name = args.contact_name;
    if (args.phone) updates.sms_consent = { status: 'opted_in', at: now, source: args.source };

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
    products: [] as string[],
    category: '',
    documents: [] as unknown[],
    sms_consent: args.phone
      ? { status: 'opted_in' as const, at: now, source: args.source }
      : { status: 'unknown' as const, at: null, source: args.source },
    sms_opt_out_at: null,
    user_id: null,
    legacy_farm_id: null,
    notes: '',
    source: args.source,
    active: true,
    created_at: now,
    updated_at: now,
  };
  await db.collection('producers').doc(id).set(producer);
  return { producer_id: id, created: true };
}
