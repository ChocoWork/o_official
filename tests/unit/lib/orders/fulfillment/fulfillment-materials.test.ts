import type { SupabaseClient } from '@supabase/supabase-js';
import { loadFulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-materials';
import { LegacyFulfillmentDisabledError } from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';

/**
 * G-1 Task 14: 発送の画面の材料は旧の発送と一緒に止めた。引数の形（client, orderId）は残し、
 * 注文・要対応・商品の行・発送・配送の集計・返品の DB の読取を1回もせずに LegacyFulfillmentDisabledError を投げる。
 */
const mockListOrderReturns = jest.fn();
jest.mock('@/lib/orders/returns/return-store', () => ({
  listOrderReturns: (...args: unknown[]) => mockListOrderReturns(...args),
}));

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

function spyClient() {
  const from = jest.fn();
  const rpc = jest.fn();
  return { client: { from, rpc } as unknown as SupabaseClient, from, rpc };
}

describe('loadFulfillmentMaterials（G-1 で停止）', () => {
  it.each([ORDER_ID, ORDER_ID.toUpperCase(), 'not-a-uuid', ''])('注文の番号 %j でも DB を読まずに LEGACY_FULFILLMENT_DISABLED を投げる', async (orderId) => {
    const { client, from, rpc } = spyClient();

    const error: unknown = await loadFulfillmentMaterials(client, orderId).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LegacyFulfillmentDisabledError);
    expect(error).toMatchObject({ code: 'LEGACY_FULFILLMENT_DISABLED', sqlstate: '55000', message: 'LEGACY_FULFILLMENT_DISABLED' });
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(mockListOrderReturns).not.toHaveBeenCalled();
  });

  it('null を返さない（「注文が無い」の 404 に落ちない）', async () => {
    const { client } = spyClient();
    await expect(loadFulfillmentMaterials(client, ORDER_ID)).rejects.toBeInstanceOf(LegacyFulfillmentDisabledError);
  });
});
