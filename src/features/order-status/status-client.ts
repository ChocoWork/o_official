// File: src/features/order-status/status-client.ts
import { clientFetch, getCsrfTokenFromCookie } from '@/lib/client-fetch';

/** GET の認証更新は既存 clientFetch に任せる。 */
export function fetchOrderStatusPrivate(token: string, signal?: AbortSignal): Promise<Response> {
  return clientFetch(`/api/order-status/${token}/private`, { method: 'GET', cache: 'no-store', signal });
}

/** ゲストの確認では refresh を起こさず、書き込みを一度だけ送る（P29）。 */
export function submitOrderStatusLastFour(token: string, lastFour: string): Promise<Response> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const csrf = getCsrfTokenFromCookie();
  if (csrf) headers.set('x-csrf-token', csrf);
  return fetch(`/api/order-status/${token}/verify`, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', headers,
    body: JSON.stringify({ lastFour }),
  });
}
