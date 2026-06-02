import { GoogleAuth } from 'google-auth-library';
import type { Env } from '../config/env.js';

const LOCATION = 'us-central1';
const MODEL = 'imagen-3.0-generate-002';

let auth: GoogleAuth | null = null;
function getAuth() {
  if (!auth) auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  return auth;
}

function projectId(env: Env): string {
  return env.GCLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'arkansaslocalfoodnetwork';
}

/**
 * Generate a single product photo with Vertex AI Imagen.
 * Returns the raw image bytes + mime type. Requires the Vertex AI API
 * (aiplatform.googleapis.com) to be enabled on the project.
 */
export async function generateProduceImage(
  env: Env,
  productName: string,
): Promise<{ buffer: Buffer; mime: string }> {
  const project = projectId(env);
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${project}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

  const prompt = `A clean, appetizing product photo of fresh ${productName}, on a simple neutral background, natural lighting, farmers-market style, no text or watermarks.`;

  const client = await getAuth().getClient();
  const tokenResp = await client.getAccessToken();
  const accessToken = typeof tokenResp === 'string' ? tokenResp : tokenResp?.token;
  if (!accessToken) throw new Error('Could not obtain Google access token for Vertex AI');

  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: 1, aspectRatio: '1:1' },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Vertex Imagen failed (${resp.status}): ${text.slice(0, 300)}`);
  }

  const data = (await resp.json()) as { predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> };
  const pred = data.predictions?.[0];
  if (!pred?.bytesBase64Encoded) throw new Error('Vertex Imagen returned no image');

  return {
    buffer: Buffer.from(pred.bytesBase64Encoded, 'base64'),
    mime: pred.mimeType || 'image/png',
  };
}
