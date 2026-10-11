/**
 * 返金とキャンセルの E2E の道具（グループ E-2）。
 * 管理画面とお客様の画面は、今までの E2E と同じく窓口の答えを差し替えて確かめる（手元の DB には管理者の権限の行が無く、
 * 本物の管理者のログインには2段階認証が要る。本計画 P16）。窓口の答えは共通の約束（実装計画 C-2）の型に合わせて組み立てるので、
 * 型が変われば tsc が教えてくれる。Stripe の本物を通す2本（FR-ADMIN-080・FR-CHECKOUT-051）は、Stripe のテストモードと
 * 手元の DB・手元のメール受け（Mailpit）を使い、Stripe から届く知らせには署名をつけて手元の窓口へ送る（FR-CHECKOUT-049 と同じやり方）。
 */
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { expect, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test';
import type { CancelReason, OrderStatus } from '@/lib/orders/order-payment-types';
import type {
  CreateRefundRequest,
  RefundAcceptedResponse,
  RefundErrorResponse,
  RefundMaterialLine,
  RefundMaterials,
  RefundPaymentMethod,
} from '@/lib/orders/refund/refund-types';
import { runWorkerOnce, withLocalDb } from './order-email-test-utils';
import { fulfillJson, mockAdminSession, orderNumberOf } from './order-fulfillment-test-utils';

// ---- 金額と日時（画面・メールと同じ書き方で、期待の文字を作る） ----

const YEN = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });

/** 画面とメールが出す金額（全角の ￥ と桁区切り。Global Constraints の「金額の書き方」）。期待の文字を、画面と同じ書き方で作る */
export function formatYen(amount: number): string {
  return YEN.format(amount);
}

const JST = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' });

/** 管理画面の日時（日本時間。履歴・要対応・ショップの設定で同じ書き方） */
export function formatJst(iso: string): string {
  return JST.format(new Date(iso));
}

/** 割引の行の符号は U+2212（ハイフンではなくマイナス記号） */
export const MINUS = '−';

// ---- 言葉（Global Constraints の文。実装の定数を import せず、試験が自分で持つ） ----

export const REFUND_TEXT = {
  unknownOutcome: '返金の結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。',
  restockHint: '発送前の在庫の品を、すぐ出せる数に戻します。',
  backorderNotice:
    '受注生産の品は在庫を確保していないため、在庫には戻りません。仕上がった品を売る時は、商品の在庫の画面で「入荷」してください。',
  shippedNotice: '品物が戻る時は、先に返品を作ってください。',
  fullRefundNotice: 'まだ発送していない注文の商品を全部返すので、送料と返金額も全部返します。',
  fraudNotice: '「不正の疑い」を選ぶと、Stripe がこのカードとメールアドレスを拒否の一覧に入れます。',
  noUndo: '返金は取り消せません。',
  cancelNoUndo: 'キャンセルと返金は取り消せません。',
  noticePending: '返金を受け付けました。お金が戻ると、注文の状態が変わります。',
  noticeSucceeded: '返金しました。',
  cancelNoticePending: 'キャンセルを受け付けました。返金が済むと、注文がキャンセルになります。',
  cancelNoticeSucceeded: '注文をキャンセルし、返金しました。',
} as const;

/** 返金の画面・支払い済みのキャンセルの画面の、お金が戻る時期の案内（支払い方法ごと） */
export const TIMING_NOTES = {
  card: 'お金はカード会社によって、5〜10営業日ほどで戻ります。',
  link: 'お金はカード会社によって、5〜10営業日ほどで戻ります。',
  paypay: 'お金は PayPay 残高にすぐ戻ります。',
  konbini: 'コンビニ払いの返金は、お客様に返金先の口座を入れてもらう必要があります（Stripe からお客様にメールが届きます。45日以内）。',
  unknown: 'お金が戻るまでの日数は、お支払いの方法によって異なります。',
} as const satisfies Record<RefundPaymentMethod, string>;

/** お客様に届く返金・キャンセルのお知らせ（メール）の文（Global Constraints）。画面の案内（TIMING_NOTES）とは言い回しが違う */
export const MAIL_TEXT = {
  notShipping: '返金した商品はお送りしません。',
  stillShipping: 'ほかの商品はこれまでどおりお送りします。',
  afterCancel: 'このご注文はお支払いの前に取り消し済みのため、お支払いいただいた金額を全額返金いたします。',
  cardTiming: 'ご返金は、カード会社によって5〜10営業日ほどで反映されます。',
  /** 未入金の取消のお知らせだけに残る文。支払い済みのキャンセルのお知らせと、返金のお知らせには入らない */
  unpaidCancel: 'お支払いは発生していません。',
} as const;

const REFUND_REFUSALS = {
  order_not_cancellable: { status: 409, message: '発送した商品がある注文はキャンセルできません。返金の画面を使ってください。' },
  quantity_exceeds_unshipped: { status: 409, message: '返金できる数を超えています。画面を開き直してください。' },
  exceeds_refundable: { status: 409, message: '返せる額を超えています。' },
  must_include_unshipped: {
    status: 409,
    message: '全額を返金する時は、まだ発送していない商品もすべて選んでください。',
  },
} as const;

export type RefundRefusalCode = keyof typeof REFUND_REFUSALS;

/** 窓口が返す断りの文 */
export function refundErrorMessage(code: RefundRefusalCode): string {
  return REFUND_REFUSALS[code].message;
}

/** 窓口の断り（共通の約束 C-2 の `{ error, code }`。HTTP 409）を返す */
export async function refuseRefund(route: Route, code: RefundRefusalCode): Promise<void> {
  const { status, message } = REFUND_REFUSALS[code];
  await fulfillJson(route, { error: message, code } satisfies RefundErrorResponse, status);
}

// ---- 返金の材料と窓口の答えの組み立て ----

/**
 * 返金の材料の商品の行。既定は、ブラウス（在庫）1つで単価 12,000、まだ1つも発送していない。
 * 未発送・発送後に返せる数・在庫に戻せる数・返金した数は、渡さなければ他の欄から出す（在庫に戻せる数は、在庫の品なら未発送の全部、受注生産は 0）。
 */
export function materialLineOf(
  input: Partial<Omit<RefundMaterialLine, 'orderItemId'>> & { orderItemId: string },
): RefundMaterialLine {
  const base = {
    name: 'シルクブラウス',
    color: 'ホワイト' as string | null,
    size: 'M' as string | null,
    fulfillmentType: 'stock' as 'stock' | 'backorder',
    itemPrice: 12_000,
    quantity: 1,
    shipped: 0,
    refundedBeforeShipment: 0,
    refundedAfterShipment: 0,
    lineDiscount: 0,
    ...input,
  };
  const unshipped = input.unshipped ?? base.quantity - base.shipped - base.refundedBeforeShipment;
  return {
    ...base,
    lineTotal: input.lineTotal ?? base.itemPrice * base.quantity,
    unshipped,
    shippedRefundable: input.shippedRefundable ?? base.shipped - base.refundedAfterShipment,
    restockable: input.restockable ?? (base.fulfillmentType === 'stock' ? unshipped : 0),
    refundedUnits: input.refundedUnits ?? base.refundedBeforeShipment + base.refundedAfterShipment,
  };
}

/**
 * GET /api/admin/orders/[id]/refund の答え（返金の材料）。合計・返せる額・返せる送料・発送した数と未発送の数は、商品の行から出す。
 * 受け取った額は、渡さなければ注文の合計（商品の合計 − 割引 + 送料）。
 */
export function refundMaterialsOf(input: {
  orderId: string;
  lines: RefundMaterialLine[];
  status?: OrderStatus;
  paymentMethod?: RefundPaymentMethod;
  shippingAmount?: number;
  discountAmount?: number;
  paidAmount?: number;
  succeededAmount?: number;
  openAmount?: number;
  refundedShipping?: number;
  awaitingRefund?: RefundMaterials['awaitingRefund'];
}): RefundMaterials {
  const sum = (pick: (line: RefundMaterialLine) => number) =>
    input.lines.reduce((total, line) => total + pick(line), 0);
  const shippingAmount = input.shippingAmount ?? 0;
  const discountAmount = input.discountAmount ?? 0;
  const totalAmount = sum((line) => line.lineTotal) - discountAmount + shippingAmount;
  const paidAmount = input.paidAmount ?? totalAmount;
  const succeededAmount = input.succeededAmount ?? 0;
  const openAmount = input.openAmount ?? 0;
  const refundedShipping = input.refundedShipping ?? 0;
  return {
    order: {
      id: input.orderId,
      orderNumber: orderNumberOf(input.orderId),
      status: input.status ?? 'paid',
      paymentMethod: input.paymentMethod ?? 'card',
      totalAmount,
      shippingAmount,
      discountAmount,
      paidAmount,
      succeededAmount,
      openAmount,
      refundableAmount: Math.max(paidAmount - succeededAmount - openAmount, 0),
      refundedShipping,
      refundableShipping: Math.max(shippingAmount - refundedShipping, 0),
      shippedTotal: sum((line) => line.shipped),
      unshippedTotal: sum((line) => line.unshipped),
    },
    lines: input.lines,
    awaitingRefund: input.awaitingRefund ?? null,
  };
}

/** 返金（と支払い済みのキャンセル）の窓口が「受け付けた」時の答え（200）。既定は保留 */
export function acceptedRefund(input: {
  amount: number;
  status?: 'pending' | 'succeeded';
  replayed?: boolean;
  refundId?: string;
}): RefundAcceptedResponse {
  return {
    refundId: input.refundId ?? randomUUID(),
    status: input.status ?? 'pending',
    amount: input.amount,
    replayed: input.replayed ?? false,
  };
}

/** 取消の窓口（POST /api/admin/orders/[id]/status）に、支払い済みのキャンセルとして届く本文 */
export type PaidCancelPost = {
  status: 'cancelled';
  requestKey: string;
  reason: CancelReason;
  note?: string;
  restock: boolean;
  notifyCustomer: boolean;
};

export type RefundRouteState = {
  /** 返金の材料の窓口（GET）の答え。試験が差し替えられる */
  materials: RefundMaterials;
  materialsReads: number;
  refundPosts: CreateRefundRequest[];
  statusPosts: PaidCancelPost[];
  confirmPosts: Array<{ refundId: string }>;
  /** 返金の窓口（POST）の答え。既定は「保留で受け付けた」。試験が差し替えて、断りや通信の切れを起こす */
  answerRefund: (route: Route, body: CreateRefundRequest) => Promise<void>;
  /** 取消の窓口（POST /status）の答え。既定は、返せる額の全額を「保留で受け付けた」 */
  answerStatus: (route: Route, body: PaidCancelPost) => Promise<void>;
  /** 確かめ直しの窓口（POST /refund/confirm）の答え。既定は「前の返金は成功していた」 */
  answerConfirm: (route: Route, body: { refundId: string }) => Promise<void>;
};

export function newRefundRouteState(materials: RefundMaterials): RefundRouteState {
  const state: RefundRouteState = {
    materials,
    materialsReads: 0,
    refundPosts: [],
    statusPosts: [],
    confirmPosts: [],
    answerRefund: (route, body) => fulfillJson(route, acceptedRefund({ amount: body.amount })),
    answerStatus: (route) => fulfillJson(route, acceptedRefund({ amount: state.materials.order.refundableAmount })),
    answerConfirm: (route, body) =>
      fulfillJson(
        route,
        acceptedRefund({
          refundId: body.refundId,
          status: 'succeeded',
          amount: state.materials.awaitingRefund?.amount ?? 0,
          replayed: true,
        }),
      ),
  };
  return state;
}

/**
 * その注文の返金の材料（GET）・返金（POST）・確かめ直し（POST …/confirm）・取消（POST …/status）の窓口を差し替える。
 * 後から登録した窓口が先に効くので、管理画面の窓口（mockAdminSession・mockOrderList）を先に呼んでから、これを呼ぶ。
 */
export async function mockRefundRoutes(page: Page, orderId: string, state: RefundRouteState): Promise<void> {
  await page.route(`**/api/admin/orders/${orderId}/refund`, async (route) => {
    if (route.request().method() === 'GET') {
      state.materialsReads += 1;
      await fulfillJson(route, state.materials);
      return;
    }
    const body = route.request().postDataJSON() as CreateRefundRequest;
    state.refundPosts.push(body);
    await state.answerRefund(route, body);
  });
  await page.route(`**/api/admin/orders/${orderId}/refund/confirm`, async (route) => {
    const body = route.request().postDataJSON() as { refundId: string };
    state.confirmPosts.push(body);
    await state.answerConfirm(route, body);
  });
  await page.route(`**/api/admin/orders/${orderId}/status`, async (route) => {
    const body = route.request().postDataJSON() as PaidCancelPost;
    state.statusPosts.push(body);
    await state.answerStatus(route, body);
  });
}

/** 店長（admin）かサポートの人（supporter）としてログインした形にする。管理画面が裏で読む窓口も固定する */
export async function mockAdminSessionAs(page: Page, role: 'admin' | 'supporter'): Promise<void> {
  await mockAdminSession(page);
  await page.route('**/api/auth/me', (route) =>
    fulfillJson(route, {
      authenticated: true,
      user: {
        id: role === 'admin' ? 'a' : 's',
        email: role === 'admin' ? 'admin@example.com' : 'support@example.com',
        role,
        mfaVerified: true,
      },
    }));
}

// ---- 画面の操作と読み方 ----

/** 一覧のその注文の行の「返金」を押して、返金の画面を開く */
export async function openRefundDialog(page: Page, orderId: string): Promise<Locator> {
  await page.getByRole('row', { name: new RegExp(orderId) }).getByRole('button', { name: '返金', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '返金', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 一覧のその注文の行の「キャンセル」を押して、支払い済みのキャンセルの画面を開く */
export async function openPaidCancelDialog(page: Page, orderId: string): Promise<Locator> {
  await page
    .getByRole('row', { name: new RegExp(orderId) })
    .getByRole('button', { name: 'キャンセル', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '注文をキャンセルする', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 返金の画面の「返金する数」の入力。区分（発送前の商品・発送済みの商品）と、商品の見出し（名前（色 / サイズ））で選ぶ */
export function quantityInput(dialog: Locator, section: '発送前の商品' | '発送済みの商品', productLabel: string): Locator {
  return dialog
    .getByRole('region', { name: section, exact: true })
    .getByRole('group', { name: productLabel, exact: true })
    .getByLabel('返金する数', { exact: true });
}

/** 返金の画面の内訳（商品・割引・送料・返金額）を、名前 → 金額の文字で読む */
export async function readBreakdown(dialog: Locator): Promise<Record<string, string>> {
  return dialog.getByRole('group', { name: '返金の内訳', exact: true }).evaluate((node) => {
    const rows: Record<string, string> = {};
    node.querySelectorAll('dt').forEach((term) => {
      rows[term.textContent ?? ''] = term.nextElementSibling?.textContent ?? '';
    });
    return rows;
  });
}

// ---- Stripe のテストモード ----

export type StripeRuntime = { ok: true; stripe: Stripe } | { ok: false; reason: string };

let runtime: Promise<StripeRuntime> | null = null;

/**
 * Stripe のテストモードの client。Stripe に届かない・鍵が Stripe に断られる（認証・権限の誤り）時は、理由を返す
 * （呼ぶ側が test.skip にする。FR-CHECKOUT-049 と同じく、環境の都合で落とさない）。それ以外の失敗は投げる。
 * 鍵の値は読み上げない・出さない。鍵が無い・テスト用でない時は、E2E の見張り（scripts/e2e/environment.ts）が起動の前に止めるので、
 * ここまで来ない。下の鍵の形の確かめは、見張りを通らない呼び方への備え（本番の鍵で Stripe を触らないための二重の守り）。
 */
export function stripeForE2e(): Promise<StripeRuntime> {
  runtime ??= (async (): Promise<StripeRuntime> => {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key || !/^(sk|rk)_test_/.test(key)) {
      return { ok: false, reason: 'Stripe のテスト用の鍵（STRIPE_SECRET_KEY）が無い' };
    }
    // 試験は Stripe を何度も呼ぶ（支払いを作る・返金を作る・読む・決済の画面を読み直す）ので、一瞬の通信の揺れで落ちないよう2回まで送り直す。
    // stripe-node は送り直しに重複防止キーを自動で付けるので、支払いも返金も二重にならない
    const stripe = new Stripe(key, { apiVersion: '2026-02-25.clover', maxNetworkRetries: 2, timeout: 20_000 });
    try {
      await stripe.refunds.list({ limit: 1 });
    } catch (error) {
      if (error instanceof Stripe.errors.StripeConnectionError) {
        return { ok: false, reason: 'Stripe に届かない' };
      }
      if (error instanceof Stripe.errors.StripeAuthenticationError || error instanceof Stripe.errors.StripePermissionError) {
        return { ok: false, reason: 'Stripe のテスト用の鍵が使えない（認証か権限の誤り）' };
      }
      throw error;
    }
    return { ok: true, stripe };
  })();
  return runtime;
}

/** テスト用カード（pm_card_visa）で払い済みの支払いを作る。Stripe のテストモードで本当に支払う */
export async function createPaidPaymentIntent(stripe: Stripe, amount: number): Promise<Stripe.PaymentIntent> {
  const intent = await stripe.paymentIntents.create({
    amount,
    currency: 'jpy',
    payment_method: 'pm_card_visa',
    payment_method_types: ['card'],
    confirm: true,
    description: 'E2E グループ E-2 の試験用の支払い',
  });
  if (intent.status !== 'succeeded') {
    throw new Error(`テスト用の支払いが済まなかった（${intent.status}）`);
  }
  return intent;
}

/** 店が Stripe の画面から行うのと同じ返金（こちらの印の metadata が無い）を、Stripe の API で作る。額を渡さなければ全額 */
export async function createDashboardRefund(
  stripe: Stripe,
  paymentIntentId: string,
  amount?: number,
): Promise<Stripe.Refund> {
  return stripe.refunds.create({ payment_intent: paymentIntentId, ...(amount === undefined ? {} : { amount }) });
}

/** その支払いの Stripe の返金を全部読む */
export async function listStripeRefunds(stripe: Stripe, paymentIntentId: string): Promise<Stripe.Refund[]> {
  const refunds: Stripe.Refund[] = [];
  for await (const refund of stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 })) {
    refunds.push(refund);
  }
  return refunds;
}

export type SignedEventType = 'refund.created' | 'refund.updated' | 'refund.failed' | 'checkout.session.completed';

/**
 * Stripe の知らせを、署名をつけて手元の窓口へ送る。署名の合言葉は E2E の固定の値（scripts/e2e/environment.ts）で、
 * 本番の値ではない。送った知らせの番号を返す。label は知らせの番号を試験ごとに分けるための短い文字（英数字とハイフン）。
 */
export async function sendSignedStripeEvent(
  request: APIRequestContext,
  type: SignedEventType,
  object: object,
  label: string,
): Promise<string> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET が無い（E2E の固定の値）');
  const eventId = `evt_e2e_${label}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    data: { object },
  });
  const response = await request.post('/api/webhook/stripe', {
    data: payload,
    headers: { 'content-type': 'application/json', 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret }) },
  });
  expect(response.status()).toBe(200);
  return eventId;
}

/**
 * 送った知らせの処理が終わる（completed）まで、worker の入口を叩き直しながら待つ。
 * 窓口は返事の後に worker を動かすが、1回で終わる保証が無い（worker は予算で止まる）ので、ここでも動かす。
 */
export async function waitForStripeEvent(request: APIRequestContext, eventId: string, timeoutMs = 90_000): Promise<void> {
  await expect
    .poll(
      async () => {
        await runWorkerOnce(request);
        return withLocalDb(async (db) =>
          (await db.query('select processing_status from public.stripe_webhook_events where id = $1', [eventId])).rows[0]
            ?.processing_status ?? 'none');
      },
      { timeout: timeoutMs, intervals: [500, 1_000, 2_000], message: 'Stripe の知らせの処理が終わること' },
    )
    .toBe('completed');
}

/** お店の決済の画面（Checkout Session）が、お客様の支払いで完了になるまで待ち、その時の中身を返す */
export async function waitForCheckoutSessionComplete(
  stripe: Stripe,
  sessionId: string,
  timeoutMs = 90_000,
): Promise<Stripe.Checkout.Session> {
  await expect
    .poll(async () => (await stripe.checkout.sessions.retrieve(sessionId)).status, {
      timeout: timeoutMs,
      intervals: [1_000, 2_000],
      message: 'Stripe の決済の画面が完了になること',
    })
    .toBe('complete');
  return stripe.checkout.sessions.retrieve(sessionId);
}
