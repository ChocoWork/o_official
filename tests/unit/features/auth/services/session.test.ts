jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
}));
jest.mock('@/lib/hash', () => ({
  tokenHashSha256: jest.fn(),
}));

import { createServiceRoleClient } from '@/lib/supabase/server';
import { tokenHashSha256 } from '@/lib/hash';
import * as sessionService from '@/features/auth/services/session';

const mockCreateClient = createServiceRoleClient as unknown as jest.Mock;
const mockTokenHash = tokenHashSha256 as unknown as jest.Mock;

function makeResponse() {
  const set = jest.fn();
  return { response: { cookies: { set } } as never, set };
}

describe('session service', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('findSessionByRefreshHash with raw token', async () => {
    const fakeHash = 'ab'.repeat(32);
    mockTokenHash.mockReturnValue(fakeHash);

    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: 'sess1',
        user_id: 'user1',
        refresh_token_hash: fakeHash,
        revoked_at: null,
      },
      error: null,
    });

    const eq = jest.fn().mockReturnValue({ maybeSingle });
    const select = jest.fn().mockReturnValue({ eq });
    const from = jest.fn().mockReturnValue({ select });
    mockCreateClient.mockResolvedValue({ from });

    const res = await sessionService.findSessionByRefreshHash('rawtoken');
    expect(mockTokenHash).toHaveBeenCalledWith('rawtoken');
    expect(from).toHaveBeenCalledWith('sessions');
    expect(res).not.toBeNull();
    expect(res?.id).toBe('sess1');
    expect(res?.user_id).toBe('user1');
  });

  test('findSessionByRefreshHash は失効済みの行も返す（判断は呼び出し側）', async () => {
    const fakeHash = 'cd'.repeat(32);
    mockTokenHash.mockReturnValue(fakeHash);

    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'sess1', user_id: 'user1', refresh_token_hash: fakeHash, revoked_at: '2026-01-01T00:00:00Z' },
      error: null,
    });
    const from = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ maybeSingle }) }),
    });
    mockCreateClient.mockResolvedValue({ from });

    const res = await sessionService.findSessionByRefreshHash(fakeHash);
    expect(res?.revoked_at).toBe('2026-01-01T00:00:00Z');
  });

  test('persistNewSession は Cookie を設定し、insert を revoke より先に実行する', async () => {
    mockTokenHash.mockResolvedValue('hashed');
    const calls: string[] = [];
    const insert = jest.fn(() => {
      calls.push('insert');
      return Promise.resolve({ error: null });
    });
    const eq = jest.fn(() => {
      calls.push('revoke');
      return Promise.resolve({ error: null });
    });
    const from = jest.fn().mockReturnValue({ insert, update: jest.fn().mockReturnValue({ eq }) });
    mockCreateClient.mockResolvedValue({ from });

    const { response, set } = makeResponse();
    await sessionService.persistNewSession(response, {
      accessToken: 'a',
      refreshToken: 'r',
      userId: 'user1',
      previousSessionId: 'old-sess',
      previousRefreshToken: 'old-r',
    });

    const cookieNames = set.mock.calls.map(([c]) => (c as { name: string }).name);
    expect(cookieNames).toEqual(
      expect.arrayContaining(['sb-access-token', 'sb-refresh-token', 'sb-csrf-token']),
    );
    expect(calls).toEqual(['insert', 'revoke']);
  });

  test('persistNewSession は insert の失敗を握り潰さず throw する', async () => {
    mockTokenHash.mockResolvedValue('hashed');
    const from = jest.fn().mockReturnValue({
      insert: jest.fn().mockResolvedValue({ error: { message: 'insert boom' } }),
      update: jest.fn(),
    });
    mockCreateClient.mockResolvedValue({ from });

    const { response } = makeResponse();
    await expect(
      sessionService.persistNewSession(response, {
        accessToken: 'a',
        refreshToken: 'r',
        userId: 'user1',
      }),
    ).rejects.toThrow('insert boom');
  });

  test('persistNewSession は旧行 revoke の失敗も throw する', async () => {
    mockTokenHash.mockResolvedValue('hashed');
    const from = jest.fn().mockReturnValue({
      insert: jest.fn().mockResolvedValue({ error: null }),
      update: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: { message: 'revoke boom' } }) }),
    });
    mockCreateClient.mockResolvedValue({ from });

    const { response } = makeResponse();
    await expect(
      sessionService.persistNewSession(response, {
        accessToken: 'a',
        refreshToken: 'r',
        userId: 'user1',
        previousSessionId: 'old-sess',
        previousRefreshToken: 'old-r',
      }),
    ).rejects.toThrow('revoke boom');
  });

  describe('auth_session_id の引き継ぎ（DD-AUTH-039）', () => {
    const TRUSTED = '11111111-1111-4111-8111-111111111111';
    const FROM_TOKEN = '22222222-2222-4222-8222-222222222222';
    const jwt = (payload: Record<string, unknown>) =>
      `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

    function setupInsert() {
      mockTokenHash.mockResolvedValue('hashed');
      const insert = jest.fn().mockResolvedValue({ error: null });
      const from = jest.fn().mockReturnValue({ insert, update: jest.fn() });
      mockCreateClient.mockResolvedValue({ from });
      return insert;
    }

    test('DD-AUTH-039 trustedAuthSessionId が無ければ、token に session_id があっても auth_session_id は null（洗濯しない）', async () => {
      const insert = setupInsert();
      const { response } = makeResponse();
      await sessionService.persistNewSession(response, {
        accessToken: jwt({ session_id: FROM_TOKEN }),
        refreshToken: 'r',
        userId: 'user1',
      });
      expect(insert.mock.calls[0][0][0].auth_session_id).toBeNull();
    });

    test('DD-AUTH-039 trustedAuthSessionId が null でも auth_session_id は null', async () => {
      const insert = setupInsert();
      const { response } = makeResponse();
      await sessionService.persistNewSession(response, {
        accessToken: jwt({ session_id: FROM_TOKEN }),
        refreshToken: 'r',
        userId: 'user1',
        trustedAuthSessionId: null,
      });
      expect(insert.mock.calls[0][0][0].auth_session_id).toBeNull();
    });

    test('DD-AUTH-039 trustedAuthSessionId があれば、新しい token の session_id を入れる', async () => {
      const insert = setupInsert();
      const { response } = makeResponse();
      await sessionService.persistNewSession(response, {
        accessToken: jwt({ session_id: FROM_TOKEN }),
        refreshToken: 'r',
        userId: 'user1',
        trustedAuthSessionId: TRUSTED,
      });
      expect(insert.mock.calls[0][0][0].auth_session_id).toBe(FROM_TOKEN);
    });

    test('DD-AUTH-039 trustedAuthSessionId があり token に session_id が無ければ、trustedAuthSessionId を入れる', async () => {
      const insert = setupInsert();
      const { response } = makeResponse();
      await sessionService.persistNewSession(response, {
        accessToken: 'opaque',
        refreshToken: 'r',
        userId: 'user1',
        trustedAuthSessionId: TRUSTED,
      });
      expect(insert.mock.calls[0][0][0].auth_session_id).toBe(TRUSTED);
    });

    test('DD-AUTH-039 findSessionByRefreshHash は auth_session_id も引いて返す', async () => {
      const fakeHash = 'ef'.repeat(32);
      mockTokenHash.mockReturnValue(fakeHash);
      const maybeSingle = jest.fn().mockResolvedValue({
        data: { id: 's', user_id: 'u', refresh_token_hash: fakeHash, revoked_at: null, auth_session_id: TRUSTED },
        error: null,
      });
      const select = jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ maybeSingle }) });
      mockCreateClient.mockResolvedValue({ from: jest.fn().mockReturnValue({ select }) });

      const res = await sessionService.findSessionByRefreshHash(fakeHash);
      expect(select.mock.calls[0][0]).toContain('auth_session_id');
      expect(res?.auth_session_id).toBe(TRUSTED);
    });

    test('DD-AUTH-039 行の auth_session_id が NULL なら null を返す', async () => {
      const fakeHash = 'ab'.repeat(32);
      const maybeSingle = jest.fn().mockResolvedValue({
        data: { id: 's', user_id: 'u', refresh_token_hash: fakeHash, revoked_at: null, auth_session_id: null },
        error: null,
      });
      const select = jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ maybeSingle }) });
      mockCreateClient.mockResolvedValue({ from: jest.fn().mockReturnValue({ select }) });

      const res = await sessionService.findSessionByRefreshHash(fakeHash);
      expect(res?.auth_session_id).toBeNull();
    });

    describe('引きの失敗（DD-AUTH-039）', () => {
      const fakeHash = 'ab'.repeat(32);
      let consoleError: jest.SpyInstance;

      beforeEach(() => {
        consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: { message: 'PGRST116 multiple rows' } });
        const select = jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ maybeSingle }) });
        mockCreateClient.mockResolvedValue({ from: jest.fn().mockReturnValue({ select }) });
      });

      afterEach(() => consoleError.mockRestore());

      test('DD-AUTH-039 既定では DB のエラーを null で返す（MFA 昇格はこちらを使う）', async () => {
        await expect(sessionService.findSessionByRefreshHash(fakeHash)).resolves.toBeNull();
      });

      test('DD-AUTH-039 throwOnError なら DB のエラーを name が SessionLookupError の Error で投げる', async () => {
        await expect(sessionService.findSessionByRefreshHash(fakeHash, { throwOnError: true })).rejects.toMatchObject({
          name: 'SessionLookupError',
        });
      });

      test('DD-AUTH-039 throwOnError でも、行が無い（エラーなし）は null で返す', async () => {
        const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
        const select = jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ maybeSingle }) });
        mockCreateClient.mockResolvedValue({ from: jest.fn().mockReturnValue({ select }) });

        await expect(sessionService.findSessionByRefreshHash(fakeHash, { throwOnError: true })).resolves.toBeNull();
      });
    });
  });
});
