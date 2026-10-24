'use client';

// File: src/components/PurchaseOrderQuantityDialog.tsx
// 発注書の数量の確定（段階が数量確定待ち）と訂正（確定後）のダイアログ（G-2 Task 6 / FREQ-527）。
// 行ごとに数量と単価（空欄は「単価未登録」、0 は 0 円）を入れ、POST /api/admin/purchase-orders/[id]/quantities へ全行を一度に送る。
// 訂正は理由が必須。納品済み未満の数量は送れない（行の下に文を出す）。同じ確定の再押下・通信の再送は同じ requestKey で送る
// （送る流れは usePurchaseOrderWrite）。版の競合（409）は表の文を出し、親に読み直しを頼む（ダイアログは開いたまま、入力は保つ）。
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { usePurchaseOrderWrite } from '@/hooks/usePurchaseOrderWrite';
import {
  formatPurchaseOrderLineLabel,
  PURCHASE_ORDER_ACTION_TEXT,
  PURCHASE_ORDER_ERRORS,
  PURCHASE_ORDER_LIMITS,
  type PurchaseOrderDetail,
} from '@/lib/purchase-orders/purchase-order-types';

const QUANTITY_PATTERN = /^(0|[1-9][0-9]{0,4})$/;
const PRICE_PATTERN = /^(0|[1-9][0-9]{0,6})$/;
const PRICE_HELP = '未入力は「単価未登録」、0 は 0 円として保存します。';
const BELOW_RECEIVED = PURCHASE_ORDER_ERRORS.GROUP_G_PO_QUANTITY_BELOW_RECEIVED[2];
const FIELD_CLASS =
  'w-full border border-black/20 bg-white px-3 py-2 lk-text-2xs text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40';

type Props = {
  /** 開いている間の発注書の詳細（版と明細）。読み直しで版や納品済みが変わっても、入力は保つ */
  purchaseOrder: PurchaseOrderDetail;
  onClose: () => void;
  /** 保存できた（再送で前の結果が返った時も）。通知の文を渡す。親がダイアログを閉じて発注書を読み直す */
  onSaved: (notice: string) => void;
  /** 版が古かった。親は発注書を読み直す（このダイアログは開いたまま） */
  onStale: () => void;
};

type Fields = { quantity: string; price: string };

const EMPTY: Fields = { quantity: '', price: '' };

export default function PurchaseOrderQuantityDialog({ purchaseOrder, onClose, onSaved, onStale }: Props): React.JSX.Element {
  const ids = useId();
  const [fields, setFields] = useState<Readonly<Record<string, Fields>>>(() => Object.fromEntries(
    purchaseOrder.lines.map((line) => [line.id, {
      quantity: String(line.orderQuantity ?? line.provisionalQuantity),
      price: line.unitPriceYen === null ? '' : String(line.unitPriceYen),
    }]),
  ));
  const [reason, setReason] = useState('');
  const write = usePurchaseOrderWrite({
    url: `/api/admin/purchase-orders/${encodeURIComponent(purchaseOrder.id)}/quantities`,
    method: 'POST',
    onSaved,
    onStale,
  });
  const { sending } = write;

  const confirming = purchaseOrder.stage === 'ordered';
  const helpId = `${ids}-help`;
  const reasonId = `${ids}-reason`;
  const rows = purchaseOrder.lines.map((line) => {
    const value = fields[line.id] ?? EMPTY;
    const quantityValid = QUANTITY_PATTERN.test(value.quantity);
    return {
      line,
      value,
      quantityValid,
      priceValid: value.price === '' || PRICE_PATTERN.test(value.price),
      belowReceived: quantityValid && Number(value.quantity) < line.receivedQuantity,
    };
  });
  const canSubmit = !sending
    && rows.every((row) => row.quantityValid && row.priceValid && !row.belowReceived)
    && (confirming || reason.trim() !== '');

  const handleClose = write.guardClose(onClose);

  const setField = (lineId: string, change: Partial<Fields>): void => {
    setFields((current) => ({ ...current, [lineId]: { ...(current[lineId] ?? EMPTY), ...change } }));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSubmit) return;
    const lines = rows.map((row) => ({
      lineId: row.line.id,
      quantity: Number(row.value.quantity),
      unitPriceYen: row.value.price === '' ? null : Number(row.value.price),
    }));
    const note = reason.trim();
    void write.submit(
      JSON.stringify({ lines, reason: note }),
      (requestKey) => ({
        expectedVersion: purchaseOrder.version,
        lines,
        ...(note === '' ? {} : { reason: note }),
        requestKey,
      }),
      confirming ? PURCHASE_ORDER_ACTION_TEXT.quantitiesConfirmedNotice : PURCHASE_ORDER_ACTION_TEXT.quantitiesCorrectedNotice,
    );
  };

  return (
    <Dialog open onClose={handleClose} title={confirming ? '数量の確定' : '数量の訂正'} fullScreenOnMobile>
      <form className="space-y-3" noValidate onSubmit={handleSubmit}>
        <p id={helpId} className="lk-text-2xs text-[#474747]">{PRICE_HELP}</p>
        {/* 幅が 768px 以上の Dialog は高さを制限しないので、行の一覧だけを縦に動かし、誤りの文とボタンは動かさない */}
        <ul className="space-y-4 md:max-h-[60vh] md:overflow-y-auto md:pr-1">
          {rows.map(({ line, value, quantityValid, priceValid, belowReceived }) => {
            const nameId = `${ids}-name-${line.id}`;
            const quantityId = `${ids}-quantity-${line.id}`;
            const priceId = `${ids}-price-${line.id}`;
            return (
              <li key={line.id} data-testid="purchase-order-quantity-row" className="space-y-2">
                <p id={nameId} className="break-words">{formatPurchaseOrderLineLabel(line)}</p>
                <div className="flex flex-wrap gap-3">
                  <div className="space-y-1">
                    <label htmlFor={quantityId} className="block lk-text-2xs">数量</label>
                    <input
                      id={quantityId}
                      type="number"
                      inputMode="numeric"
                      min={PURCHASE_ORDER_LIMITS.confirmedQuantity.min}
                      max={PURCHASE_ORDER_LIMITS.confirmedQuantity.max}
                      step={1}
                      value={value.quantity}
                      disabled={sending}
                      aria-describedby={nameId}
                      aria-invalid={!quantityValid || belowReceived}
                      onChange={(event) => setField(line.id, { quantity: event.target.value })}
                      className={`${FIELD_CLASS} w-28 text-right tabular-nums`}
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={priceId} className="block lk-text-2xs">単価（円）</label>
                    <input
                      id={priceId}
                      type="number"
                      inputMode="numeric"
                      min={PURCHASE_ORDER_LIMITS.unitPriceYen.min}
                      max={PURCHASE_ORDER_LIMITS.unitPriceYen.max}
                      step={1}
                      value={value.price}
                      disabled={sending}
                      aria-describedby={`${nameId} ${helpId}`}
                      aria-invalid={!priceValid}
                      onChange={(event) => setField(line.id, { price: event.target.value })}
                      className={`${FIELD_CLASS} w-36 text-right tabular-nums`}
                    />
                  </div>
                </div>
                {belowReceived ? <p role="alert" className="lk-text-2xs text-red-600">{BELOW_RECEIVED}</p> : null}
              </li>
            );
          })}
        </ul>
        <div className="space-y-1">
          <label htmlFor={reasonId} className="block lk-text-2xs">{confirming ? '理由（任意）' : '理由'}</label>
          <textarea
            id={reasonId}
            rows={3}
            required={!confirming}
            maxLength={PURCHASE_ORDER_LIMITS.reason.max}
            value={reason}
            disabled={sending}
            onChange={(event) => setReason(event.target.value)}
            className={FIELD_CLASS}
          />
        </div>
        {write.error !== null ? <p role="alert" className="lk-text-2xs text-red-600">{write.error}</p> : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={!canSubmit}>確定する</Button>
          <Button type="button" variant="secondary" disabled={sending} onClick={handleClose}>戻る</Button>
        </div>
      </form>
    </Dialog>
  );
}
