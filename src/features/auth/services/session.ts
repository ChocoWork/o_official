import type { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { tokenHashSha256 } from '@/lib/hash';

export const REFRESH_TOKEN_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export type Session = {
  id: string;
  user_id: string;
  refresh_token_hash?: string;
  revoked_at?: string | null;
};

/**
 * refresh token（生の値かその sha256）からセッション行を引く。
 *
 * revoked_at では絞らない。絞ると失効済み行が「見つからない」＝失効の証拠なし、として
 * 扱われてしまい、呼び出し側の失効判定が静かに無効化される。行は返し、判断は呼び出し側で行う。
 */
export async function findSessionByRefreshHash(hashOrToken: string): Promise<Session | null> {
  const service = await createServiceRoleClient();
  const isLikelyHash = /^[0-9a-f]{64}$/i.test(hashOrToken);
  const lookup = isLikelyHash ? hashOrToken : await tokenHashSha256(hashOrToken);

  const { data, error } = await service
    .from('sessions')
    .select('id, user_id, refresh_token_hash, revoked_at')
    .eq('refresh_token_hash', lookup)
    .maybeSingle();

  if (error) {
    console.error('findSessionByRefreshHash DB error:', error);
    return null;
  }

  if (!data) return null;
  return {
    id: data.id,
    user_id: data.user_id,
    refresh_token_hash: data.refresh_token_hash,
    revoked_at: data.revoked_at ?? null,
  };
}

type CookieWriter = Pick<NextResponse, 'cookies'>;

export type IssuedSession = {
  accessToken: string | null | undefined;
  refreshToken: string | null | undefined;
  userId: string;
  /** 差し替え対象の既存セッション行。無ければ新規発行として扱う。 */
  previousSessionId?: string | null;
  previousRefreshToken?: string | null;
};

/**
 * 新しく発行されたセッションを Cookie と sessions テーブルへ反映する。
 * トークンを差し替える経路（refresh / MFA 昇格）は必ずここを通し、
 * Cookie・CSRF・セッション行の更新手順が経路ごとにずれないようにする。
 *
 * DB 書き込みに失敗したら throw する。呼び出し側は監査ログに残したうえで
 * **Cookie 付きのレスポンスはそのまま返すこと**。Supabase が新トークンを発行した時点で
 * 旧 refresh token は無効化済みなので、ここで握りつぶして 500 を返すと
 * ユーザーは死んだ refresh token だけを持って詰む。sessions テーブルは監査用であり、
 * 認可の権威ではない。
 */
export async function persistNewSession(response: CookieWriter, issued: IssuedSession): Promise<void> {
  const {
    refreshCookieName,
    accessCookieName,
    csrfCookieName,
    cookieOptionsForAccess,
    cookieOptionsForRefresh,
    cookieOptionsForCsrf,
  } = await import('@/lib/cookie');
  const { generateCsrfToken } = await import('@/lib/csrf');

  const csrfToken = generateCsrfToken();

  // access Cookie の Max-Age は access token の exp ではなく refresh に揃える。
  // exp に揃えると、トークンが切れる瞬間に Cookie ごとブラウザから消える。すると logout が
  // JWT の session_id を読めず、全端末失効のフォールバックに落ちる（allowExpired 経路が
  // 実質到達不能になる）。中身の JWT は exp で毎回検証されるので、Cookie が長生きしても
  // 認証は通らない。残るのは「期限切れ JWT がしばらく Cookie に残る」ことだけ。
  response.cookies.set({ name: accessCookieName, value: issued.accessToken ?? '', ...cookieOptionsForAccess(REFRESH_TOKEN_MAX_AGE_SECONDS) });
  response.cookies.set({ name: refreshCookieName, value: issued.refreshToken ?? '', ...cookieOptionsForRefresh(REFRESH_TOKEN_MAX_AGE_SECONDS) });
  response.cookies.set({ name: csrfCookieName, value: csrfToken, ...cookieOptionsForCsrf(REFRESH_TOKEN_MAX_AGE_SECONDS) });

  const service = await createServiceRoleClient();
  const previousHash = issued.previousRefreshToken ? await tokenHashSha256(issued.previousRefreshToken) : null;
  const now = new Date().toISOString();

  // insert を先、旧行の revoke を後に行う。insert が落ちたときに旧行を失わないため。
  const { error: insertError } = await service.from('sessions').insert([
    {
      user_id: issued.userId,
      refresh_token_hash: await tokenHashSha256(issued.refreshToken ?? ''),
      previous_refresh_token_hash: previousHash,
      quarantined: false,
      csrf_token_hash: await tokenHashSha256(csrfToken),
      // 行が表すのは refresh セッション。access token の寿命を入れると列の意味とずれる。
      // 期限の権威は Supabase 側にあり、この値は監査・セッション一覧の表示用。
      expires_at: new Date(Date.now() + REFRESH_TOKEN_MAX_AGE_SECONDS * 1000).toISOString(),
      last_seen_at: now,
    },
  ]);

  if (insertError) {
    throw new Error(`persistNewSession: failed to insert session row: ${insertError.message}`);
  }

  if (issued.previousSessionId) {
    const { error: revokeError } = await service
      .from('sessions')
      .update({
        revoked_at: now,
        previous_refresh_token_hash: previousHash,
        last_seen_at: now,
      })
      .eq('id', issued.previousSessionId);

    if (revokeError) {
      throw new Error(`persistNewSession: failed to revoke previous session row: ${revokeError.message}`);
    }
  }
}
