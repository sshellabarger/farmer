'use client';

import { useEffect, useState } from 'react';
import type { CheckinFormValues, CheckinSubmitInput, ExtraQuestion } from '@/lib/types';

/**
 * The producer-facing weekly check-in form (contract §6.1). Renders the
 * fixed question set in the contract's order, then one control per
 * `extra_questions` entry. No login, no market/date fetching of its own —
 * the parent page supplies everything and owns the submit round-trip.
 *
 * `marketName` is not in the contract's prop list verbatim but is needed to
 * render "Are you attending next {market_name}?" — the smallest sensible
 * addition (see docs/phase3/notes-C.md, deviations).
 */
export function CheckinForm({
  marketName,
  questions,
  initial,
  submitting,
  onSubmit,
}: {
  marketName: string;
  questions: ExtraQuestion[];
  initial: CheckinFormValues | null;
  submitting: boolean;
  onSubmit: (values: CheckinSubmitInput) => void;
}) {
  const [attendingNext, setAttendingNext] = useState<boolean | null>(initial?.attending_next ?? null);
  const [bringingNext, setBringingNext] = useState(initial?.bringing_next ?? '');
  const [soldOut, setSoldOut] = useState(initial?.sold_out ?? '');
  const [unsold, setUnsold] = useState(initial?.unsold ?? '');
  const [estimatedSales, setEstimatedSales] = useState(initial?.estimated_sales ?? '');
  const [transactionsEstimate, setTransactionsEstimate] = useState(initial?.transactions_estimate ?? '');
  const [feedback, setFeedback] = useState(initial?.feedback ?? '');
  const [extraAnswers, setExtraAnswers] = useState<Record<string, string | boolean>>(initial?.extra_answers ?? {});

  useEffect(() => {
    setAttendingNext(initial?.attending_next ?? null);
    setBringingNext(initial?.bringing_next ?? '');
    setSoldOut(initial?.sold_out ?? '');
    setUnsold(initial?.unsold ?? '');
    setEstimatedSales(initial?.estimated_sales ?? '');
    setTransactionsEstimate(initial?.transactions_estimate ?? '');
    setFeedback(initial?.feedback ?? '');
    setExtraAnswers(initial?.extra_answers ?? {});
  }, [initial]);

  const setExtra = (key: string, value: string | boolean) => setExtraAnswers((prev) => ({ ...prev, [key]: value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (attendingNext === null || submitting) return;
    onSubmit({
      attending_next: attendingNext,
      bringing_next: bringingNext,
      sold_out: soldOut,
      unsold,
      estimated_sales: estimatedSales,
      transactions_estimate: transactionsEstimate,
      feedback,
      extra_answers: extraAnswers,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <YesNoQuestion
        label={`Are you attending next ${marketName}?`}
        name="attending_next"
        value={attendingNext}
        onChange={setAttendingNext}
        required
      />

      <TextQuestion label="What are you bringing next time?" value={bringingNext} onChange={setBringingNext} />
      <TextQuestion label="What sold out?" value={soldOut} onChange={setSoldOut} />
      <TextQuestion label="What did not sell?" value={unsold} onChange={setUnsold} />

      <div>
        <label className="block text-sm font-semibold text-earth-800 mb-1.5">Estimated total sales</label>
        <input
          type="text"
          inputMode="decimal"
          value={estimatedSales}
          onChange={(e) => setEstimatedSales(e.target.value)}
          placeholder="$"
          className="w-full px-3 py-2.5 border border-earth-200 rounded-xl text-[15px] focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100"
        />
        <p className="text-xs text-earth-500 mt-1 mb-0">SJCA staff only, reported in aggregate</p>
      </div>

      <div>
        <label className="block text-sm font-semibold text-earth-800 mb-1.5">About how many transactions?</label>
        <input
          type="text"
          inputMode="numeric"
          value={transactionsEstimate}
          onChange={(e) => setTransactionsEstimate(e.target.value)}
          className="w-full px-3 py-2.5 border border-earth-200 rounded-xl text-[15px] focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100"
        />
      </div>

      <TextQuestion label="Anything else SJCA should know?" value={feedback} onChange={setFeedback} />

      {questions.map((q) => (
        <ExtraQuestionField key={q.key} question={q} value={extraAnswers[q.key]} onChange={(v) => setExtra(q.key, v)} />
      ))}

      <button
        type="submit"
        disabled={attendingNext === null || submitting}
        className="w-full px-5 py-3 rounded-xl font-semibold text-[15px] text-white border-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        style={{ background: 'linear-gradient(135deg, #21512C, #3D7A47)' }}
      >
        {submitting ? 'Saving…' : 'Save check-in'}
      </button>
    </form>
  );
}

function TextQuestion({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-sm font-semibold text-earth-800 mb-1.5">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        className="w-full px-3 py-2.5 border border-earth-200 rounded-xl text-[15px] focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100 resize-none"
      />
    </div>
  );
}

function YesNoQuestion({
  label,
  name,
  value,
  onChange,
  required,
}: {
  label: string;
  name: string;
  value: boolean | null;
  onChange: (v: boolean) => void;
  required?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-semibold text-earth-800 mb-2">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      <div className="grid grid-cols-2 gap-3">
        <YesNoButton label="Yes" active={value === true} onClick={() => onChange(true)} name={name} />
        <YesNoButton label="No" active={value === false} onClick={() => onChange(false)} name={name} />
      </div>
    </div>
  );
}

function YesNoButton({ label, active, onClick, name }: { label: string; active: boolean; onClick: () => void; name: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={`${name}: ${label}`}
      onClick={onClick}
      className="px-4 py-3.5 rounded-xl text-base font-semibold border cursor-pointer transition-colors"
      style={
        active
          ? { borderColor: '#21512C', color: '#fff', background: 'linear-gradient(135deg, #21512C, #3D7A47)' }
          : { borderColor: '#E4DFD3', color: '#3d3428', background: '#fff' }
      }
    >
      {label}
    </button>
  );
}

function ExtraQuestionField({
  question,
  value,
  onChange,
}: {
  question: ExtraQuestion;
  value: string | boolean | undefined;
  onChange: (v: string | boolean) => void;
}) {
  if (question.type === 'yes_no') {
    return (
      <YesNoQuestion
        label={question.prompt}
        name={question.key}
        value={typeof value === 'boolean' ? value : null}
        onChange={onChange}
      />
    );
  }
  if (question.type === 'choice') {
    return (
      <div>
        <label className="block text-sm font-semibold text-earth-800 mb-2">{question.prompt}</label>
        <div className="flex flex-col gap-2">
          {(question.options || []).map((opt) => (
            <label key={opt} className="flex items-center gap-2 text-sm text-earth-800 cursor-pointer">
              <input
                type="radio"
                name={question.key}
                checked={value === opt}
                onChange={() => onChange(opt)}
                className="accent-[#21512C]"
              />
              {opt}
            </label>
          ))}
        </div>
      </div>
    );
  }
  return (
    <TextQuestion
      label={question.prompt}
      value={typeof value === 'string' ? value : ''}
      onChange={onChange}
    />
  );
}
