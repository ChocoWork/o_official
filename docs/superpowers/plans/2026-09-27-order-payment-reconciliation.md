# 支払い状態の照合と注文の先受付（グループ A）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 注文と在庫を Stripe の現在の支払い状態に合わせる照合関数を1つ作り、Webhook・見回り・完了 API・管理画面の取消から呼ぶ。支払いの前に注文を受け付ける RPC を用意し、要対応・要確認を管理画面で扱えるようにする。

**Architecture:** DB 側は状態ごとの条件付き更新 RPC（受付・入金済み・入金待ち・在庫を戻す・要対応の記録と解決）で注文を動かし、在庫は台帳（`stock_movements`）に確保した分だけを戻す。アプリ側は「Stripe を読む → 純関数で判定 → RPC で反映 → 読み直す（最大3回）」の照合関数に集約する。管理画面は ORDER タブに要対応・要確認の欄と取消の画面を足す。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript、Supabase（Postgres 17、RLS、SECURITY DEFINER RPC）、Stripe（API `2026-02-25.clover`、stripe 20.4.1）、Jest（ts-jest）+ `pg`、Playwright

**Spec:** [docs/superpowers/specs/2026-09-26-order-payment-reconciliation-design.md](../specs/2026-09-26-order-payment-reconciliation-design.md)

## Global Constraints

- 本番 Supabase（`pjidrgofvaglnuuznnyj`）に書かない。DB 結合テストはローカル DB（`postgresql://postgres:postgres@127.0.0.1:54322/postgres`）だけで流し、E2E は API をモックして本番 DB に書かない。本番へは読むだけ（SELECT・`list_migrations`・`get_advisors`）
- DB 結合テストの前に Docker Desktop を起動し、`docker inspect -f '{{.State.Health.Status}}' supabase_db_o_official` が `healthy` になってから `npx supabase start` → `npx supabase db reset` を流す。全件 `ECONNREFUSED` は接続の問題で、実装の不具合ではない
- マイグレーションは `supabase/migrations/<version>_<name>.sql`。version は本計画で固定した `20260927100000` 以降を使い、本番の最新（`20260925000303`）より新しいことを作業前に Supabase MCP の `list_migrations` で確かめる。enum の値の追加は単独のファイルにする（追加した値は同じトランザクションで使えない）。enum の値は後から消せないので名前を変えない
- マイグレーションは冪等に書く（`IF NOT EXISTS`・`CREATE OR REPLACE`・`DROP ... IF EXISTS`）。`BEGIN;` と `COMMIT;` で囲む
- 新しく作る・変える関数はすべて `SECURITY DEFINER` + `SET search_path = ''` + 完全修飾名。`PUBLIC`・`anon`・`authenticated` から実行権限を剥がし、`service_role` だけに与える（`private` スキーマの補助関数は `REVOKE ALL ... FROM PUBLIC` だけ）
- 上の規則の例外: `SECURITY DEFINER` の関数・トリガー・マイグレーションからだけ呼ぶ `private` の補助関数（`private.order_line_reservations`・`private.clear_cart_for_order`・`private.suppress_legacy_unpaid_order_emails`）は `SECURITY INVOKER` のままにし、`PUBLIC` から `EXECUTE` を剥がす（`SET search_path = ''` と完全修飾名は守る）。既存のトリガー関数（`private.protect_legal_order_immutable_fields`・`private.enforce_order_payment_invariants`）を変えるときは、既存の `SECURITY INVOKER` と `search_path`（前者は `'pg_catalog'`）を踏襲する。ほかの規則は変えない
- 新しい public の表は RLS を有効にし、制限的な拒否ポリシーを置く。このプロジェクトは public の新しい表に `anon`・`authenticated` の全権限を自動で付けるので、`REVOKE ALL ... FROM anon, authenticated, service_role` の後で必要な分だけ `GRANT` する
- 照合関数は Stripe を読むだけ。Stripe へ書くのは Session の失効（管理画面の取消・見回り・商品の非公開）だけで、照合関数の外で行う。自動返金は本計画に含めない（E）
- 決済画面の規則: 開いてから30分ちょうどまで有効、30分を超えたら失効。Stripe には作成から30分30秒後の `expires_at` を渡す。見回りは毎時、1回50件・45秒まで
- コンビニの支払期限は7日（FREQ-106・R-57。2026-09-27 決定）。日数は `src/lib/constants/konbini.ts` の `KONBINI_PAYMENT_DAYS` 1か所に置き、create-session と /legal が読む。照合・見回り・取消は Stripe の `expires_at` を読み、日数を持たない
- 管理画面の商品一覧の削除ボタンは、削除できない商品にも常に出す。押した時点で理由と非公開への誘導を出し、無効化・非表示にしない（R-44。2026-09-27 決定）
- お客様へのメールは1件1回（送信権）。件名と本文は固定の文面で組み、外から来た値をヘッダーに入れない
- E2E は本番ビルドで流す（`npx playwright test <spec>`）。流す前に `Get-NetTCPConnection -LocalPort 3000 -State Listen` で dev サーバーが止まっていることを確かめる。ビューポートは 390・768・1280
- 画面と機能の変更は、実装と同じタスクで `docs/2_Specs/spec.md` の末尾に FREQ 行を足す。番号は各タスクの最初に `grep -oE "FREQ-[0-9]+" docs/2_Specs/spec.md | sort -t- -k2 -n | tail -1` で最新を確かめ、その次から振る（本計画の番号 FREQ-407〜414 は目安）。E2E の番号も `ls e2e | grep FR-ADMIN- | sort -V | tail -1` で確かめる
- 作業は master に直接コミットする。`git add` はタスクで触ったファイルだけを名指しする（作業ツリーには本計画と無関係の変更が残っている）。コミットメッセージは日本語の Conventional Commits、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。push はしない（ユーザーが行う）
- コミットのたびに graphify の post-commit フックがグラフを作り直すので、手で `graphify update` を流す必要は無い

## Review Focus

本計画のタスクのテストで直接は確かめていないが、使う人が最も踏みやすい入力と状態。各行のテストは括弧内のタスクに足してある。

1. **受付の後に同じ Session でもう一度「注文する」が届く**（二重送信・再読込・並行）: 注文は1件のまま、在庫の確保も1回だけ（Task 4 の「同じ Session で2回呼んでも注文は1件…」と「同じ Session の受付が並行しても…」）
2. **Webhook と見回りが同じ注文を同時に処理する**: 状態の変化もメールも1回だけ（Task 11 の「Webhook と見回りが同時に照合しても、入金済みにするのは1回、メールは1通」と、Task 5 の DB 結合テスト「Webhook と見回りが別の接続から同時に入金済みにしても…」）
3. **払込票を発行した直後に管理者が取り消そうとする**: 取り消せず、払込期限が表示される（Task 16 の「払込票が有効な入金待ちは取り消さず、409 と払込期限を返す」と Task 20 の E2E「払込票が有効な注文は…払込期限が表示される」）
4. **移行前から残る未入金の注文（Session ID なし）を見回りが処理する**: PaymentIntent から Session を引いて判定し、お客様にはメールを送らない（Task 6 の「移行前の未入金の注文（Session ID なし）は…送信済みとして登録する」と Task 15 の「…Session ID の無い古い注文は PaymentIntent で照合する」）
5. **要対応の欄を開いたまま、別の管理者が同じ要対応を解決する**: 後から押した方は 409 になり、二重に取り消さない（Task 6 の「…同じ要対応をもう一度解決すると resolved=false」と Task 17 の「別の管理者が先に解決していたら 409（二重に取り消さない）」）

---

## File Structure

| ファイル | 責務 |
|---|---|
| `supabase/migrations/20260927100000_add_order_payment_statuses.sql` | `order_status` に `payment_in_progress`・`abandoned` を足す（単独） |
| `supabase/migrations/20260927100100_order_payment_columns.sql` | `orders` の列（要確認・取消の理由・Session の作成時刻）、PaymentIntent の空を許す、Session ID の一意、不変条件トリガーの更新 |
| `supabase/migrations/20260927100200_release_stock_by_order.sql` | 明細ごとの確保中の数、注文 ID で引く在庫の戻し |
| `supabase/migrations/20260927100300_place_order_from_checkout_draft.sql` | 受付 RPC |
| `supabase/migrations/20260927100400_mark_order_payment_rpcs.sql` | 入金済み・入金待ちにする RPC、カートを空にする補助関数 |
| `supabase/migrations/20260927100500_payment_exceptions.sql` | 要対応の表と RPC、要確認の確認、メールの種類、発送止め、失敗注文の取消（理由付き）、移行前の未入金の送信権 |
| `supabase/migrations/20260927100600_checkout_session_expiry.sql` | 下書きの Session 失効時刻と、それを取る RPC |
| `supabase/migrations/20260927100700_item_checkout_guards.sql` | 商品を含む開いた決済の検索、削除できない理由の検索 |
| `supabase/migrations/20260927100800_retire_legacy_order_rpcs.sql` | 古い `release_stock_for_unpaid_order`・`finalize_order_from_checkout_draft`・`admin_cancel_failed_order(uuid, uuid)` を消す |
| `src/lib/orders/order-payment-types.ts` | 注文の状態・取消の理由・要対応の理由などの型と定数 |
| `src/lib/stripe/checkout-payment-decision.ts` | 判定表（純関数） |
| `src/lib/stripe/checkout-payment-reader.ts` | Stripe の Session と PaymentIntent を読み、判定に使う形にそろえて分類する |
| `src/lib/orders/order-lifecycle-emails.ts` | 期限切れ・取消・受付を通らない支払いの案内・店への要対応メール |
| `src/lib/orders/order-confirmation-email.ts` | （変更）入金確認の文面の出し分け |
| `src/lib/stripe/checkout-payment-reconciler.ts` | 照合関数（読む → 判定 → 反映 → 読み直し）と、要対応の記録・通知。依存は引数で受け取る |
| `src/lib/stripe/checkout-payment-reconciler-deps.ts` | 照合関数の既定の依存（Supabase の RPC、Stripe、メール、監査ログ）をつなぐ |
| `src/lib/stripe/checkout-session-expiry.ts` | （変更）Session ID で開いた Session を失効させる関数を足す |
| `src/lib/stripe/webhook-processor.ts` | （変更）決済系イベントを照合関数へ |
| `src/app/api/checkout/complete/route.ts` | （変更）確定 RPC を照合関数へ |
| `src/app/api/cron/expire-pending-orders/route.ts` | （変更）照合の見回り |
| `src/app/api/checkout/create-session/route.ts` | （変更）`expires_at` と冪等キー、コンビニの支払期限を定数から送る |
| `src/lib/constants/konbini.ts` | コンビニの支払期限の日数（create-session と /legal で共有。FREQ-106） |
| `src/app/legal/page.tsx` | （変更）コンビニの支払期限を定数から表示する（文は変わらない） |
| `src/app/api/admin/orders/[id]/status/route.ts` | （変更）取消の理由・メモ・お知らせ、新しい状態 |
| `src/app/api/admin/order-attention/route.ts` | 要対応・要確認の一覧と件数 |
| `src/app/api/admin/orders/[id]/review/route.ts` | 確認済みにする |
| `src/app/api/admin/payment-exceptions/[id]/resolve/route.ts` | 解決済みにする（注文の取消を含む） |
| `src/app/api/admin/orders/route.ts` | （変更）新しい状態の表示・要確認・発送止め・取消の可否・空の PaymentIntent |
| `src/app/api/admin/orders/[id]/refund/route.ts` | （変更）空の PaymentIntent |
| `src/app/api/admin/kpi/route.ts` | （変更）支払い手続き中・放棄を数えない |
| `src/app/api/orders/route.ts`・`src/app/api/orders/[id]/route.ts` | （変更）支払い手続き中・放棄を返さない |
| `src/components/AttentionInbox.tsx` | 要対応・要確認の欄 |
| `src/components/OrderCancelDialog.tsx` | 取消の画面（理由・メモ・お知らせ） |
| `src/components/OrderSection.tsx`・`src/components/AdminSideNav.tsx`・`src/app/admin/page.tsx` | （変更）一覧・件数・KPI の1行・ダイアログのつなぎ |
| `src/lib/items/item-checkout-guards.ts` | 商品の非公開・削除のときの決済の失効と、削除できない理由 |
| `src/lib/items/item-delete-guidance.ts` | 削除できない商品の案内の文（管理画面と API で共有） |
| `src/app/api/admin/items/[id]/route.ts`・`src/app/api/admin/items/route.ts`・`src/components/ItemSection.tsx` | （変更）①と R-44 |
| `supabase/pending/harden_order_state_transitions.sql`・`supabase/pending/schedule_expire_pending_orders.sql`・`supabase/pending/README.md` | （変更）R-04 の不足分、見回りを毎時に |
| `tests/integration/db/helpers/local-db.ts`・`tests/integration/db/helpers/order-fixtures.ts` | DB 結合テストの共通の入口と試験データ |

---

## Task 0: 前提をそろえる（ユーザーの判断が要る）

**Files:** なし

- [ ] **Step 1: 作業ツリーの扱いをユーザーに確かめる**

作業ツリーには、本計画が触るファイル（`src/lib/stripe/webhook-processor.ts`・`src/app/api/cron/expire-pending-orders/route.ts`・`src/lib/stripe/checkout-session-expiry.ts` は未追跡、`src/app/api/checkout/complete/route.ts` など多数は未コミットの変更あり）を含む、レビュー対象の差分が残っている。このまま各タスクでコミットすると、無関係の変更が混ざる。次の確認をしてから始める。

Run: `git status --porcelain | wc -l`
Expected: 0 に近い（数百なら未処理）

0 でなければ、ユーザーに「今の作業ツリーを基準としてコミットしてから始めてよいか」を尋ね、指示どおりにする。指示が無いまま Task 1 以降に進まない。

- [ ] **Step 2: ローカル DB を起動してテストが通る状態を確かめる**

Run:
```bash
docker inspect -f '{{.State.Health.Status}}' supabase_db_o_official
npx supabase start
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db --runInBand
```
Expected: `healthy`、db reset 成功、既存の DB 結合テストが全件 PASS（ディレクトリ全体は必ず `--runInBand` で1ファイルずつ流す。並列だと同じローカル DB を共有するファイルどうしが干渉して落ちる。既存の不安定さで、実装の不具合ではない）

- [ ] **Step 3: 本番の最新マイグレーションを確かめる**

Supabase MCP の `list_migrations`（project `pjidrgofvaglnuuznnyj`）を読み、最新が `20260925000303` のままであることを確かめる。新しいものがあれば、本計画の version（`20260927100000`〜）がそれより新しいことを確かめ、古ければ全ファイルの version を繰り上げる。

---

## Task 1: 注文の状態に「支払い手続き中」「放棄」を足す

**Files:**
- Create: `tests/integration/db/helpers/local-db.ts`
- Create: `tests/integration/db/order_payment_statuses.integration.test.ts`
- Create: `supabase/migrations/20260927100000_add_order_payment_statuses.sql`

**Interfaces:**
- Produces: `describeLocalDb(name: string, body: (getClient: () => PgClient) => void): void`、`connectLocalDb(): Promise<PgClient>`（2本目の接続。並行のテストが使う）、`LOCAL_DATABASE_URL: string | undefined`、`type PgClient`（以降の DB 結合テストが使う）。enum `public.order_status` の値 `payment_in_progress`・`abandoned`

- [ ] **Step 1: DB 結合テストの共通の入口を作る**

`tests/integration/db/helpers/local-db.ts`:
```ts
/**
 * DB 結合テストの共通の入口。
 *
 * 試験用の注文は削除禁止トリガーで消せないので、使い捨てのローカル DB でだけ動かす。
 * DATABASE_URL が無ければ skip、localhost 以外なら失敗させる（既存の DB 結合テストと同じ規則）。
 */
const { Client } = require('pg');

export type PgClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
  end: () => Promise<void>;
};

export const LOCAL_DATABASE_URL = process.env.DATABASE_URL;

export function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export async function connectLocalDb(): Promise<PgClient> {
  const client = new Client({ connectionString: LOCAL_DATABASE_URL });
  await client.connect();
  return client as PgClient;
}

export function describeLocalDb(name: string, body: (getClient: () => PgClient) => void): void {
  describe(name, () => {
    const url = LOCAL_DATABASE_URL;
    if (!url) {
      test.skip('DATABASE_URL 未設定のためスキップ', () => {});
      return;
    }
    if (!isLocalDatabase(url)) {
      test('使い捨ての DB 以外では実行しない', () => {
        throw new Error('消せない試験注文が残るため、localhost 以外の DATABASE_URL では実行しない');
      });
      return;
    }

    let client: PgClient;
    beforeAll(async () => {
      client = await connectLocalDb();
    });
    afterAll(async () => {
      if (client) await client.end();
    });

    body(() => client);
  });
}
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/integration/db/order_payment_statuses.integration.test.ts`:
```ts
/** @jest-environment node */
import { describeLocalDb } from './helpers/local-db';

/**
 * 注文の状態に「支払い手続き中」「放棄」を足す（グループ A 設計書 4-2・4-8）。
 *
 * 実行方法:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/order_payment_statuses
 */
describeLocalDb('integration: 注文の状態の値', (db) => {
  test('order_status は受付・入金・失敗・放棄・取消・発送の順に並ぶ', async () => {
    const res = await db().query(
      `select unnest(enum_range(null::public.order_status))::text as value`,
    );
    expect(res.rows.map((row) => row.value)).toEqual([
      'payment_in_progress',
      'pending',
      'paid',
      'failed',
      'abandoned',
      'cancelled',
      'shipped',
    ]);
  });
});
```

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/order_payment_statuses`
Expected: FAIL（`payment_in_progress` と `abandoned` が無い）

- [ ] **Step 4: マイグレーションを書く**

`supabase/migrations/20260927100000_add_order_payment_statuses.sql`:
```sql
-- 注文の状態に「支払い手続き中」と「放棄」を加える（グループ A 設計書 4-2・4-8）。
--
-- Postgres では、追加した enum の値はそのトランザクションをコミットするまで使えない。
-- 値を使う関数とは別のファイルに分ける。enum の値は後から消せない（Supabase: Managing Enums）。

BEGIN;

ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'payment_in_progress' BEFORE 'pending';
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'abandoned' AFTER 'failed';

COMMIT;
```

- [ ] **Step 5: ローカル DB に当ててテストを通す**

Run:
```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/order_payment_statuses
```
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add tests/integration/db/helpers/local-db.ts tests/integration/db/order_payment_statuses.integration.test.ts supabase/migrations/20260927100000_add_order_payment_statuses.sql
git commit -m "feat(db): 注文の状態に支払い手続き中と放棄を加える

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: 注文の列・Session ID の一意・PaymentIntent は空から値へ1回だけ

**Files:**
- Create: `tests/integration/db/order_payment_columns.integration.test.ts`
- Create: `supabase/migrations/20260927100100_order_payment_columns.sql`

**Interfaces:**
- Consumes: Task 1 の `describeLocalDb`
- Produces: `orders` の列 `review_reason`（`stock_not_reserved` のみ）・`review_marked_at`・`reviewed_at`・`reviewed_by`・`cancel_reason`（`stock_unavailable`/`customer_request`/`suspected_fraud`/`other`）・`cancel_note`（500文字まで）・`cancel_notify_customer`・`checkout_session_created_at`。制約 `orders_checkout_session_id_key`。`payment_intent_id` は NULL 可

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/db/order_payment_columns.integration.test.ts`:
```ts
/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';

/**
 * 受付を先にする方式の列と制約（グループ A 設計書 4-2）。
 *
 * PaymentIntent は Session の支払いの確定時にできる（Stripe API 2022-08-01 以降）ので、受付の時点では空。
 * 空から値へ1回だけ書け、値が入った後は法定の不変条件トリガーが変更を拒む。
 */
function suffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function insertOrder(
  db: PgClient,
  options: { status: string; checkoutSessionId?: string | null; paymentIntentId?: string | null },
): Promise<string> {
  const res = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, payment_intent_id, status,
        subtotal_amount, shipping_amount, total_amount, currency)
     values ($1, $2, $3, $4::public.order_status, 1000, 0, 1000, 'jpy')
     returning id`,
    [`cols-${suffix()}`, options.checkoutSessionId ?? null, options.paymentIntentId ?? null, options.status],
  );
  return res.rows[0].id as string;
}

describeLocalDb('integration: 注文の列と制約', (db) => {
  test('PaymentIntent が空の支払い手続き中の注文を作れる', async () => {
    const orderId = await insertOrder(db(), { status: 'payment_in_progress', checkoutSessionId: `cs_${suffix()}` });
    const res = await db().query('select payment_intent_id from public.orders where id = $1', [orderId]);
    expect(res.rows[0].payment_intent_id).toBeNull();
  });

  test('PaymentIntent は空から値へ1回だけ書け、その後は変えられない', async () => {
    const orderId = await insertOrder(db(), { status: 'payment_in_progress', checkoutSessionId: `cs_${suffix()}` });

    await db().query('update public.orders set payment_intent_id = $2 where id = $1', [orderId, `pi_${suffix()}`]);

    await expect(
      db().query('update public.orders set payment_intent_id = $2 where id = $1', [orderId, `pi_${suffix()}`]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      db().query('update public.orders set payment_intent_id = null where id = $1', [orderId]),
    ).rejects.toMatchObject({ code: '23001' });
  });

  test('Session ID は注文ごとに一意で、空は何件でもよい', async () => {
    const sessionId = `cs_${suffix()}`;
    await insertOrder(db(), { status: 'payment_in_progress', checkoutSessionId: sessionId });
    await expect(
      insertOrder(db(), { status: 'payment_in_progress', checkoutSessionId: sessionId }),
    ).rejects.toMatchObject({ code: '23505' });

    await insertOrder(db(), { status: 'pending', paymentIntentId: `pi_${suffix()}` });
    await insertOrder(db(), { status: 'pending', paymentIntentId: `pi_${suffix()}` });
  });

  test('要確認と取消の理由は決まった値だけ入る', async () => {
    const orderId = await insertOrder(db(), { status: 'paid', paymentIntentId: `pi_${suffix()}` });

    await db().query(`update public.orders set review_reason = 'stock_not_reserved' where id = $1`, [orderId]);
    await expect(
      db().query(`update public.orders set review_reason = 'other' where id = $1`, [orderId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db().query(`update public.orders set cancel_reason = 'mistake' where id = $1`, [orderId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db().query(`update public.orders set cancel_note = repeat('あ', 501) where id = $1`, [orderId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('今までの法定の項目（金額など）は変えられないまま', async () => {
    const orderId = await insertOrder(db(), { status: 'paid', paymentIntentId: `pi_${suffix()}` });
    await expect(
      db().query('update public.orders set total_amount = 1 where id = $1', [orderId]),
    ).rejects.toMatchObject({ code: '23001' });
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/order_payment_columns`
Expected: FAIL（`payment_intent_id` の NOT NULL 違反など）

- [ ] **Step 3: マイグレーションを書く**

`supabase/migrations/20260927100100_order_payment_columns.sql`:
```sql
-- 受付を先にする方式の列と制約（グループ A 設計書 4-2）。

BEGIN;

-- PaymentIntent は Session の支払いの確定時にできる（Stripe API 2022-08-01 以降）ので、受付の時点では空。
ALTER TABLE public.orders ALTER COLUMN payment_intent_id DROP NOT NULL;

-- 照合は Session ID で注文を引く。UNIQUE は NULL どうしを区別するので、空は何件でもよい。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'orders_checkout_session_id_key'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_checkout_session_id_key UNIQUE (checkout_session_id);
  END IF;
END
$$;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS review_reason text
    CONSTRAINT orders_review_reason_check CHECK (review_reason IN ('stock_not_reserved')),
  ADD COLUMN IF NOT EXISTS review_marked_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS cancel_reason text
    CONSTRAINT orders_cancel_reason_check
    CHECK (cancel_reason IN ('stock_unavailable', 'customer_request', 'suspected_fraud', 'other')),
  ADD COLUMN IF NOT EXISTS cancel_note text
    CONSTRAINT orders_cancel_note_length_check CHECK (pg_catalog.char_length(cancel_note) <= 500),
  ADD COLUMN IF NOT EXISTS cancel_notify_customer boolean,
  ADD COLUMN IF NOT EXISTS checkout_session_created_at timestamptz;

COMMENT ON COLUMN public.orders.checkout_session_created_at IS
  'Stripe の Checkout Session を作った時刻。見回りが「開いてから30分を超えたか」を判定する（設計書 2-2）';

-- 法定の不変条件。PaymentIntent は空から値へ1回だけ書ける。それ以外の項目は今までどおり変えられない。
CREATE OR REPLACE FUNCTION private.protect_legal_order_immutable_fields()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'pg_catalog'
  AS $function$
BEGIN
  IF OLD.payment_intent_id IS NOT NULL
     AND NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id THEN
    RAISE EXCEPTION 'immutable legal order fields cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF ROW(
    OLD.id,
    OLD.session_id,
    OLD.checkout_session_id,
    OLD.subtotal_amount,
    OLD.shipping_amount,
    OLD.discount_amount,
    OLD.total_amount,
    OLD.currency,
    OLD.shipping_email,
    OLD.shipping_full_name,
    OLD.shipping_postal_code,
    OLD.shipping_prefecture,
    OLD.shipping_city,
    OLD.shipping_address,
    OLD.shipping_building,
    OLD.shipping_phone,
    OLD.shipping_kana,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.session_id,
    NEW.checkout_session_id,
    NEW.subtotal_amount,
    NEW.shipping_amount,
    NEW.discount_amount,
    NEW.total_amount,
    NEW.currency,
    NEW.shipping_email,
    NEW.shipping_full_name,
    NEW.shipping_postal_code,
    NEW.shipping_prefecture,
    NEW.shipping_city,
    NEW.shipping_address,
    NEW.shipping_building,
    NEW.shipping_phone,
    NEW.shipping_kana,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'immutable legal order fields cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;
```

- [ ] **Step 4: ローカル DB に当ててテストを通す**

Run:
```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/order_payment_columns tests/integration/db/order_shipping_kana
```
Expected: 両方 PASS（`order_shipping_kana` はフリガナの不変条件が残っていることの確認）

- [ ] **Step 5: コミット**

```bash
git add tests/integration/db/order_payment_columns.integration.test.ts supabase/migrations/20260927100100_order_payment_columns.sql
git commit -m "feat(db): 受付を先にするための注文の列と一意制約を足す

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: 注文 ID で引いて、確保した分だけ在庫を戻す RPC

**Files:**
- Create: `tests/integration/db/helpers/order-fixtures.ts`
- Create: `tests/integration/db/release_stock_by_order.integration.test.ts`
- Create: `supabase/migrations/20260927100200_release_stock_by_order.sql`

**Interfaces:**
- Consumes: Task 1・2
- Produces:
  - SQL `private.order_line_reservations(_order_id uuid) → table(order_item_id uuid, variant_id bigint, quantity integer, reserved integer)`
  - SQL `public.release_stock_for_unpaid_order(_order_id uuid, _expected_status order_status, _next_status order_status, _change_reason text, _actor_id uuid default null, _source_event_id text default null, _cancel_reason text default null, _cancel_note text default null, _notify_customer boolean default null) → table(released boolean, order_id uuid, status order_status)`（旧定義 `(text, order_status)` は Task 22 まで残す）
  - TS（テスト用）`createCatalogFixture`・`createDraft`・`insertOrderWithStockLine`・`movementsOf`・`variantStock`・`orderRow`・`revisionsOf`・`uniqueSuffix`

- [ ] **Step 1: 試験データの共通関数を書く**

`tests/integration/db/helpers/order-fixtures.ts`:
```ts
import type { PgClient } from './local-db';

/** DB 結合テストの試験データ。本計画の Task 3〜7・21 が使う。 */
export const PRICE = 5000;

export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 商品・色・サイズ・バリアントを作り、在庫を台帳の restock で入れる。
 * バリアントは初期在庫を持てない（トリガーが拒否する）ので、在庫は台帳から入れる。
 */
export async function createCatalogFixture(
  db: PgClient,
  options: { stock: number; itemStatus?: 'published' | 'private'; isActive?: boolean } = { stock: 0 },
): Promise<{ itemId: number; variantId: number; colorName: string; sizeLabel: string }> {
  const suffix = uniqueSuffix();
  const colorName = 'BLACK';
  const sizeLabel = 'M';
  const item = await db.query(
    `insert into public.items (name, description, price, category, image_url, status)
     values ('fx-' || $1::text, '照合テスト', $2, 'TOPS', 'https://example.com/item.png', $3)
     returning id`,
    [suffix, PRICE, options.itemStatus ?? 'published'],
  );
  const itemId = Number(item.rows[0].id);
  const color = await db.query(
    `insert into public.item_colors (item_id, name, hex, position) values ($1, $2, '#000000', 0) returning id`,
    [itemId, colorName],
  );
  const size = await db.query(
    `insert into public.item_sizes (item_id, label, position) values ($1, $2, 0) returning id`,
    [itemId, sizeLabel],
  );
  const variant = await db.query(
    `insert into public.item_variants (item_id, color_id, size_id, is_active) values ($1, $2, $3, $4) returning id`,
    [itemId, color.rows[0].id, size.rows[0].id, options.isActive ?? true],
  );
  const variantId = Number(variant.rows[0].id);
  if (options.stock > 0) {
    await db.query(
      `insert into public.stock_movements (variant_id, delta, reason, note) values ($1, $2, 'restock', 'fixture')`,
      [variantId, options.stock],
    );
  }
  return { itemId, variantId, colorName, sizeLabel };
}

type DraftLine = { quantity: number; colorName?: string | null; sizeLabel?: string | null };

/**
 * Session を付けた下書き（status = created）を作る。明細ごとにカートの行も作り、写しの source_cart_id で結ぶ。
 * カートは session・商品・色・サイズで一意（idx_carts_unique_per_user_session_item）なので、色・サイズが同じ明細は
 * カートの行を1つにまとめ（数量は明細の合計）、同じ source_cart_id を持たせる。
 * lines を省くと quantity・colorName・sizeLabel の1明細になる。色・サイズの既定は BLACK・M（createCatalogFixture と同じ）。
 */
export async function createDraft(
  db: PgClient,
  options: {
    itemId: number;
    quantity?: number;
    colorName?: string | null;
    sizeLabel?: string | null;
    lines?: DraftLine[];
    kanaName?: string | null;
  },
): Promise<{ draftId: string; cartSessionId: string; checkoutSessionId: string; cartId: string; totalAmount: number }> {
  const suffix = uniqueSuffix();
  const cartSessionId = `fx-session-${suffix}`;
  const checkoutSessionId = `cs_fx_${suffix}`;
  const lines: DraftLine[] = options.lines ?? [
    { quantity: options.quantity ?? 1, colorName: options.colorName, sizeLabel: options.sizeLabel },
  ];
  const colorOf = (line: DraftLine) => (line.colorName === undefined ? 'BLACK' : line.colorName);
  const sizeOf = (line: DraftLine) => (line.sizeLabel === undefined ? 'M' : line.sizeLabel);
  const totalAmount = lines.reduce((sum, line) => sum + PRICE * line.quantity, 0);

  // 一意インデックスは空の色・サイズを '' とみなすので、まとめるキーも同じにそろえる
  const cartKeyOf = (line: DraftLine) => `${colorOf(line) ?? ''}|${sizeOf(line) ?? ''}`;
  const cartQuantityByKey = new Map<string, number>();
  for (const line of lines) {
    const key = cartKeyOf(line);
    cartQuantityByKey.set(key, (cartQuantityByKey.get(key) ?? 0) + line.quantity);
  }
  const cartIdByKey = new Map<string, string>();
  for (const line of lines) {
    const key = cartKeyOf(line);
    if (cartIdByKey.has(key)) continue;
    const cart = await db.query(
      `insert into public.carts (session_id, item_id, quantity, color, size) values ($1, $2, $3, $4, $5) returning id`,
      [cartSessionId, options.itemId, cartQuantityByKey.get(key), colorOf(line), sizeOf(line)],
    );
    cartIdByKey.set(key, cart.rows[0].id as string);
  }
  const cartIds = lines.map((line) => cartIdByKey.get(cartKeyOf(line)) as string);

  const draft = await db.query(
    `insert into public.checkout_drafts
       (session_id, checkout_session_id, payment_method, subtotal_amount, shipping_amount, discount_amount,
        total_amount, currency, shipping_snapshot, items_snapshot)
     values ($1, $2, 'stripe_card', $3, 0, 0, $3, 'jpy', $4::jsonb, $5::jsonb)
     returning id`,
    [
      cartSessionId,
      checkoutSessionId,
      totalAmount,
      JSON.stringify({
        email: 'fixture@example.com',
        fullName: '山田 花子',
        kanaName: options.kanaName === undefined ? 'ヤマダ ハナコ' : options.kanaName,
        postalCode: '1500001',
        prefecture: '東京都',
        city: '渋谷区',
        address: '神宮前1-1-1',
        building: null,
        phone: '0311112222',
      }),
      JSON.stringify(
        lines.map((line, index) => ({
          item_id: options.itemId,
          item_name: '照合テスト',
          item_price: PRICE,
          item_image_url: 'https://example.com/item.png',
          color: colorOf(line),
          size: sizeOf(line),
          quantity: line.quantity,
          line_total: PRICE * line.quantity,
          source_cart_id: cartIds[index],
        })),
      ),
    ],
  );
  return { draftId: draft.rows[0].id as string, cartSessionId, checkoutSessionId, cartId: cartIds[0], totalAmount };
}

/**
 * 在庫扱いの明細を1行持つ注文を直接作る。reserved = true なら台帳に確保（purchase）も入れる。
 * reserved = false は「種類の欄を足したときに既定値で stock になった古い明細」（R-41）を再現する。
 */
export async function insertOrderWithStockLine(
  db: PgClient,
  options: {
    status: string;
    itemId: number;
    variantId: number;
    quantity: number;
    reserved: boolean;
    checkoutSessionId?: string | null;
    paymentIntentId?: string | null;
  },
): Promise<{ orderId: string; orderItemId: string }> {
  const suffix = uniqueSuffix();
  // 配送先は法定の不変条件で後から書き換えられないので、発送できる形で最初から入れる。
  const order = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, payment_intent_id, status,
        subtotal_amount, shipping_amount, total_amount, currency,
        shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture,
        shipping_city, shipping_address, shipping_phone)
     values ($1, $2, $3, $4::public.order_status, $5, 0, $5, 'jpy',
             'fixture@example.com', '山田 花子', '1500001', '東京都', '渋谷区', '神宮前1-1-1', '0311112222')
     returning id`,
    [
      `fx-order-${suffix}`,
      options.checkoutSessionId === undefined ? `cs_fx_${suffix}` : options.checkoutSessionId,
      options.paymentIntentId ?? null,
      options.status,
      PRICE * options.quantity,
    ],
  );
  const orderId = order.rows[0].id as string;
  const line = await db.query(
    `insert into public.order_items
       (order_id, item_id, item_name, item_price, quantity, line_total, variant_id, fulfillment_type)
     values ($1, $2, '照合テスト', $3, $4, $5, $6, 'stock')
     returning id`,
    [orderId, options.itemId, PRICE, options.quantity, PRICE * options.quantity, options.variantId],
  );
  const orderItemId = line.rows[0].id as string;
  if (options.reserved) {
    await db.query(
      `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
       values ($1, $2, 'purchase', $3, $4)`,
      [options.variantId, -options.quantity, orderId, orderItemId],
    );
  }
  return { orderId, orderItemId };
}

export async function movementsOf(db: PgClient, variantId: number): Promise<Array<{ delta: number; reason: string }>> {
  const res = await db.query(
    'select delta, reason from public.stock_movements where variant_id = $1 order by id',
    [variantId],
  );
  return res.rows.map((row) => ({ delta: Number(row.delta), reason: row.reason as string }));
}

export async function variantStock(db: PgClient, variantId: number): Promise<number> {
  const res = await db.query('select stock_quantity from public.item_variants where id = $1', [variantId]);
  return Number(res.rows[0].stock_quantity);
}

export async function orderRow(db: PgClient, orderId: string): Promise<Record<string, any>> {
  const res = await db.query(
    `select status::text as status, payment_intent_id, cancel_reason, cancel_note, cancel_notify_customer,
            review_reason, reviewed_at, reviewed_by, total_amount, discount_amount, checkout_session_created_at
     from public.orders where id = $1`,
    [orderId],
  );
  return res.rows[0];
}

export async function revisionsOf(
  db: PgClient,
  orderId: string,
): Promise<Array<{ reason: string | null; sourceEventId: string | null; changedBy: string | null }>> {
  const res = await db.query(
    `select reason, source_event_id, changed_by from public.order_revisions where order_id = $1 order by id`,
    [orderId],
  );
  return res.rows.map((row) => ({
    reason: row.reason,
    sourceEventId: row.source_event_id,
    changedBy: row.changed_by,
  }));
}
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/integration/db/release_stock_by_order.integration.test.ts`:
```ts
/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import {
  createCatalogFixture,
  insertOrderWithStockLine,
  movementsOf,
  orderRow,
  revisionsOf,
  uniqueSuffix,
  variantStock,
} from './helpers/order-fixtures';

/**
 * 在庫を戻す RPC（設計書 4-1・4-5）。注文 ID で引き、明細ごとに確保した分だけ戻す（R-41）。
 * 実行者・理由・起因イベントを注文履歴に残す（R-18・R-43）。
 */
const ACTOR = '00000000-0000-4000-8000-000000000001';

function release(
  db: PgClient,
  args: {
    orderId: string;
    expected: string;
    next: string;
    reason?: string;
    actor?: string | null;
    event?: string | null;
    cancelReason?: string | null;
    note?: string | null;
    notify?: boolean | null;
  },
) {
  return db.query(
    `select released, status::text as status
     from public.release_stock_for_unpaid_order(
       $1::uuid, $2::public.order_status, $3::public.order_status, $4::text,
       $5::uuid, $6::text, $7::text, $8::text, $9::boolean)`,
    [
      args.orderId,
      args.expected,
      args.next,
      args.reason ?? 'stripe_checkout_expired',
      args.actor ?? null,
      args.event ?? null,
      args.cancelReason ?? null,
      args.note ?? null,
      args.notify ?? null,
    ],
  );
}

describeLocalDb('integration: 注文 ID で引いて在庫を戻す', (db) => {
  test('支払い手続き中を放棄にし、確保した分だけ台帳へ戻して、履歴に理由と起因イベントを残す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 2, reserved: true,
    });
    expect(await variantStock(db(), fx.variantId)).toBe(3);

    const res = await release(db(), { orderId, expected: 'payment_in_progress', next: 'abandoned', event: 'evt_expired_1' });

    expect(res.rows[0]).toEqual({ released: true, status: 'abandoned' });
    expect(await variantStock(db(), fx.variantId)).toBe(5);
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 5, reason: 'restock' },
      { delta: -2, reason: 'purchase' },
      { delta: 2, reason: 'cancel' },
    ]);
    expect(await revisionsOf(db(), orderId)).toEqual([
      { reason: 'stripe_checkout_expired', sourceEventId: 'evt_expired_1', changedBy: null },
    ]);
  });

  test('確保の記録が無い古い明細は戻さない（R-41）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'pending', itemId: fx.itemId, variantId: fx.variantId, quantity: 2, reserved: false,
      checkoutSessionId: null, paymentIntentId: `pi_${uniqueSuffix()}`,
    });

    const res = await release(db(), { orderId, expected: 'pending', next: 'failed', reason: 'stripe_voucher_expired' });

    expect(res.rows[0]).toEqual({ released: true, status: 'failed' });
    expect(await variantStock(db(), fx.variantId)).toBe(1);
    expect(await movementsOf(db(), fx.variantId)).toEqual([{ delta: 1, reason: 'restock' }]);
  });

  test('2回呼んでも2回目は released=false で、台帳は1回分だけ', async () => {
    const fx = await createCatalogFixture(db(), { stock: 3 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
    });

    await release(db(), { orderId, expected: 'payment_in_progress', next: 'abandoned' });
    const second = await release(db(), { orderId, expected: 'payment_in_progress', next: 'abandoned' });

    expect(second.rows[0]).toEqual({ released: false, status: 'abandoned' });
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 3, reason: 'restock' },
      { delta: -1, reason: 'purchase' },
      { delta: 1, reason: 'cancel' },
    ]);
  });

  test('入金待ちからは放棄にできない（払込票を発行済みのため）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'pending', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
    });
    await expect(release(db(), { orderId, expected: 'pending', next: 'abandoned' }))
      .rejects.toMatchObject({ code: '22023', message: expect.stringContaining('ABANDON_REQUIRES_PAYMENT_IN_PROGRESS') });
    expect((await orderRow(db(), orderId)).status).toBe('pending');
  });

  test('取消は実行者と理由が要り、理由・メモ・お知らせの有無と実行者が残る', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
    });

    await expect(release(db(), { orderId, expected: 'payment_in_progress', next: 'cancelled' }))
      .rejects.toMatchObject({ code: '22023', message: expect.stringContaining('CANCEL_REQUIRES_ACTOR_AND_REASON') });

    const res = await release(db(), {
      orderId, expected: 'payment_in_progress', next: 'cancelled', reason: 'admin_cancel',
      actor: ACTOR, cancelReason: 'customer_request', note: '電話で依頼', notify: false,
    });

    expect(res.rows[0]).toEqual({ released: true, status: 'cancelled' });
    expect(await orderRow(db(), orderId)).toMatchObject({
      status: 'cancelled', cancel_reason: 'customer_request', cancel_note: '電話で依頼', cancel_notify_customer: false,
    });
    expect(await revisionsOf(db(), orderId)).toEqual([
      { reason: 'admin_cancel', sourceEventId: null, changedBy: ACTOR },
    ]);
  });

  test('取消の理由が「その他」ならメモが要る', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
    });

    await expect(release(db(), {
      orderId, expected: 'payment_in_progress', next: 'cancelled', reason: 'admin_cancel',
      actor: ACTOR, cancelReason: 'other', note: '  ', notify: true,
    })).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('CANCEL_NOTE_REQUIRED') });
    expect((await orderRow(db(), orderId)).status).toBe('payment_in_progress');
  });

  test('期待する状態と違えば何もしない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'paid', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });
    const res = await release(db(), { orderId, expected: 'pending', next: 'failed' });
    expect(res.rows[0]).toEqual({ released: false, status: 'paid' });
    expect(await variantStock(db(), fx.variantId)).toBe(0);
  });

  test.each([['pending'], ['paid'], ['shipped'], ['payment_in_progress'], [null]])(
    '行き先 %s は拒否し、注文も在庫も変えない',
    async (next) => {
      const fx = await createCatalogFixture(db(), { stock: 1 });
      const { orderId } = await insertOrderWithStockLine(db(), {
        status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
      });

      await expect(release(db(), { orderId, expected: 'payment_in_progress', next: next as string }))
        .rejects.toMatchObject({ code: '22023', message: expect.stringContaining('INVALID_NEXT_STATUS') });
      expect((await orderRow(db(), orderId)).status).toBe('payment_in_progress');
      expect(await variantStock(db(), fx.variantId)).toBe(0);
    },
  );

  test('anon・authenticated は実行できない', async () => {
    const signature =
      'public.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)';
    for (const role of ['anon', 'authenticated']) {
      const res = await db().query('select has_function_privilege($1, $2, $3) as allowed', [role, signature, 'EXECUTE']);
      expect(res.rows[0].allowed).toBe(false);
    }
  });
});
```

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/release_stock_by_order`
Expected: FAIL（`function public.release_stock_for_unpaid_order(uuid, ...) does not exist`）

- [ ] **Step 4: マイグレーションを書く**

`supabase/migrations/20260927100200_release_stock_by_order.sql`:
```sql
-- 注文 ID で引いて、確保した分だけ在庫を戻す（グループ A 設計書 4-1・4-5・4-7）。
--
-- 支払い手続き中の注文は PaymentIntent を持たないので、注文 ID で引く。
-- 旧定義 release_stock_for_unpaid_order(text, order_status) は、呼び出し元を切り替えた後の
-- Task 22 で消す（20260927100800_retire_legacy_order_rpcs.sql）。

BEGIN;

-- 明細ごとの「確保中の数」。台帳の確保（purchase）と戻し（cancel）を足して符号を反転する。
-- 種類の欄（stock / backorder）の既定値は信用しない（R-41: 古い明細は確保の記録が無いまま stock）。
CREATE OR REPLACE FUNCTION private.order_line_reservations(_order_id uuid)
RETURNS TABLE (order_item_id uuid, variant_id bigint, quantity integer, reserved integer)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT oi.id,
         oi.variant_id,
         oi.quantity,
         GREATEST(0, -COALESCE((
           SELECT pg_catalog.sum(m.delta)
           FROM public.stock_movements AS m
           WHERE m.order_item_id = oi.id
             AND m.reason IN ('purchase', 'cancel')
         ), 0))::integer
  FROM public.order_items AS oi
  WHERE oi.order_id = _order_id;
$$;

REVOKE ALL ON FUNCTION private.order_line_reservations(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.release_stock_for_unpaid_order(
  _order_id uuid,
  _expected_status public.order_status,
  _next_status public.order_status,
  _change_reason text,
  _actor_id uuid DEFAULT NULL,
  _source_event_id text DEFAULT NULL,
  _cancel_reason text DEFAULT NULL,
  _cancel_note text DEFAULT NULL,
  _notify_customer boolean DEFAULT NULL
)
RETURNS TABLE (released boolean, order_id uuid, status public.order_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  updated_id uuid;
BEGIN
  IF _order_id IS NULL OR _change_reason IS NULL OR pg_catalog.btrim(_change_reason) = '' THEN
    RAISE EXCEPTION 'RELEASE_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _expected_status IS NULL
     OR _expected_status NOT IN ('payment_in_progress'::public.order_status, 'pending'::public.order_status) THEN
    RAISE EXCEPTION 'INVALID_EXPECTED_STATUS:%', _expected_status USING ERRCODE = '22023';
  END IF;

  IF _next_status IS NULL
     OR _next_status NOT IN (
       'failed'::public.order_status, 'abandoned'::public.order_status, 'cancelled'::public.order_status
     ) THEN
    RAISE EXCEPTION 'INVALID_NEXT_STATUS:%', _next_status USING ERRCODE = '22023';
  END IF;

  -- 放棄は「決済画面が一度も完了しなかった」注文だけ。払込票を発行した入金待ちは放棄にしない。
  IF _next_status = 'abandoned'::public.order_status
     AND _expected_status <> 'payment_in_progress'::public.order_status THEN
    RAISE EXCEPTION 'ABANDON_REQUIRES_PAYMENT_IN_PROGRESS' USING ERRCODE = '22023';
  END IF;

  -- 取消は人の判断なので、実行者と理由を必ず残す（R-18）。「その他」はメモも要る（設計書 5-2）。
  IF _next_status = 'cancelled'::public.order_status
     AND (_actor_id IS NULL
          OR _cancel_reason IS NULL
          OR _cancel_reason NOT IN ('stock_unavailable', 'customer_request', 'suspected_fraud', 'other')) THEN
    RAISE EXCEPTION 'CANCEL_REQUIRES_ACTOR_AND_REASON' USING ERRCODE = '22023';
  END IF;

  IF _next_status = 'cancelled'::public.order_status
     AND _cancel_reason = 'other'
     AND NULLIF(pg_catalog.btrim(_cancel_note), '') IS NULL THEN
    RAISE EXCEPTION 'CANCEL_NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', COALESCE(_actor_id::text, ''), true);
  PERFORM pg_catalog.set_config('app.order_change_reason', _change_reason, true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', COALESCE(_source_event_id, ''), true);

  UPDATE public.orders AS o
  SET status = _next_status,
      cancel_reason = CASE
        WHEN _next_status = 'cancelled'::public.order_status THEN _cancel_reason ELSE o.cancel_reason
      END,
      cancel_note = CASE
        WHEN _next_status = 'cancelled'::public.order_status
          THEN NULLIF(pg_catalog.btrim(_cancel_note), '')
        ELSE o.cancel_note
      END,
      cancel_notify_customer = CASE
        WHEN _next_status = 'cancelled'::public.order_status THEN _notify_customer ELSE o.cancel_notify_customer
      END
  WHERE o.id = _order_id
    AND o.status = _expected_status
  RETURNING o.id INTO updated_id;

  IF updated_id IS NULL THEN
    RETURN QUERY SELECT false, _order_id, o.status FROM public.orders AS o WHERE o.id = _order_id;
    RETURN;
  END IF;

  -- バリアントを id 昇順でロックする（受付・入金済みにする処理と同じ順）。
  PERFORM 1
  FROM public.item_variants AS v
  WHERE v.id IN (
    SELECT r.variant_id
    FROM private.order_line_reservations(updated_id) AS r
    WHERE r.variant_id IS NOT NULL AND r.reserved > 0
  )
  ORDER BY v.id
  FOR UPDATE;

  -- 確保した分だけを戻す（R-41）。状態を条件に更新しているので、同じ注文で二度は走らない。
  INSERT INTO public.stock_movements (variant_id, delta, reason, order_id, order_item_id, note, created_by)
  SELECT r.variant_id, r.reserved, 'cancel', updated_id, r.order_item_id, _change_reason, _actor_id
  FROM private.order_line_reservations(updated_id) AS r
  WHERE r.variant_id IS NOT NULL AND r.reserved > 0
  ORDER BY r.variant_id, r.order_item_id;

  RETURN QUERY SELECT true, updated_id, _next_status;
END;
$$;

REVOKE ALL ON FUNCTION public.release_stock_for_unpaid_order(
  uuid, public.order_status, public.order_status, text, uuid, text, text, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_stock_for_unpaid_order(
  uuid, public.order_status, public.order_status, text, uuid, text, text, text, boolean
) TO service_role;

COMMIT;
```

- [ ] **Step 5: ローカル DB に当ててテストを通す**

Run:
```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/release_stock_by_order tests/integration/db/release_stock_next_status
```
Expected: 両方 PASS（旧定義はまだ残っているので `release_stock_next_status` も通る）

- [ ] **Step 6: コミット**

```bash
git add tests/integration/db/helpers/order-fixtures.ts tests/integration/db/release_stock_by_order.integration.test.ts supabase/migrations/20260927100200_release_stock_by_order.sql
git commit -m "feat(db): 注文 ID で引いて確保した分だけ在庫を戻す RPC を足す

R-41（確保の記録が無い明細を戻さない）・R-18（実行者）・R-43（起因イベント）を満たす。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: 受付 RPC `place_order_from_checkout_draft`

**Files:**
- Create: `tests/integration/db/place_order_from_checkout_draft.integration.test.ts`
- Create: `supabase/migrations/20260927100300_place_order_from_checkout_draft.sql`

**Interfaces:**
- Consumes: Task 1〜3（`describeLocalDb`・`connectLocalDb`・`createCatalogFixture`・`createDraft`・`movementsOf`・`variantStock`・`orderRow`）
- Produces: SQL `public.place_order_from_checkout_draft(_draft_id uuid, _checkout_session_id text, _cart_session_id text, _stripe_amount_total integer, _stripe_amount_discount integer, _stripe_currency text, _checkout_session_created_at timestamptz, _payment_intent_id text default null) → table(order_id uuid, order_status order_status, created boolean, rejection text)`。`rejection` は `draft_not_found`・`zero_amount`・`currency_mismatch`・`amount_mismatch`・`item_unavailable` のどれか（成功時は NULL）

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/db/place_order_from_checkout_draft.integration.test.ts`:
```ts
/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import {
  PRICE,
  createCatalogFixture,
  createDraft,
  movementsOf,
  orderRow,
  variantStock,
} from './helpers/order-fixtures';

/**
 * 受付 RPC（設計書 4-3）。注文を支払い手続き中で作り、在庫を確保する。
 * 金額・通貨は Stripe から取り直した Session の値を引数で受け取り、下書きと照らす。
 */
const SESSION_CREATED_AT = '2026-09-27T01:00:00.000Z';

function place(
  db: PgClient,
  args: {
    draftId: string;
    checkoutSessionId: string;
    cartSessionId: string;
    amountTotal: number;
    amountDiscount?: number;
    currency?: string;
    paymentIntentId?: string | null;
  },
) {
  return db.query(
    `select order_id, order_status::text as order_status, created, rejection
     from public.place_order_from_checkout_draft(
       $1::uuid, $2::text, $3::text, $4::integer, $5::integer, $6::text, $7::timestamptz, $8::text)`,
    [
      args.draftId,
      args.checkoutSessionId,
      args.cartSessionId,
      args.amountTotal,
      args.amountDiscount ?? 0,
      args.currency ?? 'jpy',
      SESSION_CREATED_AT,
      args.paymentIntentId ?? null,
    ],
  );
}

async function draftRow(db: PgClient, draftId: string) {
  const res = await db.query(
    'select status, total_amount, discount_amount, payment_intent_id from public.checkout_drafts where id = $1',
    [draftId],
  );
  return res.rows[0];
}

async function cartExists(db: PgClient, cartId: string): Promise<boolean> {
  const res = await db.query('select 1 from public.carts where id = $1', [cartId]);
  return res.rowCount > 0;
}

describeLocalDb('integration: 受付 RPC', (db) => {
  test('支払い手続き中の注文を作り、在庫を確保し、下書きを受付済みにする。カートは残す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 2 });

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    });

    expect(res.rows[0]).toMatchObject({ order_status: 'payment_in_progress', created: true, rejection: null });
    const order = await orderRow(db(), res.rows[0].order_id);
    expect(order).toMatchObject({ status: 'payment_in_progress', payment_intent_id: null, total_amount: PRICE * 2 });
    expect(new Date(order.checkout_session_created_at).toISOString()).toBe(SESSION_CREATED_AT);
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 5, reason: 'restock' },
      { delta: -2, reason: 'purchase' },
    ]);
    expect(await variantStock(db(), fx.variantId)).toBe(3);
    expect((await draftRow(db(), draft.draftId)).status).toBe('completed');
    expect(await cartExists(db(), draft.cartId)).toBe(true);
  });

  test('同じ Session で2回呼んでも注文は1件、在庫の確保も1回（二重送信・再読込）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const args = {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    };

    const first = await place(db(), args);
    const second = await place(db(), args);

    expect(second.rows[0]).toMatchObject({ order_id: first.rows[0].order_id, created: false, rejection: null });
    const count = await db().query('select count(*)::int as n from public.orders where checkout_session_id = $1', [
      draft.checkoutSessionId,
    ]);
    expect(count.rows[0].n).toBe(1);
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 5, reason: 'restock' },
      { delta: -1, reason: 'purchase' },
    ]);
  });

  test('在庫が足りない明細は受注生産にし、台帳は動かさない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 2 });

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    });

    const lines = await db().query('select fulfillment_type from public.order_items where order_id = $1', [
      res.rows[0].order_id,
    ]);
    expect(lines.rows.map((row) => row.fulfillment_type)).toEqual(['backorder']);
    expect(await variantStock(db(), fx.variantId)).toBe(1);
  });

  test('割引は Stripe の値で注文に入れ、下書きは割引額だけを書き戻す（R-26）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: PRICE - 1000,
      amountDiscount: 1000,
    });

    expect(await orderRow(db(), res.rows[0].order_id)).toMatchObject({
      total_amount: PRICE - 1000,
      discount_amount: 1000,
    });
    expect(await draftRow(db(), draft.draftId)).toMatchObject({ total_amount: PRICE, discount_amount: 1000 });
  });

  test('割引後の合計へ書き換え済みの古い下書きも受け付ける', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query('update public.checkout_drafts set total_amount = $2, discount_amount = 1000 where id = $1', [
      draft.draftId,
      PRICE - 1000,
    ]);

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: PRICE - 1000,
      amountDiscount: 1000,
    });

    expect(res.rows[0]).toMatchObject({ created: true, rejection: null });
  });

  test.each([
    ['別のお客様のセッション', { cartSessionId: 'someone-else' }, 'draft_not_found'],
    ['別の Session', { checkoutSessionId: 'cs_other' }, 'draft_not_found'],
    ['0円', { amountTotal: 0, amountDiscount: PRICE }, 'zero_amount'],
    ['通貨の違い', { currency: 'usd' }, 'currency_mismatch'],
    ['金額の違い', { amountTotal: PRICE + 1 }, 'amount_mismatch'],
  ])('%s は理由コードを返し、何も書かない', async (_label, override, rejection) => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
      ...override,
    });

    expect(res.rows[0]).toMatchObject({ order_id: null, created: false, rejection });
    expect((await draftRow(db(), draft.draftId)).status).toBe('created');
    expect(await movementsOf(db(), fx.variantId)).toEqual([{ delta: 1, reason: 'restock' }]);
  });

  test('受付済みの下書きは draft_not_found', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query(`update public.checkout_drafts set status = 'failed' where id = $1`, [draft.draftId]);

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    });

    expect(res.rows[0].rejection).toBe('draft_not_found');
  });

  test('非公開の商品と存在しない商品は item_unavailable', async () => {
    const hidden = await createCatalogFixture(db(), { stock: 1, itemStatus: 'private' });
    const hiddenDraft = await createDraft(db(), { itemId: hidden.itemId, quantity: 1 });
    const missing = await createCatalogFixture(db(), { stock: 1 });
    const missingDraft = await createDraft(db(), { itemId: missing.itemId, quantity: 1 });
    await db().query(
      `update public.checkout_drafts set items_snapshot = jsonb_set(items_snapshot, '{0,item_id}', '999999999') where id = $1`,
      [missingDraft.draftId],
    );

    for (const draft of [hiddenDraft, missingDraft]) {
      const res = await place(db(), {
        draftId: draft.draftId,
        checkoutSessionId: draft.checkoutSessionId,
        cartSessionId: draft.cartSessionId,
        amountTotal: draft.totalAmount,
      });
      expect(res.rows[0]).toMatchObject({ order_id: null, rejection: 'item_unavailable' });
    }
  });

  test('商品行は FOR KEY SHARE。カートの数量変更と非公開は待たせず、削除だけ待たせる（R-42）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const other = await connectLocalDb();
    try {
      await other.query(`set lock_timeout = '1s'`);
      await db().query('begin');
      await place(db(), {
        draftId: draft.draftId,
        checkoutSessionId: draft.checkoutSessionId,
        cartSessionId: draft.cartSessionId,
        amountTotal: draft.totalAmount,
      });

      await other.query('begin');
      await other.query('select id from public.items where id = $1 for share', [fx.itemId]);
      await other.query('rollback');
      await other.query(`update public.items set status = 'private' where id = $1`, [fx.itemId]);
      await expect(other.query('delete from public.items where id = $1', [fx.itemId])).rejects.toMatchObject({
        code: '55P03',
      });
    } finally {
      await db().query('rollback');
      await other.end();
    }
  });

  test('同じ Session の受付が並行しても、後発はロックを待ってから先発の注文を返す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const args = {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    };
    const other = await connectLocalDb();
    let committed = false;
    try {
      await db().query('begin');
      const first = await place(db(), args);
      // 後発は下書きの行ロックで待つ。先発のコミット後に、先発の注文を見つけて返す
      const second = place(other, args);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await db().query('commit');
      committed = true;

      expect((await second).rows[0]).toMatchObject({ order_id: first.rows[0].order_id, created: false, rejection: null });
    } finally {
      if (!committed) await db().query('rollback');
      await other.end();
    }
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 5, reason: 'restock' },
      { delta: -1, reason: 'purchase' },
    ]);
  });

  test('同じバリアントの明細が分かれていても、合算で在庫を判定する', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, lines: [{ quantity: 1 }, { quantity: 2 }] });

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    });

    const lines = await db().query('select fulfillment_type from public.order_items where order_id = $1', [
      res.rows[0].order_id,
    ]);
    // 合計 3 > 在庫 2 なので、明細を分けて確保せず、どちらも受注生産にする
    expect(lines.rows.map((row) => row.fulfillment_type)).toEqual(['backorder', 'backorder']);
    expect(await variantStock(db(), fx.variantId)).toBe(2);
  });

  test('停止中のバリアントは在庫があっても受注生産にする', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5, isActive: false });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    });

    const lines = await db().query('select fulfillment_type from public.order_items where order_id = $1', [
      res.rows[0].order_id,
    ]);
    expect(lines.rows[0].fulfillment_type).toBe('backorder');
    expect(await variantStock(db(), fx.variantId)).toBe(5);
  });

  test('対応するバリアントが無い色・サイズは variant_id が空のまま注文になる', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1, colorName: 'WHITE', sizeLabel: 'L' });

    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    });

    const lines = await db().query('select variant_id, fulfillment_type from public.order_items where order_id = $1', [
      res.rows[0].order_id,
    ]);
    expect(lines.rows).toEqual([{ variant_id: null, fulfillment_type: 'backorder' }]);
  });

  test('受注生産の注文を放棄にしても、台帳には何も書かない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const res = await place(db(), {
      draftId: draft.draftId,
      checkoutSessionId: draft.checkoutSessionId,
      cartSessionId: draft.cartSessionId,
      amountTotal: draft.totalAmount,
    });

    await db().query(
      `select released from public.release_stock_for_unpaid_order(
         $1::uuid, 'payment_in_progress', 'abandoned', 'stripe_checkout_expired')`,
      [res.rows[0].order_id],
    );

    expect(await movementsOf(db(), fx.variantId)).toEqual([]);
    expect(await variantStock(db(), fx.variantId)).toBe(0);
  });

  test('台帳の合計とバリアントの在庫がずれていない', async () => {
    const res = await db().query('select count(*)::int as mismatches from public.verify_stock_integrity()');
    expect(res.rows[0].mismatches).toBe(0);
  });

  test('anon・authenticated は実行できない', async () => {
    const signature =
      'public.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text)';
    for (const role of ['anon', 'authenticated']) {
      const res = await db().query('select has_function_privilege($1, $2, $3) as allowed', [role, signature, 'EXECUTE']);
      expect(res.rows[0].allowed).toBe(false);
    }
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/place_order_from_checkout_draft`
Expected: FAIL（`function public.place_order_from_checkout_draft(...) does not exist`）

- [ ] **Step 3: マイグレーションを書く**

`supabase/migrations/20260927100300_place_order_from_checkout_draft.sql`:
```sql
-- 受付 RPC（グループ A 設計書 4-3）。
--
-- 注文を「支払い手続き中」で作り、在庫を確保する。今の注文確定 RPC
-- finalize_order_from_checkout_draft を置き換える（旧 RPC は 20260927100800 で消す）。
-- 受付 API（F）と、照合関数の予備処理（受付を通らない支払い）の両方から呼ぶ。
-- 失敗は例外にせず理由コードで返す。お金が動く前なら画面が案内し（F）、動いた後なら要対応にする。

BEGIN;

CREATE OR REPLACE FUNCTION public.place_order_from_checkout_draft(
  _draft_id uuid,
  _checkout_session_id text,
  _cart_session_id text,
  _stripe_amount_total integer,
  _stripe_amount_discount integer,
  _stripe_currency text,
  _checkout_session_created_at timestamptz,
  _payment_intent_id text DEFAULT NULL
)
RETURNS TABLE (order_id uuid, order_status public.order_status, created boolean, rejection text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  draft_row public.checkout_drafts%ROWTYPE;
  existing_id uuid;
  existing_status public.order_status;
  inserted_id uuid;
BEGIN
  IF _draft_id IS NULL
     OR NULLIF(pg_catalog.btrim(_checkout_session_id), '') IS NULL
     OR NULLIF(pg_catalog.btrim(_cart_session_id), '') IS NULL
     OR _stripe_amount_total IS NULL
     OR _stripe_amount_discount IS NULL
     OR _stripe_amount_discount < 0
     OR NULLIF(pg_catalog.btrim(_stripe_currency), '') IS NULL
     OR _checkout_session_created_at IS NULL THEN
    RAISE EXCEPTION 'PLACE_ORDER_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- 同じ Session の注文が既にあれば、それを返す。在庫を二重に確保しない。
  SELECT o.id, o.status
  INTO existing_id, existing_status
  FROM public.orders AS o
  WHERE o.checkout_session_id = _checkout_session_id;

  IF existing_id IS NOT NULL THEN
    RETURN QUERY SELECT existing_id, existing_status, false, NULL::text;
    RETURN;
  END IF;

  SELECT d.*
  INTO draft_row
  FROM public.checkout_drafts AS d
  WHERE d.id = _draft_id
  FOR UPDATE;

  -- ロックを待つ間に、並行した受付が同じ Session の注文を作っていれば、それを返す。
  SELECT o.id, o.status
  INTO existing_id, existing_status
  FROM public.orders AS o
  WHERE o.checkout_session_id = _checkout_session_id;

  IF existing_id IS NOT NULL THEN
    RETURN QUERY SELECT existing_id, existing_status, false, NULL::text;
    RETURN;
  END IF;

  IF draft_row.id IS NULL
     OR draft_row.session_id IS DISTINCT FROM _cart_session_id
     OR draft_row.checkout_session_id IS DISTINCT FROM _checkout_session_id
     OR draft_row.status IS DISTINCT FROM 'created' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'draft_not_found'::text;
    RETURN;
  END IF;

  -- 0円の注文は受け付けない（FREQ-389）。
  IF _stripe_amount_total <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'zero_amount'::text;
    RETURN;
  END IF;

  IF pg_catalog.lower(draft_row.currency) <> pg_catalog.lower(_stripe_currency) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'currency_mismatch'::text;
    RETURN;
  END IF;

  -- 割引前どうしで比べる。今の下書きは割引前の合計を持ち、古い下書きは割引後の合計と割引額の組を
  -- 持つ。どちらも「合計 + 割引額」は割引前の額になる。
  IF draft_row.total_amount + COALESCE(draft_row.discount_amount, 0)
     <> _stripe_amount_total + _stripe_amount_discount THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'amount_mismatch'::text;
    RETURN;
  END IF;

  -- 商品行を id の昇順で FOR KEY SHARE でロックする（R-42）。
  -- FOR KEY SHARE と衝突するのは FOR UPDATE（削除など）だけ。カートの数量変更（FOR SHARE）とも
  -- 商品の非公開（キー以外の UPDATE）とも衝突しないので、ロック順が逆でもデッドロックしない。
  PERFORM 1
  FROM public.items AS i
  WHERE i.id IN (
    SELECT DISTINCT (e.value->>'item_id')::bigint
    FROM pg_catalog.jsonb_array_elements(draft_row.items_snapshot) AS e(value)
  )
  ORDER BY i.id
  FOR KEY SHARE;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(draft_row.items_snapshot) AS e(value)
    LEFT JOIN public.items AS i ON i.id = (e.value->>'item_id')::bigint
    WHERE i.id IS NULL OR i.status IS DISTINCT FROM 'published'
  ) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'item_unavailable'::text;
    RETURN;
  END IF;

  -- バリアントを id の昇順でロックする（商品の次。在庫を戻す処理・入金済みにする処理と同じ順）。
  PERFORM 1
  FROM public.item_variants AS v
  WHERE v.id IN (
    SELECT r.variant_id
    FROM public.resolve_checkout_item_variants(draft_row.items_snapshot) AS r
    WHERE r.variant_id IS NOT NULL
  )
  ORDER BY v.id
  FOR UPDATE;

  BEGIN
    INSERT INTO public.orders (
      session_id,
      checkout_session_id,
      payment_intent_id,
      status,
      subtotal_amount,
      shipping_amount,
      discount_amount,
      total_amount,
      currency,
      shipping_email,
      shipping_full_name,
      shipping_postal_code,
      shipping_prefecture,
      shipping_city,
      shipping_address,
      shipping_building,
      shipping_phone,
      shipping_kana,
      checkout_session_created_at
    ) VALUES (
      draft_row.session_id,
      _checkout_session_id,
      _payment_intent_id,
      'payment_in_progress'::public.order_status,
      draft_row.subtotal_amount,
      draft_row.shipping_amount,
      _stripe_amount_discount,
      _stripe_amount_total,
      draft_row.currency,
      draft_row.shipping_snapshot->>'email',
      draft_row.shipping_snapshot->>'fullName',
      draft_row.shipping_snapshot->>'postalCode',
      draft_row.shipping_snapshot->>'prefecture',
      draft_row.shipping_snapshot->>'city',
      draft_row.shipping_snapshot->>'address',
      draft_row.shipping_snapshot->>'building',
      draft_row.shipping_snapshot->>'phone',
      draft_row.shipping_snapshot->>'kanaName',
      _checkout_session_created_at
    )
    RETURNING id INTO inserted_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT o.id, o.status
      INTO existing_id, existing_status
      FROM public.orders AS o
      WHERE o.checkout_session_id = _checkout_session_id;
      IF existing_id IS NOT NULL THEN
        RETURN QUERY SELECT existing_id, existing_status, false, NULL::text;
        RETURN;
      END IF;
      RAISE;
  END;

  -- 明細を写しから作り、在庫で賄える明細だけ確保する（今の確定 RPC と同じ規則）。
  WITH resolved AS (
    SELECT * FROM public.resolve_checkout_item_variants(draft_row.items_snapshot)
  ),
  needed AS (
    SELECT r.variant_id, pg_catalog.sum(r.quantity)::integer AS quantity
    FROM resolved AS r
    WHERE r.variant_id IS NOT NULL
    GROUP BY r.variant_id
  ),
  covered AS (
    SELECT n.variant_id
    FROM needed AS n
    JOIN public.item_variants AS v ON v.id = n.variant_id
    WHERE v.is_active
      AND v.stock_quantity >= n.quantity
  ),
  inserted_items AS (
    INSERT INTO public.order_items (
      order_id, item_id, item_name, item_price, item_image_url, color, size,
      quantity, line_total, variant_id, fulfillment_type
    )
    SELECT inserted_id,
           r.item_id,
           r.item_name,
           r.item_price,
           r.item_image_url,
           r.color,
           r.size,
           r.quantity,
           r.line_total,
           r.variant_id,
           CASE
             WHEN r.variant_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM covered AS c WHERE c.variant_id = r.variant_id)
             THEN 'stock'
             ELSE 'backorder'
           END
    FROM resolved AS r
    ORDER BY r.line_no
    RETURNING id, variant_id, quantity, fulfillment_type
  )
  INSERT INTO public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
  SELECT i.variant_id, -i.quantity, 'purchase', inserted_id, i.id
  FROM inserted_items AS i
  WHERE i.fulfillment_type = 'stock'
    AND i.quantity > 0
  ORDER BY i.variant_id, i.id;

  -- 下書きは受付済みにする。割引額だけを書き戻し、合計は割引前のまま残す（R-26）。
  -- カートは消さない。支払いが済んだ時点で入金済み・入金待ちにする RPC が消す。
  UPDATE public.checkout_drafts AS d
  SET status = 'completed',
      discount_amount = _stripe_amount_discount,
      payment_intent_id = COALESCE(d.payment_intent_id, _payment_intent_id)
  WHERE d.id = _draft_id;

  RETURN QUERY SELECT inserted_id, 'payment_in_progress'::public.order_status, true, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.place_order_from_checkout_draft(
  uuid, text, text, integer, integer, text, timestamptz, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_order_from_checkout_draft(
  uuid, text, text, integer, integer, text, timestamptz, text
) TO service_role;

COMMIT;
```

- [ ] **Step 4: ローカル DB に当ててテストを通す**

Run:
```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/place_order_from_checkout_draft
```
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add tests/integration/db/place_order_from_checkout_draft.integration.test.ts supabase/migrations/20260927100300_place_order_from_checkout_draft.sql
git commit -m "feat(db): 注文を支払い手続き中で受け付けて在庫を確保する RPC を足す

商品行は FOR KEY SHARE でロックする（R-42）。金額は割引前どうしで照らし、
下書きへは割引額だけを書き戻す（R-26）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: 入金済み・入金待ちにする RPC

**Files:**
- Create: `tests/integration/db/mark_order_payment.integration.test.ts`
- Create: `supabase/migrations/20260927100400_mark_order_payment_rpcs.sql`

**Interfaces:**
- Consumes: Task 1 の `connectLocalDb`（並行のテストの2本目の接続）、Task 3 の `private.order_line_reservations`、Task 4 の受付 RPC、試験データの関数、既存の `public.claim_order_email(_order_id uuid, _kind text) → boolean`（`20260920064241_add_order_email_claims.sql`）
- Produces:
  - SQL `public.mark_order_paid(_order_id uuid, _expected_status order_status, _payment_intent_id text, _paid_amount integer, _paid_currency text, _source_event_id text default null) → table(updated boolean, amount_matches boolean, needs_review boolean)`。`_expected_status` は `payment_in_progress`・`pending`・`failed` のどれか
  - SQL `public.mark_order_awaiting_payment(_order_id uuid, _payment_intent_id text, _source_event_id text default null) → table(updated boolean)`
  - SQL `private.clear_cart_for_order(_order_id uuid) → void`
  - どちらも注文の PaymentIntent が空なら値を入れ、下書きの PaymentIntent も埋め（注文詳細の支払方法の表示が下書きを PaymentIntent で引くため）、カートを空にする

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/db/mark_order_payment.integration.test.ts`:
```ts
/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import {
  PRICE,
  createCatalogFixture,
  createDraft,
  insertOrderWithStockLine,
  movementsOf,
  orderRow,
  revisionsOf,
  uniqueSuffix,
  variantStock,
} from './helpers/order-fixtures';

/**
 * 入金済み・入金待ちにする RPC（設計書 4-1・4-5・⑤）。
 * 今の状態を条件にした更新で、先に動いていれば何もしない。在庫扱いで確保中が0の明細は確保し直し、
 * 足りなければ要確認にする。
 */
async function placeFromDraft(db: PgClient, options: { stock: number; quantity: number }) {
  const fx = await createCatalogFixture(db, { stock: options.stock });
  const draft = await createDraft(db, { itemId: fx.itemId, quantity: options.quantity });
  const res = await db.query(
    `select order_id from public.place_order_from_checkout_draft(
       $1::uuid, $2::text, $3::text, $4::integer, 0, 'jpy', now(), null)`,
    [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount],
  );
  return { fx, draft, orderId: res.rows[0].order_id as string };
}

function markPaid(
  db: PgClient,
  args: { orderId: string; expected: string; paymentIntentId: string; amount: number; currency?: string; event?: string },
) {
  return db.query(
    `select updated, amount_matches, needs_review
     from public.mark_order_paid($1::uuid, $2::public.order_status, $3::text, $4::integer, $5::text, $6::text)`,
    [args.orderId, args.expected, args.paymentIntentId, args.amount, args.currency ?? 'jpy', args.event ?? null],
  );
}

function markAwaiting(db: PgClient, args: { orderId: string; paymentIntentId: string; event?: string }) {
  return db.query(
    'select updated from public.mark_order_awaiting_payment($1::uuid, $2::text, $3::text)',
    [args.orderId, args.paymentIntentId, args.event ?? null],
  );
}

async function cartExists(db: PgClient, cartId: string): Promise<boolean> {
  const res = await db.query('select 1 from public.carts where id = $1', [cartId]);
  return res.rowCount > 0;
}

describeLocalDb('integration: 入金済み・入金待ちにする', (db) => {
  test('支払い手続き中を入金済みにし、PaymentIntent を埋め、カートを空にし、履歴に起因イベントを残す', async () => {
    const { draft, orderId } = await placeFromDraft(db(), { stock: 2, quantity: 1 });
    const pi = `pi_${uniqueSuffix()}`;

    const res = await markPaid(db(), { orderId, expected: 'payment_in_progress', paymentIntentId: pi, amount: PRICE, event: 'evt_paid_1' });

    expect(res.rows[0]).toEqual({ updated: true, amount_matches: true, needs_review: false });
    expect(await orderRow(db(), orderId)).toMatchObject({ status: 'paid', payment_intent_id: pi, review_reason: null });
    expect(await cartExists(db(), draft.cartId)).toBe(false);
    const draftPi = await db().query('select payment_intent_id from public.checkout_drafts where id = $1', [draft.draftId]);
    expect(draftPi.rows[0].payment_intent_id).toBe(pi);
    expect(await revisionsOf(db(), orderId)).toEqual([
      { reason: 'stripe_payment_paid', sourceEventId: 'evt_paid_1', changedBy: null },
    ]);
  });

  test('期待する状態と違えば何もしない（先に動いていた）', async () => {
    const { orderId } = await placeFromDraft(db(), { stock: 1, quantity: 1 });

    const res = await markPaid(db(), { orderId, expected: 'pending', paymentIntentId: `pi_${uniqueSuffix()}`, amount: PRICE });

    expect(res.rows[0]).toEqual({ updated: false, amount_matches: null, needs_review: null });
    expect((await orderRow(db(), orderId)).status).toBe('payment_in_progress');
  });

  test('支払額が注文と違っても入金済みにし、amount_matches=false を返す', async () => {
    const { orderId } = await placeFromDraft(db(), { stock: 1, quantity: 1 });

    const res = await markPaid(db(), { orderId, expected: 'payment_in_progress', paymentIntentId: `pi_${uniqueSuffix()}`, amount: PRICE - 1 });

    expect(res.rows[0]).toEqual({ updated: true, amount_matches: false, needs_review: false });
    expect((await orderRow(db(), orderId)).status).toBe('paid');
  });

  test('失敗の後の入金（⑤）は在庫を確保し直す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const pi = `pi_${uniqueSuffix()}`;
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
    });
    await db().query(
      `select released from public.release_stock_for_unpaid_order(
         $1::uuid, 'payment_in_progress', 'failed', 'stripe_voucher_expired')`,
      [orderId],
    );
    expect(await variantStock(db(), fx.variantId)).toBe(2);

    const res = await markPaid(db(), { orderId, expected: 'failed', paymentIntentId: pi, amount: PRICE });

    expect(res.rows[0]).toEqual({ updated: true, amount_matches: true, needs_review: false });
    expect(await variantStock(db(), fx.variantId)).toBe(1);
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 2, reason: 'restock' },
      { delta: -1, reason: 'purchase' },
      { delta: 1, reason: 'cancel' },
      { delta: -1, reason: 'purchase' },
    ]);
  });

  test('確保し直す在庫が足りなければ確保せず、要確認にする', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'failed', itemId: fx.itemId, variantId: fx.variantId, quantity: 2, reserved: false,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });
    const pi = (await orderRow(db(), orderId)).payment_intent_id as string;

    const res = await markPaid(db(), { orderId, expected: 'failed', paymentIntentId: pi, amount: PRICE * 2 });

    expect(res.rows[0]).toEqual({ updated: true, amount_matches: true, needs_review: true });
    expect(await orderRow(db(), orderId)).toMatchObject({ status: 'paid', review_reason: 'stock_not_reserved' });
    expect(await variantStock(db(), fx.variantId)).toBe(1);
  });

  test('注文の PaymentIntent と違う PaymentIntent では入金済みにしない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'pending', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });

    await expect(markPaid(db(), { orderId, expected: 'pending', paymentIntentId: 'pi_other', amount: PRICE }))
      .rejects.toMatchObject({ code: '22023', message: expect.stringContaining('PAYMENT_INTENT_MISMATCH') });
  });

  test('支払い手続き中を入金待ちにし、PaymentIntent を埋めてカートを空にする。2回目は updated=false', async () => {
    const { draft, orderId } = await placeFromDraft(db(), { stock: 1, quantity: 1 });
    const pi = `pi_${uniqueSuffix()}`;

    const first = await markAwaiting(db(), { orderId, paymentIntentId: pi, event: 'evt_awaiting_1' });
    const second = await markAwaiting(db(), { orderId, paymentIntentId: pi });

    expect(first.rows[0].updated).toBe(true);
    expect(second.rows[0].updated).toBe(false);
    expect(await orderRow(db(), orderId)).toMatchObject({ status: 'pending', payment_intent_id: pi });
    expect(await cartExists(db(), draft.cartId)).toBe(false);
    expect(await revisionsOf(db(), orderId)).toEqual([
      { reason: 'stripe_payment_awaiting', sourceEventId: 'evt_awaiting_1', changedBy: null },
    ]);
  });

  test('入金待ちから入金済みにする', async () => {
    const { orderId } = await placeFromDraft(db(), { stock: 1, quantity: 1 });
    const pi = `pi_${uniqueSuffix()}`;
    await markAwaiting(db(), { orderId, paymentIntentId: pi });

    const res = await markPaid(db(), { orderId, expected: 'pending', paymentIntentId: pi, amount: PRICE });

    expect(res.rows[0]).toEqual({ updated: true, amount_matches: true, needs_review: false });
  });

  test('Webhook と見回りが別の接続から同時に入金済みにしても、状態の変化は1回、入金確認メールの送信権も1回だけ取れる（設計書 6 の並行）', async () => {
    const { orderId } = await placeFromDraft(db(), { stock: 1, quantity: 1 });
    const pi = `pi_${uniqueSuffix()}`;
    const other = await connectLocalDb();
    try {
      const [webhook, sweep] = await Promise.all([
        markPaid(db(), { orderId, expected: 'payment_in_progress', paymentIntentId: pi, amount: PRICE, event: 'evt_concurrent_webhook' }),
        markPaid(other, { orderId, expected: 'payment_in_progress', paymentIntentId: pi, amount: PRICE, event: 'evt_concurrent_sweep' }),
      ]);

      // 後の方は行ロックを待ち、先に入金済みになった注文を見て何もしない
      expect([webhook.rows[0].updated, sweep.rows[0].updated].sort()).toEqual([false, true]);
      const winnerEvent = webhook.rows[0].updated ? 'evt_concurrent_webhook' : 'evt_concurrent_sweep';
      expect((await orderRow(db(), orderId)).status).toBe('paid');
      expect(await revisionsOf(db(), orderId)).toEqual([
        { reason: 'stripe_payment_paid', sourceEventId: winnerEvent, changedBy: null },
      ]);

      const claims = await Promise.all([
        db().query('select public.claim_order_email($1::uuid, $2::text) as claimed', [orderId, 'paid']),
        other.query('select public.claim_order_email($1::uuid, $2::text) as claimed', [orderId, 'paid']),
      ]);
      expect(claims.map((res) => res.rows[0].claimed).sort()).toEqual([false, true]);
    } finally {
      await other.end();
    }
  });

  test('anon・authenticated は実行できない', async () => {
    for (const signature of [
      'public.mark_order_paid(uuid,public.order_status,text,integer,text,text)',
      'public.mark_order_awaiting_payment(uuid,text,text)',
    ]) {
      for (const role of ['anon', 'authenticated']) {
        const res = await db().query('select has_function_privilege($1, $2, $3) as allowed', [role, signature, 'EXECUTE']);
        expect(res.rows[0].allowed).toBe(false);
      }
    }
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/mark_order_payment`
Expected: FAIL（`function public.mark_order_paid(...) does not exist`）

- [ ] **Step 3: マイグレーションを書く**

`supabase/migrations/20260927100400_mark_order_payment_rpcs.sql`:
```sql
-- 入金済み・入金待ちにする RPC（グループ A 設計書 4-1・4-5）。

BEGIN;

-- 注文の下書きに書かれたカートの行を消す。支払いが済んだ（入金済み・払込票の発行）時点で呼ぶ。
-- Session ID を持たない古い注文は下書きを引けないので何もしない（当時の確定 RPC が消している）。
CREATE OR REPLACE FUNCTION private.clear_cart_for_order(_order_id uuid)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  DELETE FROM public.carts AS c
  USING public.orders AS o,
        public.checkout_drafts AS d,
        pg_catalog.jsonb_array_elements(d.items_snapshot) AS s(value)
  WHERE o.id = _order_id
    AND d.checkout_session_id = o.checkout_session_id
    AND (s.value->>'source_cart_id') IS NOT NULL
    AND c.id = (s.value->>'source_cart_id')::uuid
    AND c.session_id = d.session_id;
$$;

REVOKE ALL ON FUNCTION private.clear_cart_for_order(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.mark_order_paid(
  _order_id uuid,
  _expected_status public.order_status,
  _payment_intent_id text,
  _paid_amount integer,
  _paid_currency text,
  _source_event_id text DEFAULT NULL
)
RETURNS TABLE (updated boolean, amount_matches boolean, needs_review boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  target public.orders%ROWTYPE;
  matches boolean;
  missing_reservation boolean;
BEGIN
  IF _order_id IS NULL
     OR NULLIF(pg_catalog.btrim(_payment_intent_id), '') IS NULL
     OR _paid_amount IS NULL
     OR NULLIF(pg_catalog.btrim(_paid_currency), '') IS NULL THEN
    RAISE EXCEPTION 'MARK_PAID_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _expected_status IS NULL
     OR _expected_status NOT IN (
       'payment_in_progress'::public.order_status,
       'pending'::public.order_status,
       'failed'::public.order_status
     ) THEN
    RAISE EXCEPTION 'INVALID_EXPECTED_STATUS:%', _expected_status USING ERRCODE = '22023';
  END IF;

  SELECT o.* INTO target FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;

  IF target.id IS NULL OR target.status IS DISTINCT FROM _expected_status THEN
    RETURN QUERY SELECT false, NULL::boolean, NULL::boolean;
    RETURN;
  END IF;

  IF target.payment_intent_id IS NOT NULL AND target.payment_intent_id <> _payment_intent_id THEN
    RAISE EXCEPTION 'PAYMENT_INTENT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  matches := target.total_amount = _paid_amount
    AND pg_catalog.lower(target.currency) = pg_catalog.lower(_paid_currency);

  -- 在庫扱いで確保中が0の明細（⑤の失敗の後の入金と、確保の記録が無い古い明細）を確保し直す。
  -- バリアントは id の昇順でロックする（受付・在庫を戻す処理と同じ順）。
  PERFORM 1
  FROM public.item_variants AS v
  WHERE v.id IN (
    SELECT r.variant_id
    FROM private.order_line_reservations(_order_id) AS r
    JOIN public.order_items AS oi ON oi.id = r.order_item_id
    WHERE oi.fulfillment_type = 'stock'
      AND r.reserved = 0
      AND r.variant_id IS NOT NULL
  )
  ORDER BY v.id
  FOR UPDATE;

  -- 足りるバリアントの明細だけ確保する。同じバリアントの明細は合算して判定する（受付と同じ）。
  WITH lines AS (
    SELECT r.order_item_id, r.variant_id, r.quantity
    FROM private.order_line_reservations(_order_id) AS r
    JOIN public.order_items AS oi ON oi.id = r.order_item_id
    WHERE oi.fulfillment_type = 'stock'
      AND r.reserved = 0
      AND r.variant_id IS NOT NULL
  ),
  needed AS (
    SELECT l.variant_id, pg_catalog.sum(l.quantity)::integer AS quantity
    FROM lines AS l
    GROUP BY l.variant_id
  ),
  covered AS (
    SELECT n.variant_id
    FROM needed AS n
    JOIN public.item_variants AS v ON v.id = n.variant_id
    WHERE v.is_active
      AND v.stock_quantity >= n.quantity
  )
  INSERT INTO public.stock_movements (variant_id, delta, reason, order_id, order_item_id, note)
  SELECT l.variant_id, -l.quantity, 'purchase', _order_id, l.order_item_id, 'reserve_on_paid'
  FROM lines AS l
  WHERE l.variant_id IN (SELECT c.variant_id FROM covered AS c)
  ORDER BY l.variant_id, l.order_item_id;

  SELECT EXISTS (
    SELECT 1
    FROM private.order_line_reservations(_order_id) AS r
    JOIN public.order_items AS oi ON oi.id = r.order_item_id
    WHERE oi.fulfillment_type = 'stock'
      AND r.reserved = 0
  ) INTO missing_reservation;

  PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'stripe_payment_paid', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', COALESCE(_source_event_id, ''), true);

  UPDATE public.orders AS o
  SET status = 'paid'::public.order_status,
      payment_intent_id = COALESCE(o.payment_intent_id, _payment_intent_id),
      review_reason = CASE WHEN missing_reservation THEN 'stock_not_reserved' ELSE o.review_reason END,
      review_marked_at = CASE WHEN missing_reservation THEN pg_catalog.now() ELSE o.review_marked_at END
  WHERE o.id = _order_id;

  UPDATE public.checkout_drafts AS d
  SET payment_intent_id = COALESCE(d.payment_intent_id, _payment_intent_id)
  WHERE target.checkout_session_id IS NOT NULL
    AND d.checkout_session_id = target.checkout_session_id;

  PERFORM private.clear_cart_for_order(_order_id);

  RETURN QUERY SELECT true, matches, missing_reservation;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_order_awaiting_payment(
  _order_id uuid,
  _payment_intent_id text,
  _source_event_id text DEFAULT NULL
)
RETURNS TABLE (updated boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  target public.orders%ROWTYPE;
BEGIN
  IF _order_id IS NULL OR NULLIF(pg_catalog.btrim(_payment_intent_id), '') IS NULL THEN
    RAISE EXCEPTION 'MARK_AWAITING_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT o.* INTO target FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;

  IF target.id IS NULL OR target.status IS DISTINCT FROM 'payment_in_progress'::public.order_status THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  IF target.payment_intent_id IS NOT NULL AND target.payment_intent_id <> _payment_intent_id THEN
    RAISE EXCEPTION 'PAYMENT_INTENT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'stripe_payment_awaiting', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', COALESCE(_source_event_id, ''), true);

  UPDATE public.orders AS o
  SET status = 'pending'::public.order_status,
      payment_intent_id = COALESCE(o.payment_intent_id, _payment_intent_id)
  WHERE o.id = _order_id;

  UPDATE public.checkout_drafts AS d
  SET payment_intent_id = COALESCE(d.payment_intent_id, _payment_intent_id)
  WHERE target.checkout_session_id IS NOT NULL
    AND d.checkout_session_id = target.checkout_session_id;

  PERFORM private.clear_cart_for_order(_order_id);

  RETURN QUERY SELECT true;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_order_paid(uuid, public.order_status, text, integer, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_awaiting_payment(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_order_paid(uuid, public.order_status, text, integer, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_awaiting_payment(uuid, text, text)
  TO service_role;

COMMIT;
```

- [ ] **Step 4: ローカル DB に当ててテストを通す**

Run:
```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/mark_order_payment
```
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add tests/integration/db/mark_order_payment.integration.test.ts supabase/migrations/20260927100400_mark_order_payment_rpcs.sql
git commit -m "feat(db): 注文を入金済み・入金待ちにする RPC を足す

失敗の後の入金は在庫を確保し直し、足りなければ要確認にする（⑤）。
起因イベントを注文履歴に残す（R-43）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: 要対応の記録・要確認の確認・メールの種類・発送止め

**Files:**
- Create: `tests/integration/db/payment_exceptions.integration.test.ts`
- Create: `supabase/migrations/20260927100500_payment_exceptions.sql`
- Modify: `tests/integration/db/order_state_transition_hardening.integration.test.ts:38-41`（適用済みの `20260925000218` を当て直さない）

**Interfaces:**
- Consumes: Task 3〜5
- Produces:
  - 表 `public.payment_exceptions`（設計書 4-4 の列。`(payment_ref, reason)` で一意）
  - SQL `public.record_payment_exception(_payment_ref text, _reason text, _detail text default null, _checkout_session_id text default null, _payment_intent_id text default null, _draft_id uuid default null, _order_id uuid default null) → table(exception_id uuid, is_new boolean, is_resolved boolean)`
  - SQL `public.claim_payment_exception_notification(_exception_id uuid, _channel text) → boolean`・`public.release_payment_exception_notification(_exception_id uuid, _channel text) → boolean`（`_channel` は `shop`・`customer`）
  - SQL `public.resolve_payment_exception(_exception_id uuid, _actor_id uuid, _note text default null, _cancel_order boolean default false, _cancel_reason text default null, _notify_customer boolean default null) → table(resolved boolean, order_id uuid, cancelled_from order_status)`
  - SQL `public.mark_order_reviewed(_order_id uuid, _actor_id uuid) → boolean`
  - SQL `public.admin_cancel_failed_order(_order_id uuid, _actor_id uuid, _cancel_reason text, _note text default null) → table(id uuid, status order_status)`（旧 `(uuid, uuid)` は Task 22 で消す）
  - SQL `private.suppress_legacy_unpaid_order_emails() → integer`（移行前の未入金の注文のお客様向けメールを送信済みとして登録。マイグレーションで1回呼ぶ）
  - `private.order_emails.kind` に `payment_expired`・`canceled` を足す。`admin_ship_paid_order` は支払額の違いの要対応が開いている注文を断る

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/db/payment_exceptions.integration.test.ts`:
```ts
/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import {
  createCatalogFixture,
  insertOrderWithStockLine,
  orderRow,
  revisionsOf,
  uniqueSuffix,
  variantStock,
} from './helpers/order-fixtures';

/**
 * 要対応の記録と解決・要確認の確認（設計書 4-4・5-2）、メールの種類と移行前の注文（第7章）、
 * 支払額の違いの発送止め（4-1）。
 */
const ACTOR = '00000000-0000-4000-8000-000000000002';

async function record(
  db: PgClient,
  args: { ref: string; reason: string; detail?: string | null; orderId?: string | null },
) {
  const res = await db.query(
    `select exception_id, is_new, is_resolved
     from public.record_payment_exception($1::text, $2::text, $3::text, $1::text, null, null, $4::uuid)`,
    [args.ref, args.reason, args.detail ?? null, args.orderId ?? null],
  );
  return res.rows[0] as { exception_id: string; is_new: boolean; is_resolved: boolean };
}

async function exceptionRow(db: PgClient, id: string) {
  const res = await db.query(
    `select detection_count, resolved_at, resolved_by, resolution_note, shop_notified_at, customer_notified_at
     from public.payment_exceptions where id = $1`,
    [id],
  );
  return res.rows[0];
}

async function claim(db: PgClient, id: string, channel: string): Promise<boolean> {
  const res = await db.query('select public.claim_payment_exception_notification($1::uuid, $2::text) as claimed', [id, channel]);
  return res.rows[0].claimed;
}

async function claimEmail(db: PgClient, orderId: string, kind: string): Promise<boolean> {
  const res = await db.query('select public.claim_order_email($1::uuid, $2::text) as claimed', [orderId, kind]);
  return res.rows[0].claimed;
}

describeLocalDb('integration: 要対応・要確認', (db) => {
  test('同じ支払い・同じ理由は1行にまとめ、検知の回数を数える', async () => {
    const ref = `cs_${uniqueSuffix()}`;
    const first = await record(db(), { ref, reason: 'order_not_creatable', detail: 'item_unavailable' });
    const second = await record(db(), { ref, reason: 'order_not_creatable', detail: 'item_unavailable' });

    expect(first).toMatchObject({ is_new: true, is_resolved: false });
    expect(second).toEqual({ exception_id: first.exception_id, is_new: false, is_resolved: false });
    expect((await exceptionRow(db(), first.exception_id)).detection_count).toBe(2);
  });

  test('理由と補足コードは決まった形だけ入る', async () => {
    await expect(record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'other' })).rejects.toMatchObject({ code: '23514' });
    await expect(
      record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'state_conflict', detail: 'hanako@example.com' }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('通知の送信権は1回だけ取れ、戻すともう一度取れる', async () => {
    const { exception_id: id } = await record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'state_conflict' });

    expect(await claim(db(), id, 'shop')).toBe(true);
    expect(await claim(db(), id, 'shop')).toBe(false);
    await db().query('select public.release_payment_exception_notification($1::uuid, $2::text)', [id, 'shop']);
    expect(await claim(db(), id, 'shop')).toBe(true);
    expect(await claim(db(), id, 'customer')).toBe(true);
  });

  test('解決すると実行者とメモが残り、同じ要対応をもう一度解決すると resolved=false', async () => {
    const { exception_id: id } = await record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'unexpected_state' });

    const first = await db().query(
      'select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, $3::text)',
      [id, ACTOR, 'Stripe で確認済み'],
    );
    const second = await db().query(
      'select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, $3::text)',
      [id, ACTOR, null],
    );

    expect(first.rows[0].resolved).toBe(true);
    expect(second.rows[0].resolved).toBe(false);
    expect(await exceptionRow(db(), id)).toMatchObject({ resolved_by: ACTOR, resolution_note: 'Stripe で確認済み' });
  });

  test('解決済みの要対応は、再び検知しても開き直さない', async () => {
    const ref = `cs_${uniqueSuffix()}`;
    const { exception_id: id } = await record(db(), { ref, reason: 'stripe_object_missing' });
    await db().query('select resolved from public.resolve_payment_exception($1::uuid, $2::uuid)', [id, ACTOR]);

    const again = await record(db(), { ref, reason: 'stripe_object_missing' });

    expect(again).toEqual({ exception_id: id, is_new: false, is_resolved: true });
  });

  test('「注文を取り消して解決」は未入金の注文を取消にし、確保した分だけ在庫を戻す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
    });
    const { exception_id: id } = await record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'unexpected_state', orderId });

    const res = await db().query(
      `select resolved, order_id, cancelled_from::text as cancelled_from
       from public.resolve_payment_exception($1::uuid, $2::uuid, $3::text, true, 'other', true)`,
      [id, ACTOR, 'Stripe に支払いが無い'],
    );

    expect(res.rows[0]).toEqual({ resolved: true, order_id: orderId, cancelled_from: 'payment_in_progress' });
    expect(await orderRow(db(), orderId)).toMatchObject({
      status: 'cancelled', cancel_reason: 'other', cancel_note: 'Stripe に支払いが無い', cancel_notify_customer: true,
    });
    expect(await variantStock(db(), fx.variantId)).toBe(2);
    expect(await revisionsOf(db(), orderId)).toEqual([
      { reason: 'resolve_payment_exception', sourceEventId: null, changedBy: ACTOR },
    ]);
  });

  test('「注文を取り消して解決」はメモが要り、入金済みの注文では使えない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const unpaid = await insertOrderWithStockLine(db(), {
      status: 'pending', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
    });
    const paid = await insertOrderWithStockLine(db(), {
      status: 'paid', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });
    const noNote = await record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'state_conflict', orderId: unpaid.orderId });
    const paidException = await record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'state_conflict', orderId: paid.orderId });

    await expect(db().query(
      `select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, null, true, 'other', true)`,
      [noNote.exception_id, ACTOR],
    )).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('RESOLUTION_NOTE_REQUIRED') });
    await expect(db().query(
      `select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, 'メモ', true, 'other', true)`,
      [paidException.exception_id, ACTOR],
    )).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('ORDER_NOT_CANCELLABLE') });
  });

  test('要確認を確認済みにすると日時と実行者が残り、2回目は false', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'paid', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });
    await db().query(
      `update public.orders set review_reason = 'stock_not_reserved', review_marked_at = now() where id = $1`,
      [orderId],
    );

    const first = await db().query('select public.mark_order_reviewed($1::uuid, $2::uuid) as reviewed', [orderId, ACTOR]);
    const second = await db().query('select public.mark_order_reviewed($1::uuid, $2::uuid) as reviewed', [orderId, ACTOR]);

    expect(first.rows[0].reviewed).toBe(true);
    expect(second.rows[0].reviewed).toBe(false);
    expect(await orderRow(db(), orderId)).toMatchObject({ reviewed_by: ACTOR });
  });

  test('支払額の違いの要対応が開いている注文は発送できず、解決すると発送できる', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'paid', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });
    const { exception_id: id } = await record(db(), { ref: `cs_${uniqueSuffix()}`, reason: 'paid_amount_mismatch', orderId });
    const ship = () => db().query(
      `select id from public.admin_ship_paid_order($1::uuid, $2::uuid, 'yamato', '1234-5678')`,
      [orderId, ACTOR],
    );

    expect((await ship()).rowCount).toBe(0);
    await db().query('select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, $3::text)', [id, ACTOR, '差額を返金']);
    expect((await ship()).rowCount).toBe(1);
  });

  test('失敗の注文の取消は理由とメモを残し、「その他」はメモが要る', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'failed', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });

    await expect(db().query(
      `select id from public.admin_cancel_failed_order($1::uuid, $2::uuid, 'other', null)`,
      [orderId, ACTOR],
    )).rejects.toMatchObject({ code: '22023' });

    const res = await db().query(
      `select status::text as status from public.admin_cancel_failed_order($1::uuid, $2::uuid, 'customer_request', '電話で依頼')`,
      [orderId, ACTOR],
    );

    expect(res.rows[0].status).toBe('cancelled');
    expect(await orderRow(db(), orderId)).toMatchObject({
      cancel_reason: 'customer_request', cancel_note: '電話で依頼', cancel_notify_customer: false,
    });
  });

  test('メールの送信権に期限切れと取消が加わる', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'failed', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });

    expect(await claimEmail(db(), orderId, 'payment_expired')).toBe(true);
    expect(await claimEmail(db(), orderId, 'canceled')).toBe(true);
    await expect(claimEmail(db(), orderId, 'refunded')).rejects.toMatchObject({ code: '23514' });
  });

  test('移行前の未入金の注文（Session ID なし）は、お客様向けメールを送信済みとして登録する', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const legacy = await insertOrderWithStockLine(db(), {
      status: 'pending', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
      checkoutSessionId: null, paymentIntentId: `pi_${uniqueSuffix()}`,
    });
    const current = await insertOrderWithStockLine(db(), {
      status: 'pending', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });

    await db().query('select private.suppress_legacy_unpaid_order_emails()');

    for (const kind of ['awaiting_payment', 'paid', 'payment_expired', 'canceled']) {
      expect(await claimEmail(db(), legacy.orderId, kind)).toBe(false);
    }
    expect(await claimEmail(db(), current.orderId, 'payment_expired')).toBe(true);
  });

  test('表は RLS が有効で、anon・authenticated は表も RPC も使えない', async () => {
    const rls = await db().query(
      `select relrowsecurity from pg_class where oid = 'public.payment_exceptions'::regclass`,
    );
    expect(rls.rows[0].relrowsecurity).toBe(true);

    for (const role of ['anon', 'authenticated']) {
      const table = await db().query(
        `select has_table_privilege($1, 'public.payment_exceptions', 'SELECT') as allowed`,
        [role],
      );
      expect(table.rows[0].allowed).toBe(false);

      for (const signature of [
        'public.record_payment_exception(text,text,text,text,text,uuid,uuid)',
        'public.claim_payment_exception_notification(uuid,text)',
        'public.release_payment_exception_notification(uuid,text)',
        'public.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)',
        'public.mark_order_reviewed(uuid,uuid)',
        'public.admin_cancel_failed_order(uuid,uuid,text,text)',
      ]) {
        const fn = await db().query('select has_function_privilege($1, $2, $3) as allowed', [role, signature, 'EXECUTE']);
        expect(fn.rows[0].allowed).toBe(false);
      }
    }
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/payment_exceptions`
Expected: FAIL（`function public.record_payment_exception(...) does not exist`）

- [ ] **Step 3: マイグレーションを書く**

`supabase/migrations/20260927100500_payment_exceptions.sql`:
```sql
-- 要対応の記録・要確認の確認・メールの種類・発送止め（グループ A 設計書 4-1・4-2・4-4・5-2・第7章）。

BEGIN;

-- 1. 要対応の記録。同じ支払い・同じ理由は1行にまとめる。個人情報は入れない。
CREATE TABLE IF NOT EXISTS public.payment_exceptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_ref          text NOT NULL CHECK (char_length(payment_ref) BETWEEN 1 AND 255),
  checkout_session_id  text,
  payment_intent_id    text,
  draft_id             uuid,
  order_id             uuid REFERENCES public.orders (id),
  reason               text NOT NULL CHECK (reason IN (
                         'order_not_creatable',
                         'paid_amount_mismatch',
                         'cancelled_order_paid',
                         'state_conflict',
                         'unexpected_state',
                         'stripe_object_missing'
                       )),
  detail               text CHECK (detail IS NULL OR detail ~ '^[a-z0-9_]{1,64}$'),
  first_detected_at    timestamptz NOT NULL DEFAULT now(),
  last_detected_at     timestamptz NOT NULL DEFAULT now(),
  detection_count      integer NOT NULL DEFAULT 1 CHECK (detection_count >= 1),
  shop_notified_at     timestamptz,
  customer_notified_at timestamptz,
  resolved_at          timestamptz,
  resolved_by          uuid,
  resolution_note      text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500),
  CONSTRAINT payment_exceptions_ref_reason_key UNIQUE (payment_ref, reason)
);

CREATE INDEX IF NOT EXISTS payment_exceptions_order_id_idx ON public.payment_exceptions (order_id);
CREATE INDEX IF NOT EXISTS payment_exceptions_open_idx
  ON public.payment_exceptions (first_detected_at)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE public.payment_exceptions IS
  '支払いの要対応（設計書 4-4）。読み書きは service_role の RPC と管理 API だけ';

ALTER TABLE public.payment_exceptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny direct client access" ON public.payment_exceptions;
CREATE POLICY "deny direct client access" ON public.payment_exceptions
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

-- このプロジェクトは public の新しい表に anon・authenticated の全権限を自動で付けるので、先に剥がす。
REVOKE ALL ON TABLE public.payment_exceptions FROM anon, authenticated, service_role;
GRANT SELECT ON TABLE public.payment_exceptions TO service_role;

-- 2. 要対応を記録する。解決済みの行は開き直さず、最後の検知時刻と回数だけ更新する。
CREATE OR REPLACE FUNCTION public.record_payment_exception(
  _payment_ref text,
  _reason text,
  _detail text DEFAULT NULL,
  _checkout_session_id text DEFAULT NULL,
  _payment_intent_id text DEFAULT NULL,
  _draft_id uuid DEFAULT NULL,
  _order_id uuid DEFAULT NULL
)
RETURNS TABLE (exception_id uuid, is_new boolean, is_resolved boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  inserted_id uuid;
  existing public.payment_exceptions%ROWTYPE;
BEGIN
  INSERT INTO public.payment_exceptions (
    payment_ref, reason, detail, checkout_session_id, payment_intent_id, draft_id, order_id
  ) VALUES (
    _payment_ref, _reason, _detail, _checkout_session_id, _payment_intent_id, _draft_id, _order_id
  )
  ON CONFLICT (payment_ref, reason) DO NOTHING
  RETURNING id INTO inserted_id;

  IF inserted_id IS NOT NULL THEN
    RETURN QUERY SELECT inserted_id, true, false;
    RETURN;
  END IF;

  UPDATE public.payment_exceptions AS e
  SET last_detected_at = pg_catalog.now(),
      detection_count = e.detection_count + 1,
      checkout_session_id = COALESCE(e.checkout_session_id, _checkout_session_id),
      payment_intent_id = COALESCE(e.payment_intent_id, _payment_intent_id),
      draft_id = COALESCE(e.draft_id, _draft_id),
      order_id = COALESCE(e.order_id, _order_id)
  WHERE e.payment_ref = _payment_ref
    AND e.reason = _reason
  RETURNING e.* INTO existing;

  RETURN QUERY SELECT existing.id, false, existing.resolved_at IS NOT NULL;
END;
$$;

-- 3. 通知の送信権。送る前に押さえ、送れなければ戻す（二重にも0通にもしない）。
CREATE OR REPLACE FUNCTION public.claim_payment_exception_notification(_exception_id uuid, _channel text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _channel = 'shop' THEN
    UPDATE public.payment_exceptions
    SET shop_notified_at = pg_catalog.now()
    WHERE id = _exception_id AND shop_notified_at IS NULL;
  ELSIF _channel = 'customer' THEN
    UPDATE public.payment_exceptions
    SET customer_notified_at = pg_catalog.now()
    WHERE id = _exception_id AND customer_notified_at IS NULL;
  ELSE
    RAISE EXCEPTION 'INVALID_NOTIFICATION_CHANNEL' USING ERRCODE = '22023';
  END IF;

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_payment_exception_notification(_exception_id uuid, _channel text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _channel = 'shop' THEN
    UPDATE public.payment_exceptions SET shop_notified_at = NULL WHERE id = _exception_id;
  ELSIF _channel = 'customer' THEN
    UPDATE public.payment_exceptions SET customer_notified_at = NULL WHERE id = _exception_id;
  ELSE
    RAISE EXCEPTION 'INVALID_NOTIFICATION_CHANNEL' USING ERRCODE = '22023';
  END IF;

  RETURN FOUND;
END;
$$;

-- 4. 解決済みにする。未入金の注文が付いていれば、取り消して解決することもできる（メモ必須）。
CREATE OR REPLACE FUNCTION public.resolve_payment_exception(
  _exception_id uuid,
  _actor_id uuid,
  _note text DEFAULT NULL,
  _cancel_order boolean DEFAULT false,
  _cancel_reason text DEFAULT NULL,
  _notify_customer boolean DEFAULT NULL
)
RETURNS TABLE (resolved boolean, order_id uuid, cancelled_from public.order_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  target public.payment_exceptions%ROWTYPE;
  current_status public.order_status;
  was_released boolean;
BEGIN
  IF _exception_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RESOLVE_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _note IS NOT NULL AND pg_catalog.char_length(_note) > 500 THEN
    RAISE EXCEPTION 'RESOLUTION_NOTE_TOO_LONG' USING ERRCODE = '22023';
  END IF;

  SELECT e.* INTO target FROM public.payment_exceptions AS e WHERE e.id = _exception_id FOR UPDATE;

  IF target.id IS NULL OR target.resolved_at IS NOT NULL THEN
    RETURN QUERY SELECT false, target.order_id, NULL::public.order_status;
    RETURN;
  END IF;

  IF COALESCE(_cancel_order, false) THEN
    IF NULLIF(pg_catalog.btrim(_note), '') IS NULL THEN
      RAISE EXCEPTION 'RESOLUTION_NOTE_REQUIRED' USING ERRCODE = '22023';
    END IF;

    SELECT o.status INTO current_status FROM public.orders AS o WHERE o.id = target.order_id;

    IF current_status IS NULL
       OR current_status NOT IN ('payment_in_progress'::public.order_status, 'pending'::public.order_status) THEN
      RAISE EXCEPTION 'ORDER_NOT_CANCELLABLE' USING ERRCODE = '22023';
    END IF;

    SELECT r.released INTO was_released
    FROM public.release_stock_for_unpaid_order(
      target.order_id,
      current_status,
      'cancelled'::public.order_status,
      'resolve_payment_exception',
      _actor_id,
      NULL,
      _cancel_reason,
      _note,
      _notify_customer
    ) AS r;

    IF NOT COALESCE(was_released, false) THEN
      RETURN QUERY SELECT false, target.order_id, NULL::public.order_status;
      RETURN;
    END IF;
  END IF;

  UPDATE public.payment_exceptions AS e
  SET resolved_at = pg_catalog.now(),
      resolved_by = _actor_id,
      resolution_note = NULLIF(pg_catalog.btrim(_note), '')
  WHERE e.id = _exception_id;

  RETURN QUERY SELECT
    true,
    target.order_id,
    CASE WHEN COALESCE(_cancel_order, false) THEN current_status ELSE NULL::public.order_status END;
END;
$$;

-- 5. 要確認を確認済みにする。手動の操作でだけ付く（発送や返金で自動では付かない）。
CREATE OR REPLACE FUNCTION public.mark_order_reviewed(_order_id uuid, _actor_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _order_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'REVIEW_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_mark_order_reviewed', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);

  UPDATE public.orders AS o
  SET reviewed_at = pg_catalog.now(),
      reviewed_by = _actor_id
  WHERE o.id = _order_id
    AND o.review_reason IS NOT NULL
    AND o.reviewed_at IS NULL;

  RETURN FOUND;
END;
$$;

-- 6. 失敗の注文の取消。理由とメモを残す。お客様には送らない（期限切れで知らせ済み）。
CREATE OR REPLACE FUNCTION public.admin_cancel_failed_order(
  _order_id uuid,
  _actor_id uuid,
  _cancel_reason text,
  _note text DEFAULT NULL
)
RETURNS TABLE (id uuid, status public.order_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _cancel_reason IS NULL
     OR _cancel_reason NOT IN ('stock_unavailable', 'customer_request', 'suspected_fraud', 'other') THEN
    RAISE EXCEPTION 'CANCEL_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _cancel_reason = 'other' AND NULLIF(pg_catalog.btrim(_note), '') IS NULL THEN
    RAISE EXCEPTION 'CANCEL_NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _note IS NOT NULL AND pg_catalog.char_length(_note) > 500 THEN
    RAISE EXCEPTION 'CANCEL_NOTE_TOO_LONG' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_cancel_failed_order', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);

  RETURN QUERY
  UPDATE public.orders AS o
  SET status = 'cancelled'::public.order_status,
      cancel_reason = _cancel_reason,
      cancel_note = NULLIF(pg_catalog.btrim(_note), ''),
      cancel_notify_customer = false
  WHERE o.id = _order_id
    AND o.status = 'failed'::public.order_status
  RETURNING o.id, o.status;
END;
$$;

-- 7. 発送は、支払額の違いの要対応が開いている注文を断る（金額を確かめてから発送する）。
CREATE OR REPLACE FUNCTION public.admin_ship_paid_order(
  _order_id uuid,
  _actor_id uuid,
  _shipping_carrier text,
  _tracking_number text
)
RETURNS TABLE (id uuid, shipping_email text, shipping_full_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _shipping_carrier IS NULL
     OR NOT (_shipping_carrier = ANY (ARRAY['yamato', 'sagawa', 'japanpost'])) THEN
    RAISE EXCEPTION 'INVALID_SHIPPING_CARRIER' USING ERRCODE = '22023';
  END IF;

  IF _tracking_number IS NULL
     OR _tracking_number !~ '^[0-9A-Za-z-]{1,64}$' THEN
    RAISE EXCEPTION 'INVALID_TRACKING_NUMBER' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_ship_paid_order', true);

  RETURN QUERY
  UPDATE public.orders AS o
  SET status = 'shipped'::public.order_status,
      shipped_at = pg_catalog.now(),
      shipping_carrier = _shipping_carrier,
      tracking_number = _tracking_number
  WHERE o.id = _order_id
    AND o.status = 'paid'::public.order_status
    AND o.shipped_at IS NULL
    AND private.order_has_required_shipping_fields(o)
    AND NOT EXISTS (
      SELECT 1
      FROM public.payment_exceptions AS e
      WHERE e.order_id = o.id
        AND e.reason = 'paid_amount_mismatch'
        AND e.resolved_at IS NULL
    )
  RETURNING o.id, o.shipping_email, o.shipping_full_name;
END;
$$;

-- 8. メールの送信権に「期限切れ」と「取消」を加える（E で返金系を足す）。
ALTER TABLE private.order_emails DROP CONSTRAINT IF EXISTS order_emails_kind_check;
ALTER TABLE private.order_emails
  ADD CONSTRAINT order_emails_kind_check
  CHECK (kind IN ('awaiting_payment', 'paid', 'payment_expired', 'canceled'));

-- 9. 移行前の未入金の注文（Session ID なし。アプリ未公開の時期の注文）に、半年後のメールが
--    届かないよう、お客様向けメールの送信権をすべて送信済みとして登録する（設計書 7-1）。
CREATE OR REPLACE FUNCTION private.suppress_legacy_unpaid_order_emails()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  inserted_count integer;
BEGIN
  INSERT INTO private.order_emails (order_id, kind)
  SELECT o.id, k.kind
  FROM public.orders AS o
  CROSS JOIN (VALUES ('awaiting_payment'), ('paid'), ('payment_expired'), ('canceled')) AS k(kind)
  WHERE o.status = 'pending'::public.order_status
    AND o.checkout_session_id IS NULL
  ON CONFLICT (order_id, kind) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION private.suppress_legacy_unpaid_order_emails() FROM PUBLIC;

SELECT private.suppress_legacy_unpaid_order_emails();

-- 10. 権限。新しく作った関数は既定で PUBLIC が実行できるので剥がす。
REVOKE ALL ON FUNCTION public.record_payment_exception(text, text, text, text, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_payment_exception_notification(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_payment_exception_notification(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_payment_exception(uuid, uuid, text, boolean, text, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_reviewed(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_cancel_failed_order(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_ship_paid_order(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_payment_exception(text, text, text, text, text, uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_payment_exception_notification(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_payment_exception_notification(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_payment_exception(uuid, uuid, text, boolean, text, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_reviewed(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_failed_order(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_ship_paid_order(uuid, uuid, text, text) TO service_role;

COMMIT;
```

- [ ] **Step 4: 既存の結合テストが古い定義を当て直さないようにする**

`tests/integration/db/order_state_transition_hardening.integration.test.ts` の `beforeAll` から、次の4行（適用済みのマイグレーションを読み直して当てる部分）を消す。`20260925000218` は `npx supabase db reset` で当たっている。当て直すと、この Task で替えた `admin_ship_paid_order`（発送止め）が古い定義に戻り、別のテストファイルの結果が実行順で変わる:
```ts
    await client.query(fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20260925000218_add_order_state_transition_rpcs.sql'),
      'utf8',
    ));
```
保留中の `harden_order_state_transitions.sql` を当てる4行は残す。

- [ ] **Step 5: ローカル DB に当ててテストを通す**

Run:
```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/payment_exceptions tests/integration/db/order_email_claims tests/integration/db/order_state_transition_hardening
```
Expected: 3本とも PASS（既存の送信権・発送のテストが壊れていないことも確かめる）

- [ ] **Step 6: コミット**

```bash
git add tests/integration/db/payment_exceptions.integration.test.ts supabase/migrations/20260927100500_payment_exceptions.sql tests/integration/db/order_state_transition_hardening.integration.test.ts
git commit -m "feat(db): 要対応の記録と解決、要確認の確認、発送止めを足す

支払額の違いの要対応が開いている注文は発送できない。移行前の未入金の注文には
お客様向けメールを送らない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: 決済画面の期限を30分に、コンビニの支払期限を7日にする（R-25・R-57）

**Files:**
- Create: `tests/integration/db/checkout_session_expiry.integration.test.ts`
- Create: `supabase/migrations/20260927100600_checkout_session_expiry.sql`
- Create: `src/lib/constants/konbini.ts`
- Modify: `src/app/api/checkout/create-session/route.ts:169-171`（冪等キー）、`:1003-1026`（Session の作成。`:1006` のコンビニの支払期限を含む）
- Modify: `tests/unit/api/checkout/create-session-route.test.ts:216-244`（RPC のモック）、`:391`・`:418-419`（冪等キーの期待値）、`:323-332`・`:344-360`（コンビニの支払期限の期待値）
- Modify: `src/app/legal/page.tsx:1-4`（import）、`:95`（コンビニの支払期限の表記）
- Modify: `docs/4_DetailDesign/13_checkout.md:678`（コンビニの支払期限）
- Modify: `docs/2_Specs/spec.md`（末尾に FREQ 行）

**Interfaces:**
- Produces: 列 `checkout_drafts.checkout_session_expires_at timestamptz`。SQL `public.reserve_checkout_session_expiry(_draft_id uuid) → bigint`（Unix 秒。作成から30分30秒後。15秒以内の再送は同じ値）。Stripe の冪等キー `checkout-session:create:v1:<draftId>:<expiresAt>`
- Produces: `KONBINI_PAYMENT_DAYS`（`src/lib/constants/konbini.ts`。値は7。FREQ-106・R-57）

- [ ] **Step 1: FREQ の番号を確かめる**

Run: `grep -oE "FREQ-[0-9]+" docs/2_Specs/spec.md | sort -t- -k2 -n | tail -1`
Expected: `FREQ-406`（違えば、以下の FREQ-407 を次の番号に読み替える。以降のタスクも同じ）

- [ ] **Step 2: 失敗する DB 結合テストを書く**

`tests/integration/db/checkout_session_expiry.integration.test.ts`:
```ts
/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, createDraft } from './helpers/order-fixtures';

/**
 * 決済画面の期限（設計書 2-2、R-25）。開いてから30分ちょうどまで有効、30分を超えたら失効。
 * Stripe は30分未満の expires_at を受け付けないので、作成から30分30秒後を渡す。
 * Stripe の冪等キーは同じパラメータでしか再利用できないので、失効時刻は下書きに1回だけ決めて保存する。
 */
async function reserve(db: PgClient, draftId: string) {
  const res = await db.query('select public.reserve_checkout_session_expiry($1::uuid) as expires_at', [draftId]);
  return Number(res.rows[0].expires_at);
}

async function unattachedDraft(db: PgClient) {
  const fx = await createCatalogFixture(db, { stock: 1 });
  const draft = await createDraft(db, { itemId: fx.itemId, quantity: 1 });
  await db.query('update public.checkout_drafts set checkout_session_id = null where id = $1', [draft.draftId]);
  return draft;
}

describeLocalDb('integration: 決済画面の失効時刻', (db) => {
  test('作成から30分30秒後の Unix 秒を返し、15秒以内の再送には同じ値を返す', async () => {
    const draft = await unattachedDraft(db());
    const now = Math.floor(Date.now() / 1000);

    const first = await reserve(db(), draft.draftId);
    const second = await reserve(db(), draft.draftId);

    expect(first).toBeGreaterThanOrEqual(now + 1830 - 5);
    expect(first).toBeLessThanOrEqual(now + 1830 + 5);
    expect(second).toBe(first);
  });

  test('保存した値が30分15秒より近ければ、新しい値を決め直す', async () => {
    const draft = await unattachedDraft(db());
    await db().query(
      `update public.checkout_drafts set checkout_session_expires_at = now() + interval '30 minutes 10 seconds' where id = $1`,
      [draft.draftId],
    );
    const now = Math.floor(Date.now() / 1000);

    const renewed = await reserve(db(), draft.draftId);

    expect(renewed).toBeGreaterThanOrEqual(now + 1830 - 5);
  });

  test('Session を付けた下書きには決めない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });

    await expect(reserve(db(), draft.draftId)).rejects.toMatchObject({
      code: '22023',
      message: expect.stringContaining('CHECKOUT_DRAFT_NOT_RESERVABLE'),
    });
  });

  test('anon・authenticated は実行できない', async () => {
    for (const role of ['anon', 'authenticated']) {
      const res = await db().query('select has_function_privilege($1, $2, $3) as allowed', [
        role,
        'public.reserve_checkout_session_expiry(uuid)',
        'EXECUTE',
      ]);
      expect(res.rows[0].allowed).toBe(false);
    }
  });
});
```

- [ ] **Step 3: 単体テストを失敗する形に書き換える**

`tests/unit/api/checkout/create-session-route.test.ts` の `beforeEach` の `mockRpc.mockImplementation` で、`retire_expired_checkout_draft` の分岐の後に足す:
```ts
        if (functionName === "reserve_checkout_session_expiry") {
          return Promise.resolve(mockReserveExpiryResult);
        }
```
ファイル上部の `let mockRetireResult ...` の宣言の並びに足す:
```ts
const RESERVED_EXPIRES_AT = 1_790_001_830;
let mockReserveExpiryResult: { data: unknown; error: { message: string } | null } = {
  data: RESERVED_EXPIRES_AT,
  error: null,
};
```
`beforeEach` の先頭の初期化に足す:
```ts
    mockReserveExpiryResult = { data: RESERVED_EXPIRES_AT, error: null };
```
冪等キーの期待値3か所（`checkout-session:create:v1:draft-123`）を `checkout-session:create:v1:draft-123:1790001830` に替える。`"%s は原子的に draft を claim し…"` のテストの `mockCreate` の期待を次にする:
```ts
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ client_reference_id: "draft-123", expires_at: RESERVED_EXPIRES_AT }),
        { idempotencyKey: "checkout-session:create:v1:draft-123:1790001830" },
      );
```
同じ `describe` の末尾にテストを足す:
```ts
  it("失効時刻を下書きに決められなければ Session を作らない", async () => {
    mockReserveExpiryResult = { data: null, error: { message: "CHECKOUT_DRAFT_NOT_RESERVABLE" } };

    const res = (await POST(
      makeRequest({ uiMode: "custom", paymentMethod: "stripe_card" }),
    )) as unknown as { status: number };

    expect(res.status).toBe(500);
    expect(mockCreate).not.toHaveBeenCalled();
  });
```

- [ ] **Step 4: テストが落ちることを確かめる**

Run:
```bash
npx jest tests/unit/api/checkout/create-session-route
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/checkout_session_expiry
```
Expected: どちらも FAIL（冪等キーと `expires_at` の不一致、RPC が無い）

- [ ] **Step 5: マイグレーションを書く**

`supabase/migrations/20260927100600_checkout_session_expiry.sql`:
```sql
-- 決済画面の期限（グループ A 設計書 2-2、R-25）。
--
-- 規則は「開いてから30分ちょうどまで有効、30分を超えたら失効」。Stripe は30分未満の expires_at を
-- 受け付けないので、通信の遅れと時計のずれで下限を割らないよう30秒足して、作成から30分30秒後にする。
-- Stripe の冪等キーは同じパラメータでしか再利用できない。失効時刻は下書きに1回だけ決めて保存し、
-- キーに含める。15秒以内の再送は同じ値（同じキー）になり、Stripe は同じ Session を返す。

BEGIN;

ALTER TABLE public.checkout_drafts
  ADD COLUMN IF NOT EXISTS checkout_session_expires_at timestamptz;

COMMENT ON COLUMN public.checkout_drafts.checkout_session_expires_at IS
  'Stripe の Checkout Session に渡した expires_at（設計書 2-2）';

CREATE OR REPLACE FUNCTION public.reserve_checkout_session_expiry(_draft_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  reserved timestamptz;
BEGIN
  UPDATE public.checkout_drafts AS d
  SET checkout_session_expires_at = CASE
    WHEN d.checkout_session_expires_at > pg_catalog.now() + interval '30 minutes 15 seconds'
      THEN d.checkout_session_expires_at
    ELSE pg_catalog.date_trunc('second', pg_catalog.now() + interval '30 minutes 30 seconds')
  END
  WHERE d.id = _draft_id
    AND d.status = 'created'
    AND d.checkout_session_id IS NULL
  RETURNING d.checkout_session_expires_at INTO reserved;

  IF reserved IS NULL THEN
    RAISE EXCEPTION 'CHECKOUT_DRAFT_NOT_RESERVABLE' USING ERRCODE = '22023';
  END IF;

  RETURN pg_catalog.date_part('epoch', reserved)::bigint;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_checkout_session_expiry(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_checkout_session_expiry(uuid) TO service_role;

COMMIT;
```

- [ ] **Step 6: create-session を変える**

`src/app/api/checkout/create-session/route.ts` の冪等キーの関数を替える:
```ts
function checkoutSessionIdempotencyKey(draftId: string, expiresAt: number): string {
  return `checkout-session:create:v${CHECKOUT_REQUEST_VERSION}:${draftId}:${expiresAt}`;
}

/**
 * 決済画面の失効時刻を下書きに1回だけ決める（設計書 2-2、R-25）。
 * 冪等キーに含めるので、同じ要求の再送は同じ Session に収束する。
 */
async function reserveCheckoutSessionExpiry(draftId: string): Promise<number> {
  const { data, error } = await supabase.rpc("reserve_checkout_session_expiry", {
    _draft_id: draftId,
  });

  if (error || typeof data !== "number" || !Number.isInteger(data)) {
    throw new Error("Failed to reserve checkout session expiry");
  }

  return data;
}
```
`const selectedPaymentMethod = createdDraft.payment_method ?? "auto";` の直前に足す:
```ts
    const checkoutSessionExpiresAt = await reserveCheckoutSessionExpiry(createdDraft.id);
```
`commonSessionParams` の `client_reference_id: createdDraft.id,` の次の行に足す:
```ts
      expires_at: checkoutSessionExpiresAt,
```
`stripe.checkout.sessions.create` の冪等キーを替える:
```ts
    const session = await stripe.checkout.sessions.create(sessionParams, {
      idempotencyKey: checkoutSessionIdempotencyKey(createdDraft.id, checkoutSessionExpiresAt),
    });
```

- [ ] **Step 7: テストを通す**

Run:
```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/checkout_session_expiry
npx jest tests/unit/api/checkout/create-session-route
npm run typecheck
```
Expected: すべて PASS

- [ ] **Step 8: FREQ 行を足す**

`docs/2_Specs/spec.md` の表の末尾に足す:
```text
| FREQ-407 | 決済画面は開いてから30分ちょうどまで有効とし、30分を超えたら失効させて在庫を戻すこと（R-25） | FREQ-407-REQ-01 | Checkout Session の `expires_at` を作成から30分30秒後にすること。値は下書きに1回だけ決めて保存し、Stripe の冪等キーに含めること | FREQ-407-REQ-02 | 毎時の見回りが、開いてから30分を超えた支払い手続き中の注文の Session がまだ開いていれば失効させ、照合関数で在庫を戻すこと（Webhook が届かなくても最長90分）。アプリ独自の日数で入金待ちを打ち切る処理（FREQ-388 の日数）は置かず、Stripe の現在値だけで判断すること | FREQ-407-AC-01 | Checkout Session が作成から30分30秒後の `expires_at` で作られること | FREQ-407-AC-02 | 同じ要求の15秒以内の再送が同じ冪等キーになること | FREQ-407-AC-03 | 見回りが、開いてから30分を超えてまだ開いている決済を失効させること |
```

- [ ] **Step 9: コミット**

```bash
git add tests/integration/db/checkout_session_expiry.integration.test.ts supabase/migrations/20260927100600_checkout_session_expiry.sql src/app/api/checkout/create-session/route.ts tests/unit/api/checkout/create-session-route.test.ts docs/2_Specs/spec.md
git commit -m "feat(checkout): 決済画面を作成から30分30秒で失効させる

失効時刻は下書きに1回だけ決めて Stripe の冪等キーに含める（R-25）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10: コンビニの支払期限のテストを7日に書き換える**

期限は7日（FREQ-106・R-57。2026-09-27 決定）。Stripe は「注文日＋7日の 23:59:59（日本時間）」まで払える。`tests/unit/api/checkout/create-session-route.test.ts` の2つのテストの名前と期待値を替える。期待値は定数を読まず数値の7で書く（定数を誤って変えたときにテストで気付けるように）。

`it("コンビニの支払期限を3日で送る", ...)` を:
```ts
  it("コンビニの支払期限を7日で送る（FREQ-106・R-57）", async () => {
```
その中の期待値を:
```ts
    expect(params.payment_method_options?.konbini?.expires_after_days).toBe(7);
```
`it("hosted モードでは payment_method_types を送らず、konbini の支払期限を3日で送る", ...)` を:
```ts
  it("hosted モードでは payment_method_types を送らず、konbini の支払期限を7日で送る（FREQ-106・R-57）", async () => {
```
その中の期待値を:
```ts
    expect(params.payment_method_options?.konbini?.expires_after_days).toBe(7);
```

- [ ] **Step 11: テストが落ちることを確かめる**

Run: `npx jest tests/unit/api/checkout/create-session-route -t "支払期限を7日"`
Expected: 2件 FAIL（`Expected: 7` / `Received: 3`）

- [ ] **Step 12: 定数を作り、create-session と /legal で読む**

`src/lib/constants/konbini.ts`:
```ts
// コンビニ決済の支払期限（日数）。Stripe の payment_method_options.konbini.expires_after_days と
// /legal の「支払方法・支払時期」の表記で共有する（FREQ-106）。Stripe では「注文日＋この日数の 23:59:59（日本時間）」まで払える。
// 7日は 2026-09-27 の決定（グループ A 設計書 5-7）。変えるときは FR-LEGAL-004 と create-session の単体テストの期待値も直す。
export const KONBINI_PAYMENT_DAYS = 7;
```

`src/app/api/checkout/create-session/route.ts` の `import { getStripeServerClient } from "@/lib/stripe/server";` の次に足す:
```ts
import { KONBINI_PAYMENT_DAYS } from "@/lib/constants/konbini";
```
`payment_method_options` を替える:
```ts
      payment_method_options: {
        konbini: { expires_after_days: KONBINI_PAYMENT_DAYS },
      },
```

`src/app/legal/page.tsx` の `import { getSiteUrl } from "@/lib/redirect";` の次に足す:
```ts
import { KONBINI_PAYMENT_DAYS } from "@/lib/constants/konbini";
```
コンビニ決済の行（95行目）を替える。表示される文は「（ご注文から7日以内）」のまま変わらない:
```tsx
          コンビニ決済：ご注文後に発行される払込番号の期限（ご注文から{KONBINI_PAYMENT_DAYS}日以内）までに、選択したコンビニでお支払いください。
```

`docs/4_DetailDesign/13_checkout.md` の「新しい決済手段をダッシュボードで有効化するときの手順」の2番目の項目にある括弧書き（「コンビニは」で始まり `expires_after_days: 3` を含むもの）を次に替える:
```text
（コンビニは `expires_after_days` に `KONBINI_PAYMENT_DAYS`（7日。`src/lib/constants/konbini.ts`）を設定済み。/legal の表記も同じ定数を読む。FREQ-106・R-57）
```

- [ ] **Step 13: テストを通す**

Run:
```bash
npx jest tests/unit/api/checkout/create-session-route
npm run typecheck
npx eslint src/lib/constants/konbini.ts src/app/legal/page.tsx src/app/api/checkout/create-session/route.ts
```
dev サーバーが止まっていることを確かめてから（`Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue` が空）:
```bash
npx playwright test e2e/FR-LEGAL-004
```
Expected: すべて PASS。FR-LEGAL-004 は /legal の文が「7日以内」のまま変わらないことの確認。既存の FREQ-106（7日・定数で一元管理・/legal と同期）をそのまま満たすので、FREQ 行は足さない

- [ ] **Step 14: コミット**

```bash
git add src/lib/constants/konbini.ts src/app/api/checkout/create-session/route.ts src/app/legal/page.tsx tests/unit/api/checkout/create-session-route.test.ts docs/4_DetailDesign/13_checkout.md
git commit -m "feat(checkout): コンビニの支払期限を7日にし、/legal と同じ定数から出す

FREQ-106 のとおり Stripe の expires_after_days と /legal の表記をそろえる（R-57）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: 型と判定表（純関数）

**Files:**
- Create: `src/lib/orders/order-payment-types.ts`
- Create: `tests/unit/lib/orders/order-payment-types.test.ts`
- Create: `src/lib/stripe/checkout-payment-decision.ts`
- Create: `tests/unit/lib/stripe/checkout-payment-decision.test.ts`

**Interfaces:**
- Produces（`order-payment-types.ts`）: `ORDER_STATUSES`・`type OrderStatus`・`HIDDEN_ORDER_STATUSES`・`HIDDEN_ORDER_STATUS_FILTER`（`'(payment_in_progress,abandoned)'`）・`CANCEL_REASONS`・`type CancelReason`・`CANCEL_REASON_LABELS`・`PAYMENT_EXCEPTION_REASONS`・`type PaymentExceptionReason`・`PAYMENT_EXCEPTION_REASON_LABELS`・`PLACE_ORDER_REJECTIONS`・`type PlaceOrderRejection`・`type PaidEmailVariant`（`'order_confirmed' | 'payment_received' | 'payment_received_after_expiry'`）・`ADMIN_NOTE_MAX_LENGTH = 500`
- Produces（`checkout-payment-decision.ts`）: `type StripePaymentState`・`type OrderAction`・`type DecisionInput`・`decideOrderAction(input: DecisionInput): OrderAction`

- [ ] **Step 1: 失敗するテストを書く（型）**

`tests/unit/lib/orders/order-payment-types.test.ts`:
```ts
import fs from 'node:fs';
import path from 'node:path';
import {
  CANCEL_REASONS,
  HIDDEN_ORDER_STATUS_FILTER,
  ORDER_STATUSES,
  PAYMENT_EXCEPTION_REASONS,
} from '@/lib/orders/order-payment-types';

/** アプリの値と DB の enum・CHECK 制約がずれないことを、マイグレーションの本文で確かめる。 */
function migration(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'supabase/migrations', name), 'utf8');
}

describe('注文と支払いの値', () => {
  it('注文の状態は DB の enum と同じ7つ', () => {
    const initial = migration('20260901102912_remote_schema.sql');
    const added = migration('20260927100000_add_order_payment_statuses.sql');
    for (const status of ORDER_STATUSES) {
      expect(`${initial}\n${added}`).toContain(`'${status}'`);
    }
    expect(ORDER_STATUSES).toHaveLength(7);
  });

  it('要対応の理由と取消の理由は DB の CHECK と同じ', () => {
    const exceptions = migration('20260927100500_payment_exceptions.sql');
    const columns = migration('20260927100100_order_payment_columns.sql');
    for (const reason of PAYMENT_EXCEPTION_REASONS) {
      expect(exceptions).toContain(`'${reason}'`);
    }
    for (const reason of CANCEL_REASONS) {
      expect(columns).toContain(`'${reason}'`);
    }
  });

  it('お客様の画面と KPI から除く状態を PostgREST の not.in の形で持つ', () => {
    expect(HIDDEN_ORDER_STATUS_FILTER).toBe('(payment_in_progress,abandoned)');
  });
});
```

- [ ] **Step 2: 失敗するテストを書く（判定表）**

`tests/unit/lib/stripe/checkout-payment-decision.test.ts`:
```ts
import { ORDER_STATUSES, type OrderStatus } from '@/lib/orders/order-payment-types';
import {
  decideOrderAction,
  type OrderAction,
  type StripePaymentState,
} from '@/lib/stripe/checkout-payment-decision';

/**
 * 判定表（設計書 3-2）の全マス。行が Stripe の状態、列が注文の状態（注文なし + 7状態）。
 * 表をそのままテストの入力にする。イベントの種類と届いた順番は入力に無い（R-01・R-02）。
 */
type Column = 'none' | OrderStatus;

const STATES = {
  入金済み: { kind: 'paid', amountReceived: 5000, amountRefunded: 0, currency: 'jpy' },
  入金待ち: { kind: 'awaiting_payment' },
  払込票の期限切れ: { kind: 'voucher_expired' },
  決済画面の放棄: { kind: 'checkout_abandoned' },
  手続き中: { kind: 'in_progress' },
  '0円で完了': { kind: 'zero_amount_complete' },
  Stripeに無い: { kind: 'missing' },
  '対象外・想定外': { kind: 'not_applicable', reason: 'unexpected' },
} satisfies Record<string, StripePaymentState>;

const none: OrderAction = { type: 'none' };
const conflict: OrderAction = { type: 'exception', reason: 'state_conflict' };

function everyOrder(action: OrderAction): Record<OrderStatus, OrderAction> {
  return Object.fromEntries(ORDER_STATUSES.map((status) => [status, action])) as Record<OrderStatus, OrderAction>;
}

const TABLE: Record<keyof typeof STATES, Record<Column, OrderAction>> = {
  入金済み: {
    none: { type: 'place_and_mark_paid' },
    payment_in_progress: { type: 'mark_paid', expectedStatus: 'payment_in_progress', emailVariant: 'order_confirmed' },
    pending: { type: 'mark_paid', expectedStatus: 'pending', emailVariant: 'payment_received' },
    paid: none,
    shipped: none,
    failed: { type: 'mark_paid', expectedStatus: 'failed', emailVariant: 'payment_received_after_expiry' },
    abandoned: conflict,
    cancelled: { type: 'exception', reason: 'cancelled_order_paid' },
  },
  入金待ち: {
    none: { type: 'place_and_mark_awaiting' },
    payment_in_progress: { type: 'mark_awaiting' },
    pending: none,
    paid: conflict,
    shipped: conflict,
    failed: conflict,
    abandoned: conflict,
    cancelled: conflict,
  },
  払込票の期限切れ: {
    none,
    payment_in_progress: { type: 'release', expectedStatus: 'payment_in_progress', nextStatus: 'failed' },
    pending: { type: 'release', expectedStatus: 'pending', nextStatus: 'failed' },
    paid: conflict,
    shipped: conflict,
    failed: none,
    abandoned: none,
    cancelled: none,
  },
  決済画面の放棄: {
    none,
    payment_in_progress: { type: 'release', expectedStatus: 'payment_in_progress', nextStatus: 'abandoned' },
    pending: conflict,
    paid: conflict,
    shipped: conflict,
    failed: none,
    abandoned: none,
    cancelled: none,
  },
  手続き中: {
    none,
    payment_in_progress: none,
    pending: conflict,
    paid: conflict,
    shipped: conflict,
    failed: none,
    abandoned: none,
    cancelled: none,
  },
  '0円で完了': {
    none: { type: 'record_only', note: 'zero_amount' },
    ...everyOrder({ type: 'exception', reason: 'paid_amount_mismatch', detail: 'zero_amount' }),
  },
  Stripeに無い: {
    none: { type: 'record_only', note: 'stripe_object_missing' },
    ...everyOrder({ type: 'exception', reason: 'stripe_object_missing' }),
  },
  '対象外・想定外': {
    none: { type: 'record_only', note: 'not_applicable' },
    ...everyOrder({ type: 'exception', reason: 'unexpected_state', detail: 'unexpected' }),
  },
};

const CASES = (Object.keys(TABLE) as Array<keyof typeof STATES>).flatMap((state) =>
  (Object.keys(TABLE[state]) as Column[]).map((column) => [state, column, TABLE[state][column]] as const),
);

describe('decideOrderAction（判定表）', () => {
  it('Stripe の状態8行 × 注文なしと7状態のすべてのマスを持つ', () => {
    expect(CASES).toHaveLength(8 * 8);
  });

  it.each(CASES)('%s × %s', (state, column, expected) => {
    expect(
      decideOrderAction({
        stripe: STATES[state],
        orderStatus: column === 'none' ? null : column,
        adminCancel: false,
      }),
    ).toEqual(expected);
  });

  it('管理画面の取消では、在庫を戻す行き先を「取消」にする', () => {
    expect(decideOrderAction({ stripe: STATES['払込票の期限切れ'], orderStatus: 'pending', adminCancel: true }))
      .toEqual({ type: 'release', expectedStatus: 'pending', nextStatus: 'cancelled' });
    expect(decideOrderAction({ stripe: STATES['決済画面の放棄'], orderStatus: 'payment_in_progress', adminCancel: true }))
      .toEqual({ type: 'release', expectedStatus: 'payment_in_progress', nextStatus: 'cancelled' });
  });

  it('管理画面の取消でも、入金済みなら取り消さず入金済みにする', () => {
    expect(decideOrderAction({ stripe: STATES['入金済み'], orderStatus: 'payment_in_progress', adminCancel: true }))
      .toEqual(TABLE['入金済み'].payment_in_progress);
  });

  it('取消の注文への入金は、Stripe の返金額で全額返金済みなら何もしない', () => {
    const refunded: StripePaymentState = { kind: 'paid', amountReceived: 5000, amountRefunded: 5000, currency: 'jpy' };
    const partly: StripePaymentState = { kind: 'paid', amountReceived: 5000, amountRefunded: 4999, currency: 'jpy' };

    expect(decideOrderAction({ stripe: refunded, orderStatus: 'cancelled', adminCancel: false })).toEqual(none);
    expect(decideOrderAction({ stripe: partly, orderStatus: 'cancelled', adminCancel: false }))
      .toEqual({ type: 'exception', reason: 'cancelled_order_paid' });
  });

  it('下書きの無い支払いは detail に no_draft を入れる', () => {
    expect(decideOrderAction({
      stripe: { kind: 'not_applicable', reason: 'no_draft' },
      orderStatus: 'paid',
      adminCancel: false,
    })).toEqual({ type: 'exception', reason: 'unexpected_state', detail: 'no_draft' });
  });
});
```

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/orders/order-payment-types tests/unit/lib/stripe/checkout-payment-decision`
Expected: FAIL（`Cannot find module '@/lib/orders/order-payment-types'`）

- [ ] **Step 4: 型を書く**

`src/lib/orders/order-payment-types.ts`:
```ts
/**
 * 注文と支払いの照合で使う値（グループ A 設計書 4-2・4-4・5-2）。
 * DB の enum・CHECK 制約と同じ値を1か所に置く。変えるときはマイグレーションと一緒に変える
 * （tests/unit/lib/orders/order-payment-types.test.ts が突き合わせる）。
 */
export const ORDER_STATUSES = [
  'payment_in_progress',
  'pending',
  'paid',
  'failed',
  'abandoned',
  'cancelled',
  'shipped',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** お客様の注文履歴と KPI に出さない状態（設計書 5-5）。メールで知らせた注文だけを見せる。 */
export const HIDDEN_ORDER_STATUSES = ['payment_in_progress', 'abandoned'] as const satisfies readonly OrderStatus[];

/** PostgREST の not.in に渡す形。`.not('status', 'in', HIDDEN_ORDER_STATUS_FILTER)` */
export const HIDDEN_ORDER_STATUS_FILTER = `(${HIDDEN_ORDER_STATUSES.join(',')})`;

export const CANCEL_REASONS = ['stock_unavailable', 'customer_request', 'suspected_fraud', 'other'] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

export const CANCEL_REASON_LABELS: Record<CancelReason, string> = {
  stock_unavailable: '在庫切れ',
  customer_request: 'お客様の依頼',
  suspected_fraud: '不正の疑い',
  other: 'その他',
};

export const PAYMENT_EXCEPTION_REASONS = [
  'order_not_creatable',
  'paid_amount_mismatch',
  'cancelled_order_paid',
  'state_conflict',
  'unexpected_state',
  'stripe_object_missing',
] as const;

export type PaymentExceptionReason = (typeof PAYMENT_EXCEPTION_REASONS)[number];

export const PAYMENT_EXCEPTION_REASON_LABELS: Record<PaymentExceptionReason, string> = {
  order_not_creatable: '注文を作れない支払い',
  paid_amount_mismatch: '支払額の違い',
  cancelled_order_paid: '取り消した注文への入金',
  state_conflict: '注文と支払いの矛盾',
  unexpected_state: '想定外の支払い状態',
  stripe_object_missing: 'Stripe に支払いが無い',
};

/** 受付 RPC が返す理由コード（設計書 4-3） */
export const PLACE_ORDER_REJECTIONS = [
  'draft_not_found',
  'item_unavailable',
  'amount_mismatch',
  'currency_mismatch',
  'zero_amount',
] as const;

export type PlaceOrderRejection = (typeof PLACE_ORDER_REJECTIONS)[number];

/** 入金済みにしたときのメールの書き分け（設計書 5-4）。送信権はどれも paid */
export type PaidEmailVariant = 'order_confirmed' | 'payment_received' | 'payment_received_after_expiry';

/** 管理画面のメモの上限（DB の CHECK と同じ） */
export const ADMIN_NOTE_MAX_LENGTH = 500;
```

- [ ] **Step 5: 判定表を書く**

`src/lib/stripe/checkout-payment-decision.ts`:
```ts
import type { OrderStatus, PaidEmailVariant, PaymentExceptionReason } from '@/lib/orders/order-payment-types';

/**
 * Stripe の現在値を判定に使う形に分けたもの（設計書 3-1）。
 * イベントの種類と届いた順番は使わない。同じ現在値からは常に同じ行動になる（R-01・R-02）。
 */
export type StripePaymentState =
  | { kind: 'paid'; amountReceived: number; amountRefunded: number; currency: string }
  | { kind: 'awaiting_payment' }
  | { kind: 'voucher_expired' }
  | { kind: 'checkout_abandoned' }
  | { kind: 'in_progress' }
  | { kind: 'zero_amount_complete' }
  | { kind: 'missing' }
  | { kind: 'not_applicable'; reason: 'no_draft' | 'unexpected' };

export type OrderAction =
  | { type: 'none' }
  | { type: 'record_only'; note: 'zero_amount' | 'stripe_object_missing' | 'not_applicable' }
  | { type: 'place_and_mark_paid' }
  | { type: 'place_and_mark_awaiting' }
  | {
      type: 'mark_paid';
      expectedStatus: 'payment_in_progress' | 'pending' | 'failed';
      emailVariant: PaidEmailVariant;
    }
  | { type: 'mark_awaiting' }
  | {
      type: 'release';
      expectedStatus: 'payment_in_progress' | 'pending';
      nextStatus: 'failed' | 'abandoned' | 'cancelled';
    }
  | { type: 'exception'; reason: PaymentExceptionReason; detail?: string };

export type DecisionInput = {
  stripe: StripePaymentState;
  /** 注文が無ければ null */
  orderStatus: OrderStatus | null;
  /** 管理画面の取消として呼ばれた。在庫を戻す行き先を「取消」にする */
  adminCancel: boolean;
};

const NONE: OrderAction = { type: 'none' };

/** 判定表の「起きない」マス。仕組みで起きないので、起きたら要対応として警報を出す */
const STATE_CONFLICT: OrderAction = { type: 'exception', reason: 'state_conflict' };

/**
 * Stripe の状態と注文の状態から、行動を1つ返す（設計書 3-2 の判定表）。外部に依存しない。
 */
export function decideOrderAction({ stripe, orderStatus, adminCancel }: DecisionInput): OrderAction {
  switch (stripe.kind) {
    case 'paid':
      return decidePaid(stripe, orderStatus);

    case 'awaiting_payment':
      if (orderStatus === null) return { type: 'place_and_mark_awaiting' };
      if (orderStatus === 'payment_in_progress') return { type: 'mark_awaiting' };
      if (orderStatus === 'pending') return NONE;
      return STATE_CONFLICT;

    case 'voucher_expired':
      if (orderStatus === 'payment_in_progress' || orderStatus === 'pending') {
        return { type: 'release', expectedStatus: orderStatus, nextStatus: adminCancel ? 'cancelled' : 'failed' };
      }
      if (orderStatus === 'paid' || orderStatus === 'shipped') return STATE_CONFLICT;
      return NONE;

    case 'checkout_abandoned':
      if (orderStatus === 'payment_in_progress') {
        return {
          type: 'release',
          expectedStatus: 'payment_in_progress',
          nextStatus: adminCancel ? 'cancelled' : 'abandoned',
        };
      }
      if (orderStatus === 'pending' || orderStatus === 'paid' || orderStatus === 'shipped') return STATE_CONFLICT;
      return NONE;

    case 'in_progress':
      if (orderStatus === 'pending' || orderStatus === 'paid' || orderStatus === 'shipped') return STATE_CONFLICT;
      return NONE;

    case 'zero_amount_complete':
      return orderStatus === null
        ? { type: 'record_only', note: 'zero_amount' }
        : { type: 'exception', reason: 'paid_amount_mismatch', detail: 'zero_amount' };

    case 'missing':
      return orderStatus === null
        ? { type: 'record_only', note: 'stripe_object_missing' }
        : { type: 'exception', reason: 'stripe_object_missing' };

    case 'not_applicable':
      return orderStatus === null
        ? { type: 'record_only', note: 'not_applicable' }
        : { type: 'exception', reason: 'unexpected_state', detail: stripe.reason };
  }
}

function decidePaid(
  stripe: Extract<StripePaymentState, { kind: 'paid' }>,
  orderStatus: OrderStatus | null,
): OrderAction {
  switch (orderStatus) {
    case null:
      return { type: 'place_and_mark_paid' };
    case 'payment_in_progress':
      return { type: 'mark_paid', expectedStatus: 'payment_in_progress', emailVariant: 'order_confirmed' };
    case 'pending':
      return { type: 'mark_paid', expectedStatus: 'pending', emailVariant: 'payment_received' };
    case 'failed':
      // ⑤ 失敗の後の入金。自動で入金済みにし、在庫を確保し直す
      return { type: 'mark_paid', expectedStatus: 'failed', emailVariant: 'payment_received_after_expiry' };
    case 'paid':
    case 'shipped':
      return NONE;
    case 'abandoned':
      return STATE_CONFLICT;
    case 'cancelled':
      // 全額返金済みかは DB の記録ではなく Stripe の返金額で判断する（返金の反映の遅れで誤って要対応にしない）
      return stripe.amountRefunded >= stripe.amountReceived
        ? NONE
        : { type: 'exception', reason: 'cancelled_order_paid' };
  }
}
```

- [ ] **Step 6: テストを通す**

Run: `npx jest tests/unit/lib/orders/order-payment-types tests/unit/lib/stripe/checkout-payment-decision && npm run typecheck`
Expected: PASS（判定表の64マスと追加の5件）

- [ ] **Step 7: コミット**

```bash
git add src/lib/orders/order-payment-types.ts tests/unit/lib/orders/order-payment-types.test.ts src/lib/stripe/checkout-payment-decision.ts tests/unit/lib/stripe/checkout-payment-decision.test.ts
git commit -m "feat(orders): 支払い状態の判定表を純関数で足す

Stripe の現在値と注文の状態から行動を1つ返す。イベントの種類と順番は使わない（R-01・R-02）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: Stripe の読み取りと分類

**Files:**
- Create: `src/lib/stripe/checkout-payment-reader.ts`
- Create: `tests/unit/lib/stripe/checkout-payment-reader.test.ts`

**Interfaces:**
- Consumes: Task 8 の `StripePaymentState`、既存の `getDraftIdFromStripeMetadata`（`checkout-draft.service.ts`）・`resolvePaymentMethodFromSession`（`payment-method.service.ts`）
- Produces:
  - `class ReconcileTransientError extends Error { code: 'stripe_unavailable' | 'db_unavailable' | 'not_converged' }`
  - `type CheckoutPaymentStripeClient`（`checkout.sessions.retrieve/list` と `paymentIntents.retrieve` だけの狭い型）
  - `type CheckoutPaymentSnapshot = { checkoutSessionId; paymentIntentId; draftId: string | null; cartSessionId; sessionCreatedAt: Date | null; amountTotal: number | null; amountDiscount: number; currency: string | null; paymentMethod: string | null; voucherExpiresAt: Date | null; state: StripePaymentState }`（`draftId` は Session の metadata に下書き ID が無ければ null。対象外にするかは Task 11 の照合関数が注文の有無と合わせて決める）
  - `classifyStripePaymentState(session, paymentIntent): StripePaymentState`（Session と PaymentIntent の状態だけで分ける。下書き ID は見ない）
  - `readCheckoutPayment(stripe, ref: { checkoutSessionId?: string | null; paymentIntentId?: string | null }): Promise<CheckoutPaymentSnapshot>`

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/lib/stripe/checkout-payment-reader.test.ts`:
```ts
import {
  ReconcileTransientError,
  readCheckoutPayment,
  type CheckoutPaymentStripeClient,
} from '@/lib/stripe/checkout-payment-reader';

/**
 * Stripe の現在値を読み、判定表の行に分ける（設計書 3-1）。Stripe へは書かない。
 */
function paymentIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_1',
    status: 'succeeded',
    amount_received: 5000,
    currency: 'jpy',
    payment_method_types: ['card'],
    payment_method: { type: 'card' },
    latest_charge: { amount_refunded: 0, payment_method_details: { type: 'card' } },
    next_action: null,
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_1',
    status: 'complete',
    payment_status: 'paid',
    created: 1_790_000_000,
    amount_total: 5000,
    currency: 'jpy',
    total_details: { amount_discount: 0 },
    metadata: { draft_id: 'draft-1', session_id: 'cart-1', selected_payment_method: 'stripe_card' },
    payment_intent: paymentIntent(),
    ...overrides,
  };
}

function stripeError(code: string) {
  return Object.assign(new Error(code), { type: 'StripeInvalidRequestError', code });
}

function client(options: {
  retrieve?: jest.Mock;
  list?: jest.Mock;
  retrievePaymentIntent?: jest.Mock;
} = {}) {
  const retrieve = options.retrieve ?? jest.fn().mockResolvedValue(session());
  const list = options.list ?? jest.fn().mockResolvedValue({ data: [] });
  const retrievePaymentIntent = options.retrievePaymentIntent ?? jest.fn().mockResolvedValue(paymentIntent());
  return {
    stripe: {
      checkout: { sessions: { retrieve, list } },
      paymentIntents: { retrieve: retrievePaymentIntent },
    } as unknown as CheckoutPaymentStripeClient,
    retrieve,
    list,
    retrievePaymentIntent,
  };
}

async function stateOf(sessionOverrides: Record<string, unknown>) {
  const { stripe } = client({ retrieve: jest.fn().mockResolvedValue(session(sessionOverrides)) });
  return (await readCheckoutPayment(stripe, { checkoutSessionId: 'cs_1' })).state;
}

describe('readCheckoutPayment', () => {
  it('Session ID で expand 付きに読み、判定と保存に使う項目をそろえる', async () => {
    const { stripe, retrieve } = client({
      retrieve: jest.fn().mockResolvedValue(session({
        amount_total: 4000,
        total_details: { amount_discount: 1000 },
      })),
    });

    const snapshot = await readCheckoutPayment(stripe, { checkoutSessionId: 'cs_1' });

    expect(retrieve).toHaveBeenCalledWith('cs_1', {
      expand: ['payment_intent', 'payment_intent.payment_method', 'payment_intent.latest_charge'],
    });
    expect(snapshot).toEqual({
      checkoutSessionId: 'cs_1',
      paymentIntentId: 'pi_1',
      draftId: 'draft-1',
      cartSessionId: 'cart-1',
      sessionCreatedAt: new Date(1_790_000_000 * 1000),
      amountTotal: 4000,
      amountDiscount: 1000,
      currency: 'jpy',
      paymentMethod: 'stripe_card',
      voucherExpiresAt: null,
      state: { kind: 'paid', amountReceived: 5000, amountRefunded: 0, currency: 'jpy' },
    });
  });

  it.each([
    ['open', { status: 'open', payment_status: 'unpaid', payment_intent: null }, { kind: 'in_progress' }],
    ['expired', { status: 'expired', payment_status: 'unpaid', payment_intent: null }, { kind: 'checkout_abandoned' }],
    [
      'complete + unpaid + requires_action（払込票の発行）',
      { payment_status: 'unpaid', payment_intent: paymentIntent({ status: 'requires_action' }) },
      { kind: 'awaiting_payment' },
    ],
    [
      'complete + unpaid + processing',
      { payment_status: 'unpaid', payment_intent: paymentIntent({ status: 'processing' }) },
      { kind: 'awaiting_payment' },
    ],
    [
      'complete + unpaid + requires_payment_method（払込票の期限切れ）',
      { payment_status: 'unpaid', payment_intent: paymentIntent({ status: 'requires_payment_method' }) },
      { kind: 'voucher_expired' },
    ],
    [
      'complete + unpaid + canceled',
      { payment_status: 'unpaid', payment_intent: paymentIntent({ status: 'canceled' }) },
      { kind: 'voucher_expired' },
    ],
    [
      'complete + unpaid でも PaymentIntent が succeeded なら入金済み（Session の反映待ち）',
      { payment_status: 'unpaid', payment_intent: paymentIntent({ status: 'succeeded' }) },
      { kind: 'paid', amountReceived: 5000, amountRefunded: 0, currency: 'jpy' },
    ],
    ['complete + no_payment_required', { payment_status: 'no_payment_required', payment_intent: null }, { kind: 'zero_amount_complete' }],
    ['complete + paid で PaymentIntent が無い', { payment_intent: null }, { kind: 'not_applicable', reason: 'unexpected' }],
    [
      'complete + unpaid + requires_confirmation',
      { payment_status: 'unpaid', payment_intent: paymentIntent({ status: 'requires_confirmation' }) },
      { kind: 'not_applicable', reason: 'unexpected' },
    ],
    [
      '下書き ID が無くても Session と PaymentIntent の状態で分ける（対象外かは照合関数が注文の有無で決める）',
      { metadata: {} },
      { kind: 'paid', amountReceived: 5000, amountRefunded: 0, currency: 'jpy' },
    ],
  ])('%s', async (_label, overrides, expected) => {
    expect(await stateOf(overrides)).toEqual(expected);
  });

  it('返金額は latest_charge の amount_refunded を使う', async () => {
    expect(await stateOf({
      payment_intent: paymentIntent({ latest_charge: { amount_refunded: 5000, payment_method_details: { type: 'card' } } }),
    })).toEqual({ kind: 'paid', amountReceived: 5000, amountRefunded: 5000, currency: 'jpy' });
  });

  it('コンビニの払込期限を読む', async () => {
    const { stripe } = client({
      retrieve: jest.fn().mockResolvedValue(session({
        payment_status: 'unpaid',
        payment_intent: paymentIntent({
          status: 'requires_action',
          payment_method_types: ['konbini'],
          payment_method: { type: 'konbini' },
          latest_charge: null,
          next_action: { type: 'konbini_display_details', konbini_display_details: { expires_at: 1_790_259_199 } },
        }),
      })),
    });

    const snapshot = await readCheckoutPayment(stripe, { checkoutSessionId: 'cs_1' });

    expect(snapshot.voucherExpiresAt).toEqual(new Date(1_790_259_199 * 1000));
    expect(snapshot.paymentMethod).toBe('stripe_konbini');
  });

  it('PaymentIntent ID だけなら、その PaymentIntent の Session を引く（Session ID を持たない古い注文）', async () => {
    const { stripe, list } = client({ list: jest.fn().mockResolvedValue({ data: [session()] }) });

    const snapshot = await readCheckoutPayment(stripe, { paymentIntentId: 'pi_1' });

    expect(list).toHaveBeenCalledWith({
      payment_intent: 'pi_1',
      limit: 1,
      expand: ['data.payment_intent', 'data.payment_intent.payment_method', 'data.payment_intent.latest_charge'],
    });
    expect(snapshot.checkoutSessionId).toBe('cs_1');
  });

  it('下書き ID の無い Session（移行前の注文）は draftId を null にし、状態で分ける', async () => {
    const legacy = session({
      metadata: {},
      payment_status: 'unpaid',
      payment_intent: paymentIntent({ status: 'requires_payment_method', amount_received: 0, latest_charge: null }),
    });
    const { stripe } = client({ list: jest.fn().mockResolvedValue({ data: [legacy] }) });

    const snapshot = await readCheckoutPayment(stripe, { paymentIntentId: 'pi_1' });

    expect(snapshot).toMatchObject({
      checkoutSessionId: 'cs_1',
      paymentIntentId: 'pi_1',
      draftId: null,
      cartSessionId: null,
      state: { kind: 'voucher_expired' },
    });
  });

  it('Checkout を通らない PaymentIntent は対象外（下書きなし）', async () => {
    const { stripe } = client();

    const snapshot = await readCheckoutPayment(stripe, { paymentIntentId: 'pi_direct' });

    expect(snapshot).toMatchObject({
      checkoutSessionId: null,
      paymentIntentId: 'pi_direct',
      state: { kind: 'not_applicable', reason: 'no_draft' },
    });
  });

  it('Session も PaymentIntent も resource_missing なら Stripe に無い', async () => {
    const bySession = client({ retrieve: jest.fn().mockRejectedValue(stripeError('resource_missing')) });
    const byIntent = client({ retrievePaymentIntent: jest.fn().mockRejectedValue(stripeError('resource_missing')) });

    expect(await readCheckoutPayment(bySession.stripe, { checkoutSessionId: 'cs_gone' })).toMatchObject({
      checkoutSessionId: 'cs_gone',
      state: { kind: 'missing' },
    });
    expect(await readCheckoutPayment(byIntent.stripe, { paymentIntentId: 'pi_gone' })).toMatchObject({
      paymentIntentId: 'pi_gone',
      state: { kind: 'missing' },
    });
  });

  it('通信・5xx・回数制限は一時的な失敗として投げる', async () => {
    const { stripe } = client({ retrieve: jest.fn().mockRejectedValue(new Error('socket hang up')) });

    await expect(readCheckoutPayment(stripe, { checkoutSessionId: 'cs_1' })).rejects.toMatchObject({
      name: 'ReconcileTransientError',
      code: 'stripe_unavailable',
    });
    await expect(readCheckoutPayment(stripe, { checkoutSessionId: 'cs_1' })).rejects.toBeInstanceOf(ReconcileTransientError);
  });

  it('ID が無ければ呼び出しの誤りとして投げる（一時的な失敗にしない）', async () => {
    const { stripe } = client();

    await expect(readCheckoutPayment(stripe, {})).rejects.toThrow('checkoutSessionId or paymentIntentId is required');
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/stripe/checkout-payment-reader`
Expected: FAIL（`Cannot find module '@/lib/stripe/checkout-payment-reader'`）

- [ ] **Step 3: 実装する**

`src/lib/stripe/checkout-payment-reader.ts`:
```ts
import type Stripe from 'stripe';
import { getDraftIdFromStripeMetadata } from '@/features/checkout/services/checkout-draft.service';
import { resolvePaymentMethodFromSession } from '@/features/checkout/services/payment-method.service';
import type { StripePaymentState } from '@/lib/stripe/checkout-payment-decision';

export type ReconcileTransientCode = 'stripe_unavailable' | 'db_unavailable' | 'not_converged';

/**
 * 照合の一時的な失敗（設計書 5-1）。呼び出し元はイベントを失敗にし、キューが間隔を空けて再試行する。
 */
export class ReconcileTransientError extends Error {
  readonly code: ReconcileTransientCode;

  constructor(code: ReconcileTransientCode, options?: { cause?: unknown }) {
    super(`Checkout payment reconciliation failed temporarily: ${code}`, options);
    this.name = 'ReconcileTransientError';
    this.code = code;
  }
}

/** 照合が使う Stripe の API だけを表す狭い型（order-refund-sync.ts と同じ考え方） */
export type CheckoutPaymentStripeClient = {
  checkout: {
    sessions: {
      retrieve(id: string, params?: { expand?: string[] }): Promise<Stripe.Checkout.Session>;
      list(params: { payment_intent: string; limit: number; expand?: string[] }): Promise<{
        data: Stripe.Checkout.Session[];
      }>;
    };
  };
  paymentIntents: {
    retrieve(id: string): Promise<Stripe.PaymentIntent>;
  };
};

export type CheckoutPaymentSnapshot = {
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  draftId: string | null;
  /** 下書きを作ったお客様のセッション（Session の metadata.session_id） */
  cartSessionId: string | null;
  sessionCreatedAt: Date | null;
  amountTotal: number | null;
  amountDiscount: number;
  currency: string | null;
  /** 実際に使われた支払方法。PaymentIntent が無ければ null */
  paymentMethod: string | null;
  /** コンビニの払込期限。払込票が無ければ null */
  voucherExpiresAt: Date | null;
  state: StripePaymentState;
};

const SESSION_EXPAND = ['payment_intent', 'payment_intent.payment_method', 'payment_intent.latest_charge'];

const UNEXPECTED: StripePaymentState = { kind: 'not_applicable', reason: 'unexpected' };

function isResourceMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'resource_missing');
}

function emptySnapshot(ref: {
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  state: StripePaymentState;
}): CheckoutPaymentSnapshot {
  return {
    checkoutSessionId: ref.checkoutSessionId,
    paymentIntentId: ref.paymentIntentId,
    draftId: null,
    cartSessionId: null,
    sessionCreatedAt: null,
    amountTotal: null,
    amountDiscount: 0,
    currency: null,
    paymentMethod: null,
    voucherExpiresAt: null,
    state: ref.state,
  };
}

function amountRefundedOf(charge: string | Stripe.Charge | null): number {
  return charge && typeof charge === 'object' ? charge.amount_refunded : 0;
}

/**
 * Session と PaymentIntent の現在値を、判定表の行に分ける（設計書 3-1）。
 * 下書き ID は見ない。下書き ID の無い支払い（当店の Checkout 以外）を対象外にするかは、照合関数が注文の有無と
 * 合わせて決める（注文が無いときだけ対象外。移行前の注文は Session に下書き ID が無くても状態に従う。設計書 7-1）。
 */
export function classifyStripePaymentState(
  session: Pick<Stripe.Checkout.Session, 'status' | 'payment_status'>,
  paymentIntent: Pick<Stripe.PaymentIntent, 'status' | 'amount_received' | 'currency' | 'latest_charge'> | null,
): StripePaymentState {
  if (session.status === 'open') return { kind: 'in_progress' };
  // expired は一度も完了していない Session だけがなる（complete は終状態）
  if (session.status === 'expired') return { kind: 'checkout_abandoned' };
  if (session.status !== 'complete') return UNEXPECTED;

  if (session.payment_status === 'no_payment_required') return { kind: 'zero_amount_complete' };
  if (!paymentIntent) return UNEXPECTED;

  // Session の payment_status は非同期決済の入金を少し遅れて反映することがある。PaymentIntent を優先する
  if (session.payment_status === 'paid' || paymentIntent.status === 'succeeded') {
    return {
      kind: 'paid',
      amountReceived: paymentIntent.amount_received,
      amountRefunded: amountRefundedOf(paymentIntent.latest_charge),
      currency: paymentIntent.currency,
    };
  }

  if (session.payment_status === 'unpaid') {
    if (paymentIntent.status === 'requires_action' || paymentIntent.status === 'processing') {
      return { kind: 'awaiting_payment' };
    }
    if (paymentIntent.status === 'requires_payment_method' || paymentIntent.status === 'canceled') {
      return { kind: 'voucher_expired' };
    }
  }

  return UNEXPECTED;
}

function snapshotFromSession(session: Stripe.Checkout.Session): CheckoutPaymentSnapshot {
  const paymentIntent =
    session.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : null;
  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : paymentIntent?.id ?? null;
  const voucherExpiresAt = paymentIntent?.next_action?.konbini_display_details?.expires_at ?? null;

  return {
    checkoutSessionId: session.id,
    paymentIntentId,
    // metadata に下書き ID が無ければ null のまま渡す（移行前の注文の Session など）
    draftId: getDraftIdFromStripeMetadata(session.metadata),
    cartSessionId: session.metadata?.session_id ?? null,
    sessionCreatedAt: new Date(session.created * 1000),
    amountTotal: session.amount_total ?? null,
    amountDiscount: session.total_details?.amount_discount ?? 0,
    currency: session.currency ?? null,
    paymentMethod: paymentIntent ? resolvePaymentMethodFromSession(session) : null,
    voucherExpiresAt: voucherExpiresAt ? new Date(voucherExpiresAt * 1000) : null,
    state: classifyStripePaymentState(session, paymentIntent),
  };
}

/**
 * Stripe の現在値を読む。Session ID があれば Session から、無ければ PaymentIntent から Session を引く
 * （Session ID を持たない古い注文と payment_intent 系のイベント。checkout-session-expiry.ts と同じ方法）。
 * Stripe へは書かない。通信・5xx・回数制限は ReconcileTransientError('stripe_unavailable') にする。
 */
export async function readCheckoutPayment(
  stripe: CheckoutPaymentStripeClient,
  ref: { checkoutSessionId?: string | null; paymentIntentId?: string | null },
): Promise<CheckoutPaymentSnapshot> {
  const checkoutSessionId = ref.checkoutSessionId ?? null;
  const paymentIntentId = ref.paymentIntentId ?? null;
  if (!checkoutSessionId && !paymentIntentId) {
    throw new Error('checkoutSessionId or paymentIntentId is required');
  }

  try {
    if (checkoutSessionId) {
      try {
        return snapshotFromSession(await stripe.checkout.sessions.retrieve(checkoutSessionId, { expand: SESSION_EXPAND }));
      } catch (error) {
        if (isResourceMissing(error)) {
          return emptySnapshot({ checkoutSessionId, paymentIntentId, state: { kind: 'missing' } });
        }
        throw error;
      }
    }

    const intentId = paymentIntentId as string;
    const sessions = await stripe.checkout.sessions.list({
      payment_intent: intentId,
      limit: 1,
      expand: SESSION_EXPAND.map((field) => `data.${field}`),
    });
    const found = sessions.data[0];
    if (found) {
      return snapshotFromSession(found);
    }

    try {
      await stripe.paymentIntents.retrieve(intentId);
    } catch (error) {
      if (isResourceMissing(error)) {
        return emptySnapshot({ checkoutSessionId: null, paymentIntentId: intentId, state: { kind: 'missing' } });
      }
      throw error;
    }

    // Checkout を通らない支払いは注文にしない（2026-08-09 の設計。会計の照合が不一致として検出する）
    return emptySnapshot({
      checkoutSessionId: null,
      paymentIntentId: intentId,
      state: { kind: 'not_applicable', reason: 'no_draft' },
    });
  } catch (error) {
    throw new ReconcileTransientError('stripe_unavailable', { cause: error });
  }
}
```

- [ ] **Step 4: テストを通す**

Run: `npx jest tests/unit/lib/stripe/checkout-payment-reader && npm run typecheck`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/stripe/checkout-payment-reader.ts tests/unit/lib/stripe/checkout-payment-reader.test.ts
git commit -m "feat(stripe): Checkout の支払い状態を読んで判定表の行に分ける

Stripe へは書かない。通信の失敗は一時的な失敗として投げる。
状態は Session と PaymentIntent だけで分け、下書き ID が無ければ null のまま渡す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: お客様と店へのメール

**Files:**
- Modify: `src/lib/orders/order-confirmation-email.ts`（種類の追加、入金確認の書き分け、共通部分の export）
- Modify: `tests/unit/lib/orders/order-confirmation-email.test.ts`（書き分けのテストを足す）
- Create: `src/lib/orders/order-lifecycle-emails.ts`
- Create: `tests/unit/lib/orders/order-lifecycle-emails.test.ts`
- Modify: `.env.example`・`README.md`（`SHOP_ALERT_EMAIL`）
- Modify: `docs/2_Specs/spec.md`（FREQ 行）

**Interfaces:**
- Consumes: Task 6 の送信権の種類（`payment_expired`・`canceled`）、Task 8 の `PaidEmailVariant`・`PaymentExceptionReason`・`PAYMENT_EXCEPTION_REASON_LABELS`
- Produces:
  - `order-confirmation-email.ts`: `type OrderEmailKind = 'awaiting_payment' | 'paid' | 'payment_expired' | 'canceled'`、`sendOrderConfirmationEmailForOrderId({ store, orderId, paymentState, logLabel, paidVariant? })`、export する `claimOrderEmail`・`releaseOrderEmail`・`formatCurrency`・`fetchOrderEmailSource(store, orderId, logLabel): Promise<OrderEmailSource | null>`・`type OrderEmailSource`
  - `order-lifecycle-emails.ts`: `sendPaymentExpiredEmail({ store, orderId, logLabel })`・`sendOrderCanceledEmail({ store, orderId, previousStatus: 'payment_in_progress' | 'pending', logLabel })`・`sendUnplacedPaymentNotice({ to, fullName, state: 'paid' | 'awaiting_payment' })`・`sendShopPaymentAlert(alert: ShopPaymentAlert)`・`type ShopPaymentAlert = { reason; detail; orderId; paymentRef; detectedAt: Date }`。どれも `Promise<boolean>`（送ったら true）

- [ ] **Step 1: FREQ の番号を確かめる**

Run: `grep -oE "FREQ-[0-9]+" docs/2_Specs/spec.md | sort -t- -k2 -n | tail -1`
Expected: `FREQ-407`（違えば FREQ-408 を次の番号に読み替える）

- [ ] **Step 2: 失敗するテストを書く（入金確認の書き分け）**

`tests/unit/lib/orders/order-confirmation-email.test.ts` の `describe("sendOrderConfirmationEmail"` の中の末尾に足す:
```ts
  test('失敗の後の入金（⑤）は、取り消しの案内の後に入金を確認したことを書く', async () => {
    await sendOrderConfirmationEmail({ ...baseParams(), paidVariant: 'payment_received_after_expiry' });

    const body = mockSendMail.mock.calls[0][0].text as string;
    expect(body).toContain('その後にお支払いを確認しました');
    expect(body).toContain('ご注文は有効です');
    expect(store.calls[0]).toEqual({ fn: 'claim_order_email', args: { _order_id: BASE.orderId, _kind: 'paid' } });
  });
```

- [ ] **Step 3: 失敗するテストを書く（新しいメール）**

`tests/unit/lib/orders/order-lifecycle-emails.test.ts`:
```ts
const mockSendMail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/mail', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSendMail(...args),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

import {
  sendOrderCanceledEmail,
  sendPaymentExpiredEmail,
  sendShopPaymentAlert,
  sendUnplacedPaymentNotice,
} from '@/lib/orders/order-lifecycle-emails';
import type { OrderEmailSourceStore } from '@/lib/orders/order-confirmation-email';

/**
 * 期限切れ・取消・受付を通らない支払いの案内と、店への要対応メール（設計書 5-3・5-4）。
 * お客様へのメールは1件1回（送信権）。店へのメールに個人情報を入れない。
 */
const ORDER_ID = 'a1b2c3d4-1111-2222-3333-444455556666';

const ORDER_ROW = {
  id: ORDER_ID,
  shipping_email: 'hanako@example.com',
  shipping_full_name: '山田 花子',
  subtotal_amount: 28000,
  shipping_amount: 800,
  discount_amount: 0,
  total_amount: 28800,
  currency: 'jpy',
  shipping_postal_code: '150-0001',
  shipping_prefecture: '東京都',
  shipping_city: '渋谷区',
  shipping_address: '神宮前1-2-3',
  shipping_building: null,
  shipping_phone: '090-1234-5678',
};

const ITEMS = [{ item_name: 'シルクブラウス', color: 'WHITE', size: 'M', quantity: 1, line_total: 28000 }];

function makeStore(options: { claim?: boolean } = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const store = {
    calls,
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return { data: fn === 'claim_order_email' ? options.claim ?? true : true, error: null };
    },
    from(table: string) {
      return {
        select: () => ({
          eq: () =>
            table === 'orders'
              ? { maybeSingle: async () => ({ data: ORDER_ROW, error: null }) }
              : Promise.resolve({ data: ITEMS, error: null }),
        }),
      };
    },
  };
  return store as typeof store & OrderEmailSourceStore;
}

const env = process.env as Record<string, string | undefined>;

beforeEach(() => {
  jest.clearAllMocks();
  mockSendMail.mockResolvedValue(undefined);
  env.MAIL_FROM_ADDRESS = 'noreply@example.com';
  env.SHOP_ALERT_EMAIL = 'shop@example.com';
});

describe('期限切れのお知らせ', () => {
  it('送信権 payment_expired を取って1通送る。件名と本文は固定の文面', async () => {
    const store = makeStore();

    const sent = await sendPaymentExpiredEmail({ store, orderId: ORDER_ID, logLabel: '[test]' });

    expect(sent).toBe(true);
    expect(store.calls[0]).toEqual({ fn: 'claim_order_email', args: { _order_id: ORDER_ID, _kind: 'payment_expired' } });
    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.to).toBe('hanako@example.com');
    expect(mail.subject).toBe('【Le Fil des Heures】お支払い期限切れのお知らせ（ORD-A1B2C3D4）');
    expect(mail.text).toContain('お支払い期限が過ぎたため、ご注文を取り消しました。');
    expect(mail.text).toContain('・シルクブラウス（WHITE / M） x1');
  });

  it('送信権を取れなければ送らない（二重送信しない）', async () => {
    const sent = await sendPaymentExpiredEmail({ store: makeStore({ claim: false }), orderId: ORDER_ID, logLabel: '[test]' });

    expect(sent).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('送れなければ送信権を戻す', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('smtp down'));
    const store = makeStore();

    const sent = await sendPaymentExpiredEmail({ store, orderId: ORDER_ID, logLabel: '[test]' });

    expect(sent).toBe(false);
    expect(store.calls).toContainEqual({ fn: 'release_order_email', args: { _order_id: ORDER_ID, _kind: 'payment_expired' } });
  });

  it('送信元が未設定なら送信権も取らない', async () => {
    delete env.MAIL_FROM_ADDRESS;
    const store = makeStore();

    expect(await sendPaymentExpiredEmail({ store, orderId: ORDER_ID, logLabel: '[test]' })).toBe(false);
    expect(store.calls).toEqual([]);
  });
});

describe('取消のお知らせ', () => {
  it.each([
    ['payment_in_progress', 'お手続き中のご注文を取り消しました。'],
    ['pending', 'お支払い待ちのご注文を取り消しました。'],
  ] as const)('%s の注文は「%s」と書く', async (previousStatus, lead) => {
    const store = makeStore();

    await sendOrderCanceledEmail({ store, orderId: ORDER_ID, previousStatus, logLabel: '[test]' });

    expect(store.calls[0]).toEqual({ fn: 'claim_order_email', args: { _order_id: ORDER_ID, _kind: 'canceled' } });
    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.subject).toBe('【Le Fil des Heures】ご注文取消のお知らせ（ORD-A1B2C3D4）');
    expect(mail.text).toContain(lead);
    expect(mail.text).toContain('お支払いは発生していません。');
  });
});

describe('受付を通らない支払いの案内', () => {
  it('入金済みなら再度の支払いは不要と書く', async () => {
    await sendUnplacedPaymentNotice({ to: 'hanako@example.com', fullName: '山田 花子', state: 'paid' });

    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.subject).toBe('【Le Fil des Heures】ご注文の確認についてのお知らせ');
    expect(mail.text).toContain('お支払いは受け付けました。');
    expect(mail.text).toContain('再度のお支払いは不要です。');
  });

  it('入金待ちなら支払いを控えるよう書く', async () => {
    await sendUnplacedPaymentNotice({ to: 'hanako@example.com', fullName: null, state: 'awaiting_payment' });

    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.text).toContain('お客様');
    expect(mail.text).toContain('お支払いはお控えください。');
  });
});

describe('店への要対応メール', () => {
  const ALERT = {
    reason: 'paid_amount_mismatch' as const,
    detail: null,
    orderId: ORDER_ID,
    paymentRef: 'cs_test_123',
    detectedAt: new Date('2026-09-27T01:00:00.000Z'),
  };

  it('理由・注文番号・Stripe の支払い ID・次にやることを書き、個人情報は入れない', async () => {
    const sent = await sendShopPaymentAlert(ALERT);

    expect(sent).toBe(true);
    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.to).toBe('shop@example.com');
    expect(mail.subject).toBe('【要対応】支払額の違い');
    expect(mail.text).toContain('注文番号: ORD-A1B2C3D4');
    expect(mail.text).toContain('Stripe の支払い: cs_test_123');
    expect(mail.text).toContain('次にやること:');
    expect(mail.text).not.toContain('hanako@example.com');
    expect(mail.text).not.toContain('山田');
  });

  it('SHOP_ALERT_EMAIL が未設定なら送らない（見回りが後で送り直す）', async () => {
    delete env.SHOP_ALERT_EMAIL;

    expect(await sendShopPaymentAlert(ALERT)).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/orders/order-confirmation-email tests/unit/lib/orders/order-lifecycle-emails`
Expected: FAIL（`paidVariant` の本文が無い、`order-lifecycle-emails` が無い）

- [ ] **Step 5: 注文確認メールを変える**

`src/lib/orders/order-confirmation-email.ts` を次のように変える。

import に足す:
```ts
import type { PaidEmailVariant } from '@/lib/orders/order-payment-types';
```
`ConfirmationItem` と `OrderEmailKind` を export し、種類を足す:
```ts
export type ConfirmationItem = {
```
```ts
export type OrderEmailKind = 'awaiting_payment' | 'paid' | 'payment_expired' | 'canceled';
```
`OrderConfirmationParams` の `paymentState?: 'paid' | 'awaiting_payment';` の次に足す:
```ts
  /** 入金済みの書き分け（設計書 5-4）。送信権はどれも paid */
  paidVariant?: PaidEmailVariant;
```
`formatCurrency` を export する:
```ts
export function formatCurrency(amount: number, currency: string): string {
```
`leadLines` を替える:
```ts
  const leadLines = awaitingPayment
    ? [
        'ご注文を承りました。まだお支払いは完了していません。',
        'お支払い手続きの案内は、決済画面および Stripe からのメールをご確認ください。',
        'ご入金の確認後、あらためて確認メールをお送りします。',
      ]
    : params.paidVariant === 'payment_received_after_expiry'
      ? [
          'お支払い期限が過ぎたためご注文の取り消しをご案内しましたが、その後にお支払いを確認しました。',
          'ご注文は有効です。このまま商品をお届けします。',
        ]
      : ['この度はご注文いただき誠にありがとうございます。', 'ご注文を承りました。'];
```
`claimOrderEmail` と `releaseOrderEmail` を export する（中身は変えない）:
```ts
export async function claimOrderEmail(
```
```ts
export async function releaseOrderEmail(
```
`OrderEmailRow` を export し、注文行と明細の取得を関数に切り出す。`sendOrderConfirmationEmailForOrderId` をまるごと次に替える:
```ts
export type OrderEmailSource = { order: OrderEmailRow; items: ConfirmationItem[] };

/**
 * 注文メールの材料（注文行と明細）を引く。明細が引けないときは null（送らない）。
 * 注文確認・期限切れ・取消のメールで同じ列の並びと同じ規則を使う。
 */
export async function fetchOrderEmailSource(
  store: OrderEmailSourceStore,
  orderId: string,
  logLabel: string,
): Promise<OrderEmailSource | null> {
  const { data: orderRow, error: orderError } = await store
    .from('orders')
    .select(ORDER_EMAIL_COLUMNS)
    .eq('id', orderId)
    .maybeSingle<OrderEmailRow>();

  if (orderError || !orderRow) {
    console.error(`${logLabel} failed to fetch order for email`, orderId, orderError);
    return null;
  }

  const { data: orderItems, error: orderItemsError } = await store
    .from('order_items')
    .select('item_name, color, size, quantity, line_total')
    .eq('order_id', orderId);

  // 取得の失敗と0件はどちらも「注文内容を書けない」。商品の行が無いメールは、客には
  // 注文が消えたように見える。送らなければ送信権を取らないので、後の経路が送り直せる。
  if (orderItemsError || !orderItems || orderItems.length === 0) {
    console.error(
      `${logLabel} failed to fetch order_items for email`,
      orderId,
      orderItemsError ?? 'no order_items rows',
    );
    return null;
  }

  return { order: orderRow, items: orderItems as ConfirmationItem[] };
}

/**
 * 注文 ID から注文行と明細を引いて、注文メールを送る。
 *
 * @returns 実際に送ったら true
 */
export async function sendOrderConfirmationEmailForOrderId(params: {
  store: OrderEmailSourceStore;
  orderId: string;
  paymentState: 'awaiting_payment' | 'paid';
  /** ログの頭に付ける呼び出し元の目印（'[webhook]' など） */
  logLabel: string;
  paidVariant?: PaidEmailVariant;
}): Promise<boolean> {
  const { store, orderId, paymentState, logLabel, paidVariant } = params;
  const source = await fetchOrderEmailSource(store, orderId, logLabel);
  if (!source) {
    return false;
  }

  const { order: orderRow, items } = source;
  return sendOrderConfirmationEmail({
    orderId: orderRow.id,
    email: orderRow.shipping_email,
    fullName: orderRow.shipping_full_name,
    items,
    subtotalAmount: orderRow.subtotal_amount,
    shippingAmount: orderRow.shipping_amount,
    // 注文確定 RPC 側の COALESCE と同じく、取れないときは 0 として扱う。
    discountAmount: orderRow.discount_amount ?? 0,
    totalAmount: orderRow.total_amount,
    currency: orderRow.currency,
    shipping: {
      fullName: orderRow.shipping_full_name,
      postalCode: orderRow.shipping_postal_code,
      prefecture: orderRow.shipping_prefecture,
      city: orderRow.shipping_city,
      address: orderRow.shipping_address,
      building: orderRow.shipping_building,
      phone: orderRow.shipping_phone,
    },
    paymentState,
    paidVariant,
    store,
  });
}
```

- [ ] **Step 6: 新しいメールを書く**

`src/lib/orders/order-lifecycle-emails.ts`:
```ts
import sendMail from '@/lib/mail';
import { logAudit } from '@/lib/audit';
import { toOrderNumber } from '@/lib/orders/order-number';
import {
  claimOrderEmail,
  fetchOrderEmailSource,
  formatCurrency,
  releaseOrderEmail,
  type OrderEmailSource,
  type OrderEmailSourceStore,
} from '@/lib/orders/order-confirmation-email';
import {
  PAYMENT_EXCEPTION_REASON_LABELS,
  type PaymentExceptionReason,
} from '@/lib/orders/order-payment-types';

/**
 * 注文の状態が変わったときのお客様へのメールと、店への要対応メール（グループ A 設計書 5-3・5-4）。
 *
 * 件名は固定の文面で組み、外から来た値（氏名・商品名）は本文にだけ入れる（メールヘッダーの注入を防ぐ）。
 * お客様へのメールは送信権（1注文・1種類につき1通）を取ってから送り、送れなければ権利を戻す。
 */
const SHOP_NAME = 'Le Fil des Heures';

function greeting(fullName: string | null): string {
  return fullName ? `${fullName} 様` : 'お客様';
}

function contactLine(orderId: string): string {
  return `お問い合わせの際は、注文番号（${toOrderNumber(orderId)}）をお問い合わせフォームにご入力ください。`;
}

function orderSummaryLines({ order, items }: OrderEmailSource): string[] {
  return [
    `注文番号: ${toOrderNumber(order.id)}`,
    '',
    'ご注文内容:',
    ...items.map((item) => {
      const variant = [item.color, item.size].filter(Boolean).join(' / ');
      const label = variant ? `${item.item_name}（${variant}）` : item.item_name;
      return `・${label} x${item.quantity}　${formatCurrency(item.line_total, order.currency)}`;
    }),
    '',
    `合計: ${formatCurrency(order.total_amount, order.currency)}`,
  ];
}

async function sendClaimedOrderEmail(params: {
  store: OrderEmailSourceStore;
  orderId: string;
  kind: 'payment_expired' | 'canceled';
  logLabel: string;
  compose: (source: OrderEmailSource) => { subject: string; text: string };
}): Promise<boolean> {
  const { store, orderId, kind, logLabel, compose } = params;
  if (!process.env.MAIL_FROM_ADDRESS) {
    return false;
  }

  const source = await fetchOrderEmailSource(store, orderId, logLabel);
  const to = source?.order.shipping_email;
  if (!source || !to) {
    return false;
  }

  if (!(await claimOrderEmail(store, orderId, kind))) {
    return false;
  }

  const { subject, text } = compose(source);
  try {
    await sendMail({ to, subject, text });
    return true;
  } catch (error) {
    console.warn(`${logLabel} order lifecycle mail send failed`, orderId, kind, error);
    await logAudit({
      action: 'order.lifecycle.mail',
      outcome: 'error',
      resource: 'order',
      resource_id: orderId,
      detail: 'mail_send_failed',
      metadata: { kind },
    });
    await releaseOrderEmail(store, orderId, kind);
    return false;
  }
}

/** 払込票の期限切れで失敗にしたとき。支払い方法を問わない文面にする（銀行振込を足しても同じ仕組みに載る） */
export function sendPaymentExpiredEmail(params: {
  store: OrderEmailSourceStore;
  orderId: string;
  logLabel: string;
}): Promise<boolean> {
  return sendClaimedOrderEmail({
    ...params,
    kind: 'payment_expired',
    compose: (source) => ({
      subject: `【${SHOP_NAME}】お支払い期限切れのお知らせ（${toOrderNumber(source.order.id)}）`,
      text: [
        greeting(source.order.shipping_full_name),
        '',
        'お支払い期限が過ぎたため、ご注文を取り消しました。',
        'お支払いは発生していません。引き続きご購入を希望される場合は、あらためてご注文ください。',
        '',
        ...orderSummaryLines(source),
        '',
        contactLine(source.order.id),
        '',
        SHOP_NAME,
      ].join('\n'),
    }),
  });
}

/** 管理画面で未入金の注文を取り消したとき。支払い手続き中の注文では、これが最初のメールになる */
export function sendOrderCanceledEmail(params: {
  store: OrderEmailSourceStore;
  orderId: string;
  previousStatus: 'payment_in_progress' | 'pending';
  logLabel: string;
}): Promise<boolean> {
  const lead =
    params.previousStatus === 'payment_in_progress'
      ? 'お手続き中のご注文を取り消しました。'
      : 'お支払い待ちのご注文を取り消しました。';

  return sendClaimedOrderEmail({
    store: params.store,
    orderId: params.orderId,
    logLabel: params.logLabel,
    kind: 'canceled',
    compose: (source) => ({
      subject: `【${SHOP_NAME}】ご注文取消のお知らせ（${toOrderNumber(source.order.id)}）`,
      text: [
        greeting(source.order.shipping_full_name),
        '',
        lead,
        'お支払いは発生していません。',
        '',
        ...orderSummaryLines(source),
        '',
        contactLine(source.order.id),
        '',
        SHOP_NAME,
      ].join('\n'),
    }),
  });
}

/**
 * 受付を通らない支払いの案内（要対応 order_not_creatable）。注文が無いので注文番号は書かない。
 * 送信権は呼び出し側が payment_exceptions.customer_notified_at で取る。
 */
export async function sendUnplacedPaymentNotice(params: {
  to: string;
  fullName: string | null;
  state: 'paid' | 'awaiting_payment';
}): Promise<boolean> {
  if (!process.env.MAIL_FROM_ADDRESS) {
    return false;
  }

  const lead =
    params.state === 'paid'
      ? ['お支払いは受け付けました。', 'ご注文の登録で確認が必要になりました。担当者からご連絡します。', '再度のお支払いは不要です。']
      : ['ご注文の登録で確認が必要になりました。', 'お支払いはお控えください。担当者からご連絡します。'];

  try {
    await sendMail({
      to: params.to,
      subject: `【${SHOP_NAME}】ご注文の確認についてのお知らせ`,
      text: [greeting(params.fullName), '', ...lead, '', SHOP_NAME].join('\n'),
    });
    return true;
  } catch (error) {
    console.warn('Unplaced payment notice send failed', error);
    await logAudit({
      action: 'order.lifecycle.mail',
      outcome: 'error',
      resource: 'payment_exception',
      detail: 'unplaced_notice_send_failed',
    });
    return false;
  }
}

export type ShopPaymentAlert = {
  reason: PaymentExceptionReason;
  detail: string | null;
  orderId: string | null;
  /** Session ID（無ければ PaymentIntent ID） */
  paymentRef: string;
  detectedAt: Date;
};

const SHOP_ALERT_NEXT_STEPS: Record<PaymentExceptionReason, string> = {
  order_not_creatable:
    'Stripe ダッシュボードで支払いを確かめ、返金するか、お客様に連絡して注文を登録してください。お客様には確認中の案内を送っています。',
  paid_amount_mismatch:
    'Stripe ダッシュボードで支払額を確かめ、差額の返金などを行ってください。解決済みにするまで発送できません。',
  cancelled_order_paid: 'Stripe ダッシュボードで返金してください。',
  state_conflict:
    'Stripe ダッシュボードで支払いの状態を確かめてください。未入金の注文は管理画面の「注文を取り消して解決」で閉じられます。',
  unexpected_state:
    'Stripe ダッシュボードで支払いの状態を確かめてください。未入金の注文は管理画面の「注文を取り消して解決」で閉じられます。',
  stripe_object_missing:
    'Stripe ダッシュボードに支払いがあるか確かめてください。未入金の注文は管理画面の「注文を取り消して解決」で閉じられます。',
};

function formatJst(date: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/**
 * 店への要対応メール。お客様の氏名・住所・メールは入れない（個人情報の最小化）。
 * 送り先は SHOP_ALERT_EMAIL。未設定なら送らず、毎時の見回りが送り直す。
 * ALERT_AUDIT_URL は監査ログを全件転送するので使わない（重要な通知が埋もれる）。
 */
export async function sendShopPaymentAlert(alert: ShopPaymentAlert): Promise<boolean> {
  const to = process.env.SHOP_ALERT_EMAIL;
  if (!to || !process.env.MAIL_FROM_ADDRESS) {
    console.warn('[shop-alert] SHOP_ALERT_EMAIL or MAIL_FROM_ADDRESS is not configured');
    return false;
  }

  const label = PAYMENT_EXCEPTION_REASON_LABELS[alert.reason];
  try {
    await sendMail({
      to,
      subject: `【要対応】${label}`,
      text: [
        '支払いの要対応を検知しました。管理画面の ORDER タブで確認してください。',
        '',
        `理由: ${label}${alert.detail ? `（${alert.detail}）` : ''}`,
        `注文番号: ${alert.orderId ? toOrderNumber(alert.orderId) : 'なし'}`,
        `Stripe の支払い: ${alert.paymentRef}`,
        `検知時刻: ${formatJst(alert.detectedAt)}`,
        '',
        `次にやること: ${SHOP_ALERT_NEXT_STEPS[alert.reason]}`,
      ].join('\n'),
    });
    return true;
  } catch (error) {
    console.warn('[shop-alert] send failed', error);
    await logAudit({
      action: 'payment_exception.shop_alert',
      outcome: 'error',
      resource: 'payment_exception',
      detail: 'mail_send_failed',
      metadata: { reason: alert.reason },
    });
    return false;
  }
}
```

- [ ] **Step 7: 環境変数を書き足す**

`.env.example` の `STRIPE_WEBHOOK_SECRET=` の次の行に足す:
```text
# 支払いの要対応を知らせる店のアドレス（src/lib/orders/order-lifecycle-emails.ts）
SHOP_ALERT_EMAIL=
```
`README.md` の `PENDING_ORDER_EXPIRY_DAYS` の行の次に、同じ表へ1行足す（`PENDING_ORDER_EXPIRY_DAYS` の行は Task 15 で消す）:
```text
  | `SHOP_ALERT_EMAIL` | 支払いの要対応（注文を作れない支払い・支払額の違いなど）を知らせる店のアドレス。未設定なら送らず、毎時の見回りが送り直す |
```

- [ ] **Step 8: テストを通す**

Run: `npx jest tests/unit/lib/orders && npm run typecheck`
Expected: PASS（既存の注文確認メールのテストも通る）

- [ ] **Step 9: FREQ 行を足す**

`docs/2_Specs/spec.md` の表の末尾に足す:
```text
| FREQ-408 | 注文の期限切れ・取消・受付を通らない支払いをお客様にメールで知らせ、要対応を店にメールで知らせること | FREQ-408-REQ-01 | 払込票の期限切れで注文を失敗にしたら「お支払い期限切れのお知らせ」を、管理画面で未入金の注文を取り消し「お客様に取消のお知らせを送る」がオンなら「ご注文取消のお知らせ」を、1注文・1種類につき1通だけ送ること | FREQ-408-REQ-02 | 受付を通らない支払いは、入金済みなら「再度のお支払いは不要」、入金待ちなら「お支払いはお控えください」と案内し、1件1回だけ送ること | FREQ-408-REQ-03 | 要対応は `SHOP_ALERT_EMAIL` へ1件1回送り、お客様の氏名・住所・メールを入れないこと。件名は固定の文面にすること | FREQ-408-AC-01 | 期限切れ・取消・受付を通らない支払いの案内が、それぞれ1回だけ送られること | FREQ-408-AC-02 | 送れなかったら送信権を戻し、後の経路が送り直せること | FREQ-408-AC-03 | 店への要対応メールに理由・注文番号・Stripe の支払い ID・次にやることが書かれ、お客様の個人情報が含まれないこと |
```

- [ ] **Step 10: コミット**

```bash
git add src/lib/orders/order-confirmation-email.ts tests/unit/lib/orders/order-confirmation-email.test.ts src/lib/orders/order-lifecycle-emails.ts tests/unit/lib/orders/order-lifecycle-emails.test.ts .env.example README.md docs/2_Specs/spec.md
git commit -m "feat(orders): 期限切れ・取消・受付を通らない支払いのメールと店への要対応メールを足す

お客様へは送信権で1件1回。店へのメールに個人情報を入れない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: 照合関数（本体）

**Files:**
- Create: `src/lib/stripe/checkout-payment-reconciler.ts`
- Create: `tests/unit/lib/stripe/checkout-payment-reconciler.test.ts`

**Interfaces:**
- Consumes: Task 8 の `decideOrderAction`・`OrderAction`・`StripePaymentState`・型、Task 9 の `CheckoutPaymentSnapshot`（`draftId` は null もある）・`ReconcileTransientError`、Task 10 の `ShopPaymentAlert`（型だけ）
- Produces:
  - `reconcileCheckoutPayment(deps: ReconcilerDeps, input: ReconcileInput): Promise<ReconcileResult>`（起きないマス `state_conflict` はすぐには記録せず、Stripe と注文を読み直して最後の回まで続いたときだけ要対応にする。下書き ID の無い支払いを対象外（記録のみ）にするのは注文が無いときだけで、注文があれば Stripe の状態の行に従う）
  - `notifyShopOfException(deps: Pick<ReconcilerDeps, 'database' | 'mailer'>, exceptionId: string, alert: ShopPaymentAlert): Promise<boolean>`（見回りの送り直しでも使う）
  - `ReconcileTransientError`（Task 9 から再 export）・`MAX_RECONCILE_ATTEMPTS = 3`
  - 型 `ReconcileInput = { checkoutSessionId?; paymentIntentId?; sourceEventId?; adminCancel?: AdminCancelRequest }`、`AdminCancelRequest = { actorId: string; reason: CancelReason; note?: string; notifyCustomer: boolean }`
  - 型 `ReconcileResult`:
    - `{ kind: 'ok'; action; orderId: string | null; orderStatus: OrderStatus | null }`
    - `{ kind: 'needs_review'; action; orderId: string; orderStatus: OrderStatus }`
    - `{ kind: 'needs_action'; exceptionId; reason; orderId: string | null; orderStatus: OrderStatus | null }`
  - 型 `ReconcilerDeps = { readPayment; database: ReconcilerDatabase; mailer: ReconcilerMailer; audit: ReconcilerAudit; now(): Date }`、`ReconcilerDatabase`・`ReconcilerMailer`・`ReconcilerOrder`・`DraftContact`・`PlaceOrderResult`（下の実装のとおり）

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/lib/stripe/checkout-payment-reconciler.test.ts`:
```ts
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
  return { id: 'order-1', status, paymentIntentId: null, checkoutSessionId: 'cs_1', ...overrides };
}

function harness(init: {
  stripe: CheckoutPaymentSnapshot;
  order?: ReconcilerOrder | null;
  amountMatches?: boolean;
  needsReview?: boolean;
}) {
  const world: { stripe: CheckoutPaymentSnapshot; order: ReconcilerOrder | null } = {
    stripe: init.stripe,
    order: init.order ?? null,
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
      return { updated: true, amountMatches: init.amountMatches ?? true, needsReview: init.needsReview ?? false };
    },
    async markOrderAwaitingPayment(args) {
      if (!world.order || world.order.status !== 'payment_in_progress') {
        return { updated: false };
      }
      world.order = { ...world.order, status: 'pending', paymentIntentId: world.order.paymentIntentId ?? args.paymentIntentId };
      return { updated: true };
    },
    async releaseStock(args) {
      if (!world.order || world.order.status !== args.expectedStatus) {
        return { released: false };
      }
      world.order = { ...world.order, status: args.nextStatus };
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
    async sendOrderConfirmation() {
      return true;
    },
    async sendPaymentExpired() {
      return true;
    },
    async sendOrderCanceled() {
      return true;
    },
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
  const deps: ReconcilerDeps = { readPayment, database, mailer, audit, now: () => NOW };
  return { deps, database, mailer, readPayment, audit, world };
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
      sourceEventId: 'evt_1',
    });
    expect(h.mailer.sendOrderConfirmation).toHaveBeenCalledWith('order-1', 'paid', 'order_confirmed');
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
    expect(h.mailer.sendOrderConfirmation).toHaveBeenCalledWith('order-new', 'paid', 'order_confirmed');
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
    expect(h.mailer.sendOrderConfirmation).toHaveBeenCalledWith('order-new', 'awaiting_payment');
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
    expect(h.mailer.sendOrderConfirmation).not.toHaveBeenCalled();
    expect(h.mailer.sendUnplacedPaymentNotice).not.toHaveBeenCalled();
    expect(h.mailer.sendShopAlert).toHaveBeenCalledTimes(1);
  });

  it('失敗の後の入金で在庫を確保し直せなければ要確認を返す（⑤）', async () => {
    const h = harness({ stripe: snapshot(PAID), order: order('failed', { paymentIntentId: 'pi_1' }), needsReview: true });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(h.mailer.sendOrderConfirmation).toHaveBeenCalledWith('order-1', 'paid', 'payment_received_after_expiry');
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
    expect(h.mailer.sendPaymentExpired).toHaveBeenCalledWith('order-1');
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
    // 送るかは送信権が決める（移行前の2件は Task 6 で送信済みとして登録してあるので届かない）
    expect(h.mailer.sendPaymentExpired).toHaveBeenCalledWith('order-legacy');
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
    expect(h.mailer.sendPaymentExpired).not.toHaveBeenCalled();
    expect(h.mailer.sendOrderCanceled).not.toHaveBeenCalled();
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
    expect(h.mailer.sendOrderCanceled).toHaveBeenCalledTimes(notifyCustomer ? 1 : 0);
    expect(result).toMatchObject({ kind: 'ok', orderStatus: 'cancelled' });
  });

  it('取り消した注文への未返金の入金は要対応にし、お客様には案内しない', async () => {
    const h = harness({ stripe: snapshot(PAID), order: order('cancelled', { paymentIntentId: 'pi_1' }) });

    const result = await reconcileCheckoutPayment(h.deps, { checkoutSessionId: 'cs_1' });

    expect(result).toMatchObject({ kind: 'needs_action', reason: 'cancelled_order_paid', orderId: 'order-1' });
    expect(h.mailer.sendUnplacedPaymentNotice).not.toHaveBeenCalled();
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
    expect(h.mailer.sendOrderConfirmation).not.toHaveBeenCalled();
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
    expect(h.mailer.sendOrderConfirmation).not.toHaveBeenCalled();
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
    expect(h.mailer.sendOrderConfirmation).toHaveBeenCalledTimes(1);
    expect(h.world.order?.status).toBe('paid');
  });

  it('Session ID も PaymentIntent ID も無ければ呼び出しの誤りとして投げる', async () => {
    const h = harness({ stripe: snapshot(PAID) });

    await expect(reconcileCheckoutPayment(h.deps, {})).rejects.toThrow('checkoutSessionId or paymentIntentId is required');
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/stripe/checkout-payment-reconciler`
Expected: FAIL（`Cannot find module '@/lib/stripe/checkout-payment-reconciler'`）

- [ ] **Step 3: 実装する**

`src/lib/stripe/checkout-payment-reconciler.ts`:
```ts
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
```

- [ ] **Step 4: テストを通す**

Run: `npx jest tests/unit/lib/stripe/checkout-payment-reconciler && npm run typecheck`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/stripe/checkout-payment-reconciler.ts tests/unit/lib/stripe/checkout-payment-reconciler.test.ts
git commit -m "feat(stripe): 注文を Stripe の現在の支払い状態に合わせる照合関数を足す

読む → 判定 → 条件付き更新 → 読み直し（最大3回）。要対応は1回だけ記録と通知をする。
起きない組み合わせは読み直してから記録する。下書き ID の無い支払いは、注文が無いときだけ対象外にする。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: 照合関数の既定の依存（Supabase・Stripe・メール・監査ログ）

**Files:**
- Create: `src/lib/stripe/checkout-payment-reconciler-deps.ts`
- Create: `tests/unit/lib/stripe/checkout-payment-reconciler-deps.test.ts`

**Interfaces:**
- Consumes: Task 4〜6 の RPC、Task 9 の `readCheckoutPayment`、Task 10 のメール、Task 11 の型
- Produces:
  - `createSupabaseReconcilerDatabase(client: SupabaseClient): ReconcilerDatabase`（Supabase のエラーは、接続・タイムアウト・デッドロック・直列化の失敗だけ `ReconcileTransientError('db_unavailable')` にし、それ以外は元のエラーのまま投げる）
  - `isTransientSupabaseError(error: unknown): boolean`（その判定。code が無い・SQLSTATE の 08 系・`40001`・`40P01`・53 系・`57014`・`57P01`〜`57P03`・`PGRST000`〜`PGRST002` だけ true）
  - `createReconcilerMailer(client: SupabaseClient): ReconcilerMailer`
  - `createDefaultReconcilerDeps(): Promise<ReconcilerDeps>`（service role の Supabase と `getStripeServerClient()` をつなぐ）
  - `listUnsentShopAlerts(client: SupabaseClient, limit: number): Promise<UnsentShopAlert[]>`（見回りの送り直し。Task 15 が使う）と `type UnsentShopAlert = { exceptionId: string; alert: ShopPaymentAlert }`

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/lib/stripe/checkout-payment-reconciler-deps.test.ts`:
```ts
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
  it.each([undefined, '', '08006', '40001', '40P01', '53300', '57014', '57P01', '57P03', 'PGRST000', 'PGRST002'])(
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
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/stripe/checkout-payment-reconciler-deps`
Expected: FAIL（`Cannot find module '@/lib/stripe/checkout-payment-reconciler-deps'`）

- [ ] **Step 3: 実装する**

`src/lib/stripe/checkout-payment-reconciler-deps.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/audit';
import {
  findMissingShippingFields,
  type CheckoutShippingSnapshot,
} from '@/features/checkout/services/checkout-draft.service';
import { sendOrderConfirmationEmailForOrderId } from '@/lib/orders/order-confirmation-email';
import {
  sendOrderCanceledEmail,
  sendPaymentExpiredEmail,
  sendShopPaymentAlert,
  sendUnplacedPaymentNotice,
  type ShopPaymentAlert,
} from '@/lib/orders/order-lifecycle-emails';
import {
  PAYMENT_EXCEPTION_REASONS,
  PLACE_ORDER_REJECTIONS,
  type OrderStatus,
  type PaymentExceptionReason,
  type PlaceOrderRejection,
} from '@/lib/orders/order-payment-types';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { getStripeServerClient } from '@/lib/stripe/server';
import {
  ReconcileTransientError,
  readCheckoutPayment,
  type CheckoutPaymentStripeClient,
} from '@/lib/stripe/checkout-payment-reader';
import type {
  ReconcilerAudit,
  ReconcilerDatabase,
  ReconcilerDeps,
  ReconcilerMailer,
} from '@/lib/stripe/checkout-payment-reconciler';

// 照合関数の既定の依存（設計書 2-1）。注文・在庫・要対応は service_role 専用の RPC だけで書く。
// 直接 UPDATE するのは、注文詳細の表示に使う下書きの支払方法（persistDraftPaymentMethod）だけ。

/**
 * Supabase のエラーが一時的な失敗か（設計書 5-1）。接続・タイムアウト・デッドロック・直列化の失敗だけを一時的とみなす。
 * code が無い（空）のは通信の失敗。SQLSTATE の 08 系（接続）・40001（直列化）・40P01（デッドロック）・53 系（資源不足）・
 * 57014（文の取り消し・タイムアウト）・57P01〜57P03（DB の停止・起動中）と、PostgREST の PGRST000〜PGRST002（DB に接続できない）。
 */
export function isTransientSupabaseError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== 'string' || code === '') {
    return true;
  }
  return (
    code.startsWith('08')
    || code.startsWith('53')
    || ['40001', '40P01', '57014', '57P01', '57P02', '57P03', 'PGRST000', 'PGRST001', 'PGRST002'].includes(code)
  );
}

/** 一時的な失敗は ReconcileTransientError にして投げ（呼び出し元がイベントを再試行する）、それ以外は元のエラーのまま投げる */
function throwSupabaseError(error: unknown): never {
  if (isTransientSupabaseError(error)) {
    throw new ReconcileTransientError('db_unavailable', { cause: error });
  }
  throw error;
}

function firstRow<T>(data: unknown): T | null {
  const row = Array.isArray(data) ? data[0] : data;
  return (row ?? null) as T | null;
}

function isPlaceOrderRejection(value: unknown): value is PlaceOrderRejection {
  return typeof value === 'string' && (PLACE_ORDER_REJECTIONS as readonly string[]).includes(value);
}

function isPaymentExceptionReason(value: unknown): value is PaymentExceptionReason {
  return typeof value === 'string' && (PAYMENT_EXCEPTION_REASONS as readonly string[]).includes(value);
}

type OrderLookupRow = {
  id: string;
  status: OrderStatus;
  payment_intent_id: string | null;
  checkout_session_id: string | null;
  total_amount: number;
  currency: string;
};

export function createSupabaseReconcilerDatabase(client: SupabaseClient): ReconcilerDatabase {
  async function callRpc<T>(fn: string, args: Record<string, unknown>): Promise<T | null> {
    const { data, error } = await client.rpc(fn, args);
    if (error) throwSupabaseError(error);
    return firstRow<T>(data);
  }

  return {
    async findOrder({ checkoutSessionId, paymentIntentId }) {
      const lookups: Array<['checkout_session_id' | 'payment_intent_id', string | null]> = [
        ['checkout_session_id', checkoutSessionId],
        ['payment_intent_id', paymentIntentId],
      ];

      for (const [column, value] of lookups) {
        if (!value) continue;
        const { data, error } = await client
          .from('orders')
          .select('id, status, payment_intent_id, checkout_session_id, total_amount, currency')
          .eq(column, value)
          .maybeSingle<OrderLookupRow>();
        if (error) throwSupabaseError(error);
        if (data) {
          return {
            id: data.id,
            status: data.status,
            paymentIntentId: data.payment_intent_id,
            checkoutSessionId: data.checkout_session_id,
            totalAmount: data.total_amount,
            currency: data.currency,
          };
        }
      }

      return null;
    },

    async placeOrder(args) {
      const row = await callRpc<{
        order_id: string | null;
        order_status: OrderStatus | null;
        created: boolean;
        rejection: string | null;
      }>('place_order_from_checkout_draft', {
        _draft_id: args.draftId,
        _checkout_session_id: args.checkoutSessionId,
        _cart_session_id: args.cartSessionId,
        _stripe_amount_total: args.amountTotal,
        _stripe_amount_discount: args.amountDiscount,
        _stripe_currency: args.currency,
        _checkout_session_created_at: args.sessionCreatedAt.toISOString(),
        _payment_intent_id: args.paymentIntentId,
      });

      if (row?.order_id && row.order_status) {
        return { placed: true, orderId: row.order_id, orderStatus: row.order_status, created: row.created === true };
      }
      const rejection = row?.rejection;
      if (isPlaceOrderRejection(rejection)) {
        return { placed: false, rejection };
      }
      throw new Error('Unexpected place_order_from_checkout_draft result');
    },

    async markOrderPaid(args) {
      const row = await callRpc<{ updated: boolean; amount_matches: boolean | null; needs_review: boolean | null }>(
        'mark_order_paid',
        {
          _order_id: args.orderId,
          _expected_status: args.expectedStatus,
          _payment_intent_id: args.paymentIntentId,
          _paid_amount: args.paidAmount,
          _paid_currency: args.paidCurrency,
          _source_event_id: args.sourceEventId,
        },
      );
      return {
        updated: row?.updated === true,
        amountMatches: row?.amount_matches === true,
        needsReview: row?.needs_review === true,
      };
    },

    async markOrderAwaitingPayment(args) {
      const row = await callRpc<{ updated: boolean }>('mark_order_awaiting_payment', {
        _order_id: args.orderId,
        _payment_intent_id: args.paymentIntentId,
        _source_event_id: args.sourceEventId,
      });
      return { updated: row?.updated === true };
    },

    async releaseStock(args) {
      const row = await callRpc<{ released: boolean }>('release_stock_for_unpaid_order', {
        _order_id: args.orderId,
        _expected_status: args.expectedStatus,
        _next_status: args.nextStatus,
        _change_reason: args.changeReason,
        _actor_id: args.actorId,
        _source_event_id: args.sourceEventId,
        _cancel_reason: args.cancelReason,
        _cancel_note: args.cancelNote,
        _notify_customer: args.notifyCustomer,
      });
      return { released: row?.released === true };
    },

    async recordException(args) {
      const row = await callRpc<{ exception_id: string; is_new: boolean; is_resolved: boolean }>(
        'record_payment_exception',
        {
          _payment_ref: args.paymentRef,
          _reason: args.reason,
          _detail: args.detail,
          _checkout_session_id: args.checkoutSessionId,
          _payment_intent_id: args.paymentIntentId,
          _draft_id: args.draftId,
          _order_id: args.orderId,
        },
      );
      if (!row?.exception_id) {
        throw new Error('Unexpected record_payment_exception result');
      }
      return { exceptionId: row.exception_id, isNew: row.is_new === true, isResolved: row.is_resolved === true };
    },

    async claimExceptionNotification(exceptionId, channel) {
      const { data, error } = await client.rpc('claim_payment_exception_notification', {
        _exception_id: exceptionId,
        _channel: channel,
      });
      if (error) throwSupabaseError(error);
      return data === true;
    },

    async releaseExceptionNotification(exceptionId, channel) {
      const { error } = await client.rpc('release_payment_exception_notification', {
        _exception_id: exceptionId,
        _channel: channel,
      });
      if (error) {
        console.error('[reconcile] failed to release exception notification claim', exceptionId, channel, error);
      }
    },

    async findDraftContact(draftId) {
      const { data, error } = await client
        .from('checkout_drafts')
        .select('shipping_snapshot')
        .eq('id', draftId)
        .maybeSingle<{ shipping_snapshot: CheckoutShippingSnapshot | null }>();
      if (error) throwSupabaseError(error);
      if (!data) return null;

      return {
        email: data.shipping_snapshot?.email ?? null,
        fullName: data.shipping_snapshot?.fullName ?? null,
        missingShippingFields: findMissingShippingFields(data.shipping_snapshot),
      };
    },

    async persistDraftPaymentMethod(draftId, paymentMethod) {
      const { error } = await client.from('checkout_drafts').update({ payment_method: paymentMethod }).eq('id', draftId);
      if (error) {
        // 注文は成立しているので止めない。注文詳細の支払方法の表示だけが古くなる
        console.error('[reconcile] failed to persist payment_method on checkout draft', draftId, error);
        await logAudit({
          action: 'checkout.payment.reconcile',
          resource: 'checkout_drafts',
          resource_id: draftId,
          outcome: 'error',
          detail: 'Failed to persist payment_method on checkout draft',
          metadata: { error_message: error.message ?? null },
        });
      }
    },
  };
}

export function createReconcilerMailer(client: SupabaseClient): ReconcilerMailer {
  return {
    sendOrderConfirmation: (orderId, paymentState, paidVariant) =>
      sendOrderConfirmationEmailForOrderId({ store: client, orderId, paymentState, paidVariant, logLabel: '[reconcile]' }),
    sendPaymentExpired: (orderId) => sendPaymentExpiredEmail({ store: client, orderId, logLabel: '[reconcile]' }),
    sendOrderCanceled: (orderId, previousStatus) =>
      sendOrderCanceledEmail({ store: client, orderId, previousStatus, logLabel: '[reconcile]' }),
    sendUnplacedPaymentNotice,
    sendShopAlert: sendShopPaymentAlert,
  };
}

const reconcileAudit: ReconcilerAudit = (event) =>
  logAudit({
    action: 'checkout.payment.reconcile',
    resource: 'orders',
    outcome: event.outcome,
    detail: event.detail,
    metadata: event.metadata,
  });

export async function createDefaultReconcilerDeps(): Promise<ReconcilerDeps> {
  const client = await createServiceRoleClient();
  const stripe = getStripeServerClient() as unknown as CheckoutPaymentStripeClient;

  return {
    readPayment: (ref) => readCheckoutPayment(stripe, ref),
    database: createSupabaseReconcilerDatabase(client),
    mailer: createReconcilerMailer(client),
    audit: reconcileAudit,
    now: () => new Date(),
  };
}

export type UnsentShopAlert = { exceptionId: string; alert: ShopPaymentAlert };

/** 店へ未送信の未解決の要対応（毎時の見回りが送り直す。設計書 5-3） */
export async function listUnsentShopAlerts(client: SupabaseClient, limit: number): Promise<UnsentShopAlert[]> {
  const { data, error } = await client
    .from('payment_exceptions')
    .select('id, reason, detail, order_id, payment_ref, first_detected_at')
    .is('shop_notified_at', null)
    .is('resolved_at', null)
    .order('first_detected_at', { ascending: true })
    .limit(limit);
  if (error) throwSupabaseError(error);

  return (data ?? []).flatMap((row: {
    id: string;
    reason: string;
    detail: string | null;
    order_id: string | null;
    payment_ref: string;
    first_detected_at: string;
  }) =>
    isPaymentExceptionReason(row.reason)
      ? [{
          exceptionId: row.id,
          alert: {
            reason: row.reason,
            detail: row.detail,
            orderId: row.order_id,
            paymentRef: row.payment_ref,
            detectedAt: new Date(row.first_detected_at),
          },
        }]
      : [],
  );
}
```

- [ ] **Step 4: テストを通す**

Run: `npx jest tests/unit/lib/stripe/checkout-payment-reconciler-deps && npm run typecheck`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/stripe/checkout-payment-reconciler-deps.ts tests/unit/lib/stripe/checkout-payment-reconciler-deps.test.ts
git commit -m "feat(stripe): 照合関数を Supabase の RPC・Stripe・メールへつなぐ

接続・タイムアウトなど一時的な Supabase のエラーだけを一時的な失敗として投げ、
呼び出し元が再試行する。それ以外は元のエラーのまま投げる。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: Webhook の決済系イベントを照合関数へ

**Files:**
- Modify: `src/lib/stripe/webhook-processor.ts`（ファイル全体を下の内容に置き換える）
- Modify: `tests/unit/api/webhook/stripe-route.test.ts`
- Modify: `docs/2_Specs/spec.md`（FREQ 行）

**Interfaces:**
- Consumes: Task 11 の `reconcileCheckoutPayment`・`ReconcileInput`、Task 12 の `createDefaultReconcilerDeps`
- Produces: `processStripeWebhookEvent(event, auditRequest)` の外形は変えない。決済系6種は `reconcileCheckoutPayment(deps, { checkoutSessionId | paymentIntentId, sourceEventId: event.id })` を呼ぶだけになる

- [ ] **Step 1: FREQ の番号を確かめる**

Run: `grep -oE "FREQ-[0-9]+" docs/2_Specs/spec.md | sort -t- -k2 -n | tail -1`
Expected: `FREQ-408`（違えば FREQ-409 を次の番号に読み替える）

- [ ] **Step 2: テストを書き換える**

`tests/unit/api/webhook/stripe-route.test.ts` を次のように変える。

1. `jest.mock('@/lib/orders/order-confirmation-email', ...)` のブロックの次に足す:
```ts
// 決済系のイベントは照合関数へ ID を渡すだけ。照合の中身は checkout-payment-reconciler.test.ts が確かめる。
const mockReconcile = jest.fn();
const mockReconcilerDeps = { name: 'reconciler-deps' };
jest.mock('@/lib/stripe/checkout-payment-reconciler', () => ({
  reconcileCheckoutPayment: (...args: unknown[]) => mockReconcile(...args),
}));
jest.mock('@/lib/stripe/checkout-payment-reconciler-deps', () => ({
  createDefaultReconcilerDeps: async () => mockReconcilerDeps,
}));
```
2. `describe('Stripe webhook business processor'` の `beforeEach` の先頭（`jest.clearAllMocks();` の次）に足す:
```ts
    mockReconcile.mockResolvedValue({ kind: 'ok', action: { type: 'none' }, orderId: null, orderStatus: null });
```
3. 次の4つだけを残し、ほかの `it(...)`・`it.each(...)` はすべて消す（どれも旧来の確定 RPC・在庫復元 RPC・直接 UPDATE・メール・割引の同期を確かめていた）:
   - `it('refund.updatedで成功済み返金累計をCAS RPCへ同期する'`
   - `it('refund.failedでStripe現在値から返金投影と会計を再同期する'`
   - `it('返金投影が3回競合したら処理を失敗させ、workerの再試行対象にする'`
   - `it.each([...])('%sを会計同期へ1回だけ渡す'`
4. `describe` の末尾に足す:
```ts
  it.each([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
    'checkout.session.expired',
  ])('%s は Session ID とイベント ID を照合関数へ渡すだけで、注文を直接書かない', async (type) => {
    const event = { id: `evt_${type}`, type, data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 5000 } } };

    const response = await processForTest(makeRequest(event));

    expect(response.status).toBe(200);
    expect(mockReconcile).toHaveBeenCalledWith(mockReconcilerDeps, { checkoutSessionId: 'cs_1', sourceEventId: `evt_${type}` });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockOrdersUpdate).not.toHaveBeenCalled();
  });

  it.each(['payment_intent.succeeded', 'payment_intent.payment_failed'])(
    '%s は PaymentIntent ID を照合関数へ渡すだけで、失敗イベントだけでは在庫を戻さない（R-02）',
    async (type) => {
      const event = { id: `evt_${type}`, type, data: { object: { id: 'pi_1', status: 'requires_payment_method', metadata: {} } } };

      const response = await processForTest(makeRequest(event));

      expect(response.status).toBe(200);
      expect(mockReconcile).toHaveBeenCalledWith(mockReconcilerDeps, { paymentIntentId: 'pi_1', sourceEventId: `evt_${type}` });
      expect(mockRpc).not.toHaveBeenCalledWith('release_stock_for_unpaid_order', expect.anything());
    },
  );

  it('同じ支払いのイベントが順不同・重複で届いても、照合関数へは同じ Session を渡す（R-01）', async () => {
    const succeeded = { id: 'evt_1', type: 'checkout.session.async_payment_succeeded', data: { object: { id: 'cs_1' } } };
    const completed = { id: 'evt_2', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } };

    await processForTest(makeRequest(succeeded));
    await processForTest(makeRequest(completed));
    await processForTest(makeRequest(succeeded));

    expect(mockReconcile.mock.calls.map(([, input]) => input.checkoutSessionId)).toEqual(['cs_1', 'cs_1', 'cs_1']);
  });

  it('要対応になった支払いもイベントは完了にする（永久に再試行しない）', async () => {
    mockReconcile.mockResolvedValue({
      kind: 'needs_action',
      exceptionId: 'exception-1',
      reason: 'order_not_creatable',
      orderId: null,
      orderStatus: null,
    });
    const event = { id: 'evt_completed', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } };

    expect((await processForTest(makeRequest(event))).status).toBe(200);
  });

  it('照合の一時的な失敗はイベントを失敗にし、worker に再試行させる', async () => {
    mockReconcile.mockRejectedValue(Object.assign(new Error('temporarily unavailable'), { code: 'stripe_unavailable' }));
    const event = { id: 'evt_completed', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } };

    expect((await processForTest(makeRequest(event))).status).toBe(500);
  });
```
5. `beforeEach` の `mockFrom.mockImplementation(...)` を、返金の同期が使う `orders` の分岐だけにする（`order-refund-sync.ts` は `from('orders').select(...).eq('payment_intent_id', ...).maybeSingle()` だけを使う）:
```ts
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') {
        return {
          update: mockOrdersUpdate,
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockImplementation(() =>
                Promise.resolve({ data: orderLookupData, error: null })
              ),
            }),
          }),
        };
      }

      return {};
    });
```
6. 消したテストと 5. でしか使っていなかった宣言（`COMPLETE_SHIPPING_SNAPSHOT`・`draftShippingSnapshot`・`orderRowForEmail`・`ordersUpdateSelectResult`・`orderItemsSelectResult`・`orderItemsSelectError`・`checkoutDraftsUpdateMock`・`mockRetrieveCheckoutSession`・`mockRetrievePaymentIntent`・`mockListCheckoutSessions`・`mockSendOrderConfirmationEmail` と、その `jest.mock` の中の参照・`beforeEach` 内の初期化）を消す。`npx eslint tests/unit/api/webhook/stripe-route.test.ts` で未使用の宣言が残っていないことを確かめる

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `npx jest tests/unit/api/webhook/stripe-route`
Expected: FAIL（照合関数が呼ばれず、旧来の処理が RPC を呼ぶ）

- [ ] **Step 4: webhook-processor を書き換える**

`src/lib/stripe/webhook-processor.ts` の全体を次に置き換える（返金・会計同期・監査ログはそのまま残し、注文確定・割引の同期・在庫復元・直接 UPDATE のコードを消す）:
```ts
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { getStripeServerClient } from '@/lib/stripe/server';
import { logAudit } from '@/lib/audit';
import {
  syncOrderRefunds,
  type OrderRefundDatabase,
  type RefundListClient,
} from '@/lib/stripe/order-refund-sync';
import {
  syncPaymentIntentAccounting,
  syncPayoutAccounting,
  syncRefundAccounting,
} from '@/lib/stripe/accounting-sync';
import { createStripeAccountingDatabase } from '@/lib/stripe/supabase-accounting-database';
import { reconcileCheckoutPayment, type ReconcileInput } from '@/lib/stripe/checkout-payment-reconciler';
import { createDefaultReconcilerDeps } from '@/lib/stripe/checkout-payment-reconciler-deps';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }

  return request.headers.get('x-real-ip');
}

async function logWebhookAudit(
  request: NextRequest,
  action: string,
  outcome: 'success' | 'failure' | 'error' | 'conflict',
  detail: string,
  metadata?: Record<string, unknown>
) {
  await logAudit({
    action,
    resource: 'stripe_webhook',
    outcome,
    detail,
    ip: getClientIp(request),
    user_agent: request.headers.get('user-agent'),
    metadata,
  });
}

/**
 * 決済系のイベントは、Session か PaymentIntent の ID だけを取り出して照合関数へ渡す（設計書 2-2）。
 * イベントの中身（状態・金額）は判定に使わず、Stripe の現在値だけで決める（R-01・R-02）。
 * 要対応・要確認は照合関数が記録と通知まで済ませるので、イベントは完了にする。
 * 一時的な失敗（ReconcileTransientError）は投げ直し、worker がイベントを失敗にして再試行する。
 */
async function reconcilePaymentEvent(input: ReconcileInput): Promise<void> {
  await reconcileCheckoutPayment(await createDefaultReconcilerDeps(), input);
}

function resolvePaymentIntentId(
  value: string | Stripe.PaymentIntent | null | undefined,
): string | null {
  if (typeof value === 'string') return value;
  return value?.id ?? null;
}

async function handleRefundChanged(
  object: Stripe.Refund | Stripe.Charge,
  stripe: Stripe,
): Promise<void> {
  const paymentIntentId = resolvePaymentIntentId(object.payment_intent);
  if (!paymentIntentId) {
    throw new Error('Stripe refund event is missing payment_intent');
  }

  await syncOrderRefunds({
    database: supabase as unknown as OrderRefundDatabase,
    stripe: stripe as unknown as RefundListClient,
    paymentIntentId,
  });
}

type AccountingStripeClient = Parameters<typeof syncPayoutAccounting>[0]['stripe'];

/**
 * 注文更新とは独立に、Stripe原始記録（Balance Transaction / Refund / Payout）を同期する。
 */
async function syncAccountingForEvent(event: Stripe.Event, stripe: Stripe): Promise<void> {
  const database = createStripeAccountingDatabase(supabase);
  const client = stripe as unknown as AccountingStripeClient;
  const object = event.data.object as { id?: string };
  if (!object?.id) {
    return;
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      await syncPaymentIntentAccounting({ stripe: client, database, paymentIntentId: object.id });
      break;
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
      await syncRefundAccounting({ stripe: client, database, refundId: object.id });
      break;
    case 'payout.paid':
    case 'payout.failed':
    case 'payout.reconciliation_completed':
      await syncPayoutAccounting({ stripe: client, database, payoutId: object.id });
      break;
    default:
      break;
  }
}

export async function processStripeWebhookEvent(
  event: Stripe.Event,
  auditRequest: NextRequest,
): Promise<void> {
  const stripe = getStripeServerClient();

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      await reconcilePaymentEvent({
        checkoutSessionId: (event.data.object as Stripe.Checkout.Session).id,
        sourceEventId: event.id,
      });
      break;
    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed':
      await reconcilePaymentEvent({
        paymentIntentId: (event.data.object as Stripe.PaymentIntent).id,
        sourceEventId: event.id,
      });
      break;
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
      await handleRefundChanged(event.data.object as Stripe.Refund, stripe);
      break;
    case 'charge.refunded':
      await handleRefundChanged(event.data.object as Stripe.Charge, stripe);
      break;
    default:
      break;
  }

  await syncAccountingForEvent(event, stripe);
  await logWebhookAudit(
    auditRequest,
    'checkout.webhook.event_processing',
    'success',
    'Webhook event processed',
    { event_id: event.id, event_type: event.type },
  );
}
```

- [ ] **Step 5: テストを通す**

Run: `npx jest tests/unit/api/webhook tests/unit/api/cron/process-stripe-webhooks-route && npm run typecheck && npx eslint src/lib/stripe/webhook-processor.ts tests/unit/api/webhook/stripe-route.test.ts`
Expected: PASS、lint の指摘なし

- [ ] **Step 6: FREQ 行を足す**

`docs/2_Specs/spec.md` の表の末尾に足す:
```text
| FREQ-409 | 注文と在庫を Stripe の現在の支払い状態に合わせる照合を1つにまとめ、Webhook の順番・重複・同時実行で結果が変わらないようにすること（R-01・R-02・R-43） | FREQ-409-REQ-01 | 照合関数は Stripe の Session と PaymentIntent を読み、判定表（設計書 3-2）で行動を1つ決め、今の状態を条件にした RPC で反映し、読み直して収まるまで最大3回くり返すこと。イベントの種類と届いた順番は判定に使わないこと | FREQ-409-REQ-02 | Webhook の決済系6種・完了 API・毎時の見回り・管理画面の取消は、照合関数を呼ぶだけにすること。状態を変える RPC に Stripe のイベント ID を渡して注文履歴に残すこと | FREQ-409-REQ-03 | 仕組みで起きない組み合わせ・注文を作れない支払い・支払額の違いは要対応として記録し（同じ支払い・同じ理由は1行）、店へ1回知らせること。Stripe の通信・DB の失敗・3回で収まらないときは一時的な失敗としてイベントを再試行させること | FREQ-409-AC-01 | 判定表の全マス（Stripe の状態8行 × 注文なしと7状態）が単体テストで確かめられていること | FREQ-409-AC-02 | 同じ支払いを同時に2回照合しても、入金済みにする更新とメールが1回だけであること | FREQ-409-AC-03 | `payment_intent.payment_failed` だけでは在庫を戻さないこと |
```

- [ ] **Step 7: コミット**

```bash
git add src/lib/stripe/webhook-processor.ts tests/unit/api/webhook/stripe-route.test.ts docs/2_Specs/spec.md
git commit -m "refactor(webhook): 決済系イベントを照合関数に任せる

イベントの中身は ID だけ使い、Stripe の現在値で判定する（R-01・R-02）。
注文の直接 UPDATE と割引の同期（R-26）を消す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 14: 完了 API を照合関数へ

**Files:**
- Modify: `src/app/api/checkout/complete/route.ts`（ファイル全体を下の内容に置き換える）
- Modify: `tests/unit/api/checkout/complete-route.test.ts`（ファイル全体を下の内容に置き換える）

**Interfaces:**
- Consumes: Task 11・12
- Produces: 画面との入出力は変えない（`POST { checkoutSessionId, paymentMethod?, shipping? }` → `200 { orderId, status, paymentMethod }`）。新しく `409 { error: 'Order could not be registered' }`（注文が無い・有効でない）と `503 { error: 'Temporarily unavailable' }`（一時的な失敗）を返す。画面はどちらも今の「注文確定に失敗しました」を出す

- [ ] **Step 1: テストをまるごと書き換える**

`tests/unit/api/checkout/complete-route.test.ts` の全体を次に置き換える:
```ts
import { NextRequest } from 'next/server';

jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn((body: unknown, init?: { status?: number }) => ({
        body,
        status: init?.status ?? 200,
      })),
    },
  };
});

const mockFrom = jest.fn();
const mockGetUser = jest.fn();
const mockLogAudit = jest.fn().mockResolvedValue(undefined);

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({ from: mockFrom, auth: { getUser: mockGetUser } }),
}));

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockRetrieveCheckoutSession = jest.fn();
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: jest.fn().mockReturnValue({
    checkout: { sessions: { retrieve: mockRetrieveCheckoutSession } },
  }),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockExtractAuthToken = jest.fn();
jest.mock('@/lib/auth/request-token', () => ({
  extractAuthToken: (...args: unknown[]) => mockExtractAuthToken(...args),
}));

// 注文の作成・状態の変更・メールは照合関数が持つ（checkout-payment-reconciler.test.ts が確かめる）。
const mockReconcile = jest.fn();
const mockReconcilerDeps = { name: 'reconciler-deps' };
jest.mock('@/lib/stripe/checkout-payment-reconciler', () => ({
  reconcileCheckoutPayment: (...args: unknown[]) => mockReconcile(...args),
  ReconcileTransientError: jest.requireActual('@/lib/stripe/checkout-payment-reader').ReconcileTransientError,
}));
jest.mock('@/lib/stripe/checkout-payment-reconciler-deps', () => ({
  createDefaultReconcilerDeps: async () => mockReconcilerDeps,
}));

import { POST } from '@/app/api/checkout/complete/route';
import { ReconcileTransientError } from '@/lib/stripe/checkout-payment-reader';

type RouteResponse = { status: number; body: Record<string, unknown> };

function makeRequest(body: Record<string, unknown>, sessionId = 'sess-abc'): NextRequest {
  const req = new NextRequest('http://localhost/api/checkout/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  Object.defineProperty(req, 'cookies', {
    value: { get: (name: string) => (name === 'session_id' && sessionId ? { value: sessionId } : undefined) },
  });

  return req;
}

async function post(body: Record<string, unknown> = { checkoutSessionId: 'cs_test' }, sessionId?: string) {
  return (await POST(makeRequest(body, sessionId))) as unknown as RouteResponse;
}

function stripeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test',
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    currency: 'jpy',
    amount_total: 5500,
    total_details: { amount_discount: 0 },
    metadata: { session_id: 'sess-abc', selected_payment_method: 'stripe_card', draft_id: 'draft-123' },
    payment_intent: {
      id: 'pi_test',
      payment_method_types: ['card'],
      latest_charge: { payment_method_details: { type: 'card' } },
    },
    ...overrides,
  };
}

let orderOwner: { user_id: string | null } | null = null;
let ordersUpdate: jest.Mock;

function setupSupabase(draft: { id: string; session_id: string } | null = { id: 'draft-123', session_id: 'sess-abc' }) {
  ordersUpdate = jest.fn().mockReturnValue({
    eq: jest.fn().mockReturnValue({
      is: jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue({ data: [{ id: 'order-1' }], error: null }),
      }),
    }),
  });

  mockFrom.mockImplementation((table: string) => {
    if (table === 'checkout_drafts') {
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            maybeSingle: jest.fn().mockResolvedValue({ data: draft, error: null }),
          }),
        }),
      };
    }

    if (table === 'orders') {
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            maybeSingle: jest.fn().mockImplementation(async () => ({ data: orderOwner, error: null })),
          }),
        }),
        update: ordersUpdate,
      };
    }

    return {};
  });
}

describe('POST /api/checkout/complete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    orderOwner = { user_id: null };
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockExtractAuthToken.mockReturnValue(null);
    mockRetrieveCheckoutSession.mockResolvedValue(stripeSession());
    mockReconcile.mockResolvedValue({
      kind: 'ok',
      action: { type: 'mark_paid', expectedStatus: 'payment_in_progress', emailVariant: 'order_confirmed' },
      orderId: 'order-1',
      orderStatus: 'paid',
    });
    setupSupabase();
  });

  test('session_id Cookie がない場合は 400 を返す', async () => {
    expect((await post({ checkoutSessionId: 'cs_test' }, '')).status).toBe(400);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('bank 決済と空の Session ID は入力の誤りとして 400 を返す', async () => {
    expect((await post({ paymentMethod: 'bank', checkoutSessionId: 'cs_test' })).status).toBe(400);
    expect((await post({ checkoutSessionId: '' })).status).toBe(400);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('決済完了の Session は照合関数に任せ、注文 ID・状態・支払方法を返す', async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orderId: 'order-1', status: 'paid', paymentMethod: 'stripe_card' });
    expect(mockReconcile).toHaveBeenCalledWith(mockReconcilerDeps, { checkoutSessionId: 'cs_test' });
    expect(mockRetrieveCheckoutSession).toHaveBeenCalledWith('cs_test', {
      expand: ['payment_intent', 'payment_intent.payment_method', 'payment_intent.latest_charge'],
    });
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'checkout:complete' }));
  });

  test('払込票を発行した Session は入金待ちの注文を返す', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue(stripeSession({ payment_status: 'unpaid' }));
    mockReconcile.mockResolvedValue({
      kind: 'ok',
      action: { type: 'place_and_mark_awaiting' },
      orderId: 'order-2',
      orderStatus: 'pending',
    });

    const res = await post();

    expect(res.body).toMatchObject({ orderId: 'order-2', status: 'pending' });
  });

  test('別のお客様の Session と下書きは 403 を返し、照合しない', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue(
      stripeSession({ metadata: { session_id: 'someone-else', draft_id: 'draft-123' } }),
    );
    expect((await post()).status).toBe(403);

    mockRetrieveCheckoutSession.mockResolvedValue(stripeSession());
    setupSupabase({ id: 'draft-123', session_id: 'someone-else' });
    expect((await post()).status).toBe(403);

    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('下書き ID の無い Session と見つからない下書きは 400 を返す', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue(stripeSession({ metadata: { session_id: 'sess-abc' } }));
    expect((await post()).status).toBe(400);

    mockRetrieveCheckoutSession.mockResolvedValue(stripeSession());
    setupSupabase(null);
    expect((await post()).status).toBe(400);

    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('合計が0円の Session は理由を明示して 400 を返す（FREQ-389）', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue(stripeSession({ amount_total: 0, payment_status: 'no_payment_required' }));

    const res = await post();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Zero-amount checkout is not supported' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      detail: 'Zero-amount checkout session is not supported',
    }));
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('支払いが終わっていない Session は 400 を返す', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue(stripeSession({ status: 'open', payment_status: 'unpaid' }));

    expect((await post()).status).toBe(400);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('注文を作れなかった支払い（要対応）は 409 を返す', async () => {
    mockReconcile.mockResolvedValue({
      kind: 'needs_action',
      exceptionId: 'exception-1',
      reason: 'order_not_creatable',
      orderId: null,
      orderStatus: null,
    });

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Order could not be registered' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure',
      metadata: expect.objectContaining({ exception_reason: 'order_not_creatable' }),
    }));
  });

  test('支払額の違いで要対応でも、入金済みの注文があれば注文 ID を返す', async () => {
    mockReconcile.mockResolvedValue({
      kind: 'needs_action',
      exceptionId: 'exception-2',
      reason: 'paid_amount_mismatch',
      orderId: 'order-3',
      orderStatus: 'paid',
    });

    const res = await post();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orderId: 'order-3', status: 'paid' });
  });

  test('失敗・取消の注文は完了として返さない', async () => {
    mockReconcile.mockResolvedValue({
      kind: 'ok',
      action: { type: 'none' },
      orderId: 'order-4',
      orderStatus: 'failed',
    });

    expect((await post()).status).toBe(409);
  });

  test('照合の一時的な失敗は 503 を返す', async () => {
    mockReconcile.mockRejectedValue(new ReconcileTransientError('stripe_unavailable'));

    const res = await post();

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Temporarily unavailable' });
  });

  test('ログイン客なら、照合の後に未所有の注文を紐付ける（R-24 の完了 API の分）', async () => {
    mockExtractAuthToken.mockReturnValue('token-1');
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });

    const res = await post();

    expect(res.status).toBe(200);
    expect(ordersUpdate).toHaveBeenCalledWith({ user_id: 'user-1' });
  });

  test('既に同じお客様の注文なら紐付け直さない', async () => {
    mockExtractAuthToken.mockReturnValue('token-1');
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    orderOwner = { user_id: 'user-1' };

    await post();

    expect(ordersUpdate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `npx jest tests/unit/api/checkout/complete-route`
Expected: FAIL（旧来の処理が照合関数を呼ばない）

- [ ] **Step 3: 完了 API を書き換える**

`src/app/api/checkout/complete/route.ts` の全体を次に置き換える:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getStripeServerClient } from '@/lib/stripe/server';
import {
  checkoutShippingSchema,
  getDraftIdFromStripeMetadata,
  isZeroAmountCheckoutSession,
  ZERO_AMOUNT_CHECKOUT_AUDIT_DETAIL,
  STRIPE_CHECKOUT_PAYMENT_METHODS,
} from '@/features/checkout/services/checkout-draft.service';
import { resolvePaymentMethodFromSession } from '@/features/checkout/services/payment-method.service';
import { logAudit } from '@/lib/audit';
import { extractAuthToken } from '@/lib/auth/request-token';
import { reconcileCheckoutPayment, ReconcileTransientError } from '@/lib/stripe/checkout-payment-reconciler';
import { createDefaultReconcilerDeps } from '@/lib/stripe/checkout-payment-reconciler-deps';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const completeCheckoutSchema = z.object({
  // 後方互換のためフィールドは残すが、クライアント申告は採用しない（resolvePaymentMethodFromSession 参照）。
  paymentMethod: z.enum(STRIPE_CHECKOUT_PAYMENT_METHODS).optional(),
  checkoutSessionId: z.string().trim().min(1),
  shipping: checkoutShippingSchema,
});

/** 注文完了として画面へ返してよい状態。失敗・放棄・取消の注文は完了として返さない */
const COMPLETED_ORDER_STATUSES = new Set(['paid', 'pending', 'shipped']);

async function resolveAuthenticatedUserId(request: NextRequest): Promise<string | null> {
  const authToken = extractAuthToken(request);
  if (!authToken) {
    return null;
  }

  const authClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
    }
  );

  const { data } = await authClient.auth.getUser(authToken);
  return data.user?.id ?? null;
}

/**
 * ゲストのまま作られた注文を、ログイン中のユーザーへ紐付ける。
 *
 * 決済は既に成立しているので、紐付けに失敗してもチェックアウトは成功として返す
 * （ここで失敗を返すと、支払い済みの客に注文失敗を見せることになる）。
 * ただし黙って捨てると「注文履歴に出てこない」形でしか表面化しないので、
 * 失敗も「対象0件」も監査ログに残して後から追えるようにする。
 */
async function linkOrderToUser(params: {
  orderId: string;
  userId: string;
  sessionId: string;
  checkoutSessionId: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<void> {
  // 他人の注文を奪わないよう user_id が未設定の行だけを対象にする。
  const { data, error } = await supabase
    .from('orders')
    .update({ user_id: params.userId })
    .eq('id', params.orderId)
    .is('user_id', null)
    .select('id');

  if (!error && data && data.length > 0) {
    return;
  }

  console.error(
    'Failed to link guest order to user:',
    error ?? 'no order row matched (already owned by another user)'
  );
  await logAudit({
    action: 'checkout.link_order_to_user',
    outcome: 'error',
    detail: error
      ? 'Failed to link guest order to user'
      : 'Guest order was not linked (already owned by another user)',
    ip: params.ip,
    user_agent: params.userAgent,
    metadata: {
      session_id: params.sessionId,
      checkout_session_id: params.checkoutSessionId,
      order_id: params.orderId,
      linked_user_id: params.userId,
      error_message: error?.message ?? null,
    },
  });
}

/** 照合の後に毎回呼ぶ。既に本人の注文なら何もしない（設計書 2-2。R-24 の完了 API の分） */
async function linkOrderToUserIfUnowned(params: Parameters<typeof linkOrderToUser>[0]): Promise<void> {
  const { data, error } = await supabase
    .from('orders')
    .select('user_id')
    .eq('id', params.orderId)
    .maybeSingle<{ user_id: string | null }>();

  if (error || !data) {
    console.error('Failed to read order owner before linking:', params.orderId, error);
    return;
  }

  if (data.user_id === params.userId) {
    return;
  }

  await linkOrderToUser(params);
}

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }

  return request.headers.get('x-real-ip');
}

export async function POST(req: NextRequest) {
  const clientIp = getClientIp(req);
  const userAgent = req.headers.get('user-agent');

  try {
    const sessionId = req.cookies.get('session_id')?.value;
    if (!sessionId) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Session not found',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Session not found' }, { status: 400 });
    }

    const activeUserId = await resolveAuthenticatedUserId(req);

    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const rateLimitByIp = await enforceRateLimit({
      request: req,
      endpoint: 'checkout:complete',
      limit: 30,
      windowSeconds: 60,
    });
    if (rateLimitByIp) {
      return rateLimitByIp;
    }

    const rateLimitBySession = await enforceRateLimit({
      request: req,
      endpoint: 'checkout:complete',
      limit: 15,
      windowSeconds: 60,
      subject: sessionId,
    });
    if (rateLimitBySession) {
      return rateLimitBySession;
    }

    const parsed = completeCheckoutSchema.safeParse(
      await req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Invalid request body',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId },
      });
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const stripe = getStripeServerClient();
    const session = await stripe.checkout.sessions.retrieve(
      parsed.data.checkoutSessionId,
      {
        expand: [
          'payment_intent',
          'payment_intent.payment_method',
          'payment_intent.latest_charge',
        ],
      }
    );

    // 実際に使われた支払方法をサーバ側で確定する（クライアント申告は採用しない）。
    const resolvedPaymentMethod = resolvePaymentMethodFromSession(session);

    if (session.metadata?.session_id && session.metadata.session_id !== sessionId) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Checkout session does not belong to current session',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
        },
      });
      return NextResponse.json(
        { error: 'Checkout session does not belong to current session' },
        { status: 403 }
      );
    }

    if (session.mode !== 'payment') {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Invalid checkout session mode',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          mode: session.mode,
        },
      });
      return NextResponse.json(
        { error: 'Invalid checkout session mode' },
        { status: 400 }
      );
    }

    const draftId = getDraftIdFromStripeMetadata(session.metadata);
    if (!draftId) {
      return NextResponse.json(
        { error: 'Checkout session draft is missing' },
        { status: 400 }
      );
    }

    // 合計が 0 の Checkout セッションは注文にしない（FREQ-389）。照合関数も記録のみにするが、
    // ここで理由を明示して断る。
    if (isZeroAmountCheckoutSession(session)) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: ZERO_AMOUNT_CHECKOUT_AUDIT_DETAIL,
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          amount_discount: session.total_details?.amount_discount ?? 0,
        },
      });
      return NextResponse.json(
        { error: 'Zero-amount checkout is not supported' },
        { status: 400 }
      );
    }

    const isSessionComplete =
      session.payment_status === 'paid' || session.status === 'complete';
    if (!isSessionComplete) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Payment is not completed yet',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          payment_status: session.payment_status,
          checkout_status: session.status,
        },
      });
      return NextResponse.json(
        { error: 'Payment is not completed yet' },
        { status: 400 }
      );
    }

    const { data: draftData, error: draftError } = await supabase
      .from('checkout_drafts')
      .select('id, session_id')
      .eq('id', draftId)
      .maybeSingle<{ id: string; session_id: string }>();

    if (draftError || !draftData) {
      return NextResponse.json(
        { error: 'Checkout draft not found' },
        { status: 400 }
      );
    }

    if (draftData.session_id !== sessionId) {
      return NextResponse.json(
        { error: 'Checkout draft does not belong to current session' },
        { status: 403 }
      );
    }

    // 注文の作成・状態の変更・在庫・メールは照合関数に任せる。Stripe の注文処理の手引きどおり、
    // Webhook と戻り先のページから同じ関数を呼ぶ（設計書 2-2）。
    let result;
    try {
      result = await reconcileCheckoutPayment(await createDefaultReconcilerDeps(), {
        checkoutSessionId: session.id,
      });
    } catch (error) {
      if (error instanceof ReconcileTransientError) {
        await logAudit({
          action: 'checkout.complete',
          outcome: 'error',
          detail: 'Checkout payment reconciliation is temporarily unavailable',
          ip: clientIp,
          user_agent: userAgent,
          metadata: {
            session_id: sessionId,
            checkout_session_id: session.id,
            reason: error.code,
          },
        });
        return NextResponse.json({ error: 'Temporarily unavailable' }, { status: 503 });
      }
      throw error;
    }

    if (!result.orderId || !result.orderStatus || !COMPLETED_ORDER_STATUSES.has(result.orderStatus)) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Order could not be registered',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: session.id,
          draft_id: draftId,
          result_kind: result.kind,
          exception_reason: result.kind === 'needs_action' ? result.reason : null,
          order_status: result.orderStatus,
        },
      });
      return NextResponse.json({ error: 'Order could not be registered' }, { status: 409 });
    }

    if (activeUserId) {
      await linkOrderToUserIfUnowned({
        orderId: result.orderId,
        userId: activeUserId,
        sessionId,
        checkoutSessionId: session.id,
        ip: clientIp,
        userAgent,
      });
    }

    await logAudit({
      action: 'checkout.complete',
      outcome: 'success',
      detail: 'Order reconciled from checkout session',
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        session_id: sessionId,
        checkout_session_id: session.id,
        draft_id: draftId,
        order_id: result.orderId,
        order_status: result.orderStatus,
        result_kind: result.kind,
      },
    });

    return NextResponse.json({
      orderId: result.orderId,
      status: result.orderStatus,
      paymentMethod: resolvedPaymentMethod,
    });
  } catch (error) {
    console.error('Complete checkout error:', error);
    await logAudit({
      action: 'checkout.complete',
      outcome: 'error',
      detail: 'Complete checkout handler error',
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        error_message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

- [ ] **Step 4: テストを通す**

Run: `npx jest tests/unit/api/checkout && npm run typecheck && npx eslint src/app/api/checkout/complete/route.ts`
Expected: PASS、lint の指摘なし

- [ ] **Step 5: コミット**

```bash
git add src/app/api/checkout/complete/route.ts tests/unit/api/checkout/complete-route.test.ts
git commit -m "refactor(checkout): 完了 API の注文確定を照合関数に任せる

Webhook と同じ関数を呼ぶ。ログイン客の注文は照合の後に毎回紐付ける（R-24 の完了 API の分）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 15: 毎時の照合の見回り

**Files:**
- Modify: `src/lib/stripe/checkout-session-expiry.ts`（`expireOpenCheckoutSession` を足す）
- Modify: `tests/unit/lib/stripe/checkout-session-expiry.test.ts`
- Modify: `src/app/api/cron/expire-pending-orders/route.ts`（ファイル全体を下の内容に置き換える）
- Modify: `tests/unit/api/cron/expire-pending-orders-route.test.ts`（ファイル全体を下の内容に置き換える）
- Modify: `supabase/pending/schedule_expire_pending_orders.sql`・`tests/unit/migrations/schedule-expire-pending-orders.test.ts`・`tests/integration/db/expire_pending_orders_job.integration.test.ts:107`（毎日 → 毎時）
- Modify: `README.md`（見回りの説明と `PENDING_ORDER_EXPIRY_DAYS` の行）

**Interfaces:**
- Consumes: Task 11 の `reconcileCheckoutPayment`・`notifyShopOfException`・`ReconcileResult`、Task 12 の `createDefaultReconcilerDeps`・`listUnsentShopAlerts`
- Produces: `expireOpenCheckoutSession(stripe: Stripe, checkoutSessionId: string): Promise<'expired' | 'not_open' | 'missing'>`（Task 16・21 も使う）。見回りの応答 `{ processed, candidateCount, batchOffset, expiredSessions, actions, needsReview, needsAction, failed, shopAlertsSent, capped, timeBudgetExhausted }`

- [ ] **Step 1: 失敗するテストを書く（Session の失効）**

`tests/unit/lib/stripe/checkout-session-expiry.test.ts` の import に `expireOpenCheckoutSession` を足し、ファイルの末尾に足す:
```ts
describe('expireOpenCheckoutSession', () => {
  function stripeWith(options: { retrieve: jest.Mock; expire?: jest.Mock }) {
    return {
      checkout: { sessions: { retrieve: options.retrieve, expire: options.expire ?? jest.fn() } },
    } as unknown as Parameters<typeof expireOpenCheckoutSession>[0];
  }

  it('開いている Session だけを、冪等キー付きで失効させる', async () => {
    const expire = jest.fn().mockResolvedValue({ id: 'cs_1', status: 'expired' });
    const stripe = stripeWith({ retrieve: jest.fn().mockResolvedValue({ id: 'cs_1', status: 'open' }), expire });

    expect(await expireOpenCheckoutSession(stripe, 'cs_1')).toBe('expired');
    expect(expire).toHaveBeenCalledWith('cs_1', {}, { idempotencyKey: 'expire-checkout-session:cs_1' });
  });

  it('完了・失効済みの Session には触らない', async () => {
    const expire = jest.fn();
    const stripe = stripeWith({ retrieve: jest.fn().mockResolvedValue({ id: 'cs_1', status: 'complete' }), expire });

    expect(await expireOpenCheckoutSession(stripe, 'cs_1')).toBe('not_open');
    expect(expire).not.toHaveBeenCalled();
  });

  it('失効の直前に支払いが完了したら、Stripe の現在値を優先して失効させない', async () => {
    const retrieve = jest.fn()
      .mockResolvedValueOnce({ id: 'cs_1', status: 'open' })
      .mockResolvedValueOnce({ id: 'cs_1', status: 'complete' });
    const stripe = stripeWith({ retrieve, expire: jest.fn().mockRejectedValue(new Error('session is not open')) });

    expect(await expireOpenCheckoutSession(stripe, 'cs_1')).toBe('not_open');
  });

  it('Stripe に無い Session は missing', async () => {
    const retrieve = jest.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'resource_missing' }));

    expect(await expireOpenCheckoutSession(stripeWith({ retrieve }), 'cs_gone')).toBe('missing');
  });
});
```

- [ ] **Step 2: 失敗するテストを書く（見回り）**

`tests/unit/api/cron/expire-pending-orders-route.test.ts` の全体を次に置き換える:
```ts
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

const mockSelect = jest.fn();
const mockOr = jest.fn();
const mockRange = jest.fn();
const mockServiceClient = { from: () => ({ select: mockSelect }) };
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => mockServiceClient),
}));

const mockStripe = { name: 'stripe' };
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: () => mockStripe,
}));

const mockExpireOpenCheckoutSession = jest.fn();
jest.mock('@/lib/stripe/checkout-session-expiry', () => ({
  expireOpenCheckoutSession: (...args: unknown[]) => mockExpireOpenCheckoutSession(...args),
}));

const mockReconcile = jest.fn();
const mockNotifyShop = jest.fn();
jest.mock('@/lib/stripe/checkout-payment-reconciler', () => ({
  reconcileCheckoutPayment: (...args: unknown[]) => mockReconcile(...args),
  notifyShopOfException: (...args: unknown[]) => mockNotifyShop(...args),
}));

const mockDeps = { name: 'reconciler-deps' };
const mockListUnsentShopAlerts = jest.fn();
jest.mock('@/lib/stripe/checkout-payment-reconciler-deps', () => ({
  createDefaultReconcilerDeps: async () => mockDeps,
  listUnsentShopAlerts: (...args: unknown[]) => mockListUnsentShopAlerts(...args),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

// 設定ミス（CRON_SECRET 未設定）の監査ログを間引くための回数制限。既定は「まだ上限に達していない」。
const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

import { POST } from '@/app/api/cron/expire-pending-orders/route';

type SweepRow = {
  id: string;
  status: 'payment_in_progress' | 'pending';
  payment_intent_id: string | null;
  checkout_session_id: string | null;
};

type SweepResponse = { status: number; body: Record<string, unknown> };

const NOW = Date.parse('2026-09-27T03:00:00.000Z');

function request(authorization?: string): Request {
  return new Request('http://localhost/api/cron/expire-pending-orders', {
    method: 'POST',
    headers: authorization ? { authorization } : {},
  });
}

async function sweep(authorization = 'Bearer cron-secret'): Promise<SweepResponse> {
  return (await POST(request(authorization))) as unknown as SweepResponse;
}

/** 件数の取得（head）と一覧の取得（order → order → range）を、同じ or 条件で受ける */
function candidates(rows: SweepRow[], totalCount = rows.length) {
  mockRange.mockResolvedValue({ data: rows, error: null });
  const listQuery: { order: () => unknown; range: jest.Mock } = { order: () => listQuery, range: mockRange };
  mockSelect.mockImplementation((_columns: string, options?: { head?: boolean }) => ({
    or: (filter: string) => {
      mockOr(filter);
      return options?.head ? Promise.resolve({ count: totalCount, error: null }) : listQuery;
    },
  }));
}

function ok(action: string) {
  return { kind: 'ok', action: { type: action }, orderId: 'order-1', orderStatus: 'paid' };
}

describe('POST /api/cron/expire-pending-orders（照合の見回り）', () => {
  let dateSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'cron-secret';
    dateSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockExpireOpenCheckoutSession.mockResolvedValue('not_open');
    mockReconcile.mockResolvedValue(ok('none'));
    mockListUnsentShopAlerts.mockResolvedValue([]);
    mockNotifyShop.mockResolvedValue(true);
    candidates([]);
  });

  afterEach(() => {
    dateSpy.mockRestore();
  });

  it('CRON_SECRET が一致しなければ 401', async () => {
    expect((await sweep('Bearer wrong')).status).toBe(401);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('長さが同じでも値が違う secret は 401（timingSafeEqual の分岐を通す）', async () => {
    expect((await sweep('Bearer cron-secreX')).status).toBe(401);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('CRON_SECRET が未設定なら 401 で、理由付きの監査ログを残す（レビュー指摘 I5）', async () => {
    delete process.env.CRON_SECRET;

    const response = await sweep();

    expect(response.status).toBe(401);
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'checkout.pending_orders.expire',
      outcome: 'failure',
      detail: expect.stringContaining('CRON_SECRET'),
    }));
  });

  it('CRON_SECRET 未設定の監査ログは、IP に依らない共通の枠で10分に1回までに絞る（FREQ-370）', async () => {
    delete process.env.CRON_SECRET;

    await sweep();

    expect(mockEnforceRateLimit).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'cron:expire-pending-orders:misconfigured',
      limit: 1,
      windowSeconds: 600,
      subject: expect.any(String),
    }));
  });

  it('枠を使い切ったら、CRON_SECRET 未設定でも監査ログを残さず 401 だけ返す（FREQ-370）', async () => {
    delete process.env.CRON_SECRET;
    mockEnforceRateLimit.mockResolvedValue(new Response(null, { status: 429 }));

    expect((await sweep()).status).toBe(401);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('Authorization ヘッダが無い・一致しない要求は監査ログを残さず、ヘッダの値をログに出さない（FREQ-370）', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect((await POST(request()) as unknown as SweepResponse).status).toBe(401);
    expect((await sweep('Bearer attacker-supplied-value')).status).toBe(401);

    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[cron] expire-pending-orders unauthorized'),
      expect.stringContaining('Missing Authorization header'),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('attacker-supplied-value');
    warn.mockRestore();
  });

  it('開いてから30分を超えた支払い手続き中の注文と、入金待ちの全件を対象にする', async () => {
    await sweep();

    expect(mockOr).toHaveBeenCalledWith(
      'and(status.eq.payment_in_progress,checkout_session_created_at.lt.2026-09-27T02:30:00.000Z),status.eq.pending',
    );
  });

  it('支払い手続き中の注文は、まだ開いている Session を失効させてから照合する', async () => {
    candidates([{ id: 'order-1', status: 'payment_in_progress', payment_intent_id: null, checkout_session_id: 'cs_1' }]);
    mockExpireOpenCheckoutSession.mockResolvedValue('expired');
    mockReconcile.mockResolvedValue({
      kind: 'ok',
      action: { type: 'release', expectedStatus: 'payment_in_progress', nextStatus: 'abandoned' },
      orderId: 'order-1',
      orderStatus: 'abandoned',
    });

    const response = await sweep();

    expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(mockStripe, 'cs_1');
    expect(mockReconcile).toHaveBeenCalledWith(mockDeps, { checkoutSessionId: 'cs_1', paymentIntentId: null });
    expect(mockExpireOpenCheckoutSession.mock.invocationCallOrder[0]).toBeLessThan(mockReconcile.mock.invocationCallOrder[0]);
    expect(response.body).toMatchObject({ processed: 1, expiredSessions: 1, actions: { release: 1 } });
  });

  it('入金待ちの注文は失効させずに照合する。Session ID の無い古い注文は PaymentIntent で照合する', async () => {
    candidates([
      { id: 'order-1', status: 'pending', payment_intent_id: 'pi_1', checkout_session_id: 'cs_1' },
      { id: 'order-legacy', status: 'pending', payment_intent_id: 'pi_legacy', checkout_session_id: null },
    ]);

    await sweep();

    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    expect(mockReconcile).toHaveBeenCalledWith(mockDeps, { checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1' });
    expect(mockReconcile).toHaveBeenCalledWith(mockDeps, { checkoutSessionId: null, paymentIntentId: 'pi_legacy' });
  });

  it('照合の結果を種類ごとに数え、1件の失敗で残りを止めない', async () => {
    candidates([
      { id: 'order-1', status: 'pending', payment_intent_id: 'pi_1', checkout_session_id: 'cs_1' },
      { id: 'order-2', status: 'pending', payment_intent_id: 'pi_2', checkout_session_id: 'cs_2' },
      { id: 'order-3', status: 'pending', payment_intent_id: 'pi_3', checkout_session_id: 'cs_3' },
      { id: 'order-4', status: 'pending', payment_intent_id: 'pi_4', checkout_session_id: 'cs_4' },
    ]);
    mockReconcile
      .mockResolvedValueOnce(ok('mark_paid'))
      .mockResolvedValueOnce({ kind: 'needs_review', action: { type: 'mark_paid' }, orderId: 'order-2', orderStatus: 'paid' })
      .mockResolvedValueOnce({ kind: 'needs_action', exceptionId: 'exception-1', reason: 'stripe_object_missing', orderId: 'order-3', orderStatus: 'pending' })
      .mockRejectedValueOnce(Object.assign(new Error('stripe down'), { code: 'stripe_unavailable' }));

    const response = await sweep();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      processed: 4,
      actions: { mark_paid: 2 },
      needsReview: 1,
      needsAction: 1,
      failed: 1,
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error',
      metadata: expect.objectContaining({ failed_order_ids: ['order-4'] }),
    }));
  });

  it('店へ未送信の要対応を送り直す', async () => {
    const alert = { reason: 'paid_amount_mismatch', detail: null, orderId: 'order-1', paymentRef: 'cs_1', detectedAt: new Date(NOW) };
    mockListUnsentShopAlerts.mockResolvedValue([
      { exceptionId: 'exception-1', alert },
      { exceptionId: 'exception-2', alert },
    ]);
    mockNotifyShop.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const response = await sweep();

    expect(mockListUnsentShopAlerts).toHaveBeenCalledWith(mockServiceClient, 20);
    expect(mockNotifyShop).toHaveBeenCalledWith(mockDeps, 'exception-1', alert);
    expect(response.body).toMatchObject({ shopAlertsSent: 1 });
  });

  it('対象がなければ 200 と 0 件を返し、監査ログを1回だけ残す', async () => {
    const response = await sweep();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ processed: 0, candidateCount: 0, failed: 0 });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'checkout.pending_orders.expire',
      resource: 'orders',
      outcome: 'success',
      detail: 'Checkout payment reconciliation sweep',
    }));
  });

  it('1回の実行の上限は50件（レビュー指摘 I3）', async () => {
    candidates([], 50);

    await sweep();

    expect(mockRange).toHaveBeenCalledWith(0, 49);
  });

  it('50件を超える場合は時間ごとに取得範囲を巡回し、残り続ける注文による後続の飢餓を防ぐ', async () => {
    candidates([{ id: 'order-51', status: 'pending', payment_intent_id: 'pi_51', checkout_session_id: 'cs_51' }], 120);
    dateSpy.mockReturnValue(60 * 60 * 1000);

    const response = await sweep();

    expect(mockRange).toHaveBeenCalledWith(50, 99);
    expect(response.body).toMatchObject({ candidateCount: 120, batchOffset: 50, capped: true });
  });

  it('件数の取得と一覧の間に状態が変わり、巡回範囲が空なら先頭範囲へ1回だけ戻す', async () => {
    candidates([], 120);
    dateSpy.mockReturnValue(60 * 60 * 1000);

    const response = await sweep();

    expect(mockRange).toHaveBeenNthCalledWith(1, 50, 99);
    expect(mockRange).toHaveBeenNthCalledWith(2, 0, 49);
    expect(response.body).toMatchObject({ batchOffset: 0, processed: 0 });
  });

  it('45秒の時間予算を超えたら残りを打ち切り、店への送り直しもしない（レビュー指摘 I3）', async () => {
    candidates([
      { id: 'order-1', status: 'pending', payment_intent_id: 'pi_1', checkout_session_id: 'cs_1' },
      { id: 'order-2', status: 'pending', payment_intent_id: 'pi_2', checkout_session_id: 'cs_2' },
    ]);
    dateSpy
      .mockReturnValueOnce(1_000_000) // 対象の時刻と巡回位置
      .mockReturnValueOnce(1_000_000) // startedAt
      .mockReturnValueOnce(1_000_100) // order-1 の予算チェック（予算内）
      .mockReturnValueOnce(1_050_000); // order-2 の予算チェック（予算超過）

    const response = await sweep();

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockListUnsentShopAlerts).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ processed: 1, timeBudgetExhausted: true });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
  });
});
```

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/stripe/checkout-session-expiry tests/unit/api/cron/expire-pending-orders-route`
Expected: FAIL（`expireOpenCheckoutSession` が無い、見回りが照合関数を呼ばない）

- [ ] **Step 4: Session を失効させる関数を足す**

`src/lib/stripe/checkout-session-expiry.ts` の末尾に足す:
```ts
export type OpenSessionExpiryResult = 'expired' | 'not_open' | 'missing';

/**
 * 開いている Checkout Session を失効させる（見回り・管理画面の取消・商品の非公開。設計書 2-2・4-6）。
 * 開いていなければ何もしない。支払いの完了と競合したら Stripe の現在値を優先し、失効させない。
 * 注文と在庫は、呼び出し側が照合関数で合わせる。
 */
export async function expireOpenCheckoutSession(
  stripe: Stripe,
  checkoutSessionId: string,
): Promise<OpenSessionExpiryResult> {
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
  } catch (error) {
    if (isResourceMissingError(error)) {
      return 'missing';
    }
    throw error;
  }

  if (session.status !== 'open') {
    return 'not_open';
  }

  try {
    await stripe.checkout.sessions.expire(
      checkoutSessionId,
      {},
      { idempotencyKey: `expire-checkout-session:${checkoutSessionId}` },
    );
    return 'expired';
  } catch (expireError) {
    // open を確かめた後に支払いが完了した（TOCTOU）。完了していれば失効させない
    const refreshed = await stripe.checkout.sessions.retrieve(checkoutSessionId);
    if (refreshed.status === 'expired') {
      return 'expired';
    }
    if (refreshed.status !== 'open') {
      return 'not_open';
    }
    throw expireError;
  }
}
```

- [ ] **Step 5: 見回りを書き換える**

`src/app/api/cron/expire-pending-orders/route.ts` の全体を次に置き換える:
```ts
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { getStripeServerClient } from '@/lib/stripe/server';
import { expireOpenCheckoutSession } from '@/lib/stripe/checkout-session-expiry';
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import {
  notifyShopOfException,
  reconcileCheckoutPayment,
  type ReconcileResult,
} from '@/lib/stripe/checkout-payment-reconciler';
import { createDefaultReconcilerDeps, listUnsentShopAlerts } from '@/lib/stripe/checkout-payment-reconciler-deps';

// 照合の見回り（グループ A 設計書 2-2）。毎時、決済画面を開いてから30分を超えた支払い手続き中の注文と、
// 入金待ちの全件を Stripe の現在値と照合する。まだ開いている決済はその場で失効させる。
// Webhook が届かなくても、放棄された注文の在庫は最長90分で戻る。入金待ちはアプリ独自の日数で打ち切らず、
// Stripe が期限切れを確定したときだけ失敗にする（FREQ-388 の日数の底上げは不要になった）。
// pg_cron + pg_net から呼ばれる。net.http_post は POST しか送れないため POST。

export const maxDuration = 60;

// 直列の Stripe 呼び出しは1件あたり数百msかかる。maxDuration に収まるよう1回50件まで（レビュー指摘 I3）。
const MAX_ORDERS_PER_RUN = 50;

// ここで打ち切って残りは次回に回す。maxDuration の余裕を持って早めに切る。
const TIME_BUDGET_MS = 45_000;

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

/** 決済画面は開いてから30分ちょうどまで有効、30分を超えたら失効（設計書 2-2） */
const CHECKOUT_SESSION_VALIDITY_MS = 30 * 60 * 1000;

const MAX_SHOP_ALERTS_PER_RUN = 20;

type SweepOrderRow = {
  id: string;
  status: 'payment_in_progress' | 'pending';
  payment_intent_id: string | null;
  checkout_session_id: string | null;
};

type AuthorizationResult =
  | { ok: true }
  | { ok: false; reason: string; misconfigured: boolean };

function checkAuthorization(request: Request): AuthorizationResult {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { ok: false, reason: 'CRON_SECRET is not configured', misconfigured: true };
  }

  const header = request.headers.get('authorization');
  if (!header) {
    return { ok: false, reason: 'Missing Authorization header', misconfigured: false };
  }

  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return {
      ok: false,
      reason: 'Authorization header does not match CRON_SECRET',
      misconfigured: false,
    };
  }

  return { ok: true };
}

// 設定ミス（CRON_SECRET 未設定）の監査ログは、全体で10分に1回までにする（FREQ-370）。
// subject を付けると IP を使わない共通のカウンタになるので、攻撃元を散らしても増えない。
const MISCONFIGURED_AUDIT_THROTTLE = {
  endpoint: 'cron:expire-pending-orders:misconfigured',
  limit: 1,
  windowSeconds: 600,
  subject: 'all-callers',
} as const;

/**
 * 認証に失敗した要求を記録する（FREQ-370）。
 * ヘッダの欠落・不一致はアプリのログにだけ残す（ヘッダの値は出さない）。
 * CRON_SECRET 未設定（運用側の設定ミス）は監査ログにも残す。ただし全体で10分に1回まで。
 */
async function recordUnauthorized(
  request: Request,
  auth: { reason: string; misconfigured: boolean },
): Promise<void> {
  console.warn('[cron] expire-pending-orders unauthorized', auth.reason);

  if (!auth.misconfigured) return;

  const throttled = await enforceRateLimit({ request, ...MISCONFIGURED_AUDIT_THROTTLE });
  if (throttled) return;

  await logAudit({
    action: 'checkout.pending_orders.expire',
    resource: 'orders',
    outcome: 'failure',
    detail: `Unauthorized: ${auth.reason}`,
  });
}

/** 対象が50件を超えるときは、時間ごとに取得範囲を巡回する（残り続ける注文で後続が飢えない） */
function resolveHourlyBatchOffset(totalOrders: number, nowMs: number): number {
  const batchCount = Math.max(1, Math.ceil(totalOrders / MAX_ORDERS_PER_RUN));
  const hour = Math.floor(nowMs / MILLISECONDS_PER_HOUR);
  return (hour % batchCount) * MAX_ORDERS_PER_RUN;
}

export async function POST(request: Request) {
  const auth = checkAuthorization(request);
  if (!auth.ok) {
    await recordUnauthorized(request, auth);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createServiceRoleClient();
  const stripe = getStripeServerClient();
  const deps = await createDefaultReconcilerDeps();

  const nowMs = Date.now();
  const staleBefore = new Date(nowMs - CHECKOUT_SESSION_VALIDITY_MS).toISOString();
  const candidateFilter =
    `and(status.eq.payment_in_progress,checkout_session_created_at.lt.${staleBefore}),status.eq.pending`;

  const { count: candidateCountValue, error: countError } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .or(candidateFilter);

  if (countError) {
    console.error('[cron] failed to count sweep candidates', countError);
    return NextResponse.json({ error: 'Failed to list orders' }, { status: 500 });
  }

  const candidateCount = candidateCountValue ?? 0;
  let batchOffset = resolveHourlyBatchOffset(candidateCount, nowMs);

  const loadBatch = (offset: number) => supabase
    .from('orders')
    .select('id, status, payment_intent_id, checkout_session_id')
    .or(candidateFilter)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + MAX_ORDERS_PER_RUN - 1);

  let { data, error } = await loadBatch(batchOffset);

  // 件数の取得と一覧の間に Webhook が注文を動かし、選んだ範囲が空になることがある。先頭範囲へ1回だけ戻す。
  if (!error && batchOffset > 0 && (data?.length ?? 0) === 0) {
    batchOffset = 0;
    ({ data, error } = await loadBatch(batchOffset));
  }

  if (error) {
    console.error('[cron] failed to list sweep candidates', error);
    return NextResponse.json({ error: 'Failed to list orders' }, { status: 500 });
  }

  const orders = (data ?? []) as SweepOrderRow[];
  const actions: Record<string, number> = {};
  let processed = 0;
  let expiredSessions = 0;
  let needsReview = 0;
  let needsAction = 0;
  let failed = 0;
  const failedOrderIds: string[] = [];
  const startedAt = Date.now();
  let timeBudgetExhausted = false;

  const countResult = (result: ReconcileResult) => {
    if (result.kind === 'needs_action') {
      needsAction += 1;
      return;
    }
    if (result.kind === 'needs_review') {
      needsReview += 1;
    }
    actions[result.action.type] = (actions[result.action.type] ?? 0) + 1;
  };

  for (const order of orders) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      timeBudgetExhausted = true;
      break;
    }

    processed += 1;

    try {
      if (order.status === 'payment_in_progress' && order.checkout_session_id) {
        if ((await expireOpenCheckoutSession(stripe, order.checkout_session_id)) === 'expired') {
          expiredSessions += 1;
        }
      }

      countResult(await reconcileCheckoutPayment(deps, {
        checkoutSessionId: order.checkout_session_id,
        paymentIntentId: order.payment_intent_id,
      }));
    } catch (orderError) {
      // 1件の失敗で残りを止めない。状態を確定できない注文は変更せず、次回と監査ログで再確認する。
      console.error('[cron] failed to reconcile order', order.id, orderError);
      failed += 1;
      failedOrderIds.push(order.id);
    }
  }

  let shopAlertsSent = 0;
  if (!timeBudgetExhausted) {
    try {
      for (const { exceptionId, alert } of await listUnsentShopAlerts(supabase, MAX_SHOP_ALERTS_PER_RUN)) {
        if (await notifyShopOfException(deps, exceptionId, alert)) {
          shopAlertsSent += 1;
        }
      }
    } catch (alertError) {
      console.error('[cron] failed to resend shop alerts', alertError);
      failed += 1;
    }
  }

  const summary = {
    processed,
    candidateCount,
    batchOffset,
    expiredSessions,
    actions,
    needsReview,
    needsAction,
    failed,
    shopAlertsSent,
    capped: candidateCount > MAX_ORDERS_PER_RUN,
    timeBudgetExhausted,
  };

  // 時間切れで途中終了した場合でも、この監査行だけは必ず残す（レビュー指摘 I3）。
  await logAudit({
    action: 'checkout.pending_orders.expire',
    resource: 'orders',
    outcome: failed > 0
      ? 'error'
      : needsAction > 0 || timeBudgetExhausted
        ? 'failure'
        : 'success',
    detail: 'Checkout payment reconciliation sweep',
    metadata: { ...summary, failed_order_ids: failedOrderIds.slice(0, 20) },
  });

  return NextResponse.json(summary);
}
```

- [ ] **Step 6: 毎日から毎時に変える**

`supabase/pending/schedule_expire_pending_orders.sql` の1行目の説明を替える:
```sql
-- 照合の見回りを毎時0分に呼ぶ（グループ A 設計書 2-2。旧: 未入金注文の掃除を毎日 04:00 UTC。FREQ-356 / FREQ-368）
```
同じファイルの `cron.schedule` の2つ目の引数を替える:
```sql
  '0 * * * *',
```
`tests/unit/migrations/schedule-expire-pending-orders.test.ts` の該当テストを替える:
```ts
  it('毎時0分に expire-pending-orders を登録する', () => {
    expect(sql).toMatch(/cron\.schedule\(\s*'expire-pending-orders'\s*,\s*'0 \* \* \* \*'/);
  });
```
`tests/integration/db/expire_pending_orders_job.integration.test.ts` の登録の期待値を替える:
```ts
    expect(job.rows[0].schedule).toBe('0 * * * *');
```
`README.md` の「これは何か」の2段落目とコードブロックを替える:
````text
大半は Stripe からの webhook で処理されるが、通知が届かなかった取りこぼしが残る。それを毎時0分に照合し直すのが、このジョブ。決済画面を開いてから30分を超えてまだ開いている決済は、ここで失効させる（在庫は最長90分で戻る）。

```text
毎時0分
  Supabase の pg_cron
    → POST https://<本番ドメイン>/api/cron/expire-pending-orders
        Authorization: Bearer <CRON_SECRET>
      → 開いてから30分を超えた支払い手続き中の注文と入金待ちの注文を Stripe の現在値と照合し、注文と在庫を合わせる
```
````
同じ `README.md` の表から `PENDING_ORDER_EXPIRY_DAYS` の行を消す。`grep -rn PENDING_ORDER_EXPIRY_DAYS src tests README.md .env.example` で何も出ないことを確かめる

- [ ] **Step 7: テストを通す**

Run:
```bash
npx jest tests/unit/lib/stripe/checkout-session-expiry tests/unit/api/cron tests/unit/migrations/schedule-expire-pending-orders
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/expire_pending_orders_job
npm run typecheck
npx eslint src/app/api/cron/expire-pending-orders/route.ts src/lib/stripe/checkout-session-expiry.ts
```
Expected: PASS、lint の指摘なし

- [ ] **Step 8: コミット**

```bash
git add src/lib/stripe/checkout-session-expiry.ts tests/unit/lib/stripe/checkout-session-expiry.test.ts src/app/api/cron/expire-pending-orders/route.ts tests/unit/api/cron/expire-pending-orders-route.test.ts supabase/pending/schedule_expire_pending_orders.sql tests/unit/migrations/schedule-expire-pending-orders.test.ts tests/integration/db/expire_pending_orders_job.integration.test.ts README.md
git commit -m "feat(cron): 未入金の掃除を毎時の照合の見回りに変える

開いてから30分を超えた決済を失効させ、照合関数で在庫を戻す（最長90分）。
入金待ちはアプリ独自の日数で打ち切らない。注文の直接 UPDATE を消す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 16: 管理画面の取消 API（理由・メモ・お知らせ）

**Files:**
- Modify: `src/app/api/admin/orders/[id]/status/route.ts`（ファイル全体を下の内容に置き換える）
- Modify: `tests/unit/api/admin/order-status-shipped.test.ts`（ファイル全体を下の内容に置き換える）

**Interfaces:**
- Consumes: Task 6 の `admin_cancel_failed_order(uuid, uuid, text, text)`・発送止め、Task 8 の型、Task 9 の `readCheckoutPayment`、Task 11・12、Task 15 の `expireOpenCheckoutSession`
- Produces: `POST /api/admin/orders/:id/status`
  - 取消: `{ status: 'cancelled', reason: CancelReason, note?: string(≤500), notifyCustomer?: boolean(既定 true) }`
    - `200 { success: true, status: 'cancelled' }`
    - `400`（理由なし・「その他」でメモなし）
    - `409 { error, cancelBlockedUntil? }`（払込票が有効・支払い済み・発送済み・放棄・要対応）
    - `503`（一時的な失敗）
  - 発送: `{ status: 'shipped', carrier, trackingNumber }`（今のまま）

- [ ] **Step 1: テストをまるごと書き換える**

`tests/unit/api/admin/order-status-shipped.test.ts` の全体を次に置き換える:
```ts
jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn((body: unknown, init?: { status?: number }) => ({
        body,
        status: init?.status ?? 200,
      })),
    },
  };
});

const mockMaybeSingle = jest.fn();
const mockFrom = jest.fn(() => ({
  select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }),
}));
const mockRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({ from: mockFrom })),
  createServiceRoleClient: jest.fn(async () => ({ rpc: mockRpc })),
}));

const mockStripe = { name: 'stripe' };
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: () => mockStripe,
}));

const mockExpireOpenCheckoutSession = jest.fn();
jest.mock('@/lib/stripe/checkout-session-expiry', () => ({
  expireOpenCheckoutSession: (...args: unknown[]) => mockExpireOpenCheckoutSession(...args),
}));

const mockReadCheckoutPayment = jest.fn();
jest.mock('@/lib/stripe/checkout-payment-reader', () => ({
  ...jest.requireActual('@/lib/stripe/checkout-payment-reader'),
  readCheckoutPayment: (...args: unknown[]) => mockReadCheckoutPayment(...args),
}));

const mockReconcile = jest.fn();
jest.mock('@/lib/stripe/checkout-payment-reconciler', () => ({
  reconcileCheckoutPayment: (...args: unknown[]) => mockReconcile(...args),
  ReconcileTransientError: jest.requireActual('@/lib/stripe/checkout-payment-reader').ReconcileTransientError,
}));

const mockDeps = { name: 'reconciler-deps' };
jest.mock('@/lib/stripe/checkout-payment-reconciler-deps', () => ({
  createDefaultReconcilerDeps: async () => mockDeps,
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn().mockResolvedValue({ ok: true, userId: 'admin-1' }),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockSendOrderShippedEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/orders/order-shipped-email', () => ({
  sendOrderShippedEmail: (...args: unknown[]) => mockSendOrderShippedEmail(...args),
}));

import { POST } from '@/app/api/admin/orders/[id]/status/route';
import { ReconcileTransientError } from '@/lib/stripe/checkout-payment-reader';

type RouteResponse = { status: number; body: Record<string, unknown> };

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };
const CANCEL = { status: 'cancelled', reason: 'customer_request' };

async function post(body: Record<string, unknown>): Promise<RouteResponse> {
  const request = new Request(`http://localhost/api/admin/orders/${ORDER_ID}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await POST(request, CONTEXT)) as unknown as RouteResponse;
}

function currentOrder(status: string, overrides: Record<string, unknown> = {}) {
  mockMaybeSingle.mockResolvedValue({
    data: { id: ORDER_ID, status, payment_intent_id: 'pi_1', checkout_session_id: 'cs_1', ...overrides },
    error: null,
  });
}

function reconciled(orderStatus: string) {
  mockReconcile.mockResolvedValue({ kind: 'ok', action: { type: 'none' }, orderId: ORDER_ID, orderStatus });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExpireOpenCheckoutSession.mockResolvedValue('expired');
  reconciled('cancelled');
});

describe('POST /api/admin/orders/[id]/status - 発送', () => {
  test('paid の注文を発送済みにできる', async () => {
    mockRpc.mockResolvedValue({ data: [{ id: ORDER_ID, shipping_email: 'hanako@example.com' }], error: null });

    const res = await post({ status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012' });

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_ship_paid_order', {
      _actor_id: 'admin-1',
      _order_id: ORDER_ID,
      _shipping_carrier: 'yamato',
      _tracking_number: '1234-5678-9012',
    });
    expect(mockSendOrderShippedEmail).toHaveBeenCalledTimes(1);
  });

  test('更新対象が無ければ 409 を返し、配送先と支払額の確認を促し、メールを送らない', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    const res = await post({ status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('配送先');
    expect(res.body.error).toContain('支払額');
    expect(mockSendOrderShippedEmail).not.toHaveBeenCalled();
  });

  test('未知の配送業者と記号の混ざった追跡番号は 400 を返す', async () => {
    expect((await post({ status: 'shipped', carrier: 'dhl', trackingNumber: '1234' })).status).toBe(400);
    expect((await post({ status: 'shipped', carrier: 'yamato', trackingNumber: '12 34/56' })).status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/orders/[id]/status - 取消', () => {
  test('取消の理由が無ければ 400 を返す', async () => {
    expect((await post({ status: 'cancelled' })).status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test('理由が「その他」ならメモが要る', async () => {
    const res = await post({ status: 'cancelled', reason: 'other', note: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('メモ');
  });

  test('メモは500文字まで', async () => {
    expect((await post({ ...CANCEL, note: 'あ'.repeat(501) })).status).toBe(400);
  });

  test('支払い手続き中の注文は、開いている決済を失効させてから、実行者・理由・メモ・お知らせを付けて照合する', async () => {
    currentOrder('payment_in_progress', { payment_intent_id: null });

    const res = await post({ ...CANCEL, note: '電話で依頼', notifyCustomer: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, status: 'cancelled' });
    expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(mockStripe, 'cs_1');
    expect(mockReconcile).toHaveBeenCalledWith(mockDeps, {
      checkoutSessionId: 'cs_1',
      paymentIntentId: null,
      adminCancel: { actorId: 'admin-1', reason: 'customer_request', note: '電話で依頼', notifyCustomer: false },
    });
    expect(mockExpireOpenCheckoutSession.mock.invocationCallOrder[0]).toBeLessThan(mockReconcile.mock.invocationCallOrder[0]);
  });

  test('お知らせは既定で送る', async () => {
    currentOrder('payment_in_progress', { payment_intent_id: null });

    await post(CANCEL);

    expect(mockReconcile).toHaveBeenCalledWith(mockDeps, expect.objectContaining({
      adminCancel: expect.objectContaining({ notifyCustomer: true }),
    }));
  });

  test('払込票が有効な入金待ちは取り消さず、409 と払込期限を返す', async () => {
    currentOrder('pending');
    mockReadCheckoutPayment.mockResolvedValue({
      state: { kind: 'awaiting_payment' },
      voucherExpiresAt: new Date('2026-09-30T14:59:59.000Z'),
    });

    const res = await post(CANCEL);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ cancelBlockedUntil: '2026-09-30T14:59:59.000Z' });
    expect(res.body.error).toContain('払込期限');
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
  });

  test('払込票の期限が切れた入金待ちは、照合して取消にする', async () => {
    currentOrder('pending');
    mockReadCheckoutPayment.mockResolvedValue({ state: { kind: 'voucher_expired' }, voucherExpiresAt: null });

    const res = await post(CANCEL);

    expect(res.status).toBe(200);
    expect(mockReadCheckoutPayment).toHaveBeenCalledWith(mockStripe, { checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1' });
    expect(mockReconcile).toHaveBeenCalledWith(mockDeps, expect.objectContaining({ checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1' }));
  });

  test('照合の結果が入金済みなら取り消さず 409 を返す', async () => {
    currentOrder('payment_in_progress', { payment_intent_id: null });
    reconciled('paid');

    const res = await post(CANCEL);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('支払いが完了した');
  });

  test('要対応になったら理由を表示する', async () => {
    currentOrder('payment_in_progress', { payment_intent_id: null });
    mockReconcile.mockResolvedValue({
      kind: 'needs_action',
      exceptionId: 'exception-1',
      reason: 'stripe_object_missing',
      orderId: ORDER_ID,
      orderStatus: 'payment_in_progress',
    });

    const res = await post(CANCEL);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Stripe に支払いが無い');
  });

  test('一時的な失敗は 503 で「時間をおいて再試行」を返す', async () => {
    currentOrder('payment_in_progress', { payment_intent_id: null });
    mockReconcile.mockRejectedValue(new ReconcileTransientError('stripe_unavailable'));

    const res = await post(CANCEL);

    expect(res.status).toBe(503);
    expect(res.body.error).toContain('時間をおいて再試行');
  });

  test('失敗の注文は専用 RPC に理由とメモを渡し、お客様には送らない', async () => {
    currentOrder('failed');
    mockRpc.mockResolvedValue({ data: [{ id: ORDER_ID, status: 'cancelled' }], error: null });

    const res = await post({ ...CANCEL, note: '電話で依頼' });

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_cancel_failed_order', {
      _order_id: ORDER_ID,
      _actor_id: 'admin-1',
      _cancel_reason: 'customer_request',
      _note: '電話で依頼',
    });
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('失敗の注文の取消と別の更新が競合したら 409 を返す', async () => {
    currentOrder('failed');
    mockRpc.mockResolvedValue({ data: [], error: null });

    const res = await post(CANCEL);

    expect(res.status).toBe(409);
    expect(res.body.success).not.toBe(true);
  });

  test.each([
    ['shipped', '発送済み'],
    ['paid', '返金処理'],
    ['abandoned', '放棄'],
  ])('%s の注文は取り消せず 409 を返す', async (status, message) => {
    currentOrder(status);

    const res = await post(CANCEL);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain(message);
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('取消済みの注文への再送は 200 を返す（冪等）', async () => {
    currentOrder('cancelled');

    expect((await post(CANCEL)).body).toEqual({ success: true, status: 'cancelled' });
    expect(mockReconcile).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `npx jest tests/unit/api/admin/order-status-shipped`
Expected: FAIL（理由を受け取らない、照合関数を呼ばない）

- [ ] **Step 3: 取消 API を書き換える**

`src/app/api/admin/orders/[id]/status/route.ts` の全体を次に置き換える:
```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getStripeServerClient } from '@/lib/stripe/server';
import { expireOpenCheckoutSession } from '@/lib/stripe/checkout-session-expiry';
import { readCheckoutPayment, type CheckoutPaymentStripeClient } from '@/lib/stripe/checkout-payment-reader';
import {
  reconcileCheckoutPayment,
  ReconcileTransientError,
  type ReconcileResult,
} from '@/lib/stripe/checkout-payment-reconciler';
import { createDefaultReconcilerDeps } from '@/lib/stripe/checkout-payment-reconciler-deps';
import { logAudit } from '@/lib/audit';
import { SHIPPING_CARRIER_IDS } from '@/lib/orders/shipping-carriers';
import { sendOrderShippedEmail } from '@/lib/orders/order-shipped-email';
import {
  ADMIN_NOTE_MAX_LENGTH,
  CANCEL_REASONS,
  PAYMENT_EXCEPTION_REASON_LABELS,
  type CancelReason,
  type OrderStatus,
} from '@/lib/orders/order-payment-types';

const orderIdSchema = z.string().uuid();

const updateStatusSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('cancelled'),
    reason: z.enum(CANCEL_REASONS),
    note: z.string().trim().max(ADMIN_NOTE_MAX_LENGTH).optional(),
    notifyCustomer: z.boolean().default(true),
  }),
  z.object({
    status: z.literal('shipped'),
    carrier: z.enum(SHIPPING_CARRIER_IDS),
    trackingNumber: z.string().trim().min(1).max(64).regex(/^[0-9A-Za-z-]+$/),
  }),
]);

type CancelRequest = { reason: CancelReason; note?: string; notifyCustomer: boolean };

type CurrentOrder = {
  id: string;
  status: OrderStatus;
  payment_intent_id: string | null;
  checkout_session_id: string | null;
};

type AuditOutcome = 'success' | 'failure' | 'error' | 'conflict';
type AuditFn = (outcome: AuditOutcome, detail: string, metadata?: Record<string, unknown>) => Promise<void>;

const VOUCHER_VALID_MESSAGE = '払込票が有効な間は取り消せません。払込期限を過ぎると自動で期限切れになります。';
const STATE_CHANGED_MESSAGE = '注文の状態が変わったためキャンセルできませんでした。';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await authorizeAdminPermission('admin.orders.read', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { id } = await params;
  return NextResponse.json(
    {
      endpoint: `/api/admin/orders/${id}/status`,
      method: 'POST',
      description: 'Order status update endpoint (cancel or shipped)',
      requiredBody: { status: 'cancelled', reason: CANCEL_REASONS },
    },
    { status: 200 },
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await authorizeAdminPermission('admin.orders.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const { id } = await params;
    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = request.headers.get('user-agent') ?? null;
    const audit: AuditFn = (outcome, detail, metadata) =>
      logAudit({
        action: 'admin.orders.status.update',
        actor_id: authz.userId,
        resource: 'orders',
        resource_id: id,
        outcome,
        detail,
        ip: clientIp,
        user_agent: userAgent,
        metadata: metadata ?? null,
      });

    const parsedOrderId = orderIdSchema.safeParse(id);
    if (!parsedOrderId.success) {
      await audit('failure', 'Invalid order id');
      return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });
    }

    const parsedBody = updateStatusSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsedBody.success) {
      await audit('failure', 'Invalid request body');
      return NextResponse.json(
        { error: 'Invalid request body', details: parsedBody.error.flatten() },
        { status: 400 },
      );
    }

    if (parsedBody.data.status === 'shipped') {
      const serviceRoleSupabase = await createServiceRoleClient();
      const { data, error } = await serviceRoleSupabase.rpc('admin_ship_paid_order', {
        _actor_id: authz.userId,
        _order_id: parsedOrderId.data,
        _shipping_carrier: parsedBody.data.carrier,
        _tracking_number: parsedBody.data.trackingNumber,
      });

      if (error) {
        console.error('[admin.orders.status] Failed to ship order:', error);
        return NextResponse.json({ error: '発送状態の更新に失敗しました。' }, { status: 500 });
      }

      const shippedOrder = Array.isArray(data) ? data[0] : data;
      if (!shippedOrder) {
        await audit('failure', 'not_shippable');
        return NextResponse.json(
          {
            error:
              '発送できる状態ではありません。決済完了・未発送で配送先の必須項目が揃い、支払額の確認（要対応）が済んだ注文のみ発送できます。',
          },
          { status: 409 },
        );
      }

      await audit('success', 'Status changed to shipped', { status: 'shipped', carrier: parsedBody.data.carrier });

      await sendOrderShippedEmail({
        orderId: id,
        email: shippedOrder.shipping_email,
        fullName: shippedOrder.shipping_full_name,
        carrier: parsedBody.data.carrier,
        trackingNumber: parsedBody.data.trackingNumber,
      });

      return NextResponse.json({ success: true, status: 'shipped' }, { status: 200 });
    }

    const cancel: CancelRequest = {
      reason: parsedBody.data.reason,
      note: parsedBody.data.note || undefined,
      notifyCustomer: parsedBody.data.notifyCustomer,
    };
    if (cancel.reason === 'other' && !cancel.note) {
      return NextResponse.json({ error: '「その他」を選んだときはメモを入力してください。' }, { status: 400 });
    }

    const supabase = await createClient(request);
    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('orders')
      .select('id, status, payment_intent_id, checkout_session_id')
      .eq('id', parsedOrderId.data)
      .maybeSingle<CurrentOrder>();

    if (currentOrderError) {
      console.error('[admin.orders.status] Failed to fetch order:', currentOrderError);
      return NextResponse.json({ error: 'Failed to update order status' }, { status: 500 });
    }

    if (!currentOrder) {
      await audit('failure', 'Order not found');
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    if (currentOrder.status === 'cancelled') {
      await audit('conflict', 'Order already cancelled');
      return NextResponse.json({ success: true, status: 'cancelled' }, { status: 200 });
    }

    if (currentOrder.status === 'shipped') {
      await audit('conflict', 'Order already shipped');
      return NextResponse.json({ error: '発送済みの注文はキャンセルできません。' }, { status: 409 });
    }

    if (currentOrder.status === 'paid') {
      await audit('conflict', 'Cannot cancel: order is already paid');
      return NextResponse.json(
        { error: '支払い済みの注文は返金処理を伴わずキャンセルできません。' },
        { status: 409 },
      );
    }

    if (currentOrder.status === 'abandoned') {
      await audit('conflict', 'Cannot cancel: order is abandoned');
      return NextResponse.json({ error: '放棄された注文は取り消せません。' }, { status: 409 });
    }

    if (currentOrder.status === 'failed') {
      return cancelFailedOrder(currentOrder, cancel, authz.userId, audit);
    }

    return cancelUnpaidOrder(currentOrder, cancel, authz.userId, audit);
  } catch (error) {
    console.error('POST /api/admin/orders/:id/status error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** 失敗 → 取消。在庫は戻し済み。お客様には送らない（期限切れで知らせ済み） */
async function cancelFailedOrder(
  order: CurrentOrder,
  cancel: CancelRequest,
  actorId: string,
  audit: AuditFn,
): Promise<Response> {
  const serviceRoleSupabase = await createServiceRoleClient();
  const { data, error } = await serviceRoleSupabase.rpc('admin_cancel_failed_order', {
    _order_id: order.id,
    _actor_id: actorId,
    _cancel_reason: cancel.reason,
    _note: cancel.note ?? null,
  });

  if (error) {
    console.error('[admin.orders.status] Failed to cancel failed order:', error);
    await audit('error', 'Failed to update order status');
    return NextResponse.json({ error: 'Failed to update order status' }, { status: 500 });
  }

  const updated = Array.isArray(data) ? data[0] : data;
  if (!updated) {
    await audit('conflict', 'Order state changed before failed-order cancellation could be applied');
    return NextResponse.json({ error: STATE_CHANGED_MESSAGE }, { status: 409 });
  }

  await audit('success', 'Status changed to cancelled', { from: 'failed', to: 'cancelled', cancel_reason: cancel.reason });
  return NextResponse.json({ success: true, status: 'cancelled' }, { status: 200 });
}

/**
 * 支払い手続き中・入金待ち → 取消（設計書 3-2・5-2、R-18）。
 * 支払い手続き中は開いている決済を先に失効させる（Checkout の PaymentIntent は直接 cancel できない）。
 * 入金待ちは払込票が有効な間は取り消さない。どちらも最後は照合関数が Stripe の現在値で決める。
 */
async function cancelUnpaidOrder(
  order: CurrentOrder,
  cancel: CancelRequest,
  actorId: string,
  audit: AuditFn,
): Promise<Response> {
  const stripe = getStripeServerClient();

  try {
    if (order.status === 'payment_in_progress') {
      if (order.checkout_session_id) {
        await expireOpenCheckoutSession(stripe, order.checkout_session_id);
      }
    } else {
      const snapshot = await readCheckoutPayment(stripe as unknown as CheckoutPaymentStripeClient, {
        checkoutSessionId: order.checkout_session_id,
        paymentIntentId: order.payment_intent_id,
      });
      if (snapshot.state.kind === 'awaiting_payment') {
        const cancelBlockedUntil = snapshot.voucherExpiresAt?.toISOString() ?? null;
        await audit('conflict', 'Cannot cancel: payment voucher is still valid', { voucher_expires_at: cancelBlockedUntil });
        return NextResponse.json({ error: VOUCHER_VALID_MESSAGE, cancelBlockedUntil }, { status: 409 });
      }
    }

    const result = await reconcileCheckoutPayment(await createDefaultReconcilerDeps(), {
      checkoutSessionId: order.checkout_session_id,
      paymentIntentId: order.payment_intent_id,
      adminCancel: { actorId, reason: cancel.reason, note: cancel.note, notifyCustomer: cancel.notifyCustomer },
    });
    return respondToCancelResult(result, order, cancel, audit);
  } catch (error) {
    if (error instanceof ReconcileTransientError) {
      await audit('error', 'Cannot cancel: Stripe or database is temporarily unavailable', { reason: error.code });
      return NextResponse.json(
        { error: 'Stripe の状態を確認できませんでした。時間をおいて再試行してください。' },
        { status: 503 },
      );
    }

    console.error('[admin.orders.status] Failed to cancel unpaid order:', error);
    await audit('error', 'Failed to terminate Stripe Checkout payment');
    return NextResponse.json({ error: 'Stripe 決済のキャンセルに失敗しました。' }, { status: 500 });
  }
}

async function respondToCancelResult(
  result: ReconcileResult,
  order: CurrentOrder,
  cancel: CancelRequest,
  audit: AuditFn,
): Promise<Response> {
  if (result.kind === 'needs_action') {
    await audit('conflict', 'Cannot cancel: payment needs action', { exception_reason: result.reason });
    return NextResponse.json(
      {
        error: `要対応として記録しました（${PAYMENT_EXCEPTION_REASON_LABELS[result.reason]}）。ORDER タブの要対応から対応してください。`,
      },
      { status: 409 },
    );
  }

  if (result.orderStatus === 'cancelled') {
    await audit('success', 'Status changed to cancelled', {
      from: order.status,
      to: 'cancelled',
      cancel_reason: cancel.reason,
      notify_customer: cancel.notifyCustomer,
    });
    return NextResponse.json({ success: true, status: 'cancelled' }, { status: 200 });
  }

  if (result.orderStatus === 'paid' || result.orderStatus === 'shipped') {
    await audit('conflict', 'Cannot cancel: payment completed', { order_status: result.orderStatus });
    return NextResponse.json(
      { error: '支払いが完了したためキャンセルできません。返金は別の操作で行ってください。' },
      { status: 409 },
    );
  }

  if (result.orderStatus === 'pending') {
    await audit('conflict', 'Cannot cancel: payment voucher was issued');
    return NextResponse.json({ error: VOUCHER_VALID_MESSAGE }, { status: 409 });
  }

  await audit('conflict', 'Order state changed before cancellation could be applied', { order_status: result.orderStatus });
  return NextResponse.json({ error: STATE_CHANGED_MESSAGE }, { status: 409 });
}
```

- [ ] **Step 4: テストを通す**

Run: `npx jest tests/unit/api/admin/order-status-shipped && npm run typecheck && npx eslint "src/app/api/admin/orders/[id]/status/route.ts"`
Expected: PASS、lint の指摘なし

- [ ] **Step 5: コミット**

```bash
git add "src/app/api/admin/orders/[id]/status/route.ts" tests/unit/api/admin/order-status-shipped.test.ts
git commit -m "feat(admin): 未入金の注文の取消に理由・メモ・お知らせの有無を付けて照合関数に任せる

実行者を注文履歴に残す（R-18）。払込票が有効な入金待ちは払込期限を返して断る。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 17: 要対応・要確認の管理 API

**Files:**
- Modify: `src/lib/orders/order-payment-types.ts`（管理画面と共有する型を足す）
- Create: `src/app/api/admin/order-attention/route.ts`
- Create: `src/app/api/admin/orders/[id]/review/route.ts`
- Create: `src/app/api/admin/payment-exceptions/[id]/resolve/route.ts`
- Create: `tests/unit/api/admin/order-attention-route.test.ts`

**Interfaces:**
- Consumes: Task 6 の `mark_order_reviewed`・`resolve_payment_exception`、Task 8 の型とラベル、Task 10 の `sendOrderCanceledEmail`
- Produces:
  - `GET /api/admin/order-attention` → `{ data: { exceptions: AttentionException[]; reviews: AttentionReview[]; counts: { exceptions: number; reviews: number } } }`
    - `AttentionException = { id; reason; reasonLabel; detail; orderId; orderNumber; orderStatus; paymentRef; firstDetectedAt; lastDetectedAt; detectionCount; canCancelOrder }`
    - `AttentionReview = { orderId; orderNumber; orderStatus; reviewReason; reviewReasonLabel; reviewMarkedAt }`
    - 型（`AttentionException`・`AttentionReview`・`OrderAttention`）は `src/lib/orders/order-payment-types.ts` に置き、画面（Task 19）と共有する
  - `POST /api/admin/orders/:id/review` → `200 { success: true }` / `409`
  - `POST /api/admin/payment-exceptions/:id/resolve`
    - 入力: `{ note?: string(≤500), cancelOrder?: boolean, cancelReason?: CancelReason, notifyCustomer?: boolean }`
    - 出力: `200 { success: true, orderCancelled: boolean }` / `400` / `409`
  - 3つとも、検証済みの JWT・権限（ACL）・2要素認証済み（`authorizeAdminPermission`）と Origin の確認（`src/proxy.ts`）を通る。POST の2つは CSRF トークン（`requireCsrfOrDeny`）も確かめる

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/api/admin/order-attention-route.test.ts`:
```ts
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

const mockAuthorize = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
}));

const mockRequireCsrf = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({
  requireCsrfOrDeny: (...args: unknown[]) => mockRequireCsrf(...args),
}));

const mockRpc = jest.fn();
const mockSelectColumns: string[] = [];
let exceptionRows: unknown[] = [];
let reviewRows: unknown[] = [];

function listQuery(rows: () => unknown[]) {
  const query: Record<string, unknown> = {};
  for (const method of ['is', 'not', 'order']) {
    query[method] = () => query;
  }
  query.limit = async () => ({ data: rows(), count: rows().length, error: null });
  return query;
}

const mockServiceClient = {
  rpc: (...args: unknown[]) => mockRpc(...args),
  from: (table: string) => ({
    select: (columns: string) => {
      mockSelectColumns.push(columns);
      return table === 'payment_exceptions' ? listQuery(() => exceptionRows) : listQuery(() => reviewRows);
    },
  }),
};
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => mockServiceClient),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

const mockSendOrderCanceledEmail = jest.fn().mockResolvedValue(true);
jest.mock('@/lib/orders/order-lifecycle-emails', () => ({
  sendOrderCanceledEmail: (...args: unknown[]) => mockSendOrderCanceledEmail(...args),
}));

import { GET as getAttention } from '@/app/api/admin/order-attention/route';
import { POST as postReview } from '@/app/api/admin/orders/[id]/review/route';
import { POST as postResolve } from '@/app/api/admin/payment-exceptions/[id]/resolve/route';

type RouteResponse = { status: number; body: Record<string, any> };

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const EXCEPTION_ID = 'b1b2c3d4-1111-2222-8333-444455556666';

function jsonRequest(url: string, body: unknown = {}) {
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function resolve(body: Record<string, unknown>): Promise<RouteResponse> {
  return (await postResolve(
    jsonRequest(`http://localhost/api/admin/payment-exceptions/${EXCEPTION_ID}/resolve`, body),
    { params: Promise.resolve({ id: EXCEPTION_ID }) },
  )) as unknown as RouteResponse;
}

async function review(id = ORDER_ID): Promise<RouteResponse> {
  return (await postReview(
    jsonRequest(`http://localhost/api/admin/orders/${id}/review`),
    { params: Promise.resolve({ id }) },
  )) as unknown as RouteResponse;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSelectColumns.length = 0;
  exceptionRows = [];
  reviewRows = [];
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'supporter', actorEmail: null });
  mockRequireCsrf.mockResolvedValue(undefined);
});

describe('GET /api/admin/order-attention', () => {
  it('未解決の要対応と未確認の要確認を、件数と一緒に返す', async () => {
    exceptionRows = [{
      id: EXCEPTION_ID,
      reason: 'order_not_creatable',
      detail: 'item_unavailable',
      order_id: null,
      payment_ref: 'cs_1',
      first_detected_at: '2026-09-27T01:00:00.000Z',
      last_detected_at: '2026-09-27T02:00:00.000Z',
      detection_count: 2,
      orders: null,
    }, {
      id: 'c1b2c3d4-1111-2222-8333-444455556666',
      reason: 'unexpected_state',
      detail: null,
      order_id: ORDER_ID,
      payment_ref: 'cs_2',
      first_detected_at: '2026-09-27T01:30:00.000Z',
      last_detected_at: '2026-09-27T01:30:00.000Z',
      detection_count: 1,
      orders: { status: 'payment_in_progress' },
    }];
    reviewRows = [{ id: ORDER_ID, status: 'paid', review_reason: 'stock_not_reserved', review_marked_at: '2026-09-27T01:00:00.000Z' }];

    const res = (await getAttention(new Request('http://localhost/api/admin/order-attention'))) as unknown as RouteResponse;

    expect(res.status).toBe(200);
    expect(res.body.data.counts).toEqual({ exceptions: 2, reviews: 1 });
    expect(res.body.data.exceptions[0]).toEqual({
      id: EXCEPTION_ID,
      reason: 'order_not_creatable',
      reasonLabel: '注文を作れない支払い',
      detail: 'item_unavailable',
      orderId: null,
      orderNumber: null,
      orderStatus: null,
      paymentRef: 'cs_1',
      firstDetectedAt: '2026-09-27T01:00:00.000Z',
      lastDetectedAt: '2026-09-27T02:00:00.000Z',
      detectionCount: 2,
      canCancelOrder: false,
    });
    expect(res.body.data.exceptions[1]).toMatchObject({ orderNumber: 'ORD-A1B2C3D4', canCancelOrder: true });
    expect(res.body.data.reviews[0]).toEqual({
      orderId: ORDER_ID,
      orderNumber: 'ORD-A1B2C3D4',
      orderStatus: 'paid',
      reviewReason: 'stock_not_reserved',
      reviewReasonLabel: '在庫を確保できなかった注文',
      reviewMarkedAt: '2026-09-27T01:00:00.000Z',
    });
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.read', expect.any(Request));
  });

  it('お客様の個人情報の列を読まない', async () => {
    await getAttention(new Request('http://localhost/api/admin/order-attention'));

    expect(mockSelectColumns.join(',')).not.toMatch(/shipping_|email|name|phone/);
  });

  it('権限が無ければ認可の応答をそのまま返す', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, response: { status: 403, body: { error: 'Forbidden' } } });

    const res = (await getAttention(new Request('http://localhost/api/admin/order-attention'))) as unknown as RouteResponse;

    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/orders/:id/review', () => {
  it('確認済みにし、実行者を渡す', async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });

    const res = await review();

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('mark_order_reviewed', { _order_id: ORDER_ID, _actor_id: 'admin-1' });
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.orders.review', actor_id: 'admin-1', outcome: 'success' }));
  });

  it('確認済みにできる要確認が無ければ 409', async () => {
    mockRpc.mockResolvedValue({ data: false, error: null });

    expect((await review()).status).toBe(409);
  });

  it('CSRF トークンが合わなければ何もしない', async () => {
    mockRequireCsrf.mockResolvedValue(new Response(null, { status: 403 }));

    expect((await review()).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('注文 ID の形が違えば 400', async () => {
    expect((await review('not-a-uuid')).status).toBe(400);
  });
});

describe('POST /api/admin/payment-exceptions/:id/resolve', () => {
  it('メモを付けて解決済みにする', async () => {
    mockRpc.mockResolvedValue({ data: [{ resolved: true, order_id: null, cancelled_from: null }], error: null });

    const res = await resolve({ note: 'Stripe で返金済み' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, orderCancelled: false });
    expect(mockRpc).toHaveBeenCalledWith('resolve_payment_exception', {
      _exception_id: EXCEPTION_ID,
      _actor_id: 'admin-1',
      _note: 'Stripe で返金済み',
      _cancel_order: false,
      _cancel_reason: null,
      _notify_customer: null,
    });
  });

  it('別の管理者が先に解決していたら 409（二重に取り消さない）', async () => {
    mockRpc.mockResolvedValue({ data: [{ resolved: false, order_id: ORDER_ID, cancelled_from: null }], error: null });

    const res = await resolve({ note: 'メモ' });

    expect(res.status).toBe(409);
    expect(mockSendOrderCanceledEmail).not.toHaveBeenCalled();
  });

  it('「注文を取り消して解決」は理由とメモが要る', async () => {
    expect((await resolve({ cancelOrder: true, note: 'メモ' })).status).toBe(400);
    expect((await resolve({ cancelOrder: true, cancelReason: 'other' })).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([true, false])('注文を取り消して解決し、取消のお知らせは notifyCustomer=%s のときだけ送る', async (notifyCustomer) => {
    mockRpc.mockResolvedValue({ data: [{ resolved: true, order_id: ORDER_ID, cancelled_from: 'payment_in_progress' }], error: null });

    const res = await resolve({ cancelOrder: true, cancelReason: 'other', note: 'Stripe に支払いが無い', notifyCustomer });

    expect(res.body).toEqual({ success: true, orderCancelled: true });
    expect(mockRpc).toHaveBeenCalledWith('resolve_payment_exception', expect.objectContaining({
      _cancel_order: true,
      _cancel_reason: 'other',
      _notify_customer: notifyCustomer,
    }));
    expect(mockSendOrderCanceledEmail).toHaveBeenCalledTimes(notifyCustomer ? 1 : 0);
  });

  it('未入金でない注文は取り消せず 409', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'ORDER_NOT_CANCELLABLE' } });

    const res = await resolve({ cancelOrder: true, cancelReason: 'other', note: 'メモ' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('未入金');
  });

  it('メモは500文字まで', async () => {
    expect((await resolve({ note: 'あ'.repeat(501) })).status).toBe(400);
  });

  it('CSRF トークンが合わなければ何もしない', async () => {
    mockRequireCsrf.mockResolvedValue(new Response(null, { status: 403 }));

    expect((await resolve({ note: 'メモ' })).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `npx jest tests/unit/api/admin/order-attention-route`
Expected: FAIL（`Cannot find module '@/app/api/admin/order-attention/route'`）

- [ ] **Step 3: 一覧の API を書く**

`src/lib/orders/order-payment-types.ts` の末尾に足す（API と管理画面で共有する）:
```ts
/** 管理画面の「要対応・要確認」欄の1行（要対応）。お客様の個人情報は入れない */
export type AttentionException = {
  id: string;
  reason: PaymentExceptionReason;
  reasonLabel: string;
  detail: string | null;
  orderId: string | null;
  orderNumber: string | null;
  orderStatus: OrderStatus | null;
  paymentRef: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  detectionCount: number;
  /** 未入金の注文が付いていれば「注文を取り消して解決」を選べる */
  canCancelOrder: boolean;
};

/** 管理画面の「要対応・要確認」欄の1行（要確認） */
export type AttentionReview = {
  orderId: string;
  orderNumber: string;
  orderStatus: OrderStatus;
  reviewReason: string;
  reviewReasonLabel: string;
  reviewMarkedAt: string | null;
};

export type OrderAttention = {
  exceptions: AttentionException[];
  reviews: AttentionReview[];
  counts: { exceptions: number; reviews: number };
};
```

`src/app/api/admin/order-attention/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { toOrderNumber } from '@/lib/orders/order-number';
import {
  PAYMENT_EXCEPTION_REASON_LABELS,
  type AttentionException,
  type AttentionReview,
  type OrderAttention,
  type OrderStatus,
  type PaymentExceptionReason,
} from '@/lib/orders/order-payment-types';

/**
 * 管理画面の「要対応・要確認」欄（設計書 5-2）。店長も対応担当も見られる ORDER タブで使う。
 * お客様の個人情報は返さない（注文番号と Stripe の支払い ID だけ）。
 */
const MAX_ITEMS = 100;

const REVIEW_REASON_LABELS: Record<string, string> = {
  stock_not_reserved: '在庫を確保できなかった注文',
};

type ExceptionRow = {
  id: string;
  reason: PaymentExceptionReason;
  detail: string | null;
  order_id: string | null;
  payment_ref: string;
  first_detected_at: string;
  last_detected_at: string;
  detection_count: number;
  orders: { status: OrderStatus } | null;
};

type ReviewRow = {
  id: string;
  status: OrderStatus;
  review_reason: string;
  review_marked_at: string | null;
};

export async function GET(request: Request) {
  const authz = await authorizeAdminPermission('admin.orders.read', request);
  if (!authz.ok) {
    return authz.response;
  }

  try {
    const supabase = await createServiceRoleClient();
    const [exceptionsResult, reviewsResult] = await Promise.all([
      supabase
        .from('payment_exceptions')
        .select(
          'id, reason, detail, order_id, payment_ref, first_detected_at, last_detected_at, detection_count, orders(status)',
          { count: 'exact' },
        )
        .is('resolved_at', null)
        .order('first_detected_at', { ascending: true })
        .limit(MAX_ITEMS),
      supabase
        .from('orders')
        .select('id, status, review_reason, review_marked_at', { count: 'exact' })
        .not('review_reason', 'is', null)
        .is('reviewed_at', null)
        .order('review_marked_at', { ascending: true })
        .limit(MAX_ITEMS),
    ]);

    if (exceptionsResult.error || reviewsResult.error) {
      console.error('[admin.order-attention] Failed to fetch', exceptionsResult.error ?? reviewsResult.error);
      return NextResponse.json({ error: 'Failed to fetch order attention' }, { status: 500 });
    }

    const exceptions: AttentionException[] = ((exceptionsResult.data ?? []) as unknown as ExceptionRow[]).map((row) => {
      const orderStatus = row.orders?.status ?? null;
      return {
        id: row.id,
        reason: row.reason,
        reasonLabel: PAYMENT_EXCEPTION_REASON_LABELS[row.reason] ?? row.reason,
        detail: row.detail,
        orderId: row.order_id,
        orderNumber: row.order_id ? toOrderNumber(row.order_id) : null,
        orderStatus,
        paymentRef: row.payment_ref,
        firstDetectedAt: row.first_detected_at,
        lastDetectedAt: row.last_detected_at,
        detectionCount: row.detection_count,
        canCancelOrder: orderStatus === 'payment_in_progress' || orderStatus === 'pending',
      };
    });

    const reviews: AttentionReview[] = ((reviewsResult.data ?? []) as ReviewRow[]).map((row) => ({
      orderId: row.id,
      orderNumber: toOrderNumber(row.id),
      orderStatus: row.status,
      reviewReason: row.review_reason,
      reviewReasonLabel: REVIEW_REASON_LABELS[row.review_reason] ?? row.review_reason,
      reviewMarkedAt: row.review_marked_at,
    }));

    const data: OrderAttention = {
      exceptions,
      reviews,
      counts: {
        exceptions: exceptionsResult.count ?? exceptions.length,
        reviews: reviewsResult.count ?? reviews.length,
      },
    };
    return NextResponse.json({ data });
  } catch (error) {
    console.error('GET /api/admin/order-attention error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

- [ ] **Step 4: 確認済みの API を書く**

`src/app/api/admin/orders/[id]/review/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';

/** 要確認を確認済みにする（設計書 5-2）。手動の操作でだけ付く */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await authorizeAdminPermission('admin.orders.manage', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const csrfResult = await requireCsrfOrDeny();
  if (csrfResult instanceof Response) {
    return csrfResult;
  }

  const { id } = await params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });
  }

  try {
    const supabase = await createServiceRoleClient();
    const { data, error } = await supabase.rpc('mark_order_reviewed', {
      _order_id: parsedId.data,
      _actor_id: authz.userId,
    });

    if (error) {
      console.error('[admin.orders.review] Failed to mark reviewed:', error);
      return NextResponse.json({ error: 'Failed to mark reviewed' }, { status: 500 });
    }

    const reviewed = data === true;
    await logAudit({
      action: 'admin.orders.review',
      actor_id: authz.userId,
      resource: 'orders',
      resource_id: parsedId.data,
      outcome: reviewed ? 'success' : 'conflict',
      detail: reviewed ? 'Order marked as reviewed' : 'No open review for the order',
    });

    if (!reviewed) {
      return NextResponse.json(
        { error: '確認済みにできる要確認がありません。一覧を更新してください。' },
        { status: 409 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('POST /api/admin/orders/:id/review error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

- [ ] **Step 5: 解決済みの API を書く**

`src/app/api/admin/payment-exceptions/[id]/resolve/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { sendOrderCanceledEmail } from '@/lib/orders/order-lifecycle-emails';
import { ADMIN_NOTE_MAX_LENGTH, CANCEL_REASONS } from '@/lib/orders/order-payment-types';

const resolveSchema = z.object({
  note: z.string().trim().max(ADMIN_NOTE_MAX_LENGTH).optional(),
  cancelOrder: z.boolean().default(false),
  cancelReason: z.enum(CANCEL_REASONS).optional(),
  notifyCustomer: z.boolean().default(true),
});

type ResolveRow = {
  resolved: boolean;
  order_id: string | null;
  cancelled_from: 'payment_in_progress' | 'pending' | null;
};

/**
 * 要対応を解決済みにする（設計書 5-2）。未入金の注文が付いていれば、取り消して解決もできる（メモ必須）。
 * 取り消した場合は確保した分だけ在庫を戻し、注文履歴に実行者と理由を残す（RPC の中）。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await authorizeAdminPermission('admin.orders.manage', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const csrfResult = await requireCsrfOrDeny();
  if (csrfResult instanceof Response) {
    return csrfResult;
  }

  const { id } = await params;
  const parsedId = z.string().uuid().safeParse(id);
  const parsedBody = resolveSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsedId.success || !parsedBody.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const { note, cancelOrder, cancelReason, notifyCustomer } = parsedBody.data;
  if (cancelOrder && (!note || !cancelReason)) {
    return NextResponse.json(
      { error: '注文を取り消して解決するときは、取消の理由とメモを入力してください。' },
      { status: 400 },
    );
  }

  try {
    const supabase = await createServiceRoleClient();
    const { data, error } = await supabase.rpc('resolve_payment_exception', {
      _exception_id: parsedId.data,
      _actor_id: authz.userId,
      _note: note || null,
      _cancel_order: cancelOrder,
      _cancel_reason: cancelOrder ? cancelReason : null,
      _notify_customer: cancelOrder ? notifyCustomer : null,
    });

    if (error) {
      if (error.message?.includes('ORDER_NOT_CANCELLABLE')) {
        return NextResponse.json({ error: '未入金の注文だけ取り消せます。' }, { status: 409 });
      }
      console.error('[admin.payment-exceptions.resolve] Failed to resolve:', error);
      return NextResponse.json({ error: 'Failed to resolve' }, { status: 500 });
    }

    const row = (Array.isArray(data) ? data[0] : data) as ResolveRow | null;
    if (!row?.resolved) {
      await logAudit({
        action: 'admin.payment_exceptions.resolve',
        actor_id: authz.userId,
        resource: 'payment_exceptions',
        resource_id: parsedId.data,
        outcome: 'conflict',
        detail: 'Payment exception was already resolved or changed',
      });
      return NextResponse.json(
        { error: '既に解決済みか、状態が変わりました。一覧を更新してください。' },
        { status: 409 },
      );
    }

    if (row.cancelled_from && row.order_id && notifyCustomer) {
      await sendOrderCanceledEmail({
        store: supabase,
        orderId: row.order_id,
        previousStatus: row.cancelled_from,
        logLabel: '[admin]',
      });
    }

    await logAudit({
      action: 'admin.payment_exceptions.resolve',
      actor_id: authz.userId,
      resource: 'payment_exceptions',
      resource_id: parsedId.data,
      outcome: 'success',
      detail: row.cancelled_from ? 'Payment exception resolved with order cancellation' : 'Payment exception resolved',
      metadata: {
        order_id: row.order_id,
        cancel_order: Boolean(row.cancelled_from),
        cancel_reason: row.cancelled_from ? cancelReason : null,
      },
    });

    return NextResponse.json({ success: true, orderCancelled: Boolean(row.cancelled_from) });
  } catch (error) {
    console.error('POST /api/admin/payment-exceptions/:id/resolve error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

- [ ] **Step 6: テストを通す**

Run: `npx jest tests/unit/api/admin/order-attention-route && npm run typecheck && npx eslint src/app/api/admin/order-attention "src/app/api/admin/orders/[id]/review" "src/app/api/admin/payment-exceptions"`
Expected: PASS、lint の指摘なし

- [ ] **Step 7: コミット**

```bash
git add src/lib/orders/order-payment-types.ts src/app/api/admin/order-attention/route.ts "src/app/api/admin/orders/[id]/review/route.ts" "src/app/api/admin/payment-exceptions/[id]/resolve/route.ts" tests/unit/api/admin/order-attention-route.test.ts
git commit -m "feat(admin): 要対応・要確認の一覧と、確認済み・解決済みの API を足す

POST は CSRF トークンと admin.orders.manage を確かめ、実行者を監査ログに残す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 18: 注文一覧・KPI・お客様の注文履歴を新しい状態に合わせる

**Files:**
- Modify: `src/app/api/admin/orders/route.ts`
- Modify: `tests/unit/api/admin/orders-search-route.test.ts`
- Modify: `src/app/api/admin/orders/[id]/refund/route.ts:20-25`・`:130`（PaymentIntent が空の注文）
- Modify: `src/app/api/admin/kpi/route.ts:304-309`
- Create: `tests/unit/api/admin/kpi-hidden-statuses.test.ts`
- Modify: `src/app/api/orders/route.ts:106-135`・`src/app/api/orders/[id]/route.ts:104-141`
- Create: `tests/unit/api/orders/orders-hidden-statuses.test.ts`
- Modify: `tests/integration/api/orders.test.ts`（注文の読み込みのモック3か所に `not` を足す）
- Modify: `docs/2_Specs/spec.md`（FREQ 行）

**Interfaces:**
- Consumes: Task 2 の列、Task 6 の `payment_exceptions`、Task 8 の `ORDER_STATUSES`・`HIDDEN_ORDER_STATUS_FILTER`
- Produces: 管理 API `GET /api/admin/orders`
  - クエリ: `status` に `payment_in_progress`・`abandoned` を足す。`review=only` を足す。status が無ければ放棄を除く
  - 各行に足す: `needsReview: boolean`・`shipBlockedReason: string | null`・`canCancel: boolean`・`cancelBlockedUntil: string | null`
  - 表示名: `status` に `'支払い手続き中'`・`'放棄'` を足す

- [ ] **Step 1: FREQ の番号を確かめる**

Run: `grep -oE "FREQ-[0-9]+" docs/2_Specs/spec.md | sort -t- -k2 -n | tail -1`
Expected: `FREQ-409`（違えば FREQ-410 を次の番号に読み替える）

- [ ] **Step 2: 失敗するテストを書く（管理の注文一覧）**

`tests/unit/api/admin/orders-search-route.test.ts` を次のように変える。

`jest.mock('@/lib/supabase/server', ...)` を替える:
```ts
const createServiceRoleClientMock = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
  createServiceRoleClient: (...args: unknown[]) => createServiceRoleClientMock(...args),
}));
```
`query` に `neq`・`not`・`is` を足し、`beforeEach` の `for` の並びにも足す:
```ts
  const query = {
    select: jest.fn(),
    order: jest.fn(),
    range: jest.fn(),
    gte: jest.fn(),
    lte: jest.fn(),
    eq: jest.fn(),
    neq: jest.fn(),
    not: jest.fn(),
    is: jest.fn(),
    or: jest.fn(),
    then: (resolve: (value: unknown) => void) => resolve(queryResult),
  };
```
```ts
    for (const method of ['select', 'order', 'range', 'gte', 'lte', 'eq', 'neq', 'not', 'is', 'or'] as const) {
```
`beforeEach` の末尾に足す（支払額の違いの要対応は既定で無し）:
```ts
    shipBlockedRows = [];
    createServiceRoleClientMock.mockResolvedValue({
      from: jest.fn().mockReturnValue({
        select: () => ({
          in: () => ({
            eq: () => ({
              is: async () => ({ data: shipBlockedRows, error: null }),
            }),
          }),
        }),
      }),
    });
```
`let queryResult ...` の次の行に足す:
```ts
let shipBlockedRows: Array<{ order_id: string }> = [];
```
`it.each(['amountMin=-1', ...])` の配列から `'status=unknown'` はそのまま残す。`describe` の末尾に足す:
```ts
  it('状態の絞り込みに支払い手続き中と放棄を足し、既定の一覧では放棄を除く', async () => {
    const { GET } = await import('@/app/api/admin/orders/route');

    expect((await GET(new Request('http://localhost/api/admin/orders?status=payment_in_progress'))).status).toBe(200);
    expect(query.eq).toHaveBeenCalledWith('status', 'payment_in_progress');
    expect(query.neq).not.toHaveBeenCalled();

    query.eq.mockClear();
    await GET(new Request('http://localhost/api/admin/orders'));
    expect(query.neq).toHaveBeenCalledWith('status', 'abandoned');
  });

  it('要確認のみの絞り込みは、確認済みでない要確認の注文だけにする', async () => {
    const { GET } = await import('@/app/api/admin/orders/route');

    await GET(new Request('http://localhost/api/admin/orders?review=only'));

    expect(query.not).toHaveBeenCalledWith('review_reason', 'is', null);
    expect(query.is).toHaveBeenCalledWith('reviewed_at', null);
  });

  it('新しい状態の表示名・要確認の印・発送止め・取消の可否を返し、PaymentIntent が空でも落ちない', async () => {
    const future = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    queryResult = {
      data: [
        {
          id: 'order-in-progress',
          payment_intent_id: null,
          checkout_session_id: 'cs_1',
          status: 'payment_in_progress',
          total_amount: 10_000,
          currency: 'jpy',
          review_reason: null,
          reviewed_at: null,
          created_at: '2026-09-27T00:00:00.000Z',
          order_items: [],
        },
        {
          id: 'order-voucher',
          payment_intent_id: 'pi_voucher',
          checkout_session_id: 'cs_2',
          status: 'pending',
          total_amount: 10_000,
          currency: 'jpy',
          review_reason: null,
          reviewed_at: null,
          created_at: '2026-09-27T00:00:00.000Z',
          order_items: [],
        },
        {
          id: 'order-mismatch',
          payment_intent_id: 'pi_mismatch',
          checkout_session_id: 'cs_3',
          status: 'paid',
          total_amount: 10_000,
          currency: 'jpy',
          shipping_email: 'buyer@example.com',
          shipping_full_name: '山田太郎',
          shipping_postal_code: '1000001',
          shipping_prefecture: '東京都',
          shipping_city: '千代田区',
          shipping_address: '丸の内1-1-1',
          shipping_phone: '0312345678',
          review_reason: 'stock_not_reserved',
          reviewed_at: null,
          created_at: '2026-09-27T00:00:00.000Z',
          order_items: [],
        },
      ],
      count: 3,
      error: null,
    };
    shipBlockedRows = [{ order_id: 'order-mismatch' }];
    getStripeMock.mockReturnValue({
      paymentIntents: {
        retrieve: jest.fn().mockImplementation((id: string) => Promise.resolve(
          id === 'pi_voucher'
            ? {
                id,
                status: 'requires_action',
                payment_method_types: ['konbini'],
                next_action: { konbini_display_details: { expires_at: future } },
              }
            : { id, status: 'succeeded', payment_method_types: ['card'] },
        )),
      },
    });

    const { GET } = await import('@/app/api/admin/orders/route');
    const response = await GET(new Request('http://localhost/api/admin/orders'));
    const body = await response.json() as { data: Array<Record<string, unknown>> };
    const byId = Object.fromEntries(body.data.map((row) => [row.id, row]));

    expect(byId['order-in-progress']).toMatchObject({ status: '支払い手続き中', canCancel: true, cancelBlockedUntil: null });
    expect(byId['order-voucher']).toMatchObject({
      status: '未決済',
      canCancel: false,
      cancelBlockedUntil: new Date(future * 1000).toISOString(),
    });
    expect(byId['order-mismatch']).toMatchObject({
      status: '決済完了',
      needsReview: true,
      canShip: false,
      shipBlockedReason: '支払額の確認が必要です（要対応）',
    });
  });
```

- [ ] **Step 3: 失敗するテストを書く（KPI とお客様の注文履歴）**

`tests/unit/api/admin/kpi-hidden-statuses.test.ts`:
```ts
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn().mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin' }),
}));

const mockNot = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    from: (table: string) => ({
      select: () => {
        if (table !== 'orders') {
          return Promise.resolve({ data: [], error: null });
        }
        return {
          not: (...args: unknown[]) => {
            mockNot(...args);
            return { order: async () => ({ data: [], error: null }) };
          },
        };
      },
    }),
  })),
}));

import { GET } from '@/app/api/admin/kpi/route';

describe('GET /api/admin/kpi', () => {
  it('支払い手続き中と放棄の注文を数えない（受付の前の注文で CVR を下げない）', async () => {
    const response = (await GET(new Request('http://localhost/api/admin/kpi'))) as unknown as { status: number };

    expect(response.status).toBe(200);
    expect(mockNot).toHaveBeenCalledWith('status', 'in', '(payment_in_progress,abandoned)');
  });
});
```

`tests/unit/api/orders/orders-hidden-statuses.test.ts`:
```ts
jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
    },
  };
});

jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn().mockResolvedValue({ ok: true, claims: { sub: 'user-1' } }),
  authFailureResponse: jest.fn(),
}));

jest.mock('@/lib/storage/item-images', () => ({
  signItemImageUrl: jest.fn(async (_client: unknown, url: string | null) => url),
}));

const mockNot = jest.fn();

function orderQuery() {
  const query: Record<string, unknown> = {};
  query.select = () => query;
  query.eq = () => query;
  query.not = (...args: unknown[]) => {
    mockNot(...args);
    return query;
  };
  query.order = async () => ({ data: [], error: null });
  query.maybeSingle = async () => ({ data: null, error: null });
  return query;
}

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({ from: () => orderQuery() })),
  createServiceRoleClient: jest.fn(async () => ({ from: () => orderQuery() })),
}));

import { NextRequest } from 'next/server';
import { GET as listOrders } from '@/app/api/orders/route';
import { GET as getOrder } from '@/app/api/orders/[id]/route';

describe('お客様の注文履歴（設計書 5-5）', () => {
  beforeEach(() => {
    mockNot.mockClear();
  });

  it('注文履歴は支払い手続き中と放棄の注文を返さない', async () => {
    await listOrders(new NextRequest('http://localhost/api/orders'));

    expect(mockNot).toHaveBeenCalledWith('status', 'in', '(payment_in_progress,abandoned)');
  });

  it('注文詳細も支払い手続き中と放棄の注文を返さない（404 になる）', async () => {
    const response = (await getOrder(
      new NextRequest('http://localhost/api/orders/order-1'),
      { params: Promise.resolve({ id: 'order-1' }) },
    )) as unknown as { status: number };

    expect(mockNot).toHaveBeenCalledWith('status', 'in', '(payment_in_progress,abandoned)');
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 4: テストが落ちることを確かめる**

Run: `npx jest tests/unit/api/admin/orders-search-route tests/unit/api/admin/kpi-hidden-statuses tests/unit/api/orders/orders-hidden-statuses`
Expected: FAIL（新しい状態・絞り込み・除外が無い）

- [ ] **Step 5: 管理の注文一覧を変える**

`src/app/api/admin/orders/route.ts` を次のように変える。

import に足す:
```ts
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { ORDER_STATUSES, type OrderStatus } from '@/lib/orders/order-payment-types';
```
（元の `import { createClient } from '@/lib/supabase/server';` はこの行に置き換える）

`OrderRow` の `payment_intent_id` と `status` を替え、列を足す:
```ts
  payment_intent_id: string | null;
  checkout_session_id: string | null;
  status: OrderStatus;
  review_reason: string | null;
  reviewed_at: string | null;
```
`querySchema` の `status` を替え、`review` を足す:
```ts
    status: z.enum(ORDER_STATUSES).optional(),
    review: z.enum(['only']).optional(),
```
`parsedQuery` の組み立てに足す:
```ts
      review: requestUrl.searchParams.get('review') ?? undefined,
```
`mapOrderStatusToLabel` を替える:
```ts
type OrderStatusLabel = '支払い手続き中' | '未決済' | '決済完了' | '決済失敗' | '放棄' | 'キャンセル' | '発送済み';

function mapOrderStatusToLabel(status: OrderStatus): OrderStatusLabel {
  switch (status) {
    case 'payment_in_progress':
      return '支払い手続き中';
    case 'paid':
      return '決済完了';
    case 'failed':
      return '決済失敗';
    case 'abandoned':
      return '放棄';
    case 'cancelled':
      return 'キャンセル';
    case 'shipped':
      return '発送済み';
    case 'pending':
      return '未決済';
  }
}
```
`fetchPaymentIntentMap` の後に足す:
```ts
const SHIP_BLOCKED_REASON = '支払額の確認が必要です（要対応）';

/** 支払額の違いの要対応が開いている注文（発送の RPC も同じ条件で断る。設計書 4-1） */
async function fetchShipBlockedOrderIds(orderIds: string[]): Promise<Set<string>> {
  if (orderIds.length === 0) {
    return new Set();
  }

  const serviceRoleSupabase = await createServiceRoleClient();
  const { data, error } = await serviceRoleSupabase
    .from('payment_exceptions')
    .select('order_id')
    .in('order_id', orderIds)
    .eq('reason', 'paid_amount_mismatch')
    .is('resolved_at', null);

  if (error) {
    throw error;
  }

  return new Set((data ?? []).map((row: { order_id: string }) => row.order_id));
}

/** 払込票が有効なら、その期限（ISO）。取消はこの時刻を過ぎるまで押せない（設計書 5-2） */
function voucherValidUntil(paymentIntent: Stripe.PaymentIntent | null): string | null {
  const expiresAt = paymentIntent?.status === 'requires_action'
    ? paymentIntent.next_action?.konbini_display_details?.expires_at ?? null
    : null;
  return expiresAt && expiresAt * 1000 > Date.now() ? new Date(expiresAt * 1000).toISOString() : null;
}
```
select の列に足す（`payment_intent_id,` の次の行）:
```ts
        checkout_session_id,
        review_reason,
        reviewed_at,
```
`if (parsedQuery.data.status) { ... }` を替える:
```ts
    if (parsedQuery.data.status) {
      query = query.eq('status', parsedQuery.data.status);
    } else {
      // 放棄（決済画面を開いたまま離れた注文）は既定の一覧に出さない。絞り込みで選べる（設計書 5-2）
      query = query.neq('status', 'abandoned');
    }

    if (parsedQuery.data.review === 'only') {
      query = query.not('review_reason', 'is', null).is('reviewed_at', null);
    }
```
`paymentIntentIds` の組み立てを替え、発送止めを読む:
```ts
    const paymentIntentIds = orderRows
      .map((order) => order.payment_intent_id)
      .filter((paymentIntentId): paymentIntentId is string => Boolean(paymentIntentId?.startsWith('pi_')));

    const [paymentIntentMap, shipBlockedOrderIds] = await Promise.all([
      fetchPaymentIntentMap(paymentIntentIds),
      fetchShipBlockedOrderIds(orderRows.map((order) => order.id)),
    ]);
```
（元の `const paymentIntentMap = await fetchPaymentIntentMap(paymentIntentIds);` は消す）

`responseData` の `map` の中を替える（`paymentIntent` の取り出しと返す値）:
```ts
      const paymentIntent = order.payment_intent_id ? paymentIntentMap.get(order.payment_intent_id) ?? null : null;
```
```ts
      const shipBlockedReason = shipBlockedOrderIds.has(order.id) ? SHIP_BLOCKED_REASON : null;
      const cancelBlockedUntil = order.status === 'pending' ? voucherValidUntil(paymentIntent) : null;

      return {
        id: order.id,
        customerName: order.shipping_full_name?.trim() || 'ゲスト',
        customerEmail: order.shipping_email?.trim() || '-',
        orderDate: toJstDate(order.created_at),
        itemCount: `${totalQuantity}点`,
        items,
        totalAmount: toCurrencyLabel(order.total_amount, order.currency),
        status: mapOrderStatusToLabel(order.status),
        paymentMethod: mapPaymentMethodLabel(paymentIntent),
        paymentReference: order.payment_intent_id ?? order.checkout_session_id ?? '-',
        stripePaymentStatus: paymentIntent?.status ?? null,
        shippedAt: order.shipped_at,
        shippingCarrier: order.shipping_carrier,
        trackingNumber: order.tracking_number,
        canShip: order.status === 'paid' && missingShippingFields.length === 0 && !shipBlockedReason,
        missingShippingFields,
        shipBlockedReason,
        needsReview: order.review_reason !== null && order.reviewed_at === null,
        canCancel:
          order.status === 'payment_in_progress'
          || order.status === 'failed'
          || (order.status === 'pending' && !cancelBlockedUntil),
        cancelBlockedUntil,
        canRefund:
          (order.status === 'paid' || order.status === 'shipped') &&
          paymentIntent?.status === 'succeeded' &&
          Boolean(order.payment_intent_id?.startsWith('pi_')),
      };
```

- [ ] **Step 6: 返金 API を PaymentIntent が空の注文でも落ちないようにする**

`src/app/api/admin/orders/[id]/refund/route.ts` の `OrderLookupRow` を替える:
```ts
type OrderLookupRow = {
  id: string;
  payment_intent_id: string | null;
  status: 'payment_in_progress' | 'pending' | 'paid' | 'failed' | 'abandoned' | 'cancelled' | 'shipped';
  total_amount: number;
};
```
同じファイルの `if (!order.payment_intent_id.startsWith('pi_')) {` を替える（この判定の後は `order.payment_intent_id` が string に絞り込まれる）:
```ts
    if (!order.payment_intent_id?.startsWith('pi_')) {
```

- [ ] **Step 7: KPI とお客様の注文履歴から除く**

`src/app/api/admin/kpi/route.ts` の import に足す:
```ts
import { HIDDEN_ORDER_STATUS_FILTER } from '@/lib/orders/order-payment-types';
```
`orders` の読み込みを替える:
```ts
      supabase
        .from('orders')
        .select('id, session_id, user_id, payment_intent_id, status, total_amount, refunded_amount, currency, created_at')
        // 受付の前の注文（支払い手続き中・放棄）は数えない。CVR と返品率を下げないため
        .not('status', 'in', HIDDEN_ORDER_STATUS_FILTER)
        .order('created_at', { ascending: false }),
```
`src/app/api/orders/route.ts` と `src/app/api/orders/[id]/route.ts` の import に足す:
```ts
import { HIDDEN_ORDER_STATUS_FILTER } from '@/lib/orders/order-payment-types';
```
`src/app/api/orders/route.ts` の `.eq('user_id', userId)` の次の行に足す:
```ts
		// メールで知らせた注文だけを見せる（支払い手続き中・放棄は出さない。設計書 5-5）
		.not('status', 'in', HIDDEN_ORDER_STATUS_FILTER)
```
`src/app/api/orders/[id]/route.ts` の `.eq('user_id', userId)` の次の行に同じ2行を足す。両ファイルの `OrderRow`・`OrderDetailRow` の `status` の型に `'payment_in_progress' | 'abandoned'` は足さない（返さないため）

- [ ] **Step 8: 既存の注文履歴 API のテストのモックに `not` を足す**

Step 7 で両 route の注文の読み込み（`createClient` のクエリ）が `.not(...)` を呼ぶので、既存の `tests/integration/api/orders.test.ts` の3件が `...not is not a function` で落ちる。`createClient` の注文のクエリのモック3か所に `not: jest.fn().mockReturnThis(),` を足す。`createServiceRoleClient` のモック（`checkout_drafts`・`items` を読む）は `.not` を呼ばないので変えない。ファイルの字下げはタブなので、タブのまま足す。

`describe('GET /api/orders')` の `returns authenticated orders with no-store cache headers` の `orderQuery` の先頭を替える:
```ts
		const orderQuery = {
			select: jest.fn().mockReturnThis(),
			eq: jest.fn().mockReturnThis(),
			not: jest.fn().mockReturnThis(),
			order: jest.fn().mockResolvedValue({
```
`describe('GET /api/orders/[id]')` の `returns order detail with no-store cache headers` の `createClient.mockResolvedValue(...)` を替える:
```ts
		createClient.mockResolvedValue({
			from: jest.fn().mockReturnValue({
				select: jest.fn().mockReturnThis(),
				eq: jest.fn().mockReturnThis(),
				not: jest.fn().mockReturnThis(),
				maybeSingle,
			}),
		});
```
同じ describe の `returns no-store on not found responses` の `createClient.mockResolvedValue(...)` を替える:
```ts
		createClient.mockResolvedValue({
			from: jest.fn().mockReturnValue({
				select: jest.fn().mockReturnThis(),
				eq: jest.fn().mockReturnThis(),
				not: jest.fn().mockReturnThis(),
				maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
			}),
		});
```

- [ ] **Step 9: テストを通す**

Run: `npx jest tests/unit/api/admin tests/unit/api/orders tests/integration/api/orders.test.ts && npm run typecheck && npx eslint src/app/api/admin/orders/route.ts src/app/api/admin/kpi/route.ts src/app/api/orders`
Expected: PASS、lint の指摘なし

- [ ] **Step 10: FREQ 行を足す**

`docs/2_Specs/spec.md` の表の末尾に足す:
```text
| FREQ-410 | お客様の注文履歴・注文詳細と KPI に、支払い手続き中と放棄の注文を出さないこと | FREQ-410-REQ-01 | 注文履歴と注文詳細の API は、支払い手続き中・放棄の注文を返さないこと（メールで知らせた注文だけを見せる。Shopify も放棄された決済を注文として見せない） | FREQ-410-REQ-02 | KPI（CVR・返品率など）は、支払い手続き中・放棄の注文を数えないこと | FREQ-410-AC-01 | 支払い手続き中・放棄の注文が注文履歴と注文詳細に表示されないこと | FREQ-410-AC-02 | KPI の集計が支払い手続き中・放棄の注文を読まないこと |
```

- [ ] **Step 11: コミット**

```bash
git add src/app/api/admin/orders/route.ts tests/unit/api/admin/orders-search-route.test.ts "src/app/api/admin/orders/[id]/refund/route.ts" src/app/api/admin/kpi/route.ts tests/unit/api/admin/kpi-hidden-statuses.test.ts src/app/api/orders/route.ts "src/app/api/orders/[id]/route.ts" tests/unit/api/orders/orders-hidden-statuses.test.ts tests/integration/api/orders.test.ts docs/2_Specs/spec.md
git commit -m "feat(orders): 注文一覧・KPI・注文履歴を支払い手続き中と放棄に合わせる

管理の一覧は要確認・発送止め・取消の可否を返し、放棄は既定で出さない。
お客様の注文履歴と KPI には受付の前の注文を出さない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 19: 管理画面の部品（取消の画面・要対応欄・一覧の印・件数）

**Files:**
- Create: `src/components/OrderCancelDialog.tsx`
- Create: `tests/unit/components/OrderCancelDialog.test.tsx`
- Create: `src/components/AttentionInbox.tsx`
- Create: `tests/unit/components/AttentionInbox.test.tsx`
- Modify: `src/components/OrderSection.tsx`（ファイル全体を下の内容に置き換える）
- Modify: `tests/unit/components/OrderSection.actions.test.tsx`
- Modify: `src/components/AdminSideNav.tsx`
- Create: `tests/unit/components/AdminSideNav.badges.test.tsx`

**Interfaces:**
- Consumes: Task 8 の `CANCEL_REASONS`・`CANCEL_REASON_LABELS`・`ADMIN_NOTE_MAX_LENGTH`、Task 17 の `OrderAttention`・`AttentionException`
- Produces:
  - `OrderCancelDialog`（default export）
    - props: `{ open; title; targetLabel; showNotifyOption; noteRequired; submitting; onClose(); onSubmit(values: OrderCancelValues) }`
    - `type OrderCancelValues = { reason: CancelReason; note: string; notifyCustomer: boolean }`
  - `AttentionInbox`（default export）
    - props: `{ attention: OrderAttention | null; processingIds: string[]; onReview(orderId); onResolve({ exceptionId, note }); onCancelAndResolve({ exceptionId, values: OrderCancelValues }) }`
  - `OrderSection`
    - `OrderStatus` に `'支払い手続き中' | '放棄'` を足す
    - `OrderItem` に `needsReview?`・`shipBlockedReason?`・`canCancel?`・`cancelBlockedUntil?` を足す
    - 取消ボタンは `canCancel` のときだけ出す
  - `AdminSideNav` に `badges?: Partial<Record<TabType, number>>` を足す

- [ ] **Step 1: 失敗するテストを書く（取消の画面）**

`tests/unit/components/OrderCancelDialog.test.tsx`:
```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import OrderCancelDialog from '@/components/OrderCancelDialog';

/**
 * 取消の画面（設計書 5-2。Shopify の取消画面に合わせる）。
 * 理由は必須。メモは「その他」と要対応の解決で必須。お知らせは既定でオン、外せる。
 */
function renderDialog(overrides: Partial<Parameters<typeof OrderCancelDialog>[0]> = {}) {
  const onSubmit = jest.fn();
  render(
    <OrderCancelDialog
      open
      title="注文を取り消す"
      targetLabel="ORD-A1B2C3D4"
      showNotifyOption
      noteRequired={false}
      submitting={false}
      onClose={jest.fn()}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { onSubmit };
}

describe('OrderCancelDialog', () => {
  it('理由を選ぶまで「取り消す」を押せない', () => {
    renderDialog();

    const submit = screen.getByRole('button', { name: '取り消す' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole('combobox', { name: '取消の理由' }), { target: { value: 'customer_request' } });
    expect(submit).toBeEnabled();
  });

  it('お知らせは既定でオンで、外すと notifyCustomer=false で送る', () => {
    const { onSubmit } = renderDialog();

    const notify = screen.getByRole('checkbox', { name: 'お客様に取消のお知らせを送る' });
    expect(notify).toBeChecked();

    fireEvent.change(screen.getByRole('combobox', { name: '取消の理由' }), { target: { value: 'stock_unavailable' } });
    fireEvent.click(notify);
    fireEvent.change(screen.getByRole('textbox', { name: /メモ/ }), { target: { value: '  在庫を確認した  ' } });
    fireEvent.click(screen.getByRole('button', { name: '取り消す' }));

    expect(onSubmit).toHaveBeenCalledWith({ reason: 'stock_unavailable', note: '在庫を確認した', notifyCustomer: false });
  });

  it('「その他」はメモが要る', () => {
    renderDialog();

    fireEvent.change(screen.getByRole('combobox', { name: '取消の理由' }), { target: { value: 'other' } });
    expect(screen.getByRole('button', { name: '取り消す' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'メモ（必須・店内のみ）' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: /メモ/ }), { target: { value: '電話で依頼' } });
    expect(screen.getByRole('button', { name: '取り消す' })).toBeEnabled();
  });

  it('要対応の解決では、理由に関係なくメモが要る', () => {
    renderDialog({ noteRequired: true, title: '注文を取り消して解決' });

    fireEvent.change(screen.getByRole('combobox', { name: '取消の理由' }), { target: { value: 'suspected_fraud' } });

    expect(screen.getByRole('button', { name: '取り消す' })).toBeDisabled();
  });

  it('失敗の注文の取消ではお知らせの選択肢を出さず、notifyCustomer=false で送る', () => {
    const { onSubmit } = renderDialog({ showNotifyOption: false });

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '取消の理由' }), { target: { value: 'customer_request' } });
    fireEvent.click(screen.getByRole('button', { name: '取り消す' }));

    expect(onSubmit).toHaveBeenCalledWith({ reason: 'customer_request', note: '', notifyCustomer: false });
  });

  it('処理中は押せない', () => {
    renderDialog({ submitting: true });

    fireEvent.change(screen.getByRole('combobox', { name: '取消の理由' }), { target: { value: 'customer_request' } });

    expect(screen.getByRole('button', { name: '処理中...' })).toBeDisabled();
  });
});
```

- [ ] **Step 2: 失敗するテストを書く（要対応欄）**

`tests/unit/components/AttentionInbox.test.tsx`:
```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import AttentionInbox from '@/components/AttentionInbox';
import type { OrderAttention } from '@/lib/orders/order-payment-types';

const ATTENTION: OrderAttention = {
  exceptions: [
    {
      id: 'exception-1',
      reason: 'order_not_creatable',
      reasonLabel: '注文を作れない支払い',
      detail: 'item_unavailable',
      orderId: null,
      orderNumber: null,
      orderStatus: null,
      paymentRef: 'cs_test_1',
      firstDetectedAt: '2026-09-27T01:00:00.000Z',
      lastDetectedAt: '2026-09-27T01:00:00.000Z',
      detectionCount: 1,
      canCancelOrder: false,
    },
    {
      id: 'exception-2',
      reason: 'unexpected_state',
      reasonLabel: '想定外の支払い状態',
      detail: null,
      orderId: 'a1b2c3d4-1111-2222-8333-444455556666',
      orderNumber: 'ORD-A1B2C3D4',
      orderStatus: 'payment_in_progress',
      paymentRef: 'cs_test_2',
      firstDetectedAt: '2026-09-27T02:00:00.000Z',
      lastDetectedAt: '2026-09-27T02:00:00.000Z',
      detectionCount: 1,
      canCancelOrder: true,
    },
  ],
  reviews: [
    {
      orderId: 'b1b2c3d4-1111-2222-8333-444455556666',
      orderNumber: 'ORD-B1B2C3D4',
      orderStatus: 'paid',
      reviewReason: 'stock_not_reserved',
      reviewReasonLabel: '在庫を確保できなかった注文',
      reviewMarkedAt: '2026-09-27T03:00:00.000Z',
    },
  ],
  counts: { exceptions: 2, reviews: 1 },
};

function renderInbox(attention: OrderAttention | null = ATTENTION) {
  const handlers = { onReview: jest.fn(), onResolve: jest.fn(), onCancelAndResolve: jest.fn() };
  render(<AttentionInbox attention={attention} processingIds={[]} {...handlers} />);
  return handlers;
}

describe('AttentionInbox', () => {
  it('未処理が0件なら何も出さない', () => {
    const { container } = render(
      <AttentionInbox
        attention={{ exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } }}
        processingIds={[]}
        onReview={jest.fn()}
        onResolve={jest.fn()}
        onCancelAndResolve={jest.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('要対応と要確認を件数と一緒に出す', () => {
    renderInbox();

    expect(screen.getByRole('heading', { name: '要対応 2件・要確認 1件' })).toBeInTheDocument();
    expect(screen.getByText('注文を作れない支払い')).toBeInTheDocument();
    expect(screen.getByText('在庫を確保できなかった注文（ORD-B1B2C3D4）')).toBeInTheDocument();
  });

  it('「確認済みにする」で注文 ID を渡す', () => {
    const { onReview } = renderInbox();

    fireEvent.click(screen.getByRole('button', { name: '確認済みにする' }));

    expect(onReview).toHaveBeenCalledWith('b1b2c3d4-1111-2222-8333-444455556666');
  });

  it('「解決済みにする」はメモを付けて送れる', () => {
    const { onResolve } = renderInbox();

    fireEvent.click(screen.getAllByRole('button', { name: '解決済みにする' })[0]);
    const dialog = screen.getByRole('dialog', { name: '解決済みにする' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /メモ/ }), { target: { value: 'Stripe で返金済み' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '解決する' }));

    expect(onResolve).toHaveBeenCalledWith({ exceptionId: 'exception-1', note: 'Stripe で返金済み' });
  });

  it('未入金の注文が付いた要対応だけ「注文を取り消して解決」を出し、理由とメモを渡す', () => {
    const { onCancelAndResolve } = renderInbox();

    const buttons = screen.getAllByRole('button', { name: '注文を取り消して解決' });
    expect(buttons).toHaveLength(1);

    fireEvent.click(buttons[0]);
    const dialog = screen.getByRole('dialog', { name: '注文を取り消して解決' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: '取消の理由' }), { target: { value: 'other' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /メモ/ }), { target: { value: 'Stripe に支払いが無い' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '取り消す' }));

    expect(onCancelAndResolve).toHaveBeenCalledWith({
      exceptionId: 'exception-2',
      values: { reason: 'other', note: 'Stripe に支払いが無い', notifyCustomer: true },
    });
  });
});
```

- [ ] **Step 3: 失敗するテストを書く（一覧の印と件数）**

`tests/unit/components/OrderSection.actions.test.tsx` の `pendingOrder` に `canCancel: true` を足す:
```tsx
const pendingOrder: OrderItem = {
  ...paidOrder,
  id: 'pending-order',
  status: '未決済',
  canRefund: false,
  canShip: false,
  canCancel: true,
};
```
`describe` の末尾に足す:
```tsx
  it('要確認の注文に「要確認」の印を出す', () => {
    render(<OrderSection orders={[{ ...paidOrder, needsReview: true }]} />);

    expect(screen.getByText('要確認')).toBeInTheDocument();
  });

  it('支払額の確認が必要な注文は、発送ボタンの代わりに理由を出す', () => {
    render(
      <OrderSection
        orders={[{ ...paidOrder, canShip: false, shipBlockedReason: '支払額の確認が必要です（要対応）' }]}
        onShipOrder={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: '発送済みにする' })).not.toBeInTheDocument();
    expect(screen.getByText('支払額の確認が必要です（要対応）')).toBeInTheDocument();
    expect(screen.queryByText('配送先要確認')).not.toBeInTheDocument();
  });

  it('払込票が有効な注文は、取消の代わりに払込期限を出す', () => {
    render(
      <OrderSection
        orders={[{ ...pendingOrder, canCancel: false, cancelBlockedUntil: '2026-09-30T14:59:59.000Z' }]}
        onCancelOrder={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'キャンセル' })).not.toBeInTheDocument();
    expect(screen.getByText(/払込期限 2026\/09\/30 23:59 まで取り消せません/)).toBeInTheDocument();
  });

  it('支払い手続き中の注文も取り消せる', () => {
    const onCancelOrder = jest.fn();
    render(
      <OrderSection
        orders={[{ ...pendingOrder, id: 'in-progress', status: '支払い手続き中' }]}
        onCancelOrder={onCancelOrder}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onCancelOrder).toHaveBeenCalledWith('in-progress');
  });
```

`tests/unit/components/AdminSideNav.badges.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import AdminSideNav from '@/components/AdminSideNav';

describe('AdminSideNav の未処理の件数', () => {
  it('件数があるタブは、ボタンの名前に件数を含める', () => {
    render(<AdminSideNav activeTab="KPI" onTabChange={jest.fn()} tabs={['KPI', 'ORDER']} badges={{ ORDER: 3 }} />);

    expect(screen.getByRole('button', { name: 'ORDER 未処理 3件' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'KPI' })).toBeInTheDocument();
  });

  it('0件なら件数を出さない', () => {
    render(<AdminSideNav activeTab="KPI" onTabChange={jest.fn()} tabs={['ORDER']} badges={{ ORDER: 0 }} />);

    expect(screen.getByRole('button', { name: 'ORDER' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: テストが落ちることを確かめる**

Run: `npx jest tests/unit/components/OrderCancelDialog tests/unit/components/AttentionInbox tests/unit/components/OrderSection tests/unit/components/AdminSideNav`
Expected: FAIL（部品が無い、新しい項目が出ない）

- [ ] **Step 5: 取消の画面を書く**

`src/components/OrderCancelDialog.tsx`:
```tsx
'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';
import {
  ADMIN_NOTE_MAX_LENGTH,
  CANCEL_REASON_LABELS,
  CANCEL_REASONS,
  type CancelReason,
} from '@/lib/orders/order-payment-types';

export type OrderCancelValues = {
  reason: CancelReason;
  note: string;
  notifyCustomer: boolean;
};

type OrderCancelDialogProps = {
  open: boolean;
  /** 「注文を取り消す」または「注文を取り消して解決」 */
  title: string;
  /** 取り消す注文の目印（注文番号など） */
  targetLabel: string;
  /** お知らせの選択肢を出すか。失敗の注文の取消では出さない（期限切れで知らせ済み） */
  showNotifyOption: boolean;
  /** 要対応の解決ではメモ必須 */
  noteRequired: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (values: OrderCancelValues) => void;
};

const REASON_OPTIONS = CANCEL_REASONS.map((reason) => ({ value: reason, label: CANCEL_REASON_LABELS[reason] }));

function isCancelReason(value: string): value is CancelReason {
  return (CANCEL_REASONS as readonly string[]).includes(value);
}

/**
 * 取消の画面（設計書 5-2。Shopify の取消画面に合わせる。2026-09-27 承認）。
 * 理由は必須。メモは「その他」と要対応の解決で必須（店内だけに残る）。
 * お知らせは既定でオン、外せる。在庫は常に戻すので選択肢を置かない。
 */
export default function OrderCancelDialog({
  open,
  title,
  targetLabel,
  showNotifyOption,
  noteRequired,
  submitting,
  onClose,
  onSubmit,
}: OrderCancelDialogProps) {
  const [reason, setReason] = useState<CancelReason | ''>('');
  const [note, setNote] = useState('');
  const [notifyCustomer, setNotifyCustomer] = useState(true);

  // 開くたびに既定へ戻す（理由は未選択、お知らせはオン）
  useEffect(() => {
    if (open) {
      setReason('');
      setNote('');
      setNotifyCustomer(true);
    }
  }, [open]);

  const noteNeeded = noteRequired || reason === 'other';
  const canSubmit = reason !== '' && (!noteNeeded || note.trim().length > 0) && !submitting;

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          // canSubmit は理由を選んだことを含むので、この後の reason は CancelReason に絞られる
          if (!canSubmit) {
            return;
          }
          onSubmit({ reason, note: note.trim(), notifyCustomer: showNotifyOption && notifyCustomer });
        }}
      >
        <p className="font-acumin lk-text-3xs text-[#474747]">{targetLabel}</p>
        <SingleSelect
          label="取消の理由"
          required
          placeholder="選んでください"
          options={REASON_OPTIONS}
          value={reason}
          onChange={(event) => {
            const value = event.target.value;
            setReason(isCancelReason(value) ? value : '');
          }}
        />
        <TextAreaField
          label={noteNeeded ? 'メモ（必須・店内のみ）' : 'メモ（任意・店内のみ）'}
          value={note}
          rows={3}
          maxLength={ADMIN_NOTE_MAX_LENGTH}
          onChange={(event) => setNote(event.target.value)}
        />
        {showNotifyOption ? (
          <Checkbox
            label="お客様に取消のお知らせを送る"
            checked={notifyCustomer}
            onChange={(event) => setNotifyCustomer(event.target.checked)}
          />
        ) : null}
        <p className="font-acumin lk-text-3xs text-[#474747]">確保した在庫は戻ります。</p>
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
            戻る
          </Button>
          <Button type="submit" variant="primary" size="sm" className="w-full font-acumin" disabled={!canSubmit}>
            {submitting ? '処理中...' : '取り消す'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
```

- [ ] **Step 6: 要対応欄を書く**

`src/components/AttentionInbox.tsx`:
```tsx
'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';
import OrderCancelDialog, { type OrderCancelValues } from '@/components/OrderCancelDialog';
import {
  ADMIN_NOTE_MAX_LENGTH,
  type AttentionException,
  type OrderAttention,
} from '@/lib/orders/order-payment-types';

type AttentionInboxProps = {
  attention: OrderAttention | null;
  /** 操作中の要対応 ID・注文 ID。ボタンを押せなくする */
  processingIds: string[];
  onReview: (orderId: string) => void;
  onResolve: (input: { exceptionId: string; note: string }) => void;
  onCancelAndResolve: (input: { exceptionId: string; values: OrderCancelValues }) => void;
};

function formatDateTime(value: string | null): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/**
 * 管理画面の「要対応・要確認」欄（設計書 5-2）。ORDER タブの注文一覧の上に置き、0件なら出さない。
 * 値はすべて文字列として描画する（理由・メモを HTML として解釈しない）。
 */
export default function AttentionInbox({
  attention,
  processingIds,
  onReview,
  onResolve,
  onCancelAndResolve,
}: AttentionInboxProps) {
  const headingId = useId();
  const [resolving, setResolving] = useState<AttentionException | null>(null);
  const [cancelling, setCancelling] = useState<AttentionException | null>(null);
  const [note, setNote] = useState('');

  if (!attention || (attention.exceptions.length === 0 && attention.reviews.length === 0)) {
    return null;
  }

  return (
    <section aria-labelledby={headingId} className="space-y-4 border border-black/15 p-4">
      <h2 id={headingId} className="font-acumin lk-text-sm text-black">
        要対応 {attention.counts.exceptions}件・要確認 {attention.counts.reviews}件
      </h2>

      {attention.exceptions.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-acumin lk-text-3xs tracking-widest text-[#474747]">要対応</h3>
          <ul className="divide-y divide-black/10">
            {attention.exceptions.map((item) => {
              const busy = processingIds.includes(item.id);
              return (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0 font-acumin lk-text-3xs">
                    <p className="text-black">
                      {item.reasonLabel}
                      {item.orderNumber ? `（${item.orderNumber}）` : ''}
                    </p>
                    <p className="break-all text-[#474747]">
                      {item.paymentRef}・{formatDateTime(item.firstDetectedAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {item.canCancelOrder ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="font-acumin"
                        disabled={busy}
                        onClick={() => setCancelling(item)}
                      >
                        注文を取り消して解決
                      </Button>
                    ) : null}
                    <Button
                      variant="primary"
                      size="sm"
                      className="font-acumin"
                      disabled={busy}
                      onClick={() => {
                        setNote('');
                        setResolving(item);
                      }}
                    >
                      解決済みにする
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {attention.reviews.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-acumin lk-text-3xs tracking-widest text-[#474747]">要確認</h3>
          <ul className="divide-y divide-black/10">
            {attention.reviews.map((item) => (
              <li key={item.orderId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0 font-acumin lk-text-3xs">
                  <p className="text-black">{item.reviewReasonLabel}（{item.orderNumber}）</p>
                  <p className="text-[#474747]">{formatDateTime(item.reviewMarkedAt)}</p>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  className="font-acumin"
                  disabled={processingIds.includes(item.orderId)}
                  onClick={() => onReview(item.orderId)}
                >
                  確認済みにする
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Dialog open={resolving !== null} onClose={() => setResolving(null)} title="解決済みにする">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!resolving) {
              return;
            }
            onResolve({ exceptionId: resolving.id, note: note.trim() });
            setResolving(null);
          }}
        >
          <p className="font-acumin lk-text-3xs text-[#474747]">
            Stripe ダッシュボードで返金などを済ませてから、解決済みにしてください。
          </p>
          <TextAreaField
            label="メモ（任意・店内のみ）"
            value={note}
            rows={3}
            maxLength={ADMIN_NOTE_MAX_LENGTH}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={() => setResolving(null)}>
              戻る
            </Button>
            <Button type="submit" variant="primary" size="sm" className="w-full font-acumin">
              解決する
            </Button>
          </div>
        </form>
      </Dialog>

      <OrderCancelDialog
        open={cancelling !== null}
        title="注文を取り消して解決"
        targetLabel={cancelling?.orderNumber ?? ''}
        showNotifyOption
        noteRequired
        submitting={false}
        onClose={() => setCancelling(null)}
        onSubmit={(values) => {
          if (cancelling) {
            onCancelAndResolve({ exceptionId: cancelling.id, values });
          }
          setCancelling(null);
        }}
      />
    </section>
  );
}
```

- [ ] **Step 7: 注文一覧を変える**

`src/components/OrderSection.tsx` の全体を次に置き換える（使われなくなる `actionLabelMap` は消える）:
```tsx
'use client';

import { Button } from '@/components/ui/Button/Button';
import { DataTable } from '@/components/ui/DataTable/DataTable';
import { StatusBadge } from '@/components/ui/StatusBadge/StatusBadge';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';

export type OrderStatus = '支払い手続き中' | '未決済' | '決済完了' | '決済失敗' | '放棄' | 'キャンセル' | '発送済み';

export type OrderLineItem = {
	name: string;
	quantity: number;
};

export type OrderItem = {
	id: string;
	customerName: string;
	customerEmail: string;
	orderDate: string;
	itemCount: string;
	items: OrderLineItem[];
	totalAmount: string;
	status: OrderStatus;
	canRefund?: boolean;
	canShip?: boolean;
	missingShippingFields?: string[];
	/** 在庫を確保できなかった入金済みの注文（要確認）。確認済みにするまで印を出す */
	needsReview?: boolean;
	/** 発送できない理由（支払額の違いの要対応）。発送ボタンの代わりに出す */
	shipBlockedReason?: string | null;
	/** 取り消せる未入金の注文（支払い手続き中・入金待ち・失敗） */
	canCancel?: boolean;
	/** 払込票が有効な間は取り消せない。その払込期限（ISO） */
	cancelBlockedUntil?: string | null;
};

interface OrderSectionProps {
	orders: OrderItem[];
	isLoading?: boolean;
	errorMessage?: string | null;
	noticeMessage?: string | null;
	onCancelOrder?: (id: string) => void;
	onRefundOrder?: (id: string) => void;
	onShipOrder?: (id: string) => void;
	processingOrderIds?: string[];
}

function formatDeadline(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export default function OrderSection({
	orders,
	isLoading = false,
	errorMessage = null,
	noticeMessage = null,
	onCancelOrder,
	onRefundOrder,
	onShipOrder,
	processingOrderIds = [],
}: OrderSectionProps) {

	const statusClassMap: Record<OrderStatus, string> = {
		支払い手続き中: 'bg-gray-100 text-[#474747]',
		未決済: 'bg-red-100 text-red-800',
		決済完了: 'bg-yellow-100 text-yellow-800',
		決済失敗: 'bg-orange-100 text-orange-800',
		放棄: 'bg-gray-100 text-gray-500',
		キャンセル: 'bg-gray-100 text-gray-500',
		発送済み: 'bg-green-100 text-green-800',
	};

	if (isLoading) {
		return (
			<section>
				<p className="lk-text-sm text-[#474747] font-acumin">注文一覧を読み込み中です...</p>
			</section>
		);
	}

	return (
		<section>
			{errorMessage ? (
				<p role="alert" className="mb-4 lk-text-sm text-red-700 font-acumin">{errorMessage}</p>
			) : null}
			{noticeMessage ? (
				<p role="status" aria-live="polite" className="mb-4 lk-text-sm text-[#474747] font-acumin">
					{noticeMessage}
				</p>
			) : null}

			<DataTable
				rows={orders}
				rowKey={(order) => order.id}
				emptyLabel="条件に一致する注文はありません"
				columns={[
					{
						key: 'id',
						header: '注文ID',
						render: (order) => <p className="font-medium font-acumin">{order.id}</p>,
					},
					{
						key: 'customer',
						header: '顧客名',
						render: (order) => (
							<div>
								<p className="lk-text-sm text-black font-acumin">{order.customerName}</p>
								<p className="lk-text-3xs text-[#474747] font-acumin">{order.customerEmail}</p>
							</div>
						),
					},
					{ key: 'date', header: '注文日', render: (order) => <p className="text-[#474747] font-acumin">{order.orderDate}</p> },
					{
						key: 'items',
						header: '購入商品',
						render: (order) => (
							<div className="space-y-1">
								{order.items.map((item) => (
									<p key={`${order.id}-${item.name}`} className="lk-text-sm text-black font-acumin">
										{item.name} × {item.quantity}
									</p>
								))}
							</div>
						),
					},
					{ key: 'count', header: '商品数', render: (order) => <p className="font-acumin">{order.itemCount}</p> },
					{ key: 'total', header: '合計金額', render: (order) => <p className="font-acumin">{order.totalAmount}</p> },
					{
						key: 'status',
						header: '決済状況',
						render: (order) => (
							<div className="flex flex-wrap items-center gap-1">
								<StatusBadge
									tone={
										order.status === '決済完了'
											? 'positive'
											: order.status === '決済失敗' || order.status === 'キャンセル' || order.status === '放棄'
												? 'danger'
												: 'warning'
									}
									className={statusClassMap[order.status]}
									size="md"
								>
									{order.status}
								</StatusBadge>
								{order.needsReview ? (
									<TagLabel variant="outline" size="2xs">要確認</TagLabel>
								) : null}
							</div>
						),
					},
					{
						key: 'action',
						header: '操作',
						render: (order) => {
							const isProcessing = processingOrderIds.includes(order.id);
							const hasMissingShipping = (order.missingShippingFields?.length ?? 0) > 0;

							return (
							<div className="flex flex-wrap items-center gap-2">
								{order.canRefund && onRefundOrder ? (
									<Button
										variant="secondary"
										size="sm"
										className="font-acumin"
										onClick={() => onRefundOrder(order.id)}
										disabled={isProcessing}
									>
										{isProcessing ? '処理中...' : '返金'}
									</Button>
								) : null}
								{order.status === '決済完了' && order.shipBlockedReason ? (
									<span className="lk-text-xs text-red-700" role="status">{order.shipBlockedReason}</span>
								) : null}
								{order.status === '決済完了' && order.canShip === false && (!order.shipBlockedReason || hasMissingShipping) ? (
									<span className="lk-text-xs text-red-700" role="status">配送先要確認</span>
								) : null}
								{order.status === '決済完了' && order.canShip && onShipOrder ? (
									<Button
										variant="primary"
										size="sm"
										className="font-acumin"
										onClick={() => onShipOrder(order.id)}
										disabled={isProcessing}
									>
										{isProcessing ? '処理中...' : '発送済みにする'}
									</Button>
								) : null}
								{order.canCancel && onCancelOrder ? (
									<Button
										variant="secondary"
										size="sm"
										className="font-acumin"
										onClick={() => onCancelOrder(order.id)}
										disabled={isProcessing}
									>
										{isProcessing ? '処理中...' : 'キャンセル'}
									</Button>
								) : null}
								{order.cancelBlockedUntil ? (
									<span className="lk-text-xs text-[#474747]" role="status">
										払込期限 {formatDeadline(order.cancelBlockedUntil)} まで取り消せません
									</span>
								) : null}
							</div>
							);
						},
					},
				]}
			 size="md"/>
		</section>
	);
}
```

- [ ] **Step 8: サイドナビに件数を出す**

`src/components/AdminSideNav.tsx` の `AdminSideNavProps` に足す:
```tsx
  /** タブごとの未処理の件数（ORDER の要対応・要確認）。0 なら出さない */
  badges?: Partial<Record<TabType, number>>;
```
関数の引数に `badges,` を足す。`const isActive = tab === activeTab;` の次の行に足す:
```tsx
        const count = badges?.[tab] ?? 0;
```
`<span>{tab}</span>` を次に替える（件数は目で見る数字と、読み上げ用の「未処理 N件」に分ける。ボタンの名前は「ORDER 未処理 N件」になる）:
```tsx
            <span>{tab}</span>
            {count > 0 ? (
              <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-black px-1.5 font-acumin lk-text-4xs leading-5 text-white">
                <span aria-hidden="true">{count}</span>
                <span className="sr-only">{` 未処理 ${count}件`}</span>
              </span>
            ) : null}
```

- [ ] **Step 9: テストを通す**

Run: `npx jest tests/unit/components && npm run typecheck && npx eslint src/components/OrderCancelDialog.tsx src/components/AttentionInbox.tsx src/components/OrderSection.tsx src/components/AdminSideNav.tsx`
Expected: PASS、lint の指摘なし（`tests/unit/components/AdminOrderRefundFlow.test.tsx`・`AdminOrderSearch.test.tsx` もこの時点では変わらず通る）

- [ ] **Step 10: コミット**

```bash
git add src/components/OrderCancelDialog.tsx tests/unit/components/OrderCancelDialog.test.tsx src/components/AttentionInbox.tsx tests/unit/components/AttentionInbox.test.tsx src/components/OrderSection.tsx tests/unit/components/OrderSection.actions.test.tsx src/components/AdminSideNav.tsx tests/unit/components/AdminSideNav.badges.test.tsx
git commit -m "feat(admin): 取消の画面・要対応欄・一覧の要確認の印とサイドナビの件数を足す

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 20: 管理画面へのつなぎ込みと E2E

**Files:**
- Modify: `src/app/admin/page.tsx`
- Modify: `e2e/admin-test-utils.ts`（要対応の API の既定のモック）
- Modify: `e2e/FR-ADMIN-051-order-refund-safety.spec.ts`（未決済の注文に `canCancel: true`）
- Create: `e2e/FR-ADMIN-060-order-attention-inbox.spec.ts`
- Create: `e2e/FR-ADMIN-061-order-list-review-states.spec.ts`
- Create: `e2e/FR-ADMIN-063-order-cancel-dialog.spec.ts`
- Modify: `docs/2_Specs/spec.md`（FREQ 行3つ）

**Interfaces:**
- Consumes: Task 16〜19 の API と部品

- [ ] **Step 1: 番号を確かめる**

Run:
```bash
grep -oE "FREQ-[0-9]+" docs/2_Specs/spec.md | sort -t- -k2 -n | tail -1
ls e2e | grep FR-ADMIN- | sort -V | tail -3
```
Expected: `FREQ-410`、`FR-ADMIN-059-...` が最後（違えば FREQ-411〜413・FR-ADMIN-060〜063 を次の番号に読み替える）

- [ ] **Step 2: E2E を書く（要対応欄）**

`e2e/admin-test-utils.ts` の `mockAdminBackgroundApis` の末尾（legal-archive のモックの後）に足す:
```ts
  // ORDER タブと KPI 画面の要対応・要確認（src/components/AttentionInbox.tsx）。未処理なしを返す
  await page.route('**/api/admin/order-attention', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }),
    }),
  );
```
`e2e/FR-ADMIN-051-order-refund-safety.spec.ts` の `id: 'order-pending'` の注文に足す（取消ボタンは `canCancel` のときだけ出る）:
```ts
    canCancel: true,
```

`e2e/FR-ADMIN-060-order-attention-inbox.spec.ts`:
```ts
import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-411: 要対応・要確認を ORDER タブの一覧の上に出し、確認済み・解決済みにできる。件数をサイドナビと KPI 画面に出す。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const EXCEPTION = {
  id: 'b1b2c3d4-1111-2222-8333-444455556666',
  reason: 'order_not_creatable',
  reasonLabel: '注文を作れない支払い',
  detail: 'item_unavailable',
  orderId: null,
  orderNumber: null,
  orderStatus: null,
  paymentRef: 'cs_test_attention',
  firstDetectedAt: '2026-09-27T01:00:00.000Z',
  lastDetectedAt: '2026-09-27T01:00:00.000Z',
  detectionCount: 1,
  canCancelOrder: false,
};

const REVIEW = {
  orderId: 'a1b2c3d4-1111-2222-8333-444455556666',
  orderNumber: 'ORD-A1B2C3D4',
  orderStatus: 'paid',
  reviewReason: 'stock_not_reserved',
  reviewReasonLabel: '在庫を確保できなかった注文',
  reviewMarkedAt: '2026-09-27T01:00:00.000Z',
};

type AttentionState = { exceptions: unknown[]; reviews: unknown[]; resolveBody: unknown };

async function mockAdminApis(page: Page, state: AttentionState): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true },
      }),
    }),
  );
  await page.route('**/api/admin/kpi', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'not mocked' }) }),
  );
  await page.route('**/api/admin/order-attention', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          exceptions: state.exceptions,
          reviews: state.reviews,
          counts: { exceptions: state.exceptions.length, reviews: state.reviews.length },
        },
      }),
    }),
  );
  await page.route('**/api/admin/orders?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    }),
  );
  await page.route(`**/api/admin/orders/${REVIEW.orderId}/review`, (route) => {
    state.reviews = [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
  await page.route(`**/api/admin/payment-exceptions/${EXCEPTION.id}/resolve`, (route) => {
    state.resolveBody = route.request().postDataJSON();
    state.exceptions = [];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, orderCancelled: false }),
    });
  });
}

async function openOrders(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ORDER' }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-060 order attention inbox (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('未処理の要対応・要確認が ORDER タブの一覧の上に件数付きで表示される', async ({ page }) => {
      // FREQ-411-AC-01
      await mockAdminApis(page, { exceptions: [EXCEPTION], reviews: [REVIEW], resolveBody: null });
      await openOrders(page);

      await expect(page.getByRole('heading', { name: '要対応 1件・要確認 1件' })).toBeVisible();
      await expect(page.getByText('注文を作れない支払い')).toBeVisible();
      await expect(page.getByText('在庫を確保できなかった注文（ORD-A1B2C3D4）')).toBeVisible();
    });

    test('「確認済みにする」を押すと要確認が欄から消える', async ({ page }) => {
      // FREQ-411-AC-02
      await mockAdminApis(page, { exceptions: [EXCEPTION], reviews: [REVIEW], resolveBody: null });
      await openOrders(page);

      await page.getByRole('button', { name: '確認済みにする' }).click();

      await expect(page.getByText('在庫を確保できなかった注文（ORD-A1B2C3D4）')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: '要対応 1件・要確認 0件' })).toBeVisible();
    });

    test('「解決済みにする」はメモを付けて送り、欄から消える', async ({ page }) => {
      // FREQ-411-AC-02
      const state: AttentionState = { exceptions: [EXCEPTION], reviews: [], resolveBody: null };
      await mockAdminApis(page, state);
      await openOrders(page);

      await page.getByRole('button', { name: '解決済みにする' }).click();
      const dialog = page.getByRole('dialog', { name: '解決済みにする' });
      await dialog.getByRole('textbox', { name: /メモ/ }).fill('Stripe で返金済み');
      await dialog.getByRole('button', { name: '解決する' }).click();

      await expect(page.getByRole('heading', { name: /要対応/ })).toHaveCount(0);
      expect(state.resolveBody).toEqual({ note: 'Stripe で返金済み' });
    });

    test('未処理が0件のとき欄を出さない', async ({ page }) => {
      // FREQ-411-AC-03
      await mockAdminApis(page, { exceptions: [], reviews: [], resolveBody: null });
      await openOrders(page);

      await expect(page.getByRole('heading', { name: /要対応/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /未処理/ })).toHaveCount(0);
    });

    test('サイドナビの ORDER と KPI 画面の上部に未処理の件数が出る', async ({ page }) => {
      // FREQ-411-AC-04
      await mockAdminApis(page, { exceptions: [EXCEPTION], reviews: [REVIEW], resolveBody: null });
      await page.goto('/admin');

      await expect(page.getByText('要対応1件・要確認1件（ORDER で確認）')).toBeVisible();
      await expect(page.getByRole('button', { name: 'ORDER 未処理 2件' })).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAdminApis(page, { exceptions: [EXCEPTION], reviews: [REVIEW], resolveBody: null });
      await openOrders(page);
      await expect(page.getByRole('heading', { name: '要対応 1件・要確認 1件' })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
```

- [ ] **Step 3: E2E を書く（一覧の新しい状態と印）**

`e2e/FR-ADMIN-061-order-list-review-states.spec.ts`:
```ts
import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-412: 注文一覧に支払い手続き中・放棄・要確認の印・発送止めの理由を出し、要確認のみ・状態で絞り込める。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const BASE = {
  customerEmail: 'buyer@example.com',
  orderDate: '2026-09-27',
  itemCount: '1点',
  items: [{ name: 'シルクブラウス', quantity: 1 }],
  totalAmount: '¥28,800',
};

const ORDERS = [
  { ...BASE, id: 'order-progress', customerName: '手続き 花子', status: '支払い手続き中', canCancel: true },
  { ...BASE, id: 'order-review', customerName: '確認 太郎', status: '決済完了', canShip: true, needsReview: true },
  {
    ...BASE,
    id: 'order-blocked',
    customerName: '金額 次郎',
    status: '決済完了',
    canShip: false,
    shipBlockedReason: '支払額の確認が必要です（要対応）',
  },
];

async function mockAdminApis(page: Page, requestedUrls: string[]): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true },
      }),
    }),
  );
  await page.route('**/api/admin/orders?**', (route) => {
    requestedUrls.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: ORDERS, pagination: { page: 1, pageSize: 20, total: ORDERS.length, totalPages: 1 } }),
    });
  });
}

async function openOrders(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ORDER' }).click();
  await expect(page.getByRole('row', { name: /order-progress/ })).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-061 order list review states (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('要確認の注文に「要確認」の印が表示される', async ({ page }) => {
      // FREQ-412-AC-01
      await mockAdminApis(page, []);
      await openOrders(page);

      await expect(page.getByRole('row', { name: /order-review/ }).getByText('要確認', { exact: true })).toBeVisible();
      await expect(page.getByRole('row', { name: /order-progress/ }).getByText('要確認', { exact: true })).toHaveCount(0);
    });

    test('「要確認のみ」を選ぶと review=only で一覧を読み直す', async ({ page }) => {
      // FREQ-412-AC-02
      const requestedUrls: string[] = [];
      await mockAdminApis(page, requestedUrls);
      await openOrders(page);

      await page.getByRole('button', { name: '要確認のみ' }).click();

      await expect.poll(() => requestedUrls.some((url) => url.includes('review=only'))).toBe(true);
    });

    test('既定の一覧は状態を送らず（放棄はサーバーが除く）、「放棄」を選ぶと status=abandoned を送る', async ({ page }) => {
      // FREQ-412-AC-03
      const requestedUrls: string[] = [];
      await mockAdminApis(page, requestedUrls);
      await openOrders(page);

      expect(requestedUrls[0]).not.toContain('status=');
      await page.getByRole('button', { name: '放棄', exact: true }).click();

      await expect.poll(() => requestedUrls.some((url) => url.includes('status=abandoned'))).toBe(true);
    });

    test('支払い手続き中の注文が状態名つきで表示される', async ({ page }) => {
      await mockAdminApis(page, []);
      await openOrders(page);

      await expect(page.getByRole('row', { name: /order-progress/ }).getByText('支払い手続き中', { exact: true })).toBeVisible();
    });

    test('支払額の違いの要対応が開いている注文は「発送済みにする」を押せず、理由が表示される', async ({ page }) => {
      // FREQ-412-AC-04
      await mockAdminApis(page, []);
      await openOrders(page);

      const blocked = page.getByRole('row', { name: /order-blocked/ });
      await expect(blocked.getByText('支払額の確認が必要です（要対応）')).toBeVisible();
      await expect(blocked.getByRole('button', { name: '発送済みにする' })).toHaveCount(0);
      await expect(page.getByRole('row', { name: /order-review/ }).getByRole('button', { name: '発送済みにする' })).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAdminApis(page, []);
      await openOrders(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
```

- [ ] **Step 4: E2E を書く（取消の画面）**

`e2e/FR-ADMIN-063-order-cancel-dialog.spec.ts`:
```ts
import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-413: 取消の画面で理由を選び（必須）、メモとお知らせの有無を決めて取り消せる。払込票が有効な間は取り消せない。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const BASE = {
  customerEmail: 'buyer@example.com',
  orderDate: '2026-09-27',
  itemCount: '1点',
  items: [{ name: 'タックスカート', quantity: 1 }],
  totalAmount: '¥32,000',
};

const ORDERS = [
  { ...BASE, id: 'order-progress', customerName: '手続き 花子', status: '支払い手続き中', canCancel: true },
  {
    ...BASE,
    id: 'order-voucher',
    customerName: '払込 太郎',
    status: '未決済',
    canCancel: false,
    cancelBlockedUntil: '2026-09-30T14:59:59.000Z',
  },
  { ...BASE, id: 'order-failed', customerName: '失敗 次郎', status: '決済失敗', canCancel: true },
];

async function mockAdminApis(page: Page, cancelBodies: unknown[]): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true },
      }),
    }),
  );
  await page.route('**/api/admin/orders?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: ORDERS, pagination: { page: 1, pageSize: 20, total: ORDERS.length, totalPages: 1 } }),
    }),
  );
  await page.route('**/api/admin/orders/*/status', (route) => {
    cancelBodies.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, status: 'cancelled' }),
    });
  });
}

async function openOrders(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ORDER' }).click();
  await expect(page.getByRole('row', { name: /order-progress/ })).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-063 order cancel dialog (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('取消の理由を選ばないと取り消せない', async ({ page }) => {
      // FREQ-413-AC-01
      await mockAdminApis(page, []);
      await openOrders(page);

      await page.getByRole('row', { name: /order-progress/ }).getByRole('button', { name: 'キャンセル' }).click();
      const dialog = page.getByRole('dialog', { name: '注文を取り消す' });
      await expect(dialog.getByRole('button', { name: '取り消す' })).toBeDisabled();

      await dialog.getByLabel('取消の理由').selectOption('customer_request');
      await expect(dialog.getByRole('button', { name: '取り消す' })).toBeEnabled();
    });

    test('お知らせは既定でオンで表示され、外すと notifyCustomer=false を送る', async ({ page }) => {
      // FREQ-413-AC-02
      const cancelBodies: unknown[] = [];
      await mockAdminApis(page, cancelBodies);
      await openOrders(page);

      await page.getByRole('row', { name: /order-progress/ }).getByRole('button', { name: 'キャンセル' }).click();
      const dialog = page.getByRole('dialog', { name: '注文を取り消す' });
      const notify = dialog.getByRole('checkbox', { name: 'お客様に取消のお知らせを送る' });
      await expect(notify).toBeChecked();

      await dialog.getByLabel('取消の理由').selectOption('customer_request');
      await notify.uncheck();
      await dialog.getByRole('button', { name: '取り消す' }).click();

      await expect(page.getByRole('row', { name: /order-progress/ }).getByText('キャンセル', { exact: true })).toBeVisible();
      expect(cancelBodies).toEqual([{ status: 'cancelled', reason: 'customer_request', notifyCustomer: false }]);
    });

    test('「その他」はメモを入れるまで取り消せない', async ({ page }) => {
      // FREQ-413-AC-03
      const cancelBodies: unknown[] = [];
      await mockAdminApis(page, cancelBodies);
      await openOrders(page);

      await page.getByRole('row', { name: /order-progress/ }).getByRole('button', { name: 'キャンセル' }).click();
      const dialog = page.getByRole('dialog', { name: '注文を取り消す' });
      await dialog.getByLabel('取消の理由').selectOption('other');
      await expect(dialog.getByRole('button', { name: '取り消す' })).toBeDisabled();

      await dialog.getByRole('textbox', { name: /メモ/ }).fill('電話で依頼');
      await dialog.getByRole('button', { name: '取り消す' }).click();

      await expect.poll(() => cancelBodies).toEqual([
        { status: 'cancelled', reason: 'other', note: '電話で依頼', notifyCustomer: true },
      ]);
    });

    test('払込票が有効な注文は「キャンセル」を押せず、払込期限が表示される', async ({ page }) => {
      // FREQ-413-AC-04
      await mockAdminApis(page, []);
      await openOrders(page);

      const voucher = page.getByRole('row', { name: /order-voucher/ });
      await expect(voucher.getByRole('button', { name: 'キャンセル' })).toHaveCount(0);
      await expect(voucher.getByText(/払込期限 2026\/09\/30 23:59 まで取り消せません/)).toBeVisible();
    });

    test('失敗の注文の取消では、お知らせの選択肢を出さない', async ({ page }) => {
      // FREQ-413-AC-05
      await mockAdminApis(page, []);
      await openOrders(page);

      await page.getByRole('row', { name: /order-failed/ }).getByRole('button', { name: 'キャンセル' }).click();
      const dialog = page.getByRole('dialog', { name: '注文を取り消す' });

      await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAdminApis(page, []);
      await openOrders(page);
      await page.getByRole('row', { name: /order-progress/ }).getByRole('button', { name: 'キャンセル' }).click();
      await expect(page.getByRole('dialog', { name: '注文を取り消す' })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
```

- [ ] **Step 5: E2E が落ちることを確かめる**

dev サーバーが止まっていることを確かめてから流す:
```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
```
Run: `npx playwright test e2e/FR-ADMIN-060 e2e/FR-ADMIN-061 e2e/FR-ADMIN-063`
Expected: FAIL（画面に要対応欄・取消の画面・新しい絞り込みが無い）

- [ ] **Step 6: 管理画面をつなぐ**

`src/app/admin/page.tsx` を次のように変える。

import に足す:
```tsx
import AttentionInbox from '@/components/AttentionInbox';
import OrderCancelDialog, { type OrderCancelValues } from '@/components/OrderCancelDialog';
import { BannerAlert } from '@/components/ui/BannerAlert/BannerAlert';
import type { OrderAttention } from '@/lib/orders/order-payment-types';
```
`ORDER_STATUS_FILTERS` を替える:
```tsx
const ORDER_STATUS_FILTERS = [
  { label: 'すべて', value: 'all' },
  { label: '支払い手続き中', value: '支払い手続き中' },
  { label: '未決済', value: '未決済' },
  { label: '決済完了', value: '決済完了' },
  { label: '決済失敗', value: '決済失敗' },
  { label: '放棄', value: '放棄' },
  { label: 'キャンセル', value: 'キャンセル' },
  { label: '発送済み', value: '発送済み' },
] as const;
```
`const [shipTrackingNumber, setShipTrackingNumber] = useState('');` の次に足す:
```tsx
  const [reviewOnly, setReviewOnly] = useState(false);
  const [attention, setAttention] = useState<OrderAttention | null>(null);
  const [processingAttentionIds, setProcessingAttentionIds] = useState<string[]>([]);
  const [cancelTarget, setCancelTarget] = useState<OrderItem | null>(null);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
```
`fetchOrders` の `statusMap` を替え、その後に要確認のみの条件を足す:
```tsx
      const statusMap: Partial<Record<OrderStatusFilterValue, string>> = {
        '支払い手続き中': 'payment_in_progress',
        '未決済': 'pending',
        '決済完了': 'paid',
        '決済失敗': 'failed',
        '放棄': 'abandoned',
        'キャンセル': 'cancelled',
      };
      const apiStatus = statusMap[selectedStatus];
      if (apiStatus) {
        query.set('status', apiStatus);
      }

      if (reviewOnly) {
        query.set('review', 'only');
      }
```
`fetchOrders` の依存の配列の末尾に `reviewOnly,` を足す。`fetchOrders` を呼ぶ `useEffect` の次に足す:
```tsx
  // 要対応・要確認（設計書 5-2）。サイドナビと KPI 画面の件数にも使うので、タブを移るたびに読み直す
  const fetchAttention = useCallback(async () => {
    try {
      const response = await clientFetch('/api/admin/order-attention', { cache: 'no-store' });
      if (!response.ok) {
        return;
      }
      const json = (await response.json()) as { data?: Partial<OrderAttention> };
      const data = json.data;
      if (!data || !Array.isArray(data.exceptions) || !Array.isArray(data.reviews) || !data.counts) {
        setAttention(null);
        return;
      }
      setAttention(data as OrderAttention);
    } catch (error) {
      console.error('Failed to fetch order attention:', error);
    }
  }, []);

  useEffect(() => {
    if (!canAccessAdmin || !isMfaVerified) {
      return;
    }

    void fetchAttention();
  }, [activeTab, canAccessAdmin, isMfaVerified, fetchAttention]);

  const attentionTotal = (attention?.counts.exceptions ?? 0) + (attention?.counts.reviews ?? 0);
```
`handleCancelOrder` をまるごと次に替える（確認のダイアログを取消の画面に替える）:
```tsx
  const handleCancelOrder = (id: string) => {
    const order = orders.find((item) => item.id === id);
    if (!order) {
      return;
    }

    setOrdersNoticeMessage(null);
    setCancelTarget(order);
  };

  const submitCancelOrder = async (values: OrderCancelValues) => {
    const target = cancelTarget;
    if (!target) {
      return;
    }

    try {
      setOrdersErrorMessage(null);
      setCancelSubmitting(true);
      updateProcessingOrder(target.id, true);

      const response = await clientFetch(`/api/admin/orders/${target.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'cancelled',
          reason: values.reason,
          ...(values.note ? { note: values.note } : {}),
          notifyCustomer: values.notifyCustomer,
        }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('認証が必要です。再ログインしてください。');
        }
        if (response.status === 403) {
          throw new Error('注文ステータス更新の権限がありません。');
        }
        if (response.status === 503) {
          throw new Error('Stripe の状態を確認できませんでした。時間をおいて再試行してください。');
        }
        throw new Error(await readSafeOrderActionError(response, '注文ステータスの更新に失敗しました。'));
      }

      setOrders((prevOrders) =>
        prevOrders.map((order) =>
          order.id === target.id
            ? { ...order, status: 'キャンセル', canCancel: false, cancelBlockedUntil: null }
            : order,
        ),
      );
      setOrdersNoticeMessage('注文を取り消しました。');
      void fetchAttention();
    } catch (error) {
      console.error('Failed to cancel order:', error);
      setOrdersErrorMessage(error instanceof Error ? error.message : '注文ステータスの更新に失敗しました。');
    } finally {
      setCancelTarget(null);
      setCancelSubmitting(false);
      updateProcessingOrder(target.id, false);
    }
  };

  /** 要対応・要確認の操作。成功したら欄と一覧を読み直す */
  const runAttentionAction = async (id: string, request: () => Promise<Response>, successMessage: string) => {
    try {
      setOrdersErrorMessage(null);
      setOrdersNoticeMessage(null);
      setProcessingAttentionIds((prev) => [...prev, id]);

      const response = await request();
      if (!response.ok) {
        if (response.status === 403) {
          throw new Error('この操作の権限がありません。');
        }
        throw new Error(await readSafeOrderActionError(response, '操作に失敗しました。一覧を更新してください。'));
      }

      setOrdersNoticeMessage(successMessage);
      await Promise.all([fetchAttention(), fetchOrders()]);
    } catch (error) {
      console.error('Failed to update order attention:', error);
      setOrdersErrorMessage(error instanceof Error ? error.message : '操作に失敗しました。');
    } finally {
      setProcessingAttentionIds((prev) => prev.filter((itemId) => itemId !== id));
    }
  };

  const handleReviewOrder = (orderId: string) =>
    void runAttentionAction(
      orderId,
      () => clientFetch(`/api/admin/orders/${orderId}/review`, { method: 'POST' }),
      '確認済みにしました。',
    );

  const handleResolveException = ({ exceptionId, note }: { exceptionId: string; note: string }) =>
    void runAttentionAction(
      exceptionId,
      () =>
        clientFetch(`/api/admin/payment-exceptions/${exceptionId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(note ? { note } : {}),
        }),
      '解決済みにしました。',
    );

  const handleCancelAndResolve = ({ exceptionId, values }: { exceptionId: string; values: OrderCancelValues }) =>
    void runAttentionAction(
      exceptionId,
      () =>
        clientFetch(`/api/admin/payment-exceptions/${exceptionId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            note: values.note,
            cancelOrder: true,
            cancelReason: values.reason,
            notifyCustomer: values.notifyCustomer,
          }),
        }),
      '注文を取り消して解決しました。',
    );
```
`tabRightContent` の `case 'ORDER':` の、状態の絞り込みの `<div className="flex shrink-0 gap-2">` を次に替える（ボタンが増えるので折り返す。「要確認のみ」を足す）:
```tsx
            <div className="flex flex-wrap justify-end gap-2">
              {ORDER_STATUS_FILTERS.map((statusFilter) => (
                <Button
                  key={statusFilter.value}
                  variant={orderStatusFilters.includes(statusFilter.value) ? 'primary' : 'secondary'}
                  size="sm"
                  className="font-acumin"
                  onClick={() => handleStatusFilterToggle(statusFilter.value)}
                >
                  {statusFilter.label}
                </Button>
              ))}
              <Button
                variant={reviewOnly ? 'primary' : 'secondary'}
                size="sm"
                className="font-acumin"
                aria-pressed={reviewOnly}
                onClick={() => {
                  setOrdersPage(1);
                  setReviewOnly((prev) => !prev);
                }}
              >
                要確認のみ
              </Button>
            </div>
```
同じ `case 'ORDER':` の外側の `<div className="flex items-center justify-end gap-3 whitespace-nowrap">` を次に替える:
```tsx
          <div className="flex flex-wrap items-center justify-end gap-3">
```
`renderContent` の `case 'KPI':` を替える:
```tsx
      case 'KPI':
        if (userRole !== 'admin') return null;
        return (
          <>
            {attentionTotal > 0 ? (
              <BannerAlert
                variant="warning"
                className="mb-6"
                message={`要対応${attention?.counts.exceptions ?? 0}件・要確認${attention?.counts.reviews ?? 0}件（ORDER で確認）`}
              />
            ) : null}
            <KpiSection data={kpiData} isLoading={isKpiLoading} errorMessage={kpiErrorMessage} onRetry={fetchKpi} />
          </>
        );
```
`renderContent` の `case 'ORDER':` の `<div className="space-y-4">` の直後に足す:
```tsx
            <AttentionInbox
              attention={attention}
              processingIds={processingAttentionIds}
              onReview={handleReviewOrder}
              onResolve={handleResolveException}
              onCancelAndResolve={handleCancelAndResolve}
            />
```
同じ `case 'ORDER':` の発送の `</Dialog>` の直後に足す:
```tsx
            <OrderCancelDialog
              open={cancelTarget !== null}
              title="注文を取り消す"
              targetLabel={cancelTarget?.id ?? ''}
              showNotifyOption={cancelTarget?.status !== '決済失敗'}
              noteRequired={false}
              submitting={cancelSubmitting}
              onClose={() => setCancelTarget(null)}
              onSubmit={(values) => void submitCancelOrder(values)}
            />
```
`<AdminSideNav activeTab={activeTab} onTabChange={handleTabChange} tabs={visibleTabs} />` を替える:
```tsx
          <AdminSideNav
            activeTab={activeTab}
            onTabChange={handleTabChange}
            tabs={visibleTabs}
            badges={{ ORDER: attentionTotal }}
          />
```

- [ ] **Step 7: テストを通す**

Run:
```bash
npx jest tests/unit/components && npm run typecheck && npx eslint src/app/admin/page.tsx
npx playwright test e2e/FR-ADMIN-050 e2e/FR-ADMIN-051 e2e/FR-ADMIN-060 e2e/FR-ADMIN-061 e2e/FR-ADMIN-063
```
Expected: すべて PASS（390・768・1280 のそれぞれ。横スクロールの検査を含む）。失敗したら CLAUDE.md の切り分け（単体で再実行 → 同じテストの他ビューポート → タイムアウトかアサーションか）の順で確かめる

- [ ] **Step 8: FREQ 行を足す**

`docs/2_Specs/spec.md` の表の末尾に足す:
```text
| FREQ-411 | 管理画面の ORDER タブに要対応・要確認の欄を置き、確認済み・解決済みにできること。未処理の件数をサイドナビと KPI 画面に出すこと | FREQ-411-REQ-01 | 要対応（注文を作れない支払い・支払額の違いなど）と要確認（在庫を確保できなかった注文）を、注文一覧の上に件数付きで出すこと。お客様の個人情報は出さないこと | FREQ-411-REQ-02 | 要確認は「確認済みにする」、要対応は任意のメモ付きの「解決済みにする」で欄から消すこと。未入金の注文が付いた要対応は「注文を取り消して解決」（理由とメモが必須）も選べること。どれも実行者と日時を残すこと | FREQ-411-REQ-03 | 未処理の件数をサイドナビの ORDER と KPI 画面の上部の1行に出すこと | FREQ-411-AC-01 | 未処理の要対応・要確認が ORDER タブの一覧の上に表示されること | FREQ-411-AC-02 | 「確認済みにする」「解決済みにする」を押すと欄から消えること | FREQ-411-AC-03 | 未処理が0件のとき欄が表示されないこと | FREQ-411-AC-04 | サイドナビの ORDER と KPI 画面の上部に未処理の件数が表示されること |
| FREQ-412 | 注文一覧に支払い手続き中・放棄・要確認の印と発送止めの理由を出し、要確認のみ・状態で絞り込めること | FREQ-412-REQ-01 | 状態の絞り込みに「支払い手続き中」「放棄」を足し、放棄は既定の一覧に出さないこと | FREQ-412-REQ-02 | 要確認の注文に「要確認」の印を出し、「要確認のみ」で絞り込めること | FREQ-412-REQ-03 | 支払額の違いの要対応が開いている注文は「発送済みにする」を出さず、理由を出すこと（発送の RPC も断る） | FREQ-412-AC-01 | 要確認の注文に「要確認」の印が表示されること | FREQ-412-AC-02 | 「要確認のみ」で要確認の注文だけを読み直すこと | FREQ-412-AC-03 | 放棄の注文が既定の一覧に表示されず、「放棄」で絞り込めること | FREQ-412-AC-04 | 支払額の違いの要対応が開いている注文では「発送済みにする」が押せず、理由が表示されること |
| FREQ-413 | 管理画面の取消の画面で、理由（必須）・メモ・お客様へのお知らせの有無を決めて未入金の注文を取り消せること（Shopify の取消画面に合わせる） | FREQ-413-REQ-01 | 理由は「在庫切れ・お客様の依頼・不正の疑い・その他」から選ばせ、「その他」ではメモを必須にすること。メモは店内だけに残ること | FREQ-413-REQ-02 | 「お客様に取消のお知らせを送る」を既定でオンにし、外せること。失敗の注文の取消では出さないこと | FREQ-413-REQ-03 | 払込票が有効な入金待ちの注文は取り消させず、払込期限を表示すること | FREQ-413-AC-01 | 取消の理由を選ばないと取り消せないこと | FREQ-413-AC-02 | 「お客様に取消のお知らせを送る」が既定でオンで表示され、外すとお知らせを送らない指定で送られること | FREQ-413-AC-03 | 「その他」はメモを入れるまで取り消せないこと | FREQ-413-AC-04 | 払込票が有効な入金待ちの注文では「キャンセル」が押せず、払込期限が表示されること | FREQ-413-AC-05 | 失敗の注文の取消ではお知らせの選択肢が表示されないこと |
```

- [ ] **Step 9: コミット**

```bash
git add src/app/admin/page.tsx e2e/admin-test-utils.ts e2e/FR-ADMIN-051-order-refund-safety.spec.ts e2e/FR-ADMIN-060-order-attention-inbox.spec.ts e2e/FR-ADMIN-061-order-list-review-states.spec.ts e2e/FR-ADMIN-063-order-cancel-dialog.spec.ts docs/2_Specs/spec.md
git commit -m "feat(admin): ORDER タブに要対応欄・取消の画面・要確認の絞り込みをつなぐ

サイドナビと KPI 画面に未処理の件数を出す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 21: 商品の非公開・削除で決済を失効させ、削除できない商品は理由を返す（①・R-44）

**Files:**
- Create: `supabase/migrations/20260927100700_item_checkout_guards.sql`
- Create: `tests/integration/db/item_checkout_guards.integration.test.ts`
- Create: `src/lib/items/item-delete-guidance.ts`
- Create: `src/lib/items/item-checkout-guards.ts`
- Create: `tests/unit/lib/items/item-checkout-guards.test.ts`
- Modify: `src/app/api/admin/items/[id]/route.ts`
- Modify: `src/app/api/admin/items/route.ts:179-205`
- Create: `tests/unit/api/admin/items-checkout-guards-route.test.ts`
- Modify: `src/components/ItemSection.tsx`
- Create: `e2e/FR-ADMIN-062-item-delete-guidance.spec.ts`
- Modify: `docs/2_Specs/spec.md`（FREQ 行）

**Interfaces:**
- Consumes: Task 15 の `expireOpenCheckoutSession`
- Produces:
  - SQL `public.find_open_checkout_sessions_for_item(_item_id bigint) → table(checkout_session_id text)`
  - SQL `public.item_delete_blockers(_item_ids bigint[]) → table(item_id bigint, has_orders boolean, has_stock_movements boolean, has_open_checkouts boolean)`
  - TS `buildItemDeleteGuidance(reasons: string[]): string`（`item-delete-guidance.ts`。画面と API で共有）
  - TS `fetchItemDeleteBlockers(client, itemIds): Promise<Map<number, ItemDeleteBlockers>>`・`isItemDeletable(blockers?)`・`describeDeleteBlockers(blockers): string[]`・`expireOpenCheckoutsForItem({ client, stripe, itemId }): Promise<{ expired: number; failed: number }>`
  - 管理 API: `GET /api/admin/items` の各商品に `canDelete?: boolean`・`deleteBlockedReasons?: string[]`。`DELETE /api/admin/items/:id` は削除できなければ `409 { error, reasons }`。`PUT`・`PATCH` で非公開にしたら、その商品を含む開いている決済を失効させる

- [ ] **Step 1: FREQ の番号を確かめる**

Run: `grep -oE "FREQ-[0-9]+" docs/2_Specs/spec.md | sort -t- -k2 -n | tail -1`
Expected: `FREQ-413`（違えば FREQ-414 を次の番号に読み替える）

- [ ] **Step 2: 失敗する DB 結合テストを書く**

`tests/integration/db/item_checkout_guards.integration.test.ts`:
```ts
/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, createDraft, insertOrderWithStockLine } from './helpers/order-fixtures';

/**
 * 商品の非公開・削除（設計書 4-6 の①・R-44）。
 * 開いている決済は受付の済んでいない下書き（24時間以内）。削除できない理由は注文・在庫の記録・決済中。
 */
async function openSessions(db: PgClient, itemId: number): Promise<string[]> {
  const res = await db.query(
    'select checkout_session_id from public.find_open_checkout_sessions_for_item($1::bigint)',
    [itemId],
  );
  return res.rows.map((row) => row.checkout_session_id as string);
}

async function blockers(db: PgClient, itemIds: number[]) {
  const res = await db.query(
    'select item_id, has_orders, has_stock_movements, has_open_checkouts from public.item_delete_blockers($1::bigint[])',
    [itemIds],
  );
  return Object.fromEntries(res.rows.map((row) => [Number(row.item_id), {
    hasOrders: row.has_orders,
    hasStockMovements: row.has_stock_movements,
    hasOpenCheckouts: row.has_open_checkouts,
  }]));
}

describeLocalDb('integration: 商品の非公開・削除の確かめ', (db) => {
  test('受付の済んでいない開いている決済だけを返す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const open = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const placed = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query(
      `select order_id from public.place_order_from_checkout_draft(
         $1::uuid, $2::text, $3::text, $4::integer, 0, 'jpy', now(), null)`,
      [placed.draftId, placed.checkoutSessionId, placed.cartSessionId, placed.totalAmount],
    );
    const stale = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query(`update public.checkout_drafts set created_at = now() - interval '25 hours' where id = $1`, [
      stale.draftId,
    ]);

    expect(await openSessions(db(), fx.itemId)).toEqual([open.checkoutSessionId]);
  });

  test('削除できない理由を商品ごとに返す', async () => {
    const plain = await createCatalogFixture(db(), { stock: 0 });
    const stocked = await createCatalogFixture(db(), { stock: 1 });
    const ordered = await createCatalogFixture(db(), { stock: 0 });
    await insertOrderWithStockLine(db(), {
      status: 'paid', itemId: ordered.itemId, variantId: ordered.variantId, quantity: 1, reserved: false,
      paymentIntentId: `pi_guard_${Date.now()}`,
    });
    const checkingOut = await createCatalogFixture(db(), { stock: 0 });
    await createDraft(db(), { itemId: checkingOut.itemId, quantity: 1 });

    expect(await blockers(db(), [plain.itemId, stocked.itemId, ordered.itemId, checkingOut.itemId])).toEqual({
      [plain.itemId]: { hasOrders: false, hasStockMovements: false, hasOpenCheckouts: false },
      [stocked.itemId]: { hasOrders: false, hasStockMovements: true, hasOpenCheckouts: false },
      [ordered.itemId]: { hasOrders: true, hasStockMovements: false, hasOpenCheckouts: false },
      [checkingOut.itemId]: { hasOrders: false, hasStockMovements: false, hasOpenCheckouts: true },
    });
  });

  test('anon・authenticated は実行できない', async () => {
    for (const signature of [
      'public.find_open_checkout_sessions_for_item(bigint)',
      'public.item_delete_blockers(bigint[])',
    ]) {
      for (const role of ['anon', 'authenticated']) {
        const res = await db().query('select has_function_privilege($1, $2, $3) as allowed', [role, signature, 'EXECUTE']);
        expect(res.rows[0].allowed).toBe(false);
      }
    }
  });
});
```

- [ ] **Step 3: 失敗する単体テストを書く**

`tests/unit/lib/items/item-checkout-guards.test.ts`:
```ts
const mockExpireOpenCheckoutSession = jest.fn();
jest.mock('@/lib/stripe/checkout-session-expiry', () => ({
  expireOpenCheckoutSession: (...args: unknown[]) => mockExpireOpenCheckoutSession(...args),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import {
  describeDeleteBlockers,
  expireOpenCheckoutsForItem,
  fetchItemDeleteBlockers,
  isItemDeletable,
} from '@/lib/items/item-checkout-guards';
import { buildItemDeleteGuidance } from '@/lib/items/item-delete-guidance';

function clientWith(rpc: jest.Mock) {
  return { rpc } as unknown as SupabaseClient;
}

const stripe = {} as Stripe;

describe('item-checkout-guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('削除できない理由を商品 ID ごとに読む', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [{ item_id: '7', has_orders: true, has_stock_movements: false, has_open_checkouts: true }],
      error: null,
    });

    const result = await fetchItemDeleteBlockers(clientWith(rpc), [7]);

    expect(rpc).toHaveBeenCalledWith('item_delete_blockers', { _item_ids: [7] });
    expect(result.get(7)).toEqual({ hasOrders: true, hasStockMovements: false, hasOpenCheckouts: true });
    expect(describeDeleteBlockers(result.get(7)!)).toEqual(['注文がある', '決済中のお客様がいる']);
  });

  it('理由が無い商品だけを削除できる。読めなかった商品は削除できない扱いにする', () => {
    expect(isItemDeletable({ hasOrders: false, hasStockMovements: false, hasOpenCheckouts: false })).toBe(true);
    expect(isItemDeletable({ hasOrders: false, hasStockMovements: true, hasOpenCheckouts: false })).toBe(false);
    expect(isItemDeletable(undefined)).toBe(false);
  });

  it('非公開を促す案内の文にする', () => {
    expect(buildItemDeleteGuidance(['注文がある'])).toBe(
      'この商品は削除できません（注文がある）。非公開にすると、お客様の画面から見えなくなります。',
    );
  });

  it('商品を含む開いている決済を失効させ、失敗しても残りを続ける', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [{ checkout_session_id: 'cs_1' }, { checkout_session_id: 'cs_2' }, { checkout_session_id: 'cs_3' }],
      error: null,
    });
    mockExpireOpenCheckoutSession
      .mockResolvedValueOnce('expired')
      .mockRejectedValueOnce(new Error('stripe down'))
      .mockResolvedValueOnce('not_open');

    const result = await expireOpenCheckoutsForItem({ client: clientWith(rpc), stripe, itemId: 7 });

    expect(rpc).toHaveBeenCalledWith('find_open_checkout_sessions_for_item', { _item_id: 7 });
    expect(mockExpireOpenCheckoutSession).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ expired: 1, failed: 1 });
  });
});
```

`tests/unit/api/admin/items-checkout-guards-route.test.ts`:
```ts
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn().mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin' }),
}));

const mockUpdateEq = jest.fn();
const mockDeleteEq = jest.fn();
const mockClient = {
  from: () => ({
    update: () => ({ eq: mockUpdateEq }),
    delete: () => ({ eq: mockDeleteEq }),
  }),
};
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => mockClient),
}));

const mockStripe = { name: 'stripe' };
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: () => mockStripe,
}));

const mockFetchBlockers = jest.fn();
const mockExpireForItem = jest.fn();
jest.mock('@/lib/items/item-checkout-guards', () => ({
  ...jest.requireActual('@/lib/items/item-checkout-guards'),
  fetchItemDeleteBlockers: (...args: unknown[]) => mockFetchBlockers(...args),
  expireOpenCheckoutsForItem: (...args: unknown[]) => mockExpireForItem(...args),
}));

jest.mock('@/lib/storage/item-images', () => ({
  signItemImageFields: jest.fn(async (_client: unknown, item: unknown) => item),
}));

import { DELETE, PATCH } from '@/app/api/admin/items/[id]/route';

type RouteResponse = { status: number; body: Record<string, unknown> };
const CONTEXT = { params: Promise.resolve({ id: '7' }) };

function patch(status: 'private' | 'published') {
  return PATCH(
    new Request('http://localhost/api/admin/items/7', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
    CONTEXT,
  ) as unknown as Promise<RouteResponse>;
}

function remove() {
  return DELETE(new Request('http://localhost/api/admin/items/7', { method: 'DELETE' }), CONTEXT) as unknown as Promise<RouteResponse>;
}

describe('管理画面の商品 API（①・R-44）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateEq.mockResolvedValue({ error: null });
    mockDeleteEq.mockResolvedValue({ error: null });
    mockExpireForItem.mockResolvedValue({ expired: 1, failed: 0 });
  });

  it('非公開にしたら、その商品を含む開いている決済を失効させる', async () => {
    expect((await patch('private')).status).toBe(200);
    expect(mockExpireForItem).toHaveBeenCalledWith({ client: mockClient, stripe: mockStripe, itemId: 7 });
  });

  it('公開にしたときは決済に触らない', async () => {
    await patch('published');

    expect(mockExpireForItem).not.toHaveBeenCalled();
  });

  it('注文・在庫の記録・決済中のある商品は削除せず、理由付きの 409 で非公開を促す', async () => {
    mockFetchBlockers.mockResolvedValue(new Map([[7, { hasOrders: true, hasStockMovements: true, hasOpenCheckouts: false }]]));

    const res = await remove();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'この商品は削除できません（注文がある・在庫の記録がある）。非公開にすると、お客様の画面から見えなくなります。',
      reasons: ['注文がある', '在庫の記録がある'],
    });
    expect(mockDeleteEq).not.toHaveBeenCalled();
  });

  it('理由の無い商品は削除する', async () => {
    mockFetchBlockers.mockResolvedValue(new Map([[7, { hasOrders: false, hasStockMovements: false, hasOpenCheckouts: false }]]));

    expect((await remove()).status).toBe(200);
    expect(mockDeleteEq).toHaveBeenCalledWith('id', 7);
  });

  it('確かめた後に記録が増えて外部キーで断られたら、汎用の500ではなく 409 を返す', async () => {
    mockFetchBlockers.mockResolvedValue(new Map([[7, { hasOrders: false, hasStockMovements: false, hasOpenCheckouts: false }]]));
    mockDeleteEq.mockResolvedValue({ error: { code: '23503', message: 'foreign key violation' } });

    const res = await remove();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('非公開');
  });

  it('商品 ID の形が違えば 400', async () => {
    const res = (await DELETE(
      new Request('http://localhost/api/admin/items/abc', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'abc' }) },
    )) as unknown as RouteResponse;

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 4: テストが落ちることを確かめる**

Run:
```bash
npx jest tests/unit/lib/items tests/unit/api/admin/items-checkout-guards-route
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/item_checkout_guards
```
Expected: FAIL（モジュールと RPC が無い）

- [ ] **Step 5: マイグレーションを書く**

`supabase/migrations/20260927100700_item_checkout_guards.sql`:
```sql
-- 商品の非公開・削除（グループ A 設計書 4-6 の①・R-44）。

BEGIN;

-- 商品を含み、まだ受付の済んでいない開いている決済。決済画面の期限は30分30秒
-- （この変更の前に作った Session は24時間）なので、24時間以内の下書きだけを見る。
CREATE OR REPLACE FUNCTION public.find_open_checkout_sessions_for_item(_item_id bigint)
RETURNS TABLE (checkout_session_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT DISTINCT d.checkout_session_id
  FROM public.checkout_drafts AS d
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(d.items_snapshot) AS e(value)
  WHERE d.status = 'created'
    AND d.checkout_session_id IS NOT NULL
    AND d.created_at > pg_catalog.now() - interval '24 hours'
    AND (e.value->>'item_id')::bigint = _item_id
    AND NOT EXISTS (
      SELECT 1 FROM public.orders AS o WHERE o.checkout_session_id = d.checkout_session_id
    );
$$;

-- 削除できない理由。注文の明細・在庫の台帳は外部キーで商品を消せないので、汎用の500にせず理由を返す。
CREATE OR REPLACE FUNCTION public.item_delete_blockers(_item_ids bigint[])
RETURNS TABLE (item_id bigint, has_orders boolean, has_stock_movements boolean, has_open_checkouts boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT ids.id,
         EXISTS (SELECT 1 FROM public.order_items AS oi WHERE oi.item_id = ids.id),
         EXISTS (
           SELECT 1
           FROM public.stock_movements AS m
           JOIN public.item_variants AS v ON v.id = m.variant_id
           WHERE v.item_id = ids.id
         ),
         EXISTS (SELECT 1 FROM public.find_open_checkout_sessions_for_item(ids.id))
  FROM pg_catalog.unnest(_item_ids) AS ids(id);
$$;

REVOKE ALL ON FUNCTION public.find_open_checkout_sessions_for_item(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.item_delete_blockers(bigint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_open_checkout_sessions_for_item(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.item_delete_blockers(bigint[]) TO service_role;

COMMIT;
```

- [ ] **Step 6: 共通の処理を書く**

`src/lib/items/item-delete-guidance.ts`:
```ts
/** 削除できない商品の案内（R-44）。管理画面と API で同じ文を使う */
export function buildItemDeleteGuidance(reasons: string[]): string {
  const detail = reasons.length > 0 ? `（${reasons.join('・')}）` : '';
  return `この商品は削除できません${detail}。非公開にすると、お客様の画面から見えなくなります。`;
}
```

`src/lib/items/item-checkout-guards.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { expireOpenCheckoutSession } from '@/lib/stripe/checkout-session-expiry';

export type ItemDeleteBlockers = {
  hasOrders: boolean;
  hasStockMovements: boolean;
  hasOpenCheckouts: boolean;
};

type BlockerRow = {
  item_id: number | string;
  has_orders: boolean;
  has_stock_movements: boolean;
  has_open_checkouts: boolean;
};

/** 削除できない理由を商品 ID ごとに読む（R-44） */
export async function fetchItemDeleteBlockers(
  client: SupabaseClient,
  itemIds: number[],
): Promise<Map<number, ItemDeleteBlockers>> {
  if (itemIds.length === 0) {
    return new Map();
  }

  const { data, error } = await client.rpc('item_delete_blockers', { _item_ids: itemIds });
  if (error) {
    throw error;
  }

  return new Map(
    ((data ?? []) as BlockerRow[]).map((row) => [
      Number(row.item_id),
      {
        hasOrders: row.has_orders,
        hasStockMovements: row.has_stock_movements,
        hasOpenCheckouts: row.has_open_checkouts,
      },
    ]),
  );
}

/** 理由が1つも無い商品だけ削除できる。読めなかった商品は削除できない扱いにする */
export function isItemDeletable(blockers: ItemDeleteBlockers | undefined): boolean {
  return Boolean(blockers) && !blockers!.hasOrders && !blockers!.hasStockMovements && !blockers!.hasOpenCheckouts;
}

export function describeDeleteBlockers(blockers: ItemDeleteBlockers): string[] {
  return [
    blockers.hasOrders ? '注文がある' : null,
    blockers.hasStockMovements ? '在庫の記録がある' : null,
    blockers.hasOpenCheckouts ? '決済中のお客様がいる' : null,
  ].filter((reason): reason is string => reason !== null);
}

/**
 * ① 非公開・削除にした商品を含む、開いている決済を失効させる（設計書 4-6）。
 * 失敗しても商品の変更は止めない（受付 RPC が非公開の商品を断る）。失効させた数と失敗の数を返す。
 */
export async function expireOpenCheckoutsForItem(params: {
  client: SupabaseClient;
  stripe: Stripe;
  itemId: number;
}): Promise<{ expired: number; failed: number }> {
  const { data, error } = await params.client.rpc('find_open_checkout_sessions_for_item', { _item_id: params.itemId });
  if (error) {
    console.error('[items] failed to find open checkout sessions for item', params.itemId, error);
    return { expired: 0, failed: 1 };
  }

  let expired = 0;
  let failed = 0;
  for (const row of (data ?? []) as Array<{ checkout_session_id: string }>) {
    try {
      if ((await expireOpenCheckoutSession(params.stripe, row.checkout_session_id)) === 'expired') {
        expired += 1;
      }
    } catch (expireError) {
      console.error('[items] failed to expire checkout session', row.checkout_session_id, expireError);
      failed += 1;
    }
  }

  return { expired, failed };
}
```

- [ ] **Step 7: 商品 API を変える**

`src/app/api/admin/items/[id]/route.ts` の import に足す:
```ts
import { getStripeServerClient } from '@/lib/stripe/server';
import {
  describeDeleteBlockers,
  expireOpenCheckoutsForItem,
  fetchItemDeleteBlockers,
  isItemDeletable,
} from '@/lib/items/item-checkout-guards';
import { buildItemDeleteGuidance } from '@/lib/items/item-delete-guidance';
```
ファイルの上の方（`patchStatusSchema` の次）に足す:
```ts
const itemIdSchema = z.coerce.number().int().positive();

/** ① 非公開にしたら、その商品を含む開いている決済を失効させる。失敗しても商品の変更は止めない */
async function expireCheckoutsIfUnpublished(
  supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
  id: string,
  status: 'private' | 'published',
): Promise<void> {
  const itemId = itemIdSchema.safeParse(id);
  if (status !== 'private' || !itemId.success) {
    return;
  }

  const result = await expireOpenCheckoutsForItem({ client: supabase, stripe: getStripeServerClient(), itemId: itemId.data });
  if (result.failed > 0) {
    console.error('[admin.items] some checkout sessions could not be expired', id, result);
  }
}
```
`PUT` の `return NextResponse.json({ success: true }, { status: 200 });` の直前に足す:
```ts
    await expireCheckoutsIfUnpublished(supabase, id, parsedPayload.data.status);
```
`PATCH` の `return NextResponse.json({ success: true }, { status: 200 });` の直前に足す:
```ts
    await expireCheckoutsIfUnpublished(supabase, id, parsed.data.status);
```
`DELETE` の `const supabase = await createServiceRoleClient();` から `return NextResponse.json({ success: true }, { status: 200 });` までを次に替える:
```ts
    const itemId = itemIdSchema.safeParse(id);
    if (!itemId.success) {
      return NextResponse.json({ error: 'Invalid item id' }, { status: 400 });
    }

    const supabase = await createServiceRoleClient();

    // 注文・在庫の記録・決済中のある商品は消さず、非公開へ誘導する（R-44）
    const blockers = (await fetchItemDeleteBlockers(supabase, [itemId.data])).get(itemId.data);
    if (!isItemDeletable(blockers)) {
      const reasons = blockers ? describeDeleteBlockers(blockers) : [];
      return NextResponse.json({ error: buildItemDeleteGuidance(reasons), reasons }, { status: 409 });
    }

    const { error } = await supabase
      .from('items')
      .delete()
      .eq('id', itemId.data);

    if (error) {
      // 確かめた後に注文・在庫の記録が増えた（外部キーで断られた）
      if (error.code === '23503') {
        return NextResponse.json({ error: buildItemDeleteGuidance([]), reasons: [] }, { status: 409 });
      }
      console.error('Failed to delete item:', error);
      return NextResponse.json({ error: 'Failed to delete item' }, { status: 500 });
    }

    await expireOpenCheckoutsForItem({ client: supabase, stripe: getStripeServerClient(), itemId: itemId.data });

    return NextResponse.json({ success: true }, { status: 200 });
```
`src/app/api/admin/items/route.ts` の import に足す:
```ts
import {
  describeDeleteBlockers,
  fetchItemDeleteBlockers,
  isItemDeletable,
  type ItemDeleteBlockers,
} from '@/lib/items/item-checkout-guards';
```
`GET` の `const signedItems = await Promise.all(...)` の行を次に替える:
```ts
    // signItemImageFields の型の制約は image_url・image_urls だけの弱い型なので、要素の型にも含める（TS2559 を避ける）
    const items = (data ?? []) as Array<{ id: number | string; image_url?: string | null; image_urls?: string[] | null }>;

    // 削除できない商品は、削除ボタンを押した時点で案内する（R-44）。読めなければ判定を付けない（削除時に API が確かめる）
    let blockers: Map<number, ItemDeleteBlockers> | null = null;
    try {
      blockers = await fetchItemDeleteBlockers(supabase, items.map((item) => Number(item.id)));
    } catch (blockersError) {
      console.error('Failed to fetch item delete blockers:', blockersError);
    }

    const signedItems = await Promise.all(items.map(async (item) => {
      const signed = await signItemImageFields(supabase, item);
      if (!blockers) {
        return signed;
      }
      const itemBlockers = blockers.get(Number(item.id));
      return {
        ...signed,
        canDelete: isItemDeletable(itemBlockers),
        deleteBlockedReasons: itemBlockers ? describeDeleteBlockers(itemBlockers) : [],
      };
    }));
```

- [ ] **Step 8: 商品一覧の画面を変える**

`src/components/ItemSection.tsx` の import に足す:
```tsx
import { buildItemDeleteGuidance } from "@/lib/items/item-delete-guidance";
```
`AdminItem` に足す:
```tsx
  /** 注文・在庫の記録・決済中のある商品は false（R-44） */
  canDelete?: boolean;
  deleteBlockedReasons?: string[];
```
`ItemCardProps` の `onDelete` を替える:
```tsx
  onDelete: (item: AdminItem) => void;
```
削除ボタンの `onClick={() => onDelete(item.id)}` を `onClick={() => onDelete(item)}` に替える。`handleDelete` をまるごと次に替える:
```tsx
  const handleDelete = async (item: AdminItem) => {
    // 削除できない商品は、送らずに非公開を促す（R-44）
    if (item.canDelete === false) {
      alert(buildItemDeleteGuidance(item.deleteBlockedReasons ?? []));
      return;
    }

    if (!confirm("この商品を削除してもよろしいですか？")) {
      return;
    }

    try {
      const res = await clientFetch(`/api/admin/items/${item.id}`, {
        method: "DELETE",
      });

      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        alert(
          typeof body.error === "string" && body.error.length > 0 && body.error.length <= 200
            ? body.error
            : buildItemDeleteGuidance([]),
        );
        await fetchItems();
        return;
      }

      if (!res.ok) {
        throw new Error("Failed to delete item");
      }

      await fetchItems();
    } catch (error) {
      console.error("Failed to delete item:", error);
      alert("商品の削除に失敗しました");
    }
  };
```

- [ ] **Step 9: E2E を書く**

`e2e/FR-ADMIN-062-item-delete-guidance.spec.ts`:
```ts
import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-414: 注文や在庫の記録がある商品を削除しようとすると、非公開を促す案内が出て商品が残る（R-44）。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const ITEMS = [
  {
    id: 1,
    name: 'シルクブラウス',
    category: 'TOPS',
    price: 28000,
    image_url: '/placeholder.png',
    status: 'published',
    canDelete: false,
    deleteBlockedReasons: ['注文がある'],
  },
  {
    id: 2,
    name: 'タックスカート',
    category: 'BOTTOMS',
    price: 32000,
    image_url: '/placeholder.png',
    status: 'private',
    canDelete: true,
    deleteBlockedReasons: [],
  },
];

async function mockAdminApis(page: Page, deleteRequests: string[]): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true },
      }),
    }),
  );
  await page.route('**/api/admin/items', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: ITEMS }) }),
  );
  await page.route('**/api/admin/items/*', (route) => {
    if (route.request().method() !== 'DELETE') {
      return route.fallback();
    }
    deleteRequests.push(route.request().url());
    // 一覧を読んだ後に注文が入った（競合）場合の応答
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'この商品は削除できません（決済中のお客様がいる）。非公開にすると、お客様の画面から見えなくなります。',
        reasons: ['決済中のお客様がいる'],
      }),
    });
  });
}

async function openItems(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ITEM' }).click();
  await expect(page.getByText('シルクブラウス')).toBeVisible();
}

function cardOf(page: Page, name: string) {
  return page.getByTestId('admin-item-grid').locator('.admin-item-card').filter({ hasText: name });
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-062 item delete guidance (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('注文のある商品は削除を送らず、非公開を促す案内を出して残す', async ({ page }) => {
      // FREQ-414-AC-01・AC-03
      const deleteRequests: string[] = [];
      const dialogs: string[] = [];
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        void dialog.accept();
      });
      await mockAdminApis(page, deleteRequests);
      await openItems(page);

      // 削除できない商品にも削除ボタンを出し、押せる（無効化・非表示にしない。2026-09-27 決定）
      const deleteButton = cardOf(page, 'シルクブラウス').getByRole('button', { name: '削除' });
      await expect(deleteButton).toBeVisible();
      await expect(deleteButton).toBeEnabled();

      await deleteButton.click();

      await expect.poll(() => dialogs).toEqual([
        'この商品は削除できません（注文がある）。非公開にすると、お客様の画面から見えなくなります。',
      ]);
      expect(deleteRequests).toEqual([]);
      await expect(page.getByText('シルクブラウス')).toBeVisible();
    });

    test('一覧の後に削除できなくなった商品は、サーバーの案内を出して残す', async ({ page }) => {
      // FREQ-414-AC-02
      const deleteRequests: string[] = [];
      const dialogs: string[] = [];
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        void dialog.accept();
      });
      await mockAdminApis(page, deleteRequests);
      await openItems(page);

      await cardOf(page, 'タックスカート').getByRole('button', { name: '削除' }).click();

      await expect.poll(() => dialogs.length).toBe(2);
      expect(dialogs[0]).toBe('この商品を削除してもよろしいですか？');
      expect(dialogs[1]).toContain('非公開にすると');
      expect(deleteRequests).toHaveLength(1);
      await expect(page.getByText('タックスカート')).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAdminApis(page, []);
      await openItems(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
```

- [ ] **Step 10: テストを通す**

Run:
```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/item_checkout_guards
npx jest tests/unit/lib/items tests/unit/api/admin && npm run typecheck
npx eslint src/lib/items "src/app/api/admin/items" src/components/ItemSection.tsx
npx playwright test e2e/FR-ADMIN-062 e2e/FR-ADMIN-052 e2e/FR-ADMIN-054
```
Expected: すべて PASS（FR-ADMIN-052・054 は商品カードの配置が崩れていないことの確認）

- [ ] **Step 11: FREQ 行を足す**

`docs/2_Specs/spec.md` の表の末尾に足す:
```text
| FREQ-414 | 商品を非公開・削除にしたら、その商品を含む開いている決済を失効させること。注文や在庫の記録がある商品は削除させず、非公開へ誘導すること（R-44） | FREQ-414-REQ-01 | 商品を非公開にしたら、その商品を含み受付の済んでいない開いている決済（24時間以内）を Stripe で失効させること。失敗しても商品の変更は止めないこと | FREQ-414-REQ-02 | 注文の明細・在庫の記録・決済中のある商品の削除は、汎用の500ではなく理由付きの409で断り、非公開を促すこと。一覧の削除ボタンは削除できない商品にも常に表示し（無効化・非表示にしない）、押した時点で同じ判定の案内を出すこと | FREQ-414-AC-01 | 注文や在庫の記録がある商品を削除しようとすると、非公開を促す案内が表示され、商品が残ること | FREQ-414-AC-02 | 一覧を読んだ後に削除できなくなった商品も、サーバーの案内が表示され、商品が残ること | FREQ-414-AC-03 | 削除できない商品にも削除ボタンが表示され、押せること |
```

- [ ] **Step 12: コミット**

```bash
git add supabase/migrations/20260927100700_item_checkout_guards.sql tests/integration/db/item_checkout_guards.integration.test.ts src/lib/items/item-delete-guidance.ts src/lib/items/item-checkout-guards.ts tests/unit/lib/items/item-checkout-guards.test.ts "src/app/api/admin/items/[id]/route.ts" src/app/api/admin/items/route.ts tests/unit/api/admin/items-checkout-guards-route.test.ts src/components/ItemSection.tsx e2e/FR-ADMIN-062-item-delete-guidance.spec.ts docs/2_Specs/spec.md
git commit -m "feat(admin): 商品の非公開で決済を失効させ、削除できない商品は理由を返す

注文・在庫の記録・決済中のある商品は汎用の500ではなく409で非公開へ誘導する（R-44）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 22: 古い RPC を消し、保留中の SQL に R-04 の不足分を足す

**Files:**
- Create: `supabase/migrations/20260927100800_retire_legacy_order_rpcs.sql`
- Create: `tests/integration/db/retire_legacy_order_rpcs.integration.test.ts`
- Modify: `src/features/cart/services/cart-stock.ts`（使われなくなった確定 RPC の読み取りを消す）
- Modify: `src/lib/stripe/checkout-session-expiry.ts`・`tests/unit/lib/stripe/checkout-session-expiry.test.ts`（使われなくなった関数を消す）
- Modify: `tests/integration/db/item_lock_order.integration.test.ts`・`order_shipping_kana.integration.test.ts`・`order_state_transition_hardening.integration.test.ts`・`checkout_draft_discount.integration.test.ts`（新しい RPC へ移す）
- Delete: `tests/integration/db/finalize_missing_item.integration.test.ts`・`finalize_order_concurrency.integration.test.ts`・`release_stock_next_status.integration.test.ts`・`variant_stock_on_order.integration.test.ts`（下の対応表のテストが同じことを確かめる）
- Modify: `supabase/pending/harden_order_state_transitions.sql`・`tests/unit/migrations/order-state-transition-hardening.test.ts`
- Modify: `supabase/pending/README.md`

**Interfaces:**
- Consumes: Task 13〜16 で呼び出し元を切り替え済みであること

消すテストと、同じことを確かめるテスト:

| 消すテスト | 同じことを確かめるテスト |
|---|---|
| `finalize_missing_item`（削除・非公開の商品で止まる、公開中なら通る） | Task 4 の「非公開の商品と存在しない商品は item_unavailable」と最初のテスト |
| `finalize_order_concurrency`（並行した確定で後発は先発の注文を返す、2回で1件） | Task 4 の「同じ Session の受付が並行しても…」「同じ Session で2回呼んでも注文は1件」 |
| `release_stock_next_status`（行き先の制限、既定は failed、cancelled で戻す） | Task 3 の「行き先 %s は拒否し…」「支払い手続き中を放棄にし…」「取消は実行者と理由が要り…」 |
| `variant_stock_on_order`（在庫・受注生産の振り分け、合算、停止中、バリアントなし、取消で戻す、二重に入らない、台帳の整合） | Task 4 の同名のテスト群と、Task 3 の「確保した分だけ戻す」 |

- [ ] **Step 1: 呼び出し元が残っていないことを確かめる**

Run:
```bash
grep -rn "finalize_order_from_checkout_draft" src
grep -rn "release_stock_for_unpaid_order" src
grep -rn "admin_cancel_failed_order" src
```
Expected: 1つ目は何も出ない。2つ目は `src/lib/stripe/checkout-payment-reconciler-deps.ts`（`_order_id` で呼ぶ）だけ。3つ目は `src/app/api/admin/orders/[id]/status/route.ts`（`_cancel_reason` を渡す）だけ

- [ ] **Step 2: 失敗するテストを書く**

`tests/integration/db/retire_legacy_order_rpcs.integration.test.ts`:
```ts
/** @jest-environment node */
import { describeLocalDb } from './helpers/local-db';

/**
 * 引数を変えた関数は古い定義を消し、同名の関数を重複させない（設計書 4-7。PGRST203 を避ける）。
 */
describeLocalDb('integration: 古い注文 RPC を消す', (db) => {
  test.each([
    ['public.finalize_order_from_checkout_draft(uuid,text,text,public.order_status,integer,text)'],
    ['public.release_stock_for_unpaid_order(text,public.order_status)'],
    ['public.admin_cancel_failed_order(uuid,uuid)'],
  ])('%s は無い', async (signature) => {
    const res = await db().query('select to_regprocedure($1) as oid', [signature]);
    expect(res.rows[0].oid).toBeNull();
  });

  test.each([
    ['release_stock_for_unpaid_order', 1],
    ['admin_cancel_failed_order', 1],
  ])('%s は1つだけ', async (name, count) => {
    const res = await db().query(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = $1`,
      [name],
    );
    expect(res.rows[0].n).toBe(count);
  });
});
```

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/retire_legacy_order_rpcs`
Expected: FAIL（古い定義が残っている）

- [ ] **Step 4: マイグレーションを書く**

`supabase/migrations/20260927100800_retire_legacy_order_rpcs.sql`:
```sql
-- 古い注文 RPC を消す（グループ A 設計書 4-7）。
--
-- 呼び出し元はすべて新しい RPC へ切り替えた（Webhook・完了 API・見回り・管理画面の取消）。
-- 同名の関数を並べると PostgREST が呼び分けられないこともある（PGRST203）ので、重複させない。
-- 本番アプリは未公開なので古い定義を残す必要が無い（2026-09-27 承認）。公開後に同じ変更をするときは
-- 広げる → 移す → 縮めるの3段階（Parallel Change）で行う。

BEGIN;

DROP FUNCTION IF EXISTS public.finalize_order_from_checkout_draft(
  uuid, text, text, public.order_status, integer, text
);
DROP FUNCTION IF EXISTS public.release_stock_for_unpaid_order(text, public.order_status);
DROP FUNCTION IF EXISTS public.admin_cancel_failed_order(uuid, uuid);

COMMIT;
```

- [ ] **Step 5: 古い RPC を使う結合テストを移す**

`tests/integration/db/item_lock_order.integration.test.ts`:
1. 冒頭の説明の「注文確定（finalize_order_from_checkout_draft）と在庫復元（release_stock_for_unpaid_order）」を「受付（place_order_from_checkout_draft）と在庫を戻す処理（release_stock_for_unpaid_order）」に替える
2. `createDraft` を替える（Session ID を持たせる）:
```ts
  async function createDraft(ids: number[]): Promise<{ draftId: string; checkoutSessionId: string; cartSessionId: string }> {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    // draft の明細は id の降順で並べる（入力順にも依存しないことを見るため）。
    const itemsSnapshot = [...ids].reverse().map((itemId) => ({
      item_id: itemId,
      item_name: 'ロック順テスト',
      item_price: 1000,
      item_image_url: 'https://example.com/item.png',
      color: null,
      size: null,
      quantity: 1,
      line_total: 1000,
    }));
    const cartSessionId = `lockorder-session-${suffix}`;
    const checkoutSessionId = `cs_lockorder_${suffix}`;

    const draft = await prober.query(
      `insert into public.checkout_drafts
         (session_id, checkout_session_id, payment_method, subtotal_amount, shipping_amount, total_amount, currency,
          shipping_snapshot, items_snapshot)
       values ($1, $2, 'stripe_card', $3, 0, $3, 'jpy', $4::jsonb, $5::jsonb)
       returning id`,
      [
        cartSessionId,
        checkoutSessionId,
        1000 * ids.length,
        JSON.stringify({ email: 'lockorder@example.com', fullName: 'テスト太郎' }),
        JSON.stringify(itemsSnapshot),
      ],
    );

    return { draftId: draft.rows[0].id, checkoutSessionId, cartSessionId };
  }
```
3. `createPendingOrder` の戻り値を注文 ID にする（`returning id, payment_intent_id` を `returning id` に、`return order.rows[0].payment_intent_id;` を `return order.rows[0].id;` に、戻り値の型の説明もそのまま `Promise<string>`）
4. `test('注文確定は商品 id の昇順でロックする'` を替える:
```ts
  test('受付は商品 id の昇順でロックする（FOR KEY SHARE でも FOR UPDATE NOWAIT とは衝突する）', async () => {
    const ids = await createItems(ITEM_COUNT);
    const { draftId, checkoutSessionId, cartSessionId } = await createDraft(ids);

    await expectAscendingLockOrder(ids, () =>
      runner.query(
        `select order_id from public.place_order_from_checkout_draft(
           $1::uuid, $2::text, $3::text, $4::integer, 0, 'jpy', now(), null)`,
        [draftId, checkoutSessionId, cartSessionId, 1000 * ids.length],
      ),
    );
  }, 120000);
```
5. `test('在庫復元は商品行をロックしない'` の中の `const paymentIntentId = await createPendingOrder(ids);` を `const orderId = await createPendingOrder(ids);` に、RPC の呼び出しを替える:
```ts
      const released = await runner.query(
        `select released from public.release_stock_for_unpaid_order(
           $1::uuid, 'pending', 'failed', 'stripe_voucher_expired')`,
        [orderId],
      );
```

`tests/integration/db/order_shipping_kana.integration.test.ts`:
1. 冒頭の説明の「注文確定（finalize_order_from_checkout_draft）」を「受付（place_order_from_checkout_draft）」に替える
2. `finalizeOrder` の draft の insert に Session ID を足す（列に `checkout_session_id` を、値に `$5` を足し、引数の配列の末尾に `` `cs_kana_${suffix}` `` を足す）:
```ts
    const draft = await client.query(
      `insert into public.checkout_drafts
         (session_id, payment_method, subtotal_amount, shipping_amount, total_amount, currency,
          shipping_snapshot, items_snapshot, checkout_session_id)
       values ($1, 'stripe_card', $2, 0, $2, 'jpy', $3::jsonb, $4::jsonb, $5)
       returning id`,
```
3. `const finalized = await client.query(...)` と `return finalized.rows[0].order_id;` を替える:
```ts
    const placed = await client.query(
      `select order_id from public.place_order_from_checkout_draft(
         $1::uuid, $2::text, $3::text, $4::integer, 0, 'jpy', now(), null)`,
      [draft.rows[0].id, `cs_kana_${suffix}`, `kana-session-${suffix}`, PRICE],
    );

    return placed.rows[0].order_id;
```
4. テスト名の「注文確定」を「受付」に替える

`tests/integration/db/checkout_draft_discount.integration.test.ts`:
- `function finalize(...)` と、それを使う3つのテスト（`割引後の合計で注文ができ…`・`割引が無い注文は…`・`下書きの合計と期待額がずれていれば…`）を消す（Task 4 の「割引は Stripe の値で注文に入れ…」「割引後の合計へ書き換え済みの古い下書きも受け付ける」「金額の違い」が確かめる）。使われなくなった定数（`DISCOUNT` など）も消し、`npx eslint tests/integration/db/checkout_draft_discount.integration.test.ts` で未使用の宣言が残っていないことを確かめる

`tests/integration/db/order_state_transition_hardening.integration.test.ts`:
1. `'public.admin_cancel_failed_order(uuid,uuid)'`（2か所）を `'public.admin_cancel_failed_order(uuid,uuid,text,text)'` に替える
2. `'select * from public.admin_cancel_failed_order($1::uuid, $2::uuid)'`（2か所）を次に替える:
```ts
        "select * from public.admin_cancel_failed_order($1::uuid, $2::uuid, 'customer_request', null)",
```
3. 状態を直接 UPDATE するテスト（`failed cancellation loses atomically…`・`配送先欠落の paid 注文は…`・`trigger rejects unpaid cancellation…`・`failed full refund must restore…`）の `begin` の直後に足す（Step 7 で変更理由の無い状態の変更を拒否するため。各テストが確かめたい条件に届くようにする）:
```ts
      await client.query("select set_config('app.order_change_reason', 'integration_test', true)");
```
4. `insertOrder` の `status` の型を `'payment_in_progress' | 'pending' | 'paid' | 'failed' | 'abandoned' | 'cancelled' | 'shipped'` に広げる
5. 末尾に足す:
```ts
  test('RPC を通らない状態の変更（変更理由なし）は拒否する', async () => {
    await client.query('begin');
    try {
      const orderId = await insertOrder({ status: 'pending' });
      await expect(
        client.query(`update public.orders set status = 'failed'::public.order_status where id = $1`, [orderId]),
      ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('ORDER_STATUS_CHANGE_REQUIRES_REASON') });
    } finally {
      await client.query('rollback');
    }
  });

  test('設計書 4-1 の表に無い遷移は拒否する', async () => {
    await client.query('begin');
    try {
      await client.query("select set_config('app.order_change_reason', 'integration_test', true)");
      const orderId = await insertOrder({ status: 'abandoned' });
      await expect(
        client.query(`update public.orders set status = 'paid'::public.order_status where id = $1`, [orderId]),
      ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('ORDER_STATUS_TRANSITION_NOT_ALLOWED') });
    } finally {
      await client.query('rollback');
    }
  });

  test('authenticated は注文と明細を直接作れず、消せない', async () => {
    const privileges = await client.query(
      `select has_table_privilege('authenticated', 'public.orders', 'INSERT') as orders_insert,
              has_table_privilege('authenticated', 'public.orders', 'DELETE') as orders_delete,
              has_table_privilege('authenticated', 'public.order_items', 'INSERT') as items_insert,
              has_table_privilege('authenticated', 'public.order_items', 'UPDATE') as items_update,
              has_table_privilege('authenticated', 'public.order_items', 'DELETE') as items_delete`,
    );
    expect(privileges.rows[0]).toEqual({
      orders_insert: false,
      orders_delete: false,
      items_insert: false,
      items_update: false,
      items_delete: false,
    });
  });
```
消すファイル:
```bash
git rm tests/integration/db/finalize_missing_item.integration.test.ts tests/integration/db/finalize_order_concurrency.integration.test.ts tests/integration/db/release_stock_next_status.integration.test.ts tests/integration/db/variant_stock_on_order.integration.test.ts
```

- [ ] **Step 6: 使われなくなったアプリのコードを消す**

`src/features/cart/services/cart-stock.ts` から `FinalizeOrderRpcRow` の型・`parseFinalizeOrderRpcResult`・`mapFinalizeOrderRpcError` を消す。消す前に `grep -rn "parseFinalizeOrderRpcResult\|mapFinalizeOrderRpcError\|FinalizeOrderRpcRow" src tests` で、このファイルのほかに出ないことを確かめる。

`src/lib/stripe/checkout-session-expiry.ts` の全体を次に置き換える（`expireCheckoutSessionForPaymentIntent`・`isPendingCheckoutPaymentIntentStatus` は Task 15・16 で使われなくなった）:
```ts
import type Stripe from 'stripe';

function isResourceMissingError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && (error as { code?: unknown }).code === 'resource_missing',
  );
}

export type OpenSessionExpiryResult = 'expired' | 'not_open' | 'missing';

/**
 * 開いている Checkout Session を失効させる（見回り・管理画面の取消・商品の非公開。設計書 2-2・4-6）。
 * 開いていなければ何もしない。支払いの完了と競合したら Stripe の現在値を優先し、失効させない。
 * 注文と在庫は、呼び出し側が照合関数で合わせる。
 */
export async function expireOpenCheckoutSession(
  stripe: Stripe,
  checkoutSessionId: string,
): Promise<OpenSessionExpiryResult> {
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
  } catch (error) {
    if (isResourceMissingError(error)) {
      return 'missing';
    }
    throw error;
  }

  if (session.status !== 'open') {
    return 'not_open';
  }

  try {
    await stripe.checkout.sessions.expire(
      checkoutSessionId,
      {},
      { idempotencyKey: `expire-checkout-session:${checkoutSessionId}` },
    );
    return 'expired';
  } catch (expireError) {
    // open を確かめた後に支払いが完了した（TOCTOU）。完了していれば失効させない
    const refreshed = await stripe.checkout.sessions.retrieve(checkoutSessionId);
    if (refreshed.status === 'expired') {
      return 'expired';
    }
    if (refreshed.status !== 'open') {
      return 'not_open';
    }
    throw expireError;
  }
}
```
`tests/unit/lib/stripe/checkout-session-expiry.test.ts` から `describe('expireCheckoutSessionForPaymentIntent', ...)` のブロックと、その import（`expireCheckoutSessionForPaymentIntent`・`isPendingCheckoutPaymentIntentStatus`）と、そのブロックでしか使っていない補助関数（ファイル先頭の `retrieve`・`list`・`expire`・`stripe`・`session`）を消す。これで使われなくなる `import type Stripe from 'stripe';` も消す（`describe('expireOpenCheckoutSession', ...)` は `Parameters<typeof expireOpenCheckoutSession>[0]` で型を取るので要らない）。`describe('expireOpenCheckoutSession', ...)` は残す。

- [ ] **Step 7: 保留中の第2段階に R-04 の不足分を足す**

`supabase/pending/harden_order_state_transitions.sql` の `DROP POLICY IF EXISTS "admin orders manage by permission update"\n  ON public.orders;` の次に足す:
```sql
-- 注文と明細は RPC だけで作り・変える（R-04 の不足分。グループ A 設計書 4-7）
REVOKE INSERT, DELETE, TRUNCATE ON TABLE public.orders FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.order_items FROM anon, authenticated;

DROP POLICY IF EXISTS "admin orders manage by permission insert" ON public.orders;
DROP POLICY IF EXISTS "admin orders manage by permission delete" ON public.orders;
DROP POLICY IF EXISTS "admin order items manage by permission insert" ON public.order_items;
DROP POLICY IF EXISTS "admin order items manage by permission update" ON public.order_items;
DROP POLICY IF EXISTS "admin order items manage by permission delete" ON public.order_items;
```
同じファイルの `private.enforce_order_payment_invariants()` の本体の先頭（`BEGIN` の直後）に足す:
```sql
  -- 状態の変更は RPC だけが行う。RPC は必ず変更理由を設定する（R-04。設計書 4-7）
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NULLIF(pg_catalog.current_setting('app.order_change_reason', true), '') IS NULL THEN
    RAISE EXCEPTION 'ORDER_STATUS_CHANGE_REQUIRES_REASON'
      USING ERRCODE = '23514';
  END IF;

  -- 設計書 4-1 の表に無い遷移は拒否する（取消の注文の復元は、全額返金の失敗で入金済み・発送済みへ戻すため）
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'payment_in_progress' AND NEW.status IN ('paid', 'pending', 'failed', 'abandoned', 'cancelled'))
    OR (OLD.status = 'pending' AND NEW.status IN ('paid', 'failed', 'cancelled'))
    OR (OLD.status = 'failed' AND NEW.status IN ('paid', 'cancelled'))
    OR (OLD.status = 'paid' AND NEW.status IN ('shipped', 'cancelled'))
    OR (OLD.status = 'shipped' AND NEW.status = 'cancelled')
    OR (OLD.status = 'cancelled' AND NEW.status IN ('paid', 'shipped'))
  ) THEN
    RAISE EXCEPTION 'ORDER_STATUS_TRANSITION_NOT_ALLOWED:%->%', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
```
`tests/unit/migrations/order-state-transition-hardening.test.ts` の `it('revokes direct updates and installs payment-state invariants'` の末尾に足す:
```ts
    expect(sql).toMatch(/REVOKE INSERT, DELETE, TRUNCATE ON TABLE public\.orders FROM anon, authenticated/i);
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public\.order_items FROM anon, authenticated/i);
    expect(sql).toContain('ORDER_STATUS_CHANGE_REQUIRES_REASON');
    expect(sql).toContain('ORDER_STATUS_TRANSITION_NOT_ALLOWED');
```
`supabase/pending/README.md` の表の2行を替える:
```text
| `schedule_expire_pending_orders.sql`  | 照合の見回り（毎時0分に `/api/cron/expire-pending-orders` を呼ぶ pg_cron）。開いてから30分を超えた決済の失効と、Webhook の取りこぼしの照合。FREQ-356 / FREQ-368 / FREQ-407 | 本番アプリ公開・決済手段の確認後。Vault に `cron_secret` と `app_base_url` を登録してから |
| `harden_order_state_transitions.sql`  | `orders`・`order_items`のData API直接更新・作成・削除を閉じ、入金・返金の不変条件と、変更理由の無い状態の変更・設計書 4-1 に無い遷移を拒否するトリガーを追加する第2段階（R-04） | 第1段階と対応アプリを本番確認後に、明示の承認を得て昇格・適用する |
```

- [ ] **Step 8: テストを通す**

Run:
```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db --runInBand
npx jest tests/unit && npm run typecheck && npm run lint
```
Expected: すべて PASS

- [ ] **Step 9: コミット**

```bash
git add supabase/migrations/20260927100800_retire_legacy_order_rpcs.sql tests/integration/db/retire_legacy_order_rpcs.integration.test.ts src/features/cart/services/cart-stock.ts src/lib/stripe/checkout-session-expiry.ts tests/unit/lib/stripe/checkout-session-expiry.test.ts tests/integration/db/item_lock_order.integration.test.ts tests/integration/db/order_shipping_kana.integration.test.ts tests/integration/db/order_state_transition_hardening.integration.test.ts tests/integration/db/checkout_draft_discount.integration.test.ts supabase/pending/harden_order_state_transitions.sql tests/unit/migrations/order-state-transition-hardening.test.ts supabase/pending/README.md
git commit -m "refactor(db): 古い注文 RPC を消し、保留中の第2段階に R-04 の不足分を足す

同名の関数を重複させない（PGRST203）。古い RPC を確かめていた結合テストは新しい RPC へ移すか、
同じことを確かめるテストに任せて消す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 23: 仕上げ（全体の確認と引き継ぎ）

**Files:**
- Modify: `docs/2_Specs/spec.md`（置き換えた要件の印）
- Modify: `docs/code-review/2026-09-25-working-diff-security-review.md`（グループ A の状態）
- Modify: `docs/4_DetailDesign/13_checkout.md`（掃除ジョブの節を照合の見回りに、新しい決済手段の手順の2・4）
- Modify: `docs/4_DetailDesign/16_admin.md`（ORDER タブ・ITEM タブ）
- Modify: `README.md`（Webhook の購読イベント）

- [ ] **Step 1: 置き換えた要件に印を付ける**

`docs/2_Specs/spec.md` の次の3か所の文の末尾に足す（行は消さない）:
- `FREQ-388-REQ-01` の要件の文の末尾: `（FREQ-407 で置き換え。見回りはアプリ独自の日数で打ち切らない）`
- `FREQ-389-REQ-01` の要件の文の末尾: `（FREQ-409 で置き換え。下書きへは割引額だけを受付 RPC の中で書き戻す。R-26）`
- `FREQ-389-REQ-03` の要件の文の末尾: `（FREQ-409 で置き換え。Webhook・完了 API・見回りは同じ照合関数を通り、注文の作成と割引額の書き戻しは受付 RPC の1つのトランザクションで行う。一時的な失敗は worker がイベントを再試行する）`

- [ ] **Step 2: 全部のテストを流す**

dev サーバーが止まっていることを確かめてから流す:
```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
```
Run:
```bash
npm run lint
npm run typecheck
npm test
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db --runInBand
npx playwright test e2e/FR-ADMIN-050 e2e/FR-ADMIN-051 e2e/FR-ADMIN-052 e2e/FR-ADMIN-054 e2e/FR-ADMIN-060 e2e/FR-ADMIN-061 e2e/FR-ADMIN-062 e2e/FR-ADMIN-063 e2e/FR-LEGAL-004
```
Expected: すべて PASS。E2E は API をモックした管理画面の spec と、DB に触れない /legal の spec だけを流す（全件は本番 Supabase に書くため、本計画では流さない。R-55）

- [ ] **Step 3: 本番へ当てる前の確認をまとめる**

コードは変えない。次をレビュー台帳のグループ A の行（`docs/code-review/2026-09-25-working-diff-security-review.md`）に「実装済み・push 待ち」として書く:
- マイグレーション9本（`20260927100000`〜`20260927100800`）。push すると CI が本番へ当てる
- 当てる直前に、本番の `orders.checkout_session_id` に重複が無いことを Supabase MCP の `execute_sql`（SELECT のみ）で読み直す: `select checkout_session_id, count(*) from public.orders where checkout_session_id is not null group by 1 having count(*) > 1;`
- 当てた後に MCP で読み戻すもの: enum の7値、`orders_checkout_session_id_key`、新しい関数の権限（`anon`・`authenticated` に EXECUTE が無い）、`payment_exceptions` の RLS、Security Advisor の新しい警告が0件（`get_advisors`）
- 本番の環境変数に `SHOP_ALERT_EMAIL` を足す
- 保留中の SQL（見回りの毎時の登録・R-04 の第2段階）は、今までどおり明示の承認を得てから当てる
- 公開前に照合を1回流し、移行前の未入金2件の結果を確かめる（設計書 7-1）

- [ ] **Step 4: 詳細設計と README を実装に合わせる**

ユーザー決定（2026-09-27。詳細設計の 13_checkout.md の掃除ジョブの節と 16_admin.md の ORDER・ITEM タブは Task 23 でまとめて更新する。`.superpowers/sdd/2026-09-27-order-payment-reconciliation/progress.md`）に当たる手順。コードは変えず、3つの文書を最終のコードに合わせる。

書き方の決まり:
- 下の文に書いた事実（値・関数名・ファイル名・状態・応答）は、書く前に1つずつ最終のコードで確かめる。違えばコードに合わせて書く（計画の文より実装を正とする）
- documentation-guide スキルの規則に従う。絵文字を使わない。概要セクションがあれば保つ。図を足すなら Mermaid で書く（AA は使わない）。表にできるものは表にする
- FREQ の番号は、Task 7・10・13・18・20・21 で実際に振った番号に読み替える（本計画の FREQ-407〜414 は目安）

**(a) `docs/4_DetailDesign/13_checkout.md`**

1. 「新しい決済手段をダッシュボードで有効化するときの手順」の2番目の項目の末尾の文「`PENDING_ORDER_EXPIRY_DAYS` は再照合を始める閾値であり、支払期限ではない」を消す（環境変数は Task 15 で廃止した。括弧書きは Task 7 で直してある）
2. 同じ手順の4番目の項目を次に替える:
```text
4. テストモードで「確定 → 支払い手続き中（`payment_in_progress`）の注文と在庫の確保 → 払込票の発行で入金待ち（Stripe の状態は `awaiting_payment`、注文の状態の値は `pending`）→ `async_payment_succeeded` で `paid` と入金確認のメール、または払込期限切れ（`async_payment_failed`）で `failed` と在庫の戻し・お支払い期限切れのお知らせ」を一巡させる。どの経路（Webhook・完了 API・見回り）でも、状態は照合関数が Stripe の現在値で決める
```
3. 「掃除ジョブの環境変数」の見出しから「下限を5日にする理由（FREQ-388）」の段落の終わりまで（前置きの文・環境変数の表・「Checkout Session が所有する PaymentIntent は…」の文・Stripe の状態の表・FREQ-388 の段落）を次に替える:
```markdown
### 照合の見回りと環境変数（FREQ-407）

`POST /api/cron/expire-pending-orders` は照合の見回り。pg_cron が毎時0分（`0 * * * *`）に呼ぶ。pg_net は POST リクエストのみ発行できるため POST となる。

| 項目 | 内容 |
| --- | --- |
| 対象 | 決済画面を開いてから30分を超えた支払い手続き中（`payment_in_progress`）の注文と、入金待ち（`pending`）の注文 |
| 1回の上限 | 50件・45秒（`MAX_ORDERS_PER_RUN`・`TIME_BUDGET_MS`）。残りは次の回に回す |
| 決済画面の失効 | 開いてから30分を超えてまだ開いている Checkout Session を失効させる（`expireOpenCheckoutSession`）。Webhook が届かなくても、放棄された決済の在庫は最長90分で戻る |
| 判定 | 照合関数（`reconcileCheckoutPayment`）が Stripe の Session と PaymentIntent の現在値だけで決める。アプリ独自の日数で入金待ちを打ち切らない |
| 店への要対応メール | 送れていない分を1回20件まで送り直す（`listUnsentShopAlerts`） |

| 環境変数 | 用途 |
| --- | --- |
| `CRON_SECRET` | 見回りの呼び出しの認証に使う `Authorization: Bearer <CRON_SECRET>` の照合値。不一致は 401 |

`PENDING_ORDER_EXPIRY_DAYS` は廃止した。入金待ちは Stripe が払込票の期限切れを確定したときだけ失敗にするので、日数の下限（FREQ-388 の5日）も要らない。FREQ-388 は FREQ-407 で置き換えた。

Checkout Session が所有する PaymentIntent は直接 cancel しない。Stripe の状態ごとの行動は判定表（`src/lib/stripe/checkout-payment-decision.ts`。設計書 3-2）にだけ置き、注文と在庫は照合関数が今の状態を条件にした RPC（`mark_order_paid`・`mark_order_awaiting_payment`・`release_stock_for_unpaid_order`）で変える。
```
4. 同じ節の続きで、日次の掃除を前提にした文も最終のコードに合わせる:
   - 「pg_net の待ち時間を短くすると」の段落の「毎晩失敗している」: 毎回失敗している
   - 「1回に処理する注文は最大50件とする。」の段落: 候補は開いてから30分を超えた支払い手続き中と入金待ち、範囲の巡回は UTC 日ごとでなく時間ごと（`resolveHourlyBatchOffset`）
   - 「認証失敗の記録と監視（FREQ-370）」の「実行時刻（04:00 UTC）から6時間以内に見る」: 見たい実行の時刻から6時間以内に見る（毎時0分に実行する）
   - 「pg_cron 登録」の「掃除ジョブを日次実行するための」: 照合の見回りを毎時実行するための
   - 「本番デプロイの前提条件（レビュー指摘 I8）」の1: 購読イベントは (c) の README と同じ6つ。「日次の掃除ジョブだけが唯一の在庫復元経路になる」は「毎時の見回りだけが注文と在庫を合わせる経路になる」

**(b) `docs/4_DetailDesign/16_admin.md`**

1. 「API 仕様（ADMIN-API）」の表の `/api/admin/orders` と `/api/admin/orders/:id/status` の行を替える:
```text
| `/api/admin/orders` | GET | 注文一覧（ページネーション・ステータスフィルタ。放棄は既定で出さない。`review=only` で要確認だけ）。各行に要確認・発送止めの理由・取消の可否・払込期限を付ける | `admin`, `supporter` |
| `/api/admin/orders/:id/status` | POST | 支払い手続き中・未決済・決済失敗の取消（理由は必須、メモ・お客様へのお知らせ）、決済完了の発送（用途別RPC）。払込票が有効な間の取消は409と払込期限、Stripe・DBの一時的な失敗は503 | `admin`, `supporter` |
```
同じ表の末尾に足す:
```text
| `/api/admin/order-attention` | GET | 未処理の要対応・要確認の一覧と件数（お客様の個人情報は返さない） | `admin.orders.read` |
| `/api/admin/orders/:id/review` | POST | 要確認を確認済みにする | `admin.orders.manage` |
| `/api/admin/payment-exceptions/:id/resolve` | POST | 要対応を解決済みにする。未入金の注文が付いていれば取り消して解決もできる。先に解決されていれば409 | `admin.orders.manage` |
| `/api/admin/items/:id` | DELETE | 商品の削除。注文の明細・在庫の記録・決済中のある商品は理由付きの409で断り、非公開を促す | `admin.items.manage` |
```
2. 「注文のキャンセル・返金（ADMIN-ORDER / FREQ-404）」の表の `pending`・`failed` のキャンセルの行と `paid` の発送の行を替え、`pending` の行の前に `payment_in_progress` の行、`failed` の行の次に `abandoned` の行を足す:
```text
| `payment_in_progress` | キャンセル（理由は必須） | 開いている Checkout Session を失効させてから、照合関数が Stripe の現在値で取り消し、確保した分だけ在庫を戻す（`release_stock_for_unpaid_order`）。先に支払いが完了していれば409 |
| `pending` | キャンセル（理由は必須） | 払込票が有効な間は取り消さず、409と払込期限（`cancelBlockedUntil`）を返す。期限の後は照合関数が Stripe の現在値で決める |
| `failed` | キャンセル（理由は必須。お知らせは出さない） | `admin_cancel_failed_order`が`failed`を条件に理由・メモ付きで更新する。競合で0件なら409 |
| `abandoned` | キャンセル | 409（放棄された注文は取り消さない） |
| `paid` | 発送 | `admin_ship_paid_order`が`paid`かつ未発送・配送先必須項目充足・支払額の違いの要対応が開いていないことを条件に`shipped`へ更新する。満たさないか競合で0件なら409。DBトリガーも直接更新を拒否する |
```
3. 「注文のキャンセル・返金」の節の次（「在庫の入力（ADMIN-STOCK / FREQ-399）」の前）に2つの節を足す:
```markdown
## ORDER タブの要対応・要確認と取消の画面（ADMIN-ORDER-ATTENTION / FREQ-411〜413）

| 部品 | 内容 |
| --- | --- |
| 要対応・要確認の欄（`src/components/AttentionInbox.tsx`） | 注文一覧の上に件数付きで出す。未処理が0件なら出さない。お客様の氏名・住所・メールは出さない |
| 件数 | 未処理の件数をサイドナビの ORDER（`src/components/AdminSideNav.tsx` の `badges`）と KPI 画面の上部の1行に出す |
| 状態の絞り込み | 「支払い手続き中」「放棄」を足す。放棄は既定の一覧に出さず、「放棄」で絞り込めば出る |
| 要確認の印 | 要確認の注文に「要確認」の印を出し、「要確認のみ」で絞り込める |
| 発送止め | 支払額の違いの要対応が開いている注文は「発送済みにする」を出さず、理由を出す（`admin_ship_paid_order` も断る） |
| 取消の画面（`src/components/OrderCancelDialog.tsx`） | Shopify の取消画面に合わせる。項目は下の表 |

- 要対応（`payment_exceptions`）: 注文を作れない支払い・支払額の違い・取り消した注文への入金など。理由の表示名は `PAYMENT_EXCEPTION_REASON_LABELS`（`src/lib/orders/order-payment-types.ts`）。「解決済みにする」（メモは任意）で欄から消す。未入金の注文が付いていれば「注文を取り消して解決」（理由とメモが必須）も選べる。別の管理者が先に解決していたら409で、二重に取り消さない
- 要確認（`orders.review_reason`）: 在庫を確保できなかった注文（`stock_not_reserved`）。「確認済みにする」で欄から消す
- どちらも実行者と日時を残す

| 取消の画面の項目 | 内容 |
| --- | --- |
| 理由 | 必須。在庫切れ・お客様の依頼・不正の疑い・その他（`CANCEL_REASONS`） |
| メモ | 店内だけに残る（500文字まで）。「その他」と要対応の解決では必須 |
| お客様へのお知らせ | 「お客様に取消のお知らせを送る」は既定でオン、外せる。失敗の注文の取消では出さない |
| 在庫 | 常に戻すので選択肢を置かない |
| 払込票が有効な入金待ち | 取り消させず、払込期限を表示する（API は409と `cancelBlockedUntil`） |

## ITEM タブの非公開と削除（ADMIN-ITEM-GUARD / FREQ-414）

- 商品一覧の削除ボタンは、削除できない商品にも常に出す（無効化・非表示にしない。R-44）
- 注文の明細・在庫の記録・決済中のある商品は、押した時点で削除を送らず、理由と非公開への案内を出す（`buildItemDeleteGuidance`。一覧の GET が `canDelete`・`deleteBlockedReasons` を返す）
- 一覧を読んだ後に削除できなくなった商品は、DELETE API が理由付きの409で断る（外部キーで断られた競合も409）。画面はサーバーの案内を出し、商品は残る
- 商品を非公開にしたら、その商品を含み受付の済んでいない開いている決済（24時間以内）を Stripe で失効させる。失効に失敗しても商品の変更は止めない（受付 RPC が非公開の商品を断る）。削除できたときも同じく失効させる
```

**(c) `README.md`**

1. 「4. Stripe の webhook 購読イベントを確認する」の本文（「Stripe ダッシュボード → 開発者」で始まる行から「この掃除ジョブが唯一の在庫復元経路になる。」で終わる行まで）を次に替える。一覧は Task 13 の `processStripeWebhookEvent` が照合関数へ渡す6つと同じにする（字下げの2文字の空白は残す）:
````markdown
  Stripe ダッシュボード → 開発者 → Webhook → 本番エンドポイント。照合関数へ渡す次の6つが有効になっていること（`src/lib/stripe/webhook-processor.ts` の `processStripeWebhookEvent`）。

  ```text
  checkout.session.completed
  checkout.session.async_payment_succeeded
  checkout.session.async_payment_failed
  checkout.session.expired
  payment_intent.succeeded
  payment_intent.payment_failed
  ```

  漏れているとエラーは出ないまま webhook 側の照合が発火せず、毎時の見回りだけが注文と在庫を合わせる経路になる（入金の反映・確認メール・在庫の戻しが次の見回りまで遅れる）。
````
2. 「これは何か」の3段落目の「ズレていると毎晩 401 を返すだけのジョブになり」の「毎晩」を「毎時」に替える（見回りは Task 15 で毎時にした）

Run:
```bash
grep -n "04:00 UTC\|毎晩\|日次\|UTC 日ごと\|expires_after_days: 3" docs/4_DetailDesign/13_checkout.md
grep -n "04:00 UTC\|毎晩\|PENDING_ORDER_EXPIRY_DAYS" README.md
```
Expected: どちらも何も出ない

- [ ] **Step 5: コミット**

```bash
git add docs/2_Specs/spec.md docs/code-review/2026-09-25-working-diff-security-review.md docs/4_DetailDesign/13_checkout.md docs/4_DetailDesign/16_admin.md README.md
git commit -m "docs: グループ A の詳細設計と README を実装に合わせ、本番へ当てる前の確認を残す

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
