'use client';

// File: src/components/ShipmentSlipDateDialog.tsx
import { useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { submitSlipDateCorrection } from '@/lib/orders/shipment-slips/shipment-slip-client';
import { SHIPMENT_SLIP_ERRORS, SHIPMENT_SLIP_TEXT, type ShipmentSlipDateCorrected, type ShipmentSlipDateInput, type ShipmentSlipDetail } from '@/lib/orders/shipment-slips/shipment-slip-types';
import { DELIVERY_FORM_TEXT, useDeliverySubmission } from '@/lib/orders/tracking/delivery-client';

type Props = {
  slip: Pick<ShipmentSlipDetail, 'id' | 'version' | 'shipmentDate'>;
  onClose: () => void;
  onCorrected: () => void;
  onStale: () => void;
};
const FIELD_CLASS = 'block w-full max-w-full border border-black/30 p-2';

/** FREQ-535-AC-03: 入力を保って版競合から再確認し、結果不明の間は同じ要求を使う。 */
export default function ShipmentSlipDateDialog({ slip, onClose, onCorrected, onStale }: Props): React.JSX.Element {
  const [shipmentDate, setShipmentDate] = useState(slip.shipmentDate ?? '');
  const [reason, setReason] = useState('');
  const [today] = useState(() => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date()));
  const submission = useDeliverySubmission<ShipmentSlipDateInput, ShipmentSlipDateCorrected>({
    send: async (body) => {
      const result = await submitSlipDateCorrection(slip.id, body);
      if (result.kind === 'refused' || (result.kind === 'blocked' && result.forbidden)) onStale();
      return result;
    },
    onSucceeded: onCorrected, onClose, onUncertain: onStale,
  });
  const { busy, uncertain } = submission;
  const locked = busy || uncertain;
  const submit = (): void => {
    const trimmed = reason.trim();
    if (!trimmed) { submission.setMessage(SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_REASON_REQUIRED[2]); return; }
    if (trimmed.length > 200 || !/^\d{4}-\d{2}-\d{2}$/.test(shipmentDate)) {
      submission.setMessage(SHIPMENT_SLIP_ERRORS.GROUP_G_ARGUMENT_INVALID[2]); return;
    }
    submission.setMessage(null);
    submission.submit((requestKey) => ({ expectedVersion: slip.version, shipmentDate, reason: trimmed, requestKey }));
  };
  return (
    <Dialog open onClose={submission.close} title={SHIPMENT_SLIP_TEXT.correctDate} description={SHIPMENT_SLIP_TEXT.dateDescription}>
      <div className="space-y-3">
        <label className="block">{SHIPMENT_SLIP_TEXT.newShipmentDate}
          <input type="date" required value={shipmentDate} max={today} disabled={locked} onChange={(event) => setShipmentDate(event.target.value)} className={FIELD_CLASS} />
        </label>
        <label className="block">{SHIPMENT_SLIP_TEXT.dateReason}
          <textarea required value={reason} disabled={locked} onChange={(event) => setReason(event.target.value)} className={FIELD_CLASS} />
        </label>
        {submission.message !== null ? <p role="alert" className="lk-text-2xs text-red-600">{submission.message}</p> : null}
        {uncertain ? <p role="alert" className="lk-text-2xs text-red-600">{DELIVERY_FORM_TEXT.unknown}</p> : null}
        <div className="flex flex-wrap gap-3">
          {uncertain ? <Button type="button" disabled={busy} onClick={submission.checkAgain}>{DELIVERY_FORM_TEXT.checkAgain}</Button>
            : <Button type="button" disabled={busy} onClick={submit}>{SHIPMENT_SLIP_TEXT.correctDateSubmit}</Button>}
          <Button type="button" variant="secondary" disabled={busy} onClick={submission.close}>{SHIPMENT_SLIP_TEXT.back}</Button>
        </div>
      </div>
    </Dialog>
  );
}
