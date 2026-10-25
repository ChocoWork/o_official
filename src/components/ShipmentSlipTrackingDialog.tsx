'use client';

// File: src/components/ShipmentSlipTrackingDialog.tsx
// 確定済みの発送票の伝票番号を入れる・直すダイアログ（G-3 Task 7 / FREQ-534-AC-01）。
// 票に含まれるすべての注文の有効な発送へ、同じ運送会社と伝票番号を反映する。運送会社と伝票番号は両方必須（空に戻す訂正は無い）。
// 番号が無い票の見出しとボタンは「伝票番号を入れる」「入れる」、番号がある票は「伝票番号を直す」「直す」。
// 送る流れは useDeliverySubmission（二重防止の番号・結果不明の「もう一度確かめる」）。
// DB に断られた時（版の競合を含む）は入力を保ったまま開いておき、親に票の読み直しを頼む（次に押すと新しい版・新しい requestKey で送る）。
import { useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { submitSlipTrackingEdit } from '@/lib/orders/shipment-slips/shipment-slip-client';
import {
  SHIPMENT_SLIP_ERRORS,
  SHIPMENT_SLIP_TEXT,
  type ShipmentSlipDetail,
  type ShipmentSlipTrackingInput,
  type ShipmentSlipTrackingUpdated,
} from '@/lib/orders/shipment-slips/shipment-slip-types';
import { SHIPPING_CARRIERS, SHIPPING_CARRIER_IDS, type ShippingCarrierId } from '@/lib/orders/shipping-carriers';
import { DELIVERY_FORM_TEXT, useDeliverySubmission } from '@/lib/orders/tracking/delivery-client';

type Props = {
  /** 開いている間の票（id・版・今の運送会社と番号）。読み直しで版が変わっても、このダイアログは開いたまま */
  slip: Pick<ShipmentSlipDetail, 'id' | 'version' | 'carrier' | 'trackingNumber'>;
  onClose: () => void;
  /** 記録できた（再送で前の結果が返った時も）。親がダイアログを閉じて通知を出し、票を読み直す */
  onUpdated: () => void;
  /** DB に断られた、または結果が分からないまま戻る。親は票を読み直す（断られた時はこのダイアログは開いたまま） */
  onStale: () => void;
};

const FIELD_CLASS = 'block max-w-full border border-black/30 p-2';

export default function ShipmentSlipTrackingDialog({ slip, onClose, onUpdated, onStale }: Props): React.JSX.Element {
  const entering = slip.trackingNumber === null;
  // 運送会社がまだ無い票は、選ばずに送って違う運送会社が全注文に入らないよう、空から始めて選ばせる。ある票は今の値から始める
  const [carrier, setCarrier] = useState<ShippingCarrierId | ''>(slip.carrier ?? '');
  const [trackingNumber, setTrackingNumber] = useState(slip.trackingNumber ?? '');
  const [notifyCustomer, setNotifyCustomer] = useState(true);

  const submission = useDeliverySubmission<ShipmentSlipTrackingInput, ShipmentSlipTrackingUpdated>({
    send: async (body) => {
      const result = await submitSlipTrackingEdit(slip.id, body);
      // DB に断られた（版の競合を含む）。票が変わったかもしれないので親に読み直しを頼む（このダイアログと入力は保つ）
      if (result.kind === 'refused') onStale();
      return result;
    },
    onSucceeded: onUpdated,
    onClose,
    onUncertain: onStale,
  });
  const { busy, uncertain } = submission;
  const locked = busy || uncertain;

  const submit = (): void => {
    const number = trackingNumber.trim();
    if (carrier === '' || number === '') {
      submission.setMessage(SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_TRACKING_INCOMPLETE[2]);
      return;
    }
    if (!/^[0-9A-Za-z-]{1,64}$/.test(number)) {
      submission.setMessage(SHIPMENT_SLIP_ERRORS.GROUP_G_ARGUMENT_INVALID[2]);
      return;
    }
    submission.setMessage(null);
    submission.submit((requestKey) => ({ expectedVersion: slip.version, carrier, trackingNumber: number, notifyCustomer, requestKey }));
  };

  const title = entering ? SHIPMENT_SLIP_TEXT.trackingEnter : SHIPMENT_SLIP_TEXT.trackingEdit;
  return (
    <Dialog open onClose={submission.close} title={title} description={SHIPMENT_SLIP_TEXT.trackingDescription}>
      <div className="space-y-3">
        <label className="block">{SHIPMENT_SLIP_TEXT.carrierLabel}
          <select value={carrier} disabled={locked} onChange={(event) => setCarrier(event.target.value as ShippingCarrierId | '')} className={FIELD_CLASS}>
            {slip.carrier === null ? <option value="">{SHIPMENT_SLIP_TEXT.carrierPlaceholder}</option> : null}
            {SHIPPING_CARRIER_IDS.map((id) => <option key={id} value={id}>{SHIPPING_CARRIERS[id].label}</option>)}
          </select>
        </label>
        <label className="block">{SHIPMENT_SLIP_TEXT.trackingNumberLabel}
          <input value={trackingNumber} disabled={locked} maxLength={64} onChange={(event) => setTrackingNumber(event.target.value)} className={FIELD_CLASS} />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={notifyCustomer} disabled={locked} onChange={(event) => setNotifyCustomer(event.target.checked)} />
          {SHIPMENT_SLIP_TEXT.trackingNotify}
        </label>
        {submission.message !== null ? <p role="alert" className="lk-text-2xs text-red-600">{submission.message}</p> : null}
        {uncertain ? <p role="alert" className="lk-text-2xs text-red-600">{DELIVERY_FORM_TEXT.unknown}</p> : null}
        <div className="flex flex-wrap gap-3">
          {uncertain ? (
            <Button type="button" disabled={busy} onClick={submission.checkAgain}>{DELIVERY_FORM_TEXT.checkAgain}</Button>
          ) : (
            <Button type="button" disabled={busy} onClick={submit}>
              {entering ? SHIPMENT_SLIP_TEXT.trackingSubmitEnter : SHIPMENT_SLIP_TEXT.trackingSubmitEdit}
            </Button>
          )}
          <Button type="button" variant="secondary" disabled={busy} onClick={submission.close}>{SHIPMENT_SLIP_TEXT.back}</Button>
        </div>
      </div>
    </Dialog>
  );
}
