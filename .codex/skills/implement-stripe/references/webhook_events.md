# 主要 Webhook イベント処理パターン

## 課金完了系
- `checkout.session.completed` — 一回限りの provisioning トリガー
- `invoice.paid` — サブスク継続課金成功。延長処理
- `invoice.payment_failed` — Dunning 開始

## サブスクライフサイクル
- `customer.subscription.created`
- `customer.subscription.updated` — `previous_attributes` で差分検出
- `customer.subscription.deleted` — アクセス剥奪
- `customer.subscription.trial_will_end` — 3日前通知

## 紛争・返金
- `charge.dispute.created` — 即対応必須（証拠提出期限あり）
- `charge.refunded`

## 設計原則
1. Webhook ハンドラは **イベント種別→ディスパッチャ** 構造
2. ビジネスロジックは別関数に分離（テスタブル化）
3. `event.created` をDBに保存し、**out-of-orderイベント**を検知
4. 重要イベントは別途 **Stripe API でstate再取得**（webhookは通知、真実はAPI）