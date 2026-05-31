import type { ToolContext } from './index.js';
import { v4 as uuid } from 'uuid';

export async function userSignup(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
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

  const existingSnap = await db.collection('users').where('phone', '==', phone).limit(1).get();
  if (!existingSnap.empty) {
    const existing = existingSnap.docs[0];
    return { error: 'already_registered', user_id: existing.id, name: existing.data().name, message: `This phone is already registered to ${existing.data().name}.` };
  }

  const userId = uuid();
  await db.collection('users').doc(userId).set({
    name, phone, role, email: null, created_at: new Date(), updated_at: new Date(),
  });

  const result: Record<string, unknown> = { success: true, user: { id: userId, name, role } };

  if (role === 'farmer' || role === 'both') {
    const farmId = uuid();
    await db.collection('farms').doc(farmId).set({
      user_id: userId, name: farmName, location, specialty,
      active: true, timezone: 'America/Chicago', delivery_schedule: [], contacts: [],
      created_at: new Date(), updated_at: new Date(),
    });
    result.farm = { id: farmId, name: farmName };
  }

  if (role === 'market' || role === 'both') {
    const marketId = uuid();
    await db.collection('markets').doc(marketId).set({
      user_id: userId, name: marketName, location, type: marketType, delivery_pref: 'either',
      active: true, contacts: [], created_at: new Date(), updated_at: new Date(),
    });
    result.market = { id: marketId, name: marketName };
  }

  // Take ownership of existing conversation
  const convoSnap = await db.collection('conversations').where('phone_number', '==', phone).limit(1).get();
  if (!convoSnap.empty) {
    await convoSnap.docs[0].ref.update({ user_id: userId });
  } else {
    await db.collection('conversations').doc(uuid()).set({
      user_id: userId, phone_number: phone, context: 'general',
      last_message_at: new Date(), created_at: new Date(),
    });
  }

  result.message = `Welcome to FarmLink, ${name}! Account created as ${role}.`;
  return result;
}
