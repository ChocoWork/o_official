/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import {
  accountingFailure, createAccountingPeriod, insertAccountingAdmin, japanToday, type AccountingBusinessType,
} from './helpers/accounting-fixtures';

// Accounting plan 1 S4 (FREQ-556 AC-01..AC-06): manual transactions become journal entries through the trigger on
// public.admin_finance_expenses, the rows are only removed logically and the revision history is append only.
// Every DB test runs inside BEGIN ... ROLLBACK (controller only, local DB; commit suites run last with a reset).
const directory = path.join(process.cwd(), 'supabase/migrations');
const s4Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p1_manual_entry_journal.sql'));
const s4Path = s4Files.length === 1 ? path.join(directory, s4Files[0]) : '';
const sql = s4Path ? fs.readFileSync(s4Path, 'utf8') : '';
const section = (name: string) => sql.split(`-- ${name}_BEGIN\n`)[1]?.split(`-- ${name}_END`)[0] ?? '';
const assertion = section('ACC_S4_FINAL_ASSERT');
const baselineStatement = section('ACC_S4_BASELINE');
const details = ['acc_s4_map_table', 'acc_s4_trigger', 'acc_s4_functions', 'acc_s4_legacy_trigger_untouched'];

describe('S4 source contract (no DB)', () => {
  test('FREQ-556-AC-01: S4はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(s4Path).not.toBe('');
    expect(path.basename(s4Path)).toBe('20261107130400_accounting_p1_manual_entry_journal.sql');
    expect(sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/-- ACC_S4_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect([...new Set([...assertion.matchAll(/'(acc_s4_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...details].sort());
    expect(assertion).not.toMatch(/ERRCODE = '(?!55000')/);
    // The body writes only the map rows and its own baseline; it never edits the existing history trigger or function.
    const body = section('ACC_S4_BODY').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')
      .replace(/AS \$\$[\s\S]*?\$\$;/g, 'AS $$ $$;');
    expect([...body.matchAll(/^(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+([\w.]+)/gm)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
      'INSERT INTO pg_temp.accounting_s4_baseline', 'INSERT INTO public.accounting_manual_category_map',
      'INSERT INTO public.accounting_manual_method_map',
    ]);
    // The history trigger itself is not touched; its function is replaced once, in place (FREQ-556-AC-06).
    expect(body).not.toMatch(/trigger_admin_finance_entry_revisions/);
    expect(body.match(/CREATE OR REPLACE FUNCTION public\.record_admin_finance_entry_revision\(\) RETURNS trigger\nLANGUAGE plpgsql SECURITY DEFINER SET search_path = ''\n/g)).toHaveLength(1);
    expect(body.match(/\bFUNCTION public\.record_admin_finance_entry_revision\b/g)).toHaveLength(2);
    expect(body.indexOf('CREATE TEMP TABLE accounting_s4_baseline')).toBeLessThan(body.indexOf('CREATE TABLE'));
  });
});

type Line = { account_code: string; debit: string; credit: string; counterparty: string | null; memo: string | null };
type Entry = {
  id: string; dedupe_key: string; event_kind: string; reason: string | null; entry_date: string; period: string;
  description: string; recorded_by: string | null; source_table: string | null; source_id: string | null;
  reverses_entry_id: string | null; lines: Line[];
};
type Expense = {
  date?: string; category?: string; item?: string; amount?: number; method?: string; type?: 'expense' | 'income';
  partner?: string; createdBy?: string | null; deletedAt?: string | null;
};

describeLocalDb('S4 manual entries: controller only', (db) => {
  const year = Number(japanToday().slice(0, 4));
  let admin: string;
  let editor: string;
  beforeEach(async () => {
    await db().query('begin');
    admin = await insertAccountingAdmin(db());
    editor = await insertUser();
  });
  afterEach(async () => { await db().query('rollback'); });

  const one = async (text: string, params: unknown[] = []) => (await db().query(text, params)).rows[0];
  const failure = (run: () => Promise<unknown>) => accountingFailure(db(), run);
  async function insertUser(): Promise<string> {
    const id = randomUUID();
    await db().query("insert into auth.users (id, raw_app_meta_data, raw_user_meta_data) values ($1, '{}', '{}')", [id]);
    return id;
  }
  /** Insert a transaction the way the route does (service_role). Returns its id. */
  async function insertExpense(input: Expense = {}): Promise<string> {
    await db().query('savepoint acc_s4_service');
    try {
      await db().query('set local role service_role');
      const row = await one(`insert into public.admin_finance_expenses (expense_date, category, item_name, amount, payment_method,
          entry_type, partner, created_by, deleted_at) values ($1::date, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz) returning id`,
      [input.date ?? `${year}-03-10`, input.category ?? '消耗品費', input.item ?? 'ペン', input.amount ?? 1200,
        input.method ?? 'クレジットカード', input.type ?? 'expense', input.partner ?? '文具店',
        input.createdBy === undefined ? admin : input.createdBy, input.deletedAt ?? null]);
      await db().query('reset role');
      await db().query('release savepoint acc_s4_service');
      return String(row.id);
    } catch (error) {
      await db().query('rollback to savepoint acc_s4_service');
      await db().query('release savepoint acc_s4_service');
      throw error;
    }
  }
  /** One UPDATE as service_role (the route's shape: a plain table write). */
  async function updateExpense(id: string, assignments: string, params: unknown[] = []): Promise<void> {
    await db().query('savepoint acc_s4_update');
    try {
      await db().query('set local role service_role');
      await db().query(`update public.admin_finance_expenses set ${assignments} where id = $1`, [id, ...params]);
      await db().query('reset role');
      await db().query('release savepoint acc_s4_update');
    } catch (error) {
      await db().query('rollback to savepoint acc_s4_update');
      await db().query('release savepoint acc_s4_update');
      throw error;
    }
  }
  /** The entries of one transaction in the order they were written, with their lines. */
  async function entriesOf(id: string): Promise<Entry[]> {
    return inWriteOrder((await db().query(`select e.id, e.dedupe_key, e.event_kind, e.reason, to_char(e.entry_date, 'YYYY-MM-DD') as entry_date,
        p.business_type || ':' || to_char(p.starts_on, 'YYYY-MM-DD') || '..' || to_char(p.ends_on, 'YYYY-MM-DD') as period,
        e.description, e.recorded_by, e.source_table, e.source_id, e.reverses_entry_id,
        (select jsonb_agg(jsonb_build_object('account_code', l.account_code, 'debit', l.debit::text, 'credit', l.credit::text,
          'counterparty', l.counterparty, 'memo', l.memo) order by l.line_no) from public.accounting_journal_lines l where l.entry_id = e.id) as lines
      from public.accounting_journal_entries e join public.accounting_periods p on p.id = e.period_id
      where e.source_table = 'admin_finance_expenses' and e.source_id = $1`, [id])).rows);
  }
  /**
   * The write order of one transaction's entries: the migrated entry, then manual entry 0, its reversal, manual entry 1,
   * ... (entry numbers restart in every period and recorded_at is the transaction time, so neither orders them).
   */
  function inWriteOrder(rows: Entry[]): Entry[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const rank = (row: Entry): number => {
      if (row.event_kind === 'migrated_entry') return -2;
      if (row.event_kind === 'manual_entry') return Number(row.dedupe_key.split(':')[2]) * 2;
      const original = row.reverses_entry_id ? byId.get(row.reverses_entry_id) : undefined;
      return original ? rank(original) + 1 : Number.MAX_SAFE_INTEGER;
    };
    return [...rows].sort((a, b) => rank(a) - rank(b));
  }
  const keys = async (id: string) => (await entriesOf(id)).map((e) => e.dedupe_key);
  const entryCount = async () => Number((await one('select count(*) as n from public.accounting_journal_entries')).n);
  const revisions = async (id: string) =>
    (await db().query('select operation, changed_by from public.admin_finance_entry_revisions where entry_id = $1 order by id', [id])).rows;
  const settings = async () => (await one('select public.get_accounting_settings() as r')).r;
  const switchTo = async (type: AccountingBusinessType) => {
    const current = await settings();
    await one('select public.admin_update_accounting_settings($1::uuid, $2::date, $3::text, $4::bigint, $5::uuid) as r',
      [admin, current.business_start_date, type, current.version, randomUUID()]);
  };
  const line = (account: string, debit: number, credit: number, counterparty: string | null = '文具店', memo: string | null = null): Line =>
    ({ account_code: account, debit: String(debit), credit: String(credit), counterparty, memo });
  const sole = (y: number) => `soleProprietor:${y}-01-01..${y}-12-31`;

  test('FREQ-556-AC-01: 手入力の支出の作成は借方が相手科目で貸方が資金科目の仕訳1本になり日は取引の日になる', async () => {
    const id = await insertExpense({ date: `${year}-03-10` });
    expect(await entriesOf(id)).toEqual([{
      id: expect.any(String), dedupe_key: `manual_entry:${id}:0`, event_kind: 'manual_entry', reason: null,
      entry_date: `${year}-03-10`, period: sole(year), description: 'ペン', recorded_by: admin,
      source_table: 'admin_finance_expenses', source_id: id, reverses_entry_id: null,
      lines: [line('6120', 1200, 0), line('2130', 0, 1200)],
    }]);
    // The partner is optional: an empty partner leaves the counterparty empty.
    const plain = await insertExpense({ partner: '', method: '現金' });
    expect((await entriesOf(plain))[0].lines).toEqual([line('6120', 1200, 0, null), line('1010', 0, 1200, null)]);
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-01: 収入は貸借が逆になる', async () => {
    const id = await insertExpense({ type: 'income', category: '売上高', item: '卸売', amount: 50000, method: '銀行', partner: '' });
    expect((await entriesOf(id)).map((e) => [e.dedupe_key, e.lines])).toEqual([
      [`manual_entry:${id}:0`, [line('1040', 50000, 0, null), line('4010', 0, 50000, null)]],
    ]);
    // The private funds follow the business type of the period (paymentMethodAccountName): sole income -> 1910.
    const privateIncome = await insertExpense({ type: 'income', category: '雑収入', method: 'プライベート', partner: '' });
    expect((await entriesOf(privateIncome))[0].lines).toEqual([line('1910', 1200, 0, null), line('4040', 0, 1200, null)]);
    const privateExpense = await insertExpense({ method: 'プライベート', partner: '' });
    expect((await entriesOf(privateExpense))[0].lines).toEqual([line('6120', 1200, 0, null), line('2920', 0, 1200, null)]);
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-01: 更新は元の仕訳の取り消しと正しい仕訳を足し元の仕訳は変わらない', async () => {
    const id = await insertExpense();
    const [original] = await entriesOf(id);
    await updateExpense(id, 'amount = 1500, updated_by = $2', [editor]);
    const after = await entriesOf(id);
    expect(after.map((e) => e.dedupe_key)).toEqual([`manual_entry:${id}:0`, `reversal:${original.id}`, `manual_entry:${id}:1`]);
    expect(after[0]).toEqual(original);
    expect(after[1]).toMatchObject({ event_kind: 'reversal', reason: 'edit', reverses_entry_id: original.id, entry_date: original.entry_date,
      description: 'ペン', recorded_by: editor, source_table: 'admin_finance_expenses', source_id: id,
      lines: [line('6120', 0, 1200), line('2130', 1200, 0)] });
    expect(after[2]).toMatchObject({ event_kind: 'manual_entry', reason: null, recorded_by: editor,
      lines: [line('6120', 1500, 0), line('2130', 0, 1500)] });
    // A second edit reverses the latest entry only and adds number 2.
    await updateExpense(id, "category = '雑費', updated_by = $2", [editor]);
    expect((await keys(id)).slice(3)).toEqual([`reversal:${after[2].id}`, `manual_entry:${id}:2`]);
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-01: 日付を別の年へ直すと取り消しは元の期間に正しい仕訳は新しい期間に入る', async () => {
    const id = await insertExpense({ date: `${year}-03-10` });
    await updateExpense(id, 'expense_date = $2::date, updated_by = $3', [`${year - 1}-12-20`, editor]);
    expect((await entriesOf(id)).map((e) => [e.event_kind, e.entry_date, e.period])).toEqual([
      ['manual_entry', `${year}-03-10`, sole(year)],
      ['reversal', `${year}-03-10`, sole(year)],
      ['manual_entry', `${year - 1}-12-20`, sole(year - 1)],
    ]);
    // The period the edit created is recorded as made by the editor (the actor of the write), the first by the creator.
    expect((await db().query(`select to_char(starts_on, 'YYYY') as y, created_by from public.accounting_periods
      where business_type = 'soleProprietor' order by starts_on`)).rows)
      .toEqual([{ y: `${year - 1}`, created_by: editor }, { y: `${year}`, created_by: admin }]);
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-01: 論理削除は取り消しだけを足し正しい仕訳は足さない', async () => {
    const id = await insertExpense();
    const [original] = await entriesOf(id);
    await updateExpense(id, 'deleted_at = now(), deleted_by = $2, updated_by = $2', [editor]);
    expect((await entriesOf(id)).map((e) => [e.dedupe_key, e.reason, e.recorded_by])).toEqual([
      [`manual_entry:${id}:0`, null, admin], [`reversal:${original.id}`, 'delete', editor],
    ]);
    // The reversal actor falls back to created_by when deleted_by is empty.
    const other = await insertExpense();
    await updateExpense(other, 'deleted_at = now()');
    expect((await entriesOf(other)).map((e) => [e.reason, e.recorded_by])).toEqual([[null, admin], ['delete', admin]]);
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-01: 仕訳に関わらない列だけの更新は仕訳を足さない', async () => {
    const id = await insertExpense();
    const before = await entryCount();
    await updateExpense(id, "memo = 'note', updated_by = $2", [editor]);
    await updateExpense(id, "fixed_asset_exempt = true, fixed_asset_exempt_reason = 'small', fixed_asset_reviewed_by = $2", [editor]);
    await updateExpense(id, 'created_by = $2, updated_by = null, deleted_by = $2', [editor]);
    await updateExpense(id, 'updated_at = now()');
    expect(await entryCount()).toBe(before);
    expect(await keys(id)).toEqual([`manual_entry:${id}:0`]);
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-01: 手入力の直しで直しの履歴の行は従来どおり1回ずつだけ増える', async () => {
    const id = await insertExpense();
    expect(await revisions(id)).toEqual([{ operation: 'insert', changed_by: admin }]);
    await updateExpense(id, 'amount = 2000, updated_by = $2', [editor]);
    expect(await revisions(id)).toEqual([{ operation: 'insert', changed_by: admin }, { operation: 'update', changed_by: editor }]);
    await updateExpense(id, 'deleted_at = now(), deleted_by = $2, updated_by = $2', [editor]);
    expect(await revisions(id)).toEqual([
      { operation: 'insert', changed_by: admin }, { operation: 'update', changed_by: editor }, { operation: 'delete', changed_by: editor },
    ]);
    // 1 + 2 + 1 journal entries; none of them wrote a history row.
    expect(await keys(id)).toHaveLength(4);
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-02: 個人で期間の無い年の取引は暦年の期間を間も含め作って入る', async () => {
    expect(Number((await one('select count(*) as n from public.accounting_periods')).n)).toBe(0);
    const first = await insertExpense({ date: `${year - 1}-05-01` });
    expect((await entriesOf(first))[0].period).toBe(sole(year - 1));
    const later = await insertExpense({ date: `${year + 1}-02-01` });
    expect((await entriesOf(later))[0].period).toBe(sole(year + 1));
    expect((await db().query(`select to_char(starts_on, 'YYYY') as y, created_by from public.accounting_periods
      where business_type = 'soleProprietor' order by starts_on`)).rows)
      .toEqual([`${year - 1}`, `${year}`, `${year + 1}`].map((y) => ({ y, created_by: admin })));
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-02: 法人で期間が無い日の取引はPERIOD_MISSINGで取引の行も残らない', async () => {
    await switchTo('corporation');
    const rows = Number((await one('select count(*) as n from public.admin_finance_expenses')).n);
    expect(await failure(() => insertExpense({ date: `${year}-03-10`, item: 'acc s4 missing' })))
      .toEqual({ code: '55000', message: 'ACCOUNTING_PERIOD_MISSING' });
    expect(Number((await one('select count(*) as n from public.admin_finance_expenses')).n)).toBe(rows);
    expect(await one("select count(*)::int as n from public.admin_finance_expenses where item_name = 'acc s4 missing'")).toEqual({ n: 0 });
    expect(await one('select count(*)::int as n from public.accounting_periods')).toEqual({ n: 0 });
    // An edit into a day without a period fails the same way and leaves the row and its entries as they were.
    await switchTo('soleProprietor');
    const id = await insertExpense({ date: `${year}-03-10` });
    await switchTo('corporation');
    expect(await failure(() => updateExpense(id, 'expense_date = $2::date', [`${year + 1}-03-10`])))
      .toEqual({ code: '55000', message: 'ACCOUNTING_PERIOD_MISSING' });
    expect(await one("select to_char(expense_date, 'YYYY-MM-DD') as d from public.admin_finance_expenses where id = $1", [id]))
      .toEqual({ d: `${year}-03-10` });
    expect(await keys(id)).toEqual([`manual_entry:${id}:0`]);
  });

  test('FREQ-556-AC-02: 個人と法人の期間が両方ある日はcurrent_business_typeの期間に入る', async () => {
    const soleEntry = await insertExpense({ date: `${year}-01-15` });
    await createAccountingPeriod(db(), admin, { businessType: 'corporation', startsOn: `${year}-07-01`, endsOn: `${year + 1}-06-30` });
    const both = await insertExpense({ date: `${year}-08-01` });
    await switchTo('corporation');
    const corporate = await insertExpense({ date: `${year}-08-02`, method: 'プライベート', partner: '' });
    expect((await entriesOf(soleEntry))[0].period).toBe(sole(year));
    expect((await entriesOf(both))[0].period).toBe(sole(year));
    expect((await entriesOf(corporate))[0]).toMatchObject({ period: `corporation:${year}-07-01..${year + 1}-06-30`,
      lines: [line('6120', 1200, 0, null), line('2120', 0, 1200, null)] });
    // An edit picks the period again; its reversal stays in the period of the original (sole).
    await updateExpense(both, 'amount = 999');
    expect((await entriesOf(both)).map((e) => [e.event_kind, e.period])).toEqual([
      ['manual_entry', sole(year)], ['reversal', sole(year)], ['manual_entry', `corporation:${year}-07-01..${year + 1}-06-30`],
    ]);
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-02: 手入力のトリガーが選ぶ期間は private.accounting_period_for_event の答えと同じ', async () => {
    type Outcome = { period: string } | { error: string; detail?: string };
    const periodText = (id: string) => one(`select business_type || ':' || to_char(starts_on, 'YYYY-MM-DD') || '..' || to_char(ends_on, 'YYYY-MM-DD') as t
      from public.accounting_periods where id = $1`, [id]).then((r) => r.t as string);
    async function outcome(run: () => Promise<string>): Promise<Outcome> {
      await db().query('savepoint acc_s4_outcome');
      try {
        const period = await periodText(await run());
        return { period };
      } catch (caught) {
        const e = caught as { message?: string; detail?: string };
        return e.detail ? { error: e.message ?? '', detail: e.detail } : { error: e.message ?? '' };
      } finally {
        await db().query('rollback to savepoint acc_s4_outcome');
        await db().query('release savepoint acc_s4_outcome');
      }
    }
    const viaTool = (date: string) => outcome(async () =>
      (await one('select private.accounting_period_for_event($1::date, $2::uuid) as id', [date, admin])).id);
    const viaTrigger = (date: string) => outcome(async () => {
      const id = await insertExpense({ date });
      return (await one(`select period_id from public.accounting_journal_entries where dedupe_key = $1`, [`manual_entry:${id}:0`])).period_id;
    });
    const dates = [`${year - 1}-06-01`, `${year}-01-01`, `${year}-06-30`, `${year}-07-01`, `${year}-12-31`, `${year + 1}-03-01`,
      `${year + 1}-12-31`, '2024-12-31', `${year + 2}-01-01`];
    const compare = async (label: string) => {
      for (const date of dates) {
        expect({ label, date, trigger: await viaTrigger(date) }).toEqual({ label, date, trigger: await viaTool(date) });
      }
    };
    await compare('no period, soleProprietor');
    await insertExpense({ date: `${year}-02-01` });
    const solePeriod = (await one(`select id, version from public.accounting_periods where business_type = 'soleProprietor'`));
    await createAccountingPeriod(db(), admin, { businessType: 'corporation', startsOn: `${year}-07-01`, endsOn: `${year + 1}-06-30` });
    await compare('sole year and corporation term');
    await switchTo('corporation');
    await compare('both, corporation');
    await switchTo('soleProprietor');
    const current = await settings();
    await one(`select public.admin_shorten_final_sole_period($1::uuid, $2::uuid, $3::date, $4::bigint, $5::bigint, null, $6::uuid) as r`,
      [admin, solePeriod.id, `${year}-06-30`, solePeriod.version, current.version, randomUUID()]);
    await compare('sole ended, not switched');
    expect(await viaTrigger(`${year}-07-01`)).toEqual({ error: 'ACCOUNTING_PERIOD_MISSING', detail: 'sole_ended_not_switched' });
    await switchTo('corporation');
    await compare('sole ended, corporation');
  });

  test('FREQ-556-AC-02: 開業日の年より前や今の年+1より先の日付は期間を作らず断る', async () => {
    for (const date of ['2024-12-31', `${year + 2}-01-01`]) {
      expect({ date, failure: await failure(() => insertExpense({ date, item: 'acc s4 window' })) })
        .toEqual({ date, failure: { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' } });
    }
    expect(await one('select count(*)::int as n from public.accounting_periods')).toEqual({ n: 0 });
    expect(await one("select count(*)::int as n from public.admin_finance_expenses where item_name = 'acc s4 window'")).toEqual({ n: 0 });
  });

  test('FREQ-556-AC-01: 削除済みで仕訳が無い行の更新は何もしない', async () => {
    // A row written as already deleted (service_role directly) has no entry and stays without one.
    const id = await insertExpense({ deletedAt: new Date().toISOString() });
    expect(await keys(id)).toEqual([]);
    await updateExpense(id, "amount = 3000, category = '雑費', deleted_at = deleted_at + interval '1 minute'");
    expect(await keys(id)).toEqual([]);
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-01: 削除済みの行の仕訳の列だけを直す更新（service_roleの直書き）は取り消し済みの行を帳簿に戻さない', async () => {
    const id = await insertExpense();
    await updateExpense(id, 'deleted_at = now(), deleted_by = $2', [editor]);
    const before = await keys(id);
    await updateExpense(id, "amount = 9000, expense_date = $2::date, category = '雑費'", [`${year}-04-01`]);
    expect(await keys(id)).toEqual(before);
    expect(before).toHaveLength(2);
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-01: 改版の番号はmanual_entryの本数で、A8の後の最初の直しは0になる', async () => {
    // A row as A8 (S5) leaves it: no manual entry, one migrated_entry with the same source. The ordinary journal
    // trigger does not fire in replica mode, which stands in for the migration's own write here.
    await db().query("set local session_replication_role = 'replica'");
    const id = await insertExpense({ date: `${year}-02-10` });
    await db().query("set local session_replication_role = 'origin'");
    expect(await keys(id)).toEqual([]);
    const periodId = (await one('select private.accounting_period_for_event($1::date, $2::uuid) as id', [`${year}-02-10`, admin])).id;
    const migrated = (await one(`select private.accounting_post_journal_core(null, $1::uuid, $2::date, 'migrated_entry', array[$3::text],
        'ペン', $4::jsonb, null, null, 'admin_finance_expenses', $3::text, now() - interval '1 day', 'admin_finance_expenses:' || $3::text, null) as r`,
    [periodId, `${year}-02-10`, id, JSON.stringify([
      { account_code: '6120', debit: 1200, credit: 0, sub_account: null, counterparty: '文具店', order_id: null, memo: null },
      { account_code: '2130', debit: 0, credit: 1200, sub_account: null, counterparty: '文具店', order_id: null, memo: null },
    ])])).r;
    await updateExpense(id, 'amount = 1300, updated_by = $2', [editor]);
    expect(await keys(id)).toEqual([`migrated_entry:${id}`, `reversal:${migrated.entry_id}`, `manual_entry:${id}:0`]);
    await updateExpense(id, 'amount = 1400, updated_by = $2', [editor]);
    expect((await keys(id)).slice(3)).toEqual([expect.stringMatching(/^reversal:/), `manual_entry:${id}:1`]);
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-03: 未登録の科目名は9999に入り元の名前がmemoに残る', async () => {
    const id = await insertExpense({ category: '登録されていない科目', method: '知らない払い方', partner: '' });
    expect((await entriesOf(id))[0].lines).toEqual([
      line('9999', 1200, 0, null, '登録されていない科目'), line('9999', 0, 1200, null, '知らない払い方'),
    ]);
    // An account name typed as the method resolves through the category map (paymentMethodAccountName returns it as is).
    const named = await insertExpense({ method: '普通預金', partner: '' });
    expect((await entriesOf(named))[0].lines).toEqual([line('6120', 1200, 0, null), line('1040', 0, 1200, null)]);
    // The memo keeps the full name (the table allows 80 characters; lines have no shorter limit).
    const long = 'あ'.repeat(80);
    const longId = await insertExpense({ category: long, partner: '' });
    expect((await entriesOf(longId))[0].lines[0]).toEqual(line('9999', 1200, 0, null, long));
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-05: 取引の行のDELETEと、直しの履歴のchanged_byをNULLにする1つ以外のUPDATEとDELETEとTRUNCATEは断られる', async () => {
    const id = await insertExpense();
    await updateExpense(id, 'amount = 1300, updated_by = $2', [editor]);
    const revisionId = (await one('select max(id) as id from public.admin_finance_entry_revisions where entry_id = $1', [id])).id;
    const immutable = { code: '55000', message: 'ACCOUNTING_HISTORY_IMMUTABLE' };
    const asService = (statement: string, params: unknown[] = []) => failure(async () => {
      await db().query('set local role service_role');
      await db().query(statement, params);
    });
    for (const [statement, params] of [
      ['delete from public.admin_finance_expenses where id = $1', [id]],
      ['truncate table public.admin_finance_expenses cascade', []],
      ["update public.admin_finance_entry_revisions set operation = 'insert' where id = $1", [revisionId]],
      ['update public.admin_finance_entry_revisions set changed_by = $2 where id = $1', [revisionId, admin]],
      ["update public.admin_finance_entry_revisions set changed_by = null, after_data = '{}'::jsonb where id = $1", [revisionId]],
      ['update public.admin_finance_entry_revisions set changed_at = changed_at where id = $1', [revisionId]],
      ['delete from public.admin_finance_entry_revisions where id = $1', [revisionId]],
      ['truncate table public.admin_finance_entry_revisions', []],
      ["update public.accounting_manual_category_map set account_code = '9999' where source_text = '現金'", []],
      ["delete from public.accounting_manual_method_map where source_text = '現金'", []],
    ] as const) {
      // As the owner (postgres, the migration role) and as service_role (privileges already end where triggers start).
      expect({ statement, owner: await failure(() => db().query(statement, [...params])) }).toEqual({ statement, owner: immutable });
      if (statement.includes('admin_finance_')) {
        expect({ statement, service: await asService(statement, [...params]) }).toEqual({ statement, service: immutable });
      }
    }
    for (const table of ['accounting_manual_category_map', 'accounting_manual_method_map']) {
      expect(await failure(() => db().query(`truncate table public.${table}`))).toEqual(immutable);
    }
    // The one allowed update: changed_by from a value to NULL, nothing else.
    expect(await failure(() => db().query('update public.admin_finance_entry_revisions set changed_by = null where id = $1', [revisionId]))).toBeNull();
    // And a row already NULL cannot be "updated" again.
    await db().query('update public.admin_finance_entry_revisions set changed_by = null where id = $1', [revisionId]);
    expect(await failure(() => db().query('update public.admin_finance_entry_revisions set changed_by = null where id = $1', [revisionId])))
      .toEqual(immutable);
    // service_role may still read and insert history rows (the route never writes them; the existing trigger does).
    await db().query('savepoint acc_s4_history');
    await db().query('set local role service_role');
    await db().query("insert into public.admin_finance_entry_revisions (entry_id, operation, before_data, after_data) values ($1, 'update', '{}', '{}')", [id]);
    expect(Number((await one('select count(*) as n from public.admin_finance_entry_revisions where entry_id = $1', [id])).n)).toBe(3);
    await db().query('rollback to savepoint acc_s4_history');
    await db().query('release savepoint acc_s4_history');
  });

  test('FREQ-556-AC-06: 履歴を持つ利用者を消すと履歴の行は残りchanged_byだけがNULLになる', async () => {
    const leaving = await insertUser();
    const id = await insertExpense({ createdBy: editor });
    await updateExpense(id, 'amount = 1300, updated_by = $2', [leaving]);
    await updateExpense(id, 'amount = 1400, updated_by = $2', [editor]);
    const before = (await db().query('select id, entry_id, operation, before_data, after_data, changed_at from public.admin_finance_entry_revisions where entry_id = $1 order by id', [id])).rows;
    const entries = await entryCount();
    expect(await revisions(id)).toEqual([
      { operation: 'insert', changed_by: editor }, { operation: 'update', changed_by: leaving }, { operation: 'update', changed_by: editor },
    ]);
    await db().query('delete from auth.users where id = $1', [leaving]);
    expect(await revisions(id)).toEqual([
      { operation: 'insert', changed_by: editor }, { operation: 'update', changed_by: null }, { operation: 'update', changed_by: editor },
    ]);
    expect((await db().query('select id, entry_id, operation, before_data, after_data, changed_at from public.admin_finance_entry_revisions where entry_id = $1 order by id', [id])).rows)
      .toEqual(before);
    expect(await entryCount()).toBe(entries);
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-06: 経費を作り最後にも直し削除もした利用者を消せ、経費の行と仕訳は残り手入力のトリガーは何も足さない', async () => {
    // Before S4 this deletion failed with 23503 (measured 2026-11-07): ON DELETE SET NULL on created_by fired the
    // history trigger, which inserted a revision naming the user being deleted. S4's history function adds no revision
    // for an update that only clears actor columns.
    const leaving = await insertUser();
    const id = await insertExpense({ createdBy: leaving });
    await updateExpense(id, 'amount = 1300, updated_by = $2', [leaving]);
    const removed = await insertExpense({ createdBy: leaving });
    await updateExpense(removed, 'deleted_at = now(), deleted_by = $2, updated_by = $2', [leaving]);
    const columns = 'select id, entry_id, operation, before_data, after_data, changed_at from public.admin_finance_entry_revisions where entry_id = any($1::bigint[]) order by id';
    const before = (await db().query(columns, [[id, removed]])).rows;
    const changedBy = (await db().query('select changed_by from public.admin_finance_entry_revisions where entry_id = any($1::bigint[]) order by id', [[id, removed]])).rows;
    expect(changedBy.every((row) => row.changed_by === leaving)).toBe(true);
    const entries = [await keys(id), await keys(removed)];
    const total = await entryCount();
    expect(await failure(() => db().query('delete from auth.users where id = $1', [leaving]))).toBeNull();
    await db().query('delete from auth.users where id = $1', [leaving]);
    expect((await db().query('select created_by, updated_by, deleted_by from public.admin_finance_expenses where id = any($1::bigint[]) order by id', [[id, removed]])).rows)
      .toEqual([{ created_by: null, updated_by: null, deleted_by: null }, { created_by: null, updated_by: null, deleted_by: null }]);
    // The same revision rows (no row added or removed, content and time unchanged); only changed_by became NULL.
    expect((await db().query(columns, [[id, removed]])).rows).toEqual(before);
    expect((await db().query('select changed_by from public.admin_finance_entry_revisions where entry_id = any($1::bigint[])', [[id, removed]])).rows
      .every((row) => row.changed_by === null)).toBe(true);
    expect([await keys(id), await keys(removed)]).toEqual(entries);
    expect(await entryCount()).toBe(total);
    // When another user edited last, only created_by becomes NULL and the history still gains nothing.
    const creator = await insertUser();
    const other = await insertExpense({ createdBy: creator });
    await updateExpense(other, 'amount = 1300, updated_by = $2', [editor]);
    await db().query('delete from auth.users where id = $1', [creator]);
    expect(await one('select created_by, updated_by from public.admin_finance_expenses where id = $1', [other]))
      .toEqual({ created_by: null, updated_by: editor });
    expect(await revisions(other)).toEqual([{ operation: 'insert', changed_by: null }, { operation: 'update', changed_by: editor }]);
    expect(await entryCount()).toBe(total + 3);
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-06: 実行者の列をNULLにするだけの更新は履歴も仕訳も足さず、別の利用者への付け替えや中身の変化は従来どおり履歴に残る', async () => {
    const id = await insertExpense();
    await updateExpense(id, 'updated_by = $2', [editor]);
    const history = await revisions(id);
    expect(history).toEqual([{ operation: 'insert', changed_by: admin }, { operation: 'update', changed_by: editor }]);
    const total = await entryCount();
    await updateExpense(id, 'created_by = null, updated_by = null');
    expect(await revisions(id)).toEqual(history);
    // An actor column set to another user is a change someone made: recorded as before (no journal entry).
    await updateExpense(id, 'updated_by = $2', [admin]);
    expect((await revisions(id)).at(-1)).toEqual({ operation: 'update', changed_by: admin });
    // Clearing an actor column together with a content change still writes the revision and the entries.
    await updateExpense(id, "updated_by = null, item_name = 'ペン2'");
    expect((await revisions(id)).map((r) => r.operation)).toEqual(['insert', 'update', 'update', 'update']);
    expect(await entryCount()).toBe(total + 2);
    await db().query('set constraints all immediate');
  });

  test('FREQ-556-AC-04: G・Hの関数のソースがadmin_finance_expensesを書かず、手入力のトリガーが行の鍵の後にG共通鍵を取っても詰まらない', async () => {
    // Functions that take the group G common lock (190521,1) directly or through private.accounting_lock_all.
    const functions = (await db().query(`select n.nspname || '.' || p.proname as name, p.prosrc as src
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prokind = 'f'`)).rows as { name: string; src: string }[];
    const takesGLock = (src: string) => /pg_advisory_xact_lock\s*\(\s*190521\s*,/.test(src) || /private\.accounting_lock_all\s*\(/.test(src);
    const writesExpenses = (src: string) =>
      /(insert\s+into|update|delete\s+from|merge\s+into)\s+(public\.)?admin_finance_expenses\b/i.test(src)
      || /from\s+(public\.)?admin_finance_expenses\b[^;]*\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/i.test(src);
    const holders = functions.filter((f) => takesGLock(f.src) && f.name !== 'private.accounting_lock_all');
    const writers = functions.filter((f) => writesExpenses(f.src)).map((f) => f.name);
    expect(holders.length).toBeGreaterThan(10);
    expect(holders.map((f) => f.name)).toEqual(expect.arrayContaining([
      'private.accounting_post_journal_core', 'private.accounting_manual_entry_after_write',
    ]));
    expect(holders.filter((f) => writesExpenses(f.src)).map((f) => f.name)).toEqual([]);
    // No holder calls a function that writes the rows either.
    expect(holders.flatMap((f) => writers.filter((w) => f.src.includes(w.split('.')[1])).map((w) => `${f.name} -> ${w}`))).toEqual([]);

    // A transaction that holds the G lock (as a G / H function does) makes the trigger wait after its row write; the
    // insert finishes as soon as that transaction ends, with no deadlock.
    const holder: PgClient = await connectLocalDb();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(190521, 1)');
      const pid = Number((await one('select pg_backend_pid() as pid')).pid);
      let settled = false;
      const pending = insertExpense({ item: 'acc s4 waits' }).finally(() => { settled = true; });
      let waiting = false;
      for (let i = 0; i < 5000 && !waiting; i += 1) {
        const locks = (await holder.query(`select l.locktype, l.classid::text, l.objid::text, l.granted, l.mode, c.relname
          from pg_locks l left join pg_class c on c.oid = l.relation where l.pid = $1`, [pid])).rows;
        waiting = locks.some((l) => l.locktype === 'advisory' && l.classid === '190521' && l.objid === '1' && !l.granted)
          && locks.some((l) => l.relname === 'admin_finance_expenses' && l.mode === 'RowExclusiveLock' && l.granted);
        if (!waiting) await new Promise((resolve) => setImmediate(resolve));
      }
      expect({ waiting, settled }).toEqual({ waiting: true, settled: false });
      await holder.query('rollback');
      const id = await pending;
      expect(await keys(id)).toEqual([`manual_entry:${id}:0`]);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
    }
  });

  async function attempt(change = ''): Promise<{ code?: string; message?: string; detail?: string } | null> {
    await db().query('savepoint acc_s4_assert');
    try {
      await db().query(baselineStatement);
      if (change) await db().query(change);
      await db().query(assertion);
      return null;
    } catch (error) {
      const e = error as { code?: string; message?: string; detail?: string };
      return { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally {
      await db().query('rollback to savepoint acc_s4_assert');
      await db().query('release savepoint acc_s4_assert');
    }
  }

  test('FREQ-556-AC-01: S4末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(assertion).not.toBe('');
    expect(baselineStatement).toContain('CREATE TEMP TABLE accounting_s4_baseline');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    // pgcrypto lives in extensions (as on Supabase), and the assert puts the caller's search_path back.
    expect(await one("select extnamespace::regnamespace::text as schema from pg_extension where extname = 'pgcrypto'"))
      .toEqual({ schema: 'extensions' });
    await db().query('savepoint acc_s4_path');
    await db().query('set local search_path = public, private, extensions, pg_catalog');
    await db().query(baselineStatement);
    await db().query(assertion);
    expect(await one("select current_setting('search_path') as path")).toEqual({ path: 'public, private, extensions, pg_catalog' });
    await db().query('rollback to savepoint acc_s4_path');
    await db().query('release savepoint acc_s4_path');
  });

  const replacedBody = (fn: string) => `create or replace function ${fn}() returns trigger language plpgsql security definer
    set search_path = '' as $f$ begin return null; end; $f$`;
  test.each([
    ["grant select on public.accounting_manual_category_map to authenticated", 'acc_s4_map_table'],
    ["grant insert on public.accounting_manual_method_map to service_role", 'acc_s4_map_table'],
    ["grant select (source_text) on public.accounting_manual_method_map to anon", 'acc_s4_map_table'],
    ["alter table public.accounting_manual_category_map disable row level security", 'acc_s4_map_table'],
    ["create policy acc_s4_probe on public.accounting_manual_method_map for select to service_role using (true)", 'acc_s4_map_table'],
    ["alter table public.accounting_manual_method_map drop constraint accounting_manual_method_map_direction_check", 'acc_s4_map_table'],
    ["alter table public.accounting_manual_category_map add constraint acc_s4_probe check (account_code <> '0000')", 'acc_s4_map_table'],
    ["insert into public.accounting_manual_category_map values ('acc s4 probe', '9999')", 'acc_s4_map_table'],
    ["alter table public.accounting_manual_category_map enable trigger accounting_manual_category_map_no_truncate", 'acc_s4_map_table'],
    ["drop trigger accounting_manual_method_map_no_update_delete on public.accounting_manual_method_map", 'acc_s4_map_table'],
    ["alter table public.admin_finance_expenses disable trigger accounting_manual_entry_journal", 'acc_s4_trigger'],
    ["alter table public.admin_finance_expenses enable always trigger accounting_manual_entry_journal", 'acc_s4_trigger'],
    ["drop trigger accounting_manual_entry_no_delete on public.admin_finance_expenses", 'acc_s4_trigger'],
    ["alter table public.admin_finance_entry_revisions enable trigger accounting_entry_revisions_guard", 'acc_s4_trigger'],
    [`create trigger accounting_probe before insert on public.admin_finance_expenses for each row
      execute function private.reject_accounting_mutation()`, 'acc_s4_trigger'],
    [`drop trigger accounting_manual_entry_journal on public.admin_finance_expenses;
      create trigger accounting_manual_entry_journal after insert on public.admin_finance_expenses for each row
      execute function private.accounting_manual_entry_after_write()`, 'acc_s4_trigger'],
    ["grant execute on function private.accounting_manual_entry_after_write() to service_role", 'acc_s4_functions'],
    ["alter function private.accounting_guard_entry_revision() security invoker", 'acc_s4_functions'],
    [replacedBody('private.accounting_manual_entry_after_write'), 'acc_s4_functions'],
    [replacedBody('private.accounting_guard_entry_revision'), 'acc_s4_functions'],
    ["create function public.accounting_probe() returns integer language sql as $f$ select 1 $f$", 'acc_s4_functions'],
    ["alter table public.admin_finance_expenses disable trigger trigger_admin_finance_entry_revisions", 'acc_s4_legacy_trigger_untouched'],
    ["drop trigger trigger_admin_finance_expenses_updated_at on public.admin_finance_expenses", 'acc_s4_legacy_trigger_untouched'],
    ["alter function public.record_admin_finance_entry_revision() set search_path = public", 'acc_s4_legacy_trigger_untouched'],
    [`create or replace function public.record_admin_finance_entry_revision() returns trigger language plpgsql security definer
      set search_path to 'public', 'pg_temp' as $f$ begin return new; end; $f$`, 'acc_s4_legacy_trigger_untouched'],
    ["drop table pg_temp.accounting_s4_baseline", 'acc_s4_legacy_trigger_untouched'],
  ])('FREQ-556-AC-01: S4改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
    expect(await attempt()).toBeNull();
  });
});
