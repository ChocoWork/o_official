/** @jest-environment node */
import { createHash } from 'crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, uniqueSuffix } from './helpers/order-fixtures';

const hashOf = (label: string) => createHash('sha256').update(label).digest('hex');

async function createMember(db: PgClient, label: string): Promise<string> {
  const result = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [`cart-carryover-${label}-${uniqueSuffix()}@example.com`],
  );
  return result.rows[0].id as string;
}

async function createGuestCart(db: PgClient): Promise<{ cartId: string; tokenHash: string }> {
  const tokenHash = hashOf(`guest-cart-${uniqueSuffix()}`);
  const result = await db.query('insert into public.carts (guest_token_hash) values ($1) returning id', [tokenHash]);
  return { cartId: result.rows[0].id as string, tokenHash };
}

async function createMemberCart(db: PgClient, userId: string): Promise<string> {
  const result = await db.query('insert into public.carts (user_id) values ($1) returning id', [userId]);
  return result.rows[0].id as string;
}

async function insertLine(db: PgClient, cartId: string, variantId: number, quantity: number, addedAt?: string): Promise<string> {
  const result = await db.query(
    `insert into public.cart_lines (cart_id, variant_id, quantity, added_at)
     values ($1, $2, $3, coalesce($4::timestamptz, now())) returning id`,
    [cartId, variantId, quantity, addedAt ?? null],
  );
  return result.rows[0].id as string;
}

/** 1つの商品にサイズ違いのバリアントを count 個作る（50種類の上限の確かめに使う） */
async function createVariants(db: PgClient, count: number): Promise<number[]> {
  const item = await db.query(
    `insert into public.items (name, description, price, category, image_url, status)
     values ('fx-many-' || $1::text, '上限テスト', 1000, 'TOPS', 'https://example.com/item.png', 'published')
     returning id`,
    [uniqueSuffix()],
  );
  const itemId = Number(item.rows[0].id);
  await db.query(
    `insert into public.item_sizes (item_id, label, position)
     select $1, 'S' || g, g from generate_series(1, $2) as g`,
    [itemId, count],
  );
  const variants = await db.query(
    `insert into public.item_variants (item_id, color_id, size_id, is_active)
     select $1, null, s.id, true from public.item_sizes as s where s.item_id = $1 order by s.position
     returning id`,
    [itemId],
  );
  return variants.rows.map((row) => Number(row.id));
}

function addLines(db: PgClient, cartId: string, lines: Array<{ variant_id: unknown; quantity: unknown }> | unknown) {
  return db.query('select * from public.cart_add_lines($1, $2::jsonb)', [cartId, JSON.stringify(lines)]);
}

async function quantityOf(db: PgClient, cartId: string, variantId: number): Promise<number | null> {
  const result = await db.query('select quantity from public.cart_lines where cart_id = $1 and variant_id = $2', [cartId, variantId]);
  return result.rows[0]?.quantity ?? null;
}

async function expectDenied(db: PgClient, role: 'anon' | 'authenticated', sql: string, params: unknown[] = []) {
  await db.query('begin');
  try {
    await db.query(`set local role ${role}`);
    await expect(db.query(sql, params)).rejects.toMatchObject({ code: '42501' });
  } finally {
    await db.query('rollback');
  }
}

function merge(db: PgClient, userId: string | null, cartTokenHash: string | null, wishlistTokenHash: string | null) {
  return db.query('select * from public.merge_guest_into_member($1, $2, $3)', [userId, cartTokenHash, wishlistTokenHash]);
}

describeLocalDb('integration: カートとお気に入りの持ち主と明細', (db) => {
  describe('表の決まり', () => {
    test('持ち主は会員か印のハッシュのどちらか1つだけ', async () => {
      const member = await createMember(db(), 'owner');
      await expect(
        db().query('insert into public.carts (user_id, guest_token_hash) values ($1, $2)', [member, hashOf('both')]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(db().query('insert into public.carts default values')).rejects.toMatchObject({ code: '23514' });
      await expect(
        db().query('insert into public.wishlists (user_id, guest_token_hash) values ($1, $2)', [member, hashOf('both-w')]),
      ).rejects.toMatchObject({ code: '23514' });
    });

    test('印のハッシュは64桁の16進だけ', async () => {
      await expect(
        db().query("insert into public.carts (guest_token_hash) values ('not-a-hash')"),
      ).rejects.toMatchObject({ code: '23514' });
    });

    test('数量は1〜20で、同じカートに同じバリアントは1行だけ', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const { cartId } = await createGuestCart(db());
      await expect(insertLine(db(), cartId, fx.variantId, 0)).rejects.toMatchObject({ code: '23514' });
      await expect(insertLine(db(), cartId, fx.variantId, 21)).rejects.toMatchObject({ code: '23514' });
      await insertLine(db(), cartId, fx.variantId, 1);
      await expect(insertLine(db(), cartId, fx.variantId, 1)).rejects.toMatchObject({ code: '23505' });
    });

    test('明細が変わると持ち主の最後に使った日時が進む', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const { cartId } = await createGuestCart(db());
      await db().query("update public.carts set updated_at = now() - interval '40 days' where id = $1", [cartId]);
      await insertLine(db(), cartId, fx.variantId, 1);
      const touched = await db().query("select updated_at > now() - interval '1 minute' as recent from public.carts where id = $1", [cartId]);
      expect(touched.rows[0].recent).toBe(true);
    });

    test.each(['carts', 'cart_lines', 'wishlists', 'wishlist_lines'])('%s は anon と authenticated から読めず書けない', async (table) => {
      for (const role of ['anon', 'authenticated'] as const) {
        await expectDenied(db(), role, `select 1 from public.${table} limit 1`);
        await expectDenied(db(), role, `delete from public.${table}`);
      }
    });

    test('古い表と古い関数9本は残っていない', async () => {
      const functions = await db().query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any($1::text[])`,
        [[
          'add_guest_cart_item', 'update_guest_cart_item_quantity', 'delete_guest_cart_item', 'list_guest_cart',
          'add_guest_wishlist_item', 'delete_guest_wishlist_item', 'list_guest_wishlist',
          'update_cart_item_quantity_secure', 'delete_cart_item_secure',
        ]],
      );
      expect(functions.rows).toEqual([]);
      const columns = await db().query(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'carts' order by column_name`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual(['created_at', 'guest_token_hash', 'id', 'updated_at', 'user_id']);
      const oldWishlist = await db().query("select to_regclass('public.wishlist') as old");
      expect(oldWishlist.rows[0].old).toBeNull();
    });

    test('3つの関数は service_role だけが実行できる', async () => {
      for (const signature of [
        'public.cart_add_lines(uuid,jsonb)',
        'public.cart_change_line(uuid,uuid,integer)',
        'public.merge_guest_into_member(uuid,text,text)',
      ]) {
        const result = await db().query(
          `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
                  has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
                  has_function_privilege('service_role', $1, 'EXECUTE') as service`,
          [signature],
        );
        expect(result.rows[0]).toEqual({ anon: false, authenticated: false, service: true });
      }
    });
  });

  describe('cart_add_lines', () => {
    test('新しいバリアントは明細を作り、同じバリアントは数量を足す', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const { cartId } = await createGuestCart(db());
      const first = await addLines(db(), cartId, [{ variant_id: fx.variantId, quantity: 2 }]);
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0]).toMatchObject({ cart_id: cartId, variant_id: String(fx.variantId), quantity: 2 });
      await addLines(db(), cartId, [{ variant_id: fx.variantId, quantity: 3 }]);
      expect(await quantityOf(db(), cartId, fx.variantId)).toBe(5);
    });

    test('20を超える時は断り、数量を変えない', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const { cartId } = await createGuestCart(db());
      await addLines(db(), cartId, [{ variant_id: fx.variantId, quantity: 19 }]);
      await expect(addLines(db(), cartId, [{ variant_id: fx.variantId, quantity: 2 }])).rejects.toMatchObject({ message: 'CART_LINE_QUANTITY_LIMIT' });
      expect(await quantityOf(db(), cartId, fx.variantId)).toBe(19);
    });

    test('51種類目は断る', async () => {
      const variants = await createVariants(db(), 51);
      const { cartId } = await createGuestCart(db());
      for (const variantId of variants.slice(0, 50)) {
        await insertLine(db(), cartId, variantId, 1);
      }
      await expect(addLines(db(), cartId, [{ variant_id: variants[50], quantity: 1 }])).rejects.toMatchObject({ message: 'CART_LINE_LIMIT' });
      // 既にある種類は50種類でも足せる
      await addLines(db(), cartId, [{ variant_id: variants[0], quantity: 1 }]);
      expect(await quantityOf(db(), cartId, variants[0])).toBe(2);
    });

    test('取り扱い終了・非公開・無いバリアントは断る', async () => {
      const inactive = await createCatalogFixture(db(), { stock: 0, isActive: false });
      const hidden = await createCatalogFixture(db(), { stock: 0, itemStatus: 'private' });
      const { cartId } = await createGuestCart(db());
      for (const variantId of [inactive.variantId, hidden.variantId, 999999999]) {
        await expect(addLines(db(), cartId, [{ variant_id: variantId, quantity: 1 }])).rejects.toMatchObject({ message: 'CART_VARIANT_UNAVAILABLE' });
      }
    });

    test('1件でも断れば何も入れない', async () => {
      const ok = await createCatalogFixture(db(), { stock: 0 });
      const ng = await createCatalogFixture(db(), { stock: 0, isActive: false });
      const { cartId } = await createGuestCart(db());
      await expect(
        addLines(db(), cartId, [{ variant_id: ok.variantId, quantity: 1 }, { variant_id: ng.variantId, quantity: 1 }]),
      ).rejects.toMatchObject({ message: 'CART_VARIANT_UNAVAILABLE' });
      expect(await quantityOf(db(), cartId, ok.variantId)).toBeNull();
    });

    test('形の違う入力は CART_INVALID_INPUT', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const { cartId } = await createGuestCart(db());
      const invalid: unknown[] = [
        [],
        Array.from({ length: 11 }, () => ({ variant_id: fx.variantId, quantity: 1 })),
        [{ variant_id: fx.variantId, quantity: 0 }],
        [{ variant_id: String(fx.variantId), quantity: 1 }],
        [{ variant_id: fx.variantId }],
        [7],
        { variant_id: fx.variantId, quantity: 1 },
      ];
      for (const lines of invalid) {
        await expect(addLines(db(), cartId, lines)).rejects.toMatchObject({ message: 'CART_INVALID_INPUT' });
      }
    });

    test('同時に同じバリアントを足すと、後の方が上限で断られる', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const { cartId } = await createGuestCart(db());
      const other = await connectLocalDb();
      try {
        await db().query('begin');
        await addLines(db(), cartId, [{ variant_id: fx.variantId, quantity: 15 }]);
        const second = addLines(other, cartId, [{ variant_id: fx.variantId, quantity: 15 }]);
        await db().query('commit');
        await expect(second).rejects.toMatchObject({ message: 'CART_LINE_QUANTITY_LIMIT' });
      } finally {
        await other.end();
      }
      expect(await quantityOf(db(), cartId, fx.variantId)).toBe(15);
    });
  });

  describe('cart_change_line', () => {
    test('数量を変え、0 で消し、他のカートの明細は見つからない', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const mine = await createGuestCart(db());
      const theirs = await createGuestCart(db());
      const lineId = await insertLine(db(), mine.cartId, fx.variantId, 1);
      await db().query('select public.cart_change_line($1, $2, 5)', [mine.cartId, lineId]);
      expect(await quantityOf(db(), mine.cartId, fx.variantId)).toBe(5);
      await expect(db().query('select public.cart_change_line($1, $2, 1)', [theirs.cartId, lineId])).rejects.toMatchObject({ message: 'CART_LINE_NOT_FOUND' });
      await expect(db().query('select public.cart_change_line($1, $2, 21)', [mine.cartId, lineId])).rejects.toMatchObject({ message: 'CART_LINE_QUANTITY_LIMIT' });
      await db().query('select public.cart_change_line($1, $2, 0)', [mine.cartId, lineId]);
      expect(await quantityOf(db(), mine.cartId, fx.variantId)).toBeNull();
    });
  });

  describe('merge_guest_into_member', () => {
    test('ゲストの分が無ければ何もしない', async () => {
      const member = await createMember(db(), 'none');
      const result = await merge(db(), member, hashOf(`missing-${uniqueSuffix()}`), null);
      expect(result.rows[0]).toEqual({ cart_lines_moved: 0, cart_lines_dropped: 0, wishlist_lines_moved: 0 });
    });

    test('会員にカートが無ければ、ゲストのカートをそのまま会員のものにする', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const member = await createMember(db(), 'convert');
      const guest = await createGuestCart(db());
      await insertLine(db(), guest.cartId, fx.variantId, 2);
      const result = await merge(db(), member, guest.tokenHash, null);
      expect(result.rows[0]).toEqual({ cart_lines_moved: 1, cart_lines_dropped: 0, wishlist_lines_moved: 0 });
      const cart = await db().query('select id, user_id, guest_token_hash from public.carts where id = $1', [guest.cartId]);
      expect(cart.rows[0]).toEqual({ id: guest.cartId, user_id: member, guest_token_hash: null });
      expect(await quantityOf(db(), guest.cartId, fx.variantId)).toBe(2);
    });

    test('両方あれば、同じバリアントは大きい方の数量、違うバリアントは移し、ゲストのカートを消す', async () => {
      const shared = await createCatalogFixture(db(), { stock: 0 });
      const memberHigher = await createCatalogFixture(db(), { stock: 0 });
      const guestOnly = await createCatalogFixture(db(), { stock: 0 });
      const member = await createMember(db(), 'combine');
      const memberCart = await createMemberCart(db(), member);
      const guest = await createGuestCart(db());
      await insertLine(db(), memberCart, shared.variantId, 1);
      await insertLine(db(), guest.cartId, shared.variantId, 3);
      await insertLine(db(), memberCart, memberHigher.variantId, 4);
      await insertLine(db(), guest.cartId, memberHigher.variantId, 1);
      await insertLine(db(), guest.cartId, guestOnly.variantId, 2);

      const result = await merge(db(), member, guest.tokenHash, null);

      expect(result.rows[0]).toEqual({ cart_lines_moved: 3, cart_lines_dropped: 0, wishlist_lines_moved: 0 });
      expect(await quantityOf(db(), memberCart, shared.variantId)).toBe(3);
      expect(await quantityOf(db(), memberCart, memberHigher.variantId)).toBe(4);
      expect(await quantityOf(db(), memberCart, guestOnly.variantId)).toBe(2);
      const gone = await db().query('select 1 from public.carts where id = $1', [guest.cartId]);
      expect(gone.rowCount).toBe(0);
    });

    test('50種類を超える分は、会員の明細を先に残し、ゲストの明細を入れた順に移す', async () => {
      const variants = await createVariants(db(), 52);
      const member = await createMember(db(), 'overflow');
      const memberCart = await createMemberCart(db(), member);
      for (const variantId of variants.slice(0, 49)) {
        await insertLine(db(), memberCart, variantId, 1);
      }
      const guest = await createGuestCart(db());
      await insertLine(db(), guest.cartId, variants[51], 1, '2026-10-01T00:00:03Z');
      await insertLine(db(), guest.cartId, variants[49], 1, '2026-10-01T00:00:01Z');
      await insertLine(db(), guest.cartId, variants[50], 1, '2026-10-01T00:00:02Z');

      const result = await merge(db(), member, guest.tokenHash, null);

      expect(result.rows[0]).toEqual({ cart_lines_moved: 1, cart_lines_dropped: 2, wishlist_lines_moved: 0 });
      expect(await quantityOf(db(), memberCart, variants[49])).toBe(1);
      expect(await quantityOf(db(), memberCart, variants[50])).toBeNull();
      expect(await quantityOf(db(), memberCart, variants[51])).toBeNull();
    });

    test('お気に入りは同じ商品を1つにして合わせ、ゲストのお気に入りを消す', async () => {
      const both = await createCatalogFixture(db(), { stock: 0 });
      const guestOnly = await createCatalogFixture(db(), { stock: 0 });
      const member = await createMember(db(), 'wishlist');
      const memberList = await db().query('insert into public.wishlists (user_id) values ($1) returning id', [member]);
      const guestHash = hashOf(`guest-wishlist-${uniqueSuffix()}`);
      const guestList = await db().query('insert into public.wishlists (guest_token_hash) values ($1) returning id', [guestHash]);
      await db().query('insert into public.wishlist_lines (wishlist_id, item_id) values ($1, $2)', [memberList.rows[0].id, both.itemId]);
      await db().query('insert into public.wishlist_lines (wishlist_id, item_id) values ($1, $2), ($1, $3)', [guestList.rows[0].id, both.itemId, guestOnly.itemId]);

      const result = await merge(db(), member, null, guestHash);

      expect(result.rows[0]).toEqual({ cart_lines_moved: 0, cart_lines_dropped: 0, wishlist_lines_moved: 1 });
      const items = await db().query('select item_id from public.wishlist_lines where wishlist_id = $1 order by item_id', [memberList.rows[0].id]);
      expect(items.rows.map((row) => Number(row.item_id))).toEqual([both.itemId, guestOnly.itemId].sort((a, b) => a - b));
      const gone = await db().query('select 1 from public.wishlists where id = $1', [guestList.rows[0].id]);
      expect(gone.rowCount).toBe(0);
    });

    test('会員にお気に入りが無ければ、ゲストのお気に入りをそのまま会員のものにする', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const member = await createMember(db(), 'wishlist-convert');
      const guestHash = hashOf(`guest-wishlist-${uniqueSuffix()}`);
      const guestList = await db().query('insert into public.wishlists (guest_token_hash) values ($1) returning id', [guestHash]);
      await db().query('insert into public.wishlist_lines (wishlist_id, item_id) values ($1, $2)', [guestList.rows[0].id, fx.itemId]);
      const result = await merge(db(), member, null, guestHash);
      expect(result.rows[0]).toEqual({ cart_lines_moved: 0, cart_lines_dropped: 0, wishlist_lines_moved: 1 });
      const owner = await db().query('select user_id, guest_token_hash from public.wishlists where id = $1', [guestList.rows[0].id]);
      expect(owner.rows[0]).toEqual({ user_id: member, guest_token_hash: null });
    });

    test('同じ印で2回合わせても、2回目は何もしない', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const member = await createMember(db(), 'twice');
      const guest = await createGuestCart(db());
      await insertLine(db(), guest.cartId, fx.variantId, 1);
      await merge(db(), member, guest.tokenHash, null);
      const second = await merge(db(), member, guest.tokenHash, null);
      expect(second.rows[0]).toEqual({ cart_lines_moved: 0, cart_lines_dropped: 0, wishlist_lines_moved: 0 });
    });

    test('形の違う入力は MERGE_INVALID_INPUT', async () => {
      const member = await createMember(db(), 'invalid');
      await expect(merge(db(), null, hashOf('x'), null)).rejects.toMatchObject({ message: 'MERGE_INVALID_INPUT' });
      await expect(merge(db(), member, 'short', null)).rejects.toMatchObject({ message: 'MERGE_INVALID_INPUT' });
      await expect(merge(db(), member, null, 'short')).rejects.toMatchObject({ message: 'MERGE_INVALID_INPUT' });
    });
  });

  describe('ゲストの分の期限', () => {
    test('最後に使ってから30日を過ぎたゲストの分だけを消す', async () => {
      const job = await db().query("select command, schedule from cron.job where jobname = 'guest-shopping-retention'");
      expect(job.rows).toHaveLength(1);
      expect(job.rows[0].schedule).toBe('45 3 * * *');

      const member = await createMember(db(), 'retention');
      const oldGuest = await createGuestCart(db());
      const recentGuest = await createGuestCart(db());
      const oldMember = await createMemberCart(db(), member);
      const oldGuestList = await db().query('insert into public.wishlists (guest_token_hash) values ($1) returning id', [hashOf(`old-list-${uniqueSuffix()}`)]);
      await db().query("update public.carts set updated_at = now() - interval '31 days' where id = any($1::uuid[])", [[oldGuest.cartId, oldMember]]);
      await db().query("update public.carts set updated_at = now() - interval '29 days' where id = $1", [recentGuest.cartId]);
      await db().query("update public.wishlists set updated_at = now() - interval '31 days' where id = $1", [oldGuestList.rows[0].id]);

      await db().query(job.rows[0].command);

      const carts = await db().query('select id from public.carts where id = any($1::uuid[]) order by id', [[oldGuest.cartId, recentGuest.cartId, oldMember]]);
      expect(carts.rows.map((row) => row.id).sort()).toEqual([recentGuest.cartId, oldMember].sort());
      const lists = await db().query('select 1 from public.wishlists where id = $1', [oldGuestList.rows[0].id]);
      expect(lists.rowCount).toBe(0);
    });
  });
});
