import { render, screen, within } from '@testing-library/react';
import { DisputeList } from '@/components/cost-profit/dispute-list';
import { ALL_FLAGS, BASE, dispute, disputePage, envelope } from './accounting-fixtures';
import { mockFetch } from './settings-fixtures';

// カード会社からの支払いの取り消しの一覧（FREQ-568-AC-01）。振り替え先の科目は取り消しごとに1つだけ表示する（Task 8 の concern 2）。

describe('支払いの取り消しの一覧', () => {
	it('FREQ-568-AC-01: 振り替え先の科目が複数に分かれる取り消しがあり得ることを、一覧の下で伝える', async () => {
		mockFetch((url) => (url.pathname === `${BASE}/disputes` ? { status: 200, body: envelope(disputePage([dispute(1, { assigned_account_code: '2130', confirmed_on: '2026-10-25' })]), ALL_FLAGS) } : undefined));
		render(<DisputeList />);
		const region = await screen.findByRole('region', { name: 'カード会社からの支払いの取り消し' });
		await within(region).findByRole('table', { name: 'カード会社からの支払いの取り消しの一覧' });
		expect(within(region).getByTestId('dispute-account-note')).toHaveTextContent('振り替え先の科目が複数に分かれる取り消しは、そのうち1つだけを表示しています。');
	});

	it('FREQ-568-AC-01: 取り消しが無い時は、複数の科目の注意を出さない', async () => {
		mockFetch((url) => (url.pathname === `${BASE}/disputes` ? { status: 200, body: envelope(disputePage([]), ALL_FLAGS) } : undefined));
		render(<DisputeList />);
		const region = await screen.findByRole('region', { name: 'カード会社からの支払いの取り消し' });
		await within(region).findByText('カード会社からの支払いの取り消しはありません');
		expect(within(region).queryByTestId('dispute-account-note')).not.toBeInTheDocument();
	});
});
