'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function UploadPhotoContent() {
  const params = useSearchParams();
  const token = params.get('token') || '';
  const [productName, setProductName] = useState<string>('your produce');
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'uploading' | 'done'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) { setState('invalid'); return; }
    fetch(`/api/uploads/produce/${token}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { setProductName(d.product_name || 'your produce'); setState('ready'); })
      .catch(() => setState('invalid'));
  }, [token]);

  async function handleFile(file: File) {
    setState('uploading');
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/uploads/produce/${token}`, { method: 'POST', body: fd });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `Upload failed (${res.status})`);
      }
      setState('done');
    } catch (e: any) {
      setError(e.message || 'Upload failed');
      setState('ready');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: '#faf8f5' }}>
      <div className="w-full max-w-[420px] bg-white rounded-2xl border p-6 shadow-sm" style={{ borderColor: '#e8e0d6' }}>
        <div className="text-center mb-5">
          <div className="text-3xl mb-2">🌱</div>
          <h1 className="font-display text-xl font-extrabold" style={{ color: '#1a3409' }}>Add a produce photo</h1>
        </div>

        {state === 'loading' && <p className="text-center text-sm" style={{ color: '#8a7e72' }}>Loading…</p>}

        {state === 'invalid' && (
          <p className="text-center text-sm px-4 py-3 rounded-xl" style={{ background: '#fef2f2', color: '#dc2626' }}>
            This upload link is invalid or has expired. Text us again to get a fresh link.
          </p>
        )}

        {(state === 'ready' || state === 'uploading') && (
          <>
            <p className="text-sm text-center mb-4" style={{ color: '#3d3428' }}>
              Upload a photo for <strong>{productName}</strong>.
            </p>
            {error && (
              <div className="mb-3 px-3 py-2 rounded-lg text-xs text-center" style={{ background: '#fef2f2', color: '#dc2626' }}>{error}</div>
            )}
            <label
              className="block w-full text-center py-3 rounded-xl text-sm font-semibold text-white cursor-pointer"
              style={{ background: state === 'uploading' ? '#9ca3af' : 'linear-gradient(135deg, #2d5016, #4a7c28)' }}
            >
              {state === 'uploading' ? 'Uploading…' : 'Choose a photo'}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                disabled={state === 'uploading'}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
              />
            </label>
            <p className="text-[11px] text-center mt-3" style={{ color: '#8a7e72' }}>
              Tip: take a photo or pick one from your library.
            </p>
          </>
        )}

        {state === 'done' && (
          <div className="text-center">
            <div className="text-4xl mb-2">✅</div>
            <p className="text-sm font-semibold" style={{ color: '#2d5016' }}>Photo added to {productName}!</p>
            <p className="text-xs mt-2" style={{ color: '#8a7e72' }}>You can close this page.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function UploadPhotoPage() {
  return (
    <Suspense>
      <UploadPhotoContent />
    </Suspense>
  );
}
