/**
 * Unit tests for refresh service logic.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { refreshSession, UnauthorizedError } from '@/features/auth/services/refresh';
import * as sessionService from '@/features/auth/services/session';
import * as hash from '@/lib/hash';

describe('refresh service', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('valid refresh returns new tokens and updates session', async () => {
    // Arrange
    const session = { id: 's1', user_id: 'u1', refresh_token_hash: 'stored-hash', current_jti: 'j1' };
    jest.spyOn(sessionService, 'findSessionByRefreshHash').mockResolvedValue(session as any);
    jest.spyOn(hash, 'verify').mockResolvedValue(true);
    const rotateSpy = jest.spyOn(sessionService, 'rotateJtiAndSave').mockResolvedValue({ newJti: 'j2' } as any);

    // Act
    const result = await refreshSession({ refreshToken: 'valid-refresh-token' });

    // Assert
    expect(result).toHaveProperty('accessToken');
    expect(result).toHaveProperty('refreshToken');
    expect(result.user).toEqual({ id: 'u1' });
    expect(rotateSpy).toHaveBeenCalledWith('s1', expect.any(String));
  });

  test('invalid refresh token returns 401 and revokes sessions', async () => {
    // Arrange
    const session = { id: 's2', user_id: 'u2', refresh_token_hash: 'stored-hash' };
    jest.spyOn(sessionService, 'findSessionByRefreshHash').mockResolvedValue(session as any);
    jest.spyOn(hash, 'verify').mockResolvedValue(false);
    const revokeSpy = jest.spyOn(sessionService, 'revokeAllSessionsForUser').mockResolvedValue(undefined as any);

    // Act & Assert
    await expect(refreshSession({ refreshToken: 'bad-token' })).rejects.toThrow(UnauthorizedError);
    expect(revokeSpy).toHaveBeenCalledWith('u2');
  });

  test('replay detection (same refresh token used twice) triggers session revoke', async () => {
    // Arrange
    const session = { id: 's3', user_id: 'u3', refresh_token_hash: 'stored-hash' };
    jest.spyOn(sessionService, 'findSessionByRefreshHash').mockResolvedValue(session as any);
    jest.spyOn(hash, 'verify').mockResolvedValue(true);
    jest.spyOn(sessionService, 'isReplay').mockResolvedValue(true as any);
    const revokeSpy = jest.spyOn(sessionService, 'revokeAllSessionsForUser').mockResolvedValue(undefined as any);

    // Act & Assert
    await expect(refreshSession({ refreshToken: 'replayed-token' })).rejects.toThrow(UnauthorizedError);
    expect(revokeSpy).toHaveBeenCalledWith('u3');
  });
});
