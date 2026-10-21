'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import type { DeliveryDialogProps, DeliveryFormProps } from '@/components/OrderTrackingEditDialog';
import { DELIVERY_FORM_TEXT, submitManualDelivered, useDeliverySubmission } from '@/lib/orders/tracking/delivery-client';
import { DELIVERY_ERROR_MESSAGES } from '@/lib/orders/tracking/delivery-messages';
import type { MarkDeliveredInput, MarkDeliveredResult } from '@/lib/orders/tracking/delivery-types';

type DeliveredBody = Pick<MarkDeliveredInput, 'requestKey' | 'deliveredOn' | 'notifyCustomer'>;

// 画面の言葉は計画の C-5・C-4 のとおり（句点を足し引きしない）
export const DELIVERED_TITLE = '配達済みにする';
const NOTIFY_LABEL = 'お客様に配達済みのメールを送る';
const EXPLANATION_OFF = 'お客様に届いたことが分かった時に使います。返品の期限は、この日から数えます';
const EXPLANATION_ON = '追跡で配達済みにならない時に使います。この後、この伝票番号の追跡は止まります';
const DATE_INVALID_MESSAGE = DELIVERY_ERROR_MESSAGES.DELIVERY_DATE_INVALID.message;

const FIELD_CLASS =
  'mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]';

/**
 * 日本時間の日付（YYYY-MM-DD）。読めない時は空。届いた日は日本時間の日付で数える（返品の期限が日本時間の日付で決まるため。
 * ブラウザの地域設定で日付がずれないよう、時刻帯を日本に決めて出す）
 */
function jstDate(value: number | string): string {
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(time)) return '';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(
    new Date(time),
  );
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  return year && month && day ? `${year}-${month}-${day}` : '';
}

/** 実在する日付か（2月30日や、日付の形でない文字を除く） */
function isRealDate(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * 配達済みにする画面（グループ E-4 設計書 6-3。Shopify に無い操作を、届いた日を選べる形で足す）。
 * 届いた日は発送の日から今日まで（日本時間）で、最初は今日。メールのチェックは、その発送のメールがオンの時だけ出す。
 * 二重防止の番号と今日の日付は、画面を開いた時に決まる。
 */
export default function OrderDeliveredDialog({ open, ...rest }: DeliveryDialogProps): React.JSX.Element {
  return <>{open ? <DeliveredFrame key={rest.fulfillment.fulfillmentId} {...rest} /> : null}</>;
}

/** 単独で開く時のダイアログの枠 */
function DeliveredFrame(props: Omit<DeliveryDialogProps, 'open'>) {
  const closeRef = useRef<(() => void) | null>(null);
  const registerClose = useCallback((close: (() => void) | null) => {
    closeRef.current = close;
  }, []);
  return (
    <Dialog open onClose={() => closeRef.current?.()} title={DELIVERED_TITLE}>
      <DeliveredForm {...props} registerClose={registerClose} />
    </Dialog>
  );
}

export function DeliveredForm({
  orderId,
  fulfillment,
  trackingEnabled,
  onClose,
  onChanged,
  onUncertain,
  registerClose,
}: DeliveryFormProps) {
  const dateId = useId();
  // 開いた時の今日。開いている間に日付をまたいでも、上限は開いた時の今日のまま（窓口が最後に今日までかを確かめる）
  const [today] = useState(() => jstDate(Date.now()));
  const minDate = jstDate(fulfillment.shippedAt);
  const [deliveredOn, setDeliveredOn] = useState(today);
  const [notifyCustomer, setNotifyCustomer] = useState(true);

  const submission = useDeliverySubmission<DeliveredBody, MarkDeliveredResult>({
    send: (body) => submitManualDelivered(orderId, fulfillment.fulfillmentId, body),
    onSucceeded: () => {
      onChanged();
      onClose();
    },
    onClose,
    onUncertain,
  });
  const { busy, uncertain, message, setMessage, close } = submission;
  const locked = busy || uncertain;

  useEffect(() => {
    registerClose(close);
    return () => registerClose(null);
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (locked) return;
    if (!isRealDate(deliveredOn) || deliveredOn < minDate || deliveredOn > today) {
      setMessage(DATE_INVALID_MESSAGE);
      return;
    }
    setMessage(null);
    submission.submit((requestKey) => ({
      requestKey,
      deliveredOn,
      // 発送のメールを送らない発送には、配達済みのメールも送らない（チェックも出さない）
      notifyCustomer: fulfillment.notifyCustomer && notifyCustomer,
    }));
  };

  return (
    <form className="space-y-3" onSubmit={handleSubmit} noValidate>
      <p className="font-acumin lk-text-3xs text-[#474747]">{trackingEnabled ? EXPLANATION_ON : EXPLANATION_OFF}</p>
      <div>
        <label htmlFor={dateId} className="block font-acumin lk-text-3xs text-[#474747]">
          届いた日
        </label>
        <input
          id={dateId}
          type="date"
          min={minDate}
          max={today}
          value={deliveredOn}
          disabled={locked}
          onChange={(event) => setDeliveredOn(event.target.value)}
          className={FIELD_CLASS}
        />
      </div>
      {fulfillment.notifyCustomer ? (
        <Checkbox
          label={NOTIFY_LABEL}
          checked={notifyCustomer}
          disabled={locked}
          onChange={(event) => setNotifyCustomer(event.target.checked)}
        />
      ) : null}

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
            {busy ? DELIVERY_FORM_TEXT.saving : DELIVERED_TITLE}
          </Button>
        )}
      </div>
    </form>
  );
}
