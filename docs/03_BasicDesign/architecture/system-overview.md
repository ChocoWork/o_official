# システム構成（現行実装）

## 概要

確認日: 2026-10-03（「Stripe 非同期処理」の行と「Stripe Webhook の処理」の図は、2026-10-07 に確認し直した。「HTTP ジョブ登録」の行は、照合の登録が抜けていたので足し、同じ日に確認し直した。「外部表示・リンク」の行の UI 見本の画像と、Proxy の CSP の許可先の記述は、2026-10-28 に直した）。対象ソース: `697836a1eb2b62e1a3257ce079ecf8f536e1cb06`（確認し直した行と図は `b54976d2`。「HTTP ジョブ登録」の行は、保留中の SQL 3本を `0781d3ff` で読んで確かめた）。

会計の計画2（2026-11-09）: 「Stripe 非同期処理」の行を18種に直し、worker の後に会計の計上係を流すことを足した。「HTTP Cron」「HTTP ジョブ登録」の行に10分ごとの会計の計上を足した。「Meta KPI」の行の月の KPI の表は S13 で `supabase/migrations/` に定義が入った。末尾に「会計の計上係の流れ」の節を足した。

本書はリポジトリ内で確認した実装と呼び出し経路を示す。ブラウザ、Next.js サーバー、外部サービス、別プロセスの運用スクリプトを区別する。本番配置先、環境変数の値、外部サービスの有効化、適用済み migration、ジョブの稼働は未確認である。

「Stripe の決済・照合」の行は2026-10-07の現行コードで確認し直し、グループ F の入力・最終確認・受付・支払い・入り直しに合わせた。

## システム構成図

矢印は要求・処理の方向を示す（通常の応答は省略）。破線は設定・接続情報または別途ジョブ登録が必要な経路であり、稼働を意味しない。DB キューは Supabase 内の永続化先、worker は Next.js の Route Handler である。

```mermaid
%%{init: {'flowchart': {'nodeSpacing': 30, 'rankSpacing': 40}}}%%
flowchart TB
  Browser["ブラウザ: React UI / Stripe.js"]
  Caller["HTTP Cron 呼び出し元<br/>登録・稼働は未確認"]
  Archive["別プロセス: 保存 CLI"]

  subgraph app["Next.js サーバー"]
    Proxy["Proxy: Origin / CSP / Cookie"]
    Routes["ページ・API・業務サービス<br/>公開 / Auth / 管理・ACL<br/>注文・会計・KPI"]
    Receivers["署名検証: Stripe / Resend 受信"]
    Jobs["Bearer 認証の Cron routes<br/>worker・processor / 決済照合<br/>Meta 同期 / export・status"]
    Proxy --> Routes
    Proxy --> Receivers
    Proxy --> Jobs
  end

  subgraph external["外部サービス"]
    SB["Supabase<br/>Auth / Postgres・RPC・キュー<br/>Storage / pg_cron"]
    Services["外部 API・メール<br/>Stripe / SES・Resend / Meta<br/>Turnstile / HIBP / ZipCloud<br/>設定時: 監査通知 URL"]
    Resources["ブラウザの外部表示・遷移<br/>Google OAuth・Maps / 外部画像<br/>SNS・配送追跡"]
    S3["S3 互換の追加保存先"]
  end

  Browser -->|ページ・API| Proxy
  Browser -->|Stripe.js・Turnstile| Services
  Browser -->|signOut / 画像| SB
  Browser --> Resources
  Caller -.->|Bearer| Proxy
  Archive -->|Bearer: export / status| Proxy
  Archive -->|保存・検証| SB
  Archive -.->|設定時| S3
  Routes -->|Supabase clients| SB
  Routes -->|API 呼び出し・送信| Services
  Receivers -->|キュー・問い合わせ保存| SB
  Jobs -->|RPC・業務データ| SB
  Jobs -.->|API・送信| Services
  Services -->|Stripe / Resend の Webhook| Proxy
  Routes -->|Next Image 画像取得| Resources
  SB -.->|HTTP ジョブ: pending SQL| Proxy
```

外部サービスは機能別にまとめている。各経路の provider 選択・設定条件と実装ソースは後続の表を参照する。署名付きイベントと Cron の処理経路は次の図で示す。

### Stripe Webhook の処理

```mermaid
flowchart TB
  Stripe["Stripe"] -->|署名付き POST| Proxy["Proxy"]
  Proxy --> Receiver["/api/webhook/stripe<br/>raw body の署名検証"]
  Receiver -->|enqueue RPC: 永続化後に応答| Queue["Supabase Postgres<br/>stripe_webhook_events"]
  Caller["Cron 呼び出し元<br/>pending SQL / 稼働未確認"] -.->|Bearer POST| WorkerProxy["Proxy"]
  WorkerProxy --> Worker["/api/cron/process-stripe-webhooks"]
  Worker --> Run["runWebhookWorker<br/>Stripe の知らせ35秒 → 注文のメール10秒<br/>その後に点検 → 配達の見回り"]
  Receiver -->|"応答の後に after() で1回（Cron の入口は介さない）"| Run
  Run -->|claim RPC: 1件ずつ繰り返す・lease| Queue
  Run --> Processor["processStripeWebhookEvent<br/>注文照合・返金同期・会計原始記録同期"]
  Processor -->|現在値を取得| Stripe
  Processor -->|RPC・同期記録| DB["Supabase Postgres / RPC"]
  Processor -.->|注文・店舗通知 / 監査通知| Notify["メール provider / 監査通知 URL"]
  Run -->|complete / fail RPC| Queue
```

### 法定保存の実行境界

```mermaid
flowchart TB
  Dump["提供済みローカル DB dump"] --> CLI["別プロセス: run-daily.ts"]
  CLI -->|Bearer: export / status| API["Next.js Proxy / 保存 Cron API"]
  API -->|読み出し・状態記録| DB["Supabase Postgres / RPC"]
  CLI -->|CSV・dump・manifest / 読み戻し検証| Storage["Supabase Storage<br/>legal-archive bucket"]
  CLI -.->|bucket / region 設定時に追加保存| S3["S3 互換ストレージ"]
```

## 実装の根拠と条件

| 構成・経路 | 確認できる内容・条件 | ソース |
|---|---|---|
| 画面・サーバー | Next.js / React の依存、App Router ページ、同一 origin API 呼び出し。Proxy の入口処理と認証判定は別 | [package.json](../../../package.json)、[トップページ](../../../src/app/page.tsx)、[LoginContext](../../../src/contexts/LoginContext.tsx)、[Proxy](../../../src/proxy.ts) |
| Supabase クライアント | サーバーの匿名・利用者 JWT・service role と、ブラウザの公開キー用クライアント。ブラウザ SDK の確認済み呼び出しはログアウト | [server.ts](../../../src/lib/supabase/server.ts)、[client.ts](../../../src/lib/supabase/client.ts)、[LoginContext](../../../src/contexts/LoginContext.tsx) |
| Auth / Google OAuth | パスワード、メール OTP、TOTP、Google OAuth 開始・コード交換。Auth の OTP 配送設定はアプリのメール送信 provider から判断できない | [login](../../../src/app/api/auth/login/route.ts)、[OTP](../../../src/app/api/auth/otp/verify/route.ts)、[MFA](../../../src/app/api/auth/mfa/verify/route.ts)、[OAuth開始](../../../src/app/api/auth/oauth/start/route.ts)、[callback](../../../src/app/api/auth/oauth/callback/route.ts) |
| Stripe の決済・照合 | 入力画面の「確認へ進む」でサーバーがSessionを作り、最終確認画面のFinalConfirmationStepにCheckoutProvider / PaymentElementを置く。「注文する」でplace-orderが注文・在庫を確保した後に支払い、completeがStripe現在値で照合する。開き直しはresumeを照会。Session失効時のcreate-session（custom）・place-orderも共通照合器を呼ぶ | [checkout UI](../../../src/app/checkout/page.tsx)、[最終確認画面](../../../src/app/checkout/_components/FinalConfirmationStep.tsx)、[create-session](../../../src/app/api/checkout/create-session/route.ts)、[place-order](../../../src/app/api/checkout/place-order/route.ts)、[resume](../../../src/app/api/checkout/resume/route.ts)、[照合](../../../src/lib/stripe/checkout-payment-reconciler.ts)、[現在値取得](../../../src/lib/stripe/checkout-payment-reader.ts) |
| Stripe 非同期処理 | 署名検証後、18種（既存の13種と `charge.dispute.*` の5種。Stripe の宛先に足すまで dispute の知らせは届かない）のイベントだけを DB 永続化する（鍵と違うモードの知らせは保存しない）。応答の後に `after()` で worker を1回動かし、毎分の Cron 呼び出しも同じ worker を起動する。worker は、取り出せる Stripe の知らせが無くなるか35秒たつまで、1件ずつ claim して注文・返金・会計を同期し、完了 / 失敗を記録する。続いて、処理した知らせがあった時だけ会計の計上係を1回（20件）流し（失敗しても worker は失敗にしない）、注文のメールを10秒の予算で送り、その後に店への知らせの点検と配達の見回りを行う（入口の実行上限は60秒）。DB RPC が重複排除・lease・再試行（9回目の失敗で退避）を管理 | [入口](../../../src/app/api/webhook/stripe/route.ts)、[worker](../../../src/app/api/cron/process-stripe-webhooks/route.ts)、[繰り返し](../../../src/lib/stripe/webhook-drain.ts)、[processor](../../../src/lib/stripe/webhook-processor.ts)、[キュー migration](../../../supabase/migrations/20260925000303_add_stripe_webhook_queue.sql)、[退避 migration](../../../supabase/migrations/20261007030242_webhook_queue_dead_letter.sql) |
| メール | `MAIL_PROVIDER` による SES / Resend 選択（未指定時のコード上の既定は SES）。問い合わせの Resend / Svix 受信経路は別 | [送信選択](../../../src/lib/mail.ts)、[SES](../../../src/lib/mail/adapters/ses.ts)、[Resend](../../../src/lib/mail/adapters/resend.ts)、[受信](../../../src/app/api/contact/inbound/route.ts) |
| Meta KPI | OAuth 接続、手動 / Cron の Graph API 同期。アプリ設定・暗号化鍵・保存済み接続が必要。月の KPI の表 `admin_kpi_monthly_records` は 2026-11-08 の S13（`20261108220000`）が `supabase/migrations/` で定義する（旧 `migrations/063` の食い違いを解消。本番は未適用）。Meta の接続・同期記録の表（`admin_meta_kpi_connections`・`admin_meta_kpi_sync_runs`）の DDL は旧 `migrations/` にだけあり、現行 `supabase/migrations/` での定義は確認できない（実 DB の有無は未確認。作るかはオーナーが決める） | [config](../../../src/lib/meta/config.ts)、[接続](../../../src/app/api/admin/kpi/meta/connect/route.ts)、[callback](../../../src/app/api/admin/kpi/meta/callback/route.ts)、[手動同期](../../../src/app/api/admin/kpi/meta/sync/route.ts)、[同期](../../../src/lib/meta/sync-kpi.ts)、[Graph client](../../../src/lib/meta/graph-client.ts)、[旧 KPI DDL](../../../migrations/063_create_admin_kpi_monthly_records.sql)、[旧 Meta DDL](../../../migrations/079_create_meta_kpi_integration.sql) |
| Bot・漏洩・住所検査 | Turnstile widget と siteverify（production で secret 未設定なら拒否）。HIBP へ SHA-1 の先頭5文字を送信。ZipCloud は郵便番号の DB / プロセス内キャッシュにない場合に照会 | [LoginModal](../../../src/components/LoginModal.tsx)、[Turnstile](../../../src/lib/turnstile.ts)、[登録 API](../../../src/app/api/auth/register/route.ts)、[HIBP](../../../src/lib/pwned-password.ts)、[郵便番号 API](../../../src/app/api/checkout/postal-code/route.ts)、[住所検索](../../../src/features/checkout/services/postal-code.service.ts) |
| Storage | 商品・NEWS・LOOK画像、`finance-receipts` の証憑保存・署名 URL 発行 | [商品画像](../../../src/app/api/admin/items/route.ts)、[NEWS画像](../../../src/lib/storage/news-images.ts)、[LOOK画像](../../../src/app/api/admin/looks/route.ts)、[証憑](../../../src/app/api/admin/kpi/cost-profit/receipt/route.ts) |
| 法定保存 | API は export / status のみ。別プロセスの CLI が CSV・既存 DB dump・manifest を Supabase Storage に保存し、S3 bucket / region 設定時は追加保存。この CLI に DB dump 生成処理はない | [run-daily](../../../scripts/legal-archive/run-daily.ts)、[export](../../../src/app/api/cron/legal-archive/export/route.ts)、[status](../../../src/app/api/cron/legal-archive/status/route.ts)、[Supabase保存](../../../src/lib/legal-archive/supabase-storage.ts)、[S3保存](../../../src/lib/legal-archive/s3-storage.ts)、[保存・検証](../../../src/lib/legal-archive/storage.ts) |
| 監査・rate limit | 監査は DB 保存、`ALERT_AUDIT_URL` 設定時はマスク済み記録を POST。rate limit は DB カウンター | [audit](../../../src/lib/audit.ts)、[rateLimit](../../../src/features/auth/middleware/rateLimit.ts)、[DBカウンター](../../../src/features/auth/ratelimit/index.ts) |
| 外部表示・リンク | Google Maps iframe / 検索、UI 見本の画像（2026-10-28 に readdy.ai から `public/` の手元の画像へ替えた）、SNS・配送追跡リンク。Next Image の許可先には placehold.co / readdy.ai / Supabase がある。許可設定だけでは実際のアクセスを意味しない | [MapView](../../../src/components/ui/MapView/MapView.tsx)、[取扱店](../../../src/features/stockist/components/PublicStockistGrid.tsx)、[UI見本](../../../src/app/ui/page.tsx)、[共有](../../../src/components/ShareButtons.tsx)、[SNS](../../../src/lib/social.ts)、[配送](../../../src/lib/orders/shipping-carriers.ts)、[画像設定](../../../next.config.ts) |

## 要求・認可の境界

- Proxy は `/api` の POST / PUT / PATCH / DELETE で Origin / Referer を検査し、CSP 等を付与する。`/api/webhook`、`/api/contact/inbound`、`/api/cron` は除外対象で、各入口の署名または Bearer 検証を使用する。CSP の許可先は自分のプロジェクトの Supabase・Stripe（全頁）・Turnstile・地図の枠だけで、jsDelivr・placehold.co・readdy.ai・`*.supabase.co` は許さない（2026-10-28、[ADR-0108](../decisions/ADR-0108-csp-own-project-stripe-turnstile-only.md)）。[Proxy](../../../src/proxy.ts)
- 認証の共通処理は Cookie / Bearer の JWT を `getClaims` で検証し、issuer / audience と `is_auth_session_active` RPC を確認する。管理権限の共通処理は DB の ACL と JWT の AAL2 を追加確認する。公開 API もあるため全要求へのログイン必須を意味しない。[認証](../../../src/lib/auth/authenticate.ts)、[RBAC](../../../src/lib/auth/admin-rbac.ts)、[公開商品API](../../../src/app/api/items/route.ts)
- service role の処理と利用者 JWT の処理はクライアントが分かれる。認可条件は Route Handler と共通関数で確認する。[クライアント生成](../../../src/lib/supabase/server.ts)、[証憑API](../../../src/app/api/admin/kpi/cost-profit/receipt/route.ts)

## ジョブ・配置と確認範囲

| 対象 | リポジトリの定義 | 未確認事項 |
|---|---|---|
| HTTP Cron | `CRON_SECRET`: [worker](../../../src/app/api/cron/process-stripe-webhooks/route.ts)、[注文見回り](../../../src/app/api/cron/expire-pending-orders/route.ts)、[Stripe照合](../../../src/app/api/cron/stripe-reconcile/route.ts)、[会計の計上](../../../src/app/api/cron/accounting-post/route.ts)、[Meta同期](../../../src/app/api/cron/meta-kpi-sync/route.ts)。保存 export / status は `LEGAL_ARCHIVE_CRON_SECRET` | 呼び出し基盤・設定値・実行結果 |
| HTTP ジョブ登録 | [worker pending SQL](../../../supabase/pending/schedule_stripe_webhook_worker.sql): 毎分（`* * * * *`）。受け取り口も保存の後に worker を1回動かすので、毎分の起動は取りこぼしを拾う役目。[注文見回り pending SQL](../../../supabase/pending/schedule_expire_pending_orders.sql): 毎時。[Stripe 照合 pending SQL](../../../supabase/pending/schedule_stripe_reconcile.sql): 毎日 18:00 UTC（`0 18 * * *`）、POST。[会計の計上 pending SQL](../../../supabase/pending/schedule_accounting_post.sql): 10分ごと（`*/10 * * * *`）、POST。いずれも pg_cron / pg_net / Vault を使用。pending SQL は開店のときに `supabase/pending/` から当てる（[手順書](../../06_Operations/webhook-queue-operations.md)の1） | pending SQL の適用・登録。ファイルの存在は適用済みの証明ではない |
| DB 内ジョブ | migration の [未完了 draft 保持期限処理](../../../supabase/migrations/20260911235714_add_checkout_drafts_retention_job.sql)、[rate limit 保持期限処理](../../../supabase/migrations/20260913132437_add_rate_limit_counters_retention_job.sql) | migration の適用・ジョブ稼働 |
| 保存・復元確認 | [package.json](../../../package.json) の保存 / 復元確認コマンド。[verify-restore](../../../scripts/legal-archive/verify-restore.ts) は提供済みファイルと復元先 Postgres を照合 | 実行基盤・dump 作成元・復元の実施 |
| ビルド・配置 | 開発 / ビルド / 起動コマンド、[READMEのVercel手順](../../../README.md)、[layoutのnext/font/google](../../../src/app/layout.tsx) | 現在の配置先・ドメイン・リージョン・ビルド時の外部取得結果 |
| DB CI | [db-migrations.yml](../../../.github/workflows/db-migrations.yml): PR で `db push --dry-run`、対象 push / 手動実行で `db push`。対象は `supabase/migrations/` | GitHub Secrets・実行履歴・対象 DB・適用済み migration |

[Redis REST アダプタ](../../../src/lib/cache/redis-cache.ts) は存在するが、確認時点の `src/` に呼び出し元がないため稼働経路の図には含めていない。[Supabase ローカル設定](../../../supabase/config.toml) の Realtime / Studio / ローカル SMTP 等も、本番でのアプリ連携・稼働の根拠とはしていない。

関連: [ER図](../data/er.md)、[API一覧](../api/api-spec.md)、[認証シーケンス](../../04_DetailDesign/sequence/auth-login-mfa.md)、[注文・決済の状態](../../04_DetailDesign/states/order-payment.md)。


## 会計の計上係の流れ

確認日: 2026-11-09（会計の計画2）。仕訳は、支払い・出荷・Stripe・dispute の出来事ごとに、DB の1つの入口 `public.accounting_run_posting`（`service_role` だけ）が入れる。アプリは `runAccountingPosting`（[posting-runner.ts](../../../src/lib/accounting/posting-runner.ts)）で50件ずつ、`hasMore` が偽になるまで最大20回呼ぶ。呼ぶ場所は次の4か所に、画面の手動の1か所を足した5経路。詳細は[計上係のシーケンス](../../04_DetailDesign/sequence/accounting-posting.md)、運用は[会計の運用](../../06_Operations/accounting-p2-posting-stripe.md)。

```mermaid
flowchart TB
  W["Webhook の worker<br/>処理した知らせがある時だけ・20件・1回"] --> Run
  O["画面の操作の後（after）<br/>発送票の確定・取り消し・出荷日の直し・着金の確認"] --> Run
  N["毎晩の照合 stripe-reconcile の最後"] --> Run
  C["10分ごとの定期処理 /api/cron/accounting-post<br/>最後の成功を ops_job_heartbeats に残す"] --> Run
  M["計上待ちの『もう一度計上する』<br/>POST /api/admin/accounting/posting/run"] --> Run
  Run["runAccountingPosting（50件ずつ・最大20回）"] --> RPC["public.accounting_run_posting<br/>（INVOKER・service_role だけ）"]
  RPC --> P1["支払い accounting_post_payment_events"]
  P1 --> P2["出荷 accounting_post_shipment_events"]
  P2 --> P3["Stripe accounting_post_stripe_events<br/>手数料→税額→入金→着金→入金の失敗"]
  P3 --> P4["dispute accounting_post_dispute_events<br/>W→R→C→L"]
  P1 & P2 & P3 & P4 --> Core["accounting_post_journal_core（計画1）"]
  P1 & P2 & P3 & P4 -.->|出来事1件の失敗| Park["accounting_pending_events<br/>理由つきの保留"]
```

| 論点 | 内容 |
| --- | --- |
| 鍵の順 | 計上係も G の書き手も同じ順: `(190521, 1)`（G の鍵）→ `(190525, 0)` → `(190525, hashtext(期間))`。全部の係は最初に `private.accounting_lock_all(NULL)` を取り、行の鍵は取らない。G の確定・取り消しの関数は、鍵の中で番号 `fact_seq` を取って事実を書く（番号の順がコミットの順） |
| 同時に動いた時 | 2か所から同時に流しても、鍵で1つずつ。後のものは待つ。同じ出来事は印で1本になる。測った待ち（記録のみ）: 引かれた取引20件を待たせた計上が約45〜80ミリ秒、その間の G の書き手の待ちが約40〜70ミリ秒 |
| 失敗の扱い | 出来事1件ごとに別の枠。失敗は戻して保留（`accounting_pending_events`）に残し、ほかは続ける。保留した行は次の呼び出しで最大10件まで見直す。生の例外の文は残さない |
| 呼び出し元の失敗 | 画面と worker は、計上の失敗で自分の応答や知らせの処理を失敗にしない（ログに入口の名前と記号だけ）。取りこぼしは10分ごとの定期処理が拾う |
| 公開の入口 | `public.accounting_run_posting` ただ1つ。各係は `private.*` で、入口を持たない（EXECUTE は所有者だけ） |
