/**
 * ログインの後の行き先を答える窓口（src/app/api/auth/post-login/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-209
 * @design DD-AUTH-035
 * @remarks 確認コードの確定と 2 段目の完了は端末が移動するので、サーバーが 303 を返せない。この窓口が戻り先を使い切って行き先を返す。
 * 役割と aal はトークンの claims からだけ読み、本文や見出しは信用しない。管理者・サポーターは aal2 になるまで使い切らない。
 */
import { NextResponse } from 'next/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import {
  applyReturnIntentCookie,
  resolveReturnDestination,
} from '@/features/auth/return-intent/return-intent-service';

type UserRole = 'admin' | 'supporter' | 'user';

const toRole = (role: unknown): UserRole => (role === 'admin' || role === 'supporter' ? role : 'user');

export async function POST(request: Request) {
  const rl = await enforceRateLimit({ request, endpoint: 'auth:post-login', limit: 60, windowSeconds: 600 });
  if (rl) return rl;

  try {
    const auth = await authenticateRequest(request);
    if (!auth.ok) {
      return authFailureResponse(auth.reason);
    }

    const { claims } = auth;
    const resolved = await resolveReturnDestination({
      cookieHeader: request.headers.get('cookie'),
      purpose: 'login',
      viewer: {
        id: claims.sub,
        role: toRole(claims.app_metadata?.role),
        aal: typeof claims.aal === 'string' ? claims.aal : null,
      },
    });

    const res = NextResponse.json({ redirectTo: resolved.path, needsMfa: resolved.needsMfa }, { status: 200 });
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('Referrer-Policy', 'no-referrer');
    applyReturnIntentCookie(res, resolved.action);
    return res;
  } catch (err) {
    console.error('post-login error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
