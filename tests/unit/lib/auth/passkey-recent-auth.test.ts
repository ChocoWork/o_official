import { evaluateRegistrationAccess } from '@/lib/auth/passkey-recent-auth';

const NOW = 1_800_000_000;
const passkeyAt = (ts: unknown) => ({ amr: [{ method: 'passkey', timestamp: ts }] });
const staff = (over: Partial<Parameters<typeof evaluateRegistrationAccess>[0]> = {}) =>
  evaluateRegistrationAccess({ claims: null, isStaff: true, windowOpen: false, approvedCount: 0, nowSeconds: NOW, ...over });
const customer = (claims: { amr?: unknown } | null) =>
  evaluateRegistrationAccess({ claims, isStaff: false, windowOpen: false, approvedCount: 0, nowSeconds: NOW });

describe('DD-AUTH-056 evaluateRegistrationAccess（店員）', () => {
  test.each([0, 1])('DD-AUTH-056 窓が開いていて認めた鍵が %i 本なら window', (count) => {
    expect(staff({ windowOpen: true, approvedCount: count })).toEqual({ ok: true, mode: 'window' });
  });

  test.each([2, 3, Number.NaN, 1.5])(
    'DD-AUTH-056 窓が開いていても認めた鍵が %p なら reauth_required（窓の免除は2本未満だけ。整数でない値は閉じる側）',
    (count) => {
      expect(staff({ windowOpen: true, approvedCount: count })).toEqual({ ok: false, reason: 'reauth_required' });
    },
  );

  test('DD-AUTH-056 窓が閉じていて passkey の印も無ければ window_closed', () => {
    expect(staff({ windowOpen: false })).toEqual({ ok: false, reason: 'window_closed' });
    expect(staff({ claims: { amr: [{ method: 'otp', timestamp: NOW }] } })).toEqual({ ok: false, reason: 'window_closed' });
  });

  test('DD-AUTH-056 5分以内のパスキーの入り直しは reauth（窓が閉じていても・鍵が2本以上でも）', () => {
    expect(staff({ claims: passkeyAt(NOW - 10), approvedCount: 5 })).toEqual({ ok: true, mode: 'reauth' });
    expect(staff({ claims: passkeyAt(NOW - 300), windowOpen: true, approvedCount: 1 })).toEqual({ ok: true, mode: 'reauth' });
  });

  test('DD-AUTH-056 認めた鍵が0本の店員は、5分以内のパスキーの入り直しでも reauth にならない（窓だけ）', () => {
    expect(staff({ claims: passkeyAt(NOW - 10), approvedCount: 0 })).toEqual({ ok: false, reason: 'reauth_required' });
    expect(staff({ claims: passkeyAt(NOW - 10), approvedCount: 0, windowOpen: true })).toEqual({ ok: true, mode: 'window' });
    expect(staff({ claims: passkeyAt(NOW - 10), approvedCount: Number.NaN })).toEqual({ ok: false, reason: 'reauth_required' });
  });

  test('DD-AUTH-056 301秒前は reauth にならず、窓が閉じていれば reauth_required', () => {
    expect(staff({ claims: passkeyAt(NOW - 301), approvedCount: 1 })).toEqual({ ok: false, reason: 'reauth_required' });
  });

  test('DD-AUTH-056 古い入り直しでも、窓が開いていて2本未満なら window', () => {
    expect(staff({ claims: passkeyAt(NOW - 301), windowOpen: true, approvedCount: 1 })).toEqual({ ok: true, mode: 'window' });
  });

  test('DD-AUTH-056 未来60秒までは時計のずれで通り、61秒先は断る', () => {
    expect(staff({ claims: passkeyAt(NOW + 60), approvedCount: 1 })).toEqual({ ok: true, mode: 'reauth' });
    expect(staff({ claims: passkeyAt(NOW + 61), approvedCount: 1 })).toEqual({ ok: false, reason: 'reauth_required' });
  });

  test('DD-AUTH-056 時刻が欠ける・文字列・小数・amr が配列でない要素は無いものとして扱う', () => {
    expect(staff({ claims: { amr: [{ method: 'passkey' }] } })).toEqual({ ok: false, reason: 'window_closed' });
    expect(staff({ claims: passkeyAt(String(NOW)) })).toEqual({ ok: false, reason: 'window_closed' });
    expect(staff({ claims: passkeyAt(NOW + 0.5) })).toEqual({ ok: false, reason: 'window_closed' });
    expect(staff({ claims: { amr: 'passkey' } })).toEqual({ ok: false, reason: 'window_closed' });
    expect(staff({ claims: { amr: [null, 3, 'x'] } })).toEqual({ ok: false, reason: 'window_closed' });
  });

  test('DD-AUTH-056 最新の passkey の時刻で見る（古い印と新しい印が並ぶ）', () => {
    const claims = { amr: [{ method: 'passkey', timestamp: NOW - 5000 }, { method: 'passkey', timestamp: NOW - 20 }] };
    expect(staff({ claims, approvedCount: 1 })).toEqual({ ok: true, mode: 'reauth' });
  });
});

describe('DD-AUTH-056 evaluateRegistrationAccess（お客さん）', () => {
  test.each(['passkey', 'otp'])('DD-AUTH-056 %s で599・600秒前は customer、601秒前は reauth_required', (method) => {
    expect(customer({ amr: [{ method, timestamp: NOW - 599 }] })).toEqual({ ok: true, mode: 'customer' });
    expect(customer({ amr: [{ method, timestamp: NOW - 600 }] })).toEqual({ ok: true, mode: 'customer' });
    expect(customer({ amr: [{ method, timestamp: NOW - 601 }] })).toEqual({ ok: false, reason: 'reauth_required' });
  });

  test('DD-AUTH-056 oauth だけ・amr 無し・claims 無しは reauth_required', () => {
    expect(customer({ amr: [{ method: 'oauth', timestamp: NOW }] })).toEqual({ ok: false, reason: 'reauth_required' });
    expect(customer({})).toEqual({ ok: false, reason: 'reauth_required' });
    expect(customer(null)).toEqual({ ok: false, reason: 'reauth_required' });
  });

  test('DD-AUTH-056 窓や認めた鍵の数はお客さんには効かない', () => {
    expect(
      evaluateRegistrationAccess({
        claims: { amr: [{ method: 'otp', timestamp: NOW - 1 }] },
        isStaff: false,
        windowOpen: true,
        approvedCount: 9,
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: true, mode: 'customer' });
  });
});
