'use client';

// File: src/components/PurchaseOrderReceiveDialog.tsx
// 発注書の受け取り（全部・一部。G-2 Task 7 / FREQ-529）のダイアログ。数量確定済みで未納のある行ごとに、今回受け取った良品の数を入れる。
//   全部: 今回受け取った数の初期値は各行の未納で、変えられない（読み取り専用）。
//   一部: 空欄で始まり、受け取る行だけに 1〜未納 の数を入れる（空欄の行は受け取らない）。
// 受取日（初期値は今日。日本時間。発注日から今日まで）とメモ（任意・200文字まで）。POST /api/admin/purchase-orders/[id]/receipts へ送る。
// 検品で不良だった分は入力せず、未納のまま待つか、あとで打ち切る。同じ確定の再押下・通信の再送は同じ requestKey で送る
// （送る流れは usePurchaseOrderWrite）。版の競合（409）は表の文を出し、親に読み直しを頼む（ダイアログは開いたまま、入力は保つ）。
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { usePurchaseOrderWrite } from '@/hooks/usePurchaseOrderWrite';
import {
  formatNumber,
  formatPurchaseOrderLineLabel,
  isPurchaseOrderDay,
  isPurchaseOrderQuantity,
  PURCHASE_ORDER_ERRORS,
  PURCHASE_ORDER_LIMITS,
  PURCHASE_ORDER_RECEIPT_TEXT,
  PURCHASE_ORDER_TEXT,
  purchaseOrderJstDay,
  type PurchaseOrderDetail,
} from '@/lib/purchase-orders/purchase-order-types';

const HEADINGS = ['商品名', '色', 'サイズ', '発注数量', '納品済み', '未納', '今回受け取った数'] as const;
const EXCEEDS = PURCHASE_ORDER_ERRORS.GROUP_G_PO_RECEIVE_EXCEEDS_REMAINING[2];
const DATE_INVALID = PURCHASE_ORDER_ERRORS.GROUP_G_PO_RECEIVED_ON_INVALID[2];
const HEAD_CELL = 'sticky top-0 z-10 whitespace-nowrap border-b border-black/15 bg-white p-3 font-normal';
const NUMBER_CELL = 'p-3 text-right tabular-nums';
const FIELD_CLASS =
  'w-full border border-black/20 bg-white px-3 py-2 lk-text-2xs text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40';

/** all: 全部（未納の全部。変えられない）/ part: 一部（各行の良品数を入れる） */
type Mode = 'all' | 'part';

type Props = {
  /** 開いている間の発注書の詳細（版と明細）。読み直しで版や未納が変わっても、入力は保つ */
  purchaseOrder: PurchaseOrderDetail;
  mode: Mode;
  onClose: () => void;
  /** 保存できた（再送で前の結果が返った時も）。通知の文を渡す。親がダイアログを閉じて発注書を読み直す */
  onSaved: (notice: string) => void;
  /** 版が古かった。親は発注書を読み直す（このダイアログは開いたまま） */
  onStale: () => void;
};

export default function PurchaseOrderReceiveDialog({ purchaseOrder, mode, onClose, onSaved, onStale }: Props): React.JSX.Element {
  const ids = useId();
  // 開いた時の今日（日本時間）。受取日の初期値と範囲の上限
  const [today] = useState(() => purchaseOrderJstDay());
  const orderedDay = purchaseOrderJstDay(purchaseOrder.orderedAt);
  const [receivedOn, setReceivedOn] = useState(today);
  const [memo, setMemo] = useState('');
  const [entries, setEntries] = useState<Readonly<Record<string, string>>>({});
  const write = usePurchaseOrderWrite({
    url: `/api/admin/purchase-orders/${encodeURIComponent(purchaseOrder.id)}/receipts`,
    method: 'POST',
    onSaved,
    onStale,
    surface: 'receipt',
  });
  const { sending } = write;

  const receivedOnId = `${ids}-received-on`;
  const memoId = `${ids}-memo`;
  const all = mode === 'all';
  const title = all ? PURCHASE_ORDER_RECEIPT_TEXT.receiveAllTitle : PURCHASE_ORDER_RECEIPT_TEXT.receivePartTitle;
  // 受け取れるのは未納のある行だけ(並びは発注書の行の並び)
  const rows = purchaseOrder.lines
    .filter((line) => (line.outstandingQuantity ?? 0) > 0)
    .map((line) => {
      const outstanding = line.outstandingQuantity ?? 0;
      const text = (entries[line.id] ?? '').trim();
      const blank = !all && text === '';
      const wellFormed = isPurchaseOrderQuantity(text);
      const exceeds = !all && wellFormed && Number(text) > outstanding;
      const valid = all || (!blank && wellFormed && !exceeds);
      return { line, outstanding, text, blank, valid, exceeds, quantity: all ? outstanding : valid && !blank ? Number(text) : 0 };
    });
  const receiving = rows.filter((row) => !row.blank && row.valid);
  const dateValid = isPurchaseOrderDay(receivedOn) && receivedOn >= orderedDay && receivedOn <= today;
  const canSubmit = !sending && dateValid && memo.trim().length <= PURCHASE_ORDER_LIMITS.receiptMemo.max
    && receiving.length > 0 && rows.every((row) => row.blank || row.valid);
  const handleClose = write.guardClose(onClose);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSubmit) return;
    const lines = receiving.map((row) => ({ lineId: row.line.id, quantity: row.quantity }));
    const note = memo.trim();
    void write.submit(
      JSON.stringify({ receivedOn, note, lines }),
      (requestKey) => ({
        expectedVersion: purchaseOrder.version,
        receivedOn,
        ...(note === '' ? {} : { memo: note }),
        lines,
        requestKey,
      }),
      PURCHASE_ORDER_RECEIPT_TEXT.receivedNotice,
    );
  };

  return (
    <Dialog open onClose={handleClose} title={title} description={PURCHASE_ORDER_RECEIPT_TEXT.receiveNote} fullScreenOnMobile>
      <form className="space-y-3" noValidate onSubmit={handleSubmit}>
        {/* 行の表だけを縦横に動かし、受取日・メモ・誤りの文・ボタンは動かさない */}
        <div role="region" aria-label="受け取る行" tabIndex={0} className="max-h-[50vh] max-w-full overflow-auto border border-black/15 focus-visible:outline-2">
          <table aria-label="受け取る行" className="w-full min-w-[40rem] border-collapse text-left">
            <thead>
              <tr>
                {HEADINGS.map((heading, index) => (
                  <th key={heading} scope="col" className={`${HEAD_CELL} ${index >= 3 ? 'text-right' : ''}`}>{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ line, outstanding, text, valid, exceeds, quantity }) => {
                const inputId = `${ids}-quantity-${line.id}`;
                return (
                  <tr key={line.id} data-testid="purchase-order-receive-row" className="border-b border-black/10 align-top">
                    <td className="break-words p-3">{line.itemName}</td>
                    <td className="break-words p-3">{line.colorName ?? '—'}</td>
                    <td className="break-words p-3">{line.sizeLabel ?? '—'}</td>
                    <td className={NUMBER_CELL}>{line.orderQuantity === null ? '—' : formatNumber(line.orderQuantity)}</td>
                    <td className={NUMBER_CELL}>{formatNumber(line.receivedQuantity)}</td>
                    <td className={NUMBER_CELL}>{formatNumber(outstanding)}</td>
                    <td className="p-3">
                      <input
                        id={inputId}
                        type="number"
                        inputMode="numeric"
                        aria-label={`${formatPurchaseOrderLineLabel(line)} の今回受け取った数`}
                        min={PURCHASE_ORDER_LIMITS.receivedQuantity.min}
                        max={outstanding}
                        step={1}
                        value={all ? String(quantity) : (entries[line.id] ?? '')}
                        readOnly={all}
                        disabled={sending}
                        aria-invalid={!valid}
                        onChange={(event) => setEntries((current) => ({ ...current, [line.id]: event.target.value }))}
                        className={`${FIELD_CLASS} w-28 text-right tabular-nums`}
                      />
                      {!valid && text !== '' ? <p role="alert" className="mt-1 lk-text-2xs text-red-600">{exceeds ? EXCEEDS : PURCHASE_ORDER_TEXT.invalidInput}</p> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="space-y-1">
          <label htmlFor={receivedOnId} className="block lk-text-2xs">受取日</label>
          <input
            id={receivedOnId}
            type="date"
            required
            min={orderedDay}
            max={today}
            value={receivedOn}
            disabled={sending}
            aria-invalid={!dateValid}
            onChange={(event) => setReceivedOn(event.target.value)}
            className={`${FIELD_CLASS} w-48`}
          />
          {!dateValid ? <p role="alert" className="lk-text-2xs text-red-600">{DATE_INVALID}</p> : null}
        </div>
        <div className="space-y-1">
          <label htmlFor={memoId} className="block lk-text-2xs">メモ</label>
          <textarea
            id={memoId}
            rows={2}
            maxLength={PURCHASE_ORDER_LIMITS.receiptMemo.max}
            value={memo}
            disabled={sending}
            onChange={(event) => setMemo(event.target.value)}
            className={FIELD_CLASS}
          />
        </div>
        {write.error !== null ? <p role="alert" className="lk-text-2xs text-red-600">{write.error}</p> : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={!canSubmit}>{PURCHASE_ORDER_RECEIPT_TEXT.receiveSubmit}</Button>
          <Button type="button" variant="secondary" disabled={sending} onClick={handleClose}>戻る</Button>
        </div>
      </form>
    </Dialog>
  );
}
