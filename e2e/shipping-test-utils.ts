/**
 * 荷作り表・発送票・同梱の発送メール（グループ G-3）の E2E の道具。FR-ADMIN-116・120・123 が使う。
 *
 * 画面 → 窓口の差し替え（bridge）→ 手元の DB の公開関数、の道で確かめる。本物の窓口（route）は通らない。
 * 本物の管理者のログインには2段階認証が要るので、画面が呼ぶ窓口（/api/admin/packing・/api/admin/shipment-slips**・注文の履歴）を、
 * 同じ DB の公開関数（service_role 専用）へ手元の DB の接続から橋渡しする。
 * - bridge は権限を決めない。実行者（actorId）を `_actor_id` で渡すだけで、許否は DB の関数が決める（読みも同じ）。
 *   窓口が返す「操作の権限があるか（canManage）」「出荷日を訂正できるか（canCorrectDate）」は、窓口が認可の結果から作る表示用の値なので、
 *   bridge は実行者の有効な役割の権限を DB の表から読んで同じ組（窓口と同じ4つ・3つ）で作る。許否そのものには使わない。
 * - DB の誤りは、窓口の store と同じ表（SHIPMENT_SLIP_ERRORS。import した物で、写していない）で HTTP の状態と本文にする。
 * - 窓口の認可・MFA・CSRF・回数の制限・操作の監査は bridge の範囲の外。本物の窓口の 401/403 は FR-ADMIN-123 の G-3 の節、
 *   窓口の流れは各 route の単体、DB の権限は G-3 の DB 結合が確かめる（bridge の下では DB の関数の権限の確かめを確かめる）。
 * - bridge は本物の窓口より緩い。次の差があるので、後の試験は検証や履歴の権限を bridge に頼らない:
 *   (a) 本文の zod 検証をしない（本物の窓口は不正な uuid・重複行・範囲外の数量を 400 `Invalid request` にするが、bridge は DB の関数へそのまま渡す）。試験は正しい本文だけを送る。
 *   (b) store の整合の検査をしない（読取の頁の total と行の重複の確かめ、書込みの答えの id が頼んだ票と同じかの確かめ）。答えの形は同じ pure な parse* だけ通す。
 *   (c) limit・page を Number() で読む（本物の窓口は readShipmentSlipQueryInteger で範囲外を 400 にする）。
 *   (d) 注文の履歴の本体（bridgeHistory）は実行者の権限を確かめずに読む（G-1 の bridge から同じ）。票への結び付きだけが `_actor_id` を通る。
 *
 * 荷作り表の並びと出る/出ないの確かめは、画面の頁を歩かず readPackingSnapshot（一時点の1回の読み取り）で行う（他の試験が行を足したり閉じたりする最中でも崩れない）。
 *
 * 権限の表と役割は手元の DB の共有の状態。権限を付け外ししない試験は、その鍵（190520, 0）を共有（pg_advisory_lock_shared）で持ち、
 * 権限を付け外しする試験（changesPermissions）だけが withPermissionScenario（排他の鍵と差分の復元）を使う。
 * 発送票・発送・割当は追記専用で消せない。試験ごとに新しい商品（createCatalogMaterial）・新しい利用者・新しい注文で作って干渉させず、
 * 終わりに、作った下書きは破棄し、発送されずに残った準備中の品は合成の発送（票を持たない）で閉じる（荷作り表に溜めない）。
 *
 * 注意: 試験の材料づくりと bridge は DB の接続を1本で共有する。材料の取引（withGroupG1Material の BEGIN/SAVEPOINT）の最中に
 * 画面の要求が bridge へ届くと、同じ取引に混ざる。材料を書く時は、画面の要求が止まっている間（描画の待ちが済んだ後）に書く。
 */
import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { ROLE_PERMISSION_CATALOG } from '@/lib/auth/role-permission-catalog';
import {
  parsePackingRow,
  parseShipmentSlipCancelled,
  parseShipmentSlipConfirmed,
  parseShipmentSlipDateCorrected,
  parseShipmentSlipDelivered,
  parseShipmentSlipDetail,
  parseShipmentSlipLink,
  parseShipmentSlipListRow,
  parseShipmentSlipSaved,
  parseShipmentSlipTrackingUpdated,
  SHIPMENT_SLIP_ERRORS,
  SHIPMENT_SLIP_LIMITS,
  SHIPMENT_SLIP_TEXT,
  type PackingRow,
  type ShipmentSlipConfirmed,
  type ShipmentSlipDetail,
  type ShipmentSlipLink,
} from '@/lib/orders/shipment-slips/shipment-slip-types';
import type { ShippingCarrierId } from '@/lib/orders/shipping-carriers';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import {
  bridgeHistory,
  callSlipDb,
  confirmSlipInDb,
  readOutbox,
  saveSlipDraftInDb,
} from './delivery-tracking-test-utils';
import {
  allocationKindOf,
  assertLocalE2eDb,
  lockE2eInventory,
  seedE2eAllocation,
  seedE2eRestock,
  seedE2eShipment,
  withGroupG1Material,
} from './group-g1-test-utils';
import { uniqueEmail, withLocalDb } from './order-email-test-utils';
import { orderNumberOf } from './order-fulfillment-test-utils';
import { createPermissionActor, withPermissionScenario } from './permission-settings-test-utils';
import { createCatalogMaterial, type CatalogMaterial } from './purchasing-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';

export {
  adjustStock,
  contentAlerts,
  createCatalogMaterial,
  expectNoPageOverflow,
  jstToday,
  materialLabel,
  paidAllocationOf,
  variantInventory,
  type CatalogMaterial,
} from './purchasing-test-utils';
export { confirmSlipInDb, readOutbox };

// ---------------------------------------------------------------------------------------------------------------------
// 試験の場面
// ---------------------------------------------------------------------------------------------------------------------

export type ShippingContext = {
  client: PgClient;
  /** 試験の実行者（役割 admin。初期値で荷作り・発送・出荷日の訂正を含む全部の権限を持つ） */
  actorId: string;
  /** 作った注文を、終わりに残りの準備中の品を閉じる対象に足す（createShippingMaterial が作った注文は自動で足される） */
  trackOrder: (orderId: string) => void;
  /** 作った票を、終わりに下書きなら破棄する対象に足す（bridge が作った票は自動で足される） */
  trackSlip: (slipId: string) => void;
};

type Tracking = { orders: Set<string>; slips: Set<string> };
const trackingByClient = new WeakMap<PgClient, Tracking>();

function trackingOf(client: PgClient): Tracking {
  let tracking = trackingByClient.get(client);
  if (!tracking) {
    tracking = { orders: new Set(), slips: new Set() };
    trackingByClient.set(client, tracking);
  }
  return tracking;
}

/**
 * 荷作り・発送票の試験の場面。手元の DB の接続1本と、役割 admin の実行者を用意し、終わりに後始末をする。
 * 既定は、権限の鍵（190520, 0）を共有で持つ（権限を付け外しする試験が排他で動く間は待ち、権限を変えない試験どうしは待ち合わない）。
 * 権限を付け外しする試験は changesPermissions を付ける: withPermissionScenario（排他の鍵と、終わりの差分の復元）の上で動く。
 */
export async function withShippingScenario(
  run: (ctx: ShippingContext) => Promise<void>,
  options: { changesPermissions?: boolean } = {},
): Promise<void> {
  const body = async (client: PgClient): Promise<void> => {
    assertLocalE2eDb(client);
    const actorId = await createPermissionActor(client, 'admin');
    const tracking = trackingOf(client);
    const ctx: ShippingContext = {
      client,
      actorId,
      trackOrder: (id) => { tracking.orders.add(id); },
      trackSlip: (id) => { tracking.slips.add(id); },
    };
    try {
      await run(ctx);
    } finally {
      await closeTracked(client, actorId);
    }
  };
  if (options.changesPermissions) {
    await withPermissionScenario(body);
    return;
  }
  await withLocalDb(async (client) => {
    await client.query('select pg_catalog.pg_advisory_lock_shared(190520, 0)');
    try {
      await body(client);
    } finally {
      await client.query('select pg_catalog.pg_advisory_unlock_shared(190520, 0)');
    }
  });
}

/** 作った下書きを破棄し、発送されずに残った準備中の品を合成の発送で閉じる。終わりの後始末なので、失敗は握りつぶす */
async function closeTracked(client: PgClient, actorId: string): Promise<void> {
  const tracking = trackingOf(client);
  await client.query('rollback').catch(() => undefined);
  for (const slipId of tracking.slips) {
    try {
      const detail = await readSlip(client, actorId, slipId);
      if (detail.stage !== 'draft') continue;
      await callSlipDb(client, 'admin_discard_shipment_slip_draft', [
        ['_slip_id', slipId, 'uuid'], ['_expected_version', detail.version, 'integer'],
        ['_actor_id', actorId, 'uuid'], ['_request_key', randomUUID(), 'uuid'],
      ]);
    } catch {
      // 後始末の失敗は試験の結果にしない
    }
  }
  for (const orderId of tracking.orders) {
    try {
      await shipLeftover(client, orderId);
    } catch {
      await client.query('rollback').catch(() => undefined);
    }
  }
  tracking.slips.clear();
  tracking.orders.clear();
}

/** 入金済みの注文の、まだ送っていない準備中の品を、合成の発送（票を持たない）で全部送った形にする */
async function shipLeftover(client: PgClient, orderId: string): Promise<void> {
  const status = (await client.query('select status::text as status from public.orders where id = $1::uuid', [orderId])).rows[0]?.status;
  if (status !== 'paid') return;
  const lines = (
    await client.query('select order_item_id, ready_unshipped from public.list_order_line_fulfillment(array[$1::uuid])', [orderId])
  ).rows
    .filter((row) => Number(row.ready_unshipped) > 0)
    .map((row) => ({ orderItemId: row.order_item_id as string, quantity: Number(row.ready_unshipped) }));
  if (lines.length === 0) return;
  await seedE2eShipment(client, {
    orderId,
    lines,
    shippedAt: new Date().toISOString(),
    trackingNumber: `E2E-CLEANUP-${randomUUID().slice(0, 8).toUpperCase()}`,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// 材料: 注文・利用者
// ---------------------------------------------------------------------------------------------------------------------

export type ShipTo = {
  fullName: string;
  postalCode: string;
  prefecture: string;
  city: string;
  address: string;
  building: string | null;
  phone: string;
};

/** 既定の配送先。同じお客様の注文を同梱する試験は、この既定のまま（7項目が完全一致）にする */
export const DEFAULT_SHIP_TO: ShipTo = {
  fullName: '山田 花子',
  postalCode: '1500001',
  prefecture: '東京都',
  city: '渋谷区',
  address: '神宮前1-1-1',
  building: null,
  phone: '0311112222',
};

export type ShippingCustomer = { kind: 'guest'; email?: string } | { kind: 'member'; userId: string; email?: string };

export type ShippingMaterialInput = {
  /** 省くと、ゲスト（試験ごとの新しいメールアドレス） */
  customer?: ShippingCustomer;
  /** 同じ商品を使う時に渡す。省くと新しい商品 */
  catalog?: CatalogMaterial;
  /** 数量。既定 3 */
  quantity?: number;
  /** 入金済みの割当（A）の数。既定は数量ぜんぶ。0 は受注生産の待ち（fulfillmentType: 'backorder'）のために使う */
  allocated?: number;
  /** 既定 stock。backorder は割当を作らない待ち */
  fulfillmentType?: 'stock' | 'backorder';
  /** 既定 paid。pending は未払い（支払い前の仮確保 H を作る） */
  status?: 'paid' | 'pending';
  /** 注文日（ISO）。注文日は後から変えられないので作る時に決める。省くと今 */
  orderedAt?: string;
  /** 注文日を今から何日前にするか（orderedAt より後に決まる）。1つの試験で古い注文と新しい注文を並べる時に使う */
  orderedDaysAgo?: number;
  /** 入金日時（ISO）。省くと注文日時と同じ。null は入金日時なし（paid_at_missing） */
  paidAt?: string | null;
  /** 配送先（省いた項目は DEFAULT_SHIP_TO） */
  shipTo?: Partial<ShipTo>;
  /** 決済の番号。返品・発送後の返金を作る試験（FR-ADMIN-117 ⑤）だけが渡す。省くと空（従来どおり） */
  paymentIntentId?: string;
};

export type ShippingMaterial = {
  orderId: string;
  orderItemId: string;
  /** 画面の注文ID（ORD-XXXXXXXX） */
  orderNumber: string;
  email: string;
  userId: string | null;
  shipTo: ShipTo;
  itemId: number;
  variantId: number;
  itemName: string;
  colorName: string;
  sizeLabel: string;
  /** 荷作り表・票の画面の呼び名（商品名 色 サイズ。選択欄の名前に使う） */
  label: string;
  quantity: number;
  allocated: number;
  /** 注文日（DB が持つ値の ISO） */
  orderedAt: string;
  unitPrice: number;
};

export const UNIT_PRICE = 5000;

/** お客様の利用者（auth.users の行）。会員の注文の持ち主にする。ログインはしない（ログインが要る試験は loginCustomer を使う） */
export async function createMemberUser(client: PgClient, label = 'g3'): Promise<{ userId: string; email: string }> {
  assertLocalE2eDb(client);
  const id = randomUUID();
  const email = uniqueEmail(`${label}-member`);
  await client.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values ($1::uuid, $2, '{}'::jsonb, now(), now())`,
    [id, email],
  );
  return { userId: id, email };
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * 荷作り表に出る注文（入金済み・配送先あり・入金日時あり・割当済み）を作る。入力で、会員/ゲスト・古い注文日・配送先・入金日・割当を変えられる。
 * 注文・明細・割当は1つの G-1 の取引（本物の入荷の入口 → 色・サイズを押さえる → 注文と明細 → 割当）で作る。
 * 作った注文は、終わりの後始末の対象に自動で足す。
 */
export async function createShippingMaterial(client: PgClient, input: ShippingMaterialInput = {}): Promise<ShippingMaterial> {
  assertLocalE2eDb(client);
  const quantity = input.quantity ?? 3;
  const fulfillmentType = input.fulfillmentType ?? 'stock';
  const status = input.status ?? 'paid';
  const allocated = fulfillmentType === 'backorder' ? 0 : (input.allocated ?? quantity);
  const catalog = input.catalog ?? (await createCatalogMaterial(client));
  const customer: ShippingCustomer = input.customer ?? { kind: 'guest' };
  const email = customer.email ?? uniqueEmail('g3');
  const userId = customer.kind === 'member' ? customer.userId : null;
  const shipTo: ShipTo = { ...DEFAULT_SHIP_TO, ...input.shipTo };
  const orderedAt = input.orderedDaysAgo !== undefined ? daysAgoIso(input.orderedDaysAgo) : (input.orderedAt ?? null);
  // 入金日時は、未払いか null の指定なら空。それ以外は指定の日時、無ければ注文日時（注文日時も無ければ作る時の今）
  const noPaidAt = status === 'pending' || input.paidAt === null;
  const paidAt = input.paidAt ?? null;
  const total = UNIT_PRICE * quantity;

  const created = await withGroupG1Material(client, async () => {
    // 在庫は本物の入荷の入口で入れる（割当が引く分）。色・サイズを押さえてから注文を作る
    if (allocated > 0) await seedE2eRestock(client, { itemId: catalog.itemId, variantId: catalog.variantId, quantity: allocated });
    await lockE2eInventory(client, { variantIds: [catalog.variantId] });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
    const order = (
      await client.query(
        `insert into public.orders
           (session_id, checkout_session_id, status, subtotal_amount, shipping_amount, discount_amount, total_amount, paid_amount, paid_at, currency,
            shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_building,
            shipping_phone, user_id, created_at, payment_intent_id)
         values ($1, $2, $3::public.order_status, $4, 0, 0, $4, $5,
                 case when $17::boolean then null else coalesce($6::timestamptz, $16::timestamptz, now()) end, 'jpy',
                 $7, $8, $9, $10, $11, $12, $13, $14, $15, coalesce($16::timestamptz, now()), $18)
         returning id, created_at`,
        [
          `e2e-g3-${suffix}`, `cs_e2e_g3_${suffix}`, status, total, status === 'paid' ? total : null, paidAt,
          email, shipTo.fullName, shipTo.postalCode, shipTo.prefecture, shipTo.city, shipTo.address, shipTo.building,
          shipTo.phone, userId, orderedAt, noPaidAt, input.paymentIntentId ?? null,
        ],
      )
    ).rows[0] as { id: string; created_at: Date };
    const item = (
      await client.query(
        `insert into public.order_items
           (order_id, item_id, item_name, item_price, color, size, quantity, line_total, variant_id, fulfillment_type)
         values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [order.id, catalog.itemId, catalog.itemName, UNIT_PRICE, catalog.colorName, catalog.sizeLabel, quantity, total, catalog.variantId, fulfillmentType],
      )
    ).rows[0] as { id: string };
    if (allocated > 0) await seedE2eAllocation(client, { orderItemId: item.id, quantity: allocated, kind: allocationKindOf(status) });
    return { orderId: order.id, orderItemId: item.id, orderedAt: order.created_at.toISOString() };
  });

  trackingOf(client).orders.add(created.orderId);
  return {
    orderId: created.orderId,
    orderItemId: created.orderItemId,
    orderNumber: orderNumberOf(created.orderId),
    email,
    userId,
    shipTo,
    itemId: catalog.itemId,
    variantId: catalog.variantId,
    itemName: catalog.itemName,
    colorName: catalog.colorName,
    sizeLabel: catalog.sizeLabel,
    label: `${catalog.itemName} ${catalog.colorName} ${catalog.sizeLabel}`,
    quantity,
    allocated,
    orderedAt: created.orderedAt,
    unitPrice: UNIT_PRICE,
  };
}

/** 支払額の確認（payment_review）の止めを、本物の入口で付ける（その注文の全部の品が選べなくなる） */
export async function holdPaymentReview(client: PgClient, orderId: string): Promise<void> {
  assertLocalE2eDb(client);
  await withGroupG1Material(client, async () => {
    await lockE2eInventory(client, { orderIds: [orderId] });
    await client.query("select private.ensure_group_g_payment_review_hold($1, 'e2e-g3', null, null, null)", [orderId]);
  });
}

export type ExchangeFeeMaterial = {
  /** 元の注文（品は1点発送した形。残りは準備中） */
  base: ShippingMaterial;
  exchangeOrderItemId: string;
  /** 交換の品の名前（元の商品名と重ならない） */
  exchangeName: string;
  /** 交換の品の呼び名（商品名 色 サイズ） */
  exchangeLabel: string;
};

/**
 * 合成状態: 割当済みの交換品が exchange_fee_waiting を持ち、荷作り表で選べず下書きも EXCHANGE_ON_HOLD で断られる注文。
 * 元の品を1点発送した形にして返品（交換）を作り、手数料（100円）を未払いにしたまま、交換品に入金済みの割当を付ける。
 * 実際には「相談」で受け取って交換品に割当が付いた後、手数料より少ない返金で手数料待ちになった時などに起きる（G-1 移行の受取・返金の処理）。
 * 普通の流れの未割当で受注生産中となり荷作り表に出ない手数料待ちは FR-ADMIN-118 ④で確かめる。
 */
export async function createExchangeFeeMaterial(
  client: PgClient,
  actorId: string,
  input: ShippingMaterialInput = {},
): Promise<ExchangeFeeMaterial> {
  const base = await createShippingMaterial(client, { quantity: 3, ...input });
  const exchangeName = `E2E交換-${randomUUID().slice(0, 8)}`;
  const exchangeOrderItemId = await withGroupG1Material(client, async () => {
    await seedE2eRestock(client, { itemId: base.itemId, variantId: base.variantId, quantity: 1 });
    await lockE2eInventory(client, { variantIds: [base.variantId], orderIds: [base.orderId] });
    const fulfillmentId = await seedE2eShipment(client, {
      orderId: base.orderId,
      lines: [{ orderItemId: base.orderItemId, quantity: 1 }],
      shippedAt: new Date().toISOString(),
      actorId,
      trackingNumber: `E2E-EXCHANGE-${randomUUID().slice(0, 8).toUpperCase()}`,
    });
    const returnId = (
      await client.query(
        `insert into public.order_returns
           (order_id, number, source, status, request_key, request_fingerprint, return_method, return_shipping_payer, notify_customer)
         values ($1::uuid, 1, 'customer_request', 'open', $2, 'e2e-g3', 'customer_ships', 'customer', false) returning id`,
        [base.orderId, randomUUID()],
      )
    ).rows[0].id as string;
    const lineId = (
      await client.query(
        `insert into public.order_return_lines
           (return_id, fulfillment_id, order_item_id, quantity, reason, resolution, exchange_variant_id, exchange_method)
         values ($1::uuid, $2::uuid, $3::uuid, 1, 'unknown', 'exchange', $4, 'make') returning id`,
        [returnId, fulfillmentId, base.orderItemId, base.variantId],
      )
    ).rows[0].id as string;
    await client.query('update public.order_returns set fee_due_amount = 100 where id = $1::uuid', [returnId]);
    const exchange = (
      await client.query(
        `insert into public.order_items
           (order_id, item_id, variant_id, item_name, item_price, color, size, quantity, line_total, fulfillment_type, line_kind,
            exchange_return_line_id, exchange_paid_amount)
         values ($1::uuid, $2, $3, $4, 0, $5, $6, 1, 0, 'backorder', 'exchange', $7::uuid, 5000) returning id`,
        [base.orderId, base.itemId, base.variantId, exchangeName, base.colorName, base.sizeLabel, lineId],
      )
    ).rows[0].id as string;
    await seedE2eAllocation(client, { orderItemId: exchange, quantity: 1, kind: 'paid' });
    return exchange;
  });
  return { base, exchangeOrderItemId, exchangeName, exchangeLabel: `${exchangeName} ${base.colorName} ${base.sizeLabel}` };
}

// ---------------------------------------------------------------------------------------------------------------------
// 材料: 発送票（本物の公開関数。実行者は役割 admin の ctx.actorId）
// ---------------------------------------------------------------------------------------------------------------------

/** 品物（注文の明細と送る数）を選んだ下書きを作る。lines を省くと、材料の準備中の数ぜんぶ */
export async function createDraftInDb(
  ctx: ShippingContext,
  materials: readonly ShippingMaterial[],
  quantities?: readonly number[],
): Promise<{ id: string; number: string; version: number }> {
  const saved = await saveSlipDraftInDb(
    ctx.client,
    ctx.actorId,
    materials.map((material, index) => ({ orderItemId: material.orderItemId, quantity: quantities?.[index] ?? material.allocated })),
  );
  ctx.trackSlip(saved.id);
  return { id: saved.id, number: saved.number, version: saved.version };
}

/** 下書きを作って確定する（品物は材料の準備中の数ぜんぶ。数を変える時は quantities）。確定の戻り（注文ごとの発送）を返す */
export async function shipMaterialsInDb(
  ctx: ShippingContext,
  materials: readonly ShippingMaterial[],
  options: {
    quantities?: readonly number[];
    carrier?: ShippingCarrierId | null;
    trackingNumber?: string | null;
    notifyCustomer?: boolean;
    shipmentDate?: string;
    requestKey?: string;
  } = {},
): Promise<ShipmentSlipConfirmed> {
  const draft = await createDraftInDb(ctx, materials, options.quantities);
  return confirmSlipInDb(ctx.client, ctx.actorId, draft, {
    carrier: options.carrier ?? null,
    trackingNumber: options.trackingNumber ?? null,
    notifyCustomer: options.notifyCustomer,
    shipmentDate: options.shipmentDate,
    requestKey: options.requestKey,
  });
}

/** 発送票の詳細（DB の関数 get_admin_shipment_slip。画面と同じ元）を検査した形で読む */
export async function readSlip(db: PgClient, actorId: string, slipId: string): Promise<ShipmentSlipDetail> {
  const result = await db.query('select public.get_admin_shipment_slip(_slip_id => $1::uuid, _actor_id => $2::uuid) as result', [slipId, actorId]);
  return parseShipmentSlipDetail(result.rows[0].result);
}

export type FulfillmentRow = {
  id: string;
  number: number;
  completesOrder: boolean;
  cancelled: boolean;
  carrier: string | null;
  trackingNumber: string | null;
  notifyCustomer: boolean;
  shipmentDate: string | null;
  quantity: number;
};

/** 注文の発送（番号順。取り消した物も含む）と、その発送の品物の数の合計 */
export async function fulfillmentsOf(db: PgClient, orderId: string): Promise<FulfillmentRow[]> {
  const result = await db.query(
    `select f.id, f.number, f.completes_order, f.cancelled_at is not null as cancelled, f.shipping_carrier, f.tracking_number,
            f.notify_customer, f.shipment_date::text as shipment_date,
            (select coalesce(sum(l.quantity), 0)::int from public.order_fulfillment_lines as l where l.fulfillment_id = f.id) as quantity
       from public.order_fulfillments as f where f.order_id = $1::uuid order by f.number`,
    [orderId],
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    number: Number(row.number),
    completesOrder: row.completes_order === true,
    cancelled: row.cancelled === true,
    carrier: (row.shipping_carrier as string | null) ?? null,
    trackingNumber: (row.tracking_number as string | null) ?? null,
    notifyCustomer: row.notify_customer === true,
    shipmentDate: (row.shipment_date as string | null) ?? null,
    quantity: Number(row.quantity),
  }));
}

export async function orderStatusOf(db: PgClient, orderId: string): Promise<string> {
  return (await db.query('select status::text as status from public.orders where id = $1::uuid', [orderId])).rows[0].status as string;
}

/** 注文の明細の、今の準備中の数（入金済みの割当があり、まだ送っていない数。DB の関数 list_order_line_fulfillment） */
export async function readyQuantityOf(db: PgClient, material: Pick<ShippingMaterial, 'orderId' | 'orderItemId'>): Promise<number> {
  const row = (
    await db.query(
      'select ready_unshipped from public.list_order_line_fulfillment(array[$1::uuid]) where order_item_id = $2::uuid',
      [material.orderId, material.orderItemId],
    )
  ).rows[0];
  return Number(row?.ready_unshipped ?? 0);
}

/** 注文の発送メールの予定（種類ごと）の数。画面を介さず DB を直に数える */
export async function outboxCount(db: PgClient, orderIds: readonly string[], kinds: readonly string[]): Promise<number> {
  const result = await db.query(
    'select count(*)::int as n from private.order_email_outbox where order_id = any($1::uuid[]) and kind = any($2::text[])',
    [orderIds, kinds],
  );
  return Number(result.rows[0].n);
}

// ---------------------------------------------------------------------------------------------------------------------
// bridge: 画面が呼ぶ窓口 → DB の公開関数
// ---------------------------------------------------------------------------------------------------------------------

export type ShippingReply = { status: number; body: unknown };

const FAILED: ShippingReply = { status: 500, body: { error: SHIPMENT_SLIP_TEXT.failed } };

/** 窓口の store が操作の権限の組として使う4つ・出荷日の訂正に使う3つ（DB の関数も同じ組を確かめる） */
const MANAGE_CODES = ['admin.shipping.manage', 'admin.shipping.read', 'admin.orders.manage', 'admin.orders.read'] as const;
const DATE_CODES = ['admin.shipping.correct_date', 'admin.shipping.read', 'admin.orders.read'] as const;

/**
 * DB の拒否を、窓口と同じ { code, error } と HTTP の状態にする。message と SQLSTATE が表と完全に一致した時だけ分類し、
 * 表に無い物・崩れた戻りは固定の500（DB の文は出さない）。出荷日の訂正の権限の拒否は、窓口と同じ専用の文にする。
 */
function errorReply(error: unknown, forbiddenText?: string): ShippingReply {
  const { message, code } = (error ?? {}) as { message?: unknown; code?: unknown };
  if (typeof message !== 'string' || !Object.hasOwn(SHIPMENT_SLIP_ERRORS, message)) return FAILED;
  const [sqlstate, status, text] = SHIPMENT_SLIP_ERRORS[message];
  if (code !== sqlstate) return FAILED;
  return { status, body: { code: message, error: message === 'GROUP_G_FORBIDDEN' && forbiddenText ? forbiddenText : text } };
}

/** 実行者の有効な役割（有効・期限内の全部）の権限の和集合が、挙げた権限を全部含むか。画面の表示用の値を作るのに使い、許否には使わない */
async function actorHasAll(db: PgClient, actorId: string, codes: readonly string[]): Promise<boolean> {
  const result = await db.query(
    `select distinct p.code from public.user_roles as ur
       join public.role_permissions as rp on rp.role_id = ur.role_id
       join public.permissions as p on p.id = rp.permission_id
      where ur.user_id = $1::uuid and ur.active and (ur.expires_at is null or ur.expires_at > now())`,
    [actorId],
  );
  const granted = new Set(result.rows.map((row) => row.code as string));
  return codes.every((code) => granted.has(code));
}

function toPackingRow(raw: Record<string, unknown>) {
  return parsePackingRow({
    orderId: raw.order_id,
    orderItemId: raw.order_item_id,
    orderCreatedAt: raw.order_created_at,
    customerName: raw.customer_name,
    customerEmail: raw.customer_email,
    itemName: raw.item_name,
    color: raw.color,
    size: raw.size,
    readyQuantity: raw.ready_quantity,
    shippableQuantity: raw.shippable_quantity,
    unitPrice: raw.unit_price,
    isExchange: raw.is_exchange,
    blockedReasons: raw.blocked_reasons,
    otherSlipNumbers: raw.other_slip_numbers,
    selectedQuantity: raw.selected_quantity,
    bundleOk: raw.bundle_ok,
    bundleKey: raw.bundle_key,
  });
}

function toSlipListRow(raw: Record<string, unknown>) {
  return parseShipmentSlipListRow({
    id: raw.id,
    number: raw.number,
    stage: raw.stage,
    version: raw.version,
    expired: raw.expired,
    shipmentDate: raw.shipment_date,
    shippingCarrier: raw.shipping_carrier,
    trackingNumber: raw.tracking_number,
    orderCount: raw.order_count,
    itemQuantity: raw.item_quantity,
    updatedAt: raw.updated_at,
  });
}

type Body = Record<string, any>;
type SlipDbArgs = Parameters<typeof callSlipDb>[2];

const ID = '([0-9a-fA-F-]{36})';
const ROUTES = {
  packing: /^\/api\/admin\/packing$/,
  slips: /^\/api\/admin\/shipment-slips$/,
  slip: new RegExp(`^/api/admin/shipment-slips/${ID}$`),
  action: new RegExp(`^/api/admin/shipment-slips/${ID}/(draft|discard|confirm|tracking|delivered|cancel|shipment-date)$`),
  history: new RegExp(`^/api/admin/orders/${ID}/history$`),
} as const;

/** bridge が受ける窓口の道（これ以外は本物の窓口へ渡す） */
function isBridgedPath(pathname: string): boolean {
  return ROUTES.packing.test(pathname) || pathname.startsWith('/api/admin/shipment-slips') || ROUTES.history.test(pathname);
}

/** 書込みの窓口。成功の本文は窓口の store と同じ検査（parse）を通した決まった項目だけ。崩れていれば固定の500 */
async function runWriter<T>(
  db: PgClient,
  fn: string,
  args: SlipDbArgs,
  parse: (value: unknown) => T,
  status: number,
  forbiddenText?: string,
): Promise<ShippingReply & { parsed?: T }> {
  try {
    const parsed = parse(await callSlipDb(db, fn, args));
    return { status, body: parsed, parsed };
  } catch (error) {
    return errorReply(error, forbiddenText);
  }
}

/**
 * 発送票の窓口へ来た要求 1 件を、実行者 actorId の DB の公開関数へ渡して、窓口と同じ形の答えにする。決めていない方法・道は null。
 * bridge の page.route と、試験が「DB には届いたが応答が画面に届かない」を作るための route が共有する。
 */
export async function dispatchShippingRequest(
  db: PgClient,
  actorId: string,
  method: string,
  url: URL,
  body: Body,
): Promise<ShippingReply | null> {
  const { pathname } = url;
  const q = url.searchParams;

  if (ROUTES.packing.test(pathname)) {
    if (method !== 'GET') return null;
    const limit = Number(q.get('limit') ?? 50);
    const page = Number(q.get('page') ?? 1);
    try {
      const result = await db.query(
        `select to_jsonb(s) as row from public.list_admin_packing(
           _slip_id => $1::uuid, _limit => $2, _offset => $3, _actor_id => $4::uuid) as s`,
        [q.get('slipId'), limit, (page - 1) * limit, actorId],
      );
      const raw = result.rows.map((row) => row.row as Record<string, unknown>);
      const rows = raw.map(toPackingRow);
      const total = raw.length > 0 ? Number(raw[0].total_count) : 0;
      return { status: 200, body: { rows, total, page, limit, canManage: await actorHasAll(db, actorId, MANAGE_CODES) } };
    } catch (error) {
      return errorReply(error);
    }
  }

  if (ROUTES.slips.test(pathname)) {
    if (method === 'GET') {
      const limit = Number(q.get('limit') ?? 20);
      const page = Number(q.get('page') ?? 1);
      try {
        const result = await db.query(
          `select to_jsonb(s) as row from public.list_admin_shipment_slips(
             _stage => $1::text, _limit => $2, _offset => $3, _actor_id => $4::uuid) as s`,
          [q.get('stage'), limit, (page - 1) * limit, actorId],
        );
        const raw = result.rows.map((row) => row.row as Record<string, unknown>);
        const total = raw.length > 0 ? Number(raw[0].total_count) : 0;
        return { status: 200, body: { rows: raw.map(toSlipListRow), total, page, limit } };
      } catch (error) {
        return errorReply(error);
      }
    }
    if (method !== 'POST') return null;
    return runWriter(db, 'admin_save_shipment_slip_draft', [
      ['_slip_id', null, 'uuid'], ['_expected_version', null, 'integer'], ['_lines', body.lines, 'jsonb'],
      ['_actor_id', actorId, 'uuid'], ['_request_key', body.requestKey, 'uuid'],
    ], parseShipmentSlipSaved, 201).then(trackCreated(db));
  }

  const slip = ROUTES.slip.exec(pathname);
  if (slip) {
    if (method !== 'GET') return null;
    try {
      const result = await db.query('select public.get_admin_shipment_slip(_slip_id => $1::uuid, _actor_id => $2::uuid) as result', [slip[1], actorId]);
      const detail = parseShipmentSlipDetail(result.rows[0].result);
      if (detail.id !== slip[1].toLowerCase()) throw new Error('SHIPMENT_SLIP_READ_FAILED');
      return { status: 200, body: { slip: detail, canCorrectDate: await actorHasAll(db, actorId, DATE_CODES) } };
    } catch (error) {
      return errorReply(error);
    }
  }

  const action = ROUTES.action.exec(pathname);
  if (action) {
    if (method !== 'POST') return null;
    const [, id, operation] = action;
    const common: SlipDbArgs = [['_slip_id', id, 'uuid'], ['_expected_version', body.expectedVersion, 'integer']];
    const actor: SlipDbArgs = [['_actor_id', actorId, 'uuid'], ['_request_key', body.requestKey, 'uuid']];
    switch (operation) {
      case 'draft':
        return runWriter(db, 'admin_save_shipment_slip_draft', [...common, ['_lines', body.lines, 'jsonb'], ...actor], parseShipmentSlipSaved, 200);
      case 'discard':
        return runWriter(db, 'admin_discard_shipment_slip_draft', [...common, ...actor], parseShipmentSlipSaved, 200);
      case 'confirm':
        return runWriter(db, 'admin_confirm_shipment_slip', [
          ...common, ['_carrier', body.carrier ?? null, 'text'], ['_tracking_number', body.trackingNumber ?? null, 'text'],
          ['_shipment_date', body.shipmentDate, 'date'], ['_notify_customer', body.notifyCustomer, 'boolean'], ...actor,
        ], parseShipmentSlipConfirmed, 200);
      case 'tracking':
        return runWriter(db, 'admin_update_shipment_slip_tracking', [
          ...common, ['_carrier', body.carrier, 'text'], ['_tracking_number', body.trackingNumber, 'text'],
          ['_notify_customer', body.notifyCustomer, 'boolean'], ...actor,
        ], parseShipmentSlipTrackingUpdated, 200);
      case 'delivered':
        return runWriter(db, 'admin_mark_shipment_slip_delivered', [
          ...common, ['_delivered_on', body.deliveredOn, 'date'], ['_notify_customer', body.notifyCustomer, 'boolean'], ...actor,
        ], parseShipmentSlipDelivered, 200);
      case 'cancel':
        return runWriter(db, 'admin_cancel_shipment_slip', [...common, ...actor], parseShipmentSlipCancelled, 200);
      default:
        return runWriter(db, 'admin_correct_shipment_date', [
          ...common, ['_shipment_date', body.shipmentDate, 'date'], ['_reason', typeof body.reason === 'string' ? body.reason.trim() : body.reason, 'text'], ...actor,
        ], parseShipmentSlipDateCorrected, 200, SHIPMENT_SLIP_TEXT.dateForbidden);
    }
  }

  const history = ROUTES.history.exec(pathname);
  if (history) {
    if (method !== 'GET') return null;
    // 窓口と同じく、票の結び付きは権限を確かめて読み、読めない時は付けずに履歴を返す
    let slips: Map<string, ShipmentSlipLink> | undefined;
    try {
      const result = await db.query(
        'select to_jsonb(s) as row from public.list_admin_order_shipment_slips(_order_id => $1::uuid, _actor_id => $2::uuid) as s',
        [history[1], actorId],
      );
      slips = new Map();
      for (const entry of result.rows) {
        const raw = entry.row as Record<string, unknown>;
        const { fulfillmentId, ...link } = parseShipmentSlipLink({
          fulfillmentId: raw.fulfillment_id, slipId: raw.slip_id, number: raw.number, stage: raw.stage,
        });
        slips.set(fulfillmentId, link);
      }
    } catch {
      slips = undefined;
    }
    const built = await bridgeHistory(db, history[1], slips);
    return built === null ? { status: 404, body: { error: 'Order not found' } } : { status: 200, body: built };
  }

  return null;
}

/** 下書きを作った答えが成功なら、その票を後始末の対象に足す */
function trackCreated(db: PgClient): (reply: ShippingReply & { parsed?: { id: string } }) => ShippingReply {
  return (reply) => {
    if (reply.status === 201 && reply.parsed) trackingOf(db).slips.add(reply.parsed.id);
    return { status: reply.status, body: reply.body };
  };
}

/**
 * 荷作り・発送票・注文の履歴の窓口への画面の要求を、実行者 actorId で DB の公開関数へ橋渡しする。権限の許否は DB の関数が決める。
 * 決めていない方法・道は本物の窓口へ渡す。後から登録した page.route が先に効くので、試験が答えを止めたり失敗させたりする時は、
 * これより後に登録して route.fallback() で渡す。
 */
export async function mockShippingUiBridge(page: Page, client: PgClient, actorId: string): Promise<void> {
  assertLocalE2eDb(client);
  await page.route(
    (url) => isBridgedPath(url.pathname),
    async (route) => {
      const request = route.request();
      let body: Body = {};
      try {
        body = (request.postDataJSON() ?? {}) as Body;
      } catch {
        body = {};
      }
      let reply: ShippingReply | null;
      try {
        reply = await dispatchShippingRequest(client, actorId, request.method(), new URL(request.url()), body);
      } catch (error) {
        reply = errorReply(error);
      }
      if (reply === null) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: reply.status,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(reply.body),
      });
    },
  );
}

/** 管理者のログインの差し替え（役割 role）と bridge（実行者 actorId）を、画面を開く前に用意する */
export async function prepareShippingPage(
  page: Page,
  ctx: ShippingContext,
  options: { role?: 'admin' | 'supporter'; actorId?: string } = {},
): Promise<void> {
  await mockAdminSessionAs(page, options.role ?? 'admin');
  await mockShippingUiBridge(page, ctx.client, options.actorId ?? ctx.actorId);
  // 荷作り表の並びを読む実行者は、画面の実行者（サポーターなど）によらず、読める権限のある役割 admin
  snapshotActors.set(page, ctx.actorId);
}

/**
 * 窓口を画面なしで呼ぶ（画面が呼ぶのと同じ bridge の中核 dispatchShippingRequest を直に呼ぶ。実行者は省くと役割 admin の ctx.actorId）。
 * 権限の許否は DB の関数が決める。bridge が決めていない方法・道は投げる。FR-ADMIN-117・118 が拒否の答えや履歴の形を確かめるのに使う。
 */
export async function callShippingApi(
  ctx: ShippingContext,
  method: 'GET' | 'POST',
  path: string,
  body: Record<string, unknown> = {},
  actorId: string = ctx.actorId,
): Promise<ShippingReply> {
  const reply = await dispatchShippingRequest(ctx.client, actorId, method, new URL(path, 'http://localhost:3000'), body);
  if (reply === null) throw new Error(`E2E_BRIDGE_UNHANDLED:${method} ${path}`);
  return reply;
}

/** 画面の中から窓口を呼ぶ（ログインの cookie は同じ origin のまま付く。bridge が DB の関数へ渡す） */
export async function callFromPage(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  return page.evaluate(
    async ({ method: m, path: p, body: b }) => {
      const response = await fetch(p, {
        method: m,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: m === 'GET' ? undefined : JSON.stringify(b ?? {}),
      });
      return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null };
    },
    { method, path, body },
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// 画面の読み方: 荷作り表
// ---------------------------------------------------------------------------------------------------------------------

/** 荷作り表の読み込みが済んだ表（見出しの名前の領域）。読み込み中・空の間は無い */
export function packingTable(page: Page): Locator {
  return page.getByRole('region', { name: SHIPMENT_SLIP_TEXT.packingHeading, exact: true });
}

const packingIndicator = (page: Page): Locator => page.getByText(/^\d+〜\d+ \/ \d+$/);

/**
 * 荷作り表の読み込みを待つ上限。荷作り表の DB の関数は、全部の入金済みの注文の準備中の行を数えて古い順に並べるので、
 * 手元の DB に注文が溜まるほど読み込みが遅くなる。既定の待ち（5 秒）では足りないことがある。
 */
const PACKING_LOAD = { timeout: 30_000 } as const;

/** 荷作り表の表が出るまで待つ（読み込みが遅い時のための長い待ち） */
export async function waitForPackingTable(page: Page): Promise<void> {
  await expect(packingTable(page)).toBeVisible(PACKING_LOAD);
}

/** 荷作り表を開き、表が出るまで待つ */
export async function openPacking(page: Page): Promise<void> {
  await page.goto('/admin/packing');
  await expect(page.getByRole('heading', { name: SHIPMENT_SLIP_TEXT.packingHeading, level: 1, exact: true })).toBeVisible();
  await expect(packingTable(page)).toBeVisible(PACKING_LOAD);
}

/** 表の行（品物の1行ごと）。商品名で絞る */
export function packingRowOf(page: Page, material: Pick<ShippingMaterial, 'itemName'> | { itemName: string }): Locator {
  return page.getByTestId('packing-row').filter({ hasText: material.itemName });
}

/** 行の直後の1行（選べない理由・別の票の通知・同梱の案内を出す行）。無ければ 0 件の Locator */
export function packingNoteOf(row: Locator): Locator {
  return row.locator('xpath=following-sibling::*[1][@data-testid="packing-row-note"]');
}

/** 行の選択欄（名前は「商品名 色 サイズ を選ぶ」） */
export function selectBoxOf(row: Locator, label: string): Locator {
  return row.getByRole('checkbox', { name: `${label} を選ぶ`, exact: true });
}

/** 行の「今回送る数」の入力 */
export function sendQuantityOf(row: Locator, label: string): Locator {
  return row.getByLabel(`${label} の送る数`, { exact: true });
}

async function clickPackingPage(page: Page, name: '前の頁' | '次の頁'): Promise<void> {
  const before = (await packingIndicator(page).count()) > 0 ? await packingIndicator(page).innerText() : null;
  await page.getByRole('button', { name, exact: true }).click();
  // 頁が変わるまで待つ（読み込み中は表も頁の表示も無い）
  await expect
    .poll(async () => ((await packingIndicator(page).count()) > 0 ? await packingIndicator(page).innerText() : null), PACKING_LOAD)
    .not.toBe(before);
  await expect(packingTable(page)).toBeVisible(PACKING_LOAD);
}

/** 荷作り表の1頁目へ戻る（今 1 頁目なら何もしない） */
export async function goToFirstPackingPage(page: Page): Promise<void> {
  await expect(packingTable(page)).toBeVisible(PACKING_LOAD);
  const previous = page.getByRole('button', { name: '前の頁', exact: true });
  while (await previous.isEnabled()) await clickPackingPage(page, '前の頁');
}

/** 荷作り表の1頁の行数（画面の既定。PackingSection の LIMIT と同じ） */
const PACKING_PAGE_SIZE = SHIPMENT_SLIP_LIMITS.packingPage.limit.fallback;

/** 荷作り表の並びを読む実行者（prepareShippingPage が頁ごとに控える。役割 admin の ctx.actorId。画面の実行者とは別でよい） */
const snapshotActors = new WeakMap<Page, string>();

/**
 * 荷作り表の全部の行を、DB の関数 list_admin_packing から**ある一時点の1回の読み取り**で取る（古い注文が先の並びのまま）。
 * 荷作り表は DB 全体で 1 つの並びで、他の試験（4 worker）が準備中の行を足したり閉じたりしている最中でも、この読み取りの中では動かない。
 * 専用の接続で、繰り返し可能読み取り（repeatable read）の読み取り専用の取引の中で 100 行ずつ全頁を読む（関数の 1 回の上限が 100 行のため）。
 * 並び・出る/出ないの確かめはこの読み取りで行い、画面は「自分の行を見せる・操作する」だけに使う（頁を歩いて探さない）。
 */
export async function readPackingSnapshot(actorId: string): Promise<PackingRow[]> {
  return withLocalDb(async (db) => {
    await db.query('begin isolation level repeatable read read only');
    try {
      const rows: PackingRow[] = [];
      for (let offset = 0; offset < 1_000_000; offset += 100) {
        const result = await db.query(
          `select to_jsonb(s) as row from public.list_admin_packing(
             _slip_id => null::uuid, _limit => 100, _offset => $1::integer, _actor_id => $2::uuid) as s`,
          [offset, actorId],
        );
        const page = result.rows.map((entry) => toPackingRow(entry.row as Record<string, unknown>));
        rows.push(...page);
        if (page.length < 100) break;
      }
      await db.query('commit');
      return rows;
    } catch (error) {
      await db.query('rollback').catch(() => undefined);
      throw error;
    }
  });
}

/** 並びの中のその明細の位置（0 始まり）。荷作り表に無ければ -1 */
export function packingIndexOf(rows: readonly PackingRow[], orderItemId: string): number {
  return rows.findIndex((row) => row.orderItemId === orderItemId);
}

/** 荷作り表を 1 頁目へ戻してから、pageNumber 頁目まで「次の頁」で送る */
async function goToPackingPageNumber(page: Page, pageNumber: number): Promise<void> {
  await goToFirstPackingPage(page);
  for (let current = 1; current < pageNumber; current += 1) {
    if (!(await page.getByRole('button', { name: '次の頁', exact: true }).isEnabled())) return;
    await clickPackingPage(page, '次の頁');
  }
}

/**
 * その品の行を画面に出して返す。1 回の読み取り（readPackingSnapshot）で行の位置（何頁目か）を決めてその頁へ行き、行があればそれを返す。
 * その間に他の試験が行を足したり閉じたりして行が別の頁へずれていたら、位置を 1 回だけ読み直して行き直す（頁を総当たりで探さない）。
 * それでも出ない、または荷作り表に無い時は投げる。
 */
export async function revealPackingRow(page: Page, material: { itemName: string; orderItemId: string }): Promise<Locator> {
  const actorId = snapshotActors.get(page);
  if (!actorId) throw new Error('E2E_PACKING_PAGE_NOT_PREPARED');
  const row = packingRowOf(page, material);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const index = packingIndexOf(await readPackingSnapshot(actorId), material.orderItemId);
    if (index < 0) throw new Error(`E2E_PACKING_ROW_NOT_IN_LIST:${material.itemName}`);
    await goToPackingPageNumber(page, Math.floor(index / PACKING_PAGE_SIZE) + 1);
    if ((await row.count()) > 0) return row;
  }
  throw new Error(`E2E_PACKING_ROW_NOT_FOUND:${material.itemName}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// 画面の読み方: 発送票
// ---------------------------------------------------------------------------------------------------------------------

/**
 * 発送票の頁の見出し（発送票 SL-…）が出るまで待つ。票の番号を返す。
 * 下書きの頁は、見出しの後に「品物を追加」の候補（荷作り表の全部の頁）を裏で読み続ける。読み込み中（role=status）が全部消えるまで待つので、
 * この後に試験が DB へ材料を書いても、画面の要求（bridge は材料と同じ DB の接続を使う）が材料の取引に混ざらない。
 */
export async function expectSlipHeading(page: Page): Promise<string> {
  const heading = page.getByRole('heading', { level: 1, name: /^発送票 SL-\d{8}-\d{4}$/ });
  await expect(heading).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: SHIPMENT_SLIP_TEXT.loading })).toHaveCount(0, PACKING_LOAD);
  return ((await heading.innerText()).replace(/^発送票 /, '')).trim();
}

/** 発送票の頁の URL から票の id を読む */
export function slipIdOfUrl(page: Page): string {
  const match = /\/admin\/shipment-slips\/([0-9a-f-]{36})$/.exec(new URL(page.url()).pathname);
  if (!match) throw new Error('E2E_NOT_ON_SLIP_PAGE');
  return match[1];
}

/** 発送票の頁を開き、見出しが出るまで待つ（票の番号を返す） */
export async function openSlip(page: Page, slipId: string): Promise<string> {
  await page.goto(`/admin/shipment-slips/${slipId}`);
  return expectSlipHeading(page);
}

/** 通知（role=status）の文 */
export function noticeOf(page: Page, text: string): Locator {
  return page.getByRole('status').filter({ hasText: text });
}

/** 荷物の情報を入れずに（運送会社は未定・番号なし）、発送票確認 → 発送確定 まで進める。成功の通知まで待つ */
export async function confirmOnSlipPage(page: Page): Promise<void> {
  await page.getByRole('button', { name: '発送票確認', exact: true }).click();
  await expect(page.getByRole('heading', { name: '発送票の確認', level: 2, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '発送確定', exact: true }).click();
  await expect(noticeOf(page, '発送を確定しました。')).toBeVisible();
  await expect(page.getByTestId('slip-stage')).toContainText('発送済み');
}

// ---------------------------------------------------------------------------------------------------------------------
// 画面の読み方: 権限の画面（店長がサポーターの権限を付け外しする）
// ---------------------------------------------------------------------------------------------------------------------

/** 権限の画面に出る権限の名前（カタログの文字そのまま） */
export function permissionLabelOf(code: string): string {
  const found = ROLE_PERMISSION_CATALOG.find((permission) => permission.code === code);
  if (!found) throw new Error(`E2E_PERMISSION_CODE_UNKNOWN:${code}`);
  return found.label;
}

/** 店長の権限の画面（bridge 経由の DB の関数）で、サポーターの1つの権限を付け外しする。保存が済み、スイッチが変わるまで待つ */
export async function setSupporterPermissionOnScreen(adminPage: Page, code: string, next: boolean): Promise<void> {
  const label = permissionLabelOf(code);
  await adminPage.goto('/admin/settings/permissions');
  await expect(adminPage.getByRole('table')).toBeVisible();
  const toggle = adminPage.getByRole('switch', { name: `サポーター：${label}`, exact: true });
  if ((await toggle.getAttribute('aria-checked')) === String(next)) return;
  await toggle.click();
  const dialog = adminPage.getByRole('dialog', { name: '権限を変更する', exact: true });
  await dialog.getByRole('button', { name: '変更する', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(adminPage.getByRole('status').filter({ hasText: '権限を保存しました。' })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', String(next));
}
