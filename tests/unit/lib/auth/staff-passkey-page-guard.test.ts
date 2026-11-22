/**
 * DD-AUTH-082 店員のパスキー管理ページの入口（src/lib/auth/staff-passkey-page-guard.ts）の単体テスト。
 * 役割なし・パスキーの印なし・24時間超・無操作の超過は /login へ。認めた鍵が1本でも通る（0本の窓の人は来ない）。確かめの失敗は unavailable。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/auth/authenticate', () => ({ verifyAccessToken: jest.fn(), checkAuthSessionLiveness: jest.fn() }));
jest.mock('@/lib/auth/passkey-approval-rpc', () => ({ isStaff: jest.fn(), approvedCount: jest.fn() }));
jest.mock('@/lib/auth/staff-passkey-idle', () => ({ checkStaffIdle: jest.fn(), staffIdleDeps: { check: jest.fn(), peek: jest.fn() } }));
jest.mock('@/lib/auth/passkey-auth-session-end', () => ({ endAuthSessionById: jest.fn().mockResolvedValue(true) }));

import { requireStaffPasskeyPage } from '@/lib/auth/staff-passkey-page-guard';
import { checkAuthSessionLiveness, verifyAccessToken } from '@/lib/auth/authenticate';
import { approvedCount, isStaff } from '@/lib/auth/passkey-approval-rpc';
import { checkStaffIdle } from '@/lib/auth/staff-passkey-idle';
import { endAuthSessionById } from '@/lib/auth/passkey-auth-session-end';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const NOW = 1_800_000_000;

function claims(amrAgeSeconds: number | null) {
  return {
    sub: USER_ID,
    session_id: SESSION_ID,
    amr: amrAgeSeconds === null ? [{ method: 'otp', timestamp: NOW }] : [{ method: 'passkey', timestamp: NOW - amrAgeSeconds }],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: true, claims: claims(60) });
  (checkAuthSessionLiveness as jest.Mock).mockResolvedValue('active');
  (isStaff as jest.Mock).mockResolvedValue({ ok: true, value: true });
  (approvedCount as jest.Mock).mockResolvedValue({ ok: true, value: 1 });
  (checkStaffIdle as jest.Mock).mockResolvedValue('ok');
});

afterEach(() => jest.restoreAllMocks());

describe('DD-AUTH-082 requireStaffPasskeyPage', () => {
  test('DD-AUTH-082 認めた鍵が1本の店員でも ok（本数は求めない）。本数を返す', async () => {
    await expect(requireStaffPasskeyPage()).resolves.toEqual({ ok: true, userId: USER_ID, approvedCount: 1 });
  });

  test('DD-AUTH-082 認めた鍵が2本でも ok', async () => {
    (approvedCount as jest.Mock).mockResolvedValue({ ok: true, value: 2 });
    await expect(requireStaffPasskeyPage()).resolves.toMatchObject({ ok: true, approvedCount: 2 });
  });

  test('DD-AUTH-082 無限の遷移にならない: 認めた鍵が1本の店員は、別の行き先へ戻されず ok で画面が出る', async () => {
    const result = await requireStaffPasskeyPage();
    expect(result).not.toHaveProperty('redirectTo');
    expect(result.ok).toBe(true);
  });

  test('DD-AUTH-082 ログインしていない・トークンが悪い・session_id が無いは /login', async () => {
    (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: false, reason: 'missing' });
    await expect(requireStaffPasskeyPage()).resolves.toEqual({ ok: false, redirectTo: '/login' });
    (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: true, claims: { sub: USER_ID, amr: [] } });
    await expect(requireStaffPasskeyPage()).resolves.toEqual({ ok: false, redirectTo: '/login' });
  });

  test('DD-AUTH-082 セッションが失効していたら /login', async () => {
    (checkAuthSessionLiveness as jest.Mock).mockResolvedValue('revoked');
    await expect(requireStaffPasskeyPage()).resolves.toEqual({ ok: false, redirectTo: '/login' });
  });

  test('DD-AUTH-082 店員の役割が無ければ /login?reason=staff_required', async () => {
    (isStaff as jest.Mock).mockResolvedValue({ ok: true, value: false });
    await expect(requireStaffPasskeyPage()).resolves.toEqual({ ok: false, redirectTo: '/login?reason=staff_required' });
  });

  test('DD-AUTH-082 amr にパスキーが無ければ /login?reason=staff_required', async () => {
    (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: true, claims: claims(null) });
    await expect(requireStaffPasskeyPage()).resolves.toEqual({ ok: false, redirectTo: '/login?reason=staff_required' });
  });

  test('DD-AUTH-082 パスキーのログインから25時間なら /login?reason=idle で、セッションを終わらせる', async () => {
    (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: true, claims: claims(25 * 3600) });
    await expect(requireStaffPasskeyPage()).resolves.toEqual({ ok: false, redirectTo: '/login?reason=idle' });
    expect(endAuthSessionById).toHaveBeenCalledWith(SESSION_ID);
  });

  test('DD-AUTH-082 無操作が61分（checkStaffIdle が idle）なら /login?reason=idle で、セッションを終わらせる', async () => {
    (checkStaffIdle as jest.Mock).mockResolvedValue('idle');
    await expect(requireStaffPasskeyPage()).resolves.toEqual({ ok: false, redirectTo: '/login?reason=idle' });
    expect(endAuthSessionById).toHaveBeenCalledWith(SESSION_ID);
  });

  test('DD-AUTH-082 無操作の確かめは時刻を進めない peek で行う', async () => {
    await requireStaffPasskeyPage();
    expect(checkStaffIdle).toHaveBeenCalledWith(expect.anything(), SESSION_ID, USER_ID, 'peek');
  });

  test('DD-AUTH-082 無操作の確かめが error なら /login へ送らず unavailable（セッションも終わらせない）', async () => {
    (checkStaffIdle as jest.Mock).mockResolvedValue('error');
    await expect(requireStaffPasskeyPage()).resolves.toEqual({ ok: false, unavailable: true });
    expect(endAuthSessionById).not.toHaveBeenCalled();
  });

  test('DD-AUTH-082 店員の判定・本数・セッションの生存が読めなければ unavailable', async () => {
    (isStaff as jest.Mock).mockResolvedValue({ ok: false });
    await expect(requireStaffPasskeyPage()).resolves.toEqual({ ok: false, unavailable: true });
    (isStaff as jest.Mock).mockResolvedValue({ ok: true, value: true });
    (approvedCount as jest.Mock).mockResolvedValue({ ok: false });
    await expect(requireStaffPasskeyPage()).resolves.toEqual({ ok: false, unavailable: true });
    (approvedCount as jest.Mock).mockResolvedValue({ ok: true, value: 1 });
    (checkAuthSessionLiveness as jest.Mock).mockResolvedValue('unavailable');
    await expect(requireStaffPasskeyPage()).resolves.toEqual({ ok: false, unavailable: true });
  });
});
