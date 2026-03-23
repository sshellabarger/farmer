import type { ToolContext } from './index.js';

export async function userSignup(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const { db, phone } = ctx;

  const name = input.name as string;
  const role = input.role as 'farmer' | 'market' | 'both';
  const location = input.location as string;
  const farmName = (input.farm_name as string) || `${name}'s Farm`;
  const marketName = (input.market_name as string) || `${name}'s Market`;
  const marketType = (input.market_type as string) || 'grocery';
  const specialty = (input.specialty as string) || null;

  if (!name || !role || !location) {
    return { error: 'missing_fields', message: 'Need name, role, and location to sign up.' };
  }

  // Check if phone is already registered
  const existing = await db
    .selectFrom('users')
    .select(['id', 'name'])
    .where('phone', '=', phone)
    .executeTakeFirst();

  if (existing) {
    return {
      error: 'already_registered',
      user_id: existing.id,
      name: existing.name,
      message: `This phone is already registered to ${existing.name}.`,
    };
  }

  // Create user
  const [user] = await db
    .insertInto('users')
    .values({
      name,
      phone,
      role: role as any,
      email: null,
    })
    .returningAll()
    .execute();

  const result: Record<string, unknown> = {
    success: true,
    user: { id: user.id, name: user.name, role: user.role },
  };

  // Create farm if farmer or both
  if (role === 'farmer' || role === 'both') {
    const [farm] = await db
      .insertInto('farms')
      .values({
        user_id: user.id,
        name: farmName,
        location,
        specialty,
      })
      .returningAll()
      .execute();
    result.farm = { id: farm.id, name: farm.name };
  }

  // Create market if market or both
  if (role === 'market' || role === 'both') {
    const [market] = await db
      .insertInto('markets')
      .values({
        user_id: user.id,
        name: marketName,
        location,
        type: marketType as any,
        delivery_pref: 'either' as any,
      })
      .returningAll()
      .execute();
    result.market = { id: market.id, name: market.name };
  }

  // Take ownership of existing anonymous conversation, or create a new one
  const existingConv = await db
    .selectFrom('conversations')
    .select('id')
    .where('phone_number', '=', phone)
    .executeTakeFirst();

  if (existingConv) {
    await db
      .updateTable('conversations')
      .set({ user_id: user.id })
      .where('id', '=', existingConv.id)
      .execute();
  } else {
    await db
      .insertInto('conversations')
      .values({
        user_id: user.id,
        phone_number: phone,
        context: 'general' as any,
      })
      .execute();
  }

  result.message = `Welcome to FarmLink, ${name}! Account created as ${role}.`;
  return result;
}
