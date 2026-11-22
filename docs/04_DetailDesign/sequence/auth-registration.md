# 会員登録・確認シーケンス

> 状態: 廃止（2026-11-22。パスキー段4の Task 28 で、公開登録の窓口 `POST /api/auth/register` と確認リンクの窓口 `GET /api/auth/confirm` を消した） | 確認日: 2026-11-22 | 対象: 公開登録、メール確認（消した）

## 概要

お客さんの会員登録は、パスワードで作る道をやめて、メールのコードで始める（ログインと同じ入口）に一本化した。このため、公開登録の受付（`POST /api/auth/register`）と、確認のメールのリンクの検証（`GET /api/auth/confirm`）は窓口ごと消えた（404。FR-AUTH-053-AC-01）。登録フォーム（`RegisterModal`）・ログインのモーダル・タブの部品・`schemas/register.ts` も消えた。

今の流れ（メールのコードで始め、8桁のコードで確定する）は [会員向けの画面の処理](auth-passkey-customer-screens.md)が持つ。パスワードで作った確認前のアカウントには、リンクの無い「メールアドレスの確認」のメールが届き、その本文の8桁のコードを入れると確認済みになる（FR-AUTH-054-AC-04）。

## 範囲と根拠

消した図（`SQ-AUTH-REGISTER-PUBLIC`・`SQ-AUTH-REGISTER-CONFIRM`・`SQ-AUTH-REGISTER-RETURN`）は、コードが無いので残さない。決めは [ADR-0469](../../03_BasicDesign/decisions/ADR-0469-passkey-customer-email-code-login.md)、廃止した決めは ADR-0404（登録の応答を同じにする）・ADR-0413（登録した端末への結び付け）にある。要件は [AUTH の要件](../../02_Requirements/areas/auth.md) の SR-AUTH-030・FR-AUTH-053、旧の項目（FR-AUTH-025 ほか）は「廃止」で残してある。

## 未確認事項

- 本番の確認メールの雛形（`confirmation`）を、手元の `supabase/templates/confirmation.html`（リンクを持たず `{{ .Token }}` の8桁を入れさせる文）に替える作業。本番のダッシュボードはオーナーが変える（段4の手順書）。
