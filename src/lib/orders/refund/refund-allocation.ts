import type { RefundMaterialLine, RefundMaterials } from '@/lib/orders/refund/refund-types';

/**
 * 返金額の見込み（グループ E-2 設計書 4-5）。返金の画面が、選んだ数から額を先に見せるために使う。画面からも読む。
 * 記録する額は DB の関数 begin_order_refund が同じ式で出す（SQL が正）。商品ごとの割引の合計 Dᵢ は DB が材料に入れて返す
 * （lineDiscount）ので、ここでは割り振らない。TS と SQL は同じ試験の値（値 A・B・C）で確かめる。
 */

/** disc(n) = floor((2·D·n + q) / (2·q))。D は商品の割引の合計（材料の lineDiscount）、q は注文の数、n は返す数の合計 */
export function unitsDiscount(lineDiscount: number, quantity: number, units: number): number {
  return Math.floor((2 * lineDiscount * units + quantity) / (2 * quantity));
}

/** 前に返した数 refundedUnits の後に、units 個を返す時の額（単価 · units − (disc(b + units) − disc(b))） */
export function refundLineAmount(
  line: Pick<RefundMaterialLine, 'itemPrice' | 'quantity' | 'lineDiscount' | 'refundedUnits'>,
  units: number,
): number {
  const discount =
    unitsDiscount(line.lineDiscount, line.quantity, line.refundedUnits + units) -
    unitsDiscount(line.lineDiscount, line.quantity, line.refundedUnits);
  return line.itemPrice * units - discount;
}

export type RefundSelection = { orderItemId: string; beforeShipment: boolean; quantity: number };
export type RefundEstimate = { itemsAmount: number; discountAmount: number; shippingAmount: number; total: number };

/** 選んだ数と送料からの見込み。割引の分は正の数（画面は − を付けて出す） */
export function estimateRefund(
  lines: readonly RefundMaterialLine[],
  selections: readonly RefundSelection[],
  shippingAmount: number,
): RefundEstimate {
  // 同じ返金に同じ商品の発送前と発送後の選びがある時は、発送前を先に数える（発送前の b は前に返した数 refundedUnits、
  // 発送後の b は refundedUnits + 発送前の数。Global Constraints）。割引の差は足し合わせると同じ額になるので、数を足して1回で出す
  const unitsByItem = new Map<string, number>();
  for (const selection of selections) {
    if (Number.isInteger(selection.quantity) && selection.quantity >= 1) {
      unitsByItem.set(selection.orderItemId, (unitsByItem.get(selection.orderItemId) ?? 0) + selection.quantity);
    }
  }

  let itemsAmount = 0;
  let discountAmount = 0;
  for (const line of lines) {
    const units = unitsByItem.get(line.orderItemId);
    if (!units) {
      continue;
    }
    itemsAmount += line.itemPrice * units;
    discountAmount += line.itemPrice * units - refundLineAmount(line, units);
  }
  return { itemsAmount, discountAmount, shippingAmount, total: itemsAmount - discountAmount + shippingAmount };
}

/**
 * 発送が0で、残りの未発送を全部、発送前として選んだか。そうなら返金額は返せる額の全部、送料は min(返せる送料, 返せる額) に固定する
 * （送る物が無いのにキャンセルにならない注文を残さないため。DB の REFUND_MUST_BE_FULL と同じ条件）。
 * この関数は条件を答えるだけ。固定する額は、true の時に画面が材料の refundableAmount・refundableShipping から出す。
 */
export function selectsAllUnshipped(materials: RefundMaterials, selections: readonly RefundSelection[]): boolean {
  if (materials.order.shippedTotal !== 0) {
    return false;
  }
  const unshippedLines = materials.lines.filter((line) => line.unshipped > 0);
  return (
    unshippedLines.length > 0 &&
    unshippedLines.every((line) => {
      const selected = selections
        .filter((selection) => selection.orderItemId === line.orderItemId && selection.beforeShipment)
        .reduce((total, selection) => total + selection.quantity, 0);
      return selected === line.unshipped;
    })
  );
}
