import crypto from 'crypto';
import { emailCodeSessionCookieName } from '@/lib/cookie';

/**
 * メールのコードのログイン・新規の保留の Cookie の署名と読み取り（src/features/auth/services/email-code-session.ts）。
 *
 * @packageDocumentation
 * @remarks 旧の保留の Cookie（login-2fa-session.ts）の写し。違いは2つ。
 * (1) `userId` を持たない（メールだけ。登録済みかどうかを Cookie から読ませない）。
 * (2) 乱数の `jti` を持つ。確定の総当たりの枠を Cookie ごとに数えるため（`email + ':' + jti`）。再送では引き継ぐ。
 * `purpose` の値が旧と違うので、旧い Cookie の値を新しい窓口へ渡しても、その逆も `null` になる。
 */
const EMAIL_CODE_SESSION_PURPOSE = 'email_code';
// Supabase の Email OTP Expiration（現行 300 秒）と一致させる。
const EMAIL_CODE_SESSION_MAX_AGE_SECONDS = 5 * 60;
// 絶対上限。exp は再送のたびに延びるので、これが無いと再送を繰り返す限り保留を無期限に保てる（ASVS V3.3.2）。
const EMAIL_CODE_SESSION_ABSOLUTE_MAX_AGE_SECONDS = 30 * 60;

export type EmailCodeSession = {
  purpose: typeof EMAIL_CODE_SESSION_PURPOSE;
  email: string;
  /** 確定の枠を Cookie ごとに数えるための乱数。再送で引き継ぐ。 */
  jti: string;
  /** 最初にコードを送った時刻。再発行しても引き継ぐ。 */
  iat: number;
  exp: number;
};

function getSecret() {
  const secret = process.env.LOGIN_2FA_SESSION_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('Login 2FA session secret is not configured');
  }
  return secret;
}

function createSignature(payload: string) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

/**
 * 保留の Cookie の値を署名して作る。
 *
 * @impl IMPL-AUTH-295
 * @design DD-AUTH-059
 */
export function createEmailCodeSessionToken(input: {
  email: string;
  expiresInSeconds?: number;
  /** 再発行時は元の iat を渡すこと（渡さないと絶対上限の起点がリセットされる）。 */
  issuedAt?: number;
  /** 再発行時は元の jti を渡すこと（渡さないと確定の枠が新しくなり総当たりできる）。 */
  jti?: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      purpose: EMAIL_CODE_SESSION_PURPOSE,
      email: input.email,
      jti: input.jti ?? crypto.randomBytes(16).toString('base64url'),
      iat: input.issuedAt ?? now,
      exp: now + (input.expiresInSeconds ?? EMAIL_CODE_SESSION_MAX_AGE_SECONDS),
    } satisfies EmailCodeSession),
    'utf8',
  ).toString('base64url');

  return `${payload}.${createSignature(payload)}`;
}

/**
 * 保留の Cookie の値を確かめる。署名・目的・期限・絶対の上限のどれかが合わなければ null。
 *
 * @impl IMPL-AUTH-296
 * @design DD-AUTH-059
 */
export function verifyEmailCodeSessionToken(token: string | null | undefined): EmailCodeSession | null {
  if (!token) return null;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = Buffer.from(createSignature(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<EmailCodeSession>;
    if (
      parsed.purpose !== EMAIL_CODE_SESSION_PURPOSE ||
      typeof parsed.email !== 'string' ||
      typeof parsed.jti !== 'string' ||
      parsed.jti.length === 0 ||
      typeof parsed.iat !== 'number' ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (parsed.exp <= now) return null;
    if (now - parsed.iat > EMAIL_CODE_SESSION_ABSOLUTE_MAX_AGE_SECONDS) return null;

    return parsed as EmailCodeSession;
  } catch {
    return null;
  }
}

/**
 * Cookie の見出しから保留の Cookie を読んで確かめる。
 *
 * @impl IMPL-AUTH-297
 * @design DD-AUTH-059
 */
export function readEmailCodeSessionFromCookieHeader(cookieHeader: string | null | undefined) {
  if (!cookieHeader) return null;

  const entry = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${emailCodeSessionCookieName}=`));
  if (!entry) return null;

  return verifyEmailCodeSessionToken(decodeURIComponent(entry.slice(emailCodeSessionCookieName.length + 1)));
}

export const emailCodeSessionMaxAgeSeconds = EMAIL_CODE_SESSION_MAX_AGE_SECONDS;
export const emailCodeSessionAbsoluteMaxAgeSeconds = EMAIL_CODE_SESSION_ABSOLUTE_MAX_AGE_SECONDS;
