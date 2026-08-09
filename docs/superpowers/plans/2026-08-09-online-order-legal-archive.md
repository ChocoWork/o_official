# Online Order Legal Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** オンライン注文を添付不要の電子証憑として扱い、改変防止、法定検索、日次CSV・DBバックアップ、月次復元確認を実現する。

**Architecture:** Supabaseの注文テーブルを業務上の正本とし、DBトリガーで不変項目と物理削除を保護する。Next.jsは検索・法定エクスポート・アーカイブ状態APIを提供し、GitHub Actionsが日次のCSV／`pg_dump`保存と月次の`pg_restore`検証を実行する。保存先は共通アダプターを介してSupabase非公開StorageからS3互換Storageへ拡張する。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript、Supabase/PostgreSQL、Jest、React Testing Library、GitHub Actions、`pg_dump`/`pg_restore`、AWS SDK v3 S3 client

## Global Constraints

- 事業年度は1月1日から12月31日とする。
- CSVは当年の全注文・全明細・全変更履歴を毎日出力する。
- DBバックアップは毎日、復元確認は毎月実行する。
- 保存期間は原則7年とし、年度単位の設定で10年へ延長可能にする。
- オンライン注文は証憑ファイルを添付させず、「注文データ保存済み」と表示する。
- 初期保存先はSupabase非公開Storageとし、S3互換外部Storageへの二重保存を設定可能にする。
- 注文・明細の物理削除と注文確定時スナップショットの変更はDBで拒否する。
- 個人情報、接続文字列、認証トークンをレスポンス、監査ログ、GitHub Actionsログへ出さない。
- 本体コードの前に失敗するテストを書き、RED、GREEN、REFACTORの順で進める。
- 既存の未コミットファイルとGraphify生成物を各タスクのコミットへ混入させない。

---

## File Structure

| Path | Responsibility |
|---|---|
| `migrations/081_online_order_legal_archive.sql` | 注文の不変性、削除禁止、変更履歴、アーカイブ実行状態、非公開バケット |
| `src/lib/legal-archive/types.ts` | エクスポート、マニフェスト、状態APIの共有型 |
| `src/lib/legal-archive/cron-auth.ts` | GitHub Actions用Bearer認証の固定時間比較 |
| `src/lib/legal-archive/export-query.ts` | 暦年単位の注文・明細・履歴取得と集計 |
| `src/lib/legal-archive/csv.ts` | 決定的CSV生成と数式インジェクション防止 |
| `src/lib/legal-archive/manifest.ts` | SHA-256、行数、金額合計、前回ハッシュのマニフェスト生成 |
| `src/lib/legal-archive/storage.ts` | 保存アダプターの契約と複製制御 |
| `src/lib/legal-archive/supabase-storage.ts` | Supabase非公開Storage実装 |
| `src/lib/legal-archive/s3-storage.ts` | S3互換Storage実装 |
| `src/app/api/cron/legal-archive/export/route.ts` | 認証済み・ページング対応の法定エクスポートAPI |
| `src/app/api/cron/legal-archive/status/route.ts` | ジョブが保存結果を記録するAPI |
| `src/app/api/admin/legal-archive/status/route.ts` | 管理画面向けの非機密状態API |
| `scripts/legal-archive/run-daily.ts` | CSV、マニフェスト、DBダンプの検証・保存CLI。`tsx`で実行 |
| `scripts/legal-archive/verify-restore.ts` | 復元DB、CSV、マニフェストの整合性検証CLI。`tsx`で実行 |
| `.github/workflows/legal-archive-daily.yml` | 日次アーカイブと手動再実行 |
| `.github/workflows/legal-archive-restore-check.yml` | 月次復元確認と手動再実行 |
| `src/lib/finance/evidence-status.ts` | 注文売上と手入力取引の証憑状態判定 |
| `src/components/CostProfitSection.tsx` | 添付不要表示、未添付集計除外、遅延警告 |
| `src/app/api/admin/orders/route.ts` | 日付・金額・取引先・識別子検索 |
| `docs/ops/legal-archive.md` | 保存、再実行、年度確定、復元、外部Storage切替の運用手順 |

---

### Task 1: Database immutability and append-only history

**Files:**
- Create: `migrations/081_online_order_legal_archive.sql`
- Create: `tests/unit/migrations/081_online_order_legal_archive.test.ts`

**Interfaces:**
- Consumes: `public.orders`, `public.order_items`, `public.stripe_webhook_events`, `public.has_permission(text)`
- Produces: `public.order_revisions`, `public.legal_archive_runs`, deletion guards, immutable-field guards, `legal-archive` private bucket

- [ ] **Step 1: Write the failing migration contract tests**

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('081_online_order_legal_archive migration', () => {
  const sql = readFileSync(
    join(process.cwd(), 'migrations', '081_online_order_legal_archive.sql'),
    'utf8',
  );

  it('blocks physical deletion and immutable order changes', () => {
    expect(sql).toContain('protect_legal_order_delete');
    expect(sql).toContain('protect_legal_order_immutable_fields');
    expect(sql).toContain('protect_legal_order_item_delete');
    expect(sql).toContain("RAISE EXCEPTION 'legal order records cannot be deleted'");
  });

  it('records allowed changes in an append-only history', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.order_revisions');
    expect(sql).toContain('changed_fields text[]');
    expect(sql).toContain('before_data jsonb');
    expect(sql).toContain('after_data jsonb');
    expect(sql).toContain('record_order_revision');
    expect(sql).not.toMatch(/CREATE POLICY[^;]+order_revisions[^;]+FOR (UPDATE|DELETE)/s);
  });

  it('creates archive run state and a private bucket', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.legal_archive_runs');
    expect(sql).toContain("VALUES ('legal-archive', 'legal-archive', false)");
    expect(sql).toContain("status IN ('running', 'completed', 'failed')");
  });
});
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `npx jest tests/unit/migrations/081_online_order_legal_archive.test.ts --runInBand`

Expected: FAIL because `migrations/081_online_order_legal_archive.sql` does not exist.

- [ ] **Step 3: Implement the migration**

Create the migration with these exact protections:

```sql
CREATE TABLE IF NOT EXISTS public.order_revisions (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('status_update', 'refund_update', 'operational_update')),
  before_data jsonb NOT NULL,
  after_data jsonb NOT NULL,
  changed_fields text[] NOT NULL CHECK (cardinality(changed_fields) > 0),
  changed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text NULL CHECK (reason IS NULL OR char_length(reason) <= 500),
  source_event_id text NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.legal_archive_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  archive_date date NOT NULL,
  fiscal_year integer NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 9999),
  run_kind text NOT NULL CHECK (run_kind IN ('daily', 'annual', 'restore_check')),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  storage_targets text[] NOT NULL DEFAULT '{}',
  manifest_path text NULL,
  manifest_sha256 text NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  error_code text NULL,
  UNIQUE (archive_date, run_kind)
);
```

Implement `BEFORE DELETE` triggers on `orders` and `order_items`. Implement `BEFORE UPDATE` guards that compare the immutable columns listed in the design. Implement an `AFTER UPDATE` trigger that records only allowed field changes and derives `operation` from changed fields. Enable RLS; permit `admin.finance.read` to select history and archive status, and do not create update/delete policies for history. Insert the private bucket idempotently.

- [ ] **Step 4: Run migration tests and existing migration regression tests**

Run: `npx jest tests/unit/migrations/081_online_order_legal_archive.test.ts tests/unit/migrations/080_stripe_order_reconciliation.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit the database contract**

```bash
git add migrations/081_online_order_legal_archive.sql tests/unit/migrations/081_online_order_legal_archive.test.ts
git commit -m "feat(finance): protect online order evidence"
```

---

### Task 2: Evidence status model and transaction UI behavior

**Files:**
- Create: `src/lib/finance/evidence-status.ts`
- Create: `tests/unit/lib/finance/evidence-status.test.ts`
- Modify: `src/app/api/admin/kpi/cost-profit/route.ts`
- Modify: `src/components/CostProfitSection.tsx`
- Modify: `tests/unit/components/CostProfitSection.test.tsx`

**Interfaces:**
- Consumes: finance entry `{ source?: 'manual' | 'order'; receipts?: unknown[] }`
- Produces: `resolveEvidenceStatus(entry): 'attached' | 'missing' | 'system_record'`, API field `evidenceStatus`

- [ ] **Step 1: Write failing evidence-status unit tests**

```typescript
import { resolveEvidenceStatus } from '@/lib/finance/evidence-status';

describe('resolveEvidenceStatus', () => {
  it('treats online orders as a saved system record', () => {
    expect(resolveEvidenceStatus({ source: 'order', receipts: [] })).toBe('system_record');
  });

  it('requires evidence for manual entries without receipts', () => {
    expect(resolveEvidenceStatus({ source: 'manual', receipts: [] })).toBe('missing');
  });

  it('marks manual entries with receipts as attached', () => {
    expect(resolveEvidenceStatus({ source: 'manual', receipts: [{ id: 1 }] })).toBe('attached');
  });
});
```

- [ ] **Step 2: Run the unit test and verify RED**

Run: `npx jest tests/unit/lib/finance/evidence-status.test.ts --runInBand`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal classifier**

```typescript
export type EvidenceStatus = 'attached' | 'missing' | 'system_record';

export function resolveEvidenceStatus(entry: {
  source?: 'manual' | 'order';
  receipts?: readonly unknown[];
}): EvidenceStatus {
  if (entry.source === 'order') return 'system_record';
  return (entry.receipts?.length ?? 0) > 0 ? 'attached' : 'missing';
}
```

- [ ] **Step 4: Run the classifier test and verify GREEN**

Run: `npx jest tests/unit/lib/finance/evidence-status.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Add failing component assertions**

Extend the existing online-order test so it expects `注文データ保存済み`, does not find an attachment button for the order, and expects the `証憑未添付` tab count to remain unchanged when an order row is added.

```typescript
expect(await screen.findByText('注文データ保存済み')).toBeInTheDocument();
expect(screen.queryByRole('button', { name: 'オンライン注文に証憑を添付' })).not.toBeInTheDocument();
expect(screen.getByRole('tab', { name: '証憑未添付（1）' })).toBeInTheDocument();
```

- [ ] **Step 6: Run the component test and verify RED**

Run: `npx jest tests/unit/components/CostProfitSection.test.tsx --runInBand -t "orders由来"`

Expected: FAIL because orders still use the empty-receipt path.

- [ ] **Step 7: Wire evidence status through API and UI**

Set `evidenceStatus: 'system_record'` in `mapOrderIncome`. Replace local receipt-length checks used by the missing count, missing filter, table cell, drawer trigger, donut, CSV status, and tax-document counts with `resolveEvidenceStatus`. Render `注文データ保存済み` for `system_record` and omit the attachment drawer action for that state.

- [ ] **Step 8: Run focused and finance regression tests**

Run: `npx jest tests/unit/lib/finance/evidence-status.test.ts tests/unit/components/CostProfitSection.test.tsx tests/unit/api/admin/cost-profit-route.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 9: Commit the evidence-state behavior**

```bash
git add src/lib/finance/evidence-status.ts src/app/api/admin/kpi/cost-profit/route.ts src/components/CostProfitSection.tsx tests/unit/lib/finance/evidence-status.test.ts tests/unit/components/CostProfitSection.test.tsx tests/unit/api/admin/cost-profit-route.test.ts
git commit -m "feat(finance): recognize archived order evidence"
```

---

### Task 3: Statutory order search

**Files:**
- Modify: `src/app/api/admin/orders/route.ts`
- Modify: `tests/integration/api/orders.test.ts`
- Modify: `src/app/admin/page.tsx`
- Create: `tests/unit/api/admin/orders-search-route.test.ts`
- Create: `tests/unit/components/AdminOrderSearch.test.tsx`

**Interfaces:**
- Consumes: query parameters `from`, `to`, `amountMin`, `amountMax`, `counterparty`, `reference`, `status`
- Produces: filtered, paginated order results without changing response row shape

- [ ] **Step 1: Write failing query validation and filtering tests**

Test these cases with the existing Supabase query mock:

```typescript
it.each([
  ['amountMin=-1'],
  ['amountMax=1.5'],
  ['status=unknown'],
])('rejects invalid statutory search %s', async (query) => {
  const response = await GET(new Request(`http://localhost/api/admin/orders?${query}`));
  expect(response.status).toBe(400);
});

it('applies date, amount, counterparty, reference and status filters', async () => {
  await GET(new Request(
    'http://localhost/api/admin/orders?from=2026-01-01&to=2026-12-31&amountMin=1000&amountMax=50000&counterparty=buyer%40example.com&reference=pi_123&status=paid',
  ));
  expect(mockQuery.gte).toHaveBeenCalledWith('total_amount', 1000);
  expect(mockQuery.lte).toHaveBeenCalledWith('total_amount', 50000);
  expect(mockQuery.eq).toHaveBeenCalledWith('status', 'paid');
  expect(mockQuery.or).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the search API test and verify RED**

Run: `npx jest tests/unit/api/admin/orders-search-route.test.ts --runInBand`

Expected: FAIL because the new parameters are ignored.

- [ ] **Step 3: Implement validated filters**

Extend the Zod schema with nonnegative integer amounts, trimmed strings of at most 200 characters, and the order status enum. Apply `.gte/.lte` to `total_amount`, `.eq` to status, and escaped `.or` predicates to name/email and order/payment references. Reject `from > to` and `amountMin > amountMax` with 400.

- [ ] **Step 4: Run API tests and verify GREEN**

Run: `npx jest tests/unit/api/admin/orders-search-route.test.ts tests/integration/api/orders.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Add failing UI test for the search controls**

Add a test that fills `取引先`, `金額（下限）`, `金額（上限）`, `注文・決済ID` and verifies the next `/api/admin/orders` request contains the encoded parameters.

- [ ] **Step 6: Run the UI test and verify RED**

Run: `npx jest tests/unit/components/AdminOrderSearch.test.tsx --runInBand`

Expected: FAIL because the controls do not exist.

- [ ] **Step 7: Add accessible statutory search controls**

Use existing `SearchField`, date picker, numeric inputs, and status controls. Preserve pagination reset behavior. Rename the existing client CSV button to `表示中の注文をCSV出力`.

- [ ] **Step 8: Run UI and API search tests**

Run: `npx jest tests/unit/components/AdminOrderSearch.test.tsx tests/unit/api/admin/orders-search-route.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 9: Commit statutory search**

```bash
git add src/app/api/admin/orders/route.ts src/app/admin/page.tsx tests/integration/api/orders.test.ts tests/unit/api/admin/orders-search-route.test.ts tests/unit/components/AdminOrderSearch.test.tsx
git commit -m "feat(orders): add statutory transaction search"
```

---

### Task 4: Authenticated export query and API

**Files:**
- Create: `src/lib/legal-archive/types.ts`
- Create: `src/lib/legal-archive/cron-auth.ts`
- Create: `src/lib/legal-archive/export-query.ts`
- Create: `src/app/api/cron/legal-archive/export/route.ts`
- Create: `tests/unit/lib/legal-archive/cron-auth.test.ts`
- Create: `tests/unit/lib/legal-archive/export-query.test.ts`
- Create: `tests/unit/api/cron/legal-archive-export-route.test.ts`

**Interfaces:**
- Consumes: `year: number`, `cursor?: string`, service-role Supabase client
- Produces: `LegalArchivePage { orders; orderItems; revisions; nextCursor; totals }`

- [ ] **Step 1: Write failing fixed-time authorization tests**

```typescript
import { authorizeCronBearer } from '@/lib/legal-archive/cron-auth';

it('accepts the exact configured bearer token', () => {
  expect(authorizeCronBearer('Bearer archive-secret', 'archive-secret')).toBe(true);
});

it.each([null, '', 'Bearer wrong', 'Basic archive-secret'])(
  'rejects invalid authorization %p',
  (value) => expect(authorizeCronBearer(value, 'archive-secret')).toBe(false),
);
```

- [ ] **Step 2: Run auth tests and verify RED**

Run: `npx jest tests/unit/lib/legal-archive/cron-auth.test.ts --runInBand`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement fixed-time auth**

Use `timingSafeEqual` over SHA-256 digests so differing input lengths do not create an early-return timing distinction. Return false when the configured secret is empty.

- [ ] **Step 4: Write failing export-query tests**

Test that `fetchLegalArchivePage({ year: 2026, cursor: null, pageSize: 500 })` converts the JST fiscal-year bounds to `2025-12-31T15:00:00.000Z` through the exclusive upper bound `2026-12-31T15:00:00.000Z`, orders by stable IDs, returns orders, items and revisions, and sums gross, refunded and net amounts as integers.

- [ ] **Step 5: Run export-query tests and verify RED**

Run: `npx jest tests/unit/lib/legal-archive/export-query.test.ts --runInBand`

Expected: FAIL because the query function does not exist.

- [ ] **Step 6: Implement typed, cursor-based export queries**

Define exact row types for every exported column. Fetch no more than 500 orders per page, then fetch related items and revisions by order IDs. Sort orders by `(created_at, id)`, items by `(order_id, created_at, id)`, and revisions by `(order_id, changed_at, id)`. Return numeric totals without formatted currency strings.

- [ ] **Step 7: Write failing route tests**

Cover missing/incorrect secret, invalid year, page-size overflow, successful page, service error returning a generic 502, and audit logging with only year/cursor/count metadata.

- [ ] **Step 8: Run route tests and verify RED**

Run: `npx jest tests/unit/api/cron/legal-archive-export-route.test.ts --runInBand`

Expected: FAIL because the route does not exist.

- [ ] **Step 9: Implement the route**

Accept `GET /api/cron/legal-archive/export?year=2026&cursor=<opaque>`. Require `LEGAL_ARCHIVE_CRON_SECRET`, validate with `authorizeCronBearer`, call the query service, and return JSON with `Cache-Control: no-store`. Do not log returned rows.

- [ ] **Step 10: Run all Task 4 tests**

Run: `npx jest tests/unit/lib/legal-archive tests/unit/api/cron/legal-archive-export-route.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 11: Commit the export boundary**

```bash
git add src/lib/legal-archive src/app/api/cron/legal-archive/export/route.ts tests/unit/lib/legal-archive tests/unit/api/cron/legal-archive-export-route.test.ts
git commit -m "feat(archive): expose protected legal export"
```

---

### Task 5: Deterministic CSV and hash-chain manifest

**Files:**
- Create: `src/lib/legal-archive/csv.ts`
- Create: `src/lib/legal-archive/manifest.ts`
- Create: `tests/unit/lib/legal-archive/csv.test.ts`
- Create: `tests/unit/lib/legal-archive/manifest.test.ts`

**Interfaces:**
- Produces: `buildArchiveCsv(pageSet): { ordersCsv; itemsCsv; revisionsCsv; totals }`
- Produces: `buildManifest(input): LegalArchiveManifest`

- [ ] **Step 1: Write failing CSV tests**

```typescript
it('uses fixed headers and CRLF rows', () => {
  const result = buildArchiveCsv(fixture);
  expect(result.ordersCsv).toMatch(/^order_id,order_date,/);
  expect(result.ordersCsv).toContain('\r\n');
});

it.each(['=SUM(1,1)', '+1', '-1+2', '@cmd'])(
  'neutralizes spreadsheet formula value %s',
  (value) => expect(escapeCsvCell(value)).toBe(`'${value}`),
);

it('is byte-for-byte deterministic for the same rows', () => {
  expect(buildArchiveCsv(fixture)).toEqual(buildArchiveCsv(fixture));
});
```

- [ ] **Step 2: Run CSV tests and verify RED**

Run: `npx jest tests/unit/lib/legal-archive/csv.test.ts --runInBand`

Expected: FAIL because the CSV module does not exist.

- [ ] **Step 3: Implement canonical CSV output**

Use explicit header arrays, ISO-8601 UTC timestamps, decimal integer yen fields, RFC 4180 quoting, CRLF separators and a trailing CRLF. Prefix cells beginning with `=`, `+`, `-`, `@`, tab or carriage return with `'` before quoting. Do not add a BOM to legal archive files.

- [ ] **Step 4: Run CSV tests and verify GREEN**

Run: `npx jest tests/unit/lib/legal-archive/csv.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Write failing manifest tests**

Test exact SHA-256 for known content, UTF-8 byte sizes, data-row counts excluding headers, gross/refund/net totals, previous-manifest hash, schema version `1`, fiscal year, Git commit, and storage-target staging verification results sorted by target name.

- [ ] **Step 6: Run manifest tests and verify RED**

Run: `npx jest tests/unit/lib/legal-archive/manifest.test.ts --runInBand`

Expected: FAIL because `buildManifest` does not exist.

- [ ] **Step 7: Implement the manifest**

Use Node `createHash('sha256')`. Serialize the final manifest with stable top-level, file-key, and storage-target ordering plus a trailing newline. Storage results describe successful staging upload and read-back verification; the orchestrator builds the manifest only after every configured target has verified the non-manifest artifacts, then uploads and promotes the identical manifest to each target. Also record target names in `legal_archive_runs` for status queries.

- [ ] **Step 8: Run archive serialization tests**

Run: `npx jest tests/unit/lib/legal-archive/csv.test.ts tests/unit/lib/legal-archive/manifest.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 9: Commit canonical serialization**

```bash
git add src/lib/legal-archive/csv.ts src/lib/legal-archive/manifest.ts tests/unit/lib/legal-archive/csv.test.ts tests/unit/lib/legal-archive/manifest.test.ts
git commit -m "feat(archive): build deterministic legal snapshots"
```

---

### Task 6: Storage adapters and atomic archive upload

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/lib/legal-archive/storage.ts`
- Create: `src/lib/legal-archive/supabase-storage.ts`
- Create: `src/lib/legal-archive/s3-storage.ts`
- Create: `tests/unit/lib/legal-archive/storage.test.ts`
- Create: `tests/unit/lib/legal-archive/supabase-storage.test.ts`
- Create: `tests/unit/lib/legal-archive/s3-storage.test.ts`

**Interfaces:**
- Produces: `ArchiveStorage` with `putTemporary`, `promote`, `exists`, `read`, `removeTemporary`
- Produces: `storeArchiveAtomically({ artifacts, targets, finalPrefix, runId })`

- [ ] **Step 1: Add AWS S3 client and TypeScript CLI dependencies**

Run: `npm install @aws-sdk/client-s3 && npm install --save-dev tsx`

Expected: `package.json` and lockfile contain `@aws-sdk/client-s3` and `tsx`.

- [ ] **Step 2: Write failing adapter-contract tests**

Test that every non-manifest artifact is written below `_staging/<runId>/`, hashes are verified after reading back, the verified target results are passed into the final manifest builder, the identical manifest is staged on every target, final keys are refused when `immutable: true` and already exist, all artifacts are promoted only after every target passes verification, and staging keys are removed on failure.

- [ ] **Step 3: Run storage tests and verify RED**

Run: `npx jest tests/unit/lib/legal-archive/storage.test.ts --runInBand`

Expected: FAIL because the storage contract does not exist.

- [ ] **Step 4: Implement orchestration with dependency injection**

```typescript
export interface ArchiveStorage {
  readonly name: string;
  putTemporary(key: string, body: Uint8Array, contentType: string): Promise<void>;
  promote(temporaryKey: string, finalKey: string, immutable: boolean): Promise<void>;
  exists(key: string): Promise<boolean>;
  read(key: string): Promise<Uint8Array>;
  removeTemporary(prefix: string): Promise<void>;
}
```

The orchestration must validate all SHA-256 hashes before promotion and return per-target results without artifact contents.

- [ ] **Step 5: Run contract tests and verify GREEN**

Run: `npx jest tests/unit/lib/legal-archive/storage.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 6: Write failing Supabase and S3 adapter tests**

Mock only the vendor clients. Verify private bucket paths, `upsert: false` for immutable annual keys, server-side copy/remove for Supabase, `PutObject`, `HeadObject`, `GetObject`, `CopyObject`, `DeleteObject` for S3, and custom S3 endpoint/path-style settings.

- [ ] **Step 7: Implement both adapters**

Supabase uses the service-role client and bucket `legal-archive`. S3 uses `S3Client` with `S3_ARCHIVE_BUCKET`, `S3_ARCHIVE_REGION`, optional `S3_ARCHIVE_ENDPOINT`, and `S3_ARCHIVE_FORCE_PATH_STYLE`. Never log client configuration or object bodies.

- [ ] **Step 8: Run all storage tests**

Run: `npx jest tests/unit/lib/legal-archive/storage.test.ts tests/unit/lib/legal-archive/supabase-storage.test.ts tests/unit/lib/legal-archive/s3-storage.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 9: Commit storage adapters**

```bash
git add package.json package-lock.json src/lib/legal-archive/storage.ts src/lib/legal-archive/supabase-storage.ts src/lib/legal-archive/s3-storage.ts tests/unit/lib/legal-archive/storage.test.ts tests/unit/lib/legal-archive/supabase-storage.test.ts tests/unit/lib/legal-archive/s3-storage.test.ts
git commit -m "feat(archive): add private storage adapters"
```

---

### Task 7: Daily archive CLI, run-status API and workflow

**Files:**
- Create: `scripts/legal-archive/run-daily.ts`
- Create: `src/app/api/cron/legal-archive/status/route.ts`
- Create: `tests/unit/scripts/legal-archive/run-daily.test.ts`
- Create: `tests/unit/api/cron/legal-archive-status-route.test.ts`
- Create: `.github/workflows/legal-archive-daily.yml`
- Create: `tests/unit/workflows/legal-archive-daily.test.ts`
- Modify: `package.json`
- Modify: `.env.example`

**Interfaces:**
- Consumes: export API pages, `database.dump.gz`, storage configuration
- Produces: `legal-archive/YYYY/daily/YYYY-MM-DD/*`, completed/failed `legal_archive_runs`

- [ ] **Step 1: Write failing CLI orchestration tests**

Test pagination until `nextCursor` is null, fiscal year derived in Asia/Tokyo, deterministic CSV creation, previous manifest lookup, required `database.dump.gz`, hash verification before upload, and failure exit code without printing API rows.

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `npx jest tests/unit/scripts/legal-archive/run-daily.test.ts --runInBand`

Expected: FAIL because the CLI module does not exist.

- [ ] **Step 3: Implement the daily CLI**

Expose a testable `runDailyArchive(dependencies)` function and keep `process.exitCode` handling in a thin entry point. Execute it with `tsx` so it imports the TypeScript CSV, manifest and storage modules without duplicating their logic. Require `APP_BASE_URL`, `LEGAL_ARCHIVE_CRON_SECRET`, `LEGAL_ARCHIVE_DATABASE_DUMP`, Supabase credentials, and optional S3 variables. Upload `orders.csv`, `order_items.csv`, `order_revisions.csv`, `database.dump.gz`, then `manifest.json` last.

- [ ] **Step 4: Run CLI tests and verify GREEN**

Run: `npx jest tests/unit/scripts/legal-archive/run-daily.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Write failing status-route tests**

Verify Bearer authentication, allowed state transitions `running -> completed|failed`, rejection of completed-to-running regressions, generic errors, and audit metadata limited to run ID, year, target names and error code.

- [ ] **Step 6: Implement the status route**

Accept POST JSON validated by Zod. Upsert the unique `(archive_date, run_kind)` row only for a new running attempt; update the same row to completed or failed. Store manifest path/hash only on completed runs.

- [ ] **Step 7: Write failing workflow contract test**

Read the YAML and assert daily JST scheduling, `workflow_dispatch`, PostgreSQL client setup, `pg_dump --format=custom`, gzip, SHA-256-safe CLI invocation, required secret validation, no artifact upload, and a failure status callback guarded with `if: failure()`.

- [ ] **Step 8: Implement the daily workflow**

Schedule at `30 17 * * *` UTC, which is 02:30 JST the next day. Use a masked `SUPABASE_DB_URL`, create the dump under `$RUNNER_TEMP`, invoke `npm run archive:legal:daily`, and remove temporary files in an `if: always()` step. Add `archive:legal:daily` to `package.json`.

- [ ] **Step 9: Run Task 7 tests**

Run: `npx jest tests/unit/scripts/legal-archive/run-daily.test.ts tests/unit/api/cron/legal-archive-status-route.test.ts tests/unit/workflows/legal-archive-daily.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 10: Commit the daily pipeline**

```bash
git add scripts/legal-archive/run-daily.ts src/app/api/cron/legal-archive/status/route.ts .github/workflows/legal-archive-daily.yml tests/unit/scripts/legal-archive/run-daily.test.ts tests/unit/api/cron/legal-archive-status-route.test.ts tests/unit/workflows/legal-archive-daily.test.ts package.json .env.example
git commit -m "feat(archive): automate daily legal snapshots"
```

---

### Task 8: Monthly restore verification

**Files:**
- Create: `scripts/legal-archive/verify-restore.ts`
- Create: `tests/unit/scripts/legal-archive/verify-restore.test.ts`
- Create: `.github/workflows/legal-archive-restore-check.yml`
- Create: `tests/unit/workflows/legal-archive-restore-check.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: restored temporary PostgreSQL, latest manifest and CSV artifacts
- Produces: restore-check result posted to `legal_archive_runs`

- [ ] **Step 1: Write failing restore-verifier tests**

Inject a `pg` query client and artifact reader. Verify checks for required tables, foreign keys, three protection/history triggers, orphan items, order/item/revision counts, gross/refund/net totals, CSV SHA-256, CSV row counts, and sanitized failure codes.

- [ ] **Step 2: Run verifier tests and verify RED**

Run: `npx jest tests/unit/scripts/legal-archive/verify-restore.test.ts --runInBand`

Expected: FAIL because the verifier does not exist.

- [ ] **Step 3: Implement restore verification**

Return `{ ok: true, checks }` only when every check matches. On mismatch return a stable code such as `ORDER_COUNT_MISMATCH`, not row contents. Never select shipping fields during verification.

- [ ] **Step 4: Run verifier tests and verify GREEN**

Run: `npx jest tests/unit/scripts/legal-archive/verify-restore.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Write failing monthly-workflow contract tests**

Assert schedule `0 18 1 * *`, `workflow_dispatch`, a PostgreSQL service container, archive download to `$RUNNER_TEMP`, `pg_restore --exit-on-error`, verifier execution, status callback, and unconditional cleanup.

- [ ] **Step 6: Implement the monthly workflow**

Run at 03:00 JST on the second day of each month. Restore into the job-local PostgreSQL service, run `npm run archive:legal:verify-restore`, post success/failure status, and remove downloaded artifacts. Do not expose the temporary database port outside the runner.

- [ ] **Step 7: Run restore and workflow tests**

Run: `npx jest tests/unit/scripts/legal-archive/verify-restore.test.ts tests/unit/workflows/legal-archive-restore-check.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 8: Commit monthly recovery proof**

```bash
git add scripts/legal-archive/verify-restore.ts .github/workflows/legal-archive-restore-check.yml tests/unit/scripts/legal-archive/verify-restore.test.ts tests/unit/workflows/legal-archive-restore-check.test.ts package.json
git commit -m "feat(archive): verify monthly database recovery"
```

---

### Task 9: Archive health API and admin warning

**Files:**
- Create: `src/app/api/admin/legal-archive/status/route.ts`
- Create: `tests/unit/api/admin/legal-archive-status-route.test.ts`
- Modify: `src/components/CostProfitSection.tsx`
- Modify: `tests/unit/components/CostProfitSection.test.tsx`

**Interfaces:**
- Produces: `{ fiscalYear; lastArchiveAt; lastRestoreCheckAt; storageTargets; externalStorageConfigured; delayed }`

- [ ] **Step 1: Write failing admin status API tests**

Verify `admin.finance.read`, current-year lookup, `delayed = true` when no completed daily run exists or the latest completion is more than 24 hours old, latest successful restore time, target names only, and `Cache-Control: no-store`.

- [ ] **Step 2: Run API tests and verify RED**

Run: `npx jest tests/unit/api/admin/legal-archive-status-route.test.ts --runInBand`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement the status API**

Use the authenticated Supabase client and permission helper. Calculate delay server-side against the current instant. Return no paths, hashes, errors, user identifiers or credentials.

- [ ] **Step 4: Run API tests and verify GREEN**

Run: `npx jest tests/unit/api/admin/legal-archive-status-route.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Write failing UI health tests**

Test three states: completed within 24 hours shows `注文データ保存済み`; absent/stale run shows `アーカイブ要確認`; S3 is not configured shows `外部保存先 未設定` without changing evidence sufficiency.

- [ ] **Step 6: Run component tests and verify RED**

Run: `npx jest tests/unit/components/CostProfitSection.test.tsx --runInBand -t "アーカイブ"`

Expected: FAIL because archive health is not fetched or displayed.

- [ ] **Step 7: Add archive status fetch and accessible warnings**

Fetch the status with the existing authenticated client helper when transaction management loads. Render the warning with `role="status"`; do not block the finance table if the status endpoint fails. Label the pre-readiness state `保存要件整備中` until at least one completed daily archive and one completed restore check exist.

- [ ] **Step 8: Run UI regression tests**

Run: `npx jest tests/unit/components/CostProfitSection.test.tsx tests/unit/api/admin/legal-archive-status-route.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 9: Commit archive health presentation**

```bash
git add src/app/api/admin/legal-archive/status/route.ts src/components/CostProfitSection.tsx tests/unit/api/admin/legal-archive-status-route.test.ts tests/unit/components/CostProfitSection.test.tsx
git commit -m "feat(finance): show legal archive health"
```

---

### Task 10: Annual finalization, retention and operations documentation

**Files:**
- Modify: `scripts/legal-archive/run-daily.ts`
- Modify: `tests/unit/scripts/legal-archive/run-daily.test.ts`
- Create: `docs/ops/legal-archive.md`
- Modify: `.env.example`

**Interfaces:**
- Produces: immutable `legal-archive/YYYY/annual/final/*` and documented recovery procedure

- [ ] **Step 1: Write failing annual-finalization tests**

With a JST run date in January, verify the CLI locates the previous year's latest completed daily manifest, copies the complete artifact set to `annual/<year>/final/`, refuses an existing final prefix, and records retention years as 7 unless `LEGAL_ARCHIVE_RETENTION_YEARS_<YEAR>=10` is configured.

- [ ] **Step 2: Run annual tests and verify RED**

Run: `npx jest tests/unit/scripts/legal-archive/run-daily.test.ts --runInBand -t "annual"`

Expected: FAIL because annual finalization is absent.

- [ ] **Step 3: Implement immutable annual finalization**

Run finalization after the current-year daily archive succeeds. Copy, do not regenerate, the prior year's final daily artifacts. Set `immutable: true` so any existing destination fails the run. Record the annual run separately in `legal_archive_runs`.

- [ ] **Step 4: Run daily CLI regression tests**

Run: `npx jest tests/unit/scripts/legal-archive/run-daily.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Write the operations runbook**

Document:

- required GitHub secrets and environment variables;
- Supabase bucket privacy verification;
- enabling S3-compatible dual writes;
- manual daily rerun and idempotency rules;
- monthly restore-check interpretation;
- annual finalization and 7/10-year retention configuration;
- credential rotation;
- response to `アーカイブ要確認`;
- recovery from partial staging objects;
- prohibition on using GitHub artifacts as the legal archive;
- quarterly review of job permissions and monthly restore evidence.

- [ ] **Step 6: Validate documentation and environment examples**

Run: `npm run validate-docs`

Expected: PASS.

- [ ] **Step 7: Commit finalization and operations**

```bash
git add scripts/legal-archive/run-daily.ts tests/unit/scripts/legal-archive/run-daily.test.ts docs/ops/legal-archive.md .env.example
git commit -m "docs(archive): define retention and recovery operations"
```

---

### Task 11: Full verification, security audit and graph refresh

**Files:**
- Modify only if a verification failure requires a scoped correction.
- Generated: `graphify-out/**`

**Interfaces:**
- Consumes: all prior tasks
- Produces: verified implementation and current code graph

- [ ] **Step 1: Run focused legal-archive tests**

Run: `npx jest tests/unit/migrations/081_online_order_legal_archive.test.ts tests/unit/lib/legal-archive tests/unit/api/cron/legal-archive-export-route.test.ts tests/unit/api/cron/legal-archive-status-route.test.ts tests/unit/api/admin/legal-archive-status-route.test.ts tests/unit/scripts/legal-archive tests/unit/workflows tests/unit/lib/finance/evidence-status.test.ts --runInBand`

Expected: PASS with no warnings.

- [ ] **Step 2: Run finance and order regression tests**

Run: `npx jest tests/unit/components/CostProfitSection.test.tsx tests/unit/api/admin/cost-profit-route.test.ts tests/integration/api/orders.test.ts tests/unit/api/admin/orders-search-route.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 3: Run static verification**

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run lint`

Expected: exit 0 with no new errors.

- [ ] **Step 4: Run the production build**

Run: `npm run build`

Expected: exit 0.

- [ ] **Step 5: Run relevant E2E tests on port 3000**

Create `e2e/FR-ADMIN-047-online-order-evidence.spec.ts` before the implementation task if the existing unit coverage cannot exercise the integrated finance response. The scenario must mock one `source: 'order'` income and one receipt-less manual expense, open transaction management, assert `注文データ保存済み`, assert the online order has no attachment control, and assert `証憑未添付（1）`. Run it with the existing receipt and transaction-workbench scenarios according to the repository `test-e2e` skill.

Expected: all selected Chromium tests pass and the development server remains running.

- [ ] **Step 6: Run the Supabase and application security audits**

Run the repository security-check wrapper and inspect migration RLS, SECURITY DEFINER search paths, secret handling, CSV injection controls, workflow permissions, and dependency audit output.

Expected: no unresolved high or critical finding in the changed scope.

- [ ] **Step 7: Refresh Graphify**

Run: `graphify update .`

Expected: the graph includes the new legal-archive modules, routes, workflows and migration.

- [ ] **Step 8: Review the final diff**

Run: `git -c safe.directory=C:/work/o_official status --short` and `git -c safe.directory=C:/work/o_official diff --check HEAD~10..HEAD`.

Expected: no whitespace errors; unrelated pre-existing changes remain uncommitted and are not included in feature commits.

- [ ] **Step 9: Commit verification-only corrections if present**

If verification required a correction, return to the task that owns the affected file, add a failing regression test, apply the minimal correction, rerun that task's tests, and commit only that task's explicit file list with `fix(archive): resolve verification findings`. If verification required no correction, mark this step complete without a commit.
