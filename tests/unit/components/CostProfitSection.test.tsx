import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CostProfitSection from '@/components/CostProfitSection';

function setupFinanceFetch() {
	const data = {
		seasonKey: '2026SS',
		plan: {
			salesRevenue: 3240000,
			openingCash: 420000,
			accountsReceivable: 324000,
			fixedAssets: 260000,
			accountsPayable: 430000,
			openingCapital: 1091000,
		},
		expenses: [
			{ id: 1, date: '2026-05-24', category: '販売費・マーケティング', item: 'Instagram広告費', amount: 32000, paymentMethod: 'クレジットカード', memo: '広告' },
		],
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
				data.expenses.unshift({ id: 2, ...body.expense });
			}
			if (body.operation === 'product.upsert') {
				data.products = data.products.map((product) => product.id === body.product.id ? body.product : product);
			}
			return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
		}
		return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	});
	global.fetch = mockFetch as unknown as typeof fetch;
	return mockFetch;
}

describe('CostProfitSection', () => {
	beforeEach(() => {
		setupFinanceFetch();
	});

	it('財務3表と青色申告向けのサブタブを表示する', async () => {
		render(<CostProfitSection seasonKey="2026SS" seasonLabel="2026 S/S" />);
		await screen.findByText('Supabaseと同期済み');

		expect(screen.getByText('損益計算書（P/L）')).toBeInTheDocument();
		expect(screen.getByText('貸借対照表（B/S）')).toBeInTheDocument();
		expect(screen.getByText('キャッシュ・フロー計算書（C/F）')).toBeInTheDocument();
		expect(screen.getByRole('tab', { name: '帳簿（仕訳一覧）' })).toBeInTheDocument();
		expect(screen.getByRole('tab', { name: '商品原価' })).toBeInTheDocument();
		expect(screen.getByRole('tab', { name: '税務レポート' })).toBeInTheDocument();
	});

	it('登録した経費を一覧と仕訳帳へ反映する', async () => {
		render(<CostProfitSection seasonKey="2026SS" seasonLabel="2026 S/S" />);
		await screen.findByText('Supabaseと同期済み');

		fireEvent.click(screen.getByRole('tab', { name: 'コスト入力' }));
		fireEvent.change(screen.getByPlaceholderText('例：Instagram広告費'), { target: { value: '展示会什器レンタル' } });
		fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '45000' } });
		fireEvent.click(screen.getByRole('button', { name: 'Supabaseへ保存' }));

		expect(await screen.findByText('経費をSupabaseへ保存し、仕訳帳と財務サマリーへ反映しました。')).toBeInTheDocument();
		expect(await screen.findByText('展示会什器レンタル')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('tab', { name: '帳簿（仕訳一覧）' }));
		expect(screen.getByText('展示会什器レンタル')).toBeInTheDocument();
	});

	it('商品原価と売価を編集すると粗利シミュレーションを更新する', async () => {
		render(<CostProfitSection seasonKey="2026SS" seasonLabel="2026 S/S" />);
		await screen.findByText('Supabaseと同期済み');

		fireEvent.click(screen.getByRole('tab', { name: '商品原価' }));
		const sellingPriceInput = screen.getByRole('spinbutton', { name: '売価（1点あたり）' });
		fireEvent.change(sellingPriceInput, { target: { value: '30000' } });

		expect(sellingPriceInput).toHaveValue(30000);
		expect(screen.getAllByText('¥21,000').length).toBeGreaterThan(0);

		fireEvent.click(screen.getByRole('button', { name: '商品原価をSupabaseへ保存' }));
		await waitFor(() => expect(screen.getByText('ドローストリングシャツの原価・売価をSupabaseへ保存しました。')).toBeInTheDocument());
	});
});
