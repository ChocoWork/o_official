# バリアント在庫の土台 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** サイズ × カラーのバリアント単位で在庫を持つテーブル群と、追記専用の在庫台帳を追加し、既存の商品データを移行する。

**Architecture:** `item_colors` / `item_sizes` / `item_variants` を新設し、在庫の増減は `stock_movements` への追記のみで行う。AFTER INSERT トリガーが `item_variants.stock_quantity` に反映し、`CHECK (stock_quantity >= 0)` が最終防衛線になる。本計画は追加のみで、既存の `items.colors` / `items.sizes` / `items.stock_quantity` は残す（削除は計画5）。したがって本計画の全タスクを通してアプリケーションコードは無変更で、ビルドとテストは常に通る。

**Tech Stack:** Postgres 15（Supabase）、`supabase` CLI 2.116、Jest + `pg`（`tests/integration/db/*.integration.test.ts` の既存パターン）

**Spec:** [docs/superpowers/specs/2026-09-06-variant-inventory-and-cart-ownership-design.md](../specs/2026-09-06-variant-inventory-and-cart-ownership-design.md)

## Global Constraints

- 本システムは未公開のため、過去のデータ形式との互換レイヤは作らない。旧列は計画5で削除する
- マイグレーションは `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` に置く。既存の最新は `20260901120426_lock_down_guest_cart_rpc.sql`
- マイグレーションの適用は `npx supabase db reset`（ローカルの全マイグレーションを再適用）。ローカル DB は `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- DB テストは `tests/integration/db/` に置き、`DATABASE_URL` が未設定ならスキップする既存パターンに従う。テストは `BEGIN` / `ROLLBACK` で囲み、データを残さない
- 在庫の実数は公開 API から絶対に出さない。`item_variants` と `stock_movements` はクライアントから直接読めないようにする
- 新規テーブルは全て RLS を有効化する
- コミットメッセージは日本語、末尾に `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` を付ける

---

## File Structure

| ファイル | 責務 |
|---|---|
| `supabase/migrations/20260906090000_add_variant_inventory_tables.sql` | `item_colors` / `item_sizes` / `item_variants` の定義、一意性、RLS、`items.made_to_order_lead_days` の追加 |
| `supabase/migrations/20260906090100_add_stock_movements.sql` | 在庫台帳、反映トリガー、追記専用の強制、RLS |
| `supabase/migrations/20260906090200_add_verify_stock_integrity.sql` | 台帳とキャッシュの検算関数 |
| `supabase/migrations/20260906090300_backfill_item_variants.sql` | 既存 `items` から色・サイズ・バリアントを生成し、在庫を寄せる |
| `supabase/migrations/20260906090400_add_order_items_variant_columns.sql` | `order_items` に `variant_id` / `fulfillment_type` を追加、`item_id` を bigint 化、後埋め |
| `supabase/migrations/20260906090500_add_variant_backorder_summary.sql` | 受注数の集計ビュー |
| `tests/integration/db/item_variants.integration.test.ts` | バリアントの一意性・RLS |
| `tests/integration/db/stock_movements.integration.test.ts` | 台帳の反映・下限・追記専用 |
| `tests/integration/db/backfill_variants.integration.test.ts` | 移行結果の検証 |
| `tests/integration/db/order_items_variant.integration.test.ts` | `order_items` の新列とビュー |

---

## Task 1: バリアントのテーブル群

**Files:**
- Create: `supabase/migrations/20260906090000_add_variant_inventory_tables.sql`
- Test: `tests/integration/db/item_variants.integration.test.ts`

**Interfaces:**
- Consumes: 既存 `public.items(id bigint, status text)`
- Produces: `public.item_colors(id, item_id, name, hex, position)` / `public.item_sizes(id, item_id, label, position)` / `public.item_variants(id, item_id, color_id, size_id, sku, stock_quantity, is_active, created_at, updated_at)` / `public.items.made_to_order_lead_days integer NULL`

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/db/item_variants.integration.test.ts`:

```typescript
export {};

const { Pool } = require('pg');

// item_variants の一意性と公開範囲を検証する。BEGIN / ROLLBACK で囲むためデータは残らない。
describe('integration: item_variants', () => {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    test.skip('skipping DB integration tests because DATABASE_URL is not set', () => {});
    return;
  }

  let pool: any;
  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function createItem(client: any): Promise<string> {
    const res = await client.query(
      `INSERT INTO public.items (name, description, price, category, image_url, status)
       VALUES ('variant test', 'desc', 1000, 'TOPS', '/images/test.jpg', 'published')
       RETURNING id`,
    );
    return res.rows[0].id;
  }

  test('同じ item_id / color_id / size_id の組み合わせは二重に登録できない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);
      const color = await client.query(
        `INSERT INTO public.item_colors (item_id, name, hex, position)
         VALUES ($1, 'Black', '#000000', 0) RETURNING id`,
        [itemId],
      );
      const size = await client.query(
        `INSERT INTO public.item_sizes (item_id, label, position)
         VALUES ($1, 'M', 1) RETURNING id`,
        [itemId],
      );

      await client.query(
        `INSERT INTO public.item_variants (item_id, color_id, size_id) VALUES ($1, $2, $3)`,
        [itemId, color.rows[0].id, size.rows[0].id],
      );

      await expect(
        client.query(
          `INSERT INTO public.item_variants (item_id, color_id, size_id) VALUES ($1, $2, $3)`,
          [itemId, color.rows[0].id, size.rows[0].id],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('color_id / size_id が NULL の組み合わせも二重に登録できない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);

      await client.query(`INSERT INTO public.item_variants (item_id) VALUES ($1)`, [itemId]);

      await expect(
        client.query(`INSERT INTO public.item_variants (item_id) VALUES ($1)`, [itemId]),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('stock_quantity は負にできない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);

      await expect(
        client.query(
          `INSERT INTO public.item_variants (item_id, stock_quantity) VALUES ($1, -1)`,
          [itemId],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('anon は item_variants を読めない（在庫の実数を公開しない）', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);
      await client.query(`INSERT INTO public.item_variants (item_id, stock_quantity) VALUES ($1, 5)`, [itemId]);

      // anon には SELECT 権限自体を与えていないため、0 行ではなく権限エラーになる
      await client.query(`SET LOCAL ROLE anon`);
      await expect(
        client.query(`SELECT count(*)::int AS c FROM public.item_variants`),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('items に made_to_order_lead_days があり、既定は NULL', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);

      const res = await client.query(
        `SELECT made_to_order_lead_days FROM public.items WHERE id = $1`,
        [itemId],
      );
      expect(res.rows[0].made_to_order_lead_days).toBeNull();

      await client.query(
        `UPDATE public.items SET made_to_order_lead_days = 21 WHERE id = $1`,
        [itemId],
      );
      const updated = await client.query(
        `SELECT made_to_order_lead_days FROM public.items WHERE id = $1`,
        [itemId],
      );
      expect(updated.rows[0].made_to_order_lead_days).toBe(21);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('made_to_order_lead_days は負にできない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);

      await expect(
        client.query(
          `UPDATE public.items SET made_to_order_lead_days = -1 WHERE id = $1`,
          [itemId],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('anon は published 商品の色とサイズを読める', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);
      await client.query(
        `INSERT INTO public.item_colors (item_id, name, hex, position) VALUES ($1, 'Ivory', '#f5f5f5', 0)`,
        [itemId],
      );
      await client.query(
        `INSERT INTO public.item_sizes (item_id, label, position) VALUES ($1, 'L', 2)`,
        [itemId],
      );

      await client.query(`SET LOCAL ROLE anon`);
      const colors = await client.query(
        `SELECT count(*)::int AS c FROM public.item_colors WHERE item_id = $1`,
        [itemId],
      );
      const sizes = await client.query(
        `SELECT count(*)::int AS c FROM public.item_sizes WHERE item_id = $1`,
        [itemId],
      );
      expect(colors.rows[0].c).toBe(1);
      expect(sizes.rows[0].c).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/item_variants.integration.test.ts`

Expected: FAIL。`relation "public.item_colors" does not exist` などのエラーになる。

- [ ] **Step 3: マイグレーションを書く**

`supabase/migrations/20260906090000_add_variant_inventory_tables.sql`:

```sql
-- サイズ × カラーのバリアントを在庫の単位にするためのテーブル群。
-- 既存の items.colors / items.sizes / items.stock_quantity はこの時点では残す
-- （アプリケーションの切り替えが終わったあと、後続のマイグレーションで削除する）。

BEGIN;

CREATE TABLE public.item_colors (
  id       bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  item_id  bigint NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  name     text   NOT NULL,
  hex      text   NOT NULL CHECK (hex ~ '^#[0-9a-fA-F]{6}$'),
  position integer NOT NULL DEFAULT 0,
  UNIQUE (item_id, name)
);
CREATE INDEX item_colors_item_id_idx ON public.item_colors (item_id);

-- position が表示順の真実。コード側の SIZE_ORDER ハードコードはこれに置き換える。
CREATE TABLE public.item_sizes (
  id       bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  item_id  bigint NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  label    text   NOT NULL,
  position integer NOT NULL DEFAULT 0,
  UNIQUE (item_id, label)
);
CREATE INDEX item_sizes_item_id_idx ON public.item_sizes (item_id);

CREATE TABLE public.item_variants (
  id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  item_id        bigint NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  color_id       bigint REFERENCES public.item_colors(id) ON DELETE RESTRICT,
  size_id        bigint REFERENCES public.item_sizes(id)  ON DELETE RESTRICT,
  sku            text UNIQUE,
  stock_quantity integer NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX item_variants_item_id_idx ON public.item_variants (item_id);

-- NULL を含む UNIQUE 制約は Postgres では重複を許すため、式インデックスで一意性を担保する。
CREATE UNIQUE INDEX item_variants_combo_key
  ON public.item_variants (item_id, coalesce(color_id, 0), coalesce(size_id, 0));

-- 受注時のお届け目安（商品単位）。在庫切れの組み合わせの表示に使う。
ALTER TABLE public.items
  ADD COLUMN made_to_order_lead_days integer
    CHECK (made_to_order_lead_days IS NULL OR made_to_order_lead_days >= 0);

ALTER TABLE public.item_colors   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_sizes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_variants ENABLE ROW LEVEL SECURITY;

-- 色とサイズは表示に必要なので、published 商品のものだけ公開する。
-- ポリシー内で join せず、IN + サブクエリにする（Supabase の RLS パフォーマンス推奨）。
CREATE POLICY "public read colors of published items" ON public.item_colors
  FOR SELECT TO anon, authenticated
  USING (item_id IN (SELECT id FROM public.items WHERE status = 'published'));

CREATE POLICY "public read sizes of published items" ON public.item_sizes
  FOR SELECT TO anon, authenticated
  USING (item_id IN (SELECT id FROM public.items WHERE status = 'published'));

-- 在庫の実数は業務データなので、クライアントからは一切読ませない。
-- 公開 API は service role で読み、在庫の有無だけに変換して返す。
CREATE POLICY "deny direct client access" ON public.item_variants
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

GRANT SELECT ON public.item_colors TO anon, authenticated;
GRANT SELECT ON public.item_sizes  TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.item_colors, public.item_sizes, public.item_variants TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.item_colors_id_seq, public.item_sizes_id_seq, public.item_variants_id_seq TO service_role;

COMMIT;
```

- [ ] **Step 4: 適用してテストが通ることを確認する**

Run:
```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/item_variants.integration.test.ts
```
Expected: 7 tests PASS

- [ ] **Step 5: コミット**

```bash
git add supabase/migrations/20260906090000_add_variant_inventory_tables.sql tests/integration/db/item_variants.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(db): サイズ×カラーのバリアントテーブルを追加

在庫の単位を商品からバリアントへ移すための土台。在庫の実数は
クライアントから読めないようにし、色とサイズのみ公開する。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 在庫台帳と反映トリガー

**Files:**
- Create: `supabase/migrations/20260906090100_add_stock_movements.sql`
- Test: `tests/integration/db/stock_movements.integration.test.ts`

**Interfaces:**
- Consumes: `public.item_variants(id, stock_quantity)`（Task 1）
- Produces: `public.stock_movements(id, variant_id, delta, reason, order_id, order_item_id, note, created_by, created_at)`、トリガー関数 `public.apply_stock_movement()`

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/db/stock_movements.integration.test.ts`:

```typescript
export {};

const { Pool } = require('pg');

// 在庫は台帳への追記だけで動く。台帳は追記専用で、在庫は負にならない。
describe('integration: stock_movements', () => {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    test.skip('skipping DB integration tests because DATABASE_URL is not set', () => {});
    return;
  }

  let pool: any;
  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function createVariant(client: any): Promise<string> {
    const item = await client.query(
      `INSERT INTO public.items (name, description, price, category, image_url, status)
       VALUES ('movement test', 'desc', 1000, 'TOPS', '/images/test.jpg', 'published')
       RETURNING id`,
    );
    const variant = await client.query(
      `INSERT INTO public.item_variants (item_id) VALUES ($1) RETURNING id`,
      [item.rows[0].id],
    );
    return variant.rows[0].id;
  }

  async function stockOf(client: any, variantId: string): Promise<number> {
    const res = await client.query(
      `SELECT stock_quantity FROM public.item_variants WHERE id = $1`,
      [variantId],
    );
    return res.rows[0].stock_quantity;
  }

  test('入庫を追記すると在庫が増える', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);

      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 3, 'restock')`,
        [variantId],
      );

      expect(await stockOf(client, variantId)).toBe(3);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('販売を追記すると在庫が減る', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);
      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 5, 'restock')`,
        [variantId],
      );

      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, -2, 'purchase')`,
        [variantId],
      );

      expect(await stockOf(client, variantId)).toBe(3);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('在庫を超える出庫は CHECK 制約で拒否される', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);
      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 1, 'restock')`,
        [variantId],
      );

      await expect(
        client.query(
          `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, -2, 'purchase')`,
          [variantId],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('delta = 0 は登録できない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);

      await expect(
        client.query(
          `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 0, 'adjustment')`,
          [variantId],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('台帳は追記専用で、更新も削除もできない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);
      const inserted = await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason)
         VALUES ($1, 2, 'restock') RETURNING id`,
        [variantId],
      );
      const movementId = inserted.rows[0].id;

      await expect(
        client.query(`UPDATE public.stock_movements SET delta = 99 WHERE id = $1`, [movementId]),
      ).rejects.toThrow();

      await expect(
        client.query(`DELETE FROM public.stock_movements WHERE id = $1`, [movementId]),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('anon は台帳を読めない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);
      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 1, 'restock')`,
        [variantId],
      );

      // anon には SELECT 権限自体を与えていないため、0 行ではなく権限エラーになる
      await client.query(`SET LOCAL ROLE anon`);
      await expect(
        client.query(`SELECT count(*)::int AS c FROM public.stock_movements`),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/stock_movements.integration.test.ts`

Expected: FAIL。`relation "public.stock_movements" does not exist`

- [ ] **Step 3: マイグレーションを書く**

`supabase/migrations/20260906090100_add_stock_movements.sql`:

```sql
-- 在庫台帳。在庫は台帳への追記でしか動かせないようにし、
-- アプリケーションが台帳を書き忘れることを構造的に不可能にする。

BEGIN;

CREATE TABLE public.stock_movements (
  id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  variant_id    bigint NOT NULL REFERENCES public.item_variants(id) ON DELETE RESTRICT,
  delta         integer NOT NULL CHECK (delta <> 0),
  reason        text    NOT NULL CHECK (reason IN
                  ('purchase','restock','adjustment','cancel','refund')),
  order_id      uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  order_item_id uuid REFERENCES public.order_items(id) ON DELETE SET NULL,
  note          text,
  created_by    uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_variant_id_idx ON public.stock_movements (variant_id);
CREATE INDEX stock_movements_order_id_idx   ON public.stock_movements (order_id);

-- 台帳の追記をバリアントの在庫へ反映する。
-- item_variants.stock_quantity の CHECK (>= 0) が在庫不足の最終防衛線になる。
CREATE OR REPLACE FUNCTION public.apply_stock_movement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  UPDATE public.item_variants
  SET stock_quantity = stock_quantity + NEW.delta,
      updated_at     = now()
  WHERE id = NEW.variant_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_movements_apply
  AFTER INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.apply_stock_movement();

-- 追記専用の強制。権限だけでなくトリガーでも止める（service role は権限を迂回できるため）。
CREATE OR REPLACE FUNCTION public.reject_stock_movement_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only';
END;
$$;

CREATE TRIGGER stock_movements_no_update
  BEFORE UPDATE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.reject_stock_movement_mutation();

CREATE TRIGGER stock_movements_no_delete
  BEFORE DELETE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.reject_stock_movement_mutation();

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deny direct client access" ON public.stock_movements
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

GRANT SELECT, INSERT ON public.stock_movements TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.stock_movements_id_seq TO service_role;

COMMIT;
```

- [ ] **Step 4: 適用してテストが通ることを確認する**

Run:
```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/stock_movements.integration.test.ts
```
Expected: 6 tests PASS

- [ ] **Step 5: コミット**

```bash
git add supabase/migrations/20260906090100_add_stock_movements.sql tests/integration/db/stock_movements.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(db): 追記専用の在庫台帳と反映トリガーを追加

在庫は台帳への追記でしか動かない。更新と削除はトリガーで禁止し、
在庫の下限は item_variants の CHECK 制約が守る。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 検算関数

**Files:**
- Create: `supabase/migrations/20260906090200_add_verify_stock_integrity.sql`
- Test: `tests/integration/db/stock_movements.integration.test.ts`（Task 2 のファイルに追記）

**Interfaces:**
- Consumes: `public.stock_movements`、`public.item_variants`（Task 1、2）
- Produces: `public.verify_stock_integrity() RETURNS TABLE(variant_id bigint, cached integer, ledger integer)` — 台帳の合計とキャッシュが食い違うバリアントだけを返す

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/db/stock_movements.integration.test.ts` の最後の `test(...)` の後ろに追記する:

```typescript
  test('整合しているときは verify_stock_integrity が何も返さない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);
      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 4, 'restock')`,
        [variantId],
      );

      const res = await client.query(
        `SELECT * FROM public.verify_stock_integrity() WHERE variant_id = $1`,
        [variantId],
      );
      expect(res.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('キャッシュを直接書き換えるとズレとして検出される', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);
      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 4, 'restock')`,
        [variantId],
      );
      await client.query(
        `UPDATE public.item_variants SET stock_quantity = 9 WHERE id = $1`,
        [variantId],
      );

      const res = await client.query(
        `SELECT * FROM public.verify_stock_integrity() WHERE variant_id = $1`,
        [variantId],
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].cached).toBe(9);
      expect(res.rows[0].ledger).toBe(4);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/stock_movements.integration.test.ts`

Expected: 追加した2件が FAIL。`function public.verify_stock_integrity() does not exist`

- [ ] **Step 3: マイグレーションを書く**

`supabase/migrations/20260906090200_add_verify_stock_integrity.sql`:

```sql
-- 台帳の合計とキャッシュ（item_variants.stock_quantity）の突き合わせ。
-- 食い違うバリアントだけを返す。整合していれば 0 行。

BEGIN;

CREATE OR REPLACE FUNCTION public.verify_stock_integrity()
RETURNS TABLE (variant_id bigint, cached integer, ledger integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT v.id,
         v.stock_quantity,
         coalesce(sum(m.delta)::integer, 0)
  FROM public.item_variants v
  LEFT JOIN public.stock_movements m ON m.variant_id = v.id
  GROUP BY v.id, v.stock_quantity
  HAVING v.stock_quantity <> coalesce(sum(m.delta)::integer, 0);
$$;

REVOKE ALL ON FUNCTION public.verify_stock_integrity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_stock_integrity() TO service_role;

COMMIT;
```

- [ ] **Step 4: 適用してテストが通ることを確認する**

Run:
```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/stock_movements.integration.test.ts
```
Expected: 8 tests PASS

- [ ] **Step 5: コミット**

```bash
git add supabase/migrations/20260906090200_add_verify_stock_integrity.sql tests/integration/db/stock_movements.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(db): 在庫台帳とキャッシュの検算関数を追加

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 既存商品データの移行

**Files:**
- Create: `supabase/migrations/20260906090300_backfill_item_variants.sql`
- Test: `tests/integration/db/backfill_variants.integration.test.ts`

**Interfaces:**
- Consumes: 既存 `public.items(colors jsonb, sizes text[], stock_quantity integer)`、Task 1 のテーブル群、Task 2 の台帳
- Produces: 移行関数 `public.backfill_item_variants(target_item_id bigint) RETURNS void` — 1商品分の色・サイズ・バリアントを生成し、在庫を台帳経由で寄せる

移行をマイグレーション本体に直書きせず関数にする理由は、テストが任意の商品に対して同じ処理を再現できるようにするため。マイグレーションはこの関数を全既存商品に対して1回呼ぶ。

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/db/backfill_variants.integration.test.ts`:

```typescript
export {};

const { Pool } = require('pg');

// 既存の items.colors / items.sizes / items.stock_quantity からバリアントを生成する。
describe('integration: backfill_item_variants', () => {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    test.skip('skipping DB integration tests because DATABASE_URL is not set', () => {});
    return;
  }

  let pool: any;
  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function createLegacyItem(
    client: any,
    colors: unknown,
    sizes: string[],
    stock: number | null,
  ): Promise<string> {
    const res = await client.query(
      `INSERT INTO public.items (name, description, price, category, image_url, status, colors, sizes, stock_quantity)
       VALUES ('backfill test', 'desc', 1000, 'TOPS', '/images/test.jpg', 'published', $1::jsonb, $2::text[], $3)
       RETURNING id`,
      [JSON.stringify(colors), sizes, stock],
    );
    return res.rows[0].id;
  }

  test('色 2 × サイズ 2 から 4 バリアントを作る', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(
        client,
        [{ name: 'Black', hex: '#000000' }, { name: 'Ivory', hex: '#f5f5f5' }],
        ['S', 'M'],
        7,
      );

      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);

      const variants = await client.query(
        `SELECT count(*)::int AS c FROM public.item_variants WHERE item_id = $1`,
        [itemId],
      );
      expect(variants.rows[0].c).toBe(4);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('色とサイズの position は元の配列の並び順になる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(
        client,
        [{ name: 'Black', hex: '#000000' }, { name: 'Ivory', hex: '#f5f5f5' }],
        ['M', 'S'],
        0,
      );

      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);

      const sizes = await client.query(
        `SELECT label, position FROM public.item_sizes WHERE item_id = $1 ORDER BY position`,
        [itemId],
      );
      expect(sizes.rows.map((r: any) => r.label)).toEqual(['M', 'S']);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('在庫は position が最小の組み合わせに全量が寄せられ、台帳にも記録される', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(
        client,
        [{ name: 'Black', hex: '#000000' }, { name: 'Ivory', hex: '#f5f5f5' }],
        ['S', 'M'],
        7,
      );

      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);

      const rows = await client.query(
        `SELECT v.stock_quantity, c.position AS cpos, s.position AS spos
         FROM public.item_variants v
         LEFT JOIN public.item_colors c ON c.id = v.color_id
         LEFT JOIN public.item_sizes  s ON s.id = v.size_id
         WHERE v.item_id = $1
         ORDER BY c.position, s.position`,
        [itemId],
      );
      expect(rows.rows[0].stock_quantity).toBe(7);
      expect(rows.rows.slice(1).every((r: any) => r.stock_quantity === 0)).toBe(true);

      const ledger = await client.query(
        `SELECT coalesce(sum(m.delta), 0)::int AS total
         FROM public.stock_movements m
         JOIN public.item_variants v ON v.id = m.variant_id
         WHERE v.item_id = $1`,
        [itemId],
      );
      expect(ledger.rows[0].total).toBe(7);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('色もサイズも無い商品は 1 バリアントになる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(client, [], [], 3);

      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);

      const res = await client.query(
        `SELECT color_id, size_id, stock_quantity FROM public.item_variants WHERE item_id = $1`,
        [itemId],
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].color_id).toBeNull();
      expect(res.rows[0].size_id).toBeNull();
      expect(res.rows[0].stock_quantity).toBe(3);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('stock_quantity が NULL の商品は在庫 0 で作られ、台帳は空になる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(client, [{ name: 'Black', hex: '#000000' }], ['M'], null);

      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);

      const res = await client.query(
        `SELECT stock_quantity FROM public.item_variants WHERE item_id = $1`,
        [itemId],
      );
      expect(res.rows[0].stock_quantity).toBe(0);

      const ledger = await client.query(
        `SELECT count(*)::int AS c
         FROM public.stock_movements m
         JOIN public.item_variants v ON v.id = m.variant_id
         WHERE v.item_id = $1`,
        [itemId],
      );
      expect(ledger.rows[0].c).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('同じ商品に二度実行しても重複しない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(client, [{ name: 'Black', hex: '#000000' }], ['M'], 2);

      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);
      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);

      const res = await client.query(
        `SELECT count(*)::int AS c FROM public.item_variants WHERE item_id = $1`,
        [itemId],
      );
      expect(res.rows[0].c).toBe(1);

      const ledger = await client.query(
        `SELECT coalesce(sum(m.delta), 0)::int AS total
         FROM public.stock_movements m
         JOIN public.item_variants v ON v.id = m.variant_id
         WHERE v.item_id = $1`,
        [itemId],
      );
      expect(ledger.rows[0].total).toBe(2);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/backfill_variants.integration.test.ts`

Expected: FAIL。`function public.backfill_item_variants(bigint) does not exist`

- [ ] **Step 3: マイグレーションを書く**

`supabase/migrations/20260906090300_backfill_item_variants.sql`:

```sql
-- 既存の items.colors / items.sizes / items.stock_quantity からバリアントを生成する。
-- 在庫は色 × サイズへ機械的に按分できないため、position が最小の組み合わせへ全量を寄せる。
-- 正しい配分は管理画面で入力し直す前提。

BEGIN;

CREATE OR REPLACE FUNCTION public.backfill_item_variants(target_item_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  legacy_stock  integer;
  head_variant  bigint;
BEGIN
  SELECT stock_quantity INTO legacy_stock FROM public.items WHERE id = target_item_id;

  -- 色。jsonb 配列の並び順を position にする。
  INSERT INTO public.item_colors (item_id, name, hex, position)
  SELECT target_item_id,
         elem->>'name',
         elem->>'hex',
         (ord - 1)::integer
  FROM public.items i,
       LATERAL jsonb_array_elements(i.colors) WITH ORDINALITY AS t(elem, ord)
  WHERE i.id = target_item_id
    AND jsonb_typeof(i.colors) = 'array'
    AND elem->>'name' IS NOT NULL
    AND elem->>'hex' ~ '^#[0-9a-fA-F]{6}$'
  ON CONFLICT (item_id, name) DO NOTHING;

  -- サイズ。text[] の並び順を position にする。
  INSERT INTO public.item_sizes (item_id, label, position)
  SELECT target_item_id, label, (ord - 1)::integer
  FROM public.items i,
       LATERAL unnest(i.sizes) WITH ORDINALITY AS t(label, ord)
  WHERE i.id = target_item_id
  ON CONFLICT (item_id, label) DO NOTHING;

  -- 色 × サイズの直積。片方が無い場合は NULL 側で 1 行になる。
  INSERT INTO public.item_variants (item_id, color_id, size_id)
  SELECT target_item_id, c.id, s.id
  FROM (SELECT id, position FROM public.item_colors WHERE item_id = target_item_id
        UNION ALL SELECT NULL::bigint, NULL::integer
        WHERE NOT EXISTS (SELECT 1 FROM public.item_colors WHERE item_id = target_item_id)) AS c(id, position)
  CROSS JOIN (SELECT id, position FROM public.item_sizes WHERE item_id = target_item_id
              UNION ALL SELECT NULL::bigint, NULL::integer
              WHERE NOT EXISTS (SELECT 1 FROM public.item_sizes WHERE item_id = target_item_id)) AS s(id, position)
  ON CONFLICT DO NOTHING;

  -- 在庫を position 最小のバリアントへ寄せる。既に台帳があるなら何もしない（再実行時の二重計上を防ぐ）。
  IF coalesce(legacy_stock, 0) > 0 THEN
    SELECT v.id INTO head_variant
    FROM public.item_variants v
    LEFT JOIN public.item_colors c ON c.id = v.color_id
    LEFT JOIN public.item_sizes  s ON s.id = v.size_id
    WHERE v.item_id = target_item_id
    ORDER BY coalesce(c.position, -1), coalesce(s.position, -1), v.id
    LIMIT 1;

    IF head_variant IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.stock_movements WHERE variant_id = head_variant) THEN
      INSERT INTO public.stock_movements (variant_id, delta, reason, note)
      VALUES (head_variant, legacy_stock, 'adjustment', 'items.stock_quantity からの移行');
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_item_variants(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_item_variants(bigint) TO service_role;

-- 既存の全商品に対して 1 回実行する。
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM public.items LOOP
    PERFORM public.backfill_item_variants(r.id);
  END LOOP;
END;
$$;

COMMIT;
```

- [ ] **Step 4: 適用してテストが通ることを確認する**

Run:
```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/backfill_variants.integration.test.ts
```
Expected: 6 tests PASS

- [ ] **Step 5: 移行後の整合を確認する**

Run:
```bash
docker exec -i supabase_db_o_official psql -U postgres -d postgres -c "SELECT count(*) FROM public.verify_stock_integrity();"
```
Expected: `count` が `0`

- [ ] **Step 6: コミット**

```bash
git add supabase/migrations/20260906090300_backfill_item_variants.sql tests/integration/db/backfill_variants.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(db): 既存商品から色・サイズ・バリアントを生成する移行を追加

在庫は按分できないため position 最小の組み合わせへ寄せ、台帳にも
記録する。正しい配分は管理画面で入力し直す。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: order_items のバリアント対応

**Files:**
- Create: `supabase/migrations/20260906090400_add_order_items_variant_columns.sql`
- Test: `tests/integration/db/order_items_variant.integration.test.ts`

**Interfaces:**
- Consumes: `public.item_variants`（Task 1）、既存 `public.order_items(item_id integer, color text, size text)`
- Produces: `order_items.variant_id bigint NULL`、`order_items.fulfillment_type text NOT NULL DEFAULT 'stock'`、`order_items.item_id` が `bigint`

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/db/order_items_variant.integration.test.ts`:

```typescript
export {};

const { Pool } = require('pg');

// order_items に受注の区分とバリアント参照を持たせる。
describe('integration: order_items variant columns', () => {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    test.skip('skipping DB integration tests because DATABASE_URL is not set', () => {});
    return;
  }

  let pool: any;
  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function createOrder(client: any): Promise<string> {
    const res = await client.query(
      `INSERT INTO public.orders (session_id, payment_intent_id, subtotal_amount, total_amount)
       VALUES ($1, $2, 1000, 1500)
       RETURNING id`,
      [`sess-${Date.now()}`, `pi_${Date.now()}`],
    );
    return res.rows[0].id;
  }

  async function createVariant(client: any): Promise<{ itemId: string; variantId: string }> {
    const item = await client.query(
      `INSERT INTO public.items (name, description, price, category, image_url, status)
       VALUES ('order item test', 'desc', 1000, 'TOPS', '/images/test.jpg', 'published')
       RETURNING id`,
    );
    const variant = await client.query(
      `INSERT INTO public.item_variants (item_id) VALUES ($1) RETURNING id`,
      [item.rows[0].id],
    );
    return { itemId: item.rows[0].id, variantId: variant.rows[0].id };
  }

  test('fulfillment_type の既定は stock で、backorder も入れられる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orderId = await createOrder(client);
      const { itemId, variantId } = await createVariant(client);

      const inserted = await client.query(
        `INSERT INTO public.order_items
           (order_id, item_id, variant_id, item_name, item_price, quantity, line_total)
         VALUES ($1, $2, $3, 'order item test', 1000, 1, 1000)
         RETURNING fulfillment_type`,
        [orderId, itemId, variantId],
      );
      expect(inserted.rows[0].fulfillment_type).toBe('stock');

      const backorder = await client.query(
        `INSERT INTO public.order_items
           (order_id, item_id, variant_id, item_name, item_price, quantity, line_total, fulfillment_type)
         VALUES ($1, $2, $3, 'order item test', 1000, 2, 2000, 'backorder')
         RETURNING fulfillment_type`,
        [orderId, itemId, variantId],
      );
      expect(backorder.rows[0].fulfillment_type).toBe('backorder');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('fulfillment_type に想定外の値は入れられない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orderId = await createOrder(client);
      const { itemId, variantId } = await createVariant(client);

      await expect(
        client.query(
          `INSERT INTO public.order_items
             (order_id, item_id, variant_id, item_name, item_price, quantity, line_total, fulfillment_type)
           VALUES ($1, $2, $3, 'x', 1000, 1, 1000, 'preorder')`,
          [orderId, itemId, variantId],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('販売実績のあるバリアントは削除できない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orderId = await createOrder(client);
      const { itemId, variantId } = await createVariant(client);
      await client.query(
        `INSERT INTO public.order_items
           (order_id, item_id, variant_id, item_name, item_price, quantity, line_total)
         VALUES ($1, $2, $3, 'x', 1000, 1, 1000)`,
        [orderId, itemId, variantId],
      );

      await expect(
        client.query(`DELETE FROM public.item_variants WHERE id = $1`, [variantId]),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('受注の集計ビューが backorder の数量だけを合計する', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orderId = await createOrder(client);
      const { itemId, variantId } = await createVariant(client);
      await client.query(
        `INSERT INTO public.order_items
           (order_id, item_id, variant_id, item_name, item_price, quantity, line_total, fulfillment_type)
         VALUES ($1, $2, $3, 'x', 1000, 1, 1000, 'stock')`,
        [orderId, itemId, variantId],
      );
      await client.query(
        `INSERT INTO public.order_items
           (order_id, item_id, variant_id, item_name, item_price, quantity, line_total, fulfillment_type)
         VALUES ($1, $2, $3, 'x', 1000, 2, 2000, 'backorder')`,
        [orderId, itemId, variantId],
      );

      const res = await client.query(
        `SELECT backorder_quantity FROM public.variant_backorder_summary WHERE variant_id = $1`,
        [variantId],
      );
      expect(res.rows[0].backorder_quantity).toBe(2);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/order_items_variant.integration.test.ts`

Expected: FAIL。`column "variant_id" of relation "order_items" does not exist`

- [ ] **Step 3: マイグレーションを書く**

`supabase/migrations/20260906090400_add_order_items_variant_columns.sql`:

```sql
-- 注文明細にバリアント参照と受注区分を持たせる。
-- item_name / item_price / color / size のスナップショットはそのまま残す
-- （バリアントが変わっても注文履歴が壊れないため）。

BEGIN;

ALTER TABLE public.order_items
  ALTER COLUMN item_id TYPE bigint;

ALTER TABLE public.order_items
  ADD COLUMN variant_id bigint REFERENCES public.item_variants(id) ON DELETE RESTRICT,
  ADD COLUMN fulfillment_type text NOT NULL DEFAULT 'stock'
    CHECK (fulfillment_type IN ('stock','backorder'));

CREATE INDEX order_items_variant_id_idx ON public.order_items (variant_id);

-- 既存明細の variant_id を color / size の一致で後埋めする。
-- 一致しない明細は NULL のまま残す（スナップショットで履歴は読める）。
UPDATE public.order_items oi
SET variant_id = v.id
FROM public.item_variants v
LEFT JOIN public.item_colors c ON c.id = v.color_id
LEFT JOIN public.item_sizes  s ON s.id = v.size_id
WHERE oi.variant_id IS NULL
  AND v.item_id = oi.item_id
  AND coalesce(c.name, '')  = coalesce(oi.color, '')
  AND coalesce(s.label, '') = coalesce(oi.size, '');

COMMIT;
```

- [ ] **Step 4: 集計ビューを追加する**

`supabase/migrations/20260906090500_add_variant_backorder_summary.sql`:

```sql
-- 受注数の真実は注文明細。実体列を持たず、ここから集計する。

BEGIN;

CREATE VIEW public.variant_backorder_summary
WITH (security_invoker = true) AS
SELECT oi.variant_id,
       sum(oi.quantity)::integer AS backorder_quantity
FROM public.order_items oi
WHERE oi.fulfillment_type = 'backorder'
  AND oi.variant_id IS NOT NULL
GROUP BY oi.variant_id;

REVOKE ALL ON public.variant_backorder_summary FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.variant_backorder_summary TO service_role;

COMMIT;
```

- [ ] **Step 5: 適用してテストが通ることを確認する**

Run:
```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/order_items_variant.integration.test.ts
```
Expected: 4 tests PASS

- [ ] **Step 6: コミット**

```bash
git add supabase/migrations/20260906090400_add_order_items_variant_columns.sql supabase/migrations/20260906090500_add_variant_backorder_summary.sql tests/integration/db/order_items_variant.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(db): 注文明細にバリアント参照と受注区分を追加

受注数の真実は注文明細に置き、集計ビューから読む。販売実績のある
バリアントは RESTRICT により物理削除できない。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 全体の回帰確認

**Files:**
- Modify: なし（確認のみ）

**Interfaces:**
- Consumes: Task 1〜5 の全マイグレーション
- Produces: なし

- [ ] **Step 1: マイグレーションを最初から再適用する**

Run: `npx supabase db reset`
Expected: エラーなく完了する

- [ ] **Step 2: DB テストを全件実行する**

Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/`
Expected: 全て PASS

- [ ] **Step 3: 既存のユニットテストと型検査が壊れていないことを確認する**

Run: `npm run typecheck && npx jest tests/unit`
Expected: 型エラー 0、ユニットテスト全て PASS（本計画はアプリケーションコードを変更していないため）

- [ ] **Step 4: 在庫の整合を確認する**

Run:
```bash
docker exec -i supabase_db_o_official psql -U postgres -d postgres -c "SELECT count(*) FROM public.verify_stock_integrity();"
```
Expected: `count` が `0`

---

## 本計画の完了条件

| 条件 | 確認方法 |
|---|---|
| バリアントのテーブル群が存在し、一意性と公開範囲が正しい | `tests/integration/db/item_variants.integration.test.ts` が PASS |
| 在庫が台帳経由でのみ動き、負にならず、台帳が追記専用である | `tests/integration/db/stock_movements.integration.test.ts` が PASS |
| 既存商品がバリアントへ移行され、台帳と在庫が整合している | `verify_stock_integrity()` が 0 行 |
| 注文明細がバリアントと受注区分を持つ | `tests/integration/db/order_items_variant.integration.test.ts` が PASS |
| アプリケーションが壊れていない | `npm run typecheck` と `npx jest tests/unit` が PASS |

## 次の計画

| 計画 | 内容 |
|---|---|
| 2 | 引当 RPC、checkout complete の置き換え、`/api/items/[id]` のバリアント対応、ITEM 詳細とカートの在庫・お届け目安表示 |
| 3 | カート所有権（`carts` / `cart_items` / マージ RPC / カート専用 Cookie） |
| 4 | ウィッシュリストのログイン必須化と共通のセキュリティ修正 |
| 5 | 管理画面のバリアント在庫編集と、旧列（`items.colors` / `items.sizes` / `items.stock_quantity`、`carts.session_id` ほか）の削除 |
