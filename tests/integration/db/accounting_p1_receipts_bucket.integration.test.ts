/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';
import { adminTableTools } from './helpers/admin-table-grants';
import { accountingS1Section, japanToday } from './helpers/accounting-fixtures';

// Accounting plan 1 S1 (FREQ-559 AC-01/02): the finance-receipts bucket lives in the migration with the values the
// receipt route enforces, and every receipt carries an evidence kind. DB suites are controller only (local DB).
const body = accountingS1Section('BODY');
const MIME_TYPES = ['application/pdf', 'image/heic', 'image/jpeg', 'image/png', 'image/webp'];
const receiptRoute = fs.readFileSync(path.join(process.cwd(), 'src/app/api/admin/kpi/cost-profit/receipt/route.ts'), 'utf8');

describe('S1 finance-receipts source contract (no DB)', () => {
  test('FREQ-559-AC-01: 移行はfinance-receiptsを非公開・20MiB・5形式でDO UPDATEに入れ、受け取りのrouteと同じ値を持つ', () => {
    expect(body).toContain("VALUES ('finance-receipts', 'finance-receipts', false, 20971520,\n"
      + "  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'])");
    expect(body).toMatch(/ON CONFLICT \(id\) DO UPDATE SET\n {2}public = false,\n {2}file_size_limit = 20971520,\n {2}allowed_mime_types = ARRAY\['application\/pdf', 'image\/jpeg', 'image\/png', 'image\/webp', 'image\/heic'\];/);
    expect(body).not.toMatch(/DO NOTHING/);
    // The route's own limits (receipt/route.ts RECEIPT_BUCKET, MAX_FILE_SIZE, ALLOWED_MIME_TYPES).
    expect(receiptRoute).toContain("const RECEIPT_BUCKET = 'finance-receipts';");
    expect(receiptRoute).toContain('const MAX_FILE_SIZE = 20 * 1024 * 1024;');
    expect(20 * 1024 * 1024).toBe(20971520);
    const routeTypes = [...(receiptRoute.match(/const ALLOWED_MIME_TYPES = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(routeTypes.sort()).toEqual(MIME_TYPES);
  });

  test('FREQ-559-AC-02: 移行は証憑に種類の列（既定は未確認）と紙だけが原本の有無を持つ検査を足す', () => {
    expect(body).toContain("ADD COLUMN evidence_kind text NOT NULL DEFAULT 'unconfirmed',");
    expect(body).toContain('ADD COLUMN paper_original_kept boolean NULL,');
    expect(body).toContain("CHECK (evidence_kind IN ('electronic', 'paper', 'unconfirmed')),");
    expect(body).toContain("CHECK (paper_original_kept IS NULL OR evidence_kind = 'paper');");
    expect(body).not.toMatch(/UPDATE public\.admin_finance_receipts/i);
  });
});

type Outcome = { rows: unknown[]; rowCount: number } | { code: string };

describeLocalDb('S1 finance-receipts bucket and evidence kind: controller only', (db) => {
  const tools = adminTableTools(db);
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function attempt(role: 'anon' | 'authenticated', claims: Record<string, unknown> | null, sql: string, params: unknown[] = []): Promise<Outcome> {
    await db().query('savepoint acc_s1_bucket');
    try {
      await db().query(`set local role ${role}`);
      await db().query("select set_config('request.jwt.claims', $1, true)", [claims ? JSON.stringify(claims) : '']);
      const result = await db().query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount };
    } catch (caught) {
      return { code: (caught as { code?: string }).code ?? 'unknown' };
    } finally {
      await db().query('rollback to savepoint acc_s1_bucket');
      await db().query('release savepoint acc_s1_bucket');
    }
  }
  // Refused (privilege) or no row visible both count as "cannot touch".
  const untouched = (outcome: Outcome) => ('code' in outcome ? outcome.code === '42501' : outcome.rowCount === 0) ? 'untouched' : outcome;

  test('FREQ-559-AC-01: finance-receiptsは非公開で20MiB・5形式・方針なし', async () => {
    const bucket = (await db().query(
      `select id, name, public, file_size_limit::text as file_size_limit, allowed_mime_types from storage.buckets where id = 'finance-receipts'`)).rows;
    expect(bucket).toHaveLength(1);
    const { allowed_mime_types: mimeTypes, ...rest } = bucket[0];
    expect(rest).toEqual({ id: 'finance-receipts', name: 'finance-receipts', public: false, file_size_limit: '20971520' });
    expect([...mimeTypes].sort()).toEqual(MIME_TYPES);
    expect((await db().query(
      `select count(*)::int as n from pg_policies where schemaname = 'storage' and tablename = 'objects'
         and (coalesce(qual, '') like '%finance-receipts%' or coalesce(with_check, '') like '%finance-receipts%')`)).rows[0].n).toBe(0);

    // Neither anon nor a signed-in administrator reaches a stored receipt through storage.objects.
    const name = `2026/1/${randomUUID()}.pdf`;
    const object = (await db().query(
      `insert into storage.objects (bucket_id, name, metadata) values ('finance-receipts', $1, jsonb_build_object('mimetype', 'application/pdf', 'size', 1))
       returning id`, [name])).rows[0];
    const admin = await tools.insertAdmin();
    for (const [role, claims] of [['anon', null], ['authenticated', admin]] as const) {
      expect({ role, read: untouched(await attempt(role, claims, 'select id from storage.objects where id = $1', [object.id])) })
        .toEqual({ role, read: 'untouched' });
      expect({ role, update: untouched(await attempt(role, claims, "update storage.objects set name = name || '.x' where id = $1 returning id", [object.id])) })
        .toEqual({ role, update: 'untouched' });
      expect({ role, delete: untouched(await attempt(role, claims, 'delete from storage.objects where id = $1 returning id', [object.id])) })
        .toEqual({ role, delete: 'untouched' });
      expect({ role, insert: untouched(await attempt(role, claims,
        "insert into storage.objects (bucket_id, name) values ('finance-receipts', $1) returning id", [`2026/1/${randomUUID()}.pdf`])) })
        .toEqual({ role, insert: 'untouched' });
    }
  });

  test('FREQ-559-AC-02: 証憑の種類の列は3値だけを受け紙以外はpaper_original_keptがNULL', async () => {
    const entry = (await db().query(
      "insert into public.admin_finance_expenses(expense_date, category, item_name, amount, payment_method) values ($1::date, 'cat', 'item', 100, 'bank') returning id",
      [japanToday()])).rows[0];
    async function insertReceipt(columns: Record<string, unknown>): Promise<Record<string, unknown> | { code: string }> {
      await db().query('savepoint acc_s1_receipt');
      try {
        const names = Object.keys(columns);
        const values = Object.values(columns);
        const extra = names.map((n) => `, ${n}`).join('');
        const placeholders = names.map((_, i) => `, $${i + 3}`).join('');
        const row = (await db().query(
          `insert into public.admin_finance_receipts(entry_id, storage_path, file_name, mime_type, file_size${extra})
           values ($1, $2, 'a.pdf', 'application/pdf', 1${placeholders}) returning evidence_kind, paper_original_kept`,
          [entry.id, `acc-s1/${randomUUID()}.pdf`, ...values])).rows[0];
        await db().query('set constraints all immediate');
        await db().query('release savepoint acc_s1_receipt');
        return row;
      } catch (caught) {
        await db().query('rollback to savepoint acc_s1_receipt');
        await db().query('release savepoint acc_s1_receipt');
        return { code: (caught as { code?: string }).code ?? 'unknown' };
      }
    }

    // An existing receipt (no kind sent) reads as unconfirmed with no original flag.
    expect(await insertReceipt({})).toEqual({ evidence_kind: 'unconfirmed', paper_original_kept: null });
    expect(await insertReceipt({ evidence_kind: 'electronic' })).toEqual({ evidence_kind: 'electronic', paper_original_kept: null });
    expect(await insertReceipt({ evidence_kind: 'paper', paper_original_kept: true })).toEqual({ evidence_kind: 'paper', paper_original_kept: true });
    expect(await insertReceipt({ evidence_kind: 'paper', paper_original_kept: false })).toEqual({ evidence_kind: 'paper', paper_original_kept: false });
    const invalid: Array<Record<string, unknown>> = [
      { evidence_kind: 'scan' },
      { evidence_kind: null },
      { evidence_kind: 'electronic', paper_original_kept: true },
      { evidence_kind: 'unconfirmed', paper_original_kept: false },
      { paper_original_kept: true },
    ];
    for (const columns of invalid) {
      const outcome = await insertReceipt(columns);
      const expected = columns.evidence_kind === null ? '23502' : '23514';
      expect({ columns, outcome }).toEqual({ columns, outcome: { code: expected } });
    }
    const column = (await db().query(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'admin_finance_receipts' and column_name = any($1::text[]) order by column_name`,
      [['evidence_kind', 'paper_original_kept']])).rows;
    expect(column).toEqual([
      { data_type: 'text', is_nullable: 'NO', column_default: "'unconfirmed'::text" },
      { data_type: 'boolean', is_nullable: 'YES', column_default: null },
    ]);
  });
});
