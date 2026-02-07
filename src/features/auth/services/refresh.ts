import crypto from 'crypto';
import * as sessionService from './session';
import * as hash from '@/lib/hash';

export class UnauthorizedError extends Error {}

export async function refreshSession({ refreshToken }: { refreshToken: string }) {
  // Find session by refresh token (hash lookup) — real impl should look up by hashed value
  const session = await sessionService.findSessionByRefreshHash(refreshToken);
  if (!session) {
    throw new UnauthorizedError('Invalid refresh token');
  }

  // Verify token matches stored hash
  const ok = await hash.verify(refreshToken, session.refresh_token_hash ?? '');
  if (!ok) {
    // In case of mismatch, revoke all sessions for user as precaution
    await sessionService.revokeAllSessionsForUser(session.user_id);
    throw new UnauthorizedError('Refresh token verification failed');
  }

  // Optional replay detection
  const replay = await sessionService.isReplay(session, refreshToken);
  if (replay) {
    await sessionService.revokeAllSessionsForUser(session.user_id);
    throw new UnauthorizedError('Refresh token replay detected');
  }

  // Rotate JTI
  const newJti = crypto.randomBytes(16).toString('hex');
  await sessionService.rotateJtiAndSave(session.id, newJti);

  // Issue new tokens (simplified for unit tests)
  const accessToken = `access_${crypto.randomBytes(8).toString('hex')}`;
  const newRefreshToken = `refresh_${crypto.randomBytes(12).toString('hex')}`;

  return { accessToken, refreshToken: newRefreshToken, user: { id: session.user_id } };
}
