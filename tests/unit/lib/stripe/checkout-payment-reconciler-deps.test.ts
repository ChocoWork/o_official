jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createReconcilerRefundSync,
  createSupabaseReconcilerDatabase,
  isTransientSupabaseError,
  listUnsentShopAlerts,
} from '@/lib/stripe/checkout-payment-reconciler-deps';
import {
  OrderNotFoundForPaymentIntentError,
  type OrderRefundDatabase,
  type RefundListClient,
  type RefundSnapshot,
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

    await expect(
      createSupabaseReconcilerDatabase(client).persistDraftPaymentMethod('draft-1', 'stripe_card'),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[reconcile] failed to persist payment_method on checkout draft', 'draft-1', { message: 'timeout' });
    error.mockRestore();
  });
});

describe('createReconcilerRefundSync', () => {
  /**
   * 照合が呼ぶ返金の同期（order-refund-sync.ts の syncOrderRefunds）。同期そのものは order-refund-sync.test.ts が確かめる。
   * ここでは、一時的な失敗（Stripe の通信・5xx・回数制限、DB の接続・直列化など）を照合の一時的な失敗にして投げ直し
   * （呼び出し元が再試行する）、恒久的な失敗は元のエラーのまま投げることを確かめる。
   */
  type DbResult = { data: unknown; error: { message: string; code?: string } | null };

  const PAID_ORDER = {
    id: 'order-1',
    status: 'paid',
    total_amount: 5000,
    refunded_amount: 0,
    payment_status_updated_at: null,
    shipped_at: null,
  };

  function refundSyncWorld(options: {
    order?: DbResult;
    rpc?: DbResult;
    refunds?: () => AsyncIterable<RefundSnapshot>;
  } = {}) {
    const rpc = jest.fn(async () => options.rpc ?? {
      data: [{ id: 'order-1', status: 'paid', refunded_amount: 2000 }],
      error: null,
    });
    const database = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => options.order ?? { data: PAID_ORDER, error: null } }),
        }),
      }),
      rpc,
    } as unknown as OrderRefundDatabase;
    const list = jest.fn(() => options.refunds?.() ?? succeededRefunds(2000));
    const stripe = { refunds: { list } } as unknown as RefundListClient;
    return { sync: createReconcilerRefundSync(database, stripe), rpc, list };
  }

  function succeededRefunds(amount: number): AsyncIterable<RefundSnapshot> {
    return {
      async *[Symbol.asyncIterator]() {
        yield { status: 'succeeded', amount, created: 1_786_000_000 };
      },
    };
  }

  function failingRefunds(error: unknown): () => AsyncIterable<RefundSnapshot> {
    return () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw error;
        },
      }),
    });
  }

  it('PaymentIntent の返金を Stripe から読み、返金投影の RPC で注文へ反映し、反映したあとの注文の状態を返す', async () => {
    const { sync, rpc, list } = refundSyncWorld();

    await expect(sync('pi_1')).resolves.toBe('paid');

    expect(list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 100 });
    expect(rpc).toHaveBeenCalledWith('apply_order_refund_projection', expect.objectContaining({
      _order_id: 'order-1',
      _expected_status: 'paid',
      _refunded_amount: 2000,
    }));
  });

  it('全額返金を反映して注文が取消になったら、取消を返す', async () => {
    const { sync, rpc } = refundSyncWorld({
      refunds: () => succeededRefunds(5000),
      rpc: { data: [{ id: 'order-1', status: 'cancelled', refunded_amount: 5000 }], error: null },
    });

    await expect(sync('pi_1')).resolves.toBe('cancelled');

    expect(rpc).toHaveBeenCalledWith('apply_order_refund_projection', expect.objectContaining({ _refunded_amount: 5000 }));
  });

  it('競合で収まらず（3回とも更新が0件）に失敗した返金の同期は、照合の一時的な失敗（not_converged）にする', async () => {
    // 同時の更新や Stripe の返金の変化は、読み直せば収まる。恒久的なエラーとして永久に失敗させない
    const { sync, rpc } = refundSyncWorld({ rpc: { data: [], error: null } });

    await expect(sync('pi_1')).rejects.toMatchObject({ name: 'ReconcileTransientError', code: 'not_converged' });
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['通信の失敗', { type: 'StripeConnectionError' }],
    ['Stripe の障害', { type: 'StripeAPIError', statusCode: 500 }],
    ['回数制限', { type: 'StripeRateLimitError', statusCode: 429 }],
  ])('Stripe の一時的な失敗（%s）は、照合の一時的な失敗（stripe_unavailable）にする', async (_name, stripeError) => {
    const { sync } = refundSyncWorld({ refunds: failingRefunds(stripeError) });

    await expect(sync('pi_1')).rejects.toMatchObject({ name: 'ReconcileTransientError', code: 'stripe_unavailable' });
  });

  it('Stripe の恒久的なエラー（入力の誤りなど）は、元のエラーのまま投げる', async () => {
    const stripeError = { type: 'StripeInvalidRequestError', statusCode: 400 };
    const { sync } = refundSyncWorld({ refunds: failingRefunds(stripeError) });

    await expect(sync('pi_1')).rejects.toBe(stripeError);
  });

  it.each([
    ['code の無い（通信の失敗）', { message: 'timeout' }],
    ['接続の失敗（08006）', { message: 'connection failure', code: '08006' }],
  ])('注文の読み取りの失敗（%s）は、照合の一時的な失敗（db_unavailable）にする', async (_name, dbError) => {
    const { sync, rpc } = refundSyncWorld({ order: { data: null, error: dbError } });

    await expect(sync('pi_1')).rejects.toMatchObject({ name: 'ReconcileTransientError', code: 'db_unavailable' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('返金投影の RPC の直列化の失敗（40001）も、照合の一時的な失敗（db_unavailable）にする', async () => {
    const { sync } = refundSyncWorld({
      rpc: { data: null, error: { message: 'could not serialize access', code: '40001' } },
    });

    await expect(sync('pi_1')).rejects.toMatchObject({ name: 'ReconcileTransientError', code: 'db_unavailable' });
  });

  it.each([
    ['注文の読み取り', { order: { data: null, error: { message: 'permission denied', code: '42501' } } }, 'Failed to read order refund state: permission denied'],
    ['返金投影の RPC', { rpc: { data: null, error: { message: 'check constraint violated', code: '23514' } } }, 'Failed to update order refund state: check constraint violated'],
  ])('%sの恒久的なエラーは、一時的な失敗にせず、これまでと同じ内容のエラーのまま投げる', async (_name, options, message) => {
    const { sync } = refundSyncWorld(options);

    const error = await sync('pi_1').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({ name: 'ReconcileTransientError' });
    expect((error as Error).message).toBe(message);
  });

  it('PaymentIntent に注文が無ければ、その型のエラーのまま投げる（一時的な失敗にしない）', async () => {
    const { sync } = refundSyncWorld({ order: { data: null, error: null } });

    await expect(sync('pi_1')).rejects.toBeInstanceOf(OrderNotFoundForPaymentIntentError);
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
