import { normalizePhone } from './phone';
import type {
  AcknowledgementsInput,
  AgriculturalPractice,
  ApplicationConfig,
  ApplicationSubmitInput,
  BoothRate,
  DailyFrequency,
  InsuranceAnswer,
  PermitEntry,
  PrefillView,
  ProductEntry,
  ProductTypeConfig,
} from './phase4-types';

/**
 * Form state for the five-section /apply page, the localStorage draft that
 * survives a reload, section validation, and the mapping from form state to
 * the POST /api/applications body. Browser storage is a per-viewer convenience
 * only: every access is wrapped, and the page works without it.
 */

export const SECTION_TITLES = [
  'You and your business',
  'What you sell',
  'Your booth',
  'Insurance and agreements',
  'Review and submit',
] as const;

export interface BusinessValues {
  name: string;
  business_name: string;
  email: string;
  mobile: string;
  website: string;
  social: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  description: string;
  years_in_operation: string;
  outlets: string;
  agricultural_practices: AgriculturalPractice | '';
  additional_info: string;
  sms_consent: boolean;
  is_returning: boolean | null;
  last_stall: string;
}

export interface BoothValues {
  rate: BoothRate | '';
  frequency: DailyFrequency | '';
  months: string[];
  spaces: 1 | 2;
  electric: boolean;
  pay_in_full: boolean;
  stall_preference: string[];
  food_truck: boolean;
}

export interface InsuranceValues {
  status: InsuranceAnswer | '';
  certificate_upload_id: string | null;
  certificate_name: string;
  carrier: string;
  expires_on: string;
}

export interface ApplyValues {
  business: BusinessValues;
  categories: string[];
  products: ProductEntry[];
  permits: Record<string, PermitEntry>;
  /** upload_id -> original file name, for display only. */
  upload_names: Record<string, string>;
  payment_methods: string[];
  booth: BoothValues;
  insurance: InsuranceValues;
  acknowledgements: AcknowledgementsInput;
  signature_name: string;
  /** The prefill link this form was started from; null for a blank form. */
  prefill_token: string | null;
}

export function emptyValues(): ApplyValues {
  return {
    business: {
      name: '',
      business_name: '',
      email: '',
      mobile: '',
      website: '',
      social: '',
      street: '',
      city: '',
      state: '',
      zip: '',
      description: '',
      years_in_operation: '',
      outlets: '',
      agricultural_practices: '',
      additional_info: '',
      sms_consent: false,
      is_returning: null,
      last_stall: '',
    },
    categories: [],
    products: [],
    permits: {},
    upload_names: {},
    payment_methods: [],
    booth: {
      rate: '',
      frequency: '',
      months: [],
      spaces: 1,
      electric: false,
      pay_in_full: false,
      stall_preference: [],
      food_truck: false,
    },
    insurance: { status: '', certificate_upload_id: null, certificate_name: '', carrier: '', expires_on: '' },
    acknowledgements: {
      rules: false,
      weekly_report: false,
      farm_visits: false,
      marketing: false,
      products_listed_only: false,
      own_booth_only: false,
    },
    signature_name: '',
    prefill_token: null,
  };
}

/* ── Draft storage ── */

export interface DraftState {
  draft_id: string;
  section: number;
  values: ApplyValues;
  saved_at: string;
}

const KEY_PREFIX = 'sjca_apply_';

export function newDraftId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // fall through
  }
  // RFC 4122 v4 from Math.random: only used where crypto.randomUUID is missing (old browsers, insecure origins).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Merge a stored (possibly older-shaped) value over the empty form, keeping only well-typed fields. */
function mergeValues(raw: unknown): ApplyValues {
  const base = emptyValues();
  if (!isObj(raw)) return base;
  const pickStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const assign = <T extends object>(target: T, source: unknown): T => {
    if (!isObj(source)) return target;
    const out = { ...target } as Record<string, unknown>;
    for (const k of Object.keys(target)) {
      const sv = source[k];
      const tv = (target as Record<string, unknown>)[k];
      if (sv === undefined) continue;
      if (Array.isArray(tv)) {
        if (Array.isArray(sv)) out[k] = sv.filter((x) => typeof x === 'string');
      } else if (tv === null || typeof tv === 'string') {
        if (typeof sv === typeof tv || (tv === null && (typeof sv === 'string' || typeof sv === 'boolean' || sv === null))) out[k] = sv;
      } else if (typeof sv === typeof tv) {
        out[k] = sv;
      }
    }
    return out as T;
  };
  const values: ApplyValues = {
    ...base,
    business: assign(base.business, raw.business),
    categories: pickStrings(raw.categories),
    products: Array.isArray(raw.products)
      ? raw.products.filter(isObj).map((p) => ({
          type: typeof p.type === 'string' ? p.type : '',
          items: pickStrings(p.items),
          practices: pickStrings(p.practices),
          description: typeof p.description === 'string' ? p.description : '',
          details: isObj(p.details) ? (p.details as ProductEntry['details']) : {},
        })).filter((p) => p.type)
      : [],
    permits: isObj(raw.permits) ? (raw.permits as Record<string, PermitEntry>) : {},
    upload_names: isObj(raw.upload_names) ? (raw.upload_names as Record<string, string>) : {},
    payment_methods: pickStrings(raw.payment_methods),
    booth: assign(base.booth, raw.booth),
    insurance: assign(base.insurance, raw.insurance),
    acknowledgements: assign(base.acknowledgements, raw.acknowledgements),
    signature_name: typeof raw.signature_name === 'string' ? raw.signature_name : '',
    prefill_token: typeof raw.prefill_token === 'string' ? raw.prefill_token : null,
  };
  if (values.booth.spaces !== 1 && values.booth.spaces !== 2) values.booth.spaces = 1;
  return values;
}

export function loadDraft(market: string): DraftState | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + market);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isObj(parsed) || typeof parsed.draft_id !== 'string' || !UUID_RE.test(parsed.draft_id)) return null;
    const section = typeof parsed.section === 'number' ? Math.max(0, Math.min(SECTION_TITLES.length - 1, Math.floor(parsed.section))) : 0;
    return {
      draft_id: parsed.draft_id,
      section,
      values: mergeValues(parsed.values),
      saved_at: typeof parsed.saved_at === 'string' ? parsed.saved_at : '',
    };
  } catch {
    return null;
  }
}

export function saveDraft(market: string, state: Omit<DraftState, 'saved_at'>): void {
  try {
    const payload: DraftState = { ...state, saved_at: new Date().toISOString() };
    localStorage.setItem(KEY_PREFIX + market, JSON.stringify(payload));
  } catch {
    // Storage blocked or full: the form still works, it just will not survive a reload.
  }
}

export function clearDraft(market: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + market);
  } catch {
    // ignore
  }
}

/* ── Prefill ── */

/** Fold a returning vendor's prefill into a blank form. Only fields the prefill covers are touched. */
export function applyPrefill(values: ApplyValues, prefill: PrefillView, config: ApplicationConfig, token: string): ApplyValues {
  const p = prefill.producer;
  const categoryKeys = new Set(config.categories.map((c) => c.key));
  const typeKeys = new Set(config.product_types.map((t) => t.key));
  const next: ApplyValues = JSON.parse(JSON.stringify(values)) as ApplyValues;
  const b = next.business;
  b.name = p.contact_name || b.name;
  b.business_name = p.business_name || b.business_name;
  b.email = p.email || b.email;
  b.mobile = p.phone || b.mobile;
  b.website = p.website || b.website;
  b.social = p.social || b.social;
  if (p.address) {
    b.street = p.address.street;
    b.city = p.address.city;
    b.state = p.address.state;
    b.zip = p.address.zip;
  }
  b.description = p.description_public || b.description;
  b.years_in_operation = p.years_in_operation === null || p.years_in_operation === undefined ? b.years_in_operation : String(p.years_in_operation);
  b.outlets = p.outlets || b.outlets;
  b.agricultural_practices = p.agricultural_practices ?? b.agricultural_practices;
  b.is_returning = true;
  if (prefill.last_membership?.usual_booth_label) b.last_stall = prefill.last_membership.usual_booth_label;

  const cats = (p.categories || []).filter((c) => categoryKeys.has(c));
  if (cats.length > 0) next.categories = cats;
  const products = (p.products || []).filter((e) => typeKeys.has(e.type));
  if (products.length > 0) {
    next.products = products.map((e) => ({
      type: e.type,
      items: [...(e.items || [])],
      practices: [...(e.practices || [])],
      description: e.description || '',
      details: { ...(e.details || {}) },
    }));
    // Make sure every prefilled type's category is selected so the type is visible.
    for (const e of next.products) {
      const t = config.product_types.find((x) => x.key === e.type);
      if (t && !t.category_keys.some((k) => next.categories.includes(k))) {
        const k = t.category_keys.find((c) => categoryKeys.has(c));
        if (k) next.categories.push(k);
      }
    }
  }
  const methods = (p.payment_methods || []).filter((m) => config.payment_methods.some((o) => o.key === m));
  if (methods.length > 0) next.payment_methods = methods;

  const last = prefill.last_membership;
  if (last) {
    next.booth.rate = last.fee_plan;
    next.booth.spaces = last.spaces;
    next.booth.electric = last.electric;
    next.booth.pay_in_full = last.fee_plan === 'seasonal' ? last.pay_in_full : false;
  }
  next.prefill_token = token;
  return next;
}

/* ── Product helpers ── */

/** Product types the applicant may list: those offered under at least one selected category. */
export function availableTypes(config: ApplicationConfig, categories: string[]): ProductTypeConfig[] {
  return config.product_types
    .filter((t) => t.category_keys.some((k) => categories.includes(k)))
    .sort((a, b) => a.sort - b.sort);
}

export type PermitChoice = PermitEntry['status'];

/** The permit answers allowed for a product type's rule. Empty when no permit control is shown. */
export function permitChoices(rule: ProductTypeConfig['permit_upload']): PermitChoice[] {
  switch (rule) {
    case 'required':
      return ['uploaded', 'will_provide'];
    case 'required_unless_food_freedom':
      return ['uploaded', 'will_provide', 'food_freedom'];
    case 'optional':
      return ['uploaded', 'will_provide', 'not_required'];
    default:
      return [];
  }
}

export function permitIsRequired(rule: ProductTypeConfig['permit_upload']): boolean {
  return rule === 'required' || rule === 'required_unless_food_freedom';
}

/* ── Validation ── */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function localToday(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function mobileDigits(raw: string): number {
  return raw.replace(/\D/g, '').length;
}

/** Messages for one section; an empty list means the section is complete. Section 4 (review) re-checks all. */
export function validateSection(index: number, v: ApplyValues, config: ApplicationConfig): string[] {
  const errs: string[] = [];
  if (index === 4) {
    for (let i = 0; i < 4; i++) errs.push(...validateSection(i, v, config));
    return errs;
  }

  if (index === 0) {
    const b = v.business;
    if (!b.name.trim()) errs.push('Enter your name.');
    if (!b.business_name.trim()) errs.push('Enter your business or farm name.');
    if (!EMAIL_RE.test(b.email.trim())) errs.push('Enter a valid email address.');
    const digits = mobileDigits(b.mobile);
    if (!(digits === 10 || (digits === 11 && b.mobile.replace(/\D/g, '').startsWith('1')))) {
      errs.push('Enter a 10-digit mobile number for market texts.');
    }
    if (!b.sms_consent) errs.push('Please agree to receive market texts at your mobile number.');
    if (!b.street.trim() || !b.city.trim() || !b.state.trim() || !b.zip.trim()) errs.push('Enter your full address (street, city, state and ZIP).');
    if (!b.agricultural_practices) errs.push('Choose the option that best describes your growing practices.');
    if (b.years_in_operation.trim() !== '') {
      const n = Number(b.years_in_operation);
      if (!Number.isInteger(n) || n < 0 || n > 150) errs.push('Years in operation must be a whole number.');
    }
    if (b.is_returning === null) errs.push('Tell us whether you are a new or returning vendor.');
  }

  if (index === 1) {
    if (v.categories.length === 0) errs.push('Choose at least one vendor category.');
    const types = availableTypes(config, v.categories);
    if (v.categories.length > 0 && v.products.length === 0) errs.push('Choose at least one thing you sell.');
    for (const entry of v.products) {
      const t = types.find((x) => x.key === entry.type);
      if (!t) {
        errs.push('One of the products you chose does not match your categories. Remove it or add its category.');
        continue;
      }
      if (entry.items.length === 0) errs.push(`${t.label}: list every item you sell (add at least one).`);
      for (const d of t.details) {
        if (!d.required || d.type === 'boolean') continue;
        const val = entry.details[d.key];
        if (val === undefined || String(val).trim() === '') errs.push(`${t.label}: ${d.label} is required.`);
      }
      if (permitIsRequired(t.permit_upload)) {
        const permit = v.permits[t.key];
        const allowed = permitChoices(t.permit_upload);
        if (!permit || !allowed.includes(permit.status)) {
          errs.push(`${t.label}: upload your permit, or say you will provide it before your first market.`);
        } else if (permit.status === 'uploaded' && !permit.upload_id) {
          errs.push(`${t.label}: finish uploading your permit or choose another option.`);
        }
      } else if (v.permits[t.key]?.status === 'uploaded' && !v.permits[t.key]?.upload_id) {
        errs.push(`${t.label}: finish uploading your permit or choose another option.`);
      }
    }
  }

  if (index === 2) {
    const bo = v.booth;
    if (!bo.rate) errs.push('Choose seasonal or daily booth rate.');
    if (bo.rate === 'daily' && !bo.frequency) errs.push('Tell us how often you expect to sell at the daily rate.');
    if (v.payment_methods.length === 0) errs.push('Choose at least one payment method you accept from customers.');
    if (!v.acknowledgements.own_booth_only) errs.push('Please confirm that you sell only what you grow, raise or produce, from your own booth.');
  }

  if (index === 3) {
    const ins = v.insurance;
    if (!ins.status) errs.push('Tell us about your liability insurance.');
    if (ins.status === 'have' && ins.expires_on) {
      if (!DATE_RE.test(ins.expires_on)) errs.push('Enter the insurance expiry date as a valid date.');
      else if (ins.expires_on < localToday()) errs.push('That insurance certificate has already expired. Enter the date of your current policy.');
    }
    const a = v.acknowledgements;
    if (!a.rules) errs.push('Please confirm you have read and agree to the Rules and Regulations.');
    if (!a.weekly_report) errs.push('Please agree to complete the weekly market report.');
    if (!a.farm_visits) errs.push('Please agree to random farm or facility visits.');
    if (!a.marketing) errs.push('Please acknowledge the market may use your name, logo and photos to promote the market.');
    if (!a.products_listed_only) errs.push('Please confirm you will sell only the items listed on your application.');
    if (v.signature_name.trim().length < 2) errs.push('Type your full legal name as your signature.');
  }
  return errs;
}

/** True when every section before `index` validates (so the applicant may open section `index`). */
export function sectionReachable(index: number, v: ApplyValues, config: ApplicationConfig): boolean {
  for (let i = 0; i < index; i++) if (validateSection(i, v, config).length > 0) return false;
  return true;
}

/* ── Submission ── */

function cleanDetails(entry: ProductEntry, t: ProductTypeConfig): ProductEntry['details'] {
  const out: ProductEntry['details'] = {};
  for (const d of t.details) {
    const val = entry.details[d.key];
    if (val === undefined || val === null) continue;
    if (d.type === 'boolean') {
      if (val === true) out[d.key] = true;
    } else if (d.type === 'number') {
      if (String(val).trim() === '') continue;
      const n = Number(val);
      if (Number.isFinite(n)) out[d.key] = n;
    } else {
      const s = String(val).trim();
      if (s) out[d.key] = s;
    }
  }
  return out;
}

/** Map validated form state to the POST /api/applications body. Call only after every section validates. */
export function buildSubmitInput(v: ApplyValues, config: ApplicationConfig, draftId: string): ApplicationSubmitInput {
  const b = v.business;
  const types = availableTypes(config, v.categories);

  const products: ProductEntry[] = [];
  const permits: Record<string, PermitEntry> = {};
  for (const entry of v.products) {
    const t = types.find((x) => x.key === entry.type);
    if (!t) continue;
    products.push({
      type: t.key,
      items: entry.items.map((s) => s.trim()).filter(Boolean),
      practices: entry.practices.filter((k) => t.practice_checklist.some((p) => p.key === k)),
      description: entry.description.trim(),
      details: cleanDetails(entry, t),
    });
    const permit = v.permits[t.key];
    if (permit && permitChoices(t.permit_upload).includes(permit.status)) {
      permits[t.key] = {
        status: permit.status,
        upload_id: permit.status === 'uploaded' ? permit.upload_id : null,
        note: (permit.note || '').trim(),
      };
    }
  }

  const bo = v.booth;
  const rate: BoothRate = bo.rate === 'daily' ? 'daily' : 'seasonal';
  const ins = v.insurance;
  const haveCert = ins.status === 'have';
  const years = b.years_in_operation.trim() === '' ? null : Number(b.years_in_operation);

  return {
    market_id: config.market.id,
    draft_id: draftId,
    prefill_token: v.prefill_token,
    contact: {
      name: b.name.trim(),
      business_name: b.business_name.trim(),
      email: b.email.trim(),
      mobile: normalizePhone(b.mobile),
      website: b.website.trim(),
      social: b.social.trim(),
      address: { street: b.street.trim(), city: b.city.trim(), state: b.state.trim(), zip: b.zip.trim() },
      description: b.description.trim(),
      years_in_operation: years,
      outlets: b.outlets.trim(),
      agricultural_practices: (b.agricultural_practices || 'not_applicable') as AgriculturalPractice,
      additional_info: b.additional_info.trim(),
    },
    sms_consent: b.sms_consent,
    sms_consent_version: config.legal.sms_consent_version,
    returning: { is_returning: b.is_returning === true, last_stall: b.is_returning === true && b.last_stall.trim() ? b.last_stall.trim() : null },
    categories: v.categories,
    products,
    permits,
    booth: {
      rate,
      frequency: rate === 'daily' && bo.frequency ? bo.frequency : null,
      months: rate === 'daily' ? bo.months : [],
      spaces: bo.spaces,
      electric: bo.electric,
      pay_in_full: rate === 'seasonal' ? bo.pay_in_full : false,
      stall_preference: bo.stall_preference.slice(0, config.limits.stall_preference_max),
      food_truck: bo.food_truck,
    },
    payment_methods: v.payment_methods,
    insurance: {
      status: (ins.status || 'none') as InsuranceAnswer,
      certificate_upload_id: haveCert ? ins.certificate_upload_id : null,
      carrier: haveCert ? ins.carrier.trim() : '',
      expires_on: haveCert && ins.expires_on ? ins.expires_on : null,
    },
    acknowledgements: { ...v.acknowledgements },
    rules_version: config.legal.rules_version,
    signature_name: v.signature_name.trim(),
  };
}
