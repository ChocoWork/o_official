/** @jest-environment node */
/**
 * 返品の窓口（return-store.ts）を、実際の PostgREST（ローカル Supabase の API）に通す（グループ E-3）。
 *
 * 管理画面の E2E は窓口を差し替え（P11）、窓口の単体試験は Supabase のクライアントを差し替え、DB の結合試験は pg で関数を直に呼ぶ。
 * どれも PostgREST を通らないので、名前つき引数の違い（uuid・uuid[]・jsonb の渡し方）・戻りの列の名前・jsonb のキーと camelCase への
 * 直しの食い違い・移行の NOTIFY pgrst による読み直しの誤りは、本番で店主が初めて返品を押した時まで分からない
 * （E-1 の fulfillment_postgrest、E-2 の refund_postgrest と同じ考え）。
 * ここでは service_role の本物の supabase-js の client で、窓口が呼ぶ DB の関数を通し、次の3つを確かめる:
 *  1. 直した後の答え（camelCase）が、共通の約束 C-2 の型のキーを過不足なく持つこと
 *  2. DB が返す jsonb が、その全部のキーを snake_case で持つこと。DB 側のキーの綴り違いは、直す側では
 *     NaN や 'undefined' に黙って落ちる（Number(undefined)・String(undefined)）ので、答えを直す前の jsonb も読んで突き合わせる
 *  3. 値が壊れていないこと（NaN・undefined・文字の 'undefined' が無い）
 * store に包みの無い2つの関数（list_order_line_return_counts・list_order_ids_by_return_status。注文の一覧と返品の窓口が直に呼ぶ）は、
 * client.rpc で直に呼び、配列・文字の渡し方と答えの列が PostgREST を通ることだけを確かめる。
 * 数え方・額・断りの全部は、移行ごとの DB 結合テストが確かめる。ここは窓口の形だけを見る。
 *
 * 受け取りは「相談」で通し、額を決めて返金は返金の記録を作るだけにする（Stripe に頼むのは return-service.ts。ここでは頼まない）。
 * 返金の記録は markOrderRefundError でエラーにし、最後は「返金しないで終える」（額 0。P20）で返品を閉じる。
 *
 * 後片付け: 試験の注文は削除禁止のトリガーで、返品の記録は追記だけのトリガーで消せないので、ほかの DB 結合テストと同じく
 * 使い捨てのローカル DB でだけ動かす（DATABASE_URL・LOCAL_SUPABASE_URL が localhost 以外なら失敗させる）。注文は毎回新しく作る。
 * 返金待ちの返品・返事待ちの返金が、全体の一覧（一覧の上の一行の数・要対応）に残らないよう、試験の終わりまでに閉じる。
 * ショップの返品の設定（設定の行と理由ごとの行）は、試験の前の値を控えて、終わりに戻す。
 *
 * 実行方法（ローカル Supabase を起動しておく。npx supabase db reset の直後）:
 *   eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
 *     npx jest tests/integration/db/return_postgrest --runInBand
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createFulfillment } from '@/lib/orders/fulfillment/fulfillment-store';
import { toOrderNumber } from '@/lib/orders/order-number';
import { markOrderRefundError } from '@/lib/orders/refund/refund-store';
import {
  ReturnStoreError,
  cancelReturn,
  countReturnAttention,
  createReturn,
  getShopReturnSettings,
  listOrderReturnSummaries,
  listOrderReturns,
  loadReturnCreateMaterials,
  receiveReturn,
  refundReturn,
  toReturnErrorCode,
  updateShopReturnSettings,
  type CreateReturnInput,
} from '@/lib/orders/returns/return-store';
import { RETURN_REASONS } from '@/lib/orders/returns/return-types';
import { describeLocalDb, isLocalDatabase, type PgClient } from './helpers/local-db';
import { PRICE, createCatalogFixture, insertOrderWithLines, uniqueSuffix } from './helpers/order-fixtures';

jest.setTimeout(30000);

const LOCAL_API_URL = process.env.LOCAL_SUPABASE_URL;
const LOCAL_SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TRACKING_NUMBER = '1234-5678-9012';
const QUANTITY = 3;
const RETURN_ADDRESS = { name: 'Le Fil des Heures 返品係', postalCode: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' };

// 共通の約束 C-2 の型のキー（過不足なく持つこと）
const MATERIALS_KEYS = ['order', 'shipments', 'exchangeOptions', 'settings'];
const MATERIALS_ORDER_KEYS = ['id', 'status', 'hasAwaitingRefund'];
const SHIPMENT_KEYS = ['fulfillmentId', 'number', 'shippedAt', 'deadlineDate', 'pastDeadline', 'lines'];
const SHIPMENT_LINE_KEYS = ['orderItemId', 'itemId', 'variantId', 'itemName', 'color', 'size', 'lineKind', 'quantity', 'returnable'];
const EXCHANGE_OPTION_KEYS = ['itemId', 'variants'];
const EXCHANGE_VARIANT_KEYS = ['variantId', 'color', 'size', 'isActive', 'stockQuantity', 'madeToOrderLeadDays'];
const MATERIALS_SETTINGS_KEYS = [
  'returnAddressSet', 'noReturnNeededEnabled', 'customerPaidMethod', 'shopLabelFee', 'restockingFeeEnabled', 'restockingFeePercent',
  'exchangeFeesEnabled', 'exchangeFee', 'exchangeShippingFee', 'reasonShippingPayers', 'reasonOutOfStockExchange',
];
const RETURN_KEYS = [
  'id', 'number', 'label', 'status', 'source', 'displayStatus', 'marks', 'returnMethod', 'returnShippingPayer', 'returnCarrier',
  'returnTrackingNumber', 'fees', 'firstReceiptDone', 'firstExchangeReceiptDone', 'shopNote', 'notifyCustomer', 'createdAt',
  'createdByEmail', 'closedAt', 'cancelledAt', 'lines', 'refunds', 'receipts', 'exchangeItems',
];
const RETURN_FEES_KEYS = [
  'returnShippingFee', 'restockingFeePercent', 'exchangeFee', 'exchangeShippingFee', 'feeDueAmount', 'feePendingDeduction', 'feeReceivedAt',
  'exchangeReleasedAt',
];
const RETURN_LINE_KEYS = [
  'id', 'fulfillmentId', 'fulfillmentNumber', 'orderItemId', 'itemName', 'color', 'size', 'quantity', 'reason', 'reasonNote', 'resolution',
  'exchange', 'progress', 'refundAmountsByCount', 'refundWaitingAmount',
];
const RETURN_LINE_EXCHANGE_KEYS = ['variantId', 'color', 'size', 'method', 'stockQuantity', 'madeToOrderLeadDays', 'outOfStockExchange'];
const RETURN_PROGRESS_KEYS = [
  'restocked', 'notRestocked', 'pendingInspection', 'sentBack', 'missing', 'processed', 'unprocessed', 'exchanged', 'refundCovered',
  'refundWaived', 'refundWaiting',
];
const RETURN_REFUND_KEYS = ['id', 'amount', 'status', 'createdAt'];
const RETURN_RECEIPT_KEYS = ['id', 'kind', 'refundChoice', 'createdAt', 'actorEmail'];
const RETURN_EXCHANGE_ITEM_KEYS = ['orderItemId', 'itemName', 'color', 'size', 'quantity', 'fulfillmentType', 'shipped'];
const SUMMARY_KEYS = ['orderId', 'displayStatus', 'marks', 'nextAction', 'hasReturnable', 'refundWaitingReturns', 'requestedReturns'];
const ATTENTION_KEYS = ['requested', 'refundWaiting'];
// store に包みが無く、注文の一覧と返品の画面の窓口が直に呼ぶ2つの DB の関数の、答えの列（C-1。snake_case のまま）
const LINE_COUNT_COLUMNS = [
  'order_id', 'order_item_id', 'shipped', 'refunded_after_shipment', 'requested', 'open_unprocessed', 'refund_waiting', 'exchanged',
  'sent_back', 'returnable', 'refundable_after_shipment',
];
const SETTINGS_KEYS = [
  'requestsEnabled', 'requestTypes', 'noticeText', 'windowDays', 'windowStart', 'deliveryBufferDays', 'returnAddress', 'customerPaidMethod',
  'shopLabelFee', 'noReturnNeededEnabled', 'restockingFeeEnabled', 'restockingFeePercent', 'exchangeFeesEnabled', 'exchangeFee',
  'exchangeShippingFee', 'inspectionEnabled', 'reasons', 'updated',
];
const SETTINGS_REASON_KEYS = ['reason', 'shown', 'resolutions', 'outOfStockExchange', 'photo', 'photoInstructions', 'shippingPayer'];
const SETTINGS_GROUPS = ['requests', 'window', 'shipping', 'reasons', 'fees', 'receiving'];
const RETURN_ADDRESS_KEYS = ['name', 'postalCode', 'address', 'phone'];

function expectKeys(value: unknown, keys: readonly string[]): void {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Object.keys(value as object).sort()).toEqual([...keys].sort());
}

function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * 直した後の答え（converted）の全部のキーが、DB の jsonb（raw）に snake_case で在るかを、入れ子と配列（同じ並びの要素どうし）まで探す。
 * 無かったキーを返す（空なら食い違いなし）。DB が余分なキーを返す分には構わない。
 * ignore は DB が作らない直した後だけのキー（label）、opaque は中のキーが理由の記号そのもので camelCase に直さない表
 */
function missingRawKeys(
  raw: unknown,
  converted: unknown,
  path: string,
  options: { ignore?: readonly string[]; opaque?: readonly string[] } = {},
): string[] {
  if (Array.isArray(converted)) {
    if (!Array.isArray(raw)) return [`${path}: DB の jsonb が配列でない`];
    return converted.flatMap((element, index) => missingRawKeys(raw[index], element, `${path}[${index}]`, options));
  }
  if (converted && typeof converted === 'object') {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [`${path}: DB の jsonb がオブジェクトでない`];
    const rawRecord = raw as Record<string, unknown>;
    return Object.entries(converted as Record<string, unknown>).flatMap(([key, value]) => {
      if (options.ignore?.includes(key)) return [];
      const rawKey = toSnake(key);
      if (!(rawKey in rawRecord)) return [`${path}.${rawKey} が DB の jsonb に無い`];
      return options.opaque?.includes(key) ? [] : missingRawKeys(rawRecord[rawKey], value, `${path}.${rawKey}`, options);
    });
  }
  return [];
}

/** 直した後の答えの壊れた値（undefined・NaN・文字の 'undefined' と 'NaN'）を探す。Number(undefined)・String(undefined) の黙った落ち方を見つける */
function brokenValues(value: unknown, path: string): string[] {
  if (value === undefined) return [`${path} が undefined`];
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [`${path} が数でない（${value}）`];
  if (typeof value === 'string') return value === 'undefined' || value === 'NaN' ? [`${path} が文字の ${value}`] : [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => brokenValues(entry, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => brokenValues(entry, `${path}.${key}`));
  }
  return [];
}

async function refusalOf(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(
    () => null,
    (error: unknown) => error,
  );
}

/** 注文の商品ごとの返品の数（list_order_line_return_counts）を PostgREST から直に読む。窓口が直に呼ぶ関数で、store に包みは無い */
async function readLineCounts(client: SupabaseClient, orderId: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await client.rpc('list_order_line_return_counts', { _order_ids: [orderId] });
  expect(error).toBeNull();
  return data as Array<Record<string, unknown>>;
}

/** 返品の状態で絞り込んだ注文の番号（list_order_ids_by_return_status）を PostgREST から直に読む。窓口が直に呼ぶ関数で、store に包みは無い */
async function readOrderIdsByReturnStatus(client: SupabaseClient, displayStatus: string): Promise<string[]> {
  const { data, error } = await client.rpc('list_order_ids_by_return_status', { _display_status: displayStatus });
  expect(error).toBeNull();
  return (data as Array<{ order_id: string }>).map((row) => row.order_id);
}

type Actor = { id: string; email: string };
type ShippedOrder = { orderId: string; orderItemId: string; fulfillmentId: string; itemId: number; variantId: number };

async function createActor(db: PgClient): Promise<Actor> {
  const email = `return-postgrest-${uniqueSuffix()}@example.com`;
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [email],
  );
  return { id: res.rows[0].id as string, email };
}

/**
 * 発送した在庫の品の注文（毎回新しく作る）。支払い済みの注文を作り、発送は本物の発送の窓口（createFulfillment）で記録する。
 * 返品の試験の道具は Task 1 が order-fixtures.ts に足すが、その名前に頼らず、この試験の中で作る（E-2 の refund_postgrest と同じ）。
 */
async function createShippedOrder(db: PgClient, client: SupabaseClient, actor: Actor, quantity: number): Promise<ShippedOrder> {
  const catalog = await createCatalogFixture(db, { stock: quantity });
  const { orderId, orderItemIds } = await insertOrderWithLines(db, {
    status: 'paid',
    paidAmount: PRICE * quantity,
    paymentIntentId: `pi_pgrst_return_${uniqueSuffix()}`,
    lines: [{ itemId: catalog.itemId, variantId: catalog.variantId, quantity, fulfillmentType: 'stock' }],
  });
  const shipped = await createFulfillment(client, {
    orderId,
    actorId: actor.id,
    requestKey: crypto.randomUUID(),
    carrier: 'yamato',
    trackingNumber: TRACKING_NUMBER,
    notifyCustomer: false,
    lines: [{ orderItemId: orderItemIds[0], quantity }],
  });
  return { orderId, orderItemId: orderItemIds[0], fulfillmentId: shipped.fulfillmentId, itemId: catalog.itemId, variantId: catalog.variantId };
}

/** 同じ商品に色違い・サイズ違いのバリアントを足す（交換の色・サイズ）。在庫は台帳の restock で入れる */
async function addVariant(db: PgClient, itemId: number, colorName: string, sizeLabel: string, stock: number): Promise<number> {
  const color = await db.query(
    `insert into public.item_colors (item_id, name, hex, position) values ($1, $2, '#ffffff', 1) returning id`,
    [itemId, colorName],
  );
  const size = await db.query(`insert into public.item_sizes (item_id, label, position) values ($1, $2, 1) returning id`, [itemId, sizeLabel]);
  const variant = await db.query(
    `insert into public.item_variants (item_id, color_id, size_id, is_active) values ($1, $2, $3, true) returning id`,
    [itemId, color.rows[0].id, size.rows[0].id],
  );
  const variantId = Number(variant.rows[0].id);
  await db.query(`insert into public.stock_movements (variant_id, delta, reason, note) values ($1, $2, 'restock', 'fixture')`, [variantId, stock]);
  return variantId;
}

type SavedSettings = { settings: Record<string, unknown>; reasons: Array<Record<string, unknown>> };

async function saveReturnSettings(db: PgClient): Promise<SavedSettings> {
  const settings = (await db.query('select * from public.shop_return_settings where id = 1')).rows[0] as Record<string, unknown>;
  const reasons = (await db.query('select * from public.shop_return_reason_settings')).rows as Array<Record<string, unknown>>;
  return { settings, reasons };
}

/** 控えた行を、列の名前どおりに戻す（更新者・時刻の列も戻る） */
async function restoreReturnSettings(db: PgClient, saved: SavedSettings): Promise<void> {
  const settingsColumns = Object.keys(saved.settings).filter((column) => column !== 'id');
  await db.query(
    `update public.shop_return_settings set ${settingsColumns.map((column, index) => `${column} = $${index + 1}`).join(', ')} where id = 1`,
    settingsColumns.map((column) => saved.settings[column]),
  );
  for (const row of saved.reasons) {
    const columns = Object.keys(row).filter((column) => column !== 'reason');
    await db.query(
      `update public.shop_return_reason_settings set ${columns.map((column, index) => `${column} = $${index + 1}`).join(', ')}
       where reason = $${columns.length + 1}`,
      [...columns.map((column) => row[column]), row.reason],
    );
  }
}

describeLocalDb('integration: 返品の窓口を実際の PostgREST に通す', (db) => {
  if (!LOCAL_API_URL || !LOCAL_SERVICE_ROLE_KEY) {
    test.skip('LOCAL_SUPABASE_URL・LOCAL_SUPABASE_SERVICE_ROLE_KEY 未設定のためスキップ', () => {});
    return;
  }
  if (!isLocalDatabase(LOCAL_API_URL)) {
    test('ローカルの API 以外では実行しない', () => {
      throw new Error('消せない試験注文が残るため、localhost 以外の LOCAL_SUPABASE_URL では実行しない');
    });
    return;
  }

  const apiUrl = LOCAL_API_URL;
  const serviceRoleKey = LOCAL_SERVICE_ROLE_KEY;
  let client: SupabaseClient;
  let actor: Actor;
  let saved: SavedSettings;
  let order: ShippedOrder;
  let otherOrder: ShippedOrder;
  let exchangeVariantId: number;
  // この順に流す試験の間で受け渡す物（作った返品・受け取りの記録）
  let returnId = '';
  let refundLineId = '';
  let exchangeLineId = '';

  beforeAll(async () => {
    client = createClient(apiUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    actor = await createActor(db());
    saved = await saveReturnSettings(db());
    order = await createShippedOrder(db(), client, actor, QUANTITY);
    otherOrder = await createShippedOrder(db(), client, actor, 1);
    exchangeVariantId = await addVariant(db(), order.itemId, 'WHITE', 'L', 2);
  });

  /** 返金の行と交換の行の2つ（同じ発送の同じ商品から1点ずつ。商品は3点なので、あと1点は返品できる） */
  function createInput(overrides: Partial<CreateReturnInput> = {}): CreateReturnInput {
    return {
      orderId: order.orderId,
      actorId: actor.id,
      requestKey: crypto.randomUUID(),
      lines: [
        {
          fulfillmentId: order.fulfillmentId, orderItemId: order.orderItemId, quantity: 1, reason: 'defective', reasonNote: null,
          resolution: 'refund', exchangeVariantId: null, exchangeMethod: null,
        },
        {
          fulfillmentId: order.fulfillmentId, orderItemId: order.orderItemId, quantity: 1, reason: 'size_too_small', reasonNote: 'タグ付き',
          resolution: 'exchange', exchangeVariantId, exchangeMethod: 'stock',
        },
      ],
      returnMethod: 'customer_ships',
      returnShippingPayer: 'shop',
      returnCarrier: null,
      returnTrackingNumber: null,
      returnShippingFee: null,
      restockingFeePercent: null,
      exchangeFee: null,
      exchangeShippingFee: null,
      shopNote: 'PostgREST の試験',
      notifyCustomer: false,
      ...overrides,
    };
  }

  test('ショップの設定: 読んだ答えが C-2 の ShopReturnSettings のキーを過不足なく持ち、DB の jsonb が全部のキーを持つ', async () => {
    const settings = await getShopReturnSettings(client);

    expectKeys(settings, SETTINGS_KEYS);
    expect(settings.reasons.map((reason) => reason.reason).sort()).toEqual([...RETURN_REASONS].sort());
    for (const reason of settings.reasons) expectKeys(reason, SETTINGS_REASON_KEYS);
    expectKeys(settings.updated, SETTINGS_GROUPS);
    for (const group of Object.values(settings.updated)) expectKeys(group, ['at', 'byEmail']);
    if (settings.returnAddress) expectKeys(settings.returnAddress, RETURN_ADDRESS_KEYS);
    expect(brokenValues(settings, 'settings')).toEqual([]);

    const raw = await client.rpc('get_shop_return_settings');
    expect(raw.error).toBeNull();
    expect(missingRawKeys(raw.data, settings, 'settings')).toEqual([]);
  });

  test('返送先が空の間は返品を作れない: DB の言葉 RETURN_ADDRESS_REQUIRED が PostgREST を通って記号に直り、何も書かない', async () => {
    const cleared = await updateShopReturnSettings(client, { settings: { returnAddress: null }, actorId: actor.id });
    expect(cleared.returnAddress).toBeNull();

    const refusal = await refusalOf(createReturn(client, createInput()));

    expect(refusal).toBeInstanceOf(ReturnStoreError);
    expect(refusal).toMatchObject({ code: 'RETURN_ADDRESS_REQUIRED' });
    const stored = await db().query('select count(*)::int as count from public.order_returns where order_id = $1', [order.orderId]);
    expect(stored.rows[0].count).toBe(0);

    // 窓口が拾う前の、PostgREST の誤りの文から DB の言葉を拾えること（存在しない返品の取消は RETURN_NOT_FOUND）
    const raw = await client.rpc('admin_cancel_return', { _return_id: crypto.randomUUID(), _actor_id: actor.id });
    expect(raw.data).toBeNull();
    expect(toReturnErrorCode(raw.error?.message)).toBe('RETURN_NOT_FOUND');
    expect(await refusalOf(cancelReturn(client, { returnId: crypto.randomUUID(), actorId: actor.id }))).toMatchObject({
      code: 'RETURN_NOT_FOUND',
    });
  });

  test('作る画面の材料: C-2 の ReturnCreateMaterials のキーを過不足なく持ち、DB の jsonb が全部のキーを持つ。返品できる数は発送した数', async () => {
    const materials = await loadReturnCreateMaterials(client, order.orderId);

    expectKeys(materials, MATERIALS_KEYS);
    expectKeys(materials.order, MATERIALS_ORDER_KEYS);
    expect(materials.order).toEqual({ id: order.orderId, status: 'shipped', hasAwaitingRefund: false });
    expect(materials.shipments).toHaveLength(1);
    const [shipment] = materials.shipments;
    expectKeys(shipment, SHIPMENT_KEYS);
    expect(shipment).toMatchObject({
      fulfillmentId: order.fulfillmentId, number: 1, shippedAt: expect.any(String), pastDeadline: false,
    });
    expect(shipment.deadlineDate === null || DATE_PATTERN.test(shipment.deadlineDate)).toBe(true);
    expect(shipment.lines).toHaveLength(1);
    expectKeys(shipment.lines[0], SHIPMENT_LINE_KEYS);
    expect(shipment.lines[0]).toEqual({
      orderItemId: order.orderItemId, itemId: order.itemId, variantId: order.variantId, itemName: '照合テスト', color: 'BLACK', size: 'M',
      lineKind: 'order', quantity: QUANTITY, returnable: QUANTITY,
    });

    // 交換で選べる色・サイズ: 同じ商品の、元の色・サイズと足した色・サイズ
    const options = materials.exchangeOptions.find((option) => option.itemId === order.itemId);
    expect(options).toBeDefined();
    expectKeys(options, EXCHANGE_OPTION_KEYS);
    expect(options?.variants.map((variant) => variant.variantId)).toContain(exchangeVariantId);
    for (const variant of options?.variants ?? []) expectKeys(variant, EXCHANGE_VARIANT_KEYS);
    expect(options?.variants.find((variant) => variant.variantId === exchangeVariantId)).toMatchObject({
      color: 'WHITE', size: 'L', isActive: true, stockQuantity: 2,
    });

    expectKeys(materials.settings, MATERIALS_SETTINGS_KEYS);
    expect(materials.settings.returnAddressSet).toBe(false);
    expect(Object.keys(materials.settings.reasonShippingPayers).sort()).toEqual([...RETURN_REASONS].sort());
    expect(Object.keys(materials.settings.reasonOutOfStockExchange).sort()).toEqual([...RETURN_REASONS].sort());
    expect(brokenValues(materials, 'materials')).toEqual([]);

    const raw = await client.rpc('get_order_return_materials', { _order_id: order.orderId });
    expect(raw.error).toBeNull();
    expect(missingRawKeys(raw.data, materials, 'materials', { opaque: ['reasonShippingPayers', 'reasonOutOfStockExchange'] })).toEqual([]);

    // 存在しない注文は、E-2 の記号 order_not_found の ReturnStoreError
    expect(await refusalOf(loadReturnCreateMaterials(client, crypto.randomUUID()))).toMatchObject({ code: 'order_not_found' });
  });

  test('返送先を入れる: 変える欄だけを渡す設定の更新が通り（理由ごとの設定は変える欄だけの行）、返送のまとまりに更新者が付く', async () => {
    const updated = await updateShopReturnSettings(client, {
      actorId: actor.id,
      settings: {
        returnAddress: RETURN_ADDRESS,
        reasons: [{ reason: 'defective', shippingPayer: 'shop', outOfStockExchange: 'make' }],
      },
    });

    expectKeys(updated, SETTINGS_KEYS);
    expect(updated.returnAddress).toEqual(RETURN_ADDRESS);
    expect(updated.updated.shipping).toEqual({ at: expect.any(String), byEmail: actor.email });
    expect(updated.reasons.find((reason) => reason.reason === 'defective')).toMatchObject({ shippingPayer: 'shop', outOfStockExchange: 'make' });
    expect(await getShopReturnSettings(client)).toEqual(updated);
    expect((await loadReturnCreateMaterials(client, order.orderId)).settings.returnAddressSet).toBe(true);
  });

  test('商品ごとの返品の数（窓口が直に呼ぶ関数）: 返品を作る前は、発送した数だけ返品できる。答えの列は C-1 のとおり過不足がない', async () => {
    const rows = await readLineCounts(client, order.orderId);

    expect(rows).toHaveLength(1);
    expectKeys(rows[0], LINE_COUNT_COLUMNS);
    expect(rows[0]).toMatchObject({
      order_id: order.orderId, order_item_id: order.orderItemId, shipped: QUANTITY, open_unprocessed: 0, returnable: QUANTITY,
    });
    expect(brokenValues(rows, 'lineCounts')).toEqual([]);
  });

  test('注文の番号を200件より多く渡した一覧の関数は、DB の言葉 TOO_MANY_ORDERS で断る。窓口が拾えば RETURN_ARGUMENT_INVALID になり、store は200件ずつに分けるので断られない', async () => {
    const ids = Array.from({ length: 201 }, () => crypto.randomUUID());

    const raw = await client.rpc('list_order_return_summaries', { _order_ids: ids });

    expect(raw.data).toBeNull();
    expect(toReturnErrorCode(raw.error?.message)).toBe('RETURN_ARGUMENT_INVALID');
    await expect(listOrderReturnSummaries(client, ids)).resolves.toBeInstanceOf(Map);
  });

  test('作る: 返品が受付中で作られ、同じ二重防止の番号の送り直しは前の結果を返す。返品できる数を超えると RETURN_QUANTITY_EXCEEDS', async () => {
    const input = createInput();

    const created = await createReturn(client, input);

    expectKeys(created, ['returnId', 'number', 'status', 'replayed']);
    expect(created).toEqual({ returnId: expect.stringMatching(UUID_PATTERN), number: 1, status: 'open', replayed: false });
    returnId = created.returnId;
    expect(await createReturn(client, input)).toEqual({ ...created, replayed: true });
    const stored = await db().query('select count(*)::int as count from public.order_returns where order_id = $1', [order.orderId]);
    expect(stored.rows[0].count).toBe(1);

    // 同じ番号で中身が違えば断る
    expect(await refusalOf(createReturn(client, { ...input, lines: [input.lines[0]] }))).toMatchObject({ code: 'RETURN_REQUEST_MISMATCH' });
    // 残りの返品できる数は 1。5 点は超える（DB の言葉が PostgREST を通っても記号に直る）
    const tooMany = createInput({
      requestKey: crypto.randomUUID(),
      lines: [{ ...input.lines[0], quantity: 5 }],
    });
    expect(await refusalOf(createReturn(client, tooMany))).toMatchObject({ code: 'RETURN_QUANTITY_EXCEEDS' });
    expect((await readLineCounts(client, order.orderId))[0]).toMatchObject({ open_unprocessed: 2, returnable: 1 });
  });

  test('返品の一覧・要約・数: 作った返品が受付中（返品中・受け取り待ち）で読め、一覧の上の一行の数と絞り込みも読める', async () => {
    const returns = await listOrderReturns(client, order.orderId);

    expect(returns).toHaveLength(1);
    const [detail] = returns;
    expectKeys(detail, RETURN_KEYS);
    expectKeys(detail.fees, RETURN_FEES_KEYS);
    expect(detail).toMatchObject({
      id: returnId,
      number: 1,
      label: `${toOrderNumber(order.orderId)}-R1`,
      status: 'open',
      source: 'shop',
      displayStatus: 'in_progress',
      marks: ['awaiting_items'],
      returnMethod: 'customer_ships',
      returnShippingPayer: 'shop',
      returnCarrier: null,
      returnTrackingNumber: null,
      firstReceiptDone: false,
      firstExchangeReceiptDone: false,
      shopNote: 'PostgREST の試験',
      notifyCustomer: false,
      createdByEmail: actor.email,
      closedAt: null,
      cancelledAt: null,
      refunds: [],
      receipts: [],
      exchangeItems: [],
    });
    expect(detail.lines).toHaveLength(2);
    const refundLine = detail.lines.find((line) => line.resolution === 'refund');
    const exchangeLine = detail.lines.find((line) => line.resolution === 'exchange');
    expect(refundLine).toBeDefined();
    expect(exchangeLine).toBeDefined();
    refundLineId = refundLine?.id ?? '';
    exchangeLineId = exchangeLine?.id ?? '';
    for (const line of detail.lines) {
      expectKeys(line, RETURN_LINE_KEYS);
      expectKeys(line.progress, RETURN_PROGRESS_KEYS);
    }
    expect(refundLine).toMatchObject({
      fulfillmentId: order.fulfillmentId, fulfillmentNumber: 1, orderItemId: order.orderItemId, itemName: '照合テスト', color: 'BLACK', size: 'M',
      quantity: 1, reason: 'defective', reasonNote: null, exchange: null, refundAmountsByCount: [PRICE, PRICE * 2], refundWaitingAmount: 0,
    });
    expect(refundLine?.progress).toMatchObject({ processed: 0, unprocessed: 1, exchanged: 0, refundWaived: 0, refundWaiting: 0 });
    // 交換の予定の行にも額の列が入る（受け取りで「返金に変える」時の見込みに使う）。返金の行と交換の行は同じ注文の商品を指すので、
    // 列は同じで、長さはこの返品でその商品を指す行の未処理の数の合計（1 + 1 = 2点分）になる（C-2。割引なしなので PRICE の倍数）
    expect(exchangeLine).toMatchObject({
      quantity: 1, reason: 'size_too_small', reasonNote: 'タグ付き', refundAmountsByCount: [PRICE, PRICE * 2],
    });
    expect(detail.fees).toMatchObject({ feeDueAmount: 0, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null });
    expectKeys(exchangeLine?.exchange, RETURN_LINE_EXCHANGE_KEYS);
    expect(exchangeLine?.exchange).toMatchObject({ variantId: exchangeVariantId, color: 'WHITE', size: 'L', method: 'stock', stockQuantity: 2 });
    expect(brokenValues(returns, 'returns')).toEqual([]);

    const rawReturns = await client.rpc('list_order_returns', { _order_id: order.orderId });
    expect(rawReturns.error).toBeNull();
    expect(missingRawKeys(rawReturns.data, returns, 'returns', { ignore: ['label'] })).toEqual([]);
    // 番号の文字は DB が作らず、store が付ける（共通の約束 C-2）
    expect(rawReturns.data[0]).not.toHaveProperty('label');

    // 一覧の要約: 返品のある注文と、返品の無い注文（返品できる品はある）
    const summaries = await listOrderReturnSummaries(client, [order.orderId, otherOrder.orderId]);
    expect([...summaries.keys()]).toEqual([order.orderId, otherOrder.orderId]);
    for (const summary of summaries.values()) expectKeys(summary, SUMMARY_KEYS);
    expect(summaries.get(order.orderId)).toEqual({
      orderId: order.orderId, displayStatus: 'in_progress', marks: ['awaiting_items'], nextAction: 'receive', hasReturnable: true,
      refundWaitingReturns: 0, requestedReturns: 0,
    });
    expect(summaries.get(otherOrder.orderId)).toEqual({
      orderId: otherOrder.orderId, displayStatus: null, marks: [], nextAction: 'none', hasReturnable: true,
      refundWaitingReturns: 0, requestedReturns: 0,
    });
    const rawSummaries = await client.rpc('list_order_return_summaries', { _order_ids: [order.orderId, otherOrder.orderId] });
    expect(rawSummaries.error).toBeNull();
    const rawSummary = (rawSummaries.data as Array<Record<string, unknown>>).find((row) => row.order_id === order.orderId);
    expect(missingRawKeys(rawSummary, summaries.get(order.orderId), 'summary')).toEqual([]);

    // 一覧の上の一行の数
    const attention = await countReturnAttention(client);
    expectKeys(attention, ATTENTION_KEYS);
    expect(brokenValues(attention, 'attention')).toEqual([]);
    const rawAttention = await client.rpc('count_order_return_attention');
    expect(rawAttention.error).toBeNull();
    expect(missingRawKeys(Array.isArray(rawAttention.data) ? rawAttention.data[0] : rawAttention.data, attention, 'attention')).toEqual([]);

    // 返金待ちの絞り込み（窓口が直に呼ぶ関数）には、まだ入らない。返品中には入る
    expect(await readOrderIdsByReturnStatus(client, 'refund_waiting')).not.toContain(order.orderId);
    expect(await readOrderIdsByReturnStatus(client, 'in_progress')).toContain(order.orderId);
  });

  test('受け取る（相談）: 返金も Stripe も使わず受け取りだけ記録され、交換の品の行が足される。送り直しは前の結果を返す。取消は断る', async () => {
    const attentionBefore = await countReturnAttention(client);
    const input = {
      returnId,
      actorId: actor.id,
      actorCanRefund: true,
      requestKey: crypto.randomUUID(),
      units: [
        { returnLineId: refundLineId, disposition: 'restocked' as const, quantity: 1 },
        { returnLineId: exchangeLineId, disposition: 'restocked' as const, quantity: 1 },
      ],
      exchangeOverrides: [],
      refundChoice: 'consult' as const,
      refundAmount: null,
      refundShippingAmount: 0,
      note: null,
      notifyCustomer: false,
      sentBackMessage: null,
      sentBackCarrier: null,
      sentBackTrackingNumber: null,
    };

    const received = await receiveReturn(client, input);

    expectKeys(received, [
      'receiptId', 'returnStatus', 'refundId', 'refundAmount', 'refundStatus', 'exchangeOrderItemIds', 'feeDueAmount',
      'shopNoticeEnqueued', 'replayed',
    ]);
    expect(received).toMatchObject({
      receiptId: expect.stringMatching(UUID_PATTERN),
      returnStatus: 'open',
      refundId: null,
      // 相談の受け取りは返金の記録が無いので、額も状態も null（0 と waived は返金しないで終えた時だけ。P20）
      refundAmount: null,
      refundStatus: null,
      exchangeOrderItemIds: [expect.stringMatching(UUID_PATTERN)],
      feeDueAmount: 0,
      shopNoticeEnqueued: false,
      replayed: false,
    });
    expect(brokenValues(received, 'received')).toEqual([]);
    expect(await receiveReturn(client, input)).toEqual({ ...received, replayed: true });

    // 受け取った後の取消は断る（DB の言葉 RETURN_STATE_CONFLICT）
    expect(await refusalOf(cancelReturn(client, { returnId, actorId: actor.id }))).toMatchObject({ code: 'RETURN_STATE_CONFLICT' });

    // 全部の品が処理され、返金の品が残っているので、返金待ち。交換の品の行が1つ足されている
    const [detail] = await listOrderReturns(client, order.orderId);
    expect(detail).toMatchObject({ status: 'open', displayStatus: 'refund_waiting', firstReceiptDone: true, firstExchangeReceiptDone: true });
    expect(detail.receipts).toEqual([
      { id: received.receiptId, kind: 'receive', refundChoice: 'consult', createdAt: expect.any(String), actorEmail: actor.email },
    ]);
    expect(detail.exchangeItems).toHaveLength(1);
    expect(detail.exchangeItems[0]).toMatchObject({
      orderItemId: received.exchangeOrderItemIds[0], color: 'WHITE', size: 'L', quantity: 1, fulfillmentType: 'stock', shipped: 0,
    });
    const refundLine = detail.lines.find((line) => line.id === refundLineId);
    expect(refundLine?.progress).toMatchObject({ restocked: 1, processed: 1, unprocessed: 0, refundWaiting: 1 });
    expect(refundLine?.refundWaitingAmount).toBe(PRICE);
    expect(detail.lines.find((line) => line.id === exchangeLineId)?.progress).toMatchObject({ restocked: 1, processed: 1, exchanged: 1 });

    const summary = (await listOrderReturnSummaries(client, [order.orderId])).get(order.orderId);
    expect(summary).toMatchObject({ displayStatus: 'refund_waiting', nextAction: 'refund', refundWaitingReturns: 1 });
    const attentionAfter = await countReturnAttention(client);
    expect(attentionAfter.refundWaiting).toBeGreaterThanOrEqual(attentionBefore.refundWaiting + 1);
    expect(await readOrderIdsByReturnStatus(client, 'refund_waiting')).toContain(order.orderId);
  });

  test('額を決めて返金して、返金しないで終える: 返金の記録（Stripe には頼まない）→ エラー → 額 0 で waived。返品が閉じる', async () => {
    // 計算どおりの額で、返金の記録を作る（返事待ち）。記録は返品と結びつく
    const recorded = await refundReturn(client, {
      returnId, actorId: actor.id, requestKey: crypto.randomUUID(), amount: null, shippingAmount: 0, note: null, notifyCustomer: false,
    });
    expectKeys(recorded, ['refundId', 'amount', 'status', 'replayed']);
    expect(recorded).toEqual({ refundId: expect.stringMatching(UUID_PATTERN), amount: PRICE, status: 'awaiting_response', replayed: false });
    const refundId = recorded.refundId as string;
    const linked = await db().query('select source, return_id from public.order_refunds where id = $1', [refundId]);
    expect(linked.rows).toEqual([{ source: 'return', return_id: returnId }]);

    // Stripe に頼まずに、エラーにして片付ける（E-2 の関数）。返金の記録は返品の中身に出る
    await markOrderRefundError(client, refundId, 'stripe_rejected', false);
    const [withRefund] = await listOrderReturns(client, order.orderId);
    expect(withRefund.refunds).toHaveLength(1);
    expectKeys(withRefund.refunds[0], RETURN_REFUND_KEYS);
    expect(withRefund.refunds[0]).toEqual({ id: refundId, amount: PRICE, status: 'error', createdAt: expect.any(String) });

    // 返金額を 0 にして、返金しないで終える。返金の記録は作られない
    const waiveInput = {
      returnId, actorId: actor.id, requestKey: crypto.randomUUID(), amount: 0, shippingAmount: 0, note: null, notifyCustomer: false,
    };
    const waived = await refundReturn(client, waiveInput);
    expect(waived).toEqual({ refundId: null, amount: 0, status: 'waived', replayed: false });
    expect(await refundReturn(client, waiveInput)).toEqual({ ...waived, replayed: true });
    const refundCount = await db().query('select count(*)::int as count from public.order_refunds where return_id = $1', [returnId]);
    expect(refundCount.rows[0].count).toBe(1);

    // 返品が閉じる。返金しないで終えた受け取りの記録（waive_refund）が残る
    const [closed] = await listOrderReturns(client, order.orderId);
    expect(closed).toMatchObject({ status: 'closed', displayStatus: 'returned', closedAt: expect.any(String) });
    expect(closed.receipts.map((receipt) => receipt.kind).sort()).toEqual(['receive', 'waive_refund']);
    for (const receipt of closed.receipts) expectKeys(receipt, RETURN_RECEIPT_KEYS);
    expect(closed.lines.find((line) => line.id === refundLineId)?.progress).toMatchObject({ refundWaived: 1, refundWaiting: 0 });
    expect(await readOrderIdsByReturnStatus(client, 'refund_waiting')).not.toContain(order.orderId);
    expect(await readOrderIdsByReturnStatus(client, 'returned')).toContain(order.orderId);
  });

  test('全部の配列に中身がある状態の返品を読む: C-2 の型のキーを過不足なく持ち、DB の jsonb が全部のキーを持つ（入れ子と配列の中まで）', async () => {
    const returns = await listOrderReturns(client, order.orderId);
    const [detail] = returns;

    // 行・返金・受け取り・交換の品の配列が、空でないこと（空だと、中のキーを確かめられない）
    expect(detail.lines.length).toBeGreaterThan(0);
    expect(detail.refunds.length).toBeGreaterThan(0);
    expect(detail.receipts.length).toBeGreaterThan(0);
    expect(detail.exchangeItems.length).toBeGreaterThan(0);

    expectKeys(detail, RETURN_KEYS);
    expectKeys(detail.fees, RETURN_FEES_KEYS);
    for (const line of detail.lines) {
      expectKeys(line, RETURN_LINE_KEYS);
      expectKeys(line.progress, RETURN_PROGRESS_KEYS);
    }
    expectKeys(detail.lines.find((line) => line.exchange !== null)?.exchange, RETURN_LINE_EXCHANGE_KEYS);
    for (const refund of detail.refunds) expectKeys(refund, RETURN_REFUND_KEYS);
    for (const receipt of detail.receipts) expectKeys(receipt, RETURN_RECEIPT_KEYS);
    for (const item of detail.exchangeItems) expectKeys(item, RETURN_EXCHANGE_ITEM_KEYS);
    expect(brokenValues(returns, 'returns')).toEqual([]);

    const raw = await client.rpc('list_order_returns', { _order_id: order.orderId });
    expect(raw.error).toBeNull();
    expect(missingRawKeys(raw.data, returns, 'returns', { ignore: ['label'] })).toEqual([]);
  });

  // 後片付けは afterAll に書かない: describeLocalDb が先に登録した afterAll（DB の接続を閉じる）が、定義の順で先に動き、
  // 後から登録したこちらの afterAll の時には接続が閉じているため。最後の試験として流す（前の試験が落ちても流れる）
  test('後片付け: ショップの返品の設定（設定の行と理由ごとの行）を、試験の前の値に戻す', async () => {
    await expect(restoreReturnSettings(db(), saved)).resolves.toBeUndefined();
  });
});
