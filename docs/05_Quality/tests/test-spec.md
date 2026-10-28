# テスト仕様

> 波 4 確認日: 2026-10-28。開店前のセキュリティの穴 波 4（送り元の IP の取り出し・回数の鍵・管理の監査の IP・取扱店の認可の拒否の監査・管理画面の CONTACT タブ）の新しい試験と外した `test.fail` 16 行を、下の「開店前のセキュリティの穴 波 4 のテスト」に記載した。本番ビルドの E2E 全件は 185 failed・4832 passed・26 skipped（波 3 の 183 failed と比べて新しく赤になった 10 ファイルは 1 並列の再実行で 200 件とも通った。並列の揺れ）。

> 波 3 確認日: 2026-10-28。開店前のセキュリティの穴 波 3（画像の署名・CSP・`session_id` の発行範囲・`/api/auth` の `no-store`・LOOK の og:image・ビルドの必須の環境変数）の新しい試験と外した `test.fail` 18 行を、下の「開店前のセキュリティの穴 波 3 のテスト」に記載した。本番ビルドの E2E 全件は 183 failed・4828 passed・26 skipped（G-4 の 181 failed から増えたのは商品詳細の揺れ 2 件だけ）。

> G-4 Task 12 確認日: 2026-10-27。返品・キャンセル申し込み・一覧の表示・配送・設定の既存E2E（050・069・070・072・076・079・084〜099・102〜104・119・123と共有の道具）を詳細頁/注文一覧表へ付け替え・整理し、旧い一覧の窓口の差し替え（mockOrderList）とORDERタブを開く道具（openOrderTab）を削除した。旧い410の宿題の仕上げ（走査をe2e・testsへ広げた許可リストの試験）を含む。下のTask 12に現行の期待を記載。本番buildのE2Eはcontroller待ち。
>
> G-4 Task 11 確認日: 2026-10-27。詳細の操作122（11case）と返金・取消・要対応・履歴15ファイルを詳細/新一覧へ付け替えた。下のTask 11に現行の期待を記載。本番buildのE2Eはcontroller待ち。

> G-4 Task 10 確認日: 2026-10-27。FR-ADMIN-112・123(G-4)と旧410期待の修正、117の詳細へのLinkを追加。controllerの本番build・1 workerでの実測を受領し、fix round 1で状態の完全一致・描画待ち・権限シナリオ・bridge検査を修正。修正後E2Eはcontroller待ち。下のTask 10参照。
>
> G-4 Task 9 確認日: 2026-10-27。注文一覧表・品物のステータス・全件CSVのE2E（FR-ADMIN-110・121）と、その道具（e2e/order-admin-test-utils.ts・e2e/order-fulfillment-test-utils.ts の詳細の道具）を下のG-4節のTask 9へ、荷作り表の注文IDの確かめ（FR-ADMIN-116）の付け替えを116の行へ記載。型・lintまで実装者が確かめた。本番ビルドのE2E（390/768/1280px）の実測はcontrollerが流した: r1 は 115 通過・6 失敗（116 ③と121 ③の試験側の直し）、r2 は 103 通過・0 失敗、r3・r4（既定の4 workers）は各 121 通過・0 失敗。Opus レビューの直しの後: r5（1 worker）・r6・r7（4 workers）は各 118 通過・3 失敗（121 ⑥ ×3幅の `history.length` を「戻る」の後に測った試験側の誤り。測りを直した）、r8（121 だけ・1 worker）は 73 通過・0 失敗、r9・r10（110+121+116・4 workers）は各 121 通過・0 失敗（下のTask 9の実測記録）。
>
> G-4 Task 8 確認日: 2026-10-27。荷作り表・発送票の注文番号の Link、履歴の dialog の撤去（`OrderHistoryDialog` → `OrderHistoryPanel` の改名）、旧い発送・仕上がりの窓口6ファイル・7メソッドの削除の単体を下のG-4節のTask 8へ記載。単体の実測は実装者のjest・tsc・lintまで。DB・実ブラウザの3幅・E2E・buildはcontroller担当で未実行。

> G-4 Task 7 確認日: 2026-10-26。注文一覧表の頁・表・要対応のhook・ORDER タブの入口・旧い入口の撤去の単体を下のG-4節のTask 7へ記載。旧い一覧の窓口と旧wiring試験は削除した。単体の実測は実装者のjest・tsc・lintまで。DB・実ブラウザの3幅・E2E・buildはcontroller担当で未実行。

> G-4 Task 6 確認日: 2026-10-26。注文の詳細頁・品物の表・入替dialog・履歴の欄・clientの単体を下のG-4節のTask 6へ記載。単体5 suite・186件、広い単体（components・lib/orders・api/admin・docs）280 suite・10,383件が成功。DB・実ブラウザの3幅・E2Eはcontroller担当で未実行。

> G-4 Task 5 確認日: 2026-10-26。入替store・POST/候補GET・clientと準備中0件の権限カタログを反映。controllerのcleanup修正後の実PostgRESTはG-3/G-4合計62/62、G-4再実行21/21。全件g4t5は20,300成功・既知stockist_rlsの2失敗のみ、G-0清掃12/12。fix round 2で500診断・試験参照・候補GETの単体を補強した。

> G-4 Task 4 確認日: 2026-10-26。割当の入替（G4C）のDB試験・並行試験・末尾assertの改ざん・書き手76本の構造を下のG-4節のTask 4へ記載。fix round 2後のcontroller fresh reset（g4t4b）でgroup_g*全53 suite・1,721成功・0失敗・1 pending、並行12/12を3回連続。実鍵ありのunit＋全DB integrationは20,178成功・既知stockist_rlsの2失敗だけ。G-0清掃12/12。詳細は下の「Task 4の記録」。本番未適用。

> G-4 Task 3 確認日: 2026-10-26。読取store・CSV・3つのGET・管理履歴と旧集計の試験を下のG-4節へ記載。controller受領記録（g4t3a）: fresh reset後、実鍵のgroup_g4_postgrest_pathsを含むgroup_g*全51 suiteで1,616成功・0失敗・1 pending（G1_CLEANUP_SUITE=1で単独実行するG-1清掃の未起動）。 全件の確認は controller が後で実施。

> G-4 Task 2 確認日: 2026-10-26。初回（g4t2a）はfresh reset・PostgREST anon/authenticated各200、group_g* 50 suite・1,606成功・0失敗・専用G-1清掃の1 pending。初回の全件（g4t2）はunit＋全DB integrationで19,912成功・既知stockist_rlsの2失敗だけ、G-0清掃12/12。修正round 1後（g4t2b）: controllerのfresh reset・PostgREST anon/authenticated各200、group_g* 50 suite・1,611成功・0失敗・1 pending（G1_CLEANUP_SUITE=1専用清掃の未起動）。unit＋全DB integrationは19,935成功・既知stockist_rlsの2失敗のみ（新規失敗なし）、G-0清掃12/12。本番未適用。

> 状態: 現行の方針（波 1-C のセキュリティの穴の修正のテストの節は 2026-10-26 に追記〔単体・結合は通過、E2E は controller が本番ビルドで実測済み、DB 結合は未実行〕。波 1-B のセキュリティの穴の修正のテストの節は 2026-10-26 に追記〔単体・結合は通過、E2E・DB 結合は未実行〕。G-3 Task 12 の発送票の操作・出荷日のE2Eと止めていた旧の発送のE2Eの移設の節は 2026-10-26 に追記〔E2Eの実測は controller の実行後〕。G-3 Task 11 の荷作り・同梱メール・権限のE2Eと再開した配送のE2Eの節は 2026-10-26 に追記〔E2Eの実測は同節に記録〕。G-3 Task 10 の書き手75本・末尾assert・並行・実PostgRESTの節は 2026-10-26 に追記。G-3 Task 8 のテストの節は 2026-10-26 に追記。グループ G-1 のテストの節は 2026-10-24 に、グループ G-2 のテストの節は 2026-10-25 に追記し、Task 3 の在庫一覧表と Task 4 の発注の作成と Task 5 の発注一覧表・発注書の詳細と Task 6 の数量の確定・訂正・打切り・発注先の訂正と Task 7 の受け取りとその取消・数量訂正と Task 8 の取引書類の原本の分と Task 9 の書き手の閉じた一覧・全入口の並行・移行の末尾の確かめの分と Task 10 の E2E（FR-ADMIN-111・113・114・115・119 と FR-ADMIN-123 の G-2 の節）の分も同日に足した） | 確認日: 2026-10-25（G-3 Task 7の伝票番号の後入力・訂正と手動の配達済みのDB・単体を追記）（G-3 Task 6の発送の取消のDB・単体を追記）（G-3 Task 4の発送票の下書きのDB・単体を追記）（G-3 Task 3の読取の窓口・画面・管理メニュー・旧い案内の置換の単体を追記）（G-3 Task 2の読取DB部分を追記）（G-3 Task 1 を追記） | 対象: 要件からテストへの追跡、テストの層、開始・終了条件 | G-3 Task 9 確認: 2026-10-26（修正前はfresh reset・12 suite・639/639成功、Fix round 1は再検証対象）

> G-4 Task 1 確認日: 2026-10-26。g4t1aでローカル適用・PostgREST両200、修正round 1の対象DB 3 suite・94/94成功。controller全件g4t1は19,665成功・既知stockist_rlsの2失敗だけ、G-0清掃12/12。本番未適用。

## 概要

この文書は、要件からテストへの追跡方法、実行するテストの層、判定と記録の方法を定める。下表のテストファイルはリポジトリで確認した例であり、ここに列挙したことは実行・成功を意味しない。グループ G-1（在庫の割当）のテストは、層の説明の後の「グループ G-1（在庫の割当）のテスト」にファイル単位でまとめる。グループ G-2（発注・受け取り）のテストはその後の「グループ G-2（発注・受け取り）のテスト」にまとめる。

## グループ G-4 のテスト

### Task 1（土台）

対象は FREQ-540-AC-14 と FREQ-523-AC-03 の土台。UI・公開の入替操作・transfer の対と数量保存は後続 Task。既存の G-1〜G-3 と別セッションの移行を編集せず、G4A を追加して確かめる。

| ファイル | 層・事前条件・入力 | 期待結果 |
| --- | --- | --- |
| [group_g4_foundation](../../../tests/integration/db/group_g4_foundation.integration.test.ts) | ソース照合とローカル DB。controller の fresh reset 後、各試験を BEGIN・共通 advisory・ROLLBACK 内で実施 | G-3 の確定文から `CREATE OR REPLACE` と期限比較の2箇所だけがバイト差分。DB の prosrc は G-3 の比較を `<` → `<=` とした本体と空白を畳んで一致。索引は非一意 btree(order_id)、enable_seqscan=off の EXPLAIN で使う。置換前後の OID・所有者・生のACL配列・属性・書き手OID集合は不変（本数は固定しない）。expires_at=now() は expired=true と GROUP_G_SLIP_DRAFT_EXPIRED / 55000、1秒先は expired=false と次の空明細検証 GROUP_G_SLIP_EMPTY / 22023 |
| 同上（理由） | 実際の割当イベント INSERT を、従来17値・allocation_swap・NULL・未知値・綴り違いで各 savepoint 内から試す。consume の遅延整合検査前に各 probe を rollback | 18値とNULLは理由 CHECK を通り、未知・綴り違いは 23514 / order_item_allocation_events_reason_check。これは CHECK の試験であり、入替業務の実行・COMMITやtransfer保存則の証明ではない |
| [group_g4_migration_asserts](../../../tests/integration/db/group_g4_migration_asserts.integration.test.ts) | ソースと、取引内の索引・確定関数・理由CHECK・行・許可一覧の改ざん。G4A 分のみ | ASCII/LF・先頭BEGIN・1組の末尾assert/NOTIFY/COMMIT・節印・本体外DMLなし。正常・異なるsearch_path・無関係なgrantee・過去行は許す。索引欠落/一意/別列/部分索引、期限比較の後退/anon EXECUTE/所有者/ロック前参照、理由の欠落/過剰/NULL排除/別条件の追加、この取引の2表の行、74/76本を拒否し、55000 と5つの項目名の DETAIL を返す。一意性は同じ代替表の1列btree(order_id)で、非一意なら通り、一意なら拒否する対照で単独検査 |
| [allocation-event-reasons](../../../tests/unit/lib/inventory/allocation-event-reasons.test.ts) | 単体。supabase/migrations/*.sqlをすべて読み、理由CHECKの本文を持つ移行を抽出して最新の定義とTSを比較する | 最新 CHECK は G4A の1定義、18値完全一致・重複なし・全値の日本語・allocation_swap の「割当の入替」・未知値の「システム」を検査。Group G以外や後続グループによるCHECK変更も検出する |
| [group_g3_migration_asserts](../../../tests/integration/db/group_g3_migration_asserts.integration.test.ts)・[group_g3_model](../../../tests/integration/db/group_g3_model.integration.test.ts)・[共有の道具](../../../tests/integration/db/helpers/group-g-allowlist.ts) | G3A 再実行は理由 CHECK を17値に戻してから改ざん。G4A は G3D_ALLOWLIST の75本を取引内で再現 | prelude → change → swap → assertion の順を保ち、理由CHECKの改ざんが復元で消えない。rollback 後は現在の18値と書き手へ戻る。PG17 MAINTAIN を版で守る既存 G3A ACL 検査も維持 |

実装者の単体 RED は7件中3失敗・4成功、実装後は7/7成功（2026-10-26）。DB suiteとその中のソース試験の実測は次のとおり。本番未適用。

| 実行者・記録（2026-10-26） | 実測結果と境界 |
| --- | --- |
| controller fresh reset（g4t1a） | 20261026045859_group_g4_orders_foundation.sql適用、PostgREST anon/authenticated各200。実鍵PostgRESTを含むgroup_g*全49 suiteは1,526成功・1失敗・1 pending。失敗はG4Aのowner-to-anon材料がassert前に42501となる1件で、SQLを変えず修正round 1で解消 |
| 通常実行の1 pending | [group_g1_cleanup.integration.test.ts](../../../tests/integration/db/group_g1_cleanup.integration.test.ts) の `G1_CLEANUP_SUITE=1 で単独に流す時だけ動かす（全注文を消して commit するため）`。全注文を消す専用suiteを通常の全件実行では起動しない印であり、清掃の成功件数には数えない |
| 実装者の修正round 1、ローカルDB | group_g4_migration_asserts・group_g4_foundation・group_g3_migration_assertsの3 suite、94成功・0失敗・skip/pendingなし |
| controller fresh reset後の全件検証（g4t1） | unit＋全DB integrationは19,665成功、既知のstockist_rlsの赤2件だけが失敗し、新規失敗なし。G-0基準の清掃suiteは別に12/12成功 |

修正round 2は既存ケースの置換と試験内の対照追加で、試験件数は変更しない。文書の整合検査は先頭AC IDのない題名とし、FREQ-540-AC-14の動作を証明する試験には数えない。

### Task 2（読取・金額・返金・状態履歴）

対象はG4Bの内部3本・private読取4本・public入口4本。DB結合はlocalhostに限り、controllerのfresh resetと既存のanon/実authenticatedのPostgREST smoke各200の後に流す。各ケースは固有のメール/IDとBEGIN→共通advisory→ROLLBACKで隔離し、期待エラーはsavepointで回収する。型・文書単体の成功をDB実測に代えない。

| ファイル・対象 | 層・事前条件・入力 | FREQ/AC | 期待結果 |
| --- | --- | --- | --- |
| [group_g4_reads](../../../tests/integration/db/group_g4_reads.integration.test.ts)：一覧・絞り込み | DB結合。混在する12状態、複数注文/明細、2行の頁、JSTの日境界、注文番号/pi、商品・顧客の語、要対応/解決済み、cap設定 | FREQ-536-AC-01・02・03、FREQ-520-AC-03 | 共通欄と購入時の写し、状態別数量/順位、非表示2状態の除外、NULL variant、安定順と頁によらない総数。customer/emailの%と_は別フィルタなしの4ケースでも文字どおり一致。attention=trueだけ要対応へ絞り、false/未指定は同じ全候補。新しい注文capを0行でも旗で知らせる |
| 同上：商品額と返金 | DB結合。割引、離れた状態区間、3種類の返金、重複部分返金、対象状態0、別明細の独自返金、交換品の返品、送料と負の調整額 | FREQ-537-AC-01〜05 | 正味100を33/33/34または33/67。既存行別割引を再利用。mainのdelivered250/cancelled400/returned900と別明細175を分離、refundNotAttached=-15。部分返金700+300と別明細125を分離し送料/調整=-30。対象0のmain50/51と別明細75を分離し送料/調整の合計=-25。未成功は商品返金へ含めない。交換の単価/商品額0、返金は自分だけ。⑧は通常1000/交換200を明細ごとのDB集計と突き合わせ、合計商品返金1200+送料調整70=返金済1270 |
| 同上：CSV材料 | DB結合。全頁の外を含む同じ条件、一覧cap=2とCSVcap=2、候補数超過、投影を呼ぶと失敗する取引内stand-in、不正/上げる設定 | FREQ-538-AC-02・05、FREQ-536-AC-03 | 1つのSTABLEなjsonbで一覧全頁と値/順/件数が一致し、needsAttention/blockedReasonsなし。一覧capに依存せず全行かGROUP_G_EXPORT_TOO_LARGE / 22023。候補注文cap超は投影前に拒否、切った行は返さない |
| 同上：詳細・認可 | DB結合。有効/無効/期限切れ/役割なし、役割権限の一時変更、未解決/解決済みの3種要対応、注文不在、payment_in_progress | FREQ-539-AC-01、FREQ-540-AC-13、FREQ-536-AC-05 | 全4入口が有効役割の和集合のorders.readを確認し、なければGROUP_G_FORBIDDEN / 42501。店長/サポーターのpermissions、要対応3種、GROUP_G_ORDER_NOT_FOUND / P0002、非表示注文の空rows。anon/authenticatedの入口EXECUTEなし |
| 同上：状態履歴 | DB結合。実G-3確定・G-2受取、actor NULL、入替operation、同時刻302イベント、別注文 | FREQ-539-AC-04 | 発送票/発注書の番号つき参照、入替の理由と反対側の注文ID、NULL actorの保持、created_at DESC→id、最大301行、別注文が混ざらない |
| [group_g4_migration_asserts](../../../tests/integration/db/group_g4_migration_asserts.integration.test.ts)：G4B部分 | ソース2ケース＋DB改ざん24ケース。既存G4A19ケースは維持。取引内で権限/属性/署名/所有者/委譲/書込み文を変更してrollback | FREQ-540-AC-13 | ASCII/LF・BEGIN/NOTIFY/COMMIT各1組・11関数・STABLE・private schema USAGE操作なし。正常形とsearch_pathの対照は成功。内部EXECUTE、public/anon/authenticated付与、VOLATILE、入口欠落、overload、別委譲、一時ロールのowner、5種類の書込み文をGROUP_G_MIGRATION_ASSERTION_FAILED / 55000で拒否。DETAILはorders_reads_internal/functions/public/no_write。ACLは意味で比較 |
| [group-g4-fixtures](../../../tests/integration/db/helpers/group-g4-fixtures.ts) | 上記DB結合の材料。既存のG-3 ready/G-1 allocation・shipment/E-3 return・refund/cancel request helperを使用。単独の試験数には数えない | FREQ-520-AC-03、FREQ-537-AC-01〜05 | 固有のメール/ID、金額等の不変値はINSERT時に決定。重複数量や対象0の防御的な返金は指定明細だけを写す代替表とsavepointを使い、元表OID・triggerモード・名前を復元。非ゼロ交換価格のprobeだけCHECKを取引内で外して復元。正規の発送は防御的な返金をrollbackした後に作る。G-1投影/通常ガードは変更しない |

| 記録（2026-10-26） | 実測と境界 |
| --- | --- |
| 初回（g4t2a）、controller fresh reset | G4B適用、PostgREST anon/authenticated各200。group_g* 50 suite・1,606成功・0失敗・1 pending。pendingは上記G-1清掃の専用フラグなしによる未起動 |
| 初回の全件（g4t2）、controller fresh reset後 | unit＋全DB integrationは19,912成功・既知stockist_rlsの2失敗だけ、新規失敗なし。G-0基準の清掃は別に12/12成功 |
| 修正round 1、SQL変更後 | 修正round 1後（g4t2b）: controllerのfresh reset・PostgREST anon/authenticated各200、group_g* 50 suite・1,611成功・0失敗・1 pending（G1_CLEANUP_SUITE=1専用清掃の未起動）。unit＋全DB integrationは19,935成功・既知stockist_rlsの2失敗のみ（新規失敗なし）、G-0清掃12/12。実装者の非DB検証はTask 2報告に記録 |

修正round 1はreadsに独立wildcard4ケースとattention false1ケースを追加し、返金の既存期待も強化する。定義数はreads58、G4B assertはソース2＋DB24で不変。定義数は実行した成功数ではない。CSV整形・画面・窓口・E2Eと本番は今回のDB証明範囲に含まない。

### Task 3（読取store・CSV・API・管理履歴・旧集計の移設）

単体はDB/Stripe/Auth管理APIをモックし、純粋な変換は実関数を呼ぶ。既存の`orders-search-route.test.ts`と`OrderSection.actions.test.tsx`の期待は変更しない（この2つは G-4 Task 7 で窓口と部品ごと削除した。下のTask 7）。実PostgRESTは別の層として、使い捨てのlocalhost DBでcontrollerのfresh resetとanon/実authenticatedのsmoke各200の後に流す。型/単体/文書の成功をPostgRESTの実測に代えない。

| ファイル・対象 | 層・事前条件・入力 | FREQ/AC | 期待結果 |
| --- | --- | --- | --- |
| [admin-order-query](../../../tests/unit/lib/orders/admin-orders/admin-order-query.test.ts) | 単体。URLSearchParams、繰返すstatus、attention=1、trim、日付、ORD/UUID/pi、200/201字、page境界、未知名、空のcap頁 | FREQ-536-AC-01・02・03 | 条件と頁へ変換し、未知名/状態/日付/逆転期間/重複する単一項目はok:false。pi_を含め200字は通る。不正なcapは拒否、0行でもcapの旗を保持。12見出しと上限の文は共通定義 |
| [admin-order-csv](../../../tests/unit/lib/orders/admin-orders/admin-order-csv.test.ts) | 単体。引用符/セル内改行、空顧客、交換品、JSTの日境界、式の先頭7種、元からアポストロフィのある文字 | FREQ-536-AC-01、FREQ-538-AC-03・04 | 12列、BOM、全セル引用、引用符二重化、末尾CRLF、ORD番号、JST日時/ファイル名。顧客名/メール/商品名/色/サイズの文字だけを無害化し、数量/金額と既存のアポストロフィは変えない |
| [admin-order-history](../../../tests/unit/lib/orders/admin-orders/admin-order-history.test.ts) | 単体。DBの18列、自動/人、交換、色サイズ、NULL状態、票/発注、入替、34理由と未知値 | FREQ-539-AC-04 | 商品名・理由の言葉・自動判定・actorEmail・ref・swapを共通変換。未知の理由は「システムによる更新」。自動の行はメール解決を呼ばない |
| [admin-order-store](../../../tests/unit/lib/orders/admin-orders/admin-order-store.test.ts) | 単体。Supabase RPCをモック。正常jsonb、件数不一致、不正な状態/数量/金額/cap/詳細、message/SQLSTATEの完全一致と片方だけの一致、301行、同じactor | FREQ-536-AC-03、FREQ-537-AC-05、FREQ-538-AC-02、FREQ-539-AC-04、FREQ-540-AC-13 | 4 RPC名/引数と認可したactor、一覧20行のoffset、固定の400/403/404/422/500、Zodの形/値域検査、生のDB情報とcauseなし。負のrefundNotAttachedを保持。exportの単一jsonbの件数一致。300行までとtruncated、同じ人のメールを1回 |
| [admin-order-summary](../../../tests/unit/lib/orders/admin-orders/admin-order-summary.test.ts) | 単体。旧describe名と期待を引継ぎ、部分発送/配送集計、取消、返金/申請/住所不足、5分キャッシュ、取得失敗の秘密相当sentinel | FREQ-539-AC-01、FREQ-541-AC-05 | 旧summaryの状態/数量/取消/返金の値を直接builderで確認。キャッシュと期限後の再取得。Stripe拒否は新しい固定Errorにtype/codeだけを写して記録し、元の本文/付随データ/causeを出さない |
| [admin-order-actions](../../../tests/unit/lib/orders/admin-orders/admin-order-actions.test.ts) | 単体。4つのnextAction、返金権限、未受取の印、返品/返品できる品の有無 | FREQ-539-AC-02 | 旧OrderSectionのボタン文と有無を維持。サポーターに返金の名前を出さず、受取か返品を選ぶ |
| [item-state-types](../../../tests/unit/lib/orders/item-state/item-state-types.test.ts) | 単体。管理用12状態のキー順、6つの阻害理由 | FREQ-536-AC-01 | ORDER_ITEM_STATUS_ORDERと管理用辞書のキー順が一致し、6理由の日本語が共通値と一致 |
| [order-items-route](../../../tests/unit/api/admin/order-items-route.test.ts) | API単体。認可と既存件数をモック、実query/storeへ正常/不正RPC材料を渡す | FREQ-536-AC-02・03、FREQ-540-AC-13 | 認可→query→store、401/403では読まない。不正queryは400、capの空行も200、要対応の2種件数、認可したactor、no-store、既知DBエラーの固定本文 |
| [order-items-export-route](../../../tests/unit/api/admin/order-items-export-route.test.ts) | API単体。認可/回数制限/監査をモック、実store/CSV。IPまたはactor制限、page、上限/未知エラー、検索語sentinel | FREQ-538-AC-02・05 | 認可→IP→actor（20回/600秒）→検証→全件RPC→CSV→監査。401/403/400/422/429/500、BOM/Content-Type/Content-Disposition/no-store。成功監査は件数とfilter_keysの名前だけ、failure/errorも検索語を含めない |
| [order-detail-route](../../../tests/unit/api/admin/order-detail-route.test.ts) | API単体。core/summary/発送/配送/票をモック、UUID/認可/不在、票/配送だけの拒否/失敗、core/必須発送の失敗、DB側403、複数発送の同じ票と票なし | FREQ-539-AC-01・04、FREQ-540-AC-13 | 認可→UUID→読取、401/403/400/404/500/200とno-store。core/summaryを保持しslipId/slipNumberを含む発送の9欄だけを返す。票の権限不足/失敗はslipsと発送ごとの票の2欄がnull、票なしも2欄null。配送だけの失敗はdeliveredAt:nullで200。core/必須発送の未知失敗は固定500、名前/codeだけのログで秘密値を出さない |
| [order-history-route](../../../tests/unit/api/admin/order-history-route.test.ts) | API単体。既存履歴と新しい品物履歴の成功/失敗 | FREQ-539-AC-04、FREQ-541-AC-05 | itemStatesとtruncatedを追加。品物履歴だけの失敗でも既存欄を返し、空配列/失敗旗/固定の警告だけ。返品の記録と品物履歴が同じactorのcacheを共有し、getUserByIdは1回。客向けの応答/メール処理へ追加しない |
| [旧履歴とメールAPI](../../../tests/unit/api/admin/order-email-routes.test.ts) | 既存の単体回帰。期待は無変更 | FREQ-539-AC-04、FREQ-541-AC-05 | 旧履歴の全欄とエラーログを保つ。旧一覧の窓口とその単体（`orders-search-route`）、旧画面の単体（`OrderSection.actions`）はTask 7で削除した（組立ての期待は [admin-order-summary](../../../tests/unit/lib/orders/admin-orders/admin-order-summary.test.ts) へ、返品ボタンの文の期待は [admin-order-actions](../../../tests/unit/lib/orders/admin-orders/admin-order-actions.test.ts) へ移し済み） |
| [group_g4_postgrest_paths](../../../tests/integration/db/group_g4_postgrest_paths.integration.test.ts) | DB/API結合。DATABASE_URLとLOCAL_SUPABASE_URL / LOCAL_SUPABASE_SERVICE_ROLE_KEY / LOCAL_SUPABASE_ANON_KEY、localhostのみ。実Authユーザー/JWT、固有の注文、別接続から読めるcommit済み材料 | FREQ-536-AC-03、FREQ-540-AC-13 | 実store→supabase-js→PostgREST→SQLの4読取がservice_roleで通り、anon/authenticatedは拒否。作れるFORBIDDEN/ORDER_NOT_FOUND/ARGUMENT_INVALIDを固定分類。limit=101を断り、exportは単一jsonbのrowCount=rows.length。1000行超の材料は作らない。3つのLOCAL_SUPABASEキーがなければDBフック登録前にskip |

| Task 3の記録（2026-10-26） | 実測と境界 |
| --- | --- |
| Phase Aの対象単体 | 新規11 suiteと既存の旧一覧/旧履歴/G-3 storeを含む14 suite・600/600成功。旧一覧は期待無変更で102/102。新summaryの秘密値診断は1失敗/8成功のRED後に修正して成功 |
| Phase Aの広い回帰 | `npx.cmd jest tests/unit/components tests/unit/api/admin --runInBand`: 最終184 suite・6,347/6,347成功。上の600件と重なるので合算しない。TypeScriptと変更TSのESLintも成功。これはPhase Aの測定値で、Phase Bで再実行した値ではない |
| 実PostgREST・DB（g4t3a） | controller受領記録（g4t3a）: fresh reset後、実鍵のgroup_g4_postgrest_pathsを含むgroup_g*全51 suiteで1,616成功・0失敗・1 pending（G1_CLEANUP_SUITE=1で単独実行するG-1清掃の未起動）。 実装者の今回の再実行ではなく、controllerから受領した結果。全件の確認は controller が後で実施 |

### Task 4（割当の入替・書き手76本・並行・末尾assert）

対象はG4C（`20261026101624_group_g4_orders_swap.sql`、35,487 bytes、MD5 `E84E1F7A64AB7A544C66A90D30F572FA`）の入替の書込み1本・候補の読取1本・押さえの道具1本と、書き手の許可一覧76本。DB結合はlocalhostに限り、controllerのfresh resetと既存のPostgREST smokeの後に流す。**fix round 2後の下のDB試験は controller の fresh reset（g4t4b）で実測済み。結果は下の「Task 4の記録」**（表の期待結果は定義であり、定義数は実行した成功数ではない）。各ケースは固有のID/メールとBEGIN→共通advisory→ROLLBACKで隔離し、期待エラーはsavepointで回収する。並行は別接続・commit済みの新しい材料で、待ちを `pg_blocking_pids` と `pg_locks` の未取得の共通advisoryで確かめてから解放する。

| ファイル・対象 | 層・事前条件・入力 | FREQ/AC | 期待結果 |
| --- | --- | --- | --- |
| [group_g4_swap](../../../tests/integration/db/group_g4_swap.integration.test.ts)：書込みの結果 | DB結合。同じ variant の出し手（発送準備中3）と受け手（受注生産中2）。出し手の割当が2行に分かれるケース | FREQ-523-AC-03 | 2点の入替で出し手は発送準備中1・受注生産中2、受け手は発送準備中2。F・A・H・手元の在庫・stock_movements の行数は不変。transfer の対（同じ操作・同数量・互いの相手・reason=allocation_swap）、両注文の品物の状態の履歴、操作の受付の結果が残る。割当が2行なら行ごとに対ができ sequence が 1・2・3・4、受け手の新しい割当は行ごとに別で数量の和が入替の数 |
| 同上：断りの表 | 引数・存在・同じ注文・色サイズ違いと variant なし・未入金/失敗/取消の注文・受け手の手数料待ち/支払額の確認・出し手のキャンセル申し込み/返金処理中/支払額の確認・数量超過。交換行の出し手/受け手それぞれでpending/cancelledの4ケース。出し手自身の同じ明細に返品申請中2点と発送準備中1点があるケース | FREQ-523-AC-02 | 引数の不正は GROUP_G_ARGUMENT_INVALID、理由が空白だけは GROUP_G_SWAP_REASON_REQUIRED、そのほかは GROUP_G_SWAP_* の固定コード。どの断りも割当・イベント・状態の履歴・操作の受付・台帳の行を増やさず内容も変えない。出荷済みの注文の交換の行は受け手にも出し手にもなれ、交換行でもpending/cancelledの注文は GROUP_G_SWAP_ORDER_NOT_PAID / 22023。出し手自身の明細の返品申請中2点はDに入らず候補はD=1/T=2、q=2は書込みなしで QUANTITY_EXCEEDS_DONOR、q=1は成功して返品申請中の2点は変わらない |
| 同上：権限・再送・FIFO・票 | 両権限の組み合わせ、役割なし・期限切れ・無効、anon/authenticated。同じ key の再送、入力・actor の違い。入替の後の入荷。出し手の行を選んだ下書き | FREQ-540-AC-13、FREQ-523-AC-04・03 | orders.allocate と orders.read の両方が要り（サポーターの初期値は GROUP_G_FORBIDDEN、役割に付けると通る）、候補の読取も同じ。再送は replayed:true で何も増えず、key が同じで入力が違えば GROUP_G_REQUEST_KEY_CONFLICT。入荷の FIFO は割当を失った出し手へ渡り受け手の割当は動かない。下書きは入替の後に issues に quantity_exceeds_ready が出て確定は GROUP_G_SLIP_QUANTITY_EXCEEDS_READY |
| 同上：候補の読取 | 同じ variant の52件の出し手（26種類の注文日時、同じ日時は2件ずつ）と、より新しいshipped注文の交換行。除外材料（支払額の確認・1/3点のキャンセル申し込み/返金処理中・未入金・別variant）は全候補より新しい日付。受け手自身のさらに新しい注文にも同じvariantの発送準備中の行。受け手がpending/failed/cancelled、failedではpaid_amount > 0の材料 | FREQ-523-AC-05（候補の読取。入替 dialog・サポーターの入口なしは後続Task） | 他の paid/shipped の注文だけを `order_created_at DESC, donor_order_id, donor_order_item_id` の正確な先頭50行で返し、日時の降順とUUIDの同日時順、除外材料と自分の注文の除外、shipped注文の交換行の採用を確かめる。swappable_quantity と taker_quantity は書込みのD/Tと一致する。明細が無い・指定の注文に属さない場合は GROUP_G_SWAP_ITEM_NOT_FOUND / P0002、その後、受け手の注文がpaid/shipped以外なら書込みと同じ GROUP_G_SWAP_ORDER_NOT_PAID / 22023。受け手のT=0（手数料待ちを含む）なら空。出し手は同じvariantの有効なpaid割当（remaining_quantity > 0）を持つ明細にMATERIALIZEDで先に絞ってから状態を投影し、候補の結果を変えない |
| [group_g4_swap_concurrency](../../../tests/integration/db/group_g4_swap_concurrency.integration.test.ts) | DB結合・別接続、12ケース。commit済みの新しい材料。待ちは `pg_blocking_pids` と `pg_locks` で確認してから解放。発送確定・入荷（FIFO）・返金開始・入金との競合は、入替が先と後の両順序 | FREQ-523-AC-04 | 共通advisoryだけを持つ接続の間、入替は両注文・明細・割当・variantの行lockを持たず（別接続が NOWAIT で取れる）、解放後に保存則を保って完了。同じ出し手を2つの受け手が同時に入れ替えると1つだけ成功し、もう一方は QUANTITY_EXCEEDS_DONOR。注文の組が逆の2つの入替は両方成功。入替が先なら発送確定は GROUP_G_SLIP_QUANTITY_EXCEEDS_READY、消費と発送数量0・手元3。発送確定が先なら入替は GROUP_G_SWAP_QUANTITY_EXCEEDS_DONOR、消費と発送数量3・手元0。入荷が先なら入替は GROUP_G_SWAP_QUANTITY_EXCEEDS_TAKER でFIFOは受け手へ2点、入替が先なら両方成功しFIFOは元の古い出し手へ2点。入荷との両順序ともF/A/H=0/5/0・出し手ready3/受け手ready2。出し手の返金開始・受け手の入金・同じkeyの同時再送でも保存則と最古優先が保たれ、どの組み合わせでも deadlock が0 |
| [group_g4_migration_asserts](../../../tests/integration/db/group_g4_migration_asserts.integration.test.ts)：G4C部分 | ソース2ケース＋DB改ざん。取引内で一覧・関数の ACL・属性・署名・所有者・本体のロック順・表の権限を変更して rollback | FREQ-540-AC-14 | ASCII/LF・BEGIN/NOTIFY/COMMIT各1組・節印・本体外DMLなし・5つの項目名。正常形、DBの一覧そのもの、search_path の違い、無関係な grantee は通る。押さえの道具/入口/候補への不正な EXECUTE、DEFINER/INVOKER/search_path/VOLATILE の変更、入口や本体の削除と置換、同名の別 overload、lock 呼出しを表の参照より後ろへ、押さえの道具の最初の文を変更、一覧の1本外す・1本足す・別の関数に替える・重複、書込み先の表の権限と PG17 の MAINTAIN、一時ロールへの所有者変更を 55000 と orders_swap_functions / lock_order / allowlist / function_set / table_acl の DETAIL で拒否 |
| [group_g1_writer_inventory](../../../tests/integration/db/group_g1_writer_inventory.integration.test.ts)：入替の構造 | DB結合。pg_proc の全関数を走査 | FREQ-523-AC-04、FREQ-540-AC-14 | 一覧が76本（末尾が入替の本体）。入替の本体は private・SECURITY DEFINER・search_path 空・service_role だけが EXECUTE、public 入口は同名 private へ委ねるだけの SQL INVOKER。本体の prosrc で押さえの道具の呼出しが表の最初の参照より前（探索は呼出し名を除いた後に行い空でないことも確かめる）。押さえの道具は最初の文が共通 advisory で誰も EXECUTE できない。入替の4関数だけが service_role から実行できる |
| [group-g-allowlist](../../../tests/integration/db/helpers/group-g-allowlist.ts) と固定の一覧を使う既存のDB試験 | 共有の道具に G4_ALLOWLIST（76本）と CURRENT_ALLOWLIST（今のDBの一覧）を追加。「今のDBの一覧が固定の集合や本数と等しい」生きた検査は CURRENT_ALLOWLIST に向け、G2B（65）・G3C（72）・G3D（75）・G4A（75）の末尾assertの再実行は、流す前に取引内でその時点の一覧へ入れ替える | FREQ-540-AC-14 | G2・G3・G4 の既存のDB試験が76本のDBでも通る。時点の再実行は group_g3_migration_asserts（G3D は75本へ入れ替え）・group_g3_tracking・group_g3_tracking_parent・group_g3_draft・group_g2_migration_asserts・group_g2_purchase_documents・group_g4_foundation・group_g4_migration_asserts（G4A）で保たれる |

**commit 済みの `allocation_swap` の行と理由 CHECK の再現**: 並行試験（`group_g4_swap_concurrency`）は本物の入替を commit するため、その後に G3A の17値の CHECK へ戻す試験（`group_g3_model`・`group_g3_migration_asserts` と G4A の改ざん）が、検証付きの `ADD CONSTRAINT` で「行が違反」と落ちる（controller の g4t4a で29件）。`replaceReasonCheckSql`（`runWithReasonCodes` も同じ）は、呼出し元の取引の中だけで、最初の文が取引の外を断り（`GROUP_G_REASONS_TRANSACTION_REQUIRED`）、遅延の数の確かめを一時に即時にして待ちを流し、追記専用の更新ガード `order_item_allocation_events_no_update` を一時に外して、再現する集合の外の理由を NULL にしてからガードを有効に戻し、CHECK を付け替え（検証あり）、確かめを遅延へ戻す。ガードは assert が流れる前に必ず有効に戻り、行は消さず、取引は呼出し元が rollback するので commit 済みの実データは変わらない。assert は弱めない。

**並行試験の待ちの証明**: 競合は、2つの呼び出しを共通 advisory を持つ門の後ろへ並べ、`pg_blocking_pids` と `pg_locks` の未取得の advisory で両方の待ちを確かめてから門を解放する。先に動いた呼び出しが成功すれば、それを待つ後続の待ちも確かめる。先に動いた呼び出しが拒否で終わった時は、savepoint への rollback でその advisory も戻るため後続の待ちは確かめない。発送確定・入荷（FIFO）・受け手の入金・出し手の返金開始との競合は、入替が先の場合と後の場合を別の試験にして、各順序の正確な結果を確かめる。

| Task 4の記録（2026-10-26） | 実測と境界 |
| --- | --- |
| 実装者のPhase A（DBなし） | `npx.cmd tsc --noEmit --incremental false` 成功、変更したテストと共有の道具のESLint成功、`npx.cmd jest tests/unit/docs --runInBand` 成功 |
| controller fresh reset（g4t4a） | G4C適用。実鍵PostgRESTを含むgroup_g*全53 suiteは1,678成功・30失敗・1 pending（G1_CLEANUP_SUITE=1専用清掃の未起動）。失敗は試験の材料だけ: `group_g3_model`・`group_g3_migration_asserts` の29件（commit済みの `allocation_swap` の行があると17値の理由 CHECK の再現が「行が違反」で落ちる）と、`group_g4_swap_concurrency` の受け手の入金の競合1件（先に動いた入替が未入金で拒否され、savepoint の rollback でその advisory も戻るため、後続の待ちの確認が成り立たなかった）。SQLは変更なし |
| 実装者の修正後、ローカルDB（同じDB、実鍵のLOCAL_SUPABASEなし） | group_g*全53 suite・1,655件のうち1,651成功・0失敗・4 pending（実鍵がなくskipした3つのPostgREST suiteと専用清掃の1）。`group_g4_swap_concurrency` を3回連続で流し10/10・10/10・10/10。`group_g4_swap` ・`group_g4_migration_asserts`・`group_g1_writer_inventory`・`group_g3_model`・`group_g3_migration_asserts` の5 suiteは265/265成功。tsc・`tests/integration/db` と `tests/unit/docs` のESLint・`jest tests/unit/docs`（56/56）成功。本番未適用 |
| fix round 2後、controller fresh reset（g4t4b） | `20261026101624_group_g4_orders_swap.sql`（35,487 bytes、MD5 `E84E1F7A64AB7A544C66A90D30F572FA`）をローカル適用。PostgREST anon/authenticated各HTTP 200。group_g*全53 suiteは1,721成功・0失敗・1 pending（G1_CLEANUP_SUITE=1で単独実行するG-1清掃の未起動）。`group_g4_swap_concurrency` は12/12・12/12・12/12の3回連続成功。本番未適用 |
| fix round 2後、controller全件検証（g4t4b、実鍵あり） | unit＋全DB integrationは20,178成功、失敗は既知の `stockist_rls` 2件だけで新規失敗なし。G-0清掃は別に12/12成功。上のgroup_g*検証と全件検証は範囲を分けた実測。実装者による再実行の件数には数えず、本番適用の証明にも使わない |

### Task 5（入替store・API・client・権限カタログ）

確認日: 2026-10-26。FREQ-523-AC-02/04/05・FREQ-540-AC-06/13。Task 5はSQL変更なし。単体の成功は実DB・PostgREST・E2Eの成功を意味しない。下表のDB実測はcontrollerから受領したfix round 1までの結果で、fix round 2ではDBを再実行していない。

| ファイル | 層・入力 | 期待結果 |
| --- | --- | --- |
| [types](../../../tests/unit/lib/inventory/allocation-swap-types.test.ts) | 単体、独立した13行の表とG4CのRAISEを照合 | SQLSTATE・HTTP・日本語本文、dialogの共通文が固定値と一致。内部エラーは表外 |
| [store](../../../tests/unit/lib/inventory/allocation-swap-store.test.ts) | 単体、RPC境界の戻り値と拒否 | writer7引数・candidates3引数、候補のcamelCase変換、完全一致の分類。部分一致・継承キー・未知・通信切れ・不正な結果は生文なしの500。未知のSQLSTATEは5文字の英大文字/数字だけを非列挙プロパティへ保持し、JSONに出さない |
| [POST](../../../tests/unit/api/admin/allocation-swap-route.test.ts) | 単体、実storeまで呼ぶ | 認可→CSRF→IP→actor→検証→RPC→監査、actorは認可結果だけ。strict本文、理由必須、401/403/400/404/409/429/500、no-store。成功監査はquantity/replayed、失敗は固定codeだけ。未知500の診断は固定error名とSQLSTATEまたはnullだけ、message・理由・detailsを出さない |
| [候補GET](../../../tests/unit/api/admin/allocation-swap-candidates-route.test.ts) | 単体、権限とid/query | 同じ2権限、UUID、余分/重複queryを拒否。200 `{data}`、未払いの受け手は409、品物不在は404。CSRFとIP/actor回数制限を呼ばないことも明示的に検査 |
| [client](../../../tests/unit/lib/inventory/allocation-swap-client.test.ts) | 単体、通信切れ・5xx・不正な成功・業務拒否 | `unknown`を区別し、同じ本文とrequestKeyで再確認できる。権限不足とMFA/CSRFを分ける。候補はno-storeで公開型を検査し、生文を出さない |
| [権限カタログ](../../../tests/unit/lib/auth/role-permission-catalog.test.ts)・[権限画面](../../../tests/unit/components/RolePermissionsSection.test.tsx) | 単体 | upcomingが空、全30行で準備中の印0件。依存・固定・初期値の既存検査を維持 |
| [FR-ADMIN-109](../../../e2e/FR-ADMIN-109-permission-settings.spec.ts) | E2Eの期待値だけ1→0に更新、実行はcontroller Task 10 | upcomingの文の出現0件 |
| [実PostgREST](../../../tests/integration/db/group_g4_postgrest_paths.integration.test.ts) | controller専用。LOCAL_SUPABASE_URL / LOCAL_SUPABASE_SERVICE_ROLE_KEY / LOCAL_SUPABASE_ANON_KEYが必要、未設定はフックを登録せずskip、localhost限定 | 実store→supabase-js→PostgREST→SQL。候補→入替→再送のoperation一致とtransfer2件、全13種類の作れる拒否を固定表へ分類。候補の未払い/所属違い/権限不足、anon/authenticatedは入替と候補を含む6本とも実行不可。controller実測: 初回g4t5aはcleanupのみ失敗。fix round 1後にG-3/G-4両PostgREST suiteで62/62成功、G-4単独再実行も21/21成功。確定した履歴のactorは残し、役割とAuth/アプリのセッションを除去する |

Task 5の実測記録（controller受領。実装者の単体実測と区別する）:

| 実行 | 実測・範囲 |
| --- | --- |
| fresh reset後のg4t5a、実キーあり | `group_g*` 全53 suiteの実行で1,737成功・0失敗・1 pending。ただし52 suite成功で、G-4 PostgRESTは `afterAll` のactor削除によるcleanup失敗でsuiteとして失敗。全suite成功とは扱わない |
| fix round 1後、実キーあり | `group_g4_postgrest_paths` + `group_g3_postgrest_paths` の2 suiteが62/62成功。その後 `group_g4_postgrest_paths` 単独を再実行して21/21成功 |
| controller全件検証g4t5 | 20,300成功、失敗は既知 `stockist_rls` の2件だけ。G-0清掃12/12成功。Playwright・provider・本番動作を検証した数ではない |
| fix round 2、実装者の単体再検証 | Task 5の5 suiteは121/121成功。指定の `tests/unit/lib/inventory tests/unit/api/admin tests/unit/lib/auth tests/unit/components tests/unit/docs --runInBand` は200 suite・6,719/6,719成功、0失敗。tsc・変更5ファイルのESLint成功。DBは再実行していない |

fix round 2では未知500のSQLSTATE保持・非直列化・安全なログをREDからGREENへ直し、候補GETのCSRF/回数制限なしを単体で固定した。既存アサーションは維持する。AC-02に対するTask 5の証拠は固定エラー表と窓口入力・実storeの拒否分類、AC-04は再送と結果不明への対処であり、FIFO・並行・ロック順のDB証拠はTask 4のまま。

### Task 6（注文の詳細頁・操作の移設・履歴の欄・入替dialog）

確認日: 2026-10-26。FREQ-539-AC-01〜05・FREQ-523-AC-05。Task 6はSQL変更なし。下の単体はすべて実装者が実測した結果で、DB・実ブラウザの3幅（390/768/1280px）・E2Eはcontroller担当（未実行）。旧 `admin/page.tsx` の一覧・dialog・handlerと旧wiring試験（`AdminOrderRefundFlow`・`AdminOrderReturnWiring`・`AdminOrderCancelRequestWiring`・`AdminOrderHistoryWiring`）は、Task 6の時点では無変更で残り通っていた。Task 7で削除した。

| ファイル | 層・入力 | FREQ/AC | 期待結果 |
| --- | --- | --- | --- |
| [AdminOrderDetailSection](../../../tests/unit/components/AdminOrderDetailSection.test.tsx)（31件） | 単体。`clientFetch`・`next/navigation`と、返金・支払い済みのキャンセル・返品・申し込みの4つの dialog、入替のclientをモック（取消の dialog は実物）。詳細の返事の旗を1つずつ変える | FREQ-539-AC-01〜05、FREQ-523-AC-05 | 7つのh2が決めた順で、各欄がregion。金額・品物・注文情報が返事のとおり。初期の403・404・失敗の文。サポーター（refund=false）では返金・支払い済みのキャンセル・額を決めて返金するが出ず、受け取る・申し込みは出る。manage=falseでは未入金の取消・確認済み・申し込みが出ない。返金の受付で知らせを出し詳細と履歴を読み直す。取消の見出しは番号だけ（氏名なし）で今の本文のままstatusへ送り「注文を取り消しました。」。品を外した返金・支払い済みのキャンセルは受理後だけ申し込みを解決し、解決だけの失敗は案内、閉じる・結果不明では解決しない。読み直しの失敗で古い詳細を残し「最新の状態を読み込めませんでした。」「この画面の内容は最新ではありません。」を出して成功の知らせを隠し、「読み込み直す」で直る。遅れて返った古い読みが新しい読みを上書きしない。読み直しの先頭で前の誤りの文を消す（解決だけの失敗の案内の後に別の申し込みの結果を読み直すと、案内が消えて成功の知らせだけが残る）。品を外した未入金の取消は、受理後に `{ refundId: null, orderCancelled: true }` で申し込みを解決して `注文を取り消しました。キャンセルの申し込みを解決しました。`。取消の画面は、後続の読み直しが返らなくても送信後に閉じる。確認済みはmanageの時だけPOST reviewして読み直す。支払い・配送の要対応のLinkと空の文。発送票Link・同梱の注意・slips:nullの権限の文・荷作り表はshippingReadの時だけ。`?open=`3種は読込後にdialogを開きqueryを消す。出せない注文・知らない値は何もしない。入替の成功で「割当を入れ替えました。」を出して読み直し、allocate=falseでは入口なし |
| [AdminOrderItemsTable](../../../tests/unit/components/AdminOrderItemsTable.test.tsx)（3件） | 単体。行の状態・補足・canSwapを変える | FREQ-539-AC-01、FREQ-523-AC-05 | 9列の見出し、交換品の印、状態別の金額、補足の言葉、スクロール領域（名前は「ORD-… 明細の表」で欄名と部分一致しない）。受注生産中で補足が在庫の入荷待ちだけの行にだけ、allocateの旗がある時にボタンが出て onSwap に行を渡す。旗が無ければボタンなし |
| [AllocationSwapDialog](../../../tests/unit/components/AllocationSwapDialog.test.tsx)（5件） | 単体。候補・送信のclientをモック | FREQ-523-AC-05 | 候補の読込・選択・数量の既定と上限（受け手と出し手の小さい方）、理由が空だと送らない、本文の形（takerOrderItemId・donorOrderItemId・quantity・trim済みの理由・requestKey）、二重押下で通信1回、結果不明で入力を止め「もう一度確かめる」が同じ本文を再送、DBの断りの本文を入力を残して出し新しい要求番号で送り直す、成功で onSwapped、候補の空と失敗の文 |
| [OrderHistoryPanel](../../../tests/unit/components/OrderHistoryPanel.test.tsx)（135件。うち5件が新規、130件は無変更） | 単体。`OrderHistoryPanel` を描画し、履歴の返事に itemStates を足す | FREQ-539-AC-04 | 品物の状態の変化の行（変更前後・nullは「（なし）」・理由の言葉・人または自動・人の変更でメールが分からない時は「自動」でなく「不明な管理者」・発送票/発注のLink・入替の相手と理由）、省略・空・失敗の文、dialog と「閉じる」を使わないこと、メールの再送の確認と送信が従来どおり。従来のdialogの試験は期待を変えず通る |
| [admin-order-client](../../../tests/unit/lib/orders/admin-orders/admin-order-client.test.ts)（12件） | 単体。`clientFetch`をモック | FREQ-539-AC-01・03 | `fetchAdminOrderDetail` が no-store で読み、403・404・その他を分け、通信・JSONの失敗は固定のerror。`readSafeOrderActionError` は400・409の短い日本語だけを通し、それ以外・英語・長すぎる・制御文字つきは既定の文 |

Task 6の実測記録（実装者。2026-10-26）:

| 実行 | 実測・範囲 |
| --- | --- |
| 上の5 suite | `npx.cmd jest tests/unit/components/AdminOrderDetailSection.test.tsx tests/unit/components/AdminOrderItemsTable.test.tsx tests/unit/components/AllocationSwapDialog.test.tsx tests/unit/components/OrderHistoryPanel.test.tsx tests/unit/lib/orders/admin-orders/admin-order-client.test.ts --runInBand`: 5 suite・186/186成功（レビュー指摘の修正後） |
| 広い単体 | `npx.cmd jest tests/unit/components tests/unit/lib/orders tests/unit/api/admin tests/unit/docs --runInBand`: 280 suite・10,383/10,383成功（旧wiring試験・要対応の窓口の試験・文書の試験を含み無変更で通る） |
| 型・lint・文書 | `npx.cmd tsc --noEmit --incremental false` 成功。変更したファイルの `npx.cmd eslint` はエラー・警告0（修正前の全体の `npm.cmd run lint` はエラー0、既存の警告102件、Task 6のファイルの警告なし）。`npm.cmd run validate-docs` は既知の2件（2026-10-07の計画書の壊れたリンク）だけ |
| レビュー指摘の修正（Opus、2026-10-26） | 読み直しの先頭で頁の誤りの文を消す（試験追加）、取消の送信後は解決・読み直しを待たず閉じる（試験追加）、品を外す未入金の取消の解決の試験、メールが分からない人の変更を「不明な管理者」と出す試験、`REVIEW_REASON_LABELS` を `order-payment-types.ts` へ一本化（要対応の窓口は同じ辞書を使い挙動は同じ）。旧頁との意図した違い（`readSafeOrderActionError` が短い日本語だけ）は `16_admin.md`・SQ-ADMIN-15 に記録 |

### Task 7（注文一覧表の頁・ORDER タブの入口化・要対応の欄の移設・旧い一覧の撤去）

確認日: 2026-10-26。FREQ-536-AC-01〜04・FREQ-538-AC-01・05・FREQ-539-AC-05・FREQ-540-AC-15。Task 7はSQL変更なし。下の単体はすべて実装者が実測した結果で、DB・実ブラウザの3幅（390/768/1280px）・E2E・`npm run build` はcontroller担当（未実行）。旧い一覧の窓口 `GET /api/admin/orders`・`OrderSection`・旧wiring試験4本・`orders-search-route`・`OrderSection.actions` は削除した。

| ファイル | 層・入力 | FREQ/AC | 期待結果 |
| --- | --- | --- | --- |
| [AdminOrderItemTable](../../../tests/unit/components/AdminOrderItemTable.test.tsx)（7件） | 単体。行の fixture を変える（`next/link` は移動しない代役） | FREQ-536-AC-01・04 | 12列の見出しが決めた順でスクロール領域に入り見出しが sticky。注文の共通欄が全行に出て、交換の行に（交換品）の印、金額は ¥12,800 の形、日付は日本時間、顧客名が空なら「ゲスト」・メールが空なら「-」、要対応の注文にだけ印。同じ明細の別ステータスの行で key の警告が出ない。注文IDは Link、行は tabIndex と aria-label。行の押下と Enter/Space で onOpen(注文ID)、Link・ボタン・入力の上の押下と Link の上の Enter では呼ばない |
| [AdminOrderItemListSection](../../../tests/unit/components/AdminOrderItemListSection.test.tsx)（50件） | 単体。`clientFetch`・`next/navigation`・ログイン文脈を差し替え、表・要対応の欄・hook は本物 | FREQ-536-AC-01〜04、FREQ-538-AC-01・05、FREQ-539-AC-05 | 見出し・説明・読み込み中・空・403/422/その他の失敗。初めて開いた時は全期間（dateFrom が付かない）、「絞り込む」まで読み直さず問合せに値が載る（status の繰り返し・attention=1・日付・語・pi_… は orderNumber）、URL に載らない、日付が逆なら読まない、条件をクリア。cap-note（5,000 / ordersCap=2 / 0行でも / 頁送りで残る / 上限に達していなければ無い）、20行と頁送り、頁を送る読み直しの間も前の頁の表・件数・注記・頁送りを外さず aria-busy で出し、押した「次の頁」のフォーカスが残り、答えで置き換え、失敗なら失敗の文に置き換える、読みの重なり（古い答えが新しい答えを上書きしない・読み込み中の表示を消さない）。sessionStorage への保存・復元・壊れた値の破棄・投げても動く。CSV は頁を含まない同じ条件で export を呼び、返った Blob をファイル名つきでダウンロード、422 の本文・429 の「しばらくしてから、もう一度お試しください。」・失敗の文・作成中の無効化。要対応の欄・メール停止の帯・「もう一度返金する」の移動先（?open=refund・?open=returns・#order-history）・サポーターの出し分け・操作の成功で欄と一覧を読み直す・断りの文・要対応の一行（0件を出さず、押すと状態1つに絞り込み、もう一度で外す）。act の警告が出ない |
| [useOrderAttention](../../../tests/unit/hooks/useOrderAttention.test.tsx)（23件） | 単体。`renderHook`・`clientFetch` を差し替え | FREQ-539-AC-05 | enabled の時だけ読む・読めない時の文。確認済み・解決・取消して解決・配送の対応済みの本文と知らせ、成功で欄と onChanged を読み直す、操作中の id、返事の間に onChanged が替わっても最新を呼ぶ、403/503/400/404/500/通信切れ/配送の404・409・429 の文、次の操作で前の文を消す |
| [old-order-entries-removed](../../../tests/unit/lib/orders/admin-orders/old-order-entries-removed.test.ts)（9件） | 単体。`src` を走査 | FREQ-540-AC-15 | `OrderSection`・`handleExportOrdersCsv`・`ORDER_CSV_HEADERS`・`formatOrderItems`・`/api/admin/orders?`・`ORDER_STATUS_FILTERS`・`RETURN_FILTER_OPTIONS` が0件。旧い一覧の部品と窓口のファイルが無く、詳細・新一覧の窓口は残る |
| [admin-order-query](../../../tests/unit/lib/orders/admin-orders/admin-order-query.test.ts)（31件。うち2件が新規） | 単体 | FREQ-536-AC-02 | `toSearchParams` が絞り込みを問合せにして `parseOrderItemQuery` で元に戻り、空の値・偽の旗・頁なしを載せない（空の dateFrom は載らない） |
| [AdminGroupG1LegacyStop](../../../tests/unit/components/AdminGroupG1LegacyStop.test.tsx)（13件）・[AdminSettingsMenu](../../../tests/unit/components/AdminSettingsMenu.test.tsx)（21件）・[AdminOrderSearch](../../../tests/unit/components/AdminOrderSearch.test.tsx)（2件） | 単体。本物の管理頁・サイドナビ。窓口と他のタブの部品を差し替え | FREQ-539-AC-05、FREQ-536-AC-02 | ORDER タブは店長にもサポーターにも「注文メニュー」の「注文一覧表」リンクだけで、旧い一覧・停止の文・荷作り表への案内・履歴/返金などのボタン・旧CSV・旧い絞り込み・dialog が無く、旧い一覧の窓口を呼ばない。サイドナビのバッジと KPI の「（ORDER で確認）」の帯（配送を含む）は残り、タブを移るたびに要対応の件数を読み直す（AdminSettingsMenu）。絞り込みの付け替え: 顧客名・メール・注文ID（pi_…）・期間が order-items の窓口へ送られ、旧い取引先・金額の欄は無い |
| [admin-order-summary](../../../tests/unit/lib/orders/admin-orders/admin-order-summary.test.ts)（16件。うち6件が移設） | 単体 | FREQ-539-AC-01 | 旧 `order-delivery-routes` の一覧の窓口の期待を builder の直接呼出しへ移した。G-4 の最終レビューで一覧の印（deliveryAttention）を要約から外したので、6件は「配送の要約は進み具合のために1回読み、要対応の印は要約に載せない（集計の優先結果6通り）」を確かめる |
| [order-delivery-routes](../../../tests/unit/api/admin/order-delivery-routes.test.ts)（52件） | 単体 | FREQ-541 | 旧い一覧の窓口の期待を移して外し、一覧のための依存の差し替えを整理した。tracking・delivered・resolve の期待は無変更 |
| [order-status-traceability](../../../tests/unit/docs/order-status-traceability.test.ts)・[delivery-status-traceability](../../../tests/unit/docs/delivery-status-traceability.test.ts)（2 suite・56件） | 文書の単体 | FREQ-540-AC-15 | 旧い一覧の窓口の削除に合わせ、route の総数を160ファイル・203メソッド、所在表を159行・202メソッドに更新。FREQ-540 の AC 一覧に AC-15 を足した |
| [AttentionInbox](../../../tests/unit/components/AttentionInbox.test.tsx)（57件） | 単体。変更なし | FREQ-539-AC-05 | 欄の部品そのものは無変更で通る |

Task 7の実測記録（実装者。2026-10-26）:

| 実行 | 実測・範囲 |
| --- | --- |
| 対象の単体 | 上の表の suite を個別に実行。AdminOrderItemTable 7、AdminOrderItemListSection 50、useOrderAttention 23、old-order-entries-removed 9、admin-order-query 31、AdminGroupG1LegacyStop 13、AdminSettingsMenu 21、AdminOrderSearch 2、admin-order-summary 16、order-delivery-routes 52、AttentionInbox 57、docs 2 suite 56。すべて成功 |
| 広い単体 | `npx.cmd jest tests/unit --runInBand`: 603 suite中600 suiteが成功・3 suiteは既存のskip、16,050件成功・8件skip・失敗0（約317秒）。 |
| 型・lint・文書 | `npx.cmd tsc --noEmit --incremental false` 成功（削除した窓口の `.next/types` は `next typegen` で作り直した）。`npm.cmd run lint` はエラー0・警告102件（既存。Task 7のファイルの警告なし）。`npm.cmd run validate-docs` は既存のCheckout計画の相対リンク切れ2件だけ |
| 未実行 | `npm run build`・Playwright・DB・390/768/1280pxの実ブラウザ確認（controller担当） |

### Task 8（入口の整理: 荷作り表・発送票から詳細へ、旧い履歴 dialog と旧い 410 の窓口の撤去）

確認日: 2026-10-27。FREQ-539-AC-05・FREQ-540-AC-15。Task 8はSQL変更なし。下の単体はすべて実装者が実測した結果で、DB（旧い関数の拒否の `group_g1_legacy_disabled`）・実ブラウザの3幅（390/768/1280px）・E2E・`npm run build` はcontroller担当（未実行）。旧い発送・仕上がりの窓口6ファイル・7メソッドと、その単体2本（`order-completion-routes`・`order-fulfillment-routes`）は削除した。`order-delivery-routes` は配送の要対応の解決（resolve）の唯一の単体なので、410 の期待（tracking・delivered）だけを外して残した。

| ファイル | 層・入力 | FREQ/AC | 期待結果 |
| --- | --- | --- | --- |
| [PackingSection](../../../tests/unit/components/PackingSection.test.tsx)（48件。履歴 dialog を開く試験1件を Link の試験2件に置き換えた） | 単体。`clientFetch`・`next/navigation` を差し替え（履歴の部品の差し替えは不要になった） | FREQ-539-AC-05 | 注文IDは `/admin/orders/{orderId}` への Link（文字は注文番号）で、押しても dialog は開かず、旧い「ORD-… の履歴を開く」のボタンが無い。行ごとに自分の注文の詳細へ向く |
| [ShipmentSlipSection](../../../tests/unit/components/ShipmentSlipSection.test.tsx)（68件。うち2件が新規） | 単体。`clientFetch` を差し替え | FREQ-539-AC-05 | 確定済みの票の同梱する品物の表と「注文ごとの発送」、下書きの票の同梱する品物・追加の候補・発送票の確認の見出しの注文番号が、その行の注文の詳細への Link。票の操作（配達済みにする・伝票番号を直す・発送を取り消す）のボタンは変わらず、押すと dialog が開き窓口は呼ばない。`注文 ORD-… 発送（1回目） …` の文字の並びは今までと同じ |
| [OrderHistoryPanel](../../../tests/unit/components/OrderHistoryPanel.test.tsx)（134件。`OrderHistoryDialog.test.tsx` を改名） | 単体。`OrderHistoryPanel` を描画し、履歴の窓口を差し替え | FREQ-539-AC-04・05 | 従来の履歴の試験（履歴の並び・メールの中身・再送・結果の知らせ・遅れて届いた返事・発送・返金・返品・申し込み・配送の表示）が改名後も、region「変更履歴」を対象にして通る。dialog だけの3件（Escape で閉じる・閉じた後のフォーカス・閉じて開き直す）を外し、注文が変わると前の画面を引き継がず読み直す試験と、改名後も通る試験（旧い部品のファイルが無い）を足した。最初の画面ではフォーカスを動かさず、画面を切り替えるとパネル自身にフォーカスが移る |
| [legacy-fulfillment-routes-removed](../../../tests/unit/api/admin/legacy-fulfillment-routes-removed.test.ts)（11件） | 単体。`src` を走査 | FREQ-540-AC-15 | 旧い窓口の6ファイル（と `completions`・`fulfillments` の階層）が存在せず、残る窓口は消えていない。`src` に `…/completions`・`…/fulfillments` の URL、旧クライアントの名前6つ（`callFulfillmentApi` など）が0件。旧い停止文と 410 の本文の組立ては定義の1ファイル（`legacy-fulfillment-disabled.ts`）の中だけ。`legacy-fulfillment-disabled` を import するのは `fulfillment-materials.ts` と `fulfillment-store.ts` だけ（明示の許可）。e2e と tests への広げ方は Task 12 |
| [order-delivery-routes](../../../tests/unit/api/admin/order-delivery-routes.test.ts)（24件。52件から tracking・delivered の 410 の期待を外した） | 単体 | FREQ-541 | 配送の要対応の解決（resolve）の窓口の期待は無変更で、権限→CSRF→IP→管理者の順・守りの拒否・厳しい本文・DBの断りの言葉・想定外500・メールだけの予定を確かめる |
| [AdminGroupG1LegacyStop](../../../tests/unit/components/AdminGroupG1LegacyStop.test.tsx)（13件） | 単体 | FREQ-524-AC-03・FREQ-533-AC-01 | 履歴の部品の改名に合わせて `OrderHistoryPanel` と region「変更履歴」へ付け替え（期待は無変更） |
| [order-status-traceability](../../../tests/unit/docs/order-status-traceability.test.ts)・[delivery-status-traceability](../../../tests/unit/docs/delivery-status-traceability.test.ts)（2 suite・56件） | 文書の単体 | FREQ-540-AC-15 | route の総数を154ファイル・196メソッド、所在表を153行・195メソッドに更新。旧い7メソッドは E-4 の撤去の注記（G-4 Task 8）と、表に行が無く route ファイルも無いことを確かめる |

Task 8の実測記録（実装者。2026-10-27）:

| 実行 | 実測・範囲 |
| --- | --- |
| 対象の単体 | 上の表の suite を実行。PackingSection 48、ShipmentSlipSection 68、OrderHistoryPanel 134、legacy-fulfillment-routes-removed 11、order-delivery-routes 24、AdminGroupG1LegacyStop 13、docs 2 suite 56。すべて成功 |
| 広い単体 | `npx.cmd jest tests/unit --runInBand`: 603 suite中600 suiteが成功・3 suiteは既存のskip、16,013件成功・8件skip・失敗0 |
| 型・lint・文書 | `npx.cmd tsc --noEmit --incremental false` 成功（削除した窓口の `.next/types` は `next typegen` で作り直した）。`npm.cmd run lint` はエラー0・警告102件（既存。Task 8のファイルの警告なし）。`npm.cmd run validate-docs` は既存のCheckout計画の相対リンク切れ2件だけ |
| 未実行 | `npm run build`・Playwright・DB（`group_g1_legacy_disabled` を含む）・390/768/1280pxの実ブラウザ確認（controller担当）。e2e に残る旧い 410 の mock・期待（`FR-ADMIN-069`・`070`・`117`・`123`・`delivery-tracking-test-utils`）は窓口が無いので 404 になる。Task 10・12 が付け替えた（Task 10: 117・123・delivery-tracking-test-utils、Task 12: 069・070 と旧い一覧の道具） |

### Task 9（E2E: 注文一覧表・品物のステータス・全件CSVと、その道具）

確認日: 2026-10-27。FREQ-520-AC-03・FREQ-536（AC-01〜05）・FREQ-537（AC-01・03・04）・FREQ-538（AC-01〜05）・FREQ-541-AC-05。Task 9はSQL・製品コードの変更なし。ここに書くE2Eはcontrollerが本番ビルド（`next build && next start`）で手元のSupabaseに対して流した（実測は下の「Task 9の実測記録」。実装者は型・lintと文書の単体まで）。画面 → 窓口の差し替え（bridge。[order-admin-test-utils](../../../e2e/order-admin-test-utils.ts)）→ 手元のDBの公開関数（`list_admin_order_item_rows`・`export_admin_order_item_rows`）の道で確かめ、bridgeは権限を決めず実行者を `_actor_id` で渡すだけ（許否はDBの関数が決める）。窓口と同じ純粋な関数・表（`parseOrderItemQuery`・`toFilterPayload`・`parseOrderItemListResult`・`buildOrderItemCsv`・`orderItemCsvFilename`・`ADMIN_ORDER_ERRORS`）をimportして使い、写していない。窓口の認可・MFA・回数の制限・監査は、本物の窓口の401/403（FR-ADMIN-123のG-4の節。Task 10）と各routeの単体が確かめる。各specは390/768/1280pxの3幅で流し、頁全体が横にはみ出さないことを確かめる。材料の注文は試験ごとに新しい商品・固有のメールアドレスで作り、画面の絞り込みもDBの期待もそのメールアドレスで読む（全体の件数は使わない）。並びと全行はDBの関数の1回の呼出し（`readExportSnapshot`。同一時点）で確かめ、頁を歩かない。

| ファイル | 層・入力 | FREQ/AC | 期待結果 |
| --- | --- | --- | --- |
| [FR-ADMIN-110](../../../e2e/FR-ADMIN-110-item-statuses.spec.ts)①〜⑥（6ケース×3幅） | E2E（3幅）。bridge。材料は `createOrderRowsMaterial`・`createReturnStatesMaterial`（return-test-utils の道具と本物の入口。⑤⑥は `withOrderAdminScenario(…, { returnSettings: true })` で鍵 14314,2 → 190520,0 の順）・`createCancelRequestMaterial`（キャンセルの申し込みは DB 材料の `insertCancelRequest` で直に書く） | FREQ-520-AC-03、FREQ-536-AC-02・03、FREQ-541-AC-05 | ①ステータスの絞り込みに12の状態が決めた順と管理の言葉で並び、複数選べてキーボードで押せる。②5点の明細に割当3・うち1点を発送すると、状態ごとの別の行（受注生産中2・発送準備中2・発送済み1）で和が5。③支払い手続き中と放棄の注文は、未解決の要対応があっても一覧にも「要対応のみ」にも出ない。④色・サイズ未確定（variant_id が NULL）の入金済みの明細は受注生産中のままで、発送準備中の行に出ない。⑤10点を送った注文の返品の途中（返品申請中1・返品受付中2・返金待ち3・返品済み1）が数量の行として出て残り3が発送済み、和が10。返品は createShippedOrder・お客様の申し込み（customer_request_return）・createReturnInDb・receiveReturnInDb・recordRefundResult で作る。キャンセルの申し込みのある注文は申請中1と発送準備中2。⑥お客様の注文状況の頁（本物の窓口・画面）に、お客様の言葉〔返品の受付済み・お申し込み中・ご返金の準備中・返品済み／キャンセルのお申し込み中／決済失敗〕が出て、管理の言葉〔返品受付中・キャンセル申請中・支払い期限切れ〕が出ない |
| [FR-ADMIN-121](../../../e2e/FR-ADMIN-121-order-item-list-export.spec.ts)①〜⑬（13ケース×3幅） | E2E（3幅）。bridge。材料は `createOrderRowsMaterial` ほか（25行・3注文、交換の行は `createExchangeFeeMaterial`） | FREQ-536（AC-01〜05）、FREQ-537（AC-01・03・04）、FREQ-538（AC-01〜05） | ①12列の見出しの順。②12のセルが DB の1回の読みと同じ（日本時間の注文日・顧客名・メール・交換の行の（交換品）・¥0・¥12,800）。③3点100円が33・33・34（和100）、返金は返金した明細の行だけ。④日付〔日本時間の境目〕・注文ID〔ORD- の有無・大文字小文字・決済ID pi_… の前方一致〕・顧客名・メール・商品名・色・サイズ・ステータス〔複数〕・要対応のみ・条件をクリア。⑤25行で20行+5行・総行数と注文数が頁に依らない・前へ次へ。⑥Tab で行に着き Enter で詳細へ、注文IDのリンクで1回だけ移る。⑦CSV が25行全部・BOM・12列・CRLF・式の無害化・引用符と改行。⑧サポーター〔初期値〕は使え、orders.read を持たない実行者は権限の文だけ。⑨書き出しの上限〔2〕で断りの文・ダウンロードなし・設定が接続に残らない。⑩見出しを保つスクロール領域。⑪詳細から戻ると条件と頁が戻る（URL に載らない）。⑫全期間から始まる・120日前/400日前も出る。⑬一覧の注文の上限〔2〕の注記と、日付で絞ると消えること、CSV は4注文全部、戻すと注記なし |
| [order-admin-test-utils](../../../e2e/order-admin-test-utils.ts)（道具） | E2E の道具。型・lintのみ | FREQ-536・538 | `withOrderAdminScenario`（権限の鍵 190520,0 を共有で持つ。`returnSettings` を付けると、別の接続で先に返品の設定の鍵 14314,2 を取る。上限の設定は終わりに必ず戻す）、`mockOrderAdminBridge`（一覧・CSV の窓口を DB の公開関数へ）、`createOrderRowsMaterial`（複数明細・明細ごとの商品 `catalog`・割当・一部発送・配達済み・色サイズ未確定・状態・注文日・顧客名・メール。同じ商品の別の明細に待ちがあると、返金で戻った在庫を本物の入口の FIFO が待ちへ割り当てるので、待ちのある明細と返金する明細は別の商品にする）、`refundLineInDb`・`openPaymentExceptionInDb`・`createReturnStatesMaterial`・`createCancelRequestMaterial`、`readExportSnapshot`（1回の呼出し）、`setListCapInDb`/`resetListCapInDb`（接続だけの `set_config(…, false)`）、`setExportCapInDb`（bridge の書き出しだけに取引の中の `set_config(…, true)`）、画面の読み方（`openOrderList`・`applyFilters`・`listRowsOf`・`columnHeadersOf`・`downloadCsv`・`parseCsv`）。作らなかった道具: `clearVariantInDb`（order_items の更新は法定の不変の守りが止める。色サイズ未確定は明細の `variantMissing` で作る時に決める）と `setPaymentIntentInDb`（決済IDは注文の `paymentIntentId` で作る時に決める） |
| [order-fulfillment-test-utils](../../../e2e/order-fulfillment-test-utils.ts)（詳細の道具） | E2E の道具。型・lintのみ | FREQ-539・541 | `adminOrderDetail`（旧い `adminOrder` の1件を summary にし、order・amounts・rows・attention・permissions〔店長の旗が既定〕・fulfillments・slips を足した `AdminOrderDetail`）、`mockOrderDetail`（詳細と空の履歴の窓口。読んだ URL を記録）、`openOrderDetail`、`detailSection`。121 ⑥⑪ が行から詳細への移動に使い、Task 10 の 112 と Task 11 の 122 が使う。`mockOrderList`・`openOrderTab` は Task 12 の最後まで残す |
| [FR-ADMIN-116](../../../e2e/FR-ADMIN-116-packing-shipment-slips.spec.ts)①③⑩（付け替え） | E2E（3幅）。ケースの題は変えない | FREQ-531-AC-01、FREQ-539-AC-05 | 荷作り表の注文IDのセルは、注文番号の文字を持つ Link で、行き先は `/admin/orders/{id}`（①）。キーボードで Link にフォーカスしても遷移せず、選択と送る数が消えない。別の頁では Link にフォーカスして Enter を押すと詳細の頁へ移る（⑩。旧い履歴 dialog の開閉は無くなった）。③「部分発送 → 残りを別の票で送る」の最後の待ちは、荷作り表の領域か「発送準備中の品物はありません。」のどちらかが出れば読み込み済みとする（reset 直後で他の試験の準備中の行が1つも無いと、荷作り表は領域でなく空の文になる。r1 の失敗の直し。「どこにも出ない」の確かめは一時点の DB の読み `readPackingSnapshot` のまま） |

Task 9の実測記録（実装者。2026-10-27）:

| 実行 | 実測・範囲 |
| --- | --- |
| 型・lint・文書 | `npx.cmd tsc --noEmit --incremental false` 成功。`npx.cmd eslint` は変更したe2e 5ファイルで0件（エラー0・警告0）。`npx.cmd jest tests/unit/e2e tests/unit/docs --runInBand` は4 suite・72件成功。`npm.cmd run validate-docs` は既知のCheckout計画（`docs/superpowers/plans/2026-10-07-checkout-place-order-payment.md`）の相対リンク切れ2件だけ（今回の追加リンクの新規エラー0） |
| controller の E2E（本番ビルド・手元の Supabase・chromium） | r1（reset 直後・`--workers=1`・110/121/116）: 115 通過・6 失敗。失敗は試験側の2つ: 116 ③ ×3幅（他に準備中の行が無く荷作り表が空の文になり、領域を待つ所で止まった。待ちを領域か空の文のどちらかに直した）、121 ③ ×3幅（同じ商品の別の明細の返金で戻った在庫を FIFO が待ちへ割り当て、受注生産中が発送準備中に変わった。明細ごとの商品 `catalog` に分けた）。r2（116+121・1 worker）: 103 通過・0 失敗。r3・r4（110+121+116・既定の4 workers）: 各 121 通過・0 失敗（isolated-global 28件を含む）。製品コードの変更なし |
| Opus レビューの直しの後 | 110 ⑤の返品の材料を return-test-utils の道具と本物の入口へ付け替え（鍵 14314,2 → 190520,0）、110 ⑥にお客様の言葉の確かめを追加、121 ⑥（詳細の読みの数・history.length）・⑦（ファイル名の日付）・⑪（sessionStorage の鍵）の確かめを強化、116 ⑩に Enter で詳細へ移る確かめを追加。controller の再実行: r5（1 worker）・r6・r7（4 workers）は各 118 通過・3 失敗で、失敗は 121 ⑥ ×3幅の `history.length` の増え方だけ（「戻る」の後に押した移動は進む側の履歴の項目を捨てるので、増えずに 0 になる。試験の測り方の誤りで、製品の誤りではない）。110 ⑤⑥（返品の本物の入口）・116 ⑩・121 ⑦⑪ は通過。121 ⑥ は、リンクを押す測りを「戻る」の前へ移して `history.length` を厳密にし（pushState・履歴の項目・詳細の窓口の読みがちょうど1つ増え、一覧の窓口は読み直されない）、Tab → Enter の確かめを戻った後に回した。直した後の controller の再実行: r8（121 だけ・1 worker）は 73 通過・0 失敗、r9・r10（110+121+116・既定の4 workers）は各 121 通過・0 失敗。型・lint・文書は上のとおり再確認 |
| 未実行 | 390/768/1280pxの実ブラウザの目視確認（controller 担当） |

### Task 10（E2E: 割当の入替・注文の権限と旧経路の撤去）

確認日: 2026-10-27。FREQ-523-AC-01〜05・FREQ-540-AC-05・AC-13・AC-15。新caseの題はTask 10 briefの指定どおり。112は8case×390/768/1280px、123のG-4は①②⑤が幅によらないHTTP（⑤はcontroller了承済み）、③④⑥は3幅。controllerの本番build・local Supabase・1 workerでの実測を受領: 初回112はlabelの完全一致locatorで失敗。controllerがdonorSelect/quantityBox/reasonBox（役割＋名前の完全一致）へ修正後、112は通過、123/109はG-2の在庫読取の遅延（4,336 variants・5.6秒、expectの上限5秒）を除き通過との連絡。総件数は未提示で推定しない。G-2のcaseは変更せずcontrollerがDBをresetする。**fix round 1の修正後のPlaywright・DB実測はcontroller待ち**。実装者は実行していない。既存Task 9の通過数を今回の証拠にしない。

| 試験 | 期待と確認する境界 |
| --- | --- |
| [FR-ADMIN-112](../../../e2e/FR-ADMIN-112-allocation-swap.spec.ts)① | 候補の注文・数量・理由で入替。双方の状態と数量を全区間の順序付き完全一致で確認し、画面の受け手に受注生産中の行が残らない。DBのA/F/H/手元/台帳の不変、transfer2件・操作1件。 |
| 同② | 空白の理由は送信されず固定の断り。200字のmaxlengthと201文字入力時の200文字への制限、DB不変。 |
| 同③ | 同注文・別variant・未入金・取消申請・返金処理中が候補に無い（候補1回の集合）、手数料待ち/支払額確認はボタン無し、出荷済み注文の在庫待ち交換品は入替可。競合で候補が減った後は固定409の文で拒否され、DB写し不変。 |
| 同④ | 両注文の変更履歴の「品物の状態の変化」に割当の入替・状態の前後・2点・相手注文番号のLink・理由。 |
| 同⑤ | 入替後の発送準備中2点の描画を待ってから同variantを入荷（bridgeの詳細読取を入荷取引へ混ぜない）。元の日付で最古の出し手へFIFOし、中間日付の待ちは残る。3注文の全区間を順序付き完全一致で確認。受け手の割当ID/残数/版と元の注文日は不変。 |
| 同⑥ | 初回をDB保存後に通信切断。二重押下は1POST。入力が止まり、明示の再確認は同じ本文/要求番号・replayed、操作/transfer/履歴/在庫のDB写しが増えない。 |
| 同⑦ | 初期サポーターに入口なし、直接POSTもDBが403。店長の権限画面でallocateを付けると候補dialogが開き、外すと入口が消えて直接POSTも拒否。withShippingScenarioのchangesPermissions:trueからwithPermissionScenarioで差分復元し、既存closeTrackedで後始末。 |
| 同⑧ | 390pxではdialogが画面いっぱい・右上×。3幅で閉じた後のフォーカス復帰と頁全体の横はみ出し無し。 |
| [FR-ADMIN-123](../../../e2e/FR-ADMIN-123-group-g-permissions.spec.ts) G-4①② | 差し替えの無い新5メソッドが未ログイン401、実際のお客様ログイン403（権限の本文でCSRF/Originと区別）。認可/MFAはbridgeの下では検証しない。 |
| 同G-4③④ | 両caseの時間制限は240秒（共有/排他の権限ロック待ちを含む）。初期サポーターは一覧/詳細/CSV可・入替ボタン無し・POST/候補GETはDBが403で不変。readを権限画面で外すと一覧は権限の文で表なし、CSVは403でダウンロード無し、詳細GETも拒否。戻すと一覧/CSVが復帰。④はwithShippingScenarioのchangesPermissions:trueからwithPermissionScenarioで差分復元し、既存closeTrackedで後始末。 |
| 同G-4⑤⑥ | GET旧一覧＋旧6ファイル7メソッドは本物のHTTP404。DB旧4関数の拒否は [group_g1_legacy_disabled](../../../tests/integration/db/group_g1_legacy_disabled.integration.test.ts)。店長/サポーターのORDERは一覧へのLinkだけで旧一覧/dialog/CSV/停止文なし、旧HTTPを呼ばない。 |
| [order-admin-test-utils](../../../e2e/order-admin-test-utils.ts) | mockOrderDetailBridgeは詳細/履歴/候補/入替を公開DB関数へ、権限はDBが判定。summary/発送/票は固定の写し。詳細coreは非公開detailSchemaと同じ検査を公開済みの純粋な部品から構成し、不正な状態/順位/阻害理由などは固定500。候補のqueryはUUIDのorderItemIdが1つだけで、欠落/不正/重複/余計なkeyはDBを呼ばず400 GROUP_G_ARGUMENT_INVALID。履歴はmapItemStateHistoryRows（読取失敗は実routeの200/itemStatesFailed:trueと異なりbridgeは500、依存caseなし）。拒否はimportしたADMIN_ORDER_ERRORS/ALLOCATION_SWAP_ERRORSとSQLSTATEの完全一致。createSwapMaterial(client,input)は固有メールの2注文（通常場面のcontextは接続から取得、権限変更時は既存shippingのcontextを明示）、交換/手数料待ち等を作る。swapInDbは実writer、readSwapSnapshotは1SQLの同一時点・対象ID/variantだけ。独自のcloseOrderRowsInDbは削除し既存の後始末へ統一。 |
| 旧caseの処置 | 123の旧401/403/410を404へ統合、G-1の両役割の一覧/履歴をORDER入口と詳細の履歴へ、G-3の旧4POSTと117⑦をmock無し404へ。delivery-tracking-test-utilsの旧tracking/delivered固定410と不要importを削除。fix round 1で読取/書込先の無いtrackingPosts/deliveredPostsも型/初期値から削除。ケースごとの保護契約は `.superpowers/sdd/2026-10-26-group-g4-orders/e2e-disposition.md`。 |
| 117⑧の持越し | 題とその他の期待を維持。荷作り表の注文IDのLink/href→詳細の変更履歴→発送票のLinkへ。詳細は固定、履歴は既存shipping bridgeの実DB読取。 |

実装者の確認: tsc・対象5ファイルのeslint・`jest tests/unit/e2e tests/unit/docs --runInBand`・validate-docs（既知のCheckout計画の相対リンク2件は別記）。最終実測値はTask 10 report。Playwright・DB・Supabase CLI・Docker・サーバー起動は実行しない。鍵は通常withOrderAdminScenarioの共有190520,0、権限変更はwithPermissionScenarioの排他190520,0。設定ロック940488→14314,2→190520,0の順を変えず、このTaskの材料は追跡/返品の設定を変更しない。

## 記録形式と追跡

要件の原本は `docs/02_Requirements/requirements.md` とし、関連する詳細設計は `docs/04_DetailDesign/` で確認する。テスト記録には要件 ID、受け入れ条件 ID、対象ファイルとテスト名、対象リビジョン、環境、実行コマンド、日時、結果、失敗時の証拠を残す。`FR-*` のような画面要件と `FREQ-*-AC-*` の受け入れ条件を混同しない。対応テストが見つからない要件は「未対応」、テストが検出されただけなら「未実行」と記録する。

| 要件・受け入れ条件の例 | テストの例 | 確認する振る舞い |
| --- | --- | --- |
| `FR-ABOUT-001` | `e2e/FR-ABOUT-001-brand-philosophy-section.spec.ts` | ブランド哲学セクションの表示 |
| `FREQ-257-AC-10` | `e2e/FR-ADMIN-043-transaction-workbench.spec.ts`、`tests/unit/components/CostProfitSection.test.tsx` | 手動取引の操作列、編集・削除の確認。受け入れ条件への完全な対応はテスト内容と実行結果を個別に確認する |
| `FREQ-106-AC-01` | `e2e/FR-LEGAL-004-konbini-deadline.spec.ts`、`tests/unit/api/checkout/create-session-route.test.ts` | コンビニ決済期限の表示とセッション設定。受け入れ条件への完全な対応はテスト内容と実行結果を個別に確認する |
| `FREQ-321-AC-01` | `.github/workflows/db-migrations.yml` の構成確認 | PR の dry run と push 時の適用。実際の本番適用履歴は別途確認する |

## テストの層と範囲

| 層 | 構成と目的 | 実行の例 |
| --- | --- | --- |
| 静的検査 | ESLint と TypeScript の構文・型の確認 | `npm run lint`、`npm run typecheck` |
| Jest | `jest.config.cjs` の `tests/**/*.test.(ts\|tsx\|js)`。関数、コンポーネント、API、SQL マイグレーションの契約を確認 | `npm test -- --runTestsByPath tests/unit/components/CostProfitSection.test.tsx` |
| Playwright E2E | `playwright.config.ts` の `e2e/`、Chromium。画面・API を通る利用者の流れを確認 | `npm run test:e2e -- e2e/FR-ABOUT-001-brand-philosophy-section.spec.ts` |
| 運用確認 | DB 適用、外部 Webhook、アーカイブ復元等の実環境での結果を確認 | 対象の運用手順と実行記録を参照 |

Playwright は `http://localhost:3000` を使い、手元の Supabase に対して流す。3000番のアプリは、E2E が手元の設定で起動したもの（印が一致するもの）だけをビルドし直さずに使い回し、それ以外は止まる。`E2E_STRICT=1` では使い回さず、3000番が空いていなければ止まる。CI では再試行が設定されている。ファイル発見や `--list` は実行結果に含めない。

## グループ G-1（在庫の割当）のテスト

対象要件は FREQ-520〜524・535・540〜541（[要件](../../02_Requirements/requirements.md)の各受け入れ条件）。設計は[在庫の割当の流れ](../../04_DetailDesign/sequence/inventory-allocation.md)・[在庫の割当の状態](../../04_DetailDesign/states/inventory-allocation.md)・[ER 図](../../03_BasicDesign/data/er.md)。受け入れ条件との対応は要件の各条件が挙げる試験を正本とし、要件が名前を挙げていない試験の対応は、試験の内容から付けた。表は検証観点の参照であり、実行・成功を意味しない。実行結果と証跡は、最終検証の記録（`.superpowers/sdd/2026-10-24-group-g1-allocation/`）に残す。

### 実行の前提

| 層 | 前提と流し方 |
| --- | --- |
| DB 結合（`tests/integration/db/group_g1_*`） | 手元の Supabase（`npx.cmd supabase db reset` の直後）と `DATABASE_URL`（localhost だけ。無ければ skip、localhost 以外は失敗）。reset の後に、`GET /rest/v1/items?select=id&limit=0` が anon と実の authenticated の両方で HTTP 200 を返すことを確かめてから流す |
| 清掃の DB 結合（`group_g1_cleanup`） | 本番相当の全注文を消して commit するため、G-0 の版までの DB に限る。`npx.cmd supabase db reset --version 20261023175712 --no-seed` の後に `$env:G1_CLEANUP_SUITE='1'; npx.cmd jest tests/integration/db/group_g1_cleanup.integration.test.ts --runInBand` でこのファイルだけを流す。合図が無い時（全件の DB 結合）は DB の試験を飛ばす。DB を使わない「移行の形」の試験は常に動く |
| 単体 | `npx.cmd jest <パス> --runInBand`。DB 不要 |
| E2E | 本番ビルド（`next build && next start`）と手元の Supabase に対して、3000番のアプリを止めてから `npm.cmd run test:e2e -- <パス>`。画面は mobile 390・tablet 768・desktop 1280 の3幅で見る |

### DB 結合（`tests/integration/db/`）

| テスト | 対応する受け入れ条件 | 確認する振る舞い |
| --- | --- | --- |
| `group_g1_model.integration.test.ts` | FREQ-521-AC-01・AC-02、FREQ-523-AC-01、FREQ-540-AC-05 | 4表・2列・12 FK・台帳の理由の CHECK。RLS・権限・所有者・`search_path`。割当の履歴・状態の履歴・操作の受付の更新／削除／全消しの拒否。割当の現在値の守り（種類は H から A だけ、残数量は増えない、`version`）。数の確かめ（`transfer` の両側の同数量・相互参照、`consume` は A だけ、明細ごとの上限、H と A の排他）。操作の受付の再送とその制約 |
| `group_g1_item_states.integration.test.ts` | FREQ-520-AC-01・AC-02 | 12状態の数量和が明細の数量に一致し、区間に重複も穴も無い。`payment_in_progress`／`abandoned` は表に出ない。variant が空の明細は要確認で FIFO の対象外。部分取消・返品の却下・返金の失敗・交換と、変化した数量だけの状態の履歴 |
| `group_g1_fifo.integration.test.ts` | FREQ-521-AC-01、FREQ-522-AC-01 | 注文日・注文 ID・明細 ID の昇順で部分的に割り当て（古い2・新しい2に入荷2で2／0）、余りは F に残る。重複した variant の入力で二重に割り当てない。H から A への切替は F も手元の在庫も変えず、古い待ち注文はその確保を取れない。取消・返金の数量・未入金・取消済み・保留・variant が空の行と、交換手数料待ちは対象外で、手数料待ちは解除後に元の注文日で参加する（台帳は `exchange`）。発送の合成は A を消費し、二重の `purchase` を作らない。台帳の孤児と誤った明細は遅延の確かめが断り、割当の履歴の失敗で入荷・F・割当・操作・状態の履歴が全部戻る |
| `group_g1_checkout.integration.test.ts` | FREQ-521-AC-01、FREQ-522-AC-01・AC-02 | 在庫の明細は `purchase` −n と H を1つだけ作り、A は入金まで作らない。variant が足りなければ backorder で H も台帳の行も無い。拒否（表示の在庫・廃止 variant・持ち主）は元の分類のまま何も書かない。入金待ちは H を保つ。未入金の解放は同じ操作で最も古い待ち注文へ FIFO する。失敗した注文の取消は H を1度だけ放す。同じ Session の同時の受付は1注文、最後の1点を争う2つの Session は H が1つで在庫が負にならない |
| `group_g1_payment.integration.test.ts` | FREQ-535-AC-01、FREQ-522-AC-01 | 入金で買い手本人の H が A に変わり（案A。古い待ち注文は次の入荷で先に受ける）、`paid_at` を初めて一度だけ書く（正常・0円・金額の違い・期限後・取消後）。再送・期待状態の不一致では変えず、変更や空への戻しは service_role の直接の更新も含め `GROUP_G_PAID_AT_IMMUTABLE` で断る。variant が空の明細は要確認で FIFO の外 |
| `group_g1_payment_review.integration.test.ts` | FREQ-522-AC-01 | 支払額の違いの要対応と保留を同じ取引で作る。人とシステムの両方の解決で保留を閉じ、FIFO に再参加する。別の注文の要対応に保留を付けない |
| `group_g1_exchange_fee.integration.test.ts` | FREQ-535-AC-01、FREQ-522-AC-01 | 交換手数料の入金・免除・発送保留の解除は `paid_at` を変えない。手数料待ちの行は FIFO の対象外で、解除後に元の注文日で参加する |
| `group_g1_stock_api.integration.test.ts` | FREQ-521-AC-01、FREQ-522-AC-01 | 在庫の窓口の関数。入荷は FIFO を1回回して状態と履歴を残し、同じキーの再送は増分0。同じキーで中身（数量・理由・メモ・確認の数・実行者・variant・商品）が変わると競合。減らす操作は空き F を先に使い、新しい A から外す（H と発送済みは無傷）。空きだけの減少は確認が要らず、間に在庫が変わると確認を求め直して何も書かない。実行者の権限が失効・期限切れ・無いと拒否。状態の履歴が書けなければ台帳・割当・操作・F が全部戻る |
| `group_g1_inventory_reads.integration.test.ts` | FREQ-521-AC-01、FREQ-541-AC-01 | F／A／H の残りと待ちの読み出し（無効な variant を残し、重複と空の入力を扱う）。予約は A と H の残り、仕上がりは発送と A、未入金の H は準備済みに数えない。お客様の準備数量と管理の投影の違い。金額確認や交換手数料で止めた受注生産も待ちに数える。割当の履歴は商品の variant で絞り、同時刻は UUID 順、既定50件・上限200件。台帳の履歴は台帳だけ。公開の読み出しは service_role 専用の INVOKER の委譲 |
| `group_g1_refund_cancel.integration.test.ts` | FREQ-520-AC-02、FREQ-522-AC-01、FREQ-541-AC-01 | 返金で発送前の A を外して台帳・履歴を足し、戻さない扱いは手元から落とす。失敗・エラーで覆いが外れた数は元の注文日で待ち直す。発送後の行は在庫を動かさない |
| `group_g1_cancel_request.integration.test.ts` | FREQ-520-AC-02、FREQ-522-AC-01・AC-02 | 取消申請の承認・お断り・閉じるで割当を保留し、FIFO に再参加する。顧客の補助関数が別接続でも共通の鍵に従う |
| `group_g1_return_requests.integration.test.ts` | FREQ-520-AC-02、FREQ-541-AC-01 | 返品の申請・作成・承認・却下・取消の数量と履歴（承認は発送分だけを変えて未発送の A と在庫を保つ。却下は配送の出来事を作らない）。再送・CAS の増分は0。履歴が書けなければ業務・メール・操作が全部戻る。内部の核は本物の advisory を持つ時だけ動き、操作の設定値だけでは実行できない |
| `group_g1_return_exchange.integration.test.ts` | FREQ-520-AC-02、FREQ-522-AC-01 | 返品の受取・検品・金額の決定と交換の品の FIFO（元の注文日で並ぶ）。途中で失敗しても割当と台帳が全部戻る |
| `group_g1_delivery.integration.test.ts` | FREQ-541-AC-01 | 配送の結果の反映。公開口は private 本体への委譲で、本体が共通の鍵を最初に取る。配達済みは操作1件と状態履歴を同じ取引で残し、発送・追跡の版・出来事で決まる再送キーにより、同じ版の再送は何も増やさず、版を訂正で上げた後の配達済みは別の記録になる。状態の履歴が書けなければ反映・登録・メール・操作が全部戻る |
| `group_g1_concurrency.integration.test.ts` | FREQ-522-AC-02 | 全入口で、別接続が advisory だけを持つ間は行の鍵が空いていること（advisory が先）。解放後の保存則、逆の順の variant・同時の入金／解放／返金失敗／受取／保留解除で deadlock・二重割当が起きない |
| `group_g1_link_guest_orders.integration.test.ts` | FREQ-522-AC-02、FREQ-541-AC-01 | ゲストの注文の関連付けが advisory を先に取り、注文を id 昇順に更新する。別接続の競合と、変えていない profile の外部キー（40P01 を許容する別枠） |
| `group_g1_writer_inventory.integration.test.ts` | FREQ-521-AC-02、FREQ-522-AC-02、FREQ-540-AC-05 | `pg_proc.prosrc` を走査し、4表・台帳・発送・仕上がりへの書込みと `item_variants.stock_quantity` の更新を持つ関数が、書き手の閉じた一覧の中だけであること。動的 SQL で参照する未審査の関数を断る |
| `group_g1_legacy_disabled.integration.test.ts` | FREQ-524-AC-03、FREQ-540-AC-05 | 旧の発送4関数が `LEGACY_FULFILLMENT_DISABLED`、仕上がり2関数が `MANUAL_COMPLETION_DISABLED`（55000）。仕上がりの表への書込み停止。旧の写しの関数2本の削除。止めた関数は共通の鍵も注文の行も待たない（2接続） |
| `group_g1_cleanup.integration.test.ts` | FREQ-524-AC-01 | 移行の形（先頭の清掃・末尾の確かめ・`BEGIN`／`COMMIT` 各1）。31表すべてに行がある本番相当の状態での全文の実行。末尾の故障注入で全行・在庫・定義・トリガー・FK が復元する。未完了の Webhook を `dead` にして通知の対象から外す。保持する対象は変えない。件数の読み取り `sql/group_g1_cleanup_counts.sql` も同じ条件 |
| `group_g1_final_acl.integration.test.ts` | FREQ-540-AC-05 | 末尾の表の権限の確かめが、役割の所属などの環境差でなく意味（所有者・service_role の SELECT だけ・PUBLIC と anon／authenticated の権限なし）で比べる |
| `group_g1_fixtures.integration.test.ts` | FREQ-524-AC-04、FREQ-541-AC-01 | 合成の割当・発送・入荷の材料が G-1 の制約を満たし、材料の取引が自分の接続で完結する |
| `group_g1_j19_compat.integration.test.ts` | FREQ-524-AC-04、FREQ-541-AC-01 | 状態の変更に理由を要求する保留中の移行（J-19）を当てた DB でも、G-1 の流れが通る。保留中の SQL の形（DB なし）も確かめる |

### 単体・E2E

| テスト | 層 | 対応する受け入れ条件 | 確認する振る舞い |
| --- | --- | --- | --- |
| `tests/unit/lib/inventory/allocation-event-reasons.test.ts` | 単体 | FREQ-521-AC-02 | 割当の履歴の理由の TS の一覧（`ALLOCATION_EVENT_REASON_CODES`）が DB の CHECK と同じ集合で、すべてに日本語の名前があり、知らない値は「システム」と表示する。移行が書く文字の理由は決まった値だけ |
| `tests/unit/e2e/group-g1-test-utils.test.ts` | 単体 | FREQ-524-AC-04、FREQ-541-AC-01 | E2E の材料の道具が、注文と割当（H／A）を同じ G-1 の取引で作り、発送を割当の消費として合成し、旧の発送の関数を呼ばず、失敗時に取引ごと戻し、localhost 以外の DB では何も問い合わせずに止める |
| `tests/unit/components/AdminGroupG1LegacyStop.test.tsx` | 単体 | FREQ-524-AC-03、FREQ-540-AC-05 | 注文の一覧と履歴で、旧の発送・発送の取消・伝票番号の訂正・手動の配達済み・仕上がりの入口を出さず、固定の停止文を1回ずつ出す。取消・返金・返品・申し込み・履歴・メールの再送は残る。G-4 Task 7 の後: 旧い一覧（OrderSection）は撤去したので注文一覧の部分は ORDER タブの入口の確かめ（停止文・旧い一覧が出ない）に書き換えた。荷作り表の案内は荷作り表へ、仕上がりの停止の文は410の本文だけに残る |
| `e2e/FR-ADMIN-123-group-g-permissions.spec.ts`（G-1の部分、G-4 Task 10で更新） | E2E | FREQ-524-AC-03、FREQ-540-AC-05 | 旧401/403/固定410の3caseを旧8メソッドの実HTTP404の1case（G-4⑤）へ統合。旧DB関数拒否はgroup_g1_legacy_disabled。店長/サポーターのORDERは一覧への入口だけで停止文なし、詳細には旧操作が無く取消/返金（店長）・返品・申請・履歴/メールの読み取りと再送が残る。3幅、変更後E2E未実行 |

同じファイルの G-0 の部分（権限の画面と保存）は FREQ-540-AC-01〜04 の対応で、この節では扱わない。全件の E2E は最新の基準と比較し、停止・削除・追加と未確認の範囲を分けて記録する（FREQ-541-AC-02）。

## グループ G-2（発注・受け取り）のテスト

対象要件は FREQ-525〜530・540（[要件](../../02_Requirements/requirements.md)の各受け入れ条件）。設計は[実装計画](../../superpowers/plans/2026-10-24-group-g2-purchasing.md)。実行の前提は G-1 の節の「実行の前提」と同じ（DB 結合は `npx.cmd supabase db reset` の直後と PostgREST の smoke の後に流す）。この節は Task 1（在庫の窓口の権限の切替、G-1 から持ち越した2件、公開関数11本の実行権）と Task 2（発注書の9表・追記専用トリガー・個別の権限・非公開の置き場）と Task 3（在庫一覧表の読取・窓口・画面・管理メニューの INVENTORY）と Task 4（発注の作成・ロック helper・書き手の一覧の57本）と Task 5（発注一覧表・発注書の詳細の読取・表示段階）と Task 6（数量の確定・訂正・単価、残りの打切り・確定前の取消、発注先・メモの訂正、書き手の一覧の60本）の分から始め、Task 7〜10 と最終レビューの修正の分を、下の表に続けて足してある。

### DB 結合（`tests/integration/db/`）

| テスト | 対応する受け入れ条件 | 確認する振る舞い |
| --- | --- | --- |
| `group_g2_stock_permissions.integration.test.ts` | FREQ-540-AC-06 | `admin.items.read/manage` だけの実行者の入荷は `GROUP_G_FORBIDDEN`／42501 で、台帳・在庫・操作が増えない。`admin.stock.manage` だけ・`admin.stock.read` だけもどちらも断られ、両方で入荷できる（`supporter` に取引内で `role_permissions` を足し、最後に rollback）。2つの役割に権限が分かれて付いても有効な役割の和集合で通り、無効・期限切れの役割は数えない。実行者の無効・期限切れ・役割なし・権限の欠落を毎回確かめる。公開 `admin_record_stock_movement` は service_role だけが EXECUTE でき、所有者 postgres・`search_path` 空・SQL の INVOKER のまま。部品 `group_g_actor_has_permissions` の真偽表（NULL・空配列・未登録・重複・和集合）と、誰にも EXECUTE を付けないこと |
| `group_g2_g1_followups.integration.test.ts` | FREQ-525-AC-03、FREQ-535-AC-01 | `group_g_open_work_order_ids`（受注生産の数がありうる注文の先絞り）が、閉じた注文12件（取消・期限切れの失敗・放棄・発送済みで未解決なし・解決済みの返金／返品／取消申請）と、入金の記録が無い `pending`／`failed`／`payment_in_progress` を返さず、`paid`・入金の記録（`paid_at`／`paid_amount`）がある `pending`／`failed`・未解決の返金／返品／申請／発送前返金の失敗がある `shipped` の11件を昇順で返す（NULL は全バリアント、空配列は空）。発送済みの注文は、未発送で取り消されていない数がある時（発送の記録が無いものを含む）か未解決の作業がある時だけ残り、全部発送済み・残りが発送前返金で覆われたものは外れる（発送か割当のある取消の注文は残す既知の費用）。`lock_group_g_inventory` は G-2 の移行が置き換えず、その閉包は閉じた注文12件を入れず、開いた注文11件に加えて `pending`・`payment_in_progress`・期限切れでない失敗の4件を入れる（割当か保留が残る注文は状態に関わらず入る）。先絞りは投影が受注生産と数える注文の上位集合で、`list_group_g_variant_inventory` の `waiting` は、絞らない投影（`group_g_item_state_ranges` を variant の全注文に掛けたもの）と variant ごとに同じ数（paid・一部割当・入金済みの pending／failed・割当だけ／発送だけの入金記録なしの注文・取消の後の割当や発送・取消申請・発送前返金の失敗・発送の記録が無い発送済み・取消／放棄／支払い手続き中・全部発送済み・発送前返金で覆われた発送済みの注文を混ぜる）。置換した関数の署名・所有者・ACL・戻り型・volatility が G-1 のまま。`orders.paid_at` の最初の値は共通の鍵を持たない接続（共有モード・別の鍵も含む）では `GROUP_G_INVENTORY_LOCK_REQUIRED`、持てば通り、値から別の値・NULL は `GROUP_G_PAID_AT_IMMUTABLE`（service_role の役も）。`mark_order_paid` は押さえの無い取引から呼んでも自分で取って書く |
| `group_g2_public_function_acl.integration.test.ts` | FREQ-540-AC-09 | 公開関数11本（`increment_rate_limit_counter` は2つの overload を別々に）が、reset 直後の DB で anon / authenticated に EXECUTE を許さず `proacl` に PUBLIC も無く、service_role と postgres は保つ。anon / authenticated の役で `revoke_auth_sessions_for_user`・`revoke_auth_session`・`is_auth_session_active`・`find_auth_user_id_by_email` を呼ぶと SQLSTATE 42501 で何も消えない。service_role の役では `is_auth_session_active`・`revoke_auth_session` が動く。移行の末尾の確かめ（`public_function_acl`）が、anon／authenticated／PUBLIC の付与・service_role の剥奪・関数の欠落で止まる。移行の形（11本の REVOKE が1文、11本への GRANT なし、private スキーマの USAGE を触らない）も DB なしで確かめる |
| `group_g1_stock_api.integration.test.ts`（G-2 で変更） | FREQ-540-AC-06 | 在庫の窓口の権限の事例を `admin.stock.manage` を外す・`admin.stock.read` を外すに変えた（G-1 では `admin.items.manage`） |
| `group_g2_purchase_model.integration.test.ts` | FREQ-530-AC-01（モデルの基盤の確かめの全て: 追記専用・権限・置き場・末尾の確かめ・発注書と明細の制約・更新の守り・受け取りと納品数。題は FREQ-526／527／529 の受け入れ条件がまだ無かった Task 2 の時点では分けて付けていたが、モデルの確かめは FREQ-530-AC-01 に揃えた。個別の振る舞いの受け入れ条件は、Task 4 以降の各ファイルが持つ） | ①追記専用の7表は owner／service_role の通常の SQL の UPDATE・DELETE・TRUNCATE を `GROUP_G_HISTORY_IMMUTABLE`／55000 で断る（TRUNCATE は指す側の表を同じ文に並べる）。②`purchase_orders`・`purchase_order_lines` は DELETE・TRUNCATE を断り、UPDATE は識別の列（`GROUP_G_PURCHASE_ORDER_GUARD`、`immutable_column`）・版 +1（`version`）・共通の鍵の保持（`GROUP_G_INVENTORY_LOCK_REQUIRED`）を守る（何も変わらない更新は鍵も版も要らない）。③行の制約: 発注番号の書式と一意、発注先・メモの文字数、段階、仮数量 1〜99999・確定数量 0〜99999・単価 0〜9999999、確定数量は納品済み以上、未確定の納品数は 0、`outstanding_quantity` の生成値、単価の NULL と 0 の区別、発注書内の variant／行番号の重複拒否、履歴の NULL の `line_id` も同じ値とみなす一意、受け取りの種類と理由の組、受取行の数量と符号と相殺元の組、台帳の行・受取の行の一意、原本の種類・大きさ（1〜20971520）・SHA-256・出所、取引の記録の日付・金額・通貨・取引先・版と理由。操作の受付への5本の外部キーは遅延で、全22本（予約の差し替え元を足した1本を含む）が `ON DELETE RESTRICT`。④`received_quantity` が受取行の合計と違うと commit（遅延の確かめ）で `GROUP_G_PO_RECEIVED_MISMATCH`。⑤受取行は同 variant・同数量の無タグの台帳行（正は `restock`、負は `adjustment`）にしか結べず、タグ付き・別 variant・数量違い・理由違い・存在しない行・別の発注書の明細は `GROUP_G_PO_RECEIPT_LINE_MISMATCH`、受け取りの種類と行の符号は結ばれていて（種類 `receive` の受け取りは正の行だけ、種類 `reverse` の受け取りは負の行だけ。違えば同じ `GROUP_G_PO_RECEIPT_LINE_MISMATCH`／23514、`DETAIL` は `kind`。Task 2 のレビューの持ち越し M1）、負の行は同じ発注書・同じ明細の種類 `receive` の中の正の行にしか結べず、相殺の合計が元の数量を超えると commit で `GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED`。⑥9表の RLS・所有者・拒否だけの方針、PUBLIC／anon／authenticated は列権限を含め何も持たず、service_role は原本と予約の2表の `SELECT` だけ（`MAINTAIN` を含めて意味で比較）、役の下の直接の読み書きが 42501。3つのトリガー関数の所有者・`search_path`・実行権。⑦置き場 `purchase-order-documents` は非公開・20971520・3つの MIME、`storage.objects` に方針が無く、anon／authenticated は読めず・直せず・消せず・足せない（足すのは 42501）、service_role は読める。⑧移行の末尾の確かめ（`$g2a_final_objects$`・`$g2a_final_table_acl$`）は今の DB で通り、RLS・行・方針・列・制約・索引・トリガー・関数・置き場・権限の変更で `purchase_*` の項目名とともに止まる。移行の形（9表・置き場の行は1つ・`storage.objects` の方針と sequence を作らない・BOM と CR が無い。1本あたり 100,000 バイトの上限は外した）は DB なしでも確かめる |
| `group_g2_inventory_list.integration.test.ts` | FREQ-525-AC-01・AC-02・AC-03、FREQ-540-AC-07 | 在庫一覧表の読取 `list_admin_inventory(_actor_id)`（private 本体と public 入口）。①注文数5（支払い済み5点のうち2点が割当済み(ready)、3点が受注生産中）・在庫2・発注済み1（確定済み発注の未納）の variant は発注必要数2。②在庫を超える発注済みでも発注必要数は0未満にならない。複数の発注書の未納は variant ごとに合計。③戻り列は `list_group_g_variant_inventory` と同じ `free`／`paid_allocated`／`payment_held`／`on_hand`。④未払いの仮確保は在庫（`on_hand`）に入り注文数に入らず、取消申請中・返品申請中の数量も注文数に加えない。⑤発注済みは数量確定済みの行の未納だけで、仮数量は数えない。打切り（確定数量を納品数まで下げる）後は未納0で発注必要数が戻って増える（Task 6 の関数が無い間は直接 INSERT／UPDATE の材料で確かめ、Task 6 で関数経由へ置き換える）。⑥停止 variant は在庫・未納・未完了の注文のどれかがある間だけ出て、無くなれば消える（`is_active` は変えない）。⑦並びは商品・色の位置・サイズの位置・variant の番号（色もサイズも無い variant は最後）。⑧読取の前後で `item_variants`・色・サイズ・台帳・割当・割当の履歴・状態の履歴・操作の受付・発注の表の行数と在庫の合計が変わらず、`items.colors`／`sizes` だけの商品に variant を作らない。private 本体と public 入口が同じ行を返す。⑨`admin.stock.read` を持たない実行者（無効・期限切れ・役割なし・`admin.items.*` だけ・`admin.stock.manage` だけ・存在しない実行者・NULL）は `GROUP_G_FORBIDDEN`／42501 で行を返さず、`admin.stock.read` があれば読める（役割をまたいだ和集合も）。権限を外すとその場から断られる。⑩private 本体と public 入口は所有者 postgres・`search_path` 空・`STABLE`・戻り列13つで、PUBLIC／anon／authenticated に EXECUTE が無く service_role だけが持つ（public 入口は SQL の INVOKER）。anon／authenticated は両方とも 42501、service_role は public 入口から読める。⑪（AC-03）一覧の `order_quantity` は、先絞りをしない投影（その variant を持つ全注文を `group_g_item_state_ranges` に渡した `in_production` + `ready`）と variant ごとに同じ（入金済み・一部割当・仮確保・入金の記録がある pending／failed・取消申請・発送の記録が無い発送済み・取消・放棄・支払い手続き中・一部発送・返品申請中を混ぜ、全部 0 で一致したのではないことも確かめる）。移行の形（本体は何も書かず実行者の確かめが最初・`$g2a_final_inventory_list$` を足す）は DB なしでも確かめる |
| `group_g2_purchase_model.integration.test.ts`（G-2 Task 8 のレビュー修正） | FREQ-530-AC-01 | 予約の表の差し替え元 `replaces_attachment_id` を足したので、外部キーは全22本（`purchase_order_attachment_reservations_replaces_fkey`。存在しない添付は 23503、実在の添付は通る）、添付の TRUNCATE の文に予約も並べた |
| `group_g1_model.integration.test.ts`・`stock_movements.integration.test.ts`（G-2 で変更） | FREQ-530-AC-01 | 操作の受付を指す外部キーの期待に G-2 の5本を足し、操作の受付・台帳の TRUNCATE を断る試験は、新しく指す表（発注書の履歴・受け取り・原本の7表）を同じ文に並べた（外部キーの確かめがトリガーより先に走るため） |
| `group_g2_purchase_create.integration.test.ts` | FREQ-526-AC-02・AC-03、FREQ-540-AC-07 | 発注の作成 `admin_create_purchase_order`（private 本体と public 入口）とロック helper `lock_group_g_purchase_orders`。①発注書1件・明細N件・版1・段階 `ordered`・仮数量・名称の写し・変更の履歴（種類 `order`・`revision_no` 1。発注書全体の1行と明細ごとの1行）・操作の記録が一度に保存され、番号は `PO-<日本時間の日付>-<その日の最大＋1>`（空の DB なら 0001。発注書は消せないので期待は最大＋1で書く）。商品名を変えても写しは変わらない。色・サイズが無い variant は NULL。発注先・メモの前後の空白は落とし、空白だけのメモは NULL。`line_no` は入力の並びで1から連番。上限ちょうど（100行・数量99999・発注先100字・メモ500字）は通る。②同日の2件目は次の番号、別の日（昔・前日・翌日）の番号は数えず、その日が 9999 まで使われていれば `GROUP_G_PO_NUMBER_EXHAUSTED`／55000 で何も残らない。③同じ `request_key`・同内容の再送（発注先・メモの空白や明細の並びが違っても同じ）は同じ発注書・`replayed: true`・行数増加0（保存した結果は `replayed: false` のまま）。内容（発注先・メモ・数量・variant・件数・実行者）が違えば `GROUP_G_REQUEST_KEY_CONFLICT`／23505 で何も増えない。権限の無い実行者には再送の結果も見せず `GROUP_G_FORBIDDEN`。④引数（行0件・配列でない・101行・variant 重複・数量0／100000／負／小数／文字列・variantId の型違い・余分や不足の項目・要素が object でない・存在しない variant・発注先の空／空白／NULL／101字・メモ501字・実行者や要求番号の NULL）は `GROUP_G_ARGUMENT_INVALID`／22023 で何も残らず、権限の確かめより先に断る。⑤`GROUP_G_FORBIDDEN`／42501: 無効・期限切れの役割・役割なし・存在しない実行者、`admin.items.*` だけ・manage だけ・read だけ・在庫と受け取りの権限だけは断り、manage ＋ read があれば通る（役割をまたいだ和集合も、店長は初期のまま）。権限を外すとその場から断る。⑥在庫・割当・割当の履歴・台帳・状態の履歴・注文の行数と各 variant の在庫・割当の残りは、作成と再送の前後で変わらない（増えるのは発注の3表と操作の記録だけ）。⑦途中失敗: 明細ごとの履歴の INSERT に故障を注入すると（その時点で発注書1件・明細2件が書かれていたことも確かめる）、最後の操作の記録の INSERT に注入しても、発注書・明細・履歴・操作が全部残らず、同じ `request_key` で後から作り直せる。⑧private 本体は所有者 postgres・DEFINER・`search_path` 空・戻り `jsonb` で service_role だけが EXECUTE でき、public 入口は SQL の INVOKER（service_role のみ）、ロック helper は誰も EXECUTE できない（service_role も 42501）。anon／authenticated は両方の入口を呼べず（42501）、service_role は public 入口から作れる。ロック helper の `prosrc` の最初の文は `pg_advisory_xact_lock(190521,1)` で、押さえを持たない取引で呼んでも自分で取る。`_with_inventory` が偽なら空の配列、真ならその発注書の variant の在庫の閉包（G-1 の `lock_group_g_inventory` と同じ結果、注文 id 昇順、関係の無い注文は入れない）。移行の形（`G2B` の印・BEGIN／COMMIT が1組・ASCII のみ・処理の順・在庫の表を書かない・書き手の一覧は G-1 の56本に1文字も変えず1本足した57本・末尾の確かめ `$g2b_final_objects$`／`$g2b_final_table_acl$`）は DB なしでも確かめる |
| `group_g1_writer_inventory.integration.test.ts`（G-2 Task 4 で変更） | FREQ-526-AC-02 | 書き手の閉じた一覧の期待に `private.admin_create_purchase_order(text,text,jsonb,uuid,uuid)` を足し、56本を57本にした（止めた旧の6本は同じ）。走査の規則は緩めていない |
| `group_g1_writer_inventory.integration.test.ts`（G-2 Task 7 で変更） | FREQ-540-AC-07 | 書き手の閉じた一覧の期待に `private.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid)`・`private.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid)` を足し、60本を62本にした（走査の規則は緩めていない。`group_g2_purchase_create`・`group_g2_purchase_quantities` の一覧の本数の期待も62本に合わせた） |
| `group_g2_purchase_quantities.integration.test.ts` | FREQ-527-AC-01・AC-02、FREQ-528-AC-01・AC-02、FREQ-525-AC-02、FREQ-526-AC-05、FREQ-540-AC-07 | 数量の確定・訂正 `admin_confirm_purchase_order_quantities`、残りの打切り・確定前の取消 `admin_short_close_purchase_order`、発注先・メモの訂正 `admin_update_purchase_order_header`（それぞれ private 本体と public 入口）。DB なしの静的な試験: 処理順（引数検証 → ロック → 権限 → 指紋と再送 → 存在 → 版 → 書込み → 操作の記録が最後）、指紋に版が無いこと、単価だけの変更の履歴が `before_quantity` ＝ `after_quantity` を書く文、3本が在庫・台帳・受取・割当・注文に触れず書く表が決まった物だけであること、権限の付け方と public 入口の委譲、末尾の確かめ。DB の試験: ①最初の確定で全行の確定数量・未納＝確定数量・版+1・全行の履歴（確定そのもの。仮数量のまま・単価なしの行も、理由と実行者つき）・changedLines は実際に変わった行だけ・単価 NULL と 0 の区別、何も変えない最初の確定でも全行の履歴が残り表示段階は変わらないこと、再確定は変わった行だけに履歴を足し最初の確定の履歴は消えないこと、②増やす・減らす・0にする、③引数（不足・重複・他の発注書の行・形・範囲）の 22023 と何も残らないこと、④訂正は理由が要り納品済み未満は `GROUP_G_PO_QUANTITY_BELOW_RECEIVED` で前の版の履歴が消えないこと、⑤版が違えば `GROUP_G_PO_VERSION_CONFLICT` で何も変わらず、確定前は全行を渡せば取消でき一部は 22023、確定前は受け取れない（表の制約）こと、⑥再送（版が進んだ後の古い版での再送を含む）と衝突、⑦確定10・納品6 の打切りが 6/6/0・`closed_quantity` 4・履歴 10→6、⑧未納0の行を含む打切りは `GROUP_G_PO_NOTHING_TO_CLOSE`、誤った打切りは理由付きの訂正で戻せて元の打切りと履歴が残ること、⑨全体の取消（確定前・確定後で受取のある行）、⑩打切りで `list_admin_inventory` の発注済みが減り発注必要数が増えること、⑪打切りを戻して全部を受け取ると `received`（sticky でない）、⑫単価だけの訂正は打切りの後も `closed` のまま、数量が実際に変わると戻り、別の行の訂正は他の行の打切りを戻さないこと、⑬発注先・メモの訂正（理由・空白・片方だけ・どの段階でも）、⑭権限（items.*・在庫・受け取りだけ、manage だけ、read だけ、無効・期限切れ・役割なし・存在しない実行者、役割をまたいだ和集合、外した直後）、⑮途中失敗（履歴・打切り・操作の記録に故障を注入）で何も残らず同じ要求番号で作り直せること、⑯在庫・割当・台帳・状態の履歴・注文・受取が動かないこと、⑰関数の形と ACL と書き手の一覧が60本であること |
| `group_g2_purchase_reads.integration.test.ts` | FREQ-526-AC-04・AC-05、FREQ-540-AC-07 | 発注の読取 `list_admin_purchase_order_lines`・`get_admin_purchase_order`（private 本体と public 入口）と、表示段階の helper `purchase_order_display_stages`。①（AC-04）一覧は発注書番号の降順・同じ発注書内は `line_no` 順・20行の頁で `total` が全明細の数（各行に同じ値）、数量確定前の行の `order_quantity` と `outstanding_quantity` は NULL（`display_stage` は `ordered`）、確定後は発注数量・納品済み・未納（確定数量 − 納品済み）、色・サイズが無ければ NULL、範囲外の offset は行なし。②`limit` が 0・101・負・NULL、`offset` が負・NULL は `GROUP_G_ARGUMENT_INVALID`／22023（権限の確かめの後）。③（AC-05）詳細のキーは決まった集合（最上位17・明細12・履歴15・打切り6・受け取り8・受取行5・書類10と `current` 8・保存途中の予約6）で `storage_path`・操作の ID・`uploaded_by` を含まず、行は `line_no` 順、履歴は版 → 発注書全体の行 → `line_no` 順、存在しない id・NULL は NULL。④表示段階: `ordered`、確定済みで納品なし、一部受け取り、全て受け取り、打切り、打切りを数量が実際に変わる再確定（より新しい quantity の版 2 → 5）で戻した後は `received`、打切りの後に単価だけの quantity の版（before = after、または数量が両方 NULL）を足しても打切りは有効のまま `closed`（その後に数量が変わる版を足すと `received`、数量が変わる版の後の単価だけの版は戻さない）、打切りの無い発注書の単価だけの版は段階を変えない、版の番号が大きい版を先に入れても行ごとの最新（版の番号の最大）で決める、他の行の quantity の版は打切りを戻さない、全行が確定数量 0 は打切りの版が無くても `closed`、一部の行だけの打切り、未納が残る間は未納側の段階。helper の戻り（納品・未納の合計と `has_active_short_close`）、複数の発注書を一度に、NULL・空は行なし。詳細と一覧は同じ段階を返す。⑤`pendingUploads` は添付に結ばれていない予約だけで期限切れは `expired` が真、保存先の鍵は出さない。差し替えの予約は差し替える添付の id を `replacesAttachmentId` に出し、それ以外は null（Task 8 のレビュー修正）。`flags.unitPriceMissing` は確定後に単価 NULL の行がある時、`flags.documentMissing` は確定後に最新の版が無効でない書類が無い時（無効にすると真に戻り、有効な書類が増えると偽）、確定前（ordered）はどちらも偽。`estimatedAmountYen` は単価と確定数量がある行の積の合計（0円も単価、全行が未登録なら NULL）。書類の `current` は最新の版、`revisionCount` は版の数、ただし `current.replacesAttachmentId` は版1から返す（版2・版3に直した差し替えの添付も差し替え元の id を失わず、差し替えでない添付は null のまま）。`reversibleQuantity` は正の行の数量から相殺の合計を引いた残りで、相殺の行は 0。⑥（AC-07）`admin.purchase_orders.read` を持たない実行者（無効・期限切れ・役割なし・`admin.items.*` だけ・manage だけ・在庫の権限だけ・存在しない実行者・NULL）は一覧も詳細も `GROUP_G_FORBIDDEN`／42501、権限が無ければ範囲外の引数でも存在しない発注書でも 42501（権限の確かめが先）、read があれば読める（役割をまたいだ和集合も）。権限を外すとその場から断られる。⑦4本の読取は所有者 postgres・`search_path` 空・`STABLE`、PUBLIC／anon／authenticated に EXECUTE が無く service_role だけが持つ（public 入口は SQL の INVOKER）。helper は誰も（service_role も）EXECUTE できない。anon／authenticated は両入口とも 42501、service_role は公開入口と private 本体から読める。⑧読取の前後で発注・履歴・受け取り・書類・予約・操作・台帳・variant の行数と在庫が変わらない。⑨移行の末尾の確かめ `$g2a_final_purchase_reads$` は今の DB で通り、EXECUTE の付与・剥奪、DEFINER／INVOKER の取り違え、`STABLE` の変更、`search_path` の変更、関数の欠落で `purchase_read_functions` とともに止まる。移行の形（読取の関数は何も書かず・鍵を取らず、権限の確かめが最初で、段階の名前は helper にだけある、`storage_path` と操作の ID を戻さない、BEGIN／COMMIT が1組・ASCII のみ）は DB なしでも確かめる |
| `group_g2_purchase_reads.integration.test.ts`（G-2 Task 7 で追加） | FREQ-526-AC-05 | 表示段階を本物の操作（作成 → 数量の確定 → 受け取り → 取消 → 受け取り、別の発注書で一部受け取り → 打切りで `closed` → 数量の再確定で `partially_received` → 受け取り完了）で通し、詳細と一覧が同じ段階を返すこと。受取の実行者のメールアドレス（`actorEmail`）が、アカウントがあれば返り、無ければ NULL であること |
| `group_g2_purchase_receipts.integration.test.ts` | FREQ-529-AC-01・AC-02、FREQ-525-AC-01、FREQ-540-AC-07 | 受け取り `admin_receive_purchase_order`（private 本体と public 入口）。DB なしの静的な試験: 処理順（引数検証 → ロック〔在庫あり〕→ 権限 → 指紋と再送 → 存在 → 段階 → 版 → 受取日 → 行と未納 → 状態の保存 → 受取 → 台帳 → 受取行 → FIFO → 履歴 → 操作の記録が最後）、台帳の入庫が `restock`・無タグで備考が `U&` の文字の列、書く表が決まった物だけ、書き手の一覧62本、末尾の確かめ、ASCII のみ。DB の試験: ①全部受け取りで restock（+q・備考「発注 PO-… の受け取り」・`allocation_operation_id` が NULL）・受取・受取行（台帳 id）・納品済み・未納0・空き在庫・版・操作の記録が一度に保存され、表示段階が受け取り完了。②古い待ち注文2件に2点入庫すると古い方だけ割当（割当イベントの理由 `fifo`、FIFO の `purchase` 行だけタグ付き、状態の履歴の理由 `purchase_order_receive`）。③案A: 買い手本人の仮確保は奪われない。④一部 → 後日に残りで納品済み・未納・段階が進み、2回目も FIFO が動く。⑤受取日は発注日から今日（日本時間）。⑥同じ request_key と同じ内容の再送（行の並び・版が違っても）は同じ受取・`replayed: true`・増加0、内容が違えば `GROUP_G_REQUEST_KEY_CONFLICT`。⑦数量確定前・未納超過・版違い・存在しない発注書・他の発注書の行・不正な引数・打切り後の行は全て不変で断り、1行が不正なら他の行も含め全て不変。⑧権限（receiving.manage ＋ purchase_orders.read。manage だけ・read だけ・発注や在庫や items の権限だけ・無効・期限切れ・役割なし・存在しない実行者は42501、役割をまたいだ和集合は通る）。⑨途中失敗（2行目の受取行・FIFO の割当イベント・操作の記録に故障注入）で全て戻り、同じ要求番号で作り直せる。⑩表示段階が 数量確定済み → 一部受け取り済み → 受け取り完了、打切りで完了。⑪在庫一覧表の発注済み・手持ち・発注必要数。⑫関数の形と ACL、anon／authenticated は呼べない（2026-10-25 に使い捨ての DB で通過）。⑬FIFO に回すのは受け取った variant だけ（空き在庫と待ち注文がある別の行の variant は動かない） |
| `group_g2_purchase_receipt_reversals.integration.test.ts` | FREQ-529-AC-04・AC-05、FREQ-525-AC-01、FREQ-540-AC-07 | 受け取りの取消・数量訂正 `admin_reverse_purchase_order_receipt`（private 本体と public 入口）。DB なしの静的な試験: 処理順（引数検証〔理由が必須〕→ ロック → 権限 → 指紋と再送 → 存在 → 版 → 受取と行 → 取り消せる数 → 在庫の不足 → 確認の数 → 相殺の受取 → 割当の解除 → 調整の台帳 → 受取行 → FIFO → 履歴 → 操作の記録）、確認の判定式が G-1 と同じ、paid だけを新しい注文から外し仮確保に触れない、台帳 `allocation_release`（タグ付き）と `adjustment`（無タグ）、割当イベント `stock_adjustment`、状態の履歴 `stock_move`。DB の試験: ①取消で相殺の受取（reverse・理由）・負の受取行（相殺元）・調整の台帳（−q・無タグ）が追記され、納品済み −q・未納 +q・空き在庫 −q・版 +1、元の受取と行は不変。②一部の訂正で取り消せる数が減り、分けた相殺の合計が元を超えると `GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED`。③受け取った在庫が古い注文2件に割り当て済みの時、最初の送信は `GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED`／55000 で DETAIL が `{"releasedQuantity": n}`、全て不変。確認の数が違えば再び409、理由なしは `GROUP_G_PO_REASON_REQUIRED`、正しい数と新しい request_key で再送すると新しい注文の割当から外れる（`allocation_release`・割当イベント `stock_adjustment`・状態の履歴 `stock_move`）。④空き在庫が足りる時は割当を外さず確認の数なしでも通り、一部だけ足りない時は不足分だけ外す。複数の variant は variant ごとの合計。⑤`GROUP_G_PO_REVERSE_STOCK_INSUFFICIENT`（仮確保は数えない・出荷で消費された割当は外せない）で全て不変。⑥取消後の再受け取り（FIFO が動く）、打切り済みの行の取消で未納が復活し発注必要数は不変。⑦再送は二重減算・二重解除0、内容が違えば衝突。他の発注書や他の受取の行・相殺の行・存在しない受取は断る。⑧権限・途中失敗（割当の解除の途中・相殺の受取行・操作の記録）で全て戻る・関数の形と ACL（2026-10-25 に使い捨ての DB で通過）。複数の variant の取消では FIFO に回すのは取り消した variant だけ（空き在庫と待ち注文がある別の行の variant は動かない） |
| `group_g2_purchase_documents.integration.test.ts`（G-2 Task 8） | FREQ-530-AC-01・AC-02・AC-03、FREQ-540-AC-07 | 取引書類の原本の予約・確定・訂正・無効化 `admin_reserve_purchase_order_attachment`・`admin_attach_purchase_order_document`・`admin_revise_purchase_order_document` と検索 `search_purchase_order_documents`（private 本体と public 入口）。DB なしの静的な確かめ（処理順＝引数の検証 → ロック → 権限 → 指紋と再送 → 存在 → 書込み → 操作の記録、書く表が決まった物だけで UPDATE・DELETE が無い、置き場・在庫・発注書に触れない、ACL の文、移行は ASCII・LF）に加え、①予約 → 確定で添付1・版1・種類・原ファイル名・保存キー・種類・大きさ・ハッシュ・出どころ（browser／server のどちらも保存でき、他は 22023）・取引日・金額・取引先・実行者が残り、予約は添付に結ばれ、発注書・在庫・台帳・割当は変わらない。予約は24時間の期限と保存キーの形・拡張子を作り、引数の誤りは 22023 で何も残らない。②予約だけの間は添付として見えず pendingUploads に出て、期限切れの予約は expired＝true で行が残り期限後も確定できる。③同じ要求番号・同じ内容の再送は同じ結果、内容が違えば 23505、別の要求番号での二重確定は ALREADY_ATTACHED。④別の発注書の予約・不明な予約は RESERVATION_INVALID、不明な発注書は P0002。⑤訂正は revision_no を最大＋1で追記し理由が必須、前の版が残り、変化なしは 22023、無効化は voided＝true の版で理由が必須、訂正で有効に戻せる。⑥差し替えは、予約の時に渡した差し替え元が予約の行に残り（確定の関数は差し替え元の引数を持たない）、確定が版1の replaces_attachment_id へ写して旧添付と旧版・予約の行は不変、保存が止まって頁を読み直しても詳細の pendingUploads の replacesAttachmentId から読め確定すると版1に残る、訂正の後も詳細の replacesAttachmentId は版1から読める、他の発注書の添付・不明な添付を差し替え元にした予約は REPLACEMENT_INVALID で予約も操作の記録も残らず（発注書が無い・権限が無いが先）、同じ要求番号でも差し替え元が違えば 23505、予約の replaces_attachment_id も UPDATE を断る。⑦検索は 取引日・金額の範囲（両端を含む）・取引先の部分一致（% _ \ を文字として扱い大小を区別しない）・発注書番号の前方一致・種類・組合せ（AND）、既定は最新の版、include_history で訂正前の値でも見つかり is_current＝false、並びと total と頁、18列で storage_path が無い、何も書かない。⑧関数経由でも既存の予約・添付・版は1文字も変わらず、3表は owner の UPDATE・DELETE・TRUNCATE も拒否、service_role は直接書けず版の表は読めず、anon／authenticated は何も読めない。⑨storage_path と保存キーが詳細にも検索にも出ない。⑩manage ＋ read の組・和集合・無効／期限切れ／役割なし／存在しない実行者、検索は read が無ければ GROUP_G_FORBIDDEN／42501（引数の確かめより先）。⑪引数（金額・通貨・日付・ハッシュ・大きさ・種類・取引先・理由）、途中失敗（版・添付・操作の記録に故障を注入）で全て戻り同じ要求番号で作り直せる、関数の形と ACL、書き手の一覧は65本、末尾の確かめ（検索の関数・書き手の関数・書く表の権限）が通り崩れを拾う |
| `group_g1_writer_inventory.integration.test.ts`（G-2 Task 8 で変更） | FREQ-540-AC-07 | 書き手の閉じた一覧の期待に `private.admin_reserve_purchase_order_attachment`・`private.admin_attach_purchase_order_document`・`private.admin_revise_purchase_order_document` を足し、62本を65本にした（走査の規則は緩めていない。`group_g2_purchase_create`・`group_g2_purchase_quantities`・`group_g2_purchase_receipts` の一覧の本数の期待も65本に合わせた） |
| `group_g1_writer_inventory.integration.test.ts`（G-2 Task 9 で変更） | FREQ-540-AC-08 | 走査する表に発注書の9表を足した（G-1 の7表と同じ規則。閉じた一覧は65本のまま）。①書込み関数9本は private の `SECURITY DEFINER`・`search_path` 空・走査が書き手と見つけて（空振りで通らない）閉じた一覧の中にあり、public の入口9本は同名 private へ委ねるだけの SQL INVOKER（何も書かず一覧に載らない）で、どちらも service_role だけが EXECUTE できる。②内部の道具4本と trigger 関数3本は誰も（service_role も）EXECUTE できず何も書かず、読取4本は本体も入口も service_role だけが EXECUTE できて何も書かない。③service_role が EXECUTE できる発注書の関数は26本だけ（同名の別の overload が増えれば見つかる）。④書込み本体9本は、呼び出し名を取り除いた後の `\b(from\|join\|into\|update)\s+(public\.)?(purchase_*\|item_variants\|stock_movements)` の最初の参照より前に `lock_group_g_purchase_orders(` を呼ぶ（各本体に表の参照が1つ以上あることも確かめて空振りで通らない）。⑤発注書の9表のそれぞれへ書く試験用の関数は未許可として見つかり、読むだけ・`FOR UPDATE` だけの関数は書き手にならない（取引は戻す） |
| `group_g2_concurrency.integration.test.ts`（G-2 Task 9） | FREQ-540-AC-08、FREQ-529-AC-03・AC-05 | 別接続（A・B・C）の並行。材料は先に commit し、待ちは `pg_blocking_pids` と `pg_locks`（待つ側の共通の鍵が granted = false）を**待っている間に**標本して確かめる。①9関数それぞれ: A が共通の鍵 `(190521,1)` だけを持つ → B が有効な入力で始める → B が鍵で待つ → C が対象の発注書・明細・variant・item・待ちの注文の行を `FOR UPDATE NOWAIT` で取れる（B は先に行の鍵を持っていない）→ A を放す → B が完了し、数量が保存則を満たす（作成は在庫・割当が動かず、受け取りは F＋A が受け取った数に等しく古い待ち注文から、取消は割当を外さず、書類は件数と版）。②受け取り対受け取り（未納5に3＋3を別キー）は片方だけ成功（在庫＋3・受取1件）、もう片方は `GROUP_G_PO_RECEIVE_EXCEEDS_REMAINING`（2本目が先の受け取りの版を読み直した再送の場合）か `GROUP_G_PO_VERSION_CONFLICT`（同じ画面の版の送信）で deadlock 0。2本を同時に待たせて放しても同じ（同時の2本は同じ画面の版なので `GROUP_G_PO_VERSION_CONFLICT`）。同じキーの同時2本は1回だけ実行され、2本目は `replayed`（受け取りも発注書の作成も）。③数量の訂正対受け取り、残りの打切り（`admin_short_close_purchase_order`）対受け取りは、同じ画面の版から送ると一方だけが通り、もう一方は `GROUP_G_PO_VERSION_CONFLICT`（どちらが先でも）。負けた方は在庫も数量・打切りも動かさない。④通常入荷（`admin_record_stock_movement`）対受け取りは、どの順でも在庫が合計し古い待ち注文から満たされる。⑤受け取り対入金（`mark_order_paid`）は二重に割り当たらず古い待ち注文が先。⑥受け取り対取消返金の受理（`record_order_refund_result`。返金を始める `begin_order_refund` だけでは割当は外れず、結果が受理された時に外れて在庫へ戻る）は、受理が先・受け取りが先・同時に待たせて放す、のどれでも空いた1点と受け取った1点が合計し、古い待ち注文だけが満たされる（最後の状態は同じ）。⑦variant の並びが逆の2つの発注書の受け取りは、続けても同時でも deadlock 0・二重に割り当たらない。⑧受け取りの取消（割当を外す入力・確認の数つき）対入金・FIFO（通常入荷）・棚卸減は、取消が先・相手が先・同時のどれでも、空き在庫が負にならず、同じ割当を二つの操作が外さず（`verify_stock_integrity` が空・割当の残りが範囲内）、F＋A＋H が保存則と合い、注文ごとの割当の合計は A に等しい。取消の戻りは外した数が確認の数のとおりで、相手の結果（FIFO の割当数・棚卸減の解除数）も決まった数。入金との組では残る割当が順で決まる（取消が先なら古い待ち注文1点と入金した注文1点、入金が先なら古い待ち注文2点。同時はそのどちらか）。deadlock は SQLSTATE 40P01 を返した接続が無いことで見る。材料は別接続から見えるように commit する（発注書・受取・注文は消せないので、他の試験は自分の id と相対の件数だけを見る。移行の末尾の確かめの「行が無い」も今の取引が書いた行だけを数える）。原本の予約・添付・版の表も追記専用で、原本の3関数の B も検査の後に commit する。材料はそのまま残す（トリガーは止めず、消す道具も持たない）ので、`group_g2_purchase_model`・`group_g2_purchase_documents` は表の全件の数や絞りの無い検索に頼らず、自分の発注書の id か発注書番号で絞って確かめる。残った材料があっても何度でも通る。後始末が失敗しても、試験の本来の失敗を隠さない（`tests/integration/db/helpers/with-cleanup.ts`） |
| `group_g2_migration_asserts.integration.test.ts`（G-2 Task 9） | FREQ-540-AC-08 | 移行2本の形（DB なし）: 名前の時刻の順（G-1 の末尾より後で基盤が先）、BOM・CR・全角空白・NBSP が無い、先頭の近くの `BEGIN;` と末尾の `COMMIT;` が各1つで直前に `NOTIFY pgrst`、節の印が1つずつこの順、`USAGE ON SCHEMA private` の文が無い、関数の本体の外のデータを変える文は基盤の置き場の1行だけ、確かめの節の失敗は全て `GROUP_G_MIGRATION_ASSERTION_FAILED`／55000 で `DETAIL` は項目名だけ、書き手の閉じた一覧が G-1 の56本＋新9本の65本で最後の確かめの固定の一覧と同じ並び（1本あたりの大きさの上限は置かない）。関数の本体の外のデータを変える文の確かめは、`DO` の本体の中や最上位の `INSERT INTO public.purchase_…`・`UPDATE`・`DELETE`・`TRUNCATE`・`COPY` も拾い、紛れ込ませた改変（`DO` の本体への `INSERT`、最上位の `UPDATE`）が見つかることも確かめる（基盤の置き場の1行の `INSERT INTO storage.buckets` だけを許す）。`DO` の本体はタグ付き `$tag$` だけを許し、タグ無しの `DO $$`・`DO LANGUAGE …`・`DO '…'` はデータを変える文を走査から隠せるので、別の確かめで 0 件にして、隠した改変（DO $$ に INSERT など）が見つかることも確かめる。この確かめの一覧（65本、移行が作る関数）は G-3 で書き手の一覧が増えたり関数が置き換わったら、`group_g2_migration_asserts`・`group_g2_purchase_model`・`group_g2_purchase_reads`・`group_g2_purchase_documents`・`group_g2_public_function_acl` の末尾の確かめを流し直す試験と一緒に更新する（各試験の冒頭に注意書きがある）。動き（DB あり）: 両ファイルの確かめの節を今の DB で流すと通る（流す側の `search_path` が違っても）。取引の中で、Task 1 の公開関数11本のそれぞれに anon／authenticated の EXECUTE を付け直す・PUBLIC を付ける・service_role を外す・関数を落とす、読取・書込みの関数を落とす・同名の別の overload を足す・service_role の EXECUTE を付け外しする・DEFINER／`search_path` を変える、置き換えた G-1 の関数の設定を変える、トリガーの名前を変える・止める、RLS を外す、この取引で行を書く（古い `created_at` の行なら通る）、置き場を公開にする、表の権限を変える（PostgreSQL 17 は `MAINTAIN`）、ロック helper の鍵の順を崩す、書き手の一覧を64本・66本・別の関数への入れ替えにする、のそれぞれで `GROUP_G_MIGRATION_ASSERTION_FAILED` が項目名つきで止まり、変更は戻る |
| `group_g2_purchase_model.integration.test.ts`・`group_g1_stock_api.integration.test.ts`（G-2 Task 9 で変更） | FREQ-530-AC-01、FREQ-540-AC-06 | 並行の試験が確定した材料（今日の日付の発注書、`stock_move` の割当解除）と重ならないよう材料だけを直した。モデルの試験の固定の発注番号は遠い日付（`PO-29991231-0001`）に、在庫の窓口の試験の「割当の解除の履歴」の問い合わせは自分の variant に絞った（期待は同じ）。さらに、並行の試験が確定した原本の予約・添付が残ることに合わせ、`group_g2_purchase_documents`・`group_g2_purchase_model` の件数と検索は、自分の発注書の id か発注書番号に絞った（service_role の直接の読み・書きの確かめの件数、検索の範囲・取引先・種類・履歴の試験。意味の期待は変えていない）。発注書番号の前方一致・種類のように他の発注書にも当たる検索は、1 頁の上限（100 件）に頼らず `total` まで頁をたどってから自分の発注書の行に絞る（残った行が何件あっても結果は変わらない）。`group_g2_g1_followups` の入金の試験は、後始末の失敗を本来の結果の確かめと混ぜない（取引を戻した後に放棄の解放を行い、その結果は `finally` の外で確かめる） |
| `group_g2_g1_followups.integration.test.ts`（G-2 Task 9 で変更） | FREQ-525-AC-03、FREQ-535-AC-01 | `mark_order_paid` の経路の試験は材料（支払い前の注文）を先に確定する物なので、終わった後に入金を戻し、その注文を放棄にして仮確保の1点を空き在庫へ戻す（`release_stock_for_unpaid_order`）。試験の後に仮確保を持つ注文を残さない。先絞りの発送済みの合計が引く列（発送の明細・返金の明細の `order_item_id`、注文の明細・返品・返金・取消申請の `order_id`、割当の `order_item_id`、結合の主キー、`orders.status`）に、先頭の列が全行を覆う索引があることを確かめる（索引は足さない） |
| `group_g2_postgrest_paths.integration.test.ts`（G-2 最終レビュー M3） | FREQ-525-AC-01、FREQ-526-AC-02・AC-04、FREQ-527-AC-01、FREQ-529-AC-01・AC-04、FREQ-530-AC-02、FREQ-540-AC-07 | 本物の store の関数（`purchase-order-store.ts`・`purchase-order-documents.ts`・`inventory-list-store.ts`）を、service_role の supabase-js から手元の Supabase の API（PostgREST）経由で1回ずつ通す。窓口の route は通らない。単体は `client.rpc` を差し替え、DB 結合は pg で関数を直に呼び、E2E は DB へ橋渡しするので、PostgREST を通る道（`uuid[]` の `_line_ids`・`date`・`jsonb`・`bigint`・STABLE の読取・誤りの形）はここだけが見る。通す順は 作成 → 詳細の読取 → 発注先の訂正（古い版は 409 `GROUP_G_PO_VERSION_CONFLICT` に分類される）→ 数量の確定 → 受け取り（空き在庫 3）→ 取消（空き在庫 2）→ 原本の予約 → 本物の署名つきの送り先へ PUT → 保存済みの確認 → 確定 → 訂正 → 署名つきリンクが同じファイルを返す → 書類検索（訂正前の版を条件で出し分ける）→ 在庫一覧表 → 発注一覧表 → 権限の無い実行者の読取は 403 → 残りの打切り。読取の戻りは JSON の往復の後、画面と同じ検査（`parsePurchaseOrderDetail`・`parsePurchaseOrderListRow`・`parsePurchaseOrderDocumentSearchRow`）に通る。要る環境変数は `DATABASE_URL`・`LOCAL_SUPABASE_URL`・`LOCAL_SUPABASE_SERVICE_ROLE_KEY`（API の住所は localhost／127.0.0.1 だけ。未設定なら理由を示して skip）。材料（実行者・商品）は試験ごとに新しく作り、発注書・受取・書類は追記専用なので残る（発注書は終わりに打ち切って閉じる）。鍵・署名つきの URL は出力しない |

### 単体・E2E

| テスト | 層 | 対応する受け入れ条件 | 確認する振る舞い |
| --- | --- | --- | --- |
| `tests/unit/lib/auth/admin-rbac.test.ts`（`authorizeAdminPermissions`） | 単体 | FREQ-540-AC-06 | 要るコードを全部持つ時だけ通し、有効な全ての役割の和集合で数える。403 の `permission` は足りない最初のコード（渡した並び順）。MFA（aal2）が無い時の本文は既存と同じで `permission` は先頭の要るコード。トークンの不通過は401、失効は401、確認不能は503、空の一覧は500。`authorizeAdminPermission` は `authorizeAdminPermissions([code])` と同じ結果 |
| `tests/unit/lib/auth/role-permission-catalog.test.ts` | 単体 | FREQ-540-AC-06 | 30コードの順・分野・ラベルは同じで、`upcoming`（準備中）は未使用の4コードだけ |
| `tests/unit/api/admin/item-variants-route.test.ts` | 単体 | FREQ-540-AC-06 | GET は `admin.stock.read`、POST は `admin.stock.manage` ＋ `admin.stock.read`。`items.read/manage` だけは GET・POST とも403（`permission` は stock 側）、`stock.read` だけは GET 200・POST 403、`stock.manage` だけは POST 403（`permission:'admin.stock.read'`）、両方で POST が進む。認可 → CSRF → IP → actor → 検証 → RPC の順は変えない |
| `tests/unit/components/ItemStockSection.test.tsx` | 単体 | FREQ-540-AC-06 | 読み込みの403は「在庫を見る権限がありません。」、記録の403は「在庫を変更する権限がありません。」を `role="alert"` で出し、Forbidden や一般の失敗の文は出さない。記録の403も本文の `reason` を先に見る（最終レビュー M2）: CSRF の失敗は「再読み込みして、もう一度」の文、MFA なしは「2要素認証が必要です」で、権限の文にしない。403 以外は今までの文のまま |
| `tests/unit/components/RolePermissionsSection.test.tsx`・`e2e/FR-ADMIN-109-permission-settings.spec.ts` | 単体・E2E | FREQ-540-AC-06 | 権限画面の「準備中」の印が4件になった（G-0 では9件） |
| `tests/unit/lib/inventory/inventory-list.test.ts` | 単体 | FREQ-525-AC-01、FREQ-540-AC-07 | `calcRequiredQuantity`（5・2・1 → 2、在庫と発注済みが多い時と全部0の時は0で負にならない）。store `listAdminInventory` は RPC を `list_admin_inventory` ＋ `{ _actor_id }` で1回だけ呼び、列を画面の形へ写し、DB の並びを変えない。`onHand` が空き＋入金済みの割当＋仮確保と違う・`required` が式と違う・負・小数・文字列・上限超え・`variant_id` が0や文字列・型の崩れ・重複・配列でない応答は `INVENTORY_READ_FAILED`。DB の `GROUP_G_FORBIDDEN`＋42501 の組だけが 403 の `AdminInventoryError`（片方だけの一致は信用しない）。通信の失敗・他の誤りは固定の文で、生の文も `cause` も持ち出さない |
| `tests/unit/api/admin/inventory-route.test.ts` | 単体 | FREQ-525-AC-01・AC-02、FREQ-540-AC-07 | `GET /api/admin/inventory`: `admin.stock.read` で認可し `authz.userId` を実行者として RPC を1回だけ呼び、200 `{ rows }`・`Cache-Control: no-store`。`backfill_item_variants` は呼ばない。`stock.read` だけで200、`items.*` だけ・`stock.manage` だけ・権限なしは403で RPC を呼ばない。認可の401／403（MFA の `reason`）／503 は状態・本文・`Retry-After` を保って no-store。DB の権限の拒否は 403 の固定の文、RPC の誤り・応答の崩れ・クライアントの失敗は固定の 500 で、本文にもログ（固定の1文）にも生の誤りを出さない |
| `tests/unit/lib/admin/admin-load-failure.test.ts` | 単体 | FREQ-525-AC-01、FREQ-540-AC-07 | `adminLoadFailureMessage`: 本文の `reason: 'MFA required'` →「2要素認証が必要です」（状態の番号より先）、401 →「ログインし直してください。」、403 → 呼び出し側が渡した権限の文、それ以外 → 失敗の文。本文が読めない形（null・文字列・数・配列・`reason` が文字列でない）でも MFA とは見なさない |
| `tests/unit/components/AdminInventorySection.test.tsx` | 単体 | FREQ-525-AC-01・AC-02、FREQ-540-AC-07 | h1「在庫一覧表」・「管理画面に戻る」(/admin)・読込中（`role="status"`）。列見出しは「商品名・色・サイズ・注文数・在庫・発注済み・発注必要数」の7つがこの順で、行は7つのセルを同じ順に持つ。色・サイズが無ければ「—」で、止めた variant も同じ7つのセルの行で出る（特別な印は付けない）。「在庫の内訳」ボタン（行ごとの `aria-expanded`）で「空き ○・入金済みの割当 ○・支払い前の仮確保 ○」を開閉し、Enter・Space でも開け、行は押しても何も起きない。表は見出しを保ったスクロール領域（`overflow-auto`・`max-w-full`・`sticky` の見出し）。空は「表示する商品がありません。」だけ。403 →「在庫一覧を見る権限がありません。」、MFA なしの403 →「2要素認証が必要です」、401 →「ログインし直してください。」、その他・通信失敗・応答の崩れ →「在庫一覧を読み込めませんでした。時間をおいて再度お試しください。」を `role="alert"` で出し、表とボタンを出さない |
| `tests/unit/components/AdminSettingsMenu.test.tsx`・`e2e/FR-ADMIN-029-accounting-tab.spec.ts`（G-2 で変更） | 単体・E2E | FREQ-525-AC-01 | 店長のタブは ORDER の次に INVENTORY が並ぶ（… ORDER・INVENTORY・SETTINGS）。サポートの人のメニューは ORDER と INVENTORY で、SETTINGS と「権限」は出ない（G-1 までは ORDER だけだった）。INVENTORY を押すと `nav`「在庫・発注メニュー」に「在庫一覧表」(/admin/inventory)・「発注一覧表」(/admin/purchase-orders) のリンクが並び、店長もサポーターも同じ中身。`tab=INVENTORY` で直接開ける（サポーターが先頭以外のタブを `tab` で指しても ORDER に戻されない）。INVENTORY の外では出ない。FR-ADMIN-029 の期待は同じ並びに直した |
| `tests/unit/components/ItemStockSection.test.tsx`（G-2 Task 3 で追加） | 単体 | FREQ-540-AC-06 | 読み込みの失敗の文を `adminLoadFailureMessage` へ切り替えた: MFA なしの403は「2要素認証が必要です」（「権限がありません」と誤って出さない）、401は「ログインし直してください。」、本文が JSON でない403・500でも権限の文・取得失敗の文に落ちる |
| `tests/unit/docs/delivery-status-traceability.test.ts`・`tests/unit/docs/order-status-traceability.test.ts`（G-2 Task 3 で変更） | 単体（文書） | FREQ-540-AC-07 | FREQ-540 の G-2 の追加 AC（`G2_FREQ_540_ADDITIONS`）に AC-07 を足した（G-1 の AC-01〜05 は先頭に固定のまま）。新しい route `GET /api/admin/inventory` に合わせて、Route Handler の数を 133 ファイル・172 メソッド（E2E 用の入口を除く表は 132 行・171 メソッド）に直した |
| `tests/unit/lib/purchase-orders/purchase-order-types.test.ts` | 単体 | FREQ-526-AC-01・AC-02 | 値の範囲（行 1〜100・仮数量 1〜99999・発注先 1〜100・メモ 0〜500）、保存する段階2つと表示する段階5つの文（数量確定待ち／数量確定済み・受け取り待ち／一部受け取り済み／受け取り完了／完了（残りを打ち切り））、DB エラー表（message → [SQLSTATE, 状態, 本文]。入力・権限・同じ要求番号で別の内容の3つ）、通知の文と、発注書の頁へ渡す目印（`created=1`）、発注数量の入力が正の整数（1〜99999。小数・負・100000・先頭の0・指数・空白つきは不可）か、失敗の文の順（表の code → MFA → 401 → 403 → 400 → その他。表に無い code の本文は出さない） |
| `tests/unit/lib/purchase-orders/purchase-order-store.test.ts` | 単体 | FREQ-526-AC-02・AC-03 | `createPurchaseOrder` は RPC `admin_create_purchase_order` を引数名どおり・実行者つきで1回だけ呼び（メモ無しは null、明細は variantId と quantity だけ）、再送（`replayed: true`）をそのまま返す。DB の誤りは message と SQLSTATE が両方そろい表と完全に一致した時だけ `PurchaseOrderError`（表の状態・固定の本文）にし、片方だけの一致・継承した名前・前後に余分な文字・未知・通信の失敗は 500 の固定の文で、生の文も `cause` も持ち出さない。戻り値は id（uuid）・number（`PO-yyyymmdd-nnnn`）・version（1以上の整数）・replayed（真偽値）を検査し、崩れていれば成功として返さず、返すのは4項目だけ。`PurchaseOrderError` は表にある code なら表の本文と code を持ち、表に無い code（継承した名前の `toString`・`__proto__`・空文字を含む）でも落ちずに code 無しの固定の失敗の文になる |
| `tests/unit/api/admin/purchase-orders-route.test.ts` | 単体 | FREQ-526-AC-02・AC-03、FREQ-540-AC-07 | `POST /api/admin/purchase-orders`: 認可 `admin.purchase_orders.manage` ＋ `read`（足りない最初の権限が403の `permission`。`items.*` だけ・片方だけ・在庫と受け取りだけは403で CSRF・制限・RPC・監査に進まない）→ CSRF → IP の回数制限 → actor の回数制限（`admin.purchase_orders.create` の30回/600秒）→ 検証 → RPC → 監査の順。実行者は認可結果の `userId` だけ（本文の `actorId` は読まない）。成功は201 `{ id, number, version, replayed }`・no-store、再送も201。検証（発注先・メモ・明細の件数・variantId の重複・数量の範囲と型・requestKey）の誤りは400 `details` つきで RPC を呼ばない。DB の3つの誤りは表の状態と本文を `{ code, error }` で返し、監査は `failure`＋結果コードだけ。未知の誤り・戻り値の崩れ・想定外の throw・クライアントの失敗は固定の500で、本文・監査・ログ（名前と code だけ）に生の誤りを出さない。監査 `admin.purchase_orders.confirm` の metadata は件数・再送かどうか・結果コードだけ（発注先・メモ・要求番号を含めない）。認可・CSRF・回数制限の拒否はそのまま返す。メモは前後の空白を落としてから長さ（500字）を見て渡し（DB と同じ数え方）、空白だけは null |
| `tests/unit/components/AdminInventorySection.test.tsx`（G-2 Task 4 で追加） | 単体 | FREQ-526-AC-01・AC-02・AC-03、FREQ-540-AC-07 | 「発注」で発注モードに入り、各行に空欄の「発注数量」入力（`aria-label` は「商品名 色 サイズ の発注数量」、色・サイズが無ければ省く）が出て、発注必要数の列は見えたまま。入る前は入力も「発注書確認」も出ない。「発注書確認」は 1〜99999 の整数が1行以上ある時だけ押せる（0・負・小数・100000 は不可）。入れた数量は在庫の内訳の開閉で消えず、「キャンセル」で抜けて入れ直すと空欄から。確認の段は h2「発注書の確認」で、正の整数の行だけを表に並べ（色・サイズが無ければ「—」）、発注先（必須・`maxlength` 100）とメモ（`maxlength` 500）があり、納期の欄は無い。「戻る」で数量が残る。発注先が空・空白だけは「発注先を入力してください。」で通信しない。確定は `/api/admin/purchase-orders` へ POST（発注先は前後の空白を落とし、メモが空なら項目ごと送らず、明細は画面の並びの variantId と quantity、requestKey は uuid）、成功したら `/admin/purchase-orders/<id>?created=1` へ移る（通知はこの部品に出さない。移動先の頁が出す。Task 5 で実装し、下の発注書の頁・画面の行で確かめる）。送信中は「発注確定」を押せず二重に押しても通信は1回。通信の失敗・500・読めない201の後の再押下は同じ requestKey と本文で、内容（メモ・数量）を変えるか4xx の後は新しい requestKey。403 は「発注を扱う権限がありません。」、MFA なしの403 は「2要素認証が必要です」、DB の誤りは表の本文、400（英語の検証の文）は「入力を確かめてください。」 |
| `tests/unit/docs/delivery-status-traceability.test.ts`・`tests/unit/docs/order-status-traceability.test.ts`（G-2 Task 4 で変更） | 単体（文書） | FREQ-526-AC-02 | 新しい route `POST /api/admin/purchase-orders` に合わせて、Route Handler の数を 134 ファイル・173 メソッド（E2E 用の入口を除く表は 133 行・172 メソッド）に直した |
| `tests/unit/docs/delivery-status-traceability.test.ts`・`tests/unit/docs/order-status-traceability.test.ts`（G-2 Task 6 で変更） | 単体（文書） | FREQ-527-AC-01、FREQ-528-AC-01 | 新しい route `PATCH /api/admin/purchase-orders/[id]`（既存の route.ts に PATCH を足した）と `POST …/quantities`・`POST …/short-closures`（新しい route.ts 2つ）に合わせて、Route Handler の数を 137 ファイル・178 メソッド（E2E 用の入口を除く表は 136 行・177 メソッド）に直した |
| `tests/unit/docs/delivery-status-traceability.test.ts`・`tests/unit/docs/order-status-traceability.test.ts`（G-2 Task 5 で変更） | 単体（文書） | FREQ-526-AC-04・AC-05 | 新しい route `GET /api/admin/purchase-orders`（既存の route.ts に GET を足した）と `GET /api/admin/purchase-orders/[id]`（新しい route.ts）に合わせて、Route Handler の数を 135 ファイル・175 メソッド（E2E 用の入口を除く表は 134 行・174 メソッド）に直した |
| `group_g1_writer_inventory.integration.test.ts`・`group_g2_purchase_create.integration.test.ts`（G-2 Task 6 で変更） | DB 結合・静的 | FREQ-526-AC-02、FREQ-540-AC-07 | 書き手の閉じた一覧の期待に Task 6 の3本（`admin_update_purchase_order_header`・`admin_confirm_purchase_order_quantities`・`admin_short_close_purchase_order`）を足して57本を60本にし、発注の作成の試験の静的な確かめ（書き手の一覧と末尾の確かめの数）も60本にした。走査の規則は緩めていない |
| `group_g2_inventory_list.integration.test.ts`（G-2 Task 6 で変更） | DB 結合 | FREQ-525-AC-02 | 発注済み・打切り後の発注必要数の試験（④）の発注書・数量の確定・打切りを、直接の INSERT / UPDATE でなく Task 4・6 の関数で作るようにした（納品数だけは受取の関数が無いので材料のまま）。期待は同じ |
| `tests/unit/lib/purchase-orders/purchase-order-store.test.ts`（G-2 Task 6 で追加） | 単体 | FREQ-527-AC-01、FREQ-528-AC-01 | `updatePurchaseOrderHeader`・`confirmPurchaseOrderQuantities`・`shortClosePurchaseOrder` は RPC を引数名どおり・実行者つきで1回だけ呼び（メモ・理由の null、明細は lineId・quantity・unitPriceYen の3項目だけで単価 0 と null を区別して渡す）、再送（`replayed: true`）をそのまま返し、戻りは決まった項目だけ。DB エラー表の全てを message と SQLSTATE が両方そろった時だけ分類し、不一致・未知・通信の失敗・戻り値の型の崩れは固定の文の500で生の文を出さない |
| `tests/unit/lib/purchase-orders/purchase-order-types.test.ts`（G-2 Task 6 で追加） | 単体 | FREQ-527-AC-01 | DB エラー表の Task 6 の5つ（見つからない・版の競合・理由が要る・納品済み未満・打ち切る未納がない）の SQLSTATE・状態・本文、操作のボタンと成功の通知の文（数量確定・発注を取り消す・数量を訂正・発注先・メモを訂正・残りを打ち切る・未納のある行をすべて選ぶ、数量を確定しました。など）、失敗の文の関数が作成と同じであること |
| `tests/unit/lib/purchase-orders/purchase-order-types.test.ts`（G-2 Task 7 で追加） | 単体 | FREQ-529-AC-01・AC-04、FREQ-540-AC-07 | DB エラー表の Task 7 の6つ（通知の文・受取日・取り消せる数・在庫不足・数量確定前・未納超過、外す割当の確認）の SQLSTATE・状態・本文、受け取りの固定の文（ボタン・見出し・説明・通知）、権限の文が画面ごとに替わること（発注／受け取り）、失敗の文の順（表の本文 → CSRF → MFA → 401 → 403 → 400 → その他）、CSRF の拒否は「権限」と言わないこと、409 の本文から外す点数を取り出す規則、日本時間の日付と日付の実在の確かめ |
| `tests/unit/api/admin/purchase-order-header-route.test.ts` | 単体 | FREQ-527-AC-01・AC-02、FREQ-540-AC-07 | `PATCH /api/admin/purchase-orders/[id]`: 認可 manage ＋ read（`items.*` だけ・片方だけは403）、順（認可 → CSRF → IP の回数制限 → actor の回数制限 → 検証 → RPC → 監査）、回数制限 `admin.purchase_orders.header.update` 30回/600秒、200 `{ version, replayed }`・no-store、実行者は認可結果の userId だけ、発注先・メモの空白、検証 400（版・発注先・メモ・理由・requestKey・id）で監査は `INVALID_REQUEST` と id が不正なら `resource_id: null`、DB の誤りの表（版の競合409・理由400・見つからない404 ほか）、未知の誤りは生の文を出さない500 |
| `tests/unit/api/admin/purchase-order-quantities-route.test.ts` | 単体 | FREQ-527-AC-01・AC-02、FREQ-540-AC-07 | `POST /api/admin/purchase-orders/[id]/quantities`: 上と同じ認可・順・no-store、回数制限 `admin.purchase_orders.quantity.confirm` 60回/600秒、201 `{ version, changedLines, replayed }`、単価 0 と null の区別・理由が省ける、検証 400（行の数・重複・数量や単価の範囲と型・単価の項目の省略・理由の長さ）、監査は id・行数・変えた行数・再送だけ、納品済み未満の409ほか表の全て |
| `tests/unit/api/admin/purchase-order-short-closures-route.test.ts` | 単体 | FREQ-528-AC-01・AC-02、FREQ-540-AC-07 | `POST /api/admin/purchase-orders/[id]/short-closures`: 上と同じ認可・順・no-store、回数制限 `admin.purchase_orders.short_close` 30回/600秒、201 `{ version, closedQuantity, replayed }`、検証 400（lineIds の数・重複・形、理由が必須）、監査は id・行数・打ち切った数・再送だけ、打ち切る未納がないの409ほか表の全て |
| `tests/unit/components/PurchaseOrderQuantityDialog.test.tsx` | 単体 | FREQ-527-AC-01・AC-02 | 見出し「数量の確定」「数量の訂正」、行ごとの「数量」「単価（円）」の初期値（仮数量／確定数量・登録済みの単価）、説明「未入力は「単価未登録」、0 は 0 円として保存します。」、理由は確定で任意・訂正で必須、納品済み未満の行の下の文と送れないこと、範囲外の入力を送れないこと、POST の本文（版・全行・理由・requestKey、単価の空欄は null）、成功の通知、送信中は閉じず二重に押しても1回、通信の失敗の後の再押下は同じ requestKey と本文（読み直しで版が進んでも最初の版）、内容を変えると新しい requestKey、4xx の後も新しい requestKey、版の競合は本文を出して `onStale`・開いたまま入力を保って読み直した版で送る |
| `tests/unit/components/PurchaseOrderShortCloseDialog.test.tsx` | 単体 | FREQ-528-AC-01・AC-02 | 見出し「残りを打ち切る」と選んだ行の「未納 ${n} → 0」、説明、理由が必須、ボタン「打ち切る」「戻る」、POST の本文（版・選んだ行・理由・requestKey）と通知「残りを打ち切りました。」。取消モードは見出し「発注の取消」・説明・ボタン「取り消す」で、発注書の全行を渡して通知「発注を取り消しました。」。送信中・再送・版の競合は数量のダイアログと同じ |
| `tests/unit/components/PurchaseOrderDetailSection.test.tsx`（G-2 Task 6 で追加） | 単体 | FREQ-527-AC-01・AC-02、FREQ-528-AC-01・AC-02 | 段階ごとのボタン（数量確定待ち「数量確定」「発注を取り消す」、確定後「数量を訂正」「未納のある行をすべて選ぶ」、いつでも「発注先・メモを訂正」）、未納のある行だけのチェック欄（表の列とセルの文字は変えない）、選ぶと「残りを打ち切る」が出ること、各ダイアログを開く・閉じる、成功で通知（作成の通知と入れ替わり `role="status"` は1つ）・選びを解いて発注書を読み直す、版の競合で読み直してダイアログと入力を保つこと、読み直しの失敗で今の表示を消さないこと、発注先・メモの訂正の PATCH、履歴の「変更」は値が変わった項目だけ（単価だけの訂正で数量を出さない） |
| `tests/unit/components/PurchaseOrderDetailSection.test.tsx`（G-2 Task 7 で追加） | 単体 | FREQ-529-AC-01・AC-04 | 数量確定後で未納のある行がある時だけ「全部受け取る」「一部を受け取る」（数量確定前・未納が全て0では出さない）、各ダイアログを開く・閉じる、受け取りの成功で通知（`role="status"` は1つ）・ダイアログを閉じて発注書を読み直す、受け取りの履歴の、種類が受け取りで取り消せる数が残る受取にだけ「この受け取りを取り消す」「数量を訂正」（名前は受取の日付つき。頁の「数量を訂正」は1つだけ）、取消・訂正のダイアログを開く・閉じる、取消の成功（`/receipts/[receiptId]/reversals` への POST）、確認の段を経て訂正が成功、読み直しで取り消せる数が無くなった受取のダイアログを閉じること、既存の履歴の表示が変わらないこと、受取ごとに「実行者 ${メールアドレス}」（アカウントが無ければ「実行者 —」）を出すこと |
| `tests/unit/lib/purchase-orders/purchase-order-types.test.ts`（G-2 Task 5 で追加） | 単体 | FREQ-526-AC-01・AC-04・AC-05 | 発注一覧表・発注書の詳細の固定の文（「発注一覧表」「発注書はまだありません。」「発注一覧を見る権限がありません。」「数量未確定」「発注書が見つかりません。」「単価未登録」「証憑未添付」「税の扱いは書類に従います」）。`parsePurchaseOrderDetail` は確定済み・確定前の発注書をそのままの形で返し、知らない項目（保存先の鍵・操作の ID）を落とし、形の崩れ（uuid・番号・メモ・未知の保存段階・未知の表示段階・保存段階と表示段階の矛盾・版0・日時・数量の負や小数や文字列・確定数量と未納の食い違い・単価の負・履歴の種類や版・受け取りの種類や日付・受取行の数量0や相殺の元の食い違いや取り消せる数の超過・書類の種類や sha256 や大きさや `current` の欠落・予約の型・旗の欠落や型・見込額の負や小数）の50件超を `PURCHASE_ORDER_READ_FAILED` にする。`parsePurchaseOrderListRow`（数量確定前の行を含む）。発注日は日本時間（協定世界時の15時以降は翌日）の `YYYY/MM/DD`、日時は `YYYY/MM/DD HH:mm`、金額は `¥1,200`。目印 `created=1` を見るのは値がちょうど "1" の時だけ（無い・別の値・複数は偽） |
| `tests/unit/lib/purchase-orders/purchase-order-store.test.ts`（G-2 Task 5 で追加） | 単体 | FREQ-526-AC-04・AC-05、FREQ-540-AC-07 | `listAdminPurchaseOrderLines` は RPC `list_admin_purchase_order_lines` を `_limit`・`_offset`（(page − 1) × limit）・`_actor_id` で1回だけ呼び、camelCase の行と全明細数を返す（余分な列は落とす）。`getAdminPurchaseOrder` は RPC `get_admin_purchase_order` を発注書の id と実行者で1回だけ呼び、検査した詳細を返し、無ければ null。権限の拒否は message と SQLSTATE（`GROUP_G_FORBIDDEN`＋42501）が完全に一致した時だけ 403 の `PurchaseOrderError`、片方だけの一致・前後に余分な文字・別の誤り・通信の失敗は `PURCHASE_ORDER_READ_FAILED` で、生の文も `cause` も持たない。応答の崩れ（配列でない・total が文字列や負や行数より小さい・行ごとに total が違う・同じ明細が2回・未知の段階・未納の食い違い・番号の形・別の発注書が返った）は成功にしない |
| `tests/unit/lib/purchase-orders/purchase-order-store.test.ts`（G-2 Task 7 で追加） | 単体 | FREQ-529-AC-01・AC-02・AC-04 | `receivePurchaseOrder`・`reversePurchaseOrderReceipt` は RPC `admin_receive_purchase_order`・`admin_reverse_purchase_order_receipt` を引数名どおり・実行者つきで1回だけ呼び、DB の戻りを決まった項目だけで返す（再送は `replayed: true`）。DB の誤りは message と SQLSTATE が両方そろった時だけ表の状態・本文（権限は受け取り用の文）の `PurchaseOrderError`、外す割当の確認は DETAIL の `{"releasedQuantity": n}` のキー1つだけを解釈して `releasedQuantity` を持たせ、崩れた DETAIL・別の SQLSTATE は固定の500。未知・不一致・通信の失敗・戻り値の型の崩れは固定の500で生の文を持たない |
| `tests/unit/api/admin/purchase-orders-route.test.ts`（G-2 Task 5 で `GET` を追加） | 単体 | FREQ-526-AC-04、FREQ-540-AC-07 | `GET /api/admin/purchase-orders`: 認可 `admin.purchase_orders.read` だけ（manage は要らない）で RPC を実行者つきで1回、200 `{ rows, total, page, limit }`・no-store（既定は limit=20・page=1）。offset は (page − 1) × limit（page=100000・limit=100 でも整数に収まる）。limit と page の範囲外・数でない指定（0・101・負・小数・空・空白・指数・桁あふれ）は400で RPC を呼ばない。`items.*` だけ・manage だけ・在庫の権限だけ・権限なしは403（`permission:'admin.purchase_orders.read'`）、認可の401／403（MFA）／503 は状態・本文・`Retry-After` を保って no-store。認可が先で、範囲外の指定でも認可の拒否が先に返る。DB の権限の拒否は403の固定の文と code、RPC の誤り・応答の崩れ・クライアントの失敗は固定の500で、本文にもログ（固定の1文）にも生の誤りを出さない。CSRF・回数制限・監査には進まない |
| `tests/unit/api/admin/purchase-order-detail-route.test.ts` | 単体 | FREQ-526-AC-05、FREQ-540-AC-07 | `GET /api/admin/purchase-orders/[id]`: 認可 `admin.purchase_orders.read` だけで RPC を発注書の id と実行者で1回、200 `{ purchaseOrder }`・no-store。保存先の鍵など DB の余分な項目は出さない。id が uuid でなければ400（認可の後）で RPC を呼ばない。無い発注書は404 `{ error: '発注書が見つかりません。' }`。`items.*` だけ・manage だけ・権限なしは403、認可の401／403（MFA）／503 はそのまま。DB の権限の拒否は403の固定の文と code、RPC の誤り・応答の崩れ・クライアントの失敗は固定の500で生の誤りを出さない |
| `tests/unit/components/PurchaseOrderListSection.test.tsx`・`PurchaseOrderListPage.test.tsx` | 単体 | FREQ-526-AC-04、FREQ-540-AC-07 | h1「発注一覧表」とリンク「取引書類を検索」(`/admin/purchase-orders/documents`)・「在庫一覧表」(`/admin/inventory`)・「管理画面に戻る」(`/admin`)。窓口を `?limit=20&page=1` で no-store に1回読む。列は「発注書番号・商品名・色・サイズ・発注数量・納品済み・未納」の7つだけがこの順（「打切り」は無い）、発注書番号は `/admin/purchase-orders/[id]` へのリンク、数量確定前の行は「発注数量」「未納」が「数量未確定」（納品済みは 0）、色・サイズが無ければ「—」、APIの並びのまま。頁送りは「前へ」「次へ」と「1〜20 / 45」の形（最初の頁で前へ、最後の頁で次へが押せない。次の頁の失敗は失敗の文）。空は「発注書はまだありません。」、403 は「発注一覧を見る権限がありません。」、MFA なしの403は「2要素認証が必要です」、401 は「ログインし直してください。」、500・応答が読めない・形の崩れ・total 欠落・通信失敗は「発注一覧を読み込めませんでした。時間をおいて再度お試しください。」を `role="alert"` で出し、表も頁送りも出さない。表は見出しを保ったスクロール領域（`overflow-auto`・`max-w-full`・`sticky` の見出し・`min-w-0` の親）。頁は `main` に部品を置く |
| `tests/unit/components/PurchaseOrderDetailSection.test.tsx`・`PurchaseOrderDetailPage.test.tsx` | 単体 | FREQ-526-AC-01・AC-05、FREQ-540-AC-07 | h1「発注書 ${番号}」・「発注一覧表に戻る」。窓口を発注書の id で no-store に1回読む。発注先・メモ（無ければ「—」）・発注日（日本時間 `YYYY/MM/DD`）・段階の日本語5つ。明細の表は8列を `line_no` 順（単価が無ければ「未登録」、あれば `1,200`、数量確定前の行は「数量未確定」）。数量確定後だけ「単価未登録」「証憑未添付」のバッジ（旗が真の時）と「発注見込額 ¥6,000」「税の扱いは書類に従います」。見込額が NULL なら出さず、数量確定前（ordered）は旗や見込額が入っていても出さない。h2「数量の履歴」「受け取りの履歴」「取引書類」と、履歴の表・受け取り（取消は負の数量と理由、無ければ「受け取りの記録はありません。」）。「取引書類」は見出しだけ（書類や予約があってもファイル名・無効の印・一覧は出さない。Task 8 が足す）。作成の通知: `?created=1`（頁）／`created`（部品）がある時だけ、読み込んだ発注書の番号で「発注書 ○○ を作成しました。数量が確定するまで受け取りはできません。」を `role="status"` で出し（番号は props でなく読んだ物）、目印が無い・別の値・空・複数・別の名前の時と、404・403・401・500・形の崩れの時は出さない。404 は「発注書が見つかりません。」、403 は「発注書を見る権限がありません。」、MFA なしの403は「2要素認証が必要です」、401 は「ログインし直してください。」、それ以外・応答の崩れ・別の発注書が返った・通信失敗は「発注書を読み込めませんでした。時間をおいて再度お試しください。」を `role="alert"` で出す。表は見出しを保ったスクロール領域。id は URL に使える形にして渡す |
| `tests/unit/api/admin/purchase-order-receipts-route.test.ts`（G-2 Task 7） | 単体 | FREQ-529-AC-01・AC-02、FREQ-540-AC-07 | `POST /api/admin/purchase-orders/[id]/receipts`: 認可は `admin.receiving.manage` ＋ `admin.purchase_orders.read`（片方だけ・`purchase_orders.manage` と在庫の権限だけは403）、順（認可 → CSRF → IP の回数制限 → actor の回数制限 → 検証 → RPC → 監査）、回数制限 `admin.purchase_orders.receive` 60回/600秒、201 `{ receiptId, version, allocatedQuantity, replayed }`・no-store、実行者は認可結果の userId だけ、メモの空白（空白だけは null）、検証 400（版・受取日の形と実在・メモの長さ・行の数と重複・数量の範囲と型・requestKey・id）で監査は `INVALID_REQUEST` だけ、DB の誤りは表の状態と本文（権限は「受け取りを記録する権限がありません。」）、未知の誤りと型の崩れは固定の500で生の文を出さない、監査は id・行数・割り当てた数・再送だけ |
| `tests/unit/api/admin/purchase-order-receipt-reversals-route.test.ts`（G-2 Task 7） | 単体 | FREQ-529-AC-04・AC-05、FREQ-540-AC-07 | `POST /api/admin/purchase-orders/[id]/receipts/[receiptId]/reversals`: 上と同じ認可・順・no-store、回数制限 `admin.purchase_orders.receipt.reverse` 30回/600秒、201 `{ receiptId, version, releasedQuantity, replayed }`、確認の数が無ければ null・0 も渡す、外す割当の確認は 409 `{ code: GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED, error, releasedQuantity }`（DETAIL が `{"releasedQuantity": n}` のキー1つの時だけ。崩れていれば固定の500）、検証 400（行・理由・確認の数の範囲・id と受取の id が uuid でない）、取り消せる数の超過と在庫不足の409ほか表の全て、監査は id・行数・外した点数・再送だけ |
| `tests/unit/components/PurchaseOrderReceiveDialog.test.tsx`（G-2 Task 7） | 単体 | FREQ-529-AC-01・AC-02、FREQ-540-AC-07 | 見出し「全部を受け取る」「一部を受け取る」、説明の文、表の7列、未納のある行だけ、全部の「今回受け取った数」が未納で読み取り専用、一部は空欄から始まり空欄の行は受け取らない、未納超過・0・負・小数の行の下の文、受取日の初期値（今日・日本時間）と範囲（発注日〜今日）と範囲外の文、POST の本文（版・受取日・メモ・行・requestKey。メモが空なら省く）、成功の通知、送信中は閉じず二重に押しても1回、通信の失敗・5xx・読めない成功の後の再押下は同じ requestKey と本文、内容を変えると新しい requestKey、4xx の後も新しい requestKey、権限の拒否は受け取り用の文・CSRF の拒否は再読み込みの文、版の競合は本文を出して `onStale` を呼び入力を保つ |
| `tests/unit/components/PurchaseOrderReceiptReverseDialog.test.tsx`（G-2 Task 7） | 単体 | FREQ-529-AC-04・AC-05 | 見出し「受け取りの取消」「受け取り数量の訂正」、説明の文、取り消せる数が残る行だけ、取消は「取り消す数」が取り消せる数ぜんぶで読み取り専用、訂正は空欄から始まり超過・0・負・小数の行の下の文、理由が必須、POST の本文（版・行・理由・requestKey。最初は確認の数なし）、成功の通知。確認の段（取消・訂正の両方）: 409 で見出しはそのまま本文「割り当て済みの品を○点外し、受注生産中に戻します。」を `role="status"` で出し行の数は変えられない、確認の後は新しい requestKey と `expectedReleaseQuantity` で送る、数が変わっていれば出し直す、点数が 0 になっていたら確認の段を出さず確認の数なしの新しい要求で送り直す、確認の後の通信の失敗・5xx は同じ requestKey と本文で再送、「戻る」で入力の段に戻る、理由が空なら「理由を入力してください。」で送らない、在庫不足の断りで入力と確認の段を保つ。送信中は閉じない・版の競合・権限と CSRF の文 |
| `tests/unit/lib/purchase-orders/purchase-order-documents.test.ts`（G-2 Task 8） | 単体 | FREQ-530-AC-02・AC-03、FREQ-540-AC-07 | 置き場と DB の結び付け。`inspectDocumentBytes`（拡張子・先頭のバイト・置き場が記録した種類・20 MiB ちょうどと超過・空・SHA-256）、`reservePurchaseOrderDocument`（DB の後に上書きできない形の署名つきの送り先、差し替え元を DB の予約へ渡す、置き場の失敗は 503 で予約は残る、DB の誤りの分類〔差し替え元の誤りを含む〕、戻りの崩れ）、`issueDocumentUploadUrl`（最初に `get_admin_purchase_order` を実行者つきで呼び 42501→403・NULL→404、予約の不一致・添付済みは 409、置き場の保存済みはオブジェクト名の完全一致だけで前だけ一致する別名は「ない」、呼ぶ順）、`attachPurchaseOrderDocument`（読み戻し → 検査 → DB の順、差し替え元を DB の関数へ渡さない、ブラウザのハッシュの一致で browser・null で server、不一致は 422、置き場にまだ無いは 409、種類・大きさの不一致は 422、置き場の不調は 503）、`revisePurchaseOrderDocument`、`createPurchaseOrderDocumentUrl`（先に読取権限を DB で確かめる、60秒、ダウンロードは原ファイル名つき、置き場に無ければ 404）、`searchPurchaseOrderDocuments`（条件・50件・オフセット、行の検査、権限の拒否は 403）。誤りと戻りに署名つきの送り先・保存キー・本文が無いこと |
| `tests/unit/lib/purchase-orders/purchase-order-documents-client.test.ts`（G-2 Task 8） | 単体 | FREQ-530-AC-02・AC-03 | ブラウザの道具。ファイルの確かめ（拡張子・ブラウザの種類・先頭のバイト〔PDF・JPEG・PNG の印。名前だけ付け替えた中身違いを置き場に置く前に断る〕・20 MiB・空、続きから保存で選び直したファイルは予約の種類の中身か）、`uploadPurchaseOrderDocument` の順（確かめ → ハッシュ → 予約〔差し替え元を渡す〕→ PUT → 確定〔差し替え元は載せない〕）、予約を取れなかった後の送り直しは同じ要求番号・予約できた後と確定した断りの後は新しい番号（G-2 Task 9: 予約の応答を失って残した番号は、同じ発注書・ファイル名の予約が続きから保存で終わった〔確定できた・rejected〕時と、送り先を出す窓口が予約は無い・使われたと断った〔404・409〕時に忘れ、終わっていない間〔pending・選び直し待ち〕や窓口が一時的に失敗した〔503〕間は残す。別のファイル名・別の発注書の番号は残る）、PUT の content-type と `x-upsert: false`、PUT 失敗・確定失敗は予約 ID つきの pending、確定が種類の検査で 422 なら rejected（続きから保存で通らない行き止まりを新しい予約への案内に替える）、予約の断りは error、`fetchPurchaseOrderDocumentUrl`（原本を開く60秒のリンクをもらう共通の道具。表示用と `?download=1`・no-store、窓口の断りは誤りの表の文、応答の崩れ・通信の失敗は「原本を取得できません。」、リンクが文に出ない）、`resumePurchaseOrderDocument`（PUT 失敗 → ファイル無しは needs_file → 選び直して PUT → 確定、ページを読み直した後は `uploaded: true` で PUT を省き sha256 なしで確定、置き場に保存済みで確定が失敗した後の再開は PUT を省き同じ内容なら同じ要求番号、確定に差し替え元を載せない）、送り先を出し直す窓口の断りの文、署名つきの送り先が結果に出ないこと |
| `tests/unit/api/admin/purchase-order-attachments-route.test.ts`・`tests/unit/api/admin/purchase-order-documents-route.test.ts`（G-2 Task 8） | 単体 | FREQ-530-AC-01・AC-02・AC-03、FREQ-540-AC-07 | 6本の窓口（予約・送り先の出し直し・確定・訂正・閲覧リンク・書類検索）。認可の組（manage ＋ read、閲覧と検索は read だけ）、認可 → CSRF → IP → actor → 検証 → 置き場の確かめ → DB → 監査の順、回数制限（reserve 30・upload_url 30・attach 30・revise 30・view 120）、本文・パス・query の検査、DB の誤りと原本の検査の誤りの本文と状態、no-store、監査は発注書・予約・添付の id・再送・結果コードだけで署名つきの送り先・リンク・保存キー・ファイル名・理由を残さない、未知の誤りは固定の500、各 route file の export は POST／GET だけ。予約の窓口は差し替え元（uuid）を DB へ渡し、確定の窓口は本文の差し替え元を DB へ渡さない |
| `tests/unit/components/PurchaseOrderDocumentsSection.test.tsx`・`tests/unit/components/PurchaseOrderDocumentSearchSection.test.tsx`（G-2 Task 8） | 単体 | FREQ-530-AC-02・AC-03、FREQ-540-AC-07 | 取引書類の節（見出し・「書類を追加」・書類の一覧とバッジ「無効」・操作のボタン、保存が終わっていないファイルと「続きから保存」・期限切れの文、表示・印刷は新しいタブ・ダウンロードは保存、追加・差し替え・続きから保存・情報を訂正・無効にするのダイアログ、送信中の二重送信防止、pending の扱い、差し替えの関係が頁を読み直した後の再開でも保たれ確定に差し替え元を載せないこと、種類の検査に通らない（rejected）時にファイルを捨てて選び直させ新しい予約で保存し直す〔種類と差し替え元の引き継ぎを含む〕こと、390/768/1280 の構造）と書類検索（条件・ボタン・列〔最後に「原本」の列。印刷しない〕・状態の文字・頁送り・印刷〔印刷では高さの上限・スクロール・表の最小幅を外す print: の指定〕・各行の「原本を見る」〔行の発注書・添付の窓口から60秒のリンクをもらい新しいタブで開く、断りの文は発注書の頁と同じ、開く間は押せない、新しい検索で文が消える〕・権限の文・構造） |
| `tests/unit/components/PurchaseOrderDetailSection.test.tsx`・`tests/unit/lib/purchase-orders/purchase-order-types.test.ts`・`tests/unit/lib/purchase-orders/purchase-order-store.test.ts`（G-2 Task 8 で追加） | 単体 | FREQ-530-AC-02 | 取引書類の節が発注書の頁に出ること（旧 Task 5 の「見出しだけ」の試験を置き換えた）、保存の後に通知を出して読み直すこと。原本の値の範囲・DB の誤りの表の3つ・置き場の確かめの誤りの表・固定の文・書類検索の行の検査・状態の文字・ファイルの種類と先頭のバイトの共通の定義（`purchaseOrderDocumentMimeOfName`・`hasPurchaseOrderDocumentSignature`）・`pendingUploads` の `replacesAttachmentId` の検査。`PurchaseOrderError` が原本の code を持つこと |
| `tests/unit/docs/delivery-status-traceability.test.ts`・`tests/unit/docs/order-status-traceability.test.ts`（G-2 Task 8 で変更） | 単体 | FREQ-530-AC-01 | 窓口の数を145ファイル・186メソッド（表は144行・185メソッド）に更新 |
| `tests/unit/docs/delivery-status-traceability.test.ts`（G-2 Task 9 で変更） | 単体 | FREQ-540-AC-08 | FREQ-540 の AC は G-1 の AC-01〜05 が先頭に並び、その後ろは G-2 が足した `G2_FREQ_540_ADDITIONS` ＝ AC-06・AC-07・AC-08・AC-09 だけ（AC-08 を足して完成） |
| `e2e/purchasing-test-utils.ts`（G-2 Task 10） | E2E の道具 | FREQ-525〜530、FREQ-540-AC-06・AC-07 | 画面が呼ぶ窓口（`/api/admin/inventory`・`/api/admin/purchase-orders**`・`/api/admin/purchase-order-documents`）を、実行者 `actorId` で DB の公開関数へ橋渡しする `mockPurchasingUiBridge`。bridge は権限を決めず（読みも `_actor_id` を渡す）、DB の誤りを窓口と同じ表 `PURCHASE_ORDER_ERRORS`（import）で HTTP の状態と本文にする（外す割当の確認は `releasedQuantity` つき）。原本の置き場だけは本物の手元の Storage（署名つきの送り先・読戻し・閲覧のリンク。手元の住所だけを受け付ける見張りを付け、鍵・URL・保存先の鍵は出力しない）。材料: `createCatalogMaterial`（試験ごとの新しい商品）・`createWaitingOrder`（注文日を指定できる入金済みの待ち注文）・`createPurchaseOrderInDb`・`confirmPurchaseOrderInDb`・`receivePurchaseOrderInDb`・`attachDocumentInDb`・`adjustStock`・`readPurchaseOrder`・`readInventoryRow`。`withPurchasingScenario` は、権限を変えない試験では権限の鍵（190520,0）を共有（`pg_advisory_lock_shared`）で持ち、権限を付け外しする試験（`changesPermissions`）だけが `withPermissionScenario`（排他の鍵と差分の復元）の上で動く。返品の設定の鍵 14314,2 を使う試験は、それを先に取る（順は 14314,2 → 190520,0）。終わりに作った発注書の残りを打ち切って閉じる（追記専用なので消さない）。窓口の認可・MFA・CSRF・回数の制限・監査は範囲の外（FR-ADMIN-123 の G-2 の節の本物の 401/403 と各 route の単体） |
| `e2e/FR-ADMIN-111-inventory-fifo.spec.ts`（G-2 Task 10） | E2E（3幅） | FREQ-525-AC-01・AC-02、FREQ-529-AC-01、FREQ-521-AC-01、FREQ-522-AC-01・AC-02 | 在庫一覧表の7列と、注文数（入金済みの待ち注文）・在庫（仮確保を含む）・発注済み・発注必要数、「在庫の内訳」のキーボード操作（①）。発注の受け取りで古い待ち注文へ順に割り当たり、買い手本人の仮確保は奪われず、一覧と商品の在庫の履歴が更新される（②）。棚卸の増・取消による解放・要確認の解消・取消申請のお断り・返品の受け取りの結果が、開き直した一覧に出る（③。原因の操作は G-1 の公開 DB 関数を直に呼ぶ）。棚卸の減で新しい注文の割当が外れた結果（④）。画面操作の移設は G-4 |
| `e2e/FR-ADMIN-113-purchase-order-create.spec.ts`（G-2 Task 10） | E2E（3幅） | FREQ-526-AC-01・AC-02・AC-03・AC-05、FREQ-525-AC-02 | 発注モードの数量が空欄で始まり、正の整数の行だけが「発注書の確認」に並び、内訳の開閉・戻る・キャンセルの挙動（①）。発注先が空だと通信せず、納期の欄は無い（②）。発注確定の二重送信で通信は1回・発注書は1件、同じ本文の再送は同じ発注書を `replayed` で返す（③）。確定直後の発注書は数量確定待ちで、通知・「数量未確定」・発注済みに数えない（④） |
| `e2e/FR-ADMIN-114-purchase-order-quantities.spec.ts`（G-2 Task 10） | E2E（3幅） | FREQ-527-AC-01・AC-02、FREQ-528-AC-01・AC-02、FREQ-526-AC-04、FREQ-525-AC-02 | 数量確定で増減・単価の未入力と 0 円の区別（①）。納品済み未満は訂正できず、訂正は理由が要る（②）。残りの打切りと履歴（③）。発注一覧表は7列で「打切り」の列が無い（④）。誤った打切りの再確定（⑤）。打切り後の発注必要数（⑥）。数量確定前の取消（⑦） |
| `e2e/FR-ADMIN-115-purchase-order-receipts.spec.ts`（G-2 Task 10） | E2E（3幅） | FREQ-529-AC-01・AC-02・AC-04・AC-05、FREQ-525-AC-01 | 全部受け取る（①）・一部と後日の受け取り（②）・二重送信（③）・数量確定前と未納超過の断り（④）・取消と在庫一覧表（⑤。受け取りの後に待ち注文 5 を作り、取消の前後で発注必要数が 2 のまま）・数量訂正（⑥）・割当を外す確認の文（⑦。古い待ち注文 3・新しい待ち注文 1 で、外れるのは新しい注文の割当から）・在庫不足の断り（⑧）。受取ごとのボタンは日付つきの名前で選ぶ |
| `e2e/FR-ADMIN-119-purchase-order-attachments.spec.ts`（G-2 Task 10） | E2E（3幅） | FREQ-530-AC-01・AC-02・AC-03 | 見積書の PDF の保存（本物の署名つきの PUT が CSP を通る）・検索・原本を新しいタブで開く・書類検索の印刷（①）。訂正の履歴と訂正前の検索（②）。差し替えと無効化（③）。置き場に保存済みで DB 未確定の予約の続きからの保存（④）。DELETE・PUT・PATCH は 405 と追記専用の行（⑤。画面を描かないので幅の繰り返しの外）。20 MiB 超・許さない種類の断り（⑥）。置き場に無い予約のファイルの選び直し（⑦） |
| `e2e/FR-ADMIN-119-purchase-order-attachments.spec.ts`（G-2 最終レビュー M4 で変更） | E2E | FREQ-530-AC-02 | 「原本を見る」の新しいタブは空で先に開き、リンクが取れてから移す形になったので、保存（download）の事象を新しいタブと開いた頁の両方で受ける。通る条件は変わらない（新しいタブが署名つきリンクへ向かうか保存になり、リンクが同じファイルを返す） |
| `e2e/FR-ADMIN-123-group-g-permissions.spec.ts`（G-2 の節。G-2 Task 10） | E2E | FREQ-540-AC-06・AC-07 | 新しい窓口15メソッドと既存の variants GET/POST（17）が、ログインなしで 401、お客様で 403。サポーター（初期値）は在庫一覧表・発注一覧表・書類検索・発注書の頁で DB の関数の拒否により表が出ず権限の文が出る。店長が権限画面でサポーターに `admin.stock.read` を付けると在庫一覧表が見え、発注（作成）は断られ、元に戻すと再び見えない。サポーターの管理メニューに ORDER と INVENTORY（SETTINGS は無し）。`admin.purchase_orders.read` を付けると INVENTORY から発注一覧表へ入れる。店長の管理メニューにも INVENTORY がある |
| `tests/unit/components/PurchaseOrderDocumentsSection.test.tsx`・`PurchaseOrderDocumentSearchSection.test.tsx`・`tests/unit/lib/purchase-orders/purchase-order-documents-client.test.ts`（G-2 最終レビュー M4） | 単体 | FREQ-530-AC-02・AC-03 | 原本を開く新しいタブを、リンクを待つ前にクリックの中で空で開く（`window.open('', '_blank')` の後に `opener` を切る）。リンクが取れたらそのタブの `location.href` を替え、取れなければタブを閉じて文を出す（リンクは `window.open` の引数にも文にも出ない）。ブラウザが止めた時（null）は、リンクを取りに行かずに「新しいタブがブラウザに止められました。このサイトのポップアップを許可して、もう一度押してください。」を `role="alert"` で出す。ダウンロードはタブを開かない |
| `tests/unit/lib/auth/role-permission-catalog.test.ts`・`e2e/FR-ADMIN-109-permission-settings.spec.ts`（G-2 最終レビュー M5） | 単体・E2E | FREQ-540-AC-06 | `admin.receiving.manage` の説明に「取消・訂正で在庫が足りなくなる時は、新しい注文から順に支払い済みの割当を外す」を足した（権限の画面で店長が付与の前に読める）。表の順・分野・準備中の4件は変わらない |

## リスクに応じた優先順位

決済・注文状態・在庫、認証・権限、マイグレーション・RLS、証憑アーカイブを優先する。これらは単体テストに加え、必要な API/E2E と実環境の運用確認を選ぶ。外部サービスのモックを使うテストは契約の一部を確認するだけであり、Webhook 配信や本番 DB の状態を証明しない。

## 開始・終了条件

開始前に変更範囲、対応要件、対象リビジョン、必要な環境変数とテストデータ、ポート 3000 の実サーバーを確認する。終了時は対象テストを実行し、失敗を分類して修正または未解決として記録する。要件ごとの判定には実行ログと環境を添える。対象外テストや未実施の本番確認を成功扱いしない。

## グループ G-3（発送票・出荷日）のテスト

Task 1 は発送票の基盤と消費の裏付けの守りを対象とする。2026-10-25のcontroller reset後の実装者DB全件でTask 1の新規失敗は0。全体は既知stockistの2件の失敗によりexit 1。一括確定のRPC・UI・メール・追跡は後続Taskの範囲。

| ファイル | 層 | 要件・受け入れ条件 | 確認する振る舞い |
| --- | --- | --- | --- |
| `tests/integration/db/group_g3_model.integration.test.ts` | DB結合 | FREQ-540-AC-12、FREQ-533-AC-02・AC-04 | 6表の列・RLS・restrictive deny・意味によるACL（別granteeでも可、PG17のMAINTAINを含む）、追記専用5表のUPDATE/DELETE/TRUNCATEと票のDELETE/TRUNCATE拒否、7つの操作印の列・段階・版。出荷日必須、運送会社と番号の対、shipment_date印で列を限定、既存の更新の契約。発送行とconsume・取消とrestoreが同じ取引で必要で、4種類の不一致とslip_partial_cancelを拒否。理由17値、票番号・確定キー・票×注文・発送IDの一意、末尾assertの再実行。AC-02はconsumeの裏付けだけ、AC-04はshipment_confirm/shipment_cancelの理由CHECKの2値だけ（在庫の1回減・取消の1回戻り・空き在庫の不変の業務処理の証明は後続Task） |
| 同 suite の `group_g3_fixtures` | DB結合（実commit） | FREQ-533-AC-02 | seedGroupG1Shipment・shipFixtureOrder・交換の発送・配送の材料とwithFixtureConsumption・取消済みの材料がJSTの出荷日と同じ取引の消費・復元を持ち、実commitまで進む。自動commitで発送行だけを書く場合は拒否 |
| `tests/integration/db/item_checkout_guards.integration.test.ts` | DB結合 | FREQ-540-AC-12（G-2持越しM1） | 注文・在庫記録・決済中が無くても発注書の行がある商品はhas_purchase_orders=true。戻り値5列、所有者・属性・ACLは元の契約を保つ |
| `tests/integration/db/group_g1_writer_inventory.integration.test.ts` | DB結合・定義走査 | FREQ-540-AC-12 | 新6表を直接書く関数も走査対象へ足す。書き手の許可一覧はTask 1では変更しない |
| `tests/unit/lib/inventory/allocation-event-reasons.test.ts` | 単体 | FREQ-533-AC-04 | Task 1の部分的な証明として最新の理由CHECKとTSが同じ17値、shipment_confirm/shipment_cancelを「発送の確定」「発送の取消」と表示し、未知値は「システム」。AC-04の在庫の1回減・取消での1回戻り・空き在庫の不変の業務処理は後続Taskで証明する |
| `tests/unit/lib/items/item-checkout-guards.test.ts` | 単体 | FREQ-540-AC-12（G-2持越しM1） | RPCのhas_purchase_ordersをhasPurchaseOrdersへ写し、発注書だけでも削除できない。理由は注文・在庫記録・決済中・発注書の順 |
| `tests/unit/api/admin/items-checkout-guards-route.test.ts`・`items-return-ineligible-route.test.ts` | 単体 | FREQ-540-AC-12（型の付け替え） | 既存の削除止めの材料にhasPurchaseOrdersを足し、既存の窓口の期待を維持する |

既存DB/E2Eの材料の付け替えは非legacyのshipment_dateにshipped_atのJST暦日を入れ、発送行とconsumeを同じ取引で書き、取消はrestoreの対を持つ。割当境界・台帳整合だけを見る試験は `SET CONSTRAINTS group_g_allocation_bounds, group_g_stock_movement_consistency IMMEDIATE` を名指しし、G-3のcommit時の検査を早めない。E2Eの材料の単体は tests/unit/e2e で確認し、ブラウザ・DBの実行と区別する。


G-0の基準専用のorder-fixtures.tsの非G分岐は、G-3のshipment_date列も遅延triggerも存在しないため、shipment_dateを書かない形を保つ（controllerのI-1裁定により付け替えから除外）。G1_CLEANUP_SUITE=1でのG-1清掃suiteの再実行はcontroller判断待ちで、通常のDB全件の成功件数からこの特別な清掃の成功を推定しない。


| Fix round 2 実装者検証（2026-10-25） | 結果 |
| --- | --- |
| DB全件 `npx.cmd jest tests/integration/db --runInBand` | exit 1。suiteは118成功・stockistの1失敗・11 skip・計130、testは3266成功・stockistの2失敗・12 skip・計3280。205.889秒。Task 1の新規失敗0 |
| レビュー修正後の対象DB6 suite | 234件成功。DB全件の既知stockist2失敗と区別する |
| G-0基準のG-1清掃suite | G1_CLEANUP_SUITE=1の特別実行はcontroller判断待ち。通常全件のskipやsuiteの成功表示は、G-0基準の清掃の成功を証明しない |

## G-3 Task 2 荷作り表と発送票の読取

確認日: 2026-10-25。下記の読取・モデル・書き手一覧を含むTask 5までの対象について、controllerが実鍵PostgRESTを含む12 suiteで665/665成功を確認した（2026-10-25）。非DB検証の成功をDB・PostgRESTの証明に含めない。

| ファイル | 層 | 対象 | 入力と期待 |
| --- | --- | --- | --- |
| [group_g3_reads](../../../tests/integration/db/group_g3_reads.integration.test.ts) | DB結合 | FREQ-531-AC-01〜04、FREQ-532-AC-01〜05、FREQ-535-AC-05、FREQ-540-AC-10 | paid割当と除外状態、一部準備数、同時刻のID順、頁とbigint総数、5阻害理由の和、相互の下書き番号・期限・選択数。同梱の会員・ゲスト・混在・別ID・7住所差分・必須の空・メールの連鎖拒否・JSON文字境界を表で確かめ、キー全一致と判定NULLを突き合わせる。役割の和集合・取消・期限、詳細issuesと取消阻害3種、履歴・注文の票・7列会計入力と取消時刻。在庫減・割当入替・受取後の数を再読取する |
| [group_g3_postgrest_paths](../../../tests/integration/db/group_g3_postgrest_paths.integration.test.ts) | 実PostgREST結合 | FREQ-531-AC-01・04、FREQ-540-AC-10 | supabase-js rpcから公開5入口をservice_roleで呼ぶ。権限なしactorはGROUP_G_FORBIDDEN / 42501。Authorizationを送らないanonと実Authで得たauthenticated JWTは5本とも42501。鍵・JWT・認証エラーは出力しない。実 store の読取4本をPostgREST越しに通す2件はTask 3で追加（下のTask 3の節） |
| [group_g1_writer_inventory](../../../tests/integration/db/group_g1_writer_inventory.integration.test.ts) | DB構造・回帰 | FREQ-540-AC-10 | 読取本体5本・入口5本・内部3本の所有者、SECURITY、空search_path、EXECUTE集合。直接・推移的な書き手に入らず、読取の追加では許可一覧は65本のまま（Task 4 で書き手を足して67本。下の Task 4 の節） |
| [delivery-status-traceability](../../../tests/unit/docs/delivery-status-traceability.test.ts) | 文書単体 | 要求表の追跡 | FREQ-531・532のAC一覧、FREQ-535の会計入力AC-05、FREQ-540の読取部分AC-10を固定し、既存の一覧と検査を保つ |

準備数の材料はpaid_atをpending時に一度設定してからpaidへ進め、発送行はseedGroupG1Shipmentのconsumeを持つ。取消はrestoreGroupG1Shipmentで戻す。seedGroupG3SlipとattachGroupG3SlipShipmentは票・行・発送との対応と履歴だけを足し、発送のconsumeを代用しない。variant欠落と古い割当の併存はG-1がcommitを拒むため、その防御的読取はrollbackする取引内だけで観測する。

実行時はDATABASE_URLのlocalhost guardを使う。PostgREST用はLOCAL_SUPABASE_URL・LOCAL_SUPABASE_SERVICE_ROLE_KEY・LOCAL_SUPABASE_ANON_KEYが必要で、未設定は理由つきskip、localhost以外は失敗。anonと実ユーザーJWTのclientは実anonキーで作る。材料は期限切れの下書き、認証利用者はactorと共用する1人、終了時は準備注文を閉じてsignOut・認証利用者の削除を行う。DB6 suiteの実行・再reset・件数はTask 2報告に記録する。画面・HTTP route・外部追跡・メール・E2E・本番は本Taskの検証外。

2026-10-25 Fix round 1の追加検査: 住所不足は該当明細だけに1件ずつ、paid以外にはpaid_at_missingなし、詳細の準備数呼出しは1回、不正/不在の票、空/不在IDの同梱拒否、住所7項目の前後空白、全段階と不正stage・確定票の2注文/3点、paid割当なしのpaid注文を含むG-1投影との先絞りの同値性。会計入力の打切りの扱いとTask 8の追跡読取側の追記は文書単体でも固定する。前版191件成功の後でSQLを変更したため、最新のTask 5までの対象ではcontrollerが実鍵PostgRESTを含む12 suiteで665/665成功を確認した（2026-10-25）。

## G-3 Task 3 荷作り表の画面と読取の窓口・管理メニュー・旧い案内の置換

確認日: 2026-10-25。下記の単体は実行済み（件数は Task 3 報告）。DB・PostgRESTの実store経路を含め、controllerが修正前のTask 9をfresh resetし、実鍵PostgRESTを含む12 suite・639/639成功（2026-10-26）。Fix round 1の後も、controllerがfresh resetし実鍵PostgRESTを含む12 suite・642/642成功（2026-10-26）。

| ファイル | 層 | 対象 | 入力と期待 |
| --- | --- | --- | --- |
| [bundling](../../../tests/unit/lib/orders/shipment-slips/bundling.test.ts) | 単体 | FREQ-532-AC-01〜05 | 会員同士のメール違いは通し、別IDは同じメールでも拒否、ゲスト同士はメールの大文字小文字・前後の空白を除いて通し、混在は拒否。配送先7項目の差、建物の空・null・空白の同一視、半角空白だけを落とす（タブ・全角は落とさない）、必須の空、評価の順（不足→お客様→配送先） |
| [shipment-slip-types](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-types.test.ts) | 単体 | FREQ-531-AC-01〜04、FREQ-524-AC-03 | 段階・阻害理由の文・値の範囲、DBエラー表28行の完全一致、継承名の排除、画面の言葉の完全一致、旧い発送の案内の新しい文、行・票の一覧・詳細・結び付きの検査（崩れは止める） |
| [shipment-slip-store](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-store.test.ts) | 単体 | FREQ-531-AC-01・04、FREQ-533-AC-01 | RPC名・引数名（_actor_id）、total_count からの total、message と SQLSTATE の完全一致の分類、未知・崩れた戻りは生の誤りを持たない固定の500 |
| [packing-route](../../../tests/unit/api/admin/packing-route.test.ts)・[shipment-slips-route](../../../tests/unit/api/admin/shipment-slips-route.test.ts)・[shipment-slip-detail-route](../../../tests/unit/api/admin/shipment-slip-detail-route.test.ts) | 単体 | FREQ-531-AC-01・04、FREQ-540-AC-10 | 認可の組（足りない最初の権限が403の permission）、応答の canManage（操作の4権限を全部持つ時だけ true。権限不足の 403 は false、2回目の確かめが 401・500・503 ならその応答を返し RPC に進まない）、401/403/MFA/503 のそのまま返し、limit・page・stage・slipId・id の検証、no-store、CSRF・回数制限なし、DB の403・404・400 の固定の本文、内部の失敗は固定の500でログに生の文を出さない |
| [PackingSection](../../../tests/unit/components/PackingSection.test.tsx) | 単体（画面） | FREQ-531-AC-01〜04 | 9列の見出しと並び、注文IDのボタンが注文の履歴を orderId つきで開く、交換の品の印、阻害理由と別の下書きの文、権限・空・失敗の文、頁送り（2頁目以降が範囲外で空なら1頁目へ戻って読み直す。2頁目以降の失敗には「前の頁」を出す）、下の発送票の一覧（下書き・確定済み・取消済み）、スクロール領域。（Task 3 の時点は読むだけで選択欄・「発送」を出さなかった。Task 4 で選択欄の列を足し、列・セルの添字を直した。下の Task 4 の節） |
| [AdminSettingsMenu](../../../tests/unit/components/AdminSettingsMenu.test.tsx) | 単体（画面） | FREQ-531-AC-01 | PACKING が店長・サポーターの両方に出て、INVENTORY の次、SETTINGS の前。印・リンク・`/admin?tab=PACKING` |
| [AdminGroupG1LegacyStop](../../../tests/unit/components/AdminGroupG1LegacyStop.test.tsx)・[ShopSettingsSection](../../../tests/unit/components/ShopSettingsSection.test.tsx) | 単体（画面） | FREQ-524-AC-03、FREQ-533-AC-01 | 履歴は発送票への案内と、票に属する発送の行への「発送票 ○○ を開く」。追跡の説明の第三の文の置換。注文一覧の荷作り表への案内は、旧い一覧の撤去（G-4 Task 7）で無くなった。AdminGroupG1LegacyStop の注文一覧の部分は ORDER タブの入口の確かめに書き換え、旧い AdminOrderHistoryWiring は削除した |
| [order-email-routes](../../../tests/unit/api/admin/order-email-routes.test.ts) | 単体（窓口） | FREQ-533-AC-01 | 履歴の窓口が slipId・slipNumber を付ける。票の読み込みに失敗した時は（DB が GROUP_G_FORBIDDEN で断った時も、他の失敗も）付けず履歴は200。FORBIDDEN 以外は例外名だけをログに出す |
| [delivery-status-traceability](../../../tests/unit/docs/delivery-status-traceability.test.ts)・[order-status-traceability](../../../tests/unit/docs/order-status-traceability.test.ts) | 文書単体 | 窓口の数・停止の注記 | route は150ファイル・192メソッド（表は149行・191メソッド。Task 4 で票の下書きの3メソッドを足した）。G-3移行の注記をE-4節と旧入口の隣に置き、仕上がりの2メソッドは G-1停止 のまま |
| [group_g3_postgrest_paths](../../../tests/integration/db/group_g3_postgrest_paths.integration.test.ts)（追加2件） | 実PostgREST結合 | FREQ-531-AC-01・04 | 実 store の読取4本を service_role の supabase-js 経由で通し、行・詳細・結び付きが型検査を通る。権限なし・不在の票は固定の403・404の ShipmentSlipError。鍵・JWT・生の誤りは出さない。修正前Task 9のcontroller fresh reset・12 suite・639/639成功に含む |

E2E は後続 Task（Task 13）で扱う。G-1 から止めていた旧い案内の期待のうち、型の都合で最小限だけ触れた E2E: FR-ADMIN-072・082・093・123（slipId: null, slipNumber: null の追加）と FR-ADMIN-104（追跡の説明の第三の文）。

## G-3 Task 4 発送票の下書き（作成・入れ替え・破棄）と書き手の一覧67本

確認日: 2026-10-25。controller がローカルを reset して最終の移行を適用し、DB の11 suite（PostgREST を含む）606/606 と、単体＋DB の全件（失敗は別作業の stockist_rls の2件だけ）を確かめた。Fix round 1（Opus レビュー後）で末尾の確かめを強め、DB の試験に押さえの順の改変6件と連番の枯渇を足した。

| ファイル | 層 | 対象 | 入力と期待 |
| --- | --- | --- | --- |
| [group_g3_draft](../../../tests/integration/db/group_g3_draft.integration.test.ts) | DB結合（構造は DB なし） | FREQ-531-AC-02・03、FREQ-532-AC-01〜05、FREQ-533-AC-03、FREQ-540-AC-10・11 | 作成（票1件・番号・stage・版・draft_lines・顧客と送り先の写し・有効期限7日・操作の記録を一度に保存、同日の2件目は次の番号、別の日は数えない、会員の写し）、一部の数量・入れ替え（先頭の明細の注文から写しを取り直す・明細の昇順）、再送と衝突と版違い（再送は票が進んでいても保存した結果）、保存でも同梱をサーバーが断る表（会員と別会員・会員とゲスト・ゲストのメール違い・別住所7項目・建物の片方空・必須の空・同じメールでの連鎖。拒否のとき票も操作の記録も増えない）、TS の bundleVerdict と DB の一致、拒否の優先順（未払い → 阻害理由 → 同梱 → 数量）、数量・形の不正（0・負・小数・文字・100000・重複・101件・空・余分な項目・不正 uuid）、阻害理由ごとの拒否コード（支払確認・配送先不足・入金日時なし・色サイズ未確定・交換手数料待ち）、2つの下書きが同じ明細を選べる、破棄（版+1・再送・破棄済み/確定済み/取消済みは NOT_DRAFT）、期限切れも保存し直せて期限が延びる、権限（4つ揃うと通る・1つ欠けると断る・無効/期限切れの役割・役割なし・存在しない実行者、権限が存在確認より先、役割の和集合）、在庫・割当・台帳・注文・発送が不変、途中の失敗（票の INSERT・UPDATE・操作の記録の INSERT に故障注入）で何も残らない、関数の構造（所有者・SECURITY・search_path・EXECUTE の集合、押さえの道具の最初の文、anon・authenticated は 42501）、末尾の確かめの改変検出（関数の欠け・ACL・押さえの順（押さえの前に表を読む・`FROM ONLY`・`TABLE`・権限の確かめの関数を押さえの前へ移す・押さえの道具が登録の行を票の行より先に取る・票の行を在庫の閉包より先に取る）・一覧の増減と差し替え・同名の overload）、連番の枯渇（`SL-<日本時間の日付>-9999` で `GROUP_G_SLIP_NUMBER_EXHAUSTED / 55000`、別の日の 9999 は数えない）、移行ファイルの形（ASCII・BOM/CR なし・印・USAGE を変えない） |
| [group_g3_postgrest_paths](../../../tests/integration/db/group_g3_postgrest_paths.integration.test.ts)（追加2件） | 実PostgREST結合 | FREQ-531-AC-03、FREQ-540-AC-10 | 実 store の保存・入れ替え・破棄を service_role の supabase-js 経由で通し、再送は replayed: true、版違い・数量超過・空・権限なし・不在の票は固定の 409・400・403・404 の ShipmentSlipError。anon・実 authenticated JWT は保存・破棄の公開入口を 42501 で拒み、何も書かない。修正前Task 9のcontroller fresh reset・12 suite・639/639成功に含む |
| [group_g1_writer_inventory](../../../tests/integration/db/group_g1_writer_inventory.integration.test.ts) | DB構造・回帰 | FREQ-540-AC-10・11 | 許可一覧は67本（保存・破棄を末尾に足した）。発送票の書込み関数2本は private の DEFINER・search_path 空で一覧にあり、public の入口は同名 private へ委ねるだけの INVOKER。押さえの道具は誰も EXECUTE できず書き手でない。service_role が EXECUTE できる発送票の書込みの関数は4本。書込み本体は押さえを表の参照より前に呼ぶ |
| [group_g2_migration_asserts](../../../tests/integration/db/group_g2_migration_asserts.integration.test.ts)・[group_g2_purchase_documents](../../../tests/integration/db/group_g2_purchase_documents.integration.test.ts) | DB結合 | FREQ-540-AC-07・08・10 | G2B の末尾の確かめを実DBで流す前に、共有の道具の `runWithAllowlist(client, G2_ALLOWLIST, 節)` で取引の中の一覧を G-2 の65本へ入れ替える（戻すのは rollback）。今の DB の一覧（67本）のままだと `purchase_writer_allowlist_missing` で止まることも確かめる。今の DB の一覧が `G3C_ALLOWLIST` と同じことも確かめる。`group_g2_purchase_quantities`・`group_g2_purchase_receipts` の「今の DB の本数」は `G3C_ALLOWLIST.length` に合わせた |
| [group-g-allowlist](../../../tests/integration/db/helpers/group-g-allowlist.ts) | 共有の道具 | FREQ-540-AC-11 | `G2_ALLOWLIST`（G2B 移行の `v_writers` から読み取って固定した65本）、`G3C_ALLOWLIST`（G-2 の65本＋この移行に存在する書き手だけ。Task 4 は67本）、`replaceAllowlistSql`、`runWithAllowlist`。`toBe(65)` の grep だけに頼らず、`g2b_final_objects`・`v_writers`・`group_g_writer_allowlist` を grep して、節を実行する suite を全部載せた（`group_g2_purchase_create`・`_receipts` の文字列読みは変更なし） |
| [shipment-slip-client](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-client.test.ts) | 単体 | FREQ-531-AC-01・03、FREQ-533-AC-03 | export は読取3つ（fetchPacking・fetchShipmentSlips・fetchShipmentSlip）と書込み2つ（submitSlipDraft・submitSlipDiscard）に固定。URL・method・本文・no-store。書込みは ok・refused（表の code の本文、知らない code は「入力を確かめてください。」）・blocked（401・403・429）・unknown（500番台・通信切れ・読めない成功・入れ替え／破棄の答えの id が別の票）の4つ。403 は reason / code / permission で分ける（CSRF の失敗は再読み込みの文で forbidden にしない、MFA は 2要素認証の文、権限の不足だけ forbidden: true）。fetchPacking は応答の canManage（真偽）を返し、無い・真偽でない応答は失敗の文。票の id が uuid でなければ窓口へ送らず「発送票が見つかりません。」（読取は error、書込みは refused）。読取は denied（401・403）を区別し、崩れた応答は失敗の文 |
| [shipment-slip-store](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-store.test.ts)（追加） | 単体 | FREQ-531-AC-03・04 | saveShipmentSlipDraft・discardShipmentSlipDraft: RPC名・引数名（_slip_id・_expected_version・_lines・_actor_id・_request_key）、行は orderItemId と quantity だけ、戻りは4項目だけ、DB の拒否14種は表の状態・code・本文、内部の誤り・崩れた戻り・通信の失敗は生の文を持たない固定の500 |
| [shipment-slip-types](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-types.test.ts)（追加） | 単体 | FREQ-531-AC-02・03 | 下書きの言葉の完全一致、issues の文は DB のエラー表と阻害理由の文に合う（全種類に文がある）、保存・破棄の戻りの検査 |
| [shipment-slips-route](../../../tests/unit/api/admin/shipment-slips-route.test.ts)（POST）・[shipment-slip-draft-route](../../../tests/unit/api/admin/shipment-slip-draft-route.test.ts)（入れ替えと破棄） | 単体（窓口） | FREQ-531-AC-03、FREQ-533-AC-03、FREQ-540-AC-10 | 認可（4権限。足りない最初の権限が403の permission）→ CSRF → IP → actor → 検証 → store → 監査 の順、回数制限（draft 120・discard 60、600秒、IP と actor）、本文の検証（lines 1〜100・uuid・数量1〜99999・重複なし・余分な項目・版・requestKey）、成功の状態（作成201・他200）と no-store、再送、DB の拒否が表の { code, error }、監査は票の id・件数・再送かどうか・結果コードだけ、生の文を本文にも監査にもログにも出さない |
| [PackingSection](../../../tests/unit/components/PackingSection.test.tsx)（追加・更新） | 単体（画面） | FREQ-531-AC-02・03、FREQ-533-AC-01・03、FREQ-540-AC-10 | 列は選択欄を足した10（操作の権限が無いと9。最初の答えの canManage が false なら最初の描画から選択欄・送る数・「発送」を出さず、権限の文を1回出す）。1行目を選ぶと bundleKey が違う行・NULL の行が無効になり行の下に案内を出し、全部外すと戻る。阻害理由のある行は選べない。送る数の入力（初期値・1〜準備中の数）と「発送」の有効条件。二重押下で通信1回・本文は選んだ行と数量と requestKey・成功で票の頁へ移り通知を引き継ぐ。結果不明は同じ requestKey と本文で確かめ直す。断り（409）は選択を保ち次は新しい requestKey。429・401 の文。「発送」の返事が権限の不足の 403（permission か GROUP_G_FORBIDDEN）の時だけ選択欄と「発送」を片付けて権限の文を1回。CSRF の失敗・MFA・理由の分からない 403 は権限が無いことにせず、文を出して操作を残す。選択は頁をまたいで残る |
| [ShipmentSlipSection](../../../tests/unit/components/ShipmentSlipSection.test.tsx) | 単体（画面） | FREQ-531-AC-02・03、FREQ-533-AC-01・03 | 見出し・状態・同梱する品物の表・送り先・追加の候補（同梱できる・未選択・選べる行だけ。100件ずつ頁を送る）。issues の文（票全体は表の上、行は行の下）。行を外す・追加は選択の全部を expectedVersion と requestKey つきで送り、成功で通知と読み直し。版違いは文を出し候補の選択を保つ。同じ内容の再押下は同じ requestKey。結果不明は入力を止めて「もう一度確かめる」「戻る」。破棄は確かめのダイアログ→POST→「破棄済み」。最後の1行を外そうとすると窓口へ送らず「品物を選んでください。」を出し（次に送ると消える）、DB が同じ code で断った時も同じ文。CSRF の失敗の 403 は再読み込みの文で権限が無い文にしない。下書き以外は編集の操作を出さない。読込失敗の文。スクロール領域 |
| [delivery-status-traceability](../../../tests/unit/docs/delivery-status-traceability.test.ts)・[order-status-traceability](../../../tests/unit/docs/order-status-traceability.test.ts) | 文書単体 | 要求表の追跡・窓口の数 | route は150ファイル・192メソッド（表は149行・191メソッド）。FREQ-533 の AC は 01〜04、FREQ-540 の AC は AC-10・AC-11・AC-12 を含む。Task 4 の追跡（下書きの試験・窓口・共有の道具・順序図・状態図の実在と索引のリンク） |

E2E は後続 Task（Task 13）で扱う。この Task は E2E の期待を変えていない（荷作り表・票の頁に触れる E2E は無い）。390/768/1280px の実測は E2E。
## G-3 Task 5 発送確定と番号なしメール

| 試験 | 段 | 対応 | 内容 |
| --- | --- | --- | --- |
| [group_g3_confirm](../../../tests/integration/db/group_g3_confirm.integration.test.ts) | DB結合（controller実測済み） | FREQ-533 AC-02〜05・FREQ-535 AC-02・FREQ-540 AC-10/11 | 複数注文の原子性、FIFO消費、F不変・Aと手元減、台帳不変、状態差分、再送、二重確定、数量再検証、故障巻戻し、追跡の親と代表1行、通知オン/オフ、JST境界と初回履歴、権限、消費ガード、押さえ順と末尾assert改変 |
| [confirm route](../../../tests/unit/api/admin/shipment-slip-confirm-route.test.ts)・[store](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-store.test.ts) | 単体 | FREQ-533 AC-02/03/05 | 入力・両方null・書式・日付・全エラー表、認可済みactor、60回/600秒、監査、崩れた戻り |
| [画面](../../../tests/unit/components/ShipmentSlipSection.test.tsx)・[client](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-client.test.ts) | 単体 | FREQ-533 AC-01/03・FREQ-535 AC-02 | JST今日・通知オン、確認と戻る、issues、二重押下1回、同じ要求番号で再確認、版競合入力保持、拒否時の確認終了・表とissues再表示、403、確定後再読込、発送・両履歴時刻のJST表示 |
| [メール完全一致](../../../tests/unit/lib/orders/email/order-email-compose-shipped.test.ts)・[worker](../../../tests/unit/lib/orders/email/order-email-worker.test.ts) | 単体 | FREQ-533 AC-05 | 番号ありの全品・一部発送の出力不変、番号なし完全一致、注文の商品だけ、残りの案内、控えて送信する経路 |
| [文書単体](../../../tests/unit/docs/delivery-status-traceability.test.ts) | 単体 | 要求と窓口 | AC-533は01〜05、AC-535は01/02/05。routeは151ファイル・193メソッド、一覧は150行・192メソッド |

許可一覧はG3C_ALLOWLISTの70本。G-2の過去のassertは65本への取引内差替えを維持する。controllerが実鍵PostgRESTを含む12 suiteで665/665成功を確認した（2026-10-25）。レビュー後の数量変数名の整理はcontrollerの再適用対象。単体はDBのトリガー・RLS・追跡事業者・実メール・ブラウザの動作を証明しない。

## G-3 Task 6 発送の取消（票全体・戻しは1回）

確認日: 2026-10-25。実装者は先に、取引の中で新しい節を当てて必ず戻す形（実関数の置換・コミットなし）で確認した。その後controllerがresetして、別接続の試験と実鍵PostgRESTを含む21 suiteで1,287/1,287成功、全件の単体とDBで18,318件成功（別セッションの意図的なstockist_rlsの赤2件だけ）、G-0 cleanup 12/12を確認した。

| 試験 | 段 | 対応 | 内容 |
| --- | --- | --- | --- |
| [group_g3_cancel](../../../tests/integration/db/group_g3_cancel.integration.test.ts) | DB結合（controller実測済み。別接続の試験を含む） | FREQ-533 AC-04・FREQ-534 AC-03・FREQ-540 AC-10/11 | 取消で各consumeごとに restock(+n・無タグ)・新しい割当・purchase/exchange(−n・タグ付き)・restore が書かれF不変・F+A+H保存・元の割当不変、戻しは1回（二重restoreは一意制約・再送replayed・取消済みの別キー）、品物状態 shipped/delivered→ready と注文 paid、追跡登録 cancelled と provider_stop_pending・要対応 auto・未送信メール skipped・送信済み不変・お客様メールなし、拒否の優先（CANCEL_NOT_ALLOWED→HAS_RETURN→REFUNDED）と全体不変・返品/返金の数え方の境界、再発送（票番号 n+1・発送番号2・復元分から消費・消費の裏付け）、引数/存在/段階/版、故障注入、権限4つ、advisory待ち中に行を持たない、押さえ前の参照の改変、構造と72本 |
| [cancel route](../../../tests/unit/api/admin/shipment-slip-cancel-route.test.ts)・[store](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-store.test.ts)・[client](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-client.test.ts)・[型と言葉](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-types.test.ts) | 単体 | FREQ-533 AC-04・FREQ-534 AC-03・FREQ-540 AC-10 | 認可→CSRF→IP/actor→検証→RPC→監査の順、30回/600秒、4権限、全エラー表と取消の3つの拒否の本文（注文番号・氏名・住所なし）、崩れた戻り（0個・別の票・小数）、監査は票ID・戻した数量・再送・結果コードだけ、取消の言葉と理由の文 |
| [取消のダイアログ](../../../tests/unit/components/ShipmentSlipCancelDialog.test.tsx)・[票の頁](../../../tests/unit/components/ShipmentSlipSection.test.tsx) | 単体 | FREQ-533 AC-04・FREQ-534 AC-03 | 説明・「取り消す」「戻る」、cancelBlockers を注文番号つきでボタンの上に、拒否の本文をダイアログの中に出し票は変えず読み直す、送信中は閉じず二重押下は通信1回、版競合の後は新しい版と要求番号、結果不明は同じ要求番号で確かめ直す、成功で通知と取消済み |
| [文書単体](../../../tests/unit/docs/delivery-status-traceability.test.ts)・[書き手の閉じた一覧](../../../tests/integration/db/group_g1_writer_inventory.integration.test.ts) | 単体・DB構造 | 要求と窓口・FREQ-540 AC-11 | AC-534-03の追跡、routeは152ファイル・194メソッド、一覧は151行・193メソッド。許可一覧は72本、発送票の書込み関数は4本（入口4本）、service_roleがEXECUTEできるのは8本 |

許可一覧はG3C_ALLOWLISTの72本。実PostgRESTの取消の経路（[group_g3_postgrest_paths](../../../tests/integration/db/group_g3_postgrest_paths.integration.test.ts)）は鍵を持つcontrollerが流す。単体はDBのトリガー・RLS・追跡事業者・実メール・ブラウザの動作を証明しない。

## G-3 Task 7 伝票番号の後入力・訂正と手動の配達済み（票単位）

確認日: 2026-10-25。実装者の最初の報告ではDB・Docker・Playwrightを起動せず（単体・型・lint・文書の確認だけ）、その後 controller が fresh reset して、実鍵PostgRESTを含む19 suiteで1,079/1,079成功、全件の単体とDBで18,870件成功（別セッションの意図的なstockist_rlsの赤2件だけ）、G-0 cleanup 12/12を確認した。レビュー後の小さな直し（運送会社が無い票は選択が空、配達済みの票に「配達済みにする」を出さない）は実装者が単体と `group_g3_tracking` をローカルDBで流して確認した。第4の移行 `20261025134538_group_g3_shipping_actions.sql`（G3D）を作った。

| 試験 | 段 | 対応 | 内容 |
| --- | --- | --- | --- |
| [group_g3_tracking](../../../tests/integration/db/group_g3_tracking.integration.test.ts) | DB結合（controller が fresh reset して実測済み。別接続の試験を含む） | FREQ-534 AC-01・AC-02・AC-04（追跡オフの部分）・AC-05・FREQ-535 AC-04（一部）・FREQ-540 AC-10/11 | 番号なしの票への後入力（全注文が同じ値・tracking_version 2・変更行の from が NULL・shipping_update が注文ごとに1通〔通知オフは0〕・票の版/versions）、番号ありの訂正（配達済みが confirmed・delivered_at NULL へ戻る・品物状態 delivered→shipped・全部送った注文の運送会社/番号）、追跡オンの旧版の登録 replaced・要対応 auto・新しい版の代表の登録だけ、同じ値/書式違反/空で消す訂正/段階/版、再送と衝突、旧版の借りの印は適用されない（applied=false）、手動の配達済み（GREATEST(shipped_at, LEAST(届いた日の正午JST, now()))・出来事 manual・代表の登録 stopped/delivered・要対応 auto・メールは両方オンの時だけ注文ごとに1通・shipped→delivered）、すでに配達済み/届いた日の範囲、返品の期限の起点が届いた日（shipped_at 不変）、追跡オフでも動く、故障注入で全部戻る、4権限・correct_dateだけ・無効な役割、advisory待ち中に行を持たない、押さえ前の参照の改変と末尾assert、構造と74本、旧4RPCの停止と迂回経路0 |
| [tracking route](../../../tests/unit/api/admin/shipment-slip-tracking-route.test.ts)・[delivered route](../../../tests/unit/api/admin/shipment-slip-delivered-route.test.ts)・[store](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-store.test.ts)・[client](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-client.test.ts)・[型と言葉](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-types.test.ts) | 単体 | FREQ-534 AC-01・AC-02・FREQ-540 AC-10 | 認可→CSRF→IP/actor→検証→RPC→監査の順、60回/600秒、4権限（correct_dateだけでは403）、本文の検証（運送会社と番号は両方必須・書式・日付の形・版・キー）、全エラー表と本文（注文番号・氏名・住所・伝票番号なし）、崩れた戻り（追跡の版が1・時刻が読めない・別の票）、監査は票ID・追跡の版・再送・結果コードだけ。client は `submitSlipTrackingEdit`・`submitSlipDelivered` が新しい窓口を呼び ok/refused/blocked/unknown に分ける |
| [伝票番号のダイアログ](../../../tests/unit/components/ShipmentSlipTrackingDialog.test.tsx)・[配達済みのダイアログ](../../../tests/unit/components/ShipmentSlipDeliveredDialog.test.tsx)・[票の頁](../../../tests/unit/components/ShipmentSlipSection.test.tsx) | 単体 | FREQ-534 AC-01・AC-02 | 見出し・説明・初期値（通知オン・届いた日は今日）・番号が無い票の文言（入れる）と運送会社の選択が空で始まり選ばないと送れないこと（運送会社がある票は今の値のまま）、空・書式違反は送らない、すでに配達済みの票には「配達済みにする」を出さない、送信中は閉じず二重押下は通信1回で同じ requestKey、拒否の本文をダイアログの中に出し入力を保って票を読み直す、版競合の後は新しい版と要求番号、結果不明は同じ要求番号で確かめ直す、取消済みなら閉じる、成功で通知 |
| [配送クライアント](../../../tests/unit/lib/orders/tracking/delivery-client.test.ts)・[配送 store](../../../tests/unit/lib/orders/tracking/delivery-store.test.ts)・[旧い整理](../../../tests/unit/lib/orders/fulfillment/fulfillment-client.test.ts) | 単体 | FREQ-534 AC-05 | 停止の道具（`submitTrackingEdit`・`submitManualDelivered`・`updateFulfillmentTracking`・`markFulfillmentDelivered`・`callFulfillmentApi`・`fetchFulfillmentMaterials`）が無く、`useDeliverySubmission`（二重防止の番号・結果不明の再送）と `DELIVERY_FORM_TEXT` が残る |
| [メールの本文](../../../tests/unit/lib/orders/email/order-email-compose-delivery.test.ts)・[メールの材料](../../../tests/unit/lib/orders/email/order-email-delivery-material.test.ts) | 単体 | FREQ-534 AC-01 | 更新メールは前の番号が無い時「先にお知らせした伝票番号は使えません」の行とその後の空行を出さず、有る時は今のまま。材料の `previousTrackingNumber` は直しの行の `from_tracking_number`（無い・空は null、更新メール以外は null） |
| [文書単体](../../../tests/unit/docs/delivery-status-traceability.test.ts)・[書き手の閉じた一覧](../../../tests/integration/db/group_g1_writer_inventory.integration.test.ts) | 単体・DB構造 | 要求と窓口・FREQ-540 AC-11 | AC-534-01/02/05 の追跡、routeは155ファイル・198メソッド（別セッションの `POST /api/auth/post-login` を含む）、一覧は154行・197メソッド。許可一覧は74本、発送票の書込み関数は6本（入口6本）、service_roleがEXECUTEできるのは12本 |

許可一覧はG3D_ALLOWLISTの74本。G-2/G-3 の末尾assertを今のDBで流す試験（`group_g2_migration_asserts`・`group_g2_purchase_documents`・`group_g3_draft`）は、流す前に取引の中の一覧をその移行を当てた時点の本数（65本・72本）へ入れ替える。実PostgRESTの伝票番号・配達済みの経路（[group_g3_postgrest_paths](../../../tests/integration/db/group_g3_postgrest_paths.integration.test.ts)）は鍵を持つcontrollerが流す。単体はDBのトリガー・RLS・追跡事業者・実メール・ブラウザの動作を証明しない。

## G-3 Task 8 追跡の親（代表の登録）と配送の読み直しの結果の票への展開

確認日: 2026-10-26。実装者は単体・型・lint・文書の確認だけを行い（DB 結合は別の作業が手元の DB を使っていたため流していない。移行の新しい節は取引の中で当てて必ず戻す形で構文と末尾 assert を確かめたのみ）、DB 結合の実測は controller の reset 後。移行は第2（reads・G3B）と第4（actions・G3D）の既存の2本を編集した（新しい移行は作らない）。

| 試験 | 段 | 対応 | 内容 |
| --- | --- | --- | --- |
| [group_g3_tracking_parent](../../../tests/integration/db/group_g3_tracking_parent.integration.test.ts) の DB なしの部分 | 構造（DBなし） | FREQ-534 AC-04・FREQ-541 AC-03・FREQ-540 AC-11 | reads の移行の形（ASCII・節の印）、3つの置換が E-4・E-5 の本文から指定の1か所だけ違うこと、助けが読むだけで誰にも EXECUTE させないこと、読み直しの結果の置換が G-1 の本体から指定の13行だけを外すこと（コメントを除く）、共通の押さえは1回・在庫の閉包の道具を呼ばないこと、行の鍵の並びが G-1 の本体と同じ12表で票の全注文を表ごとに1回ずつ取る（前の表へ戻らない）こと |
| 同 DB の部分（取引の中） | DB結合（controller の reset 後に実測） | FREQ-534 AC-01・AC-03・AC-04・FREQ-541 AC-03・FREQ-540 AC-11 | 追跡オンの票の確定で親の行1行と代表の登録1行だけ（2注文・3注文）、claim は代表の1行だけ、読み直しの結果が in_transit→out_for_delivery→delivered で全注文に反映（出来事・メール・操作の記録・品物状態を注文ごとに1回、登録は代表だけ）、配達失敗の要対応は代表だけ、古い読み直しと同じ状況の再読、参加の注文の2つの読取が代表の登録の状態を返し customer-order-view が配送の状況を出して他の注文の情報を含まない、票に属さない発送の出力と取り込み対象が従来どおり、訂正で旧版の登録が replaced・新しい親の行と代表の登録・旧版の借りの印は何も変えない、取消で代表だけ cancelled、追跡オフで親の行だけ・オンにすると代表だけ取り込み（backfilled_count が票ごとに1）、追跡オフで訂正・配達済み、末尾 assert の改変の検出（reads・actions） |
| 同 DB の部分（別接続・commit した準備） | DB結合（controller の reset 後に実測） | FREQ-541 AC-03 | 共通の鍵を待つ間は行を1つも固定しない、注文の表を2注文とも固定してから商品の表の最後の行で待つ・商品の表を全部固定してから割当の表の最後の行で待つ（表ごとに票の全注文をまとめて取る）、読み直しの結果と同じ票の伝票番号の訂正を別接続で同時に流しても deadlock が起きない |
| [group_g3_postgrest_paths](../../../tests/integration/db/group_g3_postgrest_paths.integration.test.ts) の顧客向けの経路 | DB結合（実鍵 PostgREST。controller が流す） | FREQ-541 AC-03 | 実 store（公開材料・管理の配送詳細）と customer-order-view が PostgREST を通り、参加の注文にも代表の登録の状態と配送の状況が出て、別の注文の情報が入らない |
| [既存の単体](../../../tests/unit/lib/orders/customer-order-view.test.ts)・[配送 store](../../../tests/unit/lib/orders/tracking/delivery-store.test.ts)・[文書単体](../../../tests/unit/docs/delivery-status-traceability.test.ts) | 単体 | FREQ-541 AC-03・要求の追跡 | 出力が変わらない既存の単体は無修正。文書単体は FREQ-534 の AC 一覧に AC-04 を加えた |

controller の reset 後に流す DB suite: `group_g3_tracking_parent`・`group_g1_delivery*`・`delivery_tracking_*`・`order_status_links*`・`group_g1_concurrency`・`group_g3_*`（`group_g3_postgrest_paths` は鍵を持つ controller）。既存の E-4・G-1 の suite は無修正で緑のまま（読み直しの結果の本体の文字の並びを確かめる `group_g1_delivery` は、票に属さない発送の道の文をそのまま残して通す）。単体は DB・実メール・17TRACK・ブラウザの動作を証明しない。

## 出荷日の訂正（G-3 Task 9）

確認日: 2026-10-26。DB・実鍵PostgREST・ブラウザはcontroller担当。本番未適用。

| 試験 | 対象と期待 |
| --- | --- |
| [group_g3_date](../../../tests/integration/db/group_g3_date.integration.test.ts) | FREQ-535 AC-03/04/05・FREQ-540 AC-10/11。全有効発送と票の日付・履歴・版、権限、理由、JST範囲、配達日、返品起点不変、会計revision_id、再送・衝突・段階、故障rollback、公開入口、75本、prosrc限定集合、lock前参照の拒否 |
| [shipment-date-isolation](../../../tests/unit/lib/orders/shipment-slips/shipment-date-isolation.test.ts) | FREQ-535 AC-04。KPI・finance・sales・KPI/accounting APIのソースにshipment_date/shipmentDateが無い。認証や他sessionのファイルに依存しない |
| [route](../../../tests/unit/api/admin/shipment-slip-shipment-date-route.test.ts)・[store](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-store.test.ts) | 訂正3権限、CSRF、IP/actor各30/600、認可actor、入力、固定エラー・監査、成功検査 |
| [dialog](../../../tests/unit/components/ShipmentSlipDateDialog.test.tsx)・[画面](../../../tests/unit/components/ShipmentSlipSection.test.tsx) | 正式文、理由必須、二重防止、版競合・結果不明、権限切替・履歴 |
| [実PostgREST](../../../tests/integration/db/group_g3_postgrest_paths.integration.test.ts) | 実storeの訂正・再送・権限、anon/authenticatedのEXECUTE拒否。鍵を持つcontrollerが実行 |

現行G3D_ALLOWLISTは74→75本、票の書込み本体7本と入口7本。G3Cの72本・G2の65本は履歴時点のassert用に維持。routeは156ファイル・199メソッド、表は155行・198メソッド（E2E専用GETは除外）。単体・静的確認をDB適用・RLS・実メール・事業者・ブラウザの証明にしない。

## 書き手75本・末尾assert・全入口の並行・実PostgREST（G-3 Task 10）

確認日: 2026-10-26。ここに書くDB・実鍵PostgRESTの試験は、controllerがfresh resetしてから流す。実測（2026-10-26）: group_g* 47 suite・実鍵PostgRESTを含め初回1,492通過・4失敗（並行の2件と行作成の1件の試験材料の誤り。SQLは不変）。直した後は `group_g3_concurrency` 24/24を3回連続、`group_g3_migration_asserts` 64/64で通過。レビューの直しの後（2026-10-26）は fresh resetで group_g* 全部と `delivery_tracking_records` の48 suite・実鍵PostgRESTを含め1,594通過・失敗0、`group_g3_concurrency` 25/25を3回連続、DB結合と単体の全件19,111通過（失敗は既存の `stockist_rls` 2件だけ）。本番未適用。移行4本の変更は末尾assertだけで、本体の節はHEAD `6ccbd9b0` とバイト一致する。

| 試験 | 対象と期待 |
| --- | --- |
| [group_g1_writer_inventory](../../../tests/integration/db/group_g1_writer_inventory.integration.test.ts) | FREQ-540 AC-11。一覧は75本（G-2の65本が先頭）。書込み本体7本は private・DEFINER・search_path空・service_roleだけがEXECUTE、入口7本は同名privateへ委ねるだけのSQL INVOKER。各本体で押さえの呼び出しが `shipment_*`・`order_fulfillments`・`order_item_allocations`・`stock_movements`・`item_variants`・`orders` への最初の参照より前（呼び出し名を除いて探し、空振りで通らない）。consume・register・restoreは押さえの保持を確かめ、許可された private 本体からだけ呼ばれる。service_roleがEXECUTEできる新関数は書込み7+7・読取5+5の24本だけ。旧4RPCとcompletion 2本は何も書かないまま |
| [group_g3_migration_asserts](../../../tests/integration/db/group_g3_migration_asserts.integration.test.ts) の DBなしの部分 | FREQ-540 AC-11・AC-12。4本のBOM・CR・全角空白・NBSP・ゼロ幅文字なし、BEGIN/COMMITが各1つ、節の印、`USAGE ON SCHEMA private` の文なし、関数本体の外にデータ変更文なし（走査自体の検出も確かめる）、時刻の順と `20261024180500` より後、G3C/G3Dの許可一覧が72本・75本の固定集合で並びまで一致、DETAIL名が簡潔な項目名 |
| 同 DB の部分（取引の中） | FREQ-540 AC-11・AC-12。節を取り出して通ること、search_path に依らないこと、関数のDROP・ACL・戻り列、trigger名変更・停止・遅延triggerの削除、RLS、この取引の行作成（古い行は不問）、CHECK2種、削除止め列、表と列の権限（PG17はMAINTAIN）、押さえの順（書込み本体7本・押さえの道具・置き換えた配達結果）、許可一覧の欠け・過剰・差替・重複・overloadを改ざんし、`GROUP_G_MIGRATION_ASSERTION_FAILED / 55000`・DETAILが項目名になり取引が戻ること。G2Bは65本・G3Cは72本・G3Dは75本を共有helperで取引内に入れ替えて通り、隣の本数は断られ、終わると75本へ戻る |
| [group_g3_concurrency](../../../tests/integration/db/group_g3_concurrency.integration.test.ts) | FREQ-540 AC-11・FREQ-533 AC-03・AC-04・FREQ-534 AC-01・AC-03。書込み本体7本それぞれで、別接続が共通advisoryだけを持つ間にBが `pg_blocking_pids` と `pg_locks`（未許可のadvisory）で待つことを確かめ、別接続が票・注文・明細・割当・variant・発送を `FOR UPDATE NOWAIT` で取れてから解放し、Bが完了して保存則が合う。重なる2つの下書き（片方だけ成功、消費1回、メール注文ごと1通）、同キーの同時確定、注文の並びが逆の2票、受取の取消・棚卸減（足りない側がQUANTITY_EXCEEDS_READY、確定が先の受取の取消・棚卸減では消費済みの割当は外れない）、確定と返金開始、取消と返品作成（返送先の設定は返品を作る接続の取引の中だけで設定し、RPCの直後に戻す）、確定と入金のFIFO、伝票番号の訂正と旧leaseの読み直しの結果、取消と配達済み・日付訂正、配送結果と確定。待ちは sleep で証明せず、全場面でdeadlock 0 |
| [group_g3_postgrest_paths](../../../tests/integration/db/group_g3_postgrest_paths.integration.test.ts) | FREQ-535 AC-05・FREQ-540 AC-10・AC-12。公開RPC12本（書込み7・読取4・会計入力1）を実 store → supabase-js → PostgREST → SQL でservice_roleから通し、anon・実authenticatedは42501。`SHIPMENT_SLIP_ERRORS` の28行を実材料で作り、storeが表どおりの状態コードと本文へ分類する。鍵を持つcontrollerが実行し、未設定なら理由付きskip |
| 同 DBなしの部分（走査の検出） | FREQ-540 AC-12。関数本体の外のデータ変更文の走査が `INSERT INTO`・`UPDATE <表> SET`・別名つきの `UPDATE`・`UPDATE ONLY`・`MERGE INTO`・`DELETE FROM`・`TRUNCATE` をDOの中と素の文で見つけ、`CREATE FUNCTION` の本体の中は見つけない。置き換えた配達結果の本体の確かめは、小文字の `for update` が押さえの前にある・`FOR UPDATE` や `FOR SHARE` が無い本体も断る（Fix round 1） |
| [delivery_tracking_records](../../../tests/integration/db/delivery_tracking_records.integration.test.ts) | FREQ-541 AC-03。「最初は追跡オフで登録もメールも無い」の読取を、他のsuiteがコミットした行（並行試験の追跡の登録・メール）に左右されないよう、自分の発送（`fulfillment_id`）と注文（`order_id`）に絞った。ほかの検証は変えない |
| [group_g2_migration_asserts](../../../tests/integration/db/group_g2_migration_asserts.integration.test.ts)・[group_g2_purchase_documents](../../../tests/integration/db/group_g2_purchase_documents.integration.test.ts) | FREQ-540 AC-08。G-2の65本が75本の先頭65本と一致し、G2Bの確かめを流す前に取引内で65本へ入れ替え、戻ると75本（rollback後も同じ）であること |
| [shipment-slip-store の単体](../../../tests/unit/lib/orders/shipment-slips/shipment-slip-store.test.ts) | FREQ-535 AC-05。`listShipmentAccountingInputs`（会計入力の読取を実storeで通すための追加。呼び元は試験だけ）が3つの引数（from・toは必須の日付。SQLはNULLを拒む）を送り、許可された7項目だけを返し、不正な材料・重複・取引の失敗を固定の500にする |

## 荷作り・同梱メール・権限のE2Eと、再開した配送のE2E（G-3 Task 11）

確認日: 2026-10-26。ここに書くE2Eはcontrollerが本番ビルド（`next build && next start`）で手元のSupabaseに対して流す（実装者は型・lintと単体まで）。実測（`--workers=1`）: 初回 r1（21 spec〔116・120・123・041〜043・104・050・051・061・069・082・100〜103・066・管理メニューの4 specほか〕、fresh reset）は 229 通過・16 失敗・33 skip・15 未実行。失敗のうち FR-ADMIN-004 ×3 は G-2 の基準でも赤（この作業の外）、残りの13件は試験側の直し（運送会社の選択欄の探し方・持ち主の会員の注文状況の頁の期待・出荷日の訂正の403の本文・082 の案内の文）。直した後の r2（FR-ADMIN-116・120・123・082）は 135 通過・0 失敗・9 skip（082 の Task 12 の skip）。レビューの直し（荷作り表の順と不在を1回の読みで確かめる形）の後の r3（FR-ADMIN-116・120・123・104、既定の並列の4 worker）は 135 通過・0 失敗。画面 → 窓口の差し替え（bridge。[shipping-test-utils](../../../e2e/shipping-test-utils.ts)）→ 手元のDBの公開関数の道で確かめ、bridgeは権限を決めず実行者を `_actor_id` で渡すだけ（読みも同じ。許否はDBの関数が決める）。DBの誤りは窓口と同じ `SHIPMENT_SLIP_ERRORS` の表（importした物）で状態と本文にする。窓口の認可・MFA・CSRF・回数の制限・監査は、本物の窓口の401/403（FR-ADMIN-123のG-3の節）と各routeの単体が確かめる。各specは390/768/1280pxの3幅で流し、頁全体が横にはみ出さないことを確かめる。材料の処置（過去の注文日・合成の材料）は `.superpowers/sdd/2026-10-25-group-g3-shipping/e2e-disposition.md`。

| 試験 | 対象と期待 |
| --- | --- |
| [FR-ADMIN-116](../../../e2e/FR-ADMIN-116-packing-shipment-slips.spec.ts)①② | FREQ-531 AC-01・AC-02・FREQ-532 AC-04。荷作り表は9列（選択欄の列は見出しを視覚的に隠す）で、発送準備中の行だけを古い注文から出し（並びと「出ない」は荷作り表の全部の行を一時点の1回の読み取り〔繰り返し可能読み取り〕で確かめ、画面は自分の行の中身と同じ頁の中の並びを確かめる。他の試験が行を足したり閉じたりする最中でも崩れない）、受注生産中・未払い・発送済みの行は出ない。支払額の確認・配送先不足の行は選択欄が無効で理由が行の下に出る。②の交換手数料待ちは、割当済みの交換品が `exchange_fee_waiting` を持つ合成状態（「相談」で受け取って割当が付いた後に手数料より少ない返金をした時などに起きる）で、選択できず理由が出る。交換の品には印が付く。窓口を直接呼んでも `GROUP_G_SLIP_EXCHANGE_ON_HOLD` など各理由の状態・本文と完全一致で断られ、下書きは作られない。普通の流れでは手数料待ちの交換品に割当は付かず表に出ないことを118 ④で確かめる |
| 同③④⑩ | FREQ-531 AC-03・FREQ-532 AC-02・FREQ-533 AC-01・AC-02。一部の数量で下書き→確認→確定すると部分発送（注文は入金済みのまま・準備中は残り）になり、残りを別の票で送ると全部発送済み。同じお客様の別の日の注文を1つの票へ同梱して確定すると注文ごとに発送ができる。選択と送る数がキーボードで操作でき、荷物の情報の確認の段から戻っても、入力が消えない（「履歴のダイアログを開閉しても入力が消えない」は、G-4 Task 8 で荷作り表の注文IDが注文の詳細への Link になり履歴の dialog が無くなったため、G-4 Task 9 で Link の href と、フォーカスしても遷移せず選択と送る数が消えない確かめ（別の頁で Enter を押すと詳細へ移る確かめを足した）へ付け替えた。①の注文IDのセルも Link の文字と href の確かめにした。③の最後の待ちは、荷作り表の領域か「発送準備中の品物はありません。」のどちらかが出れば読み込み済みとする（reset 直後で他に準備中の行が無いと荷作り表が空の文になるため。「全部送った注文がどこにも出ない」の確かめは一時点の DB の読みのまま）。ケースの題と他の期待は変えていない。実測: r2〜r4・r5〜r10 で通過） |
| 同⑤ | FREQ-532 AC-01〜AC-04。会員とゲストの混在・別ID（同じメールでも）・別住所の行は選べず案内が出る。同じ会員はメールが違っても同梱できる。窓口を直接呼んでも `GROUP_G_SLIP_CUSTOMER_MISMATCH`・`GROUP_G_SLIP_ADDRESS_MISMATCH` の文で断られる |
| 同⑥⑦⑧ | FREQ-531 AC-03・FREQ-533 AC-02・AC-03。同じ行を選んだ2つの下書きは、荷作り表に別の票の番号が出て、先に確定した後の確定が `GROUP_G_SLIP_QUANTITY_EXCEEDS_READY` の文で止まり何も増えない。棚卸減で準備中の数が減ると票の行に知らせが出て発送票確認が押せず、窓口を直接呼んでも断られる。確定の二重押下は通信1回・発送1つ・メール予定1つで、応答が届かない時は「もう一度確かめる」が同じ要求番号で送り直し二重にならない |
| 同⑨ | FREQ-540 AC-10。サポーター（初期値）は荷作りと発送ができ、店長が `admin.shipping.manage` を外すと表だけ見えて選択欄・発送が無く権限の文が1回出る（DBの関数も403の固定の文で断る）。戻すと選べる |
| [FR-ADMIN-120](../../../e2e/FR-ADMIN-120-combined-shipment-emails.spec.ts) | FREQ-533 AC-03・AC-05・FREQ-534 AC-01・FREQ-541 AC-03。同じ会員の2注文（宛先のメールは注文ごとに別）を1つの票で確定し、手元のMailpitで注文ごとに1通だけ届く。各メールはその注文の品物と数・残りの案内だけで、同じ票の別の注文の注文番号・品物・メールアドレスが無い。同じ要求の再送・画面の再読込・毎分の処理を重ねてもメールが増えず、通知を外した票には届かない。番号なしの票のメールは追跡欄が無く、画面で後から番号を入れると更新メールが注文ごとに1通届き「先にお知らせした伝票番号は使えません」は入らない。本物のお客様のログインで、注文の窓口・画面と注文状況の頁（確認の前後）に別の注文の情報が出ない |
| [FR-ADMIN-123](../../../e2e/FR-ADMIN-123-group-g-permissions.spec.ts) G-3 の節 | FREQ-540 AC-10・FREQ-534 AC-05・FREQ-531 AC-04。①本物の窓口11メソッドは未ログインで401、②お客様の本物のログインで403。③サポーター（初期値）は荷作り表と票を操作でき、出荷日の訂正は画面が案内の文だけを出し、窓口を直接呼ぶとDBの関数が断る（票の版と履歴は不変）。④店長が `admin.shipping.manage` を外すと票は見られるが確定・破棄・新しい下書き・取消が断られ、戻すと取消も確定も通る。⑤ `admin.shipping.read` を外すと荷作り表と票の頁は権限の文だけ。⑥旧4つの発送の入口は差し替えないHTTPの404（G-4 Task 10）。DB旧関数拒否はgroup_g1_legacy_disabled。⑦サポーターと店長の管理メニューに PACKING があり SETTINGS はサポーターに無い。G-2 の管理メニューの case には PACKING の期待を足した |
| 再開: [FR-ACCOUNT-041](../../../e2e/FR-ACCOUNT-041-delivery-without-tracking.spec.ts)・[042](../../../e2e/FR-ACCOUNT-042-delivery-tracking.spec.ts)・[043](../../../e2e/FR-ACCOUNT-043-delivery-visibility.spec.ts)・[FR-ADMIN-104](../../../e2e/FR-ADMIN-104-delivery-tracking-settings.spec.ts) | FREQ-534 AC-01・AC-02・FREQ-541 AC-03・FREQ-494。G-1 で止めていた6箇所の `test.skip` を外し、期待は変えずに材料だけ付け替えた。発送の材料（`shipFixture`・`createShippedFixture`）は発送票（下書き→確定の公開関数）を経由し、`markDeliveredInDb`・`editTrackingInDb` は発送が属する票を引いて票単位の公開関数を呼ぶ（票を持たない発送には使えない）。`createAdminActor` は役割 admin を付ける。過去の届いた日が要る材料（`deliveredAt`）だけ従来の合成の発送を残す。FR-ADMIN-104 の「追跡がオフの間も…」は本文の無い skip だけの case だったので、発送票の画面で伝票番号の直しと手の配達済みをし、17TRACK へ呼び出しが無いことを確かめる本文を書いた |
| 旧い案内の文の期待: [FR-ADMIN-050](../../../e2e/FR-ADMIN-050-order-shipping.spec.ts)・[051](../../../e2e/FR-ADMIN-051-order-refund-safety.spec.ts)・[061](../../../e2e/FR-ADMIN-061-order-list-review-states.spec.ts)・[069](../../../e2e/FR-ADMIN-069-made-to-order-completion.spec.ts)・FR-ADMIN-123 の G-1 の節 | 旧 FREQ-541 AC-04（案内文の置換を指した当時の記録。現在の AC-04「停止31箇所の処置」とは別）。Task 3 で置き換わった注文の一覧の上の案内（「発送は荷作り表から行います。」）と履歴の上の案内の文へ、期待の文だけを直した（「表の外に1回」の期待は同じ）。FR-ADMIN-082 の同じ期待は Task 11 の r1 の直しで直した（停止中の case は Task 12 で削除した） G-4 Task 11では051・061・082を詳細へ付け替え、旧一覧の案内1回の期待を発送欄の「荷作り表を開く」Linkと旧発送入口の不在へ変更。詳細の履歴の案内は埋め込み欄で保持。 |

[e2e/shipping-test-utils.ts](../../../e2e/shipping-test-utils.ts) の `mockShippingUiBridge` は `/api/admin/packing`・`/api/admin/shipment-slips**`・注文の履歴を実行者つきで公開関数へ橋渡しし、`createShippingMaterial`（会員/ゲスト・古い注文日・配送先・入金日・割当）、`holdPaymentReview`、`createExchangeFeeMaterial`、`createDraftInDb`・`shipMaterialsInDb`、`readSlip`・`readOutbox`・`fulfillmentsOf`、荷作り表の1回の読み（`readPackingSnapshot`・`packingIndexOf`）と、その位置から自分の行を開く `revealPackingRow`、`withShippingScenario`（終わりに作った下書きを破棄し、発送されずに残った準備中の品を合成の発送で閉じる）を持つ。bridge が返す「操作できるか・出荷日を訂正できるか」の表示用の値は、実行者の有効な役割の権限をDBの表から読んで窓口と同じ組で作る（許否には使わない）。単体は [group-g1-test-utils](../../../tests/unit/e2e/group-g1-test-utils.test.ts) が、`markDeliveredInDb`・`editTrackingInDb` の置き換えを偽のDBで確かめる。

## 発送票の操作・出荷日のE2Eと、止めていた旧の発送のE2Eの移設（G-3 Task 12）

確認日: 2026-10-26。ここに書くE2Eはcontrollerが本番ビルドで手元のSupabaseに対して流す（実装者は型・lint・単体・文書の確かめまで）。材料と橋渡しは Task 11 の [shipping-test-utils](../../../e2e/shipping-test-utils.ts) を使い、足したのは `createShippingMaterial` の決済の番号（`paymentIntentId`。返品・発送後の返金を作る case だけが渡す）と、画面なしで窓口を呼ぶ `callShippingApi`（bridge の中核を直に呼ぶ。拒否の答えや履歴の形、境界の組合せに使う）だけ。各specは390/768/1280pxの3幅で流す。材料の処置（過去の入金日・合成の過去の発送）は `.superpowers/sdd/2026-10-25-group-g3-shipping/e2e-disposition.md`。

controller の実測（今回のレビュー修正より前）:

| 実行 | 条件 | 結果と処置 |
| --- | --- | --- |
| t12r1 | 本番ビルド、`--workers=1`、14 spec | 193 passed / 6 failed。失敗は FR-ADMIN-117 ②③ × 3幅。DB の実際の拒否に合わせて期待を `INVALID_EMAIL_KIND` に修正 |
| t12r2 | FR-ADMIN-117・118、4 workers | 71 passed / 2 failed。失敗は FR-ADMIN-117 ⑤ の mobile・tablet。取消拒否の前後比較から、並行する追跡設定・毎分の処理で動く `registration` を除外し、取消による停止が無いことは別に確認 |
| t12r3 | FR-ADMIN-117・118、4 workers | 73 passed / 0 failed。117・118 の15 case × 3幅 = 45件と、常に走る `isolated-global` project の28件 |
| t12r4 | t12r3 と同じ条件で続けて実行 | 73 passed / 0 failed（45件 + `isolated-global` の28件） |

レビュー修正の後: t12r5（FR-ADMIN-116・117・118・120、4 workers）は 118 passed / 3 failed（118 ④ × 3幅。手数料待ちの交換品は割当が付かず荷作り表に出ないため、下書きの拒否は `GROUP_G_SLIP_QUANTITY_EXCEEDS_READY`。設計の「発送準備中だけを表示」「手数料待ちは自動割当と発送の対象外」に合わせて期待を直した）。t12r6（同じ4 spec、4 workers）は 121 passed / 0 failed（116 30件・117 24件・118 21件・120 18件の93件と `isolated-global` の28件）。

| 試験 | 対象と期待 |
| --- | --- |
| [FR-ADMIN-117](../../../e2e/FR-ADMIN-117-shipment-slip-actions.spec.ts)① | FREQ-534 AC-01・FREQ-488 AC-01・AC-03。番号なしで確定した票で、運送会社を選ぶまで送れず、運送会社と番号を入れると票と全注文の発送へ反映される（直しの記録は前の値が空）。更新のメールは注文ごとに1通（番号を初めて入れたので「使えません」の行は無い）。同じ値では直せず、断りの文がダイアログの中に出て何も増えない |
| 同② | FREQ-534 AC-01・FREQ-488 AC-01〜AC-03・FREQ-492 AC-01・AC-04。配達済みだった票（メールあり）の番号を、通知を外して直すと配達済みの記録が消えて受付済みに戻り（品物は配達済み→発送済み・返品の期限は発送の日の目安へ・配達済みのメールは1通のまま）、訂正のメールは作られない。通知を入れてもう一度直すと更新メールが注文ごとに1通届き「使えません」の行が入る。荷物の履歴に前後の番号が残り、注文の履歴に直した記録（前→後・通知の選択）が残る。更新のメールの行に再送の入口が無く、DBの再送の関数も種類として受けず `INVALID_EMAIL_KIND` で断る（窓口はDBの前に409で断る〔route の単体〕） |
| 同③ | FREQ-534 AC-02・FREQ-489 AC-01〜AC-03・FREQ-492 AC-01・AC-04・FREQ-503 AC-01。手動の配達済みで全注文が配達済みになる。届いた日の初期値は今日で上限が付き、発送した日より前・今日より後は断られる。配達済みのメールは注文ごとに1通で、届いた日・その注文の品物・注文の画面のリンクが入り、別の注文の情報と旧会員用のリンクは入らない（再送の入口は無く、DBの再送の関数も `INVALID_EMAIL_KIND` で断る）。返品の期限は届いた日から数える。配達済みの票に「配達済みにする」は出ず、もう一度は `GROUP_G_SLIP_ALREADY_DELIVERED`。発送の通知を外した票は、画面の選択がオンでも配達済みのメールを作らない |
| 同④ | FREQ-534 AC-03・FREQ-533 AC-04・FREQ-443 AC-01〜AC-04・FREQ-489 AC-03。メールの予定を取り置いた同梱の票を取り消す。「戻る」では取り消さない。取消で全注文の品物が発送準備中に戻り、全部送っていた注文は決済完了に戻って出荷日時が空になり、手元の在庫が発送前と同じに戻る（空きは動かない）。まだ送っていない発送のメールは取りやめ、取消のメールは1通も届かない。履歴に取消の行が残り、取り消した票にはどの操作も出ず、再操作は断られる。同じ品物を新しい票で送り直せ、発送番号は使い回さない。送った後に取り消してもお客様にメールは行かない |
| 同⑤ | FREQ-534 AC-03・FREQ-471 AC-01・AC-02・FREQ-454 AC-02。受付中の返品がある注文を含む同梱の票は、理由の一覧と断りの文が取消のダイアログの中に出て票は変わらない。その返品を取り消すと取り消せる。完了した返品（お返しで終えた）がある票は窓口を直に呼んでも断られる。2回に分けた発送のうち、発送後の返金（2点）を下回る最初の票は `GROUP_G_SLIP_REFUNDED` で断られ、下回らない次の票は取り消せる |
| 同⑥ | FREQ-534 AC-04・FREQ-541 AC-03・FREQ-488 AC-01・FREQ-489 AC-02・FREQ-493 AC-01。追跡オン（偽の 17TRACK）の2注文の票は、登録の行が代表の発送だけに1つで、外への呼び出しは登録と読み直しだけ。読み直しの輸送中・配達済みが両方の注文に反映され、参加の注文の履歴にも同じ票の発送の行と届いた日の出どころ「追跡」が出る。追跡オフでは登録も外への呼び出しも無いまま、伝票番号の訂正と手動の配達済みが票の全注文にでき、履歴の届いた日の出どころは「手で」 |
| 同⑦ | FREQ-540 AC-10・FREQ-534 AC-05。店長が `admin.shipping.manage` を外すと、サポーターは票を見られるが伝票番号・配達済み・取消が403の固定の文で断られ（画面もダイアログの中に出す。窓口を直に呼んでも同じ。票の版は動かない）、旧の発送の窓口は呼ばれない。戻すと同じ画面からできる。旧4つのHTTPはmockなし404に変更（G-4 Task 10）。旧DB関数の固定拒否はgroup_g1_legacy_disabledへ分担。変更後E2E未実行 |
| 同⑧ | FREQ-533 AC-01・FREQ-534 AC-05・FREQ-493 AC-01・FREQ-471 AC-02。G-4 Task 10で荷作り表の注文IDを `/admin/orders/{id}` のLinkとして確認し、詳細の「変更履歴」へ進む導線に付け替えた。題と他の期待は維持: 発送の行（配送業者・伝票番号・届いた日と出どころ「手で」）、直した記録（前→後・通知の選択）、取消・番号の訂正・配達済みの旧入口が無く案内の文だけ、発送の行の「発送票 … を開く」から票の頁へ移る。変更後E2E未実行 |
| [FR-ADMIN-118](../../../e2e/FR-ADMIN-118-shipment-dates.spec.ts)①〜④ | FREQ-535 AC-02。出荷日の初期値は日本時間の今日で、確定すると初回の履歴（今日→出荷日。初期値から変えた時も）が残り、発送した時刻は確定した時刻のまま。入金日（日本時間）より前と今日より後は確定できず（画面と窓口）、日本時間 23:59:59 の入金はその日から、0:00:00（UTC では同じ日）の入金は翌日から確定できる。複数注文の票は最も遅い入金日が下限。④は本物の交換返品の受取で、手数料待ちの交換品が未割当・受注生産中のため荷作り表のスナップショットに無い（位置 -1）ことと、直接の下書きが409・`GROUP_G_SLIP_QUANTITY_EXCEEDS_READY`・対応する文の完全一致で断られることを確かめる。後から手数料を入金すると、最大30秒のスナップショットのポーリングで準備数・発送可能数が各1点の行を確認し、`orders.paid_at` と出荷日の下限は元の入金日のままであることを確かめる |
| 同⑤⑥ | FREQ-535 AC-03・AC-04・FREQ-540 AC-10。店長は確定後に理由つきで出荷日を訂正でき（理由が空は送らずに止める）、票と全注文の発送の出荷日が変わり、履歴に前後の日付と理由が残る。同じ日・入金日より前・今日より後・空白だけの理由は窓口を直に呼んでも断られ、何も変わらない。サポーター（初期値）は案内の文だけでボタンが無く、DBの関数も断る。配達済みの日より後への訂正は `GROUP_G_SHIPMENT_DATE_AFTER_DELIVERY` で断られ、同じ日は通る（届いた日が今日より前の票は合成の過去の発送を票に付けて作る） |
| 同⑦ | FREQ-535 AC-04。出荷日を過去にして確定しても、返品の期限は発送した時刻（今日）から数え、出荷日の訂正を重ねても変わらない。手で配達済みにすると届いた日から数え、その後に出荷日を訂正しても変わらず、発送した時刻・届いた時刻も動かない |

止めていた旧の発送のE2E（`G-1: 旧配送操作停止` の skip 25箇所）の処置は、元のケースを削除して上のケースと拡張した [FR-ADMIN-116](../../../e2e/FR-ADMIN-116-packing-shipment-slips.spec.ts)・[120](../../../e2e/FR-ADMIN-120-combined-shipment-emails.spec.ts) へ移した。移設先が元の期待を含むことは、足した期待で確かめた: 116 ①（発送前に返金した行は出ず、一部返金は残りの数だけ。窓口を直に呼んでも送らせない）、②（開いた後に止めが付いた行を選んで発送すると断りの文が画面の中に出る）、③（「お客様に発送のメールを送る」は最初から入り、外した発送のメールの予定は作られない）、④（運送会社と伝票番号を入れて確定すると全注文の発送と注文に入る）、⑧（応答が届かない時と500番台の時に二重にならない）、⑩（送る数が0や準備中を超えると発送が押せない）、120 ①（発送のメールの予定は自動の1行ずつ）、②（値段は書かない・同じ注文の残りを別の票で送った2通目に残りの案内は入らない）。ファイルのケースが全部移ったもの（FR-ADMIN-066・068・071・100・101）は、docs のリンク先を保つためケース0のファイルで残した（FR-ADMIN-050・072・082・088・093 には元から止めていなかったケースだけが残る）。整合の確かめ（`delivery-status-traceability`・`order-status-traceability`）は、移設先の FR-ADMIN-117 を指すように直した。また、`order-fulfillment-test-utils` の旧の発送の画面の材料（`shipMaterials`・`materialLine`・`READY_PROGRESS`）と、`return-test-utils` の `exchangeMaterialLine`・`RETURN_TEXT.shipHold`・`shipHoldRefusal`・`hasReturnRefusal` は、削除したケースだけが使っていたので消した。

DB結合 [group_g3_cancel](../../../tests/integration/db/group_g3_cancel.integration.test.ts) の「配達済みの票も取り消せ、delivered→ready に戻る」は、直接の `UPDATE` で配達済みにしていたのを、手動の配達済みの書き手 `admin_mark_shipment_slip_delivered` に替えた（配達済みの出来事・状態の差分・票の版の行が本物と同じに残る。票は版3になるので取消は版3を渡す）。ローカルDBで `group_g3_cancel` 41/41 成功（2026-10-26）。

## 開店前のセキュリティの穴 波 2 のテスト（権限・検索・制約・置き場。SEC-HOME・AUTH・LOOK・NEWS・SEARCH・STOCKIST・ADMIN）

確認日: 2026-10-27（この節は波 2 の分。並びは時系列でなく、下の波 1-B・1-C の前に置く）。波 2 は移行 6 本（`20261026130100`〜`130600`）と、取扱店・ニュースの管理の書き込みを認可の後に service role へ寄せる窓口の変更、LOOK の PUT を `admin_update_look` の rpc 1 回にする変更を入れた。移行は本番未適用（本番は G-4 と一緒に当てる・オーナーの確認の後）。**実測（2026-10-27）**: 手元の `npm run db:reset` の後、DB 結合は `DATABASE_URL` を 54322 に向けて `--runInBand` で 144 suite 通過・13 skip・0 失敗（4339 件通過・14 skip・1 todo）。DB なしの jest 全体は 19704 件通過・0 失敗。本番ビルドの E2E 全件（1 回）は 414 failed・4602 passed・26 skipped で、G-3 の 175 failed より多いが、増えた赤は G-4 の注文・返品の E2E か、再実行で通る揺れだった。下の E2E の列に挙げた波 2 の対象ファイルは全件が期待どおり（赤なし。詳細は `.superpowers/sdd/2026-10-25-security-gap-fixes/e2e-results-wave2-full.json`）。

### 新しく作った試験ファイル

| ファイル | 先頭の ID | 確かめること |
| --- | --- | --- |
| [staged-supabase.test.ts](../../../tests/unit/helpers/staged-supabase.test.ts)（道具: `tests/helpers/staged-supabase.ts`） | （補助の単体。ID なし） | `findMigration`・`readMigration`・`resolveSeedPath`。`supabase/migrations/` と `supabase/pending-wave2/` の両方にあれば前者を返す。移行を名前の末尾で探すので、時刻を付け替えても結合試験は動く |
| [stockist_type_optional](../../../tests/integration/db/stockist_type_optional.integration.test.ts) | `DATA-STOCKIST-001` | 130100。`type` が NULL 可・CHECK が残る・NULL と正しい値は入り、未知の値は 23514（DB なしの移行の形を含む） |
| [home_items_grants](../../../tests/integration/db/home/home_items_grants.integration.test.ts) | `DATA-HOME-001` | 130200。`items` の公開 21 列だけを anon・authenticated が読める・原価 2 列は読めない・`item_cost_history` は `admin.finance.read` だけ。`finalize_order_from_checkout_draft` は退役済みで無いこと、後継の `place_order_from_checkout_draft` は service_role だけが EXECUTE できることも確かめる（古い前提を直した） |
| [look_grants_admin_tables](../../../tests/integration/db/look_grants_admin_tables.integration.test.ts) | `DATA-LOOK-003` | 130300。`looks`・`look_items` は anon・authenticated が SELECT だけ。連番 `looks_id_seq` の権限が PUBLIC・anon・authenticated に無い（2026-10-27 追加） |
| [news_grants_admin_tables](../../../tests/integration/db/news_grants_admin_tables.integration.test.ts) | `DATA-NEWS-002` | 130300。`news_articles` の SELECT だけと、連番 `news_articles_id_seq` の権限が無いこと（2026-10-27 追加） |
| [stockist_grants_admin_tables](../../../tests/integration/db/stockist_grants_admin_tables.integration.test.ts) | `DATA-STOCKIST-002` | 130300。`stockists` の SELECT だけ。連番 `stockists_id_seq` は service_role が USAGE・SELECT だけ（UPDATE が無い）で、anon・authenticated に無い |
| [admin_item_color_presets_grants](../../../tests/integration/db/admin-misc/admin_item_color_presets_grants.integration.test.ts) | `DATA-ADMIN-005` | 130300。`item_color_presets` は authenticated の SELECT だけで anon は何も持たない。連番 `item_color_presets_id_seq` の権限が無い（2026-10-27 追加） |
| [look_constraints](../../../tests/integration/db/look_constraints.integration.test.ts)・[news_constraints](../../../tests/integration/db/news_constraints.integration.test.ts) | `DATA-LOOK-001`・`DATA-NEWS-001` | 130500。CHECK 7 本が `NOT VALID` で足され（`convalidated` が偽）、長さの超過と外の道筋（`other/x.png`・`https://…`・改行を含む要素・NULL 要素）の INSERT・UPDATE が 23514 で断られる |
| [look_update_function](../../../tests/integration/db/look_update_function.integration.test.ts) | `API-LOOK-004`・`DATA-LOOK-001` | 130500。`admin_update_look` が SECURITY INVOKER・`search_path = ''`・service_role だけ EXECUTE。更新前の `image_urls` を返す・NULL なら今の画像を保つ・関連の段の失敗で行の更新も巻き戻る・同時の更新が順に走る（別接続に commit するため、プロセスが死ぬと `integration-look-update-lock-*` の行が残りうる） |
| [auth_grants_inventory](../../../tests/integration/db/auth_grants_inventory.integration.test.ts) | `DATA-AUTH-006` | 公開スキーマの権限の一覧。波 2 の移行が `ALTER DEFAULT PRIVILEGES` を使わないこと（DB なし 15 本）、広い権限が残る表の「既知の例外」の一覧、台帳・保管の表（`legal_archive_runs`・`order_revisions`・`stripe_*` 3 表）の書き込み系 7 権限が anon・authenticated に無いこと、`order_revisions_id_seq` の権限が無いこと、`legal_archive_runs` の authenticated の SELECT が残ること（2026-10-27 追加）。「既知の例外」の一覧は変えていない |
| 補助 [admin-table-grants.ts](../../../tests/integration/db/helpers/admin-table-grants.ts)・[legacy-image-rows.ts](../../../e2e/legacy-image-rows.ts) | （補助） | 4 本の権限の試験が共有する確かめの道具。`insertLegacyImageRow` は CHECK より前の旧い行を、制約を外す取引の間だけその表に ACCESS EXCLUSIVE の鍵を短く取って作る（波 3 の署名の試験用。並列 E2E での待ちは実測していない） |

### 書き換えた試験

| 領域 | ファイル | 変えたこと |
| --- | --- | --- |
| STOCKIST | `db/stockist_table`・`stockist_rls`・`stockist_permissions` | `type` の `is_nullable` は YES、必須の列から `type` を外し、「種別を省いた作成は 23502」を「通り NULL」に書き換えた（Task 2）。管理者の JWT の書き込みは 42501 に直し、service_role で通る確かめは新しい権限の試験（`DATA-STOCKIST-002`）へ移した（Task 5） |
| AUTH | `db/auth_sessions_table`・`auth_password_reset_tokens_table` | anon・authenticated は表に権限が無い（42501）。service_role で確かめる |
| ADMIN | `db/admin-misc/admin_rls_policy`・`admin_audit_logs_table`・`admin_revoke_sessions_function`・`admin_item_color_presets_table` | 同上。色見本は authenticated の SELECT だけ・anon は 42501 |
| LOOK | `db/look_rls`・`look_permissions`・`look_table`・`look_images_bucket` | 書き込みの権限の誤り。`look_items` の読みが「親の LOOK と商品の両方が公開」。見本の画像の道筋を `looks/…` の形に。置き場の期待が「上限なし」から 5 MiB・4 種類（`DATA-LOOK-005`） |
| NEWS | `db/news_articles_rls`・`news_permissions`・`news_articles_table`・`news_status_state`・`news_images_bucket` | 同上（置き場は `DATA-NEWS-004`）。道筋を `news/…` の形に |
| SEARCH | `db/search-functions`（`DATA-SEARCH-001`） | 上限 8（21・10000・NULL・0・負数も 8 以下）、検索語 100 字、`\` 先逃がし、`search_public_*` が anon・authenticated に 42501、移行の形を 4 本足した |
| 窓口 | 結合 `api/{stockist,news}-admin-*`・`api/look-admin-{item-put-api,write-path}`・`api/{look,news}-image-signing`、単体 `api/admin/{stockists,news,looks}` と `stockists-security`・`looks-audit`、`tests/unit/scripts/e2e/seed-storage` | 取扱店・ニュースの書き込み 4 窓口（POST・PUT・PATCH・DELETE）が認可（`authorizeAdminPermission`）の後に service role を使う（`DD-STOCKIST-034`・`035`、`DD-NEWS-065`）。news DELETE は service role の client を行の削除の前に作り、作れなければ 500（行も置き場も触らない）。LOOK の PUT は `admin_update_look` の rpc 1 回（更新前の画像を返す）。見本の seed-storage の道筋 |

### E2E で外した `test.fail`（27 行）と補助の変更

外した行は 10 ファイルの 27 行。本番ビルドの E2E 全件（2026-10-27）で、これらのファイルは全件が期待どおり（赤なし）だった。

| ファイル（`e2e/FR-...`） | 外した要件 ID |
| --- | --- |
| `STOCKIST-013` | FR-ADMIN-006-AC-02、FREQ-18-AC-01 |
| `HOME-024` | SEC-HOME-003-AC-02、SEC-HOME-004、SEC-HOME-005、SEC-HOME-020 |
| `LOGIN-031` | SEC-AUTH-011-AC-01 |
| `LOOK-SEC-002` | SEC-LOOK-002-AC-01・AC-02、SEC-LOOK-003-AC-02、SEC-LOOK-004-AC-01・AC-02、SEC-LOOK-005-AC-01、SEC-LOOK-010-AC-02、SEC-LOOK-023-AC-01 |
| `LOOK-SEC-004` | SEC-LOOK-015-AC-01 |
| `NEWS-SEC-002` | SEC-NEWS-002-AC-02、SEC-NEWS-010-AC-01・AC-02、SEC-NEWS-025-AC-01、SEC-NEWS-022-AC-01 |
| `SEARCH-020` | SEC-SEARCH-007、SEC-SEARCH-008 |
| `SEARCH-021` | SEC-SEARCH-003 |
| `STOCKIST-016` | SEC-STOCKIST-003-AC-02・AC-03（AC-03 は失効の前の update も断られる形に直した。失効の前後で結果が同じ） |
| `ADMIN-MISC-005` | SEC-ADMIN-002-AC-01 |

残した `test.fail` は波 5 以降の物（`SEC-HOME-003-AC-01`、`SEC-LOOK-003-AC-01`、`SEC-NEWS-002-AC-01`・`AC-03`、`SEC-STOCKIST-003-AC-01`、`SEC-ADMIN-002-AC-02`、`SEC-AUTH-005`・`010`、`SEC-SEARCH-015`・`016`、`SEC-STOCKIST-019` など）。見本の画像の道筋が `items/e2e/`・`looks/e2e/`・`news/e2e/` に変わったので、画像を見る `FR-LOOK-ALL-042`・`044`、`FR-LOOK-DETAIL-019`、`FR-LOOK-SEC-001`・`005`、`FR-NEWS-SEC-001`・`003`、`FR-NEWS-DETAIL-009`、`FR-NEWS-ALL-018` と、補助 `e2e/home-grant-test-utils.ts`・`home-test-utils.ts`・`look-admin-test-utils.ts` も合わせた。

### 本番へ当てる前の確認

DB 結合の「DB なしの形」の試験は `supabase/migrations/` の 6 本の文面を読む。本番へ当てる前後の読むだけの確認と、本番で何が変わるか（`order_revisions_id_seq` のみ実変更・台帳系の 5 表は本番では変化なし）は [移行運用](../../06_Operations/db-migrations.md) の「波 2 権限・検索・制約・置き場の移行 6 本」に書いた。

## 開店前のセキュリティの穴 波 1-B のテスト（SEC-AUTH・SEC-ADMIN・SEC-STOCKIST・SEC-NEWS・SEC-HOME）

確認日: 2026-10-26。波 1-B（認証の窓口・登録と確認・管理の窓口・取扱店・お知らせ・ホーム）で書き直した試験をまとめる。単体・結合は実装者が流して通した（Task 1〜8 の報告。最後の確認は Task 9 の `--findRelatedTests` で 135 スイート 3121 件通過）。**E2E・DB 結合は書いただけで流していない**ので、下の E2E の列は controller の本番ビルドでの実測の後に確かめる（外した `test.fail` が緑になること）。試験名の先頭の ID は `validate-trace` の層の決まりに合わせた（単体・結合に `SEC-` を付けると `wrong-test-level` になるため、`DD-`・`API-`・`ARC-` にした）。対応表（`docs/05_Quality/reports/`）は `npm run trace:report` で作り直す。

### 新しく作った試験ファイル

| ファイル | 先頭の ID | 確かめること |
| --- | --- | --- |
| [amr.test.ts](../../../tests/unit/lib/auth/amr.test.ts) | `DD-AUTH-030` | `hasSecondFactorAmr`（通行証の `amr` に 2 段目の方法があるか）。password だけでは偽（SEC-AUTH-031 の局所版） |
| [revoke-user-sessions.test.ts](../../../tests/unit/lib/auth/revoke-user-sessions.test.ts) | `DD-ADMIN-003` | `revokeAllSessionsForUser`。アプリの `sessions` の失効の誤りと RPC `revoke_auth_sessions_for_user` の誤りをそれぞれ投げる（SEC-ADMIN-007・014） |
| [stockist-schemas.test.ts](../../../tests/unit/features/stockist/stockist-schemas.test.ts) | `DD-STOCKIST-034` | `stockistWriteSchema` の許可の字・拒否の字、`toInvalidStockistResponse` が `fields` だけを返し `details`・入力の値を含まないこと（SEC-STOCKIST-011・014）。電話の末尾の改行は `trim()` が先に取り除くので通り、途中の改行は拒む |

### 窓口の単体（`tests/unit/api/`）

| ファイル | 先頭の ID | 確かめること |
| --- | --- | --- |
| auth: `mfa-verify-route`・`mfa-enroll-totp-route`・`refresh-route`・`otp-verify-route`・`confirm-route`・`register-route` | `DD-AUTH-015`（otp）・`018`（register）・`019`（confirm）・`027`（refresh）・`030`（enroll-totp）・`031`（mfa-verify） | MFA 検証の利用者単位の枠と監査（429・404・challenge の誤り・コードの誤り・成功・保存の失敗。本文 400・401/503・403 は書かない）、初回 TOTP の `amr` の確かめ、refresh の `{ ok: true }`、OTP の `{ user:{id,email,role}, message }`、`confirm` の `type` が `signup` 以外で `verifyOtp` を呼ばないこと・別のブラウザで session を作らず `signOut(local)` すること、`register` の管理の鍵の枝が無いこと・宛先単位の枠（5 回/3600 秒）・201 の本文 |
| admin: `revoke-user-sessions-route`・`mfa-reset-route` | `DD-ADMIN-003`・`DD-ADMIN-005` | 認可失敗の監査の上限（10 分 20 行）、管理者単位の枠、UUID・自分自身・存在しない利用者、MFA リセットの `user_roles` 判定・理由のハッシュだけを監査に残すこと・全 session の失効 |
| admin: `create-user-route`・`item-color-presets-route`・`item-color-presets-id-route` | `DD-ADMIN-002`・`DD-ADMIN-011`・`DD-ADMIN-012` | 認可の後の枠（認可で断った要求は数えない）、壊れた JSON は 400、パスワードの長さと漏洩の確かめ、色見本の id の形と 0 行の 404 |
| admin: `admin-contact-route`・`admin-contact-id-route`・`admin-contact-reply-route`・`admin-contact-templates-route`・`admin-contact-templates-id-route`・`audit-logs-route` | `DD-ADMIN-006`（一覧）・`007`（詳細・状態）・`008`（返信）・`009`（テンプレート）・`010`（テンプレート `[id]`）・`004`（監査ログ） | 読み出しの記録（`admin.contact.list`・`admin.contact.read`・`admin.audit_logs.read`。記録が拒まれても 200）、`submitted_ip`・`user_agent` を返さないこと、UUID でない id と 0 行の 404、返信の件名の制御文字・状態の更新の誤り・送り手の設定なし |
| stockists・news: `stockists-route`・`stockists-id-route`・`news-admin-id-route`・`news-public-service`・`news-route` | `DD-STOCKIST-034`・`035`（stockists の route 2 本）、`DD-NEWS-065`（管理 `[id]`）・`003`（公開の取り出し）・`004`（`/api/news`） | 管理の列の絞り・0 行の 404 と failure の監査・`fields` だけの 400・壊れた JSON。お知らせの公開の取り出しが service role と署名を使わず、応答に `image_url` が無いこと。管理のお知らせの変更の 0 行・形の悪い id（18 桁の境界）の 404 |
| ほか: `stockist-public-service`（取扱店の公開の取り出し。`createPublicClient` と上限 200）、`home-page.test.tsx`（ITEM を 8 件取る）、`login-page.test.tsx`・`auth-tabs.test.tsx`（`/login?registered=1` の案内）、`PublicNewsGrid.test.tsx` | `DD-STOCKIST-003`・`DD-HOME-001`・`DD-AUTH-001`（login-page）・`DD-AUTH-010`（auth-tabs）・`DD-NEWS-001` | 公開の取り出しの件数の天井、ホームの取得件数、確認リンクを別のブラウザで開いた後の案内（`role="status"`。タブを替えても残る） |

控えの結び付け（SEC-AUTH-007）は `tests/unit/features/auth/return-intent/return-intent-store.test.ts`（`DD-AUTH-033`。bindTo 付きのハッシュの式）と `return-intent-service.test.ts`（`DD-AUTH-034`。`alwaysCreate`・`consumeSignupBinding`・`resolveStoredDestination`）で確かめる。

### 結合（`tests/integration/`）

| 領域 | ファイル | 確かめること |
| --- | --- | --- |
| AUTH | `api/auth/{mfa-verify,refresh,otp-verify,confirm,register,register-enumeration,return-intent-flow}`、`api/auth-{mfa-verify-api,mfa-enroll-totp-api,admin-totp-flow,otp-verify-api,bot-rate-limit,password-rule}`、`api/auth.test.ts`、`auth-flow.test.ts`、`ui/auth-register-flow.test.tsx` | MFA 検証の 6 回目が 429、`amr: otp` の通行証だけが初回 TOTP を登録できる、応答の本文、`confirm` の登録を始めたブラウザだけが session を作る往復（別のメール・Cookie 無し・使用済み・期限）、`register` の管理の鍵が効かない・宛先の枠の数え方と順番 |
| ADMIN | `api/admin/{revoke-user-sessions,audit-logs}`、`api/admin-misc/{admin-mfa-reset-api,admin-audit-write,admin-authorization-path,admin-origin-guard}`、`api/admin-create-user-api`、`api/admin-item-color-presets-{save,delete}-api`、`api/admin-contact-{detail,list,reply,status,templates-create,templates-update,templates-delete}-api` | 窓口ごとの枠（`@/features/auth/middleware/rateLimit` を差し替え）、UUID・0 行の 404、読み出しの記録、MFA リセットの失効。`admin-origin-guard` の回数を数える窓口の一覧に 10 窓口を足した |
| STOCKIST | `api/stockist-admin-{create,item-get,item-put,item-patch,item-delete,list}-api`・`api/stockist-admin-write-path`・`api/stockist-admin-guards`（後ろの2本は末尾に `-api` が付かない）、`ui/stockist-public-read-path.test.tsx` | 8 列、404 + failure の監査（success を書かない）、`fields` の 400、公開の取り出しが `createPublicClient` |
| NEWS・HOME | `api/news-{public-api,image-signing,admin-item-put-api,admin-item-patch-api,admin-item-delete-api,admin-write-path,latest-action}`、`api/home-page-{public-read,proxy-csp}`、`ui/news-*`・`ui/home-page-*` | 公開は署名も service role も使わない、管理の 0 行・不正 id の 404、ホームの取得が 8 件（お知らせは service role を作らない） |

DB 結合は新しく書いていない。控えのハッシュの式は DB の関数が中身を知らないので `tests/integration/db/auth_return_intents.integration.test.ts` に足していない。

### E2E で外した `test.fail`（38 行。実測は controller の実行後）

`git diff -U0 HEAD -- e2e` で数えた（`test.fail(` の削除 39 行のうち 1 行は文面だけを直して残した）。

| ファイル（`e2e/FR-...`） | 外した要件 ID |
| --- | --- |
| `ADMIN-MISC-002` | SEC-ADMIN-008-AC-02、SEC-ADMIN-012-AC-01、SEC-ADMIN-013-AC-01、SEC-ADMIN-013-AC-02 |
| `ADMIN-MISC-003` | SEC-ADMIN-007-AC-01、SEC-ADMIN-008-AC-01、SEC-ADMIN-014-AC-01・AC-02、SEC-ADMIN-015-AC-01・AC-02 |
| `ADMIN-MISC-004`・`006`・`007` | SEC-ADMIN-023-AC-01、SEC-ADMIN-020-AC-01・SEC-ADMIN-021-AC-01、SEC-ADMIN-006-AC-01・AC-02・SEC-ADMIN-018-AC-01 |
| `HOME-023` | SEC-HOME-013 |
| `LOGIN-030`・`LOGIN-032` | SEC-AUTH-022（本文）、SEC-AUTH-009-AC-01・AC-02、SEC-AUTH-031-AC-01 |
| `SIGNUP-002`・`SIGNUP-003` | SEC-AUTH-016-AC-03、SEC-AUTH-017-AC-01、SEC-AUTH-006-AC-01、SEC-AUTH-007-AC-01 |
| `NEWS-SEC-001`・`NEWS-SEC-005` | SEC-NEWS-005（2 本）、SEC-NEWS-007（2 本）、SEC-NEWS-008、SEC-NEWS-016 |
| `STOCKIST-015`・`STOCKIST-017` | SEC-STOCKIST-009・011・013（2 本）・014（2 本）、SEC-STOCKIST-018 |

`FR-SIGNUP-003` は `SEC-AUTH-007-AC-02`（Cookie の無いブラウザで開くと `/login` へ 303・session の Cookie 無し・メール確認済み）と `SEC-AUTH-007-AC-03`（別の未確認会員の印を開いても session を作らず、登録中の控えの Cookie が残る）を足した。3 つの幅（390/768/1280px）で流す。残した `test.fail` は、環境の設定が要る物（`enable_confirmations`・`[auth.mfa.totp]`）と、波 2 以降の物（IP は波 4、no-store は波 1-C・波 3、DB の RLS は波 2・5）。

E2E の枠の数え直し（Task 9）: 共有の管理者が 10 分の枠（強制失効 20・MFA リセット 10・ユーザー作成 20・色見本 60・問い合わせの書き込み 60・返信 30）を超える所は無い。揺れるのは `FR-ADMIN-MISC-003` の `SEC-ADMIN-007-AC-01`（50 回送る。全体の認可失敗の監査が 10 分 20 行で、窓の境目をまたぐと最大 40 行になりうる）。揺れたら窓の頭まで待つ。

## 開店前のセキュリティの穴 波 1-C のテスト（SEC-SEARCH・SEC-LOOK・SEC-NEWS・SEC-STOCKIST・SEC-PRIVACY・SEC-HOME）

確認日: 2026-10-26。波 1-C（検索・LOOK・お知らせ・取扱店・プライバシー・ホームの公開側と管理側の窓口、`/api/auth/me`）で書き直した試験をまとめる。単体・結合は実装者が流して通した（Task 10 の最終確認: `npx tsc --noEmit` 誤り 0、波 1-C が触った 91 スイート 2181 件通過、`tests/unit/docs` 2 スイート 56 件通過）。E2E は controller が本番ビルドで実測した（下の「E2E」の実測）。**DB 結合は新しく書いておらず、流してもいない**。試験名の先頭の ID は `validate-trace` の層の決まりに合わせた（単体は `DD-`、結合は `API-`・`ARC-`・`SCR-`・`FLOW-`・`STATE-`）。`docs/05_Quality/reports/` の対応表は `npm run trace:report` で作り直す。

### 新しく作った試験ファイル（単体）

| ファイル | 先頭の ID | 確かめること |
| --- | --- | --- |
| [no-store.test.ts](../../../tests/unit/lib/http/no-store.test.ts) | `DD-STOCKIST-034` | `withNoStore` が `Cache-Control` をちょうど `private, no-store` に置き換え、状態・本文・`Retry-After`・`Set-Cookie` を変えず同じ参照を返すこと（`@jest-environment node`） |
| [image-signature.test.ts](../../../tests/unit/lib/storage/image-signature.test.ts) | `DD-LOOK-063` | `detectImageType`（PNG・JPEG・GIF・WebP の先頭の印）と `resolveUploadImageType`（申告と検出が違う・知らない申告・印の無い中身は null） |
| [safe-error.test.ts](../../../tests/unit/lib/logging/safe-error.test.ts) | `DD-SEARCH-006` | `describeErrorForLog` が名前と符号だけを残し、message を含めず、getter が投げても投げないこと |
| [query-schema.test.ts](../../../tests/unit/features/search/query-schema.test.ts) | `DD-SEARCH-009` | 検索語の入口の決まり（前後の空白を取る・100 字まで・制御文字は拒む） |
| [cross-site.test.ts](../../../tests/unit/features/search/cross-site.test.ts) | `DD-SEARCH-010` | `Sec-Fetch-Site` が無い・空・`same-origin`・`none` は通し、`cross-site`・`same-site`・大文字・知らない値は 403 `{error:"Forbidden"}` と `private, no-store` で断ること |
| [news-input.test.ts](../../../tests/unit/features/news/news-input.test.ts) | `DD-NEWS-070` | `isNewsId`（`/^[1-9]\d{0,17}$/`。`0`・先頭 0・19 桁以上・小数・空は偽）と `resolveNewsCategory`（許可の一覧の値以外は `ALL`） |
| [look-error.test.tsx](../../../tests/unit/app/look/look-error.test.tsx)・[news-error.test.tsx](../../../tests/unit/app/news/news-error.test.tsx)・[privacy-error.test.tsx](../../../tests/unit/app/privacy/privacy-error.test.tsx) | `DD-LOOK-069`・`DD-NEWS-069`・`DD-PRIVACY-002` | 誤りの画面（`error.tsx`）の案内と再試行、`console.error` に `{ digest }` だけを渡し `Error` を渡さないこと |
| [revision-date.test.ts](../../../tests/unit/app/privacy/revision-date.test.ts) | `DD-PRIVACY-003` | `resolveRevisionDate`（基準日 2026-10-26 と追跡の切り替えの更新時刻の遅い方。日本時間の日付） |
| [admin-images.test.ts（LOOK）](../../../tests/unit/features/look/services/admin-images.test.ts)・[admin-images.test.ts（NEWS）](../../../tests/unit/features/news/services/admin-images.test.ts) | `DD-LOOK-070`・`DD-NEWS-071` | 画像の中身の確かめ（`prepareLookImage`・`prepareNewsImage`）、保存名（`looks/`・`news/` の下の日付と乱数と検出した拡張子）、自分の接頭辞の下の安全な道筋だけを消す対象にすること、置き場の削除の失敗を投げず `failed` で返すこと（`@jest-environment node`。jsdom の `File` に `arrayBuffer` が無いため） |
| [images.ts](../../../tests/fixtures/images.ts) | （見本。試験ではない） | `minimalPng/Jpeg/Gif/Webp`・`textAsImage`・`fileOf`。本物の先頭の印を持つ画像の見本で、管理の窓口の試験の偽の画像を置き換えた（`minimalWebp` は印の判定専用で、画像として開けるとは限らない） |

### 窓口・取り出し・部品の単体（書き直した物）

| 領域 | ファイル | 先頭の ID | 確かめること |
| --- | --- | --- | --- |
| SEARCH | `api/search/search-route`・`suggest-route` | `DD-SEARCH-004`・`005` | 403（外のサイト側、枠に数えない）→ 400（制御文字・101 字以上）→ 回数の制限の順、全応答の `private, no-store`、`x-search-duration-ms` が無いこと、500 は固定の文、記録は名前と符号だけ |
| SEARCH | `features/search/search-service-execute`・`search-service-suggestions`・`search-page-client`・`search-home-preview` | `DD-SEARCH-006`・`007`・`008`・`002`・`003` | 検索関数が 1 つでも失敗したら `SearchBackendError`（候補は失敗した種別を飛ばして続ける）、候補は入力が止まって 250 ミリ秒後に呼び新しい入力・アンマウントで打ち切ること、タブだけの変更では取り直さないこと、プレビューは固定の説明の文と「検索した語」の枠（語は説明の文の外）で、失敗の記録に `Error` を渡さないこと |
| LOOK（公開） | `lib/look-server`・`look-public`、`app/look/look-list-page`・`look-detail-page`、`features/look/components/public-look-grid` | `DD-LOOK-003`・`004`・`032`・`005`・`033`・`068`・`002`・`030`・`001` | 一覧は説明文を持たない型で 100 件までに丸める、詳細は 1 件で取り前後を 1 件ずつ取る、`parseLookId`（10 進の正の整数・16 桁まで・`1e3`・`1.5`・先頭 0・空白は null）、取り出しの失敗は投げて誤りの画面に出す（`generateMetadata` は固定の題）、記録は名前と符号だけ |
| LOOK（管理） | `api/admin/looks/` の 6 本・`looks-audit`、`components/look-section` | `DD-LOOK-063`・`064`・`065`・`060` | 認可 → 入口の id（400 `Invalid look id`）→ 画像の中身の確かめ → 量の枠の順、存在確認（`maybeSingle`）の失敗は 500 `Failed to fetch look`、途中で失敗した時に上げた画像を消す、差し替え・削除の後に自分の `looks/` の下の画像だけを消す、置き場の削除の失敗は 200 のまま監査 `image_cleanup:"failed"`、一覧の `meta.canManage`、`canManage` が真の時だけカードの 3 ボタンを出すこと、応答にも記録にも誤りの文・ファイル名・中身が出ないこと |
| NEWS（公開） | `features/news/news-public-service`、`api/news/news-route`、`app/news/news-list-page`・`news-detail-page`、`app/actions/news-actions`、`home/home-page` | `DD-NEWS-003`・`031`〜`033`・`004`・`002`・`030`・`066`・`DD-HOME-001` | 取り出しの DB の失敗は `NewsFetchError` で投げ「無い記事」と見分ける、詳細は `isNewsId` が偽なら DB を呼ばず `null`（`maybeSingle`）、前後の失敗は記録して前後なし、`/api/news` は全応答 `private, no-store`・外れた分類は `ALL`・500 は固定の文、ホームだけは取り出しの失敗を握って空にすること |
| NEWS（管理） | `api/admin/news/news-admin-route`・`news-admin-id-route`、`components/NewsSection`、`app/admin/news/news-edit-page` | `DD-NEWS-064`・`065`・`060`・`063` | 画像の中身の確かめ（400 `Unsupported image type`）、DB の保存が失敗・例外の時に上げた画像を消す、PUT は画像ありの時に上げる前に古い `image_url` を読み（無ければ 404 で何も上げない）、更新の後に古い画像を消す、DELETE は行を消した後にだけ画像を消す、`isNewsId` を通らない id の編集頁は要求を送らず読み込みの失敗を出す、一覧の取得失敗は `role="alert"` と再読み込み（0 件の文とは別） |
| STOCKIST | `api/admin/stockists/stockists-route`・`stockists-id-route`・`stockists-security`、`features/stockist/stockist-public-service` | `DD-STOCKIST-034`・`035`・`036`〜`038`・`003` | 6 窓口の戻りの全分岐（認可・回数・CSRF の拒否を含む）に `private, no-store`、外側の catch の記録は名前と符号だけ、公開の取り出しの失敗の記録も名前と符号だけ。作り物の `NextResponse.json` と拒否の作り物に `headers` を足した（`withNoStore` が `headers.set` を呼ぶため） |
| PRIVACY・AUTH | `components/PrivacyPage`、`api/auth/me-route` | `DD-PRIVACY-001`・`DD-AUTH-026` | 最終改定日が基準日 2026年10月26日で、追跡の設定を切り替えた日（日本時間）に追従すること（`PrivacyPage`）、`/api/auth/me` の 200 に `email` が無く `id`・`role`・`mfaVerified` が残ること（2 節に「メールマガジン」の字が無いことと 9 節が Resend・Supabase・Cloudflare Turnstile を挙げることは結合の `SCR-PRIVACY-001`） |

### 結合（`tests/integration/`）

| 領域 | ファイル | 確かめること |
| --- | --- | --- |
| SEARCH | `api/search-{public-api,suggest-api,request-path,popular-items,image-signing}`、`ui/search-{suggestion-screen,commit-flow,results-state,home-preview-screen}` | 窓口の 403・400・500・`private, no-store`、候補の 250 ミリ秒の待ちと打ち切り、「タブを押すと取り直す」を「取り直さない」に書き直した（`search-commit-flow`・`search-results-state`）、プレビューの固定の文と「検索した語」の枠 |
| LOOK | `api/look-admin-{list,create,item-get,item-put,item-patch,item-delete}-api`・`look-admin-write-path`・`look-image-signing`、`ui/look-{list-screen,detail-screen,list-detail-flow,public-read-path,home-section,season-state,card,admin-list-screen,admin-flow}` | 偽の画像を本物の先頭の印つきの見本に替えた、ファイル名・中身が監査・記録に出ないこと、`SECRET` を含む置き場／DB の文が応答にも `console.error` にも出ないこと、101 件超の最古の詳細・同時刻の並び・前後だけ失敗、`meta.canManage` の偽・meta なしでボタンが出ないこと |
| NEWS | `api/news-{public-api,latest-action,image-signing,admin-create-api,admin-item-get-api,admin-item-put-api,admin-item-delete-api,admin-write-path}`、`ui/news-{detail-screen,list-detail-flow,public-read-path,admin-list-screen,admin-flow}` | モックの `single` を `maybeSingle` に替えた、数でない id の見本、上げた数と消した数が同じこと（`SEC-NEWS-018-AC-03`。`news-admin-create-api`）、画像の道筋の確かめ |
| HOME・AUTH・PRIVACY | `api/home-page-public-read`、`api/auth/me`、`ui/privacy-policy-screen`・`privacy-tracking-clause-state` | LOOK は select・order・limit 8、`/api/auth/me` の応答に `email` が無いこと、プライバシーの最終改定日と 2 節・9 節の文（`SCR-PRIVACY-001`。9 節が `Resend, Inc.` を挙げ、頁全体に「メールマガジン」が無いこと） |

先頭の ID（LOOK・NEWS の管理の窓口と画面）: `look-admin-list-api` は `API-LOOK-001`、`look-admin-create-api` は `API-LOOK-002`、`look-admin-item-get-api` は `API-LOOK-003`、`look-admin-item-put-api` は `API-LOOK-004`、`look-admin-item-patch-api` は `API-LOOK-005`、`look-admin-item-delete-api` は `API-LOOK-006`、`ui/look-admin-list-screen` は `SCR-LOOK-006`、`news-admin-create-api` は `API-NEWS-003`。

DB 結合は新しく書いていない。

### E2E

実測（2026-10-26、controller、本番ビルド、手元の Supabase）: 範囲内の 1861 件を流し、期待どおりが 1834 件。新しい赤は `SEC-SEARCH-020-AC-02` の書き直し（下の表）で解消し、`FR-SEARCH-022` が 14/14 通過した。`LOGIN-032` は一時的な 503 で、再実行で通過した。プライバシーの基準日を 2026-10-26 に上げた後の `FR-PRIVACY-*` も通過した。`FR-SEARCH-022` はコミット前にもう 1 回流す。

外した `test.fail`（32 行）。Task 10 の突き合わせの 30 行（`git diff` の旧行）に、`SEC-PRIVACY-011` の 2 行を足した。

| ファイル（`e2e/FR-...`） | 外した受け入れ条件 ID |
| --- | --- |
| `STOCKIST-015` | SEC-STOCKIST-010-AC-01 |
| `SEARCH-018`・`SEARCH-019`・`SEARCH-022` | SEC-SEARCH-021-AC-01、SEC-SEARCH-004-AC-01・SEC-SEARCH-010-AC-01・SEC-SEARCH-019-AC-01、SEC-SEARCH-005-AC-02（3 つの幅のループの中）・SEC-SEARCH-017-AC-01 |
| `LOOK-SEC-001`・`003`・`004`・`005` | SEC-LOOK-009-AC-01、SEC-LOOK-016-AC-02・AC-03、SEC-LOOK-013-AC-01・AC-02・SEC-LOOK-014-AC-01・AC-02、SEC-LOOK-021-AC-01・SEC-LOOK-022-AC-01・AC-02 |
| `NEWS-SEC-001`・`003`・`005`、`NEWS-ADMIN-001` | SEC-NEWS-012-AC-01、SEC-NEWS-006-AC-01・AC-02、SEC-NEWS-017-AC-01・AC-02・SEC-NEWS-018-AC-01・AC-02、SEC-NEWS-020-AC-01 |
| `HOME-022` | SEC-HOME-015-AC-01、SEC-HOME-016-AC-01 |
| `PRIVACY-005`・`006`・`008`・`009` | SEC-PRIVACY-011-AC-01・AC-02（`FR-PRIVACY-005`。2026-10-26 に 9 節へ事業者名を入れ、2 節からメールマガジンを外した）、SEC-PRIVACY-016-AC-01、SEC-PRIVACY-012-AC-01、SEC-PRIVACY-009-AC-01 |

足した E2E（印なし。上の実測で通過）

| 受け入れ条件 | ファイル | 幅 | 注意 |
| --- | --- | --- | --- |
| `SEC-LOOK-009-AC-02` | `FR-LOOK-SEC-005-global-faults` | 3 | 1990 年の公開の LOOK 101 件を `beforeAll` で入れ `afterAll` で消す。`isolated-global` なので他と同時に流さない |
| `SEC-LOOK-019-AC-05` | `FR-LOOK-SEC-003-admin-api-authz` | 3 | カードの 3 ボタン。「新規作成」の `SEC-LOOK-019-AC-04` は波 4 のため印を残した |
| `SEC-SEARCH-020-AC-02` | `FR-SEARCH-022-search-rate-limit` | 3 | ブラウザで外のオリジンの頁は開かない。request fixture で `Sec-Fetch-Site: cross-site` を付けて `/api/search?preview=true` を 21 回送り、全部 403 `{error:"Forbidden"}` で枠が減らないことを確かめ、ブラウザで開くのはその閲覧者の `/?q=` のプレビュー（200 と見出し「Search Preview」）だけ。外のオリジンの頁を開く手順では要求の応答を捕まえられなかったため、この形に書き直した。テストの題は「外のオリジンの頁から…」のままで、後始末の候補。`isolated-global` |
| `SEC-SEARCH-021-AC-02` | `FR-SEARCH-018-search-page-flows` | 3 | プレビューの固定の文と「検索した語」の枠。写真 6 枚を `test-results/wave1c/` に残す |

書き換えて印を残した行: `SEC-SEARCH-020-AC-01`（偽の送り元の側 (a) だけにした。波 4）。範囲外の `e2e/FR-ADMIN-108-select-fields.spec.ts` は、記事の id `news-1` を `1` に直した（編集頁が `isNewsId` を通らない id で要求を送らなくなったため）。`FR-NEWS-ADMIN-001` の差し替えの記事 id も同じ理由で `1`/`2`/`N` に直した。残した `test.fail` は、波 3 以降（署名・IP・no-store の共有）と DB の移行が要る物。

## G-4 Task 11: 詳細の操作と既存E2Eの入口（2026-10-27）

実装済み・controllerの本番build実行待ち。FR-ADMIN-122は390/768/1280pxの11case（33登録予定）。①〜⑧⑩⑪はmock、⑨は実際のお客様の頁・APIと試験ごとの新しいDB材料を使う。型・lint・既存文書/E2E helper単体の成功を、このE2Eの通過数に数えない。

| FR-ADMIN-122のcase（briefの題） | AC・確かめ |
| --- | --- |
| 1. 詳細は注文情報・支払いと返金・品物・発送・返品とキャンセルの申し込み・要対応・変更履歴の7つの欄をこの順に出す | FREQ-539-AC-01。7つのh2と同名regionを順序・1件ずつで確かめる。 |
| 2. 返金・キャンセル〔未入金の取消／支払い済み〕・返品・キャンセルの申し込みの入口が詳細にあり、サポーターの旗では返金と支払い済みのキャンセルと「額を決めて返金する」が出ず、受け取る/返品・未入金の取消・キャンセルの申し込みは出る（旧 091 ②） | FREQ-539-AC-02。091②の8組の返品summaryを店長/サポーターで確認。返金/支払済み/未入金の取消・返品・キャンセル申請のdialogも開く。 |
| 3. J-12: 取消の画面の見出しに注文番号、返金・支払い済みのキャンセルの見出しに注文番号〔名前は出ない〕。390pxでは画面いっぱいに開き右上の×で何も送らずに閉じる | FREQ-539-AC-03。全3種の確認画面の見出しに注文番号、氏名なし。返金/支払い済みの取消は390px全画面（1px許容）と右上×、送信0件。 |
| 4. 操作の後は詳細を読み直し、読み直しに失敗したら「最新の状態を読み込めませんでした。」と「この画面の内容は最新ではありません。」を出して成功の知らせを出さない。「読み込み直す」で直る | FREQ-539-AC-03。review受理後の詳細GETを500にし、2つの固定の失敗文・成功通知なし。読み込み直すで要対応と履歴を復旧。 |
| 5. 履歴: 品物の状態の変化〔変更前後・理由・人または自動・発送票への参照〕とメールの再送が詳細の中で使える | FREQ-539-AC-04。品物の変更前後/数量/理由/人と自動/発送票Link、メール再送本文と手動行。dialogは使わない。 |
| 6. 要対応: 要確認の印と「確認済みにする」〔manage の旗がある時だけ〕、支払い・配送の要対応の言葉、「要対応の一覧で対応する」で /admin/orders#attention へ移る（旧 061 ①） | FREQ-539-AC-04。manage=falseでも要確認の印、確認済み入口なし。manage=trueで解消・詳細再読。支払い/配送の文と一覧#attentionへ遷移。 |
| 7. 発送: 既存の発送票へのリンク〔票の頁が開く〕と注文別の発送、発送の操作〔発送・伝票訂正・手の配達済み〕が詳細に無い。同梱の注意文 | FREQ-539-AC-05（発送の欄）。注文別の発送・伝票番号と既存票、同梱の注意文。旧操作なし。Linkを押して本物の票の頁の見出しを読む（APIは固定）。 |
| 8. 要対応の欄の「もう一度返金する」は /admin/orders/{id}?open=refund へ移り返金の画面が開く。返品の返金は ?open=returns | FREQ-539-AC-02。新一覧の通常返金は?open=refund、返品返金は?open=returns。遷移・対応する画面・queryの除去。 |
| 9. E-5 の回帰: お客様の注文画面・注文状況の頁の言葉と公開範囲が変わらない〔110 ⑥ と同じ入り方で、同じ注文が管理の詳細で返品受付中でも客向けの画面に管理の言葉が出ない〕 | FREQ-541-AC-05。新しい固有会員/注文/返品をDBで作る。詳細と履歴の描画後だけ1SQLの数量を読み、同じ注文の実会員頁と実注文状況頁に客語を確認。匿名の確認前はaccess=noneの3キーだけで、返品の状況（返品の受付済み）はリンクだけで見える公開の範囲（FREQ-498-AC-03）として出て、管理の言葉は出ない。電話確認後はverifiedで返品の記録を出す。 |
| 10. ORDER タブは注文一覧表への入口だけ。旧い一覧・各 dialog の入口・旧CSVは出ない | FREQ-539-AC-05。ORDERの注文メニューは新一覧Link1件だけ。旧表・dialog/CSV/発送入口なし、GET旧一覧の要求0。 |
| 11. 頁全体が横にはみ出さず、表は見出しを保ったスクロール領域に収まる | FREQ-539-AC-01。30行を入れ、名前つき/キーボード可のスクロール領域、9列の順、sticky見出しと頁全体の横はみ出しなし。 |

### 付け替えた15ファイルの現行の期待

| spec | 現行の入口と維持する期待 |
| --- | --- |
| [FR-ADMIN-051](../../../e2e/FR-ADMIN-051-order-refund-safety.spec.ts) | 詳細の支払い欄で未入金/入金済み/発送済みを個別に開く。保留の知らせ・詳細GETの増加・旧発送入口の不在。 |
| [FR-ADMIN-060](../../../e2e/FR-ADMIN-060-order-attention-inbox.spec.ts) | /admin/ordersの件数・確認済み・解決・0件・断りと読込失敗・横はみ出し。サイドナビ/KPIだけ/adminのまま。 |
| [FR-ADMIN-061](../../../e2e/FR-ADMIN-061-order-list-review-states.spec.ts) | 旧①を122⑥、旧②を121④、旧③〜⑥を110③へ移設/置換。残る支払額の理由と横はみ出しは詳細。 |
| [FR-ADMIN-063](../../../e2e/FR-ADMIN-063-order-cancel-dialog.spec.ts) | 理由・お知らせ・メモ・払込票・確認不可・失敗の取消を詳細で保持。送信中に同じ注文の返金を開き直し、先の終了が閉じない。この case が守る契約は「取消の送信が終わっても、今開いている返金の画面を閉じない」だけ（詳細頁は1注文だけなので、別の注文の画面を開く元の形は作れない）。 |
| [FR-ADMIN-064](../../../e2e/FR-ADMIN-064-recovered-order-review.spec.ts) | 支払いから作った注文の要確認と確認済みを新一覧の要対応で保持。 |
| [FR-ADMIN-065](../../../e2e/FR-ADMIN-065-order-history-and-email-resend.spec.ts) | 状態変化・メール本文・再送を埋め込み履歴内で保持。Escapeと履歴ボタンへのfocus復帰のみ撤去、題は維持。題の「Escape で閉じる」は旧い文言のまま残り、今の case は埋め込みの履歴で状態の変化・メール本文・再送を確かめ、閉じる動作は確かめない。request/DB/Mailpitのcaseは変更なし。 |
| [FR-ADMIN-067](../../../e2e/FR-ADMIN-067-order-email-paused-banner.spec.ts) | 新一覧のメール停止の帯と原因・解除後の再読。 |
| [FR-ADMIN-074](../../../e2e/FR-ADMIN-074-refund-dialog.spec.ts) | 返金UIの全条件・送信本文・再送キー・確かめ中・取消後入金・横幅は保持。詳細GETの増加へ変更。題の「一覧を読み直す」は旧い文言のまま残り、今の case は詳細のGETの回数の増加を確かめる。DBの2caseは変更なし。 |
| [FR-ADMIN-075](../../../e2e/FR-ADMIN-075-paid-order-cancel.spec.ts) | 各注文の詳細の支払い欄でキャンセル可否。サポーターはpermissions.refund=false。全額/内訳/本文/再送キー/保留後の進み具合/横幅を保持。題は指定の2件だけ変更。 |
| [FR-ADMIN-077](../../../e2e/FR-ADMIN-077-order-history-refunds.spec.ts) | 同じ返金・取消・外部返金・確保し直しの履歴行と件数を埋め込みへ。DBのcaseは変更なし。 |
| [FR-ADMIN-078](../../../e2e/FR-ADMIN-078-refund-failure-attention.spec.ts) | 要対応の返金失敗・権限・返せる額・手動解決は新一覧。再試行ボタン（router.push）→?open=refundの詳細→受理後に一覧へ戻って要対応を再読。題1件変更。 |
| [FR-ADMIN-082](../../../e2e/FR-ADMIN-082-fulfillment-after-refund.spec.ts) | 返金受理後に詳細の進み具合が配送中、一部発送済みの印が消え、旧発送入口なし。DBの2caseは変更なし。 |
| [FR-ADMIN-105](../../../e2e/FR-ADMIN-105-cancel-reasons.spec.ts) | 未入金/支払済みをそれぞれ詳細で開き、同じ6理由の値と順を保持。6組のDB/worker/Mailpitは変更なし。 |
| [FR-ADMIN-106](../../../e2e/FR-ADMIN-106-refund-failure-note-required.spec.ts) | 通常/返品返金のメモ必須・空白不可と、その他のメモ任意の本文/再読を新一覧で保持。 |
| [FR-ADMIN-107](../../../e2e/FR-ADMIN-107-dialog-order-number-close.spec.ts) | 詳細から同じ返金/支払い済みキャンセルを開く。J-12の氏名なし・戻る・390pxの寸法（1px許容）・×/初期focus/送信中/広い幅の不在は保持。 |

共有helperは旧mockOrderList/openOrderTab/adminOrderを保持し、詳細用の返金/支払済み取消/返品/キャンセル申請/埋め込み履歴を別のexportへ追加。mockOrderItemListはGET /api/admin/order-items（任意のquery）へrouteと同じdata/returnAttention/cancelRequestAttentionをcurrentから返す。要対応は既存mockOrderAttentionを使用。

新しいDBの⑨はwithOrderAdminScenario({ returnSettings: true })の中で、14314,2→190520,0の順に鍵を取り、詳細と履歴の描画後にだけ同じ接続を読む。追跡設定を変えないので940488を追加しない。追記専用の行は削除しない。既存DBのみのcaseはbriefどおり変更せず、全件baseline比較はTask 13。

旧061の削除前に、移設先の題（122⑥・121④・110③）を照合し、FREQ-412-AC-01/02/03/05を移した。091②のFREQ-468-AC-02は122②へ参照を移し、元caseはTask 12で削除した。ケースごとの全処置は `.superpowers/sdd/2026-10-26-group-g4-orders/e2e-disposition.md` のTask 11に記録。

## G-4 Task 12: 返品・申し込み・一覧の表示・配送・設定の既存E2Eの付け替えと整理（2026-10-27）

実装済み・controllerの本番build実行待ち。型・lint・既存文書/E2E helper単体の成功を、このE2Eの通過数に数えない。付け替え99件・移設1件・削除9件・変更なし42件（ケースごとの全処置は `.superpowers/sdd/2026-10-26-group-g4-orders/e2e-disposition.md` のTask 12）。`grep -rn "openOrderTab\|mockOrderList\|components/OrderSection" e2e` は0件。FR-ORDER-001・010、FR-CHECKOUT-050、FR-ORDER-008は変更なし（`test.skip`・`createFulfillment`・`shipE2eOrder`・`openOrderTab`・`mockOrderList` は4ファイルとも0→0）。

### 付け替え・整理した spec の現行の期待

| spec | 現行の入口と維持する期待 |
| --- | --- |
| [FR-ADMIN-050](../../../e2e/FR-ADMIN-050-order-shipping.spec.ts) | 詳細の「注文情報」に「配送先の情報が足りません（address）」。発送できる注文（canShip=true）でも旧い入口「発送済みにする」も旧い停止文（発送は荷作り表から行います。）も出ない。横はみ出しなし。題を1件変更（配送先要確認 → 詳細の文）。 |
| [FR-ADMIN-069](../../../e2e/FR-ADMIN-069-made-to-order-completion.spec.ts) | 残るのはDBの1case（手動の仕上がりの記録・取消の固定の断りと、入荷の自動の割当で発送準備中になること）だけ。画面の2case（「受注生産中」の言葉と数／仕上がりの画面の横はみ出し）は110②・122⑪へ移して削除。`legacy-fulfillment-disabled` のimportは消した。 |
| [FR-ADMIN-070](../../../e2e/FR-ADMIN-070-order-progress-labels.spec.ts) | 詳細の「注文情報」の進み具合に未決済・受注生産中・発送準備中・配送中・配達済み・キャンセルの言葉（1行で割れない）と、一部だけ送った注文の「一部発送済み」の印。どの詳細にも「仕上がりを記録する」は出ない。絞り込みの8つの名前のcaseは110①・121④へ移して削除。お客様の購入履歴は変更なし。 |
| [FR-ADMIN-072](../../../e2e/FR-ADMIN-072-fulfillment-cancel.spec.ts) | 詳細の「変更履歴」の欄に発送の行が出ても、頁全体が横にはみ出さない。 |
| [FR-ADMIN-076](../../../e2e/FR-ADMIN-076-order-list-payment-column.spec.ts) | 詳細の「支払いと返金」に6つの支払いの言葉のどれかが1つだけ（進み具合の言葉とは重ならない）。「返金の手続き中」「返金の失敗」の印はその注文の詳細だけ（金額の見出しdtは数えない）。横はみ出しなし。列の見出し・ボタンの出方・CSVの3caseは削除（121①・051/075/122②・121⑦）。 |
| [FR-ADMIN-079](../../../e2e/FR-ADMIN-079-shop-settings.spec.ts) | 旧い一覧の窓口をやめ、要対応の窓口だけを空にする。サポーターがSETTINGSを直に開くと戻る先のORDERが「注文一覧表」への入口だけの画面であることを確かめる。ほかの期待は変えない。 |
| [FR-ADMIN-084](../../../e2e/FR-ADMIN-084-return-create.spec.ts) | 詳細頁の「返品とキャンセルの申し込み」の「返品」から返品の画面・返品を作る画面を開く（8 UI case）。DB・Mailpitの3caseは変更なし。 |
| [FR-ADMIN-085](../../../e2e/FR-ADMIN-085-return-receive-refund.spec.ts) | 詳細頁の「受け取る」から受け取りの画面を開く（6 UI case）。DB・Mailpitの7caseは変更なし。 |
| [FR-ADMIN-086](../../../e2e/FR-ADMIN-086-return-partial-missing-cancel.spec.ts) | 詳細頁から返品の画面・受け取り・届かない・開き直し・取消・検品（5 UI case）。DBの3caseは変更なし。 |
| [FR-ADMIN-087](../../../e2e/FR-ADMIN-087-return-consult-refund.spec.ts) | 詳細頁から返品の画面（5 UI case）。要対応の「もう一度返金する」は /admin/orders から /admin/orders/{id}?open=returns へ移り、返品の画面が開く（普通の返金の画面ではない）。サポーターの旗（返金なし）は詳細のpermissionsで渡す。DB・Mailpitの5caseは変更なし。 |
| [FR-ADMIN-088](../../../e2e/FR-ADMIN-088-return-exchange.spec.ts) | 詳細頁から受け取りの画面の交換の品・手数料の画面（5 UI case）。DB・Mailpitの7caseは変更なし。 |
| [FR-ADMIN-089](../../../e2e/FR-ADMIN-089-return-sent-back.spec.ts) | 詳細頁から受け取りの画面のお返しの欄（2 UI case）。DB・Mailpitの4caseは変更なし。 |
| [FR-ADMIN-090](../../../e2e/FR-ADMIN-090-return-support-receive.spec.ts) | サポーターの旗（返金なし）で詳細頁の返品の画面（3 UI case）。DB・Mailpitの3caseは変更なし。 |
| [FR-ADMIN-091](../../../e2e/FR-ADMIN-091-order-list-returns.spec.ts) | 残る確かめは2つ。注文一覧表の上の一行（返品の申し込み・返金待ち・キャンセルの申し込み。0件は出さない、全部0件なら行ごと出さない、押すとその状態だけの絞り込みでほかの絞り込みは全部外れる、もう一度で外れる）と、返品の状態・印・次にすることのDBの決まり（変更なし）。「返品」の列・ボタンの名前・絞り込みreturn=・CSVの返品の列の4caseは110⑤・122②・121④・121⑦へ移設/削除。 |
| [FR-ADMIN-092](../../../e2e/FR-ADMIN-092-shop-return-settings.spec.ts) | 旧い一覧の窓口をやめ、要対応の窓口だけを空にする。期待は変えない。 |
| [FR-ADMIN-093](../../../e2e/FR-ADMIN-093-return-guards-history.spec.ts) | 履歴の返品の行・メールの種類・横はみ出しなしは詳細の「変更履歴」（埋め込み）。ふつうの返金の数の上限は詳細の返金の画面。商品編集の在庫の履歴とDBのcaseは変更なし。 |
| [FR-ADMIN-094](../../../e2e/FR-ADMIN-094-return-request-approve.spec.ts)・[095](../../../e2e/FR-ADMIN-095-return-request-decline.spec.ts)・[096](../../../e2e/FR-ADMIN-096-customer-return-support-refund.spec.ts) | 返品の申し込みの確認・お断り・サポーターの受け取りは、adminSceneが詳細の窓口（サポーターは返金なしの旗）を差し替え、詳細頁の「申し込みを確かめる」「受け取る」から開く。期待は変えない。 |
| [FR-ADMIN-097](../../../e2e/FR-ADMIN-097-cancel-requests.spec.ts) | 一行の「キャンセルの申し込み 1件」は /admin/orders（押すとstatus=cancel_requested）。申し込みの画面は詳細頁の ?open=cancel-request と入口のボタン。品を外す→返金/取消/支払い済みキャンセルの3つの画面・解決・解決だけ失敗は詳細頁。解決後は詳細の入口が消え、一覧へ戻ると上の一行も消える。 |
| [FR-ADMIN-098](../../../e2e/FR-ADMIN-098-return-request-settings.spec.ts) | settingsSceneが旧い一覧の窓口をやめ、要対応の窓口だけを空にする。期待は変えない。 |
| [FR-ADMIN-099](../../../e2e/FR-ADMIN-099-item-return-ineligible.spec.ts) | 「お店が返品を作る画面では返品不可を警告する」は詳細頁の返品の画面から開く。商品の編集・新規の2caseは変更なし。 |
| [FR-ADMIN-102](../../../e2e/FR-ADMIN-102-delivery-tracking-sync.spec.ts) | 履歴の確かめを詳細の「変更履歴」へ。追跡・メールは変更なし。bridgeは詳細の窓口（DBのsummary）を答える。 |
| [FR-ADMIN-103](../../../e2e/FR-ADMIN-103-delivery-attention.spec.ts) | 要対応の「配送」の組と「対応済みにする」は /admin/orders。「履歴を開く」は詳細の #order-history へ移る。その注文の開いている配送の要対応（問題あり・不在で持ち帰り・伝票番号で荷物が見つからない）は詳細の「要対応」の欄に全部並ぶ（旧い一覧の優先順の1つの印は無くなった）。 |
| [FR-ADMIN-104](../../../e2e/FR-ADMIN-104-delivery-tracking-settings.spec.ts) | 設定の確かめは変更なし。最後の履歴の確かめだけ詳細の「変更履歴」へ。鍵未設定のcaseは要対応の窓口だけを空にする。発送票のcaseは変更なし。 |
| [FR-ADMIN-119](../../../e2e/FR-ADMIN-119-purchase-order-attachments.spec.ts) | 「原本を見る」の開いたタブの保存を待つ promise を、20秒で reject する時計と Promise.race させた。保存も移動も起きない時は、試験全体の時間切れまで待たず、理由つきの失敗の文で終わる。期待は変えない（G-2 最終の確かめ直しの N2。N3・N4 は本番コードのため未実施）。 |
| [FR-ADMIN-123](../../../e2e/FR-ADMIN-123-group-g-permissions.spec.ts) | 旧い一覧の窓口（mockOrderList）6か所を外し（要対応の窓口は管理者のログインの道具が空にする）、ORDERタブを開く道具は123の中のopenOrderMenuにした。旧い仕上がりの停止文の確認は固定の字で持つ。旧い窓口のURLは404の期待だけ。 |

### 共有の道具

- `order-fulfillment-test-utils`: `mockOrderList`・`openOrderTab` を削除（利用者は0件）。`adminOrder` は詳細のsummaryの元として残す（`canShip`・`canRecordCompletion` の既定は、050と123が「窓口が昔の形で true と答えても入口が出ない」を確かめるため残した）。
- `refund-test-utils`: 旧一覧の `openRefundDialog`・`openPaidCancelDialog` を削除。`return-test-utils`: `openReturnsDialog`・`openHistoryDialog`・`mockOrderListWithAttention`・`exchangeOrderLine` を削除。`return-request-test-utils`: `openCancel` を削除し、`adminScene`・`cancelScene`・`openReview`・`settingsScene` を詳細頁/注文一覧表/入口だけのORDERへ付け替え（`cancelScene` は第5引数 `landing` で詳細か注文一覧表を開く）。
- `delivery-tracking-test-utils`: `openOrderHistory` を削除。`mockAdminDeliveryBridge` は、旧い一覧の窓口をやめて `/api/admin/order-items`（空）と詳細 `GET /api/admin/orders/{id}`（DBの進み具合のsummaryと、開いている配送の要対応の行）を答える。`DeliveryBridgeLog` に `detailReads` を追加。

### 旧い410の宿題の仕上げ

`tests/unit/api/admin/legacy-fulfillment-routes-removed.test.ts` の走査を e2e と tests へ広げた。旧い窓口のURLを書いてよい行は404を期待する117（4行）と123（11行）だけ。`LEGACY_FULFILLMENT_DISABLED` の記号は、DBの旧い関数の拒否のDB結合（tests/integration/db）と、止めたstoreの関数・固定の文・その記号を投げる道具の許可リストの試験だけ。`legacy-fulfillment-disabled.ts` のimporterは、e2eに無く、testsは許可リストの5ファイルだけ。モジュールは止めたstoreの関数（fulfillment-store.ts・fulfillment-materials.ts）の試験が使うので残し、使われなくなった `legacyFulfillmentDisabledBody` と型だけを消した。

## 開店前のセキュリティの穴 波 3 のテスト（画像の署名・CSP・Cookie・no-store・og:image・ビルドの必須の環境変数。SEC-HOME・SEARCH・LOOK・NEWS・ABOUT・PRIVACY・AUTH）

確認日: 2026-10-28（この節は波 3 の分。並びは時系列でなく、波 2 の節の後に置く）。波 3 は移行を含まない（本番の DB の変更なし）。単体・結合は各 Task の実装者が対象の範囲で通した。**実測（2026-10-28）**: DB なしの jest 全体は通過（落ち 0）、手元の `npm run db:reset` の後の `npm run test:trace-coverage` は届かない分岐の節に無い 0 件・ずれた 0 件。本番ビルドの E2E 全件（1 回）は 183 failed・4828 passed・26 skipped で、G-4 の 181 failed（`.superpowers/sdd/2026-10-26-group-g4-orders/e2e-results-g4-full.json`）から増えた赤は `FR-ITEM-DETAIL-019`・`020`（単体の再実行で通る揺れ）だけ。外した `test.fail` 18 行と足した E2E は全部緑。

- 1 回目の全件で、ゲストが `/checkout` を開く決済の E2E 17 件が `networkidle` 待ちの時間切れで赤になった。原因は `/api/auth/*` に `no-store` を付けた（SEC-AUTH-022-AC-02）ことで、本文を読まない `fetch` の応答をブラウザが終わらせず、`/api/auth/refresh` の要求が開いたまま残った（`no-store` の無い応答は読まなくても終わる）。`src/lib/client-fetch.ts` の `performRefresh` が結果に関わらず本文を読み切る形に直し、[client-fetch.test.ts](../../../tests/unit/lib/client-fetch.test.ts) に「200・401・429 でも本文を読み切る」「読み切りの失敗は結果を変えない」の 4 本を足した。直した後は 17 件とも緑（1 並列の再実行 215 件通過）。

### 新しく作った試験ファイル

| ファイル | 先頭の ID | 確かめること |
| --- | --- | --- |
| [safe-object-path.test.ts](../../../tests/unit/lib/storage/safe-object-path.test.ts)（65 本） | `DD-SEARCH-011` | `parseOwnObjectPath`・`isSafeObjectPath`。自分の origin の `/object/(public\|sign\|authenticated)/<bucket>/` と素の道筋だけを通し、外の host・別プロジェクト・`..`・二重の符号・空白・日本語・接頭辞違いは `null` |
| [item-images.test.ts](../../../tests/unit/lib/storage/item-images.test.ts)（27 本） | `DD-SEARCH-011` | 商品画像の署名。期限 3600 秒、道筋にできない値・署名失敗（error・空・例外）は `null`、位置を保つ、使い回しの窓は期限の半分、記録は固定語だけ |
| [ItemDetailImages.test.tsx](../../../tests/unit/components/ItemDetailImages.test.tsx)（2 本） | （補助。ID なし） | `image_url` が null・`image_urls` が空でも商品詳細が落ちず「No Image」、`image_urls` が 2 枚ならサムネイル 2 枚 |
| [ui-page.test.tsx](../../../tests/unit/app/ui-page.test.tsx)（3 本） | `DD-HOME-004` | `/ui` が `readdy.ai`・`placehold.co` を含まない、`https://` の URL は地図の埋め込みだけ、`src` は手元の画像（`/` 始まり） |
| [proxy-session.test.ts](../../../tests/unit/middleware/proxy-session.test.ts)（28 本。判定は `src/lib/session-cookie-policy.ts`） | `DD-PRIVACY-004` | `session_id` を発行するのは `/cart`・`/checkout`・`/api/checkout` とその子だけ。`/cartx`・`/checkoutx`・`/apicheckout` などの境目、既にある Cookie、本番の Secure |
| [proxy-no-store.test.ts](../../../tests/unit/middleware/proxy-no-store.test.ts)（18 本。判定は `src/lib/auth-no-store-policy.ts`） | `DD-AUTH-037` | `/api/auth` と子の全応答（Origin 拒否の 403 を含む）に `Cache-Control: no-store`、付けない側（`/api/authx` など）の境目 |
| [look-og-route.test.ts（単体）](../../../tests/unit/app/look-og-route.test.ts) | `DD-LOOK-071` | `GET /look/[id]/og`。不正な id・非公開・画像なし・置き場の失敗・先頭の印が画像でないは固定の 404、成功は 200・`public, max-age=300, s-maxage=300`・`nosniff`・`Set-Cookie` なし |
| [look-og-route.test.ts（結合）](../../../tests/integration/api/look-og-route.test.ts) | `API-LOOK-007` | 窓口＋取り出し＋道筋の確かめ＋種類の検出を本物で通す（`validate-trace` が API-LOOK-007 に結合テストを要求） |
| [instrumentation-client.test.ts](../../../tests/unit/instrumentation-client.test.ts)（4 本） | `DD-HOME-004` | ブラウザ側の zod を `jitless` にし、`new Function` の探りが走らない（読み込まない時は走る対照を含む） |
| [build-env-guard.test.ts](../../../tests/unit/lib/build-env-guard.test.ts)（17 本） | `DD-ABOUT-002` | `VERCEL_ENV=production` で `NEXT_PUBLIC_SITE_URL`・`NEXT_PUBLIC_SUPABASE_URL` が無い（空白だけ）とビルドを落とす。`NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_URL` の origin が違えば環境に依らず落とす |
| [next-config.test.ts](../../../tests/unit/next-config.test.ts)（13 本、うち波 3 Task 13 で 4 本追加。どの領域の `tests` にも入れていない） | `DD-HOME-004`・`DD-ABOUT-002` | `images` の `remotePatterns` は本番で自分の Supabase の host 1 つ・`https`・`/storage/v1/object/sign/**` の 1 件だけ、`minimumCacheTTL` は 3600、使っていない host を許さない。`next.config.ts` が `assertBuildEnv` を読む配線 |

### 書き換えた・足した試験

| 領域 | ファイル | 変えたこと |
| --- | --- | --- |
| ITEM 署名（Task 2・3） | `tests/unit/features/cart/services/cart-view`・`client/cart-api`、`tests/unit/api/wishlist-route`、`tests/unit/components/WishlistPage`・`NewsSection`、`tests/integration/ui/look-admin-create-screen` | 署名が null の画像は元の URL に戻さない。カートは `/placeholder.png`、お気に入りは `image_url: null`、`image_url` が null の 1 件があっても全体を捨てない |
| 署名（Task 3〜5） | `tests/integration/api/search-image-signing`（ITEM・LOOK・NEWS 各 3 本）、`tests/unit/lib/storage/look-images`・`news-images`、`tests/integration/api/look-image-signing`・`news-image-signing`・`look-admin-item-get-api`・`look-admin-list-api`・`news-admin-item-get-api` | 期限 3600 秒、外の値（他の host・別プロジェクト・`..`・接頭辞違い）は署名を呼ばず `null`、署名の失敗は `null`。「元の値を返す」現状固定を「落とす」に書き換え。記録に道筋・URL・誤りの文を含まない |
| LOOK（Task 4・11） | `tests/unit/lib/look-server`（Task 4 で 2 本、Task 11 で `getPublishedLookCoverRaw` の 5 本）、`tests/integration/ui/look-public-read-path`、`tests/unit/app/look/look-detail-page`・`tests/integration/ui/look-detail-screen` | 署名で全部外れた時に生の `image_urls` が出ない。関連商品の画像の値を `items/…` に直した（Task 3 の取りこぼし）。`og:image` の期待が `/look/<id>/og` |
| CSP（Task 7） | `tests/unit/middleware/proxy-csp`（全面書き換え）、`tests/integration/api/home-page-proxy-csp`・`privacy-proxy-headers`・`about-proxy` | jsDelivr・`placehold.co`・`readdy.ai`・`*.supabase.co` が無い。Stripe.js（`js.stripe.com`・`*.js.stripe.com`）と Turnstile は全頁に残る（Q29）。`style-src` は `['self','unsafe-inline']`、`style-src-elem` は `['self']` |
| Cookie（Task 9） | `tests/integration/api/about-proxy`・`privacy-proxy-headers` | 発行系の試験を `/cart` に移し、`/about`・`/privacy` は `session_id` が付かない試験を足した |

### E2E で足した・書き換えた期待（書いただけ。controller の本番ビルドの実測待ち）

| ファイル（`e2e/FR-...`） | 要件 ID | 内容 |
| --- | --- | --- |
| `HOME-022` | `SEC-HOME-009-AC-03`（3 幅。新規） | `/cart` →「ご購入手続きへ」→ `/checkout` → 最終確認 → Stripe の部品が出るまで、外部リソース（`^https?:`）の CSP 違反が 0 件 |
| `PRIVACY-006` | `SEC-PRIVACY-014-AC-02`（書き換え）・`-AC-03`（3 幅。新規）、`SEC-PRIVACY-015-AC-02`（新規） | `script-src` に `cdn.jsdelivr.net` が無い／`https://js.stripe.com` と `https://*.js.stripe.com` がある（Q29）。`/cart`・`/checkout` で `session_id` が発行され（HttpOnly・Lax・32 桁の 16 進）、`/`・`/about`・`/terms`・`/news` では `networkidle` の後も発行されない。ヘッダーの `/cart` の `Link` は `prefetch={false}` |
| `ABOUT-010` | `SEC-ABOUT-004-AC-01`・`-AC-02`（書き換え） | AC-01 は `Set-Cookie` の有無を見ず `Cache-Control` だけを見る。AC-02 は固定の 32 桁の値を `Cookie` に付ける形 |
| `LOOK-SEC-001` | `SEC-LOOK-006-AC-03`（1 回。新規） | 公開の LOOK の `og:image`（`/look/<id>/og`）が 200・`image/*`・`public`+`max-age=300`+`s-maxage=300`・`nosniff`・`Set-Cookie` なし。非公開にした後・存在しない id・数字でない id は 404 |
| `LOGIN-036` | （注の文のみ） | 注の文を「proxy が `/cart` などの決済の道で付ける」に直した |

### E2E で外した `test.fail`（18 行）

外した行は 9 ファイルの 18 行。**反転して通ることは本番ビルドの E2E で未確認**（controller が実測する。通らなければ印を戻し、残った原因を見る）。

| ファイル（`e2e/FR-...`） | 外した要件 ID | Task |
| --- | --- | --- |
| `SEARCH-019` | SEC-SEARCH-014 | 3 |
| `SEARCH-021` | SEC-SEARCH-016（Task 3）、SEC-SEARCH-015-AC-01（Task 4） | 3・4 |
| `HOME-023` | SEC-HOME-006-AC-02、SEC-HOME-007-AC-01 | 3 |
| `LOOK-SEC-001` | SEC-LOOK-007-AC-01、SEC-LOOK-008-AC-01（Task 4）、SEC-LOOK-006-AC-02（Task 11） | 4・11 |
| `HOME-022` | SEC-HOME-009-AC-01（Task 7）、SEC-HOME-017-AC-01（Task 8）、SEC-HOME-009-AC-02（Task 12。条件つき: 赤なら印を戻し、残った違反の `blockedURI` を見る） | 7・8・12 |
| `ABOUT-010` | SEC-ABOUT-003-AC-01（Task 7）、SEC-ABOUT-003-AC-02（Task 8） | 7・8 |
| `PRIVACY-006` | SEC-PRIVACY-014-AC-02（反転でなく期待の書き換え）、SEC-PRIVACY-015-AC-01（3 幅） | 7・9 |
| `NEWS-SEC-003` | SEC-NEWS-004-AC-02、SEC-NEWS-023-AC-01（AC-02 は手元の置き場の `cache-control` が 3600 か未実測） | 8 |
| `LOGIN-030` | SEC-AUTH-022-AC-02（desktop の 1 幅。HTTP の試験なので幅は無関係） | 10 |

SEC-NEWS-007・008 の E2E（`FR-NEWS-SEC-001`）は `/api/news` が `image_url` を返さないので元から緑で、署名の関数の確かめは単体・結合に置いた。`SEC-ABOUT-006-AC-01`・`SEC-ABOUT-007-AC-01`（確かめ方は `build-env-guard.test.ts`）・`SEC-NEWS-008-AC-02`（記録に 1 件。単体）は AC に E2E が無く、`baseline.json` の既知の `missing-child` のまま。

### 流していない確認（controller）

- 本番ビルドの E2E（上の外した行・足した行。`next.config.ts` はビルドに焼かれるので、3000 番に残ったアプリを止めてビルドし直す）。`FR-HOME-023:225` は手元の Storage の見本の商品画像、`FR-SEARCH-021` は `NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_URL` が同じ origin であることが前提。`FR-UI-*`・`slider-*`・`FR-CART-*`（画像 null が `/placeholder.png` になる）が壊れていないこと。
- `npm run test:trace-coverage`（`safe-object-path.ts`・`session-cookie-policy.ts`・`auth-no-store-policy.ts`・`build-env-guard.ts`・`instrumentation-client.ts` が範囲に入った）、`npm run trace:report`（`TM-HOME-37`・`TM-HOME-54`・`TM-LOOK-51`・`TM-LOOK-66`・`TM-NEWS-54`・`TM-NEWS-55` ほか「満たさない」の記述が古くなる）。
- 全体の jest（Task 3 の ITEM の fail-closed で、ほかの結合試験の商品画像の値が `items/…` の形でないと赤くなる取りこぼしがないか）。

## 開店前のセキュリティの穴 波 4 のテスト（送り元の IP・回数の鍵・監査の IP・取扱店の認可の拒否の監査・管理画面の CONTACT タブ。SEC-AUTH・ADMIN・STOCKIST・LOOK・NEWS・SEARCH）

確認日: 2026-10-28（この節は波 4 の分。並びは時系列でなく、波 3 の節の後に置く）。波 4 は移行を含まない（本番の DB の変更なし）。単体・結合は各 Task の実装者が対象の範囲で通した。本番ビルドの E2E 全件を 1 回流し、実測した（下の「実測（2026-10-28）」）。DB 結合（`tests/integration/db`）は流していない。足した・書き換えた E2E と外した `test.fail` 16 行は緑。

- 窓口の数が 1 本増えた（`GET /api/admin/stockists/access`）。Route Handler は155ファイル・197メソッド、表は154行・196メソッド。数を固定する [order-status-traceability.test.ts](../../../tests/unit/docs/order-status-traceability.test.ts)・[delivery-status-traceability.test.ts](../../../tests/unit/docs/delivery-status-traceability.test.ts) の期待を 154 → 155、196 → 197、153 → 154、195 → 196 に直した（`tests/unit/docs` 56 件通過）。
- 送り元の IP の読みが変わった（`x-forwarded-for` を読まない）ので、`jest.config.cjs` の `setupFiles` に [setupClientIp.js](../../../tests/setupClientIp.js)（`CLIENT_IP_HEADER=x-real-ip`）を足した。各試験は `x-real-ip` を送るだけで足りる。

### 新しく作った試験ファイル

| ファイル | 先頭の ID | 確かめること |
| --- | --- | --- |
| [request-ip.test.ts](../../../tests/unit/lib/request-ip.test.ts)（24 本） | `DD-AUTH-038` | `getClientIp`・`getAuditRequestContext`。`VERCEL=1` か `CLIENT_IP_HEADER` の時だけ `x-vercel-forwarded-for` → `x-real-ip` の順に読み、`x-forwarded-for` は読まない。`isIP` を通らない値・見出し無しは `null`。空の `user-agent` は `null` |
| [audit-authz-denial.test.ts](../../../tests/unit/lib/auth/audit-authz-denial.test.ts)（19 本） | `DD-STOCKIST-039` | `auditAuthzDenial`。失敗の 1 行の全項目、操作者ごとの数え（10 分 20 行）、21 回目に `denied_burst` の 1 行、22 回目以降は書かない、`denial` 無し・成功は何もしない、数え・書き込みの失敗で投げない、偽の XFF は `ip` に入らない |
| [stockist-admin-access-api.test.ts](../../../tests/integration/api/stockist-admin-access-api.test.ts)（11 本） | `API-STOCKIST-007` | `GET /api/admin/stockists/access`。204・`no-store`・表と監査に触れない、403（監査 1 行）、トークン無しの 401（監査も操作者の枠も 0）、失効した 401、503、aal1、順序（送り元の枠が認可より前）、操作者の枠、500 |
| [setupClientIp.js](../../../tests/setupClientIp.js) | （補助。ID なし） | jest の全体の環境に `CLIENT_IP_HEADER=x-real-ip` を入れる |
| [rate-limited-response-body.test.tsx](../../../tests/unit/features/items/rate-limited-response-body.test.tsx)（3 本） | （ITEM は範囲外。ID なし） | `RelatedItems`・`usePublicItems`・`PublicItemGrid`（続きの頁）が、`/api/items` の 429（`no-store`）でも本文を読み始める |
| [contact-section-rate-limited-body.test.tsx](../../../tests/unit/components/contact-section-rate-limited-body.test.tsx)（4 本） | （CONTACT は範囲外。ID なし） | 管理のお問い合わせの返信・ステータス変更・テンプレートの保存・削除が 429 でも本文を読み始める |
| [item-form-rate-limited-body.test.tsx](../../../tests/unit/components/item-form-rate-limited-body.test.tsx)（1 本） | （ITEM は範囲外。ID なし） | `ItemForm` の保存済みカラーの削除が 429 で本文を読み始め、失敗の文を出す |
| [stockists-access-route.test.ts](../../../tests/unit/api/admin/stockists/stockists-access-route.test.ts)（6 本） | `SEC-STOCKIST-019` | `GET /api/admin/stockists/access` の単体。全件の後に足した |

### 足した・書き換えた試験（範囲外の領域を手で記載）

| ファイル | 対象 | 変えたこと |
| --- | --- | --- |
| `tests/unit/components/ItemDetailAddToCart.test.tsx`（末尾 1 本） | `ItemDetailClient` | `/api/items/[id]` の 429 で本文を読み始める（Task 1b） |
| `tests/unit/components/WishlistPage.test.tsx`（末尾 2 本。`afterEach(jest.restoreAllMocks)` も） | `src/app/wishlist/page.tsx` | 一覧の取得・削除の 429 で本文を読み始める |
| `tests/unit/contexts/CartContext.test.tsx`（3 本） | `CartContext`（お気に入りの追加・解除・行の番号の引き直し） | 429 で本文を読み始める |
| `tests/unit/components/ContactPage.test.tsx`（末尾 1 本） | 公開のお問い合わせフォーム | 送信が 429 でも本文を読み始め、上限の案内を出す |
| `tests/unit/components/AccountInquiries.test.tsx`（末尾 1 本） | 会員のお問い合わせの返信 | 429 で本文を読み始め、失敗の案内を出す |
| `tests/unit/components/ShopSettingsSection.test.tsx`（1 本） | `ShopSettingsSection` | 保存の直前の読み直しが 429 でも本文を読み始め、保存の失敗の文を出す |
| `tests/unit/hooks/useOrderAttention.test.tsx`（503・429 の各枝） | G の要対応の hook | 503（要確認）・429（配送の対応済み）で `arrayBuffer` が 1 回（G-1 了承のうえ波 4 で直した 2 か所の 1） |
| `tests/unit/features/account/returns/customer-return-client.test.ts`（429・500・502・503） | G の返品の client | 同上（2 か所の 2）。修正前 6 件失敗 → 関連 10 suites 291 件通過 |
| 取扱店の作成ページの結合試験 2 ファイル（`tests/integration/ui` 配下） | `src/app/admin/stockist/new/page.tsx` | SEC-STOCKIST-019 で頁が先に `GET /api/admin/stockists/access` を呼ぶ形に合わせて書き換えた（全件の後。40 件通過） |

### 書き換えた試験（領域の範囲内は各領域の頁にも記載）

| 領域 | ファイル | 変えたこと |
| --- | --- | --- |
| AUTH 送り元（Task 2） | `tests/unit/middleware/rateLimit.test.ts`（13 本に書き直し） | 鍵は `x-real-ip`、XFF だけなら `null`、両方在れば `x-real-ip`、`request` 無しは `null`、不正な値は `null`。429・503 に `private, no-store` と `Retry-After`（`NextResponse` が投げる環境の `Response` の枝も `jest.isolateModules` で）。先頭は `DD-AUTH-038` |
| AUTH 送り元（Task 2・2b・2c） | 単体・結合 約 36 ファイル（`tests/unit/api/auth/*`・`admin/stockists/*`・`mfa-reset`・`revoke-user-sessions`・`tests/integration/api/` の `auth-*`・`look-admin-*`・`news-admin-*`・`stockist-admin-*`・`search-*` ほか）、G の `order-email-routes`・`order-refund-route`・`checkout-route-guard`・`lib/orders/{returns,tracking}` | 見出しを `x-forwarded-for` から `x-real-ip` へ。値の `, 10.0.0.1` は単一の IP に。「XFF の先頭を使う」の現状固定を「`x-real-ip` を使う／XFF は読まない」に反転（`search-rate-limit-proxy`、`stockist-admin-guards`、`admin-audit-write`、`news-public-api`）。偽の XFF は無視され `ip null` になる試験を `role-permissions-route`・`shop-settings-route`・`customer-return-route-support`・`return-route-support`・`checkout-route-guard` などに追加 |
| AUTH 守り（Task 4） | 単体 14・結合 14 ファイル（`confirm`・`login`・`login/resend`・`mfa/enroll-totp`・`mfa/verify`・`oauth/callback`・`oauth/start`・`otp/verify`・`password-reset/*`・`post-login`・`refresh`・`register`） | 「制限の呼び出しが投げても先へ進む」を「先へ進まない」に反転（`SEC-AUTH-013-AC-02`、26 試験）。`password-reset/link` は 400 `link_expired`、`confirm`・`login/resend`・`post-login` は例外がそのまま届く。`register` の宛先の枠が投げた時は 202 でなく 500。`mfa/verify` に利用者単位の枠の新規 1 本。64 suites・1392 件通過 |
| E2E の環境（Task 3） | `tests/unit/scripts/e2e/environment.test.ts`（3 本追加） | `CLIENT_IP_HEADER` の旗の値と親環境の上書き、旗が在っても手元でない Supabase は既存の見張りが止める、旗の値・有無が印を変える |
| ADMIN 権限（Task 0・7） | `tests/unit/lib/auth/admin-rbac.test.ts`（`permissions` の和集合 ＋ `denial` 9 本）、`tests/integration/api/admin-misc/admin-authorization-path.test.ts`、`tests/unit/api/admin/{cost-profit-route,receipt-route}.test.ts`（型付きモックに `permissions`） | 成功結果が `permissions`（権限の集合）を返す。`denial` は失効した session の 401（`session`）・足りない権限の 403（`permission`）・aal1 の 403（`mfa`）だけに付き、トークン無しの 401・503・500 には付かない |
| 監査 | `tests/unit/lib/audit.masking.test.ts`（5 本追加。`DD-STOCKIST-039`） | `detail`・`metadata` の文字列の制御文字（Cc・Cf）を空白に替える。入れ子・配列の中も。日本語・絵文字は不変、元の event を壊さない、秘匿キーは `[REDACTED]` のまま |
| LOOK 一覧（Task 0） | `tests/unit/components/look-section.test.tsx`、`tests/integration/ui/look-admin-list-screen.test.tsx`、`tests/unit/api/admin/looks/looks-get-route.test.ts`、`tests/integration/api/look-admin-list-api.test.ts` | 「新規作成」は `canManage` の時だけ（0 件でも出す）。窓口の認可は 1 回、`canManage` は成功結果の `permissions` から。旧「manage の 503」の試験は「session の確かめが 1 回・確認できない時 503」に置き換え。`look-section.test.tsx` にはさらに Task 1b の 429 の読み切り 3 本 |
| ADMIN メニュー（Task 0） | `tests/unit/components/AdminSettingsMenu.test.tsx` | 店長12個・サポーター4個（CONTACT）、CONTACT を押す・`tab=CONTACT`・他タブでは出さない（FR-ADMIN-009-AC-01）。26 本通過 |
| STOCKIST（Task 8） | `tests/unit/features/stockist/stockist-admin-security.test.ts`、`tests/unit/api/admin/stockists/{stockists-route,stockists-id-route}.test.ts`、`tests/integration/api/stockist-admin-{guards,create-api,list-api,item-get-api,item-patch-api,item-put-api,item-delete-api,write-path}.test.ts`、`tests/unit/app/admin/stockist/stockist-create-page.test.tsx`（11 本に書き直し） | 回数の制限を送り元の枠（`enforceAdminStockistIpRateLimit`）と操作者の枠（`enforceAdminStockistActorRateLimit`）に分け、順序は送り元の枠 → 認可 → 操作者の枠 → CSRF。旧「認可で断られた要求は数えない・監査にも残さない」の現状固定を反転（403・aal1 の 403・失効した 401 は失敗の監査 1 行、トークン無しの 401 は 0 行）。作成の頁は入口の確かめ（読み込み中 → フォーム／401・403・429・500・503・通信失敗の固定文、2xx 以外の本文の読み切り）。21 suites・766 件通過 |
| ADMIN 監査（Task 9） | 単体 11 ファイル（`create-user-route`・`admin-contact-*`・`audit-logs-route`・`item-color-presets-*`・`revoke-user-sessions-route`）、結合 `admin-contact-*`・`admin-item-color-presets-{save,delete}`・`admin-misc/admin-audit-write`・`admin/audit-logs` | 監査の行に `actor_email`・`ip`・`user_agent` が入る期待へ（旧: `ip` は undefined）。偽の XFF は入らない。色見本は作成（201）と削除成功だけ `admin.item_color_preset.create`・`.delete` を 1 行（色の名前・値は入れない。200・404 は書かない）。93 suites・4287 件通過 |
| LOOK・NEWS 監査（Task 10） | `tests/unit/api/admin/looks-audit.test.ts`、`tests/unit/api/admin/news/news-admin-{route,id-route}.test.ts`、`tests/integration/api/look-admin-{create-api,write-path}.test.ts`、`news-admin-{create-api,item-put-api,write-path}.test.ts` | 旧「IP は残さない」を改め、`ip` が `x-real-ip` の値で偽の XFF を含まない。`request-ip.test.ts` に空の UA が null の 1 本。29 suites・761 件通過 |
| SEARCH・NEWS 公開（Task 6） | 領域の頁（19_search・02_news_list）と `search-rate-limit-proxy.test.ts` | 回数の鍵は `x-real-ip`。XFF だけなら null |

### E2E で足した・書き換えた期待（本番ビルドの E2E 全件で緑）

| ファイル（`e2e/FR-...`） | 要件 ID | 内容 |
| --- | --- | --- |
| `STOCKIST-014` | `SEC-STOCKIST-019-AC-03`・`SEC-STOCKIST-021-AC-02`・`-AC-03`（新規） | `access` は店長 204・サポーター 403・未ログイン 401・全部 `no-store`。トークン無しの PATCH は 401 で固定の `x-real-ip` の `audit_logs` が 0 行（対照にサポーターの 403 を送ると 1 行）。権限の無い会員の GET を 25 回送ると `{failure: 20, denied_burst: 1}`（窓の境をまたぐ試行は捨ててやり直す） |
| `STOCKIST-013` | `SEC-STOCKIST-019-AC-01`・`-AC-02`（`test.fail` を外し、空振り防止に「読み込み中」が消え `main .text-red-600` が見える確認を追加。3 幅） | 作成の頁を未ログイン・サポーターで開くとフォームが出ず、固定の誤りの 1 行が出る |
| `STOCKIST-015` | `SEC-STOCKIST-012-AC-01`（`test.fail` を外した）、`SEC-STOCKIST-007-AC-02`（見出しを `x-real-ip` に） | 偽の `x-forwarded-for: 203.0.113.9` を付けても行の `ip` が `x-real-ip` の値で、偽の値を含まない |
| `ADMIN-MISC-002` | `SEC-ADMIN-022-AC-03`（新規） | 利用者の作成の失敗と成功の行に `actor_email`・`ip`・`user_agent` が入る |
| `ADMIN-MISC-003` | `SEC-ADMIN-009-AC-01`（強化・`test.fail` を外した） | 全行の `ip` が `x-real-ip` の値で偽の値を含まない、行為者の行の `actor_email` が管理者のメール（トークン無しの 401 の行は全体の上限で書かれないことがあるので最低は行為者の 2 行） |
| `ADMIN-MISC-004` | `SEC-ADMIN-023-AC-02`（新規） | 問い合わせの詳細と監査ログを読むと、2 行の `ip`・`user_agent` が付けた値で偽の値を含まない |
| `ADMIN-MISC-005` | `SEC-ADMIN-022-AC-01`（`test.fail` を外した。`:219` の `SEC-ADMIN-002-AC-02` は残す） | 色見本の作成・削除の監査 |
| `ADMIN-MISC-007` | `SEC-ADMIN-022-AC-02`（強化・`test.fail` を外した） | 問い合わせの返信の `ip` が `x-real-ip` の値と一致 |
| `ADMIN-MISC-006` | `FR-ADMIN-009-AC-01`・`-AC-05`（`test.fail` を外した。3 幅） | AC-01 は CONTACT のタブが出て押すと問い合わせの一覧が出る、AC-05 は返信のテンプレートを作り・直し・消せて選ぶと返信の本文に入る（`ContactSection` を管理画面で初めて開く） |
| `ADMIN-029` | （店長のメニュー） | 店長のメニューに `CONTACT`（PACKING の次）。12 個 |
| `LOOK-SEC-003` | `SEC-LOOK-019-AC-04`（`test.fail` を外した。3 幅）、`SEC-LOOK-011-AC-01`（毎回違う `x-real-ip`） | 権限の無い人の一覧で「新規作成」が button・link とも 0 件 |
| `LOOK-SEC-004` | `SEC-LOOK-020-AC-02`（強化・`test.fail` を外した） | 行の `ip` が `x-real-ip` の値で偽の XFF を含まない |
| `NEWS-SEC-005` | `SEC-NEWS-016-AC-01`（行が 1 件）と `-AC-03`（新規。`ip` が `x-real-ip` の値で偽の XFF を含まない） | 作成を 2 回流す。`uniqueIp` を 8 区切りの IPv6 にした（6 区切りは `isIP` が 0 で ip が null になる） |
| `LOGIN-035` | `SEC-AUTH-013-AC-01`（`test.fail` を外した） | 固定の `x-real-ip` に毎回違う XFF を付けて `/api/auth/refresh` に 31 回送ると 31 回目が 429（desktop の 1 幅） |
| `SEARCH-022` | `SEC-SEARCH-006-AC-01`・`SEC-SEARCH-020-AC-01`（`test.fail` を外した。AC-01 の 3 幅） | `:288,291` は XFF のまま（見出しの無い要求は `ip null` の 1 つの枠に集まり 121 回目が 429） |
| `NEWS-SEC-003` | `SEC-NEWS-011-AC-01`（専用の送り方 `getNewsFromFixedSource` に替え、`test.fail` を外した） | 固定の `x-real-ip` に毎回違う XFF |
| 送り元の見出しの書き換え | `LOGIN-024・030・031・032・034・036・038`、`PWRESET-002・009・010`、`SIGNUP-002・003`、`member-session-helpers`、`SEARCH-018〜024`、`WISHLIST-011`、`LOOK-DETAIL-019`、`LOOK-SEC-005`、`look-admin-test-utils`、`stockist-admin-test-utils`、G/H の `ACCOUNT-035`・`return-request-test-utils`・`order-status-test-utils`・`delivery-tracking-test-utils`（5 行） | `'x-forwarded-for'` を `'x-real-ip'` に（値の作り方は不変）。残る `'x-forwarded-for'` は、GoTrue 直（`admin-session-test-utils`・`home-grant-test-utils`・`news-test-utils`）、置き場への送信に付かないことの表明（`ACCOUNT-036:50`）、偽の XFF を送る意図の試験 |

### E2E で外した `test.fail`（16 行）

外した行は 12 ファイルの 16 行。反転して通ることは本番ビルドの E2E 全件で確かめた。`grep -rnE "test\.fail" e2e | grep -E "SEC-(AUTH-013|SEARCH-(006|020)|NEWS-011|LOOK-(011|019|020)|ADMIN-(009|022)|STOCKIST-(012|019|020|021))|FR-ADMIN-009"` は 0 件。

| ファイル（`e2e/FR-...`） | 外した要件 ID | Task |
| --- | --- | --- |
| `LOGIN-035` | SEC-AUTH-013-AC-01 | 5 |
| `SEARCH-022` | SEC-SEARCH-006-AC-01、SEC-SEARCH-020-AC-01 | 6 |
| `NEWS-SEC-003` | SEC-NEWS-011-AC-01 | 6 |
| `ADMIN-MISC-006` | FR-ADMIN-009-AC-01、-AC-05 | 0 |
| `LOOK-SEC-003` | SEC-LOOK-019-AC-04 | 0 |
| `STOCKIST-013` | SEC-STOCKIST-019-AC-01、-AC-02 | 8 |
| `STOCKIST-014` | SEC-STOCKIST-020-AC-01、SEC-STOCKIST-021-AC-01 | 8 |
| `STOCKIST-015` | SEC-STOCKIST-012-AC-01 | 8 |
| `ADMIN-MISC-003` | SEC-ADMIN-009-AC-01 | 9 |
| `ADMIN-MISC-005` | SEC-ADMIN-022-AC-01 | 9 |
| `ADMIN-MISC-007` | SEC-ADMIN-022-AC-02 | 9 |
| `LOOK-SEC-004` | SEC-LOOK-020-AC-02 | 10 |

残す `test.fail`: `FR-ADMIN-MISC-005:219`（SEC-ADMIN-002-AC-02。DB の aal2）、`FR-LOOK-SEC-004:303`（SEC-LOOK-012-AC-03）、`FR-LOGIN-032:402,488`。

### 実測（2026-10-28）

- 手元の `npm run db:reset` の後、DB なしの jest 全体は 803 suites・20226 件通過・0 失敗。`npm run test:trace-coverage` は届かない分岐の節に無い 0 件・ずれた 0 件。`npm run validate-trace` は基準より増えた 0 件。
- 本番ビルドの E2E 全件（1 回）は 185 failed・4832 passed・26 skipped。波 3 の 183 failed（`.superpowers/sdd/2026-10-25-security-gap-fixes/e2e-results-wave3-full.json`）と比べて新しく赤になった 10 ファイル（FR-ITEM-031・FR-PRIVACY-006・FR-ADMIN-057・FR-HOME-022・NFR-HOME-002・FR-CART-024・FR-CHECKOUT-039・FR-LOGIN-038・FR-NEWS-ALL-001・002）は、1 並列の再実行で 200 件とも通った（並列の揺れ）。外した `test.fail` 16 行と足した E2E は緑。
- 全件の後に見つけて直した物: 取扱店の作成ページの結合試験 2 ファイル（SEC-STOCKIST-019 で頁が先に `GET /api/admin/stockists/access` を呼ぶ形に合わせた。40 件通過）、`test-gaps.md` の行のずれ 22 件、新しい単体 `tests/unit/api/admin/stockists/stockists-access-route.test.ts`（6 件）。
- LOOK の管理の一覧（`LookSection.tsx` の 3 か所）と G の画面 2 か所（`useOrderAttention.ts`・`customer-return-client.ts`）に、no-store の 429・503 の本文を読み切る 1 行を足した。ほかの G/H の 11 か所は G-1 への引き継ぎ（台帳の「波 4 の注」）。
- 流していない物: DB 結合（`tests/integration/db`）。波 4 は DB を変えないが、`rate_limit_counters.ip` に `null` が入る経路は fake client の結合でしか確かめていない。
- 参考（流す前の見立て）。部分実行は `npx playwright test e2e/FR-LOGIN e2e/FR-PWRESET e2e/FR-SIGNUP e2e/FR-SEARCH e2e/FR-NEWS-SEC-003 e2e/FR-NEWS-SEC-005 e2e/FR-WISHLIST-011 e2e/FR-STOCKIST e2e/FR-ADMIN-MISC e2e/FR-ADMIN-029 e2e/FR-ADMIN-123 e2e/FR-LOOK-SEC-001 e2e/FR-LOOK-SEC-002 e2e/FR-LOOK-SEC-003 e2e/FR-LOOK-SEC-004 e2e/FR-LOOK-SEC-005 e2e/FR-LOOK-DETAIL-019 e2e/FR-LOOK-ADMIN-001 e2e/FR-ACCOUNT-035 e2e/FR-ACCOUNT-036 e2e/FR-CHECKOUT-005 e2e/FR-CHECKOUT-025 e2e/FR-CHECKOUT-046 e2e/FR-HOME-022`、そのあと全件を波 3 の全件（183 failed）と比べる。新しい赤の見立て: ①429（`x-real-ip` の書き換え忘れ。見出しの無い要求の枠が `ip null` の 1 つにまとまった）、②503（`ip` に文字列が入った）、③`networkidle` が止まる（`no-store` の 429・503 の本文を読まない呼び手）、④CONTACT タブでメニューの並びを見る試験、⑤監査の `ip` が空。
