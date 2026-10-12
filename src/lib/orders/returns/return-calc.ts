import { formatYen } from '@/lib/orders/refund/refund-messages';
import type { RefundChoice, ReturnMethod } from '@/lib/orders/returns/return-types';

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
 * 受け取りの画面の確定のボタンの言葉（共通の約束 C-5「受け取りのボタンの言葉」）。
 * checked は今回チェックした点数、remaining は返品の未処理の残りの点数（checked が残り全部ならすべて受け取る）、
 * refundUnits・exchangeUnits・sentBackUnits は今回の点のうち、返金の品・交換の品・お返しの数。
 * 返金の品があり今返金を選んだ時に、返金額 refundAmount が 0 円なら（手数料が商品の額以上、または額を0に直した。P20）、
 * 返金の記録を作らないので「返金なしで記録する」と書く。
 */
export function buildReceiveButtonLabel(input: {
  checked: number;
  remaining: number;
  refundUnits: number;
  exchangeUnits: number;
  sentBackUnits: number;
  refundChoice: RefundChoice;
  refundAmount: number;
  actorCanRefund: boolean;
}): string {
  const receivesAll = input.checked >= input.remaining;
  const received = receivesAll ? 'すべて受け取り' : `${input.checked}点を受け取り`;
  const exchangeTail = input.exchangeUnits > 0 ? '、交換の品を発送待ちにする' : '';

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
