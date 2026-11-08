'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { applyApi, firstActiveMarketId } from '@/lib/api-apply';
import type { RulesView } from '@/lib/phase4-types';
import { Notice } from '@/components/form';
import { Markdown } from '@/components/markdown';
import { Card, ExternalLink, LoadingCard, PublicShell } from '@/components/apply/kit';

/** The market's published Rules and Regulations (Phase 4 contract section 4.1). */
export default function RulesPage() {
  return (
    <Suspense
      fallback={
        <PublicShell width={760}>
          <LoadingCard />
        </PublicShell>
      }
    >
      <RulesRoute />
    </Suspense>
  );
}

function RulesRoute() {
  const params = useSearchParams();
  return <RulesInner marketParam={params.get('market') || ''} />;
}

type State = { kind: 'loading' } | { kind: 'missing' } | { kind: 'error'; message: string } | { kind: 'ok'; view: RulesView };

function RulesInner({ marketParam }: { marketParam: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ kind: 'loading' });
      const market = marketParam || (await firstActiveMarketId());
      if (cancelled) return;
      if (!market) {
        setState({ kind: 'missing' });
        return;
      }
      try {
        const view = await applyApi.getRules(market);
        if (!cancelled) setState({ kind: 'ok', view });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setState({ kind: 'missing' });
        else setState({ kind: 'error', message: err instanceof Error ? err.message : 'Something went wrong loading the rules.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [marketParam]);

  if (state.kind === 'loading') {
    return (
      <PublicShell width={760}>
        <LoadingCard label="Loading the rules..." />
      </PublicShell>
    );
  }

  if (state.kind === 'missing') {
    return (
      <PublicShell width={760}>
        <Card>
          <Notice kind="info">The rules for this market are not published yet.</Notice>
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
  const updated = v.updated_at ? new Date(v.updated_at) : null;
  const updatedLabel = updated && !Number.isNaN(updated.getTime()) ? updated.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const hasText = v.rules_markdown.trim() !== '';

  return (
    <PublicShell width={760}>
      <Card>
        <div className="kicker mb-2">{v.market_name}</div>
        <h1 className="h-display mb-2" style={{ fontSize: 'clamp(26px, 4.5vw, 36px)' }}>
          Rules and Regulations
        </h1>
        <p className="text-sm text-text-soft m-0">
          {v.season} season
          {v.rules_version && ` | Version ${v.rules_version}`}
          {updatedLabel && ` | Updated ${updatedLabel}`}
        </p>
        {v.rules_url && (
          <p className="text-sm mt-2 mb-0">
            <ExternalLink href={v.rules_url}>{hasText ? 'Open the original document' : 'Read the rules document'}</ExternalLink>
          </p>
        )}
        {hasText && <Markdown source={v.rules_markdown} className="mt-4" />}
        {!hasText && !v.rules_url && <p className="text-sm text-earth-500 mt-4 mb-0">The rules for this market are not published yet.</p>}
      </Card>
    </PublicShell>
  );
}
