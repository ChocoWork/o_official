// 決算処理（年度締め）。
//
// 決算整理仕訳（棚卸・引当金）と、期末残高スナップショットの生成を担う。
// 減価償却の決算整理仕訳は buildDepreciationEntries（journal.ts）が作る。
//
// 期末残高スナップショットは翌年度の期首残高になる。ここで
//   ・損益科目を0にする（決算振替）
//   ・個人事業主は 事業主貸／事業主借 を元入金へ振り替える
//   ・法人は当期純利益を繰越利益剰余金へ振り替える
// を行うので、翌年期首BS = 当年期末BS が構造的に成り立つ。

import {
  accountByCode,
  resolveAccount,
  type BusinessType,
} from "@/lib/finance/accounts";
import type { JournalEntry, TrialBalance } from "@/lib/finance/journal";

/** 決算整理の入力値（実地棚卸・引当金）。期首棚卸は前年の期末棚卸なので入力しない。 */
export type YearEndAdjustment = {
  /** 期末商品（製品）棚卸高 */
  closingInventoryGoods: number;
  /** 期末材料棚卸高 */
  closingInventoryMaterials: number;
  /** 貸倒引当金繰入額 */
  allowanceForDoubtful: number;
};

export const EMPTY_YEAR_END_ADJUSTMENT: YearEndAdjustment = {
  closingInventoryGoods: 0,
  closingInventoryMaterials: 0,
  allowanceForDoubtful: 0,
};

/** 棚卸資産の科目コード。商品(1310) / 材料(1330)。 */
const GOODS_CODE = "1310";
const MATERIALS_CODE = "1330";
/** 事業主貸(1910) / 元入金(2910) / 事業主借(2920) / 繰越利益剰余金(3040) */
const OWNER_DRAW_CODE = "1910";
const CAPITAL_CODE = "2910";
const OWNER_LOAN_CODE = "2920";
const RETAINED_EARNINGS_CODE = "3040";

function entryOf(
  fiscalYear: number,
  suffix: string,
  description: string,
  debitAccount: string,
  creditAccount: string,
  amount: number,
): JournalEntry {
  const date = `${fiscalYear}-12-31`;
  return {
    // 決算整理仕訳は取引 id と衝突しない負の連番。
    entryId: -1_000_000 - suffix.charCodeAt(suffix.length - 1),
    number: `JE-${date.replaceAll("-", "")}-${suffix}`,
    date,
    description,
    partner: "",
    lines: [
      { account: resolveAccount(debitAccount), debit: amount, credit: 0 },
      { account: resolveAccount(creditAccount), debit: 0, credit: amount },
    ],
  };
}

/**
 * 棚卸の決算整理仕訳（三分法）。
 *   借方 期首商品棚卸高 / 貸方 商品   ← 前期末の在庫を当期の費用へ振替
 *   借方 商品 / 貸方 期末商品棚卸高   ← 実地棚卸の在庫を資産へ計上
 * これで商品勘定の期末残高が実地棚卸額に一致する。
 */
export function buildInventoryEntries(
  adjustment: YearEndAdjustment,
  openingBalances: ReadonlyMap<string, number>,
  fiscalYear: number,
): JournalEntry[] {
  const entries: JournalEntry[] = [];

  const openingGoods = openingBalances.get(GOODS_CODE) ?? 0;
  if (openingGoods > 0) {
    entries.push(
      entryOf(
        fiscalYear,
        "I01",
        "期首商品棚卸高の振替",
        "期首商品棚卸高",
        "商品",
        openingGoods,
      ),
    );
  }
  if (adjustment.closingInventoryGoods > 0) {
    entries.push(
      entryOf(
        fiscalYear,
        "I02",
        "期末商品棚卸高の計上",
        "商品",
        "期末商品棚卸高",
        adjustment.closingInventoryGoods,
      ),
    );
  }

  const openingMaterials = openingBalances.get(MATERIALS_CODE) ?? 0;
  if (openingMaterials > 0) {
    entries.push(
      entryOf(
        fiscalYear,
        "I03",
        "期首材料棚卸高の振替",
        "期首材料棚卸高",
        "材料",
        openingMaterials,
      ),
    );
  }
  if (adjustment.closingInventoryMaterials > 0) {
    entries.push(
      entryOf(
        fiscalYear,
        "I04",
        "期末材料棚卸高の計上",
        "材料",
        "期末材料棚卸高",
        adjustment.closingInventoryMaterials,
      ),
    );
  }

  return entries;
}

/** 貸倒引当金繰入の決算整理仕訳。借方 貸倒引当金繰入 / 貸方 貸倒引当金。 */
export function buildAllowanceEntries(
  adjustment: YearEndAdjustment,
  fiscalYear: number,
): JournalEntry[] {
  if (adjustment.allowanceForDoubtful <= 0) return [];
  return [
    entryOf(
      fiscalYear,
      "A01",
      "貸倒引当金繰入",
      "貸倒引当金繰入",
      "貸倒引当金",
      adjustment.allowanceForDoubtful,
    ),
  ];
}

/**
 * 期末残高スナップショット（翌年度の期首残高）。
 *
 * 損益科目は0にし（決算振替）、その利益を純資産へ振り替える。
 *   個人事業主：翌年元入金 = 当年元入金 + 当期純利益 + 事業主借 − 事業主貸
 *               事業主貸・事業主借は0にする
 *   法人      ：繰越利益剰余金 += 当期純利益
 *
 * 結果として「資産（事業主貸を除く）= 負債 + 純資産」が成立する。
 */
export function buildClosingBalances(
  trial: TrialBalance,
  businessType: BusinessType,
): Map<string, number> {
  const closing = new Map<string, number>();

  let netIncome = 0;
  let ownerDraw = 0;
  let ownerLoan = 0;
  let capital = 0;
  let retainedEarnings = 0;

  for (const row of trial.rows) {
    const { code, type } = row.account;
    // normalSide 基準の残高。
    const balance =
      row.account.normalSide === "debit"
        ? row.debitBalance - row.creditBalance
        : row.creditBalance - row.debitBalance;

    // 損益科目は決算振替で0になる。会計区分の正常側を正として利益に集める。
    if (type === "revenue") {
      netIncome +=
        row.account.normalSide === "credit" ? balance : -balance;
      continue;
    }
    if (type === "expense") {
      netIncome -=
        row.account.normalSide === "debit" ? balance : -balance;
      continue;
    }

    if (code === OWNER_DRAW_CODE) {
      ownerDraw = balance;
      continue;
    }
    if (code === OWNER_LOAN_CODE) {
      ownerLoan = balance;
      continue;
    }
    if (code === CAPITAL_CODE) {
      capital = balance;
      continue;
    }
    if (code === RETAINED_EARNINGS_CODE) {
      retainedEarnings = balance;
      continue;
    }

    // 資産・負債・その他の純資産はそのまま繰り越す。
    if (balance !== 0) closing.set(code, balance);
  }

  if (businessType === "soleProprietor") {
    // 事業主貸・事業主借は元入金へ吸収されて0になる。
    const nextCapital = capital + netIncome + ownerLoan - ownerDraw;
    if (nextCapital !== 0) closing.set(CAPITAL_CODE, nextCapital);
  } else {
    if (capital !== 0) closing.set(CAPITAL_CODE, capital);
    const nextRetained = retainedEarnings + netIncome;
    if (nextRetained !== 0) closing.set(RETAINED_EARNINGS_CODE, nextRetained);
  }

  return closing;
}

/**
 * 期首残高の貸借検算。
 * 借方残の科目合計 = 貸方残の科目合計 になっていること。
 */
export function verifyOpeningBalances(
  balances: ReadonlyMap<string, number>,
): { debitTotal: number; creditTotal: number; isBalanced: boolean } {
  let debitTotal = 0;
  let creditTotal = 0;

  for (const [code, amount] of balances) {
    const account = accountByCode(code);
    if (!account) continue;
    // normalSide 基準の残高を借方・貸方へ振り分ける。
    const onDebitSide = account.normalSide === "debit";
    if (amount >= 0) {
      if (onDebitSide) debitTotal += amount;
      else creditTotal += amount;
    } else if (onDebitSide) {
      creditTotal -= amount;
    } else {
      debitTotal -= amount;
    }
  }

  return {
    debitTotal,
    creditTotal,
    isBalanced: debitTotal === creditTotal,
  };
}
