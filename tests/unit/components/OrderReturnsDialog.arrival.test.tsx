import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OrderReturnsData } from '@/components/OrderReturnsDialog';
import type { OrderReturnDetail } from '@/lib/orders/returns/return-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));
// 操作の画面は代役にする（この試験は返品の欄の届いた日と直した跡だけを確かめる）
jest.mock('@/components/OrderReturnReceiveDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/OrderReturnRefundDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/OrderReturnActionDialogs', () => ({
	__esModule: true,
	OrderReturnInspectDialog: () => null,
	OrderReturnCancelDialog: () => null,
	OrderReturnReopenDialog: () => null,
	OrderReturnFeePaymentDialog: () => null,
	OrderReturnReleaseExchangeDialog: () => null,
}));
jest.mock('@/components/OrderReturnCreateForm', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/OrderReturnReviewDialog', () => ({ __esModule: true, default: () => null }));

import OrderReturnsDialog from '@/components/OrderReturnsDialog';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const RECEIPT_ID = '00000000-0000-4000-8000-000000000031';
const ACTOR_ID = 'abcdef12-3456-4789-8abc-def012345678';
const TITLE = '返品（ORD-A1B2C3D4）';
const LABEL = 'ORD-A1B2C3D4-R1';

function json(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function returnDetail(): OrderReturnDetail {
	return {
		id: 'ret-1', number: 1, label: LABEL, status: 'open', source: 'shop', displayStatus: 'in_progress', marks: [],
		returnMethod: 'customer_ships', returnShippingPayer: 'customer', returnCarrier: null, returnTrackingNumber: null,
		fees: { returnShippingFee: 0, restockingFeePercent: 0, exchangeFee: 0, exchangeShippingFee: 0, feeDueAmount: 0, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null },
		firstReceiptDone: true, firstExchangeReceiptDone: false, shopNote: null, notifyCustomer: true,
		createdAt: '2026-10-12T01:00:00.000Z', createdByEmail: 'staff@example.com', closedAt: null, cancelledAt: null, requestedAt: null, approvedAt: null, approvedByEmail: null, declinedAt: null, declineReason: null, declineMessage: null,
		lines: [], refunds: [], exchangeItems: [],
		receipts: [{ id: RECEIPT_ID, kind: 'receive', refundChoice: 'none', createdAt: '2026-11-09T02:00:00.000Z', actorEmail: 'staff@example.com' }],
	};
}

const returnsBody = (): { data: OrderReturnsData } => ({
	data: { returns: [returnDetail()], canRefund: true, returnableUnits: 1, refundableAmount: 0, refundableShipping: 0, inspectionEnabled: false },
});

const ARRIVAL = {
	receiptId: RECEIPT_ID,
	arrivedOnOriginal: '2026-11-09',
	arrivedOnCurrent: '2026-11-08',
	version: 1,
	corrections: [{ version: 1, previousOn: '2026-11-09', newOn: '2026-11-08', reason: '配達の記録が前の日だった', actorId: ACTOR_ID, createdAt: '2026-11-10T01:00:00.000Z' }],
};

function serve(options: { correctEntries: boolean; arrival?: unknown; arrivalStatus?: number }) {
	mockClientFetch.mockImplementation(async (input: string) => {
		const url = new URL(String(input), 'http://localhost');
		if (url.pathname === `/api/admin/orders/${ORDER_ID}/returns`) return json(returnsBody());
		if (url.pathname === '/api/admin/accounting/return-arrival') {
			if (options.arrivalStatus && options.arrivalStatus !== 200) return json({ error: '会計の処理に失敗しました。' }, options.arrivalStatus);
			return json({
				data: { arrivals: [options.arrival ?? ARRIVAL] },
				permissions: { manageSettings: false, ...(options.correctEntries ? { correctEntries: true } : {}) },
			});
		}
		return json({ error: 'not mocked' }, 404);
	});
}

async function openDialog() {
	render(<OrderReturnsDialog orderId={ORDER_ID} canRefund open onClose={jest.fn()} onChanged={jest.fn()} />);
	const dialog = await screen.findByRole('dialog', { name: TITLE });
	await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
	return dialog;
}

beforeEach(() => {
	mockClientFetch.mockReset();
});

describe('返品の欄の届いた日', () => {
	it('FREQ-575-AC-02: 返品の詳細に届いた日と直した跡が出る', async () => {
		serve({ correctEntries: true });
		const dialog = await openDialog();
		const card = within(dialog).getByRole('group', { name: LABEL });
		expect(await within(card).findByText('届いた日 2026/11/08')).toBeInTheDocument();
		expect(within(card).getByText('はじめの届いた日 2026/11/09')).toBeInTheDocument();
		const trace = within(card).getByRole('list', { name: '届いた日の直しの跡' });
		const text = within(trace).getByRole('listitem').textContent ?? '';
		expect(text).toContain('版1');
		expect(text).toContain('2026/11/09 → 2026/11/08');
		expect(text).toContain('配達の記録が前の日だった');
		// 直した人は番号の先頭8字だけ。名前・メールは出さない
		expect(text).toContain('abcdef12');
		expect(text).not.toContain(ACTOR_ID);
		expect(text).not.toMatch(/@/);
		// 読む呼び出しは受け取りの番号だけを渡す
		const call = mockClientFetch.mock.calls.map(([url]) => String(url)).find((url) => url.includes('return-arrival'));
		expect(call).toBe(`/api/admin/accounting/return-arrival?receiptIds=${RECEIPT_ID}`);
	});

	it('FREQ-584-AC-02: 届いた日を直す操作は権限のある人だけに出て、理由が空なら送れない', async () => {
		serve({ correctEntries: false });
		const first = await openDialog();
		await within(first).findByText('届いた日 2026/11/08');
		expect(within(first).queryByRole('button', { name: '届いた日を直す' })).not.toBeInTheDocument();
		cleanup();

		serve({ correctEntries: true });
		const dialog = await openDialog();
		fireEvent.click(await within(dialog).findByRole('button', { name: '届いた日を直す' }));
		const arrivalDialog = await screen.findByRole('dialog', { name: '届いた日を直す' });
		fireEvent.change(within(arrivalDialog).getByLabelText('新しい届いた日'), { target: { value: '2026-11-07' } });
		expect(within(arrivalDialog).getByRole('button', { name: '直して記録する' })).toBeDisabled();
	});

	it('FREQ-575-AC-02: 届いた日を読めなくても返品の欄は出し、受け取りの記録を隠さない', async () => {
		serve({ correctEntries: true, arrivalStatus: 500 });
		const dialog = await openDialog();
		expect(within(dialog).getByRole('group', { name: LABEL })).toBeInTheDocument();
		expect(within(dialog).queryByText(/届いた日 20/)).not.toBeInTheDocument();
	});
});
