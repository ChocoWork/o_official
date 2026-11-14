import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RefundMaterialLine, RefundMaterials } from '@/lib/orders/refund/refund-types';
import { DISPUTE_HOLD_REFUND_MESSAGE } from '@/lib/orders/refund/refund-messages';
import { DISPUTE_HOLD_MESSAGE } from '@/lib/orders/shipment-slips/shipment-slip-notice';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));
jest.mock('@/hooks/useUnitPricingEstimate', () => ({ useUnitPricingEstimate: () => ({ status: 'idle' }) }));

import OrderPaidCancelDialog from '@/components/OrderPaidCancelDialog';
import OrderRefundDialog from '@/components/OrderRefundDialog';

// 返金の画面と支払い済みの注文の取り消しの画面の判断待ちの止め（FREQ-584-AC-04・FREQ-580-AC-04）。

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const REFUND_URL = `/api/admin/orders/${ORDER_ID}/refund`;
const STATUS_URL = `/api/admin/orders/${ORDER_ID}/status`;

function json(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const STOCK_LINE: RefundMaterialLine = {
	orderItemId: 'item-stock', name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
	itemPrice: 12000, quantity: 2, lineTotal: 24000, shipped: 0, unshipped: 2,
	refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 0, restockable: 2,
	lineDiscount: 0, availableUnitAmounts: null, refundedUnits: 0,
};

function materials(disputeHold: boolean | undefined): RefundMaterials {
	return {
		order: {
			id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', status: 'paid', paymentMethod: 'card',
			totalAmount: 24800, shippingAmount: 800, discountAmount: 0, paidAmount: 24800,
			succeededAmount: 0, openAmount: 0, refundableAmount: 24800, refundedShipping: 0, refundableShipping: 800,
			shippedTotal: 0, unshippedTotal: 2,
		},
		lines: [STOCK_LINE],
		awaitingRefund: null,
		...(disputeHold === undefined ? {} : { disputeHold }),
	};
}

beforeEach(() => {
	mockClientFetch.mockReset();
});

describe('返金の画面の判断待ちの止め', () => {
	async function openRefund(disputeHold: boolean | undefined) {
		mockClientFetch.mockResolvedValueOnce(json(materials(disputeHold)));
		render(<OrderRefundDialog orderId={ORDER_ID} onClose={jest.fn()} onRefunded={jest.fn()} />);
		const dialog = await screen.findByRole('dialog', { name: '返金（注文 ORD-A1B2C3D4）' });
		await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
		return dialog;
	}
	const submit = (dialog: HTMLElement) => dialog.querySelector('button[type="submit"]') as HTMLButtonElement;

	it('FREQ-584-AC-04: 返金の画面は判断待ちの注文で送れず、理由を出す', async () => {
		const dialog = await openRefund(true);
		fireEvent.click(within(dialog).getByRole('button', { name: 'すべて選ぶ' }));
		expect(within(dialog).getByTestId('refund-dispute-hold')).toHaveTextContent(DISPUTE_HOLD_REFUND_MESSAGE);
		expect(submit(dialog)).toBeDisabled();
		fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
		expect(mockClientFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
	});

	it('FREQ-584-AC-04: 判断待ちでない注文・印が無い答えでは理由を出さず、送れる', async () => {
		for (const hold of [false, undefined]) {
			const dialog = await openRefund(hold);
			fireEvent.click(within(dialog).getByRole('button', { name: 'すべて選ぶ' }));
			expect(within(dialog).queryByTestId('refund-dispute-hold')).not.toBeInTheDocument();
			expect(submit(dialog)).toBeEnabled();
			cleanup();
		}
	});

	it('FREQ-580-AC-04: 返金の画面と発送票の確定画面の文が同じ「カード会社の判断待ち」の言葉になる', async () => {
		const head = 'カード会社の判断待ちの注文が含まれているため、';
		const dialog = await openRefund(true);
		expect(within(dialog).getByTestId('refund-dispute-hold').textContent?.startsWith(head)).toBe(true);
		expect(DISPUTE_HOLD_MESSAGE.startsWith(head)).toBe(true);
	});
});

describe('支払い済みの注文の取り消しの画面の判断待ちの止め', () => {
	it('FREQ-584-AC-04: 支払い済みの注文の取り消しも判断待ちの注文では送れず、同じ理由の文を出す', async () => {
		mockClientFetch.mockResolvedValueOnce(json(materials(true)));
		render(<OrderPaidCancelDialog orderId={ORDER_ID} onClose={jest.fn()} onCancelled={jest.fn()} />);
		const dialog = await screen.findByRole('dialog', { name: '注文をキャンセルする（注文 ORD-A1B2C3D4）' });
		await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
		expect(within(dialog).getByTestId('refund-dispute-hold')).toHaveTextContent(DISPUTE_HOLD_REFUND_MESSAGE);
		expect(dialog.querySelector('button[type="submit"]')).toBeDisabled();
		expect(mockClientFetch.mock.calls.map(([url]) => String(url))).toEqual([REFUND_URL]);
		expect(STATUS_URL).toContain(ORDER_ID);
	});
});
