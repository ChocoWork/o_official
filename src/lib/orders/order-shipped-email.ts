import sendMail from '@/lib/mail';
import { toOrderNumber } from '@/lib/orders/order-number';
import { logAudit } from '@/lib/audit';
import { SHIPPING_CARRIERS, type ShippingCarrierId } from '@/lib/orders/shipping-carriers';

type OrderShippedParams = {
  orderId: string;
  email: string | null;
  fullName: string | null;
  carrier: ShippingCarrierId;
  trackingNumber: string;
};

/**
 * 発送通知メールを送る。
 *
 * 送信に失敗しても発送処理は成功のまま（DB は既に shipped）。巻き戻すと
 * 二重発送の判定が壊れるので、監査ログに残すだけで例外は投げない。
 * 自動再送はしない。
 */
export async function sendOrderShippedEmail(params: OrderShippedParams): Promise<void> {
  const { orderId, email, fullName, carrier, trackingNumber } = params;

  if (!email || !process.env.MAIL_FROM_ADDRESS) {
    return;
  }

  const orderNumber = toOrderNumber(orderId);
  const carrierInfo = SHIPPING_CARRIERS[carrier];

  const text = [
    fullName ? `${fullName} 様` : 'お客様',
    '',
    'ご注文の商品を発送いたしました。',
    '',
    `注文番号: ${orderNumber}`,
    '',
    `配送業者: ${carrierInfo.label}`,
    `追跡番号: ${trackingNumber}`,
    `追跡はこちら: ${carrierInfo.trackingUrl(trackingNumber)}`,
    '',
    '※ 追跡情報は反映までに数時間かかる場合があります。',
    '',
    `お問い合わせの際は、注文番号（${orderNumber}）をお問い合わせフォームにご入力ください。`,
    '',
    'Le Fil des Heures',
  ].join('\n');

  try {
    await sendMail({
      to: email,
      subject: `【Le Fil des Heures】商品を発送いたしました（${orderNumber}）`,
      text,
    });
  } catch (error) {
    console.warn('Order shipped mail send failed. Shipment is recorded:', error);
    await logAudit({
      action: 'order.shipped.mail',
      outcome: 'error',
      resource: 'order',
      resource_id: orderId,
      detail: 'mail_send_failed',
    });
  }
}
