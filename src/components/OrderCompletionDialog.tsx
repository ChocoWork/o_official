'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';
import {
  NO_COMPLETION_QUANTITY_MESSAGE,
  callFulfillmentApi,
  clampQuantity,
  fetchFulfillmentMaterials,
  lineLabel,
} from '@/lib/orders/fulfillment/fulfillment-client';
import {
  FULFILLMENT_ERROR_MESSAGES,
  FULFILLMENT_FAILURE_MESSAGES,
  UNKNOWN_OUTCOME_MESSAGE,
} from '@/lib/orders/fulfillment/fulfillment-messages';
import type {
  FulfillmentMaterials,
  RecordCompletionRequest,
  RecordCompletionResponse,
} from '@/lib/orders/fulfillment/fulfillment-types';

type OrderCompletionDialogProps = {
  /** 開いている注文。null なら閉じている */
  orderId: string | null;
  onClose: () => void;
  /** 仕上がりを記録できた（同じ重複防止キーの送り直しで前の結果が返った時も）。親が一覧を読み直す */
  onRecorded: () => void;
};

type OrderCompletionDialogBodyProps = {
  orderId: string;
  onClose: () => void;
  onRecorded: () => void;
};

const NO_IN_PRODUCTION_MESSAGE = '受注生産中の商品はありません。';

/**
 * 仕上がりの画面（グループ E-1 設計書 5-1）。受注生産中の商品ごとに、仕上がった数を入れて記録する。
 * お客様にメールは送らない。開くたびに中身を作り直す（key に注文を使う）ので、重複防止キーも入力も開くたびに新しくなる。
 */
export default function OrderCompletionDialog({ orderId, onClose, onRecorded }: OrderCompletionDialogProps) {
  return orderId ? (
    <OrderCompletionDialogBody key={orderId} orderId={orderId} onClose={onClose} onRecorded={onRecorded} />
  ) : null;
}

function OrderCompletionDialogBody({ orderId, onClose, onRecorded }: OrderCompletionDialogBodyProps) {
  const [materials, setMaterials] = useState<FulfillmentMaterials | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 答えが分からない記録。「もう一度確かめる」は、この同じ中身（同じ重複防止キー）で送り直す
  const [unknown, setUnknown] = useState<RecordCompletionRequest | null>(null);
  // 重複防止キー。画面を開いた時に作り、窓口が断った時だけ作り直す
  const requestKey = useRef('');

  useEffect(() => {
    requestKey.current = crypto.randomUUID();
    let active = true;
    void fetchFulfillmentMaterials(orderId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setLoadError(result.message);
        return;
      }
      setMaterials(result.materials);
    });
    return () => {
      active = false;
    };
  }, [orderId]);

  const rows = materials?.lines.filter((line) => line.inProduction > 0) ?? [];
  // 決済完了でない注文は記録できない（配送先や支払額の確認は、記録には関係しない）
  const blockedMessage = materials?.blockedReason === 'not_shippable' ? FULFILLMENT_ERROR_MESSAGES.not_in_production.message : null;
  const emptyMessage = materials && !blockedMessage && rows.length === 0 ? NO_IN_PRODUCTION_MESSAGE : null;
  const locked = busy || unknown !== null || blockedMessage !== null || rows.length === 0;
  const alertText = unknown ? UNKNOWN_OUTCOME_MESSAGE : (error ?? blockedMessage ?? loadError);

  const post = async (request: RecordCompletionRequest) => {
    setBusy(true);
    setError(null);
    const result = await callFulfillmentApi<RecordCompletionResponse>(
      `/api/admin/orders/${orderId}/completions`,
      request,
      FULFILLMENT_FAILURE_MESSAGES.completion,
    );
    setBusy(false);
    if (result.kind === 'ok') {
      setUnknown(null);
      onRecorded();
      return;
    }
    if (result.kind === 'refused') {
      // 窓口が断った＝記録していない。次の送信は別の操作なので、新しい重複防止キーにする
      requestKey.current = crypto.randomUUID();
      setUnknown(null);
      setError(result.message);
      return;
    }
    setUnknown(request);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (locked) return;
    const lines = rows
      .filter((line) => (quantities[line.orderItemId] ?? 0) > 0)
      .map((line) => ({ orderItemId: line.orderItemId, quantity: quantities[line.orderItemId] }));
    if (lines.length === 0) {
      setError(NO_COMPLETION_QUANTITY_MESSAGE);
      return;
    }
    void post({ requestKey: requestKey.current, lines });
  };

  return (
    <Dialog open onClose={onClose} title="仕上がりを記録する" fullScreenOnMobile>
      <form className="space-y-3" onSubmit={handleSubmit}>
        {!materials && !loadError ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}
        {emptyMessage ? <p className="font-acumin lk-text-3xs text-[#474747]">{emptyMessage}</p> : null}

        {rows.length > 0 ? (
          <ul className="max-h-[50vh] space-y-3 overflow-y-auto" aria-label="仕上がりを記録する商品">
            {rows.map((line) => {
              const label = lineLabel(line);
              const inputId = `completion-quantity-${line.orderItemId}`;
              return (
                <li key={line.orderItemId}>
                  <div role="group" aria-label={label} className="space-y-2 border border-[#d4d4d4] p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-acumin lk-text-sm text-black">{label}</span>
                      <TagLabel variant="outline" size="2xs">
                        受注生産
                      </TagLabel>
                    </div>
                    <p className="font-acumin lk-text-3xs text-[#474747]">{`受注生産中 ${line.inProduction}`}</p>
                    <div>
                      <label htmlFor={inputId} className="block font-acumin lk-text-3xs text-[#474747]">
                        仕上がった数
                      </label>
                      <input
                        id={inputId}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={line.inProduction}
                        step={1}
                        value={quantities[line.orderItemId] ?? 0}
                        disabled={locked}
                        onChange={(event) => {
                          const next = clampQuantity(event.target.value, line.inProduction);
                          setQuantities((previous) => ({ ...previous, [line.orderItemId]: next }));
                        }}
                        className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]"
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}

        {alertText ? (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {alertText}
          </p>
        ) : null}

        {unknown ? (
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
              閉じる
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="w-full font-acumin"
              disabled={busy}
              onClick={() => void post(unknown)}
            >
              もう一度確かめる
            </Button>
          </div>
        ) : (
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
              キャンセル
            </Button>
            <Button type="submit" variant="primary" size="sm" className="w-full font-acumin" disabled={!materials || locked}>
              記録する
            </Button>
          </div>
        )}
      </form>
    </Dialog>
  );
}
