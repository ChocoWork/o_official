-- pg_cron の冗長な自己付与の取り消し
--
-- 背景: 20260911235714_add_checkout_drafts_retention_job.sql の
--   grant usage on schema cron to postgres;
--   grant all privileges on all tables in schema cron to postgres;
-- は postgres 自身が実行したため、「postgres から postgres への付与」として記録された。
-- postgres は同じ権限を supabase_admin から grant option 付きで受けているので、この付与は冗長で、
-- supabase_admin の付与に依存する形になる。
-- この状態で create extension pg_cron を実行すると、Supabase のイベントトリガー（issue_pg_cron_access）が
-- 特権で revoke all on table cron.job from postgres を実行し、依存する付与があるため
-- dependent privileges exist で失敗する（2026-09-13 に rate-limit-counters-retention の追加で実際に失敗した）。
--
-- 対応: postgres が自分に付けた付与だけを取り消す（GRANTED BY postgres）。supabase_admin からの付与は残るので、
-- cron.schedule やジョブの参照には影響しない。取り消す付与が無ければ警告だけで終わるので、再実行しても安全。
-- 今後のマイグレーションでは cron スキーマへの grant を書かないこと。

revoke usage on schema cron from postgres granted by postgres;
revoke all on table cron.job from postgres granted by postgres;
revoke all on table cron.job_run_details from postgres granted by postgres;
