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
});
