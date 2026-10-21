'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import {
  SHIPPING_CARRIERS,
  SHIPPING_CARRIER_IDS,
  isShippingCarrierId,
  type ShippingCarrierId,
} from '@/lib/orders/shipping-carriers';
import { DELIVERY_FORM_TEXT, submitTrackingEdit, useDeliverySubmission } from '@/lib/orders/tracking/delivery-client';
import type { FulfillmentDeliveryDetail, UpdateTrackingInput, UpdateTrackingResult } from '@/lib/orders/tracking/delivery-types';

/**
 * 直す画面と配達済みの画面が受け取る値（グループ E-4 の Task 10）。
 * onChanged は記録できた時（前の結果の再送でも）に、onClose の前に1回呼ぶ。onUncertain は、結果が分からないまま閉じる時に
 * 呼ぶ（記録されたかもしれないので、親が履歴・一覧を読み直す）。onClose は戻る・Escape・成功の後に呼ぶ。
 */
export type DeliveryDialogProps = {
  open: boolean;
  orderId: string;
  fulfillment: FulfillmentDeliveryDetail;
  trackingEnabled: boolean;
  onClose: () => void;
  onChanged: () => void;
  onUncertain?: () => void;
};

/**
 * 画面の中身（ダイアログの枠は含まない）が受け取る値。履歴のダイアログは、この中身を自分の枠の中に出す
 * （ダイアログを重ねず、知らせの入れ物も作り直さないため）。枠の Escape・背景の押しは、registerClose で受け取った
 * 「閉じる」（送っている間は閉じない。結果が分からないまま閉じる時は親に読み直しを頼む）につなぐ。中身は、表示している間だけ登録する。
 */
export type DeliveryFormProps = Omit<DeliveryDialogProps, 'open'> & {
  registerClose: (close: (() => void) | null) => void;
};

type TrackingBody = Pick<UpdateTrackingInput, 'requestKey' | 'carrier' | 'trackingNumber' | 'notifyCustomer'>;

// 画面の言葉は計画の C-5 のとおり（句点を足し引きしない）
export const TRACKING_EDIT_TITLE = '伝票番号を直す';
const NOTIFY_LABEL = 'お客様に発送の更新のメールを送る';
const EXPLANATION_ON =
  '直すと配送の状況は受付済みに戻り、新しい伝票番号で追跡します。チェックを外すと、この先の配達中・配達済みのメールも送りません';
const EXPLANATION_OFF = 'チェックを外すと、この先の配達済みのメールも送りません';
const DELIVERED_WARNING = '配達済みの記録が消え、返品の期限は新しい届いた日から数え直します';
const CARRIER_REQUIRED_MESSAGE = '配送業者を選んでください。';
const TRACKING_NUMBER_MESSAGE = '伝票番号は英数字とハイフンで1〜64字にしてください。';

const TRACKING_NUMBER_PATTERN = /^[0-9A-Za-z-]{1,64}$/;
const FIELD_CLASS =
  'mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]';

/**
 * 伝票番号を直す画面（グループ E-4 設計書 6-2。Shopify の「発送を編集」に合わせる）。
 * 配送業者・伝票番号・発送の更新のメールのチェックを、今の発送の値から始める。二重防止の番号は画面を開いた時に作る
 * （開くたびに中身を作り直すので、入力も番号も開くたびに新しくなる）。
 */
export default function OrderTrackingEditDialog({ open, ...rest }: DeliveryDialogProps): React.JSX.Element {
  return <>{open ? <TrackingEditFrame key={rest.fulfillment.fulfillmentId} {...rest} /> : null}</>;
}

/** 単独で開く時のダイアログの枠 */
function TrackingEditFrame(props: Omit<DeliveryDialogProps, 'open'>) {
  const closeRef = useRef<(() => void) | null>(null);
  const registerClose = useCallback((close: (() => void) | null) => {
    closeRef.current = close;
  }, []);
  return (
    <Dialog open onClose={() => closeRef.current?.()} title={TRACKING_EDIT_TITLE}>
      <TrackingEditForm {...props} registerClose={registerClose} />
    </Dialog>
  );
}

export function TrackingEditForm({
  orderId,
  fulfillment,
  trackingEnabled,
  onClose,
  onChanged,
  onUncertain,
  registerClose,
}: DeliveryFormProps) {
  const carrierId = useId();
  const numberId = useId();
  const [carrier, setCarrier] = useState<ShippingCarrierId | ''>(isShippingCarrierId(fulfillment.carrier) ? fulfillment.carrier : '');
  const [trackingNumber, setTrackingNumber] = useState(fulfillment.trackingNumber ?? '');
  const [notifyCustomer, setNotifyCustomer] = useState(fulfillment.notifyCustomer);

  const submission = useDeliverySubmission<TrackingBody, UpdateTrackingResult>({
    send: (body) => submitTrackingEdit(orderId, fulfillment.fulfillmentId, body),
    onSucceeded: () => {
      onChanged();
      onClose();
    },
    onClose,
    onUncertain,
  });
  const { busy, uncertain, message, setMessage, close } = submission;
  // 送っている間と、結果が分からない間は、入力を止める
  const locked = busy || uncertain;

  useEffect(() => {
    registerClose(close);
    return () => registerClose(null);
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (locked) return;
    const value = trackingNumber.trim();
    if (carrier === '') {
      setMessage(CARRIER_REQUIRED_MESSAGE);
      return;
    }
    if (!TRACKING_NUMBER_PATTERN.test(value)) {
      setMessage(TRACKING_NUMBER_MESSAGE);
      return;
    }
    setMessage(null);
    submission.submit((requestKey) => ({ requestKey, carrier, trackingNumber: value, notifyCustomer }));
  };

  return (
    <form className="space-y-3" onSubmit={handleSubmit} noValidate>
      <p className="font-acumin lk-text-3xs text-[#474747]">{trackingEnabled ? EXPLANATION_ON : EXPLANATION_OFF}</p>
      {fulfillment.deliveredAt !== null ? (
        <p className="font-acumin lk-text-3xs text-amber-800">{DELIVERED_WARNING}</p>
      ) : null}
      <div>
        <label htmlFor={carrierId} className="block font-acumin lk-text-3xs text-[#474747]">
          配送業者
        </label>
        <select
          id={carrierId}
          value={carrier}
          disabled={locked}
          onChange={(event) => {
            if (isShippingCarrierId(event.target.value)) setCarrier(event.target.value);
          }}
          className={FIELD_CLASS}
        >
          {/* 配送業者が分からない昔の発送だけ。選ぶまでは送れない */}
          {carrier === '' ? <option value="" /> : null}
          {SHIPPING_CARRIER_IDS.map((id) => (
            <option key={id} value={id}>
              {SHIPPING_CARRIERS[id].label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={numberId} className="block font-acumin lk-text-3xs text-[#474747]">
          伝票番号
        </label>
        <input
          id={numberId}
          type="text"
          value={trackingNumber}
          disabled={locked}
          onChange={(event) => setTrackingNumber(event.target.value)}
          placeholder="1234-5678-9012"
          className={FIELD_CLASS}
        />
      </div>
      <Checkbox
        label={NOTIFY_LABEL}
        checked={notifyCustomer}
        disabled={locked}
        onChange={(event) => setNotifyCustomer(event.target.checked)}
      />

      {message || uncertain ? (
        <div role="alert" className="space-y-1 font-acumin lk-text-3xs text-red-700">
          {message ? <p>{message}</p> : null}
          {uncertain ? <p>{DELIVERY_FORM_TEXT.unknown}</p> : null}
        </div>
      ) : null}

      <div className="flex gap-2 pt-1">
        <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={busy} onClick={close}>
          {DELIVERY_FORM_TEXT.back}
        </Button>
        {uncertain ? (
          <Button variant="primary" size="sm" className="w-full font-acumin" disabled={busy} onClick={submission.checkAgain}>
            {DELIVERY_FORM_TEXT.checkAgain}
          </Button>
        ) : (
          <Button type="submit" variant="primary" size="sm" className="w-full font-acumin" disabled={busy}>
            {busy ? DELIVERY_FORM_TEXT.saving : TRACKING_EDIT_TITLE}
          </Button>
        )}
      </div>
    </form>
  );
}
