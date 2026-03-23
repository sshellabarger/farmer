import type { ToolContext } from './index.js';

export async function inventoryAdd(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;
  if (!userId) throw new Error('User not registered');

  const farm = await db.selectFrom('farms').selectAll().where('user_id', '=', userId).executeTakeFirst();
  if (!farm) throw new Error('No farm found for this user');

  const productName = input.product as string;
  const quantity = input.quantity as number;
  const unit = input.unit as string;
  const price = input.price as number | undefined;
  const category = (input.category as string) || 'General';
  const harvestDate = input.harvest_date as string | undefined;

  // Find or create product
  let product = await db
    .selectFrom('products')
    .selectAll()
    .where('farm_id', '=', farm.id)
    .where('name', 'ilike', productName)
    .executeTakeFirst();

  if (!product) {
    const [newProduct] = await db
      .insertInto('products')
      .values({
        farm_id: farm.id,
        name: productName,
        category,
        unit,
        default_price: price ?? null,
        seasonal: false,
      })
      .returningAll()
      .execute();
    product = newProduct;
  }

  const finalPrice = price ?? (product.default_price ? Number(product.default_price) : undefined);
  if (!finalPrice) {
    return { needs_price: true, product_name: productName, message: 'What price per ' + unit + '?' };
  }

  const [inventory] = await db
    .insertInto('inventory')
    .values({
      farm_id: farm.id,
      product_id: product.id,
      quantity,
      remaining: quantity,
      price: finalPrice,
      harvest_date: harvestDate ? new Date(harvestDate) : null,
      status: 'available',
    })
    .returningAll()
    .execute();

  return {
    success: true,
    inventory_id: inventory.id,
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

  const [updated] = await db
    .updateTable('inventory')
    .set(updates)
    .where('id', '=', inventoryId)
    .returningAll()
    .execute();

  if (!updated) throw new Error('Inventory not found');

  return { success: true, inventory: updated };
}

export async function inventoryQuery(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, userId } = ctx;

  let query = db
    .selectFrom('inventory')
    .innerJoin('products', 'products.id', 'inventory.product_id')
    .innerJoin('farms', 'farms.id', 'inventory.farm_id')
    .select([
      'inventory.id',
      'products.name as product_name',
      'products.category',
      'farms.name as farm_name',
      'inventory.remaining',
      'products.unit',
      'inventory.price',
      'inventory.status',
      'inventory.harvest_date',
    ]);

  if (input.farm_id) {
    query = query.where('inventory.farm_id', '=', input.farm_id as string);
  } else if (userId) {
    // Default to user's farm
    const farm = await db.selectFrom('farms').select('id').where('user_id', '=', userId).executeTakeFirst();
    if (farm) query = query.where('inventory.farm_id', '=', farm.id);
  }

  if (input.category) {
    query = query.where('products.category', 'ilike', `%${input.category}%`);
  }
  if (input.status) {
    query = query.where('inventory.status', '=', input.status as any);
  }
  if (input.search) {
    query = query.where('products.name', 'ilike', `%${input.search}%`);
  }

  const results = await query.where('inventory.status', 'in', ['available', 'partial']).execute();

  return { count: results.length, inventory: results };
}
