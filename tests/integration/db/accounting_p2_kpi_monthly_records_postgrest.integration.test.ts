/** @jest-environment node */
/**
 * Accounting plan 2 Task 8 (FREQ-573-AC-01, AC-02): the monthly KPI records over the real PostgREST of the local Supabase. service_role
 * writes through the two functions and reads through the reader (and can SELECT the table, not write it); anon and authenticated are
 * refused (permission denied, 42501) at the table and at every function.
 *
 * This suite COMMITS rows (PostgREST writes cannot be rolled back from here). Run it on its own jest invocation with a db reset before
 * and after (controller only):
 *   npm run db:reset
 *   eval "$(npx supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET)=')"
 *   ACCOUNTING_COMMIT_SUITE=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_ANON_KEY="$ANON_KEY" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
 *   LOCAL_SUPABASE_JWT_SECRET="$JWT_SECRET" \
 *     npx jest tests/integration/db/accounting_p2_kpi_monthly_records_postgrest --runInBand
 *   npm run db:reset
 * Without ACCOUNTING_COMMIT_SUITE=1 or the four LOCAL_SUPABASE_* values it skips; a non-localhost URL fails.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { connectLocalDb, describeLocalDb, isLocalDatabase } from './helpers/local-db';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';

jest.setTimeout(60000);

const LOCAL_API_URL = process.env.LOCAL_SUPABASE_URL;
const LOCAL_ANON_KEY = process.env.LOCAL_SUPABASE_ANON_KEY;
const LOCAL_SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const LOCAL_JWT_SECRET = process.env.LOCAL_SUPABASE_JWT_SECRET;
const COMMIT_SUITE = process.env.ACCOUNTING_COMMIT_SUITE === '1';

describeLocalDb('S13 monthly KPI records over PostgREST: controller only, commits rows', () => {
  if (!COMMIT_SUITE || !LOCAL_API_URL || !LOCAL_ANON_KEY || !LOCAL_SERVICE_ROLE_KEY || !LOCAL_JWT_SECRET) {
    test.skip('ACCOUNTING_COMMIT_SUITE=1・LOCAL_SUPABASE_URL・LOCAL_SUPABASE_ANON_KEY・LOCAL_SUPABASE_SERVICE_ROLE_KEY・LOCAL_SUPABASE_JWT_SECRET 未設定のためスキップ', () => {});
    return;
  }
  if (!isLocalDatabase(LOCAL_API_URL)) {
    test('ローカルの API 以外では実行しない', () => {
      throw new Error('PostgREST を通って書いた行は消せないので、localhost 以外の LOCAL_SUPABASE_URL では実行しない');
    });
    return;
  }
  const apiUrl = LOCAL_API_URL;
  const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
  let service: SupabaseClient;
  let anon: SupabaseClient;
  let authenticated: SupabaseClient;
  let adminId: string;

  const base64url = (value: string | Buffer) => (typeof value === 'string' ? Buffer.from(value) : value).toString('base64url');
  function memberToken(secret: string): string {
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ aud: 'authenticated', role: 'authenticated', sub: randomUUID(), iss: 'supabase-demo',
      exp: Math.floor(Date.now() / 1000) + 600 }));
    return `${header}.${payload}.${base64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest())}`;
  }

  beforeAll(async () => {
    service = createClient(apiUrl, LOCAL_SERVICE_ROLE_KEY as string, options);
    anon = createClient(apiUrl, LOCAL_ANON_KEY as string, options);
    authenticated = createClient(apiUrl, LOCAL_ANON_KEY as string, {
      ...options, global: { headers: { Authorization: `Bearer ${memberToken(LOCAL_JWT_SECRET as string)}` } } });
    // An owner (the admin role holds admin.orders.read) committed for the writer.
    const client = await connectLocalDb();
    try { adminId = await insertAccountingAdmin(client); } finally { await client.end(); }
  });

  const row = { month_key: '2026-07', metric_key: 'src:reach', value: 10 };

  test('FREQ-573-AC-02: service_role は書き口で保存・削除し、読み口で月の値を読む（numeric は文字列で届く）', async () => {
    const saved = await service.rpc('admin_set_kpi_monthly_records', { _actor_id: adminId, _updates: [row, { ...row, metric_key: 'kpi:sales', value: 123.4 }] });
    expect([saved.error, saved.data]).toEqual([null, 2]);
    const listed = await service.rpc('list_kpi_monthly_records', { _month_keys: ['2026-07', '2026-08'] });
    expect(listed.error).toBeNull();
    expect((listed.data as Array<{ month_key: string; metric_key: string; value: string | number }>).map((r) => [r.month_key, r.metric_key, Number(r.value)]))
      .toEqual([['2026-07', 'kpi:sales', 123.4], ['2026-07', 'src:reach', 10]]);
    const meta = await service.rpc('system_upsert_kpi_monthly_records', { _rows: [{ ...row, value: 11 }] });
    expect([meta.error, meta.data]).toEqual([null, 1]);
    const removed = await service.rpc('admin_set_kpi_monthly_records', { _actor_id: adminId, _updates: [{ ...row, value: null }] });
    expect([removed.error, removed.data]).toEqual([null, 1]);
    const after = await service.rpc('list_kpi_monthly_records', { _month_keys: ['2026-07'] });
    expect((after.data as unknown[]).length).toBe(1);
  });

  test('FREQ-573-AC-02: 権限の無い人は書き口で ACCOUNTING_FORBIDDEN（42501）、201件は ACCOUNTING_ARGUMENT_INVALID（22023）', async () => {
    const forbidden = await service.rpc('admin_set_kpi_monthly_records', { _actor_id: randomUUID(), _updates: [row] });
    expect(forbidden.error).toMatchObject({ code: '42501', message: 'ACCOUNTING_FORBIDDEN' });
    const many = Array.from({ length: 201 }, () => row);
    const invalid = await service.rpc('admin_set_kpi_monthly_records', { _actor_id: adminId, _updates: many });
    expect(invalid.error).toMatchObject({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
  });

  test('FREQ-573-AC-01: service_role は表を読めるが書けず、anon と authenticated は表も関数も permission denied（42501）で断られる', async () => {
    expect((await service.from('admin_kpi_monthly_records').select('month_key').limit(1)).error).toBeNull();
    const write = await service.from('admin_kpi_monthly_records').insert({ month_key: '2026-09', metric_key: 'src:reach', value: 1 });
    expect(write.error).toMatchObject({ code: '42501' });
    for (const [label, client] of [['anon', anon], ['authenticated', authenticated]] as const) {
      expect([label, (await client.from('admin_kpi_monthly_records').select('month_key').limit(1)).error?.code]).toEqual([label, '42501']);
      expect([label, (await client.from('admin_kpi_monthly_records').insert({ month_key: '2026-09', metric_key: 'src:reach', value: 1 })).error?.code]).toEqual([label, '42501']);
      for (const [name, args] of [
        ['admin_set_kpi_monthly_records', { _actor_id: adminId, _updates: [row] }],
        ['system_upsert_kpi_monthly_records', { _rows: [row] }],
        ['list_kpi_monthly_records', { _month_keys: ['2026-07'] }],
      ] as const) {
        expect([label, name, (await client.rpc(name, args)).error?.code]).toEqual([label, name, '42501']);
      }
    }
  });
});
