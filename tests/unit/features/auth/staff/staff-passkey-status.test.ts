/**
 * DD-AUTH-082 店員の一覧と認めた本数を窓口から読む部品（src/features/auth/staff/staff-passkey-status.ts）の単体テスト。
 */
import { loadStaffPasskeys } from '@/features/auth/staff/staff-passkey-status';

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const fetchOf = (impl: () => Promise<Response>) => jest.fn(impl) as unknown as typeof import('@/lib/client-fetch').clientFetch;

const ITEM = { id: 'a', friendly_name: 'Mac', created_at: '2026-11-01T00:00:00Z', last_used_at: '2026-11-02T00:00:00Z', approved: true };

describe('loadStaffPasskeys', () => {
  it('DD-AUTH-082 一覧・店員か・認めた本数を読む。approved は真のときだけ真', async () => {
    const result = await loadStaffPasskeys(
      fetchOf(() => json(200, { isStaff: true, approvedCount: 2, passkeys: [ITEM, { ...ITEM, id: 'b', approved: 'yes' }] })),
    );
    expect(result).toEqual({
      ok: true,
      isStaff: true,
      approvedCount: 2,
      passkeys: [ITEM, { ...ITEM, id: 'b', approved: false }],
    });
  });

  it('DD-AUTH-082 名前・最後に使った日が文字列でなければ null、本数が整数でなければ 0、店員でなければ偽（お客さんの形）', async () => {
    const result = await loadStaffPasskeys(
      fetchOf(() =>
        json(200, {
          isStaff: false,
          approvedCount: 1.5,
          passkeys: [{ id: 'a', created_at: '2026-11-01T00:00:00Z', friendly_name: 5, last_used_at: 7 }],
        }),
      ),
    );
    expect(result).toEqual({
      ok: true,
      isStaff: false,
      approvedCount: 0,
      passkeys: [{ id: 'a', friendly_name: null, created_at: '2026-11-01T00:00:00Z', last_used_at: null, approved: false }],
    });
    const negative = await loadStaffPasskeys(fetchOf(() => json(200, { isStaff: true, approvedCount: -1, passkeys: [] })));
    expect(negative).toMatchObject({ ok: true, approvedCount: 0 });
  });

  it.each([
    [401, 'unauthorized'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
    [500, 'failed'],
  ])('DD-AUTH-082 窓口が %i なら %s（本文は捨てる）', async (status, reason) => {
    await expect(loadStaffPasskeys(fetchOf(() => json(status, { error: 'x' })))).resolves.toEqual({ ok: false, reason });
  });

  it.each([
    ['通信の失敗', () => Promise.reject(new TypeError('network'))],
    ['本文が JSON でない', () => Promise.resolve(new Response('not json', { status: 200 }))],
    ['本文が配列', () => json(200, [])],
    ['null', () => json(200, null)],
    ['passkeys が配列でない', () => json(200, { passkeys: 'x' })],
    ['行が null', () => json(200, { passkeys: [null] })],
    ['行の id が文字列でない', () => json(200, { passkeys: [{ id: 1, created_at: 'x' }] })],
    ['行の created_at が無い', () => json(200, { passkeys: [{ id: 'a' }] })],
  ])('DD-AUTH-082 %s は failed（閉じる側）', async (_label, impl) => {
    await expect(loadStaffPasskeys(fetchOf(impl))).resolves.toEqual({ ok: false, reason: 'failed' });
  });
});
