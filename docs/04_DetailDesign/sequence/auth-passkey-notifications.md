# パスキーの知らせを取り出して送るための DB の関数と、送る worker

> 状態: 推定 | 確認日: 2026-11-20 | 対象: `supabase/migrations/20261118044338_passkey_notification_sending.sql`、`src/lib/auth/passkey-notification-store.ts`、`passkey-notification-compose.ts`、`passkey-notification-worker.ts`、`src/lib/stripe/webhook-worker.ts`、`src/lib/auth/passkey-notification-ops.ts` | 親: [シーケンス設計の方針](README.md)

## 概要

段1a の引き金が `private.passkey_notification_outbox` に積んだ行（パスキーの足し・引き・鍵の差し替え）を、送る側（次のタスクの worker）が1行ずつ取り出して送り、結果を残すための DB の関数と、それを呼ぶ薄い部品。メールの文・送る worker・定期処理への組み込みは DD-AUTH-067（下）。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 対応する ID | SR-AUTH-025、FR-AUTH-030、FR-AUTH-031、FR-AUTH-047、FR-AUTH-048、FR-AUTH-049、DATA-AUTH-019、SEC-AUTH-051、SEC-AUTH-058、THR-AUTH-050、THR-AUTH-057、DD-AUTH-066、DD-AUTH-067、DD-AUTH-087、DD-AUTH-088、DD-AUTH-089、ADR-0470、ADR-0473、ADR-0474 |
| 対象のコード | 移行 `supabase/migrations/20261118044338_passkey_notification_sending.sql`、`src/lib/auth/passkey-notification-store.ts`、`passkey-notification-compose.ts`、`passkey-notification-worker.ts`、`src/lib/stripe/webhook-worker.ts`、`src/app/api/cron/process-stripe-webhooks/route.ts` |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)（6-3）、[段2の計画](../../superpowers/plans/2026-11-17-passkey-stage2-customers.md)、[パスキーのアプリの窓口](auth-passkey-server-endpoints.md) |
| 調べた時点 | 2026-11-18（手元の DB で結合試験を流した） |

## 処理の詳細

### DD-AUTH-066 知らせの行の取り出し・済み・失敗・飛ばし・宛先の処理の順番

| 属性 | 値 |
| --- | --- |
| 上位 | DATA-AUTH-019、SEC-AUTH-051 |
| 根拠 | 送る側が複数でも、1行を二重に取らず、落ちた担当の行を取り戻し、送れない行を止められるようにする。注文のメールの送り箱と同じ「担当の印（lease）・失敗の回数・間隔を広げる再試行」の考えにして、宛先と状態の変更はすべて DB の関数の中で決める。呼び手（薄い部品）は誤り・例外・想定外の戻りを `{ ok: false }` にして、呼び手が何もせず次の回へ進める。取り出す時に、鍵の今の名前（`auth.webauthn_credentials`。消した鍵は消した時に写した名前）を行の `friendly_name` に入れて返す。GoTrue は鍵を「Passkey」で足し、画面が後から名前を付けるため。足した行（`passkey_id` あり）は足してから30秒は取り出さず、名前の変更が先に入るのを待つ |
| 状態 | 推定 |
| 確かめ方 | 単体テスト（`tests/unit/lib/auth/passkey-notification-store.test.ts`）、結合テスト（`tests/integration/db/auth_passkey_notification_sending.integration.test.ts`）、E2E（`e2e/FR-LOGIN-061-passkey-notification-function-grants.spec.ts`） |
| 出どころ | `.superpowers/sdd/2026-11-17-passkey-stage2-customers/task-8-brief.md`、`docs/superpowers/plans/2026-11-17-passkey-stage2-customers.md`（Task 8。作り手の判断: 再試行は注文のメールと同じ考えで揺らぎなし、`dead` の点検は段3） |

```mermaid
sequenceDiagram
    participant W as 送る側（Task 9）
    participant S as passkey-notification-store
    participant D as DB の関数
    W->>S: claimPasskeyNotification(秒数)
    S->>D: claim_passkey_notification
    D->>D: 期限切れの担当を retry_wait（9回目なら dead）に戻す
    D->>D: 時刻が来た最古の1行を FOR UPDATE SKIP LOCKED で取り sending にする
    D-->>S: 行と担当の印（無ければ空）
    W->>S: passkeyNotificationRecipients(id)
    S->>D: passkey_notification_recipients
    D-->>W: 本人（subject_customer か subject_staff）、次に店長（admin）
    alt 送れた
        W->>S: completePasskeyNotification(id, 印)
        S->>D: 印が合えば sent
    else 送れなかった
        W->>S: failPasskeyNotification(id, 印, 符号, 秒数)
        S->>D: 印が合えば retry_wait（9回目なら dead）
    else 宛先が無い
        W->>S: skipPasskeyNotification(id, 印, 理由)
        S->>D: 印が合えば skipped
    end
```

- 追跡の単位: `src/lib/auth/passkey-notification-store.ts` の `claimPasskeyNotification` が IMPL-AUTH-330、`completePasskeyNotification` が IMPL-AUTH-331、`failPasskeyNotification` が IMPL-AUTH-332、`skipPasskeyNotification` が IMPL-AUTH-333、`passkeyNotificationRecipients` が IMPL-AUTH-334
- 取り出し: 担当の秒数は30〜900（外れは `22023`）。最古は `seq` の順。`FOR UPDATE SKIP LOCKED` なので、2つの送り手が同じ行を取らない。取り出した行は `attempts` が1増え、新しい担当の印と期限が付く。期限切れの戻しは、`fail` と同じ間隔（`60 × 2^(attempts-1)` 秒）の先を `next_attempt_at` にする（すぐ取り直すと、送り手が落ち続けた時に9回を数分で使い切って `dead` になるため。注文のメールの送り箱と同じ）。その呼び出しの中では取り直さない
- 失敗の間隔: 次の時刻 = 今 + 大きい方（指定の秒数〔負は0、1日で頭打ち〕、`60 × 2^(attempts-1)` 秒。`attempts` が8以上は128分で頭打ち）。揺らぎは付けない（宛先が少なく、同時の取り合いが無いため）。`attempts` が9以上なら `dead` で `finished_at` を付け、`next_attempt_at` は変えない
- 宛先: 本人を先に、店長を後に返す。店長は有効で期限内の役割があり、`auth.users` が消されておらず（`deleted_at` が空）、止められていない（`banned_until` が空か過去）人だけ。同じアドレスは大文字小文字を区別せず先の方を残すので、本人が店長でも `subject_staff` の文面が優先される。メールが空の行は返さない
- 部品: サービスの鍵のクライアント（`createServiceRoleClient`）から呼ぶ。引数の名前は関数と同じ `_id`・`_lease_token`・`_lease_seconds`・`_error_code`・`_retry_after_seconds`・`_reason`（`passkey-approval-rpc.ts` の `p_` とは違う）。誤りのログは関数の名前とコードだけ
- テスト観点: 最古だけ・未来の行・済み・`dead` を返さない、担当中の行を返さない、期限切れで戻り（間隔の先まで取れない）9回目で `dead`、秒数の範囲、2つの接続から同時に取っても同じ行を返さず待たされない（`FOR UPDATE SKIP LOCKED` を外すと落ちる）、指定の秒数の頭打ち、印が合う時だけ変わる、間隔（1分・2分・指定の秒数・128分の頭打ち・9回目の `dead`）、符号の形、宛先（お客さん・店員・本人が店長・本人を含めない・空を返さない・サポーター・期限切れ・無効・消された・止められた店長を含めない）、5つの関数の権限、引き金が積んだ行を取れること、部品の戻りの形の確かめと誤りの扱い

### DD-AUTH-067 知らせの文面を作り、行を取り出して宛先ごとに送り、毎分の定期処理につなぐ順番

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-AUTH-011、DATA-AUTH-019、SEC-AUTH-051 |
| 根拠 | 行の取り出し・結果の記録（DD-AUTH-066）の上に、宛先ごとの文面・送り・失敗の分け方・予算を載せる。注文のメールの送り手と停止の決めを共用し、定期処理は既存の毎分の入口に1段足す（ADR-0470）。宛先の1つの恒久の失敗で行が9回回って `dead` にならないよう、恒久の失敗の宛先だけ飛ばす。知らせの名前は送る時の名前（取り出す時に読んだ鍵の今の名前）で、足した直後の30秒は取り出されない（DD-AUTH-066） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト（`tests/unit/lib/auth/passkey-notification-compose.test.ts`・`passkey-notification-worker.test.ts`・`tests/unit/lib/stripe/webhook-worker.test.ts`）、結合テスト（`tests/integration/db/auth_passkey_notification_worker.integration.test.ts`）、E2E（`e2e/FR-LOGIN-062-passkey-notification-mail.spec.ts`） |
| 出どころ | `.superpowers/sdd/2026-11-17-passkey-stage2-customers/task-9-brief.md`、`docs/superpowers/plans/2026-11-17-passkey-stage2-customers.md`（Task 9） |

```mermaid
sequenceDiagram
    participant C as process-stripe-webhooks（毎分）
    participant W as passkey-notification-worker
    participant D as DB の関数
    participant M as 注文のメールの送り手
    C->>C: Stripe → 注文のメール → 配送の追跡の後、残りが1秒以上なら
    C->>W: runPasskeyNotificationWorker（予算 min(3秒, 60秒−経過−15秒)）
    W->>W: 停止の決め・送り手の設定・サイトの住所を確かめる（だめなら claim しない）
    loop 予算内・20行まで
        W->>D: claim（担当の秒数300）
        W->>D: recipients（本人、次に店長）
        loop 宛先ごと（予算を見る）
            W->>W: 宛先の種類で文面を作る（compose）
            W->>M: send（重複防止の鍵つき）
        end
        alt 全部成功
            W->>D: complete
        else 一時的な失敗あり
            W->>D: fail（最初の符号・最大の待ち秒数）
        else 宛先なし
            W->>D: skip
        end
    end
```

- 追跡の単位: `passkey-notification-compose.ts` の `sanitizePasskeyNameForMail` が IMPL-AUTH-335、`composePasskeyNotification` が IMPL-AUTH-336、`passkey-notification-worker.ts` の `passkeyNotificationIdempotencyKey` が IMPL-AUTH-337、`runPasskeyNotificationWorker` が IMPL-AUTH-338
- 文面: テキストだけ。本人のアドレスは店長の文面だけ。お問い合わせの住所はお客さんの文面だけ。名前は改行を空白に替え、制御文字・表示の向きを変える文字を除き、64字で切る。日時は `Asia/Tokyo`。宛名・署名は付けない（文頭の一文で店の名前を出す。理由: アカウントの守りの知らせ〔パスワードの変更の知らせ〕と同じ形。確定案はオーナーの確かめ待ち）
- 失敗の分け方: 送り手の失敗は `transient`（残りの宛先も試し、最後に `fail`）・`permanent`（その宛先だけ飛ばす）・`config`（注文のメールと同じ: その行を `fail`〔`_count_attempt` を偽にして回数を数えず、次の時刻は今＋900秒以上かつ共有の一時停止の次に試す時刻より後。DB が同じ取引で注文のメールと共有の送信の一時停止を書く〕にして、その回は `config` で止める）。`config` 以外の `fail` は9回目で DB が `dead` にする
- 一時停止の間（ADR-0470）: worker は次に試す時刻を見ず（注文のメールの取り出しが、時刻が来た回に先へ進めてしまうため。毎分ではない）、`paused` の間は1回に1行だけ取り出す。間隔は DB が決める: 止まっている間の取り出し（`claim_passkey_notification`）: 設定の失敗の符号（`quota_*`・`config_*`）を `last_error_code` に持つ行が `retry_wait` か取り出し中（`sending`）にあれば、`retry_wait` で時刻が来たその行だけを返す（来ていなければ、取り出し中の行しか無い間も、何も返さない。ほかの行が時刻でも返さない）。そういう行がまだ無ければ、通常の行を1つだけ返す（最初の試し）。数えない失敗の次の時刻は「今＋大きい方（900秒、指定の秒数）と、共有の一時停止の次に試す時刻（1日の上限なら UTC 0時）」。これで、止まっている間の試しは約15分に1回（注文のメールと同じ間隔。1日の上限ならUTC 0時まで）。止まっていなければ通常どおり。送れて `complete` が通れば DB が共有の一時停止を解く。読めなければ通常どおり動く。1通も送れず全宛先が恒久の失敗の行は、`complete` でなく `skip`（`all_recipients_permanent`）
- 予算: 新しい行を取る上限は既定3秒・20行。呼び手が残り時間から決めた値を渡す。取った行の宛先の送りは DD-AUTH-088 の行ごとの期限まで。越えたら、その行を `fail`（符号 `budget_exceeded`）にして止める。次の回で送る宛先は、Resend では同じ鍵なので2通目にならない（手元の送り手は鍵を使わないので、E2E では重なりうる）
- 定期処理: `runWebhookWorker({ requestUrl, passkeyNotifications: true })` の時だけ、配送の追跡の後・点検の前に呼ぶ。`webhook/stripe` の `after()` は呼ばない。投げても点検は続ける。注文のメールの worker と追跡の worker の挙動・予算は変えない
- 期限を見るのは送る前だけなので、新しい行を取る窓は3秒、取った行は最大20秒、絶対の上限は開始から45秒（送り1回の打ち切り〔最大8秒〕の分だけ越えうる）。知らせの worker の心拍と `dead` の点検は段3
- 動かさない環境: 注文のメールと同じ `orderEmailWorkerDisabledReason`（Vercel の preview など、DB が手元でない開発）
- テスト観点: 9通りの文面を文字列で固定、本人のアドレスの出方、日本時間、名前の整え、設定が無ければ `claim` 0回、鍵が行・宛先ごとに固定で再試行でも同じ、恒久の失敗の宛先だけ飛ばす、一時的な失敗で残りも試す（符号は最初・待ちは最大）、9回目で `dead`、予算・20行・宛先を送る間の予算、`claim` の失敗、ログにアドレス・本文・名前が無い、定期処理が投げても点検が動く・35秒＋10秒を使い切ったら呼ばない・`after()` の道では呼ばない

### DD-AUTH-087 店長への知らせ（やり直し・招待・降格）を文面にして宛先の店長へ送り、知らない種類の行は飛ばす

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-058 |
| 根拠 | 段3b の DB が積む3つの新しい種類（DD-AUTH-086）を、アプリ（取り出しの部品・文面・worker）が知らないと、取り出しが形の誤りで失敗し、行は担当の期限まで列を止めて9回で `dead` になる。だから (1) 新しい3種類を知らせの種類に足す、(2) アプリの知らない種類の行は `id` と担当の印だけ読んで `skip`（`unknown_kind`）し、アプリと DB の版がずれても列を止めない。文面は店長だけの宛先に限り（ほかの宛先は例外で `compose_error`）、対象と操作した店長のアドレスは本文にだけ入れて件名・監査・ログには入れない |
| 状態 | 推定 |
| 確かめ方 | 単体テスト（`tests/unit/lib/auth/passkey-notification-store.test.ts`・`passkey-notification-compose.test.ts`・`passkey-notification-worker.test.ts`）、結合テスト（`tests/integration/db/auth_passkey_notification_worker.integration.test.ts`。DATA-AUTH-022）、E2E（`e2e/FR-LOGIN-071-staff-manager-notice-mail.spec.ts`、FR-AUTH-047-AC-01〜03） |
| 出どころ | `.superpowers/sdd/2026-11-19-passkey-stage3b-staff-ops/task-15-brief.md`、`docs/superpowers/plans/2026-11-19-passkey-stage3b-staff-ops.md`（Task 15） |

```mermaid
sequenceDiagram
    participant W as passkey-notification-worker
    participant S as passkey-notification-store
    participant D as DB の関数
    W->>S: claimPasskeyNotification
    S->>D: claim_passkey_notification
    D-->>S: 行（末尾に actor_email）
    alt 知っている種類（6つ）
        S-->>W: ClaimedPasskeyNotification（kind・actorEmail）
        W->>D: recipients（店長への知らせは本人を除く admin 全員）
        W->>W: compose（店長への知らせは admin の宛先だけ。ほかは例外 → compose_error）
        W->>D: complete か fail か skip
    else 知らない種類（DB だけ新しい版）
        S-->>W: UnknownKindClaim（id と担当の印だけ。kind は null）
        W->>D: skip（unknown_kind）
    end
```

- 追跡の単位: `passkey-notification-compose.ts` の `isStaffNoticeKind` が IMPL-AUTH-408、`passkey-notification-store.ts` の `isUnknownKindClaim` が IMPL-AUTH-409（どちらも設計は DD-AUTH-087）。既存の `claimPasskeyNotification`（IMPL-AUTH-330。設計は DD-AUTH-086）・`composePasskeyNotification`（IMPL-AUTH-336）・`runPasskeyNotificationWorker`（IMPL-AUTH-338。設計は DD-AUTH-067）は `@design` を変えず、この節の振る舞い（新しい種類・`unknown_kind` の `skip`）も持つ。IMPL-AUTH-410・411 は使わない
- 種類: `PasskeyNotificationKind` は `passkey_added`・`passkey_removed`・`passkey_key_replaced` に `staff_redo_issued`・`staff_invited`・`staff_demoted` を足した6つ。`ClaimedPasskeyNotification` の `actorEmail` は DD-AUTH-086 が写した値
- 知らない種類: `parseClaimed` は、`kind` が文字列で6つのどれでもなく、`id` と `lease_token` が文字列なら `{ id, leaseToken, kind: null }`（型 `UnknownKindClaim`）を返す。どちらかが無ければ従来どおり `{ ok: false }`。worker は `kind` が `null` の行を数えて（`claimed`・`skipped`）、`skip(id, leaseToken, 'unknown_kind')` し、宛先も文面も触らない。`skip` が失敗の戻り・例外を返しても握り、成功（`ok` かつ値が真）の時だけ `skipped` に数え、行 ID と理由（`unknown_kind`）だけを警告に出す（版のずれの跡）。失敗・担当を失った（値が偽）時は数えず、同じ ID と理由で「skip failed」を警告に出す（行は担当の期限の後で取り直される）
- 文面（`composePasskeyNotification`。`actorEmail: string | null` を入力に足した）: 店長への知らせの3種類は `admin` の宛先だけ。ほかの宛先は例外を投げ、worker が `compose_error` で行を `fail` にする。件名は「店員のパスキーのやり直しが出されました」・「店員の招待が出されました」・「店員がお客さんに戻されました」。本文は1行目（対象のアドレスがあれば `{対象} のパスキーのやり直しが出されました。`・`{対象} への店員の招待が出されました。`・`{対象} が、店員からお客さんに戻されました。`。対象のアドレスが無い時は「店員の…」で始める）、空行、`日時: …（日本時間）`、`操作した店長: {actorEmail}`（`actorEmail` が `null` なら出さない）、空行、「心当たりがない場合は、店長の権限を確認してください。」。`名前:` の行は出さない。本人のアドレス・操作した店長のアドレスは本文にだけ入れる
- 送り方: 宛先は DD-AUTH-086 の `passkey_notification_recipients`（本人を除く有効な店長全員。操作した店長は含む）。宛先ごとに1通、重複防止の鍵（行 ID と宛先のハッシュ）は古い3種類と同じ。恒久・一時・設定の失敗の分け方、予算、9回目の `dead` も同じ（DD-AUTH-067）
- 手元の送り手は重複防止の鍵を見ないので、予算越えの再試行で同じ店長に2通届きうる。E2E は「1通以上」で確かめる
- テスト観点: 3種類を `parseClaimed` が通す・知らない種類を `kind: null` で返す・id か担当の印が無ければ失敗、3種類の件名・本文の全文・`actorEmail` が `null` の時・対象が無い時・`admin` 以外の宛先の例外・件名にアドレスが入らない・絵文字と感嘆符が無い、worker が `unknown_kind` で `skip` して次の行へ進む・`skip` の例外でも止まらない・`actorEmail` を文面へ渡す・`admin` 以外が混じると何も送らず `compose_error`、DB 結合で宛先（本人を除く・操作した店長を含む・サポーターを含まない）と宛先なしの `skipped`

### DD-AUTH-088 宛先が多い行の取りこぼしを、行ごとの期限で防ぐ

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-058 |
| 根拠 | 実行全体の予算（3秒）を宛先ごとに見ると、宛先が6人以上の行で後ろの宛先が送られない。新しい行を取る判定にだけ実行全体の予算を使い、取った行は行ごとの期限（行を取った時刻＋`rowBudgetMs`。既定20秒）で宛先を送る。遅く取った行が毎分の入口（60秒）の余裕を食わないよう、呼び手が絶対の上限 `hardDeadlineMs` を渡し、行の期限はその小さい方にする |
| 状態 | 推定 |
| 確かめ方 | 単体テスト（`tests/unit/lib/auth/passkey-notification-worker.test.ts`・`tests/unit/lib/stripe/webhook-worker.test.ts`）、E2E（`e2e/FR-LOGIN-062`） |
| 出どころ | `.superpowers/sdd/2026-11-19-passkey-stage3b-staff-ops/task-16-brief.md`、`docs/superpowers/plans/2026-11-19-passkey-stage3b-staff-ops.md`（Task 16） |

- 追跡の単位: `passkey-notification-worker.ts` の `passkeyNotificationRowDeadline` が IMPL-AUTH-412（設計は DD-AUTH-088。行の期限＝取った時刻＋`PASSKEY_NOTIFICATION_ROW_BUDGET_MS`と絶対の上限の小さい方）。`runPasskeyNotificationWorker`（IMPL-AUTH-338）は `@design` を変えず、この節の振る舞いも持つ
- 取る窓: `min(now + budgetMs, hardDeadlineMs)`。絶対の上限を過ぎる時は新しい行を取らない
- 入力: `options.rowBudgetMs`（既定20秒）、`options.hardDeadlineMs`（絶対の時刻。既定は無し）。`webhook-worker.ts` は `startedAt + 45_000` を渡す（60秒の入口に15秒の余裕）
- 期限: 行を取った直後の時刻を `rowStartedAt` として、`min(rowStartedAt + rowBudgetMs, hardDeadlineMs)` を `deliverRow` に渡す。実行全体の `budgetMs`（3秒）は次の行を取る前の判定だけに使う
- 影響: 1行の延長の分、同じ定期処理の中の点検（`runOpsChecks`）が最大約20秒遅れうる。担当の期限（300秒）より十分小さい
- 重複防止: 鍵は行 ID と宛先のハッシュで変わらないので、期限で止まった行の再試行でも Resend は同じ宛先に2通目を出さない
- テスト観点: 宛先6人・1通1秒の行が1回で全員に送られ次の行を取らない、1通10秒で宛先3人の行は2通目の後に `budget_exceeded`、鍵が再試行で同じ、遅く取った行が `hardDeadlineMs` で止まる、`rowBudgetMs` の効き、`webhook-worker` が `startedAt + 45_000` を渡す

### DD-AUTH-089 死んだ知らせと worker の停止を、毎分の worker の後の点検で店に知らせる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-058、ARC-AUTH-014 |
| 根拠 | 知らせの行が `dead` になる・worker が止まる、のどちらも今は店に伝わらない（THR-AUTH-057 の残る危険）。注文のメールの点検（`order-email-ops.ts`）と同じ形で、`dead` はまとめて1通・送れた時だけ印、停止は心拍の最後の成功から30分で1通にする |
| 状態 | 推定 |
| 確かめ方 | 単体テスト（`tests/unit/lib/auth/passkey-notification-ops.test.ts`・`tests/unit/lib/ops/ops-alert-mail.test.ts`・`tests/unit/lib/stripe/webhook-worker.test.ts`）、結合テスト（`tests/integration/db/auth_passkey_notification_ops.integration.test.ts`） |
| 出どころ | `.superpowers/sdd/2026-11-19-passkey-stage3b-staff-ops/task-17-brief.md`、`docs/superpowers/plans/2026-11-19-passkey-stage3b-staff-ops.md`（Task 17） |

- 追跡の単位: `passkey-notification-ops.ts` の `runPasskeyNotificationOpsChecks` が IMPL-AUTH-413（設計は DD-AUTH-089）。メールの作り手 `passkeyNotificationDeadMail`・`passkeyNotificationStaleMail`（`src/lib/ops/ops-alert-mail.ts`）と `webhook-worker.ts` の心拍・呼び出しは AUTH の追跡の範囲の外なので ID を持たず、この節に書く
- 心拍（`webhook-worker.ts`）: `options.passkeyNotifications` が真の時だけ。worker の `stopped` が `idle`・`budget` なら成功、`claim_error` は失敗（`db_unavailable`）、例外は失敗（`worker_error`）、`disabled`・`config` は書かない。残りが1秒未満で worker を呼ばなかった時は成功（`error_code` は null）。心拍の書き込みの例外は握る
- 点検の順: 注文のメールの点検の次、配達の見回りの前。例外は握り、結果の `passkeyChecks` を `null` にして見回りへ進む
- 死んだ知らせ: `list_unnotified_dead_passkey_notifications(50)` → 1件以上なら `sendOnce(passkey_notification_dead)` → 送れたら `mark_passkey_notification_dead_notified`（失敗したら次の点検で再送。at-least-once）
- 停止: `readHeartbeats` の `passkey_notification_worker.lastSucceededAt` が30分以上前なら `sendOnce(job_stale_passkey_notification_worker)`。一度も成功が無ければ対象にしない
- 失敗の分け方: 2つの点検は独立で、一方が投げても他方を続け、`failedChecks` に `dead`・`stale` を入れる。ログは例外名だけ
- メール（付録）: 件名「パスキーの知らせが届きませんでした」・本文「{件数}件の知らせが、再試行の上限を越えて届きませんでした。種類・失敗の理由・時刻は次のとおりです。」＋行ごとに「種類／失敗コード／時刻」（種類は日本語の名前: パスキーの追加・パスキーの削除・パスキーの置き換え・店員のやり直し・店員の招待・店員の降格。知らない種類は「不明」。失敗コードは記号のまま）。件名「パスキーの知らせの送りが止まっています」・本文「最後に成功したのは {時刻} です。送りの設定とログを確認してください。」。件数・種類・失敗コード・時刻（JST）だけで、アドレスと本文を入れない。既存の `staleJobMail` は使わず、`STALE_JOBS`・`runOpsChecks` には足さない
- DB（移行 I）: 列 `dead_notified_at`・部分索引・関数2本（DATA-AUTH-022）。`ops_job_heartbeats_job_check` に job を足す

## 未確認事項

- 本番の DB に移行 G を当てる手順と順番は [DB 移行の運用](../../06_Operations/db-migrations.md)。段3まで当てない
- 本番で毎分の定期処理が知らせを送り始めるのは、段3で移行 G を当て、この master をデプロイした後。それまで本番には何も出ない
- 注文のメールの宛名（「お客様」）と署名（店の名前）を、知らせの文面に付けるか（確定案は付けない。オーナーの確かめ待ち）
