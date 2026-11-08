/** @jest-environment node */
/**
 * Accounting plan 2 Task 6 (FREQ-562-AC-05): the public entries of the dispute posting and the posting entry point over the real PostgREST
 * of the local Supabase. service_role is accepted; anon and authenticated are refused (permission denied, 42501).
 *
 * This suite COMMITS rows: the posting entry point books whatever is waiting in the local database, and PostgREST writes cannot be
 * rolled back from here. Run it on its own jest invocation with a db reset before and after (controller only):
 *   npm run db:reset
 *   eval "$(npx supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET)=')"
 *   ACCOUNTING_COMMIT_SUITE=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_ANON_KEY="$ANON_KEY" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
 *   LOCAL_SUPABASE_JWT_SECRET="$JWT_SECRET" \
 *     npx jest tests/integration/db/accounting_p2_run_posting_postgrest --runInBand
 *   npm run db:reset
 * The authenticated role is a token signed with the local JWT secret (the local Auth refuses a password sign-in without a captcha token); set
 * LOCAL_SUPABASE_JWT_SECRET to the JWT_SECRET of `npx supabase status -o env`.
 * Without ACCOUNTING_COMMIT_SUITE=1 or the four LOCAL_SUPABASE_* values it skips; a non-localhost URL fails.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describeLocalDb, isLocalDatabase } from './helpers/local-db';

jest.setTimeout(60000);

const LOCAL_API_URL = process.env.LOCAL_SUPABASE_URL;
const LOCAL_ANON_KEY = process.env.LOCAL_SUPABASE_ANON_KEY;
const LOCAL_SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const LOCAL_JWT_SECRET = process.env.LOCAL_SUPABASE_JWT_SECRET;
const COMMIT_SUITE = process.env.ACCOUNTING_COMMIT_SUITE === '1';

describeLocalDb('S11 posting entry point over PostgREST: controller only, commits rows', () => {
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

  const base64url = (value: string | Buffer) => (typeof value === 'string' ? Buffer.from(value) : value).toString('base64url');
  /** A session token of a signed-in member (role authenticated), signed with the local JWT secret. */
  function memberToken(secret: string): string {
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ aud: 'authenticated', role: 'authenticated', sub: randomUUID(), iss: 'supabase-demo',
      exp: Math.floor(Date.now() / 1000) + 600 }));
    return `${header}.${payload}.${base64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest())}`;
  }

  beforeAll(() => {
    service = createClient(apiUrl, LOCAL_SERVICE_ROLE_KEY as string, options);
    anon = createClient(apiUrl, LOCAL_ANON_KEY as string, options);
    // A member with no accounting permission: the authenticated role is real (a signed token), but has no EXECUTE.
    authenticated = createClient(apiUrl, LOCAL_ANON_KEY as string, {
      ...options, global: { headers: { Authorization: `Bearer ${memberToken(LOCAL_JWT_SECRET as string)}` } } });
  });

  const publicEntries: Array<[string, Record<string, unknown>]> = [
    ['accounting_run_posting', { _limit: 50 }],
    ['list_dispute_account_settings', {}],
    ['list_accounting_disputes', { _limit: 5, _after_at: null, _after_id: null }],
    ['get_order_dispute_holds', { _order_ids: [randomUUID()] }],
    ['get_slip_dispute_holds', { _slip_id: randomUUID() }],
    ['admin_set_dispute_account_setting', { _actor_id: randomUUID(), _reason: 'fraudulent', _account_code: '7530', _expected_version: null, _request_key: randomUUID() }],
    ['admin_assign_dispute_confirmed', { _actor_id: randomUUID(), _dispute_id: 'dp_none', _request_key: randomUUID() }],
    // Task 7: the six reads of the order intake, the backlog, the reconciliation and the deferred revenue.
    ['list_order_intake_events', { _from: '2026-01-01', _to: '2026-01-31', _limit: 10 }],
    ['get_intake_breakdown', { _from: '2026-01-01', _to: '2026-01-31' }],
    ['get_order_backlog', { _as_of: '2026-01-31' }],
    ['get_intake_reconciliation', { _from: '2026-01-01', _to: '2026-01-31' }],
    ['list_deferred_revenue', { _as_of: '2026-01-31', _limit: 5, _after_order: null }],
    ['list_deferred_revenue_anomalies', {}],
    // Task 9: the year-end shipment list, the check mark, the shipping options and the carrier receipt-date check.
    ['list_year_end_shipments', { _from: '2026-12-25', _to: '2027-01-10', _limit: 10, _after_date: null, _after_slip: null }],
    ['admin_check_year_end_shipment', { _actor_id: randomUUID(), _slip_id: randomUUID(), _note: null, _request_key: randomUUID() }],
    ['get_shipping_options', {}],
    ['admin_set_shipping_options', { _actor_id: randomUUID(), _carrier_date_check_enabled: true, _expected_version: 1, _request_key: randomUUID() }],
    ['list_carrier_date_gaps', { _from: '2026-12-25', _to: '2027-01-10', _limit: 10 }],
  ];

  test('FREQ-562-AC-05: 入口は service_role で呼べて、件数の7つの鍵を返す', async () => {
    const { data, error } = await service.rpc('accounting_run_posting', { _limit: 50 });
    expect(error).toBeNull();
    expect(Object.keys(data as Record<string, unknown>).sort()).toEqual(['disputes', 'has_more', 'parked', 'payments', 'resolved', 'shipments', 'stripe']);
    expect(typeof (data as { has_more: unknown }).has_more).toBe('boolean');
  });

  test('FREQ-562-AC-05: 入口は limit が範囲の外なら ACCOUNTING_ARGUMENT_INVALID（22023）で断る', async () => {
    for (const bad of [0, 201]) {
      const { error } = await service.rpc('accounting_run_posting', { _limit: bad });
      expect(error).toMatchObject({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    }
  });

  test('FREQ-562-AC-05: 読み口は service_role で呼べて、申し立ての資料の写しを返さない', async () => {
    const settings = await service.rpc('list_dispute_account_settings');
    expect(settings.error).toBeNull();
    expect(settings.data).toHaveProperty('settings');
    const list = await service.rpc('list_accounting_disputes', { _limit: 5, _after_at: null, _after_id: null });
    expect(list.error).toBeNull();
    expect(JSON.stringify(list.data)).not.toMatch(/raw_payload|evidence/);
    const holds = await service.rpc('get_order_dispute_holds', { _order_ids: [randomUUID()] });
    expect(holds.error).toBeNull();
    expect(holds.data).toEqual([]);
    const slipHolds = await service.rpc('get_slip_dispute_holds', { _slip_id: randomUUID() });
    expect(slipHolds.error).toBeNull();
    expect(slipHolds.data).toEqual([]);
  });

  test('FREQ-571-AC-05: 受注高・受注残・照らし合わせ・前受金の6つの読み口は service_role で呼べて、決めた鍵を返す', async () => {
    const keysOf = async (name: string, args: Record<string, unknown>) => {
      const { data, error } = await service.rpc(name, args);
      expect([name, error]).toEqual([name, null]);
      return Object.keys(data as Record<string, unknown>).sort();
    };
    const args = (name: string) => publicEntries.find(([entry]) => entry === name)?.[1] ?? {};
    expect(await keysOf('list_order_intake_events', args('list_order_intake_events'))).toEqual(['events', 'next_after_date', 'next_after_key']);
    expect(await keysOf('get_intake_breakdown', args('get_intake_breakdown'))).toEqual(['breakdown_ok', 'discount', 'dispute_unshipped',
      'dispute_unshipped_restored', 'intake', 'order_count', 'payment', 'pre_shipment_cancel', 'shipping', 'subtotal_before_discount']);
    expect(await keysOf('get_order_backlog', args('get_order_backlog'))).toEqual(['backlog_total', 'order_count']);
    expect(await keysOf('get_intake_reconciliation', args('get_intake_reconciliation'))).toEqual(['book_sales_total', 'booked_sales_net_orders',
      'closing_backlog', 'dispute_confirmed_by_account', 'exceptions', 'intake', 'opening_backlog', 'other_4010', 'other_4020',
      'return_fee_revenue_4050', 'returns', 'sales_before_return', 'unexplained', 'unexplained2']);
    expect(await keysOf('list_deferred_revenue', args('list_deferred_revenue'))).toEqual(['next_after_order', 'orders', 'total_balance']);
    expect(await keysOf('list_deferred_revenue_anomalies', {})).toEqual(['anomalies']);
    const refused = await service.rpc('get_intake_breakdown', { _from: '2026-02-01', _to: '2026-01-01' });
    expect(refused.error).toMatchObject({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
  });

  test('FREQ-574-AC-01: 年末の一覧・設定・受付の日とのずれの3つの読み口は service_role で呼べて、決めた鍵を返し、書き口は権限の無い人を断る', async () => {
    const args = (name: string) => publicEntries.find(([entry]) => entry === name)?.[1] ?? {};
    const list = await service.rpc('list_year_end_shipments', args('list_year_end_shipments'));
    expect(list.error).toBeNull();
    expect(Object.keys(list.data as Record<string, unknown>).sort()).toEqual(['next_after_date', 'next_after_slip', 'slips']);
    const options = await service.rpc('get_shipping_options');
    expect(options.error).toBeNull();
    expect(Object.keys(options.data as Record<string, unknown>).sort()).toEqual(['carrier_date_check_enabled', 'changed_at', 'changed_by', 'version']);
    const gaps = await service.rpc('list_carrier_date_gaps', args('list_carrier_date_gaps'));
    expect(gaps.error).toBeNull();
    expect(Object.keys(gaps.data as Record<string, unknown>).sort()).toEqual(['enabled', 'slips']);
    const tooLong = await service.rpc('list_year_end_shipments', { ...args('list_year_end_shipments'), _to: '2027-03-10' });
    expect(tooLong.error).toMatchObject({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    // The writers answer a person with no permission (a random id) with 42501; nothing is written.
    const check = await service.rpc('admin_check_year_end_shipment', args('admin_check_year_end_shipment'));
    expect(check.error).toMatchObject({ code: '42501', message: 'ACCOUNTING_FORBIDDEN' });
    const set = await service.rpc('admin_set_shipping_options', args('admin_set_shipping_options'));
    expect(set.error).toMatchObject({ code: '42501', message: 'ACCOUNTING_FORBIDDEN' });
  });

  test('FREQ-568-AC-05: 書き口は service_role で呼べるが、権限の無い人は ACCOUNTING_FORBIDDEN（42501）で断られる', async () => {
    const set = await service.rpc('admin_set_dispute_account_setting', publicEntries[5][1]);
    expect(set.error).toMatchObject({ code: '42501', message: 'ACCOUNTING_FORBIDDEN' });
    const assign = await service.rpc('admin_assign_dispute_confirmed', publicEntries[6][1]);
    expect(assign.error).toMatchObject({ code: '42501', message: 'ACCOUNTING_FORBIDDEN' });
  });

  test.each(publicEntries.map(([name]) => name))('FREQ-562-AC-05: %s は anon と authenticated を permission denied（42501）で断る', async (name) => {
    const args = publicEntries.find(([entry]) => entry === name)?.[1] ?? {};
    for (const [label, client] of [['anon', anon], ['authenticated', authenticated]] as const) {
      const { data, error } = await client.rpc(name, args);
      expect([label, data, error?.code]).toEqual([label, null, '42501']);
      expect(error?.message).toMatch(/permission denied/i);
    }
  });
});
