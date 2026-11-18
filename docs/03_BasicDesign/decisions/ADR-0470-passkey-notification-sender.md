# ADR-0470 パスキーの知らせは、注文のメールの送り手と毎分の定期処理を使い、宛先ごとの重複防止の鍵で送る別の worker にする

> 状態: 推定 | 確認日: 2026-11-18 | 対象: `src/lib/auth/passkey-notification-compose.ts`、`src/lib/auth/passkey-notification-worker.ts`、`src/lib/stripe/webhook-worker.ts`、`src/app/api/cron/process-stripe-webhooks/route.ts`

## 概要

パスキーの足し・消し・差し替えの知らせ（段1a の引き金が積む行）を、お客さん・店員・店長に送る worker の作り方を決める。行の取り出しと結果の記録は Task 8（DD-AUTH-066）、この ADR は Task 9（送る側）の判断を書く。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SR-AUTH-025、FR-AUTH-031、SEC-AUTH-051、ARC-AUTH-011、DD-AUTH-067 |
| 対象のコード | `src/lib/auth/passkey-notification-compose.ts`、`src/lib/auth/passkey-notification-worker.ts`、`src/lib/stripe/webhook-worker.ts`、`src/app/api/cron/process-stripe-webhooks/route.ts` |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)（6-3）、[段2の計画](../../superpowers/plans/2026-11-17-passkey-stage2-customers.md)、[送る worker の詳細](../../04_DetailDesign/sequence/auth-passkey-notifications.md)、[Stripe の知らせの worker](../../04_DetailDesign/sequence/stripe-webhooks.md) |
| 調べた時点 | 2026-11-18（手元の Supabase・Mailpit で、お客さん・店員の両方の知らせが届くことを E2E〔FR-LOGIN-062〕で確かめた） |

## 判断

### ADR-0470 パスキーの知らせは、注文のメールの送り手と毎分の定期処理を使い、宛先ごとの重複防止の鍵で送る別の worker にする

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-051 |
| 根拠 | 送り手・設定の確かめ・停止の決め・誤りの分け方は注文のメールで実績があり、作り直す理由が無い。毎分の入口（`process-stripe-webhooks`）が既にあるので、`pg_cron` の登録を増やさずに済む。知らせの行は注文のメールの送り箱と別の表で、宛先を DB が決めるので、worker は別にする。宛先が複数ある（本人と店長全員）ので、重複防止の鍵は行ごとでは足りず宛先ごとに作る |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-11-17-passkey-stage2-customers/task-9-brief.md`、`docs/superpowers/plans/2026-11-17-passkey-stage2-customers.md`（Task 9。作り手の判断、調整役の判断 4・5） |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| 認証の変更の知らせ | 注文のメールだけ。パスキーの知らせは行を積むだけで送っていない | 出典なし（社内の比較）。公式のアカウントの守りの総まとめのページ（https://help.shopify.com/en/manual/your-account/account-security/passkeys。パスキーは例の1つとして出るだけで、パスキーの記事は別のページ）を2026-11-18 に開いたが、追加・削除のメールの有無は書かれていなかった | OWASP Authentication Cheat Sheet（https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html。2026-11-18 に読んだ）の「Secure Federated Account Linking」に「Notify the user when an identity is added, or when an identity is removed without terminating the application account」とある。パスキーの追加・削除そのものを名指しした一文は読み取れなかったので、同じ考えを当てはめた社内の判断 | 本人へ送り、店員の鍵は店長にも送る |

#### 決定

- 送り手は注文のメールのもの（`sendOrderEmailMessage`）、停止の決めは `orderEmailWorkerDisabledReason`、設定の確かめは `checkOrderEmailSendConfig`、サイトの住所の確かめは `checkSiteUrlForEmail` を使う。名前に `OrderEmail` が付いたまま使うのは、注文のメールの7つの試験に触れたくないため（名前の直しは別の作業）
- 別の定期処理は作らず、`process-stripe-webhooks` に1段足す。順番は Stripe → 注文のメール → 配送の追跡 → パスキーの知らせ → 点検 → 配達の見回り。毎分の入口だけが `passkeyNotifications: true` で呼び、受け取り口の `after()` は呼ばない。予算は `min(3秒, 60秒 − 経過 − 15秒)` で、1秒未満なら呼ばない。投げても点検は続ける。注文のメールと追跡の worker の挙動・予算は変えない
- 宛先ごとに文面を作って送る。重複防止の鍵は `passkey-notification/<行の id>/<アドレスの SHA-256 の先頭16文字>`。再試行しても同じ宛先には同じ鍵になる
- 恒久の失敗（宛先の誤りなど）はその宛先だけ飛ばし、一時的な失敗が無ければ行を済みにする。一時的な失敗があれば残りの宛先も試してから `fail` する
- 1行の宛先を送る間も予算を見て、越えたら残りを送らず `fail` で次へ回す
- 送り手の設定の失敗（Resend の1日・1か月の上限、送り元のドメイン、鍵）は、注文のメールと同じ形で扱う: その行の失敗として数えない。`fail_passkey_notification` の `_count_attempt` を偽にすると、DB が同じ取引の中で、`attempts` を戻し、注文のメールと同じ送信の一時停止（`private.set_order_email_pause`）を書き、その行の次の時刻を「今＋大きい方（900秒、指定の秒数）」かつ一時停止の次に試す時刻より後にする（worker は一時停止を別に書かない）。その回は `config` で止める。数えると、上限が数時間続く間に行が約4〜5時間で黙って `dead` になる（`dead` の点検は段3まで無い）
- 名前は送る時の名前: 鍵の行は GoTrue が「Passkey」で足し、画面が後から名前を付けるので、足した時に写した名前は初期値のまま。`claim_passkey_notification` が取り出す時に鍵の今の名前を読んで行に入れ（消した鍵は消した時の名前）、足した行は足してから30秒は取り出さない（名前の変更が先に入る。名前の変更が失敗した時は、アカウントの画面も初期値なので同じになる）。引き金（移行 C）は直さない（GoTrue の書き込みの取引の中で動くため）
- 一時停止の間は、知らせの worker が自分で試す: 注文のメールの取り出し（`claim_order_email`）は、共有の一時停止の「次に試す時刻」が来た時にだけ、その時刻を15分先へ進める（毎分ではない）。`webhook-worker` は注文のメールを先に動かすので、時刻が来た回は、知らせの worker が見る時にはもう先へ進んでいて、注文のメールの試しに使われなかった時しか試せない。そこで worker は時刻を見ず、一時停止（`paused`）の間は **1回に1行だけ** 取り出して試し、試す間隔は DB が決める。止まっている間の取り出し（`claim_passkey_notification`）: 設定の失敗の符号（`quota_*`・`config_*`）を `last_error_code` に持つ行が `retry_wait` か取り出し中（`sending`）にあれば、`retry_wait` で時刻が来たその行だけを返す（来ていなければ、取り出し中の行しか無い間も、何も返さない。ほかの行が時刻でも返さない）。そういう行がまだ無ければ、通常の行を1つだけ返す（最初の試し）。数えない失敗の次の時刻は「今＋大きい方（900秒、指定の秒数）と、共有の一時停止の次に試す時刻（1日の上限なら UTC 0時）」。これで、止まっている間の試しは約15分に1回（注文のメールと同じ間隔。1日の上限ならUTC 0時まで）。止まっていなければ通常どおり。送れて `complete_passkey_notification` が通れば、DB が同じ取引で共有の一時停止を解く（`complete_order_email` と同じ）。1通も送れず全宛先が恒久の失敗だった行は、送れた証拠にならないので `complete` でなく `skip`（`all_recipients_permanent`）にする
- 同じ送り手・同じ上限なので、知らせの設定の失敗は注文のメールの送信も止める。止まった時、店への知らせ（`ops-alert-mail`）は注文のメールの文面のまま「注文のメールの送信を止めています」と出る。パスキーの知らせも止まっていることは文面に出ない（文面を変えるかは段3の `dead` の点検と同じ回に、オーナーが決める）。逆に、注文のメールの失敗で一時停止になると、知らせの worker は1回1行の試しに切り替わる。止まっている間に知らせの試しが成功すれば、注文のメールの一時停止も解ける（同じ送り手が使えると分かったため）
- 本番の毎分の定期処理は、段3で移行 G を当て、この master をデプロイした後に動く。それまで本番には何も出ない

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 専用の定期処理（`pg_cron` の登録）を足す | 登録を増やすと本番の手順が増える。毎分の入口が既にある |
| 注文のメールの送り箱に載せる | 宛先を DB が決める・店長全員へ送るなど、扱いが違う。注文の行に結び付く列が合わない |
| 重複防止の鍵を行ごとに1つにする | 宛先が複数で、一部だけ失敗して再試行した時、先に送った宛先に2通目が出ない保証が作れない（同じ鍵だと宛先が違う要求が拒まれる） |
| 恒久の失敗で行を `fail` する | 壊れた店長のアドレス1つで、行が9回回って `dead` になり、ほかの宛先にも届かなくなる |
| 受け取り口の `after()` からも呼ぶ | 受け取りの応答を待たない処理の上限を、知らせで食う。毎分の入口で足りる |

#### 結果

- 良くなること: 送り手の実績をそのまま使える。本番の手順が増えない。壊れた宛先が、ほかの宛先を止めない
- 悪くなること: 知らせの段は予算を送る前にしか見ないので、送り1回の打ち切り（8秒）の分だけ予算を越えうる（点検の15秒に食い込みうる。注文のメールの段と同じ形で受け入れる）。知らせの worker は動いた記録（心拍）を残さず、`dead` の行を店へ知らせる点検も無い。どちらも段3で作る（既知の穴）。送り手の名前に `OrderEmail` が付いたまま。手元の送り手は重複防止の鍵を使わないので、予算を越えて次の回に回った行は、E2E では同じ宛先に重なりうる
- 見直す条件: 本番の Resend で、宛先ごとの鍵が24時間の重複防止として働くことを確かめた時。知らせの量が増えて3秒の予算で足りなくなった時
