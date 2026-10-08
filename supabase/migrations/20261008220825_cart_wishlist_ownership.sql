-- カートとお気に入りの持ち主と明細（docs/superpowers/specs/2026-10-08-cart-wishlist-carryover-design.md 第3章・第5章・第6章）
-- 古い表を消して作り直すので、1回だけ当てる。「確認へ進む」「注文する」「支払いの後」の関数は
-- 別の移行（_cart_checkout_rpcs.sql）に分けた。そちらは何度当てても同じ結果になる。
BEGIN;

-- 古い関数9本は古い表を使うので、表より先に消す
DROP FUNCTION IF EXISTS public.add_guest_cart_item(text, bigint, integer, text, text);
DROP FUNCTION IF EXISTS public.update_guest_cart_item_quantity(text, uuid, integer);
DROP FUNCTION IF EXISTS public.delete_guest_cart_item(text, uuid);
DROP FUNCTION IF EXISTS public.list_guest_cart(text);
DROP FUNCTION IF EXISTS public.add_guest_wishlist_item(text, bigint);
DROP FUNCTION IF EXISTS public.delete_guest_wishlist_item(text, uuid);
DROP FUNCTION IF EXISTS public.list_guest_wishlist(text);
DROP FUNCTION IF EXISTS public.update_cart_item_quantity_secure(uuid, text, integer);
DROP FUNCTION IF EXISTS public.delete_cart_item_secure(uuid, text);

-- 1行＝1商品で session_id を鍵にした古い表。行は捨てる（本番は未公開。設計書 3-4）
DROP TABLE IF EXISTS public.carts;
DROP TABLE IF EXISTS public.wishlist;

-- カートの持ち主（Shopify の Cart）。会員かゲストの印のどちらか1つ。会員1人・印1つにつき1つ
CREATE TABLE public.carts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid UNIQUE REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  guest_token_hash text UNIQUE CHECK (guest_token_hash ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carts_single_owner CHECK (num_nonnulls(user_id, guest_token_hash) = 1)
);
COMMENT ON COLUMN public.carts.guest_token_hash IS
  'ゲストの cart Cookie の印の SHA-256（16進）。印そのものは保存しない。updated_at から30日で毎日の処理が消す。';

-- カートの明細（Shopify の CartLine）。バリアントと数量
CREATE TABLE public.cart_lines (
  id         uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id    uuid    NOT NULL REFERENCES public.carts(id) ON DELETE CASCADE,
  variant_id bigint  NOT NULL REFERENCES public.item_variants(id) ON DELETE CASCADE,
  quantity   integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  added_at   timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cart_id, variant_id)
);
CREATE INDEX cart_lines_variant_id_idx ON public.cart_lines (variant_id);

-- お気に入りの持ち主。カートと同じ形
CREATE TABLE public.wishlists (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid UNIQUE REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  guest_token_hash text UNIQUE CHECK (guest_token_hash ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wishlists_single_owner CHECK (num_nonnulls(user_id, guest_token_hash) = 1)
);

-- お気に入りの明細。色・サイズを決める前の商品単位（2026-09-06 設計書 3 章と同じ）
CREATE TABLE public.wishlist_lines (
  id          uuid   PRIMARY KEY DEFAULT gen_random_uuid(),
  wishlist_id uuid   NOT NULL REFERENCES public.wishlists(id) ON DELETE CASCADE,
  item_id     bigint NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wishlist_id, item_id)
);
CREATE INDEX wishlist_lines_item_id_idx ON public.wishlist_lines (item_id);

-- 明細が変わったら持ち主の「最後に使った日時」を進める。ゲストの分の30日はこれで数える（設計書 3-1・3-3）
CREATE OR REPLACE FUNCTION private.touch_cart_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE public.carts AS c SET updated_at = pg_catalog.now() WHERE c.id = NEW.cart_id;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE public.carts AS c SET updated_at = pg_catalog.now() WHERE c.id = OLD.cart_id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.touch_cart_owner() FROM PUBLIC;

CREATE TRIGGER cart_lines_touch_owner
  AFTER INSERT OR UPDATE OR DELETE ON public.cart_lines
  FOR EACH ROW EXECUTE FUNCTION private.touch_cart_owner();

CREATE OR REPLACE FUNCTION private.touch_wishlist_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE public.wishlists AS w SET updated_at = pg_catalog.now() WHERE w.id = NEW.wishlist_id;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE public.wishlists AS w SET updated_at = pg_catalog.now() WHERE w.id = OLD.wishlist_id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.touch_wishlist_owner() FROM PUBLIC;

CREATE TRIGGER wishlist_lines_touch_owner
  AFTER INSERT OR UPDATE OR DELETE ON public.wishlist_lines
  FOR EACH ROW EXECUTE FUNCTION private.touch_wishlist_owner();

-- ブラウザ（anon・authenticated）からは一切読めず書けない。読み書きはサーバーの API（service role）だけ（設計書 3-2）
ALTER TABLE public.carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cart_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wishlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wishlist_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny direct client access" ON public.carts
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.cart_lines
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.wishlists
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.wishlist_lines
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.carts, public.cart_lines, public.wishlists, public.wishlist_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.carts, public.cart_lines, public.wishlists, public.wishlist_lines TO service_role;

-- 下書きを作ったカート。「注文する」の「カートが変わった」と、支払いの後に消す明細の範囲に使う（設計書第7章）
ALTER TABLE public.checkout_drafts
  ADD COLUMN IF NOT EXISTS cart_id uuid REFERENCES public.carts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS checkout_drafts_cart_id_idx ON public.checkout_drafts (cart_id);

-- 明細を足す（Shopify の /cart/add.js）。同じバリアントは同じ明細の数量を足す。全部入れるか何も入れない
CREATE OR REPLACE FUNCTION public.cart_add_lines(_cart_id uuid, _lines jsonb)
RETURNS SETOF public.cart_lines
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_lines integer;
  new_variants integer;
BEGIN
  IF _cart_id IS NULL
     OR _lines IS NULL
     OR pg_catalog.jsonb_typeof(_lines) IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'CART_INVALID_INPUT' USING ERRCODE = '22023';
  END IF;

  -- OR の評価順に頼らず、配列だと確かめた後で長さと各要素を調べる。
  IF pg_catalog.jsonb_array_length(_lines) NOT BETWEEN 1 AND 10
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
       WHERE pg_catalog.jsonb_typeof(e.value) IS DISTINCT FROM 'object'
          OR pg_catalog.jsonb_typeof(e.value->'variant_id') IS DISTINCT FROM 'number'
          OR pg_catalog.jsonb_typeof(e.value->'quantity') IS DISTINCT FROM 'number'
          OR COALESCE(e.value->>'variant_id', '') !~ '^[1-9][0-9]{0,17}$'
          OR COALESCE(e.value->>'quantity', '') !~ '^[1-9][0-9]?$'
     ) THEN
    RAISE EXCEPTION 'CART_INVALID_INPUT' USING ERRCODE = '22023';
  END IF;

  -- 同じカートへの足す・変える・合わせるを順番にする（上限を正しく数えるため）
  PERFORM 1 FROM public.carts AS c WHERE c.id = _cart_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CART_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 販売中（バリアントが有効で、商品が公開中）のバリアントだけを入れる
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT (e.value->>'variant_id')::bigint AS variant_id
      FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
    ) AS i
    LEFT JOIN public.item_variants AS v ON v.id = i.variant_id
    LEFT JOIN public.items AS it ON it.id = v.item_id
    WHERE v.id IS NULL OR NOT v.is_active OR it.status IS DISTINCT FROM 'published'
  ) THEN
    RAISE EXCEPTION 'CART_VARIANT_UNAVAILABLE' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT (e.value->>'variant_id')::bigint AS variant_id,
             pg_catalog.sum((e.value->>'quantity')::integer) AS quantity
      FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
      GROUP BY 1
    ) AS i
    LEFT JOIN public.cart_lines AS l ON l.cart_id = _cart_id AND l.variant_id = i.variant_id
    WHERE COALESCE(l.quantity, 0) + i.quantity > 20
  ) THEN
    RAISE EXCEPTION 'CART_LINE_QUANTITY_LIMIT' USING ERRCODE = '23514';
  END IF;

  SELECT pg_catalog.count(*)::integer INTO current_lines
  FROM public.cart_lines AS l
  WHERE l.cart_id = _cart_id;

  SELECT pg_catalog.count(*)::integer INTO new_variants
  FROM (
    SELECT DISTINCT (e.value->>'variant_id')::bigint AS variant_id
    FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
  ) AS i
  WHERE NOT EXISTS (
    SELECT 1 FROM public.cart_lines AS l WHERE l.cart_id = _cart_id AND l.variant_id = i.variant_id
  );

  IF current_lines + new_variants > 50 THEN
    RAISE EXCEPTION 'CART_LINE_LIMIT' USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  WITH requested AS (
    SELECT (e.value->>'variant_id')::bigint AS variant_id,
           pg_catalog.sum((e.value->>'quantity')::integer)::integer AS quantity
    FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
    GROUP BY 1
  ),
  saved AS (
    INSERT INTO public.cart_lines AS l (cart_id, variant_id, quantity)
    SELECT _cart_id, r.variant_id, r.quantity
    FROM requested AS r
    ON CONFLICT (cart_id, variant_id) DO UPDATE
      SET quantity = l.quantity + EXCLUDED.quantity,
          updated_at = pg_catalog.now()
    RETURNING l.*
  )
  SELECT * FROM saved;
END;
$$;

-- 明細の数量を変える（Shopify の /cart/change.js）。0 で消す。他のカートの明細は見つからない扱い
CREATE OR REPLACE FUNCTION public.cart_change_line(_cart_id uuid, _line_id uuid, _quantity integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _cart_id IS NULL OR _line_id IS NULL OR _quantity IS NULL OR _quantity < 0 THEN
    RAISE EXCEPTION 'CART_INVALID_INPUT' USING ERRCODE = '22023';
  END IF;
  IF _quantity > 20 THEN
    RAISE EXCEPTION 'CART_LINE_QUANTITY_LIMIT' USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.carts AS c WHERE c.id = _cart_id FOR UPDATE;

  IF _quantity = 0 THEN
    DELETE FROM public.cart_lines AS l WHERE l.id = _line_id AND l.cart_id = _cart_id;
  ELSE
    UPDATE public.cart_lines AS l
    SET quantity = _quantity, updated_at = pg_catalog.now()
    WHERE l.id = _line_id AND l.cart_id = _cart_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CART_LINE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

-- ログインでゲストの分を会員の分へ合わせる（設計書 5-2）。カートとお気に入りを1つの取引で処理する
CREATE OR REPLACE FUNCTION public.merge_guest_into_member(
  _user_id uuid,
  _cart_token_hash text,
  _wishlist_token_hash text
)
RETURNS TABLE (cart_lines_moved integer, cart_lines_dropped integer, wishlist_lines_moved integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  guest_cart_id uuid;
  member_cart_id uuid;
  guest_list_id uuid;
  member_list_id uuid;
  member_line_count integer;
  moved integer := 0;
  dropped integer := 0;
  list_moved integer := 0;
  guest_line record;
BEGIN
  IF _user_id IS NULL
     OR (_cart_token_hash IS NOT NULL AND _cart_token_hash !~ '^[0-9a-f]{64}$')
     OR (_wishlist_token_hash IS NOT NULL AND _wishlist_token_hash !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'MERGE_INVALID_INPUT' USING ERRCODE = '22023';
  END IF;

  IF _cart_token_hash IS NOT NULL THEN
    -- 2つの持ち主の行を番号の小さい順にロックする（足す・変える関数と同じ行をロックし、行き詰まりを防ぐ）
    PERFORM 1
    FROM public.carts AS c
    WHERE c.guest_token_hash = _cart_token_hash OR c.user_id = _user_id
    ORDER BY c.id
    FOR UPDATE;

    SELECT c.id INTO guest_cart_id FROM public.carts AS c WHERE c.guest_token_hash = _cart_token_hash;
    IF guest_cart_id IS NOT NULL THEN
      SELECT c.id INTO member_cart_id FROM public.carts AS c WHERE c.user_id = _user_id;
      IF member_cart_id IS NULL THEN
        -- 会員に有効なカートが無ければ、ゲストのカートがそのまま会員のカートになる（commercetools と同じ）
        UPDATE public.carts AS c
        SET user_id = _user_id, guest_token_hash = NULL, updated_at = pg_catalog.now()
        WHERE c.id = guest_cart_id;
        SELECT pg_catalog.count(*)::integer INTO moved FROM public.cart_lines AS l WHERE l.cart_id = guest_cart_id;
      ELSE
        -- 同じバリアントは大きい方の数量（commercetools の既定。2台で同じ物を入れても倍にしない）
        WITH combined AS (
          UPDATE public.cart_lines AS m
          SET quantity = GREATEST(m.quantity, g.quantity), updated_at = pg_catalog.now()
          FROM public.cart_lines AS g
          WHERE m.cart_id = member_cart_id
            AND g.cart_id = guest_cart_id
            AND g.variant_id = m.variant_id
          RETURNING m.id
        )
        SELECT pg_catalog.count(*)::integer INTO moved FROM combined;

        SELECT pg_catalog.count(*)::integer INTO member_line_count
        FROM public.cart_lines AS l
        WHERE l.cart_id = member_cart_id;

        FOR guest_line IN
          SELECT g.id
          FROM public.cart_lines AS g
          WHERE g.cart_id = guest_cart_id
            AND NOT EXISTS (
              SELECT 1 FROM public.cart_lines AS m
              WHERE m.cart_id = member_cart_id AND m.variant_id = g.variant_id
            )
          ORDER BY g.added_at, g.id
        LOOP
          IF member_line_count < 50 THEN
            UPDATE public.cart_lines AS l
            SET cart_id = member_cart_id, updated_at = pg_catalog.now()
            WHERE l.id = guest_line.id;
            member_line_count := member_line_count + 1;
            moved := moved + 1;
          ELSE
            dropped := dropped + 1;
          END IF;
        END LOOP;

        -- 移さなかった明細（同じバリアント・上限を超えた分）はゲストのカートと一緒に消える
        -- ゲストで注文まで進んだ後に Webhook・見回りが仕上げても、clear_cart_for_order が
        -- 下書きの cart_id で会員へ移した購入済み明細を消せるようにする（二重購入を防ぐため）。
        UPDATE public.checkout_drafts SET cart_id = member_cart_id WHERE cart_id = guest_cart_id;
        DELETE FROM public.carts AS c WHERE c.id = guest_cart_id;
      END IF;
    END IF;
  END IF;

  IF _wishlist_token_hash IS NOT NULL THEN
    PERFORM 1
    FROM public.wishlists AS w
    WHERE w.guest_token_hash = _wishlist_token_hash OR w.user_id = _user_id
    ORDER BY w.id
    FOR UPDATE;

    SELECT w.id INTO guest_list_id FROM public.wishlists AS w WHERE w.guest_token_hash = _wishlist_token_hash;
    IF guest_list_id IS NOT NULL THEN
      SELECT w.id INTO member_list_id FROM public.wishlists AS w WHERE w.user_id = _user_id;
      IF member_list_id IS NULL THEN
        UPDATE public.wishlists AS w
        SET user_id = _user_id, guest_token_hash = NULL, updated_at = pg_catalog.now()
        WHERE w.id = guest_list_id;
        SELECT pg_catalog.count(*)::integer INTO list_moved FROM public.wishlist_lines AS l WHERE l.wishlist_id = guest_list_id;
      ELSE
        WITH inserted AS (
          INSERT INTO public.wishlist_lines AS l (wishlist_id, item_id, added_at)
          SELECT member_list_id, g.item_id, g.added_at
          FROM public.wishlist_lines AS g
          WHERE g.wishlist_id = guest_list_id
          ON CONFLICT (wishlist_id, item_id) DO NOTHING
          RETURNING l.id
        )
        SELECT pg_catalog.count(*)::integer INTO list_moved FROM inserted;
        DELETE FROM public.wishlists AS w WHERE w.id = guest_list_id;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT moved, dropped, list_moved;
END;
$$;

REVOKE ALL ON FUNCTION public.cart_add_lines(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cart_add_lines(uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.cart_change_line(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cart_change_line(uuid, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.merge_guest_into_member(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_guest_into_member(uuid, text, text) TO service_role;

-- ゲストの分は最後に使ってから30日で消す（設計書 3-3。Shopify も使われないカートを30日で消す）。会員の分は退会まで残す
-- 同名ジョブは置き換えられる（cron.schedule はジョブ名で上書きする）
-- 実行時刻は UTC（日本時間 12:45）。
SELECT cron.schedule(
  'guest-shopping-retention',
  '45 3 * * *',
  $$
    delete from public.carts
    where guest_token_hash is not null
      and updated_at < now() - interval '30 days';
    delete from public.wishlists
    where guest_token_hash is not null
      and updated_at < now() - interval '30 days';
  $$
);

NOTIFY pgrst, 'reload schema';

COMMIT;
