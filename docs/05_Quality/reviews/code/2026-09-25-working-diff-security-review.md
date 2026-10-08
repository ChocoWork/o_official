# 2026-09-25 変更差分の決済・セキュリティレビュー

## 概要

作業ツリーの変更差分と注文・Stripe・Supabaseの周辺経路を対象にした指摘台帳。指摘は実コードと一次資料で確認してから追加し、修正後も検証結果を追記する。以下は2026-09-25時点で未修正。レビューのみを行い、決済や本番DBの状態変更はしていない。R-01〜R-14 は1回目（Codex）、R-15 以降は2回目（Claude Code、[追加レビュー](#追加レビュー2回目claude-code)）の指摘。2回目では R-11 の重大度を訂正した。

| ID | 優先度 | 状態 | 指摘 |
| --- | --- | --- | --- |
| R-01 | P1 | 未修正 | 非同期決済の成功・失敗イベントを注文未作成でも完了扱いにする |
| R-02 | P1 | 未修正 | 決済の試行失敗で注文と在庫を最終失敗へ遷移させる |
| R-03 | P1 | 未修正 | 返金の冪等キーが返金操作単位でなく注文IDと金額だけで決まる |
| R-04 | P1・適用順の既知リスク | 未適用 | 本番の注文直接UPDATE権限と不変条件トリガーの保留 |
| R-05 | P2・既存の周辺リスク | 未修正 | 署名不正WebhookごとにDB監査と外部通知を実行する |
| R-06 | P2 | 未修正 | 注文に紐づかない返金イベントが永続的な再試行になる |
| R-07 | P1・公開順序の既知リスク | 未適用 | 受信ルートを公開する前のworker Cron起動経路が未確保 |
| R-08 | P2 | 未修正 | 商品から外した色・サイズの旧バリアントが公開在庫判定に残る |
| R-09 | P2 | 未修正 | 管理画面の受注生産数に発送済み・取消済み注文が残る |
| R-10 | P2 | 未修正 | バリアント管理APIが集計・履歴の取得失敗を空データとして返す |
| R-11 | P3（2回目で P1 から訂正） | 未修正 | Custom CheckoutのSession作成時にreturn_urlがない（現状はconfirmのreturnUrlで動作） |
| R-12 | P2 | 解消（グループ F） | プロモーションコード削除のStripeエラーを画面が見落とす |
| R-13 | P1 | 未修正 | 任意の色・サイズをカートへ入れて支払済み注文にできる |
| R-14 | P2 | 未修正 | メール送信権のDB取得失敗時に重複送信を許す |
| R-15 | P2 | 修正済み（2026-10-09） | 色・サイズとバリアントの同期が管理画面の在庫欄を開いたときだけ走る |
| R-16 | P3 | 要方針決定 | 未発送の全額返金で取消になっても引当在庫を台帳へ戻さない |
| R-17 | P3 | 未修正 | ウィッシュリストのカードに「受注生産」が出ない |
| R-18 | P3 | 未修正 | 管理者の未入金注文キャンセルで注文履歴に実行者が残らない |
| R-19 | P3 | 未修正 | カート加算後の1行数量に上限がない |
| R-20 | P3 | 未修正 | 在庫増減APIの入力検証が緩く冪等キーもない |
| R-21 | P3 | 未修正 | 重複した色・サイズ名を保存でき、その商品の在庫欄が500になる |
| R-22 | P2・既存 | 未修正 | CSRFトークン検査の拒否応答を見落とし、検査が効いていない |
| R-23 | P2 | 未修正 | Stripeの500系応答が同じ冪等キーで再生され、そのカートで決済を始められない |
| R-24 | P2・既存 | 解消（グループ C。「注文する」で確かめた会員を、注文を作る処理の中で持ち主として書く） | ログイン客の注文が user_id に紐付かず注文履歴に出ない |
| R-25 | P2 | 解消（グループ F） | Checkout Sessionの有効期限が既定24時間のまま、支払後に注文確定を断る経路がある |
| R-26 | P3 | グループ A で修正（受付 RPC が同一トランザクションで discount_amount だけを書き戻す） | 値引き額の書き戻しでdraftの照合が外れ、再表示が500になる |
| R-27 | P2 | 解消（グループ F） | customer_email付きで作ったSessionでは updateEmail が例外になり支払えない |
| R-28 | P3 | 一部修正（FREQ-420でサーバーが割引コードを検証し、0円になるコードを拒否。既存の0円Sessionの完了後拒否は残る） | 100%割引で0円Sessionを完了させた後に注文確定を断る |
| R-29 | P3 | 一部修正（グループ F。金額不一致のretryable:falseと「新規」選択で再試行不可の案内が消える点は残る） | 画面の再試行ボタンとエラー消去の不整合 |
| R-30 | P3 | 未修正 | resource_missing でそのカートの決済開始が恒久的に500になる |
| R-31 | P3 | 解消（グループ F で配送先の後からの同期の入口を廃止） | 支払後・注文確定前のdraftの配送先を別タブから上書きできる |
| R-32 | P2・適用前に必須 | 未適用 | 10秒間隔のworker Cronで実行履歴が肥大し、Freeプランの容量上限に達する |
| R-33 | P2 | 未修正 | Webhookの恒久失敗が上限・退避・通知なしで永久に再試行される |
| R-34 | P2 | 未修正 | 注文確認メールの送信失敗後に再送する経路がない |
| R-35 | P3 | 未修正 | workerが1起動1件しか処理せず、集中時に反映が数十分遅れる |
| R-36 | P3・テスト | 未修正 | FREQ-401のカート単体テストが500応答でも成功する |
| R-37 | P3・潜在 | 未修正 | 公開在庫の集計が取得上限で黙って切れ得る |
| R-38 | P3 | 未修正 | 注文APIから在庫状態を外したが「予約注文」分岐と仕様が残る |
| R-39 | P3・a11y | 未修正 | 在庫欄の行ごとの操作にどの組合せかを示す名前がない |
| R-40 | P3・既存 | 未修正 | お問い合わせの注文紐付けで ilike のワイルドカードを未エスケープ |
| R-41 | P2 | 未修正 | バリアント導入前の未入金注文を取り消すと、引当のない在庫が台帳に湧く |
| R-42 | P3 | 未修正 | 注文確定とカート数量変更のロック順が逆でデッドロックし得る |
| R-43 | P3・既存 | 未修正 | 注文履歴の起因イベントIDが常に空 |
| R-44 | P3 | 未修正 | 在庫を一度でも動かした商品は削除できず汎用500になる |
| R-45 | P3・多層防御 | 未修正 | SECURITY DEFINER 3本の search_path が public を pg_catalog より前に置く |
| R-46 | P3・運用 | 未修正 | マイグレーションが冪等性の規約に反する |
| R-47 | P2・a11y | 未修正 | 見出しのないドロップダウン（/item の並び替え等）が名前を失った |
| R-48 | P2・a11y | 未修正 | 誤りのあるドロップダウンにフォーカスしても見た目が変わらない |
| R-49 | P3・a11y | 未修正 | 管理画面で返金後に表が消えてフォーカスを失い、結果の案内も不安定 |
| R-50 | P3・a11y | 未修正 | お問い合わせフォームの必須の示し方がそろっていない |
| R-51 | P3・a11y | 未修正 | 失敗の案内が割り込まない polite で出る箇所がある |
| R-52 | P3 | 未修正 | Card の見出しがカードのサイズに追従しなくなった |
| R-53 | P3・運用 | 未修正 | Footer のレイアウト変更に要求と E2E がない |
| R-54 | P3・テスト | 未修正 | 固定CTAの案内のE2Eが「見えている」ことを確かめなくなった |
| R-55 | P3・条件付き | 一部対応（E2E を手元の Supabase に切り替え。受け取り口のモードの確かめは計画2） | E2E が実際に決済を確定し、テストWebhookを登録すると本番DBに注文を作る |
| R-56 | P1 | 修正済み（グループ F） | 「確認へ進む」で支払いが確定し、戻る・再読込の後は決済フォームが出ず先へ進めない（ユーザー報告） |
| R-57 | P2・法令表示 | 未修正 | コンビニの支払期限が /legal（7日以内）と Stripe の設定（3日）で食い違う |

## 指摘

### R-01 非同期決済イベントの順不同で注文状態が取り残される

- **箇所**: [webhook-processor.ts](../../../../src/lib/stripe/webhook-processor.ts) 425〜525行、551〜574行、636〜650行、[worker route](../../../../src/app/api/cron/process-stripe-webhooks/route.ts) 48〜49行。
- **再現経路**: checkout.session.async_payment_succeeded が注文作成前に処理されると条件付きUPDATEは0件だが成功扱い。続く checkout.session.completed はイベント内の payment_status=unpaid から pending 注文を作る。その後の payment_intent.succeeded は既存注文としてスキップされ、入金済みでも pending が残り得る。失敗イベントも対象注文0件で完了扱いになり、その後の completed が pending 注文と予約在庫を作り得る。checkout.session.expired も同じ0件完了経路を持つ。
- **根拠**: [Stripe Webhook event ordering](https://docs.stripe.com/webhooks#event-ordering) は配信順を保証しない。[OWASP Business Logic Security](https://cheatsheetseries.owasp.org/cheatsheets/Business_Logic_Security_Cheat_Sheet.html) は状態遷移の順番を変えたテストを求める。
- **修正方針**: イベントのスナップショットとDB更新0件だけで完了判定せず、Stripeの現在のSession/PaymentIntent状態を注文作成・更新の直前に照合する。注文未作成なら依存イベントを再試行可能に保つか、現在値から注文を確定する。成功・失敗・期限切れの両順序をworker完了状態までテストする。
- **2回目の追記**: worker は10秒間隔・最長60秒なので最大約6本が並行し、claim の `FOR UPDATE SKIP LOCKED` は別イベントを並行に取らせる。同じ PaymentIntent のイベントでも受信順に処理される保証はなく、修正には payment_intent 単位の直列化（advisory lock 等）も要る。

### R-02 payment_intent.payment_failed は決済全体の最終失敗ではない

- **箇所**: [webhook-processor.ts](../../../../src/lib/stripe/webhook-processor.ts) 695〜720行、621〜650行、482〜525行。
- **再現経路**: payment_intent.payment_failed を受けると、現行コードはStripeの現在値を確認せず release_stock_for_unpaid_order を呼び、pending注文を failed にして在庫を解放する。同じPaymentIntentで後から成功した場合、payment_intent.succeeded は注文が存在するだけでスキップし、async_payment_succeeded は pending 以外を更新しないため、入金済み注文が failed のまま残り得る。
- **根拠**: [Stripe Event types](https://docs.stripe.com/api/events/types) は同イベントを支払方法または支払いを作る「試行」の失敗と定義する。
- **修正方針**: 試行失敗だけでは在庫を解放しない。Checkout Sessionの最終失敗・失効とStripeの現在値を照合してから状態遷移させ、後続成功があれば既存注文も安全に paid へ収束させる。試行失敗後に成功するケースを追加する。

### R-03 返金の冪等キーが操作を識別しない

- **箇所**: [refund route](../../../../src/app/api/admin/orders/[id]/refund/route.ts) 168〜180行。現行HEADにも存在するが、今回変更した返金導線の周辺リスク。
- **再現経路**: 同じ注文へ同額の部分返金を2回行うと、2回目も同じ admin-refund:orderId:amount を送る。Stripeは最初の返金応答を再利用し、新しい返金を作らない。理由や操作主体が異なるとパラメータ不一致になる。24時間以降に同じキーが削除されると、逆に同一操作の再送で新規返金が生じ得る。
- **根拠**: [Stripe Idempotent requests](https://docs.stripe.com/api/idempotent_requests) は同じキーの結果再利用、パラメータ照合、24時間以降の削除を規定する。OWASPも外部の非冪等操作には操作単位のキーを求める。
- **修正方針**: 返金操作ごとに一意な要求IDを永続化し、その要求の再試行だけで同じStripe冪等キーを使う。新規の同額部分返金には新しいIDを割り当て、Stripe返金ID・結果と対応づける。並行返金と日をまたぐ再送をテストする。

### R-04 本番の注文直接更新経路は第2段階マイグレーション待ち

- **箇所**: [harden_order_state_transitions.sql](../../../../supabase/pending/harden_order_state_transitions.sql)。
- **事実**: 2026-09-25のSupabase MCP読取では、authenticated の public.orders UPDATE権限は true、admin orders manage by permission update policy が有効で、不変条件トリガーはまだ未適用。管理APIが入金済み注文の通常キャンセルを409にしても、当該権限のある利用者はData APIを直接呼んで迂回できる。これは承認済みの段階的適用計画の未完了部分で、新しいコード由来の発見ではない。
- **根拠**: [Supabase Securing your API](https://supabase.com/docs/guides/api/securing-your-api) はData APIのGrantとRLSの両方で公開範囲を制限する実装を案内する。
- **対応条件**: 対応アプリを公開・検証した後に保留中のハードニングを適用し、Grant、policy、トリガーをMCPで読み戻す。この段階を終えるまでAPIだけで入金済みの不正キャンセルを防げるとは判定しない。
- **2回目の追記**: 本番では anon・authenticated の両方が orders・order_items に INSERT・UPDATE・DELETE・TRUNCATE の表権限を持ち、authenticated 向けに orders の insert/update/delete、order_items の insert/update/delete の permissive policy がある（2026-09-25 MCP読取）。保留中の [harden_order_state_transitions.sql](../../../../supabase/pending/harden_order_state_transitions.sql) は orders の UPDATE とその policy しか外さず、不変条件トリガーも BEFORE UPDATE だけ。適用後も admin.orders.manage を持つ利用者は Data API で入金済みの注文を INSERT でき、order_items の INSERT は既定値 'stock' の明細を作って R-41 の在庫水増しにつながる。アプリは orders・order_items を直接 INSERT していない（grep）ので、INSERT・DELETE・TRUNCATE の REVOKE と該当 policy の削除を同じ第2段階に含める。TRUNCATE は PostgREST から届かないため多層防御の位置付け。

### R-05 署名不正Webhookで監査・外部通知を増幅できる

- **箇所**: [webhook route](../../../../src/app/api/webhook/stripe/route.ts) 34〜47行、[audit.ts](../../../../src/lib/audit.ts) 45〜81行。旧実装でも署名不正時に同様の監査を行っていた。
- **再現経路**: 公開エンドポイントに不正署名付きPOSTを大量送信すると、署名失敗のたびに audit_logs INSERT と ALERT_AUDIT_URL へのPOSTが起きる。署名は防御されているが、DB・通知先を未認証リクエストで消費できる。
- **修正方針**: 不正署名は機密情報を含めずサーバーログに記録し、DB監査・外部通知は集約またはレート制限して異常頻度を通知する。署名検証の失敗自体は引き続き400とする。

### R-06 注文に紐づかない返金イベントが永続的な再試行になる

- **箇所**: [webhook-processor.ts](../../../../src/lib/stripe/webhook-processor.ts) 730〜743行と815〜822行、[order-refund-sync.ts](../../../../src/lib/stripe/order-refund-sync.ts) 154〜155行、[worker route](../../../../src/app/api/cron/process-stripe-webhooks/route.ts) 48〜58行。既存の返金イベント処理にも同じ根本問題があり、今回 refund.failed が対象に増えた。
- **再現経路**: Stripeアカウントでこのアプリの注文に紐づかないRefundまたはcharge.refundedが発生した場合、またはRefund/Chargeにpayment_intentが無い場合、注文投影が例外を投げる。workerはイベントをfailedへ戻して再試行し続け、後続の会計同期にも到達しない。Stripe-only支払いは注文を自動作成しない設計のため、注文不在は恒久的な入力になり得る。
- **根拠**: [Stripe Refund object](https://docs.stripe.com/api/refunds/object) のpayment_intentはnullable。イベントの重複・順不同に備え、注文投影と会計同期を独立に扱う必要がある。
- **修正方針**: 注文不在とpayment_intent無しを一過性DB障害から区別する。注文投影を安全にスキップして未対応の紐付けとして監査し、Refund自身の会計同期を実行する。注文が後から作られる可能性には、現在値からの照合・再同期経路を設ける。
- **2回目の追記**: 注文が存在しても status が pending・failed なら、[apply_order_refund_projection](../../../../supabase/migrations/20260925000218_add_order_state_transition_rpcs.sql) の `status IN ('paid','shipped','cancelled')` 条件で0行になり同じく永久再試行になる。R-02 で入金済みなのに failed になった注文を管理者がStripeダッシュボードから返金すると到達する。上限と通知がない点は R-33。
### R-07 workerの起動経路を受信ルートより先に確保する必要がある

- **箇所**: [webhook route](../../../../src/app/api/webhook/stripe/route.ts) 51〜63行、[worker route](../../../../src/app/api/cron/process-stripe-webhooks/route.ts) 15〜58行、[schedule_stripe_webhook_worker.sql](../../../../supabase/pending/schedule_stripe_webhook_worker.sql)。
- **事実**: 署名済みイベントはキュー保存後に2xxを返し、注文更新はworkerに移された。2026-09-25のSupabase MCP読取では対象Cronジョブ0件で、worker起動用マイグレーションは保留中。受信ルートだけを公開するとStripeは再送せず、イベントはキューに残って注文と会計が更新されない。CronマイグレーションもVaultの app_base_url / cron_secret が無い場合は警告だけで作成を続行するため、適用成功だけでは稼働確認にならない。
- **対応条件**: 対象Vault secretと到達先を確認し、workerを先にデプロイしてCronを登録する。Cronの実行履歴・HTTP応答・キューの処理完了を実イベントまたは安全なテストイベントで確認してから受信ルートを公開する。公開後は滞留件数と最古イベントの経過時間を監視する。
### R-08 商品から外した色・サイズの旧バリアントが公開在庫判定に残る

- **箇所**: [商品更新API](../../../../src/app/api/admin/items/[id]/route.ts) 139〜145行・183〜193行、[バリアント取得API](../../../../src/app/api/admin/items/[id]/variants/route.ts) 56〜70行、[backfill関数](../../../../supabase/migrations/20260921121038_retire_item_stock_quantity.sql) 286〜317行、[公開在庫集計](../../../../src/lib/items/availability.ts) 74〜87行。
- **再現経路**: 在庫のある色またはサイズを商品編集で削除・改名すると、items.colors/sizes は変わるが item_colors/item_sizes/item_variants は残る。GET時の backfill_item_variants は新しい組合せを追加するだけで旧組合せを無効化しない。公開在庫集計は旧バリアントも数えるため、現在選択できる組合せがすべて在庫0でも商品一覧は「在庫あり」になり、詳細APIに選択不能な組合せが混ざる。
- **修正方針**: 商品の選択肢変更とバリアントの有効状態・公開対象を原子的に同期する。過去の注文明細と在庫台帳は消さず、旧組合せを販売画面の集計から除く。色・サイズ削除、改名、在庫ありの旧組合せを含むケースを検証する。

### R-09 受注生産の受注数が製造待ち数量として過大になる

- **箇所**: [variant_backorder_summary](../../../../supabase/migrations/20260919065518_add_variant_backorder_summary.sql) 5〜12行、[管理画面の取得API](../../../../src/app/api/admin/items/[id]/variants/route.ts) 80〜114行、[出荷RPC](../../../../supabase/migrations/20260925000218_add_order_state_transition_rpcs.sql) 203〜213行。
- **再現経路**: 集計ビューは order_items.fulfillment_type='backorder' の数量を親注文の状態と無関係に合算する。受注生産の注文を発送、取消、失敗にしても明細はそのままなので、管理画面の「受注生産」数量は減らない。詳細設計は製造判断に使う数としているため、未履行数として読むと過大発注につながる。
- **修正方針**: 表示を累計受注数とするか製造待ち数量とするか確定する。製造待ちを示すなら、親注文と出荷・取消の状態でビューを絞り、各遷移後の数量をDBテストで確認する。累計なら画面にその意味を明示する。

### R-10 集計・履歴の取得失敗を空データとして返す

- **箇所**: [バリアント取得API](../../../../src/app/api/admin/items/[id]/variants/route.ts) 80〜101行・103〜115行。
- **再現経路**: variant_backorder_summary または stock_movements のSELECTが権限・接続・スキーマ不整合などで失敗しても、APIは error を見ずに null を空配列へ変換して200を返す。管理画面は受注生産数0件、履歴なしと表示するため、実データ欠落と正常なゼロを区別できない。
- **修正方針**: 両SELECTの error を判定し、失敗を監査したうえで適切なエラー応答または明示的な部分取得状態を返す。管理画面には再取得を促し、取得失敗時にゼロと表示しないテストを追加する。
### R-11 Custom Checkoutでリダイレクト型決済に必要なreturn_urlがない

- **箇所**: [Checkout Session作成API](../../../../src/app/api/checkout/create-session/route.ts) 987〜1025行。
- **再現経路**: 新実装は payment_method_types を省略してStripeダッシュボードの動的決済手段を使う。PayPayなどリダイレクト型の手段が有効な場合でも custom ui_mode の SessionCreateParams に return_url を指定せず、hosted 側だけ success_url/cancel_url を設定している。StripeのSession作成条件に合わず、決済開始自体が失敗する。単体テストはStripe作成APIをモックしているためこの条件を検出しない。
- **根拠**: [Stripe Checkout Session作成API](https://docs.stripe.com/api/checkout/sessions/create) は、custom/embeddedでリダイレクト型の決済手段を有効にすると return_url が必須と規定する。リポジトリの[動的決済手段の設計書](../../../superpowers/specs/2026-09-12-checkout-dynamic-payment-methods-design.md)もPayPayへの切替と復帰を対象にしている。
- **修正方針**: custom 側にも許可済み checkout_origin から組み立てた return_url を設定する。復帰時の session_id 検証・注文確定経路とつなぎ、PayPayを有効にしたStripeテスト環境で作成と復帰を検証する。
- **2回目の訂正（P1→P3）**: 「決済開始自体が失敗する」は成り立たない。[動的決済手段の設計書](../../../superpowers/specs/2026-09-12-checkout-dynamic-payment-methods-design.md) 21行目で、return_url なし・PayPay有効の状態でSession作成が成功した実測がある。画面は [page.tsx](../../../../src/app/checkout/page.tsx) 1443〜1446行で `confirm({ returnUrl })` を渡しており、[Stripe.js confirm](https://docs.stripe.com/js/custom_checkout/confirm) は returnUrl を「Session作成時に return_url を指定しなかった場合のみ必須」とする。APIリファレンス上は条件付き必須なので、堅牢化としてサーバー側設定は残す。ただし [Basil の変更](https://docs.stripe.com/checkout/custom-checkout/changelog) により、Sessionに return_url がある状態で confirm に returnUrl を渡すとエラーになる。サーバー側に移すときは画面側の returnUrl を同時に外し、R-23 のとおり冪等キーの版も上げる。
### R-12 プロモーションコード削除の失敗を案内しない

> 解消（グループ F）。[入力画面](../../../../src/app/checkout/page.tsx)の割引削除はローカルの適用済み値だけを消し、removePromotionCodeを呼ばない。[create-session](../../../../src/app/api/checkout/create-session/route.ts)が確認時にサーバー検証済みコードだけをdiscountsで付け、配送先・コードを指紋へ含めて新しい決済の画面を作る。旧再現経路は無い。以下は変更前の指摘。

- **箇所**: [Checkout画面](../../../../src/app/checkout/page.tsx) 307〜315行、[Stripe.jsの戻り値型](../../../../node_modules/@stripe/stripe-js/dist/stripe-js/checkout.d.ts) 552〜554行。
- **再現経路**: removePromotionCode() は例外だけでなく type='error' の結果を返すが、削除処理は結果を確認せず入力待ち状態に戻る。通信障害やStripe側の拒否で割引が残っても、客には理由が示されず、そのまま購入を進め得る。applyPromotionCode側は同じ型の error を表示している。
- **修正方針**: 削除結果の type を判定し、error.message を promoError に表示する。成功時だけ削除済みとして扱い、失敗結果を返すテストを追加する。

### R-13 任意の色・サイズで支払済み注文が成立する

- **箇所**: [カート入力検証](../../../../src/features/cart/services/cart-stock.ts) 4〜21行、[カート追加API](../../../../src/app/api/cart/route.ts) 195〜205行・243〜269行、[Session作成API](../../../../src/app/api/checkout/create-session/route.ts) 541〜604行、[variant解決関数](../../../../supabase/migrations/20260921035818_wire_variant_stock_on_order.sql) 63〜74行、[注文確定関数](../../../../supabase/migrations/20260921121038_retire_item_stock_quantity.sql) 505〜535行。
- **再現経路**: 公開POST /api/cart は color/size の文字種だけを検証し、対象商品の現在の選択肢と照合しない。任意文字列を入れたカートも Session 作成では商品の公開状態しか確認せず、決済へ進める。DBは一致する variant がないと variant_id=NULL とし、backorder で支払済み注文を作る。販売していない色・サイズの注文を運用へ流すことになる。
- **修正方針**: カート追加と決済開始前に、公開商品が提供する色・サイズの組合せを検証する。Session作成時に認めた組合せをdraftへ固定し、商品編集が並行しても支払済み注文を失わないよう注文確定側は既存のフォールバックを維持する。改ざんした入力と編集競合をテストする。
- **2回目の追記**: 改ざんがなくても、再購入（useReorder）は過去の注文の色・サイズをそのまま送るため、販売をやめた組合せが同じ NULL バリアントの経路に入る。数量の上限は R-19。
### R-14 メール送信権のDB取得失敗時に重複送信を許す

- **箇所**: [注文確認メール](../../../../src/lib/orders/order-confirmation-email.ts) 177〜205行、[対応テスト](../../../../tests/unit/lib/orders/order-confirmation-email.test.ts) 190行付近。
- **再現経路**: claim_order_email RPC が失敗すると claimOrderEmail は監査後に true を返す。complete、Webhook、再試行が同じ注文を並行処理し、DBの一時障害で各呼び出しのclaimが失敗すれば、いずれも送信へ進んで同じ確認メールを複数通送る。これは「未達より重複を優先」という意図的な実装だが、FREQ-386の二重送信防止契約はこの障害時には満たさない。
- **修正方針**: 送信権が不明な状態では無条件送信せず、永続的なoutboxと再試行で到達性と一度だけの送信を両立する。claim失敗・並行complete/Webhookの試験を追加し、障害時のメール運用方針を仕様に明記する。

### R-15 色・サイズとバリアントの同期が管理画面の在庫欄を開いたときだけ走る

- **箇所**: [variants route](../../../../src/app/api/admin/items/[id]/variants/route.ts) 56〜64行（`backfill_item_variants` の唯一の呼び出し元）、[resolve_checkout_item_variants](../../../../supabase/migrations/20260921035818_wire_variant_stock_on_order.sql) 36〜74行、[variant_backorder_summary](../../../../supabase/migrations/20260919065518_add_variant_backorder_summary.sql) 10〜11行、[ItemForm](../../../../src/app/admin/item/ItemForm.tsx) 364行。
- **再現経路**: 商品を新規作成すると一覧（`/admin?tab=ITEM`）へ戻り、編集画面の在庫欄は開かれない。本番の items のトリガーは `trg_items_updated_at` だけ（MCPで確認）なので item_variants は作られない。この間に購入されると variant_id=NULL・backorder の明細になり、集計ビューは `variant_id IS NOT NULL` だけを数えるため受注生産数から永続的に漏れる。商品詳細も組合せが空なので納期表示が出ない（FREQ-400-REQ-02）。
- **修正方針**: 商品の作成・更新と同じトランザクションでバリアントを同期する（RPC化、または colors/sizes 変更のトリガー）。R-08 と同じ根本原因なので1か所で直す。バリアント生成時に NULL の明細を再照合するかも決める。GET に書き込みの副作用がある点もここで解消する。
- **修正（2026-10-09）**: カートとお気に入りの引き継ぎ（[設計書](../../../superpowers/specs/2026-10-08-cart-wishlist-carryover-design.md)）の全体レビューで同じ問題が見つかり、[移行 20261008220958_item_variant_sync.sql](../../../../supabase/migrations/20261008220958_item_variant_sync.sql) で `items` に `AFTER INSERT OR UPDATE OF colors, sizes` のトリガーを足し、商品の作成・色やサイズの変更と同じ取引で `backfill_item_variants` を呼ぶ形にした（本番に適用済み。適用時に全商品を一度そろえ、組み合わせの欠けた公開中の商品が0件なことを確かめた）。管理画面の保存は色の名前・サイズの重なりを 400 で断る。外した色・サイズのバリアントを止める R-08 は未修正のまま。

### R-16 未発送の全額返金で取消になっても引当在庫を台帳へ戻さない

- **箇所**: [apply_order_refund_projection](../../../../supabase/migrations/20260925000218_add_order_state_transition_rpcs.sql) 261〜292行、[stock_movements](../../../../supabase/migrations/20260919065355_add_stock_movements.sql) 10〜11行、[管理設計書](../../../04_DetailDesign/pages/16_admin.md) 151行。
- **事実**: 全額返金で status を cancelled にするが、`reason='refund'` の台帳行を書く処理はリポジトリのどこにもない（grep）。設計書は refund を「注文の処理が書く理由」と定義している。refund.failed で cancelled から paid へ戻す分岐もあるため、戻すなら再引当も対になる。
- **修正方針**: 未発送の全額返金で明細単位に冪等な refund 行を追記するか、手動調整（adjustment）で運用すると仕様に明記するかを決める。

### R-17 ウィッシュリストのカードに「受注生産」が出ない

- **箇所**: [wishlist API](../../../../src/app/api/wishlist/route.ts) 110〜141行（未変更）、[wishlist page](../../../../src/app/wishlist/page.tsx) 360行。
- **事実**: 画面は `product?.madeToOrder ?? false` を読むが、APIは madeToOrder を返さない。FREQ-400-REQ-01 は「一覧・ウィッシュリストのカード」に表示すると定めている。既定値も一覧（[public.ts](../../../../src/lib/items/public.ts) 21行の `?? true`）と逆。
- **修正方針**: API で `getItemsAvailability` を使って付与し、既定値を一覧とそろえる。E2E に在庫0の組合せだけの商品ケースを加える。

### R-18 管理者の未入金注文キャンセルで注文履歴に実行者が残らない

- **箇所**: [release_stock_for_unpaid_order](../../../../supabase/migrations/20260921121038_retire_item_stock_quantity.sql) 567〜627行、[status route](../../../../src/app/api/admin/orders/[id]/status/route.ts) 396〜400行。
- **事実**: 他の管理RPCは `app.order_actor_id` を設定するが、この関数は設定しない。service role からの呼び出しでは `auth.uid()` も NULL なので、order_revisions.changed_by と変更理由が NULL になる。設計書 16_admin.md 144行「人間の操作は changed_by へ記録する」に反する。監査ログ側には actor_id が残る。
- **修正方針**: `_actor_id` を受け取る管理者用の未入金キャンセルRPCを追加し、Webhook経路と分ける。

### R-19 カート加算後の1行数量に上限がない

- **箇所**: [cart route](../../../../src/app/api/cart/route.ts) 246〜255行、[cart-stock.ts](../../../../src/features/cart/services/cart-stock.ts) 3・17行。
- **事実**: 入力は1回あたり20以下に制限するが、既存行への加算結果は検査しない。`quantity:20` を2回送ると40になる。決済開始側にも行単位の上限がない。移行SQL（20260921121038 22行）は「上限は MAX_CART_ITEM_QUANTITY で担保」と書いており、前提が成り立たない。今回の差分で唯一の在庫ガード（実運用では NULL で無効だった）も消えた。
- **修正方針**: 加算後の値を検査して409か上限丸めを返す。carts に `CHECK (quantity BETWEEN 1 AND 20)` を付け、create-session でも再検証する。

### R-20 在庫増減APIの入力検証が緩く冪等キーもない

- **箇所**: [variants route](../../../../src/app/api/admin/items/[id]/variants/route.ts) 19〜25行。
- **事実**: `z.coerce.number()` は `true`→1、`"1e3"`→1000、`[7]`→7 を通す（実測）。上限がなく、`3e9` は integer 列の範囲外で500になる。理由「入荷」でも負の値が通る。タイムアウト後の再送で同じ増減が二重に記録される。
- **修正方針**: coerce をやめ `z.number().int().min().max()` で範囲を決め、入荷は正の値に限る。要求IDを冪等キーとして台帳に一意制約で持つ。

### R-21 重複した色・サイズ名を保存でき、その商品の在庫欄が500になる

- **箇所**: [admin item route](../../../../src/app/api/admin/items/[id]/route.ts) 9〜25行、[ItemForm](../../../../src/app/admin/item/ItemForm.tsx) 256〜260行、[backfill_item_variants](../../../../supabase/migrations/20260921121038_retire_item_stock_quantity.sql) 258〜287行。
- **事実**: 更新スキーマに名前の一意性検査がなく、保存済みカラーの適用も重複を確認しない。重複があると backfill が data_exception を投げ、在庫欄は「Failed to sync item variants」の500を返し続ける。
- **修正方針**: zod とフォームの両方で色名・サイズ名の一意性を検査し、data_exception は理由の分かる4xxへ変換する。

### R-22 CSRFトークン検査の拒否応答を見落とし、検査が効いていない

- **箇所**: [create-session](../../../../src/app/api/checkout/create-session/route.ts) 40〜48行・500〜519行、`src/app/api/checkout/update-shipping/route.ts`（グループ F で削除済み）21〜23行、同形の判定が profile・profile/addresses・auth/logout にもある。正しい判定は [admin-security.ts](../../../../src/features/stockist/services/admin-security.ts) の `value instanceof Response`。
- **再現経路**: ログイン客（`sb-refresh-token` あり）が X-CSRF-Token なし・不正値でPOSTすると、[requireCsrfOrDeny](../../../../src/lib/csrfMiddleware.ts) は403の NextResponse を返す。呼び出し側は `'status' in value && '_body' in value` で拒否を判定するが、`'_body' in NextResponse.json({}, {status: 403})` は false（node で実測）。拒否が無視され処理が続く。DB障害時の500応答も同様に無視される。
- **影響**: proxy の Origin 検査と SameSite=Lax があるため直接の悪用は難しいが、設計が前提とする多層防御の1層が欠けている（OWASP CSRF Prevention Cheat Sheet）。単体テストはモックが `_body` 付きの素のオブジェクトを返すため検出できない。HEADから存在し、今回の差分は update-shipping を含む同じ経路を変更している。
- **修正方針**: `if (csrfResult instanceof Response) return csrfResult;` に統一し、実際の NextResponse を返すモックで拒否ケースを試験する。画面は clientFetch が X-CSRF-Token を付けるので、修正で正規の利用は壊れない。

### R-23 Stripeの500系応答が同じ冪等キーで再生され、そのカートで決済を始められない

- **箇所**: [create-session](../../../../src/app/api/checkout/create-session/route.ts) 169〜171行（キーは draft ID から決まる）・1024〜1026行、[claim_checkout_draft](../../../../supabase/migrations/20260925000132_add_checkout_session_claim_rpcs.sql) 125〜185行、[checkout-error.service.ts](../../../../src/features/checkout/services/checkout-error.service.ts) 66〜98行。
- **再現経路**: `sessions.create` がStripe側で実行開始後に500を返すと、draft は Session ID なしの created のまま残る。同じカートの再試行は同じ fingerprint で同じ draft を取り、同じキーを送る。Stripeは保存済みの500を返し続け、画面は「再試行する」を出し続ける。Session ID がないので `retire_expired_checkout_draft` も使えない。draft の保持期間は30日、Stripeのキーは24時間以降に削除される。
- **根拠**: [Stripe Idempotent requests](https://docs.stripe.com/api/idempotent_requests) は「成否にかかわらず最初の結果を保存し、500を含めて同じ結果を返す」と規定する。
- **修正方針**: StripeAPIError（実行開始後の5xx）と StripeIdempotencyError を受けたら、その draft を条件付き更新で failed にして次回は新しい draft とキーを使う。StripeIdempotencyError は再試行不可として扱い警報を出す。

### R-24 ログイン客の注文が user_id に紐付かず注文履歴に出ない

> 解消（グループ C）。「確認へ進む」と「注文する」の両方でサーバーがログインを確かめ、同じ会員の時だけ、注文を作るのと同じ処理の中で持ち主（`orders.user_id`）を書く。完了（complete）での紐付けはやめた。[設計書](../../../superpowers/specs/2026-10-08-order-owner-binding-design.md)、[実装計画](../../../superpowers/plans/2026-10-08-order-owner-binding.md)。「箇所」から「グループ C の前の状態」までは変更前の指摘。

- **箇所**: [complete route](../../../../src/app/api/checkout/complete/route.ts) の `linkOrderToUserIfUnowned`（グループ C で削除）、[webhook-processor](../../../../src/lib/stripe/webhook-processor.ts)、[place_order_from_checkout_draft](../../../../supabase/migrations/20260927100300_place_order_from_checkout_draft.sql)、[orders API](../../../../src/app/api/orders/route.ts)。
- **修正前の再現経路**: ログイン状態で購入すると注文は RPC で作られるが、INSERT に user_id がなく、通常経路でも `linkOrderToUser` が呼ばれなかった。購入履歴は `eq('user_id', userId)` なので、次回ログイン時の `linkGuestOrdersByEmail` まで表示されなかった。
- **グループ C の前の状態**: complete API は照合後、ログイン中なら未所有注文を `user_id` に紐付けた。完了の処理がログインなしで行われる場合（ブラウザを閉じた・通信が切れた・PayPay から別のブラウザに戻った）と、ユーザー情報を持たない Webhook 単独経路では、持ち主が空のまま残った。また、注文した人と、完了の時にログインしている人が同じかは確かめていなかった。
- **修正内容（グループ C）**:
  - 買い手の確かめ: create-session・place-order・resume の3つの入口が、各入口の守りの直後、DB と Stripe に触れる前に `resolveCheckoutBuyer` を呼ぶ。会員の ID は検証済みの `claims.sub` だけから取り、画面から送られた値は使わない。印が古い時は 401 `auth_expired`（画面が印を新しくして1回だけ送り直す）、確かめられない時は 503（ゲスト扱いにしない）。
  - 「確認へ進む」で、下書きの `buyer_user_id` に買い手（会員の ID、ゲストは空）を記録する。後から変えられない（`CHECKOUT_DRAFT_BUYER_IMMUTABLE`）。
  - 「注文する」でもう一度確かめ、下書きの買い手と違えば 409 `login_changed` で断る（決済の画面を閉じる。お金は動かない）。同じなら、受付 RPC `place_order_from_checkout_draft` に買い手を渡す。RPC は下書きをロックして買い手を比べ直し、注文を作るのと同じ処理の中で `user_id` を書く。
  - 「注文する」を通らない支払い（Stripe の知らせ・見回り・完了の照合）は持ち主を付けない。その注文は、メール確認済みのログインの時に `linkGuestOrdersByEmail` が同じメールの注文としてまとめる（今までの仕組み）。
  - 注文の持ち主は DB が守る。空から値へだけ書け、別の会員への付け替えは `ORDER_OWNER_IMMUTABLE` で断る。空に戻るのは会員を消した時だけ。
- **確認**: DB 結合 [checkout_order_owner_binding](../../../../tests/integration/db/checkout_order_owner_binding.integration.test.ts)、E2E [FR-CHECKOUT-046](../../../../e2e/FR-CHECKOUT-046-order-owner-binding.spec.ts)（FREQ-426・427）。FREQ-427 の2つは断られる経路が違い、別々に確かめる: AC-01 はログインでカートの印が新しくなり、買い手の比べより前に 403 `forbidden` で断られる経路（画面は `login_changed` と同じ扱い）、AC-02 はカートの印が残ったままログインの Cookie が無くなり、買い手の比べで 409 `login_changed` で断られる経路。移行 `20261008055720_checkout_order_owner_binding.sql` は本番へ未適用で、push の後にユーザーの許可を得て当てる。

### R-25 Checkout Sessionの有効期限が既定24時間のまま、支払後に注文確定を断る経路がある

> 解消（グループ F）。Sessionはページを開いた時でなく「確認へ進む」で作る。[期限予約RPC](../../../../supabase/migrations/20260927100600_checkout_session_expiry.sql)が30分の期限（Stripeの下限を割らないため30秒の余裕）を決め、[create-session](../../../../src/app/api/checkout/create-session/route.ts)がexpires_atに渡す。[後始末](../../../../src/features/checkout/services/checkout-session-lifecycle.service.ts)は同じCookieの別のopen Sessionを閉じ、受付済みなら照合して在庫を戻す。[place-order](../../../../src/app/api/checkout/place-order/route.ts)が商品・カート・価格・在庫を受付RPCで支払い前に検証するため、旧来の24時間放置・古い画面から支払い後に初めて商品を拒否する再現経路は無い。別の完了済み画面はpayment_doneでその注文の確定へ進める。閉鎖失敗は監査し、Stripe・DBの実環境検証は別途必要。以下は変更前の指摘。

- **箇所**: [create-session](../../../../src/app/api/checkout/create-session/route.ts) 987〜1022行（expires_at なし）、finalize の `ITEM_NOT_PUBLISHED`（[retire_item_stock_quantity](../../../../supabase/migrations/20260921121038_retire_item_stock_quantity.sql) 414行）、[webhook-processor](../../../../src/lib/stripe/webhook-processor.ts) 167〜191行。
- **再現経路**: 1画面化でSessionはページを開いた時点で作られ、既定で24時間有効。その間に商品を非公開にすると、開いたままのタブで支払いは完了するが、注文確定は ITEM_NOT_PUBLISHED で失敗する。画面は409、Webhookは例外で永久再試行（R-33）となり、入金済み・注文なしが残る。カート変更で新しい draft を作っても古いSessionは失効させていない。
- **修正方針**: expires_at を短く（30〜60分）設定し、新しい draft を作るとき同じ session_id の古い open Session を失効させる。支払後に確定できない場合の補償（自動返金、または要確認フラグ付きの注文作成）を決める。

### R-26 値引き額の書き戻しでdraftの照合が外れ、再表示が500になる

- **箇所**: [place_order_from_checkout_draft](../../../../supabase/migrations/20260927100300_place_order_from_checkout_draft.sql) と [complete route](../../../../src/app/api/checkout/complete/route.ts)。
- **修正前の再現経路**: 値引きありの支払い後、complete が draft の `total_amount` を値引き後の額へ書き換えると、同じカートの `create-session` が既存 draft と照合できず `CHECKOUT_FINGERPRINT_MISMATCH` になった。
- **修正内容（グループ A）**: `place_order_from_checkout_draft` は注文作成と同じトランザクションで、`discount_amount` だけを Stripe の値へ更新し、`total_amount` は割引前の額のまま残す。照合は `total_amount + discount_amount` と Stripe の割引前合計を比べる。現行の確認は [place_order_from_checkout_draft.integration.test.ts](../../../../tests/integration/db/place_order_from_checkout_draft.integration.test.ts)。

### R-27 customer_email付きで作ったSessionでは updateEmail が例外になり支払えない

> 解消（グループ F）。[入力画面](../../../../src/app/checkout/page.tsx)と[最終確認部品](../../../../src/app/checkout/_components/FinalConfirmationStep.tsx)はupdateEmailを呼ばない。メールは「確認へ進む」で下書きと指紋に固定し、create-sessionがcustomer_emailとして渡す。入力を変えれば別の決済の画面になり、confirm前のupdateEmail例外の経路は無い。以下は変更前の指摘。

- **箇所**: [create-session](../../../../src/app/api/checkout/create-session/route.ts) 1004行、[page.tsx](../../../../src/app/checkout/page.tsx) 1133〜1143行（カート読込後にSession作成）・1433〜1440行（確定直前の updateEmail）・1818行（再試行）。
- **再現経路**: Session作成時の shipping.email が空でないと `customer_email` を送る。ログイン客のプロフィール取得がカート取得より先に終わった場合、「再試行する」を押した場合、失効した draft を作り直した場合に起こる。このSessionで確定すると `updateEmail` が例外になり「メールアドレスの反映に失敗しました」等で支払えない。shipping は fingerprint に含まれないため、同じカートでは同じSessionが再利用され続ける。
- **根拠**: [Stripe Elements with Checkout Sessions 変更ログ](https://docs.stripe.com/checkout/custom-checkout/changelog)（custom_checkout_beta_6）は「updateEmail は、Checkout Session の作成時に customer_email が指定されるとエラーをスローする」「更新できるメールを事前入力するなら customer_email を渡さず updateEmail を呼ぶ」と明記する。
- **確度**: 仕組みは文書で確定。本アカウントの実APIでの再現は未実施（Stripe MCP未認証のため）。
- **修正方針**: custom モードでは customer_email を送らない。事前入力は updateEmail、または confirm の `email` オプションで行う。ログイン客でのE2E（プロフィール先着・再試行）を加える。

### R-28 100%割引で0円Sessionを完了させた後に注文確定を断る

> FREQ-420 により一部修正。以下は変更前の指摘であり、現在の画面では「適用」と「確認へ進む」でサーバーがコードを検証し、合計0円になる割引を拒否する。

- **箇所**: [page.tsx](../../../../src/app/checkout/page.tsx) 1442〜1446行、[complete route](../../../../src/app/api/checkout/complete/route.ts) 299〜319行。
- **事実**: 0円のSessionは注文にしない方針（FREQ-389）だが、画面は確定前に合計0円を止めない。Session は Stripe 上で完了し、プロモーションコードの利用回数も消費されたうえで、客には「注文確定に失敗」と出る。
- **修正方針**: 確定前に `total.minorUnitsAmount === 0` を止めて案内する。プロモーションコード側に最低金額を設定する運用も併記する。
- **対応（グループ F）**: [割引コードの検証](../../../../src/features/checkout/services/promotion-code.service.ts)が`zero_total`を拒否し、[promotion-code](../../../../src/app/api/checkout/promotion-code/route.ts)・[create-session](../../../../src/app/api/checkout/create-session/route.ts)がこの検証を呼ぶ。custom / hosted とも検証済みコードだけを`discounts`で付け、最終確認画面からはコードを変更できない。[place-order](../../../../src/app/api/checkout/place-order/route.ts)も支払い前に受付RPCの`zero_amount`を拒否する。既存の0円Sessionに対する[complete](../../../../src/app/api/checkout/complete/route.ts)の完了後拒否は残るため、台帳は一部修正とする。

### R-29 画面の再試行ボタンとエラー消去の不整合

> 一部修正（グループ F）。決済の準備は「確認へ進む」に統合し、[checkout-api](../../../../src/app/checkout/_lib/checkout-api.ts)が通信の失敗を再試行可能として返し、[入力画面](../../../../src/app/checkout/page.tsx)はretryable:falseのエラー時に「確認へ進む」を無効にする。残りは2点: [create-session](../../../../src/app/api/checkout/create-session/route.ts)のcheckout_amount_mismatchにretryable:falseが無いため、古い表示額で繰り返せること。handleSelectSavedAddressで「新規」を選ぶとsetCheckoutError(null)が在庫切れ等の再試行不可の案内まで消すこと。この波では台帳に残し、修正はしない。

- **箇所**: [create-session](../../../../src/app/api/checkout/create-session/route.ts) 643〜650行、[page.tsx](../../../../src/app/checkout/page.tsx) 945行・793行。
- **事実**: 409 `checkout_amount_mismatch` は retryable を返さず、画面は `retryable ?? true` で「再試行する」を出す。再試行は古い表示金額を送るので同じ409が続く（文言は「再読み込み」を案内）。また保存済み住所で「新規」を選ぶと `setCheckoutError(null)` で在庫切れ等の再試行不可エラーまで消える。
- **修正方針**: 金額不一致に `retryable: false` を付ける。住所選択では配送先由来のエラーだけを消す。PayPay等から戻ったときの create-session 並行実行は未追跡のため本指摘に含めない。

### R-30 resource_missing でそのカートの決済開始が恒久的に500になる

- **箇所**: [create-session](../../../../src/app/api/checkout/create-session/route.ts) 830〜845行、[create-session テスト](../../../../tests/unit/api/checkout/create-session-route.test.ts) 551行・1146行。
- **事実**: draft に保存したSessionを `retrieve` できない（テストキーから本番キーへの切替など）と、例外は再試行可能な500になる。draft は作り直されないので、同じCookieとカートでは抜けられない。本番DBにE2Eの draft が残っているため、公開時の鍵切替で起こり得る。
- **修正方針**: resource_missing では draft を failed にして作り直す。

### R-31 支払後・注文確定前のdraftの配送先を別タブから上書きできる

> グループ F により解消。配送先の後からの同期の入口を廃止したため、以下の変更前の経路は現在は存在しない。

- **箇所**: `src/app/api/checkout/update-shipping/route.ts`（グループ F で削除済み）150〜161行。
- **事実**: 条件は版番号と `status <> 'completed'` だけ。同じCookieの別タブは同じ draft とSessionを使うので、タブAで支払った後、注文確定までの間にタブBの入力で配送先を上書きできる。確定前の書き込みを必須にした FREQ-365 の意図（使う直前の値で確定する）を支払後の区間で崩す。failed の draft も更新できる。
- **修正方針**: 更新を `status = 'created'` かつ Stripe Session が open の場合に限る。支払済みなら409で再読み込みを案内する。
- **対応（グループ F）**: 配送先は[create-session](../../../../src/app/api/checkout/create-session/route.ts)の下書き作成時に保存し、要求の指紋に含める。別タブで配送先を変えると別の下書きになり、古い下書きの配送先は書き換えない。[CHECKOUT詳細設計のFREQ-365](../../../04_DetailDesign/pages/13_checkout.md#配送先の書き込み順freq-365)と同じ扱い。

### R-32 10秒間隔のworker Cronで実行履歴が肥大し、Freeプランの容量上限に達する

- **箇所**: [schedule_stripe_webhook_worker.sql](../../../../supabase/pending/schedule_stripe_webhook_worker.sql) 14〜45行。
- **事実**: 本番は組織プラン free、`cron.log_run=on`、登録済みジョブは retention の2本だけで `cron.job_run_details` の削除ジョブはない（2026-09-25 MCP読取）。既存行は平均194 byte、本ジョブのcommandは約850文字なので1行約1KB、1日8,640行で約8〜9MB増える。現在のDBは59MBで、約50日で500MBを超える。
- **根拠**: Supabase文書 [Upgrading: pg_cron records](https://supabase.com/docs/guides/platform/upgrading) は「pg_cron は履歴を自動では消さない」と明記する。Freeプランは容量超過で read-only になり、注文確定・キュー保存・監査ログが書けなくなる。
- **修正方針**: 同じマイグレーションで job_run_details の定期削除ジョブを登録する。command を private 関数呼び出し1行に縮め、R-35 と合わせて間隔を見直す。

### R-33 Webhookの恒久失敗が上限・退避・通知なしで永久に再試行される

- **箇所**: [add_stripe_webhook_queue.sql](../../../../supabase/migrations/20260925000303_add_stripe_webhook_queue.sql) claim・fail（最大30分間隔で無期限）、[webhook-events.ts](../../../../src/lib/stripe/webhook-events.ts) 100〜131行、[worker route](../../../../src/app/api/cron/process-stripe-webhooks/route.ts) 51〜58行。
- **事実**: 試行回数の上限・dead状態・通知がない。last_error はエラー名だけ（アプリの throw は素の Error なので実質 'Error'）。HEADの受信ルートは処理失敗を監査ログ（`checkout.webhook.event_processing`）に書いていたが、workerは書かない。受信ルートは常に2xxなのでStripe側の配信失敗通知も出ない。HEADの設計書（13_checkout.md「上限超過で DLQ へ退避しアラート通知」）の要件を今回削っている。R-02・R-06・R-25 の経路から到達する。
- **修正方針**: コード付きの例外型で原因を分類して記録し（PIIは入れない）、上限超過で dead へ移して監査ログと警報を出す。処理失敗の監査ログを復活させ、lease 切れも記録する。

### R-34 注文確認メールの送信失敗後に再送する経路がない

- **箇所**: [order-confirmation-email.ts](../../../../src/lib/orders/order-confirmation-email.ts) 155〜174行、[webhook-processor](../../../../src/lib/stripe/webhook-processor.ts) 425〜441行・280〜300行、[complete route](../../../../src/app/api/checkout/complete/route.ts) 430〜457行。
- **事実**: 送信失敗時は送信権を戻して false を返すが、呼び出し側は戻り値を見ない。以後、Stripeの再送はキューで重複扱い、Webhookと complete は注文が既にあれば早期に戻り、掃除ジョブは pending→paid の昇格時しか送らない。Resend の一時失敗だけで確認メールが0通で確定する。FREQ-386「0通や2通にならない」「あとの経路が送れるようにする」を満たさない。R-14 と逆方向の同じ問題。
- **修正方針**: R-14 と共通の永続 outbox を作り、workerが送信・再試行する。

### R-35 workerが1起動1件しか処理せず、集中時に反映が数十分遅れる

- **箇所**: [worker route](../../../../src/app/api/cron/process-stripe-webhooks/route.ts) 22〜50行、[webhook route](../../../../src/app/api/webhook/stripe/route.ts) 52〜61行。
- **事実**: 1回の起動で claim は1回だけ。10秒間隔なので上限は毎分6件。受信ルートは種別を絞らず全イベントを保存する。カード注文1件で最低2イベント、返金は3イベントなので、販売開始直後に数百件が溜まると数十分遅れる。コンビニ・銀行振込の注文作成とメール、返金反映、会計同期が遅れる。
- **修正方針**: 時間予算内で繰り返し claim する。受信ルートから `after()` で即時処理を起動し、Cronは取りこぼし用にする。Stripe側の購読イベントを処理対象に絞る。

### R-36 FREQ-401のカート単体テストが500応答でも成功する

- **箇所**: 当時の `tests/unit/api/cart/route.test.ts` 55〜95行。2026-10-08追記（FREQ-430）: このファイルはカート API の移行で削除済み。以下は移行前の試験についてのレビュー記録として残す。
- **事実**: モックに `insert` がなく、実行ログに `TypeError: cartSupabase.from(...).insert is not a function` が出たうえで3件成功する（2026-09-25 実行）。アサーションが `not.toBe(409)` だけなので500でも通る。
- **修正方針**: insert をモックし、201と投入内容（色・サイズ・数量）を検証する。

### R-37 公開在庫の集計が取得上限で黙って切れ得る

- **箇所**: [availability.ts](../../../../src/lib/items/availability.ts) 58〜63行、[public.ts](../../../../src/lib/items/public.ts) 96〜99行、[config.toml](../../../../supabase/config.toml) 18行（`max_rows = 1000`）。
- **事実**: 件数上限も並び順もない。1ページ最大60商品で1商品あたり17組合せを超えると上限に達し、後ろの商品は誤って「受注生産」になる。本番は現在1商品最大12バリアントなので未発生。
- **修正方針**: 商品単位で集計するRPCかビューに置き換える。

### R-38 注文APIから在庫状態を外したが「予約注文」分岐と仕様が残る

- **箇所**: [OrderItemRow](../../../../src/features/account/components/OrderItemRow.tsx) 18・35〜46行、[account page](../../../../src/app/account/page.tsx) 57行、[types/item.ts](../../../../src/types/item.ts) 28行、FREQ-78。
- **事実**: orders API は stockStatus を返さなくなったので「予約注文」リンクは表示されない死んだ分岐になった。FREQ-78 は在庫状況を返すと書いたまま。
- **修正方針**: 分岐と型を削除して仕様を更新するか、バリアント在庫から返し直すかを決める。

### R-39 在庫欄の行ごとの操作にどの組合せかを示す名前がない

- **箇所**: [ItemStockSection](../../../../src/app/admin/item/ItemStockSection.tsx) 243〜293行。
- **事実**: 各行の「理由・増減・備考・記録する」は同じラベルで、`aria-describedby` も見出し「在庫」を指すだけ。支援技術で操作一覧をたどると、どの色・サイズの操作か分からない（WCAG 2.4.6 / 1.3.1）。動的に挿入する role=alert は主要な支援技術で読み上げられるため指摘に含めない。
- **修正方針**: 行ごとに fieldset/legend を置くか、組合せ名を含む aria-label を付ける。

### R-40 お問い合わせの注文紐付けで ilike のワイルドカードを未エスケープ

- **箇所**: [contact route](../../../../src/app/api/contact/route.ts) 44〜49行。エスケープ済みの実装は [link-guest-orders.ts](../../../../src/lib/orders/link-guest-orders.ts) 113〜125行。
- **再現経路**: zod の email は `______@gmail.com` を通す。`.ilike('shipping_email', email)` で `_` が任意1文字になり、他人の注文番号を知る攻撃者がその注文を「本人の注文」として問い合わせに紐付けられる。管理画面は紐付けを本人確認済みとして表示するため、担当者が注文情報を開示する誘因になる。HEADから存在し、今回の差分は同ファイルのレート制限だけを変更している。
- **修正方針**: link-guest-orders と同じエスケープを行うか、正規化したメールで完全一致させる。

### R-41 バリアント導入前の未入金注文を取り消すと、引当のない在庫が台帳に湧く

- **箇所**: [add_order_items_variant_columns](../../../../supabase/migrations/20260919065442_add_order_items_variant_columns.sql) 11〜34行（`fulfillment_type NOT NULL DEFAULT 'stock'` と既存明細への variant_id 後埋め）、[release_stock_for_unpaid_order](../../../../supabase/migrations/20260921121038_retire_item_stock_quantity.sql) 601〜623行。
- **再現経路**: バリアント導入前の明細は既定値 'stock' と後埋めの variant_id を持つが、引当（purchase）の台帳行は一度も書かれていない。取消時の関数は purchase の有無を確かめずに `variant_id IS NOT NULL AND fulfillment_type='stock'` の明細を 'cancel'（+数量）で追記する。その注文が期限切れ・payment_failed・管理画面キャンセル・未入金掃除ジョブで取り消されると、在庫0のバリアントが「在庫あり」になり、以後の注文が3〜7日発送の約束で受け付けられる。台帳とキャッシュが同時に増えるため `verify_stock_integrity()` でも検知できない。
- **本番の対象**: purchase 行のない 'stock' 明細は pending 2注文・2明細、paid 13注文・16明細（2026-09-25 MCP読取、件数のみ）。pending の2件は取消の経路に乗る。paid の16件は R-16 を「refund 行を書く」方向で直すと同じ問題になる。
- **修正方針**: 取消はその注文の purchase 行を order_item_id 単位で反転して戻す（`-m.delta`）。既存明細の fulfillment_type は、purchase 行がなければ 'backorder' 相当として扱うかを移行で確定し、列の既定値を外す。

### R-42 注文確定とカート数量変更のロック順が逆でデッドロックし得る

- **箇所**: [retire_item_stock_quantity](../../../../supabase/migrations/20260921121038_retire_item_stock_quantity.sql) 402〜416行（finalize: items を FOR UPDATE）→ 545〜549行（carts を DELETE）、同 175〜191行（update_cart_item_quantity_secure: carts を FOR UPDATE → items を FOR SHARE）。
- **事実**: 同じセッションのカート行を注文確定と数量変更が同時に扱うと items→carts と carts→items で待ち合い、Postgres が片方を打ち切る。打ち切られたのが注文確定なら支払済みの客に失敗が返る。在庫判定を廃止したので items の行ロックはどちらも公開状態の確認にしか使っておらず、[lock_items_in_id_order](../../../../supabase/migrations/20260916034433_lock_items_in_id_order.sql) が目指したロック順の統一を満たしていない。
- **修正方針**: 数量変更側の items ロックをやめる（公開状態はロックなしで読む）か、finalize 側を FOR SHARE にする。並行実行のDBテストを加える。

### R-43 注文履歴の起因イベントIDが常に空

- **箇所**: [record_order_revision](../../../../supabase/migrations/20260925000218_add_order_state_transition_rpcs.sql) 44〜61行、[apply_order_refund_projection](../../../../supabase/migrations/20260925000218_add_order_state_transition_rpcs.sql) 221行以降。
- **事実**: トリガーは `app.order_source_event_id` を読むが、設定する処理が src・migrations のどこにもない（grep 0件）。Stripe起因の状態・返金の更新がどのイベントで起きたかを order_revisions からたどれない。列はHEADからあるが、今回Webhook処理をworkerへ移した際も設定していない。
- **修正方針**: 状態遷移RPCに `_source_event_id` を追加し、workerがイベントIDを渡す。

### R-44 在庫を一度でも動かした商品は削除できず汎用500になる

- **箇所**: [add_stock_movements](../../../../supabase/migrations/20260919065355_add_stock_movements.sql) 8行（`variant_id ... ON DELETE RESTRICT`）、[admin item route](../../../../src/app/api/admin/items/[id]/route.ts) 250〜268行。
- **事実**: items→item_variants は CASCADE だが、台帳が1行でもあるバリアントは RESTRICT で消せず、DELETE は 23503 になる。APIは「Failed to delete item」の500を返す。台帳は追記専用なので管理者に回避手段がない。
- **修正方針**: 23503 を理由付きの409に変換し、非公開化を案内する。削除ボタンの表示条件も合わせる。
- **2026-09-27 追記（見せ方の決定）**: 「表示条件を合わせる」はボタンを隠す意味にしない。管理画面の商品一覧（`/admin` の ITEM タブ）の削除ボタンは削除できない商品にも常に出し、押した時点で一覧 API の判定の理由と非公開への誘導を出す。無効化・非表示にはしない（ユーザー決定。グループ A の実装計画 Task 21）。

### R-45 SECURITY DEFINER 3本の search_path が public を pg_catalog より前に置く

- **箇所**: [harden_security_definer_search_path](../../../../supabase/migrations/20260921011535_harden_security_definer_search_path.sql) 36〜43行、[retire_item_stock_quantity](../../../../supabase/migrations/20260921121038_retire_item_stock_quantity.sql) 221行。本番の apply_stock_movement・backfill_item_variants・verify_stock_integrity は `search_path=public, pg_catalog, pg_temp`。
- **事実**: pg_catalog を明示して後ろに置くと、public に作られた同名の関数・演算子が組み込みより優先される。apply_stock_movement は `now()` や `+` を未修飾で使う。public に CREATE できるのは postgres 等だけなので現時点で攻撃経路はない。
- **根拠**: [Supabase Database Functions](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker) は SECURITY DEFINER に `search_path = ''` と完全修飾を推奨する。注文更新RPCについては FREQ-404-REQ-05 が同じ方針を定めており、在庫系だけ外れている。
- **修正方針**: 3本を `search_path = ''` と完全修飾に書き換える。

### R-46 マイグレーションが冪等性の規約に反する

- **箇所**: [fix_guest_rpc_item_id_type](../../../../supabase/migrations/20260921133624_fix_guest_rpc_item_id_type.sql) 31・100・158・188・204行（`CREATE FUNCTION`）、[add_stripe_webhook_queue](../../../../supabase/migrations/20260925000303_add_stripe_webhook_queue.sql) 6〜8・22行（`IF NOT EXISTS`）、[db-migrations.md](../../../06_Operations/db-migrations.md) 168〜190行。
- **事実**: 規約は「関数は冪等にする」「テーブル・列は冪等にしない（想定外なら落ちる）」だが、関数を OR REPLACE なしで作り、列と索引を IF NOT EXISTS で黙って飛ばしている。本番は適用済みで実害はないが、全ファイルを頭から流す環境（同文書16行）で再実行に失敗する、または想定外の既存列を見逃す。
- **修正方針**: 以後のマイグレーションで規約に合わせる。適用済みファイルは書き換えず、規約違反を運用文書に既知事項として残す。

### R-47 見出しのないドロップダウン（/item の並び替え等）が名前を失った

- **箇所**: [SingleSelect.tsx](../../../../src/components/ui/SingleSelect/SingleSelect.tsx) 353〜388行、[PublicItemGrid.tsx](../../../../src/features/items/components/PublicItemGrid.tsx) 750〜767行。管理画面の UserSection（権限）、LookForm（SS/AW）も同じ。
- **事実**: 引き金の `<button>` に `role="combobox"` を付けた。ARIA 1.2 の combobox は名前を作者指定（label・aria-label）からしか取らず、内容（選択中の値）からは取らない。HEADは role なしの button で「新着順」が名前になっていた。label も aria-label もない呼び出しでは名前が空になる（WCAG 4.1.2）。FR-ITEM-ALL-007 は CSS セレクタで要素を探すため検出できない。
- **修正方針**: 呼び出し側に aria-label（「並び替え」等）を付け、dropdown では label か aria-label を型で必須にする。E2E は `getByRole('combobox', { name })` で探す。

### R-48 誤りのあるドロップダウンにフォーカスしても見た目が変わらない

- **箇所**: [SingleSelect.css](../../../../src/components/ui/SingleSelect/SingleSelect.css) 176〜180行（`outline: none` と枠色の変更だけ）、346〜351行（今回追加）。
- **事実**: 誤りの状態ではフォーカス中も枠をエラー色に固定したため、フォーカスの有無で見た目が変わらない。globals.css に共通の focus-visible 指定はない。/checkout で都道府県だけ未入力のまま確定すると、`focusFirstError` がこの引き金にフォーカスを移すが見た目は変わらない（WCAG 2.4.7）。TextField の誤り状態にも同じ作りがある。
- **修正方針**: `:focus-visible` に outline か box-shadow のリングを足し、誤りの枠色と両立させる。

### R-49 管理画面で返金後に表が消えてフォーカスを失い、結果の案内も不安定

- **箇所**: [OrderSection.tsx](../../../../src/components/OrderSection.tsx) 62〜80行・154行、[admin page](../../../../src/app/admin/page.tsx) 190〜192行・511〜526行。
- **事実**: 返金後の `fetchOrders()` が読み込み中の状態を立て、OrderSection は読み込み中に早期 return するので、表と押した「返金」ボタンが一度消えてフォーカスが body に落ちる。結果の案内は条件付きで差し込む `role=status`・`role=alert` のままで、同じ差分で導入した LiveMessage の方針（入れ物を常に置く）と食い違う。行ごとの「配送先要確認」に付けた `role="status"` はライブリージョンの誤用。単体テストは OrderSection をモックに差し替えているため検出できない。
- **修正方針**: 再取得中も表を残し、案内は常に置いた LiveMessage に出す。静的なラベルから role を外す。

### R-50 お問い合わせフォームの必須の示し方がそろっていない

- **箇所**: [contact page](../../../../src/app/contact/page.tsx) 297〜300行・357行、[TextAreaField.tsx](../../../../src/components/ui/TextAreaField/TextAreaField.tsx) 41〜46行。
- **事実**: TextAreaField に必須マーカーの仕組みがなく、メッセージ欄は見出し文字列に「*」を含めるため名前が「MESSAGE / メッセージ *」と読まれる。お問い合わせ内容の SingleSelect は検証上必須だが `required` を渡しておらず、マーカーも aria-required もない。他の欄は aria-hidden の「*」と required で示している（WCAG 3.3.2）。
- **修正方針**: TextAreaField に TextField と同じマーカーを付けて見出しの「*」を消し、SingleSelect に required を渡す。

### R-51 失敗の案内が割り込まない polite で出る箇所がある

- **箇所**: [wishlist page](../../../../src/app/wishlist/page.tsx) 328〜335行、[AccountInquiries](../../../../src/components/AccountInquiries.tsx) 222〜225行、CostProfitSection の各案内。
- **事実**: [設計書](../../../04_DetailDesign/shared/21_design_system.md) 71行は「送信・保存の失敗、カートの操作失敗の Toast」を `role="alert"` と定めるが、これらは成功も失敗も `politeness="status"` の1つの入れ物に出す。wishlist・account・cart のトーストは閉じるボタンも入れ物の中にあり、「閉じる」まで案内として読まれる。
- **修正方針**: 成功と失敗で入れ物を分け、失敗は alert にする。閉じるボタンは入れ物の外に置く。

### R-52 Card の見出しがカードのサイズに追従しなくなった

- **箇所**: [Card.css](../../../../src/components/ui/Card/Card.css) 101〜108行、[Card.tsx](../../../../src/components/ui/Card/Card.tsx) 25〜28行、[globals.css](../../../../src/styles/globals.css) 775〜780行。
- **事実**: `.card__label` を共通トークン `--lk-label-size` に変えたが、トークンを再宣言する `[data-ui-size]` が Card のルートにない（Card は `data-ui-card-size` を使う）。見出しは祖先か :root の値（md 基準で約11.4px）になり、xs のカードでも縮まない。FR-UI-005 の確認対象に `.card__label` がないため検出できない。
- **修正方針**: Card のルートに `data-ui-size` を付けるか、`[data-ui-card]` で `--lk-label-size` を再宣言する。FR-UI-005 に Card を加える。

### R-53 Footer のレイアウト変更に要求と E2E がない

- **箇所**: [Footer.tsx](../../../../src/components/Footer.tsx) 50〜64行。
- **事実**: 左右余白の `px-[10%]` 化、FOLLOW US の `col-span-2`、md の間隔変更に対応する FREQ 行が spec.md の差分になく、E2E も追加されていない。プロジェクトの要求管理ルール（.claude/CLAUDE.md）に反する。
- **修正方針**: FREQ 行と3ビューポートの E2E を追加する。

### R-54 固定CTAの案内のE2Eが「見えている」ことを確かめなくなった

- **箇所**: [FR-ITEM-DETAIL-062](../../../../e2e/FR-ITEM-DETAIL-062-persistent-mobile-cta.spec.ts)。
- **事実**: 案内の入れ物を常に置く方式に合わせ、`toBeVisible()` を `toHaveText(/\S/)` に置き換えた。文言が入っても見た目が隠れたまま（sr-only のまま）という不具合を検出できない。
- **修正方針**: `toHaveText` と `toBeVisible` の両方を確かめる。

### R-55 E2E が実際に決済を確定し、テストWebhookを登録すると本番DBに注文を作る

- **箇所**: FR-CHECKOUT-029（グループ F で削除。当時の 10〜11行・73〜114行）、[webhook-processor](../../../../src/lib/stripe/webhook-processor.ts)（livemode の照合なし）。
- **事実**: テストカードで `checkout.confirm()` まで実行し、Stripe のテスト決済を完了させる。スペックは「注文する」を押さないので注文と在庫は変えないとするが、それは Stripe テストモードの Webhook が0件（2026-09-17 時点）だから成り立つだけ。テスト用 Webhook を登録するか `stripe listen` を動かすと、E2E が本番 Supabase を使う現状では、実行のたびに本番DBへ注文・在庫の出庫・example.com 宛のメールが作られる。
- **修正方針**: Webhook 処理で `event.livemode` と実行環境を照合する。E2E の前提（テスト用 Webhook を登録しない）をスペックと README に明記し、長期的には E2E 用のDBを分ける。
- **2026-09-27 追記（pre-push の E2E）**: [scripts/hooks/pre-push](../../../../scripts/hooks/pre-push) は `npx supabase db reset` でローカル DB を作り直してから E2E 全件を流すが、アプリは `.env.local` の本番 Supabase（pjidrgofvaglnuuznnyj）を使う。ローカル Supabase が動いていると db reset が成功し、push のたびに E2E が本番へ書き込む。ローカルが止まっていれば db reset が失敗し、警告だけで E2E を飛ばす（2026-09-27 時点はこちら）。E2E 用の接続先をローカルに切り替えるまで、フックの E2E は本番に向かう前提で扱う（B で直す）。
- **2026-10-05 追記（グループ B 計画1）**: E2E と pre-push を手元の Supabase に切り替え、見張りが本番の住所・本番の鍵・外へのメール・確かめられない3000番のアプリを拒むようにした（[計画1](../../../superpowers/plans/2026-10-05-e2e-local-supabase.md)）。アプリのメールは手元の Mailpit に届く。受け取り口で `livemode` を確かめるのは計画2。

### R-56 「確認へ進む」で支払いが確定し、戻る・再読込の後は決済フォームが出ず先へ進めない

- **出所**: 2026-09-25 ユーザー報告。「確認へ進む」の後に確定せず戻ると、支払方法の欄に「決済フォームを準備しています...」「この決済セッションは既に確定処理へ進んでいます。」が出て、「確認へ進む」が押せなくなる。
- **箇所**: [page.tsx](../../../../src/app/checkout/page.tsx) 1390〜1463行（「確認へ進む」の処理が `checkout.confirm()` で支払いを実行してから step 2 へ進む）、579行（段階は画面の状態だけで持つ）、2041行（決済フォームは step 1 だけ描画）、2120行（支払後の確認画面には「戻る」がない）、[create-session](../../../../src/app/api/checkout/create-session/route.ts) 903〜915行（完了済み Session には `retryable: false` の409）、[1画面化の設計書](../../../superpowers/specs/2026-09-11-checkout-single-step-design.md) 75行（`checkout.confirm()` → 成功で step 2 へ、を設計として決めている）。
- **再現経路**: 「確認へ進む」でカードは引き落とされ、コンビニは払込票が出る。確認画面でブラウザの戻る・再読込・カートからの入り直しをすると、段階は step 1 に戻る。カートは注文確定まで消えないので同じ下書きを取り、Stripe 上は完了済みの Session を掴んで409になる。再試行ボタンも出ず、決済フォームは描画されない。
- **影響**: 支払った客が注文を確定できない。画面からは注文が作られず、Webhook の稼働後は Webhook が注文とメールを作るので、客の認識（戻った＝注文していない）と食い違う。カートを変えると新しい Session で再び支払える（二重払い）。X-3（特定商取引法12条の6の最終確認画面）と同じ根本原因で、最終確認の前に支払いが確定している。
- **修正方針**: 支払いの実行を「注文する」へ移す。確認画面は決済フォーム（Payment Element）をマウントしたまま確認内容を示し、「注文する」で `confirm()` → 注文作成 → 在庫確保 → メール送信を一度に行う（[Stripe.js confirm](https://docs.stripe.com/js/custom_checkout/confirm) は既定でマウント中の Payment Element から支払い方法を読む）。入り直しで完了済みの Session を見つけたときは、409 で止めずに注文の状態を示す画面へ案内する。在庫を「注文の確定時（メール送信と同時）」に確保するというユーザー要望は、この変更で成り立つ。
- **対応（グループ F）**: 支払いを最終確認画面の「注文する」に移した。「確認へ進む」では決済の画面を作るだけで、お金は動かない。支払いの後に入り直すと、入り直しの入口が注文の確定を仕上げて「ご注文は確定しています」を出す（[設計書](../../../superpowers/specs/2026-10-07-checkout-place-order-payment-design.md)、[実装計画](../../../superpowers/plans/2026-10-07-checkout-place-order-payment.md)）。

### R-57 コンビニの支払期限が /legal と Stripe の設定で食い違う

- **出所**: 2026-09-27、グループ A の計画づくりの中で確認。
- **箇所**: [legal/page.tsx](../../../../src/app/legal/page.tsx) 95行（「ご注文から7日以内」）、[create-session](../../../../src/app/api/checkout/create-session/route.ts) 1006行（`expires_after_days: 3`。コミット済みのコードは未指定で、Stripe の既定値の3日）、[決済手段の動的化の設計書](../../../superpowers/specs/2026-09-12-checkout-dynamic-payment-methods-design.md) A-3（3日と決定）、[spec.md](../../../02_Requirements/requirements.md) の FREQ-106（7日。定数で一元管理し /legal と同期）。
- **影響**: 特定商取引法で表示が必要な支払時期（/legal）より、実際の期限が短い。7日と読んだお客様が注文日の4日後以降に払おうとすると、払込票が切れている。本番は未公開のため実害なし。
- **根拠**: [Stripe コンビニ決済](https://docs.stripe.com/payments/konbini/accept-a-payment?payment-ui=checkout)（既定3日・1〜60日、期限日の 23:59:59 まで）、[消費者庁 通信販売の広告表示](https://www.no-trouble.caa.go.jp/what/mailorder/advertising.html)。
- **修正方針**: 期限は7日（2026-09-27 ユーザー決定。根拠は[グループ A 設計書](../../../superpowers/specs/2026-09-26-order-payment-reconciliation-design.md)の 5-7）。日数を定数1つに置き、create-session と /legal の両方が読む（FREQ-106-REQ-01）。グループ A の実装計画 Task 7 で直す。

## 対処計画（R-01 近傍のグループ）

2026-09-25 にユーザー承認。R-01 と同じコード（Webhook の処理本体・worker・注文の状態を変えるRPC）に関わる指摘を、同じ関数を何度も直さないようにまとめた。各グループは brainstorming（設計）→ 仕様書 → writing-plans → テスト先行の実装の順に進める。

| 順 | グループ | 指摘ID | 状態 |
| --- | --- | --- | --- |
| 1 | A 支払状態を Stripe の現在値に合わせる | R-01, R-02, R-04, R-18, R-25（Webhook 側）, R-41, R-42, R-43, R-44（①の削除の案内と同じ箇所のため 2026-09-25 に移した）, R-57（create-session の同じ箇所を直すため 2026-09-27 に加えた） | 実装済み・push 待ち（[設計書](../../../superpowers/specs/2026-09-26-order-payment-reconciliation-design.md)、[実装計画](../../../superpowers/plans/2026-09-27-order-payment-reconciliation.md)。本番へ当てる前の確認は下の「グループ A を本番へ当てる前の確認」） |
| 2 | F 支払いを「注文する」で実行する | R-56, X-3, 在庫を注文確定時に確保する要望 | 実装済み・push 済み（[設計書](../../../superpowers/specs/2026-10-07-checkout-place-order-payment-design.md)、[実装計画](../../../superpowers/plans/2026-10-07-checkout-place-order-payment.md)）。DB の変更は 2026-10-07 に本番へ適用済み（20261007133711）。開店の前に、特定商取引法の表示を専門家に確かめてもらう（X-3） |
| 3 | B キューと worker の運用基盤 | R-07, R-33, R-32, R-05, R-35, R-55, X-4 | 実装済み・push 済み（[設計書](../../../superpowers/specs/2026-10-05-webhook-queue-operations-design.md)、[実装計画1（E2E）](../../../superpowers/plans/2026-10-05-e2e-local-supabase.md)、[実装計画2](../../../superpowers/plans/2026-10-05-webhook-queue-operations.md)。DB の変更は 2026-10-07 に本番へ適用済み（20261007030242・20261007030336）。定期処理の登録は開店のとき（[手順書](../../../06_Operations/webhook-queue-operations.md)）） |
| 4 | C 注文確定RPC（finalize）の整合 | R-24, R-26（R-42 は同じ箇所を直す A へ移した） | 実装済み（[設計書](../../../superpowers/specs/2026-10-08-order-owner-binding-design.md)、[実装計画](../../../superpowers/plans/2026-10-08-order-owner-binding.md)）：R-26 はグループ A で修正。R-24 は「注文する」で確かめた会員を持ち主として書く形で解消（完了での紐付けは廃止）。DB の変更（20261008055720）は 2026-10-08 に本番へ当てた |
| 5 | D 注文メールを確実に送る | R-34, R-14 | 未着手 |
| 6 | E 返金イベントの反映 | R-06, R-16（業務判断が要る）, R-03 は任意 | 未着手 |
| 未定 | H プロモーションコードの管理（ユーザー要望。2026-09-27） | 管理画面でコードを作成・停止する。期限・全体の回数上限・最低購入額は Stripe の制限で効く。初回限定は、Customer を作らない今の決済では Stripe が誰でも初回とみなすため効かない。1人あたりの回数上限は Stripe に無い。この2つは自前で確かめる。0円になるコード（100%割引、割引額以下の最低購入額）は作らせない | 順番は未定 |
| 未定 | G 在庫・注文・発注の管理画面（ユーザー要望） | 色×サイズごとに「販売できる在庫」「在庫に対しての注文数」「受注生産の注文数」を管理し、発注に使う。関連: R-09, R-10, R-15, R-39 | 順番は未定 |

決定事項（A の設計中に確定）:

- 支払後に注文を確定できないとき（R-25）: 注文を作らずに「要対応」として記録・通知し、返金は店が決める。非公開・削除の商品も注文を作らない（2026-09-25 に変更。①で決済を自動で失効させるので、非公開・削除と支払いが数秒で重なった場合だけ起きる）。金額・通貨の食い違い、下書きが無い場合も同じ。
- 在庫の確保: カートでは確保しない。注文を作った時点で確保する。コンビニ払いの期限は7日（2026-09-27 に3日から変更。R-57）。在庫を戻すのは、当店の時計ではなく Stripe が失敗を確定したとき。銀行振込は Session に Customer を指定していないため使えず、期限は定めない。
- 在庫の確保を「注文の確定（メール送信）」の時点に合わせるため、支払いの実行を「注文する」へ移す（F）。
- 方式: Stripe の現在値に合わせる照合関数を1つ作る（方式1。Stripe の注文フルフィルメント手順に一致）。
- お客様へのメール（2026-09-25 決定。Shopify・ZOZOTOWN との比較から）: 払込期限が切れたら期限切れのお知らせを送る（コンビニ払い。銀行振込は今の決済画面では使えないため、使えるようにする時に同じ仕組みに載せる）。店が注文を取り消したら取消のお知らせを送る。返金したら返金のお知らせを送る。
- 支払い後に注文を作れない状態: Shopify と同じく、支払いと注文作成を一体にして起きないようにする（2026-09-25 決定）。仕組みは「注文を先に受け付けてから支払う」（2026-09-25 承認）。「注文する」でサーバーが商品・金額・下書きを確かめ、「支払い手続き中」の注文を作って在庫を確保してから支払う。決済画面の放棄は30分で自動的に「放棄」にして在庫を戻す（メールなし・一覧に出さない）。Stripe の手動キャプチャーはコンビニ払い・PayPay・銀行振込で使えないため採らない。
- 人の作業を減らす自動化（A に含める）: ① 決済中の商品を非公開・削除したら、その商品を含む開いている決済を自動で失効させ、決済中・注文済みの商品は削除させず非公開へ誘導する。⑤ 失敗にした注文に後から入金があれば自動で入金済みにし、在庫があれば確保し直し、足りないときだけ要確認にする。人の作業が残るのは、不具合による金額の食い違いと、非公開・削除と支払いが数秒で重なった場合（どちらも要対応）、失敗後の入金で在庫が足りない場合（要確認）だけ。注文と支払いの矛盾は RPC 限定で起きなくし、起きたら警報を出す。
- 設計の第2〜4節（受付を先にする方式に合わせた改訂版。2026-09-25 承認）: 注文の状態に「支払い手続き中（payment_in_progress）」「放棄（abandoned）」を加える。PaymentIntent は Session の支払い確定時にできる（Stripe API 2022-08-01 以降）ため、`orders.payment_intent_id` は空から値へ1回だけ書けるようにし、`checkout_session_id` は空を除いて一意にして照合はこの列で注文を引く（本番16件に重複なし）。受付後に商品が非公開・削除されても注文は残し、①の自動失効は受付前の決済だけに行う。受付を通らずに支払われた場合だけ、照合が同じ受付 RPC で注文を作り、作れなければ要対応にしてお客様へ案内を1回送る。
- 設計の第5節（テストと公開の手順。2026-09-25 承認）: テストを先に書く。DB 結合はローカル Supabase で、E2E は API をモックして本番 DB に書かない。メールは単体テストで確かめる。マイグレーションは enum 値の追加だけの1本と、それ以外の1本に分ける（enum 値は消せないので名前はこの設計で確定）。本番に当てる直前に Session ID の重複0件を読み直す。R-04 の不足分は保留中の第2段階に足す。未入金の掃除は照合の見回り（毎時）に変え、Cron の本番登録は B で行う。本番の未入金2件（2026-03-20）は移行時にメールを「送信済み」として登録し、メールを送らない。R-44 は①と同じ API・同じ案内なので A に移す。
- 設計書を書いた後の論点1〜8（2026-09-27 確認。詳細は[設計書](../../../superpowers/specs/2026-09-26-order-payment-reconciliation-design.md)）:
  1. 完了 API も照合関数を呼ぶ。
  2. 0円の注文は FREQ-389 どおり断る。
  3. 注文があるのに Stripe の状態が想定外なら要対応にし、解決の操作で未入金の注文を取り消せる。
  4. 支払額の食い違いは F で起きなくする（割引コードはサーバーが付ける）。起きたら入金済みと要対応にし、解決まで発送不可。自動で返金する設定は E（既定オフ）。
  5. 取消の注文への入金は要対応。自動で返金する設定は E（既定オン）。
  6. 取消の画面は Shopify に合わせる（理由の選択は必須、お知らせは既定で送り外せる）。
  7. 決済画面は開いてから30分を超えたら失効（Stripe には30分30秒を渡す）。見回りは毎時で、受付 API（グループ F）が支払いの前に注文を作るようになった後は、Webhook が届かなくても最長90分で在庫が戻る（今は注文を支払いの後に作るので、放棄された決済は在庫を押さえない）。
  8. 在庫を戻す関数は注文 ID で引く形にし、古い定義は同じ変更で消す。
- 実装計画の後の決定（2026-09-27）:
  - コンビニ払いの期限は7日。Stripe・KOMOJU の既定値と ZOZOTOWN・Amazon は3日、BASE は5日、楽天市場は7日。OWASP OAT-021 にも特定商取引法にも日数の基準は無い。受注生産が中心で在庫を押さえる害が小さいため、よく使われる範囲の上限にする（R-57）。
  - 削除できない商品の削除ボタンは常に出し、押した時点で理由と非公開への誘導を出す（無効化・非表示にしない。R-44）。

### グループ A を本番へ当てる前の確認

マイグレーション10本（`20260927100000`〜`20260927100900`）は、master へ push すると CI（`.github/workflows/db-migrations.yml`）が本番へ当てる。本番へは Supabase MCP で読むだけにする（`list_migrations`、`execute_sql` は SELECT のみ、`get_advisors`）。

| 時点 | 読むもの | 期待 |
| --- | --- | --- |
| push の直前 | `list_migrations` | 最新が `20260925000303` のまま（違えば、台帳にあってファイルに無い version で `db push` が止まる。押し通さず、ユーザーに知らせる） |
| push の直前 | `select checkout_session_id, count(*) from public.orders where checkout_session_id is not null group by 1 having count(*) > 1;` | 0行（`orders_checkout_session_id_key` を作れる） |
| push の直前 | `select relacl from pg_class where oid = 'public.orders'::regclass;` と `select attname, attacl from pg_attribute where attrelid = 'public.orders'::regclass and attnum > 0 and not attisdropped and attacl is not null;` | `20260901102912_remote_schema.sql` の事前 GRANT からの期待値は、relacl が postgres grantor による postgres・anon・authenticated・service_role の付与だけ（PUBLIC なし）、列 ACL は0行。適用前のローカル値は現時点で確認できない。PUBLIC または別の grantor による付与は、この移行の REVOKE 後も残る |
| push の直前 | 下の `public.orders` のトリガーの SELECT | 5行（`protect_legal_order_delete`・`protect_legal_order_immutable_fields`・`record_order_revision`・`reject_shipping_without_address`・`trigger_orders_updated_at`）。`enforce_order_payment_invariants` は無い（保留中の第2段階 `supabase/pending/harden_order_state_transitions.sql` が作る）。`information_schema.triggers` で数えると、`reject_shipping_without_address` が INSERT と UPDATE の2行になるので6行 |
| push の直前 | `select count(*) from public.orders where status = 'pending' and checkout_session_id is null;` | 2（2026-03-20 の移行前の未入金。2でなければ push せず、件数と作成日時をユーザーに知らせる） |
| push の直前 | `select count(*), min(created_at), max(created_at) from public.orders where status = 'pending';` | 2件まで（上の移行前の2件だけ。`checkout_session_id` の有無を問わず数える）。E2E が本番に書いた入金待ちの注文が残っていれば、最初の見回りで `payment_expired` のメールや `stripe_object_missing` の要対応になる。2件より多ければ push せず、件数と作成日時をユーザーに知らせる |
| 当てた後（照合・見回りを流す前） | `select count(*) from private.order_emails as e join public.orders as o on o.id = e.order_id where o.status = 'pending' and o.checkout_session_id is null;` | 8（移行前の2件 × お客様向けメール4種。`20260927100500_payment_exceptions.sql` の `private.suppress_legacy_unpaid_order_emails()` が送信済みとして登録する。照合を流すと2件は入金待ちでなくなりうるので、その前に読む） |
| 当てた後 | `select enumlabel from pg_enum where enumtypid = 'public.order_status'::regtype order by enumsortorder;` | 7行（`payment_in_progress`・`pending`・`paid`・`failed`・`abandoned`・`cancelled`・`shipped`） |
| 当てた後 | `select conname from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_checkout_session_id_key';` | 1行 |
| 当てた後 | 下の関数の権限の SELECT | 14行。どれも `anon`・`authenticated` が false、`service_role` が true（古い定義が残っていれば行が増える） |
| 当てた後 | `select c.relrowsecurity, p.policyname, p.permissive, p.roles from pg_class as c left join pg_policies as p on p.schemaname = 'public' and p.tablename = c.relname where c.oid = 'public.payment_exceptions'::regclass;` | 1行（true・`deny direct client access`・`RESTRICTIVE`・`{anon,authenticated}`） |
| 当てた後 | 下の `payment_exceptions` の表の権限の SELECT | 3行。`anon`・`authenticated` は `can_select`・`can_do_more` とも false（何も無い）、`service_role` は `can_select` が true・`can_do_more` が false（SELECT だけ） |
| 当てた後 | 下の `public.orders` の店内の列の SELECT | 2行（`anon`・`authenticated`）。どちらも `unreadable_columns` が `cancel_note, cancel_notify_customer, cancel_reason, reviewed_by` の4列だけ（ほかの列は読める。`20260927100900_hide_internal_order_columns.sql` が隠す。取消のメモ・理由を、注文の持ち主やゲストに読ませないため） |
| 当てた後 | `get_advisors`（security） | 新しい警告が0件 |

```sql
select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'place_order_from_checkout_draft', 'mark_order_paid', 'mark_order_awaiting_payment',
    'release_stock_for_unpaid_order', 'record_payment_exception', 'claim_payment_exception_notification',
    'release_payment_exception_notification', 'resolve_payment_exception', 'mark_order_reviewed',
    'admin_cancel_failed_order', 'admin_ship_paid_order', 'reserve_checkout_session_expiry',
    'find_open_checkout_sessions_for_item', 'item_delete_blockers'
  )
order by p.proname;
```

上の表の「`public.orders` のトリガーの SELECT」:

```sql
select t.tgname
from pg_trigger as t
where t.tgrelid = 'public.orders'::regclass
  and not t.tgisinternal
order by t.tgname;
```

上の表の「`payment_exceptions` の表の権限の SELECT」:

```sql
select r.rolname,
       has_table_privilege(r.rolname, 'public.payment_exceptions', 'SELECT') as can_select,
       has_table_privilege(r.rolname, 'public.payment_exceptions',
                           'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as can_do_more
from pg_roles as r
where r.rolname in ('anon', 'authenticated', 'service_role')
order by r.rolname;
```

上の表の「`public.orders` の店内の列の SELECT」（読めない列だけを並べる。店内の4列以外が出たら、新しい列に `GRANT SELECT` を足し忘れている）:

```sql
select r.rolname,
       string_agg(a.attname, ', ' order by a.attname collate "C") as unreadable_columns
from pg_roles as r
cross join pg_attribute as a
where r.rolname in ('anon', 'authenticated')
  and a.attrelid = 'public.orders'::regclass
  and a.attnum > 0
  and not a.attisdropped
  and not has_column_privilege(r.rolname, 'public.orders', a.attnum, 'SELECT')
group by r.rolname
order by r.rolname;
```

- 本番の環境変数に `SHOP_ALERT_EMAIL` を足す（未設定なら店への要対応メールを送らず、毎時の見回りが送り直す）
- 保留中の SQL（見回りの毎時の登録 `supabase/pending/schedule_expire_pending_orders.sql`・R-04 の第2段階 `supabase/pending/harden_order_state_transitions.sql`）は、今までどおり明示の承認を得てから当てる
- 公開前に照合を1回流し、移行前の未入金2件の結果を確かめる（設計書 7-1）
- 公開前の最初の見回りは、移行前の2件を作った Stripe のモード（テストか本番か）のキーで流す（違うと2件とも `stripe_object_missing` になる）

## 追加レビュー（2回目・Claude Code）

R-01〜R-14 記録後にコード変更なし（src/supabase/tests/e2e/scripts の更新時刻が本台帳 11:04 より新しいファイル 0件）を確認してから開始。5領域（Checkout / Webhook・決済 / DBマイグレーション / 注文・在庫・カートAPI / UI・ツール）を並列レビューし、出た候補はすべて下表に記録、周辺コード・一次資料で検証して「妥当 / 却下 / 要確認」を付ける。妥当なものだけ R-15 以降の本指摘へ昇格する。

### 候補メモ（検証前を含む全件）

| 候補 | 出所 | 概要 | 検証結果 |
| --- | --- | --- | --- |
| O-1 | 注文・在庫 | 色・サイズとバリアントの同期が管理画面の在庫欄GET時だけ。新商品は購入でNULL variant・受注生産集計から漏れる | 妥当 → R-15 |
| O-2 | 注文・在庫 | 未発送の全額返金で cancelled になっても引当在庫を台帳へ戻さない | 妥当 → R-16 |
| O-3 | 注文・在庫 | ウィッシュリストAPIが madeToOrder を返さず「受注生産」が出ない | 妥当 → R-17 |
| O-4 | 注文・在庫 | 管理者の pending キャンセルで order_revisions に実行者が残らない | 妥当 → R-18 |
| O-5 | 注文・在庫 | カート加算後の1行数量に上限検査がない | 妥当 → R-19 |
| O-6 | 注文・在庫 | 在庫増減APIの z.coerce・上限なし・理由と符号の不整合・冪等キーなし | 妥当 → R-20 |
| O-7 | 注文・在庫 | 重複した色・サイズ名を保存でき、在庫欄が500で使えなくなる | 妥当 → R-21 |
| O-8 | 注文・在庫 | FREQ-401 カート単体テストが500でも成功する | 妥当 → R-36（実行ログに `insert is not a function`、3件成功） |
| O-9 | 注文・在庫 | 公開在庫集計が PostgREST max_rows で黙って切れ得る | 妥当（潜在） → R-37（config.toml の max_rows=1000、1ページ最大60商品） |
| O-10 | 注文・在庫 | 注文APIから stockStatus を外したが「予約注文」分岐と仕様が残る | 妥当 → R-38 |
| O-11 | 注文・在庫 | 在庫欄のエラー通知方式と行ごとの操作名がない（a11y） | 一部妥当 → R-39（行ごとの操作名のみ。動的挿入の role=alert は主要ATで読み上げられるため除外） |
| O-12 | 注文・在庫 | お問い合わせの注文紐付けで ilike の `_` がワイルドカード（HEADから存在） | 妥当・既存 → R-40 |
| W-1 | Webhook・決済 | 10秒間隔のworker Cronが cron.job_run_details を肥大させ、Freeプランで約7週間後に read-only | 妥当 → R-32（本番: plan=free、cron.log_run=on、履歴削除ジョブなし。Supabase文書: pg_cron は履歴を自動削除しない） |
| W-2 | Webhook・決済 | 恒久失敗が上限・dead状態・通知なしで永久再試行。last_error は 'Error' だけで監査も消えた | 妥当 → R-33（HEADの設計書にあったDLQ・アラート要件を削除） |
| W-3 | Webhook・決済 | メール送信失敗で送信権を戻しても再送経路がなく、確認メール0通で確定 | 妥当 → R-34（FREQ-386「0通や2通にならない」を満たさない） |
| W-4 | Webhook・決済 | workerは1起動1件。最大毎分6件で、販売開始時に数十分遅延 | 妥当 → R-35 |
| C-1 | Checkout | `requireCsrfOrDeny` の拒否判定が `'_body' in value` で、403応答を見落としCSRF検査が無効 | 妥当 → R-22（`'_body' in NextResponse.json(...)` は false を実測。HEADから存在） |
| C-2 | Checkout | Stripe 500系が同じ冪等キーで24時間再生され、そのカートで決済を始められない | 妥当 → R-23 |
| C-3 | Checkout | ログイン客の注文が通常経路で user_id に紐付かず注文履歴に出ない | 妥当 → R-24（通常経路はHEADから。差分でフォールバック経路を削除） |
| C-4 | Checkout | expires_at 未設定。放置タブから非公開化後の商品を支払うと入金済み・注文なし | 妥当 → R-25 |
| C-5 | Checkout | 値引き額の total_amount 書き戻しで claim の照合が外れ、再表示が恒久500 | 妥当 → R-26 |
| C-6 | Checkout | customer_email を取得順しだいで送り、Stripe側でメール変更不可に固定 | 妥当・重大度引上げ → R-27（Stripe変更ログ: customer_email 指定Sessionでは updateEmail が例外。確定不能になる） |
| C-7 | Checkout | 100%割引で0円のSession完了後に注文確定を断る | 妥当 → R-28 |
| C-8 | Checkout | 画面の再試行・エラー表示の不整合（金額不一致に retryable:false なし等） | 一部妥当 → R-29（PayPay復帰時の並行作成は未追跡のため除外） |
| C-9 | Checkout | resource_missing でそのカートが恒久500 | 妥当 → R-30 |
| C-10 | Checkout | 注文確定前の draft の配送先を別タブから上書きできる | 妥当 → R-31 |
| R-11 異論 | Checkout | 画面は confirm({returnUrl}) を渡すので Session 作成は失敗しない | 異論妥当 → R-11 を P3 に訂正（設計書の実測と Stripe.js confirm 仕様） |
| D-1 | DB | variant導入前の pending 明細（既定 'stock'＋後埋め variant_id）を取り消すと purchase なしで cancel が書かれ在庫が湧く | 妥当 → R-41（本番に該当 pending 2注文・2明細、paid 13注文・16明細を読取で確認） |
| D-2 | DB | 注文確定（items→carts）とカート数量変更（carts→items）のロック順が逆でデッドロック | 妥当 → R-42 |
| D-3 | DB | order_revisions.source_event_id を設定する処理がなく常に NULL | 妥当・既存 → R-43 |
| D-4 | DB | 在庫台帳のある商品は ON DELETE RESTRICT で削除できず汎用500 | 妥当 → R-44 |
| D-5 | DB | キュー導入前の failed/processing 行が worker 起動時に再生される | 却下（本番のキューは completed 1件のみ。旧同期ハンドラは本番未デプロイで対象行が生じない） |
| D-6 | DB | SECURITY DEFINER 3本の search_path が public, pg_catalog の順 | 妥当（多層防御） → R-45（本番 proconfig で3本を確認。public への CREATE は postgres 等に限られ現時点で経路なし） |
| D-7 | DB | マイグレーション規約違反（CREATE FUNCTION の非冪等、IF NOT EXISTS）とローカル台帳のずれ | 一部妥当 → R-46（ローカル台帳のずれは本番に影響しないため除外） |
| D-8 | DB | 一意索引と先頭列が重複する冗長索引3本 | 妥当（Nit・記録のみ。performance advisor も item_variants_item_id_idx を未使用と報告） |
| R-04 追加 | DB | authenticated が orders/order_items に INSERT・TRUNCATE も持ち、保留中の harden は UPDATE しか剥がさない | 妥当 → R-04 に追記（本番の権限・policy を読取で確認） |
| U-1 | UI | SingleSelect を role=combobox にしたため、見出しなしの並び替え等が名前を失う | 妥当 → R-47（ARIA 1.2 の combobox は名前を内容から取らない） |
| U-2 | UI | エラー中の combobox にフォーカスしても見た目が変わらない | 妥当 → R-48（globals.css に focus-visible の共通指定なし） |
| U-3 | UI | 管理画面の返金後に表が消えフォーカス喪失、結果が読み上げられない | 妥当 → R-49 |
| U-4 | UI | お問い合わせの必須表示が TextAreaField・SingleSelect で不統一 | 妥当 → R-50 |
| U-5 | UI | SingleSelect を開いてすぐ Tab で先頭項目が黙って選ばれる | 却下（WAI-ARIA APG の select-only combobox の既定動作どおり。空の選択肢を先頭に置くかは画面ごとの設計判断） |
| U-6 | UI | 商品詳細の納期表示の切替が読み上げられない | 却下（選択に伴う内容の変化で、WCAG 4.1.3 の status message に当たるとは言い切れない。改善提案として記録のみ） |
| U-7 | UI | 失敗案内が polite のまま、閉じるボタンが読み上げ枠の中 | 妥当 → R-51（設計書 21_design_system.md 71行「失敗は role=alert」に反する） |
| U-8 | UI | Card の見出しがカードのサイズに追従しなくなった | 妥当 → R-52 |
| U-9 | UI | Footer のレイアウト変更に FREQ 行と e2e がない | 妥当 → R-53（spec.md の差分に該当行なし） |
| U-10 | UI | e2e の検証が弱くなった箇所（FR-ITEM-DETAIL-062、FR-UI-008 AC-04） | 一部妥当 → R-54（FR-ITEM-DETAIL-062 のみ。AC-04 は否定の確認として成立） |
| U-11 | UI | FR-CHECKOUT-029 が confirm まで実行し、webhook 登録時に本番へ注文を作る | 妥当（条件付き） → R-55（webhook-processor に livemode の照合なし） |
| X-1 | UI（差分外） | UserSection の権限ドロップダウンは onChange を渡すが、dropdown は onValueChange しか呼ばず権限を変更できない | 妥当・差分外（HEADの SingleSelect も同じ。別タスクへ） |
| X-2 | UI（差分外） | /auth/verified の認証要素選択は native の SingleSelect に onValueChange を渡すが、native 分岐は呼ばず既定の要素から切り替えられない | 妥当・差分外（HEADから同じ。複数要素の管理者が別要素で検証できない。別タスクへ） |
| X-3 | Checkout（差分外） | 「確認へ進む」で課金が確定し「注文する」は後に来るため、特定商取引法12条の6の最終確認画面の要件を満たすか | 要確認（法務判断。HEADと同じ2段構成。表示項目の確認は未実施）。画面は対応（最終確認画面「注文内容の最終確認」に第12条の6 の項目を出し、申し込みと同時に支払う。グループ F）。要件を満たすかの最終判断は開店の前に専門家へ |
| Y-1 | ユーザー報告 | 「確認へ進む」の後に確定せず戻ると「決済フォームを準備しています...」「この決済セッションは既に確定処理へ進んでいます。」で先へ進めない | 妥当 → R-56（再現経路をコードで確認。X-3 と同じ根本原因）。グループ F で解消（確認へ進むでは支払わず、支払いの後の入り直しは注文の状態を出す） |
| X-4 | Cron（差分外） | stripe-reconcile の CRON_SECRET 照合が `!==` で定数時間比較でない（他の Cron は timingSafeEqual） | 妥当・差分外（[stripe-reconcile/route.ts](../../../../src/app/api/cron/stripe-reconcile/route.ts) 30行。グループA設計中に発見。グループBで Cron 認証をそろえる） |
| 追加証拠 | Webhook・注文 | R-01: worker が最大約6本並行し SKIP LOCKED で同じ PaymentIntent のイベントも並行処理される。R-06: 注文が pending/failed でも返金反映は0行で永久再試行。R-13: 再購入（useReorder）も過去の色・サイズをそのまま送る | 妥当 → 各指摘に追記 |

## 過去レビューとの照合と監査の範囲

- このCodexセッションで既に扱ったCheckout Session失効、入金済み注文キャンセル、resource_missing、Checkout Session再利用、Webhookの早期2xx、配送先欠落の方針を参照した。R-01〜R-03はそれらの修正後にも残る別の経路として確認した。
- ローカルClaude Codeの「変更差分のセキュリティレビュー」セッション（ID 88be9aa9-57db-47cd-b265-7dc75d12c971）の9月20〜21日の記録を参照した。割引額列、注文メール重複、欠落商品、フリガナ等の既往指摘は履歴として扱い、現在の差分で独立に確認していないものを新規指摘として数えていない。
- プロジェクトの security-check スクリプトを変更されたTypeScript/TSX/JavaScript 69ファイルへ実行した。生の検出はHigh 9件、Medium 2件。target=_blank の2件には既に rel=noopener noreferrer があり、動的fetch 5件はブラウザからの相対 /api URL、認証なしとされた4ルートは公開またはゲスト利用の設計で、該当するOrigin/CSRF・Cookie・レート制限のコードを確認した。これら11件は確定指摘に数えていない。静的監査だけでは決済の状態遷移問題は検出できない。
- Supabase MCPの文書検索で [Securing your API](https://supabase.com/docs/guides/api/securing-your-api)、[Database Functions](https://supabase.com/docs/guides/database/functions)、[Scheduling Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions) の実装例を確認した。本番Security Advisorは今回追加したRPCについて新規警告を出していない。既存の has_permission 公開、漏えいパスワード保護無効、会計3表のpolicyなしの警告は別件として残る。

- 型検査は成功。Webhook・worker・返金の対象Jest 4スイート49件は成功したが、R-01〜R-03とR-06の入力順序・二度目の同額返金・注文不在の分岐を検証していない。本番依存の npm audit はmoderate以上0件。
- 変更された69ファイルの対象ESLintは成功。本番MCP読取では今回のWebhook worker対象Cron登録は0件で、[schedule_stripe_webhook_worker.sql](../../../../supabase/pending/schedule_stripe_webhook_worker.sql) は保留中。受信ルート公開前にworkerの運用経路を確保する必要がある。

### 2回目（Claude Code）の範囲と検証方法

| 項目 | 内容 |
| --- | --- |
| 対象 | 作業ツリーとHEADの差分（190ファイル変更・未追跡のsrc 12件・マイグレーション30本・pending 4本）。graphify-out と package-lock の機械生成分は除外 |
| 分担 | Checkout / Webhook・決済 / DBマイグレーション / 注文・在庫・カートAPI / UI・ツール・E2E基盤 の5領域を並列にレビューし、出た候補51件（C・W・D・O・U・X・既存指摘への異論と追加証拠）を上の候補メモに全件記録した |
| 検証 | 候補ごとに周辺コード（呼び出し元・最新のDB関数定義・テスト）を読み、本番（pjidrgofvaglnuuznnyj）はカタログと件数だけを SELECT で読んだ。書き込み・決済・マイグレーション適用はしていない |
| 一次資料 | Stripe: [Idempotent requests](https://docs.stripe.com/api/idempotent_requests)、[Checkout Session作成](https://docs.stripe.com/api/checkout/sessions/create)、[Stripe.js confirm](https://docs.stripe.com/js/custom_checkout/confirm)、[Elements with Checkout Sessions 変更ログ](https://docs.stripe.com/checkout/custom-checkout/changelog)。Supabase（MCP文書検索）: [Database Functions](https://supabase.com/docs/guides/database/functions)、lint 0028/0029、[Upgrading: pg_cron records](https://supabase.com/docs/guides/platform/upgrading) |
| 機械検証 | `tsc --noEmit` 成功。単体テスト `jest tests/unit tests/items` は192スイート・1,319件成功（3スイート・8件skip）。E2E は本番Supabaseに書き込むため実行していない。DB結合テスト（ローカルDB専用で、localhost 以外の接続先では実行を拒否する）も今回は実行していない（2026-09-25 訂正: 以前は「本番に書き込むため」と誤記） |
| 結果 | 妥当 R-15〜R-55（41件）、R-01・R-04・R-06・R-13 への追記、R-11 の P1→P3 訂正。却下は D-5・U-5・U-6 の3件、記録のみは D-8（Nit）、差分外は X-1〜X-3 |
| 未使用の手段 | Stripe・Resend のプラグインMCPは未認証、GitHub MCPは接続失敗のため使っていない。R-27 の updateEmail の例外は文書で確定させたが、本アカウントの実APIでの再現は未実施 |

### 公開前に片付ける順序

R-07・R-32・R-33 は worker Cron と受信ルートの公開条件、R-01・R-02・R-25・R-34 は支払済みなのに注文・メールが欠ける経路、R-27・R-23 は客が支払えなくなる経路、R-41 は本番の未入金注文2件で在庫を水増しし得る経路。これらを先に直し、残りの P3 は次の修正にまとめる。
