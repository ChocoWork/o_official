import type { ShopPaymentAlert } from '@/lib/orders/order-lifecycle-emails';
import type {
  CancelReason,
  OrderStatus,
  PaidEmailVariant,
  PaymentExceptionReason,
  PlaceOrderRejection,
} from '@/lib/orders/order-payment-types';
import { decideOrderAction, type OrderAction, type StripePaymentState } from '@/lib/stripe/checkout-payment-decision';
import { ReconcileTransientError, type CheckoutPaymentSnapshot } from '@/lib/stripe/checkout-payment-reader';

export { ReconcileTransientError };

/** 管理画面の取消と、要対応の「注文を取り消して解決」（R-18） */
export type AdminCancelRequest = {
  actorId: string;
  reason: CancelReason;
  /** 「その他」では必須（呼び出し側の API が確かめる。DB も拒否する） */
  note?: string;
  /** 取消の画面の「お客様に取消のお知らせを送る」（既定 true） */
  notifyCustomer: boolean;
};

export type ReconcileInput = {
  /** 優先して使う */
  checkoutSessionId?: string | null;
  /** Session ID を持たない古い注文と payment_intent 系のイベント */
  paymentIntentId?: string | null;
  /** Stripe のイベント ID（R-43） */
  sourceEventId?: string | null;
  adminCancel?: AdminCancelRequest;
};

export type ReconcileResult =
  | { kind: 'ok'; action: OrderAction; orderId: string | null; orderStatus: OrderStatus | null }
  | { kind: 'needs_review'; action: OrderAction; orderId: string; orderStatus: OrderStatus }
  | {
      kind: 'needs_action';
      exceptionId: string;
      reason: PaymentExceptionReason;
      orderId: string | null;
      orderStatus: OrderStatus | null;
    };

export type ReconcilerOrder = {
  id: string;
  status: OrderStatus;
  paymentIntentId: string | null;
  checkoutSessionId: string | null;
  /** orders.total_amount / orders.currency。入金済みの導き直しで Stripe の受取額と突き合わせる（fix round 1） */
  totalAmount: number;
  currency: string;
};

export type DraftContact = { email: string | null; fullName: string | null; missingShippingFields: string[] };

export type PlaceOrderResult =
  | { placed: true; orderId: string; orderStatus: OrderStatus; created: boolean }
  | { placed: false; rejection: PlaceOrderRejection };

/** 照合が使う DB の操作。実体は Supabase の RPC（checkout-payment-reconciler-deps.ts） */
export interface ReconcilerDatabase {
  findOrder(ref: { checkoutSessionId: string | null; paymentIntentId: string | null }): Promise<ReconcilerOrder | null>;
  placeOrder(args: {
    draftId: string;
    checkoutSessionId: string;
    cartSessionId: string;
    amountTotal: number;
    amountDiscount: number;
    currency: string;
    sessionCreatedAt: Date;
    paymentIntentId: string | null;
  }): Promise<PlaceOrderResult>;
  markOrderPaid(args: {
    orderId: string;
    expectedStatus: 'payment_in_progress' | 'pending' | 'failed';
    paymentIntentId: string;
    paidAmount: number;
    paidCurrency: string;
    sourceEventId: string | null;
  }): Promise<{ updated: boolean; amountMatches: boolean; needsReview: boolean }>;
  markOrderAwaitingPayment(args: {
    orderId: string;
    paymentIntentId: string;
    sourceEventId: string | null;
  }): Promise<{ updated: boolean }>;
  releaseStock(args: {
    orderId: string;
    expectedStatus: 'payment_in_progress' | 'pending';
    nextStatus: 'failed' | 'abandoned' | 'cancelled';
    changeReason: string;
    actorId: string | null;
    sourceEventId: string | null;
    cancelReason: CancelReason | null;
    cancelNote: string | null;
    notifyCustomer: boolean | null;
  }): Promise<{ released: boolean }>;
  recordException(args: {
    paymentRef: string;
    reason: PaymentExceptionReason;
    detail: string | null;
    checkoutSessionId: string | null;
    paymentIntentId: string | null;
    draftId: string | null;
    orderId: string | null;
  }): Promise<{ exceptionId: string; isNew: boolean; isResolved: boolean }>;
  claimExceptionNotification(exceptionId: string, channel: 'shop' | 'customer'): Promise<boolean>;
  releaseExceptionNotification(exceptionId: string, channel: 'shop' | 'customer'): Promise<void>;
  findDraftContact(draftId: string): Promise<DraftContact | null>;
  /** 失敗しても照合は止めない（実装側で記録する） */
  persistDraftPaymentMethod(draftId: string, paymentMethod: string): Promise<void>;
}

export interface ReconcilerMailer {
  sendOrderConfirmation(
    orderId: string,
    paymentState: 'paid' | 'awaiting_payment',
    paidVariant?: PaidEmailVariant,
  ): Promise<boolean>;
  sendPaymentExpired(orderId: string): Promise<boolean>;
  sendOrderCanceled(orderId: string, previousStatus: 'payment_in_progress' | 'pending'): Promise<boolean>;
  sendUnplacedPaymentNotice(args: { to: string; fullName: string | null; state: 'paid' | 'awaiting_payment' }): Promise<boolean>;
  sendShopAlert(alert: ShopPaymentAlert): Promise<boolean>;
}

export type ReconcilerAudit = (event: {
  outcome: 'success' | 'failure' | 'error' | 'conflict';
  detail: string;
  metadata: Record<string, unknown>;
}) => Promise<void>;

export type ReconcilerDeps = {
  readPayment(ref: { checkoutSessionId: string | null; paymentIntentId: string | null }): Promise<CheckoutPaymentSnapshot>;
  database: ReconcilerDatabase;
  mailer: ReconcilerMailer;
  audit: ReconcilerAudit;
  now(): Date;
};

export const MAX_RECONCILE_ATTEMPTS = 3;

const CHANGE_REASONS = {
  failed: 'stripe_voucher_expired',
  abandoned: 'stripe_checkout_expired',
  cancelled: 'admin_cancel',
} as const;

const NO_DRAFT: StripePaymentState = { kind: 'not_applicable', reason: 'no_draft' };

type WriteAction = Exclude<OrderAction, { type: 'none' } | { type: 'record_only' } | { type: 'exception' }>;

type Step =
  | { kind: 'applied'; orderId: string; needsReview: boolean }
  /** 条件付き更新が0件だった。先に別の経路が動かしたので、読み直す */
  | { kind: 'lost_race' }
  | { kind: 'done'; result: ReconcileResult };

type CustomerNotice = { contact: DraftContact | null; state: 'paid' | 'awaiting_payment' };

/**
 * 注文と在庫を Stripe の現在の支払い状態に合わせる（設計書 第2章）。
 *
 * 読む → 判定 → 条件付き更新 → 読み直す を最大3回くり返す。支払い単位のロックは使わない。
 * 書き込みはすべて今の状態を条件にした RPC なので、同じ支払いについて何度・同時に呼ばれても結果は同じ
 * （Stripe の注文処理の手引きが求める性質）。Stripe へは書かない。Session の失効は呼び出し側が先に行う。
 * 判定表の起きないマス（state_conflict）は、読んでいる間に別の経路が注文を動かしただけのことがあるので、
 * すぐには記録せずに読み直す。最後の回まで続いたときだけ要対応にする（設計書 2-3）。
 */
export async function reconcileCheckoutPayment(deps: ReconcilerDeps, input: ReconcileInput): Promise<ReconcileResult> {
  if (!input.checkoutSessionId && !input.paymentIntentId) {
    throw new Error('checkoutSessionId or paymentIntentId is required');
  }

  let applied: OrderAction | null = null;
  let reviewOrderId: string | null = null;

  for (let attempt = 1; attempt <= MAX_RECONCILE_ATTEMPTS; attempt += 1) {
    const snapshot = await deps.readPayment({
      checkoutSessionId: input.checkoutSessionId ?? null,
      paymentIntentId: input.paymentIntentId ?? null,
    });
    const order = await deps.database.findOrder({
      checkoutSessionId: snapshot.checkoutSessionId ?? input.checkoutSessionId ?? null,
      paymentIntentId: snapshot.paymentIntentId ?? input.paymentIntentId ?? null,
    });
    const action = decide(snapshot, order, input);

    let step: Step;
    if (action.type === 'none' || action.type === 'record_only') {
      const finalAction = applied ?? action;
      step = {
        kind: 'done',
        result:
          reviewOrderId && order && order.id === reviewOrderId
            ? { kind: 'needs_review', action: finalAction, orderId: order.id, orderStatus: order.status }
            : { kind: 'ok', action: finalAction, orderId: order?.id ?? null, orderStatus: order?.status ?? null },
      };
    } else if (action.type === 'exception') {
      if (action.reason === 'state_conflict' && attempt < MAX_RECONCILE_ATTEMPTS) {
        // Stripe を読んでから注文を読むまでに別の経路が注文を動かすと、古い Stripe の状態と新しい注文が
        // 組み合わさって起きないマスに当たる（例: 手続き中 × 入金済み）。記録も通知もせずに両方を読み直す
        continue;
      }
      step = {
        kind: 'done',
        result: await raiseException(deps, input, snapshot, order, action.reason, action.detail ?? null, null),
      };
    } else {
      step = await apply(deps, input, snapshot, order, action);
    }

    if (step.kind === 'done') {
      await auditResult(deps, input, snapshot, step.result);
      return step.result;
    }

    if (step.kind === 'applied') {
      applied = action;
      if (step.needsReview) {
        reviewOrderId = step.orderId;
      }
    }
  }

  throw new ReconcileTransientError('not_converged');
}

function decide(snapshot: CheckoutPaymentSnapshot, order: ReconcilerOrder | null, input: ReconcileInput): OrderAction {
  // 同じ Session の PaymentIntent は1つだけ。違えば注文と支払いの矛盾（仕組みで起きない）
  if (order?.paymentIntentId && snapshot.paymentIntentId && order.paymentIntentId !== snapshot.paymentIntentId) {
    return { type: 'exception', reason: 'state_conflict', detail: 'payment_intent_mismatch' };
  }

  // mark_order_paid が返す金額の不一致は戻り値にしか残らない。直後の recordException が失敗すると、
  // 次の読み直しは入金済み×入金済みを none と見なして要対応を失う（発送を止める約束が壊れる。fix round 1）。
  // 読むたびに注文の金額・通貨と Stripe の受取額を突き合わせ、違えば毎回そのまま導き直す（state_conflict とは別で、
  // 読み直しは待たずに記録する）。
  if (
    order &&
    (order.status === 'paid' || order.status === 'shipped') &&
    snapshot.state.kind === 'paid' &&
    (order.totalAmount !== snapshot.state.amountReceived ||
      order.currency.toLowerCase() !== snapshot.state.currency.toLowerCase())
  ) {
    return { type: 'exception', reason: 'paid_amount_mismatch' };
  }

  return decideOrderAction({
    stripe: stripeStateFor(snapshot, order),
    orderStatus: order?.status ?? null,
    adminCancel: Boolean(input.adminCancel),
  });
}

/**
 * 下書き ID の無い支払い（当店の Checkout 以外）を対象外（記録のみ）にするのは、注文が無いときだけ（設計書 3-1・3-2）。
 * 注文があれば Stripe の状態の行に従う。移行前の注文は Session に下書き ID が無くても、失敗などに変わる（7-1）。
 * Stripe に無いときは下書き ID を読めていないだけなので、「Stripe に無い」の行のままにする。
 */
function stripeStateFor(snapshot: CheckoutPaymentSnapshot, order: ReconcilerOrder | null): StripePaymentState {
  if (order === null && snapshot.draftId === null && snapshot.state.kind !== 'missing') {
    return NO_DRAFT;
  }
  return snapshot.state;
}

function requireOrder(order: ReconcilerOrder | null): ReconcilerOrder {
  if (!order) {
    throw new Error('The decided action requires an existing order');
  }
  return order;
}

async function apply(
  deps: ReconcilerDeps,
  input: ReconcileInput,
  snapshot: CheckoutPaymentSnapshot,
  order: ReconcilerOrder | null,
  action: WriteAction,
): Promise<Step> {
  switch (action.type) {
    case 'place_and_mark_paid':
      return placeAndMark(deps, input, snapshot, 'paid');
    case 'place_and_mark_awaiting':
      return placeAndMark(deps, input, snapshot, 'awaiting_payment');
    case 'mark_paid':
      return markPaid(deps, input, snapshot, requireOrder(order), action.expectedStatus, action.emailVariant);
    case 'mark_awaiting':
      return markAwaiting(deps, input, snapshot, requireOrder(order));
    case 'release':
      return release(deps, input, requireOrder(order), action.expectedStatus, action.nextStatus);
  }
}

/** 受付を通らない支払いの予備処理。受付 RPC で注文を作り、その場で入金済み・入金待ちにする */
async function placeAndMark(
  deps: ReconcilerDeps,
  input: ReconcileInput,
  snapshot: CheckoutPaymentSnapshot,
  state: 'paid' | 'awaiting_payment',
): Promise<Step> {
  const { draftId, cartSessionId, checkoutSessionId, amountTotal, currency, sessionCreatedAt, paymentIntentId } = snapshot;
  if (!draftId || !cartSessionId || !checkoutSessionId || amountTotal === null || !currency || !sessionCreatedAt) {
    return {
      kind: 'done',
      result: await raiseException(deps, input, snapshot, null, 'unexpected_state', 'snapshot_incomplete', null),
    };
  }

  const contact = await deps.database.findDraftContact(draftId);
  if (contact && contact.missingShippingFields.length > 0) {
    // 配送先の欠落（FREQ-365）。支払いは成立しているので注文は作り、出荷前に気づけるよう記録する
    await deps.audit({
      outcome: 'error',
      detail: 'Checkout draft shipping snapshot is incomplete',
      metadata: {
        draft_id: draftId,
        checkout_session_id: checkoutSessionId,
        missing_shipping_fields: contact.missingShippingFields,
      },
    });
  }

  const placed = await deps.database.placeOrder({
    draftId,
    checkoutSessionId,
    cartSessionId,
    amountTotal,
    amountDiscount: snapshot.amountDiscount,
    currency,
    sessionCreatedAt,
    paymentIntentId,
  });

  if (!placed.placed) {
    return {
      kind: 'done',
      result: await raiseException(deps, input, snapshot, null, 'order_not_creatable', placed.rejection, { contact, state }),
    };
  }

  if (placed.orderStatus !== 'payment_in_progress') {
    return { kind: 'lost_race' };
  }

  const order: ReconcilerOrder = {
    id: placed.orderId,
    status: 'payment_in_progress',
    paymentIntentId,
    checkoutSessionId,
    totalAmount: amountTotal,
    currency,
  };
  return state === 'paid'
    ? markPaid(deps, input, snapshot, order, 'payment_in_progress', 'order_confirmed')
    : markAwaiting(deps, input, snapshot, order);
}

async function markPaid(
  deps: ReconcilerDeps,
  input: ReconcileInput,
  snapshot: CheckoutPaymentSnapshot,
  order: ReconcilerOrder,
  expectedStatus: 'payment_in_progress' | 'pending' | 'failed',
  emailVariant: PaidEmailVariant,
): Promise<Step> {
  const { state, paymentIntentId } = snapshot;
  if (state.kind !== 'paid' || !paymentIntentId) {
    throw new Error('mark_paid requires a paid Stripe state with a PaymentIntent');
  }

  const marked = await deps.database.markOrderPaid({
    orderId: order.id,
    expectedStatus,
    paymentIntentId,
    paidAmount: state.amountReceived,
    paidCurrency: state.currency,
    sourceEventId: input.sourceEventId ?? null,
  });
  if (!marked.updated) {
    return { kind: 'lost_race' };
  }

  if (!marked.amountMatches) {
    // 入金済みにして要対応。注文確定メールは送らない（店が確かめてから連絡する）。発送は DB が止める
    await persistPaymentMethod(deps, snapshot);
    return {
      kind: 'done',
      result: await raiseException(deps, input, snapshot, { ...order, status: 'paid' }, 'paid_amount_mismatch', null, null),
    };
  }

  await deps.mailer.sendOrderConfirmation(order.id, 'paid', emailVariant);
  await persistPaymentMethod(deps, snapshot);
  return { kind: 'applied', orderId: order.id, needsReview: marked.needsReview };
}

async function markAwaiting(
  deps: ReconcilerDeps,
  input: ReconcileInput,
  snapshot: CheckoutPaymentSnapshot,
  order: ReconcilerOrder,
): Promise<Step> {
  if (!snapshot.paymentIntentId) {
    throw new Error('mark_awaiting requires a PaymentIntent');
  }

  const marked = await deps.database.markOrderAwaitingPayment({
    orderId: order.id,
    paymentIntentId: snapshot.paymentIntentId,
    sourceEventId: input.sourceEventId ?? null,
  });
  if (!marked.updated) {
    return { kind: 'lost_race' };
  }

  await deps.mailer.sendOrderConfirmation(order.id, 'awaiting_payment');
  await persistPaymentMethod(deps, snapshot);
  return { kind: 'applied', orderId: order.id, needsReview: false };
}

async function release(
  deps: ReconcilerDeps,
  input: ReconcileInput,
  order: ReconcilerOrder,
  expectedStatus: 'payment_in_progress' | 'pending',
  nextStatus: 'failed' | 'abandoned' | 'cancelled',
): Promise<Step> {
  const cancel = nextStatus === 'cancelled' ? input.adminCancel ?? null : null;
  if (nextStatus === 'cancelled' && !cancel) {
    throw new Error('adminCancel is required to cancel an order');
  }

  const result = await deps.database.releaseStock({
    orderId: order.id,
    expectedStatus,
    nextStatus,
    changeReason: CHANGE_REASONS[nextStatus],
    actorId: cancel?.actorId ?? null,
    sourceEventId: input.sourceEventId ?? null,
    cancelReason: cancel?.reason ?? null,
    cancelNote: cancel?.note?.trim() || null,
    notifyCustomer: cancel ? cancel.notifyCustomer : null,
  });
  if (!result.released) {
    return { kind: 'lost_race' };
  }

  if (nextStatus === 'failed') {
    await deps.mailer.sendPaymentExpired(order.id);
  }
  if (cancel?.notifyCustomer) {
    await deps.mailer.sendOrderCanceled(order.id, expectedStatus);
  }
  return { kind: 'applied', orderId: order.id, needsReview: false };
}

async function persistPaymentMethod(deps: ReconcilerDeps, snapshot: CheckoutPaymentSnapshot): Promise<void> {
  if (snapshot.draftId && snapshot.paymentMethod) {
    await deps.database.persistDraftPaymentMethod(snapshot.draftId, snapshot.paymentMethod);
  }
}

/**
 * 要対応を記録し（同じ支払い・同じ理由は1行）、店へ1回知らせる。
 * 受付を通らない支払いでは、お客様にも1回案内する（設計書 5-4）。解決済みなら知らせ直さない。
 */
async function raiseException(
  deps: ReconcilerDeps,
  input: ReconcileInput,
  snapshot: CheckoutPaymentSnapshot,
  order: ReconcilerOrder | null,
  reason: PaymentExceptionReason,
  detail: string | null,
  customerNotice: CustomerNotice | null,
): Promise<ReconcileResult> {
  const paymentRef =
    snapshot.checkoutSessionId ?? snapshot.paymentIntentId ?? input.checkoutSessionId ?? input.paymentIntentId ?? null;
  if (!paymentRef) {
    throw new Error('A payment reference is required to record an exception');
  }

  const recorded = await deps.database.recordException({
    paymentRef,
    reason,
    detail,
    checkoutSessionId: snapshot.checkoutSessionId,
    paymentIntentId: snapshot.paymentIntentId,
    draftId: snapshot.draftId,
    orderId: order?.id ?? null,
  });

  if (!recorded.isResolved) {
    await notifyShopOfException(deps, recorded.exceptionId, {
      reason,
      detail,
      orderId: order?.id ?? null,
      paymentRef,
      detectedAt: deps.now(),
    });

    const email = customerNotice?.contact?.email;
    if (customerNotice && email) {
      await notifyCustomer(deps, recorded.exceptionId, {
        to: email,
        fullName: customerNotice.contact?.fullName ?? null,
        state: customerNotice.state,
      });
    }
  }

  return {
    kind: 'needs_action',
    exceptionId: recorded.exceptionId,
    reason,
    orderId: order?.id ?? null,
    orderStatus: order?.status ?? null,
  };
}

/** 店への要対応メール。送る前に送信権を押さえ、送れなければ戻す（二重にも0通にもしない） */
export async function notifyShopOfException(
  deps: Pick<ReconcilerDeps, 'database' | 'mailer'>,
  exceptionId: string,
  alert: ShopPaymentAlert,
): Promise<boolean> {
  if (!(await deps.database.claimExceptionNotification(exceptionId, 'shop'))) {
    return false;
  }

  const sent = await deps.mailer.sendShopAlert(alert);
  if (!sent) {
    await deps.database.releaseExceptionNotification(exceptionId, 'shop');
  }
  return sent;
}

async function notifyCustomer(
  deps: ReconcilerDeps,
  exceptionId: string,
  notice: { to: string; fullName: string | null; state: 'paid' | 'awaiting_payment' },
): Promise<void> {
  if (!(await deps.database.claimExceptionNotification(exceptionId, 'customer'))) {
    return;
  }

  if (!(await deps.mailer.sendUnplacedPaymentNotice(notice))) {
    await deps.database.releaseExceptionNotification(exceptionId, 'customer');
  }
}

/** すべての判定と行動を監査ログに残す（設計書 5-6）。個人情報は入れない */
async function auditResult(
  deps: ReconcilerDeps,
  input: ReconcileInput,
  snapshot: CheckoutPaymentSnapshot,
  result: ReconcileResult,
): Promise<void> {
  const detail =
    result.kind === 'needs_action'
      ? `needs_action:${result.reason}`
      : result.action.type === 'record_only'
        ? `${result.kind}:record_only:${result.action.note}`
        : `${result.kind}:${result.action.type}`;

  await deps.audit({
    outcome: result.kind === 'ok' ? 'success' : result.kind === 'needs_review' ? 'conflict' : 'error',
    detail,
    metadata: {
      checkout_session_id: snapshot.checkoutSessionId ?? input.checkoutSessionId ?? null,
      payment_intent_id: snapshot.paymentIntentId ?? input.paymentIntentId ?? null,
      order_id: result.orderId,
      source_event_id: input.sourceEventId ?? null,
      stripe_state: snapshot.state.kind,
      admin_cancel: Boolean(input.adminCancel),
      actor_id: input.adminCancel?.actorId ?? null,
      exception_reason: result.kind === 'needs_action' ? result.reason : null,
    },
  });
}
