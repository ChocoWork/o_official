import sendMail from '@/lib/mail';
import { toOrderNumber } from '@/lib/orders/order-number';
import { logAudit } from '@/lib/audit';

type ConfirmationItem = {
  item_name: string;
  color?: string | null;
  size?: string | null;
  quantity: number;
  line_total: number;
};

type OrderConfirmationParams = {
  orderId: string;
  email: string | null | undefined;
  fullName?: string | null;
  items: ConfirmationItem[];
  subtotalAmount: number;
  shippingAmount: number;
  totalAmount: number;
  currency: string;
};

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency: currency.toUpperCase(),
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `¥${amount.toLocaleString('ja-JP')}`;
  }
}

/**
 * Send the customer-facing order confirmation email containing the order
 * number (ORD-xxxx). Failure is swallowed (audit only) so it never blocks
 * order finalization — matching the graceful degradation used elsewhere.
 */
export async function sendOrderConfirmationEmail(params: OrderConfirmationParams): Promise<void> {
  const { orderId, email, fullName, items, subtotalAmount, shippingAmount, totalAmount, currency } = params;

  if (!email || !process.env.MAIL_FROM_ADDRESS) {
    return;
  }

  const orderNumber = toOrderNumber(orderId);

  const itemLines = items.map((item) => {
    const variant = [item.color, item.size].filter(Boolean).join(' / ');
    const label = variant ? `${item.item_name}（${variant}）` : item.item_name;
    return `・${label} x${item.quantity}　${formatCurrency(item.line_total, currency)}`;
  });

  const text = [
    fullName ? `${fullName} 様` : 'お客様',
    '',
    'この度はご注文いただき誠にありがとうございます。',
    'ご注文を承りました。',
    '',
    `注文番号: ${orderNumber}`,
    '',
    'ご注文内容:',
    ...itemLines,
    '',
    `小計: ${formatCurrency(subtotalAmount, currency)}`,
    `送料: ${shippingAmount > 0 ? formatCurrency(shippingAmount, currency) : '無料'}`,
    `合計: ${formatCurrency(totalAmount, currency)}`,
    '',
    `お問い合わせの際は、注文番号（${orderNumber}）をお問い合わせフォームにご入力ください。`,
    '',
    'Le Fil des Heures',
  ].join('\n');

  try {
    await sendMail({
      to: email,
      subject: `【Le Fil des Heures】ご注文ありがとうございます（${orderNumber}）`,
      text,
    });
  } catch (error) {
    console.warn('Order confirmation mail send failed. Order is finalized:', error);
    await logAudit({
      action: 'order.confirmation.mail',
      outcome: 'error',
      resource: 'order',
      resource_id: orderId,
      detail: 'mail_send_failed',
    });
  }
}
