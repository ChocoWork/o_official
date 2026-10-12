import { toOrderNumber } from '@/lib/orders/order-number';
import type {
  ReceiptDisposition,
  ReturnCarrier,
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

/** 返品の番号（画面・メール・履歴で同じ書き方）。例: ORD-A1B2C3D4-R1。DB は番号の文字を作らない */
export function formatReturnNumber(orderId: string, number: number): string {
  return `${toOrderNumber(orderId)}-R${number}`;
}
