import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PendingView } from '@/components/cost-profit/pending-view';
import { PENDING_REASONS } from '@/lib/accounting/posting-types';
import { ALL_FLAGS, BASE, envelope, pendingEvent, pendingPage, uuid, type Flags } from './accounting-fixtures';
import { mockFetch, solePeriod } from './settings-fixtures';

// 計上待ちのタブ（FREQ-569）。route の答えは Task 10 の形（計上待ちは camelCase、前受金は snake_case）。

type Serve = {
	events?: ReturnType<typeof pendingEvent>[];
	flags?: Flags;
	run?: Record<string, unknown>;
	resolve?: { status: number; body: unknown };
	deferred?: unknown;
	periods?: unknown[];
	pendingStatus?: number;
};

const EMPTY_DEFERRED = { orders: [], next_after_order: null, total_balance: 0, anomalies: [] };

function serve(state: Serve = {}) {
	let events = state.events ?? [];
	const flags = state.flags ?? ALL_FLAGS;
	const api = mockFetch((url, method) => {
		if (url.pathname === `${BASE}/pending-events` && method === 'GET') {
			if (state.pendingStatus) return { status: state.pendingStatus, body: { error: '会計の処理に失敗しました。' } };
			return { status: 200, body: envelope(pendingPage(events), flags) };
		}
		if (url.pathname === `${BASE}/posting/run` && method === 'POST') {
			// 再計上で保留が消える。
			events = [];
			return { status: 200, body: { data: { result: state.run ?? { payments: 0, shipments: 0, stripe: 0, disputes: 0, parked: 0, resolved: 0, hasMore: false } } } };
		}
		if (/\/pending-events\/[^/]+\/resolve$/.test(url.pathname) && method === 'POST') {
			const reply = state.resolve ?? { status: 200, body: { data: { event: {} } } };
			if (reply.status === 200) events = events.filter((event) => !url.pathname.includes(event.id));
			return reply;
		}
		if (url.pathname === `${BASE}/deferred-revenue`) return { status: 200, body: envelope(state.deferred ?? EMPTY_DEFERRED, flags) };
		if (url.pathname === `${BASE}/periods`) {
			return { status: 200, body: { data: { periods: state.periods ?? [], settings: {}, deadlines: {}, interim: {}, startup: [] }, permissions: { manageSettings: false } } };
		}
		return undefined;
	});
	return api;
}

/** 理由ごとに、画面の文が含む決めた言い回し。 */
const REASON_SNIPPETS: Record<(typeof PENDING_REASONS)[number], string> = {
	payment_journal_missing: '支払いが、まだ帳簿に入っていません',
	order_not_postable: '送料や合計が決まりの形と合わない',
	amount_mismatch: '取引の総額が、注文の支払額と違います',
	no_order: '注文と結び付かない支払い',
	units_insufficient: '送る着の数が、まだ送っていない着の数より多く',
	shipment_date_mismatch: '出荷日と発送票の出荷日が食い違っています',
	deferred_revenue_short: '前受金の残りより多くなっています',
	period_missing: 'この日を含む会計の期間がありません',
	posting_error: '帳簿に入れる処理で失敗しました',
	before_cutover: '新しい帳簿を始めた日より前の出来事です',
	unknown_category: 'まだ知らない種類',
	payout_mismatch: '入金の中身の合計と額が合っていません',
	dispute_refund_overlap: '成功した返金があります',
	dispute_return_refund_pending: '返品の返金待ちがあります',
	dispute_withdrawal_missing: '決着していません',
	dispute_shipment_pending: '出荷の仕訳がまだ入っていない物',
	shipment_lines_mismatch: '品ごとの数量が食い違っています',
	no_revenue: '仕訳にする額が0円です',
};

const pendingRegion = () => screen.getByRole('region', { name: '計上待ち' });
const resolveCalls = (api: ReturnType<typeof serve>) => api.calls.filter((call) => call.url.endsWith('/resolve'));

describe('計上待ちのタブ', () => {
	jest.setTimeout(30000);

	it('FREQ-569-AC-01: 計上待ちのタブは理由をやさしい文で出し、名前やメールを出さない', async () => {
		serve({
			events: [
				pendingEvent(1, { reason: 'payment_journal_missing' }),
				pendingEvent(2, { reason: 'order_not_postable', detail: { reason: 'shipping' } }),
				pendingEvent(3, { reason: 'before_cutover', detail: {} }),
			],
		});
		render(<PendingView />);

		const region = await screen.findByRole('region', { name: '計上待ち' });
		expect(await within(region).findByText('未解決 3件')).toBeInTheDocument();
		expect(within(region).getByText('この出荷の注文の支払いが、まだ帳簿に入っていません。支払いが入ると自動で計上されます。')).toBeInTheDocument();
		expect(within(region).getByText('この注文は送料や合計が決まりの形と合わないため、自動で計上できません。内容を確かめてください。')).toBeInTheDocument();
		expect(within(region).getByText('新しい帳簿を始めた日より前の出来事です。確かめて、確認済みにしてください。')).toBeInTheDocument();
		// 名前・メール・住所・敬称は出さない。
		expect(region.textContent).not.toMatch(/@|様|メールアドレス|住所/);
		expect(region.textContent).not.toMatch(/[!！]/);
	});

	it('FREQ-569-AC-01: 理由の一覧は計上待ちの理由の全部を覆う（試験の表と型の一覧が食い違えば落ちる）', () => {
		expect(Object.keys(REASON_SNIPPETS).sort()).toEqual([...PENDING_REASONS].sort());
	});

	it.each(PENDING_REASONS)('FREQ-569-AC-01: 理由 %s は決めた文を出し、固定のコードをそのまま出さない', async (reason) => {
		serve({
			events: [pendingEvent(1, {
				reason,
				detail: reason === 'period_missing' ? { entry_date: '2026-11-08' } : reason === 'dispute_withdrawal_missing' ? { dispute_status: 'under_review' } : {},
			})],
		});
		render(<PendingView />);
		const region = await screen.findByRole('region', { name: '計上待ち' });
		const text = (await within(region).findByTestId('pending-reason')).textContent ?? '';
		expect(text).toContain(REASON_SNIPPETS[reason]);
		expect(region.textContent).not.toContain(reason);
		expect(region.textContent).not.toMatch(/[!！]/);
	});

	it('FREQ-569-AC-01: dispute_withdrawal_missing は待つ相手ごとに3つの文を出す（決着を待つのは dispute_status がある時だけ）', async () => {
		const dispute = { reason: 'dispute_withdrawal_missing' as const, eventKind: 'dispute_event' as const };
		serve({
			events: [
				pendingEvent(1, { ...dispute, detail: { waiting_on: 'dispute_account_unassigned' } }),
				pendingEvent(2, { ...dispute, detail: { dispute_status: 'under_review' } }),
				// waiting_on も dispute_status も無い行は、前の段の仕訳（引かれた時・確定）を待っている。
				pendingEvent(3, { ...dispute, detail: {} }),
				pendingEvent(4, { ...dispute, detail: { waiting_on: 'dispute_withdrawn' } }),
			],
		});
		render(<PendingView />);
		const region = await screen.findByRole('region', { name: '計上待ち' });
		const reasons = await within(region).findAllByTestId('pending-reason');
		const texts = reasons.map((node) => node.textContent);
		expect(new Set(texts).size).toBe(3);
		expect(texts[0]).toMatch(/振り替え先の科目/);
		expect(texts[1]).toMatch(/決着していません/);
		expect(texts[2]).toMatch(/前の段の仕訳/);
		expect(texts[2]).not.toMatch(/決着/);
		expect(texts[3]).toBe(texts[2]);
		expect(region.textContent).not.toMatch(/チャージバック/);
	});

	it('FREQ-569-AC-01: やめた日より後で止まった行は、日を確かめてから法人へ切り替える順の案内が出る', async () => {
		serve({
			events: [
				pendingEvent(1, { reason: 'period_missing', detail: { entry_date: '2027-01-05', cause: 'sole_ended_not_switched' } }),
				pendingEvent(2, { reason: 'period_missing', detail: { entry_date: '2027-01-06' } }),
			],
		});
		render(<PendingView />);
		const reasons = await screen.findAllByTestId('pending-reason');
		expect(reasons[0]).toHaveTextContent('やめた日が正しいか確かめ、正しければ事業の形を法人へ切り替えてください');
		expect(reasons[0]).toHaveTextContent('設定・期間');
		expect(reasons[1]).toHaveTextContent('この日を含む会計の期間がありません');
		expect(reasons[1]).not.toHaveTextContent('法人へ切り替え');
	});

	it('FREQ-569-AC-01: 注文の無いStripeの支払いは確かめる案内が出て、閉じるボタンは出ない', async () => {
		serve({
			events: [pendingEvent(1, { reason: 'no_order', eventKind: 'payment_confirmed', sourceTable: 'stripe_balance_transactions', sourceId: 'txn_1', orderId: null })],
		});
		render(<PendingView />);
		const reason = await screen.findByTestId('pending-reason');
		expect(reason).toHaveTextContent('Stripe に、注文と結び付かない支払いが届いています');
		expect(reason).toHaveTextContent('確かめてください');
		expect(screen.queryByRole('button', { name: '確認済みにする' })).not.toBeInTheDocument();
		expect(within(pendingRegion()).getByText('仕訳が入るまで閉じられません')).toBeInTheDocument();
	});

	it('FREQ-569-AC-01: 取り消しの出来事に注文が無い時は、支払いの文ではなく取り消しの文を出す', async () => {
		serve({ events: [pendingEvent(1, { reason: 'no_order', eventKind: 'dispute_event', sourceTable: 'stripe_disputes', sourceId: 'dp_1', orderId: null })] });
		render(<PendingView />);
		const reason = await screen.findByTestId('pending-reason');
		expect(reason).toHaveTextContent('カード会社からの支払いの取り消しに、結び付く注文が見つかりません');
		expect(reason).not.toHaveTextContent('支払いが届いています');
	});

	it('FREQ-569-AC-02: 一覧が空なら「計上待ちはありません」と出る', async () => {
		serve({ events: [] });
		render(<PendingView />);
		expect(await screen.findByText('計上待ちはありません')).toBeInTheDocument();
		expect(screen.getByText('未解決 0件')).toBeInTheDocument();
	});

	it('FREQ-569-AC-03: 確認済みにするボタンは権限のある人だけに出て、メモが空なら送れない', async () => {
		const api = serve({
			events: [
				pendingEvent(1, { reason: 'before_cutover', detail: {} }),
				pendingEvent(2, { reason: 'payment_journal_missing' }),
				pendingEvent(3, { reason: 'no_revenue', detail: {} }),
			],
		});
		render(<PendingView />);
		const region = await screen.findByRole('region', { name: '計上待ち' });
		await within(region).findByText('未解決 3件');
		// 切り替えより前と額0の2行だけに出る。お金の動く行は閉じられない。
		expect(within(region).getAllByRole('button', { name: '確認済みにする' })).toHaveLength(2);
		const money = within(region).getAllByRole('listitem')[1];
		expect(within(money).queryByRole('button', { name: '確認済みにする' })).not.toBeInTheDocument();
		expect(within(money).getByText('仕訳が入るまで閉じられません')).toBeInTheDocument();

		fireEvent.click(within(region).getAllByRole('button', { name: '確認済みにする' })[0]);
		const memo = await within(region).findByLabelText('メモ（必須）');
		const send = within(region).getByRole('button', { name: '確認済みにして送る' });
		expect(send).toBeDisabled();
		fireEvent.change(memo, { target: { value: '   ' } });
		expect(send).toBeDisabled();
		fireEvent.change(memo, { target: { value: '切り替え前の試しの出荷。確かめた' } });
		expect(send).toBeEnabled();
		fireEvent.click(send);
		await waitFor(() => expect(resolveCalls(api)).toHaveLength(1));
		expect(resolveCalls(api)[0].url).toBe(`${BASE}/pending-events/${uuid(201)}/resolve`);
		expect(resolveCalls(api)[0].body).toEqual({ note: '切り替え前の試しの出荷。確かめた', requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
		// 解決したら読み直し、その行は消える。
		await waitFor(() => expect(within(region).getAllByRole('button', { name: '確認済みにする' })).toHaveLength(1));
	});

	it('FREQ-569-AC-03: 確認済みにする権限が無い人には、ボタンもメモ欄も出ない', async () => {
		serve({ events: [pendingEvent(1, { reason: 'before_cutover', detail: {} })], flags: { manageSettings: false, manageFinance: true } });
		render(<PendingView />);
		await screen.findByTestId('pending-reason');
		expect(screen.queryByRole('button', { name: '確認済みにする' })).not.toBeInTheDocument();
		expect(screen.queryByLabelText('メモ（必須）')).not.toBeInTheDocument();
	});

	it('FREQ-569-AC-03: すでに解決済みの409は穏やかな文で知らせ、非okの本文を読み切って読み直す', async () => {
		const api = serve({
			events: [pendingEvent(1, { reason: 'before_cutover', detail: {} })],
			resolve: { status: 409, body: { code: 'ACCOUNTING_PENDING_RESOLVED', error: 'この計上待ちは既に解決されています。' } },
		});
		render(<PendingView />);
		fireEvent.click(await screen.findByRole('button', { name: '確認済みにする' }));
		fireEvent.change(await screen.findByLabelText('メモ（必須）'), { target: { value: '確かめた' } });
		fireEvent.click(screen.getByRole('button', { name: '確認済みにして送る' }));
		expect(await screen.findByText('この計上待ちは既に解決されています。')).toBeInTheDocument();
		expect(resolveCalls(api)[0].response.bodyUsed).toBe(true);
		// 最初の読みの後に、もう1回読み直している。
		await waitFor(() => expect(api.calls.filter((call) => call.url === `${BASE}/pending-events` && call.method === 'GET')).toHaveLength(2));
	});

	it('FREQ-569-AC-03: もう一度計上するは押すと二重に押せず、結果の件数を出す', async () => {
		const api = serve({
			events: [pendingEvent(1)],
			run: { payments: 1, shipments: 2, stripe: 0, disputes: 0, parked: 1, resolved: 3, hasMore: true },
		});
		render(<PendingView />);
		const button = await screen.findByRole('button', { name: 'もう一度計上する' });
		fireEvent.click(button);
		fireEvent.click(button);
		fireEvent.click(button);
		const status = await screen.findByText(/3件を計上しました/);
		expect(api.calls.filter((call) => call.url === `${BASE}/posting/run`)).toHaveLength(1);
		expect(status).toHaveTextContent('支払い1件・出荷2件');
		expect(status).toHaveTextContent('新しく止めた1件');
		expect(status).toHaveTextContent('解決した3件');
		expect(screen.getByText('まだ残りがあります。もう一度押してください。')).toBeInTheDocument();
		// 計上の後は一覧を読み直す。
		expect(await screen.findByText('計上待ちはありません')).toBeInTheDocument();
	});

	it('FREQ-569-AC-03: 計上の権限が無ければもう一度計上するは出ない', async () => {
		serve({ events: [pendingEvent(1)], flags: { manageSettings: false, correctEntries: true } });
		render(<PendingView />);
		await screen.findByTestId('pending-reason');
		expect(screen.queryByRole('button', { name: 'もう一度計上する' })).not.toBeInTheDocument();
	});

	it('FREQ-569-AC-03: 非okの応答の本文を読み切り、固定の文を出す', async () => {
		const api = serve({ pendingStatus: 500 });
		render(<PendingView />);
		expect(await screen.findByText('会計の処理に失敗しました。')).toBeInTheDocument();
		const read = api.calls.find((call) => call.url === `${BASE}/pending-events`);
		expect(read?.response.bodyUsed).toBe(true);
		expect(screen.getByRole('button', { name: 'もう一度読み込む' })).toBeInTheDocument();
	});

	it('FREQ-569-AC-06: posting_errorの行に理由と元の記録を直して再計上する案内が出て確認済みにはできない', async () => {
		serve({
			events: [
				pendingEvent(1, {
					reason: 'posting_error',
					detail: { error_sqlstate: '23514', error_code: 'ACCOUNTING_ENTRY_UNBALANCED', entry_date: '2026-11-03' },
				}),
			],
		});
		render(<PendingView />);
		const region = await screen.findByRole('region', { name: '計上待ち' });
		const reason = await within(region).findByTestId('pending-reason');
		expect(reason).toHaveTextContent('この出来事を帳簿に入れる処理で失敗しました。元の記録や設定を確かめ、直してから『もう一度計上する』を押してください。他の出来事の計上は続けています');
		// 理由の固定コードと対象の出来事の日。生の例外の文は出さない。
		expect(region).toHaveTextContent('ACCOUNTING_ENTRY_UNBALANCED');
		expect(region).toHaveTextContent('23514');
		expect(region).toHaveTextContent('2026/11/03');
		// 元の記録を開く既存の画面と、運用の担当へ伝える出口。
		expect(within(region).getByRole('link', { name: '元の注文を開く' })).toHaveAttribute('href', `/admin/orders/${uuid(601)}`);
		expect(region).toHaveTextContent('処理の修正が必要な時は、運用の担当へ次のコードを伝えてください');
		expect(within(region).queryByRole('button', { name: '確認済みにする' })).not.toBeInTheDocument();
		expect(within(region).getByRole('button', { name: 'もう一度計上する' })).toBeInTheDocument();
	});

	it('FREQ-569-AC-06: 再計上の結果の件数をそのまま出し、保留が消えた一覧を読み直す', async () => {
		const api = serve({
			events: [pendingEvent(1, { reason: 'posting_error', detail: { error_sqlstate: '23514', error_code: 'unexpected_error' } })],
			run: { payments: 0, shipments: 1, stripe: 0, disputes: 0, parked: 0, resolved: 1, hasMore: false },
		});
		render(<PendingView />);
		fireEvent.click(await screen.findByRole('button', { name: 'もう一度計上する' }));
		expect(await screen.findByText(/1件を計上しました/)).toHaveTextContent('出荷1件');
		expect(screen.getByText(/1件を計上しました/)).toHaveTextContent('支払い0件');
		expect(await screen.findByText('計上待ちはありません')).toBeInTheDocument();
		expect(api.calls.filter((call) => call.url === `${BASE}/posting/run`)).toHaveLength(1);
	});

	it('FREQ-569-AC-04: 前受金の確認に繰り越した前受金の一覧と異常が出る', async () => {
		serve({
			events: [],
			deferred: {
				orders: [
					{ order_id: uuid(1), order_number: 'ORD-AAAA1111', balance: 12000, paid_on: '2026-12-20', unshipped_units: 2, states: { ready: 2 } },
					{ order_id: uuid(2), order_number: 'ORD-BBBB2222', balance: 8000, paid_on: '2026-12-28', unshipped_units: 1, states: { in_production: 1 } },
				],
				next_after_order: null,
				total_balance: 20000,
				anomalies: [
					{ order_id: uuid(3), order_number: 'ORD-CCCC3333', balance: -500, reason: 'negative_balance' },
					{ order_id: uuid(4), order_number: 'ORD-DDDD4444', balance: 300, reason: 'balance_after_all_shipped_or_refunded' },
				],
			},
		});
		render(<PendingView />);
		const panel = await screen.findByRole('region', { name: '前受金の確認' });
		const table = await within(panel).findByRole('table', { name: '繰り越した前受金の一覧' });
		expect(within(table).getByText('ORD-AAAA1111')).toBeInTheDocument();
		expect(within(table).getByText('¥12,000')).toBeInTheDocument();
		expect(within(table).getByText('2026/12/28')).toBeInTheDocument();
		expect(within(panel).getByText('前受金の残りの合計 ¥20,000')).toBeInTheDocument();
		const anomalies = within(panel).getByRole('list', { name: '前受金の異常' });
		expect(within(anomalies).getByText(/ORD-CCCC3333/)).toHaveTextContent('前受金の残りがマイナスです');
		expect(within(anomalies).getByText(/ORD-DDDD4444/)).toHaveTextContent('すべて出荷または返金したのに、前受金が残っています');
	});

	it('FREQ-569-AC-04: 繰り越した前受金の日付は課税事業者になる期間の初めの前の日が既定で、選び直せる', async () => {
		const taxable = solePeriod(2027, { consumptionTaxStatus: 'taxable', consumptionTaxableFrom: '2027-01-01' });
		const api = serve({ events: [], periods: [solePeriod(2026), taxable] });
		render(<PendingView />);
		const panel = await screen.findByRole('region', { name: '前受金の確認' });
		const date = await within(panel).findByLabelText('この日の終わりの前受金');
		await waitFor(() => expect(date).toHaveValue('2026-12-31'));
		await waitFor(() => expect(api.calls.some((call) => call.url === `${BASE}/deferred-revenue`)).toBe(true));
		expect(new URL(`http://x${api.fn.mock.calls.map((c) => String(c[0])).find((u) => u.includes('deferred-revenue'))}`).searchParams.get('asOf')).toBe('2026-12-31');
		fireEvent.change(date, { target: { value: '2027-03-31' } });
		await waitFor(() =>
			expect(api.fn.mock.calls.some((call) => String(call[0]).includes('asOf=2027-03-31'))).toBe(true),
		);
	});

	describe('前受金の確認の読み直し', () => {
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
		const order = (n: number, number: string) => ({ order_id: uuid(n), order_number: number, balance: 1000, paid_on: '2026-12-20', unshipped_units: 1, states: {} });
		const route = (deferred: (asOf: string | null, after: string | null) => Promise<Response> | Response) => {
			global.fetch = jest.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), 'http://localhost');
				if (url.pathname === `${BASE}/pending-events`) return json(envelope(pendingPage([]), ALL_FLAGS));
				if (url.pathname === `${BASE}/periods`) return json({ data: { periods: [], settings: {}, deadlines: {}, interim: {}, startup: [] }, permissions: { manageSettings: false } });
				if (url.pathname === `${BASE}/deferred-revenue`) return deferred(url.searchParams.get('asOf'), url.searchParams.get('afterOrder'));
				return json({}, 404);
			}) as unknown as typeof fetch;
		};

		it('FREQ-569-AC-04: 日を替えた後に前の日の続きが遅れて返っても、新しい日の表に足さない', async () => {
			let releaseOld: (response: Response) => void = () => {};
			route((asOf, after) => {
				if (after) return new Promise<Response>((resolve) => { releaseOld = resolve; });
				if (asOf === '2027-03-31') return json(envelope({ orders: [order(2, 'ORD-NEW')], next_after_order: null, total_balance: 1000, anomalies: [] }));
				return json(envelope({ orders: [order(1, 'ORD-OLD1')], next_after_order: uuid(1), total_balance: 2000, anomalies: [] }));
			});
			render(<PendingView />);
			const panel = await screen.findByRole('region', { name: '前受金の確認' });
			await within(panel).findByText('ORD-OLD1');
			fireEvent.click(within(panel).getByRole('button', { name: 'さらに読み込む' }));
			fireEvent.change(within(panel).getByLabelText('この日の終わりの前受金'), { target: { value: '2027-03-31' } });
			await within(panel).findByText('ORD-NEW');
			await act(async () => {
				releaseOld(json(envelope({ orders: [order(3, 'ORD-OLD2')], next_after_order: null, total_balance: 2500, anomalies: [] })));
			});
			expect(within(panel).queryByText('ORD-OLD2')).not.toBeInTheDocument();
			expect(within(panel).queryByText('ORD-OLD1')).not.toBeInTheDocument();
			expect(within(panel).getByText('前受金の残りの合計 ¥1,000')).toBeInTheDocument();
		});

		it('FREQ-569-AC-04: 日を替えて読み直しに失敗したら、前の日の表を残さず固定の文を出す', async () => {
			route((asOf) => (asOf === '2027-03-31'
				? json({ error: '会計の処理に失敗しました。' }, 500)
				: json(envelope({ orders: [order(1, 'ORD-OLD1')], next_after_order: null, total_balance: 2000, anomalies: [] }))));
			render(<PendingView />);
			const panel = await screen.findByRole('region', { name: '前受金の確認' });
			await within(panel).findByText('ORD-OLD1');
			fireEvent.change(within(panel).getByLabelText('この日の終わりの前受金'), { target: { value: '2027-03-31' } });
			expect(await within(panel).findByText('会計の処理に失敗しました。')).toBeInTheDocument();
			expect(within(panel).queryByText('ORD-OLD1')).not.toBeInTheDocument();
			expect(within(panel).queryByRole('table', { name: '繰り越した前受金の一覧' })).not.toBeInTheDocument();
		});
	});
});
