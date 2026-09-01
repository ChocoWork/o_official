import { NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth/authenticate';

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
    // 失効済みセッションで authenticated:true を返すと、UI は管理メニューを描くのに
    // API は 401 を返すという食い違いが起きる。認可側と同じ根拠で答える。
    const verified = await authenticateRequest(request);

    if (!verified.ok) {
      // 「失効している」と「失効しているか確認できなかった」を分ける。
      // 後者で authenticated:false を返すと、DB の一時障害だけで全利用者の画面が
      // ログアウト状態に落ちる。503 にしてクライアント側に前の状態を維持させる。
      if (verified.reason === 'unavailable') {
        const response = NextResponse.json(
          { authenticated: false, reason: 'unavailable' },
          { status: 503, headers: { 'Retry-After': '30' } },
        );
        response.headers.set('Cache-Control', 'no-store');
        response.headers.set('Referrer-Policy', 'no-referrer');
        return response;
      }

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
