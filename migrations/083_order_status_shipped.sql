-- 083: 注文ステータスに「発送済み」を追加する
--
-- ALTER TYPE ... ADD VALUE で追加した値は、同じトランザクション内では使えない。
-- 列追加や制約と混ぜず、この1本だけを独立させる。
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'shipped';
