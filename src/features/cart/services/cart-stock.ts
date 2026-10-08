import { z } from 'zod';

export const MAX_CART_ITEM_QUANTITY = 20;
export const MAX_CART_LINES = 50;

/** Shopify と同じくバリアントの番号と数量で足すため、色・サイズの文字列は受け取らない。 */
export const addCartLinesSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            quantity: z.number().int().min(1).max(MAX_CART_ITEM_QUANTITY),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();

/** 明細の key で変更し、数量0も削除として受け付けるため、追加とは検証を分ける。 */
export const changeCartLineSchema = z
  .object({
    id: z.string().uuid(),
    quantity: z.number().int().min(0).max(MAX_CART_ITEM_QUANTITY),
  })
  .strict();
