/** @jest-environment node */
import { describeLocalDb } from './helpers/local-db';
import {
  accountingFailure, createAccountingPeriod, insertAccountingAdmin, postJournal, type AccountingBusinessType,
  type JournalLineInput,
} from './helpers/accounting-fixtures';

// Accounting plan 1 S3 (FREQ-555 AC-02, AC-03, AC-06): the opening balances. Every test runs in BEGIN ... ROLLBACK
// (controller only, local DB). Amounts are signed: debit - credit.
type Opening = { account_code: string; signed_amount: number; basis: string };

describeLocalDb('S3 opening balances: controller only', (db) => {
  let admin: string;
  let part = 0;
  beforeEach(async () => {
    await db().query('begin');
    admin = await insertAccountingAdmin(db());
  });
  afterEach(async () => { await db().query('rollback'); });

  const failure = (run: () => Promise<unknown>) => accountingFailure(db(), run);
  const create = async (businessType: AccountingBusinessType, startsOn: string, endsOn: string) =>
    (await createAccountingPeriod(db(), admin, { businessType, startsOn, endsOn })).id;
  const post = (periodId: string, entryDate: string, lines: JournalLineInput[]) =>
    postJournal(db(), { periodId, entryDate, kind: 'payment_confirmed', parts: [`pi_open_${part += 1}`], lines });
  const opening = async (periodId: string): Promise<Opening[]> => (await db().query(
    'select account_code, signed_amount::int as signed_amount, basis from public.get_accounting_opening($1::uuid)', [periodId])).rows;
  const asMap = (rows: Opening[]) => Object.fromEntries(rows.map((r) => [r.account_code, r.signed_amount]));
  const store = (periodId: string, rows: { account_code: string; signed_amount: number }[], version: number, source: string,
    sourcePeriodId: string | null) => db().query(
    'select private.accounting_store_opening($1::uuid, $2::uuid, $3::jsonb, $4::integer, $5::text, $6::uuid) as n',
    [admin, periodId, JSON.stringify(rows), version, source, sourcePeriodId]).then((r) => r.rows[0].n as number);

  /** One sole year with a contribution, a sale, an expense, owner draws (1910 and 1920) and a loan. */
  async function soleYear(periodId: string, y: number): Promise<void> {
    await post(periodId, `${y}-01-05`, [{ account: '1010', debit: 500000 }, { account: '2920', credit: 500000 }]);
    await post(periodId, `${y}-03-01`, [{ account: '1130', debit: 300000 }, { account: '4010', credit: 300000 }]);
    await post(periodId, `${y}-04-01`, [{ account: '6010', debit: 80000 }, { account: '1010', credit: 80000 }]);
    await post(periodId, `${y}-05-01`, [{ account: '1910', debit: 50000 }, { account: '1010', credit: 50000 }]);
    await post(periodId, `${y}-06-01`, [{ account: '1920', debit: 10000 }, { account: '1130', credit: 10000 }]);
    await post(periodId, `${y}-07-01`, [{ account: '1010', debit: 100000 }, { account: '2110', credit: 100000 }]);
  }

  test('FREQ-555-AC-03: 個人の翌年の期首は元入金＝資産−負債で事業主貸と事業主借と損益が0になる', async () => {
    const y2026 = await create('soleProprietor', '2026-01-01', '2026-12-31');
    const y2027 = await create('soleProprietor', '2027-01-01', '2027-12-31');
    const y2028 = await create('soleProprietor', '2028-01-01', '2028-12-31');
    expect(await opening(y2026)).toEqual([]);
    await soleYear(y2026, 2026);
    // 2910 credit = 0 (previous 2910) + 220000 (income before the deduction: 300000 - 80000) + 500000 (owner
    // contribution 2920) - 60000 (owner draws 1910 + 1920) = 660000; assets 470000 + 290000 - liability 100000 = 660000.
    const next = await opening(y2027);
    expect(next).toEqual([
      { account_code: '1010', signed_amount: 470000, basis: 'carryover' },
      { account_code: '1130', signed_amount: 290000, basis: 'carryover' },
      { account_code: '2110', signed_amount: -100000, basis: 'carryover' },
      { account_code: '2910', signed_amount: -660000, basis: 'carryover' },
    ]);
    expect(next.reduce((sum, r) => sum + r.signed_amount, 0)).toBe(0);
    // Two years on (recursive): the 2027 opening plus the 2027 entries.
    await soleYear(y2027, 2027);
    expect(asMap(await opening(y2028))).toEqual({ 1010: 940000, 1130: 580000, 2110: -200000, 2910: -1320000 });
    expect(await failure(async () => undefined)).toBeNull();
  });

  test('FREQ-555-AC-02: 個人の最後の期間の期末は法人の第1期の期首に写らない', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    await soleYear(sole, 2026);
    const first = await create('corporation', '2027-01-01', '2027-12-31');
    expect(await opening(first)).toEqual([]);
    const trial = (await db().query('select account_code, opening_signed::int as o from public.get_accounting_trial_balance($1::uuid)',
      [first])).rows;
    expect(trial).toEqual([]);
  });

  test('FREQ-555-AC-03: 法人の第1期は全勘定と在庫が0で個人の最後の期間に在庫があっても変わらない', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    await post(sole, '2026-02-01', [{ account: '1310', debit: 250000 }, { account: '1010', credit: 250000 }]);
    await post(sole, '2026-02-02', [{ account: '1010', debit: 250000 }, { account: '2920', credit: 250000 }]);
    const first = await create('corporation', '2026-07-01', '2027-06-30');
    expect(asMap(await opening(await create('soleProprietor', '2027-01-01', '2027-12-31')))).toMatchObject({ 1310: 250000 });
    expect(await opening(first)).toEqual([]);
    // A stored initial opening of the first corporation term must be all zero (3-c).
    expect(await failure(() => store(first, [{ account_code: '1310', signed_amount: 250000 },
      { account_code: '3010', signed_amount: -250000 }], 1, 'initial', null)))
      .toEqual({ code: '55000', message: 'ACCOUNTING_OPENING_TYPE_MISMATCH' });
    expect(await store(first, [{ account_code: '1310', signed_amount: 0 }], 1, 'initial', null)).toBe(1);
    expect(await opening(first)).toEqual([{ account_code: '1310', signed_amount: 0, basis: 'stored' }]);
  });

  test('FREQ-555-AC-03: 法人の次の期は損益が0になり繰越利益剰余金へ当期純利益が入る', async () => {
    const term1 = await create('corporation', '2027-07-01', '2028-06-30');
    const term2 = await create('corporation', '2028-07-01', '2029-06-30');
    expect(await opening(term1)).toEqual([]);
    await post(term1, '2027-07-01', [{ account: '1010', debit: 1000000 }, { account: '3010', credit: 1000000 }]);
    await post(term1, '2027-08-01', [{ account: '1130', debit: 400000 }, { account: '4010', credit: 400000 }]);
    await post(term1, '2027-09-01', [{ account: '6010', debit: 150000 }, { account: '1010', credit: 150000 }]);
    expect(await opening(term2)).toEqual([
      { account_code: '1010', signed_amount: 850000, basis: 'carryover' },
      { account_code: '1130', signed_amount: 400000, basis: 'carryover' },
      { account_code: '3010', signed_amount: -1000000, basis: 'carryover' },
      { account_code: '3040', signed_amount: -250000, basis: 'carryover' },
    ]);
  });

  test('FREQ-555-AC-02: 事業の形が違う期間を元にした期首の保存を断る', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    const sole2027 = await create('soleProprietor', '2027-01-01', '2027-12-31');
    const term1 = await create('corporation', '2027-01-01', '2027-12-31');
    const term2 = await create('corporation', '2028-01-01', '2028-12-31');
    const rows = [{ account_code: '1010', signed_amount: 1000 }, { account_code: '3040', signed_amount: -1000 }];
    const mismatch = { code: '55000', message: 'ACCOUNTING_OPENING_TYPE_MISMATCH' };
    expect(await failure(() => store(term2, rows, 1, 'closing_carryover', sole))).toEqual(mismatch);
    expect(await failure(() => store(sole2027, [{ account_code: '1010', signed_amount: 1000 },
      { account_code: '2910', signed_amount: -1000 }], 1, 'closing_carryover', term1))).toEqual(mismatch);
    // 3-f: the stored opening balances (assets - liabilities = capital) and keeps P/L and owner accounts at zero.
    const unbalanced = { code: '23514', message: 'ACCOUNTING_OPENING_UNBALANCED' };
    expect(await failure(() => store(term2, [{ account_code: '1010', signed_amount: 1000 },
      { account_code: '3040', signed_amount: -900 }], 1, 'closing_carryover', term1))).toEqual(unbalanced);
    expect(await failure(() => store(sole2027, [{ account_code: '1910', signed_amount: 1000 },
      { account_code: '2910', signed_amount: -1000 }], 1, 'closing_carryover', sole))).toEqual(unbalanced);
    const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
    for (const bad of [
      () => store(term2, [], 1, 'closing_carryover', term1),
      () => store(term2, [{ account_code: '0000', signed_amount: 0 }], 1, 'closing_carryover', term1),
      () => store(term2, [{ account_code: '1010', signed_amount: 1.5 }, { account_code: '3040', signed_amount: -1.5 }], 1, 'closing_carryover', term1),
      () => store(term2, [{ account_code: '1010', signed_amount: 0 }, { account_code: '1010', signed_amount: 0 }], 1, 'closing_carryover', term1),
      () => store(term2, rows, 0, 'closing_carryover', term1),
      () => store(term2, rows, 1, 'closing_carryover', null),
      () => store(term2, rows, 1, 'initial', term1),
      () => store(term2, rows, 1, 'other', term1),
    ]) expect(await failure(bad)).toEqual(invalid);
    expect(await store(term2, rows, 1, 'closing_carryover', term1)).toBe(2);
    expect(await failure(() => store(term2, rows, 1, 'closing_carryover', term1))).toEqual(invalid);
    expect(await failure(async () => undefined)).toBeNull();
  });

  test('FREQ-555-AC-02: 繰越の期首は同じ事業の形の直前の期間からだけ保存でき、後の期間・自分・離れた期間を元にした物と法人の第1期への繰越は断る', async () => {
    const term1 = await create('corporation', '2027-01-01', '2027-12-31');
    const term2 = await create('corporation', '2028-01-01', '2028-12-31');
    const term3 = await create('corporation', '2029-01-01', '2029-12-31');
    const rows = [{ account_code: '1010', signed_amount: 1000 }, { account_code: '3040', signed_amount: -1000 }];
    const mismatch = { code: '55000', message: 'ACCOUNTING_OPENING_TYPE_MISMATCH' };
    // Into the first term (it has no previous period), here from a later term.
    expect(await failure(() => store(term1, rows, 1, 'closing_carryover', term2))).toEqual(mismatch);
    // From the period itself, from a later period, and from an earlier but not adjacent period.
    expect(await failure(() => store(term2, rows, 1, 'closing_carryover', term2))).toEqual(mismatch);
    expect(await failure(() => store(term2, rows, 1, 'closing_carryover', term3))).toEqual(mismatch);
    expect(await failure(() => store(term3, rows, 1, 'closing_carryover', term1))).toEqual(mismatch);
    // The immediately preceding period of the same business type is accepted; the first term stays at zero.
    expect(await store(term2, rows, 1, 'closing_carryover', term1)).toBe(2);
    expect(await opening(term2)).toEqual([
      { account_code: '1010', signed_amount: 1000, basis: 'stored' }, { account_code: '3040', signed_amount: -1000, basis: 'stored' }]);
    expect(await opening(term1)).toEqual([]);
    expect(await failure(async () => undefined)).toBeNull();
  });

  test('FREQ-555-AC-06: 期首は個人なら最も新しい版、法人なら版1の行を選び版2は使わない', async () => {
    const sole = await create('soleProprietor', '2026-01-01', '2026-12-31');
    const sole2027 = await create('soleProprietor', '2027-01-01', '2027-12-31');
    const term1 = await create('corporation', '2027-01-01', '2027-12-31');
    const term2 = await create('corporation', '2028-01-01', '2028-12-31');
    await store(sole2027, [{ account_code: '1010', signed_amount: 100 }, { account_code: '2910', signed_amount: -100 }], 1, 'closing_carryover', sole);
    await store(sole2027, [{ account_code: '1010', signed_amount: 300 }, { account_code: '2910', signed_amount: -300 }], 2, 'closing_carryover', sole);
    expect(await opening(sole2027)).toEqual([
      { account_code: '1010', signed_amount: 300, basis: 'stored' }, { account_code: '2910', signed_amount: -300, basis: 'stored' }]);
    await store(term2, [{ account_code: '1010', signed_amount: 500 }, { account_code: '3040', signed_amount: -500 }], 1, 'closing_carryover', term1);
    await store(term2, [{ account_code: '1010', signed_amount: 700 }, { account_code: '3040', signed_amount: -700 }], 2, 'closing_carryover', term1);
    expect(await opening(term2)).toEqual([
      { account_code: '1010', signed_amount: 500, basis: 'stored' }, { account_code: '3040', signed_amount: -500, basis: 'stored' }]);
    // The stored rows are append only.
    const immutable = { code: '55000', message: 'ACCOUNTING_HISTORY_IMMUTABLE' };
    for (const statement of ['update public.accounting_opening_balances set signed_amount = 0',
      'delete from public.accounting_opening_balances', 'truncate table public.accounting_opening_balances']) {
      expect({ statement, result: await failure(async () => {
        await db().query('set constraints all immediate');
        await db().query(statement);
      }) }).toEqual({ statement, result: immutable });
    }
  });
});
