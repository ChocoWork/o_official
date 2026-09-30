'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';
import {
  ADMIN_NOTE_MAX_LENGTH,
  CANCEL_REASON_LABELS,
  CANCEL_REASONS,
  type CancelReason,
} from '@/lib/orders/order-payment-types';

export type OrderCancelValues = {
  reason: CancelReason;
  note: string;
  notifyCustomer: boolean;
};

type OrderCancelDialogProps = {
  open: boolean;
  /** 「注文を取り消す」または「注文を取り消して解決」 */
  title: string;
  /** 取り消す注文の目印（注文番号など） */
  targetLabel: string;
  /** お知らせの選択肢を出すか。失敗の注文の取消では出さない（期限切れで知らせ済み） */
  showNotifyOption: boolean;
  /** 要対応の解決ではメモ必須 */
  noteRequired: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (values: OrderCancelValues) => void;
};

const REASON_OPTIONS = CANCEL_REASONS.map((reason) => ({ value: reason, label: CANCEL_REASON_LABELS[reason] }));

function isCancelReason(value: string): value is CancelReason {
  return (CANCEL_REASONS as readonly string[]).includes(value);
}

/**
 * 取消の画面（設計書 5-2。Shopify の取消画面に合わせる。2026-09-27 承認）。
 * 理由は必須。メモは「その他」と要対応の解決で必須（店内だけに残る）。
 * お知らせは既定でオン、外せる。在庫は常に戻すので選択肢を置かない。
 */
export default function OrderCancelDialog({
  open,
  title,
  targetLabel,
  showNotifyOption,
  noteRequired,
  submitting,
  onClose,
  onSubmit,
}: OrderCancelDialogProps) {
  const [reason, setReason] = useState<CancelReason | ''>('');
  const [note, setNote] = useState('');
  const [notifyCustomer, setNotifyCustomer] = useState(true);

  // 開くたびに既定へ戻す（理由は未選択、お知らせはオン）
  useEffect(() => {
    if (open) {
      setReason('');
      setNote('');
      setNotifyCustomer(true);
    }
  }, [open]);

  const noteNeeded = noteRequired || reason === 'other';
  const canSubmit = reason !== '' && (!noteNeeded || note.trim().length > 0) && !submitting;

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          // canSubmit は理由を選んだことを含むので、この後の reason は CancelReason に絞られる
          if (!canSubmit) {
            return;
          }
          onSubmit({ reason, note: note.trim(), notifyCustomer: showNotifyOption && notifyCustomer });
        }}
      >
        <p className="font-acumin lk-text-3xs text-[#474747]">{targetLabel}</p>
        <SingleSelect
          label="取消の理由"
          required
          placeholder="選んでください"
          options={REASON_OPTIONS}
          value={reason}
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
          onChange={(event) => setNote(event.target.value)}
        />
        {showNotifyOption ? (
          <Checkbox
            label="お客様に取消のお知らせを送る"
            checked={notifyCustomer}
            onChange={(event) => setNotifyCustomer(event.target.checked)}
          />
        ) : null}
        <p className="font-acumin lk-text-3xs text-[#474747]">確保した在庫は戻ります。</p>
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
            戻る
          </Button>
          <Button type="submit" variant="primary" size="sm" className="w-full font-acumin" disabled={!canSubmit}>
            {submitting ? '処理中...' : '取り消す'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
