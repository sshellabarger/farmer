import Link from 'next/link';
import { TransitionNotice } from '@/components/transition-notice';
import { Icon } from '@/components/icons';

export default function LandingPage() {
  return (
    <TransitionNotice>
      <div className="mt-6">
        <Link
          href="/apply"
          className="inline-flex items-center gap-2 text-[15px] font-semibold text-green-700 no-underline hover:underline"
        >
          Apply to sell at our markets <Icon name="arrow" size={15} />
        </Link>
      </div>
    </TransitionNotice>
  );
}
