# テスト仕様

> 状態: 現行の方針（グループ G-1 のテストの節は 2026-10-24 に、グループ G-2 のテストの節は 2026-10-25 に追記し、Task 3 の在庫一覧表の分も同日に足した） | 確認日: 2026-10-25 | 対象: 要件からテストへの追跡、テストの層、開始・終了条件

## 概要

この文書は、要件からテストへの追跡方法、実行するテストの層、判定と記録の方法を定める。下表のテストファイルはリポジトリで確認した例であり、ここに列挙したことは実行・成功を意味しない。グループ G-1（在庫の割当）のテストは、層の説明の後の「グループ G-1（在庫の割当）のテスト」にファイル単位でまとめる。グループ G-2（発注・受け取り）のテストはその後の「グループ G-2（発注・受け取り）のテスト」にまとめる。

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

## グループ G-2（発注・受け取り）のテスト

対象要件は FREQ-525〜530・540（[要件](../../02_Requirements/requirements.md)の各受け入れ条件）。設計は[実装計画](../../superpowers/plans/2026-10-24-group-g2-purchasing.md)。実行の前提は G-1 の節の「実行の前提」と同じ（DB 結合は `npx.cmd supabase db reset` の直後と PostgREST の smoke の後に流す）。この節は Task 1（在庫の窓口の権限の切替、G-1 から持ち越した2件、公開関数11本の実行権）と Task 2（発注書の9表・追記専用トリガー・個別の権限・非公開の置き場）と Task 3（在庫一覧表の読取・窓口・画面・管理メニューの INVENTORY）の分で、後の Task が同じ節に足す。

### DB 結合（`tests/integration/db/`）

| テスト | 対応する受け入れ条件 | 確認する振る舞い |
| --- | --- | --- |
| `group_g2_stock_permissions.integration.test.ts` | FREQ-540-AC-06 | `admin.items.read/manage` だけの実行者の入荷は `GROUP_G_FORBIDDEN`／42501 で、台帳・在庫・操作が増えない。`admin.stock.manage` だけ・`admin.stock.read` だけもどちらも断られ、両方で入荷できる（`supporter` に取引内で `role_permissions` を足し、最後に rollback）。2つの役割に権限が分かれて付いても有効な役割の和集合で通り、無効・期限切れの役割は数えない。実行者の無効・期限切れ・役割なし・権限の欠落を毎回確かめる。公開 `admin_record_stock_movement` は service_role だけが EXECUTE でき、所有者 postgres・`search_path` 空・SQL の INVOKER のまま。部品 `group_g_actor_has_permissions` の真偽表（NULL・空配列・未登録・重複・和集合）と、誰にも EXECUTE を付けないこと |
| `group_g2_g1_followups.integration.test.ts` | FREQ-525-AC-03、FREQ-535-AC-01 | `group_g_open_work_order_ids`（受注生産の数がありうる注文の先絞り）が、閉じた注文12件（取消・期限切れの失敗・放棄・発送済みで未解決なし・解決済みの返金／返品／取消申請）と、入金の記録が無い `pending`／`failed`／`payment_in_progress` を返さず、`paid`・入金の記録（`paid_at`／`paid_amount`）がある `pending`／`failed`・未解決の返金／返品／申請／発送前返金の失敗がある `shipped` の11件を昇順で返す（NULL は全バリアント、空配列は空）。発送済みの注文は、未発送で取り消されていない数がある時（発送の記録が無いものを含む）か未解決の作業がある時だけ残り、全部発送済み・残りが発送前返金で覆われたものは外れる（発送か割当のある取消の注文は残す既知の費用）。`lock_group_g_inventory` は G-2 の移行が置き換えず、その閉包は閉じた注文12件を入れず、開いた注文11件に加えて `pending`・`payment_in_progress`・期限切れでない失敗の4件を入れる（割当か保留が残る注文は状態に関わらず入る）。先絞りは投影が受注生産と数える注文の上位集合で、`list_group_g_variant_inventory` の `waiting` は、絞らない投影（`group_g_item_state_ranges` を variant の全注文に掛けたもの）と variant ごとに同じ数（paid・一部割当・入金済みの pending／failed・割当だけ／発送だけの入金記録なしの注文・取消の後の割当や発送・取消申請・発送前返金の失敗・発送の記録が無い発送済み・取消／放棄／支払い手続き中・全部発送済み・発送前返金で覆われた発送済みの注文を混ぜる）。置換した関数の署名・所有者・ACL・戻り型・volatility が G-1 のまま。`orders.paid_at` の最初の値は共通の鍵を持たない接続（共有モード・別の鍵も含む）では `GROUP_G_INVENTORY_LOCK_REQUIRED`、持てば通り、値から別の値・NULL は `GROUP_G_PAID_AT_IMMUTABLE`（service_role の役も）。`mark_order_paid` は押さえの無い取引から呼んでも自分で取って書く |
| `group_g2_public_function_acl.integration.test.ts` | FREQ-540-AC-09 | 公開関数11本（`increment_rate_limit_counter` は2つの overload を別々に）が、reset 直後の DB で anon / authenticated に EXECUTE を許さず `proacl` に PUBLIC も無く、service_role と postgres は保つ。anon / authenticated の役で `revoke_auth_sessions_for_user`・`revoke_auth_session`・`is_auth_session_active`・`find_auth_user_id_by_email` を呼ぶと SQLSTATE 42501 で何も消えない。service_role の役では `is_auth_session_active`・`revoke_auth_session` が動く。移行の末尾の確かめ（`public_function_acl`）が、anon／authenticated／PUBLIC の付与・service_role の剥奪・関数の欠落で止まる。移行の形（11本の REVOKE が1文、11本への GRANT なし、private スキーマの USAGE を触らない）も DB なしで確かめる |
| `group_g1_stock_api.integration.test.ts`（G-2 で変更） | FREQ-540-AC-06 | 在庫の窓口の権限の事例を `admin.stock.manage` を外す・`admin.stock.read` を外すに変えた（G-1 では `admin.items.manage`） |
| `group_g2_purchase_model.integration.test.ts` | FREQ-530-AC-01（モデルの基盤の確かめの全て: 追記専用・権限・置き場・末尾の確かめ・発注書と明細の制約・更新の守り・受け取りと納品数。題は FREQ-526／527／529 の受け入れ条件がまだ無かった Task 2 の時点では分けて付けていたが、モデルの確かめは FREQ-530-AC-01 に揃えた。個別の振る舞いの受け入れ条件は後続の Task が作る） | ①追記専用の7表は owner／service_role の通常の SQL の UPDATE・DELETE・TRUNCATE を `GROUP_G_HISTORY_IMMUTABLE`／55000 で断る（TRUNCATE は指す側の表を同じ文に並べる）。②`purchase_orders`・`purchase_order_lines` は DELETE・TRUNCATE を断り、UPDATE は識別の列（`GROUP_G_PURCHASE_ORDER_GUARD`、`immutable_column`）・版 +1（`version`）・共通の鍵の保持（`GROUP_G_INVENTORY_LOCK_REQUIRED`）を守る（何も変わらない更新は鍵も版も要らない）。③行の制約: 発注番号の書式と一意、発注先・メモの文字数、段階、仮数量 1〜99999・確定数量 0〜99999・単価 0〜9999999、確定数量は納品済み以上、未確定の納品数は 0、`outstanding_quantity` の生成値、単価の NULL と 0 の区別、発注書内の variant／行番号の重複拒否、履歴の NULL の `line_id` も同じ値とみなす一意、受け取りの種類と理由の組、受取行の数量と符号と相殺元の組、台帳の行・受取の行の一意、原本の種類・大きさ（1〜20971520）・SHA-256・出所、取引の記録の日付・金額・通貨・取引先・版と理由。操作の受付への5本の外部キーは遅延で、全21本が `ON DELETE RESTRICT`。④`received_quantity` が受取行の合計と違うと commit（遅延の確かめ）で `GROUP_G_PO_RECEIVED_MISMATCH`。⑤受取行は同 variant・同数量の無タグの台帳行（正は `restock`、負は `adjustment`）にしか結べず、タグ付き・別 variant・数量違い・理由違い・存在しない行・別の発注書の明細は `GROUP_G_PO_RECEIPT_LINE_MISMATCH`、受け取りの種類と行の符号は結ばれていて（種類 `receive` の受け取りは正の行だけ、種類 `reverse` の受け取りは負の行だけ。違えば同じ `GROUP_G_PO_RECEIPT_LINE_MISMATCH`／23514、`DETAIL` は `kind`。Task 2 のレビューの持ち越し M1）、負の行は同じ発注書・同じ明細の種類 `receive` の中の正の行にしか結べず、相殺の合計が元の数量を超えると commit で `GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED`。⑥9表の RLS・所有者・拒否だけの方針、PUBLIC／anon／authenticated は列権限を含め何も持たず、service_role は原本と予約の2表の `SELECT` だけ（`MAINTAIN` を含めて意味で比較）、役の下の直接の読み書きが 42501。3つのトリガー関数の所有者・`search_path`・実行権。⑦置き場 `purchase-order-documents` は非公開・20971520・3つの MIME、`storage.objects` に方針が無く、anon／authenticated は読めず・直せず・消せず・足せない（足すのは 42501）、service_role は読める。⑧移行の末尾の確かめ（`$g2a_final_objects$`・`$g2a_final_table_acl$`）は今の DB で通り、RLS・行・方針・列・制約・索引・トリガー・関数・置き場・権限の変更で `purchase_*` の項目名とともに止まる。移行の形（9表・置き場の行は1つ・`storage.objects` の方針と sequence を作らない・BOM と CR が無い。1本あたり 100,000 バイトの上限は外した）は DB なしでも確かめる |
| `group_g2_inventory_list.integration.test.ts` | FREQ-525-AC-01・AC-02・AC-03、FREQ-540-AC-07 | 在庫一覧表の読取 `list_admin_inventory(_actor_id)`（private 本体と public 入口）。①注文数5（支払い済み5点のうち2点が割当済み(ready)、3点が受注生産中）・在庫2・発注済み1（確定済み発注の未納）の variant は発注必要数2。②在庫を超える発注済みでも発注必要数は0未満にならない。複数の発注書の未納は variant ごとに合計。③戻り列は `list_group_g_variant_inventory` と同じ `free`／`paid_allocated`／`payment_held`／`on_hand`。④未払いの仮確保は在庫（`on_hand`）に入り注文数に入らず、取消申請中・返品申請中の数量も注文数に加えない。⑤発注済みは数量確定済みの行の未納だけで、仮数量は数えない。打切り（確定数量を納品数まで下げる）後は未納0で発注必要数が戻って増える（Task 6 の関数が無い間は直接 INSERT／UPDATE の材料で確かめ、Task 6 で関数経由へ置き換える）。⑥停止 variant は在庫・未納・未完了の注文のどれかがある間だけ出て、無くなれば消える（`is_active` は変えない）。⑦並びは商品・色の位置・サイズの位置・variant の番号（色もサイズも無い variant は最後）。⑧読取の前後で `item_variants`・色・サイズ・台帳・割当・割当の履歴・状態の履歴・操作の受付・発注の表の行数と在庫の合計が変わらず、`items.colors`／`sizes` だけの商品に variant を作らない。private 本体と public 入口が同じ行を返す。⑨`admin.stock.read` を持たない実行者（無効・期限切れ・役割なし・`admin.items.*` だけ・`admin.stock.manage` だけ・存在しない実行者・NULL）は `GROUP_G_FORBIDDEN`／42501 で行を返さず、`admin.stock.read` があれば読める（役割をまたいだ和集合も）。権限を外すとその場から断られる。⑩private 本体と public 入口は所有者 postgres・`search_path` 空・`STABLE`・戻り列13つで、PUBLIC／anon／authenticated に EXECUTE が無く service_role だけが持つ（public 入口は SQL の INVOKER）。anon／authenticated は両方とも 42501、service_role は public 入口から読める。⑪（AC-03）一覧の `order_quantity` は、先絞りをしない投影（その variant を持つ全注文を `group_g_item_state_ranges` に渡した `in_production` + `ready`）と variant ごとに同じ（入金済み・一部割当・仮確保・入金の記録がある pending／failed・取消申請・発送の記録が無い発送済み・取消・放棄・支払い手続き中・一部発送・返品申請中を混ぜ、全部 0 で一致したのではないことも確かめる）。移行の形（本体は何も書かず実行者の確かめが最初・`$g2a_final_inventory_list$` を足す）は DB なしでも確かめる |
| `group_g1_model.integration.test.ts`・`stock_movements.integration.test.ts`（G-2 で変更） | FREQ-530-AC-01 | 操作の受付を指す外部キーの期待に G-2 の5本を足し、操作の受付・台帳の TRUNCATE を断る試験は、新しく指す表（発注書の履歴・受け取り・原本の7表）を同じ文に並べた（外部キーの確かめがトリガーより先に走るため） |

### 単体・E2E

| テスト | 層 | 対応する受け入れ条件 | 確認する振る舞い |
| --- | --- | --- | --- |
| `tests/unit/lib/auth/admin-rbac.test.ts`（`authorizeAdminPermissions`） | 単体 | FREQ-540-AC-06 | 要るコードを全部持つ時だけ通し、有効な全ての役割の和集合で数える。403 の `permission` は足りない最初のコード（渡した並び順）。MFA（aal2）が無い時の本文は既存と同じで `permission` は先頭の要るコード。トークンの不通過は401、失効は401、確認不能は503、空の一覧は500。`authorizeAdminPermission` は `authorizeAdminPermissions([code])` と同じ結果 |
| `tests/unit/lib/auth/role-permission-catalog.test.ts` | 単体 | FREQ-540-AC-06 | 30コードの順・分野・ラベルは同じで、`upcoming`（準備中）は未使用の4コードだけ |
| `tests/unit/api/admin/item-variants-route.test.ts` | 単体 | FREQ-540-AC-06 | GET は `admin.stock.read`、POST は `admin.stock.manage` ＋ `admin.stock.read`。`items.read/manage` だけは GET・POST とも403（`permission` は stock 側）、`stock.read` だけは GET 200・POST 403、`stock.manage` だけは POST 403（`permission:'admin.stock.read'`）、両方で POST が進む。認可 → CSRF → IP → actor → 検証 → RPC の順は変えない |
| `tests/unit/components/ItemStockSection.test.tsx` | 単体 | FREQ-540-AC-06 | 読み込みの403は「在庫を見る権限がありません。」、記録の403は「在庫を変更する権限がありません。」を `role="alert"` で出し、Forbidden や一般の失敗の文は出さない。403 以外は今までの文のまま |
| `tests/unit/components/RolePermissionsSection.test.tsx`・`e2e/FR-ADMIN-109-permission-settings.spec.ts` | 単体・E2E | FREQ-540-AC-06 | 権限画面の「準備中」の印が4件になった（G-0 では9件） |
| `tests/unit/lib/inventory/inventory-list.test.ts` | 単体 | FREQ-525-AC-01、FREQ-540-AC-07 | `calcRequiredQuantity`（5・2・1 → 2、在庫と発注済みが多い時と全部0の時は0で負にならない）。store `listAdminInventory` は RPC を `list_admin_inventory` ＋ `{ _actor_id }` で1回だけ呼び、列を画面の形へ写し、DB の並びを変えない。`onHand` が空き＋入金済みの割当＋仮確保と違う・`required` が式と違う・負・小数・文字列・上限超え・`variant_id` が0や文字列・型の崩れ・重複・配列でない応答は `INVENTORY_READ_FAILED`。DB の `GROUP_G_FORBIDDEN`＋42501 の組だけが 403 の `AdminInventoryError`（片方だけの一致は信用しない）。通信の失敗・他の誤りは固定の文で、生の文も `cause` も持ち出さない |
| `tests/unit/api/admin/inventory-route.test.ts` | 単体 | FREQ-525-AC-01・AC-02、FREQ-540-AC-07 | `GET /api/admin/inventory`: `admin.stock.read` で認可し `authz.userId` を実行者として RPC を1回だけ呼び、200 `{ rows }`・`Cache-Control: no-store`。`backfill_item_variants` は呼ばない。`stock.read` だけで200、`items.*` だけ・`stock.manage` だけ・権限なしは403で RPC を呼ばない。認可の401／403（MFA の `reason`）／503 は状態・本文・`Retry-After` を保って no-store。DB の権限の拒否は 403 の固定の文、RPC の誤り・応答の崩れ・クライアントの失敗は固定の 500 で、本文にもログ（固定の1文）にも生の誤りを出さない |
| `tests/unit/lib/admin/admin-load-failure.test.ts` | 単体 | FREQ-525-AC-01、FREQ-540-AC-07 | `adminLoadFailureMessage`: 本文の `reason: 'MFA required'` →「2要素認証が必要です」（状態の番号より先）、401 →「ログインし直してください。」、403 → 呼び出し側が渡した権限の文、それ以外 → 失敗の文。本文が読めない形（null・文字列・数・配列・`reason` が文字列でない）でも MFA とは見なさない |
| `tests/unit/components/AdminInventorySection.test.tsx` | 単体 | FREQ-525-AC-01・AC-02、FREQ-540-AC-07 | h1「在庫一覧表」・「管理画面に戻る」(/admin)・読込中（`role="status"`）。列見出しは「商品名・色・サイズ・注文数・在庫・発注済み・発注必要数」の7つがこの順で、行は7つのセルを同じ順に持つ。色・サイズが無ければ「—」で、止めた variant も同じ7つのセルの行で出る（特別な印は付けない）。「在庫の内訳」ボタン（行ごとの `aria-expanded`）で「空き ○・入金済みの割当 ○・支払い前の仮確保 ○」を開閉し、Enter・Space でも開け、行は押しても何も起きない。表は見出しを保ったスクロール領域（`overflow-auto`・`max-w-full`・`sticky` の見出し）。空は「表示する商品がありません。」だけ。403 →「在庫一覧を見る権限がありません。」、MFA なしの403 →「2要素認証が必要です」、401 →「ログインし直してください。」、その他・通信失敗・応答の崩れ →「在庫一覧を読み込めませんでした。時間をおいて再度お試しください。」を `role="alert"` で出し、表とボタンを出さない |
| `tests/unit/components/AdminSettingsMenu.test.tsx`・`e2e/FR-ADMIN-029-accounting-tab.spec.ts`（G-2 で変更） | 単体・E2E | FREQ-525-AC-01 | 店長のタブは ORDER の次に INVENTORY が並ぶ（… ORDER・INVENTORY・SETTINGS）。サポートの人のメニューは ORDER と INVENTORY で、SETTINGS と「権限」は出ない（G-1 までは ORDER だけだった）。INVENTORY を押すと `nav`「在庫・発注メニュー」に「在庫一覧表」(/admin/inventory)・「発注一覧表」(/admin/purchase-orders) のリンクが並び、店長もサポーターも同じ中身。`tab=INVENTORY` で直接開ける（サポーターが先頭以外のタブを `tab` で指しても ORDER に戻されない）。INVENTORY の外では出ない。FR-ADMIN-029 の期待は同じ並びに直した |
| `tests/unit/components/ItemStockSection.test.tsx`（G-2 Task 3 で追加） | 単体 | FREQ-540-AC-06 | 読み込みの失敗の文を `adminLoadFailureMessage` へ切り替えた: MFA なしの403は「2要素認証が必要です」（「権限がありません」と誤って出さない）、401は「ログインし直してください。」、本文が JSON でない403・500でも権限の文・取得失敗の文に落ちる |
| `tests/unit/docs/delivery-status-traceability.test.ts`・`tests/unit/docs/order-status-traceability.test.ts`（G-2 Task 3 で変更） | 単体（文書） | FREQ-540-AC-07 | FREQ-540 の G-2 の追加 AC（`G2_FREQ_540_ADDITIONS`）に AC-07 を足した（G-1 の AC-01〜05 は先頭に固定のまま）。新しい route `GET /api/admin/inventory` に合わせて、Route Handler の数を 133 ファイル・172 メソッド（E2E 用の入口を除く表は 132 行・171 メソッド）に直した |

## リスクに応じた優先順位

決済・注文状態・在庫、認証・権限、マイグレーション・RLS、証憑アーカイブを優先する。これらは単体テストに加え、必要な API/E2E と実環境の運用確認を選ぶ。外部サービスのモックを使うテストは契約の一部を確認するだけであり、Webhook 配信や本番 DB の状態を証明しない。

## 開始・終了条件

開始前に変更範囲、対応要件、対象リビジョン、必要な環境変数とテストデータ、ポート 3000 の実サーバーを確認する。終了時は対象テストを実行し、失敗を分類して修正または未解決として記録する。要件ごとの判定には実行ログと環境を添える。対象外テストや未実施の本番確認を成功扱いしない。
