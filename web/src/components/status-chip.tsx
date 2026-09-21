'use client';

/**
 * Coloured pill for membership, application and market-date statuses
 * (contract §8.1). Unknown statuses fall back to neutral grey.
 */
const COLORS: Record<string, { bg: string; text: string }> = {
  // membership
  applied: { bg: '#FEF3C7', text: '#92400E' },
  under_review: { bg: '#DBEAFE', text: '#1E40AF' },
  approved: { bg: '#E0E7FF', text: '#3730A3' },
  active: { bg: '#D1FAE5', text: '#065F46' },
  inactive: { bg: '#F3F4F6', text: '#6B7280' },
  // application
  new: { bg: '#FEF3C7', text: '#92400E' },
  declined: { bg: '#FEE2E2', text: '#991B1B' },
  // market date
  collecting: { bg: '#EBF4E6', text: '#2A5E33' },
  lineup_final: { bg: '#E0E7FF', text: '#3730A3' },
  published: { bg: '#D1FAE5', text: '#065F46' },
  cancelled: { bg: '#FEE2E2', text: '#991B1B' },
  // sms outcomes / misc
  sent: { bg: '#D1FAE5', text: '#065F46' },
  simulated: { bg: '#DBEAFE', text: '#1E40AF' },
  failed: { bg: '#FEE2E2', text: '#991B1B' },
  admin: { bg: '#FCE7F3', text: '#9D174D' },
  market_manager: { bg: '#DBEAFE', text: '#1E40AF' },
};

export function StatusChip({ status, title }: { status: string; title?: string }) {
  const c = COLORS[status] || { bg: '#F3F4F6', text: '#6B7280' };
  return (
    <span
      className="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: c.bg, color: c.text }}
      title={title}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}
