import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RefundCancellationDialog } from '@/components/cost-profit/refund-cancellation-dialog';
import { BASE, uuid } from './accounting-fixtures';
import { mockFetch } from './settings-fixtures';

// 取り消された返金の区分を選ぶ画面（FREQ-579-AC-03・FREQ-584-AC-02）。route は POST /refund-cancellations。

const REFUND_ID = uuid(77);

type Reply = { status: number; body: unknown };

function serve(reply?: Reply) {
	return mockFetch((url, method) => {
		if (url.pathname === `${BASE}/refund-cancellations` && method === 'POST') {
			return reply ?? { status: 200, body: { data: { decision: { refundId: REFUND_ID, state: 'owed', eventId: null, replayed: false } } } };
		}
		return undefined;
	});
}

function open() {
	const props = { onClose: jest.fn(), onDone: jest.fn() };
	render(<RefundCancellationDialog refundId={REFUND_ID} orderNumber="ORD-0000004D" {...props} />);
	return { ...props, dialog: screen.getByRole('dialog', { name: '返金の取り消しの区分を選ぶ' }) };
}

const submit = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: '区分を決める' });
const reason = (dialog: HTMLElement) => within(dialog).getByLabelText('理由（必須）') as HTMLTextAreaElement;

describe('取り消しの区分の画面', () => {
	it('FREQ-584-AC-02: 取り消しの区分の選択は権限のある人だけに出て、2つの選択肢と理由が必要で、送ると二重に押せない', async () => {
		const api = serve();
		const { dialog, onDone } = open();
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

	it('FREQ-579-AC-03: 「店が返金をやめた」を選ぶ前に、発送前の取り消しそのものが取りやめになり品をまた送れる場合があることを伝える', () => {
		serve();
		const { dialog } = open();
		const note = within(dialog).getByTestId('abandon-note');
		expect(note).toHaveTextContent('発送前の取り消しそのものが取りやめになり、品をまた送れる');
		expect(note).toHaveTextContent('同じ出来事でお金が出た返金や借りがほかにある時は、この返金だけをやめたことになります');
		expect(dialog.textContent).not.toMatch(/[!！]/);
	});

	it('FREQ-579-AC-03: Stripe に届いていない error の返金で断られた時は「Stripe への返金をやり直してください。」を出し、「店が返金をやめた」を出さない', async () => {
		serve({ status: 409, body: { error: 'Stripe への返金をやり直してください。', code: 'UNIT_CANCEL_REVERT_REFUSED' } });
		const { dialog, onDone } = open();
		fireEvent.click(within(dialog).getByRole('radio', { name: '店が返金をやめた' }));
		fireEvent.change(reason(dialog), { target: { value: 'やめる' } });
		fireEvent.click(submit(dialog));
		expect(await within(dialog).findByRole('alert')).toHaveTextContent('Stripe への返金をやり直してください。');
		expect(within(dialog).queryByRole('radio', { name: '店が返金をやめた' })).not.toBeInTheDocument();
		expect(onDone).not.toHaveBeenCalled();
	});

	it('FREQ-579-AC-03: 元に戻せない断りの時は「返すつもり」を勧める文を出し、選び直せる', async () => {
		const text = 'この取り消しは元に戻せません。「返すつもり」を選んで振込で返してください。';
		serve({ status: 409, body: { error: text, code: 'UNIT_CANCEL_REVERT_REFUSED' } });
		const { dialog } = open();
		fireEvent.click(within(dialog).getByRole('radio', { name: '店が返金をやめた' }));
		fireEvent.change(reason(dialog), { target: { value: 'やめる' } });
		fireEvent.click(submit(dialog));
		expect(await within(dialog).findByRole('alert')).toHaveTextContent(text);
		expect(within(dialog).getByRole('radio', { name: '店が返金をやめた' })).toBeInTheDocument();
	});

	it('FREQ-584-AC-05: 非okの応答の本文を読み切る', async () => {
		const api = serve({ status: 409, body: { error: 'この返金の取り消しの区分は、もう決まっています。', code: 'ACCOUNTING_REFUND_CANCEL_DECIDED' } });
		const { dialog } = open();
		fireEvent.click(within(dialog).getByRole('radio', { name: '返すつもりのまま返せなかった' }));
		fireEvent.change(reason(dialog), { target: { value: '振込' } });
		fireEvent.click(submit(dialog));
		expect(await within(dialog).findByRole('alert')).toHaveTextContent('もう決まっています');
		expect(api.calls.find((call) => call.method === 'POST' && !call.url.includes('/api/auth/'))?.response.bodyUsed).toBe(true);
	});
});
