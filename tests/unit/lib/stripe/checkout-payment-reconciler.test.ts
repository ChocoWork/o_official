import {
  MAX_RECONCILE_ATTEMPTS,
  ReconcileTransientError,
  reconcileCheckoutPayment,
  type ReconcilerDatabase,
  type ReconcilerDeps,
  type ReconcilerMailer,
  type ReconcilerOrder,
} from '@/lib/stripe/checkout-payment-reconciler';
import type { CheckoutPaymentSnapshot } from '@/lib/stripe/checkout-payment-reader';
import type { StripePaymentState } from '@/lib/stripe/checkout-payment-decision';

/**
 * 照合関数（設計書 第2章・5-1）。読む → 判定 → 条件付き更新 → 読み直し（最大3回）。
 * DB は RPC と同じ「今の状態を条件にした更新」をメモリ上で再現する。
 */
const NOW = new Date('2026-09-27T03:00:00.000Z');
const SESSION_CREATED_AT = new Date('2026-09-27T02:00:00.000Z');
const PAID: StripePaymentState = { kind: 'paid', amountReceived: 5000, amountRefunded: 0, currency: 'jpy' };

function snapshot(state: StripePaymentState, overrides: Partial<CheckoutPaymentSnapshot> = {}): CheckoutPaymentSnapshot {
  return {
    checkoutSessionId: 'cs_1',
    paymentIntentId: 'pi_1',
    draftId: 'draft-1',
    cartSessionId: 'cart-1',
    sessionCreatedAt: SESSION_CREATED_AT,
    amountTotal: 5000,
    amountDiscount: 0,
    currency: 'jpy',
    paymentMethod: 'stripe_card',
    voucherExpiresAt: null,
    state,
    ...overrides,
  };
}

function order(status: ReconcilerOrder['status'], overrides: Partial<ReconcilerOrder> = {}): ReconcilerOrder {
  return {
    id: 'order-1',
    status,
    paymentIntentId: null,
    checkoutSessionId: 'cs_1',
    totalAmount: 5000,
    currency: 'jpy',
    ...overrides,
  };
}

type EnqueuedEmail = { orderId: string; kind: 'paid' | 'awaiting_payment' | 'payment_expired' | 'canceled'; variant: string | null };

const emailsOf = (h: { world: { enqueued: EnqueuedEmail[] } }, kind: EnqueuedEmail['kind']) => h.world.enqueued.filter((email) => email.kind === kind);

function harness(init: {
  stripe: CheckoutPaymentSnapshot;
  order?: ReconcilerOrder | null;
  amountMatches?: boolean;
  needsReview?: boolean;
}) {
  const world: { stripe: CheckoutPaymentSnapshot; order: ReconcilerOrder | null; enqueued: EnqueuedEmail[] } = {
    stripe: init.stripe,
    order: init.order ?? null,
    enqueued: [],
  };
  const exceptions = new Map<string, { id: string; resolved: boolean }>();

  const database: ReconcilerDatabase = {
    async findOrder() {
      return world.order ? { ...world.order } : null;
    },
    async placeOrder(args) {
      if (!world.order) {
        world.order = {
          id: 'order-new',
          status: 'payment_in_progress',
          paymentIntentId: args.paymentIntentId,
          checkoutSessionId: args.checkoutSessionId,
          totalAmount: args.amountTotal,
          currency: args.currency,
        };
        return { placed: true, orderId: world.order.id, orderStatus: world.order.status, created: true };
      }
      return { placed: true, orderId: world.order.id, orderStatus: world.order.status, created: false };
    },
    async markOrderPaid(args) {
      if (!world.order || world.order.status !== args.expectedStatus) {
        return { updated: false, amountMatches: false, needsReview: false };
      }
      world.order = { ...world.order, status: 'paid', paymentIntentId: world.order.paymentIntentId ?? args.paymentIntentId };
      const amountMatches = init.amountMatches ?? true;
      // DB の mark_order_paid と同じく、金額が合い「送る」の時だけ注文確認の行を書く
      if (amountMatches && args.notifyCustomer) {
        world.enqueued.push({ orderId: world.order.id, kind: 'paid', variant: args.paidEmailVariant });
      }
      return { updated: true, amountMatches, needsReview: init.needsReview ?? false };
    },
    async markOrderAwaitingPayment(args) {
      if (!world.order || world.order.status !== 'payment_in_progress') {
        return { updated: false };
      }
      world.order = { ...world.order, status: 'pending', paymentIntentId: world.order.paymentIntentId ?? args.paymentIntentId };
      world.enqueued.push({ orderId: world.order.id, kind: 'awaiting_payment', variant: null });
      return { updated: true };
    },
    async releaseStock(args) {
      if (!world.order || world.order.status !== args.expectedStatus) {
        return { released: false };
      }
      world.order = { ...world.order, status: args.nextStatus };
      if (args.nextStatus === 'failed') {
        world.enqueued.push({ orderId: world.order.id, kind: 'payment_expired', variant: null });
      } else if (args.nextStatus === 'cancelled' && args.notifyCustomer) {
        world.enqueued.push({ orderId: world.order.id, kind: 'canceled', variant: args.expectedStatus });
      }
      return { released: true };
    },
    async recordException(args) {
      const key = `${args.paymentRef}:${args.reason}`;
      const existing = exceptions.get(key);
      if (existing) {
        return { exceptionId: existing.id, isNew: false, isResolved: existing.resolved };
      }
      const id = `exception-${exceptions.size + 1}`;
      exceptions.set(key, { id, resolved: false });
      return { exceptionId: id, isNew: true, isResolved: false };
    },
    async claimExceptionNotification() {
      return true;
    },
    async releaseExceptionNotification() {},
    async findDraftContact() {
      return { email: 'hanako@example.com', fullName: '山田 花子', missingShippingFields: [] };
    },
    async persistDraftPaymentMethod() {},
  };

  const mailer: ReconcilerMailer = {
    async sendUnplacedPaymentNotice() {
      return true;
    },
    async sendShopAlert() {
      return true;
    },
  };

  for (const key of Object.keys(database) as Array<keyof ReconcilerDatabase>) jest.spyOn(database, key);
  for (const key of Object.keys(mailer) as Array<keyof ReconcilerMailer>) jest.spyOn(mailer, key);

  const readPayment = jest.fn(async () => world.stripe);
  const audit = jest.fn(async () => undefined);
  // 返金の同期は、同期したあとの注文の状態を返す。既定は今の注文の状態のまま（返金で取消になるときだけ、テストが上書きする）
  const syncRefunds = jest.fn<Promise<ReconcilerOrder['status']>, [string]>(async () => world.order?.status ?? 'paid');
  const deps: ReconcilerDeps = { readPayment, database, mailer, audit, syncRefunds, now: () => NOW };
  return { deps, database, mailer, readPayment, audit, syncRefunds, world };
}

describe('reconcileCheckoutPayment', () => {
  it('支払い手続き中の注文を入金済みにし、注文確定メールを送り、支払方法を下書きへ残す', async () => {
    const h = harness({ stripe: snapshot(PAID), order: order('payment_in_progress') });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1', sourceEventId: 'evt_1' });

    expect(h.database.markOrderPaid).toHaveBeenCalledWith({
      orderId: 'order-1',
      expectedStatus: 'payment_in_progress',
      paymentIntentId: 'pi_1',
      paidAmount: 5000,
      paidCurrency: 'jpy',
      notifyCustomer: true,
      paidEmailVariant: 'order_confirmed',
      sourceEventId: 'evt_1',
    });
    expect(emailsOf(h, 'paid')).toEqual([{ orderId: 'order-1', kind: 'paid', variant: 'order_confirmed' }]);
    expect(h.database.persistDraftPaymentMethod).toHaveBeenCalledWith('draft-1', 'stripe_card');
    expect(result).toEqual({
      kind: 'ok',
      action: { type: 'mark_paid', expectedStatus: 'payment_in_progress', emailVariant: 'order_confirmed' },
      orderId: 'order-1',
      orderStatus: 'paid',
    });
    // 書いた後に Stripe を読み直して収まったことを確かめる
    expect(h.readPayment).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it('受付を通らない入金済みの支払いは、受付 RPC で作ってから入金済みにする（予備処理）', async () => {
    const h = harness({
      stripe: snapshot(
        { kind: 'paid', amountReceived: 4000, amountRefunded: 0, currency: 'jpy' },
        { amountTotal: 4000, amountDiscount: 1000 },
      ),
    });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(h.database.placeOrder).toHaveBeenCalledWith({
      draftId: 'draft-1',
      checkoutSessionId: 'cs_1',
      cartSessionId: 'cart-1',
      amountTotal: 4000,
      amountDiscount: 1000,
      currency: 'jpy',
      sessionCreatedAt: SESSION_CREATED_AT,
      paymentIntentId: 'pi_1',
    });
    expect(emailsOf(h, 'paid')).toEqual([{ orderId: 'order-new', kind: 'paid', variant: 'order_confirmed' }]);
    expect(result).toMatchObject({ kind: 'ok', action: { type: 'place_and_mark_paid' }, orderId: 'order-new', orderStatus: 'paid' });
  });

  it('受付を通らない払込票の発行は、受付 RPC で作ってから入金待ちにし、お支払い待ちメールを送る', async () => {
    const h = harness({ stripe: snapshot({ kind: 'awaiting_payment' }) });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(h.database.markOrderAwaitingPayment).toHaveBeenCalledWith({
      orderId: 'order-new',
      paymentIntentId: 'pi_1',
      sourceEventId: null,
    });
    expect(emailsOf(h, 'awaiting_payment')).toEqual([{ orderId: 'order-new', kind: 'awaiting_payment', variant: null }]);
    expect(result).toMatchObject({ kind: 'ok', orderId: 'order-new', orderStatus: 'pending' });
  });

  it('配送先が欠けた下書きでも注文は作り、欠けた項目を記録する（FREQ-365）', async () => {
    const h = harness({ stripe: snapshot(PAID) });
    jest.spyOn(h.database, 'findDraftContact').mockResolvedValue({
      email: 'hanako@example.com',
      fullName: '山田 花子',
      missingShippingFields: ['address'],
    });

    await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error',
      detail: 'Checkout draft shipping snapshot is incomplete',
      metadata: expect.objectContaining({ missing_shipping_fields: ['address'] }),
    }));
    expect(h.database.placeOrder).toHaveBeenCalled();
  });

  it('受付 RPC が断ったら要対応にし、店とお客様に知らせる', async () => {
    const h = harness({ stripe: snapshot(PAID) });
    jest.spyOn(h.database, 'placeOrder').mockResolvedValueOnce({ placed: false, rejection: 'item_unavailable' });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toEqual({
      kind: 'needs_action',
      exceptionId: 'exception-1',
      reason: 'order_not_creatable',
      orderId: null,
      orderStatus: null,
    });
    expect(h.database.recordException).toHaveBeenCalledWith({
      paymentRef: 'cs_1',
      reason: 'order_not_creatable',
      detail: 'item_unavailable',
      checkoutSessionId: 'cs_1',
      paymentIntentId: 'pi_1',
      draftId: 'draft-1',
      orderId: null,
    });
    expect(h.mailer.sendShopAlert).toHaveBeenCalledWith({
      reason: 'order_not_creatable',
      detail: 'item_unavailable',
      orderId: null,
      paymentRef: 'cs_1',
      detectedAt: NOW,
    });
    expect(h.mailer.sendUnplacedPaymentNotice).toHaveBeenCalledWith({
      to: 'hanako@example.com',
      fullName: '山田 花子',
      state: 'paid',
    });
    expect(h.database.markOrderPaid).not.toHaveBeenCalled();
  });

  it('送信権を取れなければ店にもお客様にも送らない（二重に知らせない）', async () => {
    const h = harness({ stripe: snapshot(PAID) });
    jest.spyOn(h.database, 'placeOrder').mockResolvedValue({ placed: false, rejection: 'item_unavailable' });
    jest.spyOn(h.database, 'claimExceptionNotification').mockResolvedValue(false);

    await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(h.mailer.sendShopAlert).not.toHaveBeenCalled();
    expect(h.mailer.sendUnplacedPaymentNotice).not.toHaveBeenCalled();
  });

  it('店へのメールが送れなければ送信権を戻す（見回りが送り直す）', async () => {
    const h = harness({ stripe: snapshot({ kind: 'missing' }), order: order('pending', { paymentIntentId: 'pi_1' }) });
    jest.spyOn(h.mailer, 'sendShopAlert').mockResolvedValue(false);

    await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(h.database.releaseExceptionNotification).toHaveBeenCalledWith('exception-1', 'shop');
  });

  it('解決済みの要対応は、再び検知しても知らせない', async () => {
    const h = harness({ stripe: snapshot({ kind: 'missing' }), order: order('pending', { paymentIntentId: 'pi_1' }) });
    jest.spyOn(h.database, 'recordException').mockResolvedValue({ exceptionId: 'exception-9', isNew: false, isResolved: true });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toMatchObject({ kind: 'needs_action', reason: 'stripe_object_missing', orderId: 'order-1' });
    expect(h.database.claimExceptionNotification).not.toHaveBeenCalled();
  });

  it('支払額が注文と違えば入金済みにして要対応にし、注文確定メールは送らない', async () => {
    const h = harness({ stripe: snapshot(PAID), order: order('payment_in_progress'), amountMatches: false });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toEqual({
      kind: 'needs_action',
      exceptionId: 'exception-1',
      reason: 'paid_amount_mismatch',
      orderId: 'order-1',
      orderStatus: 'paid',
    });
    expect([...emailsOf(h, 'paid'), ...emailsOf(h, 'awaiting_payment')]).toEqual([]);
    expect(h.mailer.sendUnplacedPaymentNotice).not.toHaveBeenCalled();
    expect(h.mailer.sendShopAlert).toHaveBeenCalledTimes(1);
  });

  it('入金済みにした直後の要対応の記録が失敗しても、次の照合で不一致を導き直して知らせる（fix round 1）', async () => {
    const h = harness({
      stripe: snapshot(PAID),
      order: order('payment_in_progress', { totalAmount: 4500 }),
      amountMatches: false,
    });
    jest.spyOn(h.database, 'recordException').mockRejectedValueOnce(new Error('db down'));

    await expect(reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' })).rejects.toThrow('db down');
    expect(h.world.order?.status).toBe('paid');

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toMatchObject({
      kind: 'needs_action',
      reason: 'paid_amount_mismatch',
      orderId: 'order-1',
      orderStatus: 'paid',
    });
    expect(h.database.recordException).toHaveBeenCalledTimes(2);
    expect(h.mailer.sendShopAlert).toHaveBeenCalledTimes(1);
    expect([...emailsOf(h, 'paid'), ...emailsOf(h, 'awaiting_payment')]).toEqual([]);
  });

  it('入金済み × 入金済みで金額が一致すれば、導き直しても何もしない（fix round 1）', async () => {
    const h = harness({ stripe: snapshot(PAID), order: order('paid', { paymentIntentId: 'pi_1', totalAmount: 5000 }) });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toEqual({ kind: 'ok', action: { type: 'none' }, orderId: 'order-1', orderStatus: 'paid' });
    expect(h.database.recordException).not.toHaveBeenCalled();
    expect(h.mailer.sendShopAlert).not.toHaveBeenCalled();
  });

  it('金額不一致の要対応が解決済みなら、導き直しても知らせ直さない（fix round 1）', async () => {
    const h = harness({ stripe: snapshot(PAID), order: order('paid', { paymentIntentId: 'pi_1', totalAmount: 4500 }) });
    jest.spyOn(h.database, 'recordException').mockResolvedValue({ exceptionId: 'exception-9', isNew: false, isResolved: true });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toMatchObject({ kind: 'needs_action', reason: 'paid_amount_mismatch', orderId: 'order-1' });
    expect(h.database.claimExceptionNotification).not.toHaveBeenCalled();
    expect(h.mailer.sendShopAlert).not.toHaveBeenCalled();
  });

  it('発送済みでも通貨が違えば、金額の不一致として要対応にする（fix round 1）', async () => {
    const h = harness({
      stripe: snapshot(PAID),
      order: order('shipped', { paymentIntentId: 'pi_1', totalAmount: 5000, currency: 'USD' }),
    });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toMatchObject({
      kind: 'needs_action',
      reason: 'paid_amount_mismatch',
      orderId: 'order-1',
      orderStatus: 'shipped',
    });
    expect(h.database.recordException).toHaveBeenCalledWith(expect.objectContaining({ reason: 'paid_amount_mismatch' }));
    expect(h.mailer.sendShopAlert).toHaveBeenCalledTimes(1);
  });

  it('失敗の後の入金で在庫を確保し直せなければ要確認を返す（⑤）', async () => {
    const h = harness({ stripe: snapshot(PAID), order: order('failed', { paymentIntentId: 'pi_1' }), needsReview: true });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(emailsOf(h, 'paid')).toEqual([{ orderId: 'order-1', kind: 'paid', variant: 'payment_received_after_expiry' }]);
    expect(result).toMatchObject({ kind: 'needs_review', orderId: 'order-1', orderStatus: 'paid' });
  });

  it('払込票の期限切れは在庫を戻して失敗にし、期限切れのお知らせを送る', async () => {
    const h = harness({ stripe: snapshot({ kind: 'voucher_expired' }), order: order('pending', { paymentIntentId: 'pi_1' }) });

    const result = await reconcileCheckoutPayment(h.deps, { paymentIntentId: 'pi_1', sourceEventId: 'evt_failed' });

    expect(h.database.releaseStock).toHaveBeenCalledWith({
      orderId: 'order-1',
      expectedStatus: 'pending',
      nextStatus: 'failed',
      changeReason: 'stripe_voucher_expired',
      actorId: null,
      sourceEventId: 'evt_failed',
      cancelReason: null,
      cancelNote: null,
      notifyCustomer: null,
    });
    expect(emailsOf(h, 'payment_expired')).toEqual([{ orderId: 'order-1', kind: 'payment_expired', variant: null }]);
    expect(result).toMatchObject({ kind: 'ok', orderStatus: 'failed' });
  });

  it('下書き ID の無い Session でも注文があれば Stripe の状態に従い、ほかの注文と同じく失敗にする（移行前の注文。設計書 7-1）', async () => {
    // 見回りが PaymentIntent から引いた移行前の注文の Session。PaymentIntent が requires_payment_method（払込票の期限切れ）
    const h = harness({
      stripe: snapshot(
        { kind: 'voucher_expired' },
        { checkoutSessionId: 'cs_legacy', paymentIntentId: 'pi_legacy', draftId: null, cartSessionId: null },
      ),
      order: order('pending', { id: 'order-legacy', paymentIntentId: 'pi_legacy', checkoutSessionId: null }),
    });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: null, paymentIntentId: 'pi_legacy' });

    expect(h.database.releaseStock).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-legacy',
      expectedStatus: 'pending',
      nextStatus: 'failed',
      changeReason: 'stripe_voucher_expired',
    }));
    // 行を書くかは DB が決める（移行前の2件は取りやめの行を移してあるので、自動の行はもう書かれない）
    expect(emailsOf(h, 'payment_expired')).toEqual([{ orderId: 'order-legacy', kind: 'payment_expired', variant: null }]);
    expect(h.database.recordException).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: 'ok',
      action: { type: 'release', expectedStatus: 'pending', nextStatus: 'failed' },
      orderId: 'order-legacy',
      orderStatus: 'failed',
    });
  });

  it('決済画面の放棄は在庫を戻して放棄にし、メールは送らない', async () => {
    const h = harness({
      stripe: snapshot({ kind: 'checkout_abandoned' }, { paymentIntentId: null }),
      order: order('payment_in_progress'),
    });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(h.database.releaseStock).toHaveBeenCalledWith(expect.objectContaining({
      nextStatus: 'abandoned',
      changeReason: 'stripe_checkout_expired',
    }));
    expect(emailsOf(h, 'payment_expired')).toEqual([]);
    expect(emailsOf(h, 'canceled')).toEqual([]);
    expect(result).toMatchObject({ kind: 'ok', orderStatus: 'abandoned' });
  });

  it.each([true, false])('管理画面の取消は実行者・理由・メモを渡し、お知らせは notifyCustomer=%s のときだけ送る', async (notifyCustomer) => {
    const h = harness({
      stripe: snapshot({ kind: 'checkout_abandoned' }, { paymentIntentId: null }),
      order: order('payment_in_progress'),
    });

    const result = await reconcileCheckoutPayment(h.deps, {
      checkoutSessionId: 'cs_1',
      adminCancel: { actorId: 'admin-1', reason: 'customer_request', note: ' 電話で依頼 ', notifyCustomer },
    });

    expect(h.database.releaseStock).toHaveBeenCalledWith({
      orderId: 'order-1',
      expectedStatus: 'payment_in_progress',
      nextStatus: 'cancelled',
      changeReason: 'admin_cancel',
      actorId: 'admin-1',
      sourceEventId: null,
      cancelReason: 'customer_request',
      cancelNote: '電話で依頼',
      notifyCustomer,
    });
    expect(emailsOf(h, 'canceled')).toEqual(notifyCustomer ? [{ orderId: 'order-1', kind: 'canceled', variant: 'payment_in_progress' }] : []);
    expect(result).toMatchObject({ kind: 'ok', orderStatus: 'cancelled' });
  });

  it('取り消した注文への未返金の入金は要対応にし、お客様には案内しない', async () => {
    const h = harness({ stripe: snapshot(PAID), order: order('cancelled', { paymentIntentId: 'pi_1' }) });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toMatchObject({ kind: 'needs_action', reason: 'cancelled_order_paid', orderId: 'order-1' });
    expect(h.mailer.sendUnplacedPaymentNotice).not.toHaveBeenCalled();
  });

  describe('Stripe に返金済みの分がある入金済みの支払い（返金が注文より先に起きた場合）', () => {
    // 注文を作れず要対応になった支払いを店が Stripe で返金したあと、同じ支払いが再び照合される
    // （完了 API の再呼び出し・Webhook の再試行・見回りの紐付け）。返金済みの分が注文に残らないようにする。
    const REFUNDED: StripePaymentState = { kind: 'paid', amountReceived: 5000, amountRefunded: 2000, currency: 'jpy' };
    const FULLY_REFUNDED: StripePaymentState = { kind: 'paid', amountReceived: 5000, amountRefunded: 5000, currency: 'jpy' };

    it('注文が無く全額返金済みなら、注文を作らず記録だけにし、注文確定メールを送らない', async () => {
      const h = harness({ stripe: snapshot(FULLY_REFUNDED) });

      const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1', sourceEventId: 'evt_late' });

      expect(result).toEqual({
        kind: 'ok',
        action: { type: 'record_only', note: 'refunded_before_order' },
        orderId: null,
        orderStatus: null,
      });
      // 注文を読む以外は何も書かない・送らない。返金の同期も、同期する注文が無いので呼ばない
      const writes = (Object.keys(h.database) as Array<keyof ReconcilerDatabase>).filter((key) => key !== 'findOrder');
      for (const key of writes) expect(h.database[key]).not.toHaveBeenCalled();
      for (const key of Object.keys(h.mailer) as Array<keyof ReconcilerMailer>) expect(h.mailer[key]).not.toHaveBeenCalled();
      expect(h.world.enqueued).toEqual([]);
      expect(h.syncRefunds).not.toHaveBeenCalled();
      expect(h.audit).toHaveBeenCalledTimes(1);
      expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'success',
        detail: 'ok:record_only:refunded_before_order',
        metadata: expect.objectContaining({ payment_intent_id: 'pi_1', source_event_id: 'evt_late', stripe_state: 'paid' }),
      }));
    });

    it('注文が無く一部だけ返金済みなら、これまでどおり注文を作って入金済みにし、返金済みの分を同じ照合で反映する', async () => {
      const h = harness({ stripe: snapshot(REFUNDED) });

      const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

      expect(h.database.placeOrder).toHaveBeenCalledTimes(1);
      expect(h.database.markOrderPaid).toHaveBeenCalledTimes(1);
      expect(emailsOf(h, 'paid')).toHaveLength(1);
      expect(emailsOf(h, 'paid')).toEqual([{ orderId: 'order-new', kind: 'paid', variant: 'order_confirmed' }]);
      expect(h.syncRefunds).toHaveBeenCalledTimes(1);
      expect(h.syncRefunds).toHaveBeenCalledWith('pi_1');
      expect(result).toMatchObject({
        kind: 'ok',
        action: { type: 'place_and_mark_paid' },
        orderId: 'order-new',
        orderStatus: 'paid',
      });
    });

    it.each([
      ['支払い手続き中', order('payment_in_progress')],
      ['入金待ち', order('pending', { paymentIntentId: 'pi_1' })],
      ['失敗', order('failed', { paymentIntentId: 'pi_1' })],
    ])(
      '全額返金済みの支払いで%sの注文を入金済みにするときは、注文確定・入金確認のメールを送らず、取り消された状態を結果にする',
      async (_name, existing) => {
        const h = harness({ stripe: snapshot(FULLY_REFUNDED), order: existing });
        h.syncRefunds.mockResolvedValueOnce('cancelled');

        const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

        expect(h.database.markOrderPaid).toHaveBeenCalledTimes(1);
        expect(h.database.markOrderPaid).toHaveBeenCalledWith(expect.objectContaining({ notifyCustomer: false }));
        expect([...emailsOf(h, 'paid'), ...emailsOf(h, 'awaiting_payment')]).toEqual([]);
        expect(h.database.persistDraftPaymentMethod).toHaveBeenCalledWith('draft-1', 'stripe_card');
        expect(h.syncRefunds).toHaveBeenCalledWith('pi_1');
        // 同期の前の「入金済み」ではなく、同期のあとの「取消」を返す（完了 API・管理画面の取消が、取り消された注文を入金完了と扱わない）
        expect(result).toMatchObject({ kind: 'ok', orderId: 'order-1', orderStatus: 'cancelled' });
      },
    );

    it('入金済みの注文が返金の同期で取り消されたら、「何もしない」判定でも取消を結果にする', async () => {
      const h = harness({ stripe: snapshot(FULLY_REFUNDED), order: order('paid', { paymentIntentId: 'pi_1' }) });
      h.syncRefunds.mockResolvedValueOnce('cancelled');

      const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

      expect(result).toEqual({ kind: 'ok', action: { type: 'none' }, orderId: 'order-1', orderStatus: 'cancelled' });
    });

    it('要確認の結果にも、返金の同期のあとの状態を載せる', async () => {
      const h = harness({
        stripe: snapshot(FULLY_REFUNDED),
        order: order('failed', { paymentIntentId: 'pi_1' }),
        needsReview: true,
      });
      h.syncRefunds.mockResolvedValueOnce('cancelled');

      const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

      expect(result).toMatchObject({ kind: 'needs_review', orderId: 'order-1', orderStatus: 'cancelled' });
    });

    it('支払い手続き中の注文を入金済みにした後で、返金済みの分があれば返金の同期を呼ぶ', async () => {
      const h = harness({ stripe: snapshot(REFUNDED), order: order('payment_in_progress') });

      const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1', sourceEventId: 'evt_1' });

      expect(result).toEqual({
        kind: 'ok',
        action: { type: 'mark_paid', expectedStatus: 'payment_in_progress', emailVariant: 'order_confirmed' },
        orderId: 'order-1',
        orderStatus: 'paid',
      });
      // 一部だけの返金なら、注文確定メールはこれまでどおり1通送る
      expect(emailsOf(h, 'paid')).toHaveLength(1);
      expect(h.syncRefunds).toHaveBeenCalledTimes(1);
      expect(h.syncRefunds).toHaveBeenCalledWith('pi_1');
      // 注文が入金済みになってから、返金を反映する
      const markPaidOrder = (h.database.markOrderPaid as jest.Mock).mock.invocationCallOrder[0];
      expect(markPaidOrder).toBeLessThan(h.syncRefunds.mock.invocationCallOrder[0]);
    });

    it.each(['paid', 'shipped'] as const)(
      '%s の注文は、照合が何もしない判定でも、返金済みの分があれば返金の同期を呼ぶ',
      async (status) => {
        const h = harness({ stripe: snapshot(REFUNDED), order: order(status, { paymentIntentId: 'pi_1' }) });

        const result = await reconcileCheckoutPayment(h.deps, { paymentIntentId: 'pi_1', sourceEventId: 'evt_late' });

        expect(result).toEqual({ kind: 'ok', action: { type: 'none' }, orderId: 'order-1', orderStatus: status });
        expect(h.syncRefunds).toHaveBeenCalledTimes(1);
        expect(h.syncRefunds).toHaveBeenCalledWith('pi_1');
        expect(h.database.markOrderPaid).not.toHaveBeenCalled();
        expect([...emailsOf(h, 'paid'), ...emailsOf(h, 'awaiting_payment')]).toEqual([]);
      },
    );

    it.each([
      ['入金済みの注文', order('paid', { paymentIntentId: 'pi_1' })],
      ['入金済みにする注文', order('payment_in_progress')],
    ])('返金済みの分が0なら、%sでも返金の同期を呼ばない', async (_name, existing) => {
      const h = harness({ stripe: snapshot(PAID), order: existing });

      await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

      expect(h.syncRefunds).not.toHaveBeenCalled();
    });

    it('全額返金で取り消された注文では、返金の同期を呼ばない', async () => {
      const h = harness({ stripe: snapshot(FULLY_REFUNDED), order: order('cancelled', { paymentIntentId: 'pi_1' }) });

      const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

      expect(result).toEqual({ kind: 'ok', action: { type: 'none' }, orderId: 'order-1', orderStatus: 'cancelled' });
      expect(h.syncRefunds).not.toHaveBeenCalled();
    });

    it('返金の同期が一時的に失敗したらその失敗を投げ、入金済みにした注文は戻さず、次の照合で返金を反映する', async () => {
      const h = harness({ stripe: snapshot(REFUNDED), order: order('payment_in_progress') });
      h.syncRefunds.mockRejectedValueOnce(new ReconcileTransientError('stripe_unavailable'));

      await expect(reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' })).rejects.toMatchObject({
        name: 'ReconcileTransientError',
        code: 'stripe_unavailable',
      });
      expect(h.world.order?.status).toBe('paid');

      const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

      expect(result).toMatchObject({ kind: 'ok', action: { type: 'none' }, orderId: 'order-1', orderStatus: 'paid' });
      expect(h.syncRefunds).toHaveBeenCalledTimes(2);
      // 入金済みにするのも注文確定メールも、1回だけ
      expect(h.database.markOrderPaid).toHaveBeenCalledTimes(1);
      expect(emailsOf(h, 'paid')).toHaveLength(1);
    });

    it('返金の同期の恒久的な失敗は、これまでの失敗と同じく元のエラーのまま投げる', async () => {
      const h = harness({ stripe: snapshot(REFUNDED), order: order('paid', { paymentIntentId: 'pi_1' }) });
      const failure = new Error('Failed to update order refund state: permission denied');
      h.syncRefunds.mockRejectedValue(failure);

      await expect(reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' })).rejects.toBe(failure);
      expect(h.audit).not.toHaveBeenCalled();
    });
  });

  it('注文の PaymentIntent と Stripe の PaymentIntent が違えば、矛盾として要対応にする', async () => {
    const h = harness({ stripe: snapshot(PAID), order: order('pending', { paymentIntentId: 'pi_other' }) });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toMatchObject({ kind: 'needs_action', reason: 'state_conflict' });
    expect(h.database.recordException).toHaveBeenCalledWith(expect.objectContaining({ detail: 'payment_intent_mismatch' }));
    expect(h.database.markOrderPaid).not.toHaveBeenCalled();
  });

  it('0円で完了した支払い（注文なし）は記録だけにし、理由を監査ログに残す（FREQ-389・397）', async () => {
    const h = harness({ stripe: snapshot({ kind: 'zero_amount_complete' }, { paymentIntentId: null }) });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toMatchObject({ kind: 'ok', action: { type: 'record_only', note: 'zero_amount' }, orderId: null });
    expect(h.database.placeOrder).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'ok:record_only:zero_amount' }));
  });

  it('下書き ID の無い入金済みの支払いで注文も無ければ、何も書かずに監査ログへ残すだけにする（当店の Checkout 以外。設計書 3-2）', async () => {
    const h = harness({ stripe: snapshot(PAID, { draftId: null, cartSessionId: null }) });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toEqual({ kind: 'ok', action: { type: 'record_only', note: 'not_applicable' }, orderId: null, orderStatus: null });
    const writes = (Object.keys(h.database) as Array<keyof ReconcilerDatabase>).filter((key) => key !== 'findOrder');
    for (const key of writes) expect(h.database[key]).not.toHaveBeenCalled();
    for (const key of Object.keys(h.mailer) as Array<keyof ReconcilerMailer>) expect(h.mailer[key]).not.toHaveBeenCalled();
    expect(h.world.enqueued).toEqual([]);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', detail: 'ok:record_only:not_applicable' }));
  });

  it('Stripe に無く注文も無ければ、下書き ID を読めなくても「Stripe に無い」の記録のままにする', async () => {
    const h = harness({ stripe: snapshot({ kind: 'missing' }, { paymentIntentId: null, draftId: null, cartSessionId: null }) });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toEqual({
      kind: 'ok',
      action: { type: 'record_only', note: 'stripe_object_missing' },
      orderId: null,
      orderStatus: null,
    });
  });

  it('Stripe を読めなければ何も変えずに一時的な失敗を投げる', async () => {
    const h = harness({ stripe: snapshot(PAID), order: order('payment_in_progress') });
    h.readPayment.mockRejectedValueOnce(new ReconcileTransientError('stripe_unavailable'));

    await expect(reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' })).rejects.toMatchObject({
      code: 'stripe_unavailable',
    });
    expect(h.database.findOrder).not.toHaveBeenCalled();
    expect(h.database.markOrderPaid).not.toHaveBeenCalled();
  });

  it('先に別の経路が動かしていたら（条件付き更新が0件）、読み直して何もしない', async () => {
    const h = harness({ stripe: snapshot(PAID), order: order('payment_in_progress') });
    jest.spyOn(h.database, 'markOrderPaid').mockImplementationOnce(async () => {
      h.world.order = { ...(h.world.order as ReconcilerOrder), status: 'paid' };
      return { updated: false, amountMatches: false, needsReview: false };
    });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toEqual({ kind: 'ok', action: { type: 'none' }, orderId: 'order-1', orderStatus: 'paid' });
    expect([...emailsOf(h, 'paid'), ...emailsOf(h, 'awaiting_payment')]).toEqual([]);
  });

  it('古い Stripe の状態と新しい注文の起きないマス（手続き中 × 入金済み）は、記録せずに読み直す', async () => {
    const h = harness({ stripe: snapshot(PAID), order: order('payment_in_progress') });
    // Stripe を読んだ後、注文を読む前に別の経路が入金済みにする。1回目は古い「手続き中」と新しい「入金済み」の組み合わせになる
    h.readPayment.mockImplementationOnce(async () => {
      h.world.order = { ...(h.world.order as ReconcilerOrder), status: 'paid', paymentIntentId: 'pi_1' };
      return snapshot({ kind: 'in_progress' }, { paymentIntentId: null });
    });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toEqual({ kind: 'ok', action: { type: 'none' }, orderId: 'order-1', orderStatus: 'paid' });
    expect(h.readPayment).toHaveBeenCalledTimes(2);
    expect(h.database.recordException).not.toHaveBeenCalled();
    expect(h.mailer.sendShopAlert).not.toHaveBeenCalled();
    expect([...emailsOf(h, 'paid'), ...emailsOf(h, 'awaiting_payment')]).toEqual([]);
  });

  it(`起きないマスが${MAX_RECONCILE_ATTEMPTS}回読んでも続くときだけ、要対応（注文と支払いの矛盾）として1回記録して知らせる`, async () => {
    const h = harness({ stripe: snapshot({ kind: 'awaiting_payment' }), order: order('paid', { paymentIntentId: 'pi_1' }) });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toEqual({
      kind: 'needs_action',
      exceptionId: 'exception-1',
      reason: 'state_conflict',
      orderId: 'order-1',
      orderStatus: 'paid',
    });
    expect(h.readPayment).toHaveBeenCalledTimes(MAX_RECONCILE_ATTEMPTS);
    expect(h.database.recordException).toHaveBeenCalledTimes(1);
    expect(h.database.recordException).toHaveBeenCalledWith(expect.objectContaining({ reason: 'state_conflict', orderId: 'order-1' }));
    expect(h.mailer.sendShopAlert).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it(`${MAX_RECONCILE_ATTEMPTS}回で収まらなければ not_converged を投げる`, async () => {
    const h = harness({ stripe: snapshot(PAID), order: order('payment_in_progress') });
    jest.spyOn(h.database, 'markOrderPaid').mockResolvedValue({ updated: false, amountMatches: false, needsReview: false });

    await expect(reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' })).rejects.toMatchObject({
      code: 'not_converged',
    });
    expect(h.readPayment).toHaveBeenCalledTimes(MAX_RECONCILE_ATTEMPTS);
  });

  it('Webhook と見回りが同時に照合しても、入金済みにするのは1回、メールは1通', async () => {
    const h = harness({ stripe: snapshot(PAID), order: order('payment_in_progress') });

    const results = await Promise.all([
      reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1', sourceEventId: 'evt_1' }),
      reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' }),
    ]);

    expect(results.map((result) => result.kind)).toEqual(['ok', 'ok']);
    expect(emailsOf(h, 'paid')).toHaveLength(1);
    expect(h.world.order?.status).toBe('paid');
  });

  it('Session ID も PaymentIntent ID も無ければ呼び出しの誤りとして投げる', async () => {
    const h = harness({ stripe: snapshot(PAID) });

    await expect(reconcileCheckoutPayment(h.deps, {})).rejects.toThrow('checkoutSessionId or paymentIntentId is required');
  });
});
