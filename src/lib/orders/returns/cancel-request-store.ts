import {
  callRpc,
  declineReasonOf,
  firstRowOf,
  objectsOf,
  requiredEnum,
  textOrNull,
  type JsonObject,
  type ReturnRpcName,
  type ReturnStore,
} from '@/lib/orders/returns/return-store';
import {
  CANCEL_REQUEST_STATUSES,
  type AdminCancelRequest,
  type CancelRequestStatus,
  type ReturnDeclineReason,
} from '@/lib/orders/returns/return-types';

/**
 * キャンセルの申し込みの DB の関数を呼ぶ（グループ E-3 段2。共通の約束 C-1・C-2）。管理画面の窓口だけが使う。
 * 断り（記号は C-4）は return-store.ts と同じ ReturnStoreError、思いがけない失敗は RefundStoreError で止める。
 * DB の関数の jsonb は snake_case。camelCase への直しはこのファイルが行う。サーバーだけで使う（画面から読まない）。
 * 単体テストが直接読むので、サーバー専用の印（server-only）は付けない。
 */

export type CancelRequestResult = { cancelRequestId: string; status: CancelRequestStatus };

function toCancelRequestResult(row: JsonObject, operation: ReturnRpcName): CancelRequestResult {
  return {
    cancelRequestId: String(row.cancel_request_id),
    status: requiredEnum(row.status, CANCEL_REQUEST_STATUSES, operation),
  };
}

function toAdminCancelRequest(row: JsonObject): AdminCancelRequest {
  return {
    id: String(row.id),
    status: requiredEnum(row.status, CANCEL_REQUEST_STATUSES, 'list_order_cancel_requests'),
    requestedAt: String(row.requested_at),
    customerNote: textOrNull(row.customer_note),
    lines: objectsOf(row.lines).map((line) => ({
      orderItemId: String(line.order_item_id),
      itemName: String(line.item_name),
      color: textOrNull(line.color),
      size: textOrNull(line.size),
      quantity: Number(line.quantity),
      unshipped: Number(line.unshipped),
    })),
    declineReason: declineReasonOf(row.decline_reason),
    declineMessage: textOrNull(row.decline_message),
    declinedAt: textOrNull(row.declined_at),
    declinedByEmail: textOrNull(row.declined_by_email),
    resolvedAt: textOrNull(row.resolved_at),
    resolvedByEmail: textOrNull(row.resolved_by_email),
    resolvedRefundId: textOrNull(row.resolved_refund_id),
    resolvedByCancelAt: textOrNull(row.resolved_by_cancel_at),
    closedAt: textOrNull(row.closed_at),
    closedByEmail: textOrNull(row.closed_by_email),
  };
}

/** 注文のキャンセルの申し込みの一覧（新しい順。並びは DB が決める）。操作した人のメールを含むので、お客様の窓口には返さない */
export async function listOrderCancelRequests(store: ReturnStore, orderId: string): Promise<AdminCancelRequest[]> {
  const data = await callRpc(store, 'list_order_cancel_requests', { _order_id: orderId });
  return objectsOf(data).map(toAdminCancelRequest);
}

/** 申し込みをお断りする（requested → declined）。メッセージはお客様に届く。2回目は CANCEL_REQUEST_STATE_CONFLICT になる */
export async function declineCancelRequest(
  store: ReturnStore,
  input: { cancelRequestId: string; actorId: string; declineReason: ReturnDeclineReason; declineMessage: string },
): Promise<CancelRequestResult> {
  return toCancelRequestResult(
    firstRowOf(
      await callRpc(store, 'admin_decline_cancel_request', {
        _cancel_request_id: input.cancelRequestId,
        _actor_id: input.actorId,
        _decline_reason: input.declineReason,
        _decline_message: input.declineMessage,
      }),
      'admin_decline_cancel_request',
    ),
    'admin_decline_cancel_request',
  );
}

/** 申し込みを「解決済みにする」（requested → closed）。注文を変えず、メールも送らない */
export async function closeCancelRequest(
  store: ReturnStore,
  input: { cancelRequestId: string; actorId: string },
): Promise<CancelRequestResult> {
  return toCancelRequestResult(
    firstRowOf(
      await callRpc(store, 'admin_close_cancel_request', {
        _cancel_request_id: input.cancelRequestId,
        _actor_id: input.actorId,
      }),
      'admin_close_cancel_request',
    ),
    'admin_close_cancel_request',
  );
}

/**
 * 申し込みを解決にする（requested → resolved）。品を外した返金（refundId）か、注文の取消（orderCancelled）のどちらか1つを渡す。
 * DB が、その返金が同じ注文で申し込みの後にできた物か、注文が取り消されているかを確かめる（CANCEL_REQUEST_RESOLUTION_INVALID）
 */
export async function resolveCancelRequest(
  store: ReturnStore,
  input: { cancelRequestId: string; actorId: string; refundId: string | null; orderCancelled: boolean },
): Promise<CancelRequestResult> {
  return toCancelRequestResult(
    firstRowOf(
      await callRpc(store, 'admin_resolve_cancel_request', {
        _cancel_request_id: input.cancelRequestId,
        _actor_id: input.actorId,
        _refund_id: input.refundId,
        _order_cancelled: input.orderCancelled,
      }),
      'admin_resolve_cancel_request',
    ),
    'admin_resolve_cancel_request',
  );
}
