'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, type AuthUser } from '@/lib/auth-context';

export function isStaffRole(role: string | undefined | null): boolean {
  return role === 'admin' || role === 'market_manager';
}

/**
 * Staff-only page guard (contract §8.1). Redirects to /login when the
 * visitor is not signed in, is not admin/market_manager, or — with
 * `adminOnly` — is not an admin. `ready` is true once the user is allowed
 * to see the page; render nothing (or a loading state) until then.
 */
export function useStaffGuard(opts?: { adminOnly?: boolean }): { user: AuthUser | null; isAdmin: boolean; ready: boolean } {
  const { user, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const adminOnly = !!opts?.adminOnly;

  const isAdmin = user?.role === 'admin';
  const allowed = !!user && isAuthenticated && (adminOnly ? isAdmin : isStaffRole(user.role));

  useEffect(() => {
    if (isLoading) return;
    if (!allowed) router.replace('/login');
  }, [isLoading, allowed, router]);

  return { user, isAdmin, ready: !isLoading && allowed };
}

/** Whether a user may act on a market (admins: all; managers: assigned only). */
export function canAccessMarket(user: AuthUser | null, marketId: string): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'market_manager') return false;
  return user.assigned_market_ids.includes(marketId);
}
