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

export type CartQuantityRow = {
  item_id: number;
  quantity: number;
  /** 取り扱いを終えたバリアントの行は false。商品が公開中でも買えない（本計画の決め事 P14） */
  variant_active?: boolean;
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

/**
 * 買えない商品（非公開・存在しない・取り扱いを終えた色・サイズ）だけを挙げる（FREQ-401）。
 *
 * 在庫不足では挙げない。在庫の有無は納期を分けるだけで、足りなければ受注生産として受ける。
 * 在庫の正は item_variants と在庫台帳で、商品単位の在庫数はもう無い。
 */
export function collectInventoryIssues(
  cartRows: CartQuantityRow[],
  inventoryItems: InventoryItem[]
): InventoryIssue[] {
  const requestedQuantities = new Map<number, number>();
  const inactiveItemIds = new Set<number>();
  for (const cartRow of cartRows) {
    requestedQuantities.set(
      cartRow.item_id,
      (requestedQuantities.get(cartRow.item_id) ?? 0) + cartRow.quantity
    );
    if (cartRow.variant_active === false) {
      inactiveItemIds.add(cartRow.item_id);
    }
  }

  const inventoryItemMap = new Map<number, InventoryItem>(
    inventoryItems.map((item) => [item.id, item])
  );

  const issues: InventoryIssue[] = [];
  for (const [itemId, requestedQuantity] of requestedQuantities.entries()) {
    const item = inventoryItemMap.get(itemId);

    if (!item || item.status !== 'published' || inactiveItemIds.has(itemId)) {
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
