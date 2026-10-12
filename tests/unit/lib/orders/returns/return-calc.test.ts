import fs from 'node:fs';
import path from 'node:path';
import { refundLineAmount } from '@/lib/orders/refund/refund-allocation';
import { buildReceiveButtonLabel, computeReturnRefundPreview, formatDeadline } from '@/lib/orders/returns/return-calc';

type PreviewInput = Parameters<typeof computeReturnRefundPreview>[0];

// 返品の返金の額の試験の値。E-2 の割り振りの値 A（tests/integration/db/order_refund_records.integration.test.ts の「値 A」と同じ）に合わせる:
// 商品 X は 3000 円 × 2（割引 667）、商品 Y は 1000 円 × 3（割引 333）。DB は返品の行ごとに、その行が指す注文の商品の
// 「今から k 点を返金した時の商品の額」の列を返す（同じ注文の商品を指す行は同じ列）。orderItemId の X・Y はその商品、Z は額の列が空の行
// （受付中でない返品など）が指す商品
const X_AMOUNTS = [2666, 5333];
const Y_AMOUNTS = [889, 1778, 2667];

function previewInput(overrides: Partial<PreviewInput> = {}): PreviewInput {
  return {
    lines: [{ orderItemId: 'X', refundAmountsByCount: X_AMOUNTS, count: 1 }],
    firstReceipt: true,
    hasExchangeInThisReceipt: false,
    firstExchangeReceipt: true,
    returnMethod: 'customer_ships',
    returnShippingFee: 0,
    restockingFeePercent: 0,
    exchangeFee: 0,
    exchangeShippingFee: 0,
    shippingRefund: 0,
    ...overrides,
  };
}

const NO_FEES = { returnShipping: 0, restocking: 0, exchange: 0, exchangeShipping: 0 };

describe('computeReturnRefundPreview（商品の額）', () => {
  it('商品の額の列は E-2 の割り振り（refundLineAmount）の値と同じ。1点ずつ返しても合計が合う', () => {
    const amounts = (line: { itemPrice: number; quantity: number; lineDiscount: number }) =>
      Array.from({ length: line.quantity }, (_, index) => refundLineAmount({ ...line, refundedUnits: 0 }, index + 1));

    expect(amounts({ itemPrice: 3000, quantity: 2, lineDiscount: 667 })).toEqual(X_AMOUNTS);
    expect(amounts({ itemPrice: 1000, quantity: 3, lineDiscount: 333 })).toEqual(Y_AMOUNTS);
    // X を 1 点返した後に、残りの 1 点を返す額は 2667。2666 + 2667 は 2 点まとめて返す額 5333 と同じ
    expect(refundLineAmount({ itemPrice: 3000, quantity: 2, lineDiscount: 667, refundedUnits: 1 }, 1)).toBe(2667);
    expect(2666 + 2667).toBe(X_AMOUNTS[1]);
  });

  it('手数料も送料も無い時は、選んだ数の商品の額がそのまま返金額になる', () => {
    expect(computeReturnRefundPreview(previewInput())).toEqual({ itemsAmount: 2666, fees: NO_FEES, refundAmount: 2666, feeDue: 0 });
    expect(computeReturnRefundPreview(previewInput({ lines: [{ orderItemId: 'X', refundAmountsByCount: X_AMOUNTS, count: 2 }] }))).toEqual({
      itemsAmount: 5333, fees: NO_FEES, refundAmount: 5333, feeDue: 0,
    });
  });

  it('返品の行が複数ある時は、注文の商品ごとの額を足す。数が0の行は数えない', () => {
    const lines = [
      { orderItemId: 'X', refundAmountsByCount: X_AMOUNTS, count: 2 },
      { orderItemId: 'Y', refundAmountsByCount: Y_AMOUNTS, count: 1 },
      { orderItemId: 'Y', refundAmountsByCount: Y_AMOUNTS, count: 0 },
    ];

    expect(computeReturnRefundPreview(previewInput({ lines })).itemsAmount).toBe(5333 + 889);
  });

  it('同じ注文の商品の行が2つある（2回に分けて送った品など）時は、数を足してから列を引く。行ごとに足すと割引の端数で 5332 になる', () => {
    const lines = [
      { orderItemId: 'X', refundAmountsByCount: X_AMOUNTS, count: 1 },
      { orderItemId: 'X', refundAmountsByCount: X_AMOUNTS, count: 1 },
    ];

    expect(computeReturnRefundPreview(previewInput({ lines })).itemsAmount).toBe(5333);
  });

  it('選んだ数が無ければ、商品の額も返金額も0。送料の返金だけが返金額に入る', () => {
    expect(computeReturnRefundPreview(previewInput({ lines: [], shippingRefund: 500 }))).toEqual({
      itemsAmount: 0, fees: NO_FEES, refundAmount: 500, feeDue: 0,
    });
  });

  it('送料の返金は、商品の額から手数料を引いた後に足す（手数料では減らない）', () => {
    expect(computeReturnRefundPreview(previewInput({ shippingRefund: 500 }))).toMatchObject({ itemsAmount: 2666, refundAmount: 3166 });
    expect(
      computeReturnRefundPreview(previewInput({ restockingFeePercent: 10, shippingRefund: 500 })),
    ).toMatchObject({ itemsAmount: 2666, refundAmount: 2400 + 500 });
  });

  it('数が1に満たない・整数でない行は数えない。列より多く指した数は、列の最後（返せる最大）で数える。列が空の行（受付中でない返品など）は額に入らない', () => {
    const preview = (count: number, amounts = X_AMOUNTS) =>
      computeReturnRefundPreview(previewInput({ lines: [{ orderItemId: 'X', refundAmountsByCount: amounts, count }] })).itemsAmount;

    expect(preview(0)).toBe(0);
    expect(preview(-1)).toBe(0);
    expect(preview(1.5)).toBe(0);
    expect(preview(Number.NaN)).toBe(0);
    expect(preview(5)).toBe(5333);
    expect(preview(2, [])).toBe(0);
  });

  it('受け取りで「返金に変える」にした交換の行は、DB が交換の予定の行にも返す額の列と数を渡せば、返金の行と同じに額へ入る', () => {
    const refundLine = { orderItemId: 'X', refundAmountsByCount: X_AMOUNTS, count: 1 };
    const changedToRefund = { orderItemId: 'Y', refundAmountsByCount: Y_AMOUNTS, count: 2 };

    expect(computeReturnRefundPreview(previewInput({ lines: [refundLine, changedToRefund] })).itemsAmount).toBe(2666 + 1778);
  });
});

describe('computeReturnRefundPreview（返品の手数料）', () => {
  it.each([
    // [割合, 商品の額 2666 に対する手数料 floor(2666 × 割合 / 100), 返金額]
    [10, 266, 2400],
    [33, 879, 1787],
    [1, 26, 2640],
    [100, 2666, 0],
  ])('返品の手数料 %i%% → 手数料 %i 円（端数は切り捨て）、返金額 %i 円', (percent, fee, refund) => {
    expect(computeReturnRefundPreview(previewInput({ restockingFeePercent: percent }))).toEqual({
      itemsAmount: 2666, fees: { ...NO_FEES, restocking: fee }, refundAmount: refund, feeDue: 0,
    });
  });

  it('割合は、この受け取りで返金する品の商品の額に対して付く（2点なら 5333 の 10% = 533）', () => {
    const preview = computeReturnRefundPreview(
      previewInput({ lines: [{ orderItemId: 'X', refundAmountsByCount: X_AMOUNTS, count: 2 }], restockingFeePercent: 10 }),
    );

    expect(preview).toMatchObject({ itemsAmount: 5333, fees: { restocking: 533 }, refundAmount: 4800, feeDue: 0 });
  });

  it('割合が0なら手数料は付かない', () => {
    expect(computeReturnRefundPreview(previewInput({ restockingFeePercent: 0 })).fees.restocking).toBe(0);
  });
});

describe('computeReturnRefundPreview（返送料）', () => {
  const SHOP_LABEL = { returnMethod: 'shop_label', returnShippingFee: 800 } as const;

  it('お店の送り状の返品は、最初の受け取りで定額を引く', () => {
    expect(computeReturnRefundPreview(previewInput(SHOP_LABEL))).toEqual({
      itemsAmount: 2666, fees: { ...NO_FEES, returnShipping: 800 }, refundAmount: 1866, feeDue: 0,
    });
  });

  it.each([
    ['2回目以降の受け取り', { ...SHOP_LABEL, firstReceipt: false }],
    ['お客様が送る返品', { returnMethod: 'customer_ships', returnShippingFee: 800 }],
    ['返送不要の返品', { returnMethod: 'not_required', returnShippingFee: 800 }],
  ] as const)('%s には返送料を付けない', (_name, overrides) => {
    expect(computeReturnRefundPreview(previewInput(overrides))).toMatchObject({
      fees: NO_FEES, refundAmount: 2666, feeDue: 0,
    });
  });

  it('返金の品も交換の品も無い受け取り（お返しだけ）には付けない', () => {
    const preview = computeReturnRefundPreview(
      previewInput({ ...SHOP_LABEL, lines: [{ orderItemId: 'X', refundAmountsByCount: X_AMOUNTS, count: 0 }] }),
    );

    expect(preview).toEqual({ itemsAmount: 0, fees: NO_FEES, refundAmount: 0, feeDue: 0 });
  });

  it('交換の品だけの受け取りには付ける。商品の額が無いので、全額がお支払い待ち（feeDue）になる', () => {
    const preview = computeReturnRefundPreview(
      previewInput({ ...SHOP_LABEL, lines: [{ orderItemId: 'Z', refundAmountsByCount: [], count: 1 }], hasExchangeInThisReceipt: true }),
    );

    expect(preview).toEqual({ itemsAmount: 0, fees: { ...NO_FEES, returnShipping: 800 }, refundAmount: 0, feeDue: 800 });
  });
});

describe('computeReturnRefundPreview（交換の手数料と送料）', () => {
  const EXCHANGE = { exchangeFee: 500, exchangeShippingFee: 300 };

  it('交換の品のある最初の受け取りで、交換の手数料と交換の送料を引く', () => {
    expect(
      computeReturnRefundPreview(previewInput({ ...EXCHANGE, hasExchangeInThisReceipt: true, firstExchangeReceipt: true })),
    ).toEqual({ itemsAmount: 2666, fees: { ...NO_FEES, exchange: 500, exchangeShipping: 300 }, refundAmount: 1866, feeDue: 0 });
  });

  it.each([
    ['交換の品のある2回目以降の受け取り', { hasExchangeInThisReceipt: true, firstExchangeReceipt: false }],
    ['交換の品が無い受け取り', { hasExchangeInThisReceipt: false, firstExchangeReceipt: true }],
  ])('%s には付けない', (_name, overrides) => {
    expect(computeReturnRefundPreview(previewInput({ ...EXCHANGE, ...overrides })).fees).toEqual(NO_FEES);
  });

  it('交換だけの受け取りでは、手数料と送料の全額が feeDue になる（返金額は0）', () => {
    const preview = computeReturnRefundPreview(
      previewInput({ ...EXCHANGE, lines: [], hasExchangeInThisReceipt: true, firstExchangeReceipt: true }),
    );

    expect(preview).toEqual({
      itemsAmount: 0, fees: { ...NO_FEES, exchange: 500, exchangeShipping: 300 }, refundAmount: 0, feeDue: 800,
    });
  });
});

describe('computeReturnRefundPreview（手数料の組み合わせ）', () => {
  it('4つの手数料が全部付く: X を2点（5333）、返送料 800・返品の手数料 10%（533）・交換の手数料 500・交換の送料 300 → 返金額 3200', () => {
    const preview = computeReturnRefundPreview(
      previewInput({
        lines: [{ orderItemId: 'X', refundAmountsByCount: X_AMOUNTS, count: 2 }],
        hasExchangeInThisReceipt: true,
        returnMethod: 'shop_label',
        returnShippingFee: 800,
        restockingFeePercent: 10,
        exchangeFee: 500,
        exchangeShippingFee: 300,
      }),
    );

    expect(preview).toEqual({
      itemsAmount: 5333,
      fees: { returnShipping: 800, restocking: 533, exchange: 500, exchangeShipping: 300 },
      refundAmount: 3200,
      feeDue: 0,
    });
  });

  it('手数料が商品の額を超える: Y を1点（889）、返送料 800・返品の手数料 20%（177）→ 返金額は0、引けない 88 円は feeDue', () => {
    const preview = computeReturnRefundPreview(
      previewInput({
        lines: [{ orderItemId: 'Y', refundAmountsByCount: Y_AMOUNTS, count: 1 }],
        returnMethod: 'shop_label',
        returnShippingFee: 800,
        restockingFeePercent: 20,
      }),
    );

    expect(preview).toEqual({
      itemsAmount: 889, fees: { ...NO_FEES, returnShipping: 800, restocking: 177 }, refundAmount: 0, feeDue: 88,
    });
  });

  it('手数料が商品の額を超えても、送料の返金は返金額に残る（返金額 = 0 + 500）', () => {
    const preview = computeReturnRefundPreview(
      previewInput({
        lines: [{ orderItemId: 'Y', refundAmountsByCount: Y_AMOUNTS, count: 1 }],
        returnMethod: 'shop_label',
        returnShippingFee: 800,
        restockingFeePercent: 20,
        shippingRefund: 500,
      }),
    );

    expect(preview).toMatchObject({ refundAmount: 500, feeDue: 88 });
  });

  it('SQL と同じ値の例（Task 3 の DB 結合テストが、同じ入力で同じ額を確かめる）', () => {
    // R1 手数料なし: X を1点 → 2666
    expect(computeReturnRefundPreview(previewInput())).toMatchObject({ refundAmount: 2666, feeDue: 0 });
    // R2 返送料 800（最初の受け取り）と返品の手数料 10%: X を2点 → 5333 − (800 + 533) = 4000
    expect(
      computeReturnRefundPreview(
        previewInput({
          lines: [{ orderItemId: 'X', refundAmountsByCount: X_AMOUNTS, count: 2 }],
          returnMethod: 'shop_label',
          returnShippingFee: 800,
          restockingFeePercent: 10,
        }),
      ),
    ).toMatchObject({ itemsAmount: 5333, refundAmount: 4000, feeDue: 0 });
    // R3 交換だけ（返送料 800・交換の手数料 500・交換の送料 300）→ 返金なし、お支払い待ち 1600
    expect(
      computeReturnRefundPreview(
        previewInput({
          lines: [],
          hasExchangeInThisReceipt: true,
          returnMethod: 'shop_label',
          returnShippingFee: 800,
          exchangeFee: 500,
          exchangeShippingFee: 300,
        }),
      ),
    ).toMatchObject({ itemsAmount: 0, refundAmount: 0, feeDue: 1600 });
    // R4 手数料が商品の額を超える: Y を1点（889）、返送料 800 と 20%（177）→ 返金なし、お支払い待ち 88
    expect(
      computeReturnRefundPreview(
        previewInput({
          lines: [{ orderItemId: 'Y', refundAmountsByCount: Y_AMOUNTS, count: 1 }],
          returnMethod: 'shop_label',
          returnShippingFee: 800,
          restockingFeePercent: 20,
        }),
      ),
    ).toMatchObject({ itemsAmount: 889, refundAmount: 0, feeDue: 88 });
  });

  it('どの組み合わせでも: 返金額（送料を除く）− feeDue = 商品の額 − 手数料の合計。返金額と feeDue は同時に正にならない', () => {
    for (const count of [0, 1, 2]) {
      for (const percent of [0, 10, 100]) {
        for (const returnShippingFee of [0, 800, 5000]) {
          for (const hasExchangeInThisReceipt of [false, true]) {
            const input = previewInput({
              lines: [{ orderItemId: 'X', refundAmountsByCount: X_AMOUNTS, count }],
              hasExchangeInThisReceipt,
              returnMethod: 'shop_label',
              returnShippingFee,
              restockingFeePercent: percent,
              exchangeFee: 500,
              exchangeShippingFee: 300,
              shippingRefund: 200,
            });

            const { itemsAmount, fees, refundAmount, feeDue } = computeReturnRefundPreview(input);
            const feesTotal = fees.returnShipping + fees.restocking + fees.exchange + fees.exchangeShipping;

            expect(refundAmount - input.shippingRefund - feeDue).toBe(itemsAmount - feesTotal);
            expect(refundAmount).toBeGreaterThanOrEqual(input.shippingRefund);
            expect(feeDue).toBeGreaterThanOrEqual(0);
            expect((refundAmount - input.shippingRefund) * feeDue).toBe(0);
          }
        }
      }
    }
  });
});

describe('buildReceiveButtonLabel（受け取りの確定のボタンの言葉）', () => {
  function label(overrides: Partial<Parameters<typeof buildReceiveButtonLabel>[0]> = {}): string {
    return buildReceiveButtonLabel({
      checked: 1,
      remaining: 1,
      refundUnits: 1,
      exchangeUnits: 0,
      sentBackUnits: 0,
      refundChoice: 'now',
      refundAmount: 2666,
      actorCanRefund: true,
      ...overrides,
    });
  }

  it('返金の品があり今返金（額が0より大きい）: 残りを全部受け取るなら「すべて受け取って ￥{額} を返金する」', () => {
    expect(label()).toBe('すべて受け取って ￥2,666 を返金する');
  });

  it('返金の品があり今返金: 一部だけなら「{n}点を受け取って ￥{額} を返金する」', () => {
    expect(label({ checked: 1, remaining: 2 })).toBe('1点を受け取って ￥2,666 を返金する');
    expect(label({ checked: 2, remaining: 3, refundUnits: 2, refundAmount: 5333 })).toBe('2点を受け取って ￥5,333 を返金する');
  });

  it('返金の品があり今返金: 交換の品があれば、尾に「、交換の品を発送待ちにする」を足す', () => {
    expect(label({ exchangeUnits: 1, checked: 2, remaining: 2 })).toBe(
      'すべて受け取って ￥2,666 を返金する、交換の品を発送待ちにする',
    );
    expect(label({ exchangeUnits: 1, checked: 2, remaining: 3, refundAmount: 5333 })).toBe(
      '2点を受け取って ￥5,333 を返金する、交換の品を発送待ちにする',
    );
  });

  it('返金の品があり相談: 店長は「受け取りだけ記録する（返金は額を決めてから）」、サポートは「（額は店長が決める）」。点数や交換の有無で変わらない', () => {
    const admin = '受け取りだけ記録する（返金は額を決めてから）';
    const supporter = '受け取りだけ記録する（額は店長が決める）';

    expect(label({ refundChoice: 'consult' })).toBe(admin);
    expect(label({ refundChoice: 'consult', checked: 1, remaining: 3, exchangeUnits: 1 })).toBe(admin);
    expect(label({ refundChoice: 'consult', actorCanRefund: false })).toBe(supporter);
    expect(label({ refundChoice: 'consult', actorCanRefund: false, checked: 1, remaining: 3, sentBackUnits: 1 })).toBe(supporter);
  });

  it('返金の品が無く交換の品がある: 「すべて受け取り、交換の品を発送待ちにする」「{n}点を受け取り、交換の品を発送待ちにする」', () => {
    const exchangeOnly = { refundUnits: 0, exchangeUnits: 1, refundChoice: 'none', refundAmount: 0 } as const;

    expect(label({ ...exchangeOnly, checked: 1, remaining: 1 })).toBe('すべて受け取り、交換の品を発送待ちにする');
    expect(label({ ...exchangeOnly, checked: 2, remaining: 3, exchangeUnits: 2 })).toBe('2点を受け取り、交換の品を発送待ちにする');
  });

  it('お返しだけ: 「すべて受け取り、品物をお返しする」「{n}点を受け取り、品物をお返しする」', () => {
    const sentBackOnly = { refundUnits: 0, sentBackUnits: 1, refundChoice: 'none', refundAmount: 0 } as const;

    expect(label({ ...sentBackOnly, checked: 1, remaining: 1 })).toBe('すべて受け取り、品物をお返しする');
    expect(label({ ...sentBackOnly, checked: 1, remaining: 2 })).toBe('1点を受け取り、品物をお返しする');
  });

  it('交換の品とお返しが両方ある（返金の品は無い）時は、交換の言葉を使う', () => {
    expect(label({ refundUnits: 0, exchangeUnits: 1, sentBackUnits: 1, refundChoice: 'none', refundAmount: 0, checked: 2, remaining: 2 })).toBe(
      'すべて受け取り、交換の品を発送待ちにする',
    );
  });

  it('返金の品があり今返金でも、返金額が0円（手数料が商品の額以上、または額を0に直した）なら「返金なしで記録する」。返金の記録は作らない（P20）', () => {
    expect(label({ refundAmount: 0 })).toBe('すべて受け取り、返金なしで記録する');
    expect(label({ refundAmount: 0, checked: 1, remaining: 2 })).toBe('1点を受け取り、返金なしで記録する');
    expect(label({ refundAmount: 0, checked: 2, remaining: 3, refundUnits: 2 })).toBe('2点を受け取り、返金なしで記録する');
  });

  it('返金なしで記録する時も、交換の品があれば、尾に「、交換の品を発送待ちにする」を足す。お返しは言葉に出さない', () => {
    expect(label({ refundAmount: 0, exchangeUnits: 1, checked: 2, remaining: 2 })).toBe(
      'すべて受け取り、返金なしで記録する、交換の品を発送待ちにする',
    );
    expect(label({ refundAmount: 0, exchangeUnits: 1, checked: 2, remaining: 3 })).toBe(
      '2点を受け取り、返金なしで記録する、交換の品を発送待ちにする',
    );
    expect(label({ refundAmount: 0, sentBackUnits: 1, checked: 2, remaining: 3 })).toBe('2点を受け取り、返金なしで記録する');
  });

  it('返金額が0円でも、相談（consult）の言葉は変わらない。返金の記録を作るのは今返金だけ', () => {
    expect(label({ refundChoice: 'consult', refundAmount: 0 })).toBe('受け取りだけ記録する（返金は額を決めてから）');
  });

  it('それ以外（返金の品が無く、交換もお返しも無い）は「{n}点を受け取る」', () => {
    expect(label({ refundUnits: 0, refundChoice: 'none', refundAmount: 0, checked: 3, remaining: 3 })).toBe('3点を受け取る');
    // 返金の品が無いのに今返金が渡された（画面ではあり得ない）時は、返金の言葉を出さない
    expect(label({ refundUnits: 0, refundChoice: 'now', refundAmount: 2666, checked: 1, remaining: 2 })).toBe('1点を受け取る');
  });

  it('チェックした点数が残りの数以上なら「すべて」（残りより多く渡されても「すべて」）', () => {
    expect(label({ checked: 3, remaining: 2 })).toBe('すべて受け取って ￥2,666 を返金する');
  });
});

describe('formatDeadline（受付の期限の日付。M月D日）', () => {
  it.each([
    ['2026-10-20', '10月20日'],
    ['2026-10-05', '10月5日'],
    ['2026-01-05', '1月5日'],
    ['2026-12-31', '12月31日'],
  ])('日付 %s は %s（0を足さない。日付だけを返し、「受付の期限:」や「まで」は呼ぶ側が足す）', (date, expected) => {
    expect(formatDeadline(date)).toBe(expected);
  });

  it('期限が無い（無制限）時は「なし」。期限の文（受付の期限: なし）は呼ぶ側が組む', () => {
    expect(formatDeadline(null)).toBe('なし');
  });

  it('YYYY-MM-DD に読めない文字は、そのまま返す（DB は日本時間の日付だけを返す）', () => {
    expect(formatDeadline('invalid-date')).toBe('invalid-date');
    expect(formatDeadline('2026-10-05T01:00:00Z')).toBe('2026-10-05T01:00:00Z');
  });
});

describe('画面からも読めること', () => {
  it('サーバーだけの物を import しない（値を読むのは E-2 の formatYen を持つ refund-messages だけ。ほかは型だけ）', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/orders/returns/return-calc.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    const valueImports = [...source.matchAll(/^import (?!type\b)[^;]*?from '([^']+)'/gm)].map((match) => match[1]);

    expect([...specifiers].sort()).toEqual(['@/lib/orders/refund/refund-messages', '@/lib/orders/returns/return-types']);
    expect(valueImports).toEqual(['@/lib/orders/refund/refund-messages']);
  });
});
