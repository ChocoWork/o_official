import { NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/supabase/server';

type UserRole = 'admin' | 'supporter' | 'user';

const isUserRole = (role: unknown): role is UserRole => {
  return role === 'admin' || role === 'supporter' || role === 'user';
};

const buildResponse = (body: unknown) => {
  const response = NextResponse.json(body, { status: 200 });
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
};

export async function GET(request: Request) {
  try {
    const verified = await verifyAccessToken(request);

    if (!verified.ok) {
      return buildResponse({ authenticated: false });
    }

    const { claims } = verified;
    const role = isUserRole(claims.app_metadata?.role) ? claims.app_metadata.role : 'user';

    // 認可側（admin-rbac）と同じ根拠で MFA を判定する。ここがずれると
    // 画面は管理者向け UI を出すのに API は 403 という状態になる。
    const mfaVerified = claims.aal === 'aal2';

    return buildResponse({
      authenticated: true,
      user: {
        id: claims.sub,
        email: claims.email ?? null,
        role,
        mfaVerified,
      },
    });
  } catch (error) {
    console.error('Auth me handler error:', error);
    return buildResponse({ authenticated: false });
  }
}
