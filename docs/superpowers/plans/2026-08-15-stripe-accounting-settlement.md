# Stripe Accounting Settlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stripe決済成功、実額手数料、成功返金、Payout、銀行着金確認を、履歴を失わず冪等にACCOUNTINGタブへ反映する。

**Architecture:** Supabaseの`orders`を注文の正本として維持し、Stripe Balance Transaction・Refund・Payoutを専用テーブルへ保存する。Stripe原始記録から明示的な借方・貸方を持つ`JournalEntry`を決定的に生成し、既存の注文由来仕訳と段階的に切り替える。Webhookはイベント分岐、同期モジュールはStripe API取得と永続化、会計モジュールは仕訳投影、管理APIは銀行着金確認に責務を限定する。

**Tech Stack:** Next.js 16.3 App Router、React 19、TypeScript 5、Stripe Node SDK 20.4、Supabase/Postgres、Jest、React Testing Library、Playwright

## Global Constraints

- 売上認識日はStripe決済成功日とする。
- 元売上を削除・減額せず、成功返金を返金日の`売上値引・返品`として追加する。
- 手数料は固定率で推定せず、Stripe Balance Transactionの実額だけを使う。
- `payout.paid`と銀行着金確認を分け、`Stripe決済残高 → Stripe入金途上 → 普通預金`で記録する。
- Stripeにだけ存在するPaymentIntentから注文を作成しない。
- `orders.refunded_amount`は互換用途で維持し、会計の返金根拠にはしない。
- Stripe IDと投影種別から安定した仕訳IDを生成し、Webhook・Cron・バックフィルを重ねても二重計上しない。
- 新規テーブルはRLSを有効化し、`anon`と`authenticated`から直接アクセスできないようにする。
- 本番DBへのマイグレーション適用は、この実装・ローカル検証とは別に明示承認を得る。
- 既存の未コミット変更とGraphify差分を、各タスクのコミットへ混在させない。
- 実装前に`node_modules/next/dist/docs/`のRoute Handler関連ガイドを確認する。

---

## File Structure

### Create

- `migrations/089_stripe_accounting_settlement.sql`: Stripe原始取引3テーブル、制約、RLS、権限、索引。
- `tests/unit/migrations/089_stripe_accounting_settlement.test.ts`: マイグレーションの構造・セキュリティ契約。
- `src/lib/stripe/accounting-types.ts`: DB行、Stripe入力、同期結果の共有型。
- `src/lib/stripe/accounting-store.ts`: 原始取引の不変項目検証と冪等保存。
- `src/lib/stripe/accounting-sync.ts`: PaymentIntent、Refund、Payoutの取得・ページネーション・照合。
- `tests/unit/lib/stripe/accounting-store.test.ts`: 不変項目と冪等更新。
- `tests/unit/lib/stripe/accounting-sync.test.ts`: Stripe取得、分類、Payout照合。
- `src/lib/finance/stripe-journal.ts`: Stripe原始記録から`JournalEntry`を生成。
- `tests/unit/lib/finance/stripe-journal.test.ts`: 売上、手数料、返金、Payout、銀行着金の仕訳契約。
- `src/app/api/admin/accounting/stripe-payouts/[id]/confirm/route.ts`: 銀行着金確認API。
- `tests/unit/api/admin/stripe-payout-confirm-route.test.ts`: RBAC、MFA、CSRF、状態、冪等性。
- `src/app/api/admin/accounting/stripe-backfill/route.ts`: 既存注文限定の管理者起動バックフィルAPI。
- `tests/unit/api/admin/stripe-backfill-route.test.ts`: バックフィルの認可、範囲、再実行安全性。
- `e2e/FR-ADMIN-050-stripe-settlement.spec.ts`: ACCOUNTINGタブのStripe決済・返金・Payout表示。

### Modify

- `src/app/api/webhook/stripe/route.ts`: Stripe会計同期とPayoutイベントをディスパッチ。
- `src/app/api/cron/stripe-reconcile/route.ts`: 既存注文限定の会計再同期とバックフィル。
- `src/lib/stripe/reconcile-orders.ts`: 不一致レポートへ会計同期結果を追加。
- `src/lib/stripe/order-refund-sync.ts`: `orders.refunded_amount`互換更新と原始Refund同期を協調。
- `src/lib/sales/order-sales.ts`: 新投影済み注文は総額売上を保持し、旧注文だけ従来フォールバック。
- `src/lib/finance/accounts.ts`: `1150 Stripe入金途上`を追加。
- `src/lib/finance/journal.ts`: 外部で生成した明示仕訳を安全に結合できる補助関数を追加。
- `src/app/api/admin/kpi/cost-profit/route.ts`: Stripe原始記録・Payout概要を取得してレスポンスへ追加。
- `src/components/CostProfitSection.tsx`: Stripe残高・返金・Payout・銀行確認UIを追加。
- `docs/Other/財務.md`: 勘定科目1150とStripe仕訳規則を追記。
- `tests/unit/api/webhook/stripe-route.test.ts`: 会計同期イベント分岐。
- `tests/unit/api/cron/stripe-reconcile-route.test.ts`: 定期照合の範囲・認証・失敗処理。
- `tests/unit/api/admin/cost-profit-route.test.ts`: 新APIレスポンスと旧方式フォールバック。
- `tests/unit/lib/sales/order-sales.test.ts`: 総額売上・旧方式互換。
- `tests/unit/lib/finance/journal.test.ts`: 明示仕訳の結合。
- `tests/unit/components/CostProfitSection.test.tsx`: Stripe決済残高とPayout操作。
- `e2e/FR-ADMIN-044-ledger-three-views.spec.ts`: Stripe仕訳の詳細表示。

---

### Task 1: Stripe会計原始記録のDB契約

**Files:**
- Create: `migrations/089_stripe_accounting_settlement.sql`
- Create: `tests/unit/migrations/089_stripe_accounting_settlement.test.ts`

**Interfaces:**
- Produces: `public.stripe_balance_transactions`、`public.stripe_refunds`、`public.stripe_payouts`
- Produces: Stripe ID主キー、金額整合性制約、RLS、service role専用アクセス
- Consumes: `public.orders(id, payment_intent_id, total_amount, currency)`、`auth.users(id)`

- [ ] **Step 1: Supabase CLIでマイグレーション雛形を生成する**

Run:

```powershell
npx.cmd supabase migration new stripe_accounting_settlement
```

生成されたSQLファイルを、リポジトリの連番規約に合わせて`migrations/089_stripe_accounting_settlement.sql`へ移動する。空の`supabase/migrations`コピーは残さない。

- [ ] **Step 2: 失敗するマイグレーション契約テストを書く**

```typescript
const sql = readFileSync(
  path.join(process.cwd(), 'migrations/089_stripe_accounting_settlement.sql'),
  'utf8',
);

expect(sql).toContain('CREATE TABLE public.stripe_balance_transactions');
expect(sql).toContain('CHECK (amount - fee = net)');
expect(sql).toContain('CREATE TABLE public.stripe_refunds');
expect(sql).toContain('CREATE TABLE public.stripe_payouts');
expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
expect(sql).toContain('REVOKE ALL ON public.stripe_balance_transactions FROM anon, authenticated');
expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON public.stripe_balance_transactions TO service_role');
```

- [ ] **Step 3: テストが正しい理由で失敗することを確認する**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/migrations/089_stripe_accounting_settlement.test.ts
```

Expected: `CREATE TABLE`、RLS、制約が未実装のためFAIL。

- [ ] **Step 4: マイグレーションを実装する**

SQLには設計書の全列に加えて、次の制約を実装する。

```sql
CONSTRAINT stripe_balance_transactions_amount_net_check
  CHECK (amount - fee = net),
CONSTRAINT stripe_balance_transactions_currency_check
  CHECK (currency ~ '^[a-z]{3}$'),
CONSTRAINT stripe_refunds_amount_positive_check
  CHECK (amount > 0),
CONSTRAINT stripe_payouts_reconciliation_status_check
  CHECK (reconciliation_status IN ('pending', 'matched', 'mismatch'))
```

全テーブルでRLSを有効化し、`anon`・`authenticated`をREVOKE、`service_role`へ必要最小限の`SELECT, INSERT, UPDATE`をGRANTする。DELETE権限は与えない。

- [ ] **Step 5: マイグレーションテストを通す**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/migrations/089_stripe_accounting_settlement.test.ts
```

Expected: PASS。

- [ ] **Step 6: 差分を確認してコミットする**

```powershell
git -c safe.directory=C:/work/o_official add migrations/089_stripe_accounting_settlement.sql tests/unit/migrations/089_stripe_accounting_settlement.test.ts
git -c safe.directory=C:/work/o_official commit -m "feat(accounting): add Stripe settlement schema"
```

---

### Task 2: Stripe原始記録の型と冪等保存

**Files:**
- Create: `src/lib/stripe/accounting-types.ts`
- Create: `src/lib/stripe/accounting-store.ts`
- Create: `tests/unit/lib/stripe/accounting-store.test.ts`

**Interfaces:**
- Produces: `StripeBalanceTransactionRow`、`StripeRefundRow`、`StripePayoutRow`
- Produces: `upsertBalanceTransaction()`、`upsertRefund()`、`upsertPayout()`
- Consumes: Supabase service-role互換の`StripeAccountingDatabase`

- [ ] **Step 1: 失敗する不変性・冪等性テストを書く**

```typescript
it('rejects a changed immutable amount for an existing balance transaction', async () => {
  const database = fakeDatabase({ id: 'txn_1', amount: 10_000, fee: 360, net: 9_640 });

  await expect(upsertBalanceTransaction(database, {
    id: 'txn_1', amount: 9_000, fee: 360, net: 8_640, currency: 'jpy',
    sourceId: 'ch_1', reportingCategory: 'charge', type: 'charge',
  })).rejects.toThrow('immutable Stripe balance transaction mismatch');
});

it('updates only mutable state for an identical Stripe id', async () => {
  const result = await upsertBalanceTransaction(database, {
    ...sameFinancialIdentity,
    status: 'available',
    payoutId: 'po_1',
  });
  expect(result.disposition).toBe('updated');
});
```

- [ ] **Step 2: REDを確認する**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/lib/stripe/accounting-store.test.ts
```

Expected: モジュール未作成でFAIL。

- [ ] **Step 3: 共有型と保存関数を実装する**

```typescript
export type StripeStoreDisposition = 'inserted' | 'updated' | 'unchanged';

export async function upsertBalanceTransaction(
  database: StripeAccountingDatabase,
  input: StripeBalanceTransactionInput,
): Promise<{ disposition: StripeStoreDisposition; row: StripeBalanceTransactionRow }>;

export async function upsertRefund(
  database: StripeAccountingDatabase,
  input: StripeRefundInput,
): Promise<{ disposition: StripeStoreDisposition; row: StripeRefundRow }>;

export async function upsertPayout(
  database: StripeAccountingDatabase,
  input: StripePayoutInput,
): Promise<{ disposition: StripeStoreDisposition; row: StripePayoutRow }>;
```

Balance Transactionは`id, source_id, amount, fee, net, currency`、Refundは`id, order_id, payment_intent_id, amount, currency`、Payoutは`id, amount, currency, automatic`を不変比較する。不一致時は上書きせず例外にする。

- [ ] **Step 4: GREENを確認する**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/lib/stripe/accounting-store.test.ts
```

Expected: PASS。

- [ ] **Step 5: コミットする**

```powershell
git -c safe.directory=C:/work/o_official add src/lib/stripe/accounting-types.ts src/lib/stripe/accounting-store.ts tests/unit/lib/stripe/accounting-store.test.ts
git -c safe.directory=C:/work/o_official commit -m "feat(stripe): persist accounting source records"
```

---

### Task 3: Stripe決済・返金・Payout同期

**Files:**
- Create: `src/lib/stripe/accounting-sync.ts`
- Create: `tests/unit/lib/stripe/accounting-sync.test.ts`

**Interfaces:**
- Produces: `syncPaymentIntentAccounting()`
- Produces: `syncRefundAccounting()`
- Produces: `syncPayoutAccounting()`
- Consumes: Task 2の保存関数、Stripe SDKのPaymentIntent/Charge/Refund/BalanceTransaction/Payout API

- [ ] **Step 1: 決済手数料同期の失敗テストを書く**

```typescript
it('stores the charge balance transaction with actual fee and net', async () => {
  stripe.paymentIntents.retrieve.mockResolvedValue(paymentIntentWithLatestCharge('ch_1'));
  stripe.charges.retrieve.mockResolvedValue(chargeWithBalanceTransaction('txn_1'));
  stripe.balanceTransactions.retrieve.mockResolvedValue({
    id: 'txn_1', amount: 10_000, fee: 360, net: 9_640,
    currency: 'jpy', reporting_category: 'charge', type: 'charge',
    source: 'ch_1', status: 'available', created: 1_754_000_000,
  });

  const result = await syncPaymentIntentAccounting({ stripe, database, paymentIntentId: 'pi_1' });

  expect(result.balanceTransactionId).toBe('txn_1');
  expect(database.savedBalanceTransaction.fee).toBe(360);
});
```

- [ ] **Step 2: 返金とPayoutページネーションの失敗テストを書く**

```typescript
it('uses the refund balance transaction created time as succeededAt', async () => {
  const result = await syncRefundAccounting({ stripe, database, refundId: 're_1' });
  expect(result.refund.succeededAt).toBe('2026-08-15T01:00:00.000Z');
});

it('reads every balance transaction in an automatic payout', async () => {
  const result = await syncPayoutAccounting({ stripe, database, payoutId: 'po_1' });
  expect(result.transactionCount).toBe(101);
  expect(result.reconciliationStatus).toBe('matched');
});
```

- [ ] **Step 3: REDを確認する**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/lib/stripe/accounting-sync.test.ts
```

Expected: 同期関数未実装でFAIL。

- [ ] **Step 4: 同期関数を最小実装する**

```typescript
export async function syncPaymentIntentAccounting(input: {
  stripe: StripeAccountingClient;
  database: StripeAccountingDatabase;
  paymentIntentId: string;
}): Promise<PaymentAccountingSyncResult>;

export async function syncRefundAccounting(input: {
  stripe: StripeAccountingClient;
  database: StripeAccountingDatabase;
  refundId: string;
}): Promise<RefundAccountingSyncResult>;

export async function syncPayoutAccounting(input: {
  stripe: StripeAccountingClient;
  database: StripeAccountingDatabase;
  payoutId: string;
}): Promise<PayoutAccountingSyncResult>;
```

`balanceTransactions.list({ payout: payoutId, limit: 100 })`はStripe SDKの自動ページネーションで最後まで読む。Payout金額と対象取引の符号調整後純額合計が一致したときだけ`matched`にする。PaymentIntentに対応する`orders`がなければ保存せず`unmatched`を返す。

- [ ] **Step 5: GREENを確認する**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/lib/stripe/accounting-sync.test.ts
```

Expected: PASS。

- [ ] **Step 6: コミットする**

```powershell
git -c safe.directory=C:/work/o_official add src/lib/stripe/accounting-sync.ts tests/unit/lib/stripe/accounting-sync.test.ts
git -c safe.directory=C:/work/o_official commit -m "feat(stripe): reconcile fees refunds and payouts"
```

---

### Task 4: Stripe原始記録からの会計仕訳投影

**Files:**
- Create: `src/lib/finance/stripe-journal.ts`
- Create: `tests/unit/lib/finance/stripe-journal.test.ts`
- Modify: `src/lib/finance/accounts.ts`
- Modify: `src/lib/finance/journal.ts`
- Modify: `tests/unit/lib/finance/journal.test.ts`
- Modify: `docs/Other/財務.md`

**Interfaces:**
- Produces: `buildStripeJournal(input: StripeJournalInput): JournalEntry[]`
- Produces: `mergeJournalEntries(base, generated): JournalEntry[]`
- Produces: 勘定科目`1150 Stripe入金途上`
- Consumes: Task 2のDB行型、既存`JournalEntry`・`resolveAccount()`

- [ ] **Step 1: 売上・手数料・返金の失敗テストを書く**

```typescript
const journal = buildStripeJournal({ orders, balanceTransactions, refunds, payouts });

expect(linesOf(journal, 'stripe:sale:order-1')).toEqual([
  line('1130', 10_000, 0),
  line('4010', 0, 10_000),
]);
expect(linesOf(journal, 'stripe:fee:txn-charge-1')).toEqual([
  line('6280', 360, 0),
  line('1130', 0, 360),
]);
expect(linesOf(journal, 'stripe:refund:re_1')).toEqual([
  line('4020', 10_000, 0),
  line('1130', 0, 10_000),
]);
```

- [ ] **Step 2: Payout・銀行確認・未知分類の失敗テストを書く**

```typescript
expect(linesOf(journal, 'stripe:payout:po_1')).toEqual([
  line('1150', 9_640, 0),
  line('1130', 0, 9_640),
]);
expect(linesOf(journal, 'stripe:bank:po_1')).toEqual([
  line('1040', 9_640, 0),
  line('1150', 0, 9_640),
]);
expect(linesOf(journal, 'stripe:payout-failure:txn_failure_1')).toEqual([
  line('1130', 9_640, 0),
  line('1150', 0, 9_640),
]);
expect(journal.some((entry) => entry.number.includes('dispute'))).toBe(false);
```

同じBalance Transactionの埋込`fee`と独立`stripe_fee`が同一費用を表すfixtureでは、仕訳キーにより支払手数料が1回だけ計上されるテストを追加する。

- [ ] **Step 3: REDを確認する**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/lib/finance/stripe-journal.test.ts tests/unit/lib/finance/journal.test.ts
```

Expected: モジュール・科目1150未実装でFAIL。

- [ ] **Step 4: 最小の会計投影を実装する**

```typescript
export type StripeJournalInput = {
  orders: readonly StripeJournalOrder[];
  balanceTransactions: readonly StripeBalanceTransactionRow[];
  refunds: readonly StripeRefundRow[];
  payouts: readonly StripePayoutRow[];
};

export function buildStripeJournal(input: StripeJournalInput): JournalEntry[];

export function mergeJournalEntries(
  base: readonly JournalEntry[],
  generated: readonly JournalEntry[],
): JournalEntry[];
```

許可する`reporting_category`は設計書4.3節だけとする。仕訳キーは`stripe:<projection-kind>:<stripe-id>`、表示伝票番号は日付と安定ハッシュから生成する。`fee > 0`は費用、`fee < 0`は戻入とし、同じBalance Transaction ID・投影種別を一度だけ出力する。

- [ ] **Step 5: GREENを確認する**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/lib/finance/stripe-journal.test.ts tests/unit/lib/finance/journal.test.ts
```

Expected: PASS。

- [ ] **Step 6: 勘定科目文書を更新して検証する**

`docs/Other/財務.md`へ`1150 Stripe入金途上 / その他流動資産 / 資産 / 借方`と、1130・1150・1040間の振替規則を追記する。

Run:

```powershell
npm.cmd run validate-docs
```

Expected: PASS。

- [ ] **Step 7: コミットする**

```powershell
git -c safe.directory=C:/work/o_official add src/lib/finance/stripe-journal.ts src/lib/finance/accounts.ts src/lib/finance/journal.ts tests/unit/lib/finance/stripe-journal.test.ts tests/unit/lib/finance/journal.test.ts docs/Other/財務.md
git -c safe.directory=C:/work/o_official commit -m "feat(accounting): project Stripe settlement journal"
```

---

### Task 5: Webhookと定期照合への統合

**Files:**
- Modify: `src/app/api/webhook/stripe/route.ts`
- Modify: `src/app/api/cron/stripe-reconcile/route.ts`
- Modify: `src/lib/stripe/reconcile-orders.ts`
- Modify: `src/lib/stripe/order-refund-sync.ts`
- Modify: `tests/unit/api/webhook/stripe-route.test.ts`
- Modify: `tests/unit/api/cron/stripe-reconcile-route.test.ts`
- Modify: `tests/unit/lib/stripe/reconcile-orders.test.ts`
- Modify: `tests/unit/lib/stripe/order-refund-sync.test.ts`
- Create: `src/app/api/admin/accounting/stripe-backfill/route.ts`
- Create: `tests/unit/api/admin/stripe-backfill-route.test.ts`

**Interfaces:**
- Consumes: Task 3の同期関数
- Produces: Webhookイベントからの会計同期、Cronによる欠落補完、既存注文限定バックフィル
- Produces: `POST /api/admin/accounting/stripe-backfill`

- [ ] **Step 1: Webhook分岐の失敗テストを書く**

```typescript
it.each([
  ['payment_intent.succeeded', 'syncPaymentIntentAccounting'],
  ['refund.updated', 'syncRefundAccounting'],
  ['payout.reconciliation_completed', 'syncPayoutAccounting'],
  ['payout.paid', 'syncPayoutAccounting'],
  ['payout.failed', 'syncPayoutAccounting'],
])('dispatches %s once through the accounting synchronizer', async (eventType, method) => {
  mockConstructEvent.mockReturnValue(stripeEvent(eventType));
  await POST(webhookRequest());
  expect(accountingSync[method]).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Cronの対象範囲と失敗回復テストを書く**

```typescript
it('does not create orders for unmatched Stripe payments', async () => {
  const response = await GET(authorizedCronRequest());
  expect(mockOrderInsert).not.toHaveBeenCalled();
  expect(await response.json()).toMatchObject({ unmatchedPayments: 1 });
});
```

- [ ] **Step 3: REDを確認する**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/api/webhook/stripe-route.test.ts tests/unit/api/cron/stripe-reconcile-route.test.ts tests/unit/api/admin/stripe-backfill-route.test.ts tests/unit/lib/stripe/reconcile-orders.test.ts tests/unit/lib/stripe/order-refund-sync.test.ts
```

Expected: 新イベントと同期呼出し未実装でFAIL。

- [ ] **Step 4: Webhook Routeを薄いディスパッチャとして実装する**

署名検証と`beginWebhookEvent()`は維持する。各イベントハンドラは同期関数を呼び、DB保存完了後だけ`completeWebhookEvent()`へ進む。一時Stripeエラー、429、DBエラーは5xx、恒久的な不整合は監査ログと要確認結果を保存して2xxにする。

- [ ] **Step 5: Cronを拡張する**

既存注文のPaymentIntent、未確定Refund、最近の自動Payout、`pending/mismatch`を対象とする。既存の`Authorization: Bearer ${CRON_SECRET}`を維持する。結果は次の形で返す。

```typescript
type StripeReconcileResponse = {
  matchedOrders: number;
  unmatchedPayments: number;
  syncedBalanceTransactions: number;
  syncedRefunds: number;
  syncedPayouts: number;
  payoutMismatches: number;
  errors: Array<{ sourceId: string; reason: string }>;
};
```

- [ ] **Step 6: 管理者起動バックフィルAPIを実装する**

`POST /api/admin/accounting/stripe-backfill`は`admin.finance.manage`、MFA、CSRFを検証し、リクエスト`{ cursor?: string, limit: number }`を`limit: 1..100`で検証する。`orders.payment_intent_id`が存在する注文だけをID昇順で読み、最大100件ずつ`syncPaymentIntentAccounting()`と返金同期へ渡す。Stripeだけに存在する決済を探索せず、注文をINSERTしない。レスポンスは次の形とする。

```typescript
type StripeBackfillResponse = {
  data: {
    processed: number;
    synced: number;
    failed: number;
    nextCursor: string | null;
    errors: Array<{ orderId: string; reason: string }>;
  };
};
```

再実行はTask 2の冪等保存により同じ結果となる。1件の失敗でバッチ全体をロールバックせず、失敗注文を`errors`へ含める。

- [ ] **Step 7: GREENを確認する**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/api/webhook/stripe-route.test.ts tests/unit/api/cron/stripe-reconcile-route.test.ts tests/unit/api/admin/stripe-backfill-route.test.ts tests/unit/lib/stripe/reconcile-orders.test.ts tests/unit/lib/stripe/order-refund-sync.test.ts
```

Expected: PASS。

- [ ] **Step 8: コミットする**

```powershell
git -c safe.directory=C:/work/o_official add src/app/api/webhook/stripe/route.ts src/app/api/cron/stripe-reconcile/route.ts src/app/api/admin/accounting/stripe-backfill/route.ts src/lib/stripe/reconcile-orders.ts src/lib/stripe/order-refund-sync.ts tests/unit/api/webhook/stripe-route.test.ts tests/unit/api/cron/stripe-reconcile-route.test.ts tests/unit/api/admin/stripe-backfill-route.test.ts tests/unit/lib/stripe/reconcile-orders.test.ts tests/unit/lib/stripe/order-refund-sync.test.ts
git -c safe.directory=C:/work/o_official commit -m "feat(stripe): sync accounting events and payouts"
```

---

### Task 6: 注文売上の段階移行とACCOUNTING API

**Files:**
- Modify: `src/lib/sales/order-sales.ts`
- Modify: `tests/unit/lib/sales/order-sales.test.ts`
- Modify: `src/app/api/admin/kpi/cost-profit/route.ts`
- Modify: `tests/unit/api/admin/cost-profit-route.test.ts`

**Interfaces:**
- Produces: 新投影済み注文の総額売上と、旧注文の互換フォールバック
- Produces: `stripeAccounting` APIレスポンス
- Consumes: Task 1の3テーブル、Task 4の投影入力

- [ ] **Step 1: 新旧切替の失敗テストを書く**

```typescript
it('keeps gross order revenue when Stripe source records exist', () => {
  expect(toOrderSalesTransaction(order, { hasStripeAccounting: true })).toMatchObject({
    grossAmount: 10_000,
    netAmount: 10_000,
  });
});

it('uses the legacy refunded net only before source records are backfilled', () => {
  expect(toOrderSalesTransaction(order, { hasStripeAccounting: false })?.netAmount).toBe(7_000);
});
```

- [ ] **Step 2: APIレスポンスの失敗テストを書く**

```typescript
expect(payload.data.stripeAccounting).toMatchObject({
  balanceTransactions: expect.any(Array),
  refunds: expect.any(Array),
  payouts: expect.any(Array),
  summary: {
    stripeBalance: 9_640,
    inTransitBalance: 0,
    unmatchedPayoutCount: 0,
  },
});
```

- [ ] **Step 3: REDを確認する**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/lib/sales/order-sales.test.ts tests/unit/api/admin/cost-profit-route.test.ts
```

Expected: オプションと`stripeAccounting`未実装でFAIL。

- [ ] **Step 4: 段階切替とAPI取得を実装する**

注文に対応する`stripe_balance_transactions`が1件以上あり、決済Chargeが取得済みの場合だけ新投影へ切り替える。返金テーブルだけ、Payoutだけ、同期途中の注文は旧方式を維持する。APIは会計年度に必要な原始記録と、未確認Payoutを取得する。

- [ ] **Step 5: GREENを確認する**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/lib/sales/order-sales.test.ts tests/unit/api/admin/cost-profit-route.test.ts
```

Expected: PASS。

- [ ] **Step 6: コミットする**

```powershell
git -c safe.directory=C:/work/o_official add src/lib/sales/order-sales.ts tests/unit/lib/sales/order-sales.test.ts src/app/api/admin/kpi/cost-profit/route.ts tests/unit/api/admin/cost-profit-route.test.ts
git -c safe.directory=C:/work/o_official commit -m "feat(accounting): expose Stripe settlement records"
```

---

### Task 7: 銀行着金確認API

**Files:**
- Create: `src/app/api/admin/accounting/stripe-payouts/[id]/confirm/route.ts`
- Create: `tests/unit/api/admin/stripe-payout-confirm-route.test.ts`

**Interfaces:**
- Produces: `POST /api/admin/accounting/stripe-payouts/:id/confirm`
- Request: `{ bankArrivalDate: "YYYY-MM-DD" }`
- Response: `{ data: { payoutId, bankArrivalDate, bankConfirmedAt, bankConfirmedBy } }`
- Consumes: `admin.finance.manage`、MFA、CSRF、`stripe_payouts`

- [ ] **Step 1: 認可・状態・冪等性の失敗テストを書く**

```typescript
it.each([
  ['permission denied', permissionDenied(), 403],
  ['MFA required', mfaRequired(), 403],
  ['CSRF denied', csrfDenied(), 403],
  ['payout not paid', payout({ status: 'pending' }), 409],
  ['payout mismatch', payout({ reconciliation_status: 'mismatch' }), 409],
])('%s', async (_name, setup, expectedStatus) => {
  setup();
  const response = await POST(request(), { params: Promise.resolve({ id: 'po_1' }) });
  expect(response.status).toBe(expectedStatus);
});
```

```typescript
it('returns the existing confirmation without rewriting it', async () => {
  const response = await POST(request('2026-08-16'), { params: Promise.resolve({ id: 'po_1' }) });
  expect(response.status).toBe(200);
  expect(mockUpdate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: REDを確認する**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/api/admin/stripe-payout-confirm-route.test.ts
```

Expected: Route未作成でFAIL。

- [ ] **Step 3: Route Handlerを実装する**

Next.js 16の非同期`params`を使用する。`authorizeAdminPermission()`、既存MFA判定、`requireCsrfOrDeny()`の順で検証し、`paid + matched + 未確認`の行だけ条件付きUPDATEする。競合で0行なら再読込し、同じ着金日なら成功、異なる着金日なら409にする。

- [ ] **Step 4: GREENを確認する**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/api/admin/stripe-payout-confirm-route.test.ts
```

Expected: PASS。

- [ ] **Step 5: コミットする**

```powershell
git -c safe.directory=C:/work/o_official add src/app/api/admin/accounting/stripe-payouts/[id]/confirm/route.ts tests/unit/api/admin/stripe-payout-confirm-route.test.ts
git -c safe.directory=C:/work/o_official commit -m "feat(accounting): confirm Stripe bank arrivals"
```

---

### Task 8: ACCOUNTING UIと仕訳・元帳統合

**Files:**
- Modify: `src/components/CostProfitSection.tsx`
- Modify: `tests/unit/components/CostProfitSection.test.tsx`
- Modify: `e2e/FR-ADMIN-044-ledger-three-views.spec.ts`
- Create: `e2e/FR-ADMIN-050-stripe-settlement.spec.ts`

**Interfaces:**
- Consumes: Task 6の`stripeAccounting`、Task 7の確認API、Task 4の仕訳投影
- Produces: Stripe残高カード、Payout一覧、銀行着金確認、売上・返金別行表示

- [ ] **Step 1: コンポーネントの失敗テストを書く**

```typescript
expect(screen.getByText('Stripe決済残高')).toBeVisible();
expect(screen.getByText('Stripe入金途上')).toBeVisible();
expect(screen.getByRole('button', { name: 'Payout po_1 の銀行着金を確認' })).toBeEnabled();
expect(screen.getByText('売上値引・返品')).toBeVisible();
```

`mismatch`、`pending`、`failed`では確認ボタンが無効で理由が表示されるテストも追加する。

- [ ] **Step 2: REDを確認する**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/components/CostProfitSection.test.tsx
```

Expected: Stripe精算UI未実装でFAIL。

- [ ] **Step 3: 既存共通UIで最小実装する**

既存`Panel`、`DataTable`、`StatusBadge`、`Dialog`、`TextField`、`Button`を再利用する。Payout表は横スクロールを維持し、列は`Payout ID / 金額 / Stripe状態 / 予定着金日 / 照合 / 銀行確認 / 操作`とする。確認Dialogで着金日を入力し、成功後に再取得する。

- [ ] **Step 4: コンポーネントテストを通す**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/components/CostProfitSection.test.tsx
```

Expected: PASS。

- [ ] **Step 5: E2Eを先に失敗させる**

`FR-ADMIN-050`でmobile、tablet、desktopの3プロジェクトについて、次をモックデータで検証する。

```typescript
await expect(page.getByText('Stripe決済残高')).toContainText('¥9,640');
await expect(page.getByText('Stripe入金途上')).toContainText('¥9,640');
await page.getByRole('button', { name: 'Payout po_1 の銀行着金を確認' }).click();
await page.getByLabel('銀行着金日').fill('2026-08-16');
await page.getByRole('button', { name: '着金を確定' }).click();
```

Run:

```powershell
npx.cmd playwright test e2e/FR-ADMIN-050-stripe-settlement.spec.ts --workers=1
```

Expected: UI未完成の段階ではFAIL。実装後は3プロジェクトすべてPASS。

- [ ] **Step 6: 仕訳詳細E2Eを更新して通す**

Run:

```powershell
npx.cmd playwright test e2e/FR-ADMIN-044-ledger-three-views.spec.ts e2e/FR-ADMIN-050-stripe-settlement.spec.ts --workers=1
```

Expected: Stripe売上、手数料、返金、入金途上、普通預金の相手勘定がすべて表示されPASS。

- [ ] **Step 7: コミットする**

```powershell
git -c safe.directory=C:/work/o_official add src/components/CostProfitSection.tsx tests/unit/components/CostProfitSection.test.tsx e2e/FR-ADMIN-044-ledger-three-views.spec.ts e2e/FR-ADMIN-050-stripe-settlement.spec.ts
git -c safe.directory=C:/work/o_official commit -m "feat(accounting): show Stripe settlement workflow"
```

---

### Task 9: 統合検証・セキュリティ監査・Graphify

**Files:**
- Modify only if a verification failure proves a task-scoped defect.

**Interfaces:**
- Consumes: Tasks 1-8の完成物
- Produces: 検証記録、更新済みGraphify、最終コミット状態

- [ ] **Step 1: 対象Jestを実行する**

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/migrations/089_stripe_accounting_settlement.test.ts tests/unit/lib/stripe/accounting-store.test.ts tests/unit/lib/stripe/accounting-sync.test.ts tests/unit/lib/finance/stripe-journal.test.ts tests/unit/lib/finance/journal.test.ts tests/unit/lib/sales/order-sales.test.ts tests/unit/api/webhook/stripe-route.test.ts tests/unit/api/cron/stripe-reconcile-route.test.ts tests/unit/api/admin/stripe-backfill-route.test.ts tests/unit/api/admin/stripe-payout-confirm-route.test.ts tests/unit/api/admin/cost-profit-route.test.ts tests/unit/components/CostProfitSection.test.tsx
```

Expected: 全件PASS。

- [ ] **Step 2: 型検査・Lint・文書検証を実行する**

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run validate-docs
```

Expected: すべてexit 0。生成物や既知の環境要因が失敗した場合は、対象ソースとの因果を分けて報告する。

- [ ] **Step 3: セキュリティ監査を実行する**

Windowsではリポジトリ標準ラッパーを使用する。

```powershell
powershell -ExecutionPolicy Bypass -File .codex/skills/security-check/scripts/audit.ps1
```

Expected: Critical / High / Medium / Lowの新規指摘0。

- [ ] **Step 4: E2Eをポート3000で実行する**

既存サーバーのlistenerを確認し、未起動の場合だけ`http://localhost:3000`で起動して、終了後も稼働させる。

```powershell
npx.cmd playwright test e2e/FR-CHECKOUT-009-webhook-idempotency.spec.ts e2e/FR-ADMIN-044-ledger-three-views.spec.ts e2e/FR-ADMIN-050-stripe-settlement.spec.ts --workers=1
```

Expected: 対象プロジェクトすべてPASS。

- [ ] **Step 5: マイグレーションをローカル相当で検証する**

Supabase CLIの利用可能なコマンドを`npx.cmd supabase --help`と`npx.cmd supabase db --help`で確認してから、ローカルDBへ適用し、次をread-backする。

```sql
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('stripe_balance_transactions', 'stripe_refunds', 'stripe_payouts');

SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('stripe_balance_transactions', 'stripe_refunds', 'stripe_payouts');
```

Expected: 3テーブルともRLS有効、`anon`・`authenticated`権限なし、制約・索引あり。本番DBへは適用しない。

- [ ] **Step 6: Graphifyを更新する**

```powershell
graphify update .
```

Expected: 更新成功。既存の無関係なGraphify差分は最終コミットへ含めない。

- [ ] **Step 7: 最終差分と履歴を確認する**

```powershell
git -c safe.directory=C:/work/o_official status --short
git -c safe.directory=C:/work/o_official diff --check
git -c safe.directory=C:/work/o_official log -10 --oneline
```

Expected: タスク対象ソースに未コミット差分なし。既存の無関係な差分は保存されている。

---

## Production Migration Gate

この計画はマイグレーションファイルの作成とローカル検証までを含む。本番Supabaseへの`089_stripe_accounting_settlement`適用と既存注文のバックフィルは、対象プロジェクト、マイグレーション履歴、件数、Stripe本番モード、想定変更を提示し、ユーザーから明示承認を得た別工程として実施する。
