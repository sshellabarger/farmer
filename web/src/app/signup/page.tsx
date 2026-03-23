'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { Header } from '@/components/header';
import { Icon } from '@/components/icons';

type Step = 'role' | 'details' | 'business' | 'verify';

export default function SignupPage() {
  const { login } = useAuth();
  const router = useRouter();

  const [step, setStep] = useState<Step>('role');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Form state
  const [role, setRole] = useState<'farmer' | 'market' | null>(null);
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
    <div className="min-h-screen bg-earth-15">
      <Header />
      <div className="max-w-[480px] mx-auto px-4 sm:px-6 py-8 sm:py-12">
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
              Create Your Account
            </h1>
            <p className="text-white/50 text-xs mt-1">
              {step === 'role' && 'Choose your account type'}
              {step === 'details' && 'Your contact information'}
              {step === 'business' && `${role === 'farmer' ? 'Farm' : 'Market'} details`}
              {step === 'verify' && 'Verify your phone number'}
            </p>
            {/* Progress dots */}
            <div className="flex justify-center gap-2 mt-3">
              {[1, 2, 3, 4].map(n => (
                <div
                  key={n}
                  className="w-2 h-2 rounded-full transition-all"
                  style={{
                    background: n <= stepNumber ? '#fff' : 'rgba(255,255,255,0.25)',
                    width: n === stepNumber ? 20 : 8,
                  }}
                />
              ))}
            </div>
          </div>

          <div className="p-6">
            {error && (
              <div className="mb-4 px-4 py-3 bg-red-50 text-red-700 rounded-xl text-sm border border-red-100">
                {error}
              </div>
            )}

            {/* Step 1: Choose Role */}
            {step === 'role' && (
              <div>
                <p className="text-sm text-earth-600 mb-4 text-center">
                  How will you use FarmLink?
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => { setRole('farmer'); setError(''); setStep('details'); }}
                    className="p-5 rounded-xl border-2 transition-all cursor-pointer bg-white hover:border-farm-400 hover:bg-farm-50 text-center"
                    style={{ borderColor: '#e8e0d4' }}
                  >
                    <div className="text-3xl mb-2">🌱</div>
                    <div className="font-bold text-earth-900 text-sm">I&apos;m a Farmer</div>
                    <div className="text-[11px] text-earth-500 mt-1">Sell produce to markets</div>
                  </button>
                  <button
                    onClick={() => { setRole('market'); setError(''); setStep('details'); }}
                    className="p-5 rounded-xl border-2 transition-all cursor-pointer bg-white hover:border-blue-400 hover:bg-blue-50 text-center"
                    style={{ borderColor: '#e8e0d4' }}
                  >
                    <div className="text-3xl mb-2">🏪</div>
                    <div className="font-bold text-earth-900 text-sm">I&apos;m a Market</div>
                    <div className="text-[11px] text-earth-500 mt-1">Buy from local farms</div>
                  </button>
                </div>

                <div className="mt-6 text-center text-xs text-earth-400">
                  Already have an account?{' '}
                  <button
                    onClick={() => router.push('/login')}
                    className="text-farm-600 font-semibold bg-transparent border-none cursor-pointer underline"
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
                  <label className="block text-xs font-semibold text-earth-500 uppercase tracking-wide mb-1.5">
                    Full Name
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="Sarah Mitchell"
                    className="w-full px-4 py-3 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100"
                    autoFocus
                  />
                </div>
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-earth-500 uppercase tracking-wide mb-1.5">
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="sarah@greenacres.com"
                    className="w-full px-4 py-3 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100"
                  />
                </div>
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-earth-500 uppercase tracking-wide mb-1.5">
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSubmitDetails()}
                    placeholder="(501) 555-0201"
                    className="w-full px-4 py-3 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100"
                  />
                  <div className="text-[11px] text-earth-400 mt-1.5">
                    We&apos;ll send a verification code to this number
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setStep('role'); setError(''); }}
                    className="px-4 py-3 bg-earth-100 text-earth-600 rounded-xl font-semibold text-sm cursor-pointer border-none hover:bg-earth-200 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleSubmitDetails}
                    className="flex-1 py-3 bg-farm-600 text-white rounded-xl font-semibold text-sm hover:bg-farm-700 transition-colors cursor-pointer border-none"
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: Business Details */}
            {step === 'business' && (
              <div>
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-earth-500 uppercase tracking-wide mb-1.5">
                    {role === 'farmer' ? 'Farm Name' : 'Market / Business Name'}
                  </label>
                  <input
                    type="text"
                    value={businessName}
                    onChange={e => setBusinessName(e.target.value)}
                    placeholder={role === 'farmer' ? 'Green Acres Farm' : 'ABC Market'}
                    className="w-full px-4 py-3 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100"
                    autoFocus
                  />
                </div>
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-earth-500 uppercase tracking-wide mb-1.5">
                    Location
                  </label>
                  <input
                    type="text"
                    value={location}
                    onChange={e => setLocation(e.target.value)}
                    placeholder="Little Rock, AR"
                    className="w-full px-4 py-3 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100"
                  />
                </div>

                {role === 'farmer' && (
                  <div className="mb-4">
                    <label className="block text-xs font-semibold text-earth-500 uppercase tracking-wide mb-1.5">
                      Specialty <span className="text-earth-300">(optional)</span>
                    </label>
                    <input
                      type="text"
                      value={specialty}
                      onChange={e => setSpecialty(e.target.value)}
                      placeholder="Organic vegetables, herbs, etc."
                      className="w-full px-4 py-3 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100"
                    />
                  </div>
                )}

                {role === 'market' && (
                  <>
                    <div className="mb-4">
                      <label className="block text-xs font-semibold text-earth-500 uppercase tracking-wide mb-1.5">
                        Market Type
                      </label>
                      <select
                        value={marketType}
                        onChange={e => setMarketType(e.target.value)}
                        className="w-full px-4 py-3 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100 bg-white"
                      >
                        <option value="farmers_market">Farmers Market</option>
                        <option value="restaurant">Restaurant</option>
                        <option value="grocery">Grocery Store</option>
                        <option value="co_op">Co-op</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                    <div className="mb-4">
                      <label className="block text-xs font-semibold text-earth-500 uppercase tracking-wide mb-1.5">
                        Fulfillment Preference
                      </label>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { id: 'pickup', label: '📍 Pickup' },
                          { id: 'delivery', label: '🚚 Delivery' },
                          { id: 'both', label: '✅ Both' },
                        ].map(opt => (
                          <button
                            key={opt.id}
                            onClick={() => setDeliveryPref(opt.id)}
                            className={`px-3 py-2.5 text-xs font-bold rounded-xl border cursor-pointer transition-all ${
                              deliveryPref === opt.id
                                ? 'bg-farm-600 text-white border-farm-600'
                                : 'bg-white text-earth-600 border-earth-200 hover:border-farm-300'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={() => { setStep('details'); setError(''); }}
                    className="px-4 py-3 bg-earth-100 text-earth-600 rounded-xl font-semibold text-sm cursor-pointer border-none hover:bg-earth-200 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleSubmitBusiness}
                    disabled={loading}
                    className="flex-1 py-3 bg-farm-600 text-white rounded-xl font-semibold text-sm hover:bg-farm-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer border-none"
                  >
                    {loading ? 'Creating Account...' : 'Create Account & Verify'}
                  </button>
                </div>
              </div>
            )}

            {/* Step 4: Phone Verification */}
            {step === 'verify' && (
              <div>
                <div className="mb-4 p-4 bg-green-50 rounded-xl border border-green-100 text-center">
                  <div className="text-green-700 font-bold text-sm mb-1">Account Created!</div>
                  <div className="text-green-600 text-xs">
                    We sent a verification code to <span className="font-mono font-semibold">{phone}</span>
                  </div>
                </div>

                <label className="block text-xs font-semibold text-earth-500 uppercase tracking-wide mb-2">
                  Verification Code
                </label>
                <input
                  type="text"
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onKeyDown={e => e.key === 'Enter' && code.length === 6 && handleVerify()}
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
                  {loading ? 'Verifying...' : 'Verify & Sign In'}
                </button>

                <div className="mt-3 px-4 py-3 bg-farm-50 rounded-xl text-xs text-farm-700 text-center">
                  <strong>Dev mode:</strong> Any 6-digit code works (try 123456)
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
