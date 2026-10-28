import type { NextConfig } from "next";
import { assertBuildEnv } from "./src/lib/build-env-guard";

// 本番のビルドで必須の環境変数が無い・2 つの Supabase の URL が別の origin なら、ここでビルドを落とす（SEC-ABOUT-007）。
assertBuildEnv(process.env);

const skipBuildChecks = process.env.NEXT_BUILD_SKIP_CHECKS === '1';

/*
 * 手元の Supabase につないだビルド（E2E）だけ、手元の Storage の画像を next/image で表示できるようにする
 * （設計書 2026-10-05 グループ B の 7-4）。Next.js 16 は手元の住所（127.0.0.1 など）の画像の最適化を既定で止めるので、
 * そのときだけ dangerouslyAllowLocalIP を立てる。本番（*.supabase.co）のビルドでは何も変わらない。
 */
const localSupabaseStorage = (() => {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '');
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? url : null;
  } catch {
    return null;
  }
})();

/*
 * 本番のビルドでは、自分の Supabase プロジェクトの host 1 つだけを next/image の取得元にする
 * （SEC-HOME-017・SEC-NEWS-023。全プロジェクトを許す *.supabase.co は使わない）。
 * CSP の img-src と同じ NEXT_PUBLIC_SUPABASE_URL の origin に揃える。
 */
const remoteSupabaseHost = (() => {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '');
    return url.protocol === 'https:' && !localSupabaseStorage ? url.hostname : null;
  } catch {
    return null;
  }
})();

const nextConfig: NextConfig = {
  /* config options here */
  devIndicators: false,
  poweredByHeader: false,
  ...(skipBuildChecks
    ? {
        typescript: {
          ignoreBuildErrors: true,
        },
        eslint: {
          ignoreDuringBuilds: true,
        },
      }
    : {}),
  images: {
    ...(localSupabaseStorage ? { dangerouslyAllowLocalIP: true } : {}),
    // 署名つきの URL の最適化の画像は、署名の期限（3600 秒）より長くキャッシュしない。
    minimumCacheTTL: 3600,
    remotePatterns: [
      // 本番のバケットは非公開なので、署名つきの道（sign）だけ。public は入れない。
      // authenticated は next/image が認証の見出しを付けられないので入れない。
      ...(remoteSupabaseHost
        ? [
            {
              protocol: 'https' as const,
              hostname: remoteSupabaseHost,
              port: '',
              pathname: '/storage/v1/object/sign/**',
            },
          ]
        : []),
      ...(localSupabaseStorage
        ? [
            {
              protocol: localSupabaseStorage.protocol === 'https:' ? ('https' as const) : ('http' as const),
              hostname: localSupabaseStorage.hostname,
              port: localSupabaseStorage.port,
              pathname: '/storage/v1/object/**',
            },
          ]
        : []),
    ],
  },
};

export default nextConfig;
