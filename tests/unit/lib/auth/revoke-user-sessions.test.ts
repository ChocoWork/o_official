/**
 * DD-ADMIN-003 利用者の自前と Auth の session を全部失効する部品（src/lib/auth/revoke-user-sessions.ts）の単体テスト。
 */

jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';

const { createServiceRoleClient } = require('@/lib/supabase/server');

const USER_ID = '22222222-2222-4222-8222-222222222222';

const eq = jest.fn();
const update = jest.fn();
const from = jest.fn();
const rpc = jest.fn();

describe('revokeAllSessionsForUser', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    eq.mockReset().mockResolvedValue({ error: null });
    update.mockReset().mockReturnValue({ eq });
    from.mockReset().mockReturnValue({ update });
    rpc.mockReset().mockResolvedValue({ data: 3, error: null });
    createServiceRoleClient.mockResolvedValue({ from, rpc });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-ADMIN-003 両方成功した時は sessions に失効の時刻を入れ、Auth の関数を呼び、消した数を返す', async () => {
    const result = await revokeAllSessionsForUser(USER_ID);

    expect(result).toEqual({ authSessionsDeleted: 3 });
    expect(from).toHaveBeenCalledWith('sessions');
    expect(Number.isNaN(Date.parse(update.mock.calls[0][0].revoked_at))).toBe(false);
    expect(eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(rpc).toHaveBeenCalledWith('revoke_auth_sessions_for_user', { p_user_id: USER_ID });
  });

  it('DD-ADMIN-003 関数の返りが空なら消した数は 0', async () => {
    rpc.mockResolvedValue({ data: null, error: null });

    await expect(revokeAllSessionsForUser(USER_ID)).resolves.toEqual({ authSessionsDeleted: 0 });
  });

  it('DD-ADMIN-003 sessions の更新が誤りを返すと app_session_revocation_failed で throw し、Auth の関数を呼ばず、誤りの文を出さない', async () => {
    eq.mockResolvedValue({ error: { message: 'secret db detail user@example.com', code: '42501' } });

    const failure = await revokeAllSessionsForUser(USER_ID).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('app_session_revocation_failed');
    expect(rpc).not.toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret db detail');
    expect(errorSpy).toHaveBeenCalledWith(expect.any(String), { code: '42501' });
  });

  it('DD-ADMIN-003 Auth の関数が誤りを返すと auth_session_revocation_failed で throw し、誤りの文を出さない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'secret rpc detail', code: 'P0001' } });

    const failure = await revokeAllSessionsForUser(USER_ID).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('auth_session_revocation_failed');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret rpc detail');
  });
});
