import { bundleVerdict, normalizeBundleEmail, type BundleOrder } from '@/lib/orders/shipment-slips/bundling';

/**
 * 同梱の判定（G-3 / FREQ-532）。DB の private.group_g_bundle_verdict と同じ組合せ表を、TS の bundleVerdict が同じ結果で返す。
 * 唯一の正は DB で、これは画面の候補の絞り込み用。DB 側の同じ組合せ表は tests/integration/db/group_g3_reads.integration.test.ts。
 */
type ShipTo = BundleOrder['shipTo'];

const SHIP_TO: ShipTo = {
  fullName: '山田 花子',
  postalCode: '150-0001',
  prefecture: '東京都',
  city: '渋谷区',
  address: '神南1-1-1',
  building: 'ビル101',
  phone: '03-0000-0000',
};

/** 会員の注文。メールアドレスは既定で会員ごとに別（会員のメールの違いは同梱の判定に関わらない） */
function member(userId: string, shipTo: Partial<ShipTo> = {}, email: string | null = `${userId}@example.com`): BundleOrder {
  return { userId, email, shipTo: { ...SHIP_TO, ...shipTo } };
}

function guest(email: string | null, shipTo: Partial<ShipTo> = {}): BundleOrder {
  return { userId: null, email, shipTo: { ...SHIP_TO, ...shipTo } };
}

describe('bundleVerdict: お客様', () => {
  test('FREQ-532-AC-01: 同じ会員の注文は、メールアドレスが違っても同梱できる', () => {
    expect(bundleVerdict([member('user-1', {}, 'a@example.com'), member('user-1', {}, 'b@example.com')])).toBeNull();
  });

  test('FREQ-532-AC-03: 別の会員は、同じメールアドレスでも同梱できない（別IDをメールで結ばない）', () => {
    expect(bundleVerdict([member('user-1', {}, 'same@example.com'), member('user-2', {}, 'same@example.com')])).toBe('customer_mismatch');
  });

  test('FREQ-532-AC-02: ゲスト同士は、同じメールアドレス（前後の空白と大文字小文字を除く）なら同梱できる', () => {
    expect(bundleVerdict([guest('Guest@Example.com'), guest('  guest@example.com ')])).toBeNull();
  });

  test('FREQ-532-AC-02: ゲスト同士でもメールアドレスが違えば同梱できない', () => {
    expect(bundleVerdict([guest('a@example.com'), guest('b@example.com')])).toBe('customer_mismatch');
  });

  test('FREQ-532-AC-03: 会員とゲストの混在は、同じメールアドレスでも同梱できない', () => {
    expect(bundleVerdict([member('user-1', {}, 'same@example.com'), guest('same@example.com')])).toBe('customer_mismatch');
    expect(bundleVerdict([guest('same@example.com'), member('user-1', {}, 'same@example.com')])).toBe('customer_mismatch');
  });

  test('FREQ-532-AC-01: 同じ注文が重なって渡されても、同じお客様・同じ配送先として扱う', () => {
    const order = member('user-1');
    expect(bundleVerdict([order, order])).toBeNull();
  });
});

describe('bundleVerdict: 配送先7項目', () => {
  const fields: Array<keyof ShipTo> = ['fullName', 'postalCode', 'prefecture', 'city', 'address', 'phone'];

  test.each(fields)('FREQ-532-AC-04: %s が違えば同梱できない', (field) => {
    expect(bundleVerdict([member('user-1'), member('user-1', { [field]: '違う値' })])).toBe('address_mismatch');
  });

  test('FREQ-532-AC-04: 建物が違えば同梱できない。片方だけ建物が空でも同梱できない', () => {
    expect(bundleVerdict([member('user-1'), member('user-1', { building: '別のビル' })])).toBe('address_mismatch');
    expect(bundleVerdict([member('user-1'), member('user-1', { building: null })])).toBe('address_mismatch');
    expect(bundleVerdict([member('user-1', { building: '' }), member('user-1', { building: 'ビル101' })])).toBe('address_mismatch');
  });

  test('FREQ-532-AC-04: 建物は、空・空白だけ・無し（null）を同じ空として比べる', () => {
    expect(bundleVerdict([member('user-1', { building: null }), member('user-1', { building: '' }), member('user-1', { building: '   ' })]))
      .toBeNull();
  });

  test('FREQ-532-AC-04: 各項目の前後の半角の空白は落として比べる。DB の btrim と同じく、タブ・全角の空白は落とさない', () => {
    expect(bundleVerdict([member('user-1'), member('user-1', { fullName: '  山田 花子 ', address: ' 神南1-1-1  ', building: ' ビル101 ' })])).toBeNull();
    expect(bundleVerdict([member('user-1'), member('user-1', { fullName: '山田 花子\t' })])).toBe('address_mismatch');
    expect(bundleVerdict([member('user-1'), member('user-1', { fullName: '山田 花子　' })])).toBe('address_mismatch');
  });

  test('FREQ-532-AC-04: 項目の中の空白と境目は残して比べる（つなげた文字列の衝突で一致にしない）', () => {
    expect(bundleVerdict([member('user-1', { city: '渋谷', address: '区神南' }), member('user-1', { city: '渋谷区', address: '神南' })]))
      .toBe('address_mismatch');
  });
});

describe('bundleVerdict: 欠損と評価の順', () => {
  const required: Array<keyof ShipTo> = ['fullName', 'postalCode', 'prefecture', 'city', 'address', 'phone'];

  test.each(required)('FREQ-532-AC-04: %s が空（空白だけを含む）の注文が1つでもあれば address_incomplete', (field) => {
    expect(bundleVerdict([member('user-1', { [field]: '' })])).toBe('address_incomplete');
    expect(bundleVerdict([member('user-1'), member('user-1', { [field]: '   ' })])).toBe('address_incomplete');
  });

  test('FREQ-532-AC-04: メールアドレスが無い・空白だけの注文は address_incomplete。建物が無いのは欠損ではない', () => {
    expect(bundleVerdict([member('user-1', {}, null)])).toBe('address_incomplete');
    expect(bundleVerdict([guest('   ')])).toBe('address_incomplete');
    expect(bundleVerdict([member('user-1', { building: null })])).toBeNull();
  });

  test('FREQ-532-AC-04: 1つも渡さなければ address_incomplete', () => {
    expect(bundleVerdict([])).toBe('address_incomplete');
  });

  test('FREQ-532-AC-05: 評価の順は 配送先の不足 → お客様の違い → 配送先の違い', () => {
    // 不足とお客様の違いが両方ある → 不足が先
    expect(bundleVerdict([member('user-1'), member('user-2', { phone: '' })])).toBe('address_incomplete');
    // お客様の違いと配送先の違いが両方ある → お客様の違いが先
    expect(bundleVerdict([member('user-1'), member('user-2', { city: '新宿区' })])).toBe('customer_mismatch');
    // 配送先の違いだけ
    expect(bundleVerdict([member('user-1'), member('user-1', { city: '新宿区' })])).toBe('address_mismatch');
  });

  test('FREQ-532-AC-05: 3件以上でも、1件だけ違えば拒否する', () => {
    expect(bundleVerdict([member('user-1'), member('user-1'), member('user-1', { postalCode: '160-0001' })])).toBe('address_mismatch');
    expect(bundleVerdict([guest('a@example.com'), guest('a@example.com'), guest('b@example.com')])).toBe('customer_mismatch');
    expect(bundleVerdict([guest('a@example.com'), guest('A@example.com '), guest(' a@example.com')])).toBeNull();
  });
});

describe('normalizeBundleEmail', () => {
  test.each([
    ['  Guest@Example.COM ', 'guest@example.com'],
    ['a@example.com', 'a@example.com'],
    ['   ', null],
    ['', null],
    [null, null],
  ] as const)('FREQ-532-AC-02: %j は %j', (input, expected) => {
    expect(normalizeBundleEmail(input)).toBe(expected);
  });
});
