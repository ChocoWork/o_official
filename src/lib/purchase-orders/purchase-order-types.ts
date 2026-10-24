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
