// The fake Firestore's update() semantics (Phase 3 fix 2). Every behaviour
// asserted here was checked against @google-cloud/firestore's own client-side
// validation before it was mirrored: dotted keys are field paths in update()
// only, intermediate maps are created, sibling fields are untouched, a key and
// a path inside it in one update is rejected, and `undefined` is refused.
import { describe, it, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { fakeDb } from './helpers/fake-db.js';

describe('fake-db update() with dotted field paths', () => {
  it('creates nested paths, leaving sibling fields alone', async () => {
    const db = fakeDb();
    const ref = db.collection('market_dates').doc('d1');
    await ref.set({ status: 'collecting', actions: { checkin_sent_at: null, reminders_sent: [], deadline_at: new Date('2026-09-22T17:00:00Z') } });

    await ref.update({ 'actions.checkin_sent_at': new Date('2026-09-19T18:00:00Z'), 'actions.claims.checkin': new Date('2026-09-19T18:00:00Z') });
    await ref.update({ 'actions.reminder_state.offset_1440': { offset_min: 1440, recipients: 2 }, updated_at: new Date('2026-09-20T17:00:00Z') });

    expect(db.dump('market_dates').d1).toEqual({
      status: 'collecting',
      actions: {
        checkin_sent_at: new Date('2026-09-19T18:00:00Z'),
        reminders_sent: [],
        deadline_at: new Date('2026-09-22T17:00:00Z'),
        claims: { checkin: new Date('2026-09-19T18:00:00Z') },
        reminder_state: { offset_1440: { offset_min: 1440, recipients: 2 } },
      },
      updated_at: new Date('2026-09-20T17:00:00Z'),
    });
  });

  it('a plain key still replaces the whole top-level field', async () => {
    const db = fakeDb();
    const ref = db.collection('x').doc('a');
    await ref.set({ actions: { a: 1, b: 2 }, n: 1 });
    await ref.update({ actions: { c: 3 } });
    expect(db.dump('x').a).toEqual({ actions: { c: 3 }, n: 1 });
  });

  it('two interleaved dotted updates to different fields of the same map both survive', async () => {
    const db = fakeDb();
    const ref = db.collection('x').doc('a');
    await ref.set({ actions: { checkin_sent_at: null, deadline_processed_at: null } });
    // Both writers hold a pre-write view of the map (the old whole-map pattern
    // would have had the later writer drop the earlier write).
    await Promise.all([
      ref.update({ 'actions.checkin_sent_at': new Date('2026-09-19T18:00:00Z') }),
      ref.update({ 'actions.deadline_processed_at': new Date('2026-09-19T18:00:00Z'), 'actions.summary_sent_at': new Date('2026-09-19T18:00:00Z') }),
    ]);
    expect(db.dump('x').a).toEqual({
      actions: {
        checkin_sent_at: new Date('2026-09-19T18:00:00Z'),
        deadline_processed_at: new Date('2026-09-19T18:00:00Z'),
        summary_sent_at: new Date('2026-09-19T18:00:00Z'),
      },
    });
  });

  it('replaces a non-map parent with a map, like Firestore', async () => {
    const db = fakeDb();
    const ref = db.collection('x').doc('a');
    await ref.set({ actions: null, list: [1] });
    await ref.update({ 'actions.x': 1, 'list.y': 2 });
    expect(db.dump('x').a).toEqual({ actions: { x: 1 }, list: { y: 2 } });
  });

  it('throws NOT_FOUND (code 5) for a missing doc, as before', async () => {
    const db = fakeDb();
    await expect(db.collection('x').doc('missing').update({ 'a.b': 1 })).rejects.toMatchObject({ code: 5, message: expect.stringContaining('NOT_FOUND') });
    expect(db.count('x')).toBe(0);
  });

  it('rejects a field and a path inside it in one update, an undefined value, and a malformed path', async () => {
    const db = fakeDb();
    const ref = db.collection('x').doc('a');
    await ref.set({ a: { b: 0 } });
    await expect(ref.update({ 'a.b': 1, a: { c: 2 } })).rejects.toThrow('Field "a" was specified multiple times');
    await expect(ref.update({ 'a.b': undefined })).rejects.toThrow('Cannot use "undefined" as a Firestore value');
    await expect(ref.update({ a: { b: undefined } })).rejects.toThrow('found in field "a.b"');
    await expect(ref.update({ 'a..b': 1 })).rejects.toThrow('not a valid field path');
    await expect(ref.set({ x: undefined })).rejects.toThrow('Cannot use "undefined"');
    await expect(db.collection('x').doc('fresh').create({ x: { y: undefined } })).rejects.toThrow('found in field "x.y"');
    expect(db.dump('x').a).toEqual({ a: { b: 0 } }); // nothing was written
  });

  it('deep-copies: a dump() object captured before an update is unaffected, and Dates stay Dates in the store', async () => {
    const db = fakeDb();
    const ref = db.collection('x').doc('a');
    const when = new Date('2026-09-19T18:00:00Z');
    await ref.set({ actions: { at: when, list: [when] } });
    const before = db.dump('x').a! as { actions: { at: Date; list: Date[]; later?: unknown } };
    await ref.update({ 'actions.later': 1, 'actions.at': new Date('2026-09-20T18:00:00Z') });
    expect(before.actions.later).toBeUndefined();
    expect(before.actions.at).toEqual(when);
    const after = db.dump('x').a! as { actions: { at: unknown; list: unknown[]; later: unknown } };
    expect(after.actions.later).toBe(1);
    expect(after.actions.at).toBeInstanceOf(Date);
    expect(after.actions.list[0]).toBeInstanceOf(Date);
    // Reads still convert every Date to a Timestamp, nested paths included.
    const read = (await ref.get()).data()! as { actions: { at: unknown; list: unknown[] } };
    expect(read.actions.at).toBeInstanceOf(Timestamp);
    expect(read.actions.list[0]).toBeInstanceOf(Timestamp);
    // The object handed to set() is not aliased by the store either.
    const input = { n: { v: 1 } };
    await db.collection('x').doc('b').set(input);
    input.n.v = 2;
    expect(db.dump('x').b).toEqual({ n: { v: 1 } });
  });

  it('set() treats a dotted key literally (only update() parses paths), as the SDK does', async () => {
    const db = fakeDb();
    await db.collection('x').doc('a').set({ 'a.b': 1 });
    expect(db.dump('x').a).toEqual({ 'a.b': 1 });
  });
});
