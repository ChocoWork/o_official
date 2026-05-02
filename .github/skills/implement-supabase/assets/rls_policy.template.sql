-- File: rls_policy.template.sql
-- 新テーブル作成時のRLSテンプレート。<TABLE> と <USER_COL> を置換。

alter table public.<TABLE> enable row level security;

create policy "<TABLE>_select_own"
  on public.<TABLE> for select to authenticated
  using ( <USER_COL> = (select auth.uid()) );

create policy "<TABLE>_insert_own"
  on public.<TABLE> for insert to authenticated
  with check ( <USER_COL> = (select auth.uid()) );

create policy "<TABLE>_update_own"
  on public.<TABLE> for update to authenticated
  using ( <USER_COL> = (select auth.uid()) )
  with check ( <USER_COL> = (select auth.uid()) );

create policy "<TABLE>_delete_own"
  on public.<TABLE> for delete to authenticated
  using ( <USER_COL> = (select auth.uid()) );

-- 必須インデックス
create index if not exists <TABLE>_<USER_COL>_idx on public.<TABLE>(<USER_COL>);