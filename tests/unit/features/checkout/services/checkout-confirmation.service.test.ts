import type { SupabaseClient } from '@supabase/supabase-js';

const mockPreviewFulfillment = jest.fn();
jest.mock('@/features/checkout/services/checkout-fulfillment.service', () => ({
  previewFulfillment: (...args: unknown[]) => mockPreviewFulfillment(...args),
}));

import { buildCheckoutConfirmation } from '@/features/checkout/services/checkout-confirmation.service';
import type { CheckoutDraftItemSnapshot } from '@/features/checkout/services/checkout-draft.service';

const ITEMS: CheckoutDraftItemSnapshot[] = [
  {
    source_cart_id: 'cart-1',
    item_id: 1,
    item_name: 'シャツ',
    item_price: 12000,
    item_image_url: 'items/1.png',
    color: 'BLACK',
    size: 'M',
    quantity: 2,
    line_total: 24000,
  },
  {
    source_cart_id: 'cart-2',
    item_id: 2,
    item_name: 'パンツ',
    item_price: 18000,
    item_image_url: null,
    color: null,
    size: null,
    quantity: 1,
    line_total: 18000,
  },
];

const SHIPPING = {
  email: 'a@example.com',
  fullName: '山田 花子',
  kanaName: 'ヤマダ ハナコ',
  postalCode: '1500001',
  prefecture: '東京都',
  city: '渋谷区',
  address: '神宮前1-1-1',
  building: null,
  phone: '0311112222',
};

function orderItemsClient(rows: unknown[]) {
  const eq = jest.fn().mockResolvedValue({ data: rows, error: null });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });
  return { client: { from } as unknown as SupabaseClient, from, select, eq };
}

const signImageUrl = jest.fn(async (raw: string | null) => (raw ? `https://signed.example/${raw}` : null));

describe('buildCheckoutConfirmation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('受け付け前は、下書きの写しをその時点の在庫で目安づけし、画像に署名して返す', async () => {
    const { client, from } = orderItemsClient([]);
    mockPreviewFulfillment.mockResolvedValue([
      { lineNo: 1, itemId: 1, color: 'BLACK', size: 'M', quantity: 2, variantId: 11, fulfillment: 'stock' },
      { lineNo: 2, itemId: 2, color: null, size: null, quantity: 1, variantId: 22, fulfillment: 'backorder' },
    ]);

    const confirmation = await buildCheckoutConfirmation(
      { supabase: client, signImageUrl },
      {
        checkoutSessionId: 'cs_test_1',
        clientSecret: 'cs_test_1_secret',
        itemsSnapshot: ITEMS,
        shippingSnapshot: SHIPPING,
        promotionCode: 'WELCOME10',
        acceptedOrderId: null,
      },
    );

    expect(mockPreviewFulfillment).toHaveBeenCalledWith(client, [
      { item_id: 1, color: 'BLACK', size: 'M', quantity: 2 },
      { item_id: 2, color: null, size: null, quantity: 1 },
    ]);
    expect(from).not.toHaveBeenCalled();
    expect(confirmation).toEqual({
      checkoutSessionId: 'cs_test_1',
      clientSecret: 'cs_test_1_secret',
      shipping: SHIPPING,
      promotionCode: 'WELCOME10',
      lines: [
        {
          itemId: 1,
          name: 'シャツ',
          price: 12000,
          imageUrl: 'https://signed.example/items/1.png',
          color: 'BLACK',
          size: 'M',
          quantity: 2,
          variantId: 11,
          fulfillment: 'stock',
        },
        {
          itemId: 2,
          name: 'パンツ',
          price: 18000,
          imageUrl: null,
          color: null,
          size: null,
          quantity: 1,
          variantId: 22,
          fulfillment: 'backorder',
        },
      ],
    });
  });

  test('受け付け済みなら、確保した結果（注文の明細）で目安づけし、在庫を読み直さない', async () => {
    const { client, from, select, eq } = orderItemsClient([
      { item_id: 2, color: null, size: null, variant_id: 22, fulfillment_type: 'stock' },
      { item_id: 1, color: 'BLACK', size: 'M', variant_id: 11, fulfillment_type: 'backorder' },
    ]);

    const confirmation = await buildCheckoutConfirmation(
      { supabase: client, signImageUrl },
      {
        checkoutSessionId: 'cs_test_1',
        clientSecret: 'cs_test_1_secret',
        itemsSnapshot: ITEMS,
        shippingSnapshot: SHIPPING,
        promotionCode: null,
        acceptedOrderId: 'order-1',
      },
    );

    expect(mockPreviewFulfillment).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledWith('order_items');
    expect(select).toHaveBeenCalledWith('item_id, color, size, variant_id, fulfillment_type');
    expect(eq).toHaveBeenCalledWith('order_id', 'order-1');
    expect(confirmation.lines.map((line) => [line.itemId, line.variantId, line.fulfillment])).toEqual([
      [1, 11, 'backorder'],
      [2, 22, 'stock'],
    ]);
  });

  test('目安の分からない明細は受注生産、配送先が無ければ空の配送先にする', async () => {
    const { client } = orderItemsClient([]);
    mockPreviewFulfillment.mockResolvedValue([]);

    const confirmation = await buildCheckoutConfirmation(
      { supabase: client, signImageUrl },
      {
        checkoutSessionId: 'cs_test_1',
        clientSecret: 'secret',
        itemsSnapshot: [ITEMS[0]],
        shippingSnapshot: null,
        promotionCode: null,
        acceptedOrderId: null,
      },
    );

    expect(confirmation.lines[0]).toMatchObject({ variantId: null, fulfillment: 'backorder' });
    expect(confirmation.shipping).toEqual({
      email: null,
      fullName: null,
      kanaName: null,
      postalCode: null,
      prefecture: null,
      city: null,
      address: null,
      building: null,
      phone: null,
    });
  });

  test('注文の明細を読めなければ投げる', async () => {
    const eq = jest.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });
    const client = { from: () => ({ select: () => ({ eq }) }) } as unknown as SupabaseClient;

    await expect(
      buildCheckoutConfirmation(
        { supabase: client, signImageUrl },
        {
          checkoutSessionId: 'cs',
          clientSecret: 's',
          itemsSnapshot: ITEMS,
          shippingSnapshot: SHIPPING,
          promotionCode: null,
          acceptedOrderId: 'order-1',
        },
      ),
    ).rejects.toEqual({ message: 'boom' });
  });
});
