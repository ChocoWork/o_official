/** @jest-environment node */
/**
 * 照合関数の依存（checkout-payment-reconciler-deps.ts）と見回りの候補の条件を、実際の PostgREST（ローカル Supabase の API）に通す。
 *
 * 単体テストは Supabase のクライアントを偽物にし、DB 結合テストは pg で SQL を直接呼ぶ。どちらも PostgREST を通らないので、
 * RPC の引数名の違い（PGRST202）・列名の違い（42703）・.or() の構文の拒否（PGRST100）は見つからない。
 * 本番では決済のたびに失敗し、毎時の見回りも毎回 500 になる。
 *
 * 後片付けはしない。試験の注文は削除禁止のトリガーで、在庫の台帳は追記だけのトリガーで消せないので、ほかの DB 結合テストと
 * 同じく使い捨てのローカル DB でだけ動かす（DATABASE_URL・LOCAL_SUPABASE_URL が localhost 以外なら失敗させる）。
 * 残った行は次の npx supabase db reset で消える。
 *
 * 実行方法（ローカル Supabase を起動しておく）:
 *   eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
 *     npx jest tests/integration/db/reconciler_postgrest --runInBand
 */
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));
jest.mock('next/headers', () => ({ cookies: jest.fn(), headers: jest.fn() }));
// 見回りは候補の条件だけを確かめる。Stripe・照合関数・監査ログは偽物にし、Stripe へも監査ログへも書かない
jest.mock('@/lib/stripe/server', () => ({ getStripeServerClient: () => ({}) }));
jest.mock('@/lib/stripe/checkout-session-expiry', () => ({
  expireOpenCheckoutSession: jest.fn().mockResolvedValue('not_open'),
}));
jest.mock('@/lib/stripe/checkout-payment-reconciler', () => ({
  reconcileCheckoutPayment: jest
    .fn()
    .mockResolvedValue({ kind: 'ok', action: { type: 'none' }, orderId: null, orderStatus: null }),
  notifyShopOfException: jest.fn().mockResolvedValue(false),
}));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
// 見回りの拾い上げ・最後の成功の記録・点検（設計書 2026-10-05 グループ B の 3-5・4-6）は、単体テストと ops の DB 結合テストで
// 確かめる。ここでは候補の条件だけを見るので偽物にし、Stripe を呼ばず、ほかの DB 結合テストが読む ops の行も書かない
jest.mock('@/lib/stripe/orphan-payment-recovery', () => ({
  recoverOrphanPayments: jest
    .fn()
    .mockResolvedValue({ checkedSessions: 0, recovered: [], failed: 0, timeBudgetExhausted: false }),
  createOrphanRecoveryDeps: jest.fn().mockReturnValue({}),
  loadRecoveredOrderSummaries: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/ops/ops-store', () => ({
  ...jest.requireActual('@/lib/ops/ops-store'),
  recordHeartbeat: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/ops/ops-checks', () => ({
  runOpsChecks: jest
    .fn()
    .mockResolvedValue({ backlogAlerted: false, deadNotified: 0, staleAlerted: [], failedChecks: [] }),
}));

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { POST } from '@/app/api/cron/expire-pending-orders/route';
import type {
  ReconcileInput,
  ReconcileResult,
  ReconcilerDeps,
  ReconcilerMailer,
} from '@/lib/stripe/checkout-payment-reconciler';
import {
  createReconcilerRefundSync,
  createSupabaseReconcilerDatabase,
  listUnsentShopAlerts,
} from '@/lib/stripe/checkout-payment-reconciler-deps';
import type { OrderRefundDatabase, RefundListClient } from '@/lib/stripe/order-refund-sync';
import { describeLocalDb, isLocalDatabase } from './helpers/local-db';
import {
  PRICE,
  createCatalogFixture,
  createDraft,
  movementsOf,
  orderRow,
  uniqueSuffix,
} from './helpers/order-fixtures';

jest.setTimeout(30000);

const LOCAL_API_URL = process.env.LOCAL_SUPABASE_URL;
const LOCAL_SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = 'postgrest-integration-cron-secret';
/** 決済画面は開いてから30分ちょうどまで有効、30分を超えたら見回りの対象（設計書 2-2） */
const CHECKOUT_SESSION_VALIDITY_MS = 30 * 60 * 1000;

type ReconcilerDatabase = ReturnType<typeof createSupabaseReconcilerDatabase>;
type DraftFixture = Awaited<ReturnType<typeof createDraft>> & { variantId: number };
type SweepResponse = { status: number; body: { candidateCount: number; failed: number } };

// 上の jest.mock は見回りの候補だけを確かめるために照合関数を偽物にしている。返金の照合は本物の関数で確かめる
const { reconcileCheckoutPayment: reconcileForReal } = jest.requireActual('@/lib/stripe/checkout-payment-reconciler') as {
  reconcileCheckoutPayment: (deps: ReconcilerDeps, input: ReconcileInput) => Promise<ReconcileResult>;
};

function placeArgs(draft: DraftFixture, sessionCreatedAt: Date) {
  return {
    draftId: draft.draftId,
    checkoutSessionId: draft.checkoutSessionId,
    cartSessionId: draft.cartSessionId,
    amountTotal: draft.totalAmount,
    amountDiscount: 0,
    currency: 'jpy',
    sessionCreatedAt,
    paymentIntentId: null,
  };
}

async function placeOrThrow(database: ReconcilerDatabase, draft: DraftFixture, sessionCreatedAt: Date): Promise<string> {
  const placed = await database.placeOrder(placeArgs(draft, sessionCreatedAt));
  if (!placed.placed) {
    throw new Error(`place_order_from_checkout_draft rejected the fixture: ${placed.rejection}`);
  }
  return placed.orderId;
}

async function sweep(): Promise<SweepResponse> {
  const request = new Request('http://localhost/api/cron/expire-pending-orders', {
    method: 'POST',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  return (await POST(request)) as unknown as SweepResponse;
}

describeLocalDb('integration: 照合の依存と見回りの候補を実際の PostgREST に通す', (db) => {
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
  // 見回りのルートが読む環境変数。このテストが書く3つだけを、終わったら元に戻す（process.env 全体は置き換えない）
  const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET'] as const;
  let savedEnv: Record<string, string | undefined> = {};
  let client: SupabaseClient;
  let database: ReconcilerDatabase;

  async function newDraft(): Promise<DraftFixture> {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    return { ...draft, variantId: fx.variantId };
  }

  /**
   * 本物の照合関数の依存。注文・在庫・返金の書き込みは実際の PostgREST（本物の RPC）に通す。
   * 偽物にするのは、Stripe の現在値（入金済み・返金済みの額）・Stripe の返金一覧・メール・監査ログだけ。
   */
  function composedDeps(draft: DraftFixture, paymentIntentId: string, amountRefunded: number): ReconcilerDeps {
    const mailer: ReconcilerMailer = {
      sendOrderConfirmation: jest.fn().mockResolvedValue(true),
      sendPaymentExpired: jest.fn().mockResolvedValue(true),
      sendOrderCanceled: jest.fn().mockResolvedValue(true),
      sendUnplacedPaymentNotice: jest.fn().mockResolvedValue(true),
      sendShopAlert: jest.fn().mockResolvedValue(true),
    };
    const stripeRefunds = {
      refunds: {
        list: () => ({
          async *[Symbol.asyncIterator]() {
            if (amountRefunded > 0) {
              yield { status: 'succeeded', amount: amountRefunded, created: Math.floor(Date.now() / 1000) };
            }
          },
        }),
      },
    } as unknown as RefundListClient;

    return {
      readPayment: async () => ({
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
        state: { kind: 'paid', amountReceived: draft.totalAmount, amountRefunded, currency: 'jpy' },
      }),
      database,
      mailer,
      audit: jest.fn().mockResolvedValue(undefined),
      syncRefunds: createReconcilerRefundSync(client as unknown as OrderRefundDatabase, stripeRefunds),
      now: () => new Date(),
    };
  }

  beforeAll(() => {
    client = createClient(apiUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    database = createSupabaseReconcilerDatabase(client);
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    // 見回りのルートは createServiceRoleClient で DB を読む（SUPABASE_URL が NEXT_PUBLIC_SUPABASE_URL より優先）
    process.env.SUPABASE_URL = apiUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
    process.env.CRON_SECRET = CRON_SECRET;
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

  test('受付 → 入金済み: 受付・入金済みにする RPC の引数名と、注文・下書きの列名が通る', async () => {
    const draft = await newDraft();
    const paymentIntentId = `pi_pgrst_${uniqueSuffix()}`;

    expect(await database.findOrder({ checkoutSessionId: draft.checkoutSessionId, paymentIntentId: null })).toBeNull();
    expect(await database.findDraftContact(draft.draftId)).toEqual({
      email: 'fixture@example.com',
      fullName: '山田 花子',
      missingShippingFields: [],
    });

    // 金額が違えば注文を作らず理由を返す（照合関数はこれを要対応 order_not_creatable にする）
    expect(
      await database.placeOrder({ ...placeArgs(draft, new Date()), amountTotal: draft.totalAmount + 1 }),
    ).toEqual({ placed: false, rejection: 'amount_mismatch' });

    const orderId = await placeOrThrow(database, draft, new Date());
    expect(await database.findOrder({ checkoutSessionId: draft.checkoutSessionId, paymentIntentId: null })).toEqual({
      id: orderId,
      status: 'payment_in_progress',
      paymentIntentId: null,
      checkoutSessionId: draft.checkoutSessionId,
      totalAmount: PRICE,
      currency: 'jpy',
    });

    expect(
      await database.markOrderPaid({
        orderId,
        expectedStatus: 'payment_in_progress',
        paymentIntentId,
        paidAmount: PRICE,
        paidCurrency: 'jpy',
        sourceEventId: `evt_pgrst_${uniqueSuffix()}`,
      }),
    ).toEqual({ updated: true, amountMatches: true, needsReview: false });

    // Session ID の無い支払い（payment_intent 系のイベント・移行前の注文）は PaymentIntent で引く
    expect(await database.findOrder({ checkoutSessionId: null, paymentIntentId })).toMatchObject({
      id: orderId,
      status: 'paid',
      paymentIntentId,
    });

    await database.persistDraftPaymentMethod(draft.draftId, 'stripe_konbini');
    const stored = await db().query('select payment_method from public.checkout_drafts where id = $1', [draft.draftId]);
    expect(stored.rows[0].payment_method).toBe('stripe_konbini');
  });

  test('受付 → 入金待ち → 払込期限切れ: 入金待ちにする RPC と在庫を戻す RPC の引数名が通る', async () => {
    const draft = await newDraft();
    const paymentIntentId = `pi_pgrst_${uniqueSuffix()}`;
    const orderId = await placeOrThrow(database, draft, new Date());

    expect(await database.markOrderAwaitingPayment({ orderId, paymentIntentId, sourceEventId: null })).toEqual({
      updated: true,
    });
    expect(
      await database.findOrder({ checkoutSessionId: draft.checkoutSessionId, paymentIntentId: null }),
    ).toMatchObject({ status: 'pending', paymentIntentId });

    expect(
      await database.releaseStock({
        orderId,
        expectedStatus: 'pending',
        nextStatus: 'failed',
        changeReason: 'stripe_voucher_expired',
        actorId: null,
        sourceEventId: `evt_pgrst_${uniqueSuffix()}`,
        cancelReason: null,
        cancelNote: null,
        notifyCustomer: null,
      }),
    ).toEqual({ released: true });
    expect((await orderRow(db(), orderId)).status).toBe('failed');
    expect(await movementsOf(db(), draft.variantId)).toEqual([
      { delta: 2, reason: 'restock' },
      { delta: -1, reason: 'purchase' },
      { delta: 1, reason: 'cancel' },
    ]);
  });

  test('要対応: 記録・送信権の RPC の引数名と、未送信の一覧の列名が通る', async () => {
    const paymentRef = `cs_pgrst_${uniqueSuffix()}`;
    const exception = {
      paymentRef,
      reason: 'unexpected_state' as const,
      detail: 'postgrest_integration',
      checkoutSessionId: paymentRef,
      paymentIntentId: null,
      draftId: null,
      orderId: null,
    };
    const unsentIds = async () => (await listUnsentShopAlerts(client, 1000)).map((alert) => alert.exceptionId);

    const first = await database.recordException(exception);
    expect(first).toMatchObject({ isNew: true, isResolved: false });
    expect(await database.recordException(exception)).toEqual({
      exceptionId: first.exceptionId,
      isNew: false,
      isResolved: false,
    });
    expect(await unsentIds()).toContain(first.exceptionId);

    expect(await database.claimExceptionNotification(first.exceptionId, 'shop')).toBe(true);
    expect(await database.claimExceptionNotification(first.exceptionId, 'shop')).toBe(false);
    expect(await unsentIds()).not.toContain(first.exceptionId);

    await database.releaseExceptionNotification(first.exceptionId, 'shop');
    expect(await unsentIds()).toContain(first.exceptionId);
    expect(await database.claimExceptionNotification(first.exceptionId, 'shop')).toBe(true);
  });

  test.each([
    ['一部', 1000, 'paid', 1],
    ['全額', PRICE, 'cancelled', 0],
  ])('照合: 入金済みにした注文に%s返金済みの分があれば、返金投影の RPC で注文へ反映する（返金額 %i。結果の状態は %s、注文確定メールは %i 通）', async (_name, amountRefunded, expectedStatus, expectedMails) => {
    const draft = await newDraft();
    const orderId = await placeOrThrow(database, draft, new Date());
    const deps = composedDeps(draft, `pi_pgrst_${uniqueSuffix()}`, amountRefunded);

    const result = await reconcileForReal(deps, { checkoutSessionId: draft.checkoutSessionId });

    // 結果の状態は、返金の同期のあとの状態（全額返金なら取消）。完了 API・管理画面の取消が、取り消された注文を入金完了と扱わない
    expect(result).toMatchObject({ kind: 'ok', orderId, orderStatus: expectedStatus });
    const stored = await db().query(
      'select status::text as status, refunded_amount, refunded_at is not null as has_refunded_at from public.orders where id = $1',
      [orderId],
    );
    expect(stored.rows[0]).toEqual({ status: expectedStatus, refunded_amount: amountRefunded, has_refunded_at: true });
    // 全額返金済みの支払いには、注文確定メールを送らない（このあと取消になる）
    expect(deps.mailer.sendOrderConfirmation).toHaveBeenCalledTimes(expectedMails);

    // 同じ支払いをもう一度照合しても、同じ状態に収まる（返金の同期は何度呼んでも同じ結果）
    expect(await reconcileForReal(deps, { checkoutSessionId: draft.checkoutSessionId })).toMatchObject({
      kind: 'ok',
      orderId,
      orderStatus: expectedStatus,
    });
    const again = await db().query('select status::text as status, refunded_amount from public.orders where id = $1', [orderId]);
    expect(again.rows[0]).toEqual({ status: expectedStatus, refunded_amount: amountRefunded });
    expect(deps.mailer.sendOrderConfirmation).toHaveBeenCalledTimes(expectedMails);
  });

  test('照合: 注文が無く全額返金済みの入金済みの支払いは、注文を作らず記録だけにする（在庫も動かさない）', async () => {
    const draft = await newDraft();
    const deps = composedDeps(draft, `pi_pgrst_${uniqueSuffix()}`, PRICE);

    const result = await reconcileForReal(deps, { checkoutSessionId: draft.checkoutSessionId });

    expect(result).toEqual({
      kind: 'ok',
      action: { type: 'record_only', note: 'refunded_before_order' },
      orderId: null,
      orderStatus: null,
    });
    expect(await database.findOrder({ checkoutSessionId: draft.checkoutSessionId, paymentIntentId: null })).toBeNull();
    expect(await movementsOf(db(), draft.variantId)).toEqual([{ delta: 2, reason: 'restock' }]);
    expect(deps.mailer.sendOrderConfirmation).not.toHaveBeenCalled();
  });

  test('照合: 注文が無く一部だけ返金済みの入金済みの支払いは、注文を作って入金済みにし、返金済みの分を同じ照合で反映する', async () => {
    const draft = await newDraft();
    const deps = composedDeps(draft, `pi_pgrst_${uniqueSuffix()}`, 1000);

    const result = await reconcileForReal(deps, { checkoutSessionId: draft.checkoutSessionId });

    expect(result).toMatchObject({ kind: 'ok', action: { type: 'place_and_mark_paid' }, orderStatus: 'paid' });
    const stored = await db().query(
      'select status::text as status, refunded_amount from public.orders where checkout_session_id = $1',
      [draft.checkoutSessionId],
    );
    expect(stored.rows).toEqual([{ status: 'paid', refunded_amount: 1000 }]);
    expect(await movementsOf(db(), draft.variantId)).toEqual([
      { delta: 2, reason: 'restock' },
      { delta: -1, reason: 'purchase' },
    ]);
    expect(deps.mailer.sendOrderConfirmation).toHaveBeenCalledTimes(1);
  });

  test('見回り: 候補の条件（入れ子の and と ISO の時刻）を PostgREST が受け付け、30分を超えた支払い手続き中と入金待ちだけを数える', async () => {
    // 時刻を止める。ほかのテストが残した注文は2回の見回りで同じに数えられ、差はここで作った注文だけになる
    const now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const before = await sweep();
      expect(before.status).toBe(200);

      // 開いてから30分を1秒超えた支払い手続き中は候補、30分ちょうどは候補でない（比べ方は lt）
      await placeOrThrow(database, await newDraft(), new Date(now - CHECKOUT_SESSION_VALIDITY_MS - 1000));
      await placeOrThrow(database, await newDraft(), new Date(now - CHECKOUT_SESSION_VALIDITY_MS));
      // 入金待ちは開いてからの時間にかかわらず候補、入金済みは候補でない
      const awaitingOrderId = await placeOrThrow(database, await newDraft(), new Date(now));
      expect(
        await database.markOrderAwaitingPayment({
          orderId: awaitingOrderId,
          paymentIntentId: `pi_pgrst_${uniqueSuffix()}`,
          sourceEventId: null,
        }),
      ).toEqual({ updated: true });
      const paidOrderId = await placeOrThrow(database, await newDraft(), new Date(now - 2 * CHECKOUT_SESSION_VALIDITY_MS));
      expect(
        await database.markOrderPaid({
          orderId: paidOrderId,
          expectedStatus: 'payment_in_progress',
          paymentIntentId: `pi_pgrst_${uniqueSuffix()}`,
          paidAmount: PRICE,
          paidCurrency: 'jpy',
          sourceEventId: null,
        }),
      ).toMatchObject({ updated: true });

      const after = await sweep();
      expect(after.status).toBe(200);
      expect(after.body.candidateCount).toBe(before.body.candidateCount + 2);
      expect(after.body.failed).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
