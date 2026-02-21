import { NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { sanitizeRedirectPath } from '@/lib/redirect';
import { logAudit } from '@/lib/audit';
import { IdentifyRequestSchema } from '@/features/auth/schemas/identify';
import { formatZodError } from '@/features/auth/schemas/common';

const DEFAULT_REDIRECT_PATH = '/account';

const isAlreadyExistsError = (message: string) => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('already') ||
    normalized.includes('exists') ||
    normalized.includes('duplicate') ||
    normalized.includes('registered')
  );
};

export async function POST(request: Request) {
  try {
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:identify', limit: 50, windowSeconds: 600 });
      if (rl) return rl;
    } catch (e) {
      console.error('Rate limit middleware error (identify):', e);
    }

    const body = await request.json();
    const parsed = IdentifyRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(formatZodError(parsed.error), { status: 400 });
    }

    const { email, turnstileToken } = parsed.data;
    const redirectPath = sanitizeRedirectPath(parsed.data.redirect_to, DEFAULT_REDIRECT_PATH);

    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rlAccount = await enforceRateLimit({ request, endpoint: 'auth:identify', limit: 10, windowSeconds: 600, subject: email });
      if (rlAccount) return rlAccount;
    } catch (e) {
      console.error('Rate limit middleware error (identify-account):', e);
    }

    const siteKeyConfigured = !!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    if (siteKeyConfigured) {
      const { verifyTurnstile } = await import('@/lib/turnstile');
      const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
      const turnstile = await verifyTurnstile(turnstileToken, ip);
      if (!turnstile.ok) {
        await logAudit({ action: 'auth.identify', actor_email: email, outcome: 'failure', detail: turnstile.error || 'turnstile_failed' });
        return NextResponse.json({ error: 'Bot detection failed' }, { status: 403 });
      }
    }

    let usedCreateUserFallback = false;
    try {
      const serviceRole = await createServiceRoleClient();
      const { error: createError } = await serviceRole.auth.admin.createUser({
        email,
        email_confirm: true,
      });

      if (createError && !isAlreadyExistsError(createError.message || '')) {
        usedCreateUserFallback = true;
        console.warn('Identify JIT createUser failed. Falling back to shouldCreateUser=true.', createError);
      }
    } catch (createUserError) {
      usedCreateUserFallback = true;
      console.warn('Identify JIT createUser unexpected error. Falling back to shouldCreateUser=true.', createUserError);
    }

    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: usedCreateUserFallback,
      },
    });

    if (error) {
      await logAudit({ action: 'auth.identify', actor_email: email, outcome: 'failure', detail: error.message });
      return NextResponse.json({ error: 'メール送信に失敗しました。時間をおいて再度お試しください。' }, { status: 500 });
    }

    await logAudit({
      action: 'auth.identify',
      actor_email: email,
      outcome: 'success',
      detail: usedCreateUserFallback ? 'otp_sent_with_signup_fallback' : 'otp_sent_after_jit_prepare',
    });

    return NextResponse.json(
      { message: '認証コードを送信しました。メールに届いたコードを入力してください。', redirect_to: redirectPath },
      { status: 200 }
    );
  } catch (err) {
    console.error('Identify handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
