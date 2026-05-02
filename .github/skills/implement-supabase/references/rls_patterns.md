# RLS パターン集

## 原則
- `auth.uid()` は `(select auth.uid())` でラップ → InitPlan化されインデックスが効く
- ポリシーは **オペレーション別** に分けて書く（USING / WITH CHECK の意味が異なる）
- `security definer` 関数は最小限に

## パターン1: 所有者のみアクセス

\`\`\`sql
alter table public.notes enable row level security;

create policy "notes_select_own"
  on public.notes for select
  using ( user_id = (select auth.uid()) );

create policy "notes_insert_own"
  on public.notes for insert
  with check ( user_id = (select auth.uid()) );

create policy "notes_update_own"
  on public.notes for update
  using ( user_id = (select auth.uid()) )
  with check ( user_id = (select auth.uid()) );

create policy "notes_delete_own"
  on public.notes for delete
  using ( user_id = (select auth.uid()) );
\`\`\`

## パターン2: チームメンバーシップ

\`\`\`sql
create policy "team_docs_member_read"
  on public.team_documents for select
  using (
    exists (
      select 1 from public.team_members tm
      where tm.team_id = team_documents.team_id
        and tm.user_id = (select auth.uid())
    )
  );
\`\`\`

`team_members(user_id, team_id)` に**複合インデックス**を必ず張る。

## パターン3: ロールベース

\`\`\`sql
create policy "admin_only_delete"
  on public.audit_logs for delete
  using (
    (select auth.jwt() ->> 'user_role') = 'admin'
  );
\`\`\`

JWTカスタムクレームは Auth Hook で注入。

## パターン4: 公開フラグ

\`\`\`sql
create policy "public_or_owner_read"
  on public.posts for select
  using ( is_public = true or author_id = (select auth.uid()) );
\`\`\`

## パターン5: Storage バケット

\`\`\`sql
create policy "avatars_owner_write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
\`\`\`

## アンチパターン
- ❌ `using (true)` を全オペに付けて「とりあえず動かす」
- ❌ クライアントから `service_role` キーを使う
- ❌ ポリシー内で外部APIを呼ぶ関数を実行（タイムアウト・N+1）
- ❌ `auth.uid()` を裸で使う（インデックス不利用）