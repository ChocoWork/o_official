import fs from 'node:fs';
import path from 'node:path';
import {
  FULFILLMENT_ERROR_CODES,
  initialShipQuantities,
  totalQuantity,
  type FulfillmentMaterialLine,
} from '@/lib/orders/fulfillment/fulfillment-types';

function materialLine(overrides: Partial<FulfillmentMaterialLine> = {}): FulfillmentMaterialLine {
  return {
    orderItemId: 'item-1', name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
    quantity: 2, shipped: 0, inProduction: 0, readyUnshipped: 2, unshipped: 2, ...overrides,
  };
}

describe('initialShipQuantities（発送の画面の最初の数）', () => {
  it('未発送の商品ごとに、発送準備中の数の全部を入れる', () => {
    expect(initialShipQuantities([
      materialLine({ orderItemId: 'a', quantity: 3, shipped: 1, readyUnshipped: 2, unshipped: 2 }),
      materialLine({ orderItemId: 'b', quantity: 1, readyUnshipped: 1, unshipped: 1 }),
    ])).toEqual({ a: 2, b: 1 });
  });

  it('受注生産中の数は入れない。発送準備中が0の商品も、0で並べる（入力の欄が要るため）', () => {
    expect(initialShipQuantities([
      materialLine({ orderItemId: 'made', fulfillmentType: 'backorder', quantity: 3, inProduction: 2, readyUnshipped: 1, unshipped: 3 }),
      materialLine({ orderItemId: 'wip', fulfillmentType: 'backorder', quantity: 2, inProduction: 2, readyUnshipped: 0, unshipped: 2 }),
    ])).toEqual({ made: 1, wip: 0 });
  });

  it('全部送った商品は並べない。商品が無ければ空', () => {
    expect(initialShipQuantities([
      materialLine({ orderItemId: 'done', shipped: 2, readyUnshipped: 0, unshipped: 0 }),
      materialLine({ orderItemId: 'left', shipped: 1, readyUnshipped: 1, unshipped: 1 }),
    ])).toEqual({ left: 1 });
    expect(initialShipQuantities([])).toEqual({});
  });

  it('手数料のお支払い待ちで送れない数は、最初の数に入れない（押し間違えて DB に断られないように）。欄は0で並べる', () => {
    expect(initialShipQuantities([
      materialLine({ orderItemId: 'held', lineKind: 'exchange', quantity: 2, readyUnshipped: 2, unshipped: 2, exchangeOnHold: 2 }),
      materialLine({ orderItemId: 'free', lineKind: 'exchange', quantity: 1, readyUnshipped: 1, unshipped: 1, exchangeOnHold: 0 }),
      materialLine({ orderItemId: 'plain', readyUnshipped: 2, unshipped: 2 }),
    ])).toEqual({ held: 0, free: 1, plain: 2 });
  });
});

describe('totalQuantity', () => {
  it('入れた数の合計を返す。0だけ・空は0', () => {
    expect(totalQuantity({ a: 2, b: 1, c: 0 })).toBe(3);
    expect(totalQuantity({ a: 0 })).toBe(0);
    expect(totalQuantity({})).toBe(0);
  });
});

describe('誤りの記号', () => {
  it('窓口が返す17の記号は共通の約束のとおり（最後の2つは返品の交換で足した物）', () => {
    expect([...FULFILLMENT_ERROR_CODES]).toEqual([
      'order_not_found', 'not_shippable', 'address_incomplete', 'payment_review_required', 'quantity_exceeds_ready',
      'fulfillment_request_mismatch', 'invalid_argument', 'fulfillment_not_found', 'fulfillment_cancel_not_allowed',
      'not_in_production', 'quantity_exceeds_in_production', 'completion_request_mismatch', 'completion_not_found',
      'completion_already_shipped', 'fulfillment_refunded', 'fulfillment_has_return', 'fulfillment_exchange_on_hold',
    ]);
  });
});

describe('画面からも読めること', () => {
  it('サーバーだけの物を import しない（型だけの import に限る）', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/orders/fulfillment/fulfillment-types.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(specifiers).toEqual([
      '@/lib/orders/order-payment-types',
      '@/lib/orders/order-progress',
      '@/lib/orders/shipping-carriers',
    ]);
    expect(source.match(/^import /gm)).toHaveLength(source.match(/^import type /gm)?.length ?? -1);
  });
});
