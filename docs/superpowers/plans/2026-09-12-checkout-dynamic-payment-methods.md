# 決済手段の動的化と時間差決済の安全化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stripe の決済手段をダッシュボード設定に追従させ、コンビニ払い・銀行振込のような時間差決済が有効化されても在庫・注文記録・メール・エラー表示が破綻しないようにする。

**Architecture:** `create-session` から `payment_method_types` を外して Dynamic payment methods に切り替える。未入金注文は「注文時に在庫を引き当て、入金されなければ戻す」引当モデルで扱い、復元は冪等な DB 関数1本に集約して webhook と掃除ジョブの両方から呼ぶ。注文に記録する支払方法はクライアント申告ではなく Stripe の PaymentIntent から確定させる。`create-session` の失敗は Stripe の例外種別で分類し、再試行可否と参照IDを画面に出す。

**Tech Stack:** Next.js App Router (Route Handlers) / Stripe Node SDK 20 / `@stripe/react-stripe-js` 5 の Custom Checkout / Supabase (Postgres 17, service role, pg_cron + pg_net + Vault) / Jest / Playwright

**Spec:** `docs/superpowers/specs/2026-09-12-checkout-dynamic-payment-methods-design.md`

## Global Constraints

- **コミットしない。** `git commit` / `git add` を実行しない。変更は作業ツリーに残す（ユーザーの明示指示があるまで）。
- 作業ブランチは `master`。feature ブランチも worktree も PR も作らない。
- 本番 DB への変更（マイグレーション適用、pg_cron 登録）は**実装者が勝手に流さない**。SQL を用意し、適用はコントローラがユーザーの承認を取ってから行う。
- E2E は本番ビルドに対して実行する。dev サーバーが :3000 にいると Playwright がそれを再利用するので、実行前に停止する。
- 要求管理ルール: 機能変更には `docs/2_Specs/spec.md` の行と `e2e/FR-{CATEGORY}-{NNN}-*.spec.ts` をセットで追加する。E2E は mobile 390 / tablet 768 / desktop 1280 の3ビューポート。
- 在庫の減算は `items.stock_quantity` のみ（本番の `finalize_order_from_checkout_draft` がそうなっている）。復元も同じ対象に限定し、**減算と対称**にする。
- クライアントから送られた決済手段・金額は信用しない。サーバは Stripe と DB の値で判断する。
- Stripe の生の例外メッセージをクライアントへ返さない。相関IDのみ返し、詳細は `audit_logs` に残す。

---

## File Structure

| ファイル | 役割 |
|---|---|
| `supabase/migrations/20260912010000_add_release_stock_for_failed_order.sql`（新規）| 未入金注文の在庫を冪等に戻す DB 関数 |
| `src/app/api/webhook/stripe/route.ts`（変更）| `async_payment_failed` / `expired` から復元関数を呼ぶ。`async_payment_succeeded` で確認メールを送る |
| `src/app/api/cron/expire-pending-orders/route.ts`（新規）| 期限超過の `pending` 注文を掃除する POST ルート |
| `src/app/api/checkout/create-session/route.ts`（変更）| `payment_method_types` を送らない。`payment_method_options` を追加。再利用キーから支払方法を外す。エラー分類を適用 |
| `src/features/checkout/services/checkout-error.service.ts`（新規）| Stripe 例外 → HTTP ステータス・文言・`retryable` の写像 |
| `src/app/api/checkout/complete/route.ts`（変更）| 支払方法を PaymentIntent から確定。メールに `paymentState` を渡す |
| `src/lib/orders/order-confirmation-email.ts`（変更）| `paymentState` による件名・冒頭文の分岐 |
| `src/app/checkout/page.tsx`（変更）| 確定前の `updateEmail`。エラー表示（文言・参照ID・再試行可否）|
| `docs/2_Specs/spec.md`（変更）| FREQ-356 / FREQ-357 |
| `docs/4_DetailDesign/13_checkout.md`（変更）| 新しい決済手段を有効化するときの手順 |
| `e2e/FR-CHECKOUT-022-dynamic-payment-methods.spec.ts`（新規）| 支払方法セクションの描画 |
| `e2e/FR-CHECKOUT-023-create-session-error-classes.spec.ts`（新規）| エラー種別ごとの表示と再試行可否 |

---

### Task 1: 在庫復元の DB 関数

**Files:**
- Create: `supabase/migrations/20260912010000_add_release_stock_for_failed_order.sql`
- Test: `tests/unit/migrations/release-stock-for-failed-order.test.ts`

**Interfaces:**
- Consumes: 既存テーブル `orders`（`id`, `payment_intent_id`, `status`）、`order_items`（`order_id`, `item_id`, `quantity`）、`items`（`id`, `stock_quantity`）
- Produces: `public.release_stock_for_failed_order(_payment_intent_id text) returns table (released boolean, order_id uuid)`。Task 2 と Task 3 が `supabase.rpc('release_stock_for_failed_order', { _payment_intent_id })` で呼ぶ

- [ ] **Step 1: 既存のマイグレーション検証テストの書き方を確認する**

`tests/unit/migrations/` の既存ファイルを1つ読み、このリポジトリが「SQL ファイルの内容を静的に検証する」方式か「実 DB に当てる」方式かを確認する。以降のテストはその方式に合わせる。方式が読み取れない場合は、SQL ファイルを読んで必須要素の有無を検証する静的テストとして書く。

- [ ] **Step 2: 失敗するテストを書く**

`tests/unit/migrations/release-stock-for-failed-order.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

const sql = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260912010000_add_release_stock_for_failed_order.sql',
  ),
  'utf8',
);

describe('release_stock_for_failed_order マイグレーション', () => {
  it('pending の注文だけを対象にする', () => {
    expect(sql).toMatch(/status\s*=\s*'pending'/);
  });

  it('対象行を FOR UPDATE で確保する', () => {
    expect(sql).toMatch(/for update/i);
  });

  it('同一商品の複数明細を合算してから戻す', () => {
    // 集約せずに order_items を直接 join すると、同じ item_id の明細が
    // 1行ぶんしか反映されない（Postgres の UPDATE ... FROM の仕様）
    expect(sql).toMatch(/sum\(\s*oi\.quantity\s*\)/i);
    expect(sql).toMatch(/group by/i);
  });

  it('stock_quantity が NULL の商品は触らない', () => {
    expect(sql).toMatch(/stock_quantity is not null/i);
  });

  it('PUBLIC から実行権を剥奪し service_role にだけ与える', () => {
    expect(sql).toMatch(/revoke all on function public\.release_stock_for_failed_order\(text\) from public/i);
    expect(sql).toMatch(/grant execute on function public\.release_stock_for_failed_order\(text\) to service_role/i);
  });

  it('search_path を固定する', () => {
    expect(sql).toMatch(/set search_path/i);
  });
});
```

- [ ] **Step 3: テストが落ちることを確認する**

Run: `npx jest tests/unit/migrations/release-stock-for-failed-order.test.ts`
Expected: FAIL（マイグレーションファイルが存在せず `ENOENT`）

- [ ] **Step 4: マイグレーションを書く**

`supabase/migrations/20260912010000_add_release_stock_for_failed_order.sql`:

```sql
-- 未入金のまま終わった注文の在庫を戻す（FREQ-356）
--
-- 背景: finalize_order_from_checkout_draft は注文作成時に無条件で在庫を減らす。
-- コンビニ払い・銀行振込のような時間差決済では、入金されないまま終わる注文が
-- 発生するため、その分を戻す経路が要る。
--
-- 対称性の注意: 減算側（finalize_order_from_checkout_draft）は items.stock_quantity
-- だけを触り、バリアント在庫にも stock_movements にも関与しない。将来バリアント
-- 在庫を本番へ入れるときは、減算とこの復元の両方を同時に更新すること。片側だけ
-- 変更すると在庫が壊れる。
--
-- 冪等性: pending の注文だけを対象にし、処理すると failed へ遷移する。Stripe は
-- 同じイベントを再送するため、2回目以降は released=false を返して何もしない。

create or replace function public.release_stock_for_failed_order(
  _payment_intent_id text
)
returns table (released boolean, order_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_order_id uuid;
begin
  select o.id
  into target_order_id
  from public.orders o
  where o.payment_intent_id = _payment_intent_id
    and o.status = 'pending'
  for update;

  if target_order_id is null then
    return query select false, null::uuid;
    return;
  end if;

  update public.orders
  set status = 'failed'
  where id = target_order_id;

  -- 同一商品が複数明細に分かれている場合があるため、item_id で合算してから戻す
  update public.items i
  set stock_quantity = i.stock_quantity + agg.quantity
  from (
    select oi.item_id, sum(oi.quantity)::integer as quantity
    from public.order_items oi
    where oi.order_id = target_order_id
    group by oi.item_id
  ) agg
  where i.id = agg.item_id
    and i.stock_quantity is not null;

  return query select true, target_order_id;
end;
$$;

revoke all on function public.release_stock_for_failed_order(text) from public;
grant execute on function public.release_stock_for_failed_order(text) to service_role;
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npx jest tests/unit/migrations/release-stock-for-failed-order.test.ts`
Expected: PASS（6件）

- [ ] **Step 6: 適用はコントローラに委ねる**

本番 DB へは流さない。報告に「適用待ちのマイグレーション: `20260912010000_add_release_stock_for_failed_order.sql`」と明記する。

---

### Task 2: webhook から在庫復元を呼ぶ

**Files:**
- Modify: `src/app/api/webhook/stripe/route.ts`（`handleCheckoutSessionAsyncPaymentFailed` / `handleCheckoutSessionExpired`）
- Test: `tests/unit/api/webhook/stripe-route.test.ts`

**Interfaces:**
- Consumes: Task 1 の `release_stock_for_failed_order(_payment_intent_id text) → { released: boolean, order_id: uuid | null }[]`
- Produces: なし（webhook の内部挙動のみ）

- [ ] **Step 1: 失敗するテストを書く**

既存の `tests/unit/api/webhook/stripe-route.test.ts` に合わせてモックを用意し、次の3本を追加する（既存ファイルの `supabase` モック名・イベント組み立てヘルパに合わせて書き換えること）。

```ts
  it('async_payment_failed は在庫復元 RPC を呼ぶ', async () => {
    mockRpc.mockResolvedValue({ data: [{ released: true, order_id: 'order-1' }], error: null });

    await POST(makeStripeEventRequest('checkout.session.async_payment_failed', {
      id: 'cs_test_1',
      payment_intent: 'pi_test_1',
    }));

    expect(mockRpc).toHaveBeenCalledWith('release_stock_for_failed_order', {
      _payment_intent_id: 'pi_test_1',
    });
  });

  it('checkout.session.expired も在庫復元 RPC を呼ぶ', async () => {
    mockRpc.mockResolvedValue({ data: [{ released: true, order_id: 'order-1' }], error: null });

    await POST(makeStripeEventRequest('checkout.session.expired', {
      id: 'cs_test_2',
      payment_intent: 'pi_test_2',
    }));

    expect(mockRpc).toHaveBeenCalledWith('release_stock_for_failed_order', {
      _payment_intent_id: 'pi_test_2',
    });
  });

  it('復元対象がなくても 200 を返す（再送イベント）', async () => {
    mockRpc.mockResolvedValue({ data: [{ released: false, order_id: null }], error: null });

    const response = await POST(makeStripeEventRequest('checkout.session.async_payment_failed', {
      id: 'cs_test_3',
      payment_intent: 'pi_test_3',
    }));

    expect(response.status).toBe(200);
  });
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx jest tests/unit/api/webhook/stripe-route.test.ts`
Expected: FAIL（`mockRpc` が呼ばれない。現在は `orders` を直接 update している）

- [ ] **Step 3: 2つのハンドラを RPC 呼び出しに置き換える**

`handleCheckoutSessionAsyncPaymentFailed` と `handleCheckoutSessionExpired` の中の

```ts
  const { error } = await supabase
    .from('orders')
    .update({ status: 'failed' })
    .eq('payment_intent_id', paymentIntentId)
    .eq('status', 'pending');
```

を、次に置き換える（両方とも同じ形。`eventType` はそれぞれのイベント名を入れる）。

```ts
  const { data, error } = await supabase.rpc('release_stock_for_failed_order', {
    _payment_intent_id: paymentIntentId,
  });

  if (error) {
    console.error('[webhook] failed to release stock for order', error);
    await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'error', 'Failed to release stock for unpaid order', {
      event_type: eventType,
      checkout_session_id: session.id,
      payment_intent_id: paymentIntentId,
      error_message: error.message ?? null,
    });
    return;
  }

  const result = Array.isArray(data) ? data[0] : data;

  await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'success', 'Released stock for unpaid order', {
    event_type: eventType,
    checkout_session_id: session.id,
    payment_intent_id: paymentIntentId,
    released: result?.released ?? false,
    order_id: result?.order_id ?? null,
  });
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx jest tests/unit/api/webhook/stripe-route.test.ts`
Expected: PASS（既存テストを含め全件）

- [ ] **Step 5: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

---

### Task 3: 未入金注文の掃除ジョブ

**Files:**
- Create: `src/app/api/cron/expire-pending-orders/route.ts`
- Test: `tests/unit/api/cron/expire-pending-orders-route.test.ts`
- Create: `supabase/migrations/20260912020000_schedule_expire_pending_orders.sql`

**Interfaces:**
- Consumes: Task 1 の `release_stock_for_failed_order`
- Produces: `POST /api/cron/expire-pending-orders` → `{ processed: number, cancelled: number, recoveredAsPaid: number, skippedProcessing: number, failed: number }`

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/api/cron/expire-pending-orders-route.test.ts`:

```ts
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

const mockRpc = jest.fn();
const mockSelect = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn().mockResolvedValue({
    from: () => ({ select: mockSelect }),
    rpc: mockRpc,
  }),
}));

const mockPaymentIntentsRetrieve = jest.fn();
const mockPaymentIntentsCancel = jest.fn();
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: () => ({
    paymentIntents: { retrieve: mockPaymentIntentsRetrieve, cancel: mockPaymentIntentsCancel },
  }),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

import { POST } from '@/app/api/cron/expire-pending-orders/route';

function request(authorization?: string): Request {
  return new Request('http://localhost/api/cron/expire-pending-orders', {
    method: 'POST',
    headers: authorization ? { authorization } : {},
  });
}

function pendingOrders(rows: { id: string; payment_intent_id: string }[]) {
  mockSelect.mockReturnValue({
    eq: () => ({ lt: () => Promise.resolve({ data: rows, error: null }) }),
  });
}

describe('POST /api/cron/expire-pending-orders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'cron-secret';
    mockRpc.mockResolvedValue({ data: [{ released: true, order_id: 'order-1' }], error: null });
  });

  it('CRON_SECRET が一致しなければ 401', async () => {
    pendingOrders([]);
    const response = await POST(request('Bearer wrong'));
    expect(response.status).toBe(401);
    expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled();
  });

  it('Authorization ヘッダがなければ 401', async () => {
    pendingOrders([]);
    const response = await POST(request());
    expect(response.status).toBe(401);
  });

  it('requires_action の PaymentIntent は cancel して在庫を戻す', async () => {
    pendingOrders([{ id: 'order-1', payment_intent_id: 'pi_1' }]);
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi_1', status: 'requires_action' });

    const response = await POST(request('Bearer cron-secret'));

    expect(mockPaymentIntentsCancel).toHaveBeenCalledWith('pi_1', { cancellation_reason: 'abandoned' });
    expect(mockRpc).toHaveBeenCalledWith('release_stock_for_failed_order', { _payment_intent_id: 'pi_1' });
    expect(response.body).toMatchObject({ processed: 1, cancelled: 1 });
  });

  it('processing の PaymentIntent は触らない', async () => {
    pendingOrders([{ id: 'order-1', payment_intent_id: 'pi_2' }]);
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi_2', status: 'processing' });

    const response = await POST(request('Bearer cron-secret'));

    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ skippedProcessing: 1 });
  });

  it('succeeded の PaymentIntent は paid へ寄せ、在庫は戻さない', async () => {
    pendingOrders([{ id: 'order-1', payment_intent_id: 'pi_3' }]);
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi_3', status: 'succeeded' });

    const response = await POST(request('Bearer cron-secret'));

    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ recoveredAsPaid: 1 });
  });

  it('1件が例外でも残りを処理して件数を返す', async () => {
    pendingOrders([
      { id: 'order-1', payment_intent_id: 'pi_4' },
      { id: 'order-2', payment_intent_id: 'pi_5' },
    ]);
    mockPaymentIntentsRetrieve
      .mockRejectedValueOnce(new Error('stripe down'))
      .mockResolvedValueOnce({ id: 'pi_5', status: 'requires_action' });

    const response = await POST(request('Bearer cron-secret'));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ processed: 2, failed: 1, cancelled: 1 });
  });

  it('対象がなければ 200 と 0 件を返す', async () => {
    pendingOrders([]);
    const response = await POST(request('Bearer cron-secret'));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ processed: 0 });
  });
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx jest tests/unit/api/cron/expire-pending-orders-route.test.ts`
Expected: FAIL（ルートが存在しない）

- [ ] **Step 3: ルートを実装する**

`src/app/api/cron/expire-pending-orders/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { getStripeServerClient } from '@/lib/stripe/server';
import { expireCheckoutSessionForPaymentIntent } from '@/lib/stripe/checkout-session-expiry';
import { logAudit } from '@/lib/audit';

// 古い pending 注文を Stripe の確定状態と再照合する（FREQ-356）。
// Checkout Session が所有する PaymentIntent は直接 cancel せず、Stripe 側で
// 未払い終了状態を確認できた注文だけ在庫を戻す。
// pg_cron + pg_net から呼ばれる。net.http_post は POST しか送れないため POST。

const DEFAULT_EXPIRY_DAYS = 5;
const MAX_ORDERS_PER_RUN = 50;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

type PendingOrderRow = {
  id: string;
  payment_intent_id: string;
  checkout_session_id: string | null;
};

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get('authorization');
  if (!secret || !header) {
    return false;
  }

  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}

function resolveExpiryDays(): number {
  const raw = Number(process.env.PENDING_ORDER_EXPIRY_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EXPIRY_DAYS;
}

function resolveDailyBatchOffset(totalOrders: number, nowMs: number): number {
  const batchCount = Math.max(1, Math.ceil(totalOrders / MAX_ORDERS_PER_RUN));
  return (Math.floor(nowMs / MILLISECONDS_PER_DAY) % batchCount) * MAX_ORDERS_PER_RUN;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createServiceRoleClient();
  const stripe = getStripeServerClient();

  const threshold = new Date(Date.now() - resolveExpiryDays() * 24 * 60 * 60 * 1000).toISOString();

  const { count, error: countError } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
    .lt('created_at', threshold);

  if (countError) {
    return NextResponse.json({ error: 'Failed to list pending orders' }, { status: 500 });
  }

  const pendingOrderCount = count ?? 0;
  const batchOffset = resolveDailyBatchOffset(pendingOrderCount, Date.now());
  const { data, error } = await supabase
    .from('orders')
    .select('id, payment_intent_id, checkout_session_id')
    .eq('status', 'pending')
    .lt('created_at', threshold)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(batchOffset, batchOffset + MAX_ORDERS_PER_RUN - 1);

  if (error) {
    console.error('[cron] failed to list pending orders', error);
    return NextResponse.json({ error: 'Failed to list pending orders' }, { status: 500 });
  }

  const orders = (data ?? []) as PendingOrderRow[];
  let cancelled = 0;
  let recoveredAsPaid = 0;
  let skippedProcessing = 0;
  let skippedUncancelable = 0;
  let failed = 0;

  for (const order of orders) {
    if (!order.payment_intent_id) {
      failed += 1;
      continue;
    }

    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(order.payment_intent_id);

      if (paymentIntent.status === 'succeeded') {
        // webhook を取りこぼして pending のまま残った入金済み注文の救済
        await supabase.from('orders').update({ status: 'paid' }).eq('id', order.id).eq('status', 'pending');
        recoveredAsPaid += 1;
        continue;
      }

      if (paymentIntent.status === 'processing') {
        skippedProcessing += 1;
        continue;
      }

      if (paymentIntent.status !== 'canceled') {
        const expiry = await expireCheckoutSessionForPaymentIntent({
          stripe,
          paymentIntentId: order.payment_intent_id,
          checkoutSessionId: order.checkout_session_id,
        });
        if (expiry.outcome !== 'expired') {
          skippedUncancelable += 1;
          continue;
        }
      }

      const { error: releaseError } = await supabase.rpc('release_stock_for_unpaid_order', {
        _payment_intent_id: order.payment_intent_id,
      });

      if (releaseError) {
        throw new Error(releaseError.message);
      }

      cancelled += 1;
    } catch (orderError) {
      // 1件の失敗で残りを止めない。次回実行で再評価される。
      console.error('[cron] failed to expire pending order', order.id, orderError);
      failed += 1;
    }
  }

  const summary = {
    processed: orders.length,
    candidateCount: pendingOrderCount,
    batchOffset,
    cancelled,
    recoveredAsPaid,
    skippedProcessing,
    skippedUncancelable,
    failed,
  };

  await logAudit({
    action: 'checkout.pending_orders.expire',
    resource: 'orders',
    outcome: failed > 0 ? 'error' : skippedUncancelable > 0 ? 'failure' : 'success',
    detail: 'Expired pending orders sweep',
    metadata: summary,
  });

  return NextResponse.json(summary);
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx jest tests/unit/api/cron/expire-pending-orders-route.test.ts`
Expected: PASS（Checkout Session の open / expired / complete、競合、Session 不明、PaymentIntent の succeeded / processing / canceled、50件単位の日次巡回を含む）

- [ ] **Step 5: スケジュール登録の SQL を用意する（適用はしない）**

`supabase/migrations/20260912020000_schedule_expire_pending_orders.sql`:

```sql
-- 未入金注文の掃除ジョブを毎日 04:00 UTC に呼ぶ（FREQ-356）
-- CRON_SECRET は Vault に置き、復号して Authorization ヘッダへ渡す。
-- 事前に次を1回だけ実行しておくこと（値はアプリの環境変数と同じもの）:
--   select vault.create_secret('<CRON_SECRET>', 'cron_secret');
--   select vault.create_secret('<本番URL>', 'app_base_url');

create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'expire-pending-orders',
  '0 4 * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'app_base_url')
             || '/api/cron/expire-pending-orders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
      ),
      timeout_milliseconds := 30000
    );
  $$
);
```

- [ ] **Step 6: 型チェックと報告**

Run: `npx tsc --noEmit`
Expected: エラーなし

報告に「適用待ち: `20260912020000_schedule_expire_pending_orders.sql`（Vault への `cron_secret` / `app_base_url` 登録が前提）」と明記する。

---

### Task 4: 決済手段の動的化

**Files:**
- Modify: `src/app/api/checkout/create-session/route.ts:440-452`（`paymentMethodTypes` の導出）、`:498-530`（custom）、`:580-590`（hosted）、`isSameCheckoutContent`
- Test: `tests/unit/api/checkout/create-session-route.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `create-session` が `payment_method_types` を送らず `payment_method_options.konbini.expires_after_days = 3` を送るようになる。レスポンス形は不変

- [ ] **Step 1: 既存テストを新しい期待に書き換える**

`tests/unit/api/checkout/create-session-route.test.ts` の、支払方法ごとに `payment_method_types` を検証している既存テスト（`custom UI は選択された支払方法 %s だけを送信する` / `stripe_card 指定時は card の payment_method_types を送信する` など）を削除し、次に置き換える。

```ts
  it('payment_method_types を送らない（ダッシュボード設定に従う）', async () => {
    mockCreate.mockResolvedValue({ client_secret: 'secret', id: 'cs_test' });

    const req = makeRequest({ uiMode: 'custom', paymentMethod: 'stripe_card' });
    const res = (await POST(req)) as unknown as { status: number };

    const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(params.payment_method_types).toBeUndefined();
    expect(res.status).toBe(200);
  });

  it('コンビニの支払期限を3日で送る', async () => {
    mockCreate.mockResolvedValue({ client_secret: 'secret', id: 'cs_test' });

    await POST(makeRequest({ uiMode: 'custom' }));

    const params = mockCreate.mock.calls[0][0] as {
      payment_method_options?: { konbini?: { expires_after_days?: number } };
    };
    expect(params.payment_method_options?.konbini?.expires_after_days).toBe(3);
  });

  it('支払方法が違っても既存セッションを再利用する', async () => {
    // セッションは支払方法に依存しなくなったため、draft の payment_method が
    // 違っていても金額と明細が一致すれば作り直さない
    mockReusableDraft.mockResolvedValueOnce({
      data: { ...reusableDraftRow, payment_method: 'stripe_konbini' },
      error: null,
    });
    mockRetrieve.mockResolvedValue({ id: 'cs_existing', status: 'open', client_secret: 'secret_existing' });

    const res = (await POST(makeRequest({ uiMode: 'custom', paymentMethod: 'stripe_card' }))) as unknown as {
      body: Record<string, unknown>;
    };

    expect(mockCreate).not.toHaveBeenCalled();
    expect(res.body).toEqual({ clientSecret: 'secret_existing', checkoutSessionId: 'cs_existing' });
  });
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx jest tests/unit/api/checkout/create-session-route.test.ts`
Expected: FAIL（`payment_method_types` が送られている／`payment_method_options` がない／支払方法違いで再利用されない）

- [ ] **Step 3: `payment_method_types` の導出を削除する**

`route.ts:440-452` の次のブロックを**まるごと削除**する。

```ts
    const paymentMethodTypes =
      paymentMethod === 'stripe_paypay'
        ? ['paypay']
        : paymentMethod === 'stripe_konbini'
        ? ['konbini']
        : paymentMethod === 'stripe_card'
        ? ['card']
        : undefined;

    const paymentMethodTypesForStripe =
      (paymentMethodTypes?.length ?? 0) > 0
        ? (paymentMethodTypes as unknown as Stripe.Checkout.SessionCreateParams.PaymentMethodType[])
        : undefined;
```

同様に `paymentMethodTypesForCustomUi` の定義と、`if (paymentMethodTypesForCustomUi) { sessionParams.payment_method_types = ... }` / `if (paymentMethodTypesForStripe) { sessionParams.payment_method_types = ... }` の2つの if ブロックも削除する。

- [ ] **Step 4: `payment_method_options` を両方の sessionParams に足す**

custom / hosted それぞれの `sessionParams` オブジェクトに、`customer_email` の隣へ次を追加する。

```ts
        // 時間差決済の支払期限。引当在庫を押さえておく上限にもなる。
        // 対象手段が無効なアカウントでも Stripe は無視するため常に送ってよい。
        payment_method_options: {
          konbini: { expires_after_days: 3 },
        },
```

`customer_creation` は**追加しない**。`mode: 'payment'` の既定 `if_required` のままにする（銀行振込のように Customer を要求する手段が選ばれたときだけ Stripe が作る。`always` にするとゲスト全員分の Customer が増え、個人情報の保管先が無駄に増える）。

- [ ] **Step 5: 再利用の照合から支払方法を外す**

`isSameCheckoutContent` の次の行を削除する。

```ts
  if ((draft.payment_method ?? 'stripe_card') !== current.paymentMethod) return false;
```

呼び出し側の `isSameCheckoutContent(reusableDraft, { paymentMethod: paymentMethod ?? 'stripe_card', ... })` から `paymentMethod` プロパティを外し、引数の型定義からも削除する。`ReusableCheckoutDraftRow` の `payment_method` フィールドと `select(...)` の列指定は、監査・デバッグのため**残す**。

セッションに載る手段は生成時点のダッシュボード設定で固定されるため、手段を新たに有効化しても再利用中のセッションには反映されない。Stripe の Checkout Session は既定24時間で失効するのでコード上の対処はしない。この理由を `isSameCheckoutContent` の直前のコメントに1行残す。

- [ ] **Step 6: テストが通ることを確認する**

Run: `npx jest tests/unit/api/checkout/create-session-route.test.ts && npx tsc --noEmit`
Expected: PASS / エラーなし（削除した変数の未使用エラーが出たら、その変数も消す）

---

### Task 5: 支払方法をサーバ側で確定し、確定前にメールを Stripe へ渡す

**Files:**
- Modify: `src/app/api/checkout/complete/route.ts:376-380`（session retrieve の expand）、`:705-725`（`resolvePaymentMethod`）
- Modify: `src/app/checkout/page.tsx`（`handleConfirmPayment`）
- Test: `tests/unit/api/checkout/complete-route.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `resolvePaymentMethod(session)` — 引数から**クライアント申告を除いた**シグネチャ。Task 6 のメール分岐はこれに依存しない

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/api/checkout/complete-route.test.ts` に追加する（既存のセッションモックの組み立て方に合わせること）。

```ts
  it('実際に使われた支払方法を charge から取る', async () => {
    setupSession({
      payment_status: 'paid',
      status: 'complete',
      metadata: { draft_id: 'draft-1', session_id: 'sess-abc', selected_payment_method: 'stripe_card' },
      payment_intent: {
        id: 'pi_1',
        payment_method_types: ['paypay'],
        latest_charge: { payment_method_details: { type: 'paypay' } },
      },
    });

    await POST(makeRequest({ checkoutSessionId: 'cs_1', paymentMethod: 'stripe_card' }));

    expect(insertedOrderPaymentMethod()).toBe('stripe_paypay');
  });

  it('charge 前（未入金）は payment_method_types から取る', async () => {
    setupSession({
      payment_status: 'unpaid',
      status: 'complete',
      metadata: { draft_id: 'draft-1', session_id: 'sess-abc', selected_payment_method: 'stripe_card' },
      payment_intent: { id: 'pi_2', payment_method_types: ['konbini'], latest_charge: null },
    });

    await POST(makeRequest({ checkoutSessionId: 'cs_2' }));

    expect(insertedOrderPaymentMethod()).toBe('stripe_konbini');
  });

  it('クライアント申告は採用しない', async () => {
    setupSession({
      payment_status: 'paid',
      status: 'complete',
      metadata: { draft_id: 'draft-1', session_id: 'sess-abc', selected_payment_method: 'auto' },
      payment_intent: {
        id: 'pi_3',
        payment_method_types: ['card'],
        latest_charge: { payment_method_details: { type: 'card' } },
      },
    });

    await POST(makeRequest({ checkoutSessionId: 'cs_3', paymentMethod: 'stripe_konbini' }));

    expect(insertedOrderPaymentMethod()).toBe('stripe_card');
  });
```

`insertedOrderPaymentMethod()` は、**`checkout_drafts` への update に渡された `payment_method` の値**を拾うヘルパ。既存テストの Supabase モック（`mockFrom('checkout_drafts').update(...)`）の呼び出し引数から取り出す形で実装する。

補足（重要）: 調査したところ `orders` テーブルに支払方法の列はなく（`payment_intent_id` / `status` / `payment_status_updated_at` のみ）、注文の支払方法は **`checkout_drafts.payment_method`** に入っている値を `/api/orders/[id]` が読んでいる。現在の `resolvePaymentMethod` の戻り値は**レスポンス JSON に載るだけでどこにも保存されていない**ため、Step 4 では戻り値を draft へ書き戻すところまで行う。

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx jest tests/unit/api/checkout/complete-route.test.ts`
Expected: FAIL（クライアント申告や metadata が優先され、`stripe_card` / `stripe_konbini` が誤って入る）

- [ ] **Step 3: session retrieve の expand を深くする**

`route.ts:376-380`:

```ts
    const session = await stripe.checkout.sessions.retrieve(
      parsed.data.checkoutSessionId,
      {
        expand: ['payment_intent', 'payment_intent.latest_charge'],
      }
```

- [ ] **Step 4: `resolvePaymentMethod` を書き換える**

```ts
/**
 * 注文に記録する支払方法を決める。
 *
 * クライアント申告は採用しない（リダイレクト型の決済ではそもそも届かず、
 * 届いた場合も実際に使われた手段と一致する保証がないため）。
 * 1. 実際の charge の payment_method_details.type（最も確か）
 * 2. PaymentIntent の payment_method_types[0]（charge 前＝未入金の時間差決済）
 * 3. セッション metadata の selected_payment_method（生成時のクライアント初期値。最後の砦）
 */
function resolvePaymentMethod(
  session: Awaited<ReturnType<ReturnType<typeof getStripeServerClient>['checkout']['sessions']['retrieve']>>
): StripeCheckoutPaymentMethod {
  const paymentIntent = typeof session.payment_intent === 'string' ? null : session.payment_intent;

  const latestCharge =
    paymentIntent && typeof paymentIntent.latest_charge !== 'string'
      ? paymentIntent.latest_charge
      : null;

  const chargeType = latestCharge?.payment_method_details?.type;
  if (chargeType) {
    return mapStripePaymentMethodType(chargeType);
  }

  const intentType = paymentIntent?.payment_method_types?.[0];
  if (intentType) {
    return mapStripePaymentMethodType(intentType);
  }

  const selectedPaymentMethod = session.metadata?.selected_payment_method;
  if (isStripeCheckoutPaymentMethod(selectedPaymentMethod)) {
    return selectedPaymentMethod;
  }

  return 'stripe_card';
}
```

呼び出し3か所（`:554` / `:616` / `:687` 付近）を `resolvePaymentMethod(session)` に直す。リクエストの `paymentMethod` フィールドは後方互換のためスキーマに残すが、値は使わない。zod スキーマの該当行に「クライアント申告は採用しない」旨のコメントを書く。

**戻り値を draft に保存する。** `checkout_drafts` を `status: 'completed'` に更新している箇所（`complete/route.ts:214-222` 付近）に `payment_method` を足す。ここが注文一覧・注文詳細に出る支払方法の出所になる。

```ts
  await supabase
    .from('checkout_drafts')
    .update({
      checkout_session_id: draftData.checkout_session_id ?? null,
      payment_intent_id: paymentIntentId,
      payment_method: resolvedPaymentMethod,
      status: 'completed',
    })
    .eq('id', draftData.id);
```

`resolvedPaymentMethod` は関数の先頭付近で1回だけ `resolvePaymentMethod(session)` を評価して使い回す（3か所で個別に呼ぶと同じ計算を繰り返すため）。

- [ ] **Step 5: テストが通ることを確認する**

Run: `npx jest tests/unit/api/checkout/complete-route.test.ts && npx tsc --noEmit`
Expected: PASS / エラーなし

- [ ] **Step 6: 確定前に Stripe セッションへメールを渡す**

`src/app/checkout/page.tsx` の `handleConfirmPayment` で、配送先同期のあと `checkout.confirm()` の前に挿入する。

```ts
      // コンビニ払いの支払票送付先・カードの領収メール宛先。1画面化で空の配送先の
      // まま Stripe セッションを作るため、確定直前にここで渡す。
      const emailResult = await checkout.updateEmail(shippingForm.email.trim());
      if (emailResult.type === 'error') {
        setCheckoutError(
          emailResult.error.message ?? 'メールアドレスの反映に失敗しました。',
        );
        return;
      }
```

- [ ] **Step 7: 型チェックと実機確認**

Run: `npx tsc --noEmit && npx eslint src/app/checkout/page.tsx`
Expected: エラーなし

dev サーバーを起動できる状態なら `/checkout` を開き、カードで確定まで進めてエラーが出ないことを目視する。起動できない場合はコントローラに確認を委ねる旨を報告に書く。

---

### Task 6: create-session のエラー分類

**Files:**
- Create: `src/features/checkout/services/checkout-error.service.ts`
- Modify: `src/app/api/checkout/create-session/route.ts`（catch 節）
- Modify: `src/app/checkout/page.tsx`（`createCustomCheckoutSession` のエラー処理と表示）
- Test: `tests/unit/features/checkout/checkout-error.service.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `classifyCheckoutSessionError(error: unknown): { status: number; message: string; retryable: boolean; auditAction: string; stripe: { type?: string; code?: string; statusCode?: number; requestId?: string } }`
  - `create-session` のエラーレスポンス `{ error: 'checkout_session_failed', message: string, correlationId: string, retryable: boolean }`

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/features/checkout/checkout-error.service.test.ts`:

```ts
import Stripe from 'stripe';
import { classifyCheckoutSessionError } from '@/features/checkout/services/checkout-error.service';

function stripeError(type: string, extra: Record<string, unknown> = {}): unknown {
  const error = new Error('raw stripe message') as Error & Record<string, unknown>;
  error.type = type;
  Object.assign(error, extra);
  Object.setPrototypeOf(error, Stripe.errors.StripeError.prototype);
  return error;
}

describe('classifyCheckoutSessionError', () => {
  it('invalid_request は 422 で再試行させない', () => {
    const result = classifyCheckoutSessionError(
      stripeError('StripeInvalidRequestError', { code: 'amount_too_small', statusCode: 400, requestId: 'req_1' }),
    );

    expect(result.status).toBe(422);
    expect(result.retryable).toBe(false);
    expect(result.stripe.code).toBe('amount_too_small');
    expect(result.stripe.requestId).toBe('req_1');
  });

  it('rate_limit は 429 で再試行させる', () => {
    const result = classifyCheckoutSessionError(stripeError('StripeRateLimitError'));
    expect(result.status).toBe(429);
    expect(result.retryable).toBe(true);
  });

  it('接続エラーは 503 で再試行させる', () => {
    const result = classifyCheckoutSessionError(stripeError('StripeConnectionError'));
    expect(result.status).toBe(503);
    expect(result.retryable).toBe(true);
  });

  it('認証エラーは 500・再試行不可で、専用の audit action を返す', () => {
    const result = classifyCheckoutSessionError(stripeError('StripeAuthenticationError'));
    expect(result.status).toBe(500);
    expect(result.retryable).toBe(false);
    expect(result.auditAction).toBe('checkout.session.create.misconfigured');
  });

  it('Stripe 以外の例外は 500・再試行可', () => {
    const result = classifyCheckoutSessionError(new Error('boom'));
    expect(result.status).toBe(500);
    expect(result.retryable).toBe(true);
  });

  it('Stripe の生メッセージを message に出さない', () => {
    const result = classifyCheckoutSessionError(
      stripeError('StripeInvalidRequestError', { code: 'amount_too_small' }),
    );
    expect(result.message).not.toContain('raw stripe message');
    expect(result.message.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx jest tests/unit/features/checkout/checkout-error.service.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 分類サービスを実装する**

`src/features/checkout/services/checkout-error.service.ts`:

```ts
import Stripe from 'stripe';

export type CheckoutSessionErrorClassification = {
  status: number;
  message: string;
  retryable: boolean;
  auditAction: string;
  stripe: {
    type?: string;
    code?: string;
    statusCode?: number;
    requestId?: string;
  };
};

const DEFAULT_AUDIT_ACTION = 'checkout.session.create';

/**
 * Stripe の例外を、クライアントへ返してよい形に分類する。
 *
 * - 生のメッセージは返さない（内部情報の露出を避ける）。日本語の定型文に写す
 * - 永続的な失敗（金額下限など）は 422 とし、再試行ボタンを出させない
 * - 一時的な失敗（レート制限・接続）は 429 / 503 とし、再試行させる
 */
export function classifyCheckoutSessionError(error: unknown): CheckoutSessionErrorClassification {
  if (error instanceof Stripe.errors.StripeError) {
    const stripe = {
      type: error.type,
      code: error.code,
      statusCode: error.statusCode,
      requestId: error.requestId,
    };

    switch (error.type) {
      case 'StripeInvalidRequestError':
        return {
          status: 422,
          message: 'ご注文内容では決済を開始できません。カートの内容をご確認ください。',
          retryable: false,
          auditAction: DEFAULT_AUDIT_ACTION,
          stripe,
        };
      case 'StripeRateLimitError':
        return {
          status: 429,
          message: '混み合っています。しばらく待ってから再度お試しください。',
          retryable: true,
          auditAction: DEFAULT_AUDIT_ACTION,
          stripe,
        };
      case 'StripeConnectionError':
      case 'StripeAPIError':
        return {
          status: 503,
          message: '決済サービスに接続できませんでした。時間をおいて再度お試しください。',
          retryable: true,
          auditAction: DEFAULT_AUDIT_ACTION,
          stripe,
        };
      case 'StripeAuthenticationError':
      case 'StripePermissionError':
        return {
          status: 500,
          message: '決済を開始できませんでした。しばらくしてからお試しください。',
          retryable: false,
          auditAction: 'checkout.session.create.misconfigured',
          stripe,
        };
      default:
        return {
          status: 500,
          message: '決済を開始できませんでした。時間をおいて再度お試しください。',
          retryable: true,
          auditAction: DEFAULT_AUDIT_ACTION,
          stripe,
        };
    }
  }

  return {
    status: 500,
    message: '決済を開始できませんでした。時間をおいて再度お試しください。',
    retryable: true,
    auditAction: DEFAULT_AUDIT_ACTION,
    stripe: {},
  };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx jest tests/unit/features/checkout/checkout-error.service.test.ts`
Expected: PASS（6件）

- [ ] **Step 5: `create-session` の catch を書き換える**

```ts
  } catch (error) {
    const classified = classifyCheckoutSessionError(error);
    const correlationId = randomUUID();

    console.error('Checkout session creation error:', correlationId, error);
    await logAudit({
      action: classified.auditAction,
      outcome: 'error',
      detail: 'Checkout session creation error',
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        correlation_id: correlationId,
        error_message: error instanceof Error ? error.message : 'Unknown error',
        stripe_type: classified.stripe.type ?? null,
        stripe_code: classified.stripe.code ?? null,
        stripe_status: classified.stripe.statusCode ?? null,
        stripe_request_id: classified.stripe.requestId ?? null,
      },
    });

    return NextResponse.json(
      {
        error: 'checkout_session_failed',
        message: classified.message,
        correlationId,
        retryable: classified.retryable,
      },
      { status: classified.status },
    );
  }
```

ファイル冒頭に `import { randomUUID } from 'node:crypto';` と `import { classifyCheckoutSessionError } from '@/features/checkout/services/checkout-error.service';` を足す。

- [ ] **Step 6: クライアントの表示を合わせる**

`src/app/checkout/page.tsx` の `createCustomCheckoutSession` のエラー処理で、レスポンス JSON から `message` / `correlationId` / `retryable` を読む。

```ts
        const errorData: {
          error?: string;
          message?: string;
          correlationId?: string;
          retryable?: boolean;
        } = await response.json().catch(() => ({}));

        // 在庫切れは既存の専用メッセージを優先する（FR-CHECKOUT-007）
        if (errorData.error === 'out_of_stock' && errorData.message) {
          setSessionErrorRetryable(false);
          throw new Error(errorData.message);
        }

        setSessionErrorRetryable(errorData.retryable ?? true);
        setSessionErrorCorrelationId(errorData.correlationId ?? null);
        throw new Error(errorData.message ?? '決済セッションの初期化に失敗しました。');
```

state を2つ足す。

```ts
  const [sessionErrorRetryable, setSessionErrorRetryable] = useState(true);
  const [sessionErrorCorrelationId, setSessionErrorCorrelationId] = useState<string | null>(null);
```

支払方法セクションのエラー表示に参照IDを添え、再試行ボタンの条件へ `sessionErrorRetryable` を掛ける。

```tsx
          {checkoutError && (
            <div className="mt-4 space-y-3">
              <p className="lk-text-sm text-red-600">{checkoutError}</p>
              {sessionErrorCorrelationId && (
                <p style={{ fontSize: "var(--lk-size-2xs)", color: "#474747" }}>
                  エラーID: {sessionErrorCorrelationId.slice(0, 8)}
                </p>
              )}
              {!customCheckoutClientSecret && sessionErrorRetryable && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setCheckoutError(null);
                    setSessionErrorCorrelationId(null);
                    setCustomCheckoutClientSecret(null);
                    setCustomCheckoutSessionId(null);
                    sessionRequestStartedRef.current = true;
                    void createCustomCheckoutSession();
                  }}
                >
                  再試行する
                </Button>
              )}
            </div>
          )}
```

- [ ] **Step 7: 型チェックと lint**

Run: `npx tsc --noEmit && npx eslint src/app/checkout/page.tsx src/features/checkout/services/checkout-error.service.ts src/app/api/checkout/create-session/route.ts`
Expected: エラーなし

---

### Task 7: 未入金時のメール分岐

**Files:**
- Modify: `src/lib/orders/order-confirmation-email.ts`
- Modify: `src/app/api/checkout/complete/route.ts`（`sendOrderConfirmationEmail` 呼び出し）
- Modify: `src/app/api/webhook/stripe/route.ts`（`handleCheckoutSessionAsyncPaymentSucceeded`）
- Test: `tests/unit/lib/orders/order-confirmation-email.test.ts`

**Interfaces:**
- Consumes: Task 2 で整えた webhook のハンドラ
- Produces: `sendOrderConfirmationEmail` が `paymentState: 'paid' | 'awaiting_payment'` を受け取る（既定は `'paid'` で既存呼び出しを壊さない）

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/lib/orders/order-confirmation-email.test.ts`（既存ファイルがあれば追記）:

```ts
  it('未入金のときは件名を「お支払い待ち」にする', async () => {
    await sendOrderConfirmationEmail({ ...baseParams, paymentState: 'awaiting_payment' });

    const sent = mockSend.mock.calls[0][0] as { subject: string; text: string };
    expect(sent.subject).toContain('お支払い待ち');
    expect(sent.text).toContain('ご入金の確認後');
  });

  it('入金済みのときは従来の件名のまま', async () => {
    await sendOrderConfirmationEmail({ ...baseParams, paymentState: 'paid' });

    const sent = mockSend.mock.calls[0][0] as { subject: string };
    expect(sent.subject).not.toContain('お支払い待ち');
  });

  it('paymentState 未指定は入金済み扱い', async () => {
    await sendOrderConfirmationEmail(baseParams);

    const sent = mockSend.mock.calls[0][0] as { subject: string };
    expect(sent.subject).not.toContain('お支払い待ち');
  });
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx jest tests/unit/lib/orders/order-confirmation-email.test.ts`
Expected: FAIL（`paymentState` が型にない／件名が変わらない）

- [ ] **Step 3: メール本体を分岐させる**

`OrderConfirmationParams` に追加する。

```ts
  paymentState?: 'paid' | 'awaiting_payment';
```

件名と冒頭文だけを分岐する（明細・配送先の組み立ては共通のまま）。方式名は書かない。

```ts
  const awaitingPayment = params.paymentState === 'awaiting_payment';

  const subject = awaitingPayment
    ? `【お支払い待ち】ご注文を承りました（${orderNumber}）`
    : `ご注文ありがとうございました（${orderNumber}）`;

  const leadLines = awaitingPayment
    ? [
        'ご注文を承りました。まだお支払いは完了していません。',
        'お支払い手続きの案内は、決済画面および Stripe からのメールをご確認ください。',
        'ご入金の確認後、あらためて確認メールをお送りします。',
      ]
    : ['ご注文ありがとうございました。'];
```

既存の `text` 組み立てで、固定の冒頭文を使っている箇所を `leadLines` に置き換え、件名を `subject` にする。

- [ ] **Step 4: `complete` から入金状態を渡す**

`complete/route.ts` の `sendOrderConfirmationEmail(...)` 呼び出し（複数ある）に次を足す。

```ts
        paymentState: session.payment_status === 'paid' ? 'paid' : 'awaiting_payment',
```

- [ ] **Step 5: 入金確定時のメールを webhook から送る**

`handleCheckoutSessionAsyncPaymentSucceeded` の更新処理を、更新行を取得する形に変える。

```ts
  const { data: updatedOrders, error } = await supabase
    .from('orders')
    .update({ status: 'paid' })
    .eq('payment_intent_id', paymentIntentId)
    .eq('status', 'pending')
    .select('id, shipping_email, shipping_full_name, subtotal_amount, shipping_amount, total_amount, currency, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_building, shipping_phone');
```

更新行が1件あるときだけ、`order_items` を読んで確認メールを送る。0件なら再送イベントなので何もしない（冪等）。

```ts
  const updatedOrder = updatedOrders?.[0];
  if (updatedOrder) {
    const { data: orderItems } = await supabase
      .from('order_items')
      .select('item_name, color, size, quantity, line_total')
      .eq('order_id', updatedOrder.id);

    await sendOrderConfirmationEmail({
      orderId: updatedOrder.id,
      email: updatedOrder.shipping_email,
      fullName: updatedOrder.shipping_full_name,
      items: orderItems ?? [],
      subtotalAmount: updatedOrder.subtotal_amount,
      shippingAmount: updatedOrder.shipping_amount,
      totalAmount: updatedOrder.total_amount,
      currency: updatedOrder.currency,
      shipping: {
        fullName: updatedOrder.shipping_full_name,
        postalCode: updatedOrder.shipping_postal_code,
        prefecture: updatedOrder.shipping_prefecture,
        city: updatedOrder.shipping_city,
        address: updatedOrder.shipping_address,
        building: updatedOrder.shipping_building,
        phone: updatedOrder.shipping_phone,
      },
      paymentState: 'paid',
    });
  }
```

`order_items` の列名が `ConfirmationItem` の型と食い違う場合は、`select` の別名（`item_name`, `color`, `size`, `quantity`, `line_total`）で合わせる。型が合わなければ `ConfirmationItem` に合わせて写す小さな map を書く。

- [ ] **Step 6: テストが通ることを確認する**

Run: `npx jest tests/unit/lib/orders tests/unit/api/checkout tests/unit/api/webhook && npx tsc --noEmit`
Expected: PASS / エラーなし

---

### Task 8: 仕様・手順書・E2E

**Files:**
- Modify: `docs/2_Specs/spec.md`（末尾に2行）
- Modify: `docs/4_DetailDesign/13_checkout.md`（手順を追記）
- Create: `e2e/FR-CHECKOUT-022-dynamic-payment-methods.spec.ts`
- Create: `e2e/FR-CHECKOUT-023-create-session-error-classes.spec.ts`

**Interfaces:**
- Consumes: Task 4・Task 6 の実装
- Produces: なし

- [ ] **Step 1: spec.md に2行追加する**

```text
| FREQ-356 | checkout の決済手段を Stripe ダッシュボードの設定に追従させ、コンビニ払いや銀行振込のような入金までに時間差がある手段が有効化されても、在庫・注文記録・メールが破綻しないこと | FREQ-356-REQ-01 | create-session は payment_method_types を送らず、Stripe が有効と判断した手段をそのまま表示すること。コンビニの支払期限は payment_method_options で3日に固定すること | FREQ-356-REQ-02 | 未入金のまま終わった注文は、注文時に引き当てた在庫を戻すこと。復元は payment_intent_id を鍵に pending の注文のみを対象とし、再送イベントで二重に戻らないこと | FREQ-356-REQ-03 | pending のまま既定5日を超えた注文を日次で Stripe と再照合すること。Checkout Session が所有する PaymentIntent は直接取り消さず、open かつ unpaid の Checkout Session を失効させ、expired かつ unpaid、または PaymentIntent の canceled を確認できた場合だけ在庫を戻すこと。processing、complete、支払い済み、または Stripe 状態を検証できない注文は維持して監査対象とすること | FREQ-356-REQ-04 | 注文に記録する支払方法は Stripe の PaymentIntent から決めること。クライアントから送られた値は採用しないこと | FREQ-356-REQ-05 | 未入金の段階で送るメールは「お支払い待ち」と分かる件名・本文にし、入金確定時に確認メールを送ること | FREQ-356-AC-01 | mobile（390px）/ tablet（768px）/ desktop（1280px）で、/checkout の支払方法セクションに Stripe の決済フォームが描画されること | FREQ-356-AC-02 | 同一 payment_intent_id で在庫復元を2回呼んでも、在庫が戻るのは1回だけであること | FREQ-356-AC-03 | 掃除ジョブが CRON_SECRET 不一致のリクエストを 401 で拒否すること | FREQ-356-AC-04 | 支払方法が PayPay の注文で、注文に記録される支払方法が「カード」にならないこと | FREQ-356-AC-05 | Checkout Session 由来の PaymentIntent を直接 cancel せず、Session が complete、支払い済み、関連付け不明、または再検証不能の場合は注文状態と在庫を維持すること | FREQ-356-AC-06 | 候補が50件を超えて長期保留注文が含まれても、日次実行ごとに50件単位の取得範囲が巡回し、後続注文が再照合対象になること |
| FREQ-357 | 決済セッションの生成に失敗したとき、原因の種類に応じた案内と、問い合わせに使える参照IDを画面に出すこと | FREQ-357-REQ-01 | Stripe の例外種別に応じて 422 / 429 / 503 / 500 を出し分け、永続的な失敗では再試行ボタンを出さないこと | FREQ-357-REQ-02 | Stripe の生のエラーメッセージをクライアントに返さないこと。相関IDをレスポンスと監査ログの両方に記録すること | FREQ-357-AC-01 | mobile（390px）/ tablet（768px）/ desktop（1280px）で、create-session が 422 を返したとき再試行ボタンが表示されないこと | FREQ-357-AC-02 | 同3ビューポートで、create-session が 503 を返したとき再試行ボタンが表示されること | FREQ-357-AC-03 | 同3ビューポートで、エラー時に「エラーID:」を含む表示が出ること |
```

- [ ] **Step 2: 手順書を追記する**

`docs/4_DetailDesign/13_checkout.md` の末尾に、設計書 §7.5 の「新しい決済手段をダッシュボードで有効化するときの手順」を転記する。あわせて、Checkout Session の状態遷移、掃除ジョブの環境変数（`CRON_SECRET` / `PENDING_ORDER_EXPIRY_DAYS`）と pg_cron 登録 SQL の所在（`supabase/migrations/20260912020000_schedule_expire_pending_orders.sql`）を記載する。

- [ ] **Step 3: E2E を書く（FR-CHECKOUT-022）**

`e2e/FR-CHECKOUT-022-dynamic-payment-methods.spec.ts`。カートを実際に作ってセッションを張る（`FR-CHECKOUT-001` と同じ seeding を使う。50円以上の商品を選ぶこと）。

```ts
import { expect, test, type Page } from '@playwright/test';

const VIEWPORTS = [
  { name: 'mobile', width: 390 },
  { name: 'tablet', width: 768 },
  { name: 'desktop', width: 1280 },
];

function paymentIframe(page: Page) {
  return page
    .locator('section.checkout-section')
    .filter({ hasText: '支払方法の選択' })
    .locator('iframe')
    .first();
}

test.describe('FR-CHECKOUT-022 決済手段の動的化', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const seeded = await page.evaluate(async () => {
      const itemsResponse = await fetch('/api/items?pageSize=20&sort=newest');
      if (!itemsResponse.ok) {
        return { ok: false, reason: `/api/items returned ${itemsResponse.status}` };
      }
      const body = (await itemsResponse.json()) as { items?: { id?: number; price?: number }[] };
      const item = (body.items ?? []).find((i) => typeof i?.id === 'number' && (i?.price ?? 0) >= 50);
      if (!item?.id) {
        return { ok: false, reason: 'No published item priced at 50 JPY or above' };
      }
      const cartResponse = await fetch('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: item.id, quantity: 1 }),
      });
      return cartResponse.ok ? { ok: true, reason: '' } : { ok: false, reason: `cart seeding failed ${cartResponse.status}` };
    });
    if (!seeded.ok) {
      test.skip(true, seeded.reason);
    }
  });

  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）支払方法セクションに決済フォームが出る`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await page.goto('/checkout');

      // 表示される手段はダッシュボード設定に依存するため、特定手段名はアサートしない
      await expect(paymentIframe(page)).toBeVisible({ timeout: 30000 });
    });
  }
});
```

- [ ] **Step 4: E2E を書く（FR-CHECKOUT-023）**

`e2e/FR-CHECKOUT-023-create-session-error-classes.spec.ts`。`create-session` をスタブしてエラー種別ごとの表示を確認する。

```ts
import { expect, test, type Page } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

const VIEWPORTS = [
  { name: 'mobile', width: 390 },
  { name: 'tablet', width: 768 },
  { name: 'desktop', width: 1280 },
];

async function openCheckoutWithError(page: Page, status: number, retryable: boolean) {
  await mockCartApis(page, [sampleCartItem()]);
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { authenticated: false, user: null } }));
  await page.route('**/api/profile', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/profile/addresses', (route) => route.fulfill({ json: { addresses: [] } }));
  await page.route('**/api/checkout/create-session', (route) =>
    route.fulfill({
      status,
      json: {
        error: 'checkout_session_failed',
        message: 'ご注文内容では決済を開始できません。カートの内容をご確認ください。',
        correlationId: '0123abcd-4567-89ef-0123-456789abcdef',
        retryable,
      },
    }),
  );
  await page.goto('/checkout');
  await expect(page.locator('input[name="fullName"]')).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}（${viewport.width}px）422 では再試行ボタンを出さない`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await openCheckoutWithError(page, 422, false);

    await expect(page.getByText('エラーID: 0123abcd')).toBeVisible();
    await expect(page.getByRole('button', { name: '再試行する' })).toHaveCount(0);
  });

  test(`${viewport.name}（${viewport.width}px）503 では再試行ボタンを出す`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await openCheckoutWithError(page, 503, true);

    await expect(page.getByRole('button', { name: '再試行する' })).toBeVisible();
  });
}
```

- [ ] **Step 5: 静的チェック**

Run: `npx tsc --noEmit && npx eslint e2e/FR-CHECKOUT-022-dynamic-payment-methods.spec.ts e2e/FR-CHECKOUT-023-create-session-error-classes.spec.ts`
Expected: エラーなし

E2E の実行はコントローラが行う（dev サーバー停止とマイグレーション適用の判断が要るため）。実装者は Playwright を起動しない。

---

## 完了条件

- `npx tsc --noEmit` がエラーなし
- `npx jest tests/unit/api/checkout tests/unit/api/webhook tests/unit/api/cron tests/unit/features/checkout tests/unit/lib/orders tests/unit/migrations` が PASS
- `grep -rn "payment_method_types" src/app/api/checkout/create-session/route.ts` が空
- 適用待ちマイグレーション2本が報告に明記されている
- `docs/2_Specs/spec.md` に FREQ-356 / FREQ-357、`docs/4_DetailDesign/13_checkout.md` に有効化手順がある
