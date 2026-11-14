import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RefundDebtsPanel } from '@/components/cost-profit/refund-debts-panel';
import { ALL_FLAGS, BASE, envelope, uuid, type Flags } from './accounting-fixtures';
import { mockFetch } from './settings-fixtures';

// 借りが残る返金の一覧（FREQ-579-AC-04・AC-05）。route の答えは store が直した camelCase。

type State = Record<string, unknown>;

function state(n: number, overrides: State = {}): State {
	return {
		refundId: uuid(500 + n),
		orderId: uuid(600 + n),
		orderNumber: `ORD-0000006${n}`,
		source: 'return',
		state: 'owed',
		preAmount: 0,
		postAmount: 3000,
		owedPre: 0,
		owedPost: 3000,
		owedReturn: 0,
		eventKind: 'none',
		canceledAt: '2026-11-08T01:00:00+00:00',
		...overrides,
	};
}

type Serve = { refunds?: State[]; flags?: Flags; status?: number; next?: { at: string; id: string } | null; candidates?: unknown[] };

function serve(config: Serve = {}) {
	return mockFetch((url, method) => {
		if (url.pathname === `${BASE}/refund-states` && method === 'GET') {
			if (config.status) return { status: config.status, body: { error: '会計の処理に失敗しました。' } };
			return {
				status: 200,
				body: envelope({ refunds: config.refunds ?? [state(1)], nextAfterAt: config.next?.at ?? null, nextAfterId: config.next?.id ?? null }, config.flags ?? ALL_FLAGS),
			};
		}
		if (url.pathname === `${BASE}/refund-settlements/candidates` && method === 'GET') {
			return { status: 200, body: envelope({ candidates: config.candidates ?? [] }, config.flags ?? ALL_FLAGS) };
		}
		return undefined;
	});
}

function open() {
	render(<RefundDebtsPanel />);
	return screen.getByRole('region', { name: '返金の借りと振込の記録' });
}

describe('借りが残る返金の一覧', () => {
	it('FREQ-579-AC-05: 同じ返金が2行返っても1つにまとめて出す（返金の番号で数える）', async () => {
		serve({ refunds: [state(1), state(1, { owedPost: 3000 }), state(2, { owedPost: 1000 })] });
		const region = open();
		const list = await within(region).findByRole('list', { name: '借りが残る返金の一覧' });
		const items = within(list).getAllByRole('listitem');
		expect(items).toHaveLength(2);
		expect(items[0].textContent).toContain('ORD-00000061');
		expect(items[1].textContent).toContain('ORD-00000062');
	});

	it('FREQ-579-AC-05: 取り消しの区分待ちの返金（canceled）はここに出さず、計上待ちのタブで選ぶと案内する', async () => {
		serve({ refunds: [state(1), state(2, { state: 'canceled', owedPost: 0 })] });
		const region = open();
		const list = await within(region).findByRole('list', { name: '借りが残る返金の一覧' });
		expect(within(list).getAllByRole('listitem')).toHaveLength(1);
		expect(region.textContent).toContain('取り消しの区分を選ぶ返金は、計上待ちのタブに出ます');
	});

	it('FREQ-579-AC-05: 結びの操作は権限のある人だけに出て、発送前の取り消しの出来事の借りには出さず、振込の記録へ案内する（出荷前の分の借りでも、その出来事でなければ結べる）', async () => {
		serve({
			refunds: [
				state(1),
				state(2, { source: 'order_cancel', owedPre: 5000, owedPost: 0, eventKind: 'pre_shipment_cancel', eventId: uuid(700) }),
				state(3, { source: 'admin', owedPre: 5000, owedPost: 0 }),
				state(4, { source: 'admin', owedPre: 2000, owedPost: 1000 }),
			],
			flags: ALL_FLAGS,
		});
		const region = open();
		const list = await within(region).findByRole('list', { name: '借りが残る返金の一覧' });
		const [post, preCancel, pre, mixed] = within(list).getAllByRole('listitem');
		expect(within(post).getByRole('button', { name: 'やり直しと結ぶ' })).toBeInTheDocument();
		expect(within(preCancel).queryByRole('button', { name: 'やり直しと結ぶ' })).not.toBeInTheDocument();
		expect(preCancel.textContent).toContain('発送前の取り消しの返金の借りは、振込で返して記録してください。');
		expect(within(preCancel).getByRole('button', { name: '振込を記録する' })).toBeInTheDocument();
		// 出荷前の分の借りでも、発送前の取り消しの出来事でなければ結べ、案内も出さない
		expect(within(pre).getByRole('button', { name: 'やり直しと結ぶ' })).toBeInTheDocument();
		expect(pre.textContent).not.toContain('発送前の取り消しの返金の借りは');
		// 出荷前と出荷後の両方の借りも結べる
		expect(within(mixed).getByRole('button', { name: 'やり直しと結ぶ' })).toBeInTheDocument();
	});

	it('FREQ-579-AC-04: 返すつもりのまま残る返品の返金の行は返品の借りとして出て、origin が return の振込の記録を開く（結ぶ操作は出さない）', async () => {
		serve({ refunds: [state(5, { source: 'return', state: 'failed', owedPre: 0, owedPost: 0, owedReturn: 16875, eventKind: 'return_receipt', eventId: uuid(701) })] });
		const region = open();
		const list = await within(region).findByRole('list', { name: '借りが残る返金の一覧' });
		const [item] = within(list).getAllByRole('listitem');
		expect(item.textContent).toContain('返品の返金の借り ¥16,875');
		expect(item.textContent).toContain('返品の返金の借りは、振込で返して記録してください。');
		expect(within(item).queryByRole('button', { name: 'やり直しと結ぶ' })).not.toBeInTheDocument();
		fireEvent.click(within(item).getByRole('button', { name: '振込を記録する' }));
		const form = await within(region).findByRole('group', { name: '振込で返した分を記録する' });
		expect(within(form).getByLabelText('借りの種類')).toHaveValue('return');
	});

	it('FREQ-579-AC-04: 1つの行に借りの枝が複数ある時は、枝ごとに振込の記録のボタンを出す', async () => {
		serve({ refunds: [state(6, { owedPre: 2000, owedPost: 1000, owedReturn: 500 })] });
		const region = open();
		const list = await within(region).findByRole('list', { name: '借りが残る返金の一覧' });
		const [item] = within(list).getAllByRole('listitem');
		const cases = [
			['振込を記録する（出荷前の返金）', 'pre_shipment'],
			['振込を記録する（出荷後の返金・値引き）', 'post_shipment'],
			['振込を記録する（返品の返金）', 'return'],
		];
		for (const [name, origin] of cases) {
			fireEvent.click(within(item).getByRole('button', { name }));
			const form = await within(region).findByRole('group', { name: '振込で返した分を記録する' });
			expect(within(form).getByLabelText('借りの種類')).toHaveValue(origin);
		}
	});

	it('FREQ-584-AC-02: 権限が無い人にはボタンを出さず、読み取りだけにする', async () => {
		serve({ flags: { manageSettings: false } });
		const region = open();
		const list = await within(region).findByRole('list', { name: '借りが残る返金の一覧' });
		expect(within(list).queryByRole('button')).not.toBeInTheDocument();
	});

	it('FREQ-579-AC-04: 振込を記録するを押すと、その注文と借りの種類を入れた記録の欄が開く', async () => {
		serve({ refunds: [state(1)] });
		const region = open();
		const list = await within(region).findByRole('list', { name: '借りが残る返金の一覧' });
		fireEvent.click(within(list).getByRole('button', { name: '振込を記録する' }));
		const form = await within(region).findByRole('group', { name: '振込で返した分を記録する' });
		expect(within(form).getByLabelText('注文')).toHaveValue(uuid(601));
		// 借りの種類は借りが載る枝で決める（出荷後の分は出荷後。返金の元が返品でも変えない）
		expect(within(form).getByLabelText('借りの種類')).toHaveValue('post_shipment');
	});

	it('FREQ-579-AC-05: やり直しと結ぶを押すと、route が返した候補（同じ出来事の返金が先頭）を出した画面が開く', async () => {
		const candidates = [
			{ refundId: uuid(551), amount: 3000, succeededOn: '2026-11-07', eventId: uuid(702), eventKind: 'return_receipt', sameEvent: true },
			{ refundId: uuid(552), amount: 3000, succeededOn: '2026-11-06', eventId: null, eventKind: 'none', sameEvent: false },
		];
		const api = serve({ refunds: [state(1)], candidates });
		const region = open();
		const list = await within(region).findByRole('list', { name: '借りが残る返金の一覧' });
		fireEvent.click(within(list).getByRole('button', { name: 'やり直しと結ぶ' }));
		const dialog = await screen.findByRole('dialog', { name: 'やり直しの返金と結ぶ' });
		await waitFor(() => expect(within(within(dialog).getByLabelText('やり直しの返金')).getAllByRole('option')).toHaveLength(3));
		const texts = within(within(dialog).getByLabelText('やり直しの返金')).getAllByRole('option').map((option) => option.textContent);
		expect(texts[1]).toContain('同じ出来事');
		expect(texts[2]).not.toContain('同じ出来事');
		// 候補は借りの返金の番号で読む（ほかの行から作らない）
		const read = api.fn.mock.calls.map((call) => String(call[0])).find((url) => url.includes('/refund-settlements/candidates'));
		expect(new URL(read ?? '', 'https://example.test').searchParams.get('owedRefundId')).toBe(uuid(501));
	});

	it('FREQ-584-AC-05: 読めなかった時は固定の文を出す', async () => {
		serve({ status: 500 });
		const region = open();
		expect(await within(region).findByRole('alert')).toHaveTextContent('会計の処理に失敗しました。');
	});

	it('FREQ-579-AC-04: 発送前の分の借りの行は、振込の記録の借りの種類が出荷前になる', async () => {
		serve({ refunds: [state(2, { source: 'order_cancel', owedPre: 5000, owedPost: 0 })] });
		const region = open();
		const list = await within(region).findByRole('list', { name: '借りが残る返金の一覧' });
		fireEvent.click(within(list).getByRole('button', { name: '振込を記録する' }));
		const form = await within(region).findByRole('group', { name: '振込で返した分を記録する' });
		expect(within(form).getByLabelText('借りの種類')).toHaveValue('pre_shipment');
	});
});
