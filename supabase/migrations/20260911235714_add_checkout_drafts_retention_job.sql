-- checkout_drafts の保持ポリシー（FREQ-354 の派生タスク）
--
-- 背景: checkout を開いた時点で決済セッションを作る方式に変えたため、離脱ぶんの
-- 未完了 draft が増える。draft の shipping_snapshot には氏名・電話・住所が入るので、
-- 決済に至らなかった行を無期限に保持しない。
--
-- 対象: status <> 'completed'（created / failed）かつ作成から一定期間を過ぎた行。
-- 注文が確定した draft は status='completed' になり、削除対象から外れる。

create extension if not exists pg_cron with schema pg_catalog;

-- 注意: 次の2行は postgres 自身への付与として記録され、後の create extension pg_cron を
-- dependent privileges exist で失敗させる原因になった（マイグレーション revoke_redundant_pg_cron_self_grants で取り消し済み）。
-- 適用済みの記録として残しているだけなので、新しいマイグレーションに写さないこと。
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

-- 同名ジョブは upsert される（cron.schedule はジョブ名で置き換える）
select cron.schedule(
  'checkout-drafts-retention',
  '30 3 * * *',
  $$
    delete from public.checkout_drafts
    where status <> 'completed'
      and created_at < now() - interval '30 days'
  $$
);
