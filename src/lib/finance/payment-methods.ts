// 入出金方法（docs/Other/財務.md「入出金方法（表示）」）→ 勘定科目の対応。
// 取引管理では「出金方法／入金方法」を選ばせるが、仕訳では資金側の勘定科目に
// 変換する必要がある。表示名と科目正式名称が違うものだけここで橋渡しする。

import type { BusinessType } from "@/lib/finance/accounts";

/** 出金方法（支出）の選択肢。財務.md の表と一致させる。 */
export const EXPENSE_PAYMENT_METHODS = [
  "現金",
  "プライベート",
  "クレジットカード",
  "銀行",
  "支払手形",
  "買掛金",
  "借入金",
  "未払金",
  "前受金",
  "預り金",
  "賃倒引当金",
  "借受金",
  "未払消費税",
  "保証金・敷金",
  "商品券",
  "仮受消費税",
] as const;

/** 入金方法（収入）の選択肢。 */
export const INCOME_PAYMENT_METHODS = [
  "現金",
  "プライベート",
  "銀行",
  "前払金",
  "売掛金",
  "受取手形",
  "未収賃貸料",
  "貸付金",
  "立替金",
  "未収金",
  "仮払金",
  "仮払消費税",
] as const;

// 表示名と科目名がずれるものだけを列挙する。同名のものは変換不要。
// 「賃倒引当金」「借受金」は財務.md の表記ゆれ（正: 貸倒引当金 / 仮受金）。
const ACCOUNT_NAME_BY_METHOD: Record<string, string> = {
  クレジットカード: "未払金",
  銀行: "普通預金",
  借入金: "短期借入金",
  賃倒引当金: "貸倒引当金",
  借受金: "仮受金",
  "保証金・敷金": "受入保証金・敷金",
};

/**
 * 入出金方法に対応する資金側の勘定科目名。
 *
 * 「プライベート」は事業と事業主個人の資金のやりとり。個人事業主の場合:
 *   出金（事業の経費を私費で支払った）→ 事業が事業主から借りた ＝ 事業主借
 *     借方 経費 / 貸方 事業主借
 *   入金（事業の売上を個人口座で受け取った）→ 事業が事業主へ貸した ＝ 事業主貸
 *     借方 事業主貸 / 貸方 売上高
 * 法人は役員との貸借になるため、いずれも 役員借入金 に振り替える。
 */
export function paymentMethodAccountName(
  paymentMethod: string,
  businessType: BusinessType,
  direction: "expense" | "income",
): string {
  if (paymentMethod === "プライベート") {
    if (businessType === "corporation") return "役員借入金";
    return direction === "expense" ? "事業主借" : "事業主貸";
  }
  return ACCOUNT_NAME_BY_METHOD[paymentMethod] ?? paymentMethod;
}
