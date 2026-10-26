import { clientFetch } from '@/lib/client-fetch';
import type { RemoveItemsRequest } from '@/components/OrderCancelRequestDialog';
import type { AdminOrderDetail } from './admin-order-types';

export const REFUND_NOTICES = {
  pending: '返金を受け付けました。お金が戻ると、注文の状態が変わります。',
  succeeded: '返金しました。',
} as const;
export const PAID_CANCEL_NOTICES = {
  pending: 'キャンセルを受け付けました。返金が済むと、注文がキャンセルになります。',
  succeeded: '注文をキャンセルし、返金しました。',
} as const;
export const STRIPE_UNAVAILABLE_MESSAGE = 'Stripe の状態を確認できませんでした。時間をおいて再試行してください。';
export const ATTENTION_NETWORK_ERROR_MESSAGE = '通信できませんでした。一覧を更新してください。';
export const CANCEL_REQUEST_RESOLVED_NOTICE = 'キャンセルの申し込みを解決しました。';
export const CANCEL_REQUEST_RESOLVE_FAILED_MESSAGE = '返金・キャンセルは記録しましたが、申し込みを解決済みにできませんでした。キャンセルの申し込みの画面で「解決済みにする」を押してください。';
export type PendingCancelResolve = { cancelRequestId: string; orderId: string; mode: RemoveItemsRequest['mode']; lines: RemoveItemsRequest['lines'] };

/** 操作の断りは短い日本語だけを表示する。内部の英語・制御文字は既定の文に置き換える。 */
export async function readSafeOrderActionError(response: Response, fallback: string, readableStatuses: readonly number[] = [400, 409]): Promise<string> {
  if (!readableStatuses.includes(response.status)) return fallback;
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === 'string' && body.error.length > 0 && body.error.length <= 200
      && /[\u3040-\u30ff\u3400-\u9fff]/u.test(body.error) && !/[\u0000-\u001f\u007f]/u.test(body.error)) return body.error;
  } catch { /* JSONでない断りも既定の文にする。 */ }
  return fallback;
}

export type AdminOrderDetailRead = { kind: 'ready'; data: AdminOrderDetail } | { kind: 'forbidden' | 'notFound' | 'error' };
export async function fetchAdminOrderDetail(orderId: string): Promise<AdminOrderDetailRead> {
  try {
    const response = await clientFetch(`/api/admin/orders/${orderId}`, { cache: 'no-store' });
    if (!response.ok) return { kind: response.status === 403 ? 'forbidden' : response.status === 404 ? 'notFound' : 'error' };
    const body = await response.json() as { data?: AdminOrderDetail };
    if (!body.data || body.data.order?.id !== orderId) return { kind: 'error' };
    return { kind: 'ready', data: body.data };
  } catch { return { kind: 'error' }; }
}
