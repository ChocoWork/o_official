# パスワード再設定シーケンス

> 状態: 廃止（2026-11-22。パスキー段4の Task 29 で、パスワードの再設定・変更の窓口と画面を消した） | 確認日: 2026-11-22 | 対象: メール要求、リンク確認、再設定、画面再開（消した）

## 概要

お客さんのパスワードのログインを消したので、パスワードの再設定（`/auth/password-reset`・`/auth/password-reset/verify`、`POST /api/auth/password-reset/{request,link,confirm}`、`GET /api/auth/password-reset/session`）と、ログイン中のパスワード変更（`/account/password`、`POST /api/auth/password/change/{start,confirm}`）は窓口・画面ごと消えた（404。FR-AUTH-053-AC-02）。

お客さんが入る流れ（メールのコード・パスキー・Google）は [会員向けの画面の処理](auth-passkey-customer-screens.md) が持つ。パスワードを忘れた人も、同じメールのコードで入れる。

## 範囲と根拠

消した図（`SQ-AUTH-RESET-REQUEST`・`SQ-AUTH-RESET-LINK`・`SQ-AUTH-RESET-CONFIRM`・`SQ-AUTH-RESET-RESUME`）は、コードが無いので残さない。決めは [ADR-0469](../../03_BasicDesign/decisions/ADR-0469-passkey-customer-email-code-login.md)、廃止した決めは ADR-0403（再設定の印を変える時に消費する）・ADR-0405（漏れたパスワードの照合）・ADR-0421（パスワード変更の2段の窓口）にある。要件は [AUTH の要件](../../02_Requirements/areas/auth.md) の SR-AUTH-030・FR-AUTH-053、旧の項目（SR-AUTH-009・FR-AUTH-006・SEC-AUTH-034 ほか）は「廃止」で残してある。

GoTrue 自身の `/recover`（アプリの外）は残る。ただし、フックがお客さんの `password` での入室を拒むので、再設定してもパスワードでは入れない（手順書は `docs/06_Operations/supabase-auth-config.md`）。

## 未確認事項

- `public.password_reset_tokens`・`public.password_change_challenges` の表と関数の削除は、移行 K（段4の Task 32）が行う。それまでは、アプリからの使い道だけが無い。
