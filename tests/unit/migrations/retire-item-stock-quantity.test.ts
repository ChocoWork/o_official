import fs from 'node:fs';
import path from 'node:path';

/**
 * items.stock_quantity（商品単位の在庫数）の廃止（FREQ-401）。
 *
 * 在庫の正を item_variants と在庫台帳（stock_movements）に一本化する。2系統が併存していると、
 * どちらを見ているかで答えが変わる。
 *
 * 在庫の有無は「買えるか」ではなく「納期」を分ける（FREQ-400）ので、在庫を理由に
 * カートも注文も止めない。この段で落とすのは、その「足りなければ断る」判定そのもの。
 *
 * 実際の挙動は tests/integration/db/ の各テストが本物の DB で確かめる。ここはファイルの形。
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
// 版番号は本番へ適用したときに確定するため、ファイル名の後半で探す。
const MIGRATION_SUFFIX = '_retire_item_stock_quantity.sql';

function readMigration(): string {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(MIGRATION_SUFFIX));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(MIGRATIONS_DIR, files[0]), 'utf8');
}

/** コメントを外した本文。 */
function statements(): string {
  return readMigration().replace(/--.*$/gm, '');
}

/** `AS $...$ ... $...$` で囲まれた関数本体を、関数名つきで取り出す。 */
function functionBodies(): Array<{ name: string; body: string }> {
  const sql = statements();
  const out: Array<{ name: string; body: string }> = [];
  const pattern = /\bcreate\s+or\s+replace\s+function\s+public\.([a-z_]+)[\s\S]*?\bas\s+(\$[a-z_]*\$)([\s\S]*?)\2/gi;

  for (const match of sql.matchAll(pattern)) {
    out.push({ name: match[1], body: match[3] });
  }

  return out;
}

const EXPECTED_FUNCTIONS = [
  'add_guest_cart_item',
  'update_guest_cart_item_quantity',
  'update_cart_item_quantity_secure',
  'backfill_item_variants',
  'finalize_order_from_checkout_draft',
  'release_stock_for_unpaid_order',
];

describe('items.stock_quantity を廃止するマイグレーション', () => {
  it('全体をトランザクションで包む（規約: docs/06_Operations/db-migrations.md）', () => {
    const sql = readMigration();
    expect(sql).toMatch(/^BEGIN;$/im);
    expect(sql).toMatch(/^COMMIT;$/im);
  });

  it('列を読んでいた関数をすべて作り直す', () => {
    expect(functionBodies().map((fn) => fn.name)).toEqual(EXPECTED_FUNCTIONS);
  });

  /**
   * 列を落とす前に、参照している関数を作り直しておく必要がある。plpgsql の本体は
   * 依存関係として追跡されないため、落としても DROP は成功し、実行時に初めて壊れる。
   */
  it('関数を作り直してから列を落とす', () => {
    const sql = statements();
    const lastFunction = sql.lastIndexOf('$function$;');
    const lastDollar = sql.lastIndexOf('$$;');
    const drop = sql.search(/ALTER TABLE public\.items\s+DROP COLUMN stock_quantity;/i);

    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(Math.max(lastFunction, lastDollar));
  });

  it('作り直した関数の本体に items の在庫数が残っていない', () => {
    for (const fn of functionBodies()) {
      // item_variants.stock_quantity は在庫の正なので残る。items 側だけを見る。
      expect(fn.body).not.toMatch(/\bi\.stock_quantity\b/);
      expect(fn.body).not.toMatch(/items\s+i\b[\s\S]{0,200}?set stock_quantity/i);
      expect(fn.body).not.toMatch(/INSUFFICIENT_STOCK/);
      expect(fn.body).not.toMatch(/exceeds available stock/);
    }
  });

  it('公開されているかの確認は残す（在庫とは別の話）', () => {
    const cartFunctions = functionBodies().filter((fn) => fn.name.includes('cart'));

    expect(cartFunctions).toHaveLength(3);
    for (const fn of cartFunctions) {
      expect(fn.body).toMatch(/'published'/);
    }
  });

  it('注文確定は引き当てを台帳で続ける', () => {
    const finalize = functionBodies().find((fn) => fn.name === 'finalize_order_from_checkout_draft');

    expect(finalize?.body).toMatch(/INSERT INTO public\.stock_movements[\s\S]*?'purchase'/i);
    expect(finalize?.body).toMatch(/ITEM_NOT_PUBLISHED/);
  });

  it('在庫戻しは台帳への cancel だけ行う', () => {
    const release = functionBodies().find((fn) => fn.name === 'release_stock_for_unpaid_order');

    expect(release?.body).toMatch(/insert into public\.stock_movements[\s\S]*?'cancel'/i);
    // items を書かないのでロックも取らない
    expect(release?.body).not.toMatch(/from public\.items/i);
  });

  it('バリアント生成は旧在庫を移さない', () => {
    const backfill = functionBodies().find((fn) => fn.name === 'backfill_item_variants');

    expect(backfill?.body).toMatch(/INSERT INTO public\.item_variants/i);
    expect(backfill?.body).not.toMatch(/INSERT INTO public\.stock_movements/i);
  });
});
