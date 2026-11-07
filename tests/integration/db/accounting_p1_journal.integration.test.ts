/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { ACCOUNTING_EVENT_KINDS, EVENT_KEY_ARITY } from '@/lib/accounting/event-kinds';
import { buildEventKey } from '@/lib/accounting/event-key';
import { toJstDate } from '@/lib/accounting/jst-date';
import { buildAccountsSeedRows } from '@/../scripts/accounting/emit-accounts-seed';
import { describeLocalDb } from './helpers/local-db';
import { adminTableTools } from './helpers/admin-table-grants';
import {
  insertAccountingAdmin, insertAccountingPeriod, japanToday, journalLines, postJournal, type JournalLineInput,
} from './helpers/accounting-fixtures';

// Accounting plan 1 S2 (FREQ-554): the saved journal. Every test runs in BEGIN ... ROLLBACK (controller only, local DB).
type Failure = { code?: string; message?: string; detail?: string };
const TABLES = ['accounting_accounts', 'accounting_periods', 'accounting_period_sequences', 'accounting_journal_entries',
  'accounting_journal_lines'] as const;
const SALE: JournalLineInput[] = [{ account: '1130', debit: 1000 }, { account: '4010', credit: 1000 }];
const CORE_ARGS = '$1::uuid, $2::uuid, $3::date, $4::text, $5::text[], $6::text, $7::jsonb';

describeLocalDb('S2 journal: controller only', (db) => {
  const tools = adminTableTools(db);
  const today = japanToday();
  const year = Number(today.slice(0, 4));
  const lastYear = year - 1;
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  const one = async (text: string, params: unknown[] = []) => (await db().query(text, params)).rows[0];
  /** Run inside a savepoint; return the fixed error (DB text other than ACCOUNTING_* is not kept). */
  async function failure(run: () => Promise<unknown>): Promise<Failure | null> {
    await db().query('savepoint acc_s2_failure');
    try {
      await run();
      await db().query('set constraints all immediate');
      return null;
    } catch (caught) {
      const e = caught as Failure;
      const fixed = /^ACCOUNTING_[A-Z_]+$/.test(e.message ?? '');
      const message = fixed ? e.message : 'DATABASE_ERROR';
      return fixed && e.detail ? { code: e.code, message, detail: e.detail } : { code: e.code, message };
    } finally {
      await db().query('rollback to savepoint acc_s2_failure');
      await db().query('release savepoint acc_s2_failure');
    }
  }
  /** The calendar-year sole periods of last year and this year (contiguous, so the layout check passes). */
  async function solePeriods(): Promise<{ last: string; current: string }> {
    const last = await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: `${lastYear}-01-01`, endsOn: `${lastYear}-12-31` });
    const current = await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: `${year}-01-01`, endsOn: `${year}-12-31` });
    return { last, current };
  }
  const core = (args: unknown[], tail = '') => db().query(`select private.accounting_post_journal_core(${CORE_ARGS}${tail}) as r`, args);
  const reverse = (entryId: string, reason: string, entryDate: string | null = null, sourceRecordedAt: string | null = null) =>
    one('select private.accounting_reverse_journal_core(null, $1::uuid, $2::text, $3::date, $4::timestamptz) as r',
      [entryId, reason, entryDate, sourceRecordedAt]).then((row) => row.r);
  const counts = async () => one(`select (select count(*)::int from public.accounting_journal_entries) as entries,
    (select count(*)::int from public.accounting_journal_lines) as lines,
    (select coalesce(sum(last_entry_no), 0)::int from public.accounting_period_sequences) as numbers`);
  const header = (id: string) => one('select * from public.accounting_journal_entries where id = $1', [id]);
  const linesOf = async (id: string) => (await db().query(
    'select line_no, account_code, debit::int, credit::int from public.accounting_journal_lines where entry_id = $1 order by line_no',
    [id])).rows;
  /** Run as service_role inside a savepoint (the role and every row are undone afterwards). */
  async function asService<T>(run: () => Promise<T>): Promise<T> {
    await db().query('savepoint acc_s2_service');
    try {
      await db().query('set local role service_role');
      return await run();
    } finally {
      await db().query('rollback to savepoint acc_s2_service');
      await db().query('release savepoint acc_s2_service');
    }
  }
  const publicPost = (args: unknown[]) => db().query(
    'select public.admin_post_accounting_journal($1::uuid, $2::uuid, $3::date, $4::text, $5::text[], $6::text, $7::jsonb, $8::uuid, $9::text, $10::text, $11::text) as r',
    args);

  test('FREQ-554-AC-01: 借方と貸方が合わない仕訳と片側だけの行と0と負と小数の額と1行の仕訳を断る', async () => {
    const { current } = await solePeriods();
    const cases: [JournalLineInput[], string][] = [
      [[{ account: '1130', debit: 1000 }, { account: '4010', credit: 900 }], 'balance'],
      [[{ account: '1130', debit: 1000, credit: 1000 }, { account: '4010', credit: 1000 }], 'one_sided'],
      [[{ account: '1130', debit: 0, credit: 0 }, { account: '4010', credit: 1000 }], 'sign'],
      [[{ account: '1130', debit: -1000 }, { account: '4010', credit: -1000 }], 'sign'],
      [[{ account: '1130', debit: 1.5 }, { account: '4010', credit: 1.5 }], 'sign'],
      [[{ account: '1130', debit: 1000 }], 'min_lines'],
      [[], 'min_lines'],
    ];
    for (const [lines, detail] of cases) {
      const caught = await failure(() => postJournal(db(), { periodId: current, entryDate: today, kind: 'payment_confirmed', parts: [`pi_${detail}`], lines }));
      expect({ lines, caught }).toEqual({ lines, caught: { code: '23514', message: 'ACCOUNTING_ENTRY_UNBALANCED', detail } });
    }
    // A string amount never reaches the bigint cast (no 22P02).
    const text = JSON.stringify([{ account_code: '1130', debit: '1000', credit: 0 }, { account_code: '4010', debit: 0, credit: 1000 }]);
    expect(await failure(() => core([null, current, today, 'payment_confirmed', ['pi_text'], 'd', text])))
      .toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    expect(await counts()).toEqual({ entries: 0, lines: 0, numbers: 0 });
  });

  test('FREQ-554-AC-01: 見出しと行は1つのトランザクションで入り行の途中の失敗で見出しも残らない', async () => {
    const { current } = await solePeriods();
    // A check that only the second line breaks makes the line INSERT fail after the header and the number were written.
    await db().query("alter table public.accounting_journal_lines add constraint acc_s2_probe check (memo is distinct from 'boom') not valid");
    const lines = JSON.stringify([
      { account_code: '1130', debit: 1000, credit: 0, memo: null },
      { account_code: '4010', debit: 0, credit: 1000, memo: 'boom' },
    ]);
    await db().query(`do $probe$ begin
        perform private.accounting_post_journal_core(null, '${current}'::uuid, '${today}'::date, 'payment_confirmed',
          array['pi_boom'], 'd', '${lines}'::jsonb);
        raise exception 'ACC_S2_PROBE_NOT_RAISED';
      exception when check_violation then null;
      end $probe$`);
    expect(await counts()).toEqual({ entries: 0, lines: 0, numbers: 0 });
    // A line that the core itself refuses (an unknown account) leaves nothing either.
    const unknown = JSON.stringify([{ account_code: '1130', debit: 1000, credit: 0 }, { account_code: '0000', debit: 0, credit: 1000 }]);
    expect(await failure(() => core([null, current, today, 'payment_confirmed', ['pi_unknown'], 'd', unknown])))
      .toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    expect(await counts()).toEqual({ entries: 0, lines: 0, numbers: 0 });
  });

  test('FREQ-554-AC-02: 保存した見出しと行のUPDATEとDELETEとTRUNCATEは所有者でも断られる', async () => {
    const { current } = await solePeriods();
    await postJournal(db(), { periodId: current, entryDate: today, kind: 'payment_confirmed', parts: ['pi_immutable'], lines: SALE });
    await db().query('set constraints all immediate');
    expect((await one('select current_user as u')).u).toBe('postgres');
    for (const statement of [
      "update public.accounting_journal_entries set description = 'changed'",
      'delete from public.accounting_journal_entries',
      'truncate table public.accounting_journal_entries cascade',
      'update public.accounting_journal_lines set memo = 1::text',
      'delete from public.accounting_journal_lines',
      'truncate table public.accounting_journal_lines',
      "update public.accounting_accounts set scope = 'common' where code = '9999'",
      "delete from public.accounting_accounts where code = '9999'",
      'truncate table public.accounting_accounts cascade',
    ]) {
      expect({ statement, caught: await failure(() => db().query(statement)) })
        .toEqual({ statement, caught: { code: '55000', message: 'ACCOUNTING_HISTORY_IMMUTABLE' } });
    }
    expect(await counts()).toEqual({ entries: 1, lines: 2, numbers: 1 });
  });

  test('FREQ-554-AC-03: 同じ印で同じ内容を2回入れると1本のままcreated=falseを返す', async () => {
    const { current } = await solePeriods();
    const first = await postJournal(db(), { periodId: current, entryDate: today, kind: 'payment_confirmed', parts: ['pi_same'], lines: SALE });
    const again = await postJournal(db(), { periodId: current, entryDate: today, kind: 'payment_confirmed', parts: ['pi_same'], lines: SALE });
    expect(first.created).toBe(true);
    expect(again).toEqual({ ...first, created: false });
    // A reworded description is the same event.
    const reworded = (await core([null, current, today, 'payment_confirmed', ['pi_same'], 'other words', journalLines(SALE)])).rows[0].r;
    expect(reworded).toEqual({ entry_id: first.entryId, entry_no: first.entryNo, period_id: current, created: false });
    expect(await counts()).toEqual({ entries: 1, lines: 2, numbers: 1 });
    expect((await header(first.entryId)).dedupe_key).toBe('payment_confirmed:pi_same');
  });

  test('FREQ-554-AC-03: 同じ印で期間・相手のどちらかが違えばDEDUPE_CONTENT_MISMATCH', async () => {
    const { last, current } = await solePeriods();
    await postJournal(db(), { periodId: current, entryDate: today, kind: 'payment_confirmed', parts: ['pi_mismatch'], lines: SALE });
    const mismatch = { code: '23505', message: 'ACCOUNTING_DEDUPE_CONTENT_MISMATCH' };
    expect(await failure(() => postJournal(db(), { periodId: last, entryDate: `${lastYear}-06-01`, kind: 'payment_confirmed', parts: ['pi_mismatch'], lines: SALE })))
      .toEqual(mismatch);
    const otherParty = JSON.stringify([
      { account_code: '1130', debit: 1000, credit: 0, counterparty: 'someone else' },
      { account_code: '4010', debit: 0, credit: 1000 },
    ]);
    expect(await failure(() => core([null, current, today, 'payment_confirmed', ['pi_mismatch'], 'd', otherParty]))).toEqual(mismatch);
    // The refused inputs took no number.
    expect(await counts()).toEqual({ entries: 1, lines: 2, numbers: 1 });
    const next = await postJournal(db(), { periodId: current, entryDate: today, kind: 'payment_confirmed', parts: ['pi_next'], lines: SALE });
    expect(next.entryNo).toBe(2);
  });

  test('FREQ-554-AC-03: 種類の一覧と印の文字列はTSのbuildEventKeyと一致する（stripe_feeは stripe:fee: の形）', async () => {
    expect((await one('select private.accounting_event_kinds() as k')).k).toEqual([...ACCOUNTING_EVENT_KINDS]);
    for (const kind of ACCOUNTING_EVENT_KINDS) {
      const parts = Array.from({ length: EVENT_KEY_ARITY[kind] }, (_, i) => `p${i + 1}.A-b_${i}`);
      const row = await one('select private.accounting_event_arity($1) as arity, private.accounting_event_key($1, $2::text[]) as key', [kind, parts]);
      expect({ kind, ...row }).toEqual({ kind, arity: EVENT_KEY_ARITY[kind], key: buildEventKey(kind, parts) });
    }
    expect((await one("select private.accounting_event_key('stripe_fee', array['txn_9']) as k")).k).toBe('stripe:fee:txn_9');
    expect((await one("select private.accounting_event_arity('unknown') as a")).a).toBeNull();
    for (const [kind, parts] of [
      ['payment_confirmed', ['a', 'b']], ['refund_failed', ['a']], ['payment_confirmed', ['a:b']], ['payment_confirmed', ['']],
      ['payment_confirmed', ['x'.repeat(129)]], ['payment_confirmed', [null]], ['payment_confirmed', []], ['unknown', ['a']],
    ] as [string, (string | null)[]][]) {
      expect({ kind, parts, caught: await failure(() => db().query('select private.accounting_event_key($1, $2::text[])', [kind, parts])) })
        .toEqual({ kind, parts, caught: { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' } });
    }
    expect(await one("select private.accounting_event_key('payment_confirmed', array[$1]) as k", ['x'.repeat(128)]))
      .toEqual({ k: `payment_confirmed:${'x'.repeat(128)}` });
  });

  test('FREQ-554-AC-04: 取り消しは元の借貸を入れ替えて元1本につき1回だけ', async () => {
    const { current } = await solePeriods();
    const original = await postJournal(db(), { periodId: current, entryDate: today, kind: 'payment_confirmed', parts: ['pi_rev'],
      lines: [{ account: '1010', debit: 1000 }, { account: '4010', credit: 900 }, { account: '4050', credit: 100 }] });
    const reversal = await reverse(original.entryId, 'entered twice');
    expect(reversal).toEqual({ entry_id: expect.any(String), entry_no: 2, period_id: current, created: true });
    expect(await linesOf(reversal.entry_id)).toEqual([
      { line_no: 1, account_code: '1010', debit: 0, credit: 1000 },
      { line_no: 2, account_code: '4010', debit: 900, credit: 0 },
      { line_no: 3, account_code: '4050', debit: 100, credit: 0 },
    ]);
    const saved = await one(`select event_kind as kind, dedupe_key as key, reverses_entry_id as reverses, reason,
      to_char(entry_date, 'YYYY-MM-DD') as date from public.accounting_journal_entries where id = $1`, [reversal.entry_id]);
    expect(saved).toEqual({ kind: 'reversal', key: `reversal:${original.entryId}`, reverses: original.entryId, reason: 'entered twice', date: today });
    expect(await failure(() => reverse(original.entryId, 'another reason'))).toEqual({ code: '23505', message: 'ACCOUNTING_ALREADY_REVERSED' });
    expect((await one('select count(*)::int as n from public.accounting_journal_entries where reverses_entry_id = $1', [original.entryId])).n).toBe(1);
  });

  test('FREQ-554-AC-04: 同じ内容で取り消し直すとcreated=falseで前の結果を返し、違う理由や日ならALREADY_REVERSED', async () => {
    const { current } = await solePeriods();
    const original = await postJournal(db(), { periodId: current, entryDate: `${year}-01-10`, kind: 'payment_confirmed', parts: ['pi_resend'], lines: SALE });
    const first = await reverse(original.entryId, 'wrong amount');
    expect(await reverse(original.entryId, 'wrong amount')).toEqual({ ...first, created: false });
    expect(await reverse(original.entryId, 'wrong amount', `${year}-01-10`)).toEqual({ ...first, created: false });
    const already = { code: '23505', message: 'ACCOUNTING_ALREADY_REVERSED' };
    expect(await failure(() => reverse(original.entryId, 'other reason'))).toEqual(already);
    expect(await failure(() => reverse(original.entryId, 'wrong amount', `${year}-01-11`))).toEqual(already);
    expect(await counts()).toEqual({ entries: 2, lines: 4, numbers: 2 });
  });

  test('FREQ-554-AC-04: 取り消しの取り消しは作れず、取り消しの仕訳には必ず元の番号と理由が付く', async () => {
    const { current } = await solePeriods();
    const original = await postJournal(db(), { periodId: current, entryDate: today, kind: 'payment_confirmed', parts: ['pi_rr'], lines: SALE });
    const reversal = await reverse(original.entryId, 'mistake');
    expect(await failure(() => reverse(reversal.entry_id, 'undo'))).toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    // The core refuses a reversal without its original or without a reason, and a reason without a reversal.
    const swapped = journalLines([{ account: '1130', credit: 1000 }, { account: '4010', debit: 1000 }]);
    const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
    expect(await failure(() => core([null, current, today, 'reversal', [original.entryId], 'd', swapped]))).toEqual(invalid);
    expect(await failure(() => core([null, current, today, 'reversal', [original.entryId], 'd', swapped, original.entryId], ', _reverses_entry_id => $8::uuid'))).toEqual(invalid);
    expect(await failure(() => core([null, current, today, 'payment_confirmed', ['pi_reason'], 'd', journalLines(SALE), 'why'], ', _reason => $8::text'))).toEqual(invalid);
    expect(await failure(() => core([null, current, today, 'reversal', [original.entryId], 'd', swapped, original.entryId, ' '], ', $8::uuid, $9::text'))).toEqual(invalid);
    // The table itself refuses a reversal row without the original or the reason.
    expect(await failure(() => db().query(`insert into public.accounting_journal_entries (period_id, entry_no, entry_date, event_kind,
      dedupe_key, content_hash, description) values ($1, 99, $2::date, 'reversal', 'reversal:x', 'h', 'd')`, [current, today])))
      .toEqual({ code: '23514', message: 'DATABASE_ERROR' });
    const saved = await header(reversal.entry_id);
    expect({ reverses: saved.reverses_entry_id, reason: saved.reason }).toEqual({ reverses: original.entryId, reason: 'mistake' });
  });

  test('FREQ-554-AC-04: 取り消しのcoreは元と違う額の行をARGUMENT_INVALIDで断る', async () => {
    const { current } = await solePeriods();
    const original = await postJournal(db(), { periodId: current, entryDate: today, kind: 'payment_confirmed', parts: ['pi_amount'], lines: SALE });
    const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
    for (const lines of [
      [{ account: '1130', credit: 900 }, { account: '4010', debit: 900 }],
      [{ account: '1130', debit: 1000 }, { account: '4010', credit: 1000 }],
      [{ account: '4010', debit: 1000 }, { account: '1130', credit: 1000 }],
    ]) {
      expect({ lines, caught: await failure(() => core([null, current, today, 'reversal', [original.entryId], 'd', journalLines(lines), original.entryId, 'r'], ', $8::uuid, $9::text')) })
        .toEqual({ lines, caught: invalid });
    }
    const exact = await core([null, current, today, 'reversal', [original.entryId], 'd',
      journalLines([{ account: '1130', credit: 1000 }, { account: '4010', debit: 1000 }]), original.entryId, 'r'], ', $8::uuid, $9::text');
    expect(exact.rows[0].r.created).toBe(true);
  });

  test('FREQ-554-AC-05: timestamptzを日本時間の日付に直すSQLの道具はTSのtoJstDateと同じ日を返す', async () => {
    for (const instant of ['2026-12-31T15:30:00Z', '2026-12-31T14:59:59Z', '2026-12-31T15:00:00Z', '2027-02-28T15:00:00Z',
      '2028-02-28T15:00:00Z', '2026-06-30T23:59:59.999Z', '2026-01-01T00:00:00+09:00']) {
      const row = await one("select to_char(private.accounting_jst_date($1::timestamptz), 'YYYY-MM-DD') as d", [instant]);
      expect({ instant, d: row.d }).toEqual({ instant, d: toJstDate(instant) });
    }
  });

  test('FREQ-554-AC-06: DBの勘定とTSの勘定の符号が一致し9999がある', async () => {
    const rows = (await db().query(`select code, account_type as "accountType", normal_side as "normalSide", scope,
      carryover_role as "carryoverRole" from public.accounting_accounts order by code collate "C"`)).rows;
    const expected = [...buildAccountsSeedRows()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    expect(rows).toEqual(expected);
    expect(rows.find((row) => row.code === '9999')).toEqual({ code: '9999', accountType: 'expense', normalSide: 'debit', scope: 'common', carryoverRole: 'pl_zero' });
  });

  test('FREQ-554-AC-07: 会計の表はanonとauthenticatedに権限が無くservice_roleはSELECTだけで直接INSERTできない', async () => {
    const member = await tools.insertMember();
    for (const table of TABLES) {
      expect({ table, anon: await tools.privileges('anon', table), authenticated: await tools.privileges('authenticated', table),
        service: await tools.privileges('service_role', table) })
        .toEqual({ table, anon: [], authenticated: [], service: ['SELECT'] });
      for (const [role, claims] of [['anon', null], ['authenticated', member]] as const) {
        const caught = await tools.failureAs(role, claims, `select count(*) from public.${table}`);
        expect({ table, role, denied: tools.isPermissionDenied(caught, table) }).toEqual({ table, role, denied: true });
      }
      expect(await tools.failureAs('service_role', null, `select count(*) from public.${table}`)).toBeNull();
      const insert = await tools.failureAs('service_role', null, `insert into public.${table} default values`);
      expect({ table, denied: tools.isPermissionDenied(insert, table) }).toEqual({ table, denied: true });
    }
  });

  test('FREQ-554-AC-07: 入口は権限なしを42501で断り、coreは直接呼べない', async () => {
    const { current } = await solePeriods();
    const admin = await insertAccountingAdmin(db());
    const outsider = randomUUID();
    const args = (actor: string | null) => [actor, current, today, 'payment_confirmed', ['pi_gate'], 'd', journalLines(SALE), null, null, null, null];
    const forbidden = { code: '42501', message: 'ACCOUNTING_FORBIDDEN' };
    await asService(async () => {
      expect(await failure(() => publicPost(args(outsider)))).toEqual(forbidden);
      expect(await failure(() => publicPost(args(null)))).toEqual(forbidden);
      expect(await failure(() => db().query('select public.admin_reverse_accounting_journal($1::uuid, $2::uuid, $3::text)', [outsider, randomUUID(), 'r'])))
        .toEqual(forbidden);
      expect(await failure(() => core([admin, current, today, 'payment_confirmed', ['pi_core'], 'd', journalLines(SALE)])))
        .toEqual({ code: '42501', message: 'DATABASE_ERROR' });
      expect(await failure(() => db().query('select private.accounting_reverse_journal_core($1::uuid, $2::uuid, $3::text)', [admin, randomUUID(), 'r'])))
        .toEqual({ code: '42501', message: 'DATABASE_ERROR' });
      const posted = (await publicPost(args(admin))).rows[0].r;
      expect(posted).toEqual({ entry_id: expect.any(String), entry_no: 1, period_id: current, created: true });
      const reversed = (await db().query('select public.admin_reverse_accounting_journal($1::uuid, $2::uuid, $3::text) as r', [admin, posted.entry_id, 'r'])).rows[0].r;
      expect(reversed).toEqual({ entry_id: expect.any(String), entry_no: 2, period_id: current, created: true });
    });
    for (const role of ['anon', 'authenticated'] as const) {
      const caught = await tools.failureAs(role, null, 'select public.admin_post_accounting_journal($1::uuid, $2::uuid, $3::date, $4::text, $5::text[], $6::text, $7::jsonb)',
        args(admin).slice(0, 7));
      expect({ role, code: caught?.code }).toEqual({ role, code: '42501' });
    }
  });

  test('FREQ-554-AC-03: 一般の入口はreversal・manual_entry・migrated_entry・period_closing_entry・closed_year_correctionを断る', async () => {
    const { current } = await solePeriods();
    const admin = await insertAccountingAdmin(db());
    await asService(async () => {
      for (const [kind, parts] of [['reversal', [randomUUID()]], ['manual_entry', ['1', '0']], ['migrated_entry', ['1']],
        ['period_closing_entry', ['a', 'b', 'c']], ['closed_year_correction', ['a', 'b', 'c']]] as [string, string[]][]) {
        const caught = await failure(() => publicPost([admin, current, today, kind, parts, 'd', journalLines(SALE), null, null, null, null]));
        expect({ kind, caught }).toEqual({ kind, caught: { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' } });
      }
    });
    expect(await counts()).toEqual({ entries: 0, lines: 0, numbers: 0 });
  });

  test('FREQ-554-AC-03: 一般の入口は_reverses_entry_idと_reasonの値と、_source_tableがadmin_finance_expensesの指定を断る', async () => {
    const { current } = await solePeriods();
    const admin = await insertAccountingAdmin(db());
    const original = await postJournal(db(), { periodId: current, entryDate: today, kind: 'payment_confirmed', parts: ['pi_src'], lines: SALE });
    await asService(async () => {
      const base = [admin, current, today, 'shipment_confirmed', ['slip_1'], 'd', journalLines(SALE)];
      for (const tail of [[original.entryId, null, null, null], [null, 'reason', null, null], [null, null, 'admin_finance_expenses', '1']]) {
        expect({ tail, caught: await failure(() => publicPost([...base, ...tail])) })
          .toEqual({ tail, caught: { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' } });
      }
      const ok = (await publicPost([...base, null, null, 'order_shipment_slips', 'slip_1'])).rows[0].r;
      expect(ok.created).toBe(true);
    });
  });

  test('FREQ-554-AC-08: 仕訳の日が期間の外ならDATE_OUT_OF_PERIOD', async () => {
    const { last, current } = await solePeriods();
    const outside = { code: '22023', message: 'ACCOUNTING_DATE_OUT_OF_PERIOD' };
    expect(await failure(() => postJournal(db(), { periodId: current, entryDate: `${lastYear}-12-31`, kind: 'payment_confirmed', parts: ['pi_out1'], lines: SALE }))).toEqual(outside);
    expect(await failure(() => postJournal(db(), { periodId: last, entryDate: `${year}-01-01`, kind: 'payment_confirmed', parts: ['pi_out2'], lines: SALE }))).toEqual(outside);
    expect(await failure(() => postJournal(db(), { periodId: randomUUID(), entryDate: today, kind: 'payment_confirmed', parts: ['pi_out3'], lines: SALE })))
      .toEqual({ code: 'P0002', message: 'ACCOUNTING_NOT_FOUND' });
    expect((await postJournal(db(), { periodId: current, entryDate: `${year}-12-31`, kind: 'payment_confirmed', parts: ['pi_in'], lines: SALE })).created).toBe(true);
    expect(await counts()).toEqual({ entries: 1, lines: 2, numbers: 1 });
  });

  test('FREQ-554-AC-09: 登録した日時と通し番号と遅れの印は呼び手が渡せず通し番号は期間ごとに欠番なく増える', async () => {
    const { last, current } = await solePeriods();
    const numbers: [string, number][] = [];
    for (const [period, date, part] of [[current, today, 'a'], [last, `${lastYear}-05-01`, 'b'], [current, today, 'c'],
      [current, today, 'd'], [last, `${lastYear}-05-02`, 'e']] as const) {
      numbers.push([period === current ? 'current' : 'last', (await postJournal(db(), { periodId: period, entryDate: date, kind: 'payment_confirmed', parts: [`pi_seq_${part}`], lines: SALE })).entryNo]);
    }
    expect(numbers).toEqual([['current', 1], ['last', 1], ['current', 2], ['current', 3], ['last', 2]]);
    expect((await db().query('select last_entry_no::int as n from public.accounting_period_sequences order by n')).rows).toEqual([{ n: 2 }, { n: 3 }]);
    // No entry point takes the number, the late mark or the insert time; the core takes _recorded_at for migrated_entry only.
    const names = (await db().query(`select p.oid::regprocedure::text as sig, array_to_string(p.proargnames, ',') as args from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')
        and p.proname in ('accounting_post_journal_core', 'admin_post_accounting_journal', 'accounting_reverse_journal_core', 'admin_reverse_accounting_journal')`)).rows;
    expect(names).toHaveLength(6);
    for (const { sig, args } of names) {
      expect({ sig, leaked: args.split(',').filter((name: string) => /entry_no|is_late|^_recorded_by$/.test(name)) }).toEqual({ sig, leaked: [] });
    }
    expect(await failure(() => core([null, current, today, 'payment_confirmed', ['pi_rec'], 'd', journalLines(SALE), '2020-01-01T00:00:00Z'], ', _recorded_at => $8::timestamptz')))
      .toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    expect(await failure(() => core([null, current, today, 'payment_confirmed', ['pi_mig'], 'd', journalLines(SALE), 'admin_finance_expenses:1'], ', _migrated_from => $8::text')))
      .toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    const migrated = (await core([null, last, `${lastYear}-03-01`, 'migrated_entry', ['77'], 'd', journalLines(SALE), '2020-01-02T03:04:05Z', 'admin_finance_expenses:77'],
      ', _recorded_at => $8::timestamptz, _migrated_from => $9::text')).rows[0].r;
    const saved = await one('select recorded_at, is_late, migrated_from, migrated_at is not null as migrated from public.accounting_journal_entries where id = $1', [migrated.entry_id]);
    expect({ ...saved, recorded_at: saved.recorded_at.toISOString() })
      .toEqual({ recorded_at: '2020-01-02T03:04:05.000Z', is_late: false, migrated_from: 'admin_finance_expenses:77', migrated: true });
  });

  test('FREQ-554-AC-09: 登録が日付から2か月を超えると遅れの印が付く', async () => {
    const { last, current } = await solePeriods();
    const late = await postJournal(db(), { periodId: last, entryDate: `${lastYear}-03-01`, kind: 'payment_confirmed', parts: ['pi_late'], lines: SALE });
    const onTime = await postJournal(db(), { periodId: current, entryDate: today, kind: 'payment_confirmed', parts: ['pi_ontime'], lines: SALE });
    expect((await header(late.entryId)).is_late).toBe(true);
    expect((await header(onTime.entryId)).is_late).toBe(false);
    // The boundary in Japan time: recorded on the day two months after 1 March (1 May, up to 23:59:59 JST) is not late,
    // 2 May 00:00 JST is.
    for (const [recorded, expected] of [[`${lastYear}-05-01T23:59:59+09:00`, false], [`${lastYear}-05-02T00:00:00+09:00`, true]] as [string, boolean][]) {
      const posted = await postJournal(db(), { periodId: last, entryDate: `${lastYear}-03-01`, kind: 'payment_confirmed',
        parts: [`pi_edge_${expected}`], lines: SALE, sourceRecordedAt: recorded });
      expect({ recorded, late: (await header(posted.entryId)).is_late }).toEqual({ recorded, late: expected });
    }
  });

  test('FREQ-554-AC-09: 出来事の記録の日時を渡すと遅れの印はその日時で決まり、recorded_atは入れた時刻のままになる', async () => {
    const { last } = await solePeriods();
    const source = `${lastYear}-03-02T01:00:00.000Z`;
    const posted = await postJournal(db(), { periodId: last, entryDate: `${lastYear}-03-01`, kind: 'shipment_confirmed', parts: ['slip_src'], lines: SALE, sourceRecordedAt: source });
    const saved = await one('select is_late, source_recorded_at, recorded_at = now() as at_insert from public.accounting_journal_entries where id = $1', [posted.entryId]);
    expect({ ...saved, source_recorded_at: saved.source_recorded_at.toISOString() }).toEqual({ is_late: false, source_recorded_at: source, at_insert: true });
    const without = await postJournal(db(), { periodId: last, entryDate: `${lastYear}-03-01`, kind: 'shipment_confirmed', parts: ['slip_nosrc'], lines: SALE });
    expect(await one('select is_late, source_recorded_at from public.accounting_journal_entries where id = $1', [without.entryId]))
      .toEqual({ is_late: true, source_recorded_at: null });
  });

  test('FREQ-554-AC-09: 未来の出来事の記録の日時は断る', async () => {
    const { current } = await solePeriods();
    const future = (await one("select (clock_timestamp() + interval '1 hour') as t")).t.toISOString();
    expect(await failure(() => postJournal(db(), { periodId: current, entryDate: today, kind: 'shipment_confirmed', parts: ['slip_future'], lines: SALE, sourceRecordedAt: future })))
      .toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    expect(await counts()).toEqual({ entries: 0, lines: 0, numbers: 0 });
  });

  test('FREQ-554-AC-09: 仕訳と取り消しの一般の入口（privateとpublic）は出来事の記録の日時の引数を持たず、coreが使った日時は見出しのsource_recorded_atに残る', async () => {
    const entries = (await db().query(`select n.nspname || '.' || p.proname as name, p.proargnames as args from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')
        and p.proname in ('admin_post_accounting_journal', 'admin_reverse_accounting_journal') order by 1`)).rows;
    expect(entries.map((row) => row.name)).toEqual(['private.admin_post_accounting_journal', 'private.admin_reverse_accounting_journal',
      'public.admin_post_accounting_journal', 'public.admin_reverse_accounting_journal']);
    for (const { name, args } of entries) {
      expect({ name, timeArgs: (args as string[]).filter((arg) => /recorded_at|migrated/.test(arg)) }).toEqual({ name, timeArgs: [] });
    }
    const cores = (await db().query(`select p.proname as name, p.proargnames as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname in ('accounting_post_journal_core', 'accounting_reverse_journal_core') order by 1`)).rows;
    expect(cores.map((row) => [row.name, (row.args as string[]).includes('_source_recorded_at')]))
      .toEqual([['accounting_post_journal_core', true], ['accounting_reverse_journal_core', true]]);
    const { current } = await solePeriods();
    const source = (await one("select (now() - interval '1 minute') as t")).t.toISOString();
    const posted = await postJournal(db(), { periodId: current, entryDate: today, kind: 'shipment_confirmed', parts: ['slip_kept'], lines: SALE, sourceRecordedAt: source });
    expect((await header(posted.entryId)).source_recorded_at.toISOString()).toBe(source);
    const admin = await insertAccountingAdmin(db());
    const general = await asService(async () => (await publicPost([admin, current, today, 'shipment_confirmed', ['slip_general'], 'd', journalLines(SALE), null, null, null, null])).rows[0].r);
    expect(general.created).toBe(true);
  });

  test('FREQ-554-AC-09: 係のトランザクションが始まった後の時刻を出来事の記録の日時に渡しても断られず、source_recorded_atはrecorded_at以下になる', async () => {
    const { current } = await solePeriods();
    await db().query('select pg_sleep(0.01)');
    const times = await one('select clock_timestamp() as later, now() as started');
    expect(+times.later).toBeGreaterThan(+times.started);
    const posted = await postJournal(db(), { periodId: current, entryDate: today, kind: 'shipment_confirmed', parts: ['slip_after'], lines: SALE, sourceRecordedAt: times.later.toISOString() });
    const saved = await one('select source_recorded_at, recorded_at, source_recorded_at <= recorded_at as ordered from public.accounting_journal_entries where id = $1', [posted.entryId]);
    expect(saved.ordered).toBe(true);
    expect(+saved.source_recorded_at).toBe(+times.started);
    expect(+saved.recorded_at).toBe(+times.started);
  });

  test('FREQ-554-AC-09: 取り消しのcoreも出来事の記録の日時を受けて遅れの印を決める', async () => {
    const { last } = await solePeriods();
    const source = `${lastYear}-03-02T01:00:00.000Z`;
    const a = await postJournal(db(), { periodId: last, entryDate: `${lastYear}-03-01`, kind: 'return_arrived', parts: ['ret_a'], lines: SALE, sourceRecordedAt: source });
    const b = await postJournal(db(), { periodId: last, entryDate: `${lastYear}-03-01`, kind: 'return_arrived', parts: ['ret_b'], lines: SALE, sourceRecordedAt: source });
    const withSource = await reverse(a.entryId, 'return cancelled', null, source);
    const withoutSource = await reverse(b.entryId, 'return cancelled');
    const saved = await one(`select (select is_late from public.accounting_journal_entries where id = $1) as with_source,
      (select source_recorded_at from public.accounting_journal_entries where id = $1) as kept,
      (select is_late from public.accounting_journal_entries where id = $2) as without_source`, [withSource.entry_id, withoutSource.entry_id]);
    expect({ ...saved, kept: saved.kept.toISOString() }).toEqual({ with_source: false, kept: source, without_source: true });
  });

  test('FREQ-554-AC-10: coreの借貸の不一致はCOMMIT前に出来事の例外処理で捕まえられ、失敗した見出し・行・採番は残らない', async () => {
    const { current } = await solePeriods();
    await db().query('create temp table acc_s2_caught(event text, message text, detail text) on commit drop');
    const good = journalLines(SALE);
    const bad = journalLines([{ account: '1130', debit: 1000 }, { account: '4010', credit: 999 }]);
    // One handler per event, the same shape plan 2 uses: a failure is recorded and the next event goes on.
    await db().query(`do $events$
      declare v_event record; v_message text; v_detail text;
      begin
        for v_event in select * from (values ('pi_ok1', '${good}'), ('pi_bad', '${bad}'), ('pi_ok2', '${good}')) as e(part, lines) loop
          begin
            perform private.accounting_post_journal_core(null, '${current}'::uuid, '${today}'::date, 'payment_confirmed',
              array[v_event.part], 'd', v_event.lines::jsonb);
          exception when others then
            get stacked diagnostics v_message = message_text, v_detail = pg_exception_detail;
            insert into pg_temp.acc_s2_caught values (v_event.part, v_message, v_detail);
          end;
        end loop;
      end $events$`);
    expect((await db().query('select * from pg_temp.acc_s2_caught')).rows).toEqual([{ event: 'pi_bad', message: 'ACCOUNTING_ENTRY_UNBALANCED', detail: 'balance' }]);
    expect(await counts()).toEqual({ entries: 2, lines: 4, numbers: 2 });
    expect((await db().query('select entry_no::int as n from public.accounting_journal_entries order by entry_no')).rows).toEqual([{ n: 1 }, { n: 2 }]);
    // Nothing deferred is left to fail at COMMIT.
    expect(await failure(async () => undefined)).toBeNull();
  });

  test('FREQ-554-AC-10: coreは期間の重なりとすき間も返る前に断り、遅延制約は保険として残る', async () => {
    const first = await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2027-07-01', endsOn: '2028-06-30' });
    const caught = async (periodId: string, date: string, part: string) => {
      await db().query(`do $layout$ begin
          perform private.accounting_post_journal_core(null, '${periodId}'::uuid, '${date}'::date, 'payment_confirmed',
            array['${part}'], 'd', '${journalLines(SALE)}'::jsonb);
          perform pg_catalog.set_config('acc_s2.caught', 'none', true);
        exception when others then perform pg_catalog.set_config('acc_s2.caught', sqlerrm, true);
        end $layout$`);
      return (await one("select current_setting('acc_s2.caught') as message")).message as string;
    };
    await db().query('savepoint acc_s2_layout');
    await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2028-01-01', endsOn: '2028-12-31' });
    expect(await caught(first, '2027-08-01', 'pi_overlap')).toBe('ACCOUNTING_PERIOD_OVERLAP');
    await db().query('rollback to savepoint acc_s2_layout');
    await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2028-08-01', endsOn: '2029-07-31' });
    expect(await caught(first, '2027-08-01', 'pi_gap')).toBe('ACCOUNTING_PERIOD_GAP');
    await db().query('rollback to savepoint acc_s2_layout');
    // A sole period beside them belongs to another business type and does not count.
    await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: '2027-01-01', endsOn: '2027-12-31' });
    expect(await caught(first, '2027-08-01', 'pi_fine')).toBe('none');
    expect(await counts()).toEqual({ entries: 1, lines: 2, numbers: 1 });
    // The deferred triggers still refuse rows written past the core.
    const direct = async (lines: [string, number, number][]) => failure(async () => {
      const id = (await one(`insert into public.accounting_journal_entries (period_id, entry_no, entry_date, event_kind, dedupe_key,
        content_hash, description) values ($1, 90, '2027-08-02', 'payment_confirmed', $2, 'h', 'd') returning id`, [first, `payment_confirmed:direct_${lines.length}`])).id;
      for (const [index, [account, debit, credit]] of lines.entries()) {
        await db().query('insert into public.accounting_journal_lines (entry_id, line_no, account_code, debit, credit) values ($1, $2, $3, $4, $5)',
          [id, index + 1, account, debit, credit]);
      }
    });
    expect(await direct([['1130', 1000, 0], ['4010', 0, 900]])).toEqual({ code: '23514', message: 'ACCOUNTING_ENTRY_UNBALANCED', detail: 'balance' });
    expect(await direct([['1130', 1000, 1000], ['4010', 0, 1000]])).toEqual({ code: '23514', message: 'ACCOUNTING_ENTRY_UNBALANCED', detail: 'one_sided' });
    expect(await direct([])).toEqual({ code: '23514', message: 'ACCOUNTING_ENTRY_UNBALANCED', detail: 'min_lines' });
  });
});
