// Outside a production deploy the app may only open the local emulator
// (handoff 05 #16: v1 dev and seed runs wrote to the production project).
import { describe, it, expect } from 'vitest';
import { resolveDbTarget, DEV_PROJECT_ID } from '../src/db/firestore.js';

describe('database target', () => {
  it('refuses to open Firestore in dev or test without the emulator', () => {
    expect(() => resolveDbTarget({ NODE_ENV: 'development' })).toThrow(/emulator/);
    expect(() => resolveDbTarget({ NODE_ENV: 'test' })).toThrow(/emulator/);
    expect(() => resolveDbTarget({})).toThrow(/emulator/);
  });
  it('uses a demo project, never the real one, with the emulator', () => {
    expect(resolveDbTarget({ NODE_ENV: 'development', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toEqual({ projectId: DEV_PROJECT_ID });
    expect(DEV_PROJECT_ID.startsWith('demo-')).toBe(true);
  });
  it('uses the real project in production and rejects an emulator host there', () => {
    expect(resolveDbTarget({ NODE_ENV: 'production' })).toEqual({});
    expect(() => resolveDbTarget({ NODE_ENV: 'production', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toThrow();
  });
});
