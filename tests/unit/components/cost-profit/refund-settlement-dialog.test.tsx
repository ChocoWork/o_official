import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RefundSettlementDialog } from '@/components/cost-profit/refund-settlement-dialog';
import { BASE, uuid } from './accounting-fixtures';
import { mockFetch } from './settings-fixtures';

// やり直しの返金と借りの結び（FREQ-579-AC-05。preflight #16）。route は POST /refund-settlements。

const OWED_ID = uuid(41);
const PAYING_A = uuid(42);
const PAYING_B = uuid(43);

type Reply = { status: number; body: unknown };

function serve(reply?: Reply) {
	return mockFetch((url, method) => {
		if (url.pathname === `${BASE}/refund-settlements` && method === 'POST') {
			return reply ?? { status: 200, body: { data: { settlement: { settlementId: uuid(9), owedRefundId: OWED_ID, payingRefundId: PAYING_A, preAmount: 0, postAmount: 3000, entryId: uuid(8), entryNo: 3, replayed: false } } } };
		}
		return undefined;
	});
}

const CANDIDATES = [
	{ refundId: PAYING_B, label: '返金 BBBBBBBB（同じ注文の別の出来事）', sameEvent: false },
	{ refundId: PAYING_A, label: '返金 AAAAAAAA', sameEvent: true },
];

function open(candidates = CANDIDATES) {
	const props = { onClose: jest.fn(), onDone: jest.fn() };
	render(<RefundSettlementDialog owed={{ refundId: OWED_ID, orderNumber: 'ORD-00000058', owedPre: 0, owedPost: 3000 }} candidates={candidates} {...props} />);
	return { ...props, dialog: screen.getByRole('dialog', { name: 'やり直しの返金と結ぶ' }) };
}

const payer = (dialog: HTMLElement) => within(dialog).getByLabelText('やり直しの返金') as HTMLSelectElement;
const submit = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'やり直しと結ぶ' });

describe('やり直しの結び', () => {
	it('FREQ-579-AC-05: 結びの操作は権限のある人だけに出て、元の返金とやり直しの返金を選ばないと送れず、断られた時は理由の文を出す', async () => {
		const api = serve({ status: 409, body: { error: 'この出来事は今は仕訳にできません。計上待ちの一覧で理由を確かめてください。', code: 'ACCOUNTING_EVENT_NOT_POSTABLE' } });
		const { dialog, onDone } = open();
		// 元の返金（借りの方）は固定で見える
		expect(within(dialog).getByText('借りが残る返金 ORD-00000058')).toBeInTheDocument();
		expect(submit(dialog)).toBeDisabled();
		fireEvent.change(payer(dialog), { target: { value: PAYING_A } });
		expect(submit(dialog)).toBeEnabled();
		fireEvent.click(submit(dialog));
		fireEvent.click(submit(dialog));
		const alert = await within(dialog).findByRole('alert');
		expect(alert).toHaveTextContent('借りの仕訳がまだ入っていないか、返す額が借りの残高を超えています。');
		expect(onDone).not.toHaveBeenCalled();
		const posts = api.calls.filter((call) => call.method === 'POST' && !call.url.includes('/api/auth/'));
		expect(posts).toHaveLength(1);
		expect(posts[0].body).toEqual({ owedRefundId: OWED_ID, payingRefundId: PAYING_A, requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
		expect(posts[0].response.bodyUsed).toBe(true);
	});

	it('FREQ-579-AC-05: 同じ出来事の返金を候補の先頭に出す', () => {
		serve();
		const { dialog } = open();
		const options = within(payer(dialog)).getAllByRole('option').map((option) => option.textContent);
		expect(options[0]).toBe('選んでください');
		expect(options[1]).toContain('AAAAAAAA');
		expect(options[1]).toContain('同じ出来事');
		expect(options[2]).toContain('BBBBBBBB');
	});

	it('FREQ-579-AC-05: 結べた時は onDone を呼ぶ', async () => {
		serve();
		const first = open();
		fireEvent.change(payer(first.dialog), { target: { value: PAYING_A } });
		fireEvent.click(submit(first.dialog));
		await waitFor(() => expect(first.onDone).toHaveBeenCalledTimes(1));
	});

	it('FREQ-579-AC-05: 候補が無い時は選べない旨を出し、送れない', () => {
		serve();
		const { dialog } = open([]);
		expect(within(dialog).getByText('結べるやり直しの返金が見つかりません。先に、やり直しの返金を作ってください。')).toBeInTheDocument();
		expect(submit(dialog)).toBeDisabled();
	});

	it('FREQ-584-AC-05: 非okの応答の本文を読み切る', async () => {
		const api = serve({ status: 400, body: { error: '入力を確かめてください。', code: 'ACCOUNTING_ARGUMENT_INVALID' } });
		const { dialog } = open();
		fireEvent.change(payer(dialog), { target: { value: PAYING_B } });
		fireEvent.click(submit(dialog));
		expect(await within(dialog).findByRole('alert')).toHaveTextContent('入力を確かめてください。');
		expect(api.calls.find((call) => call.method === 'POST' && !call.url.includes('/api/auth/'))?.response.bodyUsed).toBe(true);
	});
});
