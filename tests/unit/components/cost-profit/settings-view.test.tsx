import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CostProfitSection from '@/components/CostProfitSection';
import { SettingsView } from '@/components/cost-profit/settings-view';
import {
	corporatePeriod,
	mockFetch,
	periodsBody,
	settingsOf,
	solePeriod,
} from './settings-fixtures';

// 設定・期間のタブ（FREQ-555・561）。GET /api/admin/accounting/periods の答えは本物の期限の関数で作る。

const PERIODS_URL = '/api/admin/accounting/periods';
const ALWAYS_NOTICE =
	'事業をやめたら、年が変わる前、かつ事業の形を法人へ変える前に、やめた日を登録してください。翌年の個人の期間が先にできると登録できません';

function financeData(period: unknown, periods: unknown[]) {
	return {
		fiscalYear: 2026,
		seasonKey: null,
		businessType: 'soleProprietor',
		plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
		expenses: [], incomes: [], products: [], partners: [], fixedAssets: [],
		closing: { closingInventoryGoods: 0, closingInventoryMaterials: 0, allowanceForDoubtful: 0, closingBalances: {}, closedAt: null },
		previousClosingBalances: null, revisions: [], reviewAcks: [], cumulativeEntries: [], templates: [], summaryOptions: [],
		stripeAccounting: { balanceTransactions: [], refunds: [], payouts: [], summary: { stripeBalance: 0, inTransitBalance: 0, unmatchedPayoutCount: 0 } },
		period, periods, savedJournal: [], opening: [],
		periodNotices: { filingDeadlinePassed: false, previousPeriodOpen: false },
	};
}

const region = (name: string) => screen.getByRole('region', { name });

describe('設定・期間のタブ', () => {
	jest.setTimeout(30000);

	it('FREQ-561-AC-02: 設定タブは開業日の入力と事業の形と期間の一覧と期限を出す', async () => {
		const p2026 = solePeriod(2026);
		const settings = settingsOf();
		mockFetch((url) => {
			if (url.pathname === '/api/admin/kpi/cost-profit') return { status: 200, body: { data: financeData(p2026, [p2026]) } };
			if (url.pathname === PERIODS_URL) return { status: 200, body: periodsBody([p2026], settings) };
			return undefined;
		});
		render(<CostProfitSection periodId={null} fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		// 他のタブの順と題は変えずに、最後に「設定・期間」を足す。
		expect(screen.getAllByRole('tab').slice(0, 6).map((tab) => tab.textContent)).toEqual([
			'財務概要', '取引管理', '帳簿', '商品原価', '税務レポート', '設定・期間',
		]);
		fireEvent.click(screen.getByRole('tab', { name: '設定・期間' }));

		const start = await screen.findByRole('region', { name: '開業日と事業の形' });
		const input = within(start).getByLabelText('開業日');
		expect(input).not.toHaveAttribute('readonly');
		expect(within(start).getByText('一度入れると選び直せません')).toBeInTheDocument();
		expect(within(start).getByText(/^選べる日: 2000\/01\/01〜\d{4}\/\d{2}\/\d{2}$/)).toBeInTheDocument();
		expect(within(start).getByText('今の事業の形: 個人')).toBeInTheDocument();

		const list = within(region('期間')).getByRole('table');
		expect(within(list).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['名前', '始まり', '終わり', '事業の形']);
		expect(within(list).getByRole('row', { name: '2026年（個人） 2026/01/01 2026/12/31 個人' })).toBeInTheDocument();

		const deadlines = region('申告の期限');
		expect(within(deadlines).getByText('所得税の確定申告')).toBeInTheDocument();
		expect(within(deadlines).getByText('2027/03/15')).toBeInTheDocument();
		// 免税の期間には消費税の期限を出さない。
		expect(within(deadlines).getByText('課税事業者になったら出します')).toBeInTheDocument();
	});

	it('FREQ-561-AC-02: 開業日から出す届け出の期限は過ぎたものと最終仕入原価法になることを出す', async () => {
		const p2025 = solePeriod(2025);
		const settings = settingsOf({ businessStartDate: '2025-04-01' });
		mockFetch((url) => (url.pathname === PERIODS_URL ? { status: 200, body: periodsBody([p2025], settings) } : undefined));
		render(<SettingsView today="2026-11-07" />);

		const startup = await screen.findByRole('region', { name: '開業日からの届け出' });
		const inventory = within(startup).getByText('棚卸資産の評価の方法の届け出').closest('li') as HTMLElement;
		expect(inventory).toHaveTextContent('2026/03/16');
		expect(inventory).toHaveTextContent('期限を過ぎました');
		expect(inventory).toHaveTextContent('最終仕入原価法（所得税法施行令102条1項）になります');
	});

	it('FREQ-561-AC-03: 入力済みの開業日は読み取り専用で変えられない', async () => {
		const p2026 = solePeriod(2026);
		const settings = settingsOf({ businessStartDate: '2026-04-01' });
		mockFetch((url) => (url.pathname === PERIODS_URL ? { status: 200, body: periodsBody([p2026], settings) } : undefined));
		render(<SettingsView today="2026-11-07" />);

		const start = await screen.findByRole('region', { name: '開業日と事業の形' });
		const input = within(start).getByLabelText('開業日');
		expect(input).toHaveAttribute('readonly');
		expect(input).toHaveValue('2026-04-01');
		expect(within(start).queryByRole('button', { name: '開業日を保存' })).not.toBeInTheDocument();
		expect(within(start).getByText('開業日は選び直せません')).toBeInTheDocument();
	});

	it('FREQ-555-AC-01: 権限の無い利用者には追加と更新のボタンが出ない', async () => {
		const p2026 = solePeriod(2026);
		const settings = settingsOf();
		mockFetch((url) => (url.pathname === PERIODS_URL
			? { status: 200, body: periodsBody([p2026], settings, { manageSettings: false }) }
			: undefined));
		render(<SettingsView today="2026-11-07" />);

		await screen.findByRole('region', { name: '期間' });
		for (const name of ['開業日を保存', '事業の形を変える', '期間を追加', '申告の設定を保存', '事業をやめた日を登録する', 'やめた日を選び直す']) {
			expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
		}
		expect(screen.queryByLabelText('開業日')).not.toBeInTheDocument();
		expect(screen.getByText('開業日: 未入力')).toBeInTheDocument();
		// 読み取りだけの人にも、一覧と期限と案内は出す。
		expect(within(region('期間')).getByRole('table')).toBeInTheDocument();
		expect(within(region('申告の期限')).getByText('所得税の確定申告')).toBeInTheDocument();
		expect(screen.getByText(ALWAYS_NOTICE)).toBeInTheDocument();
	});

	it('FREQ-561-AC-02: 休みの日に繰り下がった期限は元の期限を添える', async () => {
		// 2025年分の所得税の期限 2026-03-15 は日曜なので 2026-03-16 になる。
		const p2025 = solePeriod(2025);
		mockFetch((url) => (url.pathname === PERIODS_URL ? { status: 200, body: periodsBody([p2025], settingsOf()) } : undefined));
		render(<SettingsView today="2026-11-07" />);

		const row = (await screen.findByText('所得税の確定申告')).closest('li') as HTMLElement;
		expect(row).toHaveTextContent('2026/03/16');
		expect(row).toHaveTextContent('元の期限 2026/03/15');
	});

	it('FREQ-561-AC-02: 法人の期間の追加前に届出の案内を出す', async () => {
		const p2026 = solePeriod(2026);
		mockFetch((url) => (url.pathname === PERIODS_URL
			? { status: 200, body: periodsBody([p2026], settingsOf({ currentBusinessType: 'corporation', soleBusinessEndedOn: '2026-12-31' })) }
			: undefined));
		render(<SettingsView today="2026-11-07" />);

		const periods = await screen.findByRole('region', { name: '期間' });
		expect(within(periods).getByText('決算月を変えた時は税務署へ遅滞なく届け出てください（法人税法15条）')).toBeInTheDocument();
		expect(within(periods).getByRole('button', { name: '期間を追加' })).toBeInTheDocument();
	});

	it('FREQ-555-AC-01: 非okの応答の本文を読み切り二重に押せない', async () => {
		const p2026 = solePeriod(2026);
		const settings = settingsOf();
		const { calls } = mockFetch((url, method) => {
			if (url.pathname === PERIODS_URL) return { status: 200, body: periodsBody([p2026], settings) };
			if (url.pathname === '/api/admin/accounting/settings' && method === 'PUT') {
				return { status: 409, body: { code: 'ACCOUNTING_SETTINGS_LOCKED', error: '開業日は一度入れると選び直せません。' } };
			}
			return undefined;
		});
		render(<SettingsView today="2026-11-07" />);

		const start = await screen.findByRole('region', { name: '開業日と事業の形' });
		fireEvent.change(within(start).getByLabelText('開業日'), { target: { value: '2026-04-01' } });
		const save = within(start).getByRole('button', { name: '開業日を保存' });
		fireEvent.click(save);
		fireEvent.click(save);

		expect(await within(start).findByText('開業日は一度入れると選び直せません。')).toBeInTheDocument();
		const puts = calls.filter((call) => call.method === 'PUT');
		expect(puts).toHaveLength(1);
		expect(puts[0].body).toEqual({
			businessStartDate: '2026-04-01',
			currentBusinessType: 'soleProprietor',
			expectedVersion: '3',
			requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		expect(puts[0].response.bodyUsed).toBe(true);
		expect(save).not.toBeDisabled();
	});

	it('FREQ-561-AC-02: 開業日は選べる日の範囲の外を送る前に止める', async () => {
		const p2026 = solePeriod(2026);
		const { calls } = mockFetch((url) => (url.pathname === PERIODS_URL ? { status: 200, body: periodsBody([p2026], settingsOf()) } : undefined));
		render(<SettingsView today="2026-11-07" />);

		const start = await screen.findByRole('region', { name: '開業日と事業の形' });
		expect(within(start).getByText('選べる日: 2000/01/01〜2027/11/07')).toBeInTheDocument();
		fireEvent.change(within(start).getByLabelText('開業日'), { target: { value: '2027-11-08' } });
		fireEvent.click(within(start).getByRole('button', { name: '開業日を保存' }));
		expect(within(start).getByText('選べる日の範囲で入れてください')).toBeInTheDocument();
		expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
	});

	it('FREQ-561-AC-02: 個人の最後の期間では所得税の年分と帳簿の期間と消費税の課税期間を分けて見せる', async () => {
		const p2026 = solePeriod(2026, { endsOn: '2026-06-30', consumptionTaxStatus: 'taxable' });
		mockFetch((url) => (url.pathname === PERIODS_URL
			? { status: 200, body: periodsBody([p2026], settingsOf({ soleBusinessEndedOn: '2026-06-30' })) }
			: undefined));
		render(<SettingsView today="2026-11-07" />);

		const block = await screen.findByRole('group', { name: '2026年（個人）の申告の期限' });
		expect(within(block).getByText('所得税の年分').closest('li')).toHaveTextContent('2026/01/01〜2026/12/31');
		expect(within(block).getByText('帳簿の期間').closest('li')).toHaveTextContent('2026/01/01〜2026/06/30');
		expect(within(block).getByText('消費税の課税期間').closest('li')).toHaveTextContent('2026/01/01〜2026/12/31');
	});

	it('FREQ-555-AC-07: やめた日を選び直すには理由が要り、年が変わる前かつ法人へ変える前に登録する案内が常に出る', async () => {
		const p2026 = solePeriod(2026, { endsOn: '2026-06-30', version: '4' });
		const settings = settingsOf({
			soleBusinessEndedOn: '2026-06-30',
			soleEndChanges: [{ previousEndedOn: null, newEndedOn: '2026-06-30', reason: '初めての登録', changedAt: '2026-07-02T01:00:00Z' }],
		});
		const { calls } = mockFetch((url, method) => {
			if (url.pathname === PERIODS_URL && method === 'GET') return { status: 200, body: periodsBody([p2026], settings) };
			if (url.pathname.endsWith('/final-sole')) return { status: 200, body: { data: { period: { ...p2026, endsOn: '2026-07-31', version: '5' } } } };
			return undefined;
		});
		render(<SettingsView today="2026-11-07" />);

		const section = await screen.findByRole('region', { name: '事業をやめた日' });
		expect(within(section).getByText(ALWAYS_NOTICE)).toBeInTheDocument();
		expect(within(section).queryByRole('button', { name: '事業をやめた日を登録する' })).not.toBeInTheDocument();
		fireEvent.click(within(section).getByRole('button', { name: 'やめた日を選び直す' }));

		expect(within(section).getByText('前のやめた日: 2026/06/30')).toBeInTheDocument();
		expect(within(section).getByText('縮める時は、新しいやめた日より後の日付の仕訳が無いことを確かめてください。延ばす時は同じ年の12月31日まで選べます。')).toBeInTheDocument();
		const history = within(section).getByRole('list', { name: '選び直しの記録' });
		expect(history).toHaveTextContent('なし → 2026/06/30（初めての登録）');

		fireEvent.change(within(section).getByLabelText('やめた日'), { target: { value: '2026-07-31' } });
		const submit = within(section).getByRole('button', { name: '選び直しを保存' });
		// 理由が無い間は送れない。
		expect(submit).toBeDisabled();
		fireEvent.change(within(section).getByLabelText('選び直す理由'), { target: { value: '最後の売上の日を見落としていた' } });
		expect(submit).not.toBeDisabled();
		fireEvent.click(submit);

		await waitFor(() => expect(calls.filter((call) => call.url.endsWith('/final-sole'))).toHaveLength(1));
		expect(calls.find((call) => call.url.endsWith('/final-sole'))?.body).toEqual({
			endedOn: '2026-07-31',
			expectedPeriodVersion: '4',
			expectedSettingsVersion: '3',
			reason: '最後の売上の日を見落としていた',
			requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		// 応答が期間だけでも、期間・期限・設定の版を読み直す。
		await waitFor(() => expect(calls.filter((call) => call.url === PERIODS_URL && call.method === 'GET')).toHaveLength(2));
		expect(screen.getByText(ALWAYS_NOTICE)).toBeInTheDocument();
	});

	it('FREQ-555-AC-07: 権限のある人は最後の期間をやめた日までにでき後の日の仕訳があれば理由を出して元の期間を保つ', async () => {
		const original = solePeriod(2026);
		let current = original;
		let settings = settingsOf();
		let blocked = false;
		const onChanged = jest.fn();
		const { calls } = mockFetch((url, method, body) => {
			if (url.pathname === PERIODS_URL && method === 'GET') return { status: 200, body: periodsBody([current], settings) };
			if (url.pathname === `${PERIODS_URL}/${original.id}/final-sole`) {
				if (blocked) {
					return { status: 409, body: { code: 'ACCOUNTING_PERIOD_SHORTEN_BLOCKED', error: 'やめた日を変えられません。やめた日より後の日付の仕訳が無いか確かめてください。' } };
				}
				const endedOn = (body as { endedOn: string }).endedOn;
				current = { ...original, endsOn: endedOn, version: '2' };
				settings = settingsOf({ soleBusinessEndedOn: endedOn, version: '4' });
				return { status: 200, body: { data: { period: current, periods: [current], settings } } };
			}
			return undefined;
		});
		render(<SettingsView today="2026-11-07" onChanged={onChanged} />);

		let section = await screen.findByRole('region', { name: '事業をやめた日' });
		fireEvent.click(within(section).getByRole('button', { name: '事業をやめた日を登録する' }));
		expect(within(section).getByText('今の終わり: 2026/12/31')).toBeInTheDocument();
		fireEvent.change(within(section).getByLabelText('やめた日'), { target: { value: '2026-06-30' } });
		expect(within(section).getByText('新しい終わり: 2026/06/30')).toBeInTheDocument();
		expect(within(section).getByText('短くすると、減価償却などはその月までの月割りになります。')).toBeInTheDocument();
		expect(within(section).getByText('やめた日より後の日付の仕訳があれば、先に取引の日付と期間を確かめてください。')).toBeInTheDocument();
		// 初めての登録は理由なしで送れる。
		fireEvent.click(within(section).getByRole('button', { name: '登録する' }));

		await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
		expect(calls.find((call) => call.url.endsWith('/final-sole'))?.body).toEqual({
			endedOn: '2026-06-30', expectedPeriodVersion: '1', expectedSettingsVersion: '3', reason: null,
			requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		const list = within(region('期間')).getByRole('table');
		await waitFor(() => expect(within(list).getByRole('row', { name: '2026年（個人） 2026/01/01 2026/06/30 個人' })).toBeInTheDocument());
		section = region('事業をやめた日');
		expect(within(section).getByText('やめた日より後の取引は、事業の形を法人へ切り替えるまで止まります。法人の期間へ黙って入ることはありません。')).toBeInTheDocument();

		// 選び直しで縮めようとして、後の日の仕訳があると断られる。元の期間はそのまま。
		blocked = true;
		fireEvent.click(within(section).getByRole('button', { name: 'やめた日を選び直す' }));
		fireEvent.change(within(section).getByLabelText('やめた日'), { target: { value: '2026-05-31' } });
		fireEvent.change(within(section).getByLabelText('選び直す理由'), { target: { value: '早めた' } });
		fireEvent.click(within(section).getByRole('button', { name: '選び直しを保存' }));
		expect(await within(section).findByText('やめた日を変えられません。やめた日より後の日付の仕訳が無いか確かめてください。')).toBeInTheDocument();
		expect(within(list).getByRole('row', { name: '2026年（個人） 2026/01/01 2026/06/30 個人' })).toBeInTheDocument();
		expect(onChanged).toHaveBeenCalledTimes(1);
	});

	it('FREQ-561-AC-02: 法人の期間に定額法を選ぶ届け出の期限が出る', async () => {
		const first = corporatePeriod(1, '2027-01-01', '2027-12-31');
		const second = corporatePeriod(2, '2028-01-01', '2028-12-31');
		// 期首から6か月以下の後の期間は中間申告が要らない。
		const third = corporatePeriod(3, '2029-01-01', '2029-03-31');
		mockFetch((url) => (url.pathname === PERIODS_URL
			? { status: 200, body: periodsBody([first, second, third], settingsOf({ currentBusinessType: 'corporation' })) }
			: undefined));
		render(<SettingsView today="2026-11-07" />);

		const firstBlock = await screen.findByRole('group', { name: '第1期の申告の期限' });
		// 第1期の法人税の期限 2028-02-29（火曜）。
		expect(within(firstBlock).getByText('減価償却で定額法を選ぶ届け出').closest('li')).toHaveTextContent('2028/02/29（第1期の申告の期限）');
		expect(within(firstBlock).getByText('法人税の中間申告').closest('li')).toHaveTextContent('前の期が無いため不要');
		expect(within(firstBlock).getByText('法人税の中間申告').closest('li')).toHaveTextContent('2027/08/31');
		const secondBlock = screen.getByRole('group', { name: '第2期の申告の期限' });
		expect(within(secondBlock).getByText('減価償却で定額法を選ぶ届け出').closest('li')).toHaveTextContent('2028/02/29（第1期の申告の期限）');
		expect(within(secondBlock).getByText('法人税の中間申告').closest('li')).toHaveTextContent('前の期の税額が入るまで判定できません');
		const thirdBlock = screen.getByRole('group', { name: '第3期の申告の期限' });
		expect(within(thirdBlock).getByText('法人税の中間申告').closest('li')).toHaveTextContent('期間が6か月以下のため不要');
		// 2029年の祝日の表はまだ無い。
		expect(within(thirdBlock).getByText('法人税の確定申告').closest('li')).toHaveTextContent('祝日の表がまだ無いので、休みの日の繰り下げを確かめられません');
	});

	it('FREQ-561-AC-02: 延長を入れた法人の期限には利子税の案内を出す', async () => {
		const first = corporatePeriod(1, '2027-01-01', '2027-12-31', { corporateTaxExtensionMonths: 1 });
		mockFetch((url) => (url.pathname === PERIODS_URL
			? { status: 200, body: periodsBody([first], settingsOf({ currentBusinessType: 'corporation' })) }
			: undefined));
		render(<SettingsView today="2026-11-07" />);

		const block = await screen.findByRole('group', { name: '第1期の申告の期限' });
		expect(within(block).getByText('法人税の確定申告').closest('li')).toHaveTextContent('延ばした分に利子税がかかります');
	});

	it('FREQ-561-AC-02: 免税の期間には消費税の期限が出ず、課税の期間には出る', async () => {
		const p2026 = solePeriod(2026);
		let current = p2026;
		const { calls } = mockFetch((url, method, body) => {
			if (url.pathname === PERIODS_URL && method === 'GET') return { status: 200, body: periodsBody([current], settingsOf()) };
			if (url.pathname === `${PERIODS_URL}/${p2026.id}/filing` && method === 'PUT') {
				const filing = body as { consumptionTaxStatus: 'taxable'; consumptionTaxableFrom: string };
				current = { ...p2026, consumptionTaxStatus: filing.consumptionTaxStatus, consumptionTaxableFrom: filing.consumptionTaxableFrom, version: '2' };
				return { status: 200, body: { data: { period: current } } };
			}
			return undefined;
		});
		render(<SettingsView today="2026-11-07" />);

		let block = await screen.findByRole('group', { name: '2026年（個人）の申告の期限' });
		expect(within(block).queryByText('消費税の確定申告（個人）')).not.toBeInTheDocument();
		expect(within(block).getByText('課税事業者になったら出します')).toBeInTheDocument();

		fireEvent.change(within(block).getByLabelText('消費税'), { target: { value: 'taxable' } });
		fireEvent.change(within(block).getByLabelText('課税事業者になった日'), { target: { value: '2026-01-01' } });
		fireEvent.click(within(block).getByRole('button', { name: '申告の設定を保存' }));

		await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
		expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
			corporateTaxExtensionMonths: 0,
			consumptionTaxExtensionMonths: 0,
			consumptionTaxStatus: 'taxable',
			consumptionTaxableFrom: '2026-01-01',
			expectedVersion: '1',
			requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		block = await screen.findByRole('group', { name: '2026年（個人）の申告の期限' });
		await waitFor(() => expect(within(block).getByText('消費税の確定申告（個人）')).toBeInTheDocument());
		expect(within(block).getByText('消費税の確定申告（個人）').closest('li')).toHaveTextContent('2027/03/31');
		expect(within(block).queryByText('課税事業者になったら出します')).not.toBeInTheDocument();
	});

	it('FREQ-555-AC-09: 事業の形を法人へ変える前にやめた日と確かめの案内が出て、確かめるまで送れない', async () => {
		const p2026 = solePeriod(2026, { endsOn: '2026-06-30' });
		const settings = settingsOf({ soleBusinessEndedOn: '2026-06-30' });
		const { calls } = mockFetch((url, method) => {
			if (url.pathname === PERIODS_URL) return { status: 200, body: periodsBody([p2026], settings) };
			if (url.pathname === '/api/admin/accounting/settings' && method === 'PUT') {
				return { status: 200, body: { data: { settings: { ...settings, currentBusinessType: 'corporation', version: '4' } } } };
			}
			return undefined;
		});
		render(<SettingsView today="2026-11-07" />);

		const start = await screen.findByRole('region', { name: '開業日と事業の形' });
		fireEvent.change(within(start).getByLabelText('新しい事業の形'), { target: { value: 'corporation' } });
		expect(within(start).getByText('やめた日: 2026/06/30')).toBeInTheDocument();
		expect(within(start).getByText('やめた日が正しいか確かめてから切り替えてください。切り替えた後に日を選び直しても、それまでに法人の期間へ入った取引は動きません')).toBeInTheDocument();
		const submit = within(start).getByRole('button', { name: '事業の形を変える' });
		expect(submit).toBeDisabled();
		fireEvent.click(within(start).getByLabelText('やめた日を確かめました'));
		expect(submit).not.toBeDisabled();
		fireEvent.click(submit);

		await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
		expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
			businessStartDate: null,
			currentBusinessType: 'corporation',
			expectedVersion: '3',
			requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
	});

	it('FREQ-555-AC-09: やめた日が未登録なら事業の形を法人へ変える時に先に登録する案内が出て、送れない', async () => {
		const p2026 = solePeriod(2026);
		const { calls } = mockFetch((url) => (url.pathname === PERIODS_URL ? { status: 200, body: periodsBody([p2026], settingsOf()) } : undefined));
		render(<SettingsView today="2026-11-07" />);

		const start = await screen.findByRole('region', { name: '開業日と事業の形' });
		fireEvent.change(within(start).getByLabelText('新しい事業の形'), { target: { value: 'corporation' } });
		expect(within(start).getByText('先にやめた日を登録してください')).toBeInTheDocument();
		expect(within(start).getByRole('button', { name: '事業の形を変える' })).toBeDisabled();
		expect(within(start).queryByLabelText('やめた日を確かめました')).not.toBeInTheDocument();

		// やめた日の登録へ案内する。
		fireEvent.click(within(start).getByRole('button', { name: 'やめた日の登録へ' }));
		expect(within(region('事業をやめた日')).getByLabelText('やめた日')).toBeInTheDocument();
		expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
	});
});
