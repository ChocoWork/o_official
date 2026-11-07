import fs from 'node:fs';
import path from 'node:path';
import type { PgClient } from './local-db';

const directory = path.join(process.cwd(), 'supabase/migrations');
function migration(suffix: string): { files: string[]; sql: string } {
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(suffix));
  return { files, sql: files.length === 1 ? fs.readFileSync(path.join(directory, files[0]), 'utf8') : '' };
}
const s4 = migration('_accounting_p1_manual_entry_journal.sql');
const s5 = migration('_accounting_p1_a8_migrate_manual.sql');
/** The accounting S4 and S5 migration texts (empty when missing, so the source contract fails visibly). */
export const ACCOUNTING_S4_SQL = s4.sql;
export const ACCOUNTING_S5_SQL = s5.sql;
export const ACCOUNTING_S5_FILES = s5.files;
/** The last migration the A8 replay starts from (`supabase db reset --version` this). */
export const ACCOUNTING_S3_VERSION = '20261107130300';

/** One section of S5 between `-- ACC_S5_<name>_BEGIN` and `-- ACC_S5_<name>_END`. */
export function accountingS5Section(name: 'BODY' | 'FINAL_ASSERT' | 'LINES'): string {
  return ACCOUNTING_S5_SQL.split(`-- ACC_S5_${name}_BEGIN\n`)[1]?.split(`-- ACC_S5_${name}_END`)[0] ?? '';
}

/** A migration without its own BEGIN; / COMMIT;, to run inside a transaction or savepoint of the test. */
export function transactionBody(sql: string): string {
  if (!sql.startsWith('BEGIN;\n') || !/\nCOMMIT;\n?$/.test(sql)) throw new Error('ACC_MIGRATION_NOT_ONE_TRANSACTION');
  return sql.slice('BEGIN;\n'.length).replace(/\nCOMMIT;\n?$/, '\n');
}

export type LegacyActor = 'admin' | 'staff' | 'none';
/** One production-like manual transaction (dates and times as in the A8 window: late 2025 to October 2026). */
export type LegacyExpense = {
  key: string; date: string; createdAt: string; category: string; item: string; amount: number; method: string;
  type: 'expense' | 'income'; partner: string; createdBy: LegacyActor; edited?: boolean; deleted?: boolean;
};

const created = (date: string) => {
  const d = new Date(`${date}T01:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  return d.toISOString();
};
const row = (key: string, date: string, category: string, item: string, amount: number, method: string,
  extra: Partial<LegacyExpense> = {}): LegacyExpense => ({
  key, date, createdAt: created(date), category, item, amount, method, type: 'expense', partner: '', createdBy: 'admin', ...extra,
});

/**
 * The fixture of the A8 replay: 20 transactions inserted in this order (so ids do not follow the dates), 18 live and 2
 * logically deleted, 3 edited once; the history trigger leaves 20 insert + 3 update + 2 delete = 25 revisions.
 */
export const LEGACY_EXPENSES: readonly LegacyExpense[] = [
  row('a01', '2026-01-15', '消耗品費', 'コピー用紙', 1980, 'クレジットカード', { partner: '家電店' }),
  row('a02', '2025-11-20', '荷造運賃', '梱包材', 3300, '現金'),
  row('a03', '2026-03-02', '通信費', 'サーバー代', 1650, 'クレジットカード', { edited: true }),
  row('a04', '2025-12-05', '広告宣伝費', 'SNS広告', 5000, 'クレジットカード', { partner: '広告会社' }),
  row('a05', '2026-03-02', '仕入高', '生地', 42000, '銀行', { partner: '生地屋' }),
  row('a06', '2026-02-10', '雑収入', '補助', 10000, '銀行', { type: 'income' }),
  row('a07', '2026-04-18', '消耗品費', '糸', 880, '現金', { createdBy: 'staff' }),
  row('a08', '2025-12-05', '事務用品費', 'ペン', 330, '現金', { createdBy: 'none' }),
  row('a09', '2026-05-01', '旅費交通費', '電車', 640, 'プライベート'),
  row('a10', '2026-05-20', '外注工賃', '縫製', 30000, '銀行', { deleted: true }),
  row('a11', '2026-06-03', '支払手数料', '振込手数料', 220, '銀行'),
  row('a12', '2026-06-30', '登録されていない科目', 'その他', 500, '現金'),
  row('a13', '2025-12-28', '新聞図書費', '本', 2420, 'クレジットカード'),
  row('a14', '2026-07-07', '地代家賃', '倉庫', 15000, '銀行', { edited: true }),
  row('a15', '2026-07-15', '雑収入', 'ポイント', 300, 'プライベート', { type: 'income' }),
  row('a16', '2026-08-01', '消耗品費', 'ハンガー', 4400, 'クレジットカード', { deleted: true }),
  row('a17', '2026-08-20', '荷造運賃', '送料', 1200, '現金'),
  row('a18', '2026-09-09', '水道光熱費', '電気', 3800, '銀行', { edited: true }),
  row('a19', '2026-10-01', '通信費', '電話', 2000, 'クレジットカード'),
  row('a20', '2026-10-20', '仕入高', 'ボタン', 6600, '銀行', { partner: '資材店' }),
];
/** An edit adds this to the amount. */
export const LEGACY_EDIT_DELTA = 100;
/** The 8 receipts (one key per receipt; a03 has two, the deleted a10 has one). */
export const LEGACY_RECEIPT_KEYS: readonly string[] = ['a01', 'a03', 'a03', 'a05', 'a10', 'a14', 'a18', 'a20'];

export type LegacyRow = LegacyExpense & { id: string; actorId: string | null; finalAmount: number };
export type LegacyFixture = { rows: LegacyRow[]; byKey: Map<string, LegacyRow>; live: LegacyRow[] };

/**
 * Insert the fixture as the connection's role (postgres; before S4 nothing else fires than the history and
 * updated_at triggers): the two legacy years with zero openings, the 20 transactions, the edits and logical deletions
 * through UPDATE (so the history trigger writes the revisions), and the receipts. `live` is in (date, id) order.
 */
export async function insertLegacyFixture(client: PgClient, actors: { admin: string; staff: string }): Promise<LegacyFixture> {
  await client.query(`insert into public.admin_finance_years (fiscal_year, business_type, sales_revenue)
    values (2025, 'soleProprietor', 0), (2026, 'soleProprietor', 128000)`);
  const actorId = (who: LegacyActor) => (who === 'admin' ? actors.admin : who === 'staff' ? actors.staff : null);
  const rows: LegacyRow[] = [];
  for (const expense of LEGACY_EXPENSES) {
    const inserted = (await client.query(`insert into public.admin_finance_expenses (expense_date, category, item_name, amount,
        payment_method, entry_type, partner, created_by, created_at) values ($1::date, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
      returning id`, [expense.date, expense.category, expense.item, expense.amount, expense.method, expense.type, expense.partner,
      actorId(expense.createdBy), expense.createdAt])).rows[0];
    rows.push({ ...expense, id: String(inserted.id), actorId: actorId(expense.createdBy),
      finalAmount: expense.amount + (expense.edited ? LEGACY_EDIT_DELTA : 0) });
  }
  for (const r of rows.filter((x) => x.edited)) {
    await client.query('update public.admin_finance_expenses set amount = $2, updated_by = $3 where id = $1',
      [r.id, r.finalAmount, actors.admin]);
  }
  for (const r of rows.filter((x) => x.deleted)) {
    await client.query(`update public.admin_finance_expenses set deleted_at = $2::timestamptz + interval '1 day', deleted_by = $3
      where id = $1`, [r.id, r.createdAt, actors.admin]);
  }
  for (const [index, key] of LEGACY_RECEIPT_KEYS.entries()) {
    const r = rows.find((x) => x.key === key);
    if (!r) throw new Error('ACC_LEGACY_RECEIPT_KEY_MISSING');
    await client.query(`insert into public.admin_finance_receipts (entry_id, storage_path, file_name, mime_type, file_size, uploaded_by)
      values ($1, $2, $3, 'image/jpeg', 120000, $4)`,
    [r.id, `${r.date.slice(0, 4)}/${r.id}/1700000000000-${index}.jpg`, `receipt-${index}.jpg`, actors.admin]);
  }
  const live = rows.filter((x) => !x.deleted)
    .sort((a, b) => (a.date === b.date ? Number(a.id) - Number(b.id) : a.date < b.date ? -1 : 1));
  return { rows, byKey: new Map(rows.map((r) => [r.key, r])), live };
}

/**
 * Pin the current state as the S5 baseline BEFORE a caller tampers, so a replay of the S5 final assert compares with
 * what exists now: the migrated entries stand for the live rows of apply time, and the row, revision and receipt
 * counts and the history trigger's enabled mode are read as they are. Then the caller runs the assert.
 */
export async function pinAccountingS5Baseline(client: PgClient): Promise<void> {
  await client.query(`create temp table accounting_s5_baseline(payload jsonb) on commit drop;
    insert into pg_temp.accounting_s5_baseline(payload) select jsonb_build_object(
      'live', coalesce((select jsonb_agg(jsonb_build_object('id', e.source_id, 'date', to_char(e.entry_date, 'YYYY-MM-DD'),
          'recorded_at', e.recorded_at, 'by', e.recorded_by) order by e.entry_date, e.source_id::bigint)
        from public.accounting_journal_entries e where e.event_kind = 'migrated_entry'), '[]'::jsonb),
      'deleted', (select count(*) from public.admin_finance_expenses where deleted_at is not null),
      'expenses', (select count(*) from public.admin_finance_expenses),
      'revisions', (select count(*) from public.admin_finance_entry_revisions),
      'receipts', (select count(*) from public.admin_finance_receipts),
      'history_trigger', (select t.tgenabled::text from pg_trigger t
        where t.tgrelid = 'public.admin_finance_expenses'::regclass and t.tgname = 'trigger_admin_finance_entry_revisions'))`);
}
