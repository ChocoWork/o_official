// File: src/lib/purchase-orders/purchase-order-types.ts
// 発注書（G-2 / FREQ-526〜530）の値の範囲・段階・エラー表・固定の文。窓口・store・画面・E2E の橋が同じ定義を使う
// （サーバー専用の物は入れない）。
import { adminLoadFailureMessage } from '@/lib/admin/admin-load-failure';

/** 値の範囲の唯一の定義（計画の「共通の値」）。DB の CHECK・関数の検証・窓口の検証・画面の入力が同じ数を使う。 */
export const PURCHASE_ORDER_LIMITS = {
  /** 発注書の行数 */
  lines: { min: 1, max: 100 },
  /** 発注時の仮数量 */
  provisionalQuantity: { min: 1, max: 99999 },
  /** 数量確定後の確定数量（0 は「この行は発注しない」） */
  confirmedQuantity: { min: 0, max: 99999 },
  /** 受取数量（未納以下） */
  receivedQuantity: { min: 1, max: 99999 },
  /** 単価（整数円。未登録は NULL） */
  unitPriceYen: { min: 0, max: 9999999 },
  /** 発注先（前後の空白を落とした後の文字数） */
  supplierName: { min: 1, max: 100 },
  memo: { min: 0, max: 500 },
  reason: { min: 1, max: 200 },
  receiptMemo: { min: 0, max: 200 },
} as const;

/** DB に保存する段階。ordered は発注確定直後（数量は仮）。 */
export type PurchaseOrderStage = 'ordered' | 'quantity_confirmed';

/** 画面に出す段階。後ろの3つは保存せず、DB の関数が納品・未納・打切りの有無から導く。 */
export type PurchaseOrderDisplayStage = 'ordered' | 'quantity_confirmed' | 'partially_received' | 'received' | 'closed';

export const PURCHASE_ORDER_DISPLAY_STAGE_LABELS: Record<PurchaseOrderDisplayStage, string> = {
  ordered: '数量確定待ち',
  quantity_confirmed: '数量確定済み・受け取り待ち',
  partially_received: '一部受け取り済み',
  received: '受け取り完了',
  closed: '完了（残りを打ち切り）',
};

/**
 * DB が返す誤りの表。キーは message、値は [SQLSTATE, HTTP の状態, 利用者に見せる本文]。
 * store は message と SQLSTATE が両方そろった時だけこの表で分類し、表に無い物は生の文を出さない500にする。
 * 発注の作成が返し得る3つ。後続の Task が自分の窓口の誤りをここへ足す。
 */
export const PURCHASE_ORDER_ERRORS: Record<string, readonly [sqlstate: string, status: number, body: string]> = {
  GROUP_G_ARGUMENT_INVALID: ['22023', 400, '入力を確かめてください。'],
  GROUP_G_FORBIDDEN: ['42501', 403, '発注を扱う権限がありません。'],
  GROUP_G_REQUEST_KEY_CONFLICT: ['23505', 409, '同じ要求番号で異なる操作は実行できません。'],
};

export type PurchaseOrderCreateInput = {
  supplierName: string;
  memo: string | null;
  lines: { variantId: number; quantity: number }[];
  requestKey: string;
};

export type PurchaseOrderCreated = { id: string; number: string; version: number; replayed: boolean };

/** 発注の固定の文。窓口は failed、画面は forbidden・supplierRequired・failed・invalidInput を使う。 */
export const PURCHASE_ORDER_TEXT = {
  forbidden: PURCHASE_ORDER_ERRORS.GROUP_G_FORBIDDEN[2],
  invalidInput: PURCHASE_ORDER_ERRORS.GROUP_G_ARGUMENT_INVALID[2],
  supplierRequired: '発注先を入力してください。',
  failed: '発注の記録に失敗しました',
} as const;

/**
 * 発注確定に成功した画面が、発注書の頁へ移る時に付ける目印（`/admin/purchase-orders/<id>?created=1`）。
 * 通知は移動で消える元の画面には置かず、この目印を見た発注書の頁（Task 5）が `formatPurchaseOrderCreatedNotice` で出す。
 */
export const PURCHASE_ORDER_CREATED_QUERY = 'created=1';

/** 発注書を作った後の通知。目印 `PURCHASE_ORDER_CREATED_QUERY` がある時に発注書の頁が出す。 */
export function formatPurchaseOrderCreatedNotice(number: string): string {
  return `発注書 ${number} を作成しました。数量が確定するまで受け取りはできません。`;
}

/** 発注数量の入力が、発注書に入る値（1〜99999 の整数）か。数値の入力欄の文字をそのまま渡す。 */
export function isPurchaseOrderQuantity(value: string): boolean {
  return /^[1-9][0-9]{0,4}$/.test(value);
}

/**
 * 発注の作成が失敗した時に画面へ出す文。
 * 表にある code はその本文、MFA の無い 403 は専用の文、401・403・400 はそれぞれの文、他は固定の失敗の文。
 * 窓口の本文の error は使わない（英語の検証の文や生の文を画面へ流さないため）。
 */
export function purchaseOrderCreateFailureMessage(status: number, body: unknown): string {
  const { code } = (typeof body === 'object' && body !== null ? body : {}) as { code?: unknown };
  if (typeof code === 'string' && Object.hasOwn(PURCHASE_ORDER_ERRORS, code)) return PURCHASE_ORDER_ERRORS[code][2];
  return adminLoadFailureMessage(status, body, PURCHASE_ORDER_TEXT.forbidden,
    status === 400 ? PURCHASE_ORDER_TEXT.invalidInput : PURCHASE_ORDER_TEXT.failed);
}

// ---- 読取（発注一覧表と発注書の詳細 / G-2 Task 5・FREQ-526） ----

/** 発注一覧表の固定の文。窓口は apiFailed、画面は heading・empty・forbidden・failed・unconfirmed を使う。 */
export const PURCHASE_ORDER_LIST_TEXT = {
  heading: '発注一覧表',
  empty: '発注書はまだありません。',
  forbidden: '発注一覧を見る権限がありません。',
  failed: '発注一覧を読み込めませんでした。時間をおいて再度お試しください。',
  apiFailed: '発注一覧を読み込めませんでした。',
  /** 数量確定前の行の「発注数量」と「未納」 */
  unconfirmed: '数量未確定',
} as const;

/** 発注書の詳細の固定の文。窓口は notFound と apiFailed、画面は他も使う。 */
export const PURCHASE_ORDER_DETAIL_TEXT = {
  notFound: '発注書が見つかりません。',
  forbidden: '発注書を見る権限がありません。',
  failed: '発注書を読み込めませんでした。時間をおいて再度お試しください。',
  apiFailed: '発注書を読み込めませんでした。',
  priceMissing: '単価未登録',
  documentMissing: '証憑未添付',
  taxNote: '税の扱いは書類に従います',
} as const;

/** 読取の応答の形が崩れた時の内部の失敗の印。窓口は固定の500にし、中身は画面にもログにも出さない。 */
export const PURCHASE_ORDER_READ_FAILED = 'PURCHASE_ORDER_READ_FAILED';

const PURCHASE_ORDER_STAGES: readonly PurchaseOrderStage[] = ['ordered', 'quantity_confirmed'];
const PURCHASE_ORDER_DISPLAY_STAGES = Object.keys(PURCHASE_ORDER_DISPLAY_STAGE_LABELS) as readonly PurchaseOrderDisplayStage[];
const PURCHASE_ORDER_REVISION_KINDS = ['order', 'header', 'quantity', 'short_close'] as const;
const PURCHASE_ORDER_RECEIPT_KINDS = ['receive', 'reverse'] as const;
const PURCHASE_ORDER_ATTACHMENT_KINDS = ['quote', 'invoice'] as const;
const PURCHASE_ORDER_SHA256_SOURCES = ['browser', 'server'] as const;

export type PurchaseOrderRevisionKind = (typeof PURCHASE_ORDER_REVISION_KINDS)[number];
export type PurchaseOrderReceiptKind = (typeof PURCHASE_ORDER_RECEIPT_KINDS)[number];
export type PurchaseOrderAttachmentKind = (typeof PURCHASE_ORDER_ATTACHMENT_KINDS)[number];

/** 履歴・受け取り・書類の種類の表示の文 */
export const PURCHASE_ORDER_REVISION_KIND_LABELS: Record<PurchaseOrderRevisionKind, string> = {
  order: '発注',
  header: '発注先・メモの訂正',
  quantity: '数量の確定・訂正',
  short_close: '打切り',
};
export const PURCHASE_ORDER_RECEIPT_KIND_LABELS: Record<PurchaseOrderReceiptKind, string> = {
  receive: '受け取り',
  reverse: '受け取りの取消',
};
export const PURCHASE_ORDER_ATTACHMENT_KIND_LABELS: Record<PurchaseOrderAttachmentKind, string> = {
  quote: '見積書',
  invoice: '請求書',
};

/** 発注一覧表の1行（明細ごと）。数量確定前の行は orderQuantity と outstandingQuantity が null（画面は「数量未確定」）。 */
export type PurchaseOrderListRow = {
  purchaseOrderId: string;
  number: string;
  displayStage: PurchaseOrderDisplayStage;
  lineId: string;
  lineNo: number;
  itemName: string;
  colorName: string | null;
  sizeLabel: string | null;
  provisionalQuantity: number;
  orderQuantity: number | null;
  receivedQuantity: number;
  outstandingQuantity: number | null;
};

export type PurchaseOrderLine = {
  id: string;
  lineNo: number;
  variantId: number;
  itemName: string;
  colorName: string | null;
  sizeLabel: string | null;
  provisionalQuantity: number;
  orderQuantity: number | null;
  receivedQuantity: number;
  outstandingQuantity: number | null;
  unitPriceYen: number | null;
  version: number;
};

export type PurchaseOrderRevision = {
  id: string;
  lineId: string | null;
  revisionNo: number;
  kind: PurchaseOrderRevisionKind;
  beforeQuantity: number | null;
  afterQuantity: number | null;
  beforeUnitPriceYen: number | null;
  afterUnitPriceYen: number | null;
  beforeSupplierName: string | null;
  afterSupplierName: string | null;
  beforeMemo: string | null;
  afterMemo: string | null;
  reason: string | null;
  actorId: string;
  createdAt: string;
};

export type PurchaseOrderShortClosure = {
  id: string;
  lineId: string;
  closedQuantity: number;
  reason: string;
  actorId: string;
  createdAt: string;
};

/** quantity は相殺の行で負。reversibleQuantity は取り消せる残りの数（相殺の行は 0）。 */
export type PurchaseOrderReceiptLine = {
  id: string;
  lineId: string;
  quantity: number;
  reversesReceiptLineId: string | null;
  reversibleQuantity: number;
};

export type PurchaseOrderReceipt = {
  id: string;
  kind: PurchaseOrderReceiptKind;
  receivedOn: string;
  memo: string | null;
  reason: string | null;
  actorId: string;
  createdAt: string;
  lines: PurchaseOrderReceiptLine[];
};

export type PurchaseOrderAttachment = {
  id: string;
  kind: PurchaseOrderAttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  sha256Source: (typeof PURCHASE_ORDER_SHA256_SOURCES)[number];
  createdAt: string;
  current: {
    revisionNo: number;
    transactionDate: string;
    amountYen: number;
    currency: string;
    counterparty: string;
    voided: boolean;
    reason: string | null;
    replacesAttachmentId: string | null;
  };
  revisionCount: number;
};

/** 添付に結ばれていない予約（保存の途中で止まったファイル） */
export type PurchaseOrderPendingUpload = {
  reservationId: string;
  kind: PurchaseOrderAttachmentKind;
  fileName: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
};

/**
 * 発注書の詳細（DB の関数 get_admin_purchase_order の戻り）。保存先の鍵（storage_path）と内部の操作 ID は含まない。
 * stage は保存する段階、displayStage は納品・未納・打切りから導いた表示の段階。
 */
export type PurchaseOrderDetail = {
  id: string;
  number: string;
  supplierName: string;
  memo: string | null;
  stage: PurchaseOrderStage;
  displayStage: PurchaseOrderDisplayStage;
  version: number;
  orderedAt: string;
  createdBy: string;
  lines: PurchaseOrderLine[];
  revisions: PurchaseOrderRevision[];
  shortClosures: PurchaseOrderShortClosure[];
  receipts: PurchaseOrderReceipt[];
  attachments: PurchaseOrderAttachment[];
  pendingUploads: PurchaseOrderPendingUpload[];
  flags: { unitPriceMissing: boolean; documentMissing: boolean };
  estimatedAmountYen: number | null;
};

// 検査の道具。崩れを見つけたらその場で PURCHASE_ORDER_READ_FAILED を投げる（中身は持たない）。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUMBER_PATTERN = /^PO-[0-9]{8}-[0-9]{4}$/;
const DAY_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function fail(): never {
  throw new Error(PURCHASE_ORDER_READ_FAILED);
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

function readNullableCount(value: unknown): number | null {
  return value === null ? null : readCount(value);
}

function readMatch(value: unknown, pattern: RegExp): string {
  const text = readText(value);
  return pattern.test(text) ? text : fail();
}

const readId = (value: unknown): string => readMatch(value, UUID_PATTERN);
const readNullableId = (value: unknown): string | null => (value === null ? null : readId(value));
const readDay = (value: unknown): string => readMatch(value, DAY_PATTERN);

/** 日時（ISO 8601 の文字列）。読めない日時は崩れとして扱う */
function readTimestamp(value: unknown): string {
  const text = readText(value);
  return Number.isNaN(Date.parse(text)) ? fail() : text;
}

function readOneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fail();
}

function readList<T>(value: unknown, readItem: (item: unknown) => T): T[] {
  return Array.isArray(value) ? value.map(readItem) : fail();
}

/** 確定数量と未納は、どちらも無いか、どちらもあって 未納 = 確定数量 − 納品済み かのどちらか */
function checkQuantities(orderQuantity: number | null, receivedQuantity: number, outstandingQuantity: number | null): void {
  if ((orderQuantity === null) !== (outstandingQuantity === null)) fail();
  if (orderQuantity !== null && outstandingQuantity !== orderQuantity - receivedQuantity) fail();
}

/** 発注一覧表の1行を検査する（DB の戻りを camelCase にした物、または窓口の応答の1行）。決まった項目だけを返す。 */
export function parsePurchaseOrderListRow(value: unknown): PurchaseOrderListRow {
  const raw = readObject(value);
  const row: PurchaseOrderListRow = {
    purchaseOrderId: readId(raw.purchaseOrderId),
    number: readMatch(raw.number, NUMBER_PATTERN),
    displayStage: readOneOf(raw.displayStage, PURCHASE_ORDER_DISPLAY_STAGES),
    lineId: readId(raw.lineId),
    lineNo: readPositive(raw.lineNo),
    itemName: readText(raw.itemName),
    colorName: readNullableText(raw.colorName),
    sizeLabel: readNullableText(raw.sizeLabel),
    provisionalQuantity: readCount(raw.provisionalQuantity),
    orderQuantity: readNullableCount(raw.orderQuantity),
    receivedQuantity: readCount(raw.receivedQuantity),
    outstandingQuantity: readNullableCount(raw.outstandingQuantity),
  };
  checkQuantities(row.orderQuantity, row.receivedQuantity, row.outstandingQuantity);
  return row;
}

function readLine(value: unknown): PurchaseOrderLine {
  const raw = readObject(value);
  const line: PurchaseOrderLine = {
    id: readId(raw.id),
    lineNo: readPositive(raw.lineNo),
    variantId: readPositive(raw.variantId),
    itemName: readText(raw.itemName),
    colorName: readNullableText(raw.colorName),
    sizeLabel: readNullableText(raw.sizeLabel),
    provisionalQuantity: readCount(raw.provisionalQuantity),
    orderQuantity: readNullableCount(raw.orderQuantity),
    receivedQuantity: readCount(raw.receivedQuantity),
    outstandingQuantity: readNullableCount(raw.outstandingQuantity),
    unitPriceYen: readNullableCount(raw.unitPriceYen),
    version: readPositive(raw.version),
  };
  checkQuantities(line.orderQuantity, line.receivedQuantity, line.outstandingQuantity);
  return line;
}

function readRevision(value: unknown): PurchaseOrderRevision {
  const raw = readObject(value);
  return {
    id: readId(raw.id),
    lineId: readNullableId(raw.lineId),
    revisionNo: readPositive(raw.revisionNo),
    kind: readOneOf(raw.kind, PURCHASE_ORDER_REVISION_KINDS),
    beforeQuantity: readNullableCount(raw.beforeQuantity),
    afterQuantity: readNullableCount(raw.afterQuantity),
    beforeUnitPriceYen: readNullableCount(raw.beforeUnitPriceYen),
    afterUnitPriceYen: readNullableCount(raw.afterUnitPriceYen),
    beforeSupplierName: readNullableText(raw.beforeSupplierName),
    afterSupplierName: readNullableText(raw.afterSupplierName),
    beforeMemo: readNullableText(raw.beforeMemo),
    afterMemo: readNullableText(raw.afterMemo),
    reason: readNullableText(raw.reason),
    actorId: readId(raw.actorId),
    createdAt: readTimestamp(raw.createdAt),
  };
}

function readShortClosure(value: unknown): PurchaseOrderShortClosure {
  const raw = readObject(value);
  return {
    id: readId(raw.id),
    lineId: readId(raw.lineId),
    closedQuantity: readPositive(raw.closedQuantity),
    reason: readText(raw.reason),
    actorId: readId(raw.actorId),
    createdAt: readTimestamp(raw.createdAt),
  };
}

function readReceiptLine(value: unknown): PurchaseOrderReceiptLine {
  const raw = readObject(value);
  const quantity = readInteger(raw.quantity);
  const reversesReceiptLineId = readNullableId(raw.reversesReceiptLineId);
  const reversibleQuantity = readCount(raw.reversibleQuantity);
  // 負の行は相殺で、相殺の元を指し、取り消せる数は0。正の行は元を指さず、取り消せる数は数量以下
  if (quantity === 0 || (quantity < 0) !== (reversesReceiptLineId !== null) || reversibleQuantity > Math.max(quantity, 0)) fail();
  return { id: readId(raw.id), lineId: readId(raw.lineId), quantity, reversesReceiptLineId, reversibleQuantity };
}

function readReceipt(value: unknown): PurchaseOrderReceipt {
  const raw = readObject(value);
  return {
    id: readId(raw.id),
    kind: readOneOf(raw.kind, PURCHASE_ORDER_RECEIPT_KINDS),
    receivedOn: readDay(raw.receivedOn),
    memo: readNullableText(raw.memo),
    reason: readNullableText(raw.reason),
    actorId: readId(raw.actorId),
    createdAt: readTimestamp(raw.createdAt),
    lines: readList(raw.lines, readReceiptLine),
  };
}

function readAttachment(value: unknown): PurchaseOrderAttachment {
  const raw = readObject(value);
  const current = readObject(raw.current);
  return {
    id: readId(raw.id),
    kind: readOneOf(raw.kind, PURCHASE_ORDER_ATTACHMENT_KINDS),
    fileName: readText(raw.fileName),
    mimeType: readText(raw.mimeType),
    sizeBytes: readCount(raw.sizeBytes),
    sha256: readMatch(raw.sha256, SHA256_PATTERN),
    sha256Source: readOneOf(raw.sha256Source, PURCHASE_ORDER_SHA256_SOURCES),
    createdAt: readTimestamp(raw.createdAt),
    current: {
      revisionNo: readPositive(current.revisionNo),
      transactionDate: readDay(current.transactionDate),
      amountYen: readCount(current.amountYen),
      currency: readMatch(current.currency, CURRENCY_PATTERN),
      counterparty: readText(current.counterparty),
      voided: readBoolean(current.voided),
      reason: readNullableText(current.reason),
      replacesAttachmentId: readNullableId(current.replacesAttachmentId),
    },
    revisionCount: readPositive(raw.revisionCount),
  };
}

function readPendingUpload(value: unknown): PurchaseOrderPendingUpload {
  const raw = readObject(value);
  return {
    reservationId: readId(raw.reservationId),
    kind: readOneOf(raw.kind, PURCHASE_ORDER_ATTACHMENT_KINDS),
    fileName: readText(raw.fileName),
    createdAt: readTimestamp(raw.createdAt),
    expiresAt: readTimestamp(raw.expiresAt),
    expired: readBoolean(raw.expired),
  };
}

/**
 * 発注書の詳細（get_admin_purchase_order の戻り）を検査して、決まった項目だけの値にする。
 * 形・整数・段階の値が崩れていれば Error('PURCHASE_ORDER_READ_FAILED')。知らない項目は落とす。
 */
export function parsePurchaseOrderDetail(value: unknown): PurchaseOrderDetail {
  const raw = readObject(value);
  const stage = readOneOf(raw.stage, PURCHASE_ORDER_STAGES);
  const displayStage = readOneOf(raw.displayStage, PURCHASE_ORDER_DISPLAY_STAGES);
  // 数量確定前（ordered）だけが表示段階も ordered。確定後の4つの段階は導出した値
  if ((stage === 'ordered') !== (displayStage === 'ordered')) fail();
  const flags = readObject(raw.flags);
  return {
    id: readId(raw.id),
    number: readMatch(raw.number, NUMBER_PATTERN),
    supplierName: readText(raw.supplierName),
    memo: readNullableText(raw.memo),
    stage,
    displayStage,
    version: readPositive(raw.version),
    orderedAt: readTimestamp(raw.orderedAt),
    createdBy: readId(raw.createdBy),
    lines: readList(raw.lines, readLine),
    revisions: readList(raw.revisions, readRevision),
    shortClosures: readList(raw.shortClosures, readShortClosure),
    receipts: readList(raw.receipts, readReceipt),
    attachments: readList(raw.attachments, readAttachment),
    pendingUploads: readList(raw.pendingUploads, readPendingUpload),
    flags: { unitPriceMissing: readBoolean(flags.unitPriceMissing), documentMissing: readBoolean(flags.documentMissing) },
    estimatedAmountYen: readNullableCount(raw.estimatedAmountYen),
  };
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 日時を日本時間の YYYY/MM/DD にする。読めない日時は「—」。 */
export function formatPurchaseOrderDate(timestamp: string): string {
  const jst = new Date(Date.parse(timestamp) + JST_OFFSET_MS);
  if (Number.isNaN(jst.getTime())) return '—';
  return `${jst.getUTCFullYear()}/${pad2(jst.getUTCMonth() + 1)}/${pad2(jst.getUTCDate())}`;
}

/** 日時を日本時間の YYYY/MM/DD HH:mm にする。読めない日時は「—」。 */
export function formatPurchaseOrderDateTime(timestamp: string): string {
  const jst = new Date(Date.parse(timestamp) + JST_OFFSET_MS);
  if (Number.isNaN(jst.getTime())) return '—';
  return `${formatPurchaseOrderDate(timestamp)} ${pad2(jst.getUTCHours())}:${pad2(jst.getUTCMinutes())}`;
}

/** 日付（YYYY-MM-DD）を YYYY/MM/DD にする（日付だけの値なので時差の換算はしない）。 */
export function formatPurchaseOrderDay(day: string): string {
  return day.replace(/-/g, '/');
}

/** 3桁ごとにコンマを入れる（0 以上の整数） */
export function formatNumber(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 金額（整数円）を ¥1,200 の形にする */
export function formatYen(amount: number): string {
  return `¥${formatNumber(amount)}`;
}

/**
 * 発注書の頁のクエリに、作成直後の目印（PURCHASE_ORDER_CREATED_QUERY）があるか。
 * 値がちょうど一致する時だけ真（無い・別の値・同じ名前の複数指定は偽）。
 */
export function isPurchaseOrderCreatedQuery(query: Record<string, string | string[] | undefined>): boolean {
  const [name, expected] = PURCHASE_ORDER_CREATED_QUERY.split('=');
  return query[name] === expected;
}
