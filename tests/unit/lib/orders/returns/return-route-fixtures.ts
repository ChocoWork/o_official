import type { RefundErrorCode } from '@/lib/orders/refund/refund-types';
import type { ReturnErrorCode } from '@/lib/orders/returns/return-types';

/**
 * 返品の窓口の試験が共有する見本（グループ E-3 Task 7）。番号は zod の uuid() が通る形（版 4・変種 8）。
 * 誤りの言葉は計画の冒頭 C-4 と E-2 の refund-messages.ts の文を一字ずつ書き写した物で、
 * 窓口の表（RETURN_ERROR_MESSAGES・REFUND_ERROR_MESSAGES）と食い違えば試験が落ちる。
 */
export const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
export const REQUEST_KEY = 'b1b2c3d4-1111-4222-8333-444455556666';
export const REFUND_ID = 'c1b2c3d4-1111-4222-8333-444455556666';
export const ITEM_ID = 'd1b2c3d4-1111-4222-8333-444455556661';
export const ITEM_ID_2 = 'd1b2c3d4-1111-4222-8333-444455556662';
export const RETURN_ID = 'e1b2c3d4-1111-4222-8333-444455556666';
export const RECEIPT_ID = 'f1b2c3d4-1111-4222-8333-444455556666';
export const FULFILLMENT_ID = 'a2b2c3d4-1111-4222-8333-444455556666';
export const LINE_ID = 'a3b2c3d4-1111-4222-8333-444455556661';
export const LINE_ID_2 = 'a3b2c3d4-1111-4222-8333-444455556662';

export const HEADERS = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'user-agent': 'jest' };

export const UNKNOWN_MESSAGE = '返金の結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

/** 共通の約束 C-4 の管理画面の言葉の表（記号・HTTP・言葉）。段1の18個と段2の11個の、29個すべて */
export const C4_CASES: Array<[ReturnErrorCode, number, string]> = [
  ['RETURN_NOT_FOUND', 404, '返品が見つかりません。'],
  ['RETURN_ARGUMENT_INVALID', 400, '入力を確かめてください。'],
  ['RETURN_QUANTITY_EXCEEDS', 409, '返品できる数を超えています。画面を開き直してください。'],
  ['RETURN_EXCHANGE_VARIANT_INVALID', 400, '交換の色・サイズを選び直してください（同じ商品の色・サイズだけ選べます）。'],
  ['RETURN_ADDRESS_REQUIRED', 409, '返送先が設定されていません。ショップの設定で返送先を入れてから作ってください。'],
  ['RETURN_STATE_CONFLICT', 409, '返品の状態が変わりました。画面を開き直してください。'],
  ['RETURN_RECEIPT_EXCEEDS', 409, '受け取る数が、残りの数を超えています。画面を開き直してください。'],
  ['RETURN_EXCHANGE_OUT_OF_STOCK', 409, '交換の品の在庫が足りません。「作って送る」か「返金に変える」を選んでください。'],
  ['RETURN_FORBIDDEN', 403, 'この操作は店長だけができます。'],
  ['RETURN_REQUEST_MISMATCH', 409, '同じ操作の番号で、違う内容が送られました。画面を開き直してください。'],
  ['RETURN_REASON_NOTE_REQUIRED', 400, '理由が「その他」の時は、理由のメモを入れてください。'],
  ['RETURN_SENT_BACK_MESSAGE_REQUIRED', 400, 'お返しする時は、お客様へのメッセージを入れてください。'],
  ['RETURN_FEE_INVALID', 400, '手数料の額を確かめてください。'],
  ['RETURN_REFUND_AMOUNT_INVALID', 400, '返金額は、返せる額までにしてください。'],
  ['RETURN_NOTHING_TO_REFUND', 409, '返金する品がありません。画面を開き直してください。'],
  ['FULFILLMENT_HAS_RETURN', 409, '返品のある発送は取り消せません。'],
  ['FULFILLMENT_EXCHANGE_ON_HOLD', 409, '手数料のお支払いを待っている交換の品は送れません。'],
  ['ORDER_NOT_RETURNABLE', 409, 'この注文は返品を作れません。'],
  ['RETURN_NOT_ELIGIBLE', 409, '申し込めない品が含まれています。画面を開き直してください。'],
  ['RETURN_REQUESTS_CLOSED', 409, '申し込みの受付がオフです。'],
  ['RETURN_PHOTO_INVALID', 400, '写真を確かめてください。'],
  ['RETURN_CUSTOMER_NOTE_REQUIRED', 400, '詳しい内容が必要です。'],
  ['RETURN_DECLINE_MESSAGE_REQUIRED', 400, 'お客様へのメッセージを入れてください（1000字まで）。'],
  ['CANCEL_REQUEST_NOT_FOUND', 404, 'キャンセルの申し込みが見つかりません。'],
  ['CANCEL_REQUEST_EXISTS', 409, '申し込みを受け付けられませんでした。'],
  ['CANCEL_REQUEST_NOT_ELIGIBLE', 409, '申し込みを受け付けられませんでした。'],
  ['CANCEL_REQUEST_QUANTITY_EXCEEDS', 409, '申し込みを受け付けられませんでした。'],
  ['CANCEL_REQUEST_STATE_CONFLICT', 409, 'キャンセルの申し込みの状態が変わりました。画面を開き直してください。'],
  ['CANCEL_REQUEST_RESOLUTION_INVALID', 409, '返金・キャンセルの記録を確かめられませんでした。画面を開き直してください。'],
];

/** E-2 の返金の誤り（refund-messages.ts の言葉と HTTP。返品の窓口もそのまま返す）。13個すべて */
export const E2_CASES: Array<[RefundErrorCode, number, string]> = [
  ['order_not_found', 404, '注文が見つかりません。'],
  ['order_not_refundable', 409, 'この注文は返金できません。'],
  ['order_not_cancellable', 409, '発送した商品がある注文はキャンセルできません。返金の画面を使ってください。'],
  ['awaiting_refund_exists', 409, '確かめ中の返金があります。先に確かめてください。'],
  ['refund_request_mismatch', 409, '画面を開き直してから、もう一度返金してください。'],
  ['refund_line_not_in_order', 409, '返金できる数を超えています。画面を開き直してください。'],
  ['quantity_exceeds_unshipped', 409, '返金できる数を超えています。画面を開き直してください。'],
  ['quantity_exceeds_shipped', 409, '返金できる数を超えています。画面を開き直してください。'],
  ['shipping_exceeds', 409, '返せる送料を超えています。'],
  ['exceeds_refundable', 409, '返せる額を超えています。'],
  ['must_include_unshipped', 409, '全額を返金する時は、まだ発送していない商品もすべて選んでください。'],
  ['must_be_full', 409, 'まだ発送していない注文の商品を全部返す時は、送料と返金額も全部返してください。'],
  ['invalid_argument', 400, '入力を確かめてください。'],
];
