# 波 1-B 局所の守りの直し（AUTH・ADMIN・STOCKIST・NEWS・HOME）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 守りの穴の設計（`design-final.md`）のうち、各窓口（Route Handler）の中だけで閉じる 22 項目を直す。(1) 確認のメールのリンクは `type=signup` だけを受け、登録を始めたブラウザ（控えの Cookie が合う時）でだけ session を作る（SEC-AUTH-006・007）。(2) MFA の窓口に利用者単位の回数制限と監査を足し、初めての TOTP の登録を「メール OTP などの 2 段目を通った通行証」に限る（SEC-AUTH-009・031）。(3) 認証の応答の本文からトークンと利用者の記録を外す（SEC-AUTH-022 の本文）。(4) 登録の窓口から管理の鍵の枝を消し、宛先単位の回数制限を足す（SEC-AUTH-017・016-AC-03）。(5) 管理の書き込み 10 窓口に管理者単位の回数制限、MFA リセットの後の session 失効、強制失効の自分自身・存在しない利用者の拒否、監査の個人情報の除去、偽の成功（対象が無いのに 200）の是正、問い合わせの詳細から送信元 IP の除去と読み出しの記録（SEC-ADMIN-006〜008・012〜015・018・020・021・023）。(6) 取扱店・ニュース・ホームの局所の穴（SEC-STOCKIST-009・011・013・014・018・002、SEC-NEWS-005・016、SEC-HOME-013）。

**Architecture:** 窓口ごとの局所の直しだけで進める。共有部品（`rateLimit.ts`・`admin-rbac.ts`・`proxy.ts`・`next.config.ts`・`authenticate.ts`・`has_permission`・`src/app/admin/page.tsx`・`audit.ts`・`mail.ts`）は触らず、既存の関数を呼ぶだけにする。新しく足す物は小さな部品の追加だけ: `src/lib/auth/amr.ts`（`hasSecondFactorAmr`。純粋な関数）、`src/lib/auth/revoke-user-sessions.ts`（`revokeAllSessionsForUser`）、`src/features/stockist/schemas.ts`（取扱店の入力の形）。SEC-AUTH-007 は波 1-A の控え（`private.auth_return_intents`・`sb-return-intent` Cookie）に乗せ、**DB の変更なし**で「番号 + 登録したメール」を一緒にハッシュして結び付ける（下の P1）。窓口の数は増やさない。DB の変更が要る項目は「回す物」に載せる。

**Tech Stack:** Next.js `^16`（App Router・Route Handler）、React `^19`、TypeScript、Supabase（`@supabase/ssr`・`service_role`）、Zod、Jest（単体・結合）、React Testing Library、Playwright（書くだけ）。依存は増やさない。

**Spec:** [`.superpowers/sdd/2026-10-25-security-gap-fixes/wave1b-decisions.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/wave1b-decisions.md)（ユーザー承認 2026-10-26「波1を全部（推奨）」）。背景: 同ディレクトリの [`design-final.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md) の R2・R7・R11〜R15 と §5 の Q14〜Q16、領域別の [`AUTH.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/AUTH.md)・[`ADMIN.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/ADMIN.md)・[`STOCKIST.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/STOCKIST.md)・[`NEWS.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/NEWS.md)・[`HOME.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/HOME.md)。波 1-A の計画: [`2026-10-25-wave1a-login-return-to.md`](./2026-10-25-wave1a-login-return-to.md)（コミット `ee800974`）。

---

## 概要

| 項目 | 内容 |
| --- | --- |
| 作成日 | 2026-10-26。コード・DB・テストは 1 行も変えていない（この計画の作成だけ） |
| 直す項目 | AUTH 8（006・007・009・016-AC-03・017・022 本文・031 局所版、030 の成功の監査の一部）、ADMIN 14（006・007・008・012・013・014・015・018・020・021・023、色見本の入力）、STOCKIST 6（002・009・011・013・014・018）、NEWS 2（005・016）、HOME 1（013） |
| タスク | 9 つ（AUTH 3・ADMIN 3・STOCKIST 1・NEWS と HOME 1・最終確認 1） |
| 新しい ADR | `ADR-0413`（確認リンクの結び付けは番号 + メールのハッシュ）、`ADR-0460`（認可失敗の監査は全体で 10 分に 20 行まで）、`ADR-0461`（MFA リセットの理由は長さとハッシュだけを監査に残す） |
| 新しいコード | `src/lib/auth/amr.ts`、`src/lib/auth/revoke-user-sessions.ts`、`src/features/stockist/schemas.ts`、`return-intent-store.ts`・`return-intent-service.ts` の関数追加（`IMPL-AUTH-220`・`221`）。窓口は増やさない |
| 外す `test.fail` | 38 行（各タスクの「E2E の印」に行ごとに書く）。外さない物（別の波・ENV）も各タスクに書く |
| 触らない共有文書 | `requirements.md`・`test-spec.md`・作業と指摘の台帳・`api-spec.md`・`route-inventory.md`・`tests/unit/docs/*-traceability.test.ts`・`db-migrations.md`。必要な変更は Task 9 の報告に書く |
| 流さないもの | E2E・サーバー・3000 番・DB 結合試験・`db reset`・全体の `jest`・`trace:report`・`validate-trace --update-baseline`。DB 結合試験と E2E は書くだけ |

## 前提の読み（決定文の解釈。controller の確認を求める点を含む）

実装者はこの節を変えない。食い違いに気付いたら止めて報告する。

| # | 読み | 根拠・影響 |
| --- | --- | --- |
| P1 | SEC-AUTH-007 の「控えの Cookie が DB の行と合う」を、**Cookie の番号が signup の未使用の行に当たり、かつ確認した利用者のメールがその行を作った時のメールと同じ**と読む。実装は DB の変更なしで、signup の控えの `token_hash` を `sha256(番号 + "\n" + 小文字のメール)` にする（login の控えは今のまま `sha256(番号)`）。確認の窓口は `verifyOtp` の結果の `data.user.email` で同じ式を作って使い切る | 番号だけが当たる形だと、**被害者が自分の登録の途中（Cookie が有効）に、攻撃者の確認リンクを同じブラウザで開く**と、被害者の Cookie が被害者の行に当たってしまい、攻撃者のアカウントでログインさせられる（login CSRF が残る）。メールを式に混ぜれば、別メールの印では必ず外れる。`create_auth_return_intent`・`consume_auth_return_intent` の引数は変わらず（`token_hash` は 64 桁の 16 進のまま）、移行は要らない。**決定文の「合う」を狭く読む点を controller が確かめる** |
| P2 | 確認の窓口は signup の時、**session を作る前に控えを使い切る**（波 1-A の「保存の後に使い切る」を逆にする）。使い切って保存が失敗した時は戻り先が焼けるが、固定の行き先 `/` へ送る今の挙動のままで、被害は戻り先を失うだけ | 結び付けの成否は session を作る前に決めるしかない。DB の読み取りだけの確認関数を足すと移行が要るため採らない |
| P3 | 結び付けに合わない時は Cookie を**消さない** | 攻撃者のリンクを開かせるだけで、被害者が進行中の登録の控えを失わせたくない |
| P4 | 登録の控えは**戻り先が無い・不正でも必ず作る**（`return_path` は `/`）。`issueReturnIntent` に `alwaysCreate` と `bindTo` を足す | 決定文どおり。新規・登録済み・重複の例外の 3 つの 202 は、Set-Cookie の形（名前・属性・Max-Age）まで同じにする（SEC-AUTH-016） |
| P5 | `/login?registered=1` の案内の文は「会員登録が完了しました。ログインしてください。」（文は案。**ユーザーに画面を見せて確かめる**） | 決定文。確かめるまで `ADR-0413` と画面の文は「案」と書く |
| P6 | 控えの Cookie の名前は login と signup で共有（`sb-return-intent`）なので、登録の後に別のログインを始めると Cookie が上書きされ、同じブラウザで確認リンクを開いても `/login?registered=1` になる | 安全な側への劣化（ログインは手でできる）。波 1-A の設計のまま変えない |
| P7 | SEC-AUTH-031 の局所版は `hasSecondFactorAmr`（`amr` の中に `otp`・`magiclink`・`totp`・`oauth`・`sso/saml`・`email/signup` が 1 つでもあれば真）を `enroll-totp` にだけ当てる。`magiclink` を入れるのは、確認済みの利用者の `verifyOtp({ type: 'email' })`（`otp/verify` のログイン）を GoTrue が `otp` と `magiclink` のどちらで記録するかが未実測で、外すと管理者が最初の TOTP を全く登録できなくなる恐れがあるため（どちらも受け箱を持つことの証明で、守りの強さは同じ。退ける相手は `password` だけで得た通行証）。**ログイン後の本物の通行証の `amr` の値、更新の後も残ることは未実測**（`design-final.md` §7-2）。実測は controller が E2E で行い、外れた時は Task 1 の `enroll-totp` の変更だけを戻す | 手元で本物の通行証をデコードできない（サーバーを起動しない約束）。「OTP だけを GoTrue へ直接送る」道は閉じない（Q30(a) の自前 session への結び付けは波 5）。方法の一覧は Supabase の JWT Claims Reference（`amr.method`）の値に合わせた（2026-10-26 にレビューで確認） |
| P8 | SEC-ADMIN-007 の「全体で 10 分に 20 行」は `incrementCounter`（`@/features/auth/ratelimit`）を `subject: 'all'` で呼ぶ。呼ぶだけで共有部品は変えない | `design-final.md` Q14 D3 |
| P9 | SEC-ADMIN-014 AC-02 は、要素を全部消した後に `revokeAllSessionsForUser` を呼ぶ。失効に失敗したら 500 と固定の文の監査。要素は既に消えているので、**再実行すると要素 0 件で失効だけをやり直せる**（冪等） | 順序は `ADMIN.md` §SEC-ADMIN-014 のとおり |
| P10 | SEC-ADMIN-021 の 404 は、更新・削除の結果が 0 行の時。形の悪い id（UUID でない・数字でない）は DB に渡さず 404。404 の時は `outcome: 'failure'` の監査を固定の文で 1 行書く（`success` は書かない）。色見本は今も監査が無いので書かない（SEC-ADMIN-022 は波 4） | e2e `FR-ADMIN-MISC-006:652` は success の行が増えないことだけを見る |
| P11 | SEC-STOCKIST-002（公開の取り出しを `createPublicClient()` に替える）を、同じファイルの SEC-STOCKIST-018 と一緒に直す | `design-final.md` R13 の「同じファイルで一緒に」。単独で外したい時は Task 7 の Step 7 だけを外す |
| P12 | 取扱店の削除の監査に残す削除前の中身は `id`・`name`・`address`・`status` | 要件は名前と住所。電話・営業時間は残さない |
| P13 | `ADMIN_API_KEY` は `src` から読む所が無くなる。`scripts/e2e/environment.ts` の `E2E_FIXED_ENV` から外し、本番の環境変数の削除は運用（controller の報告に書く） | `design-final.md` R15。`tests/unit/scripts/e2e/environment.test.ts` が値を固定していないかは Task 2 で確かめる |
| P14 | SEC-NEWS-005 を直すと `FR-NEWS-SEC-001` の SEC-NEWS-007-AC-01・007-AC-02・008-AC-01 の 3 本が自動で通る（応答から `image_url` が消えるため）。この 3 本の `test.fail` も同じタスクで外す。検索と管理の署名の確かめ（SEC-NEWS-007・008 の本体）は波 1-C | `NEWS.md` 横断の注意 3 |
| P15 | ホームの ITEM の取得を 10 → 8 件にし、`FREQ-147-REQ-01` の「10 件取る」を 8 件に直す（`areas/home.md`）。`FREQ-147-REQ-02` の「xl 以上は 10 件」は FREQ-276 で置き換え済みの古い記述なので、**直さず食い違いとして報告する** | CLAUDE.md「食い違いは推測で決めず報告」。Q25 は 8 件を推奨 |

## Global Constraints

- 並行作業: 別セッション（G-3 発送）が同じ作業ツリーの別ファイルを編集し、コミットの時に全体の `tsc` を通す。**`git add`・`git commit`・`git stash`・`git checkout`・`git reset`・`git restore` は実行しない**（controller がタスクごとにコミットする）。コミットは作らない。
- **E2E・サーバー・3000 番・DB 結合試験・`db reset`・`supabase` の起動・全体の `jest`・`npm run test:trace-coverage`・`npm run trace:report`・`validate-trace --update-baseline` は実行しない**。流してよい `jest` は `npx jest <ファイル>` の対象指定だけ。DB 結合試験と E2E は書くだけ。
- `.ts` / `.tsx` を 1 つ編集するたびに `npx tsc --noEmit` を流し、自分の誤りをその場で直す。他者（G-3）の誤りが出たら触らず、報告に書く。
- 着手前に `git status --short` を見て、G-3 が変更中のファイルを確かめ、**重ならないようにする**。この計画のファイルは G-3 と別（`src/lib/orders/**`・`src/app/api/admin/shipment-slips/**`・`src/app/admin/page.tsx` ほかは触らない）。
- 触らない: `src/proxy.ts`、`next.config.ts`、`src/features/auth/middleware/rateLimit.ts`・`src/features/auth/ratelimit/index.ts`（呼ぶだけ）、`src/lib/auth/authenticate.ts`・`admin-rbac.ts`（呼ぶだけ）、`src/lib/audit.ts`、`src/lib/mail.ts`、`src/app/admin/page.tsx`、`supabase/migrations/**`（新しい移行を作らない。既存も触らない）、`tests/integration/db/helpers/group-g-allowlist.ts`。
- 共有文書は**編集しない**: `docs/02_Requirements/requirements.md`、`docs/05_Quality/tests/test-spec.md`、`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`、`docs/03_BasicDesign/api/api-spec.md`、`docs/03_BasicDesign/api/route-inventory.md`、`tests/unit/docs/*-traceability.test.ts`、`docs/06_Operations/db-migrations.md`。必要な変更は各タスクの報告に「共有文書の変更案」として書く。
- 文書: 日本語。`documentation-guide`（`.claude/skills/documentation-guide/SKILL.md`）の項目の形（見出し直後の属性表）・ID の体系・TSDoc（`@packageDocumentation`・`@impl`・`@design`・`@remarks` に「なぜ」だけ）・テスト名の先頭に ID を守る。文書の冒頭の確認日は 2026-10-26。絵文字は使わない。要件は `docs/02_Requirements/areas/<area>.md`（`requirements.md` には書かない）。「今のコードは満たさない」は**直した項目だけ**外し、直していない部分（別の波）は残す。
- 共有の `src/lib/auth/*` の新ファイル（`amr.ts`・`revoke-user-sessions.ts`）には `@impl` を付けない（共有部品にはコメントを入れない決まり）。つなぎ先は設計の文書の上位に `（範囲外）` 付きで書く。`tests/unit/lib/auth/revoke-user-sessions.test.ts` は ADMIN の範囲に入る名前なので、テスト名は `DD-ADMIN-003` で始める。`tests/unit/lib/auth/amr.test.ts` は範囲外だが、同じ形で `DD-AUTH-030` を先頭に付ける。
- 番号は**書く直前に再確認**する: `grep -rhoE "IMPL-AUTH-[0-9]+" src | sort -u | tail -3`（今は 219 が最大）、`IMPL-STOCKIST-`（148）、`ls docs/03_BasicDesign/decisions | grep -E "ADR-04(1|6)"`（`ADR-0412`・`0459` が最大）。違えば割当表をずらして一貫させる。
- 入力は信用しない: 回数制限の `subject` に使うのは**検証済みの値だけ**（`claims.sub`・`authz.userId`・登録のスキーマを通したメール）。入力の生の値を使うと他人の枠を潰せる。ログ・監査に、メール・理由の文・トークン・番号・Supabase の誤りの文を残さない。残してよいのは固定の符号と長さ・ハッシュだけ。
- 実装は最小。決定にない設定項目・追加の API・画面は作らない。作業ツリーに CRLF のファイルがある（`src/app/auth/verified/page.tsx` ほか）。そのファイルは行末を保つ。編集は Edit で行い、`sed -i` は使わない（`\` が落ちて CRLF を壊す）。`graphify update` は自分で流さない（コミットのフックが後ろで作り直す）。
- 窓口（Route Handler）のファイルを増やさない。増やす必要が出たら止めて報告する。

### ID の割当

| 種類 | ID | 題 | タスク |
| --- | --- | --- | --- |
| ADR | `ADR-0413` | 確認リンクの結び付けは、控えの番号と登録したメールを一緒にハッシュする | 3 |
| ADR | `ADR-0460` | 認可に失敗した要求の監査は、全体で 10 分に 20 行までとし、超えたらまとめの 1 行にする | 4 |
| ADR | `ADR-0461` | MFA リセットの理由の文は監査に残さず、長さとハッシュだけを残す | 4 |
| 実装 | `IMPL-AUTH-220` | `consumeSignupBinding`（`return-intent-service.ts`、`@design DD-AUTH-034`） | 3 |
| 実装 | `IMPL-AUTH-221` | `resolveStoredDestination`（`return-intent-service.ts`、`@design DD-AUTH-034`） | 3 |
| 実装 | `IMPL-STOCKIST-149` | `toInvalidStockistResponse`（`src/features/stockist/schemas.ts`、`@design DD-STOCKIST-034`） | 7 |
| 受け入れ条件 | `SEC-AUTH-007-AC-02` | 戻り先つきの登録でも、登録を始めていないブラウザで開くと戻り先を使わず `/login` へ送る | 3 |
| 受け入れ条件 | `SEC-AUTH-007-AC-03` | 登録を始めたブラウザでも、別のメールの印では session を作らない | 3 |

---

## Review Focus（最も踏みやすい失敗 5 つ）

レビュアーと実装者は、各タスクの前後でこの 5 つを具体的な入力で確かめる。

1. **SEC-AUTH-007 の結び付けの穴と、登録の応答の同一性。** (a) 被害者が自分の登録の途中（有効な `sb-return-intent`）で、**攻撃者のメールの signup の印**を同じブラウザで開く → session を作ってはならない（番号 + メールのハッシュが外れる）。結合試験で「Cookie の番号は合うがメールが違う」を必ず入れる。(b) 結び付けに合わない時に Cookie を消さない（P3）。消すと攻撃者が被害者の登録の控えを壊せる。(c) 合わない時は `verifyOtp` の結果の session を Cookie に書かず、`persistSessionAndCookies`・`linkGuestOrdersByEmail` を呼ばない。(d) `type=signup` 以外（`email`・`magiclink`・`recovery`・不明）は **`verifyOtp` を呼ばない**（印が消費されない。`FR-SIGNUP-003` の `expectTokenVerifiable` が見る）。(e) 登録の 202 は新規・登録済み・重複の例外・（Confirm email OFF の 201 は例外として控えを消す）で Set-Cookie の名前・属性・Max-Age が同じ。控えの作成に失敗しても応答の形を変えない。(f) 回数制限の位置（Turnstile と漏洩の確かめの後・控えの作成と既存会員の照会の前）。照会の後に置くと 429 の有無で存在が分かる。
2. **回数制限の枠と既存の E2E の衝突。** `subject` は検証済みの値（`claims.sub`・`authz.userId`・正規化したメール）だけ。入力の `user_id` を使うと他人の枠を潰せる。順番は「認可 → 回数 → 本文」（認可で断った要求は数えない）。`enforceRateLimit` の 503（fail-closed）を握りつぶさない。**数は案を守る**（ユーザー作成 20・強制失効 20・MFA リセット 10・返信 30・ほかの問い合わせ 60・色見本 60 / 10 分、TOTP 5 回 / 600 秒、会員登録 5 回 / 時）。`sharedAdmin()` を使う `FR-ADMIN-MISC-001・002・003・005` が 10 分以内に続けて流れても枠を超えないか、各ファイルで認可後に通る呼び出しを数えて報告に書く（超えるなら試験ごとの管理者に替える）。会員登録の枠は E2E が同じメールで何度も登録する所を壊さないか確かめる。
3. **`test.fail` の外し方の取り違え。** 外す印は「このタスクのコードだけで通る」物に限る。別の波・ENV で赤のままの物を外すと「予想外の成功」ではなく**赤のまま（印を外したので本当の失敗）**になる。逆に外し忘れると直った試験が「予想外の成功」で赤になる。各タスクに「外す」「外さない（理由）」を行番号つきで書いた。行番号は 2026-10-26 時点で、先に `grep -n "test.fail" <ファイル>` で確かめる。`SEC-AUTH-022-AC-02`（no-store は `proxy.ts`・波 3）、`SEC-AUTH-030-AC-01`・`SEC-AUTH-029`・`FREQ-316-REQ-02`（ENV）、`SEC-ADMIN-009-AC-01`・`SEC-ADMIN-022-AC-0x`（IP は波 4）は**外さない**。
4. **偽の成功の是正（0 行 → 404）が、RLS・モック・id の形で外れる。** `.update(...).select('id')` が 0 行を返すのは「無い」と「RLS が隠した」の両方。取扱店とニュースは利用者の session の client なので、aal2 でない時は 404 になりうる（403 でなく）。id の形（UUID・正の整数・bigint の桁）は DB に渡す前に確かめる（22P02 が 500 になる）。単体・結合試験のモックの連鎖に `.select` が無くて落ちる（モックを実物の形に直す）。削除の監査の `metadata` に消した中身を残す時、`maskAuditEvent` の鍵の伏せ字（`/number/`・`/pan/` など）に `name`・`address` が当たらないか確かめる。画面（`StockistSection`・`ContactSection`）が 404 を想定した表示を持つか確かめる。
5. **監査の衛生と部分失敗の順序。** MFA リセットの `logAudit` は**全部の分岐**（検証の失敗・対象なし・特権でない・要素の一覧の失敗・削除の失敗・成功）から `reason`・`target_email`・`error_message`・`delete_errors[].message` を外す（1 つでも残すと `FR-ADMIN-MISC-003` の AC-01 が通らない）。誤りの文は `console.error` へ。作成の失敗は固定の文（`email_already_registered`・`create_user_failed`）。認可失敗の監査は上限つき（カウンターが失敗したら書かない = fail-open）で、**監査の補助が窓口の応答を変えない**。失効は「要素を消す → session を失効」の順で、失効が失敗しても要素は戻らない（P9）。読み出しの監査（SEC-ADMIN-023）に名前・メール・本文・検索語を入れない（`q_length` だけ）。`logAudit` の失敗で読み出しを止めない。

---

## ファイルの全体像

| 区分 | ファイル | 操作 | タスク |
| --- | --- | --- | --- |
| route | `src/app/api/auth/mfa/enroll-totp/route.ts`・`mfa/verify/route.ts`・`refresh/route.ts`・`otp/verify/route.ts` | 変更 | 1 |
| 共有（新規・小） | `src/lib/auth/amr.ts` | 新規 | 1 |
| route | `src/app/api/auth/register/route.ts`・`confirm/route.ts` | 変更 | 2、3（重なる。下の注） |
| E2E 環境 | `scripts/e2e/environment.ts`（`ADMIN_API_KEY` を外す） | 変更 | 2 |
| 部品 | `src/features/auth/return-intent/return-intent-store.ts`・`return-intent-service.ts` | 変更 | 3 |
| 画面 | `src/app/login/page.tsx`・`src/components/AuthTabs.tsx` | 変更 | 3 |
| route | `src/app/api/admin/revoke-user-sessions/route.ts`・`users/mfa/reset/route.ts` | 変更 | 4 |
| 共有（新規・小） | `src/lib/auth/revoke-user-sessions.ts` | 新規 | 4 |
| route | `src/app/api/admin/create-user/route.ts`・`item-color-presets/route.ts`・`item-color-presets/[id]/route.ts` | 変更 | 5 |
| route | `src/app/api/admin/contact/route.ts`・`contact/[id]/route.ts`・`contact/[id]/reply/route.ts`・`contact/templates/route.ts`・`contact/templates/[id]/route.ts`・`audit-logs/route.ts` | 変更 | 6 |
| route・部品 | `src/app/api/admin/stockists/route.ts`・`[id]/route.ts`、`src/features/stockist/schemas.ts`（新規）、`src/features/stockist/services/public.ts` | 変更・新規 | 7 |
| サービス・型・頁 | `src/features/news/services/public.ts`、`src/features/news/types.ts`、`src/app/api/admin/news/[id]/route.ts`、`src/app/page.tsx` | 変更 | 8 |
| 文書 | `docs/02_Requirements/areas/{auth,admin,stockist,news,home}.md`、`docs/05_Quality/security/threats/{auth,admin,stockist,news,home}.md`、`docs/03_BasicDesign/areas/{auth,admin,stockist,news,home}.md`、`docs/03_BasicDesign/decisions/ADR-0413・0460・0461`（新規）、`docs/04_DetailDesign/pages/{14_login,16-2_admin_misc,16-4_admin_stockist,10_stockist,16-1_admin_news,02_news_list,01_home}.md`、`docs/04_DetailDesign/sequence/auth-{registration,login-mfa}.md` | 追記・更新 | 全部 |
| E2E | `e2e/FR-LOGIN-030・032`、`FR-SIGNUP-002・003`、`FR-ADMIN-MISC-002・003・004・006・007`、`FR-STOCKIST-015・017`、`FR-NEWS-SEC-001・005`、`FR-HOME-023` | `test.fail` の印の削除・期待の更新・新しい `test` の追加（書くだけ） | 1〜8 |

**ファイルの重なりと進める順（レビューで直した）。** 次の 3 本の列は、列の中を**直列**で進める。列どうしは src・test・e2e・文書のファイルが重ならないので並行にしてよい。

| 列 | 順 | 重なるファイル（だから直列） |
| --- | --- | --- |
| AUTH | Task 1 → Task 2 → Task 3 | `tests/integration/auth-flow.test.ts`（register・otp/verify・refresh を 1 つで見る。Task 1 と 2）、`tests/integration/api/auth-bot-rate-limit.test.ts`（register・mfa/verify の枠。Task 1 は流すだけ・Task 2 が直す）、`src/app/api/auth/register/route.ts`・`confirm/route.ts`・`e2e/FR-SIGNUP-003-signup-confirm-link.spec.ts` とその単体・結合試験（Task 2 と 3）、`docs/*/areas/auth.md`・`14_login.md`・`sequence/auth-registration.md`（全部） |
| ADMIN | Task 4 → Task 5 → Task 6 | `tests/integration/api/admin-misc/admin-audit-write.test.ts`・`admin-authorization-path.test.ts`・`admin-origin-guard.test.ts`（10 窓口を 1 ファイルで見る。回数制限のモックを最初に足したタスクの形を後のタスクが使う）、`e2e/FR-ADMIN-MISC-006`（Task 5 の色見本と Task 6）、`docs/*/areas/admin.md`・`16-2_admin_misc.md`（全部） |
| 公開 | Task 7 → Task 8 | `tests/integration/api/home-page-public-read.test.ts`（取扱店の公開の client は Task 7、ニュースの署名の無し・商品 8 件は Task 8） |

SEC-AUTH-007 を単独のタスクにする（ユーザーが画面の文を確かめる・最も危ない）一方で、同じ 2 つの窓口に 006・017・016-AC-03・022 の小さい直しが入るため、Task 2 と 3 を分けたまま直列にする。文書は領域ごとのファイル（`areas/auth.md` など）に同じ列の複数のタスクが別の節を足す。

---

## Task 1: AUTH 認証の窓口（MFA の回数制限と監査、初めての TOTP の登録、本文の絞り込み）

**範囲:** SEC-AUTH-009（AC-01・AC-02）、SEC-AUTH-031（局所版: `enroll-totp` だけ）、SEC-AUTH-022 の本文（AC-01）、SEC-AUTH-030 のうち成功の監査（コードの部分）。

**Files:**

- Create: `src/lib/auth/amr.ts`、`tests/unit/lib/auth/amr.test.ts`
- Modify: `src/app/api/auth/mfa/verify/route.ts`（`IMPL-AUTH-205`・`DD-AUTH-031`）、`mfa/enroll-totp/route.ts`（`IMPL-AUTH-204`・`DD-AUTH-030`）、`refresh/route.ts`（`IMPL-AUTH-201`・`DD-AUTH-027`）、`otp/verify/route.ts`（`IMPL-AUTH-146`・`DD-AUTH-015`）
- Test: `tests/unit/api/auth/mfa-verify-route.test.ts`・`mfa-enroll-totp-route.test.ts`・`refresh-route.test.ts`・`otp-verify-route.test.ts`、`tests/integration/api/auth/mfa-verify.test.ts`・`refresh.test.ts`・`otp-verify.test.ts`、`tests/integration/api/auth-mfa-enroll-totp-api.test.ts`・`auth-admin-totp-flow.test.ts`・`auth-otp-verify-api.test.ts`・`auth-cookie-data.test.ts`（本文の形を見る所があれば直す）、`tests/integration/auth-flow.test.ts`（otp/verify・refresh の本文の期待だけを直す。register の分は Task 2）、`tests/integration/api/auth-bot-rate-limit.test.ts`（流すだけ。mfa/verify の行は 1 回目の 429 で止まるので変わらない見込み。落ちたら Task 2 に回さずこのタスクで直す）、`tests/integration/ui/auth-verified-screen.test.tsx`・`auth-verified-state.test.tsx`・`tests/unit/app/auth/verified-page.test.tsx`（enroll-totp の 403 を想定するか読むだけ）
- E2E: `e2e/FR-LOGIN-030-session-cookies-and-responses.spec.ts`、`e2e/FR-LOGIN-032-admin-totp-aal2.spec.ts`
- Docs: `docs/02_Requirements/areas/auth.md`、`docs/05_Quality/security/threats/auth.md`、`docs/03_BasicDesign/areas/auth.md`、`docs/04_DetailDesign/pages/14_login.md`

**Interfaces:**

```ts
// src/lib/auth/amr.ts（共有。@impl なし）
/** amr の中に 2 段目を通った方法が 1 つでもあれば真。password・recovery・invite・email_change・token_refresh・anonymous は数えない（P7） */
export const SECOND_FACTOR_AMR_METHODS: readonly string[]; // 'otp' 'magiclink' 'totp' 'oauth' 'sso/saml' 'email/signup'
export function hasSecondFactorAmr(claims: { amr?: unknown } | null | undefined): boolean;
// amr は { method: string; timestamp?: number }[] を新しい順に読む。要素が文字列の古い形も method とみなす。配列でない・空・未定義は false。

// mfa/verify の監査（action 'mfa_verify'）
//   account_rate_limited / factor_not_found（challenge の 404 の枝）/ challenge_failed / invalid_code は outcome 'failure'、成功は outcome 'success' detail 'verified'。actor_id は auth.claims.sub。
//   今の保存の失敗の枝の detail: String(persistError) は固定の 'session_persist_failed' に替える（誤りの文を監査に残さない。console.error は残す）。
// enroll-totp の監査（action 'mfa_enroll'）
//   第 2 段なし: outcome 'denied' detail 'second_factor_required'。登録成功: outcome 'success' detail 'totp_factor_enrolled'（resource_id は factorId）。
//   未確認の要素の取り外し: action 'mfa_factor_remove'（'enroll' の字を含めない。030-AC-01 の「enroll 1 行」を数える試験を乱さないため）outcome 'success'。
// refresh の成功本文: { ok: true }。otp/verify の成功本文: { user: { id, email, role }, message }。role はサーバーが data.user.app_metadata.role から読み、'admin' | 'supporter' 以外は 'user'。
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "test.fail" e2e/FR-LOGIN-030-*.ts e2e/FR-LOGIN-032-*.ts`。`grep -rn "access_token\|app_metadata" src --include=*.ts --include=*.tsx --exclude-dir=graphify-out | grep -v "app/api"` で、`refresh`・`otp/verify` の本文を読む端末側の所（`LoginContext.verifyOtp` は `message` だけ、`RefreshResponseSchema` は両方 optional）を再確認する。
- [ ] **Step 2（RED）: 単体試験を書く。**
  - `tests/unit/lib/auth/amr.test.ts`（先頭 `DD-AUTH-030`）: 各方法ごとに真偽を表で確かめる。真: `otp`・`magiclink`・`totp`・`oauth`・`sso/saml`・`email/signup`。偽: `password`・`recovery`・`invite`・`email_change`・`token_refresh`・`anonymous`・`unknown-method`。さらに「`[{method:'password'},{method:'otp'}]` は真」「`[{method:'token_refresh'},{method:'password'}]` は偽」「文字列の要素 `['otp']` は真」「`amr` が配列でない・空・`null`・`undefined`・`claims` が `null` は偽」。
  - `mfa-verify-route.test.ts`: (a) `enforceRateLimit` が 2 回呼ばれ、2 回目が `{ endpoint: 'auth:mfa:verify', limit: 5, windowSeconds: 600, subject: <claims.sub> }`（リクエストの本文の値ではない）。(b) 2 回目が 429 を返した時、`mfa.challenge` が呼ばれず、`logAudit` が `{ action: 'mfa_verify', actor_id: sub, outcome: 'failure', detail: 'account_rate_limited' }` で 1 回。(c) challenge が失敗（400）→ `detail: 'challenge_failed'`、challenge の「not found」（404）→ `detail: 'factor_not_found'`、verify が失敗（400）→ `detail: 'invalid_code'`（どれも `outcome: 'failure'`）。保存の失敗 → `outcome: 'error'`・`detail: 'session_persist_failed'`（throw の文を含まない）。(d) 成功 → `outcome: 'success'`、`detail: 'verified'`。(e) 監査の `detail`・`metadata` にコードの数字と Supabase の誤りの文が入らない。(f) 認証に失敗（401）した時は利用者単位の枠を呼ばない（`sub` が無い）。
  - `mfa-enroll-totp-route.test.ts`: (a) `claims.amr = [{method:'password'}]` の管理者 → 403、`mfa.enroll` が呼ばれず、`logAudit` が `{ action: 'mfa_enroll', actor_id: sub, outcome: 'denied', detail: 'second_factor_required' }`。(b) `amr = [{method:'otp'}]` → 今どおり 200 で要素ができ、`outcome: 'success'` の監査が 1 行（`resource_id` は factorId）。(c) 未確認の要素があると取り外し、`action: 'mfa_factor_remove'` が別に 1 行。(d) 役割が `user` なら今までの 403（`mfa_enroll` の監査は書かない）。(e) `forceReEnroll` で検証済みの要素がある時は今までの 403。
  - `refresh-route.test.ts`: 成功の本文が `{ ok: true }` ちょうど。`JSON.stringify(body)` に `access_token`・`refresh_token`・`app_metadata` が無い。Cookie（`sb-access-token`・`sb-refresh-token`）は今までどおり `Set-Cookie` に出る。
  - `otp-verify-route.test.ts`: 成功の本文が `{ user: { id, email, role }, message }` で `user` のキーが 3 つだけ。Supabase の利用者の記録（`app_metadata`・`user_metadata`・`identities`・`phone`・`aud` など）が無い。`app_metadata.role = 'admin'` の利用者で `role: 'admin'`、無い利用者で `'user'`、`'owner'` のような不明な値で `'user'`。
- [ ] **Step 3（GREEN）: 実装する。** `amr.ts` を作る。`mfa/verify`: IP の枠・本文の確認・`authenticateRequest` の後（役割の確認の前）に利用者単位の枠。`mfa/enroll-totp`: 役割の確認の後・`listFactors` の前に `hasSecondFactorAmr(auth.claims)`。偽なら監査して `NextResponse.json({ error: 'Forbidden' }, { status: 403 })`。`refresh`: 成功の本文を `{ ok: true }`。`otp/verify`: 成功の本文を上の形に。`tsc` を流す。
- [ ] **Step 4: 結合試験を直す。** `mfa-verify.test.ts` に枠の 6 回目（429）と監査の期待、`auth-mfa-enroll-totp-api.test.ts`・`auth-admin-totp-flow.test.ts` の通行証のモックに `amr: [{ method: 'otp', timestamp: 0 }]` を足す（足さないと 403 になる）。`refresh.test.ts`・`otp-verify.test.ts`・`auth-otp-verify-api.test.ts`・`auth-cookie-data.test.ts` は本文の期待を上の形に直す。テスト名の先頭は構造設計の ID（`API-AUTH-002`・`API-AUTH-014`・`API-AUTH-017`・`API-AUTH-018`）。
- [ ] **Step 5: 対象の `jest` を流す。** `npx jest tests/unit/lib/auth/amr.test.ts tests/unit/api/auth/mfa-verify-route.test.ts tests/unit/api/auth/mfa-enroll-totp-route.test.ts tests/unit/api/auth/refresh-route.test.ts tests/unit/api/auth/otp-verify-route.test.ts tests/integration/api/auth/mfa-verify.test.ts tests/integration/api/auth/refresh.test.ts tests/integration/api/auth/otp-verify.test.ts tests/integration/api/auth-mfa-enroll-totp-api.test.ts tests/integration/api/auth-admin-totp-flow.test.ts tests/integration/api/auth-otp-verify-api.test.ts tests/integration/api/auth-cookie-data.test.ts tests/unit/components/LoginContext.test.tsx tests/integration/auth-flow.test.ts tests/integration/api/auth-bot-rate-limit.test.ts tests/integration/ui/auth-verified-screen.test.tsx tests/integration/ui/auth-verified-state.test.tsx tests/unit/app/auth/verified-page.test.tsx`。壊れた期待を同じタスクで直す。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-LOGIN-030:210`（`SEC-AUTH-022-AC-01`。`refresh`・`otp/verify` の本文に `access_token`・`refresh_token`・`app_metadata` の字が無い）。`FR-LOGIN-032:352`（`SEC-AUTH-009-AC-01`。6 回目の確かめが `challenge` より前の 429 で、ENV に関係なく反転する）。`FR-LOGIN-032:368`（`SEC-AUTH-009-AC-02`。`challenge` の失敗の分岐にも `failure` を書くので、手元の TOTP 無効（400）でも行が増える）。`FR-LOGIN-032:419`（`SEC-AUTH-031-AC-01`。コードだけで反転する。ENV の印のまま残すと「予想外の成功」で赤になる）。
  - 外さない: `FR-LOGIN-030:236`（`SEC-AUTH-022-AC-02` の no-store は `proxy.ts` で波 3）、`FR-LOGIN-032:402`（`SEC-AUTH-030-AC-01`。成功の監査は入るが、TOTP を有効にする ENV が要る。印の文は「ENV」のまま）、`FR-LOGIN-032:488`（`FREQ-316-REQ-02-AC-01`。ENV）。
  - `FR-LOGIN-032` の `SEC-AUTH-031-AC-01` の説明コメントを実際に合わせる（印を外した理由）。`SEC-AUTH-022-AC-02` の印の文は「no-store は波 3（proxy.ts）」と一言足してよい。
- [ ] **Step 7: 文書。** `areas/auth.md`: `SEC-AUTH-009`・`SEC-AUTH-031` の本文から「今のコードは満たさない」を外し現行の動きに直す（`SEC-AUTH-031` は「`amr` に 2 段目の方法がある通行証だけが初めての TOTP を登録できる。『GoTrue へ OTP だけを直接送って得た通行証』は通る（Q30(a) は波 5）。登録の本人へのメールの通知は満たさない（Q30・波 5）」と残る穴を書く。`amr` の値が未実測であること（P7）も未確認事項に書く）。`SEC-AUTH-022` の本文は「本文の部分は満たす。no-store は満たさない（波 3）」と分けて書き、`-AC-01` の確かめ方を実際に合わせる。`SEC-AUTH-030` の本文に「成功の監査は入った。AC-01 は ENV が要る」と書く。`threats/auth.md`: `THR-AUTH-009`・`THR-AUTH-031`・`THR-AUTH-022` の起こり方・対策に現状があれば直す。`areas/auth.md`（構造設計）: `API-AUTH-002`・`API-AUTH-014`・`API-AUTH-017`・`API-AUTH-018` の応答と監査を直す。`14_login.md`: `DD-AUTH-015`・`DD-AUTH-027`・`DD-AUTH-030`・`DD-AUTH-031` の入出力・異常・認可・永続化（監査）を直す。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- AUTH`（`--update-baseline` はしない。増えた違反が無いこと）。
- [ ] **Step 9: 報告。** 変えたファイル、外した印の行番号、共有文書の変更案（`api-spec.md` の `refresh`・`otp/verify` の応答の形、`route-inventory.md` は変更なし）、`amr` の実測を controller に頼む旨（P7）を返す。コミットは作らない。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。

---

## Task 2: AUTH 登録と確認の小さい直し（SEC-AUTH-006・017・016-AC-03・022 の登録の本文）

**範囲:** SEC-AUTH-006（確認は `signup` の印だけ）、SEC-AUTH-017（登録の窓口から管理の鍵の枝を消す）、SEC-AUTH-016-AC-03（宛先単位の回数制限）、SEC-AUTH-022 の `register` の 201 の本文。**Task 3 と同じ 2 つの窓口を直す。Task 3 より先に済ませる。**

**Files:**

- Modify: `src/app/api/auth/confirm/route.ts`（`IMPL-AUTH-164`・`DD-AUTH-019`）、`src/app/api/auth/register/route.ts`（`IMPL-AUTH-163`・`DD-AUTH-018`）、`scripts/e2e/environment.ts`（`ADMIN_API_KEY` の行を外す）
- Test: `tests/unit/api/auth/confirm-route.test.ts`・`register-route.test.ts`、`tests/integration/api/auth/confirm.test.ts`・`register.test.ts`・`register-enumeration.test.ts`、`tests/integration/api/auth.test.ts`・`auth-flow.test.ts`・`auth-password-rule.test.ts`（管理の鍵を使う所）、`tests/integration/ui/auth-register-flow.test.tsx`（`ADMIN_API_KEY` を触る所）、`tests/unit/scripts/e2e/environment.test.ts`（`ADMIN_API_KEY` を固定していないかを確かめる）、`tests/integration/api/auth-bot-rate-limit.test.ts`（266 行付近の「register は Turnstile に落ちたら…メール単位の枠も持たない」は呼び出し 1 回のままで通るが、題が新しい作りと食い違うので「メール単位の枠を数えない（他人の枠を潰させない）」に直す。login と同じ形で「register は Turnstile・漏洩の確かめを通ってから、小文字のメールを subject に 5 回／3600 秒の枠を数える」を 1 本足す）
- E2E: `e2e/FR-SIGNUP-002-register-api-and-password-policy.spec.ts`、`e2e/FR-SIGNUP-003-signup-confirm-link.spec.ts`
- Docs: `docs/02_Requirements/areas/auth.md`、`docs/05_Quality/security/threats/auth.md`、`docs/03_BasicDesign/areas/auth.md`、`docs/04_DetailDesign/pages/14_login.md`、`docs/04_DetailDesign/sequence/auth-registration.md`（管理の鍵の記述 95 行・105 行付近を消す）

**Interfaces:**

```ts
// confirm: type の扱い
//   type 未指定・空 → 'signup'。'signup' 以外（email・magiclink・recovery・不明・大文字違い）→ verifyOtp を呼ばず 303 /login。
//   監査: { action: 'auth.confirm', outcome: 'failure', detail: 'invalid_type', metadata: { reason: 'invalid_type' } }（type の値そのものは残さない）。
//   検査の順は 回数制限 → token_hash の有無 → type → verifyOtp。verifyOtp は { token_hash, type: 'signup' } 固定。
//   同じファイルの監査の detail: error?.message と String(err)（Supabase・例外の文）は、固定の符号（'verify_failed'・'unexpected'。分類は今の metadata.reason のまま）に替える（Global Constraints の「誤りの文を残さない」）。
// register: 回数制限は 2 つ。
//   (1) 既存: { endpoint: 'auth:register', limit: 20, windowSeconds: 3600 }（IP）
//   (2) 新規: { endpoint: 'auth:register', limit: 5, windowSeconds: 3600, subject: email }（email は RegisterRequestSchema を通った小文字・trim 済み）。
//       位置: Turnstile と漏洩パスワードの確かめの後、控えの作成と既存会員の照会の前。
// register の 201（Confirm email OFF の時だけ通る枝）の本文: { user: { id, email } }。access_token と利用者の記録を載せない。
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -rn "x-admin-token\|ADMIN_API_KEY" src tests e2e scripts --include=*.ts --include=*.tsx --exclude-dir=graphify-out`。消す試験・直す試験の一覧を作る。`tests/unit/scripts/e2e/environment.test.ts` が `ADMIN_API_KEY` を固定していないか確かめる（固定していれば同じタスクで直す）。
- [ ] **Step 2（RED）: 単体試験を書く。**
  - `confirm-route.test.ts`（先頭 `DD-AUTH-019`）: `type=magiclink`・`recovery`・`email`・`unknown`・`SIGNUP` の 5 通りで、`verifyOtp` が **呼ばれない**、`Location` が `/login`、`Set-Cookie` に `sb-access-token` が無い、`logAudit` が `detail: 'invalid_type'`。`type` 無しは `verifyOtp({ token_hash, type: 'signup' })`。`type=signup` の成功は今までどおり。
  - `register-route.test.ts`（先頭 `DD-AUTH-018`）: (a) `x-admin-token: <ADMIN_API_KEY と同じ値>` と `Authorization: Bearer ...` を付けても `createUser` が呼ばれず公開の登録として扱われる（Turnstile が呼ばれる）。`ADMIN_API_KEY` を未設定にしても 500 にならない。(b) 宛先単位の枠: `enforceRateLimit` が `{ endpoint: 'auth:register', limit: 5, windowSeconds: 3600, subject: 'user@example.com' }` で呼ばれ、呼ばれた順が Turnstile → 漏洩の確かめ → 枠 → 照会。大文字混じりの入力 `User@Example.com` でも `subject` が小文字。(c) 枠が 429 を返したら `findAuthUserIdByEmail`・`signUp`・`sendMail` が呼ばれず、`Retry-After` がある。(d) Turnstile が失敗した時は枠を呼ばない（他人の枠を潰せない）。(e) 201 の本文が `{ user: { id, email } }` でキーが 2 つだけ、`access_token` と `app_metadata` が無い。
  - `register-enumeration.test.ts`（先頭 `API-AUTH-005`）: 新規・登録済み・重複の例外の 3 通りの 202 で本文が同じ（今までの期待を保つ）。
- [ ] **Step 3（GREEN）: 実装する。** `confirm`: `ALLOWED_OTP_TYPES`・`OtpType` を消し、上の順で検査。`register`: 管理の鍵の枝（`adminApiKey`・`provided`・`createUser` の枝・`ADMIN_API_KEY` の確認）をすべて消す。`@remarks` の「公開の登録と管理の経路の両方を受ける」を直す。宛先単位の枠を入れる。201 の本文を直す。`scripts/e2e/environment.ts` の `ADMIN_API_KEY` の行を消す。`tsc` を流す。
- [ ] **Step 4: 結合試験を直す。** 管理の鍵を使う試験（`register.test.ts` の 107・374・416 行付近、`auth.test.ts` の 110〜130 行付近、`auth-flow.test.ts` の 85・94 行付近、`auth-password-rule.test.ts` の 169 行付近、`ui/auth-register-flow.test.tsx` の 273 行付近）は、管理の枝の期待を消し、「鍵を付けても公開の登録と同じ」に直す。`confirm.test.ts`（先頭 `API-AUTH-006`）に「`magiclink`・`recovery`・`email` は 303 `/login`・`Set-Cookie` 無し・`verifyOtp` 未呼び出し」を足す。
- [ ] **Step 5: 対象の `jest`。** `npx jest tests/unit/api/auth/confirm-route.test.ts tests/unit/api/auth/register-route.test.ts tests/integration/api/auth/confirm.test.ts tests/integration/api/auth/register.test.ts tests/integration/api/auth/register-enumeration.test.ts tests/integration/api/auth.test.ts tests/integration/auth-flow.test.ts tests/integration/api/auth-password-rule.test.ts tests/integration/ui/auth-register-flow.test.tsx tests/unit/scripts/e2e/environment.test.ts tests/integration/api/auth-bot-rate-limit.test.ts`。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-SIGNUP-002:201`（`SEC-AUTH-016-AC-03`。6 回目以降が宛先単位の 429。`MAX_REGISTER_ATTEMPTS_PER_ADDRESS = 40` で足りる）。`FR-SIGNUP-002:226`（`SEC-AUTH-017-AC-01`）。`FR-SIGNUP-003:298`（`SEC-AUTH-006-AC-01`）。
  - 直す: `FR-SIGNUP-002:230` の `E2E_FIXED_ENV.ADMIN_API_KEY` を、ファイルの上の定数 `const FORMER_ADMIN_TOKEN = 'e2e-former-admin-token-0123456789'` に替える（`import { E2E_FIXED_ENV }` が他で使われなくなれば import も消す）。
  - 外さない: `FR-SIGNUP-002:181`・`:245`（ENV `enable_confirmations`）、`FR-SIGNUP-003:263`（ENV）。
  - `FR-SIGNUP-002` で同じメールを 5 回より多く登録する試験が他に無いか `grep -n "postRegister" e2e/FR-SIGNUP-002-*.ts` で確かめる（`uniqueEmail()` を使っていれば問題なし）。
- [ ] **Step 7: 文書。** `areas/auth.md`: `SEC-AUTH-006` の本文から「今のコードは満たさない」を外し、確かめ方を実際に合わせる（signup の印だけ。他の型は `verifyOtp` を呼ばない）。`SEC-AUTH-016`: 本文の「宛先単位の制限は満たさない」を外し、AC-03 の確かめ方を「結合試験・E2E」にし、数字（5 回 / 時）を本文に書く。`SEC-AUTH-017`: 本文を「いつも公開の登録として扱う」の現行に直す。`SEC-AUTH-022`: `register` の 201 の本文を現行に。`threats/auth.md`: `THR-AUTH-017`（管理の鍵）の対策を「枝を削除した」に直す。`areas/auth.md`（構造設計）: `API-AUTH-005`・`API-AUTH-006` と `ARC-AUTH-006`（管理の鍵の記述があれば）を直す。`14_login.md`: `DD-AUTH-018`・`DD-AUTH-019`。`sequence/auth-registration.md`: 管理者 token の流れの図と文を削除する。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。
- [ ] **Step 9: 報告。** 共有文書の変更案: `api-spec.md` の 81 行・366 行の `ADMIN_API_KEY` の記述を消す、`register` の 201 の本文、本番の環境変数 `ADMIN_API_KEY` の削除（運用）、**本番ダッシュボードの確認メールの雛形が `token_hash` と `type=signup` を `/api/auth/confirm` へ渡しているかを開店前に確かめる**こと（`design-final.md` R15。これを外すと本番の会員登録の確認が全部失敗する）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。

---

## Task 3: AUTH SEC-AUTH-007 確認リンクのブラウザへの結び付け（単独のタスク）

**範囲:** SEC-AUTH-007（AC-01 の `test.fail` を外す。AC-02・AC-03 を足す）。波 1-A の暫定（P4: 別のブラウザでも session を作って `/`）を置き換える。**Task 2 が済んでいること。**

**Files:**

- Modify: `src/features/auth/return-intent/return-intent-store.ts`（`createReturnIntent`・`consumeReturnIntent`・`hashReturnIntentToken` に `bindTo`）、`return-intent-service.ts`（`issueReturnIntent` に `alwaysCreate`・`bindTo`、`consumeSignupBinding`・`resolveStoredDestination` を追加）、`src/app/api/auth/register/route.ts`、`src/app/api/auth/confirm/route.ts`、`src/app/login/page.tsx`（`IMPL-AUTH-101`・`DD-AUTH-001`）、`src/components/AuthTabs.tsx`（`IMPL-AUTH-141`・`DD-AUTH-010`）
- Create: `docs/03_BasicDesign/decisions/ADR-0413-signup-binding-email-bound-return-intent.md`
- Test: `tests/unit/features/auth/return-intent/return-intent-store.test.ts`・`return-intent-service.test.ts`（既存の名前を `ls` で確かめる）、`tests/unit/api/auth/confirm-route.test.ts`・`register-route.test.ts`、`tests/integration/api/auth/confirm.test.ts`・`register.test.ts`・`register-enumeration.test.ts`・`return-intent-flow.test.ts`、`tests/unit/app/login/login-page.test.tsx`（既存の名前を確かめる）、`tests/unit/components/AuthTabs.test.tsx`（同）、`tests/integration/ui/auth-register-flow.test.tsx`
- E2E: `e2e/FR-SIGNUP-003-signup-confirm-link.spec.ts`（`FR-LOGIN-038` は変えない）
- Docs: `docs/02_Requirements/areas/auth.md`、`docs/05_Quality/security/threats/auth.md`、`docs/03_BasicDesign/areas/auth.md`、`docs/04_DetailDesign/pages/14_login.md`、`docs/04_DetailDesign/sequence/auth-registration.md`

**Interfaces:**

```ts
// return-intent-store.ts
/** bindTo を渡すと sha256(番号 + "\n" + normalizeBindEmail(bindTo))。渡さない時は今までの sha256(番号)（login は変わらない） */
export function hashReturnIntentToken(token: string, bindTo?: string): string;
/** trim + 小文字。メールの大文字小文字や前後の空白で結び付けが外れないようにする */
export function normalizeBindEmail(email: string): string;
export async function createReturnIntent(input: { returnPath: string; purpose: ReturnIntentPurpose; bindTo?: string }): Promise<{ token: string; maxAgeSeconds: number } | null>;
export async function consumeReturnIntent(input: { token: string; purpose: ReturnIntentPurpose; userId: string; bindTo?: string }): Promise<string | null>;

// return-intent-service.ts
issueReturnIntent(input: { rawNext: unknown; purpose: ReturnIntentPurpose; origin?: string; bindTo?: string; alwaysCreate?: boolean })
//   alwaysCreate が真で、rawNext が無い・不正なら returnPath '/' で作る（不正の理由の監査 'rejected' は残す）。作成の失敗は今までどおり clear に倒す。
/** @impl IMPL-AUTH-220 @design DD-AUTH-034 */
export async function consumeSignupBinding(input: { cookieHeader: string | null; email: string; userId: string }):
  Promise<{ bound: true; storedPath: string } | { bound: false }>;
//   Cookie の番号が無い・形が違う・複数 → { bound:false }（DB を呼ばない）。番号があれば purpose 'signup'・bindTo email で consumeReturnIntent。null → { bound:false }。例外を投げない。Cookie は触らない。
/** @impl IMPL-AUTH-221 @design DD-AUTH-034 */
export function resolveStoredDestination(input: { stored: string; viewer: { role: 'admin'|'supporter'|'user'; aal: string|null }; origin?: string }): ResolvedDestination;
//   resolveReturnDestination の「使い切った値を出口の確かめで通す」部分を取り出した物。resolveReturnDestination もこれを呼ぶ。動きは変えない（1-A の試験が全部緑のまま）。
//   確認の窓口は使い切った後に呼ぶので、管理者・サポーターで aal2 でない時は使い切った戻り先を捨てて '/auth/verified'（今の confirm と同じ行き先）にする。
//   この分岐は confirm の側で resolveStoredDestination の前に書く（resolveStoredDestination は「確かめ」だけにし、needsMfa の判断を持たせない）。

// confirm の signup の流れ（type は Task 2 で signup 固定）
//   verifyOtp → 失敗は 303 /login（今まで）
//   → consumeSignupBinding({ cookieHeader, email: data.user.email ?? '', userId: data.user.id })
//   → bound:false  : session を作らない。persistSessionAndCookies・linkGuestOrdersByEmail を呼ばない。Cookie を書かない・消さない。
//                    verifyOtp が GoTrue 側に作った session（refresh token）は配らずに残るので、同じ public client で
//                    await supabase.auth.signOut({ scope: 'local' }) を呼んで消す（その session だけを失効。失敗は握り、console.error に { code } だけ。応答は変えない）。
//                    303 /login?registered=1（Cache-Control: no-store, Referrer-Policy: no-referrer）。
//                    監査 { action:'auth.confirm', outcome:'success', detail:'confirmed_without_session', metadata:{ reason:'no_binding' } }（メールは actor_email に残す今までの形）
//   → bound:true   : 既定 '/' の応答 → persistSessionAndCookies → linkGuestOrdersByEmail → resolveStoredDestination で Location を差し替え → applyReturnIntentCookie(res, {kind:'clear'})
//                    保存に失敗した時は今までどおり応答（'/'）を返し、Cookie は clear
// /login?registered=1 : page.tsx が registered === '1' を AuthTabs の notice に渡す。AuthTabs は notice を初回の描画で state に固定し、タブを替えても消さない（replaceState で query が消えても残る）。
//   文（案）: 「会員登録が完了しました。ログインしてください。」。role="status"。「このアカウントでログインしますか」の確かめの画面は出さない。
```

- [ ] **Step 1: 番号と既存の試験の確認（読むだけ）。** `IMPL-AUTH-220`・`221`・`ADR-0413` が空いているか。`ls tests/unit/features/auth/return-intent tests/unit/app/login tests/unit/components | grep -i "intent\|login-page\|AuthTabs"`。波 1-A で `confirm` の「Cookie が無い端末」の期待（`/` へ送る、セッションを作る）を書いた所を `grep -rn "without the return-intent cookie\|別のブラウザ\|no cookie" tests e2e` で洗い出す（Step 4・6 で直す）。
- [ ] **Step 2（RED）: 単体試験を書く。**
  - store（先頭 `DD-AUTH-033`）: `hashReturnIntentToken(t)` が `sha256(t)` の 16 進 64 桁（今までと同じ。bindTo 無し）。`hashReturnIntentToken(t, 'A@Example.com ')` と `hashReturnIntentToken(t, 'a@example.com')` が等しい。同じ番号で別のメールは違う。同じメールで別の番号は違う。`createReturnIntent({ ..., bindTo })`・`consumeReturnIntent({ ..., bindTo })` が `rpc` の `_token_hash` に bindTo ありのハッシュを渡す（bindTo 無しは今までのハッシュ）。
  - service（先頭 `DD-AUTH-034`）: (a) `issueReturnIntent({ rawNext: undefined, purpose:'signup', bindTo:'a@x.com', alwaysCreate:true })` が `createReturnIntent({ returnPath:'/', purpose:'signup', bindTo:'a@x.com' })` を呼び `{ kind:'set' }`。(b) `rawNext:'//evil.example'` でも `alwaysCreate` なら `'/'` で作り、監査 `rejected` が 1 回。(c) `alwaysCreate` 無し（login）は今までどおり clear。(d) 作成が null → clear。(e) `consumeSignupBinding`: Cookie 無し → `{bound:false}` で `consumeReturnIntent` が呼ばれない／番号が 2 つ → `{bound:false}`／`consumeReturnIntent` が null → `{bound:false}`／`/stockist` を返す → `{bound:true, storedPath:'/stockist'}`／`consumeReturnIntent` が例外 → `{bound:false}`（例外を投げない）。`consumeReturnIntent` が `purpose:'signup'`・`bindTo: 渡したメール` で呼ばれる。(f) `resolveStoredDestination`: 一般の `/account` → `/account`、`/admin`（一般）→ `/`、`//evil.example` → `/`、管理者 aal2 の `/admin` → `/admin`。`resolveReturnDestination` の既存の試験が全部緑。
  - `confirm-route.test.ts`（先頭 `DD-AUTH-019`）: `bound:false` で `persistSessionAndCookies`・`linkGuestOrdersByEmail` が呼ばれず、`auth.signOut({ scope: 'local' })` が 1 回呼ばれ（reject しても 303 のまま）、`Location` が `/login?registered=1`、`Set-Cookie` に `sb-access-token`・`sb-refresh-token`・`sb-return-intent` のどれも無い。`bound:true` で `app_metadata.role = 'admin'` の時は `/auth/verified`。`bound:true` で session の Cookie と戻り先、`sb-return-intent` の clear。`data.user.email` が無い時は `bound:false`（`consumeSignupBinding` に空文字が渡り外れる）。
  - `register-route.test.ts`（先頭 `DD-AUTH-018`）: `issueReturnIntent` が `{ purpose:'signup', bindTo: <正規化したメール>, alwaysCreate: true }` で呼ばれる。`next` 無しでも `Set-Cookie: sb-return-intent=...` が 3 つの 202（新規・登録済み・重複の例外）で出る。
  - `login-page.test.tsx`・`AuthTabs.test.tsx`: `?registered=1` で案内が `role="status"` で出る。`registered` 無し・`registered=0` では出ない。タブを会員登録に替えても案内が残る。
- [ ] **Step 3（GREEN）: 実装する。** store → service → `register`（`issueReturnIntent` の呼び出しだけ）→ `confirm` → `login/page.tsx`・`AuthTabs.tsx` の順。`tsc` をその都度流す。`register` の 201 の枝（Confirm email OFF）は今までどおり控えを clear。`ADR-0413` を書く（`documentation-guide` の 12 の型。退けた案: (a) 番号だけが行に当たる形 = 被害者の有効な Cookie が攻撃者の印で通る、(b) 署名つき Cookie に `sha256(メール)` を入れる案（`AUTH.md` の当初案。専用の鍵 `SEC-AUTH-027` が要る）、(c) PKCE の `code_verifier`（作りの変更が大きい）、(d) 確認の画面を挟む案（「はい」で同じ被害）。比較表（今の私たち／Shopify = 同じブラウザでコードを入れる／OWASP = リンクとブラウザの結び付け／結論）。上位に `SEC-AUTH-007`・`FR-AUTH-005`）。
- [ ] **Step 4: 結合試験を直す・足す。**
  - `confirm.test.ts`（先頭 `API-AUTH-006`）: 本物の `consumeSignupBinding` + `rpc` だけ偽物。**(1) Cookie の番号は signup の未使用の行に当たるが、別のメールの印**（攻撃者の印）→ `rpc` の `_token_hash` がメール込みで計算されるので偽物の `rpc` は null を返す → session を作らない・Cookie を消さない。(2) 合うメール → 303 戻り先・session。(3) Cookie 無し → 303 `/login?registered=1`・`Set-Cookie` 無し・`verifyOtp` は 1 回呼ばれる（メールの確認は済む）。(4) 波 1-A の「Cookie が無い端末は `/` へ送る」の期待を `/login?registered=1` に直す。
  - `register.test.ts`・`register-enumeration.test.ts`: 3 つの 202 の `Set-Cookie`（名前・`HttpOnly`・`SameSite=Lax`・`Max-Age=3600`・`Path=/`）が同じ形。`return-intent-flow.test.ts`: 登録 → 同じ Cookie で確認 → 戻り先、登録 → Cookie 無しで確認 → `/login?registered=1`、の往復。
  - UI 結合: `auth-register-flow.test.tsx` の登録後の画面の期待に変更が無いこと。
- [ ] **Step 5: 対象の `jest`。** `npx jest tests/unit/features/auth/return-intent tests/unit/api/auth/confirm-route.test.ts tests/unit/api/auth/register-route.test.ts tests/integration/api/auth/confirm.test.ts tests/integration/api/auth/register.test.ts tests/integration/api/auth/register-enumeration.test.ts tests/integration/api/auth/return-intent-flow.test.ts tests/unit/app/login tests/unit/components/AuthTabs.test.tsx tests/integration/ui/auth-register-flow.test.tsx tests/integration/api/auth/post-login.test.ts tests/integration/api/auth/oauth-callback.test.ts`。波 1-A の `login` 側の控え（`oauth/start`・`login`）が緑のままであること（`bindTo` を渡さない経路の回帰）。
- [ ] **Step 6: E2E（書くだけ。3 つの幅）。**
  - 外す: `FR-SIGNUP-003:351`（`SEC-AUTH-007-AC-01`）。
  - 直す: `FR-SIGNUP-003:398` の `FR-AUTH-005-AC-03 signup token opened on a browser without the return-intent cookie ignores…` を `SEC-AUTH-007-AC-02`（戻り先つきの登録でも、Cookie の無いブラウザ B で開くと戻り先を使わず `/login` へ 303、session の Cookie が無い）に書き換える。期待は `pathname === '/login'`、`ACCESS_COOKIE`・`REFRESH_COOKIE` が書かれない、メールが確認済み。
  - 足す: `SEC-AUTH-007-AC-03`（ブラウザ A で利用者 X の登録を送る → **同じブラウザ A で、別の利用者 Y の signup の印**（`issueTokenHash` で作る）の確認のリンクを開く → 303 `/login`・session の Cookie 無し・Y のメールは確認済み・A の `sb-return-intent` Cookie が残る）。
  - ファイルの上の説明コメント（「現在の結果」「行き先（波 1-A）」「SEC-AUTH-007-AC-01 だけが…赤」）を実際に合わせる。`SEC-AUTH-006-AC-02` は同じブラウザで session ができる守りとして緑のまま。
  - `FR-LOGIN-038` の `FR-AUTH-005-AC-03`（`/login` を直接開いてログイン → `/`）は別の動きなので変えない。
- [ ] **Step 7: 文書。** `areas/auth.md`: `SEC-AUTH-007` の本文から「今のコードは満たさない」「結び付けの作り方は決めていない」を外し、**番号 + メールのハッシュで結ぶ**現行の作りを書く。`-AC-01` の確かめ方を実際に、`-AC-02`・`-AC-03` を新しく書く（属性表つき。上位 `SEC-AUTH-007`）。`SEC-AUTH-006-AC-02` の「登録を始めたブラウザ」の定義を合わせる。`FR-AUTH-005` の本文の「別のブラウザは…`/`」があれば消す。`threats/auth.md`: `THR-AUTH-007` の対策。`areas/auth.md`（構造設計）: `FLOW-AUTH-003`（別のブラウザで開くと `/login?registered=1`）、`API-AUTH-005`・`API-AUTH-006`、`DATA-AUTH-004`（Cookie の用途に signup の結び付け）、`STATE-AUTH-006`（signup の控えの使い切りは session を作る前）。`14_login.md`: `DD-AUTH-001`・`DD-AUTH-010`・`DD-AUTH-018`・`DD-AUTH-019`・`DD-AUTH-033`・`DD-AUTH-034`。`sequence/auth-registration.md`: 別のブラウザで開く分岐を Mermaid の `sequenceDiagram` に足す。`e2e/FR-SIGNUP-003` の冒頭の「対応:」の行を `SEC-AUTH-007-AC-02`・`AC-03` 入りに直し、`FR-AUTH-005-AC-03` を外す（`FR-AUTH-005-AC-03` は `FR-LOGIN-038:310` が持ち続ける。`areas/auth.md` には E2E のファイルの対応表が無い＝2026-10-26 に grep で確認。対応は `trace:report` が作り直す）。`ADR-0412` の「結果」の「別のブラウザで確認のリンクを開いた人には戻り先が無く、`/` へ着く」を「`/login?registered=1` へ送る（ADR-0413）」に、signup の使い切りの順（session を作る前）を ADR-0413 へのリンクで直す（ADR-0412 の状態と確認日も直す）。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。
- [ ] **Step 9: 報告。** **案内の文をユーザーに見せて確かめる**（P5）。P1・P2・P3 の読みを報告に再掲する。残る穴として次を書く（直さない）: (1) Cookie の名前に `__Host-` の頭が無いので、同じ親ドメインの別のサブドメインを攻撃者が持つと、攻撃者の控え（攻撃者のメールに結んだ物）を被害者のブラウザへ投げ込める（cookie tossing。波 1-A の設計のまま）。(2) 被害者のブラウザに攻撃者のメールで登録を送らせる道は、`proxy.ts` の Origin の確かめと Turnstile に頼っている。共有文書の変更案: `api-spec.md` の `GET /api/auth/confirm`（別のブラウザは `/login?registered=1`）、`docs/06_Operations/secrets.md` は変更なし（専用の鍵を作らないため）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。

---

## Task 4: ADMIN 強制失効と MFA のリセット（SEC-ADMIN-006・007・008・013・014・015）

**範囲:** `revoke-user-sessions` の SEC-ADMIN-006（強制失効 20 / 10 分）・007・008（`detail`）・013（`user_id` の UUID と壊れた JSON）・015、`users/mfa/reset` の SEC-ADMIN-006（10 / 10 分）・008・014。

**Files:**

- Create: `src/lib/auth/revoke-user-sessions.ts`、`tests/unit/lib/auth/revoke-user-sessions.test.ts`、`docs/03_BasicDesign/decisions/ADR-0460-admin-unauthorized-audit-capped.md`、`docs/03_BasicDesign/decisions/ADR-0461-mfa-reset-reason-hash-only.md`
- Modify: `src/app/api/admin/revoke-user-sessions/route.ts`（`IMPL-ADMIN-103`・`DD-ADMIN-003`）、`src/app/api/admin/users/mfa/reset/route.ts`（`IMPL-ADMIN-105`・`DD-ADMIN-005`）
- Test: `tests/unit/api/admin/revoke-user-sessions-route.test.ts`・`mfa-reset-route.test.ts`、`tests/integration/api/admin/revoke-user-sessions.test.ts`、`tests/integration/api/admin-misc/admin-mfa-reset-api.test.ts`・`admin-audit-write.test.ts`・`admin-authorization-path.test.ts`・`admin-origin-guard.test.ts`（モックの形が変わる所だけ。この 3 つは Task 5・6 の窓口も 1 ファイルで見るので、`@/features/auth/middleware/rateLimit` と `@/features/auth/ratelimit` のモックはファイルの頭に 1 回だけ足し、Task 5・6 がそれを使う。Task 5・6 の窓口の期待には触らない）
- E2E: `e2e/FR-ADMIN-MISC-003-session-revocation-and-mfa-reset.spec.ts`（`FR-ADMIN-MISC-001` は枠を数えるだけで編集しない）
- Docs: `docs/02_Requirements/areas/admin.md`、`docs/05_Quality/security/threats/admin.md`、`docs/03_BasicDesign/areas/admin.md`、`docs/04_DetailDesign/pages/16-2_admin_misc.md`

**Interfaces:**

```ts
// src/lib/auth/revoke-user-sessions.ts（共有。@impl なし）
/** 自前の sessions を失効し、Auth 側の session を消す。どちらかの error があれば throw（固定の文のメッセージ）。 */
export async function revokeAllSessionsForUser(userId: string): Promise<{ authSessionsDeleted: number }>;
//   1. service.from('sessions').update({ revoked_at: now }).eq('user_id', userId) の error を見る → throw new Error('app_session_revocation_failed')
//   2. service.rpc('revoke_auth_sessions_for_user', { p_user_id: userId }) の error を見る → throw new Error('auth_session_revocation_failed')
//   3. { authSessionsDeleted: Number(data ?? 0) }。Supabase の誤りの本文は throw のメッセージに入れず console.error に { code } だけ。

// revoke-user-sessions/route.ts の流れ（順番が要点）
//   authorizeAdminPermission('admin.users.manage') 失敗 → 上限つきの監査（下）→ authz.response
//   enforceRateLimit({ endpoint: 'admin:users:revoke-sessions', limit: 20, windowSeconds: 600, subject: authz.userId })
//   body = await request.json().catch(() => null); z.object({ user_id: z.string().uuid() }) 失敗 → 400 + 監査 failure 'Invalid request body'
//   user_id === authz.userId → 400 { error: 'Cannot revoke your own sessions' } + 監査 failure 'self_revocation_rejected'
//   service.auth.admin.getUserById → 見つからない（error.status 404 または code 'user_not_found'、data.user 無し）→ 404 + 監査 failure 'target_not_found'（success を書かない）。それ以外の error → 500 + 監査 error 'target_lookup_failed'
//   revokeAllSessionsForUser → throw → 500 + 監査 error 'revoke_failed'（String(error) を入れない）
//   成功 → 監査 success metadata { auth_sessions_deleted } → 200 { ok: true }
// 認可失敗の監査の上限: incrementCounter({ endpoint: 'admin_revoke_unauthorized_audit', bucket: <600 秒に切った ISO>, subject: 'all' })
//   count <= 20 → outcome 'unauthorized' の行（今までの項目）／ count === 21 → **outcome 'unauthorized_burst'**（'unauthorized' にしない。E2E は outcome = 'unauthorized' の行を 20 以下で数える）の 1 行（detail 'further attempts suppressed for this window'）／ それ以上 → 書かない／ incrementCounter が throw → 書かない（fail-open）。
//   注: 窓の境目（600 秒）をまたぐと数え直すので、E2E の 80 回が境目をまたぐと最大 40 行になりうる（E2E の揺れとして報告に書く。直すなら E2E 側で窓の頭まで待つ）。
//   応答（authz.response）は監査の結果に関わらず変えない。

// mfa/reset/route.ts の流れ
//   authorizeAdminPermission('admin.users.manage') → enforceRateLimit({ endpoint: 'admin:users:mfa-reset', limit: 10, windowSeconds: 600, subject: authz.userId })
//   本文の確認・自分自身の拒否・getUserById（今のまま）
//   対象の役割: service.from('user_roles').select('roles!inner(code)').eq('user_id', userId).eq('active', true).or(`expires_at.is.null,expires_at.gt.${nowIso}`)
//     error → 500 + 監査 error 'role_lookup_failed'。admin か supporter が 1 つも無い → 400 { error: 'MFA reset is available only for privileged users' } + 監査 failure 'target_not_privileged'（app_metadata は使わない）
//   要素を全部消す（今のまま）。1 つでも失敗 → 500 + 監査 error（固定の文）
//   消せたら revokeAllSessionsForUser(userId)。throw → 500 + 監査 error 'session_revocation_failed'（metadata.deleted_factor_count は残す）
//   成功 → 200 { success:true, deletedFactorCount, message }（message は今のまま）
//   監査の metadata（全部の分岐）: 残してよい = requested_user_id・target_role・deleted_factor_count・total_factors・delete_error_factor_ids・reason_length・reason_sha256。
//     外す = reason・target_email・error_message・delete_errors[].message。reason_sha256 = sha256(trim 済みの reason) の 16 進。reason_length = trim 済みの reason の長さ。
//     本文の形の誤りの枝の requested_user_id・resource_id は、入力が UUID の形の時だけ残し、それ以外は null（確かめていない任意の長さの文字を監査に入れない）。
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "test.fail" e2e/FR-ADMIN-MISC-003-*.ts`。`FR-ADMIN-MISC-003` の `UNAUTHORIZED_AUDIT_ROW_LIMIT = 50`（38 行付近）を確かめる。`sharedAdmin()` で強制失効・MFA リセットを呼ぶ認可後の呼び出しの数を `FR-ADMIN-MISC-001・002・003・005` で数える（`grep -n "await revoke(\|resetMfa(" e2e/FR-ADMIN-MISC-00*.ts`）。**MFA リセットは 10 / 10 分、強制失効は 20 / 10 分を超えないこと**を報告に書く（今は 003 に MFA リセット 3 回・強制失効 5 回前後）。
- [ ] **Step 2（RED）: 単体試験を書く。**
  - `revoke-user-sessions.test.ts`（先頭 `DD-ADMIN-003`）: `sessions.update` が `{ error }` を返すと throw（メッセージは `app_session_revocation_failed`）。`rpc` が `{ error }` を返すと throw（`auth_session_revocation_failed`）。両方成功で `{ authSessionsDeleted: 3 }`（`data = 3`）、`data = null` で `0`。throw のメッセージに Supabase の誤りの本文が入らない。
  - `revoke-user-sessions-route.test.ts`（先頭 `DD-ADMIN-003`）: (a) 認可失敗 → 401 を返し、`incrementCounter` が `subject:'all'` で呼ばれ、count 20 → `outcome:'unauthorized'` 1 行、21 → `outcome:'unauthorized_burst'` 1 行（`outcome:'unauthorized'` は 0 行）、22 → 監査 0 行、`incrementCounter` が throw → 監査 0 行で応答は同じ 401。(b) 認可後に `enforceRateLimit` が `{ endpoint:'admin:users:revoke-sessions', limit:20, windowSeconds:600, subject: authz.userId }`、`user_id` を入力から使わない。429 なら本文を読まず `getUserById` を呼ばない。(c) `user_id:''`・UUID でない・壊れた JSON（`request.json()` が reject）→ 400 で 500 にならない。(d) `user_id === authz.userId` → 400 `Cannot revoke your own sessions`、`revokeAllSessionsForUser` が呼ばれず、監査 `outcome:'failure'`。(e) `getUserById` が `{ error:{ status:404, code:'user_not_found' }, data:{ user:null } }` → 404、`success` の監査が 0 行。別の error（status 500）→ 500。(f) `revokeAllSessionsForUser` が throw → 500、監査 `outcome:'error'`・`detail:'revoke_failed'`・本文のどこにも throw の文が出ない。(g) 成功 → 200 `{ ok: true }`、監査 `metadata.auth_sessions_deleted`。
  - `mfa-reset-route.test.ts`（先頭 `DD-ADMIN-005`）: (a) `enforceRateLimit` が `{ endpoint:'admin:users:mfa-reset', limit:10, windowSeconds:600, subject: authz.userId }`。(b) `app_metadata.role = 'supporter'` だが `user_roles` の問い合わせが空 → 400、`deleteFactor` が呼ばれず、監査 `detail` に `target_not_privileged`。逆に `app_metadata` が無くても `user_roles` に admin → 通る。`user_roles` の問い合わせの error → 500。(c) 全部の分岐の `logAudit` の呼び出しを集めて `JSON.stringify` し、入力の `reason` の文・`target_email`・Supabase の誤りの文が**含まれない**こと（失敗 400・自分自身・対象なし・特権でない・一覧の失敗・削除の失敗・成功の 7 分岐を表で）。成功の `metadata` は `reason_length`（trim 後の長さ）と `reason_sha256`（64 桁の 16 進で、`createHash('sha256').update(reason).digest('hex')` と等しい）を持つ。(d) 要素 0 件でも `revokeAllSessionsForUser` が呼ばれる。要素の削除に 1 つ失敗 → 500 で `revokeAllSessionsForUser` を呼ばない。(e) `revokeAllSessionsForUser` が throw → 500、`detail:'session_revocation_failed'`、`deleted_factor_count` が残る。(f) 成功の本文は今までと同じ。
- [ ] **Step 3（GREEN）: 実装する。** `revoke-user-sessions.ts` → 2 つの route の順。`tsc` を流す。`resolveRoleFromAppMetadata` と `AppRole` が不要になれば消す（自分の変更で孤児になる物だけ）。
- [ ] **Step 4: 結合試験を直す。** `revoke-user-sessions.test.ts`（先頭 `API-ADMIN-002`）・`admin-mfa-reset-api.test.ts`（先頭 `API-ADMIN-004`）のモックを新しい流れに合わせる（`getUserById`・`user_roles`・`enforceRateLimit`・`incrementCounter`）。`admin-audit-write.test.ts` ほかは、監査の `detail`・`metadata` の期待を固定の文に直す。DB 結合試験は書く場合も流さない（`tests/integration/db/` には足さない）。
- [ ] **Step 5: 対象の `jest`。** `npx jest tests/unit/lib/auth/revoke-user-sessions.test.ts tests/unit/api/admin/revoke-user-sessions-route.test.ts tests/unit/api/admin/mfa-reset-route.test.ts tests/integration/api/admin/revoke-user-sessions.test.ts tests/integration/api/admin-misc/admin-mfa-reset-api.test.ts tests/integration/api/admin-misc/admin-audit-write.test.ts tests/integration/api/admin-misc/admin-authorization-path.test.ts tests/integration/api/admin-misc/admin-origin-guard.test.ts`。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-ADMIN-MISC-003:194`（`SEC-ADMIN-007-AC-01`）、`:226`（`SEC-ADMIN-008-AC-01`）、`:279`（`SEC-ADMIN-014-AC-01`）、`:302`（`SEC-ADMIN-014-AC-02`）、`:320`（`SEC-ADMIN-015-AC-01`）、`:339`（`SEC-ADMIN-015-AC-02`）。
  - 直す: `UNAUTHORIZED_AUDIT_ROW_LIMIT` を 20 にし、「仮の値」のコメントを「決めた上限（ADR-0460）」に直す。`UNAUTHORIZED_REQUEST_COUNT` は `limit + 30` のまま。
  - 外さない: `:249`（`SEC-ADMIN-009-AC-01`。IP は波 4）。
  - `FR-ADMIN-MISC-003` の他の試験（`SEC-ADMIN-016-AC-01` ほか）が、強制失効の新しい検査（UUID・自分自身・存在）を踏まないか読む（対象が実在の別利用者であること）。
- [ ] **Step 7: 文書。** `areas/admin.md`: `SEC-ADMIN-006`（本文の「今のコードは満たさない」はこのタスクの 2 窓口の分だけ外す。ほかの窓口は Task 5・6 で外すので、**Task 6 の後に本文全体を書き直す**と注記する）、`SEC-ADMIN-007`（20 行・まとめの 1 行）、`SEC-ADMIN-008`（`-AC-01` の分。`-AC-02` は Task 5）、`SEC-ADMIN-013`（強制失効の分）、`SEC-ADMIN-014`・`SEC-ADMIN-015` の本文から「今のコードは満たさない」を外し、確かめ方を実際に合わせる。`threats/admin.md`: 該当 `THR-ADMIN-` の対策。`areas/admin.md`（構造設計）: `API-ADMIN-002`・`API-ADMIN-004`、`DATA-ADMIN-004`。`16-2_admin_misc.md`: `DD-ADMIN-003`・`DD-ADMIN-005`（流れ・監査の中身・異常）。`ADR-0460`・`ADR-0461` を書く（`ADR-0454` の「自前と Auth の両方を失効」と矛盾しないことを根拠に書く。比較表つき）。既存の ADR の食い違いを直す: `ADR-0457`（「対象の役割は `app_metadata` で決める」「監査に理由・対象のメール」「リセットの後も session を失効させない」は置き換わる。決定と結果を現行に直し、ADR-0461 へリンク）、`ADR-0454`（「悪くなること」の「自前の表の更新の誤りは見ない」「UUID・自分自身・存在しない利用者を断らない」は直った）。どちらも状態と確認日を直す。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- ADMIN`。
- [ ] **Step 9: 報告。** 共有文書の変更案（`api-spec.md`: 強制失効の 400 / 404 / 429、MFA リセットの 429 と失効、`DRV-ADMIN-002`「セッションは失効させない」の記述は `areas/admin.md` 側で直す）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- ADMIN`。

---

## Task 5: ADMIN ユーザー作成と色見本（SEC-ADMIN-006・008-AC-02・012・013・021 の色見本分）

**範囲:** `create-user` の SEC-ADMIN-006（20 / 10 分）・008-AC-02・012・013、`item-color-presets` の SEC-ADMIN-006（60 / 10 分）・013（壊れた JSON）・021（DELETE の 404、POST の確認の誤り）。

**Files:**

- Modify: `src/app/api/admin/create-user/route.ts`（`IMPL-ADMIN-102`・`DD-ADMIN-002`）、`src/app/api/admin/item-color-presets/route.ts`（`IMPL-ADMIN-141`・`DD-ADMIN-011`）、`src/app/api/admin/item-color-presets/[id]/route.ts`（`IMPL-ADMIN-142`・`DD-ADMIN-012`）
- Test: `tests/unit/api/admin/create-user-route.test.ts`・`item-color-presets-route.test.ts`・`item-color-presets-id-route.test.ts`、`tests/integration/api/admin-create-user-api.test.ts`・`admin-misc/admin-audit-write.test.ts`・`admin-authorization-path.test.ts`・`admin-origin-guard.test.ts`（8 文字のパスワードを渡す所）、`tests/integration/ui/admin-create-user-screen.test.tsx`・`tests/unit/app/admin/create-user/create-user-page.test.tsx`（変更が要らないことの確認）
- E2E: `e2e/FR-ADMIN-MISC-002-create-user-screen-and-api.spec.ts`、`e2e/FR-ADMIN-MISC-001-admin-api-authorization-gates.spec.ts`（パスワード・本文の期待を読むだけ。短いパスワードを渡す所があれば直す）
- Docs: `docs/02_Requirements/areas/admin.md`、`docs/05_Quality/security/threats/admin.md`、`docs/03_BasicDesign/areas/admin.md`、`docs/04_DetailDesign/pages/16-2_admin_misc.md`

**Interfaces:**

```ts
// create-user
//   authorizeAdminPermission('admin.users.manage') → enforceRateLimit({ endpoint:'admin:users:create', limit:20, windowSeconds:600, subject: authz.userId })
//   body = await request.json().catch(() => null); bodySchema = { email: z.string().email(), password: passwordSchema (features/auth/schemas/common, 16〜128), display_name: z.string().trim().max(100).optional() }
//   失敗 → 400 { error:'Invalid request' } + 監査 failure 'Invalid request body'（今まで）
//   checkPwnedPassword(password): 'pwned' → 400 { error: PWNED_PASSWORD_MESSAGE } + 監査 failure 'pwned_password'／'unavailable' → 通して監査 error `pwned_check_unavailable:${reason}`（fail-open）
//   createUser の error: 重複 → 409 + 監査 conflict detail 'email_already_registered' ／ それ以外 → 500 + 監査 error detail 'create_user_failed'（error.message を監査に入れない。console.error は残す）
// item-color-presets POST
//   authz('admin.items.manage') → enforceRateLimit({ endpoint:'admin:color-presets:write', limit:60, windowSeconds:600, subject: authz.userId }) → body = await request.json().catch(() => null) → 400
//   既存の確認 maybeSingle() の error → 500 { error:'Failed to save color preset' }（console.error は { code } だけ）
// item-color-presets/[id] DELETE
//   authz → 同じ endpoint の枠（POST と DELETE で 60 を分け合う）→ id が /^\d+$/ で 18 桁以下でなければ 404 → delete().eq('id', id).select('id') → 0 行 → 404 { error:'Color preset not found' }（監査は今も無いので書かない）
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "test.fail" e2e/FR-ADMIN-MISC-002-*.ts`。`grep -rn "password" e2e/FR-ADMIN-MISC-001-*.ts tests/integration/api/admin-misc/*.ts tests/integration/api/admin-create-user-api.test.ts | grep -i "create-user\|createUser\|min\|8"` で 16 文字未満のパスワードを `create-user` に渡す補助を洗い出す（同じコミットで 16 文字以上に直す）。
- [ ] **Step 2（RED）: 単体試験を書く。**
  - `create-user-route.test.ts`（先頭 `DD-ADMIN-002`）: (a) 枠 `{ endpoint:'admin:users:create', limit:20, windowSeconds:600, subject: authz.userId }` が認可の直後に呼ばれ、429 なら `createUser` を呼ばない。(b) 15 文字のパスワード → 400（今は 8 文字から通る）、16 文字 → 通る、129 文字 → 400。(c) `checkPwnedPassword` が `{ status:'pwned' }` → 400 で本文が `PWNED_PASSWORD_MESSAGE`、`createUser` 未呼び出し、監査 `pwned_password`。`{ status:'unavailable', reason:'timeout' }` → `createUser` が呼ばれ、監査に `pwned_check_unavailable:timeout`。(d) `display_name` が 101 文字 → 400、前後に空白のある 100 文字は trim して通る。(e) 壊れた JSON（`request.json()` が reject）→ 400 で 500 にならない。(f) 重複の誤り（`error.message = 'User already registered: a@b.com'`）→ 409、監査 `detail === 'email_already_registered'`。それ以外の誤り（`message = 'database error for a@b.com'`）→ 500、`detail === 'create_user_failed'`。**どちらの監査にも `error.message` とメールの字が含まれない**こと。
  - `item-color-presets-route.test.ts`（先頭 `DD-ADMIN-011`）: 枠 `{ endpoint:'admin:color-presets:write', limit:60, ..., subject: authz.userId }`、壊れた JSON → 400、`maybeSingle` が `{ error }` を返す → 500 で `insert` を呼ばない。
  - `item-color-presets-id-route.test.ts`（先頭 `DD-ADMIN-012`）: `delete().eq().select('id')` が `{ data: [] }` → 404（今は 200 を固定した例がある。直す）。`{ data: [{ id: 1 }] }` → 200。`id = 'abc'`・`'1; drop'`・`'-1'`・20 桁 → DB を呼ばず 404。枠が 429 なら DB を呼ばない。
- [ ] **Step 3（GREEN）: 実装する。** 3 つの route。`tsc` を流す。
- [ ] **Step 4: 結合試験を直す。** `admin-create-user-api.test.ts`（先頭 `API-ADMIN-001`）ほかの短いパスワードを 16 文字以上に。UI 側（`/admin/create-user` の頁）は変更が要らないことを `create-user-page.test.tsx` で確認する。
- [ ] **Step 5: 対象の `jest`。** `npx jest tests/unit/api/admin/create-user-route.test.ts tests/unit/api/admin/item-color-presets-route.test.ts tests/unit/api/admin/item-color-presets-id-route.test.ts tests/integration/api/admin-create-user-api.test.ts tests/integration/api/admin-misc tests/integration/ui/admin-create-user-screen.test.tsx tests/unit/app/admin/create-user/create-user-page.test.tsx`。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-ADMIN-MISC-002:164`（`SEC-ADMIN-008-AC-02`）、`:199`（`SEC-ADMIN-012-AC-01`）、`:211`（`SEC-ADMIN-013-AC-01`）、`:233`（`SEC-ADMIN-013-AC-02` の UUID）。
  - 印の無い `:223`（`SEC-ADMIN-013-AC-02` の壊れた JSON）は今の 500 で赤の見込みなので、このタスクで通る。**印を付け直さず**、報告に「今まで印が無く赤だった」と書く。
  - 直す: パスワードの補助（`strongPassword()` ほか）が 16 文字以上であることを確かめる。`SEC-ADMIN-012-AC-02`（漏洩）は E2E が無い（照合の外の呼び出しを差し替える試験が要る）ので、単体・結合で確かめ、E2E は足さない。
  - 外さない: `FR-ADMIN-MISC-005:373`（`SEC-ADMIN-022-AC-01`。色見本の監査と行為者のメール・IP は波 4）、`:158`・`:202`（`SEC-ADMIN-002` は波 5）。
- [ ] **Step 7: 文書。** `areas/admin.md`: `SEC-ADMIN-008`（`-AC-02` の分を外す）・`SEC-ADMIN-012`・`SEC-ADMIN-013` の本文から「今のコードは満たさない」を外す（013 は強制失効と合わせて全部の分が済む）。`SEC-ADMIN-006`・`SEC-ADMIN-021` は Task 6 の後に本文全体を書き直す旨を注記（Task 4・5 の分は現行と書く）。`areas/admin.md`（構造設計）: `API-ADMIN-001`・`API-ADMIN-014`・`API-ADMIN-015`、`SCR-ADMIN-001`（画面の 16 文字は変わらない旨）。`16-2_admin_misc.md`: `DD-ADMIN-002`・`DD-ADMIN-011`・`DD-ADMIN-012`。`threats/admin.md`: 該当 `THR-ADMIN-`（`TM-ADMIN-05` の未確認事項を「16 文字 + 漏洩照合を当てた」に直す）。`ADR-0459` の「悪くなること」の「既にあるかを引く時の誤りを見ない」は直ったので現行に直す（状態と確認日も）。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- ADMIN`。
- [ ] **Step 9: 報告。** 共有文書の変更案（`api-spec.md`: `create-user` の 16 文字・漏洩・429、`item-color-presets` の 404 / 429）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- ADMIN`。

---

## Task 6: ADMIN 問い合わせと監査ログの読み出し（SEC-ADMIN-006・018・020・021・023）

**範囲:** `contact/*` の SEC-ADMIN-006（返信 30・そのほかの問い合わせ 60 / 10 分）・018（返信の件名）・020（詳細から `submitted_ip`・`user_agent` を外す）・021（404・返信の誤り）・023（一覧・詳細・監査ログの読み出しの記録）。**Task 5 が済んでいること**（`FR-ADMIN-MISC-006:652` は色見本の DELETE も見る）。

**Files:**

- Modify: `src/app/api/admin/contact/route.ts`（`IMPL-ADMIN-121`・`DD-ADMIN-006`）、`contact/[id]/route.ts`（`IMPL-ADMIN-122`・`DD-ADMIN-007`）、`contact/[id]/reply/route.ts`（`IMPL-ADMIN-123`・`DD-ADMIN-008`）、`contact/templates/route.ts`（`IMPL-ADMIN-124`・`DD-ADMIN-009`）、`contact/templates/[id]/route.ts`（`IMPL-ADMIN-125`・`DD-ADMIN-010`）、`src/app/api/admin/audit-logs/route.ts`（`IMPL-ADMIN-104`・`DD-ADMIN-004`）
- Test: `tests/unit/api/admin/admin-contact-route.test.ts`・`admin-contact-id-route.test.ts`・`admin-contact-reply-route.test.ts`・`admin-contact-templates-route.test.ts`・`admin-contact-templates-id-route.test.ts`・`audit-logs-route.test.ts`、`tests/integration/api/admin-misc/`（問い合わせ・監査ログに触る既存の結合試験。`grep -rln "admin/contact\|admin/audit-logs" tests/integration`）、`tests/integration/api/admin-contact-detail-api.test.ts`・`admin-contact-list-api.test.ts`・`admin-contact-reply-api.test.ts`・`admin-contact-status-api.test.ts`・`admin-contact-templates-create-api.test.ts`・`admin-contact-templates-update-api.test.ts`・`admin-contact-templates-delete-api.test.ts`、`tests/integration/api/admin/audit-logs.test.ts`（2026-10-26 にレビューが `ls` で確かめた。`submitted_ip` を固定した期待・回数制限のモックの無い所を直す）
- E2E: `e2e/FR-ADMIN-MISC-004-audit-log-read.spec.ts`、`FR-ADMIN-MISC-006-contact-management.spec.ts`、`FR-ADMIN-MISC-007-contact-reply-mail-and-threading.spec.ts`
- Docs: `docs/02_Requirements/areas/admin.md`、`docs/05_Quality/security/threats/admin.md`、`docs/03_BasicDesign/areas/admin.md`、`docs/04_DetailDesign/pages/16-2_admin_misc.md`

**Interfaces:**

```ts
// 回数制限（認可の直後・本文を読む前。subject は authz.userId）
//   POST /contact/[id]/reply        : { endpoint:'admin:contact:reply',  limit:30, windowSeconds:600 }
//   PATCH /contact/[id]、POST /contact/templates、PUT・DELETE /contact/templates/[id] : { endpoint:'admin:contact:write', limit:60, windowSeconds:600 }（4 つで 60 を分け合う）
// 404（P10）: id が UUID でない → DB に渡さず 404。update/delete に .select('id')、0 行 → 404 + 監査 { outcome:'failure', detail:'inquiry_not_found' | 'template_not_found' }。success は書かない
// reply の追加:
//   件名 = inquiry.subject.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim() → 先頭が 'Re:' でなければ `Re: ${...}`（空になったら 'Re: (件名なし)'）
//   contact_inquiries の状態の更新の error を見る → 500 { error:'Failed to update inquiry status' }（保存した返信は取り消さない。監査 error 'status_update_failed'）
//   MAIL_FROM_ADDRESS が無い → mailSent:false、監査 outcome 'error' detail 'reply_saved_mail_not_configured'（'reply_sent' にしない）
// GET /contact/[id]: select から submitted_ip・user_agent を外す。200 の後に logAudit({ action:'admin.contact.read', actor_id, actor_email, resource:'contact', resource_id:id, outcome:'success' })（名前・メール・本文・件名を入れない）
// GET /contact（一覧）: 200 の後に logAudit({ action:'admin.contact.list', actor_id, actor_email, resource:'contact', outcome:'success', metadata:{ status, type, page, q_length } })（検索語そのものは入れない。status・type は許可の値だけ、無ければ null）
// GET /audit-logs: 200 の後に logAudit({ action:'admin.audit_logs.read', actor_id, actor_email, resource:'audit_logs', outcome:'success' })
//   logAudit が失敗しても読み出しは止めない（D8）。logAudit は DB の誤りを中で握るが、throw しうる所（service の作成など）もあるので、
//   読み出しの 3 か所は各ファイルの中の小さな関数 auditReadSafely（try { await logAudit(e) } catch { console.error 固定の文 }）で包む。共有の audit.ts は触らない。
//   読み出しの監査に ip は入れない（SEC-ADMIN-023 の本文の「IP」は request-ip.ts が要る → 波 4。AC-01 は id とメールだけを見る）。
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "test.fail" e2e/FR-ADMIN-MISC-004-*.ts e2e/FR-ADMIN-MISC-006-*.ts e2e/FR-ADMIN-MISC-007-*.ts`。`ContactSection.tsx` が `submitted_ip`・`user_agent` を使っていないこと、404 の応答を握る表示があるかを `grep -n "404\|submitted_ip\|user_agent\|res.ok" src/components/ContactSection.tsx`。`FR-ADMIN-MISC-006`・`007` の `withAdminActor` が試験ごとに別の管理者を作るか（枠を共有しないか）を確かめる。
- [ ] **Step 2（RED）: 単体試験を書く。**
  - `admin-contact-reply-route.test.ts`（先頭 `DD-ADMIN-008`）: (a) 枠 `admin:contact:reply` 30 / 600・`subject: authz.userId`、429 なら `insert`・`sendMail` を呼ばない。(b) 件名 `'注文\r\nBcc: attacker@example.com'` で `sendMail` の `subject` が `Re: 注文 Bcc: attacker@example.com`（`\r`・`\n` を含まない）、`mailSent:true`。`'\u0000\u001f'` だけの件名 → `Re: (件名なし)`。`Re: 既存` はそのまま。(c) 状態の更新が `{ error }` → 500。(d) `MAIL_FROM_ADDRESS` 無し → 201 `mailSent:false`、`sendMail` 未呼び出し、監査 `detail:'reply_saved_mail_not_configured'`。(e) `id` が UUID でない → 404。
  - `admin-contact-id-route.test.ts`（先頭 `DD-ADMIN-007`）: GET の `select` の文字列に `submitted_ip`・`user_agent` が無い。応答の `data` のキーにも無い。GET 200 の後に `logAudit` が `action:'admin.contact.read'`・`resource_id`・`actor_id`・`actor_email` で 1 回、`JSON.stringify(呼び出し)` に問い合わせの名前・メール・本文が無い。404 の時は読み出しの監査を書かない。PATCH: 枠 `admin:contact:write` 60、UUID でない id → 404、`update().select('id')` が `[]` → 404 + 監査 `failure`・`inquiry_not_found`（`success` が 0 行）、1 行 → 200 + `success`。
  - `admin-contact-route.test.ts`（先頭 `DD-ADMIN-006`）: 一覧 200 の後に `action:'admin.contact.list'`、`metadata` が `{ status:'open', type:null, page:1, q_length:5 }` の形で、`q` の語（`taro@example.com` など）が `JSON.stringify` に含まれない。500 の時は書かない。
  - `admin-contact-templates-route.test.ts`・`admin-contact-templates-id-route.test.ts`（先頭 `DD-ADMIN-009`・`DD-ADMIN-010`）: POST・PUT・DELETE の枠 `admin:contact:write`、PUT・DELETE の UUID でない id → 404、0 行 → 404（今の「対象が無くても 200」を固定した例を直す）。
  - `audit-logs-route.test.ts`（先頭 `DD-ADMIN-004`）: 200 の後に `action:'admin.audit_logs.read'`、`logAudit` が reject しても 200 のまま。
- [ ] **Step 3（GREEN）: 実装する。** 6 つの route。`tsc` を流す。
- [ ] **Step 4: 結合試験を直す。** モックの連鎖に `.select('id')` を足す。応答の形（`submitted_ip` なし）を固定した所を直す。
- [ ] **Step 5: 対象の `jest`。** `npx jest tests/unit/api/admin/admin-contact-route.test.ts tests/unit/api/admin/admin-contact-id-route.test.ts tests/unit/api/admin/admin-contact-reply-route.test.ts tests/unit/api/admin/admin-contact-templates-route.test.ts tests/unit/api/admin/admin-contact-templates-id-route.test.ts tests/unit/api/admin/audit-logs-route.test.ts tests/integration/api/admin-misc tests/integration/api/admin-contact tests/integration/api/admin/audit-logs.test.ts`（`tests/integration/api/admin-contact` は `admin-contact-*-api.test.ts` の 7 本に当たる）。`ContactSection` の UI 試験（`grep -rln ContactSection tests`）も流す。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-ADMIN-MISC-004:251`（`SEC-ADMIN-023-AC-01`）、`FR-ADMIN-MISC-006:630`（`SEC-ADMIN-020-AC-01`）、`:652`（`SEC-ADMIN-021-AC-01`。Task 5 の色見本の DELETE の 404 と合わせて通る）、`FR-ADMIN-MISC-007:290`（`SEC-ADMIN-006-AC-01`）、`:315`（`SEC-ADMIN-006-AC-02`。subject が管理者 id で XFF に依らない）、`:386`（`SEC-ADMIN-018-AC-01`）。
  - 外さない: `FR-ADMIN-MISC-007:414`（`SEC-ADMIN-022-AC-02`。`ip` と行為者のメールは波 4）、`FR-ADMIN-MISC-006:242`・`:262`（`FR-ADMIN-009` の CONTACT タブは波 4）。
  - `FR-ADMIN-MISC-007` の `RATE_LIMIT_PROBE_CAP = 200` が返信の上限 30 を超えていること、`replyUntilLimited` が 429 の本文を作らないことを読んで確かめる。
- [ ] **Step 7: 文書。** `areas/admin.md`: `SEC-ADMIN-006`（全窓口の分がそろったので本文全体から「今のコードは満たさない」を外し、数字を本文に書く）・`SEC-ADMIN-018`・`SEC-ADMIN-020`（送信元の IP・ブラウザは返さない。`DRV-ADMIN-008` の記述を「返さない」に）・`SEC-ADMIN-021`・`SEC-ADMIN-023` の本文から外す（`SEC-ADMIN-023` は「読んだ人の IP は満たさない（波 4、`request-ip.ts`）」を残す）。`SEC-ADMIN-022` は**残す**（波 4）。`ADR-0456` の「悪くなること」の「状態の更新の誤りは見ない」「送り手の設定が無い時も `mailSent` が真・reply_sent」は直ったので現行に直す（状態と確認日も）。返信を保存した後の状態の更新の誤りで 500 を返すと、管理者が送り直した時に返信の行が 2 つになりうることを ADR-0456 の「悪くなること」に書く（要件 SEC-ADMIN-021 が 500 を決めている）。`DRV-ADMIN-004`（「本文が壊れていると 500」「無い id でも 200」）の記述を直す。`FR-ADMIN-009` の「無くても 200」の記述を直す。`threats/admin.md` の該当 `THR-ADMIN-`。`areas/admin.md`（構造設計）: `API-ADMIN-003`・`005`〜`012`。`16-2_admin_misc.md`: `DD-ADMIN-004`・`006`〜`010`。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- ADMIN`。
- [ ] **Step 9: 報告。** 共有文書の変更案（`api-spec.md`: 問い合わせの詳細から `submitted_ip`・`user_agent` を外す、404、429、読み出しの監査）。**メール送信の最後の砦（`mail.ts` の CR・LF 除去）は今回やらない**ことを再掲。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- ADMIN`。

---

## Task 7: STOCKIST 取扱店の管理の窓口と公開の取り出し（SEC-STOCKIST-009・011・013・014・018・002）

**範囲:** 管理の列の絞り、入力の形の許可、変更の 0 行 → 404 と削除前の中身の監査、検証の誤りを固定の文に、壊れた JSON を 400 に、公開の取り出しの上限 200 と公開用の client。

**Files:**

- Create: `src/features/stockist/schemas.ts`、`tests/unit/features/stockist/stockist-schemas.test.ts`
- Modify: `src/app/api/admin/stockists/route.ts`（`IMPL-STOCKIST-141`・`DD-STOCKIST-034`）、`src/app/api/admin/stockists/[id]/route.ts`（`IMPL-STOCKIST-142`・`DD-STOCKIST-035`）、`src/features/stockist/services/public.ts`（`IMPL-STOCKIST-103`・`104`）
- Test: `tests/unit/api/admin/stockists/stockists-route.test.ts`・`stockists-id-route.test.ts`、`tests/unit/api/admin/stockists-security.test.ts`（変更が要るか確認）、`tests/integration/api/stockist-admin-create-api.test.ts`・`stockist-admin-item-get-api.test.ts`・`stockist-admin-item-put-api.test.ts`・`stockist-admin-item-patch-api.test.ts`・`stockist-admin-item-delete-api.test.ts`・`stockist-admin-list-api.test.ts`・`stockist-admin-write-path.test.ts`・`stockist-admin-guards.test.ts`、`tests/unit/features/stockist/stockist-public-service.test.ts`、`tests/unit/app/stockist/stockist-page.test.tsx`、`tests/integration/ui/stockist-list-screen.test.tsx`・`stockist-public-read-path.test.tsx`、`tests/integration/api/home-page-public-read.test.ts`（`createClient` のモックを見る所）
- E2E: `e2e/FR-STOCKIST-015-admin-api-behaviour.spec.ts`、`e2e/FR-STOCKIST-017-global-state-windows.spec.ts`
- Docs: `docs/02_Requirements/areas/stockist.md`、`docs/05_Quality/security/threats/stockist.md`、`docs/03_BasicDesign/areas/stockist.md`、`docs/04_DetailDesign/pages/16-4_admin_stockist.md`・`10_stockist.md`

**Interfaces:**

```ts
// src/features/stockist/schemas.ts
export const ADMIN_STOCKIST_COLUMNS = 'id, name, address, phone, time, holiday, status, updated_at';
export const stockistStatusSchema = z.enum(['private', 'published']);
export const stockistWriteSchema: z.ZodObject<...>;
//   name 255・address 500・time 120・holiday 120 は 1 行の文字だけ: z.string().trim().min(1).max(n).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u)
//   phone: z.string().trim().min(1).max(50).regex(/^[0-9+\-() 　（）]+$/)（半角全角の空白は明示。\s は改行を含むので使わない）
//   status: stockistStatusSchema
/** @impl IMPL-STOCKIST-149 @design DD-STOCKIST-034 */
export function toInvalidStockistResponse(error: z.ZodError): NextResponse; // 400 { error:'Invalid request', fields:[...重複なしの先頭の path の名前] }。details・fieldErrors・formErrors・入力の値を含めない。

// 管理の窓口
//   GET 一覧・GET 1 件: .select(ADMIN_STOCKIST_COLUMNS)
//   POST・PUT・PATCH: body = await request.json().catch(() => null)。null → 監査 failure 'Invalid JSON' → 400 { error:'Invalid request' }（500 にならない）。検証の失敗 → toInvalidStockistResponse
//   PUT・PATCH: .update(...).eq('id', stockistId).select('id')。error → 今までの 500。0 行 → 404 { error:'Stockist not found' } + 監査 failure 'Stockist not found'（success を書かない）
//   DELETE: .delete().eq('id', stockistId).select('id, name, address, status')。0 行 → 404 + 監査 failure。1 行 → 監査 success metadata { deleted: { id, name, address, status } }
//   console.error('Failed to ...', error) を { code: error.code } に替える（Supabase の誤りの本文・変数の値を記録しない）
// 公開の取り出し
export const PUBLIC_STOCKIST_FETCH_LIMIT = 200;
//   getPublicStockists: createPublicClient()（Cookie を引き継がない）。limit = min(floor(options.limit ?? 200), 200)。limit が無い・不正でも 200 を掛ける。
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "test.fail" e2e/FR-STOCKIST-015-*.ts e2e/FR-STOCKIST-017-*.ts`。`src/lib/supabase/server.ts` の `createPublicClient` の形。`StockistSection.tsx`・`StockistForm.tsx` が 404 とエラー本文の `error` だけを読むこと（`details` を読まないこと）を確かめる。`grep -rn "details" src/features/stockist src/components/StockistSection.tsx`。
- [ ] **Step 2（RED）: 単体試験を書く。**
  - `stockist-schemas.test.ts`（先頭 `DD-STOCKIST-034`）: 店名 `'本店\nInjected'`・`'本店​'`（書式文字）・`'本店 '` を拒む、`'本店 Le Fil'`・全角空白入りの店名は通る。電話 `'03-1234-5678'`・`'+81 3 1234 5678'`・`'（03）1234-5678'`・`'03　1234'` は通り、`'call-me-maybe'`・`'03-1234-5678\n'`・`'03-1234-5678（代表）'` は拒む。`toInvalidStockistResponse` の本文が `{ error:'Invalid request', fields:['name'] }` で、`JSON.stringify` に `fieldErrors`・`formErrors`・入力の値が無い。
  - `stockists-route.test.ts`・`stockists-id-route.test.ts`（先頭 `DD-STOCKIST-034`・`DD-STOCKIST-035`）: (a) GET の `select` が `ADMIN_STOCKIST_COLUMNS`。(b) `request.json()` が reject → POST・PUT・PATCH が 400 で `insert`・`update` を呼ばず、監査 `failure`。(c) 店名が空 → 400 で `details`・`fieldErrors`・`formErrors` が無い。(d) PUT・PATCH の `update().eq().select('id')` が `{ data: [] }` → 404 + 監査 `outcome:'failure'`、`success` の監査が 0 行。1 行 → 200 + `success`。(e) DELETE が `{ data: [] }` → 404。1 行 → 200 で監査 `metadata.deleted` が `{ id, name, address, status }` ちょうど（電話・営業時間を含まない）。(f) `console.error` の第 2 引数が `{ code }` だけ（`Error` オブジェクトを渡さない）。
  - `stockist-public-service.test.ts`（先頭 `DD-STOCKIST-003`・`DD-STOCKIST-004`）: `createPublicClient` が使われ `createClient` が呼ばれない。`options.limit` 無しで `.limit(200)`、`limit: 6` で `.limit(6)`、`limit: 500` で `.limit(200)`、`limit: 0`・`NaN`・負でも `.limit(200)`。誤りは今までどおり空配列。
- [ ] **Step 3（GREEN）: 実装する。** `schemas.ts` → 2 つの route → `public.ts`。`tsc` を流す。
- [ ] **Step 4: 結合・UI 試験を直す。** モックの連鎖に `.select(...)` を足す。`home-page-public-read.test.ts` ほか `getPublicStockists` の下のモックが `createClient` の場合は `createPublicClient` に替える。
- [ ] **Step 5: 対象の `jest`。** `npx jest tests/unit/features/stockist tests/unit/api/admin/stockists tests/unit/api/admin/stockists-security.test.ts tests/unit/app/stockist tests/integration/api/stockist-admin-create-api.test.ts tests/integration/api/stockist-admin-item-get-api.test.ts tests/integration/api/stockist-admin-item-put-api.test.ts tests/integration/api/stockist-admin-item-patch-api.test.ts tests/integration/api/stockist-admin-item-delete-api.test.ts tests/integration/api/stockist-admin-list-api.test.ts tests/integration/api/stockist-admin-write-path.test.ts tests/integration/api/stockist-admin-guards.test.ts tests/integration/ui/stockist-list-screen.test.tsx tests/integration/ui/stockist-public-read-path.test.tsx tests/integration/api/home-page-public-read.test.ts`。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-STOCKIST-015:219`（`SEC-STOCKIST-009`）、`:262`（`SEC-STOCKIST-011`）、`:300`（`SEC-STOCKIST-013-AC-01`）、`:314`（`SEC-STOCKIST-013-AC-02`）、`:330`（`SEC-STOCKIST-014-AC-01`）、`:342`（`SEC-STOCKIST-014-AC-02`）、`FR-STOCKIST-017:127`（`SEC-STOCKIST-018`。3 つの幅の繰り返しの中の 1 本）。
  - 外さない: `FR-STOCKIST-015:241`（`SEC-STOCKIST-010` no-store は波 1-C）、`:284`（`SEC-STOCKIST-012` IP は波 4）、`FR-STOCKIST-013:119・237`（`stockists.type` の移行は波 2）、`:320・332`（`SEC-STOCKIST-019` は波 4）、`FR-STOCKIST-014:520・550`（`SEC-STOCKIST-020・021` は波 4）、`FR-STOCKIST-016`（`SEC-STOCKIST-003` は波 5）。
  - `FR-STOCKIST-015` の `ADMIN_COLUMNS` が `ADMIN_STOCKIST_COLUMNS` と同じ 8 列であること、`validBody()` の電話・店名が新しい許可に合うことを読んで確かめる。
- [ ] **Step 7: 文書。** `areas/stockist.md`: `SEC-STOCKIST-009`・`011`・`013`・`014`・`018`・`002` の本文から「今のコードは満たさない」を外し、確かめ方を実際に合わせる（`011` は「許す字は案」を現行の字に）。`threats/stockist.md`。`areas/stockist.md`（構造設計）: `API-STOCKIST-001`〜`006`、`ARC-STOCKIST-001`（公開は `createPublicClient`）。`16-4_admin_stockist.md`・`10_stockist.md`: `DD-STOCKIST-003`・`004`・`034`・`035`。`ADR-0253`（公開の取り出しの誤りは空）は変えない。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- STOCKIST`。
- [ ] **Step 9: 報告。** **本番の `stockists` の `phone`・`time`・`holiday`・`name` に許可外の字（改行・「03-1234-5678（代表）」の漢字）が無いかを読むだけの SQL で確かめる**こと（`design-final.md` R12。ある店は編集で保存できなくなる）を controller に頼む。共有文書の変更案（`api-spec.md`: 管理の応答の列、400 の本文、404）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- STOCKIST`。

---

## Task 8: NEWS と HOME（SEC-NEWS-005・016、SEC-HOME-013）

**範囲:** ニュースの公開の取り出しから `image_url` と署名を外す、管理の変更の 0 行 → 404、ホームの ITEM の取得を 8 件に。

**Files:**

- Modify: `src/features/news/services/public.ts`（`IMPL-NEWS-121`〜`124`）、`src/features/news/types.ts`、`src/app/api/admin/news/[id]/route.ts`（`IMPL-NEWS-162`・`DD-NEWS-065`）、`src/app/page.tsx`（`IMPL-HOME-101`・`DD-HOME-001`）
- Test: `tests/unit/features/news/news-public-service.test.ts`、`tests/unit/api/news/news-route.test.ts`、`tests/unit/app/actions/news-actions.test.ts`、`tests/integration/api/news-public-api.test.ts`・`news-image-signing.test.ts`・`news-admin-item-put-api.test.ts`・`news-admin-write-path.test.ts`・`home-page-public-read.test.ts`・`home-page-proxy-csp.test.ts`、`tests/integration/ui/home-page-*.test.tsx`・`news-unused-units.test.tsx`・`about-flow.test.tsx`、`tests/unit/home/home-page.test.tsx`、`tests/integration/ui/home-page-view-all-screen.test.tsx`、`tests/unit/api/admin/news/news-admin-id-route.test.ts`（管理の `[id]` の単体試験）、`tests/unit/components/PublicNewsGrid.test.tsx`・`tests/integration/ui/news-category-state.test.tsx`・`news-home-section.test.tsx`・`news-list-detail-flow.test.tsx`（`image_url` 入りの記事の見本を持つ。`PublicNewsArticle` の型で書いた見本は余分な項目で `tsc` が落ちるので外す。型の付かない見本は残してよい）。`tests/integration/api/home-page-public-read.test.ts` は Task 7 の後に直す（公開の列。上の注）
- E2E: `e2e/FR-NEWS-SEC-001-public-data-exposure.spec.ts`、`e2e/FR-NEWS-SEC-005-admin-write-aal2.spec.ts`、`e2e/FR-HOME-023-home-published-only-and-content.spec.ts`
- Docs: `docs/02_Requirements/areas/news.md`・`home.md`、`docs/05_Quality/security/threats/news.md`・`home.md`、`docs/03_BasicDesign/areas/news.md`・`home.md`、`docs/04_DetailDesign/pages/02_news_list.md`・`03_news_detail.md`・`16-1_admin_news.md`・`01_home.md`

**Interfaces:**

```ts
// PublicNewsArticle から image_url を外す（PublicNewsDetailArticle は PublicNewsArticle & { detailed_content } のまま）
// getPublishedNews: .select('id, title, published_date, category, content')。createServiceRoleClient・signNewsImageFields を呼ばない
// getPublishedNewsDetailById: .select('id, title, published_date, category, content, detailed_content')。同じく署名しない
//   公開の道が service role を持たなくなる。検索（search.service.ts の signResultImages）と管理（admin/news）の署名は残す。
// admin/news/[id] PUT・PATCH: .update(...).eq('id', id).select('id')。error → 今までの 500。0 行 → 404 { error:'Article not found' } + logNewsAudit(..., 'admin.news.update.not_found' | 'admin.news.status_update.not_found', 'failure', 'News article not found', { articleId: id }, id)（success を書かない）
// admin/news/[id] DELETE: .delete().eq('id', id).select('id')。0 行 → 404 + 'admin.news.delete.not_found' の failure
//   id の形: bigint の文字（/^\d+$/ で 18 桁以下）でなければ DB に渡さず 404（失敗の監査は書く）。
// page.tsx: const HOME_ITEM_FETCH_COUNT = 8;
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "test.fail" e2e/FR-NEWS-SEC-001-*.ts e2e/FR-NEWS-SEC-005-*.ts e2e/FR-HOME-023-*.ts`。`grep -rn "image_url" src/features/news src/app/news src/app/api/news src/app/page.tsx` で公開の道に `image_url` を読む所が無いこと（`NewsSection.tsx` は管理用の自前の型）を確かめる。`getPublishedNews` を使う呼び手（`src/app/page.tsx`・`src/app/news/page.tsx`・`src/app/api/news/route.ts`・`src/app/actions/news.ts`）の型が壊れないこと。`grep -rn "HOME_ITEM_FETCH_COUNT\|toHaveBeenCalledWith(10)" src tests e2e`。
- [ ] **Step 2（RED）: 単体試験を書く。**
  - `news-public-service.test.ts`（先頭 `DD-NEWS-003`・`DD-NEWS-031`）: 一覧の `select` が `'id, title, published_date, category, content'`、詳細が `'id, title, published_date, category, content, detailed_content'`（`image_url` を含まない）。`createServiceRoleClient` と `signNewsImageFields` が**呼ばれない**。戻りの記事のキーに `image_url` が無い。
  - `news-route.test.ts`（先頭 `DD-NEWS-` の `/api/news` の単位）: 応答の各記事に `image_url` が無い。
  - 管理の `[id]` の単体試験（先頭 `DD-NEWS-065`）: PUT・PATCH・DELETE の `update/delete().eq().select('id')` が `{ data: [] }` → 404 で `logNewsAudit` が `failure`・`.not_found`、`success` の呼び出しが 0。1 行 → 200 + `success`。`id = 'abc'` → DB を呼ばず 404。`error` → 今までの 500。
  - `home-page.test.tsx`（先頭 `DD-HOME-001`）: `getPublishedItems` が `8` で呼ばれる。
- [ ] **Step 3（GREEN）: 実装する。** `types.ts` → `public.ts` → 管理の `[id]` → `page.tsx`。`tsc` を流す。
- [ ] **Step 4: 結合・UI 試験を直す。** `news-public-api.test.ts`（95・114・118・242 行付近）・`news-image-signing.test.ts`（253〜270 行付近の「公開は service role を署名に使う」→使わない）・`news-admin-item-put-api.test.ts`・`news-admin-write-path.test.ts`（モックの連鎖に `.select`）・`home-page-*` 一式（`image_url` を含む記事のモックを外す。型が通るなら残してもよい）・`home-page-view-all-screen.test.tsx:147` と `tests/unit/home/home-page.test.tsx:201` の `10` を `8` に。テスト名の先頭は構造設計の ID（`API-NEWS-001`・`API-NEWS-005`〜`007`・`SCR-HOME-004` ほか）。
- [ ] **Step 5: 対象の `jest`。** `npx jest tests/unit/features/news tests/unit/api/news tests/unit/api/admin/news tests/unit/app/actions/news-actions.test.ts tests/integration/api/news-public-api.test.ts tests/integration/api/news-image-signing.test.ts tests/integration/api/news-admin-item-put-api.test.ts tests/integration/api/news-admin-write-path.test.ts tests/integration/api/home-page-public-read.test.ts tests/integration/api/home-page-proxy-csp.test.ts tests/unit/home/home-page.test.tsx tests/integration/ui/home-page-view-all-screen.test.tsx tests/integration/ui/news-unused-units.test.tsx tests/unit/components/PublicNewsGrid.test.tsx tests/integration/ui/news-category-state.test.tsx tests/integration/ui/news-home-section.test.tsx tests/integration/ui/news-list-detail-flow.test.tsx`。`tests/integration/ui/home-page-*.test.tsx` と `about-flow.test.tsx` も流す。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-NEWS-SEC-001:271`・`:369`（`SEC-NEWS-005`）、`:388`・`:400`（`SEC-NEWS-007-AC-01・AC-02`）、`:413`（`SEC-NEWS-008-AC-01`）。後の 3 本は P14 のとおり副産物で通る。`FR-NEWS-SEC-005:271`（`SEC-NEWS-016`）。`FR-HOME-023:333`（`SEC-HOME-013`）。
  - 外さない: `FR-NEWS-SEC-001:450`（`SEC-NEWS-012`）、`FR-NEWS-SEC-003:109・134・146・194・219`（004・006・023・011）、`FR-NEWS-SEC-005:286・305・339・354`（017・018）、`FR-NEWS-ADMIN-001:472`（020）、`FR-HOME-022`・`FR-HOME-023:203・225`（別の波）。
  - `FR-HOME-021`・`FR-HOME-013` の「最大 10 件」の期待は `≤ 10` なので 8 件でも通る。変えない。
- [ ] **Step 7: 文書。** `areas/news.md`: `SEC-NEWS-005`・`SEC-NEWS-016` の本文から「今のコードは満たさない」を外す。`SEC-NEWS-007`・`SEC-NEWS-008` は「公開の道は署名しない（SEC-NEWS-005）。検索と管理の署名の確かめは満たさない（波 1-C）」と書き、AC の確かめ方を実際に合わせる。`areas/home.md`: `SEC-HOME-013` は商品の件数の部分だけを現行にし（描く 8 件だけを取る。続きの有無は件数の問い合わせ `getPublishedItemsCount` で決めるので「判定の 1 件」は取らない、と本文を実際に合わせる）、「署名つき URL を残す表（`signedUrlCache`）の件数の上限」と「大量の表示への守り（中継の回数の制限）を本番の前に決める」は**満たさないまま残す**（`HOME.md` §3.8 の残る文）。`src/app/page.tsx` の 29〜30 行の「表示数の最大値」のコメントも 8 件に合わせる。`FREQ-147-REQ-01` を「8 件取る」に直し、`FREQ-147-REQ-02` の「xl 以上は 10 件」は**直さず**「FREQ-276 で置き換え済みの古い記述。食い違い（P15）」と注記して、未確認事項に載せる。`areas/news.md`（構造設計）: `ARC-NEWS-003`（公開は署名しない）、`API-NEWS-001`・`005`〜`007`、`DATA-NEWS-004`。`areas/home.md`（構造設計）: `ARC-HOME-002`・`SCR-HOME-004`。`02_news_list.md`・`03_news_detail.md`・`16-1_admin_news.md`・`01_home.md` の `DD-`。`threats/news.md`・`home.md` の該当。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- NEWS`、`npm run validate-trace -- HOME`。
- [ ] **Step 9: 報告。** 共有文書の変更案（`api-spec.md`: `/api/news` の応答から `image_url`、`areas/news.md` 以外の `ARC-NEWS-003` の写し、`requirements.md` の `FREQ-147` の 10 件）。FREQ-147 の食い違いを報告する（P15）。管理のニュースの PUT は画像を上げてから更新するので、無い id（0 行 → 404）でも上げた画像が置き場に残る（今の更新の失敗の枝と同じ。このタスクでは直さず、SEC-NEWS の残りとして報告する）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- NEWS`、`npm run validate-trace -- HOME`。

---

## Task 9: 最終確認と controller への報告

**Files:** 変更なし（読むだけ）。報告だけを返す。

- [ ] **Step 1: 全体の型と文書。** `npx tsc --noEmit`（G-3 の誤りは報告に分けて書く）、`npm run validate-docs`、`npm run validate-trace`（全領域。`--update-baseline` はしない。基準より増えた違反が 0 件であること）。
- [ ] **Step 2: 触らない約束の確認。** `git status --short` と `git diff --stat` で、次が**変わっていない**ことを確かめる: `src/proxy.ts`、`next.config.ts`、`src/features/auth/middleware/rateLimit.ts`、`src/features/auth/ratelimit/index.ts`、`src/lib/auth/authenticate.ts`、`src/lib/auth/admin-rbac.ts`、`src/lib/audit.ts`、`src/lib/mail.ts`、`src/app/admin/page.tsx`、`supabase/migrations/**`、共有文書 7 つ、`tests/unit/docs/*-traceability.test.ts`。`grep -rn "sanitizeRedirectPath" src tests e2e --include=*.ts --include=*.tsx --exclude-dir=graphify-out` が 0 件のまま。
- [ ] **Step 3: `test.fail` の突き合わせ。** `grep -rn "test.fail" e2e/FR-LOGIN-03[02]* e2e/FR-SIGNUP-00[23]* e2e/FR-ADMIN-MISC-00* e2e/FR-STOCKIST-01[3-7]* e2e/FR-NEWS-SEC-00[135]* e2e/FR-HOME-02[23]*` の結果が、各タスクの「外さない」と一致する（外した 38 行が残っていない。外さない行が消えていない）。外した行の一覧（ファイル:元の行:要件 ID）を報告に載せる。
- [ ] **Step 4: 回数制限の枠の合計。** `sharedAdmin()` を使う E2E の認可後の呼び出しの数（強制失効・MFA リセット・ユーザー作成・色見本・問い合わせの書き込み）を、10 分の枠（20・10・20・60・60）と並べて表にする。超える所は「試験ごとの管理者に替える」案を書く。
- [ ] **Step 5: controller への報告を返す。** 次を含める。
  1. 共有文書の変更案（各タスクの報告を集約）: `api-spec.md`（`refresh`・`otp/verify`・`register` の応答、`register` の管理の鍵の記述の削除、`confirm` の別のブラウザ、強制失効・MFA リセット・ユーザー作成・色見本・問い合わせの 429 / 404 / 400、問い合わせ詳細の項目、取扱店の列と 400 / 404、`/api/news` の `image_url`）、`route-inventory.md`（窓口の追加・削除は無し）、`requirements.md`（`FREQ-147` の 10 件）、`test-spec.md`（テスト名の追加・変更）、台帳（状態欄）、`tests/unit/docs/*-traceability.test.ts`（窓口の数は変わらない）、`db-migrations.md`（変更なし）。
  2. controller が流す確認: E2E（本番ビルド、手元の Supabase）で外した 38 行と `FR-SIGNUP-003` の新しい 2 本、`npm run trace:report`、`npm run test:trace-coverage`、`amr` の実測（P7）、確認のメールの雛形（Task 2）、本番の `stockists` の既存データ（Task 7）。
  3. ユーザーに見せる物: `/login?registered=1` の案内の文（P5）。
  4. 運用: 本番の環境変数 `ADMIN_API_KEY` の削除（P13）、本番ダッシュボードの確認メールの型。
  5. 回す物（下の表）。

---

## 回す物（この波で直さない。理由つき）

`design-final.md` §3-2 の波 1-B の行と `wave1b-decisions.md` の各項目を 1 つずつ見て、タスクに割り当てた物は上の Task に、割り当てなかった物は次の表に載せた。

### 1-B の行と決定の項目の割り当て

| 項目 | 行き先 |
| --- | --- |
| R15: SEC-ADMIN-014 / 015 | Task 4 |
| R15: SEC-AUTH-017 / 006 | Task 2 |
| R15: SEC-AUTH-007（決定の追加） | Task 3 |
| R2: SEC-AUTH-031 の局所版 | Task 1 |
| R13: SEC-AUTH-022 本文 | Task 1（refresh・otp/verify）、Task 2（register の 201） |
| R7: SEC-AUTH-009 | Task 1 |
| R7: SEC-AUTH-016-AC-03 | Task 2 |
| R7: SEC-ADMIN-006 | Task 4（強制失効・MFA リセット）、Task 5（ユーザー作成・色見本）、Task 6（問い合わせ） |
| R11: SEC-ADMIN-007 / 008 | Task 4（008-AC-02 は Task 5） |
| R11: SEC-ADMIN-021 | Task 5（色見本）、Task 6（問い合わせ・テンプレート） |
| R11: SEC-STOCKIST-013 | Task 7 |
| R11: SEC-NEWS-016 | Task 8 |
| R12: SEC-ADMIN-012 / 013 | Task 5（013 の強制失効の分は Task 4） |
| R12: SEC-ADMIN-018 | Task 6 |
| R12: SEC-STOCKIST-011 / 014 | Task 7 |
| R13・R14 の局所分: SEC-NEWS-005 / SEC-HOME-013 | Task 8 |
| R13・R14 の局所分: SEC-STOCKIST-009 / 018 | Task 7 |
| R13・R14 の局所分: SEC-ADMIN-020（D7） | Task 6 |
| D8: SEC-ADMIN-023（読み出しの記録） | Task 6 |
| 同じファイルで一緒に直す: SEC-STOCKIST-002 | Task 7 |
| 同じ窓口で一緒に直す: SEC-AUTH-030 の成功の監査（コードの部分） | Task 1 |

### タスクに入れない物

| 項目 | 理由・行き先 |
| --- | --- |
| SEC-ADMIN-022（行為者のメール・IP、色見本の監査） | IP は `request-ip.ts`（R6）と Q13 が前提で、`FR-ADMIN-MISC-007:414` が `ip` を求める。**共有部品が要る → 波 4**。`FR-ADMIN-MISC-005:373` の印も残す |
| SEC-ADMIN-009（監査の IP の信頼） | `request-ip.ts`（共有・R6）が要る → 波 4。`FR-ADMIN-MISC-003:249` の印を残す |
| SEC-ADMIN-002・SEC-STOCKIST-003・SEC-AUTH-010 / 011 | DB の変更（`has_permission`・権限）→ 波 2 / 5 |
| `stockists.type` の NOT NULL を外す（`FR-ADMIN-006-AC-02`・`FREQ-18-AC-01`） | **DB の移行が要る → 波 2**（Q21）。`FR-STOCKIST-013:119・237` の印を残す |
| SEC-STOCKIST-010（no-store） | route 単位の no-store は波 1-C（共有の `withNoStore` を 1 つ作る方針） |
| SEC-STOCKIST-012 / 019 / 020 / 021 | IP（波 4）、頁の入口（波 4、Q20）、`rateLimit.ts` の順序と `admin-rbac.ts` の `denial`（共有 → 波 4、Q22） |
| SEC-AUTH-022-AC-02（`/api/auth` の no-store） | `proxy.ts`（共有）→ 波 3。`FR-LOGIN-030:236` の印を残す |
| SEC-AUTH-005・031 の共有版・DB 版、本人への通知メール | `authenticate.ts`・DB（共有）→ 波 5。通知の要否はユーザー判断（Q30）。**OTP だけを GoTrue へ直接送る道は、Task 1 の局所版では閉じない** |
| SEC-AUTH-013（回数制限の送り元） | `rateLimit.ts`（共有）→ 波 4 |
| SEC-AUTH-029・016-AC-01・015・FREQ-316-REQ-02（ENV）、SEC-AUTH-030-AC-01 の TOTP 有効化 | `supabase/config.toml`・本番ダッシュボード → 波 6。Q16 の「確認リンクの有効期間は 300 秒のまま」もここ |
| `password-reset/request` の DB 書き込みを `after()` に出す（SEC-AUTH-016 の時間差） | 1-B の行に無く、試験も無い → 波 1-C で扱うか、controller が決める |
| `/api/auth/me` の `email` を外す（SEC-HOME-016・SEC-PRIVACY-016、R13） | 1-B の行に無い。AUTH の 1 窓口で閉じる → 波 1-C に回す案。入れるなら Task 1 に `me/route.ts` を足す（controller の決定） |
| SEC-NEWS-007 / 008 の本体（検索と管理の署名の確かめ）、SEC-NEWS-006・012・017・018・020、SEC-LOOK-009 ほか | 波 1-C / 3。Task 8 は 007 / 008 の印を副産物として外すだけ（P14） |
| 管理の画像の中身の確かめ（`image-signature.ts`）、`safe-error.ts`（共有の新ファイル） | 波 1-C。Task 7 は `{ code }` だけを記録し、共有の `safe-error.ts` は作らない |
| `audit.ts` の制御文字の除去（R11-7）、`mail.ts` の CR・LF 除去 | 共有・全メールに効く → 波 4 / やらない（§6） |
| FR-ADMIN-009（CONTACT タブ） | `src/app/admin/page.tsx`（G-3 が触る）→ 波 4（Q14 D9） |
| D6（店長どうしのリセット・失効の守り、本人への通知） | 要件がユーザー待ち。テストを通すには不要 |
| 本番の確認メールの雛形、`ADMIN_API_KEY` の本番削除、本番の `stockists` の既存データの確認 | 運用・読むだけの確認（controller・ユーザー）。Task 2・7・9 の報告に載せる |
| `FREQ-147-REQ-02`「xl 以上は 10 件」 | 文書の食い違い。推測で決めず報告（P15） |

---

## 自己点検（計画の作成者が行った確認）

- **範囲の網羅。** `wave1b-decisions.md` の範囲の 7 行（R15・SEC-AUTH-007・R2 局所・R13 本文・R7・R11・R12・R14 と R13 の局所・D8）と `design-final.md` §3-2 の波 1-B の行の全項目を、上の表で Task か「タスクに入れない物」に載せた。載せ漏れが無いことを、行ごとに突き合わせた。
- **ファイルの重なり。** （レビューで直した）重なりは列の中だけにある: AUTH（1 → 2 → 3）、ADMIN（4 → 5 → 6）、公開（7 → 8）。列の中は直列、列どうしは並行にできる（「ファイルの全体像」の下の表）。
- **共有部品。** 触るのは「呼ぶだけ」の物（`enforceRateLimit`・`incrementCounter`・`authorizeAdminPermission`・`authenticateRequest`・`logAudit`・`checkPwnedPassword`・`passwordSchema`）と、新しい小さなファイル 3 つ（`amr.ts`・`revoke-user-sessions.ts`・`schemas.ts`）の追加だけ。`audit.ts`・`mail.ts`・`rateLimit.ts` の変更は無い。窓口は増やさず、移行も作らない。
- **危ない読みを `前提の読み` に出した。** P1（番号 + メールのハッシュ。決定文の「合う」を狭く読む）と P2（session を作る前に使い切る）は決定文と波 1-A の設計から外れるので、controller の確認を求める。P7（`amr` の実測）はこの計画では確かめられない。
- **行番号。** E2E の `test.fail` の行番号は 2026-10-26 時点の `grep` の結果。実装者は編集の前に `grep -n "test.fail"` で取り直す（G-3 や波 1-A の後で動く）。
- **試験の段。** 単体は `DD-`、結合は `API-`・`FLOW-`・`SCR-`、E2E は `-AC-NN` で始める。新しい受け入れ条件（`SEC-AUTH-007-AC-02`・`AC-03`）は E2E を同じタスクで書く（`missing-child` を増やさない）。
- **残るリスク。** (1) `amr` の実測前に Task 1 の `enroll-totp` を出すと、管理者が最初の TOTP を登録できなくなる恐れがある（P7）。(2) Task 2 の宛先単位の枠は、本人の間違いで 1 時間止まり、他人が妨害もできる（Q15 で許容済み）。(3) Task 7 の電話の許す字は本番の既存データで保存できなくなる店を出しうる。(4) 波 1-A の移行 `20261026010000` は本番に未適用で、Task 3 は本番適用の後でなければ本番で動かない。

---

## 計画のレビュー

| 項目 | 内容 |
| --- | --- |
| 日付 | 2026-10-26 |
| レビュアー | Claude Opus（計画のレビュー。コード・DB・テストは変えていない。この計画のファイルだけを直した） |
| 照らした物 | `wave1b-decisions.md`、`design-final.md`（R2・R7・R11〜R15、§3-2）、`AUTH.md`・`HOME.md`、各タスクが触る窓口の今のコード、`areas/{auth,admin,home}.md` の該当の AC、`test.fail` の付いた E2E（`FR-LOGIN-032`・`FR-SIGNUP-002`・`FR-SIGNUP-003`・`FR-ADMIN-MISC-003`・`004`・`007`・`FR-STOCKIST-015`・`017`・`FR-NEWS-SEC-001`・`005`・`FR-HOME-023`）、移行 `20261026010000_auth_return_intents.sql`、Supabase の JWT Claims Reference（`amr.method`） |
| 結論 | 直したうえで進めてよい。決定文から外れる所は無い。DB の移行が要る項目はタスクに隠れていない（P1 は既存の `token_hash` の 64 桁の 16 進の形のまま、関数の引数も変えない）。共有部品・共有文書の編集はどのタスクにも無い |

### 確かめて問題が無かった点

- **SEC-AUTH-007 の結び付け（P1）。** `consume_auth_return_intent` は `token_hash`・`purpose`・未使用・期限で 1 行だけを使い切る（`20261026010000`）。signup の控えを `sha256(番号 + "\n" + 小文字のメール)` にすると、(a) 被害者の有効な Cookie と攻撃者の印の組は 0 行で外れ、被害者の行も使い切られない（P3 と両立）、(b) login の控え（`sha256(番号)`）とは式も `purpose` も違うので混ざらない、(c) `RegisterRequestSchema` の `emailSchema` が trim と小文字をしているので登録の側と `data.user.email` の側がそろう。`FR-SIGNUP-003` の `SEC-AUTH-006-AC-02` は「未確認の会員を先に作って登録済みの枝の 202 を通る」形なので、3 つの 202 で同じ形の控えを作る P4 と合う。
- **SEC-AUTH-016 の見分けにくさ。** 控えの作成と宛先単位の枠を既存会員の照会の前に置くので、Set-Cookie と 429 の有無は登録済みかどうかで変わらない。`enforceRateLimit` の `subject` は `hashSubject` でハッシュされてから数え場所に入る（メールの平文は残らない）。
- **回数制限の数・`subject`。** 決定文の数（20・20・10・30・60・60 / 10 分、TOTP 5 / 600 秒、登録 5 / 時）と一致。どれも検証済みの値（`claims.sub`・`authz.userId`・スキーマを通ったメール）。
- **`test.fail` の外す・外さない。** 各タスクの行は 2026-10-26 の `grep` と一致した。`FR-LOGIN-032:419`（SEC-AUTH-031-AC-01）は `amr` の確かめが `listFactors` と `enroll` より前で 403 になるので、手元の TOTP が無効でも反転する。`FR-NEWS-SEC-001:388・400・413`（P14）は `image_url` が応答から消えれば `?? null` で通る。
- **ID の空き。** `IMPL-AUTH-` の最大は 219、`IMPL-STOCKIST-` は 148、`ADR-0413`・`0460`・`0461` は未使用。

### 直した点（この計画の本文に反映済み）

| # | 見つけたこと | 直し方 |
| --- | --- | --- |
| 1 | タスクのファイルが重ならないとしていたが、`tests/integration/auth-flow.test.ts`（Task 1 と 2）、`auth-bot-rate-limit.test.ts`（Task 1 と 2）、`admin-misc/admin-audit-write`・`admin-authorization-path`・`admin-origin-guard`（Task 4・5・6 の 10 窓口を 1 ファイルで見る）、`home-page-public-read.test.ts`（Task 7 と 8）が重なる | 「ファイルの全体像」の下に 3 本の列（AUTH 1→2→3、ADMIN 4→5→6、公開 7→8）を置き、列の中は直列・列どうしは並行とした。Task 4 が回数制限のモックを共有の試験ファイルの頭に足し、後のタスクがそれを使う |
| 2 | P7 の `amr` の数え方で `magiclink` を外していた。確認済みの利用者の `verifyOtp({ type: 'email' })` を GoTrue がどちらで記録するか未実測で、`magiclink` だった場合は管理者の最初の TOTP の登録が全部 403 になる | `magiclink` を 2 段目に数える（受け箱を持つ証明で `otp` と同じ強さ。退ける相手は `password` だけの通行証）。P7・Interfaces・`amr.test.ts` の表を直した |
| 3 | SEC-ADMIN-007 のまとめの 1 行を `unauthorized_burst` と書くだけで outcome か detail か曖昧。outcome を `unauthorized` のままにすると `FR-ADMIN-MISC-003:194` の「`unauthorized` の行 ≤ 20」が 21 で落ちる | outcome を `unauthorized_burst` と明記。600 秒の窓の境目をまたぐと最大 40 行になりうる E2E の揺れを注記 |
| 4 | Task 6 の Interfaces は「logAudit を try/catch で包まない」としつつ、単体試験は「logAudit が reject しても 200」を求めていて食い違う（D8 は読み出しを止めないこと） | 読み出しの 3 か所を各ファイルの中の `auditReadSafely` で包む形にした（共有の `audit.ts` は触らない） |
| 5 | SEC-AUTH-007 の `bound:false` で、`verifyOtp` が GoTrue 側に作った session（refresh token）が配られないまま残る | 同じ public client で `signOut({ scope: 'local' })` を呼んで消す（失敗は握る）。単体試験にも足した |
| 6 | `resolveStoredDestination` は使い切った後に呼ぶので、管理者・サポーター（aal1）の時の行き先が決まっていなかった（今の confirm は `/auth/verified`） | confirm の側で「特権で aal2 でない → `/auth/verified`」を先に書くと明記 |
| 7 | `mfa/verify` の challenge の 404（not found）の枝と、保存の失敗の枝の `String(persistError)` が監査の決まりから漏れていた | `factor_not_found` の failure と固定の `session_persist_failed` を足した |
| 8 | `confirm` の監査の `detail: error?.message`・`String(err)` が Global Constraints（誤りの文を残さない）に反するまま | Task 2 で固定の符号に替える |
| 9 | MFA リセットの形の誤りの枝で、確かめていない入力の `userId` を `resource_id`・`requested_user_id` に入れていた | UUID の形の時だけ残す |
| 10 | 既存の ADR が新しい動きと食い違うまま残る: `ADR-0412`（別のブラウザは `/`）、`ADR-0454`・`ADR-0457`（強制失効・MFA リセット）、`ADR-0456`（返信の状態の更新・`mailSent`）、`ADR-0459`（色見本の既存の確かめ） | 各タスクの「文書」の手順に直す ADR を足した |
| 11 | `SEC-HOME-013` を全部「満たす」にする手順だったが、本文の「署名つき URL の表の上限」「大量の表示への守り」は今回直さない（`HOME.md` §3.8） | 商品の件数の部分だけを現行にし、残りは「満たさない」のまま残す |
| 12 | `SEC-ADMIN-023` の本文は「読んだ人の IP」も求めるが、IP は波 4 | IP の部分を「満たさない」のまま残す |
| 13 | Task 8 の型の変更（`PublicNewsArticle` から `image_url`）で、`image_url` 入りの見本を持つ 4 つの試験（`PublicNewsGrid.test.tsx`・`news-category-state`・`news-home-section`・`news-list-detail-flow`）が試験の一覧に無く、`tsc` が落ちうる | Task 8 の Test と `jest` に足した |
| 14 | Task 2 の一覧に `auth-bot-rate-limit.test.ts` が無かった（register の枠の呼び出しの数を数える）。題の「メール単位の枠も持たない」が新しい作りと食い違う | Task 2 に足し、題の直しと宛先単位の枠の 1 本を足す手順にした。Task 1 は流すだけ |
| 15 | Task 6 の結合試験が「`admin-contact` で始まる物が無ければ」となっていたが、`tests/integration/api/admin-contact-*-api.test.ts` が 7 本と `tests/integration/api/admin/audit-logs.test.ts` がある | 名前を並べて一覧に入れた |
| 16 | Task 1 で `enroll-totp` の 403 を想定するかを見ていない UI の試験があった | `auth-verified-screen`・`auth-verified-state`・`verified-page` を読む・流す対象に足した |

### controller に確かめてほしい点（計画では決めない）

- P1（決定文の「合う」を番号 + メールで狭く読む）・P2（session の前に使い切る）。レビューでは決定文の意図（ログインの CSRF を断る）にかない、移行も要らないと判断した。
- `/login?registered=1` の文（P5）をユーザーに見せる。
- 本番の確認メールの雛形。Supabase の公式の例は `type=email` を使っているので、雛形が `type=email` なら Task 2 の後は本番の会員登録の確認が全部 `/login` で止まる。開店前に `type=signup` を確かめる（Task 2 の報告に既にある）。
- `amr` の実測（P7）。手元の本物のログインの通行証を E2E で 1 回デコードし、`otp` か `magiclink` かを記録する。
- 残る穴: cookie tossing（`sb-return-intent` に `__Host-` が無い。波 1-A の設計）、MFA の登録の本人への通知（波 5）、管理のニュースの PUT の 404 で上げた画像が残る（Task 8 の報告）、返信の保存の後の 500 で送り直すと返信が 2 つになりうる（SEC-ADMIN-021 が 500 を決めている。Task 6 の ADR に書く）。

### 最終のタスクの一覧

| 順 | タスク | 列 | 前に要るタスク |
| --- | --- | --- | --- |
| 1 | AUTH 認証の窓口（SEC-AUTH-009・031 局所・022 本文・030 の成功の監査） | AUTH | なし |
| 2 | AUTH 登録と確認の小さい直し（SEC-AUTH-006・017・016-AC-03・022 の登録） | AUTH | 1 |
| 3 | AUTH SEC-AUTH-007 確認リンクのブラウザへの結び付け | AUTH | 2 |
| 4 | ADMIN 強制失効と MFA のリセット（SEC-ADMIN-006・007・008・013・014・015） | ADMIN | なし |
| 5 | ADMIN ユーザー作成と色見本（SEC-ADMIN-006・008-AC-02・012・013・021） | ADMIN | 4 |
| 6 | ADMIN 問い合わせと監査ログの読み出し（SEC-ADMIN-006・018・020・021・023） | ADMIN | 5 |
| 7 | STOCKIST 管理の窓口と公開の取り出し（SEC-STOCKIST-009・011・013・014・018・002） | 公開 | なし |
| 8 | NEWS と HOME（SEC-NEWS-005・016、SEC-HOME-013） | 公開 | 7 |
| 9 | 最終確認と controller への報告 | 全部 | 1〜8 |
