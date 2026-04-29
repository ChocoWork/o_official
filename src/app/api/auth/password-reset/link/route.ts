import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { cookieOptionsForPasswordReset, passwordResetSessionCookieName } from '@/lib/cookie';
import { createPasswordResetSessionToken, passwordResetSessionMaxAgeSeconds } from '@/features/auth/services/password-reset-session';
import { getRequestOrigin } from '@/lib/redirect';
import { createServiceRoleClient } from '@/lib/supabase/server';

const PASSWORD_RESET_PAGE_PATH = '/auth/password-reset';

function buildRedirectResponse(origin: string) {
  const response = NextResponse.redirect(new URL(PASSWORD_RESET_PAGE_PATH, origin), { status: 303 });
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

export async function GET(request: Request) {
  const origin = getRequestOrigin(request);

  try {
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:password_reset_link', limit: 20, windowSeconds: 600 });
      if (rl) {
        return rl;
      }
    } catch (error) {
      console.error('Rate limit middleware error (password-reset-link):', error);
    }

    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (!token) {
      await logAudit({ action: 'password_reset_link', outcome: 'failure', detail: 'missing_token' });
      return buildRedirectResponse(origin);
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const supabase = await createServiceRoleClient();
    const { data: tokenRow, error: tokenError } = await supabase
      .from('password_reset_tokens')
      .select('*')
      .eq('token_hash', tokenHash)
      .gte('expires_at', new Date().toISOString())
      .eq('used', false)
      .maybeSingle();

    if (tokenError || !tokenRow) {
      await logAudit({
        action: 'password_reset_link',
        actor_email: tokenRow?.email ?? null,
        outcome: 'failure',
        detail: tokenError?.message || 'invalid_or_expired_token',
      });
      return buildRedirectResponse(origin);
    }

    let userId = tokenRow.user_id as string | null;
    if (!userId) {
      const { findAuthUserIdByEmail } = await import('@/features/auth/services/auth-admin-user');
      userId = await findAuthUserIdByEmail(supabase, tokenRow.email);
    }

    if (!userId) {
      await logAudit({
        action: 'password_reset_link',
        actor_email: tokenRow.email,
        outcome: 'error',
        detail: 'user_not_found',
      });
      return buildRedirectResponse(origin);
    }

    await supabase.from('password_reset_tokens').update({ used: true }).eq('id', tokenRow.id);

    const response = buildRedirectResponse(origin);
    response.cookies.set({
      name: passwordResetSessionCookieName,
      value: createPasswordResetSessionToken({
        userId,
        email: tokenRow.email,
        tokenId: tokenRow.id,
      }),
      ...cookieOptionsForPasswordReset(passwordResetSessionMaxAgeSeconds),
    });

    await logAudit({
      action: 'password_reset_link',
      actor_email: tokenRow.email,
      outcome: 'success',
      resource_id: userId,
    });

    return response;
  } catch (error) {
    console.error('Password reset link error:', error);
    return buildRedirectResponse(origin);
  }
}