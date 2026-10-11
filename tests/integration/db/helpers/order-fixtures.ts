import { createHash } from 'crypto';
import type { PgClient } from './local-db';

/** DB 結合テストの試験データ。本計画の Task 3〜7・21 が使う。 */
export const PRICE = 5000;

export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 商品・色・サイズ・バリアントを作り、在庫を台帳の restock で入れる。
 * バリアントは初期在庫を持てない（トリガーが拒否する）ので、在庫は台帳から入れる。
 */
export async function createCatalogFixture(
  db: PgClient,
  options: { stock: number; itemStatus?: 'published' | 'private'; isActive?: boolean } = { stock: 0 },
): Promise<{ itemId: number; variantId: number; colorName: string; sizeLabel: string }> {
  const suffix = uniqueSuffix();
  const colorName = 'BLACK';
  const sizeLabel = 'M';
  const item = await db.query(
    `insert into public.items (name, description, price, category, image_url, status)
     values ('fx-' || $1::text, '照合テスト', $2, 'TOPS', 'https://example.com/item.png', $3)
     returning id`,
    [suffix, PRICE, options.itemStatus ?? 'published'],
  );
  const itemId = Number(item.rows[0].id);
  const color = await db.query(
    `insert into public.item_colors (item_id, name, hex, position) values ($1, $2, '#000000', 0) returning id`,
    [itemId, colorName],
  );
  const size = await db.query(
    `insert into public.item_sizes (item_id, label, position) values ($1, $2, 0) returning id`,
    [itemId, sizeLabel],
  );
  const variant = await db.query(
    `insert into public.item_variants (item_id, color_id, size_id, is_active) values ($1, $2, $3, $4) returning id`,
    [itemId, color.rows[0].id, size.rows[0].id, options.isActive ?? true],
  );
  const variantId = Number(variant.rows[0].id);
  if (options.stock > 0) {
    await db.query(
      `insert into public.stock_movements (variant_id, delta, reason, note) values ($1, $2, 'restock', 'fixture')`,
      [variantId, options.stock],
    );
  }
  return { itemId, variantId, colorName, sizeLabel };
}

type DraftLine = { quantity: number; colorName?: string | null; sizeLabel?: string | null };

/**
 * Session を付けた下書き（status = created）を作る。ゲストのカートと明細も作り、下書きの cart_id と
 * 写しの source_cart_line_id で結ぶ。カートは同じバリアントを1行にまとめる（数量は明細の合計）ので、
 * 色・サイズが同じ明細は同じ明細の参照を持つ。色・サイズがバリアントに当たらない明細は参照を空にする。
 * lines を省くと quantity・colorName・sizeLabel の1明細になる。色・サイズの既定は BLACK・M（createCatalogFixture と同じ）。
 */
export async function createDraft(
  db: PgClient,
  options: {
    itemId: number;
    quantity?: number;
    colorName?: string | null;
    sizeLabel?: string | null;
    lines?: DraftLine[];
    kanaName?: string | null;
    buyerUserId?: string | null;
  },
): Promise<{
  draftId: string;
  cartSessionId: string;
  checkoutSessionId: string;
  cartId: string;
  cartLineId: string | null;
  totalAmount: number;
}> {
  const suffix = uniqueSuffix();
  const cartSessionId = `fx-session-${suffix}`;
  const checkoutSessionId = `cs_fx_${suffix}`;
  const lines: DraftLine[] = options.lines ?? [
    { quantity: options.quantity ?? 1, colorName: options.colorName, sizeLabel: options.sizeLabel },
  ];
  const colorOf = (line: DraftLine) => (line.colorName === undefined ? 'BLACK' : line.colorName);
  const sizeOf = (line: DraftLine) => (line.sizeLabel === undefined ? 'M' : line.sizeLabel);
  const totalAmount = lines.reduce((sum, line) => sum + PRICE * line.quantity, 0);

  const cart = await db.query('insert into public.carts (guest_token_hash) values ($1) returning id', [
    createHash('sha256').update(`fx-cart-${suffix}`).digest('hex'),
  ]);
  const cartId = cart.rows[0].id as string;

  const variantIds: Array<number | null> = [];
  for (const line of lines) {
    const variant = await db.query(
      `select v.id from public.item_variants as v
       left join public.item_colors as c on c.id = v.color_id
       left join public.item_sizes as z on z.id = v.size_id
       where v.item_id = $1
         and coalesce(c.name, '') = coalesce($2, '')
         and coalesce(z.label, '') = coalesce($3, '')
       limit 1`,
      [options.itemId, colorOf(line), sizeOf(line)],
    );
    variantIds.push(variant.rows[0] ? Number(variant.rows[0].id) : null);
  }

  const quantityByVariant = new Map<number, number>();
  lines.forEach((line, index) => {
    const variantId = variantIds[index];
    if (variantId !== null) {
      quantityByVariant.set(variantId, (quantityByVariant.get(variantId) ?? 0) + line.quantity);
    }
  });
  const lineIdByVariant = new Map<number, string>();
  for (const [variantId, quantity] of quantityByVariant) {
    const saved = await db.query(
      'insert into public.cart_lines (cart_id, variant_id, quantity) values ($1, $2, $3) returning id',
      [cartId, variantId, quantity],
    );
    lineIdByVariant.set(variantId, saved.rows[0].id as string);
  }
  const lineIds = variantIds.map((variantId) => (variantId === null ? null : lineIdByVariant.get(variantId) ?? null));

  const draft = await db.query(
    `insert into public.checkout_drafts
       (session_id, checkout_session_id, payment_method, subtotal_amount, shipping_amount, discount_amount,
        total_amount, currency, shipping_snapshot, items_snapshot, buyer_user_id, cart_id)
     values ($1, $2, 'stripe_card', $3, 0, 0, $3, 'jpy', $4::jsonb, $5::jsonb, $6, $7)
     returning id`,
    [
      cartSessionId,
      checkoutSessionId,
      totalAmount,
      JSON.stringify({
        email: 'fixture@example.com',
        fullName: '山田 花子',
        kanaName: options.kanaName === undefined ? 'ヤマダ ハナコ' : options.kanaName,
        postalCode: '1500001',
        prefecture: '東京都',
        city: '渋谷区',
        address: '神宮前1-1-1',
        building: null,
        phone: '0311112222',
      }),
      JSON.stringify(
        lines.map((line, index) => ({
          item_id: options.itemId,
          item_name: '照合テスト',
          item_price: PRICE,
          item_image_url: 'https://example.com/item.png',
          color: colorOf(line),
          size: sizeOf(line),
          quantity: line.quantity,
          line_total: PRICE * line.quantity,
          source_cart_line_id: lineIds[index],
        })),
      ),
      options.buyerUserId ?? null,
      cartId,
    ],
  );
  return {
    draftId: draft.rows[0].id as string,
    cartSessionId,
    checkoutSessionId,
    cartId,
    cartLineId: lineIds.find((id): id is string => id !== null) ?? null,
    totalAmount,
  };
}

/**
 * 在庫扱いの明細を1行持つ注文を直接作る。reserved = true なら台帳に確保（purchase）も入れる。
 * reserved = false は「種類の欄を足したときに既定値で stock になった古い明細」（R-41）を再現する。
 */
export async function insertOrderWithStockLine(
  db: PgClient,
  options: {
    status: string;
    itemId: number;
    variantId: number;
    quantity: number;
    reserved: boolean;
    checkoutSessionId?: string | null;
    paymentIntentId?: string | null;
    /** 宛先。配送先は後から書き換えられないので、作る時に決める（E2E が使う） */
    shippingEmail?: string;
  },
): Promise<{ orderId: string; orderItemId: string }> {
  const suffix = uniqueSuffix();
  // 配送先は法定の不変条件で後から書き換えられないので、発送できる形で最初から入れる。
  const order = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, payment_intent_id, status,
        subtotal_amount, shipping_amount, total_amount, currency,
        shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture,
        shipping_city, shipping_address, shipping_phone)
     values ($1, $2, $3, $4::public.order_status, $5, 0, $5, 'jpy',
             $6, '山田 花子', '1500001', '東京都', '渋谷区', '神宮前1-1-1', '0311112222')
     returning id`,
    [
      `fx-order-${suffix}`,
      options.checkoutSessionId === undefined ? `cs_fx_${suffix}` : options.checkoutSessionId,
      options.paymentIntentId ?? null,
      options.status,
      PRICE * options.quantity,
      options.shippingEmail ?? 'fixture@example.com',
    ],
  );
  const orderId = order.rows[0].id as string;
  const line = await db.query(
    `insert into public.order_items
       (order_id, item_id, item_name, item_price, quantity, line_total, variant_id, fulfillment_type)
     values ($1, $2, '照合テスト', $3, $4, $5, $6, 'stock')
     returning id`,
    [orderId, options.itemId, PRICE, options.quantity, PRICE * options.quantity, options.variantId],
  );
  const orderItemId = line.rows[0].id as string;
  if (options.reserved) {
    await db.query(
      `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
       values ($1, $2, 'purchase', $3, $4)`,
      [options.variantId, -options.quantity, orderId, orderItemId],
    );
  }
  return { orderId, orderItemId };
}

export async function movementsOf(db: PgClient, variantId: number): Promise<Array<{ delta: number; reason: string }>> {
  const res = await db.query(
    'select delta, reason from public.stock_movements where variant_id = $1 order by id',
    [variantId],
  );
  return res.rows.map((row) => ({ delta: Number(row.delta), reason: row.reason as string }));
}

export async function variantStock(db: PgClient, variantId: number): Promise<number> {
  const res = await db.query('select stock_quantity from public.item_variants where id = $1', [variantId]);
  return Number(res.rows[0].stock_quantity);
}

export async function orderRow(db: PgClient, orderId: string): Promise<Record<string, any>> {
  const res = await db.query(
    `select status::text as status, payment_intent_id, cancel_reason, cancel_note, cancel_notify_customer,
            review_reason, reviewed_at, reviewed_by, subtotal_amount, shipping_amount, total_amount, discount_amount,
            checkout_session_created_at
     from public.orders where id = $1`,
    [orderId],
  );
  return res.rows[0];
}

export async function revisionsOf(
  db: PgClient,
  orderId: string,
): Promise<Array<{ reason: string | null; sourceEventId: string | null; changedBy: string | null }>> {
  const res = await db.query(
    `select reason, source_event_id, changed_by from public.order_revisions where order_id = $1 order by id`,
    [orderId],
  );
  return res.rows.map((row) => ({
    reason: row.reason,
    sourceEventId: row.source_event_id,
    changedBy: row.changed_by,
  }));
}

export type FixtureLine = {
  itemId: number;
  variantId: number;
  quantity: number;
  fulfillmentType: 'stock' | 'backorder';
  /** 在庫の品で、台帳に確保（purchase）を入れるか。既定は入れる */
  reserved?: boolean;
  /** 単価。既定は PRICE（グループ E-2: 割引の割り振りの試験が、単価の違う商品を作る） */
  itemPrice?: number;
  /** 明細を登録した時刻（ISO）。既定は取引の時刻で、同じ注文の明細は全部同じ時刻になる（本物の注文と同じ） */
  createdAt?: string;
};

/**
 * 在庫の品と受注生産の品を混ぜた注文を直接作る（グループ E-1）。
 * shipped を渡すと、状態を発送済みにして発送の時刻・配送業者・伝票番号も入れる（移行の前に発送した注文を再現する）。
 * グループ E-2: 送料・割引・受け取った額・支払いの番号・返金済みの額も渡せる。合計は「小計 + 送料 − 割引」。
 * 受け取った額 orders.paid_amount は移行 A の列なので、移行 A を当てるまで、この道具は使えない。
 */
export async function insertOrderWithLines(
  db: PgClient,
  options: {
    status: string;
    lines: FixtureLine[];
    shippingEmail?: string;
    shipped?: { carrier: 'yamato' | 'sagawa' | 'japanpost' | null; trackingNumber: string | null };
    /** 送料（既定 0） */
    shippingAmount?: number;
    /** 割引（既定 0） */
    discountAmount?: number;
    /** お客様から受け取った額 orders.paid_amount（既定は空） */
    paidAmount?: number | null;
    /** 支払いの番号（既定は空） */
    paymentIntentId?: string | null;
    /** 返金済みの額 orders.refunded_amount（既定 0） */
    refundedAmount?: number;
  },
): Promise<{ orderId: string; orderItemIds: string[] }> {
  const suffix = uniqueSuffix();
  const priceOf = (line: FixtureLine) => line.itemPrice ?? PRICE;
  const shippingAmount = options.shippingAmount ?? 0;
  const discountAmount = options.discountAmount ?? 0;
  const subtotal = options.lines.reduce((sum, line) => sum + priceOf(line) * line.quantity, 0);
  const order = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, payment_intent_id, status,
        subtotal_amount, shipping_amount, discount_amount, total_amount, currency,
        paid_amount, refunded_amount, refunded_at,
        shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture,
        shipping_city, shipping_address, shipping_phone, shipped_at, shipping_carrier, tracking_number)
     values ($1, $2, $3, $4::public.order_status,
             $5, $6, $7, $8, 'jpy',
             $9, $10, case when $10::integer > 0 then now() else null end,
             $11, '山田 花子', '1500001', '東京都', '渋谷区', '神宮前1-1-1', '0311112222', $12, $13, $14)
     returning id`,
    [
      `fx-order-${suffix}`,
      `cs_fx_${suffix}`,
      options.paymentIntentId ?? null,
      options.status,
      subtotal,
      shippingAmount,
      discountAmount,
      subtotal + shippingAmount - discountAmount,
      options.paidAmount ?? null,
      options.refundedAmount ?? 0,
      options.shippingEmail ?? 'fixture@example.com',
      options.shipped ? new Date().toISOString() : null,
      options.shipped?.carrier ?? null,
      options.shipped?.trackingNumber ?? null,
    ],
  );
  const orderId = order.rows[0].id as string;
  const orderItemIds: string[] = [];
  for (const line of options.lines) {
    const price = priceOf(line);
    const inserted = await db.query(
      `insert into public.order_items
         (order_id, item_id, item_name, item_price, color, size, quantity, line_total, variant_id, fulfillment_type, created_at)
       values ($1, $2, '照合テスト', $3, 'BLACK', 'M', $4, $5, $6, $7, coalesce($8::timestamptz, now()))
       returning id`,
      [orderId, line.itemId, price, line.quantity, price * line.quantity, line.variantId, line.fulfillmentType, line.createdAt ?? null],
    );
    const orderItemId = inserted.rows[0].id as string;
    orderItemIds.push(orderItemId);
    if (line.fulfillmentType === 'stock' && (line.reserved ?? true)) {
      await db.query(
        `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
         values ($1, $2, 'purchase', $3, $4)`,
        [line.variantId, -line.quantity, orderId, orderItemId],
      );
    }
  }
  return { orderId, orderItemIds };
}

export type RefundFixtureStatus = 'awaiting_response' | 'error' | 'pending' | 'succeeded' | 'failed';

export type RefundFixtureLine = {
  orderItemId: string;
  quantity: number;
  /** 発送前の行か。既定は発送前 */
  beforeShipment?: boolean;
  /** 発送前の行の在庫の戻し方。既定は cancel。発送後の行は no_restock に決まっている */
  restockType?: 'cancel' | 'no_restock';
  /** 行の返金額。既定は 0 */
  amount?: number;
};

/**
 * 返金の記録と商品の行を直接書く（グループ E-2）。返金を始める関数（移行 B）を通さずに、数え方・守り・読み出しの試験が
 * 欲しい状態を作る。道は管理画面の返金（admin）に決まっていて、二重防止の番号と指紋は書き捨ての値を入れる。
 * 行は記録の後に1行ずつ書くので、数の守りのトリガーは行ごとに働く（数が合わない行は、ここで落ちる）。
 */
export async function insertRefundRecord(
  db: PgClient,
  options: {
    orderId: string;
    status?: RefundFixtureStatus;
    amount?: number;
    shippingAmount?: number;
    lines?: RefundFixtureLine[];
  },
): Promise<{ refundId: string }> {
  const refund = await db.query(
    `insert into public.order_refunds
       (order_id, source, request_key, request_fingerprint, status, amount, shipping_amount, notify_customer)
     values ($1, 'admin', gen_random_uuid(), 'fixture', $2, $3, $4, false)
     returning id`,
    [options.orderId, options.status ?? 'awaiting_response', options.amount ?? 1000, options.shippingAmount ?? 0],
  );
  const refundId = refund.rows[0].id as string;
  for (const line of options.lines ?? []) {
    const beforeShipment = line.beforeShipment ?? true;
    await db.query(
      `insert into public.order_refund_lines (refund_id, order_item_id, quantity, before_shipment, restock_type, amount)
       values ($1, $2, $3, $4, $5, $6)`,
      [refundId, line.orderItemId, line.quantity, beforeShipment, beforeShipment ? (line.restockType ?? 'cancel') : 'no_restock', line.amount ?? 0],
    );
  }
  return { refundId };
}
