import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RefundCancellationDialog } from '@/components/cost-profit/refund-cancellation-dialog';
import { ALL_FLAGS, BASE, envelope, uuid } from './accounting-fixtures';
import { mockFetch } from './settings-fixtures';

// 取り消された返金の区分を選ぶ画面（FREQ-579-AC-03・FREQ-584-AC-02）。route は POST /refund-cancellations。
// 画面は、借りの一覧の読み（GET /refund-states）から、この返金の出来事と元を探して、注意書きを出し分ける。

const REFUND_ID = uuid(77);

type Reply = { status: number; body: unknown };
type Row = { eventKind?: string; source?: string };

const ABANDON_ONLY = 'この返金だけをやめたことになります。';
const PRE_CANCEL_TEXT = '発送前の取り消しそのものが取りやめになり、品をまた送れる';

function stateRow(refundId: string, overrides: Row = {}) {
	return {
		refundId, orderId: uuid(600), orderNumber: 'ORD-0000004D', source: 'admin', state: 'canceled', preAmount: 3000, postAmount: 0, owedPre: 0, owedPost: 0, owedReturn: 0,
		eventId: null, eventKind: 'none', canceledAt: '2026-11-08T01:00:00+00:00', ...overrides,
	};
}

type Serve = { decision?: Reply; row?: Row; rowsStatus?: number; pages?: Array<{ rows: unknown[]; next: { at: string; id: string } | null }> };

function serve(config: Serve = {}) {
	return mockFetch((url, method) => {
		if (url.pathname === `${BASE}/refund-states` && method === 'GET') {
			if (config.rowsStatus) return { status: config.rowsStatus, body: { error: '会計の処理に失敗しました。' } };
			const after = url.searchParams.get('afterId');
			const pages = config.pages ?? [{ rows: [stateRow(REFUND_ID, config.row)], next: null }];
			const index = after === null ? 0 : Number(after.slice(-3));
			const page = pages[index] ?? { rows: [], next: null };
			return { status: 200, body: envelope({ refunds: page.rows, nextAfterAt: page.next?.at ?? null, nextAfterId: page.next?.id ?? null }, ALL_FLAGS) };
		}
		if (url.pathname === `${BASE}/refund-cancellations` && method === 'POST') {
			return config.decision ?? { status: 200, body: { data: { decision: { refundId: REFUND_ID, state: 'owed', eventId: null, replayed: false } } } };
		}
		return undefined;
	});
}

/** 出来事の読みが終わる（注意書きが出る）まで待ってから返す */
async function open() {
	const props = { onClose: jest.fn(), onDone: jest.fn() };
	render(<RefundCancellationDialog refundId={REFUND_ID} orderNumber="ORD-0000004D" {...props} />);
	const dialog = screen.getByRole('dialog', { name: '返金の取り消しの区分を選ぶ' });
	await waitFor(() => expect(within(dialog).getByTestId('abandon-note')).toBeInTheDocument());
	return { ...props, dialog };
}

const submit = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: '区分を決める' });
const reason = (dialog: HTMLElement) => within(dialog).getByLabelText('理由（必須）') as HTMLTextAreaElement;

describe('取り消しの区分の画面', () => {
	it('FREQ-584-AC-02: 取り消しの区分の選択は権限のある人だけに出て、2つの選択肢と理由が必要で、送ると二重に押せない', async () => {
		const api = serve();
		const { dialog, onDone } = await open();
		// 選択肢は2つ
		expect(within(dialog).getAllByRole('radio')).toHaveLength(2);
		expect(within(dialog).getByRole('radio', { name: '店が返金をやめた' })).toBeInTheDocument();
		expect(within(dialog).getByRole('radio', { name: '返すつもりのまま返せなかった' })).toBeInTheDocument();
		// 何も選ばない・理由が空なら送れない
		expect(submit(dialog)).toBeDisabled();
		fireEvent.click(within(dialog).getByRole('radio', { name: '返すつもりのまま返せなかった' }));
		expect(submit(dialog)).toBeDisabled();
		fireEvent.change(reason(dialog), { target: { value: '  ' } });
		expect(submit(dialog)).toBeDisabled();
		fireEvent.change(reason(dialog), { target: { value: '振込で返す予定' } });
		expect(submit(dialog)).toBeEnabled();
		// 二重に押しても1回だけ
		fireEvent.click(submit(dialog));
		fireEvent.click(submit(dialog));
		await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
		const posts = api.calls.filter((call) => call.method === 'POST' && !call.url.includes('/api/auth/'));
		expect(posts).toHaveLength(1);
		expect(posts[0].body).toEqual({ refundId: REFUND_ID, kind: 'owed', reason: '振込で返す予定', requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
	});

	it('FREQ-584-AC-02: 選ぶと自動で計上されて行が閉じる旨と、返すつもりの案内（振込の記録）を出す', async () => {
		serve();
		const { dialog } = await open();
		expect(dialog).toHaveTextContent('選ぶと、自動で計上されて、この行は閉じます。');
		expect(dialog).toHaveTextContent('返すつもりのまま残ります。振込で返したら、振込の記録を入れます。');
		// 返品の返金ではないので、返品の画面には触れない
		expect(dialog.textContent).not.toContain('返品の画面');
	});

	it('FREQ-579-AC-03: 返品の返金の取り消しでは、返すつもりの案内に返品の画面でのやり直しも添える', async () => {
		serve({ row: { source: 'return', eventKind: 'return_receipt' } });
		const { dialog } = await open();
		expect(dialog).toHaveTextContent('返すつもりのまま残ります。返品の返金は、返品の画面でやり直すか、振込で返したら振込の記録を入れます。');
	});

	it('FREQ-579-AC-03: 発送前の取り消しの返金で「店が返金をやめた」を選ぶ前に、その取り消しそのものが取りやめになり品をまた送れる場合があることを伝える', async () => {
		serve({ row: { eventKind: 'pre_shipment_cancel' } });
		const { dialog } = await open();
		const note = within(dialog).getByTestId('abandon-note');
		expect(note).toHaveTextContent(PRE_CANCEL_TEXT);
		expect(note).toHaveTextContent('同じ出来事でお金が出た返金や借りがほかにある時は、この返金だけをやめたことになります');
		expect(dialog.textContent).not.toMatch(/[!！]/);
	});

	it.each([['none'], ['return_receipt'], ['holdback_release']])(
		'FREQ-579-AC-03: 出来事が発送前の取り消しではない（%s）返金では、「この返金だけをやめたことになります」だけを伝え、取りやめの話は出さない',
		async (eventKind) => {
			serve({ row: { eventKind } });
			const { dialog } = await open();
			const note = within(dialog).getByTestId('abandon-note');
			expect(note).toHaveTextContent(ABANDON_ONLY);
			expect(note.textContent).not.toContain(PRE_CANCEL_TEXT);
		},
	);

	it('FREQ-579-AC-03: 出来事が読めない時は、取りやめになる場合がある旨も含めて慎重に伝える', async () => {
		serve({ rowsStatus: 500 });
		const failed = await open();
		expect(within(failed.dialog).getByTestId('abandon-note')).toHaveTextContent(PRE_CANCEL_TEXT);
		expect(within(failed.dialog).getByTestId('abandon-note')).toHaveTextContent('同じ出来事でお金が出た返金や借りがほかにある時は');
	});

	it('FREQ-579-AC-03: 一覧に返金が見つからない時（5ページ読んでも無い）も、読むのを5ページで止めて、慎重な文を出し、送れる', async () => {
		const pages = [0, 1, 2, 3, 4, 5].map((n) => ({ rows: [stateRow(uuid(10 + n))], next: { at: '2026-11-07T00:00:00+00:00', id: uuid(1001 + n) } }));
		const api = serve({ pages });
		const { dialog } = await open();
		expect(within(dialog).getByTestId('abandon-note')).toHaveTextContent(PRE_CANCEL_TEXT);
		// ちょうど5回で止める（6ページ目は読まない）
		expect(api.calls.filter((call) => call.url === `${BASE}/refund-states`)).toHaveLength(5);
		fireEvent.click(within(dialog).getByRole('radio', { name: '返すつもりのまま返せなかった' }));
		fireEvent.change(reason(dialog), { target: { value: '振込' } });
		expect(submit(dialog)).toBeEnabled();
	});

	it('FREQ-579-AC-03: 一覧を読んでいる間は「読み込み中」を出し、読み終わると注意書きに替わる', async () => {
		serve();
		render(<RefundCancellationDialog refundId={REFUND_ID} onClose={jest.fn()} onDone={jest.fn()} />);
		const dialog = screen.getByRole('dialog', { name: '返金の取り消しの区分を選ぶ' });
		expect(within(dialog).getByRole('status')).toHaveTextContent('読み込み中');
		expect(within(dialog).queryByTestId('abandon-note')).not.toBeInTheDocument();
		await waitFor(() => expect(within(dialog).getByTestId('abandon-note')).toBeInTheDocument());
		expect(within(dialog).queryByRole('status')).not.toBeInTheDocument();
	});

	it('FREQ-579-AC-03: 一覧の行が壊れた形で返っても、読みが落ちたままにならず、慎重な文を出して送れる', async () => {
		serve({ pages: [{ rows: [null], next: null }] });
		const { dialog } = await open();
		expect(within(dialog).getByTestId('abandon-note')).toHaveTextContent(PRE_CANCEL_TEXT);
		fireEvent.click(within(dialog).getByRole('radio', { name: '返すつもりのまま返せなかった' }));
		fireEvent.change(reason(dialog), { target: { value: '振込' } });
		expect(submit(dialog)).toBeEnabled();
	});

	it('FREQ-579-AC-03: 一覧の2ページ目にある返金も探して出来事を知る', async () => {
		serve({
			pages: [
				{ rows: [stateRow(uuid(1))], next: { at: '2026-11-07T00:00:00+00:00', id: uuid(1001) } },
				{ rows: [stateRow(REFUND_ID, { eventKind: 'pre_shipment_cancel' })], next: null },
			],
		});
		const { dialog } = await open();
		expect(within(dialog).getByTestId('abandon-note')).toHaveTextContent(PRE_CANCEL_TEXT);
	});

	it('FREQ-579-AC-03: Stripe に届いていない error の返金で断られた時は「Stripe への返金をやり直してください。」だけを出し、選択肢も理由の欄も「どちらにあたるか」の文も出さない', async () => {
		serve({ decision: { status: 409, body: { error: 'Stripe への返金をやり直してください。', code: 'UNIT_CANCEL_REVERT_STRIPE_RETRY' } } });
		const { dialog, onDone } = await open();
		expect(dialog).toHaveTextContent('どちらにあたるかを選んでください。');
		fireEvent.click(within(dialog).getByRole('radio', { name: '店が返金をやめた' }));
		fireEvent.change(reason(dialog), { target: { value: 'やめる' } });
		fireEvent.click(submit(dialog));
		expect(await within(dialog).findByRole('alert')).toHaveTextContent('Stripe への返金をやり直してください。');
		// やり直しだけが道なので、選択肢も「区分を決める」も、選ぶ促しも、必須の理由の欄も出さない
		expect(within(dialog).queryAllByRole('radio')).toHaveLength(0);
		expect(within(dialog).queryByRole('radiogroup')).not.toBeInTheDocument();
		expect(within(dialog).queryByRole('button', { name: '区分を決める' })).not.toBeInTheDocument();
		expect(dialog.textContent).not.toContain('どちらにあたるかを選んでください');
		expect(within(dialog).queryByLabelText('理由（必須）')).not.toBeInTheDocument();
		expect(dialog.textContent).not.toContain('何を確かめて決めたかを');
		expect(dialog).toHaveTextContent('この返金は Stripe 側で取り消されました。');
		expect(onDone).not.toHaveBeenCalled();
	});

	it('FREQ-579-AC-03: 元に戻せない断りの時は「返すつもり」を勧める文を出し、選び直せる', async () => {
		const text = 'この取り消しは元に戻せません。「返すつもり」を選んで振込で返してください。';
		serve({ decision: { status: 409, body: { error: text, code: 'UNIT_CANCEL_REVERT_REFUSED' } } });
		const { dialog } = await open();
		fireEvent.click(within(dialog).getByRole('radio', { name: '店が返金をやめた' }));
		fireEvent.change(reason(dialog), { target: { value: 'やめる' } });
		fireEvent.click(submit(dialog));
		expect(await within(dialog).findByRole('alert')).toHaveTextContent(text);
		expect(within(dialog).getByRole('radio', { name: '店が返金をやめた' })).toBeInTheDocument();
	});

	it('FREQ-584-AC-05: 非okの応答の本文を読み切る', async () => {
		const api = serve({ decision: { status: 409, body: { error: 'この返金の取り消しの区分は、もう決まっています。', code: 'ACCOUNTING_REFUND_CANCEL_DECIDED' } } });
		const { dialog } = await open();
		fireEvent.click(within(dialog).getByRole('radio', { name: '返すつもりのまま返せなかった' }));
		fireEvent.change(reason(dialog), { target: { value: '振込' } });
		fireEvent.click(submit(dialog));
		expect(await within(dialog).findByRole('alert')).toHaveTextContent('もう決まっています');
		expect(api.calls.find((call) => call.method === 'POST' && !call.url.includes('/api/auth/'))?.response.bodyUsed).toBe(true);
		expect(api.calls.filter((call) => call.url === `${BASE}/refund-states`).every((call) => call.response.bodyUsed)).toBe(true);
	});
});
