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

/**
 * 古い試験の名前（aal1・aal2）を管理の入口の条件に読み替える（SR-AUTH-014）。'aal2' は入口を通る店員の claims、
 * それ以外は passkey の無い通行証（認めた本数に関わらず 403 MFA required になる側）。
 */
export function aalClaims(aal: string, overrides: Record<string, unknown> = {}): JwtPayload {
  return staffEntryClaims(aal === 'aal2' ? overrides : { ...overrides, amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) }] });
}

/**
 * claims のオブジェクトの中に `...aalFields('aal2')` と書けば、古い試験の `aal: 'aal2'` を管理の入口の条件に読み替える
 * （'aal2' は今の時刻の passkey の amr、それ以外は otp だけの amr。claims の aal は常に aal1）。
 */
export function aalFields(aal: string): { aal: string; amr: Array<{ method: string; timestamp: number }> } {
  const timestamp = Math.floor(Date.now() / 1000);
  return { aal: 'aal1', amr: [{ method: aal === 'aal2' ? 'passkey' : 'otp', timestamp }] };
}

/**
 * 認可の窓口が RPC `passkey_approved_count` で本数を数えるので、`createServiceRoleClient` の偽の service に、その RPC だけを足す。
 * 元の service の他の項目・`rpc` はそのまま（`rpc` が無ければ、他の名前の呼び出しは空で返す）。本数は既定 2。
 */
export function withApprovedCount<T extends object>(service: T, count: number | null = 2): T {
  const original = (service as { rpc?: (...args: unknown[]) => unknown }).rpc;
  return Object.assign(Object.create(service), {
    rpc: (name: string, ...rest: unknown[]) =>
      name === 'passkey_approved_count'
        ? Promise.resolve({ data: count, error: null })
        : original
          ? original.call(service, name, ...rest)
          : Promise.resolve({ data: null, error: null }),
  }) as T;
}

/** `passkey_approved_count` の RPC の戻りを差す（ほかの RPC は空で返す）。 */
export function mockApprovedCount(
  rpcMock: { mockImplementation: (fn: (...args: any[]) => unknown) => unknown },
  count: number,
): void {
  rpcMock.mockImplementation(async (name: string) =>
    name === 'passkey_approved_count' ? { data: count, error: null } : { data: null, error: null });
}

/** JSON の文字をそのまま出す数（`1.0` など。JSON.stringify が整数に直さない）。DB 結合の試験だけが使う。 */
export function rawJsonNumber(text: string): unknown {
  return (JSON as unknown as { rawJSON: (value: string) => unknown }).rawJSON(text);
}

export type AmrCase = {
  name: string;
  claims: unknown;
  /** DB 結合の試験が使う claims。JSON の文字が JS の値と違う場合（`1794861306.0` など）だけ指す。無ければ claims を使う。 */
  dbClaims?: unknown;
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
    c('1秒先の時刻は時計のずれとして通す', [pk(now + 1)], true),
    c('60秒先の時刻は時計のずれとして通す', [pk(now + 60)], true),
    c('61秒先の時刻は断る', [pk(now + 61)], false, 'passkey_expired'),
    c('古い passkey と新しい passkey は新しい方で見る', [pk(now - 100000), pk(now - 5)], true),
    c('新しい passkey と古い passkey でも新しい方で見る', [pk(now - 5), pk(now - 100000)], true),
    c('有効な passkey と61秒先の passkey は先の方が最新なので断る', [pk(now), pk(now + 61)], false, 'passkey_expired'),
    c('61秒先の passkey と有効な passkey も同じく断る', [pk(now + 61), pk(now)], false, 'passkey_expired'),
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
    c('timestamp が .5 の小数は断る', [pk(now + 0.5)], false, 'no_passkey'),
    // JSON の文字が `<now>.0` の整数値は通す（JS では整数、DB の3か所とも同じ）。DB 結合の試験だけ、文字のとおり `.0` を送る
    { name: 'timestamp が .0 の整数値は通す', claims: { amr: [pk(now)] },
      dbClaims: { amr: [pk(rawJsonNumber(`${now}.0`))] }, amrOk: true },
    c('method の大文字小文字違い', [{ method: 'Passkey', timestamp: now }], false, 'no_passkey'),
    { name: 'amr の欄が無い', claims: {}, amrOk: false, reason: 'no_passkey' },
    { name: 'claims が null', claims: null, amrOk: false, reason: 'no_passkey' },
  ];
}
