'use client';

// File: src/components/ShipmentSlipDeliveredDialog.tsx
// 確定済みの発送票を全体で配達済みにするダイアログ（G-3 Task 7 / FREQ-534-AC-02・FREQ-535-AC-04）。
// 票に含まれるすべての注文の有効な発送を、届いた日の正午（日本時間）で配達済みにする。返品の期限はその届いた日から数える。
// 初期値は届いた日が今日（日本時間）、お客様へのメールがオン。送る流れは useDeliverySubmission（二重防止の番号・結果不明の「もう一度確かめる」）。
// DB に断られた時（版の競合を含む）は入力を保ったまま開いておき、親に票の読み直しを頼む（次に押すと新しい版・新しい requestKey で送る）。
import { useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { submitSlipDelivered } from '@/lib/orders/shipment-slips/shipment-slip-client';
import {
  SHIPMENT_SLIP_ERRORS,
  SHIPMENT_SLIP_TEXT,
  type ShipmentSlipDelivered,
  type ShipmentSlipDeliveredInput,
  type ShipmentSlipDetail,
} from '@/lib/orders/shipment-slips/shipment-slip-types';
import { DELIVERY_FORM_TEXT, useDeliverySubmission } from '@/lib/orders/tracking/delivery-client';

type Props = {
  /** 開いている間の票（id・版）。読み直しで版が変わっても、このダイアログは開いたまま */
  slip: Pick<ShipmentSlipDetail, 'id' | 'version'>;
  onClose: () => void;
  /** 記録できた（再送で前の結果が返った時も）。親がダイアログを閉じて通知を出し、票を読み直す */
  onDelivered: () => void;
  /** DB に断られた、または結果が分からないまま戻る。親は票を読み直す（断られた時はこのダイアログは開いたまま） */
  onStale: () => void;
};

const FIELD_CLASS = 'block max-w-full border border-black/30 p-2';
const todayInJapan = (): string => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());

export default function ShipmentSlipDeliveredDialog({ slip, onClose, onDelivered, onStale }: Props): React.JSX.Element {
  const [today] = useState(todayInJapan);
  const [deliveredOn, setDeliveredOn] = useState(today);
  const [notifyCustomer, setNotifyCustomer] = useState(true);

  const submission = useDeliverySubmission<ShipmentSlipDeliveredInput, ShipmentSlipDelivered>({
    send: async (body) => {
      const result = await submitSlipDelivered(slip.id, body);
      // DB に断られた（版の競合を含む）。票が変わったかもしれないので親に読み直しを頼む（このダイアログと入力は保つ）
      if (result.kind === 'refused') onStale();
      return result;
    },
    onSucceeded: onDelivered,
    onClose,
    onUncertain: onStale,
  });
  const { busy, uncertain } = submission;
  const locked = busy || uncertain;

  const submit = (): void => {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(deliveredOn)) {
      submission.setMessage(SHIPMENT_SLIP_ERRORS.GROUP_G_ARGUMENT_INVALID[2]);
      return;
    }
    submission.setMessage(null);
    submission.submit((requestKey) => ({ expectedVersion: slip.version, deliveredOn, notifyCustomer, requestKey }));
  };

  return (
    <Dialog open onClose={submission.close} title={SHIPMENT_SLIP_TEXT.markDelivered} description={SHIPMENT_SLIP_TEXT.deliveredDescription}>
      <div className="space-y-3">
        <label className="block">{SHIPMENT_SLIP_TEXT.deliveredOnLabel}
          <input type="date" value={deliveredOn} max={today} disabled={locked} onChange={(event) => setDeliveredOn(event.target.value)} className={FIELD_CLASS} />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={notifyCustomer} disabled={locked} onChange={(event) => setNotifyCustomer(event.target.checked)} />
          {SHIPMENT_SLIP_TEXT.deliveredNotify}
        </label>
        {submission.message !== null ? <p role="alert" className="lk-text-2xs text-red-600">{submission.message}</p> : null}
        {uncertain ? <p role="alert" className="lk-text-2xs text-red-600">{DELIVERY_FORM_TEXT.unknown}</p> : null}
        <div className="flex flex-wrap gap-3">
          {uncertain ? (
            <Button type="button" disabled={busy} onClick={submission.checkAgain}>{DELIVERY_FORM_TEXT.checkAgain}</Button>
          ) : (
            <Button type="button" disabled={busy} onClick={submit}>{SHIPMENT_SLIP_TEXT.markDelivered}</Button>
          )}
          <Button type="button" variant="secondary" disabled={busy} onClick={submission.close}>{SHIPMENT_SLIP_TEXT.back}</Button>
        </div>
      </div>
    </Dialog>
  );
}
