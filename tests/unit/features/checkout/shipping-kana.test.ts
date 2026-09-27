import {
  buildShippingSnapshot,
  checkoutShippingSchema,
  findMissingShippingFields,
} from '@/features/checkout/services/checkout-draft.service';

/**
 * 注文にフリガナを残す（FREQ-384、レビュー指摘⑬）。
 *
 * checkout で必須にしているフリガナ（FREQ-349）が、送信の中身にも配送先の写しにも無く、
 * ゲストの注文では入力させたまま捨てていた。
 */
describe('配送先のフリガナ', () => {
  const shipping = {
    email: ' Guest@Example.com ',
    fullName: ' 山田 花子 ',
    kanaName: ' ヤマダ ハナコ ',
    postalCode: '150-0001',
    prefecture: '東京都',
    city: '渋谷区',
    address: '神宮前1-1-1',
    building: '',
    phone: '03-1111-2222',
  };

  it('フリガナを受け取り、前後の空白を落とす', () => {
    expect(checkoutShippingSchema.parse(shipping)?.kanaName).toBe('ヤマダ ハナコ');
  });

  it('配送先の写しにフリガナが入る', () => {
    expect(buildShippingSnapshot(checkoutShippingSchema.parse(shipping))).toMatchObject({
      fullName: '山田 花子',
      kanaName: 'ヤマダ ハナコ',
    });
  });

  it('フリガナが無いときは null にする', () => {
    const parsed = checkoutShippingSchema.parse({ ...shipping, kanaName: '' });
    expect(buildShippingSnapshot(parsed)).toMatchObject({ kanaName: null });
  });

  it('注文に必要な項目の検証では、フリガナを欠落扱いにしない', () => {
    // 以前の draft にはフリガナが無い。欠落として扱うと、正常な注文が毎回監査ログに出る。
    const snapshot = { ...buildShippingSnapshot(checkoutShippingSchema.parse(shipping)), kanaName: null };
    expect(findMissingShippingFields(snapshot)).toEqual([]);
  });
});
