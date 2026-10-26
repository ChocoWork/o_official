/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/stripe/server', () => ({ getStripeServerClient: jest.fn() }));
jest.mock('@/lib/orders/fulfillment/fulfillment-store', () => ({ listOrderLineFulfillment: jest.fn() }));
jest.mock('@/lib/orders/refund/refund-store', () => ({ listOrderRefundSummaries: jest.fn() }));
jest.mock('@/lib/orders/returns/return-store', () => ({ listOrderReturnSummaries: jest.fn() }));
jest.mock('@/lib/orders/returns/cancel-request-reads', () => ({ findOrderIdsWithOpenCancelRequest: jest.fn() }));
jest.mock('@/lib/orders/tracking/delivery-store', () => ({ listOrderDeliverySummaries: jest.fn() }));
import type { SupabaseClient } from '@supabase/supabase-js';
import { inspect } from 'node:util';
import { buildAdminOrderSummaries, buildAdminOrderSummary, type AdminOrderSummaryInput } from '@/lib/orders/admin-orders/admin-order-summary';
import { getStripeServerClient } from '@/lib/stripe/server';
import { listOrderLineFulfillment } from '@/lib/orders/fulfillment/fulfillment-store';
import { listOrderRefundSummaries } from '@/lib/orders/refund/refund-store';
import { listOrderReturnSummaries } from '@/lib/orders/returns/return-store';
import { findOrderIdsWithOpenCancelRequest } from '@/lib/orders/returns/cancel-request-reads';
import { listOrderDeliverySummaries } from '@/lib/orders/tracking/delivery-store';
const is = jest.fn(); const query = { select: jest.fn().mockReturnThis(), in: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), is };
const client = { from: jest.fn(() => query) } as unknown as SupabaseClient;
const retrieve = jest.fn();
function order(overrides: Partial<AdminOrderSummaryInput> = {}): AdminOrderSummaryInput {
  return { id: 'order-1', payment_intent_id: null, checkout_session_id: 'cs_1', status: 'paid', total_amount: 30000, refunded_amount: 0, currency: 'jpy', shipping_email: 'buyer@example.invalid', shipping_full_name: 'Fixture', shipping_postal_code: '0000000', shipping_prefecture: 'Fixture', shipping_city: 'Fixture', shipping_address: 'Fixture', shipping_phone: '0000000000', review_reason: null, reviewed_at: null, created_at: '2026-10-10T00:00:00Z', shipped_at: null, shipping_carrier: null, tracking_number: null, order_items: [{ id: 'item-stock', item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, fulfillment_type: 'stock', line_kind: 'order' }, { id: 'item-coat', item_name: 'ウールコート', color: '黒', size: 'L', quantity: 1, fulfillment_type: 'backorder', line_kind: 'order' }], ...overrides };
}
beforeEach(() => {
  jest.clearAllMocks(); is.mockResolvedValue({ data: [], error: null }); (getStripeServerClient as jest.Mock).mockReturnValue({ paymentIntents: { retrieve } }); retrieve.mockResolvedValue({ status: 'succeeded', payment_method_types: ['card'] });
  (listOrderLineFulfillment as jest.Mock).mockResolvedValue(new Map()); (listOrderRefundSummaries as jest.Mock).mockResolvedValue(new Map()); (listOrderReturnSummaries as jest.Mock).mockResolvedValue(new Map()); (findOrderIdsWithOpenCancelRequest as jest.Mock).mockResolvedValue(new Set()); (listOrderDeliverySummaries as jest.Mock).mockResolvedValue(new Map());
});
describe('GET /api/admin/orders statutory search', () => {
  describe('商品ごとの数・注文の言葉・発送と仕上がりのボタン', () => {
    test('FREQ-539-AC-01: 一部を送って受注生産の品が残る注文は「受注生産中」＋一部発送済み。発送も仕上がりの記録も出さない（G-1 で停止）', async () => {
      (listOrderLineFulfillment as jest.Mock).mockResolvedValue(new Map([['order-1', [{ orderItemId: 'item-stock', quantity: 2, shipped: 1, inProduction: 0, readyUnshipped: 1, unshipped: 1 }, { orderItemId: 'item-coat', quantity: 1, shipped: 0, inProduction: 1, readyUnshipped: 0, unshipped: 1 }]]]));
      const rows = await buildAdminOrderSummaries(client, [order()]);
      expect(rows[0]).toMatchObject({ status: '受注生産中', orderStatus: 'paid', progressKey: 'in_production', partiallyShipped: true, canShip: false, canRecordCompletion: false, itemCount: '3点' });
      expect(rows[0].items).toEqual([{ id: 'item-stock', name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, fulfillmentType: 'stock', lineKind: 'order', shipped: 1, inProduction: 0, readyUnshipped: 1 }, { id: 'item-coat', name: 'ウールコート', color: '黒', size: 'L', quantity: 1, fulfillmentType: 'backorder', lineKind: 'order', shipped: 0, inProduction: 1, readyUnshipped: 0 }]);
    });
    test('FREQ-539-AC-01: 取り消していない発送が全部配達済みの注文は「配達済み」（progressKey は delivered）', async () => {
      (listOrderLineFulfillment as jest.Mock).mockResolvedValue(new Map([['order-1', [{ orderItemId: 'item-stock', quantity: 2, shipped: 2, inProduction: 0, readyUnshipped: 0 }]]]));
      (listOrderDeliverySummaries as jest.Mock).mockResolvedValue(new Map([['order-1', { activeCount: 2, deliveredCount: 2, attentionKind: null }]]));
      expect(await buildAdminOrderSummary(client, order({ status: 'shipped' }))).toMatchObject({ status: '配達済み', orderStatus: 'shipped', progressKey: 'delivered', partiallyShipped: false, canShip: false, canRecordCompletion: false });
    });
  });
  describe('入金待ち（pending）の取消の可否は取消 API と同じ判定にする', () => {
    test.each(['requires_action', 'processing'])('FREQ-539-AC-01: %sは払込期限を過ぎても取り消せない', async (status) => {
      retrieve.mockResolvedValue({ status, payment_method_types: ['konbini'], next_action: { konbini_display_details: { expires_at: 1 } } });
      expect(await buildAdminOrderSummary(client, order({ status: 'pending', payment_intent_id: `pi_${status}` }))).toMatchObject({ canCancel: false, cancelBlockedUntil: new Date(1000).toISOString(), paymentMethod: 'コンビニ' });
    });
    test('FREQ-539-AC-01: 払込票が期限切れのPaymentIntentは取り消せる', async () => {
      retrieve.mockResolvedValue({ status: 'requires_payment_method' });
      expect(await buildAdminOrderSummary(client, order({ status: 'pending', payment_intent_id: 'pi_expired_summary' }))).toMatchObject({ canCancel: true, cancelBlockedUntil: null });
    });
    test('FREQ-539-AC-01: PaymentIntentの5分キャッシュと期限切れの再取得', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        const input = order({ payment_intent_id: 'pi_cache_summary' }); await buildAdminOrderSummary(client, input); await buildAdminOrderSummary(client, input); expect(retrieve).toHaveBeenCalledTimes(1); now.mockReturnValue(1_300_001); await buildAdminOrderSummary(client, input); expect(retrieve).toHaveBeenCalledTimes(2);
      } finally { now.mockRestore(); }
    });
    test('FREQ-541-AC-05: Stripeの拒否詳細をログへ出さず、旧いError型の診断とsummaryの値を維持する', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const rejected = Object.assign(new Error('PRIVATE-MARKER'), { type: 'StripeRateLimitError', code: 'rate_limit', raw: { details: 'PRIVATE-MARKER' }, cause: new Error('PRIVATE-MARKER') });
      retrieve.mockRejectedValue(rejected);
      try {
        expect(await buildAdminOrderSummary(client, order({ status: 'pending', payment_intent_id: 'pi_redacted_summary' }))).toMatchObject({ paymentMethod: '不明', stripePaymentStatus: null, canCancel: false });
        expect(warn).toHaveBeenCalledWith('[admin.orders] Failed to retrieve payment intent:', expect.any(Error));
        expect(inspect(warn.mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
        expect(warn.mock.calls[0][1]).not.toBe(rejected);
        expect(warn.mock.calls[0][1]).toMatchObject({ message: 'PAYMENT_INTENT_READ_FAILED', type: 'StripeRateLimitError', code: 'rate_limit' });
        expect(Object.keys(warn.mock.calls[0][1]).sort()).toEqual(['code', 'type']);
        expect(warn.mock.calls[0][1]).not.toHaveProperty('cause');
        expect(warn.mock.calls[0][1]).not.toHaveProperty('raw');
      } finally { warn.mockRestore(); }
    });
    test('FREQ-541-AC-05: Stripeのtype/codeがないか不正な形ならnullで診断する', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      retrieve.mockRejectedValue({ type: { payload: 'PRIVATE-MARKER' }, code: ['PRIVATE-MARKER'], raw: 'PRIVATE-MARKER' });
      try {
        await buildAdminOrderSummary(client, order({ payment_intent_id: 'pi_malformed_diagnostic_summary' }));
        expect(warn.mock.calls[0][1]).toMatchObject({ message: 'PAYMENT_INTENT_READ_FAILED', type: null, code: null });
        expect(inspect(warn.mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
      } finally { warn.mockRestore(); }
    });
  });
  describe('支払いの列・返金の印・返金とキャンセルのボタン', () => {
    test('FREQ-539-AC-01: 支払い・返金・取消はDBの金額を使い、返品・申請・要対応・不足住所を写す', async () => {
      (listOrderRefundSummaries as jest.Mock).mockResolvedValue(new Map([['order-1', { paidAmount: 30000, refundableAmount: 29000, hasOpenRefund: true, hasUnresolvedRefundFailure: true }]]));
      (findOrderIdsWithOpenCancelRequest as jest.Mock).mockResolvedValue(new Set(['order-1'])); is.mockResolvedValue({ data: [{ order_id: 'order-1' }], error: null });
      const row = await buildAdminOrderSummary(client, order({ shipping_address: ' ', review_reason: 'stock_not_reserved' }));
      expect(row).toMatchObject({ canRefund: true, cancelKind: 'paid', canCancel: true, paymentStatusKey: 'paid', refundPending: true, refundFailed: true, missingShippingFields: ['address'], needsReview: true, cancelRequestOpen: true, shipBlockedReason: '支払額の確認が必要です（要対応）', returnSummary: { displayStatus: null, marks: [], nextAction: 'none', hasReturnable: false } });
    });
    test('FREQ-539-AC-01: 交換の行は商品数から外し、名前のない顧客は旧い値', async () => {
      const input = order({ shipping_full_name: ' ', shipping_email: null }); if (input.order_items) input.order_items[0].line_kind = 'exchange';
      expect(await buildAdminOrderSummary(client, input)).toMatchObject({ itemCount: '1点', customerName: 'ゲスト', customerEmail: '-', items: [expect.objectContaining({ lineKind: 'exchange' }), expect.objectContaining({ lineKind: 'order' })] });
    });
  });
});
