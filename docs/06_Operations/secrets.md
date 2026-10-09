---
title: シークレット管理方針
---

# シークレット管理方針（暫定: 手動運用）

> 状態: 既存の運用方針 | 本番設定・手順の適用状況は未確認 | 確認日: 2026-10-02

この文書中の `docs/seq/supabase-service-role-key-rotation-diagrams.md` は現行リポジトリに存在しない旧計画への参照である。自動ローテーションを実施済みとは扱わず、実施前に現在の秘密値の保管場所、権限、手順を確認する。
## 概要

このドキュメントは `SUPABASE_SERVICE_ROLE_KEY` 等の運用上重要なシークレットの**初期運用手順（手動）**を定めます。事業成長に合わせて自動ローテーション（`docs/seq/supabase-service-role-key-rotation-diagrams.md`）へ移行する計画です。

## 適用範囲

- SUPABASE_SERVICE_ROLE_KEY
- JWT_SECRET（アプリの共通鍵）
- AWS_SES_* 等送信に必要なシークレット

## 初期（手動）運用プロセス

1. 発行・変更
   - シークレットの発行は運用担当（Ops）または認可された管理者が行う。
   - 新しいキーを発行したら、Secrets Manager（または Vercel/環境に応じた安全なストア）に手動で登録する。
2. 公開手順
   - 登録後、デプロイ手順（CI）を通じてアプリに反映する。手順書を `docs/06_Operations/secrets-rotation.md` に記載する。
3. 承認と記録
   - すべてのローテーション操作は PR ではなく運用チケット（Ops のチケットトラッカー）で記録し、少なくとも 1 名の別人による承認を得ること。
   - 変更時には監査ログを記録（who/when/why）する。`src/lib/audit.ts` に該当イベントを吐くことを推奨。
4. 検証
   - 新キー適用後は影響範囲の smoke tests（簡単なヘルスチェック）を実行し、問題がないことを確認する。
5. ロールバック
   - 問題発生時は直ちに旧キーへロールバックする手順を実行し、影響を最小化する。詳細は `docs/06_Operations/secrets-rotation.md` に記載。

## セキュリティ注意点

- シークレットは平文で保存しない。コミット禁止（`.gitignore` 有効）。
- 誰がアクセスできるかは最小権限の原則に従い、必要な人のみアクセスを許可する。
- 漏洩疑いがある場合は即座に暫定値を投入し、緊急ローテーションフローを開始する（`docs/seq/supabase-service-role-key-rotation-diagrams.md` を参照）。

## 将来的な自動化（移行計画）

- 事業拡大に伴い、`docs/seq/supabase-service-role-key-rotation-diagrams.md` に記載された自動ローテーションフローを採用する予定です。
- 自動化のための TODO:
  - CI/CD の secret rotation playbook の用意（`.github/workflows/rotate-secrets.yml`）
  - 確認テスト自動化（デプロイ直後の smoke tests）
  - 監査・アラートの自動化（CloudTrail / SNS 通知）

---
*作成: SDD Agent (追記) — 現行は手動運用、将来的に自動運用へ移行予定*

## Stripe注文同期

Stripe Webhookは `${APP_BASE_URL}/api/webhook/stripe` に設定し、署名シークレットを
`STRIPE_WEBHOOK_SECRET` としてサーバー環境だけに保存します。受け取り口が保存する次の13種（`src/lib/stripe/handled-webhook-events.ts`）を購読します。ほかの種類は保存しません。本番の鍵のアプリには本番の宛先、テストの鍵のアプリにはテストの宛先をつなぎます（食い違うと処理せず、店へ知らせます）。

| イベント | 用途 |
| --- | --- |
| `checkout.session.completed` | Checkout Session の現在値を照合し、注文・決済状態へ反映する |
| `checkout.session.async_payment_succeeded` | 時間差決済の現在値を照合し、注文・決済状態へ反映する |
| `checkout.session.async_payment_failed` | 時間差決済の現在値を照合し、注文・在庫へ反映する |
| `checkout.session.expired` | 期限切れ Session を照合し、注文・在庫へ反映する |
| `payment_intent.succeeded` | PaymentIntent を照合し、注文・決済状態と会計記録へ反映する |
| `payment_intent.payment_failed` | PaymentIntent の現在値を照合し、注文・在庫へ反映する |
| `refund.created` | 返金を注文へ反映し、返金の会計記録を同期する。注文が無い場合は監査に残し、失敗・取消なら要対応にして店へ知らせる |
| `refund.updated` | 返金状態を注文へ反映し、返金の会計記録を同期する。注文が無い失敗・取消は要対応にして店へ知らせる |
| `refund.failed` | 失敗返金を注文へ反映し、返金の会計記録を同期する。注文が無ければ要対応にして店へ知らせる |
| `charge.refunded` | Charge の返金を注文へ反映する。注文が無い場合は監査に残して処理を続ける |
| `payout.paid` | Stripe の Payout を会計記録へ同期する |
| `payout.failed` | Payout の失敗を会計記録へ同期する |
| `payout.reconciliation_completed` | Payout の照合結果を会計記録へ同期する |

返金の `refund.*` 購読が無いと、注文の無い失敗・取消返金が要対応として記録されず、店への通知も行われません。

定期照合は毎日 18:00 UTC（日本時間 3:00）に pg_cron＋pg_net が `POST /api/cron/stripe-reconcile` を呼び出し、`Authorization: Bearer
${CRON_SECRET}` を付与します。Stripeだけに存在する未返金の成功決済は報告対象になり、照合では注文を作りません
（注文の無い支払いのうち、直近24時間に作られた Checkout Session のものだけを、毎時の見回りが拾います。それより古いものは見回りでは拾いません。照合は、直近7日の注文の無い成功の支払い（全額返金済みを除く）と、支払い・入金ごとの失敗を、見つかった夜だけ、1回の実行につき1通のメール（宛先は `SHOP_ALERT_EMAIL`）で店へ知らせます。7日より古い支払いは、照合の結果の `unmatchedPayments` の件数にだけ入ります）。既存注文との返金額差分だけをStripeの成功済み返金から修復します。

## RESEND_DELIVERY_WEBHOOK_SECRET

Resend の配達の状態の知らせ（`POST /api/webhook/resend-delivery`）の Svix 署名の鍵です（`whsec_` で始まる）。お問い合わせの返信の `RESEND_WEBHOOK_SECRET` とは別の宛先・別の鍵にします。Vercel の環境変数にだけ置きます。入れ替えは[注文のメールの手順書](order-email-operations.md)の4に従います。

本番の注文のメールは `MAIL_PROVIDER` に `resend`（小文字）を入れた時だけ送ります（ほかの送り手では送信を止めます）。`resend` は送り手を選ぶ値で秘密ではありません。`resolveMailProvider` は大文字小文字まで完全一致で見るため、`Resend` と入れると全部止まり、店への知らせも届きません。`RESEND_API_KEY` は Full access にします（送信専用の鍵だと、1時間ごとの配達の見回りが動きません）。

## CRON_SECRET

定期処理の入口（worker・見回り・照合・Meta の同期）の合言葉です。32文字以上のランダムな値にします。短いと全部の入口が設定の誤りとして断ります。Vercel の環境変数と、本番 DB の Vault（`cron_secret`）にだけ置きます。入れ替えは[手順書](webhook-queue-operations.md)の2に従います。

## APP_ALLOWED_ORIGINS

状態変更 API（`/api/auth` `/api/admin` `/api/cart` `/api/checkout/*` `/api/wishlist`）の
CSRF 対策で、`Origin` / `Referer` を照合する許可オリジンの一覧。カンマ区切り。

```
APP_ALLOWED_ORIGINS=https://www.example.com,https://example.com
```

未設定でも `NEXT_PUBLIC_SITE_URL` / `NEXT_PUBLIC_BASE_URL` / `BASE_URL` /
`NEXT_PUBLIC_VERCEL_URL` のいずれかがあればそれを使う。どれも無い場合は
リクエスト由来のオリジンとの一致で判定し、警告を出す（設定漏れだけで全 API が
403 になるのを避けるため）。**本番では必ず明示すること。**

同じ一覧を `getRequestOrigin`（リダイレクト先の検証）も使う。片方だけ設定する、
という状態は作らないこと。
