/**
 * ビルドの時に環境変数の設定漏れ・食い違いを検出する（src/lib/build-env-guard.ts）。共有の `next.config.ts` が先頭で呼ぶ。
 *
 * @packageDocumentation
 */

// ビルドの時に値が埋め込まれ、本番で無いと意図しない URL に落ちる変数（SEC-ABOUT-007）。
const REQUIRED_IN_PRODUCTION = ['NEXT_PUBLIC_SITE_URL', 'NEXT_PUBLIC_SUPABASE_URL'] as const;

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
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
 * 失敗の文には変数名だけを書き、URL の値を載せない。
 */
export function assertBuildEnv(env: Readonly<Record<string, string | undefined>>): void {
  if (env.VERCEL_ENV === 'production') {
    for (const name of REQUIRED_IN_PRODUCTION) {
      if (!env[name]?.trim()) {
        throw new Error(`${name} が設定されていません。本番のビルドの前に Vercel の Production に設定してください。`);
      }
    }
  }

  const publicOrigin = originOf(env.NEXT_PUBLIC_SUPABASE_URL);
  const serverOrigin = originOf(env.SUPABASE_URL);
  if (publicOrigin && serverOrigin && publicOrigin !== serverOrigin) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL と SUPABASE_URL が別の origin を指しています。同じプロジェクトの URL に揃えてください。');
  }
}
