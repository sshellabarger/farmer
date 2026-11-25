'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { Header } from '@/components/header';
import { Icon } from '@/components/icons';
import { FARMLINK_NUMBER_DISPLAY, smsHref } from '@/lib/constants';

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
    <div className="min-h-screen bg-bg font-sans">
      <Header />
      <div className="max-w-[440px] mx-auto px-4 sm:px-6 py-10 sm:py-16">
        <div className="text-center mb-7">
          <h1 className="h-display mb-2" style={{ fontSize: 'clamp(28px, 5vw, 36px)' }}>Welcome back</h1>
          <p className="text-[15px] text-text-soft m-0">
            {step === 'phone' && 'Sign in with the phone number you text from.'}
            {step === 'otp' && `Welcome back${userName ? `, ${userName}` : ''} — check your messages.`}
            {step === 'role-pick' && 'Choose which dashboard to open.'}
          </p>
        </div>

        <div className="bg-white rounded-[20px] border border-border p-6 sm:p-7" style={{ boxShadow: '0 3px 18px rgba(20,46,27,0.05)' }}>
          {error && (
            <div className="mb-4 px-4 py-3 bg-red-50 text-red-500 rounded-xl text-sm border border-red-50">
              {error}
              {error.includes('sign up') && (
                <button
                  onClick={() => router.push('/signup')}
                  className="block mt-2 text-green-700 font-semibold bg-transparent border-none cursor-pointer underline text-xs"
                >
                  Create an account
                </button>
              )}
            </div>
          )}

          {step === 'role-pick' ? (
            <div className="space-y-3">
              {userName && (
                <div className="mb-2 p-3 bg-green-50 rounded-xl text-center">
                  <div className="text-green-700 font-bold text-sm">Welcome, {userName}!</div>
                  <div className="text-text-muted text-xs mt-1">You have both a farm and a market. Choose a view:</div>
                </div>
              )}
              <button
                onClick={() => router.push('/farmer')}
                className="w-full p-4 bg-white border-2 border-earth-200 rounded-xl cursor-pointer hover:border-green-500 hover:bg-green-50 transition-all text-left"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center text-xl">🌾</div>
                  <div>
                    <div className="font-bold text-sm text-text">Farmer Dashboard</div>
                    <div className="text-xs text-text-muted mt-0.5">Manage inventory, orders &amp; drop-offs at the depot</div>
                  </div>
                </div>
              </button>
              <button
                onClick={() => router.push('/market')}
                className="w-full p-4 bg-white border-2 border-earth-200 rounded-xl cursor-pointer hover:border-accent-500 hover:bg-accent-50 transition-all text-left"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-accent-50 flex items-center justify-center text-xl">🏪</div>
                  <div>
                    <div className="font-bold text-sm text-text">Market Dashboard</div>
                    <div className="text-xs text-text-muted mt-0.5">Browse farms, order &amp; pick up at the depot</div>
                  </div>
                </div>
              </button>
            </div>
          ) : step === 'phone' ? (
            <>
              <label className="block text-xs font-bold text-text-muted uppercase tracking-[0.08em] mb-2">
                Phone Number
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleRequestOtp()}
                placeholder="(501) 555-0201"
                className="w-full px-4 py-3 border border-earth-200 rounded-xl text-[15px] focus:outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 mb-4 bg-bg"
                autoFocus
              />
              <button
                onClick={handleRequestOtp}
                disabled={!phone.trim() || loading}
                className="w-full py-3.5 text-white rounded-full font-bold text-[15px] transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer border-none"
                style={{ background: 'linear-gradient(135deg, #21512C 0%, #3D7A47 100%)' }}
              >
                {loading ? 'Checking…' : 'Send Verification Code'}
              </button>

              <div className="mt-5 text-center text-[13px] text-text-muted">
                Don&apos;t have an account?{' '}
                <button
                  onClick={() => router.push('/signup')}
                  className="text-green-700 font-semibold bg-transparent border-none cursor-pointer underline"
                >
                  Sign up free
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="text-sm text-text-soft mb-4">
                Code sent to <span className="font-semibold font-mono">{phone}</span>
              </div>
              <label className="block text-xs font-bold text-text-muted uppercase tracking-[0.08em] mb-2">
                Verification Code
              </label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && handleVerify()}
                placeholder="000000"
                maxLength={6}
                className="w-full px-4 py-3 border border-earth-200 rounded-xl text-center tracking-[0.5em] font-mono text-lg focus:outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 mb-4 bg-bg"
                autoFocus
              />
              <button
                onClick={handleVerify}
                disabled={code.length !== 6 || loading}
                className="w-full py-3.5 text-white rounded-full font-bold text-[15px] transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer border-none mb-3"
                style={{ background: 'linear-gradient(135deg, #21512C 0%, #3D7A47 100%)' }}
              >
                {loading ? 'Verifying…' : 'Sign In'}
              </button>
              <button
                onClick={() => { setStep('phone'); setCode(''); setError(''); setUserName(null); }}
                className="w-full py-2 bg-transparent border-none text-text-muted text-xs font-medium cursor-pointer hover:text-text-soft"
              >
                ← Use a different number
              </button>
              <button
                onClick={handleRequestOtp}
                disabled={loading}
                className="w-full py-2 bg-transparent border-none text-text-muted text-xs font-medium cursor-pointer hover:text-text-soft disabled:opacity-40"
              >
                Resend code
              </button>
            </>
          )}
        </div>

        {/* Text-first reminder */}
        <a
          href={smsHref('Hi FarmLink!')}
          className="mt-5 flex items-center justify-center gap-2 px-4 py-3 rounded-2xl no-underline bg-green-50/70 border border-green-100 text-green-700 text-[13.5px] font-semibold"
        >
          <Icon name="msg" size={15} />
          No dashboard needed — text {FARMLINK_NUMBER_DISPLAY} to do everything by SMS
        </a>
      </div>
    </div>
  );
}
