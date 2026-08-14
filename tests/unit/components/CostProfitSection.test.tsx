import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CostProfitSection from '@/components/CostProfitSection';

function setupFinanceFetch(
	incomes: Array<Record<string, unknown>> = [],
	archiveHealth: Record<string, unknown> = {
		fiscalYear: 2026,
		lastArchiveAt: null,
		lastRestoreCheckAt: null,
		storageTargets: [],
		externalStorageConfigured: false,
		delayed: true,
	},
	deleteFails = false,
	statusOptions: {
		businessType?: 'soleProprietor' | 'corporation';
		revisions?: Array<Record<string, unknown>>;
		reviewAcks?: Array<Record<string, unknown>>;
		entryCategory?: string;
		postError?: { status: number; payload: Record<string, unknown> };
		cumulativeEntries?: Array<Record<string, unknown>>;
		expenses?: Array<Record<string, unknown>>;
		partners?: string[];
		templates?: Array<{ name: string; entryType: string; category: string; item: string; partner: string; amount: number; paymentMethod: string; memo: string }>;
	} = {},
) {
	const data = {
		seasonKey: '2026SS',
		businessType: statusOptions.businessType ?? 'soleProprietor',
		plan: {
			salesRevenue: 3240000,
			openingCash: 420000,
			accountsReceivable: 324000,
			fixedAssets: 260000,
			accountsPayable: 430000,
			openingCapital: 1091000,
		},
		expenses: statusOptions.expenses ?? [
			{ id: 1, entryType: 'expense', date: '2026-05-24', category: statusOptions.entryCategory ?? '販売費・マーケティング', item: 'Instagram広告費', partner: '', amount: 32000, paymentMethod: 'クレジットカード', memo: '広告' },
		] as Array<Record<string, unknown>>,
		incomes,
		cumulativeEntries: statusOptions.cumulativeEntries ?? [],
		partners: statusOptions.partners ?? [],
		templates: statusOptions.templates ?? [] as Array<{ name: string; entryType: string; category: string; item: string; partner: string; amount: number; paymentMethod: string; memo: string }>,
		summaryOptions: [{ id: 11, entryType: 'expense', name: '外注検品', isCustom: true }],
		revisions: statusOptions.revisions ?? [],
		reviewAcks: statusOptions.reviewAcks ?? [],
		products: [
			{
				id: 'LFDH-SS26-T001',
				name: 'ドローストリングシャツ',
				category: 'トップス',
				productionMethod: '国内縫製',
				plannedQuantity: 60,
				sellingPrice: 24800,
				costs: { material: 3200, sewing: 3000, pattern: 500, accessories: 800, processing: 600, finishing: 900 },
			},
		],
	};

	const mockFetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
		if (String(_input).startsWith('/api/admin/legal-archive/status')) {
			return new Response(JSON.stringify({ data: archiveHealth }), { status: 200, headers: { 'Content-Type': 'application/json' } });
		}
		if (String(_input).startsWith('/api/admin/accounting/product-costs')) {
			return new Response(JSON.stringify({
				data: {
					seasonKey: '2026SS',
					summary: {
						projectedSales: 1488000,
						directCost: 540000,
						commonCost: 0,
						unallocatedCost: 0,
						totalExpense: 540000,
						productGrossProfit: 948000,
						seasonProfit: 948000,
						seasonProfitMargin: 63.7,
						costBreakdown: { material: 540000, sewing: 0, pattern: 0, accessories: 0, processing: 0, finishing: 0, other: 0 },
					},
					expenses: [],
					items: [],
				},
			}), { status: 200, headers: { 'Content-Type': 'application/json' } });
		}
		if ((init?.method ?? 'GET') === 'POST') {
			const body = JSON.parse(String(init?.body ?? '{}'));
			if (statusOptions.postError) {
				return new Response(JSON.stringify(statusOptions.postError.payload), {
					status: statusOptions.postError.status,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (body.operation === 'expense.delete' && deleteFails) {
				return new Response(JSON.stringify({ error: '商品原価の配賦を解除してください。' }), {
					status: 409,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (body.operation === 'expense.create') {
				const entry = { id: 2, ...body.expense };
				if (body.expense.entryType === 'income') data.incomes.unshift(entry);
				else data.expenses.unshift(entry);
			}
			if (body.operation === 'evidenceUnavailable.upsert') {
				data.incomes = data.incomes.map((income) => income.id === body.expenseId
					? {
						...income,
						evidenceUnavailable: {
							reason: body.reason,
							note: body.note,
							recordedAt: '2026-08-14T01:00:00.000Z',
							updatedAt: '2026-08-14T01:00:00.000Z',
						},
					}
					: income);
			}
			if (body.operation === 'evidenceUnavailable.delete') {
				data.incomes = data.incomes.map((income) => income.id === body.expenseId
					? { ...income, evidenceUnavailable: null }
					: income);
			}
			if (body.operation === 'product.upsert') {
				data.products = data.products.map((product) => product.id === body.product.id ? body.product : product);
			}
			if (body.operation === 'expense.delete') {
				data.expenses = data.expenses.filter((expense) => expense.id !== body.expenseId);
				data.incomes = data.incomes.filter((income) => income.id !== body.expenseId);
			}
			if (body.operation === 'partner.create') {
				if (!data.partners.includes(body.partnerName)) data.partners.push(body.partnerName);
			}
			if (body.operation === 'template.create') {
				if (data.templates.some((template) => template.name === body.template.name)) {
					return new Response(JSON.stringify({ error: '同じ名前のテンプレートが存在します。' }), {
						status: 409,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				data.templates = [...data.templates.filter((t) => t.name !== body.template.name), body.template];
			}
			if (body.operation === 'template.update') {
				data.templates = data.templates.map((template) => template.name === body.templateName ? body.template : template);
			}
			if (body.operation === 'template.delete') {
				data.templates = data.templates.filter((t) => t.name !== body.templateName);
			}
			if (body.operation === 'summaryOption.create') {
				data.summaryOptions.push({ id: 12, entryType: body.entryType, name: body.name.trim(), isCustom: true });
			}
			if (body.operation === 'summaryOption.delete') {
				data.summaryOptions = data.summaryOptions.filter((option) => option.id !== body.summaryOptionId);
			}
			return new Response(JSON.stringify({
				success: true,
				...(body.operation === 'expense.create' ? { resourceId: '2' } : {}),
			}), { status: 200, headers: { 'Content-Type': 'application/json' } });
		}
		return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	});
	global.fetch = mockFetch as unknown as typeof fetch;
	return mockFetch;
}

describe('CostProfitSection', () => {
	// ACCOUNTING の全サブタブを1コンポーネントで描くため、1回の render が重い。
	// 単体では各テスト1秒前後で終わるが、全スイート並列実行の負荷下では
	// 既定の5秒を超えることがあるので、この describe だけ上限を上げる。
	jest.setTimeout(30000);

	it('月次累積収支推移は科目選択と独立して全取引の累積値を表示する', async () => {
		setupFinanceFetch([], undefined, false, {
			cumulativeEntries: [
				{ id: 1, entryType: 'income', date: '2025-12-20', category: '売上高', item: '前年売上', partner: '', amount: 100000, paymentMethod: '銀行', memo: '' },
				{ id: 2, entryType: 'expense', date: '2025-12-25', category: '広告宣伝費', item: '前年広告', partner: '', amount: 30000, paymentMethod: 'クレジットカード', memo: '' },
				{ id: 3, entryType: 'income', date: '2026-01-10', category: '売上高', item: '当年売上', partner: '', amount: 20000, paymentMethod: '現金', memo: '' },
				{ id: 4, entryType: 'expense', date: '2026-03-15', category: '旅費交通費', item: '当年交通費', partner: '', amount: 5000, paymentMethod: 'プライベート', memo: '' },
			],
		});
		const { rerender } = render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '帳簿' }));

		const trend = await screen.findByRole('region', { name: '月次累積収支推移' });
		expect(within(trend).getByRole('img', { name: '2026年の月次累積収支推移' })).toBeInTheDocument();
		const accessibleTable = within(trend).getByRole('table', { name: '月次累積収支推移の月別累積収支' });
		expect(accessibleTable).toHaveTextContent('1月¥90,000');
		expect(accessibleTable).toHaveTextContent('3月¥85,000');
		expect(within(trend).getByRole('img', { name: '2026年の月次累積収支推移' })).toHaveAttribute('aria-describedby', 'cumulative-balance-trend-2026-table');
		for (const [label, value] of [
			['期首残高', '¥70,000'],
			['当年収入', '¥20,000'],
			['当年支出', '¥5,000'],
			['当年末残高', '¥85,000'],
		] as const) {
			const summary = within(trend).getByText(label).parentElement;
			expect(summary).toHaveTextContent(`${label}${value}`);
		}
		expect(within(trend).getByText('取引管理に入力した全収入・全支出による管理指標です。現金預金・利益・純資産・科目別元帳の残高ではありません。')).toBeInTheDocument();
		const trendTextBeforeAccountSelection = trend.textContent;

		const accountTree = screen.getByRole('region', { name: '勘定科目' });
		fireEvent.click(within(accountTree).getByRole('button', { name: /販売費・マーケティング/ }));

		expect(trend).toHaveTextContent(trendTextBeforeAccountSelection ?? '');
		const journalList = screen.getByRole('region', { name: '仕訳一覧' });
		expect(within(journalList).getByText('Instagram広告費')).toBeInTheDocument();
		expect(screen.getByRole('region', { name: '照合結果' })).toHaveTextContent('販売費・マーケティング');

		rerender(<CostProfitSection fiscalYear={2025} fiscalYearLabel="2025年" />);
		const priorYearTrend = await screen.findByRole('region', { name: '月次累積収支推移' });
		expect(within(priorYearTrend).getByRole('img', { name: '2025年の月次累積収支推移' })).toBeInTheDocument();
		expect(within(priorYearTrend).getByText('当年末残高').parentElement).toHaveTextContent('¥70,000');
	});

	beforeEach(() => {
		setupFinanceFetch();
	});

	it('手動収入の証憑添付不可理由を記録して解除できる', async () => {
		const mockFetch = setupFinanceFetch([
			{
				id: 2,
				entryType: 'income',
				date: '2026-05-25',
				category: '売上高',
				item: '銀行振込売上',
				partner: '取引先A',
				amount: 120000,
				paymentMethod: '普通預金',
				memo: '',
				receipts: [],
			},
		]);
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);

		fireEvent.click(await screen.findByRole('tab', { name: '取引管理' }));
		fireEvent.click(await screen.findByRole('button', { name: '銀行振込売上の証憑' }));
		fireEvent.click(screen.getByRole('button', { name: '証憑添付不可' }));
		fireEvent.click(screen.getByRole('button', { name: '添付できない理由' }));
		fireEvent.click(screen.getByRole('option', { name: '銀行の閲覧期限超過' }));
		expect(screen.getByRole('button', { name: '理由を保存' })).toBeDisabled();

		fireEvent.change(screen.getByLabelText('補足メモ'), {
			target: { value: '銀行へ過去明細を照会したが取得できず' },
		});
		fireEvent.click(screen.getByRole('button', { name: '理由を保存' }));

		await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
			'/api/admin/kpi/cost-profit',
			expect.objectContaining({
				method: 'POST',
				body: expect.stringContaining('evidenceUnavailable.upsert'),
			}),
		));
		expect((await screen.findAllByText('理由記録済み')).length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole('button', { name: '未添付に戻す' }));
		await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
			'/api/admin/kpi/cost-profit',
			expect.objectContaining({
				method: 'POST',
				body: expect.stringContaining('evidenceUnavailable.delete'),
			}),
		));
	});

	it('財務概要で借入先別と支払先別の累計・決済・残高を確認できる', async () => {
		const loan = { id: 10, entryType: 'income', date: '2026-03-01', category: '役員借入金', item: '運転資金', partner: '山田太郎', amount: 1_000_000, paymentMethod: '銀行', memo: '' };
		const repayment = { id: 11, entryType: 'expense', date: '2026-08-01', category: '役員借入金', item: '一部返済', partner: '山田太郎', amount: 300_000, paymentMethod: '銀行', memo: '' };
		const payable = { id: 12, entryType: 'expense', date: '2026-07-01', category: '仕入高', item: '生地仕入', partner: '生地商店', amount: 120_000, paymentMethod: '買掛金', memo: '' };
		setupFinanceFetch([loan], undefined, false, {
			businessType: 'corporation',
			expenses: [repayment, payable],
			cumulativeEntries: [loan, repayment, payable],
		});

		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		const funding = screen.getByRole('region', { name: '借入・事業主資金' });
		expect(within(funding).getByRole('table', { name: '借入・事業主資金' })).toBeInTheDocument();
		expect(within(funding).getByText('山田太郎')).toBeInTheDocument();
		expect(within(funding).getAllByText('¥1,000,000').length).toBeGreaterThan(0);
		expect(within(funding).getAllByText('¥300,000').length).toBeGreaterThan(0);
		expect(within(funding).getAllByText('¥700,000').length).toBeGreaterThan(0);

		const payables = screen.getByRole('region', { name: 'その他の支払債務' });
		expect(within(payables).getByText('生地商店')).toBeInTheDocument();
		expect(within(payables).getAllByText('買掛金').length).toBeGreaterThan(0);
	});

	it('orders由来の収入を連携済みとして表示し、訂正操作を提供しない', async () => {
		setupFinanceFetch([{
			id: -1,
			entryType: 'income',
			date: '2026-08-01',
			category: '売上高',
			item: 'オンライン注文',
			partner: '購入者',
			amount: 24800,
			paymentMethod: 'Stripe',
			memo: '注文 #order-1',
			source: 'order',
			sourceId: 'order-1',
			readOnly: true,
			grossAmount: 25300,
			refundedAmount: 500,
		}]);

		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));

		expect(await screen.findByText('Supabase注文')).toBeInTheDocument();
		expect(screen.getByText('返金 ¥500')).toBeInTheDocument();
		expect(screen.getByText('注文データ保存済み')).toBeInTheDocument();
		expect(screen.getByRole('tab', { name: '証憑未添付（1）' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'オンライン注文の証憑' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'オンライン注文を訂正' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'オンライン注文を編集' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'オンライン注文を削除' })).not.toBeInTheDocument();
	});

	it('摘要プルダウンの先頭から共有候補を追加できる', async () => {
		const fetchMock = setupFinanceFetch();
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		fireEvent.click(await screen.findByRole('tab', { name: '取引管理' }));
		fireEvent.click(screen.getByRole('button', { name: '新規取引' }));

		const summary = screen.getByRole('button', { name: '支出摘要' });
		fireEvent.click(summary);
		const options = screen.getAllByRole('option');
		expect(options[0]).toHaveTextContent('＋ 新しい項目を追加');
		fireEvent.click(options[0]);
		fireEvent.change(screen.getByRole('textbox', { name: '新しい支出摘要' }), { target: { value: ' 撮影立会費 ' } });
		fireEvent.click(screen.getByRole('button', { name: '支出摘要を保存' }));

		expect(await screen.findByRole('button', { name: '支出摘要' })).toHaveTextContent('撮影立会費');
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/admin/kpi/cost-profit',
			expect.objectContaining({ body: expect.stringContaining('summaryOption.create') }),
		);
	});

	it('ユーザー追加摘要には削除アクションを表示する', async () => {
		setupFinanceFetch();
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		fireEvent.click(await screen.findByRole('tab', { name: '取引管理' }));
		fireEvent.click(screen.getByRole('button', { name: '新規取引' }));
		fireEvent.click(screen.getByRole('button', { name: '支出摘要' }));

		expect(screen.getByRole('button', { name: '外注検品を削除' })).toBeInTheDocument();
	});

	it('手動取引の操作列から編集Drawerを開く', async () => {
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));

		expect(screen.getByRole('columnheader', { name: '操作' })).toBeInTheDocument();
		expect(screen.getByText('Instagram広告費').closest('button')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Instagram広告費を編集' }));

		const drawerHeading = await screen.findByRole('heading', { name: '支出を訂正（#1）' });
		expect(drawerHeading).toBeInTheDocument();
		expect(
			drawerHeading.closest('[data-ui-drawer]')?.querySelector('[aria-label="Instagram広告費を削除"]'),
		).toBeNull();
	});

	it('削除アイコンは確認後にだけ取引を論理削除する', async () => {
		const mockFetch = setupFinanceFetch();
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));

		fireEvent.click(screen.getByRole('button', { name: 'Instagram広告費を削除' }));
		expect(screen.getByRole('dialog', { name: '取引を削除' })).toHaveTextContent('Instagram広告費');
		expect(mockFetch).not.toHaveBeenCalledWith(
			'/api/admin/kpi/cost-profit',
			expect.objectContaining({ method: 'POST', body: expect.stringContaining('"operation":"expense.delete"') }),
		);

		fireEvent.click(screen.getByRole('button', { name: '削除を確定' }));
		await waitFor(() => expect(screen.queryByText('Instagram広告費')).not.toBeInTheDocument());
		expect(mockFetch).toHaveBeenCalledWith(
			'/api/admin/kpi/cost-profit',
			expect.objectContaining({ method: 'POST', body: expect.stringContaining('"operation":"expense.delete"') }),
		);
	});

	it('削除確認をキャンセルすると取引を残す', async () => {
		const mockFetch = setupFinanceFetch();
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));

		fireEvent.click(screen.getByRole('button', { name: 'Instagram広告費を削除' }));
		fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

		expect(screen.getByRole('button', { name: 'Instagram広告費を編集' })).toBeInTheDocument();
		expect(screen.queryByRole('dialog', { name: '取引を削除' })).not.toBeInTheDocument();
		expect(mockFetch).not.toHaveBeenCalledWith(
			'/api/admin/kpi/cost-profit',
			expect.objectContaining({ method: 'POST', body: expect.stringContaining('"operation":"expense.delete"') }),
		);
	});

	it('削除確認はキーボードフォーカスを管理する', async () => {
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		const deleteButton = screen.getByRole('button', { name: 'Instagram広告費を削除' });

		deleteButton.focus();
		fireEvent.click(deleteButton);
		await waitFor(() => expect(screen.getByRole('button', { name: '削除を確定' })).toHaveFocus());
		fireEvent.keyDown(document, { key: 'Escape' });

		await waitFor(() => expect(deleteButton).toHaveFocus());
	});

	it('削除に失敗すると行を復元して確認ダイアログに理由を表示する', async () => {
		setupFinanceFetch([], undefined, true);
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));

		fireEvent.click(screen.getByRole('button', { name: 'Instagram広告費を削除' }));
		fireEvent.click(screen.getByRole('button', { name: '削除を確定' }));

		const deleteDialog = await screen.findByRole('dialog', { name: '取引を削除' });
		await waitFor(() =>
			expect(deleteDialog.querySelector('[role="alert"]')).toHaveTextContent('商品原価の配賦を解除してください。'),
		);
		expect(screen.getByRole('button', { name: 'Instagram広告費を編集' })).toBeInTheDocument();
		expect(deleteDialog).toBeInTheDocument();
	});

	it('アーカイブの準備状態と外部保存先の未設定を表示する', async () => {
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		fireEvent.click(await screen.findByRole('tab', { name: '取引管理' }));
		expect(await screen.findByText('保存要件整備中')).toBeInTheDocument();
		expect(screen.getByText('外部保存先 未設定')).toBeInTheDocument();
	});

	it('24時間以内の保存と復元確認があればアーカイブ済みを表示する', async () => {
		setupFinanceFetch([], {
			fiscalYear: 2026,
			lastArchiveAt: '2026-08-10T00:00:00.000Z',
			lastRestoreCheckAt: '2026-08-02T00:00:00.000Z',
			storageTargets: ['supabase', 'external-s3'],
			externalStorageConfigured: true,
			delayed: false,
		});
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		fireEvent.click(await screen.findByRole('tab', { name: '取引管理' }));
		const archiveStatus = await screen.findByText('注文データ保存済み');
		expect(archiveStatus.closest('[role="status"]')).toHaveTextContent('注文データ保存済み');
		expect(screen.queryByText('外部保存先 未設定')).not.toBeInTheDocument();
	});

	it('財務3表と青色申告向けのサブタブを表示する', async () => {
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		expect(screen.getByText('損益計算書（P/L）')).toBeInTheDocument();
		expect(screen.getByText('貸借対照表（B/S）')).toBeInTheDocument();
		expect(screen.getByText('キャッシュ・フロー計算書（C/F）')).toBeInTheDocument();
		expect(screen.getByRole('tab', { name: '帳簿' })).toBeInTheDocument();
		expect(screen.getByRole('tab', { name: '商品原価' })).toBeInTheDocument();
		expect(screen.getByRole('tab', { name: '税務レポート' })).toBeInTheDocument();
	});

	it('登録した経費を一覧と仕訳帳へ反映する', async () => {
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		// FREQ-257 以降、取引の入力欄は「新規取引」Drawer の中にある。
		fireEvent.click(screen.getByRole('button', { name: '新規取引' }));
		// 支出概要は黄金比UIの SingleSelect（dropdown）。トリガーを開いて選択肢を押す。
		fireEvent.click(screen.getByRole('button', { name: '支出摘要' }));
		fireEvent.click(screen.getByRole('option', { name: '展示会・イベント' }));
		fireEvent.click(screen.getByRole('button', { name: '勘定科目' }));
		fireEvent.click(screen.getByRole('option', { name: '経費 / 広告宣伝費' }));
		fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '45000' } });
		fireEvent.click(screen.getByRole('button', { name: '保存' }));

		expect(await screen.findByText('支出を保存し、仕訳帳と財務概要へ反映しました。')).toBeInTheDocument();

		// 帳簿タブでは摘要が仕訳一覧と仕訳詳細の両方に出るため、件数で確認する。
		fireEvent.click(screen.getByRole('tab', { name: '帳簿' }));
		expect(screen.getAllByText('展示会・イベント').length).toBeGreaterThan(0);
	});

	it('取引先を新規登録して選択肢に追加する', async () => {
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		// FREQ-257 以降、取引の入力欄は「新規取引」Drawer の中にある。
		fireEvent.click(screen.getByRole('button', { name: '新規取引' }));
		// 取引先も SingleSelect（dropdown）。開いて「＋新規登録」を選ぶ。
		fireEvent.click(screen.getByRole('button', { name: '取引先' }));
		fireEvent.click(screen.getByRole('option', { name: '＋ 新規登録' }));
		fireEvent.change(screen.getByPlaceholderText('取引先名を入力'), { target: { value: '丸善テキスタイル' } });
		fireEvent.click(screen.getByRole('button', { name: '登録' }));

		expect(await screen.findByText('取引先を登録しました。')).toBeInTheDocument();
		// 登録後に取引先ドロップダウンを開き直すと、選択肢に追加されている。
		fireEvent.click(screen.getByRole('button', { name: '取引先' }));
		expect(await screen.findByRole('option', { name: '丸善テキスタイル' })).toBeInTheDocument();
	});

	it('入力をテンプレート保存し、選択して経費フォームへ反映する', async () => {
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		// FREQ-257 以降、取引の入力欄は「新規取引」Drawer の中にある。
		fireEvent.click(screen.getByRole('button', { name: '新規取引' }));

		// 支出概要と金額を入力してからテンプレート保存。
		fireEvent.click(screen.getByRole('button', { name: '支出摘要' }));
		fireEvent.click(screen.getByRole('option', { name: '縫製外注' }));
		fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '50000' } });

		fireEvent.click(screen.getByRole('button', { name: 'テンプレート' }));
		fireEvent.click(screen.getByRole('option', { name: '＋ 現在の入力を保存' }));

		// 名前の初期値は「支出概要 / 金額」。
		const nameInput = screen.getByPlaceholderText('テンプレート名') as HTMLInputElement;
		expect(nameInput.value).toBe('縫製外注 / ¥50,000');
		fireEvent.compositionStart(nameInput);
		fireEvent.change(nameInput, { target: { value: '縫製外注（定番）' } });
		fireEvent.keyDown(nameInput, { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
		fireEvent.compositionEnd(nameInput, { data: '定番' });

		expect(screen.getByPlaceholderText('テンプレート名')).toHaveValue('縫製外注（定番）');
		expect(screen.getByRole('button', { name: 'テンプレートを保存' })).toBeVisible();
		fireEvent.click(screen.getByRole('button', { name: 'テンプレートを保存' }));

		expect(await screen.findByText('テンプレートを保存しました。')).toBeInTheDocument();

		// 別の支出概要へ変更してから、テンプレートを選び直すと支出概要・金額が戻る。
		fireEvent.click(screen.getByRole('button', { name: '支出摘要' }));
		fireEvent.click(screen.getByRole('option', { name: '広告出稿' }));

		fireEvent.click(screen.getByRole('button', { name: 'テンプレート' }));
		fireEvent.click(await screen.findByRole('option', { name: '縫製外注（定番）' }));

		expect(screen.getByRole('button', { name: '支出摘要' })).toHaveTextContent('縫製外注');
		expect((screen.getByPlaceholderText('0') as HTMLInputElement).value).toBe('50000');
	});

	it('テンプレート名の未保存中は閉じる前に確認し、入力を保持または破棄できる', async () => {
		const mockFetch = setupFinanceFetch();
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		fireEvent.click(screen.getByRole('button', { name: '新規取引' }));
		fireEvent.click(screen.getByRole('button', { name: '収入', pressed: false }));
		fireEvent.click(screen.getByRole('button', { name: 'テンプレート' }));
		fireEvent.click(screen.getByRole('option', { name: '＋ 現在の入力を保存' }));

		const nameInput = screen.getByPlaceholderText('テンプレート名');
		fireEvent.compositionStart(nameInput);
		fireEvent.change(nameInput, { target: { value: '月次の外注費' } });
		fireEvent.keyDown(nameInput, {
			key: 'Enter',
			code: 'Enter',
			keyCode: 229,
			isComposing: true,
		});
		fireEvent.compositionEnd(nameInput, { data: '外注費' });

		expect(screen.getByPlaceholderText('テンプレート名')).toHaveValue('月次の外注費');
		expect(
			mockFetch.mock.calls.some(([, init]) =>
				String((init as RequestInit | undefined)?.body).includes('"operation":"template.create"'),
			),
		).toBe(false);

		fireEvent.click(screen.getByRole('button', { name: '取引の入力を閉じる' }));
		expect(screen.getByRole('dialog', { name: '未保存のテンプレートがあります' })).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole('button', { name: '入力を続ける' })).toHaveFocus());
		fireEvent.keyDown(document, { key: 'Escape' });
		await waitFor(() => expect(screen.getByPlaceholderText('テンプレート名')).toHaveFocus());
		expect(screen.getByPlaceholderText('テンプレート名')).toHaveValue('月次の外注費');

		fireEvent.click(screen.getByRole('button', { name: '取引の入力を閉じる' }));
		fireEvent.click(screen.getByRole('button', { name: '入力を続ける' }));
		expect(screen.getByPlaceholderText('テンプレート名')).toHaveValue('月次の外注費');

		const entryDialog = screen.getByRole('dialog');
		const drawerOverlay = entryDialog.parentElement;
		expect(drawerOverlay).not.toBeNull();
		fireEvent.click(drawerOverlay!);
		expect(screen.getByRole('dialog', { name: '未保存のテンプレートがあります' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: '入力を続ける' }));
		expect(screen.getByPlaceholderText('テンプレート名')).toHaveValue('月次の外注費');

		const cancelButtons = screen.getAllByRole('button', { name: '取消' });
		fireEvent.click(cancelButtons[cancelButtons.length - 1]);
		expect(screen.getByRole('dialog', { name: '未保存のテンプレートがあります' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: '破棄して閉じる' }));
		expect(screen.queryByPlaceholderText('テンプレート名')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: '取引の入力を閉じる' })).not.toBeInTheDocument();
	});

	it('選択したテンプレートの変更を確認後に上書きする', async () => {
		const mockFetch = setupFinanceFetch([], undefined, false, {
			partners: ['旧取引先', '新取引先'],
			templates: [{ name: '毎月の家賃', entryType: 'expense', category: '地代家賃', item: '打合せ・交通', partner: '旧取引先', amount: 80000, paymentMethod: '銀行', memo: '事務所' }],
		});
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		fireEvent.click(screen.getByRole('button', { name: '新規取引' }));
		fireEvent.click(screen.getByRole('button', { name: 'テンプレート' }));
		fireEvent.click(screen.getByRole('option', { name: '毎月の家賃' }));
		fireEvent.click(screen.getByRole('button', { name: '取引先' }));
		fireEvent.click(screen.getByRole('option', { name: '新取引先' }));
		fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '85000' } });

		fireEvent.click(screen.getByRole('button', { name: '変更を上書き' }));
		expect(screen.getByRole('dialog', { name: 'テンプレートの変更を上書き' })).toHaveTextContent('毎月の家賃');
		expect(mockFetch.mock.calls.some(([, init]) => String((init as RequestInit | undefined)?.body).includes('template.update'))).toBe(false);

		fireEvent.click(screen.getByRole('button', { name: '上書きを確定' }));
		expect(await screen.findByText('テンプレートを上書きしました。')).toBeInTheDocument();
		expect(mockFetch.mock.calls.some(([, init]) => {
			const body = String((init as RequestInit | undefined)?.body);
			return body.includes('template.update') && body.includes('"partner":"新取引先"') && body.includes('"amount":85000');
		})).toBe(true);
	});

	it('上書き確認を取り消すと変更内容を保持する', async () => {
		setupFinanceFetch([], undefined, false, {
			templates: [{ name: '毎月の家賃', entryType: 'expense', category: '地代家賃', item: '打合せ・交通', partner: '', amount: 80000, paymentMethod: '銀行', memo: '事務所' }],
		});
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		fireEvent.click(screen.getByRole('button', { name: '新規取引' }));
		fireEvent.click(screen.getByRole('button', { name: 'テンプレート' }));
		fireEvent.click(screen.getByRole('option', { name: '毎月の家賃' }));
		fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '85000' } });

		fireEvent.click(screen.getByRole('button', { name: '変更を上書き' }));
		fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

		expect(screen.queryByRole('dialog', { name: 'テンプレートの変更を上書き' })).not.toBeInTheDocument();
		expect(screen.getByPlaceholderText('0')).toHaveValue(85000);
	});

	it('選択したテンプレートを別名で保存し、既存名への保存は拒否する', async () => {
		const mockFetch = setupFinanceFetch([], undefined, false, {
			templates: [{ name: '毎月の家賃', entryType: 'expense', category: '地代家賃', item: '打合せ・交通', partner: '', amount: 80000, paymentMethod: '銀行', memo: '事務所' }],
		});
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		fireEvent.click(screen.getByRole('button', { name: '新規取引' }));
		fireEvent.click(screen.getByRole('button', { name: 'テンプレート' }));
		fireEvent.click(screen.getByRole('option', { name: '毎月の家賃' }));
		fireEvent.click(screen.getByRole('button', { name: '別名で保存' }));

		const nameInput = screen.getByRole('textbox', { name: 'テンプレート名' });
		expect(nameInput).toHaveValue('毎月の家賃');
		fireEvent.click(screen.getByRole('button', { name: 'テンプレートを保存' }));
		expect(await screen.findByText('同じ名前のテンプレートが存在します。')).toBeInTheDocument();
		expect(mockFetch.mock.calls.filter(([, init]) => String((init as RequestInit | undefined)?.body).includes('template.create'))).toHaveLength(0);

		fireEvent.change(nameInput, { target: { value: '毎月の家賃（増額後）' } });
		fireEvent.click(screen.getByRole('button', { name: 'テンプレートを保存' }));
		expect(await screen.findByText('テンプレートを保存しました。')).toBeInTheDocument();
		expect(mockFetch.mock.calls.some(([, init]) => String((init as RequestInit | undefined)?.body).includes('毎月の家賃（増額後）'))).toBe(true);
	});

	it.each([
		[{ status: 403, payload: { reason: 'CSRF validation failed' } }, 'セキュリティ確認に失敗しました。ページを再読み込みして、もう一度保存してください。'],
		[{ status: 403, payload: { reason: 'MFA required' } }, '保存には2要素認証が必要です。認証画面で2FAを完了してから、もう一度保存してください。'],
		[{ status: 403, payload: { permission: 'admin.finance.manage' } }, '会計データの保存には財務管理権限が必要です。'],
	] as const)('取引先登録の403理由に応じた案内を表示する', async (postError, message) => {
		setupFinanceFetch([], undefined, false, { postError });
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		fireEvent.click(screen.getByRole('button', { name: '新規取引' }));
		fireEvent.click(screen.getByRole('button', { name: '取引先' }));
		fireEvent.click(screen.getByRole('option', { name: '＋ 新規登録' }));
		fireEvent.change(screen.getByPlaceholderText('取引先名を入力'), { target: { value: '新規取引先' } });
		fireEvent.click(screen.getByRole('button', { name: '登録' }));

		expect(await screen.findByText(message)).toBeInTheDocument();
	});

	it('テンプレート名の取消では取引Drawerを閉じない', async () => {
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		fireEvent.click(screen.getByRole('button', { name: '新規取引' }));
		fireEvent.click(screen.getByRole('button', { name: 'テンプレート' }));
		fireEvent.click(screen.getByRole('option', { name: '＋ 現在の入力を保存' }));
		fireEvent.change(screen.getByPlaceholderText('テンプレート名'), {
			target: { value: '保存しない名前' },
		});

		const cancelButtons = screen.getAllByRole('button', { name: '取消' });
		fireEvent.click(cancelButtons[0]);

		expect(screen.queryByPlaceholderText('テンプレート名')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: '取引の入力を閉じる' })).toBeInTheDocument();
		expect(screen.queryByRole('dialog', { name: '未保存のテンプレートがあります' })).not.toBeInTheDocument();
	});

	it('商品原価タブで新しい配賦モデルのシーズン概要を表示する', async () => {
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		fireEvent.click(screen.getByRole('tab', { name: '商品原価' }));

		expect(await screen.findByRole('region', { name: '商品原価' })).toBeInTheDocument();
		expect(screen.getByRole('tab', { name: 'シーズン概要' })).toBeInTheDocument();
		expect(screen.getAllByText('売上見込み')).toHaveLength(2);
	});

	it('行末の削除ボタンで経費をSupabaseから削除する', async () => {
		const mockFetch = setupFinanceFetch();
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		fireEvent.click(screen.getByRole('button', { name: 'Instagram広告費を削除' }));
		fireEvent.click(screen.getByRole('button', { name: '削除を確定' }));

		await waitFor(() => expect(screen.queryByText('Instagram広告費')).not.toBeInTheDocument());
		expect(await screen.findByText('支出をSupabaseから削除しました。')).toBeInTheDocument();
		expect(mockFetch).toHaveBeenCalledWith(
			'/api/admin/kpi/cost-profit',
			expect.objectContaining({
				method: 'POST',
				body: expect.stringContaining('"operation":"expense.delete"'),
			}),
		);
	});

	it('種別を収入に切り替えて収入を登録し、収入一覧へ反映する', async () => {
		const mockFetch = setupFinanceFetch();
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		// FREQ-257 以降、取引の入力欄は「新規取引」Drawer の中にある。
		fireEvent.click(screen.getByRole('button', { name: '新規取引' }));

		// 種別トグルを「収入」に。
		fireEvent.click(screen.getByRole('button', { name: '収入', pressed: false }));

		// 収入時は「収入概要」ラベルになり、収入用の選択肢が選べる。
		expect(screen.getByRole('button', { name: '収入摘要' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: '収入摘要' }));
		fireEvent.click(screen.getByRole('option', { name: 'オンライン販売' }));
		fireEvent.click(screen.getByRole('button', { name: '勘定科目' }));
		fireEvent.click(screen.getByRole('option', { name: '売上（収入）金額 / 売上高' }));
		fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '120000' } });
		fireEvent.click(screen.getByRole('button', { name: '証憑添付不可' }));
		fireEvent.click(screen.getByRole('button', { name: '添付できない理由' }));
		fireEvent.click(screen.getByRole('option', { name: '証憑が発行されていない' }));
		fireEvent.click(screen.getByRole('button', { name: '保存' }));

		expect(await screen.findByText('収入を保存し、仕訳帳と財務概要へ反映しました。')).toBeInTheDocument();

		// entryType=income のPOSTが送られる。
		expect(mockFetch).toHaveBeenCalledWith(
			'/api/admin/kpi/cost-profit',
			expect.objectContaining({ method: 'POST', body: expect.stringContaining('"entryType":"income"') }),
		);
		expect(mockFetch).toHaveBeenCalledWith(
			'/api/admin/kpi/cost-profit',
			expect.objectContaining({
				method: 'POST',
				body: expect.stringContaining('evidenceUnavailable.upsert'),
			}),
		);

		// 統合された一覧に、既存の支出1件と登録した収入1件が並ぶ。
		expect(await screen.findByText('1-2 / 2件')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'オンライン販売を編集' })).toBeInTheDocument();
	});

	it('テンプレートは支出・収入で別管理される', async () => {
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		// FREQ-257 以降、取引の入力欄は「新規取引」Drawer の中にある。
		fireEvent.click(screen.getByRole('button', { name: '新規取引' }));

		// 支出のテンプレートを1件作る。
		fireEvent.click(screen.getByRole('button', { name: '支出摘要' }));
		fireEvent.click(screen.getByRole('option', { name: '縫製外注' }));
		fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '50000' } });
		fireEvent.click(screen.getByRole('button', { name: 'テンプレート' }));
		fireEvent.click(screen.getByRole('option', { name: '＋ 現在の入力を保存' }));
		fireEvent.change(screen.getByPlaceholderText('テンプレート名'), { target: { value: '縫製外注（支出）' } });
		fireEvent.click(screen.getByRole('button', { name: 'テンプレートを保存' }));
		expect(await screen.findByText('テンプレートを保存しました。')).toBeInTheDocument();

		// 支出テンプレートは支出のプルダウンに出る。
		fireEvent.click(screen.getByRole('button', { name: 'テンプレート' }));
		expect(await screen.findByRole('option', { name: '縫製外注（支出）' })).toBeInTheDocument();
		// ドロップダウンを閉じる。
		fireEvent.click(screen.getByRole('option', { name: '（テンプレートを選択）' }));

		// 収入へ切替すると、支出テンプレートは選択肢に出ない。
		fireEvent.click(screen.getByRole('button', { name: '収入', pressed: false }));
		fireEvent.click(screen.getByRole('button', { name: 'テンプレート' }));
		expect(screen.queryByRole('option', { name: '縫製外注（支出）' })).not.toBeInTheDocument();
	});

	it('法人の訂正取引は訂正内容を確認するまで要確認になる', async () => {
		setupFinanceFetch([], undefined, false, {
			businessType: 'corporation',
			entryCategory: '広告宣伝費',
			revisions: [{
				id: 1,
				entryId: 1,
				operation: 'update',
				before: { date: '2026-05-24', category: '広告宣伝費', item: '広告費', partner: '', amount: '30000' },
				after: { date: '2026-05-24', category: '販売費・マーケティング', item: 'Instagram広告費', partner: '', amount: '32000' },
				changedAt: '2026-08-12T00:00:00.000Z',
			}],
		});
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));

		const row = screen.getByText('Instagram広告費').closest('tr');
		expect(row).not.toBeNull();
		expect(within(row!).getByText('要確認')).toBeInTheDocument();
		fireEvent.click(within(row!).getByRole('button', { name: /要確認の理由を開く/ }));
		expect(screen.getByText('訂正内容の確認')).toBeInTheDocument();
	});

	it('法人の訂正確認が完了していれば登録済みになる', async () => {
		setupFinanceFetch([], undefined, false, {
			businessType: 'corporation',
			entryCategory: '広告宣伝費',
			revisions: [{ id: 1, entryId: 1, operation: 'update', before: { date: '2026-05-24', category: '広告宣伝費', item: '広告費', partner: '', amount: '30000' }, after: { date: '2026-05-24', category: '販売費・マーケティング', item: 'Instagram広告費', partner: '', amount: '32000' }, changedAt: '2026-08-12T00:00:00.000Z' }],
			reviewAcks: [{ entryRef: 'entry:1', reason: 'revisedEntry', note: '', reviewedAt: '2026-08-12T01:00:00.000Z' }],
		});
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));

		const row = screen.getByText('Instagram広告費').closest('tr');
		expect(row).not.toBeNull();
		expect(within(row!).getByText('登録済み')).toBeInTheDocument();
	});

	it('個人事業主の訂正取引は他に問題がなければ登録済みになる', async () => {
		setupFinanceFetch([], undefined, false, {
			businessType: 'soleProprietor',
			entryCategory: '広告宣伝費',
			revisions: [{ id: 1, entryId: 1, operation: 'update', before: { date: '2026-05-24', category: '広告宣伝費', item: '広告費', partner: '', amount: '30000' }, after: { date: '2026-05-24', category: '販売費・マーケティング', item: 'Instagram広告費', partner: '', amount: '32000' }, changedAt: '2026-08-12T00:00:00.000Z' }],
		});
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));

		const row = screen.getByText('Instagram広告費').closest('tr');
		expect(row).not.toBeNull();
		expect(within(row!).getByText('登録済み')).toBeInTheDocument();
	});

	it('取引一覧で摘要と取引先を独立列にして全文を非折り返し表示する', async () => {
		setupFinanceFetch([], undefined, false, {
			expenses: [{
				id: 1,
				entryType: 'expense',
				date: '2026-05-24',
				category: '外注工賃',
				item: 'サンプル制作と最終仕様確認',
				partner: '丸善テキスタイル株式会社',
				amount: 73_145,
				paymentMethod: '銀行',
				memo: '',
			}],
		});

		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));

		const summaryHeader = screen.getByRole('columnheader', { name: '摘要' });
		const table = summaryHeader.closest('table');
		expect(table).not.toBeNull();
		expect(within(table!).getByRole('columnheader', { name: '取引先' })).toBeInTheDocument();
		expect(within(table!).queryByRole('columnheader', { name: '摘要・取引先' })).not.toBeInTheDocument();

		const summary = within(table!).getByText('サンプル制作と最終仕様確認');
		const partner = within(table!).getByText('丸善テキスタイル株式会社');
		expect(summary.closest('td')).not.toBe(partner.closest('td'));
		expect(summary.closest('td')).toHaveClass('whitespace-nowrap');
		expect(partner.closest('td')).toHaveClass('whitespace-nowrap');
		expect(summary).not.toHaveClass('truncate');
		expect(partner).not.toHaveClass('truncate');
		expect(table).toHaveClass('min-w-max', '!table-auto', '[&_td]:whitespace-nowrap');
		expect(table!.parentElement).toHaveClass('[--pad-x:calc(var(--table-font-size)/var(--phi))]');
	});

	it('取引一覧で取引先未設定と注文補足を省略せず表示する', async () => {
		setupFinanceFetch([{
			id: -1,
			entryType: 'income',
			date: '2026-08-01',
			category: '売上高',
			item: 'オンラインストア注文 #1001',
			partner: '',
			amount: 73_145,
			refundedAmount: 5_000,
			paymentMethod: 'Stripe',
			memo: '',
			source: 'order',
			readOnly: true,
		}]);

		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');
		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));

		const summary = screen.getByText('オンラインストア注文 #1001');
		const row = summary.closest('tr');
		expect(row).not.toBeNull();
		expect(within(row!).getByText('取引先なし')).toBeInTheDocument();
		expect(within(row!).getByText('Supabase注文')).toBeInTheDocument();
		expect(within(row!).getByText('返金 ¥5,000')).toBeInTheDocument();
		expect(summary).not.toHaveClass('truncate');
	});
});
