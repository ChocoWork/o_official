import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OrderReturnDetail, OrderReturnLineDetail } from '@/lib/orders/returns/return-types';
import { DISPUTE_HOLD_REFUND_MESSAGE } from '@/lib/orders/refund/refund-messages';
import { DISPUTE_HOLD_MESSAGE } from '@/lib/orders/shipment-slips/shipment-slip-notice';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));
jest.mock('@/hooks/useUnitPricingEstimate', () => ({ useUnitPricingEstimate: () => ({ status: 'idle' }) }));

import OrderReturnRefundDialog from '@/components/OrderReturnRefundDialog';

// 返品の返金の画面の判断待ちの止め（FREQ-584-AC-04・FREQ-580-AC-04）。X4 の言葉は変えない（peer の依頼）。

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const RETURN_ID = 'ret-0001';
const LABEL = 'ORD-A1B2C3D4-R1';
const TITLE = `額を決めて返金する（${LABEL}）`;
const REFUND_URL = `/api/admin/returns/${RETURN_ID}/refund`;
const UNIT_PRICING_INVALID = '返金の額の計算を確かめられませんでした。画面を開き直してください。';

function json(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const WAITING_BLOUSE: OrderReturnLineDetail = {
	id: 'line-blouse', fulfillmentId: 'ful-1', fulfillmentNumber: 1, orderItemId: 'item-blouse',
	itemName: 'シルクブラウス', color: '白', size: 'M', quantity: 2, reason: 'size_too_small', reasonNote: null,
	resolution: 'refund', exchange: null,
	progress: { restocked: 2, notRestocked: 0, pendingInspection: 0, sentBack: 0, missing: 0, processed: 2, unprocessed: 0, exchanged: 0, refundCovered: 0, refundWaived: 0, refundWaiting: 2 },
	refundAmountsByCount: [], refundWaitingAmount: 24000, customerNote: null, requestedResolution: null, requestedExchange: null, photos: [], returnIneligible: false,
};

function returnDetail(): OrderReturnDetail {
	return {
		id: RETURN_ID, number: 1, label: LABEL, status: 'open', source: 'shop', displayStatus: 'refund_waiting', marks: [],
		returnMethod: 'customer_ships', returnShippingPayer: 'customer', returnCarrier: null, returnTrackingNumber: null,
		fees: { returnShippingFee: 0, restockingFeePercent: 0, exchangeFee: 0, exchangeShippingFee: 0, feeDueAmount: 0, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null },
		firstReceiptDone: true, firstExchangeReceiptDone: false, shopNote: null, notifyCustomer: true,
		createdAt: '2026-10-12T01:00:00.000Z', createdByEmail: 'admin@example.com', closedAt: null, cancelledAt: null, requestedAt: null, approvedAt: null, approvedByEmail: null, declinedAt: null, declineReason: null, declineMessage: null,
		lines: [WAITING_BLOUSE], refunds: [], receipts: [], exchangeItems: [],
	};
}

async function openDialog(disputeHold: boolean, replies: Response[] = []) {
	mockClientFetch.mockImplementation(async (input: string) => {
		if (String(input) === `/api/admin/orders/${ORDER_ID}/returns`) {
			return json({ data: { returns: [returnDetail()], canRefund: true, returnableUnits: 0, refundableAmount: 54800, refundableShipping: 800, disputeHold } });
		}
		if (String(input) === REFUND_URL) return replies.shift() ?? json({ data: { refundId: null, status: 'waived', amount: 0, replayed: false } });
		return json({ error: 'not mocked' }, 404);
	});
	render(<OrderReturnRefundDialog orderId={ORDER_ID} returnId={RETURN_ID} onClose={jest.fn()} onDone={jest.fn()} onUncertain={jest.fn()} />);
	await waitFor(() => expect(screen.queryByText('読み込み中です...')).not.toBeInTheDocument());
	return screen.getByRole('dialog', { name: TITLE });
}

const primaryButton = (dialog: HTMLElement) => dialog.querySelector('button[type="submit"]') as HTMLButtonElement;
const amountInput = (dialog: HTMLElement) => within(dialog).getByLabelText('返金額（返せる額: ￥54,800）') as HTMLInputElement;
const holdLine = (dialog: HTMLElement) => within(dialog).getByTestId('return-refund-dispute-hold');
const posts = () => mockClientFetch.mock.calls.filter(([url]) => String(url) === REFUND_URL);

beforeEach(() => {
	mockClientFetch.mockReset();
});

describe('返品の返金の画面の判断待ちの止め', () => {
	it('FREQ-584-AC-04: 返金の画面は判断待ちの注文で送れず、理由を出す', async () => {
		const dialog = await openDialog(true);
		expect(holdLine(dialog)).toHaveTextContent(DISPUTE_HOLD_REFUND_MESSAGE);
		expect(primaryButton(dialog)).toBeDisabled();
		fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
		expect(posts()).toHaveLength(0);
	});

	it('FREQ-584-AC-04: 判断待ちでない注文では理由を出さず、送れる', async () => {
		const dialog = await openDialog(false);
		expect(within(dialog).queryByTestId('return-refund-dispute-hold')).not.toBeInTheDocument();
		expect(primaryButton(dialog)).toBeEnabled();
	});

	it('FREQ-580-AC-04: 返金の画面と発送票の確定画面の文が同じ「カード会社の判断待ち」の言葉になる', () => {
		const head = 'カード会社の判断待ちの注文が含まれているため、';
		expect(DISPUTE_HOLD_REFUND_MESSAGE.startsWith(head)).toBe(true);
		expect(DISPUTE_HOLD_MESSAGE.startsWith(head)).toBe(true);
	});

	it('FREQ-584-AC-04: 返金しないで終える（0円。X4）は判断待ちでも送れ、断りの言葉と止めの理由は別の行のまま残る', async () => {
		const dialog = await openDialog(true, [json({ error: UNIT_PRICING_INVALID, code: 'UNIT_PRICING_INVALID' }, 409)]);
		fireEvent.change(amountInput(dialog), { target: { value: '0' } });
		expect(within(dialog).getByText('返金しないで終えます。お客様に返金のメールは送りません。')).toBeInTheDocument();
		expect(primaryButton(dialog)).toBeEnabled();
		fireEvent.click(primaryButton(dialog));
		const alert = await within(dialog).findByRole('alert');
		expect(alert).toHaveTextContent(UNIT_PRICING_INVALID);
		// 止めの理由は alert の外の別の行。断りの言葉と混ぜない
		expect(alert).not.toHaveTextContent(DISPUTE_HOLD_REFUND_MESSAGE);
		expect(holdLine(dialog)).toHaveTextContent(DISPUTE_HOLD_REFUND_MESSAGE);
		expect(holdLine(dialog)).not.toHaveTextContent(UNIT_PRICING_INVALID);
		expect(holdLine(dialog)).not.toBe(alert);
	});
});
