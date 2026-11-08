import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Hold Harmless agreement - SJCA Markets',
  robots: { index: false, follow: false },
  // The link carries a private token in its query string: never pass it on as a referrer.
  referrer: 'no-referrer',
};

export default function AgreementLayout({ children }: { children: React.ReactNode }) {
  return children;
}
