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
  stock_quantity: number | null;
  status?: string | null;
};

export type InventoryIssue = {
  item_id: number;
  name: string;
  requestedQuantity: number;
  availableQuantity: number | null;
  reason: 'insufficient_stock' | 'unavailable';
};

export type FinalizeOrderRpcRow = {
  order_id: string;
  order_status: 'pending' | 'paid' | 'failed' | 'cancelled';
};

export function normalizeCartVariantValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

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

    if (!item || item.status === 'private') {
      issues.push({
        item_id: itemId,
        name: item?.name ?? `商品 ${itemId}`,
        requestedQuantity,
        availableQuantity: null,
        reason: 'unavailable',
      });
      continue;
    }

    if (item.stock_quantity !== null && requestedQuantity > item.stock_quantity) {
      issues.push({
        item_id: itemId,
        name: item.name,
        requestedQuantity,
        availableQuantity: item.stock_quantity,
        reason: 'insufficient_stock',
      });
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

export function parseFinalizeOrderRpcResult(data: unknown): FinalizeOrderRpcRow | null {
  if (Array.isArray(data)) {
    const firstRow = data[0];
    if (
      firstRow &&
      typeof firstRow === 'object' &&
      'order_id' in firstRow &&
      'order_status' in firstRow
    ) {
      return firstRow as FinalizeOrderRpcRow;
    }
  }

  if (
    data &&
    typeof data === 'object' &&
    'order_id' in data &&
    'order_status' in data
  ) {
    return data as FinalizeOrderRpcRow;
  }

  return null;
}

export function mapFinalizeOrderRpcError(message: string):
  | { status: number; body: { error: string; message: string } }
  | null {
  if (message.startsWith('EMPTY_CART')) {
    return {
      status: 400,
      body: {
        error: 'empty_cart',
        message: 'カートが空です。',
      },
    };
  }

  if (message.startsWith('INSUFFICIENT_STOCK')) {
    return {
      status: 409,
      body: {
        error: 'out_of_stock',
        message: '在庫が不足しているため、購入手続きを完了できませんでした。カート内容を確認してください。',
      },
    };
  }

  if (message.startsWith('CART_ITEM_UNAVAILABLE')) {
    return {
      status: 409,
      body: {
        error: 'out_of_stock',
        message: 'カート内の商品に現在購入できないものが含まれています。',
      },
    };
  }

  if (message.startsWith('ITEM_NOT_PUBLISHED')) {
    return {
      status: 409,
      body: {
        error: 'item_not_published',
        message: '非公開商品が含まれているため、購入手続きを完了できませんでした。',
      },
    };
  }

  if (message.startsWith('CHECKOUT_TOTAL_MISMATCH')) {
    return {
      status: 409,
      body: {
        error: 'checkout_total_mismatch',
        message: 'カート内容が更新されました。もう一度お試しください。',
      },
    };
  }

  if (message.startsWith('INVALID_CHECKOUT_DRAFT')) {
    return {
      status: 400,
      body: {
        error: 'invalid_checkout_draft',
        message: 'チェックアウト情報の有効期限が切れました。最初からやり直してください。',
      },
    };
  }

  if (message.startsWith('CHECKOUT_CURRENCY_MISMATCH')) {
    return {
      status: 400,
      body: {
        error: 'checkout_currency_mismatch',
        message: '決済通貨が一致しません。最初からやり直してください。',
      },
    };
  }

  if (message.startsWith('PAYMENT_REFERENCE_MISMATCH')) {
    return {
      status: 409,
      body: {
        error: 'payment_reference_mismatch',
        message: '決済参照が一致しません。最初からやり直してください。',
      },
    };
  }

  return null;
}