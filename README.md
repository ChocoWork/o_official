このリポジトリは Next.js によるアプリケーションです。以下は開発、Supabase クライアントの配置、及び Vercel デプロイ時の注意点です。

はじめに（ローカル開発）

まず開発サーバーを起動します:

```bash
npm run dev
```

ブラウザで http://localhost:3000 を開き、`app/page.tsx` を編集すると自動リロードされます。

Supabase クライアントの配置

- サーバー側初期化: `src/lib/supabase/server.ts` をサーバールートや Server Components で使用してください。サーバー専用のためブラウザにバンドルされません。
- クライアント側初期化: `src/lib/supabase/client.ts` をクライアントコンポーネントで使用してください。ブラウザでは `NEXT_PUBLIC_SUPABASE_URL` と `NEXT_PUBLIC_SUPABASE_ANON_KEY` のみ利用します。

必須の環境変数（例）:

- `NEXT_PUBLIC_SUPABASE_URL`（公開可）
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`（公開可）
- `SUPABASE_SERVICE_ROLE_KEY`（サーバー専用・秘密）

運用時の SUPABASE_SERVICE_ROLE_KEY の取り扱い

- **絶対にクライアントに露出させないこと**。`SUPABASE_SERVICE_ROLE_KEY` は最小限のアクセス権限を持つサービスアカウントではなく強力なキーのため、Secrets Manager や Vercel の環境変数で保護してください。
- **リリース時のチェック項目**:
	- Service role キーが環境変数に設定されていること（Vercel の Project Settings → Environment Variables）。
	- デプロイ前にキーが漏洩していないか確認し、疑いがある場合は即時ローテーションしてデプロイし直すこと。
	- キーのローテーション手順（発見時の対応）を運用ドキュメントに明記すること。

Vercel にデプロイする際の具体的アクション（チェックリスト）

1. Vercel ダッシュボードの該当プロジェクト → `Settings` → `Environment Variables` に環境変数を登録:
	 - `NEXT_PUBLIC_SUPABASE_URL` = https://<project>.supabase.co
	 - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = <anon key>
	 - `SUPABASE_SERVICE_ROLE_KEY` = <service role key>（Value をプロダクションにのみ設定、Preview/Development 環境は別キーまたは未設定にする）
2. `SUPABASE_SERVICE_ROLE_KEY` は `Plaintext` 表示を避け、Vercel の Secrets 機能を使用して安全に保管する。
3. `Redirect URLs` や `Site URL` を Supabase 側で正しく設定し、`redirect_to` に関するオープンリダイレクト対策（ホワイトリスト）をサーバー側で実施する。
4. デプロイ後、ステージングでメールリンク E2E（メール受信 → リンククリック → 自動ログイン → Header が `ri-user-fill` に変わる）を確認する。

追加の注意点

- プレビュー環境では匿名キーとサービスキーの取り扱いに注意する（サービスキーをプレビューで共有しない）。
- 環境変数のローテーション手順と、万が一の漏洩時の対応手順（キー無効化、再発行、デプロイ）はリリース運用フローに含めてください。

参考ドキュメント: https://supabase.com/docs/guides/auth/ と https://vercel.com/docs
