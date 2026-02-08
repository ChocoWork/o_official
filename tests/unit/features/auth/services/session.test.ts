import { jest } from '@jest/globals';

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
        current_jti: 'jti1',
        previous_refresh_token_hash: null,
        quarantined: false,
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

  test('rotateJtiAndSave updates current_jti', async () => {
    const update = jest.fn().mockResolvedValue({ error: null });
    const eq = jest.fn().mockReturnValue({ update });
    const from = jest.fn().mockReturnValue({ update: jest.fn().mockReturnValue({ eq }) });
    mockCreateClient.mockResolvedValue({ from });

    const result = await sessionService.rotateJtiAndSave('sess1', 'newjti');
    expect(result).toEqual({ newJti: 'newjti' });
  });

  test('revokeAllSessionsForUser marks revoked_at', async () => {
    const update = jest.fn().mockResolvedValue({ error: null });
    const eq = jest.fn().mockReturnValue({ update });
    const from = jest.fn().mockReturnValue({ update: jest.fn().mockReturnValue({ eq }) });
    mockCreateClient.mockResolvedValue({ from });

    await expect(sessionService.revokeAllSessionsForUser('user1')).resolves.toBeUndefined();
  });

  test('isReplay detects previous hash and quarantined', async () => {
    const token = 'tok';
    const hash = 'cd'.repeat(32);
    mockTokenHash.mockReturnValue(hash);

    const sessionWithPrev = {
      id: 's',
      user_id: 'u',
      previous_refresh_token_hash: hash,
      quarantined: false,
    } as any;

    const replay1 = await sessionService.isReplay(sessionWithPrev, token);
    expect(replay1).toBe(true);

    const sessionQuarantined = { ...sessionWithPrev, previous_refresh_token_hash: null, quarantined: true } as any;
    const replay2 = await sessionService.isReplay(sessionQuarantined, token);
    expect(replay2).toBe(true);

    const sessionGood = { ...sessionWithPrev, previous_refresh_token_hash: null, quarantined: false } as any;
    const replay3 = await sessionService.isReplay(sessionGood, token);
    expect(replay3).toBe(false);
  });
});
