/** @jest-environment node */
/**
 * 照合関数（reconcileCheckoutPayment）と実際の DB の操作（createSupabaseReconcilerDatabase）を組み合わせ、
 * 入金・払込期限切れ・金額の違い・取消後の入金の4つの流れを、実際の PostgREST（ローカル Supabase の API）に通す。
 *
 * 単体テストは DB の操作を偽物にする。reconciler_postgrest は DB の操作を単独で呼び、本物の照合関数に通すのは返金の件だけで
 * メールも偽物にしている。入金・払込期限切れ・金額の違い・取消後の入金で、照合関数が判定した行動を本物の RPC・トリガー・
 * メールの送信権が受け取り、注文・在庫・要対応の行がその通りに収まるかは、どちらでも確かめられない。
 *
 * 本物: 照合関数、createSupabaseReconcilerDatabase（supabase-js → PostgREST → RPC・表・トリガー。要対応の記録と
 *       通知の送信権の RPC を含む）、createReconcilerMailer（注文メールの組み立てと claim_order_email の送信権、
 *       期限切れのお知らせ、店への要対応メールの組み立て）。
 * 偽物: Stripe の読み取り（readPayment。段階ごとの現在値を返す。state は本物の classifyStripePaymentState で作る）、
 *       メールの送信（@/lib/mail の sendMail だけ。呼び出しを記録する）、監査ログ（deps.audit と @/lib/audit）、
 *       返金の同期（syncRefunds。この4つの流れに返金は無いので、呼ばれたら失敗させる）。
 *
 * 後片付けはしない。試験の注文は削除禁止のトリガーで、在庫の台帳は追記だけのトリガーで消せないので、ほかの DB 結合テストと
 * 同じく使い捨てのローカル DB でだけ動かす（DATABASE_URL・LOCAL_SUPABASE_URL が localhost 以外なら失敗させる）。
 * 残った行は次の npx supabase db reset で消える（実行者の auth.users の行だけは、このテストが作って消す）。
 *
 * 実行方法（ローカル Supabase を起動しておく）:
 *   eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
 *     npx jest tests/integration/db/reconciler_composed --runInBand
 */
// 外の世界に出るメールの送信だけを偽物にする。送信権（claim_order_email）と本文の組み立ては本物
jest.mock('@/lib/mail', () => ({ __esModule: true, default: jest.fn().mockResolvedValue(undefined) }));
jest.mock('next/headers', () => ({ cookies: jest.fn(), headers: jest.fn() }));
// 監査ログは偽物にし、ローカル DB の audit_logs へも ALERT_AUDIT_URL へも書かない
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

import { createClient } from '@supabase/supabase-js';
import sendMail from '@/lib/mail';
import { toOrderNumber } from '@/lib/orders/order-number';
import { PAYMENT_EXCEPTION_REASON_LABELS } from '@/lib/orders/order-payment-types';
import type { StripePaymentState } from '@/lib/stripe/checkout-payment-decision';
import { classifyStripePaymentState, type CheckoutPaymentSnapshot } from '@/lib/stripe/checkout-payment-reader';
import {
  reconcileCheckoutPayment,
  type ReconcilerDatabase,
  type ReconcilerDeps,
  type ReconcilerMailer,
} from '@/lib/stripe/checkout-payment-reconciler';
import { createReconcilerMailer, createSupabaseReconcilerDatabase } from '@/lib/stripe/checkout-payment-reconciler-deps';
import { describeLocalDb, isLocalDatabase } from './helpers/local-db';
import {
  PRICE,
  createCatalogFixture,
  createDraft,
  movementsOf,
  revisionsOf,
  uniqueSuffix,
  variantStock,
} from './helpers/order-fixtures';

jest.setTimeout(30000);

const LOCAL_API_URL = process.env.LOCAL_SUPABASE_URL;
const LOCAL_SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
/** 店への要対応メールの宛先。メールは送られない（sendMail が偽物）ので、実在しない宛先でよい */
const SHOP_ALERT_TO = 'shop-alert@example.com';
/** createDraft が下書きの配送先に入れるメールアドレス（お客様へのメールの宛先） */
const CUSTOMER_EMAIL = 'fixture@example.com';

type DraftFixture = Awaited<ReturnType<typeof createDraft>> & { variantId: number };

const sendMailMock = jest.mocked(sendMail);

/** 偽物の sendMail が受け取った呼び出し。1件ごとにテスト前に消す */
const sentMails = () => sendMailMock.mock.calls.map(([mail]) => mail);

/**
 * 判定表（設計書 3-1）の行になる Stripe の現在値。Session と PaymentIntent の組を本物の classifyStripePaymentState に
 * 渡して作るので、偽物の Stripe が返すのは、本物の読み取りが返しうる行に限られる。
 */
const stripeState = {
  /** 入金が済んだ（Session complete・paid、PaymentIntent succeeded） */
  paid: (amountReceived: number): StripePaymentState =>
    classifyStripePaymentState(
      { status: 'complete', payment_status: 'paid' },
      { status: 'succeeded', amount_received: amountReceived, currency: 'jpy', latest_charge: null },
    ),
  /** コンビニの払込票を発行した（Session complete・unpaid、PaymentIntent requires_action） */
  awaitingPayment: (): StripePaymentState =>
    classifyStripePaymentState(
      { status: 'complete', payment_status: 'unpaid' },
      { status: 'requires_action', amount_received: 0, currency: 'jpy', latest_charge: null },
    ),
  /** 払込期限が切れた（Session は unpaid のまま、PaymentIntent が requires_payment_method に戻る） */
  voucherExpired: (): StripePaymentState =>
    classifyStripePaymentState(
      { status: 'complete', payment_status: 'unpaid' },
      { status: 'requires_payment_method', amount_received: 0, currency: 'jpy', latest_charge: null },
    ),
};

/** readCheckoutPayment が返す形の Stripe の現在値。Session の項目は下書きの試験データから取る */
function snapshotOf(
  draft: DraftFixture,
  paymentIntentId: string,
  state: StripePaymentState,
  overrides: Partial<CheckoutPaymentSnapshot> = {},
): CheckoutPaymentSnapshot {
  return {
    checkoutSessionId: draft.checkoutSessionId,
    paymentIntentId,
    draftId: draft.draftId,
    cartSessionId: draft.cartSessionId,
    sessionCreatedAt: new Date(),
    amountTotal: draft.totalAmount,
    amountDiscount: 0,
    currency: 'jpy',
    paymentMethod: 'stripe_card',
    voucherExpiresAt: null,
    state,
    ...overrides,
  };
}

describeLocalDb('integration: 照合関数と実際の DB の操作を組み合わせた4つの流れ', (db) => {
  if (!LOCAL_API_URL || !LOCAL_SERVICE_ROLE_KEY) {
    test.skip('LOCAL_SUPABASE_URL・LOCAL_SUPABASE_SERVICE_ROLE_KEY 未設定のためスキップ', () => {});
    return;
  }
  if (!isLocalDatabase(LOCAL_API_URL)) {
    test('ローカルの API 以外では実行しない', () => {
      throw new Error('消せない試験注文が残るため、localhost 以外の LOCAL_SUPABASE_URL では実行しない');
    });
    return;
  }

  const apiUrl = LOCAL_API_URL;
  const serviceRoleKey = LOCAL_SERVICE_ROLE_KEY;
  // メールの組み立てが読む環境変数。このテストが書く2つだけを、終わったら元に戻す（process.env 全体は置き換えない）
  const ENV_KEYS = ['MAIL_FROM_ADDRESS', 'SHOP_ALERT_EMAIL'] as const;
  let savedEnv: Record<string, string | undefined> = {};
  let database: ReconcilerDatabase;
  let mailer: ReconcilerMailer;

  beforeAll(() => {
    // 偽物に差し替わっていなければ、環境変数を入れたあとの本物の sendMail が本当に送ってしまう。その前に止める
    if (!jest.isMockFunction(sendMail)) {
      throw new Error('@/lib/mail が偽物に差し替わっていないので、メールの宛先を設定せずに止める');
    }
    const client = createClient(apiUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    database = createSupabaseReconcilerDatabase(client);
    mailer = createReconcilerMailer(client);
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.MAIL_FROM_ADDRESS = 'no-reply@example.com';
    process.env.SHOP_ALERT_EMAIL = SHOP_ALERT_TO;
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const previous = savedEnv[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  beforeEach(() => {
    sendMailMock.mockClear();
  });

  async function newDraft(): Promise<DraftFixture> {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    return { ...draft, variantId: fx.variantId };
  }

  /** 受付 RPC（本物）で、支払い手続き中の注文と在庫の確保を先に作っておく */
  async function placeOrThrow(draft: DraftFixture): Promise<string> {
    const placed = await database.placeOrder({
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
      amountDiscount: 0,
      currency: 'jpy',
      sessionCreatedAt: new Date(),
      paymentIntentId: null,
    });
    if (!placed.placed) {
      throw new Error(`place_order_from_checkout_draft rejected the fixture: ${placed.rejection}`);
    }
    return placed.orderId;
  }

  /** 照合関数の依存。Stripe の現在値だけを world.snapshot で差し替える。DB・メールの組み立て・送信権は本物 */
  function fakeStripe(initial: CheckoutPaymentSnapshot) {
    const world = { snapshot: initial };
    const deps: ReconcilerDeps = {
      readPayment: async () => world.snapshot,
      database,
      mailer,
      audit: jest.fn().mockResolvedValue(undefined),
      syncRefunds: async () => {
        throw new Error('返金のない支払いで返金の同期が呼ばれた');
      },
      now: () => new Date(),
    };
    return { world, deps };
  }

  const reconcile = (deps: ReconcilerDeps, draft: DraftFixture) =>
    reconcileCheckoutPayment(deps, { checkoutSessionId: draft.checkoutSessionId });

  const ordersOf = async (draft: DraftFixture) =>
    (
      await db().query(
        `select id, status::text as status, payment_intent_id, total_amount, currency, review_reason
         from public.orders where checkout_session_id = $1`,
        [draft.checkoutSessionId],
      )
    ).rows;

  const exceptionsOf = async (draft: DraftFixture) =>
    (
      await db().query(
        `select id, reason, order_id, payment_intent_id, detection_count,
                shop_notified_at is not null as shop_notified,
                customer_notified_at is not null as customer_notified,
                resolved_at is not null as resolved
         from public.payment_exceptions where payment_ref = $1 order by reason`,
        [draft.checkoutSessionId],
      )
    ).rows;

  /** 取られているお客様向けメールの送信権（種類）。private スキーマなので pg で直接読む */
  const claimedEmailKinds = async (orderId: string) =>
    (await db().query('select kind from private.order_emails where order_id = $1 order by kind', [orderId])).rows.map(
      (row) => row.kind as string,
    );

  test('カードの入金: 注文が無い支払いを入金済みの注文にして確認メールを1通だけ送り、同じ事実で照合し直しても何も変わらない', async () => {
    const draft = await newDraft();
    const paymentIntentId = `pi_composed_${uniqueSuffix()}`;
    const stripe = fakeStripe(snapshotOf(draft, paymentIntentId, stripeState.paid(PRICE)));

    const first = await reconcile(stripe.deps, draft);

    // 判定表（decidePaid）: 注文なし × 入金済み → 受付してその場で入金済みにする
    expect(first).toMatchObject({ kind: 'ok', action: { type: 'place_and_mark_paid' }, orderStatus: 'paid' });
    const orders = await ordersOf(draft);
    expect(orders).toEqual([
      { id: first.orderId, status: 'paid', payment_intent_id: paymentIntentId, total_amount: PRICE, currency: 'jpy', review_reason: null },
    ]);
    const orderId = orders[0].id as string;
    // 受付で1個を確保したまま。入金済みにしても確保し直さない
    expect(await movementsOf(db(), draft.variantId)).toEqual([
      { delta: 2, reason: 'restock' },
      { delta: -1, reason: 'purchase' },
    ]);
    expect(await variantStock(db(), draft.variantId)).toBe(1);
    expect(await exceptionsOf(draft)).toEqual([]);
    // 確認メールの送信権は本物の RPC で1行だけ取られ、送信（偽物）は1回
    expect(await claimedEmailKinds(orderId)).toEqual(['paid']);
    expect(sentMails()).toHaveLength(1);
    expect(sentMails()[0]).toMatchObject({ to: CUSTOMER_EMAIL, subject: expect.stringContaining(toOrderNumber(orderId)) });
    expect(sentMails()[0].subject).toContain('ご注文ありがとうございます');

    const revisionsAfterFirst = await revisionsOf(db(), orderId);
    const second = await reconcile(stripe.deps, draft);

    // 同じ事実からは同じ行動（何もしない）。注文・台帳・変更履歴・送信権・メールのどれも動かない
    expect(second).toEqual({ kind: 'ok', action: { type: 'none' }, orderId, orderStatus: 'paid' });
    expect(await ordersOf(draft)).toEqual(orders);
    expect(await revisionsOf(db(), orderId)).toEqual(revisionsAfterFirst);
    expect(await movementsOf(db(), draft.variantId)).toEqual([
      { delta: 2, reason: 'restock' },
      { delta: -1, reason: 'purchase' },
    ]);
    expect(await claimedEmailKinds(orderId)).toEqual(['paid']);
    expect(sentMails()).toHaveLength(1);
  });

  test('払込期限切れ: 入金待ちの注文（在庫は確保済み）が失敗になって在庫が戻り、期限切れのお知らせを1通だけ送る', async () => {
    const draft = await newDraft();
    const paymentIntentId = `pi_composed_${uniqueSuffix()}`;
    const konbini = { paymentMethod: 'stripe_konbini' };
    const stripe = fakeStripe(
      snapshotOf(draft, paymentIntentId, stripeState.awaitingPayment(), {
        ...konbini,
        voucherExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }),
    );

    // 1. 払込票を発行した。注文を作って入金待ちにし、在庫を確保したまま、お支払い待ちのメールを1通送る
    const awaiting = await reconcile(stripe.deps, draft);

    expect(awaiting).toMatchObject({ kind: 'ok', action: { type: 'place_and_mark_awaiting' }, orderStatus: 'pending' });
    const [pending] = await ordersOf(draft);
    expect(pending).toMatchObject({ status: 'pending', payment_intent_id: paymentIntentId });
    const orderId = pending.id as string;
    expect(await movementsOf(db(), draft.variantId)).toEqual([
      { delta: 2, reason: 'restock' },
      { delta: -1, reason: 'purchase' },
    ]);
    expect(await variantStock(db(), draft.variantId)).toBe(1);
    expect(await claimedEmailKinds(orderId)).toEqual(['awaiting_payment']);
    expect(sentMails()).toHaveLength(1);
    expect(sentMails()[0]).toMatchObject({ to: CUSTOMER_EMAIL, subject: expect.stringContaining(toOrderNumber(orderId)) });
    expect(sentMails()[0].subject).toContain('お支払い待ち');
    // 注文詳細に出す支払い方法は、下書きに本物の更新で書かれる
    const draftRow = await db().query('select payment_method from public.checkout_drafts where id = $1', [draft.draftId]);
    expect(draftRow.rows[0].payment_method).toBe('stripe_konbini');

    // 2. 払込期限が切れた（判定表: voucher_expired × 入金待ち → 失敗にして在庫を戻す）
    stripe.world.snapshot = snapshotOf(draft, paymentIntentId, stripeState.voucherExpired(), konbini);
    const expired = await reconcile(stripe.deps, draft);

    expect(expired).toMatchObject({
      kind: 'ok',
      action: { type: 'release', expectedStatus: 'pending', nextStatus: 'failed' },
      orderId,
      orderStatus: 'failed',
    });
    expect((await ordersOf(draft))[0]).toMatchObject({ status: 'failed' });
    const revisions = await revisionsOf(db(), orderId);
    expect(revisions[revisions.length - 1].reason).toBe('stripe_voucher_expired');
    // 確保した1個だけが、キャンセルの戻しとして台帳に入る
    expect(await movementsOf(db(), draft.variantId)).toEqual([
      { delta: 2, reason: 'restock' },
      { delta: -1, reason: 'purchase' },
      { delta: 1, reason: 'cancel' },
    ]);
    expect(await variantStock(db(), draft.variantId)).toBe(2);
    expect(await claimedEmailKinds(orderId)).toEqual(['awaiting_payment', 'payment_expired']);
    expect(sentMails()).toHaveLength(2);
    expect(sentMails()[1]).toMatchObject({ to: CUSTOMER_EMAIL, subject: expect.stringContaining(toOrderNumber(orderId)) });
    expect(sentMails()[1].subject).toContain('お支払い期限切れのお知らせ');

    // 3. 期限切れのままもう一度照合しても、戻した在庫は動かず、お知らせは増えない
    const again = await reconcile(stripe.deps, draft);

    expect(again).toEqual({ kind: 'ok', action: { type: 'none' }, orderId, orderStatus: 'failed' });
    expect(await movementsOf(db(), draft.variantId)).toHaveLength(3);
    expect(await claimedEmailKinds(orderId)).toEqual(['awaiting_payment', 'payment_expired']);
    expect(sentMails()).toHaveLength(2);
  });

  // 実行者を使う2件だけをネストした describe にまとめる。order_revisions.changed_by は auth.users への外部キーなので、
  // 架空の uuid ではなく実在の行を使う（tests/integration/db/release_stock_by_order.integration.test.ts と同じやり方）。
  // describeLocalDb の afterAll は先に登録済みで、同じ階層の afterAll は登録順に動く（接続が先に閉じる）。
  // ネストした describe の afterAll は親の afterAll より先に動くので、ここに置けば後片付けは接続が閉じる前に終わる。
  describe('実行者を使う流れ（発送の停止・取消）', () => {
    let ACTOR: string;

    beforeAll(async () => {
      const user = await db().query(
        `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
         values (gen_random_uuid(), $1, '{}'::jsonb, now(), now())
         returning id`,
        [`reconciler-composed-${uniqueSuffix()}@example.com`],
      );
      ACTOR = user.rows[0].id as string;
    });

    afterAll(async () => {
      // order_revisions.changed_by は ON DELETE SET NULL（profiles は ON DELETE CASCADE）なので、これで片付く
      await db().query('DELETE FROM auth.users WHERE id = $1', [ACTOR]);
    });

    const shipPaidOrder = (orderId: string) =>
      db().query(`select id from public.admin_ship_paid_order($1::uuid, $2::uuid, 'yamato', '1234-5678')`, [orderId, ACTOR]);

    test('金額の違い: 入金済みにして要対応に記録し、お客様への確認メールは出さず、解決するまで発送できない', async () => {
      const draft = await newDraft();
      const orderId = await placeOrThrow(draft);
      const paymentIntentId = `pi_composed_${uniqueSuffix()}`;
      // 注文は PRICE。Stripe が受け取ったのは 1000 円多い額
      const stripe = fakeStripe(snapshotOf(draft, paymentIntentId, stripeState.paid(PRICE + 1000)));

      const first = await reconcile(stripe.deps, draft);

      // 判定表: 手続き中 × 入金済み → 入金済みにする。mark_order_paid が金額の違いを返すので要対応にする
      expect(first).toMatchObject({ kind: 'needs_action', reason: 'paid_amount_mismatch', orderId, orderStatus: 'paid' });
      expect(await ordersOf(draft)).toEqual([
        { id: orderId, status: 'paid', payment_intent_id: paymentIntentId, total_amount: PRICE, currency: 'jpy', review_reason: null },
      ]);
      const [exception] = await exceptionsOf(draft);
      expect(exception).toEqual({
        id: expect.any(String),
        reason: 'paid_amount_mismatch',
        order_id: orderId,
        payment_intent_id: paymentIntentId,
        detection_count: 1,
        shop_notified: true,
        customer_notified: false,
        resolved: false,
      });
      expect(first).toMatchObject({ exceptionId: exception.id });
      expect(await exceptionsOf(draft)).toHaveLength(1);
      // 注文確定メールは出さない（店が確かめてから連絡する）。出るのは店への要対応メールだけ
      expect(await claimedEmailKinds(orderId)).toEqual([]);
      expect(sentMails()).toHaveLength(1);
      expect(sentMails()[0]).toMatchObject({
        to: SHOP_ALERT_TO,
        subject: expect.stringContaining(PAYMENT_EXCEPTION_REASON_LABELS.paid_amount_mismatch),
      });
      expect(sentMails()[0].text).toContain(toOrderNumber(orderId));
      // 受付で確保した在庫は、そのまま
      expect(await movementsOf(db(), draft.variantId)).toEqual([
        { delta: 2, reason: 'restock' },
        { delta: -1, reason: 'purchase' },
      ]);
      // 要対応が開いている間は発送できない
      expect((await shipPaidOrder(orderId)).rowCount).toBe(0);

      // 同じ事実で照合し直すと、入金済み × 入金済みでも金額の違いを導き直して同じ要対応に数えるだけ。
      // 店への知らせは増えず、発送は止まったまま
      const second = await reconcile(stripe.deps, draft);

      expect(second).toMatchObject({ kind: 'needs_action', reason: 'paid_amount_mismatch', orderId, exceptionId: exception.id });
      expect(await exceptionsOf(draft)).toEqual([{ ...exception, detection_count: 2 }]);
      expect(sentMails()).toHaveLength(1);
      expect((await shipPaidOrder(orderId)).rowCount).toBe(0);

      // 対照: 解決すれば発送できる。さっきの0件は、要対応が開いていたからである（配送先などほかの理由ではない）
      const resolved = await db().query(
        'select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, $3::text)',
        [exception.id, ACTOR, '差額を返金'],
      );
      expect(resolved.rows[0].resolved).toBe(true);
      expect((await shipPaidOrder(orderId)).rowCount).toBe(1);
      expect((await ordersOf(draft))[0]).toMatchObject({ id: orderId, status: 'shipped' });
    });

    test('取消後の入金: 取り消した注文は取消のまま在庫も戻したままにし、要対応に記録して店へ1回だけ知らせる', async () => {
      const draft = await newDraft();
      const orderId = await placeOrThrow(draft);
      // 管理画面の取消と同じ RPC（本物）で取り消す。実行者と理由は必須
      const released = await database.releaseStock({
        orderId,
        expectedStatus: 'payment_in_progress',
        nextStatus: 'cancelled',
        changeReason: 'admin_cancel',
        actorId: ACTOR,
        sourceEventId: null,
        cancelReason: 'customer_request',
        cancelNote: null,
        notifyCustomer: false,
      });
      expect(released).toEqual({ released: true });
      const movementsAfterCancel = [
        { delta: 2, reason: 'restock' },
        { delta: -1, reason: 'purchase' },
        { delta: 1, reason: 'cancel' },
      ];
      expect(await movementsOf(db(), draft.variantId)).toEqual(movementsAfterCancel);
      const revisionsAfterCancel = await revisionsOf(db(), orderId);

      // そのあとで、Stripe は入金済み（返金なし）と言う
      const paymentIntentId = `pi_composed_${uniqueSuffix()}`;
      const stripe = fakeStripe(snapshotOf(draft, paymentIntentId, stripeState.paid(PRICE)));
      const first = await reconcile(stripe.deps, draft);

      // 判定表（decidePaid）: 取消 × 入金済み（返金額が受取額に満たない）→ 要対応 cancelled_order_paid
      expect(first).toMatchObject({ kind: 'needs_action', reason: 'cancelled_order_paid', orderId, orderStatus: 'cancelled' });
      // 注文には何も書かず、在庫も確保し直さない
      expect((await ordersOf(draft))[0]).toMatchObject({ id: orderId, status: 'cancelled' });
      expect(await revisionsOf(db(), orderId)).toEqual(revisionsAfterCancel);
      expect(await movementsOf(db(), draft.variantId)).toEqual(movementsAfterCancel);
      expect(await variantStock(db(), draft.variantId)).toBe(2);
      const [exception] = await exceptionsOf(draft);
      expect(exception).toEqual({
        id: expect.any(String),
        reason: 'cancelled_order_paid',
        order_id: orderId,
        payment_intent_id: paymentIntentId,
        detection_count: 1,
        shop_notified: true,
        customer_notified: false,
        resolved: false,
      });
      expect(await exceptionsOf(draft)).toHaveLength(1);
      expect(first).toMatchObject({ exceptionId: exception.id });
      // お客様へのメールは出ず、店への要対応メールが1通
      expect(await claimedEmailKinds(orderId)).toEqual([]);
      expect(sentMails()).toHaveLength(1);
      expect(sentMails()[0]).toMatchObject({
        to: SHOP_ALERT_TO,
        subject: expect.stringContaining(PAYMENT_EXCEPTION_REASON_LABELS.cancelled_order_paid),
      });
      expect(sentMails()[0].text).toContain(toOrderNumber(orderId));
      expect(sentMails()[0].text).toContain(draft.checkoutSessionId);

      // 同じ事実で照合し直すと、同じ要対応に数え直すだけ。店への知らせは増えない
      const second = await reconcile(stripe.deps, draft);

      expect(second).toMatchObject({ kind: 'needs_action', reason: 'cancelled_order_paid', orderId, exceptionId: exception.id });
      expect(await exceptionsOf(draft)).toEqual([{ ...exception, detection_count: 2 }]);
      expect(sentMails()).toHaveLength(1);
      expect((await ordersOf(draft))[0]).toMatchObject({ status: 'cancelled' });
    });
  });
});
