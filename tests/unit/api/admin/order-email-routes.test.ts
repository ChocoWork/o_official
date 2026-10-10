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
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    // 注文の行は eq の後ろの maybeSingle で1行、商品の名前は eq の後ろをそのまま待つ
    from: (table: string) => ({
      select: () => ({
        eq: () => (table === 'order_items' ? mockOrderItems() : { maybeSingle: (...args: unknown[]) => mockMaybeSingle(...args) }),
      }),
    }),
  })),
}));

import { GET as getHistory } from '@/app/api/admin/orders/[id]/history/route';
import { GET as getContent } from '@/app/api/admin/orders/[id]/emails/[emailId]/route';
import { POST as postResend } from '@/app/api/admin/orders/[id]/emails/resend/route';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const EMAIL_ID = 'b1b2c3d4-1111-4222-8333-444455556666';
const FULFILLMENT_ID = 'c1b2c3d4-1111-4222-8333-444455556666';
const COMPLETION_ID = 'e1b2c3d4-1111-4222-8333-444455556666';
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
          in_production: 0, ready_unshipped: 1, unshipped: 1,
        },
        {
          order_id: ORDER_ID, order_item_id: ITEM_2, variant_id: 12, fulfillment_type: 'backorder', quantity: 1, shipped: 0, completed: 1,
          in_production: 0, ready_unshipped: 1, unshipped: 1,
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
    expect((await postResend(request({ kind: 'refund' }), context)).status).toBe(400);
    expect(mockLogAudit).toHaveBeenNthCalledWith(1, expect.objectContaining({ outcome: 'failure', detail: 'Invalid request body', metadata: null }));
    expect((await postResend(request({ kind: 'paid' }), { params: Promise.resolve({ id: 'x' }) })).status).toBe(400);
    expect(mockLogAudit).toHaveBeenNthCalledWith(2, expect.objectContaining({ outcome: 'failure', detail: 'Invalid order id', metadata: null }));
  });

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
