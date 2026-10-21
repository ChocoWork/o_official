import type {
  DeliveryAttentionKind,
  DeliveryErrorCode,
  DeliveryStatus,
  TrackingState,
} from '@/lib/orders/tracking/delivery-types';

export const DELIVERY_ERROR_MESSAGES: Record<DeliveryErrorCode, { status: 400 | 404 | 409; message: string }> = {
  ORDER_NOT_FOUND: { status: 404, message: '注文が見つかりません。' },
  FULFILLMENT_NOT_FOUND: { status: 404, message: '発送の記録が見つかりません。' },
  DELIVERY_ARGUMENT_INVALID: { status: 400, message: '入力を確かめてください。' },
  DELIVERY_REQUEST_MISMATCH: { status: 409, message: '操作の内容が変わりました。画面を開き直してください。' },
  DELIVERY_FULFILLMENT_CANCELLED: { status: 409, message: '取り消した発送は変更できません。' },
  DELIVERY_TRACKING_UNCHANGED: { status: 409, message: '配送業者か伝票番号を直してください。' },
  DELIVERY_ALREADY_DELIVERED: { status: 409, message: 'すでに配達済みです。履歴を読み直してください。' },
  DELIVERY_DATE_INVALID: { status: 400, message: '届いた日は、発送の日から今日までの日を選んでください。' },
  DELIVERY_TRACKING_KEY_MISSING: { status: 409, message: '17TRACK の鍵を設定してください。' },
  DELIVERY_ATTENTION_NOT_FOUND: { status: 404, message: '配送の要対応が見つかりません。' },
};

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  confirmed: '受付済み', in_transit: '輸送中', out_for_delivery: '配達中', attempted_delivery: '不在で持ち帰り',
  ready_for_pickup: '受け取り待ち', delivered: '配達済み', delayed: '遅れ', failure: '問題あり',
};

export const DELIVERY_ATTENTION_LABELS: Record<DeliveryAttentionKind, string> = {
  delivery_failure: '問題あり', attempted_delivery: '不在で持ち帰り', tracking_not_found: '伝票番号で荷物が見つからない',
  tracking_registration_failed: '追跡の登録ができない', tracking_stalled: '配達済みにならない',
};

export const TRACKING_STATE_LABELS: Record<TrackingState, string> = {
  pending: '登録待ち', registered: '追跡中', stopped: '止めた', failed: '登録できない',
};
