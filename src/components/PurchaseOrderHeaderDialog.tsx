'use client';

// File: src/components/PurchaseOrderHeaderDialog.tsx
// 発注先・メモの訂正のダイアログ（G-2 Task 6 / FREQ-527）。理由が必須。PATCH /api/admin/purchase-orders/[id] へ送る。
// 発注書の詳細（PurchaseOrderDetailSection）が開く。数量・打切り・受け取りのダイアログと同じく、1 つのファイルに分けてある。
import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { usePurchaseOrderWrite } from '@/hooks/usePurchaseOrderWrite';
import {
  PURCHASE_ORDER_ACTION_TEXT,
  PURCHASE_ORDER_LIMITS,
  type PurchaseOrderDetail,
} from '@/lib/purchase-orders/purchase-order-types';

const FIELD_CLASS =
  'w-full border border-black/20 bg-white px-3 py-2 lk-text-2xs text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40';

/**
 * 発注先・メモの訂正（理由が必須）。PATCH /api/admin/purchase-orders/[id] へ送る。メモを空にすると memo を送らず、メモが空になる。
 * 送る流れは usePurchaseOrderWrite（同じ内容の再押下は同じ requestKey、版の競合は表の文を出して親に読み直しを頼み、入力は保つ）。
 */
export default function PurchaseOrderHeaderDialog({ purchaseOrder, onClose, onSaved, onStale }: {
  purchaseOrder: PurchaseOrderDetail;
  onClose: () => void;
  onSaved: (notice: string) => void;
  onStale: () => void;
}): React.JSX.Element {
  const ids = useId();
  const [supplierName, setSupplierName] = useState(purchaseOrder.supplierName);
  const [memo, setMemo] = useState(purchaseOrder.memo ?? '');
  const [reason, setReason] = useState('');
  const write = usePurchaseOrderWrite({
    url: `/api/admin/purchase-orders/${encodeURIComponent(purchaseOrder.id)}`,
    method: 'PATCH',
    onSaved,
    onStale,
  });
  const supplierId = `${ids}-supplier`;
  const memoId = `${ids}-memo`;
  const reasonId = `${ids}-reason`;
  const canSubmit = !write.sending && supplierName.trim() !== '' && reason.trim() !== '';
  const handleClose = write.guardClose(onClose);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSubmit) return;
    const supplier = supplierName.trim();
    const note = memo.trim();
    const why = reason.trim();
    void write.submit(
      JSON.stringify({ supplier, note, why }),
      (requestKey) => ({
        expectedVersion: purchaseOrder.version,
        supplierName: supplier,
        ...(note === '' ? {} : { memo: note }),
        reason: why,
        requestKey,
      }),
      PURCHASE_ORDER_ACTION_TEXT.headerCorrectedNotice,
    );
  };

  return (
    <Dialog open onClose={handleClose} title="発注先・メモの訂正" fullScreenOnMobile>
      <form className="space-y-3" noValidate onSubmit={handleSubmit}>
        <div className="space-y-1">
          <label htmlFor={supplierId} className="block lk-text-2xs">発注先</label>
          <input
            id={supplierId}
            type="text"
            required
            maxLength={PURCHASE_ORDER_LIMITS.supplierName.max}
            value={supplierName}
            disabled={write.sending}
            onChange={(event) => setSupplierName(event.target.value)}
            className={FIELD_CLASS}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={memoId} className="block lk-text-2xs">メモ</label>
          <textarea
            id={memoId}
            rows={3}
            maxLength={PURCHASE_ORDER_LIMITS.memo.max}
            value={memo}
            disabled={write.sending}
            onChange={(event) => setMemo(event.target.value)}
            className={FIELD_CLASS}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={reasonId} className="block lk-text-2xs">理由</label>
          <textarea
            id={reasonId}
            rows={3}
            required
            maxLength={PURCHASE_ORDER_LIMITS.reason.max}
            value={reason}
            disabled={write.sending}
            onChange={(event) => setReason(event.target.value)}
            className={FIELD_CLASS}
          />
        </div>
        {write.error !== null ? <p role="alert" className="lk-text-2xs text-red-600">{write.error}</p> : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={!canSubmit}>訂正する</Button>
          <Button type="button" variant="secondary" disabled={write.sending} onClick={handleClose}>戻る</Button>
        </div>
      </form>
    </Dialog>
  );
}
