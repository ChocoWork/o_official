import type { FinanceEntry } from '@/lib/finance/journal';

export type CumulativeBalanceTrendPoint = {
  month: number;
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

export function buildCumulativeBalanceTrend(
  entries: FinanceEntry[],
  fiscalYear: number,
): CumulativeBalanceTrend {
  const yearStart = `${fiscalYear}-01-01`;
  const yearEnd = `${fiscalYear}-12-31`;
  const monthlyNet = Array<number>(12).fill(0);
  let openingBalance = 0;
  let annualIncome = 0;
  let annualExpense = 0;

  for (const entry of entries) {
    const signed = entry.entryType === 'income' ? entry.amount : -entry.amount;
    if (entry.date < yearStart) {
      openingBalance += signed;
      continue;
    }
    if (entry.date > yearEnd) continue;
    const month = Number.parseInt(entry.date.slice(5, 7), 10);
    if (!Number.isInteger(month) || month < 1 || month > 12) continue;
    monthlyNet[month - 1] += signed;
    if (entry.entryType === 'income') annualIncome += entry.amount;
    else annualExpense += entry.amount;
  }

  let balance = openingBalance;
  const monthly = monthlyNet.map((net, index) => {
    balance += net;
    return { month: index + 1, net, balance };
  });
  return { openingBalance, annualIncome, annualExpense, closingBalance: balance, monthly };
}
