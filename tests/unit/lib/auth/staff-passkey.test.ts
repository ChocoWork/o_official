import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { defaultStaffPasskeySettings } from '@/lib/auth/staff-passkey-defaults';
import {
  STAFF_MAX_SESSION_SECONDS,
  STAFF_MIN_APPROVED_PASSKEYS,
  approvedCountHint,
  evaluateStaffEntry,
} from '@/lib/auth/staff-passkey';
import { amrCases, mockApprovedCount, staffEntryClaims } from '../../helpers/staff-claims';

const NOW = 1_800_000_000;

describe('staff passkey entry conditions', () => {
  it('DD-AUTH-047 定数は設定の初めの値と同じで、移行の既定値とも合う', () => {
    const d = defaultStaffPasskeySettings();
    expect(STAFF_MAX_SESSION_SECONDS).toBe(d.staffMaxSessionSeconds);
    expect(STAFF_MIN_APPROVED_PASSKEYS).toBe(d.minApprovedPasskeys);
    expect(STAFF_MAX_SESSION_SECONDS).toBe(86400);
    expect(STAFF_MIN_APPROVED_PASSKEYS).toBe(2);
    const dir = path.join(process.cwd(), 'supabase/migrations');
    const file = readdirSync(dir).find((f) => f.endsWith('_passkey_foundation_tables.sql')) as string;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    expect(/staff_max_session_seconds\s+integer\s+NOT\s+NULL\s+DEFAULT\s+86400/i.test(sql)).toBe(true);
    expect(/min_approved_passkeys\s+integer\s+NOT\s+NULL\s+DEFAULT\s+2/i.test(sql)).toBe(true);
  });

  describe.each(amrCases(NOW))('値の表: $name', ({ claims, amrOk, reason }) => {
    it('DD-AUTH-047 条件1・2の判定が表のとおり', () => {
      const result = evaluateStaffEntry(claims as { amr?: unknown } | null, 2, NOW);
      expect(result.ok).toBe(amrOk);
      if (!amrOk) expect(result).toEqual({ ok: false, reason });
    });
  });

  it.each([
    [0, false],
    [1, false],
    [2, true],
    [3, true],
  ])('DD-AUTH-047 認めたパスキーが %i 本なら ok は %s', (count, ok) => {
    const result = evaluateStaffEntry({ amr: [{ method: 'passkey', timestamp: NOW }] }, count, NOW);
    expect(result).toEqual(ok ? { ok: true } : { ok: false, reason: 'passkeys_insufficient' });
  });

  it.each([[Infinity], [NaN], ['2'], [2.5], [-1], [undefined], [null]])(
    'DD-AUTH-047 本数が %p のように整数でない・負なら閉じる側に倒す',
    (count) => {
      const claims = { amr: [{ method: 'passkey', timestamp: NOW }] };
      expect(evaluateStaffEntry(claims, count as unknown as number, NOW)).toEqual({ ok: false, reason: 'passkeys_insufficient' });
    },
  );

  it('DD-AUTH-047 今の秒が小数でも切り捨てて境界を比べる（86400秒は通し、86401秒は断る）', () => {
    const at = (age: number) => [{ method: 'passkey', timestamp: NOW - age }];
    expect(evaluateStaffEntry({ amr: at(86400) }, 2, NOW + 0.9)).toEqual({ ok: true });
    expect(evaluateStaffEntry({ amr: at(86401) }, 2, NOW + 0.9)).toEqual({ ok: false, reason: 'passkey_expired' });
    expect(evaluateStaffEntry({ amr: at(0) }, 2, NOW + 0.9)).toEqual({ ok: true });
    // 時計のずれ: 60秒先までは通し、61秒先は断る（今の秒は切り捨て）
    expect(evaluateStaffEntry({ amr: [{ method: 'passkey', timestamp: NOW + 1 }] }, 2, NOW + 0.9)).toEqual({ ok: true });
    expect(evaluateStaffEntry({ amr: [{ method: 'passkey', timestamp: NOW + 60 }] }, 2, NOW + 0.9)).toEqual({ ok: true });
    expect(evaluateStaffEntry({ amr: [{ method: 'passkey', timestamp: NOW + 61 }] }, 2, NOW + 0.9))
      .toEqual({ ok: false, reason: 'passkey_expired' });
  });

  it('DD-AUTH-047 passkey が無ければ本数が多くても no_passkey、期限切れなら本数より先に passkey_expired', () => {
    expect(evaluateStaffEntry({ amr: [] }, 9, NOW)).toEqual({ ok: false, reason: 'no_passkey' });
    expect(evaluateStaffEntry({ amr: [{ method: 'passkey', timestamp: NOW - 86401 }] }, 0, NOW))
      .toEqual({ ok: false, reason: 'passkey_expired' });
  });

  it('DD-AUTH-047 JWT の印 staff_passkeys_ok が真でも、DB で数えた本数が1本なら断る', () => {
    const claims = staffEntryClaims({ amr: [{ method: 'passkey', timestamp: NOW }], staff_passkeys_ok: true });
    expect(evaluateStaffEntry(claims, 1, NOW)).toEqual({ ok: false, reason: 'passkeys_insufficient' });
  });

  it('DD-AUTH-047 道具: staffEntryClaims は aal1・今の passkey・印・session_id を持ち、mockApprovedCount は RPC の戻りを差す', async () => {
    const claims = staffEntryClaims();
    expect(claims.aal).toBe('aal1');
    expect(claims.staff_passkeys_ok).toBe(true);
    expect(claims.session_id).toBeTruthy();
    expect(claims.email).toBeTruthy();
    expect(evaluateStaffEntry(claims, 2, Math.floor(Date.now() / 1000))).toEqual({ ok: true });
    const rpc = jest.fn();
    mockApprovedCount(rpc, 1);
    await expect(rpc('passkey_approved_count', { p_user_id: 'x' })).resolves.toEqual({ data: 1, error: null });
    await expect(rpc('other')).resolves.toEqual({ data: null, error: null });
  });
});

describe('approvedCountHint（表示のヒント。判定には使わない）', () => {
  it('DD-AUTH-048 印 staff_passkeys_ok が true のときだけ足りる本数、それ以外は 0（閉じる側）', () => {
    expect(approvedCountHint({ staff_passkeys_ok: true })).toBe(STAFF_MIN_APPROVED_PASSKEYS);
    for (const value of [false, undefined, null, 'true', 1, {}]) {
      expect(approvedCountHint({ staff_passkeys_ok: value })).toBe(0);
    }
    expect(approvedCountHint({})).toBe(0);
    expect(approvedCountHint(null)).toBe(0);
    expect(approvedCountHint(undefined)).toBe(0);
  });

  it('DD-AUTH-048 ヒントの本数は evaluateStaffEntry を通すと、印が真なら通り、偽なら passkeys_insufficient', () => {
    const claims = staffEntryClaims();
    expect(evaluateStaffEntry(claims, approvedCountHint(claims), Date.now() / 1000)).toEqual({ ok: true });
    const noMark = staffEntryClaims({ staff_passkeys_ok: false });
    expect(evaluateStaffEntry(noMark, approvedCountHint(noMark), Date.now() / 1000)).toEqual({ ok: false, reason: 'passkeys_insufficient' });
  });
});
