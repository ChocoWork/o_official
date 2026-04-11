# 1.15 マイアカウントページ（ACCOUNT）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-ACCOUNT-001 | `/account` ページはプロフィール編集・注文履歴・ウィッシュリストの3タブ構成とし `?tab=` クエリパラメータで URL とタブ状態を同期する | IMPL-ACCOUNT-001 | `src/app/account/page.tsx` | `useSearchParams` でタブを読み取り、`router.replace` で URL 同期。`profile` / `orders` / `wishlist` の3タブを実装 | 済 |
| FR-ACCOUNT-002 | プロフィールタブにはログイン中のメールアドレスを表示しユーザーが自身の認証情報を確認できるようにする | IMPL-ACCOUNT-002 | `src/app/account/page.tsx` | メールアドレスが `"demo@gmail.com"` にハードコードされており Supabase ユーザー情報を取得していない | 未 |
| FR-ACCOUNT-003 | 未ログイン時は「ログインが必要です」メッセージと `/login` への誘導ボタンを表示しログイン済みユーザーのみコンテンツを表示する | IMPL-ACCOUNT-003 | `src/app/account/page.tsx` | `user` が null の場合に案内テキスト + `<Button href="/login">` を表示する条件分岐を実装 | 済 |
| FR-ACCOUNT-004 | プロフィール保存フォームのバリデーションと `PATCH /api/profile` への送信を実装する | IMPL-ACCOUNT-004 | `src/app/account/page.tsx`, `src/app/api/profile/route.ts` | `<form>` に `onSubmit` ハンドラなし。`convertAddress` で zipcloud を直接呼び出しており `postal_code_cache` API 経由ではない | 未 |
| FR-ACCOUNT-005 | 注文履歴タブでは `GET /api/orders` から取得した実際の注文データをステータスバッジ付きで一覧表示する | IMPL-ACCOUNT-005 | `src/app/account/page.tsx` | `orders` ステートに `ORD-ABC123` 等のハードコードダミーデータを使用。`readdy.ai` 外部画像参照。実 API 未連携 | 未 |
| FR-ACCOUNT-006 | プロフィールフォームは氏名・フリガナ・電話番号・郵便番号・都道府県・市区町村・番地・建物名の全フィールドを API で保存できるようにする | IMPL-ACCOUNT-006 | `src/app/account/page.tsx`, `src/app/api/profile/route.ts` | `full_name` / `phone` のみを PATCH で保存。フリガナ・住所フィールドは UI に存在するが `onSubmit` 未実装のため保存されない | 未 |
