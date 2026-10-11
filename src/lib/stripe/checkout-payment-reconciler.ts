import type { ShopAlertAutomation, ShopPaymentAlert } from '@/lib/orders/order-lifecycle-emails';
import type {
  CancelReason,
  OrderStatus,
  PaidEmailVariant,
  PaymentExceptionReason,
  PlaceOrderRejection,
} from '@/lib/orders/order-payment-types';
import { startAutomaticRefund, type RefundServiceDeps } from '@/lib/orders/refund/refund-service';
import {
  recordCancelledOrderPaidAmount,
  resolvePaymentExceptionBySystem,
  type ShopSettingsRow,
} from '@/lib/orders/refund/refund-store';
import {
  decideOrderAction,
  isFullyRefunded,
  type OrderAction,
  type StripePaymentState,
} from '@/lib/stripe/checkout-payment-decision';
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
    /** お客様に注文確認を送るか（全額返金済みの支払いは送らない）。DB が金額の一致と合わせて、行を書くか決める */
    notifyCustomer: boolean;
    /** 入金済みの書き分け（グループ A 設計書 5-4） */
    paidEmailVariant: PaidEmailVariant;
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

/** 照合が送るメール。お客様への注文のメールは、状態を変える DB の関数が同じ取引で行を書き、worker が送る（グループ D） */
export interface ReconcilerMailer {
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
  /**
   * 注文を Stripe の返金済みの分に合わせる（返金の同期。order-refund-sync.ts）。何度呼んでも同じ結果に収まる。
   * 同期したあとの注文の状態を返す（全額返金なら取消）。
   * 一時的な失敗は ReconcileTransientError にして投げる（呼び出し元が再試行する）。それ以外はそのまま投げる。
   */
  syncRefunds(paymentIntentId: string): Promise<OrderStatus>;
  /** ショップの設定（自動の返金①②のオン・オフ。ショップの設定の画面で変える）。自動の返金を決める時だけ読む */
  readShopSettings(): Promise<ShopSettingsRow>;
  /** 自動の返金①②が使う返金の部品（Stripe への頼み方と記録）。要対応をシステムが閉じる時も、この store で書く */
  refund: RefundServiceDeps;
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
      // 返金の同期をしたときは、同期のあとの注文の状態を結果にする（全額返金なら取消。読んだときの状態は古い）
      const syncedStatus = action.type === 'none' ? await syncRefundsOfPaidOrder(deps, snapshot, order) : null;

      const finalAction = applied ?? action;
      step = {
        kind: 'done',
        result:
          reviewOrderId && order && order.id === reviewOrderId
            ? { kind: 'needs_review', action: finalAction, orderId: order.id, orderStatus: syncedStatus ?? order.status }
            : {
                kind: 'ok',
                action: finalAction,
                orderId: order?.id ?? null,
                orderStatus: syncedStatus ?? order?.status ?? null,
              },
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

/**
 * 入金済み・発送済みの注文に Stripe の返金済みの分があれば、返金の同期を呼んで注文を Stripe に合わせる。
 * 入金済みにした直後（読み直しで「何もしない」になる）も、すでに入金済みだった注文も、照合のたびにここを通るので、
 * 注文が無い間に届いて飛ばされた返金の通知や、注文の作成・紐付けより前の返金も、この照合で注文に反映される。
 * 返金の同期は何度呼んでも同じ結果に収まるので、失敗して再試行されても収束する。
 * 返金済みの分が無い支払いと、全額返金で取り消された注文（取消。判定は「何もしない」）には呼ばない。
 * 呼んだときは、同期のあとの注文の状態を返す。呼ばなかったときは null。
 */
async function syncRefundsOfPaidOrder(
  deps: ReconcilerDeps,
  snapshot: CheckoutPaymentSnapshot,
  order: ReconcilerOrder | null,
): Promise<OrderStatus | null> {
  const { state, paymentIntentId } = snapshot;
  if (!order || (order.status !== 'paid' && order.status !== 'shipped')) {
    return null;
  }
  if (state.kind !== 'paid' || state.amountRefunded <= 0 || !paymentIntentId) {
    return null;
  }

  return deps.syncRefunds(paymentIntentId);
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

  // 全額返金済みの支払いは、このあと返金の同期が注文を取り消すので、注文確認の行を書かない（DB は金額の一致も見る）
  const marked = await deps.database.markOrderPaid({
    orderId: order.id,
    expectedStatus,
    paymentIntentId,
    paidAmount: state.amountReceived,
    paidCurrency: state.currency,
    notifyCustomer: !isFullyRefunded(state),
    paidEmailVariant: emailVariant,
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
 * 初めて記録した要対応には、設定がオンなら自動の返金を先に行い、その結果を店への知らせに載せる（グループ E-2 設計書 6-4）。
 * 同じ支払いの照合が同時に走っても、結果を載せた知らせが1通だけ届くよう、送信権は自動の返金の前に押さえる。
 * 取り消した注文への入金は、受け取った額を、要対応を記録するたびに（新しくても前からでも）先に注文へ書く（本計画 P27）。
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

  // 取り消した注文への入金の受け取った額は、要対応を記録するたびに書く（本計画 P27）。新しい要対応も前からの要対応も、
  // 自動の返金①のオン・オフにも依らない。店への知らせの送信権と自動の返金より先に済ませる
  await recordPaidAmountOfCancelledOrder(deps, snapshot, order, reason);

  if (!recorded.isResolved) {
    const alert: ShopPaymentAlert = {
      reason,
      detail,
      orderId: order?.id ?? null,
      paymentRef,
      detectedAt: deps.now(),
    };
    if (recorded.isNew && (reason === 'cancelled_order_paid' || reason === 'paid_amount_mismatch')) {
      // 自動の返金は、要対応を初めて記録した時だけ（本計画 P7）。照合を回し直した時や、失敗した後の照合では動かし直さない
      await notifyShopAfterAutomaticRefund(deps, snapshot, order, reason, recorded.exceptionId, alert);
    } else {
      await notifyShopOfException(deps, recorded.exceptionId, alert);
    }

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

/**
 * 取り消した注文への入金の受け取った額を、注文に書く（本計画 P27）。要対応を記録するたびに呼ぶ（新しくても前からでも、
 * 解決済みでも、自動の返金①のオン・オフに依らない）。DB の関数は、取り消した注文で受け取った額が空の時だけ書くので、何度呼んでも同じ。
 * ①がオフの時や、①が始める前に断られた時（注文に支払いの番号が無い）も、店が管理画面の返金の画面から全額を返せるようにするため。
 * 書けなくても、店への知らせと自動の返金は止めない（①は自分でも書き、次の照合が書き直す）。ログには名前と記号だけを出す
 */
async function recordPaidAmountOfCancelledOrder(
  deps: ReconcilerDeps,
  snapshot: CheckoutPaymentSnapshot,
  order: ReconcilerOrder | null,
  reason: PaymentExceptionReason,
): Promise<void> {
  const { state, paymentIntentId } = snapshot;
  if (reason !== 'cancelled_order_paid' || !order || state.kind !== 'paid' || !paymentIntentId) {
    return;
  }

  try {
    await recordCancelledOrderPaidAmount(deps.refund.store, {
      orderId: order.id,
      paymentIntentId,
      receivedAmount: state.amountReceived,
    });
  } catch (error) {
    console.error('[reconcile] failed to record the paid amount of a cancelled order', errorNameAndCode(error));
  }
}

/**
 * 自動の返金①②を試してから、その結果を載せて店へ知らせる。送信権は返金の前に押さえる: 同じ支払いの照合が同時に走ると
 * （コンビニ払いの入金は知らせが2つほぼ同時に届く）、初めてでない方が結果の無い知らせを先に送り、結果の付いた知らせが
 * 送れなくなるため。自動の返金の部品が誤りを投げたら、送信権を戻してから投げる（再試行の照合が、結果の無い知らせを送る。T7-4）。
 * 送信権を先に取られていた時は、返金だけ行って送らない
 */
async function notifyShopAfterAutomaticRefund(
  deps: ReconcilerDeps,
  snapshot: CheckoutPaymentSnapshot,
  order: ReconcilerOrder | null,
  reason: PaymentExceptionReason,
  exceptionId: string,
  alert: ShopPaymentAlert,
): Promise<void> {
  const claimed = await deps.database.claimExceptionNotification(exceptionId, 'shop');
  let automation: ShopAlertAutomation | null;
  try {
    automation = await runAutomaticRefund(deps, snapshot, order, reason, exceptionId);
  } catch (error) {
    if (claimed) {
      await deps.database.releaseExceptionNotification(exceptionId, 'shop');
    }
    throw error;
  }
  if (!claimed) {
    return;
  }
  if (!(await deps.mailer.sendShopAlert({ ...alert, ...(automation ? { automation } : {}) }))) {
    await deps.database.releaseExceptionNotification(exceptionId, 'shop');
  }
}

/**
 * 自動の返金①②（グループ E-2 設計書 6-4）。要対応を初めて記録した時だけ呼ぶ（本計画 P7）。
 * 返した値は店への知らせに付ける。自動の返金をしない（設定がオフ・条件に合わない）時は null。
 *
 * - ① 取り消した注文への入金: 設定①がオンなら、Stripe が受け取った額で全額を返金する
 * - ② 支払額の違い: 設定②がオンで、入金済みの注文なら、全額を返金して注文を取り消す。発送を始めた注文は
 *   DB が断る（ORDER_NOT_CANCELLABLE）ので、取り消せなかった扱いになる
 *
 * Stripe が受け付けたら要対応を閉じる（システムが解決）。断られた・結果が分からない時は、開いたままにして店に任せる。
 */
async function runAutomaticRefund(
  deps: ReconcilerDeps,
  snapshot: CheckoutPaymentSnapshot,
  order: ReconcilerOrder | null,
  reason: PaymentExceptionReason,
  exceptionId: string,
): Promise<ShopAlertAutomation | null> {
  const { state } = snapshot;
  // Stripe が受け取った入金が無い支払い（0円で完了した、など）には、返す物が無い
  if (!order || state.kind !== 'paid') {
    return null;
  }

  if (reason === 'cancelled_order_paid') {
    if (!(await deps.readShopSettings()).autoRefundCancelledOrderPayment.enabled) {
      return null;
    }
    const accepted = await refundAutomatically(deps, exceptionId, 'システムが自動で返金した', {
      orderId: order.id,
      source: 'auto_cancelled_order_payment',
      receivedAmount: state.amountReceived,
    });
    return accepted ? 'auto_refunded' : 'auto_refund_failed';
  }

  if (reason === 'paid_amount_mismatch' && order.status === 'paid') {
    if (!(await deps.readShopSettings()).autoCancelAmountMismatch.enabled) {
      return null;
    }
    const accepted = await refundAutomatically(deps, exceptionId, 'システムが自動で解決した', {
      orderId: order.id,
      source: 'auto_amount_mismatch',
      receivedAmount: null,
    });
    return accepted ? 'auto_cancelled' : 'auto_cancel_failed';
  }

  return null;
}

/** 自動の返金を始め、Stripe が受け付けたら要対応を閉じる。受け付けたか（断られた・結果が分からない時は false）を返す */
async function refundAutomatically(
  deps: ReconcilerDeps,
  exceptionId: string,
  resolutionNote: string,
  request: Parameters<typeof startAutomaticRefund>[1],
): Promise<boolean> {
  const result = await startAutomaticRefund(deps.refund, request);
  if (result.kind !== 'accepted') {
    return false;
  }

  try {
    await resolvePaymentExceptionBySystem(deps.refund.store, exceptionId, resolutionNote);
  } catch (error) {
    // 返金は Stripe が受け付けた。閉じられなくても「返金した」と知らせる（要対応は開いたまま残り、店が画面で閉じる）
    console.error('[reconcile] the exception was not resolved after the automatic refund', errorNameAndCode(error));
  }
  return true;
}

/** ログに出す誤りの名前と記号だけ（DB の文には宛先などが混ざりうる） */
function errorNameAndCode(error: unknown): { name: string; code: string | null } {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    code: typeof code === 'string' ? code : null,
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
