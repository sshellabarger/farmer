import { signJwt } from './jwt.js';
import type { Env } from '../config/env.js';
import { getDb } from '../db/firestore.js';

export type ViewTab = 'inventory' | 'orders' | 'deliveries' | 'markets' | 'analytics' | 'recurring';

function randomToken(len = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export async function generateViewLink({
  env,
  userId,
  role,
  tab,
  expiresInHours = 24,
}: {
  env: Env;
  userId: string;
  role: string;
  tab: ViewTab;
  expiresInHours?: number;
}): Promise<string> {
  const token = randomToken(8);
  const db = getDb();
  const expiresAt = new Date(Date.now() + expiresInHours * 3600 * 1000);

  await db.collection('view_links').doc(token).set({
    userId,
    role,
    tab,
    expires_at: expiresAt,
    created_at: new Date(),
  });

  return `${env.APP_URL}/api/view/${token}`;
}

export function resolveViewToken(payload: string, jwtSecret: string): { jwt: string; role: string; tab: string } {
  const { userId, role, tab } = JSON.parse(payload) as { userId: string; role: string; tab: string };
  const jwt = signJwt({ sub: userId, role }, jwtSecret);
  return { jwt, role, tab };
}
