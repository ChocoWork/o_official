# Google OAuth 設定確認チェックリスト

## 修正内容

✅ `LoginContext.tsx` を修正: `/api/auth/oauth/start` から `supabase.auth.signInWithOAuth` に変更
✅ コールバックページは既に正しく実装済み: `/app/auth/callback/page.tsx`

## 次のステップ: 設定確認

### 1. Google Cloud Console での設定確認

**対象**: Google Cloud Console > APIs & Services > Credentials > OAuth 2.0 Client IDs

以下の URL が **完全一致** で登録されているか確認:

```
https://pjidrgofvaglnuuznnyj.supabase.co/auth/v1/callback
```

**重要ポイント**:
- ✅ `https://` で始まる（`http://` ではない）
- ✅ プロジェクトID `pjidrgofvaglnuuznnyj` が正しい
- ✅ `/auth/v1/callback` で終わる（末尾スラッシュなし）
- ✅ 余計な空白やパラメータがない

**ローカル開発用（オプション）**:
開発環境でテストする場合は、以下も追加:
```
http://127.0.0.1:54321/auth/v1/callback
```

### 2. Supabase Dashboard での設定確認

**URL**: https://supabase.com/dashboard/project/pjidrgofvaglnuuznnyj/auth/providers

#### 2-1. Google Provider 設定
- [ ] **Google Enabled** が ON になっている
- [ ] **Client ID** が Google Console のものと一致
- [ ] **Client Secret** が Google Console のものと一致
- [ ] **Authorized Client IDs** は空欄でOK（モバイルアプリ用）

#### 2-2. URL Configuration
**URL**: https://supabase.com/dashboard/project/pjidrgofvaglnuuznnyj/auth/url-configuration

- [ ] **Site URL** が設定されている
  - 本番: `https://your-domain.com`
  - 開発: `http://localhost:3000`
- [ ] **Redirect URLs** に以下が含まれている:
  - `http://localhost:3000/auth/callback`
  - `https://your-domain.com/auth/callback` （本番URLがある場合）

### 3. テスト手順

1. ブラウザのシークレットウィンドウを開く（キャッシュの影響を避けるため）
2. `http://localhost:3000/login` にアクセス
3. 「Googleでサインイン」をクリック
4. Google 認証画面が表示される
5. アカウントを選択して承認
6. `/auth/callback` を経由して `/auth/verified` または `/` にリダイレクトされる
7. ヘッダーのアイコンがログイン状態（塗りつぶし）に変わる

### 4. トラブルシューティング

#### エラー: `redirect_uri_mismatch` (Google側)
→ Google Console の Authorized redirect URIs に `https://pjidrgofvaglnuuznnyj.supabase.co/auth/v1/callback` を追加

#### エラー: `bad_oauth_state` (Supabase側)
→ 修正済み（`supabase.auth.signInWithOAuth` を使用するように変更）

#### エラー: `Invalid Redirect URL` (Supabase側)
→ Supabase の URL Configuration > Redirect URLs に `/auth/callback` を追加

#### ヘッダーアイコンが変わらない
→ ブラウザのキャッシュをクリアするか、シークレットウィンドウで再試行

### 5. 開発サーバー再起動

修正後、開発サーバーを再起動:

```bash
# 既存のプロセスを停止
Ctrl + C

# 再起動
npm run dev
```

## 確認後の報告

テストが完了したら、以下を報告してください:

- [ ] Google ログインが成功した
- [ ] ヘッダーアイコンがログイン状態に変わった
- [ ] エラーが出た（エラーメッセージを共有）

## 参考

- Supabase 公式ドキュメント: https://supabase.com/docs/guides/auth/social-login/auth-google
- プロジェクトURL: https://pjidrgofvaglnuuznnyj.supabase.co
