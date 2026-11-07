import { buildCumulativeBalanceTrend } from '@/lib/finance/cumulative-balance-trend';
import type { FinanceEntry } from '@/lib/finance/journal';

const entry = (
  id: number,
  entryType: FinanceEntry['entryType'],
  date: string,
  amount: number,
  category: string,
  paymentMethod: string,
): FinanceEntry => ({
  id, entryType, date, amount, category, paymentMethod,
  item: `entry-${id}`, partner: '', memo: '',
});

it('uses the prior-year closing balance as opening balance and returns all 12 monthly points', () => {
  const result = buildCumulativeBalanceTrend([
    entry(1, 'income', '2025-12-20', 100_000, 'sales', 'bank'),
    entry(2, 'expense', '2025-12-25', 30_000, 'expense', 'credit-card'),
    entry(3, 'income', '2026-01-10', 20_000, 'sales', 'cash'),
    entry(4, 'expense', '2026-03-15', 5_000, 'expense', 'private'),
    entry(5, 'income', '2027-01-01', 999_999, 'sales', 'bank'),
  ], { startsOn: '2026-01-01', endsOn: '2026-12-31' });

  expect(result.openingBalance).toBe(70_000);
  expect(result.annualIncome).toBe(20_000);
  expect(result.annualExpense).toBe(5_000);
  expect(result.closingBalance).toBe(85_000);
  expect(result.monthly).toHaveLength(12);
  expect(result.monthly[0]).toEqual({ key: '2026-01', month: 1, label: '1月', net: 20_000, balance: 90_000 });
  expect(result.monthly[1]).toEqual({ key: '2026-02', month: 2, label: '2月', net: 0, balance: 90_000 });
  expect(result.monthly[2]).toEqual({ key: '2026-03', month: 3, label: '3月', net: -5_000, balance: 85_000 });
  expect(result.monthly[11].balance).toBe(85_000);
});

it('keeps a negative balance when there is no prior-year income', () => {
  const result = buildCumulativeBalanceTrend([
    entry(1, 'expense', '2026-02-01', 8_000, 'expense', 'cash'),
  ], { startsOn: '2026-01-01', endsOn: '2026-12-31' });

  expect(result.openingBalance).toBe(0);
  expect(result.monthly[0].balance).toBe(0);
  expect(result.monthly[1].balance).toBe(-8_000);
});
