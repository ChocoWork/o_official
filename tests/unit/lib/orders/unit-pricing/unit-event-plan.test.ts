import { planUnitEvent, UnitPricingError } from '@/lib/orders/unit-pricing/unit-event-plan';
import type { UnitEventChange, UnitPricingMaterials, UnitPricingPlan } from '@/lib/orders/unit-pricing/unit-pricing-types';
import {
  applyPlan, buildOrder, JACKET, materialsOf, oneYenOff, pairSet, percent10, quantityTier, receive, repeat, repeatDefinition,
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

