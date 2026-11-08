import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ShippingOptionsSection, YearEndShipmentsPanel } from '@/components/cost-profit/year-end-shipments-panel';
import { ALL_FLAGS, BASE, envelope, uuid, type Flags } from './accounting-fixtures';
import { mockFetch } from './settings-fixtures';

// 年末の出荷の一覧（FREQ-574）。route の答えは snake_case: {slips,next_after_date,next_after_slip,options,carrier_gaps}。

const OPTIONS_OFF = { carrier_date_check_enabled: false, changed_at: null, changed_by: null, version: '1' };

function slip(n: number, overrides: Record<string, unknown> = {}) {
	return {
		slip_id: uuid(900 + n),
		number: `SL-20261228-000${n}`,
		shipment_date: '2026-12-28',
		confirmed_at: '2026-12-28T05:00:00+00:00',
		stage: 'confirmed',
		shipping_carrier: 'yamato',
		tracking_number: `1234-5678-90${n}`,
		checked_at: null,
		checked_by: null,
		check_stale: false,
		...overrides,
	};
}

type Serve = {
	flags?: Flags;
	slips?: unknown[];
	next?: { date: string; slip: string } | null;
	options?: unknown;
	gaps?: unknown;
	restartOnCursor?: boolean;
	put?: { status: number; body: unknown };
};

function serve(state: Serve = {}) {
	const flags = state.flags ?? ALL_FLAGS;
	let slips = state.slips ?? [slip(1)];
	const api = mockFetch((url, method, body) => {
		if (url.pathname !== `${BASE}/year-end-shipments`) return undefined;
		if (method === 'GET') {
			if (state.restartOnCursor && url.searchParams.get('afterDate')) {
				return { status: 409, body: { code: 'ACCOUNTING_LIST_RESTART', error: '一覧が変わりました。最初から読み直してください。' } };
			}
			return {
				status: 200,
				body: envelope({
					slips,
					next_after_date: state.next?.date ?? null,
					next_after_slip: state.next?.slip ?? null,
					options: state.options ?? OPTIONS_OFF,
					carrier_gaps: state.gaps ?? { enabled: false, slips: [], has_more: false },
				}, flags),
			};
		}
		if (method === 'POST') {
			const slipId = (body as { slipId: string }).slipId;
			slips = slips.map((row) => ((row as { slip_id: string }).slip_id === slipId
				? { ...(row as object), checked_at: '2026-12-29T01:00:00+00:00', checked_by: uuid(11), check_stale: false } : row));
			return { status: 200, body: { data: { check: { slip_id: slipId, created: true } } } };
		}
		if (method === 'PUT') return state.put ?? { status: 200, body: { data: { options: { ...OPTIONS_OFF, carrier_date_check_enabled: true, version: '2' } } } };
		return undefined;
	});
	return api;
}

const marks = (api: ReturnType<typeof serve>) => api.calls.filter((call) => call.method === 'POST' && call.url === `${BASE}/year-end-shipments`);
const gets = (api: ReturnType<typeof serve>) => api.fn.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('year-end-shipments?'));

describe('年末の出荷の一覧', () => {
	jest.setTimeout(30000);

	it('FREQ-574-AC-01: 年末の出荷の一覧に運送会社・追跡番号・出荷した日が出て、確かめた印を付けられる', async () => {
		const api = serve({ slips: [slip(1), slip(2, { stage: 'cancelled', shipping_carrier: null, tracking_number: null })] });
		render(<YearEndShipmentsPanel today="2026-12-28" />);
		const region = await screen.findByRole('region', { name: '年末の出荷の確認' });
		// 範囲の既定は12月25日〜翌年1月10日。
		expect(within(region).getByLabelText('開始日')).toHaveValue('2026-12-25');
		expect(within(region).getByLabelText('終了日')).toHaveValue('2027-01-10');
		const table = await within(region).findByRole('table', { name: '年末の発送票' });
		expect(gets(api)[0]).toContain('from=2026-12-25&to=2027-01-10');
		const rows = within(table).getAllByRole('row').slice(1);
		expect(rows[0]).toHaveTextContent('SL-20261228-0001');
		expect(rows[0]).toHaveTextContent('ヤマト運輸');
		expect(rows[0]).toHaveTextContent('1234-5678-901');
		expect(rows[0]).toHaveTextContent('2026/12/28');
		expect(rows[0]).toHaveTextContent('確定');
		expect(rows[1]).toHaveTextContent('取り消し');
		expect(rows[0]).toHaveTextContent('まだ確かめていません');

		fireEvent.click(within(rows[0]).getByRole('button', { name: 'SL-20261228-0001を確かめた' }));
		await waitFor(() => expect(marks(api)).toHaveLength(1));
		expect(marks(api)[0].body).toEqual({
			slipId: uuid(901), note: null, requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		// 印を付けたら読み直し、確かめ済みと出る。
		await waitFor(() => expect(within(screen.getAllByRole('row')[1]).getByText(/確かめ済み 2026\/12\/29/)).toBeInTheDocument());
		expect(screen.queryByRole('button', { name: 'SL-20261228-0001を確かめた' })).not.toBeInTheDocument();
	});

	it('FREQ-574-AC-01: 確かめた後で日付か追跡が変わった行は、その旨を出して確かめ直せる', async () => {
		serve({ slips: [slip(1, { checked_at: '2026-12-27T01:00:00+00:00', check_stale: true })] });
		render(<YearEndShipmentsPanel today="2026-12-28" />);
		const row = (await screen.findAllByRole('row'))[1];
		expect(row).toHaveTextContent('確かめた後で日付か追跡が変わりました');
		expect(within(row).getByRole('button', { name: 'SL-20261228-0001をもう一度確かめた' })).toBeInTheDocument();
	});

	it('FREQ-574-AC-01: 確かめる権限が無い人には、印の操作が出ない', async () => {
		serve({ flags: { manageSettings: true, correctEntries: true } });
		render(<YearEndShipmentsPanel today="2026-12-28" />);
		await screen.findByRole('table', { name: '年末の発送票' });
		expect(screen.queryByRole('button', { name: /確かめた$/ })).not.toBeInTheDocument();
	});

	it('FREQ-574-AC-01: 1月の初めなら範囲の既定は前の年の末から。次のページの目印が古い409は最初から読み直す', async () => {
		const api = serve({ next: { date: '2026-12-28', slip: uuid(901) }, restartOnCursor: true });
		render(<YearEndShipmentsPanel today="2027-01-05" />);
		const region = await screen.findByRole('region', { name: '年末の出荷の確認' });
		expect(within(region).getByLabelText('開始日')).toHaveValue('2026-12-25');
		fireEvent.click(await within(region).findByRole('button', { name: '次のページ' }));
		expect(await within(region).findByText('一覧が変わったため、最初から読み直しました')).toBeInTheDocument();
		const urls = gets(api);
		expect(urls.some((url) => url.includes('afterDate=2026-12-28') && url.includes(`afterSlip=${uuid(901)}`))).toBe(true);
		// 最後の読みは目印なし（先頭から）。
		expect(urls.at(-1)).not.toContain('afterDate');
		expect(api.calls.find((call) => call.response.status === 409)?.response.bodyUsed).toBe(true);
	});

	it('FREQ-574-AC-03: 運送会社の受付日のオプションは既定がオフで、オンの時だけずれの一覧が出る', async () => {
		serve();
		const { unmount } = render(<YearEndShipmentsPanel today="2026-12-28" />);
		const off = await screen.findByText('運送会社の受付日との照らし合わせはオフです');
		expect(off).toBeInTheDocument();
		expect(screen.queryByRole('table', { name: '運送会社の受付日とのずれ' })).not.toBeInTheDocument();
		unmount();

		serve({
			options: { ...OPTIONS_OFF, carrier_date_check_enabled: true, version: '2' },
			gaps: {
				enabled: true,
				slips: [{ slip_id: uuid(901), number: 'SL-20261228-0001', shipment_date: '2026-12-28', carrier_accepted_date: '2026-12-30', gap_days: 2 }],
				has_more: true,
			},
		});
		render(<YearEndShipmentsPanel today="2026-12-28" />);
		const table = await screen.findByRole('table', { name: '運送会社の受付日とのずれ' });
		const row = within(table).getAllByRole('row')[1];
		expect(row).toHaveTextContent('SL-20261228-0001');
		expect(row).toHaveTextContent('2026/12/28');
		expect(row).toHaveTextContent('2026/12/30');
		expect(row).toHaveTextContent('2日後');
		expect(screen.getByText('100件を超えました。範囲を狭めてください')).toBeInTheDocument();
	});

	it('FREQ-574-AC-03: 範囲を選び直して出すと、その範囲で読み直す。60日を超える範囲は送らない', async () => {
		const api = serve();
		render(<YearEndShipmentsPanel today="2026-12-28" />);
		const region = await screen.findByRole('region', { name: '年末の出荷の確認' });
		await within(region).findByRole('table', { name: '年末の発送票' });
		fireEvent.change(within(region).getByLabelText('終了日'), { target: { value: '2027-03-01' } });
		fireEvent.click(within(region).getByRole('button', { name: 'この範囲で出す' }));
		expect(await within(region).findByText('範囲は60日までです。')).toBeInTheDocument();
		const before = gets(api).length;
		fireEvent.change(within(region).getByLabelText('終了日'), { target: { value: '2026-12-31' } });
		fireEvent.click(within(region).getByRole('button', { name: 'この範囲で出す' }));
		await waitFor(() => expect(gets(api).length).toBe(before + 1));
		expect(gets(api).at(-1)).toContain('from=2026-12-25&to=2026-12-31');
	});
});

describe('運送会社の受付日のオプション', () => {
	it('FREQ-574-AC-03: 設定の画面では既定がオフで、追跡の登録が動いてから使える注意を出し、権限のある人だけがオンにできる', async () => {
		const api = serve();
		const { unmount } = render(<ShippingOptionsSection today="2026-12-28" />);
		const region = await screen.findByRole('region', { name: '運送会社の受付日' });
		const toggle = await within(region).findByRole('checkbox', { name: '運送会社の受付日との照らし合わせを使う' });
		expect(toggle).not.toBeChecked();
		expect(within(region).getByText('追跡の登録が動いてから使えます')).toBeInTheDocument();
		fireEvent.click(toggle);
		fireEvent.click(within(region).getByRole('button', { name: 'オプションを保存' }));
		await waitFor(() => expect(api.calls.some((call) => call.method === 'PUT')).toBe(true));
		expect(api.calls.find((call) => call.method === 'PUT')?.body).toEqual({
			carrierDateCheckEnabled: true, expectedVersion: '1', requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		expect(await within(region).findByText('保存しました。')).toBeInTheDocument();
		unmount();

		serve({ flags: { manageSettings: false, manageFinance: true } });
		render(<ShippingOptionsSection today="2026-12-28" />);
		const readonly = await screen.findByRole('region', { name: '運送会社の受付日' });
		await within(readonly).findByText('今はオフです');
		expect(within(readonly).queryByRole('checkbox')).not.toBeInTheDocument();
		expect(within(readonly).queryByRole('button', { name: 'オプションを保存' })).not.toBeInTheDocument();
	});

	it('FREQ-574-AC-03: 版が違う時は読み直しを案内し、本文を読み切る', async () => {
		const api = serve({ put: { status: 409, body: { code: 'ACCOUNTING_VERSION_CONFLICT', error: '設定が変わりました。読み直してください。' } } });
		render(<ShippingOptionsSection today="2026-12-28" />);
		const toggle = await screen.findByRole('checkbox', { name: '運送会社の受付日との照らし合わせを使う' });
		fireEvent.click(toggle);
		fireEvent.click(screen.getByRole('button', { name: 'オプションを保存' }));
		expect(await screen.findByText('設定が変わりました。読み直してください。')).toBeInTheDocument();
		expect(api.calls.find((call) => call.method === 'PUT')?.response.bodyUsed).toBe(true);
		expect(screen.getByRole('button', { name: '読み直す' })).toBeInTheDocument();
	});
});
