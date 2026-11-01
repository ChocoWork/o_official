/**
 * パスワード変更の開始の窓口。現行パスワードを確かめ、メールで 8 桁の確認コードを送る（src/app/api/auth/password/change/start/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-230
 * @design DD-AUTH-041
 * @remarks ログイン中の会員が自分でパスワードを変える 2 段のうちの 1 段目。現行パスワードを先に要るのは、盗んだ session の持ち主が
 * 本人のメールへコードを撒けないようにするため。確かめは captcha を免除される auth だけの client で行う。
 * 現行パスワードの総当たりの窓口にならないよう、IP ごと 20 回／10 分に加えて本人ごと 5 回／10 分に制限し、成否を監査に残す。
 * 管理者・サポーターは aal2 でなければ断る（GoTrue も MFA 済みの利用者に aal2 を求める。直接の道と同じ強さ）。
 * /api/auth の応答は proxy が no-store にする。監査・応答にはパスワード・コード・session_id を残さず、固定の符号だけを残す。
 */
import { NextResponse } from 'next/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { PasswordChangeStartSchema } from '@/features/auth/schemas/password-change';
import { formatZodError } from '@/features/auth/schemas/common';
import {
  PASSWORD_CHANGE_CODE_TTL_SECONDS,
  generatePasswordChangeCode,
  hashPasswordChangeCode,
  sendPasswordChangeCodeMail,
  verifyCurrentPassword,
  voidPasswordChangeChallenge,
} from '@/features/auth/services/password-change';

const ACTION = 'password_change_start';
const ENDPOINT = 'auth:password_change_start';

export async function POST(request: Request) {
  try {
    const rlIp = await enforceRateLimit({ request, endpoint: ENDPOINT, limit: 20, windowSeconds: 600 });
    if (rlIp) return rlIp;

    const auth = await authenticateRequest(request);
    if (!auth.ok) return authFailureResponse(auth.reason);

    const { claims } = auth;
    const userId = claims.sub;
    const email = claims.email;
    const authSessionId = claims.session_id?.toLowerCase();
    if (!email || !authSessionId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 別のサイトからの要求が拒否の監査の行を増やせないよう、監査の行を書く前に置く。
    const csrf = await requireCsrfOrDeny();
    if (csrf instanceof Response) return csrf;

    const role = claims.app_metadata?.role;
    if ((role === 'admin' || role === 'supporter') && claims.aal !== 'aal2') {
      await logAudit({ action: ACTION, actor_id: userId, actor_email: email, outcome: 'denied', detail: 'aal2_required' });
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const rlUser = await enforceRateLimit({ request, endpoint: ENDPOINT, limit: 5, windowSeconds: 600, subject: userId });
    if (rlUser) return rlUser;

    const body = await request.json().catch(() => null);
    const parsed = PasswordChangeStartSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });

    const current = await verifyCurrentPassword(email, parsed.data.current_password);
    if (!current.ok) {
      if (current.reason === 'invalid') {
        await logAudit({ action: ACTION, actor_id: userId, actor_email: email, outcome: 'failure', detail: 'current_password_invalid' });
        return NextResponse.json({ error: '現行のパスワードが正しくありません。' }, { status: 401 });
      }
      if (current.reason === 'captcha_rejected') {
        await logAudit({ action: ACTION, actor_id: userId, actor_email: email, outcome: 'error', detail: 'supabase_captcha_rejected' });
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
      }
      await logAudit({ action: ACTION, actor_id: userId, actor_email: email, outcome: 'error', detail: 'current_password_check_unavailable' });
      return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 });
    }

    const code = generatePasswordChangeCode();
    const service = await createServiceRoleClient();
    const { data: challengeId, error: issueError } = await service.rpc('issue_password_change_challenge', {
      p_user_id: userId,
      p_auth_session_id: authSessionId,
      p_code_hash: hashPasswordChangeCode({ userId, authSessionId, code }),
      p_ttl_seconds: PASSWORD_CHANGE_CODE_TTL_SECONDS,
    });
    if (issueError || typeof challengeId !== 'string') {
      console.error('password change start: issue failed', { code: (issueError as { code?: string } | null)?.code });
      await logAudit({ action: ACTION, actor_id: userId, actor_email: email, outcome: 'error', detail: 'issue_failed' });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    try {
      await sendPasswordChangeCodeMail(email, code);
    } catch {
      // 送れていないコードを有効なままにしない。
      const voided = await voidPasswordChangeChallenge(challengeId);
      await logAudit({
        action: ACTION,
        actor_id: userId,
        actor_email: email,
        outcome: 'error',
        detail: voided ? 'mail_failed' : 'mail_failed:challenge_void_failed',
      });
      return NextResponse.json({ error: '確認コードを送れませんでした。時間をおいて再度お試しください。' }, { status: 500 });
    }

    await logAudit({ action: ACTION, actor_id: userId, actor_email: email, outcome: 'success', detail: 'code_sent' });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error('Password change start error:', err instanceof Error ? err.name : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
