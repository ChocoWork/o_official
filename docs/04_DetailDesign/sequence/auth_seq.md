# 認証シーケンスの案内

> 状態: 現行文書への案内 | 確認日: 2026-10-04 | 対象: 従来の `01_auth_seq.md` の参照先

## 概要

従来の1つの図には、現行実装と異なる登録応答、パスワードだけでのログイン完了、自前OAuth連携、未実装のrefresh再利用検出等が含まれていた。このパスはリンクを維持する案内に改め、現在のシナリオを目的別に分けて記述する。以前の設計案はGit履歴で参照できる。

## 現行の認証設計

| 目的 | 正本 |
| --- | --- |
| 登録と確認メール | [会員登録・確認](auth-registration.md) |
| パスワードとメールOTP、特権TOTP | [ログイン・追加認証](auth-login-mfa.md) |
| Google OAuth | [OAuth](auth-oauth.md) |
| パスワード再設定 | [再設定](auth-password-reset.md) |
| 初期認証状態の照会、refresh、logout、管理API認可 | [セッション・認可](auth-session.md) |
| 図の分割・フォーマット | [シーケンス設計の方針](README.md) |

## 同期時に訂正した前提

- 公開登録の通常応答は202。201は管理者作成・signupがセッションを返す場合の条件付き経路。
- メール・パスワードが正しいだけでは正式な認証Cookieを発行せず、メールOTP確認を挟む。
- 確認メールのtokenはpublic clientのverifyOtpで検証し、成功・失敗のどちらも検証済み戻り先へ303を返す経路がある。
- Google OAuthはSupabaseのPKCE対応SSR clientを使う。旧図の独自stateテーブルやアカウントlink APIを現行実装として扱わない。
- 再設定tokenは10分。link確認では消費せず、署名Cookieを使うconfirmで使用済みをclaimしてから更新する。
- refreshはSupabaseとの交換とlocal sessionsの監査記録を行う。列が存在するだけでcurrent_jti再利用検出や同時端末上限を実装済みとしない。
- logoutの正常応答は200 JSON。監査記録はaudit_logsと任意のalert webhookであり、JSON Lines保存ではない。

根拠は上表の現行文書に、Route Handler・共通サービス・関連テストへの相対リンクとしてまとめる。

## 未確認事項

Supabaseの実際のtoken寿命、メール確認設定、OAuth設定、既存セッションの実データと失効結果は今回実行確認していない。
