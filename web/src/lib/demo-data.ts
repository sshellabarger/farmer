export const FARMS = [
  { id: 'f1', name: 'Green Acres Farm', contact: '+1 501-555-0201', location: 'Scott, AR', emoji: '🌱', specialty: 'Heirloom Vegetables' },
  { id: 'f2', name: 'Riverside Berries', contact: '+1 501-555-0202', location: 'Cabot, AR', emoji: '🫐', specialty: 'Berries & Stone Fruit' },
  { id: 'f3', name: 'Ozark Greens Co-op', contact: '+1 501-555-0203', location: 'Conway, AR', emoji: '🥬', specialty: 'Greens & Herbs' },
];

export const MARKETS = [
  { id: 'm1', name: 'ABC Market', priority: 1, contact: '+1 501-555-0101', active: true, type: 'Grocery', deliveryPref: 'pickup' },
  { id: 'm2', name: 'River Market', priority: 2, contact: '+1 501-555-0102', active: true, type: 'Farmers Market', deliveryPref: 'delivery' },
  { id: 'm3', name: 'Hillcrest Co-op', priority: 3, contact: '+1 501-555-0103', active: true, type: 'Co-op', deliveryPref: 'delivery' },
  { id: 'm4', name: 'Heights Corner', priority: 4, contact: '+1 501-555-0104', active: true, type: 'Restaurant', deliveryPref: 'pickup' },
  { id: 'm5', name: 'SoMa Kitchen', priority: 5, contact: '+1 501-555-0105', active: false, type: 'Restaurant', deliveryPref: 'delivery' },
];

export const INVENTORY = [
  { id: 'i1', farmId: 'f1', product: 'Cherokee Purple Tomatoes', qty: 100, remaining: 60, unit: 'lb', price: 2.99, harvestDate: '2026-03-21', status: 'available', category: 'Vegetables' },
  { id: 'i2', farmId: 'f1', product: 'Sweet Basil', qty: 40, remaining: 20, unit: 'bunch', price: 1.50, harvestDate: '2026-03-21', status: 'available', category: 'Herbs' },
  { id: 'i3', farmId: 'f2', product: 'Strawberries', qty: 80, remaining: 35, unit: 'lb', price: 4.50, harvestDate: '2026-03-21', status: 'available', category: 'Berries' },
  { id: 'i4', farmId: 'f2', product: 'Blackberries', qty: 30, remaining: 30, unit: 'pint', price: 5.00, harvestDate: '2026-03-21', status: 'available', category: 'Berries' },
  { id: 'i5', farmId: 'f1', product: 'Mixed Greens', qty: 25, remaining: 0, unit: 'lb', price: 3.25, harvestDate: '2026-03-19', status: 'sold', category: 'Greens' },
  { id: 'i6', farmId: 'f3', product: 'Lacinato Kale', qty: 50, remaining: 35, unit: 'bunch', price: 2.25, harvestDate: '2026-03-21', status: 'available', category: 'Greens' },
  { id: 'i7', farmId: 'f3', product: 'Cilantro', qty: 60, remaining: 42, unit: 'bunch', price: 1.25, harvestDate: '2026-03-21', status: 'available', category: 'Herbs' },
  { id: 'i8', farmId: 'f1', product: 'Jalapeños', qty: 40, remaining: 40, unit: 'lb', price: 2.00, harvestDate: '2026-03-20', status: 'available', category: 'Vegetables' },
];

export const ORDERS = [
  { id: 'o1', farmId: 'f1', marketId: 'm1', market: 'ABC Market', farm: 'Green Acres Farm', items: [{ product: 'Cherokee Purple Tomatoes', qty: 40, unit: 'lb', price: 2.99 }], status: 'confirmed', date: '2026-03-21', delivery: 'pickup', deliveryTime: '7:00 AM', total: 119.60 },
  { id: 'o2', farmId: 'f2', marketId: 'm2', market: 'River Market', farm: 'Riverside Berries', items: [{ product: 'Strawberries', qty: 30, unit: 'lb', price: 4.50 }], status: 'in-transit', date: '2026-03-21', delivery: 'delivery', deliveryTime: '8:30 AM', total: 135.00 },
  { id: 'o3', farmId: 'f1', marketId: 'm3', market: 'Hillcrest Co-op', farm: 'Green Acres Farm', items: [{ product: 'Sweet Basil', qty: 20, unit: 'bunch', price: 1.50 }, { product: 'Jalapeños', qty: 10, unit: 'lb', price: 2.00 }], status: 'pending', date: '2026-03-21', delivery: 'delivery', deliveryTime: '10:00 AM', total: 50.00 },
  { id: 'o4', farmId: 'f3', marketId: 'm1', market: 'ABC Market', farm: 'Ozark Greens Co-op', items: [{ product: 'Lacinato Kale', qty: 15, unit: 'bunch', price: 2.25 }], status: 'confirmed', date: '2026-03-21', delivery: 'pickup', deliveryTime: '7:00 AM', total: 33.75 },
  { id: 'o5', farmId: 'f2', marketId: 'm4', market: 'Heights Corner', farm: 'Riverside Berries', items: [{ product: 'Strawberries', qty: 15, unit: 'lb', price: 4.50 }], status: 'delivered', date: '2026-03-20', delivery: 'pickup', deliveryTime: '6:30 AM', total: 67.50 },
  { id: 'o6', farmId: 'f1', marketId: 'm2', market: 'River Market', farm: 'Green Acres Farm', items: [{ product: 'Mixed Greens', qty: 25, unit: 'lb', price: 3.25 }], status: 'delivered', date: '2026-03-19', delivery: 'delivery', deliveryTime: '9:00 AM', total: 81.25 },
];

export const RECURRING_ORDERS = [
  { id: 'r1', marketId: 'm1', market: 'ABC Market', farmId: 'f1', farm: 'Green Acres Farm', items: [{ product: 'Sweet Basil', qty: 10, unit: 'bunch' }], frequency: 'weekly', day: 'Monday', active: true, nextDelivery: '2026-03-23' },
  { id: 'r2', marketId: 'm2', market: 'River Market', farmId: 'f2', farm: 'Riverside Berries', items: [{ product: 'Strawberries', qty: 20, unit: 'lb' }], frequency: 'twice-weekly', day: 'Tue & Fri', active: true, nextDelivery: '2026-03-24' },
  { id: 'r3', marketId: 'm3', market: 'Hillcrest Co-op', farmId: 'f3', farm: 'Ozark Greens Co-op', items: [{ product: 'Lacinato Kale', qty: 10, unit: 'bunch' }, { product: 'Cilantro', qty: 8, unit: 'bunch' }], frequency: 'weekly', day: 'Wednesday', active: true, nextDelivery: '2026-03-25' },
  { id: 'r4', marketId: 'm4', market: 'Heights Corner', farmId: 'f1', farm: 'Green Acres Farm', items: [{ product: 'Cherokee Purple Tomatoes', qty: 20, unit: 'lb' }], frequency: 'weekly', day: 'Thursday', active: false, nextDelivery: null },
];

export const WEEKLY_SALES = [
  { day: 'Mon', revenue: 285, orders: 4 },
  { day: 'Tue', revenue: 412, orders: 6 },
  { day: 'Wed', revenue: 198, orders: 3 },
  { day: 'Thu', revenue: 367, orders: 5 },
  { day: 'Fri', revenue: 523, orders: 8 },
  { day: 'Sat', revenue: 641, orders: 11 },
  { day: 'Sun', revenue: 338, orders: 5 },
];

export const TOP_PRODUCTS = [
  { product: 'Strawberries', revenue: 1215, qty: 270, unit: 'lb', trend: '+18%' },
  { product: 'Cherokee Purple Tomatoes', revenue: 896, qty: 300, unit: 'lb', trend: '+12%' },
  { product: 'Sweet Basil', revenue: 420, qty: 280, unit: 'bunch', trend: '+5%' },
  { product: 'Lacinato Kale', revenue: 382, qty: 170, unit: 'bunch', trend: '+22%' },
  { product: 'Jalapeños', revenue: 310, qty: 155, unit: 'lb', trend: '-3%' },
];

// ─── Farmer SMS Demo Scripts ───
export const FARMER_SMS = [
  { from: 'app', text: '☀️ Good morning! Reminder: ABC Market\'s standing order (10 bunch Sweet Basil) is due Monday. You have 20 bunches in stock — all set?' },
  { from: 'farmer', text: 'yes that\'s good. also I pulled 100lb of cherokee tomatoes this morning' },
  { from: 'app', text: 'Nice harvest! 🍅 I\'ve got Cherokee Purples at $2.99/lb on your price list. Still good, or want to adjust?', delay: 900 },
  { from: 'farmer', text: 'bump to 3.25, they\'re looking great this week' },
  { from: 'app', text: 'Updated to $3.25/lb.\n\nWho should I notify?\n\n1️⃣ ABC Market (Priority)\n2️⃣ All active markets\n3️⃣ Let me pick', delay: 800 },
  { from: 'farmer', text: 'ABC first, everyone else in an hour' },
  { from: 'app', text: 'Done! 📨\n\n✅ ABC Market — notified now\n⏳ River Market — 10:00 AM\n⏳ Hillcrest Co-op — 10:00 AM\n⏳ Heights Corner — 10:00 AM\n\nBTW — Hillcrest ordered kale from Ozark Greens this morning. They might pair tomatoes with that. Want me to suggest a bundle to them?', delay: 1200 },
  { from: 'farmer', text: 'yeah good idea' },
  { from: 'app', text: 'I\'ll pitch them a "Salsa Garden" bundle: Cherokee Tomatoes + Cilantro (from Ozark Greens) + your Jalapeños. I\'ll coordinate with Ozark Greens on the cilantro side. 🌶️', delay: 1000 },
  { from: 'farmer', text: 'love it. what\'s my delivery schedule look like today?' },
  { from: 'app', text: 'Today\'s deliveries:\n\n🟢 7:00 AM — ABC Market (pickup)\n   40lb Tomatoes + 15 bunch Kale (Ozark)\n\n🔵 8:30 AM — River Market\n   30lb Strawberries (Riverside delivering)\n\n🟡 10:00 AM — Hillcrest Co-op\n   20 bunch Basil + 10lb Jalapeños\n   ⚠️ Pending confirmation\n\nWant me to text Hillcrest to confirm?', delay: 1200 },
  { from: 'farmer', text: 'yes please' },
  { from: 'app', text: 'Sent! I\'ll let you know when they confirm. 👍\n\n📊 Quick stats: You\'re up 15% this week vs last. Strawberries and tomatoes are your hot sellers.', delay: 900 },
];

export const FARMER_SMS_2 = [
  { from: 'farmer', text: 'my blackberry bushes got hammered by that frost last night. gonna lose about half the crop' },
  { from: 'app', text: 'Sorry to hear that! 🥶 Let me help you manage the impact.\n\nYou have 3 active blackberry orders totaling 45 pint:\n• ABC Market — 15 pint (pickup Mon)\n• River Market — 20 pint (delivery Tue)\n• Heights Corner — 10 pint (pickup Wed)\n\nCurrent stock: 30 pint. Want me to adjust?', delay: 1000 },
  { from: 'farmer', text: 'keep ABC, they\'re priority. reduce river to 10 and cancel heights' },
  { from: 'app', text: 'Done! ✅\n\n✅ ABC Market — 15 pint (kept)\n📝 River Market — reduced to 10 pint (notified)\n❌ Heights Corner — cancelled (notified)\n\nI also bumped your blackberry price to $6.50/pint since supply is limited. Want me to keep it at $5.00 instead?', delay: 1100 },
  { from: 'farmer', text: 'no 6.50 is fair given the shortage. thanks' },
  { from: 'app', text: 'Price updated to $6.50/pint. All markets notified of limited supply. 📊\n\nAlso — Ozark Greens has blackberries at $5.00/pint. Want me to ask if they can cover Heights Corner\'s order? Could maintain the relationship.', delay: 1000 },
  { from: 'farmer', text: 'that\'d be great, yeah connect them' },
  { from: 'app', text: 'Messaged Ozark Greens! I suggested they reach out to Heights Corner directly. Good neighbor farming! 🤝', delay: 800 },
];

export const FARMER_SMS_3 = [
  { from: 'app', text: '📉 Low stock alert: Sweet Basil has 5 bunches left (12% of original). You have a standing order for 10 bunches due Monday.' },
  { from: 'farmer', text: 'oh shoot. I can harvest more tomorrow morning, should have 30 bunches by sunday' },
  { from: 'app', text: 'Great! I\'ll mark basil as "restocking Sunday" so markets know it\'s coming. Should I hold ABC Market\'s standing order or offer a substitute?', delay: 900 },
  { from: 'farmer', text: 'hold it, we\'ll have it ready monday AM' },
  { from: 'app', text: '✅ ABC Market\'s Monday basil order is held.\n\nAlso — River Market asked about Thai Basil yesterday. You mentioned you\'re growing some. Want to add it to your listings?', delay: 1000 },
  { from: 'farmer', text: 'yeah add thai basil, 20 bunch at 2.00 each' },
  { from: 'app', text: '🌿 Added! Thai Basil — 20 bunch @ $2.00\n\nI notified River Market first since they asked. Want me to tell other markets too?', delay: 800 },
  { from: 'farmer', text: 'yeah send it to everyone' },
  { from: 'app', text: 'Done! All 4 active markets notified about the new Thai Basil listing. 📨\n\n🆕 New product revenue potential: If all 20 bunches sell = $40.00. Not bad for a first listing!', delay: 900 },
];

// ─── Market SMS Demo Scripts ───
export const MARKET_SMS = [
  { from: 'app', text: '🌿 Fresh from Green Acres Farm!\n\n🍅 100lb Cherokee Purple Tomatoes — $3.25/lb\nHarvested this morning. You\'re getting first pick!' },
  { from: 'market', text: 'great timing, we\'re low on tomatoes. 40lb please' },
  { from: 'app', text: '40lb Cherokee Purples @ $3.25/lb = $130.00\n\nPickup at 7 AM as usual?', delay: 800 },
  { from: 'market', text: 'yes' },
  { from: 'app', text: 'Confirmed! ✅ Order #1048\n\nYou also have a pickup from Ozark Greens at the same time:\n• 15 bunch Lacinato Kale — $33.75\n\nCombined pickup total: $163.75\n\nBoth farms have been notified.', delay: 1000 },
  { from: 'market', text: 'perfect. do I have any standing orders coming this week?' },
  { from: 'app', text: 'This week\'s standing orders:\n\n📅 Mon — 10 bunch Sweet Basil (Green Acres) — $15.00\n📅 Tue — 20lb Strawberries (Riverside) — $90.00\n📅 Fri — 20lb Strawberries (Riverside) — $90.00\n\nTotal recurring: $195.00\n\nAll farms have confirmed availability. Want to adjust any of these?', delay: 1100 },
  { from: 'market', text: 'bump the strawberries to 25lb on both' },
  { from: 'app', text: 'Updated! Strawberry orders now 25lb each.\n\nTue: $112.50 | Fri: $112.50\n\nRiverside Berries has been notified. They\'ve got 80lb fresh today so you\'re covered. 🍓', delay: 900 },
  { from: 'market', text: 'what\'s available across all farms right now?' },
  { from: 'app', text: 'Available now from all connected farms:\n\n🌱 Green Acres Farm:\n  🍅 Cherokee Tomatoes — 60lb @ $3.25\n  🌿 Sweet Basil — 20 bunch @ $1.50\n  🌶️ Jalapeños — 40lb @ $2.00\n\n🫐 Riverside Berries:\n  🍓 Strawberries — 35lb @ $4.50\n  🫐 Blackberries — 30 pint @ $5.00\n\n🥬 Ozark Greens:\n  🥬 Lacinato Kale — 20 bunch @ $2.25\n  🌿 Cilantro — 42 bunch @ $1.25\n\nWant to order from any of these?', delay: 1300 },
];

export const MARKET_SMS_2 = [
  { from: 'market', text: 'I need stuff for a farm-to-table dinner saturday night. 40 guests' },
  { from: 'app', text: 'Fun! 🍽️ Here\'s what I\'d suggest for 40 guests from your connected farms:\n\n🥗 Salad Course:\n  🥬 Lacinato Kale — 8 bunch ($18.00)\n  🌿 Cilantro — 5 bunch ($6.25)\n\n🍅 Main Course sides:\n  🍅 Cherokee Tomatoes — 15lb ($48.75)\n  🌶️ Jalapeños — 5lb ($10.00)\n\n🍓 Dessert:\n  🍓 Strawberries — 10lb ($45.00)\n  🫐 Blackberries — 8 pint ($40.00)\n\nTotal: ~$168.00 from 3 farms\n\nWant me to place these orders?', delay: 1400 },
  { from: 'market', text: 'yes all of it. can everything be delivered friday?' },
  { from: 'app', text: 'Checking delivery schedules...\n\n✅ Green Acres — Friday delivery available (6-10am)\n✅ Riverside Berries — Friday delivery available (8-11am)\n⚠️ Ozark Greens — No Friday delivery. Options:\n  • Pickup Thursday evening\n  • Add to Green Acres route (they\'re nearby)\n\nWhat works best?', delay: 1200 },
  { from: 'market', text: 'ask green acres if they can grab the ozark stuff on their route' },
  { from: 'app', text: 'Messaged Green Acres! Sarah said yes — she\'ll pick up the kale and cilantro from Ozark Greens on her Friday morning route. No extra charge. 🚛\n\nAll 3 orders confirmed for Friday delivery:\n\n📦 Order #1052 — Green Acres: $58.75\n📦 Order #1053 — Riverside: $85.00\n📦 Order #1054 — Ozark (via Green Acres): $24.25\n\nTotal: $168.00. Farms notified!', delay: 1300 },
];

export const MARKET_SMS_3 = [
  { from: 'app', text: '📊 Your weekly spending report:\n\nThis week: $487.50 across 8 orders\nLast week: $412.00 across 6 orders\n\nTop purchases:\n🍓 Strawberries — $225.00 (46%)\n🍅 Tomatoes — $130.00 (27%)\n🥬 Kale — $67.50 (14%)\n\nYou\'re spending 18% more this week. Want to review standing orders?' },
  { from: 'market', text: 'the strawberry price seems high. what are other farms charging?' },
  { from: 'app', text: 'Strawberry pricing from your area:\n\n🫐 Riverside Berries — $4.50/lb (your current supplier)\n🌱 Green Acres — $4.25/lb (limited supply, 20lb avail)\n🆕 Valley Fresh Farm — $3.99/lb (new to FarmLink, not connected yet)\n\nRiverside\'s are organic certified. Want me to connect you with Valley Fresh for comparison?', delay: 1100 },
  { from: 'market', text: 'yes connect me with valley fresh. and get a sample order - 5lb' },
  { from: 'app', text: 'Done! 🤝\n\n✅ Connection request sent to Valley Fresh Farm\n📦 Sample order: 5lb Strawberries @ $3.99/lb = $19.95\n\nI\'ll keep your Riverside standing order active until you decide. You can compare quality side-by-side this week!', delay: 1000 },
  { from: 'market', text: 'smart. also cancel the wednesday kale order, switching to local supplier' },
  { from: 'app', text: 'Cancelled Wednesday kale order from Ozark Greens. ❌\n\nThey\'ve been notified. Your weekly recurring total drops from $195 to $161.25.\n\nFYI — Ozark Greens just listed organic spinach at $2.50/bunch if you want a different product from them. Keeps the relationship going! 🥬', delay: 1000 },
];

// Grouped for easy access
export const FARMER_SCRIPTS = [
  { id: 'harvest', title: 'Morning Harvest & Notifications', farm: 'Green Acres Farm', script: FARMER_SMS },
  { id: 'frost', title: 'Frost Damage & Order Management', farm: 'Riverside Berries', script: FARMER_SMS_2 },
  { id: 'restock', title: 'Low Stock Alert & New Listing', farm: 'Green Acres Farm', script: FARMER_SMS_3 },
];

export const MARKET_SCRIPTS = [
  { id: 'ordering', title: 'Fresh Produce & Standing Orders', market: 'ABC Market', script: MARKET_SMS },
  { id: 'event', title: 'Farm-to-Table Event Planning', market: 'River Market', script: MARKET_SMS_2 },
  { id: 'analytics', title: 'Spending Report & Price Shopping', market: 'Hillcrest Co-op', script: MARKET_SMS_3 },
];

export const EMOJI_MAP: Record<string, string> = {
  Vegetables: '🍅',
  Herbs: '🌿',
  Berries: '🍓',
  Greens: '🥬',
  default: '📦',
};
