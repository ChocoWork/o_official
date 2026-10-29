'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import AdminOrderItemsTable from '@/components/AdminOrderItemsTable';
import AllocationSwapDialog from '@/components/AllocationSwapDialog';
import OrderCancelDialog, { type OrderCancelValues } from '@/components/OrderCancelDialog';
import OrderCancelRequestDialog, { type RemoveItemsRequest } from '@/components/OrderCancelRequestDialog';
import OrderHistoryPanel from '@/components/OrderHistoryPanel';
import OrderPaidCancelDialog from '@/components/OrderPaidCancelDialog';
import OrderRefundDialog from '@/components/OrderRefundDialog';
import OrderReturnsDialog from '@/components/OrderReturnsDialog';
import { BannerAlert } from '@/components/ui/BannerAlert/BannerAlert';
import { Button } from '@/components/ui/Button/Button';
import { StatusBadge } from '@/components/ui/StatusBadge/StatusBadge';
import { clientFetch } from '@/lib/client-fetch';
import { ALLOCATION_SWAP_TEXT } from '@/lib/inventory/allocation-swap-types';
import { hasReturnsToShow, returnButtonLabel } from '@/lib/orders/admin-orders/admin-order-actions';
import { ATTENTION_NETWORK_ERROR_MESSAGE, CANCEL_REQUEST_RESOLVED_NOTICE, CANCEL_REQUEST_RESOLVE_FAILED_MESSAGE, fetchAdminOrderDetail, PAID_CANCEL_NOTICES, readSafeOrderActionError, REFUND_NOTICES, STRIPE_UNAVAILABLE_MESSAGE, type PendingCancelResolve } from '@/lib/orders/admin-orders/admin-order-client';
import { ADMIN_ORDER_TEXT, type AdminOrderDetail, type OrderItem } from '@/lib/orders/admin-orders/admin-order-types';
import { toOrderNumber } from '@/lib/orders/order-number';
import { PAYMENT_EXCEPTION_REASON_LABELS, REVIEW_REASON_LABELS, DISCOUNT_ATTENTION_LABELS } from '@/lib/orders/order-payment-types';
import { PARTIALLY_SHIPPED_LABEL } from '@/lib/orders/order-progress';
import { PAYMENT_STATUS_LABELS } from '@/lib/orders/payment-status';
import type { RefundAcceptedResponse } from '@/lib/orders/refund/refund-types';
import { RETURN_DISPLAY_STATUS_LABELS, RETURN_MARK_LABELS } from '@/lib/orders/returns/return-messages';
import { SHIPMENT_SLIP_TEXT } from '@/lib/orders/shipment-slips/shipment-slip-types';
import { SHIPPING_CARRIERS, isShippingCarrierId } from '@/lib/orders/shipping-carriers';
import { DELIVERY_ATTENTION_LABELS } from '@/lib/orders/tracking/delivery-messages';

const yen = (value: number | null): string => value === null ? '-' : `¥${value.toLocaleString('ja-JP')}`;
function dateTime(value: string): string {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
function dictionaryLabel(labels: Record<string, string>, key: string, fallback: string): string {
  return Object.hasOwn(labels, key) ? labels[key] : fallback;
}

export default function AdminOrderDetailSection({ orderId }: { orderId: string }): React.JSX.Element {
  return <Suspense fallback={<p>{ADMIN_ORDER_TEXT.detailLoading}</p>}><OrderDetail key={orderId} orderId={orderId} /></Suspense>;
}

function OrderDetail({ orderId }: { orderId: string }): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'forbidden' | 'notFound' | 'error'>('loading');
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const requestNumber = useRef(0);
  const hasDetail = useRef(false);
  const openedFromQuery = useRef(false);
  const [cancelTarget, setCancelTarget] = useState<OrderItem | null>(null);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [refundOrderId, setRefundOrderId] = useState<string | null>(null);
  const [paidCancelOrderId, setPaidCancelOrderId] = useState<string | null>(null);
  const [returnsOrderId, setReturnsOrderId] = useState<string | null>(null);
  const [cancelRequestOrderId, setCancelRequestOrderId] = useState<string | null>(null);
  const [pendingResolve, setPendingResolve] = useState<PendingCancelResolve | null>(null);
  const [swapRow, setSwapRow] = useState<AdminOrderDetail['rows'][number] | null>(null);

  // 更新時も前の詳細を保持する。最後に始めた要求だけが詳細・古い印・成功通知を更新できる。
  const reload = useCallback(async (successNotice?: string): Promise<void> => {
    const request = ++requestNumber.current;
    // 旧頁の fetchOrders と同じく、読み直しの先頭で前の知らせと誤りを消す。呼び手の誤りの文は、読み直しを始めた後に入れる。
    setNotice(null);
    setActionError(null);
    setHistoryVersion((version) => version + 1);
    const result = await fetchAdminOrderDetail(orderId);
    if (request !== requestNumber.current) return;
    if (result.kind === 'ready') {
      hasDetail.current = true;
      setDetail(result.data); setPhase('ready'); setStale(false);
      setNotice(successNotice ?? null);
    } else if (hasDetail.current) {
      setStale(true);
    } else {
      setPhase(result.kind);
    }
  }, [orderId]);
  useEffect(() => {
    void reload();
    return () => { requestNumber.current += 1; };
  }, [reload]);

  useEffect(() => {
    if (!detail || openedFromQuery.current) return;
    openedFromQuery.current = true;
    const open = searchParams.get('open');
    const { summary, permissions } = detail;
    if (open === 'refund' && permissions.refund && summary.canRefund) setRefundOrderId(orderId);
    else if (open === 'returns' && summary.returnSummary && hasReturnsToShow(summary.returnSummary)) setReturnsOrderId(orderId);
    else if (open === 'cancel-request' && permissions.manage && summary.cancelRequestOpen) setCancelRequestOrderId(orderId);
    else return;
    router.replace(`/admin/orders/${orderId}`);
  }, [detail, orderId, router, searchParams]);

  // 旧handleRemoveItemsと同じく、受理後にだけ申請を解決する。解決の失敗は操作の失敗と分ける。
  const resolveCancelRequest = async (pending: PendingCancelResolve, outcome: { refundId: string | null; orderCancelled: boolean }, baseNotice: string): Promise<void> => {
    let resolved = false;
    try {
      const response = await clientFetch(`/api/admin/cancel-requests/${pending.cancelRequestId}/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(outcome),
      });
      resolved = response.ok;
    } catch { /* 返金・取消は受理済み。解決だけの失敗を下で案内する。 */ }
    await reload(resolved ? `${baseNotice}${CANCEL_REQUEST_RESOLVED_NOTICE}` : baseNotice);
    if (!resolved) setActionError(CANCEL_REQUEST_RESOLVE_FAILED_MESSAGE);
  };
  const resolveAfterRefund = (mode: 'refund' | 'paid_cancel', refundId: string, baseNotice: string): void => {
    if (!pendingResolve || pendingResolve.mode !== mode) { void reload(baseNotice); return; }
    setPendingResolve(null);
    void resolveCancelRequest(pendingResolve, { refundId, orderCancelled: false }, baseNotice);
  };
  const handleRefundOrder = (id: string): void => { setNotice(null); setActionError(null); setPendingResolve(null); setRefundOrderId(id); };
  const handleCancelOrder = (): void => {
    if (!detail) return;
    setNotice(null); setActionError(null); setPendingResolve(null);
    if (detail.summary.cancelKind === 'paid') setPaidCancelOrderId(orderId);
    else setCancelTarget(detail.summary);
  };
  const handleRefunded = (result: RefundAcceptedResponse): void => {
    setRefundOrderId(null);
    resolveAfterRefund('refund', result.refundId, result.status === 'succeeded' ? REFUND_NOTICES.succeeded : REFUND_NOTICES.pending);
  };
  const handlePaidCancelled = (result: RefundAcceptedResponse): void => {
    setPaidCancelOrderId(null);
    resolveAfterRefund('paid_cancel', result.refundId, result.status === 'succeeded' ? PAID_CANCEL_NOTICES.succeeded : PAID_CANCEL_NOTICES.pending);
  };
  const handleRefundUncertain = (): void => { void reload(); };
  const handleReturnsChanged = (): void => { void reload(); };
  const handleReturnsClosed = (): void => { setReturnsOrderId(null); void reload(); };
  const handleCancelRequestChanged = (message: string): void => { setCancelRequestOrderId(null); void reload(message); };
  const handleRemoveItems = (request: RemoveItemsRequest): void => {
    const id = cancelRequestOrderId;
    if (!id) return;
    if (request.mode === 'unpaid_cancel' && !detail) {
      setCancelRequestOrderId(null); void reload(); setActionError('操作に失敗しました。一覧を更新してください。'); return;
    }
    setNotice(null); setActionError(null); setCancelRequestOrderId(null);
    setPendingResolve({ cancelRequestId: request.cancelRequestId, orderId: id, mode: request.mode, lines: request.lines });
    if (request.mode === 'unpaid_cancel') setCancelTarget(detail?.summary ?? null);
    else if (request.mode === 'paid_cancel') setPaidCancelOrderId(id);
    else setRefundOrderId(id);
  };
  const closeRefundDialog = (): void => { setRefundOrderId(null); setPendingResolve(null); void reload(); };
  const closePaidCancelDialog = (): void => { setPaidCancelOrderId(null); setPendingResolve(null); void reload(); };
  const closeCancelDialog = (): void => { setCancelTarget(null); setPendingResolve(null); void reload(); };
  const submitCancelOrder = async (values: OrderCancelValues): Promise<void> => {
    const target = cancelTarget;
    if (!target || cancelSubmitting) return;
    setActionError(null); setNotice(null); setCancelSubmitting(true);
    const resolveTarget = pendingResolve?.mode === 'unpaid_cancel' && pendingResolve.orderId === target.id ? pendingResolve : null;
    try {
      const response = await clientFetch(`/api/admin/orders/${target.id}/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled', reason: values.reason, ...(values.note ? { note: values.note } : {}), notifyCustomer: values.notifyCustomer }),
      });
      if (!response.ok) {
        if (response.status === 401) throw new Error('認証が必要です。再ログインしてください。');
        if (response.status === 403) throw new Error('注文ステータス更新の権限がありません。');
        if (response.status === 503) throw new Error(STRIPE_UNAVAILABLE_MESSAGE);
        throw new Error(await readSafeOrderActionError(response, '注文ステータスの更新に失敗しました。'));
      }
      const message = '注文を取り消しました。';
      // 旧頁と同じく、解決と読み直しは待たない。待つと、遅い読込の間 dialog が「処理中」のまま閉じられない。
      if (resolveTarget) { setPendingResolve(null); void resolveCancelRequest(resolveTarget, { refundId: null, orderCancelled: true }, message); }
      else void reload(message);
    } catch (error) {
      void reload();
      setActionError(error instanceof Error ? error.message : '注文ステータスの更新に失敗しました。');
    } finally {
      setCancelTarget((current) => current?.id === target.id ? null : current);
      setPendingResolve((current) => current?.mode === 'unpaid_cancel' && current.orderId === target.id ? null : current);
      setCancelSubmitting(false);
    }
  };
  const handleReviewOrder = async (): Promise<void> => {
    if (reviewSubmitting) return;
    setActionError(null); setNotice(null); setReviewSubmitting(true);
    try {
      const response = await clientFetch(`/api/admin/orders/${orderId}/review`, { method: 'POST' });
      if (!response.ok) {
        if (response.status === 403) throw new Error('この操作の権限がありません。');
        if (response.status === 503) throw new Error(STRIPE_UNAVAILABLE_MESSAGE);
        throw new Error(await readSafeOrderActionError(response, '操作に失敗しました。一覧を更新してください。'));
      }
      await reload('確認済みにしました。');
    } catch (error) {
      void reload();
      setActionError(error instanceof TypeError ? ATTENTION_NETWORK_ERROR_MESSAGE : error instanceof Error ? error.message : '操作に失敗しました。');
    } finally { setReviewSubmitting(false); }
  };

  const back = <Button href="/admin/orders" variant="secondary">{ADMIN_ORDER_TEXT.back}</Button>;
  if (!detail) return <div className="min-w-0 space-y-4">{back}{phase === 'loading' ? <p>{ADMIN_ORDER_TEXT.detailLoading}</p> : <BannerAlert message={phase === 'forbidden' ? ADMIN_ORDER_TEXT.detailForbidden : phase === 'notFound' ? ADMIN_ORDER_TEXT.detailNotFound : ADMIN_ORDER_TEXT.detailFailed} />}{phase === 'error' ? <Button onClick={() => void reload()}>{ADMIN_ORDER_TEXT.reload}</Button> : null}</div>;
  const { order, summary, permissions, amounts, attention } = detail;
  const number = toOrderNumber(orderId);
  const canRefund = permissions.refund && summary.canRefund;
  const canCancel = summary.cancelKind === 'unpaid' ? permissions.manage : summary.cancelKind === 'paid' && permissions.refund;
  const hasAttention = Boolean(attention.review || attention.paymentExceptions.length || attention.deliveries.length || attention.discounts?.length);
  return (
    <div className="w-full min-w-0 space-y-8 break-words">
      <div className="flex flex-wrap items-center justify-between gap-3"><h1>注文 {number}</h1>{back}</div>
      <div role="status" aria-live="polite">{!stale ? notice : null}</div>
      {stale ? <div className="space-y-2"><BannerAlert message={ADMIN_ORDER_TEXT.reloadFailed} /><p>{ADMIN_ORDER_TEXT.stale}</p><Button variant="secondary" onClick={() => void reload()}>{ADMIN_ORDER_TEXT.reload}</Button></div> : null}
      {actionError ? <BannerAlert message={actionError} /> : null}
      <section aria-labelledby="order-info" className="min-w-0 space-y-3">
        <h2 id="order-info">注文情報</h2>
        <dl className="grid min-w-0 gap-x-6 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt>注文日</dt><dd>{dateTime(order.createdAt)}</dd><dt>注文ID</dt><dd>{number}</dd>
          <dt>進み具合</dt><dd><StatusBadge>{summary.status}</StatusBadge>{summary.partiallyShipped ? <span className="ml-2">{PARTIALLY_SHIPPED_LABEL}</span> : null}</dd>
          <dt>顧客名</dt><dd>{order.customerName || 'ゲスト'}</dd><dt>メール</dt><dd>{order.customerEmail || '-'}</dd>
          <dt>配送先</dt><dd className="min-w-0">{[order.shipTo.fullName, order.shipTo.postalCode, order.shipTo.prefecture, order.shipTo.city, order.shipTo.address, order.shipTo.building, order.shipTo.phone].filter(Boolean).map((value, index) => <p key={index}>{value}</p>)}</dd>
          <dt>支払い方法</dt><dd>{summary.paymentMethod || '-'}</dd><dt>支払いの参照</dt><dd className="break-all">{summary.paymentReference || '-'}</dd>
        </dl>
        {summary.missingShippingFields?.length ? <p>配送先の情報が足りません（{summary.missingShippingFields.join('・')}）</p> : null}
        {summary.shipBlockedReason ? <p>支払額の確認が必要です（要対応）</p> : null}
      </section>
      <section aria-labelledby="order-payment" className="min-w-0 space-y-3">
        <h2 id="order-payment">支払いと返金</h2>
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)]">{([
          ['商品の正味額', amounts.productNet], ['割引', amounts.discount], ['送料', amounts.shipping], ['合計', amounts.total], ['受け取った額', amounts.paidAmount], ['返金済み（成功）', amounts.refundedAmount], ['返金の手続き中', amounts.refundProcessingAmount], ['送料・調整額の返金', amounts.refundNotAttached],
        ] as const).map(([label, amount]) => <Amount key={label} label={label} value={yen(amount)} />)}</dl>
        <div className="flex flex-wrap gap-2"><StatusBadge>{summary.paymentStatusKey ? PAYMENT_STATUS_LABELS[summary.paymentStatusKey] : summary.paymentStatus}</StatusBadge>{summary.refundPending ? <StatusBadge tone="warning">返金の手続き中</StatusBadge> : null}{summary.refundFailed ? <StatusBadge tone="danger">返金の失敗</StatusBadge> : null}</div>
        <div className="flex flex-wrap gap-3">{canRefund ? <Button variant="secondary" onClick={() => handleRefundOrder(orderId)}>返金</Button> : null}{canCancel ? <Button variant="secondary" onClick={handleCancelOrder}>キャンセル</Button> : null}</div>
        {summary.cancelBlockedUntil ? <p>払込票の期限切れが確定するまで取り消せません（払込期限 {dateTime(summary.cancelBlockedUntil)}）</p> : null}
        {summary.status === '未決済' && summary.canCancel === false && !summary.cancelBlockedUntil ? <p>支払いの状態を確かめられないため、今は取り消せません</p> : null}
      </section>
      <section aria-labelledby="order-items" className="min-w-0 space-y-3"><h2 id="order-items">品物</h2><AdminOrderItemsTable rows={detail.rows} orderNumber={number} canSwap={permissions.allocate} onSwap={(row) => { setNotice(null); setSwapRow(row); }} /></section>
      <section aria-labelledby="order-shipping" className="min-w-0 space-y-3">
        <h2 id="order-shipping">発送</h2>
        {detail.fulfillments.length === 0 ? <p>{ADMIN_ORDER_TEXT.noFulfillments}</p> : detail.fulfillments.map((fulfillment) => <div key={fulfillment.id} className="space-y-1">
          <h3>{fulfillment.number}回目の発送</h3><p>{dateTime(fulfillment.shippedAt)}</p>
          <p>{fulfillment.carrier && isShippingCarrierId(fulfillment.carrier) ? SHIPPING_CARRIERS[fulfillment.carrier].label : fulfillment.carrier} {fulfillment.trackingNumber || '伝票番号なし'}</p>
          {fulfillment.cancelledAt ? <p>取消済み {dateTime(fulfillment.cancelledAt)}</p> : fulfillment.deliveredAt ? <p>配達済み {dateTime(fulfillment.deliveredAt)}</p> : null}
          {detail.slips !== null && fulfillment.slipId && fulfillment.slipNumber ? <Link className="underline" href={`/admin/shipment-slips/${fulfillment.slipId}`}>発送票 {fulfillment.slipNumber}</Link> : null}
        </div>)}
        {detail.slips === null ? <p>{ADMIN_ORDER_TEXT.slipForbidden}</p> : <>
          {detail.slips.filter((slip) => !detail.fulfillments.some((fulfillment) => fulfillment.slipId === slip.slipId)).map((slip) => <p key={slip.slipId}><Link className="underline" href={`/admin/shipment-slips/${slip.slipId}`}>発送票 {slip.number}</Link></p>)}
          {detail.slips.some((slip) => slip.stage === 'confirmed') ? <p>同梱された発送票の配送の要対応は、代表の注文にだけ表示されます。詳しくは発送票を開いてください。</p> : null}
        </>}
        {permissions.shippingRead ? <Button href="/admin/packing" variant="secondary">{SHIPMENT_SLIP_TEXT.openPacking}</Button> : null}
      </section>
      <section aria-labelledby="order-returns" className="min-w-0 space-y-3">
        <h2 id="order-returns">返品とキャンセルの申し込み</h2>
        {summary.returnSummary?.displayStatus ? <div className="flex flex-wrap gap-2"><StatusBadge>{RETURN_DISPLAY_STATUS_LABELS[summary.returnSummary.displayStatus]}</StatusBadge>{summary.returnSummary.marks.map((mark) => <span key={mark}>{RETURN_MARK_LABELS[mark]}</span>)}</div> : null}
        <div className="flex flex-wrap gap-3">
          {summary.returnSummary && hasReturnsToShow(summary.returnSummary) ? <Button variant="secondary" onClick={() => { setNotice(null); setReturnsOrderId(orderId); }}>{returnButtonLabel(summary.returnSummary, permissions.refund)}</Button> : null}
          {permissions.manage && summary.cancelRequestOpen ? <Button variant="secondary" onClick={() => { setNotice(null); setCancelRequestOrderId(orderId); }}>キャンセルの申し込み</Button> : null}
        </div>
      </section>
      <section aria-labelledby="order-attention" className="min-w-0 space-y-3">
        <h2 id="order-attention">要対応</h2>
        {!hasAttention ? <p>{ADMIN_ORDER_TEXT.noAttention}</p> : <>
          {attention.review ? <div><h3>要確認</h3><p>{dictionaryLabel(REVIEW_REASON_LABELS, attention.review.reason, '要確認')}</p>{permissions.manage ? <Button variant="secondary" disabled={reviewSubmitting} onClick={() => void handleReviewOrder()}>確認済みにする</Button> : null}</div> : null}
          {attention.paymentExceptions.map((exception) => <p key={exception.id}>{dictionaryLabel(PAYMENT_EXCEPTION_REASON_LABELS, exception.reason, '支払いの要対応')}（検知 {exception.detectionCount}回）</p>)}
          {attention.deliveries.map((delivery) => <p key={`${delivery.fulfillmentId}:${delivery.kind}`}>{dictionaryLabel(DELIVERY_ATTENTION_LABELS, delivery.kind, '配送の要対応')}</p>)}
          {(attention.discounts ?? []).map(discount => <p key={discount.orderId}>{DISCOUNT_ATTENTION_LABELS[discount.kind]}</p>)}
          {attention.paymentExceptions.length || attention.deliveries.length || attention.discounts?.length ? <Link className="underline" href="/admin/orders#attention">要対応の一覧で対応する</Link> : null}
        </>}
      </section>
      <OrderHistoryPanel key={`${orderId}:${historyVersion}`} orderId={orderId} />

      <OrderRefundDialog orderId={refundOrderId} prefillBeforeShipment={pendingResolve?.mode === 'refund' && pendingResolve.orderId === refundOrderId ? pendingResolve.lines : undefined} onClose={closeRefundDialog} onRefunded={handleRefunded} onUncertain={handleRefundUncertain} />
      <OrderPaidCancelDialog orderId={paidCancelOrderId} onClose={closePaidCancelDialog} onCancelled={handlePaidCancelled} onUncertain={handleRefundUncertain} />
      {returnsOrderId ? <OrderReturnsDialog orderId={returnsOrderId} open canRefund={permissions.refund} onClose={handleReturnsClosed} onChanged={handleReturnsChanged} /> : null}
      {cancelRequestOrderId ? <OrderCancelRequestDialog orderId={cancelRequestOrderId} open canRefund={permissions.refund} onClose={() => { setCancelRequestOrderId(null); void reload(); }} onChanged={handleCancelRequestChanged} onRemoveItems={handleRemoveItems} /> : null}
      <OrderCancelDialog open={cancelTarget !== null} title={cancelTarget ? `注文を取り消す（注文 ${toOrderNumber(cancelTarget.id)}）` : '注文を取り消す'} targetLabel={cancelTarget?.id ?? ''} showNotifyOption={cancelTarget?.status !== '決済失敗'} noteRequired={false} submitting={cancelSubmitting} onClose={closeCancelDialog} onSubmit={(values) => void submitCancelOrder(values)} />
      {swapRow ? <AllocationSwapDialog orderId={orderId} orderNumber={number} row={swapRow} onClose={() => { setSwapRow(null); void reload(); }} onSwapped={() => { setSwapRow(null); void reload(ALLOCATION_SWAP_TEXT.success); }} onStale={() => void reload()} /> : null}
    </div>
  );
}

function Amount({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <><dt>{label}</dt><dd className="tabular-nums">{value}</dd></>;
}
