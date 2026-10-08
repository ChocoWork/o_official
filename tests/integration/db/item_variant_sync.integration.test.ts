/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';

const COLORS = [{ name: 'BLACK', hex: '#000000' }, { name: 'IVORY', hex: '#ffffff' }];

async function createItem(db: PgClient, sizes = ['M', 'L']): Promise<number> {
  const result = await db.query(
    `insert into public.items (name, description, price, category, image_url, status, colors, sizes)
     values ('variant sync test', 'バリアント同期の試験', 5000, 'TOPS', '/test.png', 'published', $1::jsonb, $2::text[])
     returning id`,
    [JSON.stringify(COLORS), sizes],
  );
  return Number(result.rows[0].id);
}

async function variants(db: PgClient, itemId: number) {
  return (await db.query('select id, color_id, size_id from public.item_variants where item_id = $1 order by id', [itemId])).rows;
}

describeLocalDb('integration: 商品の色・サイズのバリアント同期（移行 C）', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => {
    // 成否にかかわらず、試験で作った商品・色・サイズ・バリアントを残さないため戻す。
    await db().query('rollback');
  });

  test('色2・サイズ2の商品を作ると4つのバリアントができる', async () => {
    const itemId = await createItem(db());
    expect(await variants(db(), itemId)).toHaveLength(4);
  });

  test('色を1つ足すと2つ増え、前のバリアントの番号は変わらない', async () => {
    const itemId = await createItem(db());
    const before = await variants(db(), itemId);
    await db().query('update public.items set colors = $2::jsonb where id = $1', [
      itemId, JSON.stringify([...COLORS, { name: 'NAVY', hex: '#000080' }]),
    ]);
    const after = await variants(db(), itemId);
    expect(after).toHaveLength(6);
    expect(after).toEqual(expect.arrayContaining(before));
  });

  test('色・サイズ以外だけを変えてもトリガーが動かず、バリアントは増えない', async () => {
    const itemId = await createItem(db());
    const before = await variants(db(), itemId);
    // 色だけを直接足して同期の余地を作り、名前の更新で backfill が動かないことを観測する。
    await db().query("insert into public.item_colors (item_id, name, hex, position) values ($1, 'NAVY', '#000080', 2)", [itemId]);
    await db().query("update public.items set name = 'renamed sync test' where id = $1", [itemId]);
    expect(await variants(db(), itemId)).toEqual(before);
  });

  test('サイズが空の商品は色の数だけバリアントができる', async () => {
    const itemId = await createItem(db(), []);
    const rows = await variants(db(), itemId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.size_id === null)).toBe(true);
  });
});
