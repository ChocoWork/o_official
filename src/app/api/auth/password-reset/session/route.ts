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