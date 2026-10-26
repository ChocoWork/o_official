import { hasReturnsToShow, returnButtonLabel, RETURN_BUTTON_LABELS } from '@/lib/orders/admin-orders/admin-order-actions';
import type { OrderReturnSummary } from '@/lib/orders/returns/return-types';
const summary: OrderReturnSummary = { orderId: 'order', displayStatus: null, marks: [], nextAction: 'none', hasReturnable: false, refundWaitingReturns: 0, requestedReturns: 0 };
test.each([['review_request', '申し込みを確かめる'], ['refund', '額を決めて返金する'], ['receive', '受け取る'], ['none', '返品']] as const)('FREQ-539-AC-02: 旧OrderSectionの次の操作 %s', (nextAction, label) => {
  expect(returnButtonLabel({ ...summary, nextAction }, true)).toBe(label);
  expect(RETURN_BUTTON_LABELS[nextAction]).toBe(label);
});
test('FREQ-539-AC-02: サポーターには返金の名前を出さず受取か返品にする', () => {
  for (const mark of ['awaiting_items', 'partially_received'] as const) expect(returnButtonLabel({ ...summary, nextAction: 'refund', displayStatus: 'in_progress', marks: [mark] }, false)).toBe('受け取る');
  expect(returnButtonLabel({ ...summary, nextAction: 'refund' }, false)).toBe('返品');
  expect(hasReturnsToShow(summary)).toBe(false);
  expect(hasReturnsToShow({ ...summary, displayStatus: 'returned' })).toBe(true);
  expect(hasReturnsToShow({ ...summary, hasReturnable: true })).toBe(true);
});
