'use client';

import { SECTION_TITLES } from '@/lib/apply-draft';

/**
 * The five-step progress indicator. A step is a button when the applicant may
 * open it (every earlier section validates); the current step is marked with
 * aria-current. On a phone only the current step's title is spelled out.
 */
export function ProgressNav({
  current,
  reachable,
  onGo,
}: {
  current: number;
  reachable: boolean[];
  onGo: (index: number) => void;
}) {
  return (
    <nav aria-label="Application progress" className="mb-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-earth-500 m-0 mb-2 sm:hidden">
        Step {current + 1} of {SECTION_TITLES.length}: {SECTION_TITLES[current]}
      </p>
      <ol className="list-none m-0 p-0 flex gap-1.5">
        {SECTION_TITLES.map((title, i) => {
          const isCurrent = i === current;
          const done = i < current;
          const canGo = reachable[i] === true && !isCurrent;
          return (
            <li key={title} className="flex-1 min-w-0">
              <button
                type="button"
                onClick={() => canGo && onGo(i)}
                disabled={!canGo && !isCurrent}
                aria-current={isCurrent ? 'step' : undefined}
                className={`w-full text-left rounded-xl border px-2 py-2 transition-colors ${
                  isCurrent
                    ? 'border-farm-500 bg-green-50'
                    : done
                      ? 'border-green-100 bg-white cursor-pointer'
                      : 'border-earth-100 bg-white'
                } ${canGo || isCurrent ? '' : 'opacity-60 cursor-not-allowed'}`}
                style={{ minHeight: 44 }}
              >
                <span className={`block text-[11px] font-bold ${isCurrent || done ? 'text-green-700' : 'text-earth-400'}`}>{i + 1}</span>
                <span className="hidden sm:block text-[12px] leading-tight font-semibold text-earth-800">{title}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
