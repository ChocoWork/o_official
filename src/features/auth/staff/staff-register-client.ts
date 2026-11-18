/**
 * 2本の登録の終わりを窓口に伝える部品（src/features/auth/staff/staff-register-client.ts）。React を知らない純粋な関数だけを置く。
 *
 * @packageDocumentation
 * @remarks 鍵・トークン・`session_id` は扱わない（本文なしの POST。サーバーが Cookie のセッションで決める）。
 */
import { clientFetch } from '@/lib/client-fetch';

export type CompleteFailureReason =
  | 'keys_short'
  | 'keys_not_window'
  | 'window_closed'
  | 'rate_limited'
  | 'unavailable'
  | 'failed';

export type CompleteResult = { ok: true; redirectTo: string } | { ok: false; reason: CompleteFailureReason };

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function failureOf(status: number, body: Record<string, unknown> | null): CompleteFailureReason {
  if (status === 409 && body?.error === 'keys_short') return 'keys_short';
  if (status === 409 && body?.error === 'keys_not_window') return 'keys_not_window';
  if (status === 403 && body?.error === 'window_closed') return 'window_closed';
  if (status === 401) return 'window_closed';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'unavailable';
  return 'failed';
}

/**
 * 2本そろったことを伝え、役割の有効化を求める。成功すると窓口が全ログインを終わらせるので、行き先（`/login`）だけを返す。
 *
 * @impl IMPL-AUTH-377
 * @design DD-AUTH-080
 */
export async function completeStaffRegistration(fetchApi: typeof clientFetch): Promise<CompleteResult> {
  let response: Response;
  try {
    response = await fetchApi('/api/auth/staff/register/complete', { method: 'POST' });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  // no-store の応答は、本文を読み切らないと Chrome が「通信中」のままにする。
  const body = await readJson(response);
  if (response.ok) {
    const to = body?.redirectTo;
    return { ok: true, redirectTo: typeof to === 'string' && to.startsWith('/') && !to.startsWith('//') ? to : '/login' };
  }
  return { ok: false, reason: failureOf(response.status, body) };
}
