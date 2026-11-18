/**
 * DD-AUTH-082 店員の鍵の削除（下限つきの DB の関数を呼ぶ薄い部品。src/lib/auth/staff-passkey-delete.ts）の単体テスト。
 */

jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

import { deleteStaffPasskey } from '@/lib/auth/staff-passkey-delete';

const { createServiceRoleClient } = require('@/lib/supabase/server');

const USER_ID = '22222222-2222-4222-8222-222222222222';
const KEY_ID = '33333333-3333-4333-8333-333333333333';
const rpc = jest.fn();

describe('staff-passkey-delete', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    rpc.mockReset().mockResolvedValue({ data: null, error: null });
    createServiceRoleClient.mockReset().mockResolvedValue({ rpc });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-AUTH-082 passkey_delete_with_floor を利用者と鍵の ID で1回呼び、成功なら ok', async () => {
    await expect(deleteStaffPasskey(USER_ID, KEY_ID)).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('passkey_delete_with_floor', { p_user_id: USER_ID, p_passkey_id: KEY_ID });
  });

  it('DD-AUTH-082 STAFF_MIN_KEYS は min_keys、PASSKEY_NOT_FOUND は not_found、知らない誤りは failed', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'STAFF_MIN_KEYS' } });
    await expect(deleteStaffPasskey(USER_ID, KEY_ID)).resolves.toEqual({ ok: false, reason: 'min_keys' });
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0002', message: 'PASSKEY_NOT_FOUND' } });
    await expect(deleteStaffPasskey(USER_ID, KEY_ID)).resolves.toEqual({ ok: false, reason: 'not_found' });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied' } });
    await expect(deleteStaffPasskey(USER_ID, KEY_ID)).resolves.toEqual({ ok: false, reason: 'failed' });
  });

  it('DD-AUTH-082 例外は failed（閉じる側）で、ログに文を残さない', async () => {
    rpc.mockRejectedValueOnce(new Error('secret detail'));
    await expect(deleteStaffPasskey(USER_ID, KEY_ID)).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret detail');
  });
});
