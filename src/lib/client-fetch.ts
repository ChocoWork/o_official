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

// レート制限は攻撃を止めるための仕組みなので、こちらのリトライで焼き切ってはいけない。
// 失敗の種類ごとにクールダウンを置き、その間は refresh を一切発行しない。
const REFRESH_RATE_LIMITED_COOLDOWN_MS = 60_000;
const REFRESH_UNAUTHENTICATED_COOLDOWN_MS = 30_000;
const REFRESH_ERROR_COOLDOWN_MS = 5_000;

export const SESSION_EXPIRED_EVENT = 'auth:session-expired';

let refreshSessionPromise: Promise<boolean> | null = null;
let refreshBlockedUntil = 0;

function isRetryableRequest(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

function waitBeforeRetry(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, NETWORK_RETRY_DELAY_MS);
  });
}

function blockRefreshFor(durationMs: number): void {
  refreshBlockedUntil = Date.now() + durationMs;
}

// RFC 9110 の Retry-After。秒数のみを解釈し、解釈できなければ呼び出し側の既定値に任せる。
function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers?.get?.('Retry-After');
  if (!header) {
    return null;
  }

  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

// セッションが切れたことを画面側へ伝える。ここで画面遷移まで行うと
// client-fetch がルーティングの責務を持つことになるため、通知だけに留める。
function notifySessionExpired(): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

async function performRefresh(): Promise<boolean> {
  let response: Response;

  try {
    response = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    blockRefreshFor(REFRESH_ERROR_COOLDOWN_MS);
    return false;
  }

  if (response.ok) {
    refreshBlockedUntil = 0;
    return true;
  }

  if (response.status === 429) {
    blockRefreshFor(parseRetryAfterMs(response) ?? REFRESH_RATE_LIMITED_COOLDOWN_MS);
    return false;
  }

  if (response.status === 401) {
    // refresh token が無効。再認証以外に回復手段がないので叩き続けない。
    blockRefreshFor(REFRESH_UNAUTHENTICATED_COOLDOWN_MS);
    notifySessionExpired();
    return false;
  }

  blockRefreshFor(REFRESH_ERROR_COOLDOWN_MS);
  return false;
}

function refreshSession(): Promise<boolean> {
  if (Date.now() < refreshBlockedUntil) {
    return Promise.resolve(false);
  }

  if (!refreshSessionPromise) {
    refreshSessionPromise = performRefresh().finally(() => {
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
