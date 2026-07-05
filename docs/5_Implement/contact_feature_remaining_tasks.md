# Contact 問い合わせ機能 — 残タスク（Resend 受信メール設定）

## 現在の状態（2026-07-01 時点）

問い合わせ〜返信機能（スレッド管理 / MANAGE 返信＋テンプレート / Account チャット / 注文確認メール）は実装・デプロイ可能な状態。DB マイグレーションも本番へ適用済み。

- ✅ マイグレーション **057 / 058 / 059** を本番 Supabase（`pjidrgofvaglnuuznnyj` = Le Fil des Heures アパレルEC）へ適用済み
  - `contact_inquiries` 拡張（status / user_id / order_id / updated_at / last_message_at）
  - `contact_messages` 新規（既存24件は初回メッセージをバックフィル済み）
  - `contact_reply_templates` 新規（既定テンプレ2件）
  - 権限 `admin.contact.read` / `admin.contact.manage` を admin・supporter に付与
- ✅ サイト内チャット（MANAGE の CONTACT タブ / Account の「お問い合わせ」タブ）は稼働可能
- ✅ 送信メール（顧客への確認メール・管理者返信メール・注文確認メール）は稼働可能
  - 現状 `MAIL_FROM_ADDRESS=onboarding@resend.dev`（Resend テスト用）でも送信自体は可能

## Resend ドメイン設定（完了）

- ✅ ドメイン **`mail.lefildesheures.com`** を Resend に作成（送信+受信 有効、region us-east-1、ID `68253fd2-845d-447b-84ed-a5f69e628534`）
- ✅ Porkbun に DNS 4件（DKIM TXT / 送信SPF MX・TXT / 受信MX）を追加し、**Resend で verified**
- ✅ `.env.local`: `MAIL_FROM_ADDRESS=no-reply@mail.lefildesheures.com`、`CONTACT_INBOUND_DOMAIN=mail.lefildesheures.com`、`CONTACT_REPLY_SECRET`（生成済み）を設定

## 残タスク：inbound Webhook（デプロイ後）

ゲストのメール返信取り込みを有効化する最後の1ステップ。**本番デプロイURLが必要なため保留**。

### 1. Resend Webhook 作成
- イベント `email.received` を **本番URL** `https://<本番ドメイン>/api/contact/inbound` に配信する Webhook を作成（`create-webhook`）。
- 作成時に得られる **署名シークレット（whsec_…）を `RESEND_WEBHOOK_SECRET` に設定**。

### 2. 本番環境変数（Vercel 等ホスティング）
`.env.local` と同じ値を本番にも設定する。特に:
| 変数 | 値 | 用途 |
| --- | --- | --- |
| `CONTACT_INBOUND_DOMAIN` | `mail.lefildesheures.com` | 返信アドレス `reply+{id}.{token}@<domain>` の生成 |
| `CONTACT_REPLY_SECRET` | `.env.local` と同一値（**コミット禁止**） | 返信アドレスの HMAC 署名 |
| `RESEND_WEBHOOK_SECRET` | Resend Webhook の署名シークレット | inbound Webhook の Svix 署名検証 |
| `MAIL_FROM_ADDRESS` | `no-reply@mail.lefildesheures.com` | 送信元 |

> ⚠️ シークレット値はドキュメントにコミットしない。環境変数（ホスティングの Secrets / `.env.local`）にのみ設定する。

## 動作条件のまとめ

- 上記 1〜4 が未設定でも、**サイト内チャット・確認/返信/注文確認メールの送信は動作**する（`buildReplyAddress` は env 未設定時に Reply-To を付けずに graceful に送信）。
- inbound 取り込みと Reply-To スレッド相関は、上記の設定が揃って初めて有効になる。
- 設定後の確認: ゲストが確認メールに返信 → `/api/contact/inbound` が 200 → MANAGE の該当スレッドに `channel=email` メッセージが追加されること。

## 関連ファイル
- 受信 Webhook: `src/app/api/contact/inbound/route.ts`
- 返信アドレス生成/検証: `src/lib/contact/reply-address.ts`
- 送信メール: `src/app/api/contact/route.ts`（確認）/ `src/app/api/admin/contact/[id]/reply/route.ts`（返信）/ `src/lib/orders/order-confirmation-email.ts`（注文確認）
