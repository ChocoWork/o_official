-- rate_limit_counters の保持ポリシー（FREQ-360）
--
-- 背景: 回数の記録は時間枠（最長1時間）が過ぎれば使わないが、掃除されずに溜まり続けていた。
-- キーにはメールアドレスやセッション ID のハッシュ値が入るので、必要な期間を超えて保持しない。
--
-- 対象: bucket（時間枠の開始時刻）から2時間を過ぎた行。最長の時間枠（3600秒）に余裕を持たせた値。
-- 時間枠を1時間より長くする場合は、この保持期間も合わせて延ばすこと。
--
-- pg_cron 拡張と postgres への権限は 20260911235714_add_checkout_drafts_retention_job.sql で用意済み。
-- ここで grant は書かない。適用時点では前回の grant で postgres 自身が付与した権限が残っていて、
-- create extension を書くと Supabase のイベントトリガー（issue_pg_cron_access）の revoke が
-- dependent privileges exist で失敗した。その自己付与はマイグレーション revoke_redundant_pg_cron_self_grants で取り消した。

-- 同名ジョブは upsert される（cron.schedule はジョブ名で置き換える）
select cron.schedule(
  'rate-limit-counters-retention',
  '15 * * * *',
  $$
    delete from public.rate_limit_counters
    where bucket < now() - interval '2 hours'
  $$
);
