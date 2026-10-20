import type { CustomerReturnLineState, CustomerReturnStatus } from '@/lib/orders/returns/customer-return-types';
import type { ReturnErrorCode } from '@/lib/orders/returns/return-types';

/**
 * お客様の窓口の誤りの言葉と HTTP、お客様の注文の画面・申し込みの画面に出す状態の言葉（グループ E-3 段2。共通の約束 C-4・C-5）。
 * お客様の窓口とお客様の画面の両方が使うので、サーバーだけの物を import しない。管理画面の言葉（return-messages.ts）とは別の表にする
 * （同じ記号でも、お客様には「店長」や管理画面の言葉を出さない）。お客様に出さない記号（C-4 のお客様の欄が「—」）は、この表に入れない。
 */

/** お客様の言葉がある誤りの記号（共通の約束 C-4 のお客様の欄が「—」でない物） */
export const CUSTOMER_RETURN_ERROR_CODES = [
  'RETURN_NOT_ELIGIBLE',
  'RETURN_REQUESTS_CLOSED',
  'RETURN_PHOTO_INVALID',
  'RETURN_CUSTOMER_NOTE_REQUIRED',
  'RETURN_QUANTITY_EXCEEDS',
  'RETURN_REQUEST_MISMATCH',
  'RETURN_EXCHANGE_VARIANT_INVALID',
  'RETURN_ARGUMENT_INVALID',
  'ORDER_NOT_RETURNABLE',
  'CANCEL_REQUEST_EXISTS',
  'CANCEL_REQUEST_NOT_ELIGIBLE',
  'CANCEL_REQUEST_QUANTITY_EXCEEDS',
] as const satisfies readonly ReturnErrorCode[];
export type CustomerReturnErrorCode = (typeof CUSTOMER_RETURN_ERROR_CODES)[number];

/** DB の受付停止の記号は共通なので、キャンセルの窓口と画面では申し込みの種類に合う言葉を使う */
export const CUSTOMER_CANCEL_REQUESTS_CLOSED_MESSAGE = '現在、キャンセルのお申し込みを受け付けていません。';

/** 窓口の誤りの記号が、お客様の言葉を持つ記号か（持たない記号は、お客様の窓口では想定外の失敗として扱う） */
export function isCustomerReturnErrorCode(code: string): code is CustomerReturnErrorCode {
  return (CUSTOMER_RETURN_ERROR_CODES as readonly string[]).includes(code);
}

export const CUSTOMER_RETURN_ERROR_MESSAGES = {
  RETURN_NOT_ELIGIBLE: { status: 409, message: 'お申し込みいただけない商品が含まれています。画面を開き直してください。' },
  RETURN_REQUESTS_CLOSED: { status: 409, message: '現在、返品・交換のお申し込みを受け付けていません。' },
  RETURN_PHOTO_INVALID: { status: 400, message: '写真を確かめてください（JPEG・PNG、1枚10MBまで、1つの商品に5枚まで）。' },
  RETURN_CUSTOMER_NOTE_REQUIRED: { status: 400, message: '「破損・不良」「その他」の時は、詳しい内容を入れてください（300字まで）。' },
  RETURN_QUANTITY_EXCEEDS: { status: 409, message: 'お申し込みいただける数を超えています。画面を開き直してください。' },
  RETURN_REQUEST_MISMATCH: { status: 409, message: 'お申し込みの内容が変わりました。画面を開き直してください。' },
  RETURN_EXCHANGE_VARIANT_INVALID: { status: 400, message: '交換する色・サイズを選び直してください。' },
  RETURN_ARGUMENT_INVALID: { status: 400, message: '入力を確かめてください。' },
  ORDER_NOT_RETURNABLE: { status: 409, message: 'この注文は、返品・交換のお申し込みを受け付けていません。' },
  CANCEL_REQUEST_EXISTS: { status: 409, message: 'キャンセルのお申し込みは、すでに受け付けています。' },
  CANCEL_REQUEST_NOT_ELIGIBLE: { status: 409, message: 'この注文は、キャンセルのお申し込みを受け付けていません。' },
  CANCEL_REQUEST_QUANTITY_EXCEEDS: { status: 409, message: 'お申し込みいただける数を超えています。画面を開き直してください。' },
} as const satisfies Record<CustomerReturnErrorCode, { status: 400 | 404 | 409; message: string }>;

/**
 * お客様の注文の画面の返品の状態の言葉（label）と、状態に添える決まった文（note）。
 * 返送のしかた・交換の品の一文・お断りの「当店より:」とお店のメッセージは、状態だけでは決まらないので、画面が組む（note は null）
 */
export const CUSTOMER_RETURN_STATUS_TEXT: Record<CustomerReturnStatus, { label: string; note: string | null }> = {
  requested: { label: 'お申し込み中', note: '内容を確かめて、メールでご連絡します。' },
  accepted: { label: '返品の受付済み', note: null },
  partially_received: { label: '一部をお受け取りしました', note: '残りの商品の返送のしかたは、下のとおりです。' },
  inspecting: { label: 'お受け取りしました（確かめています）', note: '確かめてから、ご連絡します。' },
  awaiting_fee: { label: 'お支払いをお待ちしています', note: 'ご案内のメールをご覧ください。' },
  refund_preparing: { label: 'ご返金の準備中', note: null },
  returned: { label: '返品済み', note: null },
  declined: { label: 'お受けできませんでした', note: null },
};

/** 申し込みの画面で選べない品に出す言葉（選べる品 selectable には出さない） */
export const CUSTOMER_RETURN_LINE_STATE_LABELS: Record<Exclude<CustomerReturnLineState, 'selectable'>, string> = {
  past_deadline: '受付の期限を過ぎました',
  requested: 'お申し込み済み',
  sent_back: 'お返しした商品のため、お申し込みいただけません',
  unavailable: 'お申し込みいただける数がありません',
};

/** お客様の窓口の想定外の失敗（500）の言葉 */
export const CUSTOMER_RETURN_FAILURE_MESSAGE = 'お申し込みを受け付けられませんでした。時間をおいて、もう一度お試しください。';

/** お客様の窓口の回数の制限（429）の画面の言葉 */
export const CUSTOMER_RETURN_RATE_LIMITED_MESSAGE = 'しばらくしてから、もう一度お試しください。';
