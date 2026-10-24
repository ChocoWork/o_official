'use client';

// File: src/components/PurchaseOrderShortCloseDialog.tsx
// 残りの打切り（数量確定後。選んだ行の未納を 0 にする）と、発注の取消（数量確定前。全行を 0 にして完了にする）のダイアログ
// （G-2 Task 6 / FREQ-528）。どちらも同じ POST /api/admin/purchase-orders/[id]/short-closures に行の id を渡す
// （取消は発注書の全行を渡す）。入庫・台帳・割当は動かさない。理由が必須。
// 同じ操作の再押下・通信の再送は同じ requestKey で送る（送る流れは usePurchaseOrderWrite）。
// 版の競合（409）は表の文を出し、親に読み直しを頼む（開いたまま、理由は保つ）。
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { usePurchaseOrderWrite } from '@/hooks/usePurchaseOrderWrite';
import {
  formatPurchaseOrderLineLabel,
  PURCHASE_ORDER_ACTION_TEXT,
  PURCHASE_ORDER_LIMITS,
  type PurchaseOrderDetail,
} from '@/lib/purchase-orders/purchase-order-types';

const FIELD_CLASS =
  'w-full border border-black/20 bg-white px-3 py-2 lk-text-2xs text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40';

/** close: 数量確定後に選んだ行の残りを打ち切る / cancel: 数量確定前に全行を 0 にして発注を取り消す */
type Mode = 'close' | 'cancel';

const TEXT: Record<Mode, { title: string; description: string; submit: string; notice: string }> = {
  close: {
    title: '残りを打ち切る',
    description: '入庫は起こりません。打ち切った数は発注数量から引かれ、発注必要数が増えることがあります。',
    submit: '打ち切る',
    notice: PURCHASE_ORDER_ACTION_TEXT.shortClosedNotice,
  },
  cancel: {
    title: '発注の取消',
    description: '数量は確定していないため、全ての行を 0 にして完了にします。入庫は起こりません。',
    submit: '取り消す',
    notice: PURCHASE_ORDER_ACTION_TEXT.cancelledNotice,
  },
};

type Props = {
  /** 開いている間の発注書の詳細（版と明細）。読み直しで版や未納が変わっても、理由は保つ */
  purchaseOrder: PurchaseOrderDetail;
  mode: Mode;
  /** mode が close の時に打ち切る行の id（未納のある行）。cancel では使わず、常に発注書の全行を渡す */
  lineIds: readonly string[];
  onClose: () => void;
  /** 保存できた（再送で前の結果が返った時も）。通知の文を渡す。親がダイアログを閉じて発注書を読み直す */
  onSaved: (notice: string) => void;
  /** 版が古かった。親は発注書を読み直す（このダイアログは開いたまま） */
  onStale: () => void;
};

export default function PurchaseOrderShortCloseDialog({ purchaseOrder, mode, lineIds, onClose, onSaved, onStale }: Props): React.JSX.Element {
  const ids = useId();
  const [reason, setReason] = useState('');
  const write = usePurchaseOrderWrite({
    url: `/api/admin/purchase-orders/${encodeURIComponent(purchaseOrder.id)}/short-closures`,
    method: 'POST',
    onSaved,
    onStale,
  });
  const { sending } = write;

  const text = TEXT[mode];
  const reasonId = `${ids}-reason`;
  // 並びは発注書の行の並び。cancel は全行
  const targets = mode === 'cancel' ? purchaseOrder.lines : purchaseOrder.lines.filter((line) => lineIds.includes(line.id));
  const canSubmit = !sending && reason.trim() !== '' && targets.length > 0;
  const handleClose = write.guardClose(onClose);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSubmit) return;
    const note = reason.trim();
    const targetIds = targets.map((line) => line.id);
    void write.submit(
      JSON.stringify({ lineIds: targetIds, reason: note }),
      (requestKey) => ({ expectedVersion: purchaseOrder.version, lineIds: targetIds, reason: note, requestKey }),
      text.notice,
    );
  };

  return (
    <Dialog open onClose={handleClose} title={text.title} description={text.description} fullScreenOnMobile>
      <form className="space-y-3" noValidate onSubmit={handleSubmit}>
        {mode === 'close' ? (
          <ul className="space-y-2 md:max-h-[40vh] md:overflow-y-auto md:pr-1">
            {targets.map((line) => (
              <li key={line.id} data-testid="purchase-order-close-row" className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                <span className="break-words">{formatPurchaseOrderLineLabel(line)}</span>
                <span className="tabular-nums">{`未納 ${line.outstandingQuantity ?? 0} → 0`}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="space-y-1">
          <label htmlFor={reasonId} className="block lk-text-2xs">理由</label>
          <textarea
            id={reasonId}
            rows={3}
            required
            maxLength={PURCHASE_ORDER_LIMITS.reason.max}
            value={reason}
            disabled={sending}
            onChange={(event) => setReason(event.target.value)}
            className={FIELD_CLASS}
          />
        </div>
        {write.error !== null ? <p role="alert" className="lk-text-2xs text-red-600">{write.error}</p> : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={!canSubmit}>{text.submit}</Button>
          <Button type="button" variant="secondary" disabled={sending} onClick={handleClose}>戻る</Button>
        </div>
      </form>
    </Dialog>
  );
}
