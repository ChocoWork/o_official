import { calculateSalesFunnel } from '@/components/KpiSalesFunnel';

describe('calculateSalesFunnel', () => {
	it('販売数から各段階の必要人数を逆算する', () => {
		const stages = calculateSalesFunnel(100, 1.25, [10, 50, 50, 4]);

		expect(stages[4].required).toBe(80);
		expect(stages[3].required).toBe(2000);
		expect(stages[2].required).toBe(4000);
		expect(stages[1].required).toBe(8000);
		expect(stages[0].required).toBe(80000);
	});

	it('ゼロ以下の入力でも安全な最小値を使う', () => {
		const stages = calculateSalesFunnel(0, 0, [0, 0, 0, 0]);

		expect(stages[4].required).toBe(1);
		expect(stages.every((stage) => stage.required >= 1)).toBe(true);
	});
});
