import { pastFeeTotal, planUnitEvent, UnitPricingError } from '@/lib/orders/unit-pricing/unit-event-plan';
import { definition } from '../../discounts/fixtures';
import type { OrderPricingState, UnitEventChange, UnitPricingMaterials, UnitPricingPlan } from '@/lib/orders/unit-pricing/unit-pricing-types';
import {
  applyPlan, buildOrder, JACKET, materialsOf, oneYenOff, pairSet, percent10, quantityTier, receive, repeat, repeatDefinition, repeatPreviousDefinition,
  ret, retJacket, retPants, sequence, set, stacked, threshold, tiny, twoOrders,
} from './fixtures';

const step = (m: UnitPricingMaterials, c: UnitEventChange): UnitPricingPlan => planUnitEvent(m, c);

describe('DD-ADMIN-021: 設計書3章の例の返す額', () => {
  test.each<[string, UnitPricingMaterials, UnitEventChange, number]>([
    ['AC-01 例1 リピート ご都合1着', repeat(), ret(1, 'customer'), 17000],
    ['AC-08 例5 リピート 不良で送れず返金', repeat(), ret(1, 'shop'), 17000],
    ['AC-09 例6 セット ご都合でジャケット', set(), retJacket('customer'), 20000],
    ['AC-09 例7 セット ご都合でパンツ', set(), retPants('customer'), 5500],
    ['AC-08 例8 セット 不良のパンツ', set(), retPants('shop'), 8500],
    ['AC-08 例12 セット 不良のジャケット', set(), retJacket('shop'), 20000],
    ['AC-08 例13 ジャケットとパンツだけ 不良のジャケット', pairSet(), retJacket('shop'), 17000],
    ['AC-29 例13 をご都合で返すと', pairSet(), retJacket('customer'), 15500],
    ['AC-29 例14 10%引き ジャケットを返す', percent10(), retJacket('customer'), 18000],
    ['AC-29 例15 30,000円以上で1,000円引き パンツを返す', threshold(), retPants('customer'), 9000],
    ['AC-29 例15 交換できず返金', threshold(), retPants('shop'), 9667],
    ['AC-29 例16 重ねた割引 1着返す', stacked(), ret(1, 'customer'), 15300],
  ])('DD-ADMIN-021: %s', (_name, materials, change, refund) => {
    expect(planUnitEvent(materials, change).standardRefund).toBe(refund);
  });
});

test('DD-ADMIN-021: AC-14 3着以上で50%引きを1着ずつ返すと 5,000・0・5,000・10,000', () => {
  const plans = sequence(quantityTier(), 4, i => ret(1, 'customer', { returnLineId: `rl-${i}` }), step);
  expect(plans.map(p => p.standardRefund)).toEqual([5000, 0, 5000, 10000]);
  expect(plans.map(p => p.entitlement)).toEqual([5000, 0, 10000, 20000]);
});

test('DD-ADMIN-021: 例7 の行はパンツに 8,500・組のジャケットに +3,000', () => {
  const m = set();
  const plan = planUnitEvent(m, retPants('customer'));
  const jacketInSet = m.target.slots.find(s => s.orderItemId === 'oi-j' && s.paidAmount === 17000)!;
  const name = (l: { orderItemId: string; unitIndex: number }) =>
    l.orderItemId === 'oi-p' ? 'pants' : l.unitIndex === jacketInSet.unitIndex ? 'jacketInSet' : 'jacket';
  expect(plan.lines.map(l => [l.lineKind, name(l), l.allocation, l.correction])).toEqual([
    ['returned', 'pants', 8500, 0], ['kept', 'jacketInSet', 0, 3000],
  ]);
  expect(plan.standardRefund).toBe(5500);
});

test('DD-ADMIN-021: 割り振りの式 Σ割り振り − Σ直し − 手数料 ＝ 新しい E − 前の E', () => {
  const plan = planUnitEvent(set(), retPants('customer', { feePercent: 10 }));
  const alloc = plan.lines.reduce((s, l) => s + l.allocation, 0);
  const corr = plan.lines.reduce((s, l) => s + l.correction, 0);
  expect(alloc - corr - plan.feeAmount).toBe(plan.entitlement - plan.entitlementPrevious);
  expect(plan.feeAmount).toBe(Math.floor(5500 * 10 / 100));
});

describe('DD-ADMIN-021: 累計の2着目割引（前の注文から差し引く分）', () => {
  const first = () => {
    const { first: one, second } = twoOrders();
    return materialsOf(one, [second]);
  };

  test('例10 前の注文の返品は 17,000、後の注文の着に hold +3,000', () => {
    const plan = planUnitEvent(first(), receive([{ returnLineId: 'rl-a', holderOrderItemId: 'oi-a', quantity: 1, side: 'customer', part: 'now', feePercent: 0 }]));
    expect(plan.standardRefund).toBe(17000);
    expect(plan.holds).toEqual([{ heldOrderId: 'order-1', laterOrderId: 'order-2', itemId: JACKET, amount: 3000 }]);
    expect(plan.holdTotal).toBe(3000);
    expect(plan.lines.find(l => l.lineKind === 'hold')).toMatchObject({ slotOrderId: 'order-2', orderItemId: 'oi-b', allocation: 0, correction: 3000, priceBefore: 17000, priceAfter: 17000 });
    expect(plan.lines.find(l => l.lineKind === 'returned')).toMatchObject({ allocation: 20000, correction: 0 });
  });

  test('例10-2 後の注文の返品は 17,000 と前の注文への戻し 3,000', () => {
    const m1 = first();
    const plan1 = planUnitEvent(m1, receive([{ returnLineId: 'rl-a', holderOrderItemId: 'oi-a', quantity: 1, side: 'customer', part: 'now', feePercent: 0 }]));
    const after = applyPlan(m1, plan1);
    const m2 = materialsOf(after.related[0], [after.target]);
    const plan2 = planUnitEvent(m2, receive([{ returnLineId: 'rl-b', holderOrderItemId: 'oi-b', quantity: 1, side: 'customer', part: 'now', feePercent: 0 }]));
    expect(plan2.standardRefund).toBe(17000);
    expect(plan2.releases.map(r => [r.orderId, r.standardRefund])).toEqual([['order-1', 3000]]);
    expect(plan2.releases[0]).toMatchObject({
      kind: 'hold_release', entitlementPrevious: 17000, entitlement: 20000, holdTotal: 0,
      holds: [{ heldOrderId: 'order-1', laterOrderId: 'order-2', itemId: JACKET, amount: -3000 }],
    });
    expect(plan2.releases[0].lines[0]).toMatchObject({ lineKind: 'hold', slotOrderId: 'order-2', correction: -3000 });
    // 合計 37,000円 ＝ 2回目 17,000 ＋ 1回目 17,000 ＋ 戻し 3,000
    expect(plan1.standardRefund + plan2.standardRefund + plan2.releases[0].standardRefund).toBe(37000);
  });

  test('例10 を不良で送れず返金すると差し引かず 20,000', () => {
    const plan = planUnitEvent(first(), receive([{ returnLineId: 'rl-a', holderOrderItemId: 'oi-a', quantity: 1, side: 'shop', part: 'now', feePercent: 0 }]));
    expect(plan.standardRefund).toBe(20000);
    expect(plan.holds).toEqual([]);
  });

  test('AC-10 2回目の着が先に返っていれば、1回目の返品は 20,000', () => {
    const { first: one, second } = twoOrders();
    const m2 = materialsOf(second, [one]);
    const plan2 = planUnitEvent(m2, receive([{ returnLineId: 'rl-b', holderOrderItemId: 'oi-b', quantity: 1, side: 'customer', part: 'now', feePercent: 0 }]));
    expect(plan2.standardRefund).toBe(17000);
    const after = applyPlan(m2, plan2);
    const plan1 = planUnitEvent(materialsOf(after.related[0], [after.target]),
      receive([{ returnLineId: 'rl-a', holderOrderItemId: 'oi-a', quantity: 1, side: 'customer', part: 'now', feePercent: 0 }]));
    expect(plan1.standardRefund).toBe(20000);
    expect(plan1.holds).toEqual([]);
  });

  test('前の注文の E が 0 円より少なくなる分は差し引かない', () => {
    const { first: one, second } = twoOrders();
    // 1回目の注文の払った額を 2,000円だけにして、外れた 3,000円のうち 2,000円までしか引けないことを確かめる
    const cheap = { ...one, paidTotal: 2000, slots: one.slots.map(s => ({ ...s, paidAmount: 2000, currentPrice: 2000 })) };
    const plan = planUnitEvent(materialsOf(cheap, [second]),
      receive([{ returnLineId: 'rl-a', holderOrderItemId: 'oi-a', quantity: 1, side: 'customer', part: 'now', feePercent: 0 }]));
    expect(plan.holds).toEqual([{ heldOrderId: 'order-1', laterOrderId: 'order-2', itemId: JACKET, amount: 2000 }]);
    expect(plan.entitlement).toBe(0);
    expect(plan.standardRefund).toBe(0);
  });
});

describe('DD-ADMIN-021: 手数料', () => {
  const lineA = (side: 'customer' | 'shop', quantity = 1) => ({ returnLineId: `rl-${side}`, holderOrderItemId: 'oi-1', quantity, side, part: 'now' as const, feePercent: 10 });

  test('DD-ADMIN-021: AC-24・例11 手数料10% 不良とご都合を1回でも2回でもどちらの順でも 35,000', () => {
    const totals: number[] = [];
    const fees: number[] = [];
    const run = (changes: UnitEventChange[]) => {
      const plans = sequence(repeat(), changes.length, i => changes[i], step);
      totals.push(plans.reduce((s, p) => s + p.standardRefund, 0));
      fees.push(plans.reduce((s, p) => s + p.feeAmount, 0));
    };
    run([receive([lineA('shop'), lineA('customer')])]);
    run([receive([lineA('customer')]), receive([lineA('shop')])]);
    run([receive([lineA('shop')]), receive([lineA('customer')])]);
    run([receive([lineA('customer'), lineA('shop')])]);
    expect(totals).toEqual([35000, 35000, 35000, 35000]);
    expect(fees).toEqual([2000, 2000, 2000, 2000]);
  });

  test('DD-ADMIN-021: 不良の分は手数料なし 17,000、ご都合の分は 20,000 に 2,000', () => {
    const plan = planUnitEvent(repeat(), receive([lineA('shop'), lineA('customer')]));
    expect(plan.feeAmount).toBe(2000);
    expect(plan.entitlementGross).toBe(37000);
    expect(plan.entitlementShopOnly).toBe(17000);
    expect(plan.treatments).toEqual([{ returnLineId: 'rl-shop', treatment: 'shop' }, { returnLineId: 'rl-customer', treatment: 'customer' }]);
  });

  test('DD-ADMIN-021: AC-06 10% を1着ずつ2回 手数料は 1,700 と 2,000', () => {
    const plans = sequence(repeat(), 2, i => ret(1, 'customer', { returnLineId: `rl-${i}`, feePercent: 10 }), step);
    expect([plans[0].feeAmount, plans[1].feeAmount]).toEqual([1700, 2000]);
    expect(plans[1].entitlement).toBe(33300);
  });

  test('DD-ADMIN-021: お店の側の返品・発送前の取り消しには手数料を掛けない', () => {
    expect(planUnitEvent(repeat(), ret(1, 'shop', { feePercent: 10 })).feeAmount).toBe(0);
  });

  test('DD-ADMIN-021: 率が混じる時は返品の行の id の順に増えた分を割る', () => {
    const m = materialsOf(buildOrder({
      orderId: 'order-mix', lines: [{ orderItemId: 'oi-1', itemId: JACKET, unitPrice: 10000, quantity: 2 }],
    }));
    const plan = planUnitEvent(m, receive([
      { returnLineId: 'rl-b', holderOrderItemId: 'oi-1', quantity: 1, side: 'customer', part: 'now', feePercent: 20 },
      { returnLineId: 'rl-a', holderOrderItemId: 'oi-1', quantity: 1, side: 'customer', part: 'now', feePercent: 10 },
    ]));
    expect(plan.feeAmount).toBe(Math.floor(10000 * 10 / 100) + Math.floor(10000 * 20 / 100));
  });
});

test('DD-ADMIN-021: AC-13 注文全体の1円引き 残る1着 9,999 返す額 10,000', () => {
  const plan = planUnitEvent(oneYenOff(), ret(1, 'customer'));
  expect(plan.standardRefund).toBe(10000);
  // 払った額が返す額にいちばん近い 10,000円の枠を返すので、残る 9,999円の枠に直しは出ない
  expect(plan.lines.map(l => [l.lineKind, l.allocation, l.correction])).toEqual([['returned', 10000, 0]]);
});

test('DD-ADMIN-021: 手元0着は0円 残る小計50円未満は割引なし', () => {
  const m = tiny();
  const plan = planUnitEvent(m, ret(2, 'customer'));
  expect(plan.entitlement).toBe(m.target.paidTotal);
  const one = planUnitEvent(m, ret(1, 'customer'));
  expect(one.entitlementGross).toBe(m.target.paidTotal - 40);
});

test('DD-ADMIN-021: 例9 発送前の取り消しは出荷済みでない着から 17,000', () => {
  const m = materialsOf(buildOrder({
    orderId: 'order-c', lines: [{ orderItemId: 'oi-1', itemId: JACKET, unitPrice: 20000, quantity: 2 }],
    definitions: [repeatDefinition()], shipped: false,
  }));
  const plan = planUnitEvent(m, { kind: 'pre_shipment_cancel', cancels: [{ orderItemId: 'oi-1', quantity: 1 }] });
  expect(plan.kind).toBe('pre_shipment_cancel');
  expect(plan.standardRefund).toBe(17000);
  expect(plan.feeAmount).toBe(0);
  expect(plan.lines.find(l => l.lineKind === 'returned')).toMatchObject({ shipped: false, allocation: 17000, stateAfter: 'returned_shop', part: null });
});

describe('DD-ADMIN-021: 返す枠の選び方と誤り', () => {
  test('発送後の返品は出荷済みの枠から。出荷前の枠しか無ければ unit_not_available', () => {
    const m = materialsOf(buildOrder({
      orderId: 'order-u', lines: [{ orderItemId: 'oi-1', itemId: JACKET, unitPrice: 20000, quantity: 1 }], shipped: false,
    }));
    expect(() => planUnitEvent(m, ret(1, 'customer'))).toThrow(UnitPricingError);
    try { planUnitEvent(m, ret(1, 'customer')); } catch (e) { expect((e as UnitPricingError).code).toBe('unit_not_available'); }
  });

  test('空きの枠より多く返そうとすると unit_not_available', () => {
    expect(() => planUnitEvent(repeat(), ret(3, 'customer'))).toThrow(UnitPricingError);
  });

  test('同じ受け取りで交換に出す枠（excludedSlots）は返す枠に選ばない', () => {
    const m = repeat();
    const cheap = m.target.slots.find(s => s.paidAmount === 17000)!;
    const plan = planUnitEvent(m, receive([{ returnLineId: 'rl-1', holderOrderItemId: 'oi-1', quantity: 1, side: 'customer', part: 'now', feePercent: 0 }],
      [`oi-1:${cheap.unitIndex}`]));
    expect(plan.lines[0].unitIndex).not.toBe(cheap.unitIndex);
    expect(plan.lines.map(l => [l.lineKind, l.allocation, l.correction])).toEqual([['returned', 20000, 0], ['kept', 0, 3000]]);
    expect(plan.standardRefund).toBe(17000);
    expect(() => planUnitEvent(m, receive([{ returnLineId: 'rl-1', holderOrderItemId: 'oi-1', quantity: 2, side: 'customer', part: 'now', feePercent: 0 }],
      [`oi-1:${cheap.unitIndex}`]))).toThrow(UnitPricingError);
  });

  test('交換の品の返品は、持ち主がその行の枠に記録する', () => {
    const m = repeat();
    const target = {
      ...m.target,
      slots: m.target.slots.map(s => (s.paidAmount === 20000
        ? { ...s, holderOrderItemId: 'oi-ex', holderUnitIndex: 0 } : s)),
    };
    const plan = planUnitEvent(materialsOf(target), receive([{ returnLineId: 'rl-x', holderOrderItemId: 'oi-ex', quantity: 1, side: 'customer', part: 'now', feePercent: 0 }]));
    expect(plan.lines[0]).toMatchObject({ lineKind: 'returned', holderOrderItemId: 'oi-ex', orderItemId: 'oi-1', allocation: 20000 });
    expect(plan.standardRefund).toBe(17000);
  });

  test('別の返品の行に結び付いた枠は選ばない', () => {
    const m = repeat();
    const target = { ...m.target, slots: m.target.slots.map(s => ({ ...s, claimedReturnLineId: 'rl-other' })) };
    expect(() => planUnitEvent(materialsOf(target), ret(1, 'customer'))).toThrow(UnitPricingError);
  });
});

describe('DD-ADMIN-021: 今すぐと相談の分け方', () => {
  test('相談の着を手元にあるとみなした E との小さい方を今すぐ、残りを相談にする', () => {
    const m = repeat();
    const plan = planUnitEvent(m, receive([
      { returnLineId: 'rl-a', holderOrderItemId: 'oi-1', quantity: 1, side: 'customer', part: 'now', feePercent: 0 },
      { returnLineId: 'rl-b', holderOrderItemId: 'oi-1', quantity: 1, side: 'customer', part: 'consult', feePercent: 0 },
    ]));
    expect(plan.standardRefund).toBe(37000);
    expect(plan.nowRefund).toBe(17000);
    expect(plan.consultRefund).toBe(20000);
  });

  test('全部相談なら今すぐは0円', () => {
    const plan = planUnitEvent(repeat(), ret(1, 'customer', { part: 'consult' }));
    expect(plan.nowRefund).toBe(0);
    expect(plan.consultRefund).toBe(plan.standardRefund);
  });

  test('今すぐだけなら標準の額と同じ', () => {
    const plan = planUnitEvent(repeat(), ret(1, 'customer'));
    expect([plan.nowRefund, plan.consultRefund]).toEqual([plan.standardRefund, 0]);
  });
});

test('DD-ADMIN-021: 返品が空の受け取りは返す額0円で状態を動かさない', () => {
  const plan = planUnitEvent(repeat(), receive([]));
  expect(plan.standardRefund).toBe(0);
  expect(plan.lines).toEqual([]);
});

test('DD-ADMIN-021: 前の E の最高より小さい E は返す額0円', () => {
  const m = repeat();
  const plan = planUnitEvent({ ...m, target: { ...m.target, entitlementMax: 99999 } }, ret(1, 'customer'));
  expect(plan.standardRefund).toBe(0);
});

test('DD-ADMIN-021: 計画の誤りは snapshot_invalid（前の E が合わない）', () => {
  const m = repeat();
  expect(() => planUnitEvent({ ...m, target: { ...m.target, entitlementPrevious: 1234 } }, ret(1, 'customer'))).toThrow(UnitPricingError);
});

test('DD-ADMIN-021: 割引の写しの行が無い枠は snapshot_invalid', () => {
  const m = repeat();
  const broken = { ...m.target, snapshot: { ...m.target.snapshot, lines: [] } };
  expect(() => planUnitEvent(materialsOf(broken), ret(1, 'customer'))).toThrow(UnitPricingError);
});


describe('DD-ADMIN-021: 修正1 手数料は率を持つご都合の返品が生む増えにだけ掛ける', () => {
  const r = (id: string, side: 'customer' | 'shop', feePercent: number) =>
    ({ returnLineId: id, holderOrderItemId: 'oi-1', quantity: 1, side, part: 'now' as const, feePercent });

  test.each([[0], [30]])('DD-ADMIN-021: 不良 %i%% とご都合 10%% を1回の受け取りで 手数料 2,000・合計 35,000', defectRate => {
    const plan = planUnitEvent(repeat(), receive([r('rl-a', 'shop', defectRate), r('rl-b', 'customer', 10)]));
    expect(plan.feeAmount).toBe(2000);
    expect(plan.standardRefund).toBe(35000);
  });

  test.each([[0], [30]])('DD-ADMIN-021: 例11 不良が %i%% でも、どの順でも合計 35,000', defectRate => {
    const orders: UnitEventChange[][] = [
      [receive([r('rl-a', 'customer', 10)]), receive([r('rl-b', 'shop', defectRate)])],
      [receive([r('rl-b', 'shop', defectRate)]), receive([r('rl-a', 'customer', 10)])],
      [receive([r('rl-b', 'shop', defectRate), r('rl-a', 'customer', 10)])],
    ];
    const totals = orders.map(cs => sequence(repeat(), cs.length, i => cs[i], step).reduce((s, p) => s + p.standardRefund, 0));
    expect(totals).toEqual([35000, 35000, 35000]);
  });

  test('DD-ADMIN-021: 率の違うご都合の返品2つは、受け取りの行の並びを入れ替えても同じ手数料', () => {
    const a = planUnitEvent(repeat(), receive([r('rl-a', 'customer', 10), r('rl-b', 'customer', 20)]));
    const b = planUnitEvent(repeat(), receive([r('rl-b', 'customer', 20), r('rl-a', 'customer', 10)]));
    expect(a.feeAmount).toBe(b.feeAmount);
    expect(a.standardRefund).toBe(b.standardRefund);
    expect(a.feeAmount).toBeGreaterThan(3700);
  });
});

describe('DD-ADMIN-021: 修正2 hold_release の返す額は E の最高を起点にする', () => {
  const lineOf = (orderItemId: string, id: string) =>
    ({ returnLineId: id, holderOrderItemId: orderItemId, quantity: 1, side: 'customer' as const, part: 'now' as const, feePercent: 0 });

  test('DD-ADMIN-021: E が一度下がった注文への戻しは0円で、その注文から返す合計は払った額を超えない', () => {
    const first = buildOrder({
      orderId: 'order-1', placedAt: '2026-11-01T00:00:00Z',
      lines: [{ orderItemId: 'oi-a', itemId: JACKET, unitPrice: 20000, quantity: 1 }, { orderItemId: 'oi-p', itemId: 2, unitPrice: 10000, quantity: 3 }],
      definitions: [repeatPreviousDefinition(), definition('tier', { kind: 'product', targetMode: 'exclude', itemIds: [JACKET], value: { type: 'percent', value: 50 }, minimum: { type: 'quantity', value: 3 } })],
    });
    const { second } = twoOrders();
    expect(first.paidTotal).toBe(35000);
    let m = materialsOf(first, [second]);
    const p1 = planUnitEvent(m, receive([lineOf('oi-a', 'rl-1')]));
    expect([p1.standardRefund, p1.entitlement]).toEqual([17000, 17000]);
    m = applyPlan(m, p1);
    const p2 = planUnitEvent(m, receive([lineOf('oi-p', 'rl-2')]));
    expect([p2.entitlement, p2.standardRefund]).toEqual([12000, 0]);
    m = applyPlan(m, p2);
    const m3 = materialsOf(m.related[0], [m.target]);
    const p3 = planUnitEvent(m3, receive([lineOf('oi-b', 'rl-3')]));
    expect(p3.releases.map(x => [x.orderId, x.standardRefund, x.nowRefund])).toEqual([['order-1', 0, 0]]);
    m = applyPlan(m3, p3);
    const m4 = materialsOf(m.related[0], [m.target]);
    const p4 = planUnitEvent(m4, receive([lineOf('oi-p', 'rl-4'), lineOf('oi-p', 'rl-5')]));
    const total = p1.standardRefund + p2.standardRefund + p3.releases[0].standardRefund + p4.standardRefund;
    expect(total).toBeLessThanOrEqual(35000);
    expect(total).toBe(35000);
  });
});

test('DD-ADMIN-021: 修正3 手数料を引いた後の E が0円より少なくなる分は前の注文から引かない', () => {
  const first = buildOrder({
    orderId: 'order-1', placedAt: '2026-11-01T00:00:00Z',
    lines: [{ orderItemId: 'oi-a', itemId: JACKET, unitPrice: 3050, quantity: 1 }], definitions: [repeatPreviousDefinition()],
  });
  const { second } = twoOrders();
  const charged = { ...first, feeTotal: 100, entitlementPrevious: -100 };
  const plan = planUnitEvent(materialsOf(charged, [second]), receive([
    { returnLineId: 'rl-a', holderOrderItemId: 'oi-a', quantity: 1, side: 'customer', part: 'now', feePercent: 0 },
  ]));
  expect(plan.holds).toEqual([{ heldOrderId: 'order-1', laterOrderId: 'order-2', itemId: JACKET, amount: 2950 }]);
  expect(plan.entitlement).toBe(0);
});

describe('DD-ADMIN-021: 修正1b 手数料の累計を過去の返品の率で正確に出し直す', () => {
  const r = (id: string, side: 'customer' | 'shop', feePercent: number) =>
    ({ returnLineId: id, holderOrderItemId: 'oi-1', quantity: 1, side, part: 'now' as const, feePercent });

  test('DD-ADMIN-021: 過去の 10% と 20% の返品の後に不良で増えた分を、過去の率で掛ける（3回に分けても1回でも同じ）', () => {
    const m0 = materialsOf(buildOrder({
      orderId: 'order-4', lines: [{ orderItemId: 'oi-1', itemId: JACKET, unitPrice: 20000, quantity: 3 }],
      definitions: [repeatDefinition()],
    }));
    const cs = [receive([r('rl-a', 'customer', 10)]), receive([r('rl-b', 'customer', 20)]), receive([r('rl-c', 'shop', 0)])];
    const plans = sequence(m0, 3, i => cs[i], step);
    const oneReceipt = planUnitEvent(m0, receive([r('rl-a', 'customer', 10), r('rl-b', 'customer', 20), r('rl-c', 'shop', 0)]));
    // 3回に分けた手数料の合計は、1回の受け取りで返品の行の id の順に足した手数料と同じ
    expect(plans.reduce((s, p) => s + p.feeAmount, 0)).toBe(oneReceipt.feeAmount);
    expect(plans.reduce((s, p) => s + p.standardRefund, 0)).toBe(oneReceipt.standardRefund);
  });
});

describe('DD-ADMIN-021: 修正2 前の出来事の holds を、その出来事の返品の増えから外さない', () => {
  const line = (oi: string, id: string, feePercent: number) =>
    ({ returnLineId: id, holderOrderItemId: oi, quantity: 1, side: 'customer' as const, part: 'now' as const, feePercent });
  const start = () => {
    const first = buildOrder({
      orderId: 'order-1', placedAt: '2026-11-01T00:00:00Z',
      lines: [{ orderItemId: 'oi-a', itemId: JACKET, unitPrice: 20000, quantity: 1 }, { orderItemId: 'oi-c', itemId: 3, unitPrice: 1000, quantity: 1 }],
      definitions: [repeatPreviousDefinition()],
    });
    return materialsOf(first, [twoOrders().second]);
  };
  const run = (r2: number) => {
    const cs = [receive([line('oi-a', 'rl-1', 10)]), receive([line('oi-c', 'rl-2', r2)])];
    return sequence(start(), 2, i => cs[i], step);
  };

  test.each([[0, 1700], [10, 1800]])('DD-ADMIN-021: 2回目の返品が %i%% なら手数料の合計は %i（1回目は holds 3,000 を引いた 17,000 に 10%）', (r2, total) => {
    const [p1, p2] = run(r2);
    expect([p1.feeAmount, p1.holdTotal]).toEqual([1700, 3000]);
    expect(p1.feeAmount + p2.feeAmount).toBe(total);
    const single = planUnitEvent(start(), receive([line('oi-a', 'rl-1', 10), line('oi-c', 'rl-2', r2)]));
    expect(single.feeAmount).toBe(total);
    expect(single.standardRefund).toBe(p1.standardRefund + p2.standardRefund);
  });
});

describe('DD-ADMIN-021: 修正3 前の出来事を出来事の時と同じ段取りで数え直す', () => {
  const line = (oi: string, id: string, feePercent: number) =>
    ({ returnLineId: id, holderOrderItemId: oi, quantity: 1, side: 'customer' as const, part: 'now' as const, feePercent });
  const start = () => {
    const first = buildOrder({
      orderId: 'order-1', placedAt: '2026-11-01T00:00:00Z',
      lines: [
        { orderItemId: 'oi-a', itemId: JACKET, unitPrice: 20000, quantity: 1 },
        { orderItemId: 'oi-c', itemId: 3, unitPrice: 1000, quantity: 1 },
        { orderItemId: 'oi-d', itemId: 4, unitPrice: 500, quantity: 1 },
      ],
      definitions: [repeatPreviousDefinition()],
    });
    return materialsOf(first, [twoOrders().second]);
  };

  test.each([[10, 0, 1700], [30, 10, 5200]])('DD-ADMIN-021: ジャケット %i%% と小物 %i%% を同じ受け取りで返した後の返品は手数料0・合計は1回の受け取りと同じ（%i）', (r1, r2, total) => {
    const e1 = receive([line('oi-a', 'rl-1', r1), line('oi-c', 'rl-2', r2)]);
    const e2 = receive([line('oi-d', 'rl-3', 0)]);
    const [p1, p2] = sequence(start(), 2, i => [e1, e2][i], step);
    expect(p2.feeAmount).toBe(0);
    const single = planUnitEvent(start(), receive([line('oi-a', 'rl-1', r1), line('oi-c', 'rl-2', r2), line('oi-d', 'rl-3', 0)]));
    expect(p1.feeAmount + p2.feeAmount).toBe(single.feeAmount);
    expect(p1.feeAmount + p2.feeAmount).toBe(total);
    expect(p1.standardRefund + p2.standardRefund).toBe(single.standardRefund);
  });

  test('DD-ADMIN-021: お店の側の返品が入らない並びなら、出来事を分けても1回の受け取りと手数料・返す額の合計が同じ', () => {
    const rl = (oi: string, id: string, fee: number) => line(oi, id, fee);
    const all = [rl('oi-a', 'rl-1', 10), rl('oi-c', 'rl-2', 20), rl('oi-d', 'rl-3', 5)];
    const splits: number[][][] = [[[0], [1], [2]], [[0, 1], [2]], [[0], [1, 2]], [[2], [0, 1]], [[1], [0], [2]], [[2], [1], [0]]];
    const single = planUnitEvent(start(), receive(all));
    for (const split of splits) {
      const events = split.map(ix => receive(ix.map(n => all[n])));
      const plans = sequence(start(), events.length, i => events[i], step);
      const fee = plans.reduce((s, p) => s + p.feeAmount, 0);
      const refund = plans.reduce((s, p) => s + p.standardRefund, 0);
      expect(refund + fee).toBe(single.standardRefund + single.feeAmount);
      // 返品の行の id の順を保つ分け方なら、手数料の合計も1回の受け取りと同じ
      const inOrder = split.flat().every((n, i) => n === i);
      if (inOrder) expect(fee).toBe(single.feeAmount);
    }
  });
});

describe('DD-ADMIN-021: 修正4 戻しの出来事は率0の段にし、返品の行の無い返品は1着ずつ段にする', () => {
  const line = (oi: string, id: string | null, feePercent: number) =>
    ({ returnLineId: id, holderOrderItemId: oi, quantity: 1, side: 'customer' as const, part: 'now' as const, feePercent });
  const firstOrder = () => buildOrder({
    orderId: 'order-1', placedAt: '2026-11-01T00:00:00Z',
    lines: [
      { orderItemId: 'oi-a', itemId: JACKET, unitPrice: 20000, quantity: 1 },
      { orderItemId: 'oi-c', itemId: 3, unitPrice: 1000, quantity: 1 },
      { orderItemId: 'oi-d', itemId: 4, unitPrice: 500, quantity: 1 },
    ],
    definitions: [repeatPreviousDefinition()],
  });

  test.each([[30, 300, 700], [0, 0, 1000]])('DD-ADMIN-021: 前の注文への戻しの後に %i%% で返すと、戻した 3,000 に率を掛けず手数料 %i・返す額 %i', (r3, fee, refund) => {
    let m = materialsOf(firstOrder(), [twoOrders().second]);
    const p1 = planUnitEvent(m, receive([line('oi-a', 'rl-1', 10)]));
    expect([p1.feeAmount, p1.holdTotal]).toEqual([1700, 3000]);
    m = applyPlan(m, p1, '2026-11-20T00:00:00Z', { 'rl-1': 10 });
    let m2 = materialsOf(m.related[0], [m.target]);
    const p2 = planUnitEvent(m2, receive([line('oi-b', 'rl-2', 0)]));
    expect(p2.releases.map(x => [x.orderId, x.standardRefund, x.feeAmount])).toEqual([['order-1', 3000, 0]]);
    m2 = applyPlan(m2, p2, '2026-11-21T00:00:00Z', { 'rl-2': 0 });
    const m3 = materialsOf(m2.related[0], [m2.target]);
    expect(pastFeeTotal(m3.target)).toBe(1700);
    const p3 = planUnitEvent(m3, receive([line('oi-c', 'rl-3', r3)]));
    expect([p3.feeAmount, p3.standardRefund]).toEqual([fee, refund]);
  });

  test('DD-ADMIN-021: 返品の行の無いご都合の返品2つは、それぞれの率で掛ける（並びを入れ替えても同じ）', () => {
    const order = () => materialsOf(buildOrder({
      orderId: 'order-5',
      lines: [{ orderItemId: 'oi-x', itemId: 3, unitPrice: 10000, quantity: 1 }, { orderItemId: 'oi-y', itemId: 4, unitPrice: 10000, quantity: 1 }],
    }));
    const a = planUnitEvent(order(), receive([line('oi-x', null, 10), line('oi-y', null, 30)]));
    const b = planUnitEvent(order(), receive([line('oi-y', null, 30), line('oi-x', null, 10)]));
    expect(a.feeAmount).toBe(4000);
    expect([b.feeAmount, b.standardRefund]).toEqual([a.feeAmount, a.standardRefund]);
  });

  test('DD-ADMIN-021: 戻し・お店の側の返品を含む並びでも、出来事のたびに数え直した手数料の累計が取った累計と同じ', () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const actions = [['order-1', 'oi-a'], ['order-1', 'oi-c'], ['order-1', 'oi-d'], ['order-2', 'oi-b']] as const;
    for (let run = 0; run < 40; run++) {
      const orders: Record<string, OrderPricingState> = { 'order-1': firstOrder(), 'order-2': twoOrders().second };
      const order = [...actions];
      for (let i = order.length - 1; i > 0; i--) { const j = rand(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
      order.forEach(([orderId, oi], n) => {
        const otherId = orderId === 'order-1' ? 'order-2' : 'order-1';
        const id = `rl-${run}-${n}`;
        const shop = rand(3) === 0;
        const rate = shop ? 0 : [0, 10, 20, 30][rand(4)];
        const m = materialsOf(orders[orderId], [orders[otherId]]);
        const plan = planUnitEvent(m, receive([{ ...line(oi, id, rate), side: shop ? 'shop' : 'customer' }]));
        const next = applyPlan(m, plan, `2026-11-${String(20 + n).padStart(2, '0')}T00:00:00Z`, { [id]: rate });
        orders[orderId] = next.target;
        orders[otherId] = next.related[0];
        expect([pastFeeTotal(orders['order-1']), pastFeeTotal(orders['order-2'])])
          .toEqual([orders['order-1'].feeTotal, orders['order-2'].feeTotal]);
      });
    }
  });
});
