/**
 * パスワード変更の部品（コードの作成・鍵つきのハッシュ・現行パスワードの確かめ・メール）（src/features/auth/services/password-change.ts）。
 *
 * @packageDocumentation
 */
import crypto from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { createServiceRoleAuthClient, isCaptchaRejection } from '@/lib/auth/service-role-auth-client';
import { readAuthSessionId } from '@/lib/auth/app-session';
import sendMail from '@/lib/mail';

/** 確認コードの寿命（10 分）。DB の issue_password_change_challenge は 60..900 秒だけ受ける。 */
export const PASSWORD_CHANGE_CODE_TTL_SECONDS = 600;
/** 間違いの上限。DB の consume_password_change_challenge と同じ値。変えるなら移行も直す。 */
export const PASSWORD_CHANGE_MAX_ATTEMPTS = 5;

/**
 * 8 桁の確認コード（0 埋め）を作る。
 *
 * @impl IMPL-AUTH-229
 * @design DD-AUTH-041
 * @remarks 暗号論的な乱数（crypto.randomInt）で作る。Math.random は予測できるので使わない。先頭が 0 のコードを落とさないよう文字列で持つ。
 */
export function generatePasswordChangeCode(): string {
  return String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
}

/**
 * 確認コードを、利用者と GoTrue の session に結んだ鍵つきのハッシュにする（HMAC-SHA256 の hex 64 桁）。
 *
 * @impl IMPL-AUTH-234
 * @design DD-AUTH-041
 * @remarks コードは 10^8 通りしかなく、鍵の無い sha256 では行が漏れた時に数秒で逆算される。鍵はサーバーの秘密 JWT_SECRET
 * （login-2fa-session・password-reset-session と同じ。新しい環境変数は作らない）。無ければ throw する。
 * 利用者と session を入力に含めるので、別の session や別の人のコードとして使い回せない。
 */
export function hashPasswordChangeCode(input: { userId: string; authSessionId: string; code: string }): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }
  return crypto
    .createHmac('sha256', secret)
    .update(`password_change:${input.userId}:${input.authSessionId}:${input.code}`)
    .digest('hex');
}

/**
 * 発行したコードを無効にする（メールが送れなかった時）。失敗しても throw せず、成否を返す。
 *
 * @impl IMPL-AUTH-235
 * @design DD-AUTH-041
 * @remarks 送れていないコードを有効なまま残さない。呼び手はメールの失敗の 500 を返すので、ここで例外にして隠さない。
 * 表への UPDATE は M3 が service_role に許した権限で行い、新しい関数は作らない。
 */
export async function voidPasswordChangeChallenge(challengeId: string): Promise<boolean> {
  try {
    const service = await createServiceRoleClient();
    const { error } = await service
      .from('password_change_challenges')
      .update({ used_at: new Date().toISOString() })
      .eq('id', challengeId)
      .is('used_at', null);
    if (error) {
      console.error('voidPasswordChangeChallenge: update failed', { code: (error as { code?: string }).code });
      return false;
    }
    return true;
  } catch {
    console.error('voidPasswordChangeChallenge: unexpected failure');
    return false;
  }
}

export type CurrentPasswordResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'captcha_rejected' | 'unavailable' };

/**
 * 現行パスワードが合っているかを GoTrue で確かめる。成功したら作られた session をすぐ消す。
 *
 * @impl IMPL-AUTH-236
 * @design DD-AUTH-041
 * @remarks ハッシュは GoTrue の中にあり、アプリは比べられない。captcha を免除される auth だけのクライアント（サービスの鍵）で
 * signInWithPassword し、確かめるたびに GoTrue に増える session は revoke_auth_session で消す（溜めない）。
 * 誤りの本文・パスワードは返さず console にも残さない（呼び手は固定の符号だけを扱う）。
 */
export async function verifyCurrentPassword(email: string, password: string): Promise<CurrentPasswordResult> {
  try {
    const auth = await createServiceRoleAuthClient();
    const { data, error } = await auth.auth.signInWithPassword({ email, password });

    if (error) {
      if (isCaptchaRejection(error)) return { ok: false, reason: 'captcha_rejected' };
      const { code, status, name } = error as { code?: string; status?: number; name?: string };
      if (name === 'AuthRetryableFetchError' || (typeof status === 'number' && (status === 0 || status >= 500))) {
        return { ok: false, reason: 'unavailable' };
      }
      if (code === 'invalid_credentials' || status === 400 || status === 401) {
        return { ok: false, reason: 'invalid' };
      }
      return { ok: false, reason: 'unavailable' };
    }

    const sessionId = readAuthSessionId(data?.session?.access_token);
    if (!sessionId) {
      console.error('verifyCurrentPassword: auth session id unreadable; session not revoked');
    } else {
      try {
        const service = await createServiceRoleClient();
        const { error: revokeError } = await service.rpc('revoke_auth_session', { p_session_id: sessionId });
        if (revokeError) {
          console.error('verifyCurrentPassword: revoke_auth_session failed', {
            code: (revokeError as { code?: string }).code,
          });
        }
      } catch {
        console.error('verifyCurrentPassword: revoke_auth_session threw');
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/**
 * 確認コードのメールを送る。送れなければ throw する。
 *
 * @impl IMPL-AUTH-237
 * @design DD-AUTH-041
 * @remarks 本文はコード・有効期限（10 分）・心当たりが無い時の案内だけ。パスワードは入れない。
 * 呼び手は送れなかった時にコードを無効にして 500 を返す（送れていないコードを有効にしない）。
 */
export async function sendPasswordChangeCodeMail(to: string, code: string): Promise<void> {
  await sendMail({
    to,
    subject: 'パスワード変更の確認コード',
    html: `<p>パスワード変更の確認コードです。</p><p style="font-size:24px;letter-spacing:4px;"><strong>${code}</strong></p><p>有効期限は 10 分です。</p><p>心当たりがない場合は、パスワードを変えずに、すぐにお問い合わせください。</p>`,
    text: `パスワード変更の確認コードです。\n\n${code}\n\n有効期限は 10 分です。\n心当たりがない場合は、パスワードを変えずに、すぐにお問い合わせください。`,
  });
}

/**
 * パスワードを変えたことの通知のメールを送る。
 *
 * @impl IMPL-AUTH-238
 * @design DD-AUTH-041
 * @remarks 本人が気付けるようにする（ASVS V2.2.3）。再設定の確定と同じ文面。パスワードやコードは本文に入れない。
 * GoTrue 側の通知（件名「パスワードの変更を受け付けました」）とは件名を変えて見分ける（ruling 9）。
 */
export async function sendPasswordChangedNotice(to: string): Promise<void> {
  await sendMail({
    to,
    subject: 'パスワードを変更しました',
    html: '<p>アカウントのパスワードが変更されました。</p><p>心当たりがない場合は、ただちにパスワードを再設定のうえお問い合わせください。</p>',
    text: 'アカウントのパスワードが変更されました。心当たりがない場合は、ただちにパスワードを再設定のうえお問い合わせください。',
  });
}
