-- 090_add_item_product_note.sql
-- ITEM に商品ごとの注意書き（PRODUCT NOTE）カラムを追加する。
--   product_note : 素材の特性上の注意など、商品詳細の仕様リストに出す注記
--
-- 追加のみ・後方互換の安全なマイグレーション。

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS product_note text;
