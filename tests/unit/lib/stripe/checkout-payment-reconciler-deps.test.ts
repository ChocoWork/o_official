jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

// 返金の同期の中身は order-refund-sync.test.ts が確かめる。ここでは、同期した後の注文の状態を返すことと、
// 一時的な失敗を照合の一時的な失敗にすることだけを確かめる
const mockSyncPaymentIntentRefunds = jest.fn();
jest.mock('@/lib/stripe/order-refund-sync', () => {
  class OrderNotFoundForPaymentIntentError extends Error {}
  class RefundSyncNotConvergedError extends Error {}
  return {
    OrderNotFoundForPaymentIntentError,
    RefundSyncNotConvergedError,
    syncPaymentIntentRefunds: (...args: unknown[]) => mockSyncPaymentIntentRefunds(...args),
  };
});
// 返金の部品。createDefaultReconcilerDeps が1回だけ作って、返金の同期に使うことを確かめる
const mockCreateDefaultRefundServiceDeps = jest.fn();
jest.mock('@/lib/orders/refund/refund-service', () => ({
  createDefaultRefundServiceDeps: (...args: unknown[]) => mockCreateDefaultRefundServiceDeps(...args),
}));
// createDefaultReconcilerDeps が作る client。この試験では中身を使わない
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({ name: 'service-role-client' })),
}));
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: jest.fn(() => ({ name: 'stripe-client' })),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import type { RefundServiceDeps } from '@/lib/orders/refund/refund-service';
import {
  createDefaultReconcilerDeps,
  createReconcilerRefundSync,
  createSupabaseReconcilerDatabase,
  isTransientSupabaseError,
  listUnsentShopAlerts,
} from '@/lib/stripe/checkout-payment-reconciler-deps';
import {
  OrderNotFoundForPaymentIntentError,
  RefundSyncNotConvergedError,
} from '@/lib/stripe/order-refund-sync';

/**
 * 照合関数と Supabase をつなぐ部分。RPC の名前と引数、戻り値の読み方、エラーの扱いを確かめる。
 */
type Result = { data: unknown; error: { message: string; code?: string } | null };

function fakeClient(options: {
  rpc?: (fn: string, args: Record<string, unknown>) => Result;
  select?: (table: string, column: string, value: unknown) => Result;
  update?: Result;
  list?: Result;
} = {}) {
  const rpc = jest.fn(async (fn: string, args: Record<string, unknown>) => options.rpc?.(fn, args) ?? { data: null, error: null });
  const selects: Array<{ table: string; column: string; value: unknown }> = [];
  const from = jest.fn((table: string) => ({
    select: () => ({
      eq: (column: string, value: unknown) => ({
        maybeSingle: async () => {
          selects.push({ table, column, value });
          return options.select?.(table, column, value) ?? { data: null, error: null };
        },
      }),
      is: () => ({
        is: () => ({
          order: () => ({
            limit: async () => options.list ?? { data: [], error: null },
          }),
        }),
      }),
    }),
    update: () => ({
      eq: async () => options.update ?? { data: null, error: null },
    }),
  }));
  return { client: { rpc, from } as unknown as SupabaseClient, rpc, from, selects };
}

describe('createSupabaseReconcilerDatabase', () => {
  it('注文は Session ID で引き、無ければ PaymentIntent ID で引く', async () => {
    const { client, selects } = fakeClient({
      select: (_table, column) =>
        column === 'payment_intent_id'
          ? {
              data: {
                id: 'order-1',
                status: 'pending',
                payment_intent_id: 'pi_1',
                checkout_session_id: null,
                total_amount: 5000,
                currency: 'jpy',
              },
              error: null,
            }
          : { data: null, error: null },
    });

    const order = await createSupabaseReconcilerDatabase(client).findOrder({ checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1' });

    expect(selects.map((call) => call.column)).toEqual(['checkout_session_id', 'payment_intent_id']);
    // 支払額の違いを毎回の照合で導き直すため、注文の額と通貨も読む（Task 11 の修正 5487bec5）
    expect(order).toEqual({
      id: 'order-1',
      status: 'pending',
      paymentIntentId: 'pi_1',
      checkoutSessionId: null,
      totalAmount: 5000,
      currency: 'jpy',
    });
  });

  it('code の無い Supabase のエラー（通信の失敗）は一時的な失敗（db_unavailable）にする', async () => {
    const { client } = fakeClient({ select: () => ({ data: null, error: { message: 'timeout' } }) });

    await expect(
      createSupabaseReconcilerDatabase(client).findOrder({ checkoutSessionId: 'cs_1', paymentIntentId: null }),
    ).rejects.toMatchObject({ name: 'ReconcileTransientError', code: 'db_unavailable' });
  });

  it('直列化の失敗（40001）の RPC も一時的な失敗（db_unavailable）にする', async () => {
    const { client } = fakeClient({ rpc: () => ({ data: null, error: { message: 'could not serialize access', code: '40001' } }) });

    await expect(
      createSupabaseReconcilerDatabase(client).markOrderAwaitingPayment({ orderId: 'order-1', paymentIntentId: 'pi_1', sourceEventId: null }),
    ).rejects.toMatchObject({ name: 'ReconcileTransientError', code: 'db_unavailable' });
  });

  it('恒久的なエラー（関数が無い 42883 など）は一時的な失敗にせず、元のエラーのまま投げる', async () => {
    const dbError = { message: 'function public.mark_order_awaiting_payment does not exist', code: '42883' };
    const { client } = fakeClient({ rpc: () => ({ data: null, error: dbError }) });

    await expect(
      createSupabaseReconcilerDatabase(client).markOrderAwaitingPayment({ orderId: 'order-1', paymentIntentId: 'pi_1', sourceEventId: null }),
    ).rejects.toBe(dbError);
  });

  it('受付 RPC に Stripe の値を渡し、受付と理由コードを読み分ける', async () => {
    const { client, rpc } = fakeClient({
      rpc: (_fn, args) =>
        args._draft_id === 'draft-ok'
          ? { data: [{ order_id: 'order-1', order_status: 'payment_in_progress', created: true, rejection: null }], error: null }
          : { data: [{ order_id: null, order_status: null, created: false, rejection: 'item_unavailable' }], error: null },
    });
    const database = createSupabaseReconcilerDatabase(client);
    const args = {
      checkoutSessionId: 'cs_1',
      cartSessionId: 'cart-1',
      amountTotal: 4000,
      amountDiscount: 1000,
      currency: 'jpy',
      sessionCreatedAt: new Date('2026-09-27T02:00:00.000Z'),
      paymentIntentId: 'pi_1',
    };

    expect(await database.placeOrder({ draftId: 'draft-ok', ...args })).toEqual({
      placed: true,
      orderId: 'order-1',
      orderStatus: 'payment_in_progress',
      created: true,
    });
    expect(await database.placeOrder({ draftId: 'draft-ng', ...args })).toEqual({ placed: false, rejection: 'item_unavailable' });
    expect(rpc).toHaveBeenCalledWith('place_order_from_checkout_draft', {
      _draft_id: 'draft-ok',
      _checkout_session_id: 'cs_1',
      _cart_session_id: 'cart-1',
      _stripe_amount_total: 4000,
      _stripe_amount_discount: 1000,
      _stripe_currency: 'jpy',
      _checkout_session_created_at: '2026-09-27T02:00:00.000Z',
      _payment_intent_id: 'pi_1',
    });
  });

  it('入金済み・在庫の戻しの RPC に名前付きの引数を渡し、結果を読む', async () => {
    const { client, rpc } = fakeClient({
      rpc: (fn) =>
        fn === 'mark_order_paid'
          ? { data: [{ updated: true, amount_matches: false, needs_review: true }], error: null }
          : { data: [{ released: true, order_id: 'order-1', status: 'cancelled' }], error: null },
    });
    const database = createSupabaseReconcilerDatabase(client);

    expect(await database.markOrderPaid({
      orderId: 'order-1',
      expectedStatus: 'pending',
      paymentIntentId: 'pi_1',
      paidAmount: 5000,
      paidCurrency: 'jpy',
      notifyCustomer: true,
      paidEmailVariant: 'payment_received',
      sourceEventId: 'evt_1',
    })).toEqual({ updated: true, amountMatches: false, needsReview: true });

    expect(rpc).toHaveBeenCalledWith('mark_order_paid', {
      _order_id: 'order-1',
      _expected_status: 'pending',
      _payment_intent_id: 'pi_1',
      _paid_amount: 5000,
      _paid_currency: 'jpy',
      _notify_customer: true,
      _paid_email_variant: 'payment_received',
      _source_event_id: 'evt_1',
    });

    expect(await database.releaseStock({
      orderId: 'order-1',
      expectedStatus: 'payment_in_progress',
      nextStatus: 'cancelled',
      changeReason: 'admin_cancel',
      actorId: 'admin-1',
      sourceEventId: null,
      cancelReason: 'other',
      cancelNote: 'メモ',
      notifyCustomer: false,
    })).toEqual({ released: true });

    expect(rpc).toHaveBeenCalledWith('release_stock_for_unpaid_order', {
      _order_id: 'order-1',
      _expected_status: 'payment_in_progress',
      _next_status: 'cancelled',
      _change_reason: 'admin_cancel',
      _actor_id: 'admin-1',
      _source_event_id: null,
      _cancel_reason: 'other',
      _cancel_note: 'メモ',
      _notify_customer: false,
    });
  });

  it('下書きの連絡先と配送先の欠落を読む', async () => {
    const { client } = fakeClient({
      select: () => ({
        data: { shipping_snapshot: { email: 'hanako@example.com', fullName: '山田 花子', address: '' } },
        error: null,
      }),
    });

    const contact = await createSupabaseReconcilerDatabase(client).findDraftContact('draft-1');

    expect(contact).toMatchObject({ email: 'hanako@example.com', fullName: '山田 花子' });
    expect(contact?.missingShippingFields).toContain('address');
  });

  it('支払方法を下書きへ書けなくても投げない', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client } = fakeClient({ update: { data: null, error: { message: 'timeout' } } });

    try {
      await expect(
        createSupabaseReconcilerDatabase(client).persistDraftPaymentMethod('draft-1', 'stripe_card'),
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith('[reconcile] failed to persist payment_method on checkout draft', 'draft-1', { message: 'timeout' });
    } finally {
      error.mockRestore();
    }
  });
});

describe('createReconcilerRefundSync', () => {
  /**
   * 照合が呼ぶ返金の同期（order-refund-sync.ts の syncPaymentIntentRefunds）。同期そのものは order-refund-sync.test.ts が確かめる。
   * ここでは、同期した後の注文の状態を返すことと、一時的な失敗（Stripe の通信・5xx・回数制限、DB の接続・直列化など）を
   * 照合の一時的な失敗にして投げ直し（呼び出し元が再試行する）、恒久的な失敗は元のエラーのまま投げることを確かめる。
   */
  const refundDeps = { name: 'refund-service-deps' } as unknown as RefundServiceDeps;
  const sync = createReconcilerRefundSync(refundDeps);

  beforeEach(() => {
    mockSyncPaymentIntentRefunds.mockReset();
  });

  it('PaymentIntent の返金を取り込み、取り込んだ後の注文の状態を返す', async () => {
    mockSyncPaymentIntentRefunds.mockResolvedValue({ kind: 'synced', orderId: 'order-1', orderStatus: 'paid', results: [] });

    await expect(sync('pi_1')).resolves.toBe('paid');

    expect(mockSyncPaymentIntentRefunds).toHaveBeenCalledWith(refundDeps, 'pi_1');
  });

  it('全額返金を取り込んで注文が取消になったら、取消を返す', async () => {
    mockSyncPaymentIntentRefunds.mockResolvedValue({ kind: 'synced', orderId: 'order-1', orderStatus: 'cancelled', results: [] });

    await expect(sync('pi_1')).resolves.toBe('cancelled');
  });

  it('入金が決まる前の注文（skipped_unpaid）は、その状態を返す', async () => {
    mockSyncPaymentIntentRefunds.mockResolvedValue({ kind: 'skipped_unpaid', orderId: 'order-1', orderStatus: 'pending' });

    await expect(sync('pi_1')).resolves.toBe('pending');
  });

  it('書いている間に返金が変わり続けて収まらない（RefundSyncNotConvergedError）失敗は、照合の一時的な失敗（not_converged）にする', async () => {
    // 同時の更新や Stripe の返金の変化は、読み直せば収まる。恒久的なエラーとして永久に失敗させない
    mockSyncPaymentIntentRefunds.mockRejectedValue(new RefundSyncNotConvergedError());

    await expect(sync('pi_1')).rejects.toMatchObject({ name: 'ReconcileTransientError', code: 'not_converged' });
  });

  it.each([
    ['通信の失敗', { type: 'StripeConnectionError' }],
    ['Stripe の障害', { type: 'StripeAPIError', statusCode: 500 }],
    ['回数制限', { type: 'StripeRateLimitError', statusCode: 429 }],
  ])('Stripe の一時的な失敗（%s）は、照合の一時的な失敗（stripe_unavailable）にする', async (_name, stripeError) => {
    mockSyncPaymentIntentRefunds.mockRejectedValue(stripeError);

    await expect(sync('pi_1')).rejects.toMatchObject({ name: 'ReconcileTransientError', code: 'stripe_unavailable' });
  });

  it('Stripe の恒久的なエラー（入力の誤りなど）は、元のエラーのまま投げる', async () => {
    const stripeError = { type: 'StripeInvalidRequestError', statusCode: 400 };
    mockSyncPaymentIntentRefunds.mockRejectedValue(stripeError);

    await expect(sync('pi_1')).rejects.toBe(stripeError);
  });

  it.each([
    ['code の無い（通信の失敗）', { message: 'timeout' }],
    ['接続の失敗（08006）', { message: 'connection failure', code: '08006' }],
    ['直列化の失敗（40001）', { message: 'could not serialize access', code: '40001' }],
  ])('DB の一時的な失敗（%s）は、照合の一時的な失敗（db_unavailable）にする', async (_name, dbError) => {
    // 取り込みは DB の失敗を message だけの Error にして投げ、元のエラー（code 付き）を cause に残す
    mockSyncPaymentIntentRefunds.mockRejectedValue(new Error('refund store failed: record_order_refund_result', { cause: dbError }));

    await expect(sync('pi_1')).rejects.toMatchObject({ name: 'ReconcileTransientError', code: 'db_unavailable' });
  });

  it.each([
    ['注文の読み取り', { message: 'permission denied', code: '42501' }, 'Failed to read order refund state: permission denied'],
    ['返金の記録の書き込み', { message: 'check constraint violated', code: '23514' }, 'refund store failed: record_order_refund_result'],
  ])('%sの恒久的なエラーは、一時的な失敗にせず、同じ内容のエラーのまま投げる', async (_name, dbError, message) => {
    const failure = new Error(message, { cause: dbError });
    mockSyncPaymentIntentRefunds.mockRejectedValue(failure);

    await expect(sync('pi_1')).rejects.toBe(failure);
  });

  it('原因を持たない失敗（cause が null）は、一時的な失敗にしない', async () => {
    const failure = new Error('refund store failed: record_order_refund_result', { cause: null });
    mockSyncPaymentIntentRefunds.mockRejectedValue(failure);

    await expect(sync('pi_1')).rejects.toBe(failure);
  });

  it('PaymentIntent に注文が無ければ、その型のエラーのまま投げる（一時的な失敗にしない）', async () => {
    mockSyncPaymentIntentRefunds.mockRejectedValue(new OrderNotFoundForPaymentIntentError());

    await expect(sync('pi_1')).rejects.toBeInstanceOf(OrderNotFoundForPaymentIntentError);
  });
});

describe('createDefaultReconcilerDeps', () => {
  it('返金の部品を1回だけ作り、決済の照合の返金の同期に使う（返金の部品は、この関数を呼び返さない）', async () => {
    const refundDeps = { name: 'refund-service-deps' };
    mockCreateDefaultRefundServiceDeps.mockResolvedValue(refundDeps);
    mockSyncPaymentIntentRefunds.mockResolvedValue({ kind: 'synced', orderId: 'order-1', orderStatus: 'cancelled', results: [] });

    const deps = await createDefaultReconcilerDeps();

    expect(mockCreateDefaultRefundServiceDeps).toHaveBeenCalledTimes(1);
    await expect(deps.syncRefunds('pi_1')).resolves.toBe('cancelled');
    expect(mockSyncPaymentIntentRefunds).toHaveBeenCalledWith(refundDeps, 'pi_1');
  });
});

describe('isTransientSupabaseError', () => {
  it.each([undefined, '', '08006', '40001', '40P01', '53300', '57014', '57P01', '57P02', '57P03', 'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003'])(
    'code %p は一時的な失敗（再試行する）',
    (code) => {
      expect(isTransientSupabaseError({ message: 'error', code })).toBe(true);
    },
  );

  it.each(['42883', '22023', '23505', '42501', 'PGRST116', 'PGRST203'])('code %p は恒久的なエラー（再試行しない）', (code) => {
    expect(isTransientSupabaseError({ message: 'error', code })).toBe(false);
  });
});

describe('listUnsentShopAlerts', () => {
  it('未解決で店へ未送信の要対応を、店へのメールの形で返す', async () => {
    const { client } = fakeClient({
      list: {
        data: [{
          id: 'exception-1',
          reason: 'paid_amount_mismatch',
          detail: null,
          order_id: 'order-1',
          payment_ref: 'cs_1',
          first_detected_at: '2026-09-27T01:00:00.000Z',
        }],
        error: null,
      },
    });

    expect(await listUnsentShopAlerts(client, 20)).toEqual([{
      exceptionId: 'exception-1',
      alert: {
        reason: 'paid_amount_mismatch',
        detail: null,
        orderId: 'order-1',
        paymentRef: 'cs_1',
        detectedAt: new Date('2026-09-27T01:00:00.000Z'),
      },
    }]);
  });
});
