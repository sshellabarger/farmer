import { Resend } from 'resend';
import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';

function getResend(env: Env) {
  return new Resend(env.RESEND_API_KEY);
}

async function resendSend(resend: Resend, payload: Parameters<Resend['emails']['send']>[0]): Promise<void> {
  const { error } = await resend.emails.send(payload);
  if (error) throw new Error(`Resend error: ${error.message}`);
}

function baseLayout(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body { font-family: -apple-system, sans-serif; color: #1a1a1a; margin: 0; padding: 0; background: #f5f5f0; }
  .wrapper { max-width: 600px; margin: 32px auto; background: #fff; border-radius: 12px; overflow: hidden; }
  .header { background: #2d5a27; padding: 24px 32px; color: #fff; }
  .header h1 { margin: 0; font-size: 22px; } .header p { margin: 4px 0 0; font-size: 13px; opacity: 0.75; }
  .body { padding: 28px 32px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; padding: 8px 10px; background: #f5f5f0; font-size: 12px; text-transform: uppercase; }
  td { padding: 10px; border-bottom: 1px solid #f0f0eb; }
  .footer { padding: 16px 32px; background: #f5f5f0; font-size: 12px; color: #999; text-align: center; }
  </style></head><body><div class="wrapper"><div class="header"><h1>FarmLink</h1><p>${title}</p></div><div class="body">${body}</div><div class="footer">FarmLink</div></div></body></html>`;
}

export async function sendInventoryReport({
  db, env, farmId, toEmail, toName,
}: {
  db: Firestore; env: Env; farmId: string; toEmail: string; toName: string;
}) {
  const farmDoc = await db.collection('farms').doc(farmId).get();
  if (!farmDoc.exists) throw new Error('Farm not found');
  const farm = farmDoc.data()!;

  const invSnap = await db.collection('inventory').where('farm_id', '==', farmId).get();
  const items = await Promise.all(invSnap.docs.map(async (d) => {
    const inv = d.data();
    const prodDoc = await db.collection('products').doc(inv.product_id).get();
    const prod = prodDoc.data() || {};
    return { name: prod.name, unit: prod.unit, quantity: inv.quantity, remaining: inv.remaining, price: inv.price, status: inv.status };
  }));

  const totalValue = items.reduce((sum, i) => sum + i.remaining * i.price, 0);
  const rows = items.map(i => `<tr><td>${i.name}</td><td>${i.remaining}/${i.quantity} ${i.unit}</td><td>$${i.price.toFixed(2)}</td><td>${i.status}</td></tr>`).join('');
  const body = `<h2>${farm.name} Inventory</h2><p>Total value: $${totalValue.toFixed(2)}</p><table><thead><tr><th>Product</th><th>Stock</th><th>Price</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;

  await resendSend(getResend(env), { from: env.FROM_EMAIL, to: toEmail, subject: `${farm.name} Inventory Report`, html: baseLayout('Inventory Report', body) });
}

export async function sendOrdersReport({
  db, env, userId, role, toEmail, toName, period = 'week',
}: {
  db: Firestore; env: Env; userId: string; role: 'farmer' | 'market'; toEmail: string; toName: string; period?: 'day' | 'week';
}) {
  const since = new Date();
  since.setDate(since.getDate() - (period === 'day' ? 1 : 7));

  const farmSnap = role === 'farmer' ? await db.collection('farms').where('user_id', '==', userId).limit(1).get() : null;
  const marketSnap = role === 'market' ? await db.collection('markets').where('user_id', '==', userId).limit(1).get() : null;
  const entityName = farmSnap && !farmSnap.empty ? farmSnap.docs[0].data().name : (marketSnap && !marketSnap.empty ? marketSnap.docs[0].data().name : toName);

  let query: FirebaseFirestore.Query = db.collection('orders');
  if (farmSnap && !farmSnap.empty) query = query.where('farm_id', '==', farmSnap.docs[0].id);
  if (marketSnap && !marketSnap.empty) query = query.where('market_id', '==', marketSnap.docs[0].id);

  const snapshot = await query.orderBy('created_at', 'desc').get();
  const orders = snapshot.docs.filter((d) => {
    const date = d.data().created_at?.toDate?.() || new Date(d.data().created_at);
    return date >= since;
  });

  const totalRevenue = orders.reduce((sum, d) => sum + Number(d.data().total || 0), 0);
  const rows = orders.map((d) => { const o = d.data(); return `<tr><td>${o.order_number}</td><td>$${Number(o.total).toFixed(2)}</td><td>${o.status}</td></tr>`; }).join('');
  const body = `<h2>${entityName} Orders (${period})</h2><p>${orders.length} orders, $${totalRevenue.toFixed(2)} total</p><table><thead><tr><th>Order</th><th>Total</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;

  await resendSend(getResend(env), { from: env.FROM_EMAIL, to: toEmail, subject: `${entityName} Orders Report`, html: baseLayout('Orders Report', body) });
}

export async function sendInvoice({
  db, env, orderId, toEmail, toName,
}: {
  db: Firestore; env: Env; orderId: string; toEmail: string; toName: string;
}) {
  const orderDoc = await db.collection('orders').doc(orderId).get();
  if (!orderDoc.exists) throw new Error('Order not found');
  const order = orderDoc.data()!;

  const itemsSnap = await db.collection('orders').doc(orderId).collection('order_items').get();
  const farmDoc = await db.collection('farms').doc(order.farm_id).get();
  const marketDoc = await db.collection('markets').doc(order.market_id).get();

  const rows = itemsSnap.docs.map((d) => { const i = d.data(); return `<tr><td>${i.product_name}</td><td>${i.quantity} ${i.unit}</td><td>$${i.unit_price.toFixed(2)}</td><td>$${i.line_total.toFixed(2)}</td></tr>`; }).join('');
  const body = `<h2>Invoice ${order.order_number}</h2><p>Farm: ${farmDoc.data()?.name} | Market: ${marketDoc.data()?.name}</p><table><thead><tr><th>Product</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table><p><strong>Order Total: $${Number(order.total).toFixed(2)}</strong></p>`;

  await resendSend(getResend(env), { from: env.FROM_EMAIL, to: toEmail, subject: `Invoice ${order.order_number}`, html: baseLayout(`Invoice ${order.order_number}`, body) });
  return order.order_number;
}

export async function sendEmail({ env, to, subject, message }: { env: Env; to: string; subject: string; message: string }) {
  const body = `<p style="font-size:15px;line-height:1.6">${message.replace(/\n/g, '<br>')}</p>`;
  await resendSend(getResend(env), { from: env.FROM_EMAIL, to, subject, html: baseLayout(subject, body) });
}
