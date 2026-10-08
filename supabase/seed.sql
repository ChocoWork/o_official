-- 手元の Supabase の見本データ（設計書 2026-10-05 グループ B の 7-4）。
-- npx supabase db reset のたびに、移行の後に入る。すべて架空の値で、お客様・管理者のアカウント、
-- 注文、個人情報は入れない。形（件数・分類・状態・つながり）は 2026-10-05 時点の本番の公開データに合わせた。
-- 画像の中身は scripts/e2e/seed-storage.ts が E2E の前に Storage へ置く（ここでは bucket と行だけ作る）。
-- 画像のパスを変えたら、scripts/e2e/seed-storage.ts の一覧も変える（tests/unit/scripts/e2e/seed-storage.test.ts が食い違いを止める）。

INSERT INTO storage.buckets (id, name, public) VALUES
  ('item-images', 'item-images', false),
  ('look-images', 'look-images', false),
  ('news-images', 'news-images', false)
ON CONFLICT (id) DO NOTHING;

-- 商品の色・サイズ・バリアントは、下で番号と SKU を決めて入れる（E2E が SKU で選ぶため）。
-- 商品を入れた時に組み合わせを自動で作るトリガー（移行 20261008130200_item_variant_sync.sql）が先に別の番号で
-- 作ると番号がぶつかるので、見本の商品とバリアントを入れる間だけ止め、入れ終わったら戻す。
ALTER TABLE public.items DISABLE TRIGGER items_sync_variants;

-- 商品: 9件（公開7・非公開2）。番号と価格と分類は本番の形に合わせる。
-- 検索のテストは一覧の先頭（いちばん新しい商品）の名前の最初の語で検索するので、商品1の名前を「Aoi」で始める。
INSERT INTO public.items (
  id, name, description, price, category, image_url, image_urls, colors, sizes,
  product_details, status, created_at, updated_at, made_to_order_lead_days
) VALUES
  (1, 'Aoi Linen Tunic', 'Aoi sample linen tunic for local E2E.', 89000, 'TOPS',
   'e2e/item-1-1.png', ARRAY['e2e/item-1-1.png', 'e2e/item-1-2.png'],
   '[{"name":"Natural","hex":"#d8d0c5"}]'::jsonb, ARRAY['FREE', 'M'],
   'Synthetic linen sample. No real material or vendor claim.', 'published',
   '2026-06-07T12:00:00Z', '2026-06-07T12:00:00Z', NULL),
  (3, 'Mizu Wide Trousers', 'Synthetic wide trousers for local E2E.', 20999, 'BOTTOMS',
   'e2e/item-3-1.png', ARRAY['e2e/item-3-1.png', 'e2e/item-3-2.png'],
   '[{"name":"Navy","hex":"#34465e"}]'::jsonb, ARRAY['1'],
   'Synthetic product details.', 'published',
   '2026-06-06T12:00:00Z', '2026-06-06T12:00:00Z', NULL),
  (4, 'Nagi Cotton Shirt', 'Synthetic cotton shirt for local E2E.', 24800, 'TOPS',
   'e2e/item-4-1.png', ARRAY['e2e/item-4-1.png', 'e2e/item-4-2.png'],
   '[{"name":"Clay","hex":"#b87961"}]'::jsonb, ARRAY['1'],
   'Synthetic product details.', 'published',
   '2026-06-05T12:00:00Z', '2026-06-05T12:00:00Z', NULL),
  (5, 'Sora Relaxed Pants', 'Synthetic relaxed pants for local E2E.', 34800, 'BOTTOMS',
   'e2e/item-5-1.png', ARRAY['e2e/item-5-1.png', 'e2e/item-5-2.png'],
   '[{"name":"Charcoal","hex":"#424242"}]'::jsonb, ARRAY['2'],
   'Synthetic product details.', 'published',
   '2026-06-04T12:00:00Z', '2026-06-04T12:00:00Z', NULL),
  (6, 'Kiri Wool Coat', 'Synthetic wool coat for local E2E.', 49800, 'OUTERWEAR',
   'e2e/item-6-1.png', ARRAY['e2e/item-6-1.png', 'e2e/item-6-2.png'],
   '[{"name":"Moss","hex":"#59634f"},{"name":"Stone","hex":"#928b7d"}]'::jsonb, ARRAY['1'],
   'Synthetic product details.', 'published',
   '2026-06-03T12:00:00Z', '2026-06-03T12:00:00Z', NULL),
  (7, 'Tsubame Brass Brooch', 'Synthetic brass-tone brooch for local E2E.', 10000, 'ACCESSORIES',
   'e2e/item-7-1.png', ARRAY['e2e/item-7-1.png', 'e2e/item-7-2.png'],
   '[{"name":"Brass","hex":"#a77c40"}]'::jsonb, ARRAY['FREE'],
   'Synthetic product details.', 'published',
   '2026-06-02T12:00:00Z', '2026-06-02T12:00:00Z', NULL),
  (8, 'Yoru Private Tee', 'Synthetic unpublished sample.', 1, 'TOPS',
   'e2e/item-8-1.png', ARRAY['e2e/item-8-1.png', 'e2e/item-8-2.png'],
   '[{"name":"Sage","hex":"#697765"}]'::jsonb, ARRAY['FREE'],
   'Synthetic private product details.', 'private',
   '2026-05-29T12:00:00Z', '2026-05-29T12:00:00Z', NULL),
  (9, 'Aoi Sample Top', 'Synthetic low-price sample for sorting and search UI.', 2, 'TOPS',
   'e2e/item-9-1.png', ARRAY['e2e/item-9-1.png', 'e2e/item-9-2.png'],
   '[{"name":"Ink","hex":"#30343b"},{"name":"Sand","hex":"#cbbba3"},{"name":"Olive","hex":"#66704d"},{"name":"Cloud","hex":"#d6d6d2"}]'::jsonb,
   ARRAY['S', 'M', 'L'],
   'Synthetic sample details.', 'published',
   '2026-06-01T12:00:00Z', '2026-06-01T12:00:00Z', NULL),
  (10, 'Kohaku Private Dress', 'Synthetic unpublished sample.', 22222, 'TOPS',
   'e2e/item-10-1.png', ARRAY['e2e/item-10-1.png', 'e2e/item-10-2.png'],
   '[{"name":"Black","hex":"#242424"}]'::jsonb, ARRAY[]::text[],
   'Synthetic private product details.', 'private',
   '2026-05-28T12:00:00Z', '2026-05-28T12:00:00Z', NULL);

-- 色13・サイズ11・バリアント21（商品1は2、商品9は4色×3サイズの12、ほかは1）。在庫は本番の形どおりすべて0
-- （バリアントは在庫0でしか作れない。在庫は台帳でしか動かさない）。
INSERT INTO public.item_colors (id, item_id, name, hex, position) VALUES
  (1, 1, 'Natural', '#d8d0c5', 0), (2, 3, 'Navy', '#34465e', 0),
  (3, 4, 'Clay', '#b87961', 0), (4, 5, 'Charcoal', '#424242', 0),
  (5, 6, 'Moss', '#59634f', 0), (6, 6, 'Stone', '#928b7d', 1),
  (7, 7, 'Brass', '#a77c40', 0), (8, 8, 'Sage', '#697765', 0),
  (9, 9, 'Ink', '#30343b', 0), (10, 9, 'Sand', '#cbbba3', 1),
  (11, 9, 'Olive', '#66704d', 2), (12, 9, 'Cloud', '#d6d6d2', 3),
  (13, 10, 'Black', '#242424', 0);

INSERT INTO public.item_sizes (id, item_id, label, position) VALUES
  (1, 1, 'FREE', 0), (2, 1, 'M', 1), (3, 3, '1', 0), (4, 4, '1', 0),
  (5, 5, '2', 0), (6, 6, '1', 0), (7, 7, 'FREE', 0), (8, 8, 'FREE', 0),
  (9, 9, 'S', 0), (10, 9, 'M', 1), (11, 9, 'L', 2);

INSERT INTO public.item_variants (id, item_id, color_id, size_id, sku, stock_quantity, is_active) VALUES
  (1, 1, 1, 1, 'E2E-ITEM-1-NAT-FREE', 0, true),
  (2, 1, 1, 2, 'E2E-ITEM-1-NAT-M', 0, true),
  (3, 3, 2, 3, 'E2E-ITEM-3-NAVY-1', 0, true),
  (4, 4, 3, 4, 'E2E-ITEM-4-CLAY-1', 0, true),
  (5, 5, 4, 5, 'E2E-ITEM-5-CHARCOAL-2', 0, true),
  (6, 6, 5, 6, 'E2E-ITEM-6-MOSS-1', 0, true),
  (7, 7, 7, 7, 'E2E-ITEM-7-BRASS-FREE', 0, true),
  (8, 8, 8, 8, 'E2E-ITEM-8-SAGE-FREE', 0, true),
  (9, 9, 9, 9, 'E2E-ITEM-9-INK-S', 0, true),
  (10, 9, 9, 10, 'E2E-ITEM-9-INK-M', 0, true),
  (11, 9, 9, 11, 'E2E-ITEM-9-INK-L', 0, true),
  (12, 9, 10, 9, 'E2E-ITEM-9-SAND-S', 0, true),
  (13, 9, 10, 10, 'E2E-ITEM-9-SAND-M', 0, true),
  (14, 9, 10, 11, 'E2E-ITEM-9-SAND-L', 0, true),
  (15, 9, 11, 9, 'E2E-ITEM-9-OLIVE-S', 0, true),
  (16, 9, 11, 10, 'E2E-ITEM-9-OLIVE-M', 0, true),
  (17, 9, 11, 11, 'E2E-ITEM-9-OLIVE-L', 0, true),
  (18, 9, 12, 9, 'E2E-ITEM-9-CLOUD-S', 0, true),
  (19, 9, 12, 10, 'E2E-ITEM-9-CLOUD-M', 0, true),
  (20, 9, 12, 11, 'E2E-ITEM-9-CLOUD-L', 0, true),
  (21, 10, 13, NULL, 'E2E-ITEM-10-BLACK-NOSIZE', 0, true);

-- 見本の商品とバリアントを入れ終えたので、組み合わせを自動で作るトリガーを戻す（以後に作る商品は自動でそろう）。
ALTER TABLE public.items ENABLE TRIGGER items_sync_variants;

-- ルック: 7件（すべて公開）と、商品とのつながり9件。ルック1に「Aoi」を入れる（検索のテスト）。
-- 画像は本番（ルックごとに1枚）と違い、わざと2枚にする。ギャラリーの複数枚の動き（FREQ-179、
-- FR-LOOK-DETAIL-011 のタブレット・パソコンの確かめ）は2枚以上でしか動かないため。本番に合わせて減らさないこと。
INSERT INTO public.looks (
  id, season_year, season_type, theme, theme_description, image_urls, status, created_at, updated_at
) VALUES
  (1, 2026, 'SS', 'Aoi Weekend Layers', 'Aoi synthetic styling with linen layers.',
   ARRAY['e2e/look-1-1.png', 'e2e/look-1-2.png'], 'published', '2026-06-07T12:00:00Z', '2026-06-07T12:00:00Z'),
  (2, 2026, 'AW', 'Soft Winter Lines', 'Synthetic winter styling.',
   ARRAY['e2e/look-2-1.png', 'e2e/look-2-2.png'], 'published', '2026-06-06T12:00:00Z', '2026-06-06T12:00:00Z'),
  (3, 2027, 'SS', 'Quiet Morning Form', 'Synthetic spring styling.',
   ARRAY['e2e/look-3-1.png', 'e2e/look-3-2.png'], 'published', '2026-06-05T12:00:00Z', '2026-06-05T12:00:00Z'),
  (4, 2027, 'AW', 'Stone and Thread', 'Synthetic autumn styling.',
   ARRAY['e2e/look-4-1.png', 'e2e/look-4-2.png'], 'published', '2026-06-04T12:00:00Z', '2026-06-04T12:00:00Z'),
  (5, 2028, 'SS', 'Light Between Leaves', 'Synthetic spring styling.',
   ARRAY['e2e/look-5-1.png', 'e2e/look-5-2.png'], 'published', '2026-06-03T12:00:00Z', '2026-06-03T12:00:00Z'),
  (6, 2028, 'AW', 'Evening Haze', 'Synthetic winter styling.',
   ARRAY['e2e/look-6-1.png', 'e2e/look-6-2.png'], 'published', '2026-06-02T12:00:00Z', '2026-06-02T12:00:00Z'),
  (7, 2028, 'AW', 'Paper Moon', 'Synthetic winter styling.',
   ARRAY['e2e/look-7-1.png', 'e2e/look-7-2.png'], 'published', '2026-06-01T12:00:00Z', '2026-06-01T12:00:00Z');

INSERT INTO public.look_items (look_id, item_id) VALUES
  (1, 1), (1, 3), (2, 1), (3, 1), (4, 1), (5, 7), (5, 10), (6, 10), (7, 8);

-- ニュース: 8件（すべて公開）。分類は COLLECTION×4・EVENT・COLLABORATION・SUSTAINABILITY・STORE、日付はすべて違う。
INSERT INTO public.news_articles (
  id, title, category, published_date, image_url, content, detailed_content, status, created_at, updated_at
) VALUES
  (1, 'Aoi Textile Studio Collection', 'COLLECTION', '2026-05-14', 'e2e/news-1.png',
   'Aoi is a synthetic collection story for local search.', 'Synthetic article body. No real event or person.',
   'published', '2026-05-14T12:00:00Z', '2026-05-14T12:00:00Z'),
  (2, 'Synthetic Collection Note', 'COLLECTION', '2026-04-22', 'e2e/news-2.png',
   'A fictional collection note.', 'Synthetic article body.',
   'published', '2026-04-22T12:00:00Z', '2026-04-22T12:00:00Z'),
  (3, 'Synthetic Event Notice', 'EVENT', '2026-03-08', 'e2e/news-3.png',
   'Fictional event text.', 'Synthetic event detail.',
   'published', '2026-03-08T12:00:00Z', '2026-03-08T12:00:00Z'),
  (4, 'Synthetic Collaboration Story', 'COLLABORATION', '2026-01-11', 'e2e/news-4.png',
   'Fictional collaboration text.', 'Synthetic collaboration detail.',
   'published', '2026-01-11T12:00:00Z', '2026-01-11T12:00:00Z'),
  (5, 'Synthetic Sustainability Note', 'SUSTAINABILITY', '2025-11-03', 'e2e/news-5.png',
   'Fictional sustainability text.', 'Synthetic sustainability detail.',
   'published', '2025-11-03T12:00:00Z', '2025-11-03T12:00:00Z'),
  (6, 'Synthetic Store Letter', 'STORE', '2025-08-20', 'e2e/news-6.png',
   'Fictional store text.', 'Synthetic store detail.',
   'published', '2025-08-20T12:00:00Z', '2025-08-20T12:00:00Z'),
  (7, 'Synthetic Collection Journal', 'COLLECTION', '2025-04-10', 'e2e/news-7.png',
   'Fictional journal text.', 'Synthetic journal detail.',
   'published', '2025-04-10T12:00:00Z', '2025-04-10T12:00:00Z'),
  (8, 'Synthetic Collection Archive', 'COLLECTION', '2025-01-15', 'e2e/news-8.png',
   'Fictional archive text.', 'Synthetic archive detail.',
   'published', '2025-01-15T12:00:00Z', '2025-01-15T12:00:00Z');

-- 取扱店: 6件（すべて公開）。種類は SELECT SHOP×3・STORE×2・FLAGSHIP STORE×1。
-- 地域のテストは住所の頭の都府県と「Aoyama」の名前を見る。電話番号は架空の 000-0000-0000。
INSERT INTO public.stockists (id, type, name, address, phone, time, holiday, status) VALUES
  (1, 'SELECT SHOP', 'Aoyama Sample Select', '東京都港区南青山0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', 'published'),
  (2, 'SELECT SHOP', 'Osaka Sample Select', '大阪府大阪市中央区0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', 'published'),
  (3, 'SELECT SHOP', 'Kyoto Sample Select', '京都府京都市中京区0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', 'published'),
  (4, 'STORE', 'Ginza Sample Store', '東京都中央区銀座0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', 'published'),
  (5, 'STORE', 'Kobe Sample Store', '兵庫県神戸市中央区0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', 'published'),
  (6, 'FLAGSHIP STORE', 'Tokyo Synthetic Flagship', '東京都渋谷区0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', 'published');

-- 番号を明示して入れたので、次に作る行の番号が重ならないよう進める（DB 結合テストが番号を決め打ちせずに作るため）。
SELECT setval(pg_get_serial_sequence('public.items', 'id'), (SELECT max(id) FROM public.items), true);
SELECT setval(pg_get_serial_sequence('public.item_colors', 'id'), (SELECT max(id) FROM public.item_colors), true);
SELECT setval(pg_get_serial_sequence('public.item_sizes', 'id'), (SELECT max(id) FROM public.item_sizes), true);
SELECT setval(pg_get_serial_sequence('public.item_variants', 'id'), (SELECT max(id) FROM public.item_variants), true);
SELECT setval(pg_get_serial_sequence('public.looks', 'id'), (SELECT max(id) FROM public.looks), true);
SELECT setval(pg_get_serial_sequence('public.news_articles', 'id'), (SELECT max(id) FROM public.news_articles), true);
SELECT setval(pg_get_serial_sequence('public.stockists', 'id'), (SELECT max(id) FROM public.stockists), true);

-- 本番の PostgREST は、要求ごとに private.set_request_context() を動かし、ゲストのセッションの番号を
-- app.session_id に入れる（お気に入り・カート・注文のゲスト向けの RLS が読む）。本番ではロールの設定で
-- 入っているが移行には無いので、手元でも同じにする（2026-10-06 に本番の設定を読んで確認）。
ALTER ROLE authenticator SET pgrst.db_pre_request TO 'private.set_request_context';
NOTIFY pgrst, 'reload config';
