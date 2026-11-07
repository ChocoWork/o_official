import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AccountingSection from '@/components/AccountingSection';
import CostProfitSection from '@/components/CostProfitSection';

// 会計の画面を会計の期間で数える（FREQ-557）。cost-profit GET の作り物は期間・保存した仕訳・期首だけを変える。

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P2026 = {
	id: uuid(2026), businessType: 'soleProprietor', name: '2026年（個人）', startsOn: '2026-01-01', endsOn: '2026-12-31',
	corporateTaxExtensionMonths: 0, consumptionTaxExtensionMonths: 0, consumptionTaxStatus: 'exempt', consumptionTaxableFrom: null, version: '1',
};
const P2027 = {
	...P2026, id: uuid(2027), businessType: 'corporation', name: '第1期', startsOn: '2027-07-15', endsOn: '2028-07-14',
};

type Line = [accountCode: string, debit: number, credit: number];
function saved(n: number, date: string, lines: Line[], periodId = P2026.id) {
	return {
		id: uuid(500_000 + n), periodId, entryNo: n, entryDate: date, eventKind: 'manual_entry', dedupeKey: `manual_entry:${n}:0`,
		description: `手入力${n}`, recordedAt: `${date}T01:00:00Z`, recordedBy: null, isLate: false, reversesEntryId: null,
		reason: null, sourceTable: 'admin_finance_expenses', sourceId: String(n), migratedFrom: null, migratedAt: null,
		sourceRecordedAt: null,
		lines: lines.map(([accountCode, debit, credit], index) => ({
			lineNo: index + 1, accountCode, debit, credit, subAccount: null, counterparty: null, orderId: null, memo: null,
		})),
	};
}
const advertising = (n: number, amount: number, date = '2026-04-01') => saved(n, date, [['6060', amount, 0], ['1010', 0, amount]]);
const opening = (rows: Array<[string, number]>) => rows.map(([accountCode, signedAmount]) => ({ accountCode, signedAmount, basis: 'carryover' }));

function financeData(overrides: Record<string, unknown> = {}) {
	return {
		fiscalYear: 2026,
		seasonKey: null,
		businessType: 'soleProprietor',
		plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
		expenses: [],
		incomes: [],
		products: [],
		partners: [],
		fixedAssets: [],
		closing: { closingInventoryGoods: 0, closingInventoryMaterials: 0, allowanceForDoubtful: 0, closingBalances: {}, closedAt: null },
		previousClosingBalances: null,
		revisions: [],
		reviewAcks: [],
		cumulativeEntries: [],
		templates: [],
		summaryOptions: [],
		stripeAccounting: {
			balanceTransactions: [], refunds: [], payouts: [],
			summary: { stripeBalance: 0, inTransitBalance: 0, unmatchedPayoutCount: 0 },
		},
		period: P2026,
		periods: [P2026, P2027],
		savedJournal: [],
		opening: opening([['1010', 100_000], ['2910', -100_000]]),
		periodNotices: { filingDeadlinePassed: false, previousPeriodOpen: false },
		...overrides,
	};
}

type Reply = { status: number; body: unknown };
/** cost-profit GET の答えを要求の条件（periodId か旧の year）で返す。ほかの API は空で答える。 */
function mockFinanceFetch(reply: (url: URL) => Reply) {
	const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input), 'http://localhost');
		if (url.pathname === '/api/admin/kpi/cost-profit') {
			const { status, body } = reply(url);
			return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
		}
		return new Response(JSON.stringify({ error: 'not mocked' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
	});
	global.fetch = mockFetch as unknown as typeof fetch;
	return mockFetch;
}
const costProfitUrls = (mockFetch: jest.Mock) =>
	mockFetch.mock.calls.map(([input]) => String(input)).filter((url) => url.startsWith('/api/admin/kpi/cost-profit'));

async function openTrialBalance() {
	fireEvent.click(screen.getByRole('tab', { name: '帳簿' }));
	fireEvent.click(screen.getByRole('tab', { name: '決算・試算表' }));
	fireEvent.click(screen.getByRole('tab', { name: '合計残高試算表' }));
	return screen.getByRole('columnheader', { name: '借方合計' }).closest('table') as HTMLTableElement;
}
const rowOf = (table: HTMLElement, accountName: string) =>
	within(table).getByText(accountName).closest('tr') as HTMLTableRowElement;
const totalRowOf = (table: HTMLElement) => within(table).getByText('合計').closest('tr') as HTMLTableRowElement;

async function selectPeriod(name: string) {
	fireEvent.click(screen.getByRole('combobox', { name: '会計期間' }));
	fireEvent.click(screen.getByRole('option', { name }));
}

describe('会計の画面を期間で数える', () => {
	jest.setTimeout(30000);

	it('FREQ-557-AC-01: 手入力の取引は保存した仕訳から一度だけ数え合成と重ならない', async () => {
		mockFinanceFetch(() => ({
			status: 200,
			body: {
				data: financeData({
					expenses: [{ id: 1, entryType: 'expense', date: '2026-04-01', category: '広告宣伝費', item: '手入力1', partner: '', amount: 32_000, paymentMethod: '現金', memo: '' }],
					incomes: [{
						id: -1, entryType: 'income', date: '2026-04-02', category: '売上高', item: 'オンライン注文', partner: '', amount: 10_000,
						paymentMethod: 'Stripe', memo: '', seasonTag: null, receipts: [], source: 'order', sourceId: 'order-9', readOnly: true,
						grossAmount: 10_000, refundedAmount: 0,
					}],
					savedJournal: [advertising(1, 32_000)],
				}),
			},
		}));
		render(<CostProfitSection periodId={null} fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		const table = await openTrialBalance();
		// 手入力の32,000円は保存した仕訳の1本だけ。手入力から合成した2本目は無い。
		expect(rowOf(table, '広告宣伝費')).toHaveTextContent('¥32,000');
		expect(table).not.toHaveTextContent('¥64,000');
		// 注文は合成（計画2で保存）で売上に入る。
		expect(rowOf(table, '売上高')).toHaveTextContent('¥10,000');
		expect(totalRowOf(table)).toHaveTextContent('合計¥42,000¥42,000');

		// 合成の仕訳には「集計中（計画2で保存）」の印、保存した仕訳には付けない。
		fireEvent.click(screen.getByRole('tab', { name: '仕訳・元帳' }));
		const accountTree = screen.getByRole('region', { name: '勘定科目' });
		fireEvent.click(within(accountTree).getByRole('button', { name: /^4010 売上高/ }));
		expect(within(screen.getByRole('region', { name: '仕訳一覧' })).getByText('集計中（計画2で保存）')).toBeInTheDocument();
		fireEvent.click(within(accountTree).getByRole('button', { name: /^6060 広告宣伝費/ }));
		const journalList = screen.getByRole('region', { name: '仕訳一覧' });
		expect(within(journalList).getByText('JE-000001')).toBeInTheDocument();
		expect(within(journalList).queryByText('集計中（計画2で保存）')).not.toBeInTheDocument();
	});

	it('FREQ-557-AC-01: 期間を選ぶと選んだ期間の保存した仕訳と期首だけを数える', async () => {
		const mockFetch = mockFinanceFetch((url) => url.searchParams.get('periodId') === P2027.id
			? {
				status: 200,
				body: {
					data: financeData({
						fiscalYear: 2027,
						businessType: 'corporation',
						period: P2027,
						savedJournal: [saved(1, '2027-08-01', [['6060', 50_000, 0], ['1040', 0, 50_000]], P2027.id)],
						opening: opening([['1040', 70_000], ['3010', -70_000]]),
					}),
				},
			}
			: { status: 200, body: { data: financeData({ savedJournal: [advertising(1, 32_000)] }) } });
		render(<AccountingSection />);
		await screen.findByText('同期済み');
		expect(costProfitUrls(mockFetch)[0]).toMatch(/\?year=\d{4}&season=/);

		let table = await openTrialBalance();
		expect(rowOf(table, '広告宣伝費')).toHaveTextContent('¥32,000');

		await selectPeriod('第1期');
		await waitFor(() => expect(costProfitUrls(mockFetch).at(-1)).toContain(`periodId=${P2027.id}`));
		await waitFor(() => expect(screen.getByRole('columnheader', { name: '借方合計' }).closest('table')).toHaveTextContent('¥50,000'));
		table = screen.getByRole('columnheader', { name: '借方合計' }).closest('table') as HTMLTableElement;
		// 第1期の保存した仕訳と期首（普通預金 70,000 − 50,000）だけを数え、2026年の32,000円は入らない。
		expect(rowOf(table, '広告宣伝費')).toHaveTextContent('¥50,000');
		expect(rowOf(table, '普通預金')).toHaveTextContent('¥20,000');
		expect(table).not.toHaveTextContent('¥32,000');
		expect(screen.queryByText('現金')).not.toBeInTheDocument();
	});

	it('FREQ-557-AC-02: 損益と貸借の控除前の所得が一致し合わなければ入れ漏れを示す', async () => {
		mockFinanceFetch(() => ({ status: 200, body: { data: financeData({ savedJournal: [advertising(1, 32_000)] }) } }));
		const { unmount } = render(<CostProfitSection periodId={null} fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		expect(screen.queryByText('事業主貸・事業主借の入れ漏れを確かめてください')).not.toBeInTheDocument();
		unmount();

		// 期首に元入金が無い（資産と純資産が合わない）と、貸借の側の所得が損益とずれる。
		mockFinanceFetch(() => ({
			status: 200,
			body: { data: financeData({ savedJournal: [advertising(1, 32_000)], opening: opening([['1010', 100_000]]) }) },
		}));
		render(<CostProfitSection periodId={null} fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		expect(screen.getByText('事業主貸・事業主借の入れ漏れを確かめてください')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('tab', { name: '帳簿' }));
		expect(screen.getByText('事業主貸・事業主借の入れ漏れを確かめてください')).toBeInTheDocument();
	});

	it('FREQ-557-AC-05: 期間が1つも無いときは404でなく空の画面を返し作成を案内する', async () => {
		mockFinanceFetch(() => ({
			status: 200,
			body: { data: financeData({ period: null, periods: [], opening: [] }) },
		}));
		render(<CostProfitSection periodId={null} fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		const guide = '期間がありません。設定・期間のタブで期間を作ってください';
		expect(screen.getByText(guide)).toBeInTheDocument();
		expect(screen.queryByText('損益計算書（P/L）')).not.toBeInTheDocument();
		for (const tab of ['取引管理', '帳簿', '税務レポート']) {
			fireEvent.click(screen.getByRole('tab', { name: tab }));
			expect(screen.getByText(guide)).toBeInTheDocument();
		}
		expect(screen.queryByRole('columnheader', { name: '借方合計' })).not.toBeInTheDocument();
		expect(screen.queryByRole('combobox', { name: '会計期間' })).not.toBeInTheDocument();
	});

	it('FREQ-557-AC-05: 前の期間を締めていない間は数字がまだ動くと出し、期限を過ぎた期間への入力に知らせる', async () => {
		mockFinanceFetch(() => ({
			status: 200,
			body: { data: financeData({ periodNotices: { filingDeadlinePassed: true, previousPeriodOpen: true } }) },
		}));
		const { unmount } = render(<CostProfitSection periodId={null} fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		const moving = '前の期間を締めていないため、数字はまだ動きます';
		const late = 'この期間の申告の期限を過ぎています。入れた仕訳は取り消しと正しい仕訳として残ります';
		expect(screen.getByText(moving)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('tab', { name: '帳簿' }));
		expect(screen.getByText(moving)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		expect(screen.getByText(late)).toBeInTheDocument();
		unmount();

		mockFinanceFetch(() => ({ status: 200, body: { data: financeData() } }));
		render(<CostProfitSection periodId={null} fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		expect(screen.queryByText(moving)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		expect(screen.queryByText(late)).not.toBeInTheDocument();
	});

	it('FREQ-557-AC-06: 保存した仕訳が201件ある期間は101件目と201件目も読み試算表と元帳と決算書の合計に入る', async () => {
		// n 件目は n 円。101件目と201件目だけ1万円を足す。合計 = 1+…+201 + 20,000 = 40,301 円。
		const entries = Array.from({ length: 201 }, (_, index) => {
			const n = index + 1;
			return advertising(n, n === 101 || n === 201 ? n + 10_000 : n);
		});
		mockFinanceFetch(() => ({ status: 200, body: { data: financeData({ savedJournal: entries }) } }));
		render(<CostProfitSection periodId={null} fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		const table = await openTrialBalance();
		expect(rowOf(table, '広告宣伝費')).toHaveTextContent('¥40,301');
		expect(totalRowOf(table)).toHaveTextContent('合計¥40,301¥40,301');
		fireEvent.click(screen.getByRole('tab', { name: '損益計算書' }));
		expect(screen.getAllByText('¥40,301').length).toBeGreaterThan(0);

		fireEvent.click(screen.getByRole('tab', { name: '仕訳・元帳' }));
		const accountTree = screen.getByRole('region', { name: '勘定科目' });
		fireEvent.click(within(accountTree).getByRole('button', { name: /^6060 広告宣伝費/ }));
		const journalList = screen.getByRole('region', { name: '仕訳一覧' });
		expect(journalList).toHaveTextContent('/ 201件');
	});

	it('FREQ-557-AC-06: ページの上限または途中の取得失敗では一部しか読めていないと出し合計も書き出しも出さない', async () => {
		let failure = 'JOURNAL_TOO_LARGE';
		mockFinanceFetch((url) => url.searchParams.get('periodId') === P2027.id
			? { status: 500, body: { error: '会計データの取得に失敗しました。', code: failure } }
			: { status: 200, body: { data: financeData({ savedJournal: [advertising(1, 32_000)] }) } });
		render(<AccountingSection />);
		await screen.findByText('同期済み');

		// 前の期間（2026年）の合計を表示した後に、第1期の読み込みが上限で失敗する。
		const table = await openTrialBalance();
		expect(rowOf(table, '広告宣伝費')).toHaveTextContent('¥32,000');
		await selectPeriod('第1期');

		const partial = '一部しか読めていないため、合計を表示できません。もう一度読み込んでください';
		expect(await screen.findByText(partial)).toBeInTheDocument();
		expect(screen.queryByRole('columnheader', { name: '借方合計' })).not.toBeInTheDocument();
		expect(screen.queryByText('¥32,000')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: '仕訳帳CSV' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /試算表CSV/ })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('tab', { name: '財務概要' }));
		expect(screen.getByText(partial)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: '損益計算書CSV' })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('tab', { name: '税務レポート' }));
		expect(screen.getByText(partial)).toBeInTheDocument();

		// 途中のページの取得失敗も同じ。
		failure = 'JOURNAL_INCOMPLETE';
		fireEvent.click(screen.getByRole('button', { name: /更新/ }));
		await screen.findByText('同期エラー');
		expect(screen.getByText(partial)).toBeInTheDocument();
		expect(screen.queryByText('¥32,000')).not.toBeInTheDocument();
	});
});
