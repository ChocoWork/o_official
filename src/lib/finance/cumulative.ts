// 開業以来の累計。
//
// 貸借対照表は「時点」の表なので期末残高に累積が自然に現れるが、
// 損益は「期間」の表なので年度で切ると開業以来の積み上げが見えない。
// ブランドの体力（累計でいくら売り、いくら残り、いくら投資したか）は
// 年度PLだけでは分からないため、別枠の指標として出す。

import { resolveAccount } from "@/lib/finance/accounts";
import { depreciationForYear, type FixedAsset } from "@/lib/finance/depreciation";
import type { EntryType } from "@/lib/finance/journal";

/** 累計集計に必要な最小限の取引データ。 */
export type CumulativeEntry = {
  entryType: EntryType;
  date: string;
  /** 勘定科目名（相手科目） */
  category: string;
  amount: number;
};

export type CumulativeSummary = {
  /** 累計売上（収入）金額。売上値引・返品は控除済み。 */
  sales: number;
  /** 累計費用（減価償却費を含む） */
  expenses: number;
  /**
   * 累計売上原価。棚卸は年度をまたぐと期首＝前年期末で相殺されるため、
   * 累計では実質「当期仕入高の積み上げ」になる。
   */
  costOfSales: number;
  /** 累計販売費及び一般管理費（経費。減価償却費を含む） */
  operatingExpenses: number;
  /** 累計利益 = 累計収益 − 累計費用 */
  netIncome: number;
  /** 累計設備投資（固定資産の取得価額） */
  capitalInvestment: number;
  /** 集計対象の取引件数 */
  entryCount: number;
  /** 最初の取引があった年（開業年の目安）。取引がなければ null。 */
  firstYear: number | null;
};

/** 売上原価を構成する決算書区分。overview.ts の構成比と同じ区分で揃える。 */
const COST_OF_SALES_SECTIONS = ["期首商品（製品）棚卸高", "当期仕入高"];
/** 販売費及び一般管理費として扱う決算書区分（青色申告決算書の「経費」）。 */
const SGA_SECTION = "経費";

function yearOf(date: string): number {
  return Number.parseInt(date.slice(0, 4), 10);
}

/**
 * 資産の取得年から対象年までの必要経費算入額の累計。
 * 事業専用割合の按分後の額なので、そのまま累計費用に足せる。
 */
function cumulativeDepreciationExpense(
  asset: FixedAsset,
  throughYear: number,
): number {
  const acquiredYear = yearOf(asset.acquiredOn);
  let total = 0;
  for (let year = acquiredYear; year <= throughYear; year += 1) {
    total += depreciationForYear(asset, year).businessExpense;
  }
  return total;
}

/**
 * 開業以来（対象年の年末まで）の累計。
 * 取引の相手科目だけを見る。資金側（出金方法・入金方法）は必ず
 * 資産・負債・純資産の科目なので損益には影響しない。
 */
export function buildCumulativeSummary(
  entries: readonly CumulativeEntry[],
  assets: readonly FixedAsset[],
  throughYear: number,
): CumulativeSummary {
  const yearEnd = `${throughYear}-12-31`;
  const target = entries.filter((entry) => entry.date <= yearEnd);

  let sales = 0;
  let expenses = 0;
  let costOfSales = 0;
  let operatingExpenses = 0;
  let firstYear: number | null = null;

  for (const entry of target) {
    const account = resolveAccount(entry.category);
    // 支出は相手科目が借方、収入は貸方に立つ。
    const debited = entry.entryType === "expense";

    if (account.type === "revenue") {
      sales += debited ? -entry.amount : entry.amount;
    } else if (account.type === "expense") {
      const delta = debited ? entry.amount : -entry.amount;
      expenses += delta;
      // 費用の内訳。どちらにも当たらない営業外費用等は合計にだけ効く。
      if (COST_OF_SALES_SECTIONS.includes(account.section)) {
        costOfSales += delta;
      } else if (account.section === SGA_SECTION) {
        operatingExpenses += delta;
      }
    }

    const year = yearOf(entry.date);
    if (firstYear === null || year < firstYear) firstYear = year;
  }

  // 減価償却費は仕訳ではなく固定資産台帳から生成されるため別途足す。
  // 決算書上は「経費」なので販管費にも積む。
  const acquiredAssets = assets.filter(
    (asset) => asset.acquiredOn <= yearEnd,
  );
  for (const asset of acquiredAssets) {
    const depreciation = cumulativeDepreciationExpense(asset, throughYear);
    expenses += depreciation;
    operatingExpenses += depreciation;
  }

  return {
    sales,
    expenses,
    costOfSales,
    operatingExpenses,
    netIncome: sales - expenses,
    capitalInvestment: acquiredAssets.reduce(
      (sum, asset) => sum + asset.acquisitionCost,
      0,
    ),
    entryCount: target.length,
    firstYear,
  };
}
