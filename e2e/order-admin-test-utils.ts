/**
 * 注文一覧表・CSV・品物のステータス（グループ G-4）の E2E の道具。FR-ADMIN-110・121 が使う（FR-ADMIN-112・122・123 の G-4 の分も使う）。
 *
 * 画面 → 窓口の差し替え（bridge）→ 手元の DB の公開関数、の道で確かめる。本物の窓口（route）は通らない。
 * 本物の管理者のログインには2段階認証（aal2）が要るので、画面が呼ぶ一覧・CSV の窓口（GET /api/admin/order-items・…/export）を、
 * 同じ DB の公開関数（list_admin_order_item_rows・export_admin_order_item_rows。service_role 専用）へ手元の DB の接続から橋渡しする。
 * - bridge は権限を決めない。実行者（actorId）を `_actor_id` で渡すだけで、許否は DB の関数が決める（読みも同じ）。
 * - 問合せの検査・DB への条件・一覧の答えの検査・CSV の組立て・ファイル名・DB の誤りの表は、窓口と同じ純粋な関数/表を import して使う
 *   （parseOrderItemQuery・toFilterPayload・parseOrderItemListResult・buildOrderItemCsv・orderItemCsvFilename・ADMIN_ORDER_ERRORS。写していない）。
 * - 窓口の認可・MFA・回数の制限・操作の監査は bridge の範囲の外。窓口の認可の効きは本物の窓口の 401/403（FR-ADMIN-123 の G-4 の節）と
 *   各 route の単体が、DB の権限の確かめは bridge の下の DB の関数が確かめる。
 *   次の差がある: 一覧の答えの要対応の件数（returnAttention・cancelRequestAttention）は全注文の数で、並行して動く試験が変えるため既定は 0
 *   （窓口は DB から数える。窓口の単体が確かめる。options.attention で固定の値を返せる）。
 *
 * 材料の注文は試験ごとに新しい商品・新しいメールアドレス（uniqueEmail）で作る。画面の絞り込みも DB の期待もそのメールアドレスで読み、
 * 全体の件数は使わない。発送・割当・返金・返品は追記専用で消せないので、材料は作りっぱなしにし、終わりに残りの準備中の品だけを
 * 合成の発送で閉じる（荷作り表に溜めない。withShippingScenario と同じ後始末）。
 * 並びと「出ない」の確かめは、頁を歩かず、DB の関数の1回の呼出し（readExportSnapshot。同一時点）で行う。
 *
 * 権限の表と役割は手元の DB の共有の状態。既定の役割の権限に頼る試験は withOrderAdminScenario（権限の鍵 190520,0 を共有で持つ）の中で動かし、
 * 役割の権限を付け外しする試験だけが withPermissionScenario（排他の鍵と差分の復元）を使う。
 *
 * 注意: 試験の材料づくりと bridge は DB の接続を1本で共有する。材料の取引（withGroupG1Material の BEGIN/SAVEPOINT）の最中に
 * 画面の要求が bridge へ届くと、同じ取引に混ざる。材料は画面を開く前に作る。
 *
 * 作らなかった物（理由）: `clearVariantInDb`（作った明細の variant_id を NULL に書き換える道具）と `setPaymentIntentInDb`（作った注文へ決済IDを書く道具）。
 * order_items の更新は法定の不変の守り（protect_legal_order_item_immutable_fields。どの列の更新も断る）が止め、注文の更新は変更履歴の理由が要るので、
 * 書き換えずに作る時に決める: 色・サイズ未確定は明細の variantMissing、決済IDは注文の paymentIntentId。
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, type Locator, type Page } from '@playwright/test';
import { z } from 'zod';
import { buildOrderItemCsv, orderItemCsvFilename } from '@/lib/orders/admin-orders/admin-order-csv';
import {
  adminOrderBlockedReasonsSchema,
  adminOrderExportRowSchema,
  adminOrderIntegerSchema as integer,
  adminOrderTimestampSchema as timestamp,
  parseOrderItemListResult,
  parseOrderItemQuery,
  toFilterPayload,
} from '@/lib/orders/admin-orders/admin-order-query';
import {
  ADMIN_ORDER_ERRORS,
  ADMIN_ORDER_TEXT,
  ORDER_ITEM_PAGE_SIZE,
  ORDER_ITEM_STATUS_ORDER,
  type AdminOrderExportRow,
  type AdminOrderItemFilters,
} from '@/lib/orders/admin-orders/admin-order-types';
import { ADMIN_ITEM_STATUS_LABELS } from '@/lib/orders/item-state/item-state-types';
import {
  ALLOCATION_SWAP_ERRORS, ALLOCATION_SWAP_TEXT, allocationSwapInputSchema,
  parseAllocationSwapCandidates, parseAllocationSwapResult,
  type AllocationSwapInput, type AllocationSwapResult,
} from '@/lib/inventory/allocation-swap-types';
import { itemStateHistoryDbRowSchema, mapItemStateHistoryRows } from '@/lib/orders/admin-orders/admin-order-history';
import { ORDER_STATUSES } from '@/lib/orders/order-payment-types';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { insertCancelRequest, insertReturnRecord } from '../tests/integration/db/helpers/order-fixtures';
import { seedGroupG4Exchange } from '../tests/integration/db/helpers/group-g4-fixtures';
import {
  allocationKindOf,
  assertLocalE2eDb,
  lockE2eInventory,
  seedE2eAllocation,
  seedE2eRestock,
  seedE2eShipment,
  releaseE2eUnpaidOrder,
  setE2eOrderStatus,
  withGroupG1Material,
} from './group-g1-test-utils';
import { beginRefund, recordRefundResult, uniqueEmail, withLocalDb } from './order-email-test-utils';
import { adminOrderDetail, fulfillJson, historyOf, orderNumberOf } from './order-fulfillment-test-utils';
import { createReturnInDb, createShippedOrder, receiveReturnInDb } from './return-test-utils';
import {
  DEFAULT_SHIP_TO,
  UNIT_PRICE,
  createCatalogMaterial,
  createMemberUser,
  holdPaymentReview,
  withShippingScenario,
  type CatalogMaterial,
  type ShippingContext,
} from './shipping-test-utils';

export { UNIT_PRICE, uniqueEmail };

// ---------------------------------------------------------------------------------------------------------------------
// 試験の場面
// ---------------------------------------------------------------------------------------------------------------------

/** 試験の場面（手元の DB の接続1本と、役割 admin の実行者 actorId。trackOrder で作った注文を終わりの後始末の対象に足す） */
export type OrderAdminContext = ShippingContext;

/**
 * 既定の役割の権限に頼る試験（110・112・121・122・123 の G-4 の分のうち DB が権限を決める物）の場面。
 * 接続を開き、最初に共有の鍵 pg_advisory_lock_shared(190520, 0) を取り、終わりに解放する（withShippingScenario と同じ接続と後始末。
 * 役割の権限を付け外しする試験が排他の鍵で入る間は待たされ、ほかのワーカーの supporter の試験に割り込まない）。
 * 鍵の順は 940488（追跡の設定。要る試験だけ withDeliveryScenario）→ 14314,2（返品の設定）→ 190520,0。
 * 返品の設定（shop_return_settings の1行）を触る試験（返品の材料を返品の関数で作る createReturnStatesMaterial）は
 * options.returnSettings を付ける: 別の接続で先に 14314,2 を取り、その後に 190520,0 を共有で取る（逆の順で取る所は無い）。
 * 一覧・書き出しの上限の設定（この接続だけのもの）は、終わりに必ず戻す。
 */
export async function withOrderAdminScenario(
  run: (ctx: OrderAdminContext) => Promise<void>,
  options: { returnSettings?: boolean } = {},
): Promise<void> {
  const scenario = (returnLockPid?: number): Promise<void> =>
    withShippingScenario(async (ctx) => {
      orderAdminContexts.set(ctx.client, ctx);
      if (returnLockPid !== undefined) returnLockPids.set(ctx.client, returnLockPid);
      try {
        await run(ctx);
      } finally {
        orderAdminContexts.delete(ctx.client);
        resetExportCapInDb(ctx.client);
        await resetListCapInDb(ctx.client);
      }
    });
  if (!options.returnSettings) {
    await scenario();
    return;
  }
  await withLocalDb(async (lockClient) => {
    await lockClient.query('select pg_catalog.pg_advisory_lock(14314, 2)');
    try {
      const pid = Number((await lockClient.query('select pg_catalog.pg_backend_pid() as pid')).rows[0].pid);
      await scenario(pid);
    } finally {
      await lockClient.query('select pg_catalog.pg_advisory_unlock(14314, 2)');
    }
  });
}

/** 返品の設定の鍵 14314,2 を持つ接続の pid（この試験の場面が取った物）。場面の接続（ctx.client）ごとに控える。鍵を持つ自分の接続かの確かめに使う */
const returnLockPids = new WeakMap<PgClient, number>();
const orderAdminContexts = new WeakMap<PgClient, OrderAdminContext>();

// ---------------------------------------------------------------------------------------------------------------------
// 材料: 注文（明細つき）
// ---------------------------------------------------------------------------------------------------------------------

export type OrderRowsLine = {
  /** 購入時の商品名の写し。省くと試験ごとに固有の名前 */
  itemName?: string;
  /** 既定 ホワイト */
  color?: string;
  /** 既定 M */
  size?: string;
  /** 既定 1 */
  quantity?: number;
  /** 単価。既定 5000 */
  unitPrice?: number;
  /** 明細の金額（line_total）。省くと単価 × 数量。「3点100円」のように割り切れない額の確かめに使う */
  lineTotal?: number;
  /** 既定 stock。backorder は割当を作らない受注生産 */
  fulfillmentType?: 'stock' | 'backorder';
  /** 入金済みの割当（A）の数。既定は数量ぜんぶ（stock）。数量より少なければ残りが受注生産中。未払い等では仮確保（H） */
  allocated?: number;
  /** 合成の発送で送る数（割当から消費する。allocated 以下） */
  shipped?: number;
  /** 送った数を配達済みにする */
  delivered?: boolean;
  /** 色・サイズ未確定（variant_id が NULL。割当を作らない）。作った明細は書き換えられないので、作る時に決める */
  variantMissing?: boolean;
  /**
   * この明細の商品（色・サイズ）。省くと注文の商品（input.catalog、無ければ新しい商品）。
   * 同じ商品の別の明細に待ち（割当の足りない数）がある注文で返金などの在庫の戻りが起きると、本物の入口の FIFO が戻った在庫を
   * その待ちへ割り当てて状態が変わる。待ちのある明細と在庫が戻る明細は、別の商品にして分ける
   */
  catalog?: CatalogMaterial;
};

export type OrderRowsInput = {
  /** 省くと試験ごとに固有。画面の絞り込みも DB の期待もこのメールアドレスで読む */
  email?: string;
  /** 配送先の氏名（顧客名）。既定は DEFAULT_SHIP_TO の氏名 */
  customerName?: string;
  /** 注文日（ISO）。注文日は後から変えられないので作る時に決める */
  orderedAt?: string;
  /** 注文日を今から何日前にするか（orderedAt が無い時） */
  orderedDaysAgo?: number;
  /** 既定 paid。pending は未払い、payment_in_progress は支払い手続き中、abandoned は放棄、payment_expired は期限切れの失敗 */
  status?: 'paid' | 'pending' | 'payment_in_progress' | 'abandoned' | 'payment_expired';
  /** 決済の番号。省くと、入金済みの注文には試験ごとに固有の pi_… を入れる（未払い等は空） */
  paymentIntentId?: string;
  /** 省くと明細1つ（数量1・在庫の品） */
  lines?: OrderRowsLine[];
  /** 同じ商品を使う時に渡す。省くと新しい商品 */
  catalog?: CatalogMaterial;
};

export type OrderRowsLineMaterial = {
  orderItemId: string;
  itemName: string;
  color: string;
  size: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  allocated: number;
  shipped: number;
};

export type OrderRowsMaterial = {
  orderId: string;
  /** 画面の注文ID（ORD-XXXXXXXX） */
  orderNumber: string;
  email: string;
  customerName: string;
  /** 注文日（DB が持つ値の ISO） */
  orderedAt: string;
  paymentIntentId: string | null;
  itemId: number;
  variantId: number;
  lines: OrderRowsLineMaterial[];
  /** 合成の発送（lines の shipped）の番号。送っていなければ空 */
  fulfillmentIds: string[];
};

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * 明細を自由に決めた注文を作る（createShippingMaterial の複数明細版）。数量・単価・割当・一部発送・配達済み・色サイズ未確定・
 * 顧客名・メールアドレス・注文日・状態を決められる。注文・明細・割当は1つの G-1 の取引（本物の入荷の入口 → 色・サイズを押さえる →
 * 注文と明細 → 割当）で作り、発送は合成の発送（A を消費する）で足す。作った注文は、終わりの後始末の対象に自動で足す。
 */
export async function createOrderRowsMaterial(ctx: OrderAdminContext, input: OrderRowsInput = {}): Promise<OrderRowsMaterial> {
  const { client } = ctx;
  assertLocalE2eDb(client);
  const status = input.status ?? 'paid';
  const insertStatus = status === 'abandoned' ? 'payment_in_progress' : status === 'payment_expired' ? 'pending' : status;
  const paid = status === 'paid';
  const email = input.email ?? uniqueEmail('g4-rows');
  const customerName = input.customerName ?? DEFAULT_SHIP_TO.fullName;
  const orderedAt = input.orderedAt ?? (input.orderedDaysAgo !== undefined ? daysAgoIso(input.orderedDaysAgo) : null);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
  const lineInputs = input.lines ?? [{}];
  // 注文の商品は、商品を指定していない明細があるときだけ作る
  const catalog: CatalogMaterial = input.catalog
    ?? (lineInputs.some((line) => !line.catalog) ? undefined : lineInputs[0]?.catalog)
    ?? (await createCatalogMaterial(client));
  const paymentIntentId = input.paymentIntentId ?? (paid ? `pi_e2e_${suffix}` : null);

  const lines = lineInputs.map((line, index) => {
    const quantity = line.quantity ?? 1;
    const unitPrice = line.unitPrice ?? UNIT_PRICE;
    const fulfillmentType = line.fulfillmentType ?? 'stock';
    const allocated = line.variantMissing || fulfillmentType === 'backorder' ? 0 : (line.allocated ?? quantity);
    return {
      catalog: line.catalog ?? catalog,
      itemName: line.itemName ?? `E2E明細${index + 1}-${suffix.slice(0, 8)}`,
      color: line.color ?? 'ホワイト',
      size: line.size ?? 'M',
      quantity,
      unitPrice,
      lineTotal: line.lineTotal ?? unitPrice * quantity,
      fulfillmentType,
      allocated,
      shipped: line.shipped ?? 0,
      delivered: line.delivered ?? false,
      variantMissing: line.variantMissing ?? false,
    };
  });
  const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  // 入れる在庫は色・サイズ（variant）ごとに、割当が引く数の合計
  const stockByVariant = new Map<number, { itemId: number; variantId: number; quantity: number }>();
  for (const line of lines) {
    if (line.allocated === 0) continue;
    const entry = stockByVariant.get(line.catalog.variantId) ?? { itemId: line.catalog.itemId, variantId: line.catalog.variantId, quantity: 0 };
    entry.quantity += line.allocated;
    stockByVariant.set(line.catalog.variantId, entry);
  }

  const created = await withGroupG1Material(client, async () => {
    // 在庫は本物の入荷の入口で入れる（割当が引く分）。色・サイズを押さえてから注文を作る
    for (const stock of stockByVariant.values()) await seedE2eRestock(client, stock);
    await lockE2eInventory(client, { variantIds: [...new Set(lines.map((line) => line.catalog.variantId))] });
    const order = (
      await client.query(
        `insert into public.orders
           (session_id, checkout_session_id, status, subtotal_amount, shipping_amount, discount_amount, total_amount, paid_amount, paid_at, currency,
            shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_building,
            shipping_phone, user_id, created_at, payment_intent_id)
         values ($1, $2, $3::public.order_status, $4, 0, 0, $4, $5,
                 case when $6::boolean then coalesce($7::timestamptz, now()) else null end, 'jpy',
                 $8, $9, $10, $11, $12, $13, $14, $15, null, coalesce($7::timestamptz, now()), $16)
         returning id, created_at`,
        [
          `e2e-g4-${suffix}`, `cs_e2e_g4_${suffix}`, insertStatus, total, paid ? total : null, paid, orderedAt,
          email, customerName, DEFAULT_SHIP_TO.postalCode, DEFAULT_SHIP_TO.prefecture, DEFAULT_SHIP_TO.city, DEFAULT_SHIP_TO.address,
          DEFAULT_SHIP_TO.building, DEFAULT_SHIP_TO.phone, paymentIntentId,
        ],
      )
    ).rows[0] as { id: string; created_at: Date };
    const itemIds: string[] = [];
    for (const line of lines) {
      const item = (
        await client.query(
          `insert into public.order_items
             (order_id, item_id, item_name, item_price, color, size, quantity, line_total, variant_id, fulfillment_type)
           values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
          [
            order.id, line.catalog.itemId, line.itemName, line.unitPrice, line.color, line.size, line.quantity, line.lineTotal,
            line.variantMissing ? null : line.catalog.variantId, line.fulfillmentType,
          ],
        )
      ).rows[0] as { id: string };
      itemIds.push(item.id);
      if (line.allocated > 0) await seedE2eAllocation(client, { orderItemId: item.id, quantity: line.allocated, kind: allocationKindOf(insertStatus) });
    }
    // 放棄は支払い手続き中の仮確保（H）を本物の解放で0にして決める。期限切れは未払いの注文を期限切れの失敗に進める
    if (status === 'abandoned') await releaseE2eUnpaidOrder(client, { orderId: order.id, status: 'abandoned' });
    if (status === 'payment_expired') {
      await lockE2eInventory(client, { orderIds: [order.id] });
      const released = (
        await client.query("select released from public.release_stock_for_unpaid_order($1::uuid, 'pending', 'failed', 'stripe_voucher_expired')", [order.id])
      ).rows[0] as { released: boolean } | undefined;
      if (released?.released !== true) throw new Error('E2E_ORDER_EXPIRE_FAILED');
    }
    return { orderId: order.id, orderedAt: order.created_at.toISOString(), itemIds };
  });
  ctx.trackOrder(created.orderId);

  // 一部発送: 合成の発送（A を消費する）。送った数と配達済みで別の発送にする
  const fulfillmentIds: string[] = [];
  const shipments: Array<{ delivered: boolean; lines: Array<{ orderItemId: string; quantity: number }> }> = [
    { delivered: false, lines: [] },
    { delivered: true, lines: [] },
  ];
  lines.forEach((line, index) => {
    if (line.shipped > 0) shipments[line.delivered ? 1 : 0].lines.push({ orderItemId: created.itemIds[index], quantity: line.shipped });
  });
  for (const shipment of shipments) {
    if (shipment.lines.length === 0) continue;
    const shippedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    fulfillmentIds.push(
      await seedE2eShipment(client, {
        orderId: created.orderId,
        lines: shipment.lines,
        shippedAt,
        deliveredAt: shipment.delivered ? new Date(Date.now() - 60 * 60 * 1000).toISOString() : undefined,
        trackingNumber: `E2E-G4-${randomUUID().slice(0, 8).toUpperCase()}`,
      }),
    );
  }

  return {
    orderId: created.orderId,
    orderNumber: orderNumberOf(created.orderId),
    email,
    customerName,
    orderedAt: created.orderedAt,
    paymentIntentId,
    itemId: catalog.itemId,
    variantId: catalog.variantId,
    lines: lines.map((line, index) => ({
      orderItemId: created.itemIds[index],
      itemName: line.itemName,
      color: line.color,
      size: line.size,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      allocated: line.allocated,
      shipped: line.shipped,
    })),
    fulfillmentIds,
  };
}

/** 明細の一部を返金する（返金を受け付けて、成功の結果を書く。本物の入口 begin_order_refund・record_order_refund_result）。返金の番号を返す */
export async function refundLineInDb(
  ctx: OrderAdminContext,
  material: Pick<OrderRowsMaterial, 'orderId' | 'lines'>,
  input: { lineIndex: number; quantity: number; amount: number; beforeShipment?: boolean },
): Promise<string> {
  const began = await beginRefund(ctx.client, material.orderId, {
    actorId: ctx.actorId,
    lines: [{ orderItemId: material.lines[input.lineIndex].orderItemId, quantity: input.quantity, beforeShipment: input.beforeShipment ?? true }],
    amount: input.amount,
  });
  await recordRefundResult(ctx.client, began.refundId);
  return began.refundId;
}

/** その注文の未解決の要対応（支払いの要対応）を1件作る。本物の入口 record_payment_exception（理由 state_conflict。決済の番号は試験ごとに固有） */
export async function openPaymentExceptionInDb(client: PgClient, orderId: string): Promise<void> {
  assertLocalE2eDb(client);
  const recorded = await client.query(
    "select * from public.record_payment_exception($1::text, 'state_conflict', null, null, null, null, $2::uuid)",
    [`pi_e2e_exc_${randomUUID().replaceAll('-', '').slice(0, 20)}`, orderId],
  );
  if (recorded.rows[0]?.is_new !== true) throw new Error('E2E_PAYMENT_EXCEPTION_NOT_CREATED');
}

/** 返品の途中の状態を数量で分けた注文。10点を全部送り、返品の記録を4つ付ける（元の発送済みの数と二重に数えない確かめ用） */
export const RETURN_STATES_QUANTITIES = {
  total: 10, requested: 1, inProgress: 2, refundWaiting: 3, returned: 1, shipped: 3,
} as const;

/** 返品の材料の注文（画面の絞り込みも DB の期待も email で読む） */
export type ReturnStatesMaterial = { orderId: string; orderNumber: string; email: string; orderItemId: string; itemName: string };

/**
 * お客様の返品の申し込み（返品申請中）を、本物の入口 customer_request_return で作る。受付の設定（shop_return_settings の1行）を
 * 一時的に「受け付ける」にして、終わりに元へ戻す。設定を触るので、呼び手は鍵 14314,2 を持つこと
 * （withOrderAdminScenario(…, { returnSettings: true })。この試験の場面が取った鍵を、場面の接続 pid で確かめ、持っていなければ投げる。
 * ほかのワーカーが同じ鍵を持っているだけでは通らない）。
 */
async function requestReturnInDb(
  client: PgClient,
  input: { orderId: string; fulfillmentId: string; orderItemId: string; customerId: string; quantity: number },
): Promise<void> {
  const lockPid = returnLockPids.get(client);
  const locked = lockPid === undefined
    ? null
    : await client.query(
      "select exists (select 1 from pg_catalog.pg_locks where locktype = 'advisory' and classid = 14314 and objid = 2 and objsubid = 2 and granted and pid = $1::integer) as held",
      [lockPid],
    );
  if (locked?.rows[0].held !== true) throw new Error('E2E_RETURN_SETTINGS_LOCK_REQUIRED');
  const saved = (await client.query('select requests_enabled, request_types, notice_text from public.shop_return_settings where id = 1')).rows[0];
  await client.query("update public.shop_return_settings set requests_enabled = true, request_types = 'returns_only', notice_text = '' where id = 1");
  try {
    const lines = [{
      fulfillment_id: input.fulfillmentId, order_item_id: input.orderItemId, quantity: input.quantity, reason: 'other',
      customer_note: '試験の詳しい内容', requested_resolution: 'refund', requested_exchange_variant_id: null, photos: [],
    }];
    await client.query('select * from public.customer_request_return($1::uuid, $2::uuid, $3::uuid, $4::jsonb)', [
      input.orderId, input.customerId, randomUUID(), JSON.stringify(lines),
    ]);
  } finally {
    await client.query('update public.shop_return_settings set requests_enabled = $1, request_types = $2, notice_text = $3 where id = 1', [
      saved.requests_enabled, saved.request_types, saved.notice_text,
    ]);
  }
}

/**
 * 1つの注文に、返品申請中 1・返品受付中 2・返金待ち 3・返品済み 1 の返品を付ける（残り 3 は発送済みのまま）。
 * 返品は return-test-utils の道具と本物の入口で作る: 注文と発送は createShippedOrder、返品申請中はお客様の申し込み
 * （customer_request_return。会員の注文にする）、返品受付中は createReturnInDb、返金待ちは受け取り（receiveReturnInDb。相談）、
 * 返品済みは受け取り（今返金）と返金の結果（recordRefundResult）。Stripe には頼まない。返品の設定を触るので、呼び手は
 * withOrderAdminScenario(…, { returnSettings: true }) の中で呼ぶ（鍵 14314,2 → 190520,0 の順）。
 */
export async function createReturnStatesMaterial(ctx: OrderAdminContext, input: { email?: string } = {}): Promise<ReturnStatesMaterial> {
  const { client } = ctx;
  const quantities = RETURN_STATES_QUANTITIES;
  const member = await createMemberUser(client, 'g4-returns');
  const email = input.email ?? uniqueEmail('g4-returns');
  const itemName = `E2E返品-${randomUUID().slice(0, 8)}`;
  const fx = await createShippedOrder(client, 'g4-returns', [{ name: itemName, quantity: quantities.total, fulfillmentType: 'stock' }], {
    userId: member.userId, email,
  });
  const orderItemId = fx.orderItemIds[0];
  const create = (quantity: number) => createReturnInDb(client, fx, { lines: [{ orderItemId, quantity }], notify: false });

  // 返品申請中（お客様の申し込み）
  await requestReturnInDb(client, { orderId: fx.orderId, fulfillmentId: fx.fulfillmentId, orderItemId, customerId: member.userId, quantity: quantities.requested });
  // 返品受付中（作っただけ）
  await create(quantities.inProgress);
  // 返金待ち（全部を相談で受け取った）
  const waiting = await create(quantities.refundWaiting);
  await receiveReturnInDb(client, waiting.returnId, fx.actorId, {
    units: [{ lineId: waiting.lineIds[orderItemId], disposition: 'restocked', quantity: quantities.refundWaiting }],
    choice: 'consult',
    notify: false,
  });
  // 返品済み（今返金し、Stripe が受け付けた）
  const done = await create(quantities.returned);
  const received = await receiveReturnInDb(client, done.returnId, fx.actorId, {
    units: [{ lineId: done.lineIds[orderItemId], disposition: 'restocked', quantity: quantities.returned }],
    choice: 'now',
    notify: false,
  });
  await recordRefundResult(client, received.refundId as string);
  return { orderId: fx.orderId, orderNumber: orderNumberOf(fx.orderId), email, orderItemId, itemName };
}

/**
 * 開いているキャンセルの申し込み（1点）を持つ注文: 3点のうち 1点がキャンセル申請中、残り 2点が発送準備中。
 * キャンセルの申し込みは DB 材料の insertCancelRequest で直に書く（return-test-utils に道具が無い。返品の材料とは違い、本物の入口は通さない）。
 */
export async function createCancelRequestMaterial(ctx: OrderAdminContext, input: { email?: string } = {}): Promise<OrderRowsMaterial> {
  const { client } = ctx;
  const order = await createOrderRowsMaterial(ctx, { email: input.email, lines: [{ quantity: 3, allocated: 3 }] });
  await withGroupG1Material(client, async () => {
    await lockE2eInventory(client, { orderIds: [order.orderId] });
    await insertCancelRequest(client, { orderId: order.orderId, status: 'requested', lines: [{ orderItemId: order.lines[0].orderItemId, quantity: 1 }] });
  });
  return order;
}

// ---------------------------------------------------------------------------------------------------------------------
// 日付・金額の書き方（画面と同じ）
// ---------------------------------------------------------------------------------------------------------------------

/** 日本時間の暦日（YYYY-MM-DD） */
export function jstDateOf(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 日本時間の YYYY-MM-DD HH:mm（表の「注文日」の書き方） */
export function jstDateTimeOf(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** ¥12,800 の形 */
export function yen(value: number): string {
  return `¥${value.toLocaleString('en-US')}`;
}

/** 表の1行の12のセルの文字（空の顧客名はゲスト、空のメールは -、交換の行は商品名に（交換品）） */
export function expectedCellsOf(row: AdminOrderExportRow): string[] {
  const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();
  return [
    orderNumberOf(row.orderId),
    jstDateTimeOf(row.orderCreatedAt),
    clean(row.customerName || 'ゲスト'),
    clean(row.customerEmail || '-'),
    clean(`${row.itemName}${row.isExchange ? '（交換品）' : ''}`),
    row.color || '-',
    row.size || '-',
    String(row.quantity),
    yen(row.unitPrice),
    yen(row.lineAmount),
    yen(row.refundAmount),
    ADMIN_ITEM_STATUS_LABELS[row.status],
  ];
}

/** 行の aria-label（一覧の行の名前: 「注文番号 商品名 の詳細を開く」） */
export function rowLabelOf(row: Pick<AdminOrderExportRow, 'orderId' | 'itemName'>): string {
  return `${orderNumberOf(row.orderId)} ${row.itemName} の詳細を開く`;
}

// ---------------------------------------------------------------------------------------------------------------------
// DB の読み: 一回の呼出し（同一時点）。頁を歩かない
// ---------------------------------------------------------------------------------------------------------------------

export type ExportSnapshot = { rowCount: number; orderCount: number; rows: AdminOrderExportRow[] };

const exportSchema = z
  .object({
    rowCount: z.number().int().nonnegative(),
    orderCount: z.number().int().nonnegative(),
    rows: adminOrderExportRowSchema.array(),
  })
  .refine((value) => value.rowCount === value.rows.length && value.orderCount === new Set(value.rows.map((row) => row.orderId)).size);

const EXPORT_SQL = 'select public.export_admin_order_item_rows(_filters => $1::jsonb, _actor_id => $2::uuid) as result';

/**
 * 絞り込みに合う全行を、DB の関数 export_admin_order_item_rows の1回の呼出し（同一時点）で読む。一覧の全頁と同じ並び
 * （注文日の新しい順 → 注文 → 明細 → 状態の定義順）。権限が無ければ DB の関数が断る（誤りのまま投げる）。
 */
export async function readExportSnapshot(client: PgClient, actorId: string, filters: AdminOrderItemFilters): Promise<ExportSnapshot> {
  const result = await client.query(EXPORT_SQL, [JSON.stringify(toFilterPayload(filters)), actorId]);
  return exportSchema.parse(result.rows[0].result);
}

/** 書き出しの上限（app.group_g_export_cap_rows）を、この接続の bridge の書き出しにだけ効かせる（取引の中の SET LOCAL。取引を終えると戻る） */
const exportCaps = new WeakMap<PgClient, number>();

export function setExportCapInDb(client: PgClient, cap: number): void {
  exportCaps.set(client, cap);
}

export function resetExportCapInDb(client: PgClient): void {
  exportCaps.delete(client);
}

/** 一覧の注文の上限（app.group_g_list_cap_orders）を、この接続だけで下げる。上限は下げる側にしか効かない。finally で resetListCapInDb */
export async function setListCapInDb(client: PgClient, cap: number): Promise<void> {
  await client.query("select pg_catalog.set_config('app.group_g_list_cap_orders', $1, false)", [String(cap)]);
}

export async function resetListCapInDb(client: PgClient): Promise<void> {
  await client.query('reset app.group_g_list_cap_orders').catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------------------------------
// bridge: 画面が呼ぶ窓口 → DB の公開関数
// ---------------------------------------------------------------------------------------------------------------------

export type OrderAdminReply =
  | { status: number; json: unknown }
  | { status: number; csv: string; filename: string };

export type OrderAdminBridgeOptions = {
  /** 一覧の答えの要対応の件数（既定は 0）。窓口は全注文から数えるが、並行して動く試験が変えるので固定する */
  attention?: { returnAttention: { requested: number; refundWaiting: number }; cancelRequestAttention: number };
};

/**
 * DB の拒否を、窓口と同じ { code, error } と HTTP の状態にする。message と SQLSTATE が表と完全に一致した時だけ分類し、
 * 表に無い物・崩れた戻りは固定の500（DB の文は出さない）。
 */
function errorReply(error: unknown): OrderAdminReply {
  const { message, code } = (error ?? {}) as { message?: unknown; code?: unknown };
  if (typeof message === 'string' && Object.hasOwn(ADMIN_ORDER_ERRORS, message)) {
    const [sqlstate, status, text] = ADMIN_ORDER_ERRORS[message];
    if (code === sqlstate) return { status, json: { code: message, error: text } };
  }
  return { status: 500, json: { error: ADMIN_ORDER_TEXT.failed } };
}

async function exportViaBridge(db: PgClient, actorId: string, filters: AdminOrderItemFilters): Promise<ExportSnapshot> {
  const params = [JSON.stringify(toFilterPayload(filters)), actorId];
  const cap = exportCaps.get(db);
  if (cap === undefined) return exportSchema.parse((await db.query(EXPORT_SQL, params)).rows[0].result);
  await db.query('begin');
  try {
    await db.query("select pg_catalog.set_config('app.group_g_export_cap_rows', $1, true)", [String(cap)]);
    const raw = (await db.query(EXPORT_SQL, params)).rows[0].result;
    await db.query('rollback');
    return exportSchema.parse(raw);
  } catch (error) {
    await db.query('rollback').catch(() => undefined);
    throw error;
  }
}

/**
 * 一覧・CSV の窓口への要求 1 件を、実行者 actorId の DB の公開関数へ渡して、窓口と同じ形の答えにする。決めていない方法・道は null。
 * bridge の page.route と、試験が窓口を画面なしで呼ぶのに共有する。
 */
export async function dispatchOrderAdminRequest(
  db: PgClient,
  actorId: string,
  method: string,
  url: URL,
  options: OrderAdminBridgeOptions = {},
): Promise<OrderAdminReply | null> {
  if (method !== 'GET') return null;

  if (url.pathname === '/api/admin/order-items') {
    const parsed = parseOrderItemQuery(url.searchParams);
    if (!parsed.ok) return { status: 400, json: { error: 'Invalid query' } };
    try {
      const result = await db.query(
        'select public.list_admin_order_item_rows(_filters => $1::jsonb, _limit => $2::integer, _offset => $3::integer, _actor_id => $4::uuid) as result',
        [JSON.stringify(toFilterPayload(parsed.filters)), ORDER_ITEM_PAGE_SIZE, (parsed.page - 1) * ORDER_ITEM_PAGE_SIZE, actorId],
      );
      const data = parseOrderItemListResult(result.rows[0].result, parsed.page);
      const attention = options.attention ?? { returnAttention: { requested: 0, refundWaiting: 0 }, cancelRequestAttention: 0 };
      return { status: 200, json: { data, returnAttention: attention.returnAttention, cancelRequestAttention: attention.cancelRequestAttention } };
    } catch (error) {
      return errorReply(error);
    }
  }

  if (url.pathname === '/api/admin/order-items/export') {
    const parsed = parseOrderItemQuery(url.searchParams);
    if (url.searchParams.has('page') || !parsed.ok) return { status: 400, json: { error: 'Invalid query' } };
    try {
      const snapshot = await exportViaBridge(db, actorId, parsed.filters);
      return { status: 200, csv: buildOrderItemCsv(snapshot.rows), filename: orderItemCsvFilename(new Date()) };
    } catch (error) {
      return errorReply(error);
    }
  }

  return null;
}

/**
 * 注文一覧表の窓口（GET /api/admin/order-items・…/export）への画面の要求を、実行者 actorId で DB の公開関数へ橋渡しする。
 * 権限の許否は DB の関数が決める。後から登録した page.route が先に効くので、試験が答えを止めたり失敗させたりする時は、
 * これより後に登録して route.fallback() で渡す。
 */
export async function mockOrderAdminBridge(
  page: Page,
  client: PgClient,
  actorId: string,
  options: OrderAdminBridgeOptions = {},
): Promise<void> {
  assertLocalE2eDb(client);
  await page.route(
    (url) => url.pathname === '/api/admin/order-items' || url.pathname === '/api/admin/order-items/export',
    async (route) => {
      const request = route.request();
      let reply: OrderAdminReply | null;
      try {
        reply = await dispatchOrderAdminRequest(client, actorId, request.method(), new URL(request.url()), options);
      } catch (error) {
        reply = errorReply(error);
      }
      if (reply === null) {
        await route.fallback();
        return;
      }
      if ('csv' in reply) {
        await route.fulfill({
          status: reply.status,
          contentType: 'text/csv; charset=utf-8',
          headers: { 'Content-Disposition': `attachment; filename="${reply.filename}"`, 'Cache-Control': 'no-store' },
          body: reply.csv,
        });
        return;
      }
      await route.fulfill({ status: reply.status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(reply.json) });
    },
  );
}

/** 要対応の窓口（/api/admin/order-attention）を、渡した欄で答える（省くと空の欄。管理画面の背景の窓口の固定と同じ形） */
export async function mockOrderAttention(
  page: Page,
  attention: {
    exceptions?: unknown[];
    reviews?: unknown[];
    deliveries?: unknown[];
    emailSending?: { paused: boolean; reasonLabel: string | null } | null;
  } = {},
): Promise<void> {
  const exceptions = attention.exceptions ?? [];
  const reviews = attention.reviews ?? [];
  const deliveries = attention.deliveries ?? [];
  await page.route('**/api/admin/order-attention', (route) =>
    fulfillJson(route, {
      data: {
        exceptions,
        reviews,
        deliveries,
        emailSending: attention.emailSending ?? null,
        counts: { exceptions: exceptions.length, reviews: reviews.length, deliveries: deliveries.length },
      },
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// 画面の読み方・操作: 注文一覧表
// ---------------------------------------------------------------------------------------------------------------------

/** 入替の材料。権限変更の場面だけ context を渡す（通常は withOrderAdminScenario の context を接続から得る）。 */
export type SwapMaterialInput = {
  donorReady?: number; takerWaiting?: number; catalog?: CatalogMaterial;
  donorDaysAgo?: number; takerDaysAgo?: number; donorStatus?: 'paid' | 'pending';
  differentVariant?: boolean; takerExchange?: boolean; takerFeeWaiting?: boolean;
  takerReview?: boolean; donorCancelRequested?: boolean; donorRefundProcessing?: boolean;
  sameOrderReady?: boolean; context?: OrderAdminContext;
};

/**
 * 新しいメールの2注文。同じ variant の出し手を先に作り、在庫待ちの受け手は最後に作る（材料の入荷で先の待ちに FIFO しない）。
 * 交換品・未払い手数料・返金処理中は既存DB fixtureによる合成の状態。入荷・割当・発送は既存 G-1 の入口を使う。
 */
export async function createSwapMaterial(client: PgClient, input: SwapMaterialInput = {}) {
  assertLocalE2eDb(client);
  const ctx = input.context ?? orderAdminContexts.get(client);
  if (!ctx || ctx.client !== client) throw new Error('E2E_ORDER_ADMIN_CONTEXT_REQUIRED');
  const catalog = input.catalog ?? await createCatalogMaterial(client);
  const donor = await createOrderRowsMaterial(ctx, {
    catalog, orderedDaysAgo: input.donorDaysAgo ?? 10, status: input.donorStatus,
    lines: [{ quantity: input.donorReady ?? 3 }],
  });
  if (input.donorCancelRequested) await withGroupG1Material(client, async () => {
    await lockE2eInventory(client, { orderIds: [donor.orderId] });
    await insertCancelRequest(client, { orderId: donor.orderId, lines: [{ orderItemId: donor.lines[0].orderItemId, quantity: 1 }] });
  });
  if (input.donorRefundProcessing) await beginRefund(client, donor.orderId, {
    actorId: ctx.actorId, amount: UNIT_PRICE,
    lines: [{ orderItemId: donor.lines[0].orderItemId, quantity: 1, beforeShipment: true }],
  });
  const exchange = input.takerExchange || input.takerFeeWaiting;
  const quantity = input.takerWaiting ?? 2;
  const taker = await createOrderRowsMaterial(ctx, {
    catalog: input.differentVariant ? await createCatalogMaterial(client) : catalog,
    orderedDaysAgo: input.takerDaysAgo ?? 5,
    lines: [
      { quantity, allocated: exchange ? quantity : 0, shipped: exchange ? quantity : 0 },
      ...(input.sameOrderReady ? [{ quantity: 1 }] : []),
    ],
  });
  let takerOrderItemId = taker.lines[0].orderItemId;
  if (exchange) takerOrderItemId = await withGroupG1Material(client, async () => {
    await lockE2eInventory(client, { orderIds: [taker.orderId] });
    const returned = await insertReturnRecord(client, {
      orderId: taker.orderId, feeDueAmount: input.takerFeeWaiting ? 100 : 0,
      lines: [{ fulfillmentId: taker.fulfillmentIds[0], orderItemId: takerOrderItemId, quantity,
        resolution: 'exchange', exchangeVariantId: taker.variantId, exchangeMethod: 'make' }],
    });
    const id = await seedGroupG4Exchange(client, { orderId: taker.orderId, sourceItemId: takerOrderItemId, returnLineId: returned.lineIds[0], quantity });
    await setE2eOrderStatus(client, [taker.orderId], 'shipped');
    return id;
  });
  if (input.takerReview) await holdPaymentReview(client, taker.orderId);
  return { catalog, donor, taker, donorOrderItemId: donor.lines[0].orderItemId, takerOrderItemId };
}

/** 画面を通さない実際の入替（競合の再現にも使う）。引数の actor は常に DB へ渡す。 */
export async function swapInDb(client: PgClient, actorId: string, input: AllocationSwapInput & { orderId: string }): Promise<AllocationSwapResult> {
  assertLocalE2eDb(client);
  const raw = (await client.query(
    `select public.admin_swap_order_allocations(_order_id => $1::uuid, _taker_order_item_id => $2::uuid,
      _donor_order_item_id => $3::uuid, _quantity => $4::integer, _reason => $5::text, _actor_id => $6::uuid, _request_key => $7::uuid) as result`,
    [input.orderId, input.takerOrderItemId, input.donorOrderItemId, input.quantity, input.reason, actorId, input.requestKey],
  )).rows[0].result;
  return parseAllocationSwapResult(raw, input.orderId, input);
}

function swapErrorReply(error: unknown): OrderAdminReply {
  const { message, code } = (error ?? {}) as { message?: unknown; code?: unknown };
  if (typeof message === 'string' && Object.hasOwn(ALLOCATION_SWAP_ERRORS, message)) {
    const [sqlstate, status, text] = ALLOCATION_SWAP_ERRORS[message];
    if (code === sqlstate) return { status, json: { code: message, error: text } };
  }
  return { status: 500, json: { error: ALLOCATION_SWAP_TEXT.failed } };
}

// storeのdetailSchemaはserver-onlyの非公開定義なので、公開済みの純粋な部品から同じ検査を組み立てる。
const nullableDetailText = z.string().nullable();
const detailMoney = integer.nonnegative();
const orderDetailCoreSchema = z.object({
  order: z.object({
    id: z.string().uuid(), status: z.enum(ORDER_STATUSES), createdAt: timestamp, paidAt: timestamp.nullable(),
    customerKind: z.enum(['guest', 'member']), customerName: nullableDetailText, customerEmail: nullableDetailText, currency: z.string().min(1),
    shipTo: z.object({ fullName: nullableDetailText, postalCode: nullableDetailText, prefecture: nullableDetailText, city: nullableDetailText,
      address: nullableDetailText, building: nullableDetailText, phone: nullableDetailText }),
  }),
  amounts: z.object({ productNet: detailMoney, discount: detailMoney, shipping: detailMoney, total: detailMoney,
    paidAmount: detailMoney.nullable(), refundedAmount: detailMoney, refundAttachedToRows: detailMoney,
    refundNotAttached: integer, refundProcessingAmount: detailMoney }),
  rows: z.array(adminOrderExportRowSchema.omit({ orderId: true, orderCreatedAt: true, customerName: true, customerEmail: true })
    .extend({ statusRank: integer.min(1).max(12), blockedReasons: adminOrderBlockedReasonsSchema })
    .refine((row) => ORDER_ITEM_STATUS_ORDER[row.statusRank - 1] === row.status)),
  attention: z.object({
    paymentExceptions: z.array(z.object({ id: z.string().uuid(), reason: z.string(), detectionCount: integer.positive(), firstDetectedAt: timestamp })),
    review: z.object({ reason: z.string(), markedAt: timestamp.nullable() }).nullable(),
    deliveries: z.array(z.object({ fulfillmentId: z.string().uuid(), kind: z.string(), openedAt: timestamp })),
  }),
  permissions: z.object({ read: z.boolean(), manage: z.boolean(), refund: z.boolean(), return: z.boolean(), allocate: z.boolean(), shippingRead: z.boolean() }),
});

/**
 * 詳細・品物履歴・入替候補・入替を公開DB関数へ渡す。summary/発送/票は固定の写し、権限・状態・金額は get_admin_order_detail の答え。
 * 認可/MFA/CSRF/監査は通らない。DBエラーは実装の表と SQLSTATE の組だけで分類する。接続の問い合わせは要求単位で直列にする。
 */
export async function mockOrderDetailBridge(page: Page, client: PgClient, actorId: string, summary: Parameters<typeof adminOrderDetail>[0]): Promise<void> {
  assertLocalE2eDb(client);
  let tail: Promise<unknown> = Promise.resolve();
  await page.route((url) => /^\/api\/admin\/orders\/[0-9a-f-]{36}(\/history|\/allocations\/(swap|swap-candidates))?$/.test(url.pathname), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const orderId = url.pathname.split('/')[4];
    const isSwap = url.pathname.includes('/allocations/');
    if (request.method() !== (url.pathname.endsWith('/swap') ? 'POST' : 'GET')) return route.fallback();
    const run = tail.then(async () => {
      try {
        let body: unknown;
        if (url.pathname.endsWith('/swap')) {
          const parsed = allocationSwapInputSchema.safeParse(request.postDataJSON());
          if (!parsed.success) {
            const reasonOnly = parsed.error.issues.every((issue) => issue.path.length === 1 && issue.path[0] === 'reason'
              && issue.code === 'too_small' && issue.minimum === 1);
            const code = reasonOnly ? 'GROUP_G_SWAP_REASON_REQUIRED' : 'GROUP_G_ARGUMENT_INVALID';
            return fulfillJson(route, { code, error: ALLOCATION_SWAP_ERRORS[code][2] }, ALLOCATION_SWAP_ERRORS[code][1]);
          }
          body = await swapInDb(client, actorId, { orderId, ...parsed.data });
        } else if (url.pathname.endsWith('/swap-candidates')) {
          // routeはquery parserをexportしていないので、同じUUID/単一キーの検査をここで行う。
          const parsedOrderId = z.string().uuid().safeParse(orderId);
          const item = z.string().uuid().safeParse(url.searchParams.get('orderItemId'));
          if (!parsedOrderId.success || !item.success || [...url.searchParams.keys()].some((key) => key !== 'orderItemId')
            || url.searchParams.getAll('orderItemId').length !== 1) {
            return fulfillJson(route, { code: 'GROUP_G_ARGUMENT_INVALID', error: ALLOCATION_SWAP_ERRORS.GROUP_G_ARGUMENT_INVALID[2] },
              ALLOCATION_SWAP_ERRORS.GROUP_G_ARGUMENT_INVALID[1]);
          }
          const rows = (await client.query(
            'select * from public.list_admin_allocation_swap_candidates(_order_id => $1::uuid, _taker_order_item_id => $2::uuid, _actor_id => $3::uuid)',
            [parsedOrderId.data, item.data, actorId],
          )).rows;
          body = { data: parseAllocationSwapCandidates(rows.map((row) => ({ donorOrderId: row.donor_order_id,
            donorOrderItemId: row.donor_order_item_id, orderCreatedAt: new Date(row.order_created_at).toISOString(),
            swappableQuantity: Number(row.swappable_quantity), takerQuantity: Number(row.taker_quantity) })), orderId) };
        } else if (url.pathname.endsWith('/history')) {
          // 品物履歴の読取失敗時、実routeは200でitemStatesFailed:trueを返すが、このbridgeは500（依存するcaseなし）。
          const rows = (await client.query('select * from public.list_admin_order_item_state_history(_order_id => $1::uuid, _actor_id => $2::uuid)', [orderId, actorId])).rows;
          const visible = rows.slice(0, 300).map((row) => itemStateHistoryDbRowSchema.parse({ ...row,
            created_at: new Date(row.created_at).toISOString(), quantity: Number(row.quantity) }));
          body = { ...historyOf(orderId, []), itemStates: mapItemStateHistoryRows(visible, () => null), itemStatesTruncated: rows.length > 300 };
        } else {
          const core = orderDetailCoreSchema.parse((await client.query(
            'select public.get_admin_order_detail(_order_id => $1::uuid, _actor_id => $2::uuid) as result', [orderId, actorId],
          )).rows[0].result);
          body = { data: { ...adminOrderDetail({ ...summary, id: orderId }), ...core } };
        }
        await fulfillJson(route, body);
      } catch (error) {
        const reply = isSwap ? swapErrorReply(error) : errorReply(error);
        if ('json' in reply) await fulfillJson(route, reply.json, reply.status);
      }
    });
    tail = run.catch(() => undefined);
    await run;
  });
}

export type SwapSnapshot = {
  states: Array<{ orderItemId: string; status: string; quantity: number }>;
  free: number; allocated: number; held: number; onHand: number; ledger: number; transfers: number; operations: number; digest: string;
};

/** 1 SQL の同一時点の写し。数量と保存則、拒否/再送時に対象の割当・出来事・操作・在庫台帳が増減しないことを確かめる（個人情報は返さない）。 */
export async function readSwapSnapshot(client: PgClient, variantId: number, orderIds: readonly string[]): Promise<SwapSnapshot> {
  const raw = (await client.query(`with items as (select id from public.order_items where order_id = any($2::uuid[])),
    allocations as (select * from public.order_item_allocations where variant_id = $1),
    totals as (select coalesce(sum(remaining_quantity) filter(where kind='paid'),0)::int a,
      coalesce(sum(remaining_quantity) filter(where kind='payment_hold'),0)::int h from allocations),
    operations as (select * from private.group_g_operations where operation='allocation_swap' and cause_id in(select id::text from items)),
    allocation_events as (select e.* from public.order_item_allocation_events e join allocations a on a.id=e.allocation_id),
    state_events as (select e.* from public.order_item_state_events e join items i on i.id=e.order_item_id),
    movements as (select * from public.stock_movements where variant_id=$1)
    select jsonb_build_object(
      'states', coalesce((select jsonb_agg(s order by s."orderItemId",s.status) from
        (select order_item_id as "orderItemId",status,sum(unit_to-unit_from)::int quantity
          from private.group_g_item_state_ranges($2::uuid[]) group by order_item_id,status) s),'[]'::jsonb),
      'free',v.stock_quantity,'allocated',t.a,'held',t.h,'onHand',v.stock_quantity+t.a+t.h,
      'ledger',(select count(*)::int from movements),'transfers',(select count(*)::int from allocation_events where event_type='transfer'),
      'operations',(select count(*)::int from operations),
      'digest',md5(concat(
        (select string_agg(to_jsonb(a)::text,',' order by id) from allocations a),
        (select string_agg(to_jsonb(e)::text,',' order by id) from allocation_events e),
        (select string_agg(to_jsonb(e)::text,',' order by id) from state_events e),
        (select string_agg(to_jsonb(o)::text,',' order by id) from operations o),
        (select string_agg(to_jsonb(m)::text,',' order by id) from movements m)))) as result
    from public.item_variants v cross join totals t where v.id=$1`, [variantId, orderIds])).rows[0].result;
  return raw as SwapSnapshot;
}

const LOADING_TEXT = '注文一覧を読み込み中です...';

const FIELD_LABELS = {
  dateFrom: '注文日（から）',
  dateTo: '注文日（まで）',
  orderNumber: '注文ID',
  customer: '顧客名',
  email: 'メールアドレス',
  product: '商品名',
  color: '色',
  size: 'サイズ',
} as const;

/** 絞り込みの欄。入れた文字・日付はそのまま欄へ書く。statuses は画面の言葉（受注生産中 など）で、ステータスのトグルをこの組にそろえる */
export type ListFilterFields = Partial<Record<keyof typeof FIELD_LABELS, string>> & {
  statuses?: readonly string[];
  attentionOnly?: boolean;
};

/** 絞り込みの形（<form aria-label="注文の絞り込み">） */
export function filterForm(page: Page): Locator {
  return page.getByRole('form', { name: '注文の絞り込み', exact: true });
}

/** ステータスの12のトグルの入れ物（fieldset の legend「ステータス」） */
export function statusGroup(page: Page): Locator {
  return page.getByRole('group', { name: 'ステータス', exact: true });
}

/** 一覧の読み込みが済むまで待つ（読み込み中の文が消える。前の頁の表は読み直しの間も残るので、文の消えるのを待つ） */
async function expectListLoaded(page: Page): Promise<void> {
  await expect(page.getByText(LOADING_TEXT, { exact: true })).toHaveCount(0, { timeout: 30_000 });
}

/** action が起こす一覧の読み（GET /api/admin/order-items）の答えを待ち、画面が読み込み済みになるまで待つ */
async function waitForListRead(page: Page, action: () => Promise<void>): Promise<void> {
  const read = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/admin/order-items' && response.request().method() === 'GET',
  );
  await action();
  await read;
  await expectListLoaded(page);
}

/** 注文一覧表（/admin/orders）を開き、見出しと最初の読みが済むまで待つ */
export async function openOrderList(page: Page): Promise<void> {
  await page.goto('/admin/orders');
  await expect(page.getByRole('heading', { name: '注文一覧表', level: 1, exact: true })).toBeVisible();
  await expectListLoaded(page);
}

async function alignToggle(button: Locator, pressed: boolean): Promise<void> {
  if (((await button.getAttribute('aria-pressed')) === 'true') !== pressed) await button.click();
}

/** 絞り込みの欄を入れて「絞り込む」を押し、読み直しが済むまで待つ（渡さなかった欄は今のまま） */
export async function applyFilters(page: Page, fields: ListFilterFields): Promise<void> {
  const form = filterForm(page);
  for (const key of Object.keys(FIELD_LABELS) as Array<keyof typeof FIELD_LABELS>) {
    const value = fields[key];
    if (value !== undefined) await form.getByLabel(FIELD_LABELS[key], { exact: true }).fill(value);
  }
  if (fields.statuses !== undefined) {
    const group = statusGroup(page);
    const names = await group.getByRole('button').allInnerTexts();
    for (const name of names) await alignToggle(group.getByRole('button', { name, exact: true }), fields.statuses.includes(name));
  }
  if (fields.attentionOnly !== undefined) await alignToggle(form.getByRole('button', { name: '要対応のみ', exact: true }), fields.attentionOnly);
  await waitForListRead(page, () => form.getByRole('button', { name: '絞り込む', exact: true }).click());
}

/** 「条件をクリア」を押し、読み直しが済むまで待つ */
export async function clearFilters(page: Page): Promise<void> {
  await waitForListRead(page, () => filterForm(page).getByRole('button', { name: '条件をクリア', exact: true }).click());
}

/** 「次の頁」「前の頁」を押し、読み直しが済むまで待つ */
export async function goToListPage(page: Page, direction: 'next' | 'previous'): Promise<void> {
  await waitForListRead(page, () => page.getByRole('button', { name: direction === 'next' ? '次の頁' : '前の頁', exact: true }).click());
}

/** 件数の行（「25行（3件の注文）」）の文字 */
export async function countLineOf(page: Page): Promise<string> {
  return (await page.getByTestId('order-item-count').innerText()).trim();
}

/** 頁の表示（「1 / 2ページ」）の文字 */
export async function pageIndicatorOf(page: Page): Promise<string> {
  return (await page.getByText(/^\d+ \/ \d+ページ$/).innerText()).trim();
}

export type ListRowOnScreen = {
  /** 行の名前（「注文番号 商品名 の詳細を開く」） */
  label: string;
  /** 左から12のセルの文字。ステータスのセルは印（StatusBadge）の文字だけ */
  cells: string[];
  /** ステータスに「要対応」の印が付いている */
  needsAttention: boolean;
  /** 注文IDのリンクの行き先 */
  href: string | null;
};

/** 表の今見えている行（読み込み済みの1頁分）を、画面の文字のまま読む */
export async function listRowsOf(page: Page): Promise<ListRowOnScreen[]> {
  return page.getByTestId('order-item-row').evaluateAll((rows) =>
    rows.map((row) => {
      const text = (node: Element | null | undefined): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const cells = [...row.querySelectorAll('td')];
      return {
        label: row.getAttribute('aria-label') ?? '',
        cells: cells.map((cell, index) => (index === 11 ? text(cell.querySelector('[data-ui-badge]')) : text(cell))),
        needsAttention: text(cells[11]?.querySelector('[data-ui-tag-label]')) === '要対応',
        href: cells[0]?.querySelector('a')?.getAttribute('href') ?? null,
      };
    }),
  );
}

/** 表の見出し（左から12） */
export async function columnHeadersOf(page: Page): Promise<string[]> {
  return page.getByRole('region', { name: '注文一覧表', exact: true }).getByRole('columnheader').allInnerTexts();
}

// ---------------------------------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------------------------------

/** 「CSV出力」を押して download を待ち、中身（BOM を含む UTF-8 の文字）とファイル名を読む */
export async function downloadCsv(page: Page): Promise<{ text: string; filename: string }> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'CSV出力', exact: true }).click(),
  ]);
  const path = await download.path();
  return { text: (await readFile(path)).toString('utf8'), filename: download.suggestedFilename() };
}

/** CSV（先頭の BOM は外す）を、引用符・二重の引用符・セル内の改行を正しく読んで、行ごとのセルの組にする。行の区切りは CRLF */
export function parseCsv(text: string): string[][] {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (body[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      record.push(cell);
      cell = '';
    } else if (char === '\r' && body[index + 1] === '\n') {
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
      index += 1;
    } else cell += char;
  }
  if (cell !== '' || record.length > 0) {
    record.push(cell);
    records.push(record);
  }
  return records;
}
