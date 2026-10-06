# E2E テスト（Playwright）

## 概要

このディレクトリには、認証フロー中心のE2Eテストが含まれています。

## セットアップ

```bash
# Playwrightのインストール
npm run test:e2e -- --help

# ブラウザのインストール（初回のみ）
npx playwright install
```

## テスト実行

### 前提条件

E2E は本番ビルド（`next build` と `next start`）を手元の Supabase につないで流す。`playwright.config.ts` がアプリを起動するので、開発サーバーは要らない（3000番で動いていると、見張りが止める）。

1. Docker Desktop を起動し、手元の Supabase を起動する（`npm run db:start`）
2. 見本データを入れ直す（`npm run db:reset`。`supabase/seed.sql` が入る）。DB 結合テストを流した後は必ず入れ直す（結合テストが作った公開中の商品が残ると、検索などのテストが実装と関係なく落ちる）
3. テストを流す（下のコマンド）

見張り（`scripts/e2e/environment.ts`）は、次のときに理由を出して止まる。

- Supabase の住所が手元（localhost）ではない、Stripe の鍵がテスト用ではない、メールの送り先が手元ではない
- 3000番で、E2E が手元の設定で起動したものではないアプリ（開発サーバーなど）が動いている
- 手元の Supabase の状態を読めない

```bash
# 全E2Eテストを実行
npm run test:e2e

# 特定のテストファイルを実行
npm run test:e2e -- e2e/auth/full-flow.spec.ts

# UIモードで実行（デバッグに便利）
npm run test:e2e:ui

# ヘッドモードで実行（ブラウザを表示）
npm run test:e2e:headed

# デバッグモードで実行
npm run test:e2e:debug
```

## テストファイル構成

### `e2e/smoke.spec.ts`
基本的なスモークテスト。環境の動作確認用。

### `e2e/auth/full-flow.spec.ts`
完全な認証フロー：
- 新規ユーザー登録
- ログイン
- セッション維持（ページリロード）
- ページ遷移時のセッション保持
- リフレッシュトークン動作
- ログアウト
- ログアウト後のアクセス制御

### `e2e/auth/error-cases.spec.ts`
異常系・エラーケース：
- 誤パスワードでログイン失敗
- 存在しないメールでログイン失敗
- 重複メール登録失敗
- バリデーションエラー
- CSRF攻撃防御
- レート制限動作確認
- 有効期限切れトークン

### `e2e/security/session-hijacking.spec.ts`
セキュリティテスト：
- リフレッシュトークン再利用検出
- CSRF攻撃防御
- 複数デバイスでのセッション管理
- 不正トークンのアクセス拒否
- 改ざんされたJWT検出
- セッション有効期限切れ

## ヘルパー関数

`e2e/helpers.ts` には共通の処理が含まれています：
- `generateTestUser()`: ランダムなテストユーザーを生成
- `registerUser()`: ユーザー登録を実行
- `loginUser()`: ログインを実行
- `logoutUser()`: ログアウトを実行
- `expectLoggedIn()`: ログイン状態を確認
- `expectLoggedOut()`: 非ログイン状態を確認
- `getSessionCookies()`: セッションクッキーを取得

## CI/CD統合

`.github/workflows/e2e-tests.yml` (作成予定):

```yaml
name: E2E Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npm run build
      - run: npm run test:e2e
        env:
          CI: true
      - uses: actions/upload-artifact@v3
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
```

## トラブルシューティング

### ポート衝突

3000番でほかのアプリ（開発サーバーなど）が動いていると、見張りが理由を出して止まる。そのアプリを止めてから流す（`Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue` で確かめる）。E2E が手元の設定で起動したアプリが残っていれば、印で確かめてビルドし直さずにそのまま使う。コードを変えた後と push の前は、止めてから流す（`E2E_STRICT=1` のときは使い回さず、残っていれば止まる）。

### タイムアウトエラー

テストがタイムアウトする場合、`playwright.config.ts` の `timeout` 値を増やすか、ヘルパー関数の `waitForTimeout` 値を調整してください。

### セレクタが見つからない

UIが変更された場合、テストのセレクタを更新する必要があります。UIモードでデバッグすると便利です：

```bash
npm run test:e2e:ui
```

## 実装状況

- ✅ 基本的なスモークテスト
- ✅ 完全な認証フロー
- ✅ 異常系・エラーケース
- ✅ セキュリティテスト
- ⚠️ 実際のアプリケーションとの統合テストが必要
- 🚧 CI/CDパイプラインへの統合（予定）

## 注意事項

- E2E は手元の Supabase だけを使う。本番の Supabase の鍵と Resend の鍵は、アプリにもテストにも渡さない
- 見本データは `supabase/seed.sql` の架空の値。お客様・管理者のアカウントや注文は入っていない（ログインは偽の応答で行う）
- アプリのメールは手元のメール受け（Mailpit、http://127.0.0.1:54324）に届き、外へは出ない
- Stripe はテストモード。E2E は Stripe の知らせ（Webhook）を手元へつながない
- テストが作ったカートやお問い合わせは手元の DB に残る。`npm run db:reset` で消える
- 切り替えの前後を比べるときは `npm run e2e:compare`（最後の実行の `test-results/e2e-results.json` を読む）
