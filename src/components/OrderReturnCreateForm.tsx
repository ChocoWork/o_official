'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';
import { TextField } from '@/components/ui/TextField/TextField';
import { blockEnterSubmit } from '@/hooks/useRefundSubmission';
import { clampQuantity, lineLabel } from '@/lib/orders/fulfillment/fulfillment-client';
import { toOrderNumber } from '@/lib/orders/order-number';
import { ADMIN_NOTE_MAX_LENGTH } from '@/lib/orders/order-payment-types';
import { callRefundApi } from '@/lib/orders/refund/refund-client';
import { REFUND_ERROR_MESSAGES } from '@/lib/orders/refund/refund-messages';
import { formatDeadline } from '@/lib/orders/returns/return-calc';
import { fetchReturnData } from '@/lib/orders/returns/return-client';
import { RETURN_CARRIER_LABELS, RETURN_ERROR_MESSAGES, RETURN_REASON_LABELS } from '@/lib/orders/returns/return-messages';
import {
  RETURN_CARRIERS,
  RETURN_REASONS,
  type ExchangeMethod,
  type ReturnCarrier,
  type ReturnCreateMaterials,
  type ReturnMethod,
  type ReturnReason,
  type ReturnResolution,
  type ReturnStatus,
  type ShippingPayer,
} from '@/lib/orders/returns/return-types';

type Shipment = ReturnCreateMaterials['shipments'][number];
type ShipmentLine = Shipment['lines'][number];
type ExchangeVariant = ReturnCreateMaterials['exchangeOptions'][number]['variants'][number];

/** 窓口へ送る品ごとの中身（C-1 の `_lines` の各キーを camelCase にした物） */
export type CreateReturnLineRequest = {
  fulfillmentId: string;
  orderItemId: string;
  quantity: number;
  reason: ReturnReason;
  reasonNote: string | null;
  resolution: ReturnResolution;
  exchangeVariantId: number | null;
  exchangeMethod: ExchangeMethod | null;
};

/** `POST /api/admin/orders/[id]/returns` の本文（C-3）。手数料の4つは、使わない欄も 0 の整数で送る */
export type CreateReturnRequest = {
  requestKey: string;
  lines: CreateReturnLineRequest[];
  returnMethod: ReturnMethod;
  returnShippingPayer: ShippingPayer;
  returnCarrier: ReturnCarrier | null;
  returnTrackingNumber: string | null;
  returnShippingFee: number;
  restockingFeePercent: number;
  exchangeFee: number;
  exchangeShippingFee: number;
  shopNote: string | null;
  notifyCustomer: boolean;
};

/** 窓口の答え（`{ data }` の中身） */
export type CreateReturnResponse = { returnId: string; number: number; status: ReturnStatus; replayed: boolean };

type OrderReturnCreateFormProps = {
  orderId: string;
  onClose: () => void;
  /** 返品を作れた（同じ二重防止の番号の送り直しで前の結果が返った時も）。返送不要の返品は、親がすぐ受け取りの画面を開く */
  onCreated: (result: CreateReturnResponse, returnMethod: ReturnMethod) => void;
  /** 答えが分からないまま閉じた。返品が作られたかもしれないので、親が読み直す */
  onUncertain?: () => void;
};

const MATERIALS_FAILURE_MESSAGE = '返品の材料を読み込めませんでした。';
const CREATE_FAILURE_MESSAGE = '返品を作れませんでした。';
const UNKNOWN_CREATE_OUTCOME_MESSAGE =
  '返品を作れたか確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';
// 理由のメモの上限は DB の order_return_lines.reason_note と同じ（C-0）
const REASON_NOTE_MAX_LENGTH = 255;
// 金額（円）の欄の上限（Global Constraints「金額の入力の上限」）。DB の関数・窓口・ショップの設定の画面と同じ値で、桁の打ち間違いを止める
const FEE_MAX_YEN = 1_000_000;
const FEE_OVER_MAX_MESSAGE = '0から1000000までの整数（半角）で入れてください。';
// Task 12 と同じ言葉と入力の確かめ
const PERCENT_MESSAGE = '0から100までの整数（半角）で入れてください。';
// 伝票番号の形は DB の CHECK と同じ（P16）
const TRACKING_PATTERN = /^[0-9A-Za-z-]{1,64}$/;
const TRACKING_INVALID_MESSAGE = '伝票番号は英数字とハイフンで入力してください。';

const RETURN_METHODS: readonly ReturnMethod[] = ['customer_ships', 'shop_label', 'not_required'];
const PAYERS: readonly ShippingPayer[] = ['shop', 'customer'];
const EXCHANGE_METHODS: readonly ExchangeMethod[] = ['stock', 'make'];
const RESOLUTIONS: readonly ReturnResolution[] = ['refund', 'exchange'];

const RETURN_METHOD_LABELS: Record<ReturnMethod, string> = {
  customer_ships: 'お客様が送る',
  shop_label: 'お店の送り状で送る（返送料を差し引く）',
  not_required: '返送不要',
};
const PAYER_LABELS: Record<ShippingPayer, string> = { shop: 'お店', customer: 'お客様' };
const EXCHANGE_METHOD_LABELS: Record<ExchangeMethod, string> = { stock: '在庫から', make: '作って送る' };
const RESOLUTION_LABELS: Record<ReturnResolution, string> = { refund: '返金', exchange: '交換' };

const REASON_OPTIONS = RETURN_REASONS.map((reason) => ({ value: reason, label: RETURN_REASON_LABELS[reason] }));
const CARRIER_OPTIONS = RETURN_CARRIERS.map((carrier) => ({ value: carrier, label: RETURN_CARRIER_LABELS[carrier] }));
const PAYER_OPTIONS = PAYERS.map((payer) => ({ value: payer, label: PAYER_LABELS[payer] }));
const EXCHANGE_METHOD_OPTIONS = EXCHANGE_METHODS.map((method) => ({ value: method, label: EXCHANGE_METHOD_LABELS[method] }));

/** 品ごとの入力。数が0の品は他の欄を出さない（値は持ち越す） */
type LineInput = {
  quantity: number;
  reason: ReturnReason;
  reasonNote: string;
  resolution: ReturnResolution;
  /** 手で選んだ交換の色・サイズ（variantId の文字）。空なら既定（同じ色・サイズ、無ければ最初の使える物） */
  exchangeVariantId: string;
  /** 手で選んだ送り方。null なら、選んだ色・サイズの在庫が交換にする数に足りるかで決める */
  exchangeMethod: ExchangeMethod | null;
  /**
   * 手で入れた交換にする数（解決が交換で、返す数が2点以上の時だけ使う）。null なら返す数の全部。
   * 返す数より少なければ、残りは同じ発送の行の返金の行として送る（設計書 4-2。DB は2行の合計で数を確かめる）
   */
  exchangeQuantity: number | null;
};

// 理由の最初の値は「不明」。お店が作る時だけ選べる理由で、間違った理由を入れるよりも事実に合う
const EMPTY_LINE_INPUT: LineInput = {
  quantity: 0,
  reason: 'unknown',
  reasonNote: '',
  resolution: 'refund',
  exchangeVariantId: '',
  exchangeMethod: null,
  exchangeQuantity: null,
};

/** 手数料の入力。null は「手で直していない」（設定の値から始める） */
type FeesEntered = {
  shipping: number | null;
  restockingPercent: string | null;
  exchange: number | null;
  exchangeShipping: number | null;
};

/** 選んだ品（数が1以上）。送る中身と、入力の確かめに使う */
type SelectedLine = {
  fulfillmentId: string;
  line: ShipmentLine;
  input: LineInput;
  /** 交換にする時の色・サイズ。返金なら null */
  variant: ExchangeVariant | null;
  /** 交換にする時の送り方。返金なら null */
  method: ExchangeMethod | null;
};

/** select の値（文字）を、許す値の一覧に照らして型にする。一覧に無ければ null */
function pick<T extends string>(values: readonly T[], raw: string): T | null {
  return values.find((value) => value === raw) ?? null;
}

/** 「白 / M」。色もサイズも無ければ空 */
function variantText(color: string | null, size: string | null): string {
  return [color, size].filter((part): part is string => Boolean(part)).join(' / ');
}

/** 発送の日付（日本時間）を「10月10日」にする。日本時間の日付で数えるのは、期限が日本時間の日付で決まるため */
function monthDay(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).formatToParts(new Date(time));
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return month && day ? `${month}月${day}日` : iso;
}

/** 受付の期限の文。期限を過ぎていても作れる（段1はお店が作るので止めず、警告だけ出す） */
function deadlineText(shipment: Shipment): string {
  if (shipment.deadlineDate === null) return '受付の期限: なし';
  const day = formatDeadline(shipment.deadlineDate);
  return shipment.pastDeadline ? `期限を過ぎています（${day}まで）` : `受付の期限: ${day}まで`;
}

function lineKey(fulfillmentId: string, orderItemId: string): string {
  return `${fulfillmentId}:${orderItemId}`;
}

/** 同じ商品の、使える色・サイズ（使えない物は交換先にできない。DB も RETURN_EXCHANGE_VARIANT_INVALID で断る） */
function usableVariants(materials: ReturnCreateMaterials, itemId: number): ExchangeVariant[] {
  const options = materials.exchangeOptions.find((option) => option.itemId === itemId);
  return (options?.variants ?? []).filter((variant) => variant.isActive);
}

/** 交換の色・サイズの選び。手で選んでいなければ、元と同じ色・サイズ（不良品を同じ物に替える場合が多い）、無ければ最初の物 */
function chosenVariant(variants: ExchangeVariant[], input: LineInput, line: ShipmentLine): ExchangeVariant | null {
  return (
    variants.find((variant) => String(variant.variantId) === input.exchangeVariantId) ??
    variants.find((variant) => variant.variantId === line.variantId) ??
    variants[0] ??
    null
  );
}

/** 交換にする数。返金なら0。返す数が1点の品と、手で入れていない品は、返す数の全部 */
function exchangeCountOf(input: LineInput): number {
  if (input.resolution !== 'exchange') return 0;
  if (input.quantity < 2 || input.exchangeQuantity === null) return input.quantity;
  return Math.min(input.exchangeQuantity, input.quantity);
}

/** 送り方の選び。手で選んでいなければ、在庫が交換にする数に足りる時だけ在庫から（設計書 5-2 の最初の値） */
function chosenMethod(variant: ExchangeVariant | null, input: LineInput): ExchangeMethod {
  return input.exchangeMethod ?? (variant !== null && variant.stockQuantity >= exchangeCountOf(input) ? 'stock' : 'make');
}

function selectedLinesOf(materials: ReturnCreateMaterials, inputs: Record<string, LineInput>): SelectedLine[] {
  return materials.shipments.flatMap((shipment) =>
    shipment.lines
      .filter((line) => line.returnable >= 1)
      .flatMap((line): SelectedLine[] => {
        const input = inputs[lineKey(shipment.fulfillmentId, line.orderItemId)] ?? EMPTY_LINE_INPUT;
        if (input.quantity < 1) return [];
        const variant = input.resolution === 'exchange' ? chosenVariant(usableVariants(materials, line.itemId), input, line) : null;
        const method = input.resolution === 'exchange' ? chosenMethod(variant, input) : null;
        return [{ fulfillmentId: shipment.fulfillmentId, line, input, variant, method }];
      }),
  );
}

/** 「その他」は理由のメモが要り、交換は色・サイズと1点以上の交換にする数が要る（DB も同じ決まりで断る） */
function lineIsValid(entry: SelectedLine): boolean {
  if (entry.input.reason === 'other' && entry.input.reasonNote.trim() === '') return false;
  if (entry.input.resolution === 'exchange' && (entry.variant === null || exchangeCountOf(entry.input) < 1)) return false;
  return true;
}

/** 材料を読み直した後、返せる数が減った品の入力を、新しい上限に収める */
function clampInputs(inputs: Record<string, LineInput>, materials: ReturnCreateMaterials): Record<string, LineInput> {
  const next: Record<string, LineInput> = {};
  for (const shipment of materials.shipments) {
    for (const line of shipment.lines) {
      const key = lineKey(shipment.fulfillmentId, line.orderItemId);
      const input = inputs[key];
      if (input) next[key] = { ...input, quantity: Math.min(input.quantity, line.returnable) };
    }
  }
  return next;
}

type NumberFieldProps = {
  id: string;
  label: string;
  value: number;
  max: number;
  disabled: boolean;
  /**
   * 付けると、max を超えた数を収めずにそのまま持ち、この文を欄の下に出す（金額の欄。桁の打ち間違いを黙って別の額に変えない）。
   * 付けなければ、0 から max までに収める
   */
  overMaxMessage?: string;
  onChange: (next: number) => void;
};

function NumberField({ id, label, value, max, disabled, overMaxMessage, onChange }: NumberFieldProps) {
  const over = overMaxMessage !== undefined && value > max;
  return (
    <div>
      <label htmlFor={id} className="block font-acumin lk-text-3xs text-[#474747]">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        aria-invalid={over ? true : undefined}
        aria-describedby={over ? `${id}-error` : undefined}
        // 金額の欄は上限を超えた数も残して誤りに見せる。ほかは 0 から max までに収める
        onChange={(event) => onChange(clampQuantity(event.target.value, overMaxMessage === undefined ? max : Number.MAX_SAFE_INTEGER))}
        className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]"
      />
      {over ? (
        <p id={`${id}-error`} className="mt-1 font-acumin lk-text-3xs text-red-700">
          {overMaxMessage}
        </p>
      ) : null}
    </div>
  );
}

type ReturnLineFieldsProps = {
  idPrefix: string;
  line: ShipmentLine;
  input: LineInput;
  /** この品と同じ商品の、使える色・サイズ */
  variants: ExchangeVariant[];
  disabled: boolean;
  onChange: (patch: Partial<LineInput>) => void;
};

/** 発送の行1つ分の入力。数を入れた品だけ、理由・解決の方法などを出す */
function ReturnLineFields({ idPrefix, line, input, variants, disabled, onChange }: ReturnLineFieldsProps) {
  const label = lineLabel({ name: line.itemName, color: line.color, size: line.size });
  const isExchangeLine = line.lineKind === 'exchange';
  const selected = input.quantity >= 1;
  const exchanging = selected && input.resolution === 'exchange';
  const variant = exchanging ? chosenVariant(variants, input, line) : null;
  const method = exchanging ? chosenMethod(variant, input) : null;
  const noteMissing = selected && input.reason === 'other' && input.reasonNote.trim() === '';
  // 同じ商品に使える色・サイズが1つも無い品は、交換を選べない
  const resolutionOptions = RESOLUTIONS.filter((resolution) => resolution === 'refund' || variants.length > 0).map((resolution) => ({
    value: resolution,
    label: RESOLUTION_LABELS[resolution],
  }));
  const variantOptions = variants.map((option) => ({
    value: String(option.variantId),
    label: variantText(option.color, option.size) || line.itemName,
  }));

  return (
    <li>
      <div role="group" aria-label={isExchangeLine ? `${label}（交換の品）` : label} className="space-y-2 border border-[#d4d4d4] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-acumin lk-text-sm text-black">{label}</span>
          {line.returnIneligible ? (
            <p className="font-acumin lk-text-3xs text-amber-800">返品不可の品です</p>
          ) : null}
          {isExchangeLine ? (
            <TagLabel variant="outline" size="2xs">
              交換の品
            </TagLabel>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <p className="font-acumin lk-text-3xs text-[#474747]">{`返品できる数: ${line.returnable}`}</p>
          <NumberField
            id={`${idPrefix}-quantity`}
            label="返品する数"
            value={input.quantity}
            max={line.returnable}
            disabled={disabled}
            onChange={(next) => onChange({ quantity: next })}
          />
        </div>
        {selected ? (
          <div className="space-y-2">
            <SingleSelect
              id={`${idPrefix}-reason`}
              label="理由"
              options={REASON_OPTIONS}
              value={input.reason}
              disabled={disabled}
              onChange={(event) => {
                const next = pick(RETURN_REASONS, event.target.value);
                if (next) onChange({ reason: next });
              }}
            />
            <TextField
              id={`${idPrefix}-reason-note`}
              label="理由のメモ"
              value={input.reasonNote}
              maxLength={REASON_NOTE_MAX_LENGTH}
              disabled={disabled}
              errorText={noteMissing ? RETURN_ERROR_MESSAGES.RETURN_REASON_NOTE_REQUIRED.message : undefined}
              onChange={(event) => onChange({ reasonNote: event.target.value })}
            />
            <SingleSelect
              id={`${idPrefix}-resolution`}
              label="解決の方法"
              options={resolutionOptions}
              value={input.resolution}
              disabled={disabled}
              onChange={(event) => {
                const next = pick(RESOLUTIONS, event.target.value);
                if (next) onChange({ resolution: next });
              }}
            />
            {exchanging ? (
              <div className="space-y-2">
                {/* 同じ品の一部だけを交換にする時（設計書 4-2）。交換にしない残りは、返金の行として送る */}
                {input.quantity >= 2 ? (
                  <NumberField
                    id={`${idPrefix}-exchange-quantity`}
                    label="交換にする数"
                    value={exchangeCountOf(input)}
                    max={input.quantity}
                    disabled={disabled}
                    onChange={(next) => onChange({ exchangeQuantity: next })}
                  />
                ) : null}
                <SingleSelect
                  id={`${idPrefix}-exchange-variant`}
                  label="交換の色・サイズ"
                  options={variantOptions}
                  value={String(variant?.variantId ?? '')}
                  disabled={disabled}
                  // 色・サイズを選び直したら、送り方は新しい在庫から決め直す
                  onChange={(event) => onChange({ exchangeVariantId: event.target.value, exchangeMethod: null })}
                />
                <p className="font-acumin lk-text-3xs text-[#474747]">{`在庫: ${variant?.stockQuantity ?? 0}`}</p>
                <SingleSelect
                  id={`${idPrefix}-exchange-method`}
                  label="送り方"
                  options={EXCHANGE_METHOD_OPTIONS}
                  value={method ?? 'stock'}
                  disabled={disabled}
                  onChange={(event) => {
                    const next = pick(EXCHANGE_METHODS, event.target.value);
                    if (next) onChange({ exchangeMethod: next });
                  }}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * 返品を作る画面（グループ E-3 設計書 5-3）。一覧の「返品」から開く返品の画面の「返品を作る」で開く。
 * 開く時に材料を読み、発送ごとに返す品の数・理由・解決の方法（返金／交換）を入れ、返送・手数料・メモを決めて作る。
 * 二重防止の番号は開いた時に作る。窓口の答えが分からない時（通信が切れた・500番台）は、入力を止めて、同じ番号・同じ中身で送り直す。
 * 親が開くたびに作り直す（親が出し入れする）ので、番号も入力も開くたびに新しくなる。
 */
export default function OrderReturnCreateForm({ orderId, onClose, onCreated, onUncertain }: OrderReturnCreateFormProps) {
  const materialsUrl = `/api/admin/orders/${orderId}/returns/materials`;
  const submitUrl = `/api/admin/orders/${orderId}/returns`;

  const [materials, setMaterials] = useState<ReturnCreateMaterials | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, LineInput>>({});
  // 返送の入力。手で直した時だけ入る。空の間は、選んだ理由と設定から決めた既定を使う
  const [payerEntered, setPayerEntered] = useState<ShippingPayer | null>(null);
  const [methodEntered, setMethodEntered] = useState<ReturnMethod | null>(null);
  const [carrier, setCarrier] = useState<ReturnCarrier | ''>('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [feesEntered, setFeesEntered] = useState<FeesEntered>({
    shipping: null,
    restockingPercent: null,
    exchange: null,
    exchangeShipping: null,
  });
  const [note, setNote] = useState('');
  const [notifyCustomer, setNotifyCustomer] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  // 二重防止の番号。画面を開いた時に作り、窓口が断った時だけ作り直す
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  // 直近に送った中身。答えが分からない時の「もう一度確かめる」が、これをそのまま送り直す
  const [pending, setPending] = useState<CreateReturnRequest | null>(null);

  useEffect(() => {
    let active = true;
    void fetchReturnData<ReturnCreateMaterials>(materialsUrl, MATERIALS_FAILURE_MESSAGE).then((result) => {
      if (!active) return;
      if (result.kind === 'error') {
        setLoadError(result.message);
        return;
      }
      setMaterials(result.data);
    });
    return () => {
      active = false;
    };
  }, [materialsUrl]);

  const settings = materials?.settings ?? null;
  const stopped = busy || uncertain;
  const selected = materials ? selectedLinesOf(materials, inputs) : [];
  const hasExchange = selected.some((entry) => entry.input.resolution === 'exchange');
  const visibleShipments = (materials?.shipments ?? [])
    .map((shipment) => ({ shipment, lines: shipment.lines.filter((line) => line.returnable >= 1) }))
    .filter((entry) => entry.lines.length > 0);

  // 返送料の負担は、選んだ理由のどれかがお店の負担ならお店（不良品の返送料をお客様に持たせない）。返送の方法は、負担に合わせる
  const payerDefault: ShippingPayer =
    settings && selected.some((entry) => settings.reasonShippingPayers[entry.input.reason] === 'shop') ? 'shop' : 'customer';
  const payer = payerEntered ?? payerDefault;
  const methodDefault: ReturnMethod = settings && payer === 'customer' ? settings.customerPaidMethod : 'customer_ships';
  const method = methodEntered ?? methodDefault;
  const methodOptions = RETURN_METHODS.filter((option) => option !== 'not_required' || settings?.noReturnNeededEnabled).map((option) => ({
    value: option,
    label: RETURN_METHOD_LABELS[option],
  }));

  // 手数料は、設定で使う物だけ出す。出さない欄は 0 で送る（DB も、設定で使わない手数料は 0）。
  // 返送料の定額を差し引くのは、お客様の負担でお店の送り状の時だけ（設計書 8-3。DB の既定と同じ）。お店の負担なら欄を出さず 0 で送る
  const showShippingFee = method === 'shop_label' && payer === 'customer';
  const showRestocking = settings?.restockingFeeEnabled ?? false;
  const showExchangeFees = (settings?.exchangeFeesEnabled ?? false) && hasExchange;
  const shippingFee = feesEntered.shipping ?? settings?.shopLabelFee ?? 0;
  const restockingPercentText = feesEntered.restockingPercent ?? String(settings?.restockingFeePercent ?? 0);
  const restockingPercent = Number(restockingPercentText.trim());
  const restockingPercentInvalid = showRestocking &&
    (!/^[0-9]{1,9}$/.test(restockingPercentText.trim()) || restockingPercent > 100);
  const exchangeFee = feesEntered.exchange ?? settings?.exchangeFee ?? 0;
  const exchangeShippingFee = feesEntered.exchangeShipping ?? settings?.exchangeShippingFee ?? 0;

  const trackingText = trackingNumber.trim();
  // 返送不要の間は伝票番号の欄を隠して送らないので、確かめない（T9-9・T9-11 と同じ「出している欄だけ」）
  const trackingInvalid = method !== 'not_required' && trackingText !== '' && !TRACKING_PATTERN.test(trackingText);
  // 金額の欄は上限を超えた数を残して誤りを出す。出している欄だけを見る（出していない欄は 0 で送る）
  const feeOverMax =
    (showShippingFee && shippingFee > FEE_MAX_YEN) ||
    (showExchangeFees && (exchangeFee > FEE_MAX_YEN || exchangeShippingFee > FEE_MAX_YEN));
  const noReturnable = materials !== null && visibleShipments.length === 0;
  const canSubmit =
    Boolean(materials) &&
    Boolean(settings?.returnAddressSet) &&
    !stopped &&
    selected.length > 0 &&
    !trackingInvalid &&
    !feeOverMax &&
    !restockingPercentInvalid &&
    selected.every(lineIsValid);

  const buildRequest = (key: string): CreateReturnRequest => ({
    requestKey: key,
    // 交換にする数が返す数より少ない品は、同じ発送の行を返金の行と交換の行の2つに分けて送る（設計書 4-2）
    lines: selected.flatMap((entry): CreateReturnLineRequest[] => {
      const base = {
        fulfillmentId: entry.fulfillmentId,
        orderItemId: entry.line.orderItemId,
        reason: entry.input.reason,
        reasonNote: entry.input.reasonNote.trim() || null,
      };
      const exchangeCount = exchangeCountOf(entry.input);
      const refundCount = entry.input.quantity - exchangeCount;
      const rows: CreateReturnLineRequest[] = [];
      if (refundCount > 0) {
        rows.push({ ...base, quantity: refundCount, resolution: 'refund', exchangeVariantId: null, exchangeMethod: null });
      }
      if (exchangeCount > 0) {
        rows.push({
          ...base,
          quantity: exchangeCount,
          resolution: 'exchange',
          exchangeVariantId: entry.variant?.variantId ?? null,
          exchangeMethod: entry.method,
        });
      }
      return rows;
    }),
    returnMethod: method,
    returnShippingPayer: payer,
    returnCarrier: method === 'not_required' || carrier === '' ? null : carrier,
    returnTrackingNumber: method === 'not_required' ? null : trackingText || null,
    returnShippingFee: showShippingFee ? shippingFee : 0,
    restockingFeePercent: showRestocking ? restockingPercent : 0,
    exchangeFee: showExchangeFees ? exchangeFee : 0,
    exchangeShippingFee: showExchangeFees ? exchangeShippingFee : 0,
    shopNote: note.trim() || null,
    notifyCustomer,
  });

  const post = async (request: CreateReturnRequest) => {
    setPending(request);
    setBusy(true);
    setError(null);
    const result = await callRefundApi<{ data?: CreateReturnResponse } | null>(submitUrl, request, CREATE_FAILURE_MESSAGE);
    if (result.kind === 'blocked') {
      // 処理に入る前の断り（権限・回数の制限）。前の送信の結果は変わらないので、番号・中身・結果不明の状態を保つ
      setError(result.message);
      setBusy(false);
      return;
    }
    if (result.kind === 'refused') {
      // 窓口が断った＝返品は作られていない。次の送信は別の操作なので、新しい番号にする
      setRequestKey(crypto.randomUUID());
      setUncertain(false);
      setError(result.message);
      if (uncertain) {
        // 結果不明の再送の断りでは、返せる数が変わったのかもしれないので、材料を読み直す。読み直す間は押せないままにする
        const reloaded = await fetchReturnData<ReturnCreateMaterials>(materialsUrl, MATERIALS_FAILURE_MESSAGE);
        if (reloaded.kind === 'ok') {
          setMaterials(reloaded.data);
          setInputs((previous) => clampInputs(previous, reloaded.data));
        } else {
          setError(reloaded.message);
        }
      }
      setBusy(false);
      return;
    }
    setBusy(false);
    // 成功でも答えの形が読めない時は、作れたか分からない扱いにする（Task 9 の画面と同じ考え）
    const created = result.kind === 'ok' ? result.body?.data : undefined;
    if (created && typeof created.returnId === 'string' && typeof created.number === 'number') {
      setUncertain(false);
      onCreated(created, request.returnMethod);
      return;
    }
    setUncertain(true);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    void post(buildRequest(requestKey));
  };

  const checkAgain = () => {
    if (busy || !uncertain || !pending) return;
    void post(pending);
  };

  // 送っている間は閉じない。答えが分からないまま閉じる時は、返品が作られたかもしれないので親に読み直しを頼む
  const close = () => {
    if (busy) return;
    if (uncertain) onUncertain?.();
    onClose();
  };

  const updateLine = (key: string, patch: Partial<LineInput>) => {
    setInputs((previous) => ({ ...previous, [key]: { ...(previous[key] ?? EMPTY_LINE_INPUT), ...patch } }));
  };
  const updateFees = (patch: Partial<FeesEntered>) => setFeesEntered((previous) => ({ ...previous, ...patch }));

  // 結果が分からない間に処理前の断り（401・403・429）を受けた時は、断りの文の後ろに、結果が分からない時の文を続けて出す
  const unknownText = uncertain ? UNKNOWN_CREATE_OUTCOME_MESSAGE : '';
  const alertText = error ? `${error}${unknownText}` : unknownText || loadError;

  return (
    <Dialog open onClose={close} title={`返品を作る（${toOrderNumber(orderId)}）`} fullScreenOnMobile>
      <form className="space-y-3" onSubmit={handleSubmit} onKeyDown={blockEnterSubmit}>
        {!materials && !loadError ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}

        {materials && settings ? (
          // 幅が 768px 以上の Dialog は高さを制限しないので、入力の部分だけを縦に動かし、誤りの文とボタンは動かさない
          <div className="space-y-3 md:max-h-[60vh] md:overflow-y-auto md:pr-1">
            {!settings.returnAddressSet ? (
              <p className="font-acumin lk-text-3xs text-red-700">{RETURN_ERROR_MESSAGES.RETURN_ADDRESS_REQUIRED.message}</p>
            ) : null}
            {materials.order.hasAwaitingRefund ? (
              <p className="font-acumin lk-text-3xs text-[#474747]">{REFUND_ERROR_MESSAGES.awaiting_refund_exists.message}</p>
            ) : null}
            {noReturnable ? (
              <p className="font-acumin lk-text-sm text-black">{RETURN_ERROR_MESSAGES.ORDER_NOT_RETURNABLE.message}</p>
            ) : null}

            {visibleShipments.map(({ shipment, lines }) => {
              const headingId = `return-shipment-${shipment.fulfillmentId}`;
              return (
                <section key={shipment.fulfillmentId} aria-labelledby={headingId} className="space-y-2">
                  <h4 id={headingId} className="font-acumin lk-text-sm text-black">
                    {`${shipment.number}回目の発送（${monthDay(shipment.shippedAt)}発送）`}
                  </h4>
                  <p className={shipment.pastDeadline ? 'font-acumin lk-text-3xs text-amber-800' : 'font-acumin lk-text-3xs text-[#474747]'}>
                    {deadlineText(shipment)}
                  </p>
                  <ul className="space-y-3">
                    {lines.map((line) => {
                      const key = lineKey(shipment.fulfillmentId, line.orderItemId);
                      return (
                        <ReturnLineFields
                          key={key}
                          idPrefix={`return-line-${shipment.fulfillmentId}-${line.orderItemId}`}
                          line={line}
                          input={inputs[key] ?? EMPTY_LINE_INPUT}
                          variants={usableVariants(materials, line.itemId)}
                          disabled={stopped}
                          onChange={(patch) => updateLine(key, patch)}
                        />
                      );
                    })}
                  </ul>
                </section>
              );
            })}

            <section aria-labelledby="return-shipping-heading" className="space-y-2">
              <h4 id="return-shipping-heading" className="font-acumin lk-text-sm text-black">
                返送
              </h4>
              <SingleSelect
                id="return-method"
                label="返送の方法"
                options={methodOptions}
                value={method}
                disabled={stopped}
                onChange={(event) => {
                  const next = pick(RETURN_METHODS, event.target.value);
                  if (next) setMethodEntered(next);
                }}
              />
              {method !== 'not_required' ? (
                <>
                  <SingleSelect
                    id="return-payer"
                    label="返送料の負担"
                    options={PAYER_OPTIONS}
                    value={payer}
                    disabled={stopped}
                    onChange={(event) => {
                      const next = pick(PAYERS, event.target.value);
                      if (next) setPayerEntered(next);
                    }}
                  />
                  <SingleSelect
                    id="return-carrier"
                    label="返送の配送業者（任意）"
                    options={CARRIER_OPTIONS}
                    placeholder="指定しない"
                    value={carrier}
                    disabled={stopped}
                    onChange={(event) => setCarrier(pick(RETURN_CARRIERS, event.target.value) ?? '')}
                  />
                  <TextField
                    id="return-tracking"
                    label="返送の伝票番号（任意）"
                    value={trackingNumber}
                    maxLength={64}
                    disabled={stopped}
                    errorText={trackingInvalid ? TRACKING_INVALID_MESSAGE : undefined}
                    onChange={(event) => setTrackingNumber(event.target.value)}
                  />
                </>
              ) : null}
            </section>

            {showShippingFee || showRestocking || showExchangeFees ? (
              <section aria-labelledby="return-fees-heading" className="space-y-2">
                <h4 id="return-fees-heading" className="font-acumin lk-text-sm text-black">
                  手数料
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  {showShippingFee ? (
                    <NumberField
                      id="return-shipping-fee"
                      label="返送料（円）"
                      value={shippingFee}
                      max={FEE_MAX_YEN}
                      overMaxMessage={FEE_OVER_MAX_MESSAGE}
                      disabled={stopped}
                      onChange={(next) => updateFees({ shipping: next })}
                    />
                  ) : null}
                  {showRestocking ? (
                    <TextField
                      id="return-restocking-percent"
                      label="返品の手数料（%）"
                      value={restockingPercentText}
                      inputMode="numeric"
                      disabled={stopped}
                      errorText={restockingPercentInvalid ? PERCENT_MESSAGE : undefined}
                      onChange={(event) => updateFees({ restockingPercent: event.target.value })}
                    />
                  ) : null}
                  {showExchangeFees ? (
                    <>
                      <NumberField
                        id="return-exchange-fee"
                        label="交換の手数料（円）"
                        value={exchangeFee}
                        max={FEE_MAX_YEN}
                        overMaxMessage={FEE_OVER_MAX_MESSAGE}
                        disabled={stopped}
                        onChange={(next) => updateFees({ exchange: next })}
                      />
                      <NumberField
                        id="return-exchange-shipping-fee"
                        label="交換の送料（円）"
                        value={exchangeShippingFee}
                        max={FEE_MAX_YEN}
                        overMaxMessage={FEE_OVER_MAX_MESSAGE}
                        disabled={stopped}
                        onChange={(next) => updateFees({ exchangeShipping: next })}
                      />
                    </>
                  ) : null}
                </div>
              </section>
            ) : null}

            <TextAreaField
              label="メモ（お客様には見えません）"
              value={note}
              rows={3}
              maxLength={ADMIN_NOTE_MAX_LENGTH}
              disabled={stopped}
              onChange={(event) => setNote(event.target.value)}
            />
            <Checkbox
              label="お客様に返品の受付のお知らせを送る"
              checked={notifyCustomer}
              disabled={stopped}
              onChange={(event) => setNotifyCustomer(event.target.checked)}
            />
          </div>
        ) : null}

        {alertText ? (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {alertText}
          </p>
        ) : null}

        {loadError ? (
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={close}>
              閉じる
            </Button>
          </div>
        ) : uncertain ? (
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={busy} onClick={close}>
              閉じる
            </Button>
            <Button variant="primary" size="sm" className="w-full font-acumin" disabled={busy} onClick={checkAgain}>
              もう一度確かめる
            </Button>
          </div>
        ) : (
          <div className="flex flex-col-reverse gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={busy} onClick={close}>
              戻る
            </Button>
            <Button type="submit" variant="primary" size="sm" className="w-full font-acumin" disabled={!canSubmit}>
              返品を作る
            </Button>
          </div>
        )}
      </form>
    </Dialog>
  );
}
