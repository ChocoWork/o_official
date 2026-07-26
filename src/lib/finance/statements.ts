// 合計残高試算表から損益計算書・貸借対照表を組み立てる。
//
// 架空の係数は使わない。すべて仕訳の残高から導出する。
// 会計恒等式：資産 = 負債 + 純資産 + 当期純利益（決算振替前）
// これは試算表の貸借一致から自動的に従うので、成り立たなければどこかが壊れている。

import { ACCOUNTS, type Account, type AccountType } from "@/lib/finance/accounts";
import type { TrialBalance, TrialBalanceRow } from "@/lib/finance/journal";

/** 決算書区分の並び順。勘定科目マスタのコード順＝決算書の並び順。 */
const SECTION_ORDER: readonly string[] = [
  ...new Set(ACCOUNTS.map((account) => account.section)),
];

function sectionIndex(section: string): number {
  const index = SECTION_ORDER.indexOf(section);
  return index === -1 ? SECTION_ORDER.length : index;
}

export type StatementLine = {
  account: Account;
  /**
   * 会計区分の正常側を正とした残高。
   * 控除性・評価性の科目（売上値引、期末棚卸高、減価償却累計額など）は
   * 負の値になり、そのまま区分合計から差し引かれる。
   */
  amount: number;
};

export type StatementSection = {
  section: string;
  lines: StatementLine[];
  total: number;
};

/** 会計区分の正常側。資産・費用は借方、負債・純資産・収益は貸方。 */
function naturalSide(type: AccountType): "debit" | "credit" {
  return type === "asset" || type === "expense" ? "debit" : "credit";
}

/**
 * 決算書に載せる金額。会計区分の正常側を正とする。
 * normalSide 基準（元帳・試算表の残高）とは符号が異なる場合があり、
 * その差が控除性・評価性の科目にあたる。
 */
function statementAmount(row: TrialBalanceRow): number {
  const net = row.debitBalance - row.creditBalance;
  return naturalSide(row.account.type) === "debit" ? net : -net;
}

function groupBySection(rows: readonly TrialBalanceRow[]): StatementSection[] {
  const bySection = new Map<string, StatementLine[]>();

  for (const row of rows) {
    const amount = statementAmount(row);
    // 残高0の科目は決算書に出さない。
    if (amount === 0) continue;
    const lines = bySection.get(row.account.section) ?? [];
    lines.push({ account: row.account, amount });
    bySection.set(row.account.section, lines);
  }

  return [...bySection.entries()]
    .map(([section, lines]) => ({
      section,
      lines: lines.sort((a, b) =>
        a.account.code.localeCompare(b.account.code),
      ),
      total: lines.reduce((sum, line) => sum + line.amount, 0),
    }))
    .sort((a, b) => sectionIndex(a.section) - sectionIndex(b.section));
}

function totalForTypes(
  rows: readonly TrialBalanceRow[],
  types: readonly AccountType[],
): number {
  return rows
    .filter((row) => types.includes(row.account.type))
    .reduce((sum, row) => sum + statementAmount(row), 0);
}

function totalForSections(
  rows: readonly TrialBalanceRow[],
  sections: readonly string[],
): number {
  return rows
    .filter((row) => sections.includes(row.account.section))
    .reduce((sum, row) => sum + statementAmount(row), 0);
}

export type ProfitAndLoss = {
  /** 決算書区分ごとの明細（収益・費用のみ） */
  sections: StatementSection[];
  /** 売上（収入）金額。売上値引・返品は控除性なので自動で差し引かれる。 */
  sales: number;
  /** 期首商品（製品）棚卸高 */
  openingInventory: number;
  /** 当期仕入高（仕入値引・返品を控除済み） */
  purchases: number;
  /** 期末商品（製品）棚卸高（控除性なので貸方に立つ） */
  closingInventory: number;
  /** 差引原価 = 期首棚卸 + 当期仕入 − 期末棚卸 */
  costOfSales: number;
  /** 売上総利益 */
  grossProfit: number;
  /** 経費合計 */
  operatingExpenses: number;
  /** 差引金額（営業利益相当） */
  operatingProfit: number;
  /** 営業外収益 − 営業外費用 */
  nonOperatingBalance: number;
  /** 特別利益 − 特別損失 */
  extraordinaryBalance: number;
  /** 繰戻額等 − 繰入額等（専従者給与・引当金・青色申告特別控除） */
  provisionBalance: number;
  /** 収益合計・費用合計（会計区分ベース） */
  revenueTotal: number;
  expenseTotal: number;
  /** 当期純利益 = 収益合計 − 費用合計 */
  netIncome: number;
};

const SALES_SECTIONS = ["売上（収入）金額"];
const OPENING_INVENTORY_SECTIONS = ["期首商品（製品）棚卸高"];
const PURCHASE_SECTIONS = ["当期仕入高"];
const CLOSING_INVENTORY_SECTIONS = ["期末商品（製品）棚卸高"];
const OPERATING_EXPENSE_SECTIONS = ["経費"];
const NON_OPERATING_SECTIONS = ["営業外収益", "営業外費用"];
const EXTRAORDINARY_SECTIONS = ["特別利益", "特別損失"];
const PROVISION_SECTIONS = ["繰戻額等", "繰入額等", "税金"];

export function buildProfitAndLoss(trial: TrialBalance): ProfitAndLoss {
  const rows = trial.rows;
  const plRows = rows.filter(
    (row) => row.account.type === "revenue" || row.account.type === "expense",
  );

  const sales = totalForSections(rows, SALES_SECTIONS);
  const openingInventory = totalForSections(rows, OPENING_INVENTORY_SECTIONS);
  const purchases = totalForSections(rows, PURCHASE_SECTIONS);
  // 期末棚卸高は控除性（費用のマイナス）。決算書には正の値で載せるので符号を反転する。
  const closingInventory = -totalForSections(
    rows,
    CLOSING_INVENTORY_SECTIONS,
  );
  const costOfSales = openingInventory + purchases - closingInventory;
  const operatingExpenses = totalForSections(rows, OPERATING_EXPENSE_SECTIONS);

  // 営業外・特別・繰入は「収益 − 費用」で符号をそろえる。
  const signedBySection = (sections: readonly string[]) =>
    rows
      .filter((row) => sections.includes(row.account.section))
      .reduce(
        (sum, row) =>
          sum
          + (row.account.type === "revenue" ? 1 : -1) * statementAmount(row),
        0,
      );

  const revenueTotal = totalForTypes(rows, ["revenue"]);
  const expenseTotal = totalForTypes(rows, ["expense"]);
  const grossProfit = sales - costOfSales;

  return {
    sections: groupBySection(plRows),
    sales,
    openingInventory,
    purchases,
    closingInventory,
    costOfSales,
    grossProfit,
    operatingExpenses,
    operatingProfit: grossProfit - operatingExpenses,
    nonOperatingBalance: signedBySection(NON_OPERATING_SECTIONS),
    extraordinaryBalance: signedBySection(EXTRAORDINARY_SECTIONS),
    provisionBalance: signedBySection(PROVISION_SECTIONS),
    revenueTotal,
    expenseTotal,
    netIncome: revenueTotal - expenseTotal,
  };
}

export type BalanceSheet = {
  assetSections: StatementSection[];
  liabilitySections: StatementSection[];
  equitySections: StatementSection[];
  assetTotal: number;
  liabilityTotal: number;
  /** 元入金・事業主借など、当期純利益を含まない純資産 */
  equityTotal: number;
  /** 当期純利益。決算振替前なので純資産に別行で足す。 */
  netIncome: number;
  /** 負債 + 純資産 + 当期純利益 */
  liabilityAndEquityTotal: number;
  /** 資産 = 負債 + 純資産 + 当期純利益 が成り立つか */
  isBalanced: boolean;
  difference: number;
};

export function buildBalanceSheet(trial: TrialBalance): BalanceSheet {
  const rows = trial.rows;
  const assetRows = rows.filter((row) => row.account.type === "asset");
  const liabilityRows = rows.filter((row) => row.account.type === "liability");
  const equityRows = rows.filter((row) => row.account.type === "equity");

  const assetTotal = totalForTypes(rows, ["asset"]);
  const liabilityTotal = totalForTypes(rows, ["liability"]);
  const equityTotal = totalForTypes(rows, ["equity"]);
  const netIncome =
    totalForTypes(rows, ["revenue"]) - totalForTypes(rows, ["expense"]);
  const liabilityAndEquityTotal = liabilityTotal + equityTotal + netIncome;

  return {
    assetSections: groupBySection(assetRows),
    liabilitySections: groupBySection(liabilityRows),
    equitySections: groupBySection(equityRows),
    assetTotal,
    liabilityTotal,
    equityTotal,
    netIncome,
    liabilityAndEquityTotal,
    isBalanced: assetTotal === liabilityAndEquityTotal,
    difference: assetTotal - liabilityAndEquityTotal,
  };
}
