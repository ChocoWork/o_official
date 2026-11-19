# ADR-0474 パスキーの知らせの点検は、注文のメールと同じ仕組みに載せ、心拍と dead の印を移行 I で足す

> 状態: 推定 | 確認日: 2026-11-20 | 対象: `supabase/migrations/20261119181323_passkey_notification_ops.sql`、`src/lib/auth/passkey-notification-ops.ts`、`src/lib/ops/ops-alert-mail.ts`、`src/lib/stripe/webhook-worker.ts`

## 概要

パスキーの知らせ（送り箱 `private.passkey_notification_outbox`）が `dead` になった時と、送る worker が止まった時に、店が気づけるようにする。DB の側は移行 I（段3b Task 17）、アプリの側は `passkey-notification-ops.ts`。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SR-AUTH-029、FR-AUTH-049、DATA-AUTH-022、ARC-AUTH-014、SEC-AUTH-058、THR-AUTH-057、DD-AUTH-089 |
| 対象のコード | `supabase/migrations/20261119181323_passkey_notification_ops.sql`、`src/lib/auth/passkey-notification-ops.ts`、`src/lib/ops/ops-alert-mail.ts`、`src/lib/ops/ops-store.ts`、`src/lib/stripe/webhook-worker.ts` |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)、[段3b の計画](../../superpowers/plans/2026-11-19-passkey-stage3b-staff-ops.md)、[DB 移行の運用](../../06_Operations/db-migrations.md)、[知らせの worker の詳細](../../04_DetailDesign/sequence/auth-passkey-notifications.md) |
| 調べた時点 | 2026-11-20（手元の Supabase で結合試験を流した） |

## 判断

### ADR-0474 パスキーの知らせの点検は、注文のメールと同じ仕組みに載せ、心拍と dead の印を移行 I で足す

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-058 |
| 根拠 | 注文のメールの点検（`order-email-ops.ts`）が、すでに「dead をまとめて1通・送れた時だけ印・worker の心拍で停止を見る・冷却つきの `sendOnce`」を持つ。同じ形にすれば、新しい宛先も冷却の仕組みも要らず、店が見る知らせの種類が揃う |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-11-19-passkey-stage3b-staff-ops/task-17-brief.md`、`docs/superpowers/plans/2026-11-19-passkey-stage3b-staff-ops.md`（Task 17） |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| 配信の失敗の気づき | パスキーの知らせが `dead` になっても、worker が止まっても、店に知らせが無い | 出典なし（社内の比較。配信の失敗を管理者に知らせる作りは知られているが、宛先と間隔は確かめていない） | OWASP ASVS V7.1 と、キューの監視で「死んだメッセージ」と「消費者の停止」を別々に見る定番（Amazon SQS のデッドレターキューの考え方） | `dead` と worker の停止を別々に、1時間に1回まで知らせる |

#### 決定

- 心拍の job `passkey_notification_worker` を `ops_job_heartbeats_job_check` に足す（移行 I）。job の集合を比べる前の確かめで、既知の8つなら9つに作り直し、すでに含むなら触らず、別の job が入っていれば止める
- 送り箱に列 `dead_notified_at` と部分索引を足し、一覧と印付けの2本の関数を `service_role` だけに渡す。アドレス・本文は返さない
- 点検 `runPasskeyNotificationOpsChecks` は注文のメールの点検の次に呼ぶ。`STALE_JOBS`・`runOpsChecks` には足さない（閾値が30分で、既存の「【要確認】定期処理が止まっています」の形とは別の文面）
- 知らせの文面は付録（オーナーが2026-11-19に決めた）のまま。時刻は JST

#### 結果

- 良くなること: `dead` の行と worker の停止に、店が1時間以内に気づける。同じ行は2度知らせない
- 悪くなること: 毎分の worker が、点検の読み込みを2回（`dead` の一覧・心拍）増やす
- 残る危険: 知らせを店に届ける仕組み（`SHOP_ALERT_EMAIL`・Resend）自体が止まると、点検の知らせも届かない。印付けに失敗すると同じ分を次の点検で再送する（知らせを失うより再送を選ぶ）
- 残る危険（続き）: パスキーの worker の停止の点検は毎分の定期処理（`/api/cron/process-stripe-webhooks`）の中だけで動く。その定期処理そのものが止まった時は、この点検は動かず、毎時の見回りが動かす既存の注文のメールの停止の知らせ（同じ定期処理が心拍を書くので15分で出る）で気づく
- 見直す条件: 店の知らせの宛先を変える時、知らせの種類が増えて1通にまとめにくくなった時
- テスト観点: `dead` が0件・1件以上・送れなかった時・印付けの失敗・心拍が29分と31分・一度も成功が無い・冷却の鍵と3600秒・メールにアドレスが無い、DB 結合で `list`・`mark` の2度目・`pending` の行・権限・前の確かめの (a)・(b)・ずれ

## 未確認事項

- 本番の DB に移行 I を当てる手順と順番は [DB 移行の運用](../../06_Operations/db-migrations.md)。段3まで当てない（ドメインが決まるまで）
- 本番で点検が動くのは、段3で移行 I を当て、この master をデプロイした後
