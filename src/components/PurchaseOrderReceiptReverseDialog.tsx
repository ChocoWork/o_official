'use client';

// File: src/components/PurchaseOrderReceiptReverseDialog.tsx
// 受け取りの取消と数量訂正（同じ操作。G-2 Task 7 / FREQ-529）のダイアログ。相殺の受取を追記して納品済み・未納を戻す。
//   取消: 受取の各行を、取り消せる数ぜんぶ（変えられない）。 訂正: 空欄で始まり、取り消す行だけに 1〜取り消せる数 を入れる。
// 理由が必須。受け取りで入った在庫は、まず空き在庫から減らし、足りなければ支払い済みの注文の割当を新しい注文から外す。
// 外す割当があると最初の送信は 409 になる（書込み0件）。その時は「確認の段」に移り、外す点数を本文で見せる。
// 確認の後は新しい requestKey と expectedReleaseQuantity（その点数）で送り直し、数が変わっていれば再び 409 で確認を出し直す
// （同じ確定送信の通信の再送だけが同じ requestKey と本文を使う。送る流れは usePurchaseOrderWrite）。
// 確認を求められた時に外す点数が 0 になっていたら（空き在庫が増えた等）確認は要らないので、確認の段は出さず、確認の数なしで送り直す。
// 取り消す数が空き在庫と外せる割当の合計を超える断りは表の文を出し、入力は保つ。版の競合（409）は表の文を出して親に読み直しを頼む。
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { usePurchaseOrderWrite } from '@/hooks/usePurchaseOrderWrite';
import {
  formatNumber,
  formatPurchaseOrderLineLabel,
  formatPurchaseOrderReleaseConfirmation,
  isPurchaseOrderQuantity,
  PURCHASE_ORDER_ERRORS,
  PURCHASE_ORDER_LIMITS,
  PURCHASE_ORDER_RECEIPT_TEXT,
  PURCHASE_ORDER_TEXT,
  type PurchaseOrderDetail,
  type PurchaseOrderReceipt,
} from '@/lib/purchase-orders/purchase-order-types';

const EXCEEDS = PURCHASE_ORDER_ERRORS.GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED[2];
const FIELD_CLASS =
  'w-full border border-black/20 bg-white px-3 py-2 lk-text-2xs text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40';

/** cancel: 受取の全ての行を取り消せる数ぜんぶ / correct: 一部の行を一部の数 */
type Mode = 'cancel' | 'correct';

const TEXT: Record<Mode, { title: string; submit: string; notice: string }> = {
  cancel: {
    title: PURCHASE_ORDER_RECEIPT_TEXT.reverseTitle,
    submit: PURCHASE_ORDER_RECEIPT_TEXT.reverseSubmit,
    notice: PURCHASE_ORDER_RECEIPT_TEXT.reversedNotice,
  },
  correct: {
    title: PURCHASE_ORDER_RECEIPT_TEXT.correctTitle,
    submit: PURCHASE_ORDER_RECEIPT_TEXT.correctSubmit,
    notice: PURCHASE_ORDER_RECEIPT_TEXT.correctedNotice,
  },
};

type Props = {
  /** 開いている間の発注書の詳細（版と明細）。読み直しで版や取り消せる数が変わっても、入力は保つ */
  purchaseOrder: PurchaseOrderDetail;
  /** 取り消す受取（kind が receive の物。取り消せる数が残る行だけを並べる） */
  receipt: PurchaseOrderReceipt;
  mode: Mode;
  onClose: () => void;
  /** 保存できた（再送で前の結果が返った時も）。通知の文を渡す。親がダイアログを閉じて発注書を読み直す */
  onSaved: (notice: string) => void;
  /** 版が古かった。親は発注書を読み直す（このダイアログは開いたまま） */
  onStale: () => void;
};

export default function PurchaseOrderReceiptReverseDialog({ purchaseOrder, receipt, mode, onClose, onSaved, onStale }: Props): React.JSX.Element {
  const ids = useId();
  const [entries, setEntries] = useState<Readonly<Record<string, string>>>({});
  const [reason, setReason] = useState('');
  // 確認の段: 外す割当の点数(窓口が 409 で返した数)。null の間は最初の入力の段
  const [confirmation, setConfirmation] = useState<number | null>(null);
  const [reasonMissing, setReasonMissing] = useState(false);
  const write = usePurchaseOrderWrite({
    url: `/api/admin/purchase-orders/${encodeURIComponent(purchaseOrder.id)}/receipts/${encodeURIComponent(receipt.id)}/reversals`,
    method: 'POST',
    onSaved,
    onStale,
    surface: 'receipt',
    confirmsRelease: true,
  });
  const { sending } = write;

  const text = TEXT[mode];
  const cancel = mode === 'cancel';
  const reasonId = `${ids}-reason`;
  const lineById = new Map(purchaseOrder.lines.map((line) => [line.id, line]));
  // 取り消せる数が残る行だけ(相殺の行は取り消せる数が 0)。並びは受取の行の並び
  const rows = receipt.lines
    .filter((line) => line.quantity > 0 && line.reversibleQuantity > 0)
    .map((line) => {
      const entry = (entries[line.id] ?? '').trim();
      const blank = !cancel && entry === '';
      const wellFormed = isPurchaseOrderQuantity(entry);
      const exceeds = !cancel && wellFormed && Number(entry) > line.reversibleQuantity;
      const valid = cancel || (!blank && wellFormed && !exceeds);
      return { line, entry, blank, exceeds, valid, quantity: cancel ? line.reversibleQuantity : valid && !blank ? Number(entry) : 0 };
    });
  const chosen = rows.filter((row) => !row.blank && row.valid);
  const inputsValid = chosen.length > 0 && rows.every((row) => row.blank || row.valid);
  // 確認の段では理由が空でも押せる(押すと「理由を入力してください。」を出す)。最初の段は理由が入るまで押せない
  const canSubmit = !sending && inputsValid && (confirmation !== null || reason.trim() !== '');
  const handleClose = write.guardClose(onClose);

  /**
   * expected は確認した外す点数(最初の送信は null)。窓口が外す割当の確認を求めたら確認の段に移る。
   * ただし外す点数が 0 になっていた時(空き在庫が増えた等)は確認が要らないので、確認の数なしで送り直す(「0点外す」とは見せない)。
   */
  const send = async (why: string, expected: number | null): Promise<void> => {
    const lines = chosen.map((row) => ({ receiptLineId: row.line.id, quantity: row.quantity }));
    const released = await write.submit(
      JSON.stringify({ receiptId: receipt.id, lines, why, expected }),
      (requestKey) => ({
        expectedVersion: purchaseOrder.version,
        lines,
        reason: why,
        ...(expected === null ? {} : { expectedReleaseQuantity: expected }),
        requestKey,
      }),
      text.notice,
    );
    if (released === null) return;
    if (released === 0) {
      setConfirmation(null);
      if (expected !== null) await send(why, null);
      return;
    }
    setReasonMissing(false);
    setConfirmation(released);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSubmit) return;
    const why = reason.trim();
    if (why === '') {
      setReasonMissing(true);
      return;
    }
    void send(why, confirmation);
  };

  return (
    <Dialog open onClose={handleClose} title={text.title} description={PURCHASE_ORDER_RECEIPT_TEXT.reverseNote} fullScreenOnMobile>
      <form className="space-y-3" noValidate onSubmit={handleSubmit}>
        {/* 幅が 768px 以上の Dialog は高さを制限しないので、行の一覧だけを縦に動かし、誤りの文とボタンは動かさない */}
        <ul className="space-y-4 md:max-h-[50vh] md:overflow-y-auto md:pr-1">
          {rows.map(({ line, entry, exceeds, valid, quantity }) => {
            const orderLine = lineById.get(line.lineId);
            const nameId = `${ids}-name-${line.id}`;
            const quantityId = `${ids}-quantity-${line.id}`;
            return (
              <li key={line.id} data-testid="purchase-order-reverse-row" className="space-y-2">
                <p id={nameId} className="break-words">{orderLine ? formatPurchaseOrderLineLabel(orderLine) : '—'}</p>
                <div className="flex flex-wrap items-end gap-3">
                  <p className="lk-text-2xs tabular-nums">{`取り消せる数 ${formatNumber(line.reversibleQuantity)}`}</p>
                  <div className="space-y-1">
                    <label htmlFor={quantityId} className="block lk-text-2xs">取り消す数</label>
                    <input
                      id={quantityId}
                      type="number"
                      inputMode="numeric"
                      min={PURCHASE_ORDER_LIMITS.receivedQuantity.min}
                      max={line.reversibleQuantity}
                      step={1}
                      value={cancel ? String(quantity) : (entries[line.id] ?? '')}
                      readOnly={cancel}
                      disabled={sending || confirmation !== null}
                      aria-describedby={nameId}
                      aria-invalid={!valid}
                      onChange={(event) => setEntries((current) => ({ ...current, [line.id]: event.target.value }))}
                      className={`${FIELD_CLASS} w-28 text-right tabular-nums`}
                    />
                  </div>
                </div>
                {!valid && entry !== '' ? <p role="alert" className="lk-text-2xs text-red-600">{exceeds ? EXCEEDS : PURCHASE_ORDER_TEXT.invalidInput}</p> : null}
              </li>
            );
          })}
        </ul>
        <div className="space-y-1">
          <label htmlFor={reasonId} className="block lk-text-2xs">理由</label>
          <textarea
            id={reasonId}
            rows={3}
            required
            maxLength={PURCHASE_ORDER_LIMITS.reason.max}
            value={reason}
            disabled={sending}
            onChange={(event) => {
              setReason(event.target.value);
              setReasonMissing(false);
            }}
            className={FIELD_CLASS}
          />
        </div>
        {confirmation !== null ? (
          <p role="status" data-testid="purchase-order-release-confirmation" className="lk-text-2xs">{formatPurchaseOrderReleaseConfirmation(confirmation)}</p>
        ) : null}
        {reasonMissing ? <p role="alert" className="lk-text-2xs text-red-600">{PURCHASE_ORDER_RECEIPT_TEXT.reasonRequired}</p> : null}
        {write.error !== null ? <p role="alert" className="lk-text-2xs text-red-600">{write.error}</p> : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={!canSubmit}>{text.submit}</Button>
          {/* 確認の段の「戻る」は入力の段に戻る(入力は保つ)。入力の段の「戻る」は閉じる */}
          <Button type="button" variant="secondary" disabled={sending} onClick={confirmation === null ? handleClose : () => setConfirmation(null)}>戻る</Button>
        </div>
      </form>
    </Dialog>
  );
}
