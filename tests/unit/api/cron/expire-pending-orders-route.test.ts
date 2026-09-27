jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

const mockRpc = jest.fn();
const mockSelect = jest.fn();
const mockRange = jest.fn();
// route が pending → paid の救済で orders.update(...).eq(...).eq(...) も叩くため、
// select に加えて update もチェーン可能な形でモックする（本リポジトリの
// Supabase クライアントモック規約：from() は都度オブジェクトを返す薄いスタブ）。
const mockUpdate = jest.fn();
// order_items 取得（入金確認メール用）
const mockOrderItemsSelect = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn().mockResolvedValue({
    from: (table: string) => {
      if (table === 'order_items') {
        return { select: mockOrderItemsSelect };
      }
      return { select: mockSelect, update: mockUpdate };
    },
    rpc: mockRpc,
  }),
}));

const mockPaymentIntentsRetrieve = jest.fn();
const mockPaymentIntentsCancel = jest.fn();
const mockCheckoutSessionsRetrieve = jest.fn();
const mockCheckoutSessionsList = jest.fn();
const mockCheckoutSessionsExpire = jest.fn();
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: () => ({
    paymentIntents: { retrieve: mockPaymentIntentsRetrieve, cancel: mockPaymentIntentsCancel },
    checkout: {
      sessions: {
        retrieve: mockCheckoutSessionsRetrieve,
        list: mockCheckoutSessionsList,
        expire: mockCheckoutSessionsExpire,
      },
    },
  }),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

// 設定ミス（CRON_SECRET 未設定）の監査ログを間引くための回数制限。既定は「まだ上限に達していない」。
const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

// 注文行と明細の取得はメール側の共通処理が持つ（webhook と共通）。
// ここは「どの注文に、どの種類を送ろうとしたか」だけを見る。
const mockSendOrderConfirmationEmail = jest.fn().mockResolvedValue(true);
jest.mock('@/lib/orders/order-confirmation-email', () => ({
  sendOrderConfirmationEmailForOrderId: (...args: unknown[]) => mockSendOrderConfirmationEmail(...args),
}));

import { POST } from '@/app/api/cron/expire-pending-orders/route';

function request(authorization?: string): Request {
  return new Request('http://localhost/api/cron/expire-pending-orders', {
    method: 'POST',
    headers: authorization ? { authorization } : {},
  });
}

// orders テーブルへの select は「pending 一覧取得」（.eq().lt().order().limit()）と
// 「1件のメール用ルックアップ」（.eq('id', ...).maybeSingle()）の2種類の呼び方をされる。
// eq() の戻り値に両方のメソッドを生やしておくことで、どちらの経路でも動く単一のモックにする。
function pendingOrders(
  rows: { id: string; payment_intent_id: string; checkout_session_id?: string | null }[],
  orderLookupRow: Record<string, unknown> | null = {
    id: 'order-1',
    shipping_email: 'hanako@example.com',
    shipping_full_name: '山田 花子',
    subtotal_amount: 1000,
    shipping_amount: 500,
    total_amount: 1500,
    currency: 'jpy',
    shipping_postal_code: null,
    shipping_prefecture: null,
    shipping_city: null,
    shipping_address: null,
    shipping_building: null,
    shipping_phone: null,
  },
  totalCount = rows.length,
) {
  mockRange.mockResolvedValue({ data: rows, error: null });
  const orderedQuery: any = { range: mockRange };
  orderedQuery.order = () => orderedQuery;

  mockSelect.mockImplementation((_columns: string, options?: { head?: boolean }) => {
    if (options?.head) {
      return {
        eq: () => ({
          lt: () => Promise.resolve({ count: totalCount, error: null }),
        }),
      };
    }

    return {
      eq: () => ({
        lt: () => ({ order: () => orderedQuery }),
        maybeSingle: () => Promise.resolve({ data: orderLookupRow, error: null }),
      }),
    };
  });
}

describe('POST /api/cron/expire-pending-orders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'cron-secret';
    delete process.env.PENDING_ORDER_EXPIRY_DAYS;
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockRpc.mockResolvedValue({ data: [{ released: true, order_id: 'order-1' }], error: null });
    mockUpdate.mockReturnValue({
      eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'order-1' }], error: null }) }) }),
    });
    mockOrderItemsSelect.mockReturnValue({
      eq: () => Promise.resolve({ data: [], error: null }),
    });
  });

  it('CRON_SECRET が一致しなければ 401', async () => {
    pendingOrders([{ id: 'order-1', payment_intent_id: 'pi_1' }]);
    const response = await POST(request('Bearer wrong'));
    expect(response.status).toBe(401);
    expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled();
  });

  it('長さが同じでも値が違う secret は 401（timingSafeEqual の分岐を通す）', async () => {
    // 'cron-secret' と同じ長さの別値。長さチェックだけで弾かれず、
    // timingSafeEqual の比較結果で 401 になることを確認する。
    pendingOrders([{ id: 'order-1', payment_intent_id: 'pi_1' }]);
    const response = await POST(request('Bearer cron-secreX'));
    expect(response.status).toBe(401);
    expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled();
  });

  it('CRON_SECRET が未設定なら 401 で Stripe も呼ばれない', async () => {
    delete process.env.CRON_SECRET;
    pendingOrders([{ id: 'order-1', payment_intent_id: 'pi_1' }]);
    const response = await POST(request('Bearer cron-secret'));
    expect(response.status).toBe(401);
    expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled();
  });

  it('CRON_SECRET が未設定でも 401 の前に理由付きで監査ログを残す（レビュー指摘 I5）', async () => {
    delete process.env.CRON_SECRET;
    pendingOrders([]);
    const response = await POST(request('Bearer cron-secret'));

    expect(response.status).toBe(401);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'checkout.pending_orders.expire',
        outcome: 'failure',
        detail: expect.stringContaining('CRON_SECRET'),
      }),
    );
  });

  // FREQ-370: 設定ミスの監査ログ（と外部アラート）は、誰でも叩ける経路なので全体で10分に1回までに絞る。
  it('CRON_SECRET 未設定の監査ログは、IP に依らない共通の枠で10分に1回までに絞る（FREQ-370）', async () => {
    delete process.env.CRON_SECRET;
    pendingOrders([]);

    await POST(request('Bearer cron-secret'));

    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'cron:expire-pending-orders:misconfigured',
        limit: 1,
        windowSeconds: 600,
        // subject を付けると IP を使わない共通のカウンタになる（攻撃元を散らしても増えない）
        subject: expect.any(String),
      }),
    );
  });

  it('枠を使い切ったら、CRON_SECRET 未設定でも監査ログを残さず 401 だけ返す（FREQ-370）', async () => {
    delete process.env.CRON_SECRET;
    pendingOrders([]);
    mockEnforceRateLimit.mockResolvedValue(new Response(null, { status: 429 }));

    const response = await POST(request('Bearer cron-secret'));

    expect(response.status).toBe(401);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  // FREQ-370: ヘッダの欠落・不一致は誰でも起こせる。1回ごとに監査ログの INSERT と外部アラートを
  // 起こすと、未認証の要求だけでログとアラートを際限なく増やせる（OWASP Logging Cheat Sheet、API4:2023）。
  // 認証失敗の記録はアプリのログ（console）に残し、DB と外部通知には出さない。
  it('Authorization ヘッダが無い要求は 401 だけ返し、監査ログを残さない（FREQ-370）', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    pendingOrders([]);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[cron] expire-pending-orders unauthorized'),
      expect.stringContaining('Missing Authorization header'),
    );
    warn.mockRestore();
  });

  it('Authorization ヘッダが一致しない要求も監査ログを残さず、ヘッダの値をログに出さない（FREQ-370）', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    pendingOrders([]);

    const response = await POST(request('Bearer attacker-supplied-value'));

    expect(response.status).toBe(401);
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('attacker-supplied-value');
    warn.mockRestore();
  });

  it('Authorization ヘッダがなければ 401', async () => {
    pendingOrders([]);
    const response = await POST(request());
    expect(response.status).toBe(401);
  });

  it('open の Checkout Session は expire して在庫を戻し、PaymentIntent は直接 cancel しない', async () => {
    pendingOrders([{ id: 'order-1', payment_intent_id: 'pi_1', checkout_session_id: 'cs_1' }]);
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi_1', status: 'requires_action' });
    mockCheckoutSessionsRetrieve.mockResolvedValue({
      id: 'cs_1',
      status: 'open',
      payment_status: 'unpaid',
      payment_intent: 'pi_1',
    });
    mockCheckoutSessionsExpire.mockResolvedValue({
      id: 'cs_1',
      status: 'expired',
      payment_status: 'unpaid',
      payment_intent: 'pi_1',
    });

    const response = await POST(request('Bearer cron-secret'));

    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsExpire).toHaveBeenCalledWith(
      'cs_1',
      {},
      { idempotencyKey: 'expire-checkout-session:cs_1' },
    );
    expect(mockRpc).toHaveBeenCalledWith('release_stock_for_unpaid_order', { _payment_intent_id: 'pi_1' });
    expect(response.body).toMatchObject({ processed: 1, cancelled: 1 });
  });

  it('complete かつ unpaid の Checkout Session は将来入金され得るため在庫を戻さない', async () => {
    pendingOrders([{
      id: 'order-1',
      payment_intent_id: 'pi_complete',
      checkout_session_id: 'cs_complete',
    }]);
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi_complete', status: 'requires_action' });
    mockCheckoutSessionsRetrieve.mockResolvedValue({
      id: 'cs_complete',
      status: 'complete',
      payment_status: 'unpaid',
      payment_intent: 'pi_complete',
    });

    const response = await POST(request('Bearer cron-secret'));

    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsExpire).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ skippedUncancelable: 1, cancelled: 0 });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'checkout.pending_orders.expire',
      outcome: 'failure',
      metadata: expect.objectContaining({ skippedUncancelable: 1 }),
    }));
  });

  it('processing の PaymentIntent は触らない', async () => {
    pendingOrders([{ id: 'order-1', payment_intent_id: 'pi_2' }]);
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi_2', status: 'processing' });

    const response = await POST(request('Bearer cron-secret'));

    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ skippedProcessing: 1 });
  });

  it('succeeded の PaymentIntent は paid へ寄せ、在庫は戻さず入金確認メールを送る（レビュー指摘 I6b）', async () => {
    pendingOrders([{ id: 'order-1', payment_intent_id: 'pi_3' }]);
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi_3', status: 'succeeded' });

    const response = await POST(request('Bearer cron-secret'));

    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith({ status: 'paid' });
    expect(response.body).toMatchObject({ recoveredAsPaid: 1 });
    expect(mockSendOrderConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(mockSendOrderConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1', paymentState: 'paid', logLabel: '[cron]' }),
    );
  });

  it('ほかの経路が先に paid にしていたら（更新0件）入金確認メールを送らない（FREQ-386）', async () => {
    pendingOrders([{ id: 'order-1', payment_intent_id: 'pi_3' }]);
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi_3', status: 'succeeded' });
    mockUpdate.mockReturnValue({
      eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }),
    });

    const response = await POST(request('Bearer cron-secret'));

    expect(response.body).toMatchObject({ recoveredAsPaid: 0, alreadyPaid: 1, failed: 0 });
    expect(mockSendOrderConfirmationEmail).not.toHaveBeenCalled();
  });

  it('succeeded の paid 更新が失敗したら recoveredAsPaid ではなく failed にする（メールも送らない）', async () => {
    pendingOrders([{ id: 'order-1', payment_intent_id: 'pi_3' }]);
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi_3', status: 'succeeded' });
    mockUpdate.mockReturnValue({
      eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'trigger rejected' } }) }) }),
    });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(request('Bearer cron-secret'));

    expect(mockRpc).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ recoveredAsPaid: 0, failed: 1 });
    expect(mockSendOrderConfirmationEmail).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[cron] failed to mark order paid',
      'order-1',
      expect.anything()
    );

    consoleErrorSpy.mockRestore();
  });

  it('canceled の PaymentIntent は cancel を呼ばず在庫だけ戻す', async () => {
    pendingOrders([{ id: 'order-1', payment_intent_id: 'pi_6' }]);
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi_6', status: 'canceled' });

    const response = await POST(request('Bearer cron-secret'));

    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith('release_stock_for_unpaid_order', { _payment_intent_id: 'pi_6' });
    expect(response.body).toMatchObject({ cancelled: 1 });
  });

  it('未知のステータスは何もせず skippedUnknown に計上する', async () => {
    pendingOrders([{ id: 'order-1', payment_intent_id: 'pi_7' }]);
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi_7', status: 'requires_source' });
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await POST(request('Bearer cron-secret'));

    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ skippedUnknown: 1 });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));

    consoleWarnSpy.mockRestore();
  });

  it('PaymentIntent が resource_missing なら Session が expired でも注文と在庫を変更しない', async () => {
    pendingOrders([{
      id: 'order-1',
      payment_intent_id: 'pi_missing',
      checkout_session_id: 'cs_expired',
    }]);
    const notFoundError = Object.assign(new Error('No such payment_intent'), { code: 'resource_missing' });
    mockPaymentIntentsRetrieve.mockRejectedValue(notFoundError);
    mockCheckoutSessionsRetrieve.mockResolvedValue({
      id: 'cs_expired',
      status: 'expired',
      payment_status: 'unpaid',
      payment_intent: 'pi_missing',
    });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(request('Bearer cron-secret'));

    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsRetrieve).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsList).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsExpire).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ cancelled: 0, failed: 1 });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error',
      metadata: expect.objectContaining({ failed_order_ids: ['order-1'] }),
    }));

    consoleErrorSpy.mockRestore();
  });

  it('PaymentIntent の取得に失敗したら Session を推測せず在庫を戻さない', async () => {
    pendingOrders([{ id: 'order-1', payment_intent_id: 'pi_unavailable', checkout_session_id: null }]);
    mockPaymentIntentsRetrieve.mockRejectedValue(new Error('Stripe unavailable'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(request('Bearer cron-secret'));

    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsRetrieve).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsList).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsExpire).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ cancelled: 0, failed: 1 });

    consoleErrorSpy.mockRestore();
  });

  it('1件が例外でも残りを処理して件数を返す', async () => {
    pendingOrders([
      { id: 'order-1', payment_intent_id: 'pi_4' },
      { id: 'order-2', payment_intent_id: 'pi_5' },
    ]);
    mockPaymentIntentsRetrieve
      .mockRejectedValueOnce(new Error('stripe down'))
      .mockResolvedValueOnce({ id: 'pi_5', status: 'canceled' });

    const response = await POST(request('Bearer cron-secret'));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ processed: 2, failed: 1, cancelled: 1 });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ failed_order_ids: ['order-1'] }),
      })
    );
  });

  it('対象がなければ 200 と 0 件を返す', async () => {
    pendingOrders([]);
    const response = await POST(request('Bearer cron-secret'));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ processed: 0 });
  });

  it('logAudit がサマリを含めて1回呼ばれる', async () => {
    pendingOrders([{ id: 'order-1', payment_intent_id: 'pi_1' }]);
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi_1', status: 'canceled' });

    await POST(request('Bearer cron-secret'));

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'checkout.pending_orders.expire',
      resource: 'orders',
      outcome: 'success',
      detail: 'Expired pending orders sweep',
      metadata: {
        processed: 1,
        candidateCount: 1,
        batchOffset: 0,
        cancelled: 1,
        recoveredAsPaid: 0,
        alreadyPaid: 0,
        skippedProcessing: 0,
        skippedUncancelable: 0,
        skippedUnknown: 0,
        failed: 0,
        capped: false,
        timeBudgetExhausted: false,
        failed_order_ids: [],
      },
    });
  });

  it('1回の実行の上限は50件（レビュー指摘 I3）', async () => {
    pendingOrders([], null, 50);

    await POST(request('Bearer cron-secret'));

    expect(mockRange).toHaveBeenCalledWith(0, 49);
  });

  it('50件を超える場合は日ごとに取得範囲を巡回し、保留注文による後続の飢餓を防ぐ', async () => {
    pendingOrders([{ id: 'order-51', payment_intent_id: 'pi_51' }], null, 120);
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi_51', status: 'canceled' });
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(24 * 60 * 60 * 1000);

    const response = await POST(request('Bearer cron-secret'));

    expect(mockRange).toHaveBeenCalledTimes(1);
    expect(mockRange).toHaveBeenCalledWith(50, 99);
    expect(response.body).toMatchObject({ candidateCount: 120, batchOffset: 50, cancelled: 1 });

    dateSpy.mockRestore();
  });

  it('count 後の状態変化で巡回範囲が空なら先頭範囲へ1回だけ戻す', async () => {
    pendingOrders([], null, 120);
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(24 * 60 * 60 * 1000);

    const response = await POST(request('Bearer cron-secret'));

    expect(mockRange).toHaveBeenNthCalledWith(1, 50, 99);
    expect(mockRange).toHaveBeenNthCalledWith(2, 0, 49);
    expect(response.body).toMatchObject({ candidateCount: 120, batchOffset: 0, processed: 0 });

    dateSpy.mockRestore();
  });

  it('45秒の時間予算を超えたら残りを打ち切り timeBudgetExhausted を立てる（レビュー指摘 I3）', async () => {
    pendingOrders([
      { id: 'order-1', payment_intent_id: 'pi_1' },
      { id: 'order-2', payment_intent_id: 'pi_2' },
    ]);
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi_1', status: 'canceled' });

    const dateSpy = jest.spyOn(Date, 'now');
    dateSpy
      .mockReturnValueOnce(1_000_000) // threshold 計算
      .mockReturnValueOnce(1_000_000) // 日次バッチ位置の計算
      .mockReturnValueOnce(1_000_000) // startedAt
      .mockReturnValueOnce(1_000_100) // order-1 の予算チェック（予算内）
      .mockReturnValueOnce(1_050_000); // order-2 の予算チェック（予算超過）

    const response = await POST(request('Bearer cron-secret'));

    expect(mockPaymentIntentsRetrieve).toHaveBeenCalledTimes(1);
    expect(response.body).toMatchObject({ processed: 1, timeBudgetExhausted: true });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));

    dateSpy.mockRestore();
  });

  it('PENDING_ORDER_EXPIRY_DAYS が5未満なら5日に底上げして警告する（FREQ-388）', async () => {
    process.env.PENDING_ORDER_EXPIRY_DAYS = '2';
    pendingOrders([]);
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await POST(request('Bearer cron-secret'));

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('PENDING_ORDER_EXPIRY_DAYS=2'),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('using 5'));

    consoleWarnSpy.mockRestore();
  });

  it('コンビニ払込票が生きうる4日を指定しても、5日に底上げする（FREQ-388）', async () => {
    process.env.PENDING_ORDER_EXPIRY_DAYS = '4';
    pendingOrders([]);
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await POST(request('Bearer cron-secret'));

    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('using 5'));

    consoleWarnSpy.mockRestore();
  });

  it('PENDING_ORDER_EXPIRY_DAYS が5以上なら警告しない', async () => {
    process.env.PENDING_ORDER_EXPIRY_DAYS = '10';
    pendingOrders([]);
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await POST(request('Bearer cron-secret'));

    expect(consoleWarnSpy).not.toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });
});
