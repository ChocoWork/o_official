/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { readMigration, resolveSeedPath } from '../../helpers/staged-supabase';
import { describeLocalDb } from './helpers/local-db';

/**
 * stockists.type の NOT NULL を外した移行 stockists_type_optional（DATA-STOCKIST-001、FR-ADMIN-006-AC-02、FREQ-18-AC-01）。
 * 前半は移行のファイルの形だけを見る（DB なしで流れる）。後半は手元の使い捨て DB でだけ流し、
 * 各試験は取引の中で動かして巻き戻し、足した行を残さない。
 */
const TYPE_VALUES = ['FLAGSHIP STORE', 'STORE', 'SELECT SHOP'];

describe('DATA-STOCKIST-001 移行 stockists_type_optional の形（DB なし）', () => {
  const sql = readMigration('stockists_type_optional');

  test('DATA-STOCKIST-001 NOT NULL を外す文を 1 回だけ持ち、列も CHECK も消さない', () => {
    expect(sql.match(/DROP NOT NULL/g)).toHaveLength(1);
    expect(sql).toMatch(/ALTER TABLE public\.stockists ALTER COLUMN type DROP NOT NULL/);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/DROP CONSTRAINT/i);
  });

  test('DATA-STOCKIST-001 ヘッダーに ROLLBACK の節（値を入れてから SET NOT NULL）を持つ', () => {
    const header = sql.slice(0, sql.indexOf('BEGIN;'));
    expect(header).toMatch(/ROLLBACK/);
    expect(header).toMatch(/UPDATE public\.stockists SET type = 'STORE' WHERE type IS NULL/);
    expect(header).toMatch(/ALTER COLUMN type SET NOT NULL/);
  });

  test('DATA-STOCKIST-001 1 組の取引・スキーマ再読込・自己検査（55000）を持つ', () => {
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.match(/NOTIFY pgrst, 'reload schema';/g)).toHaveLength(1);
    expect(sql).toMatch(/SEC_WAVE2_MIGRATION_ASSERTION_FAILED/);
    expect(sql).toMatch(/ERRCODE = '55000'/);
    expect(sql).toMatch(/DETAIL = 'stockists_type_optional'/);
  });

  test('DATA-STOCKIST-001 見本 seed.sql の取扱店は type を入れたまま', () => {
    const seed = fs.readFileSync(resolveSeedPath('supabase/seed.sql'), 'utf8');
    expect(seed).toMatch(/INSERT INTO public\.stockists \(id, type, name, address, phone, time, holiday, status\) VALUES/);
  });
});

describeLocalDb('integration: stockists.type は NULL 可（移行 stockists_type_optional 適用後）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  /** 失敗が取引全体を壊さないよう、savepoint の中で流して SQLSTATE と制約名を返す。 */
  async function failure(sql: string, params: unknown[] = []): Promise<{ code?: string; constraint?: string }> {
    await db().query('savepoint expected_failure');
    try {
      await db().query(sql, params);
      return {};
    } catch (caught) {
      const error = caught as { code?: string; constraint?: string };
      return { code: error.code, constraint: error.constraint };
    } finally {
      await db().query('rollback to savepoint expected_failure');
    }
  }

  test('DATA-STOCKIST-001 type 列は残り、is_nullable は YES', async () => {
    const result = await db().query(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'stockists' and column_name = 'type'`,
    );

    expect(result.rows).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
  });

  test('DATA-STOCKIST-001 type を省いた insert（管理の作成の窓口と同じ形）が通り、type は NULL になる', async () => {
    const inserted = await db().query(
      `insert into public.stockists (name, address, phone, "time", holiday, status)
       values ($1, '東京都渋谷区1-1-1', '03-0000-0000', '11:00-19:00', '水曜', 'private')
       returning type`,
      [`integration type optional ${randomUUID()}`],
    );

    expect(inserted.rows).toEqual([{ type: null }]);
  });

  test('DATA-STOCKIST-001 type を NULL で明示した insert も通る', async () => {
    const inserted = await db().query(
      `insert into public.stockists (type, name, address, phone, "time", holiday)
       values (null, $1, 'a', 'p', 't', 'h') returning type`,
      [`integration type null ${randomUUID()}`],
    );

    expect(inserted.rows).toEqual([{ type: null }]);
  });

  test.each(TYPE_VALUES)('DATA-STOCKIST-001 種別 %s は今までどおり入る', async (type) => {
    const inserted = await db().query(
      `insert into public.stockists (type, name, address, phone, "time", holiday)
       values ($1, $2, 'a', 'p', 't', 'h') returning type`,
      [type, `integration type ${randomUUID()}`],
    );

    expect(inserted.rows).toEqual([{ type }]);
  });

  test.each(['BAD', 'store', ''])('DATA-STOCKIST-001 種別 "%s" は CHECK stockists_type_check の違反（23514）で落ちる', async (type) => {
    const result = await failure(
      `insert into public.stockists (type, name, address, phone, "time", holiday)
       values ($1, 'bad type', 'a', 'p', 't', 'h')`,
      [type],
    );

    expect(result).toEqual({ code: '23514', constraint: 'stockists_type_check' });
  });

  test('DATA-STOCKIST-001 CHECK stockists_type_check は残っている', async () => {
    const result = await db().query(
      `select conname from pg_constraint
       where conrelid = 'public.stockists'::regclass and contype = 'c' and conname = 'stockists_type_check'`,
    );

    expect(result.rows).toEqual([{ conname: 'stockists_type_check' }]);
  });

  test('DATA-STOCKIST-001 他の列（name・address・phone・time・holiday）は NOT NULL のまま', async () => {
    const result = await db().query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'stockists' and is_nullable = 'NO'
         and column_name in ('name', 'address', 'phone', 'time', 'holiday', 'status')
       order by column_name`,
    );

    expect(result.rows.map((row) => row.column_name)).toEqual(['address', 'holiday', 'name', 'phone', 'status', 'time']);
  });

  test('DATA-STOCKIST-001 見本の取扱店の type は消えていない', async () => {
    const expected: Record<string, string> = {
      '1': 'SELECT SHOP', '2': 'SELECT SHOP', '3': 'SELECT SHOP', '4': 'STORE', '5': 'STORE', '6': 'FLAGSHIP STORE',
    };
    const seeded = await db().query(
      `select id::text as id, type from public.stockists
       where id between 1 and 6
         and name in ('Aoyama Sample Select', 'Osaka Sample Select', 'Kyoto Sample Select',
                      'Ginza Sample Store', 'Kobe Sample Store', 'Tokyo Synthetic Flagship')`,
    );

    expect(seeded.rows.length).toBeGreaterThan(0);
    for (const row of seeded.rows) {
      expect(row.type).toBe(expected[row.id]);
    }
  });
});
