// Cookie helpers (draft)
// Provides helper functions to build cookie options used across auth routes.

export const refreshCookieName = 'sb-refresh-token';
export const accessCookieName = 'sb-access-token';
export const csrfCookieName = 'sb-csrf-token';

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

export function clearCookieOptions() {
  return {
    ...getBaseCookieOptions(),
    maxAge: 0,
  };
}

export default {
  refreshCookieName,
  accessCookieName,
  csrfCookieName,
  cookieOptionsForRefresh,
  cookieOptionsForAccess,
  cookieOptionsForCsrf,
  clearCookieOptions,
};
