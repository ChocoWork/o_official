import fs from 'node:fs';
import path from 'node:path';

/**
 * 注文メールの送信権を1つだけ取る仕組み（FREQ-386、チップ: 注文確認メールの重複）。
 *
 * 注文確定は「画面からの complete」と「webhook」の2経路から走り、どちらも同じ注文を受け取る。
 * 送信済みの記録が無いため、コンビニ・銀行振込では同じ案内が2通届き、カードでは webhook が
 * 先着すると1通も届かない。送る前に DB で権利を取り、取れた経路だけが送る。
 *
 * 実際に1回しか取れないことは tests/integration/db/order_email_claims.integration.test.ts が
 * 実 DB で確かめる。このテストは、置き場所と権限が変わらないことを守る。
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
// 版番号は本番へ適用したときに確定するため、ファイル名の後半で探す。
const MIGRATION_SUFFIX = '_add_order_email_claims.sql';

function readMigration(): string {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(MIGRATION_SUFFIX));
  expect(files).toHaveLength(1);
  // 説明コメントにも関数名や列名が出てくるので、判定から外す
  return fs.readFileSync(path.join(MIGRATIONS_DIR, files[0]), 'utf8').replace(/--.*$/gm, '');
}

describe('注文メールの送信権のマイグレーション', () => {
  it('記録は private スキーマに置く（Data API から触れない場所）', () => {
    const sql = readMigration();
    expect(sql).toMatch(/create table private\.order_emails/i);
    expect(sql).not.toMatch(/create table public\.order_emails/i);
  });

  it('注文と種類の組で1行だけにする', () => {
    const sql = readMigration();
    expect(sql).toMatch(/order_id\s+uuid\s+not null\s+references public\.orders\s*\(id\)\s+on delete cascade/i);
    expect(sql).toMatch(/kind\s+text\s+not null[\s\S]*?check\s*\(\s*kind in \('awaiting_payment',\s*'paid'\)\s*\)/i);
    expect(sql).toMatch(/primary key \(order_id, kind\)/i);
  });

  it('取る関数は、入っていなければ true、既にあれば false を返す', () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /create or replace function public\.claim_order_email\s*\(\s*_order_id uuid,\s*_kind text\s*\)[\s\S]*?returns boolean/i,
    );
    expect(sql).toMatch(/insert into private\.order_emails\s*\(order_id, kind\)[\s\S]*?on conflict\s*\(order_id, kind\)\s*do nothing/i);
  });

  it('戻す関数がある（送信に失敗したら取り消して、あとの経路に譲る）', () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /create or replace function public\.release_order_email\s*\(\s*_order_id uuid,\s*_kind text\s*\)[\s\S]*?returns boolean/i,
    );
    expect(sql).toMatch(/delete from private\.order_emails/i);
  });

  it('2つの関数とも SECURITY DEFINER で、探索パスを空に固定する', () => {
    const definitions = readMigration().match(/create or replace function public\.(claim|release)_order_email[\s\S]*?\$\$;/gi) ?? [];
    expect(definitions).toHaveLength(2);
    for (const definition of definitions) {
      expect(definition).toMatch(/security definer/i);
      expect(definition).toMatch(/set search_path = ''/i);
    }
  });

  it('実行できるのは service_role だけ（public / anon / authenticated からは取り上げる）', () => {
    const sql = readMigration();
    for (const fn of ['claim_order_email', 'release_order_email']) {
      expect(sql).toMatch(
        new RegExp(`revoke all on function public\\.${fn}\\(uuid, text\\) from public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`, 'i'),
      );
      expect(sql).toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\(uuid, text\\) to service_role\\s*;`, 'i'),
      );
    }
  });

  it('全体をトランザクションで包む（規約: docs/ops/db-migrations.md）', () => {
    const sql = readMigration();
    expect(sql).toMatch(/^BEGIN;$/im);
    expect(sql).toMatch(/^COMMIT;$/im);
  });
});
