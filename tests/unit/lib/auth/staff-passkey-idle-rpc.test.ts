/**
 * DD-AUTH-074 店員の無操作の DB の関数を呼ぶ薄い部品（src/lib/auth/staff-passkey-idle-rpc.ts）の単体テスト。
 */

jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

import { staffIdleCheck, staffIdlePeek, staffSessionTouch } from '@/lib/auth/staff-passkey-idle-rpc';

const { createServiceRoleClient } = require('@/lib/supabase/server');

const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';

const rpc = jest.fn();

describe('staff-passkey-idle-rpc', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    rpc.mockReset().mockResolvedValue({ data: true, error: null });
    createServiceRoleClient.mockReset().mockResolvedValue({ rpc });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-AUTH-074 staffIdleCheck は staff_idle_check をセッションと利用者で1回呼び、真偽を返す', async () => {
    await expect(staffIdleCheck(SESSION_ID, USER_ID)).resolves.toEqual({ ok: true, value: true });
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(staffIdleCheck(SESSION_ID, USER_ID)).resolves.toEqual({ ok: true, value: false });
    expect(rpc).toHaveBeenCalledWith('staff_idle_check', { p_session_id: SESSION_ID, p_user_id: USER_ID });
  });

  it('DD-AUTH-074 staffIdlePeek は staff_idle_peek をセッションだけで呼ぶ（利用者は渡さない）', async () => {
    await expect(staffIdlePeek(SESSION_ID)).resolves.toEqual({ ok: true, value: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('staff_idle_peek', { p_session_id: SESSION_ID });
  });

  it('DD-AUTH-074 staffSessionTouch は staff_session_touch を呼び、間引かれた偽もそのまま返す', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(staffSessionTouch(SESSION_ID, USER_ID)).resolves.toEqual({ ok: true, value: false });
    expect(rpc).toHaveBeenCalledWith('staff_session_touch', { p_session_id: SESSION_ID, p_user_id: USER_ID });
  });

  it('DD-AUTH-074 DB の誤り・真偽でない値・例外は { ok: false }（閉じる側）で、ログに SQLSTATE だけを残す', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied for function' } });
    await expect(staffIdleCheck(SESSION_ID, USER_ID)).resolves.toEqual({ ok: false });
    expect(errorSpy).toHaveBeenCalledWith('staff-passkey-idle-rpc: rpc returned an error', {
      name: 'staff_idle_check',
      code: '42501',
    });

    rpc.mockResolvedValueOnce({ data: 'true', error: null });
    await expect(staffIdlePeek(SESSION_ID)).resolves.toEqual({ ok: false });

    rpc.mockRejectedValueOnce(new Error('network'));
    await expect(staffSessionTouch(SESSION_ID, USER_ID)).resolves.toEqual({ ok: false });

    createServiceRoleClient.mockRejectedValueOnce(new Error('no client'));
    await expect(staffIdlePeek(SESSION_ID)).resolves.toEqual({ ok: false });
  });
});
