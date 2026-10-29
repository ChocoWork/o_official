# グループ H 割引（プロモーションコード・自動割引）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 店の管理画面でコードと自動の割引を作り、割り当て・併用・一番お得な組み合わせ・使用回数を店のサーバーで決め、注文の行別割引と１着ごとの支払額を決済・返品・返金・注文の表示で共有する。

**Architecture:** 純粋な TS のエンジンが、DB から受け取った設定と購入資格の事実だけで割引を計算する。確認へ進む時に結果と事実を draft に固定し、合計だけを１回限りの Stripe coupon に渡す。受付の DB 関数は固定結果を写して使用を予約し、入金の反映と未入金の終了が予約を確定・取り消す。管理の読取と書込は private の本体と service_role 専用の public 入口に分ける。H の注文は保存した１着ごとの額で返金し、記録の無い旧注文は今の計算を残す。

**Tech Stack:** 現行の Next.js `^16.3.6`、React `^19.0.0`、TypeScript `^5`、Supabase Postgres 17・PostgREST、Stripe SDK `^20.4.1`（Checkout Session `ui_mode: 'custom'`）、Zod `^4.3.6`、`pg`、Jest、React Testing Library、Playwright。依存を増やさない。

**Spec:** [承認済み H 設計](../specs/2026-10-28-group-h-promotions-design.md)の全18章、D1〜D16、C1〜C19を正本とする。[現状調査](../../../.superpowers/sdd/2026-10-28-group-h-promotions/recon-report.md)・[Shopify の調査](../../../.superpowers/sdd/2026-10-28-group-h-promotions/shopify-research.md)は現状と出典の手掛かり。[G-4 計画](2026-10-26-group-g4-orders.md)・[G-3 計画](2026-10-25-group-g3-shipping.md)の形式と DB/API/検証の境界を引き継ぐ。承認済み判断を基礎とし、その後のcontroller裁定とC20〜C22の設計者判断は「決めたこと」に日付と差分を明記する。決められない所は末尾「未確認事項」に置く。

## 概要

確認日2026-10-29、基準 `master / 0daeb6dc`。この文書を書く作業は計画だけで、実装・DB・provider・ブラウザーの成功を表さない。

| Task | 中身 | 移行 | FREQ | 検証 |
|---|---|---|---|---|
| 1 | ７表・draft の固定欄・２権限・目録32件・ACL・旧注文の行割引 | H1 foundation | 542・543 | DB/単体 |
| 2 | 純粋な割引エンジン・最適な組み合わせ・１着ごとの額 | — | 544〜546 | 単体 |
| 3 | 管理の書込/読取・割り当て表・使い捨て・資格の読取 | H2 admin | 543・547 | DB/並行 |
| 4 | 管理 API・store・入力/拒否/監査の契約 | — | 543・547 | 単体 |
| 5 | DISCOUNT タブ・一覧・詳細・フォーム・会員検索 | — | 547 | RTL |
| 6 | コードの検証・draft の固定・Stripe coupon | H3 checkout | 548 | 単体/DB |
| 7 | 受付・予約・入金・期限切れ・上限超過の要対応 | H4 acceptance | 549 | 単体/DB/並行 |
| 8 | checkout/カートの複数コードと内訳・商品の案内 | — | 550 | RTL/単体 |
| 9 | 安い着からの返金・返品・G-4 の状態別金額 | H5 refunds | 551 | 単体/DB |
| 10 | メール・会員詳細・注文状況・管理詳細の内訳 | H6 views | 552 | 単体/DB |
| 11 | 新しい E2E と既存４本の接続替え | — | 543〜552 | 本番 build/手元 DB |
| 12（controller） | 全体検証・最終 Opus レビュー・本番読取・owner確認・適用・記録 | — | 全部 | baseline比較 |

**決めたこと（ruling）**

- D1〜D16・C1〜C19を実装する。送料は0円、送料割引・ポイント・ギフトカード・割引レポート・会計の仕訳の変更・取り消し線の価格・専用のセット商品は作らない。名称を表示するための自動メール配信やコード配布メールも足さない。
- 移行は６本。`supabase/migrations/<ts1>_group_h_discounts_foundation.sql`、`<ts2>_group_h_discounts_admin.sql`、`<ts3>_group_h_discounts_checkout.sql`、`<ts4>_group_h_discounts_acceptance.sql`、`<ts5>_group_h_discounts_refunds.sql`、`<ts6>_group_h_discounts_views.sql`。時刻は wave 5 の末尾より後に controller が実装時に採番し、H1〜H6の順にする。過去の移行を編集しない。
- 名前・コード・設定は注文時の写しを残す。管理で名前を変えても、既存注文の内訳は変えない。１つの割引に共有コード１つ、または使い捨ての束を持たせる。同じ割引の別コードを同じ注文へ入れても効果は１つだけで、使用も１回だけ。
- 最適化は50円の下限後の実割引額最大→使用code数最少→割引数最少。同じならdiscountId/codeIdの辞書順で決め、個々のlineKey/unitIndexは採用する割引の組が決まった後だけ安定順で使う。下限へ戻す時は注文割引のdiscountId降順から削り、足りなければ商品割引の同順/groupの逆順から削る。0額の効果は使用に数えない。
- 金額の中間積は TS で `bigint`、SQL で `bigint`/`numeric` を使う。外へ返す円は `0..2147483647` の整数。１着を `(lineKey, unitIndex)` で識別し、`unitIndex` は0始まり。`lineKey` は `cart_lines.id` の UUID（draft snapshot の `source_cart_line_id`）で、受付時にその snapshot の行と新しい `order_items.id` の対応を作る。商品判定は `item_id`、色・サイズは区別しない。
- Hの７表は直接DMLを許さない。照合の回復をredemptions.reconciliation_fallbackへ残し、確定時の要対応は上限/１人１回/単発code超過なら`discount_limit_exceeded`、それ以外のfallbackなら`discount_reconciliation_recovered`とする（controller裁定4）。labelはそれぞれ「割引の上限を超えた注文」「割引の条件を確認する注文」。payment exceptionの配送停止へ混ぜず、同注文の注意を１欄にまとめる。
- **controller裁定（2026-10-29、review 1/3）:** aal2と結び付いたlive sessionはwave 5後のrouteの`authorizeAdminPermission`が確認し、DBはservice_role専用入口の`_actor_id`からGと同じ有効な役割の権限だけを確認する。SQL/TS目録を30→32件へ広げ、H1で２権限を登録して店長（role code=`admin`）だけへ付与し、店長の`roles.permissions_version`だけを1増やす。サポーターの既存８件と他の付与は変えない。これは許可された権限の初期登録で、既存業務データの清掃・補完はしない。
- **controller裁定（2026-10-29、review 6、仕様2.3/9.1の優先）:** 未ログインの買い手には、使えないコードの全理由（不在・割当限定・会員限定・期間・上限・最低条件など）を同じ文「このコードは使えません。会員の方はログインしてからお試しください。」で返す。ログイン済みはassigned-onlyとmember-onlyの全拒否を「このコードは使えません」、guestも許すanyoneコードは仕様9.1の期限/上限/最低額の文を保つ。ゲストへ理由の違いも返さない。
- **controller裁定（2026-10-29、review 4/5/8）:** guestのメールに結び付く初回/１人１回はpreviewではメールを入れた後も「見込み」のまま、記録を読むのはcreate-sessionとplace-orderだけ。照合のpaid/awaiting両fallbackは現在の割引条件で拒否せず、awaitingは予約、paidは確定と必要な要対応へ進む。create-sessionの`checkout_drafts.discount_amount`は0のまま、割引は`discount_result`だけへ固定する。
- **設計者の提案（2026-10-29、C20案、ownerが覆せる）:** 要対応の「確認済みにする」は金額と使用履歴を変えず注意の表示だけを閉じる。Task 7で仕様16章へC20案として記録し、Task 12で追加判断としてownerへ示す。D1〜D16/C1〜C19の承認済み判断とは区別する。
- **設計者の判断（2026-10-29、C21、オーナーが覆せる）:** 同時に有効な自動割引で併用チェックが１つでもONの物は、商品側・注文側それぞれ **N=6件** まで。全自動25件/入力コード５件は維持し、重ねない自動割引は残りの枠で使える。作成/期間変更/再開を保存する時に未来の重なりも検査する。件数以外の保存時探索予算は設けない。最大カートの試作計測840回・最大23.83msと候補数の上界はTask 2に記す。C6を狭める追加判断なのでTask 12でownerへ明示し、本番適用の判断に含める。
- **controller裁定・設計者の判断（2026-10-29、C22、オーナーが覆せる）:** 「一番お得」は割引の採否の組み合わせだけで選ぶ。選んだ商品/リピート割引は対象全着へ効き、同じ着は一番大きい効果１つ。セットが着を取る強さも、１組額を単価比・累積丸めでその着へ配った額と他の商品効果の１着額で比べる（同額はdiscountId昇順）。強い他効果に取られた着を除き、採用セットは最大の完全な組へ全て効かせる。これはC17の「全体で一番お得」を、この１着比較を満たす全適用の割引集合の中へ限定する判断。組全体の額と他効果の損失合計を比べて着を取り直さない。セット組数を減らして注文の最低額を残す選択はしない。商品/単価groupの数量は評価用の事実で、探索変数でもmemoの金額キーでもない。
- **controller裁定（2026-10-29、round 2 N1/guest初回）:** confirm/place-orderで条件を失った自動割引は黙って外して再計算し、新しい額を最終確認に表示する。入力コードだけが不適合なら409で入力へ戻し確定した拒否として保持する。guest初回もmemberと同じく入金済み以降の注文だけを数え、未入金/放棄/期限切れ/入金前取消と今作る注文自身は除く。
- **セットの保存規則（2026-10-29）:** 「商品の割引と重ねる」がONのセット同士は、有効期間が重なる時に同じitemを含められない。コード/自動を問わずDB writer・constraint trigger・schemaで同じ規則を守る。終端と次の開始が同時なら重複しない。共有を許す別案は採らない。
- **確認済みの出典（2026-10-29、H-STRIPE-MIN-JPY）:** [Stripeの最低請求額](https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts)はJPY 50円、[Shopifyの併用上限](https://help.shopify.com/en/manual/discounts/discount-combinations)は自動25/商品・注文コード5。C2/C6はこの値で固定し、原典の再確認待ちを適用条件にしない。テストモードでの50円の動作確認はTask 12の検証に残す。

## Global Constraints

- 今回の成果物はこの計画１ファイルだけ。実装は後日 master で行い、実装者はコミットせず controller が各 Task の Files だけを確認して記載のメッセージでコミットする。既存差分 `.claude/CLAUDE.md`・`package.json`・`.superpowers/` を保持し、ブランチ/worktree・pushを作らない。
- Task 1はwave 5のコミット後にだけ開始する。Hのservice_role＋actorのDB試験はJWT/sessionを作らず役割を検査し、既存RLS/has_permissionを回帰する試験だけ`tests/integration/db/helpers/app-session.ts`の`createLiveAppSession`・`jwtClaims`を使う。route/E2Eのaal2/live-session試験は`e2e/admin-session-test-utils.ts`の`createAdminSessionActor`（wave 5のapp結付け済み）を使う。
- `src/app/api/checkout/**`・`src/lib/checkout/**`・`src/features/checkout/**` を編集する各 Task の最初に controller が別セッションへ対象と開始を知らせ、最新差分を読んでから編集する（Task 6・7・8）。
- 各移行の最初の行は`BEGIN;`、最後は末尾assert→`NOTIFY pgrst, 'reload schema';`→`COMMIT;`の１組だけ。UTF-8/BOMなし/LF、SQLのコメントと文字列もASCII。移行実行時のDMLは新規７表だけとし、H1の２権限の`permissions`登録・adminだけの`role_permissions`追加・adminの`permissions_version + 1`だけを例外とする。他の既存データの清掃・補完・再投入はしない。
- 新しい本体は private・所有者 postgres・`SECURITY DEFINER SET search_path = ''`・完全修飾名、public 入口は同名同引数同戻り型の `LANGUAGE sql SECURITY INVOKER`・service_role のみ EXECUTE。委譲先のprivate本体もservice_roleだけにEXECUTEを許し、PUBLIC/anon/authenticatedを個別REVOKE、入口の無い内部helperはservice_roleからもREVOKE、private schema の USAGE を一括変更しない。
- 全移行に `-- H1_FINAL_ASSERT_BEGIN/END`（H2〜H6は数字だけ変更）を置き、失敗は `GROUP_H_MIGRATION_ASSERTION_FAILED / P0001`、DETAILはこの計画の固定コードだけ。表/列/CHECK/FK/索引/RLS/所有者/ACL/関数属性/余分なoverload/直接DMLの不許可を意味で検査する。
- Hの業務書込のロック順はG共通`pg_advisory_xact_lock(190521,1)`→H目録`(190522,0)`→本人キー`(190523,hashtext(identityKey))`→割引id昇順→G既存の在庫/注文/明細/返品/返金の順。G共通鍵が全体を直列化し、本人/割引鍵は二重の守り。待ちの観測はG共通鍵で行い、結果の１件成功/１件拒否を検査する。routeがaal2/live session、DBが`private.group_g_actor_has_permissions(_actor_id,...)`で役割権限を検査する。
- 管理の書込は認可 → CSRF → `enforceRateLimit`（IPとactor）→zod→DB関数→監査。actorは`authz.userId`だけ、IPは`src/lib/request-ip.ts`の`getClientIp`だけから取り、コード・メール・名前・検索語・トークン・生のDBエラーを監査/ログ/返答に入れない。
- 管理の読取は成功/失敗とも `Cache-Control: no-store`、画面のfetchは非okも本文を読み切るか`response.body?.cancel()`をawaitする。cloneだけを読んで元のbodyを残さない。
- DISCOUNT は `src/app/admin/page.tsx` の CONTACT 直後。２権限は `admin.discounts.read` と `admin.discounts.manage`、SQLのGET/SET目録・TS型/表示目録・API配列上限・store配列上限/changedCount上限を同時に32へそろえる。
- ％は1〜99、円は1以上、円引きは最低額必須かつ最低額>割引額、コードは大文字保存で`^[A-Z0-9-]{1,64}$`、最大５コード・同時有効自動25・併用ONの自動は各分類６件・セット2〜10種類各１着・併用ONセットのitem重複禁止・束１回1〜100。生成は接頭辞＋`-`＋4〜8字、0/O/1/I/Lなし、接頭辞だけは無効。
- 合計は50円以上、整数円、商品％は１着ずつfloor、商品→注文の順、同じ着の商品割引は１つ、併用は双方の許可、複数の注文割引は同じ商品割引後の基数で計算。円の配分は`floor((2*D*S+T)/(2*T))`の累積差、総和を必ず保存額に合わせる。
- 期間は `startsAt <= now < endsAt`（終わりnullは無期限）、画面入力/表示はAsia/Tokyo、DBはtimestamptz。使用回数はreserved+confirmed、cancelledは除外。入金後の取消/返品/返金でconfirmedを戻さない。
- guest本人キーはメールのtrim/lowercase、会員は検証済みuserId。preview/カート/商品広告は入力メールを記録照合へ使わず、guestの初回/１人１回を常に「見込み」にする。create-sessionとplace-orderだけ記録照合し、結付け後は会員へ使用を合算する。見込みでは予約/確定しない。
- UI/API変更前にローカル`node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`と`15-route-handlers.md`を読む。storeは`server-only`、型・エンジン・表示辞書はI/Oなし。管理画面は`clientFetch`、穏やかな日本語、絵文字/感嘆符なし。
- 新規テスト題名は `FREQ-NNN-AC-NN: …`。既存FR-CHECKOUT-039/042/031/032の題と画面契約は保持する。要求の正本は`docs/02_Requirements/requirements.md`の６列表で、今回の新規番号は542〜552。実装時に他セッションとの衝突を再確認する。
- 実装者は単体/型/lint、controllerはreset・DB結合/並行・PostgREST・build/E2E・provider・本番を担当する。計画作成中はPlaywright・サーバー・Supabase CLI・Docker・DB試験・変更系git・`.env*`の読取をしない。
- E2E はproduction buildと手元Supabase、port3000、390/768/1280px、`x-real-ip`を試験ごとに分ける。実Stripe・実メールとfixture/API差替えの証拠を分け、試験数は実測だけを記録する。
- 実装コードの最終変更後、controllerは現在のAGENTS.mdに従いcommit前に`graphify update .`を１回だけ完了させる。commit後はフックの結果を`graphify hook status`で確認し、手動updateを重ねない。今回の計画修正ではgraphを書き換えない。

**共通verify（後日のcontroller手順）:** 各SQL Taskは、未実装DBに対するRED → 新移行を含む手元DB reset → anon/authenticatedの既存items読取smokeが各200 → 対象DB suite → PostgRESTで新public入口のservice_role成功/anon・authenticated拒否、の順。秘密値は表示しない。変更したSQLは最後の本文でresetから再試験する。過去のGの末尾assert再実行は、その移行当時の許可一覧を取引内で復元する既存helperを使い、Hの最終許可一覧を過去の本数へ弱めない。`G1_CLEANUP_SUITE=1`は通常の回帰に含めない。並行試験は`pg_blocking_pids`/`pg_locks`で待ちを観測し、固定sleepを使わず３連続成功を記録する。

## Review Focus

- **最適化と資源の上限:** 採用した割引は対象全体へ適用し、セットはC22の最大組数。保存時の各分類６件と共有item禁止で探索を割引の採否だけに限定する。最大カートを200ms未満で解き、guard不具合でも単独案/全併用案の最善を返して要対応へ残す → Task 2の`FREQ-546-AC-01`〜`AC-04`・Task 3の`FREQ-547-AC-04`。
- **同時受付と遅れた入金:** 初回/前回着数/１人１回を二つのタブが古いdraftで通らず、予約なし/取消後の実入金は受理し、上限超過は発送を止めず要対応へ１件だけ出る → Task 7の`FREQ-549-AC-01`・`AC-04`・`AC-05`。
- **旧注文と一部返金:** 37,000円の２着から17,000円を先に返し、次は20,000円、分割・失敗・交換・G-4状態分割でも総和が保たれ、旧注文の均等式は変わらない → Task 9の`FREQ-551-AC-01`〜`AC-04`。
- **コードとメールの秘匿と復元:** guestの使えないcodeは全理由同じ文/理由で、異なる入力メールと注文の有無でもpreviewが同じ「見込み」になる。memberの限定codeも拒否をそろえ、429/503で保存を消さず非ok本文を閉じる → Task 6の`FREQ-548-AC-01`・Task 8の`FREQ-550-AC-02`。
- **認可の層と表示の漏れ:** routeでaal1/失効sessionを拒否しRPCを呼ばず、DBで無効/期限切れ役割と足りない権限を拒否する。監査/公開応答/guest広告にも情報を漏らさない → Task 1/3/4の`FREQ-543-AC-01`・Task 4の`AC-02`・Task 8の`FREQ-550-AC-03`・Task 10の`FREQ-552-AC-02`。

---

## ファイルの分担

| 分担 | 作成/変更する中心のファイル | Task |
|---|---|---|
| DB | 上記H1〜H6の６移行、`tests/integration/db/group_h_*.integration.test.ts`、`tests/integration/db/helpers/group-h-fixtures.ts` | 1・3・6・7・9・10 |
| 純粋な定義と計算 | 新規`src/lib/discounts/discount-types.ts`・`discount-eligibility.ts`・`discount-products.ts`・`discount-orders.ts`・`discount-allocation.ts`・`discount-search.ts`・`discount-engine.ts`・`discount-messages.ts` | 2 |
| 管理データ | 新規`src/lib/discounts/admin-discount-types.ts`・`admin-discount-schema.ts`・`admin-discount-store.ts`・`admin-discount-route.ts` | 4 |
| 管理UI | 新規`src/components/DiscountSection.tsx`、`src/features/discounts/components/{DiscountList,DiscountDetail,DiscountForm,DiscountAssignments,DiscountMemberPicker}.tsx`、`src/app/admin/discounts/[id]/page.tsx`・`new/page.tsx`・`[id]/edit/page.tsx` | 5 |
| checkout接続 | 既存`src/features/checkout/services/promotion-code.service.ts`・`checkout-draft.service.ts`・`checkout-confirmation.service.ts`、新規`checkout-discounts.service.ts`・`stripe-discount-coupon.service.ts`、既存promotion-code/create-session/place-order/completeのroutes | 6・7 |
| 画面 | 既存checkoutのpage/PromoCodeField/FinalConfirmationStep/checkout-api/promotion-memory、cartのpage/OrderSummary/cart-view、item/[id]のpage/ItemDetailClient、新規`src/components/DiscountBreakdown.tsx` | 8 |
| 入金と返金 | 既存`src/lib/stripe/checkout-payment-{reconciler,reconciler-deps,types}.ts`、`src/lib/orders/refund/refund-{allocation,materials,types}.ts`、`AttentionInbox.tsx`・`useOrderAttention.ts` | 7・9 |
| 注文内訳 | 新規`src/lib/discounts/order-discount-store.ts`、既存customer-order-view/status/email/admin-ordersの型/store/compose、会員詳細とOrderStatusPublic、AdminOrderDetailSection | 10 |
| E2E | 新規`e2e/discount-test-utils.ts`とTask 11の12本、既存039/042/031/032と共通helpers | 11 |
| 正本と運用記録 | `requirements.md`・`api-spec.md`・`route-inventory.md`・`er.md`・`screen-list.md`・`screen-flow.md`・`16_admin.md`・`test-spec.md`・`db-migrations.md`、新規`docs/06_Operations/group-h-discounts.md` | 各所有Task・12 |

各TaskのFilesが編集範囲。上の波括弧は分担の短縮表記だけで、各Taskには実際のパスを記す。共有の要求/API/試験正本を触る前もcontrollerが別セッションへ通知する。

## 要求と受入条件（`docs/02_Requirements/requirements.md` の６列の表へ足す文）

現在の最大はFREQ-541（同ファイル1741行）。下表の各行を「要求ID／要求内容／要件ID／要件内容／受入条件ID／受入条件内容」の６列へ展開する。各行の要件IDは `FREQ-NNN-REQ-01`、ACは同じ番号の `FREQ-NNN-AC-NN`。ACを証明する試験が存在するTaskでそのACを足す。FREQ-78・389・394・396・397・409・419・420・423・448・465・472・519・537・540・541は旧契約の履歴を残し、Hの置換箇所と旧注文の例外を追記する。

| 要求 | REQ-01 の要件 | AC | 証明する Task |
|---|---|---|---|
| FREQ-542（割引を固定記録し旧注文を保つ） | ７表とdraftの固定結果/事実を持ち、行別割引の和と１着ごとの額を注文と一致させ、H以前は今の行別関数を使う | AC-01 表/制約/不変記録／AC-02 旧配分・新配分・交換除外／AC-03 固定結果の形と金額 | 1・6・7 |
| FREQ-543（割引管理を権限と監査で守る） | read/manageをSQL/TSの32コードへ加え店長だけ初期付与と版+1、routeはaal2/live session、DBはactorの有効な役割権限を検査する | AC-01 DBのACL/RLS/32件/役割権限と、routeのaal2/session・RPC未呼出しを別々に検証／AC-02 route順/CSRF/制限/監査/no-store／AC-03 supporterへの付与/剥奪 | 1・3・4・5・11 |
| FREQ-544（商品の割引と購入資格） | 商品除外・A/B/両方・セットを服単位と１着単位で計算し、ゲスト/会員/初回/回数/期間/最低条件を事実から評価する | AC-01 対象/資格/条件／AC-02 A/B/両方/成功返金の着数／AC-03 セット2〜10種と１着の取り合い | 2・3・7・11 |
| FREQ-545（整数の注文割引と配分） | 商品割引後の同じ基数で注文割引を足し、整数円・累積丸めで行別/１着別の和を一致させる | AC-01 floor/同じ基数／AC-02 累積丸め/残額/総和／AC-03 50円下限・注文から削る | 2・6・11 |
| FREQ-546（最もお得な併用） | 双方のクラス許可と１着１商品割引を守り、５コード/25自動の候補から実割引最大→コード最少→割引数最少で選ぶ | AC-01 最適解/セットとの競合／AC-02 同額/安定順/未採用未消費／AC-03 上限と50円後の比較／AC-04 割引採否だけの厳密評価・最大カート200ms・guard時も成功と要対応 | 2・3・6・8・11 |
| FREQ-547（管理で作成と割り当てができる） | 一覧/詳細/種類別フォームと割り当て表を持ち、作成/編集制限/停止/再開/複製/未使用の割当解除/100までの使い捨てを扱う | AC-01 一覧/詳細/状態/検索／AC-02 C12の編集制限/複製／AC-03 10人10行/予約/使用日/注文/マスク／AC-04 束/衝突/接頭辞禁止/分類６件とセット重複の保存拒否／AC-05 会員選択/未使用解除/競合 | 3・4・5・11 |
| FREQ-548（店のコードを決済へ渡す） | 複数コードを自店DBで検証し、固定結果/事実と指紋をdraftへ保存し、合計を１回限りcouponへ渡す。既存の金額/所有者照合を保つ | AC-01 形式/拒否文/秘匿/ログイン案内／AC-02 draft固定/再送/偽額拒否／AC-03 coupon/Stripe合計/旧コード不使用 | 6・11 |
| FREQ-549（予約と入金の使用を一致させる） | 受付取引内で資格を再確認して予約し、入金で確定、未入金終了で取消。遅れた実入金も受け、超過を発送停止なしの要対応にする | AC-01 本人と割引の鍵/並行/コード変更拒否・自動変更は最終確認／AC-02 コピー/予約/冪等／AC-03 確定/未入金取消/返金で戻さない／AC-04 予約なし/取消後入金/要対応／AC-05 ゲスト結付けと初回の競合 | 7・11 |
| FREQ-550（画面に内訳と案内を出す） | 入力/最終確認/カートに割引名・コード・額、複数コードの削除と未採用文を表示し、広告は自動のONだけで会員条件を守る | AC-01 複数/削除/内訳/最終変更不可／AC-02 復元/通信失敗/body消費/a11y／AC-03 広告OFF既定/ON１行/ゲスト非公開 | 8・11 |
| FREQ-551（安い着から返し旧注文を保つ） | Hは１着ごとの支払額の安い順で返金/返品/取消を計算し、他の割引を取り直さずG-4の状態別金額も総和を保つ | AC-01 17000→20000の返金／AC-02 旧均等式/交換/失敗の再試行／AC-03 セット片方と前回着数／AC-04 状態別金額と返金の総和 | 9・11 |
| FREQ-552（注文とメールに同じ内訳を出す） | 確認メール/会員詳細/注文状況/管理詳細に注文時の割引内訳を出し「割引」にそろえ、0円を省き公開範囲を守る | AC-01 各表示/0省略/名称不変／AC-02 公開範囲/コード/監査／AC-03 行別と総額の一致/旧注文 | 10・11 |

## 共通の型・値・拒否

Task 2が定義し、以降は同じ名前を使う。UUIDは検証済みの`string`、itemIdは安全整数の`number`。日時はUTCのISO8601文字列。

| 型/定数 | 正確な契約 |
|---|---|
| `DiscountKind` / `DiscountClass` / `DiscountMethod` | `'order_percent' \| 'order_amount' \| 'product' \| 'repeat' \| 'set'` / `'product' \| 'order'` / `'code' \| 'automatic'` |
| `DiscountValue` / `DiscountMinimum` | `{type:'percent' \| 'amount';value:number}` / `{type:'none';value:0} \| {type:'amount' \| 'quantity';value:number}` |
| `DiscountDefinition` | `{id:string;version:string;name:string;kind:DiscountKind;method:DiscountMethod;value:DiscountValue;targetMode:'all' \| 'exclude' \| 'include';itemIds:readonly number[];minimum:DiscountMinimum;audience:'assigned' \| 'anyone';allowGuests:boolean;firstOrderOnly:boolean;usageLimit:number \| null;oncePerCustomer:boolean;startsAt:string;endsAt:string \| null;stopped:boolean;combinesWithProduct:boolean;combinesWithOrder:boolean;advertise:boolean;advertisingText:string \| null;repeatPrevious:boolean;repeatInOrder:boolean}`。`version`はbigintの10進文字列 |
| `DiscountLine` | `{lineKey:string;itemId:number;unitPrice:number;quantity:number;lineKind:'order' \| 'exchange'}`。配分順はlineKey昇順→unitIndex昇順 |
| `DiscountBuyer` | `{kind:'member';userId:string} \| {kind:'guest';normalizedEmail:string \| null}`。guestメールをクライアントの本人認証として使わない |
| `DiscountUsageFact` | `{discountId:string;reserved:number;confirmed:number;buyerUses:number\|null;assigned:boolean;codeId:string \| null;code:string \| null;audience:'assigned' \| 'anyone';allowGuests:boolean;singleUse:boolean;codeUses:number}`。guest previewのbuyerUsesだけnull、automaticはcodeId/code=null・audience=anyone/allowGuests=true |
| `DiscountFacts` | `{phase:'preview' \| 'confirm' \| 'acceptance';at:string;buyer:DiscountBuyer;hasPreviousOrder:boolean\|null;hasFirstOrderReservation:boolean\|null;priorUnitsByItem:Readonly<Record<string,number>>;usage:readonly DiscountUsageFact[]}`。guest previewはbuyer.normalizedEmail=null/hasPreviousOrder=null/hasFirstOrderReservation=null、usage.buyerUses=nullとして履歴を読まない。confirm/acceptanceでだけ有料履歴と初回予約の規則を評価する |
| `DiscountEffect` | `{discountId:string;codeId:string \| null;name:string;code:string \| null;class:DiscountClass;amount:number}`（注文時の写し） |
| `DiscountAllocation` / `DiscountUnitAmount` | `{lineKey:string;discountId:string;amount:number}` / `{lineKey:string;unitIndex:number;paidAmount:number}` |
| `DiscountResult` | `{version:1;subtotalAmount:number;shippingAmount:0;discountAmount:number;totalAmount:number;applied:readonly DiscountEffect[];allocations:readonly DiscountAllocation[];unitAmounts:readonly DiscountUnitAmount[];unusedCodes:readonly string[];provisional:boolean;calculationMode:'exact' \| 'fallback'}` |
| `DiscountInput` | `{lines:readonly DiscountLine[];discounts:readonly DiscountDefinition[];codes:readonly string[];facts:DiscountFacts}` |
| `DiscountInputError` | `class DiscountInputError extends Error`、`readonly code:'invalid_input' \| 'too_many_codes' \| 'too_many_automatic' \| 'amount_out_of_range' \| 'total_below_minimum'`、`constructor(code:DiscountInputError['code'])`。serverの不正な設定/戻り値は500、入力の形式は400、支払対象の元額50円未満は422 `お支払い金額は50円以上にしてください。` |
| `DiscountRefusal` | `{code:string;reason:'not_found' \| 'not_eligible' \| 'expired' \| 'usage_limit' \| 'minimum_amount' \| 'minimum_quantity' \| 'zero_total';minimumAmount?:number}`。`code`は本人が入力した文字だけ、存在情報は返さない |
| 上限 | `MAX_DISCOUNT_CODES=5`、`MAX_AUTOMATIC_DISCOUNTS=25`、`MAX_STACKABLE_AUTOMATIC_PER_CLASS=6`（C21）、`MIN_CHECKOUT_TOTAL=50`、`MAX_DISCOUNT_BATCH=100`、`DISCOUNT_PAGE_SIZE=20`、割当表20行/頁、会員検索20件/回、cart50行×20着、`MAX_DISCOUNT_PRODUCT_PLANS=2067`・`MAX_DISCOUNT_COMBINATIONS=160000`（通常の上界157696に対する不具合検知だけ）。最大カートの性能試験は１計算200ms未満 |

**DBとHTTPの拒否表:** `GROUP_H_ERRORS: Readonly<Record<string, readonly [sqlstate:string,status:number,message:string]>>`をTask 4の`admin-discount-types.ts`へ定義する。storeはmessageとSQLSTATEの完全一致だけで分類する。

| DB message / SQLSTATE | HTTP | 日本語本文 |
|---|---|---|
| `GROUP_H_ARGUMENT_INVALID / 22023` | 400 | `入力を確かめてください。` |
| `GROUP_H_FORBIDDEN / 42501` | 403 | `割引を操作する権限がありません。` |
| `GROUP_H_DISCOUNT_NOT_FOUND / P0002` | 404 | `割引が見つかりません。` |
| `GROUP_H_CODE_CONFLICT / 23505` | 409 | `このコードは既に使われています。` |
| `GROUP_H_VERSION_CONFLICT / 40001` | 409 | `設定が変わりました。読み直してください。` |
| `GROUP_H_USED_FIELDS_LOCKED / 55000` | 409 | `使用後はこの項目を変更できません。複製して新しく作ってください。` |
| `GROUP_H_ASSIGNMENT_USED / 55000` | 409 | `使用済みの割り当ては外せません。` |
| `GROUP_H_AUTOMATIC_LIMIT / 23514` | 409 | `同時に有効にできる自動の割引は25件までです。` |
| `GROUP_H_STACKABLE_AUTOMATIC_LIMIT / 23514` | 409 | `重ねられる自動の割引は、商品の割引と注文の割引でそれぞれ6件までです。` |
| `GROUP_H_STACKABLE_SET_ITEM_CONFLICT / 23514` | 409 | `同じ服を含むセット割引は、同じ期間に重ねる設定にできません。` |
| `GROUP_H_REQUEST_KEY_CONFLICT / 23505` | 409 | `同じ要求番号で異なる操作は実行できません。` |
| `GROUP_H_CODE_GENERATION_FAILED / 54000` | 503 | `コードを作れませんでした。もう一度お試しください。` |
| `GROUP_H_DRAFT_SNAPSHOT_CONFLICT / 22023` | 409 | `割引の条件が変わりました。入力画面で割引を確かめてください。`（固定要求の不整合だけ。自動割引の条件変更には使わない） |
| `GROUP_H_LOCK_REQUIRED / 55000` | 500 | `割引の処理に失敗しました。`（内部の鍵情報は返さない） |
| `GROUP_H_REFUND_UNIT_MISMATCH / 23514` | 500 | `返金額を確かめられませんでした。読み直してからお試しください。` |

未知の失敗は500 `割引の処理に失敗しました。`。入力拒否は`{error:message,code:<固定コード>}`、zod不正は400で同じ入力文、認証/CSRF/429/503は共通middlewareの既存本文・`Retry-After`を維持する。新しい注文受付の拒否は例外ではなく`rejection`列で返す（Task 7）。

---

### Task 1: DBの土台・権限目録・旧注文の行別割引

開始条件はwave 5がコミット済みであること。Hのservice_role/actorのDB試験はGの役割権限だけを検査する。wave 5のRLS回帰に必要なclaims/session helperとrouteの認証検査は共通制約の別々の経路で使う。

**Files:**
- Create: `supabase/migrations/<ts1>_group_h_discounts_foundation.sql`、`tests/integration/db/group_h_foundation.integration.test.ts`、`tests/integration/db/group_h_migration_asserts.integration.test.ts`、`tests/integration/db/helpers/group-h-fixtures.ts`
- Modify: `src/lib/auth/admin-rbac.ts:6-43`（PermissionCode）、`src/lib/auth/role-permission-catalog.ts:7-81`、`src/lib/auth/role-permission-store.ts:19-33`、`src/app/api/admin/role-permissions/route.ts:18`、`tests/unit/lib/auth/role-permission-catalog.test.ts`、`tests/unit/lib/auth/role-permission-store.test.ts`、`tests/unit/api/admin/role-permissions-route.test.ts`、`tests/integration/db/role_permissions.integration.test.ts`、`docs/02_Requirements/requirements.md:1741`（542/543/519）、`docs/03_BasicDesign/data/er.md`、`docs/06_Operations/db-migrations.md`
- Test: foundation/assert/既存role_permissionsのDB３suiteと権限単体３本。wave 5で行番号が変わったら名前で再確認する。
- Read: `supabase/migrations/20261023175712_group_g0_permissions.sql:221-363`（GET/SETの２目録）、`supabase/migrations/20261013001143_order_return_receipts.sql:23-71`（行別割引/返品額）。適用済みの両ファイルを変更しない。

**Interfaces:**
- Consumes: Gの`private.group_g_actor_has_permissions(_actor_id uuid,_codes text[]) RETURNS boolean`による有効な役割の和集合、`public.orders`・`public.order_items`・`public.checkout_drafts`・`public.items`・`auth.users`。service_roleのJWTから買い手のaal/sessionを推測しない。
- Produces: 次の７表。すべて`public`、RLS有効、PUBLIC/anon/authenticated/service_roleに直接SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGERなし。idはUUID、時刻はtimestamptz。業務FKはRESTRICT、`auth.users`へのuser_id/assigned_user_id/created_by/updated_by/attention_resolved_byはNULL可・ON DELETE SET NULL。退会で割引や使用履歴を消さず、割当先NULLは未割当の誰でもcodeへ変換しない。

| 表 | 列と制約（共通id/created_at以外） |
|---|---|
| `discounts` | `name text`(trim1〜100)、`kind/method/value_type/target_mode/minimum_type/audience text`（共通型のenum CHECK）、`value integer`、`minimum_value integer`、`allow_guests/first_order_only/once_per_customer/combines_with_product/combines_with_order/advertise/repeat_previous/repeat_in_order/stopped boolean`、`usage_limit integer null`(1以上)、`starts_at/ends_at`、`advertising_text text null`(1〜200)、`version bigint default 1`、`created_by/updated_by uuid`、`updated_at`、`creation_request_key uuid UNIQUE`、`creation_request_hash text`、`admin_requests jsonb NOT NULL DEFAULT '{}'`、`search_attention_at timestamptz null`、`search_attention_count integer NOT NULL DEFAULT 0 CHECK (search_attention_count>=0)`。％1〜99/円1以上と円引きの最低額>値、日時前後、assignedはguest不可、自動はaudience=anyone/allow_guests=true、広告は自動のみ、repeatはA/Bのどちらか必須、order２種のvalue_typeを固定 |
| `discount_items` | `discount_id uuid FK`、`item_id bigint FK`、複合PK(discount_id,item_id)。exclude/productまたはinclude/repeat,setだけ。setの2〜10種類はwriterと遅延constraint triggerで検査 |
| `discount_codes` | `discount_id uuid FK`、`code text UNIQUE COLLATE "C"`、`audience text`=assigned/anyone、`allow_guests boolean`、`single_use boolean`、`assigned_user_id uuid null FK auth.users ON DELETE SET NULL`、`batch_id uuid null`。大文字ASCII英数字/ハイフン1〜64、assignedはguest不可。割当先が退会してNULLになってもaudienceはassignedのまま誰にも適用しない。親のaudience/allow_guestsは既定値、資格はcodeの実列を使う。prefix単独を登録せず、共有と束を混在させない |
| `discount_assignments` | `discount_id/code_id uuid FK`、`user_id uuid null FK auth.users ON DELETE SET NULL`、UNIQUE(code_id,user_id)。共有assignedの１人１行、退会後のNULL行は履歴として保持して未使用の他人へ割り当て直さない。discount_idの整合を複合FK/triggerで検査 |
| `discount_redemptions` | `discount_id/code_id/order_id/user_id`（code/userはnull可）、`identity_key text`、`normalized_email text null`（外へ出さない）、`state text`=reserved/confirmed/cancelled、`reserved_at/confirmed_at/cancelled_at`、`name_snapshot/code_snapshot text`、`class_snapshot text`、`amount integer`(0以上)、`first_order_only_snapshot boolean`、`reconciliation_fallback boolean NOT NULL DEFAULT false`、`attention_kind text null`=discount_limit_exceeded/discount_reconciliation_recovered、`attention_resolved_at/by`。UNIQUE(order_id,discount_id)、(discount_id,state)、(identity_key,discount_id,state)、(code_id,state)、(order_id)の索引。D16の確定超過を許すためconfirmed全体に本人一意制約は作らず、通常の上限は鍵の下で数える |
| `order_line_discount_allocations` | `order_id/order_item_id/discount_id uuid FK`、`amount integer >=0`、複合PK(order_item_id,discount_id)。明細のorder_id一致を検査。INSERT後UPDATE/DELETE禁止 |
| `order_line_unit_amounts` | `order_id/order_item_id uuid FK`、`unit_index integer >=0`、`paid_amount integer >=0`、複合PK(order_item_id,unit_index)。数量ぶんの連続index・sum(paid_amount)=line_total−sum(allocations)を遅延constraint triggerで検査。INSERT後UPDATE/DELETE禁止 |

- Produces: `checkout_drafts.discount_result jsonb null`、`discount_facts jsonb null`、`discount_engine_version smallint null`（1だけ）、`discount_snapshot_hash text null`（SHA256 hex64）。４欄は全NULLか全て存在、result.version=1、JSON object、結果のallocations/unitAmountsがarray。**既存行はNULLのまま**、backfillなし。厳密な行/金額検査はTask 6の固定関数、注文の総和はTask 7。
- Produces: `private.order_line_discounts(_order_id uuid) RETURNS TABLE(order_item_id uuid,line_discount integer)`、STABLE/DEFINER/search_path空。注文に保存allocationが１件でもあれば全通常行をLEFT JOINしてsum（対象外行は0）、交換行は常に0。保存が無ければ20261013001143の累積丸めの本文と同じ。新public入口は作らない。旧注文の再計算基準を変えない。
- Produces: `private.admin_get_permissions(_actor_id uuid) RETURNS jsonb`と`private.admin_set_role_permissions(_actor_id uuid,_role_code text,_permission_codes text[],_expected_version bigint,_request_key uuid) RETURNS jsonb`の両catalogを32へ拡張し、固定２権限・版・要求鍵・監査・public INVOKERを保つ。TSに２コード/日本語名とmanageの表示依存read、上限32を追加する。H1で`permissions`へ`admin.discounts.read`/`admin.discounts.manage`（SQL名`Read discounts`/`Manage discounts`）をON CONFLICT(code) DO NOTHINGで登録、role code=adminだけへrole_permissionsをON CONFLICT DO NOTHINGで追加、adminのpermissions_versionを１回だけ+1する。
- Produces: 権限DML前に`CREATE TEMP TABLE group_h_permission_baseline(payload jsonb) ON COMMIT DROP`へpermissionsのH以外の行・全role_permissions・全rolesの版を順序固定のJSONとして控える。末尾assertは差分がHのpermissions２件/店長への付与２件/admin版+1だけ、supporter/userのH付与0、既存の他の付与と他role版が不変であることを検査する。既存H付与など前提が違えばassertで止め、削除/再投入で合わせない。
- Produces: H1 assert DETAIL `h1_tables`・`h1_draft_columns`・`h1_constraints`・`h1_rls_acl`・`h1_immutable`・`h1_line_reader`・`h1_permission_catalogs`・`h1_permission_seed`・`h1_existing_dml_allowlist`。既存表DMLは上記の初期登録/店長版更新だけ、取引内baselineから他の付与/版/permission行が不変と検査する。fixture用`seedHDiscount(client:PgClient,input:DiscountSeed):Promise<string>`、`seedHOrderUnits(client:PgClient,input:HOrderSeed):Promise<{orderId:string;orderItemIds:string[]}>`。`DiscountSeed=Omit<DiscountDefinition,'id'|'version'> & {code?:string;userIds?:readonly string[]}`、`HOrderSeed={lines:readonly {itemPrice:number;quantity:number;discounts:readonly {discountId:string;amount:number}[];unitAmounts:readonly number[]}[];legacy:boolean;buyerUserId?:string;email?:string;paidAt?:string|null;status?:OrderStatus}`。Hのactor試験ではsessionを作らない。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-542-AC-01: Hの７表は不正な値と直接DMLを拒み保存した金額を変えられない`（FK/遅延総和/数量/index/金額UPDATE/DELETE）、`FREQ-542-AC-02: 保存した3000円は対象行だけに付き旧注文の配分と交換0を保つ`、`FREQ-542-AC-03: 旧draftの４欄はNULLで半端な固定欄はCHECK違反`、`FREQ-543-AC-01: 32コードの初期登録は店長だけへ２件を付与し店長の版だけを1増やす`（実H1を適用して旧版でSETがVERSION_CONFLICT、他付与/版不変、32件可/33拒否）、`FREQ-543-AC-01: DBは無効な役割と期限切れuser_rolesと足りない権限を42501で拒む`（service_roleでactorを渡し、claims/sessionの不在では拒否しない）、`FREQ-542-AC-01: 利用者を消すと会員FKだけがNULLになり割引と使用と金額は残る`（３つの利用者参照、割当/単発codeは以後どの会員にも適用不可）。
- [ ] **Step 2（controller）: REDを測る。** `npx.cmd jest tests/integration/db/group_h_foundation.integration.test.ts tests/integration/db/group_h_migration_asserts.integration.test.ts --runInBand`と権限単体３本。H表/新コードが無い失敗を記録し、接続/認証設定の失敗をREDに数えない。
- [ ] **Step 3: InterfacesどおりのH1と32コードを実装する。** `order_line_discounts(uuid)`の引数/返り列を保つ。G-0の２関数の他の業務規則は置換しない。新表のimmutability helper/constraint triggerはprivate、service_roleからもEXECUTEを外す。
- [ ] **Step 4（controller）: 共通verifyでGREENを測る。** Step 2と`role_permissions.integration.test.ts`。末尾assertをSAVEPOINT内でRLS無効/anon権限/別overload/CHECK欠落/immutable trigger無効/目録31件へ１つずつ改ざんして流し、P0001と対応DETAILを検査する。単体/型/lintも通す。
- Test: H1のpermission差分assertを再実行する試験は`withH1PermissionBaseline(client:PgClient,assertSql:string):Promise<void>`をfixtureへ置く。取引内に同名TEMPを作り、正常な適用後の状態からH２コード/付与を除いたbaselineとadmin版−1を組み立ててから改ざんする。assert後rollback。改ざん後からbaselineを作らず、prod用の末尾assertを弱めない。
- [ ] **Step 5（controller）: Filesだけコミットする。** `feat(discounts): Hの記録基盤と32件の権限目録を追加する`。店長だけへの初期登録と版+1の実測を記録する。

### Task 2: I/Oの無い割引エンジン

**Files:**
- Create: `src/lib/discounts/discount-types.ts`、`src/lib/discounts/discount-eligibility.ts`、`src/lib/discounts/discount-products.ts`、`src/lib/discounts/discount-orders.ts`、`src/lib/discounts/discount-allocation.ts`、`src/lib/discounts/discount-search.ts`、`src/lib/discounts/discount-engine.ts`、`src/lib/discounts/discount-messages.ts`、`tests/unit/lib/discounts/discount-eligibility.test.ts`、`discount-products.test.ts`・`discount-orders.test.ts`・`discount-allocation.test.ts`・`discount-search.test.ts`・`discount-engine.test.ts`（同じ`tests/unit/lib/discounts/`）
- Modify: `docs/02_Requirements/requirements.md`（544〜546）、`docs/05_Quality/tests/test-spec.md`、`docs/superpowers/specs/2026-10-28-group-h-promotions-design.md`（実装時にC21/C22を「オーナーが覆せる」設計者判断として追記。今回の計画修正では触らない）
- Test: 上記６本。小規模oracleは固定seedで割引部分集合を全て評価し、採用割引を全部適用する別実装を使う。製品の探索関数をoracleから呼ばない。

**Interfaces:**
- Consumes: 共通型・値の全て。設定/購入事実/現在日時は引数だけから取り、DB/Stripe/fetch/Date.now/乱数を呼ばない。C21の各分類６件、C22の採用割引の全部適用とセット最大組数を前提にする。
- Produces: `evaluateEligibility(discount:DiscountDefinition,input:DiscountInput,codeId:string|null):{eligible:boolean;provisional:boolean;refusal:DiscountRefusal|null}`、`buildProductCandidates(input:DiscountInput):readonly ProductCandidate[]`、`evaluateProductCombination(input:DiscountInput,selected:readonly ProductCandidate[]):ProductPlan`、`calculateOrderEffects(input:DiscountInput,productPlan:ProductPlan,selected:readonly DiscountDefinition[]):readonly DiscountEffect[]`、`allocateCumulative(amount:number,weights:readonly number[]):number[]`、`searchBestDiscountPlan(input:DiscountInput,guard?:DiscountSearchGuard):DiscountResult`、`calculateDiscounts(input:DiscountInput):DiscountResult`。`DiscountSearchGuard={maxProductPlans:number;maxCombinations:number}`は試験注入用、省略時は上の本番定数。関数名は全試験もsearchBestDiscountPlanに統一する。
- Produces: `DiscountQuantityGroup={groupKey:string;itemId:number;unitPrice:number;quantity:number;repeatProtected:number}`（groupKey=itemId:unitPrice、repeatProtectedはBの対象外の先頭１着0/1）。`ProductCandidate={discountId:string;codeId:string|null;targetGroupKeys:readonly string[];setItemIds:readonly number[]}`。`ProductPlan={selectedDiscountIds:readonly string[];remaining:Readonly<Record<string,number>>;effects:readonly DiscountEffect[];groupAllocations:readonly {groupKey:string;discountId:string;quantity:number;amount:number}[];setCounts:Readonly<Record<string,number>>}`。quantity/remaining/setCountsは選んだ組を全適用した**計算結果**。それらや金額をDFS/memoのキーにしない。cacheが要るなら商品側のdiscount-id集合のmaskだけで、１着のbitsetは持たない。
- Produces: `expandDiscountPlan(input:DiscountInput,plan:ProductPlan,effects:readonly DiscountEffect[]):Pick<DiscountResult,'allocations'|'unitAmounts'>`は最善の割引集合が確定した後だけ呼ぶ。groupで計算した結果をlineKey/unitIndexの安定順へ展開し、最大1000着で止まる。探索中に着/配分額/セット組数を列挙しない。guest previewのhasPreviousOrder/hasFirstOrderReservation/buyerUses=nullはprovisional=true、confirm/acceptanceではnullを許さない。
- Produces: order２種はall、productはall/exclude、repeat/setはinclude。商品/リピートは選んだ組の対象全着に効き、同じ着は額の大きい１つ（同額はid昇順）。repeat AだけはmemberでpriorUnits>0なら今回全着、Bだけは今回２着目以降、両方はmemberのpriorUnits+今回で２着目以降、guestはBだけ。交換行を全分母から除外する。先頭/後ろは同itemの単価昇順→lineKey→unitIndex（仕様7.1）。A/Bともfalseやn着目設定は許さない。
- Produces: 最低額/数量は対象服だけ。商品効果の資格はその効果前の対象額、注文効果の資格は全商品効果後の対象額。セットは各服１着、１組額はfloor(単価合計*率/100)又は固定円を組総額でcapし単価比・累積丸めで配る。**「強い」は、その着へのセット取り分と他の商品効果の１着額を比較して決める**（同額はdiscountId昇順）。セットより強い他効果に取られた着を除き、全itemにそろう最大組数を適用（C22）。組全体の割引と他効果の損失合計の比較はしない。選んだセット同士のitemは保存規則で別なので奪い合わない。組へ回す着は他効果で失う額が小さいgroupから安定順に取り、組数を意図して減らさない。注文最低額を保つため商品効果を一部外す計画も作らない。
- Produces: 注文効果は全て同じ商品割引後の基数でfloorし、50円未満ならorderのid降順から削り、足りなければproductの同順/group逆順から削る。0額の効果を除き、実割引額→code数→効果数→id順で比較する。注文額は残額比で行→１着へ累積丸め、各着の残額を超えず総和一致。`unusedCodes`は正規化した入力順、`applied`はproduct→order/id順。
- Produces: `promotionRefusalMessage(refusal:DiscountRefusal,visibility:'guest'|'restricted'|'public'):string`。guestは`GUEST_DISCOUNT_REFUSAL_MESSAGE='このコードは使えません。会員の方はログインしてからお試しください。'`、reason=not_eligible/最低額等は省略。member restrictedは`このコードは使えません`、publicだけ仕様9.1の文。`BETTER_DISCOUNT_MESSAGE='このコードは今の割引と一緒には使えません。よりお得な割引を適用しています。'`。
- Produces: guard超過は不具合として`calculationMode:'fallback'`。各割引を１つだけ全適用した全案と、全ての互換な併用候補を入れた案を、同じ条件/50円/丸めで最後まで評価し、その中の最善を返す。「全部併用」の候補は各側を空/同分類許可ONの全員/同分類許可OFFの各単独として組み、相手側が非空なら交差許可OFFの候補を除いた最大の互換集合を全て評価する。双方の許可に反する組は捨てる。同分類許可OFFの１件＋相手分類の全互換候補も含め、単独案以外は全てその互換集合を全適用する。通常と同じtie-break。例外/探索503/不完全な途中bestは返さない。I/Oは呼ばず、Task3/6/8がfallbackをログと管理の要対応へ記録する。fallbackも同じresultをdraft/Stripe/注文へ固定する。

探索と配分だけ短い疑似コードで固定する。

```text
roundCum(D,S,T) = T=0 ? 0 : floor((2*D*S+T)/(2*T))
allocate(D,weights): 累積重みごとのroundCumの差を返す
side(class): 空集合 / 同分類と重ねない候補の単独 / 同分類と重ねる候補の全部分集合
for P in side(product): group別の全適用を１回計算する（セットは最大組数）
  for O in side(order):
    両側が空でなければ、P全員のorder許可とO全員のproduct許可を検査
    注文の資格/額 → 50円調整 → 0効果除外 → tie-breakで比較
guardは候補集合/組の個数だけ数え、超えれば上記単独案＋全部併用案へ移る
最善集合だけを行/1000着へ展開する
```

**正確さと上界:** 双方の許可だけが併用可否を決めるので、各側は単独候補か同分類許可ONの部分集合で尽くされる。交差許可を全員について確認すれば可行な割引集合を全て評価できる。C22により各集合の額とセット最大組数は一意で、最低額/50円/コード最少の判定に部分的な商品効果や部分組数は存在しない。商品側の全適用をorder側で再計算しない。１つの商品集合の基数について各order候補の資格/floor額を先に１回計算し、order部分集合ではその額を足すだけにする（BigIntの乗除算を組数ぶん繰り返さない）。memoのキーに金額を足す必要はない。

自動の同分類許可ON件数を商品p/注文o（各0〜6）、残り自動の商品側をu（0〜25−p−o）とする。コード５件以下を商品の同分類ON/OFFへa/b件、注文の同分類ON/OFFへc/d件と分ける（a+b+c+d<=5）。各側の集合数の計算上界はP=2^(p+a)+u+b、O=2^(o+c)+(25−p−o−u)+d（空集合を冪へ含める）。全自動25件未満は同分類/交差ともOFFを追加して上から押さえられ、交差だけONの自動は件数制約を狭めるだけで集合数を増やさない。この123480通りの件数配置を総当たりした計算上の最大は商品2067集合、組157696。商品最大はp=6/o=0/a=5/u=19で2^11+19=2067、組最大はp=o=6/a=5/u=0で2048*(64+13)=157696（対称配置も同じ）。したがってguardは2067/160000とし、合法な配置ではfallbackに入らない。６件未満の側があれば非併用自動が増えるので、両側６件だけの式を全域の上界にしない。codeを両側５件ずつ数えない。商品評価は最大2067集合、最後の着の展開は最大1000回。セットはC22で１集合１回の最大組数計算なので、21^kや単価/円の列挙を掛けない。保存時は件数とitem重複だけ検査し、カート依存の予算で設定を拒否しない。集合数/組数は計算上界であり、engine内部の訪問数を実測した値ではない。

**C21の試作計測（2026-10-29）:** Windows x64 / AMD Ryzen 7 9700X / Node v24.19.0、独立した純粋Node試作を標準入力から実行しファイルは作らなかった。N=6、50group×20着×1000円（1000000円）、全候補の交差併用ON、codeの所属をc=0..5、非併用自動13件の所属をu=0..13へ振った84配置。全商品を対象にする商品/リピートの重なりと、それへ６つの別itemセット（各最大20組）の比較相当を加えた保守的な負荷の２形を、各５回で**840回**。後者は演算負荷の試作であり、セットの意味の正しさを実装したengineではない。候補準備・全集合評価・最低額判定・50円調整・1000着のBigInt累積丸めまでを計時し、中央値4.62ms/p95 12.61ms/最大23.83ms、最大157696組。最遅はc=5/u=9/セット形・139876組・比較1126400回。N=6を採る根拠は200msに対して約8.4倍の余裕と有限の集合数。この試作は製品engineの実装/全設定の意味の正しさ/DB/providerの証拠ではない。Task2の実装で次の全試験と200msを改めて測り、失敗時に閾値を広げない。

- [ ] **Step 1: 失敗する試験を書く。** ６ファイルへ次のexactな題とassertを置く。
  - `FREQ-544-AC-01: 対象外と交換行は数えず、期間の始まりは含み終わりは含まない`（startsAt/endsAt、最低額/数量±1、assigned他人不可、guest許可OFF、メール条件はpreview見込み、初回（有料履歴又は他draft初回予約ありは不可）/全体/１人１回/単発上限）。
  - `FREQ-544-AC-02: Aだけ・Bだけ・両方は仕様7.1の着数になる`（prior0/current2はA0/B1/both1、prior1/current1はA1/B0/both1、guestはA0/both=B、色サイズ同item、成功返金でprior1→0、未入金/交換除外）。
  - `FREQ-544-AC-03: ジャケット2とパンツ1は１組で、別割引が取った着は組に使えない`（2〜10種類、重複/1/11拒否、code/自動両方、C22最大組数）。
  - `FREQ-545-AC-01: １着101円の15％は15円、注文の10％と20％は同じ10000円から合計3000円引く`（２着商品30、order順逆もtotal7000、固定円と％も同基数）。
  - `FREQ-545-AC-02: 累積丸めは100円を３つに33・34・33と配り、行と１着の和が一致する`（weights1/1/1、D=1/2・T=3、0重み、最大整数、旧G-4状態式33/33/34と区別）。
  - `FREQ-545-AC-03: 下限を割る時は注文から削って50円にし、商品だけなら商品から削る`（subtotal1000/product900/order99→商品900/注文50/total50、商品990のみ→950、subtotal50は割引0、49拒否、100％設定拒否）。
  - `FREQ-546-AC-01: セットと単品の取り合いは全体の最善を選び、少数候補の総当たりと一致する`。J20000/P10000、set3000対J単品1000、**両方の「商品の割引と重ねる」がON**。J2/P1なら１組3000（J取り分2000/P取り分1000）＋残J1000=**4000**、全単品2000より大きい。片方でもこのチェックがOFFなら併用不可でsetだけ3000。J単品4000の別fixtureは２着で8000、セットは最大組数0又は不採用。同着二重効果0。独立oracleで全分類/最低条件/floor/tie一致。
  - `FREQ-546-AC-01: engineはセットのJ取り分2000円より単品2500円を優先し２着5000円引きを選ぶ`。J20000×2/P10000×1・set3000・J単品2500、両方の「商品の割引と重ねる」がON。１組の取り分はJ2000/P1000。Jは2500>2000なので２着とも単品、セット0組/discount5000/total45000。set１組3000＋残J2500=5500はC22の１着比較に反するため作らない。
  - `FREQ-546-AC-01: 独立oracleもJ単品2500円が強い時はセット０組で5000円引きになる`。上と同じfixtureの全割引集合を別実装で評価し、集合なし0/setだけ3000/単品だけ5000/両方5000をassert。engineをoracleから呼ばず、5500の組全体比較をoracleにも入れない。
  - `FREQ-546-AC-01: 商品10％は16000円２着の両方へ適用され注文5000円だけの案が勝つ`（商品3200で基数28800は注文最低30000未達、orderだけ5000/total27000。１着だけ1600＋5000=6600の案は作らない）。
  - `FREQ-546-AC-01: 採用したセットは最大組数を使い注文の最低額のために組数を減らさない`（J20000/P10000を各２着=60000、set3000、order10000/最低57000、set/orderとも併用２チェックON。最大２組6000引き後は54000<57000でorder不適合、setだけ6000よりsetなしorder10000/total50000が勝つ。仮に１組だけなら基数57000>=57000でorderも使え13000になるが、C22ではその部分組数の案を作らない。setCountsは不採用0又は最大２だけ）。
  - `FREQ-546-AC-02: 同額はコード最少、次に割引最少、最後に安定順で、選ばないコードを消費しない`（auto1000対code1000、auto500+500対auto1000、入力順全順列で同じallocations、同discount２codeは１効果）。
  - `FREQ-546-AC-03: ５コードと25自動は処理でき、６と26は拒否し、50円で同額になる候補もtie-breakする`（25自動はC21で許された配置、正規化で同code１件、floor前だけ大きいcodeを選ばない）。
  - `FREQ-546-AC-04: ２商品10着と３つの重なる割引は全着適用の厳密な2900円引きを時間内に返す`（各1000円×10、全品auto10％/repeat B15％/member code5％、双方併用ON。先頭２着は100円ずつ、残18着は150円ずつ、discount2900/total17100/code未消費、部分集合の計算上界は2^3=８個（訪問数の実測ではない）。20回全回200ms未満）。
  - `FREQ-546-AC-04: 各分類６件と25自動５コードの最大カートを全組評価し200ms未満で返す`。上の84配置×重なり形/別item最大セット形に、注文側の併用自動0〜5件/非併用商品自動19〜14件の６配置×２形とレビューの5100円fixtureを足し、実engineで各20回（計3620計算）、module読込を除く１計算を全回<200ms。最も組数の多い157696組でも省略なし。全％fixtureはautoの商品1..6％・codeの商品7..11％・autoのorder1..6％、残る非併用auto13件はorder1..13円（最低14円）とし、商品11％＋order1..6％で110000+186900=296900/total703100。反対配置はautoの商品1..6％・autoのorder1..6％・codeのorder7..11％、非併用13件は小額orderで、商品6％＋order1..11％が60000+620400=680400/total319600。実engineではset形/対象除外/repeat保護/最低額混在/50行を５itemへ集約する形もoracle又は手計算の期待額と一致させ、試作の負荷だけを代用しない。
  - `FREQ-546-AC-04: guard不具合でも単独案と全互換併用案の最善を返してfallbackを印す`（同じsearchBestDiscountPlanへ低いguardを注入。calculationMode=fallback、全単独案以上の割引、全互換案とtie-break一致、50円/総和維持、例外なし/検索503なし。product mask以外の金額memo/単位bitset/組数分岐なし）。通常はexact、Task3/6/8のログ/要対応契約も固定する。
- [ ] **Step 2: REDを測る。** `npx.cmd jest tests/unit/lib/discounts --runInBand`。未実装exportの失敗を記録する。
- [ ] **Step 3: Interfacesの関数と型を実装する。** 割引集合を分類ごとに作り商品側を再利用、C22で全部適用し、勝者だけを１着へ展開する。Task6へI/Oを残す。20000円２着の２着目3000円引きはunitAmounts20000/17000・discount3000・total37000を共通fixtureにする。
- [ ] **Step 4: GREENを測る。** Step2と`npx.cmd jest tests/unit/lib/discounts/discount-search.test.ts --runInBand -t FREQ-546-AC-04`、型/lint。実engineの環境/全回の最大時間/商品集合数/組数を記録する。試作測定値を製品のGREENへ転記しない。oracle一致/最大cart200ms/C21保存拒否/fallbackの成功と要対応がそろうまでTask2をGREENにしない。
- [ ] **Step 5（controller）: Filesだけコミットする。** `feat(discounts): 単位別配分と最適な併用を選ぶ純粋エンジンを追加する`

### Task 3: DBの管理書込・読取・割り当て表

**Files:**
- Create: `supabase/migrations/<ts2>_group_h_discounts_admin.sql`、`tests/integration/db/group_h_admin.integration.test.ts`、`tests/integration/db/group_h_admin_concurrency.integration.test.ts`、`tests/integration/db/group_h_context.integration.test.ts`
- Modify: `tests/integration/db/helpers/group-h-fixtures.ts`、`tests/integration/db/group_h_migration_asserts.integration.test.ts`、`docs/02_Requirements/requirements.md`（543/544/546/547）、`docs/03_BasicDesign/data/er.md`、`docs/06_Operations/db-migrations.md`
- Test: 上記４suite（assert共通を含む）。

**Interfaces:**
- Consumes: H1の表とACL、Task 2の`DiscountDefinition/DiscountFacts/DiscountUsageFact`のJSONキー。admin readは`admin.discounts.read`、writeは`admin.discounts.manage`をDBで再確認する（manageだけを与えた場合でもreadを勝手に付けない）。actorは全admin関数の最後に置く。
- Produces: 下表の同名private本体/public入口。読取はSTABLE、書込はVOLATILE、全てjsonbを１値で返す（PostgRESTの1000行切捨てを避ける）。`_input/_patch`はTask 2共通定義のcamelCase、UUID/id/version/作成日時はserverが決め、未知キーを拒否する。

| SQL signature（引数名も固定） | JSON戻り値 |
|---|---|
| `admin_create_discount(_input jsonb,_request_key uuid,_actor_id uuid) RETURNS jsonb` | `{discountId:string,version:string,replayed:boolean}` |
| `admin_update_discount(_discount_id uuid,_patch jsonb,_expected_version bigint,_request_key uuid,_actor_id uuid) RETURNS jsonb` | 同上 |
| `admin_set_discount_stopped(_discount_id uuid,_stopped boolean,_expected_version bigint,_request_key uuid,_actor_id uuid) RETURNS jsonb` | 同上 |
| `admin_duplicate_discount(_discount_id uuid,_request_key uuid,_actor_id uuid) RETURNS jsonb` | 新id/version1、stopped=true、名称は元のまま、新コード/割当/使用は空。再開前に新コードを入力（コード型） |
| `admin_assign_discount(_discount_id uuid,_code_id uuid,_user_ids uuid[],_request_key uuid,_actor_id uuid) RETURNS jsonb` | `{discountId:string,changedCount:number,replayed:boolean}`。入力1〜100・重複なし、無効な会員を拒否、既存割当は再利用 |
| `admin_unassign_discount(_discount_id uuid,_code_id uuid,_user_id uuid,_request_key uuid,_actor_id uuid) RETURNS jsonb` | 同上、reserved/confirmedがあれば拒否、cancelledだけは解除可 |
| `admin_generate_discount_codes(_discount_id uuid,_prefix text,_user_ids uuid[],_count integer,_request_key uuid,_actor_id uuid) RETURNS jsonb` | `{discountId:string,batchId:string,codes:{codeId:string,code:string,userId:string\|null}[],replayed:boolean}`。userIdsありならcount=人数・assigned固定、なしならanyone側の設定を使う |
| `list_admin_discounts(_filters jsonb,_limit integer,_offset integer,_actor_id uuid) RETURNS jsonb` | `{total:number,rows:DiscountListRow[]}`、limit1〜100/offset0以上、順createdAt DESC,id |
| `get_admin_discount(_discount_id uuid,_assignment_limit integer,_assignment_offset integer,_actor_id uuid) RETURNS jsonb` | `{discount:DiscountDefinition,used:boolean,assignmentTotal:number,assignments:DiscountAssignmentRow[],searchAttention:DiscountSearchAttention\|null}`、上限1〜100、注文日/氏名等を一括1000行で取らない |
| `search_admin_discount_members(_query text,_limit integer,_actor_id uuid) RETURNS jsonb` | `{rows:{userId:string,name:string\|null,email:string}[]}`、manage必須、trim2〜100字、limit1〜20、検索語は監査しない |
| `get_checkout_discount_context(_buyer_user_id uuid,_guest_email text,_codes text[],_item_ids bigint[],_at timestamptz,_phase text) RETURNS jsonb` | `{discounts:DiscountDefinition[],facts:DiscountFacts,refusals:DiscountRefusal[]}`。phaseはpreview/confirm/acceptanceだけ、service専用。guest previewは入力メールを破棄して履歴/本人回数を検索しない |
| `record_discount_search_fallback(_discount_ids uuid[]) RETURNS void` | service専用、1〜30の実在idを重複なしへ正規化、各discountのsearch_attention_at/countを記録（未解決の同じ10分窓は１回、PII/入力codeを保存しない）。管理認可用actorは取らず、guestへ直接公開しない |
| `get_admin_discount_activation_context(_discount_id uuid,_patch jsonb,_actor_id uuid) RETURNS jsonb` | STABLE/manage、`{candidate:Omit<DiscountDefinition,'id'\|'version'>,existing:DiscountDefinition[]}`。createはid=NULLで全入力、update/resumeはidの現行設定へpatchを当てた候補。stopped=falseかつ候補期間に重なる自動/共有itemのsetだけをJSONで返す。PII/code文字なし、未知キー/禁止patchもwriterと同じ検査 |

- Produces: `DiscountListRow={id:string;name:string;kind:DiscountKind;method:DiscountMethod;status:'scheduled'|'active'|'expired'|'stopped';startsAt:string;endsAt:string|null;usedCount:number;usageLimit:number|null;searchAttention:DiscountSearchAttention|null}`。状態の優先はstopped→scheduled→expired→active、usedCount=reserved+confirmed。filtersは`{status?,kind?,method?,query?}`だけ、queryはtrim1〜100字・名前部分一致またはコード部分一致、`%/_/\`は文字どおり。検索値をログに残さない。
- Produces: `DiscountAssignmentRow={rowId:string;codeId:string;code:string;userId:string|null;assigneeDeleted:boolean;assigneeName:string|null;guestEmailMasked:string|null;status:'unused'|'reserved'|'confirmed';usedAt:string|null;orderId:string|null}`。assigned共有は１人１行、束は１code１人、reserved/confirmedは各使用日時、未使用は日時/order null。anyoneは実使用者ごとに最新使用と注文を返し、結付け後のguestを二重に出さない。guest maskは先頭１字＋`***@`＋ドメイン、不正/空は`***`。退会したassigned行はassigneeDeleted=true、TSで「退会済みの会員」、復活/誰でもcode化をしない。３状態は未使用/使用済み（入金待ち）/使用済み。
- Produces: C12の使用後判定は**reserved/confirmed/cancelledを含む過去のredemptionの存在**で固定する。使用後に許すpatchキーは`name,startsAt,endsAt,usageLimit,advertise,advertisingText`だけ、停止/割当追加は専用関数。値/対象/種類/併用/人の選択/guest/初回/once/repeat/最低条件/methodを変更しない。未使用でもコード変更はglobal unique、使い捨ての束の既存codeは書き換えない。
- Produces: H1で定義した`discounts.admin_requests`へrequestKey→{hash,result}を保存する。作成/複製は`creation_request_key`と`creation_request_hash`を使う。重複再送は同結果、違う本文ならREQUEST_KEY_CONFLICT。actorもhashに入れる。新しい８表目を作らず既存のG業務operationへ混ぜない。共有codeの人/guest設定は親の入力をcodeへ写し、束でuserIdsを指定したcodeはassigned/allow_guests=falseへ固定する。
- Produces: suffixは**割り当てなしのanyone束は８字固定、会員へ割り当てる束は４字固定**、文字集合`23456789ABCDEFGHJKMNPQRSTUVWXYZ`の暗号学的乱数。衝突は同じ長さで最大32回/コード、尽きたらbatch全体をrollbackしてGENERATION_FAILED。prefixは大文字英数字/ハイフン1〜55字・末尾ハイフン不可、完成形64字以内、prefix単独は登録しない。
- Produces: 自動25件はstopped=falseの全期間の重なりの最大数で検査（未来の予定同士も対象、終了=次の開始は重ならない）。C21は併用チェックの片方でもONのautomaticを分類別に各６件まで。C22はセット最大組数で、組数/探索予算の保存欄を足さない。商品の併用ONのset同士はcode/automaticを問わず重なる期間のitem集合が交わればSTACKABLE_SET_ITEM_CONFLICT。作成/未使用update/期間update/再開をG共通→H目録鍵で直列化し、遅延constraint triggerでも検査する。停止中/重ならない期間は対象外。25件・６件・set重複は３つの異なる固定コードで返す。
- Produces: contextはphaseを必ず検証する。memberの前回着数は入金済み以降の通常行quantity−成功したrefund数量（下限0）、pending/error/交換は除外。初回はmember/guestとも入金済み以降の注文が無い時（Task7の状態集合）、guest confirm/acceptanceではtrim/lowercaseした同メールのmember注文も含む。未入金/放棄/期限切れ/入金前取消と今のdraft/orderは除外。guest previewは注文/本人使用を一切検索せずhasPreviousOrder=null/hasFirstOrderReservation=null/buyerUses=null/buyer.normalizedEmail=null。全体/単発の回数だけはメールと独立に読めるがguest拒否は一律文/理由へ潰す。メールでmemberのAを与えない。
- Produces: facts.hasFirstOrderReservationは有料履歴と分け、同じidentityの別draftでfirst_order_only_snapshot=trueかつreservedが１件でもあればtrue。guest previewはこれもnull/検索0。confirm/acceptanceはboolean、Task7のrecheck helperでは引数_order_idの今の予約を除外して同じfactsを作る。初回限定はhasPreviousOrder=falseかつhasFirstOrderReservation=falseだけ可。自動の初回が別draftの予約で外れた後もconfirmが同じ事実で落とすため、再確認を繰り返さない。
- Produces: `DiscountSearchAttention={openedAt:string;count:number}`。list各行/get詳細へsearchAttentionを返し、管理DISCOUNTの要対応「割引の計算を確認してください。」にする。read権限で見え、manageで既存admin_update_discountの制御patch `{acknowledgeSearchAttention:true}`により注意だけ閉じる。これは設定変更でなくC12の６許可キーとは別の制御操作（他キーとの混在拒否）、版/requestKey/監査は通常updateと同じ。countは履歴として保持、次のguardで再び開く。注意の記録/解決もG共通→H目録→discount idの鍵順、候補id昇順で行い、設定versionは注意recordでは増やさず解決updateだけ増やす。追加８表目を作らず新しいdiscounts列だけを使う。
- Produces: H2 assert DETAIL `h2_functions`・`h2_public_acl`・`h2_permission_checks`・`h2_admin_requests`・`h2_code_unique`・`h2_automatic_lock`・`h2_stackable_cap`・`h2_set_items_disjoint`・`h2_search_attention`・`h2_reads_stable`。cap/共有規則のtrigger/鍵とfallback記録入口のservice専用も検査する。

- [ ] **Step 1: 失敗するDB試験を書く。** `FREQ-547-AC-01: 一覧は予定・有効・期限切れ・止めたと予約込み回数を返し、絞り込みと頁が一致する`（日時境界/LIKE特殊文字/101拒否）、`FREQ-547-AC-02: 使用後は許可した６項目だけ変更でき、複製は使用と割り当てを引き継がない`（禁止全キー/版違い40001/取消済みもlock/停止再開で使用維持）、`FREQ-547-AC-03: 同じコードを10人に割り当てると10行で、予約・確定・取消と最新注文を区別しゲストを伏せる`（10件/20頁、unused→reserved→confirmed、cancelled→unused、usedAt/link）、`FREQ-547-AC-04: 100個の束は全体で一意で、101と接頭辞だけは使えない`（文字集合/4〜8/衝突再生成/rollback/再送/別本文拒否）、`FREQ-547-AC-05: 解除と受付が競合したらどちらか一方が先に決まり使用後の解除は拒否される`（Task 7で実受付との対を完成、ここでは予約fixtureとの対）。
- [ ] **Step 2: 資格と並行のREDを追加して測る。** `FREQ-544-AC-01: confirmだけが同メールの有料履歴を読みpreviewはメールが違っても同じ見込みを返す`（有料/注文なし/期限切れ未入金のpreview同値・履歴検索0、confirmでは有料だけ初回不可）。`FREQ-543-AC-01: 管理RPCは無効な役割と期限切れuser_rolesと足りない権限を42501で拒む`（service_role＋actor成功、aal/sessionはDB対象外）。`FREQ-546-AC-03: 予定の重なり25件へ同時に２件足しても26件にならない`。`FREQ-547-AC-04: 重ねる自動は分類ごと６件で７件目を保存できず共有itemのセットも拒む`（25件全て併用ONはSTACKABLE_AUTOMATIC_LIMIT、片方ONも数える、商品6/注文6/非併用13は可、期間境界/未来/停止再開/使用後期間変更、codeのsetも共有禁止）。同時６→７/重複setの２取引は１件だけ成功、constraint改ざんをh2_stackable_cap/h2_set_items_disjointで拒否。`FREQ-546-AC-04: guardの要対応はcodeを保存せず10分に１回で管理readだけへ出る`（記録service専用/guest不可、解決manage/版/再送/再発）。`npx.cmd jest tests/integration/db/group_h_admin.integration.test.ts tests/integration/db/group_h_admin_concurrency.integration.test.ts tests/integration/db/group_h_context.integration.test.ts --runInBand`。
- [ ] **Step 3: InterfacesのSQL関数を実装する。** actor/body/version/requestKeyの検証、G共通鍵、H目録/本人/割引の順を保つ。H1の既定列を使い、readは１呼出し１snapshot。
- [ ] **Step 4（controller）: 共通verifyでGREENを測る。** Step 2とH1/assert、G-0権限回帰。H2の入口をanon許可/DEFINER化、STABLE欠落、権限検査欠落、余分overloadで改ざんし固定SQLSTATE/DETAILを検査。並行を３連続、PostgRESTで新しい全入口を照合する。
- [ ] **Step 5（controller）: Filesだけコミットする。** `feat(discounts): 管理の作成と割り当てと使い捨てコードをDBで実装する`

### Task 4: 管理API・store・入力と監査

**Files:**
- Create: `src/lib/discounts/admin-discount-types.ts`、`src/lib/discounts/admin-discount-schema.ts`、`src/lib/discounts/admin-discount-store.ts`、`src/lib/discounts/admin-discount-route.ts`
- Create: `src/app/api/admin/discounts/route.ts`、`src/app/api/admin/discounts/[id]/route.ts`、`src/app/api/admin/discounts/[id]/stop/route.ts`、`src/app/api/admin/discounts/[id]/resume/route.ts`、`src/app/api/admin/discounts/[id]/duplicate/route.ts`、`src/app/api/admin/discounts/[id]/assign/route.ts`、`src/app/api/admin/discounts/[id]/unassign/route.ts`、`src/app/api/admin/discounts/[id]/codes/route.ts`、`src/app/api/admin/discounts/members/route.ts`
- Create: `tests/unit/lib/discounts/admin-discount-store.test.ts`、`tests/unit/lib/discounts/admin-discount-schema.test.ts`、`tests/unit/api/admin/discount-routes.test.ts`
- Modify: `docs/02_Requirements/requirements.md`（543/547）、`docs/03_BasicDesign/api/api-spec.md`、`docs/03_BasicDesign/api/route-inventory.md`、`docs/05_Quality/tests/test-spec.md`、`tests/unit/docs/order-status-traceability.test.ts`、`tests/unit/docs/delivery-status-traceability.test.ts`（route数を追加９ファイル/11メソッド分だけ追従）
- Test: 上記３本。共通guardは実装を丸ごとmockせず、認可/CSRF/制限/DB/監査の各依存を記録して順をassertする。

**Interfaces:**
- Consumes: Task 3の全SQL signatures/JSON、Task 2の共通型と`DiscountDefinition`、`authorizeAdminPermission(requiredPermission:PermissionCode,request?:Request):Promise<AuthzResult>`、`enforceRateLimit({request,endpoint,limit,windowSeconds,subject?})`、`getClientIp(request)`、`logAudit`、G-0の32件目録。
- Produces: `DiscountCreateInput=Omit<DiscountDefinition,'id'|'version'> & {code:string|null;codeMode:'shared'|'batch'}`、`DiscountPatch=Partial<Omit<DiscountCreateInput,'codeMode'>>|{acknowledgeSearchAttention:true}`、`DiscountFilters={status?:DiscountListRow['status'];kind?:DiscountKind;method?:DiscountMethod;query?:string}`。`DiscountListRow`と`DiscountAssignmentRow`はTask 3の形をこのtypesへ置き、SQLとstore両方がテストで同じJSON契約を証明する。
- Produces: `listAdminDiscounts(client:SupabaseClient,actorId:string,filters:DiscountFilters,page:number):Promise<{total:number;rows:DiscountListRow[]}>`、`getAdminDiscount(client:SupabaseClient,actorId:string,id:string,page:number):Promise<AdminDiscountDetail>`、`createAdminDiscount(client:SupabaseClient,actorId:string,input:DiscountCreateInput,requestKey:string):Promise<DiscountWriteResult>`、`updateAdminDiscount(client:SupabaseClient,actorId:string,id:string,patch:DiscountPatch,expectedVersion:string,requestKey:string):Promise<DiscountWriteResult>`、`setAdminDiscountStopped(client:SupabaseClient,actorId:string,id:string,stopped:boolean,expectedVersion:string,requestKey:string):Promise<DiscountWriteResult>`、`duplicateAdminDiscount(client:SupabaseClient,actorId:string,id:string,requestKey:string):Promise<DiscountWriteResult>`。
- Produces: `assignAdminDiscount(client:SupabaseClient,actorId:string,id:string,codeId:string,userIds:readonly string[],requestKey:string):Promise<DiscountAssignmentResult>`、`unassignAdminDiscount(client:SupabaseClient,actorId:string,id:string,codeId:string,userId:string,requestKey:string):Promise<DiscountAssignmentResult>`、`generateAdminDiscountCodes(client:SupabaseClient,actorId:string,id:string,prefix:string,userIds:readonly string[],count:number,requestKey:string):Promise<DiscountBatchResult>`、`searchAdminDiscountMembers(client:SupabaseClient,actorId:string,query:string):Promise<DiscountMember[]>`。
- Produces: `AdminDiscountDetail={discount:DiscountDefinition;used:boolean;assignmentTotal:number;assignments:DiscountAssignmentRow[];searchAttention:DiscountSearchAttention|null;permissions:{read:boolean;manage:boolean}}`、`DiscountWriteResult={discountId:string;version:string;replayed:boolean}`、`DiscountAssignmentResult={discountId:string;changedCount:number;replayed:boolean}`、`DiscountBatchResult={discountId:string;batchId:string;codes:{codeId:string;code:string;userId:string|null}[];replayed:boolean}`、`DiscountMember={userId:string;name:string|null;email:string}`。storeの`AdminDiscountStoreError`は`code:keyof typeof GROUP_H_ERRORS|null`だけを外へ持つ。

| HTTP | 入力 / 成功応答 / 権限 |
|---|---|
| `GET /api/admin/discounts` | query `status,kind,method,query,page`のみ（page1〜100000）、200 `{data:{total,rows},permissions:{read,manage}}`、read |
| `POST /api/admin/discounts` | `{input:DiscountCreateInput,requestKey:string}`、201 `{data:DiscountWriteResult}`（再送も同じ本文）、manage |
| `GET /api/admin/discounts/[id]` | query`page`、200 `{data:AdminDiscountDetail}`、read |
| `PATCH /api/admin/discounts/[id]` | `{patch:DiscountPatch,expectedVersion:string,requestKey:string}`、200 `{data:DiscountWriteResult}`、manage |
| `POST .../[id]/stop` / `resume` | `{expectedVersion:string,requestKey:string}`、200 `{data:DiscountWriteResult}`、manage |
| `POST .../[id]/duplicate` | `{requestKey:string}`、201 `{data:DiscountWriteResult}`、manage |
| `POST .../[id]/assign` | `{codeId:string,userIds:string[],requestKey:string}`、200 `{data:DiscountAssignmentResult}`、manage |
| `POST .../[id]/unassign` | `{codeId:string,userId:string,requestKey:string}`、200 `{data:DiscountAssignmentResult}`、manage |
| `POST .../[id]/codes` | `{prefix:string,userIds:string[],count:number,requestKey:string}`、201 `{data:DiscountBatchResult}`、manage |
| `GET /api/admin/discounts/members` | query`query`のみ、200 `{data:DiscountMember[]}`、manage |

- Produces: writeは`admin.discounts.write`でIP30/600秒とactor30/600秒、codesは加えて`admin.discounts.codes`でIP10/600秒・actor10/600秒、member検索は`admin.discounts.members`でIP60/600秒・actor60/600秒。通常readは回数制限を増やさない。全管理readのno-storeを維持。write bodyはzod `.strict()`、UUIDとbigint文字列0〜9223372036854775807、未知キー/空patch/重複userIdsを400。`kind`別の対象/値/最低条件/guest/広告の整合をschemaで検査する。保存前に読んだ有効期間/分類/itemの目録を使う`validateDiscountActivation(input:Omit<DiscountDefinition,'id'|'version'>,existing:readonly DiscountDefinition[],replacingId?:string):{ok:true}|{ok:false;code:'GROUP_H_AUTOMATIC_LIMIT'|'GROUP_H_STACKABLE_AUTOMATIC_LIMIT'|'GROUP_H_STACKABLE_SET_ITEM_CONFLICT'}`をschemaへ置き、25/各６/セット共有を検査する。raceの最終判定は鍵の下のDBで同じく行う。制御patch acknowledgeSearchAttentionはtrue単独だけ。storeのcreate/update/resumeは通常zod検証後にget_admin_discount_activation_contextで候補/期間の目録を読み、この純粋schemaを実行してからwriterへ進む（manage権限だけで動く）。`validateAdminDiscountActivation(client:SupabaseClient,actorId:string,id:string|null,patch:DiscountCreateInput|DiscountPatch|{stopped:false}):Promise<void>`をstoreへ置く。確認中に他の設定が変わってもwriterの鍵の下の検査を省かない。stop/duplicate/注意の解決は有効数を増やさないのでこの前読取は不要。
- Produces: 監査actionは`admin.discounts.create/update/stop/resume/duplicate/assign/unassign/generate_codes`、resource=`discounts`、resource_id=検証済みdiscountId（不正idはnull）、metadataは`changed_count,generated_count,replayed,result_code`のうち該当するものだけ。code/name/email/userIds配列/prefix/queryは載せない。成功/failure/errorを既存`outcome`へ対応させる。権限拒否の既存共通本文は変えない。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-543-AC-01: routeは結付いたaal1を403、失効・期限切れのapp sessionを401、確認不能を503で拒否してRPCを呼ばない`（結付いたaal1、結付いたaal2、revoked/期限切れ、成功のaal2/live、DB試験の役割拒否とは別のassert）、`FREQ-543-AC-02: 管理writeは認可・CSRF・IP・actor・入力・RPC・監査の順で途中拒否後の処理を呼ばない`（401/403/429/503/400、本文actor偽装不可）、`FREQ-543-AC-02: 管理readの全応答はno-storeで監査を呼ばない（10.1）`（200/400/403/404/500と秘密文字列の非露出）、`FREQ-547-AC-02: storeはSQLSTATEとmessageの組だけを分類し不正JSONは500にする`（拒否表全行、別SQLSTATE/details/hint）、`FREQ-547-AC-04: 円引き・set・batchの境界と未知キーを400にする`（率0/100、円0、最低額=円額、set1/11、batch0/101、prefix56、guest+assigned）。`FREQ-547-AC-04: schemaとDB拒否は分類６件とセット共有の同じ固定コードと文になる`（期間±1、各６可/７不可、25全併用不可、code/自動set共通、DB409本文exact）。
- [ ] **Step 2: REDを測る。** `npx.cmd jest tests/unit/lib/discounts/admin-discount-store.test.ts tests/unit/lib/discounts/admin-discount-schema.test.ts tests/unit/api/admin/discount-routes.test.ts --runInBand`。
- [ ] **Step 3: Interfacesどおりのstoreと11メソッドを実装する。** GET member検索も認可→制限→検証→RPCとし、CSRFが必要なwriteと同じ関数へ無理にまとめない。汎用helperは各routeの順と拒否を隠さない。
- [ ] **Step 4: GREENを測る。** Step 2と型/lint/`npm.cmd run validate-docs`。controllerはrole付与/剥奪を実DBで反映して403/200がUI旗と一致することをTask 11へ渡す。ドキュメントの既存失敗と新しい失敗は分けて記録する。
- [ ] **Step 5（controller）: Filesだけコミットする。** `feat(discounts): 管理APIと検証付きstoreを追加する`

### Task 5: DISCOUNT一覧・詳細・作成編集・会員の選択

**Files:**
- Create: `src/components/DiscountSection.tsx`、`src/features/discounts/components/DiscountList.tsx`、`src/features/discounts/components/DiscountDetail.tsx`、`src/features/discounts/components/DiscountForm.tsx`、`src/features/discounts/components/DiscountAssignments.tsx`、`src/features/discounts/components/DiscountMemberPicker.tsx`、`src/app/admin/discounts/new/page.tsx`、`src/app/admin/discounts/[id]/page.tsx`、`src/app/admin/discounts/[id]/edit/page.tsx`
- Create: `tests/unit/components/DiscountSection.test.tsx`、`tests/unit/features/discounts/DiscountList.test.tsx`、`DiscountDetail.test.tsx`・`DiscountForm.test.tsx`・`DiscountAssignments.test.tsx`・`DiscountMemberPicker.test.tsx`（同じ`tests/unit/features/discounts/`）
- Modify: `src/app/admin/page.tsx:27-49`（タブと選択描画）、`src/components/AdminTabs.tsx`、`src/components/AdminSideNav.tsx`、`tests/unit/components/AdminSideNav.badges.test.tsx`、`docs/02_Requirements/requirements.md`（547/543）、`docs/03_BasicDesign/ui/screen-list.md`、`docs/03_BasicDesign/ui/screen-flow.md`、`docs/04_DetailDesign/pages/16_admin.md`、`docs/05_Quality/tests/test-spec.md`
- Test: 上記７本（ナビ既存を含む）。

**Interfaces:**
- Consumes: Task 4のHTTP/型とpermission旗、`clientFetch`。`DiscountSection():React.JSX.Element`は一覧と作成への入口。DISCOUNTを店長とsupporter両方のCONTACT直後へ置き、未付与supporterは権限拒否の文を出す。役割名でH権限を補わない。
- Produces: `DiscountList(props:{onOpen:(id:string)=>void;onCreate:()=>void}):React.JSX.Element`、`DiscountDetail(props:{discountId:string}):React.JSX.Element`、`DiscountForm(props:{initial:AdminDiscountDetail|null;onSaved:(id:string)=>void}):React.JSX.Element`、`DiscountAssignments(props:{detail:AdminDiscountDetail;page:number;onPage:(page:number)=>void;onChanged:()=>Promise<void>}):React.JSX.Element`、`DiscountMemberPicker(props:{selected:readonly DiscountMember[];onChange:(members:DiscountMember[])=>void}):React.JSX.Element`。新規/詳細/編集の３pageはparamsのPromiseをawaitする現行Nextの方式でIDを渡す。
- Produces: 一覧は「割引名・種類・効き方・状態・期間・使った回数／上限」、状態は「予定・有効・期限切れ・止めた」、filtersは状態/種類/効き方、検索は名前とコード。20件/頁、total、空「割引はありません。」、searchAttentionありは要対応「割引の計算を確認してください。」と件数を出す。read拒否「割引を見る権限がありません。」、失敗「割引を読み込めませんでした。」、reload「読み直す」。
- Produces: 詳細の「止める」「再開する」「複製」「編集」「割り当てを足す」、searchAttentionありはmanageだけ「確認済みにする」、表は「コード・割り当てた人・状態・使った日・注文」。状態辞書unused=`未使用`、reserved=`使用済み（入金待ち）`、confirmed=`使用済み`、未使用だけ「外す」。注文は`/admin/orders/[orderId]`へのリンク、read権限が異なる注文先はその頁で認可する。guestはマスク済み値しか受け取らない。
- Produces: フォームは「注文の％引き」「注文の円引き」「商品の割引」「リピート割引」「セット割引」、code/automatic、率/円、対象外/対象の服、最低無し/金額/点数、割り当てた人だけ/コードを知っていれば誰でも、guest許可、初回、全体回数、１人１回、開始/終了（日本時間）、併用２つ、repeat A/B、広告切替/案内文。既定はmemberだけ、併用両方OFF、広告OFF、setはautomatic。assignedのguest欄は選べずfalseへ固定。自動では人の割当欄を出さない。C21の説明「重ねられる自動の割引は、商品の割引と注文の割引でそれぞれ6件までです。」と共有setの拒否文を該当欄に結ぶ。セットの最大組数/部分組数を選ぶ欄は作らない（C22）。
- Produces: used=trueではC12以外をdisabled、説明「使用後に値や対象を変える場合は、複製して新しく作ってください。」。未使用でも期間/円の条件/セットの個数を満たさないと保存不可。duplicate後は停止中の新詳細へ移動、新しいcodeの設定後に再開。stop/resume/assign/unassign/batchの成功後は詳細と一覧を再読込、再読込失敗は「変更しましたが、最新の情報を読み込めませんでした。」と出して古い状態の操作を止める。
- Produces: 検索は２字から・300ms debounce・20人、`AbortController`で前の検索を止める。非okのbodyを読み終えてからエラーを出す。前の検索結果を遅い応答が上書きしない。削除/停止の連打は同じrequestKeyを保つ。タブ/表/ボタン/フォームの操作はroleとexactなaccessible nameで試験する。

- [ ] **Step 1: 失敗するRTL試験を書く。** `FREQ-547-AC-01: CONTACTの後にDISCOUNTがあり一覧の７列と３つの絞り込みを表示する`（店長/supporter順、20行とpage、空/取得失敗/403、guard要対応はread表示/manage解決）、`FREQ-547-AC-03: 10人の割り当ては10行で３つの状態と使用日と注文リンクが分かる`（guestマスク、使用済みに外すなし）、`FREQ-547-AC-02: 使用後フォームは許可した欄だけ編集でき、複製から新しい割引へ進める`、`FREQ-547-AC-04: 種類別の必須欄と１から100個の束を検査し接頭辞を有効コードに見せない`、`FREQ-547-AC-05: 会員の名前とメールで探して追加でき、古い検索応答と二重送信を無視する`、`FREQ-543-AC-03: manageなしは操作を出さず、付与後の読み直しで操作できる`。401/403/429/503のReadableStreamを使い、読了/cancelが呼ばれることもassertする。
- [ ] **Step 2: REDを測る。** `npx.cmd jest tests/unit/components/DiscountSection.test.tsx tests/unit/features/discounts --runInBand`。欠けたtab/部品の失敗を記録する。
- [ ] **Step 3: Interfacesどおりの部品と頁を実装する。** 390pxは画面幅内、表は見出し付きの横スクロール領域。read/manageはAPI/DBで守り、disabledだけに頼らない。入力エラーは該当欄へ結び、保存後のfocusとエラーlive regionを定める。
- [ ] **Step 4: GREENを測る。** Step 2、ナビ既存、型/lint。幅/キーボード/実認可の成功はTask 11の本番buildで測り、RTLの成功と区別する。
- [ ] **Step 5（controller）: Filesだけコミットする。** `feat(discounts): DISCOUNT一覧と割り当て詳細と種類別フォームを追加する`

### Task 6: checkoutのコード検証・draft固定・１回限りcoupon

controllerは最初に別セッションへ`src/app/api/checkout/**`・`src/features/checkout/**`の変更開始と対象を通知し、共有差分を確認する。

**Files:**
- Create: `supabase/migrations/<ts3>_group_h_discounts_checkout.sql`、`src/features/checkout/services/checkout-discounts.service.ts`、`src/features/checkout/services/stripe-discount-coupon.service.ts`、`tests/integration/db/group_h_checkout_draft.integration.test.ts`、`tests/unit/features/checkout/services/checkout-discounts.service.test.ts`、`tests/unit/features/checkout/services/stripe-discount-coupon.service.test.ts`
- Modify: `docs/04_DetailDesign/states/checkout-draft.md`（createdで割引額0/固定version1、completedでStripe割引を書戻し、旧NULL分岐）。
- Modify: `src/app/api/checkout/promotion-code/route.ts:15-99`、`src/app/api/checkout/create-session/route.ts:88-1100`（現在のschema・再計算・draft claim・Stripe parameters）、`src/app/api/checkout/resume/route.ts:121-155`、`src/features/checkout/services/promotion-code.service.ts:1-177`、`src/features/checkout/services/checkout-route-guard.ts:29-38`、`src/features/checkout/services/checkout-draft.service.ts:135-220`、`src/features/checkout/services/checkout-confirmation.service.ts:21-74`、`tests/unit/api/checkout/promotion-code-route.test.ts`、`tests/unit/api/checkout/create-session-route.test.ts`、`tests/unit/api/checkout/resume-route.test.ts`、`tests/unit/features/checkout/services/promotion-code.service.test.ts`、`tests/unit/features/checkout/services/checkout-confirmation.service.test.ts`、`tests/integration/db/group_h_migration_asserts.integration.test.ts`
- Modify: `docs/02_Requirements/requirements.md`（542/546/548/389/397/420）、`docs/03_BasicDesign/api/api-spec.md`、`docs/04_DetailDesign/pages/13_checkout.md`、`docs/06_Operations/db-migrations.md`、`docs/05_Quality/tests/test-spec.md`
- Test: 上記７単体（既存５＋新規２）とdraft/assert DB。Task 2の純粋engineをprovider試験と混同しない。

**Interfaces:**
- Consumes: `calculateDiscounts(input:DiscountInput):DiscountResult`、`get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text)`、検証済み買い手とDB価格のカート行、既存`claim_checkout_draft`の15引数（session/requestVersion/fingerprint/uiMode/origin/paymentMethod/currency/subtotal/tax/shipping/total/shippingSnapshot/itemsSnapshot/buyerUserId/cartId）。snapshotの`source_cart_line_id`をengineのlineKeyへ写す。
- Produces: `loadCheckoutDiscountContext(client:SupabaseClient,buyer:DiscountBuyer,codes:readonly string[],itemIds:readonly number[],at:string,phase:'preview'|'confirm'):Promise<{discounts:DiscountDefinition[];facts:DiscountFacts;refusals:DiscountRefusal[]}>`、`evaluateCheckoutDiscounts(client:SupabaseClient,buyer:DiscountBuyer,lines:readonly DiscountLine[],codes:readonly string[],at:string,phase:'preview'|'confirm'):Promise<{result:DiscountResult;facts:DiscountFacts;refusals:DiscountRefusal[]}>`。promotion-code/cart/広告はpreview、create-sessionはconfirmをserverが固定して渡す。guest previewはtyped guestEmailを保持/使用せずbuyer.normalizedEmail=null/_guest_email=NULL、履歴/本人回数/本人の初回予約を読まずhasPreviousOrder/hasFirstOrderReservation/buyerUses=nullで見込みを計算する。Stripe promotionCodes.listを呼ばない。
- Produces: `refusals`へ入れるのは本人が入力したcodeの不適合だけ。automaticの不適合はevaluateEligibilityのeligible=false/refusal=nullとして候補から落とす。automaticにダミーcodeの拒否を作らず、confirmのコード拒否へ混ぜない。
- Produces: `POST /api/checkout/promotion-code` bodyは`.strict()`の`{codes:string[];guestEmail?:string}`（正規化後0〜5件、各1〜64英数字/ハイフン、guestEmailはemail/max254の形式検査だけで破棄）。200 `{result:DiscountResult}`。guestのメール条件はメール入力後もprovisional=true/「見込み」、別のメールでも注文の有無にかかわらず応答同値。無効codeは422 `{error:'promotion_code_invalid',refusals:DiscountRefusal[],message:string}`、guestは全refusalsを入力codeとreason=not_eligibleだけにし、messageは一律`このコードは使えません。会員の方はログインしてからお試しください。`、codeId/最低額/用途/存在などの差を返さない。memberはrestrictedを同じnot_eligible/`このコードは使えません`、guest許可anyoneのpublicだけdistinct reason/文。形式不正400、一時失敗500はcodeの無効と区別する。探索guardはcalculationMode=fallbackの200で、検索用503を返さない。
- Produces: ログイン済みmemberのpublic文だけ`このコードは使えません`・`このコードは有効期限が切れています`・`このコードは利用回数の上限に達しています`・`このコードは ¥{桁区切り最低額} 以上のご注文で使えます`、数量不足は汎用文。不正0円結果はログイン済みpublicにだけ旧`このコードでは合計が0円になるため使えません`。guestは期限/上限/最低額/0円を含め全て一律のguest文、memberの限定codeも全て汎用文。guestEmailは監査/ログに残さない。
- Produces: guardの既存IP10/10秒・60/600秒、session10/60秒を保ち、memberは`checkout:promotion-code:member`にsubject=userIdの10/60秒を加える。ゲストメールを制限/監査の生値に使わない。成功監査もcode文字/名称を載せずdiscountId/codeIdと件数だけ。
- Produces: create-session側も既存`checkout:create-session:ip-10s`=10/10秒、`checkout:create-session:ip-10m`=60/600秒、`checkout:create-session`のsession=10/60秒を維持する（create-session/route.ts:241-242,487-504）。getClientIp以外のIP源やguestEmailのbucketを足さず、配送先履歴照合の前に全て適用する。
- Produces: `recordDiscountSearchFallback(client:SupabaseClient,discountIds:readonly string[]):Promise<void>`をcheckout-discounts.serviceへ置く。calculationMode=fallback時だけrecord_discount_search_fallbackを呼び、固定code=`discount_search_guard_exceeded`と候補id/件数だけを監査/ログへ残す。code/name/email/入力値なし。管理DISCOUNTの要対応が出る。記録I/Oの失敗でも計算した額で200を返し、固定code=`discount_search_attention_failed`をerror logへ残す（不具合で買い物を拒否しない）。cartはTask8から同じhelperを使う。
- Produces: H3の`private/public.claim_checkout_discount_draft(_claim jsonb,_discount_result jsonb,_discount_facts jsonb) RETURNS jsonb`。`_claim`は既存15引数のcamelCase object `CheckoutDiscountClaim`、未知キー拒否・金額/配送/所有者検証を既存関数へ渡して同じ取引で固定欄を埋める。返り`{draftId:string;checkoutSessionId:string|null;claimCreated:boolean;discountResult:DiscountResult;discountSnapshotHash:string}`。`CheckoutDiscountClaim={sessionId:string;requestVersion:number;requestFingerprint:string;checkoutUiMode:'custom';checkoutOrigin:string;paymentMethod:StripeCheckoutPaymentMethod;currency:'jpy';subtotalAmount:number;taxAmount:0;shippingAmount:0;totalAmount:number;shippingSnapshot:CheckoutShippingSnapshot;itemsSnapshot:CheckoutDraftItemsSnapshot;buyerUserId:string|null;cartId:string}`。totalAmount/draft.total_amountは割引前、result.totalAmountは割引後。**create-sessionはcheckout_drafts.discount_amountを触らず0のまま**、額はdiscount_resultだけへ置く。status=createdかつengine_version=1ならdiscount_amount=0のCHECKとh3_amount_checks assertを付ける。provisional=true/guest facts未確認は固定拒否。割引0でもversion1のresult/factsを全て保存する。
- Produces: `discount_snapshot_hash`はversion・全lineKey/単価/数量・正規化コード・候補id/version・資格の事実・resultのcanonical JSONをSHA256。資格のhashにはbuyer/hasPreviousOrder/hasFirstOrderReservation/priorUnits/割当/code設定を含め、観測日時atとreserved/confirmed/buyerUses/codeUsesの生カウンターは含めない（同じ判断の通信再送で別draftを増やさない）。factsの全値は最初のclaimで保存する。既存requestFingerprintへこのhashを含める。DBはsnapshot全lineの一対一/数量ぶんunit/整数/非負/総和/50円/候補codeIdの対応を検査し、同じdraftの固定済みhashが違えば`GROUP_H_DRAFT_SNAPSHOT_CONFLICT / 22023`。同hashの再送は最初に保存したresult/factsを返し上書きしない。H3で`checkout_drafts.stripe_discount_coupon_id text null`を追加（旧行null）。
- Produces: `private/public.attach_checkout_discount_coupon(_draft_id uuid,_snapshot_hash text,_coupon_id text) RETURNS boolean`。固定hash一致/未完成draftだけにsetし、同じidはtrue、異なるidはSNAPSHOT_CONFLICT。public service専用、privateはDEFINER。`claimCheckoutDiscountDraft(client:SupabaseClient,claim:CheckoutDiscountClaim,result:DiscountResult,facts:DiscountFacts):Promise<CheckoutDiscountDraft>`、`CheckoutDiscountDraft`はclaimの上記戻り型＋`stripeDiscountCouponId:string|null`（DB readにもこのキーを加える）。
- Produces: `createStripeDiscountCoupon(stripe:Stripe,draftId:string,snapshotHash:string,amount:number):Promise<string|null>`。amount0はnullでAPIを呼ばず、正は`stripe.coupons.create({amount_off:amount,currency:'jpy',duration:'once',max_redemptions:1,metadata:{checkout_draft_id:draftId}}, {idempotencyKey:'h-discount:'+draftId+':'+snapshotHash})`。code/name/emailをStripe metadataへ入れない。既存idがあれば作り直さず使う。Sessionの`discounts:[{coupon:id}]`、`promotion_code`と`allow_promotion_codes`は使わない。couponが作られてSession失敗でも同じdraft/hash/idで再送する。
- Produces: create-sessionは`promotionCodes:string[]`を正規化し、DB価格と既存の表示額照合（割引前のsubtotal/tax/shipping/total）を保つ。guestの初回/１人１回はここで初めて配送先メールと記録を照合する。不適合の**automaticだけ**は候補から外し再計算して200のconfirmationへ進む（最終画面で見込みを外した新総額を見せる）。入力codeが不適合の時だけ409 `{error:'discount_conditions_changed',retryable:false,returnTo:'input',definitive:true,refusals:DiscountRefusal[],message:'割引の条件が変わりました。入力画面で割引を確かめてください。'}`。guest/restrictedのrefusalsはnot_eligibleだけ、履歴/回数の詳細なし。`buildCheckoutConfirmation`と`CheckoutConfirmation`の単一promotionCodeを`promotionCodes:readonly string[];discountResult:DiscountResult|null`へ替え、resumeもHは固定draftから復元。旧draftだけmetadataの旧code１要素とdiscountResult=nullで互換読取。固定resultとStripeの実額を比較する。H3 assert DETAIL `h3_draft_freeze`・`h3_coupon_binding`・`h3_public_acl`・`h3_amount_checks`。

- [ ] **Step 1: 失敗する単体を書く。** `FREQ-548-AC-01: 未ログインの使えないコードは全理由が同じ文と理由で存在を区別できない`（不在/assigned/member-only/期間/上限/最低額/0円、exact guest全文、refusals reasonとキーが同じ、member限定は汎用・member publicは従来文）、`FREQ-548-AC-01: ゲストの見込みは別のメールでも同じ応答で注文の有無が分からない`（注文あり/なし/期限切れ未入金/未入力で同じresult・provisional=true、メール条件だけの自動割引も同値、SQLのメール/本人検索0、code/name/emailを監査しない）、`FREQ-548-AC-02: confirmで入力codeが不適合なら確定拒否として入力へ戻しdraftを作らない`（409/definitive=true/refusalsを保持・previewの見込みで再採用しない）、`FREQ-548-AC-02: 固定後もdraft.discount_amountは0で割引前同士の照合が成り立つ`（draft40000+0=Stripe37000+3000、既存再送同hash、割引0も固定）、`FREQ-548-AC-02: resumeは固定した複数コードと内訳を復元し旧draftも読める`、`FREQ-548-AC-03: 割引合計だけのonce couponを１つ付け旧Stripeコードを検索しない`（amount_off3000/duration once/max1/metadata draft/再送同id/0未作成/line_items元単価）。
- Test: `FREQ-548-AC-02: 前に注文のあるゲストは自動の初回割引が外れた額で最終確認へ進める`（previewは同じ見込み、confirmはautomatic初回を除いた200/新total、見込み409ループ0・コードなしで再入力要求0・支払前に額を表示）。`FREQ-548-AC-02: confirmで変わるゲストの割引にも既存IPとsessionの制限を先に掛ける`（getClientIp、IP10/10秒・60/600秒/session10/60秒、各limit+1は429/Retry-After、履歴/context/coupon0呼出し、制限を割引の有無で分けない）。`FREQ-546-AC-04: 探索guardでもpreviewとconfirmは200で同じfallback額を固定し要対応へ記録する`（単独/全併用の最善、record呼出し/固定logのみ、記録失敗でも200/金額一致、検索503なし）。
- [ ] **Step 2（controller）: draftのREDも測る。** `FREQ-542-AC-03: 固定のlineKeyと数量と配分と１着の総和が違えばdraftを残さない`、`FREQ-548-AC-02: 固定後の割引はJSONだけにありdiscount_amountを先に入れる改変をCHECKとassertが拒む`（0円割引もversion1、provisionalは拒否、40000+0=37000+3000）。`npx.cmd jest tests/unit/api/checkout/promotion-code-route.test.ts tests/unit/api/checkout/create-session-route.test.ts tests/unit/features/checkout/services/checkout-discounts.service.test.ts tests/unit/features/checkout/services/stripe-discount-coupon.service.test.ts --runInBand`、DBは`npx.cmd jest tests/integration/db/group_h_checkout_draft.integration.test.ts --runInBand`。
- [ ] **Step 3: Interfacesのservice・routes・H3を実装する。** 固定とcoupon生成の境界で通信失敗が起きても結果を取り直して既存Sessionへ違う割引を付けない。既存の画像URLの別セッションの変更を保持する。
- [ ] **Step 4（controller）: GREENを測る。** Step 2、promotion-code.service/confirmation/resume既存、H1〜H3 assertとcheckout owner/cart/draft既存DBを共通verify。H3の固定検査/入口ACL/coupon対応を改ざんしP0001とDETAILを検査する。Stripe SDK mockの成功は未確認事項のテストモード実測を代替しない。
- [ ] **Step 5（controller）: Filesだけコミットする。** `feat(checkout): 自店割引をdraftへ固定し一回限りcouponへ渡す`

### Task 7: 受付・使用予約・入金照合・遅れた支払いの要対応

controllerは最初に別セッションへ`src/app/api/checkout/**`・`src/features/checkout/**`の変更開始と対象を通知し、共有差分を確認する。

**Files:**
- Create: `supabase/migrations/<ts4>_group_h_discounts_acceptance.sql`、`tests/integration/db/group_h_acceptance.integration.test.ts`、`tests/integration/db/group_h_redemptions.integration.test.ts`、`tests/integration/db/group_h_acceptance_concurrency.integration.test.ts`、`src/app/api/admin/order-attention/discounts/[orderId]/resolve/route.ts`、`tests/unit/api/admin/discount-attention-route.test.ts`
- Create: `docs/04_DetailDesign/states/discount-redemptions.md`（reserved→confirmed/cancelled、cancelled→実入金confirmed、fallback awaiting/paidとattention、返金で戻さない）。
- Modify: `docs/superpowers/specs/2026-10-28-group-h-promotions-design.md`（Task7実装時に16章へownerが覆せるC20案だけ追記。今回の計画修正では触らない）。
- Modify: `src/app/api/checkout/place-order/route.ts:145-290`、`src/app/api/checkout/complete/route.ts:175-260`、`src/lib/stripe/checkout-payment-reconciler.ts:325-370`、`src/lib/stripe/checkout-payment-reconciler-deps.ts:88-210`、`src/lib/stripe/checkout-payment-decision.ts`、`src/lib/orders/order-payment-types.ts:65-85`、`src/app/api/admin/order-attention/route.ts`、`src/lib/orders/admin-orders/admin-order-types.ts:63-68`、`src/lib/orders/admin-orders/admin-order-store.ts`、`src/hooks/useOrderAttention.ts`、`src/components/AttentionInbox.tsx`
- Modify: `tests/unit/api/checkout/place-order-route.test.ts`、`tests/unit/api/checkout/complete-route.test.ts`、`tests/unit/lib/stripe/checkout-payment-reconciler.test.ts`、`tests/unit/api/admin/order-attention-route.test.ts`、`tests/unit/components/AttentionInbox.test.tsx`、`tests/unit/docs/order-status-traceability.test.ts`、`tests/unit/docs/delivery-status-traceability.test.ts`、`tests/integration/db/group_h_migration_asserts.integration.test.ts`、`tests/integration/db/helpers/group-h-fixtures.ts`、`tests/integration/db/helpers/group-g-allowlist.ts`、`tests/integration/db/group_g1_final_acl.integration.test.ts`、`tests/integration/db/group_g1_writer_inventory.integration.test.ts`、`tests/integration/db/group_g4_migration_asserts.integration.test.ts`
- Modify: `docs/02_Requirements/requirements.md`（549/542）、`docs/03_BasicDesign/api/api-spec.md`、`docs/03_BasicDesign/api/route-inventory.md`、`docs/04_DetailDesign/sequence/order-administration.md`、`docs/06_Operations/db-migrations.md`、`docs/05_Quality/tests/test-spec.md`
- Test: 上記DB４suite（assert含む）と受付/照合/要対応/AttentionInboxの単体、docs２本。

**Interfaces:**
- Consumes: 固定draftの`DiscountResult/DiscountFacts`、Task 3の資格読取、H1の７表。通常受付はStripeから取得した実額・Sessionの所有者を渡す。メールだけでmember資格に格上げしない。
- Produces: 既存`private/public.place_order_from_checkout_draft(_draft_id uuid,_checkout_session_id text,_cart_session_id text,_stripe_amount_total integer,_stripe_amount_discount integer,_stripe_currency text,_checkout_session_created_at timestamptz,_payment_intent_id text DEFAULT NULL,_shown_in_stock_variant_ids bigint[] DEFAULT NULL,_buyer_user_id uuid DEFAULT NULL) RETURNS TABLE(order_id uuid,order_status public.order_status,created boolean,rejection text)`を同じ引数/戻り型で置換。先頭のG共通鍵の後、固定draftから本人を読んで本人鍵を取り、対象discount idを昇順でlockし、Gの従来の在庫/行ロックへ進む。
- Produces: `private.group_h_recheck_discount_facts(_draft_id uuid,_order_id uuid DEFAULT NULL) RETURNS jsonb`→`{kind:'valid'|'codes_invalid'|'automatic_changed';rejection:string|null;invalidCodes:string[]}`、`private.group_h_copy_order_discounts(_draft_id uuid,_order_id uuid,_line_map jsonb) RETURNS void`、`private.group_h_reserve_redemptions(_draft_id uuid,_order_id uuid) RETURNS void`、`private.group_h_settle_redemptions(_order_id uuid,_paid boolean) RETURNS jsonb`。内部helperはservice_roleにもEXECUTEなし。line_map=`{lineKey:string,orderItemId:string}[]`、新明細INSERT時に対応を作る。呼出元の鍵不足はGROUP_H_LOCK_REQUIRED/55000（外500）。invalidCodesは本人の入力したcodeだけでguest/restrictedは理由を分けない。
- Produces: 通常受付は回数/１人１回/単発code・期間・停止・割当・初回・priorUnitsを鍵の下で再確認する。初回の有料履歴はmember/guestとも`(status IN ('paid','shipped') OR paid_amount>0)`（入金後cancelledも含む）だけ。paid_amountは入金の記録で成功返金後も初回の資格を戻さない。payment_in_progress/pending（入金待ち）/abandoned/failed/入金前cancelledと今作る注文自身は数えない。guestは正規化した同メールのmember注文も対象。初回の別draftのreservedは有料注文数へ加えず、並行予約を防ぐ別条件として検査する。同じ注文の複数first-only効果は１件。払った注文の返金/取消を初回へ戻さない。
- Produces: recheckは固定factsの初回/priorUnitsと関連itemの現在値を比較し、期間/stop/上限/割当を含め、使えなくなった入力codeだけcodes_invalidの拒否。automaticだけが条件を失ったらautomatic_changed（codes_invalidが優先）で注文/在庫hold/使用をまだ作らず、routeが新しいconfirm計算へ進める。コードの資格/額は変わらず単なるカウンター変動が上限内なら拒否しない。名前変更だけ等C12のversion差は金額を取り直す理由にしない。
- Produces: 入力code用rejectionは`discount_usage_limit`・`discount_once_per_customer`・`discount_expired`・`discount_stopped`・`discount_first_order_changed`・`discount_prior_units_changed`・`discount_not_eligible`。業務拒否はorder_id/status=NULL、created=false、注文/hold/使用/コピー0行。routeは409 `{error:rejection,retryable:false,returnTo:'input',definitive:true,refusals:DiscountRefusal[],message:'割引の条件が変わりました。入力画面で割引を確かめてください。'}`で共通文と本人codeのnot_eligibleだけ。旧amount/currency/zero/price/cart/loginの拒否は保持。
- Produces: automatic_changedはDB内部の`rejection='discount_automatic_changed'`で同じく無書込。routeはこの場合だけ既存`expireRejectedCheckoutSession`/`expireOpenCheckoutSession`で古い未払いSessionを失効し、200 `{reconfirmationRequired:true,returnTo:'confirmation'}`を返す（409/inputにしない）。UIはconfirmを呼ばず、既存create-session経路を新しいrequestVersionで呼び、不適合autoを落とした新draft/coupon/Sessionのconfirmationを表示する。古い固定JSONを上書きせず、新しい合計を見せて再度「注文する」を押すまで支払わない。Session失効競合で既にpaid/awaitingなら再計算せず既存reconcilerの非拒否経路へ進む。失効に失敗した時に古いclientSecretで決済しない。
- Produces: 同じ受付取引でallocations/unitAmountsを新明細へコピーし、orders.discount_amount=result.discountAmount/orders.total_amount=result.totalAmount、正額のappliedだけreserved。同Session再送は増やさない。**割引0のH注文も全通常行の数量ぶんのunit_amountsを必ず持つ**（単価のまま、redemption/allocationsは0件）、旧注文はunit記録の無い物だけ。受付前の照合はdraft.total_amount（割引前）+draft.discount_amount（0）=Stripe.amount_total+Stripe.amount_discount。受付完了時だけ今の処理と同じくdraft.discount_amountへStripe割引を書き戻し、draft.total_amountは割引前のまま、再送は既存注文を先に返す。resultの各額もStripeと完全一致させる。
- Produces: `private/public.place_reconciled_order_from_checkout_draft(_draft_id uuid,_checkout_session_id text,_cart_session_id text,_stripe_amount_total integer,_stripe_amount_discount integer,_stripe_currency text,_checkout_session_created_at timestamptz,_payment_intent_id text,_stripe_payment_state text) RETURNS TABLE(order_id uuid,order_status public.order_status,created boolean,rejection text)`。stateはpaid/awaiting_paymentのみ。**place_and_mark_paidとplace_and_mark_awaitingの両方**がStripeの取得済み状態/確定した額を確認してこの入口へ進む。通常routeから呼ばず、金額/通貨/所有者/固定snapshotの安全確認は保ち、現在の割引の回数/１人１回/期間/stop/割当/初回/着数では拒否しない。awaitingは超過してもreservedを作って既存mark_order_awaiting_paymentへ、paidはコピー/予約又は回復→mark_order_paidでconfirmedへ進める。
- Produces: `private.mark_order_paid(_order_id uuid,_expected_status public.order_status,_payment_intent_id text,_paid_amount integer,_paid_currency text,_notify_customer boolean,_paid_email_variant text,_source_event_id text DEFAULT NULL) RETURNS TABLE(updated boolean,amount_matches boolean,needs_review boolean)`の同一取引にsettle(true)、`private.release_stock_for_unpaid_order(_order_id uuid,_expected_status public.order_status,_next_status public.order_status,_change_reason text,_actor_id uuid DEFAULT NULL,_source_event_id text DEFAULT NULL,_cancel_reason text DEFAULT NULL,_cancel_note text DEFAULT NULL,_notify_customer boolean DEFAULT NULL) RETURNS TABLE(released boolean,order_id uuid,status public.order_status)`に未入金終了時だけsettle(false)。`mark_order_awaiting_payment`はreservedを維持。`private.record_cancelled_order_paid_amount(_order_id uuid,_payment_intent_id text,_received_amount integer) RETURNS boolean`の現在の経路でもsettle(true)を通す。各public入口のsignatureは保持。confirmedはcancel/refund/returnで触らず、cancelled→confirmedは実入金に限る。reconcilerはpaid判定前にこの入口を使わない。
- Produces: `ReconcilerDatabase.placeOrder`を`placeReconciledOrder(args:{draftId:string;checkoutSessionId:string;cartSessionId:string;amountTotal:number;amountDiscount:number;currency:string;sessionCreatedAt:Date;paymentIntentId:string|null;paymentState:'paid'|'awaiting_payment'}):Promise<PlaceOrderResult>`へ替え、requireOrderから両fallbackを同じSQL入口へ送る。通常place-orderのdiscount_*業務拒否を照合のorder_not_creatableへ変換しない。照合入口からdiscount_*が返ったら契約違反として固定コード`discount_reconciliation_contract_violation`の一時エラーでqueueを再試行し、その場では通知例外を作らず修正対象にする。再試行は既存queueの`private.stripe_webhook_max_attempts()=9`（20261007030242:36-43）と既存backoffに従い、９回でprocessing_status=dead/dead_atを付け既存dead-letterの運用警告へ送る。無限再試行/成功扱いはしない。reconciler内のMAX_RECONCILE_ATTEMPTS=3とqueue９回は別の上限である。予約なし/取消後/条件を越えたawaitingの入金はconfirmedへ回復し、上限/１人１回/単発code超過ならattention_kind=discount_limit_exceededを１件だけ付ける。使用の現在条件だけで出荷を止めず、金額違い等の既存の要確認は保つ。
- Produces: fallbackで作るredemptionは`reconciliation_fallback=true`。awaitingはreservedのまま保持し、入金確定時にattentionを付ける。paid/取消後回復は同じ確定処理でattentionを付け、上限超過が無ければ`discount_reconciliation_recovered`にして超過と偽らない。再送はstateとkindを重複させず、未入金終了のcancelledには新しい注意を出さない。
- Produces: `private.link_guest_orders(_user_id uuid,_email text) RETURNS TABLE(id uuid,shipping_full_name text,shipping_postal_code text,shipping_prefecture text,shipping_city text,shipping_address text,shipping_building text,created_at timestamptz)`はsignatureを保ち、G共通→guestメール/memberの本人キーを辞書順→割引id→既存orderの順で結び付け、redemptions.user_id/identity_keyを同取引で会員へ関連付ける。コード使用回数を加減しない。D16ですでに２回確定していても消したりunique違反にしない。guestとmemberの１人１回の再確認は結付けを含む同じロック規則にする。
- Produces: `DiscountAttentionKind='discount_limit_exceeded'|'discount_reconciliation_recovered'`をorder-payment-types.tsへ定義。`private/public.list_admin_discount_attention(_limit integer,_actor_id uuid) RETURNS jsonb`（STABLE/orders.read）は`{rows:{orderId:string,kind:DiscountAttentionKind,openedAt:string}[],truncated:boolean}`、最新順/limit1〜100。`private/public.admin_resolve_discount_attention(_order_id uuid,_actor_id uuid) RETURNS jsonb`（orders.manage）→`{resolved:boolean}`。`POST /api/admin/order-attention/discounts/[orderId]/resolve`は共通順/IP・actor30/600秒/body空object、200 `{data:{resolved}}`、監査はorderIdと結果だけ。確認済みはC20案であることを仕様16章へ記録する。
- Produces: `GET /api/admin/order-attention`とG-4詳細attentionへdiscountsを追加、`/admin/orders#attention`に上記２kindの正確なlabelと注文リンク/C20案の「確認済みにする」。一覧/詳細/hookは同じ辞書、no-storeの非ok本文を閉じる。解決しても金額/使用履歴を変えず出荷を止めない。
- Produces: H4 assert DETAIL `h4_acceptance`・`h4_member_lock`・`h4_redemption_lifecycle`・`h4_reconciled_recovery`・`h4_attention`・`h4_writer_allowlist`・`h4_public_acl`。Gの既存writerのOIDを保ち、新しい照合用public/private受付だけを実際のG保護trigger規則と照合して許可一覧へ追加する。両fallbackともdiscount条件で拒否しないこととstateの２値を検査する。redemptionのみのhelperはGの一覧へ混ぜず、最終OID集合と差分名を検査する。

- [ ] **Step 1: 失敗するDB試験を書く。** `FREQ-549-AC-01: 入力codeの上限・期間・停止・初回・前回着数が変わったdraftだけ入力へ戻す`（各code rejection、starts/endsちょうど、割当解除、automaticだけはautomatic_changedで注文0）、`FREQ-549-AC-02: 受付は行別割引と１着の額と使用予約を同じ取引で写し再送で増やさない`（37000/3000/20000+17000、対象外0、FK/総和、１箇所の失敗で全rollback）、`FREQ-549-AC-03: pendingは予約を保ち未入金放棄は取消しpaid後の返品は確定のまま`（paid→expireの順違いも確認）。
- [ ] **Step 2: 入金と並行のREDを書く。** `FREQ-549-AC-04: 受付を通らない入金待ちは割引条件が変わっても注文を作り予約する`（stop/期間/上限/初回/着数/割当変更後のplace_and_mark_awaiting、pendingメール１回・order_not_creatableなし、未入金終了で取消、入金でconfirmedと超過attention）、`FREQ-549-AC-04: paidとawaitingの照合fallbackはdiscount拒否へ進まず実額と固定結果で受け付ける`（両state、誤って返ったdiscount_*は一時契約エラー/queue再試行、未知額は従来拒否）、`FREQ-549-AC-04: 予約なしと取消後の入金は超過でも確定し要対応だけを１件出す`、`FREQ-549-AC-05: 同一人の２draftは別コードでも初回を２回予約できず結付けとも競合しない`（member/正規化guest/guest→member、入力codeは１成功/１拒否、automaticの後続は新しい最終確認へ）。`pg_blocking_pids`はG共通鍵の待ちを観測し、本人鍵で待つとの主張をしない。
- [ ] **Step 3（controller）: REDを測る。** `npx.cmd jest tests/integration/db/group_h_acceptance.integration.test.ts tests/integration/db/group_h_redemptions.integration.test.ts tests/integration/db/group_h_acceptance_concurrency.integration.test.ts --runInBand`。単体へ`FREQ-549-AC-01: 通常place-orderの割引拒否はconfirmを呼ばず入力へ戻す`、`FREQ-549-AC-04: reconcilerは取得したpaidとawaitingの両fallbackを割引再確認で拒否しない入口へ送る`、`FREQ-549-AC-04: fallbackを確定した時だけ２kindの要対応を１欄へ出す`を追加してREDを測る。
- Test: `FREQ-549-AC-01: 自動割引だけの条件変更は入力へ戻さず新しい最終確認を表示し支払いを待つ`（stop/期限/初回/prior/回数、200/reconfirmationRequired、古いSession失効/新requestVersion/新固定額、confirm0回→再押下で１回、paid競合は非拒否fallback）。`FREQ-549-AC-05: guest初回は有料注文だけを数え放棄した初回をやり直せる`（paid又は入金後cancelledありは不可、payment_in_progress/awaiting/expired/abandoned/未入金cancelledだけは可、自order除外、memberと同じ、reserved競合はhasFirstOrderReservationで区別、２つ目のautomaticはconfirmでも外れて再確認ループ0）。`FREQ-549-AC-04: 照合の契約違反はqueue９回でdeadへ移り運用警告へ残る`（１〜８は既存processing_status=failed/next_attempt_at、９でdead/dead_at、既存claim/dead-letter/通知抑止規則維持）。
- [ ] **Step 4: InterfacesのH4とTS接続を実装する。** 既存金額/在庫/FIFO/cart削除/outboxの順とtransactionを保ち、TSから予約確定RPCを別取引で呼ぶ形にしない。要対応の新kindは配送/支払reviewの阻害条件から独立させる。
- [ ] **Step 5（controller）: GREENを測る。** 共通verify＋Step3＋既存group_g1_checkout/checkout_order_owner_binding/place_order_from_checkout_draft/reconciler_composed/reconciler_postgrest/G-4 reads。並行３連続、照合入口のservice専用/paidとawaitingのstate制限/通常routeから未使用を検査。鍵/state/許可一覧/ACLの改ざんを固定DETAILで拒否し、routeの認可/CSRF/制限とattention２kindのUI/解決単体も通す。
- [ ] **Step 6（controller）: Filesだけコミットする。** `feat(discounts): 注文受付の予約と入金確定と上限超過の要対応を実装する`

### Task 8: checkout・カートの内訳と商品の案内

controllerは最初に別セッションへ`src/app/api/checkout/**`・`src/features/checkout/**`を含む利用箇所の変更開始と対象を通知し、共有差分を確認する。

**Files:**
- Create: `src/components/DiscountBreakdown.tsx`、`src/lib/discounts/discount-preview-store.ts`、`src/app/api/discounts/advertisements/route.ts`、`tests/unit/components/DiscountBreakdown.test.tsx`、`tests/unit/lib/discounts/discount-preview-store.test.ts`、`tests/unit/api/discount-advertisements-route.test.ts`
- Modify: `src/app/checkout/page.tsx:250-320,804-880,1687-1740`、`src/app/checkout/_components/PromoCodeField.tsx:9-90`、`src/app/checkout/_components/FinalConfirmationStep.tsx:182-397`、`src/app/checkout/_lib/checkout-api.ts:140-148,280-320`、`src/app/checkout/_lib/promotion-memory.ts:3-70`、`src/app/cart/page.tsx`、`src/app/cart/_components/OrderSummary.tsx:33-90`、`src/features/cart/services/cart-view.ts:24-102`、`src/features/cart/types/cart-json.ts:21-40`、`src/app/api/cart/route.ts`、`src/app/api/cart/add/route.ts:67`、`src/app/api/cart/change/route.ts:71`、`src/app/item/[id]/ItemDetailClient.tsx`（案内の１行だけ）
- Read: `src/features/cart/client/cart-api.ts`（既存cart更新の契約を保つ。探索busy用の応答や再送分岐を追加しない）。
- Modify: `tests/unit/components/PromoCodeField.test.tsx`、`tests/unit/components/CheckoutPage.test.tsx:748`、`tests/unit/components/FinalConfirmationStep.test.tsx`、`tests/unit/app/checkout/checkout-api.test.ts`、`tests/unit/app/checkout/promotion-memory.test.ts`、`tests/unit/features/cart/services/cart-view.test.ts`、`tests/unit/components/CartPage.test.tsx`、`tests/unit/components/ItemDetailAddToCart.test.tsx`、`tests/unit/docs/order-status-traceability.test.ts`、`tests/unit/docs/delivery-status-traceability.test.ts`
- Modify: `docs/02_Requirements/requirements.md`（550/372/373/374/419/423）、`docs/04_DetailDesign/pages/12_cart.md`、`docs/04_DetailDesign/pages/13_checkout.md`、`docs/04_DetailDesign/pages/05_item_detail.md`、`docs/03_BasicDesign/api/api-spec.md`、`docs/03_BasicDesign/api/route-inventory.md`、`docs/05_Quality/tests/test-spec.md`
- Test: 上記新規３本/既存画面・service８本とdocs２本。cartの既存API応答全体を固定する試験は新しい割引欄だけ追従する。

**Interfaces:**
- Consumes: Task 6の`POST /api/checkout/promotion-code {codes,guestEmail?}`と`DiscountResult`、Task 2の`BETTER_DISCOUNT_MESSAGE`、Task 7の409/returnTo、既存useCheckoutのStripe総額。カートは自動割引だけ、checkoutで入力したコードを勝手にcartへ送らない。
- Produces: `DiscountBreakdown(props:{effects:readonly Pick<DiscountEffect,'name'|'code'|'amount'>[];showCodes:boolean;provisional?:boolean}):React.JSX.Element|null`。正額だけ１効果１行、「割引（{name}） −¥{amount}」、codeはshowCodes=trueかつ本人入力済みだけ。provisionalは「見込み」。同じ部品を入力/最終/カート、Task 10の顧客/管理表示へ使う（メールは同じデータの文字列描画）。
- Produces: `PromoCodeField(props:{codes:readonly string[];onApply:(code:string)=>Promise<void>;onRemove:(code:string)=>Promise<void>;error:string|null;busy:boolean;unusedCodes:readonly string[];buyerKind:'member'|'guest'}):React.JSX.Element`。入力名「プロモーションコード」、placeholder「コードを入力」、「適用」、各codeの`{code}を削除`（表示「削除」）。５件で「コードは5つまで入力できます。」。guestの全拒否は裁定の同じ文と、accessible name「ログインして割引を確かめる」・href=`/login?next=%2Fcheckout`のリンク（code/emailはURLへ入れない）。member限定は汎用文、member publicは従来文。削除はserver再計算、別codeの失敗で有効なcodeを消さない。
- Produces: `applyPromotionCodes(codes:readonly string[],guestEmail?:string):Promise<PromotionCodesResponse>`、`PromotionCodesResponse={ok:true;result:DiscountResult}|{ok:false;status:number;refusals:readonly DiscountRefusal[];message:string;definitive:boolean}`をcheckout-apiへ。422又はconfirm/place-orderのcode用409で検証済みrefusalsがある時だけdefinitive=true、401/403/429/500/503/通信失敗/壊れたJSONはfalse。非okも一度本文を読んで分類し、不正bodyはcancelして閉じる。
- Produces: promotion-memoryは`checkout:promotion-codes`へ`{version:1,codes:string[]}`だけをsessionStorage保存し、金額/資格/email/名前は保存しない。旧`checkout:promotion-code {code}`は初回読取時に配列へ取り込んで旧キーを削除。関数`readPromotionCodes():string[]`・`writePromotionCodes(codes:readonly string[]):void`・`clearPromotionCodes():void`。再入場は全codeを再検証し、確定無効だけ保存から除き入力欄にcodeと理由を残す。429/503や一時障害では保存を維持する。
- Produces: final confirmationは固定resultの内訳とStripeの総額/割引を一致させ、code変更不可。入力codeの409/returnTo=inputはconfirmを呼ばず、definitive=trueのrefusalsを保持して該当codeを確定無効へ移す。入力previewで同じcodeを見込みへ戻さず、本人の削除/再入力だけで解除する。住所/選択は保つ。automatic変更の200/reconfirmationRequiredは`PlaceOrderOutcome`へ`{kind:'reconfirmation_required'}`を追加し、入力へ戻さず新requestVersionのcreate-session→新しい最終確認へ進む。新合計を表示し再押下までconfirm0回。入力画面を開いただけではSessionを作らない。
- Produces: `previewAutomaticDiscounts(client:SupabaseClient,buyer:DiscountBuyer,lines:readonly DiscountLine[],at:string):Promise<DiscountResult>`はphase=preview/codes=[]。guestメールを破棄して初回/１人１回は見込み。`buildCartJson(supabase:SupabaseClient,cartId:string|null,buyer:DiscountBuyer):Promise<CartJson>`へ本人を追加し全呼出元へ伝える。CartJsonへdiscounts/total_discount/discount_provisionalを追加、元subtotal/単価/line_priceを保ちtotal_priceは正味額、EMPTY=[]/0/false。guardでもfallbackの完全に評価した額を200で表示し、Task6のrecordDiscountSearchFallbackで管理要対応と固定logを残す。cart add/changeを計算guardで失敗応答にせず、商品追加を再送しない。
- Produces: `listDiscountAdvertisements(client:SupabaseClient,buyer:DiscountBuyer,itemId:number,at:string):Promise<{discountId:string;text:string}[]>`。Task 3のcontextからactive・automatic・advertise=true・対象itemだけを選び、Aを含む会員用の物はguestへ出さない。初回/１人１回は会員専用という意味にはせず、その割引がguestに適用できる設定かで判定する。`GET /api/discounts/advertisements?itemId=<正整数>`は検証済みmemberまたはguestを解決し、200 `{rows:{discountId,text}[]}`、no-store（member結果を共有cacheに載せない）、IP60/600秒、itemId不正400/非公開商品404。code/usage/割当情報を返さない。価格/取り消し線を変更せず１行の管理文だけを描画し、Reactのtextとしてescapeする。
- Produces: public商品頁が静的cacheを使う場合でも広告はこの個人化したno-store APIから取り、guestのSSRへmember向け案内を埋めない。`advertisingText`は管理で書いた短文、HTMLなし。広告をOFFにしてもcart/checkoutの割引を隠さない。

- [ ] **Step 1: 失敗するRTL/単体を書く。** `FREQ-550-AC-01: ５コードを削除と内訳と未採用文で操作でき最終画面では変更できない`、`FREQ-550-AC-02: ゲストの全拒否は同じ文とログインへのリンクを出しmemberの公開codeだけ詳細理由を保つ`（exact guest全文/href/name、code/emailをURLに含めない、常設alert/aria-invalid/describedby/focus）、`FREQ-550-AC-02: 再入場はcodeだけ再検証し確定無効だけを除き429と503では保存を保つ`（旧キー移行/２回検証/body読了又はcancel/壊れたJSON/入力code409だけconfirm未呼出しで入力へ、確定拒否をpreviewで復活させない）。`FREQ-548-AC-02: 戻ってきたguestは自動の初回割引が外れた新総額で確認と支払いへ進みループしない`（previewは見込み、confirm200、finalは確定額、place時変化も新final、codeなし409/input0）、`FREQ-546-AC-04: cartのguardでも追加１回でfallback額を200表示し管理要対応へ残す`（calculationMode=fallback、追加再送0、単独/全互換案の最善、表示とAPI合計一致、固定log/注意record１回）。
- [ ] **Step 2: カートと広告のREDを書く。** `FREQ-550-AC-01: 広告OFFでもカートには自動割引の名前と額と合計が出る`（subtotalは元値/totalは正味/空cart）、`FREQ-550-AC-03: 広告は自動ONの１行だけでguestにはAを含む会員条件を出さない`（OFF/code/stopped/期間外/非対象/非公開で空、memberとguestのcache非共有、案内にHTMLが入っても実行しない、値段は同じ）。`npx.cmd jest tests/unit/components/DiscountBreakdown.test.tsx tests/unit/components/PromoCodeField.test.tsx tests/unit/components/CheckoutPage.test.tsx tests/unit/app/checkout tests/unit/lib/discounts/discount-preview-store.test.ts tests/unit/api/discount-advertisements-route.test.ts --runInBand`でREDを測る。
- [ ] **Step 3: Interfacesどおり画面/API/cartの呼出元を実装する。** 未採用と無効codeを区別し、guestメール変更はpreviewの履歴照合を起こさず見込みを保つ。confirmだけがその時の配送先メールで実確認し、provisional=trueを固定しない。guestの無効codeは全理由同じ文とリンク、構造不正のJSONとは区別する。
- [ ] **Step 4: GREENを測る。** Step 2にFinalConfirmationStep/cart-view/CartPage/ItemDetailAddToCartを加え、型/lint/docs検証。３幅の表/折返し/focus/実fetchの完了はTask 11で測る。
- [ ] **Step 5（controller）: Filesだけコミットする。** `feat(discounts): 複数コードの操作とカートの内訳と商品の案内を追加する`

### Task 9: 安い着からの返金・返品・G-4の金額

**Files:**
- Create: `supabase/migrations/<ts5>_group_h_discounts_refunds.sql`、`tests/integration/db/group_h_refunds.integration.test.ts`、`tests/integration/db/group_h_refund_concurrency.integration.test.ts`、`tests/integration/db/group_h_order_amounts.integration.test.ts`
- Modify: `src/lib/orders/refund/refund-allocation.ts:19-42`、`src/lib/orders/refund/refund-materials.ts:94`、`src/lib/orders/refund/refund-types.ts`、`src/lib/orders/refund/refund-store.ts`、`tests/unit/lib/orders/refund/refund-allocation.test.ts`、`tests/unit/lib/orders/refund/refund-materials.test.ts`、`tests/integration/db/group_h_migration_asserts.integration.test.ts`、`tests/integration/db/order_refund_records.integration.test.ts`、`tests/integration/db/order_return_receipts.integration.test.ts`、`tests/integration/db/group_g4_reads.integration.test.ts`
- Modify: `docs/02_Requirements/requirements.md`（551/448/465/537）、`docs/03_BasicDesign/data/er.md`、`docs/04_DetailDesign/sequence/order-administration.md`、`docs/06_Operations/db-migrations.md`、`docs/05_Quality/tests/test-spec.md`
- Test: 上記３新DB＋assert、既存DB３本、単体２本。
- Modify: `tests/integration/db/order_refund_results.integration.test.ts`、`tests/integration/db/order_return_request_reviews.integration.test.ts`、`tests/unit/lib/orders/refund/refund-store.test.ts`、`tests/unit/lib/orders/returns/return-store.test.ts`、`tests/unit/components/OrderReturnReviewDialog.test.tsx`、`tests/unit/components/OrderReturnReceiveDialog.test.tsx`、`tests/unit/components/OrderReturnRefundDialog.test.tsx`、`tests/unit/lib/orders/email/order-email-compose.test.ts`（上の均等式読者と外部返金のH/旧回帰）。
- Test: Task9のRED/GREENコマンドへ`order_refund_results`・`order_return_request_reviews`と上記単体も加える。
- Read: 現行本体は`supabase/migrations/20261023211425_group_g1_allocation.sql:3746-4140`（refund core）・`:7192-7450`（返品/交換）、`20261026054705_group_g4_orders_reads.sql:128-205`（行金額）。適用済みSQLは編集しない。
- Read: `supabase/migrations/20261023211425_group_g1_allocation.sql:4963-5135`（record_external_order_refund）・`:4662-4863`（record_group_g_refund_result）、`supabase/migrations/20261020150415_order_return_request_reviews.sql:161-320`（return_detail_json）。ModifyするSQLは新しいH5だけ。

**Interfaces:**
- Consumes: Hの保存`order_line_unit_amounts`とallocations、既存refund/return関数の許可/数量/手数料/在庫/交換契約。過去着数から引くのは成功した返金数量だけ（C5）、一方で返金の二重受付を防ぐ予約はawaiting_response/pendingも数える（既存契約）。この二つを同じ件数にしない。
- Produces: `private.return_units_amount(_order_item_id uuid,_quantity integer,_offset integer DEFAULT 0) RETURNS integer`を同signatureで置換。H通常行は利用可能単位をpaid_amount ASC,unit_index ASCで取りoffset後quantity件の和、旧は既存return_refund_amountの式、交換はexchange_paid_amountの旧式。不足/過大は共通表のGROUP_H_REFUND_UNIT_MISMATCH/23514→500、0数量は0。Hはunit_amountsの存在で判定し、割引0のH行もこの道を通す。
- Produces: 返金失敗と同時返金でも同じ着を二度返さないため、H5で**新表unit_amountsだけ**に`refund_id uuid null FK public.order_refunds`・`refund_before_shipment boolean null`・`return_line_id uuid null FK public.order_return_lines`を追加。金額/id/order/unitのimmutableは維持し、これらの紐付け列だけを許可されたprivate writerが同じG鍵下で変更できるguardへ替える。表の直接DMLは引き続き拒否する。
- Produces: `private.group_h_claim_refund_units(_refund_id uuid,_order_item_id uuid,_quantity integer,_before_shipment boolean,_return_line_id uuid DEFAULT NULL) RETURNS integer`、`private.group_h_release_refund_units(_refund_id uuid) RETURNS void`。freeの最安単位、または当該return_lineに既に紐付く単位から選び、同一refundの再送は同単位を返す。awaiting_response/pending/succeededのclaimは占有、error/failedは解放。安いrefundが失敗した後に高いrefundが成功済みでも、再試行は空いた安い単位を選び二重返金しない。単なる`refundedUnits`だけのoffsetでHを管理しない。
- Produces: `private.group_h_claim_return_units(_return_line_id uuid,_order_item_id uuid,_quantity integer) RETURNS integer`。返品の承認/交換元額を固定する既存取引で未使用の最安単位へreturn_line_idを付ける。取消/却下で未完のclaimを解放、受取/交換/成功返金後は保持。返金の同じreturn_lineは同単位を使い、ほかの返金と重ねない。交換へ引継ぐ元の支払額もこの和で固定し、交換品行自体を新しい割引の対象にしない。
- Produces: refund coreのH分岐はquantityを検証してclaimの和を`order_refund_lines.amount`へ保存。返品のfee deduction/shipping/adjustmentは既存の式のまま別枠。返金結果の成功/失敗を反映する既存private本体へclaim保持/解放を同取引で足す。一般返金で１つの明細の発送前/後を同時に選ぶ場合は発送前を先に最安から取る。自動取消/返品/キャンセル申請から来る全既存入口が同じcore/return helperを通ることを列挙して試験する。
- Produces: **外部返金も同じclaimへ通す。** `private.record_external_order_refund(_order_id uuid,_stripe_refund_id text,_amount integer,_stripe_status text,_stripe_pending_reason text,_stripe_failure_reason text,_customer_action_expires_at timestamptz,_payment_method_type text,_reference_number text,_reference_type text,_stripe_reason text,_stripe_created_at timestamptz) RETURNS TABLE(refund_id uuid,created boolean,source text,status text,newly_accepted boolean,newly_failed boolean,order_status public.order_status,refunded_amount integer,rereserve_shortage integer,email_enqueued boolean,exception_id uuid)`をH5で同signatureのCREATE OR REPLACE。通常の未発送数量へ割り当てる既存条件は保ち、Hは均等式を呼ばず最安free単位の和でv_linesを作る。refund親INSERT後、同じG鍵/取引内で`group_h_claim_refund_units`を通し、読んだ額/claim和/保存line.amountが一致してから返金行をINSERT。重複Stripe refund IDは同claimを再利用し、pending/succeededは保持、失敗は共通結果関数で解放。数量が特定されない外部部分返金は今のadjustment処理を保ち、勝手に着を返した扱いにしない。
- Produces: **返品の詳細も同じ単位額を読む。** `private.return_detail_json(_return_id uuid) RETURNS jsonb`（既存STABLE/ACLを保つ）のH分岐で`refund_amounts_by_count`と`refund_waiting_amount`を旧return_refund_amountから切り替える。新内部STABLE helper `private.group_h_return_amounts(_return_id uuid) RETURNS TABLE(return_line_id uuid,refund_amounts_by_count integer[],refund_waiting_amount integer)`は当該返品のclaim＋未処理のfree単位を安い順に読み、他返品/返金のactive claimを除外する。同じorder_itemの各返品行は既存と同じ共通のitem_unprocessed配列を使い、待ち額はその行のclaimの和（未claim分だけ既存earlier_waiting順で仮配分）。readでclaimを書かない。旧行と交換は従来式。返品review/receive/refundの画面とorder-email-composeの待ち額はこのJSONをそのまま使い、TSで均等式を再計算しない。
- Produces: **均等式の全読者の棚卸し（2026-10-29のsource検索）:** 現行SQLは`return_units_amount`（20261013001143:62）、`begin_order_refund_core`（G1:3746/4078）、`load_order_refund_materials`（G1:2671/2748）、`record_external_order_refund`（G1:4963/5064）、`return_detail_json`（20261020150415:161/250/259）、G-4の`group_g_order_item_rows`/`get_admin_order_detail`（20261026054705:128/306）。TSの式はrefund-allocation.tsのunitsDiscount/refundLineAmountのみ、return-store.ts:742-743とorder-email-compose.ts:737は配列/待ち額の読者。この全経路をH5/Task10の試験で覆う。`refund_units_discount(integer,integer,integer)`と`return_refund_amount(text,integer,integer,integer,integer,integer,integer)`自体は旧/交換用に残し、注文idを持つH呼出元だけで分岐する。古い適用済みmigration本文は変更しない。
- Produces: `RefundMaterialLine.availableUnitAmounts:readonly number[]|null`（Hは他active claimを除いた額の昇順、当該returnのclaimは含め、旧はnull）。`public.load_order_refund_materials(_order_id uuid) RETURNS TABLE(order_id uuid,order_status public.order_status,total_amount integer,shipping_amount integer,discount_amount integer,paid_amount integer,succeeded_amount integer,open_amount integer,refundable_amount integer,refunded_shipping integer,refundable_shipping integer,shipped_total integer,unshipped_total integer,awaiting_refund_id uuid,awaiting_refund_amount integer,awaiting_refund_created_at timestamptz,lines jsonb)`は**既存public１本のSECURITY DEFINER/STABLE/ACLと戻り列を保ったCREATE OR REPLACE**でlinesだけ拡張し、private/publicへ組み替えない。`refundLineAmount(line:Pick<RefundMaterialLine,'itemPrice'|'quantity'|'lineDiscount'|'refundedUnits'|'exchangePaidAmount'|'availableUnitAmounts'>,units:number):number`はHの先頭額の和、旧/交換は旧式。DBがclaimを再確認し見込みを信じない。
- Produces: `private.group_h_order_unit_status_amounts(_order_id uuid) RETURNS TABLE(order_item_id uuid,status text,line_amount integer)`。G-1の状態数量区間と同じ数量になるようH単位を対応させる。成功した発送前refundのclaimをcancelled、成功返品のclaimをreturned、active refund/returnのclaimを対応するrefund_waiting/return系へ先に割り当てる。残る単位はpaid_amount DESC,unit_index ASCを残る状態のstatus_rank/区間順へ数量ぶん置く。同一単位を二度置かず、対応できない数量ならMISMATCHで止める。G-4の`private.group_g_order_item_rows(_order_ids uuid[]) RETURNS TABLE(order_id uuid,order_item_id uuid,status text,status_rank integer,quantity integer,blocked_reasons text[],is_exchange boolean,unit_price integer,line_amount integer,refund_amount integer,first_unit integer)`はHのline_amountをこの和へ替え、旧は今の区間floorのまま。成功した商品refundを各明細へ全額付ける既存規則とshipping/adjustment分離は保つ。
- Produces: 対応付けは表示用で、Gの状態数量/在庫割当を動かさない。partial金額返金が数量を変えない既存ケースもrefund_amountは既存の成功amountを足し、unitの支払額を変更しない。全状態line_amount和=通常行line_total−保存割引、全行refund_amount和=成功商品refund、shipping/adjustmentは行へ混ぜない。H5 assert DETAIL `h5_unit_claims`・`h5_refund_amounts`・`h5_return_amounts`・`h5_legacy_fallback`・`h5_status_amounts`・`h5_public_acl`。

- [ ] **Step 1: 失敗する単体/DBを書く。** `FREQ-551-AC-01: 20000円の２着で２着目3000円引きなら１着目の返金は17000円で次は20000円`（見込み/DB/core/返品/発送前取消が同値、37000で全額一致）、`FREQ-551-AC-02: unit記録の無い旧注文は均等式を保ち交換は元の支払額を使う`（旧SQL/TSの全fixtureを不変、H無料単位0円も返金数量は消費、G quantity境界）、`FREQ-551-AC-03: セットの片方を返しても残る服を再計算せず成功した着数だけ次回のAから引く`（pending/errorではprior不変、succeededで減る、使用回数confirmed不変）。
- [ ] **Step 2: 並行と金額表示のREDを書く。** `FREQ-551-AC-02: 安い返金が失敗し高い返金が成功しても安い単位を一度だけ再試行できる`（同時２件、17000/20000が各１claim、errorで17000が解放、再試行後和37000、過剰数量拒否、同requestKey同単位）、`FREQ-551-AC-04: G-4の返品済み17000円と残った20000円の和は37000円で他行へ返金が混ざらない`（複数状態/離れた区間/交換/送料/負のadjustment、旧３点100円は33/33/34、返金対象状態0の既存fallback維持）。
- [ ] **Step 2b: 外部返金と返品の表示のREDを書く。** `FREQ-551-AC-02: Stripeの管理画面からの返金も安い着から取り同じ着を二度返さない`（17000の通常返金後に外部20000で残る１着だけclaim、external再送不増、pending→failedで解放、quantityを持たない部分額はadjustmentのまま）、`FREQ-551-AC-01: 返品詳細の数量別見込みと入金待ち額と画面とメールは17000円からになる`（refund_amounts_by_count=[17000,37000]、１着待ち17000、残り１着の見込み20000、同じorder_itemの複数return行/他返品claim/旧18500を検査）、`FREQ-551-AC-02: Hの全ての金額読取は単位額を使い旧均等helperをH行へ呼ばない`（上の全経路をtable-driven fixtureで実行、外部の共通結果関数の失敗解放も検査）。
- [ ] **Step 3（controller）: REDを測る。** `npx.cmd jest tests/unit/lib/orders/refund/refund-allocation.test.ts tests/unit/lib/orders/refund/refund-materials.test.ts --runInBand`、`npx.cmd jest tests/integration/db/group_h_refunds.integration.test.ts tests/integration/db/group_h_refund_concurrency.integration.test.ts tests/integration/db/group_h_order_amounts.integration.test.ts --runInBand`。17000でなく18500になる旧動作をREDとして確認する。
- [ ] **Step 4: InterfacesのH5とTS材料/見込みを実装する。** paid_amountを変更して返金額へ合わせず、claimで使用した単位を残す。戻った服に当てた割引は他の服へ移さない。
- [ ] **Step 5（controller）: 共通verifyでGREENを測る。** Step 3と既存refund/return/G-4 suite、H1〜H5 assert、並行３連続。旧分岐を消す/金額列mutable/claim重複可能/G-4総和不一致の改ざんを固定P0001/DETAILで拒否する。SQLとTSは同じunit配列で見込みと保存額を比較する。
- [ ] **Step 6（controller）: Filesだけコミットする。** `feat(refunds): H注文を安い単位から返し状態別金額の総和を保つ`

### Task 10: 確認メール・会員/注文状況・管理詳細の内訳

**Files:**
- Create: `supabase/migrations/<ts6>_group_h_discounts_views.sql`、`src/lib/discounts/order-discount-store.ts`、`tests/unit/lib/discounts/order-discount-store.test.ts`、`tests/integration/db/group_h_order_views.integration.test.ts`
- Modify: `src/lib/discounts/discount-types.ts`、`src/lib/orders/email/order-email-compose.ts:56,972-1050,1264-1310`、`src/lib/orders/email/order-email-types.ts`、`src/lib/orders/customer-order-view.ts:112-130`、`src/lib/orders/status/status-store.ts:360`、`src/lib/orders/status/status-types.ts`、`src/lib/orders/status/status-messages.ts:59`、`src/app/api/orders/[id]/route.ts:42-110`、`src/app/account/orders/[id]/page.tsx:589-620`、`src/features/order-status/components/OrderStatusPublic.tsx:98-130`、`src/lib/orders/admin-orders/admin-order-types.ts`、`src/lib/orders/admin-orders/admin-order-store.ts:53-68`、`src/components/AdminOrderDetailSection.tsx:227-260`
- Modify: `tests/unit/lib/orders/email/order-email-compose.test.ts:148`、`tests/unit/lib/orders/customer-order-view.test.ts:266`、`tests/unit/components/AccountOrderDetailPage.test.tsx`、`tests/unit/features/order-status/OrderStatusPublic.test.tsx:33`、`tests/unit/lib/orders/admin-orders/admin-order-store.test.ts`、`tests/unit/components/AdminOrderDetailSection.test.tsx`、`tests/integration/db/group_h_migration_asserts.integration.test.ts`
- Modify: `docs/02_Requirements/requirements.md`（552/78/396）、`docs/03_BasicDesign/api/api-spec.md`、`docs/04_DetailDesign/pages/16_admin.md`、`docs/05_Quality/tests/test-spec.md`、`docs/06_Operations/db-migrations.md`
- Test: 上記７単体＋views/assert DB。実メール送信はTask 12、composeの文字列試験と分ける。

**Interfaces:**
- Consumes: 受付で固定した`name_snapshot/code_snapshot/amount/class_snapshot`とallocations、Task 8の`DiscountBreakdown`。現在のdiscounts.nameや現在の計算結果を注文表示へ使わない。
- Produces: `OrderDiscountBreakdown={name:string;amount:number}`、`AdminOrderDiscountBreakdown=OrderDiscountBreakdown & {discountId:string|null;code:string|null;lineAllocations:{orderItemId:string;amount:number}[]}`をdiscount-types.tsへ追加。discountId=nullは旧注文だけ。顧客型はname/amountだけでcodeId/割当/使用/個人情報を持たない。
- Produces: `private.order_discount_breakdown(_order_id uuid) RETURNS jsonb`（内部のみ、STABLE）→`{rows:AdminOrderDiscountBreakdown[],legacy:boolean}`、順はproduct→order/id。正額だけ、sum(amount)=orders.discount_amount、旧は`{rows:[{name:'discount',amount:<旧割引>,discountId:null,code:null,lineAllocations:[]}],legacy:true}`（DBはASCIIのname sentinel、TSで「割引」に変換、旧0円はrows=[]）。旧だけのnullable discountIdは`AdminOrderDiscountBreakdown.discountId:string|null`とする。
- Produces: `private/public.get_order_discount_breakdown(_order_id uuid) RETURNS jsonb`はservice専用、`getOrderDiscountBreakdown(client:SupabaseClient,orderId:string):Promise<{rows:AdminOrderDiscountBreakdown[];legacy:boolean}>`はserver-onlyで返り値をzod検査。member routeは既存の所有確認の後だけこのstoreを呼び、公開注文状況は既存token/sessionで認可されたmaterialを通して**名前と額だけ**を投影する。
- Produces: H6の`public.get_order_status_public_material(_order_id uuid) RETURNS jsonb`は**既存public１本のSECURITY DEFINER/STABLE/ACLを保ってCREATE OR REPLACE**し、`discounts:{name,amount}[]`だけを足す。private/publicへ組み替えず既存token/公開/私有境界を保持。G-4の`get_admin_order_detail(_order_id uuid,_actor_id uuid) RETURNS jsonb`も同signatureでdiscounts:AdminOrderDiscountBreakdown[]を追加。orders.readだけで注文内訳を読め、設定管理のdiscounts.readとは分ける。
- Produces: `buildCustomerOrderPublicView`の返り値へ`discounts:OrderDiscountBreakdown[]`、`OrderEmailMaterial`の現行確認メール用材料へ同じ配列を追加。確認メールの小計→割引ごとの行→送料→合計、各行「割引（{name}）: -¥{amount}」、0額は省略、HTML/text両方をescape。既存メール種別/outbox key/送信回数/再送権限を増やさない。
- Produces: 会員詳細/OrderStatusPublicの「クーポン値引き」は「割引」にそろえ内訳を出す。旧注文は合計だけの「割引」１行、正額0は省略。コードは管理詳細と本人入力中のcheckoutだけに出し、顧客メール/会員詳細/公開状況には名前と額を出す。管理詳細はコードと行別配分も表示。H6 assert DETAIL `h6_order_breakdown`・`h6_customer_projection`・`h6_admin_projection`・`h6_public_acl`。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-552-AC-01: 確認メールと会員詳細と注文状況は同じ名前と額を割引として表示し0円を出さない`（HTML/text/UI、名称変更後も注文時名、旧１行、重複なし）、`FREQ-552-AC-02: 公開注文状況とメールへコードや割り当てや会員情報を足さず所有確認前はstoreを呼ばない`（public JSONキーのallowlist、他人401/403/404の既存契約、token期限、adminだけcode/lineAllocations）、`FREQ-552-AC-03: 管理詳細の内訳と行別額とorders.discount_amountは一致する`（複数effect/対象外行/旧注文/壊れた材料500、生エラー非露出）。
- [ ] **Step 2（controller）: REDを測る。** `npx.cmd jest tests/unit/lib/discounts/order-discount-store.test.ts tests/unit/lib/orders/email/order-email-compose.test.ts tests/unit/lib/orders/customer-order-view.test.ts tests/unit/components/AccountOrderDetailPage.test.tsx tests/unit/features/order-status/OrderStatusPublic.test.tsx tests/unit/components/AdminOrderDetailSection.test.tsx --runInBand`、DB`npx.cmd jest tests/integration/db/group_h_order_views.integration.test.ts --runInBand`。
- [ ] **Step 3: InterfacesのH6と投影/表示を実装する。** 受信者/email本文/注文状況tokenを検証ログに出さない。SQL sentinelと表示辞書を１か所で変換する。
- [ ] **Step 4（controller）: 共通verifyでGREENを測る。** Step 2とadmin-order-store、H1〜H6 assert、order-status既存DB。公開投影へのcode追加/入口ACL/旧fallback欠落を改ざんし固定DETAILを検査する。メールの配信成功は未測定としてTask 12に渡す。
- [ ] **Step 5（controller）: Filesだけコミットする。** `feat(orders): 割引の内訳を確認メールと顧客画面と管理詳細へ表示する`

### Task 11: production buildと手元SupabaseでE2Eを作る

**Files:**
- Create: `e2e/discount-test-utils.ts`、`e2e/FR-ADMIN-124-discount-management.spec.ts`、`e2e/FR-ADMIN-125-discount-assignments.spec.ts`、`e2e/FR-ADMIN-126-discount-permissions.spec.ts`、`e2e/FR-ADMIN-127-discount-refund-amounts.spec.ts`
- Create: `e2e/FR-CHECKOUT-054-own-discount-codes.spec.ts`、`e2e/FR-CHECKOUT-055-discount-combinations.spec.ts`、`e2e/FR-CHECKOUT-056-discount-reservations.spec.ts`、`e2e/FR-CHECKOUT-057-automatic-repeat-set.spec.ts`、`e2e/FR-CHECKOUT-058-discount-breakdown.spec.ts`、`e2e/FR-CART-025-automatic-discounts.spec.ts`、`e2e/FR-ITEM-DETAIL-068-discount-advertising.spec.ts`、`e2e/FR-ACCOUNT-045-discounted-return.spec.ts`
- Modify: `e2e/FR-CHECKOUT-039-promotion-code-server.spec.ts`、`e2e/FR-CHECKOUT-042-promotion-code-restore.spec.ts`、`e2e/FR-CHECKOUT-031-promo-code-label.spec.ts`、`e2e/FR-CHECKOUT-032-promo-error-a11y.spec.ts`、`e2e/checkout-test-utils.ts`、`e2e/order-admin-test-utils.ts`、`e2e/permission-settings-test-utils.ts`、`e2e/FR-ADMIN-109-permission-settings.spec.ts`（32件）、`e2e/FR-CART-024-cart-api-shopify-format.spec.ts`（追加割引欄）
- Modify: `docs/02_Requirements/requirements.md`（全ACのE2E対応）、`docs/05_Quality/tests/test-spec.md`
- Test: 新規12本＋既存４本＋32件/cart応答の既存２本。採番は今回確認した各categoryの最大+1で、実装直前に再確認し、他セッションが使っていたらファイル名と正本とこの表を同時に進める。

**Interfaces:**
- Consumes: H1〜H6のpublic RPC/HTTP、production buildのport3000、手元Supabase。DB橋渡しはG同様のservice_role/actorで役割だけを試し、実routeのaal2/live sessionはwave5後の`createAdminSessionActor(db:PgClient,role:AdminSessionRole,aal:AdminSessionAal):Promise<AdminSessionActor>`で作る。HのDB関数へJWTを渡したつもりにせず、aal1/失効app sessionは実HTTPで拒否を測る。
- Produces: `withDiscountScenario<T>(name:string,run:(scenario:DiscountScenario)=>Promise<T>):Promise<T>`、`DiscountScenario={memberId:string;otherMemberId:string;guestEmail:string;ip:string;createDiscount:(input:DiscountCreateInput)=>Promise<string>;createDraft:(codes:readonly string[],buyer:'member'|'guest')=>Promise<{draftId:string;sessionId:string}>;recordPaid:(orderId:string)=>Promise<void>;cleanup:()=>Promise<void>}`。本人/メール/IPは試験ごとに固有、秘密値はログへ出さない。recordPaidは手元DBの支払反映fixtureでありStripeの実入金とは報告を分ける。
- Produces: `DiscountScenario.cleanup()`は自分の試験のfetch/fixture処理を完了・body読了/cancelしてから、作ったsession/user IDだけを既存の手元cleanupで消す。Hのuser FKがNULLになり、割引/金額/使用履歴が消えないことをassertする。全表のreset/全注文delete/production用のDMLバイパスは作らない。役割変更はwithPermissionScenarioの既存復元手順を使う。
- Produces: `withDiscountPermissionScenario<T>(run:(scenario:DiscountScenario)=>Promise<T>):Promise<T>`は既存`withPermissionScenario`の排他鍵を使い、通常scenarioは既存`withOrderAdminScenario`の共有鍵を使う。管理E2Eの新sessionは共通helperで作り、既存sessionをaal2と仮定しない。`x-real-ip`はserverが信頼するローカルE2E設定の下でだけ試験固有値を送る。
- Produces: `mockOwnDiscountPreview(page:Page,result:DiscountResult):Promise<void>`は表示/a11y専用、`installDiscountDbBridge(page:Page,scenario:DiscountScenario):Promise<void>`はStripeとの境目だけ差し替え、割引の判定/予約/返金は本物のHTTP→RPCを通す。FR-039/042/031/032は従来と同じ差替え範囲を残して新しいbody/応答へ追従する。既存helperを削除せずdetail向けの追加を横に作る。

| spec | 新規テストの正確な題とassert（各390/768/1280px） |
|---|---|
| ADMIN-124 | `FREQ-547-AC-01: 割引を作って一覧から詳細へ進み止めて再開し複製できる`。CONTACT直後、一覧７列、JST期間、stop/resume、複製新id/停止中/使用0、C12使用後disabled、画面横幅内 |
| ADMIN-125 | `FREQ-547-AC-03: 同じコードを10人に割り当てると10行で予約と確定と未使用を見分けられる`。実read10行、３状態、使用日、orderリンク、guest mask、unusedだけ解除。`FREQ-547-AC-04: 使い捨て束は１人１コードで接頭辞だけを使えない`。別人不可、単発再利用不可、100件/101拒否 |
| ADMIN-126 | `FREQ-543-AC-03: 未付与supporterは役割の権限で拒否され付与後だけ操作できる`（DB/HTTPの両方、read/manage独立、付与/剥奪）。`FREQ-543-AC-01: 管理routeは結付いたaal1を403、失効app sessionを401で拒む`（HTTPで観測、RPC未呼出しはTask4の単体でassert）。bodyを閉じて再操作できる |
| ADMIN-127 | `FREQ-551-AC-04: 安い１着を返した注文の状態別額と返金と割引の内訳が一致する`。returned17000/残20000/discount3000/返金17000、旧33/33/34、対象外行へ返金なし |
| CHECKOUT-054 | `FREQ-548-AC-01: guestの使えないコードは全理由が同じ文とログインリンクで存在を区別できない`（不在/assigned/member-only/期限/上限/最低額がexact裁定文、ログインして割引を確かめる→`/login?next=%2Fcheckout`）。member限定は汎用/publicは従来distinct、既定会員/guest switch/割当/５code/削除を実検証。`FREQ-548-AC-01: guestはメールを替えてもpreviewが同じ見込みでconfirmからだけ記録を確認する`。`FREQ-548-AC-02: 有料履歴のあるguestは自動の初回割引が外れた最終確認から払え入力へ戻るループにならない`（preview見込み→confirm200/新total→place、codeなし409=0、入力code拒否はdefinitive保持）。`FREQ-547-AC-04: 束は対象会員だけ１回、未割当束はsuffix８字でprefix単独は無効` |
| CHECKOUT-055 | `FREQ-546-AC-01: 双方の併用許可とセットの取り合いから一番お得な割引を選ぶ`。J20000/P10000/set3000/J単品1000のJ2/P1は、両方の「商品の割引と重ねる」がONなら4000、片方でもOFFならsetだけ3000。単品4000なら8000でset不採用。16000×2の商品10％とorder5000/最低30000はorderだけ5000（C22の採用割引全適用）、同着二重なし。`FREQ-546-AC-02: 同額ならcodeを使わず未採用文を表示する`。自動同額採用・未使用履歴。`FREQ-545-AC-03: 重ねすぎても注文割引から削って合計50円にする`。入力/最終/Stripe fixture総額が同じ |
| CHECKOUT-056 | `FREQ-549-AC-01: 同時の通常注文は上限と１人１回と初回を二重に予約できない`（入力codeの２page/draftの実HTTP、１成功/１拒否、入力へ戻る。automaticだけなら後続は新しい最終確認）。`FREQ-549-AC-04: 受付を通らないawaitingは割引条件が変わっても予約し入金で確定と要対応へ進む`（pendingメール１/未入金終了で取消）。`FREQ-549-AC-04: 取消後のpaid回復は超過でも確定しattention１件で出荷を止めない`、再送不変 |
| CHECKOUT-057 | `FREQ-544-AC-02: リピートのAだけ・Bだけ・両方は色サイズをまたいで２着目から効く`。prior0/1/成功返品後、member/guest、payment pending除外。`FREQ-544-AC-03: セットはそろう組だけ自動で引き他割引の着を重ねて使わない`。J2/P1は１組、2〜10種 |
| CHECKOUT-058 | `FREQ-552-AC-01: 入力と最終確認と注文の確認メールは同じ割引名と額になる`。DB/確認材料/composeの全内訳と合計、code変更不可、0行なし、改名後も旧名。実メール配送はTask12の別証拠 |
| CART-025 | `FREQ-550-AC-01: 広告OFFでもカートに自動割引と合計が分かりguestのメール条件は常に見込みになる`（履歴検索0）。`FREQ-546-AC-04: 最大カートはfallbackの時も合計を表示し管理の計算要対応へ残る`（50行×20、各分類６/全自動25の配置、checkoutで入力５code、guard注入でも200/追加再送0/注意あり。200msはTask2のpure計算で実測） |
| ITEM-DETAIL-068 | `FREQ-550-AC-03: 自動の広告ONだけ１行を出しguestに会員用案内を出さない`。既定OFF/ON/A/both/member/guest/期間、価格変化なし、取り消し線なし、cacheの跨ぎなし |
| ACCOUNT-045 | `FREQ-551-AC-01: ２着37000円の１着返品は17000円で次は20000円になる`。返品申請/管理受取/実refund RPC fixture/顧客画面まで、セット片方は他方不変、旧注文は従来額 |

**既存４本の契約:** describe/testの題は１字も変えない。FR-039の有効割引/不正0円防御の従来文はログイン済みmemberのpublic-code caseで保ち、guestの未知codeは裁定の同一文へ更新する。正常な過大割引の50円調整は新055で測る。FR-042の再検証２回/無効codeと理由/保存除去、FR-031の入力名/placeholder/見出しfocus、FR-032の常設alert１つとariaの対応を保つ。guest errorは４本とも同一の裁定文、loginリンクは不在にも同じように出し存在を漏らさない。旧題へFREQを足さず、新規だけFREQで始める。

- [ ] **Step 1: 上表の失敗する試験と既存４本の期待応答更新を書く。** 先に新規12本を定義し、scenario/bridgeをまだ実装しない。表示差替えとDB経由のcaseをtest-specへ明記し、実Stripeの証拠と誤記しない。
- [ ] **Step 2（controller）: REDを測る。** production build/手元DBを用意し、`npx.cmd playwright test e2e/FR-ADMIN-124-discount-management.spec.ts e2e/FR-CHECKOUT-054-own-discount-codes.spec.ts --workers=1 --retries=0`。未実装scenario/bridgeの失敗と、もし出た業務assert失敗を別に記録する（helper未定義は道具のREDであり、画面の回帰のREDとは言わない）。起動/権限/Docker障害はREDの証拠に数えずcontrollerへ返す。
- [ ] **Step 3: InterfacesのE2E道具と12本を接続する。** exactなrole/nameを使い、レスポンス本文を読み切る。rate-limitを全体で無効化せずIPを分ける。同時受付はfixtureで既に予約した応答を返すのではなく本物の受付を２回呼ぶ。
- [ ] **Step 4（controller）: GREENを測る。** `npm.cmd run build`後、既存のE2E起動手順でport3000のproduction serverを使用し、新12本/既存４本/ADMIN109/CART024の18ファイルを`--retries=0`で実行する。390/768/1280の全てで実測件数・pass/fail/skip・DB経路・Stripe差替え範囲を記録する。DBの待ちの証明はTask7/9を引用し、画面の並行試験だけでSQLロックを証明したとしない。
- [ ] **Step 5（controller）: Filesだけコミットする。** `test(discounts): 管理と決済と自動割引と返品のE2Eを追加する`

### Task 12（controller）: 全体検証・最終レビュー・本番確認と適用

**Files:**
- Create: `.superpowers/sdd/2026-10-29-group-h-promotions/progress.md`、`final-review.md`・`production-pre-read.md`・`verification-report.md`・`report-to-owner.md`（同じディレクトリ）、`docs/06_Operations/group-h-discounts.md`
- Modify: `docs/06_Operations/db-migrations.md`、`docs/05_Quality/tests/test-spec.md`、`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`（H/W-03/R-12）、この計画のcheckboxと未確認事項。生成レポート/graphは生成手順の出力として確認する。
- Test: Hの全単体/DB/並行/PostgREST、既存checkout/refund/return/status/email/G-0〜G-4、E2E全件。

**Interfaces:**
- Consumes: Task1〜11のcommit一覧、wave5 commitと確定helper、最新E2E baseline、全SQL最終本文、D/C対応表、末尾の未確認事項。H1の店長だけの登録/版+1は実装とassertで確認し、ownerへ前例どおりの初期登録と報告する。未完Task/未実測を成功扱いしない。
- Produces: `verification-report.md`はcommit/差分範囲/コマンド/RED・GREENの実測件数/未実行境界/３連続並行結果/最新baselineとの差分を残す。`final-review.md`は最終Opusレビューの対象commit・指摘・修正commit・再検証を残す。reviewerは明示して依頼するが、勝手に別モデルへ実装を委ねない。
- Produces: production-pre-readは既存データを変えない件数/判定だけを残す。適用順は常にwave5→H。ownerにはcommit/移行順/検証/残課題を示し「一緒に続けて適用するか、wave5だけ先に適用するか」を必ず尋ねる。H1初期登録/guest初回の有料のみは裁定済みで質問にしない。C20/C21/C22はオーナーが覆せる追加判断として明示し、C21各６/C22最大セット組数が承認済みC6/C17の範囲をどう狭めるかを示す。本番書込はownerが選んだ範囲だけ。
- Produces: `group-h-discounts.md`は共有/単発コードの作り方、使用後の編集、停止/再開、未使用解除、50円調整、未入金の回数復帰/入金後は戻らない、遅い入金の要対応の見方/確認済み、Stripe旧コードの扱い、障害時の再送/停止を説明する。配布先や生のcodeを運用文書へ保存しない。

- [ ] **Step 1: 検証の判定を先に固定する。** `FREQ-543-AC-01: routeのaal2/sessionとDBの役割権限を各層で検査する`、`FREQ-546-AC-04: 最大カートは割引集合だけを全評価しguardでも額を返して要対応にする`、`FREQ-549-AC-04: paidとawaitingのfallbackは割引条件で拒否せず入金確定と要対応へ進む`、`FREQ-551-AC-04: 外部返金と返品詳細を含めH単位額と旧均等額の総和を保つ`、`FREQ-548-AC-01: guest previewはメールに結び付く履歴を漏らさない`を必須assertにする。最新baselineのcommit/build/DB前提から比較し古い件数を転記しない。
- [ ] **Step 2: 追加試験のREDと各TaskのGREEN証拠を照合する。** 欠けたRED/DB/provider境界は未実施と書き、必要な再現を手元で実行する。過去本文のDB成功で最終SQLを検証済みとしない。全SQLをresetしてH1〜H6とG回帰、PostgRESTと並行３連続を通す。
- [ ] **Step 3: 単体・型・lint・docs・securityを最終本文で実行する。** `npx.cmd jest tests/unit --runInBand`、`npx.cmd tsc --noEmit --incremental false`、`npm.cmd run lint`、`npm.cmd run validate-docs`、`npx.cmd jest tests/unit/docs --runInBand`。implement-component/security-checkの現行skillを読んで指定の機械検証を行い、SQLを検査しないscannerならmigration安全の証拠にしない。`npm.cmd run report:traceability`の生成差分を確認し、要求表から全新ACの試験まで辿る。
- [ ] **Step 4: production buildでE2E全件を実行する。** `npm.cmd run build`→既存のproduction E2E server手順→`npx.cmd playwright test --retries=0`→`npm.cmd run e2e:compare`。最新baselineと比較し、新規/置換/失敗/skipをファイルと題で説明する。H以外の既存失敗を勝手に修正/skipしない。３幅、rate-limitのIP分割、aal2 session、body読了、39/42/31/32の題/画面契約を確認する。サーバーは既存test-e2e規則どおり残す。
- [ ] **Step 5: Stripeとメールを実測し最終Opusレビューを受ける。** 検証項目H-STRIPE-MIN-JPY（50円）とH-STRIPE-ONCE-COUPONをStripe公式Create a coupon/Add discounts to Checkoutとテストモードで確認する。amount_off/duration once/max_redemptions=1/custom対応、作成件数/rate、同draft再送の同coupon、期限切れ/遅い入金、coupon amount/Session total/DB total一致を記録する。１回目に使ったcouponの２回目適用が拒否されることも測る。couponの本番判断をownerへ再質問しない。C1について適用を止めるのは「同couponを２回使えない」と「Session合計一致」のどちらかが崩れる時だけで、件数/rateは測定結果として記録する。Mailpitは内訳合計/0行省略/１回送信を件数と判定だけ残す。D/C表・５Review Focusを最終Opusレビューに渡し、重大/中を直したら影響するDB reset/build/E2Eを再実行する。
- [ ] **Step 6: 本番の事前読取を行う。** migration末尾/関数属性/32目録とH権限の事前状態、７表の有無、旧draft/未入金件数、wave5の順と他の未適用移行、CHECKの影響、旧Stripe有効code件数を確認。全６SQLのバイト数/MD5/ASCII/１組の取引/末尾assertとDML allowlistを保存する。H1のpermissions２件/店長付与２件/admin版+1以外の既存DMLは0。補完が必要なら勝手に足さず件数と理由をownerへ示す。
- [ ] **Step 7: ownerへ適用の判断を求める。** report-to-ownerへ使える物、D1〜D16/C1〜C19、guest拒否/初回/自動条件変更の2026-10-29裁定、C20/C21/C22（オーナーが覆せる）、実測/未実測、C21の840回・最大23.83msと実engineの再計測、H1店長だけ登録/版+1、旧Stripe codeの読取件数/今後使わない影響を記す。質問は「wave5とHを続けて一緒に適用しますか。それともwave5だけ先に適用しますか」。どちらも順はwave5→H。権限投入/guest初回/couponの方式/旧code不使用を未決へ戻さず、無回答を本番適用承認にしない。
- [ ] **Step 8: 承認された範囲だけ適用し確認する。** 選ばれた同時/別日の枠でwave5→Hの順に既存controller手順とCLI helpを確認して適用。H1の初期登録/店長版+1/supporterとuserのH0/他付与不変をassertで確認。H1〜H6のassert、schema cache、管理routeとDB各層の認可、旧注文、preview見込み/固定coupon、単位額/返品詳細/注文attention２kindとDISCOUNTの計算要対応をsmokeする。実注文/実返金はowner承認済みの試験だけ。失敗は固定SQLSTATE/DETAIL/適用済み位置を残して止め、データ戻しを即興で実行しない。
- [ ] **Step 9: 記録を更新してFilesだけコミットし、graphフックの結果を確認する。** 実装コードの最終変更後・commit前にAGENTS.md指定の`graphify update .`を１回だけ完了し、進捗/レビュー/検証/適用の記録を更新して`docs(discounts): Hの検証と本番適用結果を記録する`でコミット。commit後は`graphify hook status`でフックの結果を確認するだけで、手動updateを重ねない。未適用なら明記し、pushしない。

## 未確認事項

設計として今回決められなかった事項はない。次の２件は方式のowner判断ではなく、後日のTask12で実機/本番を読む検証項目。共同適用の枠はTask12 Step7でownerへ尋ね、順はwave5→Hに固定する。

| 検証項目 | 確かめるTask / 完了条件 |
|---|---|
| **H-STRIPE-ONCE-COUPON: Sessionごとの１回限りcoupon**（仕様18章） | Task12 Step5で公式文書とテストモードの実測。１回目適用→支払→同coupon２回目拒否、同draft再送は同id、coupon/Session/DBの合計一致。件数/rateも記録。mockで完了にせず、C1の適用を止めるのは２回目拒否又は合計一致が崩れた時だけ |
| **H-STRIPE-LEGACY-CODE-COUNT: 本番の旧promotion code件数** | Task12 Step6の事前読取で有効件数だけ記録し、店の欄では使えなくなるとownerへ報告。codeの文字/配布先は記録せず、無効化/移し替えはしない。方式は仕様11.1で決定済み |

## セルフレビュー（writing-plans）

**仕様の網羅（round 2再確認）:** D1〜D16/C1〜C19を下表で実装Taskと試験へ結び、2026-10-29のcontroller裁定を本文へ反映した。C20/C21/C22は承認済み19項目とは別のオーナーが覆せる設計者判断。C21の件数capとC22の全部適用で探索の自由度を採否だけに限定し、N1の再確認、guest初回の有料のみ、再試行上限、rate-limitを実assertへ固定した。

| 決定 | 実装Task | 固定する試験 |
|---|---|---|
| D1 共有と１人１コード | 3・5・11 | 547-AC-03/04 |
| D2 注文/商品/リピートの形 | 2・5・6 | 544-AC-01/02、545-AC-01 |
| D3 A/Bの選択 | 2・5・11 | 544-AC-02 |
| D4 両方は通算２着目 | 2・7・11 | 544-AC-02、549-AC-01 |
| D5 セット | 2・5・11 | 544-AC-03 |
| D6 Aはログイン会員の購入 | 2・3・7 | 544-AC-01/02 |
| D7 コード/自動とguest | 2・3・5・8 | 544-AC-01、550-AC-01 |
| D8 広告は既定OFF | 5・8・11 | 550-AC-03 |
| D9 割引別の併用 | 2・5・11 | 546-AC-01 |
| D10 コードは既定会員のみ | 3・5・6・11 | 548-AC-01 |
| D11 全条件 | 1・2・3・5 | 542-AC-01、544-AC-01、547-AC-02 |
| D12 10人なら10行 | 3・5・11 | 547-AC-03 |
| D13 割当だけ/誰でも | 3・5・6 | 547-AC-05、548-AC-01 |
| D14 入金後は回数を戻さない | 7・9・11 | 549-AC-03、551-AC-03 |
| D15 安い着から返す | 9・11 | 551-AC-01/02/04 |
| D16 遅い入金の超過は認めて要対応 | 7・11 | 549-AC-04 |
| C1 １回限りcoupon | 6・12 | 548-AC-03、H-STRIPE-ONCE-COUPON |
| C2 50円の下限 | 2・6・11・12 | 545-AC-03、確認済みH-STRIPE-MIN-JPYと50円のテストモード検証 |
| C3 未入金終了で回数を戻す | 7・11 | 549-AC-03/04 |
| C4 guestは正規化メール | 3・7・11 | 549-AC-05 |
| C5 入金済み着数−成功返金 | 2・3・9・11 | 544-AC-02、551-AC-03 |
| C6 25自動/５コード | 2・3・5・6 | 546-AC-03 |
| C7 100個/接頭辞/4〜8文字 | 3・4・5・11 | 547-AC-04 |
| C8 同額はコード最少 | 2・7・8・11 | 546-AC-02/03 |
| C9 共通の注文基数 | 2・6 | 545-AC-01 |
| C10 セット各服１着 | 2・5・9 | 544-AC-03、551-AC-03 |
| C11 ２権限/supporter初期なし | 1・3・4・5・11・12 | 543-AC-01/02/03（H1の初期登録/店長版+1、routeとDBを分離） |
| C12 使用後編集の範囲 | 3・4・5 | 547-AC-02 |
| C13 限定codeの拒否とguestの存在秘匿（controller裁定） | 2・6・8・11 | 548-AC-01、550-AC-02（guest全文/理由同一、memberは仕様9.1） |
| C14 広告は値段を変えず１行 | 8・11 | 550-AC-03 |
| C15 「割引」の内訳 | 8・10・11 | 550-AC-01、552-AC-01 |
| C16 確認後の無効（round2裁定でcodeとautomaticを区別） | 6・7・8・11 | 548-AC-02、549-AC-01、550-AC-02（codeだけ409/input、automaticは新しい最終確認） |
| C17 セットと他効果の取り合い（C22の１着比較と全部適用へ限定） | 2・3・11 | 546-AC-01/04、547-AC-04（セット取り分との１着比較/共有禁止/採用時最大組数） |
| C18 本人鍵で初回/着数も再確認 | 7・11 | 549-AC-01/05 |
| C19 旧注文の返金は従来式 | 1・9・10 | 542-AC-02、551-AC-02、552-AC-03 |
| C20案 要対応の確認済み（設計者提案） | 3・4・5・7・12 | 546-AC-04、549-AC-04（DISCOUNT計算注意/注文注意とも解決で金額と使用を変えない） |
| C21 併用ON自動は各分類６件（オーナーが覆せる） | 2・3・4・5・11・12 | 546-AC-04（840回試作/実engine200ms）、547-AC-04（７件目/競合/期間/trigger/固定文） |
| C22 採用割引は全適用、セットは最大組数（オーナーが覆せる） | 2・3・5・6・7・8・11・12 | 546-AC-01（最低57000・併用ON、最大２組後54000ではorder不可、１組後57000なら13000だが部分組数を作らずorder単独10000。J単品2500の１着比較は5000）、546-AC-04（集合数だけの上界） |

表の`542-AC-01`等は全て`FREQ-`を前に付けたIDの略記。

**Stepの確認:** 各TaskはFiles/Consumes/Produces→正確な題とassert→REDのコマンド→実装signature→GREENのコマンド→controllerのcommitメッセージを持つ。Task12は承認/適用を含むcontroller作業で、すでに実装した物を壊してREDを捏造しない。本文は型・値・試験を決め、関数本体は書かず、探索と配分だけ短い疑似コードにした。

**型と名前の確認（round 2）:** 検索はsearchBestDiscountPlanだけ、guardはmaxProductPlans/maxCombinations、本番2067/160000。ProductPlanの数量/残り/組数/額は出力、cacheキーはdiscount集合だけ。DiscountFacts.hasFirstOrderReservationはpreview guestだけnull、confirm/acceptanceはbooleanで初回有料履歴と区別する。DiscountResult.calculationMode=exact/fallbackで統一し、検索の例外/503型は除去。DiscountRefusal.reasonに使わないlogin用の値なし。DiscountSearchAttentionはH2列→SQL JSON→TS store→一覧/詳細で同じopenedAt/count、acknowledgeSearchAttentionは設定patchと混在不可。H recheckはjsonbの３kind、code不適合は409/input/definitive、automatic_changedは200/reconfirmationRequired、新しい最終確認。Stripe paid/awaitingは固定結果の非拒否経路。注文attention２kindとDISCOUNTの計算要対応を混同しない。旧注文/割引0のH注文、AdminOrderDiscountBreakdown.discountId:string|null、既存SQLの属性は従来のまま。

**Review Focusの確認（round 2）:** ５行全てに→実装Taskと正確な試験題/assertがある。集合探索/最大cart/C21/C22/fallback→Task2 AC546-01/04とTask3 AC547-04、通常コード競合/自動再確認/両fallback→Task7 AC549-01/04/05、全返金reader/旧式→Task9 AC551-01/02/04、guest拒否/メール見込み/確定拒否復元→Task6 AC548-01/02とTask8 AC550-02、routeのsessionとDB役割分離→Task1/3/4 AC543-01。DB/provider/browserの実測を今回の文書検査と混同しない。

**分量と境界の確認（round 2）:** 12Task/６移行の順と担当、共有checkout通知をTask6/7/8の最初に保った。今回の書込はこの計画だけ。計測はファイルを作らない純粋Node試作だけで、DB/server/Playwright/providerを動かしていない。N=6の試作と後日実engineの性能検証を分けた。未確認事項はcoupon実測と本番旧code件数の２検証項目だけで、guest初回は裁定済み、共同適用の枠はTask12のowner質問。

**レビュー指摘の処理（round 1）:**

| 指摘 | 対応と確認した境界 |
|---|---|
| Critical 1 | Task1/3のDBはactor役割だけ、Task4/11のrouteはaal2/live session、543-AC-01を層別に書換え |
| Critical 2 | round2/C22で旧数量探索を置換。商品全着・セット最大組数、class別採否集合を全評価、金額memo/組数分岐なし。C21各６件、セット共有item保存拒否、上界157696、試作840回最大23.83ms。guardでも単独/全互換案の最善と管理要対応 |
| Important 3 | H1で２permission/店長だけ２付与/admin版+1、baseline比較assert、未確認から削除 |
| Important 4 | paid/awaiting両fallbackを非拒否SQLへ、awaitingはreserved、入金確定とattention、discount_*契約違反も試験 |
| Important 5 | guest previewはtypedメールを破棄し記録検索0、常に見込み、confirm/acceptanceだけ照合 |
| Important 6 | 2026-10-29裁定を記録、guestの全拒否を同じ文/理由/リンク、memberの区別は保持 |
| Important 7 | external refund/return_detail_jsonと全均等式読者を列挙、最安claim/配列/待ち額/画面/メールを同じfixtureで回帰 |
| Important 8 | created draft.discount_amount=0、割引はJSON、40000+0=37000+3000、completed書戻しのCHECK/試験 |
| Minor 9 | createLiveAppSession/jwtClaimsはRLS回帰、createAdminSessionActorはroute/E2E、Hのactor DBはsession不要 |
| Minor 10 | Stripe公式JPY50とShopify25/5を確認済み出典へ移し、再確認待ちを適用条件にしない |
| Minor 11 | load_order_refund_materials/get_order_status_public_materialの既存public DEFINER/STABLE/ACLを保つ |
| Minor 12 | snapshot/lock/refund mismatchのSQLSTATE・HTTP・日本語を共通拒否表へ追加 |
| Minor 13 | AdminOrderDiscountBreakdown.discountIdはstringまたはnullで統一 |
| Minor 14 | 割引0でもH draftはversion1の固定JSON、注文は全通常着のunit記録を持つ |
| Minor 15 | auth.usersのFKはSET NULL、退会assignedは無効のまま、E2E cleanupとFK試験を明示 |
| Minor 16 | 待ちはG共通鍵で観測、本人鍵の効果と偽らず１成功/１拒否をassert |
| Minor 17 | 未割当anyone束はsuffix８字、会員割当束４字、両方同長32回再試行 |
| Minor 18 | round2裁定でguestも有料注文のみ。Task3/7の読取/初回判定/未入金やり直しを同じassertへ統一し未確認から除いた |
| Minor 19 | 確認済み操作をC20案/ownerが覆せる設計者提案と明記しTask7/12へ |
| Minor 20 | checkout-draft.mdと新規discount-redemptions.mdを状態文書のFilesへ追加 |
| Minor 21 | guestに「ログインして割引を確かめる」/login?next=%2Fcheckout、code/emailなし |
| Minor 22 | 手動更新の全廃は採らない。現在のAGENTS.mdが「After modifying code, run graphify update . before completing the task」を明示するため、commit前１回は残し、commit後はhook statusだけとする |

**再レビュー指摘の処理（round 2）:**

| 指摘 | 対応と固定した試験 |
|---|---|
| Critical 2 + C21/C22 | 上の集合探索/保存cap/最大セット/guard成功。Task2 AC546-01/04、Task3/4 AC547-04、Task5注意/固定文、Task11 CHECKOUT-055/CART-025。保存時の探索予算は追加しない |
| N1 | 自動の不適合はconfirm/placeとも新しい最終確認、入力codeだけ409/確定拒否。Task6/8 AC548-02・Task7 AC549-01・CHECKOUT-054で returning guest loop=0 |
| N2 | 双方の商品併用ONでJ単品1000→セットあり4000、片方OFFならsetだけ3000。J単品4000→全単品8000。Task2/11と下の手計算表で同値を確認 |
| Minor 1 | DiscountRefusal.reasonから未使用のlogin用値を削除 |
| Minor 2 | searchBestDiscountPlanとDiscountSearchGuardの２個の集合数だけに型/呼出し/試験を統一 |
| Minor 3 | queue最大９回・failed→dead/dead_at・既存dead-letter運用警告、内部照合３回と区別。Task7 AC549-04 |
| Minor 4 | guest confirmの結果変更にもIP10/10秒・60/600秒/session10/60秒を先に適用しlimit+1で履歴読取0。Task6 AC548-02 |
| 未確認事項 | guest初回は有料のみへ決定。couponと旧code件数はTask12の検証、共同適用はwave5→H固定の枠だけownerへ質問 |

**数値例の手計算（round 2）:** 例の算術を再確認し、oracleで評価する時もこの期待額を先に固定する。

| 入力 | 正しい結果と試験 |
|---|---|
| 101×15％ / ２着 | floor15 / 合計30、545-AC-01 |
| order10000×(10％+20％) | 1000+2000=3000引き/7000、545-AC-01 |
| D100/同重み３つ | 累積33/67/100の差33/34/33。D1→0/1/0、D2→1/0/1。旧G-4状態分割は33/33/34、545-AC-02/551-AC-04 |
| subtotal1000/product900/order99 | orderを49削り商品900+order50=950引き/50。商品990単独も950へ削る、545-AC-03 |
| J20000×2/P10000×1・set3000/J単品1000 | 両方の「商品の割引と重ねる」がONならset１組3000（J2000/P1000）+残J1000=4000、全単品2000。片方でもOFFならsetだけ3000、546-AC-01 |
| 同cart・J単品4000 | 全J8000>set案、セット不採用、546-AC-01 |
| 同cart・J単品2500（両方の商品併用ON） | setのJ取り分2000<2500なのでJ２着は単品、set0組/5000引き/45000。組全体で比べた5500はC22の範囲外、engineと独立oracleの546-AC-01 |
| 16000×2・商品10％/order5000最低30000 | 商品3200後28800でorder不可。order単独5000/27000、546-AC-01 |
| J20000×2/P10000×2・set3000/order10000最低57000 | set/orderとも併用２チェックON。最大２組6000後54000<57000でorder不可。order単独10000/50000。１組後57000>=57000なら3000+10000=13000だがC22でその部分組数は不可、546-AC-01 |
| ２item1000×10・商品10％/repeatB15％/code5％ | 先頭２着100×2+後18着150×18=2900/17100、546-AC-04 |
| 最大cart1000000・product11％/order1..6％ | 110000+890000×21％=296900/703100、546-AC-04 |
| 最大cart1000000・product6％/order1..11％ | 60000+940000×66％=680400/319600、546-AC-04 |
| 20000×2の２着目3000引き | 20000+17000=37000、返金17000→20000、残37000−17000=20000、551-AC-01/04 |
| draft40000/discount_amount0・Stripe37000/discount3000 | 40000+0=37000+3000、548-AC-02 |

再レビューの４Minorは全て採用した。round1 Minor22だけはAGENTS.mdの明示規則があるため前述の理由で手動更新の全廃を採らず、commit前１回/commit後hook statusを保つ。

**再レビュー指摘の確認（round 3）:** R2-1は最低57000円に統一し、60000−6000=54000<57000、60000−3000=57000で部分１組だけなら13000になることを手計算した。C22の正解はorder単独10000、total50000。セット対単品の強さは１着の取り分で定義し、C17をどう限定するかをC22へ明記、J単品2500の5000円をengine/oracle別々の題へ追加した。4000円の全引用に双方の商品併用ON（片方OFFは3000）を記し、FREQ-546の証明Taskを2/3/6/8/11とTask3/6の要求追記欄へ一致させた。12Task・D1〜D16/C1〜C22の対応と５Review Focusの試験への矢印は維持した。
