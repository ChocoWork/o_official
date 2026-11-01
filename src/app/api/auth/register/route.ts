/**
 * 会員登録の窓口（src/app/api/auth/register/route.ts）。公開の登録だけを受ける。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-163
 * @design DD-AUTH-018
 * @remarks 登録済みかどうかに関わらず同じ応答（Set-Cookie の形まで）を返す。控えは戻り先が無くても必ず作り、登録したメールに結ぶ（確認のリンクをこのブラウザで開いた時だけ session を作る。SEC-AUTH-007）。409 を返すと任意のアドレスを投げるだけで会員かどうかを判別でき、会員だけを狙った標的型フィッシングや漏洩した組の絞り込みに使われる（OWASP WSTG-IDNT-04、ASVS 2.1）。登録済みなら本人にメールで伝える。各段の順番と運用上の前提の理由は、その行のコメントに書いた。管理の鍵（x-admin-token・Bearer）で利用者を作る枝は持たない（見出しを付けられても公開の登録として扱う。SEC-AUTH-017）。宛先（メール）単位の枠を Turnstile と漏洩の確かめの後に数え、特定の宛先へ確認のメールを撃ち続けるのを止める（SEC-AUTH-016）。signUp は Supabase の captcha を免除される auth だけの client（サービスの鍵）で呼び、captcha の拒否は重複にも利用者の誤りにも丸めず 5xx と監査に残す（DD-AUTH-040）。照会で見つかった利用者が未確認（確認のリンクの期限切れ）なら、「すでに登録」の通知の代わりに同じ client の auth.resend で確認メールを送り直す。応答は他の枝と同じ 202 のままで、送れなかった時（captcha の拒否を含む）は監査にだけ error を残す（SEC-AUTH-016-AC-04）。
 */
import { NextResponse, after } from 'next/server';
import sendMail from '@/lib/mail';
import { checkPwnedPassword, PWNED_PASSWORD_MESSAGE } from '@/lib/pwned-password';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { createServiceRoleAuthClient, isCaptchaRejection } from '@/lib/auth/service-role-auth-client';
import { getRequestOrigin } from '@/lib/redirect';
import { applyReturnIntentCookie, issueReturnIntent, type ReturnIntentCookieAction } from '@/features/auth/return-intent/return-intent-service';
import { logAudit } from '@/lib/audit';
import { RegisterRequestSchema } from '@/features/auth/schemas/register';
import { formatZodError } from '@/features/auth/schemas/common';
import { isEmailOriginAllowed } from '@/lib/site-url-guard';
import { getClientIp } from '@/lib/request-ip';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { notifySiteUrlInvalid } from '@/lib/ops/site-url-alert';

/**
 * 登録済みかどうかに関わらず同じ応答を返す（アカウント列挙対策）。
 *
 * 409 を返すと、任意のアドレスを投げるだけで会員かどうかを判別できる。
 * 会員だけを狙った標的型フィッシングや、漏洩した メール:パスワード 組の絞り込みに使われる。
 * OWASP WSTG-IDNT-04 / ASVS 2.1 と Supabase 既定の挙動に合わせ、登録済みなら
 * 「既に登録済み」を本人にメールで伝え、HTTP 応答は新規登録時と同一にする。
 */
function acceptedResponse(returnIntentAction: ReturnIntentCookieAction) {
  const res = NextResponse.json({ message: 'Confirmation email sent' }, { status: 202 });
  // 新規・登録済み・重複の例外の 3 つの枝で、本文・状態・Set-Cookie の形まで同じにする。
  applyReturnIntentCookie(res, returnIntentAction);
  return res;
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
    // 送り元 IP の枠。宛先単位の枠は、Turnstile と漏洩の確かめの後に数える（下）。
    const rl = await enforceRateLimit({ request, endpoint: 'auth:register', limit: 20, windowSeconds: 3600 });
    if (rl) return rl;

    const body = await request.json();
    const parsed = RegisterRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(formatZodError(parsed.error), { status: 400 });
    }

    const { email, password, display_name } = parsed.data;

    try {
      // Bot 検証を先に通す。この後ろは重複確認と signUp（＝メール送信）なので、
      // Turnstile が後ろにあるとボットに無償でメール送信を叩かせることになる。
      const { verifyTurnstile } = await import("@/lib/turnstile");
      const ip = getClientIp(request);
      const turnstile = await verifyTurnstile(parsed.data.turnstileToken, ip);
      if (!turnstile.ok) {
        await logAudit({ action: "register", actor_email: email, outcome: "failure", detail: turnstile.error || "turnstile_failed" });
        return NextResponse.json({ error: "Bot detection failed" }, { status: 403 });
      }

      const origin = getRequestOrigin(request);
      if (!isEmailOriginAllowed(origin)) {
        after(() => notifySiteUrlInvalid());
        return NextResponse.json({ error: 'ただいま会員登録を受け付けられません。時間をおいてお試しください。' }, { status: 503 });
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

      // 宛先（メール）単位の枠。Turnstile と漏洩の確かめを通った要求だけを数える（先に数えると、
      // 他人のメールを送るだけでその人の枠を使い切らせられる）。控えの作成と既存会員の照会より前に置く
      // （後ろに置くと、429 の有無で登録済みかどうかが分かる）。
      const rlEmail = await enforceRateLimit({ request, endpoint: 'auth:register', limit: 5, windowSeconds: 3600, subject: email });
      if (rlEmail) return rlEmail;

      // 戻り先の控えは、Turnstile・漏洩の確かめの後で、既存会員の照会の前に作る。戻り先が無くても必ず作り、
      // 登録したメールに結ぶ（確認のリンクを登録を始めたブラウザで開いた時だけ session を作る。SEC-AUTH-007）。
      // 照会の後に置くと、枝ごとに Cookie の有無が変わり、登録済みかどうかが応答から分かってしまう。
      // 作成に失敗しても応答の形は変えない（issueReturnIntent は失敗を clear に倒す）。
      const { action: returnIntentAction } = await issueReturnIntent({
        rawNext: parsed.data.next,
        purpose: 'signup',
        bindTo: email,
        alwaysCreate: true,
      });

      // 既存ユーザーの確認。以前は listUsers({ perPage: 100 }) で先頭 100 件だけを
      // 走査していたため、101 人目以降の重複メールを検出できなかった。
      const service = await createServiceRoleClient();
      const { findAuthUserIdByEmail, isAuthUserUnconfirmed } = await import("@/features/auth/services/auth-admin-user");
      const lookup = await findAuthUserIdByEmail(service, email);

      // 確認のリンクに戻り先は載せない（番号は Cookie だけで渡す）。
      const confirmUrl = new URL('/api/auth/confirm', origin);

      // 引けなかったときに signUp へ進むと、重複チェックが無言で消える。
      // 「重複していない」と断定できないので、ここで止める。
      if (lookup.status === "error") {
        await logAudit({ action: "register", actor_email: email, outcome: "error", detail: "user_lookup_failed" });
        return NextResponse.json({ error: "Service temporarily unavailable" }, { status: 503 });
      }

      if (lookup.status === "found") {
        // 確認のリンク（有効期限 5 分）を開かないまま切れた未確認の会員は、ここで確認メールを送り直す。
        // 「すでに登録されています」と案内しても、未確認ではログインできず、確認のリンクも切れていて、自分で抜け出せない。
        // 応答・Set-Cookie は他の枝と同じ 202（送れなかった時も変えない。存在や確認の有無を明かさない）。
        // 送り直すのは宛先の枠（上）を通った要求だけ。確かめられない時は従来の既存会員の扱いに倒す。
        if (await isAuthUserUnconfirmed(service, lookup.userId)) {
          try {
            // 新規の signUp と同じく、captcha を免除される auth だけの client で呼ぶ。
            const resendClient = await createServiceRoleAuthClient();
            const { error: resendError } = await resendClient.auth.resend({
              type: 'signup',
              email,
              options: { emailRedirectTo: confirmUrl.toString() },
            });
            if (isCaptchaRejection(resendError)) {
              // 全員の確認メールが止まる故障を隠さない。誤りの本文は残さない。応答は変えない。
              console.error('Unconfirmed resend rejected by captcha');
              await logAudit({ action: 'register', actor_email: email, outcome: 'error', detail: 'supabase_captcha_rejected' });
            } else if (resendError) {
              console.error('Unconfirmed resend error:', resendError);
              await logAudit({ action: 'register', actor_email: email, outcome: 'error', detail: `unconfirmed_resend_failed: ${resendError.message}` });
            } else {
              await logAudit({ action: 'register', actor_email: email, outcome: 'conflict', detail: 'unconfirmed_resent' });
            }
          } catch (resendThrown) {
            console.error('Unconfirmed resend threw:', resendThrown instanceof Error ? resendThrown.name : 'unknown');
            await logAudit({ action: 'register', actor_email: email, outcome: 'error', detail: 'unconfirmed_resend_threw' });
          }
          return acceptedResponse(returnIntentAction);
        }

        // 応答は新規登録時と同一。存在は本人へのメールだけで伝える。
        await logAudit({ action: "register", actor_email: email, outcome: "conflict", detail: "already_registered_notified" });
        notifyAlreadyRegistered(email, new URL('/login', origin).toString());
        return acceptedResponse(returnIntentAction);
      }

      // Supabase の captcha を免除される auth だけの client で呼ぶ（アプリの Turnstile は上で検証済みで、トークンは転送できない）。
      const client = await createServiceRoleAuthClient();

      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: {
          data: display_name ? { display_name } : undefined,
          emailRedirectTo: confirmUrl.toString(),
        },
      });

      if (isCaptchaRejection(error)) {
        // captcha の拒否を重複や利用者の誤りに丸めない（全員が登録できない故障を隠さない）。誤りの本文は残さない。
        console.error('Public signUp rejected by captcha');
        await logAudit({ action: 'register', actor_email: email, outcome: 'error', detail: 'supabase_captcha_rejected' });
        return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
      }

      if (error) {
        console.error('Public signUp error:', error);
        const msg = String(error.message || '').toLowerCase();
        if (msg.includes('already') || msg.includes('duplicate')) {
          // ここに来るのは find_auth_user_id_by_email の除外条件（SSO / banned /
          // 論理削除）に当たったアドレス。上の found と同じ応答に揃える。
          await logAudit({ action: 'register', actor_email: email, outcome: 'conflict', detail: error.message });
          notifyAlreadyRegistered(email, new URL('/login', origin).toString());
          return acceptedResponse(returnIntentAction);
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

        const res = NextResponse.json({ user: { id: data.user.id, email: data.user.email } }, { status: 201 });
        try {
          const { persistSessionAndCookies } = await import('@/features/auth/services/register');
          // ゲストのカートとお気に入りの印を、ログインの保存の後で会員の分へ合わせるために渡す。
          const { readGuestShoppingTokens } = await import('@/features/cart/services/guest-shopping-token');
          const result = await persistSessionAndCookies(res, data.session, data.user, readGuestShoppingTokens(request.headers.get('cookie')));
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

        // 即ログインの枝では確認のリンクを通らないので、控えを使う所が無い。残さないよう消す。
        applyReturnIntentCookie(res, { kind: 'clear' });
        await logAudit({ action: 'register', actor_email: email, outcome: 'success', resource_id: data.user?.id });
        return res;
      }

      // If no session (email confirmation flows), return Accepted
      await logAudit({ action: 'register', actor_email: email, outcome: 'created_needs_confirmation' });
      return acceptedResponse(returnIntentAction);
    } catch (e) {
      console.error('Public register flow error:', e);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  } catch (err) {
    console.error('Register handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
