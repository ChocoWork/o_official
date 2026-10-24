# 1.17-1 プライバシーポリシーの頁（PRIVACY）詳細設計

> 状態: 推定 | 確認日: 2026-10-24 | 対象: プライバシーポリシー `/privacy`（`src/app/privacy/page.tsx`） | 基準コミット: `4facf63b`

## 概要

プライバシーポリシーの頁を、詳細設計の項目（`DD-PRIVACY-001`）で書く。
中身は 2026-10-24 の作業ツリーのコードを読んで起こした今の動きで、ユーザーの確認を受けていないので「推定」にした。文書・要件とコードが食い違う所は決めずに今のコードの動きを書き、食い違いは `docs/05_Quality/reports/trace-matrix.md` の「食い違い」節に載せた。

| ID | 題 | 単位 |
| --- | --- | --- |
| `DD-PRIVACY-001` | プライバシーポリシーの頁の描画と metadata | `src/app/privacy/page.tsx` |

- 結論: 頁は Server Component で、request のたびに描く。service role の client でショップの配送の追跡の設定を読み、オンの時だけ「5. 個人情報の取扱いの委託」の一覧に 17TRACK の一文を足す。読めない時は例外を握りつぶさず、頁の描画を失敗にする
- 範囲の単位は `.tsx` のファイル1つだけなので、詳細設計も1項目にまとめた。前の版の `IMPL-PRIVACY-001`（本文の表示）と `IMPL-PRIVACY-002`（metadata）は、どちらもこの項目の「旧番号」に移した
- 分岐は委託の一覧の三項1つだけで、今の単体テストが両側を通す。単体テストの名前は全部 `DD-PRIVACY-001` で始まり、範囲の網羅（`jest.trace.config.cjs`）は文・分岐・関数・行とも 100%（2026-10-24 実測）

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の PRIVACY |
| 上位の文書 | [PRIVACY の構造設計](../../03_BasicDesign/areas/privacy.md)（`ARC-`・`SCR-`・`FLOW-`・`STATE-`・`DATA-PRIVACY-`）、[PRIVACY の要件](../../02_Requirements/areas/privacy.md)（`SEC-PRIVACY-`） |
| 関連文書 | [PRIVACY の脅威](../../05_Quality/security/threats/privacy.md)、[ADR-0350](../../03_BasicDesign/decisions/ADR-0350-privacy-request-time-render-fail-closed.md)・[ADR-0351](../../03_BasicDesign/decisions/ADR-0351-privacy-tracking-clause-by-shop-setting.md)・[ADR-0352](../../03_BasicDesign/decisions/ADR-0352-privacy-contact-email-text-and-form.md) |
| 対象のコード | 「実装の単位」の表の1単位 |
| 引き継いだ文書 | [1.17 プライバシーポリシーページ（PRIVACY）詳細設計](17_privacy.md) の「機能要件対応表」の `IMPL-PRIVACY-001`・`IMPL-PRIVACY-002`。元の文書は、`tests/unit/docs/delivery-status-traceability.test.ts` が配送の追跡の追加の節の文言を固定しているので変えていない |
| 調べた時点 | 2026-10-24 の作業ツリー。コードを読んで起こした。単体テストの網羅（文・分岐・関数・行とも 100%）は実測した。E2E と DB の結合テストは流していない |

範囲外の共有部品とほかの領域の部品は ID を持たないので、上位に書かず本文にファイルの道で書く。

| 部品 | 道 | ここでの使われ方 |
| --- | --- | --- |
| Supabase の client | `src/lib/supabase/server.ts` の `createServiceRoleClient` | 設定の関数を呼ぶ client を作る。URL か service role の鍵が無ければ例外 |
| 配送の追跡の読み書き（配送の追跡の部品） | `src/lib/orders/tracking/delivery-store.ts` の `getDeliveryTrackingSettings` | DB の関数 `get_delivery_tracking_settings` を呼び、1行で各欄の型が合う時だけ4つの欄で返す。在庫の作業が同じファイルを変えている |
| 守りの見出しと Cookie | `src/proxy.ts` | CSP（nonce 付き）・枠の禁止・HSTS などを付け、`session_id` の Cookie を発行する。頁は自分では見出しを足さない |
| 頁の殻 | `src/app/layout.tsx`、`src/contexts/Providers.tsx` | Header・Footer で包む。`/privacy` の時だけカートの取得を止める |
| 入口 | `src/components/Footer.tsx` | 全頁のフッターの `a` 要素で `/privacy` を開く |

## 実装の単位

`scripts/trace/parse-code.ts` の `parseCodeUnits` で数えた範囲内の単位と、つなぐ詳細設計。1つの単位は1つの `DD-` にだけつなぐ。`@impl`・`@design` のコメントはこの表から付ける。

| ファイル | 単位（symbol） | DD |
| --- | --- | --- |
| `src/app/privacy/page.tsx` | `<file>` | DD-PRIVACY-001 |

- `.tsx` はファイル全体で1つの単位なので、中の metadata の関数・既定の書き出しの頁の関数・字の大きさの定数・委託の一文の定数は、この単位に含める
- 新しい `@impl` は `IMPL-PRIVACY-101` から振る（前の版の最大が `IMPL-PRIVACY-002` のため）。ファイルの単位のコメントは、1行目の import より前に置く（委託の一文の定数のコメントは単位のコメントとして読まれない）
- ファイルの先頭に `@packageDocumentation`・`@impl IMPL-PRIVACY-101`・`@design DD-PRIVACY-001` を、import より前に付けた。コメントだけの変更で、動きは変えていない

## 詳細設計

### DD-PRIVACY-001 プライバシーポリシーの頁の描画と metadata

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-PRIVACY-001、ARC-PRIVACY-002、SCR-PRIVACY-001、FLOW-PRIVACY-001、STATE-PRIVACY-001、DATA-PRIVACY-001、DATA-PRIVACY-002、SEC-PRIVACY-005、SEC-PRIVACY-006 |
| 根拠 | 店長が切り替える追跡の設定を公表の委託の一覧へすぐ届けるため、頁を request のたびに描いて設定を読む（ARC-PRIVACY-001、STATE-PRIVACY-001）。設定の関数は anon・一般会員から取り上げてあるので、ログイン無しの閲覧者の頁でも service role の client で読み、使うのは `enabled` だけにする（DATA-PRIVACY-001・002）。読めない時に一文を黙って出し分けると誤った方針を公表するので、例外をそのまま出して頁を失敗にする（SEC-PRIVACY-005）。一文の条件は鍵でなく設定だけにする（SEC-PRIVACY-006）。7節の国外移転の既存の文は変えない（FREQ-495-REQ-01（範囲外）。観点 8）。画面の節の並び・窓口の出口・metadata は SCR-PRIVACY-001・FLOW-PRIVACY-001 に合わせ、守りの見出しは頁で重ねず共有の proxy に任せる（ARC-PRIVACY-002） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/privacy/page.tsx`）、`docs/04_DetailDesign/pages/17_privacy.md`、`docs/superpowers/plans/2026-10-21-delivery-status.md` |
| 旧番号 | IMPL-PRIVACY-001、IMPL-PRIVACY-002 |
| 旧所在 | `docs/04_DetailDesign/pages/17_privacy.md` の「機能要件対応表」の FR-PRIVACY-001・FR-PRIVACY-002 の行 |

**対応要件 ID:** ARC-PRIVACY-001・002、SCR-PRIVACY-001、FLOW-PRIVACY-001、STATE-PRIVACY-001、DATA-PRIVACY-001・002、SEC-PRIVACY-005・006（その上は FR-PRIVACY-001・002、FREQ-100-REQ-01、FREQ-101-REQ-01、DRV-PRIVACY-001〜004、ADR-0350〜0352、SEC-PRIVACY-001、FREQ-490-REQ-01（範囲外）、FREQ-495-REQ-01（範囲外））

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `GET /privacy`。props・検索の引数・Cookie は読まない。DB の関数 `get_delivery_tracking_settings` の返り値（配送の追跡の部品を通した `enabled`・`updatedAt`・`updatedByEmail`・`backfillCount`。頁が使うのは `enabled` だけ） |
| 出力（頁） | HTML。外側は最大幅 `max-w-3xl` の1列。h1「Privacy Policy / 個人情報の取り扱いについて」、前置きと 1〜12 の節の13の `section`（どれも h2）、末尾の日付の `section` |
| 出力（metadata） | title「Privacy Policy \| Le Fil des Heures」、description は固定の文、og:title・og:description は同じ字、og:image は `/mainphoto.png`（`src/app/privacy/page.tsx` の `generateMetadata`） |

**正常フロー:**

1. `generateMetadata` は、待つ処理も分岐も持たず、固定の title・description・OGP を返す
2. 頁の関数 `PrivacyPage` は、初めに Next.js の connection を待つ。ビルドの時に DB へ行かず、request の時に描く
3. `createServiceRoleClient` で client を作り、`getDeliveryTrackingSettings` に渡して設定を読む。client は1回だけ作る
4. h1 と、前置き「個人情報の取り扱いについて」、1. 定義、2. 収集方法、3. 利用目的、4. 第三者提供、5. 委託、6. 保有期間、7. 国外移転、8. 安全管理、9. Cookie 及び外部サービスの利用、10. 開示・訂正・利用停止等の請求、11. 本ポリシーの変更、12. お問い合わせ窓口を、節の間を `space-y-8` で並べる。文は頁のコードに字で持つ
5. 5節の委託の一覧は「商品の配送業務（配送事業者）」「決済処理業務（Stripe, Inc.）」「サーバー及びシステムの運用・保守業務」の3項目。`enabled` が真の時だけ、1番目と2番目の間に一文の定数 `DELIVERY_TRACKING_OUTSOURCING` を `li` で足し、4項目にする。分岐は委託の一覧を作る三項1つだけ
6. 12節は「事業者名：Le Fil des Heures」「お問い合わせ先：privacy@lefildesheures.com」を一覧の字で出す。メールは `mailto:` のリンクにしない。その下に `next/link` で `/contact` への「お問い合わせフォーム」を出す
7. 末尾に「制定日：2026年6月20日」「最終改定日：2026年7月11日」を固定の字で出す。委託の一覧が変わっても変わらない
8. 字の大きさは頁の先頭の定数で持つ。頁の見出し（`pageTitleStyle`）は `--lk-size-5xl`、節の見出し（`sectionTitleStyle`）は `--lk-size-md`（`font-brand`）、本文と一覧（`bodyTextStyle`）は `--lk-size-xs`・行間 1.9、日付（`dateTextStyle`）は `--lk-size-2xs`・行間 1.9

**分岐:**

| 条件 | 動き | 場所 |
| --- | --- | --- |
| `enabled` が真 | 委託の一覧は4項目。2番目に 17TRACK の一文 | `PrivacyPage` の委託の一覧の三項の真の側 |
| `enabled` が偽（初めの値） | 委託の一覧は3項目。頁に「17TRACK」の字は無い | 同じ三項の偽の側（何も出さない） |

**異常フロー:**（頁には try/catch が無い。どれも例外がそのまま出て頁の描画が失敗する）

| 条件 | 動き | 場所 |
| --- | --- | --- |
| connection を待つ処理が投げる | client を作らず、設定も読まない | `PrivacyPage` の最初の `await connection()` |
| service role の URL か鍵が無い | `createServiceRoleClient` が例外。設定を読まない | `PrivacyPage` の client を作る式、`src/lib/supabase/server.ts` の `createServiceRoleClient` の環境変数の確かめ |
| DB の関数の呼び出しが投げる | `DeliveryStoreError`（文は「delivery store failed」と関数名だけで、DB の誤りの文を載せない） | `PrivacyPage` の設定を読む式、`src/lib/orders/tracking/delivery-store.ts` の `DeliveryStoreError` と、DB の関数を呼ぶ内部関数 `callRpc` の投げた場合の分岐 |
| DB の関数が誤りを返す | 決まった語を含めば `DeliveryOperationError`、ほかは `DeliveryStoreError` | `delivery-store.ts` の `callRpc` の、DB が誤りを返した場合の分岐 |
| 返り値が1行でない | `DeliveryStoreError` | `delivery-store.ts` の内部関数 `singleRow` |
| 欄の型が合わない（`enabled` が真偽でない、件数が0以上の整数でないなど） | `DeliveryStoreError` | `delivery-store.ts` の内部関数 `boolean`・`integer` などと `getDeliveryTrackingSettings` |
| 上のどれか | `src/app/privacy` にも `src/app` の直下にも `error.tsx`・`global-error.tsx` が無いので、Next.js の既定の誤りの頁になる。窓口の節にも届かない。誤りの頁が中身を伏せるか（SEC-PRIVACY-008）と、方針を知る道を残すか（SEC-PRIVACY-009）は、その SEC の項目を参照 | `src/app/checkout/error.tsx`・`src/app/order-status/[token]/error.tsx` は在るが、どちらも `/privacy` には効かない |

**状態・永続化:** 頁は状態を持たず、書き込みもしない。request のたびに `shop_settings` の `id=1` の行の `delivery_tracking_enabled` を、関数を通して読み直す（DATA-PRIVACY-001）。オン・オフを変えるのは範囲外の管理の窓口（`src/app/api/admin/settings/shop/route.ts`）だけ。`revalidate` などのキャッシュの指定は無く、応答の `Cache-Control` の実際の値は確かめていない（SEC-PRIVACY-007）。関数が返す担当者のメールと件数の扱いは SEC-PRIVACY-002・003 を参照。

**認証認可:** 頁はログインを求めず、閲覧者の session も役も見ない。設定の関数と表は PUBLIC・anon・authenticated から取り上げてあり、service role だけが呼べる（DATA-PRIVACY-002）ので、頁は service role の client で読む。service role は RLS を素通りするので、受け取る欄の絞り込みは頁の側の決まり（`enabled` だけを描く）になる。鍵（`TRACKING_17TRACK_API_KEY`）の有無は見ない。守りの見出し（CSP・枠の禁止・HSTS）と `session_id` の Cookie は共有の proxy が付け、頁は重ねない（ARC-PRIVACY-002）。回数の制限は SEC-PRIVACY-004 を参照。

**テスト観点:**（`tests/unit/components/PrivacyPage.test.tsx`。connection・`createServiceRoleClient`・`getDeliveryTrackingSettings`・`next/link` を差し替える。ファイルは `docs/02_Requirements/requirements.md` の FREQ-495 の行がリンクしているので動かさない）

| # | 観点 | 通す分岐・道 | 今のテスト（名前） |
| --- | --- | --- | --- |
| 1 | オフで「配送状況の確認業務」と「17TRACK」の字が無く、オンで一文が在る | 委託の一覧の三項の両側 | 在る（「privacyの17TRACKの一文はONだけ」） |
| 2 | オンの委託の一覧が4項目で、並びが配送・17TRACK・Stripe・運用保守、一文が `LI` | 三項の真の側 | 在る（「ONの一文は…一覧の項目として出し、今の3項目は残す」） |
| 3 | オフの委託の一覧が3項目のまま | 三項の偽の側 | 在る（「OFFの一覧は今の3項目のまま」） |
| 4 | connection の後に設定を読み、client を1回だけ作って関数に渡す | `PrivacyPage` の初めの2つの待ち | 在る（「connection() の後に設定を読む…」） |
| 5 | 17TRACK の鍵が無くても、設定がオンなら一文を出す | 三項の真の側 | 在る（「17TRACK の鍵が無くても、設定がONなら委託の一文を出す…」） |
| 6 | 設定を読めない時は、頁の関数が同じ例外で失敗する | 設定を読む式の異常 | 在る（「設定を読めない時は、一文を黙って出し分けずにページの失敗として扱う」） |
| 7 | client を作れない時は、頁の関数が失敗し、設定を読まない | client を作る式の異常 | 在る（「service_role の client を作れない時も、ページの失敗として扱う」） |
| 8 | 7節の見出し・窓口のメール・最終改定日の字が残る | 7節・12節・末尾の日付の固定の字 | 在る（「ほかの節の文言は変えない…」） |
| 9 | connection が投げた時は、頁の関数が失敗し、client を作らず設定も読まない | 最初の `await connection()` の異常 | 在る（「connection() が投げた時は、ページの失敗として扱い、client も作らず設定も読まない」） |
| 10 | `generateMetadata` が title・description・og:title・og:description・og:image を返す | `generateMetadata` の返り値 | 在る（「generateMetadata が title・description・og:title・og:description・og:image を返す」） |
| 11 | h1 と13の h2 が決まった順で並び、窓口のメールが `a` 要素でなく、「お問い合わせフォーム」の `href` が `/contact` | 頁の関数の描画の全体 | 在る（「h1 と13の h2 が決まった順で並び、窓口のメールはリンクにせず、お問い合わせフォームは /contact …」） |

- 分岐は表の2つだけで、1〜3・5 が両側を通す。観点 1〜11 の単体テストは、名前の先頭が全部 `DD-PRIVACY-001`。範囲の網羅は文・分岐・関数・行とも 100%（2026-10-24 実測）で、届かない分岐は無い
- 観点 9〜11 は、分岐の網羅には要らないが、関数（`generateMetadata`）と描画の全体の網羅のために足した

## 未確認事項

- 本番の誤りの頁が中の事情を伏せるかと、`/privacy` の応答の `Cache-Control` の実際の値
- 窓口のメール箱 `privacy@lefildesheures.com` が本番に在るか
- 在庫の作業が `delivery-store.ts` と `get_delivery_tracking_settings` の返り値の形を変えるか（今の計画は頁を「維持」とする）。変わると頁と単体テストの差し替えも直す
- connection を待つ処理が request の時に投げる場面が実際にあるか（観点 9 は Next.js の中の動きに頼る）
- この項目は「推定」。ユーザーの確認を受けたら「現行」にする
