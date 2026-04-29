// Cookie helpers (draft)
// Provides helper functions to build cookie options used across auth routes.

export const refreshCookieName = 'sb-refresh-token';
export const accessCookieName = 'sb-access-token';
export const csrfCookieName = 'sb-csrf-token';
export const passwordResetSessionCookieName = 'sb-password-reset-session';
export const sessionCookieName = 'session_id';

const SESSION_ID_BYTES = 16;

export function getBaseCookieOptions() {
  // Note: `secure` should be true in production (HTTPS)
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    // maxAge left to callers
  };
}

export function cookieOptionsForRefresh(maxAgeSeconds: number) {
  return {
    ...getBaseCookieOptions(),
    maxAge: maxAgeSeconds,
    // refresh cookie must be httpOnly and accessible only on same site
    httpOnly: true,
    sameSite: 'lax' as const,
  };
}

export function cookieOptionsForAccess(maxAgeSeconds: number) {
  return {
    ...getBaseCookieOptions(),
    maxAge: maxAgeSeconds,
    httpOnly: true,
    sameSite: 'lax' as const,
  };
}

export function cookieOptionsForCsrf(maxAgeSeconds: number) {
  return {
    ...getBaseCookieOptions(),
    maxAge: maxAgeSeconds,
    httpOnly: false, // CSRF cookie must be readable by client for double-submit
    // Align with spec: use SameSite=Lax for CSRF cookie to allow top-level navigation
    sameSite: 'lax' as const,
  };
}

export function cookieOptionsForSession(maxAgeSeconds: number) {
  return {
    ...getBaseCookieOptions(),
    maxAge: maxAgeSeconds,
    httpOnly: true,
    sameSite: 'lax' as const,
  };
}

export function generateSessionId() {
  const bytes = new Uint8Array(SESSION_ID_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function cookieOptionsForPasswordReset(maxAgeSeconds: number) {
  return {
    ...getBaseCookieOptions(),
    maxAge: maxAgeSeconds,
    httpOnly: true,
    sameSite: 'strict' as const,
  };
}

export function clearCookieOptions() {
  return {
    ...getBaseCookieOptions(),
    maxAge: 0,
  };
}

const cookieHelper = {
  refreshCookieName,
  accessCookieName,
  csrfCookieName,
  passwordResetSessionCookieName,
  sessionCookieName,
  cookieOptionsForRefresh,
  cookieOptionsForAccess,
  cookieOptionsForCsrf,
  cookieOptionsForSession,
  cookieOptionsForPasswordReset,
  generateSessionId,
  clearCookieOptions,
};

export default cookieHelper;
