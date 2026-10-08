import { NextResponse } from 'next/server';
import { createPublicClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { getRequestOrigin, sanitizeRedirectPath } from '@/lib/redirect';
import { linkGuestOrdersByEmail } from '@/lib/orders/link-guest-orders';

const DEFAULT_REDIRECT_PATH = '/account';
type OtpType = 'signup' | 'email' | 'magiclink' | 'recovery';
const ALLOWED_OTP_TYPES = new Set<OtpType>(['signup', 'email', 'magiclink', 'recovery']);

function classifyConfirmError(message: string | undefined) {
  const normalized = (message || '').toLowerCase();
  if (normalized.includes('expired')) return 'expired';
  if (normalized.includes('invalid')) return 'invalid';
  if (normalized.includes('used') || normalized.includes('reused') || normalized.includes('already')) return 'reused';
  return 'unknown';
}

function buildRedirectResponse(origin: string, redirectPath: string) {
  const res = NextResponse.redirect(new URL(redirectPath, origin), { status: 303 });
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

// PUBLIC: メール確認の入口。Supabase が token_hash を検証してからセッションを発行する。
export async function GET(request: Request) {
  try {
    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const rl = await enforceRateLimit({ request, endpoint: 'auth:confirm', limit: 50, windowSeconds: 600 });
    if (rl) {
      if (rl instanceof Response) {
        return rl;
      }

      const fallback = NextResponse.json({ error: 'Too many requests' }, { status: 429 });
      fallback.headers.set('Retry-After', '600');
      return fallback;
    }
  } catch (e) {
    console.error('Rate limit middleware error (confirm):', e);
  }

  const origin = getRequestOrigin(request);
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get('token_hash') || url.searchParams.get('token');
  const rawType = url.searchParams.get('type') || 'signup';
  const otpType: OtpType = ALLOWED_OTP_TYPES.has(rawType as OtpType) ? (rawType as OtpType) : 'signup';
  const redirectPath = sanitizeRedirectPath(url.searchParams.get('redirect_to'), DEFAULT_REDIRECT_PATH);

  if (!tokenHash) {
    await logAudit({ action: 'auth.confirm', outcome: 'failure', detail: 'missing_token_hash', metadata: { reason: 'missing_token' } });
    return buildRedirectResponse(origin, redirectPath);
  }

  try {
    const supabase = await createPublicClient();
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: otpType,
    });

    if (error || !data?.session || !data?.user) {
      const reason = classifyConfirmError(error?.message);
      await logAudit({
        action: 'auth.confirm',
        actor_email: data?.user?.email ?? null,
        outcome: 'failure',
        detail: error?.message || 'missing_session_or_user',
        metadata: { reason },
      });

      return buildRedirectResponse(origin, redirectPath);
    }

    const res = buildRedirectResponse(origin, redirectPath);

    const { persistSessionAndCookies } = await import('@/features/auth/services/register');
    // ゲストのカートとお気に入りの印を、ログインの保存の後で会員の分へ合わせるために渡す。
    const { readGuestShoppingTokens } = await import('@/features/cart/services/guest-shopping-token');
    const persistResult = await persistSessionAndCookies(res, data.session, data.user, readGuestShoppingTokens(request.headers.get('cookie')));

    if (!persistResult?.ok) {
      await logAudit({
        action: 'auth.confirm',
        actor_email: data.user?.email ?? null,
        outcome: 'error',
        detail: `session_persist_failed: ${persistResult?.error || 'unknown'}`,
        resource_id: data.user?.id,
      });
      return res;
    }

    // ゲストのまま買った注文をこの会員へ引き継ぐ。
    // 失敗しても紐付けは冪等なので、次回ログインで再試行される。
    await linkGuestOrdersByEmail({
      userId: data.user.id,
      email: data.user.email ?? '',
      emailConfirmedAt: data.user.email_confirmed_at ?? null,
    });

    await logAudit({
      action: 'auth.confirm',
      actor_email: data.user?.email ?? null,
      outcome: 'success',
      resource_id: data.user?.id,
    });

    return res;
  } catch (err) {
    await logAudit({ action: 'auth.confirm', outcome: 'error', detail: String(err), metadata: { reason: 'unexpected' } });
    return buildRedirectResponse(origin, redirectPath);
  }
}
