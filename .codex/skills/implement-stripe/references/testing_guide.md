# Stripe テスト戦略

## テストカード
| 用途 | 番号 |
|------|------|
| 成功 | 4242 4242 4242 4242 |
| 認証必要(3DS) | 4000 0027 6000 3184 |
| 残高不足 | 4000 0000 0000 9995 |
| 紛争発生 | 4000 0000 0000 0259 |

## stripe-cli
- `stripe listen --forward-to localhost:3000/webhook` でローカル転送
- `stripe trigger checkout.session.completed` でイベント擬似発火
- `stripe fixtures` でシナリオ再現

## Test Clocks
- サブスクの時間進行をシミュレート
- `stripe.test_helpers.test_clocks.TestClock.create(frozen_time=...)`
- 顧客作成時に `test_clock` を紐付け

## E2E チェックリスト
- [ ] テストモードで全フロー成功
- [ ] 3DSチャレンジ通過
- [ ] Webhook受信＆冪等処理
- [ ] サブスク更新・キャンセル
- [ ] 返金フロー
- [ ] 失敗カードの UX