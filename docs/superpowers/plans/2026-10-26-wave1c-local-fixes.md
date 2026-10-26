# 波 1-C 局所の守りの穴の直し（SEARCH・LOOK・NEWS・STOCKIST・PRIVACY の Low と画面）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 守りの穴の設計（`design-final.md`）のうち、窓口（Route Handler）と頁の中だけで閉じる Low の項目と、見た目が少し変わる 1 件を直す。(1) 応答に `Cache-Control: private, no-store` を route 単位で付ける（SEC-SEARCH-010・SEC-NEWS-006・SEC-STOCKIST-010）。(2) 検索の入口を 1 つの決まりにそろえ（SEC-SEARCH-004）、処理時間の見出しを外し（019）、外のサイトから呼ばせた要求を 403 にし（020 の外のサイト側）、1 種類でも関数が失敗したら全体を失敗にし（017・018 の記録）、画面の呼びすぎを止め（005）、ホームの説明の文に検索語を埋めない（021。画面を見せて確かめる）。(3) LOOK の一覧から説明文を消して件数に上限 100 を付け（SEC-LOOK-009。価格は残す）、取り出しの失敗を「0 件」にせず誤りの画面に出す（022）、管理の画像は中身で種類を確かめ・保存名を自分で作り・消した画像を置き場からも消し（013・014・021）、id と JSON を入口で確かめ（016）、権限の無い人にカードの操作ボタンを出さない（019 の局所版）。(4) NEWS も同じ形で直す（SEC-NEWS-012・017・018・020）。(5) `/privacy` の誤り画面に窓口の案内を出し（SEC-PRIVACY-009）、最終改定日を追跡の切り替え日に追従させ（012）、`/api/auth/me` からメールを外す（SEC-HOME-016・SEC-PRIVACY-016）。(6) SEC-PRIVACY-011 は文の案だけを作る（コードも要件の本文も変えない）。

**Architecture:** 窓口ごと・頁ごとの局所の直しだけで進める。共有部品（`rateLimit.ts`・`admin-rbac.ts`・`proxy.ts`・`next.config.ts`・`authenticate.ts`・`audit.ts`・`mail.ts`・`has_permission`・`src/app/admin/page.tsx`・署名の共有ライブラリ `item/look/news-images.ts`）は触らず、呼ぶだけにする。足す共有の物は小さな新規ファイル 3 つだけ（追加のみ。Task 1）: `src/lib/http/no-store.ts`（`withNoStore`）、`src/lib/storage/image-signature.ts`（画像の先頭の印で種類を判定）、`src/lib/logging/safe-error.ts`（記録に残す誤りを名前と符号だけにする）。LOOK・NEWS・SEARCH・PRIVACY の新しい部品はそれぞれの領域の中に置く。窓口の数は増やさない（新しい `error.tsx` は窓口でも頁でもなく誤りの受け皿）。DB の変更が要る項目は「回す物」に載せる。

**Tech Stack:** Next.js `^16`（App Router・Route Handler・`error.tsx` の `retry`）、React `^19`、TypeScript、Supabase（`@supabase/ssr`・`service_role`・Storage）、Zod、Jest（単体・結合）、React Testing Library、Playwright（書くだけ）。依存は増やさない。

**Spec:** [`.superpowers/sdd/2026-10-25-security-gap-fixes/wave1c-decisions.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/wave1c-decisions.md)（ユーザー承認 2026-10-26「波1を全部（推奨）」と 1-C の 3 つの答え）。背景: 同ディレクトリの [`design-final.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md) の R10・R12・R13・R14・R16・R18 と §5 の Q11・Q17〜Q19・Q24、領域別の [`SEARCH.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/SEARCH.md)・[`LOOK.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/LOOK.md)・[`NEWS.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/NEWS.md)・[`STOCKIST.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/STOCKIST.md)・[`PRIVACY.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/PRIVACY.md)・[`HOME.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/HOME.md)。波 1-B の計画: [`2026-10-26-wave1b-local-fixes.md`](./2026-10-26-wave1b-local-fixes.md)（コミット `a824932e`。「回す物」の表で 1-C に回した物を本計画が受ける）。

---

## 概要

| 項目 | 内容 |
| --- | --- |
| 作成日 | 2026-10-26。コード・DB・テストは 1 行も変えていない（この計画の作成だけ） |
| 直す項目 | SEARCH 8（004・005・010・017・018 の記録・019・020 の外のサイト側・021）、LOOK 7（009・013・014・016・019 の局所版・021・022。014 の後始末を含む）、NEWS 5（006・012・017・018・020。1-B から回った PUT の 404 で残る画像を含む）、STOCKIST 2（010・014 の残り）、PRIVACY 3（009・012・016）と 011 の案、HOME 2（015 は SEARCH-021 と同じ部品、016 は `/api/auth/me`） |
| タスク | 10 つ（共有の部品と取扱店 1・SEARCH 2・LOOK 2・NEWS 2・PRIVACY と `/api/auth/me` 1・SEC-PRIVACY-011 の案 1・最終確認 1） |
| 新しい ADR | `ADR-0159`・`0160`・`0161`（LOOK）、`ADR-0266`（取扱店。no-store の包み方）、`ADR-0311`〜`0314`（SEARCH）、`ADR-0024`・`0025`（NEWS）、`ADR-0353`・`0354`（PRIVACY） |
| 新しいコード | `src/lib/http/no-store.ts`、`src/lib/storage/image-signature.ts`、`src/lib/logging/safe-error.ts`、`src/features/search/lib/query-schema.ts`・`cross-site.ts`、`src/features/look/services/admin-images.ts`、`src/features/news/lib/news-input.ts`・`src/features/news/services/admin-images.ts`、`src/app/look/error.tsx`・`src/app/news/error.tsx`・`src/app/privacy/error.tsx`、`src/app/privacy/revision-date.ts`。窓口は増やさない |
| 外す `test.fail` | 30 行（各タスクの「E2E の印」に行ごとに書く）と、分割する 1 行（`FR-SEARCH-022:302`）。外さない物（別の波・ENV・SEC-PRIVACY-011）も各タスクに書く |
| 新しい受け入れ条件 | `SEC-LOOK-019-AC-05`、`SEC-SEARCH-020-AC-02`、`SEC-SEARCH-021-AC-02`（画面の写真つき）。`SEC-LOOK-009-AC-01` の文は「価格を含めてよい」に直す（Q11） |
| 触らない共有文書 | `requirements.md`・`test-spec.md`・作業と指摘の台帳・`api-spec.md`・`route-inventory.md`・`tests/unit/docs/*-traceability.test.ts`・`db-migrations.md`。必要な変更は Task 10 の報告に書く |
| 流さないもの | E2E・サーバー・3000 番・DB 結合試験・`db reset`・全体の `jest`・`trace:report`・`test:trace-coverage`・`validate-trace --update-baseline`。DB 結合試験と E2E は書くだけ |
| 画面の写真 | サーバーを起動できないので撮らない。`SEC-SEARCH-021-AC-02` の E2E が 3 つの幅で `test-results/wave1c/search-021-preview-<幅>.png` に保存する。controller が E2E を流した直後に回収してユーザーに見せる（Playwright は次の実行の始めに `test-results` を空にする） |

## 前提の読み（決定文の解釈。controller の確認を求める点を含む）

実装者はこの節を変えない。食い違いに気付いたら止めて報告する。

| # | 読み | 根拠・影響 |
| --- | --- | --- |
| P1 | **SEC-LOOK-009（Q11）**: 一覧の応答から消すのは「説明文（`theme_description`）」だけ。関連商品の価格・名前・画像は今のカード（FREQ-144）が出すので残す。件数の上限は 100（`PUBLIC_LOOK_LIST_LIMIT`）。シーズンの絞り込みは今のまま（画面側）で、100 を超えたら見直す（ADR-0152・0153 に追記）。`SEC-LOOK-009-AC-01` の文から「関連商品の価格」を外し、E2E `FR-LOOK-SEC-001:425` の価格の確かめを消す | 決定文 1。LOOK 詳細は一覧の写しから現在の LOOK を取っていた（説明文もそこから）ので、**詳細の頁は現在の LOOK を `getPublishedLookById` から取り、前後は `getAdjacentPublishedLooks` で前後の 1 件ずつ（`id`・`theme` だけ）を取る形に変える**（Review Focus の 1）。これは `SEC-LOOK-009` の本文「詳細は対象の LOOK を1件で取り、前後の移動は前後の1件ずつだけを取る」そのままで、本文のこの部分は変えない（ユーザーの答えが直すのは価格と上限だけ）。100 件より古い LOOK も詳細が開き、前後のリンクも出る。一覧の並びは `created_at` の新しい順・同じ時刻は `id` の大きい順にそろえ、前後の取り出しも同じ並びで決める（レビューで直した。元の案は詳細の頁で一覧の 100 件を署名つきで取り直して位置で選び、100 件より古い LOOK の前後を出さない形で、本文と食い違っていた） |
| P2 | **SEC-SEARCH-017（Q17）**: 3 つの検索関数のどれか 1 つでも失敗したら `/api/search` は 500（固定の文 `Failed to search content`）。画面は既存の `!response.ok` で「検索結果を読み込めませんでした」を出す。候補（`/api/suggest`）は成功した種別だけ返し、失敗は符号だけ記録する。`DRV-SEARCH-003`（失敗した種別を空として続ける）は検索について逆になるので文を書き直す | 決定文の既定。NUL を含む語は入口で 400 にする（004）ので、この変更の後も NUL が 500 になる道は無い（004 と 017 は同じタスク） |
| P3 | **SEC-SEARCH-020(b)（Q18）**: `/api/search` と `/api/suggest` の先頭（検査・回数制限より前）で `Sec-Fetch-Site` を見て、無い・`same-origin`・`none` 以外（`cross-site`・`same-site`・知らない値）は 403。拒否した要求は枠に数えない。他の公開 GET には広げない。020 の (a)（偽の送り元で他人の枠を使い切る）は `rateLimit.ts`（共有）が要るので波 4。**E2E の `SEC-SEARCH-020-AC-01` は (a) と (b) を 1 本で見ているので、(b) を `SEC-SEARCH-020-AC-02` に分け、AC-01 は (a) だけにして印を残す** | 同じ試験の中に直せない半分が残るので、印を外せない。分けないと (b) を直しても「予想外の成功」が出ない |
| P4 | **R10**: `withNoStore` は応答の `Cache-Control` を `private, no-store` に置き換えるだけ。route 単位で、`proxy.ts` は触らない。対象: `/api/search`・`/api/suggest`（200・400・403・429・503・500）、`/api/news`（同）、取扱店の管理 6 ハンドラーの全応答（認可の 401・403、CSRF の拒否、回数制限の 429・503、本体）。`/api/auth` と管理の他の窓口の no-store は波 3 | 決定文の既定。値は E2E（`no-store` と `private` の両方）が見る形に合わせた |
| P5 | **SEC-LOOK-019 の局所版**: `GET /api/admin/looks` が応答に `meta.canManage` を足し、`LookSection` は `canManage === true` の時だけカードの 3 ボタン（公開/非公開・編集・削除）を出す（無い・偽は隠す。fail-closed）。`canManage` は G-3 の `GET /api/admin/packing` と同じ形（`admin.looks.manage` で認可をもう一度行い、403 だけ false、401・503 などはそのまま返す）。`admin-rbac.ts` に権限の集合を足す形は共有の変更なので波 4。**「新規作成」は `src/app/admin/page.tsx` のヘッダーにあり、役（`userRole === 'admin'`）で出している。これは波 4 まで直せない。だから `SEC-LOOK-019-AC-04`（新規作成も出ない）は赤のまま印を残し、カードの 3 ボタンだけを見る `SEC-LOOK-019-AC-05` を新しく足して緑にする** | 決定文の範囲の外に `src/app/admin/page.tsx`。二重の認可は往復が増えるが、G-3 が同じ形を既に使っている。読み出しだけの人の一覧で `console.warn('[RBAC] Permission denied …')` が 1 回増える |
| P6 | **画像の後始末（LOOK-014・NEWS-018）**: 順は「行を先に変える → 置き場を消す」。消す前に道筋を 1 本ずつ「自分の置き場の自分の接頭辞（`looks/`・`news/`）の下の安全な文字だけ」で確かめる（式は設計の X-3 と同じ）。確かめは領域の中に置く（`isOwnLookImagePath`・`isOwnNewsImagePath`）。署名の共有ライブラリが共有の確かめを持つ（波 3）ようになったら、その関数に差し替える。置き場の削除の失敗は記録するだけで応答は成功のまま | 決定文の既定（R14）。古い見本の道筋（`e2e/look-1-1.png` など。接頭辞が違う）は消さない側に倒れる |
| P7 | **公開の取り出しの失敗（LOOK-022・NEWS-020）**: 取り出しの失敗は throw にして、`error.tsx` の誤りの画面に出す。ホームの LOOK・NEWS の区画は今の「失敗しても落とさない」を保つ（`getPublishedLooks` は空の配列を返し続け、ニュースは `src/app/page.tsx` で `.catch(() => [])`）。ニュースの前後のリンクの取り出しだけは、失敗を記録して前後なしで返す（記事本体は出す）。LOOK の詳細の前後の一覧は同じく失敗しても前後なしで返す | 設計 R14 のとおり。前後は添え物なので、失敗で記事を隠さない。**LOOK は今、詳細の「関連の取り出し」の失敗を「関連なしで返す」にしているが、これも投げる側に直す**（関連が無いのか失敗なのかが見分けられないため。`ADR-0159` ではなく `DD-LOOK-032` に書く） |
| P8 | **SEC-NEWS-018 の PUT**: 画像を付けた PUT は、**画像を上げる前に**その記事の古い `image_url` を読む（無ければ 404 で、何も上げない）。1-B の報告にあった「無い id の PUT で上げた画像が置き場に残る」はこの順番で消える | 1-B の報告 5-5-5 |
| P9 | **`/api/auth/me`**: 外すのは `email` だけ。`id` は残す（SEC-PRIVACY-016 の E2E が `userId` を要求する）。`SEC-HOME-016` の本文は「id・メール」と書くが AC はメールだけを見る。**食い違いとして報告し、本文を「メールの住所を外した。id は…」に直す** | `design-final.md` R13 |
| P10 | **SEC-PRIVACY-009**: `error.tsx` を足しても HTTP 状態が 500 のままか未実測。`FR-PRIVACY-009` の `SEC-PRIVACY-005-AC-01`・`008-AC-01`（今は緑）と、印を外す `009-AC-01` 自身も `response.status() === 500` を前提にしているので、controller が E2E で確かめる。ずれたら `error.tsx` を消さずに、その 3 本の期待と `ADR-0354` を直す。**見込み（レビューで確かめた）**: 同梱の Next.js 16.3.6 の文書（`node_modules/next/dist/docs/01-app/02-guides/streaming.md` の「The HTTP contract」）は「状態が 200 に決まるのは Suspense の代わりの表示（`loading.tsx` など）が出て流し始めた後」と書く。`src/app/layout.tsx` は `children` を Suspense で包まず、`src/app` の直下・`privacy`・`look`・`news` に `loading.tsx` は無い。だから流し始める前の誤りで、`error.tsx` を出しても 500 のままの見込み。**実装者は `loading.tsx` と、頁の中の `<Suspense>` を足さない** | `PRIVACY.md` §009 の「要確認」 |
| P11 | **SEC-PRIVACY-011**: コードにも要件の本文にも入れない。`FR-PRIVACY-005:71`・`79` の印はそのまま。案は `wave1c-privacy-011-draft.md` に書き、controller がユーザーに見せる（Task 9） | 決定文 3 |
| P12 | **SEC-SEARCH-021 の画面**: 説明の文は固定「入力した語に関連する結果をホーム上で即時プレビューしています。」。語は説明の文の外の `<dl>`（`<dt>検索した語</dt><dd>…</dd>`）に出す。`<p>` に入れない。文言と枠の見た目は案なので、ユーザーに写真を見せて確かめるまで `ADR-0314` と要件は「案」と書く | 決定文 2。E2E は区画の中の `p` で文を探すので、語を `p` に入れない |
| P13 | **記録**: 触るファイルの `console.error(…, error)` は `describeErrorForLog(error)`（名前と符号だけ）に替える。触らないファイルは直さない（「回す物」に候補の束として載せた） | 1-B の報告 5-5-2。差し替えは機械的で、触るファイルの範囲に限る |

## Global Constraints

- 並行作業: 別セッション（G-3 発送）が同じ作業ツリーの別ファイルを編集し、コミットの時に全体の `tsc` を通す。**`git add`・`git commit`・`git stash`・`git checkout`・`git reset`・`git restore` は実行しない**（controller がタスクごとにコミットする）。コミットは作らない。
- **E2E・サーバー・3000 番・DB 結合試験・`db reset`・`supabase` の起動・全体の `jest`・`npm run test:trace-coverage`・`npm run trace:report`・`validate-trace --update-baseline` は実行しない**。流してよい `jest` は `npx jest <ファイル>` の対象指定だけ。DB 結合試験と E2E は書くだけ。
- `.ts` / `.tsx` を 1 つ編集するたびに `npx tsc --noEmit` を流し、自分の誤りをその場で直す。他者（G-3）の誤りが出たら触らず、報告に書く。
- 着手前に `git status --short` を見て、G-3 が変更中のファイルを確かめ、**重ならないようにする**。この計画のファイルは G-3 と別。`src/lib/orders/**`・`src/app/api/admin/shipment-slips/**`・`src/app/api/admin/packing/**`・`src/components/PackingSection.tsx`・`src/app/admin/page.tsx` は触らない。
- 触らない: `src/proxy.ts`、`next.config.ts`、`playwright.config.ts`、`src/features/auth/middleware/rateLimit.ts`・`src/features/auth/ratelimit/index.ts`（呼ぶだけ）、`src/lib/auth/authenticate.ts`・`admin-rbac.ts`（呼ぶだけ）、`src/lib/audit.ts`、`src/lib/mail.ts`、`src/app/admin/page.tsx`、`src/lib/storage/item-images.ts`・`look-images.ts`・`news-images.ts`（署名の共有。`extractLookImageObjectPath`・`extractNewsImageObjectPath` を**呼ぶだけ**。直しは波 3）、`supabase/migrations/**`（新しい移行を作らない）。
- 共有文書は**編集しない**: `docs/02_Requirements/requirements.md`、`docs/05_Quality/tests/test-spec.md`、`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`、`docs/03_BasicDesign/api/api-spec.md`、`docs/03_BasicDesign/api/route-inventory.md`、`tests/unit/docs/*-traceability.test.ts`、`docs/06_Operations/db-migrations.md`。必要な変更は各タスクの報告に「共有文書の変更案」として書く。
- 文書: 日本語。`documentation-guide`（`.claude/skills/documentation-guide/SKILL.md`）の項目の形（見出し直後の属性表）・ID の体系・TSDoc（`@packageDocumentation`・`@impl`・`@design`・`@remarks` に「なぜ」だけ）・テスト名の先頭に ID（E2E は受け入れ条件、結合は構造設計、単体は詳細設計）を守る。文書の冒頭の確認日は 2026-10-26。絵文字は使わない。要件は `docs/02_Requirements/areas/<area>.md`（`requirements.md` には書かない）。「今のコードは満たさない」は**直した項目だけ**外し、直していない部分（別の波）は残す。
- 新しい受け入れ条件を起こしたら、領域の要件のファイルの冒頭にある「E2E ファイルと受け入れ条件の対応表」の該当の行（例 `FR-LOOK-SEC-003-admin-api-authz` の行）にも足す。「E2E が無い受け入れ条件」の一覧に載っている物（`areas/look.md` の `SEC-LOOK-009-AC-02`）は、E2E を足したら一覧から外して対応表に移す。`SEC-LOOK-009-AC-02`・`SEC-LOOK-019-AC-05`・`SEC-SEARCH-020-AC-02`・`SEC-SEARCH-021-AC-02` が対象。
- コードのコメント: 範囲内の新しい単位（新ファイルの `export` した関数・クラス、新しい `error.tsx`）には TSDoc で `@impl`・`@design`・`@remarks`（「なぜ」だけ）を書く。変えた単位は `@remarks` が今の動きと食い違わないよう直す（例: `src/app/look/page.tsx` の「件数の上限を付けずに全部取る」、`src/lib/look/server.ts` の「取り出しの失敗は空の配列」）。`@impl` の番号は上の割当表から振り、同じ番号を 2 回使わない。コメント以外の変更をコメントの作業に混ぜない。
- 共有の新ファイル（`src/lib/http/*`・`src/lib/storage/image-signature.ts`・`src/lib/logging/*`）には `@impl` を付けない（共有部品にはコメントを入れない決まり）。テストは範囲外の名前にし、先頭に最初の利用者の `DD-` を付ける。
- 番号は**書く直前に再確認**する: `grep -rhoE "IMPL-(LOOK|NEWS|SEARCH|PRIVACY)-[0-9]+" src | sort -u | tail`（今は LOOK 146・NEWS 166・SEARCH 125・PRIVACY 101 が最大）、`ls docs/03_BasicDesign/decisions | grep -E "ADR-(015|0266|031|0353|002)"`、`grep -rhoE "DD-(LOOK|NEWS|SEARCH|PRIVACY)-[0-9]+" docs/04_DetailDesign | sort -u | tail`。違えば割当表をずらして一貫させる。
- 入力は信用しない: 記録・監査に、検索語・メール・トークン・Supabase の誤りの文・ファイル名・画像の道筋の全体を残さない。残してよいのは固定の符号・名前・符号（`code`）・件数だけ。
- 実装は最小。決定にない設定項目・追加の API・画面は作らない。作業ツリーに CRLF のファイルがある。編集は Edit で行い、`sed -i` は使わない（`\` が落ちて CRLF を壊す）。`graphify update` は自分で流さない（コミットのフックが後ろで作り直す）。
- E2E は既存の spec に足す。新しい spec ファイルは作らない。新しい E2E は mobile 390・tablet 768・desktop 1280 の 3 つの幅で書く（DB に大量に入れる試験は入れるのを 1 回にして、3 つの幅で読む）。

### ID の割当

| 種類 | ID | 題 | タスク |
| --- | --- | --- | --- |
| ADR | `ADR-0159` | LOOK の一覧は 100 件まで取り、説明文を取らない（価格は残す） | 4 |
| ADR | `ADR-0160` | 管理の LOOK の画像は、行を変えた後に置き場から消し、失敗は記録だけにする | 5 |
| ADR | `ADR-0161` | 管理の LOOK の操作ボタンは窓口の `meta.canManage` で出し分ける（暫定は認可の 2 回目） | 5 |
| ADR | `ADR-0266` | 取扱店の管理の応答は route の包みで `private, no-store` にする | 1 |
| ADR | `ADR-0311` | 検索は関数が 1 つでも失敗したら全体を失敗にする | 2 |
| ADR | `ADR-0312` | 検索の窓口は `Sec-Fetch-Site` が同一オリジンでない要求を 403 にする | 2 |
| ADR | `ADR-0313` | 候補の取得は 250 ミリ秒待ち、古い要求を打ち切る | 2 |
| ADR | `ADR-0314` | ホームのプレビューは検索語を説明の文に埋めず「検索した語」の枠に出す（案） | 3 |
| ADR | `ADR-0024` | 公開のニュースの取り出しの失敗は throw にし、前後だけ握る | 6 |
| ADR | `ADR-0025` | 管理のニュースの画像は DB の変更の後に消し、失敗は記録だけにする | 7 |
| ADR | `ADR-0353` | 最終改定日は固定の基準日と追跡の切り替え日（日本時間）の遅いほうにする | 8 |
| ADR | `ADR-0354` | `/privacy` の誤りの画面は案内だけを出し、方針の本文も誤りの文も出さない | 8 |
| 実装 | `IMPL-LOOK-147` | `parseLookId`（`@design DD-LOOK-068`） | 4 |
| 実装 | `IMPL-LOOK-148` | `getPublishedLookList`（`@design DD-LOOK-003`） | 4 |
| 実装 | `IMPL-LOOK-149` | `LookFetchError`（`@design DD-LOOK-003`） | 4 |
| 実装 | `IMPL-LOOK-150` | `src/app/look/error.tsx`（`@design DD-LOOK-069`） | 4 |
| 実装 | `IMPL-LOOK-151`〜`154` | `prepareLookImage`・`buildLookImagePath`・`isOwnLookImagePath`・`removeLookImages`（`@design DD-LOOK-070`。`listRemovableLookImagePaths` は 155） | 5 |
| 実装 | `IMPL-LOOK-156` | `getAdjacentPublishedLooks`（`@design DD-LOOK-032`。レビューで足した。番号は Task 5 の 151〜155 の後ろ） | 4 |
| 実装 | `IMPL-SEARCH-126`・`127`・`128` | `searchQuerySchema`（`DD-SEARCH-009`）、`rejectCrossSiteFetch`（`DD-SEARCH-010`）、`SearchBackendError`（`DD-SEARCH-006`） | 2 |
| 実装 | `IMPL-NEWS-167`〜`174` | `news/error.tsx`（`DD-NEWS-069`）、`isNewsId`・`resolveNewsCategory`（`DD-NEWS-070`）、`NewsFetchError`（`DD-NEWS-003`）、管理の画像の 4 関数（`DD-NEWS-071`） | 6・7 |
| 実装 | `IMPL-PRIVACY-102`・`103` | `error.tsx`（`DD-PRIVACY-002`）、`resolveRevisionDate`（`DD-PRIVACY-003`） | 8 |
| 受け入れ条件 | `SEC-LOOK-019-AC-05` | 権限の無い人にカードの公開の切り替え・編集・削除が出ない | 5 |
| 受け入れ条件 | `SEC-SEARCH-020-AC-02` | 外のオリジンの頁から読み込ませた要求は 403 で、その閲覧者のプレビューが止まらない | 2 |
| 受け入れ条件 | `SEC-SEARCH-021-AC-02` | 検索語が固定の説明の文と分かれた「検索した語」の枠に出る（3 つの幅の写真つき） | 3 |

---

## Review Focus（最も踏みやすい失敗 5 つ）

レビュアーと実装者は、各タスクの前後でこの 5 つを具体的な入力で確かめる。

1. **LOOK の一覧の上限 100 と詳細の頁の結び付き。** 詳細の頁は今、一覧の写し（`getPublishedLooks()` の全件）から現在の LOOK を `findIndex` で選び、説明文・関連商品・画像もそこから出している。一覧から `theme_description` を外して 100 件で切ると、(a) 詳細の説明文が空になる、(b) 101 番目より古い LOOK の詳細が「Look not found」になる、のどちらかが起きる。詳細は現在の LOOK を `getPublishedLookById` で取り、前後は `getAdjacentPublishedLooks` で前後の 1 件ずつを取る（一覧の 100 件を取り直さない。`SEC-LOOK-009` の本文のとおり）。並びは一覧と同じ `created_at` の新しい順・同じ時刻は `id` の大きい順。確かめる入力: 101 件ある時の最も古い LOOK の `/look/<id>` が開く・説明文が出る・PREV（1 つ新しい LOOK）のリンクがあり NEXT が無効。見本の LOOK 1〜7 の前後（`FR-LOOK-DETAIL-003`）が今と同じ。型は `PublicLookListItem`（説明文なし）と `PublicLook`（説明文あり）を分ける。ホーム・グリッドは説明文を使わないこと、`tests/` の見本の `themeDescription` が型の余分な項目の誤り（`tsc`）になる所を数えて直す。`/look` の HTML と RSC の受け渡しに見本の説明文が出ないことは E2E（`FR-LOOK-SEC-001:425`）が見る。
2. **誤りの画面（`error.tsx`）の導入が他を壊す。** 新しい `src/app/look/error.tsx`・`src/app/news/error.tsx`・`src/app/privacy/error.tsx` は、その頁の誤りを受ける。(a) **HTTP 状態**: `/privacy` の E2E（`FR-PRIVACY-009` の `005-AC-01`・`008-AC-01`、今は緑）は 500 を前提にしている。`error.tsx` を足して 200 になると緑が赤になる（P10。controller が本番ビルドで確かめる）。`/look` の E2E は「状態 500 以上、または本文に `エラー|error|problem|失敗|障害`」のどちらかを許すので、誤りの文に「エラー」を入れる。(b) **ホームを落とさない**: ニュースの取り出しを throw にした後、`src/app/page.tsx` の `Promise.all` の中の `getPublishedNews` に `.catch(() => [])` が無いとホーム全体が落ちる。LOOK は `getPublishedLooks`（空を返す側）を使い続ける。(c) **誤りの本文を出さない**: `error.message`・`stack` を画面にも `console.error` にも出さない（`digest` だけ）。(d) `retry` の props 名は既存の `src/app/checkout/error.tsx` と同じ。
3. **画像の中身の確かめと後始末の順序。** (a) 中身の確かめは**置き場に書く前・量の枠を使う前**に済ませる（偽の画像で 1 時間の枠を消費させない）。申告と検出が違えば 400、保存名は検出した種類の対応表から作る（送られた名前から作らない）。(b) 既存のテストの偽の画像（`new File(['img'], …)`）は印が無く 400 になる。`tests/fixtures/images.ts` の本物の最小の PNG 等に替える（数えて同じタスクで直す）。(c) 後始末は「行の更新が成功した後」にだけ古い画像を消す。更新が失敗したら、**その要求で上げた新しい画像**を消す。行が新しい道筋を指した後に関連の保存が失敗した場合は、新しい画像は消さず（行が指している）古い画像を消す。(d) 消す道筋は 1 本ずつ「自分の置き場の自分の接頭辞の下」であることを確かめ、`..`・外の URL・別の置き場・古い見本の道筋は渡さない。同じ道筋が新旧に残る時は消さない。(e) 置き場の削除の失敗で応答を失敗にしない（200 のまま、監査の `metadata` に件数）。(f) NEWS の PUT は画像を上げる**前**に古い `image_url` を読む（P8）。
4. **no-store の付け漏れと上書き。** `withNoStore` で包むのは**全ての `return`** と外側の `catch` の 500。`authz.response`（401・403・503）、CSRF の拒否、`enforceRateLimit` の 429・503、400 の検証、404 が漏れやすい。各ハンドラーを内側の関数に改名して `export` を包みで返す形にし、単体試験は「戻りの全分岐」の表で 1 つずつ確かめる。包む対象は `NextResponse` か `new Response(...)`（どちらもヘッダーを書き換えられる。`Response.redirect()` や `fetch` の戻りは書き換えられないが、この窓口群には無い）。`proxy.ts`・`next.config.ts` が後から別の値を付けて上書きしないかは未確認なので、**E2E が見出しの値そのものを見る**（`FR-STOCKIST-015:239`・`FR-SEARCH-019:99`・`FR-NEWS-SEC-003:134・194`）。`/api/news` の 200 に `no-store` を付けると CDN で使い回せなくなるが、回数制限（送り元単位）を飛ばさせないために意図して付ける。
5. **SEARCH の挙動と E2E の分け方。** (a) 017: 3 つの関数の 1 つが失敗したら 500。004（制御文字を入口で 400）が先か同時でないと、NUL の語が 500 になる。`getSearchSuggestions` は失敗しても投げない。(b) 020(b): `Sec-Fetch-Site` が付かない要求（curl・Playwright の `request`・古いブラウザ）は通す。`same-site` は断る。検査は zod・回数制限より前（拒否は枠に数えない）。同じ画面からの `fetch` は `same-origin` なので壊れない。(c) 005: 候補の 250 ミリ秒の待ちと打ち切りで、最後の文字の応答が前の応答に上書きされない（`cancelled` と `abort` の両方）。検索の effect を `[query]` だけにしても、URL の `tab` は最新の値を `useRef` から読む。(d) `FR-SEARCH-022` は `isolated-global`（回数の枠を使い切る）で、`SEC-SEARCH-020-AC-01` は (a) が残るため印を外さない。分けた `AC-02` の印は無い。印の取り違えは「予想外の成功」か本当の赤になる。

---

## ファイルの全体像

| 区分 | ファイル | 操作 | タスク |
| --- | --- | --- | --- |
| 共有（新規・小） | `src/lib/http/no-store.ts`、`src/lib/storage/image-signature.ts`、`src/lib/logging/safe-error.ts`、`tests/fixtures/images.ts` | 新規 | 1 |
| 取扱店 | `src/app/api/admin/stockists/route.ts`・`[id]/route.ts`、`src/features/stockist/services/public.ts` | 変更 | 1 |
| SEARCH 窓口 | `src/app/api/search/route.ts`、`src/app/api/suggest/route.ts`、`src/features/search/lib/query-schema.ts`・`cross-site.ts`（新規）、`src/features/search/services/search.service.ts`、`src/features/search/components/SearchPageClient.tsx` | 変更・新規 | 2 |
| SEARCH 画面 | `src/features/search/components/SearchHomePreview.tsx` | 変更 | 3 |
| LOOK 公開 | `src/lib/look/server.ts`・`public.ts`、`src/app/look/page.tsx`・`[id]/page.tsx`・`error.tsx`（新規）、`src/features/look/components/PublicLookGrid.tsx`（型だけ） | 変更・新規 | 4 |
| LOOK 管理 | `src/app/api/admin/looks/route.ts`・`[id]/route.ts`、`src/components/LookSection.tsx`、`src/features/look/services/admin-images.ts`（新規） | 変更・新規 | 5 |
| NEWS 公開 | `src/app/api/news/route.ts`、`src/features/news/services/public.ts`、`src/features/news/lib/news-input.ts`（新規）、`src/app/news/page.tsx`・`[id]/page.tsx`・`error.tsx`（新規）、`src/app/page.tsx` | 変更・新規 | 6 |
| NEWS 管理 | `src/app/api/admin/news/route.ts`・`[id]/route.ts`、`src/components/NewsSection.tsx`、`src/app/admin/news/edit/[id]/page.tsx`、`src/features/news/services/admin-images.ts`（新規） | 変更・新規 | 7 |
| PRIVACY・認証の状態 | `src/app/privacy/page.tsx`（最終改定日の 1 行だけ）・`error.tsx`・`revision-date.ts`（新規）、`src/app/api/auth/me/route.ts` | 変更・新規 | 8 |
| 文の案 | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1c-privacy-011-draft.md` | 新規（文書のみ） | 9 |
| 文書 | `docs/02_Requirements/areas/{search,look,news,stockist,privacy,home,auth}.md`、`docs/05_Quality/security/threats/{search,look,news,stockist,privacy,home,auth}.md`、`docs/03_BasicDesign/areas/{search,look,news,stockist,privacy,home,auth}.md`、`docs/03_BasicDesign/decisions/ADR-0159・0160・0161・0266・0311〜0314・0024・0025・0353・0354`（新規）、`docs/04_DetailDesign/pages/{19_search,06_look_list,07_look_detail,16-3_admin_look,02_news_list,03_news_detail,16-1_admin_news,10_stockist,16-4_admin_stockist,17-1_privacy,01_home}.md` | 追記・更新 | 全部 |
| E2E | `e2e/FR-SEARCH-018・019・022`、`FR-LOOK-SEC-001・003・004・005`、`FR-NEWS-SEC-001・003・005`、`FR-NEWS-ADMIN-001`、`FR-STOCKIST-015`、`FR-HOME-022`、`FR-PRIVACY-006・008・009` | `test.fail` の印の削除・期待の更新・新しい `test` の追加（書くだけ） | 1〜8 |

**進める順（計画のレビューで直した）。** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 10 の**直列だけ**にする。並行にしてよいのは Task 9（`.superpowers/` の文書 1 つだけを書く）だけで、いつ流してもよい。元の案の「列の間は並行」は、下の表のとおり列をまたいで重なる物（`home.md` 系は 3・6・8、`home-page-public-read.test.ts` は 1・4・6）があり、さらに各タスクの `npx tsc --noEmit` が他のタスクの書きかけの誤りを拾って「自分の誤りか」を見分けにくくするので採らない。src・試験・E2E のファイルは下の表の物を除いてタスクの間で重ならない。

| 重なる物 | 触るタスク | 順 |
| --- | --- | --- |
| Task 1 が作る 4 つの共有ファイル（`no-store.ts`・`image-signature.ts`・`safe-error.ts`・`tests/fixtures/images.ts`） | 2・4・5・6・7 が使う | 1 が先（他は全て 1 の後） |
| `tests/integration/api/home-page-public-read.test.ts` | 1（取扱店）・4（LOOK）・6（NEWS） | 1 → 4 → 6（各タスクは自分の節の describe だけ触る） |
| `tests/integration/api/look-image-signing.test.ts`、`e2e/FR-LOOK-SEC-005`（Task 4 は `:100` と新しい 009-AC-02、Task 5 は `:50`・`:134`） | 4・5 | 4 → 5 |
| `docs/*/areas/home.md`・`threats/home.md`・`areas/home.md`（構造設計）・`01_home.md` | 3（SEC-HOME-015）・6（`page.tsx` の `.catch`・`FREQ-147` の古い一文）・8（SEC-HOME-016） | 3 → 6 → 8（別の節を足す。同時に編集しない） |
| `e2e/FR-HOME-022-home-response-hardening.spec.ts`（Task 3 は `:208`、Task 8 は `:215` を外す） | 3・8 | 3 → 8 |
| `docs/*/areas/search.md` 系 | 2・3 | 2 → 3 |
| `docs/*/areas/look.md` 系 | 4・5 | 4 → 5 |
| `docs/*/areas/news.md` 系、`src/features/news/lib/news-input.ts`（6 が作り 7 が使う） | 6・7 | 6 → 7 |
| `docs/*/areas/auth.md` 系 | 8 だけ（`DRV-AUTH-007`・`API-AUTH-013`・`DD-AUTH-026`） | — |

---

## Task 1: 共有の小さな部品を足し、取扱店の管理の窓口に no-store を付ける（SEC-STOCKIST-010・014 の残り）

**範囲:** 共有の追加物 3 つと試験の見本 1 つ（他のタスクが使う）。SEC-STOCKIST-010（管理の応答の `Cache-Control`）、SEC-STOCKIST-014 のうち 1-B で残った分（各 route の外側の `catch` と公開の取り出しの記録が誤りを丸ごと渡している）。

**Files:**

- Create: `src/lib/http/no-store.ts`、`src/lib/storage/image-signature.ts`、`src/lib/logging/safe-error.ts`、`tests/fixtures/images.ts`、`tests/unit/lib/http/no-store.test.ts`、`tests/unit/lib/storage/image-signature.test.ts`、`tests/unit/lib/logging/safe-error.test.ts`
- Modify: `src/app/api/admin/stockists/route.ts`（`IMPL-STOCKIST-141`・`DD-STOCKIST-034`）、`src/app/api/admin/stockists/[id]/route.ts`（`IMPL-STOCKIST-142`・`DD-STOCKIST-035`）、`src/features/stockist/services/public.ts`（`IMPL-STOCKIST-103`・`DD-STOCKIST-003`。記録だけ）
- Test: `tests/unit/api/admin/stockists/stockists-route.test.ts`・`stockists-id-route.test.ts`、`tests/unit/api/admin/stockists-security.test.ts`（変更が要るか確認）、`tests/unit/features/stockist/stockist-public-service.test.ts`、`tests/integration/api/stockist-admin-list-api.test.ts`・`stockist-admin-item-get-api.test.ts`・`stockist-admin-item-put-api.test.ts`・`stockist-admin-item-patch-api.test.ts`・`stockist-admin-item-delete-api.test.ts`・`stockist-admin-create-api.test.ts`・`stockist-admin-guards.test.ts`・`stockist-admin-write-path.test.ts`・`stockist-admin-csrf-real-response.test.ts`、`tests/integration/api/home-page-public-read.test.ts`（取扱店の節だけ）
- E2E: `e2e/FR-STOCKIST-015-admin-api-behaviour.spec.ts`
- Docs: `docs/02_Requirements/areas/stockist.md`、`docs/05_Quality/security/threats/stockist.md`、`docs/03_BasicDesign/areas/stockist.md`、`docs/03_BasicDesign/decisions/ADR-0266-stockist-admin-private-no-store-wrapper.md`（新規）、`docs/04_DetailDesign/pages/16-4_admin_stockist.md`・`10_stockist.md`

**Interfaces:**

```ts
// src/lib/http/no-store.ts（共有。@impl なし）
export const NO_STORE_CACHE_CONTROL = 'private, no-store';
/** 応答の Cache-Control を置き換えて同じ応答を返す。状態・本文・ほかの見出し（Retry-After・Set-Cookie など）は変えない。 */
export function withNoStore<T extends Response>(response: T): T;

// src/lib/storage/image-signature.ts（共有。@impl なし）
export type DetectedImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
export const IMAGE_EXTENSION_BY_TYPE: Readonly<Record<DetectedImageType, 'jpg' | 'png' | 'webp' | 'gif'>>;
/** 先頭の印で判定: JPEG FF D8 FF / PNG 89 50 4E 47 0D 0A 1A 0A / GIF "GIF87a"・"GIF89a" / WebP "RIFF"....."WEBP"。足りない長さ・知らない印は null。 */
export function detectImageType(bytes: Uint8Array): DetectedImageType | null;
/** 申告の種類と検出した種類が同じ時だけ { type, extension } を返す。違えば null（保存名は送られた名前からでなく、この対応表から作る）。 */
export function resolveUploadImageType(declaredType: string, bytes: Uint8Array): { type: DetectedImageType; extension: string } | null;

// src/lib/logging/safe-error.ts（共有。@impl なし）
/** 記録に残してよい誤りの項目。message・details・hint・stack・入力の値は残さない。name は /^[A-Za-z0-9_$.-]{1,64}$/ に合う時だけ（Error 以外は 'UnknownError'）、code は /^[A-Za-z0-9_.-]{1,32}$/ に合う文字か整数だけ（無ければ null）。 */
export function describeErrorForLog(error: unknown): { name: string; code: string | null };

// tests/fixtures/images.ts（試験の見本。*.test.ts でないので jest は流さない）
export function minimalPng(): Buffer; export function minimalJpeg(): Buffer; export function minimalGif(): Buffer; export function minimalWebp(): Buffer;
export function textAsImage(): Buffer; // 先頭の印が無い文字列
export function fileOf(bytes: Buffer, name: string, type: string): File;

// 取扱店の route: 各ハンドラーを内側の関数（listStockists など）にし、export は包みで返す
export async function GET(request: Request) { return withNoStore(await listStockists(request)); }
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "test.fail" e2e/FR-STOCKIST-015-*.ts`（239 と 281 が残る見込み。281 は外さない）。取扱店の 2 つの route の全 `return` の数と、外側の `catch` の `console.error(…, error)` の行（`route.ts` 54・159、`[id]/route.ts` 76・203・323・419）。`rateLimit.ts` の返す応答が `NextResponse` か `new Response(...)`（試験環境の逃げ道）で、どちらも `headers.set` ができること。`csrfMiddleware.ts` の拒否も `NextResponse`。
- [ ] **Step 2（RED）: 単体試験を書く。**
  - `no-store.test.ts`（先頭 `DD-STOCKIST-034`）: `NextResponse.json({a:1}, {status: 429, headers: {'Retry-After': '30'}})` を包むと `Cache-Control` が正確に `private, no-store`、`Retry-After` が `30`、状態 429、本文 `{a:1}`、戻りが同じ参照。既に `Cache-Control: s-maxage=60` がある応答は上書きされる（`s-maxage` が残らない）。`Set-Cookie` を持つ応答の Cookie が消えない。`Response.json()`（`NextResponse` でない）も包める。
  - `image-signature.test.ts`（先頭 `DD-LOOK-063`）: 本物の最小の PNG・JPEG（`FF D8 FF E0`）・GIF（`GIF87a` と `GIF89a`）・WebP（`RIFF` + 4 バイト + `WEBP`）を表で確かめ、それぞれ `image/png`・`image/jpeg`・`image/gif`（2 件）・`image/webp`。null になる物: 空、7 バイトの PNG の印、`<!doctype html>`、`<svg`、`BM`（BMP）、`RIFF....WAVE`、`GIF88a`、文字列 `this is plain text`。`resolveUploadImageType('image/png', jpegBytes)` は null（申告と検出が違う）、`('image/png', pngBytes)` は `{ type: 'image/png', extension: 'png' }`、`('image/jpg', jpegBytes)`（知らない申告）は null。拡張子の対応は jpeg→jpg を含む 4 件。
  - `safe-error.test.ts`（先頭 `DD-SEARCH-006`）: `new Error('secret token abc')` → `{ name: 'Error', code: null }` で JSON に `secret` が無い。Supabase の誤りの形 `{ code: '42501', message: 'permission denied for table x', details: '…', hint: '…' }`（プレーンな物）→ `{ name: 'UnknownError', code: '42501' }`。`code` が長い文字・空白入り・オブジェクトなら `null`。`code` が整数 `500` なら `'500'`。`null`・`undefined`・文字列の入力でも投げない。`name` が `'Err or'`（空白入り）の `Error` は `UnknownError`。
  - 取扱店 `stockists-route.test.ts`・`stockists-id-route.test.ts`（先頭 `DD-STOCKIST-034`・`DD-STOCKIST-035`）: 「戻りの全分岐」の表で、`Cache-Control` が正確に `private, no-store`。GET 一覧: 200・認可の 401（`authz.response`）・403・読みの回数制限の 429 と 503・DB の誤りの 500・外側の catch の 500。POST: 201・400（壊れた JSON と検証）・CSRF の拒否・書きの回数制限の 429・500。`[id]` の GET（200・400 の id・404・500）・PUT・PATCH・DELETE（200・404・500・429・CSRF）。外側の `catch` の `console.error` の第 2 引数が `{ name, code }` ちょうどで、投げた `Error` の `message` を含まない。
  - `stockist-public-service.test.ts`（先頭 `DD-STOCKIST-003`）: `createPublicClient` の取り出しが誤りの時、`console.error` の第 2 引数が `{ name, code }` だけ（誤りの全体を渡さない）。戻りは今までどおり空の配列。
- [ ] **Step 3（GREEN）: 実装する。** 共有 3 ファイルと見本 → 取扱店の 2 つの route → `public.ts`。`tsc` を流す。route は各ハンドラーを内側の関数に改名し、`export async function GET/POST/PUT/PATCH/DELETE` が `withNoStore(await …)` を返す。外側の `catch` の `console.error` を `describeErrorForLog` に替える。`@impl`・`@design` の番号は変えない（ファイルの単位）。
- [ ] **Step 4: 結合試験を直す。** 取扱店の結合試験は応答の見出しを見ないので、通るままの見込み。`stockist-admin-*` で `console.error` の引数を固定している所があれば `{ name, code }` に直す。`home-page-public-read.test.ts` の取扱店の節は `console.error` の引数を固定していないかだけ確かめる。
- [ ] **Step 5: 対象の `jest` を流す。** `npx jest tests/unit/lib/http tests/unit/lib/storage/image-signature.test.ts tests/unit/lib/logging tests/unit/api/admin/stockists tests/unit/api/admin/stockists-security.test.ts tests/unit/features/stockist tests/integration/api/stockist-admin-list-api.test.ts tests/integration/api/stockist-admin-item-get-api.test.ts tests/integration/api/stockist-admin-item-put-api.test.ts tests/integration/api/stockist-admin-item-patch-api.test.ts tests/integration/api/stockist-admin-item-delete-api.test.ts tests/integration/api/stockist-admin-create-api.test.ts tests/integration/api/stockist-admin-guards.test.ts tests/integration/api/stockist-admin-write-path.test.ts tests/integration/api/stockist-admin-csrf-real-response.test.ts tests/integration/api/home-page-public-read.test.ts`。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-STOCKIST-015:239`（`SEC-STOCKIST-010-AC-01`。一覧・1 件・無い id の 404・21 回目の PATCH の 429 の `Cache-Control` に `no-store` と `private`）。
  - 外さない: `FR-STOCKIST-015:281`（`SEC-STOCKIST-012` IP は波 4）、`FR-STOCKIST-013:119・237`（`stockists.type` は波 2）、`:320・332`（`SEC-STOCKIST-019` は波 4）、`FR-STOCKIST-014:520・550`（波 4）、`FR-STOCKIST-016`（波 5）。
  - `proxy.ts` の `Forbidden origin` の 403（route に届く前）には付かない（波 3）。E2E の 4 つの応答は route を通るので足りる。
- [ ] **Step 7: 文書。** `areas/stockist.md`: `SEC-STOCKIST-010` の「今のコードは満たさない」を外して現行を書く（「`/api/admin/stockists*` の応答は route の包みで `private, no-store`。`proxy.ts` が返す Origin の 403 は波 3」）。`SEC-STOCKIST-014` は「外側の `catch` と公開の取り出しの記録も名前と符号だけにした」と書き、1-B で残した一文を外す。`threats/stockist.md`: `THR-STOCKIST-010`・`014`。`areas/stockist.md`（構造設計）: `ARC-STOCKIST-003`（包み）、`API-STOCKIST-001`〜`006` の応答の見出し。`16-4_admin_stockist.md`: `DD-STOCKIST-034`・`035` の入出力に `Cache-Control` を足す。`10_stockist.md`: `DD-STOCKIST-003` の記録。`ADR-0266` を新規（背景: 共有の包みが無く各領域がばらばら／決定: route の外側の包み／退けた案: `proxy.ts` 一括・`next.config` の `headers()`／結果）。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- STOCKIST`（`--update-baseline` はしない）。
- [ ] **Step 9: 報告。** 変えたファイル、外した印の行番号、共有文書の変更案（`api-spec.md`: 取扱店の管理の応答に `Cache-Control: private, no-store`）。共有 3 ファイルと見本の場所を他のタスクのために書く。コミットは作らない。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- STOCKIST`。

---

## Task 2: SEARCH 窓口・取り出し・画面の呼びすぎ（SEC-SEARCH-004・005・010・017・018 の記録・019・020 の外のサイト側）

**範囲:** 検索の入口の決まりを 1 つにし、応答の見出しを整え、外のサイトからの要求を断り、関数の失敗を失敗にして、画面の呼びすぎを止める。**SEC-SEARCH-021（ホームの説明の文）は Task 3**。署名（014〜016）・DB の関数（003・007・008）・送り元の信頼（006・020 の (a)）は触らない。

**Files:**

- Create: `src/features/search/lib/query-schema.ts`（`IMPL-SEARCH-126`・`DD-SEARCH-009`）、`src/features/search/lib/cross-site.ts`（`IMPL-SEARCH-127`・`DD-SEARCH-010`）、`tests/unit/features/search/query-schema.test.ts`、`tests/unit/features/search/cross-site.test.ts`
- Modify: `src/app/api/search/route.ts`（`IMPL-SEARCH-121`・`DD-SEARCH-004`）、`src/app/api/suggest/route.ts`（`IMPL-SEARCH-122`・`DD-SEARCH-005`）、`src/features/search/services/search.service.ts`（`IMPL-SEARCH-123`・`124`、`SearchBackendError` は `IMPL-SEARCH-128`・`DD-SEARCH-006`）、`src/features/search/components/SearchPageClient.tsx`（`IMPL-SEARCH-102`・`DD-SEARCH-002`）
- Test: `tests/unit/api/search/search-route.test.ts`・`suggest-route.test.ts`、`tests/unit/features/search/search-service-execute.test.ts`・`search-service-suggestions.test.ts`・`search-page-client.test.tsx`、`tests/unit/app/search/search-page.test.tsx`（確認）、`tests/integration/api/search-public-api.test.ts`・`search-suggest-api.test.ts`・`search-request-path.test.ts`・`search-rate-limit-proxy.test.ts`・`search-image-signing.test.ts`・`search-popular-items.test.ts`・`search-ranking-snippet.test.ts`、`tests/integration/ui/search-suggestion-screen.test.tsx`・`search-suggestion-state.test.tsx`・`search-commit-flow.test.tsx`・`search-results-screen.test.tsx`・`search-results-state.test.tsx`・`search-entry-detail-flow.test.tsx`・`search-page-frame-screen.test.tsx`
- E2E: `e2e/FR-SEARCH-019-search-api-contract-and-headers.spec.ts`、`e2e/FR-SEARCH-022-search-rate-limit.spec.ts`
- Docs: `docs/02_Requirements/areas/search.md`、`docs/05_Quality/security/threats/search.md`、`docs/03_BasicDesign/areas/search.md`、`docs/03_BasicDesign/decisions/ADR-0311-search-any-function-failure-fails-whole.md`・`ADR-0312-search-reject-cross-site-fetch.md`・`ADR-0313-search-suggest-debounce-abort.md`（新規）、`docs/04_DetailDesign/pages/19_search.md`

**Interfaces:**

```ts
// query-schema.ts
export const searchQuerySchema: z.ZodType<string>; // z.string().trim().max(100).refine(v => !/[\x00-\x1F\x7F]/.test(v), …)。/api/search と /api/suggest が同じ物を使う
// cross-site.ts
/** sec-fetch-site が無い・'same-origin'・'none' なら null（通す）。それ以外は 403 { error: 'Forbidden' } を返す（withNoStore 済み）。 */
export function rejectCrossSiteFetch(request: Request): NextResponse | null;
// search.service.ts
export class SearchBackendError extends Error { readonly fn: 'search_items' | 'search_looks' | 'search_news'; readonly code: string | null }
// executeSearch: 3 つの関数のどれかが error なら { fn, name, code } だけを console.error して SearchBackendError を投げる（検索語を記録しない）。
// getSearchSuggestions: 失敗した関数を同じ形で記録し、成功した種別だけで返す（投げない）。getPopularItems の記録も describeErrorForLog。
// 窓口の順: rejectCrossSiteFetch → zod（400）→ enforceRateLimit → 本体。全ての応答を withNoStore で包む。x-search-duration-ms は付けない。
// SearchPageClient: 候補は 250ms 待ち（SUGGEST_DEBOUNCE_MS）+ AbortController。検索の effect の依存は [query] だけで、tab は useRef から読む。console.error に Error を渡さない。
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "test.fail" e2e/FR-SEARCH-019-*.ts e2e/FR-SEARCH-022-*.ts`（019: 74・99・142・160、022: 216・282・302・386）。`grep -rn "x-search-duration-ms" src tests docs --include=*.ts --include=*.tsx --include=*.md`。`executeSearch` の呼び手が `/api/search` だけであること（確認済み）。`SearchPageClient.tsx` の 2 つの effect（検索と候補）と `results.tab` を読む所が無いこと。
- [ ] **Step 2（RED）: 単体試験を書く。**
  - `query-schema.test.ts`（先頭 `DD-SEARCH-009`）: `'coat'` は通る、前後の空白は取る、`'a'.repeat(100)` は通り `'a'.repeat(101)` は断る、`'a\u0000b'`・`'a\u001Fb'`・`'a\u007Fb'`・`'a\nb'`（途中の改行）は断る、全角空白・絵文字・日本語は通る。
  - `cross-site.test.ts`（先頭 `DD-SEARCH-010`）: 見出し無し・空文字・`same-origin`・`none` は null。`cross-site`・`same-site`・`Cross-Site`（大文字違いは正規化して判定）・知らない値 `foo` は 403 で、本文 `{ error: 'Forbidden' }`、`Cache-Control: private, no-store`。
  - `search-route.test.ts`（先頭 `DD-SEARCH-004`）: (a) `sec-fetch-site: cross-site` の GET は 403 で、`enforceRateLimit` と `executeSearch` が呼ばれない。(b) `q=a%00b` は 400 で `executeSearch` が呼ばれない。(c) 成功の応答に `x-search-duration-ms` が無く、`Cache-Control` が `private, no-store`。(d) 400・429（`enforceRateLimit` が 429 を返す）・503・500（`executeSearch` が `SearchBackendError`）の全てが `private, no-store`。(e) 500 の本文が `{ error: 'Failed to search content' }` で、`console.error` の第 2 引数が `{ name, code }`（検索語・`message` を含まない）。(f) `sec-fetch-site: same-origin` と見出し無しは今までどおり通る。
  - `suggest-route.test.ts`（先頭 `DD-SEARCH-005`）: 同じ 3 点（403・`private, no-store` が 200/400/429/500 の全て・制御文字は共通の決まりで 400）。
  - `search-service-execute.test.ts`（先頭 `DD-SEARCH-006`）: 3 つの関数のうち **1 つだけ**失敗（`search_looks`）→ `executeSearch` が `SearchBackendError`（`fn: 'search_looks'`）で reject し、`console.error` が 1 回、`{ fn, name, code }` で、検索語を含まない。3 つとも失敗でも reject。全て成功なら今までどおり。`getPopularItems` の失敗は空のまま続き、記録が `{ name, code }`。既存の「3 つ失敗すると 3 種とも空にして誤りを書く」（241〜250 行付近）は新しい動きに書き直す。
  - `search-service-suggestions.test.ts`（先頭 `DD-SEARCH-007`）: `search_news` だけ失敗 → 他の 2 種の候補は返り、`console.error` が `{ fn: 'search_news', name, code }` で 1 回。投げない。
  - `search-page-client.test.tsx`（先頭 `DD-SEARCH-002`、fake timers）: 5 文字を 20 ミリ秒間隔で入力し、250 ミリ秒進める前は `/api/suggest` の `fetch` が 0 回、進めた後は最後の語（5 文字）で 1 回だけ。入力を空にすると待たずに候補が消え、`fetch` しない。入力のたびに前の `AbortController` が打ち切られ、遅れて返った前の応答で候補が上書きされない。タブを ALL から ITEM に替えても `/api/search` の `fetch` が増えない。語（`q`）を替えると 1 回増え、URL の `tab=` が最新のタブ。アンマウントで候補の要求が打ち切られ、状態の更新の警告が出ない。`console.error` の呼び出しに `Error` オブジェクトを渡さない（失敗時の第 2 引数が無い）。
- [ ] **Step 3（GREEN）: 実装する。** `query-schema.ts`・`cross-site.ts` → 2 つの route → `search.service.ts` → `SearchPageClient.tsx`。`tsc` を流す。`suggest/route.ts` の冒頭のコメント（「`,().` も断る」）を実際の決まりに合わせる。
- [ ] **Step 4: 結合・UI 試験を直す。** `search-public-api.test.ts:112`・`search-request-path.test.ts:99`・`search-route.test.ts:180-183` の `x-search-duration-ms` の期待を外し、`Cache-Control` の期待に替える。`search-image-signing.test.ts:217,225`（`Cache-Control` は `null`）を `private, no-store` に書き換える。`search-suggest-api.test.ts`・`search-suggestion-screen.test.tsx`・`search-suggestion-state.test.tsx`・`search-commit-flow.test.tsx` は候補の取得が 250 ミリ秒遅れるので fake timers か `waitFor` に直す。`search-rate-limit-proxy.test.ts:220` は変わらない見込み。結合のテスト名の先頭は構造設計の ID（`API-SEARCH-001`・`API-SEARCH-002`・`STATE-SEARCH-002` ほか）。
- [ ] **Step 5: 対象の `jest` を流す。** `npx jest tests/unit/features/search tests/unit/api/search tests/unit/app/search tests/integration/api/search-public-api.test.ts tests/integration/api/search-suggest-api.test.ts tests/integration/api/search-request-path.test.ts tests/integration/api/search-rate-limit-proxy.test.ts tests/integration/api/search-image-signing.test.ts tests/integration/api/search-popular-items.test.ts tests/integration/api/search-ranking-snippet.test.ts tests/integration/ui/search-suggestion-screen.test.tsx tests/integration/ui/search-suggestion-state.test.tsx tests/integration/ui/search-commit-flow.test.tsx tests/integration/ui/search-results-screen.test.tsx tests/integration/ui/search-results-state.test.tsx tests/integration/ui/search-entry-detail-flow.test.tsx tests/integration/ui/search-page-frame-screen.test.tsx`。（`search-home-preview*` は Task 3。）
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-SEARCH-019:74`（`SEC-SEARCH-004-AC-01`）、`:99`（`SEC-SEARCH-010-AC-01`）、`:160`（`SEC-SEARCH-019-AC-01`）、`FR-SEARCH-022:216`（`SEC-SEARCH-005-AC-02`。3 つの幅のループの中の 1 つの印）、`:386`（`SEC-SEARCH-017-AC-01`。3 つの幅）。
  - **分ける:** `FR-SEARCH-022:302`（`SEC-SEARCH-020-AC-01`）を 2 本にする。AC-01 は前半（偽の送り元で `/api/search?preview=true` を 21 回送った後の利用者 A のプレビュー）だけにして**印を残す**（文を「(a) は波 4 の `rateLimit.ts`」に）。後半（外のオリジンの頁から 21 回読み込ませた後の閲覧者のプレビュー）を新しい `SEC-SEARCH-020-AC-02 (${viewport.name}) …` に移し、**印は付けない**。AC-02 に追加の確かめ: 外のオリジンから送られた各 `/api/search` の応答の状態が 403（`page.on('response')` で `sec-fetch-site: cross-site` の物を集める）。3 つの幅のループは今のまま。
  - 外さない: `FR-SEARCH-019:142`（`SEC-SEARCH-014` 署名の期限）、`FR-SEARCH-020:297・320`（`SEC-SEARCH-007・008` DB）、`FR-SEARCH-021:238・273・383`（`003`・`016`・`015`）、`FR-SEARCH-022:282`（`SEC-SEARCH-006` 送り元）、`:302` の AC-01（上のとおり）。
- [ ] **Step 7: 文書。** `areas/search.md`: `SEC-SEARCH-004`・`005`・`010`・`017`・`019` の「今のコードは満たさない」を外し現行を書く。`SEC-SEARCH-018` は「応答は満たす。記録は名前と符号だけにした。AC-01 は E2E が無い（`missing-child` のまま）」と書く。`SEC-SEARCH-020` は本文を「外のサイト側は満たした（2026-10-26）。偽の送り元の側は満たさない（波 4）」に直し、`SEC-SEARCH-020-AC-01` を (a) だけに狭め、`SEC-SEARCH-020-AC-02` を新しく起こす（属性表つき）。`DRV-SEARCH-003` を「検索は 1 種でも失敗したら全体を失敗にする。候補だけ失敗した種別を空として扱い、符号を記録する」に書き直す。`threats/search.md`: `THR-SEARCH-004`・`005`・`010`・`017`・`019`・`020`。`areas/search.md`（構造設計）: `ARC-SEARCH-005`、`API-SEARCH-001`・`002`（403・400・500・見出し）、`STATE-SEARCH-001`（失敗の見せ方）、`STATE-SEARCH-002`。`19_search.md`: `DD-SEARCH-002`・`004`・`005`・`006`・`007` を直し、`DD-SEARCH-009`・`010` を新規。**`SEC-SEARCH-018` の本文が求めるとおり、`DD-SEARCH-004`・`005`・`006` の上位に `SEC-SEARCH-018` を足し、本文の「直した時に…上位にも足す」の一文を外す**（計画のレビューで足した）。`ADR-0311`・`0312`・`0313` を新規（`ADR-0311` は `DRV-SEARCH-003` を上位に持つ）。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- SEARCH`。
- [ ] **Step 9: 報告。** 変えたファイル、外した印の行番号と分けた 1 本、共有文書の変更案（`api-spec.md`: `/api/search`・`/api/suggest` の 403・400・500・`Cache-Control`、`x-search-duration-ms` の削除）。controller が E2E（`isolated-global` の `FR-SEARCH-022` は最後）で確かめる点: 候補の最後の応答が前の応答に上書きされないこと、**分けた `SEC-SEARCH-020-AC-01`（前半だけ）が今も赤であること**（印が正しいこと。前半が通ってしまうと「予想外の成功」になるので、その時は印を外して `SEC-SEARCH-006` と同じ波 4 の印に付け替える）。コミットは作らない。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- SEARCH`。

---

## Task 3: SEC-SEARCH-021 ホームのプレビューの説明の文に検索語を埋めない（画面が変わる。単独のタスク）

**範囲:** `src/features/search/components/SearchHomePreview.tsx` の 1 部品だけ。説明の文を固定にし、検索語を「検索した語」の枠に出す。同じ部品の `console.error` が `Error`（stack つき）を渡している SEC-HOME-015 を一緒に直す。**画面の写真を撮る E2E を書き、ユーザーに見せる。**

**Files:**

- Modify: `src/features/search/components/SearchHomePreview.tsx`（`IMPL-SEARCH-103`・`DD-SEARCH-003`）
- Test: `tests/unit/features/search/search-home-preview.test.tsx`（131 行付近の固定の文の期待）、`tests/integration/ui/search-home-preview-screen.test.tsx`（112・199 行付近）
- E2E: `e2e/FR-SEARCH-018-search-page-flows.spec.ts`（`:219` と新しい `SEC-SEARCH-021-AC-02`）、`e2e/FR-HOME-022-home-response-hardening.spec.ts`（`:208`）
- Docs: `docs/02_Requirements/areas/search.md`（`SEC-SEARCH-021`・`SCR-SEARCH-004` に関わる文）、`docs/02_Requirements/areas/home.md`（`SEC-HOME-015`）、`docs/05_Quality/security/threats/search.md`・`home.md`、`docs/03_BasicDesign/areas/search.md`（`SCR-SEARCH-004`）、`docs/03_BasicDesign/decisions/ADR-0314-search-home-preview-term-in-labeled-box.md`（新規）、`docs/04_DetailDesign/pages/19_search.md`（`DD-SEARCH-003`）

**Interfaces:**

```tsx
// 描画（案。文言と見た目はユーザーの確認まで案）
<p>入力した語に関連する結果をホーム上で即時プレビューしています。</p>   // 固定。検索語を含まない
<dl data-testid="search-preview-term" className="… inline-flex max-w-full items-baseline gap-3 border …">
  <dt>検索した語</dt>
  <dd className="min-w-0 break-words …">{query}</dd>                   // 語は dd の文字として出す。p の中に入れない
</dl>
// 区画は結果が返った時だけ出る今の動きのまま（語は 100 字以下。長いと窓口が 400 で区画ごと出ない）。
// console.error('Failed to fetch home search preview') — 第 2 引数に Error を渡さない（SEC-HOME-015）。
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "test.fail" e2e/FR-SEARCH-018-*.ts e2e/FR-HOME-022-*.ts`（`FR-SEARCH-018:219`、`FR-HOME-022:208`・`215`。215 は Task 8）。`SearchHomePreview` の他の `<p>` が語を持たないこと。`FR-HOME-022` の `openHomeWithFailedSearch` が集める console の内容。
- [ ] **Step 2（RED）: 単体試験を書く。** `search-home-preview.test.tsx`（先頭 `DD-SEARCH-003`）: (a) `q=coat 本日休業のお知らせ` で、固定の文が `<p>` として 1 つあり、どの `<p>` の `textContent` にも `本日休業` が含まれない。(b) `data-testid="search-preview-term"` の `dd` の文字が `coat 本日休業のお知らせ`、`dt` が `検索した語`。(c) 語に `<b>x</b>` を入れても要素にならず文字で出る。(d) 取り出しが失敗した時、区画が出ず、`console.error` が**引数 1 つ**（文字列）で呼ばれる（`mock.calls[0]).toHaveLength(1)`）。(e) 結果 0 件の時の「プレビュー対象の検索結果は見つかりませんでした。」は今までどおり。
- [ ] **Step 3（GREEN）: 実装する。** 部品を直す。`tsc` を流す。見た目は既存の枠の色・文字の大きさの変数（`--lk-size-*`）に合わせ、新しい色・影・アニメーションを足さない。
- [ ] **Step 4: 結合試験を直す。** `search-home-preview-screen.test.tsx` の固定の文の期待を新しい固定の文に直し、「検索した語」の枠を見る 1 本を足す（先頭 `SCR-SEARCH-004`）。
- [ ] **Step 5: 対象の `jest` を流す。** `npx jest tests/unit/features/search/search-home-preview.test.tsx tests/integration/ui/search-home-preview-screen.test.tsx tests/integration/api/home-page-public-read.test.ts tests/integration/ui/home-page-fetch-flow.test.tsx`。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-SEARCH-018:219`（`SEC-SEARCH-021-AC-01`。3 つの幅）、`FR-HOME-022:208`（`SEC-HOME-015-AC-01` の stack の確かめ。3 つの幅。同じファイルの `:94`・`:118`・`:149` は別の波なので外さない）。
  - 足す: `FR-SEARCH-018` に `SEC-SEARCH-021-AC-02 ${vp.name} /?q=<語> のプレビューの区画に固定の説明の文と「検索した語」の枠があり、語は枠の中にだけある`（3 つの幅のループ）。確かめ: 区画の `p` に固定の文が見える、`getByTestId('search-preview-term')` が見えて語を含む、**画面の写真**を `await previewSection.screenshot({ path: 'test-results/wave1c/search-021-preview-' + vp.width + '.png', animations: 'disabled' })` と、頁全体 `fullPage: true` の `search-021-page-<幅>.png` に保存する。語は他の試験が使う実在の語（例 `Tsubame`）で、結果のカードが出る状態にする。`FR-SEARCH-018` は `isolated-global` でない（通常の project）。
- [ ] **Step 7: 文書。** `areas/search.md`: `SEC-SEARCH-021` の「今のコードは満たさない」を外し、現行（固定の文・語は枠）を書く。`SEC-SEARCH-021-AC-02` を新しく起こす（確かめ方: E2E と写真）。状態は「推定」、案である旨を未確認事項に書く。`areas/home.md`: `SEC-HOME-015` の「今のコードは満たさない」を外す（ブラウザ側。サーバー側の記録は他の領域の `safe-error` への差し替えで、触っていない分は満たさないまま残す）。`threats/search.md`: `THR-SEARCH-021`。`threats/home.md`: `THR-HOME-015` の画面の分。`areas/search.md`（構造設計）: `SCR-SEARCH-004`。`19_search.md`: `DD-SEARCH-003`。`ADR-0314` を新規（状態は「案」、確認日付き）。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- SEARCH`、`npm run validate-trace -- HOME`。
- [ ] **Step 9: 報告。** 変えたファイル、外した印、**写真の回収の手順**（controller が `npx playwright test e2e/FR-SEARCH-018 --grep SEC-SEARCH-021-AC-02` を流した直後に `test-results/wave1c/search-021-*.png` の 6 枚を回収してユーザーに渡す。Playwright は次の実行の始めに `test-results` を空にするので、続けて他を流さない）。サーバーが無く写真は撮っていないことを明記する。コミットは作らない。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- SEARCH`、`npm run validate-trace -- HOME`。

---

## Task 4: LOOK 公開の一覧・詳細（SEC-LOOK-009・016 の公開側・022 の公開側）

**範囲:** 一覧の取り出しから説明文を外して 100 件に切る（Q11）。取り出しの失敗を throw にして誤りの画面に出す。詳細の頁を一覧の写しに頼らない形にする。詳細の id を入口で確かめる。

**Files:**

- Create: `src/app/look/error.tsx`（`IMPL-LOOK-150`・`DD-LOOK-069`）、`tests/unit/app/look/look-error.test.tsx`
- Modify: `src/lib/look/server.ts`（`IMPL-LOOK-103`・`104`・`105`、新しい `getPublishedLookList`＝`IMPL-LOOK-148`、`LookFetchError`＝`IMPL-LOOK-149`、`getAdjacentPublishedLooks`＝`IMPL-LOOK-156`）、`src/lib/look/public.ts`（`parseLookId`＝`IMPL-LOOK-147`・`DD-LOOK-068`、型 `PublicLookListItem`）、`src/app/look/page.tsx`（`IMPL-LOOK-102`）、`src/app/look/[id]/page.tsx`（`IMPL-LOOK-124`）、`src/features/look/components/PublicLookGrid.tsx`（型だけ。`IMPL-LOOK-101`）
- Test: `tests/unit/lib/look-server.test.ts`・`look-public.test.ts`、`tests/unit/app/look/look-list-page.test.tsx`・`look-detail-page.test.tsx`、`tests/unit/features/look/components/public-look-grid.test.tsx`、`tests/features/look/PublicLookGrid.test.tsx`、`tests/integration/ui/look-list-screen.test.tsx`・`look-detail-screen.test.tsx`・`look-list-detail-flow.test.tsx`・`look-public-read-path.test.tsx`・`look-home-section.test.tsx`・`look-season-state.test.tsx`・`look-card.test.tsx`、`tests/integration/api/home-page-public-read.test.ts`（LOOK の節だけ）、`tests/integration/api/look-image-signing.test.ts`（公開の取り出しの節だけ。Task 5 が管理の節を触る）
- E2E: `e2e/FR-LOOK-SEC-001-public-visibility.spec.ts`、`e2e/FR-LOOK-SEC-005-global-faults.spec.ts`（`:100` と新しい `SEC-LOOK-009-AC-02`）
- Docs: `docs/02_Requirements/areas/look.md`、`docs/05_Quality/security/threats/look.md`、`docs/03_BasicDesign/areas/look.md`、`docs/03_BasicDesign/decisions/ADR-0159-look-list-limit-100-no-description.md`（新規。`ADR-0152`・`ADR-0153` に 1 行ずつ追記）、`docs/04_DetailDesign/pages/06_look_list.md`・`07_look_detail.md`

**Interfaces:**

```ts
// src/lib/look/public.ts
export type PublicLookListItem = Omit<PublicLook, 'themeDescription'>;
/** /^[1-9]\d{0,15}$/ に合い、Number.isSafeInteger の時だけ数にする。'0'・'01'・'1.5'・'1e3'・'-1'・' 1'・空・17 桁以上は null。 */
export function parseLookId(value: string): number | null;
// src/lib/look/server.ts
export const PUBLIC_LOOK_LIST_LIMIT = 100;
export class LookFetchError extends Error { readonly code: string | null }
/** /look 用。select は 'id,season_year,season_type,theme,image_urls,created_at'（説明文なし）+ .order('created_at', desc).order('id', desc) + .limit(100)。looks・look_items・items のどれかが error なら { name, code } を記録して LookFetchError。 */
export async function getPublishedLookList(): Promise<PublicLookListItem[]>;
/** ホーム用（詳細の頁はもう使わない）。並びと select は上と同じ。失敗は空の配列（今の動き）。limit は 1〜100 に丸める（未指定・不正・0・負・NaN は 100）。 */
export async function getPublishedLooks(limit?: number): Promise<PublicLookListItem[]>;
/** 無い・非公開は null。looks / look_items / items の DB の失敗は LookFetchError。説明文あり（PublicLook）。 */
export async function getPublishedLookById(id: number): Promise<PublicLook | null>;
/** 詳細の前後用。匿名の client で公開済みだけから、一覧と同じ並び（created_at の新しい順・同じ時刻は id の大きい順）で前後の 1 件ずつを id・theme だけ取る。
 *  prev（1 つ新しい）: .or(`created_at.gt."${createdAt}",and(created_at.eq."${createdAt}",id.gt.${id})`).order('created_at', asc).order('id', asc).limit(1).maybeSingle()
 *  next（1 つ古い）  : .or(`created_at.lt."${createdAt}",and(created_at.eq."${createdAt}",id.lt.${id})`).order('created_at', desc).order('id', desc).limit(1).maybeSingle()
 *  時刻は PostgREST の予約文字（. :）を含むので値を二重引用符で囲む。値は DB から読んだ created_at と数の id だけで、外から来た文字を入れない。
 *  片方の error は { name, code } を記録してその側を null にする（投げない。前後は添え物で、記事本体を隠さない）。 */
export async function getAdjacentPublishedLooks(look: { id: number; createdAt: string }): Promise<{ prev: { id: number; theme: string } | null; next: { id: number; theme: string } | null }>;
// error.tsx: 'use client'。見出し「LOOK を読み込めませんでした」、「一時的なエラーのため表示できません。しばらくしてからもう一度お試しください。」、retry を呼ぶボタン、一覧へ戻らず /look に留まる。error.message・stack を出さず、console.error には { digest } だけ。
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "test.fail" e2e/FR-LOOK-SEC-001-*.ts e2e/FR-LOOK-SEC-005-*.ts`（SEC-001: 328・357・389・425、SEC-005: 50・100・134）。`grep -rn "getPublishedLooks\|getPublishedLookById\|themeDescription\|PublicLook\b" src tests --include=*.ts --include=*.tsx` で、型の変更が及ぶ所（ホーム `src/app/page.tsx`・グリッド・詳細・管理の `edit/[id]/page.tsx` は別の型）を数える。詳細の頁が `looks[currentIndex]` から説明文・関連商品・画像を取っていること。
- [ ] **Step 2（RED）: 単体試験を書く。**
  - `look-public.test.ts`（先頭 `DD-LOOK-068`）: `'1'`→1、`'1234567890123456'`（16 桁）→その数。null: `'0'`・`'01'`・`'1.5'`・`'1e3'`・`'-1'`・`' 1'`・`'1 '`・`''`・`'abc'`・`'12345678901234567'`（17 桁）。
  - `look-server.test.ts`（先頭 `DD-LOOK-003`・`DD-LOOK-032`）: `getPublishedLookList` の `looks` の `select` が正確に `'id,season_year,season_type,theme,image_urls,created_at'`、`.limit` が 100、結果の各要素に `themeDescription` のキーが無い。`looks` が error（`{ code: '42501', message: 'permission denied …' }`）→ `LookFetchError`（`code` は `'42501'`）で reject、`console.error` の第 2 引数が `{ name, code }` で `message` を含まない。`look_items` が error でも、`items` が error でも reject（部分的に空で返さない）。`getPublishedLooks()` は同じ失敗で `[]`。`getPublishedLooks(8)`→`.limit(8)`、`(1000)`→100、`(0)`・`(-1)`・`(NaN)`・未指定→100。`getPublishedLookById`: `maybeSingle` が `{ data: null, error: null }`→`null`、`error`→`LookFetchError`、`look_items` の error→`LookFetchError`、成功では `themeDescription` を含む。`getPublishedLookList`・`getPublishedLooks` の `order` が `created_at` の降順の次に `id` の降順。`getAdjacentPublishedLooks({ id: 5, createdAt: '2026-06-05T12:00:00+00:00' })`（先頭 `DD-LOOK-032`）: 2 本の `.or()` の文字が上の Interfaces の形ちょうど（時刻が `"` で囲まれる）、`eq('status', 'published')` を持つ、`select` が `'id,theme'`、`order` と `limit(1)` が上のとおり。前だけ error → `{ prev: null, next: <行> }` で reject しない、記録が `{ name, code }` で 1 回。両方 null の行 → `{ prev: null, next: null }`。
  - `look-error.test.tsx`（先頭 `DD-LOOK-069`）: 見出しと「エラー」を含む文が出る。`error.message = 'SECRET_DB_DETAIL'` の時 DOM にその文字が無い。ボタンを押すと `retry` が 1 回。`console.error` の呼び出しに `message`・`stack` が無く `{ digest }` だけ。
  - `look-list-page.test.tsx`（先頭 `DD-LOOK-002`）: `getPublishedLookList` の結果をグリッドに渡す。`getPublishedLookList` が `LookFetchError` で reject → ページの関数も reject（誤りの画面に任せる）。`season=aw` は `AW` に直る（今のまま）。
  - `look-detail-page.test.tsx`（先頭 `DD-LOOK-030`）: (a) 現在の LOOK を `getPublishedLookById` から取り、説明文が出る。`getPublishedLooks` を呼ばない。(b) `getAdjacentPublishedLooks` が前後の両方を返せば PREV・NEXT のリンクが `/look/<id>` で出る（`aria-label` に題）。(c) 前だけ・後だけ null → その側が無効の表示。(d) `getAdjacentPublishedLooks` が `{ prev: null, next: null }` でもページは開く。(e) `abc`・`1e3`・`0`・`-1`・`1.5` は `getPublishedLookById` も `getAdjacentPublishedLooks` も呼ばず「Look not found」。行が無い（null）時も「Look not found」で前後を呼ばない。(f) `getPublishedLookById` が reject →ページも reject。(g) `generateMetadata` は `parseLookId` を通し、reject の時に固定の題と説明を返す（投げない）。
  - グリッド・ホームの試験は `themeDescription` の見本を `PublicLookListItem` に合わせて外す。
- [ ] **Step 3（GREEN）: 実装する。** `public.ts`（型・`parseLookId`）→ `server.ts`（`fetchPublishedLooks` を内側に持ち、`getPublishedLookList` は投げる・`getPublishedLooks` は握る）→ 一覧の頁 → 詳細の頁 → `error.tsx` → グリッドの型。`tsc` を流す。`server.ts` の `console.error` の全てを `describeErrorForLog` に替える。`hydrateLooks` の「`look_items` の失敗で署名していない `image_urls` をそのまま載せて返す」道は、投げる側では無くなる（SEC-LOOK-008 の署名の共有の直しは波 3）。ファイルの先頭の `@remarks` の「件数の上限を付けずに全部取る」を直す。詳細の頁の `@remarks`（「公開の LOOK の全部を取ってその中の位置で選ぶ」）を「前後の 1 件ずつを同じ並びで取る」に直す。`getPublishedLookById` の `@remarks`（「関連の取り出しの失敗は…関連なしで返す」）も投げる側に直す。
- [ ] **Step 4: 結合・UI 試験を直す。** `look-detail-screen`・`look-list-detail-flow` は詳細の頁のモックを `getPublishedLookById` と `getAdjacentPublishedLooks` に替える（`getPublishedLooks` で前後を作っていた所）。`look-list-screen`・`look-list-detail-flow`・`look-public-read-path`・`look-home-section`・`look-season-state`・`look-card` は説明文の見本と `getPublishedLooks` のモックの形を直す。`home-page-public-read.test.ts` の LOOK の節: `select` の文字列と `.limit(8)`、`createPublicClient` の使用。`look-image-signing.test.ts` の公開の取り出しの節: 失敗時の動き。結合のテスト名の先頭は `SCR-LOOK-001`・`SCR-LOOK-004`・`FLOW-LOOK-001`・`ARC-LOOK-001`・`ARC-HOME-002`。
- [ ] **Step 5: 対象の `jest` を流す。** `npx jest tests/unit/lib/look-server.test.ts tests/unit/lib/look-public.test.ts tests/unit/app/look tests/unit/features/look tests/features/look tests/integration/ui/look-list-screen.test.tsx tests/integration/ui/look-detail-screen.test.tsx tests/integration/ui/look-list-detail-flow.test.tsx tests/integration/ui/look-public-read-path.test.tsx tests/integration/ui/look-home-section.test.tsx tests/integration/ui/look-season-state.test.tsx tests/integration/ui/look-card.test.tsx tests/integration/api/home-page-public-read.test.ts tests/integration/api/look-image-signing.test.ts tests/unit/home`。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-LOOK-SEC-001:425`（`SEC-LOOK-009-AC-01`。3 つの幅）。**期待を書き換える**: 価格の文字・`"price":` の確かめのループを消し、説明文が `/look` の応答（HTML と受け渡し）に含まれない確かめだけにする（題を「…見本の LOOK の説明文の文字が含まれない」に）。`FR-LOOK-SEC-005:100`（`SEC-LOOK-022-AC-01`。3 つの幅。`anon` の `looks` の `select` を外した状態で `/look` が誤りの画面になる）。
  - 足す: `FR-LOOK-SEC-005`（`isolated-global`）に `SEC-LOOK-009-AC-02 ${vp.name} 上限より多い公開の LOOK があっても /look のカードは 100 以下で、最も古い LOOK は並ばず、その詳細は開く`。公開の LOOK を 101 件、`created_at` を 2000 年の連続した分にして `withLocalDb` で入れる（入れるのは 1 回。`generate_series` の 1 本の `insert`。テーマに共通の接頭辞を付け、`theme_description` は接頭辞つきの見分けやすい文、`image_urls` は見本の LOOK 1 と同じ置き場にある道筋（`e2e/look-1-1.png`）にして、署名に失敗する道筋を 100 件入れない。関連商品は付けない。後始末で接頭辞ごと消す）。3 つの幅で `/look` を読み、`data-testid="look-card"` の一意な `href` の数が 100 以下、新しい側（接頭辞 `-101`）が並び、最も古い（`-1`）が並ばず、最も古い LOOK の `/look/<id>` が開いて説明文が見え、PREV LOOK のリンク（1 つ新しい `-2`）があり NEXT LOOK が無効（desktop は `look-detail-bottom-nav`、mobile は `look-detail-fixed-nav` の中で見る）。
  - 外さない: `FR-LOOK-SEC-001:328`（`SEC-LOOK-006-AC-02` 署名の期限は波 3）・`:357`・`:389`（`007`・`008` 署名の共有は波 3）、`FR-LOOK-SEC-005:50`・`:134`（Task 5）。
- [ ] **Step 7: 文書。** `areas/look.md`: `SEC-LOOK-009` の本文を「一覧は 100 件まで取り、説明文を返さない。関連商品の価格・名前・画像は今のカードが出すので返す（Q11。2026-10-26）。詳細は対象の LOOK を 1 件で取り、前後の移動は前後の 1 件ずつだけを取る（今の本文のまま）」に直し、`AC-01` の文から価格を外し、`AC-02` に上限 100 を書く。`SEC-LOOK-016` は公開の頁の id の分を満たした旨を書く（管理の分は Task 5）。`SEC-LOOK-022` は `AC-01` を満たした旨（`AC-02` は Task 5）。`threats/look.md`: `THR-LOOK-009`・`016`・`022`。`areas/look.md`（構造設計）: `ARC-LOOK-001`、`SCR-LOOK-001`・`004`、`FLOW-LOOK-001`。`06_look_list.md`: `DD-LOOK-002`・`003`、`DD-LOOK-069`（新規）。`07_look_detail.md`: `DD-LOOK-030`（前後の 1 件ずつの取り出し）・`032`（`getPublishedLookById` が投げる・`getAdjacentPublishedLooks` の並びと失敗）、`DD-LOOK-068`（新規）。`ADR-0159` を新規（前後を一覧の位置でなく 1 件ずつ取る理由も書く）。`ADR-0152`・`ADR-0153` に「`ADR-0159` で上限 100 を足した」と 1 行足す（本文は消さない）。`ADR-0156`（詳細は 200 のまま）は変えない。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- LOOK`。
- [ ] **Step 9: 報告。** 変えたファイル、外した印、足した E2E、共有文書の変更案（なし。`api-spec.md` に公開の頁の記述は無い）。controller が確かめる点: `/look` の誤りの画面の HTTP 状態（P7）、前後のリンクの E2E（`FR-LOOK-DETAIL-003`・`013`・`017`・`019`・`020`）が緑のままか（`.or()` の時刻の引用が本物の PostgREST で通るか。単体はモックなので文字しか見られない）。コミットは作らない。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- LOOK`。

---

## Task 5: LOOK 管理の窓口（SEC-LOOK-013・014・016・019 の局所版・021・022 の管理側）

**範囲:** 管理の LOOK の 2 つの route と `LookSection`。画像は中身で種類を確かめ、保存名を自分で作り、後始末をする。id・JSON を入口で確かめる。1 件の取得は「無い」と「DB の失敗」を分ける。誤りの文言を応答と記録に出さない。カードの操作ボタンを `canManage` で出し分ける。**更新の DB の関数化（SEC-LOOK-015）は波 2。**

**Files:**

- Create: `src/features/look/services/admin-images.ts`（`IMPL-LOOK-151`〜`155`・`DD-LOOK-070`）、`tests/unit/features/look/services/admin-images.test.ts`
- Modify: `src/app/api/admin/looks/route.ts`（`IMPL-LOOK-141`・`DD-LOOK-063`）、`src/app/api/admin/looks/[id]/route.ts`（`IMPL-LOOK-142`・`DD-LOOK-064`）、`src/components/LookSection.tsx`（`IMPL-LOOK-126`・`DD-LOOK-060`）
- Test: `tests/unit/api/admin/looks/looks-post-route.test.ts`・`looks-get-route.test.ts`・`looks-id-get-route.test.ts`・`looks-id-put-route.test.ts`・`looks-id-patch-route.test.ts`・`looks-id-delete-route.test.ts`、`tests/unit/api/admin/looks-audit.test.ts`（確認）、`tests/unit/components/look-section.test.tsx`、`tests/integration/api/look-admin-create-api.test.ts`・`look-admin-item-get-api.test.ts`・`look-admin-item-put-api.test.ts`・`look-admin-item-patch-api.test.ts`・`look-admin-item-delete-api.test.ts`・`look-admin-list-api.test.ts`・`look-admin-write-path.test.ts`・`look-image-signing.test.ts`（管理の節。公開の節は Task 4）、`tests/integration/ui/look-admin-list-screen.test.tsx`・`look-admin-flow.test.tsx`（`meta.canManage` のモック）、`tests/integration/ui/look-admin-create-screen.test.tsx`・`look-admin-edit-screen.test.tsx`（読むだけ・流すだけ）
- E2E: `e2e/FR-LOOK-SEC-004-admin-write-integrity.spec.ts`、`e2e/FR-LOOK-SEC-003-admin-api-authz.spec.ts`、`e2e/FR-LOOK-SEC-005-global-faults.spec.ts`（`:50`・`:134`）
- Docs: `docs/02_Requirements/areas/look.md`、`docs/05_Quality/security/threats/look.md`、`docs/03_BasicDesign/areas/look.md`、`docs/03_BasicDesign/decisions/ADR-0160-look-admin-image-cleanup-after-row-change.md`・`ADR-0161-look-admin-card-buttons-by-can-manage.md`（新規）、`docs/04_DetailDesign/pages/16-3_admin_look.md`

**Interfaces:**

```ts
// src/features/look/services/admin-images.ts
export const LOOK_IMAGE_BUCKET = 'look-images';
export type PreparedLookImage = { buffer: Buffer; contentType: DetectedImageType; extension: string };
/** File を読み、申告の type と先頭の印が同じ時だけ返す。違えば null（呼び手が 400 'Unsupported image type'）。 */
export async function prepareLookImage(image: File): Promise<PreparedLookImage | null>;
/** looks/YYYY-MM-DD/<uuid>.<extension>（日付は UTC の ISO。now は試験用） */
export function buildLookImagePath(extension: string, now?: Date): string;
/** /^looks\/[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/ に合う時だけ true（'..'・先頭の '/'・'//'・別の接頭辞・URL は false） */
export function isOwnLookImagePath(path: string): boolean;
/** image_urls の各値を extractLookImageObjectPath で道筋にし、isOwnLookImagePath を通る物だけ、重複なし、keep に含まれる物を除いて返す。 */
export function listRemovableLookImagePaths(rawUrls: unknown, keep?: readonly string[]): string[];
/** storage.from(LOOK_IMAGE_BUCKET).remove(paths)。空なら呼ばず 'ok'。error・例外は { name, code } だけ記録して 'failed'。投げない。 */
export async function removeLookImages(supabase: SupabaseClient, paths: readonly string[]): Promise<'ok' | 'failed'>;
// GET /api/admin/looks の応答: { data, meta: { canManage: boolean } }
//   canManage = (await authorizeAdminPermission('admin.looks.manage', request)).ok。403 だけ false。401・503 などはその応答をそのまま返す（G-3 の packing と同じ）。
// LookSection: json.meta?.canManage === true の時だけカードの 3 ボタンを出す（読み込みの間・失敗・meta なしは出さない）。
// [id] の全ハンドラー: 認可 → （変更系は回数制限）→ parseLookId(id) が null なら監査 failure 'Invalid look id'（id の生の値は残さず長さだけ）+ 400 { error: 'Invalid look id' }。
// PATCH: await request.json().catch(() => null) が null → 監査 failure 'Invalid JSON' + 400 { error: 'Invalid request' }（500 にならない）。
// 1 件の存在確認は .single() でなく .maybeSingle()。error → 500 + { name, code } を記録、null → 404。
//   GET の select('*')、PUT の select('id,status,image_urls')、DELETE の select は 'id,status' → 'id,status,image_urls' に広げる（消す画像の道筋を行を消す前に読む。今の DELETE は image_urls を読んでいない）。
// 置き場の削除は、上げるのと同じ service role の client（今の route の supabase = createServiceRoleClient()）で行う。利用者の session の client で消すと置き場の方針（storage.objects の RLS）次第で断られ、移行が要るようになる。
// アップロードの失敗の応答は { error: 'Failed to upload image' } ちょうど。全ての console.error は describeErrorForLog。
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "test.fail" e2e/FR-LOOK-SEC-003-*.ts e2e/FR-LOOK-SEC-004-*.ts e2e/FR-LOOK-SEC-005-*.ts`（003: 235・301・319、004: 299・330・344・360・375・433・454、005: 50・100・134）。`grep -rn "new File(\[" tests | grep -i look` で偽の画像を使う試験を数える（`look-admin-create-api`・`look-admin-item-put-api`・`look-admin-write-path`・`look-image-signing`・`looks-post-route`・`looks-id-put-route`・`looks-audit`）。`LookSection` を使う画面の試験が `/api/admin/looks` の応答に `meta` を含むか。
- [ ] **Step 2（RED）: 単体試験を書く。**
  - `admin-images.test.ts`（先頭 `DD-LOOK-070`）: `prepareLookImage` — 本物の PNG を `type: 'image/png'` で渡すと `{ contentType: 'image/png', extension: 'png' }`、`name: 'a/b.html'` でも拡張子は `png`。文字のファイルを `image/png` と申告すると `null`。PNG を `image/jpeg` と申告すると `null`。`buildLookImagePath('png', new Date('2026-10-26T00:00:00Z'))` が `/^looks\/2026-10-26\/[0-9a-f-]{36}\.png$/`。`isOwnLookImagePath`: 真は `looks/2026-10-26/<uuid>.png`・`looks/e2e/a.png`、偽は `looks/../x.png`・`/looks/a.png`・`looks//a.png`・`news/a.png`・`other/looks/a.png`・`https://evil.example/looks/a.png`・`e2e/look-1-1.png`・`looks/a b.png`・`looks/%2e%2e/a.png`・空文字。`listRemovableLookImagePaths(['looks/a.png','looks/a.png','e2e/look-1-1.png','https://x.example/y.png',null,5], ['looks/b.png'])` → `['looks/a.png']`、`keep` に含まれる物は除く、古い公開 URL の形（自分の置き場の `/storage/v1/object/public/look-images/looks/z.png`）は `looks/z.png` に直って返る。`removeLookImages`: 空配列は `remove` を呼ばず `'ok'`、`remove` が `{ error }` を返す・例外を投げるとどちらも `'failed'` で投げず、`console.error` が `{ name, code }`。
  - `looks-post-route.test.ts`（先頭 `DD-LOOK-063`）: (a) 文字のファイルを `image/png` と申告 → 400 `{ error: 'Unsupported image type' }`、`upload` が呼ばれず、`consumeAdminLookUploadQuota` も呼ばれず、監査 failure（`detail` に中身・ファイル名なし）。(b) 名前 `a/b.html` の本物の PNG → `upload` の道筋が `/^looks\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.png$/`、`contentType: 'image/png'`、`looks.insert` の `image_urls` が同じ道筋。(c) 2 枚のうち 2 枚目の `upload` が `{ message: 'bucket details SECRET' }` で失敗 → 500 `{ error: 'Failed to upload image' }` ちょうど（`SECRET` を含まない）、1 枚目の道筋だけで `remove` が 1 回、`console.error` の第 2 引数が `{ name, code }`。(d) `looks.insert` の失敗 → 上げた全部の道筋で `remove`。(e) `look_items` の失敗 → `looks.delete` と `remove`。(f) `remove` 自体が失敗しても応答の状態は変わらず、監査の `metadata` に `orphaned_count`。
  - `looks-get-route.test.ts`（先頭 `DD-LOOK-063`）: 2 回目の認可が ok → `meta.canManage === true`、403 → `false`、401 → その 401 を返す、503 → その 503 を返す。`data` は今までどおり。
  - `looks-id-get-route.test.ts`・`-patch-`・`-delete-`・`-put-route.test.ts`（先頭 `DD-LOOK-064`）: `abc`・`1e3`・`0`・`-1`・`1.5` は、認可が通った後で 400 `{ error: 'Invalid look id' }`、DB を呼ばない。認可が通らなければ今までの 401・403（id の検査より先）。GET: `maybeSingle` が null → 404、error → 500（`{ name, code }` を記録）。PATCH: 本文が JSON でない（`request.json()` が reject）→ 400、`update` が呼ばれず、監査 failure `Invalid JSON`。PUT: 文字のファイルを `image/png` で → 400。新しい画像つきの成功 → `remove` が**古い**道筋（新しい配列に無い、自分の接頭辞の下の物）だけで 1 回。更新（`looks.update`）の失敗 → `remove` は**新しく上げた**道筋だけ。更新は成功し関連の保存（`look_items`）が失敗 → `remove` は古い道筋（新しい画像は消さない）で、500。画像なしの PUT → `remove` を呼ばない。DELETE: 存在確認の `select` が `image_urls` を含む。成功 → `remove` が `image_urls` のうち自分の道筋だけ（`e2e/look-1-1.png`・外の URL・`looks/../x` を渡さない）。行の削除が error → `remove` を呼ばない。`remove` が失敗しても 200 で、監査 `metadata.image_cleanup === 'failed'`。
  - `look-section.test.tsx`（先頭 `DD-LOOK-060`）: `meta: { canManage: true }` → 「公開」または「非公開」・「編集」・「削除」のボタンが各カードにある。`canManage: false`・`meta` なし・`meta: {}`・`canManage: 'true'`（文字）→ 3 つとも無く、LOOK のテーマ・シーズン・画像は見える。取得の失敗・0 件の表示は今までどおり。
- [ ] **Step 3（GREEN）: 実装する。** `admin-images.ts` → POST と GET の `route.ts` → `[id]/route.ts` → `LookSection.tsx`。`tsc` を流す。中身の確かめは**サイズの確かめの直後・量の枠（`consumeAdminLookUploadQuota`）の前**。画像の読み込みは一度だけ（`prepareLookImage` の `buffer` を `upload` に渡す）。既存の `allowedImageTypes` と `maxImageBytes` の確かめは残す。`image.name` から拡張子を作る 2 か所を `buildLookImagePath(prepared.extension)` に替える。
- [ ] **Step 4: 結合・UI 試験を直す。** 偽の画像の見本を `tests/fixtures/images.ts` の `fileOf(minimalPng(), …)` に替える（数えた 7 ファイル）。`look-admin-*-api` と `look-admin-write-path` のモックの連鎖に `storage.from().remove` と `maybeSingle` を足す。`look-admin-list-screen`・`look-admin-flow` のモックに `meta: { canManage: true }` を足し、`canManage: false` の 1 本を足す（先頭 `SCR-LOOK-006`）。結合のテスト名の先頭は `API-LOOK-001`〜`006`。
- [ ] **Step 5: 対象の `jest` を流す。** `npx jest tests/unit/features/look/services tests/unit/api/admin/looks tests/unit/api/admin/looks-audit.test.ts tests/unit/components/look-section.test.tsx tests/integration/api/look-admin-create-api.test.ts tests/integration/api/look-admin-item-get-api.test.ts tests/integration/api/look-admin-item-put-api.test.ts tests/integration/api/look-admin-item-patch-api.test.ts tests/integration/api/look-admin-item-delete-api.test.ts tests/integration/api/look-admin-list-api.test.ts tests/integration/api/look-admin-write-path.test.ts tests/integration/api/look-image-signing.test.ts tests/integration/ui/look-admin-list-screen.test.tsx tests/integration/ui/look-admin-flow.test.tsx tests/integration/ui/look-admin-create-screen.test.tsx tests/integration/ui/look-admin-edit-screen.test.tsx tests/unit/app/admin/look`。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-LOOK-SEC-004:330`（`SEC-LOOK-013-AC-01`）・`:344`（`013-AC-02`）・`:360`（`SEC-LOOK-014-AC-01`）・`:375`（`014-AC-02`）、`FR-LOOK-SEC-003:301`（`SEC-LOOK-016-AC-02`）・`:319`（`016-AC-03`）、`FR-LOOK-SEC-005:50`（`SEC-LOOK-021-AC-01`）・`:134`（`SEC-LOOK-022-AC-02`）。
  - 足す: `FR-LOOK-SEC-003` に `SEC-LOOK-019-AC-05 ${vp.name} admin.looks.read だけを持つ役の aal2 の session で LOOK のタブを開くと、一覧は表示され、カードの公開の切り替え・編集・削除のボタンが表示されない`（AC-04 の本体から「新規作成」の確かめを除いた形で、名前の確かめ `編集`・`公開`・`非公開`・`削除` の button・link が 0 件。3 つの幅。印は付けない）。**数える範囲は LOOK の一覧の区画の中だけ**にする: `const lookSection = page.locator('section').filter({ has: page.getByText(look.theme, { exact: true }) }).last();` を作り、`lookSection.getByRole(role, { name, exact: true })` を数える（AC-04 は印つきで赤のまま流れるので、頁全体に同じ名前のボタンが無いことの確かめに使えない。頁全体で数えると、ヘッダーなど別の部品の同名のボタンで理由の違う赤になる）。0 件の見かけの成功を避けるため、先に `look.theme` と `Aoi Weekend Layers` が `lookSection` の中に見えること、カードの状態の印（「公開中」か「非公開」の `TagLabel`。ボタンでない）が見えることを確かめる。
  - **外さない:** `FR-LOOK-SEC-003:235`（`SEC-LOOK-019-AC-04`）は、「新規作成」が `src/app/admin/page.tsx` のヘッダー（役で出す。波 4）に残るので**赤のまま印を残す**。印の文を「…カードの 3 ボタンは AC-05。新規作成のボタンは `src/app/admin/page.tsx`（波 4）」に直す。`FR-LOOK-SEC-004:299`（`012-AC-03` 量の鍵。割当無し）・`:433`（`020` IP は波 4）・`:454`（`015` 更新の関数化は波 2）、`FR-LOOK-SEC-003` の他は無し。
  - 期待の確認: `FR-LOOK-SEC-004` の `013-AC-02`（`/` が 2 つで `.html` を含まない）と `014-AC-02`（古い道筋が置き場に無い）が実装の道筋の形に合うこと、`FR-LOOK-ADMIN-001`（本物の一覧を使うのでボタンが出る）が影響されないこと。
- [ ] **Step 7: 文書。** `areas/look.md`: `SEC-LOOK-013`・`014`・`016`（管理の分）・`021`・`022`（`AC-02`）の「今のコードは満たさない」を外し現行を書く。`SEC-LOOK-019` は本文を「窓口とカードの 3 ボタンは満たした。新規作成のボタンは役で出していて満たさない（波 4）」に直し、`AC-04` の文に「新規作成」を残し、`AC-05` を新しく起こす。`SEC-LOOK-014` に「古い見本の道筋は消さない」「置き場の削除の失敗は記録だけ」。`threats/look.md`: `THR-LOOK-013`・`014`・`016`・`019`・`021`・`022`。`areas/look.md`（構造設計）: `ARC-LOOK-003`（後始末）、`SCR-LOOK-006`（ボタンの出し分け）、`API-LOOK-001`〜`006`（`meta.canManage`・400・500・応答の文言）。`16-3_admin_look.md`: `DD-LOOK-060`・`063`・`064` を直し、`DD-LOOK-070`（新規）。`ADR-0160`・`ADR-0161` を新規（`ADR-0161` は「暫定。波 4 で `admin-rbac.ts` が権限の集合を返したら 1 回の認可にする」）。`ADR-0158`（IP を残さない）は触らない（波 4）。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- LOOK`。
- [ ] **Step 9: 報告。** 変えたファイル、外した印と足した E2E、共有文書の変更案（`api-spec.md`: `GET /api/admin/looks` に `meta.canManage`、`POST`・`PUT` の 400 `Unsupported image type`・500 `Failed to upload image`、`[id]` の 400 `Invalid look id`・500、PATCH の壊れた JSON 400、DELETE・PUT の画像の削除）。controller が確かめる点: 本番ビルドで読み出しだけの人の `[RBAC] Permission denied` の警告が一覧の度に 1 行増える件、`FR-LOOK-ADMIN-001` が緑のままか。コミットは作らない。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- LOOK`。

---

## Task 6: NEWS 公開の取り出しと窓口（SEC-NEWS-006・012・020 の公開側）

**範囲:** `/api/news` に no-store と分類の許可の一覧を付け、公開の取り出しの `error` を読んで失敗を失敗にし、`/news` に誤りの画面を足し、ホームは落とさない。詳細の id を入口で確かめる。

**Files:**

- Create: `src/features/news/lib/news-input.ts`（`IMPL-NEWS-168`・`169`・`DD-NEWS-070`）、`src/app/news/error.tsx`（`IMPL-NEWS-167`・`DD-NEWS-069`）、`tests/unit/features/news/news-input.test.ts`、`tests/unit/app/news/news-error.test.tsx`
- Modify: `src/app/api/news/route.ts`（`IMPL-NEWS-103`・`DD-NEWS-004`）、`src/features/news/services/public.ts`（`IMPL-NEWS-121`〜`124`、`NewsFetchError`＝`IMPL-NEWS-174`・`DD-NEWS-003`）、`src/app/news/page.tsx`（`IMPL-NEWS-102`）、`src/app/news/[id]/page.tsx`（`IMPL-NEWS-125`）、`src/app/page.tsx`（`IMPL-HOME-101`・`DD-HOME-001`。ニュースの `.catch` だけ）
- Test: `tests/unit/api/news/news-route.test.ts`、`tests/unit/features/news/news-public-service.test.ts`、`tests/unit/app/news/news-list-page.test.tsx`・`news-detail-page.test.tsx`、`tests/unit/app/actions/news-actions.test.ts`、`tests/unit/home/home-page.test.tsx`、`tests/integration/api/news-public-api.test.ts`・`news-proxy.test.ts`・`news-latest-action.test.ts`、`tests/integration/ui/news-list-screen.test.tsx`・`news-detail-screen.test.tsx`・`news-public-read-path.test.tsx`・`news-list-detail-flow.test.tsx`・`news-home-section.test.tsx`・`news-category-state.test.tsx`、`tests/integration/api/home-page-public-read.test.ts`（NEWS の節だけ）、`tests/integration/ui/home-page-fetch-flow.test.tsx`（確認）
- E2E: `e2e/FR-NEWS-SEC-003-http-hardening-and-rate-limit.spec.ts`、`e2e/FR-NEWS-SEC-001-public-data-exposure.spec.ts`
- Docs: `docs/02_Requirements/areas/news.md`・`home.md`、`docs/05_Quality/security/threats/news.md`、`docs/03_BasicDesign/areas/news.md`・`home.md`、`docs/03_BasicDesign/decisions/ADR-0024-news-public-fetch-failure-throws.md`（新規）、`docs/04_DetailDesign/pages/02_news_list.md`・`03_news_detail.md`・`01_home.md`

**Interfaces:**

```ts
// src/features/news/lib/news-input.ts
/** /^[1-9]\d{0,17}$/（bigint の桁）。DB に渡す前の確かめ。 */
export function isNewsId(value: string): boolean;
/** 分類を大文字にして src/lib/news-data.ts の categories にある物だけ返し、外れ・無しは 'ALL'（頁の resolveCategory と同じ決まり）。 */
export function resolveNewsCategory(raw: string | null | undefined): (typeof categories)[number];
// src/features/news/services/public.ts
export class NewsFetchError extends Error { readonly code: string | null }
// getPublishedNews: { data, error } を読み、error なら { name, code } を記録して NewsFetchError。
// getPublishedNewsDetailById: isNewsId(id) が偽なら DB を呼ばず null。.maybeSingle()。error は NewsFetchError、行なしは null。
// getPublishedNewsNavigation: error は { name, code } を記録して { prevArticle: null, nextArticle: null }（前後だけ握る）。getPublishedNewsCount は今までどおり 0 を返し、記録は { name, code }。
// /api/news: 全ての応答（200・400 相当・429・503・500）を withNoStore で包む。category は resolveNewsCategory を通して渡す。
// src/app/page.tsx: getPublishedNews({ limit }) に .catch(() => [])（ホームは落とさない）。
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "test.fail" e2e/FR-NEWS-SEC-001-*.ts e2e/FR-NEWS-SEC-003-*.ts`（SEC-001: 445、SEC-003: 109・134・146・194・219）。`getPublishedNews` の呼び手（`/api/news`・`/news`・ホーム・未使用の `getLatestNews`）を確かめ、throw が及ぶ所を数える。`categories` の中身（`src/lib/news-data.ts:120`）。
- [ ] **Step 2（RED）: 単体試験を書く。**
  - `news-input.test.ts`（先頭 `DD-NEWS-070`）: `isNewsId`: `'1'`・`'123456789012345678'`（18 桁）は真、`'0'`・`'01'`・`'abc'`・`'1.5'`・`'-1'`・`'1234567890123456789'`（19 桁）・`''`・`'1 '` は偽。`resolveNewsCategory`: `'collection'`→`'COLLECTION'`、`'ALL'`→`'ALL'`、`undefined`・`null`・`''`→`'ALL'`、`'X'.repeat(300)`→`'ALL'`、`'EVENT;drop'`→`'ALL'`。
  - `news-public-service.test.ts`（先頭 `DD-NEWS-003`・`031`・`032`）: 一覧の `error`（`{ code: '42501', message: 'permission denied' }`）→ `NewsFetchError`（`code` は `'42501'`）で reject し、`console.error` の第 2 引数が `{ name, code }` で `message` を含まない。詳細: `isNewsId('abc')` で `from` が呼ばれず `null`、行なしは `null`、`error` は reject。前後: `error` は `{ prevArticle: null, nextArticle: null }` で記録が 1 回。件数: `error` は 0。
  - `news-route.test.ts`（先頭 `DD-NEWS-004`）: 200・429（`enforceRateLimit` が返す）・503・500（`getPublishedNews` が `NewsFetchError`）の全てが `Cache-Control: private, no-store`。`category=${'X'.repeat(300)}` は `getPublishedNews` に `category: 'ALL'` で渡る。`category=collection` は `COLLECTION`。500 の本文は固定の `Failed to fetch news`、`console.error` は `{ name, code }`。
  - `news-error.test.tsx`（先頭 `DD-NEWS-069`）: `news-error` は Task 4 の `look-error` と同じ形の確かめ（見出し・「エラー」を含む文・`error.message` が DOM に無い・`retry` が 1 回・`console.error` は `{ digest }` だけ）。
  - `news-list-page.test.tsx`（先頭 `DD-NEWS-002`）: `getPublishedNews` が `NewsFetchError` で reject → ページも reject。`news-detail-page.test.tsx`（先頭 `DD-NEWS-030`）: `abc` は `notFound()`、`generateMetadata` は固定の題を返す（投げない）。`home-page.test.tsx`（先頭 `DD-HOME-001`）: `getPublishedNews` が reject してもホームが描かれ、ニュースの区画は空。
- [ ] **Step 3（GREEN）: 実装する。** `news-input.ts` → `public.ts` → `/api/news` → 頁 2 つ → `error.tsx` → `src/app/page.tsx`（1 行）。`tsc` を流す。`src/app/actions/news.ts` の `getLatestNews`（未使用）は変えない。
- [ ] **Step 4: 結合・UI 試験を直す。** `news-public-api.test.ts`（category を渡す期待・500 の記録）、`news-latest-action.test.ts`、`news-public-read-path.test.tsx`（`error` を読むモックの形）、`home-page-public-read.test.ts` の NEWS の節（`from().select()` の戻りに `error: null` を持たせる）。結合のテスト名の先頭は `API-NEWS-001`・`SCR-NEWS-001`・`SCR-NEWS-002`・`ARC-NEWS-001`・`ARC-HOME-002`。
- [ ] **Step 5: 対象の `jest` を流す。** `npx jest tests/unit/features/news tests/unit/api/news tests/unit/app/news tests/unit/app/actions/news-actions.test.ts tests/unit/home/home-page.test.tsx tests/integration/api/news-public-api.test.ts tests/integration/api/news-proxy.test.ts tests/integration/api/news-latest-action.test.ts tests/integration/api/home-page-public-read.test.ts tests/integration/ui/news-list-screen.test.tsx tests/integration/ui/news-detail-screen.test.tsx tests/integration/ui/news-public-read-path.test.tsx tests/integration/ui/news-list-detail-flow.test.tsx tests/integration/ui/news-home-section.test.tsx tests/integration/ui/news-category-state.test.tsx tests/integration/ui/home-page-fetch-flow.test.tsx`。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-NEWS-SEC-003:134`（`SEC-NEWS-006-AC-01`）・`:194`（`SEC-NEWS-006-AC-02`）、`FR-NEWS-SEC-001:445`（`SEC-NEWS-012-AC-01`）。
  - 外さない: `FR-NEWS-SEC-003:109・146・219`（`004`・`023`・`011` は共有）、`FR-NEWS-SEC-002` の全て（DB）、Task 7 の分。
  - 期待の確認: `SEC-NEWS-012-AC-01` の外れた分類は `ALL` と同じ記事になる（`200` の側）。
- [ ] **Step 7: 文書。** `areas/news.md`: `SEC-NEWS-006`・`012`（`AC-01`）を満たした旨にし、`SEC-NEWS-020` は公開の分（`AC-03`）を満たした旨（管理の分は Task 7）。本文の「画像の署名の client を作れない時も、公開の一覧の文字は出す」は、1-B（`SEC-NEWS-005`）で公開の取り出しが署名も service role も持たなくなったので満たしている、と現行に書く（コードは変えない）。`areas/home.md`: `FREQ-147-REQ-01` の「元の `requirements.md` の要件の文の『10件』は古いまま」の一文を、1-B で `requirements.md` が 8 件に直ったことに合わせて直す（1-B の報告にある古くなった一文）。`threats/news.md`: `THR-NEWS-012`・`019` ほか。`areas/news.md`（構造設計）: `API-NEWS-001`、`SCR-NEWS-001`・`002`、`ARC-NEWS-001`。`02_news_list.md`: `DD-NEWS-002`・`003`・`004`、`DD-NEWS-069`（新規）。`03_news_detail.md`: `DD-NEWS-030`・`031`・`032`、`DD-NEWS-070`（新規）。`01_home.md`: `DD-HOME-001`（ニュースの失敗を握る）。`ADR-0024` を新規。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- NEWS`、`npm run validate-trace -- HOME`。
- [ ] **Step 9: 報告。** 変えたファイル、外した印、共有文書の変更案（`api-spec.md`: `/api/news` の `Cache-Control`・分類の外れは `ALL`）。controller が確かめる点: `/news` の誤りの画面の HTTP 状態。コミットは作らない。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- NEWS`、`npm run validate-trace -- HOME`。

---

## Task 7: NEWS 管理の窓口（SEC-NEWS-012 の管理側・017・018・020 の管理側）

**範囲:** 管理のニュースの画像を中身で確かめ、保存名を種類の対応表から作り、消した・差し替えた・保存に失敗した画像を置き場から消す。1 件の取得の「無い」と「失敗」を分ける。管理の一覧の失敗を 0 件と別に出す。編集の頁の id を確かめる。**署名の道筋の確かめ（SEC-NEWS-007・008 の本体）は R8 で波 3。**

**Files:**

- Create: `src/features/news/services/admin-images.ts`（`IMPL-NEWS-170`〜`173`・`DD-NEWS-071`）、`tests/unit/features/news/services/admin-images.test.ts`
- Modify: `src/app/api/admin/news/route.ts`（`IMPL-NEWS-161`・`DD-NEWS-064`）、`src/app/api/admin/news/[id]/route.ts`（`IMPL-NEWS-162`・`DD-NEWS-065`）、`src/components/NewsSection.tsx`（`IMPL-NEWS-141`・`DD-NEWS-060`）、`src/app/admin/news/edit/[id]/page.tsx`（`IMPL-NEWS-144`・`DD-NEWS-063`）
- Test: `tests/unit/api/admin/news/news-admin-route.test.ts`・`news-admin-id-route.test.ts`、`tests/unit/components/NewsSection.test.tsx`、`tests/unit/app/admin/news/news-edit-page.test.tsx`、`tests/integration/api/news-admin-create-api.test.ts`・`news-admin-item-get-api.test.ts`・`news-admin-item-put-api.test.ts`・`news-admin-item-patch-api.test.ts`・`news-admin-item-delete-api.test.ts`・`news-admin-list-api.test.ts`・`news-admin-write-path.test.ts`・`news-image-signing.test.ts`、`tests/integration/ui/news-admin-list-screen.test.tsx`・`news-admin-edit-screen.test.tsx`・`news-admin-create-screen.test.tsx`・`news-admin-flow.test.tsx`
- E2E: `e2e/FR-NEWS-SEC-005-admin-write-aal2.spec.ts`、`e2e/FR-NEWS-ADMIN-001-admin-news-screens.spec.ts`
- Docs: `docs/02_Requirements/areas/news.md`、`docs/05_Quality/security/threats/news.md`、`docs/03_BasicDesign/areas/news.md`、`docs/03_BasicDesign/decisions/ADR-0025-news-admin-image-cleanup-after-db-change.md`（新規）、`docs/04_DetailDesign/pages/16-1_admin_news.md`

**Interfaces:**

```ts
// src/features/news/services/admin-images.ts
export const NEWS_IMAGE_BUCKET = 'news-images';
export async function prepareNewsImage(image: File): Promise<{ buffer: Buffer; contentType: DetectedImageType; extension: string } | null>; // 申告と先頭の印が同じ時だけ
export function buildNewsImagePath(extension: string, now?: Date): string;  // news/YYYY-MM-DD/<uuid>.<ext>
export function isOwnNewsImagePath(path: string): boolean;                  // /^news\/[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/
export async function removeNewsImages(supabase: SupabaseClient, rawUrls: readonly (string | null | undefined)[], keep?: readonly string[]): Promise<'ok' | 'failed'>; // extractNewsImageObjectPath で道筋にし、isOwnNewsImagePath を通る物だけを remove。失敗は { name, code } だけ記録。投げない
// POST: prepareNewsImage → null なら 400 'Unsupported image type'（置き場に書かない）。DB の insert が失敗したら上げた道筋を removeNewsImages。
// PUT: id が isNewsId でなければ 404。画像ありの時、上げる前に select('image_url').eq('id', id).maybeSingle() で古い値を読み（無ければ 404・何も上げない）、更新が成功したら古い道筋を除去、更新が失敗・0 行なら新しい道筋を除去。
// DELETE: .delete().eq('id', id).select('id, image_url')。成功後に image_url を removeNewsImages。失敗しても 200（監査 metadata.imageCleanup = 'failed'）。
// GET [id]: isNewsId でなければ 404（DB を呼ばない）。.maybeSingle()。error → 500 + { name, code } を記録、null → 404。
// 1-B の local な newsIdPattern（/^\d{1,18}$/）は isNewsId に統一する。全ての console.error は describeErrorForLog。
// removeNewsImages に渡す client は、上げるのと同じ service role の client（今の uploadSupabase = createServiceRoleClient()）。DB の読み書きは今のまま利用者の session（dbSupabase）。
//   DELETE は今 session の client しか作らないので、削除が成功した後に createServiceRoleClient() を 1 つ作って消すのに使う（行の削除・存在の判定には使わない）。
//   session の client で置き場を消すと storage.objects の方針次第で断られ、方針を足す移行が要るようになる（この波では移行を作らない）。
// NewsSection: 取得が失敗したら role="alert" で「ニュース記事の取得に失敗しました」と再読み込みのボタン。0 件の「ニュース記事がありません」とは別。
// 編集の頁: isNewsId(articleId) でなければ要求を送らず「記事の読み込みに失敗しました」。fetch の道は encodeURIComponent。
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "test.fail" e2e/FR-NEWS-SEC-005-*.ts e2e/FR-NEWS-ADMIN-001-*.ts`（SEC-005: 285・304・338・353、ADMIN-001: 472）。`grep -rn "new File(\[" tests | grep -i news` で偽の画像を使う試験を数える（`news-admin-create-api`・`news-admin-item-put-api`・`news-admin-write-path`・`news-image-signing`・`news-admin-route`・`news-admin-id-route`）。`extractNewsImageObjectPath` の挙動（旧い公開 URL でも道筋を取り出す）。
- [ ] **Step 2（RED）: 単体試験を書く。**
  - `admin-images.test.ts`（先頭 `DD-NEWS-071`）: Task 5 の LOOK の試験と同じ形（接頭辞 `news/`、`prepareNewsImage`・`buildNewsImagePath`・`isOwnNewsImagePath`・`removeNewsImages`）。`removeNewsImages(supabase, ['news/e2e/a.png', 'e2e/news-1.png', null], ['news/e2e/b.png'])` は `news/e2e/a.png` だけ `remove`。古い公開 URL の形（`/storage/v1/object/public/news-images/news/z.png`）は `news/z.png` に直る。
  - `news-admin-route.test.ts`（先頭 `DD-NEWS-064`）: HTML を `image/png` と申告した POST → 400 `Unsupported image type`、`upload` が呼ばれない。DB の `insert` が失敗 → 上げた道筋で `remove` が 1 回、500 `Failed to save news article`。`remove` が失敗しても応答は変わらない。
  - `news-admin-id-route.test.ts`（先頭 `DD-NEWS-065`）: PUT — 名前 `x.html` の本物の PNG → 道筋が `.png` で終わり `contentType: 'image/png'`。画像あり・記事なし（古い値の読みが null）→ 404、`upload` が呼ばれない。更新成功 → 古い道筋を `remove`（新しい道筋と同じ物は渡さない）。更新の error → 新しい道筋を `remove`、500。更新が 0 行 → 新しい道筋を `remove`、404。画像なしの PUT は `remove` を呼ばない。DELETE — 成功で `image_url` を `remove`（`remove` を受けるのは `createServiceRoleClient` の模擬で、`createClient` の模擬の `storage` は呼ばれない）、`remove` が失敗しても 200 で監査に `imageCleanup: 'failed'`、0 行は 404 で `remove` なし。POST・PUT の `remove` も service role の模擬が受ける。GET — `abc` は 404 で DB を呼ばない、`maybeSingle` の error は 500、null は 404。
  - `NewsSection.test.tsx`（先頭 `DD-NEWS-060`）: `/api/admin/news` が 500 → `role="alert"` に「ニュース記事の取得に失敗しました」、「ニュース記事がありません」は無い。再読み込みのボタンで再取得。成功して 0 件なら「ニュース記事がありません」。
  - `news-edit-page.test.tsx`（先頭 `DD-NEWS-063`）: `articleId = 'abc'`・`'..%2F..%2Fadmin'` で `fetch` が呼ばれず、失敗の文が出る。正しい id の fetch の URL が `/api/admin/news/123`。
- [ ] **Step 3（GREEN）: 実装する。** `admin-images.ts` → 2 つの route → `NewsSection.tsx` → 編集の頁。`tsc` を流す。PUT の古い値の読みは**利用者の session の client**（RLS を通す。他の読み書きと同じ）で、無ければ 404 の監査（`respondArticleNotFound`）を使う。中身の確かめは種類・サイズの確かめの直後・`upload` の前。
- [ ] **Step 4: 結合・UI 試験を直す。** 偽の画像の見本を `fileOf(minimalPng(), …)` に替える（数えた 6 ファイル）。`news-admin-item-put-api`・`news-admin-write-path`・`news-image-signing` のモックの連鎖に `maybeSingle`・`storage.from().remove` を足す。`news-admin-item-get-api` は DB の失敗が 500 になる期待を足す（`SEC-NEWS-020-AC-02`。先頭 `API-NEWS-004`）。作成の失敗で置き場のファイルの数が増えない結合を足す（`SEC-NEWS-018-AC-03`。先頭 `API-NEWS-003`）。結合のテスト名の先頭は `API-NEWS-002`〜`007`・`SCR-NEWS-003`・`SCR-NEWS-005`。
- [ ] **Step 5: 対象の `jest` を流す。** `npx jest tests/unit/features/news/services tests/unit/api/admin/news tests/unit/components/NewsSection.test.tsx tests/unit/app/admin/news tests/integration/api/news-admin-create-api.test.ts tests/integration/api/news-admin-item-get-api.test.ts tests/integration/api/news-admin-item-put-api.test.ts tests/integration/api/news-admin-item-patch-api.test.ts tests/integration/api/news-admin-item-delete-api.test.ts tests/integration/api/news-admin-list-api.test.ts tests/integration/api/news-admin-write-path.test.ts tests/integration/api/news-image-signing.test.ts tests/integration/ui/news-admin-list-screen.test.tsx tests/integration/ui/news-admin-edit-screen.test.tsx tests/integration/ui/news-admin-create-screen.test.tsx tests/integration/ui/news-admin-flow.test.tsx`。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-NEWS-SEC-005:285`（`SEC-NEWS-017-AC-01`）・`:304`（`017-AC-02`）・`:338`（`SEC-NEWS-018-AC-01`）・`:353`（`018-AC-02`）、`FR-NEWS-ADMIN-001:472`（`SEC-NEWS-020-AC-01`。3 つの幅）。
  - 外さない: `FR-NEWS-SEC-005` の他の印（無し）、`FR-NEWS-SEC-002` の全て（DB）。
  - 期待の確認: `SEC-NEWS-012-AC-03`（編集の頁。印なし、今は緑）が `isNewsId` の変更後も緑であること（要求は `/api/` の外へ出ない）。
- [ ] **Step 7: 文書。** `areas/news.md`: `SEC-NEWS-012`（管理の分）・`017`・`018`・`020`（管理の分）の「今のコードは満たさない」を外し、`SEC-NEWS-007`・`008` は変えない（署名の本体は波 3）。`SEC-NEWS-016` の未確認事項にあった「無い id の PUT で上げた画像が残る」を直った旨に。`threats/news.md`: `THR-NEWS-012`・`017`・`018`・`019`。`areas/news.md`（構造設計）: `ARC-NEWS-003`（後始末）、`API-NEWS-002`〜`007`、`SCR-NEWS-003`・`005`。`16-1_admin_news.md`: `DD-NEWS-060`・`063`・`064`・`065` を直し、`DD-NEWS-071`（新規）。`ADR-0025` を新規。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- NEWS`。
- [ ] **Step 9: 報告。** 変えたファイル、外した印、共有文書の変更案（`api-spec.md`: 管理のニュースの POST・PUT の 400 `Unsupported image type`、GET `[id]` の 500）。残る穴: 本番の既に残っている孤児の画像の掃除は別の運用作業。コミットは作らない。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- NEWS`。

---

## Task 8: PRIVACY の誤りの画面と最終改定日、`/api/auth/me` のメール（SEC-PRIVACY-009・012・016、SEC-HOME-016）

**範囲:** `/privacy` に誤りの画面を足し（案内だけ）、最終改定日を追跡の切り替え日に追従させ、`/api/auth/me` の応答から `email` を外す。**`/privacy` の節の文（2・3・5・7・9 節）は触らない**（SEC-PRIVACY-011 は Task 9 の案）。

**Files:**

- Create: `src/app/privacy/error.tsx`（`IMPL-PRIVACY-102`・`DD-PRIVACY-002`）、`src/app/privacy/revision-date.ts`（`IMPL-PRIVACY-103`・`DD-PRIVACY-003`）、`tests/unit/app/privacy/privacy-error.test.tsx`、`tests/unit/app/privacy/revision-date.test.ts`
- Modify: `src/app/privacy/page.tsx`（`IMPL-PRIVACY-101`・`DD-PRIVACY-001`。最終改定日の 1 行と import だけ）、`src/app/api/auth/me/route.ts`（`IMPL-AUTH-185`・`DD-AUTH-026`）
- Test: `tests/unit/components/PrivacyPage.test.tsx`、`tests/integration/ui/privacy-policy-screen.test.tsx`・`privacy-tracking-clause-state.test.tsx`・`privacy-request-time-render.test.tsx`、`tests/unit/api/auth/me-route.test.ts`、`tests/integration/api/auth/me.test.ts`、`tests/unit/components/LoginContext.test.tsx`（確認）
- E2E: `e2e/FR-PRIVACY-006-response-headers-and-cookies.spec.ts`、`e2e/FR-PRIVACY-008-tracking-setting-and-read-failure.spec.ts`、`e2e/FR-PRIVACY-009-tracking-setting-read-failure.spec.ts`、`e2e/FR-HOME-022-home-response-hardening.spec.ts`（`:215`）
- Docs: `docs/02_Requirements/areas/privacy.md`・`home.md`・`auth.md`、`docs/05_Quality/security/threats/privacy.md`・`home.md`・`auth.md`、`docs/03_BasicDesign/areas/privacy.md`・`auth.md`、`docs/03_BasicDesign/decisions/ADR-0353-privacy-revision-date-follows-tracking-switch.md`・`ADR-0354-privacy-error-screen-guidance-only.md`（新規）、`docs/04_DetailDesign/pages/17-1_privacy.md`

**Interfaces:**

```ts
// src/app/privacy/revision-date.ts
export const PRIVACY_POLICY_BASE_REVISION = '2026-07-11';
/** 基準日と、追跡の設定が変わった時刻（UTC の文字列）を日本時間の日付にした物の、遅いほうを「YYYY年M月D日」で返す。null・読めない値・基準日より前は基準日。 */
export function resolveRevisionDate(trackingUpdatedAt: string | null): string;
// page.tsx: 最終改定日：{resolveRevisionDate(deliveryTracking.updatedAt)}（更新者のメール・件数は頁に出さない。使うのは enabled と updatedAt だけ）
// error.tsx: 'use client'。props { error, retry }（checkout/error.tsx と同じ名前）。見出し「プライバシーポリシーを表示できません」（h1 に "Privacy Policy" を入れない）、
//   「現在、プライバシーポリシーを表示できません。しばらく時間を置いてから、もう一度お試しください。」、privacy@lefildesheures.com、/contact への「お問い合わせフォーム」のリンク、retry を呼ぶ「もう一度表示する」。
//   方針の本文・委託の一覧・17TRACK・error.message・stack を出さない。console.error('[privacy] render failed', { digest }) だけ。
// /api/auth/me: user = { id: claims.sub, role, mfaVerified }（email を外す。id は残す）
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "test.fail" e2e/FR-PRIVACY-00*.ts e2e/FR-HOME-022-*.ts`（PRIVACY-005: 71・79、006: 57・68・93、008: 79、009: 87、HOME-022: 94・118・149・208・215）。`grep -rn "\.email\b" src/contexts src/components src/app --include=*.tsx | grep -iv "admin\|user.email.*Section"` で `/api/auth/me` の `user.email` を読む所が無いことを確かめる（`LoginContext`・`auth/verified`・`VerifyOtpClient`・`auth/callback`）。`getDeliveryTrackingSettings` の `updatedAt` の型（`string | null`）。
- [ ] **Step 2（RED）: 単体試験を書く。**
  - `revision-date.test.ts`（先頭 `DD-PRIVACY-003`）: `null`→`2026年7月11日`、`''`→基準日、`'not-a-date'`→基準日、`'2026-06-01T00:00:00Z'`→基準日、`'2026-07-10T15:00:00Z'`（日本時間 7/11 0 時）→`2026年7月11日`、`'2026-07-11T15:00:00Z'`（日本時間 7/12 0 時）→`2026年7月12日`（UTC の日付のままだと 7/11 になる境目）、`'2026-10-26T16:30:00Z'`→`2026年10月27日`、`'2027-01-05T00:00:00Z'`→`2027年1月5日`（月・日はゼロ詰めしない）。
  - `privacy-error.test.tsx`（先頭 `DD-PRIVACY-002`）: 「時間を置いて」「もう一度」が含まれる、`privacy@lefildesheures.com` と `/contact` へのリンクがある、`h1` が `Privacy Policy` を含まない、`error.message = 'get_delivery_tracking_settings permission denied 42501'` が DOM に無い、`17TRACK`・`個人情報の取扱いの委託` が無い、ボタンで `retry` が 1 回、`console.error` の呼び出しが `{ digest }` だけで `message`・`stack` を持たない。
  - `me-route.test.ts`（先頭 `DD-AUTH-026`）: 認証済みの応答の `user` のキーが `id`・`role`・`mfaVerified` ちょうど、`JSON.stringify` に `@` を含むメールが無い。未認証・503 の応答は今までどおり。
  - `PrivacyPage.test.tsx`（先頭 `DD-PRIVACY-001`）: `updated_at: null` で `最終改定日：2026年7月11日`（今までどおり）、`updated_at: '2026-10-26T16:30:00Z'` で `最終改定日：2026年10月27日`。試験の名前の「固定の字」「追跡がオンでも変わらない」は逆になるので直す。
- [ ] **Step 3（GREEN）: 実装する。** `revision-date.ts` → `page.tsx`（1 行）→ `error.tsx` → `me/route.ts`。`tsc` を流す。`resolveRevisionDate` は `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })` で `YYYY-MM-DD` を作り、基準日と文字の辞書順で比べる。
- [ ] **Step 4: 結合・UI 試験を直す。** `privacy-policy-screen.test.tsx:118`・`privacy-tracking-clause-state.test.tsx:99`（STATE-PRIVACY-001「どの状態でも最終改定日は変わらない」）の期待と名前を直し、`updated_at` が入る試験を足す。`me.test.ts`（`API-AUTH-013`）の `email` の期待を外す。`LoginContext.test.tsx` のモックに `email` が残っていても読み手は使わない（任意）。結合のテスト名の先頭は `SCR-PRIVACY-001`・`STATE-PRIVACY-001`・`API-AUTH-013`。
- [ ] **Step 5: 対象の `jest` を流す。** `npx jest tests/unit/app/privacy tests/unit/components/PrivacyPage.test.tsx tests/integration/ui/privacy-policy-screen.test.tsx tests/integration/ui/privacy-tracking-clause-state.test.tsx tests/integration/ui/privacy-request-time-render.test.tsx tests/integration/api/privacy-proxy-headers.test.ts tests/unit/api/auth/me-route.test.ts tests/integration/api/auth/me.test.ts tests/unit/components/LoginContext.test.tsx`。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-PRIVACY-006:93`（`SEC-PRIVACY-016-AC-01`。3 つの幅）、`FR-PRIVACY-008:79`（`SEC-PRIVACY-012-AC-01`）、`FR-PRIVACY-009:87`（`SEC-PRIVACY-009-AC-01`）、`FR-HOME-022:215`（`SEC-HOME-016-AC-01`。3 つの幅）。
  - 外さない: `FR-PRIVACY-005:71・79`（`SEC-PRIVACY-011`。Task 9 は案だけ）、`FR-PRIVACY-006:57・68`（`014`・`015`。波 3）、`FR-HOME-022:94・118・149`（別の波）。
  - 期待の確認: `FR-PRIVACY-009` の `SEC-PRIVACY-005-AC-01`・`008-AC-01`（今は緑）と、印を外す `009-AC-01` は `response.status() === 500` を前提にしている。`error.tsx` の後も 500 の見込みだが未実測（P10）。`error.tsx` の文は `getByRole('main')` の中に出る（`openPrivacyWhileUnreadable` は `main` があれば `main` の字だけを読む）ので、案内と窓口を `main` の外の部品にしない。`e2e/account-test-utils.ts:32` ほか 3 か所の `/api/auth/me` の模擬（`email` 入り）は共有の補助なので**触らない**（読み手が使わないので壊れない。実物に合わせるのは任意の後始末として報告する）。
- [ ] **Step 7: 文書。** `areas/privacy.md`: `SEC-PRIVACY-009`・`012`・`016` の「今のコードは満たさない」を外す。`SEC-PRIVACY-011` は変えない。`areas/home.md`: `SEC-HOME-016` を「メールの住所を外した。`id` は `SEC-PRIVACY-016-AC-01` が要るので残す」に直し、本文の「id・メール」との食い違いを書く（P9）。`areas/auth.md`: `DRV-AUTH-007` の応答の項目を直す。`threats/privacy.md`: `THR-PRIVACY-004`・`008` ほか。`threats/home.md`: `THR-HOME-016`。`threats/auth.md`: 該当。`areas/privacy.md`（構造設計）: `ARC-PRIVACY-001`、`STATE-PRIVACY-001`、`SCR-PRIVACY-001`。`areas/auth.md`（構造設計）: `API-AUTH-013`。`17-1_privacy.md`: `DD-PRIVACY-001` を直し、`DD-PRIVACY-002`・`003`（新規）。`pages/14_login.md`: `DD-AUTH-026`。`ADR-0353`・`ADR-0354` を新規。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- PRIVACY`、`npm run validate-trace -- AUTH`、`npm run validate-trace -- HOME`。
- [ ] **Step 9: 報告。** 変えたファイル、外した印、共有文書の変更案（`api-spec.md`: `/api/auth/me` の応答から `email`、`{id, email, role, mfaVerified}` → `{id, role, mfaVerified}`）。食い違い: `SEC-HOME-016` の本文。controller が確かめる点: `/privacy` の誤りの画面の HTTP 状態が 500 のままか（P10）、`FR-PRIVACY-008` の `SEC-PRIVACY-012-AC-01` が追跡を切り替えた日（日本時間）以降になるか。コミットは作らない。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- PRIVACY`、`npm run validate-trace -- AUTH`、`npm run validate-trace -- HOME`。

---

## Task 9: SEC-PRIVACY-011 の文の案（文書のみ。コードも要件の本文も変えない）

**範囲:** `wave1c-decisions.md` の 3 に従い、プライバシーポリシーの外部サービスの公表の文の案を 1 つの文書にまとめる。controller がユーザーに見せて決めてもらう。**`src/`・`tests/`・`e2e/`・`docs/` のどれも変えない**。

**Files:**

- Create: `C:\work\o_official\.superpowers\sdd\2026-10-25-security-gap-fixes\wave1c-privacy-011-draft.md`（これ 1 つだけ）

**Interfaces:** なし（文書のみ）。下の構成の 6 つの節を持つ 1 つの Markdown。

- [ ] **Step 1: 事実の確認（読むだけ）。** 次を確かめて、案の「事実」の表にコードの場所つきで書く。(a) 個人情報（メール・氏名・住所・電話・注文の内容・IP）を渡す外部サービスを、`src/` から数える。`rg -n "resend|Resend" src` / `rg -n "turnstile|challenges.cloudflare" src` / `rg -n "createClient|supabase" src/lib/supabase` / `rg -n "stripe" src/lib/stripe` / `rg -n "17track|17TRACK" src/lib/orders/tracking`。各サービスについて、**何を渡すか**（メールの宛先と本文、IP とトークン、全データの保管、決済情報、伝票番号）を 1 行で書く。(b) `src/app/privacy/page.tsx` の現行の文（2・3・5・7・9 節）を原文のまま引用する。(c) 「メールマガジン」と「キャンペーン」の機能が `src/` にあるかを確かめる（`rg -n "newsletter|メールマガジン|campaign|promotion" src`。`/api/checkout/promotion-code` は割引コードで、案内の送信は無い見込み）。(d) 試験が固定している文・個数を数える（`tests/integration/ui/privacy-policy-screen.test.tsx:89,145`、`tests/unit/components/PrivacyPage.test.tsx:75-92`、`tests/integration/ui/privacy-tracking-clause-state.test.tsx:62,81-84`、`e2e/FR-PRIVACY-005:71,79`、`FR-PRIVACY-008` の `SEC-PRIVACY-006-AC-01` の 3 項目 / 追跡オンで 4 項目）。
- [ ] **Step 2: 案を書く。** 見出し「波 1-C SEC-PRIVACY-011 の文の案」、確認日 2026-10-26、状態「案（法務の確認前。ユーザーが決める）」。構成: (1) 目的と前提（コード・要件の本文は変えない／入れる時の差分の予告）、(2) 事実の表（上の (a)〜(c)）、(3) 現行の文の引用、(4) **4 つの問い**を 1 つずつ、`選択肢の表（A/B/…、利点、欠点、試験への影響）` と `推奨` と `そのまま貼れる文案`（日本語）で書く:
  1. **会社名まで書くか**。選択肢: A 屋号と種類だけ（「メール送信サービス」など）／B 事業者名まで（`Resend, Inc.`・`Supabase, Inc.`・`Cloudflare, Inc.`。Stripe の既存の書き方と同じ粒度。**法人名は法務が確認する**と明記）。推奨 B。**各選択肢の表に、今の要件との合い方の列を置く**: `SEC-PRIVACY-011-AC-01` は「Stripe」「Resend」「Supabase」「Cloudflare Turnstile」（追跡オンで「17TRACK」）の名前が出ることを求めるので、A を選ぶと AC-01 と `FR-PRIVACY-005:71` の期待を直す（要件の本文を変える。ユーザーの判断）ことになる、と書く。B はそのまま AC-01 を満たす（「Cloudflare Turnstile」の字が文案に入ること）。
  2. **置き場: 5 節の一覧か 9 節の段落か**。推奨 9 節。今の `SEC-PRIVACY-011` の本文は「委託の一覧と 9 節に」と両方を書くので、9 節だけを選ぶ時は本文の「委託の一覧と」を直す（ユーザーの判断）ことを、選択肢の表の「要件との合い方」の列に書く。5 節の一覧に足す時の試験の個数の変化（3→6、追跡オンで 4→7）と、直す試験の一覧を書く。9 節の段落の文案（`メールの送信に…、データの保管と会員認証に…、不正なアクセスや自動操作の防止に Cloudflare, Inc. の Turnstile を…利用しており、必要な情報が同社へ送信され、同社のプライバシーポリシーに基づいて取り扱われます。` を土台に、事実の表に合わせて直す）。
  3. **「キャンペーン」の案内の使い道を残すか**。3 節「新商品やキャンペーン情報のご案内」と 2 節「キャンペーンやイベントへの参加時」。選択肢: A 残す（将来の機能のため。実際と食い違う）／B 実際の機能（割引コード・ご注文のご連絡）に合わせて書き直す／C 削除。2 節の「メールマガジンの購読登録時」は、要件 `SEC-PRIVACY-011-AC-02`（機能が無い間「メールマガジン」の字を出さない。`FR-PRIVACY-005:79`）が削除を求めるので、問いではなく「要件が決めている前提（変えるなら要件から）」として書く。
  4. **国名を 7 節に書くか**。選択肢: A 書かない（現行）／B 書く（米国など。各サービスの処理の場所は**確認が要る**と明記）。個人情報保護法の外国にある第三者への扱いの公表の要件との関係は、**法務に確認する点**として書き、断定しない。
  (5) 入れる時の作業の見積り（変えるファイル: `src/app/privacy/page.tsx` の 9 節・2 節・（3・7 節）、直す試験、外す `test.fail` は `FR-PRIVACY-005:71・79` の 2 行、`areas/privacy.md` の `SEC-PRIVACY-011`）、(6) ユーザーに聞くこと（4 つの問いの答え、法人名、国名）。
- [ ] **Step 3: 自己確認。** 案に断定できない法律の判断が無いこと（「法務に確認」と書く）。案の文が `src/app/privacy/page.tsx` の文体（である調でなく「〜します」）に合うこと。事実の表の全ての行にコードの場所があること。自分が書いたのがこの 1 ファイルだけであること（`.superpowers/` は丸ごと未追跡で、同じ作業ツリーを G-3 が触るので、`git status` では見分けられない。自分の書き込みの記録で確かめる）。
- [ ] **Step 4: 報告。** ファイルの場所、4 つの問いの推奨、法務に確認する点の一覧を返す。コミットは作らない（`.superpowers/` は管理外）。

**検証コマンド:** なし（文書のみ）。`src`・`tests`・`e2e`・`docs` のファイルを 1 つも書いていないこと（`git status` は G-3 の変更も出すので、自分の書き込みの記録で確かめる）。

---

## Task 10: 最終確認と controller への報告

**Files:** 変更なし（読むだけ）。報告だけを返す。

**Interfaces:** なし。

- [ ] **Step 1: 全体の型と文書。** `npx tsc --noEmit`（G-3 の誤りは報告に分けて書く）、`npm run validate-docs`、`npm run validate-trace`（全領域。`--update-baseline` はしない。基準より増えた違反が 0 件であること）。
- [ ] **Step 2: 触らない約束の確認。** `git status --short` と `git diff --stat` で、次が**変わっていない**ことを確かめる: `src/proxy.ts`、`next.config.ts`、`playwright.config.ts`、`src/features/auth/middleware/rateLimit.ts`、`src/features/auth/ratelimit/index.ts`、`src/lib/auth/authenticate.ts`、`src/lib/auth/admin-rbac.ts`、`src/lib/audit.ts`、`src/lib/mail.ts`、`src/app/admin/page.tsx`、`src/lib/storage/item-images.ts`・`look-images.ts`・`news-images.ts`、`supabase/migrations/**`、共有文書 7 つ、`tests/unit/docs/*-traceability.test.ts`、`src/app/page.tsx` の差分がニュースの `.catch` の 1 行だけ、`src/app/privacy/page.tsx` の差分が最終改定日の 1 行と import だけ（節の文が変わっていない）。
- [ ] **Step 3: `test.fail` の突き合わせ。** `grep -rn "test.fail" e2e/FR-SEARCH-01[89]* e2e/FR-SEARCH-02[0-2]* e2e/FR-LOOK-SEC-00* e2e/FR-NEWS-SEC-00* e2e/FR-NEWS-ADMIN-001* e2e/FR-STOCKIST-01[3-7]* e2e/FR-HOME-02[23]* e2e/FR-PRIVACY-00*` の結果が、各タスクの「外さない」と一致する（外した 30 行が残っていない。外さない行が消えていない。`FR-SEARCH-022` の `SEC-SEARCH-020-AC-01` と `FR-LOOK-SEC-003` の `SEC-LOOK-019-AC-04` の印が残り、`SEC-PRIVACY-011` の 2 行が残る）。外した行の一覧（ファイル:元の行:要件 ID）を報告に載せる。
- [ ] **Step 4: 新しい E2E の一覧。** 足した E2E（`SEC-LOOK-009-AC-02`・`SEC-LOOK-019-AC-05`・`SEC-SEARCH-020-AC-02`・`SEC-SEARCH-021-AC-02`）のファイルと、`isolated-global` の物（`FR-SEARCH-022`・`FR-LOOK-SEC-005`・`FR-PRIVACY-009`）を分けて表にする。
- [ ] **Step 5: controller への報告を返す。** 次を含める。
  1. 共有文書の変更案（各タスクの報告を集約）: `api-spec.md`（`/api/search`・`/api/suggest` の 403・400・500・`Cache-Control` と `x-search-duration-ms` の削除、`/api/news` の分類と `Cache-Control`、`GET /api/admin/looks` の `meta.canManage` と POST・PUT・`[id]` の 400・500、管理のニュースの 400・500、取扱店の管理の `Cache-Control`、`/api/auth/me` の `email` 削除）、`route-inventory.md`（窓口の追加・削除は無し。`error.tsx` は窓口でない）、`requirements.md`（変更なし。`SEC-LOOK-009` は領域のファイルで直した）、`test-spec.md`（テスト名の追加・変更）、台帳（状態欄。波 1-C で直した SEC の一覧）、`tests/unit/docs/*-traceability.test.ts`（窓口の数は変わらない見込みだが `npx jest tests/unit/docs` で確かめる）、`db-migrations.md`（変更なし）。
  2. controller が流す確認: E2E（本番ビルド、手元の Supabase）で外した 30 行と足した 4 本、`FR-SEARCH-022`・`FR-LOOK-SEC-005`・`FR-PRIVACY-009` は `isolated-global`、`npm run trace:report`、`npm run test:trace-coverage`（新しい分岐の網羅）、誤りの画面の HTTP 状態（`/privacy`・`/look`・`/news`）、`FR-LOOK-ADMIN-001` が緑のままか。
  3. **ユーザーに見せる物:** `SEC-SEARCH-021` の画面の写真（`test-results/wave1c/search-021-*.png` の 6 枚。E2E を流した直後に回収）、`SEC-PRIVACY-011` の文の案（Task 9 のファイル）。
  4. 運用: なし（環境変数の変更・移行は無い）。
  5. 回す物（下の表）。

---

## 回す物（この波で直さない。理由つき）

`design-final.md` §3-2 の波 1-C の行と `wave1c-decisions.md` の各項目、および 1-B の計画の「回す物」で 1-C に回された物を 1 つずつ見て、タスクに割り当てた物は上の Task に、割り当てなかった物は後ろの表に載せた。**§3-2 の波 1-B の行の項目は全て 1-B（コミット `a824932e`）で済んでいる**（1-B の計画の表のとおり）。ここで扱う 1-B 由来の物は、その計画が「波 1-C に回す」と書いた物だけ。

### 1-B の行の項目（全て 1-B で済み。ここでは割り当てない）

| 1-B の行の項目 | 状態 | 1-C に残る部分 |
| --- | --- | --- |
| R15: SEC-ADMIN-014・015、SEC-AUTH-017・006 | 1-B で済み（`a824932e`） | なし |
| R2: SEC-AUTH-031 の局所版（`enroll-totp`） | 済み | 共有版・DB 版は波 5（1-B の表のとおり） |
| R13: SEC-AUTH-022 の本文 | 済み | `/api/auth` の no-store（`SEC-AUTH-022-AC-02`）は波 3 |
| R7: SEC-AUTH-009・016-AC-03、SEC-ADMIN-006 | 済み | なし |
| R11: SEC-ADMIN-007・008・021、SEC-STOCKIST-013、SEC-NEWS-016 | 済み | なし（IP は波 4） |
| R12: SEC-ADMIN-012・013・018、SEC-STOCKIST-011・014 | 済み | **SEC-STOCKIST-014 の外側の `catch` と公開の取り出しの記録は Task 1** |
| R13・R14 の局所分: SEC-NEWS-005、SEC-STOCKIST-009・018、SEC-HOME-013、SEC-ADMIN-020 | 済み | なし |

### 波 1-C の行・決定・1-B から回った物の割り当て

| 項目 | 行き先 |
| --- | --- |
| R10: SEC-SEARCH-010 | Task 2 |
| R10: SEC-NEWS-006 | Task 6 |
| R10: SEC-STOCKIST-010（1-B から） | Task 1 |
| R12: SEC-LOOK-013（画像の中身）・016（id・JSON）・021（置き場の誤りの文言） | Task 5（016 の公開の頁は Task 4） |
| R12: SEC-NEWS-012（分類・id） | Task 6（公開・分類・詳細の id）、Task 7（管理の id・編集の頁） |
| R12: SEC-NEWS-017（画像の中身） | Task 7 |
| R12: SEC-SEARCH-004（制御文字）・019（処理時間の見出し） | Task 2 |
| R12: SEC-HOME-015（検索窓の stack） | Task 3（ブラウザ側。サーバー側の記録は P13） |
| R12: 共有の `image-signature.ts`・`safe-error.ts`（1-B から） | Task 1 |
| R14: SEC-LOOK-022（取り出しの失敗） | Task 4（公開）、Task 5（管理の 1 件） |
| R14: SEC-NEWS-020（取り出しの失敗） | Task 6（公開）、Task 7（管理） |
| R14: SEC-SEARCH-017（Q17） | Task 2 |
| R14: SEC-LOOK-014（画像の残り） | Task 5 |
| R14: SEC-NEWS-018（画像の残り。1-B の PUT の 404 の分も） | Task 7 |
| R13: SEC-LOOK-009（Q11） | Task 4 |
| R13: SEC-HOME-016・SEC-PRIVACY-016（`/api/auth/me` のメール。1-B から） | Task 8 |
| R16: SEC-LOOK-019 の局所版 | Task 5（カードの 3 ボタン。新規作成は下の表） |
| R18: SEC-PRIVACY-009・012 | Task 8 |
| R18: SEC-PRIVACY-011（Q24。文の案だけ） | Task 9 |
| R18: SEC-SEARCH-021（Q19） | Task 3 |
| R18/R7: SEC-SEARCH-005（画面の呼びすぎ） | Task 2 |
| R7: SEC-SEARCH-020 の (b)（Q18） | Task 2 |
| 1-B から: SEC-STOCKIST-014 の外側の `catch` と公開の取り出しの記録 | Task 1 |
| 1-B から: SEC-NEWS-007・008 の E2E 3 本の副産物 | 1-B で済み（`FR-NEWS-SEC-001:388・400・413`）。本体は下の表 |
| 1-B から: 管理のニュースの PUT の 404 で残る画像 | Task 7（P8） |

### 割り当てなかった物

| 項目 | 理由・行き先 |
| --- | --- |
| SEC-LOOK-019 の「新規作成」ボタン（`FR-LOOK-SEC-003:235` の `AC-04`）と CONTACT タブ（FR-ADMIN-009） | `src/app/admin/page.tsx`（G-3 が触る頁）→ **共有 → 波 4**。決定文の範囲の外。`AC-04` の印は残す |
| SEC-LOOK-007・008、SEC-NEWS-007・008 の本体、SEC-SEARCH-014〜016、SEC-HOME-006・007（署名の道筋・失敗で元の値・期限） | R8。`item/look/news-images.ts` は検索・ITEM（16 ファイル）が共有する → **共有 → 波 3**。Task 4 は `hydrateLooks` の「署名していない `image_urls` を載せて返す」道を投げる側で無くすが、署名の関数は直さない |
| SEC-AUTH-022-AC-02（`/api/auth` の no-store）、SEC-PRIVACY-014・015（CSP・`session_id`） | `proxy.ts`（共有）→ 波 3 |
| SEC-SEARCH-006・SEC-SEARCH-020 の (a)（偽の送り元） | `rateLimit.ts`（共有）→ 波 4。`FR-SEARCH-022:282` と `SEC-SEARCH-020-AC-01` の印を残す |
| SEC-LOOK-002・003・004・005・010・015・023、SEC-NEWS-002・010・022・025、SEC-SEARCH-003・007・008（DB の方針・権限・関数・制約・置き場の設定） | **DB の移行が要る → 波 2 / 5**。SEC-LOOK-015（更新を 1 つの関数に）が入ると Task 5 の PUT の後始末の位置は「関数の成功の後」に移る（`ADR-0160` に書く） |
| SEC-LOOK-020（監査の IP）、SEC-STOCKIST-012・019・020・021 | `request-ip.ts`・`rateLimit.ts`・`admin-rbac.ts`（共有）→ 波 4 |
| SEC-LOOK-012（1 時間の画像の量を作成と更新で別々に数える）、Q12（1 回の上限） | 設計の R のどこにも割り当てが無い。局所の直し（鍵を 1 つに）は小さいが、1 回の上限（20MB に上げるか 10MB 未満に要件を直すか）の**ユーザーの判断（Q12）が先**。`FR-LOOK-SEC-004:299` の印を残す |
| NFR-HOME-001（読み込み 2 秒）・NFR-HOME-002（ヒーローのコントラスト） | **ユーザーの判断（Q25）**: 要件を直すか画像を軽くするか、ヒーローを暗くするか。測ってから |
| FREQ-126（VIEW ALL の位置）、FREQ-139-AC-02・FR-LOOK-DETAIL-019（LOOK の見た目・読み上げ） | **ユーザーの判断（Q26。デザイン）**。後者は `BottomNavigation`（共有）に触る |
| SEC-AUTH-012（既に塞がっている。文書だけ） | コードの変更なし。1-C の行に無い。文書の整理として次の仕上げに |
| `password-reset/request` の DB 書き込みを `after()` に出す（SEC-AUTH-016 の時間差） | 1-B・1-C の行に無く、受け入れ条件も試験も無い。`after()` で書き込みを出すと実行環境によって書き込みが落ちうる → **controller の判断**（入れるなら要件の AC を先に足す） |
| 「ログの掃除」の束: `register` の監査の `detail: error.message`・`String(e)`、`create-user` の `console.error('admin.createUser error:', error)`、問い合わせの PATCH とテンプレートの PUT・DELETE の `console.error`、ITEM 側（`src/lib/items/public.ts` ほか）の DB の誤りの記録 | 触るファイルが AUTH・ADMIN・ITEM の別の領域の物で、それぞれの試験・文書の更新が要る。`describeErrorForLog` を使う機械的な差し替えなので、controller が欲しければ**別の小さなタスク（Task 11）**として足せる |
| 後始末: `docs/04_DetailDesign/sequence/auth-login-mfa.md` の未更新（1-B）、`e2e/account-test-utils.ts:32` ほか 3 か所の `/api/auth/me` の模擬の `email` | 1-B の後始末と共有の E2E 補助（多くの spec が使う）→ controller の判断 |
| 返信の保存の後の 500 で送り直すと返信が 2 つになりうる件（ADMIN）、cookie tossing（`sb-return-intent`）、MFA の登録の本人への通知 | 1-B の報告のとおり、ADMIN の判断・波 3〜5 |
| 画像の既存の孤児ファイルの掃除（本番） | 別の運用作業（Task 5・7 の後始末は今後の削除・差し替えだけに効く）。ユーザーの判断 |
| LOOK の一覧の上限 100 を超えた時のシーズンの絞り込みとページング（ADR-0152・0153 の見直し） | 現状の LOOK は 7 件。ユーザーの答え「超えたら見直す」 |
| SEC-PRIVACY-011 の本体（文の差し込み・`FR-PRIVACY-005:71・79` の印を外す） | ユーザーが案を決めてから（Task 9）。コードも要件の本文も、案が決まるまで変えない |

---

## 自己点検（計画の作成者が行った確認）

- **範囲の網羅。** `wave1c-decisions.md` の 3 つの答え・推奨の値・範囲の外・範囲の決まりと、`design-final.md` §3-2 の波 1-C の行（R12 の画像の中身・入力、R14 の取り出しの失敗、R16 の LOOK-019 の局所版、R18 の PRIVACY-009・011・012・SEARCH-021・005、R10 の route 単位の no-store）、波 1-B の計画の「回す物」で 1-C に回した物を、上の表で行ごとに Task か「割り当てなかった物」に載せた。
- **ファイルの重なり。** src・試験・E2E のファイルは、表に書いた共有（4 つの共有ファイル、`home-page-public-read.test.ts`、`look-image-signing.test.ts`、`FR-LOOK-SEC-005`、`home.md` 系の文書）を除いてどのタスクの間でも重ならない。重なる物は順番を決めた。
- **共有部品。** 触るのは新しい小さなファイル 3 つ（追加のみ）と、`withNoStore`・`describeErrorForLog`・`detectImageType`・`authorizeAdminPermission`・`extractLookImageObjectPath`・`extractNewsImageObjectPath`・`enforceRateLimit` を**呼ぶ**ことだけ。`proxy.ts`・`admin-rbac.ts`・`rateLimit.ts`・署名の共有ライブラリ・`src/app/admin/page.tsx`・移行は変えない。窓口は増やさない。
- **危ない読みを `前提の読み` に出した。** P3（020 の AC を分ける）、P5（`AC-04` が赤のまま残る）、P1（詳細の頁が一覧の写しに頼っていた）、P10（誤りの画面の HTTP 状態）、P9（`SEC-HOME-016` の本文の食い違い）。
- **行番号。** E2E の `test.fail` の行番号は 2026-10-26 の `grep` の結果。実装者は編集の前に `grep -n "test.fail"` で取り直す。
- **試験の段。** 単体は `DD-`、結合は `API-`・`SCR-`・`ARC-`・`STATE-`・`FLOW-`、E2E は `-AC-NN` で始める。新しい受け入れ条件の E2E は同じタスクで書く（`missing-child` を増やさない）。`SEC-SEARCH-018-AC-01` の E2E は元から無く、本計画でも足さない（サーバーの記録を集められない。報告に書く）。
- **残るリスク。** (1) `/privacy` の `error.tsx` が HTTP 状態を 200 にすると既存の緑 2 本が赤になり、外す 1 本も緑にならない（P10。Next.js の文書からは 500 のままの見込み）。(2) `FR-SEARCH-020-AC-02` の「外のオリジンの頁」の作り方は元の試験のまま移すので、環境で揺れる（元の試験の揺れと同じ）。(3) Task 5 の `canManage` は認可の往復が 1 回増える（波 4 で解く）。(4) 100 件を超える LOOK は一覧に出ない（詳細は開き、前後も出る。シーズンの絞り込みは 100 件の中だけ。ユーザーの答え「超えたら見直す」）。詳細の前後の `.or()` の時刻の引用は単体ではモックの文字しか見られず、本物の PostgREST での確かめは controller の E2E（`FR-LOOK-DETAIL-003` ほか）。(5) 本番の `look-images`・`news-images` の設定は未確認で、画像の削除が本番で効くかは置き場の権限次第（service role なので効く見込みだが未確認）。

---

## 計画のレビュー

| 項目 | 内容 |
| --- | --- |
| レビュー日 | 2026-10-26 |
| レビュアー | Claude Opus（計画のレビュー。コード・テスト・DB は変えていない。書いたのはこのファイルだけ） |
| 照らした物 | `wave1c-decisions.md`、`design-final.md` の R10・R12・R13・R14・R16・R18 と Q11・Q17〜Q19・Q24、各タスクが触る route と頁の今のコード、`docs/02_Requirements/areas/{look,news,search,privacy}.md` の該当の SEC と AC、`test.fail` の付いた E2E の本体、同梱の Next.js 16.3.6 の文書 |

### 確かめて合っていた点

- 決定文 1（SEC-LOOK-009）: 価格は残し、説明文だけを外し、上限 100。`FR-LOOK-SEC-001:425` の価格の確かめを消し、`AC-01` の文を直すのは決定のとおり。
- 決定文 3（SEC-PRIVACY-011）: Task 9 は `.superpowers/` の案 1 つだけを書き、`src`・`tests`・`e2e`・`docs` と要件の本文に触れない。`FR-PRIVACY-005:71・79` の印は残る。
- 共有部品（`rateLimit.ts`・`admin-rbac.ts`・`proxy.ts`・`next.config.ts`・`authenticate.ts`・`audit.ts`・`mail.ts`・`has_permission`・`src/app/admin/page.tsx`・署名の共有ライブラリ）と共有文書 7 つは、どのタスクも編集しない。新しい共有の物は `design-final.md` が新設を認めた 3 つ（`withNoStore`・`image-signature.ts`・`safe-error.ts`）と試験の見本だけ。`src/lib/orders/**` は Task 8・9 が読む・呼ぶだけ。
- 移行が要る物は隠れていない。置き場の削除は service role で行い（下の 3）、`get_delivery_tracking_settings` は既に `updated_at` を返す（`delivery-store.ts:237`）。`look_items` は `ON DELETE CASCADE`。
- `test.fail` の行番号（30 行と分ける 1 行）は今の E2E と一致した。各 E2E の期待（`SEC-LOOK-021-AC-01` の置き場の上限 1 バイト、`SEC-LOOK-022-AC-02` の service_role の権限の取り消し、`SEC-NEWS-012-AC-01` の ALL と同じ記事、`SEC-SEARCH-020-AC-01` の後半が `Sec-Fetch-Site: cross-site` を確かめる形、`SEC-SEARCH-005-AC-02` の 20 ミリ秒間隔の 5 文字）は、計画の直し方で緑になる形だった。E2E と UI の見本の画像（`tinyPng`・`makePng`・`TINY_PNG`）は本物の PNG で、中身の確かめで赤にならない。
- P5（`SEC-LOOK-019-AC-04` を赤のまま残し `AC-05` を足す）: 読み出しだけの役の利用者は `profiles` の役が `admin` のまま作られる（`withReadOnlyLookActor`）ので、`src/app/admin/page.tsx:1036` の「新規作成」は出続ける。読みは正しい。`design-final.md` R16 は「2 回目の認可は呼ばない」と書くが、集合を返すには `admin-rbac.ts`（共有）を変える必要があるので、P5・`ADR-0161` の暫定の 2 回目の認可は範囲の中で取れる唯一の形。
- 各タスクの型の変更は同じタスクの中で閉じる（`PublicLookListItem` はホームが推論で受ける、`src/app/page.tsx` の `.catch` は Task 6 だけ）。

### 直した点（この計画の本文を書き換えた）

1. **LOOK の詳細の前後（Task 4・P1・Review Focus 1・ID の割当・残るリスク）。** 元の案は、詳細の頁で一覧の 100 件（関連商品と署名つきの画像つき）を取り直してその中の位置で前後を決め、100 件より古い LOOK は前後を出さず、`SEC-LOOK-009` の本文を「前後は一覧（100 件）の位置で決める」に書き換えていた。今の本文は「詳細は対象の LOOK を1件で取り、前後の移動は前後の1件ずつだけを取る」で、ユーザーの答えが直すのは価格と上限だけなので、本文を変える根拠が無い。新しい `getAdjacentPublishedLooks`（`IMPL-LOOK-156`・`DD-LOOK-032`）で前後の 1 件ずつを `id`・`theme` だけ取る形に直し、並びを `created_at` の降順・`id` の降順にそろえた。詳細の頁が開くたびに最大 100 件の画像を署名し直す重さも無くなる。
2. **LOOK の削除が画像の道筋を読んでいない（Task 5）。** 今の DELETE の存在確認は `select('id,status')` で、`image_urls` が無いと消す道筋が分からない。`select` を広げることと、その単体の確かめを足した。
3. **NEWS の置き場の削除の client（Task 7）。** 計画は `removeNewsImages(supabase, …)` の client を決めていなかった。NEWS の route は DB を利用者の session（`createClient(request)`）で、上げるのを service role（`uploadSupabase`）で行う。session の client で消すと `storage.objects` の方針次第で断られ、方針を足す移行が要る。消すのは service role の client と決め、今は session の client しか作らない DELETE に service role を 1 つ足すこと、単体でどちらの模擬が `remove` を受けるかを確かめることを書いた。LOOK（Task 5）も同じ決まりを明記した（LOOK の route は既に service role）。
4. **`SEC-LOOK-019-AC-05` の数える範囲（Task 5）。** 元の案は頁全体でボタンを数え、「他の部品に同じ名前のボタンが無いことは AC-04 で確かめる」としていたが、AC-04 は印つきで赤のまま流れるので確かめにならない。LOOK の一覧の区画の中だけで数え、先に区画の中身が見えることを確かめる形にした。
5. **`SEC-SEARCH-018` の本文の求め（Task 2）。** 本文が「直した時に `DD-SEARCH-004`・`005`・`006` の上位にも足す」と書いているのに、計画の文書の手順に無かった。足した。
6. **`SEC-PRIVACY-011` の案と今の要件の合い方（Task 9）。** `AC-01` は「Stripe」「Resend」「Supabase」「Cloudflare Turnstile」の名前を求め、本文は「委託の一覧と 9 節に」と両方を書く。案 A（種類だけ）や「9 節だけ」を選ぶと要件の本文を変えることになるので、各選択肢の表にその列を置くことにした。「メールマガジン」を消すのは問いでなく要件（`AC-02`）が決めた前提と書いた。`.superpowers/` は丸ごと未追跡なので `git status` では自分の書き込みを見分けられない点も直した。
7. **P10 の根拠（Task 8）。** 同梱の Next.js の文書では、状態が 200 に決まるのは流し始めた（Suspense の代わりの表示が出た）後なので、`loading.tsx` も Suspense も無い `/privacy`・`/look`・`/news` は `error.tsx` を足しても 500 の見込み。根拠を P10 に書き、実装者が `loading.tsx` と頁の中の `<Suspense>` を足さないこと、`SEC-PRIVACY-009-AC-01` 自身も 500 を前提にしていること、案内を `main` の中に出すことを書いた（controller の実測は残す）。
8. **進める順。** 「列の間は並行」は、`home.md` 系（3・6・8）と `home-page-public-read.test.ts`（1・4・6）が列をまたいで重なり、各タスクの `tsc` が他のタスクの書きかけを拾うので、Task 9 を除いて直列だけにした。
9. 小さな足し: Task 4 の 101 件の E2E の見本の画像と説明文の入れ方（署名に失敗する道筋を 100 件入れない）、前後のリンクの確かめ、controller が見る `FR-LOOK-DETAIL-*`。Task 6 の `SEC-NEWS-020` の本文の「署名の client」の一文は 1-B で満たしている旨。

### 残した判断（controller に返す）

- `SEC-SEARCH-021` の「検索した語」の枠は、設計 R18 の「読み取り専用の入力欄」ではなく `<dl>` にしている。ユーザーの答え（「別の枠に『検索した語』として出す」）には合い、写真で確かめるので計画のままにした。
- `SEC-LOOK-019` の 2 回目の認可（P5）は設計 R16 の書き方と違う。範囲の中で取れる形として残し、`ADR-0161` に暫定と書く。
