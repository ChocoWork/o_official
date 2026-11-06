import { formatYen } from '@/lib/orders/refund/refund-messages';
import type { ReceiptRefundChoice, ReturnMethod } from '@/lib/orders/returns/return-types';

/**
 * 受け取りの画面の返金の見込みとボタンの言葉、受付の期限の日付の書き方（グループ E-3 設計書 4-9・6-1・6-3・6-4。共通の約束 C-5）。
 * 画面からも読むので、サーバーだけの物を import しない。
 * 記録する額は DB の関数 admin_receive_return が同じ式で出す（SQL が正。TS は見込みだけ）。商品の額は E-2 の割り振りで
 * DB が出し、返品の行が指す注文の商品ごとの「今から k 点を返金した時の額」（refundAmountsByCount。同じ注文の商品の行は同じ列）として
 * 画面に渡る。ここでは割り振らず、同じ注文の商品の行の数を足して列を引くだけ。
 */

/**
 * 注文の商品ごとの、今回返金する品の商品の額（商品ごとに1要素の配列。返金の品が無ければ空）。DB の admin_receive_return は注文の商品ごとに
 * 今回の数を足してから private.return_units_amount で1回で額を出すので、同じ注文の商品の行は数を足してから列を引く
 * （行ごとに引いて足すと、割引の端数で1円ずれうる。E-2 の estimateRefund と同じ考え）。列は DB が同じ注文の商品の行に同じ物を返す。
 * count が 1 に満たない・整数でない行と、列が空の行（受付中でない返品など）は数えない。列より多く指しても、列の最後（返せる最大）で数える
 */
function itemsAmountsOf(
  lines: ReadonlyArray<{ orderItemId: string; refundAmountsByCount: number[]; count: number }>,
): number[] {
  const byItem = new Map<string, { amounts: number[]; count: number }>();
  for (const line of lines) {
    if (!Number.isInteger(line.count) || line.count < 1 || line.refundAmountsByCount.length === 0) {
      continue;
    }
    const entry = byItem.get(line.orderItemId) ?? { amounts: line.refundAmountsByCount, count: 0 };
    entry.count += line.count;
    byItem.set(line.orderItemId, entry);
  }
  return [...byItem.values()].map((entry) => entry.amounts[Math.min(entry.count, entry.amounts.length) - 1]);
}

/**
 * 受け取りで返金する額の見込み。式は共通の約束 Global Constraints「返品の返金の額」のとおり:
 * 返品の手数料 = floor(商品の額 × % / 100)、返送料（お店の送り状）は返金の品か交換の品がある最初の受け取りだけ、
 * 交換の手数料と送料は交換の品のある最初の受け取りだけ。返金額 = max(商品の額 − 手数料の合計, 0) + 送料の返金、
 * 引けなかった手数料 = max(手数料の合計 − 商品の額, 0)（お支払い待ちの額 fee_due_amount に足される）。
 * lines は今回返金する返品の行ごとの orderItemId（行が指す注文の商品）・数 count・その行の refundAmountsByCount。
 * 同じ orderItemId の行は count を足してから列を引く（itemsAmountsOf）。返金の品の行と、受け取りで「返金に変える」にした交換の行
 * （DB は交換の予定の行にも額の列を返す）だけを呼ぶ側が入れる。count が 0 の行と、額の列が [] の行（受付中でない返品）は額にも返金の品にも入らない。
 * firstReceipt は、返金か交換の品を受け取った受け取り（receive）がまだ無いか（OrderReturnDetail.firstReceiptDone の反対。
 * お返しだけの受け取りは数えない）、hasExchangeInThisReceipt はこの受け取りに交換の品があるか、
 * firstExchangeReceipt は交換の品のある最初の受け取りか、shippingRefund は店長が入れる送料の返金。
 */
export function computeReturnRefundPreview(input: {
  lines: Array<{ orderItemId: string; refundAmountsByCount: number[]; count: number }>;
  firstReceipt: boolean;
  hasExchangeInThisReceipt: boolean;
  firstExchangeReceipt: boolean;
  returnMethod: ReturnMethod;
  returnShippingFee: number;
  restockingFeePercent: number;
  exchangeFee: number;
  exchangeShippingFee: number;
  shippingRefund: number;
}): {
  itemsAmount: number;
  fees: { returnShipping: number; restocking: number; exchange: number; exchangeShipping: number };
  refundAmount: number;
  feeDue: number;
} {
  const amounts = itemsAmountsOf(input.lines);
  const itemsAmount = amounts.reduce((total, amount) => total + amount, 0);
  const hasRefundItems = amounts.length > 0;

  const hasExchangeFees = input.hasExchangeInThisReceipt && input.firstExchangeReceipt;
  const fees = {
    returnShipping:
      input.returnMethod === 'shop_label' && input.firstReceipt && (hasRefundItems || input.hasExchangeInThisReceipt)
        ? input.returnShippingFee
        : 0,
    restocking: Math.floor((itemsAmount * input.restockingFeePercent) / 100),
    exchange: hasExchangeFees ? input.exchangeFee : 0,
    exchangeShipping: hasExchangeFees ? input.exchangeShippingFee : 0,
  };
  const feesTotal = fees.returnShipping + fees.restocking + fees.exchange + fees.exchangeShipping;

  return {
    itemsAmount,
    fees,
    refundAmount: Math.max(itemsAmount - feesTotal, 0) + input.shippingRefund,
    feeDue: Math.max(feesTotal - itemsAmount, 0),
  };
}

/**
 * 品ごとの見込みの1行（返品の行ごと）。nowCount・consultCount は、この受け取りでその行の品を今すぐ返金・額を相談にした数。
 * receiveRefundAmountsByCount は H の注文だけの、その行が確保した着の累計（添字 k−1）。null の行（H の無い旧い注文・交換の行）は
 * refundAmountsByCount（注文の商品ごとの共通の累計）へ戻る。
 */
export type ReceivePreviewLine = {
  returnLineId: string;
  orderItemId: string;
  refundAmountsByCount: number[];
  receiveRefundAmountsByCount: number[] | null;
  nowCount: number;
  consultCount: number;
};

export type PerItemReturnRefundPreviewInput = {
  lines: ReceivePreviewLine[];
  firstReceipt: boolean;
  hasExchangeInThisReceipt: boolean;
  firstExchangeReceipt: boolean;
  returnMethod: ReturnMethod;
  returnShippingFee: number;
  restockingFeePercent: number;
  exchangeFee: number;
  exchangeShippingFee: number;
  shippingRefund: number;
  /** 注文の今の返せる額。今すぐ返金の入力の上限の片方 */
  refundableAmount: number;
};

/** 累計の列から、先頭の count 点の額（count が列より多ければ列の最後、0 なら 0） */
function cumulativeAt(amounts: readonly number[], count: number): number {
  if (count < 1 || amounts.length === 0) return 0;
  return amounts[Math.min(count, amounts.length) - 1];
}

const countOf = (value: number) => (Number.isInteger(value) && value > 0 ? value : 0);

/**
 * 今すぐ返金の品の額 G今 と額を相談の品の額 G相（返品の品ごとの返金 設計4-1・4-4）。
 * H の行は行ごとの累計で、今すぐの品に先頭（安い着）を、相談の品にその続きを当てる（他の行の安い着へ替えない）。
 * 旧い行は注文の商品ごとに数を足し、G今 = A[N−1]、G相 = A[N+C−1] − A[N−1] とする（行ごとに丸めないので端数を二重に数えない）。
 */
function perItemAmountsOf(lines: readonly ReceivePreviewLine[]): { now: number; consult: number; hasNow: boolean; hasConsult: boolean } {
  let now = 0;
  let consult = 0;
  let hasNow = false;
  let hasConsult = false;
  const legacy = new Map<string, { amounts: number[]; now: number; consult: number }>();
  for (const line of lines) {
    const nowCount = countOf(line.nowCount);
    const consultCount = countOf(line.consultCount);
    if (nowCount + consultCount === 0) continue;
    if (line.receiveRefundAmountsByCount !== null) {
      const amounts = line.receiveRefundAmountsByCount;
      if (amounts.length === 0) continue;
      const nowAmount = cumulativeAt(amounts, nowCount);
      now += nowAmount;
      consult += cumulativeAt(amounts, nowCount + consultCount) - nowAmount;
      hasNow ||= nowCount > 0;
      hasConsult ||= consultCount > 0;
      continue;
    }
    if (line.refundAmountsByCount.length === 0) continue;
    const entry = legacy.get(line.orderItemId) ?? { amounts: line.refundAmountsByCount, now: 0, consult: 0 };
    entry.now += nowCount;
    entry.consult += consultCount;
    legacy.set(line.orderItemId, entry);
  }
  for (const entry of legacy.values()) {
    const nowAmount = cumulativeAt(entry.amounts, entry.now);
    now += nowAmount;
    consult += cumulativeAt(entry.amounts, entry.now + entry.consult) - nowAmount;
    hasNow ||= entry.now > 0;
    hasConsult ||= entry.consult > 0;
  }
  return { now, consult, hasNow, hasConsult };
}

/**
 * 受け取りの品ごとの見込み（返品の品ごとの返金 設計4章）。記録する額は DB の admin_receive_return が同じ式で出す（DB が正）。
 * 今すぐの額 = max(G今 − F今, 0) + S、入力の上限 = min(注文の返せる額, G今 + S)。
 * F今は、最初の受け取りだけの固定費用（返送料・交換の手数料・交換の送料）と floor(G今 × p / 100)。相談の分の返品の手数料は
 * floor(G相 × p / 100) を別に切り捨てる。今すぐの分で引ききれない手数料は、同じ受け取りに相談の品があれば後で引く手数料
 * （feePendingDeduction）へ、無ければお支払い待ち（feeDue）へ足す。従来の computeReturnRefundPreview は変えない。
 *
 * @design DD-ADMIN-017
 */
export function computePerItemReturnRefundPreview(input: PerItemReturnRefundPreviewInput): {
  nowItemsAmount: number;
  consultItemsAmount: number;
  nowFees: { returnShipping: number; restocking: number; exchange: number; exchangeShipping: number };
  consultRestockingFee: number;
  refundAmount: number;
  refundCap: number;
  feePendingDeduction: number;
  feeDue: number;
} {
  const amounts = perItemAmountsOf(input.lines);
  const hasRefundItems = amounts.hasNow || amounts.hasConsult;
  const hasExchangeFees = input.hasExchangeInThisReceipt && input.firstExchangeReceipt;
  const nowFees = {
    returnShipping:
      input.returnMethod === 'shop_label' && input.firstReceipt && (hasRefundItems || input.hasExchangeInThisReceipt)
        ? input.returnShippingFee
        : 0,
    restocking: Math.floor((amounts.now * input.restockingFeePercent) / 100),
    exchange: hasExchangeFees ? input.exchangeFee : 0,
    exchangeShipping: hasExchangeFees ? input.exchangeShippingFee : 0,
  };
  const consultRestockingFee = Math.floor((amounts.consult * input.restockingFeePercent) / 100);
  const nowFeesTotal = nowFees.returnShipping + nowFees.restocking + nowFees.exchange + nowFees.exchangeShipping;
  const shortfall = Math.max(nowFeesTotal - amounts.now, 0);
  return {
    nowItemsAmount: amounts.now,
    consultItemsAmount: amounts.consult,
    nowFees,
    consultRestockingFee,
    refundAmount: Math.max(amounts.now - nowFeesTotal, 0) + input.shippingRefund,
    refundCap: Math.min(input.refundableAmount, amounts.now + input.shippingRefund),
    feePendingDeduction: consultRestockingFee + (amounts.hasConsult ? shortfall : 0),
    feeDue: amounts.hasConsult ? 0 : shortfall,
  };
}

/**
 * 受け取りの画面の確定のボタンの言葉（共通の約束 C-5「受け取りのボタンの言葉」）。
 * checked は今回チェックした点数、remaining は返品の未処理の残りの点数（checked が残り全部ならすべて受け取る）、
 * refundUnits・exchangeUnits・sentBackUnits は今回の点のうち、返金の品・交換の品・お返しの数。
 * 返金の品があり今返金を選んだ時に、返金額 refundAmount が 0 円なら（手数料が商品の額以上、または額を0に直した。P20）、
 * 返金の記録を作らないので「返金なしで記録する」と書く。
 * 品ごとの選びで今すぐと相談が混ざる時（refundChoice が mixed）だけ「受け取る（n点を ￥X 返金・m点は相談）」にする
 * （nowUnits・consultUnits は今すぐ・相談の点数。0円でも同じ形）。片方だけの時は今までの言葉のまま。
 *
 * @design DD-ADMIN-019
 */
export function buildReceiveButtonLabel(input: {
  checked: number;
  remaining: number;
  refundUnits: number;
  exchangeUnits: number;
  sentBackUnits: number;
  refundChoice: ReceiptRefundChoice;
  refundAmount: number;
  actorCanRefund: boolean;
  nowUnits?: number;
  consultUnits?: number;
}): string {
  const receivesAll = input.checked >= input.remaining;
  const received = receivesAll ? 'すべて受け取り' : `${input.checked}点を受け取り`;
  const exchangeTail = input.exchangeUnits > 0 ? '、交換の品を発送待ちにする' : '';

  if (input.refundChoice === 'mixed') {
    return `受け取る（${input.nowUnits ?? 0}点を ${formatYen(input.refundAmount)} 返金・${input.consultUnits ?? 0}点は相談）`;
  }

  if (input.refundUnits > 0 && input.refundChoice === 'consult') {
    return input.actorCanRefund ? '受け取りだけ記録する（返金は額を決めてから）' : '受け取りだけ記録する（額は店長が決める）';
  }
  if (input.refundUnits > 0 && input.refundChoice === 'now') {
    if (input.refundAmount > 0) {
      const head = receivesAll ? 'すべて受け取って ' : `${input.checked}点を受け取って `;
      return `${head}${formatYen(input.refundAmount)} を返金する${exchangeTail}`;
    }
    return `${received}、返金なしで記録する${exchangeTail}`;
  }
  if (input.exchangeUnits > 0) {
    return `${received}、交換の品を発送待ちにする`;
  }
  if (input.sentBackUnits > 0) {
    return `${received}、品物をお返しする`;
  }
  return `${input.checked}点を受け取る`;
}

/**
 * 受付の期限の日付の書き方（M月D日。0詰めなし）。DB が日本時間の日付 YYYY-MM-DD で返す物を読む。
 * 期限の文（`受付の期限: M月D日まで`・`期限を過ぎています（M月D日まで）`・`受付の期限: なし`）は、呼ぶ側（作る画面）が組む。
 * 期限が無い（無制限）時は「なし」を返す。YYYY-MM-DD に読めない文字は、そのまま返す。
 */
export function formatDeadline(date: string | null): string {
  if (date === null) {
    return 'なし';
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${Number(match[2])}月${Number(match[3])}日` : date;
}
