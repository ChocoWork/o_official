import { NextResponse, after } from 'next/server';
import crypto from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import sendMail from '@/lib/mail';
import { logAudit } from '@/lib/audit';
import { ResetRequestSchema } from '@/features/auth/schemas/password-reset';
import { formatZodError } from '@/features/auth/schemas/common';
import { getRequestOrigin } from '@/lib/redirect';

// PUBLIC: パスワードを忘れた利用者の入口なので認証は掛けられない。
// 濫用対策はレート制限と、登録有無で応答を変えないこと（OWASP Forgot Password CS）。

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function POST(request: Request) {
  try {
    // Enforce IP-level rate limit for password reset requests
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:password_reset_request', limit: 10, windowSeconds: 3600 });
      if (rl) return rl;
    } catch (e) {
      console.error('Rate limit middleware error (password-reset):', e);
    }
    const body = await request.json();
    const parsed = ResetRequestSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });

    // emailSchema が trim + lowercase 済み
    const { email, turnstileToken } = parsed.data;

    const { verifyTurnstile } = await import('@/lib/turnstile');
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    const turnstile = await verifyTurnstile(turnstileToken, ip);
    if (!turnstile.ok) {
      await logAudit({ action: 'password_reset_request', actor_email: email, outcome: 'failure', detail: turnstile.error || 'turnstile_failed' });
      return NextResponse.json({ error: 'Bot detection failed' }, { status: 403 });
    }

    // Account-based rate limit (by email) to prevent email enumeration/abuse
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rlAccount = await enforceRateLimit({ request, endpoint: 'auth:password_reset_request', limit: 5, windowSeconds: 3600, subject: email });
      if (rlAccount) return rlAccount;
    } catch (e) {
      console.error('Rate limit middleware error (password-reset-account):', e);
    }
    const supabase = await createServiceRoleClient();

    // Resolve user from Supabase Auth admin API to avoid public.users dependency.
    const { findAuthUserIdByEmail } = await import('@/features/auth/services/auth-admin-user');
    const lookup = await findAuthUserIdByEmail(supabase, email);

    // 引けなかったときは「アカウント無し」に丸めない。丸めると再設定が全滅しても
    // 200 と outcome:'success' が並ぶだけで、障害が監視に上がらない。
    if (lookup.status === 'error') {
      await logAudit({ action: 'password_reset_request', actor_email: email, outcome: 'error', detail: 'user_lookup_failed' });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    const userId = lookup.status === 'found' ? lookup.userId : null;

    // アカウントが無いときはトークンも作らずメールも送らない。
    // 以前は userId が null でも送っていたため、任意の第三者アドレスを投げるだけで
    // 当社ドメインから無差別にメールを出せる状態だった（メールリレー悪用）。
    // 列挙対策は「存在有無に関わらず同じ 200 を返す」ことで担保する。
    let detail = 'no_account';

    if (userId) {
      // 新しいトークンを出す前に、同じ宛先の未使用トークンを潰す。
      // 有効なリセットリンクは常に最新の1本だけにする。
      const { error: invalidateError } = await supabase
        .from('password_reset_tokens')
        .update({ used: true })
        .eq('email', email)
        .eq('used', false);

      if (invalidateError) {
        console.error('Failed to invalidate previous password reset tokens:', invalidateError);
      }

      // Generate secure token and store its hash
      const token = crypto.randomBytes(32).toString('hex');
      const { tokenHashSha256 } = await import('@/lib/hash');
      const tokenHash = await tokenHashSha256(token);
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

      const { error: insertError } = await supabase.from('password_reset_tokens').insert([
        {
          user_id: userId,
          email,
          token_hash: tokenHash,
          expires_at: expiresAt,
          used: false,
        },
      ]);

      if (insertError) {
        // トークンを保存できていないのにメールを送ると、踏んでも通らないリンクを渡すことになる。
        console.error('Failed to persist password reset token:', insertError);
        await logAudit({ action: 'password_reset_request', actor_email: email, outcome: 'error', detail: 'token_persist_failed' });
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
      }

      // メールのリンク先は副作用のない確認ページ。そこのボタン（POST）で初めて
      // トークンを消費する。GET で消費すると、企業メールのリンクスキャナが
      // 先に踏んでトークンを潰してしまい、利用者が再設定できなくなる。
      const resetUrl = new URL('/auth/password-reset/verify', getRequestOrigin(request));
      resetUrl.searchParams.set('token', token);

      // SMTP の往復を応答経路から外す（レスポンスを待たせない）。
      after(async () => {
        try {
          await sendMail({
            to: email,
            subject: 'Password reset',
            html: `<p>Click to reset your password: <a href="${resetUrl.toString()}">Reset password</a></p>`,
            text: `Reset your password: ${resetUrl.toString()}`,
          });
        } catch (mailErr) {
          console.warn('Failed to send password reset mail:', mailErr);
        }
      });

      detail = 'mail_queued';
    }

    // 監査ログには結果を残すが、レスポンスには出さない。
    await logAudit({ action: 'password_reset_request', actor_email: email, outcome: 'success', resource_id: userId, detail });

    // Respond 200 even if email not found to avoid enumeration
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error('Password reset request error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
