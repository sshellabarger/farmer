'use client';

import { useEffect, useState } from 'react';
import { Header } from '@/components/header';
import { Icon } from '@/components/icons';
import { CheckboxField, Field, Notice, PrimaryButton } from '@/components/form';
import { formatDateLabel, formatTime12h } from '@/components/admin-shell';
import { FARMLINK_NUMBER_DISPLAY, smsHref } from '@/lib/constants';
import { api } from '@/lib/api';
import type { PublicMarket } from '@/lib/types';

/** Public vendor application (contract §8.3): page 1 (identity + markets), page 2 (placeholder). */
export default function ApplyPage() {
  const [markets, setMarkets] = useState<PublicMarket[]>([]);
  const [loadingMarkets, setLoadingMarkets] = useState(true);
  const [marketsError, setMarketsError] = useState('');

  const [page, setPage] = useState<1 | 2>(1);
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [phone, setPhone] = useState('');
  const [marketIds, setMarketIds] = useState<string[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    api
      .getPublicMarkets()
      .then((d) => setMarkets((d.markets || []).filter((m) => m.active)))
      .catch((err: any) => setMarketsError(err?.message || 'Could not load markets'))
      .finally(() => setLoadingMarkets(false));
  }, []);

  const toggleMarket = (id: string) => setMarketIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const page1Valid = email.trim() && businessName.trim() && contactPerson.trim() && phone.trim() && marketIds.length > 0;

  const goPage2 = () => {
    if (!page1Valid) { setError('Fill in every field and choose at least one market.'); return; }
    setError('');
    setPage(2);
  };

  const submit = async () => {
    setSubmitting(true);
    setError('');
    try {
      await api.submitApplication({
        email: email.trim(),
        business_name: businessName.trim(),
        contact_person: contactPerson.trim(),
        phone: phone.trim(),
        markets_applied: marketIds,
        extra: {},
      });
      setDone(true);
    } catch (err: any) {
      const msg: string = err?.message || 'Could not submit the application';
      setError(/duplicate|already have a recent/i.test(msg) ? 'We already have a recent application for this email.' : msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg font-sans flex flex-col">
      <Header />
      <main className="flex-1 px-4 md:px-6 py-12 md:py-16">
        <div className="max-w-[560px] mx-auto" style={{ animation: 'fadeUp 0.6s ease both' }}>
          <div className="kicker mb-3">St. Joseph Center of Arkansas</div>
          <h1 className="h-display mb-3" style={{ fontSize: 'clamp(26px, 4.5vw, 36px)' }}>Apply to sell at our markets</h1>
          <p className="text-[15px] leading-relaxed text-text-soft mb-8">
            Tell us about your business and which SJCA farmers markets you&apos;d like to sell at. We&apos;ll text you with next steps.
          </p>

          {done ? (
            <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-6 text-center">
              <div className="text-3xl mb-2">🌾</div>
              <p className="text-[15px] text-text m-0">
                Thanks — St. Joseph Center of Arkansas will review your application and text you.
              </p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-earth-100 shadow-sm p-4 sm:p-6 space-y-4">
              {error && <Notice kind="error">{error}</Notice>}

              {page === 1 && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
                    <Field label="Business name" value={businessName} onChange={setBusinessName} />
                    <Field label="Contact person" value={contactPerson} onChange={setContactPerson} />
                    <Field label="Phone" type="tel" value={phone} onChange={setPhone} placeholder="(501) 555-0100" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-earth-500 mb-2">Which markets?</label>
                    {loadingMarkets ? (
                      <p className="text-sm text-earth-400 m-0">Loading markets…</p>
                    ) : marketsError ? (
                      <Notice kind="error">{marketsError}</Notice>
                    ) : markets.length === 0 ? (
                      <p className="text-sm text-earth-400 m-0">No markets are open for applications right now.</p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {markets.map((m) => (
                          <CheckboxField
                            key={m.id}
                            checked={marketIds.includes(m.id)}
                            onChange={() => toggleMarket(m.id)}
                            label={<span className="font-semibold">{m.location?.name ? `${m.name} — ${m.location.name}` : m.name}</span>}
                            hint={m.next ? `Next: ${formatDateLabel(m.next.date)}, ${formatTime12h(m.next.start_time)}–${formatTime12h(m.next.end_time)}` : undefined}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex justify-end pt-2">
                    <PrimaryButton onClick={goPage2} disabled={!page1Valid}>Continue</PrimaryButton>
                  </div>
                </>
              )}

              {page === 2 && (
                <>
                  <div className="rounded-xl border border-earth-100 bg-earth-50/60 p-4 text-sm text-earth-700">
                    More questions coming — SJCA is finalising the application; you can submit now.
                  </div>
                  <div className="flex justify-between pt-2">
                    <button
                      type="button"
                      onClick={() => setPage(1)}
                      className="px-4 py-2 rounded-xl font-semibold text-sm border border-earth-200 bg-white text-earth-700 cursor-pointer"
                    >
                      Back
                    </button>
                    <PrimaryButton onClick={submit} disabled={submitting}>{submitting ? 'Submitting…' : 'Submit application'}</PrimaryButton>
                  </div>
                </>
              )}
            </div>
          )}

          <a
            href={smsHref('Hi SJCA Markets!')}
            className="mt-6 flex items-center justify-center gap-2 px-4 py-3 rounded-2xl no-underline bg-green-50/70 border border-green-100 text-green-700 text-[13.5px] font-semibold"
          >
            <Icon name="msg" size={15} />
            Prefer to text? {FARMLINK_NUMBER_DISPLAY}
          </a>
        </div>
      </main>
    </div>
  );
}
