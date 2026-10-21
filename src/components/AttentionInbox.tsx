'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';
import OrderCancelDialog, { type OrderCancelValues } from '@/components/OrderCancelDialog';
import {
  ADMIN_NOTE_MAX_LENGTH,
  type AttentionException,
  type OrderAttention,
} from '@/lib/orders/order-payment-types';
import { formatYen } from '@/lib/orders/refund/refund-messages';
import { DELIVERY_ATTENTION_LABELS, DELIVERY_STATUS_LABELS } from '@/lib/orders/tracking/delivery-messages';

type AttentionInboxProps = {
  attention: OrderAttention | null;
  /** 操作中の要対応 ID・注文 ID。ボタンを押せなくする */
  processingIds: string[];
  onReview: (orderId: string) => void;
  onResolve: (input: { exceptionId: string; note: string }) => void;
  onCancelAndResolve: (input: { exceptionId: string; values: OrderCancelValues }) => void;
  /** 返金の失敗の行から、その注文の返金の画面を開く。返金の権限が無い人には渡さない（ボタンを出さない） */
  onRetryRefund?: (orderId: string) => void;
  /**
   * 失敗した返金が返品の返金（refundFailure.returnId あり）の行から、その注文の返品の画面を開く。返品の返金は、返品の画面の
   * 「額を決めて返金する」で返し直す（ふつうの返金の画面では返金待ちの品を選べない。グループ E-3 の P21）。返金の権限が無い人には渡さない（ボタンを出さない）
   */
  onRetryReturnRefund?: (orderId: string) => void;
  /** 配送の要対応の行から、その注文の履歴を開く（グループ E-4 の Task 10）。渡さなければ「履歴を開く」を出さない */
  onOpenDeliveryHistory?: (orderId: string) => void;
  /** 配送の要対応を対応済みにする（要対応の番号を渡す）。管理の権限（店長とサポート）が無い人には渡さない（ボタンを出さない） */
  onResolveDelivery?: (attentionId: string) => void;
};

function formatDateTime(value: string | null): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/**
 * 管理画面の「要対応・要確認」欄（設計書 5-2）。ORDER タブの注文一覧の上に置き、0件なら出さない。
 * 値はすべて文字列として描画する（理由・メモを HTML として解釈しない）。
 */
export default function AttentionInbox({
  attention,
  processingIds,
  onReview,
  onResolve,
  onCancelAndResolve,
  onRetryRefund,
  onRetryReturnRefund,
  onOpenDeliveryHistory,
  onResolveDelivery,
}: AttentionInboxProps) {
  const headingId = useId();
  const [resolving, setResolving] = useState<AttentionException | null>(null);
  const [cancelling, setCancelling] = useState<AttentionException | null>(null);
  const [note, setNote] = useState('');

  // 配送の組は、開いている行が無ければ出さない（追跡オフの間は窓口が空で返す）。窓口が付けない昔の形は、無い組と同じに扱う
  const deliveries = attention?.deliveries ?? [];
  if (!attention || (attention.exceptions.length === 0 && attention.reviews.length === 0 && deliveries.length === 0)) {
    return null;
  }
  const deliveryCount = attention.counts.deliveries ?? deliveries.length;

  return (
    <section aria-labelledby={headingId} className="space-y-4 border border-black/15 p-4">
      <h2 id={headingId} className="font-acumin lk-text-sm text-black">
        要対応 {attention.counts.exceptions}件・要確認 {attention.counts.reviews}件{deliveries.length > 0 ? `・配送 ${deliveryCount}件` : ''}
      </h2>

      {attention.exceptions.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-acumin lk-text-3xs tracking-widest text-[#474747]">要対応</h3>
          <ul className="divide-y divide-black/10">
            {attention.exceptions.map((item) => {
              const busy = processingIds.includes(item.id);
              const retryOrderId = item.canRetryRefund ? item.orderId : null;
              // 返品の返金の失敗は、ふつうの返金の画面ではなく、注文の返品の画面で返し直す（P21）。その処理が無い人には、ボタンを出さない
              const retry = item.refundFailure?.returnId ? onRetryReturnRefund : onRetryRefund;
              return (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0 font-acumin lk-text-3xs">
                    <p className="text-black">
                      {item.reasonLabel}
                      {item.orderNumber ? `（${item.orderNumber}）` : ''}
                    </p>
                    <p className="break-all text-[#474747]">
                      {item.paymentRef}・{formatDateTime(item.firstDetectedAt)}
                    </p>
                    {item.refundFailure ? (
                      <>
                        {item.refundFailure.amount > 0 ? (
                          <p className="text-black">{`返金 ${formatYen(item.refundFailure.amount)}`}</p>
                        ) : null}
                        <p className="text-black">{`失敗の理由: ${item.refundFailure.failureReasonLabel}`}</p>
                        {item.refundFailure.shortages.length > 0 ? (
                          <p className="text-black">
                            {`確保し直せなかった商品: ${item.refundFailure.shortages.map((shortage) => `${shortage.name} × ${shortage.quantity}`).join('、')}`}
                          </p>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {item.canCancelOrder ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="font-acumin"
                        disabled={busy}
                        onClick={() => setCancelling(item)}
                      >
                        注文を取り消して解決
                      </Button>
                    ) : null}
                    {retryOrderId !== null && retry ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="font-acumin"
                        disabled={busy}
                        onClick={() => retry(retryOrderId)}
                      >
                        もう一度返金する
                      </Button>
                    ) : null}
                    <Button
                      variant="primary"
                      size="sm"
                      className="font-acumin"
                      disabled={busy}
                      onClick={() => {
                        setNote('');
                        setResolving(item);
                      }}
                    >
                      解決済みにする
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {attention.reviews.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-acumin lk-text-3xs tracking-widest text-[#474747]">要確認</h3>
          <ul className="divide-y divide-black/10">
            {attention.reviews.map((item) => (
              <li key={item.orderId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0 font-acumin lk-text-3xs">
                  <p className="text-black">{item.reviewReasonLabel}（{item.orderNumber}）</p>
                  <p className="text-[#474747]">{formatDateTime(item.reviewMarkedAt)}</p>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  className="font-acumin"
                  disabled={processingIds.includes(item.orderId)}
                  onClick={() => onReview(item.orderId)}
                >
                  確認済みにする
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {deliveries.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-acumin lk-text-3xs tracking-widest text-[#474747]">配送</h3>
          <ul className="divide-y divide-black/10">
            {deliveries.map((item) => {
              const busy = processingIds.includes(item.id);
              return (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0 font-acumin lk-text-3xs">
                    <p className="text-black">{DELIVERY_ATTENTION_LABELS[item.kind]}</p>
                    <p className="break-all text-[#474747]">{`注文番号 ${item.orderNumber}・${item.fulfillmentNumber}回目の発送`}</p>
                    <p className="text-[#474747]">{`${formatDateTime(item.openedAt)}・${DELIVERY_STATUS_LABELS[item.status]}`}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {onOpenDeliveryHistory ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="font-acumin"
                        onClick={() => onOpenDeliveryHistory(item.orderId)}
                      >
                        履歴を開く
                      </Button>
                    ) : null}
                    {onResolveDelivery ? (
                      <Button
                        variant="primary"
                        size="sm"
                        className="font-acumin"
                        disabled={busy}
                        onClick={() => onResolveDelivery(item.id)}
                      >
                        対応済みにする
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <Dialog open={resolving !== null} onClose={() => setResolving(null)} title="解決済みにする">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!resolving) {
              return;
            }
            onResolve({ exceptionId: resolving.id, note: note.trim() });
            setResolving(null);
          }}
        >
          <p className="font-acumin lk-text-3xs text-[#474747]">
            返金やお客様への連絡を済ませてから、解決済みにしてください。
          </p>
          <TextAreaField
            label="メモ（任意・店内のみ）"
            value={note}
            rows={3}
            maxLength={ADMIN_NOTE_MAX_LENGTH}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={() => setResolving(null)}>
              戻る
            </Button>
            <Button type="submit" variant="primary" size="sm" className="w-full font-acumin">
              解決する
            </Button>
          </div>
        </form>
      </Dialog>

      <OrderCancelDialog
        open={cancelling !== null}
        title="注文を取り消して解決"
        targetLabel={cancelling?.orderNumber ?? ''}
        showNotifyOption
        noteRequired
        submitting={false}
        onClose={() => setCancelling(null)}
        onSubmit={(values) => {
          if (cancelling) {
            onCancelAndResolve({ exceptionId: cancelling.id, values });
          }
          setCancelling(null);
        }}
      />
    </section>
  );
}
