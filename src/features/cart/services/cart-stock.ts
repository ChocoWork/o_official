import { z } from 'zod';

export const MAX_CART_ITEM_QUANTITY = 20;
const CART_VARIANT_PATTERN = /^[\p{L}\p{N}\s\-_/().]+$/u;

const cartVariantSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(CART_VARIANT_PATTERN)
  .optional()
  .nullable();

export const addCartItemSchema = z.object({
  item_id: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive().max(MAX_CART_ITEM_QUANTITY).default(1),
  color: cartVariantSchema,
  size: cartVariantSchema,
});

export const updateCartQuantitySchema = z.object({
  quantity: z.coerce.number().int().positive().max(MAX_CART_ITEM_QUANTITY),
});

export type CartQuantityRow = {
  item_id: number;
  quantity: number;
};

export type InventoryItem = {
  id: number;
  name: string;
  status?: string | null;
};

export type InventoryIssue = {
  item_id: number;
  name: string;
  requestedQuantity: number;
  availableQuantity: number | null;
  reason: 'insufficient_stock' | 'unavailable';
};

export function normalizeCartVariantValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 買えない商品（非公開・存在しない）だけを挙げる（FREQ-401）。
 *
 * 在庫不足では挙げない。在庫の有無は納期を分けるだけで、足りなければ受注生産として受ける。
 * 在庫の正は item_variants と在庫台帳で、商品単位の在庫数はもう無い。
 */
export function collectInventoryIssues(
  cartRows: CartQuantityRow[],
  inventoryItems: InventoryItem[]
): InventoryIssue[] {
  const requestedQuantities = new Map<number, number>();
  for (const cartRow of cartRows) {
    requestedQuantities.set(
      cartRow.item_id,
      (requestedQuantities.get(cartRow.item_id) ?? 0) + cartRow.quantity
    );
  }

  const inventoryItemMap = new Map<number, InventoryItem>(
    inventoryItems.map((item) => [item.id, item])
  );

  const issues: InventoryIssue[] = [];
  for (const [itemId, requestedQuantity] of requestedQuantities.entries()) {
    const item = inventoryItemMap.get(itemId);

    if (!item || item.status !== 'published') {
      issues.push({
        item_id: itemId,
        name: item?.name ?? `商品 ${itemId}`,
        requestedQuantity,
        availableQuantity: null,
        reason: 'unavailable',
      });
      continue;
    }
  }

  return issues;
}

export function buildInventoryConflictBody(
  issues: InventoryIssue[],
  errorCode: string
): {
  error: string;
  message: string;
  items: Array<{
    item_id: number;
    name: string;
    requestedQuantity: number;
    availableQuantity: number | null;
    reason: 'insufficient_stock' | 'unavailable';
  }>;
} {
  const unavailableItems = issues.filter((issue) => issue.reason === 'unavailable');
  if (unavailableItems.length > 0) {
    return {
      error: errorCode,
      message: `以下の商品は現在購入できません: ${unavailableItems
        .map((issue) => issue.name)
        .join('、')}`,
      items: unavailableItems,
    };
  }

  return {
    error: errorCode,
    message: `以下の商品の在庫が不足しています: ${issues
      .map(
        (issue) =>
          `${issue.name}（要求 ${issue.requestedQuantity} / 在庫 ${issue.availableQuantity ?? 0}）`
      )
      .join('、')}`,
    items: issues,
  };
}
