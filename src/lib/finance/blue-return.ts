// 青色申告決算書（一般用）の各ページに載せる数値の組み立て。
//
// 1ページ 損益計算書
// 2ページ 月別売上（収入）金額及び仕入金額 / 給料賃金の内訳 / 専従者給与の内訳 /
//         貸倒引当金繰入額の計算 / 青色申告特別控除額の計算
// 3ページ 減価償却費の計算 / 利子割引料の内訳 / 地代家賃の内訳 / 税理士等の報酬・料金の内訳
// 4ページ 貸借対照表 / 製造原価の計算
//
// 65万円控除の要件（国税庁 No.2070）：複式簿記 ＋ 貸借対照表と損益計算書の添付
// ＋ 期限内申告 ＋ e-Tax 申告または優良な電子帳簿保存。

import { accountByCode, type Account } from "@/lib/finance/accounts";
import type { JournalEntry } from "@/lib/finance/journal";

/** 青色申告特別控除の上限（複式簿記＋e-Tax）。 */
export const BLUE_RETURN_DEDUCTION_MAX = 650_000;
/** e-Tax・優良な電子帳簿保存のいずれもない場合の上限。 */
export const BLUE_RETURN_DEDUCTION_WITHOUT_ETAX = 550_000;

/** 会計区分の正常側を正とする符号。決算書の金額はこの向きで載せる。 */
function naturalSign(account: Account): 1 | -1 {
  const naturalSide =
    account.type === "asset" || account.type === "expense" ? "debit" : "credit";
  return naturalSide === account.normalSide ? 1 : -1;
}

/** 仕訳行の、決算書に載せる向きの金額。 */
function statementAmountOfLine(
  account: Account,
  debit: number,
  credit: number,
): number {
  const net =
    account.normalSide === "debit" ? debit - credit : credit - debit;
  return naturalSign(account) * net;
}

export type MonthlyAmountRow = {
  /** 1〜12 */
  month: number;
  sales: number;
  purchases: number;
};

const SALES_SECTION = "売上（収入）金額";
const PURCHASE_SECTION = "当期仕入高";
/** 雑収入は月別欄ではなく専用行に載せる。 */
const MISC_INCOME_CODE = "4040";

export type MonthlySummary = {
  rows: MonthlyAmountRow[];
  salesTotal: number;
  purchasesTotal: number;
  /** 雑収入（月別欄の外に載せる） */
  miscIncome: number;
};

/**
 * 2ページ「月別売上（収入）金額及び仕入金額」。
 * 売上値引・返品や仕入値引・返品は控除性なので自動的に差し引かれる。
 */
export function buildMonthlySummary(
  journal: readonly JournalEntry[],
  fiscalYear: number,
): MonthlySummary {
  const rows: MonthlyAmountRow[] = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    sales: 0,
    purchases: 0,
  }));
  let miscIncome = 0;

  for (const entry of journal) {
    // 会計期間外の仕訳は載せない（決算整理仕訳は 12/31 なので12月に入る）。
    if (!entry.date.startsWith(`${fiscalYear}-`)) continue;
    const month = Number.parseInt(entry.date.slice(5, 7), 10);
    const row = rows[month - 1];
    if (!row) continue;

    for (const line of entry.lines) {
      const amount = statementAmountOfLine(
        line.account,
        line.debit,
        line.credit,
      );
      if (amount === 0) continue;

      if (line.account.code === MISC_INCOME_CODE) {
        miscIncome += amount;
      } else if (line.account.section === SALES_SECTION) {
        row.sales += amount;
      } else if (line.account.section === PURCHASE_SECTION) {
        row.purchases += amount;
      }
    }
  }

  return {
    rows,
    salesTotal: rows.reduce((sum, row) => sum + row.sales, 0),
    purchasesTotal: rows.reduce((sum, row) => sum + row.purchases, 0),
    miscIncome,
  };
}

export type PartnerBreakdownRow = {
  /** 支払先。未入力なら「（取引先未設定）」 */
  partner: string;
  amount: number;
  count: number;
};

/**
 * 支払先別の内訳。決算書2ページの給料賃金・専従者給与、
 * 3ページの利子割引料・地代家賃・税理士等の報酬に使う。
 */
export function buildPartnerBreakdown(
  journal: readonly JournalEntry[],
  accountCodes: readonly string[],
): PartnerBreakdownRow[] {
  const byPartner = new Map<string, PartnerBreakdownRow>();

  for (const entry of journal) {
    for (const line of entry.lines) {
      if (!accountCodes.includes(line.account.code)) continue;
      const amount = statementAmountOfLine(
        line.account,
        line.debit,
        line.credit,
      );
      if (amount === 0) continue;

      const partner = entry.partner.trim() || "（取引先未設定）";
      const existing = byPartner.get(partner);
      if (existing) {
        existing.amount += amount;
        existing.count += 1;
      } else {
        byPartner.set(partner, { partner, amount, count: 1 });
      }
    }
  }

  return [...byPartner.values()].sort((a, b) => b.amount - a.amount);
}

/** 決算書の内訳欄に対応する科目コード。 */
export const BREAKDOWN_ACCOUNT_CODES = {
  /** 給料賃金 */
  wages: ["6180"],
  /** 専従者給与 */
  familyWages: ["9010"],
  /** 利子割引料 */
  interest: ["6240", "7510"],
  /** 地代家賃 */
  rent: ["6250"],
  /** 税理士・弁護士等の報酬・料金 */
  professionalFees: ["6230"],
} as const;

export type BlueReturnDeduction = {
  /** 青色申告特別控除前の所得金額 */
  incomeBeforeDeduction: number;
  /** 適用できる控除額の上限 */
  limit: number;
  /** 実際の控除額（所得を超えて控除しない） */
  deduction: number;
  /** 控除後の所得金額 */
  incomeAfterDeduction: number;
};

/**
 * 2ページ「青色申告特別控除額の計算」。
 * 複式簿記＋貸借対照表添付を満たす前提で、e-Tax（または優良な電子帳簿保存）の
 * 有無で 65万円 / 55万円 を切り替える。控除は所得金額を上限とする。
 */
export function buildBlueReturnDeduction(
  incomeBeforeDeduction: number,
  usesEtax: boolean,
): BlueReturnDeduction {
  const limit = usesEtax
    ? BLUE_RETURN_DEDUCTION_MAX
    : BLUE_RETURN_DEDUCTION_WITHOUT_ETAX;
  const deduction = Math.min(limit, Math.max(0, incomeBeforeDeduction));
  return {
    incomeBeforeDeduction,
    limit,
    deduction,
    incomeAfterDeduction: incomeBeforeDeduction - deduction,
  };
}

export type BalanceSheetSideRow = {
  code: string;
  name: string;
  /** 期首残高（会計区分の正常側を正とする） */
  opening: number;
  /** 期末残高 */
  closing: number;
};

/**
 * 4ページ「貸借対照表」。期首（前年末）と期末の2時点を並べる。
 * 期首は前年度の決算スナップショット、期末は当年度の残高。
 */
export function buildBalanceSheetComparison(
  openingBalances: ReadonlyMap<string, number>,
  closingBalances: ReadonlyMap<string, number>,
): {
  assets: BalanceSheetSideRow[];
  liabilitiesAndEquity: BalanceSheetSideRow[];
  openingAssetTotal: number;
  closingAssetTotal: number;
  openingLiabilityEquityTotal: number;
  closingLiabilityEquityTotal: number;
} {
  const codes = [
    ...new Set([...openingBalances.keys(), ...closingBalances.keys()]),
  ].sort((a, b) => a.localeCompare(b));

  const assets: BalanceSheetSideRow[] = [];
  const liabilitiesAndEquity: BalanceSheetSideRow[] = [];

  for (const code of codes) {
    const account = accountByCode(code);
    if (!account) continue;
    // スナップショットは normalSide 基準なので決算書向きへ直す。
    const sign = naturalSign(account);
    const row: BalanceSheetSideRow = {
      code,
      name: account.name,
      opening: sign * (openingBalances.get(code) ?? 0),
      closing: sign * (closingBalances.get(code) ?? 0),
    };
    if (row.opening === 0 && row.closing === 0) continue;

    if (account.type === "asset") assets.push(row);
    else if (account.type === "liability" || account.type === "equity") {
      liabilitiesAndEquity.push(row);
    }
  }

  const sum = (rows: BalanceSheetSideRow[], pick: "opening" | "closing") =>
    rows.reduce((total, row) => total + row[pick], 0);

  return {
    assets,
    liabilitiesAndEquity,
    openingAssetTotal: sum(assets, "opening"),
    closingAssetTotal: sum(assets, "closing"),
    openingLiabilityEquityTotal: sum(liabilitiesAndEquity, "opening"),
    closingLiabilityEquityTotal: sum(liabilitiesAndEquity, "closing"),
  };
}
