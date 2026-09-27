-- 回数制限の subject 単位（メールアドレス・セッション・管理者）が一度も効いていなかった問題の修正（FREQ-360）
--
-- 背景: subject 単位の回数は ip を NULL にして数える。一意制約 UNIQUE (ip, endpoint, bucket) は
-- NULL 同士を別の値とみなすため ON CONFLICT が発動せず、加算されないまま「1回目」の行が毎回増えていた。
-- 対応: NULLS NOT DISTINCT（PostgreSQL 15 以降）で NULL 同士を同じ値とみなす。加算する関数は変更しない
-- （ON CONFLICT (ip, endpoint, bucket) は、列が同じ新しい一意制約をそのまま使う）。
--
-- 手順の注意:
-- - 旧制約の削除と新制約の追加は同じトランザクションで行う。間で確定すると ON CONFLICT に合う制約が
--   無くなり、回数制限を使う API がすべて 503（fail-closed）を返す。
-- - IP が NULL の行は一度も制限に効いていないので、消しても挙動は変わらない。
-- - idx_rate_limit_ip_endpoint_bucket は一意制約の索引と同じ列の通常索引で、書き込みを遅くするだけなので削除する。

-- 行の大半はここで消える。行ロックだけなので、他の書き込みを止めない。
DELETE FROM public.rate_limit_counters
WHERE ip IS NULL
   OR bucket < now() - interval '2 hours';

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 上の削除から張り替えまでの間に入った IP なしの行（重複しうる）で制約の追加が失敗しないよう、
-- 書き込みを止めてから消し直す。
LOCK TABLE public.rate_limit_counters IN SHARE ROW EXCLUSIVE MODE;

DELETE FROM public.rate_limit_counters
WHERE ip IS NULL;

ALTER TABLE public.rate_limit_counters
  DROP CONSTRAINT IF EXISTS rate_limit_counters_unique;

ALTER TABLE public.rate_limit_counters
  ADD CONSTRAINT rate_limit_counters_unique UNIQUE NULLS NOT DISTINCT (ip, endpoint, bucket);

DROP INDEX IF EXISTS public.idx_rate_limit_ip_endpoint_bucket;

COMMIT;
