'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { Header } from '@/components/header';
import { Icon } from '@/components/icons';
import { FARMLINK_NUMBER_DISPLAY, smsHref } from '@/lib/constants';
import { isStaffRole } from '@/components/staff-guard';

export default function LoginPage() {
  const { user, isAuthenticated, isLoading, requestOtp, login, logout } = useAuth();
  const router = useRouter();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [userName, setUserName] = useState<string | null>(null);

  // Already signed in as staff (e.g. returning with a stored token) → go straight in.
  useEffect(() => {
    if (!isLoading && isAuthenticated && isStaffRole(user?.role)) {
      router.replace('/admin');
    }
  }, [isLoading, isAuthenticated, user, router]);

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
        setError('No account found with this number. Ask an SJCA administrator to invite you.');
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
      if (isStaffRole(result.role)) {
        router.push('/admin');
      }
      // Non-staff stay here: the signed-in branch below shows the staff-only notice.
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const signedInNonAdmin = !isLoading && isAuthenticated && !isStaffRole(user?.role);

  return (
    <div className="min-h-screen bg-bg font-sans">
      <Header />
      <div className="max-w-[440px] mx-auto px-4 sm:px-6 py-10 sm:py-16">
        <div className="text-center mb-7">
          <h1 className="h-display mb-2" style={{ fontSize: 'clamp(28px, 5vw, 36px)' }}>
            {signedInNonAdmin ? 'Market staff only' : 'Welcome back'}
          </h1>
          <p className="text-[15px] text-text-soft m-0">
            {signedInNonAdmin && 'This tool is for SJCA market staff.'}
            {!signedInNonAdmin && step === 'phone' && 'Sign in with the phone number you text from.'}
            {!signedInNonAdmin && step === 'otp' && `Welcome back${userName ? `, ${userName}` : ''} — check your messages.`}
          </p>
        </div>

        <div className="bg-white rounded-[20px] border border-border p-6 sm:p-7" style={{ boxShadow: '0 3px 18px rgba(20,46,27,0.05)' }}>
          {error && (
            <div className="mb-4 px-4 py-3 bg-red-50 text-red-500 rounded-xl text-sm border border-red-50">
              {error}
            </div>
          )}

          {signedInNonAdmin ? (
            <div className="text-center">
              <p className="text-sm text-text-soft mb-4">
                You are signed in as <span className="font-semibold">{user?.name}</span>, but this tool is for SJCA market staff.
                If you sold through FarmLink, you&apos;ll get a text when the new weekly check-in system is ready.
              </p>
              <button
                onClick={() => { logout(); setStep('phone'); setCode(''); setError(''); }}
                className="text-green-700 font-semibold bg-transparent border-none cursor-pointer underline text-sm"
              >
                Log out
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
                Staff accounts are created by invitation.
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
          href={smsHref('Hi SJCA Markets!')}
          className="mt-5 flex items-center justify-center gap-2 px-4 py-3 rounded-2xl no-underline bg-green-50/70 border border-green-100 text-green-700 text-[13.5px] font-semibold"
        >
          <Icon name="msg" size={15} />
          Questions? Text {FARMLINK_NUMBER_DISPLAY}
        </a>
      </div>
    </div>
  );
}
