/**
 * 「結び付いた生きた session」を DB に作る試験の道具（波 5、DATA-AUTH-007）。
 *
 * `private.app_session_is_live`・`public.has_permission`（M2）・会員の表の方針は、JWT の `session_id` が
 * `auth.sessions` の生きた行と、`public.sessions.auth_session_id` で結び付いた失効していない行の両方に当たる時だけ通す。
 * claims に `sub` と `role` だけを入れる試験は、この道具で session を作り、claims に `aal`・`session_id` を足す。
 * 呼ぶ側の begin / rollback の中で使う（行を残さない）。`auth.users` の行は呼ぶ前に作っておく。
 */
import { randomUUID } from 'node:crypto';
import type { PgClient } from './local-db';

export type AppSessionOptions = {
  /** `auth.sessions.aal`。既定は aal2 */
  aal?: 'aal1' | 'aal2';
  /** false なら `public.sessions` の行を作らない（アプリを通らずに取った通行証を真似る）。既定は true */
  bind?: boolean;
  /** true なら `public.sessions.revoked_at` を立てる（`bind: false` では意味が無い） */
  revoked?: boolean;
};

/** auth.sessions と public.sessions に、結び付いた生きた session の行を作る。 */
export async function createLiveAppSession(
  db: PgClient,
  userId: string,
  options: AppSessionOptions = {},
): Promise<{ sessionId: string }> {
  const { aal = 'aal2', bind = true, revoked = false } = options;
  const sessionId = randomUUID();

  await db.query(
    `insert into auth.sessions (id, user_id, created_at, updated_at, aal, not_after)
     values ($1, $2, now(), now(), $3::auth.aal_level, null)`,
    [sessionId, userId, aal],
  );

  if (bind) {
    await db.query(
      `insert into public.sessions (user_id, refresh_token_hash, auth_session_id, expires_at, last_seen_at, revoked_at)
       values ($1, 'test-' || gen_random_uuid()::text, $2, now() + interval '7 days', now(),
               case when $3::boolean then now() else null end)`,
      [userId, sessionId, revoked],
    );
  }

  return { sessionId };
}

/**
 * PostgREST が入れる JWT の claims（role authenticated・aal・session_id）。
 * `select set_config('request.jwt.claims', $1, true)` に JSON.stringify して渡す。
 */
export function jwtClaims(
  userId: string,
  session: { sessionId: string },
  aal: 'aal1' | 'aal2' = 'aal2',
): Record<string, unknown> {
  return { sub: userId, role: 'authenticated', aal, session_id: session.sessionId };
}
