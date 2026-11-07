/** @jest-environment node */
import { describeLocalDb } from './helpers/local-db';
import {
  accountingFailure, createAccountingPeriod, insertAccountingAdmin, japanToday, journalLines, postJournal,
  type JournalLineInput,
} from './helpers/accounting-fixtures';

// Accounting plan 1 S3 (FREQ-555-AC-04): the read functions. Every test runs in BEGIN ... ROLLBACK (controller only,
// local DB).
const SALE: JournalLineInput[] = [{ account: '1130', debit: 1000 }, { account: '4010', credit: 1000 }];
const INVALID = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
type Page = { entries: { id: string; entry_no: number; entry_date: string }[]; next_after_date: string | null; next_after_no: number | null };

describeLocalDb('S3 reads: controller only', (db) => {
  let admin: string;
  let part = 0;
  beforeEach(async () => {
    await db().query('begin');
    admin = await insertAccountingAdmin(db());
  });
  afterEach(async () => { await db().query('rollback'); });

  const one = async (text: string, params: unknown[] = []) => (await db().query(text, params)).rows[0];
  const failure = (run: () => Promise<unknown>) => accountingFailure(db(), run);
  const sole = async (y: number) => (await createAccountingPeriod(db(), admin,
    { businessType: 'soleProprietor', startsOn: `${y}-01-01`, endsOn: `${y}-12-31` })).id;
  const post = (periodId: string, entryDate: string, lines: JournalLineInput[] = SALE, sourceRecordedAt?: string) =>
    postJournal(db(), { periodId, entryDate, kind: 'payment_confirmed', parts: [`pi_read_${part += 1}`], lines, sourceRecordedAt });
  const page = (periodId: string, options: { from?: string; to?: string; limit?: number; afterDate?: string | null;
    afterNo?: number | null } = {}) => one(
    'select public.list_accounting_journal($1::uuid, $2::date, $3::date, $4::integer, $5::date, $6::bigint) as r',
    [periodId, options.from ?? null, options.to ?? null, options.limit ?? 100, options.afterDate ?? null, options.afterNo ?? null])
    .then((r) => r.r as Page);
  const trial = async (periodId: string, through: string | null = null) => (await db().query(
    `select account_code, debit_total::int as d, credit_total::int as c, opening_signed::int as o
     from public.get_accounting_trial_balance($1::uuid, $2::date)`, [periodId, through])).rows;

  test('FREQ-555-AC-04: 期間で数える読み口は注文を作った日でなく仕訳の期間で絞り日付順に並べる', async () => {
    const y2026 = await sole(2026);
    const y2027 = await sole(2027);
    const order = '6f1c3a52-7d0e-4c1a-9a6e-0b2d4c8e1f37';
    const march = await post(y2026, '2026-03-01');
    const january = await post(y2026, '2026-01-15', [{ account: '1130', debit: 200 }, { account: '4010', credit: 200 }]);
    const february = await post(y2026, '2026-02-10', [{ account: '1130', debit: 30 }, { account: '4010', credit: 30 }]);
    const februaryAgain = await post(y2026, '2026-02-10', [{ account: '6010', debit: 5 }, { account: '1010', credit: 5 }]);
    // An order made in 2026 whose entry falls on a 2027 day is read in 2027 only.
    const shipped = (await db().query(`select private.accounting_post_journal_core(null, $1::uuid, '2027-01-03', 'shipment_confirmed',
      array['slip_2026_order'], 'shipped', $2::jsonb) as r`, [y2027, JSON.stringify([
      { account_code: '1130', debit: 700, credit: 0, order_id: order }, { account_code: '4010', debit: 0, credit: 700, order_id: order }])])).rows[0].r;
    const ids = (p: Page) => p.entries.map((e) => e.id);
    expect(ids(await page(y2026))).toEqual([january.entryId, february.entryId, februaryAgain.entryId, march.entryId]);
    expect((await page(y2026)).entries.map((e) => [e.entry_date, e.entry_no])).toEqual([
      ['2026-01-15', 2], ['2026-02-10', 3], ['2026-02-10', 4], ['2026-03-01', 1]]);
    expect(ids(await page(y2026, { from: '2026-02-01', to: '2026-02-28' }))).toEqual([february.entryId, februaryAgain.entryId]);
    expect(ids(await page(y2027))).toEqual([shipped.entry_id]);
    expect(await trial(y2026)).toEqual([
      { account_code: '1010', d: 0, c: 5, o: 0 }, { account_code: '1130', d: 1230, c: 0, o: 0 },
      { account_code: '4010', d: 0, c: 1230, o: 0 }, { account_code: '6010', d: 5, c: 0, o: 0 }]);
    expect(await trial(y2026, '2026-01-31')).toEqual([
      { account_code: '1130', d: 200, c: 0, o: 0 }, { account_code: '4010', d: 0, c: 200, o: 0 }]);
    // The next period counts its own entries on top of the computed opening.
    expect(await trial(y2027)).toEqual([
      { account_code: '1010', d: 0, c: 0, o: -5 }, { account_code: '1130', d: 700, c: 0, o: 1230 },
      { account_code: '2910', d: 0, c: 0, o: -1225 }, { account_code: '4010', d: 0, c: 700, o: 0 }]);
  });

  test('FREQ-555-AC-04: 仕訳の読み口の続きの目印は仕訳の日と通し番号の組で、日の古い取り消しの仕訳がページの境目にあっても、抜けも重なりも無く最後まで読める', async () => {
    const period = await sole(2026);
    const posted: { entryId: string; entryNo: number; created: boolean }[] = [];
    for (const day of ['10', '11', '12', '13', '14']) posted.push(await post(period, `2026-01-${day}`));
    // The reversal of the second entry takes number 6 but keeps the original day (2026-01-11).
    const reversal = (await one('select private.accounting_reverse_journal_core(null, $1::uuid, $2::text) as r',
      [posted[1].entryId, 'entered twice'])).r;
    const expected = [posted[0].entryId, posted[1].entryId, reversal.entry_id, posted[2].entryId, posted[3].entryId, posted[4].entryId];
    for (const limit of [1, 2, 4, 6, 200]) {
      const seen: string[] = [];
      let cursor: { afterDate: string | null; afterNo: number | null } = { afterDate: null, afterNo: null };
      for (let round = 0; round < 10; round += 1) {
        const result = await page(period, { limit, ...cursor });
        seen.push(...result.entries.map((e) => e.id));
        expect((result.next_after_date === null) === (result.next_after_no === null)).toBe(true);
        if (result.next_after_date === null) break;
        const last = result.entries[result.entries.length - 1];
        expect([result.next_after_date, result.next_after_no]).toEqual([last.entry_date, last.entry_no]);
        cursor = { afterDate: result.next_after_date, afterNo: result.next_after_no };
      }
      expect({ limit, seen }).toEqual({ limit, seen: expected });
    }
    // The last page has both marks null.
    expect(await page(period, { limit: 6 })).toMatchObject({ next_after_date: null, next_after_no: null });
  });

  test('FREQ-555-AC-04: 続きの目印は日と番号を片方だけ渡すと断られる', async () => {
    const period = await sole(2026);
    await post(period, '2026-01-10');
    expect(await failure(() => page(period, { afterDate: '2026-01-10' }))).toEqual(INVALID);
    expect(await failure(() => page(period, { afterNo: 1 }))).toEqual(INVALID);
    expect(await failure(() => page(period, { limit: 0 }))).toEqual(INVALID);
    expect(await failure(() => page(period, { limit: 201 }))).toEqual(INVALID);
    expect(await failure(() => page(period, { from: '2026-02-01', to: '2026-01-01' }))).toEqual(INVALID);
    expect(await failure(() => page('6f1c3a52-7d0e-4c1a-9a6e-0b2d4c8e1f37'))).toEqual({ code: 'P0002', message: 'ACCOUNTING_NOT_FOUND' });
    expect((await page(period, { limit: 200 })).entries).toHaveLength(1);
    expect((await page(period, { afterDate: '2026-01-10', afterNo: 1 })).entries).toEqual([]);
  });

  test('FREQ-555-AC-04: 仕訳の読み口はsource_recorded_atを返し、渡さなかった仕訳はnull', async () => {
    const period = await sole(2026);
    const source = '2026-01-20T03:00:00.000Z';
    await post(period, '2026-01-10', SALE, source);
    await post(period, '2026-01-11');
    // A manual / migrated entry also carries the counts of its old revisions and receipts.
    await db().query("insert into public.admin_finance_entry_revisions (entry_id, operation) values (900001, 'insert'), (900001, 'update')");
    const receipts = Number((await one("select count(*) as n from public.admin_finance_receipts where entry_id::text = '900001'")).n);
    await db().query(`select private.accounting_post_journal_core(null, $1::uuid, '2026-01-12', 'manual_entry', array['900001', '0'],
      'manual', $2::jsonb, _source_table => 'admin_finance_expenses', _source_id => '900001')`, [period, journalLines(SALE)]);
    const [withSource, withoutSource, manual] = (await page(period)).entries as unknown as Record<string, unknown>[];
    expect(new Date(withSource.source_recorded_at as string).toISOString()).toBe(source);
    expect(withoutSource.source_recorded_at).toBeNull();
    expect(Object.keys(withoutSource).sort()).toEqual(['dedupe_key', 'description', 'entry_date', 'entry_no', 'event_kind', 'id',
      'is_late', 'lines', 'migrated_at', 'migrated_from', 'period_id', 'reason', 'recorded_at', 'recorded_by', 'reverses_entry_id',
      'source_id', 'source_recorded_at', 'source_table']);
    expect(withoutSource.lines).toEqual([
      { line_no: 1, account_code: '1130', debit: 1000, credit: 0, sub_account: null, counterparty: null, order_id: null, memo: null },
      { line_no: 2, account_code: '4010', debit: 0, credit: 1000, sub_account: null, counterparty: null, order_id: null, memo: null }]);
    expect(manual.legacy).toEqual({ revision_count: 2, receipt_count: receipts });
    expect([withSource.event_kind, withSource.is_late, typeof withSource.recorded_at]).toEqual(['payment_confirmed', false, 'string']);
  });

  test('FREQ-555-AC-04: 設定の読み口は開業日・切り替えの日・事業の形・やめた日・版と変更の記録を返す', async () => {
    const read = (await one('select public.get_accounting_settings() as r')).r;
    expect(read).toEqual({ business_start_date: null, cutover_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      current_business_type: 'soleProprietor', sole_business_ended_on: null, version: expect.stringMatching(/^\d+$/),
      sole_end_changes: expect.any(Array) });
    expect(read.cutover_on <= japanToday()).toBe(true);
    const periods = (await db().query('select r from public.list_accounting_periods() as r')).rows.map((row) => row.r);
    expect(periods).toEqual([]);
    const corporation = await createAccountingPeriod(db(), admin, { businessType: 'corporation', startsOn: '2026-04-01', endsOn: '2027-03-31' });
    const y2026 = await sole(2026);
    const listed = (await db().query('select r from public.list_accounting_periods() as r')).rows.map((row) => row.r);
    expect(listed.map((p: { id: string }) => p.id)).toEqual([y2026, corporation.id]);
    expect(Object.keys(listed[0]).sort()).toEqual(['business_type', 'consumption_tax_extension_months', 'consumption_tax_status',
      'consumption_taxable_from', 'corporate_tax_extension_months', 'ends_on', 'id', 'legacy_fiscal_year', 'name', 'starts_on', 'version']);
  });

  test('FREQ-555-AC-04: 読み口と書く入口はservice_roleだけが呼べ、読み口はSTABLEで、新しい表はservice_roleのSELECTだけ', async () => {
    const period = await sole(2026);
    await post(period, '2026-01-10');
    const calls = [
      'select public.get_accounting_settings()',
      'select * from public.list_accounting_periods()',
      `select * from public.get_accounting_opening('${period}')`,
      `select public.list_accounting_journal('${period}')`,
      `select * from public.get_accounting_trial_balance('${period}')`,
      `select public.admin_update_accounting_settings('${admin}', null, 'soleProprietor', 1, gen_random_uuid())`,
      `select public.admin_create_accounting_period('${admin}', 'soleProprietor', '2027-01-01', '2027-12-31', null, gen_random_uuid())`,
      `select public.admin_update_accounting_period_filing('${admin}', '${period}', 0::smallint, 0::smallint, 'exempt', null, 1, gen_random_uuid())`,
      `select public.admin_shorten_final_sole_period('${admin}', '${period}', '2026-12-31', 1, 1, null, gen_random_uuid())`,
    ];
    const as = (role: string, statement: string) => failure(async () => {
      await db().query(`set local role ${role}`);
      await db().query(statement);
    });
    for (const statement of calls) {
      expect({ statement, service: await as('service_role', statement) }).toEqual({ statement, service: null });
      for (const role of ['anon', 'authenticated']) {
        expect({ statement, role, result: await as(role, statement) }).toEqual({ statement, role, result: { code: '42501', message: 'DATABASE_ERROR' } });
      }
    }
    const executable = (await db().query(`select p.proname::text as name, p.provolatile::text as volatility,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service
      from pg_proc p where p.pronamespace in ('private'::regnamespace, 'public'::regnamespace)
        and p.proname in ('get_accounting_settings', 'list_accounting_periods', 'get_accounting_opening', 'list_accounting_journal',
          'get_accounting_trial_balance', 'accounting_period_for_event', 'accounting_ensure_individual_periods',
          'accounting_opening_balances', 'accounting_store_opening')
      order by 1, p.pronamespace::regnamespace::text`)).rows;
    expect(executable).toEqual([
      { name: 'accounting_ensure_individual_periods', volatility: 'v', service: false },
      { name: 'accounting_opening_balances', volatility: 's', service: false },
      { name: 'accounting_period_for_event', volatility: 'v', service: false },
      { name: 'accounting_store_opening', volatility: 'v', service: true },
      ...['get_accounting_opening', 'get_accounting_settings', 'get_accounting_trial_balance', 'list_accounting_journal',
        'list_accounting_periods'].flatMap((name) => [{ name, volatility: 's', service: true }, { name, volatility: 's', service: true }]),
    ]);
    for (const table of ['accounting_settings', 'accounting_opening_balances']) {
      const privileges = await one(`select has_table_privilege('service_role', $1, 'SELECT') as service_select,
        has_table_privilege('service_role', $1, 'INSERT,UPDATE,DELETE,TRUNCATE') as service_write,
        has_table_privilege('anon', $1, 'SELECT,INSERT,UPDATE,DELETE') as anon_any,
        has_table_privilege('authenticated', $1, 'SELECT,INSERT,UPDATE,DELETE') as authenticated_any`, [`public.${table}`]);
      expect({ table, privileges }).toEqual({ table, privileges: { service_select: true, service_write: false, anon_any: false, authenticated_any: false } });
    }
  });
});
