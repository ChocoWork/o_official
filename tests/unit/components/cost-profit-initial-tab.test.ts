import { initialCostProfitTab } from '@/components/cost-profit/constants';

describe('会計画面の最初のサブタブ', () => {
  it('FREQ-572-AC-05: KPI 画面の案内（accountingTab=reconciliation）は照合のサブタブを最初に開く', () => {
    expect(initialCostProfitTab('reconciliation')).toBe('reconciliation');
    expect(initialCostProfitTab('pending')).toBe('pending');
  });

  it('FREQ-572-AC-05: 指定が無い・知らない値は財務概要を開く', () => {
    expect(initialCostProfitTab(null)).toBe('summary');
    expect(initialCostProfitTab(undefined)).toBe('summary');
    expect(initialCostProfitTab('unknown')).toBe('summary');
    expect(initialCostProfitTab('')).toBe('summary');
  });
});
