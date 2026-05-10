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
    const csrfToken = getCsrfTokenFromCookie();
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
