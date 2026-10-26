import { z } from 'zod';
import { adminLoadFailureMessage } from '@/lib/admin/admin-load-failure';
import { clientFetch } from '@/lib/client-fetch';
import { RATE_LIMITED_MESSAGE } from '@/lib/orders/refund/refund-messages';
import type { DeliveryCallResult } from '@/lib/orders/tracking/delivery-types';
import {
  ALLOCATION_SWAP_ERRORS, ALLOCATION_SWAP_TEXT, parseAllocationSwapCandidates, parseAllocationSwapResult,
  type AllocationSwapCandidate, type AllocationSwapInput, type AllocationSwapResult,
} from './allocation-swap-types';

const uuid = z.string().uuid();
const object = (body: unknown): Record<string, unknown> => body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
function knownMessage(body: unknown): string | undefined {
  const { code } = object(body);
  return typeof code === 'string' && Object.hasOwn(ALLOCATION_SWAP_ERRORS, code) ? ALLOCATION_SWAP_ERRORS[code][2] : undefined;
}

/** useDeliverySubmissionが同じ本文とrequestKeyを保存して再確認できるよう、書込み結果不明を分ける。 */
export async function postAllocationSwap(orderId: string, input: AllocationSwapInput): Promise<DeliveryCallResult<AllocationSwapResult>> {
  if (!uuid.safeParse(orderId).success) return { kind: 'refused', message: ALLOCATION_SWAP_ERRORS.GROUP_G_ARGUMENT_INVALID[2] };
  let response: Response;
  try {
    response = await clientFetch(`/api/admin/orders/${orderId}/allocations/swap`, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  } catch { return { kind: 'unknown' }; }
  if (response.status >= 500) return { kind: 'unknown' };
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    try { return { kind: 'ok', data: parseAllocationSwapResult(body, orderId, input) }; } catch { return { kind: 'unknown' }; }
  }
  if (response.status === 403) {
    const { reason, code, permission } = object(body);
    if (reason === 'CSRF validation failed') return { kind: 'blocked', message: ALLOCATION_SWAP_TEXT.csrfFailed, forbidden: false };
    return { kind: 'blocked', message: adminLoadFailureMessage(403, body, ALLOCATION_SWAP_TEXT.forbidden, ALLOCATION_SWAP_TEXT.failed),
      forbidden: reason !== 'MFA required' && (code === 'GROUP_G_FORBIDDEN' || typeof permission === 'string' && permission !== '') };
  }
  if (response.status === 401) return { kind: 'blocked', message: adminLoadFailureMessage(401, body, ALLOCATION_SWAP_TEXT.forbidden, ALLOCATION_SWAP_TEXT.failed) };
  if (response.status === 429) return { kind: 'blocked', message: RATE_LIMITED_MESSAGE };
  return { kind: 'refused', message: knownMessage(body) ?? ALLOCATION_SWAP_ERRORS.GROUP_G_ARGUMENT_INVALID[2] };
}

export type AllocationSwapCandidatesRead = { kind: 'ok'; data: AllocationSwapCandidate[] } | { kind: 'error'; message: string; denied: boolean };
/** 候補の失敗は書込みの結果不明ではない。生のerror本文を表示せず固定文を選ぶ。 */
export async function fetchSwapCandidates(orderId: string, orderItemId: string): Promise<AllocationSwapCandidatesRead> {
  const failed: AllocationSwapCandidatesRead = { kind: 'error', message: ALLOCATION_SWAP_TEXT.candidatesFailed, denied: false };
  if (!uuid.safeParse(orderId).success || !uuid.safeParse(orderItemId).success) return failed;
  try {
    const response = await clientFetch(`/api/admin/orders/${orderId}/allocations/swap-candidates?orderItemId=${orderItemId}`, { cache: 'no-store' });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { kind: 'error', denied: response.status === 401 || response.status === 403,
      message: response.status === 401 || response.status === 403
        ? adminLoadFailureMessage(response.status, body, ALLOCATION_SWAP_TEXT.forbidden, ALLOCATION_SWAP_TEXT.candidatesFailed)
        : response.status < 500 ? knownMessage(body) ?? ALLOCATION_SWAP_TEXT.candidatesFailed : ALLOCATION_SWAP_TEXT.candidatesFailed };
    return { kind: 'ok', data: parseAllocationSwapCandidates(object(body).data, orderId) };
  } catch { return failed; }
}
