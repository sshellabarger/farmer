import { request, qs, ApiError } from './api';
import type {
  AgreementSignInput,
  AgreementView,
  ApplicationConfig,
  ApplicationSubmitInput,
  ApplicationSubmitResult,
  PrefillView,
  RulesView,
  UploadResult,
} from './phase4-types';
import type { PublicMarket } from './types';

const UPLOAD_ERRORS: Record<number, string> = {
  400: 'The upload was missing something. Please try again.',
  404: 'We could not find that market. Reload the page and try again.',
  409: 'Applications are closed for this market, so files cannot be uploaded right now.',
  413: 'That file is too large. Please choose a smaller file.',
  415: 'That file type is not accepted. Please upload a PDF, JPG, PNG or HEIC file.',
  429: 'Too many uploads. Please wait a bit and try again.',
  503: 'We cannot accept more uploads today. Please try again tomorrow, or contact the market manager.',
};

/** Public application, rules and agreement calls (Phase 4 contract section 4.1). No JWT is involved. */
export const applyApi = {
  getConfig: (market: string) => request<ApplicationConfig>(`/applications/config${qs({ market })}`),

  /**
   * Multipart upload with progress events. `market`, `draft_id` and `kind` go before the file so the server sees them first.
   * The server only takes a file for a market whose application window is open.
   */
  upload: (
    file: File,
    market: string,
    draft_id: string,
    kind: UploadResult['kind'],
    onProgress?: (pct: number) => void,
  ): Promise<UploadResult> =>
    new Promise<UploadResult>((resolve, reject) => {
      const form = new FormData();
      form.append('market', market);
      form.append('draft_id', draft_id);
      form.append('kind', kind);
      form.append('file', file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/applications/uploads');
      xhr.responseType = 'text';
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable && e.total > 0) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      };
      xhr.onerror = () => reject(new ApiError('The upload could not be sent. Check your connection and try again.', 0));
      xhr.onabort = () => reject(new ApiError('The upload was cancelled.', 0));
      xhr.onload = () => {
        let body: Record<string, unknown> = {};
        try {
          body = xhr.responseText ? (JSON.parse(xhr.responseText) as Record<string, unknown>) : {};
        } catch {
          body = {};
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress?.(100);
          resolve(body as unknown as UploadResult);
          return;
        }
        const message =
          (typeof body.error === 'string' && body.error) ||
          (typeof body.message === 'string' && body.message) ||
          UPLOAD_ERRORS[xhr.status] ||
          `Upload failed (${xhr.status})`;
        reject(new ApiError(message, xhr.status));
      };
      xhr.send(form);
    }),

  submit: (data: ApplicationSubmitInput) =>
    request<ApplicationSubmitResult>('/applications', { method: 'POST', body: JSON.stringify(data) }),

  getPrefill: (t: string) => request<PrefillView>(`/applications/prefill/${encodeURIComponent(t)}`),

  getRules: (market: string) => request<RulesView>(`/markets/${encodeURIComponent(market)}/rules`),

  getAgreement: (t: string) => request<AgreementView>(`/agreements/${encodeURIComponent(t)}`),

  signAgreement: (t: string, data: AgreementSignInput) =>
    request<{ ok: true; signed: { name: string; signed_at: string }; membership_status: string }>(
      `/agreements/${encodeURIComponent(t)}`,
      { method: 'POST', body: JSON.stringify(data) },
    ),
};

/**
 * The market a public page should use when the URL names none: the first
 * active market the API lists. Null when there is none (or the call fails), so
 * the page can say so instead of guessing an id.
 */
export async function firstActiveMarketId(): Promise<string | null> {
  try {
    const { markets } = await request<{ markets: PublicMarket[] }>('/markets/public');
    return (markets || []).find((m) => m.active)?.id ?? null;
  } catch {
    return null;
  }
}
