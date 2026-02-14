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

開発サーバーが起動している必要があります：

```bash
npm run dev
```

別のターミナルでテストを実行：

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

開発サーバーが既に起動している場合、`playwright.config.ts` の `reuseExistingServer` を `true` に設定してください。

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

- E2Eテストは統合環境でのみ実行されます（開発サーバーが必要）
- テストデータは各テストで自動生成され、クリーンアップされます
- 本番環境ではE2Eテストを実行しないでください
