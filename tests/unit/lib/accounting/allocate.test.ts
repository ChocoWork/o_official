import { AccountingAllocateError, allocateByWeight } from '@/lib/accounting/allocate';

/** SQL の private.accounting_allocate_amount と同じ15本の固定のベクトル（DB 側の試験にも同じ表がある）。 */
const VECTORS: ReadonlyArray<{ total: number; weights: number[]; expected: number[] }> = [
	{ total: 10, weights: [1, 1, 1], expected: [4, 3, 3] },
	{ total: 0, weights: [1, 1, 1], expected: [0, 0, 0] },
	{ total: 0, weights: [0, 0], expected: [0, 0] },
	{ total: 5, weights: [2, 0, 1], expected: [4, 0, 1] },
	{ total: 1, weights: [1, 1, 1], expected: [1, 0, 0] },
	{ total: 2, weights: [1, 1, 1], expected: [1, 1, 0] },
	{ total: 100, weights: [3], expected: [100] },
	{ total: 100, weights: [0, 5], expected: [0, 100] },
	{ total: 7, weights: [0, 1, 1], expected: [0, 4, 3] },
	{ total: 1000, weights: [1, 2, 3, 4], expected: [100, 200, 300, 400] },
	{ total: 999, weights: [1, 2, 3, 4], expected: [100, 200, 300, 399] },
	{ total: 18750, weights: [6250, 6250, 6250], expected: [6250, 6250, 6250] },
	{ total: 10250, weights: [5000, 5250], expected: [5000, 5250] },
	{ total: 3, weights: [5000, 0, 5000, 0, 5000], expected: [1, 0, 1, 0, 1] },
	{ total: 9007199254740991, weights: [1, 1], expected: [4503599627370496, 4503599627370495] },
];

describe('FREQ-563-AC-03: TSの割り振りは端数を番号の若い順に1円ずつ足し合計が元の額に合う', () => {
	it.each(VECTORS.map((vector, index) => [index + 1, vector] as const))('ベクトル%i は決めた値になる', (_n, vector) => {
		expect(allocateByWeight(vector.total, vector.weights)).toEqual(vector.expected);
	});

	it('10円を[1,1,1]に割ると[4,3,3]、重み0の要素は0のまま', () => {
		expect(allocateByWeight(10, [1, 1, 1])).toEqual([4, 3, 3]);
		expect(allocateByWeight(5, [2, 0, 1])).toEqual([4, 0, 1]);
	});

	it('重みの合計が0で額が正なら拒む。額が0なら全部0', () => {
		expect(() => allocateByWeight(1, [0, 0])).toThrow(AccountingAllocateError);
		expect(allocateByWeight(0, [0, 0])).toEqual([0, 0]);
	});

	it('負の額・負の重み・小数・空の重みで額が正なら拒む', () => {
		expect(() => allocateByWeight(-1, [1])).toThrow(AccountingAllocateError);
		expect(() => allocateByWeight(1, [1, -1])).toThrow(AccountingAllocateError);
		expect(() => allocateByWeight(1.5, [1])).toThrow(AccountingAllocateError);
		expect(() => allocateByWeight(1, [0.5, 1])).toThrow(AccountingAllocateError);
		expect(() => allocateByWeight(1, [])).toThrow(AccountingAllocateError);
		expect(allocateByWeight(0, [])).toEqual([]);
	});
});

describe('FREQ-563-AC-03: TSの割り振りは合計を保つ', () => {
	it('ランダム100本で合計が元の額に一致し、全部が0以上で、重み0の要素は0', () => {
		// 試験を毎回同じにするため、種を固定した Park-Miller 法を使う（積が 2^53 を超えない）。
		let state = 20261108;
		const next = (limit: number) => {
			state = (state * 48271) % 2147483647;
			return state % limit;
		};
		for (let round = 0; round < 100; round += 1) {
			const length = 1 + next(8);
			const weights: number[] = Array.from({ length }, () => (next(4) === 0 ? 0 : next(100000)));
			if (!weights.some((weight) => weight > 0)) weights[0] = 1;
			const total = next(10_000_000);
			const result = allocateByWeight(total, weights);
			expect(result).toHaveLength(length);
			expect(result.reduce((sum, value) => sum + value, 0)).toBe(total);
			result.forEach((value, index) => {
				expect(value).toBeGreaterThanOrEqual(0);
				expect(Number.isInteger(value)).toBe(true);
				if (weights[index] === 0) expect(value).toBe(0);
			});
		}
	});
});
