-- 配送先スナップショットの版番号（FREQ-365、レビュー指摘⑤）
--
-- 背景: draft の配送先は3経路から書き換わる。
--   1. 画面のデバウンス同期（POST /api/checkout/update-shipping）
--   2. 確定直前の同期（同上）
--   3. create-session の再利用経路（別タブ・再読み込み）
-- これまでは無条件の上書きだったため、遅れて届いた古い内容が新しい内容を消し、
-- 古い住所のまま支払い済みの注文ができた（lost update）。画面側は自分の記憶だけで
-- 「同期済み」と判定していたため、確定直前の同期も省略されていた（TOCTOU）。
--
-- 対策: 書き込みは「クライアントが見た版と一致するときだけ」適用する。
--   update public.checkout_drafts
--   set shipping_snapshot = $1, shipping_revision = $2 + 1
--   where ... and shipping_revision = $2
-- RFC 9110 の条件付きリクエスト（If-Match）と同じ考え方。Read Committed の Postgres は
-- 競合した更新の条件を評価し直すため、同時に走っても勝つのは片方だけになる。
-- 「読んでから書く」の2段構えにはしない（Supabase のベストプラクティス data-upsert）。
--
-- 既定値つきの not null 列の追加は、PostgreSQL 11 以降ではテーブルを書き換えない。

BEGIN;

alter table public.checkout_drafts
  add column if not exists shipping_revision bigint not null default 0;

comment on column public.checkout_drafts.shipping_revision is
  '配送先スナップショットの版番号。更新はクライアントが見た版と一致するときだけ適用する（lost update 防止、FREQ-365）。';

COMMIT;
