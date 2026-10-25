'use client';

// File: src/components/ShipmentSlipCancelDialog.tsx
// 確定済みの発送票を全体で取り消すダイアログ（G-3 Task 6 / FREQ-533-AC-04・FREQ-534-AC-03）。
// 票に含まれるすべての注文の発送を取り消し、品物を発送準備中に戻す（割当の消費を1回だけ戻す）。
// 返品・発送後の返金・取り消せない状態の注文があれば DB が全体を断り、票は変わらない。断りの本文は表の文をダイアログの中に出す。
// cancelBlockers を持つ票は、ボタンの上に理由を注文番号つきで先に出す。
// 送る流れは useShipmentSlipWrite（送信中は閉じず二重に送らない。同じ内容の再押下・再送は同じ requestKey。結果不明は「もう一度確かめる」）。
// 断られた時（版の競合を含む）は開いたまま親に読み直しを頼む。
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { useShipmentSlipWrite } from '@/hooks/useShipmentSlipWrite';
import { toOrderNumber } from '@/lib/orders/order-number';
import { submitSlipCancel } from '@/lib/orders/shipment-slips/shipment-slip-client';
import { formatCancelBlocker, SHIPMENT_SLIP_TEXT, type ShipmentSlipDetail } from '@/lib/orders/shipment-slips/shipment-slip-types';
import { DELIVERY_FORM_TEXT } from '@/lib/orders/tracking/delivery-client';

type Props = {
  /** 開いている間の票（id・版・取消を止める理由）。読み直しで版や理由が変わっても、このダイアログは開いたまま */
  slip: Pick<ShipmentSlipDetail, 'id' | 'version' | 'cancelBlockers'>;
  onClose: () => void;
  /** 取り消せた（再送で前の結果が返った時も）。親がダイアログを閉じて通知を出し、票を読み直す */
  onCancelled: () => void;
  /** DB に断られた、または結果が分からないまま戻る。親は票を読み直す（断られた時はこのダイアログは開いたまま） */
  onStale: () => void;
};

export default function ShipmentSlipCancelDialog({ slip, onClose, onCancelled, onStale }: Props): React.JSX.Element {
  const write = useShipmentSlipWrite();
  const { sending, uncertain } = write;

  /** 送っている間は閉じない。結果が分からないまま閉じる時は、記録されたかもしれないので親に読み直しを頼む */
  const close = (): void => {
    if (sending) return;
    if (uncertain) {
      write.forget();
      onStale();
    }
    onClose();
  };

  const submit = (): void => {
    write.run(
      `cancel:${slip.version}`,
      (requestKey) => submitSlipCancel(slip.id, { expectedVersion: slip.version, requestKey }),
      (result) => {
        if (result.kind === 'ok') onCancelled();
        else if (result.kind === 'refused') onStale();
      },
    );
  };

  return (
    <Dialog open onClose={close} title={SHIPMENT_SLIP_TEXT.cancelShipment} description={SHIPMENT_SLIP_TEXT.cancelDescription}>
      <div className="space-y-3">
        {slip.cancelBlockers.length > 0 ? (
          <ul className="space-y-1" data-testid="slip-cancel-blockers">
            {slip.cancelBlockers.map((blocker) => (
              <li key={`${blocker.orderId}-${blocker.reason}`}>{formatCancelBlocker(toOrderNumber(blocker.orderId), blocker.reason)}</li>
            ))}
          </ul>
        ) : null}
        {write.message !== null ? <p role="alert" className="lk-text-2xs text-red-600">{write.message}</p> : null}
        {uncertain ? <p role="alert" className="lk-text-2xs text-red-600">{DELIVERY_FORM_TEXT.unknown}</p> : null}
        <div className="flex flex-wrap gap-3">
          {uncertain ? (
            <Button type="button" disabled={sending} onClick={write.checkAgain}>{DELIVERY_FORM_TEXT.checkAgain}</Button>
          ) : (
            <Button type="button" disabled={sending} onClick={submit}>{SHIPMENT_SLIP_TEXT.cancelSubmit}</Button>
          )}
          <Button type="button" variant="secondary" disabled={sending} onClick={close}>{SHIPMENT_SLIP_TEXT.back}</Button>
        </div>
      </div>
    </Dialog>
  );
}
