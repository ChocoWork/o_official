import {
	MAX_TAX_REFUND_MONTHS,
	arrivedOnSchema,
	correctArrivalBodySchema,
	parseRefundStatesQuery,
	parseReturnArrivalQuery,
	parseTaxRefundsQuery,
	refundBankTransferBodySchema,
	refundCancellationBodySchema,
	refundSettlementBodySchema,
	returnOptionBodySchema,
} from '@/lib/accounting/return-refund-schema';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const KEY = uuid(91);
const q = (query: string): URLSearchParams => new URLSearchParams(query);

describe('FREQ-575-AC-01: 届いた日の入力', () => {
	test('受け取りの届いた日は暦にある YYYY-MM-DD だけ', () => {
		expect(arrivedOnSchema.safeParse('2026-11-14').success).toBe(true);
		for (const bad of ['2026-02-30', '2026/11/14', '20261114', '', '2026-11-14T00:00:00Z', 5]) {
			expect([bad, arrivedOnSchema.safeParse(bad).success]).toEqual([bad, false]);
		}
	});

	test('届いた日の直しの本文は理由が空・501字・版が負・知らない鍵のどれでも断る', () => {
		const ok = { receiptId: uuid(1), newOn: '2026-11-10', reason: '到着の記録を見直した', expectedVersion: 0, requestKey: KEY };
		expect(correctArrivalBodySchema.safeParse(ok).success).toBe(true);
		expect(correctArrivalBodySchema.parse({ ...ok, reason: '  前後の空白  ' }).reason).toBe('前後の空白');
		for (const bad of [
			{ ...ok, reason: '   ' },
			{ ...ok, reason: 'あ'.repeat(501) },
			{ ...ok, expectedVersion: -1 },
			{ ...ok, expectedVersion: 1.5 },
			{ ...ok, newOn: '2026-13-01' },
			{ ...ok, receiptId: 'x' },
			{ ...ok, actorId: uuid(2) },
		]) {
			expect(correctArrivalBodySchema.safeParse(bad).success).toBe(false);
		}
		expect(correctArrivalBodySchema.safeParse({ ...ok, reason: 'あ'.repeat(500) }).success).toBe(true);
	});

	test('受け取りの番号の問い合わせは1〜200件・重複なし・知らない鍵なし', () => {
		expect(parseReturnArrivalQuery(q(`receiptIds=${uuid(1)},${uuid(2)}`))).toEqual([uuid(1), uuid(2)]);
		const many = Array.from({ length: 200 }, (_, i) => uuid(i + 1)).join(',');
		expect(parseReturnArrivalQuery(q(`receiptIds=${many}`))).toHaveLength(200);
		for (const bad of [
			'',
			'receiptIds=',
			`receiptIds=${many},${uuid(999)}`,
			`receiptIds=${uuid(1)},${uuid(1)}`,
			`receiptIds=${uuid(1)},x`,
			`receiptIds=${uuid(1)},`,
			`receiptIds=${uuid(1)}&receiptIds=${uuid(2)}`,
			`receiptIds=${uuid(1)}&x=1`,
		]) {
			expect([bad, parseReturnArrivalQuery(q(bad))]).toEqual([bad, null]);
		}
	});
});

describe('FREQ-575-AC-04: 設定の入力', () => {
	test('設定は版（1以上の10進文字列）が要り、真偽以外・知らない鍵は断る', () => {
		expect(returnOptionBodySchema.safeParse({ enabled: true, expectedVersion: '1', requestKey: KEY }).success).toBe(true);
		for (const bad of [
			{ enabled: 'true', expectedVersion: '1', requestKey: KEY },
			{ enabled: true, expectedVersion: '0', requestKey: KEY },
			{ enabled: true, expectedVersion: 1, requestKey: KEY },
			{ enabled: true, expectedVersion: '1', requestKey: 'x' },
			{ enabled: true, expectedVersion: '1', requestKey: KEY, actorId: uuid(1) },
		]) {
			expect(returnOptionBodySchema.safeParse(bad).success).toBe(false);
		}
	});
});

describe('FREQ-579-AC-03: 取り消しの区分の入力', () => {
	test('区分は abandoned か owed、理由は空でも501字でもない', () => {
		const ok = { refundId: uuid(3), kind: 'owed', reason: '返す', requestKey: KEY };
		expect(refundCancellationBodySchema.safeParse(ok).success).toBe(true);
		expect(refundCancellationBodySchema.safeParse({ ...ok, kind: 'abandoned' }).success).toBe(true);
		for (const bad of [
			{ ...ok, kind: 'settled' },
			{ ...ok, reason: ' ' },
			{ ...ok, reason: 'a'.repeat(501) },
			{ ...ok, refundId: 'x' },
			{ ...ok, extra: 1 },
		]) {
			expect(refundCancellationBodySchema.safeParse(bad).success).toBe(false);
		}
	});

	test('取り消しの区分の状態の一覧の問い合わせは続きの目印が対でなければ断る', () => {
		expect(parseRefundStatesQuery(q(''))).toEqual({ limit: 50 });
		expect(parseRefundStatesQuery(q(`limit=100&afterAt=2026-11-14T00:00:00Z&afterId=${uuid(1)}`))).toEqual({
			limit: 100,
			afterAt: '2026-11-14T00:00:00Z',
			afterId: uuid(1),
		});
		for (const bad of ['limit=101', 'limit=0', 'afterAt=2026-11-14T00:00:00Z', `afterId=${uuid(1)}`, 'afterAt=x&afterId=y', 'x=1']) {
			expect([bad, parseRefundStatesQuery(q(bad))]).toEqual([bad, null]);
		}
	});
});

describe('FREQ-579-AC-04: 振込の記録の入力', () => {
	const today = '2026-11-14';
	const schema = refundBankTransferBodySchema(today);
	const ok = { orderId: uuid(4), origin: 'pre_shipment', amount: 1000, bankDate: today, bankTxnNo: 'BANK-1', note: 'メモ', requestKey: KEY };

	test('未来の日・額0・負の額・長すぎるメモ・取引の番号の形の誤りを断る', () => {
		expect(schema.safeParse(ok).success).toBe(true);
		expect(schema.safeParse({ ...ok, bankDate: '2026-11-13' }).success).toBe(true);
		for (const bad of [
			{ ...ok, bankDate: '2026-11-15' },
			{ ...ok, amount: 0 },
			{ ...ok, amount: -1 },
			{ ...ok, amount: 1.5 },
			{ ...ok, note: 'あ'.repeat(501) },
			{ ...ok, bankTxnNo: 'a b' },
			{ ...ok, bankTxnNo: 'a'.repeat(101) },
			{ ...ok, bankTxnNo: '' },
			{ ...ok, origin: 'other' },
			{ ...ok, bankDate: '2026-02-30' },
			{ ...ok, extra: 1 },
		]) {
			expect(schema.safeParse(bad).success).toBe(false);
		}
		expect(schema.safeParse({ ...ok, note: 'あ'.repeat(500) }).success).toBe(true);
		expect(schema.safeParse({ ...ok, bankTxnNo: 'a'.repeat(100) }).success).toBe(true);
	});

	test('空のメモは null にし、前後の空白を落とす', () => {
		expect(schema.parse({ ...ok, note: '   ' }).note).toBeNull();
		expect(schema.parse({ ...ok, note: null }).note).toBeNull();
		expect(schema.parse({ ...ok, note: ' 振込 ' }).note).toBe('振込');
		expect(schema.parse({ ...ok, bankTxnNo: ' BANK-1 ' }).bankTxnNo).toBe('BANK-1');
	});
});

describe('FREQ-579-AC-05: 結びの入力', () => {
	test('同じ返金どうしは結べず、番号の形の誤りと知らない鍵を断る', () => {
		const ok = { owedRefundId: uuid(5), payingRefundId: uuid(6), requestKey: KEY };
		expect(refundSettlementBodySchema.safeParse(ok).success).toBe(true);
		for (const bad of [
			{ ...ok, payingRefundId: uuid(5) },
			{ ...ok, owedRefundId: 'abcdef01-0000-4000-8000-000000000005', payingRefundId: 'ABCDEF01-0000-4000-8000-000000000005' },
			{ ...ok, owedRefundId: 'x' },
			{ ...ok, amount: 1 },
		]) {
			expect(refundSettlementBodySchema.safeParse(bad).success).toBe(false);
		}
	});
});

describe('FREQ-583-AC-01: 消費税用の一覧の問い合わせ', () => {
	test('月の範囲を月の初日と末日にし、既定の件数を100にする', () => {
		expect(parseTaxRefundsQuery(q('from=2026-02&to=2026-02'))).toEqual({ from: '2026-02-01', to: '2026-02-28', limit: 100 });
		expect(parseTaxRefundsQuery(q('from=2028-02&to=2028-03&limit=200'))).toEqual({ from: '2028-02-01', to: '2028-03-31', limit: 200 });
	});

	test(`期間が逆・${MAX_TAX_REFUND_MONTHS}か月を超える・月の形の誤り・件数の誤り・知らない鍵・重ねた鍵を断る`, () => {
		expect(parseTaxRefundsQuery(q('from=2026-01&to=2026-12'))).not.toBeNull();
		for (const bad of [
			'',
			'from=2026-03&to=2026-02',
			'from=2026-01&to=2027-01',
			'from=2026-1&to=2026-02',
			'from=2026-01-01&to=2026-02-01',
			'from=2026-13&to=2026-14',
			'from=2026-01&to=2026-02&limit=201',
			'from=2026-01&to=2026-02&limit=0',
			'from=2026-01&to=2026-02&x=1',
			'from=2026-01&from=2026-02&to=2026-03',
		]) {
			expect([bad, parseTaxRefundsQuery(q(bad))]).toEqual([bad, null]);
		}
	});

	test('FREQ-583-AC-03: 続きの目印は日と行の印が対で、行の印の形が不正なら断る', () => {
		const key = `${uuid(7)}:2`;
		expect(parseTaxRefundsQuery(q(`from=2026-01&to=2026-02&afterDate=2026-01-15&afterKey=${key}`))).toEqual({
			from: '2026-01-01',
			to: '2026-02-28',
			limit: 100,
			afterDate: '2026-01-15',
			afterKey: key,
		});
		for (const bad of [
			'afterDate=2026-01-15',
			`afterKey=${key}`,
			`afterDate=2026-01-15&afterKey=${uuid(7)}`,
			`afterDate=2026-01-15&afterKey=${uuid(7)}:0`,
			'afterDate=2026-01-15&afterKey=ABCDEF01-0000-4000-8000-000000000007:2',
			`afterDate=2026-01-15&afterKey=${key};drop`,
			`afterDate=2026-02-30&afterKey=${key}`,
			`afterDate=x&afterKey=${key}`,
		]) {
			expect([bad, parseTaxRefundsQuery(q(`from=2026-01&to=2026-02&${bad}`))]).toEqual([bad, null]);
		}
	});
});
