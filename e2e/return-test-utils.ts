/**
 * 返品と交換の E2E の道具（グループ E-3 段1）。
 * 管理画面の操作は、今までの E2E と同じく窓口の答えを差し替えて確かめる（手元の DB には管理者の権限の行が無く、本物の管理者の
 * ログインには2段階認証が要る。本計画 P11）。DB の動き（受け取り・在庫の台帳・返金の記録・メールの予定）は、窓口が呼ぶのと同じ
 * DB の関数を、手元の DB に直に呼んで確かめる。Stripe には頼まず、返金の結果は E-2 の道具 recordRefundResult で書く。
 * 窓口の答えは共通の約束（実装計画 C-2・C-3）の型に合わせて組み立てるので、型が変われば tsc が教えてくれる。
 * 画面の作りへの頼り方（役割と名前）は、画面を探す関数にまとめた。画面の作りが変わったら、この1か所を直す。
 */
import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test';
import type { OrderItem, OrderLineItem } from '@/components/OrderSection';
import type {
  OrderHistoryEmailEntry,
  OrderHistoryReturnEntry,
  OrderHistoryReturnEntryKind,
} from '@/lib/orders/email/order-history';
import type { FulfillmentMaterialLine } from '@/lib/orders/fulfillment/fulfillment-types';
import type {
  ExchangeMethod,
  OrderReturnDetail,
  OrderReturnLineDetail,
  OrderReturnSummary,
  OutOfStockExchange,
  ReceiptDisposition,
  RefundChoice,
  ReturnCarrier,
  ReturnCreateMaterials,
  ReturnMethod,
  ReturnReason,
  ReturnStatus,
  ShippingPayer,
} from '@/lib/orders/returns/return-types';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { PRICE, uniqueSuffix } from '../tests/integration/db/helpers/order-fixtures';
import {
  createActor,
  createFulfillment,
  createOrderWithLines,
  mailBodies,
  runWorkerUntil,
  uniqueEmail,
  withLocalDb,
  type E2eOrderLine,
  type MailBody,
} from './order-email-test-utils';
import { adminOrder, fulfillJson, materialLine, orderLine, orderNumberOf } from './order-fulfillment-test-utils';
import { formatYen } from './refund-test-utils';

// ---- 言葉（共通の約束 C-5・C-6）。実装の定数を import せず、試験が自分で持つ。金額は画面と同じ全角の ￥ と桁区切り ----

export const RETURN_TEXT = {
  empty: 'この注文にはまだ返品がありません。',
  created: '返品を作りました。',
  addressMissing: '返送先が設定されていません。ショップの設定で返送先を入れてから作ってください。',
  /** 作る画面の円の欄（返送料・交換の手数料・交換の送料）が上限を超えた時の誤り。ショップの設定の画面の金額の欄と同じ言葉 */
  yenLimit: '0から1000000までの整数（半角）で入れてください。',
  /** 作る画面の返品の手数料（%）の欄が0〜100の整数でない時の誤り。ショップの設定の画面の割合の欄と同じ言葉 */
  percentLimit: '0から100までの整数（半角）で入れてください。',
  notReturnable: 'この注文は返品を作れません。',
  unknownCreate: '返品を作れたか確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。',
  unknownReceive: '受け取りの結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。',
  noticeRecorded: '受け取りを記録しました。',
  noticeRefundAccepted: '受け取りを記録し、返金を受け付けました。',
  noticeRefunded: '受け取りを記録し、返金しました。',
  noticeWaived: '返金しないで終えました。',
  noticeClosedMissing: '「届かない」として返品を終えました。',
  noticeByAmountAccepted: '返金を受け付けました。お金が戻ると、注文の状態が変わります。',
  noticeByAmountSucceeded: '返金しました。',
  consultButton: '受け取りだけ記録する（返金は額を決めてから）',
  supportConsultButton: '受け取りだけ記録する（額は店長が決める）',
  consultOption: '額を相談してから返金する',
  supportRefundNote: '返金は店長が行います（受け取ると「返金待ち」になります）。',
  missingOption: '残りは届かないものとして返品を終える',
  sentBackConfirm: 'お客様にメッセージが届きます。取り消せません。',
  sentBackMessageLabel: 'お客様へのメッセージ（必須・お客様に届きます）',
  sentBackCarrierLabel: '送り返しの配送業者（任意）',
  sentBackTrackingLabel: '送り返しの伝票番号（任意）',
  notifyLabel: 'お客様に知らせる',
  exchangeHeading: '交換の品',
  stockMake: '在庫が足りないため、作ってお送りします。',
  stockDeclineManager: '在庫が足りません。「作って送る」か「返金に変える」を選んでください。',
  stockDeclineSupport: '在庫が足りません。この品は店長が受け取ります。',
  refundNoUndo: '返金は取り消せません。',
  refundWaiveNote: '返金しないで終えます。お客様に返金のメールは送りません。',
  refundWaiveButton: '返金しないで終える',
  refundMailLabel: 'お客様に返金のメールを送る',
  memoLabel: 'メモ（お客様には見えません）',
  cancelTitle: '返品を取り消す',
  cancelBody: 'この返品を取り消します。品はまた返品できるようになります。お客様にメールは送りません。',
  reopenTitle: '返品を開き直す',
  feeTitle: '手数料の受け取りを記録する',
  feeMemoLabel: '受け取りの方法のメモ（お客様には見えません）',
  feeRecordButton: '受け取りを記録する',
  feeWaiveButton: 'いただかないで終える',
  feeWaivedNotice: '手数料をいただかないことにしました。',
  releaseTitle: '支払いを待たずに送る',
  releaseBody: '手数料のお支払いを待たずに、交換の品を送れるようにします。手数料はお支払い待ちのまま残ります。',
  /** 受け取りの画面の、押す前のお支払い待ちの見込み（引けない手数料か、返金の品が無い受け取りで付く手数料がある時だけ。C-5） */
  awaitingPayment: (yen: string) => `お支払い待ち ${yen}（交換の品は、お支払いを確かめてから送ります）`,
  shipHold: (count: number) =>
    `手数料のお支払いを待っている交換の品があります（${count}点）。送るには、返品の画面で受け取りを記録するか「支払いを待たずに送る」を押してください。`,
  shipHoldRefusal: '手数料のお支払いを待っている交換の品は送れません。',
  hasReturnRefusal: '返品のある発送は取り消せません。',
  remaining: (count: number) => `返品できる品: あと${count}点`,
  deadline: (day: string) => `受付の期限: ${day}まで`,
  pastDeadline: (day: string) => `期限を過ぎています（${day}まで）`,
  progress: (total: number, checked: number) => `${total}点中${checked}点を確認`,
  nowOption: /^計算どおり .+ を返金する$/,
  receiveAll: (yen: string, tail = '') => `すべて受け取って ${yen} を返金する${tail}`,
  receivePart: (count: number, yen: string, tail = '') => `${count}点を受け取って ${yen} を返金する${tail}`,
  receiveAllWaived: (tail = '') => `すべて受け取り、返金なしで記録する${tail}`,
  receivePartWaived: (count: number, tail = '') => `${count}点を受け取り、返金なしで記録する${tail}`,
  receiveAllExchange: 'すべて受け取り、交換の品を発送待ちにする',
  receivePartExchange: (count: number) => `${count}点を受け取り、交換の品を発送待ちにする`,
  receiveAllSentBack: 'すべて受け取り、品物をお返しする',
  receivePartSentBack: (count: number) => `${count}点を受け取り、品物をお返しする`,
  receiveCount: (count: number) => `${count}点を受け取る`,
  exchangeTail: '、交換の品を発送待ちにする',
  partialConfirm: (count: number) =>
    `まだ届いていない商品が ${count} 点あります。届いた分だけ記録し、残りは受付中のまま残ります。`,
  missingConfirm: (count: number) =>
    `届いていない ${count} 点を「届かない」として返品を終えます。この品は返金も交換もしません。`,
  reopenBody: (count: number) => `「届かない」として終えた ${count} 点を、また受け取れるようにします。`,
  feeBody: (yen: string) => `いただく額: ${yen}`,
  refundTitle: (label: string) => `額を決めて返金する（${label}）`,
  receiveTitle: (label: string) => `受け取る（${label}）`,
  inspectTitle: (label: string) => `検品を終える（${label}）`,
  refundAmountLabel: (yen: string) => `返金額（返せる額: ${yen}）`,
  shippingAmountLabel: (yen: string) => `送料（返せる送料: ${yen}）`,
  refundButton: (yen: string) => `${yen} を返金する`,
  stockOf: (count: number) => `在庫から（在庫 ${count}）`,
  makeOf: (days: number) => `作って送る（お届けの目安 ${days}日）`,
} as const;

/** 状態の言葉（C-5）。受け取りの行の選択肢の字でもある */
export const UNIT_STATES = {
  restock: '在庫に戻す',
  keep: '戻さない',
  sentBack: '条件に合わないのでお返しする',
  inspection: '検品待ち',
} as const;
export type UnitState = (typeof UNIT_STATES)[keyof typeof UNIT_STATES];

/** メールの件名・本文の文（C-6）。件名の頭 `【Le Fil des Heures】` を除いた名前と、本文の行 */
export const RETURN_MAIL = {
  accepted: '返品の受付のお知らせ',
  received: '返品をお受け取りしました',
  sentBack: '品物をお返しします',
  refund: 'ご返金のお知らせ',
  shipped: '商品を発送いたしました',
  shopAlert: '【要対応】返金待ちの返品があります',
  consult: 'ご返金の額は、確かめてから改めてご連絡いたします。',
  refundZero: '今回のご返品では、ご返金の額が0円のため、ご返金はございません。',
  notShipping: '返金した商品はお送りしません。',
  customerPays: '恐れ入りますが、返送料はお客様のご負担でお送りください。',
  shopPays: '返送料は当店が負担いたします。着払いでお送りください。',
  noReturn: '品物のご返送は不要です。',
  sendTo: '下記の返送先へお送りください。',
  exchangeShipped: 'ご返品いただいた品の、交換の品をお送りしました。',
  shopAlertNext: '管理画面の注文の一覧で「額を決めて返金する」を押して、返金してください。',
  accepted1: (orderNumber: string, label: string) => `ご注文（${orderNumber}）の返品を承りました（返品番号 ${label}）。`,
  received1: (label: string) => `ご返品いただいた商品をお受け取りしました（返品番号 ${label}）。`,
  refundLead: (orderNumber: string) => `ご注文（${orderNumber}）の返金の手続きをいたしました。`,
  refundLater: (label: string) => `ご返品いただいた商品のご返金です（返品番号 ${label}）。`,
  payLater: (yen: string) =>
    `交換の品は、手数料 ${yen} のお支払いを確かめてからお送りします。お支払いの方法は、別にご案内いたします。`,
  makeShort: 'お作りしてお送りします。',
  makeNote: (days: number) => `お作りしてお送りします。お届けの目安は ${days}日ほどです。`,
  sentBackLead: (label: string) =>
    `ご返品いただいた商品を確かめましたが、返品・交換をお受けできませんでした（返品番号 ${label}）。品物はお返しいたします。`,
  sentBackTracking: (carrier: string, tracking: string) => `送り返しの伝票番号: ${carrier} ${tracking}`,
} as const;

/** 試験が手元の DB の設定に入れる返送先（毎回同じ値を書く。並行して動く試験どうしが、設定の1行をぶつけ合っても同じ結果になる） */
export const RETURN_ADDRESS = {
  name: 'E2E返品センター',
  postalCode: '1500001',
  address: '東京都渋谷区神宮前1-1-1',
  phone: '0311112222',
} as const;

export const SHOP_ALERT_TO = process.env.SHOP_ALERT_EMAIL ?? 'shop-alert@e2e.test';

// ---- 手元の DB：設定・注文・返品の DB の関数 ----

/**
 * 返品の設定の1行（全部の試験で共有する）に、返送先と、手数料・要検品・返送不要を使う印を書く。
 * 毎回同じ値を書くので、並行して動く試験がぶつかっても同じ結果になる。ほかの欄（受付の期限・理由ごとの設定）は書き換えない。
 * 返送先が空だと返品を作れず、要検品がオフだと検品待ちを受け取れない（DB の関数が断る）ため、返品の試験の準備で必ず呼ぶ。
 */
export async function ensureReturnSettings(db: PgClient): Promise<void> {
  await db.query(
    `update public.shop_return_settings set
       return_address_name = $1, return_address_postal_code = $2, return_address_line = $3, return_address_phone = $4,
       no_return_needed_enabled = true, restocking_fee_enabled = true, exchange_fees_enabled = true, inspection_enabled = true
     where id = 1`,
    [RETURN_ADDRESS.name, RETURN_ADDRESS.postalCode, RETURN_ADDRESS.address, RETURN_ADDRESS.phone],
  );
}

/** 同じ商品の別の色・サイズを足して、番号を返す。在庫は台帳（restock）から入れる（バリアントは初期在庫を持てない） */
export async function addVariant(
  db: PgClient,
  itemId: number,
  input: { color: string; size: string; stock?: number; active?: boolean },
): Promise<number> {
  const color = await db.query(
    `insert into public.item_colors (item_id, name, hex, position) values ($1, $2, '#ffffff', 1) returning id`,
    [itemId, input.color],
  );
  const size = await db.query(`insert into public.item_sizes (item_id, label, position) values ($1, $2, 1) returning id`, [
    itemId,
    input.size,
  ]);
  const variant = await db.query(
    `insert into public.item_variants (item_id, color_id, size_id, is_active) values ($1, $2, $3, $4) returning id`,
    [itemId, color.rows[0].id, size.rows[0].id, input.active ?? true],
  );
  const variantId = Number(variant.rows[0].id);
  if ((input.stock ?? 0) > 0) {
    await db.query(
      `insert into public.stock_movements (variant_id, delta, reason, note) values ($1, $2, 'restock', 'fixture')`,
      [variantId, input.stock],
    );
  }
  return variantId;
}

export type ReturnFixture = {
  orderId: string;
  /** 注文の配送先のメール（お客様へのメールの宛先） */
  email: string;
  /** 管理者の番号（auth.users の行。DB の関数の実行者） */
  actorId: string;
  itemId: number;
  /** 注文の商品が持つ色・サイズ（全部の行が同じ） */
  variantId: number;
  /** 注文の商品の行の番号（lines の順） */
  orderItemIds: string[];
  /** 最初の発送の番号（既定では、全部の商品を1回で送った発送） */
  fulfillmentId: string;
  /** 発送の番号（lines の順。separate を付けると商品ごとに1回ずつ、付けなければ1つだけ） */
  fulfillmentIds: string[];
};

/**
 * 全部の商品を発送した注文（発送済み。受け取った額は注文の合計と同じで、Stripe の支払いの番号つき）を作る。
 * 既定では全部を1回で送る。separate を付けると、商品ごとに1回ずつ送る（発送の取消の守りなど、発送が複数要る試験用）。
 * 受け取りで今返金する道は、支払いの番号（pi_ で始まる値）と受け取った額が無い注文を ORDER_NOT_REFUNDABLE で断るので、必ず付ける。
 * 返品の設定も、ここで整える（ensureReturnSettings）。
 */
export async function createShippedOrder(
  db: PgClient,
  label: string,
  lines: E2eOrderLine[],
  options: { userId?: string; email?: string; separate?: boolean } = {},
): Promise<ReturnFixture> {
  await ensureReturnSettings(db);
  const actorId = await createActor(db);
  const email = options.email ?? uniqueEmail(label);
  const order = await createOrderWithLines(db, email, lines, {
    paidAmount: 'total',
    paymentIntentId: `pi_e2e_${uniqueSuffix()}`,
    userId: options.userId,
  });
  const batches = options.separate
    ? order.orderItemIds.map((orderItemId, index) => [{ orderItemId, quantity: lines[index].quantity }])
    : [order.orderItemIds.map((orderItemId, index) => ({ orderItemId, quantity: lines[index].quantity }))];
  const fulfillmentIds: string[] = [];
  for (const [index, batch] of batches.entries()) {
    const shipment = await createFulfillment(db, order.orderId, actorId, {
      trackingNumber: `E2E-RET-${uniqueSuffix()}-${index + 1}`,
      notify: false,
      lines: batch,
    });
    fulfillmentIds.push(shipment.fulfillmentId);
  }
  return {
    orderId: order.orderId,
    email,
    actorId,
    itemId: order.itemId,
    variantId: order.variantId,
    orderItemIds: order.orderItemIds,
    fulfillmentId: fulfillmentIds[0],
    fulfillmentIds,
  };
}

export type E2eReturnLine = {
  orderItemId: string;
  quantity: number;
  reason?: ReturnReason;
  reasonNote?: string | null;
  /** 交換にする時の色・サイズ（同じ商品の物）と送り方。省くと返金 */
  exchange?: { variantId: number; method: ExchangeMethod };
};

export type E2eCreatedReturn = {
  returnId: string;
  number: number;
  status: string;
  replayed: boolean;
  /** 注文の商品の行の番号 → 返品の行の番号（同じ商品を返金と交換の2行に分けた時は、後の1行だけが入る。2行とも見たい時は lineRows） */
  lineIds: Record<string, string>;
  /** 返品の行を1行ずつ（同じ発送の同じ商品を返金と交換に分けた2行も別々に） */
  lineRows: Array<{ id: string; orderItemId: string; resolution: string; quantity: number }>;
};

export type E2eCreateReturnInput = {
  lines: E2eReturnLine[];
  requestKey?: string;
  method?: ReturnMethod;
  payer?: ShippingPayer;
  returnShippingFee?: number;
  restockingFeePercent?: number;
  exchangeFee?: number;
  exchangeShippingFee?: number;
  shopNote?: string | null;
  notify?: boolean;
};

/** 返品を作る DB の関数 admin_create_return。管理画面の「返品を作る」の代わりに、窓口と同じ関数を直に呼ぶ */
export async function createReturnInDb(
  db: PgClient,
  fx: Pick<ReturnFixture, 'orderId' | 'actorId' | 'fulfillmentId'>,
  input: E2eCreateReturnInput,
): Promise<E2eCreatedReturn> {
  const lines = input.lines.map((line) => ({
    fulfillment_id: fx.fulfillmentId,
    order_item_id: line.orderItemId,
    quantity: line.quantity,
    reason: line.reason ?? 'size_too_small',
    reason_note: line.reasonNote ?? null,
    resolution: line.exchange ? 'exchange' : 'refund',
    exchange_variant_id: line.exchange?.variantId ?? null,
    exchange_method: line.exchange?.method ?? null,
  }));
  const res = await db.query(
    `select * from public.admin_create_return(
       $1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::text, $6::text, null::text, null::text,
       $7::integer, $8::integer, $9::integer, $10::integer, $11::text, $12::boolean)`,
    [
      fx.orderId,
      fx.actorId,
      input.requestKey ?? randomUUID(),
      JSON.stringify(lines),
      input.method ?? 'customer_ships',
      input.payer ?? 'customer',
      input.returnShippingFee ?? 0,
      input.restockingFeePercent ?? 0,
      input.exchangeFee ?? 0,
      input.exchangeShippingFee ?? 0,
      input.shopNote ?? null,
      input.notify ?? true,
    ],
  );
  const row = res.rows[0];
  const returnId = row.return_id as string;
  const saved = await db.query(
    'select id, order_item_id, resolution, quantity from public.order_return_lines where return_id = $1 order by resolution, id',
    [returnId],
  );
  const lineIds: Record<string, string> = {};
  for (const line of saved.rows) lineIds[line.order_item_id as string] = line.id as string;
  const lineRows = saved.rows.map((line) => ({
    id: line.id as string,
    orderItemId: line.order_item_id as string,
    resolution: line.resolution as string,
    quantity: Number(line.quantity),
  }));
  return { returnId, number: Number(row.number), status: row.status as string, replayed: row.replayed as boolean, lineIds, lineRows };
}

export type E2eReceiveUnit = { lineId: string; disposition: ReceiptDisposition; quantity: number };

export type E2eReceiveInput = {
  units: E2eReceiveUnit[];
  requestKey?: string;
  /** 店長か（既定 true）。サポートの人は false */
  canRefund?: boolean;
  /** 既定は相談（consult）。今返金は now、返金の品が無い受け取りは none */
  choice?: RefundChoice;
  /** 店長が直した返金額。省くと計算どおり */
  amount?: number | null;
  shippingAmount?: number;
  note?: string | null;
  notify?: boolean;
  exchangeOverrides?: Array<{ lineId: string; action: 'make' | 'refund' }>;
  sentBack?: { message: string; carrier?: ReturnCarrier | null; trackingNumber?: string | null };
};

export type E2eReceived = {
  receiptId: string;
  returnStatus: string;
  refundId: string | null;
  /** 返金の無い受け取り（相談・返金の品が無い・お返しだけ）は null。0円で終えた受け取り（waived）は 0（C-3。窓口の答えと同じ） */
  refundAmount: number | null;
  refundStatus: string | null;
  exchangeOrderItemIds: string[];
  feeDueAmount: number;
  shopNoticeEnqueued: boolean;
  replayed: boolean;
};

/** 受け取りの DB の関数 admin_receive_return。受け取りの画面の確定の代わりに、窓口と同じ関数を直に呼ぶ（Stripe には頼まない） */
export async function receiveReturnInDb(
  db: PgClient,
  returnId: string,
  actorId: string,
  input: E2eReceiveInput,
): Promise<E2eReceived> {
  const res = await db.query(
    `select * from public.admin_receive_return(
       $1::uuid, $2::uuid, $3::boolean, $4::uuid, $5::jsonb, $6::jsonb, $7::text, $8::integer,
       $9::integer, $10::text, $11::boolean, $12::text, $13::text, $14::text)`,
    [
      returnId,
      actorId,
      input.canRefund ?? true,
      input.requestKey ?? randomUUID(),
      JSON.stringify(
        input.units.map((unit) => ({ return_line_id: unit.lineId, disposition: unit.disposition, quantity: unit.quantity })),
      ),
      JSON.stringify((input.exchangeOverrides ?? []).map((item) => ({ return_line_id: item.lineId, action: item.action }))),
      input.choice ?? 'consult',
      input.amount ?? null,
      input.shippingAmount ?? 0,
      input.note ?? null,
      input.notify ?? true,
      input.sentBack?.message ?? null,
      input.sentBack?.carrier ?? null,
      input.sentBack?.trackingNumber ?? null,
    ],
  );
  const row = res.rows[0];
  return {
    receiptId: row.receipt_id as string,
    returnStatus: row.return_status as string,
    refundId: (row.refund_id as string | null) ?? null,
    refundAmount: row.refund_amount === null ? null : Number(row.refund_amount),
    refundStatus: (row.refund_status as string | null) ?? null,
    exchangeOrderItemIds: (row.exchange_order_item_ids as string[] | null) ?? [],
    feeDueAmount: Number(row.fee_due_amount),
    shopNoticeEnqueued: row.shop_notice_enqueued as boolean,
    replayed: row.replayed as boolean,
  };
}

export type E2eReturnRefund = { refundId: string | null; amount: number; status: string; replayed: boolean };

/** 額を決めて返金する DB の関数 admin_refund_return（返金の記録を作るだけ。Stripe には頼まない）。amount 0 は返金しないで終える（P20） */
export async function refundReturnInDb(
  db: PgClient,
  returnId: string,
  actorId: string,
  input: { requestKey?: string; amount?: number | null; shippingAmount?: number; note?: string | null; notify?: boolean } = {},
): Promise<E2eReturnRefund> {
  const res = await db.query(
    `select * from public.admin_refund_return($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::integer, $6::text, $7::boolean)`,
    [
      returnId,
      actorId,
      input.requestKey ?? randomUUID(),
      input.amount ?? null,
      input.shippingAmount ?? 0,
      input.note ?? null,
      input.notify ?? true,
    ],
  );
  const row = res.rows[0];
  return {
    refundId: (row.refund_id as string | null) ?? null,
    amount: Number(row.amount),
    status: row.status as string,
    replayed: row.replayed as boolean,
  };
}

/** 返品を取り消す DB の関数 admin_cancel_return（何も受け取る前だけ） */
export async function cancelReturnInDb(db: PgClient, returnId: string, actorId: string): Promise<string> {
  const res = await db.query('select * from public.admin_cancel_return($1::uuid, $2::uuid)', [returnId, actorId]);
  return res.rows[0].status as string;
}

export type E2eReceiptOutcome = { receiptId: string; returnStatus: string; replayed: boolean };

function toReceiptOutcome(row: Record<string, unknown>): E2eReceiptOutcome {
  return { receiptId: row.receipt_id as string, returnStatus: row.return_status as string, replayed: row.replayed as boolean };
}

/** 「届かないものとして返品を終える」の DB の関数 admin_close_return_missing */
export async function closeMissingInDb(
  db: PgClient,
  returnId: string,
  actorId: string,
  requestKey: string = randomUUID(),
): Promise<E2eReceiptOutcome> {
  const res = await db.query('select * from public.admin_close_return_missing($1::uuid, $2::uuid, $3::uuid)', [
    returnId,
    actorId,
    requestKey,
  ]);
  return toReceiptOutcome(res.rows[0]);
}

/** 開き直す DB の関数 admin_reopen_return */
export async function reopenReturnInDb(
  db: PgClient,
  returnId: string,
  actorId: string,
  requestKey: string = randomUUID(),
): Promise<E2eReceiptOutcome> {
  const res = await db.query('select * from public.admin_reopen_return($1::uuid, $2::uuid, $3::uuid)', [
    returnId,
    actorId,
    requestKey,
  ]);
  return toReceiptOutcome(res.rows[0]);
}

/** 検品を終える DB の関数 admin_inspect_return。行ごとに、戻す数と戻さない数を渡す */
export async function inspectReturnInDb(
  db: PgClient,
  returnId: string,
  actorId: string,
  lines: Array<{ lineId: string; restocked: number; notRestocked: number }>,
  requestKey: string = randomUUID(),
): Promise<E2eReceiptOutcome> {
  const res = await db.query('select * from public.admin_inspect_return($1::uuid, $2::uuid, $3::uuid, $4::jsonb)', [
    returnId,
    actorId,
    requestKey,
    JSON.stringify(lines.map((line) => ({ return_line_id: line.lineId, restocked: line.restocked, not_restocked: line.notRestocked }))),
  ]);
  return toReceiptOutcome(res.rows[0]);
}

/**
 * 手数料の受け取りを記録する DB の関数 admin_record_return_fee_payment（店長だけが押す操作）。
 * waive を付けると「いただかないで終える」（計画の冒頭 P27。受け取りの記録と同じく手数料のお支払い待ちを終えるが、
 * 受け取った物ではなく、いただかないことにした印 fee_waived を付ける）。
 */
export async function recordFeePaymentInDb(
  db: PgClient,
  returnId: string,
  actorId: string,
  note: string | null = null,
  waive = false,
): Promise<string> {
  const res = await db.query(
    'select * from public.admin_record_return_fee_payment($1::uuid, $2::uuid, $3::text, $4::boolean)',
    [returnId, actorId, note, waive],
  );
  return res.rows[0].return_status as string;
}

/** 支払いを待たずに送る DB の関数 admin_release_return_exchange（店長だけが押す操作） */
export async function releaseExchangeInDb(db: PgClient, returnId: string, actorId: string): Promise<string> {
  const res = await db.query('select * from public.admin_release_return_exchange($1::uuid, $2::uuid)', [returnId, actorId]);
  return res.rows[0].return_status as string;
}

// ---- 手元の DB：読み出し ----

export type E2eReturnRow = {
  number: number;
  source: string;
  status: string;
  return_method: string;
  return_shipping_payer: string;
  return_shipping_fee: number;
  restocking_fee_percent: number;
  exchange_fee: number;
  exchange_shipping_fee: number;
  fee_due_amount: number;
  fee_settled_amount: number;
  fee_pending_deduction: number;
  fee_received_at: Date | null;
  fee_waived: boolean;
  exchange_released_at: Date | null;
  notify_customer: boolean;
  shop_note: string | null;
};

export async function returnRowOf(db: PgClient, returnId: string): Promise<E2eReturnRow> {
  const res = await db.query(
    `select number, source, status, return_method, return_shipping_payer, return_shipping_fee, restocking_fee_percent,
            exchange_fee, exchange_shipping_fee, fee_due_amount, fee_settled_amount, fee_pending_deduction, fee_received_at, fee_waived,
            exchange_released_at, notify_customer, shop_note
     from public.order_returns where id = $1`,
    [returnId],
  );
  return res.rows[0] as E2eReturnRow;
}

export async function returnCountOf(db: PgClient, orderId: string): Promise<number> {
  const res = await db.query('select count(*)::int as n from public.order_returns where order_id = $1', [orderId]);
  return Number(res.rows[0].n);
}

export type E2eReturnLineRow = {
  quantity: number;
  reason: string;
  reason_note: string | null;
  resolution: string;
  exchange_variant_id: string | null;
  exchange_method: string | null;
};

export async function returnLineRowOf(db: PgClient, lineId: string): Promise<E2eReturnLineRow> {
  const res = await db.query(
    `select quantity, reason, reason_note, resolution, exchange_variant_id, exchange_method
     from public.order_return_lines where id = $1`,
    [lineId],
  );
  return res.rows[0] as E2eReturnLineRow;
}

export type E2eLineProgress = {
  quantity: number;
  restocked: number;
  not_restocked: number;
  pending_inspection: number;
  sent_back: number;
  missing: number;
  processed: number;
  unprocessed: number;
  exchanged: number;
  refund_covered: number;
  refund_waived: number;
  refund_waiting: number;
};

/** 返品の行ごとの処理の数（受け取り・検品・届かない・開き直しを足し引きした結果）。キーは返品の行の番号 */
export async function lineProgressOf(db: PgClient, returnId: string): Promise<Record<string, E2eLineProgress>> {
  const res = await db.query('select * from private.order_return_line_progress($1::uuid)', [returnId]);
  const progress: Record<string, E2eLineProgress> = {};
  for (const row of res.rows) {
    progress[row.return_line_id as string] = {
      quantity: Number(row.quantity),
      restocked: Number(row.restocked),
      not_restocked: Number(row.not_restocked),
      pending_inspection: Number(row.pending_inspection),
      sent_back: Number(row.sent_back),
      missing: Number(row.missing),
      processed: Number(row.processed),
      unprocessed: Number(row.unprocessed),
      exchanged: Number(row.exchanged),
      refund_covered: Number(row.refund_covered),
      refund_waived: Number(row.refund_waived),
      refund_waiting: Number(row.refund_waiting),
    };
  }
  return progress;
}

export type E2eReceiptRow = {
  id: string;
  kind: string;
  refund_choice: string | null;
  refund_id: string | null;
  notify_customer: boolean;
  actor_can_refund: boolean | null;
};

/** 返品の受け取りの記録（追記だけの表）を、書いた順に読む */
export async function receiptRows(db: PgClient, returnId: string): Promise<E2eReceiptRow[]> {
  const res = await db.query(
    `select id, kind, refund_choice, refund_id, notify_customer, actor_can_refund
     from public.order_return_receipts where return_id = $1 order by created_at, id`,
    [returnId],
  );
  return res.rows as E2eReceiptRow[];
}

export type E2eReceiptUnitRow = {
  disposition: string;
  quantity: number;
  resolution: string | null;
  exchange_method: string | null;
};

/** 受け取りの行（品ごとの状態と数）。状態の名前の順 */
export async function receiptUnitRows(db: PgClient, receiptId: string): Promise<E2eReceiptUnitRow[]> {
  const res = await db.query(
    `select disposition, quantity, resolution, exchange_method
     from public.order_return_receipt_lines where receipt_id = $1 order by disposition, quantity`,
    [receiptId],
  );
  return res.rows as E2eReceiptUnitRow[];
}

export type E2eReturnRefundRow = { id: string; return_id: string | null; source: string; status: string; amount: number };

/** その注文の返金の記録（返品の番号つき）を、作った順に読む */
export async function returnRefundRows(db: PgClient, orderId: string): Promise<E2eReturnRefundRow[]> {
  const res = await db.query(
    `select id, return_id, source, status, amount from public.order_refunds where order_id = $1 order by created_at, id`,
    [orderId],
  );
  return res.rows as E2eReturnRefundRow[];
}

export type E2eReturnLedgerRow = { reason: string; delta: number; return_id: string | null; variant_id: number };

/** その注文で、返品が動かした在庫の台帳（return・exchange）を、書いた順に読む */
export async function returnLedger(db: PgClient, orderId: string): Promise<E2eReturnLedgerRow[]> {
  const res = await db.query(
    `select reason, delta, return_id, variant_id from public.stock_movements
     where order_id = $1 and reason in ('return', 'exchange') order by id`,
    [orderId],
  );
  return res.rows.map((row) => ({
    reason: row.reason as string,
    delta: Number(row.delta),
    return_id: (row.return_id as string | null) ?? null,
    variant_id: Number(row.variant_id),
  }));
}

export type E2eExchangeItemRow = {
  id: string;
  item_name: string;
  quantity: number;
  item_price: number;
  line_total: number;
  line_kind: string;
  fulfillment_type: string;
  exchange_paid_amount: number | null;
  variant_id: number | null;
};

/** その注文の交換の品の行 */
export async function exchangeItemRows(db: PgClient, orderId: string): Promise<E2eExchangeItemRow[]> {
  const res = await db.query(
    `select id, item_name, quantity, item_price, line_total, line_kind, fulfillment_type, exchange_paid_amount, variant_id
     from public.order_items where order_id = $1 and line_kind = 'exchange' order by created_at, id`,
    [orderId],
  );
  return res.rows as E2eExchangeItemRow[];
}

export type E2eReturnSummaryRow = {
  display_status: string | null;
  marks: string[];
  next_action: string;
  has_returnable: boolean;
  refund_waiting_returns: number;
  requested_returns: number;
};

/** 一覧の「返品」の列の元（list_order_return_summaries）。注文に返品が無ければ display_status は NULL */
export async function returnSummaryRow(db: PgClient, orderId: string): Promise<E2eReturnSummaryRow> {
  const res = await db.query(
    `select display_status, marks, next_action, has_returnable, refund_waiting_returns, requested_returns
     from public.list_order_return_summaries(array[$1::uuid])`,
    [orderId],
  );
  const row = res.rows[0];
  return {
    display_status: (row.display_status as string | null) ?? null,
    marks: (row.marks as string[] | null) ?? [],
    next_action: row.next_action as string,
    has_returnable: row.has_returnable as boolean,
    refund_waiting_returns: Number(row.refund_waiting_returns),
    requested_returns: Number(row.requested_returns),
  };
}

/** 一覧の絞り込み「返品」の元（list_order_ids_by_return_status）。その表示の状態の返品がある注文の番号（新しい注文から500件まで） */
export async function orderIdsByReturnStatus(db: PgClient, displayStatus: string): Promise<string[]> {
  const res = await db.query('select order_id from public.list_order_ids_by_return_status($1::text)', [displayStatus]);
  return res.rows.map((row) => row.order_id as string);
}

/** 一覧の上の一行の数（count_order_return_attention）。全部の注文の数なので、並行して動く試験の分も入る（下限でだけ比べる） */
export async function returnAttentionCounts(db: PgClient): Promise<{ requested: number; refundWaiting: number }> {
  const res = await db.query('select requested, refund_waiting from public.count_order_return_attention()');
  return { requested: Number(res.rows[0].requested), refundWaiting: Number(res.rows[0].refund_waiting) };
}

/** 注文の商品ごとの返品できる数（list_order_line_return_counts の returnable）。キーは注文の商品の行の番号 */
export async function returnableByItem(db: PgClient, orderId: string): Promise<Record<string, number>> {
  const res = await db.query(
    'select order_item_id, returnable from public.list_order_line_return_counts(array[$1::uuid])',
    [orderId],
  );
  const counts: Record<string, number> = {};
  for (const row of res.rows) counts[row.order_item_id as string] = Number(row.returnable);
  return counts;
}

export type E2eReturnEmailRow = {
  kind: string;
  variant: string | null;
  status: string;
  return_id: string | null;
  return_receipt_id: string | null;
  refund_id: string | null;
};

/** 返品に結び付くメールの予定（return_ で始まる種類と、返品の返金のお知らせ）を、書いた順に読む */
export async function returnEmailRows(db: PgClient, orderId: string): Promise<E2eReturnEmailRow[]> {
  const res = await db.query(
    `select kind, variant, status, return_id, return_receipt_id, refund_id
     from private.order_email_outbox
     where order_id = $1 and (kind like 'return\\_%' or (kind = 'refund' and variant = 'return')) order by seq`,
    [orderId],
  );
  return res.rows as E2eReturnEmailRow[];
}

/** 送信済みになった、返品に結び付くメールの行の数（種類で絞る）。メールが着いてから行が送信済みになるまでの、わずかな差を待つために使う */
export async function sentReturnMailCount(orderId: string, kind: string): Promise<number> {
  const rows = await withLocalDb((db) => returnEmailRows(db, orderId));
  return rows.filter((row) => row.kind === kind && row.status === 'sent').length;
}

/** 件名に subjectIncludes を含むメールが count 通になるまで、worker を叩き直して待ち、本文つきで返す */
export async function waitForMails(
  request: APIRequestContext,
  email: string,
  subjectIncludes: string,
  count = 1,
): Promise<MailBody[]> {
  await runWorkerUntil(
    request,
    async () => (await mailBodies(request, email, subjectIncludes)).length >= count,
    `${subjectIncludes} のメールが${count}通届くこと`,
  );
  return mailBodies(request, email, subjectIncludes);
}

/** 店への要対応メール（宛先は E2E の固定の値）のうち、その注文の物。同じ宛先を他の試験も使うので、注文番号で絞る */
export async function shopAlertsFor(request: APIRequestContext, orderNumber: string): Promise<MailBody[]> {
  return (await mailBodies(request, SHOP_ALERT_TO, '【要対応】')).filter((mail) => mail.Text.includes(orderNumber));
}

// ---- 窓口の答えの組み立て（画面を窓口の差し替えで確かめる） ----

export const SHIPPED_AT = '2026-10-10T03:00:00.000Z';
export const FULFILLMENT_ID = 'f3b2c3d4-0000-4000-8000-0000000000f1';
export const ITEM_ID = 9001;
export const VARIANT_ID = 9101;

/** 返品の番号の表示（注文番号の末尾に -R と返品の番号を付ける。formatReturnNumber と同じ） */
export function returnLabelOf(orderId: string, number: number): string {
  return `${orderNumberOf(orderId)}-R${number}`;
}

type LineProgress = OrderReturnLineDetail['progress'];

const ZERO_PROGRESS: Omit<LineProgress, 'unprocessed'> = {
  restocked: 0,
  notRestocked: 0,
  pendingInspection: 0,
  sentBack: 0,
  missing: 0,
  processed: 0,
  exchanged: 0,
  refundCovered: 0,
  refundWaived: 0,
  refundWaiting: 0,
};

/** 交換の色・サイズの見本 */
export function exchangeOf(input: Partial<NonNullable<OrderReturnLineDetail['exchange']>> = {}): NonNullable<OrderReturnLineDetail['exchange']> {
  return {
    variantId: VARIANT_ID + 1,
    color: 'ホワイト',
    size: 'L',
    method: 'stock',
    stockQuantity: 3,
    madeToOrderLeadDays: 5,
    outOfStockExchange: 'decline' as OutOfStockExchange,
    ...input,
  };
}

/**
 * 返品の行の見本（既定は、シルクブラウス1点・返金・まだ何も処理していない）。
 * 処理した数（processed）・未処理の数（unprocessed）・返金の見込み（添字 k−1 は k 点分の商品の額）は、渡さなければ他の欄から出す。
 */
export function returnLineOf(input: {
  id: string;
  orderItemId: string;
  quantity?: number;
  itemName?: string;
  color?: string | null;
  size?: string | null;
  fulfillmentId?: string;
  reason?: ReturnReason;
  reasonNote?: string | null;
  exchange?: OrderReturnLineDetail['exchange'];
  progress?: Partial<LineProgress>;
  unitAmount?: number;
}): OrderReturnLineDetail {
  const quantity = input.quantity ?? 1;
  const unitAmount = input.unitAmount ?? PRICE;
  const done = { ...ZERO_PROGRESS, ...input.progress };
  const processed =
    input.progress?.processed ?? done.restocked + done.notRestocked + done.pendingInspection + done.sentBack + done.missing;
  const unprocessed = input.progress?.unprocessed ?? quantity - processed;
  const exchange = input.exchange ?? null;
  return {
    id: input.id,
    fulfillmentId: input.fulfillmentId ?? FULFILLMENT_ID,
    fulfillmentNumber: 1,
    orderItemId: input.orderItemId,
    itemName: input.itemName ?? 'シルクブラウス',
    color: input.color === undefined ? 'ホワイト' : input.color,
    size: input.size === undefined ? 'M' : input.size,
    quantity,
    reason: input.reason ?? 'size_too_small',
    reasonNote: input.reasonNote ?? null,
    resolution: exchange ? 'exchange' : 'refund',
    exchange,
    progress: { ...done, processed, unprocessed },
    // 交換の予定の行にも入れる（受け取りで「返金に変える」を選んだ時の見込みに使う。計画の冒頭 C-2）
    refundAmountsByCount: Array.from({ length: unprocessed }, (_, index) => unitAmount * (index + 1)),
    refundWaitingAmount: exchange ? 0 : unitAmount * done.refundWaiting,
  };
}

/** 返品の見本（既定は、お店が作った・返送はお客様が送る・受け取り待ちの返品中） */
export function returnDetailOf(input: {
  orderId: string;
  lines: OrderReturnLineDetail[];
  id?: string;
  number?: number;
  status?: ReturnStatus;
  displayStatus?: OrderReturnDetail['displayStatus'];
  marks?: OrderReturnDetail['marks'];
  returnMethod?: ReturnMethod;
  returnShippingPayer?: ShippingPayer;
  fees?: Partial<OrderReturnDetail['fees']>;
  firstReceiptDone?: boolean;
  firstExchangeReceiptDone?: boolean;
  refunds?: OrderReturnDetail['refunds'];
  receipts?: OrderReturnDetail['receipts'];
  exchangeItems?: OrderReturnDetail['exchangeItems'];
  shopNote?: string | null;
}): OrderReturnDetail {
  const number = input.number ?? 1;
  const status = input.status ?? 'open';
  return {
    id: input.id ?? `b3b2c3d4-0000-4000-8000-00000000000${number}`,
    number,
    label: returnLabelOf(input.orderId, number),
    status,
    source: 'shop',
    displayStatus: input.displayStatus === undefined ? 'in_progress' : input.displayStatus,
    marks: input.marks ?? ['awaiting_items'],
    returnMethod: input.returnMethod ?? 'customer_ships',
    returnShippingPayer: input.returnShippingPayer ?? 'customer',
    returnCarrier: null,
    returnTrackingNumber: null,
    fees: {
      returnShippingFee: 0,
      restockingFeePercent: 0,
      exchangeFee: 0,
      exchangeShippingFee: 0,
      feeDueAmount: 0,
      // 相談の受け取りで付き、額を決めて返金する時に引く手数料（C-2 の必須の欄。額を決めて返金の画面が読む）
      feePendingDeduction: 0,
      feeReceivedAt: null,
      exchangeReleasedAt: null,
      ...input.fees,
    },
    firstReceiptDone: input.firstReceiptDone ?? false,
    firstExchangeReceiptDone: input.firstExchangeReceiptDone ?? false,
    shopNote: input.shopNote ?? null,
    notifyCustomer: true,
    createdAt: '2026-10-11T00:00:00.000Z',
    createdByEmail: 'admin@example.com',
    closedAt: status === 'closed' ? '2026-10-12T00:00:00.000Z' : null,
    cancelledAt: status === 'cancelled' ? '2026-10-12T00:00:00.000Z' : null,
    lines: input.lines,
    refunds: input.refunds ?? [],
    receipts: input.receipts ?? [],
    exchangeItems: input.exchangeItems ?? [],
  };
}

/** 一覧の「返品」の列の元（C-2 の OrderReturnSummary）。既定は、返品は無いが返品できる品がある */
export function returnSummaryOf(input: Partial<OrderReturnSummary> & { orderId: string }): OrderReturnSummary {
  return {
    displayStatus: null,
    marks: [],
    nextAction: 'none',
    hasReturnable: true,
    refundWaitingReturns: 0,
    requestedReturns: 0,
    ...input,
  };
}

type MaterialShipment = ReturnCreateMaterials['shipments'][number];
type MaterialLine = MaterialShipment['lines'][number];

/** 返品を作る画面の材料の、発送の行（既定は、シルクブラウス1点・返品できる数1） */
export function materialsLineOf(input: Partial<MaterialLine> & { orderItemId: string }): MaterialLine {
  return {
    itemId: ITEM_ID,
    variantId: VARIANT_ID,
    itemName: 'シルクブラウス',
    color: 'ホワイト',
    size: 'M',
    lineKind: 'order',
    quantity: 1,
    returnable: 1,
    ...input,
  };
}

/** 返品を作る画面の材料の、発送（既定は、10月10日に送った1回目で、期限は10月20日・過ぎていない） */
export function materialsShipmentOf(input: Partial<MaterialShipment> & { lines: MaterialLine[] }): MaterialShipment {
  return {
    fulfillmentId: FULFILLMENT_ID,
    number: 1,
    shippedAt: SHIPPED_AT,
    deadlineDate: '2026-10-20',
    pastDeadline: false,
    ...input,
  };
}

const DEFAULT_PAYERS: Record<ReturnReason, ShippingPayer> = {
  defective: 'shop',
  wrong_item: 'shop',
  size_too_small: 'customer',
  size_too_large: 'customer',
  color: 'customer',
  style: 'customer',
  not_as_described: 'customer',
  unwanted: 'customer',
  other: 'customer',
  unknown: 'customer',
};

const DEFAULT_OUT_OF_STOCK: Record<ReturnReason, OutOfStockExchange> = {
  defective: 'make',
  wrong_item: 'make',
  size_too_small: 'decline',
  size_too_large: 'decline',
  color: 'decline',
  style: 'decline',
  not_as_described: 'decline',
  unwanted: 'decline',
  other: 'decline',
  unknown: 'decline',
};

/** 返品を作る画面の材料（GET …/returns/materials の data）。設定の既定は、仕様書 8-3 の最初の値（手数料は使わない・返送先は入っている） */
export function returnMaterialsOf(input: {
  orderId: string;
  shipments: MaterialShipment[];
  exchangeOptions?: ReturnCreateMaterials['exchangeOptions'];
  settings?: Partial<ReturnCreateMaterials['settings']>;
  hasAwaitingRefund?: boolean;
}): ReturnCreateMaterials {
  return {
    order: { id: input.orderId, status: 'shipped', hasAwaitingRefund: input.hasAwaitingRefund ?? false },
    shipments: input.shipments,
    exchangeOptions: input.exchangeOptions ?? [],
    settings: {
      returnAddressSet: true,
      noReturnNeededEnabled: false,
      customerPaidMethod: 'customer_ships',
      shopLabelFee: 0,
      restockingFeeEnabled: false,
      restockingFeePercent: 0,
      exchangeFeesEnabled: false,
      exchangeFee: 0,
      exchangeShippingFee: 0,
      reasonShippingPayers: DEFAULT_PAYERS,
      reasonOutOfStockExchange: DEFAULT_OUT_OF_STOCK,
      ...input.settings,
    },
  };
}

/**
 * 一覧の注文の行（返品の要約つき）。返品の要約と、商品の行の印（lineKind）は、Task 8・11 が足した欄。
 * 型を足す前でも書けるよう、欄を足した物として渡す（型は足した後の形に合っている）。
 */
export function orderWithReturns(
  input: { id: string; summary: OrderReturnSummary } & Partial<Omit<OrderItem, 'id'>>,
): OrderItem {
  const { summary, ...rest } = input;
  return adminOrder({
    status: '配送中',
    orderStatus: 'shipped',
    progressKey: 'in_transit',
    canShip: false,
    canRefund: true,
    ...rest,
    returnSummary: summary,
  } as Partial<OrderItem> & { id: string });
}

/**
 * 注文の一覧の窓口（答えに returnAttention＝一覧の上の一行の数 つき）。読まれた URL を記録する。数は試験が呼び出しごとに替えられる。
 * 注文の番号つきの窓口（…/orders/{id}/…）と取り違えないよう、パスが一覧だけの時に当てる。
 */
export async function mockOrderListWithAttention(
  page: Page,
  current: () => OrderItem[],
  attention: () => { requested: number; refundWaiting: number },
): Promise<{ urls: string[] }> {
  const urls: string[] = [];
  await page.route(
    (url) => url.pathname === '/api/admin/orders',
    (route) => {
      urls.push(route.request().url());
      const orders = current();
      return fulfillJson(route, {
        data: orders,
        pagination: { page: 1, pageSize: 20, total: orders.length, totalPages: 1 },
        returnAttention: attention(),
      });
    },
  );
  return { urls };
}

/** 一覧の購入商品の、交換の品の行（印 lineKind は Task 8・11 が足した欄。型を足す前でも書けるよう、欄を足した物として渡す） */
export function exchangeOrderLine(overrides: Partial<OrderLineItem> = {}): OrderLineItem {
  return orderLine({ ...overrides, lineKind: 'exchange' } as Partial<OrderLineItem>);
}

/**
 * 発送の画面の材料の、交換の品の行。印 lineKind と、手数料のお支払いを待っていて送れない数 exchangeOnHold は Task 8 が足した欄
 * （窓口は必ず返す。交換の品の行は、お支払い待ちの間、その行の未発送の数の全部が exchangeOnHold になる）。
 */
export function exchangeMaterialLine(
  input: { orderItemId: string; onHold: number } & Partial<FulfillmentMaterialLine>,
): FulfillmentMaterialLine {
  const { onHold, ...rest } = input;
  return {
    ...materialLine({ name: 'E2Eシャツ', color: 'ホワイト', size: 'L', quantity: 1, readyUnshipped: 1, ...rest }),
    lineKind: 'exchange',
    exchangeOnHold: onHold,
  } as FulfillmentMaterialLine;
}

/**
 * 履歴の返品の行（Task 8 の OrderHistoryReturnEntry）。文は窓口が C-5 のとおり組み立て済みで、画面は title と details をそのまま出す。
 * した人（actorEmail）は、窓口が引けた時だけ入る。分からない行は null で、画面は「操作:」を出さない。
 * 手数料をいただかないことにした行も kind は fee_received のまま（画面は kind で出し分けず、言葉は title が運ぶ）。
 * 型は実装の型（Task 8）をそのまま使う。欄が変わったら、tsc が教える。
 */
export function returnHistoryEntry(input: {
  kind: OrderHistoryReturnEntryKind;
  at: string;
  /** 交換の品を足した行だけ null */
  returnId: string | null;
  title: string;
  details?: string[];
  actorEmail?: string | null;
}): OrderHistoryReturnEntry {
  return {
    type: 'return',
    kind: input.kind,
    id: `${input.kind}-${input.at}`,
    at: input.at,
    returnId: input.returnId,
    title: input.title,
    details: input.details ?? [],
    actorEmail: input.actorEmail ?? null,
  };
}

/** 履歴のメールの行（返品のメール。再送のボタンは付かない）。kind は Task 6 が足す種類（OrderEmailKind） */
export function returnEmailHistoryEntry(input: {
  kind: OrderHistoryEmailEntry['kind'];
  kindLabel: string;
  at: string;
}): OrderHistoryEmailEntry {
  return {
    type: 'email',
    at: input.at,
    emailId: randomUUID(),
    kind: input.kind,
    kindLabel: input.kindLabel,
    manual: false,
    requestedByEmail: null,
    stateLabel: '送信済み',
    warning: false,
    attempts: 1,
    errorLabel: null,
    sentAt: input.at,
    deliveryEventAt: null,
    canViewContent: true,
    bodyErased: false,
    resendable: false,
    fulfillmentId: null,
    fulfillmentNumber: null,
  };
}

/** 一覧のその注文の行の「履歴」を押して、注文の履歴の画面を開く */
export async function openHistoryDialog(page: Page, orderId: string): Promise<Locator> {
  await page.getByRole('button', { name: `${orderNumberOf(orderId)} の履歴` }).click();
  const dialog = page.getByRole('dialog', { name: 'この注文の履歴' });
  await expect(dialog).toBeVisible();
  return dialog;
}

export type ReturnAction =
  | 'receive'
  | 'refund'
  | 'cancel'
  | 'reopen'
  | 'close-missing'
  | 'inspect'
  | 'fee-payment'
  | 'release-exchange';

const RETURN_ACTIONS: readonly ReturnAction[] = [
  'receive',
  'refund',
  'cancel',
  'reopen',
  'close-missing',
  'inspect',
  'fee-payment',
  'release-exchange',
];

export type ReturnPost = { returnId: string; body: Record<string, unknown> };

export type ReturnRouteState = {
  /** GET …/returns の答え。試験が差し替えられる */
  returns: OrderReturnDetail[];
  canRefund: boolean;
  returnableUnits: number;
  refundableAmount: number;
  refundableShipping: number;
  /** 要検品を使うか（ショップの設定。GET …/returns の答えに入る欄で、受け取りの画面が「検品待ち」を選ばせるかを決める） */
  inspectionEnabled: boolean;
  /** GET …/returns/materials の答え */
  materials: ReturnCreateMaterials;
  listReads: number;
  materialsReads: number;
  createPosts: Array<Record<string, unknown>>;
  posts: Record<ReturnAction, ReturnPost[]>;
  /** POST …/returns（返品を作る）の答え。既定は「作れた」 */
  answerCreate: (route: Route, body: Record<string, unknown>) => Promise<void>;
  /** POST …/returns/{returnId}/{action} の答え。既定は、操作ごとの「受け付けた」の答え */
  answerAction: (route: Route, action: ReturnAction, post: ReturnPost) => Promise<void>;
};

/** 受け取りの窓口の「受け付けた」答えの data（C-3）。既定は、返金の無い受け取り（返金の欄はどれも null。0円で終えた受け取りだけ refundAmount 0・refundStatus waived）で、返品は受付中のまま */
export function receiveData(input: Partial<Record<'receiptId' | 'returnStatus' | 'refundId' | 'refundAmount' | 'refundStatus' | 'feeDueAmount' | 'replayed', unknown>> = {}) {
  return {
    receiptId: randomUUID(),
    returnStatus: 'open',
    refundId: null,
    refundAmount: null,
    refundStatus: null,
    feeDueAmount: 0,
    replayed: false,
    ...input,
  };
}

/** 額を決めて返金の窓口の「受け付けた」答えの data（C-3）。0円なら refundId は null・status は waived */
export function refundData(input: { amount: number; status?: string; refundId?: string | null; replayed?: boolean }) {
  return {
    refundId: input.refundId === undefined ? randomUUID() : input.refundId,
    amount: input.amount,
    status: input.status ?? 'pending',
    replayed: input.replayed ?? false,
  };
}

function defaultActionData(action: ReturnAction): Record<string, unknown> {
  if (action === 'receive') return receiveData();
  if (action === 'refund') return refundData({ amount: 0 });
  return { returnStatus: 'open' };
}

export function newReturnRouteState(input: {
  orderId: string;
  returns?: OrderReturnDetail[];
  materials?: ReturnCreateMaterials;
  canRefund?: boolean;
  returnableUnits?: number;
  refundableAmount?: number;
  refundableShipping?: number;
}): ReturnRouteState {
  const state: ReturnRouteState = {
    returns: input.returns ?? [],
    canRefund: input.canRefund ?? true,
    returnableUnits: input.returnableUnits ?? 1,
    refundableAmount: input.refundableAmount ?? PRICE * 4,
    refundableShipping: input.refundableShipping ?? 0,
    inspectionEnabled: true,
    materials: input.materials ?? returnMaterialsOf({ orderId: input.orderId, shipments: [] }),
    listReads: 0,
    materialsReads: 0,
    createPosts: [],
    posts: {
      receive: [],
      refund: [],
      cancel: [],
      reopen: [],
      'close-missing': [],
      inspect: [],
      'fee-payment': [],
      'release-exchange': [],
    },
    answerCreate: (route) =>
      fulfillJson(route, { data: { returnId: randomUUID(), number: state.returns.length + 1, status: 'open', replayed: false } }),
    answerAction: (route, action) => fulfillJson(route, { data: defaultActionData(action) }),
  };
  return state;
}

/**
 * その注文の返品の窓口（一覧と中身・材料・作る）と、返品ごとの操作の窓口を差し替える。
 * 後から登録した窓口が先に効くので、管理画面の窓口（mockAdminSession・mockOrderList）を先に呼んでから、これを呼ぶ。
 */
export async function mockReturnRoutes(page: Page, orderId: string, state: ReturnRouteState): Promise<void> {
  await page.route(`**/api/admin/orders/${orderId}/returns/materials`, async (route) => {
    state.materialsReads += 1;
    await fulfillJson(route, { data: state.materials });
  });
  await page.route(`**/api/admin/orders/${orderId}/returns`, async (route) => {
    if (route.request().method() === 'GET') {
      state.listReads += 1;
      await fulfillJson(route, {
        data: {
          returns: state.returns,
          canRefund: state.canRefund,
          returnableUnits: state.returnableUnits,
          refundableAmount: state.refundableAmount,
          refundableShipping: state.refundableShipping,
          inspectionEnabled: state.inspectionEnabled,
        },
      });
      return;
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.createPosts.push(body);
    await state.answerCreate(route, body);
  });
  await page.route(/\/api\/admin\/returns\/[^/]+\/[a-z-]+$/, async (route) => {
    const match = /\/api\/admin\/returns\/([^/]+)\/([a-z-]+)$/.exec(new URL(route.request().url()).pathname);
    const action = match?.[2] as ReturnAction | undefined;
    if (!match || !action || !RETURN_ACTIONS.includes(action)) {
      await route.fallback();
      return;
    }
    const post: ReturnPost = { returnId: match[1], body: (route.request().postDataJSON() ?? {}) as Record<string, unknown> };
    state.posts[action].push(post);
    await state.answerAction(route, action, post);
  });
}

/** 窓口に届いた受け取りの本文の units から、返品の行と状態ごとの数を合わせた数を読む（1行にまとめて送る作りでも、1点ずつ送る作りでも同じ値になる） */
export function unitTotal(body: Record<string, unknown>, lineId: string, disposition: ReceiptDisposition): number {
  const units = (body.units ?? []) as Array<{ returnLineId: string; disposition: string; quantity: number }>;
  return units
    .filter((unit) => unit.returnLineId === lineId && unit.disposition === disposition)
    .reduce((sum, unit) => sum + unit.quantity, 0);
}

// ---- 画面の操作と読み方（画面の作りへの頼り方はここにまとめる） ----

export const returnsDialogName = (orderId: string) => `返品（${orderNumberOf(orderId)}）`;
export const createDialogName = (orderId: string) => `返品を作る（${orderNumberOf(orderId)}）`;

/** 一覧のその注文の行の「返品」系のボタンを押して、返品の画面を開く。ボタンの名前は次にすること（返品・受け取る・額を決めて返金する・申し込みを確かめる） */
export async function openReturnsDialog(page: Page, orderId: string, buttonName = '返品'): Promise<Locator> {
  await page.getByRole('row', { name: new RegExp(orderId) }).getByRole('button', { name: buttonName, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: returnsDialogName(orderId), exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('読み込み中です...')).toHaveCount(0);
  return dialog;
}

/** 返品の画面の、その返品の欄（名前は返品の番号 ORD-XXXXXXXX-R1） */
export function returnCard(dialog: Locator, label: string): Locator {
  return dialog.getByRole('group', { name: label, exact: true });
}

/** 返品の画面の「返品を作る」を押して、返品を作る画面を開く（材料を読み終えるまで待つ） */
export async function openCreateDialog(page: Page, orderId: string): Promise<Locator> {
  const returns = page.getByRole('dialog', { name: returnsDialogName(orderId), exact: true });
  await returns.getByRole('button', { name: '返品を作る', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: createDialogName(orderId), exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('読み込み中です...')).toHaveCount(0);
  return dialog;
}

/** 返品を作る画面の、品の欄（名前は 品名（色 / サイズ）。交換の品の行は末尾に（交換の品）） */
export function createLineGroup(dialog: Locator, label: string): Locator {
  return dialog.getByRole('group', { name: label, exact: true });
}

/** 返品の画面の、その返品の欄のボタンを押して、操作の画面（受け取り・額を決めて返金・検品など）を開く */
export async function openOperationDialog(
  page: Page,
  orderId: string,
  label: string,
  buttonName: string,
  dialogTitle: string,
): Promise<Locator> {
  const returns = page.getByRole('dialog', { name: returnsDialogName(orderId), exact: true });
  await returnCard(returns, label).getByRole('button', { name: buttonName, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: dialogTitle, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

export const openReceiveDialog = (page: Page, orderId: string, label: string) =>
  openOperationDialog(page, orderId, label, '受け取る', RETURN_TEXT.receiveTitle(label));

export const openReturnRefundDialog = (page: Page, orderId: string, label: string) =>
  openOperationDialog(page, orderId, label, '額を決めて返金する', RETURN_TEXT.refundTitle(label));

/**
 * 受け取りの画面の、まだ処理していない i 番目（0 始まり）の点に、「届いた」のチェックを入れて、状態を選ぶ。
 * 同じ品の固定の行と未処理の行は group の名前が重なるため、選び（品の状態）がある listitem の順で数える。
 */
export async function setUnitState(dialog: Locator, index: number, state: UnitState): Promise<void> {
  const row = unitRows(dialog).filter({ has: dialog.page().getByRole('combobox', { name: '品の状態', exact: true }) }).nth(index);
  const select = row.getByRole('combobox', { name: '品の状態', exact: true });
  await row.getByRole('checkbox', { name: '届いた', exact: true }).check();
  await select.selectOption({ label: state });
}

/** 受け取りの画面の、点の行（前の受け取りで処理した固定の行も含む） */
export function unitRows(dialog: Locator): Locator {
  return dialog.getByRole('list', { name: '受け取る品' }).getByRole('listitem');
}

/** 受け取りの画面の返金の選び（計算どおり・相談） */
export async function chooseRefundChoice(dialog: Locator, choice: 'now' | 'consult'): Promise<void> {
  const radio = dialog.getByRole('radio', { name: choice === 'now' ? RETURN_TEXT.nowOption : RETURN_TEXT.consultOption });
  await radio.check();
}

/** 受け取りの画面の確定のボタン（名前は中身で変わる） */
export function confirmButton(dialog: Locator, name: string): Locator {
  return dialog.getByRole('button', { name, exact: true });
}

/** 操作の画面の内訳（group 返金の内訳。商品・返送料・返品の手数料・返金額など）を、項目名 → 金額の文字で読む。項目名は dt、金額は次の dd（E-2 の返金の画面と同じ作り） */
export async function readReturnBreakdown(dialog: Locator): Promise<Record<string, string>> {
  return dialog.getByRole('group', { name: '返金の内訳', exact: true }).evaluate((node) => {
    const rows: Record<string, string> = {};
    node.querySelectorAll('dt').forEach((term) => {
      rows[(term.textContent ?? '').trim()] = (term.nextElementSibling?.textContent ?? '').trim();
    });
    return rows;
  });
}

export { formatYen };
