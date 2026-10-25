# 波 1-A ログインの戻り先（SEC-AUTH-026 と open redirect の根治）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ログインの後の行き先を、サーバーに控えた「戻り先」だけで決める。会員だけの頁（`/account` ほか）をログインせずに開いた人と、ヘッダーのログインから入った人は、ログインの後に元の頁へ戻る。戻り先が無い・確かめに通らない時はホーム `/`。管理者・サポーターは先に 2 段目（TOTP、`/auth/verified`）を通し、その後で戻り先へ（戻り先が無ければ今どおり `/admin`）。URL に載る `next` / `redirect_to` で出口を決める作りをやめ、共有の `sanitizeRedirectPath` を新しい確かめの部品 1 つに置き換える。`/auth/callback` の画面は消す。

**Architecture:** 確かめの部品は純粋な 1 ファイル（`src/features/auth/return-intent/return-path.ts`）。入口（`/api/auth/login`・`/api/auth/oauth/start`・`/api/auth/register` の POST）で確かめを通った `next` だけを、`private.auth_return_intents`（sha256 のハッシュだけを持つ非公開の表）に控え、128 ビット以上の乱数の番号は HttpOnly の Cookie `sb-return-intent` にだけ置く。表は service_role 専用の `public` の SECURITY DEFINER 関数 2 本（作る・1 回で使い切る）だけで触る。Google の開始は `fetch` の `POST /api/auth/oauth/start`（JSON）で控えを作り、返った authorize の URL へ端末が移る（CSP の `form-action 'self'` があるので、フォームの POST から外へ 303 する形は使えない。下の P2）。出口は 2 種類。サーバーが 303 で移す所（Google の戻り・確認のメールのリンク）はその場で使い切る。端末が移す所（確認コードの確定・TOTP の確定）は新しい窓口 `POST /api/auth/post-login` が使い切って行き先を返す。出口でも役割と aal2 を含めて確かめ直す。管理者・サポーターは aal2 になるまで使い切らない。

**Tech Stack:** Next.js `^16`（App Router・Route Handler）、React `^19`、TypeScript、Supabase（Postgres・`@supabase/ssr`・`service_role`）、Zod、Jest（単体・結合）、React Testing Library、Playwright（書くだけ）。依存は増やさない。

**Spec:** [`.superpowers/sdd/2026-10-25-security-gap-fixes/wave1a-decisions.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/wave1a-decisions.md)（ユーザー承認 2026-10-25）。背景: 同ディレクトリの [`design-final.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md) R1、[`AUTH.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/AUTH.md) の SEC-AUTH-026 の節、[`supabase-mcp-refs.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/supabase-mcp-refs.md)。

---

## 概要

| 項目 | 内容 |
| --- | --- |
| 新しい要求・要件 | `SR-AUTH-008`（要求）、`FR-AUTH-005`（要件）と `FR-AUTH-005-AC-01`〜`07`、`SEC-AUTH-026` の更新と `-AC-01`〜`03`、`SEC-AUTH-032`（控えの扱い）と `-AC-01`〜`02`、脅威 `THR-AUTH-032` |
| 新しい設計 | `ARC-AUTH-010`、`STATE-AUTH-006`、`API-AUTH-019`、`DATA-AUTH-005`、`ADR-0412`、`DD-AUTH-032`〜`036`。既存の `FLOW-AUTH-001`〜`003`・`API-AUTH-001`・`005`〜`008`・`015`・`DATA-AUTH-004`・`DD-AUTH-005`・`014`・`017`〜`021`・`028` を更新。`SCR-AUTH-008` と `DD-AUTH-006` を廃止 |
| 新しいコード | `src/features/auth/return-intent/`（`return-path.ts`・`return-intent-store.ts`・`return-intent-service.ts`・`use-login-href.ts`）、`src/app/api/auth/post-login/route.ts`、移行 `supabase/migrations/20261025120000_auth_return_intents.sql` |
| 消すコード | `src/app/auth/callback/page.tsx` と、その単体・結合試験 2 本。`src/lib/redirect.ts` の `sanitizeRedirectPath` |
| 触る既存コード | `login`・`login/cancel`・`logout`・`register`・`confirm`・`oauth/start`・`oauth/callback` の各 route、`/login` 頁、`/auth/verified` 頁、`VerifyOtpClient`、`AuthTabs`・`LoginModal`・`RegisterModal`・`Header`、`LoginContext`、`/account` 系の 3 つのログイン門、`src/lib/cookie.ts`、2 つのスキーマ |
| タスク | 8 つ（文書の骨組み → 確かめの部品 → 移行と DB 試験 → 保存・開始・解決の部品 → 入口 → 出口 → 画面 → 消す・E2E・最終確認） |
| 流さないもの | E2E・サーバー・3000 番・DB 結合試験・`db reset`・本番適用（全部書くだけ。controller が流す） |

## 前提の読み（決定文の解釈。controller の確認を求める点を含む）

実装者はこの節を変えない。食い違いに気付いたら止めて報告する。

| # | 読み | 根拠・影響 |
| --- | --- | --- |
| P1 | 戻り先が無い時の既定は `/`（一般の会員）。今まで `/account` へ送っていた所（確認コードの確定・Google の戻り・確認のメールのリンク）も `/` に変わる | 決定 2「戻り先が無い・確かめに通らない時はホーム `/`」。`/account` を前提にした単体・E2E の期待を直す（Task 6・7 の一覧） |
| P2 | `POST /api/auth/oauth/start` を新設する。端末は `fetch`（`credentials:'same-origin'`、本文 JSON `{ provider, next? }`）で送り、窓口は 200 `{ url }`（Supabase の authorize の URL）と PKCE・控えの Set-Cookie を返す。端末は `navigateBrowser(url)` で移る。既存の `GET` は残すが、戻り先は一切作らず（`redirect_to` は読まない）、残っている控えの Cookie は消す | 決定 3「GET では作らない」。**フォームの POST から 303 で外へ移す案は採らない**: `src/proxy.ts` の CSP が `form-action 'self'` で、Chrome・Firefox はフォームの送信に続くリダイレクトの行き先にも `form-action` を当てるため、Supabase・Google への 303 が止められる（`proxy.ts` は触らない約束）。同じ origin の `fetch` の応答の Set-Cookie は端末に入り、本文はリダイレクトを含まないので `fetch` のリダイレクトの扱いも要らない。番号は Cookie だけで、本文の `url` に番号は載らない。Origin 検査（proxy）は `/api` の POST に既にかかっている（レビューで変更） |
| P3 | 控えの作成は、各入口の「成功した所」で行う。`/api/auth/login` は確認コードを送れた後（保留の Cookie を置く所）、`/api/auth/register` は Turnstile・漏洩の確かめの後で既存会員の照会の前、`/api/auth/oauth/start` は Google の URL を作れた後 | パスワードの誤りやボットで表の行を増やさない。登録は 202 の 3 つの枝（新規・登録済み・重複の例外）で Set-Cookie まで同じ形にするため、照会の前に作る |
| P4 | 確認のメールのリンクを、控えの Cookie を持たない端末（別のブラウザ）で開いた時は、この波では戻り先を使わず既定 `/` へ送る。セッションの発行は今のまま（`SEC-AUTH-007` の「`/login` へ送り、セッションを作らない」は別の波） | **決定の文面（「別のブラウザ…は戻り先を使わず /login へ」）とずれる**。この波では「戻り先を使わず」だけを満たす。理由: 今は別のブラウザでもセッションが作られるので、ログイン済みの人を `/login` へ送ると資格情報のフォームが出て混乱する。また控えの Cookie が無いことは「別のブラウザ」と「同じブラウザで `next` 無しに登録した」を区別できない（区別は `SEC-AUTH-007` の結び付けの Cookie が要る）。`/login` へ切り替える所は `SEC-AUTH-007` の作業に残す（`FR-SIGNUP-003` の `test.fail` はそのまま）。**controller は Task 6 の着手前にこの読みをユーザーに確かめる**（違えば Task 6 の confirm の仕様だけを直す） |
| P5 | 確認のメールのリンクの失敗（トークン欠落・検証失敗・例外）は、固定の `/login` へ送る。URL の値は読まない | 今は `redirect_to`（既定 `/account`）へ送っている。入力に依存する行き先をやめるので固定にする。ログイン前の失敗なので `/login` が自然 |
| P6 | `Max-Age`・DB の期限は login 15 分、signup 1 時間。DB の関数が期限を決め、`Max-Age` は関数の戻り値（秒）をそのまま使う | 決定 3 の「Max-Age は期限と同じ」 |
| P7 | 使う時に戻り先の用途（`purpose`）を合わせる。ログイン系の出口は `login` だけ、確認のリンクは `signup` だけを使い切る | 登録の控えが後のログインに使われる・その逆を防ぐ |
| P8 | Google のログインは `purpose = 'login'`（新規作成も含む）。`oauth/callback` の URL から `next` を外す | 番号も道筋も URL に載せない（決定 3）。Supabase の許可する戻り先の一致も短くなる |
| P9 | 「会員だけの頁」でログインの門を持つのは `/account`・`/account/orders/[id]`・`/account/orders/[id]/return` の 3 つ。`/wishlist`・`/cart`・`/checkout` はゲストでも開けて門が無いので、ヘッダーのログインから入った時の戻り先の許可リストにだけ載る | コードで確認済み（`src/app/wishlist`・`checkout`・`cart` に `/login` へのリンクが無い） |
| P10 | `/admin` は入口（控える時）では許し、出口で「役割が admin / supporter かつ aal2」の時だけ許す。それ以外は既定へ | 決定 4 |

## Global Constraints

- 並行作業: 別セッション（G-3 発送）が同じ作業ツリーの別ファイルを編集し、コミットの時に全体の `tsc` を通す。**`git add`・`git commit`・`git stash`・`git checkout`・`git reset`・`git restore` は実行しない**（controller がタスクごとにコミットする）。コミットは作らない。
- **E2E・サーバー起動・3000 番・DB 結合試験・`db reset`・`supabase` の起動は実行しない**。E2E と DB 試験は書くだけ。DB 結合試験は `DATABASE_URL` が無ければ skip される作りなので、単体の `jest` を流しても落ちない。
- `.ts` / `.tsx` を 1 つ編集するたびに `npx tsc --noEmit` を流し、自分の誤りをその場で直す。他者の誤りが出たら触らず、報告に書く。
- 着手前に `git status --short` で G-3 の変更中のファイルを確認し、**重ならないようにする**。G-3 が変更中の文書は編集しない: `docs/03_BasicDesign/ui/screen-flow.md`・`screen-list.md`・`docs/03_BasicDesign/api/api-spec.md`・`route-inventory.md`・`docs/03_BasicDesign/data/er.md`・`docs/02_Requirements/requirements.md`・`docs/05_Quality/tests/test-spec.md`。範囲内の領域（AUTH）は `docs/02_Requirements/areas/auth.md` などの領域の文書に書く決まりなので、そもそもこれらには書き足さない。`docs/06_Operations/db-migrations.md` も G-3 が変更中（`git status --short` で変更の印が付いている）なので**この波の実装者は編集しない**。同じファイルに 2 つのセッションの差分が乗ると、G-3 のコミットに波 1-A の節が混ざる。節の本文は Task 3 の報告に全文で返し、controller が G-3 のコミットの後に `## ベースライン化（初回のみ・要 Docker と DB パスワード）` の見出しの直前へ挿入して、波 1-A の移行と同じコミットに入れる（レビューで変更）。
- 触らない: `src/lib/mail.ts`、`src/proxy.ts`、`src/features/auth/middleware/rateLimit.ts`（呼ぶだけ）、`src/lib/auth/authenticate.ts`・`admin-rbac.ts`（呼ぶだけ）、G の表・関数、`supabase/migrations/` の既存ファイル（特に G-3 の `20261025100130_…`）、`tests/integration/db/helpers/group-g-allowlist.ts`。
- 文書: 日本語。`documentation-guide`（`.claude/skills/documentation-guide/SKILL.md`）の項目の形（見出し直後の属性表）・ID の体系・TSDoc（`@packageDocumentation`・`@impl`・`@design`・`@remarks` に「なぜ」だけ）・テスト名の先頭に ID を守る。文書の冒頭の確認日は 2026-10-25 にする。絵文字は使わない。
- 範囲（`scripts/trace/scope.json` の AUTH）に入っていない新ファイルは、`@impl`・`@design` を検査されない。**Task 1 で範囲に足す**（下の「scope.json」）。共有部品（`src/lib/cookie.ts`・`src/lib/redirect.ts`）にはコメントを足さない。
- 番号は**書く直前に再確認**する（他の波が取る可能性）: `grep -on "SR-AUTH-[0-9]*" docs/02_Requirements/areas/auth.md`、`FR-AUTH-`・`SEC-AUTH-`・`THR-AUTH-`・`ARC-AUTH-`・`STATE-AUTH-`・`API-AUTH-`・`DATA-AUTH-` の最大、`ls docs/03_BasicDesign/decisions | grep ADR-04[0-4]`、`grep -rhon "IMPL-AUTH-[0-9]*" src | sort -u | tail -3`、`grep -on "DD-AUTH-[0-9]*" docs/04_DetailDesign/pages/14_login.md | tail -2`、`ls e2e | grep FR-LOGIN | tail -2`、`ls supabase/migrations | tail -2`。下の割当と違えば、全部ずらして一貫させる。
- 入力は信用しない: 戻り先の値・Cookie の番号・フォームの項目はすべて確かめる。ログ・監査・エラーに、戻り先の道筋・番号・メールを残さない。残してよいのは理由の符号（`rejected_reason`）だけ。
- 実装は最小。決定にない設定項目・管理画面・追加の API は作らない。

### ID の割当（Task 1 で文書に起こし、以降のタスクのコードが指す）

| 種類 | ID | 題 |
| --- | --- | --- |
| 要求 | `SR-AUTH-008` | ログインの後に、会員だけの頁またはログインを始めた頁へ戻れる |
| 要件 | `FR-AUTH-005` | ログインの後の行き先は、サーバーに控えた内部の頁だけにする |
| 受け入れ条件 | `FR-AUTH-005-AC-01`〜`07` | 01 ヘッダーのログインから入ると、開いていた頁（検索条件付き）へ戻る／02 `/account` を未ログインで開いてログインすると `/account` へ戻る／03 戻り先が無いと `/`／04 外の住所・不正な値は `/`／05 管理者は先に 2 段目を通してから戻り先へ（戻り先が無ければ `/admin`）／06 `/login`・`/api/*` などへの戻り先は `/`／07 使った戻り先は 2 回目に使えない |
| セキュリティ要件 | `SEC-AUTH-026`（更新） | ログインの後の送り先は、内部の道だけにする（`-AC-01` `/auth/callback` の画面が無い（404）／`-AC-02` 確認のリンクの `redirect_to` で外へ出ない／`-AC-03` ログインの窓口へ外の `next` を送っても `/` に着く） |
| 脅威 | `THR-AUTH-032` | 戻り先の控えの番号の盗み・使い回し・総当たり |
| セキュリティ要件 | `SEC-AUTH-032` | 戻り先の控えは、番号だけを HttpOnly の Cookie に持ち、表には番号のハッシュだけを持つ（`-AC-01` Cookie の属性と、番号が URL・応答の本文・Location に出ない／`-AC-02` ログアウトで Cookie が消える） |
| 構造設計 | `ARC-AUTH-010` | 戻り先は入口で控え、出口で使い切り、出口でも確かめ直す |
| 構造設計 | `STATE-AUTH-006` | 戻り先の控えは、作られ、使い切られるか期限で消える |
| 構造設計 | `API-AUTH-019` | `POST /api/auth/post-login` は戻り先を使い切って行き先を返す |
| 構造設計 | `DATA-AUTH-005` | `private.auth_return_intents` の表と、作る・使い切る 2 本の関数 |
| 設計判断 | `ADR-0412` | 戻り先はサーバーに控え、番号だけを HttpOnly の Cookie で渡す |
| 詳細設計 | `DD-AUTH-032`〜`036` | 032 戻り先の確かめ（`return-path.ts`）／033 控えの保存（`return-intent-store.ts`）／034 控えの開始と解決（`return-intent-service.ts`）／035 ログイン後の行き先の窓口（`post-login/route.ts`）／036 ログインの入口の URL を作る（`use-login-href.ts`） |
| 実装 | `IMPL-AUTH-206`〜`210` | 206 `return-path.ts`／207 `return-intent-store.ts`／208 `return-intent-service.ts`／209 `post-login/route.ts`／210 `use-login-href.ts` |
| E2E | `e2e/FR-LOGIN-038-login-return-to.spec.ts` | 3 つの幅（390・768・1280） |
| 移行 | `supabase/migrations/20261025120000_auth_return_intents.sql` | 時刻は `ls supabase/migrations` の最新（今は `20261025100130`）より後。G-3 が新しい移行を足していたら、それより後に付け直す |

### scope.json（Task 1 で足す）

`scripts/trace/scope.json` の `"area": "AUTH"` の次の欄に足す（既存の並びは変えない）。

| 欄 | 足す型 |
| --- | --- |
| `src` | `"src/features/auth/return-intent/**/*.ts"` |
| `tests` | `"tests/unit/features/auth/return-intent/**/*.test.{ts,tsx}"`、`"tests/unit/migrations/auth-return-intents*.test.ts"`（`tests/integration/ui/auth-*.test.{ts,tsx}` は既にある） |

DB 試験 `tests/integration/db/auth_return_intents.integration.test.ts` は既存の型 `auth_*.integration.test.ts` に合う。結合試験 `tests/integration/api/auth/*.test.ts` も既存の型に合う。

---

## Review Focus（最も踏みやすい失敗 5 つ）

レビュアーと実装者は、各タスクの前後でこの 5 つを具体的な入力で確かめる。

1. **確かめの部品の抜け（パーサーの食い違い）。** タブ・改行（`/%09/evil.example`、`/\t/evil.example`）、`\`、`%5C`、`%2F%2F`、1 回デコードした後の再検査、`/.//evil`・`/a/..//evil`・`/item/%2e%2e/api/x` のように**解釈した後の道筋が変わる**物、`pathname` の接頭辞の境界（`/itemx`・`/Item`）、`/admin` を役割と aal2 抜きで通す物、`%` のデコード失敗、512 文字超、`new URL` に渡す基準の origin。入口でも出口でも**同じ関数**を使うこと、返すのは**解釈し直した `pathname + search` だけ**で fragment を捨てること、`sanitizeRedirectPath` の呼び出しが 1 つも残らないこと（confirm・oauth start・oauth callback・register の 4 つ）。grep は `graphify-out` の写しにも当たるので、確かめは常に `grep -rn --include='*.ts' --include='*.tsx' --exclude-dir=graphify-out "<語>" src tests e2e` で行う。
2. **使い切る時機と状態の取り違え。** 管理者・サポーターを aal1 のうちに使い切ると、TOTP の後の戻り先が消える。確認コードの確定で永続化が失敗した時（500）に使い切ると戻り先だけが焼ける。2 回呼ばれて 2 回目に前の戻り先が出る（`UPDATE … WHERE consumed_at IS NULL RETURNING` が 1 回で使い切ること）。**戻り先の無いログインの試みで、前の試みの古い Cookie が残って使われる**（入口は `next` が無い・不正でも必ず Cookie を消す）。`purpose` の取り違え。`SameSite=Strict` にすると Google と確認のメールの戻り（別サイトからの移動）で Cookie が付かない（`Lax` が必須）。`Secure` は本番だけ。
3. **会員登録の応答の同一性（列挙対策）。** `register` の 202 は新規・登録済み・重複の例外の 3 つの枝で、本文・状態・Set-Cookie の形まで同じにする。控えの作成を既存会員の照会より**後**に置くと、枝ごとに Cookie の有無が変わり存在が分かる。控えの作成に失敗しても応答の形を変えない（Cookie は消す側へ倒す）。
4. **移行の権限（`public` に作った関数は既定で anon・authenticated に EXECUTE が付く）。** 新しい関数 2 本は、同じ移行の中で `REVOKE ALL … FROM PUBLIC, anon, authenticated` してから `GRANT EXECUTE … TO service_role`。`SECURITY DEFINER` + `SET search_path = ''`、本文の表・関数は `pg_catalog.`・`private.` で修飾。表は `ENABLE ROW LEVEL SECURITY`、`REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`（関数だけで触る）。cron の登録（`create extension if not exists pg_cron`）の自己付与を写さない（`20260911235714_…` の注意）。時刻が G-3 より前だと適用順が崩れる。
5. **既存の期待が大量に壊れる（影響の大きさ）。** 既定が `/account` → `/`（確認コード・Google・確認のリンク）、`oauth/start` が GET の 302 のまま（E2E `FR-LOGIN-002` が 302 を期待）→ POST の 200 `{ url }` が主、`redirect_to` / `next` を読む単体・結合試験、`sanitizeRedirectPath` をモックする試験、`/auth/callback` を指す文書と試験、`VerifyOtpClient`・`/auth/verified` 頁が `/api/auth/me` で行き先を決めている試験。**各タスクで `tsc` と対象の `jest` を流し、壊れた期待を同じタスクで直す**（次のタスクに先送りしない。G-3 のコミット時の全体 `tsc` を落とさない）。

---

## ファイルの全体像

| 区分 | ファイル | 操作 | タスク |
| --- | --- | --- | --- |
| 文書 | `docs/02_Requirements/areas/auth.md`、`docs/05_Quality/security/threats/auth.md`、`docs/03_BasicDesign/areas/auth.md`、`docs/03_BasicDesign/decisions/ADR-0412-return-intent-server-side-cookie-id.md`、`docs/04_DetailDesign/pages/14_login.md`、`docs/04_DetailDesign/sequence/auth-*.md`、`scripts/trace/scope.json`、台帳（`docs/06_Operations/db-migrations.md` は G-3 の後に controller が当てる。本文は Task 3 の報告） | 追記・更新 | 1・3・8 |
| 部品 | `src/features/auth/return-intent/return-path.ts` | 新規 | 2 |
| 部品 | `src/features/auth/return-intent/return-intent-store.ts`、`return-intent-service.ts` | 新規 | 4 |
| 部品 | `src/features/auth/return-intent/use-login-href.ts` | 新規 | 7 |
| 共有 | `src/lib/redirect.ts`（`sanitizeRedirectPath` を削除）、`src/lib/cookie.ts`（名前と属性を足す）。`src/lib/browser-location.ts` は触らない（既存の `navigateBrowser` を使う） | 変更 | 2・4 |
| 移行 | `supabase/migrations/20261025120000_auth_return_intents.sql`、`tests/unit/migrations/auth-return-intents.test.ts`（移行の文面の単体試験。DB なしで流せる） | 新規 | 3 |
| route | `login`・`login/cancel`・`logout`・`register`・`oauth/start` | 変更 | 5 |
| route | `post-login`（新規）・`confirm`・`oauth/callback` | 新規・変更 | 6 |
| スキーマ | `src/features/auth/schemas/login.ts`・`register.ts` | 変更 | 5 |
| 画面 | `src/app/login/page.tsx`、`AuthTabs.tsx`、`LoginModal.tsx`、`RegisterModal.tsx`、`Header.tsx`、`src/contexts/LoginContext.tsx`、`src/app/login/verify/VerifyOtpClient.tsx`、`src/app/auth/verified/page.tsx`、`src/app/account/page.tsx`、`src/app/account/orders/[id]/page.tsx`、`src/app/account/orders/[id]/return/page.tsx` | 変更 | 6・7 |
| 削除 | `src/app/auth/callback/page.tsx`、`tests/unit/app/auth/auth-callback-page.test.tsx`、`tests/integration/ui/auth-callback-screen.test.tsx` | 削除 | 8 |
| 試験 | 各タスクに書く | 新規・更新 | 全部 |
| E2E | `e2e/FR-LOGIN-038-login-return-to.spec.ts`（新規）、`e2e/FR-LOGIN-030-session-cookies-and-responses.spec.ts`（反転）、`e2e/FR-LOGIN-002-google-oauth.spec.ts`・`FR-SIGNUP-003-signup-confirm-link.spec.ts` ほか | 新規・更新 | 8 |

---

## Task 1: 文書の骨組みと範囲（番号を先に決める）

**Why first:** 以降のコードの `@design` が指す `DD-` と、試験名の先頭の ID が、先に文書に無いと `validate-trace` が `bad-design-link`・`unknown-test-id` で落ちる。この段階ではコードより先に「設計」を書く。廃止にする項目（`SCR-AUTH-008`・`DD-AUTH-006`）は、コードを消す Task 8 まで廃止にしない。

**Files:**
- Modify: `scripts/trace/scope.json`
- Modify: `docs/02_Requirements/areas/auth.md`
- Modify: `docs/05_Quality/security/threats/auth.md`
- Modify: `docs/03_BasicDesign/areas/auth.md`
- Create: `docs/03_BasicDesign/decisions/ADR-0412-return-intent-server-side-cookie-id.md`
- Modify: `docs/04_DetailDesign/pages/14_login.md`
- Modify: `docs/04_DetailDesign/sequence/auth-login-mfa.md`・`auth-oauth.md`・`auth-registration.md`（戻り先の流れを足す Mermaid の追記だけ）

**Interfaces（文書の項目。見出しの形は `documentation-guide` の 7）:**

- [ ] **Step 1: 番号の再確認。** Global Constraints の grep を流し、ID の割当表と一致するか確かめる。違えば全部ずらす。
- [ ] **Step 2: `scope.json` に「scope.json（Task 1 で足す）」の型を足す。** `npx tsx scripts/trace/validate.ts --list-unmatched` ではなく `npm run validate-trace -- AUTH` で JSON の形が壊れていないことを確かめる。
- [ ] **Step 3: 要求・要件・受け入れ条件・セキュリティ要件を `docs/02_Requirements/areas/auth.md` に書く（`requirements.md` には書かない）。**
  - 「要求」節に `### SR-AUTH-008 …`（属性: 根拠・状態 `推定`・出どころ「ユーザーの発言 2026-10-25（wave1a-decisions.md）」）。
  - 「要件」節に `### FR-AUTH-005 …`（上位 `SR-AUTH-008`、優先度 `MUST`）。「受け入れ条件」節に `FR-AUTH-005-AC-01`〜`07`。各 AC の本文は検証できる形で、上の割当表の 01〜07 のとおり。AC-01 は「`/stockist?from=e2e` のような検索条件付きの公開頁でヘッダーのログインを押し、ログインを終えると同じ道筋と検索条件に着き、fragment は付かない」、AC-04 は「`next=//evil.example`・`/%09/evil.example` を付けたログインは `/` に着き、店のサイトの外へ出ない」、AC-07 は「`POST /api/auth/post-login` を続けて 2 回呼ぶと 2 回目は `/` を返す」と書く。
  - `SEC-AUTH-026`（既存の節）を書き換える: 「根拠」から「サーバーの側は…満たす」を削り、「`/auth/callback` の画面と共有関数 `sanitizeRedirectPath` の両方に穴があった（タブ・改行）。画面は消し、共有関数は戻り先の確かめの部品に置き換えた」と書く。本文の「`/auth/callback` の画面は満たさない」を直す。`SEC-AUTH-026-AC-01` は「`/auth/callback?next=//evil.example` を開くと 404 になり、店のサイトの外へ出ない」に書き換える。`-AC-02`（`GET /api/auth/confirm?redirect_to=%2F%09%2Fevil.example` が店のサイトの外へ 303 しない）と `-AC-03`（ログインの窓口へ外の `next` を送っても `/` に着く）を足す。
  - `SEC-AUTH-032`（上位 `THR-AUTH-032`、ASVS V3.2 / V5.1.5 / V8.3）と `SEC-AUTH-032-AC-01`・`-AC-02` を足す。
- [ ] **Step 4: 脅威を `docs/05_Quality/security/threats/auth.md` に書く。** `THR-AUTH-026` の「起こり方」「対策」を更新（画面の穴＋共有関数の穴＋対策に `SEC-AUTH-026`・`SEC-AUTH-032`）。`THR-AUTH-032` を新規（守るもの: ログイン直後の行き先とその控え／脅威: 他人の控えの番号を盗む・総当たり・別の端末で使う・使い回し／対策: 128 ビットの乱数・HttpOnly・SameSite=Lax・ハッシュだけを表に・1 回で使い切る・短い期限）。
- [ ] **Step 5: 構造設計を `docs/03_BasicDesign/areas/auth.md` に書く。** 新規: `ARC-AUTH-010`、`STATE-AUTH-006`（Mermaid の `stateDiagram-v2`: 作られた → 使い切られた／期限切れ）、`API-AUTH-019`、`DATA-AUTH-005`（列・制約・2 本の関数・権限・cron）。更新: `FLOW-AUTH-001`（確認コードの確定の後に `post-login`、管理者は `/auth/verified` → TOTP → `post-login`）、`FLOW-AUTH-002`（Google は `fetch` の POST で始めて返った URL へ移り、戻りは窓口が使い切る。一般は戻り先か `/`、管理者は `/auth/verified`）、`FLOW-AUTH-003`（登録の送信で控え、確認のリンクを同じ端末で開くと戻り先か `/`）、`API-AUTH-001`（`next` を受け、成功時に控えて Cookie を置く）、`API-AUTH-004`（取消で控えの Cookie も消す）、`API-AUTH-005`（`next` を受け、3 つの 202 で同じ形の Cookie）、`API-AUTH-006`（`redirect_to` を読まない・失敗は固定の `/login`）、`API-AUTH-007`（`GET` は 302 で控えを作らない、`POST` は JSON を受けて 200 `{ url }`。CSP の `form-action` の理由を書く）、`API-AUTH-008`（`next` を読まない・戻り先は控えから）、`API-AUTH-015`（Cookie を消す）、`DATA-AUTH-004`（Cookie に `sb-return-intent` を足す）、`SCR-AUTH-007`（`post-login` を呼ぶ）、`SCR-AUTH-001`（`/login?next=` を受ける）。`SCR-AUTH-008`（`/auth/callback`）は**まだ廃止にしない**（本文に「Task 8 で消す」と書かない。コードが残るので）。427・502・847・869・889 行付近の「`next` は `/` で始まるかだけを見る」などの古い記述を直す。各項目の「上位」は要件・`SEC-`・`DRV-` を必ず 1 つ入れる。
- [ ] **Step 6: ADR を書く。** `ADR-0412`（`documentation-guide` の 12 の型）。決定: サーバーに控え、番号だけを HttpOnly の Cookie で渡す。退けた案は表で書く: (a) URL の `next` をそのまま使う（OWASP「行き先を入力に使わない」、Shopify の `return_to` は相対だけ。ただし値そのものが URL に載り、確認のメールや Referer を経て改ざん・流出する）、(b) 署名つきの戻り先を Cookie にだけ持つ（サーバーの失効・1 回限りを作れない。鍵の用途を増やす: `SEC-AUTH-027`）、(c) 署名つきの戻り先を URL に載せる（URL に載る）。比較表（今の私たち／Shopify／OWASP／結論）を「背景」に付ける。出典: OWASP Unvalidated Redirects and Forwards Cheat Sheet、Supabase `securing-your-api`（`supabase-mcp-refs.md` §2・§4）。上位に `FR-AUTH-005`・`SEC-AUTH-026`・`SEC-AUTH-032` を書く。
- [ ] **Step 7: 詳細設計を `docs/04_DetailDesign/pages/14_login.md` に書く。** 新規: `DD-AUTH-032`〜`036`（入出力・正常・異常・認可・永続化・試験の観点）。更新: `DD-AUTH-005`（`/auth/verified`）、`014`（login）、`017`（cancel）、`018`（register）、`019`（confirm）、`020`（oauth start）、`021`（oauth callback）、`028`（logout）。概要の表（`DD-AUTH-001`〜`031` と書いた所）を `〜036` に直す。`DD-AUTH-006` は残す。
- [ ] **Step 8: 順序図を直す。** `auth-login-mfa.md`・`auth-oauth.md`・`auth-registration.md` に戻り先の控え・使い切りを Mermaid の `sequenceDiagram` で足す。`/auth/callback` の記述は Task 8 で消すのでここでは触らない。
- [ ] **Step 9: 確かめ。** `npm run validate-docs`（リンク・Markdown・Mermaid）。`npm run validate-trace -- AUTH` は、**この時点では新しい `DD-`・`SEC-`・`AC` の下位（コード・試験）が無い**ので `missing-child` が増える。増えた件数を控え、Task 8 の最終確認で 0 件増（基準 `scripts/trace/baseline.json` と同じ）になることを確かめる。ここで `--update-baseline` はしない。
- [ ] **Step 10: 報告。** 書いた ID の一覧と、確認日・基準コミットを書き換えた箇所を返す。コミットは作らない。

**検証コマンド:** `npm run validate-docs`、`npx tsc --noEmit`（コードは触らないが、全体が緑のままか確かめる）。

---

## Task 2: 戻り先の確かめの部品と `sanitizeRedirectPath` の置き換え

**Files:**
- Create: `src/features/auth/return-intent/return-path.ts`
- Create: `tests/unit/features/auth/return-intent/return-path.test.ts`
- Modify: `src/lib/redirect.ts`（`sanitizeRedirectPath` を削除。他は触らない）
- Modify: `src/app/api/auth/confirm/route.ts`・`oauth/start/route.ts`・`oauth/callback/route.ts`・`register/route.ts`（import と呼び出しだけ。この段階では URL / body の値を読む作りを残し、新しい部品に差し替えて**穴を先に塞ぐ**）
- Modify: `tests/unit/api/auth/confirm-route.test.ts`・`register-route.test.ts`（`sanitizeRedirectPath` を使う・モックする所を直す）、`tests/integration/api/auth/confirm.test.ts`・`oauth-callback.test.ts`・`oauth-start.test.ts`・`register.test.ts` ほか該当する物

**Interfaces（`return-path.ts`。名前・形はこのとおり。サーバー専用の import をしない。クライアントからも使う）:**

```ts
/**
 * 戻り先の確かめ（src/features/auth/return-intent/return-path.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-206
 * @design DD-AUTH-032
 * @remarks ログインの後の行き先は入口と出口の両方でこの 1 つの関数を通す。文字の頭を見る確かめは URL パーサーとの食い違い
 * （タブ・改行の除去、円記号の読み替え、`..` の解決）で抜けるので、解釈した結果の道筋で許可リストと比べる。
 */
export const RETURN_PATH_MAX_LENGTH = 512;

export type ReturnPathRejectReason =
  | 'empty'                 // 文字列でない・空
  | 'too_long'              // 512 文字を超える（解釈後の長さも）
  | 'forbidden_char'        // 空白・制御文字・書式文字（\p{Cc}\p{Cf}\s）・円記号（デコード前もデコード後も）
  | 'decode_failed'         // % のデコードに失敗
  | 'not_relative'          // 「/」で始まらない、または 2 文字目が「/」か「\」
  | 'origin_mismatch'       // 解釈した origin がサイトの origin と違う
  | 'userinfo'              // userinfo を含む
  | 'excluded_path'         // /login /register /auth/* /api/*
  | 'not_allowed_path'      // 許可リストの先頭の道筋に当たらない
  | 'resolved_not_local'    // 解釈後の道筋が「//」「/\」で始まる、または再解釈で origin が変わる
  | 'admin_requires_privileged_aal2'; // 出口で /admin を役割と aal2 抜きで通そうとした

export type ReturnViewer = {
  role: 'admin' | 'supporter' | 'user';
  aal: string | null; // 'aal2' のときだけ管理者・サポーターに /admin を許す
};

export type ValidateReturnPathOptions = {
  /** 解釈の基準の origin。省略時は getSiteUrl()（環境変数）の origin。要求の見出しは使わない。ブラウザは window.location.origin を渡してよい */
  origin?: string;
  /** 出口の確かめで渡す。渡さない（入口）と /admin は許す */
  viewer?: ReturnViewer;
};

export type ValidateReturnPathResult =
  | { ok: true; path: string }  // 解釈し直した pathname + search。fragment は捨てる
  | { ok: false; reason: ReturnPathRejectReason };

export function validateReturnPath(raw: unknown, options?: ValidateReturnPathOptions): ValidateReturnPathResult;

/** 外れたら fallback（既定 '/'）を返す。fallback は確かめない（/auth/verified などを渡してよい） */
export function sanitizeReturnPath(raw: unknown, fallback?: string, options?: ValidateReturnPathOptions): string;

export function isPrivilegedRole(role: unknown): role is 'admin' | 'supporter';
```

**手順（`validateReturnPath` の中身。順番が要点）:**

1. `typeof raw !== 'string'` または空 → `empty`。長さ > 512 → `too_long`。
2. `forbidden_char`: `/[\s\\]|\p{Cc}|\p{Cf}/u` に当たる（トリミングはしない。前後の空白もここで断る）。
3. 1 回デコード: `decodeURIComponent(raw)`。例外 → `decode_failed`。デコード後の文字列にも 2 と 3 の検査（長さ・`forbidden_char`・次の「`/` で始まり 2 文字目が `/` でも `\` でもない」）をもう一度かける。
4. `not_relative`: `raw` が `/` で始まらない、または 2 文字目が `/`・`\`。
5. `new URL(raw, origin)`（`origin` は `options.origin ?? new URL(getSiteUrl()).origin`。失敗 → `origin_mismatch`）。`url.origin !== origin` → `origin_mismatch`。`url.username || url.password` → `userinfo`。
6. `out = url.pathname + url.search`。`out` が `//` か `/\` で始まる → `resolved_not_local`。`out.length > 512` → `too_long`。`new URL(out, origin).origin !== origin` → `resolved_not_local`。
7. 除外（`url.pathname` が `/login`・`/register`・`/auth`・`/api` と一致または `<接頭辞>/…`）→ `excluded_path`。許可リスト（公開: `/`〔完全一致〕・`/item`・`/look`・`/news`・`/stockist`・`/about`・`/search`・`/privacy`・`/contact`、会員: `/account`・`/wishlist`・`/cart`・`/checkout`、管理: `/admin`）に当たらない → `not_allowed_path`。接頭辞の比べ方は「完全一致か `接頭辞 + '/'` で始まる」（`/itemx` は当たらない。大文字小文字は区別する）。
8. `/admin`: `options.viewer` があり、`isPrivilegedRole(viewer.role) && viewer.aal === 'aal2'` でなければ `admin_requires_privileged_aal2`。`viewer` が無い（入口）なら通す。
9. `{ ok: true, path: out }`。

- [ ] **Step 1（RED）: 単体試験を書く。** `tests/unit/features/auth/return-intent/return-path.test.ts`（1 行目 `/** @jest-environment node */` は付けず、別に `return-path.client.test.ts` を `@jest-environment jsdom` で 1 件だけ書き、ブラウザの環境で import できて `origin: window.location.origin` で動くことを確かめる）。試験名の先頭は `DD-AUTH-032 `。origin は `options.origin = 'http://localhost:3000'` を渡す（環境変数に依存しない）。別の 1 件で `NEXT_PUBLIC_SITE_URL = 'https://shop.example'` を設定して省略時の origin が環境変数の origin になることを確かめる。**値と期待（`ok` / `reason`）の確かめ表:**

| 入力 | 期待 |
| --- | --- |
| `//evil.example` | `ok:false` `not_relative` |
| `/\evil.example`（文字列 `'/\\evil.example'`） | `ok:false` `forbidden_char` |
| `/%2F%2Fevil.example` | `ok:false` `not_relative`（デコード後 `///evil…` の 2 文字目） |
| `/%5Cevil.example` | `ok:false` `forbidden_char` |
| `/%09/evil.example` | `ok:false` `forbidden_char` |
| `'/\t/evil.example'`（実際のタブ）、`'/\n/evil.example'`、`'/\r/evil.example'` | `ok:false` `forbidden_char` |
| `https:evil.example`、`javascript:alert(1)`、`data:text/html,x`、`evil.example`、`''`、`'/ '` | `ok:false`（`not_relative`・`empty`・`forbidden_char`） |
| `/@evil.example`、`/item@evil.example` | `ok:false` `not_allowed_path`（`/@evil.example`）／`/item@evil.example` も `not_allowed_path` |
| `'/item/' + 'a'.repeat(600)` | `ok:false` `too_long` |
| `/login`、`/login?next=/account`、`/login/verify`、`/register`、`/auth/verified`、`/auth/callback`、`/auth/password-reset`、`/api/x`、`/api`、`/api/auth/me` | `ok:false` `excluded_path` |
| `/admin`、`/admin/orders`（入口＝viewer なし） | `ok:true` |
| 同じ `/admin`（出口）: viewer `{role:'user',aal:'aal1'}`、`{role:'user',aal:'aal2'}`、`{role:'admin',aal:'aal1'}`、`{role:'supporter',aal:null}` | 全部 `ok:false` `admin_requires_privileged_aal2` |
| 同じ `/admin`（出口）: `{role:'admin',aal:'aal2'}`、`{role:'supporter',aal:'aal2'}` | `ok:true` `path:'/admin'` |
| `/unknown`、`/itemx`、`/Item/3`、`/items/3`、`/foo/bar` | `ok:false` `not_allowed_path` |
| `/item/3?color=red#x` | `ok:true` `path:'/item/3?color=red'`（fragment を捨てる） |
| `/`、`/?a=1`、`/item`、`/search?q=a%2Fb`、`/account`、`/account/orders/abc/return`、`/wishlist`、`/cart`、`/checkout`、`/contact?topic=x` | `ok:true`（返す値は入力と同じ形） |
| `/item/日本語?q=あ` | `ok:true` `path:'/item/%E6%97%A5%E6%9C%AC%E8%AA%9E?q=%E3%81%82'`（解釈し直した形） |
| `/item/%252F%252Fevil` | `ok:true`（二重のエンコードは 1 回のデコード後も無害。道筋の中身が `%2F%2Fevil` のまま返る） |
| `/.//evil.example`、`/%2e//evil.example`、`/a/..//evil.example`、`/..//evil.example`、`/item/..//evil.example` | `ok:false`（`not_allowed_path` か `resolved_not_local`。どちらでもよいが `ok` は必ず `false`） |
| `/item/%2e%2e/api/x`、`/item/../api/x` | `ok:false` `excluded_path` |
| `/item/../admin`（入口）／出口で一般の会員 | `ok:true path:'/admin'` ／ `ok:false admin_requires_privileged_aal2` |
| `/item/%`、`/item/%E0%A4%A` | `ok:false` `decode_failed` |
| `' /item'`、`'/item '`、`/item/‮`、`/item/​`（書式文字） | `ok:false` `forbidden_char` |
| `null`、`undefined`、`123`、`{}`、`['/item']` | `ok:false` `empty` |
| `/search?q=black+coat` | `ok:true` `path:'/search?q=black+coat'`（`+` は空白の文字ではないので通る。`URLSearchParams` が作る形） |
| `/search?q=black%20coat`、`/item/%E3%80%80` | `ok:false` `forbidden_char`（決定の「デコードの後も同じ検査」により空白へ戻る値は断る。既定 `/` へ倒れるのは決定どおりの挙動として受け入れる。レビューで追加） |

  追加の試験: ①`sanitizeReturnPath('//evil.example')` は `'/'`、`sanitizeReturnPath('//evil.example', '/auth/verified')` は `'/auth/verified'`（fallback は確かめない）。②`isPrivilegedRole` は `'admin'`・`'supporter'` だけ真。③**不変条件**: 上の `ok:true` の全入力について、返す `path` を `new URL(path, 'http://localhost:3000')` で解釈すると origin が同じで、`path` が `//` と `/\` で始まらず、`#` を含まない。④`validateReturnPath` は例外を投げない（上の全入力と 1000 個のランダムな文字列〔制御文字・`%`・`/`・`\` を多めに混ぜる、固定の seed の自前の乱数〕で）。
- [ ] **Step 2: 実装して GREEN。** `npx jest tests/unit/features/auth/return-intent --runInBand`。`npx tsc --noEmit`。
- [ ] **Step 3: `sanitizeRedirectPath` を置き換える。** `src/lib/redirect.ts` から関数を消す（他の関数は触らない）。4 つの route の import を `sanitizeReturnPath` に替え、呼び出しを次のとおりにする（読む元の値はこの段階では今のまま）:
  - `confirm`: `sanitizeReturnPath(url.searchParams.get('redirect_to'), DEFAULT_REDIRECT_PATH)`
  - `oauth/start`: `sanitizeReturnPath(parsed.data.redirect_to, DEFAULT_REDIRECT_PATH)`
  - `oauth/callback`: `sanitizeReturnPath(next, DEFAULT_REDIRECT_PATH)`
  - `register`: `sanitizeReturnPath(parsed.data.redirect_to ?? parsed.data.emailRedirectTo, '/auth/verified')`
  `/auth/verified` を `redirect_to` に渡す今のクライアントは `excluded_path` で fallback（同じ `/auth/verified`）になり、register・oauth start・oauth callback の見た目の結果は変わらない。**confirm だけは変わる**: register が `redirect_to=/auth/verified` を付けた確認のリンクは、今は `/auth/verified` を経て `/account` に着くが、Task 2 の後は `excluded_path` で既定 `/account` へ直接 303 する（最終の着地は同じ）。`tests/unit/api/auth/confirm-route.test.ts`・`tests/integration/api/auth/confirm.test.ts` の `/auth/verified` の期待をこのタスクで直す。E2E `FR-SIGNUP-003` が途中の `/auth/verified` を待っていれば Task 8 で直す一覧に入れる（レビューで追加）。
- [ ] **Step 4: 既存の試験を直す。** `grep -rn --include='*.ts' --include='*.tsx' --exclude-dir=graphify-out "sanitizeRedirectPath" src tests e2e` の結果をすべて直し、0 件にする（今は `tests/unit/api/auth/confirm-route.test.ts`・`register-route.test.ts` の 2 つ）。`confirm`・`oauth` の結合試験に次を足す（試験名の先頭は `API-AUTH-006 ` / `API-AUTH-007 ` / `API-AUTH-008 ` / `API-AUTH-005 `）: `redirect_to=/%09/evil.example` と `redirect_to=/.//evil.example` と `//evil.example` は fallback へ 303/302 し、`Location` が同じ origin のままであること。**トークン無しの `GET /api/auth/confirm?redirect_to=%2F%09%2Fevil.example`** が外へ 303 しないこと（失敗の枝）。
- [ ] **Step 5: 確かめ。** `npx tsc --noEmit`、`npx jest tests/unit/features/auth tests/unit/api/auth tests/integration/api/auth --runInBand`（DB 以外）。Step 4 の grep が 0 件。

**検証コマンド:** 上の 3 つ + `npx eslint src/features/auth/return-intent src/lib/redirect.ts src/app/api/auth`。

---

## Task 3: 移行・DB 結合試験（書くだけ）・運用文書

**Files:**
- Create: `supabase/migrations/20261025120000_auth_return_intents.sql`
- Create: `tests/integration/db/auth_return_intents.integration.test.ts`
- Create: `tests/unit/migrations/auth-return-intents.test.ts`
- 報告に書く（編集しない）: `docs/06_Operations/db-migrations.md` の新しい節の本文
- Modify: `docs/03_BasicDesign/areas/auth.md`（`DATA-AUTH-005` を実際の列・関数名に合わせる）

**移行の中身（`BEGIN; … COMMIT;` で包む。G-3 の移行の書き方に合わせる）:**

```sql
BEGIN;

-- 戻り先の控え（SEC-AUTH-026 / SEC-AUTH-032、DATA-AUTH-005）。番号そのものは持たず sha256 のハッシュだけを持つ。
CREATE TABLE private.auth_return_intents (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  return_path text NOT NULL,
  purpose text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  user_id uuid,                              -- 消費時に記録。auth.users への外部キーは付けない（履歴を消さない）
  CONSTRAINT auth_return_intents_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_return_intents_purpose_check CHECK (purpose IN ('login','signup')),
  CONSTRAINT auth_return_intents_return_path_check CHECK (
    pg_catalog.char_length(return_path) BETWEEN 1 AND 512
    AND return_path ~ '^/'
    AND return_path !~ '^//'
    AND return_path !~ '[\\[:space:][:cntrl:]]'
  ),
  CONSTRAINT auth_return_intents_expires_check CHECK (expires_at > created_at),
  CONSTRAINT auth_return_intents_consumed_check CHECK ((consumed_at IS NULL) = (user_id IS NULL))
);
ALTER TABLE private.auth_return_intents OWNER TO postgres;
CREATE INDEX auth_return_intents_expires_idx ON private.auth_return_intents (expires_at);
ALTER TABLE private.auth_return_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.auth_return_intents FROM PUBLIC, anon, authenticated, service_role;

-- 作る。期限は用途で決め、戻り値は Cookie の Max-Age にそのまま使う秒数。
CREATE OR REPLACE FUNCTION public.create_auth_return_intent(_token_hash text, _return_path text, _purpose text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ … $$;
--   INSERT ... (expires_at = now() + (CASE _purpose WHEN 'login' THEN 900 ELSE 3600 END) * interval '1 second')
--   RETURNING の秒数を返す。_purpose が不正なら CHECK が 23514 で止める。

-- 1 回で使い切る。戻り値は return_path。使えなければ NULL（期限切れ・使用済み・別の用途・存在しない）。
-- STRICT: 引数のどれかが NULL なら本文を流さず NULL を返す（_user_id が NULL のまま consumed_at だけ入る 23514 を起こさない）。
CREATE OR REPLACE FUNCTION public.consume_auth_return_intent(_token_hash text, _purpose text, _user_id uuid)
RETURNS text LANGUAGE sql STRICT SECURITY DEFINER SET search_path = '' AS $$
  UPDATE private.auth_return_intents
     SET consumed_at = pg_catalog.now(), user_id = _user_id
   WHERE token_hash = _token_hash AND purpose = _purpose
     AND consumed_at IS NULL AND expires_at > pg_catalog.now()
  RETURNING return_path
$$;

ALTER FUNCTION public.create_auth_return_intent(text, text, text) OWNER TO postgres;
ALTER FUNCTION public.consume_auth_return_intent(text, text, uuid) OWNER TO postgres;
-- 先例 20261022084844_order_status_links と同じく service_role からも一度外してから、EXECUTE だけを付け直す（既定の権限の ALL を残さない）。
REVOKE ALL ON FUNCTION public.create_auth_return_intent(text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.consume_auth_return_intent(text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_auth_return_intent(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_auth_return_intent(text, text, uuid) TO service_role;

-- 掃除（毎日）。pg_cron は 20260911235714 で入れ済み。自己付与の grant は写さない。
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
SELECT cron.schedule('auth-return-intents-cleanup', '20 3 * * *',
  $$ DELETE FROM private.auth_return_intents WHERE expires_at < pg_catalog.now() - interval '1 day' $$);

-- 末尾の確かめ: G-3 の $g3c_final_objects$ と同じ形で、失敗は
-- RAISE EXCEPTION 'AUTH_RETURN_INTENT_ASSERTION_FAILED' USING ERRCODE='55000', DETAIL='<項目名>'。
--   auth_return_intents_table: 表の存在・postgres 所有・RLS 有効・anon/authenticated/service_role に表の権限なし（has_table_privilege）
--   auth_return_intents_functions: 2 本の存在・DEFINER・空の search_path・anon/authenticated/PUBLIC の EXECUTE なし・service_role の EXECUTE あり
--   auth_return_intents_cleanup_job: cron.job に jobname があり、スケジュールが '20 3 * * *'
COMMIT;
```

関数を `public` に置く理由: サーバーは `supabase-js` の `rpc`（PostgREST）で呼ぶので、公開の schema に置く必要がある。Supabase の公式の注意（`SECURITY DEFINER` を公開の schema に置かない）の代わりに、Supabase の Database Advisor の lint `0028_anon_security_definer_function_executable`・`0029_authenticated_security_definer_function_executable` の解決策 1（`PUBLIC`・`anon`・`authenticated` から `EXECUTE` を外す。`PUBLIC` も外さないと既定の付与が残る）と、Database Functions の「Function privileges」に従う（<https://supabase.com/docs/guides/database/functions>、<https://supabase.com/docs/guides/database/database-advisors>）。表は `private` に置き、PostgREST から見えない。先例は `20261022084844_order_status_links.sql`（同じ形で E-5 に本番適用済み）。ADR-0412 の「背景」にこの段落の要点を書く（レビューで追加）。

`SECURITY DEFINER` の見出しは `tests/unit/migrations/security-definer-search-path-guard.test.ts` が検査する（`SET search_path = ''` を `AS $$` の前に書く。後ろに書くと見出しから外れて落ちる）。

SQL の本文は上の骨組みを正とし、`pg_catalog.` と `private.` の修飾を省かない。`_purpose` の秒数は `CASE` で決め、他の値は表の CHECK に任せる。**ファイルの時刻を `ls supabase/migrations` の最新より後に付ける**（Global の再確認）。全角の文字（`　` など）を SQL に入れない（適用の途中で字が変わる事故の前例: `push-hook-and-ci-migrations`）。

**DB 結合試験の中身（`tests/integration/db/auth_return_intents.integration.test.ts`。先頭は `/** @jest-environment node */`、`describeLocalDb`、各試験を `begin` / `rollback` で包む。例外: 並行の試験だけ実コミット＋後始末）。試験名の先頭は `DATA-AUTH-005 `。書くだけ。流さない。**

- 表の ACL: `has_table_privilege` が `anon`・`authenticated`・`service_role` で `select,insert,update,delete` すべて偽。`relrowsecurity` が真。`relowner` が postgres。
- 関数の ACL: 2 本の `has_function_privilege` が `anon`・`authenticated`・`public` で偽、`service_role` で真。`prosecdef` 真、`proconfig` に `search_path=""`。
- 作る: login は 900、signup は 3600 を返す。行の `expires_at - created_at` が同じ秒数。保存された `token_hash` が渡した値で、平文の番号を渡していない（列に番号が無い）ことは構造の確認だけ（列の一覧が期待どおり）。
- 使い切る: 1 回目は `return_path` を返し `consumed_at`・`user_id` が入る。2 回目は NULL。
- 期限切れ: 直接 `insert` した過去の `expires_at`（`created_at` も過去にずらす）は NULL。
- 用途違い: signup の行を `'login'` で使うと NULL（行は未使用のまま）。逆も。
- 存在しないハッシュは NULL。`_user_id` が NULL でも NULL（`STRICT`）で、行は未使用のまま。
- CHECK: `//evil`・`/\evil`・`/a b`・タブ入り・`evil`（`/` で始まらない）・513 文字・空・不正な `purpose`・64 桁の 16 進でない `token_hash` を入れると 23514。同じ `token_hash` の 2 回目は 23505。`consumed_at` だけ入って `user_id` が NULL も 23514。
- 並行（実コミット、`connectLocalDb()` の 2 本目を使い、`afterEach` で `token_hash` の接頭辞で削除）: 同じハッシュを 2 接続から同時に使い切ると、返すのが 1 つの `return_path` と 1 つの NULL（`Promise.all`）。
- 掃除: `cron.job` に `auth-return-intents-cleanup` がある。2 日前に期限切れの行は掃除の SQL（`cron.job.command` を読んで実行）で消え、新しい行は残る。
- 末尾の確かめの改変: 取引の中で `GRANT EXECUTE … TO anon` を足した上で、移行の末尾の `DO` ブロックを再実行できる形にせず、**同じ条件を試験の中で再計算して偽になること**を確かめる（G-3 の `group_g3_draft` の末尾の確かめの試験を見本にする）。
- （任意・鍵が要る）PostgREST: `SUPABASE_SERVICE_ROLE_KEY` と `NEXT_PUBLIC_SUPABASE_URL` がある時だけ、`service_role` で `rpc('create_auth_return_intent')` が 200、anon キーでは 401/403/404 のどれかになることを確かめる。無ければ `test.skip` ではなく `describe` ごと条件で外す。

- [ ] **Step 1: 移行を書く。** 上の骨組みを完成させる。`psql` は流さない（DB は動かさない）。SQL は目で `BEGIN`/`COMMIT` の対応・修飾・権限の行を確かめる。
- [ ] **Step 1b: 移行の文面の単体試験（DB なしで流せる。レビューで追加）。** `tests/unit/migrations/auth-return-intents.test.ts`（見本: `tests/unit/migrations/092_lock_down_rpc_surface.test.ts`）。試験名の先頭は `DATA-AUTH-005 `。ファイル名で移行を探し（`_auth_return_intents.sql` で終わる 1 本）、コメントを外した本文に次があることを確かめる: 2 本の関数それぞれの `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated, service_role;` と `GRANT EXECUTE ON FUNCTION … TO service_role;`、`anon`・`authenticated` への `GRANT` が 1 つも無い、表の `ENABLE ROW LEVEL SECURITY` と `REVOKE ALL ON TABLE private.auth_return_intents FROM PUBLIC, anon, authenticated, service_role;`、表への `GRANT` が無い、`SECURITY DEFINER` の数と `SET search_path = ''` の数が同じ、`consume_auth_return_intent` に `STRICT`、`consumed_at IS NULL AND expires_at > pg_catalog.now()` の条件、`grant usage on schema cron`・`grant all privileges on all tables in schema cron` が無い（自己付与を写さない）、ファイルの時刻が G-3 の `20261025100130` より後、全角の空白（U+3000）が無い。流す: `npx jest tests/unit/migrations/auth-return-intents.test.ts tests/unit/migrations/security-definer-search-path-guard.test.ts --runInBand`。
- [ ] **Step 2: DB 結合試験を書く。** `npx tsc --noEmit`。`npx jest tests/integration/db/auth_return_intents --runInBand` は `DATABASE_URL` が無ければ skip されるだけで落ちないことを確かめる（流してよい。DB に繋がない）。
- [ ] **Step 3: 運用文書の本文を書く（ファイルは編集しない）。** `docs/06_Operations/db-migrations.md` は G-3 が変更中なので触らない（Global Constraints）。節「波 1-A 戻り先の控えの移行（本番未適用）」の Markdown の全文を Task 3 の報告に入れる: 内容（表・関数 2 本・cron）、触らないもの、末尾の確かめの項目表、試験（controller が reset 後に流す）、**本番適用は G-3 の本番適用の後**（本番アプリは未公開なので待てる）、ロールバック（表と関数と cron を消す文。クライアントが `rpc` を呼ばなくなってから）。controller が G-3 のコミットの後に挿入し、`npm run validate-docs` を流す。
- [ ] **Step 4: 構造設計の更新。** `DATA-AUTH-005` の列・関数名・期限・権限を実物に合わせる。
- [ ] **Step 5: 確かめ。** `npm run validate-docs`。

**検証コマンド:** `npx tsc --noEmit`、`npx jest tests/unit/migrations/auth-return-intents.test.ts tests/unit/migrations/security-definer-search-path-guard.test.ts --runInBand`（緑）、`npx jest tests/integration/db/auth_return_intents --runInBand`（skip で緑）、`npm run validate-docs`。

---

## Task 4: 保存・開始・解決の部品と Cookie

**Files:**
- Create: `src/features/auth/return-intent/return-intent-store.ts`
- Create: `src/features/auth/return-intent/return-intent-service.ts`
- Modify: `src/lib/cookie.ts`（Cookie の名前と属性だけを足す。コメントは足さない）
- Create: `tests/unit/features/auth/return-intent/return-intent-store.test.ts`
- Create: `tests/unit/features/auth/return-intent/return-intent-service.test.ts`
- Modify: `tests/unit/lib/cookie*.test.ts`（あれば。無ければ `return-intent-service.test.ts` の中で属性を確かめる）

**Interfaces:**

```ts
// src/lib/cookie.ts に足す
export const returnIntentCookieName = 'sb-return-intent';
export function cookieOptionsForReturnIntent(maxAgeSeconds: number): {
  httpOnly: true; secure: boolean /* NODE_ENV === 'production' */; sameSite: 'lax'; path: '/'; maxAge: number;
};

// return-intent-store.ts  (@impl IMPL-AUTH-207 / @design DD-AUTH-033)
export type ReturnIntentPurpose = 'login' | 'signup';
export const RETURN_INTENT_TOKEN_PATTERN: RegExp;                 // /^[A-Za-z0-9_-]{43}$/（32 バイトの base64url）
export function generateReturnIntentToken(): string;               // crypto.randomBytes(32).toString('base64url')
export function hashReturnIntentToken(token: string): string;      // sha256 の 16 進 64 桁
export async function createReturnIntent(input: { returnPath: string; purpose: ReturnIntentPurpose }):
  Promise<{ token: string; maxAgeSeconds: number } | null>;        // 失敗は null（符号だけを console.error。道筋・番号・ハッシュは出さない）
export async function consumeReturnIntent(input: { token: string; purpose: ReturnIntentPurpose; userId: string }):
  Promise<string | null>;                                          // 使えない・失敗は null

// return-intent-service.ts  (@impl IMPL-AUTH-208 / @design DD-AUTH-034)
export type ReturnIntentCookieAction =
  | { kind: 'set'; token: string; maxAgeSeconds: number }
  | { kind: 'clear' }
  | { kind: 'keep' };
export function applyReturnIntentCookie(
  response: { cookies: { set: (cookie: { name: string; value: string } & Record<string, unknown>) => unknown } },
  action: ReturnIntentCookieAction,
): void;
export function readReturnIntentToken(cookieHeader: string | null): string | null;   // パターンに合う時だけ返す

export async function issueReturnIntent(input: {
  rawNext: unknown;
  purpose: ReturnIntentPurpose;
  origin?: string;
}): Promise<{ action: ReturnIntentCookieAction; outcome: 'created' | 'cleared' | 'rejected' | 'failed' }>;
// rawNext が undefined / null / '' → { clear, 'cleared' }（監査なし）
// 確かめに外れる → { clear, 'rejected' } + logAudit({ action:'auth.return_intent', outcome:'rejected', detail: <reason> })
// 通る → createReturnIntent → 成功 { set, 'created' } ／ 失敗 { clear, 'failed' } + logAudit(... outcome:'error', detail:'create_failed')

export type ResolvedDestination = { path: string; needsMfa: boolean; action: ReturnIntentCookieAction };
export async function resolveReturnDestination(input: {
  cookieHeader: string | null;
  purpose: ReturnIntentPurpose;
  viewer: { id: string; role: 'admin' | 'supporter' | 'user'; aal: string | null };
  origin?: string;
}): Promise<ResolvedDestination>;
// 特権（admin / supporter）で aal !== 'aal2' → { path:'/auth/verified', needsMfa:true, action:{kind:'keep'} }（使い切らない）
// それ以外:
//   Cookie の見出しに sb-return-intent が 1 つも無い → 既定 + keep（消す物が無い）
//   ある が readReturnIntentToken が null（パターン外・名前の重複）→ 既定 + clear（使い切りは呼ばない）
//   番号がある → consumeReturnIntent（NULL・失敗でも Cookie は clear）
//   使い切れた戻り先を validateReturnPath(path, { viewer, origin }) で出口の確かめ。外れたら既定 + 監査（reason だけ）
//   既定: 特権 → '/admin'、一般 → '/'
// issueReturnIntent と resolveReturnDestination は例外を投げない（中の想定外の例外は捕まえ、issue は { clear, 'failed' }、
// resolve は { 既定, needsMfa:false, clear }（特権で aal2 でない時は先の枝で返るので届かない）。ログインを止めないため。レビューで追加）
```

- [ ] **Step 1（RED）: store の単体試験。** 試験名の先頭は `DD-AUTH-033 `。`createServiceRoleClient`（`@/lib/supabase/server`）を差し替え、`rpc` の引数と戻りを確かめる。
  - `createReturnIntent`: `rpc('create_auth_return_intent', { _token_hash, _return_path, _purpose })` を呼ぶ。`_token_hash` が 64 桁の 16 進で、**渡す引数のどこにも平文の番号が無い**。戻り値 `{ token, maxAgeSeconds }` の `token` は `RETURN_INTENT_TOKEN_PATTERN` に合い、`hashReturnIntentToken(token) === _token_hash`。`maxAgeSeconds` は rpc の戻り値（数値）そのまま。`rpc` が `{ error }` を返すと `null`、投げても `null`、`console.error` の引数に道筋・番号・ハッシュの文字列が含まれない（`error.code` だけ）。戻り値が数値でなければ `null`。
  - 番号の生成: 1000 回で重複なし、43 文字、`+`・`/`・`=` を含まない。
  - `consumeReturnIntent`: `rpc('consume_auth_return_intent', { _token_hash, _purpose, _user_id })`。文字列が返れば返し、`null`・エラー・投げるは `null`。
- [ ] **Step 2（RED）: service の単体試験。** 試験名の先頭は `DD-AUTH-034 `。store と `@/lib/audit` を差し替える。
  - `issueReturnIntent`: `undefined`・`null`・`''` → `clear`・`cleared`・`createReturnIntent` 未呼び出し・監査なし。`'//evil.example'`・`'/%09/evil.example'`・`'/login'`・`'/api/x'` → `clear`・`rejected`・監査に `{ action:'auth.return_intent', outcome:'rejected', detail:'not_relative' など }` **だけ**（`detail` に入力の値が含まれない）。`'/item/3?color=red#x'` → 保存へ渡る道筋が `'/item/3?color=red'`、`set`・`created`。保存が `null` → `clear`・`failed`・監査 `error`。`purpose` がそのまま渡る。
  - `resolveReturnDestination`: 一般の会員・番号あり・保存が `/item/3` → `path:'/item/3'`・`needsMfa:false`・`clear`。番号なし → `path:'/'`・`keep`（消すものが無い）。番号がパターン外 → `path:'/'`・`clear`。保存が `null` → `path:'/'`・`clear`（Cookie は消す）。**特権（admin）・aal1 → `path:'/auth/verified'`・`needsMfa:true`・`keep`・`consumeReturnIntent` 未呼び出し**。特権・aal2・保存 `/item/3` → `/item/3`。特権・aal2・保存 `null`／番号なし → `/admin`。**一般の会員で保存が `/admin`（入口で通った古い控え）→ 出口の確かめで外れ、`path:'/'`**・監査に `admin_requires_privileged_aal2`。特権・aal2・保存 `/admin` → `/admin`。**保存の値が改ざんされた場合の出口の確かめ（レビューで追加）**: 保存が `//evil.example`・`/login`・`/api/auth/me`・`/%09/evil.example` を返しても（DB の CHECK を外れた値を fake で返す）`path` は既定（一般 `/`、特権 aal2 `/admin`）で、監査の `detail` は理由の符号だけ。`consumeReturnIntent` が投げる・`logAudit` が投げる時も例外にならず既定を返す。`issueReturnIntent` も `createReturnIntent`・`logAudit` が投げる時に例外にならず `clear`・`failed`。
  - `applyReturnIntentCookie`: `set` は名前 `sb-return-intent`・`httpOnly:true`・`sameSite:'lax'`・`path:'/'`・`maxAge`・本番で `secure:true`（`NODE_ENV` を切り替えて両方）。`clear` は値 `''`・`maxAge:0`。`keep` は `cookies.set` を呼ばない。
  - `readReturnIntentToken`: 他の Cookie が混ざる見出しから取れる。43 文字でない・文字種が違う・2 つ名前が重なる値は `null`。
- [ ] **Step 3: 実装して GREEN。** `npx tsc --noEmit` を編集のたびに。`@impl`・`@design`・`@remarks`（「なぜ」だけ）を 2 ファイルの先頭に付ける。
- [ ] **Step 4: Cookie の名前・属性を `src/lib/cookie.ts` に足す。** 既存の関数・default export の形は変えない（default export のオブジェクトに足すかは、既存の試験が形を固定していないか `grep -rn "cookieHelper\|from '@/lib/cookie'" tests` で確かめて決める）。
- [ ] **Step 5: 確かめ。** `npx tsc --noEmit`、`npx jest tests/unit/features/auth/return-intent --runInBand`、`npx eslint src/features/auth/return-intent src/lib/cookie.ts`。

**検証コマンド:** 上の 3 つ + `npm run validate-trace -- AUTH`（この時点の `missing-child` は Task 8 まで残る前提。**新しい `bad-design-link`・`missing-impl`・`duplicate-impl`・`untagged-test`・`unknown-test-id` は 0 件**）。

---

## Task 5: 入口（login・oauth/start・register・取消・ログアウト）

**Files:**
- Modify: `src/app/api/auth/login/route.ts`、`login/cancel/route.ts`、`logout/route.ts`、`register/route.ts`、`oauth/start/route.ts`
- Modify: `src/features/auth/schemas/login.ts`（`next` を足す）、`register.ts`（`redirect_to`・`emailRedirectTo` を消し、`next` を足す）
- Modify: 該当の単体・結合試験（`tests/unit/api/auth/{login-route,login-cancel-route,register-route,oauth-start-route}.test.ts`、`tests/integration/api/auth/{login,login-cancel,register,register-enumeration,oauth-start,logout}.test.ts`、`tests/integration/api/auth-login-api.test.ts`、`auth-bot-rate-limit.test.ts`、`auth-password-rule.test.ts`）

**仕様:**

- `login`: スキーマに `next: z.unknown().optional()`（**文字列の型・長さの検査を Zod に置かない**。`next: 123` や 2000 文字超で 400 になり、ログインそのものが止まるのを防ぐ。決定「ログインそのものは止めない」。型・長さは `issueReturnIntent` → `validateReturnPath` が `empty`・`too_long` で断り、Cookie を消す。レビューで変更）。確認コードを送れて保留の Cookie を置く所で `issueReturnIntent({ rawNext: parsed.data.next, purpose: 'login' })` を呼び、`applyReturnIntentCookie(res, action)`。**パスワードの誤り・ボット判定・制限・OTP 送信失敗の応答には控えの Cookie を付けない・作らない**。DB の失敗でログインは止めない。
- `login/cancel`: 保留の Cookie を捨てる所で `applyReturnIntentCookie(res, { kind:'clear' })`。
- `logout`: 認証の Cookie を全部消す所に `sb-return-intent` を足す（常に 200 は変えない）。
- `register`: スキーマの `redirect_to`・`emailRedirectTo` を消し `next: z.unknown().optional()` を足す（古いクライアントが送っても Zod が捨てる。`next` の型で 400 にしない理由は login と同じ）。公開の登録の流れで、**Turnstile・漏洩の確かめを通った後、`findAuthUserIdByEmail` の前**に `issueReturnIntent({ rawNext: next, purpose: 'signup' })`。得た `action` を、`acceptedResponse()` を返す 3 つの枝（登録済み・重複の例外・メール確認待ち）すべてに同じ形で適用する（`acceptedResponse(action)` に引数を足し、中で `applyReturnIntentCookie`）。`confirmUrl` から `redirect_to` を外す（`emailRedirectTo` は `/api/auth/confirm` だけ）。即ログインの枝（201、Confirm email が OFF の時）には `clear` を適用する。管理の鍵の枝（SEC-AUTH-017 は別の波）には触らない。
- `oauth/start`: 共通の中身を関数 `startOAuth(request, { provider, next })` に切り出し（戻り値は Google の URL と PKCE の Cookie の一覧、または失敗の応答）、`GET` は `next: undefined`、`POST` は `await request.json()`（JSON でない・壊れている → 400）の `provider`・`next` を渡す（`StartBodySchema = z.object({ provider: z.string().min(1), next: z.unknown().optional() })`）。`GET` の `redirect_to` はもう読まない（読んでも捨てる）。`StartQuerySchema` から `redirect_to` を消す。コールバックの URL に `next` を付けない（`callbackUrl.searchParams.set('next', …)` を消す）。Google の URL が取れた後に `issueReturnIntent({ rawNext: next, purpose: 'login' })`、得た `action` を応答に適用（POST も GET も。GET は `next` が無いので常に `clear`）。**POST は 200 `NextResponse.json({ url: data.url })`**（リダイレクトしない。P2 の CSP `form-action` の理由）、GET は従来どおり 302。どちらも `Cache-Control: no-store`・`Referrer-Policy: no-referrer`。`provider` は `'google'` だけ（本文の値も同じ検査）。`logAudit` の `metadata.redirect_to` はやめる（道筋を残さない）。レート制限の枠は GET と同じ `auth:oauth:start`。

- [ ] **Step 1（RED）: 単体試験を足す・直す。** 試験名の先頭は `DD-AUTH-014 `（login）、`DD-AUTH-017 `（cancel）、`DD-AUTH-018 `（register）、`DD-AUTH-020 `（oauth start）、`DD-AUTH-028 `（logout）。`issueReturnIntent`・`applyReturnIntentCookie` は本物を通し、`createReturnIntent` だけを差し替えるか、`issueReturnIntent` を差し替えて呼び出しの引数と順序を確かめる（既存の試験の様式に合わせる）。具体的な確かめ:
  - login: `next:'/item/3?color=red'` で成功 → 応答に `sb-return-intent`（`HttpOnly`・`SameSite=Lax`・`Path=/`・`Max-Age=900`）と保留の Cookie の**両方**が付く。`next` 無し／`'//evil.example'`／`123`／`'/item/' + 'a'.repeat(3000)` → 200・`step:'otp'` のまま、控えの Cookie は `Max-Age=0`（消す。`next` の形でログインが 400 にならない）。パスワード誤り（401）・Turnstile 失敗（403）・OTP 送信失敗（500）の応答に `sb-return-intent` の Set-Cookie が**無い**。DB の失敗（`createReturnIntent` が `null`）でも応答は 200・`step:'otp'`。応答の本文に番号・道筋が出ない。
  - register: `next` ありで新規・登録済み・重複の例外の 3 枝すべて、202・本文 `{ message:'Confirmation email sent' }`・`sb-return-intent` の Set-Cookie の**属性の並びが同じ**（値は違ってよい）。`createReturnIntent` が失敗しても 3 枝とも 202 かつ Cookie は `Max-Age=0`。`signUp` の `emailRedirectTo` が `/api/auth/confirm` で**クエリを持たない**。`redirect_to` をボディに入れても無視される（`next` 扱いにならない）。順序: `createReturnIntent` の呼び出しが `findAuthUserIdByEmail` の**前**（`mock.invocationCallOrder`）。Turnstile 失敗では呼ばれない。
  - oauth start: `POST`（`application/json`、`{ provider:'google', next:'/account' }`）→ 200、本文 `{ url }` が Supabase の URL（`Location` の見出しは無い）、`sb-return-intent` あり、PKCE の Cookie もある、本文に番号が無い、`callbackUrl`（`signInWithOAuth` の `redirectTo`）が `/api/auth/oauth/callback` で**クエリ無し**。`next:'//evil.example'` → 200 はそのまま、Cookie は消す側、監査に `rejected`。`next: 123` → 200（ログインを止めない）・Cookie は消す側。`provider:'github'` → 400。本文が JSON でない → 400。`GET ?provider=google&redirect_to=/account` → 302、Cookie は消す側、`redirectTo` にクエリ無し、`createReturnIntent` 未呼び出し。
  - cancel / logout: `sb-return-intent` が `Max-Age=0` で消える。
- [ ] **Step 2（RED）: 結合試験を直す。** 試験名の先頭は `API-AUTH-001 `（login）、`API-AUTH-004 `（cancel）、`API-AUTH-005 `（register）、`API-AUTH-007 `（oauth start）、`API-AUTH-015 `（logout）。同じ観点を、既存の結合試験の様式（`Request` を route に渡す）で。登録の 3 枝の応答の同一性は `register-enumeration.test.ts` に Set-Cookie の属性の比較を足す。
- [ ] **Step 3: 実装して GREEN。** 編集のたびに `npx tsc --noEmit`。IMPL・design の TSDoc の `@remarks` を、変えた route の先頭で更新する（`IMPL-AUTH-145` など既存の番号は変えない。「なぜ」だけ）。
- [ ] **Step 4: 確かめ。** `npx jest tests/unit/api/auth tests/integration/api/auth tests/integration/api/auth-login-api.test.ts tests/integration/api/auth-bot-rate-limit.test.ts tests/integration/api/auth-password-rule.test.ts --runInBand`、`npx tsc --noEmit`、`npx eslint src/app/api/auth src/features/auth`。`grep -rn "redirect_to\|emailRedirectTo" src` は `confirm` が読まない形になっていること（この時点で `confirm`・`oauth/callback` には読む所が残っていてよい。Task 6 で消す）。

**検証コマンド:** 上の 3 つ。

---

## Task 6: 出口（post-login 窓口・OTP の確定の後・/auth/verified・Google の戻り・確認のリンク）

**Files:**
- Create: `src/app/api/auth/post-login/route.ts`
- Modify: `src/app/api/auth/oauth/callback/route.ts`、`confirm/route.ts`
- Modify: `src/app/login/verify/VerifyOtpClient.tsx`、`src/app/auth/verified/page.tsx`
- Create: `tests/unit/api/auth/post-login-route.test.ts`、`tests/integration/api/auth/post-login.test.ts`
- Modify: `tests/unit/api/auth/{oauth-callback-route,confirm-route}.test.ts`、`tests/integration/api/auth/{oauth-callback,confirm}.test.ts`、`tests/unit/components/VerifyOtpClient.test.tsx`、`tests/unit/app/auth/verified-page.test.tsx`、`tests/integration/ui/auth-oauth-flow.test.tsx`（`next` 前提を直す）

**`post-login/route.ts` の仕様（`@impl IMPL-AUTH-209` / `@design DD-AUTH-035`）:**

```ts
// POST /api/auth/post-login   （本文なし）
// 1. enforceRateLimit({ request, endpoint: 'auth:post-login', limit: 60, windowSeconds: 600 })
// 2. authenticateRequest(request)（@/lib/auth/authenticate）
//    !ok → authFailureResponse(reason)（@/lib/auth/authenticate。unavailable は 503 + Retry-After、他は 401。/api/auth/me と同じ部品。Cookie は触らない）
// 3. viewer = { id: claims.sub, role: claims.app_metadata.role（admin / supporter / それ以外は 'user'）, aal: claims.aal ?? null }
// 4. const resolved = await resolveReturnDestination({ cookieHeader, purpose: 'login', viewer })
// 5. 200 { redirectTo: resolved.path, needsMfa: resolved.needsMfa }、Cache-Control: no-store、Referrer-Policy: no-referrer、
//    applyReturnIntentCookie(res, resolved.action)
```

**303 の行き先を決める時機（`oauth/callback`・`confirm` 共通。レビューで追加）:** 今の 2 つの route は、`persistSessionAndCookies(res, …)` が Cookie を書き込む先として、保存の**前に** `NextResponse.redirect(…)` の応答を作っている。戻り先は保存の成功の後でないと使い切れない（保存の失敗で戻り先だけが焼けるのを防ぐ）ので、応答はこれまでどおり既定の行き先で先に作り、保存が成功した後に `resolveReturnDestination` を呼び、`res.headers.set('Location', new URL(resolved.path, origin).toString())` で行き先を差し替えてから `applyReturnIntentCookie(res, resolved.action)` する。保存の失敗の枝では `resolveReturnDestination` を呼ばない（Cookie も触らない）。試験は「保存が `{ ok:false }` を返すと `consume_auth_return_intent` の rpc が呼ばれず、`Location` は既定」「保存の後で `Location` が戻り先に替わる」の両方を持つ。

**`oauth/callback` の仕様:** `CallbackQuerySchema` から `next` を消す。セッションの保存（`persistSessionAndCookies`）に**成功した後**で `resolveReturnDestination({ cookieHeader, purpose:'login', viewer:{ id:user.id, role, aal: <交換直後のセッションの aal> } })`。交換直後は Google のログインなので `aal1`（`session.user` から取れなければ `'aal1'` 固定でよい。**特権は必ず aal1 扱い**にして `/auth/verified` へ）。結果の `path` へ 303（`new URL(path, origin)`）、`action` を応答へ適用。保存に失敗した時は戻り先を使い切らない（`keep`）で、今の「Cookie を付けた応答を返す」挙動のまま既定 `/`（特権は `/auth/verified`）。`DEFAULT_REDIRECT_PATH` と「`/auth/verified` なら `/account` に替える」分岐は消す。

**`confirm` の仕様:** `redirect_to` を**読まない**。失敗の 3 つの枝（トークン欠落・検証失敗・例外）は固定の `/login` へ 303（P5）。成功は `persistSessionAndCookies` の後に `resolveReturnDestination({ …, purpose:'signup', viewer:{ id:data.user.id, role: data.user.app_metadata.role, aal:'aal1' } })`。Cookie が無い（別のブラウザ）なら既定 `/`（P4）。保存の失敗の枝は今どおり応答を返す（戻り先は使い切らない）。**`otpType` が `'signup'` でない時（`email`・`magiclink`・`recovery` の印が来た時）は戻り先を使い切らず既定 `/`**（登録の控えを登録以外の確認で使わない。P7 の延長。レビューで追加）。成功の既定は `/`（P1）、失敗は `/login`（P5）なので、`DEFAULT_REDIRECT_PATH` は消して 2 つの定数にする。

**`VerifyOtpClient` の仕様:** `resolvePostLoginPath` を `POST /api/auth/post-login`（`credentials:'same-origin'`、`cache:'no-store'`）に替える。応答 200 → `redirectTo` が `needsMfa === true` なら `'/auth/verified'`、そうでなければ `sanitizeReturnPath(body.redirectTo, '/')`（クライアントでの二重の確かめ。`origin: window.location.origin`）。401 → `'/login'`。**通信の失敗・503・429・その他 → `'/auth/verified'`**（`/` にすると、`post-login` が落ちた時に管理者・サポーターが 2 段目を通らずに着地する。`/auth/verified` は一般の会員なら `post-login` をもう一度呼んで `/` へ、特権なら TOTP を出すので、どちらにも安全に倒れる。今の `/api/auth/me` の失敗の既定 `/account` の代わり。レビューで変更）。`/api/auth/me` の呼び出しは消える。

**`/auth/verified` 頁の仕様:** 次の 3 か所の `router.replace(…)` を、共通の関数 `goAfterLogin()` に替える: ①特権で `mfaVerified` の時の `/admin`、②TOTP の確定の後の `/admin`、③一般の会員の `/account`（`setTimeout` の 800ms の中）。`goAfterLogin()` は `POST /api/auth/post-login` を呼び、`redirectTo` を `sanitizeReturnPath`（クライアントの二重の確かめ）で通して `router.replace`。失敗の時の保険: 特権は `/admin`、一般は `/`。`needsMfa:true` が返った時（特権が aal1 のまま来た。`/api/auth/me` の `mfaVerified` と、`post-login` が読む claims の `aal` が食い違った時）は移らず、①の枝なら `loadMfaStatus()` を呼んで TOTP の入力を出す（「管理画面へ移動します…」のまま止まらない）、②の枝なら誤りの文言を出す。一般の会員の案内の文言「確認完了。アカウントへ移動します…」は「確認完了。移動します…」に、リンクの表示（「アカウントへ」）は `href="/"` の「トップへ」に替える（FREQ-377 の同じ status の中身の入れ替えは保つ）。

- [ ] **Step 1（RED）: `post-login` の単体試験。** 試験名の先頭は `DD-AUTH-035 `。`authenticateRequest`・`resolveReturnDestination`・`enforceRateLimit` を差し替える。確かめ: 未ログイン → 401（`resolveReturnDestination` 未呼び出し）、`unavailable` → 503 と `Retry-After`（値は `authFailureResponse` のもの）、一般の会員 → 200 `{ redirectTo:'/item/3', needsMfa:false }`、`viewer` の `role`・`aal` が**トークンの claims 由来**でボディ・ヘッダー由来でない（`x-role: admin` を送っても無視）、特権・aal1 → `needsMfa:true`・`redirectTo:'/auth/verified'`・Cookie の Set-Cookie が無い（`keep`）、使い切った応答に `sb-return-intent` が `Max-Age=0`、`Cache-Control: no-store`、制限に当たると 429 でそのまま返す。
- [ ] **Step 2（RED）: `post-login` の結合試験。** 試験名の先頭は `API-AUTH-019 `。本物の `resolveReturnDestination` を通し、`createServiceRoleClient` の `rpc` だけを差し替える（`consume_auth_return_intent` が最初の 1 回だけ道筋を返す fake）。観点: 続けて 2 回呼ぶと 2 回目は `redirectTo:'/'`（FR-AUTH-005-AC-07 の単位試験版）、`purpose` が `login` で渡る、一般の会員 + 保存が `/admin` → `redirectTo:'/'`、特権 + aal2 + 保存が `/admin/orders` → 同じ、特権 + aal1 → rpc 未呼び出し。
- [ ] **Step 3（RED）: 他の出口の試験を直す。** 試験名の先頭は `DD-AUTH-021 `／`API-AUTH-008 `（oauth callback）、`DD-AUTH-019 `／`API-AUTH-006 `（confirm）、`DD-AUTH-005 `／`SCR-AUTH-007 `（verified 頁）、`DD-AUTH-…`（`VerifyOtpClient` は既存の ID のまま、期待を直す）。
  - oauth callback: `?code=…&next=/account`（古い形）の `next` は**無視**され、控えの Cookie が無ければ `/`。控えあり（fake が `/item/3` を返す）・一般の会員 → `/item/3` へ 303 かつ `sb-return-intent` が消える。特権 → `/auth/verified`・`consume` 未呼び出し。保存失敗 → 戻り先を使い切らない。`redirectTo`/`next` に `//evil.example` を入れても外へ出ない。
  - confirm: `?redirect_to=%2F%09%2Fevil.example`（トークン無し）→ 303 が `/login`、`Location` の origin が同じ。成功 + 控えあり → 戻り先。成功 + 控え無し → `/`。成功 + 控えの用途が `login`（fake の `consume` が `purpose` 違いで `null`）→ `/`。成功 + `type=magiclink`（控えあり）→ `/` かつ `consume` 未呼び出し。保存の失敗 → `consume` 未呼び出し・`Location` は既定。失敗の 3 枝 → `/login`。
  - `VerifyOtpClient`: 確定の後に `fetch('/api/auth/post-login', { method:'POST' })` を呼び、`{ redirectTo:'/item/3', needsMfa:false }` → `router.replace('/item/3')`、`{ redirectTo:'/auth/verified', needsMfa:true }` → `/auth/verified`、`redirectTo:'//evil.example'` → `/`、401 → `/login`、fetch が投げる・503 → `/auth/verified`。`/api/auth/me` を呼ばない。既存の `/account` の期待 4 か所（`:107`・`:481`・`:487`・`:511`）を `/` ほかに直す。
  - `/auth/verified`: 一般の会員で `post-login` が `/item/3` → `router.replace('/item/3')`、特権・`mfaVerified` で `post-login` が `/admin` → `/admin`、TOTP の確定の後に `post-login` を呼んでから `router.replace`、`post-login` の失敗で特権は `/admin`。
- [ ] **Step 4: 実装して GREEN。** 編集のたびに `npx tsc --noEmit`。`confirm`・`oauth/callback` の `@remarks` を直す。
- [ ] **Step 5: 確かめ。** `npx jest tests/unit/api/auth tests/integration/api/auth tests/unit/components/VerifyOtpClient.test.tsx tests/unit/app/auth/verified-page.test.tsx tests/integration/ui --runInBand`、`npx tsc --noEmit`、`npx eslint src/app src/features/auth`。`grep -rn --include='*.ts' --include='*.tsx' --exclude-dir=graphify-out "redirect_to" src` が**注釈・古いメールの互換の説明と `src/contexts/LoginContext.tsx`（Task 7 で直す）を除き 0 件**、同じ形の `grep … "'/account'" src/app/api/auth` が 0 件。

**検証コマンド:** 上の 3 つ。

---

## Task 7: 画面（入口のリンク・`next` の受け渡し・Google の開始）

**Files:**
- Create: `src/features/auth/return-intent/use-login-href.ts`
- Modify: `src/contexts/LoginContext.tsx`（`src/lib/browser-location.ts` は触らない。既存の `navigateBrowser` を使う）
- Modify: `src/app/login/page.tsx`、`src/components/AuthTabs.tsx`、`LoginModal.tsx`、`RegisterModal.tsx`、`Header.tsx`
- Modify: `src/app/account/page.tsx`、`src/app/account/orders/[id]/page.tsx`、`src/app/account/orders/[id]/return/page.tsx`
- Create: `tests/unit/features/auth/return-intent/use-login-href.test.tsx`
- Modify: `tests/unit/components/{LoginContext,LoginModal,RegisterModal,AuthTabs,Header}.test.tsx`、`tests/integration/ui/auth-login-form-screen.test.tsx`・`auth-register-form-screen.test.tsx`・`auth-register-flow.test.tsx`・`auth-oauth-flow.test.tsx`、`tests/unit/app/login/*.test.tsx`（`/login` 頁）、`/account` 系の画面試験

**Interfaces:**

```ts
// use-login-href.ts  ('use client'; @impl IMPL-AUTH-210 / @design DD-AUTH-036)
export function buildLoginHref(path: string | null | undefined, origin?: string): string;
// 確かめ（validateReturnPath、origin 省略時は window.location.origin）を通った時だけ `/login?next=<encodeURIComponent(path)>`、外れたら '/login'
export function useLoginHref(): string;
// usePathname() で初期値を作り（サーバーの描画と一致させる）、マウント後と pathname の変化で window.location.search を足して更新する。
// useSearchParams は使わない（静的な頁で Suspense が要るため）

// LoginContext
login(email, password, turnstileToken?, options?: { next?: string })
register(email, password, turnstileToken?, options?: { next?: string })
loginWithGoogle(params?: { next?: string })
// fetch('/api/auth/oauth/start', { method:'POST', credentials:'same-origin', cache:'no-store',
//   headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ provider:'google', ...(next ? { next } : {}) }) })
// 200 かつ body.url が文字列で、new URL(body.url) の protocol が 'https:' か 'http:' → navigateBrowser(body.url)、{ success:true }
// それ以外（非 200・形が違う・投げる）→ { success:false, error }（今の失敗の文言の形に合わせる）。
// フォームの POST にしない理由は P2（CSP の form-action 'self' がリダイレクトの先にも当たる）
```

**仕様:**

- `/login` 頁（サーバー）: `params.next`（文字列）を `validateReturnPath` に通し、通った `path` だけを `AuthTabs` の `returnTo` に渡す（外れたら `undefined`。値を画面に出さない）。保留の Cookie が有効なら今までどおり `/login/verify` へ。
- `AuthTabs`: `returnTo?: string` を受け、`LoginModal`・`RegisterModal` に渡す（タブを替えて URL から `next` が消えても状態で持つ）。
- `LoginModal`: `login(email, password, token, { next: returnTo })`、Google は `loginWithGoogle({ next: returnTo })`（今の `{ next: "/auth/verified" }` をやめる）。`RegisterModal`: `register(…, { next: returnTo })`、Google も同じ。`register` の本文は `{ email, password, turnstileToken, next }`（`redirect_to: '/auth/verified'` をやめる）。
- `Header`: ログインのリンクを `href={loginHref}`（`useLoginHref()`）に。`/login` 自身・`/auth/*` にいる時は `next` を付けない（`buildLoginHref` の除外で `'/login'` になる）。
- `/account` の門 3 か所: `Button href="/login"` を `href={loginHref}` に。

- [ ] **Step 1（RED）: `use-login-href` の単体試験。** 試験名の先頭は `DD-AUTH-036 `。`next/navigation` の `usePathname` を差し替え、`window.history.pushState` で検索条件を作る。確かめ: `/stockist` + `?from=e2e` → `'/login?next=%2Fstockist%3Ffrom%3De2e'`、`/item/3` + `?color=red#x`（fragment は `location.search` に含まれない）→ `'/login?next=%2Fitem%2F3%3Fcolor%3Dred'`、`/login`・`/auth/verified`・`/api/x`・`/unknown` → `'/login'`、`buildLoginHref('//evil.example')` → `'/login'`、初回の描画（サーバーと同じ）は検索条件を含まず、効果の後に含む、`pathname` が変わると更新される。
- [ ] **Step 2（RED）: 画面・文脈の試験を足す・直す。** 
  - `LoginContext`: `login(…, { next:'/item/3' })` が `fetch('/api/auth/login')` の本文に `next` を含める。`next` 無しは本文に `next` を含めない。`register` も同じ。`loginWithGoogle({ next:'/account' })` が `fetch('/api/auth/oauth/start', { method:'POST' … })` を本文 `{ provider:'google', next:'/account' }` で呼び、応答の `url` で `navigateBrowser` を呼ぶ（`/api/auth/oauth/start?…` の GET への `navigateBrowser` は呼ばない）。`next` 無しは本文が `{ provider:'google' }` だけ。応答が 502・`url` 無し・`url:'javascript:alert(1)'`・fetch が投げる → `navigateBrowser` を呼ばず `{ success:false }`。`startsWith('/')` の独自の確かめを消す（サーバーが確かめる）。
  - `/login` 頁: `?next=%2Fitem%2F3%3Fcolor%3Dred` → `AuthTabs` に `returnTo='/item/3?color=red'`、`?next=//evil.example`・`?next=/login`・`?next[]=x`（配列）→ `returnTo` が `undefined`。
  - `AuthTabs`・`LoginModal`・`RegisterModal`: `returnTo` が `login`・`register`・Google のそれぞれに渡る。タブを替えても保たれる。
  - `Header`: ログインしていない時のリンクが `/login?next=…`（`usePathname` を `/stockist` に）、していない かつ `/login` では `/login`。
  - `/account` の門: 未ログインの `ログイン` ボタンの `href` が `/login?next=%2Faccount`（注文の詳細は `%2Faccount%2Forders%2F<id>`、返品は `…%2Freturn`）。
  試験名の先頭は既存の様式に合わせた ID（画面の試験は `SCR-AUTH-001`・`SCR-AUTH-002`・`SCR-AUTH-003`・`SCR-AUTH-009`、結合の文脈は `FLOW-AUTH-001`〜`003`）。
- [ ] **Step 3: 実装して GREEN。** 編集のたびに `npx tsc --noEmit`。
- [ ] **Step 4: 確かめ。** `npx jest tests/unit/components tests/unit/app tests/unit/features/auth tests/integration/ui --runInBand`（他の波が壊している試験があれば、自分の変更によるものか `git stash` ではなく**変更前のコードを読んで**切り分け、自分のものだけ直す）、`npx tsc --noEmit`、`npx eslint src/components src/contexts src/app src/features/auth`。

**検証コマンド:** 上の 3 つ。

---

## Task 8: `/auth/callback` の削除・E2E・文書の締め・最終確認

**Files:**
- Delete: `src/app/auth/callback/page.tsx`、`tests/unit/app/auth/auth-callback-page.test.tsx`、`tests/integration/ui/auth-callback-screen.test.tsx`
- Create: `e2e/FR-LOGIN-038-login-return-to.spec.ts`
- Modify: `e2e/FR-LOGIN-030-session-cookies-and-responses.spec.ts`（`SEC-AUTH-026-AC-01` の反転）、`e2e/FR-LOGIN-002-google-oauth.spec.ts`、`e2e/FR-SIGNUP-003-signup-confirm-link.spec.ts`、`e2e/FR-LOGIN-034-…spec.ts`、必要なら `e2e/member-session-helpers.ts`（`loginAsMember` に省略可能な `next` を足す。既定の動きは変えない）
- Modify: 文書（下）、台帳、`tests/unit/**` で `/auth/callback` を指す物

- [ ] **Step 1: 画面と試験を消す。** 3 つのファイルを Bash の `rm` で削除する（パスを 3 つ明示。他に触らない）。`grep -rn --include='*.ts' --include='*.tsx' --exclude-dir=graphify-out "auth/callback" src tests e2e` の残りを直す: `tests/integration/api/auth/{oauth-callback,oauth-start}.test.ts`・`tests/integration/api/auth-bot-rate-limit.test.ts`・`tests/integration/ui/auth-oauth-flow.test.tsx`・`tests/unit/api/auth/{oauth-callback-route,oauth-start-route}.test.ts` は `/api/auth/oauth/callback` の文字列に当たっているだけの物は残す。**画面 `/auth/callback` を指す物だけ**を消す・直す。`npx tsc --noEmit`。
- [ ] **Step 2: 文書の廃止と締め。**
  - `SCR-AUTH-008` と `DD-AUTH-006` を**廃止**（状態 `廃止`、番号は使い回さない）。`IMPL-AUTH-122` のコードは消えたので、`DD-AUTH-006` の本文に「2026-10-25 に画面ごと削除した（SEC-AUTH-026、ADR-0412）」と書く。廃止の項目を指す `retired-reference` を 0 件にする（`FLOW-AUTH-002` ほかの上位から外す）。
  - `docs/02_Requirements/areas/auth.md`・`docs/03_BasicDesign/areas/auth.md`・`docs/04_DetailDesign/sequence/auth-oauth.md` の `/auth/callback` の記述を直す。`docs/03_BasicDesign/architecture/auth-structure.md`・`system-overview.md`・`docs/03_BasicDesign/ui/design-guide.md` の `/auth/callback` は `git status --short` で G-3 が変更中でなければ直す。G-3 が変更中の物（`ui/screen-list.md`・`ui/screen-flow.md`・`api/api-spec.md`・`api/route-inventory.md`）は**直さず**、直す行の一覧を報告に書く（G-3 のコミット後に controller が当てる）。`docs/05_Quality/reviews/security/security_review_auth_callback.md`・`uiux_review_auth_callback.md` などの過去のレビュー記録は書き換えない（日付付きの記録）。
  - 台帳 `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`: W-08 の SEC-AUTH-026 の行と「追跡の仕組み」の行の状態欄に「波 1-A で直した（画面を削除、確かめの部品に置換、戻り先の控えを追加。2026-10-25、本番の DB 適用は G-3 の後）」を書く（G-3 が同じ台帳を変更中なら、`git diff` を読んでから該当の 1 行だけを `Edit`）。
  - `docs/superpowers/plans/` のこの計画の先頭は変えない。
- [ ] **Step 3: E2E を書く（流さない）。** 

**`e2e/FR-LOGIN-038-login-return-to.spec.ts`:** 既存の様式（`FR-LOGIN-030` のヘルパー、`createTestMember`・`loginAsMember`・`uniqueSourceIp`、`viewports` の 3 つ）に合わせる。`loginAsMember` の実装（`e2e/member-session-helpers.ts:110`）を**先に読み**、確認コードの取り方を共通にする。UI 経由のログインで `next` を通すため、`/login?next=…` を開いて画面から送る補助関数を spec の中に書く（共有ヘルパーの既定の動きは変えない）。画面の幅ごとに実行する（`for (const viewport of viewports)`）。重い管理者の流れは、`FR-LOGIN-030` と同じ理由で 1 つの幅だけにしてもよいが、その場合は spec の冒頭に理由を書く（CLAUDE.md の 3 幅の決まりの例外として controller の確認を取る）。試験名の先頭は受け入れ条件の ID。

| 試験名の先頭 | 手順と主張 |
| --- | --- |
| `FR-AUTH-005-AC-01` | ログアウト状態で `/stockist?from=e2e` を開き、ヘッダーのログインを押す（`href` が `/login?next=%2Fstockist%3Ffrom%3De2e`）。会員でログイン（確認コードまで）し、`expect.poll` で `new URL(page.url())` の `pathname + search` が `/stockist?from=e2e`、`hash` が空 |
| `FR-AUTH-005-AC-02` | ログアウト状態で `/account` を開き、門の「ログイン」を押す。ログインし終えると `pathname === '/account'` |
| `FR-AUTH-005-AC-03` | `/login` を直接開いてログイン → `pathname === '/'` |
| `FR-AUTH-005-AC-04` | `/login?next=//evil.example` と `/login?next=%2F%09%2Fevil.example` を開いてログイン → `pathname === '/'`、`evil.example` への要求が 0 件（`page.route` で止めて記録）、店のサイトの外へ移っていない（`framenavigated`）。さらに `POST /api/auth/login`（`page.request.post`）に `next:'//evil.example'` を直接送り、応答の Set-Cookie に `sb-return-intent` が `Max-Age=0` で付く |
| `FR-AUTH-005-AC-05` | 管理者（`createAdminSessionActor` ではなく、TOTP まで本物で通す既存の補助 `FR-LOGIN-032` を見本にする）で `/login?next=%2Fitem` を開いてログインすると、確認コードの後に `/auth/verified`（TOTP の入力）に着き、TOTP を通すと `pathname === '/item'`。戻り先が無い管理者は TOTP の後に `/admin` |
| `FR-AUTH-005-AC-06` | `/login?next=%2Flogin` と `?next=%2Fapi%2Fauth%2Fme` と `?next=%2Fauth%2Fverified` でログイン → `pathname === '/'` |
| `FR-AUTH-005-AC-07` | 先に `page.route('**/api/auth/post-login', (route) => route.abort())` で画面からの `post-login` を止め、`/login?next=%2Fstockist` からログインする（画面は失敗の既定で `/auth/verified` → `/` に倒れ、控えは使われずに残る）。その後で `page.request.post('/api/auth/post-login')` を 2 回続けて呼ぶ（`page.route` は `page.request` に掛からない）。1 回目は `redirectTo:'/stockist'`、2 回目は `redirectTo:'/'`。1 回目の応答の Set-Cookie で `sb-return-intent` が `Max-Age=0` |
| `SEC-AUTH-026-AC-02` | 未ログインで `GET /api/auth/confirm?redirect_to=%2F%09%2Fevil.example`（`maxRedirects:0`）→ 303、`Location` の origin が店と同じ（`/login`）。`redirect_to=//evil.example` と `/.//evil.example` も同じ |
| `SEC-AUTH-026-AC-03` | `POST /api/auth/login` に `next:'//evil.example'` を送って成功させ、確認コードまで進めて `pathname === '/'`（AC-04 と重ならない形で、API だけで完結させるなら `page.request` を使う） |
| `SEC-AUTH-032-AC-01` | `next=/stockist` 付きでログインを始めた直後の応答の `Set-Cookie` を `parseSetCookie`（FR-LOGIN-030 のもの）で読み、`sb-return-intent` が `httponly`・`samesite=lax`・`path=/`・`max-age=900`。値が 43 文字の base64url。ログイン中に踏んだ URL・`Location`・応答の本文に値が含まれない（`page.on('request')` と応答の本文を全部集めて文字列検索） |
| `SEC-AUTH-032-AC-02` | `next` 付きで保留（確認コードの入力前）まで進み、`POST /api/auth/login/cancel` と、ログインを終えた後の `POST /api/auth/logout` の両方の応答で `sb-return-intent` が `Max-Age=0` |

Google の本物の画面は開かない。`oauth/start` の POST は `page.request.post('/api/auth/oauth/start', { data:{ provider:'google', next:'/stockist' } })` で 200、本文の `url` が Supabase の authorize URL、`sb-return-intent` の Set-Cookie があり、その値が本文に含まれないことだけを書く（名前は `SEC-AUTH-032-AC-01 …Google の開始でも…`）。

`page.request.post` で状態を変える窓口（`/api/auth/*` の POST）を叩く所は、proxy の Origin 検査に通るよう `FR-LOGIN-030` と同じく `Origin` の見出し（`originOf(baseURL)`）を付ける。付け忘れると 403 になり、実装の欠陥と取り違える（レビューで追加）。

**既存 E2E の更新:**

- `FR-LOGIN-030…:341`: `test.fail(true, …)` を外し、試験を書き換える（名前の先頭は `SEC-AUTH-026-AC-01` のまま）。内容: ログイン済みで `page.goto('/auth/callback?next=//evil.example')` → 応答の状態が 404、`evil.example` への要求が 0 件、店のサイトの外へ移らない。ファイル冒頭のコメント（3・8 行目）の「今は赤になるのが想定」を消す。3 つの幅は維持。
- `FR-LOGIN-002…:31`: 開始の応答の状態を `302` → `200` に（ボタンは `fetch` の `POST` を送り、本文の `url` へ端末が移る。P2）。`waitForResponse` の条件に `response.request().method() === 'POST'` を足す。後半の `prompt=select_account` の確かめはそのまま（CSP の `form-action` に止められずに Google へ移ることの確かめにもなる）。
- `FR-SIGNUP-003…`（`:122`・`:234`・`:330`・`:361` 付近）: `redirect_to` を付けて確認のリンクを開く補助とアサーションを、「`register` の `next` で控え、同じ端末の Cookie 付きで開く」形に直す。**`:344` の `SEC-AUTH-007-AC-01` の `test.fail` は触らない**（別の波）。他のブラウザ（Cookie 無し）で開く試験の期待を `/` に直す。
- `FR-LOGIN-034…`・`FR-ACCOUNT-*`・`account-test-utils.ts` の「ログインの直後に `/account` に着く」前提: `grep -rn "waitForURL.*account\|toHaveURL.*account" e2e` の各行を読み、ログイン直後の着地を待っている所だけを `/`（または戻り先）に直す。ログイン後に自分で `goto('/account')` している所は触らない。
- `ADMIN` 系の補助が `/auth/verified` → `/admin` の移動を待っている所（`FR-LOGIN-032` など）は、戻り先が無ければ今までどおり `/admin` なので触らない。

- [ ] **Step 4: 試験の整合。** E2E は流さない。`npx tsc --noEmit`（`e2e/` が型検査の対象なら含めて）、`npx playwright test --list e2e/FR-LOGIN-038-login-return-to.spec.ts`（サーバーを起動せず**一覧だけ**。`webServer` が起動する構成なら実行しない。その場合は `npx tsc --noEmit` と `npx eslint e2e/FR-LOGIN-038-login-return-to.spec.ts` だけにする）。
- [ ] **Step 5: 追跡の最終確認。** 順に流す（失敗したら該当タスクの範囲で直す）。
  1. `npm run validate-trace -- AUTH`: 基準（`scripts/trace/baseline.json`）より**増えた違反が 0 件**であること（`missing-child`・`untagged-test`・`unknown-test-id`・`bad-design-link`・`duplicate-impl`・`retired-reference` を重点的に）。承認なしに `--update-baseline` しない。
  2. `$env:TRACE_AREAS='AUTH'; npm run test:trace-coverage`（PowerShell。単体を流して範囲内のファイルの分岐の網羅を測る）: 新しい 4 ファイルの届かない分岐を、書き足せるテストで埋める。型の上で起きない道だけを `docs/05_Quality/reports/test-gaps.md` の「届かない分岐」節に 1 行ずつ理由を書いて載せる。
  3. `npm run validate-docs`。
  4. `npm run trace:report`: 生成物（`docs/05_Quality/reports/trace-matrix.md`・`test-gaps.md`・`unused-code.md`）を作り直す。**`git status --short` でこれらが G-3 の変更中なら流さず**、controller に任せる旨を報告に書く。
  5. `npx tsc --noEmit`、`npx eslint .`（自分の触ったファイルに限った誤りが 0 件）、`npx jest tests/unit tests/integration --runInBand --testPathIgnorePatterns tests/integration/db`（DB 以外。他者の赤は触らず報告）。
  6. `grep -rn --include='*.ts' --include='*.tsx' --exclude-dir=graphify-out "sanitizeRedirectPath\|submitBrowserForm" src tests e2e` が 0 件。`grep -rn --include='*.ts' --include='*.tsx' --exclude-dir=graphify-out "/auth/callback" src tests e2e | grep -v "oauth/callback"` の残りが `FR-LOGIN-030` の 404 の試験だけ。
- [ ] **Step 6: controller への引き渡し。** 報告に次を含める: 変更したファイルの一覧、G-3 が変更中のため直さなかった文書と行の一覧、流していない物（E2E 全体・DB 結合試験・`db reset`・本番適用）と、その順番の推奨（①G-3 が済む ②`db reset` ③`auth_return_intents` の DB 試験 ④ E2E `FR-LOGIN-038`・`030`・`002`・`SIGNUP-003`・`LOGIN-034`・`ACCOUNT-*` ⑤本番適用は G-3 の本番適用の後）、確認を求める点（前提の読み P1・P2・P4・P5、E2E の幅の例外を使ったか）、Task 3 の報告にある `docs/06_Operations/db-migrations.md` の節を G-3 のコミットの後に当てること。

**検証コマンド:** Step 5 の 6 項目。

---

## 決定との対応（Spec coverage）

| 決定 | 実装・確認するタスク |
| --- | --- |
| 1. `/auth/callback` の画面を消す。Google の戻りは `/api/auth/oauth/callback` | Task 8（削除）、Task 6（callback route）。`SEC-AUTH-026-AC-01` の E2E を 404 に反転 |
| 2. 戻り先の規則（会員頁・ヘッダー・既定 `/`・管理者は 2 段目の後・`/login` 等はホーム） | Task 2（確かめ）、Task 4（解決）、Task 6（出口）、Task 7（リンク）。`FR-AUTH-005-AC-01`〜`06` |
| 3. サーバーに控え、番号だけを HttpOnly の Cookie | Task 3（表・関数）、Task 4（番号・Cookie）、Task 5（作る）。`SEC-AUTH-032` |
| 4. 戻ってよい頁の一覧と `/admin` | Task 2（許可リストと viewer）、Task 4（出口の確かめ） |
| 確かめの部品（1〜6） | Task 2。入口 Task 5、出口 Task 4・6 |
| 控えの仕組み（表・番号・期限・作る時・使う時・失敗・掃除・ログアウト・監査・別ブラウザ） | 表・掃除: Task 3／番号・期限・Cookie・監査: Task 4／作る時: Task 5／使う時: Task 6／失敗は `/`: Task 4・6／ログアウト: Task 5／別ブラウザ: Task 6（P4） |
| 範囲の決まり（要件・SEC-AUTH-026・脅威・構造・詳細・ADR・E2E・移行の時刻・`sanitizeRedirectPath` の置換） | Task 1・2・3・8 |

## 自己レビュー

実装前に書いた者が、次を確かめた。実装者・レビュアーは同じ項を再確認する。

| 観点 | 確認 |
| --- | --- |
| 決定の抜け | 上の対応表で決定 1〜4・確かめの 1〜6・控えの仕組みの各項に、タスクと確認方法がある。ユーザーの依頼の「ヘッダー・`/account` の門・members-only 頁が `?next=` を渡す」「ログインの頁が POST へ `next` を転送」「管理者・サポーターは先に `/auth/verified`」も Task 5〜7 に入れた |
| 入口が 3 つ（login・oauth/start・register） | `oauth/start` は今 `GET`。決定 3 の「GET では作らない」に合わせて `POST`（JSON・200 `{ url }`）を足し、`GET` は控えを作らない形にした（前提 P2。フォームの POST＋303 は CSP の `form-action 'self'` で止まるので採らない）。controller の確認事項として報告する |
| 出口が 4 つ（OTP・2 段目・Google・確認のリンク） | OTP と 2 段目は端末が移すので `POST /api/auth/post-login` に集約（Task 6）。Google と確認のリンクはサーバーの 303 の場所で使い切る。出口の数を増やさず、役割と aal2 の確かめを 1 か所（`resolveReturnDestination`）にした |
| 順序の依存 | Task 1（文書の ID）→ 2（部品）→ 3（DB）→ 4（保存・解決）→ 5（入口）→ 6（出口）→ 7（画面）→ 8（削除・E2E・締め）。各タスクで `tsc` が通る（Task 2 で `sanitizeRedirectPath` を新部品に置き換えて穴を先に塞ぎ、Task 5・6 で URL を読む作りを消す）。Task 7 の前に `loginWithGoogle` を `GET` で呼ぶ画面は残るが、`GET` は動く（戻り先が無いだけ）ので壊れない |
| 名前・型の一貫 | `validateReturnPath`・`sanitizeReturnPath`・`issueReturnIntent`・`resolveReturnDestination`・`applyReturnIntentCookie`・`createReturnIntent`・`consumeReturnIntent`・`returnIntentCookieName`・`create_auth_return_intent`・`consume_auth_return_intent`・`private.auth_return_intents`・`POST /api/auth/post-login` を全タスクで同じ綴りにした |
| テスト名の ID | 単体は `DD-`、結合（API・画面・DB）は `API-`・`SCR-`・`FLOW-`・`DATA-`、E2E は受け入れ条件の ID。ファイルは AUTH の範囲の型に合う（`scope.json` の追記を Task 1 に入れた） |
| 禁止事項 | コミットしない・E2E/サーバー/DB 結合試験/`db reset` を流さない・G-3 の変更中のファイルを編集しない・`tsc` を編集のたびに流す、を Global Constraints に書いた |
| 未確認 | `loginAsMember` の確認コードの取り方、`persistSessionAndCookies` 直後の `aal` の取り方（交換直後は aal1 固定でよいとした）、`NEXT_PUBLIC_SITE_URL` が単体の環境で未設定の時の `getSiteUrl()` の既定（`http://localhost:3000`）、手元の Supabase に `pg_cron` が入っているか（`20260911235714` が前提にしている）、E2E の管理者の TOTP を通す補助の有無（`FR-LOGIN-032` を見本にする）は、実装者が着手時に読んで確かめる。食い違えば止めて報告する |
| 範囲外に残したもの（レビューの後も同じ） | `SEC-AUTH-007`（確認のリンクを別の端末で開いた時にセッションを作らない）、`SEC-AUTH-005/031` の aal の確かめ、`/api/auth/me` の no-store、`GuestRegisterPrompt` の `next` 付与、`LoginModal` の Header 内の開閉（`loginOpen` は今も使われていない） |

## 計画のレビュー

2026-10-25、Opus（計画のレビュアー）。決定文（`wave1a-decisions.md`）と今のコード（`src/lib/redirect.ts`、`src/app/api/auth/{login,oauth/start,oauth/callback,confirm,register,logout,otp/verify}/route.ts`、`src/contexts/LoginContext.tsx`、`src/app/login/**`、`src/app/auth/verified/page.tsx`、`src/app/account/page.tsx`、`src/components/Header.tsx`、`src/proxy.ts` の CSP、`src/lib/auth/authenticate.ts`、`tests/unit/migrations/`）を突き合わせた。Supabase の文書は MCP の `search_docs` で Database Functions の「Function privileges」と lint 0028・0029 を読んだ。

### 直した所

| # | 重さ | 見つけたこと | 直した所 |
| --- | --- | --- | --- |
| 1 | 高 | Google の開始を `<form method="post">` → 303 で外へ移す案（P2）は、`src/proxy.ts` の CSP `form-action 'self'` に止められる。Chrome・Firefox はフォームの送信に続くリダイレクトの先にも `form-action` を当てるので、Supabase・Google への 303 が全部の端末で止まり、Google のログインが壊れる。`proxy.ts` は触らない約束 | P2・Architecture・Task 5（`POST` は JSON を受けて 200 `{ url }`）・Task 7（`fetch` → `navigateBrowser`。`submitBrowserForm` をやめ `browser-location.ts` を触らない）・Task 8（`FR-LOGIN-002` は 200、Google の E2E は `data`）・ファイルの全体像・自己レビュー |
| 2 | 高 | `oauth/callback`・`confirm` は保存（`persistSessionAndCookies`）の**前に** 303 の応答を作っている。「保存の後で使い切る」と「その行き先へ 303」を同時に満たす作り方が計画に無く、実装者が保存の前に使い切ると保存の失敗で戻り先が焼ける | Task 6 に「応答は既定で先に作り、保存の成功の後に `Location` を差し替える。失敗の枝では使い切らない」の段落と試験を足した |
| 3 | 高 | `docs/06_Operations/db-migrations.md` は G-3 が変更中。挿入だけでも同じファイルに 2 つのセッションの差分が乗り、G-3 のコミットに波 1-A の節が混ざる（「G-3 のファイルに触らない」に反する） | Global Constraints・Task 3・ファイルの全体像・Task 8 の引き渡し: 実装者は編集せず、節の全文を報告に返し、controller が G-3 のコミットの後に当てる |
| 4 | 中 | `login`・`register` のスキーマの `next: z.string().max(2000)` は、`next: 123` や長すぎる値でログイン・登録そのものを 400 で止める（決定「ログインそのものは止めない」に反する） | `next: z.unknown().optional()` にし、型・長さは `validateReturnPath` で断って Cookie を消す。試験を足した |
| 5 | 中 | 確認コードの確定の後に `post-login` が落ちた時の既定が `/` だと、管理者・サポーターが 2 段目を通らずに着地する | `VerifyOtpClient` の失敗の既定を `/auth/verified`（一般は `/` へ、特権は TOTP へ倒れる）に。`/auth/verified` で `needsMfa:true` が返った時は TOTP の入力を出す（止まらない） |
| 6 | 中 | `issueReturnIntent`・`resolveReturnDestination` が例外を投げない約束が無く、監査や rpc の例外でログインが 500 になりうる。出口の確かめが DB の値の改ざんに効くことを試す項目が無い | Task 4 に「例外を投げない」の約束と、保存の値が `//evil.example`・`/login`・`/%09/evil.example` の時に既定へ倒れる試験を足した。Cookie が無い時（keep）と壊れている時（clear）の書き分けを直した |
| 7 | 中 | DB の試験は流せないので、移行の権限の行を確かめる試験がこの波の中で 1 本も流れない | `tests/unit/migrations/auth-return-intents.test.ts`（文面の単体試験。DB なし）を Task 3 に足し、既存の `security-definer-search-path-guard.test.ts` も流す。`scope.json` に型を足した |
| 8 | 低 | 移行の関数の `REVOKE` が `service_role` から外していない（先例 `order_status_links` と違う）。`consume` に `_user_id` が NULL で来ると CHECK の 23514 | `REVOKE … FROM PUBLIC, anon, authenticated, service_role` → `GRANT EXECUTE … TO service_role`。`consume` を `STRICT` に。`public` に置く理由と Supabase の出典（lint 0028・0029、Function privileges）を書いた |
| 9 | 低 | `confirm` は `signup` 以外の印（`magiclink`・`recovery`・`email`）も受ける。登録の控えを登録以外の確認で使い切る | `otpType !== 'signup'` の時は使い切らず既定 `/`。試験を足した |
| 10 | 低 | P4 は決定の文面（別のブラウザは `/login`）とずれているのに、ずれの理由と確かめの時機が無かった | P4 にずれと理由を明記し、controller が Task 6 の前にユーザーに確かめる手順にした |
| 11 | 低 | 決定の「デコードの後も同じ検査」で `/search?q=black%20coat` は断られる（既定 `/` へ）。計画の表に無く、実装者が「直す」恐れ | Task 2 の表に `%20`（断る）と `+`（通す）の行を足し、決定どおりの挙動と明記した |
| 12 | 低 | Task 2 の置換で `confirm` だけは途中の着地が変わる（`/auth/verified` を経ず `/account` へ）。計画は「見た目は変わらない」と書いていた | Task 2 Step 3 に例外として書き、直す試験を挙げた |
| 13 | 低 | `grep -rn … src` は `src/graphify-out` の写しに当たり、「0 件」の確かめが通らない。`[^/]auth/callback` の形は `/api/auth/oauth/callback` にも当たる | 全部の grep を `--include='*.ts' --include='*.tsx' --exclude-dir=graphify-out` にし、`/auth/callback` は `grep -v oauth/callback` で外す形にした |
| 14 | 低 | E2E の `page.request.post` は Origin を付けないと proxy の Origin 検査で 403。`FR-AUTH-005-AC-07` の手順が曖昧 | Task 8 に Origin の見出しの注意を足し、AC-07 を `page.route` で画面の `post-login` を止めてから API を 2 回呼ぶ形に直した |
| 15 | 低 | `post-login` の 401/503 を自前で書く案は、`/api/auth/me` と同じ部品 `authFailureResponse` があるのに使っていない | `authFailureResponse(reason)` を使う形にした |

### 確かめて直さなかった所

- 決定 1〜4・確かめの 1〜6・控えの仕組みは、上の直しの後も「決定との対応」の表のとおり全部にタスクがある。
- 番号は空いている（`SR-AUTH-007`・`FR-AUTH-004`・`SEC-AUTH-031`・`THR-AUTH-031`・`ARC-AUTH-009`・`STATE-AUTH-005`・`API-AUTH-018`・`DATA-AUTH-004`・`DD-AUTH-031`・`IMPL-AUTH-205`・`ADR-0411`・`FR-LOGIN-037`・移行 `20261025100130` が今の最大）。
- 番号は URL・本文・`Location` に出ない（Cookie だけ）。使い切りは `UPDATE … WHERE consumed_at IS NULL AND expires_at > now() RETURNING` の 1 文で、同時の 2 回目は行の鍵の待ちの後に条件を評価し直して NULL になる（DB の並行の試験で確かめる）。番号は HttpOnly の Cookie だけで持つので端末に結び付く。
- 出口の確かめ（`resolveReturnDestination` → `validateReturnPath(path, { viewer })`）は claims の `app_metadata.role` と `aal` を使う（`ADR-0409` と同じ根拠）。特権で aal2 でない時は使い切らない。
- タスクの順は、各タスクの後で `tsc` が通る（Task 5 で register のスキーマから `redirect_to` を消しても、`LoginContext` が送る `redirect_to` は Zod が捨てるだけ。Task 7 まで Google は GET のまま動く）。
- 計画は G-3 の変更中のファイル（`git status --short` の一覧）に触らない（上の 3 の後）。
