-- 在庫の単位を色 × サイズ（item_variants）へ寄せる 第1段（FREQ-398）
--
-- ブランドの前提（docs/01_Planning/brand.md、法令ページ）:
-- 「原則として受注生産。在庫がある場合は3〜7営業日で発送。無い場合は一定数の注文が
--   まとまった時点で製造」。つまり在庫の有無は「買えるか」ではなく「納期」を分ける。
-- 在庫が無い組み合わせも受注生産（backorder）として受ける。
--
-- この段でやること（客に見える変化は無い）:
--   1. 注文明細に variant_id と fulfillment_type を正しく記録する
--   2. 在庫で賄える分だけ、在庫台帳（stock_movements）に 'purchase' を追記して引き当てる
--   3. 未入金の取り消しで、引き当てた分を 'cancel' として戻す
--
-- この段でやらないこと:
--   - items.stock_quantity の減算は残す（本番は全商品 NULL なので実質無効。表示側を
--     バリアントへ切り替える第3段で外す。今外すと2系統の在庫が併存する期間が延びる）
--   - 店頭表示と管理画面は触らない（第2段・第3段）
--
-- 引き当ての単位はバリアント。1つの注文で同じバリアントが複数明細に分かれることがあるため
-- 合算して判定する。在庫が必要数に満たなければ、その明細は分割せず全量を backorder にする。
-- 部分的に引き当てると、残りを待つ客に対して在庫だけ先に確保した状態になり、
-- 「まとまった時点で製造」の判断（variant_backorder_summary）も歪む。
--
-- ロックの順序は items（id 昇順）→ item_variants（id 昇順）で、注文確定と在庫戻しでそろえる。
-- 逆順で取る経路があるとデッドロックになる。
--
-- search_path は関数定義の中で pg_temp を最後に置く（20260921011535 の ALTER と同じ状態。
-- CREATE OR REPLACE は proconfig を丸ごと置き換えるため、書かないと対策が巻き戻る）。

BEGIN;

-- 明細のスナップショット（色・サイズは文字列）から、対応するバリアントを引く。
-- 後埋め（20260919065430）と同じ対応付け。一致しなければ variant_id は NULL のままにし、
-- 注文は止めない。支払いは既に済んでいるため、対応表の不足で注文を失わせない。
-- item_variants_combo_key（item_id, color_id, size_id の一意インデックス）があるので
-- 一致するバリアントは高々1件。
CREATE OR REPLACE FUNCTION public.resolve_checkout_item_variants(_items_snapshot jsonb)
  RETURNS TABLE (
    line_no        integer,
    item_id        bigint,
    item_name      text,
    item_price     integer,
    item_image_url text,
    color          text,
    size           text,
    quantity       integer,
    line_total     integer,
    variant_id     bigint
  )
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_temp
  AS $function$
  SELECT t.ordinality::integer,
         (t.s->>'item_id')::bigint,
         t.s->>'item_name',
         (t.s->>'item_price')::integer,
         t.s->>'item_image_url',
         t.s->>'color',
         t.s->>'size',
         (t.s->>'quantity')::integer,
         (t.s->>'line_total')::integer,
         matched.variant_id
  FROM jsonb_array_elements(_items_snapshot) WITH ORDINALITY AS t(s, ordinality)
  LEFT JOIN LATERAL (
    SELECT v.id AS variant_id
    FROM public.item_variants v
    LEFT JOIN public.item_colors c ON c.id = v.color_id
    LEFT JOIN public.item_sizes  z ON z.id = v.size_id
    WHERE v.item_id = (t.s->>'item_id')::bigint
      AND coalesce(c.name, '')  = coalesce(t.s->>'color', '')
      AND coalesce(z.label, '') = coalesce(t.s->>'size', '')
    LIMIT 1
  ) AS matched ON true
$function$;

REVOKE ALL ON FUNCTION public.resolve_checkout_item_variants(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_checkout_item_variants(jsonb) TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.finalize_order_from_checkout_draft (
  _draft_id              uuid,
  _payment_intent_id     text,
  _checkout_session_id   text,
  _order_status          public.order_status,
  _expected_total_amount integer,
  _currency              text
)
  RETURNS TABLE (
    order_id     uuid,
    order_status public.order_status
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $function$
DECLARE
  draft_row public.checkout_drafts%ROWTYPE;
  item_id_val integer;
  item_qty integer;
  item_stock integer;
  item_status text;
  inserted_order_id uuid;
  inserted_order_status public.order_status;
BEGIN
  IF _draft_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_CHECKOUT_DRAFT';
  END IF;

  IF _payment_intent_id IS NULL OR btrim(_payment_intent_id) = '' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_REFERENCE';
  END IF;

  -- Idempotency: return existing order if already finalized
  SELECT o.id, o.status
  INTO inserted_order_id, inserted_order_status
  FROM public.orders o
  WHERE o.payment_intent_id = _payment_intent_id
  LIMIT 1;

  IF inserted_order_id IS NOT NULL THEN
    RETURN QUERY SELECT inserted_order_id, inserted_order_status;
    RETURN;
  END IF;

  -- Lock draft row
  SELECT *
  INTO draft_row
  FROM public.checkout_drafts d
  WHERE d.id = _draft_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_CHECKOUT_DRAFT';
  END IF;

  -- Idempotency (after lock): 並行した確定処理がロック待ちの間にコミットしていれば、その注文を返す。
  -- Read Committed では、この SELECT はロックを待ち終わった時点の最新のコミット済みデータを読む。
  -- ここで返さないと、後発は先発が減らした後の在庫を見て INSUFFICIENT_STOCK で失敗し、
  -- 支払い済みの客に注文失敗を返すことになる。
  SELECT o.id, o.status
  INTO inserted_order_id, inserted_order_status
  FROM public.orders o
  WHERE o.payment_intent_id = _payment_intent_id
  LIMIT 1;

  IF inserted_order_id IS NOT NULL THEN
    RETURN QUERY SELECT inserted_order_id, inserted_order_status;
    RETURN;
  END IF;

  -- Verify total amount matches
  IF _expected_total_amount IS NOT NULL AND draft_row.total_amount <> _expected_total_amount THEN
    RAISE EXCEPTION 'CHECKOUT_TOTAL_MISMATCH:%:%', draft_row.total_amount, _expected_total_amount;
  END IF;

  IF _currency IS NOT NULL AND lower(draft_row.currency) <> lower(_currency) THEN
    RAISE EXCEPTION 'CHECKOUT_CURRENCY_MISMATCH:%:%', draft_row.currency, _currency;
  END IF;

  -- Lock items and verify stock from items_snapshot
  -- 同一商品が複数明細に分かれている場合があるため item_id で合算してから検証する。
  -- 明細単位のまま検証すると、各行が減算前の同じ stock_quantity と比較されてしまい、
  -- 合計数量が在庫を超えていても INSUFFICIENT_STOCK が発生しない（下の集約 UPDATE が
  -- 在庫をマイナスにしてしまう）。
  -- order by 1（item_id の昇順）でロックの取得順を固定する。集約の出力順のままだと
  -- 組み合わせごとに順が変わり、在庫復元や別の注文確定と逆順になってデッドロックになる。
  FOR item_id_val, item_qty IN
    SELECT (s->>'item_id')::integer AS item_id,
           SUM((s->>'quantity')::integer)::integer AS quantity
    FROM jsonb_array_elements(draft_row.items_snapshot) AS s
    GROUP BY (s->>'item_id')::integer
    ORDER BY 1
  LOOP
    SELECT i.status, i.stock_quantity
    INTO item_status, item_stock
    FROM public.items i
    WHERE i.id = item_id_val
    FOR UPDATE;

    IF NOT FOUND OR item_status IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'ITEM_NOT_PUBLISHED:%', item_id_val;
    END IF;

    IF item_stock IS NOT NULL AND item_qty > item_stock THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%', item_id_val, item_qty, item_stock;
    END IF;
  END LOOP;

  -- バリアントを id 昇順でロックする（items の次。在庫戻しと同じ順）。
  -- 引当区分は「ロックした後に読んだ在庫」で決める。先に読んで後でロックすると、
  -- その間に別の注文が引き当てて在庫が足りなくなる（OWASP ASVS V11.1.6）。
  PERFORM 1
  FROM public.item_variants v
  WHERE v.id IN (
    SELECT r.variant_id
    FROM public.resolve_checkout_item_variants(draft_row.items_snapshot) r
    WHERE r.variant_id IS NOT NULL
  )
  ORDER BY v.id
  FOR UPDATE;

  -- Insert order
  BEGIN
    INSERT INTO public.orders (
      session_id,
      checkout_session_id,
      payment_intent_id,
      status,
      subtotal_amount,
      shipping_amount,
      discount_amount,
      total_amount,
      currency,
      shipping_email,
      shipping_full_name,
      shipping_postal_code,
      shipping_prefecture,
      shipping_city,
      shipping_address,
      shipping_building,
      shipping_phone,
      shipping_kana
    ) VALUES (
      draft_row.session_id,
      _checkout_session_id,
      _payment_intent_id,
      _order_status,
      draft_row.subtotal_amount,
      draft_row.shipping_amount,
      COALESCE(draft_row.discount_amount, 0),
      draft_row.total_amount,
      draft_row.currency,
      draft_row.shipping_snapshot->>'email',
      draft_row.shipping_snapshot->>'fullName',
      draft_row.shipping_snapshot->>'postalCode',
      draft_row.shipping_snapshot->>'prefecture',
      draft_row.shipping_snapshot->>'city',
      draft_row.shipping_snapshot->>'address',
      draft_row.shipping_snapshot->>'building',
      draft_row.shipping_snapshot->>'phone',
      draft_row.shipping_snapshot->>'kanaName'
    )
    RETURNING id, status
    INTO inserted_order_id, inserted_order_status;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT o.id, o.status
      INTO inserted_order_id, inserted_order_status
      FROM public.orders o
      WHERE o.payment_intent_id = _payment_intent_id
      LIMIT 1;
      IF inserted_order_id IS NOT NULL THEN
        RETURN QUERY SELECT inserted_order_id, inserted_order_status;
        RETURN;
      END IF;
      RAISE;
  END;

  -- Insert order_items from items_snapshot, and reserve stock for the covered variants.
  -- 引当区分はバリアント単位で決める（同じバリアントが複数明細に分かれていても合算）。
  -- 在庫で賄えないもの・バリアントに対応しないもの・停止中のバリアントは backorder にし、
  -- 台帳には何も書かない（受注生産として受ける）。
  WITH resolved AS (
    SELECT * FROM public.resolve_checkout_item_variants(draft_row.items_snapshot)
  ),
  needed AS (
    SELECT r.variant_id, SUM(r.quantity)::integer AS quantity
    FROM resolved r
    WHERE r.variant_id IS NOT NULL
    GROUP BY r.variant_id
  ),
  covered AS (
    SELECT n.variant_id
    FROM needed n
    JOIN public.item_variants v ON v.id = n.variant_id
    WHERE v.is_active
      AND v.stock_quantity >= n.quantity
  ),
  inserted_items AS (
    INSERT INTO public.order_items (
      order_id,
      item_id,
      item_name,
      item_price,
      item_image_url,
      color,
      size,
      quantity,
      line_total,
      variant_id,
      fulfillment_type
    )
    SELECT inserted_order_id,
           r.item_id,
           r.item_name,
           r.item_price,
           r.item_image_url,
           r.color,
           r.size,
           r.quantity,
           r.line_total,
           r.variant_id,
           CASE
             WHEN r.variant_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM covered c WHERE c.variant_id = r.variant_id)
             THEN 'stock'
             ELSE 'backorder'
           END
    FROM resolved r
    ORDER BY r.line_no
    RETURNING id, variant_id, quantity, fulfillment_type
  )
  INSERT INTO public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
  SELECT i.variant_id, -i.quantity, 'purchase', inserted_order_id, i.id
  FROM inserted_items i
  WHERE i.fulfillment_type = 'stock'
    -- delta <> 0 の CHECK があるため 0 個の明細は台帳に書かない（支払い済みの注文を失わせない）
    AND i.quantity > 0
  ORDER BY i.variant_id, i.id;

  -- Decrement stock
  -- 同一商品が複数明細に分かれている場合があるため item_id で合算してから引く。
  -- 集約しないと UPDATE ... FROM が対象行を1度しか更新せず、引き漏らしが出る。
  -- 対象行は上の検証ループで既にロック済みなので、ここでのロック順は問題にならない。
  UPDATE public.items i
  SET stock_quantity = i.stock_quantity - agg.quantity
  FROM (
    SELECT (s->>'item_id')::integer AS item_id,
           SUM((s->>'quantity')::integer)::integer AS quantity
    FROM jsonb_array_elements(draft_row.items_snapshot) AS s
    GROUP BY (s->>'item_id')::integer
  ) agg
  WHERE i.id = agg.item_id
    AND i.stock_quantity IS NOT NULL;

  -- Remove cart items
  DELETE FROM public.carts c
  USING jsonb_array_elements(draft_row.items_snapshot) AS s
  WHERE (s->>'source_cart_id') IS NOT NULL
    AND c.id = (s->>'source_cart_id')::uuid
    AND c.session_id = draft_row.session_id;

  -- Mark draft completed
  UPDATE public.checkout_drafts
  SET status = 'completed',
      checkout_session_id = COALESCE(checkout_session_id, _checkout_session_id),
      payment_intent_id   = COALESCE(payment_intent_id, _payment_intent_id)
  WHERE id = _draft_id;

  RETURN QUERY SELECT inserted_order_id, inserted_order_status;
END;
$function$;

REVOKE ALL ON FUNCTION "public"."finalize_order_from_checkout_draft"(uuid, text, text, public.order_status, integer, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."finalize_order_from_checkout_draft"(uuid, text, text, public.order_status, integer, text) TO "postgres", "service_role";

-- 未入金の取り消しで、引き当てた分を台帳へ戻す。
-- 引当区分が 'stock' の明細だけが対象。backorder は在庫を減らしていないので戻すものが無い。
-- 検査以外（引数・戻り値・items の戻し方）は 20260919233113 と同じ。
create or replace function public.release_stock_for_unpaid_order(
  _payment_intent_id text,
  _next_status public.order_status default 'failed'
)
returns table (released boolean, order_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_order_id uuid;
begin
  -- 未入金の注文を移せる先は failed / cancelled だけ。NULL は not in では弾けないので明示する。
  if _next_status is null or _next_status not in ('failed', 'cancelled') then
    raise exception 'INVALID_NEXT_STATUS:%', _next_status
      using errcode = 'invalid_parameter_value';
  end if;

  select o.id
  into target_order_id
  from public.orders o
  where o.payment_intent_id = _payment_intent_id
    and o.status = 'pending'
  for update;

  if target_order_id is null then
    return query select false, null::uuid;
    return;
  end if;

  update public.orders
  set status = _next_status
  where id = target_order_id;

  -- 商品行は id の昇順でまとめてロックしてから戻す（注文確定と同じ順）。
  -- 下の UPDATE は結合の都合でロック順が変わるため、順序を先に固定する。
  -- 在庫数が空の商品も含めてロックし、注文確定側と同じ集合・同じ順にする。
  perform 1
  from public.items i
  where i.id in (
    select oi.item_id
    from public.order_items oi
    where oi.order_id = target_order_id
  )
  order by i.id
  for update;

  -- バリアントも id 昇順でロックする（items の次。注文確定と同じ順）。
  perform 1
  from public.item_variants v
  where v.id in (
    select oi.variant_id
    from public.order_items oi
    where oi.order_id = target_order_id
      and oi.variant_id is not null
      and oi.fulfillment_type = 'stock'
  )
  order by v.id
  for update;

  -- 引き当てた分を台帳へ戻す。追記でしか在庫を動かさない（stock_movements の設計）。
  -- この関数は pending の注文だけを対象に状態を進めるため、同じ注文で二度は走らない。
  insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
  select oi.variant_id, oi.quantity, 'cancel', target_order_id, oi.id
  from public.order_items oi
  where oi.order_id = target_order_id
    and oi.variant_id is not null
    and oi.fulfillment_type = 'stock'
    and oi.quantity > 0
  order by oi.variant_id, oi.id;

  -- 同一商品が複数明細に分かれている場合があるため、item_id で合算してから戻す
  update public.items i
  set stock_quantity = i.stock_quantity + agg.quantity
  from (
    select oi.item_id, sum(oi.quantity)::integer as quantity
    from public.order_items oi
    where oi.order_id = target_order_id
    group by oi.item_id
  ) agg
  where i.id = agg.item_id
    and i.stock_quantity is not null;

  return query select true, target_order_id;
end;
$$;

revoke all on function public.release_stock_for_unpaid_order(text, public.order_status) from public, anon, authenticated;
grant execute on function public.release_stock_for_unpaid_order(text, public.order_status) to service_role;

COMMIT;
