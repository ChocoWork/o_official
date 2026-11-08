import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { InvoiceRecordForm, ReconciliationView } from '@/components/cost-profit/reconciliation-view';
import { ALL_FLAGS, BASE, envelope, type Flags } from './accounting-fixtures';
import { mockFetch } from './settings-fixtures';

// 照合のタブ（FREQ-566・571）。route は読み口の答えを組み替えずに返す（平らな snake_case）。

const BALANCE = {
	through: '2026-11-09',
	stripe_balance: 1000000,
	ledger_1160: 900000,
	ledger_1130_stripe: 50000,
	difference: 50000,
	unjournaled: [
		{ kind: 'planned_p3', count: 1, net_sum: -3000 },
		{ kind: 'pending', count: 2, net_sum: 40000 },
		{ kind: 'unknown', count: 0, net_sum: 0 },
		{ kind: 'payout_unposted', count: 1, net_sum: -10000 },
		{ kind: 'manual_topup', count: 1, net_sum: 23000 },
	],
	payout_in_transit_1150: 70000,
};

const FEE = {
	jst_total: 12000,
	utc_total: 11800,
	invoice_total: 11500,
	boundary_in: [{ txn_id: 'txn_in', jst_date: '2026-10-01', utc_date: '2026-09-30', fee: 200 }],
	boundary_out: [],
	next_month_adjustments: [{ txn_id: 'txn_adj', jst_date: '2026-11-02', amount: 150 }],
	diff_jst_utc: 200,
	explained_boundary: 200,
	unexplained_jst_utc: 0,
	diff_utc_invoice: 300,
	explained_adjustments: 150,
	unexplained_utc_invoice: 150,
	journal_vs_txn_diff: 0,
};

const INTAKE = {
	opening_backlog: 500000,
	intake: 800000,
	sales_before_return: 600000,
	closing_backlog: 650000,
	exceptions: [
		{ kind: 'dispute_pending', label_key: 'dispute_pending', amount: -30000 },
		{ kind: 'return_refund_2130', label_key: 'return_refund_2130', amount: 0 },
		{ kind: 'other', label_key: 'other', event_kind: 'manual_entry', amount: 20000 },
	],
	unexplained: 0,
	returns: 10000,
	booked_sales_net_orders: 590000,
	return_fee_revenue_4050: 1000,
	other_4010: 4000,
	other_4020: 500,
	book_sales_total: 593500,
	unexplained2: 0,
	dispute_confirmed_by_account: [{ account_code: '6290', sub_account: null, amount: 30000 }],
};

type Serve = { flags?: Flags; fee?: unknown; intake?: unknown; invoice?: { record: unknown }; invoicePut?: { status: number; body: unknown } };

function serve(state: Serve = {}) {
	return mockFetch((url, method) => {
		const flags = state.flags ?? ALL_FLAGS;
		if (url.pathname === `${BASE}/reconciliation`) {
			const kind = url.searchParams.get('kind');
			if (kind === 'stripe-balance') return { status: 200, body: envelope(BALANCE, flags) };
			if (kind === 'stripe-fee') return { status: 200, body: envelope(state.fee ?? FEE, flags) };
			if (kind === 'intake') return { status: 200, body: envelope(state.intake ?? INTAKE, flags) };
		}
		if (url.pathname === `${BASE}/year-end-shipments`) {
			return {
				status: 200,
				body: envelope({
					slips: [], next_after_date: null, next_after_slip: null,
					options: { carrier_date_check_enabled: false, changed_at: null, changed_by: null, version: '1' },
					carrier_gaps: { enabled: false, slips: [], has_more: false },
				}, flags),
			};
		}
		if (url.pathname === `${BASE}/stripe-invoices` && method === 'GET') {
			return { status: 200, body: envelope(state.invoice ?? { record: null }, flags) };
		}
		if (url.pathname === `${BASE}/stripe-invoices` && method === 'PUT') {
			return state.invoicePut ?? { status: 200, body: { data: { record: { month: '2026-10', total: 11500, tax: 1045, documentRef: null, enteredAt: '2026-11-09T00:00:00+00:00', version: '1' } } } };
		}
		return undefined;
	});
}

const reconciliationUrls = (api: ReturnType<typeof serve>) =>
	api.fn.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('/reconciliation?'));

describe('照合のタブ', () => {
	jest.setTimeout(30000);

	it('FREQ-566-AC-03: Stripeの残高の照合は差を仕訳になっていない取引の種類で示す', async () => {
		const api = serve();
		render(<ReconciliationView today="2026-11-09" periodStart="2026-01-01" periodEnd="2026-12-31" />);
		const region = screen.getByRole('region', { name: 'Stripeの残高の照合' });
		fireEvent.change(within(region).getByLabelText('照合する日'), { target: { value: '2026-11-09' } });
		fireEvent.click(within(region).getByRole('button', { name: 'Stripeの残高を照合する' }));

		const table = await within(region).findByRole('table', { name: '仕訳になっていない取引の種類' });
		expect(reconciliationUrls(api)).toEqual([expect.stringContaining('kind=stripe-balance&through=2026-11-09')]);
		// 何の日に対する結果かを添える。
		expect(within(region).getByText('2026/11/09 時点の照合')).toBeInTheDocument();
		expect(within(region).getByText('Stripeの残高 ¥1,000,000')).toBeInTheDocument();
		expect(within(region).getByText('帳簿の残高 ¥950,000')).toBeInTheDocument();
		expect(within(region).getByText('差 ¥50,000')).toBeInTheDocument();
		const pending = within(table).getByRole('row', { name: /計上待ちの取引/ });
		expect(pending).toHaveTextContent('2件');
		expect(pending).toHaveTextContent('¥40,000');
		expect(within(table).getByRole('row', { name: /残高の補充/ })).toHaveTextContent('¥23,000');
		expect(within(table).getByRole('row', { name: /入金の取引/ })).toHaveTextContent('▲¥10,000');
		// 種類の合計と差が合えば、説明のつかない差は0。
		expect(within(region).getByTestId('balance-unexplained')).toHaveTextContent('説明のつかない差 ¥0');
		expect(within(region).getByTestId('balance-unexplained')).toHaveAttribute('data-tone', 'ok');
		expect(within(region).getByText('入金途上（1150） ¥70,000')).toBeInTheDocument();
		// 日を替えたら、前の日の結果は消す。
		fireEvent.change(within(region).getByLabelText('照合する日'), { target: { value: '2026-11-08' } });
		expect(within(region).queryByRole('table', { name: '仕訳になっていない取引の種類' })).not.toBeInTheDocument();
		expect(within(region).queryByText('2026/11/09 時点の照合')).not.toBeInTheDocument();
	});

	it('FREQ-566-AC-01: 手数料の月の照合は2段の差と説明のつかない差を出し、0でなければ赤字で出す', async () => {
		const api = serve();
		render(<ReconciliationView today="2026-11-09" periodStart="2026-01-01" periodEnd="2026-12-31" />);
		const region = screen.getByRole('region', { name: '手数料の月の照合' });
		fireEvent.change(within(region).getByLabelText('照合する月'), { target: { value: '2026-10' } });
		fireEvent.click(within(region).getByRole('button', { name: '手数料を照合する' }));

		const step1 = await within(region).findByRole('group', { name: '1段目 日本時間とUTCの差' });
		expect(api.fn.mock.calls.some((call) => String(call[0]).includes('kind=stripe-fee&month=2026-10'))).toBe(true);
		expect(within(region).getByText('2026年10月の照合')).toBeInTheDocument();
		expect(step1).toHaveTextContent('日本時間の合計 ¥12,000');
		expect(step1).toHaveTextContent('UTCの合計 ¥11,800');
		expect(step1).toHaveTextContent('差 ¥200');
		expect(step1).toHaveTextContent('月またぎで説明できる差 ¥200');
		expect(within(step1).getByText(/txn_in/)).toBeInTheDocument();
		const unexplained1 = within(step1).getByTestId('fee-unexplained-1');
		expect(unexplained1).toHaveTextContent('説明のつかない差 ¥0');
		expect(unexplained1).toHaveAttribute('data-tone', 'ok');

		const step2 = within(region).getByRole('group', { name: '2段目 UTCと請求書の差' });
		expect(step2).toHaveTextContent('請求書の合計 ¥11,500');
		expect(step2).toHaveTextContent('差 ¥300');
		expect(step2).toHaveTextContent('翌月の調整で説明できる分 ¥150');
		const unexplained2 = within(step2).getByTestId('fee-unexplained-2');
		expect(unexplained2).toHaveTextContent('説明のつかない差 ¥150');
		// 0でなければ赤字。
		expect(unexplained2).toHaveAttribute('data-tone', 'alert');
		expect(unexplained2.className).toMatch(/text-red-700/);
		// 符号は暫定。誤りと決めつける言葉は使わない。
		expect(region.textContent).not.toMatch(/誤り/);
		expect(step2).toHaveTextContent('符号の向きは確認中');
		// 月を替えたら、前の月の結果と請求書の欄は消す。
		fireEvent.change(within(region).getByLabelText('照合する月'), { target: { value: '2026-09' } });
		expect(within(region).queryByRole('group', { name: '1段目 日本時間とUTCの差' })).not.toBeInTheDocument();
		expect(within(region).queryByRole('region', { name: /適格請求書の記録/ })).not.toBeInTheDocument();
	});

	it('FREQ-566-AC-02: 請求書の合計を保存したら、手数料の照合を引き直して2段目に反映する', async () => {
		const api = serve({ fee: { ...FEE, invoice_total: null, diff_utc_invoice: null, explained_adjustments: null, unexplained_utc_invoice: null } });
		render(<ReconciliationView today="2026-11-09" periodStart="2026-01-01" periodEnd="2026-12-31" />);
		const region = screen.getByRole('region', { name: '手数料の月の照合' });
		fireEvent.change(within(region).getByLabelText('照合する月'), { target: { value: '2026-10' } });
		fireEvent.click(within(region).getByRole('button', { name: '手数料を照合する' }));
		await within(region).findByText(/請求書の合計が未入力です/);
		const form = await within(region).findByRole('region', { name: '適格請求書の記録（2026年10月）' });
		await within(form).findByText('この月の請求書の合計はまだ入っていません');
		fireEvent.change(within(form).getByLabelText('請求書の合計（税込）'), { target: { value: '11500' } });
		fireEvent.change(within(form).getByLabelText('うち消費税'), { target: { value: '1045' } });
		const before = reconciliationUrls(api).length;
		fireEvent.click(within(form).getByRole('button', { name: '請求書の合計を保存' }));
		await waitFor(() => expect(reconciliationUrls(api).length).toBe(before + 1));
		expect(reconciliationUrls(api).at(-1)).toContain('kind=stripe-fee&month=2026-10');
		// 引き直している間も請求書の欄は残り、「保存しました。」が消えない。
		expect(await within(form).findByText('保存しました。')).toBeInTheDocument();
		await within(region).findByRole('group', { name: '2段目 UTCと請求書の差' });
		expect(within(region).getByText('保存しました。')).toBeInTheDocument();
	});

	it('FREQ-566-AC-01: 請求書がまだ無い月は2段目を「請求書の合計が未入力です」にする', async () => {
		serve({ fee: { ...FEE, invoice_total: null, diff_utc_invoice: null, explained_adjustments: null, unexplained_utc_invoice: null } });
		render(<ReconciliationView today="2026-11-09" periodStart="2026-01-01" periodEnd="2026-12-31" />);
		const region = screen.getByRole('region', { name: '手数料の月の照合' });
		fireEvent.change(within(region).getByLabelText('照合する月'), { target: { value: '2026-10' } });
		fireEvent.click(within(region).getByRole('button', { name: '手数料を照合する' }));
		const step2 = await within(region).findByRole('group', { name: '2段目 UTCと請求書の差' });
		expect(step2).toHaveTextContent('請求書の合計が未入力です');
		expect(within(step2).queryByTestId('fee-unexplained-2')).not.toBeInTheDocument();
	});

	it('FREQ-566-AC-02: 請求書の合計を入れて保存でき、版違いは読み直しを案内する', async () => {
		const api = serve({
			invoice: { record: { month: '2026-10', total: 11000, tax: 1000, documentRef: 'INV-1', enteredAt: '2026-11-01T00:00:00+00:00', version: '3' } },
			invoicePut: { status: 409, body: { code: 'ACCOUNTING_VERSION_CONFLICT', error: '設定が変わりました。読み直してください。' } },
		});
		render(<InvoiceRecordForm month="2026-10" />);
		const region = await screen.findByRole('region', { name: '適格請求書の記録（2026年10月）' });
		await waitFor(() => expect(within(region).getByLabelText('請求書の合計（税込）')).toHaveValue(11000));
		fireEvent.change(within(region).getByLabelText('請求書の合計（税込）'), { target: { value: '11500' } });
		fireEvent.change(within(region).getByLabelText('うち消費税'), { target: { value: '1045' } });
		fireEvent.change(within(region).getByLabelText('書類の参照（任意）'), { target: { value: '  ' } });
		fireEvent.click(within(region).getByRole('button', { name: '請求書の合計を保存' }));

		await waitFor(() => expect(api.calls.some((call) => call.method === 'PUT')).toBe(true));
		const put = api.calls.find((call) => call.method === 'PUT');
		expect(put?.url).toBe(`${BASE}/stripe-invoices`);
		expect(put?.body).toEqual({ month: '2026-10', total: 11500, tax: 1045, documentRef: null, expectedVersion: '3', requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
		// 版違い: 本文を読み切って案内し、読み直しの操作を出す。
		expect(await within(region).findByText('設定が変わりました。読み直してください。')).toBeInTheDocument();
		expect(put?.response.bodyUsed).toBe(true);
		const reads = () => api.calls.filter((call) => call.method === 'GET' && call.url === `${BASE}/stripe-invoices`).length;
		const before = reads();
		fireEvent.click(within(region).getByRole('button', { name: '読み直す' }));
		await waitFor(() => expect(reads()).toBe(before + 1));
	});

	it('FREQ-566-AC-02: 初めて入れる月は版をnullで送り、合計が負や小数なら送らない。権限が無ければ読み取りだけ', async () => {
		const api = serve();
		const { unmount } = render(<InvoiceRecordForm month="2026-10" />);
		const region = await screen.findByRole('region', { name: '適格請求書の記録（2026年10月）' });
		await within(region).findByText('この月の請求書の合計はまだ入っていません');
		fireEvent.change(within(region).getByLabelText('請求書の合計（税込）'), { target: { value: '-1' } });
		fireEvent.change(within(region).getByLabelText('うち消費税'), { target: { value: '0' } });
		fireEvent.click(within(region).getByRole('button', { name: '請求書の合計を保存' }));
		expect(await within(region).findByText('合計と消費税は0以上の整数で入れてください。')).toBeInTheDocument();
		expect(api.calls.some((call) => call.method === 'PUT')).toBe(false);
		fireEvent.change(within(region).getByLabelText('請求書の合計（税込）'), { target: { value: '11500' } });
		fireEvent.click(within(region).getByRole('button', { name: '請求書の合計を保存' }));
		await waitFor(() => expect(api.calls.some((call) => call.method === 'PUT')).toBe(true));
		expect(api.calls.find((call) => call.method === 'PUT')?.body).toMatchObject({ expectedVersion: null, total: 11500 });
		unmount();

		serve({ flags: { manageSettings: false }, invoice: { record: { month: '2026-10', total: 11000, tax: 1000, documentRef: null, enteredAt: '2026-11-01T00:00:00+00:00', version: '3' } } });
		render(<InvoiceRecordForm month="2026-10" />);
		await screen.findByText('請求書の合計 ¥11,000');
		expect(screen.queryByRole('button', { name: '請求書の合計を保存' })).not.toBeInTheDocument();
	});

	it('FREQ-571-AC-05: 受注高と帳簿の2段の照らし合わせに「帳簿の売上高ではありません。申告には使いません」が出る', async () => {
		const api = serve();
		render(<ReconciliationView today="2026-11-09" periodStart="2026-01-01" periodEnd="2026-12-31" />);
		const region = screen.getByRole('region', { name: '受注高と帳簿の照らし合わせ' });
		expect(within(region).getByText('受注高は帳簿の売上高ではありません。申告には使いません')).toBeInTheDocument();
		// 期間の既定は選んでいる会計期間。
		expect(within(region).getByLabelText('開始日')).toHaveValue('2026-01-01');
		expect(within(region).getByLabelText('終了日')).toHaveValue('2026-12-31');
		fireEvent.click(within(region).getByRole('button', { name: '受注高を照合する' }));

		const step1 = await within(region).findByRole('group', { name: '1段目 受注残の動き' });
		expect(api.fn.mock.calls.some((call) => String(call[0]).includes('kind=intake&from=2026-01-01&to=2026-12-31'))).toBe(true);
		expect(step1).toHaveTextContent('期首の受注残 ¥500,000');
		expect(step1).toHaveTextContent('受注高 ¥800,000');
		expect(step1).toHaveTextContent('返品の前の売上 ¥600,000');
		expect(step1).toHaveTextContent('期末の受注残 ¥650,000');
		// 例外の行は1段目の下に並ぶ。
		const exceptions = within(step1).getByRole('list', { name: '例外の行' });
		expect(within(exceptions).getByText(/カード会社の判断待ち/)).toHaveTextContent('▲¥30,000');
		expect(within(exceptions).getByText(/返品の返金待ち/)).toHaveTextContent('¥0');
		expect(within(exceptions).getByText(/その他/)).toHaveTextContent('¥20,000');
		expect(within(step1).getByTestId('intake-unexplained-1')).toHaveAttribute('data-tone', 'ok');

		const step2 = within(region).getByRole('group', { name: '2段目 売上の照らし合わせ' });
		expect(within(region).getByText('2026/01/01 〜 2026/12/31 の照合')).toBeInTheDocument();
		expect(step2).toHaveTextContent('返品 ¥10,000');
		expect(step2).toHaveTextContent('受注の売上（返品を引いた後） ¥590,000');
		expect(step2).toHaveTextContent('返品の手数料の売上（4050） ¥1,000');
		expect(step2).toHaveTextContent('帳簿の売上の合計 ¥593,500');
		expect(within(step2).getByTestId('intake-unexplained-2')).toHaveAttribute('data-tone', 'ok');
		// 取り消しの確定は勘定ごとに2段目の下へ。
		const confirmed = within(step2).getByRole('list', { name: '確定した取り消しの勘定別' });
		expect(confirmed).toHaveTextContent('6290');
		expect(confirmed).toHaveTextContent('¥30,000');
	});

	it('FREQ-571-AC-05: 選んでいる会計期間が替わったら、範囲もその期間に合わせ、前の期間の結果は消す', async () => {
		serve();
		const { rerender } = render(<ReconciliationView today="2026-11-09" periodStart="2026-01-01" periodEnd="2026-12-31" />);
		const region = screen.getByRole('region', { name: '受注高と帳簿の照らし合わせ' });
		fireEvent.click(within(region).getByRole('button', { name: '受注高を照合する' }));
		await within(region).findByRole('group', { name: '1段目 受注残の動き' });
		rerender(<ReconciliationView today="2026-11-09" periodStart="2027-01-01" periodEnd="2027-12-31" />);
		await waitFor(() => expect(within(region).getByLabelText('開始日')).toHaveValue('2027-01-01'));
		expect(within(region).getByLabelText('終了日')).toHaveValue('2027-12-31');
		expect(within(region).queryByRole('group', { name: '1段目 受注残の動き' })).not.toBeInTheDocument();
	});

	it('FREQ-574-AC-01: 照合のタブに年末の出荷の確認が出る（運送会社の受付日のずれもここ）', async () => {
		serve();
		render(<ReconciliationView today="2026-12-28" periodStart="2026-01-01" periodEnd="2026-12-31" />);
		const panel = await screen.findByRole('region', { name: '年末の出荷の確認' });
		expect(await within(panel).findByText('運送会社の受付日との照らし合わせはオフです')).toBeInTheDocument();
		expect(within(panel).getByLabelText('開始日')).toHaveValue('2026-12-25');
	});

	it('FREQ-571-AC-05: 説明のつかない差が0でなければ赤字で出す', async () => {
		serve({ intake: { ...INTAKE, unexplained: 1200, unexplained2: -300 } });
		render(<ReconciliationView today="2026-11-09" periodStart="2026-01-01" periodEnd="2026-12-31" />);
		const region = screen.getByRole('region', { name: '受注高と帳簿の照らし合わせ' });
		fireEvent.click(within(region).getByRole('button', { name: '受注高を照合する' }));
		const first = await within(region).findByTestId('intake-unexplained-1');
		expect(first).toHaveTextContent('説明のつかない差 ¥1,200');
		expect(first).toHaveAttribute('data-tone', 'alert');
		expect(within(region).getByTestId('intake-unexplained-2')).toHaveAttribute('data-tone', 'alert');
		expect(within(region).getByTestId('intake-unexplained-2')).toHaveTextContent('▲¥300');
	});

	it('FREQ-571-AC-05: 照合の読み込みが失敗したら、固定の文を出して本文を読み切る', async () => {
		const api = mockFetch(() => ({ status: 500, body: { error: '会計の処理に失敗しました。' } }));
		render(<ReconciliationView today="2026-11-09" periodStart="2026-01-01" periodEnd="2026-12-31" />);
		const region = screen.getByRole('region', { name: '受注高と帳簿の照らし合わせ' });
		fireEvent.click(within(region).getByRole('button', { name: '受注高を照合する' }));
		expect(await within(region).findByText('会計の処理に失敗しました。')).toBeInTheDocument();
		expect(api.calls.find((call) => call.url === `${BASE}/reconciliation`)?.response.bodyUsed).toBe(true);
	});
});
