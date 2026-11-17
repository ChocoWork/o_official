import { staffEntryOkFromClaims } from '@/features/auth/return-intent/staff-entry-hint';

const NOW = 1_800_000_000;
const passkeyAt = (timestamp: unknown) => [{ method: 'passkey', timestamp }];

describe('DD-AUTH-054 staffEntryOkFromClaims', () => {
  it('DD-AUTH-054 パスキーで24時間以内・認めた2本の印が真なら真', () => {
    expect(staffEntryOkFromClaims({ amr: passkeyAt(NOW - 60), staff_passkeys_ok: true }, NOW)).toBe(true);
  });

  it.each([
    ['claims が無い', undefined],
    ['amr が欠ける', { staff_passkeys_ok: true }],
    ['amr が空', { amr: [], staff_passkeys_ok: true }],
    ['時刻が文字列', { amr: passkeyAt(String(NOW - 60)), staff_passkeys_ok: true }],
    ['時刻が未来', { amr: passkeyAt(NOW + 3600), staff_passkeys_ok: true }],
    ['24時間超', { amr: passkeyAt(NOW - 25 * 3600), staff_passkeys_ok: true }],
    ['印が偽', { amr: passkeyAt(NOW - 60), staff_passkeys_ok: false }],
    ['印が文字列 "true"', { amr: passkeyAt(NOW - 60), staff_passkeys_ok: 'true' }],
    ['印が無い', { amr: passkeyAt(NOW - 60) }],
    ['aal2 だけ', { aal: 'aal2' }],
  ])('DD-AUTH-054 %s なら偽（閉じる側）', (_label, claims) => {
    expect(staffEntryOkFromClaims(claims as never, NOW)).toBe(false);
  });
});
