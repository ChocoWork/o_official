# DB マイグレーション運用

> 交換の印 移行 B 確認日: 2026-11-10。移行 `20261110104605_unit_binding_core.sql`（値段の計画の材料・確かめと記録・返金の結び・取り押さえの重ね定義）を末尾の「交換の印と1着ずつの記録の移行 B（FREQ-642 Task 4、2026-11-10）」に追記した。手元の DB で確かめた。本番は未適用。
>
> 交換の印 移行 A 確認日: 2026-11-10。移行 `20261110090325_unit_binding_schema.sql` を末尾の「交換の印と1着ずつの記録の移行 A（FREQ-642 Task 2、2026-11-10）」に追記した。手元の DB で確かめた。本番は未適用。
>
> 会計の計画 2 確認日: 2026-11-09。移行 S6〜S14（`20261108150000`〜`20261108230000`、9本）を末尾の「会計の作り直し 計画 2 の移行 S6〜S14（手元の DB で確認済み・2026-11-09 本番適用済み）」に追記した。本番へは 2026-11-09 にオーナーの承認で当てた（その節の「本番への適用の記録」）。適用の前提（計画1が本番にあること、接続先のオーナー確認、S6 前の発送票の件数）と、移行の間の呼び出しの依存（S8 → S11、S9 → S11）を、その節に書いた。
>
> 会計の計画 1 確認日: 2026-11-08。移行 S0〜S5（`20261107130000`〜`20261107130500`）を末尾の「会計の作り直し 計画 1 の移行 S0〜S5（手元の DB で確認済み・2026-11-08 本番適用済み）」に追記した。本番へは 2026-11-08 に当てた（その節の「本番への適用の記録」）。

> 返品の受け取りの数え方の直し 確認日: 2026-11-08。1回目の形に戻した（受け取りの時の結び付けは外した。オーナー決定）。直していない場面を「既知の点」に書いた。移行 `20261108063711_return_receive_unit_dedup.sql` を追記した（「返品の受け取りの数え方の直しの移行（I-1・N-1、2026-11-08）」の節）。手元の DB で当てて確かめた後、2026-11-08 にオーナーの許可で本番へ MCP の `apply_migration` で当てた（版 `20261108063711`。ファイル名をその版に直した）。デプロイは移行を先に当ててからコードを出す。

> 確認日: 2026-11-08。「ローカル開発について」の節の古い記述（seed が無い・pre-push の E2E を手元の DB にするかは未決）を、今の形（`supabase/seed.sql` あり・E2E と pre-push は手元の DB）に直した。

> 返品の品ごとの返金 Task 1 確認日: 2026-11-06。移行 `20261106005536_return_receive_per_item.sql` を追記した（「返品の受け取りの品ごとの返金の移行（FREQ-641 Task 1）」の節）。手元の DB だけで当てて確かめた。デプロイは移行を先に当ててからコードを出す。本番には 2026-11-06 にオーナーの許可を得て `supabase db push --linked` で当てた（`schema_migrations` に version と名前 `return_receive_per_item` が入り、`refund_choice` の列2つがあることを確かめた）。当てた後に master を push した。

> 波 6 確認日: 2026-11-01。パスワード変更の確認コードの移行 M3（`20261101120000`）を追記した（「波 6 パスワード変更の確認コードの移行 M3」の節）。手元は適用済み、本番も 2026-11-01 21:06 頃 JST に適用済み（Task 11。G-1 に知らせ、dry-run が M3 の1本だけと確かめてから `db push --linked`。照合は同じ節）。

> グループ H 本番適用: 2026-11-01（`20261029130000`〜`20261029130600` の7本。照合は末尾の「グループH 本番適用の記録」）

> 波 5 確認日: 2026-10-29。アプリの session への結び付けの移行 M1（`20261029120000`）を追記した（「波 5 アプリの session への結び付けの移行 M1」の節）。2026-10-29 に本番へ適用済み。M2（`20261029120100`、`has_permission` の aal2 と会員の表の方針）を同じ日に追記した（「波 5 `has_permission` の aal2 と会員の表の方針の移行 M2」の節）。**M2 も 2026-10-29 に本番へ単独で適用済み**（オーナーの決定。G-1 の次の適用より前。`npx supabase db push --linked`、dry-run は M2 の 1 本だけ）。

> 波 2 確認日: 2026-10-27。権限・検索・制約・置き場の移行 6 本（`20261026130100`〜`130600`）を追記した（「波 2 権限・検索・制約・置き場の移行 6 本」の節）。2026-10-27 に本番へ適用済み（G-4 と一緒に）。以後の移行は GRANT を明示する決まりも同じ節に書いた。

> G-4 Task 4 確認日: 2026-10-26。fix round 2後の第3の移行 G4C（割当の入替・書き手76本）はcontrollerのfresh reset（g4t4b）でローカル適用・検証済み。group_g*全53 suiteは1,721成功・0失敗・1 pending、並行12/12を3回連続。全件検証も新規失敗なし（「G4Cの適用と再検証」）。本番未適用。

> G-4 Task 2 確認日: 2026-10-26。初回（g4t2a）: controllerのfresh reset後、PostgREST anon/authenticated各200、group_g* 50 suite・1,606成功・0失敗・1 pending（G1_CLEANUP_SUITE=1専用清掃の未起動）。修正round 1後（g4t2b）: controllerのfresh reset・PostgREST anon/authenticated各200、group_g* 50 suite・1,611成功・0失敗・1 pending（G1_CLEANUP_SUITE=1専用清掃の未起動）。unit＋全DB integrationは19,935成功・既知stockist_rlsの2失敗のみ（新規失敗なし）、G-0清掃12/12。本番未適用。

> G-4 本番適用: 2026-10-27 09:06 JST（`20261026045859`・`20261026054705`・`20261026101624`。別セッションの7本と同じ push。照合は G-4 の節の「G-4 本番適用の記録」）

> G-3 本番適用: 2026-10-26 08:33 JST（`20261025053324`・`20261025070821`・`20261025100130`・`20261025134538`。照合は G-3 の節の末尾） | G-3 Task 10 確認: 2026-10-26（4移行assert・75本・並行/PostgREST試験。controllerのfresh resetでgroup_g* 47 suiteを検証、SQLは不変で試験材料3件を直し、group_g3_concurrency 24/24を3回連続・group_g3_migration_asserts 64/64で通過） | 状態: 運用方針（グループ G-1 の移行の節は 2026-10-24 に、グループ G-2 の移行の節は 2026-10-25 に追記。G-2 は Task 1 の基盤と Task 2 の発注書の9表と Task 3 の在庫一覧表の読取と、Task 4 の2本目の移行〔発注の作成とロック helper〕と、Task 5 の発注一覧表・発注書の詳細の読取〔基盤の移行の節15〕と、Task 6 の数量の確定・訂正・打切り・発注先の訂正〔2本目の移行の節3〜5〕と、Task 7 の受け取りとその取消〔2本目の移行の節6・7〕と、Task 8 の取引書類の原本〔基盤の移行の節16の検索、2本目の移行の節8の予約・確定・訂正〕と、Task 9 の書き手の閉じた一覧・全入口の並行・末尾の確かめの完成〔「適用の手順と確認」〕と、Task 11 の本番適用の記録まで。G-3 は Task 1 の基盤・Task 2 の読取・Task 4 の書き手の移行・Task 6 の発送の取消を追記） | 確認日: 2026-10-26 | 本番適用状況: G-1 の移行は 2026-10-24 に、G-2 の移行2本は 2026-10-25 12:39 JST に適用済み | G-3 Task 9 確認: 2026-10-26（修正前はfresh reset・12 suite・639/639成功、Fix round 1は再検証対象）

## 概要

G-3 Task 1 の発送票の基盤を 2026-10-25 に追記した。ローカルはcontroller reset後のDB全件でTask 1の新規失敗0。全体は既知stockist2失敗によりexit 1。本番へのG-3適用は未実施。

G-3 Task 2 の荷作り表・票・会計入力の読取移行を同日に作成した。Task 5までローカルへ適用後、controllerが実鍵PostgRESTを含む12 suiteで665/665成功を確認した（2026-10-25）。

本書はデータベースマイグレーションの現行手順と過去の移行記録をまとめる。実際の適用対象は `supabase/migrations/` と `.github/workflows/db-migrations.yml` で確認し、本番台帳は実行前に読み直す。グループ G-1 の移行（本番のテスト用の注文を消す清掃を含む1本）の内容・当て方・記録は「グループ G-1 在庫の割当の移行」に書く。グループ G-2 の移行（発注・受け取り・原本の添付）は末尾の「グループ G-2 発注・受け取りの移行」に書く。

本番 Supabase（`pjidrgofvaglnuuznnyj`）へのスキーマ適用手順と、
マイグレーションの書き方の規約。

## グループ G-4: 注文一覧表・注文の詳細（FREQ-523・540、2026-10-26）

| 順 | ファイル名 | 役割・状態 |
| --- | --- | --- |
| 1 / G4A | [20261026045859_group_g4_orders_foundation.sql](../../supabase/migrations/20261026045859_group_g4_orders_foundation.sql) | 土台。発送票の注文別索引・確定の期限境界・割当理由18値。2026-10-26のcontroller fresh reset（g4t1a）でローカル適用済み、本番未適用。2026-10-27 に本番適用済み（「G-4 本番適用の記録」） |
| 2 / G4B | [20261026054705_group_g4_orders_reads.sql](../../supabase/migrations/20261026054705_group_g4_orders_reads.sql) | 内部3本、private本体4本とpublic入口4本。STABLEな一覧・CSV材料・詳細・品物の状態履歴。初回（g4t2a）: controllerのfresh reset後、PostgREST anon/authenticated各200、group_g* 50 suite・1,606成功・0失敗・1 pending（G1_CLEANUP_SUITE=1専用清掃の未起動）。修正round 1後（g4t2b）: controllerのfresh reset・PostgREST anon/authenticated各200、group_g* 50 suite・1,611成功・0失敗・1 pending（G1_CLEANUP_SUITE=1専用清掃の未起動）。unit＋全DB integrationは19,935成功・既知stockist_rlsの2失敗のみ（新規失敗なし）、G-0清掃12/12。本番未適用。2026-10-27 に本番適用済み（「G-4 本番適用の記録」） |
| 3 / G4C | [20261026101624_group_g4_orders_swap.sql](../../supabase/migrations/20261026101624_group_g4_orders_swap.sql) | 割当入替の書込み1本（private本体＋public入口）・候補の読取1本（private本体＋public入口）・押さえの道具1本、書き手一覧76本。Task 4 で作成。controllerのfresh reset（g4t4a）でローカル適用済み、本番未適用（検証の結果は下の「G4Cの適用と再検証」）。2026-10-27 に本番適用済み（「G-4 本番適用の記録」） |

確認日: 2026-10-26。G-1・G-2・G-3 は本番へ適用済み（Task 1 依頼時の確認）。上の過去の節の未適用表記は当時の記録。G4Aはローカル適用済み・本番未適用で、既存の移行ファイルは編集しない。別セッションの `20261026010000_auth_return_intents.sql` は変更せず、その認証機能をG-4の試験の前提にしない。理由の単体は全SQLからCHECK本文を抽出する。3本の版は G4A < G4B < G4C とする。

G4A は、`shipment_slip_fulfillments_order_idx` を `public.shipment_slip_fulfillments(order_id)` の通常の非一意 btree として追加する。確定の private 本体は G-3 の文をそのまま写し、`CREATE OR REPLACE` と `expires_at <= now()` の2箇所だけ変える。所有者・ACL を再設定せず、OID・所有者・ACL・属性・書き手の OID 集合を保つ。期限ちょうどの下書きを読取と確定の双方が期限切れと判定し、1秒先は次の検証へ進む。理由 CHECK と TS は従来17値に `allocation_swap`（割当の入替）を足した18値。公開の入替操作は後続 Task の対象。

末尾の `$g4a_final_objects$` は、索引の表・列・種類・有効性・非一意、確定の所有者・DEFINER・空 search_path・EXECUTE の意味と期限比較・表の参照より先のロック、NULL を許す理由 CHECK の18値完全一致、この取引の2表への行作成が無いこと、G4A 時点の書き手75本を確認する。違反は `GROUP_G_MIGRATION_ASSERTION_FAILED / 55000`、DETAIL は `orders_foundation_index`・`orders_foundation_confirm`・`orders_foundation_reasons`・`orders_foundation_rows`・`orders_foundation_allowlist` のいずれか。ACL の文字列表現は比較せず、private schema の USAGE と表の権限は操作しない。

再実行する G3A の assert は、取引内で理由 CHECK を G3A の17値へ復元し、**復元→改ざん→許可一覧の再現→assert** の順に流す。G4A の75本の assert は `runWithAllowlist` と `G3D_ALLOWLIST` で当時の集合を再現する。いずれも呼出し元の rollback で戻す。

controllerのfresh reset（g4t1a）でG4Aを適用し、PostgREST anon/実authenticatedは各HTTP 200。実鍵PostgRESTを含むgroup_g*全49 suiteは1,526成功・1失敗・1 pendingだった。失敗は所有者をanonへ変える改ざん材料がassert前に42501となる1件で、SQLを変えず修正round 1で解消。pendingはgroup_g1_cleanupの `G1_CLEANUP_SUITE=1 で単独に流す時だけ動かす（全注文を消して commit するため）`。通常全件ではこの専用清掃を起動しない。修正round 1で実装者がローカルDBの [末尾 assert](../../tests/integration/db/group_g4_migration_asserts.integration.test.ts)・[土台](../../tests/integration/db/group_g4_foundation.integration.test.ts)・G3末尾assertを実行し、3 suite・94/94成功。controllerのfresh reset後の全件検証（g4t1）はunit＋全DB integrationで19,665成功・既知stockist_rlsの赤2件だけが失敗し、新規失敗なし。G-0基準の専用清掃は別に12/12成功（すべて2026-10-26）。本番未適用。以後SQLを変更した場合はcontrollerがresetから再検証する。

### G4Bの適用と再検証（2026-10-26）

G4Bは先頭BEGIN、G4BのBODY/FINAL_ASSERT節印、末尾assert→NOTIFY→COMMITの1取引。ASCII・BOMなし・LF。SQLにはデータ変更、表の追加、private schemaのUSAGE変更、別セッションの認証移行への依存がない。G4Bの今回のサイズ・MD5と初回の値は下表に記録する。非DB検証の実測はTask 2報告へ記録する。既存のG4AとG-1〜G-3の適用済みSQLは編集しない。

| G4Bの版 | bytes | MD5 | 適用・検証 |
| --- | --- | --- | --- |
| 初回（g4t2a） | 34,778 | `7DAFF1634E1B026CDA04C76DDA366981` | controller fresh reset・PostgREST anon/authenticated各200、group_g* 50 suite・1,606成功・0失敗・1 pending（専用G-1清掃の未起動）。初回の全件g4t2は19,912成功・既知stockist_rlsの2失敗だけ、G-0清掃12/12。本番未適用 |
| 修正round 1 | 35,038 | `0B931939008EAE84059EE5123633D70D` | reasons CTEで阻害理由を1回集約してLEFT JOIN。attention=false/未指定は絞り込まない。修正round 1後（g4t2b）: controllerのfresh reset・PostgREST anon/authenticated各200、group_g* 50 suite・1,611成功・0失敗・1 pending（G1_CLEANUP_SUITE=1専用清掃の未起動）。unit＋全DB integrationは19,935成功・既知stockist_rlsの2失敗のみ（新規失敗なし）、G-0清掃12/12。本番未適用 |

| 末尾assertのDETAIL | 確認するもの |
| --- | --- |
| `orders_reads_internal` | private内部3本だけ、publicの同名0本、余分なoverloadなし、postgres所有・STABLE・DEFINER・空search_path・署名/戻り列、PUBLIC/anon/authenticated/service_roleのEXECUTEなし |
| `orders_reads_functions` | private本体4本だけ、署名・引数名・戻り型/列・postgres所有・STABLE・DEFINER・空search_path。service_roleだけにEXECUTE |
| `orders_reads_public` | public入口4本だけ、同じ署名・戻り列、postgres所有・STABLE・SQL INVOKER・空search_path、private同名への委譲、service_roleだけにEXECUTE |
| `orders_reads_no_write` | 11本のprosrcを小文字化・空白正規化してINSERT INTO・UPDATE schema.・DELETE FROM・TRUNCATE・MERGE INTOが0件、探索数が11で空でない |

違反はすべて `GROUP_G_MIGRATION_ASSERTION_FAILED / 55000`。ACLはhas_function_privilege・aclexplodeで意味を検査し、proacl::textを比較しない。改ざんは内部へのservice_role付与・public/anon/authenticated付与・VOLATILE・DEFINER変更・入口削除・overload・別委譲・書込み文・一時ロールへの所有者変更を取引内で再現しrollbackする。G4Aの当時の75本は既存のrunWithAllowlistのまま再現する。

実装者はSupabase CLI・Docker・DB・Playwrightを起動しない。controllerがfresh reset→既存のanon/実authenticatedのPostgREST smoke各HTTP 200→[G4読取](../../tests/integration/db/group_g4_reads.integration.test.ts)・[G4末尾assert](../../tests/integration/db/group_g4_migration_asserts.integration.test.ts)・G1 item_states・G3 readsを実行する。SQLを直したら再度resetから通す。単体/型/lintの成功をDB適用・ACL・PostgREST・本番の証拠にしない。

### G4Cの適用と再検証（2026-10-26、Task 4）

G4Cは先頭BEGIN、G4CのBODY/FINAL_ASSERT節印、末尾assert→NOTIFY→COMMITの1取引。ASCII・BOMなし・LF。表・列・制約・triggerを変えず、G-1の割当の境界trigger（`GROUP_G_ALLOCATION_BOUNDS`）も緩めない。G4A・G4B・G-1〜G-3の適用済みSQLは編集しない。別セッションの認証移行へは依存しない。

| 関数 | 役割 |
| --- | --- |
| `private.lock_group_g_allocation_swap(uuid,uuid,uuid)` | 押さえの道具。最初の文が共通advisory `pg_advisory_xact_lock(190521,1)`。その後に2つの明細から注文とvariantを読み、`private.lock_group_g_inventory(variant配列, 注文配列, NULL)` を呼んでロックした注文IDを返す。誰にもEXECUTEなし |
| `private.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid)` | 書込み本体（SECURITY DEFINER）。許可一覧の76本目。service_roleだけEXECUTE |
| `public.admin_swap_order_allocations(…)` | 同名・同引数・同戻り型のSQL INVOKER入口。private本体へ委ねるだけ。service_roleだけEXECUTE |
| `private.list_admin_allocation_swap_candidates(uuid,uuid,uuid)` / `public.…` | 候補の読取（STABLE）。権限は `admin.orders.allocate` と `admin.orders.read`。明細の存在・所属を確かめた後、受け手の注文がpaid/shipped以外なら書込みと同じ `GROUP_G_SWAP_ORDER_NOT_PAID / 22023`。同じvariantの有効なpaid割当（remaining_quantity > 0）が残る出し手の注文をMATERIALIZEDで先に絞ってから投影する。最大50行 |

書込み本体の処理の順（G-3の書込みと同じ）: ①引数の検証（NULL・数量1〜99999・理由200字以内・同じ明細は `GROUP_G_ARGUMENT_INVALID`、trim後に空の理由は `GROUP_G_SWAP_REASON_REQUIRED`）→ ②押さえの道具 → ③権限（`GROUP_G_FORBIDDEN / 42501`）→ ④指紋（operation・注文・両明細・数量・trim後の理由・actor）と再送（同じ鍵・同じ指紋は前の結果に `replayed:true`、違えば `GROUP_G_REQUEST_KEY_CONFLICT / 23505`）→ ⑤存在と整合を次の順に最初の違反で止める: 明細が無い・注文に属さない `GROUP_G_SWAP_ITEM_NOT_FOUND / P0002`、`GROUP_G_SWAP_SAME_ORDER`、`GROUP_G_SWAP_VARIANT_MISMATCH`、`GROUP_G_SWAP_ORDER_NOT_PAID`（`status IN ('paid','shipped')` 以外）、投影から求めた `GROUP_G_SWAP_TAKER_ON_HOLD`・`GROUP_G_SWAP_DONOR_PENDING_REQUEST`・`GROUP_G_SWAP_DONOR_ON_HOLD`・`GROUP_G_SWAP_QUANTITY_EXCEEDS_TAKER`・`GROUP_G_SWAP_QUANTITY_EXCEEDS_DONOR`（22023）→ ⑥出し手の `kind='paid'` で残りがある割当行を `created_at, id` の昇順に使い、行ごとに出し手の残数量を減らして `version` を1進め、受け手の明細に新しい割当行を作り、`transfer` の対（出し手の `sequence` は2k−1、受け手は2k、`reason='allocation_swap'`、`stock_movement_id` はNULL）を書く → ⑦品物の状態の履歴（`allocation_swap`）→ ⑧操作の受付を最後に1行。FIFOは呼ばず、`stock_movements` も `item_variants.stock_quantity` も触らない。ロック順は共通advisory →（`lock_group_g_inventory` の中で）variant・注文・明細・割当。

末尾の `$g4c_final_objects$` と `$g4c_final_table_acl$` の DETAIL は次の5つ。違反はすべて `GROUP_G_MIGRATION_ASSERTION_FAILED / 55000`。

| 末尾assertのDETAIL | 確認するもの |
| --- | --- |
| `orders_swap_functions` | 5本の署名・引数名・戻り型/列・postgres所有・DEFINER/INVOKER・揮発性・言語・空search_path・EXECUTE（押さえの道具は誰にもなし、本体と入口はservice_roleだけ）。入口の委譲先 |
| `orders_swap_lock_order` | 書込み本体のprosrc（注釈を除き小文字・空白を畳む）で `private.lock_group_g_allocation_swap(` が割当・割当イベント・台帳・variant・注文・明細の表の最初の参照より前。探索が空でない。押さえの道具の最初の文が共通advisoryで `lock_group_g_inventory` を呼ぶ |
| `orders_swap_allowlist` | 許可一覧が76本の固定集合とOIDまで一致（1本外す・1本足す・別の関数に替える・重複を拒否） |
| `orders_swap_function_set` | 3つの名前のpublic/private関数が上の5本だけ（同名の別overloadなし） |
| `orders_swap_table_acl` | 書込み先の4表（割当・割当イベント・品物の状態履歴・操作の受付）にanon/authenticatedの権限・列権限がなく、service_roleは決めた表のSELECTだけ。PG17のMAINTAINも含む。ACLは `has_*_privilege` と `aclexplode` の意味で見て、`proacl::text` は比較しない |

許可一覧の本数は G4A=75、G4C=76。試験の共有の道具 `group-g-allowlist.ts` は `G4_ALLOWLIST`（76本）と、今のDBの一覧を指す `CURRENT_ALLOWLIST` を持つ。「今のDBの一覧が固定の集合や本数と等しい」ことを確かめる生きた検査は `CURRENT_ALLOWLIST` とそのlengthに向け、次の段階が本数を足す時はこの指し先だけを付け替える。G2B（65）・G3C（72）・G3D（75）・G4A（75）・G4C（76）の末尾assertの再実行は、流す前に取引内でその時点の一覧（`G2_ALLOWLIST`・`G3C_ALLOWLIST`・`G3D_ALLOWLIST`・`G4_ALLOWLIST`）へ入れ替え、戻すのは呼出し元のrollbackにする。

並行試験が本物の入替を commit するため、commit 済みの行に `reason='allocation_swap'` が残る。G3A の17値の理由 CHECK を取引内で再現する試験（`group_g3_model`・`group_g3_migration_asserts`・G4A の改ざん）は、共有の `replaceReasonCheckSql` が呼出し元の取引の中だけで、追記専用の更新ガードを一時に外して再現する集合の外の理由を NULL にしてから戻し、検証付きで CHECK を付け替える。取引の外では最初の文が断り、行は消さず、呼出し元の rollback で commit 済みの実データは変わらない。移行の SQL は変わらない。

| G4Cの版 | bytes | MD5 | 適用・検証 |
| --- | --- | --- | --- |
| 初回（Task 4、g4t4a） | 34,940 | `859C0442F69DEAE5F2AF1D71995C2866` | controller fresh reset後に適用（SQLは変更なし）。group_g*全53 suite・1,678成功・30失敗・1 pending。30失敗は試験の材料（commit済みの `allocation_swap` の行があると17値の理由 CHECK の再現が落ちる29件と、受け手の入金の競合の待ちの確認1件）。実装者が試験側を直した後のローカル再実行は1,651成功・0失敗・4 pending（実鍵PostgRESTの3 suiteと専用清掃の1）で、並行は3回連続10/10。本番未適用 |
| Opusレビュー修正（Task 4 fix round 2、現在のSQL） | 35,487 | `E84E1F7A64AB7A544C66A90D30F572FA` | 候補の受け手の入金確認、有効なpaid割当を持つ出し手の事前絞込み、押さえの道具の最初のBEGINに固定したadvisory検査。controller fresh reset（g4t4b）でローカル適用済み、PostgREST anon/authenticated各HTTP 200。group_g*全53 suiteは1,721成功・0失敗・1 pending（G1_CLEANUP_SUITE=1で単独実行するG-1清掃の未起動）。発送確定と入荷も両順序を試す `group_g4_swap_concurrency` は12/12・12/12・12/12の3回連続成功。本番未適用 |

fix round 2後のcontroller全件検証（g4t4b、実鍵あり）: unit＋全DB integrationは20,178成功、失敗は既知の `stockist_rls` 2件だけで新規失敗なし。G-0清掃は別に12/12成功。上のgroup_g*検証と全件検証は範囲を分けた実測で、1 pendingは環境変数の指定がある時だけ単独実行するG-1清掃の未起動を示す。本番には適用していない。

### G-4 本番適用の記録（2026-10-27）

2026-10-27 09:06 JST に `npx.cmd supabase db push --linked --yes` で本番へ当てた（exit 0）。オーナーの決定（2026-10-27）で、別セッションの `20261026010000_auth_return_intents.sql` と波 2 の6本（`20261026130100`〜`20261026130600`）も同じ push で当てた（その7本の事後の確かめは別セッションの節）。dry-run は10本をこの順で示した。本番で試験の入替・一覧の読取は行っていない。

| 版 | 名前 | 文の数 | 文の MD5（`md5(array_to_string(statements, E'\n'))`） | ファイル（bytes / MD5） |
| --- | --- | --- | --- | --- |
| `20261026045859` | group_g4_orders_foundation | 8 | `cc6497251c3b2633b3a360485f53560c` | 18,813 / `bedbe829bc85fab6646ed189871fc5f3` |
| `20261026054705` | group_g4_orders_reads | 45 | `53521b0da55354c1ec6cc51fbb0035f8` | 35,038 / `0b931939008eae84059ee5123633d70d` |
| `20261026101624` | group_g4_orders_swap | 25 | `666b3da2e606a40bc8c2fe07868463c2` | 35,487 / `e84e1f7a64ab7a544c66a90d30f572fa` |

文の数と文の MD5 は、本番と手元の `db reset` 後で一致した。3ファイルとも BOM・CR・U+3000・NBSP・ゼロ幅文字は0、先頭行は `BEGIN;`、`BEGIN;`/`COMMIT;` は1組。

| 確かめ（MCP `execute_sql`、読取のみ・件数のみ） | 適用前 | 適用後 |
| --- | --- | --- |
| 履歴の最新 | `20261025134538`（G-4・別セッションの7本は無し） | `20261026130600`（`20261026010000` 以降の10版） |
| 索引 `shipment_slip_fulfillments_order_idx` | 無し（票の発送の行0） | `(order_id)` の有効な通常の btree |
| `order_item_allocation_events_reason_check` | G-3 の17値（`14e0795…`） | 18値・`allocation_swap` を含む（`20b215a…`。手元の最新と同じ） |
| 書き手の許可一覧 | 75本 | 76本・入替の関数を含む |
| `private.admin_confirm_shipment_slip(...)` の定義 MD5 | `69f5da7…`（手元を `20261025134538` まで作り直した値と同じ） | `f2b58ca…`（手元の最新と同じ） |
| `private.group_g_writer_allowlist()` の定義 MD5 | `4491ee8…`（同上） | `5508246…`（手元の最新と同じ） |
| `role_permissions`（admin / supporter） | 30 / 8 | 30 / 8（不変） |
| 注文・明細・在庫の動き・variant・在庫合計 | 0・0・0・21・0 | 変わらない（データは変えない） |
| `private.group_g_operations` | 0 | 0（新しい書込みの行は無い） |

非機密の catalog の指紋（手元の最新と本番で一致）: G-4 の18関数（定義・DEFINER・search_path・所有者・EXECUTE・ACL）`3f255a0e85dfabc63adc41e15e834f07`、public・private の全関数414本 `d3404fe69953da10e2ed6ed9ba6a5060`、policy 186 `cf0aa111d5bfb337789841e240ce8229`、trigger 158 `1b986e62cb68d7179f2ba0ef098b57ce`、索引336 `33f3896372f0ee37328a75ba2b6cf41b`。

適用前の検証（2026-10-27、手元の Supabase）: tsc・lint 0、単体＋DB 結合 20,531 通過・0 失敗、G-0 版からの清掃 12/12。E2E 全件（本番ビルド）5,012件で 4,805 通過・181 失敗・26 skip。G-3 の基準（4,922件・175 失敗・26 skip）と比べ、前に通って後で落ちた18件は1並列の単独実行で101/101通過（並列の時だけの揺れ）、G-4 の spec（110・112・121・122・123）は全部通過、消えた G-4 の題34はすべて処置表で説明がつく。記録は `.superpowers/sdd/2026-10-26-group-g4-orders/`（`prod-read-1.md`・`migration-shape.txt`・`e2e-compare.log`・`e2e-missing-map.md`）。

## なぜ変えたか

旧 `.github/workflows/db-migrations.yml` は毎回こうしていた。

```bash
for f in migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
```

問題が3つある。

1. **適用済み台帳が無い。** 毎回全ファイルを頭から流すので、全 migration が冪等でないと壊れる。
2. **トランザクションで包まれない。** `psql -f` は文ごとに autocommit する。
   `CREATE OR REPLACE FUNCTION` の直後に `REVOKE` を書く形（092・093）だと、
   その間だけ PUBLIC が EXECUTE できる窓ができる。`revoke_auth_session` は
   任意の auth セッションを消せるので、この窓は塞ぐ必要がある。
3. **ファイルと本番が一致していない。** `scripts/apply-legacy-migrations.mjs` が
   `scripts/replay-missing-objects.sql`（本番にあるがマイグレーションが作っていない
   手作りオブジェクト）を必要としている時点で、`migrations/` は本番を再現できていない。

Supabase CLI の `db push` は `supabase_migrations.schema_migrations` を台帳として
適用済みをスキップするので 1 が解決する。2 は各ファイルへ明示的に `BEGIN;` / `COMMIT;`
を書いて塞ぐ（ツールの挙動に依存しない）。3 はベースライン化で解決する（下記）。

## 波 1-A 戻り先の控えの移行（本番適用済み）

確認日: 2026-10-27。**本番適用済み（2026-10-27。G-4・波 2 と一緒に `db push --linked`）。** 事後の確かめ（読むだけ）: 表 `private.auth_return_intents` は anon・authenticated・service_role とも表の権限なし、関数 `public.create_auth_return_intent`・`public.consume_auth_return_intent`（consume だけ STRICT）は DEFINER・`search_path=""`・EXECUTE は postgres と service_role だけ、`cron.job` の `auth-return-intents-cleanup` は `20 3 * * *`。`get_advisors` の新しい項目はこの表の `rls_enabled_no_policy`（INFO。関数だけで触る作りなので意図どおり）だけ。

ログインの後の戻り先（SEC-AUTH-026・SEC-AUTH-032、DATA-AUTH-005、ADR-0412）をサーバーに控えるための移行 1 本。`20261026010000_auth_return_intents.sql`（8163 バイト、MD5 `21bd78bac76bc6f2c119a10f3dcf9a80`。Git に入った LF の内容の値で、作業ツリーが CRLF になると合わない。コミット後は `git show HEAD:supabase/migrations/20261026010000_auth_return_intents.sql | md5sum` で取る。ファイルを変えたらこの値を取り直す）。時刻は G-3 の移行 4 本（最後は `20261025134538_group_g3_shipping_actions.sql`）より後で、適用の順も全部の G-3 の移行の後。

### 何をするか

| 順 | 内容 |
| --- | --- |
| 1 | `private.auth_return_intents` を作る。列は id・token_hash（番号の sha256、16 進 64 桁、一意）・return_path（1〜512 文字、`/` で始まり、空白・制御文字・`\` を含まない）・purpose（`login` / `signup`）・created_at・expires_at・consumed_at・user_id。番号そのものの列は無い。`auth.users` への外部キーは付けない。所有者 postgres、RLS 有効、`PUBLIC`・`anon`・`authenticated`・`service_role` の表の権限を全部外す（関数だけで触る） |
| 2 | `public.create_auth_return_intent(text,text,text)`: 行を作り、期限の秒数（login 900、signup 3600）を返す。Cookie の `Max-Age` にそのまま使う |
| 3 | `public.consume_auth_return_intent(text,text,uuid)`: 1 回の `UPDATE … RETURNING` で使い切り、`return_path` を返す。期限切れ・使用済み・別の用途・存在しないは NULL。`STRICT` |
| 4 | 2 本とも `SECURITY DEFINER`・`SET search_path = ''`・所有者 postgres。`PUBLIC`・`anon`・`authenticated`・`service_role` から `REVOKE ALL` してから `service_role` に `EXECUTE` だけを付ける（先例 `20261022084844_order_status_links`。Database Advisor の lint 0028・0029 の解決策） |
| 5 | pg_cron のジョブ `auth-return-intents-cleanup` を毎日 03:20（UTC）に登録し、期限の 1 日後を過ぎた行を消す。cron スキーマへの自己付与は書かない |
| 6 | 末尾の確かめと `NOTIFY pgrst, 'reload schema'` |

触らないもの: 既存の移行ファイル、G の表・関数、書き手の許可一覧（`group_g_writer_allowlist()` は変えない。この 2 本は G の書き手ではない）、`private` スキーマの USAGE、cron の既存ジョブ。

### 末尾の確かめ

`-- AUTH_RETURN_INTENT_ASSERT_BEGIN` から `-- AUTH_RETURN_INTENT_ASSERT_END` の間の `DO $auth_return_intents_final$`。失敗は `AUTH_RETURN_INTENT_ASSERTION_FAILED`（SQLSTATE 55000）、DETAIL は項目名だけ。

| DETAIL の項目 | 確認する内容 |
| --- | --- |
| auth_return_intents_table | 表の存在・所有者 postgres・RLS 有効・列の並びが 8 列のとおり（平文の番号の列が無い）・`anon`/`authenticated`/`service_role` に表の権限が無い・PUBLIC への付与が無い |
| auth_return_intents_functions | 2 本の存在・所有者・DEFINER・STRICT（consume だけ）・言語と戻り値の型・`search_path=""`・`anon`/`authenticated`/PUBLIC の EXECUTE が無い・`service_role` の EXECUTE がある・同名の関数が public と private を合わせて 2 本だけ |
| auth_return_intents_cleanup_job | `cron.job` に `auth-return-intents-cleanup` があり、スケジュールが `20 3 * * *`、対象が `private.auth_return_intents` |

区間は何度流し直しても副作用が無い（読み取りだけ）。

### 試験（controller が `db reset` の後に流す）

- 移行の文面（DB なし）: `npx jest tests/unit/migrations/auth-return-intents.test.ts tests/unit/migrations/security-definer-search-path-guard.test.ts --runInBand`
- DB 結合: `npx jest tests/integration/db/auth_return_intents --runInBand`（手元の DB に `DATABASE_URL` を向けて流す）。権限・構造・作る・使い切る・期限切れ・用途違い・STRICT・CHECK・掃除・末尾の確かめの改変 16 通り・2 接続の同時の使い切りを確かめる。`LOCAL_SUPABASE_URL`・`LOCAL_SUPABASE_SERVICE_ROLE_KEY`・`LOCAL_SUPABASE_ANON_KEY` が揃えば、本物の PostgREST で service_role が呼べ、anon が呼べないことも確かめる。

### 適用の境界

- **本番の適用は G-3 の本番適用の後**（本番アプリは未公開なので待てる）。手元は `npm run db:reset` で G-3 の移行 4 本の後に自然に当たる。
- 適用の前に: アプリの `rpc` 呼び出し（Task 4 以降）は、この移行が本番に入る前に本番へ出さない。表と関数が無い間は戻り先の控えが作れず、`/`（管理者は `/admin`）へ送る作りなので、ログインは止まらない。
- 当て方: `supabase db push --linked`（`supabase migration list --linked` で本番に無いのが G-3 の残りとこの 1 本だけであることを確かめてから）。MCP の `apply_migration` で当てる場合は、当てた文を `schema_migrations` の `md5(statements[1])` でファイルと突き合わせ、`return_path` の CHECK の正規表現（`pg_get_constraintdef`）に `\\` が 2 個残っていることを確かめる。
- 適用後の読み取りの確かめ: 表の ACL（`has_table_privilege` が 3 役とも偽）、関数の ACL（`anon`/`authenticated` が偽、`service_role` が真）、`cron.job` の `auth-return-intents-cleanup`。本番で試験の行は作らない。

### ロールバック

アプリが `rpc` を呼ばなくなってから、新しい移行で次を流す（適用済みのファイルは書き換えない）。

```sql
BEGIN;
SELECT cron.unschedule('auth-return-intents-cleanup');
DROP FUNCTION IF EXISTS public.consume_auth_return_intent(text, text, uuid);
DROP FUNCTION IF EXISTS public.create_auth_return_intent(text, text, text);
DROP TABLE IF EXISTS private.auth_return_intents;
NOTIFY pgrst, 'reload schema';
COMMIT;
```

表の行は戻り先（内部の道筋）と番号のハッシュだけで、個人情報は持たない（`user_id` は使い切った利用者の id）。消しても失うのは未使用の戻り先だけ。

## 波 2 権限・検索・制約・置き場の移行 6 本（本番適用済み）

確認日: 2026-10-27。**6 本とも本番適用済み（2026-10-27。G-4 と一緒に `db push --linked`、オーナーの決定）。** 事後の確かめ（読むだけ・Supabase MCP）: `schema_migrations` の文を空白と `;` を除いて繋いだ md5 が、7 本（波 1-A を含む）ともコミットしたファイルと一致。`stockists.type` は NULL 可、`items` は原価 2 列だけ anon に読めず他の 21 列は読める、`item_cost_history` の方針は `admin.finance.read` の SELECT だけ（行は 0 件）、5 本の連番は anon・authenticated の権限なし（`stockists_id_seq` の service_role は USAGE・SELECT だけ）、対象の 11 表で anon・authenticated の書き込みは `profiles` の authenticated だけ（決めた 4 権限）、`search_public_*` は postgres・service_role だけ、`look_items` の読みの方針 2 本、CHECK 7 本が `NOT VALID`、`admin_update_look` は service_role だけ、置き場 2 つは非公開・5MiB・4 種類（既存ファイルの最大は 184449 バイト）。`get_advisors` の security に増えた WARN は無い。 手元は `npm run db:reset` で 6 本とも適用され、末尾の自己検査が通った。DB 結合試験は 144 suite 通過・13 skip・0 失敗（4339 件通過・14 skip・1 todo。`DATABASE_URL` を 54322 に向けて `--runInBand`）。要件は `docs/02_Requirements/areas/` の SEC-HOME・SEC-AUTH・SEC-LOOK・SEC-NEWS・SEC-SEARCH・SEC-STOCKIST・SEC-ADMIN、設計判断は ADR-0106・0107・0162〜0164・0315 など。窓口（`src/app/api/admin/stockists`・`news`・`looks/[id]`）の変更と同じ日に配備する。

| 順 | ファイル名 | 役割・状態 |
| --- | --- | --- |
| 1 | [20261026130100_stockists_type_optional.sql](../../supabase/migrations/20261026130100_stockists_type_optional.sql) | `stockists.type` の NOT NULL だけを外す（CHECK の `FLAGSHIP STORE`・`STORE`・`SELECT SHOP` は残す）。列が無ければ何もしない。本番適用済み（2026-10-27。G-4 と一緒に `db push --linked`。当てた文がファイルと一致・事後の確かめは下の表のとおり通過） |
| 2 | [20261026130200_sec_grants_hardening.sql](../../supabase/migrations/20261026130200_sec_grants_hardening.sql) | `items` の anon・authenticated の権限を 21 公開列の SELECT だけに（原価 2 列は service_role だけ）。`item_cost_history` の「Allow all」方針を外し `admin.finance.read` の SELECT 方針だけに。認証の 5 表と連番は anon・authenticated から全権限を外す。`profiles` は anon なし・authenticated は 4 権限。**5 の節（2026-10-27 追加）**: `legal_archive_runs`・`order_revisions`・`stripe_balance_transactions`・`stripe_payouts`・`stripe_refunds` の anon・authenticated から INSERT・UPDATE・DELETE・TRUNCATE・REFERENCES・TRIGGER・MAINTAIN を外し、所有する連番 `order_revisions_id_seq`（`pg_depend` で探す。1 本だけ）は PUBLIC・anon・authenticated から全権限を外す。SELECT は触らない。本番適用済み（2026-10-27。G-4 と一緒に `db push --linked`。当てた文がファイルと一致・事後の確かめは下の表のとおり通過） |
| 3 | [20261026130300_sec_grants_admin_tables.sql](../../supabase/migrations/20261026130300_sec_grants_admin_tables.sql) | `looks`・`look_items`・`news_articles`・`stockists` は anon・authenticated に SELECT だけ、`item_color_presets` は authenticated の SELECT だけ。`stockists_id_seq` は anon・authenticated・PUBLIC を外し、service_role は USAGE・SELECT だけ（UPDATE を外す）。**2026-10-27 追加**: `looks_id_seq`・`news_articles_id_seq`・`item_color_presets_id_seq`（identity の連番）を PUBLIC・anon・authenticated から全権限を外す。本番適用済み（2026-10-27。G-4 と一緒に。**窓口（Task 3）の配備の後**） |
| 4 | [20261026130400_sec_search_functions.sql](../../supabase/migrations/20261026130400_sec_search_functions.sql) | `search_items`・`search_looks`・`search_news` の件数を 1〜8 に丸め、検索語を先頭 100 字に、`\` を先に逃がす。`search_public_*` の 3 本は DROP せず PUBLIC・anon・authenticated の EXECUTE を外す。本番適用済み（2026-10-27。G-4 と一緒に `db push --linked`。当てた文がファイルと一致・事後の確かめは下の表のとおり通過） |
| 5 | [20261026130500_sec_rls_predicates_and_constraints.sql](../../supabase/migrations/20261026130500_sec_rls_predicates_and_constraints.sql) | `look_items` の読みの方針 2 本を作り直し（親の LOOK と商品の両方が公開）。`looks`・`news_articles` に CHECK 7 本を `NOT VALID` で足す。関数 `admin_update_look`（service_role だけ EXECUTE）を足す。本番適用済み（2026-10-27。G-4 と一緒に。**窓口（Task 7）と同じ日**） |
| 6 | [20261026130600_sec_storage_buckets.sql](../../supabase/migrations/20261026130600_sec_storage_buckets.sql) | 置き場 `look-images`・`news-images` を非公開・5MiB・JPEG/PNG/WebP/GIF に合わせる（`ON CONFLICT (id) DO UPDATE`）。`item-images` は触らない。本番適用済み（2026-10-27。G-4 と一緒に `db push --linked`。当てた文がファイルと一致・事後の確かめは下の表のとおり通過） |

6 本とも `BEGIN`/`COMMIT` が各 1 組、`NOTIFY pgrst, 'reload schema'` が 1 回、失敗は `SEC_WAVE2_MIGRATION_ASSERTION_FAILED`（55000）。時刻は G-4 の最後の移行（`20261026101624`）より後。適用しても `ALTER DEFAULT PRIVILEGES` は使わない。別セッションの `20261026010000_auth_return_intents.sql` は上の「波 1-A 戻り先の控えの移行」の節（本番未適用）のとおりで、この 6 本とは独立。

### 本番の事前の確認（読むだけ。適用の前に Supabase MCP で）

適用の前に `get_advisors`（security）を保存し、適用の後に比べる（`has_permission` の WARN が増えていないこと、`rls_enabled_no_policy`・`security_definer_view` などが増えていないこと。`item_cost_history` は方針が 1 件になるので INFO が 1 つ減る）。ロールバックの値は、この結果から確定する。

| 移行 | 読むだけの確認 |
| --- | --- |
| 130100 | `select is_nullable from information_schema.columns where table_schema='public' and table_name='stockists' and column_name='type'`（NO なら適用が必要、YES なら no-op） |
| 130200 | `has_table_privilege('anon','public.items','select')`、`has_column_privilege('anon','public.items','pattern_cost','select')`、`select count(*) from public.item_cost_history`（行があれば原価が公開されていた期間の記録として扱うか決める）、`pg_policies` の `item_cost_history`・認証の 5 表、5 表・連番・`profiles` の `has_table_privilege`。5 の節の 5 表は 2026-10-27 の読み取りで本番は anon・authenticated とも書き込み側の権限が無い（authenticated は `legal_archive_runs`・`order_revisions` に SELECT だけ、`stripe_*` 3 表は付与なし）ため**本番では変化なし**。**`order_revisions_id_seq` は本番で anon = authenticated = SELECT・UPDATE・USAGE のまま（`remote_schema.sql`）なので、これだけは本番の実変更** |
| 130300 | 5 表の `has_table_privilege('anon'/'authenticated', 'public.<表>', 'insert'/'update'/'delete'/'truncate')`、`item_color_presets` の anon の `select`、`pg_policies` の 5 表（`admin % manage by permission %` が insert・update・delete で残っているか。無いと自己検査で止まる）、`stockists_id_seq`・`looks_id_seq`・`news_articles_id_seq`・`item_color_presets_id_seq` の ACL（`pg_class.relacl`。`remote_schema.sql` では `stockists_id_seq` の service_role に SELECT・UPDATE・USAGE がある）。**窓口（Task 3）が配備された後に当てる** |
| 130400 | `has_function_privilege(r, 'public.' \|\| f \|\| '(text,integer)', 'execute') from unnest(array['anon','authenticated']) r, unnest(array['search_public_items','search_public_looks','search_public_news']) f`、`select proname, proacl from pg_proc where proname like 'search\_%' and pronamespace='public'::regnamespace`（前後で比べる）、本番の `search_items/looks/news` の本体が `remote_schema.sql:2139-2238` と同じか（`pg_get_functiondef`。違えば移行ヘッダーの旧い本体でなく本番の本体をロールバックに残す） |
| 130500 | 画像の道筋の先頭の階層と件数（`split_part(u,'/',1)`）、NULL・空文字・改行・`/object/public/` を含む要素、`char_length` の超過（`theme`>200、`theme_description`>4000、`title`>200、`content`>2000、`detailed_content`>10000）、CHECK の正規表現に合わない行の一覧。適用の前後に `has_function_privilege('anon'/'authenticated'/'service_role', 'public.admin_update_look(bigint,integer,text,text,text,text[],text,bigint[])','execute')` と `pg_policies`（`look_items`）。**窓口（Task 7）と同じ日に当てる**。`NOT VALID` でも UPDATE は検査されるので、旧い行は公開切り替えの PATCH も `23514` になりうる（VALIDATE の前に正規化する。VALIDATE はこの波に含めない） |
| 130600 | `select id, public, file_size_limit, allowed_mime_types from storage.buckets where id in ('look-images','news-images')`、`select policyname, qual, with_check from pg_policies where schemaname='storage' and tablename='objects'`（置き場を名指しする方針があれば移行が自己検査で止まる。意図した止まり方）、`select bucket_id, count(*), max((metadata->>'size')::bigint) from storage.objects where bucket_id in ('look-images','news-images') group by 1`（5242880 超の既存ファイルは残る）。結果をロールバックの値として保存する |

### 適用の順序

1. 窓口（取扱店・ニュースの service role 化 Task 3、LOOK の PUT を `admin_update_look` の rpc 1 回にする Task 7）を先に（または同じ日に）配備する。130300 を窓口より先に当てると取扱店・ニュースの管理の書き込みが 42501 で止まる。130500 だけ当てて窓口が古いままなら LOOK は変わらず動くが、窓口だけ出して 130500 が無いと LOOK の更新が `PGRST202` で全部 500。
2. 見本（`supabase/seed.sql`・`scripts/e2e/seed-storage.ts`）の画像の道筋は `items/e2e/`・`looks/e2e/`・`news/e2e/` の形（130500 の CHECK が旧い `e2e/…` を INSERT で断る）。
3. 6 本は時刻の順に当てる。当て方は `supabase db push --linked`（MCP の `apply_migration` で当てる場合は当てた文を `schema_migrations` の `md5(statements[1])` でファイルと突き合わせる）。

### ロールバック

各移行ファイルのヘッダーの `ROLLBACK` を使う（適用済みのファイルは書き換えず、新しい移行で流す）。

- 130100: `UPDATE public.stockists SET type = 'STORE' WHERE type IS NULL;` のあと `ALTER TABLE public.stockists ALTER COLUMN type SET NOT NULL;`。
- 130200: 方針と GRANT を戻す行がヘッダーにある。**5 の節の表の行は手元（新しい DB）の旧い状態を戻すもので、本番では流さない**（本番はもともと書き込み側の権限が無い）。連番 `order_revisions_id_seq` の行は本番の旧い状態。
- 130300: 5 表と 4 本の連番の GRANT を戻す行がヘッダーにある（`stockists_id_seq` の service_role の UPDATE も）。
- 130400: 旧い本体 3 本の全文がヘッダーにある（`remote_schema.sql` の 2139-2238 行）。`search_public_*` は `GRANT EXECUTE … TO PUBLIC, anon, authenticated`。
- 130500: 旧い方針 2 本の全文・`DROP CONSTRAINT IF EXISTS` 7 本・`DROP FUNCTION`。関数を消すなら LOOK の PUT の窓口も同じリリースで戻す。
- 130600: 適用の前に控えた値へ `UPDATE storage.buckets` で戻す（手元の見本の状態へなら `file_size_limit`・`allowed_mime_types` を NULL。`public` は偽のまま）。

### 以後の移行は GRANT を明示する

公開スキーマの表・列・関数・連番の権限は移行が明示する。新しい物を作る移行は、anon・authenticated・service_role への GRANT・REVOKE を必ず書く（`ALTER DEFAULT PRIVILEGES` はプロジェクト全体に効くので使わない。設計書 Q9 の別の判断）。Supabase 公式は既定の権限がプロジェクトごとに違い、自動で付く権限は外される方向だと案内している（Hardening the Data API）。

- 新しい表の雛形: `REVOKE ALL ON TABLE public.<表> FROM PUBLIC, anon, authenticated;` → 要る役に要る物だけ `GRANT … TO …;` → `GRANT ALL ON TABLE public.<表> TO service_role;`
- 連番: `GRANT USAGE, SELECT ON SEQUENCE … TO service_role;`（identity の連番は INSERT で権限を確かめないので、anon・authenticated の直の `nextval()` を断つ REVOKE も書く）
- 関数: `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated;` のあと呼ぶ役に `GRANT EXECUTE`
- 権限の一覧は `tests/integration/db/auth_grants_inventory.integration.test.ts`（DATA-AUTH-006）で守る。権限を替える移行を足したら、同じ変更で一覧も直す

## 波 5 アプリの session への結び付けの移行 M1（本番適用済み）

確認日: 2026-10-29。**本番適用済み（2026-10-29。controller が `npx supabase db push --linked`、先の dry-run は本ファイルだけを示した）。** オーナーの決定: 手元の開発が本番の DB を使うので、新しいコードより先に当てる。ファイルは [20261029120000_sec_app_session_binding.sql](../../supabase/migrations/20261029120000_sec_app_session_binding.sql)（計画 `docs/superpowers/plans/2026-10-29-wave5-session-binding-aal2-db.md` の Task 1/1B、ADR-0417、DATA-AUTH-007）。

足すもの（挙動は変えない。`has_permission` と既存の方針は触らない）:

| 物 | 内容 |
| --- | --- |
| 列 `public.sessions.auth_session_id` | `uuid` NULL 可。既存の行は NULL のまま（アプリが結んでいない行の意味） |
| 索引 `sessions_auth_session_id_live_idx` | 部分（`revoked_at IS NULL AND auth_session_id IS NOT NULL`）・一意でない（新しい行を先に入れて古い行を後で失効させるので、一瞬 2 行が同じ id を持つ） |
| `private.app_session_is_live(uuid)` | EXECUTE は postgres だけ |
| `public.is_app_session_active(uuid)` | EXECUTE は postgres と service_role |
| `private.is_app_bound_live_session()` | EXECUTE は postgres・authenticated・service_role（RLS 用。JWT の `session_id` が不正でも false で落ちない） |

関数 3 本とも SECURITY DEFINER・`search_path ''`・所有者 postgres。末尾の自己検査（失敗は `SEC_WAVE5_MIGRATION_ASSERTION_FAILED`、55000）が列・索引・関数の属性と ACL・PUBLIC 非公開・`sessions` の anon/authenticated 権限なしを確かめ、失敗すれば全体が戻る。ロールバックは移行ファイルのヘッダーの `ROLLBACK`（関数 3 本・索引・列を DROP。M2 を当てていれば先に M2 を戻す）。

M2（`has_permission` と `profiles`・`orders`・`order_items` の RESTRICTIVE 方針）は M1 の後に、2026-10-29 に本番へ適用済み。アプリの書き手（Task 2）はログインのたびに `auth_session_id` を入れるので、M1 は新しいコードより先に当てた。

事後の確かめ（読むだけ・Supabase MCP）:

- 最新の版が `20261029120000`。
- `schema_migrations` の文を空白と `;` を除いて繋いだ md5 がファイルと一致（`d321d34f408b1e8fcc1c4a8b3917cdad`）。
- `sessions` は 16 列。行は 48 件で、結んだ行は 0 件。
- 関数 3 本の ACL は上の表のとおり。索引あり。
- `has_permission` の定義は変わらず。
- `get_advisors`（security）に新しい項目なし。

手元は `npm run db:reset` のあと `tests/integration/db` 全体で 145 suite 通過・13 skip・4355 件通過・0 失敗。Task 0 の実測（`.superpowers/sdd/2026-10-25-security-gap-fixes/wave5-task0-report.md`）で、GoTrue の `session_id` は refresh しても変わらない。

## 波 5 `has_permission` の aal2 と会員の表の方針の移行 M2（本番適用済み）

確認日: 2026-10-29。**状態: 2026-10-29 に本番適用済み（単独。適用後の確認は下の「本番の事後の確認」）。** ファイルは [20261029120100_sec_has_permission_aal2_member_rls.sql](../../supabase/migrations/20261029120100_sec_has_permission_aal2_member_rls.sql)（計画 Task 6・10、ADR-0418、DATA-AUTH-008）。手元では `supabase/migrations/` に置いて `db reset` で当てる（`supabase/pending-wave5/` に同じ内容の写しがある場合、適用済みなので消してよい）。**M1 と違い、こちらが効く。** 当てた瞬間から、結び付いていない既存の session は会員の表を 0 行しか読めず、`has_permission` は aal2 と結び付いた生きた session でなければ false になる。本番に当たった今、**結び付いた生きた session を持たない利用者の JWT は、`has_permission` が false になり、会員の表（`profiles`・`orders`・`order_items`）の読みも断られる。** 本番の利用者は 8 人（全員試し用。本番のアプリは未配備）で、アプリでログインし直す必要がある。手元の開発は本番の DB を使うので、手元でもログインし直す。

変えるもの:

| 物 | 内容 |
| --- | --- |
| `public.has_permission(text)` | `CREATE OR REPLACE`。順序は uid が空なら false → `claims.aal` が `aal2` でなければ false（無ければ aal1 扱い）→ ACL（G-0 の `SELECT EXISTS` を一字一句そのまま）→ ACL が真の時だけ `private.app_session_is_live(claims.session_id)`（形の検査の後で uuid にする。形が悪ければ例外でなく false）。所有者・EXECUTE（authenticated・service_role・postgres、anon は不可）は `CREATE OR REPLACE` で保たれるので GRANT・REVOKE は書かない。`SET search_path = ''` は書き直す |
| 方針 `require app bound live session`（`public.profiles`） | `AS RESTRICTIVE FOR ALL TO authenticated`・USING と WITH CHECK とも `(SELECT private.is_app_bound_live_session())`。先に `DROP POLICY IF EXISTS` |
| 同（`public.orders`） | 同上。ゲストの注文の `app.session_id` の道（anon）は変えない |
| 同（`public.order_items`） | 同上 |

`has_permission` を呼ぶ方針は約 100 本あり、本体の置き換えだけで全部に効く。`(status = 'published' OR has_permission(...))` の形の公開の読みは RESTRICTIVE にせず、OR の側が合わなくなるだけなので、一般の会員は公開済みを読み続ける。`private.group_g_actor_has_permissions(_actor_id, …)` は `auth.uid()`・`has_permission` に依らないので、G-2／G-3／G-4 の書き手は変わらない。`carts`・`wishlists`・`checkout_drafts`・`contact_*`・`refresh_token_history`・`postal_code_cache` は既に全拒否で、`user_roles` は `has_permission('admin.users.read')` を通る。**G-4／H が会員の行を返す新しい表を足したら、同じ RESTRICTIVE の方針を足す。**

先頭と末尾の自己検査（失敗は `SEC_WAVE5_MIGRATION_ASSERTION_FAILED`、55000。全体が戻る）: 先頭で M1 の存在（`private.app_session_is_live`・`private.is_app_bound_live_session`・`sessions.auth_session_id`）を確かめ、無ければ何も変えずに止まる。末尾で本体の語と検査の順・所有者／DEFINER／STABLE／`search_path`・EXECUTE（authenticated 可、anon 不可、service_role 可）・3 表に RESTRICTIVE／authenticated／`*` の方針が各 1 本であることを確かめる。

### 本番の事前の確認（読むだけ・Supabase MCP。結果をロールバックの基準として残す）

```sql
select md5(pg_get_functiondef('public.has_permission(text)'::regprocedure));
-- 20261023175712 の本体であること（G-0 のとき 418b949c1ec79dfa89ea6454bf81f66a）。M1 は本体を変えない
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check from pg_policies
  where schemaname = 'public' and tablename in ('profiles', 'orders', 'order_items') order by 2, 3;
select tablename, policyname from pg_policies where schemaname = 'public'
  and (qual like '%auth.uid()%' or with_check like '%auth.uid()%' or qual like '%auth.jwt()%') order by 1, 2;
-- profiles（4）・orders（1）・order_items（1）だけであること。増えていれば同じ方針を足してから当てる
select count(*) filter (where revoked_at is null and auth_session_id is not null) as bound_live from public.sessions;
select version from supabase_migrations.schema_migrations order by version desc limit 3;
-- M1（20261029120000）が入っていて、最後が G-1 の最新であること
```

あわせて、適用前の `get_advisors`（security・performance）を保存する。

### 適用の順序（順序が命）

1. M1 が本番に当たっていること（2026-10-29 に済み）。
2. アプリの書く側（ログイン・refresh・MFA 昇格が `auth_session_id` を持つ行を作る・引き継ぐ）と読む側（`is_app_session_active` を呼ぶ）が配備されていること。旗 `AUTH_REQUIRE_APP_SESSION` は設定しない（既定で有効）。段階が要る時は先に `off` で配備し、`select count(*) from public.sessions where auth_session_id is not null and revoked_at is null` で行ができたのを確かめてから外す。
3. **全員がログインし直す**（開発者・試し用の 4 人・管理者。管理者は TOTP の再登録は不要で、メール OTP → TOTP の通常の流れ）。本番は `auth.users` 8 人・失効していない自前の session 3 本。
4. **M2 を当てる（2026-10-29 に済み）。** オーナーの決定で、G-1 の次の適用より前に M2 だけを単独で当てた（`npx supabase db push --linked`。直前の dry-run は M2 の 1 本だけを示した）。当てる前の確認は次のとおり。`ls supabase/migrations | tail -3` で最後の時刻を見て、M2 の時刻が M1 と全部の既存の移行より後であることを確かめる（G-4／H／G-1 が後から足していれば付け直す。`db push` は古い時刻を断る。付け直したらファイル名・ヘッダー・試験の参照・ADR・文書を一貫させる）。
5. 事後（読むだけ）: 当てた文を `schema_migrations` の `md5(statements[1])` でファイルと突き合わせる（空白と `;` を除いて繋いだ md5。M1 の節と同じやり方）、`has_permission` の定義に `aal2` と `app_session_is_live` がある、`pg_policies` に方針 3 本、`get_advisors`（security）に増えた WARN が無い、未ログインの anon とパスワードだけの通行証の `profiles` が 0 行。

### 本番の事後の確認（2026-10-29 に実測済み・読むだけ・Supabase MCP）

- 最新の版が `20261029120100`。
- `schema_migrations` の `md5(statements[1])`（空白と `;` を除いて繋いだもの）がファイルと一致（`e99566627ad4f56a6cc6da961d2a687e`）。
- `public.has_permission` の定義に `aal2` の検査と、アプリに結び付いた生きた session の検査（`private.app_session_is_live`）がある。ACL は変わらず（postgres・authenticated・service_role）。これを使う方針は 83 本。適用前の定義の md5 は `418b949c1ec79dfa89ea6454bf81f66a`（`aal2` の検査なし）。
- RESTRICTIVE の方針 `require app bound live session`（cmd ALL、ロール authenticated、`(SELECT private.is_app_bound_live_session())`）が `profiles`・`orders`・`order_items` にある。
- `get_advisors`（security）に新しい項目なし。
- 適用前の本番: 結び付いた生きた session は 0 本。したがって適用の瞬間から、全利用者はアプリでログインし直すまで `has_permission` が false で、会員の表も読めない。

### ロールバック

M2 のファイルのヘッダーの `ROLLBACK`（方針 3 本の `DROP POLICY IF EXISTS` と、`has_permission` を G-0 の本体に戻す `CREATE OR REPLACE`。本体は単体で G-0 と突き合わせ済み）。M1 まで戻すなら M2 → M1 の順（M1 のヘッダーの ROLLBACK は関数 3 本・索引・列を DROP する）。**旗 `AUTH_REQUIRE_APP_SESSION` では DB は戻らない**（DB は環境変数を読めない）。アプリの側は旗を `off` にする。

### 手元の確かめ（2026-10-29 に実測済み。本番へは同日に単独で適用済み）

M1・M2 を `supabase/migrations` に置いて `npm run db:reset` が通り（末尾の自己検査が出ない）、`tests/integration/db` は 146 suites・4377 件通過・0 失敗（13 suites・14 件 skipped、1 todo）。reset せずに流した 1 回目は G の g3／g4 が赤だったが、前の実行の残りのデータが原因で、reset し直すと緑になった（DB 結合は毎回 `db reset` の後で流す）。`news_articles_rls` には「aal1・結び付いていない・失効した読み手は公開済みの行しか見えない」の否定を足した。`group_g*` は一字も変えずに通った。本番ビルドの E2E 全件は 203 failed・4821 passed・26 skipped（波 4 の 185 failed との差は、1 並列の再実行と波 5 に未対応だった試験の直しで説明がついた）。M2 はこの後、同日に本番へ単独で適用した（上の「本番の事後の確認」）。内訳は [test-spec](../05_Quality/tests/test-spec.md) の波 5 の節。

### 本番の前の確認（コードでは確かめられない）

- 本物の TOTP の `mfa.verify` の前後で `session_id` が変わらないこと（配備前の preview で管理者 1 人が TOTP を通して実測する。ローカルは TOTP が無効で、Task 0 は補助の amr で代用した）。
- Google ログイン（`oauth/callback`）の session が結び付くこと。
- 本番の GoTrue の `auth.sessions` の `not_after`（time-box）の設定。短いと再ログインが増える。
- `auth.sessions` の主キー引きの性能。aal1 は表を引かずに false、aal2 の管理者だけが 2 回の主キー引き。`get_advisors`（performance）と管理画面の一覧（注文・会計）の応答時間を適用の前後で比べる。重ければ Custom Access Token Hook を上乗せする。
- 会員の 2 段（パスワード＋メールの OTP）は NIST SP 800-63B の AAL2 ではなくアプリ独自の方針（メールは out-of-band に使えない）。AAL2 にあたるのは管理者の TOTP。パスワードとメールの受信箱の両方を盗まれた場合は破れる。

## 波 6 パスワード変更の確認コードの移行 M3（手元・本番とも適用済み）

確認日: 2026-11-01。**状態: 手元は 2026-11-01 の `npm run db:reset` で適用済み。本番も 2026-11-01 21:06 頃 JST に適用済み（波 6 の Task 11。G-1 に知らせ、`npx supabase db push --linked --dry-run` で送るのがこの1本だけと確かめてから `npx supabase db push --linked`。開店までの順番の中の本番 DB 適用の許可による）。** 事後の確かめ: 本番の `schema_migrations` の `20261101120000` は 20 文で `md5(array_to_string(statements, E'\n'))` が `721c73726b8723cd8c4c087585eeb318`、手元の db reset で当てた物と同じ。表は RLS が有効で方針 3 本（anon・authenticated は拒否、service_role だけ）、表の権限は service_role だけ。2 つの関数は SECURITY DEFINER・`search_path=""`・EXECUTE は service_role だけ（anon・authenticated は偽）。security advisors は当てる前後で同じ（INFO 18・WARN 2〔`has_permission`・漏洩パスワードの確認が無効〕）。ファイルは [20261101120000_sec_password_change_challenges.sql](../../supabase/migrations/20261101120000_sec_password_change_challenges.sql)（14,366 bytes・LF・BOMなし・MD5 `92d7d33f84d56bc44e59be4568cc0314`。計画 `docs/superpowers/plans/2026-11-01-wave6-captcha-password-change-config.md` の Task 4、ADR-0421、DATA-AUTH-009・010）。既存の挙動は変えない（表 1 つ・関数 2 つを足すだけ）。

足すもの:

| 物 | 内容 |
| --- | --- |
| 表 `public.password_change_challenges` | 8 列（`id`・`user_id`〔`auth.users` への外部キー、`ON DELETE CASCADE`〕・`auth_session_id`・`code_hash`〔鍵つきハッシュの hex 64 桁。平文のコードは置かない〕・`attempts`・`expires_at`・`used_at`・`created_at`）。部分索引 `password_change_challenges_open_idx`（`user_id`、`used_at IS NULL`）。RLS 有効、方針 3 本（anon・authenticated は全拒否、service_role は全許可。`password_reset_tokens` と同じ形）。`REVOKE ALL FROM PUBLIC, anon, authenticated`、`GRANT SELECT, INSERT, UPDATE, DELETE TO service_role` |
| `public.issue_password_change_challenge(uuid, uuid, text, integer)` | 利用者・認証 session・ハッシュ・TTL（60〜900 秒）。引数が空・TTL が範囲外・ハッシュが hex 64 桁でない時は 22023。取引内の助言ロックで利用者ごとに直列化し、未使用の行を全部 `used_at = now()` にして、1 日より古い行を消し、新しい行を入れて id を返す |
| `public.consume_password_change_challenge(uuid, uuid, text)` | 利用者・認証 session・ハッシュ。未使用・期限内の最新の行を `FOR UPDATE` で取り、`none`（行なし・別 session）／`locked`（`attempts` が 5 以上。正しいコードでも拒否）／`ok`（`used_at` を立てる）／`invalid`（`attempts` + 1）を返す。行ロックなので並列の推測でも `attempts` は 5 を超えない |

関数 2 本とも SECURITY DEFINER・`search_path ''`・所有者 postgres・PUBLIC／anon／authenticated から REVOKE・EXECUTE は service_role だけ。末尾の自己検査（失敗は `SEC_WAVE6_MIGRATION_ASSERTION_FAILED`、55000。全体が戻る）が列・索引・RLS・方針・権限・関数の属性と ACL を確かめる。最後に `NOTIFY pgrst, 'reload schema'` を 1 回。表は冪等にしない（想定外の既存の表があれば移行を落とす）。

### 当てる順序

1. 本番の事前の読み取り（読むだけ）: `select max(version) from supabase_migrations.schema_migrations`（`20261029130600` かそれ以降）、`select to_regclass('public.password_change_challenges')` が null、2 関数が無いこと。
2. G-1（別セッション）に知らせる。`npx supabase db push --linked --dry-run` が M3 の 1 本だけを示すことを確かめる。
3. **窓口（`POST /api/auth/password/change/start`・`confirm`）と画面（`/account/password`）を本番で動かす前に当てる。** 窓口より先に当てても安全（呼ぶ物が無い）。M3 が無い DB で `start` を叩くと関数が無く 500（`issue_failed`）になる。
4. 事後（読むだけ）: 当てた文を `schema_migrations` の `md5(statements[1])` でファイルと突き合わせる（空白と `;` を除いて比べる）。表・索引・関数 2 本・ACL が上の表のとおり、anon・authenticated から表も関数も呼べないこと、`get_advisors`（security）に新しい項目が無いこと。

### 失敗したとき・戻すとき

末尾の自己検査が落ちれば取引ごと戻り、台帳にも残らない。当てた後に戻すなら、窓口と画面を止めてから、ファイルのヘッダーの `ROLLBACK`（関数 2 本と表を `DROP`。`consume`→`issue`→表の順）を流す。コードの表は一時的な物（10 分で期限切れ）で、戻して失うのは未使用のコードだけ。

### 手元の確かめ（2026-11-01 に実測済み）

`npm run db:reset` が通り（末尾の自己検査が出ない）、`tests/integration/db` を含む DB 結合の全体は 161 suites 通過・13 skipped・4715 件通過・0 失敗。M3 の専用の結合試験は `tests/integration/db/auth_password_change_challenges.integration.test.ts`、権限の棚卸しは `auth_grants_inventory.integration.test.ts`（表 1・関数 2 の行を足した）。

## ベースライン化（初回のみ・要 Docker と DB パスワード）

> **実施済み（2026-09-01）。** 以下は記録。再実行は不要。
>
> - `migration repair --status reverted` で旧 105 件を台帳から落とし、
>   `db pull` で `supabase/migrations/20260901102912_remote_schema.sql`（4233 行）を生成。
>   同バージョンは台帳へ `applied` として記録済み。
> - 実施後の確認: `migration list` がローカル / リモートとも `20260901102912` の 1 件のみ。
>   `db push --dry-run` は `Remote database is up to date`。
> - 本番スキーマは無変更（テーブル 51 / 関数 40 / RLS ポリシー 139 / 拡張 7 が前後で一致）。
>   `revoke_auth_session` の EXECUTE は `postgres, service_role` のまま。
> - 生成物の検査結果: トップレベルの `DROP` は無し（公式が警告する
>   `DROP EXTENSION pg_net;` も出なかった）。`http` 拡張の復活も無し。
>   092 のロックダウン（anon / authenticated へ EXECUTE を出さない）は保存されている。
>   機密値の混入も無し。

2026-09-01 時点の実測:

- 本番の台帳 `supabase_migrations.schema_migrations`: **105 行**
  （最新は `auth_user_lookup_and_token_hygiene` = 093、`092_lock_down_rpc_surface`、
  `091_auth_session_revocation`。いずれも MCP の apply_migration 経由で適用され、
  台帳にも記録されている）
- ローカルの `supabase/migrations/`: **0 件**

CLI はこの2つを突き合わせて「台帳に無いファイル」だけを適用する。
リモート 105 / ローカル 0 は完全な不整合なので、`db push` は sync エラーになり
`supabase migration repair` を促される。

本番の現状（テーブル 51 / 関数 40 / RLS ポリシー 139）をそのまま
`supabase/migrations/` の最初の 1 本に固定して、この食い違いを解消する。

```bash
npx supabase login                                  # ブラウザでアクセストークンを発行
npx supabase link --project-ref pjidrgofvaglnuuznnyj  # DB パスワードを聞かれる
npx supabase migration list                         # 適用前にローカルとリモートの差を確認
npx supabase db pull                                # supabase/migrations/<timestamp>_remote_schema.sql が出る
```

`db pull` は生成したファイルを台帳へ「適用済み」として記録するので、
後続の `db push` が再適用することはない。出力には 092・093 の内容も含まれる。

**コミット前に生成されたファイルを読むこと。** `db pull` は本番とローカルスタックの
既定構成を差分するため、意図しない文が混ざることがある（公式が挙げている例:
ローカルスタックが既定で有効化している拡張に対する `DROP EXTENSION pg_net;`）。
これらは `db reset` 時に黙って適用され、ローカルのスキーマを変えてしまう。

```bash
git add supabase/migrations && git commit -m "chore(db): baseline production schema"
```

旧 `migrations/*.sql` は履歴として残し、以後の追加はしない。

台帳と実体がずれたときは repair で台帳側だけを直す（SQL は実行されない）。

```bash
npx supabase migration repair --status applied <version>   # 実体はあるが台帳に無い
npx supabase migration repair --status reverted <version>  # 台帳にあるが実体が無い
```

## 以後の追加手順

```bash
npx supabase migration new <name>      # supabase/migrations/<timestamp>_<name>.sql
# SQL を書く（規約は下記）
git commit && git push                 # master への push で CI が db push する
```

PR を作ると CI が `supabase db push --dry-run` で「何が当たるか」だけを出す。
master への push で実際に適用される。

### 本番に当てる前の試行（取り消し前提）

データに依存するマイグレーション（既存行の後埋め、列の型変更、トリガーの一時無効化など）は、
本番のデータで通るかを先に試す。全体を1つの `DO` ブロックに入れ、各ファイルの SQL を
`EXECUTE` で流し（トップレベルの `BEGIN;` / `COMMIT;` は外す）、確かめたい値を集めてから
最後に `RAISE EXCEPTION` で全体を取り消す。例外の文言に結果を載せれば、何も残さずに結果だけを得られる。

```sql
do $dryrun$
declare r text;
begin
  execute $m0$ /* 1本目の SQL */ $m0$;
  execute $m1$ /* 2本目の SQL */ $m1$;
  select format('rows=%s', (select count(*) from public.some_table)) into r;
  raise exception 'DRYRUN (rolled back): %', r;
end
$dryrun$;
```

実行後に、作られるはずのオブジェクトが無いこと（取り消されたこと）を確かめる。
2026-09-19 のバリアント在庫6本は、この試行で結果（生成件数・検算0行・既存明細の紐付け）を確かめてから当てた。

#### RLS を変えるときは、立場ごとの件数を前後で比べる

同じ `DO` ブロックの中で「変更前に数える → `EXECUTE` で当てる → 変更後に数える」を行い、件数が一致することを確かめる。
立場は `SET LOCAL ROLE` と JWT のクレーム、セッション ID で切り替える（`auth.uid()` と `current_app_role()` はクレームから読む）。

```sql
execute 'set local role authenticated';
perform set_config('request.jwt.claims',
  json_build_object('sub', '<user_id>', 'role', 'authenticated',
                    'app_metadata', json_build_object('role', 'user'))::text, true);
perform set_config('app.session_id', '<session_id>', true);
execute 'select count(*) from public.orders' into n;
execute 'reset role';
```

- 匿名・一般会員・サポーター・管理者に加え、セッションで見える行（ゲストのカート・注文）も数える。ACL で管理者権限を持つ会員を「一般会員」に使うと、権限の経路しか試せない
- 書き込みの条件は、行を変えない `UPDATE ... SET col = col` の件数で比べる。トリガーの無い表に限る
- 流した SQL がファイルと同じであることは、本文の `md5()` をローカルで計算した値と比べて確かめる
- 索引の使用回数（`pg_stat_user_indexes`）は取り消されない。試行の検索で使われた索引は、advisor の unused_index から外れる

2026-09-19 の FREQ-382（RLS 15本の書き換えと会計3表の分割）は、9つの立場×8表で件数が前後一致することを確かめてから当てた。

### MCP の apply_migration で当てた場合

MCP の `apply_migration` は、**当てた時刻**を version として台帳に書く。ファイル名の番号とは一致しない。
当てた直後に `list_migrations` で記録された version を確かめ、ファイル名をその version に直す。

```text
supabase/migrations/<作ったときの番号>_<name>.sql  →  <台帳に記録された version>_<name>.sql
```

直さないと、次の `db push` が「台帳にある version がローカルに無い」で止まる。

### まだ本番に入れないマイグレーション

`supabase/migrations/` に置いたものは、master への push で本番に流れる。
公開時まで入れないものは `supabase/pending/` に置く（[supabase/pending/README.md](../../supabase/pending/README.md)）。
入れるときは新しい version を付けて `supabase/migrations/` へ移す。元の古い日付のまま戻さないこと。

### 新しい移行を前提にするコードは、当てるまで本番の DB につながない

新しいコードが新しい移行（列・表・関数の追加）を前提にする時は、push の後、移行を本番に当てるまで、普段の開発（`npm run dev`。DB は本番のまま）で新しいコードを本番の DB につながない。
移行の無い DB を読んで、画面と窓口が動かない。
例: グループ E-2 は移行 A〜C が無いと、注文の一覧・全部の種類のメールの材料・返金が動かない。
当てるまでの確かめは、手元の Supabase（`npm run db:start`・`npm run db:reset`）で行う。

### `--include-all` を使わない

本番の最新より古い日付の未適用ファイルがあると、`db push` は
`Found local migration files to be inserted before the last migration on remote database.` で止まる。
`--include-all` はこの確認を外すだけで、適用順が崩れる。止まったら、ファイル名と台帳のずれを直す。

## 書き方の規約

**オブジェクトの種別で冪等性の扱いを分ける。**
「全部を冪等にする」は一見安全だが、テーブルに対しては逆効果になる。

### 冪等にする — 関数 / ビュー / RLS ポリシー / GRANT

再実行しても同じ結果になる形で書く。ファイルが唯一の正になる。
Flyway の repeatable migration（`R__`）と同じ考え方。

```sql
CREATE OR REPLACE FUNCTION public.foo(...) ... ;

DROP POLICY IF EXISTS "name" ON public.bar;
CREATE POLICY "name" ON public.bar ...;

REVOKE ALL ON FUNCTION public.foo(...) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.foo(...) TO service_role;
```

### 冪等にしない — テーブル / 列 / データ移行

`CREATE TABLE IF NOT EXISTS` は「既にあるが形が違う」を**黙って見逃す**。
ドリフトを隠すので、事故に気づくのが遅れる。台帳が「一度だけ実行」を保証するので
冪等性は要らない。**想定外の状態では黙って飛ばさず、落ちること。**

```sql
-- 良い: 想定と違えば落ちる
ALTER TABLE public.sessions ADD COLUMN auth_session_id uuid;

-- 避ける: 既存の列の型が違っても素通りする
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS auth_session_id uuid;
```

### 必ずトランザクションで包む

```sql
BEGIN;
-- ...
COMMIT;
```

`CREATE FUNCTION` → `REVOKE` の順で書く箇所は、包まないと権限の窓ができる。
`CREATE INDEX CONCURRENTLY` などトランザクション内で実行できない文だけは
別ファイルに分け、その旨をコメントに書くこと。

### SECURITY DEFINER 関数は search_path の最後に `pg_temp` を書く

`CREATE OR REPLACE FUNCTION` は関数の設定（`pg_proc.proconfig`）を丸ごと置き換える。
本番で実測した結果（巻き戻し済み）:

| 書き方 | 適用後の `proconfig` |
| --- | --- |
| `SET search_path = public, pg_temp` | `search_path=public, pg_temp` |
| `SET search_path TO 'public'` | `search_path=public`（`pg_temp` が消える） |
| `SET` 句なし | `NULL`（設定ごと消える） |

`20260921011535_harden_security_definer_search_path.sql` は `ALTER FUNCTION ... SET` で
既存 20 本に `pg_temp` を足している。**ALTER は関数定義の中に残らない**ため、それより前の
マイグレーションを雛形にして貼り直すと、対策が静かに巻き戻る。

- 新しい SECURITY DEFINER 関数は `SET search_path = <スキーマ>, pg_temp` と書く
- 既存の関数を `CREATE OR REPLACE` で差し替えるときは、雛形にした版が古くても `pg_temp` を足す
- 雛形にするなら、その関数を最後に定義しているファイルを選ぶ（`ls supabase/migrations | grep <関数名>` で探せない場合は `grep -l`）
- 適用済みのファイルは書き換えない（台帳と md5 がずれる）。直すときは新しいマイグレーションを足す

`tests/unit/migrations/security-definer-search-path-guard.test.ts` が、上記の ALTER より後の
ファイルについてこれを機械的に確認する。DB 側の実際の状態は
`tests/integration/db/security_definer_search_path.integration.test.ts` が見る。

## 必要な GitHub Secrets

| 名前 | 取得元 |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Supabase ダッシュボード > Account > Access Tokens |
| `SUPABASE_DB_PASSWORD` | プロジェクト > Settings > Database > Database password |
| `SUPABASE_PROJECT_ID` | `pjidrgofvaglnuuznnyj` |

## ローカル開発について

`npx supabase db reset` はローカル Docker のスタックを対象にする。本番には触れない。
ベースラインが入ったので、`db reset` は本番相当のスキーマを再現できる。
`db reset` は移行の後に [`supabase/seed.sql`](../../supabase/seed.sql)（架空の見本データ）を入れる。画像の中身は E2E の前に `scripts/e2e/seed-storage.ts` が置く。
E2E は手元の Supabase に対して流す（`playwright.config.ts` の見張り `scripts/e2e/environment.ts` が本番の住所を拒む）。[`scripts/hooks/pre-push`](../../scripts/hooks/pre-push) も E2E の前に `npx supabase db reset` で手元の DB を作り直す。

## 付録: 台帳の旧 105 件をどうするか

ベースラインを作る前は、こうなっていた。

- 台帳: 105 行
- ローカルのファイル: 0 件

この状態では `db pull` 自体が先に止まる（`The remote database's migration history
does not match local files in supabase/migrations directory.`）。
`db push` も同様に「台帳にあるがローカルに無いバージョン」で停止する。

旧 105 件の内容はベースラインに吸収されるので、台帳から落として 1 対 1 に揃える。

`migration repair` は**台帳だけを書き換える。SQL は実行しないし、スキーマは変わらない。**

**2026-09-01 に実施済み。** 実際に `db pull` がこのエラーで停止したため、
次のコマンドを 1 行で実行して解消した（CLI は 1 件ずつの実行を提案してくるが、
バージョンを並べれば 1 回で済む）。以下は記録用。

```bash
npx supabase migration repair --status reverted 20260221083223 20260221084906 20260221091645 20260221100658 20260221103324 20260221103333 20260221103453 20260221103758 20260221103805 20260221103848 20260221104024 20260221104036 20260221104044 20260221104137 20260221104221 20260221104235 20260221104302 20260221104344 20260221104407 20260221104410 20260221104415 20260221104419 20260221104423 20260221104428 20260221104433 20260221104437 20260221104441 20260221104454 20260221104458 20260221104504 20260222101348 20260222101501 20260222101642 20260222103644 20260222115552 20260222120847 20260223012929 20260223012936 20260223091236 20260309135458 20260313124449 20260330160643 20260404024730 20260404024947 20260404031308 20260412055512 20260418055307 20260419012931 20260419014223 20260419015007 20260419015138 20260419071338 20260419081341 20260421120514 20260423105818 20260426004430 20260426004558 20260426031046 20260426031226 20260426073120 20260426073316 20260426080244 20260426080605 20260426115752 20260426122154 20260619224233 20260701131932 20260701132205 20260701132220 20260705034750 20260705041303 20260720084636 20260720084711 20260725080853 20260725103539 20260725130756 20260725135133 20260726063437 20260726090505 20260726113851 20260726123039 20260726130334 20260801033014 20260801090848 20260801132041 20260801153101 20260801153307 20260801153729 20260809120849 20260810062052 20260810071751 20260811132742 20260811132755 20260812105842 20260812121910 20260812230300 20260812230331 20260814000138 20260814015227 20260816022459 20260816025424 20260824104133 20260829110448 20260830005833 20260830225148
```

（2026-09-01 時点の台帳の全 105 件。最古 20260221083223、最新 20260830225148 = 093）

実行後に確認する。

```bash
npx supabase migration list      # ローカルとリモートが一致していること
npx supabase db push --dry-run   # 「適用対象なし」になること
```

適用履歴そのものは `migrations/*.sql` と git のコミット履歴に残るので、
台帳から落としても追跡性は失われない。

## 付録: 台帳とファイル名のずれを揃えた記録（2026-09-19）

レビュー指摘⑪。FREQ-380。

| ずれ | 原因 | 対処 |
|---|---|---|
| 本番は `20260911235714` / `20260913005807` / `20260913005917`、ファイルは `20260912000000` / `20260912010000` / `20260912015000` | MCP の `apply_migration` で当てた後、ファイル名を記録された version に直していなかった。SQL の中身は同一（コメント・`BEGIN`/`COMMIT`・空白を除いて一致） | ファイル名を本番の version に直した。本番は変更していない |
| バリアント在庫の6本（`20260906090000`〜`090500`）が未適用で、本番の最新より古い日付 | 在庫台帳の方針が決まるまで保留していた | 本番へ適用し（取り消し前提の試行で結果を確かめてから）、ファイル名を記録された version（`20260919065336`〜`20260919065518`）に直した |
| 掃除ジョブ（`20260912020000`）が未適用で、本番の最新より古い日付 | 呼び先のアプリが本番に無く、Vault の秘密も未登録 | `supabase/pending/` へ移した |

揃えた後の状態: ローカル17本と本番の台帳17件が1対1で一致し、`db push` で流れる未適用ファイルは無い。

この状態で CLI が勧める `migration repair --status reverted` だけを行い `--include-all` で流すと、
`20260911235714`（保持ジョブ）の SQL が再実行され、2026-09-14 に取り消した pg_cron の自己付与が戻る
（以後の `create extension pg_cron` が `dependent privileges exist` で失敗する）。台帳を書き換えず、
ファイル名を台帳に合わせたのはこのため。

## 権限を狭めるマイグレーションの順序

`REVOKE` を含むマイグレーションは、**アプリの新しいコードが動いてから**当てること。
順序を逆にすると、旧コードが剥がされた権限を使い続けて本番が壊れる。

例: `20260901120426_lock_down_guest_cart_rpc.sql` は `delete_cart_item_secure` /
`update_cart_item_quantity_secure` の EXECUTE を anon から剥がす。カート API が
service role 経由に変わっている必要がある。両者が同じ push に乗ると、
CI（DB）とホスティング（アプリ）のどちらが先に終わるかは保証されない。

2026-09-01 時点では Vercel にプロジェクトが無く、アプリはどこにもデプロイされて
いないため実害は無い。**ホスティングを用意したらこの節を読み直すこと。**
対処は次のいずれか。

- 権限を広げる変更を先に出し、狭める変更は次のリリースへ回す（2 段階デプロイ）
- メンテナンス時間を取って、アプリのデプロイ完了を確認してから `db push` を手で流す

## グループ G-1 在庫の割当の移行（20261023211425）

[設計書](../superpowers/specs/2026-10-23-group-g-design.md)の11章（切り替え）と[実装計画](../superpowers/plans/2026-10-24-group-g1-allocation.md)の Task 1・14・19 に従う。**2026-10-24 21:35（日本時間）に本番へ適用済み**。内容は[ER 図](../03_BasicDesign/data/er.md)の「在庫の割当と品物の状態の履歴」、流れは[在庫の割当の流れ](../04_DetailDesign/sequence/inventory-allocation.md)に書く。

### 記録

| 項目 | 値 |
| --- | --- |
| 移行ファイル | `supabase/migrations/20261023211425_group_g1_allocation.sql`（1本。先頭の `BEGIN;` と末尾の `COMMIT;` を1組だけ持つ。528,284 バイト、MD5 `7ecf481abdb351fb4b126e68c5746360`） |
| 本番適用版 | `20261023211425`（2026-10-24 21:35 JST、Supabase CLI の `db push --linked` で適用。CLI はファイルの版のまま記録するので改名なし） |
| 清掃件数 | オーナーが確認した件数（適用の直前に2回読み、同じ値）: `orders` 16、`order_items` 18、`order_revisions` 13、`checkout_drafts` 140、`private.order_email_outbox` 8、ほかの26の対象は0。`item_variants` は21行すべて元から在庫0（変化なし）。Webhook の `dead` への移し0、payout の計算し直し0、問い合わせの関連の解除0 |
| 適用後の照合 | 履歴の文 591個と、その連結の MD5 がローカルの `db reset` の履歴と一致。関数328（本文・所有者・設定）・トリガー108・列983 もローカルと一致。清掃の対象は全部0 |

件数は表名・条件・件数だけを書き、ID・メール・本文は書かない。

### 何をするか

1本のファイルが次の順に1取引で動く。途中までの適用はしない。

| 順 | 内容 |
| --- | --- |
| 1 | `SET LOCAL lock_timeout = '15s'`、共通の鍵 `pg_advisory_xact_lock(190521, 1)`、清掃の31表の `ACCESS EXCLUSIVE` ロック。cron の設定は変えず、この鍵と表のロックで cron・worker と直列にする。ロックごとに15秒が掛かるので、全体が15秒で必ず終わるとは言わない。取れなければ SQLSTATE `55P03` で全部戻る |
| 2 | **清掃**。開始時に削除対象の表のユーザートリガーが通常有効か、法定保存の2つの削除保護（`protect_legal_order_delete`・`protect_legal_order_item_delete`）があるか、循環 FK の形が想定どおりかを確かめ、違えば `GROUP_G_CLEANUP_PRECONDITION`（55000）で始めない。確かめた後、この取引の中だけユーザートリガーを無効にして消し、同じ取引の中で有効に戻す。循環 FK `order_items_exchange_return_line_id_fkey` は一時的に外し、同名・同じ列・`ON DELETE RESTRICT` で戻す |
| 3 | **本体**。4表・2列・台帳の理由・割当の鍵と FIFO・状態の投影と履歴・各入口の置き換え（受付・入金・解放・返金・申し込み・返品・交換・配送）・書き手の閉じた一覧。詳細は ER 図 |
| 4 | **旧入口の停止**。旧の発送4関数と仕上がりの手動記録2関数を、処理せず拒否する定義に置き換える（SQLSTATE 55000）。仕上がりの表への書込みを止める。旧の写しの関数2本を消す。**G-3 の発送票が出るまで、管理画面から発送・発送の取消・伝票番号の訂正・手動の配達済み・仕上がりの記録はできない** |
| 5 | **末尾の確かめ**（3つのブロック）。清掃後の状態、新しい表・列・制約・トリガー・関数・権限の期待、書き手の集合を比べる。1つでも違えば `GROUP_G_MIGRATION_ASSERTION_FAILED`（55000）で、清掃も本体も含めて全部戻る（全部成功か何も起きないか）。続けて `NOTIFY pgrst, 'reload schema'`、`COMMIT` |

清掃で消す・直すもの（31の永続表）:

| 操作 | 表 |
| --- | --- |
| 全件削除（25表） | `private.order_email_outbox`・`private.order_status_links`・`private.fulfillment_tracking_registrations`、`public` の `order_fulfillment_attention`・`order_fulfillment_events`・`order_fulfillment_tracking_changes`・`order_return_photos`・`order_return_photo_uploads`・`order_cancel_request_lines`・`order_cancel_requests`・`order_return_receipt_lines`・`order_return_receipts`・`order_refund_lines`・`stock_movements`・`order_refunds`・`order_return_lines`・`order_fulfillment_lines`・`order_item_completions`・`order_items`・`order_fulfillments`・`order_returns`・`order_revisions`・`payment_exceptions`・`checkout_drafts`・`orders`（削除の順は外部キーに従い、`stripe_refunds`・`stripe_balance_transactions` の注文に結ぶ行を先に消してから `orders` を消す） |
| 注文に結ぶ行だけ削除（2表） | `stripe_refunds`・`stripe_balance_transactions`（消す注文に結ぶ行） |
| 関連だけ外す（1表） | `contact_inquiries.order_id` を空にする。本文と子メッセージは残す |
| 在庫を0にする（1表） | `item_variants.stock_quantity`（無効な variant も含む全部）。**適用後は全商品が、再入荷を記録するまで売り切れ表示になる** |
| 集計を直す（1表） | `stripe_payouts`。影響を受ける payout だけ、残る balance の net の合計で `reconciled_net` を計算し直し、照合状態を `pending` に戻す（行は残す） |
| 終端にする（1表） | `stripe_webhook_events`。消す注文に結ぶ未完了のイベントだけ `dead` にし、理由 `group_g1_test_data_cleanup` と通知済み時刻を同じ更新で入れる（削除しない。テストデータについて知らせのメールは送らない） |

商品・variant・色・サイズ、利用者と全 ACL・G-0 の履歴、問い合わせの本文、注文に結ばない Stripe の写し、payout の行、Resend の重複防止の記録、Webhook の全行、監査ログ、Storage の全オブジェクトは残す。写真は注文に結ぶ DB の行だけを消す。条件の正確な文は計画の Task 1 の表が唯一の正本で、本書はその要約。

### 当て方

計画では Supabase MCP の `apply_migration` でファイル全文を1回だけ当てる予定だった。実際は、ファイルが 528KB と大きく1回の呼び出しで渡せないため、オーナーの指示で **Supabase CLI の `db push --linked`** で当てた（ローカルの `db reset` と同じ仕組みでファイルをそのまま1取引で当てる。CLI はログイン済みの印で一時的な役割を作って接続し、DB のパスワードは扱っていない）。清掃だけ・本体だけの個別適用と、移行履歴への手の INSERT はしない。読み取りは MCP の `execute_sql`。

| 順 | 内容 |
| --- | --- |
| 1 | 全体検証（型・単体・DB 結合・E2E を最新の基準と比較・最終レビュー）を終える |
| 2 | MCP で件数だけを読む（31表の条件別の件数、全 variant の件数と在庫の合計、削除する balance の件数、影響する payout の件数、問い合わせの解除件数、未完了の Webhook の件数）。ID・メール・本文は読まない。本番とローカルの関数の指紋・所有者・`search_path`・権限・トリガー・FK も読み比べ、差があれば止める |
| 3 | 適用前に次を確かめる（最終レビューの推奨）。(a) `anon`・`authenticated`・`service_role` の `pg_auth_members` と `pg_write_all_data`・`pg_read_all_data`・`pg_maintain` の所属（所属があると台帳の INSERT 権限の確かめが落ちて全部戻る）。(b) 清掃の対象27表のユーザートリガーの `tgenabled`（`O` 以外があると開始時に止まる。安全側だが時間枠を無駄にする）。(c) 本番にだけある関数の有無（本番とローカルの関数の集合を両方向で比べる） |
| 4 | 移行ファイルの文字を固定する（UTF-8・BOMなし・LF、全角空白 U+3000 と CR が0、ドル引用の外のトップレベルの `BEGIN`・`COMMIT` が各1）。MD5（小文字）とバイト数を保存し、以後ファイルを変えたら検証・レビュー・この固定からやり直す |
| 5 | 手元で動くアプリと worker を止める（3000番の E2E 用のアプリも）。止めたことを棚卸しで確かめ、master の対象コミットだけを push する |
| 6 | 適用の直前に、writer（アプリ・worker）、cron の登録（jobname・schedule・active・関数名だけ。command の本文は出さない）、31表の件数を読み直す。**前回より多くても少なくても止めて**原因を確かめ、連続2回の読み取りが一致する安定した件数を作る。cron の設定は変えない |
| 7 | オーナーに31表の条件と件数を示し、**明示の確認**を取る（一般の実装の承認や時間経過では代えない）。確認後に件数や時間枠が変わったら 6 に戻る |
| 8 | `supabase migration list --linked` で本番に無いのが G-1 だけであることを、`supabase db push --linked --dry-run` で当てるのが G-1 の1本だけ（seed・役割なし）であることを確かめ、`supabase db push --linked` を1回流す |
| 9 | 当てた文を照合する。CLI は文ごとに分けて記録するので、`array_length(statements,1)` と `md5(array_to_string(statements, E'\n'))` を、ローカルで `db reset` した履歴の同じ値と比べる。新しい表・列・関数・権限、旧入口の停止、31表の結果（件数・全 variant が0・Webhook の `dead`）、`private` スキーマの `USAGE`、G-0 の保持を読み取りで確かめる。本番で試験の注文は作らない |
| 10 | 版はファイルのまま記録されるので改名しない。上の記録を埋めてコミットし、push する |

### 失敗したとき・戻すとき

- `55P03`（15秒でロックが取れない）、`40P01`（deadlock）を含む失敗は、全部戻る。移行履歴にも残らないことを読み取りで確かめる。個別の節の適用や、すぐの強制再試行はしない。後の時間枠で 2 からやり直す。cron の設定を変えて通さない。
- 適用に成功した後の巻き戻しは用意しない。清掃で消したテスト用の注文と関連記録は戻せない。後からの直しは新しい移行で行う。
- 適用の前に、ローカルの DB でも同じ全文を、故障を注入して実行する試験（`group_g1_cleanup.integration.test.ts`）があり、末尾の確かめが失敗したときに清掃・新しい表・列・関数がすべて戻ることを確かめている。本番での実行を意味しない。

### 適用後に残る作業

- 旧の発送4関数と仕上がりの2関数は、G-3 の発送票まで再開しない。
- 適用の前後の読み比べで、G-1 と関係のない前からの差が2つ見つかった（G-1 は触っていない）。後でどちらに揃えるかを決める。
  - 11の関数（`cleanup_password_reset_tokens`・`clear_admin_expense_cost_allocations`・`create_profile_for_new_auth_user`・`find_auth_user_id_by_email`・`increment_rate_limit_counter` の2つ・`is_auth_session_active`・`record_admin_finance_entry_revision`・`replace_admin_expense_cost_allocations`・`revoke_auth_session`・`revoke_auth_sessions_for_user`）の EXECUTE 権限が、本番は `postgres`・`service_role` だけ、ローカル（移行ファイル）は `anon`・`authenticated` にも付く。本番の方が狭い。**G-2 の最初の移行（`20261024153505_group_g2_purchasing_foundation.sql`）が、ローカル側の `anon`・`authenticated`・PUBLIC の EXECUTE を外して本番に揃える**（下の「グループ G-2 発注・受け取りの移行」）。
  - `admin_finance_summary_options` の2つの CHECK 制約の定義の括弧の付き方が違う（意味は同じ）。
  - 7つの関数の本文の改行（CR の有無）が違う（CR を除くと同じ）。

## グループ G-2 発注・受け取りの移行（20261024153505〜）

[設計書](../superpowers/specs/2026-10-23-group-g-design.md)と[実装計画](../superpowers/plans/2026-10-24-group-g2-purchasing.md)に従う。移行は2本（Task 1 で作り Task 2 以降が足す基盤と、Task 4 で作り Task 6 以降が足す書込みの `writers`）。ここには基盤の移行を書き（Task 1 の分と Task 2 の発注書の9表と Task 3 の在庫一覧表の読取と Task 5 の発注の読取）、`writers` の移行は下の「writers の移行」に書く。**2本とも 2026-10-25 12:39 JST に本番へ適用済み**（全体の検証の後に、基盤・書込みの順で。記録は下の「本番適用の記録」）。基盤のファイルの 100,000 バイトの上限は Task 3 で外した（本番は `npx supabase db push --linked` でファイルごとに1取引で当て、CLI は大きなファイルも扱える）。移行は2本のまま。

### 記録（Task 1 の基盤）

| 項目 | 値 |
| --- | --- |
| 移行ファイル | `supabase/migrations/20261024153505_group_g2_purchasing_foundation.sql`（先頭の `BEGIN;` と末尾の `COMMIT;` を1組だけ持つ。本体は `-- G2A_BODY_BEGIN`〜`-- G2A_BODY_END`、末尾の確かめは `-- G2A_FINAL_ASSERT_BEGIN`〜`-- G2A_FINAL_ASSERT_END`。UTF-8・BOMなし・LF） |
| 本番適用版 | `20261024153505`（2026-10-25 12:39 JST、Supabase CLI の `db push --linked` で適用。版はファイルのまま） |
| 書込みの移行 | `supabase/migrations/20261024180500_group_g2_purchasing_writers.sql`（Task 4。常に基盤の後。節の印は `-- G2B_BODY_BEGIN`〜`-- G2B_BODY_END` と `-- G2B_FINAL_ASSERT_BEGIN`〜`-- G2B_FINAL_ASSERT_END`。UTF-8・BOMなし・LF・ASCII のみ）。本番適用版 `20261024180500`（同じ push で基盤の直後に適用） |

### 何をするか

G-1 の適用済みの移行は変えず、新しい移行の本体で次を行う。

| 順 | 内容 |
| --- | --- |
| 1 | 内部の部品 `private.group_g_actor_has_permissions(_actor_id, _codes)` を足す。実行者の有効な（`active` かつ期限なしか未来の）全ての役割の権限の**和集合**が `_codes` を全て含む時だけ true（窓口の `authorizeAdminPermissions` と同じ意味）。NULL・空配列・未登録コードは false。誰にも EXECUTE を付けない（G-2 の DB 関数の権限の確かめはこれ1つ） |
| 2 | 内部の部品 `private.group_g_open_work_order_ids(_variant_ids)` を足す。そのバリアントを含み、受注生産の数がありうる注文の id を昇順で返す先絞り（NULL は全バリアント）。投影（`group_g_item_state_ranges`）が受注生産と数えうる注文の**上位集合**で、外すのは数えようのない注文だけ: `payment_in_progress`・`abandoned`（投影が隠す）、未発送で取り消されていない数（明細の数 − 取り消していない発送の数 − 発送前返金の数〔`awaiting_response`・`pending`・`succeeded`〕が正）が無く、未解決の返品・返金・取消申請・発送前返金の失敗も無い `shipped`（投影の「残り > 取消」と同じ条件）、入金の記録（`paid_at`・`paid_amount`）も paid の割当も発送も無い `pending`・`failed`、割当も発送も無い `cancelled`（G-1 の規則で全部が取消の数）。`paid`・上の条件を満たす `shipped`（発送の記録が無い発送済みの注文を含む）・入金の記録か paid の割当か発送がある `pending`・`failed` は残す。発送か割当のある `cancelled` は、投影が何も数えない形でも残す（既知の費用。先絞りは上位集合のままにして、決めるのは投影）。誰にも EXECUTE を付けない |
| 3 | `private.admin_record_stock_movement` の権限の確かめだけを `admin.items.manage` から `admin.stock.manage` ＋ `admin.stock.read`（1で足した部品）へ替える。ほかは G-1 のまま（`CREATE OR REPLACE`。署名・所有者・ACL・戻り型は同じ） |
| 4 | `private.list_group_g_variant_inventory` の受注生産の数え方を、そのバリアントを持った全注文でなく、2で足した先絞りが返す注文だけに投影を掛ける（`CREATE OR REPLACE`）。先絞りが上位集合なので、絞らない投影と同じ数になる（試験が variant ごとに比べる）。`lock_group_g_inventory` は変えない（その閉包は、割当も保留も残らない閉じた注文を入れないが、`pending`・`payment_in_progress`・期限切れでない失敗の注文と、割当か保留が残る注文〔状態に関わらず〕は入れる） |
| 5 | `private.guard_group_g_paid_at` に、`orders.paid_at` の最初の値（NULL から値）は共通の鍵 `(190521,1)` を持つ接続だけが書ける、という確かめを足す（`GROUP_G_INVENTORY_LOCK_REQUIRED`／55000）。値から別の値・NULL は今までどおり `GROUP_G_PAID_AT_IMMUTABLE` |
| 6 | 認証・会計の公開関数11本の EXECUTE を `PUBLIC`・`anon`・`authenticated` から外す（`GRANT` は足さない。`service_role` と `postgres` は触らない） |
| 7 | 発注書の9表を作る（Task 2。`purchase_orders`・`purchase_order_lines`・`purchase_order_revisions`・`purchase_order_short_closures`・`purchase_order_receipts`・`purchase_order_receipt_lines`・`purchase_order_attachment_reservations`・`purchase_order_attachments`・`purchase_order_attachment_revisions`。すべて public・所有者 postgres・主キー uuid。外部キー22本はすべて `ON DELETE RESTRICT`、操作の受付 `private.group_g_operations` への5本だけ遅延）。データを入れる文は無い |
| 8 | 追記専用の7表に `*_no_update`・`*_no_delete`・`*_no_truncate` を付け（G-1 と同じ `private.reject_group_g_event_mutation()`）、`purchase_orders`・`purchase_order_lines` の削除と TRUNCATE を同じ関数で断る |
| 9 | `private.guard_group_g_purchase_order_change()` を `purchase_orders`・`purchase_order_lines` の BEFORE UPDATE に付ける（識別の列の変更を断る・変わる更新は `version` +1 と共通の鍵の保持を要る） |
| 10 | `private.check_purchase_order_receipt_line()`（受取行の BEFORE INSERT。台帳の無タグの行との突き合わせと相殺元の確かめ）と `private.check_purchase_order_line_received()`（納品数と受取行の合計・相殺の超過を commit の時に確かめる遅延トリガー）を足す |
| 11 | 9表の RLS・拒否だけの `RESTRICTIVE` の方針・全権限の剥奪。service_role に `SELECT` を残すのは `purchase_order_attachments` と `purchase_order_attachment_reservations` だけ |
| 12 | 非公開の置き場 `purchase-order-documents`（20 MiB・PDF／JPEG／PNG）を `storage.buckets` に1行足す（`ON CONFLICT (id) DO NOTHING`）。`storage.objects` の方針は作らない |
| 14 | 在庫一覧表の読取 `private.list_admin_inventory(_actor_id)` と public 入口を足す（Task 3。下の「14 の在庫一覧表の読取について」）。10 の受取行の確かめには、受け取りの種類と行の符号を結ぶ確かめ（`DETAIL` は `kind`）も足した |
| 15 | 発注の読取の3関数と public 入口2本を足す（Task 5。下の「15 の発注の読取について」）: 内部の helper `private.purchase_order_display_stages(uuid[])`（表示段階を導く唯一の場所。誰にも EXECUTE を付けない）、`private.list_admin_purchase_order_lines(_limit, _offset, _actor_id)`、`private.get_admin_purchase_order(_purchase_order_id, _actor_id)` と、後の2つの同名の public 入口。末尾に `$g2a_final_purchase_reads$`（`DETAIL` は `purchase_read_functions`）を足した |
| 13 | 末尾の確かめ（`GROUP_G_MIGRATION_ASSERTION_FAILED`／55000、`DETAIL` が項目名）。Task 1 の `public_function_acl`（11本が存在し、anon・authenticated・PUBLIC〔有効な ACL で見る。`proacl` が NULL なら既定の ACL〕が EXECUTE できず、service_role が EXECUTE できる）に、Task 2 の `$g2a_final_objects$`（9表に今の取引が書いた行が無いこと・RLS・所有者・方針・列・制約87本・索引25本・トリガー30本・3関数・置き場の値と方針の無さ。`purchase_tables`・`purchase_table_rows`・`purchase_table_policies`・`purchase_table_columns`・`purchase_table_constraints`・`purchase_table_indexes`・`purchase_table_triggers`・`purchase_functions`・`purchase_bucket`・`purchase_bucket_policies`）と `$g2a_final_table_acl$`（`purchase_table_acl`。表の権限を意味で比べ、PostgreSQL 17 以降は `MAINTAIN` も「無い」の一覧に入れる）を足した。Task 9 は `$g2a_final_objects$` に、足した2つの部品と置き換えた G-1 の3関数の所有者・SECURITY・volatility・search_path・EXECUTE（`foundation_functions`）、この file の14関数の名前の関数が他に無いこと（`foundation_function_set`）、service_role が EXECUTE できるのは読取の本体4本と入口4本だけであること（`foundation_service_role_execute`）を足し、`purchase_table_rows` を「今の取引が書いた行が無い」（`created_at` が取引の開始時刻と同じ行が無い）に直した（後から確定した別の取引の行で確かめが落ちないように）。違えば全部戻る。続けて `NOTIFY pgrst, 'reload schema'`、`COMMIT` |

### 6 の公開関数11本の EXECUTE について（セキュリティ）

ベースの移行（`20260901102912_remote_schema.sql`）は、この11本について `PUBLIC` を外して `postgres`・`service_role` に付けただけで、Supabase の既定の権限が付けた `anon`・`authenticated` の直接の EXECUTE が残った。移行から作った DB（ローカルの `db reset` など）では、anon が `revoke_auth_sessions_for_user` などを呼び、他の利用者のセッションを消せた。**本番は 2026-10-24 の読み取りで `postgres`・`service_role` だけが持つことを確かめてあり、本番の状態は変わらない**（適用の直前にもう一度読み取って確かめる）。

呼び出し元は全て `createServiceRoleClient`（service_role）で、anon・authenticated のクライアントから呼ぶ箇所は無い（2026-10-25 に再確認: `revoke_auth_sessions_for_user` は password-reset の confirm・logout・admin の revoke-user-sessions、`revoke_auth_session` は logout、`is_auth_session_active` は `authenticate.ts`、`find_auth_user_id_by_email` は register と password-reset の request・link、`increment_rate_limit_counter` は `features/auth/ratelimit`、`replace_` と `clear_admin_expense_cost_allocations` は accounting の product-costs。`cleanup_password_reset_tokens` は src に呼び手が無く、`create_profile_for_new_auth_user` と `record_admin_finance_entry_revision` はトリガー関数で、PostgreSQL はトリガー関数の EXECUTE を作成時にしか確かめないので発火に影響しない）。新しいコードを前提にする移行ではなく、権限を狭めるだけの移行なので、アプリの順序の制約（「権限を狭めるマイグレーションの順序」）は、呼び手が全て service_role のため本番では満たされている。

### 7〜13 の発注書の9表について（Task 2）

- **本番への影響**: 新しい表・関数・トリガー・方針と `storage.buckets` の1行を足すだけで、既存の表・行は変えない。データを変える文（清掃・補完・権限行の再投入）は無いので、適用の前の owner 確認は要らない。構造と列・制約・索引・トリガー・権限は移行の末尾の確かめが全部見る。
- **適用の直前に読み取って確かめる**: `storage.buckets` に `purchase-order-documents` がまだ無いこと。既にあって設定が違うと（`public = true`・上限・種類）、`ON CONFLICT (id) DO NOTHING` は何も変えず、末尾の確かめ（`purchase_bucket`）が移行全体を戻す。その時は置き場の設定を確かめてから決める（黙って直さない）。
- **外部キーと TRUNCATE**: 追記専用の表の TRUNCATE は、PostgreSQL が外部キーの確かめをトリガーより先に行うので、その表を指す表を同じ文に並べない限りトリガーに届かない（届かなくても全消しはできない）。G-1 の `group_g1_model`（操作の受付の全消し）と `stock_movements`（台帳の全消し）の試験は、新しく指す表を同じ文に足して「追記専用」の拒否を確かめ続けた。操作の受付 `private.group_g_operations` を指す外部キーは 4 本から 9 本（遅延）になった。
- **大きさ**: 基盤の移行は Task 2 の後で約 76 KB、Task 3 の後で約 84 KB。100,000 バイトの上限は Task 3 で外した（上の記録のとおり、CLI は大きなファイルも扱える）。3 本目に分けず、移行は2本のまま。バイト数と MD5 は適用の直前に固定して記録する。

### 14 の在庫一覧表の読取について（Task 3）

- **足すもの**: `private.list_admin_inventory(_actor_id uuid)` と、同じ名前・引数・戻り型の public 入口（`LANGUAGE sql STABLE SECURITY INVOKER`）。戻り列は `variant_id`・`item_id`・`item_name`・`color_name`・`size_label`・`is_active`・`free`・`paid_allocated`・`payment_held`・`on_hand`・`order_quantity`・`on_order`・`required` の13。private 本体は `plpgsql STABLE SECURITY DEFINER SET search_path = ''`、所有者 postgres。private 本体も public 入口も `PUBLIC`・`anon`・`authenticated`・`service_role` を個別に REVOKE してから `service_role` だけに EXECUTE を付ける（public 入口は INVOKER なので、private 本体にも `service_role` の EXECUTE が要る）。`private` schema の USAGE には触れない。
- **何をするか**: 最初に `private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.stock.read'])` を確かめ、偽なら `GROUP_G_FORBIDDEN`／42501（何も読む前）。一つの SQL の中で、在庫は G-1 と同じ（`on_hand` = 空き＋入金済みの割当＋支払い前の仮確保）、注文数は `group_g_item_state_ranges(group_g_open_work_order_ids(NULL))` の `in_production`＋`ready`、発注済みは数量確定済みの発注の未納（`outstanding_quantity`）、`required` = `max(0, 注文数 − 在庫 − 発注済み)`。表示は、販売中か、在庫・未納・注文数のどれかがある variant。並びは商品・色の位置・サイズの位置・variant の番号。**何も書かず、variant を作らない**（STABLE なので全体が呼び出しの snapshot を共有する）。
- **本番への影響**: 新しい関数を足すだけ。表・行・権限は変えない。
- **末尾の確かめ**: `$g2a_final_inventory_list$`（`DETAIL` は `inventory_list_functions`）が、2関数の存在・所有者・`SECURITY DEFINER` か INVOKER か・言語・`STABLE`・集合を返すこと・`search_path` が空・引数と戻り列の名前／型／順・anon／authenticated／PUBLIC が EXECUTE できず service_role ができること、を見る。
- **Task 2 のレビューからの持ち越し（M1）**: `private.check_purchase_order_receipt_line()` に、受け取りの種類と行の符号の確かめを足した。種類 `receive` の受け取りは正の行だけ、種類 `reverse` の受け取りは負の行だけ。違えば `GROUP_G_PO_RECEIPT_LINE_MISMATCH`／23514（`DETAIL` は `kind`）。まだ本番に当てていない移行の中の関数なので、同じファイルの中で直した。

### 15 の発注の読取について（Task 5）

- **足すもの**: 次の5関数（すべて所有者 postgres、`search_path` 空）。
  - `private.purchase_order_display_stages(_purchase_order_ids uuid[])`（`plpgsql STABLE SECURITY DEFINER`）: 発注書ごとに 表示段階・納品の合計・未納の合計・`has_active_short_close` を返す。**表示段階を導く唯一の場所**（規則は[発注書の状態](../04_DetailDesign/states/purchasing.md)。打切りを戻すのは数量が実際に変わる `quantity` の版だけで、単価だけの版は戻さない）。`PUBLIC`・`anon`・`authenticated`・`service_role` を個別に REVOKE し、GRANT しない（呼ぶのは同じ所有者の DEFINER 関数だけ）。
  - `private.list_admin_purchase_order_lines(_limit integer, _offset integer, _actor_id uuid)`（`plpgsql STABLE SECURITY DEFINER`）と、同じ名前・引数・戻り型の public 入口（`LANGUAGE sql STABLE SECURITY INVOKER`）: 明細ごとの行を発注書番号の降順（`COLLATE "C"`）・明細番号順で返し、各行に全明細の数 `total` を持たせる。`_limit` は 1〜100、`_offset` は 0 以上（外は `GROUP_G_ARGUMENT_INVALID`／22023。権限の確かめの後）。
  - `private.get_admin_purchase_order(_purchase_order_id uuid, _actor_id uuid)`（`plpgsql STABLE SECURITY DEFINER`、戻りは jsonb）と public 入口（`LANGUAGE sql STABLE SECURITY INVOKER`）: 発注書の詳細を camelCase の jsonb で返し、無ければ NULL。`storage_path` と内部の操作 ID は含まず、`sha256` は含む。書類の `current` は最新の版だが、`replacesAttachmentId` は版1にしか保存されない（表の CHECK）ので版1から返す。
  - 4本の読取とも `PUBLIC`・`anon`・`authenticated`・`service_role` を個別に REVOKE してから `service_role` だけに EXECUTE を付ける（public 入口は INVOKER なので private 本体にも要る）。`private` schema の USAGE には触れない。
- **権限**: 一覧も詳細も、最初に `private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.purchase_orders.read'])` を確かめ、偽なら `GROUP_G_FORBIDDEN`／42501（何も読む前）。`manage` は要らない。
- **何も書かず、鍵も取らない**: 3つとも STABLE で、呼び出しの snapshot を共有する。共通の鍵・行の鍵・動的な SQL は使わない（G-1 の「書き手の閉じた一覧」の走査に掛からない）。
- **本番への影響**: 新しい関数を足すだけ。表・行・権限は変えない。データを変える文は無いので、適用の前の owner 確認は要らない。
- **末尾の確かめ**: `$g2a_final_purchase_reads$`（`DETAIL` は `purchase_read_functions`）が、5関数の存在・所有者・`SECURITY DEFINER` か INVOKER か・言語（plpgsql／sql）・`STABLE`・集合を返すか・戻り型・`search_path` が空・引数名と戻り列の名前／型／順・anon／authenticated／PUBLIC が EXECUTE できないこと・service_role の EXECUTE（helper だけ無し、他の4本は有り）を見る。
- **大きさ**: 基盤の移行は Task 5 の後で約 104 KB（約 84 KB から約 20 KB 増えた。上限は Task 3 で外してあり、移行は2本のまま）。バイト数と MD5 は適用の直前に固定して記録する。

### 16 の取引書類の検索について（Task 8）

- **足すもの**: `private.search_purchase_order_documents(_date_from date, _date_to date, _amount_min bigint, _amount_max bigint, _counterparty text, _purchase_order_number text, _kind text, _include_history boolean, _limit integer, _offset integer, _actor_id uuid)`（`plpgsql STABLE SECURITY DEFINER`、所有者 postgres、`search_path` 空、集合を返す）と、同じ名前・引数・戻り型の public 入口（`LANGUAGE sql STABLE SECURITY INVOKER`）。戻り列は `total`・`attachment_id`・`purchase_order_id`・`purchase_order_number`・`kind`・`original_file_name`・`mime_type`・`size_bytes`・`revision_no`・`is_current`・`transaction_date`・`amount_yen`・`currency`・`counterparty`・`voided`・`reason`・`replaces_attachment_id`・`created_at` の18で、**`storage_path` は返さない**。private 本体も public 入口も `PUBLIC`・`anon`・`authenticated`・`service_role` を個別に REVOKE してから `service_role` だけに EXECUTE を付ける。`private` schema の USAGE には触れない。
- **何をするか**: 最初に `private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.purchase_orders.read'])` を確かめ、偽なら `GROUP_G_FORBIDDEN`／42501（何も読む前）。次に引数（`_kind` は quote・invoice・NULL、`_include_history` は NULL でない、`_limit` は 1〜100、`_offset` は 0 以上。外は `GROUP_G_ARGUMENT_INVALID`／22023）。既定は各添付の最新の版だけ、`_include_history` が真なら全ての版を対象にして `is_current` で最新と区別する。取引日・金額は両端を含む範囲、取引先は大小文字を区別しない部分一致（`strpos`。`% _ \` は文字）、発注書番号は大小文字を区別しない前方一致、種類は一致、全て AND。並びは `transaction_date DESC, created_at DESC（版の記録）, 版の id`。`total` は頁を切る前の件数。何も書かず、鍵も取らない。
- **本番への影響**: 新しい関数を足すだけ。表・行・権限は変えない。データを変える文は無いので、適用の前の owner 確認は要らない。
- **末尾の確かめ**: `$g2a_final_purchase_reads$`（`DETAIL` は `purchase_read_functions`）の対象に、この2関数（存在・所有者・DEFINER か INVOKER か・言語・`STABLE`・集合を返す・戻り型・`search_path` 空・引数名と戻り列の名前／型／順・anon／authenticated／PUBLIC が EXECUTE できず service_role ができる）を足した。基盤の移行は Task 8 の後で約 115 KB。予約の表に差し替え元 `replaces_attachment_id uuid`（NULL 可。添付への外部キー `purchase_order_attachment_reservations_replaces_fkey`、`ON DELETE RESTRICT`）を足した（最後の確かめの列の並びと制約の一覧にも入れた。版の表の同じ列〔版1だけ〕と同じ向き）。発注書の詳細の `pendingUploads` の各要素は `replacesAttachmentId` を持ち、書類検索の `replaces_attachment_id` は版1から読む。バイト数と MD5 は適用の直前に固定して記録する。

### writers の移行（Task 4・6・7・8。発注の作成とロック helper、数量の確定・訂正・打切り・発注先の訂正、受け取りとその取消・数量訂正、取引書類の原本の予約・確定・訂正）

`20261024180500_group_g2_purchasing_writers.sql` は、基盤の移行が作った表に書く関数だけを持つ（発注の作成・数量の確定と訂正・打切り・発注先の訂正・受け取りとその取消・取引書類の原本の書込みが、Task 4・6・7・8 でここに入った）。データを変える文は無く、**本番の変更は関数の追加と書き手の一覧の置き換えだけ**（owner 確認は要らない）。Task 6 は同じファイルに節3〜5（下の順 3〜5）を足し、書き手の一覧を60本にした（ファイルは約 25 KB から約 52 KB）。Task 7 は節6・7（下の順 6・7）を足し、書き手の一覧を62本にした（約 81 KB）。Task 8 は節8（下の順 8。取引書類の原本の3関数）を足し、書き手の一覧を65本にした（約 103 KB。バイト数と MD5 は適用の直前に固定して記録する）。レビューの後、差し替え元を予約の行に残す形にしたので、予約の関数は `_replaces_attachment_id` を取り（署名は 6 引数）、確定の関数は取らない（署名は 12 引数）。この移行は本番へ未適用なので、適用済みの SQL を変えることにはならない。

| 順 | 内容 |
| --- | --- |
| 1 | ロック helper `private.lock_group_g_purchase_orders(_purchase_order_ids uuid[], _with_inventory boolean) RETURNS uuid[]`（`SECURITY DEFINER`・所有者 postgres・`search_path` 空）を足す。**最初の文が共通の鍵 `pg_advisory_xact_lock(190521,1)`**。`_with_inventory` が真なら、その鍵の**後**に発注書の行の `variant_id` を読み、`lock_group_g_inventory(その variant, [], NULL)`（鍵は再入できる）で在庫の閉包を取って、ロックした注文の id（昇順）を返す。偽なら空の配列。続けて `purchase_orders`（id 昇順）→ `purchase_order_lines`（id 昇順）を `FOR UPDATE` で取る。`SKIP LOCKED` は使わない。呼び手は対象を後から足して前の段に戻らない。**誰にも EXECUTE を付けない**（service_role にも） |
| 2 | `private.admin_create_purchase_order(_supplier_name, _memo, _lines, _actor_id, _request_key) RETURNS jsonb` と、同じ名前・引数・戻り型の public 入口（`LANGUAGE sql SECURITY INVOKER`）を足す。private 本体も public 入口も `PUBLIC`・`anon`・`authenticated`・`service_role` を個別に REVOKE してから `service_role` だけに EXECUTE を付ける。処理の順は **引数の検証（`22023`）→ ロック helper（鍵だけ）→ 権限（`admin.purchase_orders.manage` ＋ `read` の和集合。`42501`）→ 指紋と再送・衝突（`23505`）→ variant の存在（`22023`）→ 番号 → INSERT**。詳細は[発注の作成の順序図](../04_DetailDesign/sequence/purchasing.md) |
| 3 | **発注先・メモの訂正**（Task 6）`private.admin_update_purchase_order_header(_purchase_order_id uuid, _expected_version integer, _supplier_name text, _memo text, _reason text, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{version, replayed}`）と同名・同引数・同戻り型の public 入口。操作の種類 `purchase_order_header_update`。理由が必須（`GROUP_G_PO_REASON_REQUIRED`／22023、引数検証の段）。発注先もメモも変わらなければ 22023。履歴は種類 `header`（`line_id` NULL、前後の発注先とメモ）で `revision_no` ＝ 新しい版、発注書の版 +1。どの段階でも直せる |
| 4 | **数量の確定・訂正**（Task 6）`private.admin_confirm_purchase_order_quantities(_purchase_order_id uuid, _expected_version integer, _lines jsonb, _reason text, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{version, changedLines, replayed}`）と public 入口。操作の種類 `purchase_order_quantities`。`_lines` は `[{lineId, quantity 0〜99999, unitPriceYen 0〜9999999 または null}]` で、各要素は3項目ちょうど、発注書の全行をちょうど1回ずつ（不足・重複・他の発注書の行は 22023）。段階 `ordered` は最初の確定（理由は任意）で全行の確定数量と単価を決めて段階を `quantity_confirmed` にし（全行の版が進む）、`quantity_confirmed` は訂正（理由が必須。納品済み未満は `GROUP_G_PO_QUANTITY_BELOW_RECEIVED`／23514、何も変わらなければ 22023）。履歴 `quantity` は、**最初の確定は全行に**（確定そのものを追記専用の履歴に残す。仮数量のまま・単価なしの行も、理由と実行者つきで書く）、訂正は変わった行（数量または単価。NULL と 0 は別）だけに足す。`changedLines` は実際に変わった行だけを数える。前の数量は確定数量（最初の確定は仮数量）で、**単価だけの変更も `before_quantity` ＝ `after_quantity`（現在の数量）で書く**（基盤の節15の表示段階は、数量が実際に変わる `quantity` の版だけを打切りの取消として数える）。発注書の版 +1 |
| 5 | **残りの打切り・確定前の取消**（Task 6）`private.admin_short_close_purchase_order(_purchase_order_id uuid, _expected_version integer, _line_ids uuid[], _reason text, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{version, closedQuantity, replayed}`）と public 入口。操作の種類 `purchase_order_short_close`。理由が必須（`GROUP_G_PO_REASON_REQUIRED`、引数検証の段）。`_line_ids` は1次元で1〜100件・NULL と重複なし（他の発注書の行は 22023）。段階 `quantity_confirmed`: 選んだ行の未納に0があれば `GROUP_G_PO_NOTHING_TO_CLOSE`／55000。各行の確定数量を納品済みまで下げ、履歴 `short_close`（前＝確定数量、後＝納品済み）と `purchase_order_short_closures`（`closed_quantity` ＝ 未納）を足す。段階 `ordered`（確定前の取消）: 全行をちょうど1回ずつ渡した時だけ（一部は 22023）、全行の確定数量を 0 にして段階を `quantity_confirmed` へ進め、履歴（前＝仮数量、後＝0）と打切り（`closed_quantity` ＝ 仮数量）を足す。どちらも発注書の版 +1、入庫・台帳・割当・受取は動かさない |
| 6 | **受け取り**（Task 7）`private.admin_receive_purchase_order(_purchase_order_id uuid, _expected_version integer, _received_on date, _memo text, _lines jsonb, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{receiptId, version, allocatedQuantity, replayed}`）と public 入口。操作の種類 `purchase_order_receive`。権限は `admin.receiving.manage` ＋ `admin.purchase_orders.read`。ロック helper は `_with_inventory = true`（鍵 → 発注書の行の variant を鍵の後に読む → 在庫の閉包 → 発注書 → 明細）。`_lines` は `[{lineId, quantity 1〜99999}]`（各要素は2項目ちょうど、1〜100件・lineId の重複なし）。順は **引数の検証 → ロック → 権限 → 指紋と再送 → 存在（P0002）→ 段階（数量確定前は `GROUP_G_PO_NOT_CONFIRMED`／55000）→ 版 → 受取日（発注日から今日・日本時間。`GROUP_G_PO_RECEIVED_ON_INVALID`／22023）→ 行が当発注書の物か（22023）と未納以下か（`GROUP_G_PO_RECEIVE_EXCEEDS_REMAINING`／23514）→ 書込み**。書込みは 状態の保存（`capture_group_g_item_states`）→ `app.group_g_operation_id` を設定 → 受取（`receive`）→ 行（lineId 昇順）ごとに台帳 `restock`（+q・備考「発注 PO-… の受け取り」・**無タグ**）・受取行・納品済み +q・行の版 +1 → 発注書の版 +1 → `allocate_group_g_fifo`（受け取った variant だけ）→ 状態の履歴（理由 `purchase_order_receive`）→ 操作の記録 → `app.group_g_operation_id` を戻す（失敗でも戻す。G-1 の形）。備考の日本語は、この移行が ASCII のみなので `U&'\XXXX'` の文字の列で組む |
| 7 | **受け取りの取消・数量訂正**（Task 7。同じ操作）`private.admin_reverse_purchase_order_receipt(_purchase_order_id uuid, _expected_version integer, _receipt_id uuid, _lines jsonb, _reason text, _expected_release_quantity integer, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{receiptId, version, releasedQuantity, replayed}`）と public 入口。操作の種類 `purchase_order_receipt_reverse`。権限と鍵は受け取りと同じ。`_lines` は `[{receiptLineId, quantity 1〜99999}]`。理由が必須（`GROUP_G_PO_REASON_REQUIRED`／22023、引数検証の段。外す割当が0でも必須）、`_expected_release_quantity` は NULL か 0 以上。検査は全て書込みの前: 存在 → 版 → 受取が当発注書の `receive` か（22023）→ 各行が当受取の正の行か（22023。相殺の行は不可）→ 取り消す数 ≤ 取り消せる数（`GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED`／23514）→ variant ごとに 取り消す数 q ≤ 空き在庫 F ＋ 外せる支払い済みの割当 A（`GROUP_G_PO_REVERSE_STOCK_INSUFFICIENT`／23514。仮確保は外さず数えない）→ 外す点数 n ＝ variant ごとの max(q − F, 0) の合計が 0 でないのに確認の数が無い・違う時 `GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED`／55000（`DETAIL` は `{"releasedQuantity": n}`。G-1 の `admin_record_stock_movement` と同じ判定式）。書込みは G-1 の減らし方: 相殺の受取（`reverse`・日本時間の今日・理由）→ 行（receiptLineId 昇順）ごとに空き在庫の次に支払い済みの割当を新しい注文から外す（割当の残りと版、台帳 `allocation_release`〔+n・タグ付き・注文と明細つき・備考＝理由〕、割当イベント `release`〔理由 `stock_adjustment`〕）→ 台帳 `adjustment`（−q・無タグ）・負の受取行（相殺元つき）・納品済み −q・行の版 +1 → 発注書の版 +1 → FIFO（余りが無いので0点）→ 状態の履歴（理由 **`stock_move`**。G-1 の在庫を減らす操作と同じ値。計画の `stock_adjustment` 案より G-1 との一致を優先）→ 操作の記録。外れるのは未発送の割当だけ（消費された数量は `remaining_quantity` に残らない） |
| 8（Task 8） | **取引書類の原本**（FREQ-530）の3関数と public 入口。どれも発注書・在庫・台帳・割当・注文を読みも書きもせず、書くのは予約・添付・版の表と `private.group_g_operations` だけ（追記だけで、UPDATE・DELETE は無い）。処理の順は 引数の検証（`22023`）→ ロック helper（`ARRAY[発注書]`・在庫を動かさない）→ 権限（`admin.purchase_orders.manage` ＋ `read`）→ 指紋と再送・衝突（`23505`）→ 存在（`P0002`）→ 業務規則 → 書込み → 操作の記録。置き場は一切使わない（検査済みの種類・大きさ・ハッシュは呼び手が渡す）。通貨は JPY 固定（列は3文字の英大文字を許す）。(a) `private.admin_reserve_purchase_order_attachment(_purchase_order_id uuid, _kind text, _file_name text, _replaces_attachment_id uuid, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{reservationId, storagePath, expiresAt, replayed}`）: 操作の種類 `purchase_order_attachment_reserve`。種類は quote・invoice、ファイル名は前後の空白を落として1〜255字で制御文字なし、拡張子は pdf・jpg・jpeg・png（大小は問わず保存キーでは小文字。他は `22023`）。保存キー `<発注書の id>/<gen_random_uuid()>.<拡張子>`、`expires_at = now() + 24時間`。差し替えの予約だけ `_replaces_attachment_id`（NULL は新しい書類）を取り、存在の確かめの後に、その発注書の添付でなければ `GROUP_G_PO_DOCUMENT_REPLACEMENT_INVALID`／22023（予約も操作の記録も残らない）、合えば予約の行の `replaces_attachment_id` に残す。指紋にも入る（同じ要求番号で差し替え元が違えば `23505`）。(b) `private.admin_attach_purchase_order_document(_reservation_id uuid, _purchase_order_id uuid, _mime_type text, _size_bytes bigint, _sha256 text, _sha256_source text, _transaction_date date, _amount_yen bigint, _currency text, _counterparty text, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{attachmentId, revisionNo: 1, replayed}`）: 操作の種類 `purchase_order_attachment_attach`。種類は PDF・JPEG・PNG、大きさ 1〜20971520、`sha256` は64桁の小文字、`sha256_source` は browser／server、取引日は2000-01-01以降の有限の日付、金額は0〜99999999999、取引先は1〜100字（他は `22023`）。予約が当発注書の物でなければ `GROUP_G_PO_DOCUMENT_RESERVATION_INVALID`／55000、すでに添付に結ばれていれば `GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED`／55000。差し替え元は引数で受けず、予約の `replaces_attachment_id` を版1へ写す（頁を読み直した後の再開でも変わらない）。予約の期限は見ない（期限切れでも確定できる）。添付（種類・原ファイル名・保存キーは予約から）と版1（`replaces_attachment_id` は版1だけ）を追記する。(c) `private.admin_revise_purchase_order_document(_attachment_id uuid, _purchase_order_id uuid, _transaction_date date, _amount_yen bigint, _currency text, _counterparty text, _voided boolean, _reason text, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{attachmentId, revisionNo, replayed}`）: 操作の種類 `purchase_order_attachment_revise`。理由が必須（`GROUP_G_PO_REASON_REQUIRED`、201字以上は `22023`）、前の版と同じ内容・他の発注書の添付・存在しない添付は `22023`、`revision_no` は最大＋1。3本とも private 本体も public 入口（`LANGUAGE sql SECURITY INVOKER`）も `PUBLIC`・`anon`・`authenticated`・`service_role` を個別に REVOKE してから `service_role` だけに EXECUTE を付ける。指紋は 操作・対象・全ての入力・実行者（版は無い）。原因は `purchase_order`＝発注書の id |
| 8（一覧。旧 8） | `private.group_g_writer_allowlist()` を置き換える（`CREATE OR REPLACE`。署名・所有者・ACL は同じ）。G-1 の56本は1文字も変えず、`private.admin_create_purchase_order(text,text,jsonb,uuid,uuid)`（Task 4）、続けて Task 6 の `private.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid)`・`private.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid)`・`private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid)` を足した60本に、Task 7 の `private.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid)`・`private.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid)` を足した62本に、Task 8 の `private.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid)`・`private.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid)`・`private.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid)` を足した**65本**（9本とも `private.group_g_operations` へ書く書き手で、public 入口は private 本体へ委ねるだけ。受け取りの2本は台帳・割当・受取の表にも書く。原本の3本は予約・添付・版の表にだけ書く）。G-2 で書き手の一覧は65本で閉じており、増やす時は末尾の確かめと構造の試験も一緒に直す |
| 9 | 末尾の確かめ（`GROUP_G_MIGRATION_ASSERTION_FAILED`／55000、`DETAIL` が項目名）。`$g2b_final_objects$`: 19関数（ロック helper と、作成・訂正・確定・打切り・受け取り・受け取りの取消・原本の予約・原本の確定・原本の訂正の private 本体と public 入口）の存在・所有者・`SECURITY DEFINER` か INVOKER か・言語・戻り型・引数名・`search_path` 空・anon／authenticated／PUBLIC〔有効な ACL で見る〕が EXECUTE できないこと・service_role の EXECUTE（`purchase_writer_functions`）、ロック helper の本体で鍵が在庫の閉包と `FOR UPDATE` より先にあること（`purchase_writer_lock_order`）、一覧の65本が全て関数に解決すること（`purchase_writer_allowlist_missing`）、一覧が期待の65本と同じ集合であること（`purchase_writer_allowlist`）、この19関数の名前の関数が public・private に他に無いこと〔余分な overload と欠け。per-function の EXECUTE の確かめと合わせて、service_role が EXECUTE できるのは書込みの本体9本と入口9本だけ〕（`purchase_writer_function_set`。Task 9）。`$g2b_final_table_acl$`: 書き込む8表（`purchase_orders`・`purchase_order_lines`・`purchase_order_revisions`・`purchase_order_short_closures`・`purchase_order_receipts`・`purchase_order_receipt_lines`・`purchase_order_attachment_revisions`・`private.group_g_operations`）の権限を意味で比べ、postgres は全権限、PUBLIC・anon・authenticated・service_role は列の権限も含め無し、PostgreSQL 17 以降は `MAINTAIN` も「無い」の一覧に入れる（`purchase_writer_table_acl`）。違えば全部戻る。続けて `NOTIFY pgrst, 'reload schema'`、`COMMIT` |

- **発注番号**: `PO-` ＋ 日本時間（`Asia/Tokyo`）の `YYYYMMDD` ＋ `-` ＋ 4桁の連番。連番は同じ日の最大＋1で、共通の鍵の下で採り、`purchase_orders.number` の UNIQUE が守る。別の日の番号は数えない。9999 を超えると `GROUP_G_PO_NUMBER_EXHAUSTED`／55000 で何も残さず止まる（窓口は固定の500）。
- **冪等**: 操作の種類 `purchase_order_create`・原因 `purchase_order`＝新しい発注書の id。指紋は `{operation, supplier_name, memo, lines〔variantId 昇順〕, actor_id}` の SHA-256。同じ要求番号・同じ指紋は保存した結果に `replayed: true` を足して返し、指紋が違えば `GROUP_G_REQUEST_KEY_CONFLICT`／23505。権限の確かめは再送の判定より先なので、権限の無い人には再送の結果も見せない。Task 6 の3本も同じ規則（原因＝書き換える発注書の id）で、指紋は 操作・発注書の id・内容・理由・実行者の SHA-256 で**版を含めない**（版が進んだ後に古い版で再送しても保存した結果を返す。再送の判定は存在と版の確かめより先）。
- **在庫を動かすのは Task 7 の2本だけ**: 作成と Task 6 の3本は在庫・割当・台帳・状態の履歴・注文を読みも書きもしない（読むのは variant・商品・色・サイズ・発注書・操作の受付だけ。Task 6 の3本は発注書・明細・履歴・打切り・操作の受付だけを書き、受取や台帳は読みもしない）。受け取りとその取消（Task 7）だけがロック helper の `_with_inventory = true` を使い、台帳（`restock`・`allocation_release`・`adjustment`）・割当・割当イベント・状態の履歴・受取・受取行を書く。受け取りの台帳は**無タグ**（付けると G-1 の整合の trigger が一致する割当イベントを求めて `GROUP_G_ALLOCATION_BOUNDS` で落ちる）で、タグが付くのは FIFO の `purchase` 行と、取消が外す `allocation_release` だけ。
- **適用の順**: 常に基盤の移行の後（ファイル名が後ろ）。基盤が先に当たっていないと、この移行は表が無くて関数の末尾の確かめで止まる。

### 適用の手順と確認（Task 9 で完成）

**2 本の移行**（常にこの順。どちらも先頭の `BEGIN;` と末尾の `COMMIT;` を1組だけ持ち、UTF-8・BOMなし・LF・ASCII のみ。全角空白・NBSP・CR は無い）:

| 順 | ファイル | バイト数 | MD5 |
| --- | --- | --- | --- |
| 1 | `supabase/migrations/20261024153505_group_g2_purchasing_foundation.sql` | 121,715 | `5248d3da2923b2476f79b6be1c42acca` |
| 2 | `supabase/migrations/20261024180500_group_g2_purchasing_writers.sql` | 106,412 | `b4813a3fb1a2c360264b02d6a441214b` |

バイト数と MD5（小文字）は 2026-10-25 の適用前の固定で計り直した値（Task 9 の書き上がりから変わっていない。BOM・CR・全角空白・NBSP は0、トップレベルの `BEGIN;`・`COMMIT;` は各1）。以後ファイルを変えたら検証からやり直す。1 本あたり 100,000 バイトの目安は Task 3 で外した（MCP の `apply_migration` の上限のための目安で、本番は CLI がファイルごとに1つの取引で当てる。G-1 の移行は 528 KB で通った）。

**当て方（本番）**: 適用の直前の読み取りで (1) 本番の移行の台帳の末尾が `20261023211425` であること、(2) `storage.buckets` に `purchase-order-documents` が無いこと（あれば設定が同じこと）、(3) 認証・会計の公開関数11本の EXECUTE が `postgres`・`service_role` だけであることを確かめ、(4) 次の段落の名前の衝突の読み取りが 0 を返すことを確かめ、`npx supabase db push --linked` で2本を順に当てる。各ファイルは1つの取引で、**末尾の確かめが1つでも落ちるとそのファイルは巻き戻り**（`GROUP_G_MIGRATION_ASSERTION_FAILED`／55000、`DETAIL` は項目名だけ）、2本目は当たらない。データを変える文は無く、本番の変更は新しい表・関数・トリガー・方針・置き場の1行・書き手の一覧の置き換え・11関数の権限を狭める REVOKE（本番では何も変わらない）だけ。

**適用前の名前の衝突の読み取り（読み取りだけ。G-2 の前は 0 になる）**: 2本の移行は関数を `CREATE FUNCTION`（`OR REPLACE` なし）で作り、末尾の確かめは名前で関数の集合を比べる。本番にだけある同じ名前の関数（別の引数の型の過負荷を含む）があると、2本目まで流してから落ちるか、集合の確かめで落ちる。基盤の移行が作る10名（`group_g_actor_has_permissions`・`group_g_open_work_order_ids`・`purchase_order_display_stages`・`guard_group_g_purchase_order_change`・`check_purchase_order_receipt_line`・`check_purchase_order_line_received`・`list_admin_inventory`・`list_admin_purchase_order_lines`・`get_admin_purchase_order`・`search_purchase_order_documents`）と、書込みの移行が作る10名（`lock_group_g_purchase_orders`・`admin_create_purchase_order`・`admin_update_purchase_order_header`・`admin_confirm_purchase_order_quantities`・`admin_short_close_purchase_order`・`admin_receive_purchase_order`・`admin_reverse_purchase_order_receipt`・`admin_reserve_purchase_order_attachment`・`admin_attach_purchase_order_document`・`admin_revise_purchase_order_document`）が、`public` と `private` に1つも無いことを、適用の直前に次で数える（0 以外なら適用を止めて、本番にある関数の定義を調べる）。

```sql
SELECT count(*) AS existing_g2_functions
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'private')
  AND p.proname IN (
    'group_g_actor_has_permissions', 'group_g_open_work_order_ids', 'purchase_order_display_stages',
    'guard_group_g_purchase_order_change', 'check_purchase_order_receipt_line', 'check_purchase_order_line_received',
    'list_admin_inventory', 'list_admin_purchase_order_lines', 'get_admin_purchase_order', 'search_purchase_order_documents',
    'lock_group_g_purchase_orders', 'admin_create_purchase_order', 'admin_update_purchase_order_header',
    'admin_confirm_purchase_order_quantities', 'admin_short_close_purchase_order', 'admin_receive_purchase_order',
    'admin_reverse_purchase_order_receipt', 'admin_reserve_purchase_order_attachment', 'admin_attach_purchase_order_document',
    'admin_revise_purchase_order_document');
```

この数は適用の前だけの確かめで、適用の後は 0 にならない。適用後の関数の集合は、末尾の確かめ（`foundation_function_set`・`purchase_writer_function_set`）が OID まで見る。

**末尾の確かめは環境によらない**: 局所で作られる名前（自動の制約名など）を使わず、制約・トリガー・索引は名前で、ACL は意味で（`has_function_privilege`・`has_table_privilege`・`aclexplode`。`proacl` が NULL の既定には PUBLIC が含まれるので有効な ACL で見る）、PostgreSQL 17 の `MAINTAIN` は版（`server_version_num >= 170000`）で守って比べる。本番に別の grantee（`supabase_admin` など）が付いていても通る。9表に「この取引が書いた行」が無いことの確かめ（`purchase_table_rows`）は、行の `created_at` が今の取引の開始時刻と同じ物だけを数える（この移行はデータを書かないので、別の取引が後で確定した行までは数えない。確かめを後から流し直しても通る）。

**適用の後の確認**: `db reset` で作った DB と本番で、次を流して通ること。
- 末尾の確かめの節（`-- G2A_FINAL_ASSERT_BEGIN`〜`END`、`-- G2B_FINAL_ASSERT_BEGIN`〜`END`）をそのまま流し直すと通る（`tests/integration/db/group_g2_migration_asserts.integration.test.ts` が、取引の中で関数を落とす・EXECUTE を変える・トリガーの名前を変える・書き手の一覧を変える、のそれぞれで項目名つきで止まることまで確かめる）。
- 書き手の閉じた一覧は65本（G-1 の56本＋新9本）で、`private.group_g_writer_allowlist()` が固定の65本と OID まで同じ。pg_proc の走査（`group_g1_writer_inventory`）は、発注書の9表を含む16表への書込みを持つ関数が、この65本の中だけにあることを見る。
- service_role が EXECUTE できる発注書の関数は、書込みの本体9本とその public 入口9本、読取の本体4本とその入口4本の26本だけ。ロック helper `lock_group_g_purchase_orders`・`group_g_actor_has_permissions`・`group_g_open_work_order_ids`・`purchase_order_display_stages` は誰にも EXECUTE を付けない。anon・authenticated・PUBLIC は全関数で持たない。
- 9つの書込み関数のそれぞれが共通の鍵 `(190521,1)` を、発注書の表・`item_variants`・`stock_movements` への最初の参照より前に取る（`group_g1_writer_inventory`）。別接続の並行は `group_g2_concurrency`（各関数が鍵だけを別接続が持つ間は行の鍵を取らず待つこと、受け取り対受け取り・入荷・入金・返金の受理・数量確定・残りの打切り・取消対入金／FIFO／棚卸減で deadlock が無く二重に動かないこと）。この試験が commit した材料（発注書・受取・注文、原本の予約・添付）は追記専用なので残り、DB 結合の他の試験は自分の発注書の id か番号に絞って確かめる（局所の DB を `db reset` しなくても、続けて何度流しても通る）。

**先絞りの索引（Task 1 の確かめ直しで残った点）**: `group_g_open_work_order_ids` の発送済みの注文ごとの合計が引く列（`order_fulfillment_lines.order_item_id`・`order_refund_lines.order_item_id`・`order_items.order_id`・`order_item_allocations.order_item_id`・`order_returns.order_id`〔`(order_id, number)` の一意制約の先頭〕・`order_refunds.order_id`・`order_cancel_requests.order_id`、結合は主キー）には、先頭の列が全行を覆う索引がすでにある。**新しい索引は足さない**（`group_g2_g1_followups` が、これらの索引が先頭の列に残っていることを確かめる）。実測（2026-10-25、手元の DB で取引の中に作って戻した材料: 注文 30,490・明細 60,511・発送の明細 60,045・返金約 6,000）: variant を絞った読み（`list_group_g_variant_inventory` の経路）は 27 ms で、発送の明細の合計・返金の明細の合計・注文の明細・注文の主キーのどれも索引走査（`order_fulfillment_lines_order_item_idx`・`order_refund_lines_item_idx`・`idx_order_items_order_id`・`order_items_variant_id_idx`・各主キー）。逐次走査になったのは件数が数十行の表（返品・取消申請）だけ。全 variant の読み（`list_admin_inventory` の経路、NULL）は 166 ms で、注文・明細・発送の明細を各1回ずつ走査する（全件を見る読みなので避けられない）が、行ごとの合計は索引走査のまま（60,511 回）。返金の表が小さい（数十行）間は計画が逐次走査を選ぶが、約 6,000 行では `order_refund_lines_item_idx` を使う。

### 本番適用の記録（2026-10-25）

| 段 | 結果 |
| --- | --- |
| 適用前の読み取り（MCP、読み取りだけ・件数だけ） | 台帳の末尾 `20261023211425`、G-2 の版・9表・置き場は無し。`role_permissions` は店長30・サポーター8（G-0／G-1 の記録と同じ）。注文0・明細0・台帳0・variant 21・在庫の合計0（G-1 の清掃の後のまま）。`storage.objects` の方針は0件。G-2 の20の名前の関数は0。anon・authenticated・service_role の役割の所属は無し。11関数は anon・authenticated・PUBLIC が EXECUTE できず service_role だけ（Task 1 の REVOKE は本番では何も変えない） |
| 置き換える関数の照合 | `admin_record_stock_movement`（public・private）・`list_group_g_variant_inventory`（public・private）・`private.guard_group_g_paid_at()` の5つの `pg_get_functiondef` の MD5 が、本番と手元で G-1 まで当てた DB（`db reset --version 20261023211425`）で全部一致 |
| ファイルの固定 | 基盤 121,715 バイト・`5248d3da2923b2476f79b6be1c42acca`、書込み 106,412 バイト・`b4813a3fb1a2c360264b02d6a441214b`。BOM・CR・全角空白・NBSP は0、トップレベルの `BEGIN;`・`COMMIT;` は各1 |
| 適用 | `supabase migration list --linked` で本番に無いのは G-2 の2本だけ、`db push --linked --dry-run` も2本だけ（seed・役割なし）を確かめ、`db push --linked --yes` で基盤・書込みの順に適用（2026-10-25 12:39 JST、パスワードの入力なし） |
| 当てた文の照合 | `20261024153505`: 文 137・`md5(array_to_string(statements, E'\n'))` `14ececdfee43e8d464349c2150d72a45`。`20261024180500`: 文 81・`e2cfbddd720d2f18a5eac48949efe1f9`。本番と手元の `db reset` の履歴で一致 |
| 適用後の形の照合（本番と手元で同じ値） | 発注書の9表（RLS・強制 RLS・anon／authenticated／service_role の表の権限）、方針9、トリガー30、public 186・private 175 の関数（定義〔CR を除く〕・`SECURITY DEFINER`・設定・3役割の EXECUTE）の指紋が全部一致（G-0／G-1 の既存の関数は置き換えた3つ以外変わらず、前回の記録の「本番だけ ACL が狭い11関数」の差も無くなった）。置き場 `purchase-order-documents` は非公開・20,971,520 バイト・PDF／JPEG／PNG。書き手の一覧 65本。`role_permissions` は店長30・サポーター8 のまま |
| 適用後の件数 | 発注書の9表・置き場の物はすべて0。注文0・台帳0・在庫の合計0（データを変える文は無い）。本番で試験の発注書は作っていない |

### 試験

DB 結合は `group_g2_stock_permissions`・`group_g2_g1_followups`・`group_g2_public_function_acl`・`group_g2_purchase_model`・`group_g2_inventory_list`（Task 3）・`group_g2_purchase_create`（Task 4）・`group_g2_purchase_reads`（Task 5）・`group_g2_purchase_quantities`（Task 6）・`group_g2_purchase_receipts`・`group_g2_purchase_receipt_reversals`（Task 7）・`group_g2_purchase_documents`（Task 8）・`group_g2_concurrency`・`group_g2_migration_asserts`（Task 9）の13本（共通の確認は `db reset` の後に PostgREST の smoke → 上の13本と、`admin_revoke_sessions_function`・`auth_db_functions`・`rate_limit_counters`・G-1 の `group_g1_stock_api`・`group_g1_inventory_reads`・`group_g1_payment`・`group_g1_exchange_fee`・`group_g1_concurrency`・`group_g1_fifo`・`group_g1_model`・`group_g1_writer_inventory`・`stock_movements`）。対応は[試験仕様](../05_Quality/tests/test-spec.md)の「グループ G-2 のテスト」。

## グループ G-3: 発送票と出荷日（FREQ-533・540、2026-10-25）

G-3 は4本を次の順で作る。Task 1 で存在するのは基盤の1本だけで、後続3本の時刻は作成時のUTCで決める。既に本番へ適用したG-1・G-2の移行は変更しない。

| 順 | ファイル | 役割・作成する Task |
| --- | --- | --- |
| 1 | `20261025053324_group_g3_shipping_foundation.sql` | 発送票の6表・出荷日の列とCHECK・変更と消費の守り・割当イベントの理由17値・発注書のある商品の削除止め。Task 1 |
| 2 | `20261025070821_group_g3_shipping_reads.sql`（Task 2 で作成、Task 8 で追記。**50,113 bytes / `DBF8F752B92F1EA97159A9968BF49608`**。ローカル DB へは controller が fresh reset して適用し、Task 8 の分を含む18 suiteで958/958成功を確認した。本番未適用） | 読取5本と入口5本、内部3本の同梱・準備数の定義。Task 2。追跡の読取側の置換（内部の助け `private.tracking_registration_owner` の追加と、`delivery_tracking_backfill_targets`・`get_order_delivery_detail`・`get_order_status_public_material` の1行ずつの置換、末尾assert `$g3b_tracking_parent$`）を同じ移行へTask 8で追記した |
| 3 | `20261025100130_group_g3_shipping_slips.sql`（Task 4 で作成済み・ローカル DB に適用済み・本番未適用） | ロック helper、下書きの保存・破棄、書き手の閉じた一覧（G-2 の65本＋この移行の書き手）。Task 4。発送確定は Task 5、発送の取消（戻しの道具とともに）は Task 6 で同じ移行へ追記済み（適用前なので追記してよい）。72本 |
| 4 | `20261025134538_group_g3_shipping_actions.sql`（Task 7 で作成・本番未適用。ローカル DB へは controller が fresh reset して適用し、19 suite・1,079/1,079成功、全件の単体と DB で18,870件成功〔別セッションの意図的な stockist_rls の赤2件だけ〕を確認した。2026-10-25） | 伝票番号の後入力・訂正、手動配達済み、許可一覧とassert（72→74本）。Task 7。Task 8 で配送の読み直しの結果（`private.record_delivery_read_result`）の置換を追記した（票の代表の結果を票の全注文へ展開。サイズ・MD5 は **72,255 bytes / `4C2AA20FBDAF43F3E4CC08B5AFA5E5CC`**。許可一覧は74本のまま）。出荷日訂正は同じ移行へ Task 9 が追記する。Task 9（Fix round 1の現行値: 81,150 bytes / MD5 3A7E207102973720BFB060B9C325F355）で出荷日訂正（private/public admin_correct_shipment_date）・理由つき履歴を追記、許可一覧74→75本とG3D最終assertを拡張。controllerが修正前のTask 9をfresh resetし、実鍵PostgRESTを含む12 suite・639/639成功（2026-10-26）。Fix round 1の後も、controllerがfresh resetし実鍵PostgRESTを含む12 suite・642/642成功 |

`20261024180500 < ts1 < ts2 < ts3 < ts4`。各ファイルは先頭 BEGIN; から末尾assert・NOTIFY pgrst, 'reload schema';・COMMIT; までを1取引で当てる。基盤は G3A_BODY_BEGIN/END と G3A_FINAL_ASSERT_BEGIN/END、後続は G3B/G3C/G3D の印で区切る。基盤は書込み口を追加せず、読取は書込みを持たない。ファイルの大きさに上限はなく、バイト数とMD5をTaskの報告へ残す。

### Task 1 の基盤と末尾の確かめ

所有者 postgres の public 5表・private 1表を作り、RLS・restrictive deny・表の権限剥奪で service_role からの SELECT も止める。票以外の5表は追記専用、票本体は7つの操作印で列・段階・版を制限する。order_fulfillments.shipment_date は非legacyで必須、運送会社と番号は両方空にできる。発送行の数と consume − restore は3か所の遅延constraint triggerで取引末尾に一致させる（内部エラー `GROUP_G_SHIPMENT_CONSUMPTION / 23514`）。

前提はG-1清掃後のorder_fulfillmentsが0行で、controllerが適用直前に再確認する。基盤移行も0行を確認し、1行でもあれば `GROUP_G_MIGRATION_ASSERTION_FAILED / 55000 / shipping_fulfillment_rows` で取引全体を巻き戻す。shipment_dateのCHECKは直接追加し、既存行の埋戻しもtriggerの停止・再開も行わない。

item_delete_blockers(bigint[]) は戻り値が5列になるので DROP → CREATE する。既存の STABLE・SECURITY DEFINER・空の search_path・postgres 所有・service_role 専用の EXECUTE を復元する。private schema の USAGE は変更しない。

末尾の `$g3a_final_objects$`・`$g3a_final_table_acl$` は次を確認する。失敗は `GROUP_G_MIGRATION_ASSERTION_FAILED / 55000`、DETAIL は項目名だけ。

| DETAIL の項目 | 確認する内容 |
| --- | --- |
| shipping_tables | 6表・列数・所有者・RLS・restrictive deny・主な制約 |
| shipping_table_acl | PUBLIC/anon/authenticated/service_role に表の権限が無く postgres は持つ（PG17以降は MAINTAIN も） |
| shipping_table_triggers | 票の変更とTRUNCATE拒否、残り5表のUPDATE/DELETE/TRUNCATE拒否の名前と種類 |
| shipping_consumption_triggers | 発送行・取消・consume/restore に付く3つの遅延constraint trigger |
| shipping_table_rows | 6表に、この取引が書いた `created_at = transaction_timestamp()` の行が無い |
| shipping_fulfillment_columns | shipment_date が date、非legacyの出荷日必須と運送会社/番号の対のCHECK |
| shipping_guard_functions | 新しい守り2本の postgres 所有・DEFINER・空のsearch_path・EXECUTEなし。置換した発送の守りは既存の INVOKER・所有者・search_path・ACL を保つ |
| shipping_reason_codes | 割当イベントの理由が既存15値＋shipment_confirm/shipment_cancelの17値 |
| shipping_delete_blockers | 削除止めの戻り値5列とACL |

ACL は relacl::text/proacl::text の文字列ではなく有効な権限の意味で比べ、別の grantee の有無に依存しない。既存データを全件0件と比べず、この取引による行の作成だけを検査するため、末尾assertを後で流し直すこともできる。

### Task 1 の試験と適用の境界

[発送票モデル](../../tests/integration/db/group_g3_model.integration.test.ts) は6表・操作印・消費の守り・理由・一意制約・削除止め・末尾assertを確認し、group_g3_fixtures の describe は既存材料が発送日のJST暦日と同じ取引の消費・取消時の復元を持って実際にcommitできることを確認する。[商品削除の守り](../../tests/integration/db/item_checkout_guards.integration.test.ts) と既存の書き手一覧の試験も対象とする。

Task 1 の実装者はSQL・試験・単体・型・lint・文書の検査までを担当する。controllerがローカルでresetしてSQLを適用し、2026-10-25のDB全件でTask 1の新規失敗0を確認した。全体は既知stockist2失敗によりexit 1。PostgRESTの共通smokeはDB suiteと別に記録する。本番へのG-3適用は未実施。


G-0の基準専用の材料では、order-fixtures.tsの非G分岐はshipment_dateを意図的に書かない（controllerのI-1裁定）。G-0にはG-3の列と遅延triggerがまだ無いため、この分岐はTask 1の一般的な材料の付け替えから除外する。G1_CLEANUP_SUITE=1によるG-1清掃suiteの再実行はcontroller判断待ち。


| Fix round 2 実装者検証（2026-10-25） | 結果 |
| --- | --- |
| DB全件 `npx.cmd jest tests/integration/db --runInBand` | exit 1。suiteは118成功・stockistの1失敗・11 skip・計130、testは3266成功・stockistの2失敗・12 skip・計3280。205.889秒。Task 1の新規失敗0 |
| レビュー修正後の対象DB6 suite | 234件成功。DB全件の既知stockist2失敗と区別する |
| G-0基準のG-1清掃suite | G1_CLEANUP_SUITE=1の特別実行はcontroller判断待ち。通常全件のskipやsuiteの成功表示は、G-0基準の清掃の成功を証明しない |

## G-3 Task 2 読取移行の適用境界

確認日: 2026-10-25。[読取移行](../../supabase/migrations/20261025070821_group_g3_shipping_reads.sql) はTask 1の後に適用する。ASCII・BOMなし・LF、BEGIN / NOTIFY / COMMITは各1組、本体と末尾assertの印はG3B。適用済みG-1/G-2とTask 1の移行は変更しない。業務データ・表権限・private schemaのUSAGEを書き換えない。

| 末尾assertのDETAIL | 確かめる内容 |
| --- | --- |
| `shipping_read_functions` | actorつき4本＋会計入力1本のprivate本体とpublic入口の10本。関数集合に余分なoverloadがない、postgres所有、STABLE、DEFINER/INVOKER、空search_path、引数名・戻り型・列名・型・順序、service_roleのみのEXECUTE、publicは同名privateへ委譲するSQLだけ |
| `shipping_internal_functions` | 準備数・同梱判定・同梱キーの3本。存在、postgres所有、STABLE DEFINER、空search_path、引数・戻り型と列、PUBLIC・anon・authenticated・service_roleのEXECUTEなし |

ACLはhas_function_privilegeとaclexplodeで意味を比較する。proaclの文字列表現、環境依存のOID値・ACL順には依存しない。この移行に表権限の変更はなく、PG17のMAINTAINを扱うTask 1の版ガードはそのまま保つ。

追跡の親（Task 8）: 同じ移行の末尾へ、読むだけの内部の助け `private.tracking_registration_owner`（だれも EXECUTE できない）と、既存の3関数の1行ずつの置換（属性・ACLは不変）、末尾assert `$g3b_tracking_parent$`（DETAIL は `tracking_parent_functions`・`tracking_parent_callers`）を足した。サイズ・MD5 は上の表のとおり（50,113 bytes）。ローカルはfresh resetの18 suiteで958/958成功（2026-10-26）、本番未適用。詳しくは[ER](../03_BasicDesign/data/er.md)の「追跡の親（代表の登録）と配送の結果の票への展開」。

Task 2当時は読取・PostgREST・書き手一覧・モデル・在庫・商品状態の6 suiteを対象にした。最新のTask 5までの対象ではcontrollerが実鍵PostgRESTを含む12 suiteで665/665成功を確認した（2026-10-25）。会計入力はactorなしのservice_role窓口で、HTTP routeは作らない。SQL修正時のローカル再適用はcontrollerが担当する。本番は未適用。

### Task 2 Fix round 1の契約（2026-10-25）

前版はローカル6 suite・191件が成功した。Opusレビュー後の修正もTask 5までローカルへ適用され、controllerが実鍵PostgRESTを含む12 suiteで665/665成功を確認した（2026-10-25）。署名・ACL・writer65本は保つ。

会計入力の`_limit`は結果を切り詰める。会計Taskは **`rows = _limit`なら、より多い行がある可能性がある** と扱い、読み切った成功や全件0件の結論に使わない。範囲を狭めるか上限を上げて、`rows < _limit`になるまで確認する。1日だけでも上限に達した場合は未完了として扱う。今回の署名は固定し、ページ引数と索引は追加しない。

荷作り表は指定票が不在なら`GROUP_G_SLIP_NOT_FOUND / P0002`、下書き以外なら共通値の`GROUP_G_SLIP_NOT_DRAFT / 55000`。どちらもactorの2権限を確認した後に判定する。詳細の住所不足・入金日時なし・注文状態・支払確認などは明細IDつきで示し、顧客/住所の不一致と期限切れは票単位。入金日時なしはpaid注文だけに付ける。準備数のMATERIALIZED集合は詳細1回につき1度計算し、linesとissuesで共用する。

同梱判定は空/NULL配列・不在ID・NULL要素を`address_incomplete`にする。重複する実在IDは同じ注文として扱い、キーは不在/NULL IDでNULL。PostgRESTの再検証には`LOCAL_SUPABASE_ANON_KEY`も必要で、未設定は理由つきskip。anonと実ユーザーJWTのclientは実anonキー、service_roleだけはserviceキーを使う。材料の票は最初から期限切れ、認証の利用者はactorと共用する1人だけとし、終了時は準備注文を閉じてsignOut・認証利用者の削除を行う。追記専用の票・注文・在庫の材料は残る。

## G-3 Task 4 発送票の書き手の移行の適用境界

確認日: 2026-10-25。[書き手の移行](../../supabase/migrations/20261025100130_group_g3_shipping_slips.sql) は Task 2 の読取移行の後に適用する。ASCII・BOMなし・LF、BEGIN / NOTIFY / COMMIT は各1組、本体と末尾assertの印は G3C。適用済みの G-1/G-2 の移行と、Task 1・2 の移行は変更しない。業務データ・表・表権限・private schema の USAGE は変更しない（表と権限は Task 1 が作った物を使う）。**本番には未適用（ローカルの reset でだけ適用）なので、後続 Task（5〜6）が同じファイルへ書き手を追記してよい。本番へ適用した後は編集しない。**

| 項目 | 値 |
| --- | --- |
| 名前 | `20261025100130_group_g3_shipping_slips.sql`（UTC 2026-10-25 10:01:30。Task 2 の `20261025070821` より後） |
| サイズ・MD5 | 41,238 bytes・`A28AFAAEBE5FA5D8095602E76AFB010D`（Fix round 1。直前: 40,253 bytes・`2440F06B8E8FF420A3401CDE507DCD7F`。Task 1: 40,477 bytes・`635ADBB776D48CBAD9AF26AF8AE5ACB3`、Task 2: 34,091 bytes・`2549F499F202525CD02A4CC460AD2B29` のまま不変） |
| 作るもの | 関数5本: 内部の押さえ `private.lock_group_g_shipment_slips(uuid[],uuid[],boolean)`（誰も EXECUTE できない）、書込み本体2本 `private.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)`・`private.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid)`（service_role だけ EXECUTE）、同名・同引数・同戻り型の public 入口2本（SQL INVOKER の委譲だけ。service_role だけ EXECUTE）。`private.group_g_writer_allowlist()` を `CREATE OR REPLACE` で G-2 の65本＋保存・破棄の2本＝67本へ置換 |
| 触らないもの | 表・列・制約・trigger・索引・sequence・既存関数（許可一覧の置換を除く）・`USAGE ON SCHEMA private` |

### 末尾の確かめ

`$g3c_final_objects$` は失敗を `GROUP_G_MIGRATION_ASSERTION_FAILED / 55000`、DETAIL は項目名だけで止める。ACL は `has_function_privilege` と `aclexplode` の意味で比べ、`proacl::text`・OID の数値・ACL 順には依存しない。この移行に表権限の変更は無いので MAINTAIN の版ガードも要らない（Task 1 のガードはそのまま）。

| DETAIL | 確かめる内容 |
| --- | --- |
| `shipment_slip_functions` | 5本の存在、postgres 所有、VOLATILE、DEFINER/INVOKER、言語、戻り型、引数名、空の search_path、anon・authenticated・PUBLIC の EXECUTE なし、service_role の EXECUTE は書込み本体2本と入口2本だけ（押さえの道具は誰にも付けない） |
| `shipment_slip_lock_order` | 押さえの道具の本文が `BEGIN` の直後に `PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);` で始まり、続いて設定の `FOR SHARE` → `lock_group_g_inventory(` → 票の行の `FOR UPDATE`（`public.shipment_slips` を指す）→ 追跡の登録の行（`private.fulfillment_tracking_registrations`）の `FOR UPDATE` の順（大文字小文字・空白の違いを問わない。票の行より先に登録の行を取る、在庫の閉包より先に票の行を取る改変を止める）。書込み本体2本が `lock_group_g_shipment_slips(` を呼び、その呼び出しより前の本文に、表の参照（`from`・`join`・`into`・`update`・`table` の後ろに、`only` を挟んでもよい `public.` か `private.`）も、`public.` か `private.` の関数の呼び出し（例: 権限の確かめ `group_g_actor_has_permissions(` を押さえの前へ移す改変）も無い（小文字化して見るので大文字・空白の数・引用符つきのスキーマ名の書き方でもすり抜けない） |
| `shipment_slip_writer_allowlist_missing` | 固定の67本がすべて関数に解決でき、重複せず、`group_g_writer_allowlist()` の本数も67 |
| `shipment_slip_writer_allowlist` | 許可一覧の関数の OID の集合が、固定の一覧の OID の集合と同じ |
| `shipment_slip_function_set` | public と private にある同名（押さえの道具・保存・破棄）の関数が、上の5本ちょうど（余分な overload と欠けを見つける） |

### 書き手の許可一覧が65本を超えた最初の Task のための直し

G-2 の末尾の確かめ（`$g2b_final_objects$`）は「適用した時点の65本」を固定で持つ。実DBで流す2つの suite（`group_g2_migration_asserts`・`group_g2_purchase_documents`）は、流す前に取引の中の一覧を共有の道具 [group-g-allowlist](../../tests/integration/db/helpers/group-g-allowlist.ts) の `runWithAllowlist(client, G2_ALLOWLIST, 節)` で G-2 の65本へ入れ替える（`G2_ALLOWLIST` は G2B 移行の `v_writers` の配列から読み取って固定する。戻すのは各試験の rollback）。今の DB の一覧のままでは G2B の確かめが `purchase_writer_allowlist_missing` で止まることも試験する。「今の DB の本数」を見る試験（`group_g1_writer_inventory`・`group_g2_purchase_documents`・`group_g2_purchase_quantities`・`group_g2_purchase_receipts`）は G-3 の現在の本数（67）に合わせた。`G3C_ALLOWLIST` は G-2 の65本＋この移行に**存在する**書き手だけで、Task 5 で確定の3本、Task 6 で2本と増える（まだ無い関数の署名は `::regprocedure` に通さない）。G3C の末尾の確かめを `G3C_ALLOWLIST` で流し直すのは Task 10。

### 試験と適用の境界

[発送票の下書き](../../tests/integration/db/group_g3_draft.integration.test.ts) は 作成・入れ替え・再送・同梱・優先順・数量・権限・原子性（故障注入）・破棄・期限切れ・構造・末尾の確かめの改変を確認する。[書き手の閉じた一覧](../../tests/integration/db/group_g1_writer_inventory.integration.test.ts)は67本と新しい関数の構造（押さえの道具の最初の文、書込み本体が表を読む前に押さえを呼ぶ順）を確認する。[実 PostgREST](../../tests/integration/db/group_g3_postgrest_paths.integration.test.ts)の保存・破棄の経路は、鍵を持つ controller が流す。

Task 4では実装者が SQL・試験・単体・型・lint・文書を検査し、controllerのローカル適用後に下書き・書き手一覧・G-2末尾assert・モデル・読取・並行性を検査する手順を定めた。Task 5までの最新の対象と実測結果は下記に記す。SQLを直した時の再適用はcontrollerが担当し、本番への適用は未実施。

Fix round 1（Opus レビュー後、2026-10-25）は末尾の確かめ `shipment_slip_lock_order` の強化だけで SQL の本体（押さえの道具・保存・破棄・入口・許可一覧）は変えていない。強化した確かめを実DBの関数に当て直す試験（`group_g3_draft` の末尾の確かめの改変）に、`group_g_actor_has_permissions(` を押さえの前へ移す（保存・破棄）・`FROM ONLY`・`TABLE` で表を読む・押さえの道具が登録の行を票の行より先に取る・票の行を在庫の閉包より先に取る、の5つの改変を足した（既存の改変は残す）。連番の枯渇（`SL-<日本時間の日付>-9999` があると `GROUP_G_SLIP_NUMBER_EXHAUSTED / 55000`）の試験も足した。これらの下書きの末尾assert改変も、Task 5までの実鍵PostgRESTを含むcontrollerの12 suite・665/665成功に含まれる。
## G-3 Task 5 発送確定の追記（ローカル実測済み）

本番未適用の [20261025100130_group_g3_shipping_slips.sql](../../supabase/migrations/20261025100130_group_g3_shipping_slips.sql) に、consume・追跡の親・確定のprivate本体とpublic確定入口を追記した。新規移行は作らず、G-1/G-2とTask 1/2の移行は変更しない。許可一覧とG3C末尾assertは67→70本へ更新した。

確定の順・在庫とoutbox・出荷日の契約は[発送順序図](../04_DetailDesign/sequence/shipping.md)と[ER](../03_BasicDesign/data/er.md)を参照。[確定DB suite](../../tests/integration/db/group_g3_confirm.integration.test.ts)と下書き・書き手一覧・G-2末尾assert等をローカルで検査し、controllerが実鍵PostgRESTを含む12 suiteで665/665成功を確認した（2026-10-25）。レビュー後の数量変数名の整理はcontrollerが再適用し、同じ範囲を再検証する。実PostgRESTはcontrollerの鍵で実行する。本番適用・外部追跡・メール送信・E2Eの証拠にはしない。

## G-3 Task 6 発送の取消の追記（ローカル実測済み）

確認日: 2026-10-25。本番未適用の [20261025100130_group_g3_shipping_slips.sql](../../supabase/migrations/20261025100130_group_g3_shipping_slips.sql) に、戻しの内部の道具 `private.restore_group_g_shipment(uuid,uuid,uuid,uuid,text)` と、取消のprivate本体 `private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)` とpublic入口（同名・同引数・SQL INVOKER）を追記した。**新規移行は作らず**、G-1/G-2とTask 1/2の移行は変更しない。表・列・制約・triggerは変えない。サイズ・MD5は **80,003 bytes / `4B45CBBE48D9A645A60F49042563C8A8`**（controllerがresetして適用した版は79,708 bytes / `9842FF3C9030F98F5B74C1CEBCFF7ED9`。その後のレビュー対応は関数の外のコメントだけで、関数の本文・ACL・assertは同一。直前のTask 5は62,630 bytes / `B984C9560FF6D62CE0DC6F7947B7B62C`）。ASCIIのみ・BOM/CRなし（台帳の備考の日本語は `U&'\767A…'` のUnicodeエスケープで書き、適用の途中で字が変わる事故を避ける）、BEGIN/NOTIFY/COMMITとG3Cの節印は各1組のまま。

| 項目 | 内容 |
| --- | --- |
| 書き手の閉じた一覧 | 70本へ `restore_group_g_shipment`・`admin_cancel_shipment_slip` の2本を足した**72本**（`private.group_g_writer_allowlist()` の置換）。`G3C_ALLOWLIST`・`group_g1_writer_inventory`・`group_g3_draft`・`group_g3_confirm` の本数を72へ更新 |
| 末尾のassert（G3C） | 関数の集合を9→12本（restore と cancel の private・public）、書き手の集合を70→72本、押さえ前の参照の検査対象へ取消を追加（保存・破棄・確定・取消の4本）。EXECUTEは取消の本体と入口だけがservice_role、restoreは誰も不可 |
| 在庫 | 取消はFを動かさない（restock +n と purchase −n）。手元（F+A+H）が消費した数だけ戻る。元の割当は更新しない |
| 書込みの順 | 発送ごとに、取消の印 → 追跡登録 cancelled・要対応 auto → restore → 注文 paid → 未送信メール skipped。割当の上限は遅延の確かめ（commit の時）だが、途中の状態も上限を超えないよう発送の取消を先にする。詳しくは[発送の取消](../04_DetailDesign/sequence/shipping.md) |

実装者は本番・Docker・supabase CLI・db resetを使わず、DBへは接続して**取引の中で新しい節を当てて必ず戻す**形（実関数の置換・コミットなし）で先に確認した。その後controllerがresetして適用し、[発送の取消](../../tests/integration/db/group_g3_cancel.integration.test.ts)（別接続の試験を含む）・確定・下書き・書き手の閉じた一覧・G-2末尾assert（`group_g2_migration_asserts`・`group_g2_purchase_documents`）・`group_g3_model`・`group_g3_reads`・`group_g1_refund_cancel`・`group_g1_return_exchange`・`group_g2_purchase_receipt_reversals`・`order_return_*`・`order_refund_*` と、鍵を持つcontrollerが流した実鍵PostgRESTの[経路の試験](../../tests/integration/db/group_g3_postgrest_paths.integration.test.ts)を含む**21 suiteで1,287/1,287成功**、全件の単体とDBで**18,318件成功**（別セッションの意図的なstockist_rlsの赤2件だけ）、G-0 cleanup 12/12を確認した（2026-10-25）。本番適用・実メール・外への停止・E2Eの証拠にはしない。

## G-3 Task 7 伝票番号の後入力・訂正と手動の配達済み（第4の移行）

確認日: 2026-10-25。第4の移行 [20261025134538_group_g3_shipping_actions.sql](../../supabase/migrations/20261025134538_group_g3_shipping_actions.sql) を作った（`migration new` の代わりに実装時の UTC で手で作成）。別セッションの認証の移行は `20261026010000_auth_return_intents.sql` に改名され、G-3 の4本より後に並ぶ（適用の順も全部の G-3 の移行の後）。**本番未適用**。G-1/G-2と先の3本（foundation・reads・slips）は変更しない。表・列・制約・triggerは変えない。サイズ・MD5は **43,652 bytes / `36D5544C71FC56D0CBA2DD294863BEA7`**（ASCIIのみ・BOM/CRなし・全角空白/NBSP/ゼロ幅文字なし・BEGIN/NOTIFY/COMMITとG3Dの節印は各1組）。

| 項目 | 内容 |
| --- | --- |
| 追加する関数 | `private.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid)`・`private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)` とそれぞれの `public` 入口（同名・同引数・SQL INVOKER）。DEFINER・`search_path=''`・所有者postgres・PUBLIC/anon/authenticatedを個別REVOKE、service_roleだけがEXECUTE。`USAGE ON SCHEMA private` は操作しない |
| 書き手の閉じた一覧 | 72本へ上の2本の private 本体を足した**74本**（`private.group_g_writer_allowlist()` を `CREATE OR REPLACE`）。共有の試験の道具 `G3D_ALLOWLIST`（74本）を足し、今のDBの本数を固定する試験（`group_g1_writer_inventory`・`group_g2_migration_asserts`・`group_g2_purchase_documents`・`group_g2_purchase_quantities`・`group_g2_purchase_receipts`・`group_g3_confirm`・`group_g3_cancel`）は 74 へ、G3C の末尾assertを今のDBで流す `group_g3_draft` は流す前に取引の中の一覧を `G3C_ALLOWLIST`（72本）へ入れ替える |
| 末尾のassert（G3D） | 4関数の所有者・SECURITY・言語・戻り型・引数名・search_path・EXECUTE（実効ACLの意味。PUBLICを含む）、4関数の集合（同名の余分な overload と欠け）、書込み本体2本の押さえ前の参照（表の参照と public/private 関数呼出しを置けない）、書き手74本のOID照合。違えば `GROUP_G_MIGRATION_ASSERTION_FAILED`／55000（DETAIL は `shipment_slip_action_functions`・`shipment_slip_action_lock_order`・`shipment_slip_action_writer_allowlist(_missing)`・`shipment_slip_action_function_set`） |
| 旧4RPC | `admin_create_fulfillment`・`admin_cancel_fulfillment`・`admin_update_fulfillment_tracking`・`admin_mark_fulfillment_delivered` は `LEGACY_FULFILLMENT_DISABLED`／55000 のまま（変更なし）。旧の発送ごとの窓口の呼び出し・store の停止の道具だけを整理した |

適用と確認: ローカルは controller が `db reset` してから共通の確かめ（匿名と実 authenticated の `GET /rest/v1/items?select=id&limit=0` が各 HTTP 200）→ [伝票番号・配達済み](../../tests/integration/db/group_g3_tracking.integration.test.ts)・書き手の閉じた一覧・下書き・確定・取消・G-2 の末尾の確かめ・`group_g3_model`・`group_g3_reads`・配送（`group_g1_delivery*`・`delivery_tracking_*`）・メール（`order_email_*`）を `--runInBand` で流す。実鍵 PostgREST の [経路の試験](../../tests/integration/db/group_g3_postgrest_paths.integration.test.ts)（伝票番号・配達済みの実 store 経路と、anon・authenticated の拒否）は鍵を持つ controller が流す。実測: controller が fresh reset して流し、鍵つきの PostgREST を含む19 suiteで1,079/1,079成功、全件の単体と DB で18,870件成功（別セッションの意図的な stockist_rls の赤2件だけ）、G-0 cleanup 12/12（2026-10-25）。レビュー後の小さな直し（SQL は不変）は実装者が `group_g3_tracking` をローカル DB で流して確認した。本番適用・実メール・外への登録・E2Eの証拠にはしない。

追跡の親（Task 8）: 同じ移行へ `private.record_delivery_read_result` の置換を追記した（票の代表の読み直しの結果を、表ごとに票の全注文の行を固定して全注文へ展開する。登録・要対応・戻り値は代表について1回。許可一覧は74本のまま、属性・ACLは不変、末尾assertに `shipment_slip_read_result_function`・`shipment_slip_read_result_body` を足した）。サイズ・MD5 は現在 **72,255 bytes / `4C2AA20FBDAF43F3E4CC08B5AFA5E5CC`**（上の43,652 bytes はTask 7時点）。ローカルはfresh resetの18 suiteで958/958成功（`group_g3_tracking_parent`・実鍵PostgREST・`group_g1_delivery*`・`delivery_tracking_*`・`order_status_links*`・`group_g1_concurrency`・書き手の閉じた一覧・G-2末尾assertを含む。2026-10-26）、本番未適用。

## 確定後の出荷日の訂正（G-3 Task 9）

確認日: 2026-10-26。第4移行actionsだけを追記した。Fix round 1の現在は81,150 bytes、MD5 3A7E207102973720BFB060B9C325F355。Task 7/8の上記サイズは各時点の記録。新関数をregprocedureの許可一覧より前に定義し、private本体はpostgres所有・DEFINER・空search_path、public入口は同signatureのSQL INVOKER、service_roleだけEXECUTE。新しい書き手1本で74→75本。G3D最終assertは新関数の属性・ACL・集合・lock前参照と75本のOIDを照合する。先の3本と適用済みのG-1/G-2/E-4、認証の移行は変更しない。

引数検証→lock(false)→訂正3権限→指紋と再送→票存在→段階→版→同日→JST範囲→配達日→票と有効発送の日付→correction履歴→date_correction版→操作。途中失敗は全てrollback、操作印は復元する。shipped_at・confirmed_at・delivered_at、返品期限、メール、品物状態、割当、在庫、追跡は不変。controllerが修正前のTask 9をfresh resetし、実鍵PostgRESTを含む12 suite・639/639成功（2026-10-26）。Fix round 1の後も、controllerがfresh resetし実鍵PostgRESTを含む12 suite・642/642成功（2026-10-26）。実装者はDB・supabase CLI・Docker・Playwrightを実行していない。本番未適用。

Fix round 1: Task 8のactions移行は72,255 bytes / MD5 4C2AA20FBDAF43F3E4CC08B5AFA5E5CCとして記録を復元した。Task 9初回は80,411 bytes / MD5 09B757157099A8222B7818EEBCFA8217で、上の現行値と区別する。理由のtrim集合をJavaScriptと一致させ、発送更新直後に操作印を復元するSQL差分を加えた。修正前の639/639を新SQLの適用証明には使わない。

## G-3 Task 10 書き手75本・並行試験・最終assert

確認日: 2026-10-26。以下が4ファイルの現行値。上のTask別サイズと実測は過去の記録であり、Task 10の適用証明ではない。2026-10-26 08:33 JST に本番へ適用した（下の「本番適用の記録」）。変更は末尾assertだけで、4本のBODY節はHEAD `6ccbd9b0` とバイト一致する。末尾assertのDETAIL名はTask 10で `shipping_*` に統一した。上のTask 1〜9の節に残る `shipment_slip_*`・`tracking_parent_*` などの名は当時のもので、現行は下の表。

| 順 | ファイル | bytes | MD5 |
| --- | --- | --- | --- |
| 1 | `20261025053324_group_g3_shipping_foundation.sql` | 40,844 | `C7852621860190E1D2F52DEB4EC3F91A` |
| 2 | `20261025070821_group_g3_shipping_reads.sql` | 50,712 | `556CF25E8895A6CBA47029AB301E647D` |
| 3 | `20261025100130_group_g3_shipping_slips.sql` | 82,615 | `0D6E89EBAD5026B4AF110870B1E35A30` |
| 4 | `20261025134538_group_g3_shipping_actions.sql` | 84,383 | `7A448D97181B4D2587EEA32ED5C1A7C7` |

全て150 KB以下。BOM・CR・全角空白・NBSP・ゼロ幅文字なし、BEGIN／末尾assert／NOTIFY／COMMITは1組。関数本体の外にINSERT・UPDATE・DELETE・TRUNCATEを置かず、private schemaのUSAGEは操作しない。

| 節 | 最終DETAIL・内容 |
| --- | --- |
| G3A | `shipping_tables`・`shipping_table_triggers`・`shipping_consumption_triggers`・`shipping_table_rows`・`shipping_fulfillment_columns`・`shipping_guard_functions`・`shipping_reason_codes`・`shipping_delete_blockers`・`shipping_table_acl`。6表、遅延検査、CHECK、削除止め5列と意味で比べるACL。行検査はこの取引の `created_at = transaction_timestamp()` だけ |
| G3B | `shipping_read_functions`・`shipping_internal_functions`・`shipping_replaced_readers`。読取5本と入口5本、内部4本、既存読取3本の置換。追跡の親の検査は既存の `$g3b_tracking_parent$` 節を保ち、DETAILを統一 |
| G3C | `shipping_slip_functions`・`shipping_slip_lock_order`・`shipping_slip_allowlist`・`shipping_slip_function_set`・`shipping_slip_table_acl`。12関数、共通advisory→設定→在庫閉包→票→登録、固定72本のOID集合、余分なoverloadなし、新6表のACL |
| G3D | `shipping_action_functions`・`shipping_action_allowlist`・`shipping_action_function_set`・`shipping_action_replaced`・`shipping_action_table_acl`。本体3本と入口3本、配送結果の置換の戻り型を含む属性、固定75本のOID集合、新6表のACL |

失敗は全て `GROUP_G_MIGRATION_ASSERTION_FAILED / 55000`、DETAILは項目名だけ。表・列ACLは `has_table_privilege`・`has_any_column_privilege`・`aclexplode` で比べ、所有者のACLからの権限欠落も調べる。PG17以降だけMAINTAINを検査する。ACLの並びや環境固有のOID値には依存しない。

閉集合はG-2の65本＋G-3の10本＝75本。service_roleがEXECUTEできるG-3の新関数は、書込み7本と入口7本・読取5本と入口5本の24本だけ。内部の道具・守りの関数は誰にも付けず、PUBLIC／anon／authenticatedは全て拒否する。過去の末尾assertを流す試験は、[共有helper](../../tests/integration/db/helpers/group-g-allowlist.ts) の `runWithAllowlist` で、G3Cは72本・G2Bは65本へ取引内だけ差し替え、SAVEPOINTへのROLLBACKで75本へ戻ることも確認する。

### 適用前の読取と適用順

本番でG-3を初めて適用する前に、次の名前の重なりを読取りだけで数える。新関数なので全行の `matches = 0` が期待値。置換対象の既存6関数はこの一覧に含めない。1件でもあればoverloadを含む署名を調べ、意図しない関数の上書きを避ける。

```sql
WITH names(name) AS (VALUES
  ('guard_group_g_shipment_slip_change'),('check_group_g_shipment_consumption'),
  ('group_g_shipment_ready'),('group_g_bundle_verdict'),('group_g_bundle_key'),('tracking_registration_owner'),
  ('list_admin_packing'),('list_admin_shipment_slips'),('get_admin_shipment_slip'),
  ('list_admin_order_shipment_slips'),('list_shipment_accounting_inputs'),('lock_group_g_shipment_slips'),
  ('admin_save_shipment_slip_draft'),('admin_discard_shipment_slip_draft'),('consume_group_g_allocations'),
  ('register_group_g_slip_tracking'),('admin_confirm_shipment_slip'),('restore_group_g_shipment'),
  ('admin_cancel_shipment_slip'),('admin_update_shipment_slip_tracking'),
  ('admin_mark_shipment_slip_delivered'),('admin_correct_shipment_date')
)
SELECT names.name, count(p.oid) AS matches
FROM names LEFT JOIN pg_catalog.pg_proc p ON p.proname = names.name
  AND p.pronamespace IN (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname IN ('public','private'))
GROUP BY names.name ORDER BY names.name;
```

順序は `20261024180500 < 20261025053324 < 20261025070821 < 20261025100130 < 20261025134538`。適用前にサイズ・MD5・基盤の発送0行前提・移行履歴を再確認し、本番担当者が `npx.cmd supabase db push --linked` を実行する。各ファイルのassertが失敗すれば、そのファイル全体がROLLBACKされる。別セッションの後続移行をG-3の検証前提にしない。

### controllerのローカル検証

controllerがresetとanon／実authenticatedのPostgREST smoke（各200）を完了してから、[並行](../../tests/integration/db/group_g3_concurrency.integration.test.ts)・[最終assert](../../tests/integration/db/group_g3_migration_asserts.integration.test.ts)・G-1 writer inventory・G-2 migration asserts／purchase documentsを `--runInBand` で実行する。並行suiteは3回連続で成功を記録し、その後PostgREST以外の `group_g3_*`・`group_g2_*`・`group_g1_*` 全suiteを流す。SQL修正が必要なら再reset待ちへ戻る。

実測（2026-10-26）: controllerのfresh reset（上のSQL）で、実鍵PostgRESTを含むgroup_g* 47 suiteは初回1,492通過・4失敗。4件は試験材料の誤りで、SQLは変えていない。(1) 重なる2つの下書き: 全数を発送済みにした注文は先に `GROUP_G_SLIP_ORDER_NOT_SHIPPABLE` で断られるため、4個中3個ずつの選択に直し、負けた側が `GROUP_G_SLIP_QUANTITY_EXCEEDS_READY` になるようにした。(2) 取消と返品作成（2順）: 返送先の設定が空で `RETURN_ADDRESS_REQUIRED` だったため、返送先・理由設定を返品を作る接続の取引の中だけで設定し、RPCの直後に同じ取引の中で元へ戻す（設定は何もコミットしない。Fix round 1で、最初のコミットして`afterEach`で戻す形から直した）。(3) 「この取引で書いた行だけが失敗する」: 試験の行に必須の `stage` が無かった。修正後は `group_g3_concurrency` 24/24を3回連続、`group_g3_migration_asserts` 64/64が通過し、設定の復元（返送先・追跡の設定）も確かめた。

Task 10 Fix round 1（2026-10-26、レビューの指摘対応）: 変えた移行はactionsだけで、末尾assertの節の中に限る（本体の節はHEAD `6ccbd9b0` とバイト一致）。(1) 末尾assertの注釈を実際の6関数・書込み本体3本・75本に合わせた。(2) 置き換えた `record_delivery_read_result` の本体の確かめを小文字化して読み、`FOR UPDATE`・`FOR SHARE` が本体に無ければ失敗とし（飛ばさない）、最初のそれが共通の押さえの前にあっても失敗にする。ほかに試験では、書込み範囲の走査が `UPDATE <表> <別名> SET`・`UPDATE ONLY`・`MERGE INTO` も見つけ、返品作成の設定は取引の中だけ、確定の後の棚卸減（消費済みの割当を外さない）の並行を足し、`delivery_tracking_records` の「最初は追跡オフ」の読取は自分の発送・注文に絞った。サイズ・MD5は上の表のとおり（actionsは84,383 bytes）。この後のDBは、controllerのreset後に再実測する（assertの節だけをローカルDBで流した限りでは通過）。

[実PostgREST経路](../../tests/integration/db/group_g3_postgrest_paths.integration.test.ts) は `LOCAL_SUPABASE_URL`・`LOCAL_SUPABASE_SERVICE_ROLE_KEY`・`LOCAL_SUPABASE_ANON_KEY` を環境から渡すcontrollerが実行する。未設定なら理由付きskip。公開RPC12本を実store→supabase-js→PostgREST→SQLで通し、anon／実authenticatedは拒否する。エラー表28行を実材料で発生させ、storeの状態コード・固定本文も検査する。単体・静的試験の成功はDB・PostgREST・外部登録・実メール・本番の証明にはしない。

### 本番適用の記録（2026-10-26）

| 段 | 結果 |
| --- | --- |
| 適用前の読み取り（MCP、読み取りだけ・件数だけ） | 台帳の末尾 `20261024180500`（G-2）。G-3 の4版と別セッションの `20261026010000` は無し。G-3 の6表・`order_fulfillments.shipment_date` の列は無し。`order_fulfillments` は全体0・`legacy` でない行0（新しい CHECK に当たる行が無い）。`role_permissions` は店長30・サポーター8、書き手の一覧65本（G-2 のまま）。注文0・明細0・台帳0・variant 21・在庫の合計0（G-2 の記録と同じ） |
| 置き換える関数の照合 | `item_delete_blockers`・`restrict_fulfillment_record_update`・`delivery_tracking_backfill_targets`・`get_order_delivery_detail`・`get_order_status_public_material`・`record_delivery_read_result`・`group_g_writer_allowlist` の7つの `pg_get_functiondef` と、制約 `order_fulfillments_tracking_check`・`order_item_allocation_events_reason_check` の定義の MD5 が、本番と手元で G-2 まで当てた DB（`db reset --version 20261024180500`）で9つとも一致 |
| ファイルの固定 | 上の表の4本（40,844／50,712／82,615／84,383 バイト、MD5 は表のとおり）。BOM・CR・全角空白・NBSP・ゼロ幅文字・非 ASCII は0、`BEGIN;`・`COMMIT;` は各1。本体は HEAD から変えていない |
| 別セッションの移行 | `db push --linked --dry-run` が別セッションの `20261026010000_auth_return_intents.sql` も示したため、オーナーの決定（G-3 の4本だけを当てる）で、適用の間だけそのファイルをリポジトリの外へ移し、適用の後に同じ中身で戻した（SHA256 と git の blob `a91d8a3` が一致、`git diff` の差なし）。別セッションには前後で知らせた。本番に別セッションの移行は入っていない |
| 適用 | `db push --linked --dry-run` が G-3 の4本だけをこの順で示すことを確かめ（seed・役割なし）、`db push --linked --yes` で基盤・読取・票・操作の順に適用（2026-10-26 08:33 JST、パスワードの入力なし） |
| 当てた文の照合 | `20261025053324`: 文 71・`md5(array_to_string(statements, E'\n'))` `ca4164428adabd1d850063a308adadfb`。`20261025070821`: 文 60・`cc393b1065d9579c9bcdf615f16edffe`。`20261025100130`: 文 50・`b9866f41de2c69d3bbea5ae355771c43`。`20261025134538`: 文 31・`e25bc6b68302a3fac4515a58b73684d9`。本番と手元の `db reset` の履歴で一致 |
| 適用後の形の照合（本番と手元で同じ値） | G-3 の6表と `order_fulfillments`・`order_fulfillment_lines` の8表（RLS・強制 RLS・3役割の表の権限）、列の型と NOT NULL、制約75（遅延の有無と定義）、public・private の方針186、トリガー158（有効・関数・遅延）、public 198・private 197 の関数（定義〔CR を除く〕・`SECURITY DEFINER`・設定・3役割の EXECUTE。手元にだけある別セッションの2関数は除く）の指紋が全部一致。置き換えた9つの定義の MD5 も手元の最新と一致。書き手の一覧75本。`role_permissions` は店長30・サポーター8 のまま |
| 適用後の件数 | G-3 の6表はすべて0行。データを変える文は無い。本番で試験の票は作っていない |


## グループ H Task 1: 割引の記録基盤（手元で確認済み・本番未適用）

controller の実測（2026-10-29、手元の Supabase を reset）: H の結合試験 group_h_foundation・group_h_migration_asserts と role_permissions・order_return_receipts・order_items_variant が 140/140。単体＋DB 結合の全件 21,184 通過・0 失敗、G-0 版からの清掃 12/12。本番への適用は H の最後にオーナーへ尋ねる。

確認日: 2026-10-29。[20261029130000_group_h_discounts_foundation.sql](../../supabase/migrations/20261029130000_group_h_discounts_foundation.sql)（65,616 bytes、MD5 `44865ba525e083311c977b1b270e9f6a`、UTF-8/BOMなし/LF/ASCII。fix round 2後）。本番未適用。controllerのfix round 1後のfresh reset・全体実行は21,167件通過と既存baselineに対する新規3失敗を報告した。fix round 2でUIの件数、行別読取のINVOKER、無関係な明細更新の遅延イベントを修正し、最終SQLでのcontroller再実行待ち。実装者はDB試験・reset・Supabase CLIを実行していない。採番はcontroller指定で、Hの予約範囲20261029130000〜20261029135959に入り、波5の20261029120100より後に並ぶ。

7表とcheckout_draftsの4欄を追加し、既存draftへ補完しない。private.order_line_discounts(uuid)は保存allocationがある注文ではその合計、ない注文では従来の累積丸めを返す。交換行は0。controller裁定でSTABLE/INVOKER・空search_pathを保ち、service_roleにも直接EXECUTEを与えない。表の直接権限はservice_roleからも外す。内部helperはpostgres所有・DEFINER・空search_pathで、service_roleにもEXECUTEを与えない。既存order_itemsへのH triggerは関係4列とH着別金額のある注文だけに絞る。H設定のtriggerは会員FKのSET NULLでは起動しない。明示索引は15本。

SQL/TSの目録は32件。H1の既存表DMLはpermissionsの2行登録、adminだけへの2件付与、adminのpermissions_version+1だけ。移行前の一時baselineにH以外のpermission行・全付与・全役割の版を控え、末尾assertで差分を検査する。既にHの登録/付与がある場合は停止し、削除や再投入で合わせない。

末尾assertは `GROUP_H_MIGRATION_ASSERTION_FAILED / P0001`。DETAILは `h1_tables`・`h1_draft_columns`・`h1_constraints`・`h1_rls_acl`・`h1_immutable`・`h1_line_reader`・`h1_permission_catalogs`・`h1_permission_seed`・`h1_existing_dml_allowlist`。独立した一時表で期待するCHECK/FK/列をPostgresに解析させ、実カタログとの比較で確認する。期待FKの参照先も一時表を使い、schema/表/列名へ正規化して比較する。triggerの対象列とWHEN/参照helperも検査し、関数本文のMD5はCRを除いて計算する。

実装者の静的確認はTypeScript/対象ESLint15ファイルがexit 0、RolePermissionsSectionを含む指定Jestが10 suites・313 tests通過（fix round 2後）。修正後のDB・末尾assert・会員削除・既存items読取/RLS回帰とFR-ADMIN-109 E2Eはcontrollerが実測する。Graphify更新も共通制約どおりcontrollerが最終コード変更後・commit前に1回行う。[実装レポート](../../.superpowers/sdd/2026-10-29-group-h-promotions/task-1-report.md)に対象ファイルと未検証境界を記す。

## グループ H Task 3: 管理・資格・割り当て表（controllerのDB確認待ち）

確認日: 2026-10-29。[20261029130100_group_h_discounts_admin.sql](../../supabase/migrations/20261029130100_group_h_discounts_admin.sql) は86,176 bytes、MD5 `a129e4f78e6be0ab774f341124ed54ab`（Task 5 fix round 1 で詳細の読取にコードの一覧を足し、作成の検査を直した。その前の Task 4 fix round 1。`get_admin_discount` の rowId を最初の利用の reserved_at→id から作り、`admin_generate_discount_codes` は接頭辞が既存のどのコードとも同じなら CODE_CONFLICT にした。この2関数の本文MD5と末尾の assert の値は controller が再計算する）、UTF-8/BOMなし/LF/ASCII。Hの予約範囲内でH1の直後、他セッションの20261029140000以後の移行より前に並ぶ。本番未適用。H1の本文は変更していない。

private本体26・public入口13を追加する。全publicはSQL/INVOKER・service_roleだけEXECUTE、privateはpostgres所有/DEFINER/空search_path。全adminは最後の_actor_idからGの役割権限helperでread/manageを別々に検査し、JWT/aal/sessionを読まない。内部helperはservice_roleからも直接呼べない。書込はG共通→H目録→必要な本人→割引id昇順で直列化し、要求キーはH1のcreation列/admin_requestsへ保存する。新しい業務operation表を作らない。

自動25件・片側でも併用ONの自動各分類６件・併用ONセットの共有item禁止を、未来を含む半開区間で検査する。writerと遅延constraint triggerの両方で守り、SQL/TSの上限一致を試験に固定する。使用後は取消済みも固定対象。注意はservice専用記録・同じ未解決10分窓１回、readで表示、manageの版付きupdateで閉じる。

７表を維持し、discount_assignments.original_user_idを共有退会割当の使用照合用に固定する。discount_codes.unassigned_atは未使用単発割当の解除を表し、退会と区別してcontext/一覧から外す。移行時のDMLは新規H表の補助列補完だけ。顧客名・メール・検索語を監査/eventへ入れない。束の文字は制限された再送結果に保持するが、監査へ転記しない。

末尾assertの失敗は `GROUP_H_MIGRATION_ASSERTION_FAILED / P0001`。DETAILは `h2_functions`・`h2_public_acl`・`h2_permission_checks`・`h2_admin_requests`・`h2_code_unique`・`h2_automatic_lock`・`h2_stackable_cap`・`h2_set_items_disjoint`・`h2_search_attention`・`h2_reads_stable`。関数/ACL/本文指紋/余分なoverload/列/一意/triggerの属性を検査する。H1のassertはsavepoint内でH2追加列だけを一時的に外して当時の形を検査し、rollbackで戻す。

実装者のTypeScript・対象５ファイルESLintはexit 0。DBのRED/GREENは実測していない。controllerは未実装DBのRED、最終SQLでのfresh reset、既存itemsのanon/authenticated smoke各200、H管理/context/並行とH1/共通assert・G-0回帰、全13 public入口の実PostgREST（service成功、anon/authenticated拒否）を実施する。並行はpg_blocking_pids/pg_locksで待ちを観測して３連続。実受付との解除競合と現在の注文を除いた予約再検査はTask 7。Graphify updateはcontrollerが最終変更後・commit前に１回、commit後hook確認もcontrollerが担当する。[Task 3レポート](../../.superpowers/sdd/2026-10-29-group-h-promotions/task-3-report.md)に署名・鍵・エラー・各テストと懸念を記す。

## グループH Task 6: checkout割引固定（controllerのDB確認待ち）

確認日2026-10-29。移行は[20261029130200_group_h_discounts_checkout.sql](../../supabase/migrations/20261029130200_group_h_discounts_checkout.sql)。サイズ 34,677 bytes、MD5 `11d59bfef03fbadb26ad5b4bc98b4827`（末尾 assert の関数7本の本文の指紋は controller が手元の DB で計算して埋めた）。UTF-8/BOMなし/LF/ASCII、BEGIN→H3末尾assert→NOTIFY→COMMIT。既存行への補完/清掃は無い。H1/H2は変更しない。

private本体７（整数検査/canonical JSON/hash/全固定検査/不変trigger/claim/coupon結付け）、public入口２。postgres所有、private DEFINER、public INVOKER、空search_path。入口と対応privateだけservice_roleへEXECUTEを与え、内部helperはservice_roleからもREVOKE。createdかつversion1のdiscount_amount=0とcoupon整合のCHECK、固定済み写しの変更禁止triggerを追加する。

H3_FINAL_ASSERTのDETAILはh3_draft_freeze・h3_coupon_binding・h3_public_acl・h3_amount_checks。失敗はGROUP_H_MIGRATION_ASSERTION_FAILED/P0001。関数署名/属性/本文、余分なoverload、意味上のACL、trigger、列、CHECKを検査する。本文MD5全７本はcontrollerがDBでmd5(replace(prosrc, CR, ''))を計算して補完済み。fix round 1ではH3本文と補完値を変更していない。以後本文を変えた関数だけ期待値を00000000000000000000000000000000へ戻し、controllerが補完してからfresh resetする。署名一覧は[Task 6レポート](../../.superpowers/sdd/2026-10-29-group-h-promotions/task-6-report.md)。

実装者は単体/TypeScript/ESLintだけを確認し、DBテスト・CLI・Docker・本番・実Stripeは実行しない。controllerはH1〜H3/旧owner-cart-draft回帰、全入口のservice成功/anon・authenticated拒否をPostgRESTでも確認する。Task 7の予約/確定/遅い入金は別途実装する。

## グループH Task 7: 受付・予約・入金照合・要対応（H4、controllerのDB確認待ち）

確認日2026-10-29。移行は[20261029130300_group_h_discounts_acceptance.sql](../../supabase/migrations/20261029130300_group_h_discounts_acceptance.sql)。サイズ 114,898 bytes、MD5 `d4f7cd24c36670b2463d959ed8f980f9`（末尾 assert の関数19本の本文の指紋は controller が手元の DB で計算して埋めた。fix round 1 で本文を変えた4本 `group_h_recheck_discount_facts`・`group_h_reserve_redemptions`・`place_order_from_checkout_draft`・`place_reconciled_order_from_checkout_draft` も計算し直し済み）。UTF-8/BOMなし/LF/ASCII、BEGIN→H4本体→H4末尾assert→NOTIFY→COMMIT。H1〜H3・G・波の過去の移行は編集しない。既存行への補完/清掃は無い（実行時のDMLは関数の中だけ）。

新しい private 本体は postgres 所有・SECURITY DEFINER・空 search_path。内部helper 7本（`group_h_lock_acceptance`・`group_h_assert_acceptance_locks`・`group_h_recheck_discount_facts`・`group_h_copy_order_discounts`・`group_h_reserve_redemptions`・`group_h_settle_redemptions`・`group_h_discount_attention_rows`）は service_role にも EXECUTE を与えず、Gの書き手の一覧にも混ぜない。service_role 専用の新しい入口は `place_reconciled_order_from_checkout_draft`（private本体+public INVOKER）、`list_admin_discount_attention`（STABLE、`admin.orders.read`）、`admin_resolve_discount_attention`（`admin.orders.manage`）。

`CREATE OR REPLACE` で本文を置き換える既存の関数（署名・戻り型・所有者・SECURITY・search_path・権限・OIDを保つ）: `place_order_from_checkout_draft`（先頭のG共通鍵の後に本人・割引の鍵、固定額の照合、割引の再確認、行別割引・1着の額・予約のコピー）、`mark_order_paid`・`record_cancelled_order_paid_amount`（同じ取引で settle(true)）、`release_stock_for_unpaid_order`（未入金終了だけ settle(false)）、`mark_order_awaiting_payment`（予約を保つ。鍵だけ追加）、`link_guest_orders`（G共通→本人キー辞書順→割引id→既存orderの順で結び、redemptionsの本人を会員へ。注文のメールの比較を `lower(btrim())` に揃えた小さな変更を含む）、`get_checkout_discount_context`（初回の有料履歴を `status IN (paid, shipped) OR paid_amount>0` へ）、`get_admin_order_detail`（`attention.discounts` を追加）、`group_g_writer_allowlist`（76本 → 77本。`place_reconciled_order_from_checkout_draft` の1本だけを足す）。

H4_FINAL_ASSERTのDETAILは `h4_acceptance`・`h4_member_lock`・`h4_redemption_lifecycle`・`h4_reconciled_recovery`・`h4_attention`・`h4_writer_allowlist`・`h4_public_acl`。失敗は `GROUP_H_MIGRATION_ASSERTION_FAILED / P0001`。関数の署名・属性・意味上のACL・public入口の委譲・本文MD5と、書き手の一覧が「H4より前の76本のOID + 照合入口1本」であることを検査する。本文MD5は controller が DB で `md5(replace(prosrc, E'\r', ''))` を計算して補完する。本文を変えた関数だけ `00000000000000000000000000000000` に戻してあり、その一覧は[Task 7レポート](../../.superpowers/sdd/2026-10-29-group-h-promotions/task-7-report.md)の fix round 1 に書く。

実装者は単体/TypeScript/ESLintだけを確認し、DBテスト・CLI・Docker・本番・実Stripeは実行しない。controllerは未実装DBのRED、MD5補完、fresh reset、H4のDB 3 suite+assert、既存のG-1〜G-4回帰（`group_g1_writer_inventory` は77本）、並行の3連続、PostgRESTでの新public入口のservice成功/anon・authenticated拒否、照合入口が通常routeから未使用であることを確認する。

## グループH Task 9: 返金・返品・G-4金額（H5、controllerのDB確認待ち）

移行は[20261029130400_group_h_discounts_refunds.sql](../../supabase/migrations/20261029130400_group_h_discounts_refunds.sql)。サイズ 189,702 bytes、MD5 `aa93b52d78391ca52015dc84275171a9`（末尾 assert の関数の本文の指紋は controller が手元の DB で計算して埋めた。fix round 4 で返品単位の対応付けと解放順の2本を変え、その2本も計算し直し済み）。ASCII/BOMなし/LF、BEGIN→既存関数のCREATE OR REPLACEと単位claim→H5_FINAL_ASSERT→NOTIFY→COMMIT。既存移行は編集しない。業務データの補完/清掃はしない。

新しい列はunit_amountsだけのrefund_id/refund_before_shipment/return_line_id。金額などのimmutable・RLS・直接DML拒否を保ち、G共通鍵下の内部helperだけが関連を変える。使用回数confirmedは戻さない。G writer allowlistは77本のまま（Hの追加helperはGの保護する表を書かない）。既存関数はOID・署名・戻り型・SECURITY・volatility・search_path・ACLを保つ。public.load_order_refund_materialsは既存のSECURITY DEFINER/STABLEの1本を拡張する。

H5 assertは `GROUP_H_MIGRATION_ASSERTION_FAILED / P0001`、DETAILは `h5_unit_claims`・`h5_refund_amounts`・`h5_return_amounts`・`h5_legacy_fallback`・`h5_status_amounts`・`h5_public_acl`。fix round 2の11本はcontrollerが補完済み。fix round 4では `private.group_h_return_unit_dispositions(uuid)` と `private.group_h_release_return_units(uuid)` だけ `00000000000000000000000000000000` に戻した（[Task 9レポート](../../.superpowers/sdd/2026-10-29-group-h-promotions/task-9-report.md)）。controllerがDBの `md5(replace(prosrc, E'\r', ''))` から該当2本を補完する。各検査前のDETAIL・fp alias・EXISTSの括弧修正を保持し、実行時エラーのHINTはSQLSTATEだけを返す。

controller手順: 未適用DBでRED→MD5補完→fresh reset→H1〜H5 assertと新DB3本・既存refund/return/G-4回帰→並行3連続（pg_blocking_pids/pg_locksでG鍵待ちを観測）→既存public入口のPostgREST service成功/anon・authenticated拒否。実装者はDB・CLI・Docker・Playwright・serverを実行しない。最終SQLのコンパイル・DB上の金額/数量/ACL/ロック/例外・本番適用は未確認。

## グループH Task 10: 注文の割引の内訳（H6、手元のDBで確認済み・本番未適用）

移行は[20261029130500_group_h_discounts_views.sql](../../supabase/migrations/20261029130500_group_h_discounts_views.sql)。サイズ 23,567 bytes、MD5 `4a67ff2236d71f764401b6beba486365`（末尾 assert の関数4本の本文の指紋は controller が手元の DB で計算して埋めた）。ASCII/BOMなし/LF、BEGIN→baseline→新関数3本→既存2関数のCREATE OR REPLACE→ACL→H6_FINAL_ASSERT→NOTIFY→COMMIT。既存移行は編集しない。業務データの補完/清掃/再投入はしない（読み取りだけで、新しい列・表・権限もない）。

新しい関数は3本。`private.order_discount_breakdown(uuid)`（STABLE、内部のみ。service_roleにもEXECUTEを与えない）、`private.get_order_discount_breakdown(uuid)`と`public.get_order_discount_breakdown(uuid)`（public入口はSECURITY INVOKERのSQL委譲、service_roleのみ）。受付で固定した使用の写し（名前・コード・額・分類）と行別配分だけから、商品→注文→割引idの順の`{rows,legacy}`を作る。額の合計が`orders.discount_amount`と食い違えば`GROUP_H_ORDER_BREAKDOWN_INVALID`（55000）。正額の使用がない旧注文は`discount_amount>0`なら名前の印`discount`の合計1行、0円なら空。

既存の置き換えは2本（署名・戻り型・所有者・SECURITY・volatility・search_path・ACLを保ちOID不変）。`public.get_order_status_public_material(uuid)`はG3の本文に`discounts:[{name,amount}]`の1か所だけを足し（名前と額の2キーだけ。コード・割引id・配分は読まない）、`private.get_admin_order_detail(uuid,uuid)`はH4の本文に`discounts`（上のrowsそのまま）の1行だけを足す（権限は`admin.orders.read`のまま）。

H6 assertは `GROUP_H_MIGRATION_ASSERTION_FAILED / P0001`、DETAILは `h6_order_breakdown`・`h6_customer_projection`・`h6_admin_projection`・`h6_public_acl`。本文の指紋（`md5(replace(prosrc, E'\r', ''))`）の4本（`private.order_discount_breakdown(uuid)`・`private.get_order_discount_breakdown(uuid)`・`public.get_order_status_public_material(uuid)`・`private.get_admin_order_detail(uuid,uuid)`）は、controllerが手元のDBで計算して移行の末尾assertへ埋めた（値は移行のとおり）。assertの`position(x IN y)`は`pg_catalog.strpos`に直した。H4のassertが持つ`get_admin_order_detail`の旧い指紋は、[group_h_migration_asserts](../../tests/integration/db/group_h_migration_asserts.integration.test.ts)がH6のファイルに固定された値を読んで置き換えて流す。今の本文から指紋を作り直す形にはしていないので、本文を変えればH4のassertも落ちる（H6のファイルから値が取れない時も落ちる）。

controllerの確認（2026-10-30）: fresh reset した手元のDBで、H・G-4・注文状況・メールの27 suite 741/741が成功。本番適用、実メールの配信、実ブラウザの表示は未確認。

## グループH Task 12 fix 1: 支払いの例外の解決で未入金の予約を取り消す（H7）

確認日2026-11-01。本番未適用。H1〜H6とG以前の移行は変更しない。

| 移行 | ファイル | サイズ（bytes） | MD5 |
| --- | --- | --- | --- |
| H7 | [20261029130600_group_h_payment_exception_cancel.sql](../../supabase/migrations/20261029130600_group_h_payment_exception_cancel.sql) | 14,568 | c79a631430ba20a333ceb83254f8e4f1 |

ASCII/BOMなし/LF、BEGIN→取引内baseline→CREATE OR REPLACE→H7_FINAL_ASSERT→NOTIFY→COMMIT。`private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)`はG-1の本文に2行だけ追加する。G在庫鍵の前に`group_h_lock_acceptance(NULL, v_order_id)`を呼び、G共通→H目録→本人→割引→G在庫の順を守る。取消経路のUPDATE直後だけ`group_h_settle_redemptions(target.order_id, false)`を呼ぶ。取消なしの解決は予約を保つ。既存業務行の補完・清掃・再投入はない。

private本体とpublic入口の署名・OID・戻り型・引数名/既定値・所有者・SECURITY・volatility・search_path・ACL・コメントを保つ。G-1はこの関数にCOMMENTを設定していないため、H7もCOMMENT文を発行しない。書き手の一覧はH4と同じ77本（`CURRENT_ALLOWLIST`は同じ集合の`H7_ALLOWLIST`を参照）。H4の一覧本体の固定MD5は変えず、予約だけを書くhelperを追加しない。

H7末尾assertの失敗は`GROUP_H_MIGRATION_ASSERTION_FAILED / P0001`、DETAILは`h7_payment_exception_cancel`・`h7_public_acl`・`h7_writer_allowlist`。新しい本体のMD5は、controllerが手元のDBで取引内に本文を当てて`md5(replace(prosrc, E'\r', ''))`を採り（`656d6fc09913ed4865fe2b26029b0fd0`）、末尾assertへ固定した（2026-11-01）。

controller手順: H7未適用DBの新しい取消テストでRED→取引内で新本体のMD5を採取して補完→最終SQLのfresh reset→H1〜H7末尾assertとH受付/遷移/並行、G-1 payment-review/writer-inventoryとG-0〜G-4回帰→public入口のPostgREST service_role成功/anon・authenticated拒否。並行はG鍵待ちを`pg_blocking_pids`/`pg_locks`で観測して3連続。`G1_CLEANUP_SUITE=1`は通常回帰に含めない。実装者はDB・CLI・Docker・server・build・Playwright・実Stripe・本番を実行していない。controllerの実測（2026-11-01）: H7未適用のDBで新しい取消テストが落ちる（RED）→MD5を固定しDBを初期化→group_h_redemptions・group_h_migration_asserts・group_g1_payment_review・group_g1_writer_inventoryの4 suiteが通る。leakproofと所有者の付け替えの改ざんは手元のpostgresが超ユーザーでないため試験から外した（42501。末尾assertは両方を検査する）。

## グループH 本番適用の記録（H1〜H7、2026-11-01）

確認日: 2026-11-01。**本番適用済み（2026-11-01 14:35 頃 JST。オーナーの承認の後、controller が `npx supabase db push --linked`）。** 先の dry-run は H1〜H7 の7本だけを示した（別セッションの波 6 の M3 は当時 `supabase/pending-wave6/` にあり送られなかった。M3 は今は `supabase/migrations/20261101120000_sec_password_change_challenges.sql` で、手元は適用済み。本番へも同じ日の 21:06 頃 JST に別に当てた〔「波 6 パスワード変更の確認コードの移行 M3」の節〕）。当てる前に7本のファイルの MD5 が上の各節と同じことを確かめた。

| 確かめ（本番、読むだけ・件数だけ） | 適用前 | 適用後 |
| --- | --- | --- |
| 最新の移行 | `20261029120100` | `20261029130600`（`130000`〜`130600` の7本が増えた） |
| `public.permissions` | 30 | 32（`admin.discounts.read`・`admin.discounts.manage`） |
| 割引の権限を持つ役割 | なし | admin だけ（2件） |
| 役割の `permissions_version` | admin v0・supporter v0・user v0 | admin v1・supporter v0・user v0 |
| `private.resolve_payment_exception` の本文 MD5 | G-1 の本文 | `656d6fc09913ed4865fe2b26029b0fd0`（H7 の末尾 assert と同じ） |
| `orders`・`checkout_drafts` | 0・0 | 0・0 |

既存のデータへの書き込みは H1 の権限の種（2件・admin への付与2件・admin の版 +1）だけ。各移行の末尾 assert は本番でも通った（落ちれば取引ごと戻り、push が止まる）。

## 返品の受け取りの品ごとの返金の移行（FREQ-641 Task 1、手元の DB で確認済み・本番未適用）

移行は [20261106005536_return_receive_per_item.sql](../../supabase/migrations/20261106005536_return_receive_per_item.sql)。サイズ 100,580 bytes、MD5 `dd1402bee51133c791cea533b6933310`（2026-11-06 の直し1の後。直し1は、error の返金に成功が遅れて届いた時の取り直しが行の数量で取れなければ例外へ回すことと、受け取りで0円にした今返す品の解放をその受け取りの now の明細に結ぶこと）。ASCII・BOM なし・LF。`BEGIN;` → 書き手の許可一覧の写し（一時表 `rr_writer_baseline`）→ 表の変更（`order_return_receipt_lines.refund_choice`・CHECK・6列の一意の組、`order_return_receipts` の CHECK に `mixed`）→ private の11本の `CREATE OR REPLACE` と新しい読み出し `private.return_receive_amounts` → 所有者・ACL → 末尾 assert → `NOTIFY pgrst, 'reload schema';` → `COMMIT;`。適用済みの移行は変えない。過去の受け取りの行の埋め直し・業務データの書き換えはしない（`UPDATE` は無い）。公開の入口 `public.admin_receive_return` と芯 `private.order_return_line_states_core` は変えない。

デプロイの順番（2026-11-06）: 本番では、この移行を先に当ててから、このコードを出す。逆にすると、管理画面の注文履歴の窓口 `/api/admin/orders/[id]/history` が新しい列 `refund_choice` を読めず500を返す。本番への適用は 2026-11-06 にオーナーの許可を得て済ませた（移行を先に当て、その後に push した）。

`.github/workflows/db-migrations.yml` は master への push で `supabase/migrations/**` に変更があれば本番へ `supabase db push` するため、許可の前に push しない。

末尾 assert は `RETURN_RECEIVE_PER_ITEM_MIGRATION_ASSERTION_FAILED / P0001`。DETAIL は `rr_schema`（列・CHECK・一意の組）・`rr_receive`（受け取り・詳細・読み出しの本文の MD5 と属性、公開の入口の本文）・`rr_amounts`（H の9本の本文の MD5 と属性）・`rr_acl`（12本の ACL。`private.admin_receive_return` だけ service_role に EXECUTE を残す。公開の入口が SECURITY INVOKER のため）・`rr_writers`（G の書き手の許可一覧が77本・同じ OID 集合・本文の MD5 `1a9bd697484b32bb5f44793ced4b70df` のまま）。

手元で当てて確かめる手順（Docker の手元の Supabase が動いている時。`--linked` は使わない）:

1. `npx supabase db reset`（手元だけ。全部の移行を当て直す。末尾 assert が落ちると取引ごと戻り、reset が止まる）
2. `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/return-receive-per-item --runInBand`（新しい試験の2ファイル・43件）
3. もう一度 `npx supabase db reset` の後に `DATABASE_URL=… npx jest tests/integration/db --runInBand`（全部の DB の試験。`checkout_session_claim` の試験は後片付けで関数を消すので、ほかを流し直す前に reset する）

2026-11-06 の実装者の実測（手元）: 手順2は43件すべて通過。手順3は fresh reset 直後の全件で 4,774 件中 4,758 件通過・失敗0・15件 skip・1件 todo（163 suite 通過・13 suite skip）。1回目の全件では G-3 の2 suite（3件、試験の準備の関数 `setOrderStatusForFixture` で `PAID_ORDER_REQUIRES_FULL_REFUND_BEFORE_CANCELLATION`）が落ちたが、単独では移行あり・なしとも通り、2回目の全件でも通ったので、並び順による揺れと見る。直し1の後（fresh reset 直後の全件）: 4,776 件中 4,760 件通過・失敗0・15件 skip・1件 todo。本番の DB への適用（`db push --linked` や MCP）は、オーナーの許可が出るまでしない。

## 返品の受け取りの数え方の直しの移行（I-1・N-1、2026-11-08、本番適用済み）

移行は [20261108063711_return_receive_unit_dedup.sql](../../supabase/migrations/20261108063711_return_receive_unit_dedup.sql)。サイズ 53,330 bytes、MD5 `85377c44f56224126ad24155564ed69a`。ASCII・BOM なし・LF。2026-11-08 にオーナーが承認した案（I-1・N-1 とも案 A）。適用済みの移行（`20261029130400`・`20261106005536`）は1字も変えていない。

| 何を | どう変えたか |
| --- | --- |
| 表 `order_return_receipts` | 列 `consult_quantity integer` を足した（NULL＝この移行より前の記録）。CHECK `order_return_receipts_consult_quantity_check`（NULL か0以上）。追記だけの表なので、既存の行は埋め直さない（`UPDATE` は無い）。値は受け取りの INSERT の時に書く |
| `private.admin_receive_return` | 受け取りの記録に、この受け取りで返金待ちにした相談の点数（覆いで抑えた後の `v_consult_total`）を書く（N-1）。指紋 `request_fingerprint` と再送の一致の確かめには入れない（古い再送が `RETURN_REQUEST_MISMATCH` にならない）。相談の上限は、今すぐの分が使った空きの着の次から数える。交換の品の値段（`exchange_paid_amount`）も、同じ注文の商品の交換の行の間で空きの着を1列で使う（I-1） |
| `private.group_h_receiving_amount` | 受け取りの上限の値段を、行ごとの `group_h_return_line_amount` の足し算から、注文の商品ごとに空きの着を1列に並べて前の行が使った着を次の行で使わない形にした（I-1）。要素に `refund_choice` があれば相談は今すぐの後に数える |
| `private.group_h_return_refund_amount` | 受け取りの記録がある枝（返金の行の値段）を同じ形にした。受け取りの記録が無い枝は元のまま |
| `private.return_receive_amounts` | 画面の見込みも、行の id の順に空きの着を1列で使う（前は行ごとに最初の空きの着から数えた） |

順番は3つの数え方（値段・上限・実際に着を取る `group_h_return_refund_slices`→`group_h_claim_refund_units`）でそろえた: 行の id の順、自分の着 → 空きの着、安い順、今すぐの後に相談。関数の署名・所有者・`search_path`・EXECUTE の付与は前と同じ（`private.admin_receive_return` だけ service_role に EXECUTE を残し、ほかは postgres だけ）。G の書き手の許可一覧は変えない（OID は `CREATE OR REPLACE` で変わらない）。

末尾 assert は `RETURN_RECEIVE_UNIT_DEDUP_MIGRATION_ASSERTION_FAILED / P0001`。DETAIL は `rd_schema`（列の型・NULL 可・既定値なし、CHECK の定義、anon・authenticated が読めず service_role が読めるだけ）と `rd_bodies`（置き換えた4本の本文の MD5・所有者・SECURITY DEFINER・`search_path`・揮発性・ACL・同じ名前の関数が1本だけ、公開の入口 `public.admin_receive_return` の本文 MD5 `2dedc2b2503ceb8516dedeaeb970609c` のまま）。

デプロイの順番: 本番では、この移行を先に当ててから、このコードを出す。逆にすると、管理画面の注文履歴の窓口 `/api/admin/orders/[id]/history` が新しい列 `consult_quantity` を読めず500を返す。`.github/workflows/db-migrations.yml` が master への push で本番へ `supabase db push` するため、許可の前に push しない。本番の DB への適用は、2026-11-08 にオーナーの許可を得て MCP で行った（下の「本番への適用」）。

手元で当てて確かめる手順（`--linked` は使わない）:

1. `npx supabase db reset`（手元だけ。末尾 assert が落ちると取引ごと戻り、reset が止まる）
2. `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest --runInBand tests/integration/db/return-receive-per-item-repro.integration.test.ts tests/integration/db/return-receive-per-item.integration.test.ts tests/integration/db/return-receive-per-item-migration.integration.test.ts`

2026-11-08 の実装者の実測（手元）: 手順1で新しい移行が当たった。手順2は3ファイル55件すべて通過（再現の試験 9件・品ごとの返金 28件・移行の契約 18件）。割引の返金・返品に関わる DB の試験19ファイル（`group_g1_refund_cancel`・`group_g1_return_exchange`・`group_g1_return_requests`・`group_h_admin`・`group_h_migration_asserts`・`group_h_order_amounts`・`group_h_refund_concurrency`・`group_h_refund_outcomes`・`group_h_refunds`・`order_refund_records`・`order_refund_requests`・`order_refund_results`・`order_return_actions`・`order_return_customer_requests`・`order_return_receipts`・`order_return_records`・`order_return_request_records`・`order_return_request_reviews`・`order_status_returns`）は1,005件通過・失敗0。PostgREST を通す3ファイルは、`refund_postgrest`・`refund_failure_exception_postgrest` が通過、`return_postgrest` は3件失敗（返品の行の鍵の一覧に `receiveRefundAmountsByCount` が無い。2026-11-06 の f07981dc で TS の写し `return-store.ts` にこの鍵を足した時に、試験の鍵の一覧〔試験の105-108行〕を直し忘れた前からの失敗。今回の移行のせいではない。試験の鍵の一覧にこの鍵を足して直した）。終わった後に `npx supabase db reset` で手元の DB を戻した。

既知の点（直していない。別の設計で直す）:

- 交換の行と返金の行が同じ注文の商品の空きの着を要る時、交換の品の値段（`exchange_paid_amount`）が返金と同じ着を指す。あとで交換の品を返金する時に少なく返す（例: 3000円）。受け取りを2回に分けても起きる。この場面ではお客様に足りない向き。ただし返し過ぎの向きの道もある（4つ目の点）。返品の行に結び付かないふつうの返金も、交換が値段のもとにした空きの着を取れるので、同じ向きの誤りになる見込みがある（確かめていない。別の設計で確かめる）。
- 画面の見込み（`private.return_receive_amounts`）が、一部の行だけ受け取る時や、相談と今すぐの行の id の順によって、DB の上限・額とずれる。額は DB が決めるので返し過ぎにはならない。ただし P9 の人に出る「計算どおり」の額が実際と違うことがある。
- 受け取りを2回に分けて相談にすると、手数料の控えが同じ着を2回数える（10%で 3700円のはずが 3400円）。
- error の後に返金をやり直すと、返し過ぎの向きに誤る道もある。本番に当たっている `20261106005536` から前からある道で、`20261108063711` が入れた物ではない。原因は3つ。開き直しのトリガー（005536:122-145）が空きの着を行へ結び付ける。`group_h_claim_refund_units`（005536:217-219）が空きの着に `return_line_id` も書く。返金の error の時の `group_h_release_refund_units`（130400:258-266）は `refund_id` だけを外す。場面: 数量2（17000円と20000円）の交換の行を「届かない」で終える。ふつうの返金を1点して 17000円の着を取る。開き直すと、20000円の着がその行に結び付く。返金が error になり、17000円の着が空きへ戻る。1回目の受け取りで交換すると、交換の値段は 20000円になる。2回目の受け取りの今すぐの返金が 17000円の着を取って行に結び付け、交換の印が位置で 17000円の着へ移る。その返金が error になる（`return_line_id` は残る）。やり直した返金が 20000円の着を取る。交換の値段 20000円と返金 20000円で、払った 37000円より 3000円多く返る。返金の error が2回いるので、とてもまれ。別の設計の受け入れ条件に、この場面の試験を入れる。
- 直し方の向き: 交換の印を行の着の位置（安い順の何番目か）ではなく着そのものに結び付ける設計を別に書き、承認を得てから直す（2026-11-08 オーナー決定）。2回目・3回目で受け取りの時に空きの着を行へ結び付ける形を試したが、今の位置で決める作りと合わず返し過ぎの道が出たので、この移行は1回目の形に戻した。

2026-11-08 の実装者の実測（手元、1回目の形に戻した後）: 移行は1回目と同じ（MD5 `85377c44f56224126ad24155564ed69a`）。`npx supabase db reset` で当たった。手順2の3ファイルは55件すべて通過。上の19ファイルは1,005件通過・1件飛ばし・失敗0（1回目と同じ）。PostgREST を通す3ファイルは、`db reset` の後に27件すべて通過（`return_postgrest` も通過）。終わった後に `npx supabase db reset` で手元の DB を戻した。

本番への適用（2026-11-08、オーナー承認の案A）:

- 手段: Supabase MCP の `apply_migration`（`name` は `return_receive_unit_dedup`、`query` はファイルの全文）。`supabase db push --linked` は、本番に無い会計の S0〜S5（`20261107130000`〜`20261107130500`）も一緒に当てるので使わなかった。この移行は S0〜S5 に頼らない。
- 当てる前（読むだけ）: 本番の最新は `20261106005536`。`order_return_receipts.consult_quantity` は無く、置き換える4本の関数はあり、公開の入口 `public.admin_receive_return` の本文 MD5 は `2dedc2b2503ceb8516dedeaeb970609c`（末尾 assert の前提どおり）。受け取りの記録は0件。
- 記録された版: `20261108063711`。ファイル名を `20261108120000_…` から `20261108063711_return_receive_unit_dedup.sql` に直した（上の「MCP の apply_migration で当てた場合」）。並びは会計の S0〜S5 の後のままで、手元の `db reset` の適用順は変わらない。
- 当てた後（読むだけ）: `schema_migrations` の `md5(statements[1])` が `85377c44f56224126ad24155564ed69a`（ファイルと同じ）、文は1つ。列 `consult_quantity` と CHECK `CHECK (((consult_quantity IS NULL) OR (consult_quantity >= 0)))` がある。置き換えた4本の本文 MD5 が末尾 assert の値と同じ（`admin_receive_return` `4fc48eb2…`・`group_h_receiving_amount` `523ba3a9…`・`group_h_return_refund_amount` `3ddd20e9…`・`return_receive_amounts` `9fea9f9a…`）。
- 会計の S0〜S5 は本番に当てていない。S0〜S5 はこの移行より版が古くなるので、素の `db push` では止まる（当て方は下の節の Ruling T15b-apply）。


## 会計の作り直し 計画 1 の移行 S0〜S5（手元の DB で確認済み・2026-11-08 本番適用済み）

確認日: 2026-11-08。FREQ-553〜561。計画は [会計の作り直し 計画1](../superpowers/plans/2026-11-04-accounting-p1-journal-foundation.md)。使い方・事前確認・成功の確認・戻し方の詳細は[運用の手引き](accounting-p1-journal-foundation.md)が正本で、ここは移行の台帳として目的・順・末尾の検査・戻し方を写す。手元の DB で確かめた。本番へは 2026-11-08 に当てた（下の「本番への適用の記録」）。

本番に当てる前の約束（Task 16 Step 0。[本番適用前の普段の開発の接続先のオーナー確認](accounting-p1-journal-foundation.md#本番適用前の普段の開発の接続先のオーナー確認)）:

1. 本番に当てる前に、オーナーが `npm run dev` の接続先が手元の Supabase であることを確かめる。
2. 済むまで S0〜S5 を本番に当てない。
3. 環境変数の値は Claude も書き手も読まない。
4. 記録するのは確認した日と確認済みかどうかだけ。2026-11-08 に確認済み（オーナーの依頼で Claude が「手元かどうか」だけを確かめ、`.env.development.local` で切り替えた。詳しくは運用の手引き）。

`.github/workflows/db-migrations.yml` は master への push で `supabase/migrations/**` に変更があれば本番へ `supabase db push` するため、許可と確認の前に push しない。

### 順番と各ファイル

適用の順はファイル名の順（S0 → S5。本番へは下の「本番へ当てる手順（T16-1）」の当て方で 1 本ずつ）。各移行は 1 本の取引（`BEGIN`〜`COMMIT`）で、末尾に自己検査を持つ。検査が崩れると全部戻り、失敗の詳細は固定の `DETAIL` の語だけを返す。ファイルの MD5 はコミットしたファイルのもの。本番に当てた文の照合は、下の「本番への適用の記録」に書いた（CLI で当てたため `md5(statements[1])` の書き方は当てはまらず、本文の指紋で照らした）。ファイルの MD5 のほかに、本文の指紋（`md5(replace(prosrc, E'\r', ''))`。関数を戻した後や当てた後に、本番の定義と突き合わせる値）を下に書く。

| 移行 | 大きさ / ファイルの MD5 | 当てた文の照合 | 目的 |
| --- | --- | --- | --- |
| S0 `20261107130000_accounting_p1_permissions.sql` | 21,480 bytes / `8928d04875b7acc5e22fa9287e7f3cb1` | 2026-11-08 適用（CLI。版はファイル名のまま） | 権限 6 件を足す（32 → 38）。店長だけに付ける。H1 の GET/SET 目録の関数を 38 件に広げる |
| S1 `20261107130100_accounting_p1_grants_receipts.sql` | 16,404 bytes / `cdde6fb7ac47d57419f45fb2cd0f52a9` | 2026-11-08 適用（CLI。版はファイル名のまま） | `admin_finance_*` の 12 表と 8 連番から `anon`・`authenticated` の権限を外す。`admin_finance_receipts` に `evidence_kind`・`paper_original_kept`。置き場 `finance-receipts` を非公開・20MiB・5 形式にする |
| S2 `20261107130200_accounting_p1_journal_foundation.sql` | 84,339 bytes / `dab29db5a8aefaae01166c4acee2b263` | 2026-11-08 適用（CLI。版はファイル名のまま） | 仕訳・期間・勘定の 5 表、仕訳を入れる関数・取り消しの関数、勘定 163 行（162 ＋ `9999`） |
| S3 `20261107130300_accounting_p1_period_reads.sql` | 87,564 bytes / `0593bf4afcf8cf781c827643f6be0257` | 2026-11-08 適用（CLI。版はファイル名のまま） | 設定・期首の表、期間の作成・やめた日・設定・申告の設定の書き手、読み 5 つ、トリガー |
| S4 `20261107130400_accounting_p1_manual_entry_journal.sql` | 48,136 bytes / `5ceaf3e153ee5809f03c982b7704401e` | 2026-11-08 適用（CLI。版はファイル名のまま） | 手入力の取引を仕訳にするトリガー、分類・支払方法の写し、履歴の保護、履歴を書く関数の入れ替え |
| S5 `20261107130500_accounting_p1_a8_migrate_manual.sql` | 17,118 bytes / `fcb9c5d689beacd0ba81b50f771687aa` | 2026-11-08 適用（CLI。版はファイル名のまま） | 削除されていない手入力の取引を `migrated_entry` として移す（A8） |

本文の指紋（`md5(replace(prosrc, E'\r', ''))`）:

| 対象 | 値 | 使い方 |
| --- | --- | --- |
| S0 後の `private.admin_get_permissions(uuid)` | `57b375f57488317d34e9b4b5aa9b8e10`（S0 :229） | S0 の末尾の検査が照らす。当てた後の本番の定義と突き合わせる |
| S0 後の `private.admin_set_role_permissions(uuid,text,text[],bigint,uuid)` | `340c33e13641a27bbad4080f23931b94`（S0 :230） | 同上 |
| H1（`20261029130000`）の元の `admin_get_permissions` | `e74dab48011008b34e1c42f06f75efcf`（H1 :878） | S0 を戻した後の確かめ。`CREATE OR REPLACE` で戻した本体がこの値に戻ること |
| H1 の元の `admin_set_role_permissions` | `8dd855720e3442134a80e240e8474185`（H1 :879） | 同上 |
| S2 の勘定の種（`9999` を含む 163 行。`code,account_type,normal_side,scope,carryover_role` を `;` でつないだ md5） | `9267159e6a646a2f7b5fcd81a725235f`（S2 :1231） | S2 の末尾の検査が照らす。当てた後の `accounting_accounts` と突き合わせる |

### 本番への適用の記録（2026-11-08）

- 当てた人と日: controller（Claude）、2026-11-08。オーナーの承認（「当ててよい」）と、普段の開発の接続先の確認（運用の手引きの表）の後。
- 当て方（Ruling T16-cli）: CLI の `npx supabase db push --linked --include-all` を 2 回。1 回目は S4・S5 のファイルを一時的に外して S0〜S3 だけを当て（dry-run で 4 本だけと確かめた）、事前確認の残り（設定の行・仕訳 0・期間 0）を読んでから、ファイルを戻して 2 回目に S4・S5 を当てた。どちらも成功（終了の値 0）。MCP の `apply_migration` は使わなかった（84〜87KB の本文を手で写すとずれるおそれがあるため。CLI はファイルをそのまま送り、版もファイル名のまま残るので、付け直しは要らない）。
- 当てた文の照合: CLI は文を分けて記録するので、`md5(statements[1])` の照合は当てはまらない（記録された文の数は S0 16・S1 10・S2 76・S3 97・S4 40・S5 6）。代わりに上の本文の指紋で照らし、S0 後の 2 関数と勘定の種の md5 が表の値と一致した。
- 結果（読むだけで確かめた）: 権限 38（会計 6）。`admin_finance_*` の `anon`・`authenticated` の権限 0。置き場は非公開・20MiB・5 形式。勘定 163。移した仕訳 15 ＝ 生きている経費 15。期間 2（2025年・2026年の個人）。通し番号は各期間で 1 から欠けなし（9 と 6）。借貸はすべて一致。`9999` の行 0。経費・履歴・領収書の行の数は当てる前のまま（18・25・8）。経費のトリガーは有効。

### 末尾の検査（DETAIL）と戻し方

| 移行 | 末尾の検査（DETAIL） | 戻し方 |
| --- | --- | --- |
| S0 | `acc_s0_permission_catalogs`・`acc_s0_permission_seed`・`acc_s0_existing_dml_allowlist` | 移行のファイルに戻しの文は無い。S1〜S5 を先に戻した後だけ（S3 の書き手が `admin.accounting.settings.manage` を確かめるため）。H1（`20261029130000`）の 2 関数の本体へ `CREATE OR REPLACE` し、`role_permissions`・`permissions` から 6 件を消す。6 件を消した役割の版を +1 する（店長。画面でサポーターへ付けていればサポーターも）。アプリの目録（`admin-rbac.ts`・`role-permission-catalog.ts`・保存の上限、38 → 32）を同じデプロイで戻す（要レビュー） |
| S1 | `acc_s1_finance_table_acl`・`acc_s1_finance_seq_acl`・`acc_s1_bucket`・`acc_s1_receipt_columns`・`acc_s1_policies_unchanged` | 移行のファイルの先頭の ROLLBACK のとおり。適用前に読んだ権限・置き場の行の値へ戻す。種類の列を消すと適用後に記録した種類が消えるので先に書き出す。`public` は `true` に戻さない |
| S2 | `acc_s2_tables` ほか 8 つ（計 9 つ） | 仕訳が 1 件も無い間だけ、ファイル先頭の DROP の文。仕訳は消せない |
| S3 | `acc_s3_settings_row`・`acc_s3_period_layout_trigger`・`acc_s3_functions`・`acc_s3_rls_acl`・`acc_s3_reads_stable` | 期間・設定の変更・期首の行が残らない間だけ、ファイル先頭の DROP の文 |
| S4 | `acc_s4_map_table`・`acc_s4_trigger`・`acc_s4_functions`・`acc_s4_legacy_trigger_untouched` | 手入力の仕訳が無い間だけ、ファイル先頭の DROP の文。履歴の関数は `remote_schema.sql` の本体へ `CREATE OR REPLACE` で戻し、続けて `ALTER FUNCTION public.record_admin_finance_entry_revision() SET search_path = public, pg_temp;` も流す |
| S5 | `acc_s5_counts`・`acc_s5_numbering`・`acc_s5_revisions_unchanged`・`acc_s5_receipts_unchanged`・`acc_s5_triggers_unchanged`、事前の止め `a8_corporation_year`・`a8_legacy_opening_nonzero`・`a8_closings_exist`・`a8_startup_cost_category` | 戻せない。誤りは取り消しと正しい仕訳で直す |

### 本番へ当てる手順（T16-1）

（記録。手順は下の日本語）Ruling T16-1 (refines C11): Task 16 applies in two pushes — (1) S0–S3 first; (2) run ALL S5 stop pre-checks read-only on production (task-13-report's 9 checks + earliest live expense year ≥ 2025 when start date NULL + max(created_at) ≤ now + category listing incl. 開業費 0 rows); (3) owner confirms no admin expense writes; (4) push S4+S5 together; if S5 fails, nobody edits expenses (S4 alone posts only on writes), fix S5 and push again — because db push commits each file separately and an S4-only state + any write would make S5 stop permanently (M-4) — cost if wrong: manual reconciliation decision needed.

意味: 1 回目で S0〜S3 を当てる。続けて[運用の手引きの本番の事前確認](accounting-p1-journal-foundation.md#本番の事前確認読み取りだけ)をすべて読み取り専用で流す（`current_setting('server_version_num')` が 170000 以上 180000 未満（PG17）であること＝S2 は制約を27と数える、当てる役割が `storage.buckets` に INSERT・UPDATE できること、も含む）。S5 の事前の止めが崩れた時、事前確認1の `created_at`（S2:662）と5の年の窓（S3:516-518）は `DETAIL` の語でなく `ACCOUNTING_ARGUMENT_INVALID`（22023）で落ちる。管理者が会計の取引を書いていないことをオーナーが確かめてから、2 回目で S4 を当てて続けて S5 を当てる。S5 が失敗したら、直して S5 を当て直すまで誰も取引を書かない（S4 だけの状態で取引を書くと、S5 が `acc_s5_counts` で永久に止まる）。S4 と S5 は別々に確定するため、2 本を別の日に分けない。

当て方（Ruling T15b-apply）: 2 回とも Supabase MCP の `apply_migration` で 1 本ずつ当てる。1 回目は S0 → S1 → S2 → S3、2 回目は S4 の直後に S5。`name` はファイル名の版（`20261107130000_` など）を除いた部分に合わせ、`query` はファイルの全文にする。素の `supabase db push` と CI（master への push で動く `db-migrations.yml`）は、この 6 本には使わない。6 本を一度に当てるため、S5 で止まると T16-1 が避けたい「S4 だけ」の状態が残る。返品の `20261108063711` が先に本番へ当たっていても、この当て方なら止まらない（MCP は版を当てた時刻で付けるので、S0〜S5 のファイルの版が本番の最新より古くても関係しない。素の `db push` ならその時点で止まる）。当てた直後に `list_migrations` で記録された版を見て、上の「MCP の apply_migration で当てた場合」の決まりでファイル名の版を付け直し、`schema_migrations` の文の `md5(statements[1])` をファイルと突き合わせる。付け直すと手元の `db reset` の適用順が変わりうるので、付け直した後に `db reset` が通ることも確かめる。付け直したら、ファイル名を固定で書いた試験と文書の参照も同じ版にそろえる（`grep -rn 20261107130 tests e2e docs` で拾う）。S0〜S5 のコミットの master への push は、当て終えて版を付け直した後にする（先に push すると、CI が動いた場合に 6 本が一度に当たる。今は CI が `supabase link` で落ちているが、当てにしない）。手元の master では S0〜S5 の上にほかの作業のコミットが重なっているので、それまでは**どのセッションも master を push しない**（2026-11-08 に返品の作業のセッションと取り決めた）。（2026-11-08 の実際の適用は、S4・S5 のファイルを一時的に外した CLI の `db push --linked --include-all` を 2 回に分けて行った。Ruling T16-cli。記録は上の「本番への適用の記録」）

当てた後の確かめ（正の確認は `migrated_entry` の件数と元の表の生きた行の数の一致。NOTICE の `moved=` は目安で、MCP が返すかは未確認。元の表の件数が変わらないこと、`schema_migrations` の突き合わせ、画面で移した仕訳が読めること）は[運用の手引きの成功の確認](accounting-p1-journal-foundation.md#成功の確認)。アプリを出すのは S5 を当てて確かめた後（S2・S3 の前は会計の画面が500、S3 の後・S5 の前は手入力が0件に見える、S1 の前は GET が `evidence_kind` を読めない）。確かめのために本番で取引を足したり直したりしない（S4 の後は仕訳と取り消しの行が消せずに残る）。

### 手元で当てて確かめる手順（`--linked` は使わない）

1. `npx supabase db reset`（手元だけ。末尾の検査が落ちると取引ごと戻り、reset が止まる）
2. `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/accounting_p1 --runInBand`（`accounting_p1_*` の 12 ファイル）
3. E2E（`FR-ADMIN-128` など）の後に DB 結合を流すときは、先に `npm run db:reset` する。E2E が開業日・個人事業を終えた日・空きの個人の期間を手元の DB に残すため。

## 会計の作り直し 計画 2 の移行 S6〜S14（手元の DB で確認済み・2026-11-09 本番適用済み）

確認日: 2026-11-09。FREQ-562〜574。計画は [会計の作り直し 計画2](../superpowers/plans/2026-11-04-accounting-p2-deferred-revenue-stripe.md)。使い方・計上待ちの読み方・Stripe の購読の変え方・事前の読み取りは[運用の手引き](accounting-p2-posting-stripe.md)が正本で、ここは移行の台帳として目的・順・末尾の検査・戻し方を写す。手元の DB（`supabase db reset`）で全部を当てて確かめた。本番へは 2026-11-09 に当てた（下の「本番への適用の記録」）。

本番に当てる前の約束:

1. 計画1の S0〜S5 が本番に当たっていること（2026-11-08 に当てた）。
2. 計画1の Task 16 Step 0 の接続先のオーナー確認（`npm run dev` が手元の Supabase を向く）が有効なこと（[計画2の運用の手引きの 8](accounting-p2-posting-stripe.md#8-普段の開発の接続先のオーナー確認計画1の-task-16-step-0-を引き継ぐ)）。済んでいなければ当てずに報告する。
3. S6 を当てる前に、確定済み・取り消し済みの発送票の件数を読み、どちらも0であること（[運用の手引きの 9](accounting-p2-posting-stripe.md#9-s6-を当てる前の発送票の件数task-16-step-6)）。1件でもある時、または適用の途中で S6 の assert（`acc_s6_slip_fact_backfill`）が止まった時は、**当てずに報告して、オーナーと対応を決める**。発送票の清掃・assert の無効化・番号の推測による補完をその場で行わない。
4. **Stripe の行が切り替えの日以後に1件も無いこと（止める規則）**: `stripe_balance_transactions` で `private.accounting_jst_date(stripe_created_at) >= cutover_on` の件数、`stripe_payouts` で `paid_at` または `bank_arrival_date` が `cutover_on` 以後の件数を読み（数だけ。[運用の手引きの 9](accounting-p2-posting-stripe.md#9-s6-を当てる前の発送票の件数task-16-step-6)）、**どれも0であること**。1件でもあれば当てずに報告する（当てると、最初の計上の呼び出しで消せない手数料・入金・入金の失敗の仕訳になり、期間が自動で作られることがある）。切り替えの日より前の行は `before_cutover` で保留になるだけで害はない。
5. 本番に `admin_kpi_monthly_records` が**まだ無い**こと（S13 は `CREATE TABLE` なので、旧 `migrations/063` を手で当てていると失敗して戻る）。
6. master への push はオーナーの許可を得てから。`.github/workflows/db-migrations.yml` は master への push で `supabase/migrations/**` の変更を本番へ `supabase db push` する。

### 順番と各ファイル

適用の順はファイル名の順（S6 → S14）。各移行は1本の取引（`BEGIN`〜`COMMIT`）で、末尾に自己検査を持つ。検査が崩れると全部戻り、失敗の詳細は固定の `DETAIL` の語（`acc_s6_*`〜`acc_s14_*`）だけを返す。SQL の日本語は `U&'\XXXX'` 形で、`src/lib/accounting/labels.ts` と試験が一致を確かめる。ファイルの MD5 はコミットしたファイルのもの（`md5sum`。ファイルは ASCII・LF）。状態はすべて 2026-11-09 に本番へ適用済み。

| 移行 | 大きさ / ファイルの MD5 | 状態 | 目的 |
| --- | --- | --- | --- |
| S6 `20261108150000_accounting_p2_posting_tables.sql` | 95,453 bytes / `634abc8f986c49dab1a7fbcc093193c9` | 2026-11-09 適用（CLI。版はファイル名のまま） | 計上待ち・出荷の着・出荷前の返金の割り当て・発送票の確定／取り消しの事実の4表と、G の鍵の中で番号を取る連番 `private.accounting_g_fact_seq`。割り当ての道具、計上待ちの書き手と読み、G の2関数（確定・取り消し）に事実を書く1行ずつ、`ops_job_heartbeats` に `accounting_post` |
| S7 `20261108160000_accounting_p2_payment_posting.sql` | 21,977 bytes / `3a217724d16b35a8e3b2bbcdb48d56fd` | 2026-11-09 適用（CLI。版はファイル名のまま） | 支払いを前受金（1160 借 / 2150 貸）にする計上（`private.accounting_post_payment_events`）と、失敗を保留に残す道具 `accounting_park_failure` |
| S8 `20261108170000_accounting_p2_shipment_posting.sql` | 57,985 bytes / `35c17969e28884ebf20a4ca6eb582325` | 2026-11-09 適用（CLI。版はファイル名のまま） | 発送票の確定・取り消し・出荷日の直しの計上（`private.accounting_post_shipment_events`）、出荷の計画の道具、仕訳から発送票の跡を引く読み（`get_shipment_journal_trace`・`list_journal_shipment_meta`） |
| S9 `20261108180000_accounting_p2_stripe_posting.sql` | 88,692 bytes / `ac529381e3c8d92067e81d041dd8880f` | 2026-11-09 適用（CLI。版はファイル名のまま） | Stripe の手数料・税額調整・入金・着金・入金の失敗の計上（5つの係）、取引の種類の対応表、残高の補充の書き手、請求書の記録の表と書き手、手数料と残高の照合の読み |
| S10 `20261108190000_accounting_p2_dispute_intake.sql` | 27,849 bytes / `fd2177fce49a35be0f89de51b30e425f` | 2026-11-09 適用（CLI。版はファイル名のまま） | dispute の表 `stripe_disputes` と履歴 `stripe_dispute_events`、受け取る関数 `record_stripe_dispute` |
| S11 `20261108200000_accounting_p2_dispute_posting.sql` | 90,364 bytes / `1cb5b304fe7f539cd3b838af9411eaf7` | 2026-11-09 適用（CLI。版はファイル名のまま） | dispute の計上（引かれた時 W・確定 C・戻り R／L・科目の振り替え X）、原因ごとの科目の設定と振り替えの表、dispute の読み、**計上の入口 `public.accounting_run_posting`** |
| S12 `20261108210000_accounting_p2_intake_reads.sql` | 43,964 bytes / `2a8e4c593d9c7888615865676139246c` | 2026-11-09 適用（CLI。版はファイル名のまま） | 受注高・受注残・照合・前受金の確認の読み（表なし、行を書かない） |
| S13 `20261108220000_accounting_p2_kpi_monthly_records.sql` | 26,363 bytes / `982af0ee7672ed54ee501419da9a944e` | 2026-11-09 適用（CLI。版はファイル名のまま） | 月の KPI の記録の表 `admin_kpi_monthly_records`（旧 063 の食い違いの解消）と、書き手・読み |
| S14 `20261108230000_accounting_p2_year_end_shipments.sql` | 43,995 bytes / `958fcbac2176547d928cbe825ed4b9af` | 2026-11-09 適用（CLI。版はファイル名のまま） | 年末の出荷の確かめの印の表、運送会社の受付日のオプションの表、年末の一覧・受付日の差の読み |

### 本番への適用の記録（2026-11-09）

- 2026-11-09 にオーナーの承認を得て、CLI の `npx.cmd supabase db push --linked --include-all` で S6〜S14 の 9 本を一度に当てた（先に `--dry-run` で 9 本だけが対象であることを確かめた。各ファイルは 1 本の取引で、CLI は最初に失敗したファイルで止まる）。版はファイル名のまま（`20261108150000`〜`20261108230000`）で、付け直しは無い。push はしていない。
- 当てる直前（2026-11-09 11:58 JST）に読み直した数: 確定済み・取り消し済みの発送票 0 件、切り替えの日（2026-11-08）以後の Stripe の取引 0 件・入金 0 件、`admin_kpi_monthly_records` は無し。
- 当てた後に読むだけで確かめた: 9 本の版が `schema_migrations` にある。`admin_kpi_monthly_records` は在って 0 行。`accounting_pending_events` は 0 行。`accounting_settings` は変わらない（`cutover_on` 2026-11-08・版 1）。権限は 38 件（会計 6 件）のまま。仕訳は 15 件のまま（計画1の A8 の移し替えの分）。
- 当てた文の照合: CLI で当てたため `md5(statements[1])` は使わず、本文の指紋で照らした。`public`・`private` の会計・Stripe・dispute・月の KPI・年末・出荷の跡の関数 123 個について、`md5(replace(prosrc, E'\r', ''))` を署名の順につないだ md5 が、手元の DB（同じ 9 本を当てた `db reset` 後）と本番で同じ `b35a1934d0fa54d3dec3801a86d236f0` だった。
- Meta 連携の表（`admin_meta_kpi_connections`・`admin_meta_kpi_sync_runs`）は本番にも移行にも無い。オーナーの決定（2026-11-09）で別の作業として作る。

### 移行の間の呼び出しの依存（実行時に探す）

関数の本体は plpgsql で、呼ぶ関数の名前は実行時に探す。そのため、あとの移行の関数を前の移行が呼ぶ。どれかの関数を落とすと、前の移行の係が壊れる。

| 呼ぶ側 | 呼ばれる側 | 壊れるもの |
| --- | --- | --- |
| S8 の `private.accounting_post_shipment_events` | S11 の `private.accounting_dispute_order` | 出荷の係。引かれた dispute のある注文の発送票を W まで待たせる |
| S9 の `private.get_stripe_balance_reconciliation`（公開の窓口と同じ） | S11 の `private.accounting_dispute_key` | Stripe の残高の照合。dispute の取引を仕訳済みと数える |
| S11 の `private.accounting_run_posting` | S7・S8・S9・S11 の4つの係 | 計上の入口 |

S11 を戻す時は、先に S8 の出荷の関数と S9 の残高の照合の関数を、dispute を呼ばない版に作り直す（S11 のヘッダーの注意）。戻す順は逆順（S14 → S6）。S7・S8・S9 は S11 の入口から呼ばれるので、S11 より前には戻せない。

### 末尾の検査（DETAIL）と戻し方

| 移行 | 末尾の検査（DETAIL） | 戻し方 |
| --- | --- | --- |
| S6 | 事前の止め `acc_s6_slip_fact_backfill`（確定・取り消し済みの発送票があれば本体の前で止まる。末尾の検査の段にも同じ名前がある）、末尾 `acc_s6_tables`・`acc_s6_constraints`・`acc_s6_immutable`・`acc_s6_rls_acl`・`acc_s6_function_attrs`・`acc_s6_heartbeat_check`・`acc_s6_seq_acl`・`acc_s6_existing_dml_allowlist`・`acc_s6_g_allowlist_unchanged`・`acc_s6_g_body_unchanged`・`acc_s6_g_function_attrs`（計12）。割り当ての合計の違反は `ACCOUNTING_ARGUMENT_INVALID` / 22023、DETAIL `unit_allocation_sum` | 4表の行が1件も無い間だけ。ファイル先頭の ROLLBACK のとおり: G の2関数（確定 `20261026045859_group_g4_orders_foundation.sql`・取り消し `20261025100130_group_g3_shipping_slips.sql`）を前の定義へ `CREATE OR REPLACE`、`ops_job_heartbeats_job_check` から `accounting_post` を外す、**4表の DROP を先に**（割り当ての表の制約トリガーが `accounting_check_unit_allocation_sum` を呼ぶので、表より先に関数を落とせない）、そのあとで読み・書き手・道具の関数、索引、連番の DROP |
| S7 | `acc_s7_functions`・`acc_s7_function_attrs`・`acc_s7_existing_dml_allowlist` | `payment_confirmed` の仕訳が無い間だけ。`private.accounting_post_payment_events(integer)`・`private.accounting_park_failure(...)` を DROP。S11 の `accounting_run_posting` が呼ぶので、S11 を先に戻す |
| S8 | `acc_s8_functions`・`acc_s8_function_attrs`・`acc_s8_reads_stable`・`acc_s8_g_untouched`・`acc_s8_existing_dml_allowlist` | `shipment_confirmed`・`shipment_redated` の仕訳が無い間だけ。ファイル先頭の DROP の文（8関数）。S11 が S8 の道具を呼ぶので、S11 を先に戻す |
| S9 | `acc_s9_tables`・`acc_s9_functions`・`acc_s9_function_attrs`・`acc_s9_rls_acl`・`acc_s9_reads_stable`・`acc_s9_category_map`・`acc_s9_existing_dml_allowlist` | `stripe_fee`・`stripe_tax_adjustment`・`payout_started`・`bank_arrived`・`payout_failed`・`balance_topup` の仕訳が無く、請求書の表が空の間だけ。ファイル先頭の DROP の文と `DROP TABLE accounting_stripe_invoice_records`。S11 の `accounting_run_posting` が呼ぶので、S11 を先に戻す |
| S10 | `acc_s10_tables`・`acc_s10_constraints`・`acc_s10_immutable`・`acc_s10_rls_acl`・`acc_s10_function_attrs`・`acc_s10_existing_dml_allowlist` | dispute が1件も記録されていない間だけ。`record_stripe_dispute`（公開と私的）・`stripe_disputes_guard_update` と2表を DROP |
| S11 | `acc_s11_tables`・`acc_s11_functions`・`acc_s11_function_attrs`・`acc_s11_rls_acl`・`acc_s11_reads_stable`・`acc_s11_run_posting`・`acc_s11_existing_dml_allowlist` | `dispute_event` の仕訳が無く、2表が空の間だけ。先に S8 と S9 の依存する関数を作り直してから、ファイル先頭の DROP の文 |
| S12 | `acc_s12_functions`・`acc_s12_function_attrs`・`acc_s12_reads_stable`・`acc_s12_existing_dml_allowlist` | 行を書かない移行。関数の DROP だけ |
| S13 | `acc_s13_table`・`acc_s13_constraints`・`acc_s13_rls_acl`・`acc_s13_function_attrs`・`acc_s13_existing_dml_allowlist` | 表が空の間だけ。関数と `admin_kpi_monthly_records`・`admin_kpi_monthly_records_touch` の DROP。戻すと月の記録の保存はまた失敗する |
| S14 | `acc_s14_tables`・`acc_s14_constraints`・`acc_s14_immutable`・`acc_s14_rls_acl`・`acc_s14_function_attrs`・`acc_s14_existing_dml_allowlist` | 印の表に行が無く、オプションの表が既定の1行だけの間だけ。関数と2表の DROP |

### 当てる手順

- 方法: CLI の `npx supabase db push --linked --include-all`。S6 → S14 の順で、途中で止めたい時はあとのファイルを一時的に外す（計画1の Ruling T16-cli）。MCP の `apply_migration` は使わない。大きいファイル（S6・S9・S11 は約90KB）を手で写すとずれる。CLI はファイルをそのまま送り、版もファイル名のまま残る。
- 事前（読むだけ）: 上の「当てる前の約束」の1〜5、`list_migrations` で本番の最新と S6〜S14 の版の並び（ファイル名の版が本番の最新より新しいこと。`20261108063711` の返品の移行の後）。
- 事後（読むだけ）: 9本が `schema_migrations` に載ったこと、`accounting_pending_events` が0件、`accounting_settings` が変わっていないこと、権限が38件のままであること、`admin_kpi_monthly_records` が空で存在すること、`ops_job_heartbeats_job_check` に `accounting_post` があること。**本番に書いて確かめることはしない**（仕訳は消せない）。
- 失敗した時: 固定の SQLSTATE・DETAIL・どこまで当たったかを残して止める。データの戻しを即興で行わない。S6 の `acc_s6_slip_fact_backfill` で止まった時は S7 以後へ進まない。
- **コードの配備は S6〜S14 を全部当てた後**（出荷の確定の route は `get_slip_dispute_holds` が無いと安全側で止まり、KPI の route は S13 が無いと 500 になる）。
- 当てた後は、Stripe の宛先に `charge.dispute.*` の5種を足し（本番の宛先が出来た時）、10分ごとの定期処理を登録する（[運用の手引きの 3・4](accounting-p2-posting-stripe.md)）。

### 手元で当てて確かめる手順（`--linked` は使わない）

1. `npx supabase db reset`（手元だけ。末尾の検査が落ちると取引ごと戻り、reset が止まる）
2. `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/accounting_p2 --runInBand`（`accounting_p2_*` の DB 結合）。計画1も流すなら `accounting_p1 accounting_p2` を並べる。
3. コミットする試験（`ACCOUNTING_COMMIT_SUITE=1`）は**単独の jest で1ファイルずつ**流し、前後に `db reset` を挟む。同じ jest にロールバックの試験を混ぜると、残った行で落ちる。PostgREST の試験（`accounting_p2_run_posting_postgrest`・`accounting_p2_kpi_monthly_records_postgrest`）は `LOCAL_SUPABASE_URL`・`LOCAL_SUPABASE_ANON_KEY`・`LOCAL_SUPABASE_SERVICE_ROLE_KEY`・`LOCAL_SUPABASE_JWT_SECRET` も要る。
4. E2E の後に DB 結合を流すときは、先に `npm run db:reset` する。

### G・H の試験に足した変更（計画2の移行が G のテーブルに外部キーを張るため）

計画2の表が G・H の表へ外部キーを張った（`accounting_g_slip_facts` と `accounting_shipment_checks` が `shipment_slips` へ、`accounting_unit_refund_allocations` が `order_line_unit_amounts` へ）ため、G・H の既存の試験の期待を次のように直した（試験のコードだけ。G・H の移行・関数・表は変えていない）:

- `group_g1_model`・`group_g3_model`: TRUNCATE の一覧と、`service_role` の権限の一覧に `accounting_g_slip_facts`・`accounting_shipment_checks` を足した。
- `group_h_migration_asserts`: `order_line_unit_amounts` の DROP を `cascade` にした。
- `group_g3_date` の `FREQ-535-AC-04`（「`shipment_date` を含む関数は G-3 の物だけ」）: 会計の出荷の係の5関数（S8）と年末の2関数（S14）を、許す一覧に足した。出荷日を読む会計の関数を足す計画は、この一覧を広げる。
- `group_g4_foundation` の `FREQ-540-AC-14`: `-- ACC_P<数字>_BEGIN … _END` の区間を両側から外して比べる。
- 計画1の `accounting_p1_migration_asserts`・`accounting_p1_manual_entry`: 公開の入口 `public.accounting_run_posting` が出来たため、「`public.accounting_*` が無い」確かめの再生で、先にこの関数を落とす。計画1の移行は変えていない。

## 交換の印と1着ずつの記録の移行 A（FREQ-642 Task 2、2026-11-10）

確認日: 2026-11-10。移行は [20261110090325_unit_binding_schema.sql](../../supabase/migrations/20261110090325_unit_binding_schema.sql)。サイズ 40191 bytes、MD5 `94b259bfdb388c14f81d232a64df527d`。ASCII・BOM なし・LF。手元の DB（`npx supabase db reset`）で当てて確かめた。**本番は未適用**（当てる前にオーナーの許可を取る）。適用済みの移行は1字も変えていない。版は `20261108230000` より後で、会計のセッションへ知らせる版はこの `20261110090325`。

| 項目 | 内容 |
| --- | --- |
| 目的 | 交換の印を着そのものに結び付け、返金を手元に残る服の正しい値段から決める（設計書 2-2・4-1〜4-4）ための表・注文の時の写し・前の注文の着数の数え直し・理由の設定 |
| 足した表 | `order_discount_snapshots`・`order_unit_slots`・`order_unit_exchange_links`・`order_unit_events`・`order_unit_event_lines`・`order_unit_holds`・`order_unit_event_refunds`・`order_return_line_treatments`（RLS・制限つきの方針・service_role は SELECT だけ。枠の表以外は追記だけで、UPDATE・DELETE・TRUNCATE は `GROUP_H_IMMUTABLE`。枠の表は DELETE・TRUNCATE だけ断る）。詳しい列は [er.md](../03_BasicDesign/data/er.md) |
| 取り替えた関数 | `private.group_h_copy_order_discounts(uuid,uuid,jsonb)`（今の本文に、写し 1 行と着ごとの枠を足すだけ）、`private.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text)`（前の注文の着数だけ変える）。署名・所有者・権限・`SECURITY DEFINER`・`search_path` は H4 のまま。G の書き手の一覧は変えない |
| 設定の UPDATE | `shop_return_reason_settings` の `defective`・`wrong_item` の `resolutions` を `exchange_only` にする（ほかの列・ほかの理由の行は変えない）。店長が設定の画面で変えていた値も、この2行は `exchange_only` に上書きされる |
| 末尾の確かめ | `UNIT_BINDING_SCHEMA_MIGRATION_ASSERTION_FAILED`（SQLSTATE `P0001`）。DETAIL は `ub_tables`（列・制約・守り）・`ub_acl`（RLS・権限・関数の権限）・`ub_functions`（取り替えた2本の本文の MD5・所有者・設定）・`ub_settings`（2行の値） |
| 古い試験への影響 | H4 の末尾の確かめは取り替えた2本の本文の MD5 を持つため、`group_h_migration_asserts` の試験は H4 のその2つの MD5 を、この移行のファイルが持つ MD5 へ置き換えて流す（H2・H6 の時と同じ書き方） |
| 戻し方 | 本番に当てた後に戻す時は、取り替えた2本を H4（`20261029130300`）の本文に戻す新しい移行を足す（適用済みの移行は直さない）。8 表は行が無ければ `DROP TABLE` できる。行ができた後は消さない（追記だけの表）。設定の2行は、戻す前の値を店長に確かめてから `UPDATE` する |
| 前の注文の着数 | 枠のある注文は `state = 'kept'` の枠の数、枠の無い古い注文は今までの式（入金済みの行の数 − 成功した返金の数）。交換の品の行は枠で数えるので足さない |
| 配備 | 移行 A は返金の計算を変えない（写しと枠を残し、前の注文の着数を数え直し、理由の設定を直す）。理由の設定の直しで、お客様の返品の申し込みと店長の返品の作成の画面は、初期不良・誤送のご希望を交換だけにする。返金の計算・入口の変更は後の作業で出す。**ただし移行 A だけを本番に当ててはいけない。** 移行 A の後、枠のある注文は返金・返品・発送前の取り消しが成功しても枠が手元にある（kept）のまま残り、お客様の前の注文の着数が減らない。枠を動かすのは Task 4〜6 の移行なので、それより前に作られた枠は直す道が無く、リピート割引の数え間違いが残り続ける。移行 A は Task 4〜6 の移行と一緒に本番へ当てる |

## 交換の印と1着ずつの記録の移行 B（FREQ-642 Task 4、2026-11-10）

確認日: 2026-11-10。移行は [20261110104605_unit_binding_core.sql](../../supabase/migrations/20261110104605_unit_binding_core.sql)。サイズ 45045 bytes、MD5 `e053ea34b5abc246f02a2ae14645a57d`。ASCII・BOM なし・LF。手元の DB（`npx supabase db reset`）で当てて確かめた。**本番は未適用**（移行 A と一緒に、当てる前にオーナーの許可を取る）。適用済みの移行は1字も変えていない。版は移行 A（`20261110090325`）の後で、会計のセッションへ知らせる版は A の `20261110090325` とこの `20261110104605`。

| 項目 | 内容 |
| --- | --- |
| 目的 | TypeScript の値段の計画（`planUnitEvent`）の材料を返し、計画を確かめて1着ずつの出来事として記録する DB の芯と、返金を着に結ぶ道具（設計書 4-1・5・7章） |
| 列の直し | `order_unit_events` の金額の10列（`entitlement_previous`・`entitlement_max_before`・`entitlement_gross`・`entitlement_shop_only`・`fee_amount`・`hold_total`・`entitlement`・`standard_refund`・`now_refund`・`consult_refund`）から `DEFAULT 0` を外す（`NOT NULL` は残す）。入れ忘れが黙って 0 にならず `23502` で止まる |
| 枠の守り | `order_unit_slots` に BEFORE UPDATE の守り `ub_order_unit_slots_guard`（`private.order_unit_slot_guard`）。鍵の列は変えられず、状態は `kept` から `returned_*` へだけ動く。返した枠の値段・持ち主は動かない。`returned_shop` から `kept` は、最後の出来事が `pre_shipment_cancel` の枠だけで、取引の中の設定 `app.unit_slot_revert` が今の取引の id（`select set_config('app.unit_slot_revert', txid_current()::text, true)` を UPDATE の直前に）と同じで、G の共通鍵を持っている時だけ（Task 6 の戻しの道が使う）。移行 A の末尾の確かめ（枠の表に UPDATE の守りが無い）は履歴で、新しい期待はこの移行の `ubc_schema` が持つ |
| 足した関数（読み手） | `private.order_unit_related_orders`・`order_unit_version`・`order_unit_totals`・`order_unit_order_state`・`order_unit_pricing_materials`（STABLE。材料。`service_role` が実行できる）。入口は `public.order_unit_pricing_materials(uuid)`（SECURITY INVOKER、`service_role` だけ）。写しの無い注文は `NULL`。版は `<対象と同じ会員の関わる注文に触った出来事の seq の最大（無ければ 0）>:<関わる注文の id の一覧の MD5>`（不透明な文字列。出来事なしに入金済みの注文が増えても変わる）。E の最高は 0 円を下限にする（注文の時の E） |
| 足した関数（書き手） | `private.order_unit_apply_plan(jsonb,uuid,uuid,uuid,uuid)`（確かめて記録する。誰にも実行を渡さない）、`private.order_unit_link_refund(uuid,uuid,text)`、`private.order_unit_outstanding(uuid)`、取り押さえの重ね定義 `private.group_h_claim_refund_units(uuid,uuid,integer[],boolean,uuid)` と `private.group_h_release_return_units(uuid,integer[])`（H5 の同じ名前の関数に、着の番号の一覧を取る版を足す。名前が同じなので `order_line_unit_amounts` の守りが通す）。計画を行に開く道具 `order_unit_plan_lines`・`order_unit_plan_holds`・`order_unit_plan_line_facts` |
| 断る時の記号 | 版が今と違う: `UNIT_PRICING_STALE`（`40001`）。計画が合わない: `UNIT_PRICING_INVALID`（`22023`）、DETAIL は `ub_plan_1`（形）・`ub_plan_3`（枠の状態・値段・出荷の印）・`ub_plan_4`（状態の移り方）・`ub_plan_5`（割り振り）・`ub_plan_6`（式と E の閉じ方）・`ub_plan_7`（前の E・E の最高・返す額）・`ub_plan_8`（E ≦ 払った合計・holds・手数料）・`ub_plan_9`（holds）。返金の結びの誤りは `ub_link_1`・`ub_link_2` |
| 末尾の確かめ | `UNIT_BINDING_CORE_MIGRATION_ASSERTION_FAILED`（SQLSTATE `P0001`）。DETAIL は `ubc_schema`（金額列の既定値・枠の守り）・`ubc_functions`（本文の MD5・所有者・設定・名前ごとの本数。取り押さえの2つは H5 の分と合わせて2本）・`ubc_acl`（関数の権限） |
| 古い試験への影響 | 移行 A の末尾の確かめを再生する試験は、再生の前にこの移行の枠の守りを落とす（A は枠の表に UPDATE の守りが無いことを期待していた）。出来事を直接入れる試験は、金額の10列を全部書く。H5・RR の末尾の確かめを再生する試験の道具（`withH5ReturnBaseline`）と RR の試験は、重ね定義の2つを外して再生し（巻き戻しで戻る）、元の11本の名前を引く所は重ね定義を除く |
| 戻し方 | 本番に当てた後は、新しい関数と守りを落とし金額列の既定値を戻す新しい移行を足す（適用済みの移行は直さない）。出来事・行・holds・結びができた後は表を消さない（追記だけ）。取り押さえの重ね定義は、使い手（Task 5・6）を戻した後で落とす |
| 配備 | この移行は、返金の計算の入口（受け取り・額を決めて返金・発送前の取り消し）をまだ変えない。**移行 A・B だけを本番に当ててはいけない。** 枠を動かすのは Task 5・6 の入口の変更なので、一緒に本番へ当てる |
