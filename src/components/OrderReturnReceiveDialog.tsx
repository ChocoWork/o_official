'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { ReturnFlowContent, ReturnLoadDialog, ReturnRefundFields, type ReturnDialogProps } from '@/components/ReturnDialogParts';
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';
import { TextField } from '@/components/ui/TextField/TextField';
import { useLoadedReturn, type LoadedReturn } from '@/hooks/useLoadedReturn';
import { blockEnterSubmit } from '@/hooks/useRefundSubmission';
import { parseActionResponse, readRecord, useReturnOperation, type ReturnActionResponse } from '@/hooks/useReturnOperation';
import { lineLabel } from '@/lib/orders/fulfillment/fulfillment-client';
import { formatYen } from '@/lib/orders/refund/refund-messages';
import { buildReceiveButtonLabel, computeReturnRefundPreview } from '@/lib/orders/returns/return-calc';
import {
  DISPOSITION_LABELS,
  RETURN_CARRIER_LABELS,
  RETURN_ERROR_MESSAGES,
  RETURN_REASON_LABELS,
} from '@/lib/orders/returns/return-messages';
import {
  RETURN_CARRIERS,
  RETURN_STATUSES,
  type OrderReturnDetail,
  type OrderReturnLineDetail,
  type ReceiptDisposition,
  type RefundChoice,
  type ReturnCarrier,
  type ReturnStatus,
} from '@/lib/orders/returns/return-types';

/**
 * 受け取りの窓口が返す `data`（C-3）。返金が無い受け取りは refundId・refundAmount・refundStatus が null。
 * 返金額が0円になる受け取り（P20）は、返金を作らず refundId が null、refundAmount が 0、refundStatus が 'waived'（Task 7）
 */
export type ReceiveReturnResponse = {
  receiptId: string;
  returnStatus: ReturnStatus;
  refundId: string | null;
  refundAmount: number | null;
  refundStatus: 'pending' | 'succeeded' | 'waived' | null;
  feeDueAmount: number;
  replayed: boolean;
};

/** 受け取りの画面が親に返す結果。受け取りを記録した時と、残りを「届かない」として返品を終えた時 */
export type ReceiveDialogResult =
  | { kind: 'received'; response: ReceiveReturnResponse }
  | { kind: 'closed_missing'; response: ReturnActionResponse };

type ExchangeOverride = 'make' | 'refund';

/** 受け取りの窓口へ送る本文。C-1 の admin_receive_return の引数を camelCase にした物（返品の番号は URL、人と権限は窓口が決める） */
export type ReceiveReturnRequest = {
  requestKey: string;
  units: Array<{ returnLineId: string; disposition: ReceiptDisposition; quantity: number }>;
  exchangeOverrides: Array<{ returnLineId: string; action: ExchangeOverride }>;
  refundChoice: RefundChoice;
  refundAmount: number | null;
  refundShippingAmount: number;
  note: string | null;
  notifyCustomer: boolean;
  sentBackMessage: string | null;
  sentBackCarrier: ReturnCarrier | null;
  sentBackTrackingNumber: string | null;
};

type OrderReturnReceiveDialogBodyProps = Pick<ReturnDialogProps, 'onClose' | 'onDone' | 'onUncertain'> & {
  loaded: LoadedReturn;
  /** 在庫不足で断られた時（在庫が戻った行への上書きの断り RETURN_ARGUMENT_INVALID を含む）に、入力を残して返品を読み直す（内部の部品だけ） */
  onReload?: () => void;
  reloading?: boolean;
  reloadError?: string | null;
};

type RowState = { checked: boolean; disposition: ReceiptDisposition | '' };
type UnitRow = { key: string; line: OrderReturnLineDetail; index: number };
type LineTally = { kept: number; sentBack: number; byDisposition: Partial<Record<ReceiptDisposition, number>> };
type ExchangeInfo = NonNullable<OrderReturnLineDetail['exchange']>;
// 交換の品の在庫の足りなさ。make は設定で「作って送る」に自動で変わる、choose は店長が選ぶ
type Shortage = 'none' | 'make' | 'choose';
type Step = 'form' | 'confirm' | 'missing';

// 割引・手数料の行の符号は U+2212（ハイフンではなくマイナス記号）
const MINUS = '\u2212';
const UNKNOWN_RECEIVE_MESSAGE =
  '受け取りの結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';
const CONSULT_HINT =
  '着た跡や付属品の不足などで、お客様と相談して額を決める時に選びます。受け取りだけを記録し、返品は「返金待ち」になります。';
const SUPPORT_REFUND_NOTICE = '返金は店長が行います（受け取ると「返金待ち」になります）。';
// サポートが、お客様の申し込みの返品（返送不要でない）を受け取る時の相談の選びの言葉（C-5）。今返金の言葉は店長の選びと同じ「計算どおり {額} を返金する」
const SUPPORT_CONSULT_LABEL = '額を相談してから返金する（店長が額を決めます）';
const MAKE_REASON = '在庫が足りないため、作ってお送りします。';
const CHOOSE_NOTICE = '在庫が足りません。「作って送る」か「返金に変える」を選んでください。';
const SUPPORT_STOCK_NOTICE = '在庫が足りません。この品は店長が受け取ります。';
const SENT_BACK_CONFIRM = 'お客様にメッセージが届きます。取り消せません。';
// 伝票番号の形は E-1 の追跡番号と同じ（P16）。C-5 に誤りの文が無いので、ここで決めた物
const TRACKING_NUMBER_PATTERN = /^[0-9A-Za-z-]{1,64}$/;
const TRACKING_NUMBER_ERROR = '伝票番号は英数字とハイフンで入力してください。';
// DB の order_return_receipts.sent_back_message の上限
const SENT_BACK_MESSAGE_MAX_LENGTH = 1000;
const PLACEHOLDER = '選択してください';
const NO_CARRIER = '指定しない';

const RECEIVE_NOTICES = {
  recorded: '受け取りを記録しました。',
  accepted: '受け取りを記録し、返金を受け付けました。',
  refunded: '受け取りを記録し、返金しました。',
  // C-5 に無い。残りを「届かない」として終えた後の知らせ
  closedMissing: '「届かない」として返品を終えました。',
} as const;

// 選択肢の並びは C-5 の「品の状態」の順。検品待ちは要検品の設定がオンの時だけ足す
const DISPOSITION_ORDER: readonly ReceiptDisposition[] = ['restocked', 'not_restocked', 'sent_back', 'pending_inspection'];
const dispositionOptionsOf = (values: readonly ReceiptDisposition[]) => values.map((value) => ({ value, label: DISPOSITION_LABELS[value] }));
// 選択肢は画面の外で1度だけ作る（SingleSelect は選択肢が変わるたびに計り直すため、描画のたびに作り直さない）
const DISPOSITION_OPTIONS = dispositionOptionsOf(DISPOSITION_ORDER.filter((value) => value !== 'pending_inspection'));
const DISPOSITION_OPTIONS_WITH_INSPECTION = dispositionOptionsOf(DISPOSITION_ORDER);
const CARRIER_OPTIONS = RETURN_CARRIERS.map((carrier) => ({ value: carrier, label: RETURN_CARRIER_LABELS[carrier] }));

function isDisposition(value: string): value is ReceiptDisposition {
  return (DISPOSITION_ORDER as readonly string[]).includes(value);
}

function isCarrier(value: string): value is ReturnCarrier {
  return (RETURN_CARRIERS as readonly string[]).includes(value);
}

/** 受け取りの窓口の答えを、画面が使う形に読む。形が違えば null（答えが分からない時と同じに扱う） */
function parseReceiveResponse(data: unknown): ReceiveReturnResponse | null {
  const record = readRecord(data);
  if (!record || typeof record.receiptId !== 'string' || typeof record.returnStatus !== 'string') return null;
  if (!(RETURN_STATUSES as readonly string[]).includes(record.returnStatus)) return null;
  return {
    receiptId: record.receiptId,
    returnStatus: record.returnStatus as ReturnStatus,
    refundId: typeof record.refundId === 'string' ? record.refundId : null,
    refundAmount: typeof record.refundAmount === 'number' ? record.refundAmount : null,
    refundStatus:
      record.refundStatus === 'pending' || record.refundStatus === 'succeeded' || record.refundStatus === 'waived'
        ? record.refundStatus
        : null,
    feeDueAmount: typeof record.feeDueAmount === 'number' ? record.feeDueAmount : 0,
    replayed: record.replayed === true,
  };
}

/** 受け取りを記録した後に、親が出す知らせ（C-5）。返金が無い受け取りと、返金なしで記録した受け取り（waived）は同じ言葉 */
export function receiveNoticeOf(result: ReceiveDialogResult): string {
  if (result.kind === 'closed_missing') return RECEIVE_NOTICES.closedMissing;
  const { refundId, refundStatus } = result.response;
  if (refundId === null) return RECEIVE_NOTICES.recorded;
  return refundStatus === 'succeeded' ? RECEIVE_NOTICES.refunded : RECEIVE_NOTICES.accepted;
}

/** まだ処理していない品を1点ずつ並べる（受け取り済み・届かないの品は、固定の行として別に出す） */
function selectableRows(detail: OrderReturnDetail): UnitRow[] {
  return detail.lines.flatMap((line) =>
    Array.from({ length: line.progress.unprocessed }, (_, index) => ({ key: `${line.id}-${index}`, line, index })),
  );
}

/** チェックして状態を選んだ行を、返品の行ごと・状態ごとに数える */
function tallyOf(rows: readonly UnitRow[], states: Record<string, RowState>): Record<string, LineTally> {
  const tally: Record<string, LineTally> = {};
  for (const { key, line } of rows) {
    const state = states[key];
    if (!state || !state.checked || state.disposition === '') continue;
    const entry = tally[line.id] ?? { kept: 0, sentBack: 0, byDisposition: {} };
    if (state.disposition === 'sent_back') entry.sentBack += 1;
    else entry.kept += 1;
    entry.byDisposition[state.disposition] = (entry.byDisposition[state.disposition] ?? 0) + 1;
    tally[line.id] = entry;
  }
  return tally;
}

function variantText(color: string | null, size: string | null): string {
  return [color, size].filter((part): part is string => Boolean(part)).join(' / ');
}

/** 行の解決。「返金」「交換: 黒 / XL（在庫から）」（返品の画面と同じ言葉） */
function resolutionText(line: OrderReturnLineDetail): string {
  if (line.resolution === 'refund') return '返金';
  const exchange = line.exchange;
  if (exchange === null) return '交換';
  return `交換: ${variantText(exchange.color, exchange.size)}（${exchange.method === 'stock' ? '在庫から' : '作って送る'}）`;
}

/** 前の受け取りで処理した行の言葉。固定の行に出す */
function processedLabels(line: OrderReturnLineDetail): string[] {
  const { restocked, notRestocked, pendingInspection, sentBack, missing, unprocessed } = line.progress;
  const labels = [
    ...Array<string>(restocked + notRestocked).fill('受け取り済み'),
    ...Array<string>(pendingInspection).fill('検品待ち'),
    ...Array<string>(sentBack).fill('お返し'),
    ...Array<string>(missing).fill('届かない'),
  ];
  const fixedCount = line.quantity - unprocessed;
  while (labels.length < fixedCount) labels.push('受け取り済み');
  return labels.slice(0, fixedCount);
}

function exchangeMethodText(exchange: ExchangeInfo, method: 'stock' | 'make'): string {
  if (method === 'stock') return `在庫から（在庫 ${exchange.stockQuantity}）`;
  return exchange.madeToOrderLeadDays === null ? '作って送る' : `作って送る（お届けの目安 ${exchange.madeToOrderLeadDays}日）`;
}

function UnitRowFrame({ line, children }: { line: OrderReturnLineDetail; children: ReactNode }) {
  const label = lineLabel({ name: line.itemName, color: line.color, size: line.size });
  return (
    <li>
      <div role="group" aria-label={label} className="space-y-2 border border-[#d4d4d4] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-acumin lk-text-sm text-black">{label}</span>
          <TagLabel variant="outline" size="2xs">
            {resolutionText(line)}
          </TagLabel>
        </div>
        <p className="font-acumin lk-text-3xs text-[#474747]">{`理由: ${RETURN_REASON_LABELS[line.reason]}`}</p>
        {children}
      </div>
    </li>
  );
}

type SelectableUnitProps = {
  line: OrderReturnLineDetail;
  state: RowState;
  /** チェックできない理由の文（サポートが、在庫を超える交換の品を受け取ろうとした時）。無ければ null */
  blockedText: string | null;
  disabled: boolean;
  dispositionOptions: Array<{ value: string; label: string }>;
  onToggle: (checked: boolean) => void;
  onSelect: (value: string) => void;
};

function SelectableUnit({ line, state, blockedText, disabled, dispositionOptions, onToggle, onSelect }: SelectableUnitProps) {
  return (
    <UnitRowFrame line={line}>
      <Checkbox
        label="届いた"
        checked={state.checked}
        disabled={disabled || blockedText !== null}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <SingleSelect
        label="品の状態"
        placeholder={PLACEHOLDER}
        options={dispositionOptions}
        value={state.disposition}
        disabled={disabled || !state.checked}
        onChange={(event) => onSelect(event.target.value)}
      />
      {blockedText ? <p className="font-acumin lk-text-3xs text-[#474747]">{blockedText}</p> : null}
    </UnitRowFrame>
  );
}

/**
 * 受け取りの画面（グループ E-3 設計書 6-1。Shopify の返品の処理に合わせる）。
 * まだ処理していない品を1点ずつ並べ、届いた品にチェックを入れて状態を選ぶ。返金の欄（今返金・額を相談）・交換の品・お返し・
 * 残りを「届かない」として終える、を1つの画面で行う。返金の見込みは DB と同じ式（return-calc）で出し、DB が受け取りの時に計算し直す。
 * 開く時に、注文の返品の窓口を読んで返品の中身を得る（useLoadedReturn）。親が開くたびに描き直す（閉じたら外す）ので、
 * 二重防止の番号も入力も開くたびに新しくなる。受け取りを記録したら onDone(C-5 の後の知らせ) を呼ぶ。閉じるのは親。
 */
export default function OrderReturnReceiveDialog({ orderId, returnId, onClose, onDone, onUncertain }: ReturnDialogProps) {
  const { state, reload, reloading, reloadError } = useLoadedReturn(orderId, returnId);
  if (state.kind !== 'ready') return <ReturnLoadDialog state={state} title="受け取る" onClose={onClose} />;
  return <OrderReturnReceiveDialogBody key={state.detail.id} loaded={state} onReload={reload} reloading={reloading} reloadError={reloadError} onClose={onClose} onDone={onDone} onUncertain={onUncertain} />;
}

function OrderReturnReceiveDialogBody({ loaded, onReload, reloading = false, reloadError = null, onClose, onDone, onUncertain }: OrderReturnReceiveDialogBodyProps) {
  const { detail, canRefund, refundableAmount, refundableShipping, inspectionEnabled } = loaded;
  const flow = useReturnOperation({
    unknownMessage: UNKNOWN_RECEIVE_MESSAGE,
    fallbackMessage: RETURN_ERROR_MESSAGES.RETURN_ARGUMENT_INVALID.message,
    onClose,
    onUncertain,
    onRefused: (code) => {
      // 在庫不足の断り。画面を開いた後に同じ色・サイズの在庫が戻った行へ上書きを送ると、DB は足りる行への上書きを
      // RETURN_ARGUMENT_INVALID で断る。どちらも返品を読み直して今の在庫で数え直す（足りるようになった行の上書きは overrideOf が送らない）
      if (code === 'RETURN_EXCHANGE_OUT_OF_STOCK' || code === 'RETURN_ARGUMENT_INVALID') {
        setStep('form');
        setAmountEntered(null);
        onReload?.();
      }
    },
  });
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [overrides, setOverrides] = useState<Record<string, ExchangeOverride>>({});
  const [refundChoice, setRefundChoice] = useState<'now' | 'consult'>('now');
  const [shippingEntered, setShippingEntered] = useState(0);
  // 返金額を手で直した時だけ入る。行・送料・選びを変えたら空に戻し、見込みの額に追い付かせる
  const [amountEntered, setAmountEntered] = useState<number | null>(null);
  const [sentBackMessage, setSentBackMessage] = useState('');
  const [sentBackCarrier, setSentBackCarrier] = useState<ReturnCarrier | ''>('');
  const [sentBackTracking, setSentBackTracking] = useState('');
  const [notifyCustomer, setNotifyCustomer] = useState(true);
  const [step, setStep] = useState<Step>('form');

  const stopped = flow.busy || flow.uncertain || flow.recorded || reloading;
  const rows = selectableRows(detail);
  const tally = tallyOf(rows, rowStates);
  const checkedCount = rows.filter((row) => rowStates[row.key]?.checked).length;
  const undecidedCount = rows.filter((row) => rowStates[row.key]?.checked && rowStates[row.key]?.disposition === '').length;
  const remaining = rows.length - checkedCount;
  const totalUnits = detail.lines.reduce((sum, line) => sum + line.quantity, 0);
  const arrivedBefore = detail.lines.reduce(
    (sum, line) => sum + line.progress.restocked + line.progress.notRestocked + line.progress.pendingInspection + line.progress.sentBack,
    0,
  );
  const dispositionOptions = inspectionEnabled ? DISPOSITION_OPTIONS_WITH_INSPECTION : DISPOSITION_OPTIONS;

  const keptOf = (line: OrderReturnLineDetail) => tally[line.id]?.kept ?? 0;
  // GET の lines の順を保つ（Task 2: fulfillment_number, item_created_at, order_item_id, resolution, id）。
  // DB（Task 3）も同じ返品の行の順で在庫を前から割り当てる（Global Constraints の「返品の行の並び」）
  const availableByLine = new Map<string, number>();
  const shortageByLine = new Map<string, Shortage>();
  const leftByVariant = new Map<number, number>();
  for (const line of detail.lines) {
    const exchange = line.exchange;
    if (line.resolution !== 'exchange' || exchange === null || exchange.method !== 'stock') continue;
    const available = leftByVariant.get(exchange.variantId) ?? exchange.stockQuantity;
    availableByLine.set(line.id, available);
    // サポートは状態を選ぶ前のチェックも数える。お返しは在庫を使わない。
    const picked = canRefund ? keptOf(line) : rows.filter((row) =>
      row.line.id === line.id && rowStates[row.key]?.checked && rowStates[row.key]?.disposition !== 'sent_back',
    ).length;
    const short = picked > available;
    shortageByLine.set(line.id, short ? (exchange.outOfStockExchange === 'make' ? 'make' : 'choose') : 'none');
    // 足りない行は行全体が make/refund になり、在庫を減らさない。元から make の行はこのループの対象外。
    leftByVariant.set(exchange.variantId, short ? available : available - picked);
  }
  const shortageOf = (line: OrderReturnLineDetail): Shortage => shortageByLine.get(line.id) ?? 'none';
  const overrideOf = (line: OrderReturnLineDetail): ExchangeOverride | undefined => {
    if (!canRefund) return undefined;
    const shortage = shortageOf(line);
    if (shortage === 'choose') return overrides[line.id];
    // make の理由は「作って送る」が最初の値。refund を選んだ時だけ送る。
    return shortage === 'make' && overrides[line.id] === 'refund' ? 'refund' : undefined;
  };
  const unresolvedCount = detail.lines.filter((line) =>
    canRefund && shortageOf(line) === 'choose' && overrides[line.id] === undefined,
  ).length;
  const capOf = (line: OrderReturnLineDetail): number => {
    const exchange = line.exchange;
    return !canRefund && line.resolution === 'exchange' && exchange !== null && exchange.method === 'stock' && exchange.outOfStockExchange === 'decline'
      ? availableByLine.get(line.id) ?? 0
      : Number.POSITIVE_INFINITY;
  };
  // 後ろを先にチェックしてから前を増やした場合も、上限を超えたまま送れない。チェックは外せる。
  const supportStockExceeded = !canRefund && detail.lines.some((line) =>
    line.exchange?.outOfStockExchange === 'decline' && shortageOf(line) === 'choose',
  );

  let refundUnits = 0;
  let exchangeUnits = 0;
  let sentBackUnits = 0;
  const refundSources: Array<{ orderItemId: string; refundAmountsByCount: number[]; count: number }> = [];
  for (const line of detail.lines) {
    const entry = tally[line.id];
    if (!entry) continue;
    sentBackUnits += entry.sentBack;
    if (entry.kept === 0) continue;
    if (overrideOf(line) === 'refund' || line.resolution === 'refund') {
      refundUnits += entry.kept;
      // 額の表は、その注文の商品について今から k 点を返金した時の額で、同じ注文の商品を指す行は同じ列を持つ（C-2）。
      // 返金に変えた交換の行も、返金の行と同じ表を使う（C-2 が交換の予定の行にも入れる）。行ごとに orderItemId を付けて渡し、
      // 同じ orderItemId の行は computeReturnRefundPreview が数を足してから列を引く（DB の受け取りと同じ。行ごとに引くと割引の端数で1円ずれる）。
      // 表が点数より短い時は、足りない分を見込みに入れない。最後に額を決めるのは DB（受け取りの時に計算し直す）
      refundSources.push({
        orderItemId: line.orderItemId,
        refundAmountsByCount: line.refundAmountsByCount,
        count: Math.min(entry.kept, line.refundAmountsByCount.length),
      });
    } else {
      exchangeUnits += entry.kept;
    }
  }

  const shippingAmount = Math.min(shippingEntered, refundableShipping);
  const preview = computeReturnRefundPreview({
    lines: refundSources,
    firstReceipt: !detail.firstReceiptDone,
    hasExchangeInThisReceipt: exchangeUnits > 0,
    firstExchangeReceipt: !detail.firstExchangeReceiptDone,
    returnMethod: detail.returnMethod,
    returnShippingFee: detail.fees.returnShippingFee,
    restockingFeePercent: detail.fees.restockingFeePercent,
    exchangeFee: detail.fees.exchangeFee,
    exchangeShippingFee: detail.fees.exchangeShippingFee,
    shippingRefund: shippingAmount,
  });
  // サポート（返金の権限が無い人）の今返金は、お客様の申し込みの返品（返送不要でない）を受け取る時だけ許される（P9。DB も同じ条件で断る）。
  // 額・送料・在庫不足の上書きは変えられず、窓口でも DB でも断られるので、画面は入力を出さず、額は DB が計算する
  const supportAutoRefund = !canRefund && detail.source === 'customer_request' && detail.returnMethod !== 'not_required';
  // 返金の品が無ければ none。サポートは、自動の返金が許される返品なら今返金か相談を選べ、ほかの返品は相談（返金待ち）
  const effectiveChoice: RefundChoice = refundUnits === 0 ? 'none' : canRefund || supportAutoRefund ? refundChoice : 'consult';
  const amount = Math.min(refundableAmount, amountEntered ?? preview.refundAmount);
  const breakdownRows: Array<[string, string]> = [['商品', formatYen(preview.itemsAmount)]];
  if (preview.fees.returnShipping > 0) breakdownRows.push(['返送料', `${MINUS}${formatYen(preview.fees.returnShipping)}`]);
  if (preview.fees.restocking > 0) breakdownRows.push(['返品の手数料', `${MINUS}${formatYen(preview.fees.restocking)}`]);
  if (preview.fees.exchange > 0) breakdownRows.push(['交換の手数料', `${MINUS}${formatYen(preview.fees.exchange)}`]);
  if (preview.fees.exchangeShipping > 0) breakdownRows.push(['交換の送料', `${MINUS}${formatYen(preview.fees.exchangeShipping)}`]);
  breakdownRows.push(['送料', formatYen(shippingAmount)], ['返金額', formatYen(preview.refundAmount)]);

  const feesTotal = preview.fees.returnShipping + preview.fees.restocking + preview.fees.exchange + preview.fees.exchangeShipping;
  const feeDuePreview = effectiveChoice === 'now' ? preview.feeDue : effectiveChoice === 'none' ? feesTotal : 0;
  const feeDueNotice = feeDuePreview > 0
    ? <p className="font-acumin lk-text-sm text-black">{`お支払い待ち ${formatYen(feeDuePreview)}（交換の品は、お支払いを確かめてから送ります）`}</p>
    : null;

  const trimmedMessage = sentBackMessage.trim();
  const trimmedTracking = sentBackTracking.trim();
  const trackingInvalid = trimmedTracking !== '' && !TRACKING_NUMBER_PATTERN.test(trimmedTracking);
  const sentBackInvalid = sentBackUnits > 0 && (trimmedMessage === '' || trackingInvalid);
  // DB は「送料 ≤ 額」を入力の誤りにする。画面に新しい文は足さず、直るまで押せなくする（E-2 の返金の画面と同じ）。
  // 返金額が0円（手数料が商品の額以上か、店長が0に直した）の時は押せる。DB は返金を作らず、受け取りだけを記録する（P20）。
  // 押すボタンの言葉は buildReceiveButtonLabel が「返金なしで記録する」にする
  const amountInvalid = effectiveChoice === 'now' && amount < shippingAmount;
  const canSubmitForm =
    !stopped && checkedCount >= 1 && undecidedCount === 0 && !sentBackInvalid && unresolvedCount === 0 && !amountInvalid && !supportStockExceeded && reloadError === null;
  // 一部だけ届いた時と、お返しを含む時は、送る前に確かめを挟む
  const needsConfirm = sentBackUnits > 0 || remaining > 0;

  const formLabel = buildReceiveButtonLabel({
    checked: checkedCount,
    // Task 4 の remaining は今回チェックする前の未処理の全部の点数
    remaining: rows.length,
    refundUnits,
    exchangeUnits,
    sentBackUnits,
    refundChoice: effectiveChoice,
    refundAmount: canRefund ? amount : preview.refundAmount,
    actorCanRefund: canRefund,
  });
  const submitLabel = step === 'missing' ? '返品を終える' : step === 'confirm' ? (sentBackUnits > 0 ? 'お返しする' : '記録する') : formLabel;
  const canSubmit = step === 'missing' ? !stopped : canSubmitForm;

  const changeRow = (key: string, next: RowState) => {
    setRowStates((previous) => ({ ...previous, [key]: next }));
    setAmountEntered(null);
  };

  const buildBody = (requestKey: string): ReceiveReturnRequest => ({
    requestKey,
    units: detail.lines.flatMap((line) =>
      DISPOSITION_ORDER.flatMap((disposition) => {
        const quantity = tally[line.id]?.byDisposition[disposition] ?? 0;
        return quantity > 0 ? [{ returnLineId: line.id, disposition, quantity }] : [];
      }),
    ),
    exchangeOverrides: detail.lines.flatMap((line) => {
      const action = overrideOf(line);
      return action ? [{ returnLineId: line.id, action }] : [];
    }),
    refundChoice: effectiveChoice,
    // 見込みと同じ額なら送らない（DB が同じ式で計算する）。手で直した額と、返せる額で切った額だけを送る
    refundAmount: effectiveChoice === 'now' && canRefund && amount !== preview.refundAmount ? amount : null, // サポートは額を送らない（DB が計算する。P9）
    refundShippingAmount: effectiveChoice === 'now' && canRefund ? shippingAmount : 0,
    note: null,
    // お返しのメッセージを伝えるため、お返しを含む時は必ず送る
    notifyCustomer: sentBackUnits > 0 ? true : notifyCustomer,
    sentBackMessage: sentBackUnits > 0 ? trimmedMessage : null,
    sentBackCarrier: sentBackUnits > 0 && sentBackCarrier !== '' ? sentBackCarrier : null,
    sentBackTrackingNumber: sentBackUnits > 0 && trimmedTracking !== '' ? trimmedTracking : null,
  });

  const sendReceive = () => {
    flow.submit(`/api/admin/returns/${detail.id}/receive`, buildBody, (data) => {
      const response = parseReceiveResponse(data);
      if (response === null) return false;
      onDone(receiveNoticeOf({ kind: 'received', response }));
      return true;
    });
  };

  const sendCloseMissing = () => {
    flow.submit(
      `/api/admin/returns/${detail.id}/close-missing`,
      (requestKey) => ({ requestKey }),
      (data) => {
        const response = parseActionResponse(data);
        if (response === null) return false;
        onDone(receiveNoticeOf({ kind: 'closed_missing', response }));
        return true;
      },
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    if (step === 'missing') {
      sendCloseMissing();
      return;
    }
    if (step === 'form' && needsConfirm) {
      setStep('confirm');
      return;
    }
    sendReceive();
  };

  const exchangeBlocks = detail.lines.flatMap((line) => {
    const exchange = line.exchange;
    return line.resolution === 'exchange' && exchange !== null && keptOf(line) > 0 ? [{ line, exchange, count: keptOf(line) }] : [];
  });

  return (
    <Dialog open onClose={flow.close} title={`受け取る（${detail.label}）`} fullScreenOnMobile>
      <form className="space-y-3" onSubmit={handleSubmit} onKeyDown={blockEnterSubmit}>
        <ReturnFlowContent
          flow={flow}
          backLabel="戻る"
          onBack={step === 'form' ? undefined : () => setStep('form')}
          submitLabel={submitLabel}
          canSubmit={canSubmit}
        >
          {reloading ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}
          {reloadError ? (
            <div className="space-y-2">
              <p role="alert" className="font-acumin lk-text-3xs text-red-700">{reloadError}</p>
              <Button variant="secondary" size="sm" disabled={stopped} onClick={onReload}>もう一度読み込む</Button>
            </div>
          ) : null}
          {supportStockExceeded ? <p className="font-acumin lk-text-3xs text-[#474747]">{SUPPORT_STOCK_NOTICE}</p> : null}

          {step === 'confirm' ? (
            <div className="space-y-2">
              {remaining > 0 ? (
                <p className="font-acumin lk-text-sm text-black">{`まだ届いていない商品が ${remaining} 点あります。届いた分だけ記録し、残りは受付中のまま残ります。`}</p>
              ) : null}
              {sentBackUnits > 0 ? <p className="font-acumin lk-text-sm text-black">{SENT_BACK_CONFIRM}</p> : null}
            </div>
          ) : null}

          {step === 'missing' ? (
            <p className="font-acumin lk-text-sm text-black">{`届いていない ${rows.length} 点を「届かない」として返品を終えます。この品は返金も交換もしません。`}</p>
          ) : null}

          {step === 'form' ? (
            // 幅が 768px 以上の Dialog は高さを制限しないので、入力の部分だけを縦に動かし、誤りの文とボタンは動かさない
            <div className="space-y-3 md:max-h-[60vh] md:overflow-y-auto md:pr-1">
              <p className="font-acumin lk-text-sm text-black">{`${totalUnits}点中${arrivedBefore + checkedCount}点を確認`}</p>

              <ul aria-label="受け取る品" className="space-y-3">
                {detail.lines.flatMap((line) => [
                  ...processedLabels(line).map((text, index) => (
                    <UnitRowFrame key={`${line.id}-done-${index}`} line={line}>
                      <p className="font-acumin lk-text-3xs text-black">{text}</p>
                    </UnitRowFrame>
                  )),
                  ...rows
                    .filter((row) => row.line.id === line.id)
                    .map((row) => (
                      <SelectableUnit
                        key={row.key}
                        line={line}
                        state={rowStates[row.key] ?? { checked: false, disposition: '' }}
                        blockedText={!rowStates[row.key]?.checked && row.index >= capOf(line) ? SUPPORT_STOCK_NOTICE : null}
                        disabled={stopped}
                        dispositionOptions={dispositionOptions}
                        onToggle={(checked) =>
                          changeRow(row.key, { checked, disposition: checked ? (rowStates[row.key]?.disposition ?? '') : '' })
                        }
                        onSelect={(value) =>
                          changeRow(row.key, { checked: rowStates[row.key]?.checked ?? false, disposition: isDisposition(value) ? value : '' })
                        }
                      />
                    )),
                ])}
              </ul>

              {sentBackUnits > 0 ? (
                <div role="group" aria-label="お返し" className="space-y-3 border border-[#d4d4d4] p-3">
                  <TextAreaField
                    label="お客様へのメッセージ（必須・お客様に届きます）"
                    value={sentBackMessage}
                    rows={3}
                    maxLength={SENT_BACK_MESSAGE_MAX_LENGTH}
                    disabled={stopped}
                    onChange={(event) => setSentBackMessage(event.target.value)}
                  />
                  <SingleSelect
                    label="送り返しの配送業者（任意）"
                    placeholder={NO_CARRIER}
                    options={CARRIER_OPTIONS}
                    value={sentBackCarrier}
                    disabled={stopped}
                    onChange={(event) => setSentBackCarrier(isCarrier(event.target.value) ? event.target.value : '')}
                  />
                  <TextField
                    label="送り返しの伝票番号（任意）"
                    type="text"
                    maxLength={64}
                    value={sentBackTracking}
                    disabled={stopped}
                    errorText={trackingInvalid ? TRACKING_NUMBER_ERROR : undefined}
                    onChange={(event) => setSentBackTracking(event.target.value)}
                  />
                </div>
              ) : null}

              {exchangeBlocks.length > 0 ? (
                <section aria-labelledby="return-receive-exchange-heading" className="space-y-2">
                  <h4 id="return-receive-exchange-heading" className="font-acumin lk-text-sm text-black">
                    交換の品
                  </h4>
                  {exchangeBlocks.map(({ line, exchange, count }) => {
                    const shortage = shortageOf(line);
                    const override = overrideOf(line);
                    const blockLabel = `${lineLabel({ name: line.itemName, color: exchange.color, size: exchange.size })} × ${count}`;
                    // 実際に送る方法。足りない時は、設定で作って送るに変わるか、店長が選んだ方になる。返金に変える・まだ選んでいない間は無い
                    const method =
                      override === 'refund'
                        ? null
                        : exchange.method === 'make' || shortage === 'make' || override === 'make'
                          ? 'make'
                        : shortage === 'none'
                          ? 'stock'
                          : null;
                    return (
                      <div key={line.id} role="group" aria-label={blockLabel} className="space-y-2 border border-[#d4d4d4] p-3">
                        <p className="font-acumin lk-text-sm text-black">{blockLabel}</p>
                        {method ? <p className="font-acumin lk-text-3xs text-[#474747]">{exchangeMethodText(exchange, method)}</p> : null}
                        {shortage === 'make' ? <p className="font-acumin lk-text-3xs text-[#474747]">{MAKE_REASON}</p> : null}
                        {canRefund && (shortage === 'choose' || shortage === 'make') ? (
                          <>
                            {shortage === 'choose' ? <p className="font-acumin lk-text-3xs text-[#474747]">{CHOOSE_NOTICE}</p> : null}
                            <div role="radiogroup" aria-label={blockLabel} className="space-y-1">
                              {(
                                [
                                  ['make', '作って送る'],
                                  ['refund', '返金に変える'],
                                ] as const
                              ).map(([value, text]) => (
                                <label key={value} className="flex min-h-9 cursor-pointer items-center gap-2">
                                  <input
                                    type="radio"
                                    name={`return-receive-exchange-${line.id}`}
                                    value={value}
                                    className="h-4 w-4 accent-black"
                                    checked={(shortage === 'make' ? override ?? 'make' : override) === value}
                                    disabled={stopped}
                                    onChange={() => {
                                      setOverrides((previous) => ({ ...previous, [line.id]: value }));
                                      setAmountEntered(null);
                                    }}
                                  />
                                  <span className="font-acumin lk-text-sm text-black">{text}</span>
                                </label>
                              ))}
                            </div>
                          </>
                        ) : null}
                      </div>
                    );
                  })}
                </section>
              ) : null}

              {refundUnits > 0 && canRefund ? (
                <fieldset className="space-y-2">
                  <legend className="font-acumin lk-text-sm text-black">返金</legend>
                  <label className="flex min-h-9 cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name="return-receive-refund-choice"
                      value="now"
                      className="h-4 w-4 accent-black"
                      checked={refundChoice === 'now'}
                      disabled={stopped}
                      onChange={() => setRefundChoice('now')}
                    />
                    <span className="font-acumin lk-text-sm text-black">{`計算どおり ${formatYen(preview.refundAmount)} を返金する`}</span>
                  </label>
                  <div>
                    <label className="flex min-h-9 cursor-pointer items-center gap-2">
                      <input
                        type="radio"
                        name="return-receive-refund-choice"
                        value="consult"
                        className="h-4 w-4 accent-black"
                        aria-describedby="return-receive-consult-hint"
                        checked={refundChoice === 'consult'}
                        disabled={stopped}
                        onChange={() => setRefundChoice('consult')}
                      />
                      <span className="font-acumin lk-text-sm text-black">額を相談してから返金する</span>
                    </label>
                    <p id="return-receive-consult-hint" className="ml-6 font-acumin lk-text-3xs text-[#474747]">
                      {CONSULT_HINT}
                    </p>
                  </div>
                </fieldset>
              ) : null}
              {refundUnits > 0 && supportAutoRefund ? (
                <fieldset className="space-y-2">
                  <legend className="font-acumin lk-text-sm text-black">返金</legend>
                  {refundChoice === 'now' ? (
                    <p className="font-acumin lk-text-sm text-black">{`受け取ると、計算どおり ${formatYen(preview.refundAmount)} を自動で返金します（額は変えられません）。`}</p>
                  ) : null}
                  <label className="flex min-h-9 cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name="return-receive-refund-choice"
                      value="now"
                      className="h-4 w-4 accent-black"
                      checked={refundChoice === 'now'}
                      disabled={stopped}
                      onChange={() => setRefundChoice('now')}
                    />
                    <span className="font-acumin lk-text-sm text-black">{`計算どおり ${formatYen(preview.refundAmount)} を返金する`}</span>
                  </label>
                  <label className="flex min-h-9 cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name="return-receive-refund-choice"
                      value="consult"
                      className="h-4 w-4 accent-black"
                      checked={refundChoice === 'consult'}
                      disabled={stopped}
                      onChange={() => setRefundChoice('consult')}
                    />
                    <span className="font-acumin lk-text-sm text-black">{SUPPORT_CONSULT_LABEL}</span>
                  </label>
                </fieldset>
              ) : null}
              {refundUnits > 0 && !canRefund && !supportAutoRefund ? (
                <p className="font-acumin lk-text-sm text-black">{SUPPORT_REFUND_NOTICE}</p>
              ) : null}
              {effectiveChoice === 'now' && canRefund ? (
                <ReturnRefundFields
                  idPrefix="return-receive"
                  rows={breakdownRows}
                  afterBreakdown={feeDueNotice}
                  amount={amount}
                  refundableAmount={refundableAmount}
                  onAmountChange={setAmountEntered}
                  shippingAmount={shippingAmount}
                  refundableShipping={refundableShipping}
                  onShippingChange={(next) => {
                    setShippingEntered(next);
                    setAmountEntered(null);
                  }}
                  disabled={stopped}
                />
              ) : null}

              {effectiveChoice === 'now' && !canRefund ? feeDueNotice : null}
              {effectiveChoice === 'none' && feeDuePreview > 0 ? (
                <div className="space-y-2">
                  <dl className="space-y-1 border-t border-[#d4d4d4] pt-3">
                    {breakdownRows.filter(([term]) => ['返送料', '交換の手数料', '交換の送料'].includes(term)).map(([term, value]) => (
                      <div key={term} className="flex justify-between font-acumin lk-text-sm text-black"><dt>{term}</dt><dd>{value}</dd></div>
                    ))}
                  </dl>
                  {feeDueNotice}
                </div>
              ) : null}

              <Checkbox
                label="お客様に知らせる"
                checked={sentBackUnits > 0 || notifyCustomer}
                disabled={stopped || sentBackUnits > 0}
                onChange={(event) => setNotifyCustomer(event.target.checked)}
              />

              {checkedCount === 0 && rows.length > 0 ? (
                <Button variant="secondary" size="sm" className="font-acumin" disabled={stopped} onClick={() => setStep('missing')}>
                  残りは届かないものとして返品を終える
                </Button>
              ) : null}
            </div>
          ) : null}
        </ReturnFlowContent>
      </form>
    </Dialog>
  );
}
