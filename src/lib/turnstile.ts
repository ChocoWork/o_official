type TurnstileVerifyResult = {
  ok: boolean;
  error?: string;
  skipped?: boolean;
};

export async function verifyTurnstile(token: string | undefined, ip?: string | null): Promise<TurnstileVerifyResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, error: 'turnstile_not_configured' };
    }
    return { ok: true, skipped: true };
  }

  if (!token) {
    return { ok: false, error: 'missing_turnstile_token' };
  }

  try {
    const params = new URLSearchParams();
    params.set('secret', secret);
    params.set('response', token);
    if (ip) params.set('remoteip', ip);

    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!resp.ok) {
      return { ok: false, error: 'turnstile_verify_failed' };
    }

    const data = (await resp.json()) as { success?: boolean; ['error-codes']?: string[] };
    if (!data.success) {
      return { ok: false, error: (data['error-codes'] || []).join(',') || 'turnstile_invalid' };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
