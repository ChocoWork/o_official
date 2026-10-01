const mockExpireOpenCheckoutSession = jest.fn();
jest.mock('@/lib/stripe/checkout-session-expiry', () => ({
  expireOpenCheckoutSession: (...args: unknown[]) => mockExpireOpenCheckoutSession(...args),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import {
  describeDeleteBlockers,
  expireOpenCheckoutsForItem,
  fetchItemDeleteBlockers,
  isItemDeletable,
} from '@/lib/items/item-checkout-guards';
import { buildItemDeleteGuidance } from '@/lib/items/item-delete-guidance';

function clientWith(rpc: jest.Mock) {
  return { rpc } as unknown as SupabaseClient;
}

const stripe = {} as Stripe;

describe('item-checkout-guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('削除できない理由を商品 ID ごとに読む', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [{ item_id: '7', has_orders: true, has_stock_movements: false, has_open_checkouts: true }],
      error: null,
    });

    const result = await fetchItemDeleteBlockers(clientWith(rpc), [7]);

    expect(rpc).toHaveBeenCalledWith('item_delete_blockers', { _item_ids: [7] });
    expect(result.get(7)).toEqual({ hasOrders: true, hasStockMovements: false, hasOpenCheckouts: true });
    expect(describeDeleteBlockers(result.get(7)!)).toEqual(['注文がある', '決済中のお客様がいる']);
  });

  it('理由が無い商品だけを削除できる。読めなかった商品は削除できない扱いにする', () => {
    expect(isItemDeletable({ hasOrders: false, hasStockMovements: false, hasOpenCheckouts: false })).toBe(true);
    expect(isItemDeletable({ hasOrders: false, hasStockMovements: true, hasOpenCheckouts: false })).toBe(false);
    expect(isItemDeletable(undefined)).toBe(false);
  });

  it('非公開を促す案内の文にする', () => {
    expect(buildItemDeleteGuidance(['注文がある'])).toBe(
      'この商品は削除できません（注文がある）。非公開にすると、お客様の画面から見えなくなります。',
    );
  });

  it('商品を含む開いている決済を失効させ、失敗しても残りを続ける', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const rpc = jest.fn().mockResolvedValue({
      data: [{ checkout_session_id: 'cs_1' }, { checkout_session_id: 'cs_2' }, { checkout_session_id: 'cs_3' }],
      error: null,
    });
    mockExpireOpenCheckoutSession
      .mockResolvedValueOnce('expired')
      .mockRejectedValueOnce(new Error('stripe down'))
      .mockResolvedValueOnce('not_open');

    const result = await expireOpenCheckoutsForItem({ client: clientWith(rpc), stripe, itemId: 7 });

    expect(rpc).toHaveBeenCalledWith('find_open_checkout_sessions_for_item', { _item_id: 7 });
    expect(mockExpireOpenCheckoutSession).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ expired: 1, failed: 1 });
    expect(consoleError).toHaveBeenCalledWith('[items] failed to expire checkout session', 'cs_2', expect.any(Error));
    consoleError.mockRestore();
  });
});
