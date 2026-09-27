-- 注文メールの送信権を1つだけ取れるようにする（FREQ-386、チップ: 注文確認メールの重複）
--
-- 背景: 注文確定は「画面からの complete」と「Stripe webhook」の2経路から走り、どちらも同じ注文を
-- 受け取る（関数は既存の注文をそのまま返すため）。送信済みの記録がどこにも無いので、
--   コンビニ・銀行振込: complete と webhook の両方が「お支払い待ち」を送る（2通）
--   カード: webhook が先に注文を作ると、webhook は pending のときしか送らず、complete は
--           既存注文として何も送らずに返す（0通）
-- Stripe は「同じイベントを複数回受信する可能性」「配信順は保証しない」と明記しているため、
-- 受け取り側で重複を排除する必要がある（OWASP ASVS V11.1.6 の TOCTOU / 競合）。
--
-- 修正: 送る直前に (注文, 種類) の権利を1つだけ取る。取れた経路だけが送り、送信に失敗したら戻す。
-- 記録は private スキーマに置く。Supabase のドキュメントのとおり、private は Data API から触れない。
-- 触るのは public の SECURITY DEFINER 関数だけにし、実行は service_role にのみ許す。

BEGIN;

create table private.order_emails (
  order_id uuid not null references public.orders (id) on delete cascade,
  kind     text not null check (kind in ('awaiting_payment', 'paid')),
  sent_at  timestamptz not null default now(),
  primary key (order_id, kind)
);

comment on table private.order_emails is '注文メールの送信権。1注文・1種類につき1行だけ（FREQ-386）';

-- 取れたら true。既に誰かが取っていれば false。
create or replace function public.claim_order_email(_order_id uuid, _kind text)
  returns boolean
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  insert into private.order_emails (order_id, kind)
  values (_order_id, _kind)
  on conflict (order_id, kind) do nothing;

  return found;
end;
$$;

-- 送信に失敗したときに権利を戻す。戻せたら true。
create or replace function public.release_order_email(_order_id uuid, _kind text)
  returns boolean
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  delete from private.order_emails
  where order_id = _order_id
    and kind = _kind;

  return found;
end;
$$;

revoke all on function public.claim_order_email(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_order_email(uuid, text) to service_role;

revoke all on function public.release_order_email(uuid, text) from public, anon, authenticated;
grant execute on function public.release_order_email(uuid, text) to service_role;

COMMIT;
