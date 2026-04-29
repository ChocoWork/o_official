import type { NextConfig } from "next";

const skipBuildChecks = process.env.NEXT_BUILD_SKIP_CHECKS === '1';

const nextConfig: NextConfig = {
  /* config options here */
  devIndicators: false,
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
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'placehold.co',
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
      // SECURITY NOTE:
      // readdy.ai image URLs are still referenced by legacy/demo content.
      // Keep this allow-list only while that content exists, and review regularly.
      {
        protocol: 'https',
        hostname: 'readdy.ai',
        port: '',
        pathname: '/api/search-image',
      },
    ],
  },
};

export default nextConfig;