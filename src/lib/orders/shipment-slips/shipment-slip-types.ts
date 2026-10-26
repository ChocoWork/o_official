// File: src/lib/orders/shipment-slips/shipment-slip-types.ts
// 発送票（G-3 / FREQ-531〜535）の段階・阻害理由・値の範囲・エラー表・固定の文・読取の行の型と検査。
// 窓口・store・画面・E2E の橋が同じ定義を使う（サーバー専用の物は入れない）。
import { SHIPPING_CARRIER_IDS, type ShippingCarrierId } from '@/lib/orders/shipping-carriers';
import {
  DELIVERY_STATUSES,
  TRACKING_STATES,
  type DeliveryStatus,
  type TrackingState,
} from '@/lib/orders/tracking/delivery-types';

/** 発送票の保存する段階。画面の状態の文字は SHIPMENT_SLIP_STAGE_LABELS。 */
export const SHIPMENT_SLIP_STAGES = ['draft', 'confirmed', 'cancelled', 'discarded'] as const;
export type ShipmentSlipStage = (typeof SHIPMENT_SLIP_STAGES)[number];

export const SHIPMENT_SLIP_STAGE_LABELS: Record<ShipmentSlipStage, string> = {
  draft: '下書き',
  confirmed: '発送済み',
  cancelled: '取消済み',
  discarded: '破棄済み',
};

export function isShipmentSlipStage(value: unknown): value is ShipmentSlipStage {
  return typeof value === 'string' && (SHIPMENT_SLIP_STAGES as readonly string[]).includes(value);
}

/** 荷作り表で行を選べない理由（DB の阻害理由コード）。並びは DB が返す順 */
export const PACKING_HOLD_REASONS = [
  'payment_review',
  'exchange_fee_waiting',
  'variant_missing',
  'address_incomplete',
  'paid_at_missing',
] as const;
export type PackingHoldReason = (typeof PACKING_HOLD_REASONS)[number];

/** 阻害理由ごとに荷作り表・票へ出す文 */
export const PACKING_HOLD_LABELS: Record<PackingHoldReason, string> = {
  payment_review: '支払額の確認が済むまで選べません',
  exchange_fee_waiting: '交換手数料のお支払いを待っているため選べません',
  variant_missing: '色・サイズが確定していないため選べません',
  address_incomplete: '配送先の情報が足りないため選べません',
  paid_at_missing: '入金日時が記録されていないため選べません',
};

/** 値の範囲の唯一の定義（計画の「共通の値」）。DB の CHECK・関数の検証・窓口の検証・画面が同じ数を使う。 */
export const SHIPMENT_SLIP_LIMITS = {
  /** 票の行数 */
  lines: { min: 1, max: 100 },
  /** 1行の送る数 */
  quantity: { min: 1, max: 99999 },
  /** 下書きの有効期限（最後の保存からの日数） */
  draftExpiryDays: 7,
  /** 荷作り表の頁。page の上限は offset（(page − 1) × limit）が整数に収まるための物 */
  packingPage: { limit: { min: 1, max: 100, fallback: 50 }, page: { min: 1, max: 100000, fallback: 1 } },
  /** 票の一覧の頁 */
  slipPage: { limit: { min: 1, max: 100, fallback: 20 }, page: { min: 1, max: 100000, fallback: 1 } },
} as const;

export type ShipmentSlipQueryRange = { min: number; max: number; fallback: number };

/** 指定が無ければ既定値。あれば桁数を絞った10進の整数で範囲内の時だけ数にする（空・小数・符号・空白・指数は範囲外 = null） */
export function readShipmentSlipQueryInteger(value: string | null, range: ShipmentSlipQueryRange): number | null {
  if (value === null) return range.fallback;
  if (!/^[0-9]{1,7}$/.test(value)) return null;
  const number = Number(value);
  return number >= range.min && number <= range.max ? number : null;
}

/**
 * DB が返す誤りの表。キーは message、値は [SQLSTATE, HTTP の状態, 利用者に見せる本文]。
 * store は message と SQLSTATE が両方そろった時だけこの表で分類し、表に無い物は生の文を出さない500にする。
 * 本文に注文番号・氏名・住所を載せない（どの注文が原因かは票の詳細の issues／cancelBlockers が注文IDで示す）。
 */
export const SHIPMENT_SLIP_ERRORS: Record<string, readonly [sqlstate: string, status: number, body: string]> = {
  GROUP_G_ARGUMENT_INVALID: ['22023', 400, '入力を確かめてください。'],
  GROUP_G_FORBIDDEN: ['42501', 403, '発送を扱う権限がありません。'],
  GROUP_G_REQUEST_KEY_CONFLICT: ['23505', 409, '同じ要求番号で異なる操作は実行できません。'],
  GROUP_G_SLIP_NOT_FOUND: ['P0002', 404, '発送票が見つかりません。'],
  GROUP_G_SLIP_VERSION_CONFLICT: ['55000', 409, '発送票が更新されました。内容を確認して、もう一度送ってください。'],
  GROUP_G_SLIP_NOT_DRAFT: ['55000', 409, 'この発送票は下書きではありません。'],
  GROUP_G_SLIP_NOT_CONFIRMED: ['55000', 409, '発送が確定した発送票だけで行える操作です。'],
  GROUP_G_SLIP_CANCELLED: ['55000', 409, 'この発送票は取り消されています。'],
  GROUP_G_SLIP_DRAFT_EXPIRED: ['55000', 409, '下書きの期限が切れました。品物を選び直してください。'],
  GROUP_G_SLIP_EMPTY: ['22023', 400, '品物を選んでください。'],
  GROUP_G_SLIP_CUSTOMER_MISMATCH: ['22023', 409, '同じお客様の注文だけを同梱できます。会員は同じ会員、ゲストは同じメールアドレスの注文に限ります。'],
  GROUP_G_SLIP_ADDRESS_MISMATCH: ['22023', 409, '配送先がすべて同じ注文だけを同梱できます。'],
  GROUP_G_SLIP_ADDRESS_INCOMPLETE: ['22023', 409, '配送先の情報が足りない注文は発送できません。'],
  GROUP_G_SLIP_ORDER_NOT_SHIPPABLE: ['22023', 409, '入金が確認できていない注文は発送できません。'],
  GROUP_G_SLIP_PAYMENT_REVIEW_REQUIRED: ['22023', 409, '支払額の確認が済むまで発送できません。'],
  GROUP_G_SLIP_EXCHANGE_ON_HOLD: ['22023', 409, '交換手数料のお支払いを待っているため発送できません。'],
  GROUP_G_SLIP_QUANTITY_EXCEEDS_READY: ['22023', 409, '発送準備中の数を超えています。荷作り表を読み直してください。'],
  GROUP_G_SLIP_TRACKING_INCOMPLETE: ['22023', 400, '運送会社と伝票番号は、両方入れるか両方空にしてください。'],
  GROUP_G_SLIP_TRACKING_UNCHANGED: ['22023', 409, '運送会社も伝票番号も変わっていません。'],
  GROUP_G_SHIPMENT_DATE_INVALID: ['22023', 400, '出荷日は、入金日から今日までの日付にしてください。'],
  GROUP_G_SHIPMENT_DATE_AFTER_DELIVERY: ['22023', 409, '配達済みの日より後の日にはできません。配送の記録を確かめてください。'],
  GROUP_G_SHIPMENT_DATE_UNCHANGED: ['22023', 409, '出荷日が変わっていません。'],
  GROUP_G_SLIP_REASON_REQUIRED: ['22023', 400, '理由を入力してください。'],
  GROUP_G_SLIP_ALREADY_DELIVERED: ['55000', 409, 'この発送票はすでに配達済みです。'],
  GROUP_G_SLIP_DELIVERY_DATE_INVALID: ['22023', 400, '届いた日は、発送した日から今日までの日付にしてください。'],
  GROUP_G_SLIP_HAS_RETURN: ['22023', 409, '返品の対象になっている注文があるため、発送を取り消せません。'],
  GROUP_G_SLIP_REFUNDED: ['22023', 409, '発送後に返金した注文があるため、発送を取り消せません。'],
  GROUP_G_SLIP_CANCEL_NOT_ALLOWED: ['22023', 409, '取り消せない状態の注文があるため、発送を取り消せません。'],
};

/** 表に載せない内部の誤り（GROUP_G_SHIPMENT_CONSUMPTION など）と、分類できない失敗に出す固定の文 */
export const SHIPMENT_SLIP_FAILED = '発送の記録に失敗しました';

/** 読取の応答の形が崩れた時の内部の失敗の印。store が固定の500にし、中身は画面にもログにも出さない。 */
export const SHIPMENT_SLIP_READ_FAILED = 'SHIPMENT_SLIP_READ_FAILED';

/** 利用者に見せる誤り code か（DB の表にあるもの）。継承した名前は含まない */
export function isShipmentSlipErrorCode(code: string): boolean {
  return Object.hasOwn(SHIPMENT_SLIP_ERRORS, code);
}

/** 荷作り表の9列の見出し（左から）。交換の品の印は商品名の横に出す */
export const PACKING_COLUMN_HEADINGS = [
  '注文ID', '注文日', '顧客名', 'メールアドレス', '商品名', '色', 'サイズ', '数量', '単価',
] as const;

/** 画面の言葉の部品（計画の「発送票の画面とメールの言葉」）。窓口は failed、画面は他も使う。 */
export const SHIPMENT_SLIP_TEXT = {
  correctDate: '出荷日を訂正する',
  dateDescription: 'お客様の返品期限は変わりません。',
  newShipmentDate: '新しい出荷日',
  dateReason: '理由',
  correctDateSubmit: '訂正する',
  dateCorrected: '出荷日を訂正しました。',
  dateOwnerOnly: '出荷日の訂正は店長だけができます。',
  dateForbidden: '出荷日を訂正する権限がありません。',
  failed: SHIPMENT_SLIP_FAILED,
  packingHeading: '荷作り表',
  packingDescription: '発送準備中の品物だけを表示します。品物を選んで「発送」を押すと、発送票の下書きを作ります。',
  packingEmpty: '発送準備中の品物はありません。',
  packingForbidden: '荷作り表を見る権限がありません。',
  packingFailed: '荷作り表を読み込めませんでした。',
  exchangeMark: '交換の品',
  previousPage: '前の頁',
  nextPage: '次の頁',
  draftsHeading: '発送票の下書き',
  confirmedHeading: '確定済みの発送票',
  slipListFailed: '発送票の一覧を読み込めませんでした。',
  slipListForbidden: '発送票を見る権限がありません。',
  slipListEmpty: '該当する発送票はありません。',
  open: '開く',
  expired: '期限切れ',
  noTracking: '伝票番号なし',
  /** 旧い注文一覧の表の上にあった案内（G-4 で一覧は撤去した。使う画面はもう無い。E2E〔orderSectionGuide・openPacking を参照する試験〕の付け替え〔Task 11・12〕までは定義を残す） */
  orderSectionGuide: '発送は荷作り表から行います。',
  openPacking: '荷作り表を開く',
  /** 注文の詳細の変更履歴（OrderHistoryPanel）の上の案内 */
  orderHistoryGuide: '発送・発送取消・伝票番号の訂正・手動の配達済みは、発送票から行います。',
  // ---- 下書き（G-3 Task 4） ----
  /** 荷作り表の選択欄の見出し（視覚的に隠す） */
  selectHeading: '選択',
  /** 1行目を選んだ後、同梱できない行の下に出す */
  bundleHint: '同じお客様・同じ配送先の注文だけ同梱できます',
  /** 荷作り表の各行の「今回送る数」の見出し */
  sendQuantity: '今回送る数',
  ship: '発送',
  draftSaved: '下書きを保存しました。',
  /** 荷作り表から作る操作の権限だけが無い人に1回出す */
  createForbidden: '発送票を作る権限がありません。',
  /** 書込みの窓口が 403 で返す文（DB のエラー表と同じ）。荷作り表は、これが返ったら操作の欄を片付ける */
  forbidden: SHIPMENT_SLIP_ERRORS.GROUP_G_FORBIDDEN[2],
  /** CSRF の確かめで断られた 403 は権限の不足ではない。再読み込みを促す */
  csrfFailed: 'セキュリティ確認に失敗しました。ページを再読み込みして、もう一度送ってください。',
  /** 最後の1行を外そうとした時（DB の GROUP_G_SLIP_EMPTY と同じ文）。窓口へは送らない */
  emptyLines: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_EMPTY[2],
  // ---- 発送の取消（G-3 Task 6） ----
  cancelShipment: '発送を取り消す',
  cancelDescription: '票に含まれるすべての注文の発送を取り消し、品物を発送準備中に戻します。',
  cancelSubmit: '取り消す',
  cancelled: '発送を取り消しました。',
  // ---- 伝票番号の後入力・訂正と手動の配達済み（G-3 Task 7） ----
  /** 番号がある票のボタン・見出し。番号が無い票は trackingEnter */
  trackingEdit: '伝票番号を直す',
  trackingEnter: '伝票番号を入れる',
  /** ダイアログのボタン（番号がある票は「直す」、無い票は「入れる」） */
  trackingSubmitEdit: '直す',
  trackingSubmitEnter: '入れる',
  trackingDescription: '票に含まれるすべての注文に反映します。',
  trackingNotify: 'お客様に更新のメールを送る',
  trackingUpdated: '伝票番号を更新しました。',
  carrierLabel: '運送会社',
  /** 運送会社がまだ無い票の伝票番号のダイアログで、選択の先頭に置く（選ぶまで送れない） */
  carrierPlaceholder: '選んでください',
  trackingNumberLabel: '伝票番号',
  markDelivered: '配達済みにする',
  deliveredDescription: '票に含まれるすべての注文を配達済みにします。',
  deliveredOnLabel: '届いた日',
  deliveredNotify: 'お客様に配達済みのメールを送る',
  delivered: '配達済みにしました。',
  slipBack: '荷作り表に戻る',
  slipFailed: '発送票を読み込めませんでした。',
  slipForbidden: '発送票を見る権限がありません。',
  slipNotFound: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_NOT_FOUND[2],
  linesHeading: '同梱する品物',
  removeLine: 'この行を外す',
  addHeading: '品物を追加',
  addButton: '追加',
  addEmpty: '追加できる品物はありません。',
  shipToHeading: '送り先',
  discardDraft: '下書きを破棄',
  discardConfirm: 'この下書きを破棄しますか。',
  discardSubmit: '破棄する',
  back: '戻る',
  loading: '読み込み中...',
} as const;

/** 票の id（窓口の URL のパスに入れる値）の形か。uuid でなければ URL に入れない */
export function isShipmentSlipId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** 票の頁の「同梱する品物」の表の見出し（左から。操作の列は視覚的に隠す見出しを足す） */
export const SLIP_LINE_COLUMN_HEADINGS = [
  '注文ID', '顧客名', '商品名', '色', 'サイズ', '送る数', '今の準備中の数',
] as const;

/** 票の頁の見出し。例: 発送票 SL-20261025-0001 */
export function formatSlipHeading(number: string): string {
  return `発送票 ${number}`;
}

/**
 * 下書きの問題（issues）を行や票の上に出す文。DB のエラー表の本文と、阻害理由の文（PACKING_HOLD_LABELS）に合わせる。
 * 色・サイズ未確定と入金日時なしは、エラー表に独自の文が無いので荷作り表と同じ阻害理由の文を使う。
 */
export const SHIPMENT_SLIP_ISSUE_TEXT: Record<ShipmentSlipIssueCode, string> = {
  expired: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_DRAFT_EXPIRED[2],
  customer_mismatch: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_CUSTOMER_MISMATCH[2],
  address_mismatch: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_ADDRESS_MISMATCH[2],
  order_not_shippable: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_ORDER_NOT_SHIPPABLE[2],
  payment_review: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_PAYMENT_REVIEW_REQUIRED[2],
  exchange_fee_waiting: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_EXCHANGE_ON_HOLD[2],
  variant_missing: PACKING_HOLD_LABELS.variant_missing,
  address_incomplete: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_ADDRESS_INCOMPLETE[2],
  paid_at_missing: PACKING_HOLD_LABELS.paid_at_missing,
  quantity_exceeds_ready: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_QUANTITY_EXCEEDS_READY[2],
};

/** 別の下書きにも選ばれている行の通知。番号は票の番号（複数なら読点で並べる） */
export function formatOtherSlipNotice(numbers: readonly string[]): string {
  return `別の発送票（${numbers.join('、')}）にも選ばれています`;
}

/** 発送票へのリンクの文字（注文の履歴の発送の行） */
export function formatOpenSlipLabel(number: string): string {
  return `発送票 ${number} を開く`;
}

// ---- 読取の行（DB の関数の戻りを camelCase にした物） ----

/** 荷作り表の1行（DB の関数 list_admin_packing の戻り）。選べない行は blockedReasons があり、shippableQuantity が 0。 */
export type PackingRow = {
  orderId: string;
  orderItemId: string;
  orderCreatedAt: string;
  customerName: string | null;
  customerEmail: string | null;
  itemName: string;
  color: string | null;
  size: string | null;
  readyQuantity: number;
  shippableQuantity: number;
  unitPrice: number;
  isExchange: boolean;
  blockedReasons: PackingHoldReason[];
  /** この行を選んでいる別の有効な下書きの番号 */
  otherSlipNumbers: string[];
  /** slipId を指定した時の、その下書きが選んでいる数。それ以外は null */
  selectedQuantity: number | null;
  bundleOk: boolean;
  /** 同じお客様・同じ配送先を表す印。配送先が足りない注文は null */
  bundleKey: string | null;
};

/** 票の一覧の1行（DB の関数 list_admin_shipment_slips の戻り） */
export type ShipmentSlipListRow = {
  id: string;
  number: string;
  stage: ShipmentSlipStage;
  version: number;
  expired: boolean;
  shipmentDate: string | null;
  shippingCarrier: ShippingCarrierId | null;
  trackingNumber: string | null;
  orderCount: number;
  itemQuantity: number;
  updatedAt: string;
};

export type ShipmentSlipShipTo = {
  fullName: string;
  postalCode: string;
  prefecture: string;
  city: string;
  address: string;
  building: string | null;
  phone: string;
};

export type ShipmentSlipDetailLine = {
  orderId: string;
  orderItemId: string;
  itemName: string;
  color: string | null;
  size: string | null;
  quantity: number;
  /** 今の準備中の数（発送できる数）。確定済みの票では 0 になりうる */
  readyQuantity: number;
  unitPrice: number;
  isExchange: boolean;
};

/** 下書きの問題の種類。票全体の物は orderItemId が null */
export const SHIPMENT_SLIP_ISSUE_CODES = [
  'expired',
  'customer_mismatch',
  'address_mismatch',
  'order_not_shippable',
  'payment_review',
  'exchange_fee_waiting',
  'variant_missing',
  'address_incomplete',
  'paid_at_missing',
  'quantity_exceeds_ready',
] as const;
export type ShipmentSlipIssueCode = (typeof SHIPMENT_SLIP_ISSUE_CODES)[number];
export type ShipmentSlipIssue = { code: ShipmentSlipIssueCode; orderItemId: string | null };

/** 発送の取消を止める理由 */
export const SHIPMENT_SLIP_CANCEL_BLOCKER_REASONS = ['has_return', 'refunded', 'not_cancellable'] as const;
export type ShipmentSlipCancelBlockerReason = (typeof SHIPMENT_SLIP_CANCEL_BLOCKER_REASONS)[number];
export type ShipmentSlipCancelBlocker = { orderId: string; reason: ShipmentSlipCancelBlockerReason };

/** 取消を止める理由ごとの文。取消のダイアログの上に、注文番号つきで先に出す（formatCancelBlocker） */
export const SHIPMENT_SLIP_CANCEL_BLOCKER_TEXT: Record<ShipmentSlipCancelBlockerReason, string> = {
  has_return: '返品の対象です',
  refunded: '発送後に返金済みです',
  not_cancellable: '取り消せない状態です',
};

/** 例: 注文 ORD-XXXX は返品の対象です */
export function formatCancelBlocker(orderNumber: string, reason: ShipmentSlipCancelBlockerReason): string {
  return `注文 ${orderNumber} は${SHIPMENT_SLIP_CANCEL_BLOCKER_TEXT[reason]}`;
}

export type ShipmentSlipOrderFulfillment = {
  orderId: string;
  fulfillmentId: string;
  fulfillmentNumber: number;
  deliveryStatus: DeliveryStatus | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
};

export const SHIPMENT_SLIP_VERSION_KINDS = ['confirm', 'tracking_update', 'delivered', 'date_correction', 'cancel'] as const;
export type ShipmentSlipVersionKind = (typeof SHIPMENT_SLIP_VERSION_KINDS)[number];

export type ShipmentSlipVersionEntry = {
  version: number;
  kind: ShipmentSlipVersionKind;
  carrier: ShippingCarrierId | null;
  trackingNumber: string | null;
  trackingVersion: number;
  shipmentDate: string;
  reason: string | null;
  actorEmail: string | null;
  createdAt: string;
};

export const SHIPMENT_DATE_HISTORY_KINDS = ['initial', 'correction'] as const;
export type ShipmentDateHistoryKind = (typeof SHIPMENT_DATE_HISTORY_KINDS)[number];

export type ShipmentDateHistoryEntry = {
  version: number;
  kind: ShipmentDateHistoryKind;
  previousDate: string;
  newDate: string;
  reason: string | null;
  actorEmail: string | null;
  createdAt: string;
};

/** 追跡の登録の要約。追跡がオフなら enabled が false で、他は null */
export type ShipmentSlipRegistration = {
  enabled: boolean;
  state: TrackingState | null;
  everRegistered: boolean | null;
  leaderOrderId: string | null;
};

/** 発送票1件の詳細（DB の関数 get_admin_shipment_slip の戻り）。全注文を見せるのは管理画面だけ。 */
export type ShipmentSlipDetail = {
  id: string;
  number: string;
  stage: ShipmentSlipStage;
  version: number;
  expired: boolean;
  customerKind: 'member' | 'guest';
  shipTo: ShipmentSlipShipTo;
  carrier: ShippingCarrierId | null;
  trackingNumber: string | null;
  notifyCustomer: boolean | null;
  shipmentDate: string | null;
  trackingVersion: number;
  confirmedAt: string | null;
  cancelledAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
  lines: ShipmentSlipDetailLine[];
  issues: ShipmentSlipIssue[];
  cancelBlockers: ShipmentSlipCancelBlocker[];
  orders: ShipmentSlipOrderFulfillment[];
  versions: ShipmentSlipVersionEntry[];
  dateHistory: ShipmentDateHistoryEntry[];
  registration: ShipmentSlipRegistration;
};

/** 注文の履歴の発送の行に付ける、その発送が属する票。票に属さない発送は null */
export type ShipmentSlipLink = { slipId: string; number: string; stage: ShipmentSlipStage };

// ---- 書込み（下書きの保存・破棄。G-3 Task 4） ----

/** 下書きに選ぶ1行。送る数は 1〜99999（SHIPMENT_SLIP_LIMITS.quantity）で、準備中の数以下 */
export type ShipmentSlipDraftLine = { orderItemId: string; quantity: number };

/** 下書きの保存・破棄の成功の戻り。replayed は同じ要求番号・同じ内容の再送で true */
export type ShipmentSlipSaved = { id: string; number: string; version: number; replayed: boolean };

// ---- 検査の道具。崩れを見つけたらその場で SHIPMENT_SLIP_READ_FAILED を投げる（中身は持たない）。 ----

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUMBER_PATTERN = /^SL-[0-9]{8}-[0-9]{4}$/;
const DAY_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function fail(): never {
  throw new Error(SHIPMENT_SLIP_READ_FAILED);
}

function readObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : fail();
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value : fail();
}

function readNullableText(value: unknown): string | null {
  return value === null ? null : readText(value);
}

function readBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : fail();
}

function readNullableBoolean(value: unknown): boolean | null {
  return value === null ? null : readBoolean(value);
}

function readInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fail();
}

/** 0 以上の整数 */
function readCount(value: unknown): number {
  const count = readInteger(value);
  return count >= 0 ? count : fail();
}

/** 1 以上の整数 */
function readPositive(value: unknown): number {
  const count = readInteger(value);
  return count >= 1 ? count : fail();
}

function readMatch(value: unknown, pattern: RegExp): string {
  const text = readText(value);
  return pattern.test(text) ? text : fail();
}

const readId = (value: unknown): string => readMatch(value, UUID_PATTERN);
const readNullableId = (value: unknown): string | null => (value === null ? null : readId(value));
const readNumber = (value: unknown): string => readMatch(value, NUMBER_PATTERN);
const readDay = (value: unknown): string => readMatch(value, DAY_PATTERN);
const readNullableDay = (value: unknown): string | null => (value === null ? null : readDay(value));

/** 日時（ISO 8601 の文字列）。読めない日時は崩れとして扱う */
function readTimestamp(value: unknown): string {
  const text = readText(value);
  return Number.isNaN(Date.parse(text)) ? fail() : text;
}

const readNullableTimestamp = (value: unknown): string | null => (value === null ? null : readTimestamp(value));

function readOneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fail();
}

function readNullableOneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return value === null ? null : readOneOf(value, allowed);
}

function readList<T>(value: unknown, readItem: (item: unknown) => T): T[] {
  return Array.isArray(value) ? value.map(readItem) : fail();
}

/** 運送会社と伝票番号は、両方あるか両方無いか */
function checkTracking(carrier: unknown, trackingNumber: unknown): void {
  if ((carrier === null) !== (trackingNumber === null)) fail();
}

/** 荷作り表の1行を検査する（DB の戻りを camelCase にした物、または窓口の応答の1行）。決まった項目だけを返す。 */
export function parsePackingRow(value: unknown): PackingRow {
  const raw = readObject(value);
  const row: PackingRow = {
    orderId: readId(raw.orderId),
    orderItemId: readId(raw.orderItemId),
    orderCreatedAt: readTimestamp(raw.orderCreatedAt),
    customerName: readNullableText(raw.customerName),
    customerEmail: readNullableText(raw.customerEmail),
    itemName: readText(raw.itemName),
    color: readNullableText(raw.color),
    size: readNullableText(raw.size),
    readyQuantity: readPositive(raw.readyQuantity),
    shippableQuantity: readCount(raw.shippableQuantity),
    unitPrice: readCount(raw.unitPrice),
    isExchange: readBoolean(raw.isExchange),
    blockedReasons: readList(raw.blockedReasons, (reason) => readOneOf(reason, PACKING_HOLD_REASONS)),
    otherSlipNumbers: readList(raw.otherSlipNumbers, readNumber),
    selectedQuantity: raw.selectedQuantity === null ? null : readCount(raw.selectedQuantity),
    bundleOk: readBoolean(raw.bundleOk),
    bundleKey: readNullableText(raw.bundleKey),
  };
  // 選べる行（理由なし）は準備中の数ぜんぶ、選べない行は 0。違えば読み違い
  if (new Set(row.blockedReasons).size !== row.blockedReasons.length) fail();
  if (row.shippableQuantity !== (row.blockedReasons.length === 0 ? row.readyQuantity : 0)) fail();
  return row;
}

/** 票の一覧の1行を検査する（DB の戻りを camelCase にした物、または窓口の応答の1行）。決まった項目だけを返す。 */
export function parseShipmentSlipListRow(value: unknown): ShipmentSlipListRow {
  const raw = readObject(value);
  checkTracking(raw.shippingCarrier, raw.trackingNumber);
  return {
    id: readId(raw.id),
    number: readNumber(raw.number),
    stage: readOneOf(raw.stage, SHIPMENT_SLIP_STAGES),
    version: readPositive(raw.version),
    expired: readBoolean(raw.expired),
    shipmentDate: readNullableDay(raw.shipmentDate),
    shippingCarrier: readNullableOneOf(raw.shippingCarrier, SHIPPING_CARRIER_IDS),
    trackingNumber: readNullableText(raw.trackingNumber),
    orderCount: readCount(raw.orderCount),
    itemQuantity: readCount(raw.itemQuantity),
    updatedAt: readTimestamp(raw.updatedAt),
  };
}

/** 発送が属する票（DB の関数 list_admin_order_shipment_slips の1行を camelCase にした物）を検査する。決まった項目だけを返す。 */
export function parseShipmentSlipLink(value: unknown): ShipmentSlipLink & { fulfillmentId: string } {
  const raw = readObject(value);
  return {
    fulfillmentId: readId(raw.fulfillmentId),
    slipId: readId(raw.slipId),
    number: readNumber(raw.number),
    stage: readOneOf(raw.stage, SHIPMENT_SLIP_STAGES),
  };
}

/**
 * 下書きの保存・破棄の戻り（DB の関数の戻り、または窓口の応答）を検査して、決まった項目だけにする。
 * 崩れていれば Error('SHIPMENT_SLIP_READ_FAILED')。
 */
export function parseShipmentSlipSaved(value: unknown): ShipmentSlipSaved {
  const raw = readObject(value);
  return { id: readId(raw.id), number: readNumber(raw.number), version: readPositive(raw.version), replayed: readBoolean(raw.replayed) };
}

function readShipTo(value: unknown): ShipmentSlipShipTo {
  const raw = readObject(value);
  return {
    fullName: readText(raw.fullName),
    postalCode: readText(raw.postalCode),
    prefecture: readText(raw.prefecture),
    city: readText(raw.city),
    address: readText(raw.address),
    building: readNullableText(raw.building),
    phone: readText(raw.phone),
  };
}

function readDetailLine(value: unknown): ShipmentSlipDetailLine {
  const raw = readObject(value);
  return {
    orderId: readId(raw.orderId),
    orderItemId: readId(raw.orderItemId),
    itemName: readText(raw.itemName),
    color: readNullableText(raw.color),
    size: readNullableText(raw.size),
    quantity: readPositive(raw.quantity),
    readyQuantity: readCount(raw.readyQuantity),
    unitPrice: readCount(raw.unitPrice),
    isExchange: readBoolean(raw.isExchange),
  };
}

function readIssue(value: unknown): ShipmentSlipIssue {
  const raw = readObject(value);
  return { code: readOneOf(raw.code, SHIPMENT_SLIP_ISSUE_CODES), orderItemId: readNullableId(raw.orderItemId) };
}

function readCancelBlocker(value: unknown): ShipmentSlipCancelBlocker {
  const raw = readObject(value);
  return { orderId: readId(raw.orderId), reason: readOneOf(raw.reason, SHIPMENT_SLIP_CANCEL_BLOCKER_REASONS) };
}

function readOrderFulfillment(value: unknown): ShipmentSlipOrderFulfillment {
  const raw = readObject(value);
  return {
    orderId: readId(raw.orderId),
    fulfillmentId: readId(raw.fulfillmentId),
    fulfillmentNumber: readPositive(raw.fulfillmentNumber),
    deliveryStatus: readNullableOneOf(raw.deliveryStatus, DELIVERY_STATUSES),
    deliveredAt: readNullableTimestamp(raw.deliveredAt),
    cancelledAt: readNullableTimestamp(raw.cancelledAt),
  };
}

function readVersionEntry(value: unknown): ShipmentSlipVersionEntry {
  const raw = readObject(value);
  checkTracking(raw.carrier, raw.trackingNumber);
  return {
    version: readPositive(raw.version),
    kind: readOneOf(raw.kind, SHIPMENT_SLIP_VERSION_KINDS),
    carrier: readNullableOneOf(raw.carrier, SHIPPING_CARRIER_IDS),
    trackingNumber: readNullableText(raw.trackingNumber),
    trackingVersion: readPositive(raw.trackingVersion),
    shipmentDate: readDay(raw.shipmentDate),
    reason: readNullableText(raw.reason),
    actorEmail: readNullableText(raw.actorEmail),
    createdAt: readTimestamp(raw.createdAt),
  };
}

function readDateHistoryEntry(value: unknown): ShipmentDateHistoryEntry {
  const raw = readObject(value);
  return {
    version: readPositive(raw.version),
    kind: readOneOf(raw.kind, SHIPMENT_DATE_HISTORY_KINDS),
    previousDate: readDay(raw.previousDate),
    newDate: readDay(raw.newDate),
    reason: readNullableText(raw.reason),
    actorEmail: readNullableText(raw.actorEmail),
    createdAt: readTimestamp(raw.createdAt),
  };
}

function readRegistration(value: unknown): ShipmentSlipRegistration {
  const raw = readObject(value);
  const registration: ShipmentSlipRegistration = {
    enabled: readBoolean(raw.enabled),
    state: readNullableOneOf(raw.state, TRACKING_STATES),
    everRegistered: readNullableBoolean(raw.everRegistered),
    leaderOrderId: readNullableId(raw.leaderOrderId),
  };
  // 追跡がオフなら登録の項目は持たない
  if (!registration.enabled && (registration.state !== null || registration.everRegistered !== null || registration.leaderOrderId !== null)) fail();
  return registration;
}

/**
 * 発送票の詳細（get_admin_shipment_slip の戻り）を検査して、決まった項目だけの値にする。
 * 形・整数・段階の値が崩れていれば Error('SHIPMENT_SLIP_READ_FAILED')。知らない項目は落とす。
 */
export function parseShipmentSlipDetail(value: unknown): ShipmentSlipDetail {
  const raw = readObject(value);
  checkTracking(raw.carrier, raw.trackingNumber);
  const stage = readOneOf(raw.stage, SHIPMENT_SLIP_STAGES);
  const detail: ShipmentSlipDetail = {
    id: readId(raw.id),
    number: readNumber(raw.number),
    stage,
    version: readPositive(raw.version),
    expired: readBoolean(raw.expired),
    customerKind: readOneOf(raw.customerKind, ['member', 'guest'] as const),
    shipTo: readShipTo(raw.shipTo),
    carrier: readNullableOneOf(raw.carrier, SHIPPING_CARRIER_IDS),
    trackingNumber: readNullableText(raw.trackingNumber),
    notifyCustomer: readNullableBoolean(raw.notifyCustomer),
    shipmentDate: readNullableDay(raw.shipmentDate),
    trackingVersion: readPositive(raw.trackingVersion),
    confirmedAt: readNullableTimestamp(raw.confirmedAt),
    cancelledAt: readNullableTimestamp(raw.cancelledAt),
    expiresAt: readNullableTimestamp(raw.expiresAt),
    updatedAt: readTimestamp(raw.updatedAt),
    lines: readList(raw.lines, readDetailLine),
    issues: readList(raw.issues, readIssue),
    cancelBlockers: readList(raw.cancelBlockers, readCancelBlocker),
    orders: readList(raw.orders, readOrderFulfillment),
    versions: readList(raw.versions, readVersionEntry),
    dateHistory: readList(raw.dateHistory, readDateHistoryEntry),
    registration: readRegistration(raw.registration),
  };
  // 期限切れの印があるのは下書きだけ。期限は下書きだけが持つ
  if (detail.expired && stage !== 'draft') fail();
  if ((stage === 'draft') !== (detail.expiresAt !== null)) fail();
  return detail;
}

/** 発送確定の入力。日付はJSTの暦日。運送会社と番号は両方nullか両方あり。 */
export type ShipmentSlipConfirmInput = {
  expectedVersion: number; carrier: ShippingCarrierId | null; trackingNumber: string | null;
  shipmentDate: string; notifyCustomer: boolean; requestKey: string;
};
export type ShipmentSlipConfirmed = ShipmentSlipSaved & {
  shipmentDate: string;
  fulfillments: { orderId: string; fulfillmentId: string; number: number; completesOrder: boolean }[];
};

/** 発送の取消の戻り。restoredQuantity は戻した数量の合計。replayed は同じ要求番号・同じ内容の再送で true */
export type ShipmentSlipCancelled = { id: string; version: number; restoredQuantity: number; replayed: boolean };

/** 取消の戻り（DB の関数の戻り、または窓口の応答）を検査して、決まった項目だけにする。戻した数量は1以上。 */
export function parseShipmentSlipCancelled(value: unknown): ShipmentSlipCancelled {
  const raw = readObject(value);
  return { id: readId(raw.id), version: readPositive(raw.version), restoredQuantity: readPositive(raw.restoredQuantity), replayed: readBoolean(raw.replayed) };
}

/**
 * 伝票番号の後入力・訂正の入力（G-3 Task 7）。運送会社と伝票番号は両方必須（空に戻す訂正は無い）。
 * 伝票番号は trim 後 `^[0-9A-Za-z-]{1,64}$`。
 */
export type ShipmentSlipTrackingInput = {
  expectedVersion: number; carrier: ShippingCarrierId; trackingNumber: string; notifyCustomer: boolean; requestKey: string;
};
/** 伝票番号の後入力・訂正の戻り。trackingVersion は新しい追跡の版（2 以上） */
export type ShipmentSlipTrackingUpdated = { id: string; version: number; trackingVersion: number; replayed: boolean };

/** 伝票番号の後入力・訂正の戻り（DB の関数の戻り、または窓口の応答）を検査して、決まった項目だけにする。 */
export function parseShipmentSlipTrackingUpdated(value: unknown): ShipmentSlipTrackingUpdated {
  const raw = readObject(value);
  const trackingVersion = readPositive(raw.trackingVersion);
  if (trackingVersion < 2) fail();
  return { id: readId(raw.id), version: readPositive(raw.version), trackingVersion, replayed: readBoolean(raw.replayed) };
}

/** 手動の配達済みの入力（G-3 Task 7）。deliveredOn は日本時間の暦日（YYYY-MM-DD） */
export type ShipmentSlipDeliveredInput = { expectedVersion: number; deliveredOn: string; notifyCustomer: boolean; requestKey: string };
/** 手動の配達済みの戻り。deliveredAt は届いたとして記録した時刻（ISO 8601） */
export type ShipmentSlipDelivered = { id: string; version: number; deliveredAt: string; replayed: boolean };

/** 出荷日だけの訂正。返品期限・発送時刻・通知は変えない。 */
export type ShipmentSlipDateInput = { expectedVersion: number; shipmentDate: string; reason: string; requestKey: string };
export type ShipmentSlipDateCorrected = { id: string; version: number; shipmentDate: string; replayed: boolean };
/** 日付訂正の戻りの許可項目を検査し、余分な情報を落とす。 */
export function parseShipmentSlipDateCorrected(value: unknown): ShipmentSlipDateCorrected {
  const raw = readObject(value);
  const shipmentDate = readDay(raw.shipmentDate);
  const milliseconds = Date.parse(`${shipmentDate}T00:00:00Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== shipmentDate) fail();
  return { id: readId(raw.id), version: readPositive(raw.version), shipmentDate, replayed: readBoolean(raw.replayed) };
}

/** 手動の配達済みの戻り（DB の関数の戻り、または窓口の応答）を検査して、決まった項目だけにする。 */
export function parseShipmentSlipDelivered(value: unknown): ShipmentSlipDelivered {
  const raw = readObject(value);
  return { id: readId(raw.id), version: readPositive(raw.version), deliveredAt: readTimestamp(raw.deliveredAt), replayed: readBoolean(raw.replayed) };
}

/** 確定の戻りを検査する。空・重複・順序の崩れは成功として扱わない。 */
export function parseShipmentSlipConfirmed(value: unknown): ShipmentSlipConfirmed {
  const raw = readObject(value);
  const saved = parseShipmentSlipSaved(raw);
  const fulfillments = readList(raw.fulfillments, (value) => {
    const row = readObject(value);
    return { orderId: readId(row.orderId), fulfillmentId: readId(row.fulfillmentId), number: readPositive(row.number), completesOrder: readBoolean(row.completesOrder) };
  });
  if (fulfillments.length === 0 || new Set(fulfillments.map((row) => row.fulfillmentId)).size !== fulfillments.length
    || fulfillments.some((row, index) => index > 0 && fulfillments[index - 1].orderId >= row.orderId)) fail();
  return { ...saved, shipmentDate: readDay(raw.shipmentDate), fulfillments };
}
