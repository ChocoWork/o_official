# Code Review: contact (additional)
**Ready for Production**: No
**Critical Issues**: 0

## Priority 2 (Should Fix)

- `src/app/api/contact/route.ts`: `request.json()` をそのまま実行しており、本文サイズ上限チェックが未実装。大きなリクエストによるメモリ圧迫リスクがある。
- `src/app/api/contact/route.ts`: 監査ログ用 `email_hash` がソルトなし SHA-256。辞書攻撃で再識別されるリスクがある。
- `src/lib/turnstile.ts`: Turnstile 検証でタイムアウト未設定、`success` 以外の検証（`hostname`/`action`）なし。

## Priority 3 (Nice to Have)

- `src/app/api/contact/route.ts`: `CONTACT_TO_EMAIL` 未設定時に `SES_FROM_ADDRESS` / `MAIL_FROM_ADDRESS` を宛先にフォールバックする設計。運用ミス時の誤送信リスクがある。
- `src/app/api/contact/route.ts`: `console.warn(..., mailError)` で送信基盤エラー詳細をログ出力。運用ログの閲覧範囲次第で情報露出の可能性がある。

## Recommended Changes

1. 本文サイズ上限を導入し、上限超過は `413 Payload Too Large` を返す。
2. `email_hash` は HMAC-SHA256（secret pepper 使用）へ変更するか、不要なら保存を中止する。
3. Turnstile 検証は `AbortController` でタイムアウトを設定し、`hostname`/`action` の照合を追加する。
4. 宛先は `CONTACT_TO_EMAIL` のみ許可し、未設定時は送信しない。
5. メール失敗ログはエラーコード中心に最小化し、詳細スタックは保護された監視基盤へ限定する。