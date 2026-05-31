import type { ToolContext } from './index.js';
import { v4 as uuid } from 'uuid';

export async function inventoryAdd(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  if (!userId) throw new Error('User not registered');

  const farmSnap = await db.collection('farms').where('user_id', '==', userId).limit(1).get();
  if (farmSnap.empty) throw new Error('No farm found for this user');
  const farmId = farmSnap.docs[0].id;
  const farm = farmSnap.docs[0].data();

  const productName = input.product as string;
  const quantity = input.quantity as number;
  const unit = input.unit as string;
  const price = input.price as number | undefined;
  const category = (input.category as string) || 'General';
  const harvestDate = input.harvest_date as string | undefined;

  // Find or create product
  const prodSnap = await db.collection('products')
    .where('farm_id', '==', farmId)
    .get();

  let productId: string | undefined;
  let defaultPrice: number | null = null;

  for (const doc of prodSnap.docs) {
    if (doc.data().name.toLowerCase() === productName.toLowerCase()) {
      productId = doc.id;
      defaultPrice = doc.data().default_price;
      break;
    }
  }

  if (!productId) {
    productId = uuid();
    await db.collection('products').doc(productId).set({
      farm_id: farmId,
      name: productName,
      category,
      unit,
      default_price: price ?? null,
      seasonal: false,
      created_at: new Date(),
    });
  }

  const finalPrice = price ?? (defaultPrice ? Number(defaultPrice) : undefined);
  if (!finalPrice) {
    return { needs_price: true, product_name: productName, message: 'What price per ' + unit + '?' };
  }

  const invId = uuid();
  await db.collection('inventory').doc(invId).set({
    farm_id: farmId,
    product_id: productId,
    quantity,
    remaining: quantity,
    price: finalPrice,
    harvest_date: harvestDate ? new Date(harvestDate) : null,
    status: 'available',
    listed_at: new Date(),
  });

  return {
    success: true,
    inventory_id: invId,
    product_name: productName,
    quantity,
    unit,
    price: finalPrice,
    harvest_date: harvestDate || null,
    farm_name: farm.name,
  };
}

export async function inventoryUpdate(input: Record<string, unknown>, ctx: ToolContext) {
  const { db } = ctx;
  const inventoryId = input.inventory_id as string;

  const updates: Record<string, unknown> = {};
  if (input.remaining !== undefined) updates.remaining = input.remaining;
  if (input.price !== undefined) updates.price = input.price;
  if (input.status !== undefined) updates.status = input.status;

  if (Object.keys(updates).length === 0) {
    return { error: 'No fields to update' };
  }

  const ref = db.collection('inventory').doc(inventoryId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Inventory not found');

  await ref.update(updates);
  const updated = await ref.get();
  return { success: true, inventory: { id: updated.id, ...updated.data() } };
}

export async function inventoryClearAll(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  if (!userId) throw new Error('User not registered');

  const farmSnap = await db.collection('farms').where('user_id', '==', userId).limit(1).get();
  if (farmSnap.empty) throw new Error('No farm found for this user');
  const farmId = farmSnap.docs[0].id;

  const activeSnap = await db.collection('inventory')
    .where('farm_id', '==', farmId)
    .where('status', 'in', ['available', 'partial'])
    .get();

  if (activeSnap.empty) {
    return { success: true, cleared: 0, message: 'No active inventory to clear.' };
  }

  const batch = db.batch();
  for (const doc of activeSnap.docs) {
    batch.update(doc.ref, { remaining: 0, status: 'sold' });
  }
  await batch.commit();

  return { success: true, cleared: activeSnap.size, message: `Cleared ${activeSnap.size} inventory item(s).` };
}

export async function inventoryQuery(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;

  let farmId: string | undefined = input.farm_id as string | undefined;

  if (!farmId && userId) {
    const farmSnap = await db.collection('farms').where('user_id', '==', userId).limit(1).get();
    if (!farmSnap.empty) farmId = farmSnap.docs[0].id;
  }

  let query: FirebaseFirestore.Query = db.collection('inventory')
    .where('status', 'in', ['available', 'partial']);

  if (farmId) query = query.where('farm_id', '==', farmId);

  const snapshot = await query.get();

  const results = await Promise.all(
    snapshot.docs.map(async (doc) => {
      const inv = doc.data();
      const prodDoc = await db.collection('products').doc(inv.product_id).get();
      const product = prodDoc.data() || {};
      const farmDoc = await db.collection('farms').doc(inv.farm_id).get();

      if (input.category && !product.category?.toLowerCase().includes((input.category as string).toLowerCase())) return null;
      if (input.search && !product.name?.toLowerCase().includes((input.search as string).toLowerCase())) return null;

      return {
        id: doc.id,
        product_name: product.name || 'Unknown',
        category: product.category || '',
        farm_name: farmDoc.data()?.name || 'Unknown',
        remaining: inv.remaining,
        unit: product.unit || '',
        price: inv.price,
        status: inv.status,
        harvest_date: inv.harvest_date,
      };
    }),
  );

  const filtered = results.filter(Boolean);
  return { count: filtered.length, inventory: filtered };
}
