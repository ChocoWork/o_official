import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { expireOpenCheckoutSession } from '@/lib/stripe/checkout-session-expiry';

export type ItemDeleteBlockers = {
  hasOrders: boolean;
  hasStockMovements: boolean;
  hasOpenCheckouts: boolean;
};

type BlockerRow = {
  item_id: number | string;
  has_orders: boolean;
  has_stock_movements: boolean;
  has_open_checkouts: boolean;
};

/** 削除できない理由を商品 ID ごとに読む（R-44） */
export async function fetchItemDeleteBlockers(
  client: SupabaseClient,
  itemIds: number[],
): Promise<Map<number, ItemDeleteBlockers>> {
  if (itemIds.length === 0) {
    return new Map();
  }

  const { data, error } = await client.rpc('item_delete_blockers', { _item_ids: itemIds });
  if (error) {
    throw error;
  }

  return new Map(
    ((data ?? []) as BlockerRow[]).map((row) => [
      Number(row.item_id),
      {
        hasOrders: row.has_orders,
        hasStockMovements: row.has_stock_movements,
        hasOpenCheckouts: row.has_open_checkouts,
      },
    ]),
  );
}

/** 理由が1つも無い商品だけ削除できる。読めなかった商品は削除できない扱いにする */
export function isItemDeletable(blockers: ItemDeleteBlockers | undefined): boolean {
  return Boolean(blockers) && !blockers!.hasOrders && !blockers!.hasStockMovements && !blockers!.hasOpenCheckouts;
}

export function describeDeleteBlockers(blockers: ItemDeleteBlockers): string[] {
  return [
    blockers.hasOrders ? '注文がある' : null,
    blockers.hasStockMovements ? '在庫の記録がある' : null,
    blockers.hasOpenCheckouts ? '決済中のお客様がいる' : null,
  ].filter((reason): reason is string => reason !== null);
}

/**
 * ① 非公開・削除にした商品を含む、開いている決済を失効させる（設計書 4-6）。
 * 失敗しても商品の変更は止めない（受付 RPC が非公開の商品を断る）。失効させた数と失敗の数を返す。
 */
export async function expireOpenCheckoutsForItem(params: {
  client: SupabaseClient;
  stripe: Stripe;
  itemId: number;
}): Promise<{ expired: number; failed: number }> {
  const { data, error } = await params.client.rpc('find_open_checkout_sessions_for_item', { _item_id: params.itemId });
  if (error) {
    console.error('[items] failed to find open checkout sessions for item', params.itemId, error);
    return { expired: 0, failed: 1 };
  }

  let expired = 0;
  let failed = 0;
  for (const row of (data ?? []) as Array<{ checkout_session_id: string }>) {
    try {
      if ((await expireOpenCheckoutSession(params.stripe, row.checkout_session_id)) === 'expired') {
        expired += 1;
      }
    } catch (expireError) {
      console.error('[items] failed to expire checkout session', row.checkout_session_id, expireError);
      failed += 1;
    }
  }

  return { expired, failed };
}
