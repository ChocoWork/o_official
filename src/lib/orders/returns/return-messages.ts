import { toOrderNumber } from '@/lib/orders/order-number';
import type {
  ReceiptDisposition,
  ReturnCarrier,
  ReturnDeclineReason,
  ReturnDisplayStatus,
  ReturnErrorCode,
  ReturnMark,
  ReturnReason,
} from '@/lib/orders/returns/return-types';

/**
 * 返品の窓口の誤りの言葉と HTTP、一覧や画面に出す言葉（グループ E-3 設計書 4-10・8 章。共通の約束 C-4・C-5）。
 * 窓口と画面の両方が使うので、サーバーだけの物を import しない。画面に出す言葉は、ここの1か所だけで持つ。
 * E-2 の返金の誤り（AWAITING_REFUND_EXISTS など）の言葉と HTTP は、E-2 の REFUND_ERROR_MESSAGES をそのまま使う（共通の約束 C-4 の末尾）。
 */
export const RETURN_ERROR_MESSAGES = {
  RETURN_NOT_FOUND: { status: 404, message: '返品が見つかりません。' },
  RETURN_ARGUMENT_INVALID: { status: 400, message: '入力を確かめてください。' },
  RETURN_QUANTITY_EXCEEDS: { status: 409, message: '返品できる数を超えています。画面を開き直してください。' },
  RETURN_EXCHANGE_VARIANT_INVALID: { status: 400, message: '交換の色・サイズを選び直してください（同じ商品の色・サイズだけ選べます）。' },
  RETURN_ADDRESS_REQUIRED: { status: 409, message: '返送先が設定されていません。ショップの設定で返送先を入れてから作ってください。' },
  RETURN_STATE_CONFLICT: { status: 409, message: '返品の状態が変わりました。画面を開き直してください。' },
  RETURN_RECEIPT_EXCEEDS: { status: 409, message: '受け取る数が、残りの数を超えています。画面を開き直してください。' },
  RETURN_EXCHANGE_OUT_OF_STOCK: { status: 409, message: '交換の品の在庫が足りません。「作って送る」か「返金に変える」を選んでください。' },
  RETURN_FORBIDDEN: { status: 403, message: 'この操作は店長だけができます。' },
  RETURN_REQUEST_MISMATCH: { status: 409, message: '同じ操作の番号で、違う内容が送られました。画面を開き直してください。' },
  RETURN_REASON_NOTE_REQUIRED: { status: 400, message: '理由が「その他」の時は、理由のメモを入れてください。' },
  RETURN_SENT_BACK_MESSAGE_REQUIRED: { status: 400, message: 'お返しする時は、お客様へのメッセージを入れてください。' },
  RETURN_FEE_INVALID: { status: 400, message: '手数料の額を確かめてください。' },
  RETURN_REFUND_AMOUNT_INVALID: { status: 400, message: '返金額は、返せる額までにしてください。' },
  RETURN_NOTHING_TO_REFUND: { status: 409, message: '返金する品がありません。画面を開き直してください。' },
  FULFILLMENT_HAS_RETURN: { status: 409, message: '返品のある発送は取り消せません。' },
  FULFILLMENT_EXCHANGE_ON_HOLD: { status: 409, message: '手数料のお支払いを待っている交換の品は送れません。' },
  ORDER_NOT_RETURNABLE: { status: 409, message: 'この注文は返品を作れません。' },
  // 段2（共通の約束 C-4 の管理画面の言葉）。管理画面の窓口からは出ない記号（お客様の申し込みだけで出る物）も、Record の型のために言葉を持つ
  RETURN_NOT_ELIGIBLE: { status: 409, message: '申し込めない品が含まれています。画面を開き直してください。' },
  RETURN_REQUESTS_CLOSED: { status: 409, message: '申し込みの受付がオフです。' },
  RETURN_PHOTO_INVALID: { status: 400, message: '写真を確かめてください。' },
  RETURN_CUSTOMER_NOTE_REQUIRED: { status: 400, message: '詳しい内容が必要です。' },
  RETURN_DECLINE_MESSAGE_REQUIRED: { status: 400, message: 'お客様へのメッセージを入れてください（1000字まで）。' },
  CANCEL_REQUEST_NOT_FOUND: { status: 404, message: 'キャンセルの申し込みが見つかりません。' },
  CANCEL_REQUEST_EXISTS: { status: 409, message: '申し込みを受け付けられませんでした。' },
  CANCEL_REQUEST_NOT_ELIGIBLE: { status: 409, message: '申し込みを受け付けられませんでした。' },
  CANCEL_REQUEST_QUANTITY_EXCEEDS: { status: 409, message: '申し込みを受け付けられませんでした。' },
  CANCEL_REQUEST_STATE_CONFLICT: { status: 409, message: 'キャンセルの申し込みの状態が変わりました。画面を開き直してください。' },
  CANCEL_REQUEST_RESOLUTION_INVALID: { status: 409, message: '返金・キャンセルの記録を確かめられませんでした。画面を開き直してください。' },
} as const satisfies Record<ReturnErrorCode, { status: 400 | 403 | 404 | 409; message: string }>;

export const RETURN_DISPLAY_STATUS_LABELS: Record<ReturnDisplayStatus, string> = {
  requested: '返品の申し込み',
  in_progress: '返品中',
  refund_waiting: '返金待ち',
  returned: '返品済み',
};

export const RETURN_MARK_LABELS: Record<ReturnMark, string> = {
  awaiting_items: '受け取り待ち',
  partially_received: '一部受け取り',
  pending_inspection: '検品待ち',
  awaiting_fee: 'お支払い待ち',
};

export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  defective: '破損・不良',
  wrong_item: '注文と違う品が届いた',
  size_too_small: 'サイズが小さい',
  size_too_large: 'サイズが大きい',
  color: '色がイメージと違った',
  style: 'デザインが好みでない',
  not_as_described: '説明と違った',
  unwanted: '不要になった',
  other: 'その他',
  unknown: '不明',
};

export const RETURN_CARRIER_LABELS: Record<ReturnCarrier, string> = {
  yamato: 'ヤマト運輸',
  sagawa: '佐川急便',
  japanpost: '日本郵便',
  other: 'その他',
};

/** 受け取りの画面の、品ごとの状態の選び方 */
export const DISPOSITION_LABELS: Record<ReceiptDisposition, string> = {
  restocked: '在庫に戻す',
  not_restocked: '戻さない',
  pending_inspection: '検品待ち',
  sent_back: '条件に合わないのでお返しする',
};

/** 返品・キャンセルの申し込みのお断りの理由（お店の中だけで使う。お客様には出さない。共通の約束 C-5） */
export const RETURN_DECLINE_REASON_LABELS: Record<ReturnDeclineReason, string> = {
  window_passed: '期間切れ',
  final_sale: '返品不可',
  other: 'その他',
};

/** お断りの理由を選んだ時に、お客様へのメッセージの欄に入れる最初の文（C-5。その他は空） */
export const RETURN_DECLINE_MESSAGE_PREFILL: Record<ReturnDeclineReason, string> = {
  window_passed: '受付の期限を過ぎているため、今回のお申し込みはお受けできませんでした。',
  final_sale: 'この商品は返品不可の商品のため、お客様のご都合による返品・交換はお受けできませんでした。',
  other: '',
};

/**
 * 理由を選び直した時のメッセージの欄。欄が空白だけか、前の理由の最初の文のままなら、新しい理由の最初の文にする。直した文は残す
 * （P8。返品とキャンセルの申し込みのお断りの画面が同じ部品を使う）
 */
export function prefillDeclineMessage(
  current: string,
  previousReason: ReturnDeclineReason | null,
  nextReason: ReturnDeclineReason,
): string {
  const untouched =
    current.trim() === '' || (previousReason !== null && current === RETURN_DECLINE_MESSAGE_PREFILL[previousReason]);
  return untouched ? RETURN_DECLINE_MESSAGE_PREFILL[nextReason] : current;
}

/** 返品の番号（画面・メール・履歴で同じ書き方）。例: ORD-A1B2C3D4-R1。DB は番号の文字を作らない */
export function formatReturnNumber(orderId: string, number: number): string {
  return `${toOrderNumber(orderId)}-R${number}`;
}
