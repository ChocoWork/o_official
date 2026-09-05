import crypto from 'crypto';
import { loginTwoFactorSessionCookieName } from '@/lib/cookie';

const LOGIN_2FA_SESSION_PURPOSE = 'login_2fa';
// Supabase の Email OTP Expiration（現行 300 秒）と一致させる。
// Cookie だけが長いと、コードが切れているのに入力画面が生きている窓ができ、
// 利用者からは「入れても無効」にしか見えない。
const LOGIN_2FA_SESSION_MAX_AGE_SECONDS = 5 * 60;

// 保留中セッションの絶対上限。exp は再送のたびに延びる（スライドする）ので、
// これが無いと再送を繰り返す限り「パスワード検証済み」状態を無期限に保てる。
// OWASP ASVS v4.0.3 V3.3.2 が求める絶対タイムアウトを認証前段にも適用する。
// 30 分は「TTL 5 分 + 再送クールダウン 60 秒」で約 5 回の再送を許す値で、
// アカウント単位の送信枠（5 回 / 600 秒）と釣り合う。
const LOGIN_2FA_SESSION_ABSOLUTE_MAX_AGE_SECONDS = 30 * 60;

export type LoginTwoFactorSession = {
  purpose: typeof LOGIN_2FA_SESSION_PURPOSE;
  userId: string;
  email: string;
  /** 最初にパスワード検証を通った時刻。再発行しても引き継ぐ。 */
  iat: number;
  exp: number;
};

function getLoginTwoFactorSessionSecret() {
  const secret = process.env.LOGIN_2FA_SESSION_SECRET || process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('Login 2FA session secret is not configured');
  }

  return secret;
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function createSignature(payload: string) {
  return crypto.createHmac('sha256', getLoginTwoFactorSessionSecret()).update(payload).digest('base64url');
}

export function createLoginTwoFactorSessionToken(input: {
  userId: string;
  email: string;
  expiresInSeconds?: number;
  /**
   * 再発行時は元の iat を渡すこと。渡さないと絶対上限の起点がリセットされ、
   * 再送を繰り返す限り保留状態を延ばせてしまう。
   */
  issuedAt?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  const iat = input.issuedAt ?? now;
  const exp = now + (input.expiresInSeconds ?? LOGIN_2FA_SESSION_MAX_AGE_SECONDS);
  const payload = base64UrlEncode(JSON.stringify({
    purpose: LOGIN_2FA_SESSION_PURPOSE,
    userId: input.userId,
    email: input.email,
    iat,
    exp,
  } satisfies LoginTwoFactorSession));

  return `${payload}.${createSignature(payload)}`;
}

export function verifyLoginTwoFactorSessionToken(token: string | null | undefined): LoginTwoFactorSession | null {
  if (!token) {
    return null;
  }

  const [payload, signature] = token.split('.');
  if (!payload || !signature) {
    return null;
  }

  const expectedSignature = createSignature(payload);
  const expectedBuffer = Buffer.from(expectedSignature);
  const actualBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== actualBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as Partial<LoginTwoFactorSession>;
    if (
      parsed.purpose !== LOGIN_2FA_SESSION_PURPOSE ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.email !== 'string' ||
      typeof parsed.iat !== 'number' ||
      typeof parsed.exp !== 'number'
    ) {
      // iat を持たない旧形式のトークンもここで落ちる。互換は切る判断。
      // 影響は「デプロイ時点でパスワード送信済み・OTP 未入力」の人だけで、
      // TTL 5 分ぶんの窓に限られ、やり直しで完全復帰できる。
      return null;
    }

    const now = Math.floor(Date.now() / 1000);

    if (parsed.exp <= now) {
      return null;
    }

    // 絶対上限。exp は再送で延びるので、これが最終的な打ち切りになる。
    if (now - parsed.iat > LOGIN_2FA_SESSION_ABSOLUTE_MAX_AGE_SECONDS) {
      return null;
    }

    return parsed as LoginTwoFactorSession;
  } catch {
    return null;
  }
}

export function readLoginTwoFactorSessionFromCookieHeader(cookieHeader: string | null | undefined) {
  if (!cookieHeader) {
    return null;
  }

  const cookieEntry = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${loginTwoFactorSessionCookieName}=`));

  if (!cookieEntry) {
    return null;
  }

  const rawValue = cookieEntry.slice(loginTwoFactorSessionCookieName.length + 1);
  return verifyLoginTwoFactorSessionToken(decodeURIComponent(rawValue));
}

export const loginTwoFactorSessionMaxAgeSeconds = LOGIN_2FA_SESSION_MAX_AGE_SECONDS;
export const loginTwoFactorSessionAbsoluteMaxAgeSeconds = LOGIN_2FA_SESSION_ABSOLUTE_MAX_AGE_SECONDS;
