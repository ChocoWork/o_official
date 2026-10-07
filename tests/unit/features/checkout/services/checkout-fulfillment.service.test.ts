import { previewFulfillment } from '@/features/checkout/services/checkout-fulfillment.service';
import {
  CART_FULFILLMENT_LABELS,
  FINAL_FULFILLMENT_LABELS,
  FULFILLMENT_HEADINGS,
} from '@/features/checkout/utils/fulfillment-labels';

describe('previewFulfillment', () => {
  test('明細を関数に渡し、行を画面で使う形にそろえる（数は number、バリアントが無ければ null）', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [
        { line_no: 1, item_id: '10', color: 'BLACK', size: 'M', quantity: 2, variant_id: '55', fulfillment: 'stock' },
        { line_no: 2, item_id: '11', color: null, size: null, quantity: 1, variant_id: null, fulfillment: 'backorder' },
      ],
      error: null,
    });

    const lines = await previewFulfillment({ rpc }, [
      { item_id: 10, color: 'BLACK', size: 'M', quantity: 2 },
      { item_id: 11, color: null, size: null, quantity: 1 },
    ]);

    expect(rpc).toHaveBeenCalledWith('preview_checkout_fulfillment', {
      _items_snapshot: [
        { item_id: 10, color: 'BLACK', size: 'M', quantity: 2 },
        { item_id: 11, color: null, size: null, quantity: 1 },
      ],
    });
    expect(lines).toEqual([
      { lineNo: 1, itemId: 10, color: 'BLACK', size: 'M', quantity: 2, variantId: 55, fulfillment: 'stock' },
      { lineNo: 2, itemId: 11, color: null, size: null, quantity: 1, variantId: null, fulfillment: 'backorder' },
    ]);
  });

  test('知らない値は受注生産として扱う（在庫ありと誤って見せない）', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [{ line_no: 1, item_id: 10, color: null, size: null, quantity: 1, variant_id: 5, fulfillment: 'unknown' }],
      error: null,
    });

    const lines = await previewFulfillment({ rpc }, [{ item_id: 10, color: null, size: null, quantity: 1 }]);

    expect(lines[0].fulfillment).toBe('backorder');
  });

  test('明細が無ければ DB を呼ばない', async () => {
    const rpc = jest.fn();

    await expect(previewFulfillment({ rpc }, [])).resolves.toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('DB の失敗は投げる', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });

    await expect(
      previewFulfillment({ rpc }, [{ item_id: 10, color: null, size: null, quantity: 1 }]),
    ).rejects.toEqual({ message: 'boom' });
  });
});

describe('お届けの目安の文言（設計書 5-2・第4章）', () => {
  test('カートと最終確認画面の文言', () => {
    expect(CART_FULFILLMENT_LABELS).toEqual({
      stock: '在庫あり・3〜7営業日で発送',
      backorder: '受注生産・数週間〜2か月以上',
    });
    expect(FULFILLMENT_HEADINGS).toEqual({ stock: '在庫あり', backorder: '受注生産' });
    expect(FINAL_FULFILLMENT_LABELS).toEqual({
      stock: 'ご注文（コンビニはご入金）の確認後、3〜7営業日で発送',
      backorder: '発送まで数週間〜2か月以上（目安）',
    });
  });
});
