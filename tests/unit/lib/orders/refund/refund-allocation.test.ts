import fs from 'node:fs';
import path from 'node:path';
import {
  estimateRefund,
  refundLineAmount,
  selectsAllUnshipped,
  unitsDiscount,
} from '@/lib/orders/refund/refund-allocation';
import type { RefundMaterialLine, RefundMaterials } from '@/lib/orders/refund/refund-types';

// 割り振りの試験の値。Task 1 の DB 結合テストと同じ値で、TS と SQL の答えが食い違わないことを確かめる（本計画 P4）。
// 値 A: 注文の割引 1000 円を、商品の小計 6000 円（X）と 3000 円（Y）の割合で割った 667 円と 333 円
const X = { itemPrice: 3000, quantity: 2, lineDiscount: 667, refundedUnits: 0 } as const;
const Y = { itemPrice: 1000, quantity: 3, lineDiscount: 333, refundedUnits: 0 } as const;

function materialLine(overrides: Partial<RefundMaterialLine> = {}): RefundMaterialLine {
  return {
    orderItemId: 'item-x', name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
    itemPrice: 3000, quantity: 2, lineTotal: 6000, shipped: 0, unshipped: 2,
    refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 0, restockable: 2,
    lineDiscount: 667, refundedUnits: 0, ...overrides,
  };
}

/** 値 A の X（在庫の品 3000 円 × 2） */
const LINE_X = materialLine();
/** 値 A の Y（受注生産の品 1000 円 × 3） */
const LINE_Y = materialLine({
  orderItemId: 'item-y', name: 'リネンパンツ', color: null, size: null, fulfillmentType: 'backorder',
  itemPrice: 1000, quantity: 3, lineTotal: 3000, unshipped: 3, restockable: 0, lineDiscount: 333,
});

function materials(overrides: { shippedTotal?: number; lines?: RefundMaterialLine[] } = {}): RefundMaterials {
  const lines = overrides.lines ?? [LINE_X, LINE_Y];
  return {
    order: {
      id: 'order-1', orderNumber: 'ORD-ORDER-1A', status: 'paid', paymentMethod: 'card',
      totalAmount: 8500, shippingAmount: 500, discountAmount: 1000, paidAmount: 8500,
      succeededAmount: 0, openAmount: 0, refundableAmount: 8500, refundedShipping: 0, refundableShipping: 500,
      shippedTotal: overrides.shippedTotal ?? 0,
      unshippedTotal: lines.reduce((total, line) => total + line.unshipped, 0),
    },
    lines,
    awaitingRefund: null,
  };
}

describe('unitsDiscount（disc(n) = floor((2·D·n + q) / (2·q))）', () => {
  it.each([
    ['値 A の X（D = 667、q = 2）', 667, 2, [[0, 0], [1, 334], [2, 667]]],
    ['値 A の Y（D = 333、q = 3）', 333, 3, [[0, 0], [1, 111], [2, 222], [3, 333]]],
    ['値 B: 割引が 0 なら、いつも 0', 0, 3, [[0, 0], [1, 0], [2, 0], [3, 0]]],
    ['値 C: 数 3・割引 1', 1, 3, [[0, 0], [1, 0], [2, 1], [3, 1]]],
  ] as const)('%s', (_name, lineDiscount, quantity, expected) => {
    for (const [units, discount] of expected) {
      expect(unitsDiscount(lineDiscount, quantity, units)).toBe(discount);
    }
  });

  it('まだ返していなければ disc(0) = 0、ぜんぶ返すと disc(q) = D になり、返す数が増えても減らない（端数が出ても合計がぴったり合う）', () => {
    for (let discount = 0; discount <= 12; discount += 1) {
      for (let quantity = 1; quantity <= 7; quantity += 1) {
        expect(unitsDiscount(discount, quantity, 0)).toBe(0);
        expect(unitsDiscount(discount, quantity, quantity)).toBe(discount);
        for (let units = 0; units < quantity; units += 1) {
          expect(unitsDiscount(discount, quantity, units + 1)).toBeGreaterThanOrEqual(unitsDiscount(discount, quantity, units));
        }
      }
    }
  });
});

describe('refundLineAmount（今回の k 個の額 = 単価 · k − (disc(b + k) − disc(b))）', () => {
  it.each([
    ['値 A: X をまだ返していない時に 1 個', X, 1, 2666],
    ['値 A: X を 1 個返した後に 1 個（最後の返金で合計がぴったり）', { ...X, refundedUnits: 1 }, 1, 2667],
    ['値 A: X を 2 個まとめて', X, 2, 5333],
    ['値 A: Y をまだ返していない時に 2 個', Y, 2, 1778],
    ['値 A: Y を 2 個返した後に 1 個', { ...Y, refundedUnits: 2 }, 1, 889],
    ['値 B: 割引が 0 なら 単価 × 数', { ...X, lineDiscount: 0 }, 2, 6000],
  ] as const)('%s → %i', (_name, line, units, expected) => {
    expect(refundLineAmount(line, units)).toBe(expected);
  });

  it('1個ずつ順に返しても合計は「単価 × 数 − 割引の合計」になり、まとめて返した額と同じ', () => {
    const lines = [X, Y, { ...X, lineDiscount: 0 }, { itemPrice: 1000, quantity: 3, lineDiscount: 1, refundedUnits: 0 }];

    for (const base of lines) {
      let oneByOne = 0;
      for (let refundedUnits = 0; refundedUnits < base.quantity; refundedUnits += 1) {
        oneByOne += refundLineAmount({ ...base, refundedUnits }, 1);
      }

      expect(oneByOne).toBe(base.itemPrice * base.quantity - base.lineDiscount);
      expect(refundLineAmount(base, base.quantity)).toBe(oneByOne);
    }
  });
});

describe('交換の品の行（グループ E-3、本計画 P22）の額は、元の品の支払額 P を数で累積に割り振る', () => {
  // 値 D（Task 3 の DB 結合テストの private.return_units_amount と同じ値。TS と SQL の答えが食い違わないことを確かめる）:
  // 元の支払額 14999、数 3 → A(n) = floor((2·P·n + q) / (2·q)) で A(1) = 5000・A(2) = 9999・A(3) = 14999。
  // 1個ずつ返すと 5000・4999・5000、3個まとめて 14999
  const EXCHANGE = { itemPrice: 0, quantity: 3, lineDiscount: 0, refundedUnits: 0, exchangePaidAmount: 14999 } as const;

  it.each([
    ['値 D: まだ返していない時に 1 個', 0, 1, 5000],
    ['値 D: 1 個返した後に 1 個', 1, 1, 4999],
    ['値 D: 2 個返した後に 1 個', 2, 1, 5000],
    ['値 D: まだ返していない時に 3 個まとめて', 0, 3, 14999],
    ['値 D: 1 個返した後に 2 個', 1, 2, 9999],
  ] as const)('%s → %i', (_name, refundedUnits, units, expected) => {
    expect(refundLineAmount({ ...EXCHANGE, refundedUnits }, units)).toBe(expected);
  });

  it('1個ずつ順に返しても、合計は元の支払額にぴったり合う（端数が出ても合計が変わらない）', () => {
    let total = 0;
    for (let refundedUnits = 0; refundedUnits < EXCHANGE.quantity; refundedUnits += 1) {
      total += refundLineAmount({ ...EXCHANGE, refundedUnits }, 1);
    }

    expect(total).toBe(EXCHANGE.exchangePaidAmount);
  });

  it('元の支払額が0の交換の品は、いくつ返しても 0 円', () => {
    expect(refundLineAmount({ ...EXCHANGE, exchangePaidAmount: 0 }, 2)).toBe(0);
  });

  it('exchangePaidAmount が null か省かれた行は、ふつうの行の式（単価 · 数 − 割引の差）のまま', () => {
    expect(refundLineAmount({ ...X, exchangePaidAmount: null }, 1)).toBe(2666);
    expect(refundLineAmount(X, 1)).toBe(2666);
  });
});

describe('estimateRefund（交換の品の行を含む）', () => {
  const EXCHANGE_LINE = materialLine({
    orderItemId: 'item-ex', name: 'シルクブラウス', color: '黒', size: 'L', itemPrice: 0, quantity: 3, lineTotal: 0, unshipped: 3,
    restockable: 0, lineDiscount: 0, exchangePaidAmount: 14999,
  });

  it('交換の品の額は「商品」に入れ、「割引」には入れない。値 D: 2個選ぶと 商品 9999・割引 0・合計 9999', () => {
    expect(estimateRefund([EXCHANGE_LINE], [{ orderItemId: 'item-ex', beforeShipment: true, quantity: 2 }], 0)).toEqual({
      itemsAmount: 9999, discountAmount: 0, shippingAmount: 0, total: 9999,
    });
  });

  it('前に1個返した交換の品をもう1個選ぶと 4999（前に返した数 refundedUnits から割り振る）', () => {
    const afterOne = { ...EXCHANGE_LINE, refundedUnits: 1, refundedBeforeShipment: 1, unshipped: 2 };

    expect(estimateRefund([afterOne], [{ orderItemId: 'item-ex', beforeShipment: true, quantity: 1 }], 0)).toEqual({
      itemsAmount: 4999, discountAmount: 0, shippingAmount: 0, total: 4999,
    });
  });

  it('ふつうの行と一緒に選ぶ: 値 A の X を 1 個（商品 3000・割引 334）と交換の品を 1 個（5000）・送料 500 → 商品 8000・割引 334・合計 8166', () => {
    const selections = [
      { orderItemId: 'item-x', beforeShipment: true, quantity: 1 },
      { orderItemId: 'item-ex', beforeShipment: true, quantity: 1 },
    ];

    expect(estimateRefund([LINE_X, EXCHANGE_LINE], selections, 500)).toEqual({
      itemsAmount: 8000, discountAmount: 334, shippingAmount: 500, total: 8166,
    });
  });
});

describe('estimateRefund', () => {
  it('選んだ数が無ければ、商品も割引も 0。送料だけが合計に入る', () => {
    expect(estimateRefund([LINE_X, LINE_Y], [], 500)).toEqual({
      itemsAmount: 0, discountAmount: 0, shippingAmount: 500, total: 500,
    });
  });

  it('値 A: X を 1 個選ぶと、商品 3000・割引 334（正の数）・合計 2666', () => {
    expect(estimateRefund([LINE_X, LINE_Y], [{ orderItemId: 'item-x', beforeShipment: true, quantity: 1 }], 0)).toEqual({
      itemsAmount: 3000, discountAmount: 334, shippingAmount: 0, total: 2666,
    });
  });

  it('値 A: 前に 1 個返した X をもう 1 個選ぶと、割引は 333・合計は 2667', () => {
    const afterOne = materialLine({ refundedUnits: 1, refundedBeforeShipment: 1, unshipped: 1 });

    expect(estimateRefund([afterOne], [{ orderItemId: 'item-x', beforeShipment: true, quantity: 1 }], 0)).toEqual({
      itemsAmount: 3000, discountAmount: 333, shippingAmount: 0, total: 2667,
    });
  });

  it('値 A: 商品を2つ選び、送料を足す。X を 1 個・Y を 2 個・送料 500 → 商品 5000・割引 556・合計 4944', () => {
    const selections = [
      { orderItemId: 'item-x', beforeShipment: true, quantity: 1 },
      { orderItemId: 'item-y', beforeShipment: true, quantity: 2 },
    ];

    expect(estimateRefund([LINE_X, LINE_Y], selections, 500)).toEqual({
      itemsAmount: 5000, discountAmount: 556, shippingAmount: 500, total: 4944,
    });
  });

  it('値 A: 2回に分けて全部返すと、合計は 商品の合計 9000 − 割引 1000 = 8000 にぴったり合う', () => {
    const first = estimateRefund(
      [LINE_X, LINE_Y],
      [{ orderItemId: 'item-x', beforeShipment: true, quantity: 1 }, { orderItemId: 'item-y', beforeShipment: true, quantity: 2 }],
      0,
    );
    // 1回目で返した数（X は 1 個、Y は 2 個）を、材料の refundedUnits に入れて読み直した形
    const second = estimateRefund(
      [materialLine({ refundedUnits: 1, unshipped: 1 }), { ...LINE_Y, refundedUnits: 2, unshipped: 1 }],
      [{ orderItemId: 'item-x', beforeShipment: true, quantity: 1 }, { orderItemId: 'item-y', beforeShipment: true, quantity: 1 }],
      0,
    );

    expect(first.total).toBe(4444);
    expect(second.total).toBe(3556);
    expect(first.total + second.total).toBe(8000);
  });

  it('同じ返金に同じ商品の発送前と発送後の選びがあっても、合計は発送前 → 発送後に分けて数えた額の和と同じで、並べた順に依らない（行ごとの額の順は DB が確かめる）。値 A: 2666 + 2667', () => {
    const shippedOne = materialLine({ shipped: 1, unshipped: 1, shippedRefundable: 1 });
    const beforeShipment = { orderItemId: 'item-x', beforeShipment: true, quantity: 1 };
    const afterShipment = { orderItemId: 'item-x', beforeShipment: false, quantity: 1 };

    // 発送前の 1 個は b = 0 で 2666。続けて発送後の 1 個は b = 0 + 1 で 2667
    const first = estimateRefund([shippedOne], [beforeShipment], 0);
    const second = estimateRefund([{ ...shippedOne, refundedUnits: 1 }], [afterShipment], 0);
    expect(first.total).toBe(2666);
    expect(second.total).toBe(2667);

    // 同じ返金に2つとも入れると、商品の額 6000（割引の前）・割引 667（正の数）・合計 5333 = 2666 + 2667。選びを並べた順は関係しない
    const together = { itemsAmount: 6000, discountAmount: 667, shippingAmount: 0, total: 5333 };
    expect(estimateRefund([shippedOne], [beforeShipment, afterShipment], 0)).toEqual(together);
    expect(estimateRefund([shippedOne], [afterShipment, beforeShipment], 0)).toEqual(together);
    expect(first.total + second.total).toBe(together.total);
  });

  it('値 B: 割引が 0 の商品は、単価 × 数がそのまま合計になる', () => {
    const noDiscount = materialLine({ lineDiscount: 0 });

    expect(estimateRefund([noDiscount], [{ orderItemId: 'item-x', beforeShipment: true, quantity: 2 }], 500)).toEqual({
      itemsAmount: 6000, discountAmount: 0, shippingAmount: 500, total: 6500,
    });
  });

  it('数が1に満たない・整数でない・材料に無い商品の選びは数えない', () => {
    const selections = [
      { orderItemId: 'item-x', beforeShipment: true, quantity: 0 },
      { orderItemId: 'item-x', beforeShipment: true, quantity: -1 },
      { orderItemId: 'item-x', beforeShipment: true, quantity: 1.5 },
      { orderItemId: 'item-x', beforeShipment: true, quantity: Number.NaN },
      { orderItemId: 'item-unknown', beforeShipment: true, quantity: 2 },
    ];

    expect(estimateRefund([LINE_X, LINE_Y], selections, 0)).toEqual({
      itemsAmount: 0, discountAmount: 0, shippingAmount: 0, total: 0,
    });
  });
});

describe('selectsAllUnshipped（発送が0で、残りの未発送を全部、発送前として選んだか）', () => {
  const selectAll = [
    { orderItemId: 'item-x', beforeShipment: true, quantity: 2 },
    { orderItemId: 'item-y', beforeShipment: true, quantity: 3 },
  ];

  it('全部の商品の未発送を、発送前として選んでいれば true', () => {
    expect(selectsAllUnshipped(materials(), selectAll)).toBe(true);
  });

  it('商品を1つ選んでいなければ false', () => {
    expect(selectsAllUnshipped(materials(), selectAll.slice(0, 1))).toBe(false);
    expect(selectsAllUnshipped(materials(), [])).toBe(false);
  });

  it('1つの商品で、未発送より1個でも少なければ false', () => {
    const oneShort = [selectAll[0], { orderItemId: 'item-y', beforeShipment: true, quantity: 2 }];

    expect(selectsAllUnshipped(materials(), oneShort)).toBe(false);
  });

  it('発送後の商品として選んだ数は、未発送の全部には数えない', () => {
    const afterShipment = [selectAll[0], { orderItemId: 'item-y', beforeShipment: false, quantity: 3 }];

    expect(selectsAllUnshipped(materials(), afterShipment)).toBe(false);
  });

  it('1つでも発送している注文は、未発送を全部選んでも false（送料と返金額を全部に固定しない）', () => {
    expect(selectsAllUnshipped(materials({ shippedTotal: 1 }), selectAll)).toBe(false);
  });

  it('もう未発送の商品が1つも残っていない注文は false（全部選ぶ物が無い）', () => {
    const nothingLeft = materials({ lines: [materialLine({ unshipped: 0, refundedBeforeShipment: 2, refundedUnits: 2 })] });

    expect(selectsAllUnshipped(nothingLeft, [])).toBe(false);
  });

  it('未発送が残っていない商品には選びが要らない（前に全部返した商品があっても、残りを全部選べば true）', () => {
    const refundedBefore = materialLine({ orderItemId: 'item-done', unshipped: 0, refundedBeforeShipment: 1, refundedUnits: 1 });

    expect(selectsAllUnshipped(materials({ lines: [refundedBefore, LINE_X] }), [selectAll[0]])).toBe(true);
  });
});

describe('画面からも読めること', () => {
  it('サーバーだけの物を import しない（型だけの import に限る）', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/orders/refund/refund-allocation.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(specifiers).toEqual(['@/lib/orders/refund/refund-types']);
    expect(source.match(/^import /gm)).toHaveLength(source.match(/^import type /gm)?.length ?? -1);
  });
});
