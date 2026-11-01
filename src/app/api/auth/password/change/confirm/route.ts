/**
 * パスワード変更の確定の窓口。確認コードと新しいパスワードを受け、変更して全 session を失効する（src/app/api/auth/password/change/confirm/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-231
 * @design DD-AUTH-041
 * @remarks 順番は「書式の検査 → 漏洩確認 → コードを使い切る → パスワードの更新 → 全 session の失効 → Cookie の削除 → 通知」。
 * コードは本人確認なので、弱いパスワードで弾かれた人のコードを焼かないよう、書式と漏洩確認をコードの消費より前に置く。
 * 「新パスワードが現行と同じ」の確かめは置かない。ハッシュは GoTrue の中にあり、比べるには現行パスワードの確かめを呼ぶしかなく、
 * コードを持たない要求でも現行パスワードの当否を明かす窓口になってしまうため。この窓口は GoTrue の signInWithPassword を呼ばない。
 * 変更後はこの端末を含む全 session を失効し、認証 Cookie を消す。失効の失敗は 200 のまま監査 revoke_failed に残す
 * （パスワードは既に変わっている）が、この端末の Cookie は必ず消す。コードが違う・使えない・期限切れは同じ文で答える。
 * 応答は同じ文でも、監査の符号は分ける（`code_invalid` 誤り、`code_locked` 5 回の誤りで止まった、`code_unusable` 期限切れ・使用済み・送り直しで無効・別の session）。
 */
import { NextResponse, after } from 'next/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { checkPwnedPassword, PWNED_PASSWORD_MESSAGE } from '@/lib/pwned-password';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { PasswordChangeConfirmSchema } from '@/features/auth/schemas/password-change';
import { formatZodError } from '@/features/auth/schemas/common';
import { hashPasswordChangeCode, sendPasswordChangedNotice } from '@/features/auth/services/password-change';
import {
  accessCookieName,
  cookieOptionsForAccess,
  cookieOptionsForCsrf,
  cookieOptionsForRefresh,
  csrfCookieName,
  refreshCookieName,
} from '@/lib/cookie';

const ACTION = 'password_change_confirm';
const ENDPOINT = 'auth:password_change_confirm';
const CODE_UNUSABLE_MESSAGE = '確認コードが正しくないか、期限が切れています。もう一度コードを送ってください。';

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
    const parsed = PasswordChangeConfirmSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });
    const { code, new_password: newPassword } = parsed.data;

    // コードを使う前に漏洩確認。弱いパスワードで弾かれた人のコードを焼かない。
    const pwned = await checkPwnedPassword(newPassword);
    if (pwned.status === 'pwned') {
      await logAudit({ action: ACTION, actor_id: userId, actor_email: email, outcome: 'failure', detail: 'pwned_password' });
      return NextResponse.json({ error: PWNED_PASSWORD_MESSAGE }, { status: 400 });
    }
    if (pwned.status === 'unavailable') {
      // 外部サービスの障害で変更を止めない。検査が効いていない期間を追えるよう監査に残す。
      await logAudit({ action: ACTION, actor_id: userId, actor_email: email, outcome: 'error', detail: `pwned_check_unavailable:${pwned.reason}` });
    }

    const service = await createServiceRoleClient();
    const { data: consumed, error: consumeError } = await service.rpc('consume_password_change_challenge', {
      p_user_id: userId,
      p_auth_session_id: authSessionId,
      p_code_hash: hashPasswordChangeCode({ userId, authSessionId, code }),
    });
    if (consumeError) {
      console.error('password change confirm: consume failed', { code: (consumeError as { code?: string }).code });
      await logAudit({ action: ACTION, actor_id: userId, actor_email: email, outcome: 'error', detail: 'consume_failed' });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
    if (consumed !== 'ok') {
      await logAudit({
        action: ACTION,
        actor_id: userId,
        actor_email: email,
        outcome: 'failure',
        detail: consumed === 'invalid' ? 'code_invalid' : consumed === 'locked' ? 'code_locked' : 'code_unusable',
      });
      return NextResponse.json({ error: CODE_UNUSABLE_MESSAGE }, { status: 401 });
    }

    // updateUserById は throw せず { error } を返す。見ないと失敗しても成功を返してしまう。
    const { error: updateError } = await service.auth.admin.updateUserById(userId, { password: newPassword });
    if (updateError) {
      // コードは焼けたまま。もう一度 start からやり直す。誤りの本文にパスワードが入りうるので残さない。
      console.error('password change confirm: update failed', { code: (updateError as { code?: string }).code });
      await logAudit({ action: ACTION, actor_id: userId, actor_email: email, outcome: 'error', detail: 'update_failed' });
      return NextResponse.json({ error: 'Failed to update password' }, { status: 500 });
    }

    // この端末を含む全 session を失効する。失敗してもパスワードは変わっているので 200 のまま、監査に残す。
    try {
      await revokeAllSessionsForUser(userId);
    } catch {
      await logAudit({ action: ACTION, actor_id: userId, actor_email: email, outcome: 'error', detail: 'revoke_failed' });
    }

    const response = NextResponse.json({ ok: true }, { status: 200 });
    // 失効した session の Cookie を残すと、失効済みのトークンで 401 を繰り返す。失効に失敗した時も必ず消す。
    response.cookies.set({ name: accessCookieName, value: '', ...cookieOptionsForAccess(0) });
    response.cookies.set({ name: refreshCookieName, value: '', ...cookieOptionsForRefresh(0) });
    response.cookies.set({ name: csrfCookieName, value: '', ...cookieOptionsForCsrf(0) });

    after(async () => {
      try {
        await sendPasswordChangedNotice(email);
      } catch {
        console.warn('Failed to send password change notification');
      }
    });

    await logAudit({ action: ACTION, actor_id: userId, actor_email: email, outcome: 'success', detail: 'password_changed' });
    return response;
  } catch (err) {
    console.error('Password change confirm error:', err instanceof Error ? err.name : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
