import { NextResponse } from 'next/server';
import { createClient, resolveRequestUser } from '@/lib/supabase/server';

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
    const supabase = await createClient(request);
    const {
      data: { user },
    } = await resolveRequestUser(supabase, request);

    if (!user) {
      return buildResponse({ authenticated: false });
    }

    const role = isUserRole(user.app_metadata?.role) ? user.app_metadata.role : 'user';
    const mfaVerified = user.app_metadata?.admin_mfa_verified === true || user.app_metadata?.mfa_verified === true;

    return buildResponse({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email ?? null,
        role,
        mfaVerified,
      },
    });
  } catch (error) {
    console.error('Auth me handler error:', error);
    return buildResponse({ authenticated: false });
  }
}