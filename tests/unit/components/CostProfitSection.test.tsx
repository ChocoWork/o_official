import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CostProfitSection from '@/components/CostProfitSection';

function setupFinanceFetch() {
	const data = {
		seasonKey: '2026SS',
		businessType: 'soleProprietor',
		plan: {
			salesRevenue: 3240000,
			openingCash: 420000,
			accountsReceivable: 324000,
			fixedAssets: 260000,
			accountsPayable: 430000,
			openingCapital: 1091000,
		},
		expenses: [
			{ id: 1, entryType: 'expense', date: '2026-05-24', category: '販売費・マーケティング', item: 'Instagram広告費', partner: '', amount: 32000, paymentMethod: 'クレジットカード', memo: '広告' },
		] as Array<Record<string, unknown>>,
		incomes: [] as Array<Record<string, unknown>>,
		partners: [] as string[],
		templates: [] as Array<{ name: string; entryType: string; category: string; item: string; amount: number; paymentMethod: string; memo: string }>,
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
		if ((init?.method ?? 'GET') === 'POST') {
			const body = JSON.parse(String(init?.body ?? '{}'));
			if (body.operation === 'expense.create') {
				const entry = { id: Math.floor(Math.random() * 1e6) + 2, ...body.expense };
				if (body.expense.entryType === 'income') data.incomes.unshift(entry);
				else data.expenses.unshift(entry);
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
				data.templates = [...data.templates.filter((t) => t.name !== body.template.name), body.template];
			}
			if (body.operation === 'template.delete') {
				data.templates = data.templates.filter((t) => t.name !== body.templateName);
			}
			return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

	beforeEach(() => {
		setupFinanceFetch();
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
		fireEvent.click(screen.getByRole('button', { name: '支出概要' }));
		fireEvent.click(screen.getByRole('option', { name: '展示会・イベント' }));
		fireEvent.click(screen.getByRole('button', { name: '勘定科目' }));
		fireEvent.click(screen.getByRole('option', { name: '経費 / 広告宣伝費' }));
		fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '45000' } });
		fireEvent.click(screen.getByRole('button', { name: '保存' }));

		expect(await screen.findByText('支出を保存し、仕訳帳と財務概要へ反映しました。')).toBeInTheDocument();

		// 仕訳帳タブには支出概要のプルダウン選択肢が無いため、支出概要テキストが一意に現れる。
		fireEvent.click(screen.getByRole('tab', { name: '帳簿' }));
		expect(screen.getByText('展示会・イベント')).toBeInTheDocument();
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
		fireEvent.click(screen.getByRole('button', { name: '支出概要' }));
		fireEvent.click(screen.getByRole('option', { name: '縫製外注' }));
		fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '50000' } });

		fireEvent.click(screen.getByRole('button', { name: 'テンプレート' }));
		fireEvent.click(screen.getByRole('option', { name: '＋ 現在の入力を保存' }));

		// 名前の初期値は「支出概要 / 金額」。
		const nameInput = screen.getByPlaceholderText('テンプレート名') as HTMLInputElement;
		expect(nameInput.value).toBe('縫製外注 / ¥50,000');
		fireEvent.change(nameInput, { target: { value: '縫製外注（定番）' } });
		fireEvent.click(screen.getByRole('button', { name: 'テンプレートを保存' }));

		expect(await screen.findByText('テンプレートを保存しました。')).toBeInTheDocument();

		// 別の支出概要へ変更してから、テンプレートを選び直すと支出概要・金額が戻る。
		fireEvent.click(screen.getByRole('button', { name: '支出概要' }));
		fireEvent.click(screen.getByRole('option', { name: '広告出稿' }));

		fireEvent.click(screen.getByRole('button', { name: 'テンプレート' }));
		fireEvent.click(await screen.findByRole('option', { name: '縫製外注（定番）' }));

		expect(screen.getByRole('button', { name: '支出概要' })).toHaveTextContent('縫製外注');
		expect((screen.getByPlaceholderText('0') as HTMLInputElement).value).toBe('50000');
	});

	it('商品原価と売価を編集すると粗利シミュレーションを更新する', async () => {
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		fireEvent.click(screen.getByRole('tab', { name: '商品原価' }));
		const sellingPriceInput = screen.getByRole('spinbutton', { name: '売価（1点あたり）' });
		fireEvent.change(sellingPriceInput, { target: { value: '30000' } });

		expect(sellingPriceInput).toHaveValue(30000);
		expect(screen.getAllByText('¥21,000').length).toBeGreaterThan(0);

		fireEvent.click(screen.getByRole('button', { name: '保存' }));
		await waitFor(() => expect(screen.getByText('ドローストリングシャツの原価・売価を保存しました。')).toBeInTheDocument());
	});

	it('ゴミ箱ボタンで経費をSupabaseから削除する', async () => {
		const mockFetch = setupFinanceFetch();
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		// FREQ-257 以降、削除は行から開く訂正 Drawer の中にある。
		fireEvent.click(screen.getByRole('button', { name: 'Instagram広告費を訂正' }));
		fireEvent.click(screen.getByRole('button', { name: 'Instagram広告費を削除' }));

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
		expect(screen.getByRole('button', { name: '収入概要' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: '収入概要' }));
		fireEvent.click(screen.getByRole('option', { name: 'オンライン販売' }));
		fireEvent.click(screen.getByRole('button', { name: '勘定科目' }));
		fireEvent.click(screen.getByRole('option', { name: '売上（収入）金額 / 売上高' }));
		fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '120000' } });
		fireEvent.click(screen.getByRole('button', { name: '保存' }));

		expect(await screen.findByText('収入を保存し、仕訳帳と財務概要へ反映しました。')).toBeInTheDocument();

		// entryType=income のPOSTが送られる。
		expect(mockFetch).toHaveBeenCalledWith(
			'/api/admin/kpi/cost-profit',
			expect.objectContaining({ method: 'POST', body: expect.stringContaining('"entryType":"income"') }),
		);

		// 統合された一覧に、既存の支出1件と登録した収入1件が並ぶ。
		expect(await screen.findByText('1-2 / 2件')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'オンライン販売を訂正' })).toBeInTheDocument();
	});

	it('テンプレートは支出・収入で別管理される', async () => {
		render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
		await screen.findByText('同期済み');

		fireEvent.click(screen.getByRole('tab', { name: '取引管理' }));
		// FREQ-257 以降、取引の入力欄は「新規取引」Drawer の中にある。
		fireEvent.click(screen.getByRole('button', { name: '新規取引' }));

		// 支出のテンプレートを1件作る。
		fireEvent.click(screen.getByRole('button', { name: '支出概要' }));
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
});
