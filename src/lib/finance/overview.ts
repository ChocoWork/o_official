// 財務概要（ACCOUNTING > 財務概要）の派生値。
//
// 仕訳・元帳・試算表・財務3表の計算には手を入れず、そこから導ける
// 「資金推移」「資金予定」「アクション」「構成比」だけをここで組み立てる。
// 架空の係数は使わない。目標線のように前提入力が要る値は、前提が無ければ null を返す。

import { isCashAccount } from "@/lib/finance/cash-flow";
import type {
  FinanceEntry,
  LedgerAccount,
  TrialBalance,
} from "@/lib/finance/journal";
import {
  accountByName,
  resolveAccount,
  type BusinessType,
} from "@/lib/finance/accounts";
import { paymentMethodAccountName } from "@/lib/finance/payment-methods";

/** 売上債権（未回収）とみなす決算書区分。 */
const RECEIVABLE_SECTIONS = ["売上債権"];
/** 仕入債務（未払）とみなす決算書区分。クレジットカード払いは未払金に立つ。 */
const PAYABLE_SECTIONS = ["仕入債務"];
const PAYABLE_ACCOUNT_CODES = ["2130", "2140"];

/** 売上高構成の集計対象（収入取引のうち、売上として立ったもの）。 */
const SALES_SECTION = "売上（収入）金額";
/** 売上原価を構成する決算書区分（期末棚卸は控除項目なので構成比に載せない）。 */
const COST_OF_SALES_SECTIONS = ["期首商品（製品）棚卸高", "当期仕入高"];
/** 販売費及び一般管理費として扱う決算書区分（青色申告決算書の「経費」）。 */
const SGA_SECTION = "経費";

export const MONTH_LABELS = [
  "1月",
  "2月",
  "3月",
  "4月",
  "5月",
  "6月",
  "7月",
  "8月",
  "9月",
  "10月",
  "11月",
  "12月",
] as const;

export type CashTrendPoint = {
  label: string;
  /** 月末の資金残高 */
  balance: number;
  /** 当月の資金増減 */
  net: number;
  /** 期首からの累積増減 */
  cumulativeNet: number;
};

export type CashTrend = {
  openingCash: number;
  closingCash: number;
  points: CashTrendPoint[];
};

/**
 * 月末の資金残高の推移。
 * 現金・預金科目の元帳を月で束ねるだけなので、C/F の期末残高と必ず一致する。
 */
export function buildMonthlyCashTrend(
  ledger: readonly LedgerAccount[],
  fiscalYear: number,
): CashTrend {
  const cashLedgers = ledger.filter((row) => isCashAccount(row.account));
  const openingCash = cashLedgers.reduce(
    (sum, row) => sum + row.openingBalance,
    0,
  );

  const netByMonth = new Array<number>(12).fill(0);
  for (const cashLedger of cashLedgers) {
    for (const row of cashLedger.rows) {
      if (Number.parseInt(row.date.slice(0, 4), 10) !== fiscalYear) continue;
      const month = Number.parseInt(row.date.slice(5, 7), 10);
      if (!Number.isFinite(month) || month < 1 || month > 12) continue;
      netByMonth[month - 1] += row.debit - row.credit;
    }
  }

  let balance = openingCash;
  let cumulativeNet = 0;
  const points = netByMonth.map((net, index) => {
    balance += net;
    cumulativeNet += net;
    return { label: MONTH_LABELS[index], balance, net, cumulativeNet };
  });

  return { openingCash, closingCash: balance, points };
}

/** 安全水準：3ヶ月分の固定費（経費の月平均×3）。経費が無ければ 0。 */
export function cashSafetyLevel(operatingExpenses: number): number {
  return Math.max(0, Math.round((operatingExpenses / 12) * 3));
}

/**
 * 資金の目標線。
 * 期首資金に「計画利益（財務前提の売上見込み − 当期費用実績）」を月割で積む。
 * 売上見込みが未入力なら目標を描かない（架空の目標を置かない）。
 */
export function buildCashTargetLine(
  openingCash: number,
  plannedSales: number,
  expenseTotal: number,
): number[] | null {
  if (plannedSales <= 0) return null;
  const monthlyGain = (plannedSales - expenseTotal) / 12;
  return MONTH_LABELS.map((_, index) =>
    Math.round(openingCash + monthlyGain * (index + 1)),
  );
}

export type ScheduleRow = {
  id: number;
  date: string;
  partner: string;
  item: string;
  amount: number;
};

export type CashSchedule = {
  from: string;
  to: string;
  incoming: ScheduleRow[];
  outgoing: ScheduleRow[];
  incomingTotal: number;
  outgoingTotal: number;
};

/** ISO日付（YYYY-MM-DD）に日数を足す。 */
export function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * 今後 n 日の資金予定。
 * 予定日を持つ別テーブルは無いため、登録済みで日付が未来の取引を予定として扱う。
 * （取引管理で先付けの取引を入れた分がそのまま資金予定になる）
 */
export function buildCashSchedule(
  entries: readonly FinanceEntry[],
  today: string,
  days = 30,
): CashSchedule {
  const to = addDays(today, days);
  const inWindow = entries
    .filter((entry) => entry.date >= today && entry.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
    .map((entry) => ({
      id: entry.id,
      date: entry.date,
      partner: entry.partner,
      item: entry.item,
      amount: entry.amount,
      entryType: entry.entryType,
    }));

  const incoming = inWindow.filter((row) => row.entryType === "income");
  const outgoing = inWindow.filter((row) => row.entryType === "expense");
  const sum = (rows: typeof incoming) =>
    rows.reduce((total, row) => total + row.amount, 0);

  return {
    from: today,
    to,
    incoming,
    outgoing,
    incomingTotal: sum(incoming),
    outgoingTotal: sum(outgoing),
  };
}

/** 決算書区分・科目コードの合計残高（正常側を正とする）。 */
function balanceOf(
  trial: TrialBalance,
  sections: readonly string[],
  codes: readonly string[] = [],
): number {
  return trial.rows
    .filter(
      (row) =>
        sections.includes(row.account.section) ||
        codes.includes(row.account.code),
    )
    .reduce((sum, row) => {
      const net = row.debitBalance - row.creditBalance;
      return sum + (row.account.normalSide === "debit" ? net : -net);
    }, 0);
}

export function receivableBalance(trial: TrialBalance): number {
  return balanceOf(trial, RECEIVABLE_SECTIONS);
}

export function payableBalance(trial: TrialBalance): number {
  return balanceOf(trial, PAYABLE_SECTIONS, PAYABLE_ACCOUNT_CODES);
}

/**
 * 掛け（売上債権）で計上した収入の件数。
 * 入金方法が売掛金・受取手形などの取引は、資金がまだ入っていない。
 */
export function countReceivableEntries(
  incomes: readonly FinanceEntry[],
  businessType: BusinessType,
): number {
  return incomes.filter((entry) => {
    const account = accountByName(
      paymentMethodAccountName(entry.paymentMethod, businessType, "income"),
    );
    return (
      account !== undefined && RECEIVABLE_SECTIONS.includes(account.section)
    );
  }).length;
}

/** 遷移先のサブタブ。詳細を確認できる画面へ送る。 */
export type OverviewActionTarget = "expenses" | "journal";

export type OverviewAction = {
  key: string;
  message: string;
  target: OverviewActionTarget;
};

export type OverviewActionInput = {
  trial: TrialBalance;
  /** 掛け（売上債権）で計上した収入の件数 */
  receivableEntryCount: number;
  /** 7日以内に支払予定の取引 */
  dueSoon: ScheduleRow[];
  closingCash: number;
  safetyLevel: number;
  /** 元帳・C/F の検算が合っているか */
  isBalanced: boolean;
};

/**
 * 要対応の項目。条件を満たしたものだけを返すので、
 * 空配列＝対応が必要な項目なし。
 */
export function buildOverviewActions({
  trial,
  receivableEntryCount,
  dueSoon,
  closingCash,
  safetyLevel,
  isBalanced,
}: OverviewActionInput): OverviewAction[] {
  const actions: OverviewAction[] = [];

  const receivable = receivableBalance(trial);
  if (receivable > 0) {
    actions.push({
      key: "receivable",
      message: `未入金${receivableEntryCount > 0 ? ` ${receivableEntryCount}件` : ""}（売上債権 ¥${receivable.toLocaleString("ja-JP")}）を確認`,
      target: "expenses",
    });
  }

  if (dueSoon.length > 0) {
    const total = dueSoon.reduce((sum, row) => sum + row.amount, 0);
    actions.push({
      key: "due-soon",
      message: `7日以内の支払 ${dueSoon.length}件（¥${total.toLocaleString("ja-JP")}）`,
      target: "expenses",
    });
  }

  const payable = payableBalance(trial);
  if (payable > 0) {
    actions.push({
      key: "payable",
      message: `未払の仕入債務 ¥${payable.toLocaleString("ja-JP")} を確認`,
      target: "expenses",
    });
  }

  if (safetyLevel > 0 && closingCash < safetyLevel) {
    actions.push({
      key: "runway",
      message: `手元資金が安全水準（3ヶ月分固定費 ¥${safetyLevel.toLocaleString("ja-JP")}）を下回る`,
      target: "journal",
    });
  }

  if (!isBalanced) {
    actions.push({
      key: "unbalanced",
      message: "帳簿の貸借差額を確認",
      target: "journal",
    });
  }

  return actions;
}

export type CompositionItem = {
  label: string;
  amount: number;
  /** 構成比（%）。合計が 100 になるよう最大項目で端数を吸収する。 */
  ratio: number;
};

/**
 * 構成比。金額の大きい順に limit 件まで残し、以降は「その他」へまとめる。
 * 端数処理で合計が 100% からずれないよう、差分を先頭（最大）の項目へ寄せる。
 */
export function buildComposition(
  items: readonly { label: string; amount: number }[],
  limit = 4,
): CompositionItem[] {
  const positive = items
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  if (positive.length === 0) return [];

  const head = positive.slice(0, limit);
  const rest = positive.slice(limit);
  const rows =
    rest.length > 0
      ? [
          ...head,
          {
            label: "その他",
            amount: rest.reduce((sum, item) => sum + item.amount, 0),
          },
        ]
      : head;

  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const composition = rows.map((row) => ({
    label: row.label,
    amount: row.amount,
    ratio: Math.round((row.amount / total) * 1000) / 10,
  }));

  const drift =
    Math.round(
      (100 - composition.reduce((sum, row) => sum + row.ratio, 0)) * 10,
    ) / 10;
  composition[0] = {
    ...composition[0],
    ratio: Math.round((composition[0].ratio + drift) * 10) / 10,
  };
  return composition;
}

/** 売上高構成。売上として立った収入取引を「収入概要」で束ねる。 */
export function buildSalesComposition(
  incomes: readonly FinanceEntry[],
  limit = 4,
): CompositionItem[] {
  const byItem = new Map<string, number>();
  for (const entry of incomes) {
    if (resolveAccount(entry.category).section !== SALES_SECTION) continue;
    const label = entry.item || "未設定";
    byItem.set(label, (byItem.get(label) ?? 0) + entry.amount);
  }
  return buildComposition(
    [...byItem.entries()].map(([label, amount]) => ({ label, amount })),
    limit,
  );
}

function compositionFromSections(
  trial: TrialBalance,
  sections: readonly string[],
  limit: number,
): CompositionItem[] {
  return buildComposition(
    trial.rows
      .filter((row) => sections.includes(row.account.section))
      .map((row) => ({
        label: row.account.name,
        amount: row.debitBalance - row.creditBalance,
      })),
    limit,
  );
}

/** 売上原価構成（期首棚卸・当期仕入）。期末棚卸は控除項目なので含めない。 */
export function buildCostOfSalesComposition(
  trial: TrialBalance,
  limit = 4,
): CompositionItem[] {
  return compositionFromSections(trial, COST_OF_SALES_SECTIONS, limit);
}

/** 販売費及び一般管理費構成（経費の勘定科目別）。 */
export function buildSgaComposition(
  trial: TrialBalance,
  limit = 4,
): CompositionItem[] {
  return compositionFromSections(trial, [SGA_SECTION], limit);
}
