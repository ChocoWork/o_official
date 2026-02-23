/**
 * Browser-side fetch wrapper that automatically includes Authorization header
 * with the Supabase access token from localStorage
 */
export async function clientFetch(
  endpoint: string,
  options?: RequestInit
): Promise<Response> {
  // Get token from localStorage
  const tokenData = localStorage.getItem('supabase.auth.token');
  const token = tokenData ? JSON.parse(tokenData) : null;

  const headers = new Headers(options?.headers || {});

  // Add Authorization header if token exists
  if (token?.access_token) {
    headers.set('Authorization', `Bearer ${token.access_token}`);
    console.log('[clientFetch] Added Authorization header');
  } else {
    console.warn('[clientFetch] No access token found in localStorage');
  }

  return fetch(endpoint, {
    ...options,
    headers,
  });
}
