/**
 * Browser-side fetch wrapper that automatically includes Authorization header
 * with the Supabase access token from localStorage
 */
function resolveAccessToken(rawTokenData: string | null): string | null {
  if (!rawTokenData) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawTokenData) as
      | { access_token?: unknown; currentSession?: { access_token?: unknown } }
      | null;

    if (typeof parsed?.access_token === 'string' && parsed.access_token.length > 0) {
      return parsed.access_token;
    }

    if (typeof parsed?.currentSession?.access_token === 'string' && parsed.currentSession.access_token.length > 0) {
      return parsed.currentSession.access_token;
    }
  } catch {
    return null;
  }

  return null;
}

export async function clientFetch(
  endpoint: string,
  options?: RequestInit
): Promise<Response> {
  // Get token from localStorage
  const tokenData = localStorage.getItem('supabase.auth.token');
  const accessToken = resolveAccessToken(tokenData);

  const headers = new Headers(options?.headers || {});

  // Add Authorization header if token exists
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  return fetch(endpoint, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
}
