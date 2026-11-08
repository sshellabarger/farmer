'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { applyApi, firstActiveMarketId } from '@/lib/api-apply';
import {
  applyPrefill,
  buildSubmitInput,
  clearDraft,
  emptyValues,
  loadDraft,
  newDraftId,
  saveDraft,
  sectionReachable,
  SECTION_TITLES,
  validateSection,
  type ApplyValues,
} from '@/lib/apply-draft';
import { describeTotal, formatMoney } from '@/lib/fees';
import type { ApplicationConfig, ApplicationSubmitResult } from '@/lib/phase4-types';
import { formatDateLabel, formatTime12h } from '@/components/admin-shell';
import { Notice, PrimaryButton, SecondaryButton } from '@/components/form';
import { Card, ErrorList, ExternalLink, LoadingCard, PublicShell } from '@/components/apply/kit';
import { ProgressNav } from '@/components/apply/progress-nav';
import { SectionBusiness } from '@/components/apply/section-business';
import { SectionProducts } from '@/components/apply/section-products';
import { SectionBooth } from '@/components/apply/section-booth';
import { SectionAgreements } from '@/components/apply/section-agreements';
import { SectionReview } from '@/components/apply/section-review';

/** Public vendor application (Phase 4 contract section 4.1): five sections, a saved draft, an optional prefill link. */
export default function ApplyPage() {
  return (
    <Suspense
      fallback={
        <PublicShell>
          <LoadingCard />
        </PublicShell>
      }
    >
      <ApplyRoute />
    </Suspense>
  );
}

function ApplyRoute() {
  const params = useSearchParams();
  return <ApplyInner marketParam={params.get('market') || ''} token={params.get('t') || ''} />;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' }
  | { kind: 'done'; result: ApplicationSubmitResult; mobile: string };

function seasonLine(config: ApplicationConfig): string {
  const s = config.season;
  const parts: string[] = [`${s.label} season`];
  if (s.start && s.end) parts.push(`${formatDateLabel(s.start)} to ${formatDateLabel(s.end)}`);
  if (s.market_count > 0) parts.push(`${s.market_count} markets`);
  const days = s.days_of_week.map((d) => d.charAt(0).toUpperCase() + d.slice(1) + 's').join(' and ');
  if (days) parts.push(s.start_time && s.end_time ? `${days}, ${formatTime12h(s.start_time)} to ${formatTime12h(s.end_time)}` : days);
  return parts.join(' | ');
}

function ApplyInner({ marketParam, token }: { marketParam: string; token: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [config, setConfig] = useState<ApplicationConfig | null>(null);
  const [values, setValues] = useState<ApplyValues>(emptyValues);
  const [draftId, setDraftId] = useState('');
  const [section, setSection] = useState(0);
  const [notice, setNotice] = useState('');
  const [welcome, setWelcome] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const topRef = useRef<HTMLDivElement>(null);

  /* Load the prefill (if any), the market config and the saved draft. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPhase({ kind: 'loading' });
      let prefill: Awaited<ReturnType<typeof applyApi.getPrefill>> | null = null;
      let prefillNotice = '';
      if (token) {
        try {
          prefill = await applyApi.getPrefill(token);
        } catch (err) {
          if (err instanceof ApiError && err.status === 410) prefillNotice = 'This link has expired. You can still apply below.';
          else if (err instanceof ApiError && err.status === 404) prefillNotice = 'We do not recognise this link. You can still apply below.';
          else prefillNotice = 'We could not load your saved details. You can still apply below.';
        }
      }
      const market = prefill?.market_id || marketParam || (await firstActiveMarketId());
      if (cancelled) return;
      if (!market) {
        setPhase({ kind: 'error', message: 'No markets are accepting applications right now.' });
        return;
      }
      let cfg: ApplicationConfig;
      try {
        cfg = await applyApi.getConfig(market);
      } catch (err) {
        if (cancelled) return;
        setPhase({
          kind: 'error',
          message:
            err instanceof ApiError && err.status === 404
              ? 'We could not find that market. Check the link and try again.'
              : err instanceof Error
                ? err.message
                : 'Something went wrong loading the application.',
        });
        return;
      }
      if (cancelled) return;

      const draft = loadDraft(cfg.market.id);
      let nextValues: ApplyValues;
      let nextSection = 0;
      if (prefill) {
        if (draft && draft.values.prefill_token === token) {
          nextValues = draft.values;
          nextSection = draft.section;
        } else {
          nextValues = applyPrefill(emptyValues(), prefill, cfg, token);
        }
        setWelcome(prefill.producer.business_name);
      } else if (draft) {
        nextValues = { ...draft.values, prefill_token: null };
        nextSection = draft.section;
      } else {
        nextValues = emptyValues();
      }
      setConfig(cfg);
      setValues(nextValues);
      setSection(nextSection);
      setDraftId(draft?.draft_id ?? newDraftId());
      setNotice(prefillNotice);
      setPhase({ kind: 'ready' });
    })();
    return () => {
      cancelled = true;
    };
  }, [marketParam, token]);

  /* Save the draft shortly after every change. */
  useEffect(() => {
    if (phase.kind !== 'ready' || !config || !draftId) return;
    const t = setTimeout(() => saveDraft(config.market.id, { draft_id: draftId, section, values }), 400);
    return () => clearTimeout(t);
  }, [phase.kind, config, draftId, section, values]);

  /* Bring the error summary into view when it appears. */
  useEffect(() => {
    if (errors.length > 0) document.getElementById('apply-errors')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [errors]);

  const update = useCallback((fn: (v: ApplyValues) => ApplyValues) => setValues((v) => fn(v)), []);

  const scrollTop = () => topRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  const go = (i: number) => {
    setErrors([]);
    setSubmitError('');
    setSection(i);
    scrollTop();
  };

  if (phase.kind === 'loading') {
    return (
      <PublicShell>
        <LoadingCard label="Loading the application..." />
      </PublicShell>
    );
  }

  if (phase.kind === 'error' || !config) {
    return (
      <PublicShell>
        <Card>
          <Notice kind="error">{phase.kind === 'error' ? phase.message : 'Something went wrong loading the application.'}</Notice>
        </Card>
      </PublicShell>
    );
  }

  const rulesHref = config.legal.has_rules_text ? `/rules?market=${encodeURIComponent(config.market.id)}` : config.legal.rules_url;

  if (!config.season.open_now) {
    return (
      <PublicShell>
        <Card>
          <div className="kicker mb-2">St. Joseph Center of Arkansas</div>
          <h1 className="h-display mb-3" style={{ fontSize: 'clamp(24px, 4.5vw, 32px)' }}>
            Applications for {config.market.name} are not open right now.
          </h1>
          <p className="text-[15px] leading-relaxed text-text-soft m-0">
            {config.season.application_open
              ? `Applications open ${formatDateLabel(config.season.application_open)}.`
              : 'Check back soon, or text us and we will let you know when they open.'}
          </p>
          {rulesHref && (
            <p className="text-[15px] mt-3 mb-0">
              In the meantime you can read the <ExternalLink href={rulesHref}>market rules</ExternalLink>.
            </p>
          )}
        </Card>
      </PublicShell>
    );
  }

  if (phase.kind === 'done') {
    const { result, mobile } = phase;
    return (
      <PublicShell>
        <Card>
          <h1 className="h-display mb-3" style={{ fontSize: 'clamp(24px, 4.5vw, 32px)' }}>
            Thank you, your application is in.
          </h1>
          {result.fee.url ? (
            <>
              <p className="text-[15px] leading-relaxed text-text m-0 mb-4">
                Pay the {formatMoney(result.fee.amount, result.fee.currency)} non-refundable application fee here:
              </p>
              <a
                href={result.fee.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center px-5 rounded-xl font-semibold text-white no-underline text-[15px]"
                style={{ background: 'linear-gradient(135deg, #21512C, #3D7A47)', minHeight: 48 }}
              >
                Pay the application fee
              </a>
            </>
          ) : (
            <p className="text-[15px] leading-relaxed text-text m-0">
              The application fee is {formatMoney(result.fee.amount, result.fee.currency)} (non-refundable). SJCA will send you payment instructions.
            </p>
          )}
          <p className="text-[15px] leading-relaxed text-text-soft mt-4 mb-0">
            SJCA will review your application and text you at {mobile}.
          </p>
          <p className="text-sm text-earth-600 mt-3 mb-0">Your booth fee if accepted: {describeTotal(result.season_total)}. It is collected after acceptance.</p>
        </Card>
      </PublicShell>
    );
  }

  const reachable = SECTION_TITLES.map((_, i) => sectionReachable(i, values, config));

  const next = () => {
    const errs = validateSection(section, values, config);
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    go(section + 1);
  };

  const submit = async () => {
    const errs = validateSection(4, values, config);
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    setErrors([]);
    setSubmitError('');
    setSubmitting(true);
    try {
      const result = await applyApi.submit(buildSubmitInput(values, config, draftId));
      clearDraft(config.market.id);
      setPhase({ kind: 'done', result, mobile: values.business.mobile });
      window.scrollTo({ top: 0 });
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        setValues((v) => ({ ...v, prefill_token: null }));
        setSubmitError('This link has expired. You can still apply: please submit again.');
      } else {
        setSubmitError(err instanceof Error ? err.message : 'We could not submit your application. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const last = section === SECTION_TITLES.length - 1;
  const common = { values, update, config };

  return (
    <PublicShell>
      <div ref={topRef} style={{ scrollMarginTop: 12 }}>
        <div className="kicker mb-2">St. Joseph Center of Arkansas</div>
        <h1 className="h-display mb-2" style={{ fontSize: 'clamp(26px, 4.5vw, 36px)' }}>
          Apply to sell at {config.market.name}
        </h1>
        <p className="text-[14px] leading-relaxed text-text-soft m-0">{seasonLine(config)}</p>
        <p className="text-[14px] leading-relaxed text-text-soft mt-1 mb-0">
          Every vendor applies each season, including returning vendors.
          {rulesHref && (
            <>
              {' '}
              <ExternalLink href={rulesHref}>Read the market rules</ExternalLink>.
            </>
          )}
        </p>
      </div>

      {welcome && values.prefill_token && (
        <Notice kind="success">
          Welcome back, {welcome}. We filled in what we have from before. Please check each section and update anything that has changed.
        </Notice>
      )}
      {notice && <Notice kind="warning">{notice}</Notice>}

      <Card>
        <ProgressNav current={section} reachable={reachable} onGo={go} />

        {section === 0 && <SectionBusiness {...common} />}
        {section === 1 && <SectionProducts {...common} draftId={draftId} />}
        {section === 2 && <SectionBooth {...common} />}
        {section === 3 && <SectionAgreements {...common} draftId={draftId} />}
        {section === 4 && <SectionReview values={values} config={config} onEdit={go} />}

        <div className="mt-6 space-y-3">
          <ErrorList errors={errors} />
          {submitError && <Notice kind="error">{submitError}</Notice>}
          <div className="flex items-center justify-between gap-3">
            {section > 0 ? (
              <SecondaryButton onClick={() => go(section - 1)} disabled={submitting}>
                Back
              </SecondaryButton>
            ) : (
              <span />
            )}
            {last ? (
              <PrimaryButton onClick={submit} disabled={submitting}>
                {submitting ? 'Submitting...' : 'Submit application'}
              </PrimaryButton>
            ) : (
              <PrimaryButton onClick={next}>Continue</PrimaryButton>
            )}
          </div>
          <p className="text-xs text-earth-500 text-center m-0">Your answers are saved on this device as you go.</p>
        </div>
      </Card>
    </PublicShell>
  );
}
