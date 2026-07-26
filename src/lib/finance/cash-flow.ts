// キャッシュ・フロー計算書（直接法）。
//
// 現金・預金科目の総勘定元帳の動きを、相手科目で営業／投資／財務に分類する。
// 間接法（PL と BS 2時点から逆算）より実装が軽く、誤差も出ない。
// 個人事業主の確定申告に C/F は法定でないが、資金の実態は経営判断に必須。

import type { Account } from "@/lib/finance/accounts";
import type { LedgerAccount } from "@/lib/finance/journal";

/** 資金（現金及び預金）とみなす決算書区分。 */
const CASH_SECTION = "現金及び預金";

/** 投資活動とみなす相手科目の決算書区分。 */
const INVESTING_SECTIONS = [
  "有価証券",
  "有形固定資産",
  "無形固定資産",
  "投資その他の資産",
  "繰延資産",
];

/** 財務活動とみなす相手科目名。借入・出資・事業主との資金移動。 */
const FINANCING_ACCOUNT_NAMES = [
  "短期借入金",
  "長期借入金",
  "役員借入金",
  "社債",
  "長期未払金",
  "元入金",
  "事業主貸",
  "事業主借",
  "資本金",
  "資本準備金",
  "自己株式",
  "未払配当金",
];

export type CashFlowCategory = "operating" | "investing" | "financing";

export const CASH_FLOW_CATEGORY_LABELS: Record<CashFlowCategory, string> = {
  operating: "営業活動によるキャッシュ・フロー",
  investing: "投資活動によるキャッシュ・フロー",
  financing: "財務活動によるキャッシュ・フロー",
};

export function isCashAccount(account: Account): boolean {
  return account.section === CASH_SECTION;
}

/** 相手科目から活動区分を決める。判定できないものは営業活動に寄せる。 */
export function categorizeCounterAccount(
  counterAccountName: string,
  lookup: (name: string) => Account | undefined,
): CashFlowCategory {
  if (FINANCING_ACCOUNT_NAMES.includes(counterAccountName)) return "financing";
  const account = lookup(counterAccountName);
  if (account && INVESTING_SECTIONS.includes(account.section)) {
    return "investing";
  }
  return "operating";
}

export type CashFlowLine = {
  category: CashFlowCategory;
  /** 相手科目名 */
  account: string;
  /** 収入は正、支出は負 */
  amount: number;
};

export type CashFlow = {
  openingCash: number;
  operating: number;
  investing: number;
  financing: number;
  /** 期末現金・預金残高 */
  closingCash: number;
  /** 活動区分×相手科目の明細（金額の大きい順） */
  lines: CashFlowLine[];
  /**
   * 元帳の期末残高との差額。直接法なので 0 になるのが正しい。
   * 0 でなければ資金科目の判定漏れがある。
   */
  difference: number;
};

/**
 * 現金・預金科目の元帳から直接法の C/F を組む。
 * 資金科目間の振替（現金→普通預金など）は資金総額を動かさないので除外する。
 */
export function buildCashFlow(
  ledger: readonly LedgerAccount[],
  lookup: (name: string) => Account | undefined,
): CashFlow {
  const cashLedgers = ledger.filter((row) => isCashAccount(row.account));

  const openingCash = cashLedgers.reduce(
    (sum, row) => sum + row.openingBalance,
    0,
  );
  const closingCash = cashLedgers.reduce(
    (sum, row) => sum + row.closingBalance,
    0,
  );

  const byKey = new Map<string, CashFlowLine>();
  const totals: Record<CashFlowCategory, number> = {
    operating: 0,
    investing: 0,
    financing: 0,
  };

  for (const cashLedger of cashLedgers) {
    for (const row of cashLedger.rows) {
      const counter = lookup(row.counterAccount);
      // 資金科目間の振替は資金総額に影響しないため C/F に載せない。
      if (counter && isCashAccount(counter)) continue;

      const amount = row.debit - row.credit;
      if (amount === 0) continue;

      const category = categorizeCounterAccount(row.counterAccount, lookup);
      totals[category] += amount;

      const key = `${category}:${row.counterAccount}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.amount += amount;
      } else {
        byKey.set(key, {
          category,
          account: row.counterAccount,
          amount,
        });
      }
    }
  }

  const lines = [...byKey.values()]
    .filter((line) => line.amount !== 0)
    .sort(
      (a, b) =>
        a.category.localeCompare(b.category)
        || Math.abs(b.amount) - Math.abs(a.amount),
    );

  const netChange = totals.operating + totals.investing + totals.financing;

  return {
    openingCash,
    operating: totals.operating,
    investing: totals.investing,
    financing: totals.financing,
    closingCash,
    lines,
    difference: openingCash + netChange - closingCash,
  };
}
