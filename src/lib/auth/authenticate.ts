import { cache } from 'react';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import type { JwtPayload, SupabaseClient } from '@supabase/supabase-js';
import { accessCookieName } from '@/lib/cookie';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { extractAuthToken } from '@/lib/auth/request-token';

/**
 * 認証ポリシー層。「このリクエストは誰か」だけを答える。
 *
 * クライアント生成（@/lib/supabase/server）とは関心事が違うので分けている。
 * あちらは「何を叩くか」、ここは「誰か」。同じファイルに置くと、認可の入口が
 * どれなのかがクライアント生成関数に埋もれて見えなくなる。
 */

export type VerifiedAccessToken =
  | { ok: true; claims: JwtPayload }
  /**
   * `unavailable` は「失効している」ではなく「失効しているか確認できなかった」。
   * 混ぜてはいけない。両方 401 にすると、クライアントは 401 を「トークンが古い」と
   * 解釈してセッション更新を撃つため、DB 障害の最中に refresh が殺到して障害を増幅する。
   * 呼び出し側は `unavailable` を 503 + Retry-After として返すこと。
   * どちらもアクセスは拒否するので fail-closed は保たれる。
   */
  | { ok: false; reason: 'missing' | 'invalid' | 'revoked' | 'unavailable' };

/** セッションの生存確認の結果。「生きている」「失効した」「確認できない」の3値。 */
export type SessionLiveness = 'active' | 'revoked' | 'unavailable';

// JWKS のキャッシュ（TTL 10 分）はクライアントインスタンス単位なので、検証専用クライアントは
// モジュールレベルで 1 個だけ作って使い回す。getClaims に JWT を明示的に渡す限り
// セッションストレージには触れないため、リクエスト間で共有しても状態は混ざらない。
let tokenVerifierClient: SupabaseClient | null = null;

async function getTokenVerifierClient(): Promise<SupabaseClient> {
  if (!tokenVerifierClient) {
    const { createClient: createSupabaseClient } = await import('@supabase/supabase-js');

    tokenVerifierClient = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
      },
    );
  }

  return tokenVerifierClient;
}

function hasAuthenticatedAudience(aud: string | string[]): boolean {
  return Array.isArray(aud) ? aud.includes('authenticated') : aud === 'authenticated';
}

async function resolveAccessToken(request?: Request): Promise<string | null> {
  const fromRequest = extractAuthToken(request);
  if (fromRequest) {
    return fromRequest;
  }

  if (request) {
    return null;
  }

  const cookieStore = await cookies();
  return cookieStore.get(accessCookieName)?.value ?? null;
}

/**
 * Access token を暗号的に検証して claims を返す。署名・exp・iss・aud のみを見る。
 *
 * getClaims は非対称鍵（本プロジェクトは ES256）なら JWKS でローカル検証し、署名と exp を確認する。
 * ただし iss / aud は検証しないため、ここで明示的に突き合わせる。
 *
 * この関数は「トークンが本物か」しか答えない。**セッションが失効していても ok を返す**
 * （Supabase 公式いわく、getClaims が返すのは JWT をデコードしたクレームであって
 * ユーザー照会の結果ではない）。認可判定には使わず authenticateRequest を使うこと。
 * 直接使ってよいのは次の 2 つだけ:
 *   - ログアウト処理（期限切れトークンから session_id を取り出すため allowExpired が要る）
 *   - admin-rbac（失効確認と ACL 照会を並列に投げるため内訳を必要とする）
 */
export async function verifyAccessToken(
  request?: Request,
  options?: { allowExpired?: boolean },
): Promise<VerifiedAccessToken> {
  const token = await resolveAccessToken(request);
  if (!token) {
    return { ok: false, reason: 'missing' };
  }

  const verifier = await getTokenVerifierClient();
  const { data, error } = await verifier.auth.getClaims(token, {
    allowExpired: options?.allowExpired ?? false,
  });

  if (error || !data?.claims) {
    return { ok: false, reason: 'invalid' };
  }

  const claims = data.claims;
  const expectedIssuer = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`;

  if (claims.iss !== expectedIssuer || !hasAuthenticatedAudience(claims.aud)) {
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true, claims };
}

/**
 * JWT の session_id が Supabase 側でまだ生きているかを照合する。
 *
 * 署名が正しいことと、そのセッションがまだ有効なことは別問題。ログアウト済み・
 * 強制失効済みの access token も exp までは暗号的には「正しい」ため、これが要る。
 *   https://supabase.com/docs/guides/auth/sessions
 *
 * RPC が落ちたときは `unavailable` を返す。`revoked` に丸めないこと（型の定義を参照）。
 *
 * React の cache() で包み、リクエストスコープが効く経路（Server Components 等）では
 * 同一リクエスト内の重複呼び出しを 1 回にまとめる。Route Handler ではスコープが
 * 効かない場合があるが、そのときは従来どおり毎回問い合わせるだけで挙動は変わらない。
 * あくまで往復を減らす最適化であり、正しさはこれに依存しない。
 */
export const checkAuthSessionLiveness = cache(
  async (sessionId: string | undefined): Promise<SessionLiveness> => {
    if (!sessionId) {
      // session_id が無い JWT は失効の確認ができない。通してはいけないが、
      // これは「DB が落ちている」ではないので revoked として扱う。
      return 'revoked';
    }

    try {
      const service = await createServiceRoleClient();
      const { data, error } = await service.rpc('is_auth_session_active', { p_session_id: sessionId });

      if (error) {
        console.error('[auth.checkAuthSessionLiveness] RPC error:', error);
        return 'unavailable';
      }

      return data === true ? 'active' : 'revoked';
    } catch (err) {
      console.error('[auth.checkAuthSessionLiveness] Exception:', err);
      return 'unavailable';
    }
  },
);

/**
 * 認可判定の入口。トークンが本物であることに加えて、そのセッションがまだ生きている
 * ことまで確認する。認証を要する API ルートは必ずこれを通すこと。
 *
 * かつては GoTrue の getUser を叩く resolveRequestUser と 2 系統に分かれていたが、
 * Supabase 公式が getClaims を推奨しており（"Prefer this method over
 * GoTrueClient.getUser which always sends a request to the Auth server for each JWT."）、
 * こちらへ一本化した。失効検知は上の RPC が担う。
 */
export async function authenticateRequest(request?: Request): Promise<VerifiedAccessToken> {
  const verified = await verifyAccessToken(request);
  if (!verified.ok) {
    return verified;
  }

  const liveness = await checkAuthSessionLiveness(verified.claims.session_id);
  if (liveness !== 'active') {
    return { ok: false, reason: liveness === 'unavailable' ? 'unavailable' : 'revoked' };
  }

  return verified;
}

/**
 * 認証に失敗したときの標準応答。
 *
 * 理由ごとの HTTP ステータスの対応をここ 1 箇所に閉じ込める。各ルートに書くと
 * `unavailable` の扱いを取りこぼした経路が生まれ、そこだけ DB 障害時に 401 を返して
 * クライアントのセッション更新を誘発する（それが FREQ-324 で直した問題そのもの）。
 */
export function authFailureResponse(
  reason: Extract<VerifiedAccessToken, { ok: false }>['reason'],
  headers: Record<string, string> = {},
): NextResponse {
  if (reason === 'unavailable') {
    return NextResponse.json(
      { error: 'Service temporarily unavailable' },
      { status: 503, headers: { ...headers, 'Retry-After': '30' } },
    );
  }

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
}
