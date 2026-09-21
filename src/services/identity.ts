/**
 * Producer identity resolution (SPEC §7.9): identity by email, never by name
 * alone. Pure functions, no I/O, fully unit-testable.
 *
 * SHARED VERBATIM: executor D owns this file; executor A2 copies it
 * byte-for-byte. Do not reformat, do not add code here — put extensions in
 * your own module and import from this one.
 *
 * Two survey rows belong to the same producer when they share any of:
 *   1. a normalized email address,
 *   2. a non-generic email domain (a business domain), or
 *   3. the first significant word of the vendor name (see nameKey).
 * Union-find over those three keys yields the clusters.
 */

/** Consumer mail domains that must never link two producers. */
export const GENERIC_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'protonmail.com', 'proton.me', 'mail.com', 'zoho.com', 'gmx.com',
  'att.net', 'sbcglobal.net', 'bellsouth.net', 'comcast.net', 'cox.net', 'charter.net',
  'verizon.net', 'earthlink.net', 'centurylink.net', 'windstream.net', 'suddenlink.net',
  'example.com',
]);

/** Words that mark a name as a business rather than a person. */
export const BUSINESS_WORDS: ReadonlySet<string> = new Set([
  'farm', 'farms', 'farmstead', 'bakery', 'bakehouse', 'bakes', 'baking', 'co', 'company',
  'llc', 'inc', 'ltd', 'market', 'markets', 'coffee', 'kitchen', 'orchard', 'orchards',
  'ranch', 'nursery', 'homestead', 'microgreens', 'crafts', 'project', 'network', 'garden',
  'gardens', 'greenhouse', 'acres', 'apiary', 'honey', 'creamery', 'dairy', 'produce',
  'foods', 'eggs', 'meats', 'soap', 'soaps', 'candles', 'pottery', 'studio', 'sweets',
  'treats', 'mushrooms', 'flowers', 'herbs', 'creations', 'provisions', 'goods',
  'collective', 'cooperative', 'coop', 'bbq', 'jams', 'jellies',
]);

/** Articles and prepositions skipped when looking for the first significant word. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'of', 'at', 'by', 'from', 'for', 'with', 'in', 'on', 'to', 'my', 'our',
]);

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/**
 * Lower-cased, trimmed, stripped of `mailto:` and `Name <addr>` wrapping and
 * of embedded whitespace. Returns null when the result is not an email.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  const angle = s.match(/<([^>]+)>/);
  if (angle) s = angle[1].trim();
  if (s.startsWith('mailto:')) s = s.slice('mailto:'.length);
  s = s.replace(/\s+/g, '');
  return isValidEmail(s) ? s : null;
}

/** Domain part of a normalized email, or null when the input is not an email. */
export function emailDomain(email: string | null | undefined): string | null {
  const n = normalizeEmail(email);
  if (!n) return null;
  return n.slice(n.lastIndexOf('@') + 1);
}

export function isGenericDomain(domain: string): boolean {
  return GENERIC_DOMAINS.has(domain.trim().toLowerCase());
}

/**
 * Lower-case ASCII tokens of a name: accents stripped, `&`/`+` mapped to
 * "and", possessive `'s` dropped ("Sarah's" → "sarah"), punctuation removed.
 */
export function nameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[&+]/g, ' and ')
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return s ? s.split(' ') : [];
}

/**
 * The first significant word of a name: the first token that is at least two
 * characters long and not a stop word. Empty string when there is none.
 */
export function nameKey(name: string | null | undefined): string {
  for (const t of nameTokens(name)) {
    if (t.length >= 2 && !STOP_WORDS.has(t)) return t;
  }
  return '';
}

export function looksLikeBusiness(name: string | null | undefined): boolean {
  return nameTokens(name).some((t) => BUSINESS_WORDS.has(t));
}

/** Minimal union-find (disjoint set) over integer indexes. */
export class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = new Array<number>(size).fill(0);
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[i] !== root) {
      const next = this.parent[i];
      this.parent[i] = root;
      i = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) {
      this.parent[ra] = rb;
    } else if (this.rank[ra] > this.rank[rb]) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra] += 1;
    }
  }

  /** Members of every set, each ascending, sets ordered by their smallest member. */
  groups(): number[][] {
    const byRoot = new Map<number, number[]>();
    for (let i = 0; i < this.parent.length; i += 1) {
      const root = this.find(i);
      const members = byRoot.get(root);
      if (members) members.push(i);
      else byRoot.set(root, [i]);
    }
    return [...byRoot.values()].sort((x, y) => x[0] - y[0]);
  }
}

function compareScores(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Pick the canonical spelling from `variants` (name → occurrence count):
 * business-looking names beat person-looking ones, then the most frequent,
 * then the longest (most complete), then alphabetical. Names are compared
 * trimmed with whitespace collapsed; the returned name is in that form.
 */
export function chooseCanonicalName(variants: Map<string, number>): string {
  let bestName = '';
  let bestScore: number[] | null = null;
  const counts = new Map<string, number>();
  for (const [name, count] of variants) {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) continue;
    counts.set(clean, (counts.get(clean) ?? 0) + count);
  }
  for (const [name, count] of counts) {
    const score = [looksLikeBusiness(name) ? 1 : 0, count, name.length];
    const cmp = bestScore ? compareScores(score, bestScore) : 1;
    if (cmp > 0 || (cmp === 0 && name < bestName)) {
      bestName = name;
      bestScore = score;
    }
  }
  return bestName;
}

export interface IdentityRow {
  /** Vendor name as typed on the form (may be a business or a person). */
  name: string;
  /** Every email cell of the row; blanks and invalid values are ignored. */
  emails: Array<string | null | undefined>;
}

export interface IdentityCluster {
  /** Indexes into the input rows, ascending. */
  rows: number[];
  canonical_name: string;
  /** Every other distinct name variant (trimmed, whitespace collapsed), sorted. */
  aliases: string[];
  /** Every normalized email seen in the cluster, sorted. */
  emails: string[];
  /** Non-generic email domains seen in the cluster, sorted. */
  domains: string[];
  /** Distinct name keys seen in the cluster, sorted. */
  name_keys: string[];
}

/**
 * Cluster rows into producers by union-find over normalized email,
 * non-generic email domain and name key, then choose one canonical name per
 * cluster: among the business-looking variants when any exist (otherwise all
 * variants), the largest name-key group by occurrences wins, and
 * chooseCanonicalName picks the spelling within that group.
 */
export function resolveProducerIdentity(rows: IdentityRow[]): IdentityCluster[] {
  const uf = new UnionFind(rows.length);
  const byEmail = new Map<string, number>();
  const byDomain = new Map<string, number>();
  const byNameKey = new Map<string, number>();

  const link = (map: Map<string, number>, key: string, index: number) => {
    const first = map.get(key);
    if (first === undefined) map.set(key, index);
    else uf.union(first, index);
  };

  rows.forEach((row, index) => {
    for (const raw of row.emails) {
      const email = normalizeEmail(raw);
      if (!email) continue;
      link(byEmail, email, index);
      const domain = email.slice(email.lastIndexOf('@') + 1);
      if (!isGenericDomain(domain)) link(byDomain, domain, index);
    }
    const key = nameKey(row.name);
    if (key) link(byNameKey, key, index);
  });

  return uf.groups().map((members) => {
    const variants = new Map<string, number>();
    const emails = new Set<string>();
    const domains = new Set<string>();
    const keys = new Set<string>();
    for (const i of members) {
      const clean = rows[i].name.trim().replace(/\s+/g, ' ');
      if (clean) variants.set(clean, (variants.get(clean) ?? 0) + 1);
      for (const raw of rows[i].emails) {
        const email = normalizeEmail(raw);
        if (!email) continue;
        emails.add(email);
        const domain = email.slice(email.lastIndexOf('@') + 1);
        if (!isGenericDomain(domain)) domains.add(domain);
      }
      const key = nameKey(rows[i].name);
      if (key) keys.add(key);
    }

    const business = new Map<string, number>();
    for (const [name, count] of variants) if (looksLikeBusiness(name)) business.set(name, count);
    const pool = business.size > 0 ? business : variants;

    const groups = new Map<string, Map<string, number>>();
    for (const [name, count] of pool) {
      const key = nameKey(name);
      const group = groups.get(key) ?? new Map<string, number>();
      group.set(name, count);
      groups.set(key, group);
    }
    let largest: Map<string, number> = new Map();
    let largestTotal = -1;
    let largestKey = '';
    for (const [key, group] of groups) {
      const total = [...group.values()].reduce((sum, n) => sum + n, 0);
      if (total > largestTotal || (total === largestTotal && key < largestKey)) {
        largest = group;
        largestTotal = total;
        largestKey = key;
      }
    }
    const canonical = chooseCanonicalName(largest);

    return {
      rows: members,
      canonical_name: canonical,
      aliases: [...variants.keys()].filter((n) => n !== canonical).sort(),
      emails: [...emails].sort(),
      domains: [...domains].sort(),
      name_keys: [...keys].sort(),
    };
  });
}
