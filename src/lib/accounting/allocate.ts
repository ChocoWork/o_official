// 額を重みの比で割り振る（設計 2-h・4-e2・5-g の端数の決め方）。
// SQL の private.accounting_allocate_amount(_total, _weights) と同じ値を返す。
// 各要素に floor(total × 重み ÷ 重みの合計) を割り、余りを重み0でない要素の番号の若い順に1円ずつ足す。

export class AccountingAllocateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AccountingAllocateError';
	}
}

function assertNonNegativeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new AccountingAllocateError(`${label} must be a non-negative safe integer`);
	}
}

export function allocateByWeight(total: number, weights: readonly number[]): number[] {
	assertNonNegativeInteger(total, 'total');
	weights.forEach((weight) => assertNonNegativeInteger(weight, 'weight'));
	// 積が 2^53 を超えても丸めないため BigInt で数える。
	const zero = BigInt(0);
	const one = BigInt(1);
	const sum = weights.reduce((acc, weight) => acc + BigInt(weight), zero);
	if (sum === zero) {
		if (total > 0) throw new AccountingAllocateError('weights sum to zero');
		return weights.map(() => 0);
	}
	const shares = weights.map((weight) => (BigInt(total) * BigInt(weight)) / sum);
	let remainder = BigInt(total) - shares.reduce((acc, share) => acc + share, zero);
	return shares.map((share, index) => {
		if (remainder > zero && weights[index] > 0) {
			remainder -= one;
			return Number(share + one);
		}
		return Number(share);
	});
}
