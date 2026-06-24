-- 055_add_item_structured_details.sql
-- ITEM に構造化された製品情報カラムを追加する。
--   material      : 素材名
--   origin        : 原産国
--   sewing_region : 縫製地域
--   care          : ケア方法
--   season        : コレクション（SS / AW のみ。年は持たない）
--
-- 既存の自由テキスト product_details は互換のため残置（旧データの表示フォールバックに使用）。
-- 追加のみ・後方互換の安全なマイグレーション。

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS material text,
  ADD COLUMN IF NOT EXISTS origin text,
  ADD COLUMN IF NOT EXISTS sewing_region text,
  ADD COLUMN IF NOT EXISTS care text,
  ADD COLUMN IF NOT EXISTS season text;

-- season は SS / AW のみ許可（未設定 = NULL）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'items_season_check'
  ) THEN
    ALTER TABLE items
      ADD CONSTRAINT items_season_check CHECK (season IS NULL OR season IN ('SS', 'AW'));
  END IF;
END$$;
