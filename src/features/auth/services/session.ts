export type Session = {
  id: string;
  user_id: string;
  refresh_token_hash?: string;
  current_jti?: string;
};

export async function findSessionByRefreshHash(_hash: string): Promise<Session | null> {
  throw new Error('Not implemented: findSessionByRefreshHash');
}

export async function rotateJtiAndSave(_sessionId: string, _newJti: string): Promise<{ newJti: string }>{
  throw new Error('Not implemented: rotateJtiAndSave');
}

export async function revokeAllSessionsForUser(_userId: string): Promise<void> {
  throw new Error('Not implemented: revokeAllSessionsForUser');
}

export async function isReplay(_session: Session, _token: string): Promise<boolean> {
  // Optional helper to detect replay; default false
  return false;
}
