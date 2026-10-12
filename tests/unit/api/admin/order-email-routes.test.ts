/** @jest-environment node */

// jest の共通の初期設定（tests/setupRequestPolyfill.js）が Response を node-fetch のものに差し替え、静的な json() が無い。NextResponse.json が内部で使うため補う
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

const mockAuthorize = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
}));
const mockRequireCsrf = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: (...args: unknown[]) => mockRequireCsrf(...args) }));
const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
const mockSchedule = jest.fn();
jest.mock('@/lib/orders/email/order-email-schedule', () => ({
  scheduleOrderEmailDelivery: (...args: unknown[]) => mockSchedule(...args),
}));
const mockRpc = jest.fn();
const mockMaybeSingle = jest.fn();
const mockOrderItems = jest.fn();
// 返品の受け取りの行（order_return_receipt_lines）。select の後ろの in で、受け取りの番号を渡して読む（表の名前も受け取って確かめる）
const mockReceiptLines = jest.fn();
// 返品の記録（order_returns の取消などをした人の番号と fee_waived）。select の後ろの in で、返品の番号を渡して読む（読む列も受け取って確かめる）
const mockReturnRecords = jest.fn();
// 人の番号からメールを引く Auth の管理の窓口（supabase.auth.admin.getUserById）
const mockGetUserById = jest.fn();
// 返品の一覧（Task 4 の return-store の listOrderReturns）。履歴の窓口の試験では DB の jsonb ではなく、窓口の形で渡す
const mockListOrderReturns = jest.fn();
jest.mock('@/lib/orders/returns/return-store', () => ({
  ...jest.requireActual('@/lib/orders/returns/return-store'),
  listOrderReturns: (...args: unknown[]) => mockListOrderReturns(...args),
}));
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    auth: { admin: { getUserById: (...args: unknown[]) => mockGetUserById(...args) } },
    // 注文の行は eq の後ろの maybeSingle で1行、商品の名前は eq の後ろをそのまま待つ。受け取りの行と返品の記録は in の後ろを待つ
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: () => (table === 'order_items' ? mockOrderItems() : { maybeSingle: (...args: unknown[]) => mockMaybeSingle(...args) }),
        in: (...args: unknown[]) =>
          (table === 'order_returns' ? mockReturnRecords(columns, ...args) : mockReceiptLines(table, ...args)),
      }),
    }),
  })),
}));

import { GET as getHistory } from '@/app/api/admin/orders/[id]/history/route';
import { GET as getContent } from '@/app/api/admin/orders/[id]/emails/[emailId]/route';
import { POST as postResend } from '@/app/api/admin/orders/[id]/emails/resend/route';
import { returnDetail } from '../../lib/orders/returns/order-return-detail-fixture';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const EMAIL_ID = 'b1b2c3d4-1111-4222-8333-444455556666';
const FULFILLMENT_ID = 'c1b2c3d4-1111-4222-8333-444455556666';
const COMPLETION_ID = 'e1b2c3d4-1111-4222-8333-444455556666';
const REFUND_ID = 'f1b2c3d4-1111-4222-8333-444455556666';
const RECEIPT_ID = 'a2b2c3d4-1111-4222-8333-444455556666';
const ADMIN_USER_ID = 'b2b2c3d4-1111-4222-8333-444455556666';
const GONE_USER_ID = 'b3b2c3d4-1111-4222-8333-444455556666'; // 消えた利用者（Auth が 404 を返す）
const ITEM_1 = 'd1b2c3d4-1111-4222-8333-444455556661';
const ITEM_2 = 'd1b2c3d4-1111-4222-8333-444455556662';
const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });

function rpcReturns(map: Record<string, { data: unknown; error?: unknown }>) {
  mockRpc.mockImplementation(async (name: string) => ({ data: map[name]?.data ?? null, error: map[name]?.error ?? null }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRpc.mockReset();
  mockMaybeSingle.mockReset();
  mockOrderItems.mockReset();
  mockOrderItems.mockResolvedValue({ data: [], error: null });
  mockReceiptLines.mockReset();
  mockReceiptLines.mockResolvedValue({ data: [], error: null });
  mockReturnRecords.mockReset();
  mockReturnRecords.mockResolvedValue({ data: [], error: null });
  mockGetUserById.mockReset();
  mockGetUserById.mockResolvedValue({ data: { user: null }, error: { status: 404, code: 'user_not_found', message: 'User not found' } });
  mockListOrderReturns.mockReset();
  mockListOrderReturns.mockResolvedValue([]);
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' });
  mockRequireCsrf.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockResolvedValue(undefined);
});

describe('GET /api/admin/orders/[id]/history', () => {
  const context = { params: Promise.resolve({ id: ORDER_ID }) };
  const request = () => new Request(`http://localhost/api/admin/orders/${ORDER_ID}/history`);

  it('注文を見る権限で、履歴を新しい順に返す', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'paid', shipping_email: 'hanako@example.com', created_at: '2026-10-08T23:00:00.000Z' },
      error: null,
    });
    rpcReturns({
      list_order_status_history: { data: [{
        changed_at: '2026-10-09T01:00:00.000Z', from_status: 'payment_in_progress', to_status: 'paid', change_reason: 'stripe_payment_paid',
        actor_email: null, shipping_carrier: null, tracking_number: null, cancel_reason: null,
      }] },
      list_order_email_history: { data: [{
        email_id: EMAIL_ID, kind: 'paid', variant: 'order_confirmed', origin: 'auto', requested_by_email: null, status: 'sent', attempts: 1,
        last_error_code: null, delivery_status: null, delivery_event_at: null, created_at: '2026-10-09T01:00:00.000Z',
        sent_at: '2026-10-09T01:00:05.000Z', finished_at: '2026-10-09T01:00:05.000Z', has_body: true, body_erased: false,
      }] },
      get_order_email_send_state: { data: [{ paused: false, reason: null, paused_at: null, next_probe_at: null }] },
    });

    const response = await getHistory(request(), context);

    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.read', expect.any(Request));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.order).toEqual({ id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', statusLabel: '決済完了', recipient: 'hanako@example.com' });
    expect(body.entries.map((entry: { type: string }) => entry.type)).toEqual(['email', 'status', 'created']);
    expect(body.entries[0]).toMatchObject({ emailId: EMAIL_ID, stateLabel: '送信済み', resendable: true, fulfillmentId: null, fulfillmentNumber: null });
    expect(mockRpc).toHaveBeenCalledWith('list_order_status_history', { _order_id: ORDER_ID });
    expect(mockRpc).toHaveBeenCalledWith('list_order_email_history', { _order_id: ORDER_ID });
    expect(JSON.stringify(body)).not.toContain('order_confirmed');
  });

  it('発送・仕上がり・発送ごとのメールも新しい順に返し、商品の名前は「商品名（色 / サイズ）」で出す', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'paid', shipping_email: 'hanako@example.com', created_at: '2026-10-08T23:00:00.000Z' },
      error: null,
    });
    mockOrderItems.mockResolvedValue({
      data: [
        { id: ITEM_1, item_name: 'シルクブラウス', color: '白', size: 'M' },
        { id: ITEM_2, item_name: 'リネンパンツ', color: null, size: null },
      ],
      error: null,
    });
    rpcReturns({
      list_order_email_history: { data: [{
        email_id: EMAIL_ID, kind: 'shipped', variant: null, origin: 'auto', requested_by_email: null, status: 'sent', attempts: 1,
        last_error_code: null, delivery_status: null, delivery_event_at: null, created_at: '2026-10-10T02:00:00+00:00',
        sent_at: '2026-10-10T02:00:05+00:00', finished_at: '2026-10-10T02:00:05+00:00', has_body: true, body_erased: false,
        fulfillment_id: FULFILLMENT_ID, fulfillment_number: 1,
      }] },
      get_order_email_send_state: { data: [{ paused: false, reason: null, paused_at: null, next_probe_at: null }] },
      list_order_fulfillments: { data: [{
        fulfillment_id: FULFILLMENT_ID, number: 1, shipping_carrier: 'yamato', tracking_number: '1234-5678', notify_customer: true,
        completes_order: false, shipped_at: '2026-10-10T02:00:00+00:00', created_by_email: 'admin@example.com', cancelled_at: null,
        cancelled_by_email: null, legacy: false, lines: [{ order_item_id: ITEM_1, quantity: 1 }],
      }] },
      list_order_completions: { data: [{
        completion_id: COMPLETION_ID, order_item_id: ITEM_2, quantity: 1, created_at: '2026-10-10T01:00:00+00:00',
        created_by_email: 'admin@example.com', cancelled_at: null, cancelled_by_email: null, legacy: false,
      }] },
      list_order_line_fulfillment: { data: [
        {
          order_id: ORDER_ID, order_item_id: ITEM_1, variant_id: 11, fulfillment_type: 'stock', quantity: 2, shipped: 1, completed: 2,
          refunded_before_shipment: 0, refunded_after_shipment: 0, in_production: 0, ready_unshipped: 1, unshipped: 1,
        },
        {
          order_id: ORDER_ID, order_item_id: ITEM_2, variant_id: 12, fulfillment_type: 'backorder', quantity: 1, shipped: 0, completed: 1,
          refunded_before_shipment: 0, refunded_after_shipment: 0, in_production: 0, ready_unshipped: 1, unshipped: 1,
        },
      ] },
    });

    const response = await getHistory(request(), context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries.map((entry: { type: string }) => entry.type)).toEqual(['email', 'fulfillment', 'completion', 'created']);
    expect(body.entries[0]).toMatchObject({
      kindLabel: '発送（1回目）', fulfillmentId: FULFILLMENT_ID, fulfillmentNumber: 1, resendable: true,
    });
    expect(body.entries[1]).toMatchObject({
      number: 1, carrierLabel: 'ヤマト運輸', trackingNumber: '1234-5678', cancellable: true,
      items: [{ name: 'シルクブラウス（白 / M）', quantity: 1 }], actorEmail: 'admin@example.com',
    });
    expect(body.entries[2]).toMatchObject({ items: [{ name: 'リネンパンツ', quantity: 1 }], cancellable: true });
    expect(mockRpc).toHaveBeenCalledWith('list_order_fulfillments', { _order_id: ORDER_ID });
    expect(mockRpc).toHaveBeenCalledWith('list_order_completions', { _order_id: ORDER_ID });
    expect(mockRpc).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: [ORDER_ID] });
  });

  it('権限が無ければ認可の応答、注文番号の形が違えば 400、無ければ 404、DB の失敗は 500', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });
    expect((await getHistory(request(), context)).status).toBe(403);

    expect((await getHistory(request(), { params: Promise.resolve({ id: 'x' }) })).status).toBe(400);

    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await getHistory(request(), context)).status).toBe(404);

    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockMaybeSingle.mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'paid', shipping_email: null, created_at: '2026-10-08T23:00:00Z' }, error: null });
      rpcReturns({ list_order_status_history: { data: null, error: { message: '宛先・件名・本文を含む例外', code: '08006' } } });
      const response = await getHistory(request(), context);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Failed to load history' });
      expect(error.mock.calls).toEqual([['[admin.orders.history] Failed to load history', 'OrderEmailStoreError', '08006']]);
    } finally {
      error.mockRestore();
    }
  });

  it('発送の一覧・商品の名前の読み込みが失敗しても 500。ログは例外名と DB の記号だけ', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockMaybeSingle.mockResolvedValue({ data: { id: ORDER_ID, status: 'paid', shipping_email: null, created_at: '2026-10-08T23:00:00Z' }, error: null });
      rpcReturns({ list_order_fulfillments: { data: null, error: { message: '宛先を含む例外', code: '08006' } } });
      expect((await getHistory(request(), context)).status).toBe(500);

      rpcReturns({});
      mockOrderItems.mockResolvedValueOnce({ data: null, error: { message: '宛先を含む例外', code: '42P01' } });
      const response = await getHistory(request(), context);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Failed to load history' });
      expect(error.mock.calls).toEqual([
        ['[admin.orders.history] Failed to load history', 'FulfillmentStoreError', '08006'],
        ['[admin.orders.history] Failed to load history', 'FulfillmentStoreError', '42P01'],
      ]);
    } finally {
      error.mockRestore();
    }
  });
  it('返金の行と、失敗で在庫を確保し直した行も、状態の行と一緒に新しい順に返す', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'paid', shipping_email: 'hanako@example.com', created_at: '2026-10-08T23:00:00.000Z' },
      error: null,
    });
    mockOrderItems.mockResolvedValue({ data: [{ id: ITEM_1, item_name: 'シルクブラウス', color: '白', size: 'M' }], error: null });
    rpcReturns({
      // 一部を発送した注文の残りを返金して発送済みになり、返金が失敗して発送待ちに戻った
      list_order_status_history: { data: [
        {
          changed_at: '2026-11-25T00:00:00.000Z', from_status: 'shipped', to_status: 'paid', change_reason: 'refund_failed_reopened',
          actor_email: null, shipping_carrier: null, tracking_number: null, cancel_reason: null,
        },
        {
          changed_at: '2026-10-11T01:00:03.000Z', from_status: 'paid', to_status: 'shipped', change_reason: 'refund_completed_order',
          actor_email: null, shipping_carrier: 'yamato', tracking_number: '1234-5678', cancel_reason: null,
        },
      ] },
      get_order_email_send_state: { data: [{ paused: false, reason: null, paused_at: null, next_probe_at: null }] },
      list_order_refunds: { data: [{
        refund_id: REFUND_ID, source: 'admin', status: 'failed', stripe_status: 'failed', stripe_pending_reason: null,
        stripe_failure_reason: 'expired', customer_action_expires_at: null, payment_method_type: 'konbini', amount: 5500,
        shipping_amount: 500, adjustment_amount: 0, note: 'お客様の依頼', stripe_reason: 'requested_by_customer', cancel_reason: null,
        notify_customer: true, actor_email: 'admin@example.com', reference_number: null, reference_type: null,
        created_at: '2026-10-11T01:00:00.000Z', accepted_at: '2026-10-11T01:00:03.000Z', succeeded_at: null,
        failed_at: '2026-11-25T00:00:00.000Z', errored_at: null,
        lines: [{
          order_item_id: ITEM_1, quantity: 1, before_shipment: true, restock_type: 'cancel', amount: 5000,
          released_quantity: 1, restocked_quantity: 1, rereserved_quantity: 0, rereserve_shortage: 1,
        }],
      }] },
      list_order_line_fulfillment: { data: [{
        order_id: ORDER_ID, order_item_id: ITEM_1, variant_id: 11, fulfillment_type: 'stock', quantity: 2, shipped: 1, completed: 2,
        refunded_before_shipment: 0, refunded_after_shipment: 0, in_production: 0, ready_unshipped: 0, unshipped: 0,
      }] },
    });

    const response = await getHistory(request(), context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries.map((entry: { type: string }) => entry.type)).toEqual([
      'status', 'refund_rereserve', 'status', 'refund', 'created',
    ]);
    expect(body.entries[0]).toMatchObject({
      fromLabel: '発送済み', toLabel: '決済完了', detail: '返金の失敗で発送待ちに戻りました',
    });
    expect(body.entries[1]).toEqual({
      type: 'refund_rereserve', at: '2026-11-25T00:00:00.000Z', refundId: REFUND_ID,
      items: [{ name: 'シルクブラウス（白 / M）', quantity: 0, shortage: 1 }],
    });
    expect(body.entries[2]).toMatchObject({
      fromLabel: '決済完了', toLabel: '発送済み', detail: '残りの商品を返金したため発送済み',
    });
    expect(body.entries[3]).toMatchObject({
      type: 'refund', refundId: REFUND_ID, source: 'admin', sourceLabel: '管理画面', actorEmail: 'admin@example.com',
      amount: 5500, shippingAmount: 500, failureReasonLabel: '口座の入力の期限が過ぎました',
      stripeReasonLabel: 'お客様の希望', note: 'お客様の依頼',
      items: [{ name: 'シルクブラウス（白 / M）', quantity: 1, beforeShipment: true, restockedQuantity: 1 }],
      steps: [
        { status: 'awaiting_response', label: '返事待ち', at: '2026-10-11T01:00:00.000Z' },
        { status: 'pending', label: '保留', at: '2026-10-11T01:00:03.000Z' },
        { status: 'failed', label: '失敗', at: '2026-11-25T00:00:00.000Z' },
      ],
    });
    expect(mockRpc).toHaveBeenCalledWith('list_order_refunds', { _order_id: ORDER_ID });
  });

  it('返金の一覧の読み込みが失敗しても 500。ログは例外名と DB の記号だけで、メモなどの文は出さない', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockMaybeSingle.mockResolvedValue({ data: { id: ORDER_ID, status: 'paid', shipping_email: null, created_at: '2026-10-08T23:00:00Z' }, error: null });
      rpcReturns({ list_order_refunds: { data: null, error: { message: '店のメモを含む例外', code: '08006' } } });

      const response = await getHistory(request(), context);

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Failed to load history' });
      expect(error.mock.calls).toEqual([['[admin.orders.history] Failed to load history', 'RefundStoreError', '08006']]);
      expect(JSON.stringify(error.mock.calls)).not.toContain('メモ');
    } finally {
      error.mockRestore();
    }
  });

  it('返品の行（作った・受け取り・手数料）、交換の品を足した行、返品の返金の「どこから」を、ほかの行と一緒に新しい順に返す', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'paid', shipping_email: 'hanako@example.com', created_at: '2026-10-08T23:00:00.000Z' },
      error: null,
    });
    mockOrderItems.mockResolvedValue({
      data: [
        { id: ITEM_1, item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, line_kind: 'order', created_at: '2026-10-08T23:00:00+00:00' },
        { id: ITEM_2, item_name: 'シルクブラウス', color: '黒', size: 'L', quantity: 1, line_kind: 'exchange', created_at: '2026-10-12T02:00:00+00:00' },
      ],
      error: null,
    });
    mockListOrderReturns.mockResolvedValue([returnDetail({
      receipts: [{ id: RECEIPT_ID, kind: 'receive', refundChoice: 'now', createdAt: '2026-10-12T02:00:00+00:00', actorEmail: 'support@example.com' }],
      refunds: [{ id: REFUND_ID, amount: 4500, status: 'succeeded', createdAt: '2026-10-12T02:00:00+00:00' }],
      fees: { feeDueAmount: 0, feeReceivedAt: '2026-10-12T03:00:00+00:00' },
    })]);
    mockReturnRecords.mockResolvedValue({
      data: [{ id: 'ret-1', cancelled_by: null, fee_received_by: null, exchange_released_by: null, fee_waived: false, fee_settled_amount: 800 }],
      error: null,
    });
    mockReceiptLines.mockResolvedValue({
      data: [
        { receipt_id: RECEIPT_ID, disposition: 'restocked', quantity: 1 },
        { receipt_id: RECEIPT_ID, disposition: 'sent_back', quantity: 1 },
      ],
      error: null,
    });
    rpcReturns({
      get_order_email_send_state: { data: [{ paused: false, reason: null, paused_at: null, next_probe_at: null }] },
      list_order_refunds: { data: [{
        refund_id: REFUND_ID, source: 'return', status: 'succeeded', stripe_status: 'succeeded', stripe_pending_reason: null,
        stripe_failure_reason: null, customer_action_expires_at: null, payment_method_type: 'card', amount: 4500,
        shipping_amount: 0, adjustment_amount: 0, note: null, stripe_reason: 'requested_by_customer', cancel_reason: null,
        notify_customer: true, actor_email: 'support@example.com', reference_number: null, reference_type: null,
        created_at: '2026-10-12T02:00:00+00:00', accepted_at: '2026-10-12T02:00:01+00:00', succeeded_at: '2026-10-12T02:00:01+00:00',
        failed_at: null, errored_at: null,
        lines: [{
          order_item_id: ITEM_1, quantity: 1, before_shipment: false, restock_type: 'return', amount: 4500,
          released_quantity: 0, restocked_quantity: 0, rereserved_quantity: 0, rereserve_shortage: 0,
        }],
      }] },
      list_order_line_fulfillment: { data: [
        {
          order_id: ORDER_ID, order_item_id: ITEM_1, variant_id: 11, fulfillment_type: 'stock', quantity: 2, shipped: 1, completed: 2,
          refunded_before_shipment: 0, refunded_after_shipment: 1, in_production: 0, ready_unshipped: 1, unshipped: 1,
        },
        {
          order_id: ORDER_ID, order_item_id: ITEM_2, variant_id: 12, fulfillment_type: 'stock', quantity: 1, shipped: 0, completed: 1,
          refunded_before_shipment: 0, refunded_after_shipment: 0, in_production: 0, ready_unshipped: 1, unshipped: 1,
        },
      ] },
    });

    const response = await getHistory(request(), context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries.map((entry: { type: string; kind?: string }) => (entry.type === 'return' ? `return:${entry.kind}` : entry.type))).toEqual([
      'return:fee_received', 'return:exchange_added', 'refund', 'return:receive', 'return:created', 'created',
    ]);
    expect(body.entries[0]).toMatchObject({ title: '手数料の受け取りを記録した（￥800）', actorEmail: null });
    expect(body.entries[1]).toMatchObject({ title: '交換の品を足した（シルクブラウス（黒 / L） × 1）', returnId: null });
    expect(body.entries[2]).toMatchObject({ type: 'refund', refundId: REFUND_ID, source: 'return', sourceLabel: '返品（ORD-A1B2C3D4-R1）' });
    expect(body.entries[3]).toMatchObject({
      title: '返品の受け取り（ORD-A1B2C3D4-R1）', details: ['在庫に戻す 1点', 'お返し 1点'], actorEmail: 'support@example.com',
    });
    expect(body.entries[4]).toMatchObject({ title: '返品を作った（ORD-A1B2C3D4-R1）', actorEmail: 'admin@example.com' });
    expect(mockListOrderReturns).toHaveBeenCalledWith(expect.objectContaining({ rpc: expect.any(Function) }), ORDER_ID);
    expect(mockReceiptLines).toHaveBeenCalledWith('order_return_receipt_lines', 'receipt_id', [RECEIPT_ID]);
  });

  it('受け取りも、取消・手数料の受け取り・支払いを待たずに送るも無い返品は、受け取りの行（order_return_receipt_lines）も返品の記録（order_returns）も読まない', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'paid', shipping_email: 'hanako@example.com', created_at: '2026-10-08T23:00:00.000Z' },
      error: null,
    });
    mockListOrderReturns.mockResolvedValue([returnDetail()]);
    rpcReturns({ get_order_email_send_state: { data: [{ paused: false, reason: null, paused_at: null, next_probe_at: null }] } });

    const response = await getHistory(request(), context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries.map((entry: { type: string; kind?: string }) => (entry.type === 'return' ? `return:${entry.kind}` : entry.type))).toEqual([
      'return:created', 'created',
    ]);
    expect(mockReceiptLines).not.toHaveBeenCalled();
    // 取消・手数料の受け取り・支払いを待たずに送るの無い返品は、した人（と手数料をいただかない印）を読まない
    expect(mockReturnRecords).not.toHaveBeenCalled();
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('受け取りの行の読み込みが失敗しても 500。ログは例外名と DB の記号だけで、DB の文は出さない', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockMaybeSingle.mockResolvedValue({ data: { id: ORDER_ID, status: 'paid', shipping_email: null, created_at: '2026-10-08T23:00:00Z' }, error: null });
      mockListOrderReturns.mockResolvedValue([returnDetail({
        receipts: [{ id: RECEIPT_ID, kind: 'receive', refundChoice: 'now', createdAt: '2026-10-12T02:00:00+00:00', actorEmail: 'admin@example.com' }],
      })]);
      mockReceiptLines.mockResolvedValue({ data: null, error: { message: '宛先を含む例外', code: '42P01' } });
      rpcReturns({});

      const response = await getHistory(request(), context);

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Failed to load history' });
      expect(error.mock.calls).toEqual([['[admin.orders.history] Failed to load history', 'FulfillmentStoreError', '42P01']]);
      expect(JSON.stringify(error.mock.calls)).not.toContain('宛先');
    } finally {
      error.mockRestore();
    }
  });

  it('返品の一覧の読み込みが失敗しても 500。ログは例外名だけで、メッセージは出さない', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockMaybeSingle.mockResolvedValue({ data: { id: ORDER_ID, status: 'paid', shipping_email: null, created_at: '2026-10-08T23:00:00Z' }, error: null });
      mockListOrderReturns.mockRejectedValue(new Error('宛先を含む例外'));
      rpcReturns({});

      const response = await getHistory(request(), context);

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Failed to load history' });
      expect(error.mock.calls).toEqual([['[admin.orders.history] Failed to load history', 'Error']]);
      expect(JSON.stringify(error.mock.calls)).not.toContain('宛先');
    } finally {
      error.mockRestore();
    }
  });

  it('返品の取消・手数料の受け取り・支払いを待たずに送るの行は、order_returns の人の番号からメールを引いて、した人を出す。同じ人は1回だけ引き、消えた利用者は null', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'paid', shipping_email: 'hanako@example.com', created_at: '2026-10-08T23:00:00.000Z' },
      error: null,
    });
    mockListOrderReturns.mockResolvedValue([
      returnDetail({ status: 'cancelled', cancelledAt: '2026-10-12T02:00:00+00:00' }),
      returnDetail({
        id: 'ret-2', number: 2, label: 'ORD-A1B2C3D4-R2',
        fees: { feeDueAmount: 0, feeReceivedAt: '2026-10-12T04:00:00+00:00', exchangeReleasedAt: '2026-10-12T03:00:00+00:00' },
      }),
    ]);
    mockReturnRecords.mockResolvedValue({
      data: [
        { id: 'ret-1', cancelled_by: ADMIN_USER_ID, fee_received_by: null, exchange_released_by: null, fee_waived: false, fee_settled_amount: 0 },
        { id: 'ret-2', cancelled_by: null, fee_received_by: ADMIN_USER_ID, exchange_released_by: GONE_USER_ID, fee_waived: false, fee_settled_amount: 800 },
      ],
      error: null,
    });
    mockGetUserById.mockImplementation(async (userId: string) => (userId === ADMIN_USER_ID
      ? { data: { user: { id: ADMIN_USER_ID, email: 'admin@example.com' } }, error: null }
      : { data: { user: null }, error: { status: 404, code: 'user_not_found', message: 'User not found' } }));
    rpcReturns({ get_order_email_send_state: { data: [{ paused: false, reason: null, paused_at: null, next_probe_at: null }] } });

    const response = await getHistory(request(), context);

    expect(response.status).toBe(200);
    const body = await response.json();
    const returnRows = body.entries.filter((entry: { type: string }) => entry.type === 'return');
    expect(returnRows.map((entry: { kind: string; actorEmail: string | null }) => [entry.kind, entry.actorEmail])).toEqual([
      ['fee_received', 'admin@example.com'],
      ['exchange_released', null],
      ['cancel', 'admin@example.com'],
      ['created', 'admin@example.com'],
      ['created', 'admin@example.com'],
    ]);
    expect(mockReturnRecords).toHaveBeenCalledWith('id, cancelled_by, fee_received_by, exchange_released_by, fee_waived, fee_settled_amount', 'id', ['ret-1', 'ret-2']);
    // 同じ人は1回だけ引く
    expect(mockGetUserById.mock.calls.map(([userId]) => userId).sort()).toEqual([ADMIN_USER_ID, GONE_USER_ID].sort());
  });

  it('手数料をいただかないことにした返品（order_returns.fee_waived）は、手数料の行を「手数料をいただかないことにした（￥n）」と出す（P27）', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'paid', shipping_email: 'hanako@example.com', created_at: '2026-10-08T23:00:00.000Z' },
      error: null,
    });
    mockListOrderReturns.mockResolvedValue([returnDetail({ fees: { feeDueAmount: 0, feeReceivedAt: '2026-10-12T03:00:00+00:00' } })]);
    mockReturnRecords.mockResolvedValue({
      data: [{ id: 'ret-1', cancelled_by: null, fee_received_by: ADMIN_USER_ID, exchange_released_by: null, fee_waived: true, fee_settled_amount: 800 }],
      error: null,
    });
    mockGetUserById.mockResolvedValue({ data: { user: { id: ADMIN_USER_ID, email: 'admin@example.com' } }, error: null });
    rpcReturns({ get_order_email_send_state: { data: [{ paused: false, reason: null, paused_at: null, next_probe_at: null }] } });

    const response = await getHistory(request(), context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries[0]).toMatchObject({
      type: 'return', kind: 'fee_received', title: '手数料をいただかないことにした（￥800）', actorEmail: 'admin@example.com',
    });
  });

  it('した人のメールを引けなかった時（消えた利用者でない失敗）は 500。ログは例外名と記号だけで、文は出さない', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockMaybeSingle.mockResolvedValue({ data: { id: ORDER_ID, status: 'paid', shipping_email: null, created_at: '2026-10-08T23:00:00Z' }, error: null });
      mockListOrderReturns.mockResolvedValue([returnDetail({ status: 'cancelled', cancelledAt: '2026-10-12T02:00:00+00:00' })]);
      mockReturnRecords.mockResolvedValue({
        data: [{ id: 'ret-1', cancelled_by: ADMIN_USER_ID, fee_received_by: null, exchange_released_by: null, fee_waived: false, fee_settled_amount: 0 }],
        error: null,
      });
      mockGetUserById.mockResolvedValue({ data: { user: null }, error: { status: 500, code: 'unexpected_failure', message: '宛先を含む例外' } });
      rpcReturns({});

      const response = await getHistory(request(), context);

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Failed to load history' });
      expect(error.mock.calls).toEqual([['[admin.orders.history] Failed to load history', 'FulfillmentStoreError', 'unexpected_failure']]);
      expect(JSON.stringify(error.mock.calls)).not.toContain('宛先');
    } finally {
      error.mockRestore();
    }
  });

  it('返品の記録（order_returns）が読めなかった時は 500。ログは例外名と DB の記号だけ', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockMaybeSingle.mockResolvedValue({ data: { id: ORDER_ID, status: 'paid', shipping_email: null, created_at: '2026-10-08T23:00:00Z' }, error: null });
      mockListOrderReturns.mockResolvedValue([returnDetail({ status: 'cancelled', cancelledAt: '2026-10-12T02:00:00+00:00' })]);
      mockReturnRecords.mockResolvedValue({ data: null, error: { message: '宛先を含む例外', code: '42501' } });
      rpcReturns({});

      const response = await getHistory(request(), context);

      expect(response.status).toBe(500);
      expect(error.mock.calls).toEqual([['[admin.orders.history] Failed to load history', 'FulfillmentStoreError', '42501']]);
      expect(JSON.stringify(error.mock.calls)).not.toContain('宛先');
      expect(mockGetUserById).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe('GET /api/admin/orders/[id]/emails/[emailId]', () => {
  const context = { params: Promise.resolve({ id: ORDER_ID, emailId: EMAIL_ID }) };
  const request = () => new Request(`http://localhost/api/admin/orders/${ORDER_ID}/emails/${EMAIL_ID}`);

  it('送信済みのメールの件名と本文を返す', async () => {
    rpcReturns({ get_order_email_content: { data: [{ subject: '件名', body_text: '本文', sent_at: '2026-10-09T01:00:05.000Z', body_erased: false }] } });

    const response = await getContent(request(), context);

    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.read', expect.any(Request));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockRpc).toHaveBeenCalledWith('get_order_email_content', { _order_id: ORDER_ID, _email_id: EMAIL_ID });
    await expect(response.json()).resolves.toEqual({ status: 'available', subject: '件名', bodyText: '本文', sentAt: '2026-10-09T01:00:05.000Z' });
  });

  it('本文を消した後は消したことだけ返し、無い・送信済みでなければ 404', async () => {
    rpcReturns({ get_order_email_content: { data: [{ subject: null, body_text: null, sent_at: '2026-08-01T00:00:00.000Z', body_erased: true }] } });
    const response = await getContent(request(), context);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ status: 'erased', sentAt: '2026-08-01T00:00:00.000Z' });

    rpcReturns({ get_order_email_content: { data: [] } });
    expect((await getContent(request(), context)).status).toBe(404);

    expect((await getContent(request(), { params: Promise.resolve({ id: ORDER_ID, emailId: 'x' }) })).status).toBe(400);
  });

  it('中身を見る権限が無ければ 403 で DB を読まない', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });
    expect((await getContent(request(), context)).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('中身の DB の失敗は 500 で、ログは例外名と DB の記号だけ', async () => {
    rpcReturns({ get_order_email_content: { data: null, error: { message: '宛先・件名・本文を含む例外', code: '08006' } } });
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await getContent(request(), context);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Failed to load content' });
      expect(error.mock.calls).toEqual([['[admin.orders.email.content] Failed to load content', 'OrderEmailStoreError', '08006']]);
    } finally {
      error.mockRestore();
    }
  });
});

describe('POST /api/admin/orders/[id]/emails/resend', () => {
  const context = { params: Promise.resolve({ id: ORDER_ID }) };
  const request = (body: unknown) => new Request(`http://localhost/api/admin/orders/${ORDER_ID}/emails/resend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'user-agent': 'jest' },
    body: JSON.stringify(body),
  });

  it('注文の管理の権限・CSRF・回数の制限を通った後に再送の行を足し、監査に残し、worker を動かす', async () => {
    rpcReturns({ request_order_email_resend: { data: EMAIL_ID } });

    const req = request({ kind: 'paid' });
    const response = await postResend(req, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, emailId: EMAIL_ID });
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, { request: req, endpoint: 'admin:orders:email-resend', limit: 30, windowSeconds: 600 });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, { request: req, endpoint: 'admin:orders:email-resend', limit: 30, windowSeconds: 600, subject: 'admin-1' });
    expect(mockRpc).toHaveBeenCalledWith('request_order_email_resend', { _order_id: ORDER_ID, _kind: 'paid', _actor_id: 'admin-1', _fulfillment_id: null });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.orders.email.resend', actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID, outcome: 'success',
      metadata: { kind: 'paid', email_id: EMAIL_ID },
    }));
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('@example.com');
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('発送のメールは、どの発送かを付けて再送を頼む。どの発送かも監査に残す', async () => {
    rpcReturns({ request_order_email_resend: { data: EMAIL_ID } });

    const response = await postResend(request({ kind: 'shipped', fulfillmentId: FULFILLMENT_ID }), context);

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('request_order_email_resend', {
      _order_id: ORDER_ID, _kind: 'shipped', _actor_id: 'admin-1', _fulfillment_id: FULFILLMENT_ID,
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success', metadata: { kind: 'shipped', fulfillment_id: FULFILLMENT_ID, email_id: EMAIL_ID },
    }));
    // 入れた鍵が maskAuditEvent に伏せられることもない
    const { maskAuditEvent } = jest.requireActual('@/lib/audit');
    const audited = mockLogAudit.mock.calls[0][0];
    expect(maskAuditEvent(audited).metadata).toEqual(audited.metadata);
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('発送のメール以外は、発送の番号が null でも受ける（持たない扱い）', async () => {
    rpcReturns({ request_order_email_resend: { data: EMAIL_ID } });

    const response = await postResend(request({ kind: 'paid', fulfillmentId: null }), context);

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('request_order_email_resend', expect.objectContaining({ _kind: 'paid', _fulfillment_id: null }));
  });

  it('権限が無ければ CSRF を確かめず、認可の応答を返す（権限の確認が先）', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await postResend(request({ kind: 'paid' }), context)).status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('CSRF の合言葉が合わない・回数の制限を超えたら、行を足さない', async () => {
    mockRequireCsrf.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await postResend(request({ kind: 'paid' }), context)).status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();

    mockEnforceRateLimit.mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect((await postResend(request({ kind: 'paid' }), context)).status).toBe(429);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('知らない種類・形の違う注文番号は 400', async () => {
    expect((await postResend(request({ kind: 'unknown_kind' }), context)).status).toBe(400);
    expect(mockLogAudit).toHaveBeenNthCalledWith(1, expect.objectContaining({ outcome: 'failure', detail: 'Invalid request body', metadata: null }));
    expect((await postResend(request({ kind: 'paid' }), { params: Promise.resolve({ id: 'x' }) })).status).toBe(400);
    expect(mockLogAudit).toHaveBeenNthCalledWith(2, expect.objectContaining({ outcome: 'failure', detail: 'Invalid order id', metadata: null }));
  });

  // 返金のお知らせと返品のメール4種類（グループ E-3 計画 P7）は、再送しない種類。知っている種類なので窓口は通し、DB が断る
  it.each(['refund', 'return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop'])(
    '%s のメールは知っている種類。再送の依頼は DB まで届き、DB が断る（409）。どの種類かを監査に残す',
    async (kind) => {
      rpcReturns({ request_order_email_resend: { data: null, error: { message: 'RESEND_NOT_ALLOWED', code: '22023' } } });

      const response = await postResend(request({ kind }), context);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: '今の注文の状態では、このメールは再送できません。' });
      expect(mockRpc).toHaveBeenCalledWith('request_order_email_resend', {
        _order_id: ORDER_ID, _kind: kind, _actor_id: 'admin-1', _fulfillment_id: null,
      });
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'conflict', metadata: { kind } }));
      expect(mockSchedule).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['発送のメールに発送の番号が無い', { kind: 'shipped' }],
    ['発送のメールの発送の番号が null', { kind: 'shipped', fulfillmentId: null }],
    ['発送のメールの発送の番号が UUID でない', { kind: 'shipped', fulfillmentId: 'x' }],
    ['発送のメール以外に発送の番号がある', { kind: 'paid', fulfillmentId: FULFILLMENT_ID }],
  ])('%s なら 400。行を足さず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await postResend(request(body), context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid request' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.orders.email.resend', actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('管理者ごとの回数の制限で 429 なら行・監査・送信予約を作らない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response(null, { status: 429 }));
    const req = request({ kind: 'paid' });
    expect((await postResend(req, context)).status).toBe(429);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, { request: req, endpoint: 'admin:orders:email-resend', limit: 30, windowSeconds: 600 });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, { request: req, endpoint: 'admin:orders:email-resend', limit: 30, windowSeconds: 600, subject: 'admin-1' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it.each(['null', '{', JSON.stringify({ kind: '宛先・件名・本文' })])('本文の形が誤り（%s）なら固定の文だけで failure の監査を残す', async (body) => {
    const req = new Request(`http://localhost/api/admin/orders/${ORDER_ID}/emails/resend`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'user-agent': 'jest' }, body,
    });
    expect((await postResend(req, context)).status).toBe(400);
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.orders.email.resend', actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it.each([
    ['RESEND_ALREADY_QUEUED', '23505', 409, '同じメールの再送がまだ送られていません。少し待ってから履歴を確かめてください。'],
    ['RESEND_NOT_ALLOWED', '22023', 409, '今の注文の状態では、このメールは再送できません。'],
    ['ORDER_NOT_FOUND', 'P0002', 404, '注文が見つかりません。'],
  ])('DB が %s（%s）で断ったら %i', async (message, code, status, error) => {
    rpcReturns({ request_order_email_resend: { data: null, error: { message, code } } });

    const response = await postResend(request({ kind: 'paid' }), context);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: status === 404 ? 'failure' : 'conflict', metadata: { kind: 'paid' } }));
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('取り消した発送のメールの再送を DB が断ったら 409。どの発送かを監査に残す', async () => {
    rpcReturns({ request_order_email_resend: { data: null, error: { message: 'RESEND_NOT_ALLOWED', code: '22023' } } });

    const response = await postResend(request({ kind: 'shipped', fulfillmentId: FULFILLMENT_ID }), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: '今の注文の状態では、このメールは再送できません。' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'conflict', metadata: { kind: 'shipped', fulfillment_id: FULFILLMENT_ID },
    }));
  });

  it('思いがけない DB の失敗は 500', async () => {
    rpcReturns({ request_order_email_resend: { data: null, error: { message: '宛先・件名・本文を含む例外', code: '08006' } } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await postResend(request({ kind: 'paid' }), context);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '再送を受け付けられませんでした。' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.email.resend] Failed to request resend', 'OrderEmailStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'Failed to request resend', metadata: { kind: 'paid' } }));
      expect(mockSchedule).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
