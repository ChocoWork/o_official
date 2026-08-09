create table if not exists public.admin_meta_kpi_connections (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'meta' check (provider = 'meta'),
  instagram_user_id text not null,
  instagram_username text,
  facebook_page_id text,
  ad_account_id text,
  ad_account_name text,
  access_token_encrypted text not null,
  token_expires_at timestamptz,
  connected_by uuid references auth.users(id) on delete set null,
  last_synced_at timestamptz,
  last_sync_status text check (last_sync_status in ('success', 'partial', 'failed')),
  last_sync_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider)
);

create table if not exists public.admin_meta_kpi_sync_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.admin_meta_kpi_connections(id) on delete cascade,
  season_key text not null check (season_key ~ '^[0-9]{4}(SS|AW)$'),
  status text not null check (status in ('running', 'success', 'partial', 'failed')),
  metrics_written integer not null default 0,
  message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.admin_meta_kpi_connections enable row level security;
alter table public.admin_meta_kpi_sync_runs enable row level security;

revoke all on table public.admin_meta_kpi_connections from anon, authenticated;
revoke all on table public.admin_meta_kpi_sync_runs from anon, authenticated;

create index if not exists idx_admin_meta_kpi_sync_runs_connection_started
  on public.admin_meta_kpi_sync_runs (connection_id, started_at desc);

comment on table public.admin_meta_kpi_connections is 'Meta OAuth connection. Service-role access only; tokens are application-encrypted.';
comment on table public.admin_meta_kpi_sync_runs is 'Audit trail for Instagram and Meta Ads KPI synchronization.';
