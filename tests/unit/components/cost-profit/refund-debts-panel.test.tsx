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
		canceledAt: '2026-11-08T01:00:00+00:00',
		...overrides,
	};
}

type Serve = { refunds?: State[]; flags?: Flags; status?: number; next?: { at: string; id: string } | null };

function serve(config: Serve = {}) {
	return mockFetch((url, method) => {
		if (url.pathname === `${BASE}/refund-states` && method === 'GET') {
			if (config.status) return { status: config.status, body: { error: '会計の処理に失敗しました。' } };
			return {
				status: 200,
				body: envelope({ refunds: config.refunds ?? [state(1)], nextAfterAt: config.next?.at ?? null, nextAfterId: config.next?.id ?? null }, config.flags ?? ALL_FLAGS),
			};
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

	it('FREQ-579-AC-05: 結びの操作は権限のある人だけに出て、発送前の取り消しの借りには出さず、振込の記録へ案内する', async () => {
		serve({ refunds: [state(1), state(2, { source: 'order_cancel', owedPre: 5000, owedPost: 0 })], flags: ALL_FLAGS });
		const region = open();
		const list = await within(region).findByRole('list', { name: '借りが残る返金の一覧' });
		const [post, pre] = within(list).getAllByRole('listitem');
		expect(within(post).getByRole('button', { name: 'やり直しと結ぶ' })).toBeInTheDocument();
		expect(within(pre).queryByRole('button', { name: 'やり直しと結ぶ' })).not.toBeInTheDocument();
		expect(pre.textContent).toContain('発送前の取り消しの返金の借りは、振込で返して記録してください。');
		expect(within(pre).getByRole('button', { name: '振込を記録する' })).toBeInTheDocument();
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
		expect(within(form).getByLabelText('借りの種類')).toHaveValue('return');
	});

	it('FREQ-579-AC-05: やり直しと結ぶを押すと、同じ注文のほかの返金を候補にした画面が開く', async () => {
		serve({ refunds: [state(1), state(1, { refundId: uuid(550), state: 'succeeded', owedPost: 0 })] });
		const region = open();
		const list = await within(region).findByRole('list', { name: '借りが残る返金の一覧' });
		fireEvent.click(within(list).getByRole('button', { name: 'やり直しと結ぶ' }));
		const dialog = await screen.findByRole('dialog', { name: 'やり直しの返金と結ぶ' });
		await waitFor(() => expect(within(within(dialog).getByLabelText('やり直しの返金')).getAllByRole('option')).toHaveLength(2));
	});

	it('FREQ-584-AC-05: 読めなかった時は固定の文を出す', async () => {
		serve({ status: 500 });
		const region = open();
		expect(await within(region).findByRole('alert')).toHaveTextContent('会計の処理に失敗しました。');
	});
});
