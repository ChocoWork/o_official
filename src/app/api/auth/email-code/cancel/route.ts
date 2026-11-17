/**
 * メールのコード入力からの離脱の窓口（src/app/api/auth/email-code/cancel/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-301
 * @design DD-AUTH-059
 * @remarks 副作用は保留の Cookie と戻り先の控えの Cookie の破棄だけ。CSRF は proxy の Origin 検査が /api 配下の POST を既定で覆う。
 * 記録するのは実際に保留を捨てた時だけ（Cookie が無い時に書くと、枠の無いこの口から監査行を水増しできる）。
 */
import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { clearCookieOptions, emailCodeSessionCookieName } from '@/lib/cookie';
import { readEmailCodeSessionFromCookieHeader } from '@/features/auth/services/email-code-session';
import { applyReturnIntentCookie } from '@/features/auth/return-intent/return-intent-service';

export async function POST(request: Request) {
  const pending = readEmailCodeSessionFromCookieHeader(request.headers.get('cookie'));

  const res = new NextResponse(null, { status: 204 });
  res.headers.set('Cache-Control', 'no-store');
  res.cookies.set({ name: emailCodeSessionCookieName, value: '', ...clearCookieOptions() });
  applyReturnIntentCookie(res, { kind: 'clear' });

  if (pending) {
    await logAudit({ action: 'auth.email_code.cancel', actor_email: pending.email, outcome: 'cancelled', detail: 'code_step_abandoned' });
  }
  return res;
}
