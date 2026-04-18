# 1.15 マイアカウントページ（ACCOUNT）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-ACCOUNT-001 | `/account` ページはプロフィールタブ・配送情報タブ・注文履歴タブを提供し、`?tab=` クエリと表示状態を同期する | IMPL-ACCOUNT-001 | `src/app/account/page.tsx` | `useSearchParams` と `router.replace` を併用し、`profile` / `shipping` / `orders` の3タブと `?tab=` クエリを同期し、旧 `address` 指定は `shipping` へ正規化する | 済 |
| FR-ACCOUNT-002 | プロフィールタブではメールアドレス（読み取り専用）・氏名・電話番号を表示・編集できる | IMPL-ACCOUNT-002 | `src/app/account/page.tsx`, `src/app/api/profile/route.ts` | `/api/profile` が認証済みユーザーの email / 氏名 / 電話番号を返し、account 画面で read-only メール表示と編集保存を行う | 済 |
| FR-ACCOUNT-003 | 未ログイン時のアクセスは案内表示またはログイン導線で適切にハンドリングする | IMPL-ACCOUNT-003 | `src/app/account/page.tsx` | `isLoggedIn` が false の場合に案内テキストと `/login` への誘導ボタンを表示する | 済 |
| FR-ACCOUNT-004 | 配送情報タブでは郵便番号・都道府県・市区町村・番地を入力・保存でき、郵便番号入力時に住所自動補完を行う | IMPL-ACCOUNT-004 | `src/app/account/page.tsx`, `src/app/api/profile/route.ts` | 配送情報タブで住所を保存し、郵便番号補完は `/api/checkout/postal-code` 経由で実行する | 済 |
| FR-ACCOUNT-005 | 注文履歴タブでは過去の注文を一覧表示し、注文詳細への遷移を提供する | IMPL-ACCOUNT-005 | `src/app/account/page.tsx`, `src/app/api/orders/route.ts`, `src/app/api/orders/[id]/route.ts`, `src/app/account/orders/[id]/page.tsx` | `/api/orders` で本人注文一覧を返し、一覧カードと `/account/orders/[id]` の注文詳細導線を実装する | 済 |
| FR-ACCOUNT-006 | 顧客プロフィールの保存項目を拡張し、フリガナ・住所を含めた完全な顧客情報を管理できるようにする | IMPL-ACCOUNT-006 | `src/app/account/page.tsx`, `src/app/api/profile/route.ts` | `profiles.kana_name` / `phone` / `address` を保存対象に含め、プロフィール編集から完全な顧客情報を管理できるようにする | 済 |
| FR-ACCOUNT-007 | account ページからログアウトできる導線を提供し、ログアウト後は未ログイン状態を明示する | IMPL-ACCOUNT-007 | `src/app/account/page.tsx`, `src/contexts/LoginContext.tsx`, `src/app/api/auth/logout/route.ts` | account サイドバーにログアウトボタンを追加し、`/api/auth/logout` 呼び出し後に未ログイン案内表示へ戻す | 済 |
| FR-ACCOUNT-008 | メールアドレスをプロフィールカードへ含め、配送先住所 UI を配送情報タブへ分離する | IMPL-ACCOUNT-008 | `src/app/account/page.tsx`, `e2e/FR-ACCOUNT-008-profile-address-integration.spec.ts` | プロフィールカード内に read-only メール表示を含め、住所管理は配送情報タブへ分離する | 済 |
| FR-ACCOUNT-009 | ログイン中アカウントのメールアドレスをプロフィール欄へ表示し、プロフィール取得失敗を解消する | IMPL-ACCOUNT-009 | `src/app/api/profile/route.ts`, `src/lib/supabase/server.ts`, `e2e/FR-ACCOUNT-009-authenticated-profile-fetch.spec.ts` | account API が Bearer token または `sb-access-token` Cookie から本人を解決できるようにし、プロフィール取得を成功させる | 済 |
| FR-ACCOUNT-010 | 購入履歴をログイン中アカウントに紐づく注文で表示し、注文履歴取得失敗を解消する | IMPL-ACCOUNT-010 | `src/app/api/orders/route.ts`, `src/app/api/orders/[id]/route.ts`, `src/lib/supabase/server.ts`, `e2e/FR-ACCOUNT-010-authenticated-order-history-fetch.spec.ts` | orders API が Bearer token または `sb-access-token` Cookie から本人を解決できるようにし、購入履歴一覧と注文詳細取得を成功させる | 済 |

---

## TODO一覧 (ACCOUNT-FOLLOWUPS)

| 要件ID | 種別 | 現状 | 修正/確認計画 |
|--------|------|------|--------------|
| FR-ACCOUNT-008 | 完了 | 配送先住所 UI をプロフィールタブへ統合し、独立タブを廃止した | 旧 `?tab=address` の導線が `profile` へ正規化される状態を維持する |
| FR-ACCOUNT-009 | 完了 | profile API が custom auth cookie / Bearer token から本人を解決できるようになった | メールアドレス欄の実アカウント表示とプロフィール取得回帰を維持する |
| FR-ACCOUNT-010 | 完了 | orders API が custom auth cookie / Bearer token から本人を解決できるようになった | 購入履歴一覧と注文詳細取得の回帰を維持する |
| FR-ACCOUNT-002 | 完了 | `/api/profile` が認証済みユーザーの email / 氏名 / 電話番号を返すようになった | account 画面の read-only メール表示と Playwright 回帰を維持する |
| FR-ACCOUNT-004 | 完了 | 住所保存と `/api/checkout/postal-code` 経由の補完を実装した | 保存後メッセージと住所表示同期の回帰を維持する |
| FR-ACCOUNT-005 | 完了 | `/api/orders` と `/account/orders/[id]` による注文一覧・詳細導線を実装した | 注文が 0 件の空状態と本人注文のみ表示の前提を維持する |
| FR-ACCOUNT-006 | 完了 | フリガナ・住所を含む完全プロフィール保存を実装した | checkout からの既存 `/api/profile` payload 互換を維持する |
| FR-ACCOUNT-007 | 実装 | account ページからログアウトできる要件を追加済み | account 詳細設計と実装の整合性を維持する |
| FR-ACCOUNT-007 | UI | account ページにログアウトボタンを追加済み | ボタン文言・状態表示・エラー表示を回帰確認する |
| FR-ACCOUNT-007 | 認証 | `LoginContext.logout` を API `/api/auth/logout` と整合済み | サーバー logout とクライアント状態更新の両方を維持する |
| FR-ACCOUNT-001〜007 | E2E | account 認証モック共通 helper と要件単位の Playwright 試験を整備済み | Chromium で `FR-ACCOUNT-001` 〜 `007` が通る状態を維持する |
| FR-ACCOUNT-007 | E2E | logout フローの Playwright 試験を実行可能な形で実装済み | OTP モックから `/account` へ遷移する検証パターンを維持する |
| FR-ACCOUNT-001 / 002 / 004 / 005 / 006 | 検証 | 事前に作成した Playwright 試験を Chromium で実行し、skip を解消した | 実データ環境でも同一シナリオを継続確認する |

## 今回の実装計画

1. `FR-ACCOUNT-008〜010` の Playwright 試験ファイルを追加し、住所統合・認証付きプロフィール取得・認証付き注文履歴取得の期待挙動を固定した。
2. account 画面と関連 API の認証経路を調査し、client 側 login 状態と server 側 `supabase.auth.getUser()` の不整合原因が custom auth cookie 未考慮にあると切り分けた。
3. `src/app/account/page.tsx` を更新し、配送先住所 UI をプロフィールタブへ統合し、独立タブを廃止した。
4. profile / orders API を更新し、Bearer token または `sb-access-token` Cookie から本人を解決してメールアドレスと購入履歴を返せるようにした。
5. Playwright で account 要件と画面崩れを再確認し、詳細設計のステータス更新まで完了した。

### 統合メモ

- logout 後は `/account` 上で未ログイン案内表示へ戻し、明示的にログアウト完了を確認できるようにする。
- E2E は login ページの OTP モックから SPA 遷移で `/account` に入り、セッション永続化なしでも UI フローを確認する。
- 実運用では client の localStorage セッションと server API の認証判定がずれる可能性があるため、account 系 fetch は Bearer token を付与できる実装へ寄せる。
- OTP verify 成功時は browser 側の Supabase session / localStorage も同期し、ログイン直後のプロフィール取得で認証不整合が起きないようにする。
- Supabase の profiles 保存は RLS が有効なため、account/profile API は request ごとの Authorization ヘッダを Supabase client に引き渡し、DB query 自体もユーザー文脈で実行する。
- account の電話番号と郵便番号入力は、表示は自動整形しつつ、ユーザーは数字のみを意識して入力できる状態を維持する。郵便番号の補完 API 呼び出しと保存 payload は正規化済みの数字列を使う。
- account のプロフィールタブはメールアドレス・氏名・フリガナ・電話番号を扱い、配送情報タブは住所情報のみを扱う。削除操作もタブごとの情報範囲に限定する。
