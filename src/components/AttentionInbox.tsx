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

type AttentionInboxProps = {
  attention: OrderAttention | null;
  /** 操作中の要対応 ID・注文 ID。ボタンを押せなくする */
  processingIds: string[];
  onReview: (orderId: string) => void;
  onResolve: (input: { exceptionId: string; note: string }) => void;
  onCancelAndResolve: (input: { exceptionId: string; values: OrderCancelValues }) => void;
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
}: AttentionInboxProps) {
  const headingId = useId();
  const [resolving, setResolving] = useState<AttentionException | null>(null);
  const [cancelling, setCancelling] = useState<AttentionException | null>(null);
  const [note, setNote] = useState('');

  if (!attention || (attention.exceptions.length === 0 && attention.reviews.length === 0)) {
    return null;
  }

  return (
    <section aria-labelledby={headingId} className="space-y-4 border border-black/15 p-4">
      <h2 id={headingId} className="font-acumin lk-text-sm text-black">
        要対応 {attention.counts.exceptions}件・要確認 {attention.counts.reviews}件
      </h2>

      {attention.exceptions.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-acumin lk-text-3xs tracking-widest text-[#474747]">要対応</h3>
          <ul className="divide-y divide-black/10">
            {attention.exceptions.map((item) => {
              const busy = processingIds.includes(item.id);
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
            Stripe ダッシュボードで返金などを済ませてから、解決済みにしてください。
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
