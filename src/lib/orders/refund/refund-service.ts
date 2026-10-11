import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';
import type { ShopPaymentAlert } from '@/lib/orders/order-lifecycle-emails';
import { refundFailureReasonLabel } from '@/lib/orders/refund/refund-messages';
import {
  RefundOperationError,
  RefundStoreError,
  beginOrderRefund,
  getOrderRefund,
  listOrderRefunds,
  markOrderRefundError,
  recordOrderRefundResult,
  type BeganRefund,
  type BeginRefundInput,
  type OrderRefundLineRow,
  type OrderRefundRef,
  type RefundResultRow,
  type RefundStore,
} from '@/lib/orders/refund/refund-store';
import {
  createStripeRefund,
  listPaymentIntentRefunds,
  readPaymentMethodType,
  type StripeRefundSnapshot,
} from '@/lib/orders/refund/refund-stripe';
import type {
  CreateRefundRequest,
  PaidCancelRequest,
  RefundErrorCode,
  StripeRefundReason,
} from '@/lib/orders/refund/refund-types';
import { getStripeServerClient } from '@/lib/stripe/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

/**
 * 返金の流れ（グループ E-2 設計書 3-2・5・6）。どの道（管理画面の返金・支払い済みのキャンセル・自動の返金）も、
 * 記録を「返事待ち」で作る（DB）→ Stripe に頼む（重複防止キー order-refund-{記録の番号}）→ 結果を書く（DB）の順に進む。
 * Stripe の返事が分からない時は、記録を返事待ちのまま残す。同じ記録の確かめ直し（同じ二重防止の番号の送り直し・
 * confirmAwaitingRefund）と、毎時の見回りが片付ける。
 */
export type RefundServiceDeps = {
  store: RefundStore & Pick<SupabaseClient, 'from'>;
  stripe: Stripe;
  now(): Date;
  /** 店への要対応の知らせ（notifyShopOfException の形）。返金の失敗の要対応で使う */
  notifyShopOfRefundFailure(exceptionId: string, alert: ShopPaymentAlert): Promise<boolean>;
  scheduleOrderEmailDelivery(): void;
};

export type RefundSubmitResult =
  | { kind: 'accepted'; refundId: string; status: 'pending' | 'succeeded'; amount: number; replayed: boolean }
  | { kind: 'refused'; code: RefundErrorCode }
  | { kind: 'stripe_rejected'; refundId: string; reasonLabel: string | null }
  | { kind: 'unknown'; refundId: string };

// Stripe は、24時間以上たった重複防止キーを消してよいとしている。消えた後に同じキーで頼むと、返金がもう1件できるおそれがある。
// 記録の時刻（DB の時計）とこちらの時計・Stripe の時計のずれも見込み、23時間を超えた記録は頼み直さない
const IDEMPOTENT_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
// 支払額の違いの自動の取消（②）のメモ（お客様には見えない）
const AMOUNT_MISMATCH_CANCEL_NOTE = '支払額の違いの自動の取消';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/** 管理画面の返金（道ア）。商品と数・送料・額は画面が決め、DB が通すか断るかを決める */
export async function submitAdminRefund(
  deps: RefundServiceDeps,
  input: { orderId: string; actorId: string; request: CreateRefundRequest },
): Promise<RefundSubmitResult> {
  const { orderId, actorId, request } = input;
  return startRefund(deps, {
    orderId,
    source: 'admin',
    requestKey: request.requestKey,
    lines: request.lines,
    restock: request.restock,
    shippingAmount: request.shippingAmount,
    amount: request.amount,
    note: request.note,
    stripeReason: request.stripeReason,
    cancelReason: null,
    notifyCustomer: request.notifyCustomer,
    actorId,
  });
}

/** 支払い済みの注文のキャンセル（道イ）。残りの商品と送料の全額は DB が決めるので、額と送料には 0 を渡す */
export async function submitPaidOrderCancel(
  deps: RefundServiceDeps,
  input: { orderId: string; actorId: string; request: PaidCancelRequest },
): Promise<RefundSubmitResult> {
  const { orderId, actorId, request } = input;
  return startRefund(deps, {
    orderId,
    source: 'order_cancel',
    requestKey: request.requestKey,
    lines: [],
    restock: request.restock,
    shippingAmount: 0,
    amount: 0,
    note: request.note,
    // 不正の疑いの時だけ、Stripe にも伝える（Stripe がそのカードとメールアドレスを拒否の一覧に入れる）
    stripeReason: request.reason === 'suspected_fraud' ? 'fraudulent' : 'requested_by_customer',
    cancelReason: request.reason,
    notifyCustomer: request.notifyCustomer,
    actorId,
  });
}

/**
 * 自動の返金（道エ・オ）。呼ぶのは、照合が要対応を初めて記録した時だけ（P7）。
 * 失敗しても自動ではやり直さない（やり直すかどうかは呼ぶ側が決める）。実行した人はいない。
 * Stripe に理由を伝えるのは、エ・オのどちらもしない
 */
export async function startAutomaticRefund(
  deps: RefundServiceDeps,
  input: {
    orderId: string;
    source: 'auto_cancelled_order_payment' | 'auto_amount_mismatch';
    receivedAmount: number | null;
  },
): Promise<RefundSubmitResult> {
  const cancelsOrder = input.source === 'auto_amount_mismatch';
  return startRefund(deps, {
    orderId: input.orderId,
    source: input.source,
    requestKey: null,
    lines: [],
    // ②は取り消す注文の在庫を戻す。①の注文は、取り消した時に戻し済みで、商品の行も無い
    restock: cancelsOrder,
    shippingAmount: 0,
    amount: 0,
    note: cancelsOrder ? AMOUNT_MISMATCH_CANCEL_NOTE : null,
    // ①・②とも Stripe に理由を伝えない。DB（begin_order_refund）は自動の返金の理由を記録に残さず、確かめ直しは記録の値で頼む。
    // 最初の頼みに理由を付けると、同じ重複防止キーで中身が違う頼みになり、Stripe が idempotency_error にして、前の頼みが通ったかを教えない
    stripeReason: null,
    cancelReason: cancelsOrder ? 'other' : null,
    notifyCustomer: true,
    actorId: null,
    receivedAmount: input.receivedAmount,
  });
}

/**
 * 返事待ちの記録を、記録の番号で確かめ直す（画面を開き直した時の「もう一度確かめる」。P24）。
 * 記録がその注文の物でなければ refused（order_not_found）。返事待ちでなければ今の状態を返す
 * （保留・成功 → accepted・replayed、エラー・失敗 → stripe_rejected）。返事待ちなら送り直しと同じ確かめ直し
 */
export async function confirmAwaitingRefund(
  deps: RefundServiceDeps,
  input: { orderId: string; refundId: string },
): Promise<RefundSubmitResult> {
  const ref = await getOrderRefund(deps.store, input.refundId);
  // 別の注文の記録があることは教えない
  if (!ref || ref.orderId !== input.orderId) {
    return { kind: 'refused', code: 'order_not_found' };
  }
  return settleExistingRefund(deps, ref);
}

/**
 * 結果を書いた後の始末（P15）。メールの予定が書かれていれば送る処理を動かし、初めて失敗になった返金なら店へ知らせる。
 * 記録はもう書けているので、例外は投げない（投げると、画面が失敗と受け取って同じ返金をもう一度押される）。
 * 書けなかった店への知らせは、未送信の要対応として毎時の見回りが送り直す
 */
export async function applyRefundSideEffects(deps: RefundServiceDeps, result: RefundResultRow): Promise<void> {
  if (result.emailEnqueued) {
    deps.scheduleOrderEmailDelivery();
  }
  if (result.newlyFailed && result.exceptionId) {
    await notifyRefundFailure(deps, result.exceptionId, result);
  }
}

export async function createDefaultRefundServiceDeps(): Promise<RefundServiceDeps> {
  // 照合の部品は、ここで読み込む。照合（checkout-payment-reconciler*.ts）がこのファイルを import するので、
  // 静的に import すると、互いを import する輪ができる
  const [{ notifyShopOfException }, { createReconcilerMailer, createSupabaseReconcilerDatabase }] = await Promise.all([
    import('@/lib/stripe/checkout-payment-reconciler'),
    import('@/lib/stripe/checkout-payment-reconciler-deps'),
  ]);
  const client = await createServiceRoleClient();
  const reconciler = { database: createSupabaseReconcilerDatabase(client), mailer: createReconcilerMailer() };

  return {
    store: client,
    stripe: getStripeServerClient(),
    now: () => new Date(),
    notifyShopOfRefundFailure: (exceptionId, alert) => notifyShopOfException(reconciler, exceptionId, alert),
    scheduleOrderEmailDelivery,
  };
}

// ---- ここから下は、このファイルの中だけで使う ----

/**
 * 窓口の言葉（stripeRejectedBody）に載せる理由。こちらが付けた総称 stripe_rejected は、
 * 文の頭の「Stripe が返金を受け付けませんでした」と重なるので載せない
 */
function windowReasonLabel(reason: string | null): string | null {
  return reason === null || reason === 'stripe_rejected' ? null : refundFailureReasonLabel(reason);
}

type PaymentContext =
  | { kind: 'ready'; paymentIntentId: string; shippingEmail: string | null }
  | { kind: 'refused'; code: RefundErrorCode };

/**
 * 注文の支払いの番号と連絡先のメールを読む。返金は Stripe の支払い（pi_ で始まる番号）にしか頼めない。
 * 記録（返事待ち）を作る前に確かめ、断る時に返事待ちを残さない
 */
async function loadPaymentContext(deps: RefundServiceDeps, orderId: string): Promise<PaymentContext> {
  const { data, error } = await deps.store
    .from('orders')
    .select('payment_intent_id, shipping_email')
    .eq('id', orderId)
    .maybeSingle<{ payment_intent_id: string | null; shipping_email: string | null }>();
  if (error) {
    throw new RefundStoreError('load_order', error);
  }
  if (!data) {
    return { kind: 'refused', code: 'order_not_found' };
  }

  const paymentIntentId = data.payment_intent_id;
  if (!paymentIntentId || !paymentIntentId.startsWith('pi_')) {
    return { kind: 'refused', code: 'order_not_refundable' };
  }
  return { kind: 'ready', paymentIntentId, shippingEmail: data.shipping_email };
}

/** 記録を作り（DB）、Stripe に頼み、結果を書く。同じ二重防止の番号の送り直しは、前の記録の今の状態で答える */
async function startRefund(deps: RefundServiceDeps, input: BeginRefundInput): Promise<RefundSubmitResult> {
  const context = await loadPaymentContext(deps, input.orderId);
  if (context.kind === 'refused') {
    return context;
  }

  let began: BeganRefund;
  try {
    began = await beginOrderRefund(deps.store, input);
  } catch (error) {
    if (error instanceof RefundOperationError) {
      return { kind: 'refused', code: error.code };
    }
    throw error;
  }

  if (began.replayed) {
    const ref = await getOrderRefund(deps.store, began.refundId);
    return ref ? settleExistingRefund(deps, ref) : { kind: 'refused', code: 'order_not_found' };
  }

  return requestRefundFromStripe(deps, {
    refundId: began.refundId,
    orderId: input.orderId,
    actorId: input.actorId,
    amount: began.amount,
    stripeReason: input.stripeReason,
    paymentIntentId: context.paymentIntentId,
    shippingEmail: context.shippingEmail,
    replayed: false,
  });
}

/** すでにある記録（送り直し・確かめ直し）の今の状態で答える。返事待ちなら、Stripe に頼み直すか一覧から探す */
async function settleExistingRefund(deps: RefundServiceDeps, ref: OrderRefundRef): Promise<RefundSubmitResult> {
  if (ref.status !== 'awaiting_response') {
    return resultOfSettledRefund(ref);
  }

  const context = await loadPaymentContext(deps, ref.orderId);
  if (context.kind === 'refused') {
    return context;
  }

  // 頼み直す Stripe の返金は、最初の頼みと同じ中身（額・理由・実行した人）にする。同じ重複防止キーで中身が違うと、
  // Stripe は誤りにする。だから今の入力ではなく、記録の値（getOrderRefund の答え）を使う
  const request: StripeRequest = {
    refundId: ref.refundId,
    orderId: ref.orderId,
    actorId: ref.actorId,
    amount: ref.amount,
    stripeReason: ref.stripeReason,
    paymentIntentId: context.paymentIntentId,
    shippingEmail: context.shippingEmail,
    replayed: true,
  };
  const ageMs = deps.now().getTime() - Date.parse(ref.createdAt);
  return ageMs > IDEMPOTENT_RETRY_WINDOW_MS ? lookUpRefundInStripe(deps, request) : requestRefundFromStripe(deps, request);
}

/** 返事待ちではない記録の今の状態。保留・成功は受け付けた答え、エラー・失敗は Stripe が受け付けなかった答え */
function resultOfSettledRefund(ref: OrderRefundRef): RefundSubmitResult {
  if (ref.status === 'pending' || ref.status === 'succeeded') {
    return { kind: 'accepted', refundId: ref.refundId, status: ref.status, amount: ref.amount, replayed: true };
  }
  if (ref.status === 'error' || ref.status === 'failed') {
    return { kind: 'stripe_rejected', refundId: ref.refundId, reasonLabel: windowReasonLabel(ref.failureReason) };
  }
  return { kind: 'unknown', refundId: ref.refundId };
}

/** Stripe に頼む中身。最初の頼みと確かめ直しで、これが同じになる */
type StripeRequest = {
  refundId: string;
  orderId: string;
  /** 記録の実行した人。Stripe の印に入る。自動の返金は null */
  actorId: string | null;
  amount: number;
  stripeReason: StripeRefundReason | null;
  paymentIntentId: string;
  shippingEmail: string | null;
  /** 同じ二重防止の番号の送り直し・確かめ直しか。受け付けた答えの replayed に入る */
  replayed: boolean;
};

/** Stripe に返金を頼み（重複防止キー order-refund-{記録の番号}）、答えに合わせて記録を進める */
async function requestRefundFromStripe(deps: RefundServiceDeps, request: StripeRequest): Promise<RefundSubmitResult> {
  const paymentMethodType = await readPaymentMethodType(deps.stripe, request.paymentIntentId);
  if (paymentMethodType === null) {
    // 種類が分からないまま頼むと、コンビニ払いで instructions_email の有無が、最初の頼みと頼み直しで変わりうる。
    // 同じ重複防止キーで中身が変わると、Stripe は前の頼みが通ったかを教えずに誤りにする。だから頼まない。
    // 記録は返事待ちのまま、同じ番号の確かめ直し（同じキー・同じ中身）か毎時の見回りに任せる
    return { kind: 'unknown', refundId: request.refundId };
  }
  const outcome = await createStripeRefund(deps.stripe, {
    refundId: request.refundId,
    orderId: request.orderId,
    actorId: request.actorId,
    paymentIntentId: request.paymentIntentId,
    amount: request.amount,
    stripeReason: request.stripeReason,
    // コンビニ払いは、お客様に口座を入れてもらうお願いのメールを Stripe が送る。その宛先
    instructionsEmail: paymentMethodType === 'konbini' ? request.shippingEmail : null,
  });

  if (outcome.kind === 'created') {
    return writeStripeResult(deps, request, outcome.refund, paymentMethodType);
  }
  if (outcome.kind === 'rejected') {
    return recordRejection(deps, request);
  }
  // 作られたか分からない。記録は返事待ちのまま、同じキーでの確かめ直しか毎時の見回りに任せる
  return { kind: 'unknown', refundId: request.refundId };
}

/** Stripe が断った。記録をエラーにする。頼んでいる間に記録が進んでいたら、今の状態で答える */
async function recordRejection(deps: RefundServiceDeps, request: StripeRequest): Promise<RefundSubmitResult> {
  const marked = await markOrderRefundError(deps.store, request.refundId, 'stripe_rejected', false);
  if (marked.outcome === 'errored') {
    return { kind: 'stripe_rejected', refundId: request.refundId, reasonLabel: null };
  }

  const ref = await getOrderRefund(deps.store, request.refundId);
  return ref ? resultOfSettledRefund(ref) : { kind: 'unknown', refundId: request.refundId };
}

/** 23時間を超えた返事待ち。同じキーで頼み直さず、その支払いの返金の一覧から印（refund_id）で探す */
async function lookUpRefundInStripe(deps: RefundServiceDeps, request: StripeRequest): Promise<RefundSubmitResult> {
  let snapshots: StripeRefundSnapshot[];
  try {
    snapshots = await listPaymentIntentRefunds(deps.stripe, request.paymentIntentId);
  } catch (error) {
    console.warn('[refund] the refund list was not read from Stripe', errorName(error));
    return { kind: 'unknown', refundId: request.refundId };
  }

  const found = snapshots.find((snapshot) => snapshot.metadataRefundId === request.refundId);
  if (!found) {
    // 見つからなくても、ここではエラーにしない。15分たっても見つからない記録は、毎時の見回りがエラーにする
    return { kind: 'unknown', refundId: request.refundId };
  }
  // 一覧の写しは支払いの種類を持たない。頼んだ時の返事を書けなかった記録なので、見つけた時に1回だけ読んで書く。
  // 読めなくても（null）結果は書く。返金はもう作られていて、種類は戻る時期の文にだけ使う
  const paymentMethodType = await readPaymentMethodType(deps.stripe, request.paymentIntentId);
  return writeStripeResult(deps, request, found, paymentMethodType);
}

/** Stripe の返金の値を記録に書き、後の始末をして、答えを作る */
async function writeStripeResult(
  deps: RefundServiceDeps,
  request: Pick<StripeRequest, 'refundId' | 'amount' | 'replayed'>,
  snapshot: StripeRefundSnapshot,
  paymentMethodType: string | null,
): Promise<RefundSubmitResult> {
  let row: RefundResultRow;
  try {
    row = await recordOrderRefundResult(deps.store, request.refundId, {
      ...snapshot,
      paymentMethodType: snapshot.paymentMethodType ?? paymentMethodType,
    });
  } catch (error) {
    // Stripe は受け付けたが、こちらの記録に書けなかった。お金は動いているので、断りでも成功でもなく「分からない」とし、
    // 同じ記録の番号の確かめ直しで書き直す
    console.error('[refund] the Stripe result was not recorded', errorName(error));
    return { kind: 'unknown', refundId: request.refundId };
  }

  await applyRefundSideEffects(deps, row);

  if (row.status === 'pending' || row.status === 'succeeded') {
    return { kind: 'accepted', refundId: request.refundId, status: row.status, amount: request.amount, replayed: request.replayed };
  }
  if (row.status === 'failed') {
    // Stripe は作ったその場で失敗の返金を返すことがある（PayPay など）
    return { kind: 'stripe_rejected', refundId: request.refundId, reasonLabel: windowReasonLabel(snapshot.failureReason) };
  }
  return { kind: 'unknown', refundId: request.refundId };
}

async function notifyRefundFailure(deps: RefundServiceDeps, exceptionId: string, result: RefundResultRow): Promise<void> {
  try {
    await deps.notifyShopOfRefundFailure(exceptionId, await buildRefundFailureAlert(deps, result));
  } catch (error) {
    console.error('[refund] the shop was not told about the failed refund', errorName(error));
  }
}

/**
 * 返金の失敗の知らせ。失敗の理由の言葉・確保し直せなかった商品と数・キャンセルのお知らせを送っていたか
 * （店が、お客様に連絡が要るかを分かるように）を、返金の記録と注文の商品の名前から作る
 */
async function buildRefundFailureAlert(deps: RefundServiceDeps, result: RefundResultRow): Promise<ShopPaymentAlert> {
  const [refunds, ref] = await Promise.all([
    listOrderRefunds(deps.store, result.orderId),
    getOrderRefund(deps.store, result.refundId),
  ]);
  const refund = refunds.find((row) => row.refundId === result.refundId);
  const failureReason = refund?.failureReason ?? null;
  const shortageLines = (refund?.lines ?? []).filter((line) => line.rereserveShortage > 0);

  return {
    reason: 'refund_failed',
    detail: failureReason ?? 'unknown',
    orderId: result.orderId,
    // 要対応の payment_ref（Stripe の返金の番号。無ければ返金の記録の番号）と同じ物
    paymentRef: ref?.stripeRefundId ?? result.refundId,
    detectedAt: deps.now(),
    refundFailure: {
      failureReasonLabel: refundFailureReasonLabel(failureReason),
      shortages: await shortagesOf(deps, shortageLines),
      // キャンセルのお知らせの予定は、Stripe が受け付けた時に書く。返事待ちからそのまま失敗した返金（P21。受け付けた時刻が無い）は送っていない
      cancelEmailSent:
        refund !== undefined
        && (refund.source === 'order_cancel' || refund.source === 'auto_amount_mismatch')
        && refund.notifyCustomer
        && refund.acceptedAt !== null,
    },
  };
}

type OrderItemNameRow = { id: string; item_name: string; color: string | null; size: string | null };

/** 確保し直せなかった商品の名前と数。足りない行が無ければ、商品の名前は読まない */
async function shortagesOf(
  deps: RefundServiceDeps,
  lines: OrderRefundLineRow[],
): Promise<Array<{ name: string; quantity: number }>> {
  if (lines.length === 0) {
    return [];
  }

  const { data, error } = await deps.store
    .from('order_items')
    .select('id, item_name, color, size')
    .in('id', lines.map((line) => line.orderItemId));
  if (error) {
    throw new RefundStoreError('load_order_items', error);
  }

  const items = new Map(((data ?? []) as OrderItemNameRow[]).map((item) => [item.id, item] as const));
  return lines.map((line) => ({ name: itemNameOf(items.get(line.orderItemId)), quantity: line.rereserveShortage }));
}

/** 品名（色 / サイズ）。色もサイズも無ければ品名だけ */
function itemNameOf(item: OrderItemNameRow | undefined): string {
  if (!item) {
    return '商品';
  }
  const variant = [item.color, item.size].filter((part): part is string => Boolean(part)).join(' / ');
  return variant ? `${item.item_name}（${variant}）` : item.item_name;
}
