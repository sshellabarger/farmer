import type { Firestore } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';
import type { Env } from '../config/env.js';
import { uploadImageBuffer } from './storage.js';
import { generateProduceImage } from './imagen.js';

type PhotoMode = 'existing' | 'generate' | 'upload';

/**
 * Handle a produce photo for an inventory item via one of three modes:
 *  - existing: reuse the product's saved default photo
 *  - generate: create one with Vertex AI Imagen
 *  - upload:   return a tokenized web link the farmer can use to upload one
 */
export async function setProducePhoto(
  db: Firestore,
  env: Env,
  inventoryId: string,
  mode: PhotoMode,
): Promise<{ success: boolean; url?: string; message: string; error?: string }> {
  const invRef = db.collection('inventory').doc(inventoryId);
  const invDoc = await invRef.get();
  if (!invDoc.exists) return { success: false, error: 'not_found', message: 'That inventory item was not found.' };
  const inv = invDoc.data()!;

  const prodRef = inv.product_id ? db.collection('products').doc(inv.product_id) : null;
  const prodDoc = prodRef ? await prodRef.get() : null;
  const productName = prodDoc?.data()?.name || 'produce';

  if (mode === 'existing') {
    const existing = prodDoc?.data()?.image_url;
    if (!existing) {
      return { success: false, error: 'no_existing', message: `No photo on file yet for ${productName}.` };
    }
    await invRef.update({ image_url: existing });
    return { success: true, url: existing, message: `Reused your saved photo for ${productName}. ✅` };
  }

  if (mode === 'generate') {
    const { buffer, mime } = await generateProduceImage(env, productName);
    const { url } = await uploadImageBuffer(env, buffer, mime);
    await invRef.update({ image_url: url });
    if (prodRef) await prodRef.update({ image_url: url }).catch(() => {});
    return { success: true, url, message: `Generated a photo for ${productName}. ✅` };
  }

  // mode === 'upload' — create a short-lived token + web link
  const token = uuid().replace(/-/g, '').slice(0, 12);
  await db.collection('upload_links').doc(token).set({
    inventory_id: inventoryId,
    product_name: productName,
    expires_at: new Date(Date.now() + 24 * 3600 * 1000),
    created_at: new Date(),
  });
  const url = `${env.APP_URL}/upload-photo?token=${token}`;
  return { success: true, url, message: `Here's a link to add a photo for ${productName}: ${url}` };
}
