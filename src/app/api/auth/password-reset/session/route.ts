/**
 * パスワード再設定 Cookie の状態を答える窓口（src/app/api/auth/password-reset/session/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-183
 * @design DD-AUTH-024
 * @remarks 再設定の Cookie は HttpOnly でブラウザの script から読めないため、画面は
 * この窓口に聞いて申請・新パスワード入力のどちらを出すか決める。
 */

import { NextResponse } from 'next/server';
import { cookieOptionsForPasswordReset, passwordResetSessionCookieName } from '@/lib/cookie';
import { readPasswordResetSessionFromCookieHeader } from '@/features/auth/services/password-reset-session';

function buildSessionResponse(body: { ready: boolean; email?: string | null }) {
  const response = NextResponse.json(body, { status: 200 });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function GET(request: Request) {
  const session = readPasswordResetSessionFromCookieHeader(request.headers.get('cookie'));
  const response = buildSessionResponse(
    session ? { ready: true, email: session.email } : { ready: false, email: null }
  );

  if (!session) {
    response.cookies.set({
      name: passwordResetSessionCookieName,
      value: '',
      ...cookieOptionsForPasswordReset(0),
    });
  }

  return response;
}