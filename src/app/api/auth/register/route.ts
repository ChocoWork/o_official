import { NextResponse, after } from 'next/server';
import sendMail from '@/lib/mail';
import { checkPwnedPassword, PWNED_PASSWORD_MESSAGE } from '@/lib/pwned-password';
import { createServiceRoleClient, createClient } from '@/lib/supabase/server';
import { getRequestOrigin, sanitizeRedirectPath } from '@/lib/redirect';
import { logAudit } from '@/lib/audit';
import { RegisterRequestSchema } from '@/features/auth/schemas/register';
import { formatZodError } from '@/features/auth/schemas/common';

/**
 * 登録済みかどうかに関わらず同じ応答を返す（アカウント列挙対策）。
 *
 * 409 を返すと、任意のアドレスを投げるだけで会員かどうかを判別できる。
 * 会員だけを狙った標的型フィッシングや、漏洩した メール:パスワード 組の絞り込みに使われる。
 * OWASP WSTG-IDNT-04 / ASVS 2.1 と Supabase 既定の挙動に合わせ、登録済みなら
 * 「既に登録済み」を本人にメールで伝え、HTTP 応答は新規登録時と同一にする。
 */
function acceptedResponse() {
  return NextResponse.json({ message: 'Confirmation email sent' }, { status: 202 });
}

/** 既に登録済みのアドレスへ、ログイン導線を案内する。パスワードには触れない。 */
function notifyAlreadyRegistered(email: string, loginUrl: string) {
  // 応答経路から SMTP の往復を外す。送信の有無で応答時間に差が出ないようにする。
  after(async () => {
    try {
      await sendMail({
        to: email,
        subject: 'アカウントはすでに登録されています',
        html: `<p>このメールアドレスはすでに登録されています。</p><p><a href="${loginUrl}">ログイン</a>してください。パスワードが分からない場合は、ログイン画面から再設定できます。</p><p>心当たりがない場合は、このメールを破棄してください。</p>`,
        text: `このメールアドレスはすでに登録されています。\nログイン: ${loginUrl}\nパスワードが分からない場合は、ログイン画面から再設定できます。\n心当たりがない場合は、このメールを破棄してください。`,
      });
    } catch (mailErr) {
      console.warn('Failed to send already-registered notice:', mailErr);
    }
  });
}


export async function POST(request: Request) {
  try {
    // Enforce rate limit for admin register calls
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:register', limit: 20, windowSeconds: 3600 });
      if (rl) return rl;
    } catch (e) {
      console.error('Rate limit middleware error (register):', e);
    }

    // 管理者用ヘッダが渡されている場合のみ管理者チェックを行う。
    // ADMIN_API_KEY が未設定でも、ヘッダ無しのリクエストはパブリックサインアップとして処理する。
    const adminApiKey = process.env.ADMIN_API_KEY;
    const provided = request.headers.get('x-admin-token') || request.headers.get('authorization')?.replace(/^Bearer\s+/, '');

    // If the client provided an admin token, validate it against server config.
    if (provided) {
      if (!adminApiKey) {
        console.error('ADMIN_API_KEY is not configured but admin token provided');
        return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
      }
      if (provided !== adminApiKey) {
        await logAudit({ action: 'register', actor_email: null, outcome: 'unauthorized', detail: 'Missing or invalid admin token' });
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const body = await request.json();
    const parsed = RegisterRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(formatZodError(parsed.error), { status: 400 });
    }

    const { email, password, display_name } = parsed.data;
    const redirectPath = sanitizeRedirectPath(parsed.data.redirect_to ?? parsed.data.emailRedirectTo, '/auth/verified');

    // If admin token provided, use existing admin-create path (already implemented)
    if (provided && provided === adminApiKey) {
      const supabase = await createServiceRoleClient();
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        user_metadata: { display_name },
      });

      if (error) {
        console.error('Supabase createUser error:', error);
        const msg = String(error.message || '').toLowerCase();
        if (msg.includes('already') || msg.includes('duplicate')) {
          await logAudit({ action: 'register', actor_email: email, outcome: 'conflict', detail: error.message });
          return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
        }

        await logAudit({ action: 'register', actor_email: email, outcome: 'error', detail: error.message });
        return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
      }

      await logAudit({ action: 'register', actor_email: email, outcome: 'success', resource_id: data.user?.id });
      return NextResponse.json({ id: data.user?.id, email: data.user?.email }, { status: 201 });
    }

    // Public signup flow
    try {
      // Bot 検証を先に通す。この後ろは重複確認と signUp（＝メール送信）なので、
      // Turnstile が後ろにあるとボットに無償でメール送信を叩かせることになる。
      const { verifyTurnstile } = await import("@/lib/turnstile");
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
      const turnstile = await verifyTurnstile(parsed.data.turnstileToken, ip);
      if (!turnstile.ok) {
        await logAudit({ action: "register", actor_email: email, outcome: "failure", detail: turnstile.error || "turnstile_failed" });
        return NextResponse.json({ error: "Bot detection failed" }, { status: 403 });
      }

      // 漏洩済みパスワードを弾く。Supabase の leaked password protection は
      // Pro プラン以上でしか使えないため、同等の制御をここに置く（FREQ-323）。
      const pwned = await checkPwnedPassword(password);
      if (pwned.status === 'pwned') {
        await logAudit({ action: "register", actor_email: email, outcome: "failure", detail: "pwned_password" });
        return NextResponse.json({ error: PWNED_PASSWORD_MESSAGE }, { status: 400 });
      }
      if (pwned.status === 'unavailable') {
        // 外部サービスの障害で登録を止めない。検査が効いていない期間を追えるよう監査に残す。
        await logAudit({ action: "register", actor_email: email, outcome: "error", detail: `pwned_check_unavailable:${pwned.reason}` });
      }

      // 既存ユーザーの確認。以前は listUsers({ perPage: 100 }) で先頭 100 件だけを
      // 走査していたため、101 人目以降の重複メールを検出できなかった。
      const service = await createServiceRoleClient();
      const { findAuthUserIdByEmail } = await import("@/features/auth/services/auth-admin-user");
      const lookup = await findAuthUserIdByEmail(service, email);

      // 引けなかったときに signUp へ進むと、重複チェックが無言で消える。
      // 「重複していない」と断定できないので、ここで止める。
      if (lookup.status === "error") {
        await logAudit({ action: "register", actor_email: email, outcome: "error", detail: "user_lookup_failed" });
        return NextResponse.json({ error: "Service temporarily unavailable" }, { status: 503 });
      }

      if (lookup.status === "found") {
        // 応答は新規登録時と同一。存在は本人へのメールだけで伝える。
        await logAudit({ action: "register", actor_email: email, outcome: "conflict", detail: "already_registered_notified" });
        notifyAlreadyRegistered(email, new URL('/login', getRequestOrigin(request)).toString());
        return acceptedResponse();
      }

      const client = await createClient();
      const origin = getRequestOrigin(request);
      const confirmUrl = new URL('/api/auth/confirm', origin);
      confirmUrl.searchParams.set('redirect_to', redirectPath);

      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: {
          data: display_name ? { display_name } : undefined,
          emailRedirectTo: confirmUrl.toString(),
        },
      });

      if (error) {
        console.error('Public signUp error:', error);
        const msg = String(error.message || '').toLowerCase();
        if (msg.includes('already') || msg.includes('duplicate')) {
          // ここに来るのは find_auth_user_id_by_email の除外条件（SSO / banned /
          // 論理削除）に当たったアドレス。上の found と同じ応答に揃える。
          await logAudit({ action: 'register', actor_email: email, outcome: 'conflict', detail: error.message });
          notifyAlreadyRegistered(email, new URL('/login', getRequestOrigin(request)).toString());
          return acceptedResponse();
        }
        await logAudit({ action: 'register', actor_email: email, outcome: 'error', detail: error.message });
        return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
      }

      // If signup returned a session (auto signed-in), persist session and set cookies
      // 注: この 201 分岐は Supabase 側の Confirm email が OFF のときだけ通る。
      // OFF にすると新規は 201、既存は 202 となり応答で判別できてしまうため、
      // 列挙対策を保つには Confirm email を ON のまま運用すること。
      if (data.session) {
        if (!data.user) {
          await logAudit({ action: 'register', actor_email: email, outcome: 'error', detail: 'missing_user_after_signup' });
          return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
        }

        const res = NextResponse.json({ access_token: data.session.access_token, user: data.user }, { status: 201 });
        try {
          const { persistSessionAndCookies } = await import('@/features/auth/services/register');
          const result = await persistSessionAndCookies(res, data.session, data.user);
          if (!result?.ok) {
            console.error('persistSessionAndCookies failed:', result.error);
            // Clear cookies to avoid inconsistent client state
            try {
              const {
                refreshCookieName,
                accessCookieName,
                cookieOptionsForRefresh,
                cookieOptionsForAccess,
                csrfCookieName,
                cookieOptionsForCsrf,
              } = await import('@/lib/cookie');
              res.cookies.set({ name: accessCookieName, value: '', ...cookieOptionsForAccess(0) });
              res.cookies.set({ name: refreshCookieName, value: '', ...cookieOptionsForRefresh(0) });
              res.cookies.set({ name: csrfCookieName, value: '', ...cookieOptionsForCsrf(0) });
            } catch (clearErr) {
              console.error('Failed to clear cookies after persistence failure:', clearErr);
            }
            await logAudit({ action: 'register', actor_email: email, outcome: 'error', detail: `session_persist_failed: ${result.error}`, resource_id: data.user?.id });
            return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
          }
        } catch (e) {
          console.error('Failed to persist session after signUp:', e);
          try {
            const {
              refreshCookieName,
              accessCookieName,
              cookieOptionsForRefresh,
              cookieOptionsForAccess,
              csrfCookieName,
              cookieOptionsForCsrf,
            } = await import('@/lib/cookie');
            res.cookies.set({ name: accessCookieName, value: '', ...cookieOptionsForAccess(0) });
            res.cookies.set({ name: refreshCookieName, value: '', ...cookieOptionsForRefresh(0) });
            res.cookies.set({ name: csrfCookieName, value: '', ...cookieOptionsForCsrf(0) });
          } catch (clearErr) {
            console.error('Failed to clear cookies after persistence unexpected error:', clearErr);
          }
          await logAudit({ action: 'register', actor_email: email, outcome: 'error', detail: String(e), resource_id: data.user?.id });
          return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
        }

        await logAudit({ action: 'register', actor_email: email, outcome: 'success', resource_id: data.user?.id });
        return res;
      }

      // If no session (email confirmation flows), return Accepted
      await logAudit({ action: 'register', actor_email: email, outcome: 'created_needs_confirmation' });
      return acceptedResponse();
    } catch (e) {
      console.error('Public register flow error:', e);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  } catch (err) {
    console.error('Register handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
