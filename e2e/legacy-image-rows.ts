/**
 * CHECK より前からある旧い形の画像の行を、E2E のために作る道具（ADR-0162）。
 *
 * looks.image_urls・news_articles.image_url の CHECK は NOT VALID で入るので、本番には CHECK に合わない旧い行
 * （外の URL・旧い見本の道筋）が残りうる。アプリが「署名しない・null にする」ことを確かめる試験は、その旧い行が要る。
 * 今の CHECK は新しい INSERT を断るので、1 つの取引で制約を外して行を入れ、同じ定義で NOT VALID に戻す。
 *
 * ALTER TABLE は表に ACCESS EXCLUSIVE の鍵を取り、commit まで持つ。別の接続からは制約の無い瞬間が見えない
 * （FR-LOOK-SEC-004 が一時のトリガーを同じやり方で作るのと同じ考え）。制約がまだ無い DB（移行より前）では
 * 制約に触らず insert だけする。postgres の接続（withLocalDb）で使う。
 */
import type { PgClient } from '../tests/integration/db/helpers/local-db';

type LegacyTable = 'looks' | 'news_articles';
type LegacyConstraint = 'looks_image_urls_path_check' | 'news_articles_image_url_path_check';

/**
 * 旧い形の行を 1 件入れて、その id を返す。
 *
 * @param db postgres の接続
 * @param table 行を入れる表
 * @param constraint 一時的に外す CHECK の名前（その表の画像の道筋の CHECK）
 * @param insertSql INSERT 文。`returning id` が無ければ足す
 * @param params INSERT 文の引数
 */
export async function insertLegacyImageRow(
  db: PgClient,
  table: LegacyTable,
  constraint: LegacyConstraint,
  insertSql: string,
  params: unknown[],
): Promise<number> {
  const sql = /\breturning\b/i.test(insertSql) ? insertSql : `${insertSql} returning id`;
  await db.query('begin');
  try {
    const found = await db.query(
      `select pg_get_constraintdef(c.oid) as definition
       from pg_constraint c
       where c.conrelid = $1::regclass and c.conname = $2`,
      [`public.${table}`, constraint],
    );
    const definition = (found.rows[0]?.definition as string | undefined)?.replace(/\s+NOT VALID$/i, '');
    if (definition) {
      await db.query(`alter table public.${table} drop constraint ${constraint}`);
    }
    const inserted = await db.query(sql, params);
    if (definition) {
      await db.query(`alter table public.${table} add constraint ${constraint} ${definition} not valid`);
    }
    await db.query('commit');
    return Number(inserted.rows[0].id);
  } catch (error) {
    await db.query('rollback').catch(() => undefined);
    throw error;
  }
}
