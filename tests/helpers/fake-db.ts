// Minimal in-memory stand-in for the Firestore admin SDK, covering only what
// the surviving routes use: collection().doc().get/set/update/delete and
// collection().where('==').limit().get(). Anything fancier throws so a test
// can't silently pass against an unsupported query.
// Phase 3 fix: doc().create() mirrors the admin SDK's atomic create — it throws a
// GoogleError-shaped `{ code: 6, message: '6 ALREADY_EXISTS: …' }` when the doc exists.

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

class FakeDocRef {
  constructor(private store: Map<string, Doc>, public id: string, private colName = '') {}
  async get() {
    const data = this.store.get(this.id);
    return { id: this.id, exists: data !== undefined, data: () => (data ? (fromStore(data) as Doc) : undefined), ref: this };
  }
  async set(data: Doc, opts?: { merge?: boolean }) {
    const prev = opts?.merge ? this.store.get(this.id) ?? {} : {};
    this.store.set(this.id, { ...prev, ...data });
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
    if (this.store.has(this.id)) {
      const path = this.colName ? `${this.colName}/${this.id}` : this.id;
      const err = new Error(`6 ALREADY_EXISTS: Document already exists: ${path}`) as Error & { code: number };
      err.code = 6;
      throw err;
    }
    this.store.set(this.id, { ...data });
  }
  async update(data: Doc) {
    const prev = this.store.get(this.id);
    if (!prev) throw new Error(`NOT_FOUND: ${this.id}`);
    this.store.set(this.id, { ...prev, ...data });
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
