import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';

// Initialize with default credentials (uses GOOGLE_APPLICATION_CREDENTIALS or gcloud auth)
initializeApp({ projectId: 'arkansaslocalfoodnetwork' });
const db = getFirestore();

async function seed() {
  console.log('Seeding Firestore...');

  // Users
  const adminId = uuid();
  const farmer1Id = uuid();
  const farmer2Id = uuid();
  const market1Id = uuid();
  const market2Id = uuid();

  await db.collection('users').doc(adminId).set({
    name: 'Scott Shellabarger', phone: '+15551000000', email: 'scott@stjosephcenter.org',
    role: 'admin', created_at: new Date(), updated_at: new Date(),
  });
  await db.collection('users').doc(farmer1Id).set({
    name: 'Sarah Johnson', phone: '+15551000001', email: 'sarah@greenvalley.farm',
    role: 'farmer', created_at: new Date(), updated_at: new Date(),
  });
  await db.collection('users').doc(farmer2Id).set({
    name: 'Marcus Bell', phone: '+15551000002', email: 'marcus@bellacres.farm',
    role: 'farmer', created_at: new Date(), updated_at: new Date(),
  });
  await db.collection('users').doc(market1Id).set({
    name: 'Lisa Chen', phone: '+15551000003', email: 'lisa@localgrocer.com',
    role: 'market', created_at: new Date(), updated_at: new Date(),
  });
  await db.collection('users').doc(market2Id).set({
    name: 'Chef Roberto', phone: '+15551000004', email: 'roberto@farmtable.com',
    role: 'market', created_at: new Date(), updated_at: new Date(),
  });

  // Farms
  const farm1Id = uuid();
  const farm2Id = uuid();

  await db.collection('farms').doc(farm1Id).set({
    user_id: farmer1Id, name: 'Green Valley Farm', location: 'Conway, AR',
    specialty: 'Organic vegetables', active: true, timezone: 'America/Chicago',
    phone: '+15551000001', email: 'sarah@greenvalley.farm',
    delivery_schedule: [
      { day: 'monday', time_window: '6am-10am', areas: ['Little Rock', 'Conway'] },
      { day: 'thursday', time_window: '6am-10am', areas: ['Little Rock', 'North Little Rock'] },
    ],
    contacts: [], created_at: new Date(), updated_at: new Date(),
  });
  await db.collection('farms').doc(farm2Id).set({
    user_id: farmer2Id, name: 'Bell Acres', location: 'Cabot, AR',
    specialty: 'Berries and stone fruit', active: true, timezone: 'America/Chicago',
    phone: '+15551000002', email: 'marcus@bellacres.farm',
    delivery_schedule: [
      { day: 'tuesday', time_window: '7am-11am', areas: ['Little Rock'] },
      { day: 'friday', time_window: '7am-11am', areas: ['Little Rock', 'Cabot'] },
    ],
    contacts: [], created_at: new Date(), updated_at: new Date(),
  });

  // Markets
  const mkt1Id = uuid();
  const mkt2Id = uuid();

  await db.collection('markets').doc(mkt1Id).set({
    user_id: market1Id, name: 'Local Grocer Co-op', location: 'Little Rock, AR',
    type: 'grocery', delivery_pref: 'delivery', active: true,
    phone: '+15551000003', email: 'lisa@localgrocer.com',
    contacts: [], created_at: new Date(), updated_at: new Date(),
  });
  await db.collection('markets').doc(mkt2Id).set({
    user_id: market2Id, name: 'Farm & Table Restaurant', location: 'North Little Rock, AR',
    type: 'restaurant', delivery_pref: 'either', active: true,
    phone: '+15551000004', email: 'roberto@farmtable.com',
    contacts: [], created_at: new Date(), updated_at: new Date(),
  });

  // Products
  const products = [
    { id: uuid(), farm_id: farm1Id, name: 'Cherokee Purple Tomatoes', category: 'Vegetables', unit: 'lb', default_price: 4.50, seasonal: true },
    { id: uuid(), farm_id: farm1Id, name: 'Rainbow Chard', category: 'Greens', unit: 'bunch', default_price: 3.00, seasonal: false },
    { id: uuid(), farm_id: farm1Id, name: 'Sugar Snap Peas', category: 'Vegetables', unit: 'lb', default_price: 5.00, seasonal: true },
    { id: uuid(), farm_id: farm1Id, name: 'Fresh Basil', category: 'Herbs', unit: 'bunch', default_price: 2.50, seasonal: true },
    { id: uuid(), farm_id: farm2Id, name: 'Blackberries', category: 'Fruits', unit: 'pint', default_price: 6.00, seasonal: true },
    { id: uuid(), farm_id: farm2Id, name: 'Peaches', category: 'Fruits', unit: 'lb', default_price: 3.50, seasonal: true },
    { id: uuid(), farm_id: farm2Id, name: 'Muscadine Grapes', category: 'Fruits', unit: 'lb', default_price: 5.00, seasonal: true },
  ];

  for (const p of products) {
    const { id, ...data } = p;
    await db.collection('products').doc(id).set({ ...data, created_at: new Date() });
  }

  // Inventory
  const inventoryItems = [
    { farm_id: farm1Id, product_id: products[0].id, quantity: 50, remaining: 42, price: 4.50, status: 'partial' },
    { farm_id: farm1Id, product_id: products[1].id, quantity: 30, remaining: 30, price: 3.00, status: 'available' },
    { farm_id: farm1Id, product_id: products[2].id, quantity: 25, remaining: 25, price: 5.00, status: 'available' },
    { farm_id: farm1Id, product_id: products[3].id, quantity: 40, remaining: 35, price: 2.50, status: 'partial' },
    { farm_id: farm2Id, product_id: products[4].id, quantity: 60, remaining: 48, price: 6.00, status: 'partial' },
    { farm_id: farm2Id, product_id: products[5].id, quantity: 80, remaining: 80, price: 3.50, status: 'available' },
    { farm_id: farm2Id, product_id: products[6].id, quantity: 40, remaining: 40, price: 5.00, status: 'available' },
  ];

  for (const inv of inventoryItems) {
    await db.collection('inventory').doc(uuid()).set({ ...inv, listed_at: new Date(), harvest_date: null, image_url: null });
  }

  // Farm-Market Relationships
  await db.collection('farm_market_rels').doc(uuid()).set({
    farm_id: farm1Id, market_id: mkt1Id, priority: 1, notification_delay_min: 0,
    active: true, status: 'active', initiated_by: 'farm', created_at: new Date(),
  });
  await db.collection('farm_market_rels').doc(uuid()).set({
    farm_id: farm1Id, market_id: mkt2Id, priority: 2, notification_delay_min: 15,
    active: true, status: 'active', initiated_by: 'market', created_at: new Date(),
  });
  await db.collection('farm_market_rels').doc(uuid()).set({
    farm_id: farm2Id, market_id: mkt2Id, priority: 1, notification_delay_min: 0,
    active: true, status: 'active', initiated_by: 'farm', created_at: new Date(),
  });

  // Sample Orders
  const order1Id = uuid();
  await db.collection('orders').doc(order1Id).set({
    farm_id: farm1Id, market_id: mkt1Id, order_number: 'ORD-DEMO001',
    status: 'delivered', total: 67.50, order_date: new Date(Date.now() - 3 * 86400000),
    delivery_type: 'delivery', notes: null,
    created_at: new Date(Date.now() - 3 * 86400000), updated_at: new Date(Date.now() - 2 * 86400000),
  });
  await db.collection('orders').doc(order1Id).collection('order_items').doc(uuid()).set({
    inventory_id: 'demo', product_name: 'Cherokee Purple Tomatoes', quantity: 10, unit: 'lb', unit_price: 4.50, line_total: 45.00,
  });
  await db.collection('orders').doc(order1Id).collection('order_items').doc(uuid()).set({
    inventory_id: 'demo', product_name: 'Fresh Basil', quantity: 9, unit: 'bunch', unit_price: 2.50, line_total: 22.50,
  });

  const order2Id = uuid();
  await db.collection('orders').doc(order2Id).set({
    farm_id: farm2Id, market_id: mkt2Id, order_number: 'ORD-DEMO002',
    status: 'confirmed', total: 54.00, order_date: new Date(Date.now() - 86400000),
    delivery_type: 'pickup', notes: 'Will pick up Friday morning',
    created_at: new Date(Date.now() - 86400000), updated_at: new Date(),
  });
  await db.collection('orders').doc(order2Id).collection('order_items').doc(uuid()).set({
    inventory_id: 'demo', product_name: 'Blackberries', quantity: 6, unit: 'pint', unit_price: 6.00, line_total: 36.00,
  });
  await db.collection('orders').doc(order2Id).collection('order_items').doc(uuid()).set({
    inventory_id: 'demo', product_name: 'Peaches', quantity: 4, unit: 'lb', unit_price: 3.50, line_total: 14.00,
  });

  // Deliveries
  await db.collection('deliveries').doc(uuid()).set({
    order_id: order1Id, type: 'delivery', scheduled_at: new Date(Date.now() - 2 * 86400000),
    completed_at: new Date(Date.now() - 2 * 86400000), status: 'completed', notes: null, created_at: new Date(Date.now() - 3 * 86400000),
  });
  await db.collection('deliveries').doc(uuid()).set({
    order_id: order2Id, type: 'pickup', scheduled_at: new Date(Date.now() + 86400000),
    completed_at: null, status: 'scheduled', notes: 'Friday morning pickup', created_at: new Date(Date.now() - 86400000),
  });

  console.log('Seed complete!');
  console.log(`  Users: 5 (1 admin, 2 farmers, 2 markets)`);
  console.log(`  Farms: 2`);
  console.log(`  Markets: 2`);
  console.log(`  Products: ${products.length}`);
  console.log(`  Inventory: ${inventoryItems.length}`);
  console.log(`  Relationships: 3`);
  console.log(`  Orders: 2`);
  console.log(`  Deliveries: 2`);
}

seed().catch(console.error);
