# 発注書の状態（G-2）

> 状態: 保存する2段階と、導出する3つの表示段階（導出する関数は Task 5）は現行のソース（グループ G-2 Task 2・4・5。本番へは未適用） | 確認日: 2026-10-25 | 対象: `purchase_orders.stage` と、画面に出す5つの表示段階

## 概要

発注書の「段階」は、**DB に保存する2つ**と、**保存せず納品・未納・打切りから導く3つ**に分かれる。保存するのは `ordered`（発注確定の直後。数量は仮）と `quantity_confirmed`（数量が確定済み）だけで、受け取りの進み具合や打切りでは `stage` を変えない。画面には、この2つに導出の3つを足した5つの表示段階を出す。`draft`（入力途中）は画面の中の状態で、DB に保存しない。

| 層 | 値 | 保存 | 更新主体 |
| --- | --- | --- | --- |
| 保存する段階 | `ordered`、`quantity_confirmed` | `purchase_orders.stage`（CHECK 制約。既定 `ordered`） | 作成は `admin_create_purchase_order`（Task 4）、`quantity_confirmed` への進みは数量確定の関数（Task 6） |
| 導出する表示段階 | `ordered`、`quantity_confirmed`、`partially_received`、`received`、`closed` | しない（読取の関数が毎回導く） | 内部の helper `private.purchase_order_display_stages`（Task 5。導くのはここ1か所） |
| 画面だけの状態 | `draft` | しない | 在庫一覧表の発注モード（入力と確認） |

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 対応要件 | FREQ-526（発注の作成）、FREQ-527・528（数量確定と打切り。後続 Task）、FREQ-529（受け取り。後続 Task） |
| 設計 | [グループ G 設計書](../../superpowers/specs/2026-10-23-group-g-design.md)、[G-2 実装計画](../../superpowers/plans/2026-10-24-group-g2-purchasing.md)の「決めたこと」 |
| 実装 | 表と CHECK は移行 `20261024153505_group_g2_purchasing_foundation.sql`、作成は `20261024180500_group_g2_purchasing_writers.sql`、型は[共通の定義](../../../src/lib/purchase-orders/purchase-order-types.ts) |
| 関連 | 書込みの順序は[発注書の作成の流れ](../sequence/purchasing.md)、在庫の割当は[在庫の割当の状態](inventory-allocation.md) |
| 調査時点 | 2026-10-25。導出の式は Task 5 の移行（`20261024153505_group_g2_purchasing_foundation.sql` の節15）に実装した。DB での実行の検証は[発注の読取の試験](../../../tests/integration/db/group_g2_purchase_reads.integration.test.ts)（controller が使い捨て DB で流す） |

## 状態定義

| ID | 種類 | 値 | 意味 | 表示の文 |
| --- | --- | --- | --- | --- |
| ST-PO-01 | 保存 | `ordered` | 発注を確定した直後。明細の数量は仮（`provisional_quantity`）で、確定数量は未設定。受け取りはできない | 数量確定待ち |
| ST-PO-02 | 保存 | `quantity_confirmed` | 数量が全行そろって確定した。確定数量・納品済み・未納（確定数量 − 納品済み）を持つ。訂正してもこの段階のまま | 数量確定済み・受け取り待ち |
| ST-PO-03 | 導出 | `partially_received` | `quantity_confirmed` で、納品が1つ以上あり未納が残る | 一部受け取り済み |
| ST-PO-04 | 導出 | `received` | `quantity_confirmed` で、全行の未納が0で、打切りが無い | 受け取り完了 |
| ST-PO-05 | 導出 | `closed` | `quantity_confirmed` で、全行の未納が0で、打切りがある（確定前の発注の取消も、確定数量を全行0にした打切りとして、ここに入る） | 完了（残りを打ち切り） |

## 図

```mermaid
stateDiagram-v2
  [*] --> ordered : 発注確定（admin_create_purchase_order）
  ordered --> quantity_confirmed : 数量確定または確定前の取消（全行を渡す）
  state quantity_confirmed {
    [*] --> waiting : 納品なし
    waiting --> partially_received : 一部を受け取る
    partially_received --> partially_received : 続けて一部を受け取る
    waiting --> received : 全部を受け取る
    partially_received --> received : 残りを受け取る
    waiting --> closed : 残りを打ち切る
    partially_received --> closed : 残りを打ち切る
    received --> partially_received : 受け取りの取消や数量の訂正で未納が戻る
  }
```

内側の状態 `waiting` の表示の文は「数量確定済み・受け取り待ち」。外側の遷移は保存する `stage` の変化、内側は保存せず導く表示段階の変化。訂正・単価・発注先の訂正・受け取り・打切りは `quantity_confirmed` のまま（`stage` は変えない）で、下の遷移条件表に書く。

## 表示段階の導き方（実装）

導くのは DB の内部の関数 `private.purchase_order_display_stages(uuid[])`（STABLE の SECURITY DEFINER。誰にも EXECUTE を付けず、発注一覧表の読取 `list_admin_purchase_order_lines` と発注書の詳細の読取 `get_admin_purchase_order` だけが呼ぶ）の**1か所だけ**。戻りは 発注書の id・表示段階・納品の合計・未納の合計・`has_active_short_close`。納品の合計・未納の合計は発注書の明細の `received_quantity`・`outstanding_quantity`（確定数量 − 納品済み。未確定の行は NULL で、合計では 0 として数える）の和。

| 順 | 条件 | 表示段階 |
| --- | --- | --- |
| 1 | 保存する段階が `ordered` | `ordered` |
| 2 | 未納の合計 > 0 かつ 納品の合計 = 0 | `quantity_confirmed` |
| 3 | 未納の合計 > 0 かつ 納品の合計 > 0 | `partially_received` |
| 4 | 未納の合計 = 0 かつ（`has_active_short_close`、または納品の合計 = 0） | `closed` |
| 5 | 未納の合計 = 0 かつ 納品の合計 > 0 かつ `has_active_short_close` でない | `received` |

`has_active_short_close` は「ある明細の、数量に関わる最新の版が打切りである」時に真。数量に関わる版は `purchase_order_revisions` の、種類 `short_close`（打切り）と、**数量が実際に変わる**種類 `quantity` の版（`before_quantity` と `after_quantity` が違う。NULL 同士は同じとみなす）で、明細ごとに `revision_no` が最大の1件を取り、それが `short_close` なら真（`order`・`header` の版は数えない）。単価だけを直す `quantity` の版（数量は変わらない。Task 6 の確定・訂正の関数は単価の変更もこの種類で記録する）は打切りを戻さないので、打切りの後に単価を足しても `closed` のまま。誤って打切った後に数量を戻す再確定（数量が変わる、より新しい `quantity` の版）をした明細は偽に戻るので、全部を受け取った後は `received` になる。全行を確定数量 0 で確定した（確定前の取消も含む）発注書は、納品の合計が 0 なので打切りの版が無くても `closed`。

## 遷移条件

| ID | 契機 | 条件 | 副作用 | 実行 |
| --- | --- | --- | --- | --- |
| ST-PO-T1 | 発注確定 | 権限の組があり、引数が範囲内で、variant が全て存在する | 発注書・明細・履歴・操作の記録を1取引で保存。版 1、段階 `ordered` | `admin_create_purchase_order`（Task 4） |
| ST-PO-T2 | 数量確定 | 段階が `ordered`。発注書の全行を一度に渡す | 段階 `quantity_confirmed`、版 +1、変化した行を履歴へ | Task 6 |
| ST-PO-T3 | 確定前の発注の取消 | 段階が `ordered`。全行を渡した打切り | 確定数量を全行0にして段階 `quantity_confirmed`、打切りの履歴に仮数量を残す。表示は `closed` | Task 6 |
| ST-PO-T4 | 数量の訂正・単価・発注先の訂正 | 段階が `quantity_confirmed`。納品済み未満には訂正できない | 版 +1、履歴 | Task 6 |
| ST-PO-T5 | 受け取り・その取消 | 段階が `quantity_confirmed`。未納以下の数 | 納品済みの合計が変わる（導出する表示段階が変わる）。段階は変えない | Task 7 |
| ST-PO-T6 | 残りを打ち切る | 段階が `quantity_confirmed`。未納がある | 確定数量を納品済みまで下げ、未納0にする。段階は変えない | Task 6 |

逆向きの遷移（`quantity_confirmed` から `ordered` へ戻す）は無い。`UPDATE` は `purchase_orders` の `version` を1つずつ進め、共通の鍵を持つ接続だけが書ける（DB の守り）。

## 独立属性・冪等性

| 属性 | 内容 |
| --- | --- |
| 版 | `purchase_orders.version` と `purchase_order_lines.version`。作成は1。更新のたびに +1 し、利用者の画面が古い版で送ると `GROUP_G_PO_VERSION_CONFLICT`（後続 Task） |
| 履歴 | `purchase_order_revisions` は追記専用。`revision_no` は更新後の版。作成は種類 `order` の `revision_no` 1 |
| 冪等 | 作成は `(purchase_order_create, request_key)` と入力の指紋。同じ再送は同じ発注書を返し、状態を進めない |
| 納品の整合 | 納品済みは受取行の合計と一致する（commit の時に DB が確かめる）。未納は確定数量から導く生成列 |

## 関連テスト

| 層 | テスト |
| --- | --- |
| 単体 | [共通の定義（段階の文・エラー表・読取の検査）](../../../tests/unit/lib/purchase-orders/purchase-order-types.test.ts)、[画面の段階の文](../../../tests/unit/components/PurchaseOrderDetailSection.test.tsx) |
| DB 結合 | [発注の作成（版 1・段階 ordered）](../../../tests/integration/db/group_g2_purchase_create.integration.test.ts)、[発注書の9表と守り](../../../tests/integration/db/group_g2_purchase_model.integration.test.ts)、[発注の読取（表示段階の導出）](../../../tests/integration/db/group_g2_purchase_reads.integration.test.ts) |

## 未確認事項

- 導出の式は Task 5 の試験が、直接 INSERT / UPDATE の材料で全分岐（`ordered`・`quantity_confirmed`・`partially_received`・`received`・`closed`、打切りを数量の変わる再確定で戻した場合、打切りの後に単価だけの `quantity` の版を足しても `closed` のままの場合）を確かめる。数量確定・打切り・受け取りの**関数を通した**段階の遷移（部分受取・全受取・打切り・打切りを再確定で戻して全部を受け取った後の `received`・打切りの後の単価の追加）は Task 6・7 の試験が確かめる。Task 6 の確定・訂正の関数は、単価だけが変わった明細にも `quantity` の版を書く（`before_quantity` = `after_quantity`）ことを、この規則が前提にしている。
- 数量確定・打切り・受け取りの関数（Task 6・7）は未実装。上の遷移表の「実行」が Task の列になっているものは、まだコードに無い。
