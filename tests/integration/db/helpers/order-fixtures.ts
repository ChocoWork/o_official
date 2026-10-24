import { createHash } from 'crypto';
import type { PgClient } from './local-db';
import { seedGroupG1Allocation, seedGroupG1Shipment, withGroupG1FixtureTransaction } from './group-g1-fixtures';

/** DB 結合テストの試験データ。本計画の Task 3〜7・21 が使う。 */
export const PRICE = 5000;

export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** G-0 cleanup material has no allocation table; it keeps the bare ledger reservation. */
async function groupGPresent(db: PgClient): Promise<boolean> {
  return (await db.query("select to_regclass('public.order_item_allocations') is not null as present")).rows[0].present as boolean;
}

/** Legacy suites already own BEGIN. Take the common lock before this material's next write. */
async function lockGroupGFixture(db: PgClient): Promise<void> {
  if ((db as PgClient & { _txStatus?: string })._txStatus === 'T') {
    await db.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  }
}

/**
 * G-1 Task 14: the ledger trigger refuses a stock change without the common advisory. A plain restock row
 * (allocation_operation_id NULL, no FIFO) is written under it. Inside the caller's transaction the same key
 * is taken as a session lock only around the INSERT (inside a savepoint) and released at once, so the
 * material does not leave the caller holding the advisory (suites assert GROUP_G_INVENTORY_LOCK_REQUIRED
 * and lock waits afterwards). Outside a transaction, a one-statement transaction is opened.
 * The advisory is harmless on the G-0 cleanup schema.
 */
export async function insertRestockMovement(db: PgClient, variantId: number, quantity: number, note = 'fixture'): Promise<void> {
  await withLedgerLock(db, () => db.query(
    `insert into public.stock_movements (variant_id, delta, reason, note) values ($1, $2, 'restock', $3)`,
    [variantId, quantity, note],
  ));
}

/**
 * Runs one direct ledger write under the common advisory without leaving the caller holding it (see above).
 * A failing write is rolled back to its own savepoint and rethrown, so callers can still assert the refusal.
 */
export async function withLedgerLock<T>(db: PgClient, write: () => Promise<T>): Promise<T> {
  const status = (db as PgClient & { _txStatus?: string })._txStatus;
  if (status === 'T') {
    await db.query('savepoint g1_fixture_ledger');
    await db.query('select pg_catalog.pg_advisory_lock(190521,1)');
    try {
      const result = await write();
      await db.query('release savepoint g1_fixture_ledger');
      return result;
    } catch (error) {
      await db.query('rollback to savepoint g1_fixture_ledger');
      throw error;
    } finally {
      await db.query('select pg_catalog.pg_advisory_unlock(190521,1)');
    }
  }
  if (status !== 'I') throw new Error('GROUP_G_FIXTURE_TRANSACTION_STATE_REQUIRED');
  await db.query('begin');
  try {
    await db.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    const result = await write();
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

/**
 * G-1 reads count only A/H. A reserved stock line of a paid order is therefore one real allocation
 * with its purchase/-n movement (A); an unpaid order holds H. A shipped/closed order's reservation
 * is already consumed or released, so it keeps only the historical ledger row.
 */
async function reserveFixtureLine(
  db: PgClient, groupG: boolean,
  input: { orderId: string; orderItemId: string; variantId: number; quantity: number; status: string },
): Promise<void> {
  const kind = input.status === 'paid' ? 'paid'
    : ['pending', 'payment_in_progress', 'failed'].includes(input.status) ? 'payment_hold' : null;
  if (groupG && kind) {
    await seedGroupG1Allocation(db, { orderItemId: input.orderItemId, quantity: input.quantity, kind });
    return;
  }
  await withLedgerLock(db, () => db.query(
    `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
     values ($1, $2, 'purchase', $3, $4)`,
    [input.variantId, -input.quantity, input.orderId, input.orderItemId],
  ));
}

/** Suite-owned order material: the reserved stock line becomes A (paid/shipped) or H (unpaid). */
export async function reserveFixtureAllocation(
  db: PgClient, input: { orderId: string; orderItemId: string; variantId: number; quantity: number; status: string },
): Promise<void> {
  const groupG = await groupGPresent(db);
  if (groupG) await lockGroupGFixture(db);
  await reserveFixtureLine(db, groupG, input);
}

export type FixtureShipmentResult = {
  fulfillment_id: string;
  number: number;
  completes_order: boolean;
  order_status: string;
  replayed: false;
};

/**
 * Material for lines whose real allocating writer is converted in a later task (exchange lines,
 * backorder lines): only the missing paid A is added. A short free stock is first restocked, as the
 * made or returned unit arriving; existing A/H and the legacy ledger rows are left as they are.
 */
export async function ensureFixturePaidAllocation(
  db: PgClient,
  lines: Array<{ order_item_id: string; quantity: number }>,
): Promise<void> {
  await lockGroupGFixture(db);
  await withGroupG1FixtureTransaction(db, async () => {
    for (const line of lines) {
      const row = (await db.query(
        `select oi.variant_id, v.stock_quantity,
                coalesce((select sum(a.remaining_quantity) from public.order_item_allocations as a
                          where a.order_item_id = oi.id and a.kind = 'paid'), 0)::integer as paid
         from public.order_items as oi join public.item_variants as v on v.id = oi.variant_id
         where oi.id = $1`,
        [line.order_item_id],
      )).rows[0];
      const shortage = line.quantity - Number(row.paid);
      if (shortage <= 0) continue;
      // Backorder material: the made unit arrives, then is allocated to this line.
      if (Number(row.stock_quantity) < shortage) {
        await db.query(
          `insert into public.stock_movements (variant_id, delta, reason, note) values ($1, $2, 'restock', 'fixture')`,
          [row.variant_id, shortage - Number(row.stock_quantity)],
        );
      }
      await seedGroupG1Allocation(db, { orderItemId: line.order_item_id, quantity: shortage, kind: 'paid' });
    }
  });
}

/**
 * Reservation release material (the refund/cancel writers move to FIFO in Task 8): the ledger row,
 * the paid/held allocation decrease and its release event are one G-1 operation, followed by the
 * item-state history. Returns the ledger row id.
 */
export async function releaseFixtureAllocation(
  db: PgClient,
  input: { orderId: string; orderItemId: string; quantity: number; reason: 'refund' | 'cancel'; refundId?: string | null },
): Promise<string> {
  await lockGroupGFixture(db);
  return withGroupG1FixtureTransaction(db, async () => {
    const before = (await db.query('select private.capture_group_g_item_states($1) as states', [[input.orderId]])).rows[0].states;
    const op = (await db.query(`insert into private.group_g_operations
      (id,operation,request_key,fingerprint,cause_type,cause_id,result)
      values (gen_random_uuid(),'fixture_release',gen_random_uuid(),repeat('c',64),'order_item',$1::text,'{}') returning id`,
    [input.orderItemId])).rows[0].id as string;
    const allocation = (await db.query(`select id, variant_id from public.order_item_allocations
      where order_item_id = $1 and remaining_quantity >= $2 order by id desc limit 1`, [input.orderItemId, input.quantity])).rows[0];
    if (!allocation) throw new Error('GROUP_G_FIXTURE_ALLOCATION_REQUIRED');
    const movement = (await db.query(
      `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id, refund_id, allocation_operation_id)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [allocation.variant_id, input.quantity, input.reason, input.orderId, input.orderItemId, input.refundId ?? null, op],
    )).rows[0].id as string;
    await db.query(`update public.order_item_allocations
      set remaining_quantity = remaining_quantity - $2, version = version + 1, updated_at = now() where id = $1`,
    [allocation.id, input.quantity]);
    await db.query(`insert into public.order_item_allocation_events
      (allocation_id, event_type, quantity, operation_id, sequence, stock_movement_id, reason)
      values ($1, 'release', $2, $3, 1, $4, 'fixture_release')`, [allocation.id, input.quantity, op, movement]);
    await db.query('select private.record_group_g_item_state_changes($1,$2,$3,1,$4,$5)',
      [JSON.stringify(before), [input.orderId], op, 'fixture_release', null]);
    return String(movement);
  });
}

/**
 * For suites that write their own fulfillment rows (legacy/NULL-carrier or delivered material that
 * seedGroupG1Shipment cannot express): under the common lock, the shipped quantity's paid A is
 * consumed in one operation before `write` inserts the fulfillment lines, and the item-state history
 * is recorded afterwards, as one G-1 shipment.
 */
export async function withFixtureConsumption<T>(
  db: PgClient,
  input: { orderId: string; lines: Array<{ order_item_id: string; quantity: number }> },
  write: () => Promise<T>,
): Promise<T> {
  await lockGroupGFixture(db);
  return withGroupG1FixtureTransaction(db, async () => {
    await ensureFixturePaidAllocation(db, input.lines);
    const before = (await db.query('select private.capture_group_g_item_states($1) as states', [[input.orderId]])).rows[0].states;
    const op = (await db.query(`insert into private.group_g_operations
      (id,operation,request_key,fingerprint,cause_type,cause_id,result)
      values (gen_random_uuid(),'fixture_shipment',gen_random_uuid(),repeat('d',64),'order',$1::text,'{}') returning id`,
    [input.orderId])).rows[0].id as string;
    let sequence = 0;
    for (const line of [...input.lines].sort((a, b) => a.order_item_id.localeCompare(b.order_item_id))) {
      let remaining = line.quantity;
      const allocations = (await db.query(`select id, remaining_quantity from public.order_item_allocations
        where order_item_id = $1 and kind = 'paid' and remaining_quantity > 0 order by id`, [line.order_item_id])).rows;
      for (const allocation of allocations) {
        if (!remaining) break;
        const n = Math.min(remaining, Number(allocation.remaining_quantity));
        await db.query(`update public.order_item_allocations
          set remaining_quantity = remaining_quantity - $2, version = version + 1, updated_at = now() where id = $1`,
        [allocation.id, n]);
        await db.query(`insert into public.order_item_allocation_events
          (allocation_id, event_type, quantity, operation_id, sequence, reason)
          values ($1, 'consume', $2, $3, $4, 'fixture_shipment')`, [allocation.id, n, op, ++sequence]);
        remaining -= n;
      }
    }
    const result = await write();
    await db.query('select private.record_group_g_item_state_changes($1,$2,$3,1,$4,$5)',
      [JSON.stringify(before), [input.orderId], op, 'fixture_shipment', null]);
    return result;
  });
}

/**
 * Shipping material without the legacy RPC (stopped in Task 14). Under the common lock it tops up
 * paid A only where the line has none ready, consumes A through seedGroupG1Shipment, then keeps the
 * legacy RPC's visible side effects: confirmed event, tracking registration, order shipped on the
 * last unit and the shipped email when notifying.
 */
export async function shipFixtureOrder(
  db: PgClient,
  input: {
    orderId: string;
    actorId: string | null;
    lines: Array<{ order_item_id: string; quantity: number }>;
    carrier?: 'yamato' | 'sagawa' | 'japanpost';
    trackingNumber?: string;
    notifyCustomer?: boolean;
    requestKey?: string;
  },
): Promise<FixtureShipmentResult> {
  await lockGroupGFixture(db);
  return withGroupG1FixtureTransaction(db, async () => {
    const carrier = input.carrier ?? 'yamato';
    const trackingNumber = input.trackingNumber ?? '1234-5678-9012';
    await ensureFixturePaidAllocation(db, input.lines);
    const unshipped = Number((await db.query(
      'select coalesce(sum(unshipped), 0)::integer as n from private.order_line_fulfillment($1)', [input.orderId],
    )).rows[0].n);
    const requested = input.lines.reduce((sum, line) => sum + line.quantity, 0);
    const completes = unshipped - requested === 0;
    const shippedAt = (await db.query('select now() as t')).rows[0].t as Date;
    const fulfillmentId = await seedGroupG1Shipment(db, {
      orderId: input.orderId,
      lines: input.lines.map((line) => ({ orderItemId: line.order_item_id, quantity: line.quantity })),
      shippedAt: shippedAt.toISOString(),
      actorId: input.actorId ?? undefined,
      carrier,
      trackingNumber,
      notifyCustomer: input.notifyCustomer ?? false,
      requestKey: input.requestKey,
      completesOrder: completes,
    });
    await db.query(
      `insert into public.order_fulfillment_events (fulfillment_id, tracking_version, status, happened_at, source)
       values ($1, 1, 'confirmed', $2, 'shipment')`,
      [fulfillmentId, shippedAt],
    );
    await db.query(
      `insert into private.fulfillment_tracking_registrations (fulfillment_id, tracking_version, carrier, tracking_number, expires_at)
       select $1, 1, $2, upper($3), $4::timestamptz + interval '30 days'
       from public.shop_settings where id = 1 and delivery_tracking_enabled`,
      [fulfillmentId, carrier, trackingNumber, shippedAt],
    );
    if (completes) {
      if (input.actorId) await db.query("select set_config('app.order_actor_id', $1::text, true)", [input.actorId]);
      await db.query("select set_config('app.order_change_reason', 'admin_create_fulfillment', true)");
      await db.query(
        `update public.orders set status = 'shipped', shipped_at = now(), shipping_carrier = $2, tracking_number = $3
         where id = $1`,
        [input.orderId, carrier, trackingNumber],
      );
    }
    if (input.notifyCustomer) {
      await db.query("select private.enqueue_order_email($1, 'shipped', null, $2)", [input.orderId, fulfillmentId]);
    }
    const result = (await db.query(
      `select f.number, o.status::text as order_status from public.order_fulfillments as f
       join public.orders as o on o.id = f.order_id where f.id = $1`,
      [fulfillmentId],
    )).rows[0];
    return {
      fulfillment_id: fulfillmentId, number: Number(result.number), completes_order: completes,
      order_status: result.order_status, replayed: false,
    };
  });
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
    await insertRestockMovement(db, variantId, options.stock);
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
  const groupG = options.reserved && await groupGPresent(db);
  if (groupG) await lockGroupGFixture(db);
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
    await reserveFixtureLine(db, groupG, {
      orderId, orderItemId, variantId: options.variantId, quantity: options.quantity, status: options.status,
    });
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
  variantId: number | null;
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
    /** FIFO fixtures set the immutable order date at INSERT time. */
    createdAt?: string;
  },
): Promise<{ orderId: string; orderItemIds: string[] }> {
  const suffix = uniqueSuffix();
  const priceOf = (line: FixtureLine) => line.itemPrice ?? PRICE;
  const shippingAmount = options.shippingAmount ?? 0;
  const discountAmount = options.discountAmount ?? 0;
  const subtotal = options.lines.reduce((sum, line) => sum + priceOf(line) * line.quantity, 0);
  const reservedOf = (line: FixtureLine) => line.fulfillmentType === 'stock' && (line.reserved ?? true);
  const groupG = options.lines.some(reservedOf) && await groupGPresent(db);
  if (groupG) await lockGroupGFixture(db);
  const order = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, payment_intent_id, status,
        subtotal_amount, shipping_amount, discount_amount, total_amount, currency,
        paid_amount, refunded_amount, refunded_at,
        shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture,
        shipping_city, shipping_address, shipping_phone, shipped_at, shipping_carrier, tracking_number, created_at)
     values ($1, $2, $3, $4::public.order_status,
             $5, $6, $7, $8, 'jpy',
             $9, $10, case when $10::integer > 0 then now() else null end,
             $11, '山田 花子', '1500001', '東京都', '渋谷区', '神宮前1-1-1', '0311112222', $12, $13, $14, coalesce($15::timestamptz,now()))
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
      options.createdAt ?? null,
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
    if (reservedOf(line)) {
      await reserveFixtureLine(db, groupG, {
        orderId, orderItemId, variantId: line.variantId as number, quantity: line.quantity, status: options.status,
      });
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

export type ShippedOrderLine = {
  /** 注文の数 */
  quantity: number;
  /** 既定は在庫の品。受注生産の品は、発送の前に仕上がり（order_item_completions）を数の全部で記録する */
  fulfillmentType?: 'stock' | 'backorder';
  /** 単価。既定は PRICE */
  itemPrice?: number;
  /** 台帳の確保（purchase）とは別に、色・サイズの在庫へ足す数。既定は 0（確保した後の在庫は 0 になる） */
  extraStock?: number;
};

export type ShippedOrderShipment = {
  /** 送る商品。lineIndex は lines の番号（0 始まり） */
  lines: Array<{ lineIndex: number; quantity: number }>;
  /** 発送の時刻（ISO）。既定は取引の時刻。期限の試験が、日本時間の日の境目を作る */
  shippedAt?: string;
  /** true なら、記録した後で取り消した発送にする。取り消す発送も含めた合計が注文の数を超えないこと */
  cancelled?: boolean;
};

export type ShippedOrderFixture = {
  orderId: string;
  /** lines と同じ並び */
  orderItemIds: string[];
  itemIds: number[];
  variantIds: number[];
  /** shipments と同じ並び。発送の番号は 1 から */
  fulfillments: Array<{ id: string; number: number; lines: Array<{ orderItemId: string; quantity: number }> }>;
};

/**
 * 発送した品のある注文を直接作る（グループ E-3: 返品の試験の土台）。
 * 商品は lines の 1 行ごとに別の商品・色・サイズ（BLACK・M）を作る。在庫の品は台帳に確保（purchase）も入れる。
 * 発送は shipments の並びに番号 1, 2, … で書く（既定は全部を 1 回で送る）。
 * 取り消していない発送で全部送り終えていれば注文の状態は shipped、残りがあれば paid。
 * 受け取った額 orders.paid_amount は合計（商品の小計 + 送料 − 割引）と同じにし、支払いの番号も入れる。
 */
export async function createShippedOrderFixture(
  db: PgClient,
  options: {
    lines?: ShippedOrderLine[];
    shipments?: ShippedOrderShipment[];
    shippingAmount?: number;
    discountAmount?: number;
    createdAt?: string;
  } = {},
): Promise<ShippedOrderFixture> {
  // The cleanup suite deliberately builds its baseline on G-0, before these objects exist.
  const groupG = (await db.query("select to_regclass('public.order_item_allocations') is not null as present")).rows[0].present as boolean;
  // Legacy suites already own BEGIN. Acquire the common lock before this material's first write;
  // the strict nested helper below still verifies the lock and never commits the caller.
  if (groupG && (db as PgClient & { _txStatus?: string })._txStatus === 'T') {
    await db.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  }
  const run = async (): Promise<ShippedOrderFixture> => {
    const lines = options.lines ?? [{ quantity: 3 }];
    const shipments =
      options.shipments ?? [{ lines: lines.map((line, lineIndex) => ({ lineIndex, quantity: line.quantity })) }];
    const typeOf = (line: ShippedOrderLine) => line.fulfillmentType ?? 'stock';

    const itemIds: number[] = [];
    const variantIds: number[] = [];
    for (const line of lines) {
      const fx = await createCatalogFixture(db, {
        stock: (groupG || typeOf(line) === 'stock' ? line.quantity : 0) + (line.extraStock ?? 0),
      });
      itemIds.push(fx.itemId);
      variantIds.push(fx.variantId);
    }

    const shippedByLine = lines.map(() => 0);
    for (const shipment of shipments) {
      if (shipment.cancelled) continue;
      for (const shipped of shipment.lines) shippedByLine[shipped.lineIndex] += shipped.quantity;
    }
    const allShipped = lines.every((line, index) => shippedByLine[index] === line.quantity);

    const shippingAmount = options.shippingAmount ?? 0;
    const discountAmount = options.discountAmount ?? 0;
    const subtotal = lines.reduce((sum, line) => sum + (line.itemPrice ?? PRICE) * line.quantity, 0);
    const { orderId, orderItemIds } = await insertOrderWithLines(db, {
      status: allShipped ? 'shipped' : 'paid',
      shipped: allShipped ? { carrier: 'yamato', trackingNumber: '1234-5678-9012' } : undefined,
      shippingAmount,
      discountAmount,
      paidAmount: subtotal + shippingAmount - discountAmount,
      paymentIntentId: `pi_${uniqueSuffix()}`,
      createdAt: options.createdAt,
      lines: lines.map((line, index) => ({
        itemId: itemIds[index],
        variantId: variantIds[index],
        quantity: line.quantity,
        fulfillmentType: typeOf(line),
        itemPrice: line.itemPrice,
        reserved: !groupG,
      })),
    });

    if (groupG) {
      for (const [index, line] of lines.entries()) {
        await seedGroupG1Allocation(db, { orderItemId: orderItemIds[index], quantity: line.quantity, kind: 'paid' });
      }
    }

    // G-0 cleanup material keeps its original completion. G-1 derives preparation only from A.
    for (const [index, line] of lines.entries()) {
      if (!groupG && typeOf(line) === 'backorder') {
        await db.query(
          `insert into public.order_item_completions (order_id, order_item_id, quantity, request_key)
           values ($1, $2, $3, gen_random_uuid())`,
          [orderId, orderItemIds[index], line.quantity],
        );
      }
    }

    const fulfillments: ShippedOrderFixture['fulfillments'] = [];
    for (const [index, shipment] of shipments.entries()) {
      let id: string;
      if (groupG) id = await seedGroupG1Shipment(db, {
        orderId,
        lines: shipment.lines.map((line) => ({ orderItemId: orderItemIds[line.lineIndex], quantity: line.quantity })),
        shippedAt: shipment.shippedAt ?? new Date().toISOString(),
        cancelledAt: shipment.cancelled ? new Date().toISOString() : undefined,
        carrier: 'yamato', trackingNumber: '1234-5678-9012', notifyCustomer: false,
      });
      else {
        id = (await db.query(`insert into public.order_fulfillments
          (order_id,number,request_key,shipping_carrier,tracking_number,notify_customer,completes_order,shipped_at)
          values($1,$2,gen_random_uuid(),'yamato','1234-5678-9012',false,false,coalesce($3::timestamptz,now())) returning id`,
        [orderId, index + 1, shipment.shippedAt ?? null])).rows[0].id as string;
        for (const line of shipment.lines) await db.query(`insert into public.order_fulfillment_lines
          (fulfillment_id,order_item_id,quantity) values($1,$2,$3)`, [id, orderItemIds[line.lineIndex], line.quantity]);
        if (shipment.cancelled) await db.query('update public.order_fulfillments set cancelled_at=now() where id=$1', [id]);
      }
      fulfillments.push({
        id,
        number: index + 1,
        lines: shipment.lines.map((shipped) => ({ orderItemId: orderItemIds[shipped.lineIndex], quantity: shipped.quantity })),
      });
    }

    return { orderId, orderItemIds, itemIds, variantIds, fulfillments };
  };
  return groupG ? withGroupG1FixtureTransaction(db, run) : run();
}

/**
 * 同じ商品に、新しい色・サイズの色違い・サイズ違い（バリアント）を足す（交換の色・サイズの試験用）。
 * 色・サイズの名前は商品ごとに一意なので、既にある名前（BLACK・M）は渡さない。在庫は台帳の restock で入れる。
 */
export async function addItemVariant(
  db: PgClient,
  options: { itemId: number; colorName: string; sizeLabel: string; stock?: number; isActive?: boolean },
): Promise<{ variantId: number }> {
  const color = await db.query(
    `insert into public.item_colors (item_id, name, hex, position) values ($1, $2, '#112233', 1) returning id`,
    [options.itemId, options.colorName],
  );
  const size = await db.query(
    `insert into public.item_sizes (item_id, label, position) values ($1, $2, 1) returning id`,
    [options.itemId, options.sizeLabel],
  );
  const variant = await db.query(
    `insert into public.item_variants (item_id, color_id, size_id, is_active) values ($1, $2, $3, $4) returning id`,
    [options.itemId, color.rows[0].id, size.rows[0].id, options.isActive ?? true],
  );
  const variantId = Number(variant.rows[0].id);
  if ((options.stock ?? 0) > 0) {
    await insertRestockMovement(db, variantId, options.stock as number);
  }
  return { variantId };
}

export type ReturnFixtureStatus = 'requested' | 'open' | 'closed' | 'cancelled' | 'declined';

export type ReturnFixtureLine = {
  fulfillmentId: string;
  orderItemId: string;
  quantity: number;
  /** 既定は defective（破損・不良） */
  reason?: string;
  /** 作った時の予定の解決。既定は refund（返金） */
  resolution?: 'refund' | 'exchange';
  /** 解決が exchange の時の交換の色・サイズ（item_variants の番号）。exchange の時は必須 */
  exchangeVariantId?: number;
  /** 解決が exchange の時の送り方の予定。既定は stock（在庫から） */
  exchangeMethod?: 'stock' | 'make';
};

/**
 * 返品と返品の行を直接書く（グループ E-3）。返品を作る関数（移行 B）を通さずに、数え方・守り・読み出しの試験が
 * 欲しい状態を作る。番号は注文の中の次の番号。二重防止の番号は書き捨ての値、指紋は 'fixture'。
 * 道は status が requested・declined なら customer_request、ほかは shop。状態に合う時刻の列（requested_at・approved_at・
 * declined_at・closed_at・cancelled_at）も入れる。受け取りの記録は insertReturnReceipt で足す。
 */
export async function insertReturnRecord(
  db: PgClient,
  options: {
    orderId: string;
    lines: ReturnFixtureLine[];
    /** 既定は open（受付中） */
    status?: ReturnFixtureStatus;
    returnMethod?: 'customer_ships' | 'shop_label' | 'not_required';
    returnShippingPayer?: 'shop' | 'customer';
    returnShippingFee?: number;
    restockingFeePercent?: number;
    exchangeFee?: number;
    exchangeShippingFee?: number;
    /** 返金から引けずにお客様からいただく額（既定 0） */
    feeDueAmount?: number;
    notifyCustomer?: boolean;
  },
): Promise<{ returnId: string; number: number; lineIds: string[] }> {
  const status = options.status ?? 'open';
  const source = status === 'requested' || status === 'declined' ? 'customer_request' : 'shop';
  const next = await db.query(
    'select coalesce(max(number), 0) + 1 as next from public.order_returns where order_id = $1',
    [options.orderId],
  );
  const number = Number(next.rows[0].next);
  const created = await db.query(
    `insert into public.order_returns
       (order_id, number, source, status, request_key, request_fingerprint,
        requested_at, approved_at, declined_at, decline_reason, closed_at, cancelled_at,
        return_method, return_shipping_payer, return_shipping_fee, restocking_fee_percent,
        exchange_fee, exchange_shipping_fee, fee_due_amount, notify_customer)
     values ($1, $2, $3, $4, gen_random_uuid(), 'fixture',
             case when $3::text = 'customer_request' then now() end,
             case when $4::text in ('open', 'closed', 'cancelled') then now() end,
             case when $4::text = 'declined' then now() end,
             case when $4::text = 'declined' then 'other' end,
             case when $4::text = 'closed' then now() end,
             case when $4::text = 'cancelled' then now() end,
             $5, $6, $7, $8, $9, $10, $11, $12)
     returning id`,
    [
      options.orderId,
      number,
      source,
      status,
      options.returnMethod ?? 'customer_ships',
      options.returnShippingPayer ?? 'shop',
      options.returnShippingFee ?? 0,
      options.restockingFeePercent ?? 0,
      options.exchangeFee ?? 0,
      options.exchangeShippingFee ?? 0,
      options.feeDueAmount ?? 0,
      options.notifyCustomer ?? false,
    ],
  );
  const returnId = created.rows[0].id as string;
  const lineIds: string[] = [];
  for (const line of options.lines) {
    const resolution = line.resolution ?? 'refund';
    const inserted = await db.query(
      `insert into public.order_return_lines
         (return_id, fulfillment_id, order_item_id, quantity, reason, resolution, exchange_variant_id, exchange_method)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id`,
      [
        returnId,
        line.fulfillmentId,
        line.orderItemId,
        line.quantity,
        line.reason ?? 'defective',
        resolution,
        resolution === 'exchange' ? line.exchangeVariantId ?? null : null,
        resolution === 'exchange' ? line.exchangeMethod ?? 'stock' : null,
      ],
    );
    lineIds.push(inserted.rows[0].id as string);
  }
  return { returnId, number, lineIds };
}

export type ReturnReceiptDisposition =
  | 'restocked'
  | 'not_restocked'
  | 'pending_inspection'
  | 'inspected_restocked'
  | 'inspected_not_restocked'
  | 'sent_back'
  | 'missing'
  | 'missing_reopened'
  | 'refund_waived';

/**
 * 受け取りの記録と商品の扱いを直接書く（グループ E-3）。受け取りの関数（移行 C）を通さないので、在庫の台帳・
 * 返金・返品の状態は動かさない（試験が必要なら別に書く）。kind が receive の時だけ refundChoice が要る（既定 none）。
 * 二重防止の番号は書き捨ての値、指紋は 'fixture'。商品の扱いは、返品の行の番号と扱いと数で渡す。
 * 受け取った品（restocked・not_restocked・pending_inspection）の行には、その受け取りで実際に決まった解決を書く:
 * resolution を省くと、返品の行の予定の解決（交換なら送り方も）を使う。ほかの扱いには解決を書かない。
 */
export async function insertReturnReceipt(
  db: PgClient,
  options: {
    returnId: string;
    lines: Array<{
      returnLineId: string;
      disposition: ReturnReceiptDisposition;
      quantity: number;
      resolution?: 'refund' | 'exchange';
      exchangeMethod?: 'stock' | 'make';
    }>;
    /** 既定は receive */
    kind?: 'receive' | 'inspect' | 'close_missing' | 'reopen' | 'waive_refund';
    /** kind が receive の時の返金の選び方。既定は none。receive 以外では書かない */
    refundChoice?: 'now' | 'consult' | 'none';
    refundId?: string | null;
    notifyCustomer?: boolean;
    sentBackMessage?: string | null;
  },
): Promise<{ receiptId: string }> {
  const kind = options.kind ?? 'receive';
  const created = await db.query(
    `insert into public.order_return_receipts
       (return_id, request_key, request_fingerprint, kind, refund_choice, refund_id, notify_customer, sent_back_message)
     values ($1, gen_random_uuid(), 'fixture', $2, $3, $4, $5, $6)
     returning id`,
    [
      options.returnId,
      kind,
      kind === 'receive' ? options.refundChoice ?? 'none' : null,
      options.refundId ?? null,
      options.notifyCustomer ?? false,
      options.sentBackMessage ?? null,
    ],
  );
  const receiptId = created.rows[0].id as string;
  for (const line of options.lines) {
    const received =
      line.disposition === 'restocked' || line.disposition === 'not_restocked' || line.disposition === 'pending_inspection';
    let resolution: string | null = null;
    let exchangeMethod: string | null = null;
    if (received) {
      const planned = await db.query(
        'select resolution, exchange_method from public.order_return_lines where id = $1',
        [line.returnLineId],
      );
      resolution = line.resolution ?? (planned.rows[0].resolution as string);
      if (resolution === 'exchange') {
        exchangeMethod = line.exchangeMethod ?? (planned.rows[0].exchange_method as string | null) ?? 'stock';
      }
    }
    await db.query(
      `insert into public.order_return_receipt_lines (receipt_id, return_line_id, disposition, quantity, resolution, exchange_method)
       values ($1, $2, $3, $4, $5, $6)`,
      [receiptId, line.returnLineId, line.disposition, line.quantity, resolution, exchangeMethod],
    );
  }
  return { receiptId };
}

/**
 * 返品の返金（道 return）の記録と商品の行を直接書く（グループ E-3）。商品の行は発送後の行で、在庫の戻し方は return。
 * 返金を始める関数（移行 C）を通さずに、返品の返金で覆われた数の試験が欲しい状態を作る。
 * 二重防止の番号は書き捨ての値、指紋は 'fixture'。行は記録の後に 1 行ずつ書くので、数の守りのトリガーは行ごとに働く。
 */
export async function insertReturnRefund(
  db: PgClient,
  options: {
    orderId: string;
    returnId: string;
    lines: Array<{ orderItemId: string; quantity: number; amount?: number }>;
    /** 既定は pending（保留） */
    status?: RefundFixtureStatus;
    amount?: number;
  },
): Promise<{ refundId: string }> {
  const refund = await db.query(
    `insert into public.order_refunds
       (order_id, source, return_id, request_key, request_fingerprint, status, amount, notify_customer)
     values ($1, 'return', $2, gen_random_uuid(), 'fixture', $3, $4, false)
     returning id`,
    [options.orderId, options.returnId, options.status ?? 'pending', options.amount ?? 1000],
  );
  const refundId = refund.rows[0].id as string;
  for (const line of options.lines) {
    await db.query(
      `insert into public.order_refund_lines (refund_id, order_item_id, quantity, before_shipment, restock_type, amount)
       values ($1, $2, $3, false, 'return', $4)`,
      [refundId, line.orderItemId, line.quantity, line.amount ?? 0],
    );
  }
  return { refundId };
}

/**
 * 写真の送り先を直接書く（グループ E-3 段 2）。送り先を出す関数（移行 E）を通さずに、写真・申し込み・消す処理の試験が
 * 欲しい状態を作る。場所は requests/{注文の番号}/{送り先の番号}（送り先の番号は DB が作る）。
 * お客様の番号を省くと書き捨ての値。時刻を省くと取引の時刻。消す処理の試験が「1 日より前に出した送り先」を作る時は、
 * createdAt に昔の時刻（ISO）を渡す。attachedAt・purgedAt を渡すと、使い済み・消し済みの送り先として書く。
 */
export async function insertReturnPhotoUpload(
  db: PgClient,
  options: {
    orderId: string;
    customerId?: string;
    createdAt?: string;
    attachedAt?: string | null;
    purgedAt?: string | null;
  },
): Promise<{ uploadId: string; storagePath: string; customerId: string }> {
  const created = await db.query(
    `with picked as (select pg_catalog.gen_random_uuid() as id)
     insert into public.order_return_photo_uploads (id, order_id, customer_id, storage_path, created_at, attached_at, purged_at)
     select picked.id, $1::uuid, coalesce($2::uuid, pg_catalog.gen_random_uuid()),
            'requests/' || $1::uuid::text || '/' || picked.id::text,
            coalesce($3::timestamptz, now()), $4::timestamptz, $5::timestamptz
     from picked
     returning id, storage_path, customer_id`,
    [options.orderId, options.customerId ?? null, options.createdAt ?? null, options.attachedAt ?? null, options.purgedAt ?? null],
  );
  return {
    uploadId: created.rows[0].id as string,
    storagePath: created.rows[0].storage_path as string,
    customerId: created.rows[0].customer_id as string,
  };
}

/**
 * 申し込みに付いた写真を直接書く（グループ E-3 段 2）。送り先（使い済み）と写真の行を 1 組で作る。
 * 申し込みの関数（移行 E）を通さずに、写真の一覧・消す処理の試験が欲しい状態を作る。
 * uploadCreatedAt は送り先を出した時刻、createdAt は写真の行を作った（送り先を使った）時刻で、省くと取引の時刻。
 * purgedAt を渡すと、写真と送り先の両方を消し済みにする。
 */
export async function insertReturnPhoto(
  db: PgClient,
  options: {
    returnLineId: string;
    orderId: string;
    customerId?: string;
    contentType?: 'image/jpeg' | 'image/png';
    sizeBytes?: number;
    uploadCreatedAt?: string;
    createdAt?: string;
    purgedAt?: string | null;
  },
): Promise<{ photoId: string; uploadId: string; storagePath: string }> {
  const upload = await insertReturnPhotoUpload(db, {
    orderId: options.orderId,
    customerId: options.customerId,
    createdAt: options.uploadCreatedAt,
  });
  await db.query(
    `update public.order_return_photo_uploads
     set attached_at = coalesce($2::timestamptz, now()), purged_at = $3::timestamptz
     where id = $1`,
    [upload.uploadId, options.createdAt ?? null, options.purgedAt ?? null],
  );
  const photo = await db.query(
    `insert into public.order_return_photos (return_line_id, upload_id, storage_path, content_type, size_bytes, created_at, purged_at)
     values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7::timestamptz)
     returning id`,
    [
      options.returnLineId,
      upload.uploadId,
      upload.storagePath,
      options.contentType ?? 'image/jpeg',
      options.sizeBytes ?? 1000,
      options.createdAt ?? null,
      options.purgedAt ?? null,
    ],
  );
  return { photoId: photo.rows[0].id as string, uploadId: upload.uploadId, storagePath: upload.storagePath };
}

export type CancelRequestFixtureStatus = 'requested' | 'resolved' | 'declined' | 'closed';

/**
 * キャンセルの申し込みと行を直接書く（グループ E-3 段 2）。申し込みの関数（移行 E）を通さずに、守り・読み出し・お断りと
 * 解決の試験が欲しい状態を作る。二重防止の番号は書き捨ての値、指紋は 'fixture'。
 * 状態に合う列（お断りの理由とメッセージ・時刻、解決の時刻、解決済みの時刻）も入れて、表の CHECK を通す。
 * status が resolved の時は、resolvedRefundId があれば「その返金で解決」、なければ「注文の取消で解決」にする。
 * 開いている（requested の）申し込みは注文に 1 つだけなので、同じ注文に requested を 2 つは書けない。
 */
export async function insertCancelRequest(
  db: PgClient,
  options: {
    orderId: string;
    lines: Array<{ orderItemId: string; quantity: number }>;
    /** 既定は requested */
    status?: CancelRequestFixtureStatus;
    customerId?: string;
    customerNote?: string | null;
    /** 申し込んだ時刻（ISO）。省くと取引の時刻 */
    requestedAt?: string;
    resolvedRefundId?: string;
  },
): Promise<{ cancelRequestId: string; lineIds: string[]; customerId: string }> {
  const created = await db.query(
    `with picked as (select coalesce($6::uuid, pg_catalog.gen_random_uuid()) as customer_id)
     insert into public.order_cancel_requests
       (order_id, status, request_key, request_fingerprint, customer_note, requested_at, requested_by,
        decline_reason, decline_message, declined_at, declined_by,
        resolved_at, resolved_by, resolved_refund_id, resolved_by_cancel_at,
        closed_at, closed_by)
     select $1::uuid, $2::text, pg_catalog.gen_random_uuid(), 'fixture', $3::text, coalesce($4::timestamptz, now()), picked.customer_id,
            case when $2::text = 'declined' then 'other' end,
            case when $2::text = 'declined' then 'お断りの文' end,
            case when $2::text = 'declined' then now() end,
            case when $2::text = 'declined' then pg_catalog.gen_random_uuid() end,
            case when $2::text = 'resolved' then now() end,
            case when $2::text = 'resolved' then pg_catalog.gen_random_uuid() end,
            case when $2::text = 'resolved' then $5::uuid end,
            case when $2::text = 'resolved' and $5::uuid is null then now() end,
            case when $2::text = 'closed' then now() end,
            case when $2::text = 'closed' then pg_catalog.gen_random_uuid() end
     from picked
     returning id, requested_by`,
    [
      options.orderId,
      options.status ?? 'requested',
      options.customerNote ?? null,
      options.requestedAt ?? null,
      options.resolvedRefundId ?? null,
      options.customerId ?? null,
    ],
  );
  const cancelRequestId = created.rows[0].id as string;
  const lineIds: string[] = [];
  for (const line of options.lines) {
    const inserted = await db.query(
      'insert into public.order_cancel_request_lines (cancel_request_id, order_item_id, quantity) values ($1, $2, $3) returning id',
      [cancelRequestId, line.orderItemId, line.quantity],
    );
    lineIds.push(inserted.rows[0].id as string);
  }
  return { cancelRequestId, lineIds, customerId: created.rows[0].requested_by as string };
}
