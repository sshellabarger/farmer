'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { Header } from '@/components/header';
import { Icon } from '@/components/icons';

const TEST_USERS = [
  { label: 'Sarah Mitchell (Farmer)', phone: '+15015550201' },
  { label: 'Jake Rivera (Farmer)', phone: '+15015550202' },
  { label: 'Tom at ABC (Market)', phone: '+15015550101' },
  { label: 'Scott Shellabarger', phone: '+15015550300' },
];

export default function LoginPage() {
  const { requestOtp, login } = useAuth();
  const router = useRouter();
  const [step, setStep] = useState<'phone' | 'otp' | 'role-pick'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [userName, setUserName] = useState<string | null>(null);

  const formatPhone = (raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return raw.startsWith('+') ? raw : `+${digits}`;
  };

  const handleRequestOtp = async () => {
    setError('');
    setLoading(true);
    try {
      const formatted = formatPhone(phone);
      setPhone(formatted);

      // Check if phone is registered
      const check = await api.checkPhone(formatted);
      if (!check.exists) {
        setError('No account found with this number. Please sign up first.');
        setLoading(false);
        return;
      }
      setUserName(check.user?.name || null);

      await requestOtp(formatted);
      setStep('otp');
    } catch (err: any) {
      setError(err.message || 'Failed to send OTP');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    setError('');
    setLoading(true);
    try {
      const result = await login(phone, code);
      if (result.role === 'both') {
        // User has both roles — let them pick which view
        setStep('role-pick');
        setLoading(false);
        return;
      }
      if (result.hasFarm) {
        router.push('/farmer');
      } else if (result.hasMarket) {
        router.push('/market');
      } else {
        router.push('/');
      }
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-earth-15">
      <Header />
      <div className="max-w-[420px] mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="bg-white rounded-2xl shadow-lg overflow-hidden border border-earth-100">
          {/* Card header */}
          <div
            className="px-6 py-5 text-center"
            style={{ background: 'linear-gradient(135deg, #1a3409, #2d5016 40%, #4a7c28)' }}
          >
            <div className="w-14 h-14 rounded-2xl bg-white/[0.13] flex items-center justify-center mx-auto mb-3">
              <Icon name="leaf" size={28} />
            </div>
            <h1 className="text-white font-display font-extrabold text-xl m-0">
              Sign in to FarmLink
            </h1>
            <p className="text-white/50 text-xs mt-1">
              {step === 'phone' ? 'Enter your phone number' : step === 'role-pick' ? 'Choose your dashboard view' : `Welcome back${userName ? `, ${userName}` : ''}`}
            </p>
          </div>

          <div className="p-6">
            {error && (
              <div className="mb-4 px-4 py-3 bg-red-50 text-red-700 rounded-xl text-sm border border-red-100">
                {error}
                {error.includes('sign up') && (
                  <button
                    onClick={() => router.push('/signup')}
                    className="block mt-2 text-farm-600 font-semibold bg-transparent border-none cursor-pointer underline text-xs"
                  >
                    Create an account
                  </button>
                )}
              </div>
            )}

            {step === 'role-pick' ? (
              <div className="space-y-3">
                {userName && (
                  <div className="mb-2 p-3 bg-farm-50 rounded-xl text-center">
                    <div className="text-farm-700 font-bold text-sm">Welcome, {userName}!</div>
                    <div className="text-earth-500 text-xs mt-1">You have both a farm and a market. Choose a view:</div>
                  </div>
                )}
                <button
                  onClick={() => router.push('/farmer')}
                  className="w-full p-4 bg-white border-2 border-earth-200 rounded-xl cursor-pointer hover:border-farm-500 hover:bg-farm-50 transition-all text-left group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center text-xl">🌾</div>
                    <div>
                      <div className="font-bold text-sm text-earth-800">Farmer Dashboard</div>
                      <div className="text-xs text-earth-500 mt-0.5">Manage inventory, orders &amp; market connections</div>
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => router.push('/market')}
                  className="w-full p-4 bg-white border-2 border-earth-200 rounded-xl cursor-pointer hover:border-blue-500 hover:bg-blue-50 transition-all text-left group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center text-xl">🏪</div>
                    <div>
                      <div className="font-bold text-sm text-earth-800">Market Dashboard</div>
                      <div className="text-xs text-earth-500 mt-0.5">Browse farms, place orders &amp; manage deliveries</div>
                    </div>
                  </div>
                </button>
              </div>
            ) : step === 'phone' ? (
              <>
                <label className="block text-xs font-semibold text-earth-500 uppercase tracking-wide mb-2">
                  Phone Number
                </label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleRequestOtp()}
                  placeholder="(501) 555-0201"
                  className="w-full px-4 py-3 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100 mb-4"
                  autoFocus
                />
                <button
                  onClick={handleRequestOtp}
                  disabled={!phone.trim() || loading}
                  className="w-full py-3 bg-farm-600 text-white rounded-xl font-semibold text-sm hover:bg-farm-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer border-none"
                >
                  {loading ? 'Checking...' : 'Send Verification Code'}
                </button>

                {/* Quick select for dev */}
                <div className="mt-6 pt-5 border-t border-earth-100">
                  <div className="text-[10px] text-earth-400 font-semibold uppercase tracking-wide mb-2">
                    Quick sign in (seeded accounts)
                  </div>
                  {TEST_USERS.map((u) => (
                    <button
                      key={u.phone}
                      onClick={() => setPhone(u.phone)}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-earth-15 rounded-lg transition-colors cursor-pointer bg-transparent border-none"
                    >
                      <span className="font-medium text-earth-700">{u.label}</span>
                      <span className="text-earth-400 ml-2 font-mono text-[11px]">{u.phone}</span>
                    </button>
                  ))}
                </div>

                <div className="mt-5 text-center text-xs text-earth-400">
                  Don&apos;t have an account?{' '}
                  <button
                    onClick={() => router.push('/signup')}
                    className="text-farm-600 font-semibold bg-transparent border-none cursor-pointer underline"
                  >
                    Sign up
                  </button>
                </div>
              </>
            ) : (
              <>
                {userName && (
                  <div className="mb-4 p-3 bg-farm-50 rounded-xl text-center">
                    <div className="text-farm-700 font-bold text-sm">Welcome back, {userName}!</div>
                  </div>
                )}
                <div className="text-sm text-earth-600 mb-4">
                  Code sent to <span className="font-semibold font-mono">{phone}</span>
                </div>
                <label className="block text-xs font-semibold text-earth-500 uppercase tracking-wide mb-2">
                  Verification Code
                </label>
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && handleVerify()}
                  placeholder="000000"
                  maxLength={6}
                  className="w-full px-4 py-3 border border-earth-200 rounded-xl text-sm text-center tracking-[0.5em] font-mono text-lg focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100 mb-4"
                  autoFocus
                />
                <button
                  onClick={handleVerify}
                  disabled={code.length !== 6 || loading}
                  className="w-full py-3 bg-farm-600 text-white rounded-xl font-semibold text-sm hover:bg-farm-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer border-none mb-3"
                >
                  {loading ? 'Verifying...' : 'Sign In'}
                </button>
                <button
                  onClick={() => { setStep('phone'); setCode(''); setError(''); setUserName(null); }}
                  className="w-full py-2 bg-transparent border-none text-earth-500 text-xs font-medium cursor-pointer hover:text-earth-700"
                >
                  ← Use a different number
                </button>
                <div className="mt-4 px-4 py-3 bg-farm-50 rounded-xl text-xs text-farm-700 text-center">
                  <strong>Dev mode:</strong> Any 6-digit code works (try 123456)
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
