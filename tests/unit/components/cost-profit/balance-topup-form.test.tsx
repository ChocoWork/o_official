import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BalanceTopupForm } from '@/components/cost-profit/balance-topup-form';
import { BASE } from './accounting-fixtures';
import { mockFetch } from './settings-fixtures';

// 残高の補充の入力（FREQ-565-AC-06）。POST /api/admin/accounting/balance-topups は管理の財務の権限の人だけ。

type Reply = { status: number; body: unknown };
const OK: Reply = { status: 200, body: { data: { topup: { entry_id: 'e1', entry_no: 7, period_id: 'p1', created: true } } } };

function serve(reply: Reply = OK) {
	return mockFetch((url, method) => (url.pathname === `${BASE}/balance-topups` && method === 'POST' ? reply : undefined));
}
// 画面の書き込みは CSRF の印を取りに行く /api/auth/refresh を先に呼ぶことがあるので、補充の窓口だけを数える。
const posts = (api: ReturnType<typeof serve>) => api.calls.filter((call) => call.method === 'POST' && call.url === `${BASE}/balance-topups`);

function fill(region: HTMLElement, values: Record<string, string>) {
	for (const [label, value] of Object.entries(values)) fireEvent.change(within(region).getByLabelText(label), { target: { value } });
}
const submit = (region: HTMLElement) => fireEvent.click(within(region).getByRole('button', { name: '補充を記録する' }));

describe('残高の補充の入力', () => {
	jest.setTimeout(30000);

	it('FREQ-565-AC-06: 残高の補充の入力は未来の日と額0を送る前に止める', async () => {
		const api = serve();
		render(<BalanceTopupForm canManage today="2026-11-09" />);
		const region = screen.getByRole('region', { name: '残高の補充の記録' });

		fill(region, { '補充した額（円）': '0', 銀行の日: '2026-11-09', 銀行の取引番号: 'BANK-1' });
		submit(region);
		expect(await within(region).findByText('額は1円以上の整数で入れてください。')).toBeInTheDocument();

		fill(region, { '補充した額（円）': '50000', 銀行の日: '2026-11-10' });
		submit(region);
		expect(await within(region).findByText('未来の日は入れられません。')).toBeInTheDocument();

		fill(region, { '補充した額（円）': '1500.5', 銀行の日: '2026-11-09' });
		submit(region);
		expect(await within(region).findByText('額は1円以上の整数で入れてください。')).toBeInTheDocument();

		fill(region, { '補充した額（円）': '50000', 銀行の日: '' });
		submit(region);
		expect(await within(region).findByText('銀行の日を入れてください。')).toBeInTheDocument();
		// どれも送っていない。
		expect(posts(api)).toHaveLength(0);
	});

	it('FREQ-565-AC-06: 取引番号は英数字と _ . - だけ、128文字まで。どちらかは必須で、欄の説明にも書く', async () => {
		const api = serve();
		render(<BalanceTopupForm canManage today="2026-11-09" />);
		const region = screen.getByRole('region', { name: '残高の補充の記録' });
		expect(within(region).getAllByText('英数字と _ . - だけ、128文字までで入れてください').length).toBeGreaterThanOrEqual(1);

		fill(region, { '補充した額（円）': '50000', 銀行の日: '2026-11-09' });
		submit(region);
		expect(await within(region).findByText('銀行の取引番号かStripeの取引番号のどちらかを入れてください。')).toBeInTheDocument();

		fill(region, { 銀行の取引番号: 'BANK 1/2' });
		submit(region);
		expect(await within(region).findByText('取引番号は英数字と _ . - だけ、128文字までです。')).toBeInTheDocument();

		fill(region, { 銀行の取引番号: 'a'.repeat(129) });
		submit(region);
		expect(await within(region).findByText('取引番号は英数字と _ . - だけ、128文字までです。')).toBeInTheDocument();
		expect(posts(api)).toHaveLength(0);
	});

	it('FREQ-565-AC-06: 入力が正しければ銀行の番号とStripeの取引の番号を添えて送り、記録したと出す', async () => {
		const api = serve();
		render(<BalanceTopupForm canManage today="2026-11-09" />);
		const region = screen.getByRole('region', { name: '残高の補充の記録' });
		fill(region, {
			'補充した額（円）': '50000',
			銀行の日: '2026-11-09',
			銀行の取引番号: 'BANK_2026-11.09',
			Stripeの取引番号: 'txn_1Abc',
			'メモ（任意）': '  残高の補充  ',
		});
		const button = within(region).getByRole('button', { name: '補充を記録する' });
		fireEvent.click(button);
		fireEvent.click(button);
		expect(await within(region).findByText('補充を記録しました。')).toBeInTheDocument();
		expect(posts(api)).toHaveLength(1);
		expect(posts(api)[0].url).toBe(`${BASE}/balance-topups`);
		expect(posts(api)[0].body).toEqual({
			amount: 50000,
			bankDate: '2026-11-09',
			bankTxnNo: 'BANK_2026-11.09',
			stripeTxnId: 'txn_1Abc',
			note: '残高の補充',
			requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		// 記録したら欄を空に戻す。
		expect(within(region).getByLabelText('補充した額（円）')).toHaveValue(null);
	});

	it('FREQ-565-AC-06: 切り替えの日より前の日の400は、固定の文で知らせ、本文を読み切る', async () => {
		const api = serve({ status: 400, body: { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '切り替えの日より前の日は入れられません。' } });
		render(<BalanceTopupForm canManage today="2026-11-09" />);
		const region = screen.getByRole('region', { name: '残高の補充の記録' });
		fill(region, { '補充した額（円）': '50000', 銀行の日: '2025-01-01', Stripeの取引番号: 'txn_1' });
		submit(region);
		expect(await within(region).findByText('切り替えの日より前の日は入れられません。')).toBeInTheDocument();
		expect(posts(api)[0].response.bodyUsed).toBe(true);
		// 失敗では欄を消さない。
		expect(within(region).getByLabelText('補充した額（円）')).toHaveValue(50000);
		await waitFor(() => expect(within(region).getByRole('button', { name: '補充を記録する' })).toBeEnabled());
	});

	it('FREQ-565-AC-06: 権限の無い人には入力欄を出さない', () => {
		const api = serve();
		render(<BalanceTopupForm canManage={false} today="2026-11-09" />);
		expect(screen.queryByRole('button', { name: '補充を記録する' })).not.toBeInTheDocument();
		expect(screen.getByText('残高の補充を記録する権限がありません')).toBeInTheDocument();
		expect(api.calls).toHaveLength(0);
	});
});
