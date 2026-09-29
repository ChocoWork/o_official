jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createSupabaseReconcilerDatabase,
  isTransientSupabaseError,
  listUnsentShopAlerts,
} from '@/lib/stripe/checkout-payment-reconciler-deps';

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
      sourceEventId: 'evt_1',
    })).toEqual({ updated: true, amountMatches: false, needsReview: true });

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
    const { client } = fakeClient({ update: { data: null, error: { message: 'timeout' } } });

    await expect(
      createSupabaseReconcilerDatabase(client).persistDraftPaymentMethod('draft-1', 'stripe_card'),
    ).resolves.toBeUndefined();
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
