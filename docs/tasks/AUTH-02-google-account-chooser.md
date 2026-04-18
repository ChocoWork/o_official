# AUTH-02-GOOGLE-ACCOUNT-CHOOSER

## 対象
- src/contexts/LoginContext.tsx
- src/components/LoginModal.tsx
- e2e/FR-LOGIN-002-google-oauth.spec.ts
- tests/unit/components/LoginContext.test.tsx

## 背景
- Google でサインイン押下時、Google 側の既存セッションによりアカウント選択画面を経ずにログインすることがある。
- ログイン先アカウントを利用者が選べる挙動が必要。

## TODO
- [x] FR-LOGIN-002 の Playwright 試験をアカウント選択要件まで拡張する
- [x] `signInWithOAuth` に Google アカウント選択を強制するクエリを付与する
- [x] 単体テストで OAuth オプションを固定化する
- [x] 詳細設計と仕様レビューを更新する
- [x] Chromium Playwright と Jest で再検証する