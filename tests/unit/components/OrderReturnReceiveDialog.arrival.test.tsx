import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OrderReturnDetail, OrderReturnLineDetail } from '@/lib/orders/returns/return-types';
import { toJstDate } from '@/lib/accounting/jst-date';
import { RETURN_ARRIVAL_CORRECTION_ONLY_NOTE, RETURN_ARRIVAL_INVALID_NOTE_COMMON } from '@/lib/accounting/return-refund-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));
// 見込みの窓口の本文（第2引数）を残して、届いた日が入らないことを確かめる
const mockEstimateBodies: Array<Record<string, unknown> | null> = [];
jest.mock('@/hooks/useUnitPricingEstimate', () => ({
	useUnitPricingEstimate: (url: string | null, body: Record<string, unknown> | null) => {
		mockEstimateBodies.push(body);
		return url ? { status: 'ready', estimate: { legacy: true } } : { status: 'idle' };
	},
}));

import OrderReturnReceiveDialog from '@/components/OrderReturnReceiveDialog';

// 受け取りの画面の届いた日と判断待ちの止め（FREQ-584。会計の計画3 Task 11）。

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const RETURN_ID = 'ret-0001';
const LABEL = 'ORD-A1B2C3D4-R1';
const TITLE = `受け取る（${LABEL}）`;
const RECEIVE_URL = `/api/admin/returns/${RETURN_ID}/receive`;
const HOLD_TEXT = 'カード会社の判断待ちのため、今は返金できません。受け取りだけ記録できます';
const today = () => toJstDate(new Date());

function json(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const BLOUSE: OrderReturnLineDetail = {
	id: 'line-blouse', fulfillmentId: 'ful-1', fulfillmentNumber: 1, orderItemId: 'item-blouse',
	itemName: 'シルクブラウス', color: '白', size: 'M', quantity: 2, reason: 'size_too_small', reasonNote: null,
	resolution: 'refund', exchange: null,
	progress: { restocked: 0, notRestocked: 0, pendingInspection: 0, sentBack: 0, missing: 0, processed: 0, unprocessed: 2, exchanged: 0, refundCovered: 0, refundWaived: 0, refundWaiting: 0 },
	refundAmountsByCount: [12000, 24000], refundWaitingAmount: 0, customerNote: null, requestedResolution: null, requestedExchange: null, photos: [], returnIneligible: false,
};

function returnDetail(restockingFeePercent = 0): OrderReturnDetail {
	return {
		id: RETURN_ID, number: 1, label: LABEL, status: 'open', source: 'shop', displayStatus: 'in_progress', marks: ['awaiting_items'],
		returnMethod: 'customer_ships', returnShippingPayer: 'customer', returnCarrier: null, returnTrackingNumber: null,
		fees: { returnShippingFee: 0, restockingFeePercent, exchangeFee: 0, exchangeShippingFee: 0, feeDueAmount: 0, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null },
		firstReceiptDone: false, firstExchangeReceiptDone: false, shopNote: null, notifyCustomer: true,
		createdAt: '2026-10-12T01:00:00.000Z', createdByEmail: 'admin@example.com', closedAt: null, cancelledAt: null, requestedAt: null, approvedAt: null, approvedByEmail: null, declinedAt: null, declineReason: null, declineMessage: null,
		lines: [BLOUSE], refunds: [], receipts: [], exchangeItems: [],
	};
}

function receiveData(overrides: Record<string, unknown> = {}) {
	return { receiptId: 'receipt-1', returnStatus: 'open', refundId: null, refundAmount: null, refundStatus: null, feeDueAmount: 0, replayed: false, ...overrides };
}

type Open = { disputeHold?: boolean; restockingFeePercent?: number; replies?: Array<Response | Promise<Response>> };

async function openDialog(options: Open = {}) {
	const replies = [...(options.replies ?? [])];
	mockClientFetch.mockImplementation(async (input: string) => {
		if (String(input) === `/api/admin/orders/${ORDER_ID}/returns`) {
			return json({
				data: {
					returns: [returnDetail(options.restockingFeePercent ?? 0)], canRefund: true, returnableUnits: 0, refundableAmount: 54800, refundableShipping: 800,
					...(options.disputeHold === undefined ? {} : { disputeHold: options.disputeHold }),
				},
			});
		}
		if (String(input) === RECEIVE_URL) return replies.shift() ?? json({ data: receiveData() });
		return json({ error: 'not mocked' }, 404);
	});
	const props = { onClose: jest.fn(), onDone: jest.fn(), onUncertain: jest.fn() };
	render(<OrderReturnReceiveDialog orderId={ORDER_ID} returnId={RETURN_ID} {...props} />);
	await waitFor(() => expect(screen.queryByText('読み込み中です...')).not.toBeInTheDocument());
	const dialog = screen.getByRole('dialog', { name: TITLE });
	return { ...props, dialog };
}

const unitRows = (dialog: HTMLElement) => within(within(dialog).getByRole('list', { name: '受け取る品' })).getAllByRole('listitem');
const primaryButton = (dialog: HTMLElement) => dialog.querySelector('button[type="submit"]') as HTMLButtonElement;
const arrivedInput = (dialog: HTMLElement) => within(dialog).getByLabelText('届いた日') as HTMLInputElement;

function receiveAll(dialog: HTMLElement) {
	unitRows(dialog).forEach((row) => {
		fireEvent.click(within(row).getByRole('checkbox', { name: '届いた' }));
		fireEvent.change(within(row).getByRole('combobox', { name: '品の状態' }), { target: { value: 'restocked' } });
	});
}

const postBodies = () =>
	mockClientFetch.mock.calls
		.filter(([url]) => String(url) === RECEIVE_URL)
		.map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);

beforeEach(() => {
	mockClientFetch.mockReset();
	mockEstimateBodies.length = 0;
});

describe('受け取りの画面の届いた日', () => {
	it('FREQ-584-AC-01: 受け取りの画面で届いた日を選べ、既定は今日で、未来の日は選べない', async () => {
		const { dialog, onDone } = await openDialog();
		expect(arrivedInput(dialog).value).toBe(today());
		expect(arrivedInput(dialog).max).toBe(today());
		receiveAll(dialog);
		// 既定のままなら arrivedOn は送らない（DB が今日にする。再送の指紋を変えない）
		fireEvent.click(primaryButton(dialog));
		await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
		expect(postBodies()[0]).not.toHaveProperty('arrivedOn');
	});

	it('FREQ-584-AC-01: 前の日を選ぶと arrivedOn を送り、未来の日は理由を出して送れない', async () => {
		const { dialog, onDone } = await openDialog();
		receiveAll(dialog);
		fireEvent.change(arrivedInput(dialog), { target: { value: '2999-01-01' } });
		expect(primaryButton(dialog)).toBeDisabled();
		expect(within(dialog).getByText('未来の日は選べません。')).toBeInTheDocument();
		fireEvent.change(arrivedInput(dialog), { target: { value: '2026-11-01' } });
		expect(primaryButton(dialog)).toBeEnabled();
		fireEvent.click(primaryButton(dialog));
		await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
		expect(postBodies()[0].arrivedOn).toBe('2026-11-01');
	});

	it('FREQ-584-AC-01: 見込みの窓口へ送る本文には arrivedOn を入れず、届いた日を変えても本文は変わらない', async () => {
		mockEstimateBodies.length = 0;
		const { dialog } = await openDialog();
		receiveAll(dialog);
		const before = mockEstimateBodies.filter((body): body is Record<string, unknown> => body !== null);
		expect(before.length).toBeGreaterThan(0);
		const last = JSON.stringify(before[before.length - 1]);
		fireEvent.change(arrivedInput(dialog), { target: { value: '2026-11-01' } });
		const after = mockEstimateBodies.filter((body): body is Record<string, unknown> => body !== null);
		expect(after.every((body) => !('arrivedOn' in body))).toBe(true);
		expect(JSON.stringify(after[after.length - 1])).toBe(last);
	});

	it('FREQ-584-AC-01: 断られた後に届いた日を直して送り直すと、新しい二重防止の番号で新しい日を送る。結果が分からない間は日を変えられない', async () => {
		const { dialog } = await openDialog({
			replies: [json({ error: '入力を確かめてください。', code: 'RETURN_ARGUMENT_INVALID' }, 400), json({ error: 'x' }, 502)],
		});
		receiveAll(dialog);
		fireEvent.change(arrivedInput(dialog), { target: { value: '2026-11-01' } });
		fireEvent.click(primaryButton(dialog));
		await waitFor(() => expect(within(dialog).getByRole('alert')).toBeInTheDocument());
		fireEvent.change(arrivedInput(dialog), { target: { value: '2026-11-02' } });
		fireEvent.click(primaryButton(dialog));
		await waitFor(() => expect(postBodies()).toHaveLength(2));
		const [first, second] = postBodies();
		expect(first.arrivedOn).toBe('2026-11-01');
		expect(second.arrivedOn).toBe('2026-11-02');
		expect(second.requestKey).not.toBe(first.requestKey);
		// 2回目は分からない結果（502）。日は変えられず、確かめ直しは同じ番号・同じ中身
		await waitFor(() => expect(arrivedInput(dialog)).toBeDisabled());
		fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
		await waitFor(() => expect(postBodies()).toHaveLength(3));
		expect(postBodies()[2]).toEqual(second);
	});
});

describe('受け取りの画面の断りの扱い', () => {
	it('FREQ-575-AC-01: 届いた日が断られた時は、選べない日の説明を同じ文で添え、日を直すと消える', async () => {
		const { dialog } = await openDialog({ replies: [json({ error: '届いた日を確かめてください。', code: 'RETURN_ARRIVAL_DATE_INVALID' }, 400)] });
		receiveAll(dialog);
		fireEvent.change(arrivedInput(dialog), { target: { value: '2026-11-01' } });
		fireEvent.click(primaryButton(dialog));
		expect(await within(dialog).findByText(RETURN_ARRIVAL_INVALID_NOTE_COMMON)).toBeInTheDocument();
		// 「直せません」の文は直す画面だけ。最初の受け取りの画面には出さない
		expect(within(dialog).queryByText(RETURN_ARRIVAL_CORRECTION_ONLY_NOTE, { exact: false })).not.toBeInTheDocument();
		fireEvent.change(arrivedInput(dialog), { target: { value: '2026-11-02' } });
		expect(within(dialog).queryByText(RETURN_ARRIVAL_INVALID_NOTE_COMMON)).not.toBeInTheDocument();
	});

	it('FREQ-575-AC-01: 届いた日の断りの後に別の理由で断られたら、届いた日の説明は消える', async () => {
		const { dialog } = await openDialog({
			replies: [
				json({ error: '届いた日を確かめてください。', code: 'RETURN_ARRIVAL_DATE_INVALID' }, 400),
				json({ error: '入力を確かめてください。', code: 'RETURN_ARGUMENT_INVALID' }, 400),
			],
		});
		receiveAll(dialog);
		fireEvent.change(arrivedInput(dialog), { target: { value: '2026-11-01' } });
		fireEvent.click(primaryButton(dialog));
		expect(await within(dialog).findByText(RETURN_ARRIVAL_INVALID_NOTE_COMMON)).toBeInTheDocument();
		fireEvent.click(primaryButton(dialog));
		await waitFor(() => expect(within(dialog).queryByText(RETURN_ARRIVAL_INVALID_NOTE_COMMON)).not.toBeInTheDocument());
	});

	it('FREQ-584-AC-01: 判断待ちの読みが偽だった注文で DISPUTE_HOLD に断られたら、返品を読み直して「今すぐ返金」を外す', async () => {
		let returnsReads = 0;
		const replies = [json({ error: 'カード会社の判断待ちの注文が含まれているため、返金できません。', code: 'DISPUTE_HOLD', orderIds: [] }, 409)];
		mockClientFetch.mockImplementation(async (input: string) => {
			if (String(input) === `/api/admin/orders/${ORDER_ID}/returns`) {
				returnsReads += 1;
				return json({ data: { returns: [returnDetail()], canRefund: true, returnableUnits: 0, refundableAmount: 54800, refundableShipping: 800, disputeHold: returnsReads > 1 } });
			}
			return replies.shift() ?? json({ data: receiveData() });
		});
		render(<OrderReturnReceiveDialog orderId={ORDER_ID} returnId={RETURN_ID} onClose={jest.fn()} onDone={jest.fn()} />);
		await waitFor(() => expect(screen.queryByText('読み込み中です...')).not.toBeInTheDocument());
		const dialog = screen.getByRole('dialog', { name: TITLE });
		receiveAll(dialog);
		fireEvent.click(primaryButton(dialog));
		await waitFor(() => expect(returnsReads).toBe(2));
		await waitFor(() => expect(within(dialog).getByText(HOLD_TEXT)).toBeInTheDocument());
		within(dialog).getAllByRole('radio', { name: '今すぐ返金' }).forEach((radio) => expect(radio).toBeDisabled());
	});
});

describe('受け取りの画面の判断待ちの止め', () => {
	it('FREQ-584-AC-01: 判断待ちの注文では品ごとの「今すぐ返金」が無効になり理由が出て、全部の品を相談にすれば受け取れる', async () => {
		const { dialog, onDone } = await openDialog({ disputeHold: true });
		expect(within(dialog).getByText(HOLD_TEXT)).toBeInTheDocument();
		receiveAll(dialog);
		const nows = within(dialog).getAllByRole('radio', { name: '今すぐ返金' });
		expect(nows).toHaveLength(2);
		nows.forEach((radio) => expect(radio).toBeDisabled());
		within(dialog).getAllByRole('radio', { name: '額を相談' }).forEach((radio) => expect(radio).toBeChecked());
		expect(within(dialog).queryByText(/今すぐ返金（/)).not.toBeInTheDocument();
		expect(primaryButton(dialog)).toBeEnabled();
		fireEvent.click(primaryButton(dialog));
		await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
		const body = postBodies()[0];
		expect(body.refundChoice).toBe('consult');
		expect(body.units).toEqual([{ returnLineId: 'line-blouse', disposition: 'restocked', quantity: 2, refundChoice: 'consult' }]);
		expect(body.refundAmount).toBeNull();
	});

	it('FREQ-584-AC-01: 判断待ちでない注文では理由を出さず、「今すぐ返金」を選べる', async () => {
		const { dialog } = await openDialog({ disputeHold: false });
		expect(within(dialog).queryByText(HOLD_TEXT)).not.toBeInTheDocument();
		receiveAll(dialog);
		within(dialog).getAllByRole('radio', { name: '今すぐ返金' }).forEach((radio) => expect(radio).toBeEnabled());
	});
});

describe('受け取りの画面の交換の部分は変えない（peer の依頼）', () => {
	it('FREQ-584-AC-01: 返品手数料免除はチェック欄のままで、switch にせず、aria-describedby も付けず、送ると restockingFeeWaived を送る', async () => {
		const { dialog, onDone } = await openDialog({ restockingFeePercent: 10 });
		receiveAll(dialog);
		const waiver = within(dialog).getByRole('checkbox', { name: '返品手数料免除' });
		expect(waiver).not.toHaveAttribute('aria-describedby');
		expect(within(dialog).queryByRole('switch')).not.toBeInTheDocument();
		fireEvent.click(waiver);
		fireEvent.click(primaryButton(dialog));
		await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
		expect(postBodies()[0].restockingFeeWaived).toBe(true);
	});

	it('FREQ-584-AC-01: 割引の扱いの選びは説明の文（return-receive-treatment-hint）に結ばれたまま', async () => {
		const { dialog } = await openDialog();
		receiveAll(dialog);
		const select = within(dialog).getAllByRole('combobox', { name: '割引の扱い' })[0];
		expect(select).toHaveAttribute('aria-describedby', 'return-receive-treatment-hint');
		expect(dialog.querySelector('#return-receive-treatment-hint')).toHaveTextContent('返金する品にかかる割引の扱いです');
	});

	it('FREQ-584-AC-01: 0円で終えた受け取り（waived）の知らせは今までの言葉のまま', async () => {
		const { dialog, onDone } = await openDialog({ replies: [json({ data: receiveData({ refundId: null, refundAmount: 0, refundStatus: 'waived' }) })] });
		receiveAll(dialog);
		fireEvent.click(primaryButton(dialog));
		await waitFor(() => expect(onDone).toHaveBeenCalledWith('受け取りを記録しました。'));
	});
});
