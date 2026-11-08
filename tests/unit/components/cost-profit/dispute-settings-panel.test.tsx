import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DisputeList } from '@/components/cost-profit/dispute-list';
import { DisputeSettingsPanel } from '@/components/cost-profit/dispute-settings-panel';
import { ALL_FLAGS, BASE, dispute, disputePage, envelope, type Flags } from './accounting-fixtures';
import { mockFetch } from './settings-fixtures';

// 支払いの取り消し（カード会社からの支払いの取り消し）の設定と一覧（FREQ-568）。
// 設定は {settings:[{reason,account_code,version,updated_at}]}、一覧は {disputes,next_after_at,next_after_id}（snake_case）。

const SETTING = { reason: 'fraudulent', account_code: '6280', version: '4', updated_at: '2026-11-01T00:00:00+00:00' };

type Serve = {
	flags?: Flags;
	settings?: unknown[];
	disputes?: unknown[];
	put?: { status: number; body: unknown };
	assign?: { status: number; body: unknown };
};

function serve(state: Serve = {}) {
	const flags = state.flags ?? ALL_FLAGS;
	return mockFetch((url, method) => {
		if (url.pathname === `${BASE}/dispute-settings` && method === 'GET') return { status: 200, body: envelope({ settings: state.settings ?? [] }, flags) };
		if (url.pathname === `${BASE}/dispute-settings` && method === 'PUT') {
			return state.put ?? { status: 200, body: { data: { setting: { reason: 'x', account_code: '6280', version: '5', updated_at: '2026-11-09T00:00:00+00:00' } } } };
		}
		if (url.pathname === `${BASE}/disputes` && method === 'GET') return { status: 200, body: envelope(disputePage(state.disputes ?? []), flags) };
		if (/\/disputes\/[^/]+\/assign$/.test(url.pathname) && method === 'POST') {
			return state.assign ?? { status: 200, body: { data: { assignment: { entry_id: 'e', entry_no: 3, period_id: 'p', created: true } } } };
		}
		return undefined;
	});
}

describe('支払いの取り消しの設定', () => {
	jest.setTimeout(30000);

	it('FREQ-568-AC-05: 科目の設定は勘定を選んで保存でき、権限が無ければ読み取りだけ', async () => {
		const api = serve({ settings: [SETTING] });
		const { unmount } = render(<DisputeSettingsPanel />);
		const region = await screen.findByRole('region', { name: '支払いの取り消しの振り替え先' });
		const select = await within(region).findByLabelText('商品が届かないの振り替え先');
		// 費用か収益の勘定だけを選べる（資産・負債は選べない）。
		const options = within(select as HTMLElement).getAllByRole('option').map((option) => option.textContent);
		expect(options).toContain('6280 支払手数料');
		expect(options.some((text) => text?.startsWith('1010'))).toBe(false);
		// 設定のある原因は今の科目が選ばれている。
		expect(within(region).getByLabelText('不正利用の振り替え先')).toHaveValue('6280');

		fireEvent.change(select, { target: { value: '6280' } });
		fireEvent.click(within(region).getByRole('button', { name: '商品が届かないを保存' }));
		await waitFor(() => expect(api.calls.some((call) => call.method === 'PUT')).toBe(true));
		// 初めて入れる原因は版をnullで送る。
		expect(api.calls.find((call) => call.method === 'PUT')?.body).toEqual({
			reason: 'product_not_received', accountCode: '6280', expectedVersion: null, requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		expect(await within(region).findByText('保存しました。')).toBeInTheDocument();

		// 設定のある原因を変える時は読んだ版を送る。
		fireEvent.change(within(region).getByLabelText('不正利用の振り替え先'), { target: { value: '6020' } });
		fireEvent.click(within(region).getByRole('button', { name: '不正利用を保存' }));
		await waitFor(() => expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(2));
		expect(api.calls.filter((call) => call.method === 'PUT')[1].body).toMatchObject({ reason: 'fraudulent', accountCode: '6020', expectedVersion: '4' });
		unmount();

		serve({ settings: [SETTING], flags: { manageSettings: false, correctEntries: true } });
		render(<DisputeSettingsPanel />);
		const readonly = await screen.findByRole('region', { name: '支払いの取り消しの振り替え先' });
		await within(readonly).findByText('6280 支払手数料');
		expect(within(readonly).queryByRole('combobox')).not.toBeInTheDocument();
		expect(within(readonly).queryByRole('button', { name: /を保存/ })).not.toBeInTheDocument();
	});

	it('FREQ-568-AC-05: 選んだ勘定が使えない時は、固定の文を出して本文を読み切る', async () => {
		const api = serve({ put: { status: 400, body: { code: 'ACCOUNTING_DISPUTE_ACCOUNT_INVALID', error: '選んだ勘定は、支払いの取り消しの振り替え先に使えません。' } } });
		render(<DisputeSettingsPanel />);
		const select = await screen.findByLabelText('不正利用の振り替え先');
		fireEvent.change(select, { target: { value: '6280' } });
		fireEvent.click(screen.getByRole('button', { name: '不正利用を保存' }));
		expect(await screen.findByText('選んだ勘定は、支払いの取り消しの振り替え先に使えません。')).toBeInTheDocument();
		expect(api.calls.find((call) => call.method === 'PUT')?.response.bodyUsed).toBe(true);
	});

	it('FREQ-568-AC-02: 確定・科目の決定待ちの分に振り替える操作が出て、設定が無い時は設定を促す', async () => {
		const api = serve({
			settings: [SETTING],
			disputes: [
				dispute(1, { status: 'lost', reason: 'fraudulent', confirmed_on: '2026-11-03', assigned_account_code: null }),
				dispute(2, { status: 'lost', reason: 'duplicate', confirmed_on: '2026-11-04', assigned_account_code: null }),
				dispute(3, { status: 'lost', reason: 'fraudulent', confirmed_on: '2026-11-02', assigned_account_code: '6280' }),
				dispute(4, { status: 'under_review' }),
			],
		});
		render(<DisputeSettingsPanel />);
		const waiting = await screen.findByRole('list', { name: '科目の決定待ちの取り消し' });
		const items = within(waiting).getAllByRole('listitem');
		// 確定済みで科目がまだの2件だけ。
		expect(items).toHaveLength(2);
		expect(within(items[0]).getByRole('button', { name: 'dp_0001を設定の科目へ振り替える' })).toBeInTheDocument();
		expect(items[0]).toHaveTextContent('6280 支払手数料');
		expect(items[1]).toHaveTextContent('先に上の設定で科目を決めてください');
		expect(within(items[1]).queryByRole('button')).not.toBeInTheDocument();

		fireEvent.click(within(items[0]).getByRole('button', { name: 'dp_0001を設定の科目へ振り替える' }));
		await waitFor(() => expect(api.calls.some((call) => call.url === `${BASE}/disputes/dp_0001/assign`)).toBe(true));
		expect(api.calls.find((call) => call.url === `${BASE}/disputes/dp_0001/assign`)?.body).toEqual({ requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
		expect(await screen.findByText('dp_0001を振り替えました。')).toBeInTheDocument();
	});

	it('FREQ-568-AC-02: 振り替える権限が無い人には振り替えのボタンが出ない', async () => {
		serve({
			settings: [SETTING],
			flags: { manageSettings: true },
			disputes: [dispute(1, { status: 'lost', reason: 'fraudulent', confirmed_on: '2026-11-03', assigned_account_code: null })],
		});
		render(<DisputeSettingsPanel />);
		const waiting = await screen.findByRole('list', { name: '科目の決定待ちの取り消し' });
		expect(within(waiting).queryByRole('button')).not.toBeInTheDocument();
	});

	it('FREQ-568-AC-02: 決定待ちの取り消しが無ければ、無いと出す', async () => {
		serve({ settings: [SETTING], disputes: [dispute(4, { status: 'under_review' })] });
		render(<DisputeSettingsPanel />);
		expect(await screen.findByText('科目の決定待ちの取り消しはありません')).toBeInTheDocument();
	});
});

describe('支払いの取り消しの一覧', () => {
	it('FREQ-568-AC-01: 支払いの取り消しの一覧は「カード会社からの支払いの取り消し」の言葉で出し、チャージバックと書かない', async () => {
		serve({
			disputes: [
				dispute(1, { status: 'needs_response' }),
				dispute(2, { status: 'under_review' }),
				dispute(3, { status: 'lost', confirmed_on: '2026-11-03', assigned_account_code: '6280' }),
				dispute(4, { status: 'won' }),
			],
		});
		render(<DisputeList />);
		const region = await screen.findByRole('region', { name: 'カード会社からの支払いの取り消し' });
		const table = await within(region).findByRole('table', { name: 'カード会社からの支払いの取り消しの一覧' });
		const rows = within(table).getAllByRole('row').slice(1);
		expect(rows).toHaveLength(4);
		expect(rows[0]).toHaveTextContent('カード会社の判断待ち');
		expect(rows[1]).toHaveTextContent('カード会社の判断待ち');
		expect(rows[2]).toHaveTextContent('取り消しが確定した（お金は戻らない）');
		expect(rows[3]).toHaveTextContent('取り消しが取り下げられた（お金が戻った）');
		expect(rows[0]).toHaveTextContent('¥30,000');
		expect(rows[0]).toHaveTextContent('不正利用');
		expect(rows[2]).toHaveTextContent('6280 支払手数料');
		expect(document.body.textContent).not.toMatch(/チャージバック/);
		expect(document.body.textContent).not.toMatch(/[!！]/);
	});

	it('FREQ-568-AC-01: 取り消しが1件も無ければ、無いと出す。続きがあれば「さらに読み込む」で足す', async () => {
		serve({ disputes: [] });
		const { unmount } = render(<DisputeList />);
		expect(await screen.findByText('カード会社からの支払いの取り消しはありません')).toBeInTheDocument();
		unmount();

		const api = mockFetch((url) => {
			if (url.pathname !== `${BASE}/disputes`) return undefined;
			if (url.searchParams.get('afterId')) return { status: 200, body: envelope(disputePage([dispute(2)]), ALL_FLAGS) };
			return { status: 200, body: envelope(disputePage([dispute(1)], { next_after_at: '2026-10-20T03:00:00+00:00', next_after_id: 'dp_0001' }), ALL_FLAGS) };
		});
		render(<DisputeList />);
		fireEvent.click(await screen.findByRole('button', { name: 'さらに読み込む' }));
		await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
		expect(api.fn.mock.calls.some((call) => String(call[0]).includes('afterId=dp_0001'))).toBe(true);
		expect(screen.queryByRole('button', { name: 'さらに読み込む' })).not.toBeInTheDocument();
	});
});
