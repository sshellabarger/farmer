'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { api } from './api';

interface AuthUser {
  id: string;
  name: string;
  role: string;
  phone: string;
}

interface AuthFarm {
  id: string;
  name: string;
}

interface AuthMarket {
  id: string;
  name: string;
}

interface AuthContextType {
  user: AuthUser | null;
  farm: AuthFarm | null;
  market: AuthMarket | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  requestOtp: (phone: string) => Promise<void>;
  login: (phone: string, code: string) => Promise<{ role: string; hasFarm: boolean; hasMarket: boolean }>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [farm, setFarm] = useState<AuthFarm | null>(null);
  const [market, setMarket] = useState<AuthMarket | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Check existing token on mount. Also capture a token passed in the URL
  // (?token=...) from an SMS "view-link" — this must happen BEFORE we decide
  // the user is logged out, otherwise clicking a texted dashboard link bounces
  // to /login.
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
        setUser(data.user);
        setFarm(data.farm);
        setMarket(data.market);
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
    localStorage.setItem('farmlink_token', data.token);
    setToken(data.token);
    setUser(data.user);
    setFarm(data.farm);
    setMarket(data.market);
    return {
      role: data.user.role,
      hasFarm: !!data.farm,
      hasMarket: !!data.market,
    };
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('farmlink_token');
    setToken(null);
    setUser(null);
    setFarm(null);
    setMarket(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        farm,
        market,
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
