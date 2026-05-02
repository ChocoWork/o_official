# Stripe × Supabase 連携設計

## 推奨テーブル

\`\`\`sql
-- 顧客と auth.users の1:1マッピング
create table public.stripe_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz default now()
);

-- 購読の現在状態（Webhookで同期）
create table public.subscriptions (
  id text primary key,                       -- Stripe sub_xxx
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null,                      -- active/trialing/past_due/canceled...
  price_id text not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean default false,
  metadata jsonb,
  updated_at timestamptz default now()
);
create index on public.subscriptions(user_id);
create index on public.subscriptions(status);

-- Webhook 冪等性
create table public.stripe_webhook_events (
  id text primary key,                       -- evt_xxx
  type text not null,
  received_at timestamptz default now()
);
\`\`\`

## RLS

\`\`\`sql
alter table public.stripe_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.stripe_webhook_events enable row level security;

create policy "own_customer_read" on public.stripe_customers
  for select using ( user_id = (select auth.uid()) );

create policy "own_subscription_read" on public.subscriptions
  for select using ( user_id = (select auth.uid()) );

-- 書き込みは service_role のみ（ポリシー無しで暗黙的に拒否）
\`\`\`

## Edge Function: Stripe Webhook 受信

要点:
- `Stripe-Signature` ヘッダ検証（Deno: `Stripe.webhooks.constructEventAsync`）
- `stripe_webhook_events` に `INSERT ... ON CONFLICT DO NOTHING` で冪等化
- `customer.subscription.*` で `subscriptions` を upsert
- `service_role` クライアントを利用、CORSは Stripe IP 想定で不要

## アクセス権チェック（アプリ側）

\`\`\`sql
create or replace function public.has_active_subscription()
returns boolean
language sql stable
as $$
  select exists (
    select 1 from public.subscriptions
    where user_id = (select auth.uid())
      and status in ('active', 'trialing')
      and current_period_end > now()
  );
$$;
\`\`\`

これをRLSポリシーや Edge Function から参照する。