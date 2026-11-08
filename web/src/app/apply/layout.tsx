import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Vendor application - SJCA Markets',
  description: 'Apply to sell at a St. Joseph Center of Arkansas farmers market.',
  // A prefill link carries a private token in its query string: never pass it on as a referrer.
  referrer: 'no-referrer',
};

export default function ApplyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
