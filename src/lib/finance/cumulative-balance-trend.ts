import type { FinanceEntry } from '@/lib/finance/journal';
import { periodMonthIndexOf, periodMonthsOf, type PeriodBounds } from '@/lib/finance/period-range';

export type CumulativeBalanceTrendPoint = {
  /** `YYYY-MM` */
  key: string;
  /** 暦の月（1〜12） */
  month: number;
  /** 横軸の見出し（`periodMonthsOf` と同じ） */
  label: string;
  net: number;
  balance: number;
};

export type CumulativeBalanceTrend = {
  openingBalance: number;
  annualIncome: number;
  annualExpense: number;
  closingBalance: number;
  monthly: CumulativeBalanceTrendPoint[];
};

/** 期首（期間の始まりより前の累計）と、期間の月ごとの累積収支。期間の後の取引は数えない。 */
export function buildCumulativeBalanceTrend(
  entries: FinanceEntry[],
  period: PeriodBounds,
): CumulativeBalanceTrend {
  const months = periodMonthsOf(period);
  const monthlyNet = Array<number>(months.length).fill(0);
  let openingBalance = 0;
  let annualIncome = 0;
  let annualExpense = 0;

  for (const entry of entries) {
    const signed = entry.entryType === 'income' ? entry.amount : -entry.amount;
    if (entry.date < period.startsOn) {
      openingBalance += signed;
      continue;
    }
    const index = periodMonthIndexOf(months, entry.date);
    if (index < 0) continue;
    monthlyNet[index] += signed;
    if (entry.entryType === 'income') annualIncome += entry.amount;
    else annualExpense += entry.amount;
  }

  let balance = openingBalance;
  const monthly = monthlyNet.map((net, index) => {
    balance += net;
    const { key, month, label } = months[index];
    return { key, month, label, net, balance };
  });
  return { openingBalance, annualIncome, annualExpense, closingBalance: balance, monthly };
}
