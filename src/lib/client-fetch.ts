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

const NETWORK_RETRY_DELAY_MS = 250;
let refreshSessionPromise: Promise<boolean> | null = null;

function isRetryableRequest(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

function waitBeforeRetry(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, NETWORK_RETRY_DELAY_MS);
  });
}

function refreshSession(): Promise<boolean> {
  if (!refreshSessionPromise) {
    refreshSessionPromise = fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then((response) => response.ok)
      .catch(() => false)
      .finally(() => {
        refreshSessionPromise = null;
      });
  }

  return refreshSessionPromise;
}

async function fetchWithNetworkRetry(
  endpoint: string,
  options: RequestInit,
  method: string,
): Promise<Response> {
  try {
    return await fetch(endpoint, options);
  } catch (error) {
    // fetch rejects only when the request itself could not be completed.
    // Retry idempotent reads once, but never replay writes that may already
    // have reached the server.
    if (!(error instanceof TypeError) || !isRetryableRequest(method)) {
      throw error;
    }

    await waitBeforeRetry();
    return fetch(endpoint, options);
  }
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
      if (await refreshSession()) {
        csrfToken = getCsrfTokenFromCookie();
      }
    }

    if (csrfToken) {
      headers.set('x-csrf-token', csrfToken);
    }
  }

  const requestOptions: RequestInit = {
    ...options,
    method,
    headers,
    credentials: 'same-origin',
  };

  const response = await fetchWithNetworkRetry(endpoint, requestOptions, method);

  // Access tokens can expire between the page-level auth check and subsequent
  // API reads. Refresh once and replay only idempotent requests. Concurrent
  // 401 responses share one refresh to avoid refresh-token replay detection.
  if (
    response.status === 401 &&
    endpoint !== '/api/auth/refresh' &&
    isRetryableRequest(method) &&
    await refreshSession()
  ) {
    return fetchWithNetworkRetry(endpoint, requestOptions, method);
  }

  return response;
}
