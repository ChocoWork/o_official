/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/auth/authenticate', () => ({ verifyAccessToken: jest.fn(), checkAuthSessionLiveness: jest.fn() }));
jest.mock('@/lib/auth/passkey-approval-rpc', () => ({ windowIsOpen: jest.fn(), approvedCount: jest.fn() }));

import { readStaffRegisterAccess } from '@/features/auth/staff/staff-register-access';
import { checkAuthSessionLiveness, verifyAccessToken } from '@/lib/auth/authenticate';
import { approvedCount, windowIsOpen } from '@/lib/auth/passkey-approval-rpc';

const verify = verifyAccessToken as jest.Mock;
const liveness = checkAuthSessionLiveness as jest.Mock;
const opened = windowIsOpen as jest.Mock;
const counted = approvedCount as jest.Mock;

const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
  verify.mockResolvedValue({ ok: true, claims: { sub: USER_ID, session_id: SESSION_ID } });
  liveness.mockResolvedValue('active');
  opened.mockResolvedValue({ ok: true, value: true });
  counted.mockResolvedValue({ ok: true, value: 1 });
});

describe('DD-AUTH-080 登録の画面の入口の確かめ（readStaffRegisterAccess）', () => {
  test('DD-AUTH-080 窓が開いた生きたセッションなら ok で、認めた鍵の本数（最大2）を返す', async () => {
    await expect(readStaffRegisterAccess()).resolves.toEqual({ ok: true, registered: 1 });
    expect(liveness).toHaveBeenCalledWith(SESSION_ID, true);
    expect(opened).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    counted.mockResolvedValue({ ok: true, value: 5 });
    await expect(readStaffRegisterAccess()).resolves.toEqual({ ok: true, registered: 2 });
  });

  test.each([
    ['トークンが無い・壊れている', () => verify.mockResolvedValue({ ok: false, reason: 'missing' })],
    ['sub が無い', () => verify.mockResolvedValue({ ok: true, claims: { session_id: SESSION_ID } })],
    ['session_id が無い', () => verify.mockResolvedValue({ ok: true, claims: { sub: USER_ID } })],
    ['セッションが失効', () => liveness.mockResolvedValue('revoked')],
    ['窓が閉じている', () => opened.mockResolvedValue({ ok: true, value: false })],
  ])('DD-AUTH-080 %s時は ok: false（閉じる側）', async (_label, arrange) => {
    arrange();
    await expect(readStaffRegisterAccess()).resolves.toEqual({ ok: false });
  });
});

describe('DD-AUTH-080 登録の画面の入口: DB が読めない時は閉じず、使えないと知らせる', () => {
  test.each([
    ['トークンの確認が使えない', () => verify.mockResolvedValue({ ok: false, reason: 'unavailable' })],
    ['セッションが確認できない', () => liveness.mockResolvedValue('unavailable')],
    ['窓が読めない', () => opened.mockResolvedValue({ ok: false })],
    ['本数が読めない', () => counted.mockResolvedValue({ ok: false })],
  ])('DD-AUTH-080 %s時は { ok: false, unavailable: true }（/login へ送らない）', async (_label, arrange) => {
    arrange();
    await expect(readStaffRegisterAccess()).resolves.toEqual({ ok: false, unavailable: true });
  });
});
