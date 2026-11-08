// D29: a text from a number that matches no producer is logged and never answered
// (except STOP / START / HELP). A known producer's workflow is unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ADMIN_PHONE, P1_PHONE, T_OPEN, boot, seed, type Db } from './helpers/a1-fixtures.js';
import { REPLIES } from '../src/services/inbound.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T_OPEN);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const STRANGER = '+15015559999';
const inboundUrl = (from: string, message: string) =>
  `/api/sms/voipms/inbound?from=${from.replace('+', '')}&message=${encodeURIComponent(message)}&id=sms-${Math.random().toString(36).slice(2)}`;
const outbound = (db: Db) => Object.values(db.dump('messages')).filter((m) => m.direction === 'outbound');
const inboundRows = (db: Db) => Object.values(db.dump('messages')).filter((m) => m.direction === 'inbound');

describe('an unknown number', () => {
  it('a plain text is logged and nothing is sent', async () => {
    const db = seed();
    const app = await boot(db);
    const res = await app.inject({ method: 'GET', url: inboundUrl(STRANGER, 'Pre-approved loan offer, reply now') });
    expect(res.statusCode).toBe(200);
    expect(inboundRows(db)).toHaveLength(1);
    expect(inboundRows(db)[0]).toMatchObject({ from: STRANGER, body: 'Pre-approved loan offer, reply now', status: 'received' });
    expect(outbound(db)).toHaveLength(0);

    await app.inject({ method: 'GET', url: inboundUrl(STRANGER, 'second spam') });
    expect(inboundRows(db)).toHaveLength(2);
    expect(outbound(db)).toHaveLength(0);
  });

  it('HELP gets one help reply', async () => {
    const db = seed();
    const app = await boot(db);
    await app.inject({ method: 'GET', url: inboundUrl(STRANGER, 'HELP') });
    expect(outbound(db)).toHaveLength(1);
    expect(outbound(db)[0]).toMatchObject({ kind: 'help', to: STRANGER, body: REPLIES.help });
  });

  it('STOP gets one opt-out confirmation and START one opt-in confirmation', async () => {
    const db = seed();
    const app = await boot(db);
    await app.inject({ method: 'GET', url: inboundUrl(STRANGER, 'STOP') });
    expect(outbound(db).map((m) => m.kind)).toEqual(['opt_out_confirm']);
    await app.inject({ method: 'GET', url: inboundUrl(STRANGER, 'START') });
    expect(outbound(db).map((m) => m.kind).sort()).toEqual(['opt_in_confirm', 'opt_out_confirm']);
  });

  it('a staff member\'s own number gets no reply to a plain text either', async () => {
    const db = seed();
    const app = await boot(db);
    await app.inject({ method: 'GET', url: inboundUrl(ADMIN_PHONE, 'testing the number') });
    expect(inboundRows(db)).toHaveLength(1);
    expect(outbound(db)).toHaveLength(0);
  });

  it('the old "service has closed" reply is gone', () => {
    expect((REPLIES as Record<string, unknown>).closed).toBeUndefined();
  });
});

describe('a known producer (unchanged)', () => {
  const known = () =>
    seed({
      producers: { p1: { business_name: 'Testfield Farm', contact_name: 'Terry', phone: P1_PHONE, emails: ['owner@testfield.example'], active: true, sms_opt_out_at: null } },
      users: { admin1: { name: 'Admin', role: 'admin', phone: ADMIN_PHONE, active: true } },
    });

  it('a free text is forwarded to staff and gets one courtesy reply per 24 hours', async () => {
    const db = known();
    const app = await boot(db);
    await app.inject({ method: 'GET', url: inboundUrl(P1_PHONE, 'running late today') });
    const kinds = () => outbound(db).map((m) => m.kind).sort();
    expect(kinds()).toEqual(['auto_reply', 'forwarded_inbound']);
    expect(outbound(db).find((m) => m.kind === 'forwarded_inbound')).toMatchObject({ to: ADMIN_PHONE });
    expect(outbound(db).find((m) => m.kind === 'auto_reply')).toMatchObject({ to: P1_PHONE, body: REPLIES.received });

    await app.inject({ method: 'GET', url: inboundUrl(P1_PHONE, 'and another thing') });
    expect(kinds()).toEqual(['auto_reply', 'forwarded_inbound', 'forwarded_inbound']); // forwarded again, no second courtesy reply
  });

  it('HELP from a producer still answers', async () => {
    const db = known();
    const app = await boot(db);
    await app.inject({ method: 'GET', url: inboundUrl(P1_PHONE, 'help') });
    expect(outbound(db).map((m) => m.kind)).toEqual(['help']);
  });
});
