import type { ToolContext } from './index.js';
import { sendInventoryReport, sendOrdersReport, sendInvoice, sendEmail } from '../services/email.js';

export async function emailSend(input: Record<string, unknown>, ctx: ToolContext) {
  const { db, env, userId } = ctx;
  const reportType = input.report_type as string;
  const period = (input.period as 'day' | 'week') || 'week';
  const orderId = input.order_id as string | undefined;
  const customMessage = input.message as string | undefined;
  const subject = input.subject as string | undefined;

  const userDoc = userId ? await db.collection('users').doc(userId).get() : null;
  const user = userDoc?.data();
  const toEmail = (input.to_email as string | undefined) || user?.email || null;
  const toName = user?.name || 'FarmLink User';

  if (!toEmail) {
    return { success: false, error: 'No email address on file. Please provide your email address first.' };
  }

  try {
    switch (reportType) {
      case 'inventory': {
        const farmSnap = await db.collection('farms').where('user_id', '==', userId!).limit(1).get();
        if (farmSnap.empty) return { success: false, error: 'No farm found for your account.' };
        await sendInventoryReport({ db, env, farmId: farmSnap.docs[0].id, toEmail, toName });
        return { success: true, message: `Inventory report sent to ${toEmail}` };
      }
      case 'orders': {
        const role = (user?.role === 'market' ? 'market' : 'farmer') as 'farmer' | 'market';
        await sendOrdersReport({ db, env, userId: userId!, role, toEmail, toName, period });
        return { success: true, message: `Orders report sent to ${toEmail}` };
      }
      case 'invoice': {
        if (!orderId) return { success: false, error: 'Please provide an order ID.' };
        const orderNumber = await sendInvoice({ db, env, orderId, toEmail, toName });
        return { success: true, message: `Invoice ${orderNumber} sent to ${toEmail}` };
      }
      case 'custom': {
        if (!subject || !customMessage) return { success: false, error: 'Subject and message required.' };
        await sendEmail({ env, to: toEmail, subject, message: customMessage });
        return { success: true, message: `Email sent to ${toEmail}` };
      }
      default:
        return { success: false, error: `Unknown report type: ${reportType}` };
    }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
