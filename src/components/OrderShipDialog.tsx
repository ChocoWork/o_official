'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';
import {
  COMPLETION_RECORDED_MESSAGE,
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
import {
  initialShipQuantities,
  totalQuantity,
  type CreateFulfillmentRequest,
  type CreateFulfillmentResponse,
  type FulfillmentLineQuantity,
  type FulfillmentMaterialLine,
  type FulfillmentMaterials,
  type RecordCompletionRequest,
  type RecordCompletionResponse,
} from '@/lib/orders/fulfillment/fulfillment-types';
import {
  SHIPPING_CARRIERS,
  SHIPPING_CARRIER_IDS,
  isShippingCarrierId,
  type ShippingCarrierId,
} from '@/lib/orders/shipping-carriers';
import { cn } from '@/lib/utils';

type OrderShipDialogProps = {
  /** 開いている注文。null なら閉じている */
  orderId: string | null;
  onClose: () => void;
  /** 発送を記録できた（同じ重複防止キーの送り直しで前の結果が返った時も）。親が一覧を読み直す */
  onShipped: (result: CreateFulfillmentResponse) => void;
};

type OrderShipDialogBodyProps = {
  orderId: string;
  onClose: () => void;
  onShipped: (result: CreateFulfillmentResponse) => void;
};

/** 答えが分からない操作。「もう一度確かめる」は、保存してある同じ中身（同じ重複防止キー）で送り直す */
type UnknownOutcome =
  | { kind: 'ship'; request: CreateFulfillmentRequest }
  | { kind: 'completion'; request: RecordCompletionRequest };

const TRACKING_NUMBER_PATTERN = /^[0-9A-Za-z-]{1,64}$/;
const NO_QUANTITY_MESSAGE = '送る数を入れてください。';

/**
 * 仕上がりを画面の中で記録した後の送る数。記録した数を、その商品の送る数に足す（発送準備中の数までに収める）。
 * 仕上がった品もそのまま送る流れが自然で、入れ直したければ直せる。
 */
function quantitiesAfterCompletion(
  previous: Record<string, number>,
  recorded: readonly FulfillmentLineQuantity[],
  lines: readonly FulfillmentMaterialLine[],
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const line of lines) {
    if (line.unshipped < 1) continue;
    const added = recorded.find((entry) => entry.orderItemId === line.orderItemId)?.quantity ?? 0;
    next[line.orderItemId] = Math.min(line.readyUnshipped, (previous[line.orderItemId] ?? 0) + added);
  }
  return next;
}

/**
 * 発送の画面（グループ E-1 設計書 6-1。Shopify の「発送済みにする」に合わせる）。
 * 開く時に発送の材料を読み、商品ごとに今回送る数を入れて発送する。受注生産中の品は、ここで仕上がりも記録できる。
 * 開くたびに中身を作り直す（key に注文を使う）ので、重複防止キーも入力も開くたびに新しくなる。
 */
export default function OrderShipDialog({ orderId, onClose, onShipped }: OrderShipDialogProps) {
  return orderId ? <OrderShipDialogBody key={orderId} orderId={orderId} onClose={onClose} onShipped={onShipped} /> : null;
}

function OrderShipDialogBody({ orderId, onClose, onShipped }: OrderShipDialogBodyProps) {
  const [materials, setMaterials] = useState<FulfillmentMaterials | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [completionInputs, setCompletionInputs] = useState<Record<string, number>>({});
  const [carrier, setCarrier] = useState<ShippingCarrierId>('yamato');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [notifyCustomer, setNotifyCustomer] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<UnknownOutcome | null>(null);
  // 重複防止キー。画面を開いた時に作り、窓口が断った時（仕上がりは、記録して材料を読み直せた時も）だけ作り直す。
  // 答えが分からない時と、記録したのに読み直せなかった時は、同じキーで確かめ直す
  const keys = useRef({ ship: '', completion: '' });

  useEffect(() => {
    keys.current = { ship: crypto.randomUUID(), completion: crypto.randomUUID() };
    let active = true;
    void fetchFulfillmentMaterials(orderId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setLoadError(result.message);
        return;
      }
      setMaterials(result.materials);
      setQuantities(initialShipQuantities(result.materials.lines));
    });
    return () => {
      active = false;
    };
  }, [orderId]);

  const blockedReason = materials?.blockedReason ?? null;
  const blockedMessage = blockedReason ? FULFILLMENT_ERROR_MESSAGES[blockedReason].message : null;
  // 送っている間・答えが分からない間・発送できない注文は、入力も操作も止める
  const locked = busy || unknown !== null || blockedMessage !== null;
  const alertText = unknown ? UNKNOWN_OUTCOME_MESSAGE : (error ?? blockedMessage ?? loadError);
  const rows = materials?.lines.filter((line) => line.unshipped >= 1) ?? [];
  const total = totalQuantity(quantities);

  const postShip = async (request: CreateFulfillmentRequest) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await callFulfillmentApi<CreateFulfillmentResponse>(
      `/api/admin/orders/${orderId}/fulfillments`,
      request,
      FULFILLMENT_FAILURE_MESSAGES.create,
    );
    setBusy(false);
    if (result.kind === 'ok') {
      setUnknown(null);
      onShipped(result.body);
      return;
    }
    if (result.kind === 'refused') {
      // 窓口が断った＝記録していない。次の送信は別の操作なので、新しい重複防止キーにする
      keys.current.ship = crypto.randomUUID();
      setUnknown(null);
      setError(result.message);
      return;
    }
    setUnknown({ kind: 'ship', request });
  };

  const postCompletion = async (request: RecordCompletionRequest) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await callFulfillmentApi<RecordCompletionResponse>(
      `/api/admin/orders/${orderId}/completions`,
      request,
      FULFILLMENT_FAILURE_MESSAGES.completion,
    );
    if (result.kind === 'unknown') {
      setBusy(false);
      setUnknown({ kind: 'completion', request });
      return;
    }
    setUnknown(null);
    if (result.kind === 'refused') {
      // 窓口が断った＝記録していない。次の記録は別の操作なので、新しい重複防止キーにする
      keys.current.completion = crypto.randomUUID();
      setBusy(false);
      setError(result.message);
      return;
    }
    // 記録できた。記録は済んでいるので、材料の読み直しが失敗しても、入力は空に戻して知らせる
    // （数が残ったままだと、押し直しが新しい記録に見えて、二重に記録してしまう）
    setCompletionInputs({});
    setNotice(COMPLETION_RECORDED_MESSAGE);
    // 材料を読み直し、仕上がった品を発送準備中として出す
    const reloaded = await fetchFulfillmentMaterials(orderId);
    setBusy(false);
    if (!reloaded.ok) {
      // 重複防止キーは前のまま残す。同じ数を押し直しても、窓口が前の結果を返すので記録は増えない（違う数は窓口が止める）
      setError(reloaded.message);
      return;
    }
    // 読み直せて、画面の数が今の記録に追いついた。次の記録は別の操作なので、新しい重複防止キーにする
    keys.current.completion = crypto.randomUUID();
    setMaterials(reloaded.materials);
    setQuantities((previous) => quantitiesAfterCompletion(previous, request.lines, reloaded.materials.lines));
  };

  const retry = () => {
    if (!unknown || busy) return;
    void (unknown.kind === 'ship' ? postShip(unknown.request) : postCompletion(unknown.request));
  };

  const recordCompletion = (line: FulfillmentMaterialLine) => {
    if (locked) return;
    const quantity = completionInputs[line.orderItemId] ?? 0;
    if (quantity < 1) {
      setNotice(null);
      setError(NO_COMPLETION_QUANTITY_MESSAGE);
      return;
    }
    void postCompletion({ requestKey: keys.current.completion, lines: [{ orderItemId: line.orderItemId, quantity }] });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!materials || locked) return;
    const lines = rows
      .filter((line) => (quantities[line.orderItemId] ?? 0) > 0)
      .map((line) => ({ orderItemId: line.orderItemId, quantity: quantities[line.orderItemId] }));
    if (lines.length === 0) {
      setNotice(null);
      setError(NO_QUANTITY_MESSAGE);
      return;
    }
    const value = trackingNumber.trim();
    if (!TRACKING_NUMBER_PATTERN.test(value)) {
      setNotice(null);
      setError('追跡番号は英数字とハイフンで入力してください。');
      return;
    }
    void postShip({ requestKey: keys.current.ship, carrier, trackingNumber: value, notifyCustomer, lines });
  };

  return (
    <Dialog open onClose={onClose} title="発送済みにする" fullScreenOnMobile>
      <form className="space-y-3" onSubmit={handleSubmit}>
        {!materials && !loadError ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}

        {materials ? (
          <>
            <ul className="max-h-[50vh] space-y-3 overflow-y-auto" aria-label="発送する商品">
              {rows.map((line) => {
                const label = lineLabel(line);
                const quantityId = `ship-quantity-${line.orderItemId}`;
                const completionId = `ship-completion-${line.orderItemId}`;
                return (
                  <li key={line.orderItemId}>
                    <div role="group" aria-label={label} className="space-y-2 border border-[#d4d4d4] p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-acumin lk-text-sm text-black">{label}</span>
                        <TagLabel variant="outline" size="2xs">
                          {line.fulfillmentType === 'stock' ? '在庫' : '受注生産'}
                        </TagLabel>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <p className="font-acumin lk-text-3xs text-[#474747]">発送準備中</p>
                          <p className="font-acumin lk-text-sm text-black">{line.readyUnshipped}</p>
                        </div>
                        <div>
                          <label htmlFor={quantityId} className="block font-acumin lk-text-3xs text-[#474747]">
                            今回送る数
                          </label>
                          <input
                            id={quantityId}
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={line.readyUnshipped}
                            step={1}
                            value={quantities[line.orderItemId] ?? 0}
                            disabled={locked || line.readyUnshipped < 1}
                            onChange={(event) => {
                              const next = clampQuantity(event.target.value, line.readyUnshipped);
                              setQuantities((previous) => ({ ...previous, [line.orderItemId]: next }));
                            }}
                            className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]"
                          />
                        </div>
                      </div>
                      {line.inProduction > 0 ? (
                        <div className="space-y-1 border-t border-[#d4d4d4] pt-2">
                          <p className="font-acumin lk-text-3xs text-[#474747]">{`受注生産中 ${line.inProduction}`}</p>
                          <div className="flex items-end gap-2">
                            <div className="flex-1">
                              <label htmlFor={completionId} className="block font-acumin lk-text-3xs text-[#474747]">
                                仕上がった数
                              </label>
                              <input
                                id={completionId}
                                type="number"
                                inputMode="numeric"
                                min={0}
                                max={line.inProduction}
                                step={1}
                                value={completionInputs[line.orderItemId] ?? 0}
                                disabled={locked}
                                onChange={(event) => {
                                  const next = clampQuantity(event.target.value, line.inProduction);
                                  setCompletionInputs((previous) => ({ ...previous, [line.orderItemId]: next }));
                                }}
                                // Enter で発送の送信になってしまわないよう、この欄の Enter は仕上がりの記録にする。
                                // 日本語入力の変換中の Enter は変換の確定なので、何もしない（Dialog が変換中の Escape を無視するのと同じ）
                                onKeyDown={(event) => {
                                  if (event.nativeEvent.isComposing || event.key !== 'Enter') return;
                                  event.preventDefault();
                                  recordCompletion(line);
                                }}
                                className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]"
                              />
                            </div>
                            <Button
                              variant="secondary"
                              size="sm"
                              className="font-acumin"
                              disabled={locked}
                              onClick={() => recordCompletion(line)}
                            >
                              仕上がりを記録
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="font-acumin lk-text-sm text-black">{`今回送る数の合計: ${total}点`}</p>
            <div>
              <label htmlFor="ship-carrier" className="block font-acumin lk-text-3xs text-[#474747]">
                配送業者
              </label>
              <select
                id="ship-carrier"
                value={carrier}
                disabled={locked}
                onChange={(event) => {
                  if (isShippingCarrierId(event.target.value)) setCarrier(event.target.value);
                }}
                className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]"
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
                disabled={locked}
                onChange={(event) => setTrackingNumber(event.target.value)}
                placeholder="1234-5678-9012"
                className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]"
              />
            </div>
            <Checkbox
              label="お客様に発送のメールを送る"
              checked={notifyCustomer}
              disabled={locked}
              onChange={(event) => setNotifyCustomer(event.target.checked)}
            />
            {/* 仕上がりの記録の結果。後から差し込むと読み上げられない環境が多いので、入れ物は最初から置く（空の間は場所を取らない） */}
            <p role="status" aria-live="polite" className={cn('font-acumin lk-text-3xs text-[#474747]', !notice && 'sr-only')}>
              {notice}
            </p>
          </>
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
            <Button variant="primary" size="sm" className="w-full font-acumin" disabled={busy} onClick={retry}>
              もう一度確かめる
            </Button>
          </div>
        ) : (
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
              キャンセル
            </Button>
            <Button type="submit" variant="primary" size="sm" className="w-full font-acumin" disabled={!materials || locked}>
              発送する
            </Button>
          </div>
        )}
      </form>
    </Dialog>
  );
}
