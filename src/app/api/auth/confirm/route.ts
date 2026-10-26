/**
 * 確認のメールのリンクの窓口（src/app/api/auth/confirm/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-164
 * @design DD-AUTH-019
 * @remarks メールのリンクは未ログインの端末で開かれるが、token_hash の検証だけでは session を作らない。
 * 登録を始めたブラウザ（控えの Cookie の番号と、確認した利用者のメールを一緒にハッシュした印が signup の未使用の行に当たる）
 * で開いた時だけ session を作る（SEC-AUTH-007、ADR-0413）。控えは session を作る前に使い切る（結び付けの成否は
 * session より先に決めるしかない。保存に失敗した時は、行き先は固定の '/'・控えの Cookie は clear・verifyOtp の session は失効）。
 * 外れた時は、メールの確認だけ済ませ、verifyOtp が GoTrue 側に作った session を signOut(local) で消し、
 * 控えの Cookie は消さずに /login?registered=1 へ送る（攻撃者のリンクで被害者の進行中の登録の控えを壊させない）。
 * 行き先は URL の値を読まない。受けるのは登録の確認（type=signup）の印だけで、それ以外の型では
 * verifyOtp を呼ばない（magiclink・recovery・email の印でログインの通行証を作らせない。SEC-AUTH-006）。
 * 監査には Supabase や例外の文を残さず、固定の符号だけを残す。
 */
import { NextResponse } from 'next/server';
import { createPublicClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { getRequestOrigin } from '@/lib/redirect';
import {
  applyReturnIntentCookie,
  consumeSignupBinding,
  resolveStoredDestination,
} from '@/features/auth/return-intent/return-intent-service';
import { linkGuestOrdersByEmail } from '@/lib/orders/link-guest-orders';

const SUCCESS_REDIRECT_PATH = '/';
const FAILURE_REDIRECT_PATH = '/login';
/** 登録を始めたブラウザで開かなかった時の行き先。session は作らず、ログインを案内する。 */
const UNBOUND_REDIRECT_PATH = '/login?registered=1';
const MFA_REDIRECT_PATH = '/auth/verified';

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

/**
 * verifyOtp が GoTrue 側に作った session を、その session だけ失効させる。
 * supabase-js の signOut は失敗を投げずに { error } で返す（throwOnError が既定 false）ので、両方を拾う。
 * 失敗は握り、ログには符号だけを残す（応答は変えない）。
 */
async function revokeLocalSession(supabase: Awaited<ReturnType<typeof createPublicClient>>) {
  try {
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) {
      console.error('confirm signOut(local) failed', { code: error.code ?? error.status });
    }
  } catch (signOutErr) {
    console.error('confirm signOut(local) failed', { code: (signOutErr as { code?: string } | null)?.code });
  }
}

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

  if (!tokenHash) {
    await logAudit({ action: 'auth.confirm', outcome: 'failure', detail: 'missing_token_hash', metadata: { reason: 'missing_token' } });
    return buildRedirectResponse(origin, FAILURE_REDIRECT_PATH);
  }

  // 登録の確認の印だけを受ける。type の値そのものは監査に残さない。
  if (rawType !== 'signup') {
    await logAudit({ action: 'auth.confirm', outcome: 'failure', detail: 'invalid_type', metadata: { reason: 'invalid_type' } });
    return buildRedirectResponse(origin, FAILURE_REDIRECT_PATH);
  }

  try {
    const supabase = await createPublicClient();
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: 'signup',
    });

    if (error || !data?.session || !data?.user) {
      const reason = classifyConfirmError(error?.message);
      await logAudit({
        action: 'auth.confirm',
        actor_email: data?.user?.email ?? null,
        outcome: 'failure',
        detail: error ? 'verify_failed' : 'missing_session_or_user',
        metadata: { reason },
      });

      return buildRedirectResponse(origin, FAILURE_REDIRECT_PATH);
    }

    // 結び付けの成否は session を作る前に決める。控えをここで使い切る（Cookie は触らない）。
    const binding = await consumeSignupBinding({
      cookieHeader: request.headers.get('cookie'),
      email: data.user.email ?? '',
      userId: data.user.id,
    });

    if (!binding.bound) {
      // メールの確認は済んでいる。verifyOtp が GoTrue 側に作った session は誰にも渡さず、その session だけを失効させる。
      await revokeLocalSession(supabase);
      await logAudit({
        action: 'auth.confirm',
        actor_email: data.user.email ?? null,
        outcome: 'success',
        detail: 'confirmed_without_session',
        resource_id: data.user.id,
        metadata: { reason: 'no_binding' },
      });
      return buildRedirectResponse(origin, UNBOUND_REDIRECT_PATH);
    }

    const res = buildRedirectResponse(origin, SUCCESS_REDIRECT_PATH);

    const { persistSessionAndCookies } = await import('@/features/auth/services/register');
    // ゲストのカートとお気に入りの印を、ログインの保存の後で会員の分へ合わせるために渡す。
    const { readGuestShoppingTokens } = await import('@/features/cart/services/guest-shopping-token');
    const persistResult = await persistSessionAndCookies(res, data.session, data.user, readGuestShoppingTokens(request.headers.get('cookie')));

    if (!persistResult?.ok) {
      await logAudit({
        action: 'auth.confirm',
        actor_email: data.user?.email ?? null,
        outcome: 'error',
        detail: 'session_persist_failed',
        resource_id: data.user?.id,
      });
      // 控えは使い切り済みで、session は誰にも渡さない。控えの Cookie を消し、verifyOtp の session も失効させる。
      applyReturnIntentCookie(res, { kind: 'clear' });
      await revokeLocalSession(supabase);
      return res;
    }

    // ゲストのまま買った注文をこの会員へ引き継ぐ。失敗しても紐付けは冪等なので、次回ログインで再試行される。
    await linkGuestOrdersByEmail({
      userId: data.user.id,
      email: data.user.email ?? '',
      emailConfirmedAt: data.user.email_confirmed_at ?? null,
    });

    const role = data.user.app_metadata?.role;
    const viewerRole = role === 'admin' || role === 'supporter' ? role : 'user';
    // 管理者・サポーターは aal2 になるまで戻り先へ送らない。使い切った戻り先は捨てて 2 段目へ送る。
    const destination =
      viewerRole === 'user'
        ? await resolveStoredDestination({ stored: binding.storedPath, viewer: { role: viewerRole, aal: 'aal1' }, origin })
        : { path: MFA_REDIRECT_PATH, action: { kind: 'clear' } as const };
    res.headers.set('location', new URL(destination.path, origin).toString());
    applyReturnIntentCookie(res, destination.action);

    await logAudit({
      action: 'auth.confirm',
      actor_email: data.user?.email ?? null,
      outcome: 'success',
      resource_id: data.user?.id,
    });

    return res;
  } catch {
    await logAudit({ action: 'auth.confirm', outcome: 'error', detail: 'unexpected', metadata: { reason: 'unexpected' } });
    return buildRedirectResponse(origin, FAILURE_REDIRECT_PATH);
  }
}
