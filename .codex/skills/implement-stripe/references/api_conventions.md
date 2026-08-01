# Stripe API 利用規約チェックリスト

## APIバージョン
- 必ず固定（`stripe.api_version = "YYYY-MM-DD.codename"`）
- アップグレードは Dashboard → Developers → API version で段階移行

## 冪等性
- すべての書き込みリクエストに `Idempotency-Key`
- キーは UUIDv4。**24時間**有効。同一キーで同一レスポンス再生

## ページング
- `limit` 最大100、`starting_after`/`ending_before` でカーソル送り
- `has_more` を必ず確認

## レート制限
- 標準: read 100rps / write 100rps（テストはより低い）
- 429 は **指数バックオフ + jitter** で再試行
- `Retry-After` ヘッダがあれば優先

## エラー分類
| Type | Retry? | 対応 |
|------|--------|------|
| `card_error` | No | ユーザーに再入力を促す |
| `invalid_request_error` | No | 実装バグ。ログして修正 |
| `api_error` | Yes | バックオフ再試行 |
| `rate_limit_error` | Yes | バックオフ |
| `authentication_error` | No | キー再設定 |

## 通貨と金額
- すべて **最小通貨単位の整数**（USDなら cents、JPYは整数円のまま）
- ゼロ十進通貨（JPY等）の罠に注意

## メタデータ
- 50キー、各キー40字、値500字まで
- 内部ID紐付けに必須（例: `metadata.user_id`）