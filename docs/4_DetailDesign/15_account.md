# 1.15 マイアカウントページ（ACCOUNT）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-ACCOUNT-001 | `/account` ページはプロフィールタブ・注文履歴タブ・配送先住所タブを提供し、`?tab=` クエリと表示状態を同期する | IMPL-ACCOUNT-001 | `src/app/account/page.tsx` | `useSearchParams` でタブを読み取り、`profile` / `orders` / `address` の3タブを表示する。URL 同期はクエリ読取のみで完全ではない | 済 |
| FR-ACCOUNT-002 | プロフィールタブではメールアドレス（読み取り専用）・氏名・電話番号を表示・編集できる | IMPL-ACCOUNT-002 | `src/app/account/page.tsx`, `src/app/api/profile/route.ts` | 氏名・電話番号は `/api/profile` で取得・保存できるが、メールアドレスは `"demo@gmail.com"` にハードコードされている | 未 |
| FR-ACCOUNT-003 | 未ログイン時のアクセスは案内表示またはログイン導線で適切にハンドリングする | IMPL-ACCOUNT-003 | `src/app/account/page.tsx` | `isLoggedIn` が false の場合に案内テキストと `/login` への誘導ボタンを表示する | 済 |
| FR-ACCOUNT-004 | 配送先住所タブでは郵便番号・都道府県・市区町村・番地を入力・保存でき、郵便番号入力時に住所自動補完を行う | IMPL-ACCOUNT-004 | `src/app/account/page.tsx`, `src/app/api/profile/route.ts` | 郵便番号から zipcloud を直接呼び出して補完するが、保存処理と API 連携は未完了 | 未 |
| FR-ACCOUNT-005 | 注文履歴タブでは過去の注文を一覧表示し、注文詳細への遷移を提供する | IMPL-ACCOUNT-005 | `src/app/account/page.tsx` | `ORD-ABC123` 等のハードコードダミーデータを表示しており、実注文 API と詳細導線は未実装 | 未 |
| FR-ACCOUNT-006 | 顧客プロフィールの保存項目を拡張し、フリガナ・住所を含めた完全な顧客情報を管理できるようにする | IMPL-ACCOUNT-006 | `src/app/account/page.tsx`, `src/app/api/profile/route.ts` | UI 上は住所系入力欄があるが、保存対象は `full_name` / `phone` のみでフリガナ・住所は未保存 | 未 |
| FR-ACCOUNT-007 | account ページからログアウトできる導線を提供し、ログアウト後は未ログイン状態を明示する | IMPL-ACCOUNT-007 | `src/app/account/page.tsx`, `src/contexts/LoginContext.tsx`, `src/app/api/auth/logout/route.ts` | account サイドバーにログアウトボタンを追加し、`/api/auth/logout` 呼び出し後に未ログイン案内表示へ戻す | 済 |

---

## TODO一覧 (ACCOUNT-LOGOUT-FOLLOWUPS)

| 要件ID | 種別 | 現状 | 修正/確認計画 |
|--------|------|------|--------------|
| FR-ACCOUNT-007 | 実装 | account ページからログアウトできる要件を追加済み | account 詳細設計と実装の整合性を維持する |
| FR-ACCOUNT-007 | UI | account ページにログアウトボタンを追加済み | ボタン文言・状態表示・エラー表示を回帰確認する |
| FR-ACCOUNT-007 | 認証 | `LoginContext.logout` を API `/api/auth/logout` と整合済み | サーバー logout とクライアント状態更新の両方を維持する |
| FR-ACCOUNT-001〜007 | E2E | account 要件ごとの Playwright 試験ファイルを追加済み | 要件未実装分は skip を維持し、実装後に有効化する |
| FR-ACCOUNT-007 | E2E | logout フローの Playwright 試験を実行可能な形で実装済み | OTP モックから `/account` へ遷移する検証パターンを維持する |
| FR-ACCOUNT-001 / 002 / 004 / 005 / 006 | 残課題 | 認証モックまたは実データ連携が不足しており skip が残っている | 認証モックまたは実データ連携を整備し、skip を外す |

### 統合メモ

- logout 後は `/account` 上で未ログイン案内表示へ戻し、明示的にログアウト完了を確認できるようにする。
- E2E は login ページの OTP モックから SPA 遷移で `/account` に入り、セッション永続化なしでも UI フローを確認する。
