-- K-1: 送料は無料に固定（FREQ-516）。orders.shipping_amount の既定値 500 の残り物を 0 にする。
-- 注文を作る関数は列を必ず書くので、お金の動きは変わらない。昔の注文の値は変えない。
BEGIN;

ALTER TABLE public.orders ALTER COLUMN shipping_amount SET DEFAULT 0;

COMMIT;

NOTIFY pgrst, 'reload schema';
