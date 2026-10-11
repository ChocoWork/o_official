'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';
import { blockEnterSubmit, useRefundSubmission } from '@/hooks/useRefundSubmission';
import {
  ADMIN_NOTE_MAX_LENGTH,
  CANCEL_REASON_LABELS,
  CANCEL_REASONS,
  type CancelReason,
} from '@/lib/orders/order-payment-types';
import { REFUND_FAILURE_MESSAGES, formatYen, refundTimingNote } from '@/lib/orders/refund/refund-messages';
import type { RefundAcceptedResponse } from '@/lib/orders/refund/refund-types';

type OrderPaidCancelDialogProps = {
  /** 開いている注文。null なら閉じている */
  orderId: string | null;
  onClose: () => void;
  /** キャンセルを受け付けた（同じ二重防止の番号の送り直しで前の結果が返った時も）。親が知らせを出して一覧を読み直す */
  onCancelled: (result: RefundAcceptedResponse) => void;
  /** 答えが分からないまま閉じた。返金が頼まれたかもしれないので、親が一覧を読み直す */
  onUncertain?: () => void;
};

type OrderPaidCancelDialogBodyProps = Omit<OrderPaidCancelDialogProps, 'orderId'> & { orderId: string };

const REASON_OPTIONS = CANCEL_REASONS.map((reason) => ({ value: reason, label: CANCEL_REASON_LABELS[reason] }));

function isCancelReason(value: string): value is CancelReason {
  return (CANCEL_REASONS as readonly string[]).includes(value);
}

/**
 * 支払い済みの注文のキャンセルの画面（グループ E-2 設計書 5-3。Shopify の「注文のキャンセル」に合わせる）。
 * 開く時に返金の材料を読み、残りの商品と送料の全額を返金してキャンセルする。注文が「キャンセル」になるのは返金が成功した時。
 * 理由は必須、メモは「その他」で必須（店内だけに残る）。お知らせと在庫に戻すは最初から入っていて、外せる。
 * 開くたびに中身を作り直す（key に注文を使う）ので、二重防止の番号も入力も開くたびに新しくなる。
 */
export default function OrderPaidCancelDialog({ orderId, onClose, onCancelled, onUncertain }: OrderPaidCancelDialogProps) {
  return orderId ? (
    <OrderPaidCancelDialogBody
      key={orderId}
      orderId={orderId}
      onClose={onClose}
      onCancelled={onCancelled}
      onUncertain={onUncertain}
    />
  ) : null;
}

function OrderPaidCancelDialogBody({ orderId, onClose, onCancelled, onUncertain }: OrderPaidCancelDialogBodyProps) {
  const flow = useRefundSubmission({
    orderId,
    submitUrl: `/api/admin/orders/${orderId}/status`,
    fallbackMessage: REFUND_FAILURE_MESSAGES.cancel,
    onAccepted: onCancelled,
    onClose,
    onUncertain,
  });
  const { materials, awaiting } = flow;
  const [reason, setReason] = useState<CancelReason | ''>('');
  const [note, setNote] = useState('');
  const [restock, setRestock] = useState(true);
  const [notifyCustomer, setNotifyCustomer] = useState(true);

  const order = materials?.order ?? null;
  const stopped = flow.busy || flow.uncertain;
  const refundable = order?.refundableAmount ?? 0;
  // 送料は、返せる送料と返せる額の小さい方（DB が全部を返す時に入れる送料と同じ。送料 ≤ 額）
  const shipping = order ? Math.min(order.refundableShipping, order.refundableAmount) : 0;
  // 未発送の全部を返すので、在庫に戻せる数（restockable）が1以上の在庫の品があれば「在庫に戻す」を出す。
  // 戻せる数が0（在庫を確保できなかった注文など）なら、DB は何も戻さないので出さない
  const showRestock = materials?.lines.some((line) => line.fulfillmentType === 'stock' && line.restockable >= 1) ?? false;
  const noteNeeded = reason === 'other';
  const canSubmit = reason !== '' && (!noteNeeded || note.trim().length > 0) && refundable >= 1 && !awaiting && !stopped;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // canSubmit は理由を選んだことを含むが、型には伝わらないので、ここでも確かめる
    if (reason === '' || !canSubmit) return;
    const memo = note.trim();
    flow.submit((requestKey) => ({
      status: 'cancelled',
      requestKey,
      reason,
      // 窓口の note は省ける。空の文字を送らない
      ...(memo ? { note: memo } : {}),
      restock,
      notifyCustomer,
    }));
  };

  return (
    <Dialog open onClose={flow.close} title="注文をキャンセルする" fullScreenOnMobile>
      <form className="space-y-3" onSubmit={handleSubmit} onKeyDown={blockEnterSubmit}>
        {!materials && !flow.loadError ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}

        {awaiting ? (
          <p className="font-acumin lk-text-sm text-black">{`確かめ中の返金があります（${formatYen(awaiting.amount)}）。`}</p>
        ) : null}

        {order && !awaiting ? (
          // 幅が 768px 以上の Dialog は高さを制限しないので、入力の部分だけを縦に動かし、誤りの文とボタンは動かさない
          <div className="space-y-3 md:max-h-[60vh] md:overflow-y-auto md:pr-1">
            <p className="font-acumin lk-text-sm text-black">{`返金する額: ${formatYen(refundable)}（全額）`}</p>
            <ul aria-label="返金の内訳" className="space-y-1 font-acumin lk-text-3xs text-[#474747]">
              <li>{`商品 ${formatYen(refundable - shipping)}`}</li>
              <li>{`送料 ${formatYen(shipping)}`}</li>
            </ul>
            <p className="font-acumin lk-text-3xs text-[#474747]">{refundTimingNote(order.paymentMethod)}</p>
            <SingleSelect
              label="取消の理由"
              required
              placeholder="選んでください"
              options={REASON_OPTIONS}
              value={reason}
              disabled={stopped}
              onChange={(event) => {
                const value = event.target.value;
                setReason(isCancelReason(value) ? value : '');
              }}
            />
            <TextAreaField
              label={noteNeeded ? 'メモ（必須・店内のみ）' : 'メモ（任意・店内のみ）'}
              value={note}
              rows={3}
              maxLength={ADMIN_NOTE_MAX_LENGTH}
              disabled={stopped}
              onChange={(event) => setNote(event.target.value)}
            />
            {showRestock ? (
              <Checkbox
                label="在庫に戻す"
                checked={restock}
                disabled={stopped}
                onChange={(event) => setRestock(event.target.checked)}
              />
            ) : null}
            <Checkbox
              label="お客様にキャンセルのお知らせを送る"
              checked={notifyCustomer}
              disabled={stopped}
              onChange={(event) => setNotifyCustomer(event.target.checked)}
            />
            <p className="font-acumin lk-text-3xs text-[#474747]">キャンセルと返金は取り消せません。</p>
          </div>
        ) : null}

        {flow.alertText ? (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {flow.alertText}
          </p>
        ) : null}

        {flow.loadError ? (
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={flow.close}>
              閉じる
            </Button>
          </div>
        ) : awaiting || flow.uncertain ? (
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={flow.busy} onClick={flow.close}>
              閉じる
            </Button>
            <Button variant="primary" size="sm" className="w-full font-acumin" disabled={flow.busy} onClick={flow.checkAgain}>
              もう一度確かめる
            </Button>
          </div>
        ) : (
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={flow.busy} onClick={flow.close}>
              戻る
            </Button>
            <Button type="submit" variant="primary" size="sm" className="w-full font-acumin" disabled={!canSubmit}>
              {`注文をキャンセルして ${formatYen(refundable)} を返金する`}
            </Button>
          </div>
        )}
      </form>
    </Dialog>
  );
}
