import { formatYen } from '@/lib/orders/refund/refund-messages';
import { formatDeadline } from '@/lib/orders/returns/return-calc';
import { RETURN_REASON_LABELS } from '@/lib/orders/returns/return-messages';
import type { ReturnResolution, ShippingPayer } from '@/lib/orders/returns/return-types';
import type {
  CustomerReturnReason,
  CustomerReturnRequestMaterials,
  ReasonPhotoRule,
  ReasonResolutions,
} from '@/lib/orders/returns/customer-return-types';

/**
 * お客様の返品・交換の申し込みの画面の、画面に依らない決まりと言葉（グループ E-3 段2。共通の約束 C-5・P2・P5・P7）。
 * 品の状態・理由の絞り込み・ご希望の出し分け・交換の色・サイズの選べる物・入力の確かめ・窓口へ送る中身・確かめる段の文を、
 * 画面の部品から切り離して持つ（部品は出し分けの結果を描くだけにする）。ブラウザだけで使う。
 */

/** 1つの商品の行に付けられる写真の上限（Global Constraints「申し込みの写真」。DB も同じ） */
export const MAX_PHOTOS_PER_LINE = 5;
/** 詳しい内容の上限（DB の order_return_lines.customer_note と同じ） */
export const NOTE_MAX_LENGTH = 300;
/** 詳しい内容が必須の理由（DB の RETURN_CUSTOMER_NOTE_REQUIRED と同じ。Global Constraints「お客様が申し込める理由」） */
const NOTE_REQUIRED_REASONS: readonly CustomerReturnReason[] = ['defective', 'other'];
/** 返品不可の商品に許す理由（同上） */
const INELIGIBLE_ALLOWED_REASONS: readonly CustomerReturnReason[] = ['defective', 'wrong_item'];

/** 画面の言葉（C-5。一字も変えない）。差し込みのある物は関数にしてある */
export const REQUEST_TEXT = {
  title: '返品・交換のお申し込み',
  stepsLabel: 'お申し込みの手順',
  stepLabels: ['1. 商品を選ぶ', '2. 内容を確かめる', '3. お申し込みの受付'],
  orderNumber: (orderNumber: string) => `ご注文番号: ${orderNumber}`,
  shipmentHeading: (number: number, shippedDate: string) => `${number}回目の発送（${shippedDate}発送）`,
  deadline: (deadlineDate: string | null) =>
    deadlineDate === null ? '返品・交換の受付：期限なし' : `返品・交換の受付：${formatDeadline(deadlineDate)}まで`,
  exchangeBadge: '交換の品',
  ineligible: 'この商品は返品不可の商品です。初期不良・誤送の時だけお申し込みいただけます。',
  selectItem: 'この商品を申し込む',
  quantity: '数',
  reason: '理由',
  reasonPlaceholder: '選んでください',
  note: (required: boolean) => `詳しい内容（${required ? '必須' : '任意'}・${NOTE_MAX_LENGTH}字まで）`,
  photoLabel: (rule: Exclude<ReasonPhotoRule, 'none'>) => `写真（${rule === 'required' ? '必須' : '任意'}・${MAX_PHOTOS_PER_LINE}枚まで）`,
  pickPhoto: '写真を選ぶ',
  removePhoto: 'この写真を外す',
  sendingPhoto: '写真を送っています…',
  wish: 'ご希望',
  wishRefund: '返金',
  wishExchange: '交換',
  exchangeVariant: '交換する色・サイズ',
  makeToOrder: (leadDays: number | null) =>
    leadDays !== null && leadDays > 0 ? `お作りしてお送りします（お届けの目安 ${leadDays}日）` : 'お作りしてお送りします',
  outOfStock: '在庫がないため選べません',
  check: '内容を確かめる',
  back: '戻る',
  submit: '申し込む',
  checkAgain: 'もう一度確かめる',
  toOrder: '注文の画面に戻る',
  confirmHeading: 'お申し込みの内容',
  confirmLine: (label: string, quantity: number) => `${label} × ${quantity}`,
  confirmReason: (reasonLabel: string) => `理由: ${reasonLabel}`,
  confirmNote: (note: string) => `詳しい内容: ${note}`,
  confirmWishRefund: 'ご希望: 返金',
  confirmWishExchange: (variantLabel: string) => (variantLabel ? `ご希望: 交換（${variantLabel}）` : 'ご希望: 交換'),
  confirmPhotos: (count: number) => `写真 ${count}枚`,
  shippingShop: '返送料: 当店が負担します（着払いでお送りください）',
  shippingCustomer: '返送料: お客様のご負担です',
  shippingLabel: (yen: string) => `返送料: ${yen}（ご返金から差し引きます）`,
  shippingLabelFree: '返送料: 当店がご用意する送り状でお送りください。',
  restockingFee: (percent: number) => `返品の手数料: ご返金の商品の額の ${percent}%`,
  exchangeFee: (yen: string) => `交換の手数料: ${yen}`,
  exchangeShippingFee: (yen: string) => `交換の送料: ${yen}`,
  feeNoteWithRefund: '手数料はご返金から差し引きます。差し引けない分は、お支払いのご案内をお送りします。',
  feeNoteExchangeOnly: '手数料は、お支払いのご案内をお送りします。お支払いの後に交換の品をお送りします。',
  confirmNotice: 'お申し込みの後、当店で内容を確かめてから、メールでご連絡します。',
  accepted: 'お申し込みを受け付けました。内容を確かめて、メールでご連絡します。',
  returnNumber: (label: string) => `返品番号: ${label}`,
  noneSelected: '申し込む商品を選んでください。',
  reasonRequired: '理由を選んでください。',
  noteRequired: `詳しい内容を入れてください（${NOTE_MAX_LENGTH}字まで）。`,
  photoRequired: '写真を1枚以上選んでください。',
  photoLimit: (max: number) => `写真は${max}枚までです。`,
  variantRequired: '交換する色・サイズを選んでください。',
  unknownOutcome: 'お申し込みの結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。',
  closed: '現在、返品・交換のお申し込みを受け付けていません。',
  ended: (endedDate: string) => `返品・交換の受付は ${endedDate} で終わりました`,
  none: 'この注文は、返品・交換のお申し込みを受け付けていません。',
  loadFailed: 'お申し込みの画面を読み込めませんでした。時間をおいて、もう一度お試しください。',
  loginRequired: 'お申し込みにはログインが必要です',
  login: 'ログイン',
  loading: '読み込み中...',
} as const;

export type RequestShipment = CustomerReturnRequestMaterials['shipments'][number];
export type RequestLine = RequestShipment['lines'][number];
export type RequestReason = CustomerReturnRequestMaterials['reasons'][number];
export type RequestVariant = CustomerReturnRequestMaterials['exchangeOptions'][number]['variants'][number];

/** 品ごとの入力。reason と variantId の空は「選んでいない」 */
export type LineInput = {
  selected: boolean;
  quantity: number;
  reason: CustomerReturnReason | '';
  note: string;
  resolution: ReturnResolution;
  /** 交換の色・サイズの番号（文字）。選んでいなければ空 */
  variantId: string;
};

export const EMPTY_LINE_INPUT: LineInput = {
  selected: false,
  quantity: 1,
  reason: '',
  note: '',
  resolution: 'refund',
  variantId: '',
};

/** 画面の中の写真1枚。送り先の番号（uploadId）は送り終えてから入る */
export type PickedPhoto = {
  id: string;
  status: 'sending' | 'sent';
  uploadId: string | null;
  /** 一覧に出す縮小画像（data: のアドレス）。読めるまでと、読めなかった時は null */
  previewUrl: string | null;
};

export type RequestDraft = Record<string, LineInput>;
export type RequestPhotos = Record<string, PickedPhoto[]>;

/** 詳しい内容が必須の理由か */
export function isNoteRequired(reason: CustomerReturnReason): boolean {
  return NOTE_REQUIRED_REASONS.includes(reason);
}

/**
 * 縮めた写真を、一覧に出す見本（data: のアドレス）にする。ページの CSP の img-src は blob: を許さず data: を許すので、
 * blob: のアドレスは作らない。読めない時は null で、一覧は枠だけを出す
 */
export function readPreviewDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    } catch {
      resolve(null);
    }
  });
}

/** 発送の行1つの印。同じ商品が別の発送にもあるので、発送の番号と合わせて決める */
export function lineKey(fulfillmentId: string, orderItemId: string): string {
  return `${fulfillmentId}:${orderItemId}`;
}

/** 行の印を、DOM の id に使える形（英数字と - _ だけ）にする */
export function lineDomId(key: string): string {
  return `rr-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/** 選べる行か。窓口が selectable の状態でも、選べる数が0なら選べない行として扱う */
export function isSelectableLine(line: RequestLine): boolean {
  return line.state === 'selectable' && line.selectable >= 1;
}

/** 「白 / M」。色もサイズも無ければ空 */
export function variantText(color: string | null, size: string | null): string {
  return [color, size].filter((part): part is string => Boolean(part)).join(' / ');
}

/** 「シルクブラウス（白 / M）」。色もサイズも無ければ名前だけ */
export function itemLabel(name: string, color: string | null, size: string | null): string {
  const variant = variantText(color, size);
  return variant ? `${name}（${variant}）` : name;
}

/** 日本時間の「M月D日」（0詰めなし）。読めない時はそのまま返す。発送日は日本時間の日付で数える（期限が日本時間の日付で決まるため） */
export function formatMonthDay(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).formatToParts(new Date(time));
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return month && day ? `${month}月${day}日` : iso;
}

/** 同じ商品の、使える色・サイズ（窓口が使える物だけを返す） */
export function exchangeVariantsOf(materials: CustomerReturnRequestMaterials, itemId: number): RequestVariant[] {
  return materials.exchangeOptions.find((option) => option.itemId === itemId)?.variants ?? [];
}

const RESOLUTIONS_BY_RULE: Record<ReasonResolutions, readonly ReturnResolution[]> = {
  refund_and_exchange: ['refund', 'exchange'],
  exchange_only: ['exchange'],
  refund_only: ['refund'],
};

/** 理由の設定が許すご希望。交換にできる色・サイズが1つも無い商品は、交換を出さない */
export function resolutionOptionsOf(rule: ReasonResolutions, exchangeUsable: boolean): ReturnResolution[] {
  return RESOLUTIONS_BY_RULE[rule].filter((resolution) => resolution === 'refund' || exchangeUsable);
}

export function reasonSettingOf(
  materials: CustomerReturnRequestMaterials,
  reason: CustomerReturnReason | '',
): RequestReason | undefined {
  return reason === '' ? undefined : materials.reasons.find((setting) => setting.reason === reason);
}

/**
 * この行で選べる理由（窓口が出す理由の並びのまま）。返品不可の商品は「破損・不良」「注文と違う品が届いた」だけ。
 * ご希望が交換だけの理由は、交換にできる色・サイズが無い商品では選べない（選んでも申し込めないため）
 */
export function reasonOptionsOf(materials: CustomerReturnRequestMaterials, line: RequestLine): RequestReason[] {
  const exchangeUsable = exchangeVariantsOf(materials, line.itemId).length > 0;
  return materials.reasons.filter(
    (setting) =>
      (!line.returnIneligible || INELIGIBLE_ALLOWED_REASONS.includes(setting.reason)) &&
      resolutionOptionsOf(setting.resolutions, exchangeUsable).length > 0,
  );
}

export type VariantChoice = { variant: RequestVariant; status: 'in_stock' | 'make' | 'unavailable' };

/**
 * 交換の色・サイズの選べる状態。在庫が申し込む数以上なら在庫から、足りなければ、理由の設定の「在庫の無い交換」が
 * 作って送る（make）の時だけ選べ、断る（decline）なら選べない
 */
export function variantChoicesOf(
  materials: CustomerReturnRequestMaterials,
  line: RequestLine,
  setting: RequestReason,
  quantity: number,
): VariantChoice[] {
  return exchangeVariantsOf(materials, line.itemId).map((variant) => ({
    variant,
    status: variant.stockQuantity >= quantity ? 'in_stock' : setting.outOfStockExchange === 'make' ? 'make' : 'unavailable',
  }));
}

/**
 * 入力を、材料の決まりに収める。数は 1 から選べる数まで、選べない理由は未選択に戻し、許されないご希望は先頭の許す物にし、
 * 選べなくなった交換の色・サイズ（数を増やして在庫が足りなくなった時など）は未選択に戻す
 */
export function normalizeLine(materials: CustomerReturnRequestMaterials, line: RequestLine, input: LineInput): LineInput {
  const quantity = Math.min(Math.max(Math.trunc(input.quantity) || 1, 1), Math.max(line.selectable, 1));
  const setting = reasonOptionsOf(materials, line).find((option) => option.reason === input.reason);
  const resolutions = setting ? resolutionOptionsOf(setting.resolutions, exchangeVariantsOf(materials, line.itemId).length > 0) : [];
  const resolution = resolutions.includes(input.resolution) ? input.resolution : (resolutions[0] ?? 'refund');
  const choice =
    setting && resolution === 'exchange'
      ? variantChoicesOf(materials, line, setting, quantity).find((candidate) => String(candidate.variant.variantId) === input.variantId)
      : undefined;
  return {
    ...input,
    quantity,
    reason: setting ? setting.reason : '',
    resolution,
    variantId: choice && choice.status !== 'unavailable' ? input.variantId : '',
  };
}

/** 送り終えた写真の送り先の番号 */
export function sentPhotoIds(photos: PickedPhoto[] | undefined): string[] {
  return (photos ?? []).flatMap((photo) => (photo.status === 'sent' && photo.uploadId ? [photo.uploadId] : []));
}

type SelectedEntry = { key: string; shipment: RequestShipment; line: RequestLine; input: LineInput };

/** 申し込みに選んだ行（材料の並び順） */
function selectedEntries(materials: CustomerReturnRequestMaterials, draft: RequestDraft): SelectedEntry[] {
  return materials.shipments.flatMap((shipment) =>
    shipment.lines.flatMap((line): SelectedEntry[] => {
      if (!isSelectableLine(line)) return [];
      const key = lineKey(shipment.fulfillmentId, line.orderItemId);
      const input = draft[key];
      return input?.selected ? [{ key, shipment, line, input }] : [];
    }),
  );
}

/**
 * 送っている途中の写真があるか（あれば「内容を確かめる」を押せない）。画面に出している写真の欄
 * （選んだ品で、理由の設定が写真を求める行）だけを見る。チェックを外した品や、写真が「なし」の理由に変えた品の
 * 送っている途中の写真は、欄が隠れていて理由が見えないので数えない（その写真は窓口にも送らない）
 */
export function hasSendingPhotos(materials: CustomerReturnRequestMaterials, draft: RequestDraft, photos: RequestPhotos): boolean {
  return selectedEntries(materials, draft).some(({ key, input }) => {
    const setting = reasonSettingOf(materials, input.reason);
    return setting !== undefined && setting.photo !== 'none' && (photos[key] ?? []).some((photo) => photo.status === 'sending');
  });
}

export type LineErrors = { reason?: string; note?: string; photos?: string; variant?: string };
export type DraftValidation = { valid: boolean; noneSelected: boolean; lines: Record<string, LineErrors> };

/** 「内容を確かめる」を押した時の入力の確かめ。送っている途中の写真は数えない（その間は押せない） */
export function validateDraft(materials: CustomerReturnRequestMaterials, draft: RequestDraft, photos: RequestPhotos): DraftValidation {
  const entries = selectedEntries(materials, draft);
  const lines: Record<string, LineErrors> = {};
  for (const { key, input } of entries) {
    const errors: LineErrors = {};
    const setting = reasonSettingOf(materials, input.reason);
    if (!setting) {
      errors.reason = REQUEST_TEXT.reasonRequired;
    } else {
      if (isNoteRequired(setting.reason) && input.note.trim() === '') errors.note = REQUEST_TEXT.noteRequired;
      if (setting.photo === 'required' && sentPhotoIds(photos[key]).length === 0) errors.photos = REQUEST_TEXT.photoRequired;
      if (input.resolution === 'exchange' && input.variantId === '') errors.variant = REQUEST_TEXT.variantRequired;
    }
    if (Object.keys(errors).length > 0) lines[key] = errors;
  }
  const noneSelected = entries.length === 0;
  return { valid: !noneSelected && Object.keys(lines).length === 0, noneSelected, lines };
}

/** 最初の誤りの入力欄の id。画面の並び（理由 → 詳しい内容 → 写真 → 交換の色・サイズ）で、先の発送・先の品から探す */
export function firstErrorFieldId(materials: CustomerReturnRequestMaterials, validation: DraftValidation): string | null {
  for (const shipment of materials.shipments) {
    for (const line of shipment.lines) {
      const key = lineKey(shipment.fulfillmentId, line.orderItemId);
      const errors = validation.lines[key];
      if (!errors) continue;
      const prefix = lineDomId(key);
      if (errors.reason) return `${prefix}-reason`;
      if (errors.note) return `${prefix}-note`;
      if (errors.photos) return `${prefix}-photo-button`;
      if (errors.variant) return `${prefix}-variant`;
    }
  }
  return null;
}

/** 窓口 POST /api/orders/[id]/return-request の本文（C-3） */
export type SubmitBody = {
  requestKey: string;
  lines: Array<{
    fulfillmentId: string;
    orderItemId: string;
    quantity: number;
    reason: CustomerReturnReason;
    customerNote: string | null;
    requestedResolution: ReturnResolution;
    requestedExchangeVariantId: number | null;
    photoUploadIds: string[];
  }>;
};

/**
 * 窓口へ送る中身。詳しい内容は前後の空白を外し、空なら null。写真は、理由の設定が写真を求める理由の行だけ
 * （理由を変えて「なし」になった行に残った写真は送らない）、送り終えた物だけを送る
 */
export function buildSubmitBody(
  materials: CustomerReturnRequestMaterials,
  draft: RequestDraft,
  photos: RequestPhotos,
  requestKey: string,
): SubmitBody {
  const lines = selectedEntries(materials, draft).flatMap(({ key, shipment, line, input }): SubmitBody['lines'] => {
    const setting = reasonSettingOf(materials, input.reason);
    if (!setting) return [];
    const note = input.note.trim();
    return [
      {
        fulfillmentId: shipment.fulfillmentId,
        orderItemId: line.orderItemId,
        quantity: input.quantity,
        reason: setting.reason,
        customerNote: note === '' ? null : note,
        requestedResolution: input.resolution,
        requestedExchangeVariantId: input.resolution === 'exchange' ? Number(input.variantId) : null,
        photoUploadIds: setting.photo === 'none' ? [] : sentPhotoIds(photos[key]),
      },
    ];
  });
  return { requestKey, lines };
}

/**
 * 申し込みの時の返送の負担と方法の仮の値（P5。DB の customer_request_return と同じ決め方）。
 * 負担は、選んだ理由のどれかが「お店」ならお店、ほかはお客様。方法は、負担がお店なら着払い（customer_ships）、
 * お客様なら設定の「お客様の負担の時の送り方」
 */
export function shippingTermsOf(
  materials: CustomerReturnRequestMaterials,
  reasons: CustomerReturnReason[],
): { payer: ShippingPayer; method: 'customer_ships' | 'shop_label' } {
  const payer: ShippingPayer = reasons.some((reason) => reasonSettingOf(materials, reason)?.shippingPayer === 'shop') ? 'shop' : 'customer';
  return { payer, method: payer === 'shop' ? 'customer_ships' : materials.fees.customerPaidMethod };
}

export type ConfirmLine = {
  key: string;
  title: string;
  reason: string;
  note: string | null;
  wish: string;
  photos: string | null;
};
export type ConfirmSummary = { lines: ConfirmLine[]; shipping: string; fees: string[]; feeNote: string | null };

/**
 * 「内容を確かめる」の段に出す文（C-5）。手数料は設定で使う物（0より大きい物）のうち、この申し込みに関わる物だけ出す
 * （返品の手数料は返金の行がある時、交換の手数料と送料は交換の行がある時）。手数料の添え書きは、手数料がある時だけ、
 * 返金の行があるか交換だけかで文を変える。返送料は、お客様の負担でお店の送り状の定額が0円なら、金額を出さない文にする
 */
export function buildConfirmSummary(materials: CustomerReturnRequestMaterials, draft: RequestDraft, photos: RequestPhotos): ConfirmSummary {
  const chosen = selectedEntries(materials, draft).flatMap((entry) => {
    const setting = reasonSettingOf(materials, entry.input.reason);
    return setting ? [{ ...entry, setting }] : [];
  });

  const lines = chosen.map(({ key, line, input, setting }): ConfirmLine => {
    const variant =
      input.resolution === 'exchange'
        ? exchangeVariantsOf(materials, line.itemId).find((candidate) => String(candidate.variantId) === input.variantId)
        : undefined;
    const note = input.note.trim();
    const photoCount = setting.photo === 'none' ? 0 : sentPhotoIds(photos[key]).length;
    return {
      key,
      title: REQUEST_TEXT.confirmLine(itemLabel(line.itemName, line.color, line.size), input.quantity),
      reason: REQUEST_TEXT.confirmReason(RETURN_REASON_LABELS[setting.reason]),
      note: note === '' ? null : REQUEST_TEXT.confirmNote(note),
      wish:
        input.resolution === 'exchange'
          ? REQUEST_TEXT.confirmWishExchange(variant ? variantText(variant.color, variant.size) : '')
          : REQUEST_TEXT.confirmWishRefund,
      photos: photoCount > 0 ? REQUEST_TEXT.confirmPhotos(photoCount) : null,
    };
  });

  const terms = shippingTermsOf(materials, chosen.map(({ setting }) => setting.reason));
  const shipping =
    terms.payer === 'shop'
      ? REQUEST_TEXT.shippingShop
      : terms.method === 'shop_label'
        ? materials.fees.shopLabelFee > 0
          ? REQUEST_TEXT.shippingLabel(formatYen(materials.fees.shopLabelFee))
          : REQUEST_TEXT.shippingLabelFree
        : REQUEST_TEXT.shippingCustomer;

  const hasRefund = chosen.some(({ input }) => input.resolution === 'refund');
  const hasExchange = chosen.some(({ input }) => input.resolution === 'exchange');
  const fees: string[] = [];
  if (hasRefund && materials.fees.restockingFeePercent > 0) fees.push(REQUEST_TEXT.restockingFee(materials.fees.restockingFeePercent));
  if (hasExchange && materials.fees.exchangeFee > 0) fees.push(REQUEST_TEXT.exchangeFee(formatYen(materials.fees.exchangeFee)));
  if (hasExchange && materials.fees.exchangeShippingFee > 0) {
    fees.push(REQUEST_TEXT.exchangeShippingFee(formatYen(materials.fees.exchangeShippingFee)));
  }
  // 手数料がある時だけ添え書きを付ける。返金の品があれば返金から差し引く文、交換だけなら（差し引く返金が無いので）お支払いのご案内の文
  const feeNote = fees.length === 0 ? null : hasRefund ? REQUEST_TEXT.feeNoteWithRefund : REQUEST_TEXT.feeNoteExchangeOnly;
  return { lines, shipping, fees, feeNote };
}

/** 申し込めない時（受付がオフ・受付が終わった・対象が無い）に出す文。申し込める時は null */
export function availabilityMessageOf(availability: CustomerReturnRequestMaterials['availability']): string | null {
  switch (availability.returns) {
    case 'available':
      return null;
    case 'closed':
      return REQUEST_TEXT.closed;
    case 'ended':
      return availability.endedOn ? REQUEST_TEXT.ended(formatDeadline(availability.endedOn)) : REQUEST_TEXT.none;
    case 'none':
      return REQUEST_TEXT.none;
  }
}
