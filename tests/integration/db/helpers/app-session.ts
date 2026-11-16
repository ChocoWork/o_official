/**
 * 「結び付いた生きた session」を DB に作る試験の道具（波 5、DATA-AUTH-007）。
 *
 * `private.app_session_is_live`・`public.has_permission`（M2）・会員の表の方針は、JWT の `session_id` が
 * `auth.sessions` の生きた行と、`public.sessions.auth_session_id` で結び付いた失効していない行の両方に当たる時だけ通す。
 * claims に `sub` と `role` だけを入れる試験は、この道具で session を作り、claims に `aal`・`session_id` を足す。
 * 呼ぶ側の begin / rollback の中で使う（行を残さない）。`auth.users` の行は呼ぶ前に作っておく。
 *
 * 管理の入口はパスキーの amr と DB で数えた認めたパスキー2本以上（SR-AUTH-014。`aal` は見ない）。古い名前の aal を読み替える:
 * 'aal2' → 認めたパスキー2本（`auth.webauthn_credentials` に行を直に入れ、`passkey_approve` で認める）、'aal1' → 認めたパスキー1本。
 * `jwtClaims` は、'aal2'（既定）が1時間前の `passkey` の amr を持つ claims、'aal1' が `passkey` の無い（メールのコードの）amr の claims を返す。
 * 認めた本数が足りない側（1本）を作りたい時は、`createLiveAppSession(..., { aal: 'aal1' })` に `jwtClaims(..., 'aal2')`（passkey の amr）を合わせる。
 */
import { randomUUID } from 'node:crypto';
import type { PgClient } from './local-db';

/** 利用者の認めたパスキーを count 本にそろえる（足りない分だけ、鍵の行を直に入れて passkey_approve で認める）。 */
export async function seedApprovedPasskeys(db: PgClient, userId: string, count: number): Promise<void> {
  const current = await db.query('select public.passkey_approved_count($1::uuid)::int as n', [userId]);
  for (let i = Number(current.rows[0].n); i < count; i += 1) {
    const inserted = await db.query(
      `insert into auth.webauthn_credentials (user_id, credential_id, public_key, friendly_name)
       values ($1::uuid, gen_random_bytes(32), gen_random_bytes(32), 'test-passkey') returning id`,
      [userId],
    );
    await db.query('select public.passkey_approve($1::uuid, $2::uuid, $3)', [userId, inserted.rows[0].id, 'script']);
  }
}

export type AppSessionOptions = {
  /** 頼んだ側の名前。'aal2' は認めたパスキー2本、'aal1' は1本（`auth.sessions.aal` の列は常に aal1。パスキーは aal1 のまま）。既定は aal2 */
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
    [sessionId, userId, 'aal1'],
  );
  await seedApprovedPasskeys(db, userId, aal === 'aal2' ? 2 : 1);

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
 * PostgREST が入れる JWT の claims（role authenticated・aal・amr・session_id）。
 * `select set_config('request.jwt.claims', $1, true)` に JSON.stringify して渡す。
 * `aal` の引数は頼んだ側の名前（先頭の説明）。claims の aal は常に aal1（パスキーのログインと同じ）、amr は1時間前の passkey（'aal1' は otp）。
 */
export function jwtClaims(
  userId: string,
  session: { sessionId: string },
  aal: 'aal1' | 'aal2' = 'aal2',
): Record<string, unknown> {
  return {
    sub: userId,
    role: 'authenticated',
    aal: 'aal1',
    // 取引の中の now() は取引の始めの時刻で固定なので、取引が長引いても claims の時刻が未来にならないよう、1時間前にする（24時間の窓の内側。本物の JWT も要求より前に出る）。
    // 1時間より長い取引は想定しない
    amr: [{ method: aal === 'aal2' ? 'passkey' : 'otp', timestamp: Math.floor(Date.now() / 1000) - 3600 }],
    session_id: session.sessionId,
  };
}
