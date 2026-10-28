# 波 4 共有の守り（送り元 IP の取り出し・回数の制限・認可の拒否の監査・監査の IP・管理画面の出し分け）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 守りの穴の設計（`design-final.md`）の波 4 を直す。(1) 送り元 IP を、Vercel が付ける見出しだけから取る共有の関数 `src/lib/request-ip.ts` の `getClientIp` を作り、`rateLimit.ts` の回数の制限の鍵と、取扱店・管理（ADMIN）・LOOK（・NEWS）の監査の IP をそれに替える。`x-forwarded-for` は読まない。`rateLimit.ts` の 429・503 に `Cache-Control: no-store` を付け、制限部品の読み込み失敗を握りつぶす `try/catch` は静的 import に替えて外す。E2E の送り元の分け方を `x-real-ip` に書き換え、E2E の固定の環境に `CLIENT_IP_HEADER` を入れる（R6、Q4: SEC-AUTH-013、SEC-SEARCH-006・020(a)、SEC-NEWS-011、SEC-LOOK-011、SEC-ADMIN-009、SEC-STOCKIST-012）。(2) 取扱店の 6 つの窓口を「送り元の枠 → 認可 → 操作者の枠 → CSRF」の順にする（R7: SEC-STOCKIST-020）。(3) 管理の監査を直す: 認可で断った要求（actor が分かる 403・失効した session の 401）を取扱店の窓口から監査に残し（`admin-rbac` に `denial` を足す）、管理の操作の監査に行為者のメール・IP・ブラウザの名乗りを残し、色見本の作成・削除を監査に残し、読み出しの記録に IP を足し、`maskAuditEvent` で制御文字を除く（R11 の 3〜7、Q13: SEC-ADMIN-022・023、SEC-STOCKIST-021、SEC-LOOK-020、SEC-NEWS-016 の改め）。(4) 管理画面の出し分けと欠けた機能（R16）: CONTACT タブを作る（FR-ADMIN-009）、LOOK の「新規作成」を権限（`canManage`）で出す（SEC-LOOK-019-AC-04）、取扱店の作成の頁の入口で権限を確かめる（SEC-STOCKIST-019）。

**Architecture:** 共有部品を触る波。`src/lib/request-ip.ts`（新規・追加のみ）を先に足し（Task 1）、`no-store` を付ける前に呼び手が本文を読み切るよう直し（Task 1b。独立で、先に入れても安全）、`rateLimit.ts` を替えるのと同じタスクで、**今 `x-forwarded-for` を読んでいて替える物**（取扱店の 4 か所・強制失効・2 要素のリセット・Turnstile の 3 か所）と、それらを送る単体・結合の試験の見出しを `x-real-ip` に直して木を緑に保つ（Task 2）。E2E の固定の環境（Task 3）、AUTH の `try/catch` の撤去（Task 4）、E2E の見出しの書き換え（Task 5・6・8・9・10）は領域ごとに分け、`test.fail` の印は**その反転に要る物が全部そろったタスク**で外す。`admin-rbac.ts`・`audit.ts` は追加だけ（Task 7）。CONTACT タブと LOOK の「新規作成」（R16 の画面側。`src/app/admin/page.tsx` を触る）は IP の作業と独立で、G-1 が「波 4 を先に入れてよい。CONTACT タブを先にコミットすれば H が合わせる」と答え済み（`wave4-decisions.md:26`）なので、**最初のタスク（Task 0）にして早くコミットする**。取扱店・ADMIN・LOOK・NEWS の窓口以外の `x-forwarded-for` の直読み 25 ファイルも、controller の裁定（`wave4-decisions.md:34`）で `getClientIp` に寄せる（非 G は Task 2b、G/H は Task 2c。checkout・cart を触る前に G-1 へ知らせる）。G/H の E2E 4 ファイルは G-1 に一覧を先に送るので別タスク（Task 12）にし、controller が最後の E2E を流す前に必ず済ませる。DB の移行はない。新しい窓口は `GET /api/admin/stockists/access` の 1 本だけ（Task 8）。

**Tech Stack:** Next.js `^16.3.6`（App Router・`proxy.ts`・Route Handler）、React `^19`、TypeScript、Supabase（`rate_limit_counters` の `ip inet`）、node の `net.isIP`、Jest（単体・結合）、Playwright（書くだけ。流すのは controller）。依存は増やさない。

**Spec:** [`.superpowers/sdd/2026-10-25-security-gap-fixes/wave4-decisions.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/wave4-decisions.md)（ユーザー答え Q4・Q13 と、推奨で進める Q20・Q22・Q14 D9・R6 同じ波。**この文書が拘束する**）。背景: 同ディレクトリの [`design-final.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md) の R6・R7（STOCKIST-020 だけ）・R11（1〜7）・R16 と §3-2 の波 4 の行・§3-3、領域別の `AUTH.md`・`ADMIN.md`・`STOCKIST.md`・`LOOK.md`・`NEWS.md`・`SEARCH.md`。前の波の計画（書式の見本）: [`2026-10-28-wave3-csp-images-session.md`](./2026-10-28-wave3-csp-images-session.md)（コミット `ea393ce4`）、[`2026-10-26-wave2-local-fixes.md`](./2026-10-26-wave2-local-fixes.md)。

---

## 概要

| 項目 | 内容 |
| --- | --- |
| 作成日 | 2026-10-28。コード・DB・テストは 1 行も変えていない（この計画の作成だけ。読んだのは `src/`・`tests/`・`e2e/`・`scripts/`・`supabase/migrations/`・`docs/` のみ） |
| 直す項目 | R6（SEC-AUTH-013、SEC-SEARCH-006・020(a)、SEC-NEWS-011、SEC-LOOK-011、SEC-ADMIN-009、SEC-STOCKIST-012、R10 の `rateLimit.ts` の 429・503）、R7 の SEC-STOCKIST-020、R11 の 3〜7（SEC-ADMIN-022・023(IP)・SEC-STOCKIST-021・SEC-LOOK-020・NEWS-016 の改め）、R16（FR-ADMIN-009、SEC-LOOK-019-AC-04、SEC-STOCKIST-019）。Q4・Q13・Q20・Q22・Q14 D9 |
| タスク | 16 つ（管理画面の頁 Task 0・共有の関数 Task 1・呼び手の本文読み切り Task 1b・`rateLimit.ts` と取扱店・AUTH の XFF の読みの切り替え Task 2・非 G の XFF の直読みの寄せ Task 2b・G/H の XFF の直読みの寄せ Task 2c・E2E の固定の環境 Task 3・AUTH の `try/catch` の撤去 Task 4・E2E の書き換え AUTH Task 5／SEARCH・NEWS Task 6・`admin-rbac`／`audit.ts` の追加 Task 7・取扱店 Task 8・ADMIN Task 9・LOOK／NEWS の監査 IP Task 10・G/H の E2E Task 12・controller の最終 Task 13）。**実行の順は Task 0 → 1 → 1b → 2 → 2b → 2c → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 12 → 13**（Task 11 は Task 0 へ移した欠番） |
| 新しいコード | `src/lib/request-ip.ts`、`src/lib/auth/audit-authz-denial.ts`、`src/app/api/admin/stockists/access/route.ts`（窓口が 1 本増える。共有文書の数の更新が要る: Task 8・13）、`tests/setupClientIp.js`（jest の環境） |
| 新しい ADR | `ADR-0416`（AUTH・送り元の IP は Vercel の見出しだけ。XFF は読まない。前段の中継は置かない前提）、`ADR-0462`（ADMIN・管理の操作の監査に IP を残す。`ADR-0010`・`ADR-0158` の「残さない」を置き換える）、`ADR-0268`（STOCKIST・認可の拒否の監査は actor が分かる物だけ、操作者ごとの上限）、`ADR-0269`（STOCKIST・作成の頁の入口の権限の確かめ）、`ADR-0166`（LOOK・「新規作成」は `canManage` で出し、権限の集合は `admin-rbac` が返す。`ADR-0161` の暫定を解く）。番号は書く直前に `ls docs/03_BasicDesign/decisions` で再確認する（今の各帯の最大: AUTH 0415・ADMIN 0461・STOCKIST 0267・LOOK 0165・NEWS 0026・SEARCH 0316） |
| 外す `test.fail` | 現在の行番号で 16 か所（各タスクの「E2E の印」に行ごとに書く）。設計書の行番号から動いている。「設計書の印と今の印」の表 |
| 触らない共有文書 | `requirements.md`・`test-spec.md`・作業と指摘の台帳・`api-spec.md`・`route-inventory.md`・`tests/unit/docs/*-traceability.test.ts`・`db-migrations.md`・`er.md`・`docs/03_BasicDesign/ui/screen-list.md`・`screen-flow.md`・`docs/04_DetailDesign/pages/16_admin.md`（G-4/H が触る）。必要な変更は各タスクの報告の「共有文書の変更案」に書き、controller が Task 13 で反映する |
| 流さないもの | E2E・サーバー・3000 番・DB 結合試験・`db reset`・全体の `jest`・`trace:report`・`test:trace-coverage`・`validate-trace --update-baseline`・`next build`。流してよい `jest` は `npx jest <ファイル>` の対象指定だけ。E2E は書くだけ |
| 本番 | 本番の配備はこの計画の範囲外。配備前に Vercel の最初の preview で偽の `x-real-ip` と偽の XFF を送り、Vercel が上書きすることを実測する（Task 13「本番の前の確認」） |

### 設計書の印と今の印（確かめた結果）

設計書の「確かめ方」の行番号は波 1〜3 の後で動いた。**現在の `e2e/` を読んで確かめた**。`grep -rnE "test\.fail" e2e` で、設計書が挙げた 29 か所のうち波 4 に残る物は 16 か所。

| 設計書 | 今 | 状態 | タスク |
| --- | --- | --- | --- |
| R6 `FR-LOGIN-035:228`（SEC-AUTH-013-AC-01、3 幅） | `FR-LOGIN-035:228` | 残っている | 5 |
| R6 `FR-SEARCH-022:282`（SEC-SEARCH-006-AC-01） | `FR-SEARCH-022:281` | 残っている（1 行ずれ） | 6 |
| R6 `FR-SEARCH-022:302`（SEC-SEARCH-020-AC-01、3 幅） | `FR-SEARCH-022:300` | 残っている（2 行ずれ） | 6 |
| R6 `FR-NEWS-SEC-003:219`（SEC-NEWS-011-AC-01） | `FR-NEWS-SEC-003:213` | 残っている（6 行ずれ） | 6 |
| R6 `FR-ADMIN-MISC-003:249`（SEC-ADMIN-009-AC-01） | `FR-ADMIN-MISC-003:248` | 残っている | 9 |
| R6 `FR-STOCKIST-015:284`（SEC-STOCKIST-012-AC-01） | `FR-STOCKIST-015:280` | 残っている | 8 |
| R6・R11 `FR-LOOK-SEC-004:433`（SEC-LOOK-020-AC-02） | `FR-LOOK-SEC-004:429` | 残っている | 10 |
| R7 `FR-STOCKIST-014:520`（SEC-STOCKIST-020-AC-01） | `FR-STOCKIST-014:520` | 残っている | 8 |
| R11 `FR-STOCKIST-014:550`（SEC-STOCKIST-021-AC-01） | `FR-STOCKIST-014:550` | 残っている | 8 |
| R11 `FR-ADMIN-MISC-005:373`（SEC-ADMIN-022-AC-01） | `FR-ADMIN-MISC-005:390` | 残っている（色見本は監査を一切書かない） | 9 |
| R11 `FR-ADMIN-MISC-007:414`（SEC-ADMIN-022-AC-02） | `FR-ADMIN-MISC-007:411` | 残っている | 9 |
| R16 `FR-STOCKIST-013:320`（SEC-STOCKIST-019-AC-01 の作成、3 幅） | `FR-STOCKIST-013:319` | 残っている | 8 |
| R16 `FR-STOCKIST-013:332`（SEC-STOCKIST-019-AC-02、3 幅） | `FR-STOCKIST-013:331` | 残っている | 8 |
| R16 `FR-ADMIN-MISC-006:242`（FR-ADMIN-009-AC-01、3 幅） | `FR-ADMIN-MISC-006:244` | 残っている | 0 |
| R16 `FR-ADMIN-MISC-006:262`（FR-ADMIN-009-AC-05、3 幅） | `FR-ADMIN-MISC-006:264` | 残っている | 0 |
| R16 `FR-LOOK-SEC-003:235`（SEC-LOOK-019-AC-04、3 幅） | `FR-LOOK-SEC-003:235` | 残っている | 0 |
| R7・R11 `FR-LOGIN-032:352,368,402`、`FR-SIGNUP-002:201`、`FR-ADMIN-MISC-007:290,315`、`FR-ADMIN-MISC-003:194,226`、`FR-ADMIN-MISC-002:164`、`FR-ADMIN-MISC-004:251`、`FR-STOCKIST-015:300,314`、`FR-NEWS-SEC-005:271` | なし | **波 1-B・1-C で外れた**。`FR-LOGIN-032:402,488` に残る印は ENV（TOTP の設定）で別件 | - |
| `FR-ADMIN-MISC-005:219`（SEC-ADMIN-002-AC-02）、`FR-LOOK-SEC-004:299`（SEC-LOOK-012-AC-03） | 残っている | 波 4 の範囲外（DB の aal2＝波 5、画像の量＝別件）。**外さない** | - |

## 前提の読み（決定文の解釈と、読んで確かめた事実。controller の確認を求める点を含む）

実装者はこの節を変えない。食い違いに気付いたら止めて報告する。

| # | 読み | 根拠・影響 |
| --- | --- | --- |
| P1 | **`rateLimit.ts` は 1 つの関数の中で送り元を決める**。`getIpFromRequest`（`src/features/auth/middleware/rateLimit.ts:4-16`）は非公開で呼び手は `enforceRateLimit`（`:19`）だけ。`x-forwarded-for` の左端 → `x-real-ip` → 無ければ `'127.0.0.1'`。`enforceRateLimit` の呼び手は **60 ファイル・98 呼び出し**（`grep -rn "enforceRateLimit(" src`、`graphify-out` を除く）。25 ファイル（30 か所）が `await import('@/features/auth/middleware/rateLimit')` で読み、そのうち **14 ファイル・19 か所**（全部 `src/app/api/auth/` 配下。`confirm`・`login/resend`・`login`×2・`mfa/enroll-totp`・`mfa/verify`×2・`oauth/callback`・`oauth/start`・`otp/verify`×2・`password-reset/confirm`・`link`・`request`×2・`post-login`・`refresh`・`register`×2）が `try/catch` で例外を握りつぶして**先へ進む**（`console.error('Rate limit middleware error ...')`）。残りの動的 import（`cart/add`・`cart/change`・`checkout/*`・`contact`・`news`・`search`・`suggest`・`checkout-route-guard`）は握りつぶさないので、この波では静的にしない（台帳） | 429 は `:27-45`、503 は `:45-66`。どちらも `Retry-After` だけで `Cache-Control` が無い |
| P2 | **設計書の「鍵は null のとき `'unknown'`」は DB に入らない**。`public.rate_limit_counters.ip` は `inet`（`supabase/migrations/20260901102912_remote_schema.sql:816-826`）、RPC の `_ip` も `inet`（`:1807-1811`）。`'unknown'` を渡すと `invalid input syntax for type inet` で RPC が失敗し、`enforceRateLimit` は全部 503 になる。一方、一意制約は `UNIQUE NULLS NOT DISTINCT (ip, endpoint, bucket)`（`20260913132105_fix_rate_limit_counters_subject_counting.sql:33-34`）で、`incrementCounter` は元から `effectiveIp: subject ? null : ip ?? null`（`src/features/auth/ratelimit/index.ts:20-31`）なので **`ip: null` は「送り元が分からない全員が 1 つの枠」になる**（設計の意図そのまま。「厳しい側に倒す」）。だから鍵は `string \| null` で、`null` をそのまま `incrementCounter` に渡す。**ruling 1（controller の確認）** | **現行の枠の事実（訂正）**: 見出しの無い E2E が `'127.0.0.1'` の枠を共有していたのではない。`next start` は見出しが無い時に XFF を接続元から付ける（`node_modules/next/dist/server/base-server.js:612` の `x-forwarded-for ??= socket.remoteAddress`）ので、今の鍵は接続元（`::1`・`::ffff:127.0.0.1` など）だった（`'127.0.0.1'` が鍵になるのは、XFF も `x-real-ip` も無い要求を直に渡す単体・結合の試験だけ）。新しい形では見出しの無い要求は全部が `ip null` の 1 つの枠になる。ブラウザと API の接続の族（IPv4／IPv6）が違って 2 つだった枠は 1 つにまとまる（Task 13 の新しい赤の見立て①）。後始末の SQL は IP の文字で消す物が無い（`grep -rn "127.0.0.1'" e2e` で確認済み。`order-status-test-utils.ts:105-106,292-297` は `ip=any(...) or (ip is null and endpoint=any(subject の枠))` で、素の `ip is null` の枠は触らない） |
| P3 | **`getClientIp(request?: Request): string \| null`**（`src/lib/request-ip.ts`、新規）: `process.env.VERCEL === '1'` か `process.env.CLIENT_IP_HEADER` が空でない時だけ、`x-vercel-forwarded-for` → `x-real-ip` の順に読む。値は `trim()` し `node:net` の `isIP` が 0 でなければ返し、それ以外（空・`foo`・`1.2.3.4, 5.6.7.8`・ポート付き）は **null（次の見出しへは進まない。最初に在った見出しの値が不正なら null）**。`x-forwarded-for` は読まない。`TRUST_PROXY_HEADERS` は読まない・使い回さない。`CLIENT_IP_HEADER` は**旗**として扱い、値は見ない（決定文のとおり。値の使い道は ruling 2） | 設計 R6-1〜4、決定 Q4(a)。`isIP` は IPv6 も通す（E2E の G/H の補助は `2001:db8:…` を使う: `return-request-test-utils.ts:55`、`order-status-test-utils.ts:345`） |
| P4 | **`redirect.ts` の `TRUST_PROXY_HEADERS` は別の意味で、変えない**。`shouldTrustForwardedHeaders`（`src/lib/redirect.ts:46-52`）が「`x-forwarded-host`/`proto` からオリジンを作ってよい」の判定に `TRUST_PROXY_HEADERS === 'true'` か `VERCEL === '1'` を使う。`src/proxy.ts:138-146` の退避も `x-forwarded-host` を読む。`tests/integration/api/auth/confirm.test.ts:77,135-138,539` と `auth-register-flow.test.tsx:286` がこの変数を立てる。**この波は `redirect.ts`・`proxy.ts` の該当部分・この変数を読む試験を 1 行も変えない**。`getClientIp` は `VERCEL === '1'` の条件を同じ文字で書くが、`TRUST_PROXY_HEADERS` は読まない | E2E で `TRUST_PROXY_HEADERS` を立てるとオリジンの決め方まで変わる（設計 R6-1）ので、新しい `CLIENT_IP_HEADER` を使う |
| P5 | **GoTrue（手元の Supabase の Auth）に送る XFF は、アプリの `getClientIp` と無関係で、そのまま残す**。`e2e/admin-session-test-utils.ts:62-72`（`uniqueSourceIp()` を `${env.url}/auth/v1/token` へ）、`e2e/home-grant-test-utils.ts:133`（`${SUPABASE_URL}/auth/v1/token`）、`e2e/news-test-utils.ts:165`（`createClient(...).auth.signInWithPassword` の `global.headers`）の 3 か所は GoTrue の IP の枠を避ける物で、設計 R6 も「GoTrue が IP の枠に XFF を使う証拠」とする。**書き換えない**。本番ではアプリのサーバーから GoTrue を呼ぶ時に利用者の IP を渡していない（`src` に GoTrue へ XFF を付ける所は無い）ので、GoTrue の IP の枠は店の全員で分け合う見込み（R17・開店前の確認。Task 13「本番の前の確認」） | `admin-session-test-utils.ts:58-59` の注に「x-forwarded-for を送り元に数える作りに頼る分離」とある。アプリの枠の話と GoTrue の枠の話を混ぜない |
| P6 | **`CLIENT_IP_HEADER` を手元の Supabase の時だけ有効にする仕組み**: `E2E_FIXED_ENV`（`scripts/e2e/environment.ts:54`）は `buildE2EOverrides`（`:133`）が**手元の Supabase の状態を読んだ後にだけ**混ぜ、`prepareE2EEnvironment` が `assertSafeE2EEnv`（`:169`）で確かめる。`computeServerFingerprint`（`:180-197`）は `fixed: Object.keys(E2E_FIXED_ENV)` を印に含める（`:194`）ので、**キーを足すと 3000 番の古いアプリは使い回されない**。**見張りは足さない**: `findUnsafeE2ESettings`（`:146-150`）は `NEXT_PUBLIC_SUPABASE_URL`／`SUPABASE_URL` が手元でなければ条件なしで既に止め、`scripts/e2e-server.mjs:91-92` の `findUnsafeSettings` も同じ。`CLIENT_IP_HEADER` は `buildE2EOverrides` の中でしか混ざらないので、『`CLIENT_IP_HEADER` が在るのに手元でない』は独立に効く場面が無く、足す見張りも試験も既存の条件だけで通ってしまう（何もしない）。最小は、『`E2E_FIXED_ENV` は `buildE2EOverrides` の中だけで混ぜ、既存の見張りが手元の Supabase を保証する』を文書（`deployment-topology.md`・`ADR-0416`・`E2E_FIXED_ENV` の注）に書くこと | 設計 R6「見張りで『手元の Supabase のときだけ有効』にする」は、既存の見張りが満たす（新しい見張りは足さない） |
| P7 | **XFF／`x-real-ip` を読む `src` は 33 ファイル・38 行**（`grep -rniE "x-forwarded-for\|x-real-ip" src`、`graphify-out`・`admin/news/route.ts:37` のコメントを除く）。この波で替えるのは次のとおり。**鍵**: `rateLimit.ts`（1 か所、98 呼び出し全部に効く）。**監査の IP を替える（現に XFF を読んでいる物）**: `admin/stockists/route.ts:80`、`admin/stockists/[id]/route.ts:108,235,355`、`admin/revoke-user-sessions/route.ts:76`、`admin/users/mfa/reset/route.ts:72`（4 ファイル・6 か所）。**Turnstile の `remoteip`**: `auth/login/route.ts:39`、`auth/password-reset/request/route.ts:44`、`auth/register/route.ts:77`（3 か所。`AUTH.md` が SEC-AUTH-013 の直す場所に挙げる。**ruling 4**）。**監査の IP を新しく足す（今は IP を書かない）**: ADMIN（`create-user`・`contact/*`・`audit-logs`・色見本）、LOOK（`admin-audit.ts`）、NEWS（`admin/news/route.ts:53`・`[id]/route.ts:53`。**ruling 3**）。**読み方だけ `getClientIp` に寄せる（25 ファイル。controller の裁定 `wave4-decisions.md:34`。保存先・変数名・使い方は変えず、読み方だけ。非 G 13 は Task 2b、G/H 12 は Task 2c）**: 管理 `accounting/product-costs:182`・`stripe-backfill:90`・`stripe-payouts/[id]/confirm:116`、`kpi/cost-profit:1575`・`receipt:151`、`role-permissions:71`、`settings/shop:250`、`users:196`、`orders/[id]/{emails/resend:68,refund:113,refund/confirm:53,status:104}`、`cart/add:13`・`cart/change:12`、`checkout/complete:37`・`create-session:91`、`checkout-route-guard.ts:77`、`contact:81`（`submitted_ip` を DB に保存: `:173`）、`items:72`、`wishlist:18`・`wishlist/[id]:13`、`lib/stripe/webhook-processor.ts:27`、`lib/orders/returns/{customer-return-route-support:140,return-route-support:234}`、`lib/orders/tracking/delivery-route-support:56`。うち **G/H（orders・returns・shipping・checkout・cart）は 12 ファイル（Task 2c）、非 G は 13 ファイル（Task 2b）**。自前の `getClientIp`・`clientIpOf` の複製（`cart/add:12`・`cart/change:11` の `clientIpOf`、`checkout/complete:36`・`checkout/create-session:90`・`checkout-route-guard.ts:77`（`export` だが外から import されていない）・`contact:80`・`wishlist:17`・`wishlist/[id]:12`・`webhook-processor.ts:26` の `getClientIp`）は消して共有の `getClientIp` を使う。使い道（監査の ip・回数の制限の鍵・DB の列）は決定 `:29` が『回数の制限の鍵に自前で XFF を読む所』にも挙げるので、各タスクの Step 1 で 1 か所ずつ表にする | 設計 R6「約 25 か所」は今 33 か所（うち 8 を Task 2 で、25 を Task 2b・2c で替える。controller の裁定で設計の『取扱店・管理・LOOK だけ』から広げた） |
| P8 | **E2E で送り元の見出しを付ける所は 42 ファイル**（`grep -rliE "x-forwarded-for\|x-real-ip\|x-vercel-forwarded-for" e2e`）。内訳: **GoTrue 直（書き換えない。P5）3**、**表明だけ（`x-forwarded-for` が付かないことを見る）1**（`FR-ACCOUNT-036:50`）、**書き換える 38**＝非 G/H の 34（共通の補助 `member-session-helpers.ts:126`・`stockist-admin-test-utils.ts:72,87,94`・`look-admin-test-utils.ts:46` の 3 と、spec 31）＋ **G/H の 4**（`FR-ACCOUNT-035:105`・`return-request-test-utils.ts:63`・`order-status-test-utils.ts:354,367`・`delivery-tracking-test-utils.ts:1478`）。書き換えは「見出しの名前 `'x-forwarded-for'` を `'x-real-ip'` にする」だけ（値の作り方は変えない）。**例外**: ①偽の XFF を送って「効かない」ことを見る試験（`FR-ADMIN-MISC-003:254`、`FR-STOCKIST-015:279-` の `FORGED_IP`、`FR-SEARCH-022` の `proxyHeaders`）は XFF を残し、信頼する見出し（`x-real-ip`）を別に付ける。②XFF を毎回変えて「枠を逃れられない」ことを見る試験（`FR-LOGIN-035:228`、`FR-NEWS-SEC-003:213`）は、**1 試験に 1 つの固定の `x-real-ip` を付け、XFF は毎回変える**（付けないと、全試験が共有する `ip null` の枠を 31 回・61 回使い切り、他の試験を 10 分間 429 にする）。`FR-SEARCH-022:281,300` は元から isolated-global の project で枠を消しながら流すので、見出しの付け足しは要らない | 見出しの付け方は 4 通り: `headers: {...}`／`extraHTTPHeaders`（`test.use` と `newContext`）／`page.setExtraHTTPHeaders`／`route.continue({headers})`。どれも文字列の `'x-forwarded-for'` を探して替える |
| P9 | **取扱店の窓口の今の順序**: `list`（`stockists/route.ts:31-38`）は 認可(`:33`)→読みの枠(`:38`)、`create`（`:62-74`）は 認可→変更の枠→CSRF、`[id]` の `get`（`:47-60`）・`put`（`:84-102`）・`patch`（`:211-229`）・`delete`（`:331-349`）も同じ。`[id]` の 4 つは**認可の前に id の形を確かめて 400**（例 `get` の `:52` 付近）。送り元の枠と操作者の枠は `enforceStockistAdminRateLimit`（`src/features/stockist/services/admin-security.ts:99-129`）が 1 つの関数で続けて数える。export は 6 つ全部 `withNoStore` を通る（`[id]/route.ts:427-441`）。直し方は設計 R7-5 / `STOCKIST.md` SEC-STOCKIST-020: 関数を **送り元の枠（認可の前。subject なし）** と **操作者の枠（認可の後。subject = actorId）** に分け、窓口は「送り元の枠 → （id の形） → 認可 → 操作者の枠 → CSRF」の順にする。限度（読み 120・変更 20 / 600 秒）は変えない。送り元の枠は**ハンドラーの最初**（id の形の検査より前）に置き、形の悪い id の連打も数える | 未認証の 401・一般会員の 403・CSRF の拒否も送り元の枠に数えられる（同じ事務所の店長が巻き添えで 429 になりうる。Vercel では送り元は単一の接続元）。`Retry-After` は `enforceRateLimit` が付ける |
| P10 | **認可の拒否の監査（R11-4・5、Q22）**: `AuthzFailure` に任意の `denial` を足す（追加のみ）。`authorizeAdminPermissions`（`src/lib/auth/admin-rbac.ts:187`）の次の 3 つの `return` に付ける: ①失効した session の 401（`:218-239` の `liveness !== 'active'` のうち `unavailable` でない枝。`userId = claims.sub`、`reason: 'session'`、`permission` は渡された最初の物）、②権限の足りない 403（`:241-253`。`reason: 'permission'`、`permission = missingPermission`）、③aal2 でない 403（`:255-265`。`reason: 'mfa'`、`permission = firstRequired`）。**トークン無しの 401（`:200-206`）・503（`:225-236`）・500（`:279-`）には付けない**（actor が無い／拒否ではない）。`denial = { userId, email: claims.email ?? null, role: tokenRole, permission, reason }`。取扱店の 6 窓口（と新しい `access`）は `!authz.ok` の枝で `auditAuthzDenial(authz, { request, action, resource: 'stockists' })` を呼んでから `authz.response` を返す。`auditAuthzDenial` は新しい共有の `src/lib/auth/audit-authz-denial.ts`（`audit.ts` には入れない）。**洪水の防止は設計の「全体で 10 分に N 行」でなく「操作者ごとに 10 分に 20 行まで、21 回目だけまとめの 1 行、以降は書かない。数えられなければ書かない」にする（ruling 6）**: 全体の上限だと、ある操作者が 20 回断られるだけで他の人の拒否の記録が 10 分消え（攻撃者が自分の拒否で他人の跡を消せる）、E2E の「新しい利用者の拒否で行がちょうど 1 つ増える」（`FR-STOCKIST-014:550-563`）も他の試験の拒否の数に左右される。なお既存の `revoke-user-sessions` の `auditUnauthorized`（全体 20 行、ADR-0460）は触らない | 設計 R11-4「全拒否を自動で監査にする案は採らない」。`logAudit` は失敗を握りつぶす（`audit.ts:45-90`）ので `auditAuthzDenial` も投げない |
| P11 | **`AuthzSuccess` に `permissions: ReadonlySet<PermissionCode>` を足す（Task 0 で追加する）**（追加のみ。`aclPermissions` は `:213-216` で既に引いている）。これで `GET /api/admin/looks`（`src/app/api/admin/looks/route.ts:468-475`）の「`admin.looks.manage` をもう一度認可する」暫定（ADR-0161 の「暫定の印」）を `authz.permissions.has('admin.looks.manage')` の 1 回にできる。`AuthzSuccess` の形を `toEqual` で固定している試験は 2 つ: `tests/unit/lib/auth/admin-rbac.test.ts:284`、`tests/integration/api/admin-misc/admin-authorization-path.test.ts:472`。権限の呼び手の試験モックは `permissions` を持たないので、**窓口では `authz.permissions?.has(...) === true`（無ければ偽。fail-closed）と読む** | 設計 R16「成功結果に項目を足す案は加算だけ」 |
| P12 | **監査の IP の取り方（Q13）**: 共有の `getAuditRequestContext(request): { ip: string \| null; user_agent: string \| null }`（`request-ip.ts`）を足し、`logAudit` に `...getAuditRequestContext(request)` と書く。IP は `getClientIp` の値で、取れなければ **null のまま保存**（`audit_logs.ip` は text で null 可）。Vercel 以外・`CLIENT_IP_HEADER` が無い手元では null になる（`STOCKIST.md` の影響どおり）。E2E は `x-real-ip` を信頼するので行に IP が入る。**ADR-0158・ADR-0010 の「残さない」は `ADR-0462` が置き換える**（理由: 管理者だけが対象、乗っ取られた session の追跡、OWASP Logging の source address）。保存期間は法令対応の後回し（memory `legal-compliance-deferred`）に従い、この波では決めない（`src/lib/auditCleanup.ts` の既定 365 日は使われていない物で、ADR の「未確認事項」に書く） | 現状固定の試験（`rows[0].ip` が undefined／null の物）が赤くなるので書き換える（各タスクの Test に列挙） |
| P13 | **LOOK-019-AC-04 と R16 の中身**: `LookSection`（`src/components/LookSection.tsx:34,45,141`）は `canManage` をすでに持ち、カードの 3 ボタンは `canManage` の時だけ出る（AC-05）。残るのは **「新規作成」が `src/app/admin/page.tsx:174-180` の `tabRightContent` の `case 'LOOK'` に役（`userRole !== 'admin'`）で出ている**こと。直し方: 「新規作成」を `LookSection` の中へ移し（`canManage` の時だけ）、`page.tsx` の `case 'LOOK'`（`:174-180`）を消す。**`LookSection` は一覧が 0 件の時に早く return する（`:103-109`）ので、0 件でも「新規作成」を出す**（出さないと最初の 1 件を作れない）。`GET /api/admin/looks` は `meta.canManage` を P11 の 1 回の認可から作る | `FR-LOOK-SEC-003:235` は管理の画面全体で `button`／`link` の名前「新規作成」が 0 件を求める |
| P14 | **CONTACT タブ**: `AdminTabs.tsx:1,13` の `TabType`・`allTabs`、`AdminSideNav.tsx:23` の `TAB_ICONS` に `CONTACT` が既にある。`src/app/admin/page.tsx` の `allAdminTabs`（`:29`）と `supporterTabs`（`:30`）に `'CONTACT'` を **`PACKING` の次・`SETTINGS` の前**（`AdminTabs.tsx:13` の並び）に足し、`renderContent`（`:193-`）に `case 'CONTACT': return <ContactSection />;` と import を足す。窓口は `admin.contact.read/manage` で守る（店長もサポーターも見える。権限を外されたサポーターは窓口の 403 の文が出る）。**メニューの並びを固定している試験**: `tests/unit/components/AdminSettingsMenu.test.tsx:75,105,193,239`、`e2e/FR-ADMIN-029-accounting-tab.spec.ts:110`（店長 12 個になる）。`FR-ADMIN-123-group-g-permissions.spec.ts` は PACKING の有無だけを見る | `ContactSection`（`src/components/ContactSection.tsx:99`、default export、751 行）は今どこからも使われていない |
| P15 | **取扱店の作成の頁の入口**: `src/app/admin/stockist/create/page.tsx` は `'use client'` で `StockistForm` を直に描く。新しい `GET /api/admin/stockists/access`（`src/app/api/admin/stockists/access/route.ts`）は 送り元の枠 → `authorizeAdminPermission('admin.stockists.manage', request)` → （拒否なら `auditAuthzDenial`）→ 操作者の枠（読み）→ `204`、全応答 `withNoStore`。静的な `access` は `[id]` より優先される。頁は編集の頁（`edit/[id]/page.tsx:13-86`）と同じ作り: `clientFetch('/api/admin/stockists/access')` が通るまで「読み込み中...」、通ったらフォーム、`401`／`403`／その他は `main .text-red-600` に固定の文（`FR-STOCKIST-013` の既存の確かめが `main .text-red-600` を使う）。`clientFetch` は 401 で session の更新を 1 回試す。**編集の頁は触らない**（決定 Q20 は作成の頁。編集の頁は `GET /api/admin/stockists/[id]`（読みの権限）で通っており、`FR-STOCKIST-013:327` の AC-01(編集) は元から緑。`admin.stockists.read` だけの人に編集のフォームが出る穴は残るが、書き込みは窓口が 403 にする。**ruling 10**） | 要件 `SEC-STOCKIST-019` の文は「作成・編集の頁」。決定は作成のみ |
| P16 | **429・503 に `no-store` を付ける時の呼び手の確かめ（波 3 の学び）**: 本文を読まずに捨てる `fetch` は、`no-store` の応答だと Chromium が要求を開いたまま残し、E2E の `networkidle` が止まる（`/api/auth/refresh` の件。`src/lib/client-fetch.ts` の `performRefresh` が本文を読み切るよう直した）。`/api/auth/*` は波 3 の proxy が既に `no-store` を付けるので新しい影響は無い。**新しく影響を受ける呼び手**は、`enforceRateLimit` を通る `/api/auth` の外の窓口（`items`・`search`・`suggest`・`news`・`contact`・`cart/*`・`wishlist`・`checkout/*`・管理）をブラウザの `fetch` で呼び、`!res.ok` で本文を読まずに戻る・投げる物。今見つけたのは: `src/features/items/components/RelatedItems.tsx:39-41`（`if (!res.ok) return;`）、`PublicItemGrid.tsx:798-803`（本文を読まずに `throw`）、`src/features/items/hooks/usePublicItems.ts:34-37`（同）、`src/features/search/components/SearchHomePreview.tsx:35-38`（同）、`src/app/item/[id]/ItemDetailClient.tsx:265-272`（同）。Task 2 Step 5 が `grep` で洗い直し、見つけた物の `!ok` の枝に本文を読み切る 1 行を足す（**ruling 9**）。429／503 は E2E でも回数の制限の試験でしか出ないが、波 3 は 17 件の決済が赤くなった | 本文は使わない物には `await res.arrayBuffer().catch(() => {})`（`client-fetch.ts` の流儀）を足す |

### 送り元の見出しを読む／付ける所の一覧（controller が最後に見る）

| 区分 | 場所 | この波の扱い |
| --- | --- | --- |
| 回数の鍵 | `rateLimit.ts:8-11` | `getClientIp`（Task 2） |
| 監査の IP（今 XFF を読む） | 取扱店 4 か所・強制失効・2 要素のリセット | `getClientIp`（Task 2） |
| Turnstile の remoteip | `login:39`・`password-reset/request:44`・`register:77` | `getClientIp`（Task 2。ruling 4） |
| 監査の IP（新しく足す） | ADMIN の `create-user`・`contact/*`・`audit-logs`・色見本、LOOK、NEWS | `getAuditRequestContext`（Task 9・10） |
| 読み方だけ寄せる（25 ファイル） | 上の P7 の 25 ファイル | `getClientIp`（非 G の 13 は Task 2b、G/H の 12 は Task 2c。checkout・cart を触る前に G-1 へ知らせる） |
| E2E・GoTrue 直 | `admin-session-test-utils.ts:70`・`home-grant-test-utils.ts:133`・`news-test-utils.ts:165` | **替えない**（P5） |
| E2E・アプリ向け・非 G/H | 34 ファイル | Task 5・6・8・9・10 |
| E2E・G/H | `FR-ACCOUNT-035:105`・`return-request-test-utils.ts:63`・`order-status-test-utils.ts:354,367`・`delivery-tracking-test-utils.ts:1478`（`FR-ACCOUNT-036:50` は表明で替えない） | **Task 12（G-1 の了承が要る）** |
| 単体・結合の試験（25 ファイルの読み方が変わるので期待が変わる 9 ファイル） | `tests/unit/lib/orders/returns/*`（4）、`tests/unit/api/admin/{order-email-routes,order-refund-route,role-permissions-route,shop-settings-route}.test.ts`、`tests/unit/features/checkout/services/checkout-route-guard.test.ts` | 見出しを `x-real-ip` に直す。`role-permissions-route`・`shop-settings-route` は Task 2b、残りの 7（`returns/*` 4・`order-email-routes`・`order-refund-route`・`checkout-route-guard`）は Task 2c |

## Global Constraints

- **Task 12 が済むまで push しない（controller は手元のコミットだけ）。** Task 2 の後は、E2E の見出しの書き換え（Task 3・5・6・8〜10・12）がそろうまで E2E の枠の分け方が壊れている（見出しの無い要求が `ip null` の 1 つの枠に集まる）。pre-push は E2E を流すので、途中のコミットを push すると誤った赤で止まるか、止めずに警告だけで通して壊れた状態を載せる。
- 並行作業: 別セッション（G-4／H）が同じ作業ツリーの別ファイルを編集し、コミットの時に全体の `tsc` を通す。**`git add`・`git commit`・`git stash`・`git checkout`・`git reset`・`git restore` は実行しない**（controller がタスクごとにコミットする）。コミットは作らない。`git status --short` に出ている `.claude/CLAUDE.md`・`package.json` は他者の変更なので触らない。
- **E2E・サーバー・3000 番・DB 結合試験・`db reset`・`supabase` の起動・全体の `jest`・`next build`・`npm run test:trace-coverage`・`npm run trace:report`・`validate-trace --update-baseline` は実行しない**。流してよい `jest` は `npx jest <ファイル>` の対象指定だけ。E2E は書くだけ。DB は本番も手元も触らない。
- `.ts` / `.tsx` を 1 つ編集するたびに `npx tsc --noEmit` を流し、自分の誤りをその場で直す。他者（G-4／H）の誤りが出たら触らず、報告に書く。
- 着手前に `git status --short` を見て、他セッションが変更中のファイルを確かめ、**重ならないようにする**。この波は共有ファイルを触る: `src/features/auth/middleware/rateLimit.ts`・`src/lib/auth/admin-rbac.ts`・`src/lib/audit.ts`・`scripts/e2e/environment.ts`・`jest.config.cjs`・`src/app/admin/page.tsx`。**`scripts/e2e/**`（Task 3）・G/H の E2E（Task 12）は、着手前に controller が G-1 に了承を取る**（Task 12 は一覧を先に送る。タスクの冒頭に「前提」と書いた）。`src/app/admin/page.tsx`（Task 0）は G-1 が「CONTACT タブを先にコミットすれば H が合わせる」と答え済みなので了承を取り直さず、`git status` で他者の変更中でないことだけ確かめる。**checkout・cart の窓口（Task 2c）は、触る前に controller が G-1 へ知らせる**（決定 `:29`）。その他の共有ファイルも、`git status --short` に他者の変更が在れば止めて報告する。
- 触らない: `src/lib/orders/**`・G-4／H の注文・返品・発送・購買・決済・カートの窓口と画面のうち、**XFF の読み方を `getClientIp` に替える行（P7 の 25 ファイル。Task 2b・2c）以外**、`src/proxy.ts`・`next.config.ts`・`src/lib/redirect.ts`（P4）、`supabase/**`、`playwright.config.ts`。
- 共有文書は**編集しない**: `docs/02_Requirements/requirements.md`、`docs/05_Quality/tests/test-spec.md`、`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`、`docs/03_BasicDesign/api/api-spec.md`、`docs/03_BasicDesign/api/route-inventory.md`、`docs/03_BasicDesign/data/er.md`、`docs/03_BasicDesign/ui/screen-list.md`、`screen-flow.md`、`docs/04_DetailDesign/pages/16_admin.md`、`tests/unit/docs/*-traceability.test.ts`、`docs/06_Operations/db-migrations.md`。必要な変更は各タスクの報告に「共有文書の変更案」として書く。`docs/06_Operations/{secrets,deployment-topology}.md`・`.env.example` は Task 3 で編集してよい（波 3 と同じ）。
- 文書: 日本語。`documentation-guide`（`.claude/skills/documentation-guide/SKILL.md`）の項目の形（見出し直後の属性表）・ID の体系・TSDoc（`@packageDocumentation`・`@impl`・`@design`・`@remarks` に「なぜ」だけ）・テスト名の先頭に ID（E2E は受け入れ条件、結合は構造設計、単体は詳細設計）を守る。文書の冒頭の確認日は 2026-10-28。絵文字は使わない。要件は `docs/02_Requirements/areas/<area>.md`（`requirements.md` には書かない）、脅威は `docs/05_Quality/security/threats/<area>.md`、構造設計は `docs/03_BasicDesign/areas/<area>.md`、設計判断は `docs/03_BasicDesign/decisions/ADR-NNNN-<slug>.md`、処理の詳細は `docs/04_DetailDesign/pages/` の頁の `DD-`。「今のコードは満たさない」は**直した項目だけ**外す。直していない部分は残す。新しい受け入れ条件を起こしたら、領域の要件のファイルの冒頭の「E2E ファイルと受け入れ条件の対応表」にも足す。
- コードのコメント: 範囲内の新しい単位（`src/app/api/admin/stockists/access/route.ts` の `GET`）には TSDoc で `@impl`・`@design`・`@remarks`（「なぜ」だけ）を書く。変えた単位は `@remarks` が今の動きと食い違わないよう直す（例: `stockists/route.ts` の「回数の制限を認可の後に呼ぶので、認可で断った要求は数えない。これは SEC-STOCKIST-020 を満たさない（推定）」、`look/admin-audit.ts` の IP を渡さない説明、`news/route.ts:36-39` の「IP を残さない」コメント）。**`src/lib/request-ip.ts`（AUTH の `src`）と `src/lib/auth/audit-authz-denial.ts`（STOCKIST の `src`）は `scope.json` に足すので、`@impl`・`@design` を付ける**（波 3 で同じ扱いにした `src/lib/storage/safe-object-path.ts` が結局 `@impl IMPL-SEARCH-129/130`・`@design DD-SEARCH-011` を持つ前例と同じ。付けないと `validate-trace`・`test:trace-coverage` が基準より増える）: `request-ip.ts` は `IMPL-AUTH-224`・`@design DD-AUTH-038`、`audit-authz-denial.ts` は `IMPL-STOCKIST-150`・`@design DD-STOCKIST-039`、`access` の `GET` は `IMPL-STOCKIST-151`・`@design DD-STOCKIST-040`。`@remarks` は「なぜ」だけ。`rateLimit.ts` は範囲外のままなので `@impl` を付けない。その単体試験は先頭に `DD-` を付ける。`@impl` の番号は書く直前に `grep -rhoE "IMPL-(AUTH|ADMIN|STOCKIST|LOOK|NEWS)-[0-9]+" src | sort -u | tail`（今の最大: AUTH 223・ADMIN 145・STOCKIST 149・LOOK 158・NEWS 174）で確かめる。
- 入力は信用しない: 記録・監査に、Cookie の値・鍵・Supabase の誤りの文・見出しの生の値を残さない。IP は `isIP` を通った物だけ（通らなければ null）。残してよいのは固定の符号と種類だけ。
- 実装は最小。決定にない設定項目・追加の窓口・画面は作らない（新しい窓口は `access` の 1 本だけ）。作業ツリーに CRLF のファイルがある。編集は Edit で行い、`sed -i` は使わない（`\` が落ちて CRLF を壊す）。`graphify update` は自分で流さない（コミットのフックが後ろで作り直す）。
- `scripts/trace/scope.json` を足す物: 新しい `src` の単位（`src/lib/request-ip.ts` を AUTH の `src`、`tests/unit/lib/request-ip.test.ts` を AUTH の `tests`、`src/lib/auth/audit-authz-denial.ts` を STOCKIST の `src`、`tests/unit/lib/auth/audit-authz-denial.test.ts` を STOCKIST の `tests` に）。足さないと `DD-` に「コードの単位」「単体テスト」が付かず `validate-trace` が基準より増える（波 3 の Task 9・10 と同じ手当）。範囲に入れる以上、`@impl`・`@design` も付ける（上の『コードのコメント』）。
- E2E は既存の spec に足す。新しい spec ファイルは作らない。新しい E2E は mobile 390・tablet 768・desktop 1280 の 3 つの幅で書く（応答の見出しだけを見る試験は幅に依存しないので 1 回でよい。既存の流儀に合わせる）。

### ID の割当

番号は**書く直前に再確認**する。違えば割当表をずらして一貫させる。ADR は領域ごとの帯（`scripts/trace/scope.json`: AUTH 040〜044・ADMIN 045〜049・STOCKIST 025〜029・LOOK 015〜019）に合わせ、上位に載せる構造設計（`ARC-`・`API-`・`DATA-`）を書く直前に確かめる（無いと `missing-child`）。

| 種類 | ID | 題 | タスク |
| --- | --- | --- | --- |
| ADR | `ADR-0416` | 送り元の IP は Vercel の見出し（`x-vercel-forwarded-for`→`x-real-ip`）だけから取り、`x-forwarded-for` は読まない。本番は Vercel 直で前段の中継を置かない（置く時は `TRUSTED_PROXY_HOPS` を設計する）。鍵が取れない時は `ip null` の 1 つの枠 | 1 |
| ADR | `ADR-0462` | 管理の操作の監査に送り元の IP を残す（`ADR-0158`・`ADR-0010` の「残さない」を置き換える）。保存期間は法令対応の後回しに従う | 9 |
| ADR | `ADR-0268` | 認可で断った取扱店の要求は actor が分かる物だけ監査に残し、操作者ごとに 10 分 20 行で止める | 8 |
| ADR | `ADR-0269` | 取扱店の作成の頁は入口で `GET /api/admin/stockists/access` を呼んで権限を確かめる | 8 |
| ADR | `ADR-0166` | LOOK の「新規作成」は `canManage` で出し、権限の集合は `admin-rbac` の成功結果が返す（`ADR-0161` の暫定を解く） | 0 |
| 実装 | `IMPL-AUTH-224`（`@design DD-AUTH-038`） | `src/lib/request-ip.ts`（`getClientIp`・`getAuditRequestContext`） | 1 |
| 実装 | `IMPL-STOCKIST-150`（`@design DD-STOCKIST-039`） | `src/lib/auth/audit-authz-denial.ts`（`auditAuthzDenial`） | 7 |
| 実装 | `IMPL-STOCKIST-151`（`@design DD-STOCKIST-040`） | `GET /api/admin/stockists/access` | 8 |
| 詳細設計 | `DD-AUTH-038` | 送り元の IP の取り出し（`getClientIp`・`getAuditRequestContext`・回数の鍵の `null`・429/503 の `no-store`）。**項目は Task 1 が `14_login.md` に作る**（試験の先頭の ID が先に在るように）。Task 2・4 が節を足す | 1（作る）・2・4（足す） |
| 詳細設計 | `DD-STOCKIST-039` | 認可の拒否の監査（`auditAuthzDenial`）と取扱店の窓口の順序 | 7（作る）・8（足す） |
| 詳細設計 | `DD-STOCKIST-040` | 取扱店の作成の頁の入口の確かめ（`access`） | 8 |
| 詳細設計 | `DD-ADMIN-016` | 管理の監査の行為者の文脈（メール・IP・ブラウザの名乗り）・色見本の監査・読み出しの IP | 9 |
| 詳細設計 | `DD-LOOK-072` | LOOK の一覧の「新規作成」と `canManage` | 0 |
| API | `API-STOCKIST-007` | `GET /api/admin/stockists/access` | 8 |
| 受け入れ条件 | `SEC-AUTH-013-AC-03` | 送り元は Vercel の見出し／`CLIENT_IP_HEADER` の時だけ読み、`x-forwarded-for` を読まず、IP の形でなければ null（単体） | 1 |
| 受け入れ条件 | `SEC-AUTH-013-AC-04` | 回数の制限の 429・503 に `Cache-Control: no-store` と `Retry-After` が付く（単体） | 2 |
| 受け入れ条件 | `SEC-STOCKIST-019-AC-03` | `GET /api/admin/stockists/access` は店長に 204、サポーターに 403、未ログインに 401、全部 `no-store` | 8 |
| 受け入れ条件 | `SEC-STOCKIST-021-AC-02` | token の無い 401 は監査に行を増やさない | 8 |
| 受け入れ条件 | `SEC-STOCKIST-021-AC-03` | 同じ操作者の拒否の監査は 10 分に 20 行まで、21 回目にまとめの 1 行（結合） | 7・8 |
| 受け入れ条件 | `SEC-ADMIN-022-AC-03` | ユーザー作成・強制失効・2 要素のリセットの監査の行に行為者のメール・IP・ブラウザの名乗りが入る | 9 |
| 受け入れ条件 | `SEC-ADMIN-023-AC-02` | 問い合わせの一覧・詳細と監査ログの読み出しの行に、読んだ人の IP が入る | 9 |
| 受け入れ条件 | `SEC-NEWS-016-AC-03`（`AC-01` の書き換え） | 管理のニュースの監査に IP が入る（`ADR-0010` を改める） | 10 |

### 共有ファイルの並べ方（shared files）

| ファイル | 触るタスク | 並べ方 |
| --- | --- | --- |
| `src/features/auth/middleware/rateLimit.ts` | 2 | 1 回だけ（鍵と `no-store` を同じ編集で。設計 R6「同じファイルを 2 回触らない」） |
| `src/lib/request-ip.ts` | 1（作る） | Task 9・10 は呼ぶだけ |
| `src/lib/auth/admin-rbac.ts` | 0（`permissions`）・7（`denial`） | 追加のみ。2 回に分けて触る。G-4／H が触っていないかを `git status` で確認 |
| `src/lib/audit.ts` | 7 | 追加のみ（制御文字の除去）。G-4／H の確認 |
| `scripts/e2e/environment.ts` | 3 | G-1 の了承（`scripts/e2e/**`）。`scripts/e2e-server.mjs` は触らない（見張りを足さない。P6） |
| `jest.config.cjs`・`tests/setupClientIp.js` | 2 | 1 回だけ |
| `src/app/admin/page.tsx`・`src/app/api/admin/looks/route.ts` | 0 | **最初に**（CONTACT タブを早くコミットして H が合わせる。G-1 は答え済みで了承は取り直さない） |
| checkout・cart・orders の窓口、`lib/orders/{returns,tracking}`（XFF の読み 12 ファイル） | 2c | 触る前に G-1 へ知らせる（決定 `:29`）。読み方だけ |
| `docs/*/areas/auth.md` 系 | 1・2・4・5 | 順 |
| `docs/*/areas/stockist.md` 系 | 7・8 | 順 |
| `docs/*/areas/admin.md` 系 | 0・9 | 順 |
| `docs/*/areas/look.md` 系 | 0・10 | 順 |

---

## Review Focus（最も踏みやすい失敗 7 つ）

レビュアーと実装者は、各タスクの前後でこの 7 つを具体的な入力で確かめる。

1. **`'unknown'` を `inet` に渡して全窓口が 503 になる。** 鍵が取れない時の値は **`null`**（P2）。確かめる入力（単体）: 見出し無しの `Request` で `enforceRateLimit` を呼ぶと `incrementCounter` が `ip: null` で呼ばれる。`subject` を渡した時は従来どおり `incrementCounter` 側が IP を捨てる（`normalizeCounterTarget`）。`'127.0.0.1'` の固定値の期待（`tests/integration/api/search-rate-limit-proxy.test.ts:155`、`tests/integration/api/stockist-admin-guards.test.ts:293`）を `null` に書き換える。なお E2E の今の鍵は `'127.0.0.1'` でなく接続元（`::1`・`::ffff:127.0.0.1` など。`next start` が見出しの無い時に XFF を付ける。P2 の訂正）で、新しい形では見出しの無い要求の枠が `ip null` の 1 つにまとまる。
2. **E2E が互いに 429 になる（memory「E2E 全件の既存赤」の再来）。** 送り元の見出しを `x-real-ip` に書き換え忘れた E2E は、全員が `ip null` の枠を共有する。書き換え忘れの見つけ方: `grep -rnE "'x-forwarded-for'|\"x-forwarded-for\"" e2e` が **P5 の 3 か所と、偽の XFF を送る意図の試験（P8 の例外①）・例外②の専用の送り方（`FR-LOGIN-035:236`・`FR-NEWS-SEC-003` の AC-01。XFF を毎回変え、固定の `x-real-ip` を別に付ける）・`FR-ACCOUNT-036:50` だけ**になること。例外②の 2 試験（`FR-LOGIN-035:228`・`FR-NEWS-SEC-003:213`）は固定の `x-real-ip` を 1 つ付ける。G/H の 4 ファイル（Task 12）を最後の E2E の前に済ませないと、注文の状況・返品・配送の E2E が `ip null` の枠を取り合う。
3. **429・503 の `no-store` で本文を読まない呼び手が要求を開いたまま残す。** P16 の 5 か所と `grep` の結果の枝に、本文を読み切る 1 行を足す（Task 1b。Task 2 より前に入れる）。確かめる入力（単体）: `fetch` を `{ ok: false, status: 429, arrayBuffer }` に差し替え、`arrayBuffer` が呼ばれる。
4. **取扱店の送り元の枠を認可の前に移して、巻き添えと二重計上が出る。** 送り元の枠は 1 要求 1 回（今の `enforceStockistAdminRateLimit` の前半を移すだけ）、操作者の枠は認可の後に 1 回。確かめる入力: 一般会員の token で `GET /api/admin/stockists` を 121 回 → 120 回目まで 403、121 回目が 429＋`Retry-After`。店長の `PATCH` を 20 回 → 21 回目が 429（`FR-STOCKIST-015:208` の `SEC-STOCKIST-007-AC-02`）。別オリジンの 21 回の後の正しい `PATCH` は 200（`FR-STOCKIST-014:486` の `SEC-STOCKIST-005` は proxy が先に断るので枠を使わない）。
5. **認可の拒否の監査が洪水を起こす／行が足りない。** `denial` を付けるのは P10 の 3 つだけ。確かめる入力: ①サポーターの aal2 の `PATCH` が 403 → `audit_logs` に actor・`failure`・`admin.stockists.manage` を含む行が**ちょうど 1 つ**。②同じ操作者が 25 回断られると 20 行＋まとめの 1 行（`outcome: 'denied_burst'`）で止まる。③token の無い要求・503（失効の確認ができない）・500 では 0 行。④`incrementCounter` が投げても窓口の応答は変わらない（fail-open）。
6. **監査の IP の意味が変わる。** 非 Vercel・`CLIENT_IP_HEADER` 無しでは **null**（偽の XFF は入らない）。E2E は `x-real-ip` を信頼するので IP が入る。確かめる入力: `FR-STOCKIST-015:280` は XFF に `203.0.113.9` を付け、`x-real-ip` に別の IP を付けて、行の `ip` が `x-real-ip` の値で XFF の値を含まないこと（今より強い確かめ）。`FR-NEWS-SEC-005:263`（旧 `SEC-NEWS-016-AC-01`: IP が空）は逆の期待に書き換える。単体・結合の `rows[0].ip` が undefined の物（`admin-contact-*-api.test.ts` 7、`look-admin-*-api.test.ts`・`look-admin-write-path.test.ts`、`news-admin-*-api.test.ts` 3）は、IP が入る期待へ。
7. **LOOK の「新規作成」が消える／メニューの試験が壊れる。** `LookSection` の 0 件の枝でも「新規作成」を出す（P13）。`canManage` が偽・`meta` なし・読み込み中は出さない。CONTACT タブを足すと `AdminSettingsMenu.test.tsx:75,105,193,239` と `FR-ADMIN-029:110` の並びの期待が変わる（P14）。`ContactSection` が 3 幅で溢れない（`AdminSideNav` は `overflow-x-auto`）。

---

## ファイルの全体像

| 区分 | ファイル | 操作 | タスク |
| --- | --- | --- | --- |
| 共有（新規） | `src/lib/request-ip.ts`、`src/lib/auth/audit-authz-denial.ts`、`tests/setupClientIp.js` | 新規 | 1・7・2 |
| 共有（変更） | `src/features/auth/middleware/rateLimit.ts`、`src/lib/auth/admin-rbac.ts`、`src/lib/audit.ts`、`jest.config.cjs` | 変更 | 2・7 |
| 共有（E2E 環境） | `scripts/e2e/environment.ts`（`scripts/e2e-server.mjs` は触らない）、`tests/unit/scripts/e2e/environment.test.ts`、`.env.example`、`docs/06_Operations/{secrets,deployment-topology}.md` | 変更 | 3 |
| AUTH | `src/app/api/auth/**`（`try/catch` を外す 14 ファイル、Turnstile の 3 ファイル） | 変更 | 2・4 |
| 取扱店 | `src/features/stockist/services/admin-security.ts`、`src/app/api/admin/stockists/route.ts`・`[id]/route.ts`、`src/app/api/admin/stockists/access/route.ts`（新規）、`src/app/admin/stockist/create/page.tsx` | 変更・新規 | 2・8 |
| ADMIN | `src/app/api/admin/{revoke-user-sessions,users/mfa/reset,create-user,audit-logs,contact,item-color-presets}/**` | 変更 | 2・9 |
| LOOK／NEWS | `src/features/look/services/admin-audit.ts`、`src/app/api/admin/news/route.ts`・`[id]/route.ts`、`src/app/api/admin/looks/route.ts`、`src/components/LookSection.tsx`、`src/app/admin/look/**` | 変更 | 10・0 |
| 管理の頁 | `src/app/admin/page.tsx` | 変更 | 0 |
| 呼び手（本文を読む） | `src/features/items/components/RelatedItems.tsx`・`PublicItemGrid.tsx`、`src/features/items/hooks/usePublicItems.ts`、`src/features/search/components/SearchHomePreview.tsx`、`src/app/item/[id]/ItemDetailClient.tsx`（＋ `grep` の結果） | 変更 | 1b |
| XFF の直読み 25 ファイル | P7 の 25 ファイル（非 G 13・G/H 12）。自前の `getClientIp`・`clientIpOf` の複製を消す | 変更 | 2b・2c |
| 試験（単体・結合） | `tests/unit/lib/request-ip.test.ts`・`tests/unit/lib/auth/audit-authz-denial.test.ts`（新規）、`tests/unit/middleware/rateLimit.test.ts`、`tests/unit/lib/auth/admin-rbac.test.ts`、`tests/unit/lib/audit*.test.ts`、36 ファイル（Task 2。XFF の見出しを送る物）と Task 2b・2c の 9 ファイル、`tests/unit/components/AdminSettingsMenu.test.tsx`・`look-section.test.tsx`、`tests/unit/app/admin/stockist/stockist-create-page.test.tsx` | 追加・変更 | 全部 |
| E2E | 非 G/H 34 ファイル（Task 5・6・8・9・10）、`FR-ADMIN-029`（メニュー）、G/H 4 ファイル（Task 12） | 見出しの書き換え・`test.fail` の削除・期待の更新 | 5〜12 |
| 文書 | `docs/02_Requirements/areas/{auth,admin,stockist,look,news,search}.md`、`docs/05_Quality/security/threats/{同}.md`、`docs/03_BasicDesign/areas/{同}.md`、`docs/03_BasicDesign/decisions/ADR-0416・0462・0268・0269・0166`（新規）と `ADR-0010・0158・0161・0259・0261・0312` の状態（更新）、`docs/04_DetailDesign/pages/{14_login,16-2_admin_misc,10_stockist,16-4_admin_stockist,16-3_admin_look,16-1_admin_news,19_search}.md` | 追記・更新 | 全部 |

---

## Task 0: 管理画面（CONTACT タブ・LOOK の「新規作成」を権限で出す）。最初に入れて早くコミットする

**前提:** `src/app/admin/page.tsx` は G-4／H が触る共有の頁。G-1 は「波 4 を先に入れてよい。CONTACT タブを先にコミットすれば H が合わせる」と答え済み（`wave4-decisions.md:26`）なので、`page.tsx` の了承は取り直さない。`git status` でその頁が他者の変更中でないことだけ確かめ、**この波の最初の実装として早くコミットする**（IP の作業と独立）。コミットしたら controller が G-1 に知らせる（H は同じ頁に割引のタブを足す）。

**範囲:** R16 の画面側。`GET /api/admin/looks` が使う `AuthzSuccess.permissions`（P11）は、このタスクで `admin-rbac.ts` に追加する（追加のみ。`denial` は Task 7）。

**Files:**

- Modify: `src/lib/auth/admin-rbac.ts`（`AuthzSuccess` に `permissions: ReadonlySet<PermissionCode>` を足す。追加のみ）、`src/app/admin/page.tsx`（`allAdminTabs`・`supporterTabs` に `'CONTACT'` を `PACKING` の次に、`renderContent` に `case 'CONTACT'`、`import ContactSection`、`tabRightContent` の `case 'LOOK'`（`:174-180`）を消す）、`src/components/LookSection.tsx`（`canManage` の時だけ「新規作成」を出す。0 件の枝でも出す。P13）、`src/app/api/admin/looks/route.ts`（`:468-475` の 2 回目の認可を `authz.permissions?.has('admin.looks.manage') === true` に）
- Test: `tests/unit/lib/auth/admin-rbac.test.ts`（`:284` の `toEqual` に `permissions` を足す。成功の結果の `permissions` が ACL の集合）、`tests/integration/api/admin-misc/admin-authorization-path.test.ts:472`（同じ形の固定に `permissions`）、`tests/unit/components/AdminSettingsMenu.test.tsx`（`:75,105,193,239` のメニューの並びに `CONTACT` を足す。supporter は `['ORDER','INVENTORY','PACKING','CONTACT']`。CONTACT を押すと `ContactSection` が出る）、`tests/unit/components/look-section.test.tsx`・`tests/integration/ui/look-admin-flow.test.tsx`・`look-admin-list-screen.test.tsx`（「新規作成」が `canManage` の時だけ・0 件でも・`meta` なしや偽では出ない）、`GET /api/admin/looks` の単体（`authorizeAdminPermission` が 1 回だけ呼ばれる・`permissions` に `manage` が無ければ `canManage: false`・`permissions` が無い（モック）なら偽・401／503 はそのまま）
- E2E: `e2e/FR-ADMIN-029-accounting-tab.spec.ts:110`（店長のメニューの並びに `CONTACT`）。**外す**: `FR-ADMIN-MISC-006:244`（`FR-ADMIN-009-AC-01`、3 幅）・`:264`（`FR-ADMIN-009-AC-05`、3 幅）、`FR-LOOK-SEC-003:235`（`SEC-LOOK-019-AC-04`、3 幅。冒頭の注 `:21` も直す）。`FR-LOOK-ADMIN-001` が「新規作成」を探す所が壊れないこと（店長は出る）
- Docs: `docs/02_Requirements/areas/admin.md`（`FR-ADMIN-009-AC-01〜06` の「今のコード: タブも画面も無い」を外す。D9）、`docs/02_Requirements/areas/look.md`（`SEC-LOOK-019-AC-04` の「新規作成は src/app/admin/page.tsx が役で出す・波 4」を外す）、`docs/05_Quality/security/threats/{admin,look}.md`、`docs/03_BasicDesign/areas/{admin,look}.md`（`look.md:259,552` の記述）、`docs/03_BasicDesign/decisions/ADR-0166-look-create-button-by-can-manage-permissions-set.md`（新規）、`ADR-0161` の状態（「暫定を解いた」）、`docs/04_DetailDesign/pages/16-3_admin_look.md`（`DD-LOOK-072`、`DD-LOOK-060` の `LookSection` の節）。共有文書の変更案: `docs/03_BasicDesign/ui/screen-list.md:127`（「CONTACT は現行 `/admin` の表示タブ配列に含まれない」を直す。admin の 12 タブ、supporter の 4 タブ）、`screen-flow.md`、`docs/04_DetailDesign/pages/16_admin.md`

- [ ] **Step 1: 現状の確認（読むだけ）。** P11・P13・P14。`ContactSection` の import と 3 幅での表示（`AdminSideNav` は `overflow-x-auto`）を読む。
- [ ] **Step 2（RED）→ Step 3（GREEN）。** 試験 → 実装。`tsc`。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/unit/lib/auth tests/integration/api/admin-misc/admin-authorization-path.test.ts tests/unit/components tests/integration/ui/look-admin tests/unit/api/admin/looks`（`AdminGroupG1LegacyStop.test.tsx` など G／H の試験が赤くならないことも確かめる）。
- [ ] **Step 5: E2E（書くだけ）。** 外す行は 3 か所（`FR-ADMIN-MISC-006:244,264`・`FR-LOOK-SEC-003:235`。すべて 3 幅の繰り返しの中）。
- [ ] **Step 6: 文書・報告。** `validate-docs`・`validate-trace -- ADMIN`・`-- LOOK`。共有文書の変更案を報告に。controller は Task 0 を IP の作業より先に単独でコミットし、G-1 に知らせる。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- ADMIN`、`-- LOOK`。

---

## Task 1: 送り元 IP の取り出し `getClientIp`（追加のみ）

**範囲:** 何も呼ばない新しい純粋な関数と、その単体試験。挙動は変わらない（Task 2・8・9・10 が使う）。

**Files:**

- Create: `src/lib/request-ip.ts`、`tests/unit/lib/request-ip.test.ts`
- Modify: `scripts/trace/scope.json`（AUTH の `src` に `src/lib/request-ip.ts`、`tests` に `tests/unit/lib/request-ip.test.ts`。`@impl IMPL-AUTH-224` を付ける）
- Docs: `docs/04_DetailDesign/pages/14_login.md` に `DD-AUTH-038` の項目だけ作る（見出し直後の属性表・題・上位の `ARC-AUTH-` への紐付け・`getClientIp` の仕様の要約）。`docs/03_BasicDesign/decisions/ADR-0416-auth-client-ip-vercel-headers-only.md`（新規。背景: XFF の左端を信じる／決定: P3／退けた案: 右から数える方式（Vercel は XFF を上書きするので意味が無く、前段の中継を置かない前提では要らない）・`TRUST_PROXY_HEADERS` の使い回し（P4）／結果: 非 Vercel では null／見直す条件: Cloudflare 等の前段を置く時は `TRUSTED_PROXY_HOPS` を設計する）。`docs/02_Requirements/areas/auth.md` に `SEC-AUTH-013-AC-03` を足し、`SEC-AUTH-013` 本文の「送り元は今のコードが満たさない」を Task 2 まで残す（AC-03 は「満たす」）。`docs/03_BasicDesign/areas/auth.md` の共有部品の表に `request-ip.ts` の行。確かめ: `npm run validate-docs`、`npm run validate-trace -- AUTH`

**Interfaces:**

```ts
// src/lib/request-ip.ts（@impl IMPL-AUTH-224・@design DD-AUTH-038）
/** Vercel（VERCEL=1）か CLIENT_IP_HEADER が空でない時だけ、x-vercel-forwarded-for → x-real-ip の順に読む。x-forwarded-for は読まない。IP の形でなければ null */
export function getClientIp(request?: Request): string | null;
/** 監査に載せる送り元の文脈。ip は getClientIp、user_agent は user-agent（無ければ null） */
export function getAuditRequestContext(request: Request): { ip: string | null; user_agent: string | null };
```

- [ ] **Step 1: 現状の確認（読むだけ）。** P1・P2・P7 の事実を `rateLimit.ts:4-16` と `ratelimit/index.ts:20-31` で自分の目で確かめる。`grep -rn "node:net" src` で `isIP` の既存の使い方を確かめる（無ければ `import { isIP } from 'node:net'` を新しく足す。`src/lib/request-ip.ts` は Route Handler からだけ読まれ、`proxy.ts` は読まない）。
- [ ] **Step 2（RED）: 単体試験を書く**（先頭 `DD-AUTH-038`。環境変数は `process.env` を差し替えて戻す）。表（`it.each`）で:
  - 読む物: `VERCEL=1` ＋ `x-vercel-forwarded-for: 203.0.113.9` → `203.0.113.9`。`VERCEL=1` ＋ `x-real-ip` だけ → その値。両方在る時は `x-vercel-forwarded-for` が勝つ。`CLIENT_IP_HEADER=x-real-ip`（`VERCEL` 無し）＋ `x-real-ip` → その値。IPv6（`2001:db8::1`）。前後の空白は `trim`。
  - null になる物: `VERCEL` も `CLIENT_IP_HEADER` も無い時（`x-real-ip`・`x-vercel-forwarded-for` が在っても）。**偽の `x-forwarded-for` だけ**（`VERCEL=1` でも）。`x-forwarded-for` と `x-real-ip` の両方が在る時は `x-real-ip` を返し XFF は無視。値が空・`foo`・`203.0.113.9, 10.0.0.1`・`203.0.113.9:8080`・`999.1.1.1`。`x-vercel-forwarded-for` が不正で `x-real-ip` が正しい時は **null**（上位の見出しが在って不正なら次へ進まない）。`request` が `undefined`。`VERCEL=true`（`'1'` 以外）。`TRUST_PROXY_HEADERS=true` だけ（読まない。P4）。
  - `getAuditRequestContext`: `ip` が上と同じ、`user_agent` が見出し／無ければ null。
- [ ] **Step 3（GREEN）: 実装する。** 上の仕様どおり。TSDoc に `@impl IMPL-AUTH-224`・`@design DD-AUTH-038`・`@remarks`（なぜ `x-forwarded-for` を読まないか）を付ける（`scope.json` に足す物なので。Global Constraints）。`tsc`。
- [ ] **Step 4: 対象の `jest` を流す。** `npx jest tests/unit/lib/request-ip.test.ts`。
- [ ] **Step 5: 報告。** 作ったファイル、共有文書の変更案は無い。コミットは作らない。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。

---

## Task 1b: 呼び手が `!ok` の応答の本文を読み切る（`no-store` を付ける Task 2 より前に入れる）

**範囲:** 独立で、先に入れても安全な直し。本文を読み切る 1 行を足すだけなので、今の応答（`no-store` なし）でも害は無い。Task 2 が 429・503 に `Cache-Control: no-store` を付けると、本文を読まずに捨てる `fetch` は Chromium が要求を開いたまま残し、E2E の `networkidle` が止まる（P16・Review Focus 3）。Task 2 から切り離して、別のコミットで先に入れる。

**Files:**

- Modify（P16 の 5 か所）: `src/features/items/components/RelatedItems.tsx:39-41`、`src/features/items/components/PublicItemGrid.tsx:798-803`、`src/features/items/hooks/usePublicItems.ts:34-37`、`src/features/search/components/SearchHomePreview.tsx:35-38`、`src/app/item/[id]/ItemDetailClient.tsx:265-272`、と Step 1 の `grep` で見つけた物
- Test: 各 1 本の単体試験（`fetch` を `{ ok: false, status: 429, arrayBuffer: jest.fn() }` に差し替え、`arrayBuffer` が呼ばれる）
- Docs: `SearchHomePreview.tsx` は SEARCH の範囲（`src/features/search/**`）なので、`@impl`・`@remarks` を今の動き（`!ok` の枝で本文を読み切る）に合わせ、`docs/04_DetailDesign/pages/19_search.md` の該当する `DD-`（`SearchHomePreview` を扱う項目）を直す。`npm run validate-trace -- SEARCH`。ITEM の 4 部品（`RelatedItems.tsx`・`PublicItemGrid.tsx`・`usePublicItems.ts`・`ItemDetailClient.tsx`）は範囲外（`scripts/trace/scope.json` に ITEM が無い）なので領域の文書は直さず、`docs/05_Quality/tests/test-spec.md` の変更案（足した単体試験の名前と対象）を報告の「共有文書の変更案」に書く。controller が Task 13 Step 3 の一覧に足す

- [ ] **Step 1: 洗い直し。** `grep -rnE "fetch\(" src --include=*.ts --include=*.tsx --exclude-dir=graphify-out` のうち `/api/` を呼び、`/api/auth` を除く物を洗い、`!res.ok`／`!response.ok` の枝で本文を読まずに戻る・投げる所を表にする（P16 の 5 か所は必ず入る）。`swr`／`useSWR` や自前の `request` ラッパーが在れば同じ確かめをする。
- [ ] **Step 2（RED）→ Step 3（GREEN）。** 試験を書き、見つけた物の `!ok` の枝に `await res.arrayBuffer().catch(() => {});` を足す（`client-fetch.ts` の `performRefresh` と同じ流儀と注。本文を使う物には足さない）。`tsc`。
- [ ] **Step 4: 対象の `jest`。** 足した試験と、それぞれの部品の既存の試験（`npx jest tests/unit/features/items tests/unit/features/search tests/unit/app/item`。実際の場所は Step 1 に従う）。
- [ ] **Step 5: 文書・報告。** Docs のとおり。ITEM の `test-spec.md` の変更案を報告に書く。E2E の印は外さない。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- SEARCH`。

---

## Task 2: `rateLimit.ts` の鍵と `no-store`、今の XFF の読みの切り替え

**範囲:** `rateLimit.ts` を 1 回だけ編集して、(a) 鍵を `getClientIp`（`null` は `null` のまま）に、(b) 429・503 に `Cache-Control: no-store`（`withNoStore` の `private, no-store`）を付ける。同じタスクで、**今 XFF を読んでいて替える物**（P7: 取扱店 4 か所・強制失効・2 要素のリセット・Turnstile 3 か所）を `getClientIp` に替え、XFF の見出しを送る単体・結合の試験の見出しを `x-real-ip` に直して木を緑に保つ。ジェストの環境に `CLIENT_IP_HEADER` を入れる。

**Files:**

- Modify: `src/features/auth/middleware/rateLimit.ts`、`src/app/api/admin/stockists/route.ts`（`:80`）、`src/app/api/admin/stockists/[id]/route.ts`（`:108,235,355`）、`src/app/api/admin/revoke-user-sessions/route.ts`（`:76`）、`src/app/api/admin/users/mfa/reset/route.ts`（`:72`）、`src/app/api/auth/login/route.ts`（`:39`）、`password-reset/request/route.ts`（`:44`）、`register/route.ts`（`:77`）（Turnstile。ruling 4）、`jest.config.cjs`（`setupFiles` に `<rootDir>/tests/setupClientIp.js`）。P16 の呼び手の「本文を読み切る」直しは Task 1b で先に入れてある
- Create: `tests/setupClientIp.js`（`process.env.CLIENT_IP_HEADER = 'x-real-ip';` の 1 行と理由の注。jest 全体で効く。`request-ip.test.ts` は自分で環境を差し替える。ruling 8）
- Test（**見出しを `x-forwarded-for` から `x-real-ip` に直す。ほかの期待は変えない**。Task 2b・2c が直す 9 ファイル（「送り元の見出しを読む／付ける所の一覧」の最後の行）は除く）: 36 ファイル — `tests/unit/middleware/rateLimit.test.ts`、`tests/unit/features/look/services/admin-rate-limit.test.ts`、`tests/unit/api/auth/{login-route,password-reset-request-route,register-route}.test.ts`、`tests/unit/api/admin/{mfa-reset-route,revoke-user-sessions-route,stockists-security}.test.ts`、`tests/unit/api/admin/stockists/{stockists-id-route,stockists-route}.test.ts`、`tests/integration/api/{auth-bot-rate-limit,auth-login-api,auth-password-reset-request-api,look-admin-create-api,look-admin-item-delete-api,look-admin-item-get-api,look-admin-item-patch-api,look-admin-item-put-api,look-admin-write-path,news-admin-write-path,news-public-api,search-popular-items,search-rate-limit-proxy,search-request-path,stockist-admin-create-api,stockist-admin-guards,stockist-admin-item-delete-api,stockist-admin-item-get-api,stockist-admin-item-patch-api,stockist-admin-item-put-api,stockist-admin-list-api,stockist-admin-write-path}.test.ts`、`tests/integration/api/auth/register.test.ts`、`tests/integration/api/admin/revoke-user-sessions.test.ts`、`tests/integration/api/admin-misc/{admin-audit-write,admin-mfa-reset-api}.test.ts`。**書き換えるべき現状固定**: `search-rate-limit-proxy.test.ts:142-163`（「XFF の先頭を使う」→「`x-real-ip` を使い、XFF は無視。どちらも無ければ `ip: null`」）、`news-public-api.test.ts:177-183`、`stockist-admin-guards.test.ts:287-293`（`'127.0.0.1'` → `null`）、`tests/unit/middleware/rateLimit.test.ts`（429・503 の見出し）
- Docs: `docs/04_DetailDesign/pages/14_login.md` の `DD-AUTH-038` に「回数の鍵は `null`（`inet` に入らないため `'unknown'` にしない）」と「429・503 の `no-store`」の節。`docs/02_Requirements/areas/auth.md`: `SEC-AUTH-013-AC-04`（429・503 に `no-store`）を足し、`SEC-AUTH-013` 本文の「送り元は今のコードが満たさない」を満たす旨に直す（`try/catch` と GoTrue の枠は Task 4・開店前の確認として残す）。`docs/05_Quality/security/threats/auth.md` の `THR-AUTH-013`。`docs/03_BasicDesign/areas/auth.md` の共有部品の表の `rateLimit.ts` の行。`docs/03_BasicDesign/decisions/ADR-0259-*.md`・`ADR-0306-*.md`・`ADR-0312-*.md` の「XFF から取る・偽れる」の記述を「`getClientIp`（ADR-0416）」に直す（状態は変えない）。`docs/05_Quality/security/threats/{news,search,look,admin,stockist}.md` の XFF の記述の更新は、各領域のタスクで

**Interfaces:**

```ts
// rateLimit.ts（enforceRateLimit の引数・戻り値は変えない）
const ip = getClientIp(request);                 // string | null。null は incrementCounter にそのまま渡す（ip 列は inet、NULLS NOT DISTINCT）
// 429・503 は withNoStore(...) を通す。NextResponse が無い環境の Response の枝も Cache-Control を付ける
```

- [ ] **Step 1: 現状の確認（読むだけ）。** P1・P2 を確かめる。`grep -rln "x-forwarded-for" tests` の 45 ファイルを、Task 2 で直す 36・Task 2b（2）／2c（7）で直す 9 に分けた表を報告の冒頭に書く。**手元の試験の環境でも `Request` の `headers.get` が大小文字を区別しない**ことを確かめる。
- [ ] **Step 2（RED）: 試験を書く。** ①`rateLimit.test.ts`: `x-real-ip: 1.2.3.4` ＋ `CLIENT_IP_HEADER` → `incrementCounter` が `ip: '1.2.3.4'`。XFF だけ → `ip: null`。`request` 無し → `ip: null`。`subject` ありは従来どおり。②429 の応答が `Cache-Control: private, no-store` と `Retry-After` を持つ（`SEC-AUTH-013-AC-04`）。DB が投げて 503 でも同じ。`NextResponse` が使えない環境の `Response` の枝も同じ（`jest.isolateModules` で `NextResponse.json` を投げさせる）。③強制失効・2 要素のリセット・取扱店の監査の `ip` が `x-real-ip` の値で、XFF は入らない（既存の期待 `ip: '203.0.113.9'` は見出しを直すだけで残る）。④Turnstile に渡す IP が `getClientIp` の値で、見出しが無ければ `null`。
- [ ] **Step 3（GREEN）: 実装する。** `rateLimit.ts` の `getIpFromRequest` を消し（呼び手は `enforceRateLimit` だけ。使われなくなる物は消す）、`getClientIp` と `withNoStore` を使う。取扱店の 4 か所・強制失効・2 要素のリセット・Turnstile の 3 か所は 1 行ずつ `getClientIp(request)` に（`clientIp` 変数の名前と使い方は変えない）。`rateLimit.ts` に `@impl` は付けない（範囲外の共有部品）。`tsc`。
- [ ] **Step 4: 試験を直す。** Test の 36 ファイルで `'x-forwarded-for'` を `'x-real-ip'` にし（値が `'a, b'` の形の物は先頭の 1 つにする）、上の「書き換えるべき現状固定」を直す。XFF を**送らない**意図の試験（偽の XFF を無視する確かめ）は Step 2 で足した物に集める。`npx jest <各ファイル>` を領域ごとに流して緑にする。
- [ ] **Step 5: （欠番。呼び手の確かめ（P16）は Task 1b に移した。Task 1b が先に入っていることを `git log` で確かめる。入っていなければ止めて報告する）**
- [ ] **Step 6: 文書。** Docs の各項目。`DD-AUTH-038` に節を足す。
- [ ] **Step 7: 確かめ。** `npx tsc --noEmit`、各領域の `jest`（Test の全部）、`npm run validate-docs`、`npm run validate-trace -- AUTH`。**他領域の proxy の試験群**（`npx jest tests/unit/middleware tests/integration/api/about-proxy.test.ts tests/integration/api/privacy-proxy-headers.test.ts tests/integration/api/home-page-proxy-csp.test.ts tests/integration/api/news-proxy.test.ts tests/integration/api/stockist-proxy.test.ts tests/integration/api/search-rate-limit-proxy.test.ts tests/integration/api/admin-misc/admin-origin-guard.test.ts`）も流して赤が増えていないことを確かめる。
- [ ] **Step 8: 報告。** 変えたファイル、36 ファイルの一覧、共有文書の変更案（なし）。E2E の印は外さない。

**検証コマンド:** `npx tsc --noEmit`、Step 7 の `jest`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。

---

## Task 2b: XFF の直読みを `getClientIp` に寄せる（非 G の 13 ファイル）

**範囲:** controller の裁定（`wave4-decisions.md:34`）。G を含む全部の `x-forwarded-for` の直読みを `request-ip.ts` に寄せる。読み方が 1 つに揃い、偽れる値が監査に残らない。このタスクは G/H に関わらない 13 ファイル。**保存先・変数名・使い方は変えず、読み方だけ**替える。自前の `getClientIp` の複製は消す。誤りなら監査の ip の形が変わるだけ（null になりうる）。

**Files:**

- Modify: `src/app/api/admin/accounting/product-costs/route.ts:182`・`stripe-backfill/route.ts:90`・`stripe-payouts/[id]/confirm/route.ts:116`、`src/app/api/admin/kpi/cost-profit/route.ts:1575`・`cost-profit/receipt/route.ts:151`、`src/app/api/admin/role-permissions/route.ts:71`、`src/app/api/admin/settings/shop/route.ts:250`、`src/app/api/admin/users/route.ts:196`、`src/app/api/items/route.ts:72`、`src/app/api/contact/route.ts:80-81`（自前の `getClientIp`。`submitted_ip` は text で null 可: `supabase/migrations/20260901102912_remote_schema.sql:496`）、`src/app/api/wishlist/route.ts:17`・`src/app/api/wishlist/[id]/route.ts:12`（自前の `getClientIp`）、`src/lib/stripe/webhook-processor.ts:26-27`（同）
- Test（見出しを `x-forwarded-for` から `x-real-ip` に直す。ほかの期待は変えない）: `tests/unit/api/admin/{role-permissions-route,shop-settings-route}.test.ts`
- Docs: `docs/05_Quality/security/threats/` と `docs/03_BasicDesign/areas/` の該当領域のうち、これらの XFF の記述を『`getClientIp`（ADR-0416）』に直す（範囲内の領域だけ。範囲外は台帳の『読み方を寄せた』記録のみ）。共有文書の変更案があれば報告に書く

- [ ] **Step 1: 現状の確認（読むだけ）。** 13 ファイルそれぞれの XFF の値の使い道（監査の ip・回数の制限の鍵・DB の列）と、null になった時の動き（列が null 可か、鍵が `null` で通るか）を 1 か所ずつ表にする。null で壊れる所があれば止めて報告する。
- [ ] **Step 2（RED）→ Step 3（GREEN）。** 試験の見出しを直して赤にし、`getClientIp(request)` に替える。自前の `getClientIp` の定義と未使用の import を消す（自分の変更で未使用になった物だけ）。`tsc`。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/unit/api/admin/role-permissions-route.test.ts tests/unit/api/admin/shop-settings-route.test.ts` と、触った窓口の既存の単体・結合の試験。
- [ ] **Step 5: 報告。** 表、変えたファイル。E2E の印は外さない。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`。

---

## Task 2c: XFF の直読みを `getClientIp` に寄せる（G/H の 12 ファイル。触る前に G-1 へ知らせる）

**前提:** 決定 `:29` のとおり、checkout・cart を触る前に controller が G-1 へ知らせる（触るファイル、『読み方だけを `getClientIp` に替える。自前の複製を消す。形は変えない』）。返事（異議なし）を得てから着手する。`git status` で G-4／H が同じファイルを変更中でないことを確かめる。

**範囲:** G/H（orders・returns・shipping・checkout・cart）の XFF の直読み 12 ファイル。Task 2b と同じ作法（保存先・変数名・使い方は変えず、読み方だけ）。G-1 が『読み方だけ `request-ip.ts` に寄せてよい（中身は変えない）』と答え済み（`wave4-decisions.md:28`）。

**Files:**

- Modify: `src/app/api/admin/orders/[id]/emails/resend/route.ts:68`・`refund/route.ts:113`・`refund/confirm/route.ts:53`・`status/route.ts:104`、`src/lib/orders/returns/customer-return-route-support.ts:140`・`return-route-support.ts:234`、`src/lib/orders/tracking/delivery-route-support.ts:56`、`src/app/api/checkout/complete/route.ts:36-37`・`create-session/route.ts:90-91`（自前の `getClientIp`）、`src/features/checkout/services/checkout-route-guard.ts:77`（自前の `getClientIp`。`export` だが外から import されていない）、`src/app/api/cart/add/route.ts:12-13`・`cart/change/route.ts:11-12`（自前の `clientIpOf`）
- Test（見出しを `x-real-ip` に直す。ほかの期待は変えない）: `tests/unit/lib/orders/returns/*`（4）、`tests/unit/api/admin/{order-email-routes,order-refund-route}.test.ts`、`tests/unit/features/checkout/services/checkout-route-guard.test.ts`
- Docs: Task 2b と同じ

- [ ] **Step 0: G-1 への連絡。** controller が連絡して返事を得た旨を報告の冒頭に書く。得ていなければ止める。
- [ ] **Step 1〜5: Task 2b と同じ**（使い道の表、試験の見出し、置き換え、複製の削除、対象の `jest`、報告）。回数の制限の鍵に自前の IP を使う物が在れば（決定 `:29` は checkout・cart を挙げる）、鍵が `null` で通ることを単体で確かめる。

**検証コマンド:** `npx tsc --noEmit`、`npx jest tests/unit/lib/orders tests/unit/api/admin/order-email-routes.test.ts tests/unit/api/admin/order-refund-route.test.ts tests/unit/features/checkout`、`npm run validate-docs`。

---

## Task 3: E2E の固定の環境に `CLIENT_IP_HEADER` を入れる

**前提:** `scripts/e2e/**` は他セッションが触りうる。着手前に controller が G-1 の了承を取る。

**範囲:** E2E のアプリ（本番ビルド）が `x-real-ip` を送り元として信頼するようにする。**見張りは足さない**（P6）。`findUnsafeE2ESettings` は Supabase の住所が手元でなければ条件なしで既に止める（`scripts/e2e/environment.ts:148-150`、`scripts/e2e-server.mjs:91-92`）。`E2E_FIXED_ENV` は `buildE2EOverrides` の中で手元の Supabase の状態を読んだ後にだけ混ざるので、『`CLIENT_IP_HEADER` が在るのに手元でない』は独立に効く場面が無く、足す試験も既存の条件だけで通ってしまう。最小は、『`E2E_FIXED_ENV` は `buildE2EOverrides` の中だけで混ぜ、既存の見張りが手元の Supabase を保証する』を文書に書くこと。

**Files:**

- Modify: `scripts/e2e/environment.ts`（`E2E_FIXED_ENV` に `CLIENT_IP_HEADER: 'x-real-ip'` を 1 行。`E2E_FIXED_ENV` の注に、`buildE2EOverrides` の中だけで混ぜ、手元の Supabase は既存の `findUnsafeE2ESettings` が保証することを書く）、`.env.example`（`CLIENT_IP_HEADER` は E2E 専用・本番に置かない旨）。**`findUnsafeE2ESettings`・`scripts/e2e-server.mjs` は変えない**
- Test: `tests/unit/scripts/e2e/environment.test.ts`（`buildE2EOverrides` が `CLIENT_IP_HEADER: 'x-real-ip'` を持つ。`computeServerFingerprint` の印がキーで変わる）
- Docs: `docs/06_Operations/secrets.md`（`CLIENT_IP_HEADER` の節: E2E 専用・本番は `VERCEL=1` で足りる・非 Vercel の置き場で使う時の約束）、`docs/06_Operations/deployment-topology.md`（本番は Vercel 直で前段の中継を置かない前提・置く時は `TRUSTED_PROXY_HOPS` の設計が要る・最初の preview で偽の `x-real-ip` と偽の XFF を送って上書きを実測する手順。『`E2E_FIXED_ENV` は `buildE2EOverrides` の中だけで混ぜ、既存の見張りが手元の Supabase を保証する』）、`docs/03_BasicDesign/decisions/ADR-0416-*.md` の「結果」に環境変数の約束を足す

**Interfaces:**

```ts
// scripts/e2e/environment.ts
export const E2E_FIXED_ENV = { /* 既存 */, CLIENT_IP_HEADER: 'x-real-ip' };
// findUnsafeE2ESettings・scripts/e2e-server.mjs の findUnsafeSettings は変えない（Supabase が手元でなければ既に止める）
```

- [ ] **Step 1: 現状の確認（読むだけ）。** P6 の事実を確かめる。`E2E_FIXED_ENV` が `buildE2EOverrides` 以外から混ざらないこと、`findUnsafeE2ESettings` が手元でない Supabase の住所を条件なしで止めることを `environment.ts`・`e2e-server.mjs` で読む。
- [ ] **Step 2（RED）→ Step 3（GREEN）。** 上の仕様。`tsc`。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/unit/scripts/e2e/environment.test.ts`。
- [ ] **Step 5: 文書。** Docs。
- [ ] **Step 6: 報告。** 「3000 番の古いアプリは印が変わるので使い回されない。controller の最後の E2E は 3000 番を止めてから」と書く。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`。

---

## Task 4: AUTH の制限部品の `try/catch` を静的 import にして外す

**範囲:** `src/app/api/auth/` の 14 ファイル・19 か所（P1）。`await import('@/features/auth/middleware/rateLimit')` を先頭の `import { enforceRateLimit } from '@/features/auth/middleware/rateLimit'` に替え、`try { ... } catch (e) { console.error('Rate limit middleware error ...') }` を外して中身だけ残す。数えの DB の失敗は今も `enforceRateLimit` が自分で 503 にする（`rateLimit.ts:45-66`）ので変わらない。外側の `catch` の 500 になるのは、呼び出しが投げた時（作り物が投げた時）だけ（ruling 5）。`login/resend` は静的 import のまま `try/catch` だけ外す。

**Files:**

- Modify: `src/app/api/auth/{confirm,login,login/resend,mfa/enroll-totp,mfa/verify,oauth/callback,oauth/start,otp/verify,password-reset/confirm,password-reset/link,password-reset/request,post-login,refresh,register}/route.ts`
- Test: 各窓口の単体・結合（`tests/unit/api/auth/`・`tests/integration/api/auth*`・`tests/integration/api/auth/`）のうち、`@/features/auth/middleware/rateLimit` を `jest.mock`／`jest.doMock` で差し替え、「制限が投げても先へ進む」を固定している物（`grep -rn "Rate limit middleware error\|rateLimit.*mockRejected" tests`）。静的 import になると `jest.doMock` が効かない物は `jest.mock` に直す。足す物: `SEC-AUTH-013-AC-02` の新しい形を二段で（①数えの DB の失敗は 503＝部品が返す（`rateLimit.test.ts`）、②ログイン・OTP・TOTP・再設定・確認・更新で `enforceRateLimit` が投げると、窓口が先へ進まず 5xx で、`signInWithPassword` などが呼ばれない）
- Docs: `docs/02_Requirements/areas/auth.md`（`SEC-AUTH-013-AC-02` を二段で書く: 『数えの DB の失敗は 503（`enforceRateLimit` が返す）、呼び出しが投げたら先へ進まず 5xx（外側の catch の 500）』。ruling 5。`SEC-AUTH-013` 本文の「窓口は…握りつぶさず 503 で断る」も同じ。**`ADR-0009-rate-limit-fail-closed`（503 で断る）と食い違わないことを確かめ、食い違う記述があれば直す**）、`docs/05_Quality/security/threats/auth.md`、`docs/03_BasicDesign/areas/auth.md`（窓口の構造の記述）、`docs/04_DetailDesign/pages/14_login.md`（`DD-AUTH-038` の節、窓口ごとの `DD-` に「握りつぶして先へ進む」の記述が在れば直す: `grep -n "握りつぶ" docs/04_DetailDesign/pages/14_login.md`）。触る窓口の `@remarks` に「制限の呼び出しの例外は握りつぶさない」と食い違う記述が在れば直す

- [ ] **Step 1: 現状の確認（読むだけ）。** P1 の 19 か所を `file:line` の表にする。各窓口の外側の `catch` が返す状態（login・otp・refresh・mfa/verify は 500）を表にする。`confirm`・`oauth/*`・`post-login`・`password-reset/link` は戻り方が違うので個別に読む（リダイレクトを返す窓口の例外時の動きを変えない）。
- [ ] **Step 2（RED）: 試験を書く／直す。** Test のとおり。
- [ ] **Step 3（GREEN）: 直す。** 1 窓口ずつ。`tsc`。`Rate limit middleware error` の文字列が `src/app/api/auth` から消えることを `grep` で確かめる。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/unit/api/auth tests/integration/api/auth tests/integration/api/auth-bot-rate-limit.test.ts tests/integration/api/auth-login-api.test.ts tests/integration/api/auth-password-reset-request-api.test.ts`（実際の場所は Step 1 の `grep` に従う）。
- [ ] **Step 5: 文書と報告。** `validate-docs`・`validate-trace -- AUTH`。残りの動的 import（P1 の 12 ファイル）は台帳に載せる。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。

---

## Task 5: E2E の送り元の書き換え（AUTH 系）と `FR-LOGIN-035:228` の反転

**範囲:** 共通の補助 1 つと AUTH 系の spec 13 ファイル。書き換えは P8 の方針（名前を `'x-real-ip'` にするだけ）。

**Files:**

- Modify（共通の補助）: `e2e/member-session-helpers.ts`（`:126` の `sourceHeaders`。関数の引数名 `forwardedFor` は変えない。注の「x-forwarded-for を…」を直す）
- Modify（spec）: `FR-LOGIN-024`（`:69,110`）、`FR-LOGIN-030`（`:107,165,213,237,311`）、`FR-LOGIN-031`（`:474`）、`FR-LOGIN-032`（`:165,220,313,320,446,526`）、`FR-LOGIN-034`（`:108,212,264,304`）、`FR-LOGIN-035`（`:86` だけ。`:236` は AC-01 の要求そのもの（XFF を毎回変え、固定の `x-real-ip` を付ける専用の送り方）なので名前を変えない。Step 3）、`FR-LOGIN-036`（`:67`）、`FR-LOGIN-038`（`:148,211,437,563`）、`FR-PWRESET-002`（`:99`）、`FR-PWRESET-009`（`:48,89,215,260`）、`FR-PWRESET-010`（`:80,114,136,198,210,244`）、`FR-SIGNUP-002`（`:73`）、`FR-SIGNUP-003`（`:132,220,243`）。各ファイルの冒頭の「x-forwarded-for を送り元に数える作りに頼る」の注を、`x-real-ip`（E2E の固定の環境 `CLIENT_IP_HEADER`）の説明に直す
- Docs: `docs/02_Requirements/areas/auth.md`（`SEC-AUTH-013-AC-01` の確かめ方を「E2E（`CLIENT_IP_HEADER` の E2E のアプリで、`x-real-ip` を固定し XFF を毎回変えて送る）」に）、`E2E ファイルと受け入れ条件の対応表`

- [ ] **Step 1: 現状の確認（読むだけ）。** 各行が**アプリ向け**であることを確かめる（GoTrue 直は P5 の 3 か所だけ）。`FR-LOGIN-032:313` の `page.context().setExtraHTTPHeaders` はブラウザの全要求に付く。
- [ ] **Step 2: 書き換える。** 上の行。値の作り方は変えない。
- [ ] **Step 3: 反転する試験を直す。** `FR-LOGIN-035:228`（`SEC-AUTH-013-AC-01`、3 幅）: 1 試験ごとに固定の `x-real-ip`（`uniqueForwardedFor()` を 1 度だけ呼んだ値）を付け、XFF は毎回変える。31 回目が 429。`test.fail` の行を外す。**`:236` は名前を `x-real-ip` に変えない**（変えると `x-real-ip` が毎回変わり 429 にならない）。専用の送り方: 試験の先頭で `const fixedRealIp = uniqueForwardedFor();` を 1 度だけ呼び、31 回とも `headers: { 'x-real-ip': fixedRealIp, 'x-forwarded-for': uniqueForwardedFor(), origin }`。
- [ ] **Step 4: 確かめ（書くだけ）。** `grep -rnE "'x-forwarded-for'" e2e/FR-LOGIN-0* e2e/FR-PWRESET-* e2e/FR-SIGNUP-* e2e/member-session-helpers.ts` は `FR-LOGIN-035:236`（例外②の専用の送り方）だけ。`npx tsc --noEmit`（`e2e` が型の対象なら）、`npm run validate-docs`。
- [ ] **Step 5: 報告。** 書き換えた行の一覧、外した印の行番号（`:228`）、共有文書の変更案（なし）。

**検証コマンド:** 上の `grep`、`npx tsc --noEmit`、`npm run validate-docs`。

---

## Task 6: E2E の送り元の書き換え（SEARCH・NEWS・WISHLIST）と `SEARCH-022`・`NEWS-SEC-003` の反転

**Files:**

- Modify（spec）: `FR-SEARCH-018`（`:15`）、`019`（`:48`）、`020`（`:37`。`API_FORWARDED_FOR` の見出し名）、`021`（`:36`）、`022`（`:194,203,288,291`。`proxyHeaders`（`:117-119`）は 3 つの見出しを付けており**そのまま**）、`023`（`:8`）、`024`（`:7`）、`FR-NEWS-SEC-003`（`:65` の `getNews` は見出しを `x-real-ip` に変えるが、AC-01（`:219`）は `getNews` を使わず Step 2 の専用の送り方を使う）、`FR-WISHLIST-011`（`:199,211`。ウィッシュリストはカート寄りだが決定の G/H の一覧（orders・returns・shipping・purchasing・checkout・cart）に無い。**ruling 11**）。冒頭の注（`SEC-SEARCH-006 が直って…効かなくなる`）を直す
- Docs: `docs/02_Requirements/areas/search.md`（`SEC-SEARCH-006`・`020` の「今のコードは満たさない」「偽の送り元の側は波 4 まで赤」を外す。`FR-SEARCH-022` の行の注）、`docs/05_Quality/security/threats/search.md`（`THR-SEARCH-006`・`020`）、`docs/03_BasicDesign/areas/search.md`、`docs/04_DetailDesign/pages/19_search.md`（`:830` の「波 4」の記述）、`docs/03_BasicDesign/decisions/ADR-0312-*.md`（「偽の送り元の側は波 4」→ 直した）、`docs/02_Requirements/areas/news.md`（`SEC-NEWS-011`）、`docs/05_Quality/security/threats/news.md`、`docs/03_BasicDesign/areas/news.md`

- [ ] **Step 1: 書き換える。** P8 の方針。
- [ ] **Step 2: 反転する試験を直す。** `FR-SEARCH-022:281`（`SEC-SEARCH-006-AC-01`）と `:300`（`SEC-SEARCH-020-AC-01`、3 幅）は**試験の中身を変えずに** `test.fail` を外す（isolated-global の project。`proxyHeaders` は `x-vercel-forwarded-for` と `x-real-ip` に攻撃者の IP を付けるので、攻撃者の 21 回が利用者 A の枠を使わない）。`FR-NEWS-SEC-003:213`（`SEC-NEWS-011-AC-01`）は 1 試験に固定の `x-real-ip` を付け、XFF は毎回変えて 61 回目が 429、`test.fail` を外す。専用の送り方 `getNewsFromFixedSource(request, fixedRealIp, forwardedFor)`（`headers: { 'x-real-ip': fixedRealIp, 'x-forwarded-for': forwardedFor }`）を足し、`:219` の `getNews(request, uniqueForwardedFor())` をそれに替える（`getNews` は使わない。`getNews` を `x-real-ip` に変えたまま AC-01 が呼ぶと、`x-real-ip` が毎回変わって枠を逃れ、429 にならない）。
- [ ] **Step 3: 確かめ（書くだけ）。** 外した行は `FR-SEARCH-022:281,300`・`FR-NEWS-SEC-003:213` の 3 か所。`grep -rn "'x-forwarded-for'" e2e/FR-SEARCH-* e2e/FR-NEWS-SEC-003* e2e/FR-WISHLIST-011*` は `FR-SEARCH-022` の `proxyHeaders` の XFF（`:117`）と `FR-NEWS-SEC-003` の専用の送り方の XFF だけ。
- [ ] **Step 4: 文書・報告。** `validate-docs`・`validate-trace -- SEARCH`・`-- NEWS`。

**検証コマンド:** 上の `grep`、`npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- SEARCH`、`-- NEWS`。

---

## Task 7: `admin-rbac` に `denial`（`permissions` は Task 0）、`audit.ts` に制御文字の除去、`auditAuthzDenial`（追加のみ）

**前提:** `admin-rbac.ts`・`audit.ts` を G-4／H が触っていないことを `git status` で確かめる（設計 §4）。

**範囲:** 呼び手が使うまで挙動は変わらない追加。

**Files:**

- Modify: `src/lib/auth/admin-rbac.ts`（`AuthzFailure` に `denial?`、`AuthzFailure`・`AuthzDenial` を export。`AuthzSuccess` の `permissions` は Task 0 で追加済み）、`src/lib/audit.ts`（`maskAuditEvent` が `detail` と `metadata` の文字列（入れ子も）の `[\p{Cc}\p{Cf}]` を空白にする）
- Create: `src/lib/auth/audit-authz-denial.ts`、`tests/unit/lib/auth/audit-authz-denial.test.ts`
- Modify: `scripts/trace/scope.json`（STOCKIST の `src`・`tests`。`@impl IMPL-STOCKIST-150` を付ける）
- Test: `tests/unit/lib/auth/admin-rbac.test.ts`（①失効した session の 401 に `denial.reason === 'session'`、②足りない権限の 403 に `denial.reason === 'permission'` と `permission` が足りない最初の物、③aal1 の 403 に `reason === 'mfa'`、④**トークン無しの 401・503・500 には `denial` が無い**、⑤成功の結果の形（`permissions` は Task 0 で足した物）が変わっていない）、`tests/unit/lib/audit.masking.test.ts`（制御文字を含む `detail`・`metadata` が空白になる・無い物は変わらない・元の event を壊さない）
- Docs: `docs/04_DetailDesign/pages/10_stockist.md` に `DD-STOCKIST-039`（項目だけ。`auditAuthzDenial` の仕様の要約）、`docs/02_Requirements/areas/stockist.md`（`SEC-STOCKIST-021-AC-03` の文。確かめ方は結合テスト）

**Interfaces:**

```ts
// admin-rbac.ts
export type AuthzDenial = { userId: string; email: string | null; role: AppRole; permission: PermissionCode; reason: 'permission' | 'mfa' | 'session' };
export type AuthzFailure = { ok: false; response: NextResponse; denial?: AuthzDenial };
type AuthzSuccess = { ok: true; userId: string; role: AppRole; actorEmail: string | null; permissions: ReadonlySet<PermissionCode> }; // permissions は Task 0 で追加済み
// audit-authz-denial.ts（@impl IMPL-STOCKIST-150・@design DD-STOCKIST-039。投げない）
export const AUTHZ_DENIAL_AUDIT_LIMIT = 20;   // 操作者ごとに 600 秒で 20 行
export async function auditAuthzDenial(authz: AuthzFailure, input: { request: Request; action: string; resource: string }): Promise<void>;
//   denial が無ければ何もしない。incrementCounter({ endpoint: 'admin_authz_denial_audit', bucket, subject: denial.userId }) の count が 20 以下なら logAudit({ outcome: 'failure', detail: `Forbidden: ${permission} (${reason})`, metadata: { permission, reason, role }, actor_id, actor_email, ...getAuditRequestContext(request) })、21 なら outcome 'denied_burst' の 1 行、それ以上と数え失敗は何も書かない
```

- [ ] **Step 1: 現状の確認（読むだけ）。** P10・P11。`authorizeAdminPermissions` の 3 つの拒否の `return` の位置を確かめる。
- [ ] **Step 2（RED）→ Step 3（GREEN）。** 試験を書き、実装する。`audit-authz-denial.ts` に `@impl IMPL-STOCKIST-150`・`@design DD-STOCKIST-039`・`@remarks`（なぜ操作者ごとの上限か）を付ける。`denial` を足しても既存の呼び手が壊れないこと（`tsc`）。`audit.ts` は `JSON.parse(JSON.stringify(...))` の後ろで文字列を走査する。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/unit/lib/auth tests/unit/lib/audit.masking.test.ts tests/unit/lib/audit.test.ts tests/integration/api/admin-misc/admin-authorization-path.test.ts`。管理 API の試験は `admin-rbac` をモックしているので、`npx jest tests/unit/api/admin` を流して赤が増えていないことも確かめる。
- [ ] **Step 5: 文書・報告。** 共有文書の変更案（なし）。`validate-docs`・`validate-trace -- STOCKIST`。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- STOCKIST`。

---

## Task 8: 取扱店（SEC-STOCKIST-012・019・020・021）

**範囲:** 6 窓口＋新しい `access`。**Task 2 で監査の IP は替え済み**（`SEC-STOCKIST-012`）。ここでは順序の入れ替え・拒否の監査・作成の頁の入口・E2E を行う。

**Files:**

- Modify: `src/features/stockist/services/admin-security.ts`（`enforceStockistAdminRateLimit` を `enforceAdminStockistIpRateLimit(request, kind)`（subject なし）と `enforceAdminStockistActorRateLimit(request, actorId, kind)` に分ける。`kind` は `'read' | 'mutation'`。限度・窓・endpoint は不変）、`src/app/api/admin/stockists/route.ts`・`[id]/route.ts`（P9 の順序。拒否の枝で `auditAuthzDenial`）、`src/app/admin/stockist/create/page.tsx`
- Create: `src/app/api/admin/stockists/access/route.ts`（P15。`@impl IMPL-STOCKIST-151`、`@design DD-STOCKIST-040`）
- Test: `tests/integration/api/stockist-admin-guards.test.ts`（呼ぶ順番、送り元の枠が認可の前）、`tests/unit/api/admin/stockists-security.test.ts`、`tests/unit/api/admin/stockists/{stockists-route,stockists-id-route}.test.ts`、`tests/integration/api/stockist-admin-{create,list,item-get,item-patch,item-put,item-delete,write-path}-api.test.ts`（拒否の枝で `auditAuthzDenial` が呼ばれる・token 無しの 401 では呼ばれない）、`tests/unit/app/admin/stockist/stockist-create-page.test.tsx`（`access` が通るまで「読み込み中」、通ればフォーム、401／403 で誤りの文でフォーム無し）、新しい `access` の結合試験 `tests/integration/api/stockist-admin-access-api.test.ts`（204・401・403・`no-store`・送り元の枠が認可の前）
- E2E: `e2e/stockist-admin-test-utils.ts`（`:72,87,94`）、`FR-STOCKIST-014`（`:289` の `extraHTTPHeaders` と `uniqueForwardedFor` の見出し）、`FR-STOCKIST-015`（`:144`）。**外す**: `FR-STOCKIST-014:520`（`SEC-STOCKIST-020-AC-01`）、`:550`（`SEC-STOCKIST-021-AC-01`）、`FR-STOCKIST-015:280`（`SEC-STOCKIST-012-AC-01`）、`FR-STOCKIST-013:319`（`SEC-STOCKIST-019-AC-01` の作成）・`:331`（`SEC-STOCKIST-019-AC-02`）。**この 2 つは印を外すだけでは足りない**: `toHaveCount(0)`（店舗名の入力欄が無い）は頁が「読み込み中...」の間に即座に通り、窓口がのちにフォームを出しても緑のままになる（空振り）。編集の試験（`:325`）と同じく、入力欄の確かめの前に `await expect(page.getByText('読み込み中')).toHaveCount(0);` を足し、`main .text-red-600` が見えて文字を持つことの確かめも足す（`:319` は未ログインの 401 の文、`:331` はサポーターの 403 の文）。**足す**: `SEC-STOCKIST-019-AC-03`（`access` が店長 204・サポーター 403・未ログイン 401・`no-store`）、`SEC-STOCKIST-021-AC-02`（token 無しの 401 では行が増えない。並列の実行では `audit_logs` 全体の件数が揺れるので全体は数えず、この試験の固定の `x-real-ip` で絞った行 `select count(*)::int as n from public.audit_logs where ip = $1 and resource = 'stockists'` が 0 件のままであることで確かめる）。`FR-STOCKIST-015:208`（`SEC-STOCKIST-007-AC-02`）は見出しを `x-real-ip` にして毎回変える（操作者の枠だけが 21 回目を止める確かめ。XFF のままだと全部が `ip null` の 1 つの枠になり、止めるのが送り元の枠に変わって意味が変わる）。`FR-STOCKIST-015:280` は `x-forwarded-for: 203.0.113.9` に別の `x-real-ip` を付け、行の `ip` が `x-real-ip` の値で XFF の値を含まないことを見る（Review Focus 6）
- Docs: `docs/02_Requirements/areas/stockist.md`（`SEC-STOCKIST-012`・`019`・`020`・`021` の「今のコードは満たさない」を外す。AC-03・021-AC-02 を足す。対応表）、`docs/05_Quality/security/threats/stockist.md`、`docs/03_BasicDesign/areas/stockist.md`（窓口の順序・`access`・`API-STOCKIST-007`）、`docs/03_BasicDesign/decisions/ADR-0268-stockist-authz-denial-audit-per-actor-cap.md`・`ADR-0269-stockist-create-page-access-gate.md`（新規）、`ADR-0259`・`ADR-0261` の更新、`docs/04_DetailDesign/pages/10_stockist.md`・`16-4_admin_stockist.md`（`DD-STOCKIST-039` に順序の節、`DD-STOCKIST-040`）。窓口の `@remarks` の「回数の制限を認可の後に呼ぶので…SEC-STOCKIST-020 を満たさない（推定）」を直す。共有文書の変更案: `api-spec.md`・`route-inventory.md`（`GET /api/admin/stockists/access` の行。155 ファイル・197 メソッド、表は 154 行・196 メソッド）

- [ ] **Step 1: 現状の確認（読むだけ）。** P9・P10・P15。`FR-STOCKIST-013:298-312` の「`adminApiRequests` が `/api/admin/stockists/` で始まる物だけ」の確かめが `access` を許すことを確かめる。
- [ ] **Step 2（RED）: 試験を書く。** Test のとおり。順序の試験は `rateLimit`・`authorizeAdminPermission` のモックの呼び出し順で見る。
- [ ] **Step 3（GREEN）: 実装する。** 順序の入れ替え → 拒否の監査 → `access` → 作成の頁。`access` は `GET` だけ。`tsc`。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/unit/api/admin/stockists tests/unit/api/admin/stockists-security.test.ts tests/integration/api/stockist-admin tests/unit/app/admin/stockist tests/unit/features/stockist`。proxy の試験群（`stockist-proxy.test.ts` ほか）。
- [ ] **Step 5: E2E の印と書き換え（書くだけ）。** 上のとおり。
- [ ] **Step 6: 文書・確かめ・報告。** `validate-docs`・`validate-trace -- STOCKIST`。窓口の数が 1 本増えることを報告に明記する。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- STOCKIST`。

---

## Task 9: ADMIN の監査（SEC-ADMIN-009・022・023(IP)）

**範囲:** ADMIN の範囲（`scripts/trace/scope.json`）の窓口の `logAudit` に行為者のメール・IP・ブラウザの名乗りを足し、色見本の作成・削除の監査を新しく書き、読み出しの記録に IP を足す。**強制失効・2 要素のリセットの IP は Task 2 で替え済み**。管理の窓口のうち注文・会計・KPI・設定・権限・利用者は、行為者・IP の項目を新しく足さない（IP の読み方は Task 2b・2c で `getClientIp` に寄せる。ruling 7）。

**Files:**

- Modify: `src/app/api/admin/create-user/route.ts`（`:47,63,75,97,108,119` の 6 か所）、`src/app/api/admin/contact/route.ts`（`:86` の読み）、`contact/[id]/route.ts`（`:69` の読み、`:124,136` の状態の変更）、`contact/[id]/reply/route.ts`（`:94,125`）、`contact/templates/route.ts`（`:89`）、`contact/templates/[id]/route.ts`（`:69,81,129,141`）、`src/app/api/admin/audit-logs/route.ts`（`:52` の読み）、`item-color-presets/route.ts`（POST の 201 に `admin.item_color_preset.create`、`resource: 'item_color_preset'`、`resource_id: String(data.id)`）、`item-color-presets/[id]/route.ts`（削除成功に `admin.item_color_preset.delete`）。`revoke-user-sessions/route.ts:94`（`audit` の閉包）は `ip`・`user_agent` を持たないので足す。全部に `actor_id`・`actor_email: authz.actorEmail`・`...getAuditRequestContext(request)`（IP は null のまま保存）。色の名前や値は入れない
- Test: 窓口ごとの単体（`tests/unit/api/admin/{create-user-route,admin-contact-*,item-color-presets-route,item-color-presets-id-route,revoke-user-sessions-route,mfa-reset-route}.test.ts`）に `expect.objectContaining({ actor_email, ip, user_agent })` を足す。**現状固定の書き換え**: `tests/integration/api/admin-contact-{detail,list,reply,status,templates-create,templates-delete,templates-update}-api.test.ts` の `expect(rows[0].ip).toBeUndefined()` を、IP が入る期待へ。色見本の結合（監査の行が 2 つ）。`tests/integration/api/admin/audit-logs.test.ts:207` は読み出しの**応答**の列なので変えない
- E2E: `e2e/FR-ADMIN-MISC-003`（`:162` の見出し。`:254` の偽の XFF は残し、`x-real-ip` を別に付けて行の `ip` が `x-real-ip` の値で偽の値を含まないことを見る。**外す**: `:248`）、`FR-ADMIN-MISC-007`（`:110` の `adminHeaders`。**外す**: `:411`。`SEC-ADMIN-006-AC-02` の `:313` の XFF を変える試験はそのまま）、`FR-ADMIN-MISC-005`（**外す**: `:390`。`:219` は外さない）、`FR-ADMIN-MISC-004`（`SEC-ADMIN-023-AC-02`: 読んだ人の IP が入る、を足す）
- Docs: `docs/02_Requirements/areas/admin.md`（`SEC-ADMIN-009`・`022`・`023` の「今のコードは満たさない」を外す。`:1080` の「読んだ人の IP は今のコードは満たさない」を直す。`SEC-ADMIN-022-AC-03`・`SEC-ADMIN-023-AC-02` を足す。対応表）、`docs/05_Quality/security/threats/admin.md`（`:407` 付近の `THR-ADMIN-`）、`docs/03_BasicDesign/areas/admin.md`（`:150` の「id とメールだけで 1 行ずつ」→ IP・ブラウザの名乗りも）、`docs/03_BasicDesign/decisions/ADR-0462-admin-audit-keeps-client-ip.md`（新規。背景: `ADR-0158`・`ADR-0010` が「残さない」とした理由は見出しを偽れるから→ `getClientIp` で解けた／決定: 管理の操作の監査に IP を残す。取れなければ null／理由: 管理者だけが対象・乗っ取られた session の追跡・OWASP Logging／退けた案: 残さない・XFF の右から数える／結果: 個人情報にあたりうる。保存期間は法令対応の後回しに従う／未確認事項: 保存期間・開示）、`docs/04_DetailDesign/pages/16-2_admin_misc.md`（`DD-ADMIN-016`。`:312,441,511` の「読んだ人の IP は入れない」を直す。`DD-ADMIN-002/003/005/006/007/012` の監査の記述）、`ADR-0460`・`ADR-0461` の記述に IP の言及が在れば整える

- [ ] **Step 1: 現状の確認（読むだけ）。** P12。各 `logAudit` の呼び出しが `request` を使える位置か（`audit` の閉包・関数の引数）を表にする。`FR-ADMIN-MISC-005:390` の判定（`color` の語で行を見分ける）に合う `action`／`resource` の名前か。
- [ ] **Step 2（RED）→ Step 3（GREEN）。** 窓口ごとに。`create-user` の失敗の `detail` の固定の文（ADR-0461 の流儀）は変えない。`tsc`。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/unit/api/admin tests/integration/api/admin-misc tests/integration/api/admin tests/integration/api/admin-contact-*`。
- [ ] **Step 5: E2E の印と書き換え（書くだけ）。** 外す行は `FR-ADMIN-MISC-003:248`・`FR-ADMIN-MISC-005:390`・`FR-ADMIN-MISC-007:411` の 3 か所。
- [ ] **Step 6: 文書・確かめ・報告。** `validate-docs`・`validate-trace -- ADMIN`。Task 2b・2c で寄せた XFF の読み（P7 の 25）が `getClientIp` になっていることを `grep` で確かめ、報告に再掲する。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- ADMIN`。

---

## Task 10: LOOK・NEWS の監査に IP（SEC-LOOK-020・NEWS-016 の改め、Q13）

**範囲:** `logAdminLookAudit`（1 か所）と、NEWS の `logNewsAudit`（2 か所）に `...getAuditRequestContext(request)`。**NEWS を含めることは決定済み**（決定 Q13 が `ADR-0010` を改めると明記。ruling 3）。

**Files:**

- Modify: `src/features/look/services/admin-audit.ts`（`@remarks` の「IP は渡さない」の説明を直す。`getRequestUserAgent` は `getAuditRequestContext` に置き換わる）、`src/app/api/admin/news/route.ts`（`:36-39` のコメントと `:53-`）、`src/app/api/admin/news/[id]/route.ts`（`:53-`）
- Test: `tests/integration/api/look-admin-{create,item-delete,item-get,item-patch,item-put,write-path}-api.test.ts`（`rows[0].ip` が undefined → IP が入る。`look-admin-write-path.test.ts:355` 付近の「IP は残さない」）、`tests/unit/api/admin/looks-audit.test.ts`、`tests/integration/api/news-admin-{create-api,item-put-api,write-path}.test.ts`（`:217,271,232` 付近の `ip` が undefined）、`tests/unit/api/admin/news`
- E2E: `e2e/look-admin-test-utils.ts`（`:46`）、`FR-LOOK-DETAIL-019`（`:17`）、`FR-LOOK-SEC-003`（`:92`。冒頭の注の `SEC-LOOK-011-AC-01` の説明、`:371` の `SEC-LOOK-011-AC-01` は見出しを `x-real-ip` にして毎回変える（操作者の枠だけが止める確かめ。固定の IP だと送り元の枠が先に止めて意味が変わる））、`FR-LOOK-SEC-004`（`:213`。**外す**: `:429`（`SEC-LOOK-020-AC-02`））、`FR-LOOK-SEC-005`（`:74,208`）、`FR-NEWS-SEC-005`（`:221` の見出し。`:263` 付近の `SEC-NEWS-016-AC-01`（IP の値が入っていない）は**逆の期待に書き換える**: `x-real-ip` の値が入る）
- Docs: `docs/02_Requirements/areas/look.md`（`SEC-LOOK-011`・`020` の満たさない旨を外す）、`docs/02_Requirements/areas/news.md`（`SEC-NEWS-016-AC-01` の「IP の値が入っていない」を `SEC-NEWS-016-AC-03` の「入る」へ。`:2150` の「IP は見出しを偽れるので残さない」）、`docs/05_Quality/security/threats/{look,news}.md`、`docs/03_BasicDesign/areas/{look,news}.md`、`docs/03_BasicDesign/decisions/ADR-0158-*.md`・`ADR-0010-*.md`（状態を「置き換え済み（`ADR-0462`）」に。本文は残す）、`ADR-0154` の XFF の記述、`docs/04_DetailDesign/pages/16-3_admin_look.md`・`16-1_admin_news.md`（監査の節）

- [ ] **Step 1〜3: 読む → 試験 → 実装。**
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/integration/api/look-admin tests/unit/api/admin/looks tests/unit/api/admin/looks-audit.test.ts tests/integration/api/news-admin tests/unit/api/admin/news`。
- [ ] **Step 5: E2E（書くだけ）。** 外す行は `FR-LOOK-SEC-004:429` の 1 か所。
- [ ] **Step 6: 文書・報告。** `validate-docs`・`validate-trace -- LOOK`・`-- NEWS`。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- LOOK`、`-- NEWS`。

---

## Task 11: （欠番。CONTACT タブ・LOOK の「新規作成」は Task 0 へ移した）

---

## Task 12: G/H の E2E の送り元の書き換え（G-1 の了承が要る）

**前提:** 対象は G/H（orders・returns・shipping・checkout・cart）の E2E。**着手前に controller が一覧（下の Files）を先に G-1 に送り、了承を取る**（決定 `:30`）。controller が最後の E2E を流す前に必ず済ませる（済んでいないと注文の状況・返品・配送の E2E が `ip null` の枠を取り合って 429 になる。Review Focus 2）。

**Files（`'x-forwarded-for'` を `'x-real-ip'` にするだけ）:** `e2e/FR-ACCOUNT-035-return-request.spec.ts:105`、`e2e/return-request-test-utils.ts:63`、`e2e/order-status-test-utils.ts:354,367`、`e2e/delivery-tracking-test-utils.ts:1478`。**替えない**: `e2e/FR-ACCOUNT-036-return-request-photos.spec.ts:50`（置き場への送信に XFF が付かないことの表明）。

- [ ] **Step 1: 書き換える。** `ip` の作り方（IPv6 の `2001:db8:…`）は変えない（`isIP` が通る）。
- [ ] **Step 2: 確かめ（書くだけ）。** `grep -rn "'x-forwarded-for'" e2e` が P5 の 3 か所・P8 の例外①・`FR-ACCOUNT-036:50` だけになる。例外②（`FR-LOGIN-035:236` と `FR-NEWS-SEC-003` の専用の送り方）は**わざと書き換えない**（書き換えると AC-01 が 429 にならない）。

---

## Task 13: 最終確認と controller への報告

**範囲:** 読むことと、流してよい検査だけ。コードは変えない。

- [ ] **Step 1: 木の確認。** `npx tsc --noEmit`。流してよい `jest` の対象指定（各タスクの Step の和集合 + `npx jest tests/unit/middleware tests/unit/lib tests/unit/scripts/e2e tests/unit/components`）。`npm run validate-docs`（既知の 2 件のリンク切れは `2026-10-07-checkout-place-order-payment.md`。それ以外が増えていないこと）。`npm run validate-trace`（増えた違反が 0）。
- [ ] **Step 1b: 範囲内の領域に求められる確かめ（controller が最後に流す。実装者は流さない）。** ①`npm run trace:report`（`docs/05_Quality/reports/` を作り直す）、②`npm run test:trace-coverage`（`scripts/trace/baseline.json`・`test-gaps.md` から増やさない。`--update-baseline` はしない）、③`npm run validate-trace`、④`npm run validate-docs`。③④は①②の後でもう一度。この波は AUTH・ADMIN・STOCKIST・LOOK・NEWS・SEARCH の 6 領域に及ぶ。
- [ ] **Step 2: 印の棚卸し。** `grep -rnE "test\.fail" e2e | grep -E "SEC-(AUTH-013|SEARCH-(006|020)|NEWS-011|LOOK-(011|019|020)|ADMIN-(009|022)|STOCKIST-(012|019|020|021))|FR-ADMIN-009"` が 0 件。各タスクの外した行の合計 16（`FR-LOGIN-035:228`・`FR-SEARCH-022:281,300`・`FR-NEWS-SEC-003:213`・`FR-ADMIN-MISC-003:248`・`FR-ADMIN-MISC-005:390`・`FR-ADMIN-MISC-007:411`・`FR-STOCKIST-013:319,331`・`FR-STOCKIST-014:520,550`・`FR-STOCKIST-015:280`・`FR-LOOK-SEC-004:429`・`FR-ADMIN-MISC-006:244,264`・`FR-LOOK-SEC-003:235`）と数が合うこと。`FR-ADMIN-MISC-005:219`・`FR-LOOK-SEC-004:299`・`FR-LOGIN-032:402,488` は**残る**。
- [ ] **Step 3: 共有文書の変更案をまとめる。** `api-spec.md`・`route-inventory.md`（`GET /api/admin/stockists/access`。155 ファイル・197 メソッド）、`tests/unit/docs/*-traceability.test.ts` の数、`screen-list.md`・`screen-flow.md`・`16_admin.md`（CONTACT タブ、LOOK の「新規作成」の場所、取扱店の作成の頁の入口）、`test-spec.md`（足した・書き換えた試験、書き換えた現状固定、**Task 1b で ITEM の 4 部品（`RelatedItems.tsx`・`PublicItemGrid.tsx`・`usePublicItems.ts`・`ItemDetailClient.tsx`）に足した単体試験**。ITEM は範囲外なので手で足す）、作業と指摘の台帳（W-08・波 4 の状態、解決した指摘 ID の一覧）、`requirements.md`（AC の文が変わる物があれば）。
- [ ] **Step 4: 報告。** 下の「controller が最後に流す E2E」「本番の前の確認」「ruling」「回す物」を、結果と共に返す。

### controller が最後に流す E2E（本番ビルド。3000 番の残りを止めてから。`db reset` してから。Task 12 を済ませてから）

`E2E_FIXED_ENV` が変わるので、古い 3000 番のアプリは使い回されない（Task 3）。

```bash
npx playwright test e2e/FR-LOGIN e2e/FR-PWRESET e2e/FR-SIGNUP e2e/FR-SEARCH e2e/FR-NEWS-SEC-003 e2e/FR-NEWS-SEC-005 e2e/FR-WISHLIST-011 e2e/FR-STOCKIST e2e/FR-ADMIN-MISC e2e/FR-ADMIN-029 e2e/FR-ADMIN-123 e2e/FR-LOOK-SEC-001 e2e/FR-LOOK-SEC-002 e2e/FR-LOOK-SEC-003 e2e/FR-LOOK-SEC-004 e2e/FR-LOOK-SEC-005 e2e/FR-LOOK-DETAIL-019 e2e/FR-LOOK-ADMIN-001 e2e/FR-ACCOUNT-035 e2e/FR-ACCOUNT-036 e2e/FR-CHECKOUT-005 e2e/FR-CHECKOUT-025 e2e/FR-CHECKOUT-046 e2e/FR-HOME-022
```

その後、全件を流して `.superpowers/sdd/2026-10-25-security-gap-fixes/e2e-results-wave3-full.json`（波 3 の全件: 183 failed）と比べる（`flattenPlaywrightJson` で直して渡す）。**新しい赤**の原因の見立て: ①429（`x-real-ip` の書き換え忘れ。Review Focus 2。**見出しの無い要求の枠がまとまった**ことも含む: 今の鍵は `next start` が XFF に付ける接続元（`::1`・`::ffff:127.0.0.1` など）で、ブラウザと API の接続の族が違えば 2 つだった枠が、新しい形では `ip null` の 1 つになる）、②503（`ip` に文字列が入った）、③`networkidle` が止まる（`no-store` の 429／503 の本文を読まない呼び手。Review Focus 3）、④CONTACT タブでメニューの並びを見る試験（P14）、⑤監査の `ip` が空（`x-real-ip` を付けていない E2E）。

### 本番の前の確認（コードでは確かめられない）

1. Vercel の最初の preview で、偽の `x-real-ip` と偽の `x-forwarded-for` を付けた要求を送り、Vercel が上書きして `x-vercel-forwarded-for`・`x-real-ip` に本物の IP が入ることを実測する（公式は「`x-real-ip` は XFF と同一」とだけ書く）。入らなければ `getClientIp` は `x-vercel-forwarded-for` だけにする。
2. 前段に Cloudflare 等の中継を置かないことを確かめる（置くなら `TRUSTED_PROXY_HOPS` の設計を先に作る）。
3. Supabase Auth（GoTrue）の IP の枠: アプリのサーバーから呼ぶ時に利用者の IP を渡していないので、サインイン・OTP・更新の枠（公式の既定は 30 回／5 分／IP など）は店の全員で分け合う見込み。本番の枠の値・送り元を渡す方法・枠を上げる手順を確かめる（R17）。
4. `audit_logs.ip` に IP が入る（個人情報にあたりうる）。保存期間・開示は法令対応の後回しの決めに従う（`ADR-0462` の未確認事項）。

### ruling（controller への確認。実装者は広げず、理由を書いて進める）

1. **回数の鍵は `'unknown'` でなく `null`**（P2）。`rate_limit_counters.ip` が `inet` で文字列が入らない。`null` は「分からない全員が 1 つの枠」で設計の意図どおり。決定文の字面（`'unknown'`）と食い違うので確認を求める。
2. **`CLIENT_IP_HEADER` は旗として扱う**（値を見ない。決定文のとおり）。「値の見出しだけを読む」へ変える案もあるが、決定文は固定の順（`x-vercel-forwarded-for` → `x-real-ip`）なので広げない。
3. **NEWS の監査にも IP を入れる**（Task 10）。確認ではなく決定済み: 決定 Q13 が『ADR-0158・NEWS の ADR-0010 の「残さない」を改める』と明記している。
4. **Turnstile の `remoteip` 3 か所を `getClientIp` に替える**（Task 2）。`AUTH.md` が SEC-AUTH-013 の直す場所に挙げ、替えないと攻撃者が自分の IP を偽って渡せる。替えない場合は台帳に載せる。
5. **`SEC-AUTH-013-AC-02` は二段で書く**（Task 4）。数えの DB の失敗は今も `enforceRateLimit` が自分で 503 にする（`rateLimit.ts:45-66`）ので、これは変わらない（`ADR-0009-rate-limit-fail-closed` の『503 で断る』と食い違わない）。外側の `catch` の 500 になるのは、静的 import にして `try/catch` を外した後に、呼び出しが投げた時（作り物が投げた時）だけ。『DB の失敗は 503（部品が返す）、呼び出しが投げたら先へ進まず 5xx』と書く。
6. **認可の拒否の監査の上限は「操作者ごと」**（P10）。設計の「全体で 10 分に N 行」だと、1 人の拒否で他人の跡が消える（記録の抑止に使える）。
7. **監査の行為者・IP を新しく足す範囲**は ADMIN の範囲（`scope.json`）・取扱店・LOOK・NEWS。ユーザー一覧・権限・店の設定・注文・会計・KPI・商品の管理の窓口（P7 の 25 ファイル）は、controller の裁定（`wave4-decisions.md:34`）で IP の読み方だけ `getClientIp` に寄せる（Task 2b・2c。保存先・変数名・使い方は変えず、新しい項目は足さない）。`revoke-user-sessions` の `auditUnauthorized`（actor 無し・全体で 20 行、ADR-0460）は触らない。
8. **jest の全体の環境に `CLIENT_IP_HEADER=x-real-ip` を入れる**（`tests/setupClientIp.js`）。各試験が `x-real-ip` を送るだけで済む。各試験で環境を差し替える案もあるが、36 ファイルに同じ前処理が入る。
9. **`!ok` で本文を読まない呼び手に読み切る 1 行を足す**（Task 1b。ITEM・SEARCH の部品を含む）。波 3 の 17 件の赤の再来を避ける。足さない場合は最後の E2E の結果で決める。
10. **取扱店の編集の頁は触らない**（Q20 は作成の頁）。`admin.stockists.read` だけの人に編集のフォームが出る穴は残る（書き込みは窓口が 403）。直すなら編集の頁も `access` を呼ぶ。
11. **`FR-WISHLIST-011` は G/H に入れない**（Task 6 で書き換える）。決定の G/H の一覧はカートまで。
12. **G/H の E2E（Task 12）は、一覧を先に G-1 に送ってから**（決定 `:30`）。`scripts/e2e/**`（Task 3）も同じ。最後の E2E の前に済ませる。`src/app/admin/page.tsx`（Task 0）は G-1 が『CONTACT タブを先にコミットすれば合わせる』と答え済みなので了承を取り直さない。checkout・cart の窓口（Task 2c）は触る前に G-1 へ知らせる（決定 `:29`）。
13. **`ADR-0462` は ADMIN の帯**に置き、`ADR-0010`（NEWS の帯）・`ADR-0158`（LOOK の帯）の状態だけを更新する。

## 回す物（この波で直さない。理由つき）

- **`contact/route.ts:173` の `submitted_ip`（DB に保存）の保存期間・開示**。読み方は Task 2b で `getClientIp` に寄せる（取れなければ null。列は null 可）が、個人情報としての扱いは法令対応の後回し。
- **`rateLimit.ts` を通らず手で 429／503 を作る所**: `auth/confirm/route.ts:74`、`auth/otp/verify/route.ts:64`、`checkout/create-session/route.ts:464`、`checkout-route-guard.ts:124`、`checkout-error.service.ts:75,84`、`look/services/admin-rate-limit.ts:29`（画像の量の 429／503）。`no-store` の有無は別の確かめ。
- **残りの動的 import**（P1 の 12 ファイル）。握りつぶさないので害は無い。
- **`TRUSTED_PROXY_HOPS`**: 前段の中継を置く時の設計。今は作らない（決定 Q4）。
- **GoTrue の IP の枠**（R17。本番の確認）。
- **`revoke-user-sessions` の拒否の監査を `auditAuthzDenial` に寄せる**（actor が分かる拒否を残す）。ADR-0460 の見直し。
- **取扱店の編集の頁の入口**（ruling 10）。
- **`FR-LOOK-SEC-004:299`（画像の量）・`FR-ADMIN-MISC-005:219`（DB の aal2）**: 波 4 の範囲外。
