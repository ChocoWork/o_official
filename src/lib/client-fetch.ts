/**
 * Browser-side fetch wrapper that relies on cookie-based authentication.
 * API routes should use same-site cookies instead of client-stored tokens.
 */
function getCsrfTokenFromCookie(): string | undefined {
  if (typeof document === 'undefined') {
    return undefined;
  }

  const match = document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith('sb-csrf-token='));

  if (!match) {
    return undefined;
  }

  // Keep the transport value header-safe. Legacy cookies may be percent-encoded
  // and are decoded on the server before hash comparison.
  return match.split('=').slice(1).join('=');
}

export async function clientFetch(
  endpoint: string,
  options?: RequestInit
): Promise<Response> {
  const headers = new Headers(options?.headers || {});
  const method = (options?.method ?? 'GET').toUpperCase();
  const needsCsrfToken = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  if (needsCsrfToken && !headers.has('x-csrf-token')) {
    let csrfToken = getCsrfTokenFromCookie();

    // A previous CSRF rotation may have left an authenticated browser without
    // the readable CSRF cookie. Refresh the session once to issue a matching
    // cookie/hash pair before sending the state-changing request.
    if (!csrfToken && endpoint !== '/api/auth/refresh') {
      const refreshResponse = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
      });

      if (refreshResponse.ok) {
        csrfToken = getCsrfTokenFromCookie();
      }
    }

    if (csrfToken) {
      headers.set('x-csrf-token', csrfToken);
    }
  }

  return fetch(endpoint, {
    ...options,
    method,
    headers,
    credentials: 'same-origin',
  });
}
