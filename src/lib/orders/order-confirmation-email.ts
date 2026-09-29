import type { SupabaseClient } from '@supabase/supabase-js';
import sendMail from '@/lib/mail';
import { toOrderNumber } from '@/lib/orders/order-number';
import { logAudit } from '@/lib/audit';
import type { PaidEmailVariant } from '@/lib/orders/order-payment-types';

export type ConfirmationItem = {
  item_name: string;
  color?: string | null;
  size?: string | null;
  quantity: number;
  line_total: number;
};

export type OrderConfirmationShipping = {
  fullName: string | null;
  postalCode: string | null;
  prefecture: string | null;
  city: string | null;
  address: string | null;
  building: string | null;
  phone: string | null;
};

/**
 * 送信権を取る・戻すための最小の入れ口（FREQ-386）。
 * supabase-js のクライアントがそのまま入る（webhook-events.ts と同じ形）。
 */
export type OrderEmailClaimStore = {
  rpc(
    fn: 'claim_order_email' | 'release_order_email',
    args: { _order_id: string; _kind: OrderEmailKind },
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

export type OrderEmailKind = 'awaiting_payment' | 'paid' | 'payment_expired' | 'canceled';

type OrderConfirmationParams = {
  orderId: string;
  email: string | null | undefined;
  /** 送信権を取る先。同じ注文・同じ種類で送れるのは1経路だけ */
  store: OrderEmailClaimStore;
  fullName?: string | null;
  items: ConfirmationItem[];
  subtotalAmount: number;
  shippingAmount: number;
  /**
   * プロモーションコードで引かれた額。0 なら本文に割引の行を出さない。
   *
   * 必須にしてある。省略できると、呼び出し側を足したときに割引だけ落ちて
   * 「小計＋送料と合計が合わないメール」になる（FREQ-396）。
   */
  discountAmount: number;
  totalAmount: number;
  currency: string;
  shipping: OrderConfirmationShipping;
  paymentState?: 'paid' | 'awaiting_payment';
  /** 入金済みの書き分け（設計書 5-4）。送信権はどれも paid */
  paidVariant?: PaidEmailVariant;
};

export function formatCurrency(amount: number, currency: string): string {
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

export function formatItemLines(items: ConfirmationItem[], currency: string): string[] {
  return items.map((item) => {
    const variant = [item.color, item.size].filter(Boolean).join(' / ');
    const label = variant ? `${item.item_name}（${variant}）` : item.item_name;
    return `・${label} x${item.quantity}　${formatCurrency(item.line_total, currency)}`;
  });
}

/**
 * 注文番号（ORD-xxxx）入りの注文メールを、1注文・1種類につき1通だけ送る。
 *
 * **本番の入口は `sendOrderConfirmationEmailForOrderId` だけ。これを直接呼ばない。**
 * 呼び出し側が金額や明細を手で組み立てると、経路ごとに客へ届く内容がずれる。実際、値引額は
 * 注文行にしか無いため、下書きから組んでいた経路だけ割引の行が落ちていた（FREQ-396）。
 *
 * 注文確定は画面からの complete と Stripe webhook の2経路から走り、どちらも同じ注文を受け取る
 * （Stripe は同じイベントの再送と順序の入れ替わりを前提にするよう求めている）。送る前に DB で
 * 送信権を取り、取れた経路だけが送る（OWASP ASVS V11.1.6 の競合対策）。
 *
 * 送信の失敗は監査ログに残すだけで、注文確定は止めない（ほかと同じ扱い）。失敗したときは
 * 送信権を戻し、あとの経路（webhook の再送・掃除ジョブ）が送れるようにする。
 *
 * @returns 実際に送ったら true
 */
export async function sendOrderConfirmationEmail(params: OrderConfirmationParams): Promise<boolean> {
  const { orderId, email, fullName, items, subtotalAmount, shippingAmount, discountAmount, totalAmount, currency, shipping, store } = params;

  if (!email || !process.env.MAIL_FROM_ADDRESS) {
    return false;
  }

  const kind: OrderEmailKind = params.paymentState === 'awaiting_payment' ? 'awaiting_payment' : 'paid';
  const claimed = await claimOrderEmail(store, orderId, kind);
  if (!claimed) {
    return false;
  }

  const orderNumber = toOrderNumber(orderId);
  const awaitingPayment = params.paymentState === 'awaiting_payment';

  const subject = awaitingPayment
    ? `【お支払い待ち】ご注文を承りました（${orderNumber}）`
    : `【Le Fil des Heures】ご注文ありがとうございます（${orderNumber}）`;

  const leadLines = awaitingPayment
    ? [
        'ご注文を承りました。まだお支払いは完了していません。',
        'お支払い手続きの案内は、決済画面および Stripe からのメールをご確認ください。',
        'ご入金の確認後、あらためて確認メールをお送りします。',
      ]
    : params.paidVariant === 'payment_received_after_expiry'
      ? [
          'お支払い期限が過ぎたためご注文の取り消しをご案内しましたが、その後にお支払いを確認しました。',
          'ご注文は有効です。このまま商品をお届けします。',
        ]
      : ['この度はご注文いただき誠にありがとうございます。', 'ご注文を承りました。'];

  const itemLines = formatItemLines(items, currency);

  // 空の項目で空行が出ないよう、値のある行だけを積む。
  const shippingLines = [
    shipping.fullName ? `${shipping.fullName} 様` : null,
    shipping.postalCode ? `〒${shipping.postalCode}` : null,
    [shipping.prefecture, shipping.city, shipping.address].filter(Boolean).join('') || null,
    shipping.building || null,
    shipping.phone || null,
  ].filter((line): line is string => Boolean(line));

  const text = [
    fullName ? `${fullName} 様` : 'お客様',
    '',
    ...leadLines,
    '',
    `注文番号: ${orderNumber}`,
    '',
    'ご注文内容:',
    ...itemLines,
    '',
    `小計: ${formatCurrency(subtotalAmount, currency)}`,
    `送料: ${shippingAmount > 0 ? formatCurrency(shippingAmount, currency) : '無料'}`,
    // 値引があるときだけ出す。出さないと小計＋送料と合計が合わず、客には理由の無い差額に見える。
    // 書き方は注文詳細（/api/orders/[id]）と同じ「-￥1,000」にそろえる（FREQ-396）。
    ...(discountAmount > 0 ? [`割引: -${formatCurrency(discountAmount, currency)}`] : []),
    `合計: ${formatCurrency(totalAmount, currency)}`,
    '',
    'お届け先:',
    ...shippingLines,
    '',
    `お問い合わせの際は、注文番号（${orderNumber}）をお問い合わせフォームにご入力ください。`,
    '',
    'Le Fil des Heures',
  ].join('\n');

  try {
    await sendMail({
      to: email,
      subject,
      text,
    });
    return true;
  } catch (error) {
    console.warn('Order confirmation mail send failed. Order is finalized:', error);
    await logAudit({
      action: 'order.confirmation.mail',
      outcome: 'error',
      resource: 'order',
      resource_id: orderId,
      detail: 'mail_send_failed',
    });
    // 送れなかったので権利を戻す。戻さないと、あとの経路も「誰かが送った」と見なして送らない。
    await releaseOrderEmail(store, orderId, kind);
    return false;
  }
}

/**
 * 送信権を取る。取れたら true。
 *
 * 権利の確認そのものが失敗したときは true を返して送る。届かないより重複するほうがましで、
 * 見逃さないように監査ログに残す。
 */
export async function claimOrderEmail(
  store: OrderEmailClaimStore,
  orderId: string,
  kind: OrderEmailKind,
): Promise<boolean> {
  try {
    const { data, error } = await store.rpc('claim_order_email', { _order_id: orderId, _kind: kind });
    if (error) {
      throw new Error(error.message ?? 'claim_order_email failed');
    }
    return data === true;
  } catch (error) {
    console.warn('Order email claim failed. Sending anyway:', orderId, kind, error);
    await logAudit({
      action: 'order.confirmation.mail',
      outcome: 'error',
      resource: 'order',
      resource_id: orderId,
      detail: 'mail_claim_failed',
      metadata: { kind },
    });
    return true;
  }
}

export async function releaseOrderEmail(
  store: OrderEmailClaimStore,
  orderId: string,
  kind: OrderEmailKind,
): Promise<void> {
  try {
    const { error } = await store.rpc('release_order_email', { _order_id: orderId, _kind: kind });
    if (error) {
      throw new Error(error.message ?? 'release_order_email failed');
    }
  } catch (error) {
    console.warn('Order email claim release failed:', orderId, kind, error);
    await logAudit({
      action: 'order.confirmation.mail',
      outcome: 'error',
      resource: 'order',
      resource_id: orderId,
      detail: 'mail_claim_release_failed',
      metadata: { kind },
    });
  }
}

/** 注文行と明細を引ける入れ口。実体は service role の supabase クライアント。 */
export type OrderEmailSourceStore = OrderEmailClaimStore & Pick<SupabaseClient, 'from'>;

/** 注文メールに必要な orders の列。経路ごとに並びがずれないよう、ここ1か所で持つ。 */
const ORDER_EMAIL_COLUMNS =
  'id, shipping_email, shipping_full_name, subtotal_amount, shipping_amount, discount_amount, total_amount, currency, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_building, shipping_phone';

export type OrderEmailRow = {
  id: string;
  shipping_email: string | null;
  shipping_full_name: string | null;
  subtotal_amount: number;
  shipping_amount: number;
  discount_amount: number;
  total_amount: number;
  currency: string;
  shipping_postal_code: string | null;
  shipping_prefecture: string | null;
  shipping_city: string | null;
  shipping_address: string | null;
  shipping_building: string | null;
  shipping_phone: string | null;
};

export type OrderEmailSource = { order: OrderEmailRow; items: ConfirmationItem[] };

/**
 * 注文メールの材料（注文行と明細）を引く。明細が引けないときは null（送らない）。
 * 注文確認・期限切れ・取消のメールで同じ列の並びと同じ規則を使う。
 */
export async function fetchOrderEmailSource(
  store: OrderEmailSourceStore,
  orderId: string,
  logLabel: string,
): Promise<OrderEmailSource | null> {
  const { data: orderRow, error: orderError } = await store
    .from('orders')
    .select(ORDER_EMAIL_COLUMNS)
    .eq('id', orderId)
    .maybeSingle<OrderEmailRow>();

  if (orderError || !orderRow) {
    console.error(`${logLabel} failed to fetch order for email`, orderId, orderError);
    return null;
  }

  const { data: orderItems, error: orderItemsError } = await store
    .from('order_items')
    .select('item_name, color, size, quantity, line_total')
    .eq('order_id', orderId);

  // 取得の失敗と0件はどちらも「注文内容を書けない」。商品の行が無いメールは、客には
  // 注文が消えたように見える。送らなければ送信権を取らないので、後の経路が送り直せる。
  if (orderItemsError || !orderItems || orderItems.length === 0) {
    console.error(
      `${logLabel} failed to fetch order_items for email`,
      orderId,
      orderItemsError ?? 'no order_items rows',
    );
    return null;
  }

  return { order: orderRow, items: orderItems as ConfirmationItem[] };
}

/**
 * 注文 ID から注文行と明細を引いて、注文メールを送る。
 *
 * @returns 実際に送ったら true
 */
export async function sendOrderConfirmationEmailForOrderId(params: {
  store: OrderEmailSourceStore;
  orderId: string;
  paymentState: 'awaiting_payment' | 'paid';
  /** ログの頭に付ける呼び出し元の目印（'[webhook]' など） */
  logLabel: string;
  paidVariant?: PaidEmailVariant;
}): Promise<boolean> {
  const { store, orderId, paymentState, logLabel, paidVariant } = params;
  const source = await fetchOrderEmailSource(store, orderId, logLabel);
  if (!source) {
    return false;
  }

  const { order: orderRow, items } = source;
  return sendOrderConfirmationEmail({
    orderId: orderRow.id,
    email: orderRow.shipping_email,
    fullName: orderRow.shipping_full_name,
    items,
    subtotalAmount: orderRow.subtotal_amount,
    shippingAmount: orderRow.shipping_amount,
    // 注文確定 RPC 側の COALESCE と同じく、取れないときは 0 として扱う。
    discountAmount: orderRow.discount_amount ?? 0,
    totalAmount: orderRow.total_amount,
    currency: orderRow.currency,
    shipping: {
      fullName: orderRow.shipping_full_name,
      postalCode: orderRow.shipping_postal_code,
      prefecture: orderRow.shipping_prefecture,
      city: orderRow.shipping_city,
      address: orderRow.shipping_address,
      building: orderRow.shipping_building,
      phone: orderRow.shipping_phone,
    },
    paymentState,
    paidVariant,
    store,
  });
}
