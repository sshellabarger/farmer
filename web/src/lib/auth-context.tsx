'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { api } from './api';

export interface AuthUser {
  id: string;
  name: string;
  role: string;
  phone: string;
  email: string | null;
  assigned_market_ids: string[];
}

/** Fill the Phase 2 fields the API may omit (older tokens, legacy users). */
function toAuthUser(raw: any): AuthUser {
  return {
    id: String(raw?.id ?? ''),
    name: String(raw?.name ?? ''),
    role: String(raw?.role ?? ''),
    phone: String(raw?.phone ?? ''),
    email: typeof raw?.email === 'string' ? raw.email : null,
    assigned_market_ids: Array.isArray(raw?.assigned_market_ids) ? raw.assigned_market_ids.map(String) : [],
  };
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  requestOtp: (phone: string) => Promise<void>;
  login: (phone: string, code: string) => Promise<{ role: string }>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Check existing token on mount. Also capture a token passed in the URL
  // (?token=...) — harmless, and it keeps any still-circulating v1 links
  // from bouncing straight to /login before the session is bootstrapped.
  useEffect(() => {
    let stored = localStorage.getItem('farmlink_token');

    try {
      const urlToken = new URLSearchParams(window.location.search).get('token');
      if (urlToken) {
        localStorage.setItem('farmlink_token', urlToken);
        stored = urlToken;
        // Strip the token from the URL so it isn't bookmarked or leaked in history.
        const url = new URL(window.location.href);
        url.searchParams.delete('token');
        window.history.replaceState({}, '', url.pathname + url.search + url.hash);
      }
    } catch {
      /* window/URL not available — ignore */
    }

    if (!stored) {
      setIsLoading(false);
      return;
    }
    setToken(stored);
    api.getMe()
      .then((data) => {
        setUser(toAuthUser(data.user));
      })
      .catch(() => {
        localStorage.removeItem('farmlink_token');
        setToken(null);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const requestOtp = useCallback(async (phone: string) => {
    await api.requestOtp(phone);
  }, []);

  const login = useCallback(async (phone: string, code: string) => {
    const data = await api.verifyOtp(phone, code);
    if (!data?.token || !data?.user) {
      throw new Error('Login failed — no session returned. Please try again.');
    }
    const user = toAuthUser(data.user);
    localStorage.setItem('farmlink_token', data.token);
    setToken(data.token);
    setUser(user);
    return { role: user.role };
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('farmlink_token');
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isLoading,
        isAuthenticated: !!user,
        requestOtp,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
