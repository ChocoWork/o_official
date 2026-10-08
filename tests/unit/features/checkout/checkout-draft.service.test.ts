import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buyerOfCheckoutSession,
  checkoutShippingSchema,
  mapStripePaymentMethodType,
  normalizeCheckoutEmail,
} from '@/features/checkout/services/checkout-draft.service';

// 会員のログインのメール（create-session）を、ゲストが入力したメールと同じ整えにするための関数（グループ C・C7）
describe('normalizeCheckoutEmail', () => {
  test.each([
    ['小文字にそろえる', 'Member@Example.COM', 'member@example.com'],
    ['前後の空白を除く', '  member@example.com\t', 'member@example.com'],
    ['全角を半角（NFKC）にそろえる', 'ｍｅｍｂｅｒ＠ｅｘａｍｐｌｅ．ｃｏｍ', 'member@example.com'],
    ['整えが要らない値はそのまま', 'member@example.com', 'member@example.com'],
  ])('%s', (_label, input, expected) => {
    expect(normalizeCheckoutEmail(input)).toBe(expected);
  });

  test.each([
    ['メールアドレスの形でない値', 'not-an-email'],
    ['空白だけ', '   '],
    ['空文字', ''],
    ['254 文字を超える値', `${'a'.repeat(250)}@example.com`],
    ['文字列でない値', 42],
    ['null', null],
    ['未指定', undefined],
  ])('使えない値（%s）は undefined にする', (_label, input) => {
    expect(normalizeCheckoutEmail(input)).toBeUndefined();
  });

  // ゲストの入力（checkoutShippingSchema の email）と同じ結果になること。整えを2か所に書き分けて食い違わせない
  test.each([
    'Member@Example.COM',
    '  member@example.com\t',
    'ｍｅｍｂｅｒ＠ｅｘａｍｐｌｅ．ｃｏｍ',
    'member@example.com',
  ])('ゲストのメールの整え（checkoutShippingSchema）と同じ結果になる: %s', (input) => {
    expect(normalizeCheckoutEmail(input)).toBe(checkoutShippingSchema.parse({ email: input })?.email);
  });
});

describe('buyerOfCheckoutSession', () => {
  function clientWithResult(result: { data: unknown; error: unknown }) {
    const maybeSingle = jest.fn().mockResolvedValue(result);
    const eq = jest.fn().mockReturnValue({ maybeSingle });
    const select = jest.fn().mockReturnValue({ eq });
    const from = jest.fn().mockReturnValue({ select });
    return { client: { from } as unknown as SupabaseClient, from, select, eq };
  }

  test.each([
    ['会員の下書き', { buyer_user_id: 'member-a' }, 'member-a'],
    ['ゲストの下書き', { buyer_user_id: null }, null],
    ['下書きなし', null, undefined],
  ])('%s の買い手を返し、ゲストと下書きなしを区別する', async (_label, data, expected) => {
    const { client, from, select, eq } = clientWithResult({ data, error: null });

    await expect(buyerOfCheckoutSession(client, 'cs_test_paid')).resolves.toBe(expected);

    expect(from).toHaveBeenCalledWith('checkout_drafts');
    expect(select).toHaveBeenCalledWith('buyer_user_id');
    expect(eq).toHaveBeenCalledWith('checkout_session_id', 'cs_test_paid');
  });

  test('下書きの読み出しが失敗したら、買い手なしとして扱わず例外を返す', async () => {
    const error = { code: '08006', message: '読み出し失敗' };
    const { client } = clientWithResult({ data: null, error });

    await expect(buyerOfCheckoutSession(client, 'cs_test_paid')).rejects.toBe(error);
  });
});

describe('mapStripePaymentMethodType（レビュー指摘 C1）', () => {
  it('card は stripe_card に正規化する', () => {
    expect(mapStripePaymentMethodType('card')).toBe('stripe_card');
  });

  it('paypay は stripe_paypay に正規化する', () => {
    expect(mapStripePaymentMethodType('paypay')).toBe('stripe_paypay');
  });

  it('konbini は stripe_konbini に正規化する', () => {
    expect(mapStripePaymentMethodType('konbini')).toBe('stripe_konbini');
  });

  it('未対応の種別（link 等）は stripe_card に丸めず raw の文字列をそのまま返す', () => {
    expect(mapStripePaymentMethodType('link')).toBe('link');
    expect(mapStripePaymentMethodType('customer_balance')).toBe('customer_balance');
    expect(mapStripePaymentMethodType('alipay')).toBe('alipay');
  });

  it('値が無ければ既定値 stripe_card を返す', () => {
    expect(mapStripePaymentMethodType(undefined)).toBe('stripe_card');
  });
});
