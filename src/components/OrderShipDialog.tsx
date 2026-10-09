'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import {
  SHIPPING_CARRIERS,
  SHIPPING_CARRIER_IDS,
  isShippingCarrierId,
  type ShippingCarrierId,
} from '@/lib/orders/shipping-carriers';

export type OrderShipValues = {
  carrier: ShippingCarrierId;
  trackingNumber: string;
  notifyCustomer: boolean;
};

type OrderShipDialogProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (values: OrderShipValues) => void;
};

const TRACKING_NUMBER_PATTERN = /^[0-9A-Za-z-]{1,64}$/;

/**
 * 発送の画面（グループ D 設計書 5-4。Shopify の「発送の詳細を今すぐ送る」に合わせる）。
 * 「お客様に発送のメールを送る」は既定でオン、外せる。開くたびに既定へ戻す。
 * 追跡番号の形の誤りは、開いているこの画面の中に出す（一覧の下に出すと、開いているダイアログに隠れる）。
 */
export default function OrderShipDialog({ open, onClose, onSubmit }: OrderShipDialogProps) {
  const [carrier, setCarrier] = useState<ShippingCarrierId>('yamato');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [notifyCustomer, setNotifyCustomer] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 開くたびに既定へ戻す（配送業者はヤマト、追跡番号は空、お客様へのメールはオン）
  useEffect(() => {
    if (open) {
      setCarrier('yamato');
      setTrackingNumber('');
      setNotifyCustomer(true);
      setError(null);
    }
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title="発送済みにする">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const value = trackingNumber.trim();
          if (!TRACKING_NUMBER_PATTERN.test(value)) {
            setError('追跡番号は英数字とハイフンで入力してください。');
            return;
          }
          onSubmit({ carrier, trackingNumber: value, notifyCustomer });
        }}
      >
        <div>
          <label htmlFor="ship-carrier" className="block font-acumin lk-text-3xs text-[#474747]">
            配送業者
          </label>
          <select
            id="ship-carrier"
            value={carrier}
            onChange={(event) => {
              if (isShippingCarrierId(event.target.value)) setCarrier(event.target.value);
            }}
            className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black"
          >
            {SHIPPING_CARRIER_IDS.map((id) => (
              <option key={id} value={id}>
                {SHIPPING_CARRIERS[id].label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ship-tracking" className="block font-acumin lk-text-3xs text-[#474747]">
            追跡番号
          </label>
          <input
            id="ship-tracking"
            type="text"
            maxLength={64}
            value={trackingNumber}
            onChange={(event) => setTrackingNumber(event.target.value)}
            placeholder="1234-5678-9012"
            className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black"
          />
        </div>
        <Checkbox
          label="お客様に発送のメールを送る"
          checked={notifyCustomer}
          onChange={(event) => setNotifyCustomer(event.target.checked)}
        />
        {error ? (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" variant="primary" size="sm" className="w-full font-acumin">
            発送する
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
