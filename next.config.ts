import type { NextConfig } from "next";

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
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'placehold.co',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'readdy.ai',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'public.readdy.ai',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        port: '',
        pathname: '/storage/v1/object/public/**',
      },
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        port: '',
        pathname: '/storage/v1/object/sign/**',
      },
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        port: '',
        pathname: '/storage/v1/object/authenticated/**',
      },
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
