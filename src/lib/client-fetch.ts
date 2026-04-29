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

  return decodeURIComponent(match.split('=').slice(1).join('='));
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
