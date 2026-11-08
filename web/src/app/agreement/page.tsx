'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { applyApi } from '@/lib/api-apply';
import type { AgreementView } from '@/lib/phase4-types';
import { CheckboxField, Notice, PrimaryButton } from '@/components/form';
import { Markdown } from '@/components/markdown';
import { Card, ExternalLink, LoadingCard, PublicShell, TextField } from '@/components/apply/kit';

/** Hold Harmless e-sign page, reached from the acceptance text or email (Phase 4 contract section 4.1). */
export default function AgreementPage() {
  return (
    <Suspense
      fallback={
        <PublicShell width={760}>
          <LoadingCard />
        </PublicShell>
      }
    >
      <AgreementRoute />
    </Suspense>
  );
}

function AgreementRoute() {
  const params = useSearchParams();
  return <AgreementInner token={params.get('t') || ''} />;
}

type State =
  | { kind: 'loading' }
  | { kind: 'unknown' }
  | { kind: 'expired' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; view: AgreementView };

function formatSigned(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
}

function AgreementInner({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState('');

  const load = useCallback(async () => {
    if (!token) {
      setState({ kind: 'unknown' });
      return;
    }
    try {
      const view = await applyApi.getAgreement(token);
      setState(view.status === 'expired' ? { kind: 'expired' } : { kind: 'ok', view });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setState({ kind: 'unknown' });
      else if (err instanceof ApiError && err.status === 410) setState({ kind: 'expired' });
      else setState({ kind: 'error', message: err instanceof Error ? err.message : 'Something went wrong loading this agreement.' });
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const sign = async () => {
    setSigning(true);
    setSignError('');
    try {
      await applyApi.signAgreement(token, { signature_name: name.trim(), agree: true });
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) await load();
      else if (err instanceof ApiError && err.status === 404) setState({ kind: 'unknown' });
      else if (err instanceof ApiError && err.status === 410) setState({ kind: 'expired' });
      else setSignError(err instanceof Error ? err.message : 'We could not save your signature. Please try again.');
    } finally {
      setSigning(false);
    }
  };

  if (state.kind === 'loading') {
    return (
      <PublicShell width={760}>
        <LoadingCard />
      </PublicShell>
    );
  }
  if (state.kind === 'unknown') {
    return (
      <PublicShell width={760}>
        <Card>
          <Notice kind="error">Unknown link. Check the link in your text or email, or text us and we will help.</Notice>
        </Card>
      </PublicShell>
    );
  }
  if (state.kind === 'expired') {
    return (
      <PublicShell width={760}>
        <Card>
          <Notice kind="error">This link has expired. Ask the market manager for a new one.</Notice>
        </Card>
      </PublicShell>
    );
  }
  if (state.kind === 'error') {
    return (
      <PublicShell width={760}>
        <Card>
          <Notice kind="error">{state.message}</Notice>
        </Card>
      </PublicShell>
    );
  }

  const v = state.view;

  if (v.status === 'signed' && v.signed) {
    return (
      <PublicShell width={760}>
        <Card>
          <div className="kicker mb-2">{v.market_name}</div>
          <h1 className="h-display mb-3" style={{ fontSize: 'clamp(24px, 4.5vw, 32px)' }}>
            Hold Harmless agreement signed
          </h1>
          <p className="text-[15px] leading-relaxed text-text m-0">
            Signed by {v.signed.name}
            {formatSigned(v.signed.signed_at) && ` on ${formatSigned(v.signed.signed_at)}`}. You are all set; the market manager has your signature.
          </p>
          {v.insurance_help_url && (
            <p className="text-sm text-text-soft mt-3 mb-0">
              Reminder: proof of liability insurance is required before your first market day.{' '}
              <ExternalLink href={v.insurance_help_url}>Insurance information sheet</ExternalLink>
            </p>
          )}
        </Card>
      </PublicShell>
    );
  }

  const canSign = name.trim().length >= 2 && agree && !signing;

  return (
    <PublicShell width={760}>
      <Card>
        <div className="kicker mb-2">{v.market_name}</div>
        <h1 className="h-display mb-2" style={{ fontSize: 'clamp(26px, 4.5vw, 36px)' }}>
          Hold Harmless agreement
        </h1>
        <p className="text-sm text-text-soft m-0">
          {v.business_name} | {v.season} season
          {v.hold_harmless_version && ` | Version ${v.hold_harmless_version}`}
        </p>
        {v.hold_harmless_markdown.trim() ? (
          <Markdown source={v.hold_harmless_markdown} className="mt-4" />
        ) : (
          <p className="text-sm text-earth-500 mt-4 mb-0">The agreement text is not available yet. Please contact the market manager.</p>
        )}
      </Card>

      <Card>
        <div className="space-y-4">
          <TextField
            id="signature_name"
            label="Type your full legal name"
            value={name}
            onChange={setName}
            autoComplete="name"
            maxLength={120}
            required
            hint="Typing your name is your signature."
          />
          <CheckboxField checked={agree} onChange={setAgree} label="I have read and agree to the Hold Harmless agreement." />
          {signError && <Notice kind="error">{signError}</Notice>}
          <div className="flex justify-end">
            <PrimaryButton onClick={sign} disabled={!canSign}>
              {signing ? 'Signing...' : 'Sign'}
            </PrimaryButton>
          </div>
        </div>
      </Card>
    </PublicShell>
  );
}
