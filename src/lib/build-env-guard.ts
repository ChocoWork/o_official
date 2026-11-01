/**
 * ビルドの時に環境変数の設定漏れ・食い違いを検出する（src/lib/build-env-guard.ts）。共有の `next.config.ts` が先頭で呼ぶ。
 *
 * @packageDocumentation
 */

// ビルドの時に値が埋め込まれ、本番で無いと意図しない URL に落ちる変数（SEC-ABOUT-007）。
// APP_ALLOWED_ORIGINS は Origin の確かめ（SEC-LOOK-018）の許可の一覧。本番で一覧を明示させる（www と apex など複数のオリジンを含められる）決定による（SEC-ABOUT-007-AC-02）。
const REQUIRED_IN_PRODUCTION = ['NEXT_PUBLIC_SITE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'APP_ALLOWED_ORIGINS'] as const;

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * `APP_ALLOWED_ORIGINS` の各項目が origin の形（`https://host[:port]`。末尾の / もパスも無い）か確かめる。
 * `redirect.ts` の `parseAllowedOrigins` は読めない項目を黙って捨てるので、書き間違いで許可から落ちても実行時には気付けない。
 * 失敗の文には変数名だけを書き、値を載せない。
 */
function assertAllowedOriginsShape(raw: string): void {
  const fail = (): never => {
    throw new Error(
      'APP_ALLOWED_ORIGINS の書式が正しくありません。カンマ区切りで、各項目を https://host の形（末尾の / やパスを付けない）にしてください。',
    );
  };
  for (const item of raw.split(',').map((part) => part.trim())) {
    if (!item) fail();
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      return fail();
    }
    if (url.protocol !== 'https:' || url.origin !== item) fail();
  }
}

/**
 * 本番のビルドで必須の環境変数が無い、または 2 つの Supabase の URL が別の origin を指すなら、ビルドを落とす。
 *
 * @impl IMPL-ABOUT-102
 * @design DD-ABOUT-002
 * @remarks 判定は `VERCEL_ENV` で行う。`NODE_ENV` は E2E の本番ビルドも `production` になり、止めてはいけないため。
 * `getSiteUrl` は変えず、設定の漏れはビルドで止める（メール・法令の頁の挙動を変えない）。
 * 署名つき URL は `SUPABASE_URL` 優先で作られ、CSP の `img-src` と `remotePatterns` は `NEXT_PUBLIC_SUPABASE_URL` の
 * 1 つの origin だけを許すので、2 つが別だと署名が通っても画像が止まる。信頼する origin を 1 つに揃える。
 * 許可オリジン（`APP_ALLOWED_ORIGINS`）は、www と apex など複数のオリジンを含む許可の一覧を本番で明示させる
 * ユーザーの決定（2026-10-31）により、無ければビルドで止める。`NEXT_PUBLIC_SITE_URL` が必須なので proxy の
 * 要求由来の値で比べる退避（`hasExplicitOriginConfig` が false の時）は本番では起きない。`proxy.ts`・`redirect.ts` の読み方は変えない。
 * 許可オリジンは、本番では各項目が `new URL()` で読め、`https:` で、`origin` と一致する（末尾の / もパスも無い）形でなければ
 * ビルドで止める（空の項目も止める）。書き間違いの項目が黙って許可から落ち、その側の状態を変える API が 403 になるのを防ぐ。
 * 失敗の文には変数名だけを書き、URL の値を載せない。
 */
export function assertBuildEnv(env: Readonly<Record<string, string | undefined>>): void {
  if (env.VERCEL_ENV === 'production') {
    for (const name of REQUIRED_IN_PRODUCTION) {
      if (!env[name]?.trim()) {
        throw new Error(`${name} が設定されていません。本番のビルドの前に Vercel の Production に設定してください。`);
      }
    }
    assertAllowedOriginsShape(String(env.APP_ALLOWED_ORIGINS));
  }

  const publicOrigin = originOf(env.NEXT_PUBLIC_SUPABASE_URL);
  const serverOrigin = originOf(env.SUPABASE_URL);
  if (publicOrigin && serverOrigin && publicOrigin !== serverOrigin) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL と SUPABASE_URL が別の origin を指しています。同じプロジェクトの URL に揃えてください。');
  }
}
