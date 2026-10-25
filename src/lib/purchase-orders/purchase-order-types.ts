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
  /** 取引書類の取引先（前後の空白を落とした後の文字数） */
  counterparty: { min: 1, max: 100 },
  /** 取引書類の原本のファイル名 */
  documentFileName: { min: 1, max: 255 },
  /** 取引書類の取引金額（整数円。発注見込額とは別に保存する） */
  documentAmountYen: { min: 0, max: 99999999999 },
} as const;

/** 取引書類の原本の大きさの上限（20 MiB。非公開の入れ物 purchase-order-documents の file_size_limit と同じ） */
export const PURCHASE_ORDER_DOCUMENT_MAX_BYTES = 20971520;
/** 取引日の下限（DB の CHECK と同じ。上は未来でもよい） */
export const PURCHASE_ORDER_DOCUMENT_MIN_DAY = '2000-01-01';
/** 書類検索の1頁の件数 */
export const PURCHASE_ORDER_DOCUMENT_PAGE_LIMIT = 50;

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
 * 発注の作成が返し得る3つ、数量の確定・訂正、打切り、発注先・メモの訂正が返し得る5つ、受け取りとその取消・数量訂正、取引書類の原本が返し得る誤りを、下に並べてある。窓口ごとの誤りはみなここにある。
 */
export const PURCHASE_ORDER_ERRORS: Record<string, readonly [sqlstate: string, status: number, body: string]> = {
  GROUP_G_ARGUMENT_INVALID: ['22023', 400, '入力を確かめてください。'],
  GROUP_G_FORBIDDEN: ['42501', 403, '発注を扱う権限がありません。'],
  GROUP_G_REQUEST_KEY_CONFLICT: ['23505', 409, '同じ要求番号で異なる操作は実行できません。'],
  GROUP_G_PO_NOT_FOUND: ['P0002', 404, '発注書が見つかりません。'],
  GROUP_G_PO_VERSION_CONFLICT: ['55000', 409, '発注書が更新されました。内容を確認して、もう一度送ってください。'],
  GROUP_G_PO_REASON_REQUIRED: ['22023', 400, '理由を入力してください。'],
  GROUP_G_PO_QUANTITY_BELOW_RECEIVED: ['23514', 409, '納品済みの数より少ない数量には訂正できません。'],
  GROUP_G_PO_NOTHING_TO_CLOSE: ['55000', 409, '打ち切る未納がありません。'],
  // 受け取りとその取消・数量訂正（Task 7）。確認の約束は G-1 の在庫を減らす操作と同じ（DETAIL は {"releasedQuantity":n} だけ）
  GROUP_G_PO_NOT_CONFIRMED: ['55000', 409, '数量が確定するまで受け取りはできません。'],
  GROUP_G_PO_RECEIVE_EXCEEDS_REMAINING: ['23514', 409, '未納の数を超えて受け取ることはできません。先に数量を訂正してください。'],
  GROUP_G_PO_RECEIVED_ON_INVALID: ['22023', 400, '受取日は発注日から今日までの日付にしてください。'],
  GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED: ['23514', 409, '取り消せる数を超えています。'],
  GROUP_G_PO_REVERSE_STOCK_INSUFFICIENT: ['23514', 409, '在庫が足りないため取り消せません。取り消す数が、空き在庫と外せる割当の合計を超えています。'],
  GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED: ['55000', 409, '割り当て済みの品を外す必要があります。数量を確認してください。'],
  // 取引書類の原本（Task 8）
  GROUP_G_PO_DOCUMENT_RESERVATION_INVALID: ['55000', 409, '保存の予約が見つかりません。もう一度ファイルを選んでください。'],
  GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED: ['55000', 409, 'この書類はすでに登録されています。'],
  GROUP_G_PO_DOCUMENT_REPLACEMENT_INVALID: ['22023', 400, '差し替え元の書類を確かめてください。'],
};

/**
 * DB を呼ぶ前に store が原本（置き場のファイル）を確かめて投げる誤り（Task 8）。DB の誤りと違い SQLSTATE は無い。
 * キーは code、値は [HTTP の状態, 利用者に見せる本文]。署名つきの送り先・保存先の鍵・ファイルの中身は本文に入れない。
 */
export const PURCHASE_ORDER_DOCUMENT_ERRORS: Record<string, readonly [status: number, body: string]> = {
  DOCUMENT_NOT_UPLOADED: [409, 'ファイルがまだ届いていません。もう一度アップロードしてください。'],
  DOCUMENT_TYPE_UNSUPPORTED: [422, 'PDF・JPEG・PNG のファイルを選んでください。'],
  DOCUMENT_TOO_LARGE: [422, 'ファイルは 20 MiB までです。'],
  DOCUMENT_HASH_MISMATCH: [422, 'アップロードしたファイルの内容が一致しません。もう一度アップロードしてください。'],
  DOCUMENT_STORAGE_UNAVAILABLE: [503, 'ファイルの保存先に接続できません。時間をおいて再度お試しください。'],
  DOCUMENT_NOT_FOUND: [404, '原本を取得できません。'],
};

/**
 * 同じ DB の誤りでも、画面（受け取りの窓口と受け取りのダイアログ）ごとに本文を変える物。いまは権限の文だけ。
 * order は発注の窓口（作成・訂正・数量・打切り）、receipt は受け取りとその取消・数量訂正。
 */
export type PurchaseOrderSurface = 'order' | 'receipt';
export const PURCHASE_ORDER_SURFACE_FORBIDDEN: Record<PurchaseOrderSurface, string> = {
  order: PURCHASE_ORDER_ERRORS.GROUP_G_FORBIDDEN[2],
  receipt: '受け取りを記録する権限がありません。',
};

/** 利用者に見せる誤り code（DB の表と原本の表）か。継承した名前は含まない */
export function isPurchaseOrderErrorCode(code: string): boolean {
  return Object.hasOwn(PURCHASE_ORDER_ERRORS, code) || Object.hasOwn(PURCHASE_ORDER_DOCUMENT_ERRORS, code);
}

/** 誤り code の本文（isPurchaseOrderErrorCode が真の code だけ）。受け取りの画面では GROUP_G_FORBIDDEN だけ画面ごとの文に替える。 */
export function purchaseOrderErrorBody(code: string, surface: PurchaseOrderSurface = 'order'): string {
  if (Object.hasOwn(PURCHASE_ORDER_DOCUMENT_ERRORS, code)) return PURCHASE_ORDER_DOCUMENT_ERRORS[code][1];
  return code === 'GROUP_G_FORBIDDEN' ? PURCHASE_ORDER_SURFACE_FORBIDDEN[surface] : PURCHASE_ORDER_ERRORS[code][2];
}

export type PurchaseOrderCreateInput = {
  supplierName: string;
  memo: string | null;
  lines: { variantId: number; quantity: number }[];
  requestKey: string;
};

export type PurchaseOrderCreated = { id: string; number: string; version: number; replayed: boolean };

/** 発注先・メモの訂正（G-2 Task 6 / FREQ-527）。memo が null ならメモを空にする。 */
export type PurchaseOrderHeaderUpdateInput = {
  purchaseOrderId: string;
  expectedVersion: number;
  supplierName: string;
  memo: string | null;
  reason: string;
  requestKey: string;
};
export type PurchaseOrderHeaderUpdated = { version: number; replayed: boolean };

/** 数量の確定（最初の確定。reason は任意）と訂正（reason 必須）。lines は発注書の全行をちょうど1回ずつ。unitPriceYen null は単価未登録、0 は 0 円。 */
export type PurchaseOrderQuantitiesInput = {
  purchaseOrderId: string;
  expectedVersion: number;
  lines: { lineId: string; quantity: number; unitPriceYen: number | null }[];
  reason: string | null;
  requestKey: string;
};
export type PurchaseOrderQuantitiesConfirmed = { version: number; changedLines: number; replayed: boolean };

/** 残りの打切り（確定後は未納のある行、確定前の取消は全行）。 */
export type PurchaseOrderShortCloseInput = {
  purchaseOrderId: string;
  expectedVersion: number;
  lineIds: string[];
  reason: string;
  requestKey: string;
};
export type PurchaseOrderShortClosed = { version: number; closedQuantity: number; replayed: boolean };

/** 受け取り（G-2 Task 7 / FREQ-529）。receivedOn は YYYY-MM-DD（発注日から今日まで・日本時間）。lines は受け取る行だけ（各 1〜未納）。 */
export type PurchaseOrderReceiveInput = {
  purchaseOrderId: string;
  expectedVersion: number;
  receivedOn: string;
  memo: string | null;
  lines: { lineId: string; quantity: number }[];
  requestKey: string;
};
export type PurchaseOrderReceived = { receiptId: string; version: number; allocatedQuantity: number; replayed: boolean };

/**
 * 受け取りの取消・数量訂正（同じ操作。取消 = 全ての行を取り消せる数ぜんぶ、訂正 = 一部の行を一部の数）。
 * expectedReleaseQuantity は外す割当の点数の確認値。最初は null で送り、外す割当があると窓口が 409
 * （GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED + releasedQuantity）で返す。確認した後は新しい requestKey で、その数を入れて送り直す。
 */
export type PurchaseOrderReceiptReverseInput = {
  purchaseOrderId: string;
  expectedVersion: number;
  receiptId: string;
  lines: { receiptLineId: string; quantity: number }[];
  reason: string;
  expectedReleaseQuantity: number | null;
  requestKey: string;
};
export type PurchaseOrderReceiptReversed = { receiptId: string; version: number; releasedQuantity: number; replayed: boolean };

/** 受け取りの固定の文（発注書の詳細のボタンと、受け取り・取消のダイアログ）。 */
export const PURCHASE_ORDER_RECEIPT_TEXT = {
  receiveAll: '全部受け取る',
  receivePart: '一部を受け取る',
  receiveAllTitle: '全部を受け取る',
  receivePartTitle: '一部を受け取る',
  receiveNote: '検品で不良だった分は入力せず、未納のまま待つか、あとで打ち切ってください。',
  receiveSubmit: '受け取りを確定',
  receivedNotice: '受け取りを記録しました。',
  reverse: 'この受け取りを取り消す',
  correct: '数量を訂正',
  reverseTitle: '受け取りの取消',
  correctTitle: '受け取り数量の訂正',
  reverseNote: '受け取りで入った在庫を、まず空き在庫から減らします。足りない時は、支払い済みの注文の割当を新しい注文から外します。',
  reverseSubmit: '取り消す',
  correctSubmit: '訂正する',
  reversedNotice: '受け取りを取り消しました。',
  correctedNotice: '受け取り数量を訂正しました。',
  reasonRequired: PURCHASE_ORDER_ERRORS.GROUP_G_PO_REASON_REQUIRED[2],
} as const;

/** 外す割当があると、最初の送信は 409 になる。その確認の段に出す本文（n は窓口が返した外す点数）。 */
export function formatPurchaseOrderReleaseConfirmation(releasedQuantity: number): string {
  return `割り当て済みの品を${releasedQuantity}点外し、受注生産中に戻します。`;
}

/** 外す割当の確認を求める 409 の code（G-1 の在庫を減らす操作と同じ） */
export const PURCHASE_ORDER_RELEASE_CONFIRMATION_CODE = 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED';

/** 窓口の 409 の本文から、外す点数（0 以上の整数）を取り出す。形が合わなければ null */
export function readReleasedQuantity(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const { code, releasedQuantity } = body as { code?: unknown; releasedQuantity?: unknown };
  if (code !== PURCHASE_ORDER_RELEASE_CONFIRMATION_CODE) return null;
  return typeof releasedQuantity === 'number' && Number.isInteger(releasedQuantity) && releasedQuantity >= 0 && releasedQuantity <= 2147483647
    ? releasedQuantity
    : null;
}

const JST_DAY_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 日本時間の日付（YYYY-MM-DD）。受取日の初期値と範囲に使う。日時の文字列を渡すと、その日時の日本時間の日付。 */
export function purchaseOrderJstDay(at: Date | string = new Date()): string {
  const time = typeof at === 'string' ? Date.parse(at) : at.getTime();
  return Number.isNaN(time) ? '' : new Date(time + JST_DAY_OFFSET_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD が実在の日付か（2026-02-30 のような日付は偽） */
export function isPurchaseOrderDay(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** 明細の呼び名: 商品名・色・サイズ。色・サイズが無ければ有る部分だけを並べる（詳細の表・履歴・ダイアログで同じ） */
export function formatPurchaseOrderLineLabel(line: { itemName: string; colorName: string | null; sizeLabel: string | null }): string {
  return [line.itemName, line.colorName, line.sizeLabel].filter((part): part is string => part !== null && part !== '').join(' ');
}

/** 発注書の詳細の操作（G-2 Task 6）の固定の文。ボタンの名前と、成功の通知。 */
export const PURCHASE_ORDER_ACTION_TEXT = {
  confirmQuantities: '数量確定',
  cancelOrder: '発注を取り消す',
  correctQuantities: '数量を訂正',
  correctHeader: '発注先・メモを訂正',
  shortClose: '残りを打ち切る',
  selectOutstanding: '未納のある行をすべて選ぶ',
  quantitiesConfirmedNotice: '数量を確定しました。',
  quantitiesCorrectedNotice: '数量を訂正しました。',
  shortClosedNotice: '残りを打ち切りました。',
  headerCorrectedNotice: '発注先・メモを訂正しました。',
  cancelledNotice: '発注を取り消しました。',
} as const;

/** 発注の固定の文。窓口は failed、画面は forbidden・supplierRequired・failed・invalidInput を使う。 */
export const PURCHASE_ORDER_TEXT = {
  forbidden: PURCHASE_ORDER_ERRORS.GROUP_G_FORBIDDEN[2],
  invalidInput: PURCHASE_ORDER_ERRORS.GROUP_G_ARGUMENT_INVALID[2],
  supplierRequired: '発注先を入力してください。',
  failed: '発注の記録に失敗しました',
  /** 変更の窓口の CSRF の確かめで断られた時（権限の不足ではない）。他の管理画面と同じ「再読み込みして、もう一度」の文 */
  csrfFailed: 'セキュリティ確認に失敗しました。ページを再読み込みして、もう一度送ってください。',
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
 * 発注の作成・数量の確定と訂正・打切り・発注先の訂正が失敗した時に画面へ出す文。
 * 表にある code はその本文、CSRF で断られた 403 は「再読み込みして、もう一度」の文（権限の不足とは言わない）、
 * MFA の無い 403 は専用の文、401・403・400 はそれぞれの文、他は固定の失敗の文。
 * 窓口の本文の error は使わない（英語の検証の文や生の文を画面へ流さないため）。
 * surface が receipt（受け取りとその取消・数量訂正）の時だけ、権限の文が「受け取りを記録する権限がありません。」になる。
 */
export function purchaseOrderFailureMessage(status: number, body: unknown, surface: PurchaseOrderSurface = 'order'): string {
  const { code, reason } = (typeof body === 'object' && body !== null ? body : {}) as { code?: unknown; reason?: unknown };
  if (typeof code === 'string' && isPurchaseOrderErrorCode(code)) return purchaseOrderErrorBody(code, surface);
  if (status === 403 && reason === 'CSRF validation failed') return PURCHASE_ORDER_TEXT.csrfFailed;
  return adminLoadFailureMessage(status, body, PURCHASE_ORDER_SURFACE_FORBIDDEN[surface],
    status === 400 ? PURCHASE_ORDER_TEXT.invalidInput : PURCHASE_ORDER_TEXT.failed);
}

/** 発注の作成の画面が使う名前（purchaseOrderFailureMessage と同じ関数） */
export const purchaseOrderCreateFailureMessage = purchaseOrderFailureMessage;

/** 発注書の版が古い（別の操作で更新された）時の code。画面は本文を出し、発注書を読み直す（入力は保つ） */
export const PURCHASE_ORDER_VERSION_CONFLICT_CODE = 'GROUP_G_PO_VERSION_CONFLICT';

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
  /** 受取を記録した人のメールアドレス(在庫の履歴と同じ見せ方)。アカウントが無くなっていれば null。画面は「実行者」に出す */
  actorEmail: string | null;
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

/** 添付に結ばれていない予約（保存の途中で止まったファイル）。replacesAttachmentId は差し替えの予約が差し替える添付（新しい書類は null） */
export type PurchaseOrderPendingUpload = {
  reservationId: string;
  kind: PurchaseOrderAttachmentKind;
  fileName: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  replacesAttachmentId: string | null;
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
    actorEmail: readNullableText(raw.actorEmail),
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
    replacesAttachmentId: readNullableId(raw.replacesAttachmentId),
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

// ---- 取引書類の原本（見積書・請求書 / G-2 Task 8・FREQ-530） ----

export type PurchaseOrderDocumentMeta = {
  transactionDate: string;
  amountYen: number;
  counterparty: string;
};

export type PurchaseOrderDocumentMime = 'application/pdf' | 'image/jpeg' | 'image/png';

/** 原本に使える拡張子と、その種類（小文字の拡張子）。画面の事前の確かめとサーバーの検査が同じ表を使う */
export const PURCHASE_ORDER_DOCUMENT_MIME_BY_EXTENSION: Readonly<Record<string, PurchaseOrderDocumentMime>> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/** 種類ごとの先頭のバイト（PDF `%PDF-`／JPEG `FF D8 FF`／PNG `89 50 4E 47 0D 0A 1A 0A`） */
export const PURCHASE_ORDER_DOCUMENT_SIGNATURES: Readonly<Record<PurchaseOrderDocumentMime, readonly number[]>> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

/** 先頭のバイトを見るのに要る長さ（一番長い印） */
export const PURCHASE_ORDER_DOCUMENT_SIGNATURE_LENGTH = 8;

/** ファイル名の拡張子（最後の `.` の後ろ。小文字）から種類を決める。許す拡張子でなければ null */
export function purchaseOrderDocumentMimeOfName(name: string): PurchaseOrderDocumentMime | null {
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1].toLowerCase();
  return extension !== undefined && Object.hasOwn(PURCHASE_ORDER_DOCUMENT_MIME_BY_EXTENSION, extension)
    ? PURCHASE_ORDER_DOCUMENT_MIME_BY_EXTENSION[extension]
    : null;
}

/** 先頭のバイトが、その種類の印と同じか */
export function hasPurchaseOrderDocumentSignature(bytes: ArrayLike<number>, mime: PurchaseOrderDocumentMime): boolean {
  return PURCHASE_ORDER_DOCUMENT_SIGNATURES[mime].every((byte, index) => bytes[index] === byte);
}

/** 書類の予約（置き場の保存先を1つ約束する）。署名つきの送り先は応答にだけ載せる。replacesAttachmentId は差し替える添付（予約に残り、確定が版1へ写す） */
export type PurchaseOrderDocumentReserveInput = {
  purchaseOrderId: string;
  kind: PurchaseOrderAttachmentKind;
  fileName: string;
  replacesAttachmentId: string | null;
  requestKey: string;
};
export type PurchaseOrderDocumentReserved = { reservationId: string; signedUrl: string; expiresAt: string; replayed: boolean };

export type PurchaseOrderDocumentUploadUrlInput = { purchaseOrderId: string; reservationId: string };
export type PurchaseOrderDocumentUploadUrl = { uploaded: true } | { uploaded: false; signedUrl: string };

/** sha256 は 64 桁の小文字（ブラウザが計算した値）。null は手元にファイルが無い再開で、サーバーが読み戻した本文から計算する */
export type PurchaseOrderDocumentAttachInput = PurchaseOrderDocumentMeta & {
  purchaseOrderId: string;
  reservationId: string;
  sha256: string | null;
  currency: 'JPY';
  requestKey: string;
};
export type PurchaseOrderDocumentAttached = { attachmentId: string; revisionNo: number; replayed: boolean };

/** 書類の情報の訂正と無効化（どちらも新しい版を足す。reason は必須） */
export type PurchaseOrderDocumentReviseInput = PurchaseOrderDocumentMeta & {
  purchaseOrderId: string;
  attachmentId: string;
  currency: 'JPY';
  voided: boolean;
  reason: string;
  requestKey: string;
};
export type PurchaseOrderDocumentRevised = { attachmentId: string; revisionNo: number; replayed: boolean };

export type PurchaseOrderDocumentUrlInput = { purchaseOrderId: string; attachmentId: string; download: boolean };
export type PurchaseOrderDocumentUrl = { url: string; expiresInSeconds: 60 };

/** 書類検索の条件。空の条件は null（かけない）。日付は YYYY-MM-DD、金額は整数円 */
export type PurchaseOrderDocumentSearchFilters = {
  dateFrom: string | null;
  dateTo: string | null;
  amountMin: number | null;
  amountMax: number | null;
  counterparty: string | null;
  number: string | null;
  kind: PurchaseOrderAttachmentKind | null;
  includeHistory: boolean;
};

/** 書類検索の1行（添付の1つの版）。保存先の鍵は含まない。isCurrent が偽の行は、訂正の前の版 */
export type PurchaseOrderDocumentSearchRow = {
  attachmentId: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  kind: PurchaseOrderAttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  revisionNo: number;
  isCurrent: boolean;
  transactionDate: string;
  amountYen: number;
  currency: string;
  counterparty: string;
  voided: boolean;
  reason: string | null;
  replacesAttachmentId: string | null;
  createdAt: string;
};

/** 書類検索の1行を検査する（DB の戻りを camelCase にした物、または窓口の応答の1行）。決まった項目だけを返す。崩れていれば PURCHASE_ORDER_READ_FAILED */
export function parsePurchaseOrderDocumentSearchRow(value: unknown): PurchaseOrderDocumentSearchRow {
  const raw = readObject(value);
  return {
    attachmentId: readId(raw.attachmentId),
    purchaseOrderId: readId(raw.purchaseOrderId),
    purchaseOrderNumber: readMatch(raw.purchaseOrderNumber, NUMBER_PATTERN),
    kind: readOneOf(raw.kind, PURCHASE_ORDER_ATTACHMENT_KINDS),
    fileName: readText(raw.fileName),
    mimeType: readText(raw.mimeType),
    sizeBytes: readCount(raw.sizeBytes),
    revisionNo: readPositive(raw.revisionNo),
    isCurrent: readBoolean(raw.isCurrent),
    transactionDate: readDay(raw.transactionDate),
    amountYen: readCount(raw.amountYen),
    currency: readMatch(raw.currency, CURRENCY_PATTERN),
    counterparty: readText(raw.counterparty),
    voided: readBoolean(raw.voided),
    reason: readNullableText(raw.reason),
    replacesAttachmentId: readNullableId(raw.replacesAttachmentId),
    createdAt: readTimestamp(raw.createdAt),
  };
}

/** 取引書類の固定の文（発注書の詳細の節・保存途中のファイル・書類検索）。窓口の文は誤りの表（PURCHASE_ORDER_DOCUMENT_ERRORS）にある。 */
export const PURCHASE_ORDER_DOCUMENT_TEXT = {
  heading: '取引書類',
  add: '書類を追加',
  empty: '取引書類はまだありません。',
  voidedBadge: '無効',
  view: '表示',
  download: 'ダウンロード',
  print: '印刷',
  correct: '情報を訂正',
  replace: '差し替える',
  void: '無効にする',
  pendingHeading: '保存が終わっていないファイル',
  resume: '続きから保存',
  expired: '期限を過ぎています。内容を確認してください。',
  kindLabel: '種類',
  transactionDateLabel: '取引日',
  amountLabel: '金額（円）',
  counterpartyLabel: '取引先',
  fileLabel: 'ファイル',
  reasonLabel: '理由',
  addTitle: '書類を追加',
  replaceTitle: '書類を差し替える',
  correctTitle: '書類の情報を訂正',
  voidTitle: '書類を無効にする',
  resumeTitle: '続きから保存',
  save: '保存する',
  back: '戻る',
  selectFileAgain: 'ファイルを選び直してください。',
  /** 続きから保存で選び直したファイルが、予約したファイルの種類と違う */
  resumeTypeMismatch: '予約したファイルと同じ種類のファイルを選んでください。',
  /** 置き場のファイルが種類の検査に通らなかった（続きから保存を繰り返しても通らない）。新しい予約で保存し直す */
  rejectedFile: 'このファイルは保存できませんでした。PDF・JPEG・PNG の正しいファイルを選び直して、新しく保存してください。',
  correctSubmit: '訂正する',
  searchResults: '検索結果',
  savedNotice: '書類を保存しました。',
  correctedNotice: '書類の情報を訂正しました。',
  voidedNotice: '書類を無効にしました。',
  pendingNotice: '書類の保存が終わっていません。内容を確認して、続きから保存してください。',
  openFailed: '原本を取得できません。',
  /** 原本を開く新しいタブをブラウザが止めた（ポップアップのブロック）。リンクはまだ取っていない */
  openBlocked: '新しいタブがブラウザに止められました。このサイトのポップアップを許可して、もう一度押してください。',
  uploadFailed: 'ファイルを送れませんでした。続きから保存してください。',
  inputRequired: '取引日・金額・取引先を入力してください。',
  fileRequired: 'ファイルを選んでください。',
  /** 書類検索 */
  searchHeading: '取引書類の検索',
  searchDateFrom: '取引日（から）',
  searchDateTo: '取引日（まで）',
  searchAmountMin: '金額（円）（から）',
  searchAmountMax: '金額（円）（まで）',
  searchCounterparty: '取引先',
  searchNumber: '発注書番号',
  searchKind: '種類',
  searchKindAll: 'すべて',
  searchIncludeHistory: '訂正前の情報も探す',
  search: '検索',
  clear: '条件をクリア',
  searchEmpty: '該当する書類はありません。',
  searchForbidden: '取引書類を見る権限がありません。',
  searchFailed: '取引書類を読み込めませんでした。時間をおいて再度お試しください。',
  searchApiFailed: '取引書類を読み込めませんでした。',
  columnNumber: '発注書番号',
  columnKind: '種類',
  columnFileName: 'ファイル名',
  columnDate: '取引日',
  columnAmount: '金額（円）',
  columnCounterparty: '取引先',
  columnState: '状態',
  /** 結果の表の最後の列（印刷しない）と、その行の原本を開くボタン */
  columnOriginal: '原本',
  viewOriginal: '原本を見る',
  stateValid: '有効',
  stateVoided: '無効',
  stateBefore: '訂正前',
} as const;

/** 書類検索の結果の「状態」の文字。訂正前の版は「訂正前」、最新の版が無効なら「無効」、それ以外は「有効」 */
export function purchaseOrderDocumentStateLabel(row: Pick<PurchaseOrderDocumentSearchRow, 'isCurrent' | 'voided'>): string {
  if (!row.isCurrent) return PURCHASE_ORDER_DOCUMENT_TEXT.stateBefore;
  return row.voided ? PURCHASE_ORDER_DOCUMENT_TEXT.stateVoided : PURCHASE_ORDER_DOCUMENT_TEXT.stateValid;
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
