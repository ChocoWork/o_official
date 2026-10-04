-- 店内の注文の列（取消のメモ・理由・お知らせの有無・確認者）を、お客様の Data API から隠す。
-- グループ A 最終レビュー Important 1。設計書 5-2「メモは店内だけに残る」。
--
-- 注文の持ち主（authenticated）とゲスト（anon）は、RLS で自分の注文の行を読める。表単位の SELECT が
-- あるままだと、その行の cancel_note（管理者のメモ）や cancel_reason（suspected_fraud など）まで読めてしまう。
-- 行は RLS、列は権限で止める。
--
--   1. anon・authenticated の表単位の SELECT を剥がす。列単位の SELECT も一緒に消えるので、再実行しても同じ結果になる。
--   2. 店内の4列を除く今の全列へ、列単位の SELECT を付ける。列の一覧は適用時に pg_attribute から組むので、
--      ローカルに無く本番にだけある列も取りこぼさない。
--
-- INSERT・UPDATE・DELETE など、ほかの権限と service_role は変えない。管理画面の一覧が管理者の JWT で読む
-- review_reason・reviewed_at は、読めるままにする。この制限は public.orders の4列に適用する。
-- private.record_order_revision() は to_jsonb(OLD/NEW) を order_revisions.before_data/after_data に保存するため、
-- そのコピーには店内の4列も含まれる。order_revisions は admin.finance.read を持つ管理者の JWT が RLS 経由で読める。
-- 将来 order_revisions を顧客向けに公開するときは、これらのコピーも公開しないこと。
--
-- これからの変更で守ること: 列単位の権限は、後から足した列に及ばない。つまり orders に足した列は、何もしなければ
-- anon・authenticated から読めない（隠れる側に倒れる）。足すときは同じ変更で、次のどちらかを決める。
--   (a) お客様に見せる列: その移行で GRANT SELECT (列) ON TABLE public.orders TO anon, authenticated を足す。
--   (b) 店内だけの列: 移行では何もしない。tests/integration/db/order_internal_columns.integration.test.ts の
--       INTERNAL_COLUMNS へ足して、意図して隠していることを残す。
-- public.orders に列を足したら、公開は列単位で GRANT SELECT、非公開は INTERNAL_COLUMNS へ登録し、tests/integration/db/order_internal_columns.integration.test.ts を実行する（CI では自動実行しない）。
-- 決めないと、そのテストの「ほかの列はすべて読める」が落ちる。決めないまま出すと、その列を利用者の JWT で読む処理が
-- 42501 で落ちる。適用済みのこの移行は書き換えない。
-- 利用者の JWT で orders を select('*') や列なしの select() で読まないこと。店内の列を含むので 42501 になる。
-- anon・authenticated へ orders の表単位の GRANT SELECT / GRANT ALL を流さないこと。店内の4列まで読めてしまう
-- （そのテストの「店内の4列を読めず」が落ちる）。

BEGIN;

REVOKE SELECT ON TABLE public.orders FROM anon, authenticated;

DO $$
DECLARE
  v_internal_columns CONSTANT text[] := ARRAY[
    'cancel_note',
    'cancel_reason',
    'cancel_notify_customer',
    'reviewed_by'
  ];
  v_visible_columns text;
BEGIN
  SELECT pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ' ORDER BY a.attnum)
    INTO v_visible_columns
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'public.orders'::pg_catalog.regclass
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND a.attname::pg_catalog.text <> ALL (v_internal_columns);

  EXECUTE pg_catalog.format(
    'GRANT SELECT (%s) ON TABLE public.orders TO anon, authenticated',
    v_visible_columns
  );
END
$$;

COMMIT;
