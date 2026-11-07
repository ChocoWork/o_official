import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CostProfitSection from '@/components/CostProfitSection';
import { solePeriod } from './settings-fixtures';

// 領収書の添付で種類を選ぶ（FREQ-559-AC-03）。

const P2026 = solePeriod(2026);

function financeData(expenses: unknown[]) {
	return {
		fiscalYear: 2026, seasonKey: null, businessType: 'soleProprietor',
		plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
		expenses, incomes: [], products: [], partners: [], fixedAssets: [],
		closing: { closingInventoryGoods: 0, closingInventoryMaterials: 0, allowanceForDoubtful: 0, closingBalances: {}, closedAt: null },
		previousClosingBalances: null, revisions: [], reviewAcks: [], cumulativeEntries: [], templates: [], summaryOptions: [],
		stripeAccounting: { balanceTransactions: [], refunds: [], payouts: [], summary: { stripeBalance: 0, inTransitBalance: 0, unmatchedPayoutCount: 0 } },
		period: P2026, periods: [P2026], savedJournal: [], opening: [],
		periodNotices: { filingDeadlinePassed: false, previousPeriodOpen: false },
	};
}

const receipt = (id: number, evidenceKind: string, paperOriginalKept: boolean | null) => ({
	id, storagePath: `2026/1/${id}.pdf`, fileName: `領収書${id}.pdf`, mimeType: 'application/pdf', fileSize: 10,
	createdAt: '2026-05-24T01:00:00.000Z', evidenceKind, paperOriginalKept,
});

describe('領収書の種類', () => {
	jest.setTimeout(30000);

	it('FREQ-559-AC-03: 領収書の種類を選べ紙のときは原本の確認が必須で未確認の既存分に促しが出る', async () => {
		const uploads: FormData[] = [];
		global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), 'http://localhost');
			if (url.pathname === '/api/admin/kpi/cost-profit/receipt' && init?.method === 'POST') {
				uploads.push(init.body as FormData);
				return new Response(JSON.stringify({ data: { id: 99 } }), { status: 200 });
			}
			if (url.pathname === '/api/admin/kpi/cost-profit') {
				return new Response(JSON.stringify({
					data: financeData([{
						id: 1, entryType: 'expense', date: '2026-05-24', category: '広告宣伝費', item: 'Instagram広告費', partner: '',
						amount: 32_000, paymentMethod: '現金', memo: '',
						receipts: [receipt(7, 'unconfirmed', null), receipt(8, 'electronic', null)],
					}]),
				}), { status: 200 });
			}
			return new Response(JSON.stringify({ error: 'not mocked' }), { status: 404 });
		}) as unknown as typeof fetch;

		render(<CostProfitSection periodId={null} fiscalYear={2026} fiscalYearLabel="2026年" />);
		fireEvent.click(await screen.findByRole('tab', { name: '取引管理' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Instagram広告費の証憑' }));

		const drawer = screen.getByRole('heading', { name: '証憑を追加' }).parentElement?.parentElement as HTMLElement;
		// 種類が未確認の既存の領収書にだけ促しを出す。
		const unconfirmed = within(drawer).getByRole('button', { name: '領収書7.pdfを開く' }).closest('li') as HTMLElement;
		expect(unconfirmed).toHaveTextContent('種類を確かめてください');
		const electronic = within(drawer).getByRole('button', { name: '領収書8.pdfを開く' }).closest('li') as HTMLElement;
		expect(electronic).not.toHaveTextContent('種類を確かめてください');

		// 種類を選ぶまでは添付できない。
		const zone = within(drawer).getByLabelText('Instagram広告費に証憑を添付');
		expect(zone).toBeDisabled();
		fireEvent.click(within(drawer).getByRole('radio', { name: '紙あり（画像は写し）' }));
		// 紙は原本を残してあることを確かめるまで添付できない。
		expect(zone).toBeDisabled();
		fireEvent.click(within(drawer).getByRole('checkbox', { name: '紙の原本を残してある' }));
		expect(zone).not.toBeDisabled();
		fireEvent.change(zone, { target: { files: [new File(['x'], 'scan.jpg', { type: 'image/jpeg' })] } });
		await waitFor(() => expect(uploads).toHaveLength(1));
		expect(uploads[0].get('evidenceKind')).toBe('paper');
		expect(uploads[0].get('paperOriginalKept')).toBe('true');
		// 添付が済んだら種類の選択を戻し、次の取引へ持ち越さない。
		await waitFor(() => expect(within(drawer).getByRole('radio', { name: '紙あり（画像は写し）' })).not.toBeChecked());
		expect(within(drawer).queryByRole('checkbox', { name: '紙の原本を残してある' })).not.toBeInTheDocument();
		expect(zone).toBeDisabled();

		fireEvent.click(within(drawer).getByRole('radio', { name: '電子で受け取った（PDF など）' }));
		expect(within(drawer).queryByRole('checkbox', { name: '紙の原本を残してある' })).not.toBeInTheDocument();
		await waitFor(() => expect(zone).not.toBeDisabled());
		fireEvent.change(zone, { target: { files: [new File(['y'], 'mail.pdf', { type: 'application/pdf' })] } });
		await waitFor(() => expect(uploads).toHaveLength(2));
		expect(uploads[1].get('evidenceKind')).toBe('electronic');
		expect(uploads[1].get('paperOriginalKept')).toBeNull();
	});
});
