/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { formatPeriodName } from '@/lib/accounting/period';
import { describeLocalDb } from './helpers/local-db';
import {
  accountingFailure, createAccountingPeriod, insertAccountingAdmin, japanToday, postJournal, type AccountingBusinessType,
  type AccountingPeriodJson, type JournalLineInput,
} from './helpers/accounting-fixtures';

// Accounting plan 1 S3 (FREQ-555, FREQ-561-AC-03, FREQ-554-AC-04): settings, periods, the end day of the sole business
// and the period of an event. Every test runs in BEGIN ... ROLLBACK (controller only, local DB).
const SALE: JournalLineInput[] = [{ account: '1130', debit: 1000 }, { account: '4010', credit: 1000 }];
const FORBIDDEN = { code: '42501', message: 'ACCOUNTING_FORBIDDEN' };
const INVALID = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
const VERSION = { code: '40001', message: 'ACCOUNTING_VERSION_CONFLICT' };
const BLOCKED = { code: '55000', message: 'ACCOUNTING_PERIOD_SHORTEN_BLOCKED' };
const IMMUTABLE = { code: '55000', message: 'ACCOUNTING_HISTORY_IMMUTABLE' };
const MISSING = { code: '55000', message: 'ACCOUNTING_PERIOD_MISSING' };
const NOT_SWITCHED = { ...MISSING, detail: 'sole_ended_not_switched' };
const KEY_CONFLICT = { code: '23505', message: 'ACCOUNTING_REQUEST_KEY_CONFLICT' };

type Settings = {
  business_start_date: string | null; cutover_on: string; current_business_type: AccountingBusinessType;
  sole_business_ended_on: string | null; version: string;
  sole_end_changes: { previousEndedOn: string | null; newEndedOn: string; reason: string | null; changedAt: string }[];
};

describeLocalDb('S3 periods: controller only', (db) => {
  const year = Number(japanToday().slice(0, 4));
  let admin: string;
  beforeEach(async () => {
    await db().query('begin');
    admin = await insertAccountingAdmin(db());
  });
  afterEach(async () => { await db().query('rollback'); });

  const one = async (text: string, params: unknown[] = []) => (await db().query(text, params)).rows[0];
  const failure = (run: () => Promise<unknown>) => accountingFailure(db(), run);
  const create = (businessType: AccountingBusinessType, startsOn: string, endsOn: string, extra: { actor?: string | null;
    name?: string | null; requestKey?: string } = {}) =>
    createAccountingPeriod(db(), extra.actor === undefined ? admin : extra.actor, { businessType, startsOn, endsOn, ...extra });
  const settings = async (): Promise<Settings> => (await one('select public.get_accounting_settings() as r')).r;
  const row = (id: string) => one(`select to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on,
    version::text, business_type, consumption_tax_status, to_char(consumption_taxable_from, 'YYYY-MM-DD') as taxable_from,
    corporate_tax_extension_months as corporate, consumption_tax_extension_months as consumption
    from public.accounting_periods where id = $1`, [id]);
  const settingsRow = () => one('select to_jsonb(s) as r from public.accounting_settings s').then((r) => r.r);
  const shorten = (periodId: string, endedOn: string, periodVersion: number | string, settingsVersion: number | string,
    reason: string | null = null, requestKey: string = randomUUID(), actor: string | null = admin) =>
    one(`select public.admin_shorten_final_sole_period($1::uuid, $2::uuid, $3::date, $4::bigint, $5::bigint, $6::text, $7::uuid) as r`,
      [actor, periodId, endedOn, periodVersion, settingsVersion, reason, requestKey]).then((r) => r.r as AccountingPeriodJson);
  const updateSettings = (startDate: string | null, type: AccountingBusinessType, version: number | string,
    requestKey: string = randomUUID(), actor: string | null = admin) =>
    one('select public.admin_update_accounting_settings($1::uuid, $2::date, $3::text, $4::bigint, $5::uuid) as r',
      [actor, startDate, type, version, requestKey]).then((r) => r.r as Settings);
  const switchTo = async (type: AccountingBusinessType) => {
    const current = await settings();
    return updateSettings(current.business_start_date, type, current.version);
  };
  const filing = (periodId: string, corporate: number, consumption: number, status: string, taxableFrom: string | null,
    version: number | string, requestKey: string = randomUUID()) =>
    one(`select public.admin_update_accounting_period_filing($1::uuid, $2::uuid, $3::smallint, $4::smallint, $5::text, $6::date,
      $7::bigint, $8::uuid) as r`, [admin, periodId, corporate, consumption, status, taxableFrom, version, requestKey])
      .then((r) => r.r as AccountingPeriodJson);
  const forEvent = (date: string, actor: string | null = null) =>
    one('select private.accounting_period_for_event($1::date, $2::uuid) as id', [date, actor]).then((r) => r.id as string);
  const ensure = (y: number) =>
    db().query('select private.accounting_ensure_individual_periods($1::integer, $2::uuid) as id', [y, admin]).then((r) => r.rows);
  const counts = async () => one(`select count(*) filter (where business_type = 'soleProprietor')::int as sole,
    count(*) filter (where business_type = 'corporation')::int as corporation from public.accounting_periods`);
  const reverse = (entryId: string, entryDate: string | null = null) =>
    one('select private.accounting_reverse_journal_core($1::uuid, $2::uuid, $3::text, $4::date) as r',
      [admin, entryId, 'mistake', entryDate]).then((r) => r.r);
  const periodOf = (entryId: string) =>
    one('select period_id from public.accounting_journal_entries where id = $1', [entryId]).then((r) => r.period_id as string);

  test('FREQ-555-AC-01: 期間は重なりとすき間と1年超を断り受理は事業の形ごとに続く', async () => {
    const sole2026 = await create('soleProprietor', '2026-01-01', '2026-12-31');
    const soleHalf = await create('soleProprietor', '2027-01-01', '2027-06-30');
    expect([sole2026.name, sole2026.legacy_fiscal_year, soleHalf.name, soleHalf.legacy_fiscal_year])
      .toEqual(['2026年（個人）', 2026, '2027年（個人）', 2027]);
    expect(await failure(() => create('soleProprietor', '2027-01-01', '2027-12-31'))).toEqual({ code: '23514', message: 'ACCOUNTING_PERIOD_OVERLAP' });
    expect(await failure(() => create('soleProprietor', '2028-01-01', '2028-12-31'))).toEqual({ code: '23514', message: 'ACCOUNTING_PERIOD_GAP' });
    expect(await failure(() => create('soleProprietor', '2028-02-01', '2028-12-31'))).toEqual(INVALID);
    // The corporation dates overlap the sole half year: another business type, so it is accepted.
    const first = await create('corporation', '2027-04-01', '2028-03-31');
    expect(first.name).toBe('第1期');
    expect(await failure(() => create('corporation', '2028-04-01', '2029-04-01'))).toEqual({ code: '23514', message: 'ACCOUNTING_PERIOD_TOO_LONG' });
    expect(await failure(() => create('corporation', '2028-05-01', '2029-03-31'))).toEqual({ code: '23514', message: 'ACCOUNTING_PERIOD_GAP' });
    expect(await failure(() => create('corporation', '2028-03-01', '2029-02-28'))).toEqual({ code: '23514', message: 'ACCOUNTING_PERIOD_OVERLAP' });
    // start > end is an argument error (HTTP 400), not a layout error.
    expect(await failure(() => create('corporation', '2029-04-01', '2028-04-01'))).toEqual(INVALID);
    expect(await failure(() => create('corporation', '2028-04-01', '2029-03-31', { name: ' ' }))).toEqual(INVALID);
    expect(await failure(() => create('corporation', '2028-04-01', '2029-03-31', { name: 'x'.repeat(61) }))).toEqual(INVALID);
    const second = await create('corporation', '2028-04-01', '2029-03-31');
    expect([second.name, second.legacy_fiscal_year]).toEqual(['第2期', null]);
    expect((await create('corporation', '2029-04-01', '2030-03-31', { name: '第3期（決算変更前）' })).name).toBe('第3期（決算変更前）');
    expect(await failure(async () => undefined)).toBeNull();
    expect(await counts()).toEqual({ sole: 2, corporation: 3 });
  });

  test('FREQ-555-AC-01: SQLの期間の名前はTSのformatPeriodNameと同じ文字列になる', async () => {
    await create('corporation', '2027-07-01', '2028-06-30');
    for (const [type, startsOn, term] of [['soleProprietor', '2026-01-01', undefined], ['soleProprietor', '2031-01-01', undefined],
      ['corporation', '2027-07-01', 1], ['corporation', '2028-07-01', 2]] as const) {
      const name = (await one('select private.accounting_default_period_name($1::text, $2::date) as n', [type, startsOn])).n;
      expect({ type, startsOn, name }).toEqual({ type, startsOn,
        name: formatPeriodName({ businessType: type, startsOn, endsOn: startsOn, termNumber: term }) });
    }
  });

  test('FREQ-555-AC-01: 2月29日開始の法人の期間は翌年2月28日まで受け翌年3月1日は断る', async () => {
    expect(await failure(() => create('corporation', '2028-02-29', '2029-03-01'))).toEqual({ code: '23514', message: 'ACCOUNTING_PERIOD_TOO_LONG' });
    const leap = await create('corporation', '2028-02-29', '2029-02-28');
    expect([leap.starts_on, leap.ends_on]).toEqual(['2028-02-29', '2029-02-28']);
    expect(await failure(async () => undefined)).toBeNull();
  });

  test('FREQ-555-AC-01: 専用の入口以外の期間の日付と事業の形のUPDATEとDELETEは断られる', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    const corporation = await create('corporation', '2027-07-01', '2028-06-30');
    const before = [await row(sole.id), await row(corporation.id)];
    // TRUNCATE refuses pending deferred trigger events (55006); fire the layout checks first.
    await db().query('set constraints all immediate');
    for (const [statement, expected] of [
      [`update public.accounting_periods set starts_on = '2026-02-01' where id = '${corporation.id}'`, IMMUTABLE],
      [`update public.accounting_periods set business_type = 'corporation' where id = '${sole.id}'`, IMMUTABLE],
      [`update public.accounting_periods set legacy_fiscal_year = 2030 where id = '${sole.id}'`, IMMUTABLE],
      [`update public.accounting_periods set ends_on = '2028-05-31' where id = '${corporation.id}'`, BLOCKED],
      // The last sole period without the settings record of the shorten entry.
      [`update public.accounting_periods set ends_on = '2026-06-30' where id = '${sole.id}'`, BLOCKED],
      [`delete from public.accounting_periods where id = '${corporation.id}'`, IMMUTABLE],
      ['truncate table public.accounting_periods cascade', IMMUTABLE],
      ['delete from public.accounting_settings', IMMUTABLE],
      ['truncate table public.accounting_settings', IMMUTABLE],
    ] as const) {
      expect({ statement, result: await failure(() => db().query(statement)) }).toEqual({ statement, result: expected });
    }
    // Under replica mode the guards still fire (ALWAYS).
    expect(await failure(async () => {
      await db().query("set local session_replication_role = 'replica'");
      await db().query(`update public.accounting_periods set starts_on = '2027-08-01' where id = '${corporation.id}'`);
    })).toEqual(IMMUTABLE);
    // The name may change directly; nothing else moved.
    await db().query(`update public.accounting_periods set name = 'renamed' where id = '${corporation.id}'`);
    expect([await row(sole.id), await row(corporation.id)]).toEqual(before);
  });

  test('FREQ-555-AC-01: 期間の作成は権限なしを42501で再送は同じ結果を返す', async () => {
    expect(await failure(() => create('soleProprietor', '2026-01-01', '2026-12-31', { actor: randomUUID() }))).toEqual(FORBIDDEN);
    expect(await failure(() => create('soleProprietor', '2026-01-01', '2026-12-31', { actor: null }))).toEqual(FORBIDDEN);
    const key = randomUUID();
    const first = await create('soleProprietor', '2026-01-01', '2026-12-31', { requestKey: key });
    expect(await create('soleProprietor', '2026-01-01', '2026-12-31', { requestKey: key })).toEqual(first);
    expect(await counts()).toEqual({ sole: 1, corporation: 0 });
    expect(await failure(() => create('soleProprietor', '2027-01-01', '2027-12-31', { requestKey: key }))).toEqual(KEY_CONFLICT);
    // A key used by another operation conflicts too.
    const settingsKey = randomUUID();
    await updateSettings(null, 'soleProprietor', 1, settingsKey);
    expect(await failure(() => create('soleProprietor', '2027-01-01', '2027-12-31', { requestKey: settingsKey }))).toEqual(KEY_CONFLICT);
  });

  test('FREQ-561-AC-03: 開業日は1度入れると別の値に選び直せず同じ値の再送は通る', async () => {
    expect((await settings()).business_start_date).toBeNull();
    const key = randomUUID();
    const first = await updateSettings('2025-10-01', 'soleProprietor', 1, key);
    expect([first.business_start_date, first.version]).toEqual(['2025-10-01', '2']);
    expect(await updateSettings('2025-10-01', 'soleProprietor', 1, key)).toEqual(first);
    const locked = { code: '55000', message: 'ACCOUNTING_SETTINGS_LOCKED' };
    expect(await failure(() => updateSettings('2025-11-01', 'soleProprietor', 2))).toEqual(locked);
    expect(await failure(() => updateSettings(null, 'soleProprietor', 2))).toEqual(locked);
    expect(await failure(() => db().query("update public.accounting_settings set business_start_date = '2025-11-01'"))).toEqual(locked);
    // The same value again passes and changes nothing.
    const same = await updateSettings('2025-10-01', 'soleProprietor', 2);
    expect([same.business_start_date, same.version]).toEqual(['2025-10-01', '2']);
  });

  test('FREQ-555-AC-06: 設定の版が違えば更新できない', async () => {
    expect(await failure(() => updateSettings(null, 'corporation', 5))).toEqual(VERSION);
    expect(await failure(() => updateSettings(null, 'corporation', 1, randomUUID(), randomUUID()))).toEqual(FORBIDDEN);
    expect(await failure(() => updateSettings(null, 'other' as AccountingBusinessType, 1))).toEqual(INVALID);
    const switched = await updateSettings(null, 'corporation', 1);
    expect([switched.current_business_type, switched.version]).toEqual(['corporation', '2']);
    expect(await failure(() => updateSettings(null, 'soleProprietor', 1))).toEqual(VERSION);
    expect((await settings()).current_business_type).toBe('corporation');
  });

  test('FREQ-555-AC-01: 消費税の延長は法人税の延長より大きくできない', async () => {
    const corporation = await create('corporation', '2027-07-01', '2028-06-30');
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    expect(await failure(() => filing(corporation.id, 0, 1, 'exempt', null, 1))).toEqual(INVALID);
    expect(await failure(() => filing(corporation.id, 2, 0, 'exempt', null, 1))).toEqual(INVALID);
    expect(await failure(() => filing(sole.id, 1, 0, 'exempt', null, 1))).toEqual(INVALID);
    const both = await filing(corporation.id, 1, 1, 'exempt', null, 1);
    expect([both.corporate_tax_extension_months, both.consumption_tax_extension_months, both.version]).toEqual([1, 1, '2']);
    const corporateOnly = await filing(corporation.id, 1, 0, 'exempt', null, 2);
    expect([corporateOnly.corporate_tax_extension_months, corporateOnly.consumption_tax_extension_months]).toEqual([1, 0]);
    // The table CHECK is the second gate for a direct write.
    expect(await failure(() => db().query(`update public.accounting_periods set consumption_tax_extension_months = 1,
      corporate_tax_extension_months = 0 where id = $1`, [corporation.id]))).toEqual({ code: '23514', message: 'DATABASE_ERROR' });
  });

  test('FREQ-555-AC-01: 課税か免税かの欄は、免税ならNULL、課税なら期間の中の日だけを受け、専用の最後の期間の登録以外では日付と事業の形は変えられない', async () => {
    const corporation = await create('corporation', '2027-07-01', '2028-06-30');
    expect(await failure(() => filing(corporation.id, 0, 0, 'taxable', null, 1))).toEqual(INVALID);
    expect(await failure(() => filing(corporation.id, 0, 0, 'exempt', '2027-10-01', 1))).toEqual(INVALID);
    expect(await failure(() => filing(corporation.id, 0, 0, 'taxable', '2027-06-30', 1))).toEqual(INVALID);
    expect(await failure(() => filing(corporation.id, 0, 0, 'taxable', '2028-07-01', 1))).toEqual(INVALID);
    expect(await failure(() => filing(corporation.id, 0, 0, 'other', null, 1))).toEqual(INVALID);
    expect(await failure(() => filing(corporation.id, 0, 0, 'taxable', '2027-10-01', 9))).toEqual(VERSION);
    expect(await failure(() => filing(randomUUID(), 0, 0, 'exempt', null, 1))).toEqual({ code: 'P0002', message: 'ACCOUNTING_NOT_FOUND' });
    const key = randomUUID();
    const taxable = await filing(corporation.id, 0, 0, 'taxable', '2027-10-01', 1, key);
    expect([taxable.consumption_tax_status, taxable.consumption_taxable_from, taxable.version]).toEqual(['taxable', '2027-10-01', '2']);
    expect(await filing(corporation.id, 0, 0, 'taxable', '2027-10-01', 1, key)).toEqual(taxable);
    expect(await failure(() => filing(corporation.id, 0, 0, 'exempt', null, 1, key))).toEqual(KEY_CONFLICT);
    const exempt = await filing(corporation.id, 0, 0, 'exempt', null, 2);
    expect([exempt.consumption_tax_status, exempt.consumption_taxable_from, exempt.version]).toEqual(['exempt', null, '3']);
    // The filing entry never touches the dates or the business type.
    expect(await row(corporation.id)).toMatchObject({ starts_on: '2027-07-01', ends_on: '2028-06-30', business_type: 'corporation' });
  });

  test('FREQ-555-AC-04: 日付と事業の形から期間を引く道具は無ければPERIOD_MISSINGを返す', async () => {
    await switchTo('corporation');
    expect(await failure(() => forEvent('2026-05-01'))).toEqual(MISSING);
    expect(await failure(() => forEvent(null as unknown as string))).toEqual(INVALID);
    expect(await counts()).toEqual({ sole: 0, corporation: 0 });
  });

  test('FREQ-555-AC-04: 日から期間を引く道具は、期間が1つなら それ、個人と法人の両方があればcurrent_business_typeの期間、個人で期間が無ければ暦年の期間を作り、法人で無ければPERIOD_MISSINGを返す', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    const corporation = await create('corporation', '2026-10-01', '2027-09-30');
    const label = new Map([[sole.id, 'sole2026'], [corporation.id, 'corporation1']]);
    // Each lookup runs in a savepoint that is rolled back, so a period it creates does not change the next answer.
    const lookup = async (date: string) => {
      await db().query('savepoint acc_lookup');
      try {
        const id = await forEvent(date, admin);
        if (!label.has(id)) {
          const created = await one(`select business_type, to_char(starts_on, 'YYYY-MM-DD') as starts_on, legacy_fiscal_year,
            created_by = $2::uuid as by_actor from public.accounting_periods where id = $1`, [id, admin]);
          return `created:${created.business_type}:${created.starts_on}:${created.legacy_fiscal_year}:${created.by_actor}`;
        }
        return label.get(id);
      } catch (caught) {
        const e = caught as { message?: string; detail?: string };
        return e.detail ? `${e.message}:${e.detail}` : e.message;
      } finally {
        await db().query('rollback to savepoint acc_lookup');
        await db().query('release savepoint acc_lookup');
      }
    };
    const asSole: [string, string | undefined][] = [];
    for (const date of ['2026-05-01', '2026-11-01', '2027-03-01', '2025-06-01']) asSole.push([date, await lookup(date)]);
    expect(asSole).toEqual([
      ['2026-05-01', 'sole2026'],
      ['2026-11-01', 'sole2026'],
      ['2027-03-01', 'corporation1'],
      ['2025-06-01', 'created:soleProprietor:2025-01-01:2025:true'],
    ]);
    await switchTo('corporation');
    const asCorporation: [string, string | undefined][] = [];
    for (const date of ['2026-11-01', '2026-05-01', '2027-03-01', `${year + 1}-12-31`]) asCorporation.push([date, await lookup(date)]);
    expect(asCorporation).toEqual([
      ['2026-11-01', 'corporation1'],
      ['2026-05-01', 'sole2026'],
      ['2027-03-01', 'corporation1'],
      [`${year + 1}-12-31`, 'ACCOUNTING_PERIOD_MISSING'],
    ]);
    // Without the savepoint the created period stays: missing years in between are created too, without a gap.
    await switchTo('soleProprietor');
    await forEvent(`${year + 1}-12-01`, admin);
    const soleYears = (await db().query(`select extract(year from starts_on)::int as y, legacy_fiscal_year as l
      from public.accounting_periods where business_type = 'soleProprietor' order by starts_on`)).rows;
    expect(soleYears).toEqual(Array.from({ length: year + 1 - 2026 + 1 }, (_, i) => ({ y: 2026 + i, l: 2026 + i })));
    expect(await failure(async () => undefined)).toBeNull();
  });

  test('FREQ-555-AC-01: 範囲の外の年の個人の期間は作らず断る', async () => {
    expect(await failure(() => forEvent('2024-12-31'))).toEqual(INVALID);
    expect(await failure(() => forEvent(`${year + 2}-01-01`))).toEqual(INVALID);
    expect(await failure(() => ensure(2024))).toEqual(INVALID);
    expect(await counts()).toEqual({ sole: 0, corporation: 0 });
    await updateSettings('2026-03-01', 'soleProprietor', 1);
    expect(await failure(() => forEvent('2025-06-01'))).toEqual(INVALID);
    const created = await forEvent('2026-03-01', admin);
    expect(await row(created)).toMatchObject({ starts_on: '2026-01-01', ends_on: '2026-12-31' });
    // The year that exists is reused (nothing is created).
    expect(await ensure(2026)).toEqual([]);
    expect(await counts()).toEqual({ sole: 1, corporation: 0 });
  });

  test('FREQ-555-AC-07: 個人の最後の期間をやめた日まで短くし期間と設定の版が増え、同じ要求の再送は増えない', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    const key = randomUUID();
    const shortened = await shorten(sole.id, '2026-06-30', 1, 1, null, key);
    expect([shortened.ends_on, shortened.version]).toEqual(['2026-06-30', '2']);
    const after = await settings();
    expect([after.sole_business_ended_on, after.version, after.sole_end_changes.length]).toEqual(['2026-06-30', '2', 1]);
    const record = (await settingsRow()).sole_end_changes[0];
    expect(record).toEqual({ previousEndedOn: null, newEndedOn: '2026-06-30', reason: null, changedBy: admin,
      changedAt: expect.any(String), requestKey: key });
    // The same request again: the first result, no new version or record (before the version check).
    expect(await shorten(sole.id, '2026-06-30', 1, 1, null, key)).toEqual(shortened);
    expect(await failure(() => shorten(sole.id, '2026-06-30', 1, 1, 'other', key))).toEqual(KEY_CONFLICT);
    // Another request for the day already registered returns the period and changes nothing.
    expect(await shorten(sole.id, '2026-06-30', 2, 2)).toEqual(shortened);
    expect([(await row(sole.id)).version, (await settings()).version, (await settings()).sole_end_changes.length]).toEqual(['2', '2', 1]);
    expect(await failure(async () => undefined)).toBeNull();
  });

  test('FREQ-555-AC-07: 年末の日を指定して長さが変わらない場合も最後の期間として登録できる', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    const registered = await shorten(sole.id, '2026-12-31', 1, 1);
    expect([registered.ends_on, registered.version]).toEqual(['2026-12-31', '2']);
    expect(await settings()).toMatchObject({ sole_business_ended_on: '2026-12-31', version: '2' });
    expect(await failure(async () => undefined)).toBeNull();
  });

  test('FREQ-555-AC-07: 後の日の仕訳が1件でもある時と後の個人の期間がある時は短くせず全て元のまま残る', async () => {
    const sole2026 = await create('soleProprietor', '2026-01-01', '2026-12-31');
    const sole2027 = await create('soleProprietor', '2027-01-01', '2027-12-31');
    const snapshot = async () => [await row(sole2026.id), await row(sole2027.id), await settingsRow()];
    const before = await snapshot();
    expect(await failure(() => shorten(sole2026.id, '2026-06-30', 1, 1))).toEqual(BLOCKED);
    expect(await failure(() => shorten(sole2026.id, '2026-12-31', 1, 1))).toEqual(BLOCKED);
    // An entry after the new day (here an original and its reversal on the same day) blocks the shortening.
    const original = await postJournal(db(), { periodId: sole2027.id, entryDate: '2027-08-01', kind: 'payment_confirmed', parts: ['pi_late'], lines: SALE });
    await reverse(original.entryId);
    expect(await failure(() => shorten(sole2027.id, '2027-06-30', 1, 1))).toEqual(BLOCKED);
    expect(await failure(() => shorten(sole2027.id, '2027-07-31', 1, 1))).toEqual(BLOCKED);
    expect(await snapshot()).toEqual(before);
    // On the day of the entry itself it is allowed.
    expect((await shorten(sole2027.id, '2027-08-01', 1, 1)).ends_on).toBe('2027-08-01');
  });

  test('FREQ-555-AC-07: 権限なしと期間の版違いと設定の版違いは断る', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    const corporation = await create('corporation', '2027-07-01', '2028-06-30');
    const before = [await row(sole.id), await settingsRow()];
    expect(await failure(() => shorten(sole.id, '2026-06-30', 1, 1, null, randomUUID(), randomUUID()))).toEqual(FORBIDDEN);
    expect(await failure(() => shorten(sole.id, '2026-06-30', 2, 1))).toEqual(VERSION);
    expect(await failure(() => shorten(sole.id, '2026-06-30', 1, 2))).toEqual(VERSION);
    expect(await failure(() => shorten(corporation.id, '2028-03-31', 1, 1))).toEqual(INVALID);
    expect(await failure(() => shorten(randomUUID(), '2026-06-30', 1, 1))).toEqual({ code: 'P0002', message: 'ACCOUNTING_NOT_FOUND' });
    expect([await row(sole.id), await settingsRow()]).toEqual(before);
  });

  test('FREQ-555-AC-07: 締まっていない最後の個人の期間なら、やめた日を縮めても延ばしても選び直せ、前の日・理由・人・時刻が追記の記録に残り、直接のUPDATEでは消せず、やめた日だけの直接のUPDATEも断る', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    await shorten(sole.id, '2026-12-31', 1, 1);
    expect((await shorten(sole.id, '2026-06-30', 2, 2, 'closed early')).ends_on).toBe('2026-06-30');
    expect((await shorten(sole.id, '2026-09-30', 3, 3, 'reopened for a while')).ends_on).toBe('2026-09-30');
    const records = (await settingsRow()).sole_end_changes;
    expect(records.map((r: Record<string, unknown>) => [r.previousEndedOn, r.newEndedOn, r.reason, r.changedBy])).toEqual([
      [null, '2026-12-31', null, admin],
      ['2026-12-31', '2026-06-30', 'closed early', admin],
      ['2026-06-30', '2026-09-30', 'reopened for a while', admin],
    ]);
    expect(records.every((r: Record<string, unknown>) => typeof r.changedAt === 'string')).toBe(true);
    // The read returns the change record without the person.
    expect(Object.keys((await settings()).sole_end_changes[1]).sort()).toEqual(['changedAt', 'newEndedOn', 'previousEndedOn', 'reason']);
    expect(await settings()).toMatchObject({ sole_business_ended_on: '2026-09-30', version: '4' });
    const before = await settingsRow();
    for (const statement of [
      "update public.accounting_settings set sole_end_changes = '[]'::jsonb",
      'update public.accounting_settings set sole_end_changes = sole_end_changes - 0',
      `update public.accounting_settings set sole_end_changes = jsonb_set(sole_end_changes, '{1,reason}', '"edited"')`,
      "update public.accounting_settings set sole_business_ended_on = '2026-08-31'",
      'update public.accounting_settings set sole_business_ended_on = null',
      "update public.accounting_settings set cutover_on = '2026-01-01'",
    ]) {
      expect({ statement, result: await failure(() => db().query(statement)) }).toEqual({ statement, result: IMMUTABLE });
    }
    expect(await settingsRow()).toEqual(before);
    expect(await failure(async () => undefined)).toBeNull();
  });

  test('FREQ-555-AC-07: やめた日と一致する記録1件だけを直接書き期間を動かさないUPDATEはコミットの時にPERIOD_SHORTEN_BLOCKEDで断られ、設定も期間も元のまま残る', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    const before = [await row(sole.id), await settingsRow()];
    const record = JSON.stringify([{ previousEndedOn: null, newEndedOn: '2026-06-30', reason: null, changedBy: admin,
      changedAt: '2026-11-07T00:00:00Z', requestKey: randomUUID() }]);
    expect(await failure(() => db().query(`update public.accounting_settings set sole_business_ended_on = '2026-06-30',
      sole_end_changes = $1::jsonb, version = version + 1`, [record]))).toEqual(BLOCKED);
    // A record with a wrong shape is refused at once.
    const wrong = JSON.stringify([{ previousEndedOn: null, newEndedOn: '2026-05-31', reason: null, changedBy: admin,
      changedAt: '2026-11-07T00:00:00Z', requestKey: randomUUID() }]);
    expect(await failure(() => db().query(`update public.accounting_settings set sole_business_ended_on = '2026-06-30',
      sole_end_changes = $1::jsonb`, [wrong]))).toEqual(IMMUTABLE);
    expect([await row(sole.id), await settingsRow()]).toEqual(before);
  });

  test('FREQ-555-AC-07: 選び直しは理由が無いと断り、縮める時は新しい日より後の日付の仕訳が1件でもあれば断り、延ばす時は同じ年の12月31日を超えると断る', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    await shorten(sole.id, '2026-09-30', 1, 1);
    expect(await failure(() => shorten(sole.id, '2026-06-30', 2, 2))).toEqual(INVALID);
    expect(await failure(() => shorten(sole.id, '2026-06-30', 2, 2, '  '))).toEqual(INVALID);
    expect(await failure(() => shorten(sole.id, '2026-06-30', 2, 2, 'x'.repeat(501)))).toEqual(INVALID);
    await postJournal(db(), { periodId: sole.id, entryDate: '2026-07-15', kind: 'payment_confirmed', parts: ['pi_july'], lines: SALE });
    expect(await failure(() => shorten(sole.id, '2026-06-30', 2, 2, 'too early'))).toEqual(BLOCKED);
    expect(await failure(() => shorten(sole.id, '2027-01-01', 2, 2, 'next year'))).toEqual(INVALID);
    expect(await failure(() => shorten(sole.id, '2025-12-31', 2, 2, 'before'))).toEqual(INVALID);
    expect((await shorten(sole.id, '2026-12-31', 2, 2, 'back to the year end')).ends_on).toBe('2026-12-31');
    // A taxable day after the new end is refused (the period keeps its taxable day).
    await filing(sole.id, 0, 0, 'taxable', '2026-10-01', 3);
    expect(await failure(() => shorten(sole.id, '2026-09-30', 4, 3, 'taxable later'))).toEqual(INVALID);
  });

  test('FREQ-555-AC-09: 早すぎるやめた日を登録しても、current_business_typeが個人のままならそれより後の日付の個人の取引は法人の期間へ入らずPERIOD_MISSINGで止まり、法人へ切り替えるかやめた日を選び直すと入る', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    const corporation = await create('corporation', '2026-07-01', '2027-06-30');
    await shorten(sole.id, '2026-03-31', 1, 1);
    expect(await failure(() => forEvent('2026-05-01'))).toEqual(NOT_SWITCHED);
    expect(await failure(() => forEvent('2026-08-01'))).toEqual(NOT_SWITCHED);
    expect(await forEvent('2026-03-31')).toBe(sole.id);
    // Re-selecting the day lets the sole transaction in again.
    await shorten(sole.id, '2026-06-30', 2, 2, 'typo');
    expect(await forEvent('2026-05-01')).toBe(sole.id);
    expect(await failure(() => forEvent('2026-08-01'))).toEqual(NOT_SWITCHED);
    // Switching to the corporation lets the later day into the corporation period.
    await switchTo('corporation');
    expect(await forEvent('2026-08-01')).toBe(corporation.id);
    expect(await failure(async () => undefined)).toBeNull();
  });

  test('FREQ-555-AC-08: current_business_typeが個人のままでもやめた日より後の個人の期間を自動でも手動でも作れず最後の期間を延ばさない', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    await shorten(sole.id, '2026-06-30', 1, 1);
    expect(await failure(() => forEvent('2027-02-01'))).toEqual(NOT_SWITCHED);
    expect(await failure(() => forEvent('2026-08-01'))).toEqual(NOT_SWITCHED);
    expect(await failure(() => ensure(2027))).toEqual(MISSING);
    expect(await ensure(2026)).toEqual([]);
    expect(await failure(() => create('soleProprietor', '2027-01-01', '2027-12-31'))).toEqual(INVALID);
    const later = `insert into public.accounting_periods (business_type, name, starts_on, ends_on)
      values ('soleProprietor', 'p', '2027-01-01', '2027-12-31')`;
    // A direct insert of a later sole period is refused at COMMIT: after a shortened year it leaves a gap ...
    expect(await failure(() => db().query(later))).toEqual({ code: '23514', message: 'ACCOUNTING_PERIOD_GAP' });
    expect(await row(sole.id)).toMatchObject({ ends_on: '2026-06-30' });
    expect(await counts()).toEqual({ sole: 1, corporation: 0 });
    // ... and after an end day on 31 December it no longer matches the last sole period.
    await shorten(sole.id, '2026-12-31', 2, 2, 'worked to the year end');
    expect(await failure(() => forEvent('2027-02-01'))).toEqual(NOT_SWITCHED);
    expect(await failure(() => db().query(later))).toEqual(BLOCKED);
    expect(await counts()).toEqual({ sole: 1, corporation: 0 });
  });

  test('FREQ-555-AC-08: やめた日より後は、current_business_typeが法人で法人の期間があればそれを返し、個人のままなら法人の期間があってもPERIOD_MISSINGを返す', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    const corporation = await create('corporation', '2026-07-01', '2027-06-30');
    await shorten(sole.id, '2026-06-30', 1, 1);
    expect(await failure(() => forEvent('2026-08-01'))).toEqual(NOT_SWITCHED);
    await switchTo('corporation');
    expect(await forEvent('2026-08-01')).toBe(corporation.id);
    expect(await forEvent('2026-06-30')).toBe(sole.id);
    expect(await failure(() => forEvent('2027-08-01'))).toEqual(MISSING);
    expect(await counts()).toEqual({ sole: 1, corporation: 1 });
  });

  test('FREQ-554-AC-04: 取り消す日の個人の期間が無ければ元の事業の形で暦年の期間を作り、やめた日より後の年と法人の期間は作らずPERIOD_MISSINGを返す', async () => {
    const sole2025 = await create('soleProprietor', '2025-01-01', '2025-12-31');
    const first = await postJournal(db(), { periodId: sole2025.id, entryDate: '2025-05-01', kind: 'payment_confirmed', parts: ['pi_r1'], lines: SALE });
    const second = await postJournal(db(), { periodId: sole2025.id, entryDate: '2025-06-01', kind: 'payment_confirmed', parts: ['pi_r2'], lines: SALE });
    const reversal = await reverse(first.entryId, '2026-01-10');
    const created = await one(`select business_type, to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on,
      legacy_fiscal_year from public.accounting_periods where id = $1`, [reversal.period_id]);
    expect(created).toEqual({ business_type: 'soleProprietor', starts_on: '2026-01-01', ends_on: '2026-12-31', legacy_fiscal_year: 2026 });
    await shorten(reversal.period_id, '2026-09-30', 1, 1);
    expect(await failure(() => reverse(second.entryId, '2027-01-10'))).toEqual(MISSING);
    expect(await failure(() => reverse(second.entryId, '2026-10-15'))).toEqual(MISSING);
    // A corporation period is never created by a reversal.
    const corporation = await create('corporation', '2027-07-01', '2028-06-30');
    const corporate = await postJournal(db(), { periodId: corporation.id, entryDate: '2027-08-01', kind: 'payment_confirmed', parts: ['pi_c1'], lines: SALE });
    expect(await failure(() => reverse(corporate.entryId, '2028-08-01'))).toEqual(MISSING);
    expect(await counts()).toEqual({ sole: 2, corporation: 1 });
    expect(await failure(async () => undefined)).toBeNull();
  });

  test('FREQ-554-AC-04: 法人へ切り替えた後も、個人と法人が重なる日の個人の仕訳を元の日のまま個人の期間で取り消せる', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    const corporation = await create('corporation', '2026-04-01', '2027-03-31');
    const original = await postJournal(db(), { periodId: sole.id, entryDate: '2026-05-01', kind: 'payment_confirmed', parts: ['pi_switch'], lines: SALE });
    await switchTo('corporation');
    expect(await forEvent('2026-05-01')).toBe(corporation.id);
    const reversal = await reverse(original.entryId);
    expect([reversal.period_id, await periodOf(reversal.entry_id)]).toEqual([sole.id, sole.id]);
    expect((await one('select to_char(entry_date, \'YYYY-MM-DD\') as d from public.accounting_journal_entries where id = $1', [reversal.entry_id])).d)
      .toBe('2026-05-01');
    expect(await failure(async () => undefined)).toBeNull();
  });
});
