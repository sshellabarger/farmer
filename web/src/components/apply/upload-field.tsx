'use client';

import { useRef, useState } from 'react';
import { applyApi } from '@/lib/api-apply';
import type { ApplicationConfig, UploadResult } from '@/lib/phase4-types';

export interface UploadedFile {
  upload_id: string;
  name: string;
}

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
};

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Upload one file to the application's draft (progress bar, client-side size and type checks). */
export function UploadField({
  id,
  label,
  kind,
  draftId,
  limits,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  kind: UploadResult['kind'];
  draftId: string;
  limits: ApplicationConfig['limits'];
  value: UploadedFile | null;
  onChange: (file: UploadedFile | null) => void;
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState('');

  const accept = [...limits.upload_mimes, '.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif'].join(',');

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const mime = file.type || EXT_MIME[ext] || '';
    if (!limits.upload_mimes.includes(mime)) {
      setError('That file type is not accepted. Please upload a PDF, JPG, PNG or HEIC file.');
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    if (file.size > limits.upload_max_bytes) {
      setError(`That file is ${formatBytes(file.size)}. The limit is ${formatBytes(limits.upload_max_bytes)}.`);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    setPct(0);
    try {
      const res = await applyApi.upload(file, draftId, kind, setPct);
      onChange({ upload_id: res.upload_id, name: res.original_name || file.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The upload failed. Please try again.');
    } finally {
      setPct(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const uploading = pct !== null;

  return (
    <div>
      <label htmlFor={id} className="block text-[13px] font-semibold text-earth-700 mb-1">
        {label}
      </label>
      {hint && <p className="text-xs text-earth-500 mt-0 mb-2">{hint}</p>}

      {value && !uploading && (
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border border-green-100 bg-green-50/60 text-sm mb-2">
          <span className="text-green-800 break-all">Uploaded: {value.name}</span>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="bg-transparent border-none cursor-pointer text-earth-600 underline text-sm shrink-0"
          >
            Remove
          </button>
        </div>
      )}

      {uploading && (
        <div className="mb-2" role="status" aria-live="polite">
          <div className="h-2 rounded-full bg-earth-100 overflow-hidden">
            <div className="h-full bg-farm-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-earth-500 mt-1 mb-0">Uploading... {pct}%</p>
        </div>
      )}

      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        disabled={uploading}
        onChange={(e) => choose(e.target.files?.[0])}
        className="block w-full text-sm text-earth-700 file:mr-3 file:px-4 file:py-2.5 file:rounded-xl file:border file:border-earth-200 file:bg-white file:text-earth-700 file:font-semibold file:cursor-pointer"
      />
      <p className="text-xs text-earth-500 mt-1 mb-0">PDF, JPG, PNG or HEIC, up to {formatBytes(limits.upload_max_bytes)}.</p>
      {error && (
        <p className="text-sm mt-1.5 mb-0" style={{ color: '#B91C1C' }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
