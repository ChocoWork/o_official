import { NextResponse, after } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import sendMail from '@/lib/mail';
import { checkPwnedPassword, PWNED_PASSWORD_MESSAGE } from '@/lib/pwned-password';
import { logAudit } from '@/lib/audit';
import { ResetSessionConfirmSchema } from '@/features/auth/schemas/password-reset';
import { formatZodError } from '@/features/auth/schemas/common';
import {
  accessCookieName,
  cookieOptionsForAccess,
  cookieOptionsForCsrf,
  cookieOptionsForPasswordReset,
  cookieOptionsForRefresh,
  csrfCookieName,
  passwordResetSessionCookieName,
  refreshCookieName,
} from '@/lib/cookie';
import { readPasswordResetSessionFromCookieHeader } from '@/features/auth/services/password-reset-session';

// PUBLIC: 再設定フローの終端。認証の代わりに署名済み Cookie と未消費トークン行の
// 両方を検証する（どちらか一方だけを能力にしない）。

/**
 * パスワード変更後は既存セッションを全て切る。
 * 乗っ取られた利用者がパスワードを変えても、失効させないと攻撃者のセッションが
 * access token の exp まで生き残る（OWASP: invalidate the sessions automatically）。
 * 管理者による強制ログアウトと同じ2段構え。失敗しても本処理は成功のまま
 * （パスワードは既に変わっているので、ここで 500 を返す方が利用者に不利）。
 */
async function revokeAllSessions(
  service: Awaited<ReturnType<typeof createServiceRoleClient>>,
  userId: string,
): Promise<void> {
  const { error: appSessionError } = await service
    .from('sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId);

  if (appSessionError) {
    console.error('[password-reset.confirm] failed to revoke app sessions:', appSessionError);
  }

  const { error: authSessionError } = await service.rpc('revoke_auth_sessions_for_user', {
    p_user_id: userId,
  });

  if (authSessionError) {
    console.error('[password-reset.confirm] failed to revoke auth sessions:', authSessionError);
  }
}

export async function POST(request: Request) {
  try {
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:password_reset_confirm', limit: 10, windowSeconds: 3600 });
      if (rl) return rl;
    } catch (e) {
      console.error('Rate limit middleware error (password-reset-confirm):', e);
    }

    const session = readPasswordResetSessionFromCookieHeader(request.headers.get('cookie'));
    if (!session) {
      await logAudit({ action: 'password_reset_confirm', outcome: 'failure', detail: 'missing_reset_session' });
      return NextResponse.json({ error: 'Invalid or expired reset session' }, { status: 400 });
    }

    const body = await request.json();
    const parsed = ResetSessionConfirmSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });

    const { new_password } = parsed.data;

    const supabase = await createServiceRoleClient();

    // Cookie は署名されているが、それだけを能力にしない。トークン行がまだ未消費で
    // 残っていることを確認する。期限（expires_at）はここでは見ない。時間の境界は
    // 10 分の再設定 Cookie が持つ。ここで見ると、フォームを開いて入力している最中に
    // リンクの 10 分が切れて弾かれる。
    const { data: tokenRow, error: tokenError } = await supabase
      .from('password_reset_tokens')
      .select('id')
      .eq('id', session.tokenId)
      .eq('used', false)
      .maybeSingle();

    if (tokenError) {
      console.error('Token lookup error:', tokenError);
      await logAudit({ action: 'password_reset_confirm', actor_email: session.email, outcome: 'error', detail: 'token_lookup_failed' });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    if (!tokenRow) {
      await logAudit({ action: 'password_reset_confirm', actor_email: session.email, outcome: 'failure', detail: 'invalid_or_consumed_token' });
      return NextResponse.json({ error: 'Invalid or expired reset session' }, { status: 400 });
    }

    // 漏洩済みパスワードを弾く。トークンが有効だと確かめた後に行う。順序が逆だと、
    // 消費済み・偽造トークンでも HIBP への外部往復が発生し、未認証の相手に
    // 外部 API を叩かせる導線になる（増幅の踏み台になり、レイテンシも無駄になる）。
    // Supabase の leaked password protection は Pro プラン以上でしか使えないため、
    // 同等の制御をここに置く（FREQ-323）。
    const pwned = await checkPwnedPassword(new_password);
    if (pwned.status === 'pwned') {
      await logAudit({ action: 'password_reset_confirm', actor_email: session.email, outcome: 'failure', detail: 'pwned_password' });
      return NextResponse.json({ error: PWNED_PASSWORD_MESSAGE }, { status: 400 });
    }
    if (pwned.status === 'unavailable') {
      // 外部サービスの障害で再設定を止めない。検査が効いていない期間を追えるよう監査に残す。
      await logAudit({ action: 'password_reset_confirm', actor_email: session.email, outcome: 'error', detail: `pwned_check_unavailable:${pwned.reason}` });
    }

    // ここで初めてトークンを焼く。リンクを開いた時点ではなくパスワードを変える直前に
    // 置くことで、JS を実行するリンクスキャナが踏んでもトークンが残る。
    // used=false を更新条件に含めるので、同じリンクから複数の Cookie が出ていても
    // 通るのは 1 つだけ（0 行なら競合に負けた側）。
    // 弱いパスワードで弾かれた利用者のリンクを焼かないよう、漏洩照合より後に置く。
    const { data: claimedRow, error: claimError } = await supabase
      .from('password_reset_tokens')
      .update({ used: true })
      .eq('id', session.tokenId)
      .eq('used', false)
      .select('id')
      .maybeSingle();

    if (claimError) {
      console.error('Token claim error:', claimError);
      await logAudit({ action: 'password_reset_confirm', actor_email: session.email, outcome: 'error', detail: 'token_claim_failed' });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    if (!claimedRow) {
      await logAudit({ action: 'password_reset_confirm', actor_email: session.email, outcome: 'failure', detail: 'token_already_consumed' });
      return NextResponse.json({ error: 'Invalid or expired reset session' }, { status: 400 });
    }

    // updateUserById は AuthError を投げずに { data, error } で返す。
    // 戻り値を見ないと、パスワードポリシー違反などで失敗しても「更新しました」を返してしまう。
    const { error: updateError } = await supabase.auth.admin.updateUserById(session.userId, {
      password: new_password,
    });

    if (updateError) {
      console.error('Failed to update user password:', updateError);
      await logAudit({ action: 'password_reset_confirm', actor_email: session.email, outcome: 'error', detail: updateError.message });
      return NextResponse.json({ error: 'Failed to update password' }, { status: 500 });
    }

    // 使い終わったトークン行を落とす。used=true のまま残しても使い回しは弾かれるが、
    // 不要な行を溜めない。
    const { error: deleteError } = await supabase.from('password_reset_tokens').delete().eq('id', session.tokenId);
    if (deleteError) {
      console.error('Failed to delete consumed password reset token:', deleteError);
    }

    await revokeAllSessions(supabase, session.userId);

    const response = NextResponse.json({ ok: true }, { status: 200 });
    response.cookies.set({
      name: passwordResetSessionCookieName,
      value: '',
      ...cookieOptionsForPasswordReset(0),
    });
    // 全セッションを失効させたので、この端末に残っている認証 Cookie も落とす。
    // 残すと失効済みのトークンで 401 を繰り返すことになる。
    response.cookies.set({ name: accessCookieName, value: '', ...cookieOptionsForAccess(0) });
    response.cookies.set({ name: refreshCookieName, value: '', ...cookieOptionsForRefresh(0) });
    response.cookies.set({ name: csrfCookieName, value: '', ...cookieOptionsForCsrf(0) });

    // 本人が気づけるように変更を通知する。パスワードそのものは本文に入れない。
    const notifyEmail = session.email;
    after(async () => {
      try {
        await sendMail({
          to: notifyEmail,
          subject: 'パスワードを変更しました',
          html: '<p>アカウントのパスワードが変更されました。</p><p>心当たりがない場合は、ただちにパスワードを再設定のうえお問い合わせください。</p>',
          text: 'アカウントのパスワードが変更されました。心当たりがない場合は、ただちにパスワードを再設定のうえお問い合わせください。',
        });
      } catch (mailErr) {
        console.warn('Failed to send password change notification:', mailErr);
      }
    });

    await logAudit({ action: 'password_reset_confirm', actor_email: session.email, outcome: 'success', resource_id: session.userId });
    return response;
  } catch (err) {
    console.error('Password reset confirm error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
