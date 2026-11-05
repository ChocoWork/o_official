# 会計の作り直し 計画4「返品の条件の表示」実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 返品の条件の文を、ショップの設定（返品の欄・理由ごとの設定・期限）から1つ作る部品を作り、商品ページ・最終確認の画面・特定商取引法の表記・利用規約の第6条・フッターのリンク先の新ページ「返品について」の5か所が同じ文を出すようにする。文は「返品の特約」（お客様の都合の返品・交換を受けるかどうか）と「契約の内容に合わない品」（破損・不良・注文と違う品・数の不足）を分けて書き、合わない品は期限で締めない。受付の作りも同じ考え方に直す（合わない品は期限で締めない、「その他」は返品不可の品にも開く）。受付の期限は文の期限（届いてから7日）より早く締まらない形にする。注文には、注文した時に出ていた条件の中身・版・日時と、返品不可の品の印を残す。帳簿の仕訳は変えない（14-h）。

**Architecture:** 文の元は DB の2つの設定の表（`shop_return_settings`・`shop_return_reason_settings`）。DB は文を作らず、**文に効く設定だけを1本の SELECT で読んで正規の jsonb（`inputs`）にし、その SHA-256（`inputs_hash`）を出す**（1本の SELECT なので、設定を直す人と同時でも2つの表の途中の状態を読まない）。文を作るのは TS の純粋な関数 `renderReturnTerms(inputs)` 1つだけで、5か所は全部これを通る（手で書いた文を別々に置かない）。注文の条件の中身は「`inputs`（内容で同じ物は1行にまとめる追記専用の表）」と「その注文を作った時の `inputs_hash`」で残す。注文の insert に DB のトリガーをぶら下げて、この条件の記録を同じトランザクションで残す（決済の関数 `place_order_from_checkout_draft` の本文は1字も変えない）。お客様が最終確認の画面で見た版（`inputs_hash` と文の版 `templateVersion`）と、そこで見せた返品不可の品の番号の一覧（`returnIneligibleItemIds`）を place-order の本文で送る。新しい public の入口 `place_order_with_return_terms` が、**設定の行を共有ロックしたまま**現在の文の版・品の印の一覧と比べ、違えば注文を作らず「確認へ戻る」（応答の形は H の自動割引と同じ `reconfirmationRequired`。ただし決済の画面は閉じない）、同じなら決済の関数をそのまま呼んで、同じトランザクションで見た版と注文時に返品不可の印がある品の番号の一覧を追記専用の表に残す（比べてから注文を作るまでの間に設定は変わらない。決済の関数の本文は変えない）。内容で一意の表と `ON CONFLICT DO NOTHING` だけを使うので、届く順や同時の更新に頼らず、二重も抜けも起きない。

**Tech Stack:** 現行の Next.js `^16.3.6`、React `^19.0.0`、TypeScript `^5`、Supabase Postgres 17・PostgREST、Zod `^4.3.6`、`pg`、Jest、React Testing Library、Playwright。依存を増やさない。

**Spec:** [承認済みの設計](../specs/2026-11-03-accounting-redesign-design.md)の 14章の全部（14-1〜14-5）、A6・A9・A13、16章のうち範囲に関わる行（「届くのに一番長くかかる日数（14-e の目安）」）を正本とする。[計画1](2026-11-04-accounting-p1-journal-foundation.md)・[計画2](2026-11-04-accounting-p2-deferred-revenue-stripe.md)・[計画3](2026-11-04-accounting-p3-returns-refunds.md)の冒頭の地図・Global Constraints・「共通の型・値・拒否」を正とし、前の計画を変える必要があれば「前の計画への直しの願い」の節に書く（前の計画のファイルは変えない）。[今の作りの地図](../../../.superpowers/sdd/2026-11-04-accounting-redesign/recon-report.md)の `recon-part-D.md`（6章・食い違い1・7・8・9）は現状と file:line の手掛かり。ブランドの前提は [brand.md](../../01_Planning/brand.md)（お客様に見える文は穏やかで、感嘆符・絵文字なし）。形式は計画3と [H の計画](2026-10-29-group-h-promotions.md)を引き継ぐ。設計で決まったことは変えない。決められない所は末尾「未確認事項」に置く。

## 概要

確認日 2026-11-04、基準 `master / 4cfaafee`（計画1〜3が書かれた時点。計画1〜3の実装は未着手）。この文書を書く作業は計画だけで、実装・DB・provider・ブラウザーの成功を表さない。graphify の既存グラフ（36142 ノード）で返品の設定・期限・受付の関数の場所を確かめたが、グラフはその後の編集より古い可能性があるので、結論はソース（`supabase/migrations/20261012235910_order_return_records.sql`・`20261021221140_delivery_tracking_admin.sql`・`20261023211425_group_g1_allocation.sql` ほか）を直接読んで確かめた。

### 7本の計画の中の位置

地図は計画1の「7本の計画の地図」のとおり。計画4は14章だけを受け持ち、**帳簿の仕訳・印・勘定は1つも足さない**（14-h）。計画3が作る物とは次の点だけでつながる。

| 前の計画から使う物 | 計画4での使い方 |
| --- | --- |
| 計画1: Global Constraints（移行の形・ASCII・`U&'\XXXX'`・route の順序・no-store・DB 試験の ROLLBACK の形・権限は足さない・graphify の回し方） | そのまま当てる。新しい権限は足さない（設定の更新は既存の `admin.settings.manage`、読み取りは公開） |
| 計画3: FREQ-584・S23・`FR-ADMIN-140` までの番号 | 続きの番号を使う（FREQ-585〜、S24〜、`FR-ADMIN-141`〜） |
| 計画3: Task 2 の返送料・交換の手数料の DB の固定（S16）と `ShopReturnSettingsSection.tsx`・設定の route の変更 | 文の部品は定額の返送料・交換の手数料を**読まない**（0に固定されているため）。割合の手数料（`restocking_fee_*`）だけ読む。同じ画面・同じ route を触るので、計画3 Task 2・11 のコミットの後に始める |
| 計画3: Task 4 の `admin_receive_return`（末尾に `_arrived_on`）・Task 1 の `order_return_receipts.arrived_on` | 関数は触らない。返品の届いた日（返品を受け取った日）と、計画4の受付の期限の「お客様に届いた日」は別の物。ただし計画3の S18 は G の書き手の一覧の `admin_receive_return` を新しい形に置き換えるので（本数は77のまま）、計画4の一覧 `P4_ALLOWLIST` は計画3が足す `P3_ALLOWLIST` の上に1本足して78本にする（Task 8） |
| 計画1の地図の行4（2026-11-04 に controller が直した）: 返品の受付・期限・設定の関数7本〔`get_shop_return_settings`・`admin_update_shop_return_settings`・`customer_request_return`・`customer_return_line_states`・`customer_return_availability`・`get_customer_return_request_materials`・`fulfillment_line_returnable`〕の手入れは、計画3の後に計画4が行う。計画5〜7は触らない | 計画4はこの7本に加え、2026-11-05 controller 決定で管理画面の読み口 `get_order_return_materials`・`return_detail_json` の2本を Task 9 で手入れする。新しい入口 `place_order_with_return_terms` は決済の関数を呼ぶだけ。`customer_return_line_states` は戻り型を変えず、新しい小さい関数 `customer_return_defect_lines` を足す |
| 計画1〜3の S0〜S23 が本番に当たっていること | 計画4の本番適用の前提（Task 14） |

**計画4が受け持たない物:** 返品の追跡番号を追跡のサービスに登録する作り（E-4 の追跡をオンにした後）、注文確認メールへの返品の条件の追記（設計 14章に無い。未確認事項 #10）、適格返還請求書（計画6）、原価・在庫（計画5）。

| Task | 中身 | 移行 | FREQ | 検証 |
| --- | --- | --- | --- | --- |
| 1 | 条件の文を作る部品（純粋な TS）と、期限の数え方の部品 | — | 585 | 単体 |
| 2 | 設定に「添える文」の欄を足し、設定の読み書きを直す | S24 return_terms_settings | 586・593 | DB/単体 |
| 3 | 文の元の読み口・内容で一意の表・公開の読み口 | S25 return_terms_tables | 586 | DB/単体 |
| 4 | 公開の route・読み込みの部品・「返品について」のページ・フッターのリンク | — | 587 | 単体/RTL |
| 5 | 商品ページの一文（全部の品・価格の近く） | — | 587 | RTL |
| 6 | 最終確認の画面の印・見出しの文・申し込みの方法の条件 | — | 588 | RTL |
| 7 | 特定商取引法の表記と利用規約の第6条に同じ文を差し込む | — | 589 | RTL |
| 8 | 注文に条件の版を残す（トリガー・新しい入口で比べて注文を作り見た版を結ぶ・照合の道） | S26 order_return_terms_record | 590 | DB/並行/単体 |
| 9 | 受付の作り（その他・合わない品を期限で締めない・申し込みのボタンが期限後も出る） | S27 return_request_rules | 591 | DB/並行/RTL |
| 10 | 期限（目安の既定・法律の8日の別の数え方・遅れの案内） | S28 return_deadline | 592 | DB/単体/RTL |
| 11 | 設定の画面（添える文・プレビュー・警告） | — | 593 | RTL |
| 12 | 新しい E2E | — | 585〜593 | 本番 build/手元 DB |
| 13 | 文書の正本の更新 | — | 全部 | validate-docs |
| 14（controller） | 全体検証・最終レビュー・本番を読む・適用・記録 | — | 全部 | baseline 比較 |

**決めたこと（この計画の細部。設計の決定は変えない。「AI の判断」はオーナーが覆せる）**

- 移行は5本。`supabase/migrations/<ts24>_accounting_p4_return_terms_settings.sql`（S24）、`<ts25>_accounting_p4_return_terms_tables.sql`（S25）、`<ts26>_accounting_p4_order_return_terms_record.sql`（S26）、`<ts27>_accounting_p4_return_request_rules.sql`（S27）、`<ts28>_accounting_p4_return_deadline.sql`（S28）。時刻は計画3の S23 の後に controller が実装時に採番し、S24→S28 の順にする。適用済みの移行は編集しない。移行実行時の DML は、S24 の設定の1行の更新（`contract_note` の初期値）と S28 の設定の1行の更新（目安の日数の既定。人が変えていなければ）だけ（本番の注文は試しだけで0件のため、ほかの既存の行は動かない。設計 0-4）。
- **文を作る場所は TS の1か所（`renderReturnTerms`）。** DB に文を複製しない（SQL と TS で文がずれるのを避ける）。DB が持つ物は「文に効く設定の jsonb（`inputs`）とそのハッシュ」と「TS が作った文の控え（`renderings`）」。文の版は `templateVersion`（整数。文の作り方を変えたら上げる）と `inputs_hash` の組で決まる。**過去の `templateVersion` の作り方は削除しない**（`renderReturnTerms` は版を受けて作り分けられる形にはせず、古い版の文は `renderings` の控えで残す。控えがあれば、コードが変わった後も注文の時の文を示せる）。
- `inputs` に入れる設定（文の意味を変える物だけ）: 受付の有無・種類、期限の日数と数え始め、返送の方法（`customer_paid_method`）、受け取りで送り返さなくてよい扱いの有無、割合の手数料（有効の時だけ%）、添える文（`contract_note`）、理由ごとの 出す／ご希望／在庫の無い交換／写真／写真の案内／送料の負担。**入れない物:** 返送先（住所・電話。個人情報を公開しない）、更新者・日時、目安の日数（`delivery_buffer_days`。文には出ず、期限の締め方だけに効く）、定額の返送料・交換の手数料（0に固定。計画3 S16）、検品の有無。
- **公開の route には、`inputs` の中の設定と作った文だけを出し、返送先・更新者・個人情報を含めない**（試験で固定する）。お客様が読む route なので認証は無く、IP の回数制限をかける。

- **12ポイントの読み方（決まった。旧 未確認事項 #8）:** 12ポイント＝16px（1pt＝1/72インチ、CSS は 96px/インチ）。ガイドラインの数は例なので、一文の大きさは「価格の大きさ以上」にそろえる（価格は md で 1rem＝16px、狭い幅は `--lk-size-md`）。AC は「価格以上」とし、「12px 以上」とは書かない。
- **メールの文（決まった。旧 未確認事項 #10）:** 注文確認メールに返品の条件の手書きの文は無い（`order-email-compose.ts` にあるのは返品のお断り・受け取りの文だけ）。計画4は触らない。お断りの理由 `window_passed`・`final_sale`（`return-messages.ts:101-102`）は Task 9 で扱う。
- 2026-11-04 計画4の確かめから直した: ①期限後に申し込みの画面そのものが開かない所を直した（`customer_return_availability` を S27 に足し、画面と注文の状況のページも直す。重大-1）。②見た版の確かめを注文を作るトランザクションの中に入れた（新しい入口 `place_order_with_return_terms`。設定の行の共有ロック。決済の関数の本文は変えない。断りの時に今の文を返し、決済の画面は閉じない。重大-2・中-2）。③計画1の地図の行4を controller が直した件を願いの節に書いた（中-1）。④注文と記録は消せない形に決めた（中-3）。⑤照合の道を分けた（トリガーは失敗しても注文を止めず、新しい入口は記録が無ければ取り消す。中-4）。⑥期限の日数・数え始めは注文の時の記録から読み、法律の8日に戻す条件を「見た版の結びが無い」にした（中-5）。⑦返品不可の品にも送料の負担を出す（中-6）。⑧「返品できない場合」の箇条書きを Task 1 の規則表に入れた（中-7）。⑨最終確認の行のデータに足す決済のファイルを Task 6 に入れた（中-8）。⑩小-1〜8。
- 2026-11-04 計画4の確かめ直し（1回目）から直した: ①新しい入口を G の書き手の閉じた一覧に足し（77→78本）、意図して直す試験〔`group_g1_writer_inventory`・`group-g-allowlist.ts`・H の確かめを流し直す試験〕と入口の SECURITY・所有者・`search_path`・委譲の形を書いた。共通の押さえを持つ関数は設定の行の鍵を取らない決まりを足した（重大-A）。②材料の関数 `get_customer_return_request_materials` を7本目として名指しし、地図を7本にそろえた（中-A）。③`customer_return_defect_lines` の数の式を `fulfillment_line_returnable` と `order_line_return_counts` から作るように直した（中-B）。④入口の引数に `DEFAULT NULL` を付けた（小-A）。⑤設定の更新の鍵は今の関数にあるので足さない（小-B）。⑥`available` の時は `ended_on` を空にし、合わない品の理由を出さない設定は今のとおり `ended`（小-C）。⑦ロックの後にも既存の注文を見る（小-D）。未確認 #15・#16 はオーナーの判断のまま（#16 は 14-a3 の2つの文の読み方が分かれる点を報告に書く）。
- 2026-11-04 計画4の確かめ直し（2回目）から直した: ①G の書き手の一覧は `P4_ALLOWLIST` を足して `CURRENT_ALLOWLIST` を付け替え、H4・H7 の確かめを流す前に H4 の一覧の関数の文を1字も変えずに流して戻す形にし、直す試験3つを Task 8 の Files に入れた（中-1）。②S26 の末尾の確かめの固定コード `acc_s26_*` を書いた（小-1）。③`customer_return_availability` の引数を `public.orders` に直した（小-2）。④古い名前を消した（どの Task にも無い関数名、Task 14 の関数の一覧、行番号。小-3）。⑤鍵の順を計画1の決まりに合わせて書いた（小-4）。

- **返品不可の品の印（決まった。旧 未確認事項 #15）:** お客様が注文した時の値を注文ごとに残す。注文後に店が品に印を付けても、外しても、前の注文の受付と画面は注文の時の値のまま（相談の窓口では受けられる）。S26 の `order_return_terms_shown.return_ineligible_item_ids` に残し、`place_order_with_return_terms` が同じトランザクションで書く。印の記録が無い注文（照合の道で支払いの後から作る注文・直接作る注文を含む）は「返品不可でない」として受ける。期限と同じくお客様に有利な側にする。
- **「その他」の期限（決まった。旧 未確認事項 #16）:** 今の計画のまま。破損・不良・注文と違う品だけ期限で締めず、「その他」の相談の申し込みは期限で締める。節④の「期間を過ぎた後はお問い合わせでご相談ください」も変えない。
- 2026-11-05 オーナー決定（未確認 #15）を入れた
- 2026-11-05 全体の最終レビュー（final-review-p3-p4）の指摘を入れた
- 2026-11-05 最終レビューの直しの確かめ（final-review-b2）の指摘を入れた
- 2026-11-05 計画5・6の直しの確かめ（final-fix-review-b3）の中-3 を入れた（計画3の S18 の確かめを `runWithAllowlist(P3_ALLOWLIST)` の中で流す直しを Task 8 の意図して直す試験に足した）
- 2026-11-05 直し3回目の確かめ（final-fix-review-b2-3）の小1 を入れた（Task 8 Step 4 の直した試験の数を4つにそろえた）
- 2026-11-05 計画5・6の直しの確かめ（final-fix-review-b3-2）の中-C を入れた（Task 8 の意図して直す試験の4番目で、計画3の S18 に加えて S19 の確かめ〔`acc_s19_g_allowlist_unchanged`〕も `runWithAllowlist(P3_ALLOWLIST)` の中で流す。直す試験のファイルは4つのまま）

## 前の計画への直しの願い（計画4を書いて分かったこと）

**1件（controller が直した）。**

| # | 計画の場所 | 願い |
| --- | --- | --- |
| 1 | 計画1の地図の行3・行4（「返金・返品の SQL 関数の手入れは計画3だけ」） | 返品の受付・期限・設定の関数7本（`get_shop_return_settings`・`admin_update_shop_return_settings`・`customer_request_return`・`customer_return_line_states`・`customer_return_availability`・`get_customer_return_request_materials`・`fulfillment_line_returnable`）の手入れは、設計 14章（14-a3・14-e）のため計画3の後に計画4が行う。計画5〜7はこの7本を触らない。**controller が計画1の地図の行4を7本に直した（2026-11-04。7本目の `get_customer_return_request_materials` は確かめ直しで見つかった）。計画4の Task の関数名は、今のコードの名前と地図の7本にそろえた**（Task 2: 設定の2本、Task 9: 受付の `customer_request_return`・`customer_return_availability`・`get_customer_return_request_materials` と新しい小さい関数、Task 10: 期限の1本）。`customer_return_line_states` は名前だけ地図にあるが、戻り型を変えないので計画4では作り直さない（新しい小さい関数 `customer_return_defect_lines` で足りる） |

ほかに確かめた点: ①計画3 Task 2 が触る `shop_return_settings` の CHECK（定額の手数料を0に固定）と、計画4 S24 が足す `contract_note` の列は重ならない。②計画3が作り直す7本の関数に、計画4が作り直す関数は入っていない（G の書き手の一覧だけは計画3の S18 と計画4の S26 の両方が作り直すので、S26 は S18 の後の定義を写す。final-review-b2 の小4）。③H5 の `h5_function_baseline` の対象は返金・返品の14本（`20261029130400_…sql:3-20`）で、追加する `private.return_detail_json(uuid)` が入っている。H5 の末尾の確かめは属性と本文の MD5 を比べる。S27 は引数・戻り型・属性・ACL・所有者を保ち、本文だけを囲みで直す。`group_h_migration_asserts` の `FREQ-551-AC-02` は、計画3と同じく新しい本文の MD5 と囲みを除いた本文の比べ方を期待にする（Task 9）。H4 の末尾の確かめ（`20261029130300_…sql` の `h4_final`）は `place_order_from_checkout_draft` と `place_reconciled_order_from_checkout_draft` の本文の MD5 を固定しているが、計画4は両方の本文を変えない（新しい入口が呼ぶだけ）ので通る。実装時に対象を `grep` で数え直し、入っていたら Task の Files に足して報告する。

## Global Constraints

計画1の Global Constraints を全部そのまま当てる。違う所は次の3つだけ。

- 要件の FREQ の番号は、計画3が使った最後の番号の次から。FREQ は 585〜593（計画3は 575〜584。実装時に別セッションとの重なりを確かめる）。移行は S24〜S28（計画3は S15〜S23）。試験の題は `FREQ-NNN-AC-NN: …` で始める。E2E は、お客様の画面は CLAUDE.md の要求管理ルールのカテゴリで名前を付け、番号は実装時に `ls e2e` で最大を取り直す（2026-11-04 の最大: `FR-ITEM-DETAIL-068`・`FR-CHECKOUT-058`・`FR-LEGAL-006`・`FR-TERMS-005`・`FR-FOOTER-001`・`FR-ACCOUNT-046`。新しいカテゴリ `FR-RETURNS` は 001 から）。管理画面は `FR-ADMIN-141` から（計画3は 137〜140）。3つの幅（390・768・1280px）で確かめる。
- 本番への適用の Task（最後の controller の Task 14）の前提: 計画1〜3の移行（S0〜S23）が本番に当たっていること。
- 本番の注文は試しだけで0件（設計 0-4）。本番では読むだけにし、本番の Stripe は触らない。本番の DB に試しの注文・返品を作らない。

計画4で足す決まり（計画1〜3の決まりと矛盾しない）:

- 新しい移行は計画3と同じ形（最初の行 `BEGIN;`、末尾 assert → `NOTIFY pgrst, 'reload schema';` → `COMMIT;`、`-- ACC_S24_FINAL_ASSERT_BEGIN/END`〜`ACC_S28_…`、失敗は `ACCOUNTING_MIGRATION_ASSERTION_FAILED / 55000` と固定コード `acc_s24_*`〜`acc_s28_*`）。SQL は ASCII、日本語は `U&'\XXXX'` 形。
- **既存の関数を作り直す移行（S24・S27・S28）の守り:** 計画3の Global Constraints「既存の関数を作り直す移行の守り」の①〜⑤をそのまま当てる（最新の定義を1字も変えずに写し、足す所を `-- ACC_P4_BEGIN` 〜 `-- ACC_P4_END` で囲む。移行の assert が囲みを全部除いた本文を最新の定義と比べ、引数・戻り型・属性・ACL・`search_path`・所有者が前と同じことを確かめる。`group_g1_writer_inventory` の書き手の一覧に足すのは、S26 の新しい入口 `private.place_order_with_return_terms` の1本だけ〔77→78本。Task 8〕。ほかの新しい関数は足さない）。**DROP して作り直す関数は無い**（`customer_return_line_states` の戻り型は変えず、新しい小さい関数 `customer_return_defect_lines` を足す。Task 9）。新しい入口 `place_order_with_return_terms`（S26）は新規の関数で、決済の関数 2本の本文は変えない。
- **共通の押さえ（`pg_advisory_xact_lock(190521,1)`）を持つ関数は、`shop_return_settings` の行の鍵を取らない**（新しい入口は「設定の行の共有ロック → 共通の押さえ」の順。逆順の関数を作ると止まる。並行の試験の題に入れる。Task 8）。計画1の鍵の順（①G 共通 → ②会計の鍵 → ③期間ごとの鍵 → ④元の行）との関係: **設定の行は、計画1の④元の行（会計の業務書込の行）に入らない。設定の行の鍵だけは、共通の押さえより先に取る**（今、共通の押さえを持ったまま設定の行の鍵を取る関数は無く、設定の更新〔`order_return_actions.sql:1766`〕は共通の押さえを取らないので、すれ違いで止まらない）。**S24・S28 の移行は、共通の押さえを取ってから設定の行を UPDATE しない**（移行の先頭で共通の押さえを取る形にしない）。
- 決済のファイル（`src/lib/stripe/**`・`src/app/api/webhooks/**`・`src/app/api/checkout/**`・`src/lib/checkout/**`・`src/features/checkout/**`）と決済の DB 関数を触る Task（Task 6・8）の最初の行に「controller が別セッションへ先に知らせる」と書く。**決済の DB 関数（`place_order_from_checkout_draft`）の本文は計画4で1字も変えない**（注文の記録はトリガーで残す）。決済の関数を触る必要が出たら止めて controller に知らせる。決済の試験（G・H）は、トリガーを足した後も無改造で通ることを Task 8 の Step 4 で確かめ、通らない物があれば Task 8 の Files に足して直し、直した試験を一覧表で報告する。
- 返品の route・返品の関数を触る Task（Task 9・10）、設定の route と画面を触る Task（Task 2・11）、共有の文書を直す Task（Task 3・12・13）も、最初の行に同じ「controller が別セッションへ先に知らせる」を置く。
- お客様に見える文の決まり: 穏やかな日本語、絵文字・感嘆符なし。「カード会社からの支払いの取り消し」と書き、「チャージバック」とは書かない（返品の条件の文には出ない見込みだが、試験で語が混ざらないことを固定する）。法令の根拠は設計 14-4 のとおりで、文の確定にオーナーの確認が要る所は「オーナーへの報告」に置く。
- 実装者は単体/型/lint、controller は reset・DB 結合/並行・PostgREST・build/E2E・provider・本番を担当する。計画作成中は Playwright・サーバー・Supabase CLI・Docker・DB 試験・変更系 git・`.env*` の読取をしない。

**共通 verify（後日の controller 手順）:** 計画1〜3の共通 verify と同じ（RED → reset → 既存 `items` 読取 smoke → 対象 DB suite → PostgREST で新 public 入口の service_role 成功/anon・authenticated 拒否）。加えて、作り直した関数を触る既存の suite（各 Task に列挙）を、意図して直した所以外は無改造で流して赤くならないこと。**文の元を保存する並行の試験と PostgREST の試験だけがコミットする試験**で、別の jest 実行で流し、前後に `db reset` する（注文は消せるが、内容で一意の表の行は消せないため）。

## Review Focus

- **5か所が同じ文で、設定から作られる:** 商品ページ・最終確認の画面・特定商取引法の表記・利用規約の第6条・「返品について」のページが、同じ `renderReturnTerms` の出力から作られ、設定を変えると全部変わる。手で書いた旧文が残らない。可否・条件（期限を含む）・送料の負担の3つ、申し込みの方法（アカウントの注文ページ・注文の状況のページ・お問い合わせ）が出て、お問い合わせは誰でも・どの理由でも受ける → Task 1 の `FREQ-585-AC-01`〜`AC-08`・Task 5〜7 の `FREQ-587-AC-01`・`FREQ-588-AC-01`〜`AC-04`・`FREQ-589-AC-01`〜`AC-04`。
- **特約と合わない品が分かれ、合わない品を期限で締めない:** 文で別の節になり、合わない品に「7日を過ぎたら受けない」と「返金はしない」の形が無い。受付の作り（DB・画面）も、破損・不良と注文と違う品は期限を過ぎても受け、サイズなど特約の理由だけ期限で締める。「その他」は返品不可の品にも開き、理由は必須 → Task 1 の `FREQ-585-AC-02`・Task 9 の `FREQ-591-AC-01`〜`AC-05`。
- **期限が文より早く締まらない:** 目安の既定が文の期限（届いてから7日）より早く締めない形になり、人が変えた値は更新しない。特約が正しく出ていない注文（見た版の結びが無い注文）は、法律の8日（届いた日を1日目に数える）と店の期限の遅い方。店の期限（届いた日を数えない）と法律の8日が別の数え方で持たれ、期限を過ぎた画面にお問い合わせの案内が出る → Task 10 の `FREQ-592-AC-01`〜`AC-06`。
- **注文に版が残り、届く順や同時の更新に頼らない:** 注文を作ると同じトランザクションで条件の中身・ハッシュ・日時が残り、後で設定を変えても変わらない。設定を直す人と同時に注文が入っても、記録は確定した状態の1つで、途中の状態にならない。同じ注文に何度付けても1行。画面で見せた版と現在が違えば注文を作らず確認へ戻す → Task 8 の `FREQ-590-AC-01`〜`AC-09`・Task 9 の `FREQ-591-AC-07`・`AC-08`。注文時の品の印も固定し、後の印の変更で前の注文の条件を変えない。
- **帳簿と決済を壊さない:** 仕訳が1本も増えず（14-h）、決済の関数の本文は1字も変わらず、G・H の決済・注文・返品の既存の試験が意図して直した所以外は無改造で通る → Task 8 の `FREQ-590-AC-07`・Task 14 の Step 2。

---

## 設計の行から Task への対応

「計画N」は他の計画が作る物。範囲の外の行は計画番号を書く。

| 設計の行 | 作る Task | 固定する試験 |
| --- | --- | --- |
| 14-a（条件の文は設定から作る。可否・条件・送料・申し込みの方法。期限は数え方つき。お問い合わせは必ず受ける。4か所に別々の手書きを置かない。添える文は設定に1つ） | 1・2・3・4・11 | 585-AC-01・03・04・06、586-AC-01・02、593-AC-01 |
| 14-a2（特約と合わない品を分ける。合わない品は「お気づきの時はお早めに」。店がする事は責任の決めとして書く。返金はしないの形は書かない。素材の風合いは契約の内容の説明として別の所） | 1・7 | 585-AC-02・07、589-AC-01 |
| 14-a3（受付の作りでも合わない品の理由は期限で締めない。期限は特約の理由だけ） | 9 | 591-AC-02〜04 |
| 14-b（全部の品に価格の近くに3つの重要事項とリンク。大きさは価格と同じくらい。返品不可の品の一文も同じ大きさ。全ページのフッターに「返品について」） | 4・5 | 587-AC-01〜04・06 |
| 14-c（最終確認の画面: 品ごとの印・見出しの所の文と送料・リンク・申し込みの方法の条件を画面そのものに・返品不可の品にも相談の窓口） | 6 | 588-AC-01〜06 |
| 14-d（特定商取引法の表記と利用規約の第6条にも同じ文。見出しで分け、規約のほかの条に埋もれさせない） | 7 | 589-AC-01〜04 |
| 14-e（受付の期限は文の期限より早く締まらない。目安の既定を一番長くかかる日数に。期限を過ぎた画面にお問い合わせの案内。追跡オン後は配達の日。法律の8日と店の期限の別の数え方） | 1・10 | 585-AC-03、592-AC-01〜06 |
| 14-f（注文に条件の文の中身・版・日時を残す）と2026-11-05 オーナー決定（品の印も注文時の値） | 3・8・9 | 586-AC-02〜03、590-AC-01〜09、591-AC-07〜08 |
| 14-g（「その他」は特約と別の相談の窓口。特約は言い切り、相談は別に書く。印は品の種類で分ける。返品不可の品にも相談の窓口。A9・A13） | 1・6・9 | 585-AC-05・07、588-AC-04、591-AC-01 |
| 14-h（帳簿の仕訳は変わらない。返品は5章の2段のまま） | 全 Task（仕訳を足さない） | 590-AC-07 |
| 14-1 の「今の作り」5行（最終確認の画面・特定商取引法の表記・利用規約・商品ページ・フッター） | 5・6・7・4 | 587〜589 |
| 14-3 の例5行 | 1（文の例）・5・6・9・10（期限の例） | 585-AC-05、592-AC-01、591-AC-02 |
| 14-5 の比較（受付の作りとの一致・注文に版を残す・届いた日が分からない時の期限） | 1・8・10 | 585-AC-04、590-AC-01、592-AC-01 |
| 16章「届くのに一番長くかかる日数（14-e の目安）」 | 10（暫定値をオーナーへの報告に載せる） | 592-AC-01 |
| 帳簿・5章・15章など他の章 | 計画1〜3・5〜7 | — |

---

## 要求と受入条件（`docs/02_Requirements/requirements.md` の6列の表へ足す文）

計画3の最後の番号は FREQ-584。下表の各行を「要求ID／要求内容／要件ID／要件内容／受入条件ID／受入条件内容」の6列へ展開する。要件 ID は `FREQ-NNN-REQ-01`、AC は同じ番号の `FREQ-NNN-AC-NN`。各 Task は、自分が証明する AC の行を同じコミットで足す（要求管理ルール。会計・返品の要求は `scope.json` の範囲の外なので `requirements.md` に書く）。Task 13 は全部そろっているかの確かめと体裁だけ。

| 要求 | REQ-01 の要件 | AC | 証明する Task |
| --- | --- | --- | --- |
| FREQ-585（返品の条件の文を設定から1つ作る） | 設定（返品の欄・理由ごとの設定・期限）から、特約と合わない品を分けた条件の文・品ごとの印・申し込みの方法を作る部品を1つ持つ | AC-01 可否・条件（期限を含む）・送料の負担・申し込みの方法（アカウントの注文ページ・注文の状況のページ・お問い合わせ）が出る／AC-02 返品の特約と契約の内容に合わない品が別の節で、合わない品に「7日を過ぎたら受けない」も「返金はしない」の形も無く、店がする事は責任の決めとして「まず交換か修理で対応し、できない時は返金します」の形で書く／AC-03 期限は数え方つき（「商品到着の翌日から7日以内」）、日数が空なら「期限なし」／AC-04 設定を変えると文が変わる（受付停止・期限の日数・理由の出す出さない・送料の負担・写真・割合の手数料の行列）／AC-05 品の種類で印が分かれる（ふつうの品「サイズ交換のみ・届いてから7日以内（ほかはご相談ください）」、返品不可の品「返品不可（ご相談可）」）／AC-06 お問い合わせからの申し込みは、ログインしないお客様も・どの理由でも受けると書く／AC-07 特約は「お客様のご都合による返品・交換（サイズ交換を除く）はお受けしません」と言い切り、相談は別の段で「やむを得ない事情がある時はご相談ください。受けられない場合があります」と書く。「原則として」「チャージバック」の語が無い／AC-08 設定の組み合わせで文が読めなくなる時（説明と違うを出す・受付停止なのに理由が出るなど）は警告を返す | 1 |
| FREQ-586（文の元を DB で持つ） | 文に効く設定を1本の SELECT で正規の jsonb とハッシュにして読み、内容で一意の追記専用の表に控え、添える文の欄を設定に持つ | AC-01 添える文（500字まで）を更新でき、更新者・日時が残る。どの設定の更新も設定の行の鍵を先に取る／AC-02 読み口は返送先・更新者・個人情報を含まず、同じ設定は同じハッシュ・違う設定は違うハッシュ／AC-03 文の元・文の控え・注文の記録の表は追記専用で、anon・authenticated に権限が無く service_role は SELECT だけ／AC-04 文の控えの登録は何度でも同じ結果で、現在の設定と合わないハッシュは断る／AC-05 公開の読み口は認証なしで読め、個人情報を含まない／AC-06 設定の既存の試験が意図して直した所以外は通る | 2・3・4 |
| FREQ-587（商品ページ・フッター・返品についてのページ） | 全部の品に価格の近くに返品の3つの重要事項とリンクを出し、全ページのフッターに「返品について」を置き、返品の条件の所へ直接開く | AC-01 全部の品の価格の近くに、返品できるか・条件（期限を含む）・送料の負担の3つとリンクが出る／AC-02 一文の大きさが価格の大きさ以上／AC-03 返品不可の品は「返品不可（ご相談可）」と送料の負担が出て、同じ大きさ／AC-04 フッターの「返品について」が全ページ（決済の画面も）に出て、押すと返品の条件の所へ直接開く／AC-05 「返品について」のページが生成した文の全部の節を出す／AC-06 390/768/1280px で崩れない／AC-07 文を取れなくても商品ページは崩れず、返品についてのページへのリンクだけ出す | 4・5 |
| FREQ-588（最終確認の画面の返品の印） | 品ごとの行に返品の印、見出しの所に同じ文と送料の負担とリンク、申し込みの方法の条件を画面そのものに出す | AC-01 品ごとの行に印が出て、ふつうの品と返品不可の品（送料の負担つき）で分かれる／AC-02 「返品について」の所に同じ文・送料の負担・リンクが出る／AC-03 写真の決まりなど申し込みの方法に付く条件が、リンクの先でなく画面そのものに出る／AC-04 返品不可の品にも相談の窓口が出る／AC-05 文を取れない時は「注文する」を押せず、再読み込みの案内が出る／AC-06 390/768/1280px で崩れない | 6 |
| FREQ-589（特定商取引法の表記と利用規約に同じ文） | 特定商取引法の表記と利用規約の第6条に同じ文を差し込み、見出しで分ける | AC-01 特定商取引法の表記の「返品・交換・キャンセルについて」が生成した文と一致する／AC-02 利用規約の第6条が「返品に関するお知らせ」の見出しで分かれ、同じ文を出す／AC-03 商品ページ・最終確認・特定商取引法・規約・返品についてのページの文の段落が一致する／AC-04 旧い手書きの文がソースに残らない | 7 |
| FREQ-590（注文に返品の条件の版と品の印を残す） | 注文を作ると、その時の条件の中身・ハッシュ・日時と返品不可の品の番号の一覧を同じトランザクションで追記専用の表に残し、見た版を結ぶ | AC-01 注文を作ると同じトランザクションで中身・ハッシュ・日時が残る／AC-02 後で設定を変えても既存の注文の記録は変わらず、新しい注文は新しい記録／AC-03 設定を直す人と同時に注文が入っても、記録は確定した状態の1つ（途中の状態にならない）。比べた後・注文を作る前に設定が変わる隙が無く、見た版と違う条件の注文は通らない／AC-04 新しい入口で注文すると見た版が同じトランザクションで結ばれ、同じ決済の画面の再送は既存の注文を返し、見た版と現在が違えば注文を作らず記録も残さない／AC-05 画面で見た版と現在が違えば注文を作らず確認へ戻り、応答の今の文で1回の押し直しで注文できる（決済の画面は閉じない）／AC-06 追記専用で、注文を作った関数が失敗すれば記録も残らない。直接作る注文・照合の道の注文はトリガーが失敗しても作られ、新しい入口は記録が無ければ注文ごと取り消す。照合の道の注文は見た版の結びが無い／AC-07 仕訳が1本も増えず、決済の関数の本文は変わらない／AC-08 新しい入口が注文時に返品不可の印のある品の番号を DB から読み、画面が送った一覧と比べて同じだった物を注文ごとに固定して残す。印のある品が無ければ空の一覧で、再送でも上書きしない／AC-09 最終確認で見せた返品不可の品の番号の一覧を入口へ送り、同じトランザクションで注文を作る前に今の印と比べる。違えば注文を作らず `return_terms_changed` で確認へ戻り、文と品の印を更新する。比べた後に管理画面で印が変わっても、注文には比べて同じだった一覧を残し、お客様に見せた条件で受ける | 8 |
| FREQ-591（受付の作りを文に合わせる） | 返品不可の判定は注文時の記録で行い、返品不可の品にも「その他」を開き、破損・不良と注文と違う品は期限で締めない | AC-01 返品不可の品でも「その他」を選べ、詳しい内容は必須／AC-02 破損・不良と注文と違う品は期限を過ぎても申し込める／AC-03 サイズなど特約の理由は今のとおり期限で締まる／AC-04 期限後の画面は破損・不良・注文と違う品だけ選べ、案内が出る。期限切れの行だけの注文でも申し込みのボタンが出て、受付を終了しましたの文は出ない（アカウントの画面と注文の状況のページ）／AC-05 数が足りない品は申し込みの理由に無いので、お問い合わせの案内が出る／AC-06 管理画面のお断りで、破損・不良・注文と違う品の申し込みに「期限を過ぎているため」を選ばせない／AC-07 注文後に品の印を付けても外しても、受付・申し込み画面と、管理画面の材料・詳細の警告の印は注文時の値でそろい、返品不可の品も相談の窓口は開く／AC-08 印の記録が無い注文（照合の道・直接作る注文を含む）は「返品不可でない」とし、今の品の印へ戻って判定しない | 9 |
| FREQ-592（受付の期限が文より早く締まらない） | 目安の既定を届くのに一番長くかかる日数にし、見た版の結びが無い注文は法律の8日と店の期限の遅い方にし、記録のある注文は注文の時の日数で締め、遅れの案内を出す | AC-01 発送の日＋目安で届いた日とみなす時、文の期限（届いてから7日）より早く締まらない（10/10 発送・10/15 着・10/21 の申し込みが通る）／AC-02 目安は3日のままの時だけ更新し、人が変えた値は変えない／AC-03 見た版の結びが無い注文（記録の無い注文・照合の道の注文）は、法律の8日（届いた日を1日目）と店の期限の遅い方。結びのある注文は店の期限のまま／AC-04 店の期限（届いた日を数えない。10/15 着なら 10/22）と法律の8日（10/15 着なら 10/22 の23:59:59 まで。同じ日だが数え方が別）を別の部品で持つ／AC-05 期限を過ぎた画面に、届くのが遅れた時のお問い合わせの案内が出る／AC-06 配達の日（追跡）があればそちらで数える／AC-07 記録のある注文の期限の日数と数え始めは、注文の時の記録から読む（注文の後に店が日数を変えても、約束した期限で締まる） | 10 |
| FREQ-593（設定の画面で添える文を直し、文を確かめる） | 返品の設定の画面に添える文の欄とプレビューと警告を足す | AC-01 添える文を編集でき、権限が無い人は保存できない／AC-02 プレビューが公開の文と同じ／AC-03 警告が出る／AC-04 390/768/1280px で崩れない | 2・11 |

---

### Task 1: 条件の文を作る部品（純粋な TS）と、期限の数え方の部品

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-585 の6列の行）
- Create: `src/lib/orders/returns/return-terms.ts`（`RETURN_TERMS_TEMPLATE_VERSION`・型・`renderReturnTerms`・`describeReturnTermsWarnings`）、`src/lib/orders/returns/return-terms-types.ts`、`tests/unit/lib/orders/returns/return-terms.test.ts`、`tests/unit/lib/orders/returns/return-terms-matrix.test.ts`
- Modify: `src/lib/orders/returns/return-calc.ts`（`shopReturnDeadline`・`statutoryReturnDeadline` を足す）、`tests/unit/lib/orders/returns/return-calc.test.ts`
- Read: `src/lib/orders/returns/return-types.ts`（`RETURN_REASONS`・`ShopReturnSettings`）、`src/lib/orders/returns/return-calc.ts`（`formatDeadline`）、`src/lib/orders/returns/return-messages.ts`（`RETURN_REASON_LABELS`）、`src/app/legal/page.tsx:110-140`、`src/app/terms/page.tsx:129-135`、`src/app/checkout/_components/FinalConfirmationStep.tsx:416-424`、`src/app/item/[id]/ItemDetailClient.tsx:910-921`（今の手書きの文。意味を落とさないための写し元）、設計 14-2・14-3・14-4

**Interfaces:**
- Consumes: なし（I/O なし。DB を呼ばない）。
- Produces（型。`return-terms-types.ts`）:
  - `ReturnTermsInputs`: `{ v: 1; requestsEnabled: boolean; requestTypes: 'returns_and_cancellations'|'returns_only'|'cancellations_only'; windowDays: number|null; windowStart: 'each_item'|'last_item'; customerPaidMethod: 'customer_ships'|'shop_label'; noReturnNeededEnabled: boolean; restockingFeePercent: number|null; contractNote: string; reasons: Array<{reason: ReturnReason; shown: boolean; resolutions: 'refund_and_exchange'|'exchange_only'|'refund_only'; outOfStockExchange: 'make'|'decline'; photo: 'none'|'optional'|'required'; photoInstructions: string; shippingPayer: 'shop'|'customer'}> }`。`reasons` は `reason` の昇順。`restockingFeePercent` は手数料が有効の時だけ数、そうでなければ `null`。DB の `private.return_terms_inputs()`（Task 3）の出力と同じ形（試験で固定）。
  - `ReturnTermsView`: `{ templateVersion: number; headline: string; special: ReturnTermsSection; mismatch: ReturnTermsSection; howToApply: ReturnTermsSection; consult: ReturnTermsSection; contractNote: ReturnTermsSection | null; marks: { standard: string; ineligible: string }; shippingLine: string; ineligibleShippingLine: string; deadlineRule: string; photoRules: string[]; links: { detail: '/returns'; contact: '/contact' }; warnings: ReturnTermsWarning[] }`、`ReturnTermsSection = { heading: string; paragraphs: string[]; items: string[] }`、`ReturnTermsWarning = { code: 'size_reasons_hidden'|'not_as_described_shown'|'requests_disabled_with_reasons'|'window_unlimited'|'shop_label_with_customer_payer'; message: string }`。
- Produces（関数）:
  - `renderReturnTerms(inputs: ReturnTermsInputs): ReturnTermsView`。純粋で、同じ入力は同じ出力（試験で2回比べる）。`RETURN_TERMS_TEMPLATE_VERSION = 1`。
  - `shopReturnDeadline(arrivalDate: string, windowDays: number|null): string|null`（YYYY-MM-DD。**届いた日を数えない**＝届いた日の翌日から `windowDays` 日。`windowDays` が `null` なら `null`。民法140条。10/15 着・7日なら 10/22）。
  - `statutoryReturnDeadline(arrivalDate: string): string`（YYYY-MM-DD。**届いた日を1日目に数える**＝届いた日＋7日。特定商取引法15条の3 1項「引渡しを受けた日から起算して八日」。10/15 着なら 10/22。数え方が別なので別の関数にし、「同じ日になることがある」ことを試験の題で示す）。
  - `describeReturnTermsWarnings(inputs): ReturnTermsWarning[]`（`renderReturnTerms` の `warnings` と同じ。画面のプレビューが同じ物を使う）。
- 文の作り方（規則表。試験の行列で固定する。文言は設計 14-2・14-3 のとおりで、確定にオーナーの確認が要る所は「オーナーへの報告」）:
  - **見出しと節:** `headline`＝「返品について」。節は ①「返品の特約」（お客様のご都合による返品・交換）、②「契約の内容に合わない品」（破損・不良・ご注文と違う品・数が足りない品）、③「お申し込みの方法」、④「ご相談」、⑤添える文（`contractNote` が空でない時だけ。見出しは「素材の風合いなどについて」。契約の内容の説明であり、返品の特約とは別の節〔14-a2〕）。節①の特約の条件の列は `items` に入れる（中-7）: 「商品到着の翌日から◯日を過ぎたもの」（`windowDays` から作る。「商品到着後7日以上経過したもの」の手書きは使わない。数え方を文の中の期限〔届いた日を数えない〕とそろえる。`windowDays=null` なら行を出さない）に続けて、「お客様が一度ご使用になったもの」「お客様が破損・汚損されたもの」「お客様が加工・修理されたもの」「商品の箱・タグ・説明書などの付属品を汚損・破損・紛失された場合」（今の `legal/page.tsx:122-131` の4行を1字も変えずに移す）。この列は節①（サイズ交換など特約の理由）にだけ付け、節②には付けない。節④には「相談の申し込みの受付期間を過ぎた後も、お問い合わせからご相談いただけます」の1文を足す（小-8。『その他』は期限で締まり、期限の後はお問い合わせで受ける）。
  - **①返品の特約:** 特約は言い切る。標準の設定（サイズ2種が `exchange_only`・出す、色・デザイン・不要・説明と違うは出さない）では、「お客様のご都合による返品・交換（サイズ交換を除く）はお受けしません。」「サイズ交換は、商品到着の翌日から7日以内に、タグの付いた未使用の品に限ってお受けします。」（在庫が無い時は `outOfStockExchange='decline'` なので「在庫がない時はお受けできません」を添える。`make` なら「在庫がない時はお作りしてお送りします」）。期限は数え方つき（`windowStart='each_item'` は「商品到着の翌日から◯日以内」、`last_item` は「複数回に分けてお届けする場合は、最後の品の到着の翌日から◯日以内」）。`windowDays=null` は「期限は設けていません」。`restockingFeePercent` があれば「返金の際は、お支払いの額から◯%を差し引きます」。送料は「返送の送料は、サイズ交換など特約の理由ではお客様のご負担です」（`shippingPayer` が理由ごとに違う時は理由ごとに書く）。**「原則として」は使わない**（14-4「原則と店が決めるを合わせると条件が読めない」）。
  - **②契約の内容に合わない品:** 「破損・不良・ご注文と違う品・数が足りない品は、お気づきの時はお早めにご連絡ください。」「まず交換か修理で対応し、できない時は返金します。」（`defective`・`wrong_item` の `shippingPayer='shop'` なら「送料は当店が負担します」）。**期限の打ち切り（「7日を過ぎたら受けない」）と「返金はしない」の形は書かない**（試験で語を探して0件を固定）。
  - **③お申し込みの方法:** 「アカウントのご注文ページ、またはご注文の状況のページからお申し込みいただけます。」「お問い合わせからも、ログインなしで、どの理由でもお申し込みいただけます。」（`contact` へのリンク）。写真が必要な理由（`photo='required'`）は、`photoRules` に「◯◯の場合は、写真をお送りください（`photoInstructions`）。」を1行ずつ入れる。
  - **④ご相談（14-g）:** `other` が `shown` の時だけ。「やむを得ない事情がある時はご相談ください。受けられない場合があります。」を、特約と**別の段**に書く（「特約」の節の文に混ぜない）。
  - **印（`marks`）:** `standard`＝ふつうの品。標準の設定では「サイズ交換のみ・届いてから7日以内（ほかはご相談ください）」。サイズの理由が返金も許す設定なら「サイズ違いは返品・交換可・届いてから7日以内（ほかはご相談ください）」、サイズの理由を出さない設定なら「お客様のご都合の返品・交換不可（ご相談可）」。`windowDays=null` なら「届いてから7日以内」を「期限なし」に変える。`ineligible`＝返品不可の品。「返品不可（ご相談可）」（`other` を出さない設定では「返品不可」）。受付停止（`requestsEnabled=false`）なら両方「返品・交換の受付は停止中です」。
  - **`shippingLine`:** 「送料はお客様負担」（特約の理由）。**`ineligibleShippingLine`（返品不可の品の印に添える。14-3 の5行目。中-6）:** 「ご相談の上で受けた場合の送料は、内容に応じてご案内します。破損・不良・ご注文と違う品の送料は当店が負担します」。合わない品の送料負担は節②に書く。
  - **`warnings`:** `size_reasons_hidden`（サイズの理由が両方 `shown=false` なのに印は「サイズ交換のみ」を出さない旨）、`not_as_described_shown`（「説明と違った」を出す設定。特約でなく合わない品の扱いになるかの確認を促す。未確認事項 #6）、`requests_disabled_with_reasons`（受付停止なのに理由が出る設定）、`window_unlimited`（日数が空）、`shop_label_with_customer_payer`（`customer_paid_method='shop_label'` でお客様負担の理由がある設定。送り状の費用が0に固定されているため。未確認事項 #7）。
- 計画3の固定との関係: 定額の返送料・交換の手数料は `inputs` に入らず、文に出ない。

- [ ] **Step 1: 失敗する試験を書く。** 単体: `FREQ-585-AC-01: 標準の設定で可否・条件・送料の負担・申し込みの方法が出る`、`FREQ-585-AC-02: 合わない品の節に7日の打ち切りも返金はしないの形も無い`、`FREQ-585-AC-02: 店がする事は先に交換か修理で、できない時は返金すると書く`、`FREQ-585-AC-03: 期限は商品到着の翌日から7日以内と数え方つきで書き、日数が空なら期限なしと書く`、`FREQ-585-AC-03: 複数回に分けて届ける場合は最後の品の到着の翌日から数えると書く（last_item）`、`FREQ-585-AC-04: 設定を1つずつ変えると文が変わる行列`（`return-terms-matrix.test.ts`。受付停止・日数の変更・日数が空・サイズ理由を返金も許す・サイズ理由を出さない・在庫が無い時の作る／受けない・送料の負担の違い・写真の必須・割合の手数料・添える文・`other` を出さない、の各行で期待の文字が変わること）、`FREQ-585-AC-05: ふつうの品と返品不可の品で印が分かれる`、`FREQ-585-AC-06: お問い合わせはログインなしでどの理由でも受けると書く`、`FREQ-585-AC-07: 特約は言い切りで相談は別の段に書き、原則としてとチャージバックの語が無い`、`FREQ-585-AC-08: 警告が組み合わせごとに出る`、`FREQ-585-AC-04: 同じ入力は同じ出力（2回描いて等しい）`、`FREQ-592-AC-04: 店の期限は届いた日を数えず、法律の8日は届いた日を1日目に数える（10/15 着なら どちらも 10/22 になる別の関数）`、`FREQ-592-AC-04: 月末・年またぎ・閏日の数え方`、`FREQ-585-AC-01: DB の inputs と同じ形のキーだけを受ける（余計なキーを無視する）`、`FREQ-585-AC-04: 特約の条件の列の期限の行の日数が windowDays で変わり、日数が空なら出ない`、`FREQ-585-AC-02: 節②に特約の条件の列（商品到着後◯日を過ぎたもの）が付かない`、`FREQ-585-AC-05: 返品不可の品の印に送料の一文が付く`、`FREQ-585-AC-07: 節④に相談の受付期間の後はお問い合わせで受けると書く`。
- [ ] **Step 2（controller）: RED を測る。** `npx.cmd jest tests/unit/lib/orders/returns/return-terms.test.ts tests/unit/lib/orders/returns/return-terms-matrix.test.ts tests/unit/lib/orders/returns/return-calc.test.ts --runInBand`。ファイルが無い失敗を記録する。
- [ ] **Step 3: 実装する。** Interfaces の規則表のとおり。文言は定数を1か所に置き、`renderReturnTerms` 以外の場所に文を書かない。`RETURN_TERMS_TEMPLATE_VERSION` を上げる条件（文言・節・印の作り方を変えた時）をファイル先頭のコメントに書く。
- [ ] **Step 4: GREEN を測る。** 単体、型、lint。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(returns): 返品の条件の文を設定から作る部品を追加する`

### Task 2: 設定に「添える文」の欄を足し、設定の読み書きを直す

controller が別セッションへ `ShopReturnSettingsSection.tsx`・`src/app/api/admin/settings/shop/route.ts`・`docs/06_Operations/db-migrations.md` の変更を先に知らせる。計画3 Task 2・11 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-586 の AC-01 の行・FREQ-593 の AC-01 の行を、同じコミットで6列の表へ足す）
- Create: `supabase/migrations/<ts24>_accounting_p4_return_terms_settings.sql`、`tests/integration/db/accounting_p4_return_terms_settings.integration.test.ts`、`tests/integration/db/accounting_p4_migration_asserts.integration.test.ts`
- Modify: `src/lib/orders/returns/return-types.ts`（`ShopReturnSettings` に `contractNote`・`termsUpdatedAt`・`termsUpdatedBy`）、`src/lib/orders/returns/return-store.ts`（`getShopReturnSettings`・`updateShopReturnSettings`）、`src/app/api/admin/settings/shop/route.ts`（`returns` の zod は strict のまま `contractNote: z.string().max(500)` を足す）、`tests/unit/lib/orders/returns/return-store.test.ts`、`tests/unit/api/admin/shop-settings-route.test.ts`
- Test: 上の DB 2 suite と単体、既存の返品の設定の suite（`order_return_records`・`order_return_actions`・`group_g1_return_requests` のうち設定を読む所）
- Read: `supabase/migrations/20261012235910_order_return_records.sql:462-546`（設定の2表）、`20261012235910_order_return_records.sql:1147,1284-1288`（`get_shop_return_settings`）、`20261013000456_order_return_actions.sql:1725-2110`（`admin_update_shop_return_settings`。private 版は無く public だけ）、および `get_shop_return_settings`・`admin_update_shop_return_settings`。**最新の定義は後の移行にあるか `grep -n "FUNCTION public.admin_update_shop_return_settings\|FUNCTION public.get_shop_return_settings\|FUNCTION private.admin_update_shop_return_settings" supabase/migrations/*.sql` で確かめる**）、`src/app/legal/page.tsx:136`（素材の風合いの文。初期値に1字も変えずに移す）、`tests/integration/db/h5_function_baseline` を使う試験（`group_h_migration_asserts`）

**Interfaces:**
- Consumes: 計画3 S16 の設定の CHECK（変えない）、`shop_return_settings` の「まとまりごとの更新者・日時」の流儀。
- Produces（列）: `shop_return_settings.contract_note text NOT NULL DEFAULT '' CHECK (char_length(contract_note) <= 500)`、`terms_updated_at timestamptz`、`terms_updated_by uuid`（外部キーにしない）。**既存の `notice_text`（≤2000字。申し込みの注意書き）とは別の欄**（14-a2「素材の風合いは返品の特約と別の所」。未確認事項 #5）。
- Produces（DML）: 設定の1行の `contract_note` を、`src/app/legal/page.tsx:136` の素材の風合いの文（1字も変えない）に更新する。条件は `WHERE id = 1 AND contract_note = ''`（人がすでに入れていれば変えない）。本文は `scripts/accounting/emit-labels.ts` と同じ道（TS の定数から `U&'\XXXX'` を出して貼る）で作り、試験が TS の定数と一致を確かめる。移す元の文は「これらを理由とする返品・交換はご容赦ください」と返品を断る言い方を含み、14-a2 の「契約の内容の説明」と合わないので、**文の確定の対象**（未確認事項 #2・オーナーへの報告）。S24 は今の文を1字も変えずに入れ、書き直しが決まれば初期値だけを変える。
- Produces（関数）: `get_shop_return_settings()` の戻りに `contractNote`・`termsUpdatedAt`・`termsUpdatedBy` を足す。`admin_update_shop_return_settings(_settings jsonb, _actor_id uuid)` に、まとまり `terms`（`{contractNote}`）を足し、権限は今のとおり `admin.settings.manage`（新しい権限は足さない）。どちらも最新の定義を1字も変えずに写し、足す所を `-- ACC_P4_BEGIN` 〜 `-- ACC_P4_END` で囲む。**`admin_update_shop_return_settings` は、今の定義がすでに理由の表を直す前に `SELECT … FOR UPDATE` で設定の行の鍵を取っている（`20261013000456_order_return_actions.sql:1766`、理由の表の更新は `:1887`）。その鍵をそのまま使い、足さない**（二重にしない。Task 8 の新しい入口の共有ロックと順番を決める。理由の設定の表だけを直す更新も同じ鍵を通ることを試験で確かめる）。
- Produces: S24 assert DETAIL `acc_s24_column`・`acc_s24_functions_unchanged_outside_markers`・`acc_s24_acl`・`acc_s24_initial_note`・`acc_s24_existing_dml_allowlist`（DML は設定の1行だけ）。

- [ ] **Step 1: 失敗する試験を書く。** DB は ROLLBACK の形。`FREQ-586-AC-01: 添える文の列は500字を超えると入らない`、`FREQ-586-AC-01: 設定の更新で添える文が変わり、更新者と時刻が残る`、`FREQ-586-AC-01: 添える文だけを送っても、ほかのまとまりの更新者と時刻は変わらない`、`FREQ-586-AC-01: 権限が無い人は更新できない（今のとおり admin.settings.manage）`、`FREQ-586-AC-01: 初期値は素材の風合いの文で、すでに入っていれば変えない`、`FREQ-586-AC-06: 設定を読む関数の既存の戻りのキーは変わらず、3つのキーが増える`、`FREQ-586-AC-01: 理由の設定の表だけを直す更新も、設定の行の鍵を先に取る（別の接続が設定の行を共有ロックしている間は待つ）`（今の関数ですでに成り立つ回帰の試験で、RED を求めない）。単体: `FREQ-586-AC-01: 設定の route の zod は添える文を501字で400にする`、`FREQ-586-AC-01: store は contractNote を読み書きする`。
- [ ] **Step 2（controller）: RED を測る。** DB 2 suite と単体。列が無い失敗を記録し、接続の失敗を RED に数えない。
- [ ] **Step 3: S24 と TS を実装する。** 作り直す2関数の最新の定義を一字も変えずに写し、囲みの外が変わっていないことを assert が確かめる。H5 の基準（`h5_function_baseline`）の対象に入っていれば、Task の Files に基準の試験を足して直し方を報告する。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify。末尾 assert を SAVEPOINT 内で、列欠落・関数の本文の改ざん・ACL の改ざんを1つずつ入れて流し、55000 と対応 DETAIL を検査する。`order_return_records`・`order_return_actions`・`group_g1_return_requests`・`group_h_migration_asserts` が、意図して直した所以外は無改造で通る。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(returns): 返品の設定に添える文の欄を足す`

### Task 3: 文の元の読み口・内容で一意の表・公開の読み口

controller が別セッションへ `docs/06_Operations/db-migrations.md`・`docs/03_BasicDesign/data/er.md` の更新を先に知らせる。Task 2 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-586 の AC-02〜05 の行）
- Create: `supabase/migrations/<ts25>_accounting_p4_return_terms_tables.sql`、`tests/integration/db/accounting_p4_return_terms_tables.integration.test.ts`、`tests/integration/db/accounting_p4_return_terms_concurrency.integration.test.ts`、`tests/integration/db/accounting_p4_return_terms_postgrest.integration.test.ts`、`scripts/accounting/emit-return-terms-fixture.ts`（`inputs` の見本を TS から出し、DB の出力と比べる試験の元にする）
- Modify: `tests/integration/db/accounting_p4_migration_asserts.integration.test.ts`、`tests/integration/db/group_g2_public_function_acl.integration.test.ts`（公開の関数の一覧に2本を足す。**意図して直す期待はこの一覧だけ**）
- Read: `supabase/migrations/20261012235910_order_return_records.sql:330-360`（追記専用のトリガーの形）、計画3 Task 1 の `reject_accounting_mutation` の使い方、`tests/integration/db/helpers/local-db.ts`

**Interfaces:**
- Consumes: S24 の設定、計画1 S2 の `private.reject_accounting_mutation()`（追記専用のトリガー。UPDATE・DELETE・TRUNCATE を断る）。
- Produces（関数）:
  - `private.return_terms_inputs() RETURNS jsonb`（`STABLE`、SECURITY DEFINER、`search_path=''`）。**1本の SELECT**（`shop_return_settings` と `shop_return_reason_settings` を1つの文で読み、`jsonb_build_object` と `jsonb_agg(... ORDER BY reason)` で組む）。Interfaces の `ReturnTermsInputs` と同じキー・同じ型（`v=1`）。1本の文なので、設定を直す人が2つの表を別々に更新している途中でも、途中の状態を読まない。返送先・更新者・日時・目安の日数・定額の手数料・検品は含めない。
  - `private.return_terms_hash(_inputs jsonb) RETURNS text`（`IMMUTABLE`。`encode(sha256(convert_to(_inputs::text, 'UTF8')), 'hex')`。jsonb の文字列化はキーの並びが決まっているので、同じ内容は同じ文字列）。
  - `public.get_return_terms_inputs() RETURNS jsonb`（入口。`{inputs, inputsHash}` を返し、あわせて `public.return_terms_snapshots` に `INSERT ... ON CONFLICT (inputs_hash) DO NOTHING` で控える。service_role だけ EXECUTE）。
  - `private.publish_return_terms_rendering(_inputs_hash text, _template_version integer, _rendered jsonb) RETURNS jsonb`（SECURITY DEFINER）と同名同引数の public 入口（service_role だけ）。**現在の `private.return_terms_hash(private.return_terms_inputs())` が `_inputs_hash` と同じ時だけ**控える（違えば `{status:'stale'}`。TS が作った文が現在の設定の物だと保証するため）。`_rendered` の形は `ReturnTermsView` の jsonb（`templateVersion` が `_template_version` と同じことを確かめる）。同じ `(inputs_hash, template_version)` は `ON CONFLICT DO NOTHING` で `{status:'exists'}`（先の1行を残し、後からの内容では上書きしない）。戻りは `{status:'created'|'exists'|'stale'}`。
- Produces（表。すべて `public`、RLS 有効、所有者 postgres、PUBLIC/anon/authenticated に権限なし、service_role は SELECT のみ。書くのは private 関数。追記専用は `reject_accounting_mutation` を UPDATE/DELETE/TRUNCATE に付ける）:
  - `return_terms_snapshots(inputs_hash text PRIMARY KEY CHECK (inputs_hash ~ '^[0-9a-f]{64}$'), inputs jsonb NOT NULL CHECK (jsonb_typeof(inputs) = 'object' AND inputs->>'v' = '1'), first_seen_at timestamptz NOT NULL DEFAULT now(), CHECK (inputs_hash = private.return_terms_hash(inputs)))`（内容で一意。ハッシュと中身が合わない行は入らない）。
  - `return_terms_renderings(inputs_hash text NOT NULL REFERENCES return_terms_snapshots(inputs_hash) ON DELETE RESTRICT, template_version integer NOT NULL CHECK (template_version >= 1), rendered jsonb NOT NULL CHECK (jsonb_typeof(rendered) = 'object'), rendered_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (inputs_hash, template_version))`。
- Produces: S25 assert DETAIL `acc_s25_tables`・`acc_s25_constraints`・`acc_s25_immutable`・`acc_s25_rls_acl`・`acc_s25_functions`・`acc_s25_existing_dml_allowlist`（DML は無い）。
- 注意: `order_return_terms`・`order_return_terms_shown`（注文の記録）は Task 8 の S26 で作る。

- [ ] **Step 1: 失敗する試験を書く。** DB は ROLLBACK の形（PostgREST と並行だけコミット）。`FREQ-586-AC-02: 読み口は inputs とハッシュを返し、返送先・更新者・日時・個人情報を含まない`、`FREQ-586-AC-02: 同じ設定は同じハッシュ、理由の設定を1つ変えると違うハッシュ`、`FREQ-586-AC-02: inputs のキーと型は TS の ReturnTermsInputs と同じ`（`emit-return-terms-fixture.ts` の出力と比べる）、`FREQ-586-AC-02: 目安の日数と定額の手数料と検品を変えてもハッシュは変わらない`、`FREQ-586-AC-03: 3つの表は anon と authenticated に権限が無く service_role は SELECT だけ`、`FREQ-586-AC-03: 控えの表は UPDATE・DELETE・TRUNCATE を断る`、`FREQ-586-AC-03: ハッシュと中身が合わない行は入らない`、`FREQ-586-AC-04: 現在の設定のハッシュなら文の控えが登録され、2回目は exists で内容を上書きしない`、`FREQ-586-AC-04: 現在と違うハッシュの登録は stale で何も残さない`、`FREQ-586-AC-04: 文の版が違えば同じハッシュに2行できる`、`FREQ-586-AC-05: PostgREST で service_role は読め、anon と authenticated は拒否される`、並行（別の jest 実行）`FREQ-586-AC-02: 設定を直すトランザクションが未コミットの間、読み口は直す前の状態を返し、コミット後は直した後の状態を返す（途中の状態を返さない）`、`FREQ-586-AC-04: 同じ登録を同時に20回流しても1行`。
- [ ] **Step 2（controller）: RED を測る。**
- [ ] **Step 3: S25 を実装する。** Interfaces どおり。`inputs_hash` の CHECK が `private.return_terms_hash` を呼ぶので、関数を先に作る。SQL は ASCII。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify。PostgREST 3連続、並行3連続。末尾 assert を SAVEPOINT 内で、RLS 無効・追記専用トリガー無効・CHECK 欠落を1つずつ入れて流して 55000 を確かめる。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(returns): 返品の条件の元を内容で一意に控える表と読み口を追加する`

### Task 4: 公開の route・読み込みの部品・「返品について」のページ・フッターのリンク

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-587 の AC-04・05・07 の行）
- Create: `src/lib/orders/returns/return-terms-store.ts`（`loadReturnTerms(supabase)`: `get_return_terms_inputs` → `renderReturnTerms` → `publish_return_terms_rendering`。控えが既にあれば登録を省く）、`src/app/api/return-terms/route.ts`（GET。公開）、`src/lib/orders/returns/use-return-terms.ts`（クライアントの読み込みの部品。取得中・失敗・成功の3状態）、`src/components/ReturnTermsBlock.tsx`（節を描く共通の部品。商品ページ・最終確認・`/returns` が使う）、`src/app/returns/page.tsx`（「返品について」）、`tests/unit/lib/orders/returns/return-terms-store.test.ts`、`tests/unit/api/return-terms-route.test.ts`、`tests/unit/components/ReturnTermsBlock.test.tsx`、`tests/unit/app/returns-page.test.tsx`
- Modify: `src/components/Footer.tsx`（リンクを1つ足す）、`tests/unit/components/Footer.test.tsx`（無ければ作る）
- Read: `src/app/api/items/[id]/route.ts`（公開 route の形）、`src/lib/request-ip.ts`・`@/lib/rate-limit` の `enforceRateLimit`、`@/lib/http/no-store`、`src/contexts/Providers.tsx:42`（フッターは全ページ・決済の画面にも出る）、`src/app/legal/page.tsx`（ページの外枠・見出しの流儀）

**Interfaces:**
- Consumes: Task 1 の `renderReturnTerms`・Task 3 の公開の読み口と登録。
- Produces（route）: `GET /api/return-terms`。認証なし。**IP の回数制限**（`getClientIp`。計画1の順序のうち認可・CSRF は読み取りなので省く）。成功は `200 {terms: ReturnTermsView, ref: {inputsHash: string, templateVersion: number}}`、`Cache-Control: public, s-maxage=30, stale-while-revalidate=60`（短いキャッシュ。商品ページ・特定商取引法の表記向け。**最終確認の画面は `?fresh=1` を付けて取り、その時は `Cache-Control: no-store`**。見た版と現在の比べは place-order の入口〔Task 8〕が行い、断りの応答にも今の文と `ref` を載せるので、キャッシュが古くても押し直しが続かない）。失敗は `503 {error:'return_terms_unavailable'}` と `Cache-Control: no-store`。応答に返送先・更新者・日時・個人情報を含めない（試験で固定）。クライアントは非 ok の応答の本文を読み切るか `response.body?.cancel()` を await する。
- Produces（ページ）: `/returns`（サーバー側で `loadReturnTerms` を呼び、`export const revalidate = 60` を書き、`ReturnTermsBlock` で全部の節を描く。見出し「返品について」。各節に `id`（`returns-special`・`returns-mismatch`・`returns-apply`・`returns-consult`）を付け、フッターのリンクは `/returns` へ開く）。取得に失敗した時は、「ただいま読み込めません。お問い合わせからご相談ください」と `/contact` へのリンクだけを出す（手で書いた条件の文は置かない）。`metadata` に `title: 返品について`。
- Produces（フッター）: 右下のリンク群に「返品について」（`href="/returns"`）を、`Legal Notice` の前に足す。全ページ（決済の画面も）に出る。
- 注意: `ReturnTermsBlock` は節の `paragraphs`・`items`・`photoRules` を `<p>`・`<ul>` に描くだけで、文を持たない。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-587-AC-05: 返品についてのページが生成した文の全部の節を出す`、`FREQ-587-AC-05: 取得に失敗するとお問い合わせへのリンクだけを出し、手で書いた条件の文を出さない`、`FREQ-586-AC-05: route は認証なしで200を返し、応答に返送先と更新者と個人情報のキーが無い`、`FREQ-586-AC-05: 回数の制限を超えると429で、本文を読み切れる`、`FREQ-586-AC-05: 取得に失敗すると503でno-store`、`FREQ-586-AC-05: fresh を付けるとno-storeで、付けないとs-maxageが付く`、`FREQ-586-AC-04: 控えが無ければ登録し、あれば登録を省く`、`FREQ-587-AC-04: フッターに返品についてのリンクがあり、href は /returns`、`FREQ-587-AC-04: 決済の画面を含む全ページのフッターに出る`（Providers の描画の単体）、`FREQ-587-AC-06: 返品についてのページが 390/768/1280px で横にはみ出さない`（RTL ではなく E2E で。Task 12）、`FREQ-587-AC-07: 読み込みの部品は失敗の状態を返し、例外を投げない`。
- [ ] **Step 2（controller）: RED を測る。** 単体を流し、ファイルが無い失敗を記録する。
- [ ] **Step 3: 実装する。** 順は ①store → ②route → ③読み込みの部品 → ④共通の部品 → ⑤ページ → ⑥フッター。ページ内のリンクは `<a>`/`Link` で、アンカー（`#returns-mismatch` など）を後から使えるよう節に `id` を付ける。
- [ ] **Step 4: GREEN を測る。** 単体、型、lint。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(returns): 返品についてのページと公開の読み口とフッターのリンクを追加する`

### Task 5: 商品ページの一文（全部の品・価格の近く）

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-587 の AC-01〜03 の行）
- Modify: `src/app/item/[id]/ItemDetailClient.tsx`（今の返品不可の一文〔`:910-921`〕を、全部の品に出す一文に置き換える。**価格・在庫・納期の表示と購入の操作は変えない**）、`tests/unit/components/ItemDetailReturnIneligible.test.tsx`（意図して直す）、`tests/unit/components/ItemDetailReturnTerms.test.tsx`（新規）
- Modify（意図して直す既存の E2E）: `e2e/FR-ITEM-DETAIL-066-return-ineligible.spec.ts`（題は変えず、「印が無ければ出さない」の期待を「ふつうの品にもふつうの品の印が出る」に直す。直した所を一覧表で報告する）
- Read: `src/app/item/[id]/ItemDetailClient.tsx` の価格を描く所（クラス名・`lk-text-*` の大きさ。実装の最初に読み、価格の `font-size` の出し方を確かめる）、`src/types/item.ts`（`returnIneligible`）、`src/app/api/items/[id]/route.ts:44,70-80`、Task 4 の `useReturnTerms`

**Interfaces:**
- Consumes: Task 4 の `useReturnTerms`・`ReturnTermsBlock`（印だけ描く小さい部品 `ReturnTermsMark` を同じファイルで足す）、`item.returnIneligible`。
- Produces: 価格の直後に1つの `<p data-testid="item-return-terms-note">` を出す。中身は、ふつうの品 `marks.standard` ＋ `shippingLine`、返品不可の品 `marks.ineligible` ＋ `ineligibleShippingLine`（14-3 の5行目。可否・条件・費用の負担の3つを返品不可の品にも出す。中-6）。後ろに「くわしくは返品について」のリンク（`/returns`）。**大きさは価格と同じ**（`font-size` を価格と同じトークンにそろえる）。今の `lk-text-3xs`（約11.8px）は使わない。返品不可の品の一文も同じ大きさ（直し2）。取得中は何も出さず、失敗した時は「返品についてはこちら」のリンクだけを出す（FREQ-587-AC-07）。
- 12ポイントの読み方: ガイドラインの「12ポイント以上」は 12pt＝16px とも読める。この Task は価格と同じ大きさにそろえ、**価格が 16px 未満なら、実測値をオーナーへの報告に載せる**（未確認事項 #8）。

- [ ] **Step 1: 失敗する試験を書く。** RTL: `FREQ-587-AC-01: ふつうの品の価格の近くに可否・条件・送料の3つとリンクが出る`、`FREQ-587-AC-01: 一文は価格と在庫の表示の間に入り、購入の操作の順序は変わらない`、`FREQ-587-AC-03: 返品不可の品は返品不可（ご相談可）と送料の負担が出て、ふつうの品と同じ大きさのクラスを使う`、`FREQ-587-AC-07: 文を取れなくても商品ページは描かれ、返品についてのリンクだけが出る`。E2E の大きさの確かめは Task 12。既存 `ItemDetailReturnIneligible.test.tsx` の2件は、文言の期待だけを新しい印に直す。
- [ ] **Step 2（controller）: RED を測る。**
- [ ] **Step 3: 実装する。** 一文は `ReturnTermsMark` に任せ、`ItemDetailClient.tsx` に文を書かない。
- [ ] **Step 4: GREEN を測る。** 単体、型、lint。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(item): 全部の商品ページの価格の近くに返品の条件を出す`

### Task 6: 最終確認の画面の印・見出しの文・申し込みの方法の条件

controller が別セッションへ先に知らせる（決済のファイル `src/features/checkout/**`・`src/app/api/checkout/create-session/route.ts`・`src/app/api/checkout/resume/route.ts`・`src/app/checkout/**` を触る。place-order の本文に触る Task 8 と順番が重なるので、Task 8 の前にこの Task を先にコミットする）。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-588 の行）
- Modify: `src/app/checkout/_components/FinalConfirmationStep.tsx`（`:392` の見出しの下の「返品・キャンセル」の段〔`:416-424`〕を置き換え、品ごとの行〔`:134-139`・「お届けの時期」の一覧〕に印を足す）、`src/app/checkout/page.tsx`（`FinalConfirmationStep` に渡す行へ `returnIneligible` を通す）、**`src/features/checkout/services/checkout-confirmation.service.ts`（`CheckoutConfirmationLine`〔`:9-20`〕に `returnIneligible: boolean` を足す。行は決済の下書きの写しと `order_items` から組まれる〔`:78-125`〕ので、確認の画面を作る時の `items.return_ineligible` を読んで足す）、`src/app/api/checkout/create-session/route.ts`・`src/app/api/checkout/resume/route.ts`（確認の応答に通す）と、それぞれの単体の試験**（最終確認で見せた行の印から `returnIneligibleItemIds` を作って保持し、Task 8 の入口へ送る。入口は注文を作る前に今の印と比べ、同じだった一覧を注文ごとに残す。受付は Task 9 のとおりその記録を読む。旧 未確認事項 #15 は2026-11-05に決定）、`tests/unit/components/FinalConfirmationStep.test.tsx`（`:111-125` の返品の文の固定を意図して直す）
- Modify（意図して直す既存の E2E）: `e2e/FR-CHECKOUT-037-final-confirmation-screen.spec.ts`（特定商取引法の項目の期待のうち、返品の文だけを新しい文に直す）
- Create: `tests/unit/components/FinalConfirmationReturnTerms.test.tsx`
- Read: `src/app/checkout/_components/FinalConfirmationStep.tsx`（全体）、`src/app/checkout/_lib/checkout-api.ts`（`placeOrder`）、設計 14-c・14-g

**Interfaces:**
- Consumes: Task 4 の `useReturnTerms`・`ReturnTermsBlock`・`ReturnTermsMark`、行の `returnIneligible`。
- Produces（画面）: 見出し「お支払い・お届け・返品について」の下に、①「返品について」の段（`marks.standard` の文・`shippingLine`・`/returns` へのリンク）、②品ごとの行に印（`お届けの時期` の一覧に並ぶ各行の後ろに、ふつうの品は `marks.standard`、返品不可の品は `marks.ineligible`）、③**申し込みの方法に条件が付く時（`photoRules` が空でない時）は、その行を画面そのものに出す**（14-c。「写真が必要な理由は…」をリンクの先に任せない）、④返品不可の品が1つでもあれば「返品不可の品も、やむを得ない事情はご相談ください」の1文（14-g）。文はすべて `useReturnTerms` の出力を通す。
- **取得に失敗した時（FREQ-588-AC-05）:** 「注文する」を無効にし、「返品の条件を読み込めませんでした。ページを読み込み直してください」を出す（最終確認の画面に3つの重要事項を出せないまま申し込ませない。12条の6）。再読み込みの操作を置く。
- Produces（本文に送る物）: Task 8 が `placeOrder` の本文に `returnTerms: {inputsHash, templateVersion, returnIneligibleItemIds}` を足す。一覧は最終確認で実際に見せた `returnIneligible` が真の行の品の番号を重複なし・番号順にした物（無ければ空の一覧）で、送信時に見せていない値へ読み替えない。この Task では文の `ref` と見せた一覧を state に持つところまで（送るのは Task 8）。

- [ ] **Step 1: 失敗する試験を書く。** RTL: `FREQ-588-AC-01: 品ごとの行に印が出て、ふつうの品と返品不可の品で分かれる`、`FREQ-588-AC-02: 返品についての段に同じ文と送料の負担とリンクが出る`、`FREQ-588-AC-03: 写真が必須の理由がある設定では、写真の決まりが画面そのものに出る`、`FREQ-588-AC-03: 写真の必須の理由が無い設定ではその行が出ない`、`FREQ-588-AC-04: 返品不可の品があれば相談の窓口の1文と送料の負担が出る`、`FREQ-588-AC-05: 文を取れない時は注文するが無効で、再読み込みの案内が出る`、`FREQ-588-AC-01: 手で書いた旧い文（お受けできません。初期不良・誤送は…）が残らない`。既存 `FinalConfirmationStep.test.tsx` の21件のうち返品の文を固定する所（`:111-125`）だけ、新しい文の期待に直す（題は変えない）。
- [ ] **Step 2（controller）: RED を測る。**
- [ ] **Step 3: 実装する。** 見出しの `id`（`termsHeadingId`）と `data-testid="checkout-terms"` は変えない（既存の試験・E2E の根拠）。
- [ ] **Step 4: GREEN を測る。** 単体、型、lint。`FinalConfirmationStep` を使う既存の suite（`grep -rln FinalConfirmationStep tests`）が、意図して直した所以外は通る。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(checkout): 最終確認の画面に品ごとの返品の印と条件を出す`

### Task 7: 特定商取引法の表記と利用規約の第6条に同じ文を差し込む

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-589 の行）
- Modify: `src/app/legal/page.tsx`（「返品・交換・キャンセルについて」の項〔`:110-136`〕を `ReturnTermsBlock` に置き換える。キャンセルの申し込みは使わない設定なので、「キャンセルはお受けできません」の1文だけは項の先頭に残す）、`src/app/terms/page.tsx`（第6条〔`:131-134`〕を、見出し「返品に関するお知らせ」の下に `ReturnTermsBlock` を置く形にする）、`e2e/FR-LEGAL-006-return-policy.spec.ts`・`e2e/FR-TERMS-*.spec.ts`（意図して直す。下の一覧表）
- Create: `tests/unit/app/legal-return-terms.test.tsx`、`tests/unit/app/terms-return-terms.test.tsx`、`tests/unit/app/return-terms-single-source.test.ts`（ソースの文字列の検査）
- Read: `src/app/legal/page.tsx`（全体。項の組み立て）、`src/app/terms/page.tsx`（全体。目次・`id="terms-6"` のアンカー）、`e2e/FR-LEGAL-006-return-policy.spec.ts`（「初期不良と7日以内・送料の負担・不可のケース5項目以上」を固定している）

**Interfaces:**
- Consumes: Task 4 の `loadReturnTerms`（サーバー側で呼ぶ）・`ReturnTermsBlock`。
- Produces: `/legal` と `/terms` はサーバー側で `loadReturnTerms` を呼ぶ。両ページは今は静的なので、`export const revalidate = 60` を足す（設定を直してから最長60秒で反映。商品ページ・最終確認〔クライアント取得〕は30秒のキャッシュ。注文の記録は place-order の確かめで守る）。取得に失敗した時は「返品の条件は返品についてのページをご覧ください」のリンクだけを出す。`terms-6` のアンカーは変えない（既存の目次・リンクを壊さない）。
- 「返品できない場合」の箇条書きは、Task 1 の規則表に**最初から**入っている（節①の `items`。期限の行は `windowDays` から作り、残り4行は今の `legal/page.tsx:122-131` の文のまま。この Task では規則表を足さない。Task 1 のファイルは変えない）。**合わない品には7日の打ち切りを付けない**ので、期限の行は節①にだけ付く。この Task は `ReturnTermsBlock` に出すだけ。
- 差し込む文の範囲: 特定商取引法の表記は節①〜④（添える文を含む）の全部、利用規約の第6条は全部＋「返品についてのページ」へのリンク。4か所の文が一致することを試験で固定する（FREQ-589-AC-03）。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-589-AC-01: 特定商取引法の表記の返品の項が生成した文と一致する`、`FREQ-589-AC-01: 特定商取引法の表記の返品の項に添える文が出る`、`FREQ-589-AC-02: 利用規約の第6条が返品に関するお知らせの見出しで分かれ、同じ文を出す`、`FREQ-589-AC-02: terms-6 のアンカーが残る`、`FREQ-589-AC-03: 商品ページ・最終確認・特定商取引法・規約・返品についてのページの文の段落が同じ設定で一致する`（5つの描画の出力から節の段落を取り、集合として等しいことを比べる）、`FREQ-589-AC-04: ソースに旧い手書きの文（お客様のご都合による返品・交換は原則としてお受けできません 等）が残らない`（`src/` を読む）。
- [ ] **Step 2（controller）: RED を測る。**
- [ ] **Step 3: 実装する。** 旧い文は削除する。意図して直す E2E（`FR-LEGAL-006-return-policy`・`FR-TERMS-*` のうち第6条を固定する所）を一覧にして `.superpowers/sdd/2026-11-04-accounting-p4/changed-tests.md` に残す（実装時に `grep -ln "返品\|第6条" e2e/FR-LEGAL-* e2e/FR-TERMS-*` で数える）。
- [ ] **Step 4: GREEN を測る。** 単体、型、lint。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(legal): 特定商取引法の表記と利用規約の返品の文を設定から作った文にそろえる`

### Task 8: 注文に条件の版を残す（トリガー・新しい入口で比べて注文を作り見た版を結ぶ・照合の道）

controller が別セッションへ先に知らせる（G の書き手の一覧 `private.group_g_writer_allowlist()`〔77→78本〕、新しい入口 `place_order_with_return_terms`〔private と public〕、`src/app/api/checkout/place-order/route.ts`、`src/app/checkout/_lib/checkout-api.ts`、`src/app/checkout/_components/FinalConfirmationStep.tsx`、`src/app/checkout/page.tsx`、`orders` の表への DB トリガー）。Task 3・6 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-590 の行）
- Create: `supabase/migrations/<ts26>_accounting_p4_order_return_terms_record.sql`、`tests/integration/db/accounting_p4_order_return_terms.integration.test.ts`、`tests/integration/db/accounting_p4_order_return_terms_concurrency.integration.test.ts`、`tests/unit/api/checkout-place-order-return-terms.test.ts`
- Modify: `src/app/api/checkout/place-order/route.ts`（zod に `returnTerms: z.object({inputsHash: z.string().regex(/^[0-9a-f]{64}$/), templateVersion: z.number().int().min(1), returnIneligibleItemIds: z.array(z.number().int().positive())})` を足し、RPC を `place_order_with_return_terms` に替える。断りの応答に今の文と `ref` を載せる）、`src/app/checkout/_lib/checkout-api.ts`（`placeOrder` の引数に `returnTerms`、`PlaceOrderOutcome` の再確認の道に理由 `return_terms_changed` と新しい文・`ref` を足す）、`src/app/checkout/_components/FinalConfirmationStep.tsx`（`ref` と見せた `returnIneligibleItemIds` を送り、再確認の応答の文と一覧で品ごとの印も差し替える）、`src/app/checkout/page.tsx`（`handleReconfirmationRequired`〔`:1139`〕に返品の条件用の道を足す。返品の条件が変わっただけなら決済の画面を作り直さず、同じ画面で文だけ差し替える。割引の文〔`:311`「割引の内容が変わりました…」〕は割引の理由の時だけ出す）、`tests/integration/db/accounting_p4_migration_asserts.integration.test.ts`、`tests/unit/app/checkout-page-reconfirmation.test.tsx`（無ければ新規）、決済の既存の試験のうち `orders` のトリガーの一覧・表の列を固定する物（実装時に `grep -rln "pg_trigger\|information_schema.triggers" tests/integration/db | xargs grep -ln "orders"` で数える）、`group_g2_public_function_acl.integration.test.ts`（公開の関数の一覧に `place_order_with_return_terms` を足す）、**`tests/integration/db/helpers/group-g-allowlist.ts`・`tests/integration/db/group_h_migration_asserts.integration.test.ts`・`tests/integration/db/group_g1_writer_inventory.integration.test.ts`・`tests/integration/db/accounting_p3_migration_asserts.integration.test.ts`（書き手の一覧の付け替えと、H の確かめと計画3の S18・S19 の確かめを流す前に一覧を戻す直し。下の「G の書き手の閉じた一覧に足す」）**
- Modify（注文を消さない形に直す。下の「注文は消せない」）: `e2e/FR-SEARCH-021-search-injected-rows.spec.ts:186`、`tests/integration/db/group_g1_legacy_disabled.integration.test.ts:228`、ほかに後始末で注文を消す helper・fixture（実装時に `grep -rn "DELETE FROM public.orders\|delete from orders\|from('orders').delete" tests e2e src` で数える）
- Read: `supabase/migrations/20261029130300_group_h_discounts_acceptance.sql:273-300`（`private.place_order_from_checkout_draft` の最新の定義。**本文は変えない**。戻りは `(order_id, order_status, created, rejection)`）、同 `:465-480`（H の確かめ `group_h_recheck_discount_facts` の後に注文の行を入れる）、同 `:612`（`place_reconciled_order_from_checkout_draft`）、同 `:1795-1830`（H4 の末尾の確かめ。**この2本の本文の MD5 を固定している**。変えないので通る）、`src/app/api/checkout/place-order/route.ts`（全体。`:323-350` の `discount_automatic_changed` の道、`expireOpenCheckoutSession`、入金と競った時の照合）、`src/lib/stripe/checkout-payment-reconciler-deps.ts:131`（照合の道の呼び口）、`tests/integration/db/place_order_from_checkout_draft.integration.test.ts`、`tests/integration/db/group_g1_cleanup.integration.test.ts`

**Interfaces:**
- Consumes: Task 3 の `private.return_terms_inputs()`・`private.return_terms_hash`・`return_terms_snapshots`・`return_terms_renderings`。
- Produces（表。追記専用・RLS・service_role は SELECT のみ。計画3 Task 1 と同じ守り）:
  - `order_return_terms(order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE RESTRICT, inputs_hash text NOT NULL REFERENCES return_terms_snapshots(inputs_hash) ON DELETE RESTRICT, recorded_at timestamptz NOT NULL DEFAULT now())`。14-f の「注文した時に出ていた条件の中身・日時」。中身は `inputs_hash` から `return_terms_snapshots.inputs`。
  - `order_return_terms_shown(order_id uuid PRIMARY KEY REFERENCES order_return_terms(order_id) ON DELETE RESTRICT, shown_inputs_hash text NOT NULL, template_version integer NOT NULL CHECK (template_version >= 1), attached_at timestamptz NOT NULL DEFAULT now(), return_ineligible_item_ids bigint[] NOT NULL DEFAULT '{}'::bigint[], FOREIGN KEY (shown_inputs_hash, template_version) REFERENCES return_terms_renderings(inputs_hash, template_version) ON DELETE RESTRICT)`。お客様が最終確認の画面で見た版（文の控えの1行を指す）と、入口で比べて同じだった返品不可の品の番号の一覧（以後、その注文の時の値として扱う。`items.id`。注文の明細にある品だけ、重複なし・番号順。印のある品が無ければ空の一覧）。一覧は入口が DB から読み、クライアントには決めさせない。新しい入口では必ず `shown_inputs_hash = order_return_terms.inputs_hash`（違えば注文ごと断るので、一致を表す列は持たない）。**この行が無い注文は「見た版の証拠が無い注文」**（照合の道で作られた注文・直接作られた注文）。画面・運用の文書にそう書く。
- **注文は消せない（決定: 記録は消せない物にする）。** 注文への外部キーは `RESTRICT` のまま、追記専用のまま。注文を消す試験・後始末は「消さない形」（試験ごとに固有の識別子で作って残す。DB 結合の試験は ROLLBACK の形なので消す必要がない）に直し、直した所を `changed-tests.md` に表で報告する。本番の注文は消さない決まり。共通 verify の「注文は消せるが」は「注文と記録は消せない」と読み替える。
- Produces（トリガー）: `private.order_record_return_terms() RETURNS trigger`（SECURITY DEFINER、`search_path=''`）と `acc_p4_orders_record_return_terms AFTER INSERT ON public.orders FOR EACH ROW`。本体は ①`v := private.return_terms_inputs()`（1本の SELECT。ロックを取らない）、②`INSERT INTO return_terms_snapshots ... ON CONFLICT (inputs_hash) DO NOTHING`、③`INSERT INTO order_return_terms (order_id, inputs_hash) VALUES (NEW.id, hash)`。**トリガーは失敗しても注文を止めない**（入れ子の `BEGIN ... EXCEPTION WHEN OTHERS THEN RAISE WARNING ...` で記録だけ落とす）。理由: 照合の道（支払い済みの注文を後から作る）で「お金は取ったのに注文が無い」にしないため（H4 の「支払い済みは今の条件で断らない」と同じ考え方）。記録の無い注文は Task 10 で法律の8日に戻るので安全側。**「注文する」の道の厳しさは新しい入口が持つ**（下）。決済の関数の本文は1字も変えない。
- Produces（新しい入口。決済の関数の本文は変えずに、比べることと注文を作ることを同じトランザクションにする）: `private.place_order_with_return_terms(<place_order_from_checkout_draft と同じ10個の引数>, _shown_inputs_hash text DEFAULT NULL, _shown_template_version integer DEFAULT NULL, _shown_return_ineligible_item_ids bigint[] DEFAULT NULL) RETURNS TABLE (order_id uuid, order_status public.order_status, created boolean, rejection text)`（後ろの3つの引数は既定値つきなので、足す3つにも `DEFAULT NULL` が要る。見た一覧は重複なし・番号順に正規化し、NULL の配列・NULL の要素・正でない番号は断る。中で NULL なら `RETURN_ARGUMENT_INVALID / 22023` で断る）。private 本体は postgres の `SECURITY DEFINER`・`search_path=''`・service_role だけ EXECUTE（一覧に入る関数の決まり）。public 入口は同名同引数（同じ `DEFAULT NULL`）の `LANGUAGE sql SECURITY INVOKER`・service_role だけ EXECUTE で、本体は `select * from private.place_order_with_return_terms(<引数>)` の1文だけ（`group_g1_writer_inventory` の `isPublicDelegate` と H4 の `v_expected_delegate` の形）。
  - **G の書き手の閉じた一覧に足す（重大-A。77→78本）:** この関数は書き手（`private.place_order_from_checkout_draft`、一覧の中）を呼ぶので、一覧の外に置くと `group_g1_writer_inventory` が落ちる。S26 で `private.group_g_writer_allowlist()` を作り直して `place_order_with_return_terms` を足す。元の文は、計画3の S18 の後の定義（`-- ACC_P3_BEGIN`〜`_END` の囲みと新しい形の `admin_receive_return` を含む）で、それを一字も変えずに写し、`-- ACC_P4_BEGIN`〜`-- ACC_P4_END` の囲みで1行足す（H4 の文〔古い形〕から写すと `regprocedure` が解けず CREATE が落ちる。計画3の S18 も一覧を作り直すので、計画3と計画4の作り直す関数はこの一覧だけ重なる。final-review-b2 の小4）。今の決まりは `tests/integration/db/helpers/group-g-allowlist.ts:122-136` のとおり: **時点の一覧の定数（`H4_ALLOWLIST`・`H7_ALLOWLIST` など）は変えず、`CURRENT_ALLOWLIST` の指す先だけを付け替える。昔の確かめを今の DB で流す試験は、流す前に一覧をその時点の物に戻す**（G4 の試験の `runWithAllowlist(G3D_ALLOWLIST)` と同じ形、`group_g4_migration_asserts:232-237`）。適用済みの移行（H の移行）と H の確かめの文は編集しない。意図して直す試験は次の4つで、**すべて Files の Modify に入れる**:
    1. `tests/integration/db/helpers/group-g-allowlist.ts`: `P4_ALLOWLIST = [...P3_ALLOWLIST, 'private.place_order_with_return_terms(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid,text,integer,bigint[])']`（78本）を足し、`CURRENT_ALLOWLIST` を `P4_ALLOWLIST` に付け替える。`H4_ALLOWLIST`・`H7_ALLOWLIST`・`P3_ALLOWLIST`（計画3 Task 4 が足した物。77本。`admin_receive_return` が計画3の新しい形〔末尾に `date`〕の一覧）は変えない。`P4_ALLOWLIST` は `H7_ALLOWLIST`（古い形の `admin_receive_return` を含む）の上ではなく、**`P3_ALLOWLIST` の上**に積む（計画3の後の DB では古い形の関数が無く、一覧が解けなくなるため。最終レビュー final-review-p3-p4 中1）。
    2. `tests/integration/db/group_h_migration_asserts.integration.test.ts`: H4・H7 の `attempt`（確かめを移行のファイルから切り出して流す所、`:354`・`:597`）の前に、**H4 の移行の `CREATE OR REPLACE FUNCTION private.group_g_writer_allowlist()` の文（`20261029130300_…sql:1610-1690`）を、移行のファイルから切り出して1字も変えずに流して一覧を77本に戻す**。ただし H4 の文の一覧には古い形 `private.admin_receive_return(…14個の引数)` が書かれていて、計画3の S18 の後の DB にはその形の関数が無い（`regprocedure` の変換が `function … does not exist` で落ちる）。そこで、流す前に計画3 Task 4 が `group-g-allowlist.ts` に足す道具 `createLegacyReceiveReturnStub(client)`（取引の中だけで、古い形の仮の関数を `CREATE FUNCTION` する。試験の後の rollback で消える）を呼ぶ。H4・H7 の確かめが解く他の関数は計画3の後も同じ形で残っている（H7 は一覧の関数の本文の MD5 `1a9bd697…` を求めるので、`replaceAllowlistSql(H4_ALLOWLIST)` の `select array[...]` の書き方では戻せない）。取引の中なので試験の後の rollback で戻る。
    3. `tests/integration/db/group_g1_writer_inventory.integration.test.ts`: 試験の中に手で書いた文字列 `ALLOWLIST`（`:31-109`、77本）に78本目を足し、`FREQ-549-AC-03`（`:206-215`）の期待を「`CURRENT_ALLOWLIST` は `P4_ALLOWLIST` で78本」に直す。`:254-263` の呼び元の確かめは、新しい関数が一覧の中なので通る。
    4. `tests/integration/db/accounting_p3_migration_asserts.integration.test.ts`: 計画3の S18 の確かめ（`acc_s18_g_allowlist_replaced`。一覧が77本であることを見る）と S19 の確かめ（`acc_s19_g_allowlist_unchanged`。一覧が `P3_ALLOWLIST` と同じことを見る）を、`runWithAllowlist(P3_ALLOWLIST)` の中で流す形に直す（S26 の後の DB は78本なので、そのまま流すと落ちる。題と期待は変えない。final-fix-review-b3 の中-3、final-fix-review-b3-2 の中-C。計画5はこの直した形を流すだけ。S17 と計画2の S6 の確かめは計画3 Task 4 が `runWithAllowlist(H7_ALLOWLIST)` の中で流す形に直してあるので触らない）。`changed-tests.md` の表にも入れる。
    `CURRENT_ALLOWLIST` を使う G の試験（`group_g2_*`・`group_g3_*` の本数の確かめ）は付け替えに自然に付いてくるので、無改造で通ることを Step 4 で確かめる。直した所は `changed-tests.md` に表で報告する。
  - 手順は次の順:
  1. **すでにこの決済の画面の注文があれば、比べずに `private.place_order_from_checkout_draft` の結果をそのまま返す**（決済の関数の先頭の再送の枝が既存の注文を返す。1回目の応答が届かなかった再送で、すでにある注文に「確認へ戻る」を返さない）。既存の注文の有無は `orders.checkout_session_id` で調べる（決済の関数 `20261029130300_…sql:319-320` と同じ列）。
  2. 無ければ `SELECT ... FROM public.shop_return_settings WHERE id = 1 FOR SHARE` で設定の行を共有ロックし（コミットまで外れない）、**ロックを取った後にもう一度 `orders.checkout_session_id` で既存の注文を見て、在れば比べずに手順1と同じく決済の関数の結果を返す**（同じ決済の画面の要求が2つ同時に来て、1つ目の注文のコミットの直後に設定が直された時、2つ目に `return_terms_changed` を返さない）。在らなければ、`private.return_terms_hash(private.return_terms_inputs())` を出す。`return_terms_renderings` に `(_shown_inputs_hash, _shown_template_version)` の行が無ければ断る（見た版の控えが無い＝お客様が見ていない版）。文の版が現在の TS の版と違う時は route が先に弾く（下の route。DB は TS の版を知らない）。
  3. **注文を作る前に、品の印を含めて比べる。** 決済の関数と同じく、下書きの `items_snapshot` から `resolve_checkout_item_variants` で対象の variant の集合を閉じ、`private.group_h_lock_acceptance(_draft_id,NULL)` → `private.lock_group_g_inventory(v_variants, ARRAY[]::uuid[], _draft_id)` を同じ順で呼ぶ（既存の共通の押さえ・H の鍵・G の鍵と対象の行の鍵を先に取る。新しい鍵の番号は足さず、後で呼ぶ決済の関数による同じ取引内の再取得は許す）。鍵の後に下書きを読み直し、集合が変わった時の検査も決済の関数と同じにする。ここでも既存の注文を見直し、在れば手順1の結果を返す。下書きが指す全品の今の `items.return_ineligible` から、重複なし・番号順の DB の一覧を1回読み、比較に使った値を保持する。ハッシュが `_shown_inputs_hash` と違うか、この DB の一覧が `_shown_return_ineligible_item_ids` の正規化した一覧と違えば、**決済の関数を呼ばず、注文を作らず** `(NULL, NULL, false, 'return_terms_changed')` を返す。注文を作ってから印の違いで取り消す形にはしない。
  4. 同じなら `private.place_order_from_checkout_draft(...)` を呼び、注文が作られた（`created`）時、`order_return_terms` の行がトリガーで入っているはずなので、無ければ `RAISE EXCEPTION 'RETURN_TERMS_RECORD_MISSING' USING ERRCODE = '55000'`（この入口は未払いの注文を作る道なので、注文ごと取り消す。記録の無い注文を作らない）、あれば作成した注文の `order_items.item_id` の品の集合が、手順3で読んだ下書きの品の集合と同じであり、残す一覧がその注文の品だけであることを確かめる。違えば `RETURN_TERMS_RECORD_MISSING / 55000` で注文と記録を同じ呼び出しごと取り消す（記録が無い時と同じ）。品の印は読み直さず、手順3で比べて同じだった DB の一覧を `return_ineligible_item_ids` として、`order_return_terms_shown` に見た版と一緒に `INSERT ... ON CONFLICT (order_id) DO NOTHING` で残す。印のある品が無ければ空の一覧。注文と同じトランザクションで固定し、手順1・2の再送では読み直しも上書きもしない。
  - **ロックの順:** 設定の行（共有）→ 共通の押さえ → H の受付の鍵 → G の在庫の鍵・対象の行（手順3で、決済の関数と同じ道具・同じ順）。設定を直す関数は G の鍵を取らない。`admin_update_shop_return_settings` は今の定義ですでに設定の行の `FOR UPDATE`（`order_return_actions.sql:1766`）を取っているので、足さずそのまま使う。**どの設定の更新も設定の行の鍵を先に取る**（理由の設定の表だけを直す更新でも、行の鍵で注文の入口と順番が決まる）。共通の押さえを持つ関数は設定の行の鍵を取らない決まり（Global Constraints）を並行の試験の題に入れる。すれ違いで止まらないことを並行の試験で固定する。
  - 設定の共有ロックは注文を作るまで続くので、文に効く設定は途中で変わらない。品の印は比較後に管理画面で変わることがあるが、比較に使った一覧を読み直さず注文へ残す。その注文はお客様に見せた一覧の条件で受ける（オーナー決定 #15）。品の印のための `FOR SHARE` は足さず、G の鍵の順は変えない。
- Produces（照合の道）: `private.place_reconciled_order_from_checkout_draft`（支払いが済んだのに注文が無い時に後から作る。`checkout-payment-reconciler-deps.ts:131`）は**触らない**（本文の MD5 が H4 で固定されている）。トリガーは働くので記録は残る（**照合した時の設定**。お客様が見た時の設定ではない）が、見た版の結びは無い。トリガーは失敗しても注文を止めないので、お金を取った注文を作れなくなる事は無い。照合で作られた注文は `order_return_terms_shown` の行が無いので「見た版の証拠が無い注文」と分かる。直接作る注文も同じで、返品不可の印の記録は作らず、受付は「返品不可でない」とする（今の品の印や照合時の印を写して埋めない）。
- Produces（route）: place-order の route は、まず本文の `returnTerms.templateVersion` が現在の `RETURN_TERMS_TEMPLATE_VERSION` と違えば RPC を呼ばずに断る（文の作り方が変わった後の古い画面）。それ以外は RPC `place_order_with_return_terms` を呼ぶ。`rejection='return_terms_changed'` の時は、`discount_automatic_changed` と違い**決済の画面を閉じない**（金額は変わらない。注文はまだ作られていない）。断りの応答は `{reconfirmationRequired: true, returnTo: 'confirmation', reason: 'return_terms_changed', terms: <今の ReturnTermsView>, ref: {inputsHash, templateVersion, returnIneligibleItemIds}}`（HTTP 200）。**route が断りの時に `loadReturnTerms` で今の文を作り、確認の行を読む既存の道で今の品の印も読み直して `ref.returnIneligibleItemIds` を返す**ので、画面はキャッシュに頼らず新しい文と印を持てる。画面は文と品ごとの印・state の一覧を一緒に差し替え、「返品の条件が更新されました。内容をご確認のうえ、もう一度『注文する』を押してください」を出す。決済の画面は作り直さない。割引の断りの道（`expireOpenCheckoutSession`・入金と競った時の照合）には触れない。
- S26 assert DETAIL（固定コード）: `acc_s26_tables`（2表の列・制約・追記専用・RLS・ACL）・`acc_s26_trigger`（`orders` のトリガーの名前・タイミング・関数の属性）・`acc_s26_entry`（新しい入口の属性・所有者・`search_path`・ACL・public の委譲の形）・`acc_s26_writer_allowlist`（78本と並び。計画3の後の77本の一覧〔`P3_ALLOWLIST`〕に1本足しただけであること）・`acc_s26_checkout_bodies_unchanged`（決済の関数 2本の本文の MD5 が前と同じ）・`acc_s26_existing_dml_allowlist`（移行の中で行を書き換えない）。
- 順序の保証: ①記録は注文の insert と同じトランザクション（原子）。②内容で一意の表と `ON CONFLICT DO NOTHING` だけで、届く順に依存しない。③見た版の結びは新しい入口の中で注文と同じトランザクション。④設定の行の共有ロックで、比べてから注文を作るまでの間に設定は変わらない。⑤既存の注文は比べずに返す。⑥見せた品の印の一覧を、同じトランザクションで注文を作る前に今の印と比べ、同じだった一覧を注文に残す。比べた後に管理画面の印が変わっても、その注文は見せた一覧のままで、再送でも変えない。

- [ ] **Step 1: 失敗する試験を書く。** DB は ROLLBACK の形（並行だけコミット）。`FREQ-590-AC-01: 注文を作ると同じトランザクションで条件の記録が1行残る`、`FREQ-590-AC-01: 記録のハッシュは作った時の設定のハッシュと同じで、中身が控えの表にある`、`FREQ-590-AC-02: 設定を変えても既存の注文の記録は変わらず、新しい注文は新しいハッシュ`、`FREQ-590-AC-02: 設定を元に戻すと同じハッシュに戻り、控えの表に行が増えない`、`FREQ-590-AC-04: 新しい入口で注文すると見た版が結ばれ、同じ決済の画面の再送は何も足さず既存の注文を返す`、`FREQ-590-AC-04: 見た版が現在と違えば注文を作らず return_terms_changed を返し、記録も結びも残さない`、`FREQ-590-AC-04: 見た版の控えが無い版を送ると断る`、`FREQ-590-AC-04: すでに注文がある決済の画面は、設定が変わった後の再送でも return_terms_changed を返さず既存の注文を返す`、`FREQ-590-AC-06: 2つの表は UPDATE・DELETE・TRUNCATE を断り、anon と authenticated に権限が無い`、`FREQ-590-AC-06: 注文を作る関数が失敗すれば記録も残らない`、`FREQ-590-AC-06: トリガーの本体が失敗しても、直接作る注文と照合の道の注文は作られ、新しい入口は RETURN_TERMS_RECORD_MISSING で注文ごと取り消す`、`FREQ-590-AC-06: 照合の道で作った注文は記録が1行で、見た版の結びが無い`、`FREQ-590-AC-07: 注文を作っても accounting_journal_entries の行が増えない`、`FREQ-590-AC-07: place_order_from_checkout_draft と place_reconciled_order_from_checkout_draft の本文の MD5 が S26 の前後で同じ（H4 の末尾の確かめがそのまま通る）`、`FREQ-590-AC-06: orders のトリガーの一覧に acc_p4_orders_record_return_terms が増えただけ`、`FREQ-590-AC-08: 注文した品のうち返品不可の印がある品の番号だけが重複なし・番号順で残り、印が無ければ空の一覧になる`、`FREQ-590-AC-08: 注文後に品の印を付けても外しても記録は変わらず、同じ決済の画面の再送でも上書きしない`、`FREQ-590-AC-08: 注文を作る関数が失敗すれば品の印の記録も残らず、送った一覧はDBの一覧と比べるだけで違う一覧は記録に使わない`、`FREQ-590-AC-09: 最終確認の後、入口で比べる前に品の印を付けても外しても、入口は注文を作らずreturn_terms_changedを返し、注文・条件・見た一覧の記録は0件のまま`、`FREQ-590-AC-09: 送った一覧に別の品を足す・印のある品を抜くと確認へ戻り、同じ一覧の順や重複だけは正規化して比較する`、`FREQ-590-AC-08: 比べた下書きの品の集合と作った注文のorder_items.item_idの集合が違えばRETURN_TERMS_RECORD_MISSINGで注文と記録を残さず、注文の外の品の番号は一覧に入らない`。
  - 並行（別の jest 実行）: `FREQ-590-AC-03: 設定を直す未コミットのトランザクションの間に作った注文は直す前のハッシュを、コミット後に作った注文は直した後のハッシュを持つ`、`FREQ-590-AC-03: 新しい入口が設定の行の共有ロックを持っている間に設定の更新を始めると、更新は入口のコミットまで待ち、見た版と違う条件の注文は1件も通らない（比べた後・注文を作る前に設定が変わる隙の試験）`、`FREQ-590-AC-03: 注文を50件と設定の更新を20回、並べて流しても、全部の注文の記録のハッシュが見た版のハッシュと一致するか、return_terms_changed で断られている`、`FREQ-590-AC-03: 設定の更新と新しい入口の鍵の順の入れ替わりで止まらない（理由の設定の表だけの更新も含む）`、`FREQ-590-AC-04: 同じ決済の画面で新しい入口を同時に10回呼んでも注文と結びは1つ`、`FREQ-590-AC-04: 1つ目の注文のコミットの直後に設定が直されても、同時に来た2つ目は return_terms_changed を返さず既存の注文を返す`、`FREQ-590-AC-06: 共通の押さえを持つ関数が shop_return_settings の行の鍵を取らない（関数のソースの検索と pg_locks で固定する）`、`FREQ-590-AC-06: place_order_with_return_terms は G の書き手の一覧に入り、private は SECURITY DEFINER・search_path 空・postgres 所有、public は委譲だけ`、`FREQ-590-AC-06: 引数の既定値の並びで関数が作れ、見た版が NULL なら断る`、`FREQ-590-AC-09: 印の更新が比較より先にコミットすれば古い一覧は注文前に断られ、比べた後に管理画面の印の更新がコミットしても注文は作られ、注文に残る一覧は見せた一覧のまま`。
  - 単体: `FREQ-590-AC-05: 文の版が現在と違えば RPC を呼ばず再確認を返す`、`FREQ-590-AC-05: return_terms_changed で決済の画面を閉じず、今の文と ref を応答に載せる`、`FREQ-590-AC-05: 一致すれば RPC の結果をそのまま返す`、`FREQ-590-AC-05: 本文に returnTerms が無いと400`、`FREQ-590-AC-05: 非 ok の応答の本文を読み切る`、`FREQ-590-AC-05: 設定を直した直後に戻され、応答の文と ref で1回の押し直しで注文できる（キャッシュに頼らない）`（画面の単体）、`FREQ-590-AC-09: 本文とRPCに見せたreturnIneligibleItemIdsを送り、再確認で返った一覧から品の印も更新する`、`FREQ-590-AC-09: 一覧が無い本文と正でない番号は400で、空の一覧は送れる`。
- [ ] **Step 2（controller）: RED を測る。** DB 2 suite と単体。表が無い失敗を記録する。
- [ ] **Step 3: S26 と TS を実装する。** 決済の関数は触らない。H5 の基準（`h5_function_baseline`）の対象は返金・返品の14本で、この Task の入口とトリガーは入っていない（Task 9 の `return_detail_json` は対象）（2026-11-04 に `20261029130400_…sql:3-20` で確認）。H4 の末尾の確かめ（`place_order_from_checkout_draft`・`place_reconciled_order_from_checkout_draft` の本文 MD5）は変えないので通ることを assert で確かめる。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify。並行3連続。末尾 assert を SAVEPOINT 内で、表の改ざん・トリガーの欠落・入口の属性の改ざん・一覧の本数の改ざん・決済の関数の本文の改ざんを1つずつ入れて流し、55000 と対応 DETAIL（`acc_s26_*`）を検査する。上の4つの直した試験（4つ目の `accounting_p3_migration_asserts` は S18・S19 の両方の確かめ）と、`CURRENT_ALLOWLIST` を使う G の試験（`group_g2_*`・`group_g3_*`）が、直した所以外は無改造で通る。**決済の回帰:** `place_order_from_checkout_draft`・`group_h_discounts_*`・`group_g1_*`（注文・在庫・清掃）・checkout の route の単体・`FR-CHECKOUT-*` の E2E を、意図して直した所以外は無改造で流して赤くならないこと。通らない物があれば Files に足して直し、`changed-tests.md` に表で残す。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(checkout): 注文に返品の条件の版を残す`

### Task 9: 受付の作り（その他・合わない品を期限で締めない）

controller が別セッションへ先に知らせる（`private.customer_request_return`・`private.customer_return_availability`・`public.get_customer_return_request_materials`・`public.get_order_return_materials`・`private.return_detail_json`・返品の route・`ReturnRequestForm.tsx`・`OrderReturnsSection.tsx`・`return-request-model.ts`・注文の状況のページの読み口）。Task 8 のコミット後に始める。計画1の地図の行4（controller が7本に直した）が定める、返品の受付・期限・設定の関数7本（`get_shop_return_settings`・`admin_update_shop_return_settings`・`customer_request_return`・`customer_return_line_states`・`customer_return_availability`・`get_customer_return_request_materials`・`fulfillment_line_returnable`）のうち、この Task は受付の3本（`customer_request_return`・`customer_return_availability`・`get_customer_return_request_materials`）に、管理画面の材料 `get_order_return_materials` と詳細 `return_detail_json` の2本を加えて手入れする（2026-11-05 controller 決定）。`customer_return_line_states` は戻り型を変えないので作り直さない。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-591 の行）
- Create: `supabase/migrations/<ts27>_accounting_p4_return_request_rules.sql`、`tests/integration/db/accounting_p4_return_request_rules.integration.test.ts`、`tests/integration/db/accounting_p4_return_request_rules_concurrency.integration.test.ts`、`tests/integration/db/helpers/accounting-return-terms-fixtures.ts`（下の `recordOrderReturnTerms`）
- Modify: `src/features/account/returns/return-request-model.ts`（`INELIGIBLE_ALLOWED_REASONS` に `other` を足す〔`:25`〕。期限後の行の選べる理由を `defect_selectable` から出す〔`:220`〕。「◯月◯日で受付を終了しました」の文〔`REQUEST_TEXT.ended`、`:465`〕を、破損・不良・注文と違う品の申し込みが残る時は出さない。`REQUEST_TEXT.ineligible` と期限後の案内を `useReturnTerms` の文を通す形に直す）、`src/features/account/returns/ReturnRequestForm.tsx`（期限後の行を、破損・不良・注文と違う品だけが選べる形で出す）、`src/features/account/returns/OrderReturnsSection.tsx`（`canRequest = availability.returns === "available"` の所〔`:358`〕。期限切れの行だけの注文でも、合わない品の申し込みのボタンを出す）、`src/lib/orders/returns/customer-return-store.ts`（`:93` 付近の許す値の一覧と行に `defectSelectable`）、`customer-return-types.ts`、`customer-return-messages.ts`、`src/lib/orders/status/status-store.ts`（`:406` 以降。注文の状況のページの同じ読み口）、`src/components/OrderHistoryPanel.tsx`（`:552`）、`src/components/OrderReturnCreateForm.tsx`（`:330`）・`OrderReturnReviewDialog.tsx`（`:301`）の返品不可の警告の文（その他も受けると直す）、管理画面のお断りの理由の画面（`return-messages.ts:101`・`window_passed`。下の小-7 の決定）、それぞれの単体の試験
- Modify（意図して直す既存の試験。題は変えない）: `tests/integration/db/group_g1_return_requests.integration.test.ts`・`order_return_customer_requests.integration.test.ts`・`tests/integration/db/return_postgrest.integration.test.ts`（注文時の印の記録を fixture に足すか、記録の無い注文として期待を偽に直す。返品不可の理由と期限後の理由の期待も直す）、`order_status_returns.integration.test.ts`（availability を読む所）、`tests/unit/features/account/returns/return-request-model.test.ts`、`ReturnRequestForm` と `OrderReturnsSection` の単体、`OrderReturnCreateFormIneligible.test.tsx`、`e2e/FR-ACCOUNT-035-return-request.spec.ts`・`FR-ACCOUNT-037-…-eligibility.spec.ts`・`FR-ADMIN-099-item-return-ineligible.spec.ts`。`e2e/return-request-test-utils.ts`（postgres の `rr.db` を使って注文時の記録を作る道具を呼べるようにする）・`e2e/order-admin-test-utils.ts`（管理画面の注文にも同じ記録を足す）、`tests/integration/db/accounting_p4_migration_asserts.integration.test.ts`（追加2本の本文の囲みと H5 の属性・本文の MD5）、`tests/integration/db/group_h_migration_asserts.integration.test.ts:35-48`（`FREQ-551-AC-02`。`return_detail_json` の新しい本文の MD5 と、囲みを除いた本文の比べ方を期待にする。既存の題は変えない）。ほかに `grep -rln "return_ineligible = true\|setItem(" tests e2e` で該当する試験を数え、必要なファイルをこの Modify に足す。**試験ごとに「印を付けた後、対象の操作の前に道具で注文時の記録を作る」か「記録の無い注文として期待を偽に直す」かを `changed-tests.md` に表で残す。既存の題は変えない。**
- Read: `supabase/migrations/20261023211425_group_g1_allocation.sql:5913-6290`（`private.customer_request_return` の最新の定義。**ステップ8〔期限〕は `:6030-6041`、ステップ10〔理由〕は `:6067-6081`**）、`20261020144842_order_return_customer_requests.sql:50-160`（`private.customer_return_line_states`）・`:130`（`private.customer_return_availability`。`returns='ended'` になる条件は `:149-157`）・`:385,542,1096` と `20261022084944_order_status_returns.sql:29`（availability を呼ぶ所）、`20261020150415_order_return_request_reviews.sql:450-515`（管理画面の材料の最新）、`20261029130400_group_h_discounts_refunds.sql:2692-2760`（詳細の最新）・`:3-20,3105-3143`（H5 の属性と本文の MD5 の確かめ）、`src/lib/orders/returns/return-store.ts:608,754`、`20261029*` が同じ関数を触っていないこと（`grep -n "customer_request_return\|customer_return_availability" supabase/migrations/20261029*`）

**Interfaces:**
- Consumes: 設計 14-a3・14-g・A9・A13、Task 8 の `order_return_terms_shown.return_ineligible_item_ids`（2026-11-05 オーナー決定、旧 未確認事項 #15）。
- Produces（DB。S27）。最新の定義を1字も変えずに写し、足す所を `-- ACC_P4_BEGIN/END` で囲む:
  - `private.customer_request_return(uuid,uuid,uuid,jsonb)`: ①返品不可の判定で今の `items.return_ineligible` を読む所を、対象の `order_items.item_id` がその注文の `order_return_terms_shown.return_ineligible_item_ids` に含まれるかに替える。行が無い時は偽（「返品不可でない」）とし、今の品の印へ戻らない。②ステップ8（期限）の `WHERE fr.deadline_date IS NOT NULL AND fr.deadline_date < v_today` に `AND p.reason NOT IN ('defective', 'wrong_item')` を足す（期限は特約の理由だけに効く）。③ステップ10（理由）の `NOT IN ('defective', 'wrong_item')` を `NOT IN ('defective', 'wrong_item', 'other')` にする（A9 の「その他」は返品不可の品にも開く。理由の設定で `shown` が偽ならこれまでどおり断る）。詳しい内容の必須（`other`・`defective`）はステップ11のまま。**「その他」は期限で締まる**（ステップ8の除外は破損・不良・注文と違う品だけ）。相談の申し込みの期限の後は、お問い合わせで受ける（節④に1文足す。Task 1 の規則表）。
  - 新しい小さい関数 `private.customer_return_defect_lines(_order_id uuid) RETURNS TABLE (fulfillment_id uuid, order_item_id uuid, defect_selectable integer)`（`STABLE`）: `customer_return_line_states` の出力は返品できる数の列を持たず（`past_deadline` の行の `selectable` は0、`quantity` は発送の行の数）、そこからは作れない。そこで `private.fulfillment_line_returnable(_order_id)` と `private.order_line_return_counts(_order_id)` を直接読み、`customer_return_line_states` の `base`（`20261020144842_…sql:82-90`）と同じ式 `LEAST(fr.returnable, COALESCE(c.returnable, 0))` を、**期限切れ（`fr.deadline_date IS NOT NULL AND fr.deadline_date < 日本時間の今日`）の行だけ**、`defect_selectable` として返す（1以上の行だけ）。式が二つの関数で食い違わないよう、両方に「この式は相手とそろえる」の注記を置く。**`customer_return_line_states` は作り直さない**（戻り型を変えて DROP する道を避ける。呼ぶ側が SQL 関数でも依存で止まらないため、assert で依存が無いことを確かめる必要も無くなる）。
  - `private.customer_return_availability(public.orders)`（今の引数は注文の行 `_order public.orders`。`20261020144842_…sql:130`。`uuid` で作るとオーバーロードが増えるだけで呼ぶ側は古い関数を使い続けるので、型を変えない）: 戻りの形は変えない。期限切れの行しか無い注文でも、`private.customer_return_defect_lines` に `defect_selectable > 0` の行があれば、`returns = 'available'`（今は `ended`）を返す。**`ended_on` は `available` の時は空にする**（今の CASE は「選べる行が無い」だけで日付を返すので、直した後は `available` と一緒に日付が返り、注記 `:127`「ended の時だけ」と食い違う。`available` なら `NULL`）。破損・不良・注文と違う品の理由を設定で出さない時（`shop_return_reason_settings.shown` が両方偽）は、選べる理由が0なので **今のとおり `ended`**（`defect_selectable` を数える時に、その理由が一つでも `shown` の時だけ数える）。期限切れの行しか無い時に「破損・不良・注文と違う品の申し込みだけ受ける」状態は、行の `defectSelectable` で画面が出し分ける（`defectOnly` の値は新しく作らない＝TS の許す値の一覧を増やさない）。
  - 申し込みの関数は、期限後の行に `size_*` を送れば `RETURN_NOT_ELIGIBLE` で断る（ステップ8とステップ10の組み合わせ）。
  - **`public.get_customer_return_request_materials`**（`20261020144842_order_return_customer_requests.sql:369`。後の移行に作り直しは無い。行の JSON は `:420-431` で `selectable`・`state` を出す）を最新の定義を1字も変えずに写し、`-- ACC_P4_BEGIN/END` で囲んで、行の JSON に `defectSelectable`（`customer_return_defect_lines` の値。無ければ0）を足す。同じ JSON の `return_ineligible` も今の `items.return_ineligible` ではなく、対象の `order_items.item_id` が注文の `order_return_terms_shown.return_ineligible_item_ids` に含まれるかで出す。行が無ければ偽。受付の判定と画面の印・選べる理由を同じ注文時の値にそろえる。private 本体があるか public だけかは実装時に `Read` で確かめ、同じ形（属性・ACL・`search_path`）を assert で確かめる。`src/lib/orders/returns/customer-return-store.ts` の `toRequestShipmentLine`（`:115-124`）に `defectSelectable` を足す。
- Produces（TS）: 行の型に `defectSelectable: number`。期限後の行は、`defectSelectable > 0` なら選べる理由を `defective`・`wrong_item` だけにし、「サイズ交換などの受付期間は過ぎましたが、破損・不良・ご注文と違う品は期限なくお受けします」を出す（文は `renderReturnTerms` の節②と同じ段落を通す）。`OrderReturnsSection` は `availability.returns === 'available'` の時に申し込みのボタンを出すので、上の DB の変更で期限切れの行だけの注文にも出る。注文の状況のページ・アカウントの画面の「受付を終了しました」の文は、`defectSelectable > 0` の行が1つでもあれば出さず、「破損・不良・ご注文と違う品は、期限なくお受けします。そのほかのご事情はお問い合わせください」を出す。
- **数が足りない品（入れ忘れ）:** 申し込みの理由に無いので、期限後でも申し込みの画面では扱わない。節②の「数が足りない品」と、期限後の案内の「お問い合わせから、期限に関わらずご連絡ください」でお問い合わせへ導く（未確認事項 #9）。
- **管理画面のお断りの理由 `window_passed`（「受付の期限を過ぎているため…」。`return-messages.ts:101`）:** 破損・不良・注文と違う品の申し込みには選ばせない（管理画面のお断りの画面で、その申し込みの行の理由が `defective`・`wrong_item` のものを含む時は `window_passed` を無効にして理由を出す）。選べる理由は `final_sale`・`other` のまま。
- S27 assert DETAIL `acc_s27_request_unchanged_outside_markers`・`acc_s27_materials_unchanged_outside_markers`・`acc_s27_availability_unchanged_outside_markers`・`acc_s27_admin_materials_unchanged_outside_markers`・`acc_s27_detail_unchanged_outside_markers`・`acc_s27_detail_attrs`（属性が前と同じで、本文は S27 後の固定の新しい MD5 と同じ）・`acc_s27_defect_lines`・`acc_s27_acl`・`acc_s27_existing_dml_allowlist`（DML は無い）。

- **7本の関数の印の読み方:** 地図の7本と、追加する管理画面の読み口2本の最新の定義を検索し、返品不可の印を読む所は全部、注文の `return_ineligible_item_ids` を読む形に替える。現時点で直接読むのは `customer_request_return`・`get_customer_return_request_materials`・`get_order_return_materials`・`return_detail_json`。`customer_return_line_states`・`customer_return_availability`・`fulfillment_line_returnable` にも実装時に直接の参照が見つかれば同じ形に替え、該当する S27・S28 の Files と本文の比べの assert に入れる（戻り型・引数・ACL は変えない）。設定の2本は商品の印を読まない。注文時に印が無かった品は後から印を付けても前の注文の通常の受付を狭めず、注文時に印があった品は後から外しても注文時の扱いのまま、相談の窓口を残す。印の記録の無い注文はすべて「返品不可でない」。

- **管理画面の材料と詳細（S27）:** `public.get_order_return_materials(_order_id uuid) RETURNS jsonb`（最新は `20261020150415_order_return_request_reviews.sql:450`）と `private.return_detail_json(_return_id uuid) RETURNS jsonb`（最新は `20261029130400_group_h_discounts_refunds.sql:2692`）も作り直す。2本の `return_ineligible` は、対象の元の注文明細の `order_items.item_id` が、その注文の `order_return_terms_shown.return_ineligible_item_ids` に含まれるかで返す。行が無ければ偽で、今の品の印は読まない。キー名・戻りの JSON の形・引数・属性・ACL・所有者は変えず、`src/lib/orders/returns/return-store.ts:608,754` から出る材料と詳細の警告も同じ注文時の値にする。本文は最新の定義を写して変更を `ACC_P4_BEGIN/END` で囲む。

- **注文時の記録を作る試験の道具:** `tests/integration/db/helpers/accounting-return-terms-fixtures.ts` に `recordOrderReturnTerms(db, orderId, ineligibleItemIds)` を作り、DB の試験と E2E の道具から呼ぶ。postgres の接続を引数で受け、`return_terms_snapshots`・`return_terms_renderings`・`order_return_terms`・`order_return_terms_shown` を外部キーの依存順に用意する（Task 3 の `inputs`・ハッシュと `renderReturnTerms` の文の控えの契約を使う）。既に注文の記録があればその `inputs_hash` に沿って控えを作り、記録や一覧を上書きしない。印の一覧はその注文の品だけに限る。DB の試験は呼び元と同じ接続・ROLLBACK の中で行い、E2E は `e2e/return-request-test-utils.ts` の postgres の `rr.db` と管理画面の道具の接続で行う。service_role へ INSERT の権限を足さない。`rr.setItem` で印を付けてからこの道具を呼び、試験対象の申し込みの前に注文時の条件をそろえる。注文後の印の変更を確かめる試験は、記録を作った後に印を変える。

- [ ] **Step 1: 失敗する試験を書く。** 注文時の記録は上の道具で作り、次の段ごとに分ける。
  - DB（ROLLBACK の形）: `FREQ-591-AC-01: 返品不可の品でも理由「その他」で申し込め、詳しい内容が無いと断る`、`FREQ-591-AC-01: 理由の設定で その他 を出さない時は返品不可の品も断る`、`FREQ-591-AC-01: 返品不可の品に サイズが小さい を送ると今のとおり断る`、`FREQ-591-AC-02: 破損・不良と注文と違う品は期限の翌日でも申し込める`、`FREQ-591-AC-03: サイズが小さい と その他 は期限の翌日に断られ、期限の当日の23:59:59 までは通る`（日本時間の日付で）、`FREQ-591-AC-04: 期限切れの行しか無い注文の availability が available になり、defect_selectable に返品できる数が入る`、`FREQ-591-AC-04: 期限内の行だけの注文の availability と、返品できる行が無い注文の ended は今のとおり`、`FREQ-591-AC-04: defect_selectable は返品済みの数を引いた数で、全部返品済みの期限切れの行は出ない`、`FREQ-591-AC-04: available の時は ended_on が空`、`FREQ-591-AC-04: 破損・不良と注文と違う品の理由を出さない設定では、期限切れの行だけの注文は今のとおり ended`、`FREQ-591-AC-04: 申し込みの画面の材料の行に defectSelectable が出る`、`FREQ-591-AC-02: 期限後に破損・不良と サイズが小さい を同じ申し込みに混ぜると全体を断る`、`FREQ-591-AC-07: 注文時に印が無い品へ後から印を付けても、期限内のサイズ交換を受付が通し、申し込みの材料も返品不可でないまま`、`FREQ-591-AC-07: 注文時に印がある品から後で印を外しても、サイズ交換は断り、その他の相談は受け、材料も注文時の値になる`、`FREQ-591-AC-08: 照合の道・直接作った注文と印の記録が無い注文は、今の品の印があっても返品不可でない`、`FREQ-591-AC-07: 管理画面の材料get_order_return_materialsと詳細return_detail_jsonも、注文後に印を付けても外しても注文時の値を返す`、`FREQ-591-AC-08: 管理画面の材料と詳細も、記録の無い注文は今の品の印があっても返品不可でない`、`FREQ-591-AC-07: 地図の7本と管理画面の2本に今の品の印で注文の受付や警告を決める参照が残らない`。
  - 並行（コミットする別の jest 実行）: `FREQ-591-AC-02: 同じ申し込みを同時に流しても1件`。
  - 単体: `FREQ-591-AC-04: 期限後の行は破損・不良・注文と違う品だけを選べる理由にする`、`FREQ-591-AC-01: 返品不可の品の選べる理由に その他 が入る`、`FREQ-591-AC-05: 期限後の案内にお問い合わせの案内が出る`、`FREQ-591-AC-06: 管理画面のお断りで、破損・不良の申し込みには window_passed を選べない`。
  - RTL: `FREQ-591-AC-04: 期限切れの行だけの注文で、合わない品の申し込みのボタンが出て、受付を終了しましたの文は出ない`（アカウントの画面と注文の状況のページの両方）、`FREQ-591-AC-07: 注文時の値の材料から返品の印と選べる理由が出て、注文後に変えた品の印を使わない`、`FREQ-591-AC-07: 管理画面の作成と詳細の警告は返ってきた注文時の値にそろう`、`FREQ-591-AC-08: 記録の無い注文の材料では返品不可の警告を出さない`。
- [ ] **Step 2（controller）: RED を測る。**
- [ ] **Step 3: S27 と TS を実装する。** H5 の基準（`h5_function_baseline`）の対象14本に `private.return_detail_json(uuid)` が入る。S27 の前後で引数・戻り型・属性・ACL・`search_path`・所有者が同じことを確かめる。H5 の末尾の確かめは属性と本文の MD5 を比べるので、`acc_s27_detail_attrs` は属性の維持と S27 後の本文の固定 MD5 を検査する。本文は注文時の印を読む所だけ囲みで直し、囲みを全部除いた本文は最新の定義と比べる。`group_h_migration_asserts` の `FREQ-551-AC-02` は計画3と同じく新しい MD5 と囲みを除いた比べ方を期待にする。新しい MD5 は実装した S27 の本文から CR を除いて算出し、試験の固定の期待値に置く（DB の今の本文から期待値を作らない）。適用済みの H5 の移行は編集せず、試験が流し直す確かめの SQL の期待を替える。H4 の末尾の確かめにも入っていない（2026-11-04 に確認）。実装時に `grep` で数え直し、入っていたら Files に足して報告する。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify。返品の既存の suite（`order_return_*`・`group_g1_return_*`・`order_status_returns`・`group_g2_public_function_acl` ほか、関数を触る物を `grep` で数える）が、意図して直した所以外は無改造で通る。`return_postgrest.integration.test.ts` は Files の「意図して直す」側で、注文時の記録を作る fixture とその期待以外の題・期待は保つ。`group_h_migration_asserts` の `FREQ-551-AC-02` も意図して直す側で、新しい本文の MD5 は通り、本文を1字変えた物は `h5_return_amounts` で断ることを確かめる。返品の E2E（`FR-ACCOUNT-035〜038・045`・`FR-ADMIN-084〜099`）を production build で流す。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(returns): 返品不可の品にもその他を開き、合わない品を期限で締めないようにする`

### Task 10: 期限（目安の既定・法律の8日の別の数え方・遅れの案内）

controller が別セッションへ先に知らせる（`private.fulfillment_line_returnable`・返品の期限を見せる画面）。Task 9 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-592 の行）
- Create: `supabase/migrations/<ts28>_accounting_p4_return_deadline.sql`、`tests/integration/db/accounting_p4_return_deadline.integration.test.ts`
- Modify: `src/lib/orders/returns/customer-return-messages.ts`（`past_deadline` の文にお問い合わせの案内を足す〔`:67`〕）、`src/features/account/returns/return-request-model.ts`（期限切れの案内）、`src/components/ShopReturnSettingsSection.tsx`（目安の日数の説明文に「届くのに一番長くかかる日数」を書く。入力欄は変えない）、`src/lib/orders/email/order-email-compose.ts`（期限を書く文があれば、期限の数え方〔`届いた日を数えない`〕と同じ言い方にそろえる。実装時に `Read` して、無ければ触らない）、`tests/unit/lib/orders/returns/customer-return-messages.test.ts`
- Modify（意図して直す既存の試験。題は変えない）: `tests/integration/db/group_g1_return_requests.integration.test.ts`・`order_return_records.integration.test.ts`・`delivery_tracking_admin.integration.test.ts`・`order_return_actions.integration.test.ts` のうち、`delivery_buffer_days` の既定3日や期限の日付を固定している所の期待。`changed-tests.md` に表で報告する。
- Read: `supabase/migrations/20261021221140_delivery_tracking_admin.sql:1294-1362`（`private.fulfillment_line_returnable` の最新の定義。配達の日があればそれを使い、無ければ発送の日＋`delivery_buffer_days`）、`20261012235910_order_return_records.sql:472-474`（`delivery_buffer_days` の既定と CHECK 0〜14）、設計 14-e

**Interfaces:**
- Consumes: Task 1 の `shopReturnDeadline`・`statutoryReturnDeadline`、Task 8 の `order_return_terms`（注文の記録）。
- Produces（DB。S28）:
  - **目安の既定:** `shop_return_settings.delivery_buffer_days` の列の既定を `N` にする（`ALTER COLUMN ... SET DEFAULT N`）。`N` は「届くのに一番長くかかる日数」で、**controller が実装の最初（Step 0）に運送会社〔ヤマト運輸・佐川急便・日本郵便〕の公表している配達日数の目安から決め、決めた根拠をオーナーへの報告に載せる**（暫定: 7。CHECK の上限は14のまま変えない）。設定の1行は `UPDATE ... SET delivery_buffer_days = N WHERE id = 1 AND delivery_buffer_days = 3`（3日のままの時だけ。人が3以外に変えた値は変えない〔FREQ-592-AC-02〕。受付の日数だけを直した設定でも更新される。目安は同じ「window」のまとまりだが、`window_updated_by` は見ない）。3日のまま更新しなかった時は Task 14 の報告に示す。
  - **注文の時の記録から読む（中-5）と、法律の8日の別の数え方:** `private.fulfillment_line_returnable(uuid)` の最新の定義を1字も変えずに写し、足す所を `-- ACC_P4_BEGIN/END` で囲んで、①`window_days`・`window_start` を、その注文に `order_return_terms` の行があれば記録の `inputs`（`windowDays`・`windowStart`。`return_terms_snapshots.inputs`）から読み、無ければ今の設定から読む（注文の後に店が日数を変えても、約束した条件で締まる。14-a・14-f）。②`deadline_date` の `CASE` の結果を、**その注文に見た版の結び（`order_return_terms_shown`）が無い時だけ** `GREATEST(<今の期限>, arrival_date + 7)` にする。`arrival_date + 7` は届いた日を1日目に数えた8日目（特定商取引法15条の3 1項「引渡しを受けた日から起算して八日」。設計 14-e 2回目の直し5）。結びが無い注文は、記録の無い注文のほか、照合の道で作った注文・直接作った注文で、特約を見せた証拠が無い（Task 8）。店の期限（`arrival_date + window_days`。届いた日を数えない）とは別の式。**標準の設定（受付の日数7日）では店の期限と8日目が同じ日なので、結びが無い注文の既存の試験の期待は変わらない。** `window_days IS NULL`（無制限）の時は `NULL` のまま。戻り型・列・ACL は変えない。
  - 配達の日（追跡）がある時の数え方は今のまま（`delivered_at` の日本時間の日を使う。設計 14-e「追跡をオンにした後は配達の日で数える」）。
- Produces（TS）: 期限切れの案内に「商品が届くのが遅れた場合は、お問い合わせからご連絡ください」を足す（FREQ-592-AC-05）。画面の期限の表示は `shopReturnDeadline` を使う（二重の数え方を作らない）。
- S28 assert DETAIL `acc_s28_returnable_unchanged_outside_markers`・`acc_s28_default`・`acc_s28_acl`・`acc_s28_existing_dml_allowlist`（DML は設定の1行だけ）。

- [ ] **Step 0（controller）: 目安の日数 `N` を決める。** 運送会社の公表している配達日数の目安を、離島・北海道・沖縄・年末年始・繁忙期を含めて読み、最長の日数を決める。決めた値と根拠（出典・読んだ日）を `.superpowers/sdd/2026-11-04-accounting-p4/delivery-days.md` に残し、オーナーへの報告に載せる（未確認事項 #1）。`N` が14を超えるなら止めて報告する。
- [ ] **Step 1: 失敗する試験を書く。** DB は ROLLBACK の形。`FREQ-592-AC-01: 10/10 に発送して目安 N で届いたとみなす時、文の期限（届いてから7日）より早く締まらない`（発送 10/10・実際に届いた日 10/15・目安 N=7 なら届いたとみなす日 10/17、期限 10/24。10/21 の申し込みが通る）、`FREQ-592-AC-01: 初期の目安3日だと同じ申し込みが10/20 で締まる（修正前の確認）`（修正前の確認として書き、今の結果ではないと明記する）、`FREQ-592-AC-02: 初期のままの目安は新しい既定に更新され、人が変えた値は変わらない`、`FREQ-592-AC-03: 見た版の結びが無い注文は、店の期限が法律の8日より早ければ8日目まで受ける`（受付の日数3日の記録を持つ結びの無い注文で用意する）、`FREQ-592-AC-03: 照合の道で作った注文（結びが無い）も同じ`、`FREQ-592-AC-03: 見た版の結びがある注文は店の期限のまま`、`FREQ-592-AC-07: 注文の後に店が受付の日数を変えても、記録のある注文は注文の時の日数で締まる`、`FREQ-592-AC-07: 記録の無い注文は今の設定から読む`、`FREQ-592-AC-03: 期限が無制限なら記録が無くても無制限`、`FREQ-592-AC-04: 店の期限は届いた日を数えず、法律の8日は届いた日を1日目に数える（10/15 着なら どちらも 10/22）`、`FREQ-592-AC-06: 配達の日があればそちらで数える`。単体: `FREQ-592-AC-05: 期限切れの文に届くのが遅れた時のお問い合わせの案内が出る`。
- [ ] **Step 2（controller）: RED を測る。** 修正前の確認は過去の確認として書く（今の結果ではない）。
- [ ] **Step 3: S28 と TS を実装する。** `fulfillment_line_returnable` を使う関数（`customer_return_line_states`・`get_order_return_materials`・申し込みの関数）は本文を変えず、新しい `deadline_date` を自然に使う。H5 の基準の対象かを確かめる。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify。返品の既存の suite を、意図して直した所以外は無改造で流す。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(returns): 返品の受付の期限が文の期限より早く締まらないようにする`

### Task 11: 設定の画面（添える文・プレビュー・警告）

controller が別セッションへ `ShopReturnSettingsSection.tsx` と `ShopSettingsSection.tsx` の変更を先に知らせる。計画3 Task 2・11 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-593 の AC-02〜04 の行）
- Modify: `src/components/ShopReturnSettingsSection.tsx`（702行。まとまり「お客様に見せる文」を足す〔添える文の入力・文字数・プレビュー・警告〕。ほかのまとまりは変えない）、`src/components/ShopSettingsSection.tsx`（保存後にプレビューを更新する呼びだけ）、`tests/unit/components/ShopReturnSettingsSection.test.tsx`（既存の46件は無改造で通る。新しい題を足す）、`tests/unit/components/ShopReturnTermsPreview.test.tsx`
- Create: `src/components/ShopReturnTermsPreview.tsx`
- Read: `src/components/ShopReturnSettingsSection.tsx`（全体。まとまりごとの保存の流儀・計画3 Task 2 で無効にした手数料の欄）、`src/app/admin/page.tsx:245`

**Interfaces:**
- Consumes: Task 1 の `renderReturnTerms`・`describeReturnTermsWarnings`、Task 2 の `contractNote`。
- Produces: まとまり「お客様に見せる文」。①添える文（500字まで。「素材の風合いなど、契約の内容の説明を書きます。返品の条件ではありません」の説明つき）、②プレビュー（今の画面の入力から `inputs` を組み、`renderReturnTerms` で作った文を `ReturnTermsBlock` で見せる。**保存前の入力でも描く**〔保存前の確認〕）、③警告（`describeReturnTermsWarnings` の `message` を表示）。保存は既存の `PUT /api/admin/settings/shop` の `returns.contractNote`。権限が無い人（サポーター）は編集できない（今のとおり）。保存した後は `publish` が走るのを待たず、お客様が読む時に Task 4 の `loadReturnTerms` が控えを登録する。

- [ ] **Step 1: 失敗する試験を書く。** RTL: `FREQ-593-AC-01: 添える文を編集して保存でき、501字目は入らない`、`FREQ-593-AC-01: 権限が無い人は添える文を保存できない`、`FREQ-593-AC-02: プレビューが公開の文と同じ段落を出す（同じ inputs で比べる）`、`FREQ-593-AC-02: 理由を出す出さないを変えるとプレビューが保存の前に変わる`、`FREQ-593-AC-03: 説明と違うを出す設定で警告が出る`、`FREQ-593-AC-03: shop_label でお客様負担の理由がある設定で警告が出る`、`FREQ-593-AC-04: 390/768/1280px で横にはみ出さない`（E2E は Task 12）、`FREQ-593-AC-01: 非 ok の応答の本文を読み切る`。
- [ ] **Step 2（controller）: RED を測る。**
- [ ] **Step 3: 実装する。** プレビューは文を持たず、`renderReturnTerms` の出力を描くだけにする。
- [ ] **Step 4: GREEN を測る。** 単体、型、lint。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(admin): 返品の設定の画面に添える文とプレビューを足す`

### Task 12: 新しい E2E

controller が別セッションへ `docs/05_Quality/tests/test-spec.md` の更新を先に知らせる。

**Files:**
- Create: `e2e/FR-ITEM-DETAIL-069-return-terms-note.spec.ts`、`e2e/FR-CHECKOUT-059-return-terms-final-confirmation.spec.ts`、`e2e/FR-CHECKOUT-060-order-return-terms-record.spec.ts`、`e2e/FR-RETURNS-001-return-terms-page.spec.ts`、`e2e/FR-FOOTER-002-return-terms-link.spec.ts`、`e2e/FR-LEGAL-007-return-terms-legal.spec.ts`、`e2e/FR-TERMS-006-return-terms-clause.spec.ts`、`e2e/FR-ACCOUNT-047-return-request-after-deadline.spec.ts`、`e2e/FR-ADMIN-141-return-terms-settings.spec.ts`（番号は実装時に `ls e2e` で最大を取り直して確かめる）
- Modify: `e2e/return-request-test-utils.ts`・`e2e/order-admin-test-utils.ts`（返品不可の品・期限後の発送・設定の変更の fixture と、Task 9 の `recordOrderReturnTerms` を呼ぶ道具を足す。**既存の関数の動きは変えない**）、`e2e/return-terms-test-utils.ts`（新規。設定を変えて元に戻す道具・文の取得）、Task 5〜10 で意図して直した既存の E2E（期待の文字と注文時の記録を作る fixture を直す。`FR-ADMIN-099` は管理画面の材料・詳細の警告が注文時の値でそろうことも確かめる。題は変えない）
- Test: 新規の E2E ＋ 既存の返品・商品詳細・最終確認・特定商取引法・規約・フッターの E2E の回帰
- Read: `e2e/FR-ITEM-DETAIL-066-return-ineligible.spec.ts`、`e2e/FR-CHECKOUT-037-final-confirmation-screen.spec.ts`、`e2e/FR-LEGAL-006-return-policy.spec.ts`、`e2e/FR-FOOTER-001-nav-link-spacing.spec.ts`、`e2e/FR-ACCOUNT-035-return-request.spec.ts`、`e2e/FR-ADMIN-092-shop-return-settings.spec.ts`、`e2e/admin-session-test-utils.ts`

**Interfaces:**
- Consumes: S24〜S28・route・画面。実 route の aal2/live-session は `createAdminSessionActor(db,role,aal)`。Stripe は呼ばず、注文は DB に直接入れる（`FR-CHECKOUT-060` は place-order の route を呼ぶ既存の helper が使えるかを `Read` で確かめ、使えなければこの Task の Files の道具を拡張して新しい AC-08・AC-09 の E2E を組む。組めない間は未確認として controller に知らせ、単体・DB の成功を E2E の成功に代えず GREEN としない）。
- Produces: 設定を変える E2E は、元の設定に戻す後始末を `finally` で行う（設定の表は消せるが、他のテストと並列でぶつけない。`--workers=1` の spec にまとめる）。設定を変えるテストは試験ごとに固有の IP。3つの幅（390/768/1280px）で確かめる。

| spec | 新規テストの正確な題と assert（各 390/768/1280px） |
| --- | --- |
| ITEM-DETAIL-069 | `FREQ-587-AC-01: ふつうの品の価格の近くに可否・条件・送料の3つとリンクが出る`、`FREQ-587-AC-02: 一文の文字の大きさが価格の大きさ以上`（価格の実測値を test の注釈に出す。12ポイント＝16px の読み方は「決めたこと」のとおり）、`FREQ-587-AC-03: 返品不可の品は返品不可（ご相談可）と送料の負担が出て、同じ大きさ`、`FREQ-587-AC-01: 設定で期限の日数を変えると一文が変わる` |
| CHECKOUT-059 | `FREQ-588-AC-01: 最終確認の画面の品ごとの行に印が出る`、`FREQ-588-AC-02: 返品についての段に文と送料の負担とリンクが出る`、`FREQ-588-AC-03: 写真が必須の理由がある時、申し込みの方法の条件が画面に出る`、`FREQ-588-AC-04: 返品不可の品にも相談の窓口が出る`、`FREQ-588-AC-06: 横にはみ出さない` |
| CHECKOUT-060 | `FREQ-590-AC-05: 画面を開いた後に返品の設定を直して注文すると、注文を作らず確認へ戻り、文が新しくなり、決済の画面はそのままで1回の押し直しで注文できる`、`FREQ-590-AC-01: 注文すると注文の記録に見た版が残る（DB 経由で確かめる）`、`FREQ-590-AC-08: 最終確認で見せて入口で一致した返品不可の品の番号の一覧が注文に残り、注文後に印を変えても記録は変わらない`、`FREQ-590-AC-09: 最終確認の後、入口で比べる前に品の印を付けても外しても、注文を作らず確認へ戻って印が更新され、押し直した注文には新しく見せた一覧が残る` |
| RETURNS-001 | `FREQ-587-AC-05: 返品についてのページが全部の節を出す`、`FREQ-587-AC-06: 横にはみ出さない`、`FREQ-587-AC-04: フッターのリンクから返品の条件の節へ直接開く` |
| FOOTER-002 | `FREQ-587-AC-04: トップ・商品ページ・カート・決済の画面のフッターに返品についてのリンクが出る`、`FREQ-587-AC-04: 押すと /returns に移る` |
| LEGAL-007 | `FREQ-589-AC-01: 特定商取引法の表記の返品の項が返品についてのページの節と同じ段落を出す`、`FREQ-589-AC-03: 5か所の段落が一致する（商品ページ・最終確認・特定商取引法・規約・返品についてのページ）` |
| TERMS-006 | `FREQ-589-AC-02: 第6条が返品に関するお知らせの見出しで分かれ、目次からたどれる` |
| ACCOUNT-047 | `FREQ-591-AC-01: 返品不可の品でも その他 で申し込める`、`FREQ-591-AC-02: 期限後でも破損・不良は申し込める`、`FREQ-591-AC-04: 期限切れの行だけの注文でも申し込みのボタンが出る（アカウントの画面と注文の状況のページ）`、`FREQ-591-AC-03: 期限後にサイズの理由は選べない`、`FREQ-592-AC-05: 期限後の画面にお問い合わせの案内が出る`、`FREQ-591-AC-07: 注文時の記録を作った後に品の印を付けても外しても、返品の印と選べる理由は注文時の条件のまま`、`FREQ-591-AC-08: 記録を付けない注文は、今の品が返品不可でもサイズ交換を選べる` |
| ADMIN-141 | `FREQ-593-AC-01: 添える文を保存すると公開の文に出る`、`FREQ-593-AC-02: プレビューが保存の前に変わる`、`FREQ-593-AC-03: 警告が出る`、`FREQ-593-AC-01: サポーターは保存できない`、`FREQ-593-AC-04: 横にはみ出さない` |

- [ ] **Step 1: 上表の失敗する試験を書く。** helper をまだ実装しない。表示の確かめと DB 経由の確かめを test-spec に分けて明記し、実 Stripe の証拠と誤記しない。
- [ ] **Step 2（controller）: RED を測る。** production build/手元 DB を用意し、新 spec を `--workers=1 --retries=0` で流す。helper 未定義の失敗は道具の RED であり、画面の回帰の RED とは言わない。
- [ ] **Step 3: helper と spec を接続する。** exact な role/name を使い、応答の本文を読み切る。rate-limit を全体で無効にせず IP を分ける。
- [ ] **Step 4（controller）: GREEN を測る。** `npm.cmd run build` 後、port3000 の production server で新 spec と既存の返品・商品詳細・最終確認・特定商取引法・規約・フッター・会計の E2E を 390/768/1280 を `--retries=0` で流し、件数・pass/fail/skip を実測で記録する。3000番に残った E2E 用でないアプリを先に止める。
- [ ] **Step 5（controller）: Files だけコミットする。** `test(returns): 返品の条件の表示と受付と注文の記録のE2Eを追加する`

### Task 13: 文書の正本の更新

controller が別セッションへ先に知らせる（`db-migrations.md`・`test-spec.md`・台帳・`docs/06_Operations/README.md` は共有の文書）。会計・返品は `scripts/trace/scope.json` の範囲の外なので、CLAUDE.md の「範囲に入っていない領域」の表に従い、同じコミットで直す。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-585〜593 の6列の行。各 Task が足した物を確かめ、足りない行を足す）、`docs/03_BasicDesign/api/api-spec.md`・`route-inventory.md`（`GET /api/return-terms`、place-order の本文 `returnTerms` と再確認の応答、返品の材料の `defectSelectable`、設定の route の `returns.contractNote`）、`docs/03_BasicDesign/data/er.md`（S24 の列、S25・S26 の4表）、`docs/03_BasicDesign/ui/screen-list.md`・`screen-flow.md`（`/returns`、フッターのリンク、最終確認の画面の返品の段、設定の画面）、`docs/03_BasicDesign/architecture/`（文の元の流れ：設定 → inputs → 文 → 注文の記録）、`docs/04_DetailDesign/pages/` の商品詳細・決済・特定商取引法・規約・フッター・返品の申し込み・設定の頁、`docs/05_Quality/tests/test-spec.md`（手で書く）、`docs/06_Operations/db-migrations.md`（S24〜S28 の目的・適用順・assert・戻し方。作り直した関数の一覧と、直した既存の試験の表）、`docs/06_Operations/README.md`、`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`（台帳の返品の条件の表示・注文の記録の状態欄）
- Create: `docs/06_Operations/accounting-p4-return-terms.md`
- Test: `npm.cmd run validate-docs`、`npx.cmd jest tests/unit/docs --runInBand`

**Interfaces:**
- Consumes: Task 1〜12 の確定した名前と route。
- Produces: `accounting-p4-return-terms.md`: ①文の作り方（設定 → inputs → 文。文を直す所は `renderReturnTerms` の1か所だけ。文の版を上げる条件）、②設定を直すと反映される時間（キャッシュの長さ）と注文の記録の関係（見た版が違えば確認へ戻る）、③注文の記録の見方（注文 → 記録 → 中身。後で設定を変えても変わらないこと）、④受付の期限（店の期限と法律の8日の別の数え方・目安の日数 `N` とその根拠・記録の無い注文の扱い）、⑤合わない品の扱い（期限で締めない・数が足りない時の窓口）、⑥文の確定にオーナーの確認が要る所、⑦本番で試しの注文を作らない決まり。
- Produces: 各文書の冒頭の確認日の更新。`docs/05_Quality/reports/traceability-report.md` は自動生成なので手で直さず `npm run report:traceability` で作り直す。更新不要と判断した文書は理由を完了報告に1行書く。

- [ ] **Step 1: 文書を直す。** 上の Files の順に、Task 1〜12 の実装の確定後の名前で書く。
- [ ] **Step 2: 検証する。** `npm.cmd run validate-docs` と `npx.cmd jest tests/unit/docs --runInBand` が通る。`npm.cmd run report:traceability` の生成差分を確認し、要求表から全新 AC の試験まで辿れる。
- [ ] **Step 3（controller）: Files だけコミットする。** `docs(returns): 計画4の返品の条件の表示の正本を更新する`

### Task 14（controller）: 全体検証・最終レビュー・本番を読む・適用・記録

controller が別セッションへ `docs/06_Operations/db-migrations.md`・`test-spec.md`・台帳の更新を先に知らせる。**前提: 計画1の S0〜S5、計画2の S6〜S14、計画3の S15〜S23 が本番に当たっていること**（当たっていなければここで止め、計画1〜3の最後の controller の Task を先に終える）。

**Files:**
- Create: `.superpowers/sdd/2026-11-04-accounting-p4/progress.md`、`final-review.md`、`production-pre-read.md`、`verification-report.md`、`report-to-owner.md`、`changed-tests.md`（Task 7〜10 の記録）、`delivery-days.md`（Task 10 Step 0 の記録）
- Modify: `docs/06_Operations/db-migrations.md`、`docs/05_Quality/tests/test-spec.md`、`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`、この計画のチェックボックスと未確認事項。生成レポート/graph は生成手順の出力として確認する
- Test: 計画4の全単体/DB/並行/PostgREST、計画1〜3・G・H・checkout・refund・return・status・email の回帰、E2E 全件

**Interfaces:**
- Consumes: Task 1〜13 のコミット一覧、計画1〜3の最後の controller の Task の記録、最新 E2E baseline（`.superpowers/sdd/2026-10-26-group-g4-orders/e2e-results-g4-full.json` を `flattenPlaywrightJson` で直して渡す）。
- Produces: `verification-report.md` はコミット/差分範囲/コマンド/RED・GREEN の実測件数/未実行境界/3連続の並行の結果/最新 baseline との差分/作り直した関数の既存の試験で直した所の一覧を残す。`final-review.md` は最終 Opus レビュー（実作業は Codex または Sonnet、レビューは Opus）の対象コミット・指摘・修正コミット・再検証を残す。
- Produces: **適用の順は S24→S25→S26→S27→S28。** push はしない。

- [ ] **Step 1: 検証の判定を先に固定する。** 必須 assert: `FREQ-585-AC-02: 合わない品の節に7日の打ち切りも返金はしないの形も無い`、`FREQ-585-AC-04: 設定を変えると文が変わる行列`、`FREQ-589-AC-03: 5か所の文の段落が一致する`、`FREQ-590-AC-03: 設定を直す人と同時に注文が入っても記録は確定した状態の1つ`、`FREQ-590-AC-05: 見た版と現在が違えば注文を作らず確認へ戻す`、`FREQ-590-AC-07: 注文を作っても仕訳が増えず、決済の関数の本文が変わらない`、`FREQ-591-AC-02: 破損・不良と注文と違う品は期限を過ぎても申し込める`、`FREQ-591-AC-03: サイズなど特約の理由は期限で締まる`、`FREQ-592-AC-01: 文の期限より早く締まらない`、`FREQ-592-AC-04: 店の期限と法律の8日が別の数え方`。最新 baseline の commit/build/DB 前提から比較し、古い件数を転記しない。
- [ ] **Step 2: 追加試験の RED と各 Task の GREEN の証拠を照合する。** 欠けた RED/DB/provider の境界は未実施と書き、必要な再現を手元で実行する。全 SQL を reset して S0〜S28 と G・H の回帰、PostgREST、並行3連続を通す。**作り直した関数**（地図の7本のうち作り直す6本 `get_shop_return_settings`・`admin_update_shop_return_settings`・`customer_request_return`・`customer_return_availability`・`get_customer_return_request_materials`・`fulfillment_line_returnable`。`customer_return_line_states` は作り直さない）と、**新しい関数**（`place_order_with_return_terms`・`customer_return_defect_lines`）の既存の試験と、**`orders` にトリガーを足したこと**に関わる決済・注文・清掃の既存の試験が、意図して直した所以外は無改造で通ることを明記する。
- [ ] **Step 3: 単体・型・lint・docs・security を最終本文で実行する。** `npx.cmd jest tests/unit --runInBand`、`npx.cmd tsc --noEmit --incremental false`、`npm.cmd run lint`、`npm.cmd run validate-docs`、`npx.cmd jest tests/unit/docs --runInBand`。implement-component/security-check の現行 skill を読んで指定の機械検証を行う（公開の route は個人情報を返さない・回数制限・本文の読み切りを確かめる）。
- [ ] **Step 4: production build で E2E 全件を実行し baseline と比べる。** `npm.cmd run build` → 既存の E2E 起動手順 → `npx.cmd playwright test --retries=0` → `npm.cmd run e2e:compare`。新規/置換/失敗/skip をファイルと題で説明する。計画4以外の既存の赤は勝手に直さず、前に通って後で落ちたものは単独で再実行して揺れか実装かを切り分ける。3000番に残るアプリは先に止める。
- [ ] **Step 5: 最終 Opus レビューを受ける。** Review Focus の5行・設計の行の対応表・未確認事項・作り直した関数の差分（囲みの外が変わっていないこと）を渡す。重大/中を直したら影響する DB reset/build/E2E を再実行する。
- [ ] **Step 6: 本番を先に読む（数だけ。書かない）。** Supabase MCP の `execute_sql` で次を数える: 計画1〜3の移行が当たっていること（`accounting_journal_entries`・`accounting_refund_events`・`order_return_arrival_corrections` の表があること）、`orders` の払い済みの件数と全件（0〜試しだけのはず）、`order_returns`・`order_return_receipts` の件数、**`shop_return_settings` の `delivery_buffer_days`（3のままか。S28 の更新の条件）**、`contract_note` の列が無いこと（S24 の前提）、`shop_return_reason_settings` の10行、S24〜S28 のバイト数/MD5/ASCII/1組の取引/末尾 assert。結果は `production-pre-read.md` へ数だけ書く（金額・中身・相手を書かない）。想定と違えば適用せず理由とともにオーナーへ示す。本番の Stripe には触らない。
- [ ] **Step 7: オーナーへ適用の判断を求める。** `report-to-owner.md` に、使える物、設計の行の対応、実測/未実測、本番を読んだ数、未確認事項、次を載せる: S24〜S28 を適用してよいか。適用で本番の DB に入るのは列・表・関数・トリガー・設定の1行の更新だけで、注文・返品・仕訳の行は増えない（本番の注文は0件）。無回答を承認としない。
- [ ] **Step 8: 承認された範囲だけ適用し、読むだけで確かめる。** 既存の controller 手順で適用する（`supabase/migrations` との名前の一致を `list_migrations` で確かめ、適用した文は `schema_migrations` の `md5(statements[1])` とファイルを突き合わせる。大きい移行は MCP でなく CLI の `db push --linked`。S27・S28 は既存の関数の作り直し）。適用後の確かめは**読むだけ**: S24〜S28 の assert の結果、`contract_note` が初期値、`delivery_buffer_days` が `N`（人が変えていなければ）、3つの新しい表が空、`orders` のトリガーに `acc_p4_orders_record_return_terms` があること、作り直した関数の本文の MD5 が手元の期待と同じこと、権限の件数が計画3の後のままであること。**本番に書いて確かめることはしない**（注文を作らない）。トリガーの動作・文の公開・注文の記録は手元の DB だけで確かめる。失敗は固定 SQLSTATE/DETAIL/適用済みの位置を残して止め、データの戻しを即興で実行しない。
- [ ] **Step 9: 記録を更新して Files だけコミットし、graph フックの結果を確認する。** 実装コードの最終変更後・commit 前に `graphify update .` を1回だけ完了し、進捗/レビュー/検証/適用の記録を更新して `docs(returns): 計画4の検証と本番適用結果を記録する` でコミット。commit 後は `graphify hook status` を確認するだけで手動 update を重ねない。未適用なら明記し、push しない。

## 未確認事項

設計として決められなかった所と、実装・本番・外部サービスの読み取りで確かめる所。推測で埋めていない。

| # | 内容 | 確かめる Task / 決め方 |
| --- | --- | --- |
| 1 | **届くのに一番長くかかる日数 `N`（14-e の目安）。** 設計 16章は「運送会社の目安を作る時に確かめる」とする。暫定値は7日（CHECK の上限は14）。目安を長くすると、届くのが早かった注文の受付期限は長くなる（文の期限より早く締まらない側に倒れる） | Task 10 Step 0。運送会社の公表値を読み、根拠をオーナーへ報告。オーナー承認 |
| 2 | **文の言い回しの確定。** 規則表の文言は設計 14-2・14-3 の例に沿った案。特に「まず交換か修理で対応し、できない時は返金します」「サイズ交換は…タグの付いた未使用の品に限って」「複数回に分けてお届けする場合は最後の品の到着の翌日から」。法律の言い回しの最終確認は弁護士・消費者庁の窓口での確認が望ましい | オーナーに報告。開店前に確認 |
| 3 | **公開の文のキャッシュの長さ。** 商品ページは30秒、特定商取引法の表記・規約・返品についてのページは60秒。設定を直してからお客様の画面に反映されるまでこの時間がかかる。最終確認の画面は `?fresh=1` でキャッシュを使わず、断りの応答にも今の文を載せる。注文の記録は place-order の入口の比べで守る | AI の判断。オーナーが覆せる |
| 4 | **トリガーの失敗の扱いは道で分ける。** トリガー自体は失敗しても注文を止めない（照合の道で、お金を取った注文を作れなくならないため）。「注文する」の道は、新しい入口が記録の有無を確かめ、無ければ注文ごと取り消す（未払いなので安全）。記録の無い注文は見た版の結びが無いので、期限は法律の8日に戻る。失敗の WARNING を監視する | AI の判断。オーナーが覆せる |
| 5 | **添える文の欄は新しい列 `contract_note`。** 既存の `notice_text`（≤2000字。申し込みの注意書き）とは別にした（素材の風合いは契約の内容の説明で、申し込みの注意書きとも返品の特約とも別の所に出すため）。`notice_text` の使い道は変えない | AI の判断。オーナーが覆せる |
| 6 | **「説明と違った」（`not_as_described`）を出す設定。** 標準では出さない。出すと、特約の理由（期限で締まる）なのか、契約の内容に合わない品なのかが設定だけでは決まらない。計画4は期限で締めない理由を `defective`・`wrong_item` に限り（設計 14-a3）、この理由を出す時は設定の画面に警告を出す | オーナーに報告。出す時は設計に足してから |
| 7 | **返送の方法 `shop_label`（店の送り状）と送料の負担。** 計画3で送り状の費用を0に固定したため、`customer_paid_method='shop_label'` でお客様負担の理由があると「お客様負担」が実際は0になる。文は理由ごとの `shippingPayer` だけで書き、この組み合わせは警告を出す | オーナーに報告。使うなら設計に足す |
| 8 | **（決まった）12ポイントの読み方。** 12pt＝16px。ガイドラインの数は例なので、一文は価格の大きさ以上にそろえる | 「決めたこと」へ移した |
| 9 | **数が足りない品（入れ忘れ）の申し込み。** 今の理由の一覧（`RETURN_REASONS`）に無く、申し込みの画面では出せない。文では節②に含め、期限後の案内でお問い合わせへ導く。理由を足す（`missing_item`）かは決めていない | オーナーの確認。足すなら DB・TS・理由の設定の表に変更が要る |
| 10 | **（決まった）メールの文。** 注文確認メールに返品の条件の手書きの文は無い。計画4は触らない | 「決めたこと」へ移した |
| 11 | **英語・多言語。** お客様向けの画面は日本語のみ。多言語に広げる時は `renderReturnTerms` の文を言語ごとに持つ | 将来 |
| 12 | **「返品について」の新ページ `/returns` の公開日と検索エンジン。** 開店前なので公開しても内容は変わらないが、`sitemap`・`robots` に載せるかは決めていない | オーナー |
| 13 | **店頭・現金の返品。** 設計 14章は通販の画面だけ。店頭の返品の条件の文は扱わない（計画3の「通販のカード払いの返金だけ」と同じ） | 将来 |
| 14 | **設定を直した直後の注文。** 最終確認で見た版が現在と違うと確認へ戻す（Task 8）。応答に今の文を載せるので、1回の押し直しで注文できる。それでも設定を頻繁に直すと戻る注文が増えるので、開店後の設定の変更は注文の少ない時間にする運用の文書を Task 13 に書く | Task 13 |
| 15 | **（決まった）返品不可の印は注文の時の値を注文ごとに残す。** 記録の無い注文は「返品不可でない」とする | 2026-11-05 オーナー決定。「決めたこと」へ移した |
| 16 | **（決まった）「その他」の相談の期限は今の計画のまま。** 破損・不良・注文と違う品だけ期限で締めず、その他は期限後にお問い合わせへ案内する | オーナー決定。「決めたこと」へ移した（中身は変えない） |

## オーナーへの報告（Task 14 の `report-to-owner.md` に載せる）

- 返品の条件の文は、設定から1つ作る。商品ページ・最終確認の画面・特定商取引法の表記・利用規約・新しい「返品について」のページが同じ文になる。設定を直せば全部が変わる。素材の風合いなどの添える文は、設定の欄に1つだけ持つ。
- 文は、お客様のご都合の返品・交換（返品の特約）と、契約の内容に合わない品（破損・不良・注文と違う品・数が足りない品）を分けて書く。合わない品は「7日を過ぎたら受けない」と書かず、「お気づきの時はお早めに」と書く。受付の作りも同じで、破損・不良と注文と違う品は期限を過ぎても申し込める。サイズ交換などは今までどおり期限で締まる。
- 返品不可の品にも、「その他」でご相談の申し込みができるようになる（今は破損・不良と注文と違う品だけ）。理由の記入は必須。
- 商品ページは、全部の品の価格の近くに、返品できるか・条件・送料の負担（返品不可の品にも）と詳しくのリンクを出す。大きさは価格と同じ以上にそろえた（12ポイント＝16px。価格の実測値は報告する）。
- フッターに「返品について」を足し、全ページと決済の画面から返品の条件へ直接開く。
- 最終確認の画面は、品ごとの行に返品の印を出し、写真が必須の理由などは画面そのものに出す。文を取れない時は「注文する」を押せない。
- 注文には、注文した時の返品の条件の中身・日時を残す。後で条件を変えても、その注文で約束した条件が分かる。最終確認で見た条件が、注文の直前に変わっていたら、注文を作らず確認へ戻す。
- 受付の期限は、文の期限（届いてから7日）より早く締まらない。届いた日が分からない時の目安を、届くのに一番長くかかる日数にする（暫定7日。運送会社の目安を確かめて決める。未確認事項 #1）。条件の記録が無い注文は、法律の8日（届いた日を1日目に数える）と店の期限の遅い方まで受ける。
- 帳簿の仕訳・勘定・決済の関数は変えない（設計 14-h）。本番の注文は0件なので移しかえは無く、本番に書いて確かめることはしない。
- 文の言い回しの確定（未確認事項 #2）と、「説明と違った」を出す設定・店の送り状の費用・数が足りない品の理由（未確認事項 #6・#7・#9）は、オーナーの確認が要る。
- 設計 14-c・14-g は「理由ごとの設定の『その他』はどの品でも選べる」と今の作りのように書くが、今の受付は返品不可の品に破損・不良と注文と違う品しか許さない（DB のステップ10と画面の両方）。A9 の決定の範囲なので S27 で変える。設計の前提の文の食い違いは controller が設計を直す。
- 注文確認後の申し込み画面は、期限を過ぎても破損・不良・注文と違う品の申し込みのボタンが出る。管理画面のお断りでは、その申し込みに「期限を過ぎているため」を選べなくする。
- 注文に残す条件は、注文の時の条件の中身と、お客様が見た版の結び、注文時の返品不可の品の番号の一覧。注文後に印を付けても外しても前の注文の条件は変えず、相談の窓口は残す。照合の道（支払いの後から作る注文）と直接作る注文には印の記録が無く、「返品不可でない」として受ける。期限は法律の8日と店の期限の遅い方になる（2026-11-05 オーナー決定、旧 未確認事項 #15）。
- 添える文（素材の風合いなど）の初期値は、今の特定商取引法の文をそのまま移す。「ご容赦ください」と返品を断る言い方を含むので、契約の内容の説明として書き直すか決めてほしい（未確認事項 #2）。
- 「その他」の相談の申し込みの期限は、オーナー決定により今の計画のまま。破損・不良・注文と違う品だけ期限で締めず、その他の期限後はお問い合わせで相談を受ける（旧 未確認事項 #16）。
- 計画1の地図の行4は、controller が直した（返品の受付・期限・設定の関数7本は計画3の後に計画4が手入れする）。計画1〜3への新しい願いは無い。

## セルフレビュー（writing-plans）

**仕様の網羅:** 設計の行から Task への対応表で、14-a・14-a2・14-a3・14-b・14-c・14-d・14-e・14-f・14-g・14-h の全部、14-1 の今の作り5行、14-3 の例5行、14-5 の比較、16章の範囲の行を、作る Task と固定する試験に結んだ。範囲の外の行は「計画N」と書いた。決められない所は未確認事項に置いた。

**型・名前:** `ReturnTermsInputs`・`ReturnTermsView`・`ReturnTermsSection`・`ReturnTermsWarning`・`renderReturnTerms`・`describeReturnTermsWarnings`・`RETURN_TERMS_TEMPLATE_VERSION`・`shopReturnDeadline`・`statutoryReturnDeadline`・`loadReturnTerms`・`useReturnTerms`・`ReturnTermsBlock`・`ReturnTermsMark`・`ShopReturnTermsPreview`・`private.return_terms_inputs`・`private.return_terms_hash`・`get_return_terms_inputs`・`private.publish_return_terms_rendering`・`return_terms_snapshots`・`return_terms_renderings`・`order_return_terms`・`order_return_terms_shown`・`private.order_record_return_terms`・`acc_p4_orders_record_return_terms`・`private.place_order_with_return_terms`・`private.customer_return_defect_lines`・`defect_selectable`・`defectSelectable` は、Task 1〜12 で同じ綴り・同じ引数で使う。計画3の名前（`order_return_receipts.arrived_on`・`admin_receive_return`・`shop_return_settings` の手数料の CHECK・`RETURN_NOT_FOUND`・`RETURN_ARGUMENT_INVALID`）はそのまま使い、新しい権限・印・勘定は足していない。

**Review Focus の5行:** 1行目は Task 1・4〜7、2行目は Task 1・9、3行目は Task 10、4行目は Task 8、5行目は Task 8・14 の試験で確かめられる。

**届く順・同時の更新:** 注文に残す所は、①内容で一意の表（ハッシュが主キー）と `ON CONFLICT DO NOTHING`、②注文の insert と同じトランザクションのトリガー、③設定を1本の SELECT で読むこと、④結びを注文の主キーで1回に絞ること、の4つで、届く順や同時の更新に頼らない。試験は `FREQ-590-AC-03`（並行）・`AC-04`・`FREQ-586-AC-02`（未コミットの設定の更新）で固定した。

**計画1〜3への直し:** 1件（計画1の地図の行4。controller が直した）。決済の関数 2本の本文は変えず（H4 の MD5 の確かめが通る）、計画3が作り直す7本の関数とも重ならない（G の書き手の一覧は両方が作り直すので、S26 は計画3の S18 の後の定義を写す）。H5 の対象14本に Task 9 の `return_detail_json` が入る。属性と本文の MD5 を比べるので、同じ Task の Files に `group_h_migration_asserts` の `FREQ-551-AC-02` を意図して直す試験として入れ、新しい MD5 と囲みを除いた本文の比べ方にそろえる。実装時に数え直す。
