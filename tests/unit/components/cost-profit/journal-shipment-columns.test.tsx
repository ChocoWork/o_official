import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CostProfitSection from '@/components/CostProfitSection';
import { useShipmentJournalMeta } from '@/components/cost-profit/ledger-view';
import { BASE, envelope, uuid } from './accounting-fixtures';
import { mockFetch, solePeriod } from './settings-fixtures';

// 仕訳帳の出荷の列と出荷の跡（FREQ-564-AC-03・AC-04）。列は帳簿タブの「仕訳・元帳」の仕訳一覧の列で、
// 出荷の仕訳の行にだけ「出荷した日」「登録した日」と「出荷の跡」の操作が付き、ほかの行は空。
// 仕訳の読み口は shipmentMeta（出荷の仕訳だけ）を足す。跡は {slip, history, entries}（snake_case）。

const PERIOD = solePeriod(2026);
const SLIP = uuid(901);
const E5 = uuid(305);
const E6 = uuid(306);
const E7 = uuid(307);

function line(lineNo: number, accountCode: string, debit: number, credit: number) {
	return { lineNo, accountCode, debit, credit, subAccount: null, counterparty: null, orderId: null, memo: null };
}

function entry(id: string, no: number, overrides: Record<string, unknown> = {}) {
	return {
		id,
		periodId: PERIOD.id,
		entryNo: no,
		entryDate: '2026-11-03',
		eventKind: 'payment_confirmed',
		dedupeKey: `k:${no}`,
		description: '注文の支払い',
		recordedAt: '2026-11-03T05:00:00+00:00',
		recordedBy: null,
		isLate: false,
		reversesEntryId: null,
		reason: null,
		sourceTable: 'orders',
		sourceId: uuid(800 + no),
		migratedFrom: null,
		migratedAt: null,
		sourceRecordedAt: null,
		lines: [line(1, '2150', 0, 30000), line(2, '1160', 30000, 0)],
		...overrides,
	};
}

const SHIPMENT_ENTRY = entry(E5, 5, {
	eventKind: 'shipment_confirmed', description: '出荷', sourceTable: 'shipment_slips', sourceId: SLIP,
	lines: [line(1, '2150', 30000, 0), line(2, '4010', 0, 30000)],
});
const PAYMENT_ENTRY = entry(uuid(304), 4, { lines: [line(1, '2150', 0, 30000), line(2, '1160', 30000, 0)] });
const META = { entryId: E5, slipNumber: 'SL-20261103-0001', shipmentDate: '2026-11-03', confirmedAt: '2026-11-03T16:30:00+00:00' };

const TRACE = {
	slip: { number: 'SL-20261103-0001', confirmed_at: '2026-11-03T16:30:00+00:00', shipment_date: '2026-11-05', stage: 'confirmed' },
	history: [
		{ version: 1, kind: 'initial', previous_date: '2026-11-03', new_date: '2026-11-03', reason: null, actor_id: uuid(11), created_at: '2026-11-03T16:30:00+00:00' },
		{ version: 2, kind: 'correction', previous_date: '2026-11-03', new_date: '2026-11-05', reason: '出荷日の記録の誤り', actor_id: uuid(12), created_at: '2026-11-04T02:00:00+00:00' },
	],
	entries: [
		{ entry_id: E5, entry_no: 5, event_kind: 'shipment_confirmed', entry_date: '2026-11-03', recorded_at: '2026-11-03T17:00:00+00:00', reverses_entry_id: null },
		{ entry_id: E6, entry_no: 6, event_kind: 'reversal', entry_date: '2026-11-03', recorded_at: '2026-11-04T02:00:01+00:00', reverses_entry_id: E5 },
		{ entry_id: E7, entry_no: 7, event_kind: 'shipment_redated', entry_date: '2026-11-05', recorded_at: '2026-11-04T02:00:02+00:00', reverses_entry_id: null },
	],
};

function financeData() {
	return {
		fiscalYear: 2026, seasonKey: null, businessType: 'soleProprietor',
		plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
		expenses: [], incomes: [], products: [], partners: [], fixedAssets: [],
		closing: { closingInventoryGoods: 0, closingInventoryMaterials: 0, allowanceForDoubtful: 0, closingBalances: {}, closedAt: null },
		previousClosingBalances: null, revisions: [], reviewAcks: [], cumulativeEntries: [], templates: [], summaryOptions: [],
		stripeAccounting: { balanceTransactions: [], refunds: [], payouts: [], summary: { stripeBalance: 0, inTransitBalance: 0, unmatchedPayoutCount: 0 } },
		period: PERIOD, periods: [PERIOD], savedJournal: [PAYMENT_ENTRY, SHIPMENT_ENTRY], opening: [],
		periodNotices: { filingDeadlinePassed: false, previousPeriodOpen: false },
	};
}

type Serve = { journalPages?: Record<string, unknown>; journalStatus?: number; traceStatus?: number };

function serve(state: Serve = {}) {
	return mockFetch((url) => {
		if (url.pathname === '/api/admin/kpi/cost-profit') return { status: 200, body: { data: financeData() } };
		if (url.pathname === `${BASE}/journal`) {
			if (state.journalStatus) return { status: state.journalStatus, body: { error: '会計の処理に失敗しました。' } };
			const body = state.journalPages?.[url.searchParams.get('afterEntryNo') ?? 'first'] ?? {
				entries: [PAYMENT_ENTRY, SHIPMENT_ENTRY], nextAfter: null, opening: [], shipmentMeta: [META],
			};
			return { status: 200, body: envelope(body) };
		}
		if (url.pathname === `${BASE}/shipment-trace`) {
			if (state.traceStatus) return { status: state.traceStatus, body: { code: 'ACCOUNTING_NOT_FOUND', error: '会計の記録が見つかりません。' } };
			return { status: 200, body: envelope(TRACE) };
		}
		return undefined;
	});
}

/** 勘定科目の一覧から「前受金」を選ぶ（仕訳一覧は選んだ科目の元帳行）。 */
async function selectAccount() {
	const button = await waitFor(() => {
		const found = screen.getAllByRole('button').find((candidate) => candidate.textContent?.startsWith('2150前受金'));
		if (!found) throw new Error('2150 not shown yet');
		return found;
	});
	fireEvent.click(button);
}

async function openLedger() {
	render(<CostProfitSection periodId={null} fiscalYear={2026} fiscalYearLabel="2026年" />);
	await screen.findByText('同期済み');
	fireEvent.click(screen.getByRole('tab', { name: '帳簿' }));
	// 仕訳一覧の表は選んだ科目の元帳行。2つの仕訳が通る「前受金」を選ぶ。
	await selectAccount();
	return screen.findByRole('button', { name: 'JE-000005の出荷の跡を開く' });
}

const journalTable = () => screen.getAllByRole('table').find((table) => within(table).queryByRole('columnheader', { name: '出荷した日' }))!;
const rowOf = (number: string) => within(journalTable()).getAllByRole('row').find((row) => within(row).queryByText(number))!;

describe('仕訳帳の出荷の列', () => {
	jest.setTimeout(30000);

	it('FREQ-564-AC-04: 仕訳帳の出荷の仕訳に出荷した日と登録した日が並び、ほかの仕訳は空', async () => {
		const api = serve();
		await openLedger();
		const headers = within(journalTable()).getAllByRole('columnheader').map((cell) => cell.textContent);
		// 既存の列の後ろに、出荷した日・登録した日・出荷の跡の3列。
		expect(headers.slice(-3)).toEqual(['出荷した日', '登録した日', '出荷の跡']);
		expect(headers.slice(0, 3)).toEqual(['日付', '伝票No.', '相手勘定科目']);
		expect(api.fn.mock.calls.some((call) => String(call[0]).includes(`${BASE}/journal?`) && String(call[0]).includes(`periodId=${PERIOD.id}`))).toBe(true);

		const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((cell) => cell.textContent);
		// 出荷の仕訳: 出荷した日 = 発送票の出荷日、登録した日 = 発送票を確定した日（日本時間）。
		const shipment = cells(rowOf('JE-000005'));
		expect(shipment.slice(-3, -1)).toEqual(['2026/11/03', '2026/11/04']);
		expect(within(rowOf('JE-000005')).getByRole('button', { name: 'JE-000005の出荷の跡を開く' })).toBeInTheDocument();
		// 出荷でない仕訳は、3つの列とも空で、跡の操作も無い。
		const payment = cells(rowOf('JE-000004'));
		expect(payment.slice(-3)).toEqual(['', '', '']);
		expect(within(rowOf('JE-000004')).queryByRole('button', { name: /出荷の跡/ })).not.toBeInTheDocument();
	});

	it('FREQ-564-AC-04: 続きの仕訳も最後まで読んで、出荷の列に反映する', async () => {
		const api = serve({
			journalPages: {
				first: { entries: [PAYMENT_ENTRY], nextAfter: { entryDate: '2026-11-03', entryNo: 4 }, opening: [], shipmentMeta: [] },
				'4': { entries: [SHIPMENT_ENTRY], nextAfter: null, opening: [], shipmentMeta: [META] },
			},
		});
		await openLedger();
		expect(api.fn.mock.calls.some((call) => String(call[0]).includes('afterEntryDate=2026-11-03&afterEntryNo=4'))).toBe(true);
	});

	it('FREQ-564-AC-04: 出荷の日付が読めなくても仕訳一覧は出て、固定の文で知らせ、本文を読み切る', async () => {
		const api = serve({ journalStatus: 500 });
		render(<CostProfitSection periodId={null} fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '帳簿' }));
		await selectAccount();
		expect(await screen.findByText('会計の処理に失敗しました。')).toBeInTheDocument();
		await waitFor(() => expect(within(journalTable()).getByText('JE-000005')).toBeInTheDocument());
		const cells = within(rowOf('JE-000005')).getAllByRole('cell').map((cell) => cell.textContent);
		expect(cells.slice(-3)).toEqual(['', '', '']);
		expect(api.calls.find((call) => call.url === `${BASE}/journal`)?.response.bodyUsed).toBe(true);
	});

	it('FREQ-564-AC-03: 出荷の跡に直した理由・人・前後の日と、取り消しと正しい仕訳が並ぶ', async () => {
		const api = serve();
		fireEvent.click(await openLedger());

		const trace = await screen.findByRole('region', { name: '出荷の跡' });
		await within(trace).findByRole('list', { name: '出荷日の直した跡' });
		expect(api.fn.mock.calls.some((call) => String(call[0]).includes(`shipment-trace?slipId=${SLIP}`))).toBe(true);
		expect(trace).toHaveTextContent('SL-20261103-0001');
		expect(trace).toHaveTextContent('今の出荷日 2026/11/05');

		const items = within(within(trace).getByRole('list', { name: '出荷日の直した跡' })).getAllByRole('listitem');
		expect(items[0]).toHaveTextContent('最初の出荷日 2026/11/03');
		expect(items[1]).toHaveTextContent('2026/11/03 から 2026/11/05 へ直しました');
		expect(items[1]).toHaveTextContent('理由 出荷日の記録の誤り');
		expect(items[1]).toHaveTextContent('担当 00000000');
		expect(items[1]).toHaveTextContent('直した日 2026/11/04');

		const rows = within(within(trace).getByRole('list', { name: 'この出荷の仕訳' })).getAllByRole('listitem');
		expect(rows).toHaveLength(3);
		expect(rows[0]).toHaveTextContent('JE-000005');
		expect(rows[0]).toHaveTextContent('取り消されました（JE-000006）');
		expect(rows[1]).toHaveTextContent('JE-000006');
		expect(rows[1]).toHaveTextContent('JE-000005を取り消す');
		expect(rows[2]).toHaveTextContent('JE-000007');
		expect(rows[2]).toHaveTextContent('今の正しい仕訳');
		// お客様の名前・メールは出さない。
		expect(trace.textContent).not.toMatch(/@|様/);
	});

	it('FREQ-564-AC-03: 跡が読めなければ固定の文を出して本文を読み切り、閉じられる', async () => {
		const api = serve({ traceStatus: 404 });
		fireEvent.click(await openLedger());
		expect(await screen.findByText('会計の記録が見つかりません。')).toBeInTheDocument();
		expect(api.calls.find((call) => call.url === `${BASE}/shipment-trace`)?.response.bodyUsed).toBe(true);
		fireEvent.click(screen.getByRole('button', { name: '出荷の跡を閉じる' }));
		expect(screen.queryByRole('region', { name: '出荷の跡' })).not.toBeInTheDocument();
	});

	it('FREQ-564-AC-04: 上限のページ数まで読んでも続きがあれば、後ろの列が空であることを穏やかな文で知らせる', async () => {
		mockFetch((url) => {
			if (url.pathname === '/api/admin/kpi/cost-profit') return { status: 200, body: { data: financeData() } };
			if (url.pathname === `${BASE}/journal`) {
				return { status: 200, body: envelope({ entries: [], nextAfter: { entryDate: '2026-11-03', entryNo: 4 }, opening: [], shipmentMeta: [] }) };
			}
			return undefined;
		});
		render(<CostProfitSection periodId={null} fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '帳簿' }));
		expect(await screen.findByText(/仕訳が多いため、後ろの仕訳の出荷した日と登録した日は空のままです/, undefined, { timeout: 15000 })).toBeInTheDocument();
	});
});

describe('出荷の列の読み込み（期間を替えた時）', () => {
	function Probe({ periodId }: { periodId: string }) {
		const { byNumber } = useShipmentJournalMeta(periodId);
		return <ul aria-label="出荷の列">{[...byNumber].map(([number, info]) => <li key={number}>{`${number} ${info.shipmentDate}`}</li>)}</ul>;
	}
	const page = (entryNo: number, entryId: string, shipmentDate: string) => envelope({
		entries: [entry(entryId, entryNo, { eventKind: 'shipment_confirmed', sourceTable: 'shipment_slips', sourceId: uuid(950 + entryNo) })],
		nextAfter: null, opening: [],
		shipmentMeta: [{ entryId, slipNumber: `SL-${entryNo}`, shipmentDate, confirmedAt: '2026-11-03T16:30:00+00:00' }],
	});

	it('FREQ-564-AC-04: 期間を替えたら、前の期間の遅れた答えで出荷の列を上書きしない', async () => {
		const OLD = uuid(2025);
		const NEW = uuid(2026);
		let releaseOld: (response: Response) => void = () => {};
		const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		global.fetch = jest.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), 'http://localhost');
			if (url.pathname !== `${BASE}/journal`) return new Response('{}', { status: 404 });
			if (url.searchParams.get('periodId') === OLD) return new Promise<Response>((resolve) => { releaseOld = resolve; });
			return json(page(7, uuid(307), '2026-12-01'));
		}) as unknown as typeof fetch;

		const { rerender } = render(<Probe periodId={OLD} />);
		rerender(<Probe periodId={NEW} />);
		const list = screen.getByRole('list', { name: '出荷の列' });
		await within(list).findByText('JE-000007 2026-12-01');
		await act(async () => {
			releaseOld(json(page(5, uuid(305), '2025-12-01')));
		});
		expect(within(list).queryByText(/2025-12-01/)).not.toBeInTheDocument();
		expect(within(list).getAllByRole('listitem')).toHaveLength(1);
	});
});
