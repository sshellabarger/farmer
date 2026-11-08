import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Rules and Regulations - SJCA Markets',
  description: 'The vendor rules and regulations for St. Joseph Center of Arkansas farmers markets.',
};

export default function RulesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
