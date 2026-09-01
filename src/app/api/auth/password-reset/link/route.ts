import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { cookieOptionsForPasswordReset, passwordResetSessionCookieName } from '@/lib/cookie';
import { createPasswordResetSessionToken, passwordResetSessionMaxAgeSeconds } from '@/features/auth/services/password-reset-session';
import { getRequestOrigin } from '@/lib/redirect';
import { createServiceRoleClient } from '@/lib/supabase/server';

const PASSWORD_RESET_PAGE_PATH = '/auth/password-reset';
const PASSWORD_RESET_VERIFY_PATH = '/auth/password-reset/verify';

function buildRedirectResponse(origin: string, path: string) {
  const response = NextResponse.redirect(new URL(path, origin), { status: 303 });
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

function buildJsonResponse(body: unknown, status: number) {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

/**
 * メール内のリンクを踏んだときの入口。ここではトークンを消費せず、確認ページへ送るだけ。
 *
 * 企業メールのリンクスキャナは受信時にリンクを GET する。GET で消費する作りだと
 * 利用者が開く前にトークンが潰れ、再送しても新しいリンクがまた同じようにスキャンされるため
 * 永久に再設定できなくなる（Supabase の Production Checklist が明記している事象）。
 * 消費は確認ページのボタンから POST するときだけ行う。
 */
export async function GET(request: Request) {
  const origin = getRequestOrigin(request);
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) {
    await logAudit({ action: 'password_reset_link', outcome: 'failure', detail: 'missing_token' });
    return buildRedirectResponse(origin, `${PASSWORD_RESET_PAGE_PATH}?error=link_invalid`);
  }

  const target = new URL(PASSWORD_RESET_VERIFY_PATH, origin);
  target.searchParams.set('token', token);
  return buildRedirectResponse(origin, `${target.pathname}${target.search}`);
}

/**
 * 確認ページのボタンから呼ばれる。ここでトークンを1回だけ消費して再設定 Cookie を張る。
 */
export async function POST(request: Request) {
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

    const body = await request.json().catch(() => null);
    const token = typeof body?.token === 'string' ? body.token : null;
    if (!token) {
      await logAudit({ action: 'password_reset_link', outcome: 'failure', detail: 'missing_token' });
      return buildJsonResponse({ error: 'link_invalid' }, 400);
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const supabase = await createServiceRoleClient();

    // 照合と消費を1文で行う。select してから update する形だと、同時に踏まれたとき
    // 両方が「未使用」を見て両方成功し、再設定 Cookie が二重に発行される。
    // used=false を更新条件に含めることで、勝つのは片方だけになる。
    const { data: tokenRow, error: consumeError } = await supabase
      .from('password_reset_tokens')
      .update({ used: true })
      .eq('token_hash', tokenHash)
      .eq('used', false)
      .gte('expires_at', new Date().toISOString())
      .select('id, user_id, email')
      .maybeSingle();

    if (consumeError) {
      console.error('Password reset link consume error:', consumeError);
      await logAudit({ action: 'password_reset_link', outcome: 'error', detail: consumeError.message });
      return buildJsonResponse({ error: 'link_expired' }, 400);
    }

    if (!tokenRow) {
      await logAudit({ action: 'password_reset_link', outcome: 'failure', detail: 'invalid_or_expired_token' });
      return buildJsonResponse({ error: 'link_expired' }, 400);
    }

    let userId = tokenRow.user_id as string | null;
    if (!userId) {
      const { findAuthUserIdByEmail } = await import('@/features/auth/services/auth-admin-user');
      const lookup = await findAuthUserIdByEmail(supabase, tokenRow.email);

      // 引けなかっただけなら link_expired を返さない。トークンは既に消費済みなので、
      // 期限切れと言って再送を促すと、消費済みのリンクを二度と使えないまま
      // 利用者を袋小路に入れることになる。500 で「もう一度」を促す。
      if (lookup.status === 'error') {
        await logAudit({
          action: 'password_reset_link',
          actor_email: tokenRow.email,
          outcome: 'error',
          detail: 'user_lookup_failed',
        });
        return buildJsonResponse({ error: 'internal_error' }, 500);
      }

      userId = lookup.status === 'found' ? lookup.userId : null;
    }

    if (!userId) {
      await logAudit({
        action: 'password_reset_link',
        actor_email: tokenRow.email,
        outcome: 'error',
        detail: 'user_not_found',
      });
      return buildJsonResponse({ error: 'link_expired' }, 400);
    }

    const response = buildJsonResponse({ ok: true, redirectTo: PASSWORD_RESET_PAGE_PATH }, 200);
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
    return buildJsonResponse({ error: 'link_expired' }, 400);
  }
}
