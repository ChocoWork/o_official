import type { JwtPayload } from '@/lib/jwt';

export const STAFF_TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
export const STAFF_TEST_SESSION_ID = '22222222-2222-4222-8222-222222222222';

/** 管理の入口を通る店員の claims（aal1・今の時刻の passkey・印は真）。overrides で上書きする（Task 9 が偽装の元にする）。 */
export function staffEntryClaims(overrides: Record<string, unknown> = {}): JwtPayload {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    sub: STAFF_TEST_USER_ID,
    email: 'staff@example.com',
    aal: 'aal1',
    amr: [{ method: 'passkey', timestamp: nowSeconds }],
    staff_passkeys_ok: true,
    session_id: STAFF_TEST_SESSION_ID,
    ...overrides,
  };
}

/** `passkey_approved_count` の RPC の戻りを差す（ほかの RPC は空で返す）。 */
export function mockApprovedCount(
  rpcMock: { mockImplementation: (fn: (...args: any[]) => unknown) => unknown },
  count: number,
): void {
  rpcMock.mockImplementation(async (name: string) =>
    name === 'passkey_approved_count' ? { data: count, error: null } : { data: null, error: null });
}

export type AmrCase = {
  name: string;
  claims: unknown;
  /** DB の `staff_passkey_amr_ok` の期待（条件1・2） */
  amrOk: boolean;
  /** TS の `evaluateStaffEntry` の理由（本数は足りている前提） */
  reason?: 'no_passkey' | 'passkey_expired';
};

/** 条件1・2の値の表。TS の単体試験と DB 結合試験が同じ表を使う。 */
export function amrCases(now: number): AmrCase[] {
  const pk = (timestamp: unknown) => ({ method: 'passkey', timestamp });
  const c = (name: string, amr: unknown, amrOk: boolean, reason?: AmrCase['reason']): AmrCase =>
    ({ name, claims: { amr }, amrOk, reason });
  return [
    c('今の時刻', [pk(now)], true),
    c('ちょうど86400秒前は通す', [pk(now - 86400)], true),
    c('86401秒前は期限切れ', [pk(now - 86401)], false, 'passkey_expired'),
    c('未来の時刻は断る', [pk(now + 1)], false, 'passkey_expired'),
    c('古い passkey と新しい passkey は新しい方で見る', [pk(now - 100000), pk(now - 5)], true),
    c('新しい passkey と古い passkey でも新しい方で見る', [pk(now - 5), pk(now - 100000)], true),
    c('有効な passkey と未来の passkey は未来の方が最新なので断る', [pk(now), pk(now + 60)], false, 'passkey_expired'),
    c('未来の passkey と有効な passkey も同じく断る', [pk(now + 60), pk(now)], false, 'passkey_expired'),
    c('古い passkey だけは期限切れ', [pk(now - 100000)], false, 'passkey_expired'),
    c('otp が古くても passkey が新しければ通す', [{ method: 'otp', timestamp: now - 999999 }, pk(now)], true),
    c('amr が空の配列', [], false, 'no_passkey'),
    c('amr が配列でなく文字列', 'passkey', false, 'no_passkey'),
    c('amr がオブジェクト', pk(now), false, 'no_passkey'),
    c('amr が null', null, false, 'no_passkey'),
    c('oauth だけ', [{ method: 'oauth', timestamp: now }], false, 'no_passkey'),
    c('otp だけ', [{ method: 'otp', timestamp: now }], false, 'no_passkey'),
    c('要素が文字列', ['passkey'], false, 'no_passkey'),
    c('timestamp が文字列', [pk(String(now))], false, 'no_passkey'),
    c('timestamp が無い', [{ method: 'passkey' }], false, 'no_passkey'),
    c('timestamp が null', [pk(null)], false, 'no_passkey'),
    c('timestamp が小数', [pk(now - 0.5)], false, 'no_passkey'),
    c('method の大文字小文字違い', [{ method: 'Passkey', timestamp: now }], false, 'no_passkey'),
    { name: 'amr の欄が無い', claims: {}, amrOk: false, reason: 'no_passkey' },
    { name: 'claims が null', claims: null, amrOk: false, reason: 'no_passkey' },
  ];
}
