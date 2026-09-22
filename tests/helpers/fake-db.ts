// Minimal in-memory stand-in for the Firestore admin SDK, covering only what
// the surviving routes use: collection().doc().get/set/update/delete and
// collection().where('==').limit().get(). Anything fancier throws so a test
// can't silently pass against an unsupported query.
// Phase 3 fix: doc().create() mirrors the admin SDK's atomic create — it throws a
// GoogleError-shaped `{ code: 6, message: '6 ALREADY_EXISTS: …' }` when the doc exists.
// Phase 3 fix 2: doc().update() honours dotted field paths exactly as the admin
// SDK does (see FakeDocRef.update), and every write rejects `undefined` values
// the way the SDK does ("Cannot use "undefined" as a Firestore value").

import { Timestamp } from 'firebase-admin/firestore';

type Doc = Record<string, unknown>;

// The admin SDK returns `Timestamp` instances for every date field, never
// `Date`. Mirror that on every read so code that forgets to normalise (see
// src/utils/dates.ts) fails here, in a test, instead of in production — the
// nightly rollMarketDates run died on `doc.end_at.getTime()` on 2026-09-22.
// `dump()` stays raw so tests can still assert on what was written.
function fromStore(value: unknown): unknown {
  if (value instanceof Date) return Timestamp.fromDate(value);
  if (Array.isArray(value)) return value.map(fromStore);
  if (value && typeof value === 'object' && !(value instanceof Timestamp)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = fromStore(v);
    return out;
  }
  return value;
}

/**
 * Deep copy of a value going into or living in the store: Dates stay Dates
 * (fresh instances), Timestamps are immutable and shared, arrays and plain
 * objects are rebuilt. Writes clone what they store and update() clones the
 * stored doc before mutating it, so a caller holding an earlier `dump()`
 * object (or the object it passed to set()) never sees a later write.
 */
function clone(value: unknown): unknown {
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Timestamp) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = clone(v);
    return out;
  }
  return value;
}

/** The admin SDK refuses `undefined` anywhere in a write unless `ignoreUndefinedProperties` is on (it is not, in src/db/firestore.ts). */
function assertNoUndefined(value: unknown, path: string): void {
  if (value === undefined) {
    throw new Error(`Cannot use "undefined" as a Firestore value (found in field "${path}"). If you want to ignore undefined values, enable \`ignoreUndefinedProperties\`.`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Timestamp)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertNoUndefined(v, path ? `${path}.${k}` : k);
  }
}

function assertValidDocument(data: Doc): void {
  for (const [k, v] of Object.entries(data)) assertNoUndefined(v, k);
}

/**
 * What the admin SDK validates on an update map: every key is a field path
 * (dotted, no empty segment), no `undefined` values, and no key may name a
 * field that another key reaches into ('a' together with 'a.b' is
 * `Field "a" was specified multiple times.`).
 */
function assertValidUpdate(data: Doc): void {
  const keys = Object.keys(data);
  for (const key of keys) {
    if (key === '' || key.startsWith('.') || key.endsWith('.') || key.includes('..')) {
      throw new Error(`Value for argument "${key}" is not a valid field path. Paths must not be empty, begin with ".", end with ".", or contain "..".`);
    }
    assertNoUndefined(data[key], key);
  }
  for (const a of keys) {
    for (const b of keys) {
      if (a !== b && b.startsWith(`${a}.`)) throw new Error(`Value for argument "dataOrField" is not a valid update map. Field "${a}" was specified multiple times.`);
    }
  }
}

function isMap(value: unknown): value is Doc {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof Timestamp);
}

class FakeDocRef {
  constructor(private store: Map<string, Doc>, public id: string, private colName = '') {}
  async get() {
    const data = this.store.get(this.id);
    return { id: this.id, exists: data !== undefined, data: () => (data ? (fromStore(data) as Doc) : undefined), ref: this };
  }
  /** Whole-document write; keys are literal field names (a dotted key is NOT a path here, as in the SDK). */
  async set(data: Doc, opts?: { merge?: boolean }) {
    assertValidDocument(data);
    const prev = opts?.merge ? this.store.get(this.id) ?? {} : {};
    this.store.set(this.id, { ...prev, ...(clone(data) as Doc) });
  }
  /**
   * Atomic create, as the admin SDK's `DocumentReference.create()`: writes the
   * doc only when it does not exist, otherwise rejects with what
   * @google-cloud/firestore surfaces — a GoogleError whose `code` is
   * `6` (ALREADY_EXISTS) and whose message starts `6 ALREADY_EXISTS: Document
   * already exists: <path>`. The exists-check and the write happen in one
   * synchronous step, so interleaved async callers can never both succeed.
   */
  async create(data: Doc) {
    assertValidDocument(data);
    if (this.store.has(this.id)) {
      const path = this.colName ? `${this.colName}/${this.id}` : this.id;
      const err = new Error(`6 ALREADY_EXISTS: Document already exists: ${path}`) as Error & { code: number };
      err.code = 6;
      throw err;
    }
    this.store.set(this.id, clone(data) as Doc);
  }
  /**
   * Field-level update, as the admin SDK's `DocumentReference.update(data)`:
   *   - the doc must exist (NOT_FOUND otherwise, gRPC code 5);
   *   - a plain key replaces that top-level field;
   *   - a dotted key `'a.b.c'` is a field path: it sets the nested field,
   *     creating (or replacing, when the parent is not a map) the intermediate
   *     maps, and touches no sibling field — two interleaved updates to
   *     different paths inside the same map both survive;
   *   - `undefined` values and prefix conflicts are rejected up front.
   * The stored doc is deep-copied before mutation.
   */
  async update(data: Doc) {
    const prev = this.store.get(this.id);
    if (!prev) {
      const path = this.colName ? `${this.colName}/${this.id}` : this.id;
      const err = new Error(`NOT_FOUND: ${this.id} (5 NOT_FOUND: No document to update: ${path})`) as Error & { code: number };
      err.code = 5;
      throw err;
    }
    assertValidUpdate(data);
    const next = clone(prev) as Doc;
    for (const [key, value] of Object.entries(data)) {
      const segments = key.split('.');
      let cursor: Doc = next;
      for (const segment of segments.slice(0, -1)) {
        if (!isMap(cursor[segment])) cursor[segment] = {};
        cursor = cursor[segment] as Doc;
      }
      cursor[segments[segments.length - 1]!] = clone(value);
    }
    this.store.set(this.id, next);
  }
  async delete() {
    this.store.delete(this.id);
  }
}

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private max: number | null = null;
  constructor(private store: Map<string, Doc>, protected colName = '') {}
  where(field: string, op: string, value: unknown) {
    if (op !== '==') throw new Error(`fake-db: unsupported operator ${op}`);
    this.filters.push([field, value]);
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  async get() {
    let docs = [...this.store.entries()]
      .filter(([, data]) => this.filters.every(([f, v]) => data[f] === v))
      .map(([id, data]) => ({ id, exists: true, data: () => fromStore(data) as Doc, ref: new FakeDocRef(this.store, id, this.colName) }));
    if (this.max !== null) docs = docs.slice(0, this.max);
    return { empty: docs.length === 0, size: docs.length, docs };
  }
}

export class FakeCollection extends FakeQuery {
  constructor(private col: Map<string, Doc>, name = '') {
    super(col, name);
  }
  doc(id: string = `auto-${this.col.size + 1}`) {
    return new FakeDocRef(this.col, id, this.colName);
  }
  async add(data: Doc) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

export function fakeDb(seed: Record<string, Record<string, Doc>> = {}) {
  const cols = new Map<string, Map<string, Doc>>();
  for (const [name, docs] of Object.entries(seed)) {
    cols.set(name, new Map(Object.entries(docs)));
  }
  const col = (name: string) => {
    if (!cols.has(name)) cols.set(name, new Map());
    return cols.get(name)!;
  };
  return {
    collection(name: string) {
      return new FakeCollection(col(name), name);
    },
    /** Test-only: read a whole collection as {id: data}. */
    dump(name: string): Record<string, Doc> {
      return Object.fromEntries(col(name));
    },
    /** Test-only (contract §1.6, D's importer tests): document count of a collection. */
    count(name: string): number {
      return col(name).size;
    },
  };
}
