-- 031: Add stock_quantity to items table
-- stock_quantity: NULL = 在庫情報なし, 0 = SOLD OUT, 1-4 = 残りわずか, 5+ = 在庫あり

ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS stock_quantity integer DEFAULT NULL;

COMMENT ON COLUMN public.items.stock_quantity IS 'NULL = 在庫情報なし, 0 = SOLD OUT, 1-4 = 残りわずか (LOW STOCK), 5以上 = 在庫あり';
