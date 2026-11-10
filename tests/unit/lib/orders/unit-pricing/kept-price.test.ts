import { correctKeptPrice, priceSlots } from '@/lib/orders/unit-pricing/kept-price';
import { slotKeyOf, UnitPricingError, type OrderPricingState, type SlotKey, type SlotState } from '@/lib/orders/unit-pricing/unit-pricing-types';
import { oneYenOff, set, stacked, tiny, repeat, percent10, twoOrders } from './fixtures';

const keys = (o: OrderPricingState) => o.slots.map(s => slotKeyOf(s.orderItemId, s.unitIndex));
const states = (entries: [SlotKey, SlotState][]) => new Map<SlotKey, SlotState>(entries);

describe('DD-ADMIN-021: priceSlots', () => {
  test('全部を含めると注文の時の払った額になる（セット 17,000・20,000・8,500）', () => {
    const order = set().target;
    const priced = priceSlots(order, keys(order));
    expect([...priced.values()].sort((a, b) => a - b)).toEqual([8500, 17000, 20000]);
  });

  test('含める枠が空なら空の表', () => {
    expect(priceSlots(set().target, []).size).toBe(0);
  });

  test('商品ごとに額の安い順を、枠の今の値段の安い順へ当てる', () => {
    const order = repeat().target; // 17,000円の枠(unit 1)と 20,000円の枠(unit 0)
    const priced = priceSlots(order, keys(order));
    const cheap = order.slots.find(s => s.paidAmount === 17000)!;
    expect(priced.get(slotKeyOf(cheap.orderItemId, cheap.unitIndex))).toBe(17000);
  });

  test('含める小計が 50円未満なら割引なしの単価、0着は空', () => {
    const order = tiny().target;
    const one = priceSlots(order, [slotKeyOf('oi-1', 0)]);
    expect([...one.values()]).toEqual([40]);
  });

  test('知らない枠は snapshot_invalid', () => {
    expect(() => priceSlots(set().target, ['nope:0'])).toThrow(UnitPricingError);
  });

  test('前の注文の着数を options で直すと値段が変わる', () => {
    const { first, second } = twoOrders();
    expect(first.paidTotal).toBe(20000);
    expect([...priceSlots(second, keys(second)).values()]).toEqual([17000]);
    expect([...priceSlots(second, keys(second), { priorUnitsByItem: { '1': 0 } }).values()]).toEqual([20000]);
  });
});

describe('DD-ADMIN-021: correctKeptPrice', () => {
  test('手元に残る枠が0なら0円（計算の例外にならない）', () => {
    const order = set().target;
    const all = states(keys(order).map(k => [k, 'returned_customer'] as [SlotKey, SlotState]));
    expect(correctKeptPrice(order, all).total).toBe(0);
  });

  test('残る小計が 50円未満なら割引なしの単価（40円）', () => {
    const order = tiny().target;
    const result = correctKeptPrice(order, states([[slotKeyOf('oi-1', 1), 'returned_customer']]));
    expect(result.total).toBe(40);
  });

  test('お客様のご都合の返品: 手元に残る枠だけで出し直す（セット: パンツを返すとジャケット 2着で 40,000円）', () => {
    const order = set().target;
    expect(correctKeptPrice(order, states([[slotKeyOf('oi-p', 0), 'returned_customer']])).total).toBe(40000);
  });

  test('お店の側の返品: 籠から割引の付いた着を引き、低い方を使う（セットの不良パンツは 37,000円、不良ジャケットは 25,500円）', () => {
    const order = set().target;
    expect(correctKeptPrice(order, states([[slotKeyOf('oi-p', 0), 'returned_shop']])).total).toBe(37000);
    const cheapJacket = order.slots.find(s => s.orderItemId === 'oi-j' && s.paidAmount === 20000)!;
    expect(correctKeptPrice(order, states([[slotKeyOf('oi-j', cheapJacket.unitIndex), 'returned_shop']])).total).toBe(25500);
  });

  test('注文全体の1円引き: 残る1着にも条件が合えば 9,999円', () => {
    const order = oneYenOff().target;
    expect(correctKeptPrice(order, states([[slotKeyOf('oi-1', 1), 'returned_customer']])).total).toBe(9999);
  });

  test('重ねた割引: 1着返すと残る1着は 10%引きだけで 18,000円', () => {
    const order = stacked().target;
    expect(correctKeptPrice(order, states([[slotKeyOf('oi-1', 1), 'returned_customer']])).total).toBe(18000);
  });

  test('割引コードの割引は残る枠にも付く（10%引き: パンツ 9,000円）', () => {
    const order = percent10().target;
    expect(correctKeptPrice(order, states([[slotKeyOf('oi-j', 0), 'returned_customer']])).total).toBe(9000);
  });
});
