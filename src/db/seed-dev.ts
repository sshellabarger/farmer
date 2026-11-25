/**
 * Development seed. Writes ONLY to the local Firestore emulator: `getDb()`
 * refuses to open anything else outside production. Replaces the v1 seed,
 * which wrote demo data into the production project.
 *
 * Creates the two test farms and links each to its Square SANDBOX vendor
 * (looked up by name, created if missing). Phone numbers are fictional (555-01xx).
 * Safe to re-run: ids are fixed, so it overwrites the same documents.
 */
import { getEnv } from '../config/env.js';
import { getDb } from './firestore.js';
import { idempotencyKey, squareEnabled, squareRequest } from '../services/square.js';

const FARMS = [
  { id: 'farm-panama', userId: 'user-panama', farm: 'Panama Farms', farmer: 'Test Farmer One', phone: '+15015550101', location: 'Little Rock, AR' },
  { id: 'farm-hellabarger', userId: 'user-hellabarger', farm: 'Hellabarger Homestead', farmer: 'Test Farmer Two', phone: '+15015550102', location: 'North Little Rock, AR' },
];
const BUYER = { id: 'buyer-test', userId: 'user-buyer', name: 'Test Kitchen', person: 'Test Buyer', phone: '+15015550103' };

async function vendorIdFor(name: string): Promise<string | null> {
  const env = getEnv();
  if (!squareEnabled(env)) return null;
  if (env.SQUARE_ENVIRONMENT !== 'sandbox') throw new Error('The dev seed only links Square SANDBOX vendors.');
  const found = await squareRequest<{ vendors?: Array<{ id: string }> }>(env, 'POST', '/v2/vendors/search', { filter: { name: [name] } });
  if (found.vendors?.[0]) return found.vendors[0].id;
  const created = await squareRequest<{ vendor: { id: string } }>(env, 'POST', '/v2/vendors/create', {
    idempotency_key: idempotencyKey('test-vendor', name),
    vendor: { name, note: 'FarmLink test farm' },
  });
  return created.vendor.id;
}

async function customerIdFor(buyerId: string, name: string, phone: string): Promise<string | null> {
  const env = getEnv();
  if (!squareEnabled(env)) return null;
  if (env.SQUARE_ENVIRONMENT !== 'sandbox') throw new Error('The dev seed only links Square SANDBOX customers.');
  const found = await squareRequest<{ customers?: Array<{ id: string }> }>(env, 'POST', '/v2/customers/search', {
    query: { filter: { reference_id: { exact: buyerId } } },
  });
  if (found.customers?.[0]) return found.customers[0].id;
  const created = await squareRequest<{ customer: { id: string } }>(env, 'POST', '/v2/customers', {
    idempotency_key: idempotencyKey('test-customer', buyerId),
    company_name: name, phone_number: phone, reference_id: buyerId, note: 'FarmLink test buyer',
  });
  return created.customer.id;
}

/** Fail fast with a clear message instead of retrying forever when the emulator is down. */
async function assertEmulatorUp(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) return; // getDb() reports this case
  try {
    await fetch(`http://${host}/`, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new Error(`The Firestore emulator is not running at ${host}. Start it with \`npm run emulators\` in another terminal.`);
  }
}

async function seed() {
  await assertEmulatorUp();
  const db = getDb();
  const now = new Date();

  for (const f of FARMS) {
    const vendorId = await vendorIdFor(f.farm);
    await db.collection('users').doc(f.userId).set({ name: f.farmer, phone: f.phone, email: null, role: 'farmer', created_at: now, updated_at: now });
    await db.collection('farms').doc(f.id).set({
      user_id: f.userId, name: f.farm, phone: f.phone, location: f.location, active: true,
      square_vendor_id: vendorId, created_at: now, updated_at: now,
    });
    console.log(`farm ${f.farm} → Square vendor ${vendorId ?? '(Square not configured)'}`);
  }

  const customerId = await customerIdFor(BUYER.id, BUYER.name, BUYER.phone);
  await db.collection('users').doc(BUYER.userId).set({ name: BUYER.person, phone: BUYER.phone, email: null, role: 'market', created_at: now, updated_at: now });
  await db.collection('markets').doc(BUYER.id).set({
    user_id: BUYER.userId, name: BUYER.name, type: 'restaurant', phone: BUYER.phone, location: 'Little Rock, AR',
    delivery_pref: 'pickup', active: true, square_customer_id: customerId, created_at: now, updated_at: now,
  });
  console.log(`buyer ${BUYER.name} → Square customer ${customerId ?? '(Square not configured)'}`);
}

seed().then(() => process.exit(0)).catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
