# テスト仕様

> 状態: 現行の方針（グループ G-1 のテストの節は 2026-10-24 に追記） | 確認日: 2026-10-24 | 対象: 要件からテストへの追跡、テストの層、開始・終了条件

## 概要

この文書は、要件からテストへの追跡方法、実行するテストの層、判定と記録の方法を定める。下表のテストファイルはリポジトリで確認した例であり、ここに列挙したことは実行・成功を意味しない。グループ G-1（在庫の割当）のテストは、層の説明の後の「グループ G-1（在庫の割当）のテスト」にファイル単位でまとめる。

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
| `tests/unit/components/AdminGroupG1LegacyStop.test.tsx` | 単体 | FREQ-524-AC-03、FREQ-540-AC-05 | 注文の一覧と履歴で、旧の発送・発送の取消・伝票番号の訂正・手動の配達済み・仕上がりの入口を出さず、固定の停止文を1回ずつ出す。取消・返金・返品・申し込み・履歴・メールの再送は残る |
| `e2e/FR-ADMIN-123-group-g-permissions.spec.ts`（G-1 の部分） | E2E | FREQ-524-AC-03、FREQ-540-AC-05 | 旧配送・手動仕上がりの窓口7メソッドが、ログインなしで 401、お客様で 403（410 には届かない）。店長とサポーターの注文の一覧と履歴に旧の入口が無く、固定の停止文が出て、取消・返金・返品・履歴の読み取りは残る（3幅）。認可済みの 410 の本文は差し替えの形の確認で、HTTP の証拠は窓口の単体と DB 結合 |

同じファイルの G-0 の部分（権限の画面と保存）は FREQ-540-AC-01〜04 の対応で、この節では扱わない。全件の E2E は最新の基準と比較し、停止・削除・追加と未確認の範囲を分けて記録する（FREQ-541-AC-02）。

## リスクに応じた優先順位

決済・注文状態・在庫、認証・権限、マイグレーション・RLS、証憑アーカイブを優先する。これらは単体テストに加え、必要な API/E2E と実環境の運用確認を選ぶ。外部サービスのモックを使うテストは契約の一部を確認するだけであり、Webhook 配信や本番 DB の状態を証明しない。

## 開始・終了条件

開始前に変更範囲、対応要件、対象リビジョン、必要な環境変数とテストデータ、ポート 3000 の実サーバーを確認する。終了時は対象テストを実行し、失敗を分類して修正または未解決として記録する。要件ごとの判定には実行ログと環境を添える。対象外テストや未実施の本番確認を成功扱いしない。
