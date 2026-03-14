---
status: todo
id: CHECKOUT-01
title: チェックアウトフローと Stripe 統合
priority: high
estimate: 3d
assignee: unassigned
dependencies: [CART-01]
created: 2026-01-17
updated: 2026-03-13
---

# 概要

ゲストおよび会員向けのチェックアウトフローを実装し、Stripe で決済を行う。Webhook の署名検証と冪等性処理を含む。

# 詳細

- エンドポイント: `POST /api/checkout/create-session`, `POST /api/checkout/complete`, `POST /api/webhook/stripe`
- Webhook は `STRIPE_WEBHOOK_SECRET` による署名検証、イベントは永続化キューで処理し冪等性を担保する。

# 受け入れ条件

1. Stripe セッション作成から支払完了後に注文が `paid` で保存される。
2. Webhook の署名検証に失敗したイベントは 400 を返す。
3. 重複イベントに対して冪等に処理される。

# 実装ノート

- 金額はサーバ側で再計算し最小単位（整数）で扱う。
- Webhook は先に永続化してワーカーで処理するパターンを採用。

# 依存関係

- Stripe, メール送信サービス

# チェックリスト

- [ ] Stripe セッション作成実装
- [x] Stripe Payment Element + PaymentIntent 初期化API実装
- [x] `POST /api/checkout/complete` 実装（カード/銀行振込/代金引換）
- [x] Webhook 受信と署名検証
- [x] 注文確定ロジック（orders / order_items 保存、カートクリア）
- [x] 郵便番号入力時の住所自動補完を同一オリジンAPI経由へ変更（CSP制約回避）
- [x] 郵便番号住所検索を Supabase DB 一次ソース + Redis 任意キャッシュ構成へ変更

## Stripe Payment Element ベストプラクティス

- [ ] Payment Element のレイアウトを Accordion で表示し、複数支払い方法を切り替えられる UI にする
- [ ] Appearance API で Payment Element の見た目をブランドに合わせてカスタマイズする
- [ ] Checkout Sessions API を使った決済フローに切り替え（サーバー側でセッションを作成し、クライアントはセッションへリダイレクト）
- [ ] セッション／PaymentIntent に `metadata`（注文ID、カートID 等）を渡して Stripe ダッシュボードで検索できるようにする
- [ ] Dynamic Payment Methods を利用し、Stripe による支払い方法の最適表示を有効化する
- [ ] Stripe API バージョンが最新であることを確認し、必要であれば `stripe` SDK をアップデートする
- [ ] Payment Element が iframe 内に埋め込まれないようにし、リダイレクトを伴う支払い方法でも正常に動作することを確認する
- [ ] Dashboard の「支払い方法の設定」画面で表示される支払い方法を確認し、必要に応じて Payment Method Rules でカスタマイズする
