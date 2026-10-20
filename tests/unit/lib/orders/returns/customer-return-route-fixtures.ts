import type { CustomerReturnErrorCode } from '@/lib/orders/returns/customer-return-messages';

/**
 * お客様の窓口の試験が共有する見本（グループ E-3 段2 Task 7）。番号は zod の uuid() が通る形（版 4・変種 8）。
 * 誤りの言葉は計画の冒頭 C-4 の「お客様の言葉」の列を一字ずつ書き写した物で、
 * 窓口の表（CUSTOMER_RETURN_ERROR_MESSAGES）と食い違えば試験が落ちる。
 */
export const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
/** ログインしたお客様の番号（トークンの claims.sub） */
export const CUSTOMER_ID = '0c0c0c0c-1111-4222-8333-444455556666';
export const REQUEST_KEY = 'b1b2c3d4-1111-4222-8333-444455556666';
export const FULFILLMENT_ID = 'a2b2c3d4-1111-4222-8333-444455556666';
export const ORDER_ITEM_ID = 'd1b2c3d4-1111-4222-8333-444455556661';
export const ORDER_ITEM_ID_2 = 'd1b2c3d4-1111-4222-8333-444455556662';
export const RETURN_ID = 'e1b2c3d4-1111-4222-8333-444455556666';
export const CANCEL_REQUEST_ID = 'c2b2c3d4-1111-4222-8333-444455556666';
export const UPLOAD_ID = '9a9a9a9a-1111-4222-8333-444455556661';
export const UPLOAD_ID_2 = '9a9a9a9a-1111-4222-8333-444455556662';

export const HEADERS = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'user-agent': 'jest' };

/** 想定外の失敗（500）のお客様の言葉（C-4 の下の欄） */
export const FAILURE_MESSAGE = 'お申し込みを受け付けられませんでした。時間をおいて、もう一度お試しください。';

/** 計画の冒頭 C-4 のお客様の言葉がある12個（記号・HTTP・言葉） */
export const CUSTOMER_C4_CASES: Array<[CustomerReturnErrorCode, number, string]> = [
  ['RETURN_NOT_ELIGIBLE', 409, 'お申し込みいただけない商品が含まれています。画面を開き直してください。'],
  ['RETURN_REQUESTS_CLOSED', 409, '現在、返品・交換のお申し込みを受け付けていません。'],
  ['RETURN_PHOTO_INVALID', 400, '写真を確かめてください（JPEG・PNG、1枚10MBまで、1つの商品に5枚まで）。'],
  ['RETURN_CUSTOMER_NOTE_REQUIRED', 400, '「破損・不良」「その他」の時は、詳しい内容を入れてください（300字まで）。'],
  ['RETURN_QUANTITY_EXCEEDS', 409, 'お申し込みいただける数を超えています。画面を開き直してください。'],
  ['RETURN_REQUEST_MISMATCH', 409, 'お申し込みの内容が変わりました。画面を開き直してください。'],
  ['RETURN_EXCHANGE_VARIANT_INVALID', 400, '交換する色・サイズを選び直してください。'],
  ['RETURN_ARGUMENT_INVALID', 400, '入力を確かめてください。'],
  ['ORDER_NOT_RETURNABLE', 409, 'この注文は、返品・交換のお申し込みを受け付けていません。'],
  ['CANCEL_REQUEST_EXISTS', 409, 'キャンセルのお申し込みは、すでに受け付けています。'],
  ['CANCEL_REQUEST_NOT_ELIGIBLE', 409, 'この注文は、キャンセルのお申し込みを受け付けていません。'],
  ['CANCEL_REQUEST_QUANTITY_EXCEEDS', 409, 'お申し込みいただける数を超えています。画面を開き直してください。'],
];

/** 実物の maskAuditEvent を通しても、監査の鍵が [REDACTED] にならないこと（number・card・pan・token などを含む鍵は伏せられてしまう） */
export function expectNoKeyIsRedacted(metadata: Record<string, unknown>): void {
  const { maskAuditEvent } = jest.requireActual('@/lib/audit');
  expect(maskAuditEvent({ action: 'x', outcome: 'success', metadata }).metadata).toEqual(metadata);
}
