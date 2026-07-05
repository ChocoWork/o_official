import crypto from 'crypto';
import { loginTwoFactorSessionCookieName } from '@/lib/cookie';

const LOGIN_2FA_SESSION_PURPOSE = 'login_2fa';
const LOGIN_2FA_SESSION_MAX_AGE_SECONDS = 10 * 60;

export type LoginTwoFactorSession = {
  purpose: typeof LOGIN_2FA_SESSION_PURPOSE;
  userId: string;
  email: string;
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
}) {
  const exp = Math.floor(Date.now() / 1000) + (input.expiresInSeconds ?? LOGIN_2FA_SESSION_MAX_AGE_SECONDS);
  const payload = base64UrlEncode(JSON.stringify({
    purpose: LOGIN_2FA_SESSION_PURPOSE,
    userId: input.userId,
    email: input.email,
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
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }

    if (parsed.exp <= Math.floor(Date.now() / 1000)) {
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
