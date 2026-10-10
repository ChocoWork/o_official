import type { FulfillmentErrorCode, FulfillmentErrorResponse } from '@/lib/orders/fulfillment/fulfillment-types';

/**
 * 発送と仕上がりの窓口の誤りの言葉と HTTP（グループ E-1 設計書 5-2・6-2・7-2）。窓口と画面の両方が使うので、
 * サーバーだけの物を import しない。画面に出す言葉は、ここの1か所だけで持つ。
 */
export const FULFILLMENT_ERROR_MESSAGES = {
  order_not_found: { status: 404, message: '注文が見つかりません。' },
  not_shippable: { status: 409, message: '発送できる状態ではありません。一覧を更新してください。' },
  address_incomplete: { status: 409, message: '配送先の必須項目が足りないため発送できません。' },
  payment_review_required: { status: 409, message: '支払額の確認（要対応）が済むまで発送できません。' },
  quantity_exceeds_ready: {
    status: 409,
    message: '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。',
  },
  fulfillment_request_mismatch: { status: 409, message: '前の発送と内容が違います。画面を開き直してください。' },
  invalid_argument: { status: 400, message: '入力を確かめてください。' },
  fulfillment_not_found: { status: 404, message: '発送の記録が見つかりません。' },
  fulfillment_cancel_not_allowed: { status: 409, message: 'この発送は取り消せません。注文の状態を確かめてください。' },
  not_in_production: { status: 409, message: '仕上がりを記録できる状態ではありません。一覧を更新してください。' },
  quantity_exceeds_in_production: { status: 409, message: '仕上がった数が受注生産中の数を超えています。一覧を更新してください。' },
  completion_request_mismatch: { status: 409, message: '前の記録と内容が違います。画面を開き直してください。' },
  completion_not_found: { status: 404, message: '仕上がりの記録が見つかりません。' },
  completion_already_shipped: { status: 409, message: 'もう発送した数があるため、取り消せません。' },
} as const satisfies Record<FulfillmentErrorCode, { status: 400 | 404 | 409; message: string }>;

/** 窓口に届いた中身の形が誤っている時（400）。どこが誤りかは返さない */
export const INVALID_REQUEST_MESSAGE = '入力を確かめてください。';
export const INVALID_REQUEST_BODY: FulfillmentErrorResponse = { error: INVALID_REQUEST_MESSAGE, code: 'invalid_request' };

/** 思いがけない失敗（500）の言葉。何を記録しようとして失敗したかで分ける */
export const FULFILLMENT_FAILURE_MESSAGES = {
  create: '発送の記録に失敗しました。',
  cancel: '発送の取消に失敗しました。',
  completion: '仕上がりの記録に失敗しました。',
  completion_cancel: '仕上がりの取消に失敗しました。',
  materials: '発送の材料を読み込めませんでした。',
} as const;
export type FulfillmentFailureKind = keyof typeof FULFILLMENT_FAILURE_MESSAGES;

/** 通信が切れたなど、サーバーが記録したか分からない時に画面が出す言葉 */
export const UNKNOWN_OUTCOME_MESSAGE =
  '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

export function fulfillmentErrorBody(code: FulfillmentErrorCode): FulfillmentErrorResponse {
  return { error: FULFILLMENT_ERROR_MESSAGES[code].message, code };
}

export function fulfillmentFailureBody(kind: FulfillmentFailureKind): FulfillmentErrorResponse {
  return { error: FULFILLMENT_FAILURE_MESSAGES[kind], code: 'failed' };
}
