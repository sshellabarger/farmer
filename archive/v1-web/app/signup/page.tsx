'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { Header } from '@/components/header';
import { FARMLINK_NUMBER_DISPLAY } from '@/lib/constants';

type Step = 'role' | 'details' | 'business' | 'verify';

const inputCls =
  'w-full px-4 py-3 border border-earth-200 rounded-xl text-[15px] focus:outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 bg-bg';
const labelCls = 'block text-xs font-bold text-text-muted uppercase tracking-[0.08em] mb-1.5';
const primaryBtnCls =
  'py-3.5 text-white rounded-full font-bold text-[15px] transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer border-none';
const primaryBtnStyle = { background: 'linear-gradient(135deg, #21512C 0%, #3D7A47 100%)' };

function SignupContent() {
  const { login } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Marketing pages link here with ?role=farmer / ?role=market — skip straight to details.
  const preselect = searchParams.get('role');
  const initialRole = preselect === 'farmer' || preselect === 'market' ? preselect : null;

  const [step, setStep] = useState<Step>(initialRole ? 'details' : 'role');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Form state
  const [role, setRole] = useState<'farmer' | 'market' | null>(initialRole);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [location, setLocation] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [marketType, setMarketType] = useState('farmers_market');
  const [deliveryPref, setDeliveryPref] = useState('both');
  const [code, setCode] = useState('');

  const formatPhone = (raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return raw.startsWith('+') ? raw : `+${digits}`;
  };

  const handleSubmitDetails = () => {
    if (!name.trim() || !email.trim() || !phone.trim()) {
      setError('Please fill in all fields');
      return;
    }
    if (!/\S+@\S+\.\S+/.test(email)) {
      setError('Please enter a valid email address');
      return;
    }
    setError('');
    setPhone(formatPhone(phone));
    setStep('business');
  };

  const handleSubmitBusiness = async () => {
    if (!businessName.trim() || !location.trim()) {
      setError('Please fill in all fields');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const formatted = formatPhone(phone);
      await api.signup({
        name: name.trim(),
        email: email.trim(),
        phone: formatted,
        role: role!,
        businessName: businessName.trim(),
        location: location.trim(),
        specialty: role === 'farmer' ? specialty.trim() : undefined,
        marketType: role === 'market' ? marketType : undefined,
        deliveryPref: role === 'market' ? deliveryPref : undefined,
      });
      setPhone(formatted);
      setStep('verify');
    } catch (err: any) {
      setError(err.message || 'Signup failed');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    setError('');
    setLoading(true);
    try {
      const result = await login(phone, code);
      if (result.hasFarm) {
        router.push('/farmer');
      } else if (result.hasMarket) {
        router.push('/market');
      } else {
        router.push('/');
      }
    } catch (err: any) {
      setError(err.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const stepNumber = step === 'role' ? 1 : step === 'details' ? 2 : step === 'business' ? 3 : 4;

  return (
    <div className="min-h-screen bg-bg font-sans">
      <Header />
      <div className="max-w-[480px] mx-auto px-4 sm:px-6 py-10 sm:py-14">
        <div className="text-center mb-7">
          <h1 className="h-display mb-2" style={{ fontSize: 'clamp(28px, 5vw, 36px)' }}>
            {step === 'verify' ? 'Almost there' : 'Join the network'}
          </h1>
          <p className="text-[15px] text-text-soft m-0">
            {step === 'role' && 'Free during the Little Rock pilot. Takes about two minutes.'}
            {step === 'details' && 'Your contact information.'}
            {step === 'business' && `Tell us about your ${role === 'farmer' ? 'farm' : 'market'}.`}
            {step === 'verify' && 'Verify the phone number you’ll text from.'}
          </p>
          {/* Progress dots */}
          <div className="flex justify-center gap-2 mt-4">
            {[1, 2, 3, 4].map(n => (
              <div
                key={n}
                className="h-2 rounded-full transition-all"
                style={{
                  background: n <= stepNumber ? '#2A5E33' : '#DCD8CC',
                  width: n === stepNumber ? 22 : 8,
                }}
              />
            ))}
          </div>
        </div>

        <div className="bg-white rounded-[20px] border border-border p-6 sm:p-7" style={{ boxShadow: '0 3px 18px rgba(20,46,27,0.05)' }}>
          {error && (
            <div className="mb-4 px-4 py-3 bg-red-50 text-red-500 rounded-xl text-sm border border-red-50">
              {error}
            </div>
          )}

          {/* Step 1: Choose Role */}
          {step === 'role' && (
            <div>
              <p className="text-sm text-text-soft mb-4 text-center">How will you use FarmLink?</p>
              <div className="grid grid-cols-1 gap-3">
                <button
                  onClick={() => { setRole('farmer'); setError(''); setStep('details'); }}
                  className="p-5 rounded-2xl border-2 border-earth-100 transition-all cursor-pointer bg-white hover:border-green-500 hover:bg-green-50 text-left"
                >
                  <div className="flex items-start gap-3.5">
                    <div className="text-3xl">🌾</div>
                    <div>
                      <div className="font-display font-semibold text-text text-[17px]">I grow food</div>
                      <div className="text-[13px] text-text-muted mt-1 leading-snug">Farms, ranches, and growers who want to sell or distribute locally</div>
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => { setRole('market'); setError(''); setStep('details'); }}
                  className="p-5 rounded-2xl border-2 border-earth-100 transition-all cursor-pointer bg-white hover:border-accent-500 hover:bg-accent-50 text-left"
                >
                  <div className="flex items-start gap-3.5">
                    <div className="text-3xl">🏪</div>
                    <div>
                      <div className="font-display font-semibold text-text text-[17px]">I buy food</div>
                      <div className="text-[13px] text-text-muted mt-1 leading-snug">Restaurants, groceries, food hubs, food banks, schools, co-ops, and any organization sourcing local food</div>
                    </div>
                  </div>
                </button>
              </div>

              <div className="mt-6 text-center text-[13px] text-text-muted">
                Already have an account?{' '}
                <button
                  onClick={() => router.push('/login')}
                  className="text-green-700 font-semibold bg-transparent border-none cursor-pointer underline"
                >
                  Sign in
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Personal Details */}
          {step === 'details' && (
            <div>
              <div className="mb-4">
                <label className={labelCls}>Full Name</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Sarah Mitchell" className={inputCls} autoFocus />
              </div>
              <div className="mb-4">
                <label className={labelCls}>Email Address</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="sarah@greenacres.com" className={inputCls} />
              </div>
              <div className="mb-5">
                <label className={labelCls}>Phone Number</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSubmitDetails()}
                  placeholder="(501) 555-0201"
                  className={inputCls}
                />
                <div className="text-xs text-text-muted mt-1.5">
                  This is the number you&apos;ll text FarmLink from — we&apos;ll send a verification code to it.
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { setStep('role'); setError(''); }}
                  className="px-5 py-3.5 bg-earth-50 text-text-soft rounded-full font-semibold text-sm cursor-pointer border-none hover:bg-earth-100 transition-colors"
                >
                  Back
                </button>
                <button onClick={handleSubmitDetails} className={`flex-1 ${primaryBtnCls}`} style={primaryBtnStyle}>
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Business Details */}
          {step === 'business' && (
            <div>
              <div className="mb-4">
                <label className={labelCls}>{role === 'farmer' ? 'Farm Name' : 'Market / Business Name'}</label>
                <input
                  type="text"
                  value={businessName}
                  onChange={e => setBusinessName(e.target.value)}
                  placeholder={role === 'farmer' ? 'Green Acres Farm' : 'ABC Market'}
                  className={inputCls}
                  autoFocus
                />
              </div>
              <div className="mb-4">
                <label className={labelCls}>Location</label>
                <input type="text" value={location} onChange={e => setLocation(e.target.value)} placeholder="Little Rock, AR" className={inputCls} />
              </div>

              {role === 'farmer' && (
                <div className="mb-4">
                  <label className={labelCls}>
                    Specialty <span className="text-earth-300 normal-case font-medium">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={specialty}
                    onChange={e => setSpecialty(e.target.value)}
                    placeholder="Organic vegetables, herbs, etc."
                    className={inputCls}
                  />
                </div>
              )}

              {role === 'market' && (
                <>
                  <div className="mb-4">
                    <label className={labelCls}>Market Type</label>
                    <select value={marketType} onChange={e => setMarketType(e.target.value)} className={`${inputCls} bg-white`}>
                      <option value="farmers_market">Farmers Market</option>
                      <option value="restaurant">Restaurant</option>
                      <option value="grocery">Grocery Store</option>
                      <option value="co_op">Co-op</option>
                      <option value="food_hub">Food Hub</option>
                      <option value="food_bank">Food Bank</option>
                      <option value="food_pantry">Food Pantry</option>
                      <option value="school">School / Institution</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div className="mb-4 p-3.5 bg-blue-50 rounded-xl">
                    <div className="flex items-start gap-2">
                      <span className="text-base mt-0.5">📍</span>
                      <div>
                        <div className="text-xs font-bold text-blue-500">Central Pickup Location</div>
                        <div className="text-xs text-text-soft mt-0.5">All orders are picked up from the FarmLink Depot at 10301 N Rodney Parham Rd, STE C1, Little Rock, AR 72227</div>
                      </div>
                    </div>
                  </div>
                </>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => { setStep('details'); setError(''); }}
                  className="px-5 py-3.5 bg-earth-50 text-text-soft rounded-full font-semibold text-sm cursor-pointer border-none hover:bg-earth-100 transition-colors"
                >
                  Back
                </button>
                <button onClick={handleSubmitBusiness} disabled={loading} className={`flex-1 ${primaryBtnCls}`} style={primaryBtnStyle}>
                  {loading ? 'Creating Account…' : 'Create Account & Verify'}
                </button>
              </div>
            </div>
          )}

          {/* Step 4: Phone Verification */}
          {step === 'verify' && (
            <div>
              <div className="mb-4 p-4 bg-green-50 rounded-xl text-center">
                <div className="text-green-700 font-bold text-sm mb-1">Account created!</div>
                <div className="text-text-soft text-xs">
                  We sent a verification code to <span className="font-mono font-semibold">{phone}</span>
                </div>
              </div>

              <label className={labelCls}>Verification Code</label>
              <input
                type="text"
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={e => e.key === 'Enter' && code.length === 6 && handleVerify()}
                placeholder="000000"
                maxLength={6}
                className="w-full px-4 py-3 border border-earth-200 rounded-xl text-center tracking-[0.5em] font-mono text-lg focus:outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 mb-4 bg-bg"
                autoFocus
              />
              <button onClick={handleVerify} disabled={code.length !== 6 || loading} className={`w-full ${primaryBtnCls}`} style={primaryBtnStyle}>
                {loading ? 'Verifying…' : 'Verify & Sign In'}
              </button>

              <div className="mt-4 px-4 py-3 bg-green-50/70 border border-green-100 rounded-xl text-[13px] text-green-700 text-center leading-relaxed">
                💡 Once you&apos;re in, you can run everything by texting{' '}
                <strong className="font-bold">{FARMLINK_NUMBER_DISPLAY}</strong> — save it to your contacts.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupContent />
    </Suspense>
  );
}
