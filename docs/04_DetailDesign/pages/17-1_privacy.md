# 1.17-1 プライバシーポリシーの頁（PRIVACY）詳細設計

> 状態: 推定 | 確認日: 2026-10-28 | 対象: プライバシーポリシー `/privacy`（`src/app/privacy/page.tsx`・`error.tsx`・`revision-date.ts`）と、共有の `src/proxy.ts` の `session_id` の発行条件 | 基準コミット: `4facf63b`

## 概要

プライバシーポリシーの頁を、詳細設計の項目（`DD-PRIVACY-001`〜`004`）で書く。`DD-PRIVACY-002`（誤りの画面）と `DD-PRIVACY-003`（最終改定日）は 2026-10-26 に、`DD-PRIVACY-004`（`session_id` の発行条件）は 2026-10-28 に足した。
中身は 2026-10-24 の作業ツリーのコードを読んで起こした今の動きで、ユーザーの確認を受けていないので「推定」にした。文書・要件とコードが食い違う所は決めずに今のコードの動きを書き、食い違いは `docs/05_Quality/reports/trace-matrix.md` の「食い違い」節に載せた。

| ID | 題 | 単位 |
| --- | --- | --- |
| `DD-PRIVACY-001` | プライバシーポリシーの頁の描画と metadata | `src/app/privacy/page.tsx` |
| `DD-PRIVACY-002` | 設定を読めない時の誤りの画面 | `src/app/privacy/error.tsx` |
| `DD-PRIVACY-003` | 最終改定日を決める関数 | `src/app/privacy/revision-date.ts` |
| `DD-PRIVACY-004` | `session_id` の発行条件 | `src/lib/session-cookie-policy.ts` |

- 結論: 頁は Server Component で、request のたびに描く。service role の client でショップの配送の追跡の設定を読み、オンの時だけ「5. 個人情報の取扱いの委託」の一覧に 17TRACK の一文を足す。読めない時は例外を握りつぶさず、頁の描画を失敗にする
- 範囲の単位は `.tsx` のファイル1つだけなので、詳細設計も1項目にまとめた。前の版の `IMPL-PRIVACY-001`（本文の表示）と `IMPL-PRIVACY-002`（metadata）は、どちらもこの項目の「旧番号」に移した
- 分岐は委託の一覧の三項1つだけで、今の単体テストが両側を通す。単体テストの名前は全部 `DD-PRIVACY-001` で始まり、範囲の網羅（`jest.trace.config.cjs`）は文・分岐・関数・行とも 100%（2026-10-24 実測）

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の PRIVACY |
| 上位の文書 | [PRIVACY の構造設計](../../03_BasicDesign/areas/privacy.md)（`ARC-`・`SCR-`・`FLOW-`・`STATE-`・`DATA-PRIVACY-`）、[PRIVACY の要件](../../02_Requirements/areas/privacy.md)（`SEC-PRIVACY-`） |
| 関連文書 | [PRIVACY の脅威](../../05_Quality/security/threats/privacy.md)、[ADR-0350](../../03_BasicDesign/decisions/ADR-0350-privacy-request-time-render-fail-closed.md)・[ADR-0351](../../03_BasicDesign/decisions/ADR-0351-privacy-tracking-clause-by-shop-setting.md)・[ADR-0352](../../03_BasicDesign/decisions/ADR-0352-privacy-contact-email-text-and-form.md)・[ADR-0353](../../03_BasicDesign/decisions/ADR-0353-privacy-revision-date-follows-tracking-switch.md)・[ADR-0354](../../03_BasicDesign/decisions/ADR-0354-privacy-error-screen-guidance-only.md)・[ADR-0355](../../03_BasicDesign/decisions/ADR-0355-privacy-session-id-allowlist.md) |
| 対象のコード | 「実装の単位」の表の1単位 |
| 引き継いだ文書 | [1.17 プライバシーポリシーページ（PRIVACY）詳細設計](17_privacy.md) の「機能要件対応表」の `IMPL-PRIVACY-001`・`IMPL-PRIVACY-002`。元の文書は、`tests/unit/docs/delivery-status-traceability.test.ts` が配送の追跡の追加の節の文言を固定しているので変えていない |
| 調べた時点 | 2026-10-24 の作業ツリー。コードを読んで起こした。単体テストの網羅（文・分岐・関数・行とも 100%）は実測した。E2E と DB の結合テストは流していない |

範囲外の共有部品とほかの領域の部品は ID を持たないので、上位に書かず本文にファイルの道で書く。

| 部品 | 道 | ここでの使われ方 |
| --- | --- | --- |
| Supabase の client | `src/lib/supabase/server.ts` の `createServiceRoleClient` | 設定の関数を呼ぶ client を作る。URL か service role の鍵が無ければ例外 |
| 配送の追跡の読み書き（配送の追跡の部品） | `src/lib/orders/tracking/delivery-store.ts` の `getDeliveryTrackingSettings` | DB の関数 `get_delivery_tracking_settings` を呼び、1行で各欄の型が合う時だけ4つの欄で返す。在庫の作業が同じファイルを変えている |
| 守りの見出しと Cookie | `src/proxy.ts` | CSP（nonce 付き）・枠の禁止・HSTS などを付ける。`session_id` の Cookie は `/cart`・`/checkout`・`/api/checkout` の応答だけで発行し、`/privacy` には付けない（DD-PRIVACY-004）。頁は自分では見出しを足さない |
| 頁の殻 | `src/app/layout.tsx`、`src/contexts/Providers.tsx` | Header・Footer で包む。`/privacy` の時だけカートの取得を止める |
| 入口 | `src/components/Footer.tsx` | 全頁のフッターの `a` 要素で `/privacy` を開く |

## 実装の単位

`scripts/trace/parse-code.ts` の `parseCodeUnits` で数えた範囲内の単位と、つなぐ詳細設計。1つの単位は1つの `DD-` にだけつなぐ。`@impl`・`@design` のコメントはこの表から付ける。

| ファイル | 単位（symbol） | DD |
| --- | --- | --- |
| `src/app/privacy/page.tsx` | `<file>` | DD-PRIVACY-001 |
| `src/app/privacy/error.tsx` | `<file>` | DD-PRIVACY-002 |
| `src/app/privacy/revision-date.ts` | `<file>` | DD-PRIVACY-003 |
| `src/lib/session-cookie-policy.ts` | `shouldIssueSessionCookie` | DD-PRIVACY-004 |

- `.tsx` はファイル全体で1つの単位なので、中の metadata の関数・既定の書き出しの頁の関数・字の大きさの定数・委託の一文の定数は、この単位に含める
- 新しい `@impl` は `IMPL-PRIVACY-101` から振る（前の版の最大が `IMPL-PRIVACY-002` のため）。`error.tsx` は `IMPL-PRIVACY-102`、`revision-date.ts` は `IMPL-PRIVACY-103`（2026-10-26）、`src/lib/session-cookie-policy.ts` の `shouldIssueSessionCookie` は `IMPL-PRIVACY-104`（2026-10-28。共有の `src/proxy.ts` が呼ぶ。`proxy` 全体は CSP・Origin の検査も持つ共有部品で、範囲の単位にしないので、発行の判定だけを小さな関数に出して範囲に入れた。`scripts/trace/scope.json` の PRIVACY の `src` と、試験 `tests/unit/middleware/proxy-session.test.ts` を `tests` に足した）。ファイルの単位のコメントは、1行目の import より前に置く（委託の一文の定数のコメントは単位のコメントとして読まれない）
- ファイルの先頭に `@packageDocumentation`・`@impl IMPL-PRIVACY-101`・`@design DD-PRIVACY-001` を、import より前に付けた。コメントだけの変更で、動きは変えていない

## 詳細設計

### DD-PRIVACY-001 プライバシーポリシーの頁の描画と metadata

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-PRIVACY-001、ARC-PRIVACY-002、SCR-PRIVACY-001、FLOW-PRIVACY-001、STATE-PRIVACY-001、DATA-PRIVACY-001、DATA-PRIVACY-002、SEC-PRIVACY-005、SEC-PRIVACY-006 |
| 根拠 | 店長が切り替える追跡の設定を公表の委託の一覧へすぐ届けるため、頁を request のたびに描いて設定を読む（ARC-PRIVACY-001、STATE-PRIVACY-001）。設定の関数は anon・一般会員から取り上げてあるので、ログイン無しの閲覧者の頁でも service role の client で読み、使うのは `enabled` と `updatedAt` だけにする（DATA-PRIVACY-001・002）。最終改定日は設定の更新時刻に追従させる（SEC-PRIVACY-012、DD-PRIVACY-003）。読めない時に一文を黙って出し分けると誤った方針を公表するので、例外をそのまま出して頁を失敗にする（SEC-PRIVACY-005）。一文の条件は鍵でなく設定だけにする（SEC-PRIVACY-006）。7節の国外移転の既存の文は変えない（FREQ-495-REQ-01（範囲外）。観点 8）。画面の節の並び・窓口の出口・metadata は SCR-PRIVACY-001・FLOW-PRIVACY-001 に合わせ、守りの見出しは頁で重ねず共有の proxy に任せる（ARC-PRIVACY-002） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/privacy/page.tsx`）、`docs/04_DetailDesign/pages/17_privacy.md`、`docs/superpowers/plans/2026-10-21-delivery-status.md` |
| 旧番号 | IMPL-PRIVACY-001、IMPL-PRIVACY-002 |
| 旧所在 | `docs/04_DetailDesign/pages/17_privacy.md` の「機能要件対応表」の FR-PRIVACY-001・FR-PRIVACY-002 の行 |

**対応要件 ID:** ARC-PRIVACY-001・002、SCR-PRIVACY-001、FLOW-PRIVACY-001、STATE-PRIVACY-001、DATA-PRIVACY-001・002、SEC-PRIVACY-005・006（その上は FR-PRIVACY-001・002、FREQ-100-REQ-01、FREQ-101-REQ-01、DRV-PRIVACY-001〜004、ADR-0350〜0352、SEC-PRIVACY-001、FREQ-490-REQ-01（範囲外）、FREQ-495-REQ-01（範囲外））

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `GET /privacy`。props・検索の引数・Cookie は読まない。DB の関数 `get_delivery_tracking_settings` の返り値（配送の追跡の部品を通した `enabled`・`updatedAt`・`updatedByEmail`・`backfillCount`。頁が使うのは `enabled` と `updatedAt` だけ） |
| 出力（頁） | HTML。外側は最大幅 `max-w-3xl` の1列。h1「Privacy Policy / 個人情報の取り扱いについて」、前置きと 1〜12 の節の13の `section`（どれも h2）、末尾の日付の `section` |
| 出力（metadata） | title「Privacy Policy \| Le Fil des Heures」、description は固定の文、og:title・og:description は同じ字、og:image は `/mainphoto.png`（`src/app/privacy/page.tsx` の `generateMetadata`） |

**正常フロー:**

1. `generateMetadata` は、待つ処理も分岐も持たず、固定の title・description・OGP を返す
2. 頁の関数 `PrivacyPage` は、初めに Next.js の connection を待つ。ビルドの時に DB へ行かず、request の時に描く
3. `createServiceRoleClient` で client を作り、`getDeliveryTrackingSettings` に渡して設定を読む。client は1回だけ作る
4. h1 と、前置き「個人情報の取り扱いについて」、1. 定義、2. 収集方法、3. 利用目的、4. 第三者提供、5. 委託、6. 保有期間、7. 国外移転、8. 安全管理、9. Cookie 及び外部サービスの利用、10. 開示・訂正・利用停止等の請求、11. 本ポリシーの変更、12. お問い合わせ窓口を、節の間を `space-y-8` で並べる。文は頁のコードに字で持つ
5. 5節の委託の一覧は「商品の配送業務（配送事業者）」「決済処理業務（Stripe, Inc.）」「サーバー及びシステムの運用・保守業務」の3項目。`enabled` が真の時だけ、1番目と2番目の間に一文の定数 `DELIVERY_TRACKING_OUTSOURCING` を `li` で足し、4項目にする。分岐は委託の一覧を作る三項1つだけ。9節は Cookie の段落、Stripe, Inc. の段落、Resend, Inc.・Supabase, Inc.・Cloudflare, Inc.（Cloudflare Turnstile）を挙げる段落の3つ。2節の一覧に「メールマガジン」は無い（SEC-PRIVACY-011）
6. 12節は「事業者名：Le Fil des Heures」「お問い合わせ先：privacy@lefildesheures.com」を一覧の字で出す。メールは `mailto:` のリンクにしない。その下に `next/link` で `/contact` への「お問い合わせフォーム」を出す
7. 末尾に「制定日：2026年6月20日」を固定の字で、「最終改定日」を `resolveRevisionDate(deliveryTracking.updatedAt)` の結果で出す（DD-PRIVACY-003）。追跡を切り替えていない間は 2026年10月26日
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
| 上のどれか | `src/app/privacy/error.tsx`（DD-PRIVACY-002）の誤りの画面になる。方針の本文は出ない。誤りの画面が中身を伏せるかは SEC-PRIVACY-008 を参照 | `src/app/privacy/error.tsx`。`loading.tsx` と頁の中の `<Suspense>` は足さない（HTTP 状態が 200 になりうる） |

**状態・永続化:** 頁は状態を持たず、書き込みもしない。request のたびに `shop_settings` の `id=1` の行の `delivery_tracking_enabled` を、関数を通して読み直す（DATA-PRIVACY-001）。オン・オフを変えるのは範囲外の管理の窓口（`src/app/api/admin/settings/shop/route.ts`）だけ。`revalidate` などのキャッシュの指定は無く、応答の `Cache-Control` の実際の値は確かめていない（SEC-PRIVACY-007）。関数が返す担当者のメールと件数は使わない（SEC-PRIVACY-002・003）。

**認証認可:** 頁はログインを求めず、閲覧者の session も役も見ない。設定の関数と表は PUBLIC・anon・authenticated から取り上げてあり、service role だけが呼べる（DATA-PRIVACY-002）ので、頁は service role の client で読む。service role は RLS を素通りするので、受け取る欄の絞り込みは頁の側の決まり（`enabled` と `updatedAt` だけを使う）になる。鍵（`TRACKING_17TRACK_API_KEY`）の有無は見ない。守りの見出し（CSP・枠の禁止・HSTS）は共有の proxy が付け、頁は重ねない（ARC-PRIVACY-002）。`session_id` の Cookie は `/privacy` には付かない（DD-PRIVACY-004）。回数の制限は SEC-PRIVACY-004 を参照。

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
| 8 | 7節の見出し・窓口のメール・制定日の字が残る | 7節・12節・末尾の制定日の固定の字 | 在る（「ほかの節の文言は変えない…」） |
| 12 | 最終改定日が、追跡を切り替えていない間は 2026年10月26日で、切り替えた日（日本時間）が基準日より後ならその日になる | 末尾の日付の式 | 在る（「最終改定日は、追跡の設定を切り替えていない…」「最終改定日は、追跡の設定を切り替えた日…」） |
| 9 | connection が投げた時は、頁の関数が失敗し、client を作らず設定も読まない | 最初の `await connection()` の異常 | 在る（「connection() が投げた時は、ページの失敗として扱い、client も作らず設定も読まない」） |
| 10 | `generateMetadata` が title・description・og:title・og:description・og:image を返す | `generateMetadata` の返り値 | 在る（「generateMetadata が title・description・og:title・og:description・og:image を返す」） |
| 11 | h1 と13の h2 が決まった順で並び、窓口のメールが `a` 要素でなく、「お問い合わせフォーム」の `href` が `/contact` | 頁の関数の描画の全体 | 在る（「h1 と13の h2 が決まった順で並び、窓口のメールはリンクにせず、お問い合わせフォームは /contact …」） |

- 分岐は表の2つだけで、1〜3・5 が両側を通す。観点 1〜11 の単体テストは、名前の先頭が全部 `DD-PRIVACY-001`。範囲の網羅は文・分岐・関数・行とも 100%（2026-10-24 実測）で、届かない分岐は無い
- 観点 9〜11 は、分岐の網羅には要らないが、関数（`generateMetadata`）と描画の全体の網羅のために足した

### DD-PRIVACY-002 設定を読めない時の誤りの画面

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-PRIVACY-001、SCR-PRIVACY-001、SEC-PRIVACY-005、SEC-PRIVACY-008、SEC-PRIVACY-009 |
| 根拠 | 設定を読めない時は、古い方針を出し続けないため頁を失敗にする（SEC-PRIVACY-005）。その受け皿では、方針の本文も委託の一覧も出さず、利用者が窓口へ辿り着ける案内だけを出す（SEC-PRIVACY-009、ADR-0354）。誤りの文・stack は画面にも記録にも出さず、digest だけ残す（SEC-PRIVACY-008）。props の名前（`retry`）は `src/app/checkout/error.tsx` と同じ |
| 状態 | 推定 |
| 確かめ方 | 単体テスト・E2E |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1c-decisions.md`、`docs/superpowers/plans/2026-10-26-wave1c-local-fixes.md` の Task 8 |

**対応要件 ID:** ARC-PRIVACY-001、SCR-PRIVACY-001、SEC-PRIVACY-005・008・009（その上は DRV-PRIVACY-002、ADR-0350、ADR-0354）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | props `error`（`Error & { digest?: string }`）と `retry`（`() => void`）。Client Component |
| 出力 | h1「プライバシーポリシーを表示できません」（「Privacy Policy」を含まない）、案内の文「現在、プライバシーポリシーを表示できません。しばらく時間を置いてから、もう一度お試しください。」、窓口の字 `privacy@lefildesheures.com`、`/contact` への「お問い合わせフォーム」のリンク、`retry` を呼ぶ「もう一度表示する」のボタン |
| 記録 | `console.error('[privacy] render failed', { digest })` だけ |

**正常フロー:**

1. 頁の描画が失敗すると、Next.js がこの画面を出す
2. 描画の後に、digest だけを記録する（`error.message`・`stack` は渡さない）
3. 案内・窓口・フォームへのリンク・「もう一度表示する」を出す。ボタンは `retry` を1回呼ぶ

**分岐と異常フロー:** 分岐は無い。`digest` が無くても記録は `{ digest: undefined }` になるだけ。

**状態・永続化:** 持たない。

**認証認可:** ログインを求めない。方針の本文・委託の一覧・17TRACK の字を出さない。

**テスト観点:**（`tests/unit/app/privacy/privacy-error.test.tsx`。名前の先頭は `DD-PRIVACY-002`。E2E は `e2e/FR-PRIVACY-009`）

| # | 観点 |
| --- | --- |
| 1 | 「時間を置いて」「もう一度」を含む案内 |
| 2 | 窓口のメールの字と `/contact` へのリンク |
| 3 | h1 に「Privacy Policy」が無い |
| 4 | 誤りの文（権限の拒否の文など）・「17TRACK」・「個人情報の取扱いの委託」が画面に無い |
| 5 | ボタンで `retry` が1回 |
| 6 | 記録は `{ digest }` だけで `message`・`stack` を持たない |

### DD-PRIVACY-003 最終改定日を決める関数

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-PRIVACY-001、STATE-PRIVACY-001、DATA-PRIVACY-001、SEC-PRIVACY-012 |
| 根拠 | 追跡の切り替えで委託の一覧が変わるのに最終改定日が固定のままだと、変わった日を本人が知れない（SEC-PRIVACY-012）。固定の基準日と、設定が変わった日の遅いほうにする（ADR-0353）。設定の時刻は UTC の文字列なので、日本時間の日付に直してから比べる |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1c-decisions.md`、`docs/superpowers/plans/2026-10-26-wave1c-local-fixes.md` の Task 8 |

**対応要件 ID:** SCR-PRIVACY-001、STATE-PRIVACY-001、DATA-PRIVACY-001、SEC-PRIVACY-012（その上は ADR-0353）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `trackingUpdatedAt`（設定の更新時刻。UTC の文字列か null） |
| 出力 | 「YYYY年M月D日」（月・日はゼロ詰めしない）。定数 `PRIVACY_POLICY_BASE_REVISION = '2026-10-26'` も書き出す |

**正常フロー:**

1. 更新時刻を `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', ... })` で日本時間の `YYYY-MM-DD` にする
2. 基準日と文字の辞書順で比べ、遅いほうを選ぶ
3. 年・月・日に分けて「YYYY年M月D日」に整える

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| null・空の文字 | 基準日 |
| 日付として読めない | 基準日 |
| 日本時間の日付が基準日より前、または同じ | 基準日 |
| 日本時間の日付が基準日より後 | その日 |

**状態・永続化:** 持たない。純粋な関数。

**認証認可:** 無い。

**テスト観点:**（`tests/unit/app/privacy/revision-date.test.ts`。名前の先頭は `DD-PRIVACY-003`）

| # | 観点 |
| --- | --- |
| 1 | null・空・読めない値・基準日より前（旧基準日 2026-07-11 の翌日 0 時、基準日の 1 分前を含む）は 2026年10月26日 |
| 2 | 日本時間でちょうど 10月26日 0 時（UTC の 10月25日 15時）は 2026年10月26日 |
| 3 | 日本時間で 10月27日 0 時（UTC の 10月26日 15時）は 2026年10月27日（UTC の日付のままだと 10月26日になる境目） |
| 4 | UTC 16:30 は日本時間で翌日になる（2026年10月27日） |
| 5 | 月・日はゼロ詰めしない（2027年1月5日） |

### DD-PRIVACY-004 `session_id` の発行条件

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-PRIVACY-002、SEC-PRIVACY-015 |
| 根拠 | `session_id` を読むのは決済の流れだけ（`checkout-route-guard`・`create-session`・`complete`・`src/lib/supabase/server.ts` の `x-session-id`）。読み手のいない頁に識別子を配ると、方針を読むだけの閲覧者を長く追え、公開で共有キャッシュに載る応答にも識別子が付く。発行を読み手の道に限り、既定は配らない（ADR-0355、ユーザーの決定 Q23） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト・結合テスト |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave3-decisions.md`（Q23）、`docs/superpowers/plans/2026-10-28-wave3-csp-images-session.md` の Task 9 |

**対応要件 ID:** ARC-PRIVACY-002、SEC-PRIVACY-015（その上は ADR-0355）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | 要求の道筋（`request.nextUrl.pathname`）と、要求の Cookie の `session_id` |
| 出力 | 許可リストの道で、`session_id` が無い時だけ、応答に新しい `session_id` の `Set-Cookie`（32 桁の 16 進、30 日、HttpOnly、SameSite=Lax、本番で Secure）を足す |

**正常フロー:**

1. 許可リスト `SESSION_COOKIE_ISSUE_PATH_PREFIXES = ['/cart', '/checkout', '/api/checkout']` のどれかに、セグメントの境目（完全一致か `<prefix>/`）で当たるかを見る（`src/lib/session-cookie-policy.ts` の `shouldIssueSessionCookie`）
2. `src/proxy.ts` が、当たり、かつ要求に `session_id` の値が無い時だけ、`generateSessionId()` の値を `cookieOptionsForSession(30 日)` で応答の Cookie に足す
3. 守りの見出し（CSP・HSTS など）は、発行の有無に関わらず全部の道に付ける

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 許可リストの道、`session_id` が無い | 発行する |
| 許可リストの道、`session_id` が既にある | 何もしない |
| 許可リストの外（`/`・`/about`・`/privacy`・`/terms`・`/news`・`/look`・`/item`・`/api/auth` ほか） | 発行しない。守りの見出しは付く |
| 境目の外れ（`/cartx`・`/checkoutx`・`/api/checkoutx`・`/apicheckout`） | 発行しない |

**状態・永続化:** 持たない。Cookie の値は応答で渡すだけで、proxy は保存しない。

**認証認可:** 無い。ログインの成功で新しい `session_id` を発行して回す処理（`src/features/auth/services/register.ts`）は別の仕組みで、この項目の対象外。許可リストの外の `/api/auth/*` の応答にも `Set-Cookie` が付く（セッション固定への守り。`FR-CHECKOUT-046` が頼る。ADR-0355 の「結果」）。

**テスト観点:**（`tests/unit/middleware/proxy-session.test.ts`。名前の先頭は `DD-PRIVACY-004`。結合テストは `tests/integration/api/privacy-proxy-headers.test.ts`・`about-proxy.test.ts`、E2E は `e2e/FR-PRIVACY-006`）

| # | 観点 |
| --- | --- |
| 1 | `/cart`・`/cart/`・`/checkout`・`/checkout?session_id=…`・`/api/checkout/create-session`・`/api/checkout/complete` で、Cookie の無い要求に発行する（32 桁の 16 進、HttpOnly、Lax、30 日） |
| 2 | `/`・`/about`・`/privacy`・`/terms`・`/news`・`/look/1`・`/look/1/og`・`/item/1`・`/api/auth/login`・`/api/search`・`/cartx`・`/checkoutx`・`/api/checkoutx`・`/apicheckout` で発行せず、`Set-Cookie` が無く、守りの見出しは付く |
| 3 | 既に `session_id` がある要求は、どの道でも `Set-Cookie` を付けない |
| 4 | ほかの Cookie だけがある `/cart` の要求には発行する |
| 5 | 発行する値は要求ごとに違い、本番だけ Secure が付く |

## 未確認事項

- 本番の誤りの画面が中の事情を伏せるかと、`/privacy` の応答の `Cache-Control` の実際の値
- 誤りの画面を足した後も HTTP 状態が 500 のままか（未実測。E2E `FR-PRIVACY-009` が確かめる）
- 窓口のメール箱 `privacy@lefildesheures.com` が本番に在るか
- 在庫の作業が `delivery-store.ts` と `get_delivery_tracking_settings` の返り値の形を変えるか（今の計画は頁を「維持」とする）。変わると頁と単体テストの差し替えも直す
- connection を待つ処理が request の時に投げる場面が実際にあるか（観点 9 は Next.js の中の動きに頼る）
- この項目は「推定」。ユーザーの確認を受けたら「現行」にする
