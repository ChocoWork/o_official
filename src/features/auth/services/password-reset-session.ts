import crypto from 'crypto';
import { passwordResetSessionCookieName } from '@/lib/cookie';

const PASSWORD_RESET_SESSION_PURPOSE = 'password_reset';
const PASSWORD_RESET_SESSION_MAX_AGE_SECONDS = 15 * 60;

export type PasswordResetSession = {
  purpose: typeof PASSWORD_RESET_SESSION_PURPOSE;
  userId: string;
  email: string;
  tokenId: string;
  exp: number;
};

function getPasswordResetSessionSecret() {
  const secret = process.env.PASSWORD_RESET_SESSION_SECRET || process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('Password reset session secret is not configured');
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
  return crypto.createHmac('sha256', getPasswordResetSessionSecret()).update(payload).digest('base64url');
}

export function createPasswordResetSessionToken(input: {
  userId: string;
  email: string;
  tokenId: string;
  expiresInSeconds?: number;
}) {
  const exp = Math.floor(Date.now() / 1000) + (input.expiresInSeconds ?? PASSWORD_RESET_SESSION_MAX_AGE_SECONDS);
  const payload = base64UrlEncode(JSON.stringify({
    purpose: PASSWORD_RESET_SESSION_PURPOSE,
    userId: input.userId,
    email: input.email,
    tokenId: input.tokenId,
    exp,
  } satisfies PasswordResetSession));

  return `${payload}.${createSignature(payload)}`;
}

export function verifyPasswordResetSessionToken(token: string | null | undefined): PasswordResetSession | null {
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
    const parsed = JSON.parse(base64UrlDecode(payload)) as Partial<PasswordResetSession>;
    if (
      parsed.purpose !== PASSWORD_RESET_SESSION_PURPOSE ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.email !== 'string' ||
      typeof parsed.tokenId !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }

    if (parsed.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    return parsed as PasswordResetSession;
  } catch {
    return null;
  }
}

export function readPasswordResetSessionFromCookieHeader(cookieHeader: string | null | undefined) {
  if (!cookieHeader) {
    return null;
  }

  const cookieEntry = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${passwordResetSessionCookieName}=`));

  if (!cookieEntry) {
    return null;
  }

  const rawValue = cookieEntry.slice(passwordResetSessionCookieName.length + 1);
  return verifyPasswordResetSessionToken(decodeURIComponent(rawValue));
}

export const passwordResetSessionMaxAgeSeconds = PASSWORD_RESET_SESSION_MAX_AGE_SECONDS;