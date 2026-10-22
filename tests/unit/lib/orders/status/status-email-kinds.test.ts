/** @jest-environment node */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ORDER_EMAIL_KINDS, SHOP_EMAIL_KINDS } from '@/lib/orders/email/order-email-types';

/**
 * 確認期限を進める種類の SQL と TS の一覧のずれを見張る（グループ E-5 最終レビュー Minor 1）。
 * TS 側は「店向け以外の全部」の本文にリンクを入れる。SQL 側（移行 A の complete_order_email）は種類の名前を直書きで並べる。
 * お客様向けの種類を片方だけに足すと、リンクは入るのに期限が進まないので、ここで落とす。
 */
const migration = readFileSync(
  path.resolve(__dirname, '../../../../../supabase/migrations/20261023100000_order_status_links.sql'),
  'utf8',
);

function advancingKindsInSql(sql: string): string[] {
  const matches = [...sql.matchAll(/IF\s+v_kind\s+IN\s*\(([^)]*)\)\s*THEN/g)];
  if (matches.length !== 1) throw new Error(`v_kind IN (...) が ${matches.length} か所ある（1か所のはず）`);
  const list = matches[0][1].replace(/--[^\n]*/g, '');
  return [...list.matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

function customerKindsInTs(): string[] {
  return ORDER_EMAIL_KINDS.filter((kind) => !(SHOP_EMAIL_KINDS as readonly string[]).includes(kind));
}

describe('確認期限を進める種類（移行 A の complete_order_email）', () => {
  it('SQL の IN の一覧は16種類で、重なりが無い', () => {
    const sqlKinds = advancingKindsInSql(migration);

    expect(sqlKinds).toHaveLength(16);
    expect(new Set(sqlKinds).size).toBe(16);
  });

  it('TS の ORDER_EMAIL_KINDS から店向け SHOP_EMAIL_KINDS を除いた集合と一致する', () => {
    const sqlKinds = advancingKindsInSql(migration);
    const tsKinds = customerKindsInTs();

    expect(tsKinds).toHaveLength(16);
    expect({
      onlyInSql: sqlKinds.filter((kind) => !tsKinds.includes(kind)),
      onlyInTs: tsKinds.filter((kind) => !sqlKinds.includes(kind)),
    }).toEqual({ onlyInSql: [], onlyInTs: [] });
  });
});
