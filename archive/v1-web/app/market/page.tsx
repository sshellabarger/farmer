'use client';

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Dashboard } from '@/components/dashboard';

function MarketContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const tab = searchParams.get('tab') as string | null;

  useEffect(() => {
    if (token) {
      localStorage.setItem('farmlink_token', token);
    }
  }, [token]);

  return <Dashboard viewAs="market" initialTab={tab ?? undefined} />;
}

export default function MarketPage() {
  return (
    <Suspense>
      <MarketContent />
    </Suspense>
  );
}
