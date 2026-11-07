/** @jest-environment node */
/**
 * Accounting plan 1 S1 (FREQ-553-AC-04): after the table privileges are tightened, the real accounting routes still
 * work, because they read and write through service_role only. The route functions are called directly with a real
 * supabase-js client on the local Supabase service_role (the same shape as refund_postgrest.integration.test.ts).
 * Only the permission check, CSRF, server-only and next/server are replaced; logAudit and Storage are real.
 *
 * This suite COMMITS rows (expense, receipt, audit log, the stored receipt object): PostgREST writes cannot be rolled
 * back from here. Run it on its own jest invocation with a db reset before and after (controller only):
 *   npm run db:reset
 *   eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
 *   ACCOUNTING_COMMIT_SUITE=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
 *     npx jest tests/integration/db/accounting_p1_routes_after_grants --runInBand
 *   npm run db:reset
 * Without ACCOUNTING_COMMIT_SUITE=1 or the two LOCAL_SUPABASE_* values it skips; a non-localhost URL fails.
 */
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      body,
      json: async () => body,
      cookies: { set: () => undefined },
    }),
  },
}));
let mockActorId = '';
jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn(async () => ({
    ok: true, userId: mockActorId, role: 'admin', actorEmail: 'accounting-s1@example.test', permissions: new Set(),
  })),
}));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn(async () => undefined) }));
let mockRouteClient: unknown;
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(async () => mockRouteClient) }));
jest.mock('server-only', () => ({}), { virtual: true });

import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { GET as getProductCosts } from '@/app/api/admin/accounting/product-costs/route';
import { GET as getCostProfit, POST as postCostProfit } from '@/app/api/admin/kpi/cost-profit/route';
import { POST as postReceipt } from '@/app/api/admin/kpi/cost-profit/receipt/route';
import { describeLocalDb, isLocalDatabase } from './helpers/local-db';
import { japanToday } from './helpers/accounting-fixtures';

jest.setTimeout(60000);

const LOCAL_API_URL = process.env.LOCAL_SUPABASE_URL;
const LOCAL_SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const COMMIT_SUITE = process.env.ACCOUNTING_COMMIT_SUITE === '1';
type RouteResponse = { status: number; body: any };

describeLocalDb('S1 routes after grants: controller only, commits rows', (db) => {
  if (!COMMIT_SUITE || !LOCAL_API_URL || !LOCAL_SERVICE_ROLE_KEY) {
    test.skip('ACCOUNTING_COMMIT_SUITE=1・LOCAL_SUPABASE_URL・LOCAL_SUPABASE_SERVICE_ROLE_KEY 未設定のためスキップ', () => {});
    return;
  }
  if (!isLocalDatabase(LOCAL_API_URL)) {
    test('ローカルの API 以外では実行しない', () => {
      throw new Error('PostgREST を通って書いた行は消せないので、localhost 以外の LOCAL_SUPABASE_URL では実行しない');
    });
    return;
  }
  const apiUrl = LOCAL_API_URL;
  const serviceRoleKey = LOCAL_SERVICE_ROLE_KEY;
  const today = japanToday();
  const year = Number(today.slice(0, 4));
  const season = `${year}SS`;
  const item = `acc s1 route ${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    mockRouteClient = createClient(apiUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    mockActorId = randomUUID();
    await db().query(
      "insert into auth.users (id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values ($1, jsonb_build_object('role', 'admin'), '{}', now(), now())",
      [mockActorId],
    );
    // The routes only work after S1 if the tables really are closed to anon and authenticated.
    const closed = (await db().query(
      "select has_table_privilege('authenticated', 'public.admin_finance_expenses', 'SELECT') as authenticated, has_table_privilege('anon', 'public.admin_finance_receipts', 'SELECT') as anon",
    )).rows[0];
    expect(closed).toEqual({ authenticated: false, anon: false });
  });

  test('FREQ-553-AC-04: 表の権限を締めた後も、route の関数を直接呼ぶ結合の試験（cost-profit の GET と expense.create、receipt の POST、product-costs の GET）が手元の DB の service_role で200と行を返す', async () => {
    const created = await postCostProfit(new Request('http://localhost/api/admin/kpi/cost-profit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'expense.create',
        fiscalYear: year,
        expense: { entryType: 'expense', date: today, category: '消耗品費', item, amount: 1200, paymentMethod: '銀行', seasonTag: season },
      }),
    })) as unknown as RouteResponse;
    expect({ status: created.status, success: created.body?.success }).toEqual({ status: 200, success: true });
    const expense = (await db().query(
      'select id, fiscal_year, season_key, amount from public.admin_finance_expenses where item_name = $1 and deleted_at is null', [item])).rows;
    expect(expense).toEqual([{ id: expect.anything(), fiscal_year: year, season_key: season, amount: '1200' }]);
    const entryId = Number(expense[0].id);
    expect((await db().query("select operation from public.admin_finance_entry_revisions where entry_id = $1 order by id", [entryId])).rows)
      .toEqual([{ operation: 'insert' }]);
    // Since S4 (FREQ-556-AC-01/02) the same write also leaves the sole period of today and one journal entry
    // (debit 6120 consumables, credit 1040 bank) recorded by the actor; the route's write shape is unchanged.
    expect((await db().query(
      `select e.dedupe_key, p.business_type, to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, e.recorded_by,
         (select jsonb_agg(jsonb_build_array(l.account_code, l.debit, l.credit) order by l.line_no)
          from public.accounting_journal_lines l where l.entry_id = e.id) as lines
       from public.accounting_journal_entries e join public.accounting_periods p on p.id = e.period_id
       where e.source_table = 'admin_finance_expenses' and e.source_id = $1::text`, [entryId])).rows)
      .toEqual([{ dedupe_key: `manual_entry:${entryId}:0`, business_type: 'soleProprietor', entry_date: today, recorded_by: mockActorId,
        lines: [['6120', 1200, 0], ['1040', 0, 1200]] }]);

    const form = new FormData();
    form.set('entryId', String(entryId));
    form.set('evidenceKind', 'paper');
    form.set('paperOriginalKept', 'true');
    form.set('file', new File(['%PDF-1.4 accounting s1'], 'receipt.pdf', { type: 'application/pdf' }));
    // tests/setupRequestPolyfill.js replaces the global Request with node-fetch's, which has no formData(). Next.js
    // hands the route a WHATWG Request, so the body is encoded as real multipart and parsed back by Node's own
    // (undici) Response, whose class comes from a data: URL fetch (no network).
    const NativeResponse = (await fetch('data:,')).constructor as typeof Response;
    const encoded = new NativeResponse(form);
    const multipart = { type: encoded.headers.get('content-type') ?? '', bytes: await encoded.arrayBuffer() };
    const receiptRequest = Object.assign(new Request('http://localhost/api/admin/kpi/cost-profit/receipt', {
      method: 'POST', headers: { 'user-agent': 'accounting-s1-test', 'content-type': multipart.type },
    }), { formData: () => new NativeResponse(multipart.bytes, { headers: { 'content-type': multipart.type } }).formData() });
    const uploaded = await postReceipt(receiptRequest) as unknown as RouteResponse;
    expect(uploaded.status).toBe(200);
    const storagePath = uploaded.body.data.storagePath as string;
    expect((await db().query(
      'select evidence_kind, paper_original_kept, uploaded_by from public.admin_finance_receipts where entry_id = $1', [entryId])).rows)
      .toEqual([{ evidence_kind: 'paper', paper_original_kept: true, uploaded_by: mockActorId }]);
    expect((await db().query("select bucket_id from storage.objects where bucket_id = 'finance-receipts' and name = $1", [storagePath])).rows)
      .toEqual([{ bucket_id: 'finance-receipts' }]);
    expect(Number((await db().query(
      "select count(*) as n from public.audit_logs where action = 'admin.finance.receipt.attach' and resource_id = $1 and outcome = 'success'",
      [String(uploaded.body.data.id)])).rows[0].n)).toBe(1);

    const ledger = await getCostProfit(new Request(`http://localhost/api/admin/kpi/cost-profit?year=${year}`)) as unknown as RouteResponse;
    expect(ledger.status).toBe(200);
    const listed = (ledger.body.data.expenses as Array<{ id: number; item: string; receipts: Array<Record<string, unknown>> }>)
      .find((row) => row.id === entryId);
    expect(listed?.item).toBe(item);
    expect(listed?.receipts.map((r) => [r.storagePath, r.evidenceKind, r.paperOriginalKept])).toEqual([[storagePath, 'paper', true]]);

    const costs = await getProductCosts(new Request(`http://localhost/api/admin/accounting/product-costs?season=${season}`)) as unknown as RouteResponse;
    expect(costs.status).toBe(200);
    expect((costs.body.data.expenses as Array<{ id: number; amount: number }>).filter((row) => row.id === entryId).map((row) => row.amount))
      .toEqual([1200]);
  });
});
