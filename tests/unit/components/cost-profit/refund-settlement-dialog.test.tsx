import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RefundSettlementDialog } from '@/components/cost-profit/refund-settlement-dialog';
import { ALL_FLAGS, BASE, envelope, uuid } from './accounting-fixtures';
import { mockFetch } from './settings-fixtures';

// やり直しの返金と借りの結び（FREQ-579-AC-05。preflight #16）。候補は GET /refund-settlements/candidates、結びは POST /refund-settlements。
// 候補は route の答えの形（refundId・amount・succeededOn・eventId・eventKind・sameEvent）。同じ出来事の返金は route が先頭に並べる。

const OWED_ID = uuid(41);
const PAYING_A = uuid(42);
const PAYING_B = uuid(43);

type Reply = { status: number; body: unknown };

const CANDIDATES = [
	{ refundId: PAYING_A, amount: 3000, succeededOn: '2026-11-07', eventId: uuid(71), eventKind: 'return_receipt', sameEvent: true },
	{ refundId: PAYING_B, amount: 5000, succeededOn: '2026-11-05', eventId: null, eventKind: 'none', sameEvent: false },
];

type Serve = { settle?: Reply; candidates?: unknown[]; candidatesStatus?: number };

function serve(config: Serve = {}) {
	return mockFetch((url, method) => {
		if (url.pathname === `${BASE}/refund-settlements/candidates` && method === 'GET') {
			if (config.candidatesStatus) return { status: config.candidatesStatus, body: { error: '会計の処理に失敗しました。' } };
			return { status: 200, body: envelope({ candidates: config.candidates ?? CANDIDATES }, ALL_FLAGS) };
		}
		if (url.pathname === `${BASE}/refund-settlements` && method === 'POST') {
			return config.settle ?? { status: 200, body: { data: { settlement: { settlementId: uuid(9), owedRefundId: OWED_ID, payingRefundId: PAYING_A, preAmount: 0, postAmount: 3000, entryId: uuid(8), entryNo: 3, replayed: false } } } };
		}
		return undefined;
	});
}

function open() {
	const props = { onClose: jest.fn(), onDone: jest.fn() };
	render(<RefundSettlementDialog owed={{ refundId: OWED_ID, orderNumber: 'ORD-00000058', owedPre: 0, owedPost: 3000 }} {...props} />);
	return { ...props, dialog: screen.getByRole('dialog', { name: 'やり直しの返金と結ぶ' }) };
}

const payer = async (dialog: HTMLElement) => (await within(dialog).findByLabelText('やり直しの返金')) as HTMLSelectElement;
const submit = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'やり直しと結ぶ' });

describe('やり直しの結び', () => {
	it('FREQ-579-AC-05: 結びの操作は権限のある人だけに出て、元の返金とやり直しの返金を選ばないと送れず、断られた時は理由の文を出す', async () => {
		const api = serve({ settle: { status: 409, body: { error: 'この出来事は今は仕訳にできません。計上待ちの一覧で理由を確かめてください。', code: 'ACCOUNTING_EVENT_NOT_POSTABLE' } } });
		const { dialog, onDone } = open();
		// 元の返金（借りの方）は固定で見える
		expect(within(dialog).getByText('借りが残る返金 ORD-00000058')).toBeInTheDocument();
		expect(submit(dialog)).toBeDisabled();
		fireEvent.change(await payer(dialog), { target: { value: PAYING_A } });
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

	it('FREQ-579-AC-05: 候補は route から借りの返金の番号で読み、route が返した順（同じ出来事が先頭）に、成功の日と額を添えて出す', async () => {
		const api = serve();
		const { dialog } = open();
		const select = await payer(dialog);
		const options = within(select).getAllByRole('option').map((option) => option.textContent);
		expect(options).toEqual([
			'選んでください',
			'返金 00000000　2026/11/07に成功　¥3,000（同じ出来事）'.replace('00000000', PAYING_A.slice(0, 8).toUpperCase()),
			'返金 00000000　2026/11/05に成功　¥5,000'.replace('00000000', PAYING_B.slice(0, 8).toUpperCase()),
		]);
		const read = api.fn.mock.calls.map((call) => String(call[0])).find((url) => url.includes('/refund-settlements/candidates'));
		expect(new URL(read ?? '', 'https://example.test').searchParams.get('owedRefundId')).toBe(OWED_ID);
		expect(api.calls.find((call) => call.url.includes('/refund-settlements/candidates'))?.method).toBe('GET');
	});

	it('FREQ-579-AC-05: 結べた時は onDone を呼ぶ', async () => {
		serve();
		const first = open();
		fireEvent.change(await payer(first.dialog), { target: { value: PAYING_A } });
		fireEvent.click(submit(first.dialog));
		await waitFor(() => expect(first.onDone).toHaveBeenCalledTimes(1));
	});

	it('FREQ-579-AC-05: 候補が無い時は選べない旨を出し、送れない（発送前の取り消しの借りも同じ）', async () => {
		serve({ candidates: [] });
		const { dialog } = open();
		expect(await within(dialog).findByText('結べるやり直しの返金が見つかりません。先に、やり直しの返金を作ってください。')).toBeInTheDocument();
		expect(submit(dialog)).toBeDisabled();
	});

	it('FREQ-584-AC-05: 候補が読めなかった時は固定の文を出し、本文を読み切り、送れない', async () => {
		const api = serve({ candidatesStatus: 500 });
		const { dialog } = open();
		expect(await within(dialog).findByRole('alert')).toHaveTextContent('会計の処理に失敗しました。');
		expect(submit(dialog)).toBeDisabled();
		expect(api.calls.find((call) => call.url.includes('/candidates'))?.response.bodyUsed).toBe(true);
	});

	it('FREQ-584-AC-05: 非okの応答の本文を読み切る', async () => {
		const api = serve({ settle: { status: 400, body: { error: '入力を確かめてください。', code: 'ACCOUNTING_ARGUMENT_INVALID' } } });
		const { dialog } = open();
		fireEvent.change(await payer(dialog), { target: { value: PAYING_B } });
		fireEvent.click(submit(dialog));
		expect(await within(dialog).findByRole('alert')).toHaveTextContent('入力を確かめてください。');
		expect(api.calls.find((call) => call.method === 'POST' && !call.url.includes('/api/auth/'))?.response.bodyUsed).toBe(true);
	});
});
