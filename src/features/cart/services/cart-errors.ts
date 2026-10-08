import { NextResponse } from 'next/server';

export const CART_ERROR_DESCRIPTIONS = {
  quantityLimit: '1つの商品は20個までです。',
  lineLimit: 'カートに入れられるのは50種類までです。',
  variantUnavailable: '選んだ色・サイズは現在お求めいただけません。',
  lineNotFound: 'カートの商品が見つかりません。ページを読み込み直してください。',
  invalidRequest: '送った内容を確認できませんでした。',
  failed: 'カートを更新できませんでした。時間をおいてもう一度お試しください。',
} as const;

/** Shopify の Ajax Cart API と同じ断りの形（設計書 6-1） */
export function cartErrorResponse(status: 400 | 404 | 422 | 500, description: string): NextResponse {
  return NextResponse.json({ status, message: 'Cart Error', description }, { status });
}

/** DB の関数の断り（RAISE EXCEPTION の文）を窓口の断りに直す。知らない失敗は null（呼び出し側が 500 にする） */
export function cartRpcErrorResponse(message: string): NextResponse | null {
  if (message.startsWith('CART_LINE_QUANTITY_LIMIT')) return cartErrorResponse(422, CART_ERROR_DESCRIPTIONS.quantityLimit);
  if (message.startsWith('CART_LINE_LIMIT')) return cartErrorResponse(422, CART_ERROR_DESCRIPTIONS.lineLimit);
  if (message.startsWith('CART_VARIANT_UNAVAILABLE')) return cartErrorResponse(404, CART_ERROR_DESCRIPTIONS.variantUnavailable);
  if (message.startsWith('CART_LINE_NOT_FOUND')) return cartErrorResponse(404, CART_ERROR_DESCRIPTIONS.lineNotFound);
  if (message.startsWith('CART_INVALID_INPUT')) return cartErrorResponse(400, CART_ERROR_DESCRIPTIONS.invalidRequest);
  return null;
}
