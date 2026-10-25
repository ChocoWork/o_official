# 荷作り表から発送票の下書きまでの流れ（G-3）

> 状態: 現行のソース（グループ G-3 Task 4・5・6・7・8。荷作り表で下書きを作り、票の頁で編集・破棄・確認・確定・取消・伝票番号の入力と訂正・手動の配達済みをする。追跡の外への登録は票の代表の1行で、読み直しの結果は票の全注文へ展開する。本番へは未適用） | 確認日: 2026-10-26 | 対象: 下書きの作成・入れ替え・破棄と発送確定と発送の取消と伝票番号の後入力・訂正と手動の配達済みと追跡の親・配送の読み直しの結果の展開の順序、発送票の書込みに共通のロックの順 | G-3 Task 9 確認: 2026-10-26（修正前はfresh reset・12 suite・639/639成功、Fix round 1は再検証対象）

## 概要

発送は 荷作り表で品物を選ぶ → 「発送」で下書きを作る → 発送票の確認 → 発送確定 の順に進む。この文書は**下書きを作る・入れ替える・破棄する操作と、発送確定**を扱う。下書きは「どの品物を何点まとめて送るか」を覚えておくだけの記録で、**在庫・割当・台帳・注文・発送は一切変えない**。2つの下書きが同じ明細を選べる（取り置かない）。先に確定した分を超える発送は、確定が数量を確かめて断る。

| 項目 | 内容 |
| --- | --- |
| 入口 | 作成 `POST /api/admin/shipment-slips`（201）、入れ替え `POST /api/admin/shipment-slips/[id]/draft`（200）、破棄 `POST /api/admin/shipment-slips/[id]/discard`（200）。認可（`admin.shipping.manage` ＋ `admin.shipping.read` ＋ `admin.orders.manage` ＋ `admin.orders.read` の4つすべて）→ CSRF → IP の回数制限 → actor の回数制限 → 検証 → store → 監査 |
| 権限の確かめ | 窓口と DB の関数の両方（DB は実行者の有効な全役割の権限の和集合で、毎回確かめる） |
| 冪等 | 画面は同じ内容の再押下・通信の再送に同じ `requestKey` と本文を使い、内容を変えたら新しい `requestKey`。DB は `(shipment_slip_save, request_key)` と入力の指紋（操作・票・行・実行者。版は含めない）で、同じなら前の結果を `replayed: true` で返し、違えば断る |
| 番号 | `SL-` ＋ 日本時間の `YYYYMMDD` ＋ `-` ＋ 4桁の連番（その日の最大＋1。9999 を超えると失敗）。下書きを作った時に採る。別の日の番号は数えない |
| 共通のロック | 全ての票の書込みは `private.lock_group_g_shipment_slips` を引数の検証の直後に呼ぶ。最初の文が共通の鍵 `(190521, 1)` |
| 有効期限 | 保存のたびに `now() + 7 日`。期限切れの下書きも保存し直せて、破棄もできる（確定は期限切れを断る） |

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 対応要件 | FREQ-531（荷作り表と下書きの選択）、FREQ-532（同梱の判定をサーバーでも）、FREQ-533（発送票の流れ。下書きの部分）、FREQ-540（権限の組・書き手の閉じた一覧）。[要件](../../02_Requirements/requirements.md) |
| 設計 | [G-3 実装計画](../../superpowers/plans/2026-10-25-group-g3-shipping.md)の Task 4・5 と全体のロック順、[グループ G 設計書](../../superpowers/specs/2026-10-23-group-g-design.md) |
| 実装 | 移行 `supabase/migrations/20261025100130_group_g3_shipping_slips.sql`、[store](../../../src/lib/orders/shipment-slips/shipment-slip-store.ts)、[書込みの窓口の共通の流れ](../../../src/lib/orders/shipment-slips/shipment-slip-route.ts)、窓口（[作成](../../../src/app/api/admin/shipment-slips/route.ts)・[入れ替え](../../../src/app/api/admin/shipment-slips/%5Bid%5D/draft/route.ts)・[破棄](../../../src/app/api/admin/shipment-slips/%5Bid%5D/discard/route.ts)）、[ブラウザの道具](../../../src/lib/orders/shipment-slips/shipment-slip-client.ts)、[送る流れの hook](../../../src/hooks/useShipmentSlipWrite.ts)、画面（[荷作り表](../../../src/components/PackingSection.tsx)・[票の頁](../../../src/components/ShipmentSlipSection.tsx)） |
| 関連 | 保存する段階は[発送票の状態](../states/shipping.md)、鍵の順の元は[在庫の割当と共通の鍵の流れ（G-1）](inventory-allocation.md)と[発注書の流れ（G-2）](purchasing.md)、API は[API 設計](../../03_BasicDesign/api/api-spec.md)の「管理:荷作り表・発送票」 |
| 調査時点 | 2026-10-25 のソース。本番の適用状況と実データでの競合は未確認（末尾） |

## 荷作り表から下書きを作る順序

事前条件: 荷作り表（`/admin/packing`）を開いていて、発送準備中の品物の行から 1 行以上を選んでいる。1行目を選ぶと、`bundleKey` が違う行・`bundleKey` が無い行は選べなくなる（「同じお客様・同じ配送先の注文だけ同梱できます」）。選んだ行ごとに「今回送る数」（1〜準備中の数。初期値は準備中の数）を入れている。

```mermaid
sequenceDiagram
  autonumber
  participant B as 荷作り表（ブラウザ）
  participant A as POST /api/admin/shipment-slips
  participant S as store（saveShipmentSlipDraft）
  participant D as DB 関数 admin_save_shipment_slip_draft
  participant L as lock_group_g_shipment_slips
  B->>B: 行を選ぶ（同梱できない行は無効）、送る数を入れる（通信しない）
  B->>A: 発送（lines, requestKey）
  A->>A: 認可 4権限、CSRF、IP と actor の回数制限、zod の検証
  A->>S: saveShipmentSlipDraft(actorId, 作成)
  S->>D: rpc admin_save_shipment_slip_draft（service_role）
  D->>D: 引数の検証（22023）、表は読まない
  D->>L: 共通の鍵 → 在庫の閉包 → 票の行
  D->>D: 権限の確かめ（42501）
  D->>D: 指紋を作り、同じ request_key を探す
  alt 同じ request_key で同じ指紋
    D-->>S: 保存した結果と replayed true
  else 同じ request_key で指紋が違う
    D-->>S: GROUP_G_REQUEST_KEY_CONFLICT（23505）
  else 初めての request_key
    D->>D: 明細の存在、未払い、阻害理由、同梱、数量の順に確かめる
    D->>D: 番号の採番、票 1 件の保存、操作の記録
    D-->>S: id、number、version 1、replayed false
  end
  S-->>A: 結果か ShipmentSlipError
  A->>A: 監査 admin.shipment_slips.draft.save
  A-->>B: 201 か表の状態とエラー本文
  B->>B: 通知の印を残し、/admin/shipment-slips/[id] へ移る
```

| 順 | 内容 |
| --- | --- |
| 1 | 画面だけの段。選択は頁をまたいで残り、同梱の基準は選んだ最初の行の `bundleKey`。「発送」は選択が1行以上で、全部の送る数が有効な時だけ押せる。送っている間は選択欄も入力も止める |
| 2〜3 | 窓口の順は変えない。回数制限は `admin.shipment_slips.draft` の 120 回／600 秒。実行者は認可結果の `userId` だけから DB へ渡す |
| 4〜5 | store は引数名どおりに RPC を1回呼ぶ。DB の誤りは `message` と SQLSTATE が表と完全に一致した時だけ分類し、他は生の文を出さない500にする |
| 6〜8 | 引数の誤りは権限より先に断る。ロック helper は票・注文・variant の行を読む前に共通の鍵だけを取る。権限の確かめは再送の判定より先で、権限の無い人には再送の結果も見せない |
| 9〜13 | 初めての要求だけが、明細の存在・同梱・数量の確かめと保存へ進む。再送と衝突は何も書かない |
| 14〜16 | 成功も失敗も監査に残す。metadata は件数・再送かどうか・結果コードだけで、品物・数量・要求番号は残さない |
| 17 | 移動で消える画面の代わりに、移動先の票の頁が一度だけ「下書きを保存しました。」を出す（`sessionStorage` に票の id だけを置く。URL は `/admin/shipment-slips/[id]` のまま） |

## DB の関数の中の確かめの順

`admin_save_shipment_slip_draft` は 1 回の呼び出しが 1 つの取引で、次の順に確かめて、最初の違反だけを返す。

| 順 | 確かめること | 違反の時 |
| --- | --- | --- |
| 1 | 引数の形: 実行者・要求番号あり、作成なら版なし・更新なら版あり（1以上）、`lines` は配列で1〜100件、各要素は `orderItemId`（uuid）と `quantity`（1〜99999 の整数）の2項目だけ、明細の重複なし | 空は `GROUP_G_SLIP_EMPTY`、他は `GROUP_G_ARGUMENT_INVALID`（22023） |
| 2 | 押さえ: `lock_group_g_shipment_slips(票, 明細, false)`（下の「ロックの順」） | |
| 3 | 権限: 4権限すべて（実行者の有効な全役割の和集合） | `GROUP_G_FORBIDDEN`（42501） |
| 4 | 指紋と再送 | 異なる内容は `GROUP_G_REQUEST_KEY_CONFLICT`（23505）。同じ内容は保存した結果を返して終わり |
| 5 | 更新なら: 票の存在 → 段階が下書き → 版が一致 | `GROUP_G_SLIP_NOT_FOUND`（P0002）→ `GROUP_G_SLIP_NOT_DRAFT` → `GROUP_G_SLIP_VERSION_CONFLICT`（55000） |
| 6 | 明細が全部ある | `GROUP_G_ARGUMENT_INVALID` |
| 7 | 注文が全部 `paid` | `GROUP_G_SLIP_ORDER_NOT_SHIPPABLE` |
| 8 | 阻害理由（`group_g_shipment_ready` を1回だけ評価）。支払額要確認 → 交換手数料待ち → 配送先不足 → 色サイズ未確定・入金日時なし の順 | `…_PAYMENT_REVIEW_REQUIRED`・`…_EXCHANGE_ON_HOLD`・`…_ADDRESS_INCOMPLETE`・`…_ORDER_NOT_SHIPPABLE` |
| 9 | 同梱の判定（`group_g_bundle_verdict`） | `…_CUSTOMER_MISMATCH`・`…_ADDRESS_MISMATCH`・`…_ADDRESS_INCOMPLETE` |
| 10 | 数量が各行の発送できる数（`shippable`）以下 | `GROUP_G_SLIP_QUANTITY_EXCEEDS_READY` |
| 11 | 書込み: 作成は採番（9999 超は失敗）と票の挿入、更新は印 `draft` の UPDATE（選択・顧客と送り先の写し・有効期限・版+1） | |
| 12 | 操作の記録（最後。操作 `shipment_slip_save`・原因 `shipment_slip`＝票の id） | |

顧客と送り先の写しは、選んだ明細を `orderItemId` の昇順に並べた先頭の明細の注文から取る（会員は `member` ＋会員 ID、ゲストは `guest` ＋ `lower(btrim(メール))`。7項目は前後の空白を落とし、建物は空なら NULL）。同梱の判定が通っているので、どの注文から取っても同じ値になる。

## 下書きの入れ替えと破棄

外す・追加は、どちらも**選択の全部**を `POST …/draft` で送って丸ごと入れ替える（`expectedVersion` は票の頁が読んだ版）。破棄は `POST …/discard`（`expectedVersion` と `requestKey`）。破棄は 1〜5 の確かめ（引数・押さえ・権限・再送・存在・下書き・版）だけを行い、印 `discard` で `stage = discarded`・`discarded_at`・`discarded_by`・`expires_at = NULL`・版+1 にして、操作 `shipment_slip_discard` を記録する。

```mermaid
sequenceDiagram
  autonumber
  participant B as 票の頁（ブラウザ）
  participant A as POST …/[id]/draft か …/[id]/discard
  participant D as DB 関数
  B->>B: 行を外す・候補を選ぶ・破棄の確かめ（通信しない）
  B->>A: 選択の全部と expectedVersion と requestKey（破棄は版と requestKey）
  A->>D: 認可・CSRF・回数制限・検証の後、RPC を1回
  alt 成功（再送も）
    D-->>B: 200 id・number・version・replayed
    B->>B: 通知「下書きを保存しました。」、票を読み直す
  else 版が違う・下書きでない・同梱できない など（4xx）
    D-->>B: 表の本文（code と error）
    B->>B: 文を出し、選んだ候補はそのまま保ち、票を読み直す。次は新しい requestKey
  else 結果が分からない（通信切れ・500）
    B->>B: 入力を止め、「もう一度確かめる」で同じ requestKey と本文を送り直す
  end
```

| 失敗の種類 | 画面の扱い |
| --- | --- |
| 処理の前の断り（401・403・429） | 文を出す。同じ内容の再押下は同じ `requestKey`（記録していないので安全） |
| 処理の中の断り（400・404・409・422） | 表の文を出し、新しい `requestKey` で送れるようにする。票を読み直す |
| 結果が分からない（通信切れ・500番台・読めない成功） | 「結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。」を出す。同じ `requestKey` と本文だけを送り直す。「戻る」は取ってある送信を捨て、票を読み直す |
| 荷作り表の答えの `canManage` が false | 最初の描画から選択欄と「発送」を出さず、「発送票を作る権限がありません。」を1回出す（窓口 `GET /api/admin/packing` が操作の4権限の組を調べて返す） |
| 荷作り表の「発送」の返事が権限の不足の 403（`permission`・`GROUP_G_FORBIDDEN`） | 選択欄と「発送」を片付け、「発送票を作る権限がありません。」を1回出す |
| 「発送」の返事が CSRF の失敗・MFA の 403 | 権限が無いことにしない。CSRF は「セキュリティ確認に失敗しました。ページを再読み込みして、もう一度送ってください。」、MFA は「2要素認証が必要です」を出し、操作は残す |
| 最後の1行を外そうとした時（票の頁） | 窓口へ送らず「品物を選んでください。」を出す |

## ロックの順（`lock_group_g_shipment_slips`）

票の書込みは、G-1 の全体順（共通の鍵 → 設定 → 注文 → … → 割当）の末尾に票を足す。helper の中の順は固定で、呼び手が対象を後から足して前に戻ることを禁じる。

| 順 | 取るもの | 補足 |
| --- | --- | --- |
| 1 | 共通の鍵 `pg_advisory_xact_lock(190521, 1)` | helper の**最初の文**。他の行を読む前 |
| 2 | `shop_settings`（id=1）を `FOR SHARE` | 追跡に触れる書込み（`_with_settings` が真）だけ。下書きの保存・破棄では取らない |
| 3 | 対象の読取だけ（行は取らない） | 渡された明細の注文・variant、票の下書きの選択・確定行・発送が指す注文を合わせて集める |
| 4 | `lock_group_g_inventory(variant 配列, 注文 配列, NULL)` | 共通の鍵は再入可能。戻りのロックした注文 ID（昇順）を保持して返す |
| 5 | `shipment_slips`（id 昇順）`FOR UPDATE` | 在庫の行を全部取った後 |
| 6 | 代表の `fulfillment_tracking_registrations`（`(fulfillment_id, tracking_version)` 昇順）`FOR UPDATE` | 追跡に触れる書込みだけ |

誰も EXECUTE できない内部の道具で、public の入口はない。書込みの本体（保存・破棄）は、票・注文・操作の記録の表を読む前にこれを呼ぶ（構造は pg_proc の本文で試験し、移行の末尾の確かめも見る）。書き手の閉じた一覧は G-2 の65本に保存・破棄・消費・追跡登録・確定の5本と戻し・取消の2本を足した72本。

## 関連テスト

| 観点 | 試験 |
| --- | --- |
| DB の関数（作成・入れ替え・再送・同梱・優先順・数量・権限・原子性・破棄・期限切れ） | [group_g3_draft](../../../tests/integration/db/group_g3_draft.integration.test.ts) |
| 書き手の閉じた一覧・関数の構造 | [group_g1_writer_inventory](../../../tests/integration/db/group_g1_writer_inventory.integration.test.ts)、G-2 の末尾の確かめを流し直す [group_g2_migration_asserts](../../../tests/integration/db/group_g2_migration_asserts.integration.test.ts)・[group_g2_purchase_documents](../../../tests/integration/db/group_g2_purchase_documents.integration.test.ts)、共有の道具 [書き手の一覧の入れ替え](../../../tests/integration/db/helpers/group-g-allowlist.ts) |
| 実 PostgREST | [group_g3_postgrest_paths](../../../tests/integration/db/group_g3_postgrest_paths.integration.test.ts) |
| 窓口 | [作成](../../../tests/unit/api/admin/shipment-slips-route.test.ts)、[入れ替えと破棄](../../../tests/unit/api/admin/shipment-slip-draft-route.test.ts) |
| store・ブラウザの道具 | [store](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-store.test.ts)、[client](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-client.test.ts) |
| 画面 | [荷作り表](../../../tests/unit/components/PackingSection.test.tsx)、[票の頁](../../../tests/unit/components/ShipmentSlipSection.test.tsx)、[取消のダイアログ](../../../tests/unit/components/ShipmentSlipCancelDialog.test.tsx) |
| 発送の取消 | DB [group_g3_cancel](../../../tests/integration/db/group_g3_cancel.integration.test.ts)、窓口 [cancel](../../../tests/unit/api/admin/shipment-slip-cancel-route.test.ts) |

## 未確認事項

- Task 5までの移行はローカルへ適用済み。controllerが実鍵PostgRESTを含む12 suiteで665/665成功を確認した（2026-10-25）。レビュー後の数量変数名の整理はcontrollerが再適用する。本番へは未適用。
- 390/768/1280px の実測と、本番ビルドでの画面の動きは E2E の担当（Task 13）。この Task は単体で表の構造とクラスだけを確かめた。
- 「発送票確認」「発送確定」「発送を取り消す」は実装済み（取消は Task 6）。確定後の伝票番号・配達済みはTask 7、出荷日の訂正はTask 9で実装済み。

## 発送確定（G-3 Task 5）

```mermaid
sequenceDiagram
  autonumber
  participant B as 発送票の頁
  participant A as POST confirm
  participant D as DB確定関数
  participant Q as outboxと追跡登録
  B->>B: 荷物の情報を入力し発送票確認
  B->>A: 発送確定（版・荷物情報・出荷日・通知・要求番号）
  A->>A: 認可→CSRF→IPとactorの制限→検証
  A->>D: 認可済みuserIdでRPC
  D->>D: 引数→共通advisory→設定共有lock→在庫閉包→票→代表登録
  D->>D: 権限→指紋と再送→存在→下書き→版→期限
  D->>D: paid→阻害理由→同梱→数量→全注文のJST出荷日範囲
  D->>D: 状態beforeと操作印を保存
  loop 注文ID昇順
    D->>D: 注文の発送ヘッダー
    loop 明細ID昇順
      D->>D: paid割当をFIFO消費しconsume履歴
      D->>D: その明細の発送行を追加（G-1即時境界を満たす）
    end
    D->>D: confirmed出来事・票の結びつき
    D->>D: 全部送った注文だけshippedへ
    opt 通知オン
      D->>Q: 注文ごとのshipped予定1通
    end
  end
  opt 伝票番号あり
    D->>Q: 票×版の親1行、追跡オンなら代表だけ外部登録予定
  end
  D->>D: 票confirmed・版+1・確定行・版履歴・initial出荷日履歴
  D->>D: ready→shipped差分・操作結果を保存、操作印を復帰
  D-->>A: id・number・version・shipmentDate・fulfillments・replayed
  A->>A: 監査（票ID・件数・結果コード）
  A-->>B: 200
  B->>B: 発送を確定しました。票を読み直す
```

再送は保存結果を返し、発送・消費・予定・履歴を増やさない。失敗は取引全体を巻き戻す。Fは動かさずpaid割当Aだけ減らすため、手元（F+A+H）は発送数だけ減る。台帳のINSERTはない。DB内で外部送信は行わない。

割当消費は各発送行INSERTの前に行う。逆順ではG-1の即時境界が同じ数量を発送済みと残るpaid割当の両方に数え、FULFILLMENT_BOUNDS_VIOLATEDとなる。途中のconsumeと行の一時的な不一致は同一取引内だけで、G-3の遅延group_g_shipment_consumptionが最終的な一致を検査する。before取得・操作印・注文順・注文status・outbox・追跡登録・票更新・履歴・操作結果の順は維持する。

[確定DB試験](../../../tests/integration/db/group_g3_confirm.integration.test.ts)・[窓口単体](../../../tests/unit/api/admin/shipment-slip-confirm-route.test.ts)・[メール完全一致](../../../tests/unit/lib/orders/email/order-email-compose-shipped.test.ts)。controllerが実鍵PostgRESTを含む12 suiteで665/665成功を確認した（2026-10-25）。

## 発送の取消（G-3 Task 6）

確定済みの票を**全体で**取り消す（FREQ-533-AC-04・FREQ-534-AC-03）。票に含まれるすべての注文の発送を取り消し、割当の消費を**1回だけ**戻す。空き在庫Fは動かさず、手元の在庫（F+A+H）は消費した数だけ戻る。DB の関数 `admin_cancel_shipment_slip`（`private` の DEFINER 本体と、同名・同引数の `public` の SQL INVOKER 入口。service_role だけが EXECUTE）と、内部の道具 `restore_group_g_shipment`（誰も EXECUTE できない）が、1取引で行う。

### 順序

```mermaid
sequenceDiagram
  autonumber
  participant B as 発送票の頁（取消のダイアログ）
  participant A as POST /api/admin/shipment-slips/[id]/cancel
  participant D as DB 関数 admin_cancel_shipment_slip
  participant R as restore_group_g_shipment
  B->>B: 「発送を取り消す」→ ダイアログ（説明・取消を止める理由・「取り消す」「戻る」）
  B->>A: expectedVersion と requestKey
  A->>A: 認可 4権限、CSRF、IP と actor の回数制限（30回/600秒）、検証
  A->>D: 認可済みの userId で RPC を1回
  D->>D: 引数 → 押さえ（設定 FOR SHARE を含む）→ 権限 → 指紋と再送
  D->>D: 存在 → 段階 → 版
  D->>D: 拒否の検査（全注文分。違反があれば何も書かず終わる）
  D->>D: 状態 before → 操作印
  loop 注文 ID 昇順（発送ごと）
    D->>D: 発送の取消（cancelled_at・cancelled_by。印なし）
    D->>D: 追跡登録を cancelled で止める・要対応を auto で閉じる
    D->>R: 発送の行の明細ごと・consume ごとに 4 文
    D->>D: 全部送っていた注文は paid へ（shipped_at・運送会社・番号を NULL）
    D->>D: まだ送っていない発送メールを skipped に
  end
  D->>D: 票 cancelled・版+1・cancel の版履歴
  D->>D: 状態の差分（shipment_slip_cancel）・操作の記録
  D-->>A: id・version・restoredQuantity・replayed
  A->>A: 監査 admin.shipment_slips.cancel（票 ID・戻した数量・再送かどうか・結果コード）
  A-->>B: 200
  B->>B: 「発送を取り消しました。」、ダイアログを閉じて票を読み直す
```

| 順 | 内容 |
| --- | --- |
| 引数 | 版・実行者・要求番号の欠け（版は1以上）は `GROUP_G_ARGUMENT_INVALID`（22023）。表は読まない |
| 押さえ〜再送 | `lock_group_g_shipment_slips(票, 空, true)`（追跡に触れるので設定を `FOR SHARE`）→ 4権限（42501）→ 指紋 `{operation, slip_id, actor_id}`（版は含めない）。同じ `request_key` で同じ指紋は保存した結果を `replayed: true` で返し、違えば `GROUP_G_REQUEST_KEY_CONFLICT`（23505） |
| 票 | 無ければ `GROUP_G_SLIP_NOT_FOUND`（P0002）→ 段階が `cancelled` なら `GROUP_G_SLIP_CANCELLED`、`confirmed` でなければ `GROUP_G_SLIP_NOT_CONFIRMED` → 版が違えば `GROUP_G_SLIP_VERSION_CONFLICT`（55000） |
| 拒否の検査 | 書込みの前に**全注文分**。1つでも違反があれば何も書かない（他の注文の発送・割当・台帳・メールを含む）。優先は ① 注文が `paid`・`shipped` でない発送 → `GROUP_G_SLIP_CANCEL_NOT_ALLOWED` ② その発送を指す返品行が `requested`・`open`・`closed` の返品に 1 つでもある → `GROUP_G_SLIP_HAS_RETURN` ③ 発送後の返金（返事待ちを含む）が取消で割れる（`shipped − この発送の数量 < 発送後に返金した数`）→ `GROUP_G_SLIP_REFUNDED`（いずれも 22023）。取消・お断りの返品と、失敗・エラーの返金は数えない |
| 書込み | 発送ごと（`order_id` 昇順）に、後述の順 |

### 書込みの順と、G-1 の即時の確かめ

G-1 の割当の数（`group_g_allocation_bounds`）・台帳の対応（`group_g_stock_movement_consistency`）と、G-3 の消費の裏付け（`group_g_shipment_consumption`）は**遅延**の確かめで、commit の時に最終の状態を見る。割当の変更の守り（`GROUP_G_HISTORY_IMMUTABLE`）・外部キー・一意制約・在庫 F の下限（`stock_quantity >= 0`）は**即時**で、文ごとに働く。次の順にして、**各文の時点で即時の確かめが通り**、遅延の確かめが commit の時に取消と戻しが揃って通るようにした。割当の上限（`残りの合計 <= 明細の数量 − 取り消していない発送の数量`）も遅延の確かめなので、文の途中の状態は見られず、commit の時の最終の状態だけが検査される（順を変えても最終の状態は同じで通る）。そのうえで、途中の状態も意味が通るように、発送の取消を先にして、新しい割当を足す時点でも上限を超えない並びにした（旧の取消と同じ並びで、読取の関数が途中で呼ばれても矛盾しない）。試験は取引の最後に `SET CONSTRAINTS ALL IMMEDIATE` で最終の状態を確かめる。

| 順 | 文 | この順にする理由 |
| --- | --- | --- |
| 1 | 発送の `cancelled_at`・`cancelled_by`（既存の取消の分岐。印なし） | 先に取り消すと、取り消していない発送の数量が減り、続く途中の状態でも新しい割当が明細の上限を超えない（上限そのものの検査は commit の時） |
| 2 | 追跡登録を `cancelled` で止める・要対応を `auto` で閉じる（代表以外は何も変わらない） | 既存の道具 `stop_fulfillment_registrations`・`close_delivery_attention`。（配送業者, 番号）の組の鍵は行の鍵の後に取る |
| 3 | `restore_group_g_shipment`（下の 4 文を consume ごとに） | 1 で途中の状態も上限に収まっている。割当の数・台帳の対応・消費の裏付けは commit の時に最終の状態で検査される |
| 4 | 注文が `shipped` で取消後の未発送が 1 以上なら `paid`（`shipped_at`・運送会社・番号を NULL） | 既存の取消と同じ理由コード `admin_cancel_fulfillment` |
| 5 | まだ送っていない発送メール（`pending`・`retry_wait`）を `skipped`（`last_error_code` は `fulfillment_cancelled`、本文を消す） | 既存の取消と同じ |

`restore_group_g_shipment` は、その発送の行を明細順に、確定の操作の `consume` 出来事を `id` 昇順に取り、出来事ごとに次の 4 文を**この順に**書く（外部キーが先の行を要る）。

| 順 | 文 | 内容 |
| --- | --- | --- |
| ① | 台帳 `restock` | `delta = +n`、`allocation_operation_id` を**付けない**、`order_id`・`order_item_id` つき、備考「発送票 ○○ の発送取消（戻し）」。台帳の対応の確かめは印の付いた行だけを見る |
| ② | 新しい割当 | 同じ明細・variant、数量 = 残り = `n`、`kind = 'paid'`、`operation_id` = 取消の操作。元の割当は一切更新しない |
| ③ | 台帳 `purchase`（交換の品は `exchange`） | `delta = −n`、取消の操作の印つき、備考「発送票 ○○ の発送取消（再確保）」 |
| ④ | 出来事 `restore` | 新しい割当・数量 `n`・連番 1・`reverses_event_id` = その `consume` の id・台帳は ③・理由 `shipment_cancel` |

F は ① で `+n`、③ で `−n` なので下限を割らず、最後は元のまま。戻しは 1 回で、同じ `consume` を 2 度戻そうとすると `order_item_allocation_events` の `reverses_event_id` の一意で止まる。

### お客様向けのメールと追跡

お客様向けの取消のメールは作らない。まだ送っていない発送メールだけを取りやめる（送信済みは変えない）。追跡は代表の登録だけが cancelled で止まり、一度でも外へ登録できた登録は外への停止の印（`provider_stop_pending`）が付く。参加の注文の発送に登録は無い。票×版の親の行は追記専用で変えない。取消後に同じ明細を新しい票へ選んで再発送でき、票番号は次の連番、発送の番号は取消済みも数えた次の番号になる。

### 画面

確定済みの票に「発送を取り消す」を出す（下書き・取消済みには出さない）。ダイアログは見出し「発送を取り消す」・説明「票に含まれるすべての注文の発送を取り消し、品物を発送準備中に戻します。」・「取り消す」「戻る」。`cancelBlockers` を持つ票は、ボタンの上に「注文 ○○ は返品の対象です／発送後に返金済みです／取り消せない状態です」を先に出す（それでもボタンは押せ、DB が最終の判断をする）。送信中は閉じず、二重に押しても通信は1回。DB が断った時（返品・返金・取り消せない状態・版の競合）は表の本文をダイアログの中に出して開いたまま票を読み直す。結果が分からない時は「もう一度確かめる」で同じ本文・同じ `requestKey` を送り直す。成功は「発送を取り消しました。」を出してダイアログを閉じ、票を読み直す。

### 未確認事項

- DB は controller が reset して実測した（別接続の試験と実鍵 PostgREST を含む21 suiteで1,287/1,287成功、全件の単体と DB で18,318件成功。2026-10-25）。実メール送信・実際の外への停止・本番の実データは未確認。
- 390/768/1280px の実測は E2E の担当。

## 伝票番号の後入力・訂正と手動の配達済み（G-3 Task 7）

確定済みの票の**全体に**、伝票番号を入れる・直す操作（FREQ-534-AC-01）と、手動で配達済みにする操作（FREQ-534-AC-02。返品の期限は FREQ-535-AC-04 の一部）。どちらも DB の関数（`private` の DEFINER 本体と、同名・同引数の `public` の SQL INVOKER 入口。service_role だけが EXECUTE）が、票の全注文の有効な発送を1取引で更新する。移行は `20261025134538_group_g3_shipping_actions.sql`（節の印 `G3D`）。書き手の閉じた一覧は72本から74本。旧の発送ごとの関数（`admin_update_fulfillment_tracking`・`admin_mark_fulfillment_delivered`）は `LEGACY_FULFILLMENT_DISABLED`／55000 のまま。

### 順序（伝票番号の入力・訂正）

```mermaid
sequenceDiagram
  autonumber
  participant B as 発送票の頁（伝票番号のダイアログ）
  participant A as POST /api/admin/shipment-slips/[id]/tracking
  participant D as DB 関数 admin_update_shipment_slip_tracking
  B->>B: 「伝票番号を直す」（番号が無い票は「伝票番号を入れる」）→ 運送会社・伝票番号・更新メール
  B->>A: expectedVersion・carrier・trackingNumber・notifyCustomer・requestKey
  A->>A: 認可 4権限、CSRF、IP と actor の回数制限（60回/600秒）、検証（運送会社と番号は両方必須）
  A->>D: 認可済みの userId で RPC を1回
  D->>D: 引数 → 押さえ（設定 FOR SHARE を含む）→ 権限 → 指紋と再送 → 存在 → 段階 → 版 → 変更なし
  D->>D: 状態 before → 操作印
  loop 注文 ID 昇順（有効な発送ごと）
    D->>D: 変更行（from は今の値・NULL 可）→ 発送（印 tracking_edit）→ 出来事 → 注文の写し
  end
  D->>D: 代表の登録を replaced → 要対応を auto → 新しい版の親と代表の登録
  D->>D: 通知オンなら注文ごとに shipping_update を1通
  D->>D: 票（印 tracking）・tracking_update の版・状態の差分・操作の記録
  D-->>A: id・version・trackingVersion・replayed
  A->>A: 監査 admin.shipment_slips.tracking.update
  A-->>B: 200 → 「伝票番号を更新しました。」票を読み直す
```

| 順 | 内容 |
| --- | --- |
| 引数 | 版・実行者・要求番号・通知の欠け、運送会社が3値以外、番号が trim 後 `^[0-9A-Za-z-]{1,64}$` でないのは `GROUP_G_ARGUMENT_INVALID`（22023）。書式が正しくても運送会社か番号のどちらかが空なら `GROUP_G_SLIP_TRACKING_INCOMPLETE`（22023。**空には戻せない**）。表は読まない |
| 押さえ〜再送 | `lock_group_g_shipment_slips(票, 空, true)` → 4権限（42501）→ 指紋 `{operation, slip_id, carrier, tracking_number, notify_customer, actor_id}`（版は含めない）。同じ `request_key` で同じ指紋は保存した結果を `replayed: true` で返し、違えば `GROUP_G_REQUEST_KEY_CONFLICT`（23505） |
| 票 | 無ければ `GROUP_G_SLIP_NOT_FOUND`（P0002）→ `cancelled` は `GROUP_G_SLIP_CANCELLED`、`confirmed` でなければ `GROUP_G_SLIP_NOT_CONFIRMED` → 版が違えば `GROUP_G_SLIP_VERSION_CONFLICT`（55000）→ 運送会社が同じで番号が大文字小文字を無視して同じなら `GROUP_G_SLIP_TRACKING_UNCHANGED`（22023。通知だけの変更も断る。番号が無かった票は常に変更） |
| 書込み | 新しい追跡の版 v = 票の `tracking_version` + 1。有効な発送ごと（`order_id` 昇順）に ① 変更行（`from_*` = 今の値、`to_*`、`tracking_version` = v、`notify_customer`、`request_key` = `md5('slip_tracking:' ‖ 共通のキー ‖ ':' ‖ 発送 ID)` の uuid、E-4 と同じ式の `request_fingerprint`、`changed_by`）② 発送を印 `tracking_edit` で更新（運送会社・番号・通知・`delivery_status = confirmed`・`delivery_status_at = now()`・`delivered_at = NULL`・`tracking_version = v`、作成の指紋が NULL なら補う）③ 出来事 `confirmed`／`tracking_edit` ④ 全部送った発送（`completes_order`）で注文が `shipped` なら注文の運送会社と番号を同じ値へ（理由 `admin_update_fulfillment_tracking`） |
| 追跡 | 代表（有効な発送の最小の `order_id`）の登録を `stop_fulfillment_registrations(代表, 'replaced')` で止め、開いた要対応を `auto` で閉じ、`register_group_g_slip_tracking(票, v, …)` で票×版の親の行と（追跡がオンなら）代表の新しい版の登録（期限は訂正の時刻 + 30日）を作る。参加の発送に登録は作らない。追跡がオフでも親の行だけは作り、全操作が動く |
| メール | `notifyCustomer` なら発送ごとに `enqueue_delivery_email(発送, v, 'shipping_update', 変更行)`。注文ごとに1通。本文は、直す前の番号（変更行の `from_tracking_number`）が無い時は「先にお知らせした伝票番号は使えません」の行とその後の空行を出さない |
| 票 | 印 `tracking`（運送会社・番号・`tracking_version` と版+1）、`shipment_slip_versions`（kind `tracking_update`）、状態の差分（配達済みだった票は `delivered`→`shipped`。理由 `shipment_slip_tracking_update`）、操作の記録 `shipment_slip_tracking_update` |

訂正前の版の借りの印で `record_delivery_read_result` を呼んでも、旧版の登録は止まっていて発送の `tracking_version` も違うので `applied = false` で何も書かない（現行の発送の状況は変わらない）。

### 順序（手動の配達済み）

```mermaid
sequenceDiagram
  autonumber
  participant B as 発送票の頁（配達済みのダイアログ）
  participant A as POST /api/admin/shipment-slips/[id]/delivered
  participant D as DB 関数 admin_mark_shipment_slip_delivered
  B->>B: 「配達済みにする」→ 届いた日（初期値は今日）・配達済みのメール
  B->>A: expectedVersion・deliveredOn・notifyCustomer・requestKey
  A->>A: 認可 4権限、CSRF、IP と actor の回数制限（60回/600秒）、検証（日付の形）
  A->>D: 認可済みの userId で RPC を1回
  D->>D: 引数 → 押さえ → 権限 → 指紋と再送 → 存在 → 段階 → 版 → すでに配達済み → 届いた日の範囲
  D->>D: 状態 before → 操作印
  loop 注文 ID 昇順（有効な発送ごと）
    D->>D: 発送（印 manual）を配達済みへ → 出来事 delivered／manual
    D->>D: 代表だけ: 登録を stopped／delivered・要対応を auto
    D->>D: 発送の通知と入力の両方がオンなら delivered メールを1通
  end
  D->>D: 票（印 deliver・版+1）・delivered の版・状態の差分・操作の記録
  D-->>A: id・version・deliveredAt・replayed
  A-->>B: 200 → 「配達済みにしました。」票を読み直す
```

| 順 | 内容 |
| --- | --- |
| 引数〜版 | 伝票番号と同じ（引数 → 押さえ → 権限 → 指紋 `{operation, slip_id, delivered_on, notify_customer, actor_id}` と再送 → 存在 → 段階 → 版） |
| 配達済み | 有効な発送のどれかが `delivered_at` を持つなら `GROUP_G_SLIP_ALREADY_DELIVERED`（55000） |
| 届いた日 | 発送した日（JST）より前、または今日（JST）より後は `GROUP_G_SLIP_DELIVERY_DATE_INVALID`（22023） |
| 書込み | 発送ごとに `delivery_status = delivered`・`delivery_status_at = delivered_at = GREATEST(shipped_at, LEAST(届いた日 12:00 JST, now()))`（印 `manual`）、出来事 `delivered`／`manual`（`created_by`、`request_key` = `md5('slip_delivered:' ‖ 共通のキー ‖ ':' ‖ 発送 ID)` の uuid、E-4 と同じ式の指紋）。代表の登録は E-4 と同じ更新で `stopped`／`delivered`。通知は `fulfillment.notify_customer` かつ入力がオンの時だけ。票は印 `deliver`（版+1 だけ）、`shipment_slip_versions`（kind `delivered`）、状態の差分（`shipped`→`delivered`。理由 `shipment_slip_deliver`） |
| 返品の期限 | 既存の `fulfillment_line_returnable` が `delivered_at` の日（JST）から数える。コードは変えない。`shipped_at` は動かさない |

### 画面（伝票番号・配達済み）

確定済みの票に「伝票番号を直す」（番号が無い票は「伝票番号を入れる」）と「配達済みにする」を出す。どちらのダイアログも `useDeliverySubmission`（二重防止の番号・結果不明の「もう一度確かめる」）で窓口を呼ぶ。DB が断った時（版の競合・同じ値・配達済みなど）は表の本文をダイアログの中に出し、入力を保ったまま開いておき、票を読み直す（次に押すと新しい版・新しい `requestKey` で送る）。成功は「伝票番号を更新しました。」「配達済みにしました。」を出して閉じ、票を読み直す。

### 未確認事項（Task 7）

- DB（`group_g3_tracking` ほか）は controller が fresh reset して実測した（実鍵 PostgREST を含む19 suiteで1,079/1,079成功、全件の単体と DB で18,870件成功。別セッションの意図的な stockist_rls の赤2件だけ。2026-10-25）。実メール送信・実際の外への登録・本番の実データは未確認。
- 同梱の票の追跡の結果を票の全注文へ反映する処理は、この Task では代表の登録の作成と止めるところまでで、次の節（Task 8）で実装した。

## 追跡の親と配送の読み直しの結果の票への展開（G-3 Task 8）

同梱の票は、外部（17TRACK）への登録を**票×追跡の版に1つ**だけ持ち（FREQ-534-AC-04）、登録されるのは票の代表の発送（確定・訂正の時点で有効な発送のうち `order_id` が最小）の番号だけ。読み直しの結果は代表の借りの印で書き、票の全注文の有効な発送へ同じ内容で広げる（FREQ-541-AC-03）。参加の注文のお客様にも、代表の登録の状態で配送の状況が出る。DB の変更は読取の移行 `20261025070821_group_g3_shipping_reads.sql`（`private.tracking_registration_owner` と3関数の置換）と actions の移行 `20261025134538_group_g3_shipping_actions.sql`（`private.record_delivery_read_result` の置換）。書き手の閉じた一覧は74本のまま。

### 設計 8-1 との差

| 項目 | 設計 8-1 | 実装 |
| --- | --- | --- |
| 親の行（`private.shipment_tracking_registrations`） | 登録状態・lease・再送情報まで持つ作業単位 | **同一性と所属だけ**（票・版・代表の発送・運送会社・番号・操作）。追記専用 |
| 登録の状態・lease・再試行・外への停止の印 | 親の行 | 代表の発送の**既存E-4の行**（`private.fulfillment_tracking_registrations`）。claim・登録の結果・停止・期限切れは従来のまま |
| 要対応 | 注文別 | 代表の発送にだけ付く。票の詳細の `registration` が代表の注文IDを示す |
| 参加の発送 | 注文別の登録 | 登録の行も要対応も作らない |

### 順序（読み直しの結果）

```mermaid
sequenceDiagram
  autonumber
  participant W as 配送の worker
  participant C as claim_delivery_tracking
  participant R as record_delivery_read_result
  W->>C: 借りる
  C-->>W: 代表の1行だけ（参加の発送には登録の行が無い）
  W->>W: 17TRACK を読む（DB のロックの外）
  W->>R: 代表の発送ID・版・借りの印・結果
  R->>R: 共通の鍵 → 設定（FOR SHARE）
  R->>R: 代表が票の代表か（親の行がこの発送を代表と呼ぶ）を引く
  R->>R: 票の全注文を表ごとにまとめて固定（orders → order_items → 割当 → … → 取消申請の明細 → 発送）
  R->>R: 代表の登録の行（借りの印・版・状態・発送の取消を確かめる）
  loop 対象（代表が先頭、続けて有効な他の発送を order_id 昇順）
    R->>R: 出来事・状況・配達中/配達済みのメール・配達済みの反映（操作の記録と品物の状態）
  end
  R->>R: 代表だけ: 登録の更新・要対応の開閉
  R-->>W: applied・changed・stopped（代表について1回）
```

| 順 | 内容 |
| --- | --- |
| 引数〜設定 | G-1 の本体のまま（引数 → 共通の鍵 → 設定 FOR SHARE。設定オフ・発送が無いは何も書かない） |
| 票の引き | `private.shipment_tracking_registrations` に「代表 = この発送・追跡の版 = 引数」の行があればその票。無ければ票に属さない（または参加の）発送で、従来どおり自分の注文だけを固定する。どちらの表も追記専用なので、共通の鍵を持つ間の読みは変わらない |
| 固定 | 票の代表: G-1 の本体と同じ12表の並びを、各表を票の全注文（id 昇順の `ANY(票の注文)`）で1回ずつ。ある表を固定した後に前の表の別の注文へ戻らない（設計7-3）。発送の表は票の注文の発送を全部（id 昇順）、そのあとで代表の登録の行（借りの印の確かめと更新）。在庫の閉包の道具は呼ばない（variant・商品・近隣の注文まで広げると、この worker が今より多く取るため） |
| 確かめ | 借りの印・期限・登録の状態が registered・発送が取り消されていない・発送の版 = 引数の版。合わなければ `applied = false` で何も書かない（訂正前の版・取消の後・別の借りの印） |
| 対象 | `v_targets` = 代表（先頭）＋その票の他の有効な発送のうち同じ追跡の版で**まだ配達済みでない**もの（`order_id` 昇順）。票に属さない発送は代表だけ。代表が未配達のまま参加だけが配達済みという状態は今のどの経路でも起きないが、起きても後の読み直しがその配達済みの時刻を消さないための絞り込み |
| 対象ごとの書込み | 出来事（同じ版・状況・時刻は一意で増えない）、`apply_tracking_status`（状況）、配達中の状況なら `out_for_delivery` のメール、配達済みなら届いた時刻（各発送の `shipped_at` との `GREATEST`）・`delivered` のメール・配達済みの反映（`delivery_reflect` の操作と品物状態 shipped→delivered。冪等キーは `md5('delivery:' ‖ 発送ID ‖ ':' ‖ 版 ‖ ':delivered')` の uuid を発送ごとに）。メールは通知オンの注文ごとに1通 |
| 代表だけ | 登録の行の更新（読んだ時刻・次の時刻・配達済みなら stopped／delivered・STOPPED の合図なら provider_stopped）、要対応の開閉（荷物が見つからない・配達失敗・不在・追跡が止まった）、戻り値 |

追跡の訂正（Task 7）の後は、旧版の代表の登録は止まり発送の版も上がるので、旧版の借りの印の結果は確かめで `applied = false` になり、参加を含め何も変わらない。票の取消（Task 6）では代表の登録だけが取り消しで止まる（外へ登録済みなら外への停止の印）。参加の発送には何の印も付かない。追跡がオフの間も親の行は版ごとに作られ、全操作が動く。あとからオンにすると取り込みの対象は票ごとに現在の版の代表だけになる。

### 未確認事項（Task 8）

- controllerが修正前のTask 9をfresh resetし、実鍵PostgRESTを含む12 suite・639/639成功（2026-10-26）。Fix round 1の後も、controllerがfresh resetし実鍵PostgRESTを含む12 suite・642/642成功（2026-10-26）。追跡の親・顧客向けの実鍵PostgRESTの経路を含む。
- 実際の 17TRACK・実メール・本番の実データでの票ごとの1回の登録は未確認。追跡はオフのまま開店する前提で、オンにする前の確認は[運用手順](../../06_Operations/webhook-queue-operations.md)にある。

## 出荷日の訂正（G-3 Task 9）

確認日: 2026-10-26。FREQ-535 AC-03・04・05、FREQ-540 AC-10・11。controllerが修正前のTask 9をfresh resetし、実鍵PostgRESTを含む12 suite・639/639成功（2026-10-26）。Fix round 1の後も、controllerがfresh resetし実鍵PostgRESTを含む12 suite・642/642成功（2026-10-26）。

```mermaid
sequenceDiagram
  participant U as 訂正権限を持つ人
  participant A as 訂正の窓口
  participant D as admin_correct_shipment_date
  U->>A: 票ID・版・新しい日・理由・キー
  A->>A: 訂正3権限 → CSRF → IP30/600 → actor30/600 → 検証
  A->>D: 認可actorと本文
  D->>D: 引数 → lock(false) → 権限 → 指紋と再送
  D->>D: 存在 → 段階 → 版 → 同日 → 範囲 → 配達日
  D->>D: 票の日付と版 → 有効発送の日付 → 日付履歴 → 票の版 → 操作
  D-->>A: id・version・shipmentDate・replayed
  A-->>U: 監査後に200とno-store
```

指紋はSHA-256の `{operation:'shipment_date_correct',slip_id,shipment_date,reason,actor_id}`。理由はJavaScript trimと同じ空白集合を除去した後、版を含めない。lock前に表参照・public/private関数呼出しを置かない。lock_group_g_shipment_slips(票ID配列,空uuid配列,false)の共通advisoryから在庫閉包・票を既存順に固定する。空理由は他引数の検証後に専用エラー。

全注文の最遅JST入金日以上・今日JST以下、有効な発送のどれかの配達日JSTより後は拒否。印dateで票の日付・version+1・updated_at、印shipment_dateで有効発送の日付を更新し、その直後に元のapp.fulfillment_changeへ戻す。correction（前後日付・理由・actor・版・操作）、date_correction（理由つき）、操作の順に追記。途中失敗は全て戻し、操作印は成功・失敗とも復元。

shipped_at・confirmed_at・delivered_at、返品期限、メール、品物状態、割当、在庫、追跡の版・登録は不変。会計入力は訂正後の日と最新履歴idのrevision_idを返すが、KPI・会計・売上の計上基準には接続しない。
