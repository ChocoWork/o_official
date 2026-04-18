# ACCOUNT-LOGOUT-FOLLOWUPS

## 対象
- docs/2_Specs/spec.md
- docs/4_DetailDesign/14_login.md
- src/app/account/page.tsx

## TODO
- [x] FR-ACCOUNT-007: account ページからログアウトできる要件を追加する
- [x] account ページにログアウトボタンを追加する
- [x] LoginContext の logout を API `/api/auth/logout` と整合するよう更新する
- [x] account 要件ごとの Playwright 試験ファイルを追加する
- [x] FR-ACCOUNT-007 の Playwright 試験を実行可能な形にする
- [ ] FR-ACCOUNT-001 / 002 / 004 / 005 / 006 の認証モックまたは実データ連携を整備し、skip を外す

## 実装方針
- logout 後は `/account` 上で未ログイン案内表示へ戻し、明示的にログアウト完了を確認できるようにする。
- E2E は login ページの OTP モックから SPA 遷移で `/account` に入り、セッション永続化なしでも UI フローを確認する。