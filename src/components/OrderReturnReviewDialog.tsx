'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ReturnFlowContent, ReturnLoadDialog, requestedWishText, type ReturnDialogProps } from '@/components/ReturnDialogParts';
import ReturnPhotoViewer, { PHOTO_LOAD_FAILURE_TEXT, PHOTO_PURGED_TEXT } from '@/components/ReturnPhotoViewer';
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';
import { TextField } from '@/components/ui/TextField/TextField';
import { useLoadedReturn, type LoadedReturn } from '@/hooks/useLoadedReturn';
import { blockEnterSubmit } from '@/hooks/useRefundSubmission';
import { parseActionResponse, useReturnOperation } from '@/hooks/useReturnOperation';
import { clampQuantity, lineLabel } from '@/lib/orders/fulfillment/fulfillment-client';
import { ADMIN_NOTE_MAX_LENGTH } from '@/lib/orders/order-payment-types';
import { fetchReturnData } from '@/lib/orders/returns/return-client';
import {
  RETURN_CARRIER_LABELS,
  RETURN_DECLINE_REASON_LABELS,
  RETURN_ERROR_MESSAGES,
  RETURN_REASON_LABELS,
  prefillDeclineMessage,
} from '@/lib/orders/returns/return-messages';
import {
  RETURN_CARRIERS,
  RETURN_DECLINE_REASONS,
  type ExchangeMethod,
  type OrderReturnLineDetail,
  type ReturnCarrier,
  type ReturnCreateMaterials,
  type ReturnDeclineReason,
  type ReturnMethod,
  type ReturnResolution,
  type ShippingPayer,
} from '@/lib/orders/returns/return-types';

export type OrderReturnReviewDialogProps = ReturnDialogProps & {
  /** 承認した。返送不要で承認した時は親が受け取りの画面を開く */
  onApproved: (input: { notRequired: boolean }) => void;
};

type OrderReturnReviewDialogBodyProps = Pick<
  OrderReturnReviewDialogProps,
  'orderId' | 'onClose' | 'onDone' | 'onUncertain' | 'onApproved'
> & {
  loaded: LoadedReturn;
  /** 状態に合わない断りの後に、返品を読み直す */
  onReload: () => void;
  reloading: boolean;
  reloadError: string | null;
};

type Materials = ReturnCreateMaterials;
type ExchangeVariant = Materials['exchangeOptions'][number]['variants'][number];
/** `GET /api/admin/returns/[returnId]/photos` の写真1枚（C-3）。消した写真は url が null */
type ReturnPhotoLink = { photoId: string; returnLineId: string; url: string | null; purged: boolean };
type ViewablePhoto = { photoId: string; url: string; purged: false };
type MaterialsState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; materials: Materials };
type ReviewMode = 'review' | 'decline';

/** 承認で決める、行ごとの解決。最初の値は返品の今の値（申し込みの時に入れた仮の値＝お客様のご希望） */
type LineInput = {
  resolution: ReturnResolution;
  /** 選んだ交換の色・サイズ（variantId の文字）。空なら、元と同じ色・サイズ、無ければ最初の使える物 */
  exchangeVariantId: string;
  /** 選んだ送り方。null なら、選んだ色・サイズの在庫が数に足りるかで決める */
  exchangeMethod: ExchangeMethod | null;
};

type ApprovalLineEntry = {
  line: OrderReturnLineDetail;
  input: LineInput;
  /** この品と同じ商品の、使える色・サイズ */
  variants: ExchangeVariant[];
  /** 交換にする時の色・サイズ。返金なら null */
  variant: ExchangeVariant | null;
  /** 交換にする時の送り方。返金なら null */
  exchangeMethod: ExchangeMethod | null;
};

const MATERIALS_FAILURE_MESSAGE = '返品の材料を読み込めませんでした。';
// C-5 に無い文（この Task で決めた）。交換先の色・サイズが1つも使えない品の行に、承認が押せない理由として出す
const NO_EXCHANGE_TARGET_MESSAGE = '交換できる色・サイズがありません。解決の方法を返金にするか、お断りしてください。';
// 承認・お断りは二重防止の番号を持たない（P8）ので「二重にならずに」とは書かない。送り直して既に済んでいれば、状態に合わない断りで読み直す
const UNKNOWN_REVIEW_MESSAGE = '操作の結果を確かめられませんでした。「もう一度確かめる」を押すと、確かめ直します。';
const DECLINED_NOTICE = 'お断りしました。';
const DECLINE_CONFIRM_TEXT = 'お客様にメッセージが届きます。取り消せません。';
// DB の order_returns.decline_message の上限（C-0）
const DECLINE_MESSAGE_MAX_LENGTH = 1000;
// 金額（円）の欄の上限と割合の欄の誤りは、返品を作る画面・ショップの設定の画面と同じ言葉と確かめ（Global Constraints「金額の入力の上限」）
const FEE_MAX_YEN = 1_000_000;
const FEE_OVER_MAX_MESSAGE = '0から1000000までの整数（半角）で入れてください。';
const PERCENT_MESSAGE = '0から100までの整数（半角）で入れてください。';
// 伝票番号の形は DB の CHECK と同じ（P16）
const TRACKING_PATTERN = /^[0-9A-Za-z-]{1,64}$/;
const TRACKING_INVALID_MESSAGE = '伝票番号は英数字とハイフンで入力してください。';
const SELECT_PLACEHOLDER = '選んでください';
const NO_CARRIER = '指定しない';

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

// 選択肢は画面の外で1度だけ作る（SingleSelect は選択肢が変わるたびに計り直すため、描画のたびに作り直さない）
const PAYER_OPTIONS = PAYERS.map((payer) => ({ value: payer, label: PAYER_LABELS[payer] }));
const EXCHANGE_METHOD_OPTIONS = EXCHANGE_METHODS.map((method) => ({ value: method, label: EXCHANGE_METHOD_LABELS[method] }));
const CARRIER_OPTIONS = RETURN_CARRIERS.map((carrier) => ({ value: carrier, label: RETURN_CARRIER_LABELS[carrier] }));
const DECLINE_REASON_OPTIONS = RETURN_DECLINE_REASONS.map((reason) => ({ value: reason, label: RETURN_DECLINE_REASON_LABELS[reason] }));

/** select の値（文字）を、許す値の一覧に照らして型にする。一覧に無ければ null */
function pick<T extends string>(values: readonly T[], raw: string): T | null {
  return values.find((value) => value === raw) ?? null;
}

/** 「白 / M」。色もサイズも無ければ空 */
function variantText(color: string | null, size: string | null): string {
  return [color, size].filter((part): part is string => Boolean(part)).join(' / ');
}

/** 日時（日本時間）。管理画面の他の画面と同じ書き方 */
function formatJst(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function initialLineInput(line: OrderReturnLineDetail): LineInput {
  return {
    resolution: line.resolution,
    exchangeVariantId: line.exchange ? String(line.exchange.variantId) : '',
    exchangeMethod: line.exchange ? line.exchange.method : null,
  };
}

/** 同じ商品の、使える色・サイズ（使えない物は交換先にできない。DB も RETURN_EXCHANGE_VARIANT_INVALID で断る） */
function usableVariants(materials: Materials, itemId: number | null): ExchangeVariant[] {
  if (itemId === null) return [];
  const options = materials.exchangeOptions.find((option) => option.itemId === itemId);
  return (options?.variants ?? []).filter((variant) => variant.isActive);
}

/** 交換の色・サイズの選び。手で選んでいなければ、元と同じ色・サイズ、無ければ最初の使える物 */
function chosenVariant(variants: ExchangeVariant[], input: LineInput, originalVariantId: number | null): ExchangeVariant | null {
  return (
    variants.find((variant) => String(variant.variantId) === input.exchangeVariantId) ??
    variants.find((variant) => variant.variantId === originalVariantId) ??
    variants[0] ??
    null
  );
}

/** 送り方の選び。手で選んでいなければ、在庫が数に足りる時だけ在庫から */
function chosenMethod(variant: ExchangeVariant | null, input: LineInput, quantity: number): ExchangeMethod {
  return input.exchangeMethod ?? (variant !== null && variant.stockQuantity >= quantity ? 'stock' : 'make');
}

/** 返品の行を、材料の発送の行（商品の番号 itemId と元の色・サイズの番号 variantId を持つ）に結んで、承認の入力の形にする */
function approvalLineOf(materials: Materials, line: OrderReturnLineDetail, input: LineInput): ApprovalLineEntry {
  const shipLine = materials.shipments
    .find((shipment) => shipment.fulfillmentId === line.fulfillmentId)
    ?.lines.find((candidate) => candidate.orderItemId === line.orderItemId);
  const variants = usableVariants(materials, shipLine?.itemId ?? null);
  const variant = input.resolution === 'exchange' ? chosenVariant(variants, input, shipLine?.variantId ?? null) : null;
  const exchangeMethod = input.resolution === 'exchange' ? chosenMethod(variant, input, line.quantity) : null;
  return { line, input, variants, variant, exchangeMethod };
}

/** その行の、見られる写真（消していない・リンクがある物）。窓口が返した順 */
function viewablePhotosOf(links: ReturnPhotoLink[] | null, lineId: string): ViewablePhoto[] {
  return (links ?? []).flatMap((link): ViewablePhoto[] =>
    link.returnLineId === lineId && !link.purged && link.url !== null ? [{ photoId: link.photoId, url: link.url, purged: false }] : [],
  );
}

type FeeFieldProps = {
  id: string;
  label: string;
  value: number;
  disabled: boolean;
  onChange: (next: number) => void;
};

/** 金額（円）の欄。上限を超えた数も残して誤りを出す（桁の打ち間違いを、黙って別の額に変えない） */
function FeeField({ id, label, value, disabled, onChange }: FeeFieldProps) {
  const over = value > FEE_MAX_YEN;
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
        max={FEE_MAX_YEN}
        step={1}
        value={value}
        disabled={disabled}
        aria-invalid={over ? true : undefined}
        aria-describedby={over ? `${id}-error` : undefined}
        onChange={(event) => onChange(clampQuantity(event.target.value, Number.MAX_SAFE_INTEGER))}
        className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]"
      />
      {over ? (
        <p id={`${id}-error`} className="mt-1 font-acumin lk-text-3xs text-red-700">
          {FEE_OVER_MAX_MESSAGE}
        </p>
      ) : null}
    </div>
  );
}

type PhotoBlockProps = {
  line: OrderReturnLineDetail;
  /** 写真の窓口の答え。まだ読んでいない・読めなかった間は null */
  links: ReturnPhotoLink[] | null;
  failed: boolean;
  /** 画像を読み込めなかった写真（署名つきのリンクは10分で切れる。置き場の不調も）。1枚でもあれば「読み込めませんでした。」を出す */
  brokenIds: ReadonlySet<string>;
  onBroken: (photoId: string) => void;
  onView: (startIndex: number) => void;
};

/** 行の写真の欄。枚数は返品の中身から、小さい写真のリンクは写真の窓口から出す */
function PhotoBlock({ line, links, failed, brokenIds, onBroken, onView }: PhotoBlockProps) {
  if (line.photos.length === 0) return null;
  const viewable = viewablePhotosOf(links, line.id);
  // 一覧ごと読めなかった時と、リンクを作れなかった写真がある時（置き場の不調。消した写真ではない）と、画像を読み込めなかった写真がある時
  const unreadable =
    failed ||
    (links ?? []).some((link) => link.returnLineId === line.id && !link.purged && link.url === null) ||
    viewable.some((photo) => brokenIds.has(photo.photoId));
  return (
    <div className="space-y-2 pt-1">
      <p className="font-acumin lk-text-3xs text-[#474747]">{`写真 ${line.photos.length}枚`}</p>
      {unreadable ? <p className="font-acumin lk-text-3xs text-red-700">{PHOTO_LOAD_FAILURE_TEXT}</p> : null}
      {line.photos.some((photo) => photo.purged) ? (
        <p className="font-acumin lk-text-3xs text-[#474747]">{PHOTO_PURGED_TEXT}</p>
      ) : null}
      {viewable.length > 0 ? (
        <>
          <ul className="flex flex-wrap gap-2">
            {viewable.map((photo, index) => (
              <li key={photo.photoId}>
                <button
                  type="button"
                  aria-label={`写真 ${index + 1} を大きく見る`}
                  onClick={() => onView(index)}
                  className="block border border-[#d4d4d4]"
                >
                  {/* 署名つきのリンク（10分だけ使える）は、画像の最適化の経由に載せず、そのまま出す */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photo.url} alt="" onError={() => onBroken(photo.photoId)} className="h-16 w-16 object-cover" />
                </button>
              </li>
            ))}
          </ul>
          <Button variant="secondary" size="sm" className="font-acumin" onClick={() => onView(0)}>
            写真を大きく見る
          </Button>
        </>
      ) : null}
    </div>
  );
}

type RequestLineProps = {
  line: OrderReturnLineDetail;
  links: ReturnPhotoLink[] | null;
  photosFailed: boolean;
  brokenPhotoIds: ReadonlySet<string>;
  onPhotoBroken: (photoId: string) => void;
  onView: (startIndex: number) => void;
};

/** 申し込みの品1つ分の中身（読むだけ）。お客様が書いた文は書かれたとおりの字で出す（HTML として読まない） */
function RequestLine({ line, links, photosFailed, brokenPhotoIds, onPhotoBroken, onView }: RequestLineProps) {
  const label = lineLabel({ name: line.itemName, color: line.color, size: line.size });
  const wish = requestedWishText(line);
  return (
    <li>
      <div role="group" aria-label={label} className="space-y-1 border border-[#d4d4d4] p-3">
        <p className="font-acumin lk-text-sm text-black">{`${label} × ${line.quantity}`}</p>
        <p className="font-acumin lk-text-3xs text-[#474747]">{`理由: ${RETURN_REASON_LABELS[line.reason]}`}</p>
        {line.customerNote ? (
          <p className="whitespace-pre-wrap break-words font-acumin lk-text-3xs text-[#474747]">{`詳しい内容: ${line.customerNote}`}</p>
        ) : null}
        {wish ? <p className="font-acumin lk-text-3xs text-[#474747]">{wish}</p> : null}
        {line.returnIneligible ? <p className="font-acumin lk-text-3xs text-amber-800">返品不可の品です</p> : null}
        <PhotoBlock line={line} links={links} failed={photosFailed} brokenIds={brokenPhotoIds} onBroken={onPhotoBroken} onView={onView} />
      </div>
    </li>
  );
}

type ApprovalLineProps = {
  entry: ApprovalLineEntry;
  disabled: boolean;
  onChange: (patch: Partial<LineInput>) => void;
};

/** 承認する時に決める、品1つ分の解決（返金／交換の色・サイズと送り方） */
function ApprovalLine({ entry, disabled, onChange }: ApprovalLineProps) {
  const { line, input, variants, variant, exchangeMethod } = entry;
  const label = lineLabel({ name: line.itemName, color: line.color, size: line.size });
  const idPrefix = `return-review-${line.id}`;
  // 同じ商品に使える色・サイズが1つも無い品は、交換を選べない。ただし今の値が交換の間は「交換」を残す
  // （選択肢から消すと、値は交換のままなのに画面は返金に見え、「承認する」が黙って押せなくなる）
  const resolutionOptions = RESOLUTIONS.filter(
    (resolution) => resolution === 'refund' || variants.length > 0 || input.resolution === 'exchange',
  ).map((resolution) => ({
    value: resolution,
    label: RESOLUTION_LABELS[resolution],
  }));
  const variantOptions = variants.map((option) => ({
    value: String(option.variantId),
    label: variantText(option.color, option.size) || line.itemName,
  }));
  return (
    <li>
      <div role="group" aria-label={`${label}の解決`} className="space-y-2 border border-[#d4d4d4] p-3">
        <p className="font-acumin lk-text-sm text-black">{label}</p>
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
        {input.resolution === 'exchange' ? (
          <div className="space-y-2">
            <SingleSelect
              id={`${idPrefix}-variant`}
              label="交換の色・サイズ"
              options={variantOptions}
              value={String(variant?.variantId ?? '')}
              disabled={disabled}
              // 色・サイズを選び直したら、送り方は新しい在庫から決め直す
              onChange={(event) => onChange({ exchangeVariantId: event.target.value, exchangeMethod: null })}
            />
            {variant === null ? (
              // 申し込みの後に、同じ商品の色・サイズが全部使えなくなった（稀）。承認は押せないので、理由を出す
              <p className="font-acumin lk-text-3xs text-red-700">{NO_EXCHANGE_TARGET_MESSAGE}</p>
            ) : (
              <p className="font-acumin lk-text-3xs text-[#474747]">{`在庫: ${variant.stockQuantity}`}</p>
            )}
            <SingleSelect
              id={`${idPrefix}-method`}
              label="送り方"
              options={EXCHANGE_METHOD_OPTIONS}
              value={exchangeMethod ?? 'stock'}
              disabled={disabled}
              onChange={(event) => {
                const next = pick(EXCHANGE_METHODS, event.target.value);
                if (next) onChange({ exchangeMethod: next });
              }}
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * 申し込みを確かめる画面（グループ E-3 段2。設計書 4-10・5-2・13-1）。管理画面の返品の欄の「申し込みを確かめる」から開く。
 * 申し込みの中身（品・理由・詳しい内容・ご希望・写真）を見て、承認する（解決・返送・手数料・メモ・知らせを決める）か、お断りする（メッセージを送る）。
 * 開く時に、注文の返品の窓口を読んで返品の中身を得る（useLoadedReturn）。承認とお断りは状態で守られ（二重防止の番号を持たない。P8）、
 * 別の人が先に済ませていたら状態に合わない断りになるので、断りの文を出して読み直す。
 * 承認したら onApproved（返送不要なら親が受け取りの画面を開く）、お断りしたら onDone('お断りしました。')。閉じるのは親。
 */
export default function OrderReturnReviewDialog({
  orderId,
  returnId,
  onClose,
  onDone,
  onUncertain,
  onApproved,
}: OrderReturnReviewDialogProps) {
  const { state, reload, reloading, reloadError } = useLoadedReturn(orderId, returnId);
  if (state.kind !== 'ready') return <ReturnLoadDialog state={state} title="返品の申し込みを確かめる" onClose={onClose} />;
  return (
    <OrderReturnReviewDialogBody
      key={state.detail.id}
      orderId={orderId}
      loaded={state}
      onReload={reload}
      reloading={reloading}
      reloadError={reloadError}
      onClose={onClose}
      onDone={onDone}
      onUncertain={onUncertain}
      onApproved={onApproved}
    />
  );
}

function OrderReturnReviewDialogBody({
  orderId,
  loaded,
  onReload,
  reloading,
  reloadError,
  onClose,
  onDone,
  onUncertain,
  onApproved,
}: OrderReturnReviewDialogBodyProps) {
  const { detail } = loaded;
  const [mode, setMode] = useState<ReviewMode>('review');
  const [materialsState, setMaterialsState] = useState<MaterialsState>({ kind: 'loading' });
  const [photoLinks, setPhotoLinks] = useState<ReturnPhotoLink[] | null>(null);
  const [photosFailed, setPhotosFailed] = useState(false);
  // 画像を読み込めなかった写真（署名つきのリンクは10分で切れる。置き場の不調も）。1枚でもあれば「読み込めませんでした。」を出す
  const [brokenPhotoIds, setBrokenPhotoIds] = useState<ReadonlySet<string>>(() => new Set());
  const [viewer, setViewer] = useState<{ lineId: string; startIndex: number } | null>(null);
  // 承認の入力。最初の値は返品の今の値（申し込みの時にサーバーが入れた仮の値）
  const [lineInputs, setLineInputs] = useState<Record<string, LineInput>>(() =>
    Object.fromEntries(detail.lines.map((line): [string, LineInput] => [line.id, initialLineInput(line)])),
  );
  const [method, setMethod] = useState<ReturnMethod>(detail.returnMethod);
  const [payer, setPayer] = useState<ShippingPayer>(detail.returnShippingPayer);
  const [carrier, setCarrier] = useState<ReturnCarrier | ''>(detail.returnCarrier ?? '');
  const [trackingNumber, setTrackingNumber] = useState(detail.returnTrackingNumber ?? '');
  // 返送料は手で直した時だけ入る。直すまでは下の shippingFee（返品の今の値、無ければ設定の返送料）を使う
  const [shippingFeeEntered, setShippingFeeEntered] = useState<number | null>(null);
  const [restockingPercentText, setRestockingPercentText] = useState(String(detail.fees.restockingFeePercent));
  const [exchangeFee, setExchangeFee] = useState(detail.fees.exchangeFee);
  const [exchangeShippingFee, setExchangeShippingFee] = useState(detail.fees.exchangeShippingFee);
  const [note, setNote] = useState(detail.shopNote ?? '');
  const [notifyCustomer, setNotifyCustomer] = useState(detail.notifyCustomer);
  // お断りの入力
  const [declineReason, setDeclineReason] = useState<ReturnDeclineReason | ''>('');
  const [declineMessage, setDeclineMessage] = useState('');

  const flow = useReturnOperation({
    unknownMessage: UNKNOWN_REVIEW_MESSAGE,
    fallbackMessage: RETURN_ERROR_MESSAGES.RETURN_ARGUMENT_INVALID.message,
    onClose,
    onUncertain,
    onRefused: (code) => {
      // 別の人が先に承認・お断りした（状態に合わない）。入力は残したまま確かめる画面に戻し、返品を読み直して今の状態を見せる
      if (code === 'RETURN_STATE_CONFLICT') {
        setMode('review');
        onReload();
      }
    },
  });

  const hasPhotos = detail.lines.some((line) => line.photos.length > 0);

  useEffect(() => {
    let active = true;
    void fetchReturnData<Materials>(`/api/admin/orders/${orderId}/returns/materials`, MATERIALS_FAILURE_MESSAGE).then((result) => {
      if (!active) return;
      setMaterialsState(result.kind === 'error' ? { kind: 'error', message: result.message } : { kind: 'ready', materials: result.data });
    });
    return () => {
      active = false;
    };
  }, [orderId]);

  useEffect(() => {
    // 写真が無い申し込みは、写真の窓口を読まない
    if (!hasPhotos) return;
    let active = true;
    void fetchReturnData<{ photos: ReturnPhotoLink[] }>(`/api/admin/returns/${detail.id}/photos`, PHOTO_LOAD_FAILURE_TEXT).then((result) => {
      if (!active) return;
      if (result.kind === 'error' || !Array.isArray(result.data.photos)) {
        setPhotosFailed(true);
        return;
      }
      setPhotoLinks(result.data.photos);
    });
    return () => {
      active = false;
    };
  }, [detail.id, hasPhotos]);

  const reviewable = detail.status === 'requested';
  const declining = mode === 'decline' && reviewable;
  const stopped = flow.busy || flow.uncertain || reloading;
  const materials = materialsState.kind === 'ready' ? materialsState.materials : null;
  const settings = materials?.settings ?? null;
  const approvalLines = materials
    ? detail.lines.map((line) => approvalLineOf(materials, line, lineInputs[line.id] ?? initialLineInput(line)))
    : [];
  const hasExchange = approvalLines.some((entry) => entry.input.resolution === 'exchange');
  const methodOptions = RETURN_METHODS.filter((option) => option !== 'not_required' || settings?.noReturnNeededEnabled).map((option) => ({
    value: option,
    label: RETURN_METHOD_LABELS[option],
  }));

  // 手数料は、設定で使う物だけ出す。出さない欄は 0 で送る（返品を作る画面と同じ。DB も、設定で使わない手数料は 0）。
  // 返送料の定額を差し引くのは、お客様の負担でお店の送り状の時だけ
  const showShippingFee = method === 'shop_label' && payer === 'customer';
  // 返送料の定額は、申し込みの時はお客様の負担でお店の送り状の時だけ入る（P5）ので、承認でその組み合わせに切り替えると 0 円から始まって取り損ねる。
  // 手で直すまでは、返品の今の値が 0 なら設定の返送料から始める（返品を作る画面と同じ）
  const shippingFee = shippingFeeEntered ?? (detail.fees.returnShippingFee > 0 ? detail.fees.returnShippingFee : (settings?.shopLabelFee ?? 0));
  const showRestocking = settings?.restockingFeeEnabled ?? false;
  const showExchangeFees = (settings?.exchangeFeesEnabled ?? false) && hasExchange;
  const restockingText = restockingPercentText.trim();
  const restockingPercent = Number(restockingText);
  const restockingPercentInvalid = showRestocking && (!/^[0-9]{1,9}$/.test(restockingText) || restockingPercent > 100);
  const trackingText = trackingNumber.trim();
  // 返送不要の間は伝票番号の欄を隠して送らないので、確かめない
  const trackingInvalid = method !== 'not_required' && trackingText !== '' && !TRACKING_PATTERN.test(trackingText);
  const feeOverMax =
    (showShippingFee && shippingFee > FEE_MAX_YEN) ||
    (showExchangeFees && (exchangeFee > FEE_MAX_YEN || exchangeShippingFee > FEE_MAX_YEN));
  const canApprove =
    reviewable &&
    settings !== null &&
    settings.returnAddressSet &&
    !stopped &&
    !trackingInvalid &&
    !feeOverMax &&
    !restockingPercentInvalid &&
    approvalLines.every((entry) => entry.input.resolution === 'refund' || entry.variant !== null);

  const trimmedMessage = declineMessage.trim();
  const canDecline =
    reviewable && declineReason !== '' && trimmedMessage !== '' && declineMessage.length <= DECLINE_MESSAGE_MAX_LENGTH && !stopped;

  const updateLine = (line: OrderReturnLineDetail, patch: Partial<LineInput>) => {
    setLineInputs((previous) => ({ ...previous, [line.id]: { ...(previous[line.id] ?? initialLineInput(line)), ...patch } }));
  };

  const startDecline = () => setMode('decline');

  const changeDeclineReason = (raw: string) => {
    const next = pick(RETURN_DECLINE_REASONS, raw);
    if (next === null) {
      // 「選んでください」に戻した時は、書いたメッセージは残す（理由が無いので送れない）
      setDeclineReason('');
      return;
    }
    // 理由を選ぶと最初の文が入る。直した文は、理由を選び直しても残す（欄が空白だけか、前の理由の最初の文のままの時だけ置き換える。P8）
    setDeclineMessage(prefillDeclineMessage(declineMessage, declineReason === '' ? null : declineReason, next));
    setDeclineReason(next);
  };

  const sendApprove = () => {
    const body = {
      lines: approvalLines.map((entry) => ({
        returnLineId: entry.line.id,
        resolution: entry.input.resolution,
        exchangeVariantId: entry.variant?.variantId ?? null,
        exchangeMethod: entry.exchangeMethod,
      })),
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
    };
    flow.submit(
      `/api/admin/returns/${detail.id}/approve`,
      () => body,
      (data) => {
        if (parseActionResponse(data) === null) return false;
        onApproved({ notRequired: method === 'not_required' });
        return true;
      },
    );
  };

  const sendDecline = () => {
    if (declineReason === '') return;
    const body = { declineReason, declineMessage: trimmedMessage };
    flow.submit(
      `/api/admin/returns/${detail.id}/decline`,
      () => body,
      (data) => {
        if (parseActionResponse(data) === null) return false;
        onDone(DECLINED_NOTICE);
        return true;
      },
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!declining) {
      if (canApprove) sendApprove();
      return;
    }
    // お断りはお客様にメッセージが届いて取り消せないので、確かめの文（DECLINE_CONFIRM_TEXT）を入力の下に最初から出し、1回押して送る
    if (canDecline) sendDecline();
  };

  const requestSection = (
    <div className="space-y-3">
      {reloadError ? (
        <p role="alert" className="font-acumin lk-text-3xs text-red-700">
          {reloadError}
        </p>
      ) : null}
      <p className="font-acumin lk-text-sm text-black">{`申し込み: ${formatJst(detail.requestedAt ?? detail.createdAt)}`}</p>
      <ul className="space-y-3">
        {detail.lines.map((line) => (
          <RequestLine
            key={line.id}
            line={line}
            links={photoLinks}
            photosFailed={photosFailed}
            brokenPhotoIds={brokenPhotoIds}
            onPhotoBroken={(photoId) => setBrokenPhotoIds((previous) => new Set(previous).add(photoId))}
            onView={(startIndex) => setViewer({ lineId: line.id, startIndex })}
          />
        ))}
      </ul>
    </div>
  );

  const approvalSection = (
    <section aria-labelledby="return-review-approval-heading" className="space-y-3">
      <h4 id="return-review-approval-heading" className="font-acumin lk-text-sm text-black">
        承認する時の内容
      </h4>
      {materialsState.kind === 'loading' ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}
      {materialsState.kind === 'error' ? <p className="font-acumin lk-text-3xs text-red-700">{materialsState.message}</p> : null}
      {settings && !settings.returnAddressSet ? (
        <p className="font-acumin lk-text-3xs text-red-700">{RETURN_ERROR_MESSAGES.RETURN_ADDRESS_REQUIRED.message}</p>
      ) : null}
      {materials ? (
        <>
          <ul className="space-y-3">
            {approvalLines.map((entry) => (
              <ApprovalLine key={entry.line.id} entry={entry} disabled={stopped} onChange={(patch) => updateLine(entry.line, patch)} />
            ))}
          </ul>

          <section aria-labelledby="return-review-shipping-heading" className="space-y-2">
            <h4 id="return-review-shipping-heading" className="font-acumin lk-text-sm text-black">
              返送
            </h4>
            <SingleSelect
              id="return-review-method"
              label="返送の方法"
              options={methodOptions}
              value={method}
              disabled={stopped}
              onChange={(event) => {
                const next = pick(RETURN_METHODS, event.target.value);
                if (next) setMethod(next);
              }}
            />
            {method !== 'not_required' ? (
              <>
                <SingleSelect
                  id="return-review-payer"
                  label="返送料の負担"
                  options={PAYER_OPTIONS}
                  value={payer}
                  disabled={stopped}
                  onChange={(event) => {
                    const next = pick(PAYERS, event.target.value);
                    if (next) setPayer(next);
                  }}
                />
                <SingleSelect
                  id="return-review-carrier"
                  label="返送の配送業者（任意）"
                  options={CARRIER_OPTIONS}
                  placeholder={NO_CARRIER}
                  value={carrier}
                  disabled={stopped}
                  onChange={(event) => setCarrier(pick(RETURN_CARRIERS, event.target.value) ?? '')}
                />
                <TextField
                  id="return-review-tracking"
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
            <section aria-labelledby="return-review-fees-heading" className="space-y-2">
              <h4 id="return-review-fees-heading" className="font-acumin lk-text-sm text-black">
                手数料
              </h4>
              <div className="grid grid-cols-2 gap-3">
                {showShippingFee ? (
                  <FeeField id="return-review-shipping-fee" label="返送料（円）" value={shippingFee} disabled={stopped} onChange={setShippingFeeEntered} />
                ) : null}
                {showRestocking ? (
                  <TextField
                    id="return-review-restocking-percent"
                    label="返品の手数料（%）"
                    value={restockingPercentText}
                    inputMode="numeric"
                    disabled={stopped}
                    errorText={restockingPercentInvalid ? PERCENT_MESSAGE : undefined}
                    onChange={(event) => setRestockingPercentText(event.target.value)}
                  />
                ) : null}
                {showExchangeFees ? (
                  <>
                    <FeeField id="return-review-exchange-fee" label="交換の手数料（円）" value={exchangeFee} disabled={stopped} onChange={setExchangeFee} />
                    <FeeField
                      id="return-review-exchange-shipping-fee"
                      label="交換の送料（円）"
                      value={exchangeShippingFee}
                      disabled={stopped}
                      onChange={setExchangeShippingFee}
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
        </>
      ) : null}
    </section>
  );

  // 幅が 768px 以上の Dialog は高さを制限しないので、内容の部分だけを縦に動かし、誤りの文とボタンは動かさない
  const reviewScreen = (
    <ReturnFlowContent
      flow={flow}
      backLabel="閉じる"
      submitLabel="承認する"
      canSubmit={canApprove}
      // お断りは、返送先が空などで承認できない時にも押せる
      extraAction={{ label: 'お断りする', onClick: startDecline, disabled: stopped }}
    >
      <div className="space-y-4 md:max-h-[60vh] md:overflow-y-auto md:pr-1">
        {requestSection}
        {approvalSection}
      </div>
    </ReturnFlowContent>
  );

  // お断りの画面は1つの画面（C-5。Task 12 のキャンセルの申し込みのお断りと同じ作り）。確かめの文は入力の下に最初から出す
  const declineScreen = (
    <ReturnFlowContent
      flow={flow}
      backLabel="戻る"
      onBack={() => setMode('review')}
      submitLabel="お断りする"
      canSubmit={canDecline}
    >
      <div className="space-y-3">
        <SingleSelect
          id="return-decline-reason"
          label="お断りの理由（お客様には見えません）"
          options={DECLINE_REASON_OPTIONS}
          placeholder={SELECT_PLACEHOLDER}
          value={declineReason}
          disabled={stopped}
          onChange={(event) => changeDeclineReason(event.target.value)}
        />
        <TextAreaField
          id="return-decline-message"
          label="お客様へのメッセージ（必須・お客様に届きます）"
          value={declineMessage}
          rows={5}
          maxLength={DECLINE_MESSAGE_MAX_LENGTH}
          disabled={stopped}
          onChange={(event) => setDeclineMessage(event.target.value)}
        />
        <p className="font-acumin lk-text-sm text-black">{DECLINE_CONFIRM_TEXT}</p>
      </div>
    </ReturnFlowContent>
  );

  // 受付中でなくなった返品（別の人が先に承認・お断りした）は、中身と「閉じる」だけを出す
  const closedScreen = (
    <>
      <div className="space-y-4 md:max-h-[60vh] md:overflow-y-auto md:pr-1">{requestSection}</div>
      {flow.alertText ? (
        <p role="alert" className="font-acumin lk-text-3xs text-red-700">
          {flow.alertText}
        </p>
      ) : null}
      <div className="flex gap-2 pt-1">
        <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={flow.close}>
          閉じる
        </Button>
      </div>
    </>
  );

  const screen = declining ? declineScreen : reviewable ? reviewScreen : closedScreen;
  const title = declining ? `お断りする（${detail.label}）` : `返品の申し込みを確かめる（${detail.label}）`;

  return (
    <>
      {viewer === null ? (
        <Dialog open onClose={flow.close} title={title} fullScreenOnMobile>
          <form className="space-y-3" onSubmit={handleSubmit} onKeyDown={blockEnterSubmit}>
            {screen}
          </form>
        </Dialog>
      ) : null}
      <ReturnPhotoViewer
        photos={viewer === null ? [] : viewablePhotosOf(photoLinks, viewer.lineId)}
        open={viewer !== null}
        startIndex={viewer?.startIndex ?? 0}
        onClose={() => setViewer(null)}
      />
    </>
  );
}
