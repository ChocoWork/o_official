# パスキー 段4（パスワードと認証アプリのログインの片付け）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** お客さんのパスワードのログイン・会員登録・パスワードの再設定と変更・認証アプリ（TOTP）の画面と窓口・それらの試験・使わなくなる DB の表と関数を消し、**フックでお客さんの `password` の拒否を有効にする**。残す入り方（メールのコード・パスキー・Google・店員の招待・アカウントの画面）が、消した後も動くことを試験で示す。文書の正本を直し、本番に当てる手順書と戻し方を段4に合わせる。**本番には何も当てず、デプロイもしない。**

**Architecture:** (1) 消す前に、残す流れの試験を足して基準にする（Task 26）。**試験の古い手助けは、最後の呼び手を直した後の Task 33 で消す**（Task 28〜32 は、各 spec の呼びだけを外す）。パスワードで JWT を取っている試験の手助けを、パスワード無しの道に替える（Task 27）。(2) 領域ごとに消す: お客さんのログイン・登録（28）、パスワードの再設定・変更（29）、TOTP・MFA・`/auth/verified`（30）、最初の店長のコマンド（31）。各タスクが、そのタスクで消す機能を調べる E2E・jest・文書の追跡の項目を、同じコミットで消すか書き直す。(3) 新しい移行は2本: J（フックの旗 `reject_customer_password` を真にする）と K（使わない表と関数を消す）。どちらも**本番の独自のドメインが決まるまで当てない**（A〜I と同じ。当てる順は A〜I の後、J・K の順）。(4) 残りの片付け（33）、正本の文書（34）、手順書と戻し方（35）、最終の確かめ（36）。

**Tech Stack:** Next.js App Router、`@supabase/supabase-js` 2.119.0（固定）、Postgres 17（手元の Supabase）、Jest、Playwright（本番ビルド・3幅）、`tsx`。

**Spec:** [docs/superpowers/specs/2026-11-07-passkey-auth-design.md](../specs/2026-11-07-passkey-auth-design.md)（4-2 の段4の行、4-2 の :140 と :192 〔お客さんの `password` の拒否を段4まで待つ理由〕、7 の「消すもの・残すもの」、8-1、12-2 の17）。ADR-0469 の「段4で消す一覧」と「旧画面の退避」。作業と指摘の台帳 `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md` の「段4へ」（:564）と 1-3「skip の一覧」。前の計画は [段3b](2026-11-19-passkey-stage3b-staff-ops.md)。段3b の最終レビュー `.superpowers/sdd/2026-11-19-passkey-stage3b-staff-ops/final-review.md`（持ち越し M-2・M-3・M-4・M-6）。ブランドは `docs/01_Planning/brand.md`（CLAUDE.md の `docs/1_RequirementsDifinition/brand.md` は無い）。

## 分け方と番号

3b の Task 25 の続きとして **Task 26〜36（11本。上限の14本の内）**。分割は要らない。ただし Task 28 と 29 が大きいので、実行者は「消す物の一覧」を最初に報告へ貼ってから消す。

| Task | 中身 | 新しい移行 |
| --- | --- | --- |
| 26 | 消す前の基準: 残す流れの試験と、パスワードで作ったアカウントがメールのコードで入れることの試験 | 無し |
| 27 | パスワードで JWT を取っている試験の手助けを、パスワード無しの道に替える | 無し |
| 28 | お客さんのパスワードのログイン・会員登録・確認メールの窓口を消す | 無し |
| 29 | パスワードの再設定・変更を消す | 無し |
| 30 | TOTP・MFA の窓口と `/auth/verified`・MFA のやり直しの窓口を消す | 無し |
| 31 | 最初の店長のコマンド `admin:bootstrap` を消す（オーナーの答え2が A の時） | 無し |
| 32 | 移行 J（フックの旗）・K（表と関数を消す）と、フックの試験の反転 | J・K |
| 33 | 残りの掃き出し（部品の縮小・設定・参照の0件の確かめ） | 無し |
| 34 | 正本の文書と追跡の廃止の仕上げ | 無し |
| 35 | 手順書・戻し方・最初の店長の手順書の直し | 無し |
| 36 | 最終の確かめ | 無し |

パスキーの移行は **11本（A〜K）** になる。J・K は A〜I の**後**に、**本番の独自のドメインが決まってから**、オーナーの許可を得て当てる（調整役。Task 35 の手順書）。

## 試験の古い手助けを、どのタスクで直し・消すか

Task 28 で手助けを消すと、後のタスクで直す spec が import できず、typecheck と Playwright の読み込みが落ちる（`tsconfig.json` は `**/*.ts` を含む）。そのため、**手助けを消すのは、最後の呼び手を直した後の Task 33**にする。Task 28〜32 は、自分が直す spec から古い手助けの呼びを外す（消すか、`loginAsMember` に替える）だけで、手助けの定義は消さない。

| 手助け | 呼ぶ spec（直すタスク） | 消すタスク |
| --- | --- | --- |
| `loginAsMemberLegacy`（`member-session-helpers.ts`） | `FR-LOGIN-030`（28・30）、`031`（28・29・30・32 に分ける）、`032`・`033`（30）、`FR-PWRESET-010`・`FR-ACCOUNT-046`（29）、`FR-ADMIN-MISC-008`（31）。**この手助けは中身が古い窓口（`login/resend`・`otp/verify`）を叩くので、Task 28 で中身を `loginAsMember`（メールのコード）に付け替える（名前・引数は残す）。窓口が消えた後も、この5本は自分のタスクで消す・直すまで緑のまま** | 33（別名ごと消す） |
| `setLoginTwoFactorCookie`・`auth-2fa-test-utils.ts` | `FR-LOGIN-001`・`006`・`008`・`026`・`027`・`028`・`034`・`036`・`055`・`056`、`FR-CHECKOUT-012`、`login-otp-resend-errors`（`026` は 28 と 29 の両方に再設定の分があるので、**28 で呼びを外し、29 で再設定の分を消す**） | 33 |
| `createTestMember` の `password` | `FR-LOGIN-031`・`040`・`078`・`081` は、パスワード付きの会員を**自分の spec の中で** `createUser({ password, email_confirm: true })` で作る（拒否・基準の確かめ専用）。ほかは `password` を使わない | 33 |
| `registerUser`・`loginUser`（`helpers.ts`） | 使う spec は0本（確認済み）。呼び手を grep で0件にしてから消す | 33 |
| `loginAndOpenAccount`（`account-test-utils.ts`） | 残す（16本の `FR-ACCOUNT-*` が使う）。中身を `/login/password` から `loginAsMember` へ付け替える | 28 |

**同じタスクで直す決まり**: ある AC を廃止にするタスクは、その AC の名前をテスト名に持つ spec を、同じコミットで直す。ある窓口を消すタスクは、その窓口を叩く spec を、同じコミットで直す。

**緑を保つ決め**: Task 28〜31 のどのコミットでも、その時点で残っている spec は緑にする。上の別名がその手段で、「既知の赤」を作らない。付け替えた後、5本が使う場面（会員でログインして画面を開く）が、メールのコード経由でも成り立つかを、実行者が Task 28 の Step 4 で5本を流して確かめる（成り立たない呼びは、その spec を自分のタスクを待たず Task 28 で消し、AC の廃止も同じコミットに移す）。**成り立たない見込みが高い2本の決め**: (1) `FR-ADMIN-MISC-008` は最初の店長（店員）でログインするが、メールのコードは店員を `staff_passkey_required` で断る。**問2が A でも B でも通る道**: Task 28 で、008 の skip でない定義のログインの部分を `createAdminSessionActor`（パスキー）に付け替える（別名の `loginAsMember` は使わない）。そのうえで、A なら Task 31 で消し、B なら Task 31 で DB の確かめ（利用者・役割・TOTP の要素が無いこと）に書き直す。Task 28 では消さない。(2) `FR-ACCOUNT-046` は同じ会員で20回近くログインするので、メールのコードのメール単位の回数の枠に当たるおそれがある。まず、定義ごとに別の会員（`createTestMember` の別のラベル）にして流す。それでも当たるなら、Task 28 で spec ごと消し、`FR-AUTH-006`・`SEC-AUTH-034` の AC の廃止も Task 28 に移し、報告に書く（Task 29 の消す物から外す）。


## 答えの関所（オーナーの答えを、どのタスクの前に揃えるか）

調整役は、次の答えを得てから、実行者にタスクを渡す。実行者が途中で止まると、確認の窓口は消したのに雛形はそのまま、という半端なコミットになるため。

| タスクの前に要る答え | 問い | 揃っていない時 |
| --- | --- | --- |
| Task 28（と26の測り方） | 問1（確認前の登録の扱い）・問3（見た目の約束）・問5（確認メールと画面の1文。**文そのものを含めて**決める） | **Task 28 を渡さない**。Task 26・27 だけ先に進めてよい（26 は問1の D の実測を含む） |
| Task 31 | 問2（`admin:bootstrap`）・問6（`package.json`） | おすすめの A（問2）・B（問6）で進めてよい |
| Task 32 | 問4（K を当てる時期。K の置き場も決まる） | おすすめの B（K は `supabase/pending-passkey-stage4/` に置く）で進めてよい |

**組み合わせの決め**: 問1が A（確認のリンクの入口を消す）なら、問5は A（確認メールにも8桁の数字を入れる）にする。問5を「ログイン画面からメールのコードでお入りください」と案内するだけの文にしない（確認がまだの人に届くのは確認のメールで、数字が無いと、頼むたびに同じメールが届き、入れなくなる＝行き止まり）。問1が B（リンクを残す）の時だけ、問5は B（今のまま）を選べる。調整役は、答えを受けた時にこの組み合わせを確かめる。**問1の「メールでの新規登録の入口を閉じる」案（旧 D）は、全員のメールのコードのログインも止める見込みが高いので採らない**（Task 26 (d) で記録だけ取る）。


## 作り手の判断（違えばオーナーが直す。末尾の「オーナーに聞くこと」に重要な物を再掲）

1. **`/auth/verified` は消す**（設計 4-2・7 に従う）。台帳の「段4へ」・ADR-0469 の一覧には載っていないが、設計 7 の「消す」の行にある。今の `/auth/verified` は TOTP の画面に加え、認めた鍵が1本の店員を `/admin/passkeys?more=1` へ送る役もしているので、その行き先は `post-login` と `return-intent` の判定が直接返す形に付け替える（Task 30）。店員が入口の条件に足りない時の行き先は、今ある文 `/login?error=staff_passkey_required`（「店員の方は、パスキーでログインしてください。」）を使う。失敗の時（通信の失敗・2xx でない応答・読めない本文）の行き先は `/login`（既存の文を出す所は変えない）。新しい文は足さない。
2. **`/api/auth/me` の `mfaVerified` と `needsMfa` の名前は変えない**（設計 7: 意味は「パスキーで入った店員か」に変え済み。応答の形は保つ。約80本の E2E がこの形を偽装している）。**名前ごとの決め**: 変えない物は `mfaVerified`・`needsMfa`・`LoginContext` の `isMfaVerified`・拒否の理由 `admin_requires_privileged_aal2`・`denial.reason = 'mfa'`・403 の本文 `MFA required`（応答の形が約80本の E2E に偽装されている。拒否の理由は監査の行に残るので、過去の行と見分けられるよう変えない。作り手の判断6）。変える物は無い。ADR-0463・ADR-0468 の「段4でまとめて直す」の文は、設計と食い違うので、Task 34 で「変えない」に直す（食い違いは報告に書いた）。
3. **`/admin/create-user` は既に無い**（`src/app/admin/` に無い）。設計 7 の「消す」の行は済んでいる。台帳の skip の一覧の「`create-user`」も、試験が残っていないことを Task 36 の grep で確かめるだけ。
4. **MFA のやり直しの窓口 `/api/admin/users/mfa/reset` は消す**（設計 7 は「作り直す」と書き、段3a の `redo`〔`/api/admin/staff/[id]/redo`〕が置き換えた。画面からも呼ばれていない）。その E2E（`FR-ADMIN-MISC-003`・`001` の該当部分）は消し、`redo` の試験（FR-LOGIN-063）が代わる。
5. **店員の TOTP の要素（`auth.mfa_factors`）は、段4のコードでは消さない**。GoTrue の持ち物で、設計 6-2・8-1 は「移す時に消す」とし、H の招待・やり直しの取引が、その人の分だけ消す。残りの数と扱いは手順書（Task 35）に読むだけの SQL として書き、オーナーが当てる時に決める。
6. **監査の記録は消さない**。`audit_logs` などの表・行・列挙は触らない。消すログインの道が過去に書いた行は残す。`src/lib/audit.ts` の行為の名前の一覧に消した道の名前があっても、型から外さず（過去の行を読む画面が使う）、`@remarks` に「過去の行のために残す」と書く（法令対応は後回しの方針）。
7. **`auth_return_intents` の `purpose = 'signup'`・`create/consume` の関数は DB に残す**（表は共有で、`login` の用途が使い続ける。CHECK を変える移行は、得るものが無い）。アプリの `signup` 用の関数だけを消す（Task 28）。
8. **新しい文面は、オーナーが決めた物だけを使う**（オーナーの答え5: 確認メールの雛形と、メールのコードの画面の1文）。それ以外は既存の物だけを出す。足りなければ実行者が止まって報告する。
9. **`SEC-AUTH-015`（GoTrue を直に叩いた時のパスワードの規則・再認証・captcha）は廃止にしない**。GoTrue 自身の `/signup`・`/user` が残る間は効く規則で、`config.toml` のパスワードの長さ・`secure_password_change` も同じ理由で残す（Task 33）。`FR-LOGIN-031` の該当の試験も残す。廃止にするのは、アプリの窓口が持つ AC だけ（Task 29 が `npm run trace -- <AC>` で見分ける）。

## Global Constraints

3b の決まりを全部引き継ぐ。全タスクの要件に含まれる。

**本番の安全（オーナー決定 2026-11-16・2026-11-19・2026-11-20）**

- **段4は本番の DB・設定・ダッシュボードに何も当てず、デプロイもしない**。Supabase の MCP（`apply_migration`・`execute_sql` ほか）はサブエージェントから使わない。`supabase db push`（どの形でも）と `workflow_dispatch` は流さない。本番を読む SQL も流さない（手順書に書くだけ）。`.env*` は読まない・表示しない。`graphify update` は流さない（コミットのフックが後で流す）。graphify を使う時は、起動が止められていれば `.venv/Scripts/python.exe -m graphify query "<質問>"`。
- パスキーの移行（今 A〜I の9本。段4で J・K を足して11本）は、**本番の独自のドメインが決まるまで当てない**（オーナー決定 2026-11-19）。当てるのは調整役だけで、オーナーの許可を得た時に、1本ずつ MCP の `apply_migration`。J・K は A〜I の後。当てた後は `md5(statements[1])` をファイルの MD5 と突き合わせる（Task 35 の手順書）。
- **適用済みの本番の移行は編集しない**。J・K は新しいファイル。未適用の A〜I も、段4では**触らない**（H の M-6 は、H を直す時だけ畳む。段4は H を直さない）。移行の版は作る時の時刻で付け、最新（`20261119181323`）より後にする。
- 移行は戻せる形にする: 各ファイルの頭に `ROLLBACK`（戻す SQL）を書く。J の戻しは1行の `UPDATE`。K の戻しは、消した表・関数を作り直す文（**K を当てる前の手元の DB の最終の姿**〔締め直した権限を含む〕。作り方は Task 32。表の中身は戻らないが、中身は期限つきの確認用のハッシュだけ）。
- master への push は調整役がオーナーの許可を得て行う（実行者は push しない）。

**リポジトリ・E2E**

- master で作業し、タスクごとに1コミット。**自分が作った物だけを名前で `git add`**（`git add -A` を使わない）。`.claude/CLAUDE.md`・`package.json`・`.superpowers/`・`.codex/`・`graphify-out`・stockist の差分（`PublicStockistGrid.tsx`・`stockist-region-state.test.tsx`）は足さない・触れない。末尾に `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- **`package.json` は、手元にオーナーの未コミットの変更がある**（9行目の `"dev": "next dev --turbopack"` → `--webpack` の1か所。消す `admin:bootstrap` は6行目で、同じ差分の塊に入るので `git add -p` は使えない。対話の操作は使えない環境）。Task 31 が `admin:bootstrap` の行を消す。**実行者は `package.json` を足さない・オーナーの変更を戻さない・コミットしない**。調整役が、オーナーの答え6に従い、次の対話の無い手順（Git Bash）で、その1行の削除だけをインデックスに入れる。PowerShell のパイプは文字を壊すので使わない:
  ```bash
  S=<調整役の作業場所（scratchpad）の絶対パス>   # Git Bash の $TMP は /tmp になるので使わない
  git show HEAD:package.json | grep -v '"admin:bootstrap":' > "$S/pkg.json"
  git update-index --cacheinfo 100644,"$(git hash-object -w --no-filters "$S/pkg.json")",package.json   # core.autocrlf=true のため --no-filters
  git diff --cached package.json   # 1行の削除だけであること
  git diff package.json            # オーナーの dev の1行だけが残ること
  ```
  先にオーナーが `--webpack` をコミットするなら、その後に通常どおり足す（答え6）。**順番**: 調整役が上の `update-index` → `git diff --cached` で1行だけと確かめる → 実行者のコミット（`git add` は名前で、`package.json` は足さない）にそのまま入る。逆の順だと別のコミットが要る。
- E2E は本番ビルド（`next build && next start`）・390・768・1280 の3幅。dev サーバーでは流さない。`retries` を上げない。流す前に3000番のアプリを止める（`Get-NetTCPConnection -LocalPort 3000 -State Listen`）。**E2E の全件・push 前の確かめは調整役だけ**。手元の DB 結合は、実行者が1人ずつ `npx.cmd supabase db reset` の後に流してよい。
- E2E と DB 結合は手元の Supabase（`npm run db:start`・`npm run db:reset`）に対して流す。
- **最後の全件の E2E の前に `npm run db:reset` を流す**（3b の最終レビュー M-2: E2E が作る店長が手元の DB に溜まるため。Task 36）。
- 試験を足す・消す・名前を変えるタスクは `npm.cmd run trace:report` を流し、台帳の状態欄をそのタスクのコミットで直す。
- 落ちたら「単独の再実行 → 他の幅 → `goto` のタイムアウトかアサーションか」の順で切り分ける。全件の赤は、比べる元（3b の全体の確かめ `.superpowers/sdd/2026-11-19-passkey-stage3b-staff-ops/e2e-task25-full.json`）と比べる。**消した試験の分だけ減る。件数でなく、テスト名の一覧の差（`npm run trace:compare-e2e` か JSON の差）で比べ、消えた名前が消した定義と一致することを確かめる**（3幅で回さない spec もあるため）。
- モデル: 書き手は Sonnet、レビューは Opus（effort high）。
- **消すものは「残る呼び手が0」を確かめてから消す**: 消す前に、`graphify query` と `grep -rn` で、その単位の呼び手が消す物の中だけであることを確かめ、結果を報告に貼る。他の呼び手が残る物は消さず、縮める。

**追跡と文書（範囲内の領域 AUTH・ADMIN）**

- 要求・要件・受け入れ条件は `docs/02_Requirements/areas/auth.md`（ADMIN の物は `admin.md`）、基本設計は `docs/03_BasicDesign/areas/auth.md`、設計判断は `docs/03_BasicDesign/decisions/ADR-NNNN-<slug>.md`、脅威は `docs/05_Quality/security/threats/auth.md`、処理の詳細は `docs/04_DetailDesign/sequence/auth-*.md`。コードには TSDoc の `@impl`・`@design`。書式は `documentation-guide` スキル。
- **追跡の鎖**: 公開した単位ごとに IMPL を1つ。DD の親は構造設計か SEC。SEC の親は THR。ADR には構造設計の子が要る。AC には E2E か単体の試験が要る。
- **消した単位の追跡の項目は、黙って消さず「廃止」にする**（documentation-guide の決まり）。書き方:
  1. 消す単位の `IMPL-`・`DD-`・`API-`・`SCR-`・`FR-`・`SR-`・`SEC-`・`THR-`・AC の「状態」を `廃止` に直し、中身は残す（番号は使い回さない）。**下から上の順**（試験 → AC → IMPL → DD → 構造設計 → 要件）で直す。
  2. 廃止の項目を指している項目は `retired-reference` で落ちる。指している側（子・上位・「関連」）を同じコミットで直す。まだ生きている物が廃止の物を上位に持つなら、上位を生きている物へ付け替える。
  3. コードから `@impl`・`@design` が消えるので、`missing-impl` の逆（定義だけ残る）は `廃止` にして通す。
  4. `docs/05_Quality/reports/` は `npm run trace:report` で作り直す。手で直さない。
  5. 「廃止」にした物が、残る物の根拠として必要なら（例: SR-AUTH-014 の説明に残る一文）、文を直す。
  6. **構造設計（`DATA-`・`ARC-`・`API-`・`SCR-`）の扱い**: DD を廃止にする前に、その上位の構造設計を `npm run trace -- <ID>` で見る。下の DD が全部廃止になる（かつ結合テストも全部消える）なら、その構造設計も**同じタスクで**廃止にする。上位の ADR・SEC が廃止になる時も同じ。生き続ける中身があるなら、生きた DD と結合テストに付け替える。これを後のタスクへ回すと、間のコミットで `missing-child` か `retired-reference` の新しい鍵が出る。
- **コミットの前に** `npm.cmd run validate-trace`・`npm.cmd run test:trace-coverage`・`npm.cmd run validate-docs`。**`validate-trace` の合否は「終了コード0（`scripts/trace/baseline.json` に無い違反の鍵が0件）」**。比べるのは件数でなく違反の鍵の集合なので、合計が97より減っていても、新しい鍵が1つ出れば落ちる。消す spec に付いていた基準の鍵（18件）と、廃止にした AC の `missing-child` は、基準より減る。**減った分は、各タスクの終わりに調整役が許可を得て `npm.cmd run validate-trace -- --update-baseline` で基準を更新する**（次のタスクの新しい鍵が、減った分に紛れないため）。届かない分岐は `test-gaps.md` の節に書く。
- **コマンド（各タスク共通）**: 単体 `npx.cmd jest <パス>`、型 `npm.cmd run typecheck`、`npm.cmd run lint`、E2E `npx.cmd playwright test e2e/<spec> --project=<名前>` ではなく3幅を含む通常の流し方（`npx.cmd playwright test e2e/FR-LOGIN-080`）、DB 結合 `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx.cmd jest tests/integration/db/<file> --runInBand`（`db reset` の後）。
- **旗（`reject_customer_password`）を切り替える試験は、DB 全体に効くので `isolated-global`（直列）の project に入れる**（`FR-LOGIN-062`・`071`・`077` と同じ。`playwright.config.ts` の `testIgnore` と `testMatch` の両方）。対象は `FR-LOGIN-078` の AC-03、`081`。普通の project の spec は、旗を触らない。
- **廃止の手順への追加（最後の試験が消える AC）**: テストを消す・書き直す前に `npm run trace -- <AC>` で子のテストを数える。**最後の1本が消えるなら、その AC を廃止にするか、残す spec に名乗らせ直す**。生きたまま子が0になる AC は、新しい `missing-child` の鍵になる。移す試験（`FR-LOGIN-079`）の名前には、移した AC の ID を必ず付ける（付けないと `untagged-test`）。
- **番号の予約**（着手時に `grep` で空きを確かめる。2026-11-20 の実測の最大は SR-AUTH-029、FR-AUTH-052、API-AUTH-038、DD-AUTH-091、IMPL-AUTH-425、SEC-AUTH-059、THR-AUTH-057、DATA-AUTH-022、SCR-AUTH-016、ARC-AUTH-014、FLOW-AUTH-005、STATE-AUTH-006、ADR-0474、FR-LOGIN-077。ADR-0480 は別の領域が持つので避ける）:
  `SR-AUTH-030`、`FR-AUTH-053`〜`055`、`DD-AUTH-092`〜`093`（093 は予備）、`IMPL-AUTH-426`〜`428`（予備。新しい TS の単位が無ければ使わない）、`SEC-AUTH-060`〜`061`、`THR-AUTH-058`〜`059`、`ARC-AUTH-015`、`ADR-0475`〜`0476`、E2E は `e2e/FR-LOGIN-078`〜`082`（082 は予備）。`API-AUTH-039`・`DATA-AUTH-023`・`FR-AUTH-056`〜`058` は**予約しない**（作らない。下の親の決めを参照）。
- **親の決め**（`scripts/trace/rules.ts` の「下に要る物」を満たす形）: DD には**単体テストと、`@design` を持つ TS のコードの単位**が要る。AC には **E2E** が要る。SEC の子は AC でよい。構造設計には結合テストと DD が要る。SQL の移行・文書だけの物には DD・IMPL を作らない。
  - `SR-AUTH-030`（パスワードと認証アプリのログインの廃止）← `FR-AUTH-053`（消した窓口・画面が404。AC は `FR-LOGIN-080` が確かめる）・`054`（残す流れが動く。AC は `FR-LOGIN-078`・`079`）・`055`（フックがお客さんの password を拒否。AC は `FR-LOGIN-081`）。試験の手助け（Task 27）は製品の要件でないので ID を作らず、範囲の外の DB 結合（`customer_session_helper.integration.test.ts`。`auth_` で始めない名前）で確かめる。
  - `THR-AUTH-058`（GoTrue を直に叩くパスワードのログインが残る）→ `SEC-AUTH-060`。AC は `SEC-AUTH-060-AC-01`（お客さんの `password` が `[customer-password-disabled]` で拒否される）・`-AC-02`（ほかの方式は通る）で、`FR-LOGIN-081` が名乗る。DB 結合 `auth_passkey_stage4_migrations.integration.test.ts` のテスト名は、既存の `DATA-AUTH-013`（フックの関数）を名乗る。J・K の SQL に DD・IMPL は作らない。
  - `THR-AUTH-059`（消した窓口へのリンクと戻り先が残る）→ `SEC-AUTH-061`。AC は `SEC-AUTH-061-AC-01`（消した画面・窓口に着地しない。`FR-LOGIN-080` が名乗る）。**`THR-AUTH-059`・`SEC-AUTH-061`・`SEC-AUTH-061-AC-01` は Task 28 で作る**（080 を作るタスクのため）。DD は**新しく作らず**、既存の `DD-AUTH-060`（`post-login.ts` の行き先）の上位に `SEC-AUTH-061` と `ARC-AUTH-015` を足す（`@design` は1単位に1つだけで、付け足すと `bad-design-link` になるため。`DD-AUTH-092` は予備のまま使わない）。`return-intent-service.ts` の `@design DD-AUTH-034` は変えない。単体テストは `tests/unit/features/auth/passkey/post-login.test.ts`。
  - `ARC-AUTH-015`（行き先と、消した窓口・画面の構成）は **Task 30 で作る**。上位は `SEC-AUTH-061` と `ADR-0475`（構造設計の上位には要件・SEC・DRV のどれかが要る）。`ADR-0475`（`/auth/verified` を消し、行き先を判定が返す）も Task 30 で作る。**Task 32 で**、`ARC-AUTH-015` の上位に `ADR-0476` を足し、`ADR-0476`（旗を真にする J と、表を消す K を分ける）を作る。`ADR-0476` の上位は `SEC-AUTH-060`（`THR-AUTH-058`・`SEC-AUTH-060` も Task 32 で作る）。**`ARC-AUTH-015` を名乗る結合テスト**は `tests/integration/api/auth/post-login.test.ts`（行き先の分。Task 30 の Files）。`ARC-AUTH-015` の DD の子は `DD-AUTH-060`。
- 追跡の範囲: `scripts/trace/scope.json` の AUTH は `src/app/auth/**`・`src/app/api/auth/**`・`src/features/auth/services/password-change.ts` などを名指しする。**消した物をここから外し（`password-change` の2行など）**、外すたびに `validate-trace` と `test:trace-coverage` を流す。新しい名前が外れる時は足す。

**文面（お客さん・店員に見える物）**

- 丁寧語で短く、断定せず、煽らない。「頁」は使わず「ページ」。絵文字・感嘆符を使わない。専門語（WebAuthn・UV・認証器・TOTP）を画面とメールに出さない。ブランドは `docs/01_Planning/brand.md`。
- 段4は新しい文を作らない（作り手の判断8）。出てくる既存の文を変えない。
- 監査・ログ・メールに、合言葉・リンクの全文・鍵・宛先のアドレスの列を残さない。

## Review Focus

先頭ほど起きやすい。

1. **消した後に、残す流れが動くか**: メールのコード（パスワードで作ったアカウントを含む）・パスキー・Google・店員の招待と登録・アカウントの画面（鍵の一覧）が、3幅で通るか。消す前の基準（Task 26）と同じ件数で通るか。
2. **消した物が本当に無いか**: 消した窓口が404（`/api/auth/login` など）、消した画面が404（`/login/password` など）で、どこからもリンクが残らないか。リンクの元（`Header`・`LoginContext`・戻り先・メール・文書）を grep で0件にしたか。
3. **お客さんの `password` をフックが拒否するか**: 手元の GoTrue へ直に `grant_type=password` を投げて拒否され（拒否の印 `[customer-password-disabled]`）、メールのコード・Google・パスキー・更新は通るか。店員の拒否（`[staff-...]`）の印とは混ざらないか。旗を偽に戻すと、元に戻るか。
4. **パスワードで JWT を取っていた試験が、旗を真にしても通るか**（Task 27 の替え方が、旗を真にした後の Task 32 で効くか）。
5. **戻せるか**: J・K に `ROLLBACK` があり、戻しの順（K → J → 古いアプリ）が手順書にあり、古いアプリ（`c336e0b5`）に戻した時にお客さんがパスワードで入れるか。
6. **追跡**: 廃止にした項目を指す物が残らないか。最後の試験が消えて子が0になる AC が残らないか。`validate-trace` が終了コード0か（基準に無い鍵が0件）。
7. **監査の行・表を消していないか**。

---

## ファイルの全体図

| 区分 | ファイル | タスク |
| --- | --- | --- |
| 作る | `e2e/FR-LOGIN-078-legacy-account-email-code-login.spec.ts`（基準。旗を切り替える AC-03 は `isolated-global`）、`e2e/FR-LOGIN-079-login-screens-layout.spec.ts`（画面の見た目の移し先。オーナーの答え3が A の時）、`e2e/FR-LOGIN-080-removed-auth-entries-gone.spec.ts`（消した窓口・画面が404）、`e2e/FR-LOGIN-081-customer-password-rejected.spec.ts`（旗を真にした後） | 26・28・32 |
| 作る | `e2e/customer-session-test-utils.ts`（パスワード無しで会員の JWT を取る手助け） | 27 |
| 作る | `supabase/migrations/<時刻>_passkey_reject_customer_password.sql`（J）、`<時刻>_drop_password_auth_objects.sql`（K） | 32 |
| 作る | `docs/03_BasicDesign/decisions/ADR-0475-*.md`・`ADR-0476-*.md` | 30・32 |
| 消す（フォルダごと） | `src/app/login/password/`・`src/app/login/verify/`、`src/app/auth/password-reset/`、`src/app/auth/verified/`、`src/app/account/password/`、`src/app/api/auth/{login,otp,register,confirm,mfa,password,password-reset}/`、`src/app/api/admin/users/mfa/` | 28〜30 |
| 消す（ファイル） | `src/components/{AuthTabs,LoginModal,RegisterModal,AuthResultScreen}.tsx`、`src/features/auth/services/{login-2fa-session,password-change,password-reset-session}.ts`（`register.ts` は縮めるだけ）、`schemas/{login,otp,register,password-change,password-reset}.ts`、`src/lib/pwned-password.ts`、`scripts/admin/bootstrap*.ts` | 28〜31 |
| 縮める（呼び手が残る） | `src/contexts/LoginContext.tsx`、`src/app/login/page.tsx`、`src/components/Header.tsx`、`src/contexts/Providers.tsx`、`src/features/auth/services/register.ts`・`session.ts`、`schemas/common.ts`、`src/lib/cookie.ts`、`src/lib/auth/service-role-auth-client.ts`、`src/features/auth/return-intent/*`、`src/app/api/auth/{me,post-login,oauth/callback}/route.ts`、`src/lib/audit.ts`（注釈だけ） | 28〜33 |
| 直す | E2E の手助け `e2e/{member-session-helpers,account-test-utils,helpers,home-grant-test-utils,news-test-utils,passkey-hook-scenarios}.ts`、`auth-2fa-test-utils.ts`（消す） | 27〜30・32 |
| 直す | `supabase/config.toml`（手元の TOTP を止める）、`docs/06_Operations/{passkey-production-apply-runbook,passkey-staff-recovery,first-admin-bootstrap,supabase-auth-config,db-migrations}.md` | 31〜35 |
| 直す | 台帳、`docs/02_Requirements/areas/{auth,admin}.md`、`docs/03_BasicDesign/areas/{auth,admin}.md`、`api/{api-spec,route-inventory}.md`、`ui/{screen-list,screen-flow}.md`、`architecture/system-overview.md`、`docs/04_DetailDesign/pages/{14_login,16-2_admin_misc}.md`、`docs/04_DetailDesign/sequence/auth-*.md`、ADR（0400〜0405・0409・0410・0413・0418・0421・0457・0461・0463 の状態）、`docs/05_Quality/tests/test-spec.md`、`src/features/auth/design.md`、`scripts/trace/{scope,baseline}.json` | 各タスク・34 |

---

## 消す物の一覧と、残す物の理由

実行者は、各タスクの最初に `graphify query` と `grep -rn` で呼び手を確かめ、一覧を報告へ貼る。次は計画の時に確かめた結果（2026-11-20）。

### 窓口と画面

| 物 | 判断 | 理由・呼び手 | タスク |
| --- | --- | --- | --- |
| `/login/password`（`src/app/login/password/page.tsx`） | 消す | ADR-0469。リンク元は旧の流れの中だけ | 28 |
| `/login/verify`（`page.tsx`・`VerifyOtpClient.tsx`） | 消す | 旧の2段目 | 28 |
| `/api/auth/login`・`login/resend`・`login/cancel`・`/api/auth/otp/verify`・`/api/auth/register` | 消す | パスワードのログイン・登録の窓口。`/login/page.tsx` と `LoginContext` が呼ぶ分は縮める | 28 |
| `/api/auth/confirm`（会員登録の確認メールのリンク） | 消す（オーナーの答え1が A の時。B なら残す） | パスワード登録が無くなると、確認のメールの送り元が無い。本番に確認前のパスワード登録が残っていれば、手順書で読んで消す（Task 35） | 28 |
| `AuthTabs`・`LoginModal`・`RegisterModal`・`AuthResultScreen`（と `AuthResultScreen.css`） | 消す | `AuthResultScreen` の呼び手は消す `password-reset/page.tsx` だけ。`Header.tsx` の `LoginModal` は `loginOpen` を立てる所が無いことを確かめて外す | 28・29 |
| `src/contexts/Providers.tsx` の `isAuthPage` の `/login/verify`・`/login/password` | 縮める | `/login/code`・`/login/passkey` は残す | 28 |
| `/auth/password-reset`（`page.tsx`・`verify/page.tsx`・`verify/VerifyClient.tsx`）、`/api/auth/password-reset/{request,link,confirm,session}` | 消す | 設計 7。パスワードが無い | 29 |
| `scripts/verify-register.js`（と `verify-register.md`） | 消す | `/api/auth/register` を叩く手動の確かめ。呼び手が0であることを確かめてから | 28 |
| `src/lib/ops/site-url-alert.ts` と `ops-alert-mail.ts` の `siteUrlInvalidMail` | 縮める（呼び手が `register`・`password-reset/request` だけなら消す。文は「パスワードの再設定と会員登録のメール」） | `src/lib/site-url-guard.ts` 自体は招待・知らせ・注文のメールが使い続けるので残す | 29 |
| `/account/password`（`page.tsx`・`PasswordChangeForm.tsx`）、`/api/auth/password/change/{start,confirm}` | 消す | 設計 7。アカウントの画面からのリンクは段2で外し済み | 29 |
| `/api/auth/mfa/{enroll-totp,status,verify}`、`/auth/verified` | 消す | 設計 4-2・7。`enroll-totp` は店員向けが既に410 | 30 |
| `/api/admin/users/mfa/reset` | 消す | `redo` が置き換えた（作り手の判断4） | 30 |
| `scripts/admin/bootstrap*.ts`・`npm run admin:bootstrap` | 消す（オーナーの答え2が A の時） | パスワード＋TOTP の最初の店長を作る物。段4のアプリでは入れない | 31 |
| `/api/auth/{logout,me,refresh,post-login,oauth/*,passkey/*,email-code/*,staff/*}`、`/login`・`/login/code`・`/login/passkey`、`/admin/passkeys` | 残す | 残る流れ | - |

### サービス・部品・設定

| 物 | 判断 | 理由 | タスク |
| --- | --- | --- | --- |
| `services/login-2fa-session.ts` | 消す（先に `email-code-session.ts`・`status-session.ts`・`cookie.ts` が使う共通部分を切り出す） | 呼び手が残る（`email-code-session.ts` と `lib/orders/status/status-session.ts`）。署名の部品だけが共有なら、その部品を `email-code-session.ts` 側へ移して旧の保留の関数を消す | 28 |
| `services/password-change.ts`・`password-reset-session.ts`、`schemas/{password-change,password-reset}.ts`、`lib/pwned-password.ts` | 消す | 呼び手は消す窓口だけ | 29 |
| `services/register.ts` | 縮める（`persistSessionAndCookies` などは `email-code/verify`・`oauth/callback`・`passkey/login/finish`・`staff/invite/start` が使う） | 呼び手が残る | 28 |
| `services/auth-admin-user.ts` | 縮める | `admin/staff/invites`・`admin/orders/[id]/history` が使う | 28・29 |
| `services/session.ts`・`lib/hash.ts`・`lib/auth/authenticate.ts` | 残す（`session.ts` から `mfa/verify` 専用の分があれば縮める） | `refresh`・`logout`・多数の窓口が使う | 30 |
| `schemas/common.ts` の `passwordSchema` | 消す（`emailSchema` は残す） | 設計 7。呼び手は消す窓口だけ | 29 |
| `schemas/{login,otp,register}.ts` | `otp.ts` は残す（`email-code/verify` が使う）。`login.ts`・`register.ts` は消す | `LoginContext` の呼びを先に外す | 28 |
| `lib/cookie.ts` の旧の保留・再設定の Cookie の名前 | 消す | 呼び手が無くなる | 33 |
| `lib/auth/service-role-auth-client.ts` の `signInWithPassword`・`signUp` | 型と実体から外す（`signInWithOtp`・`resend` は残る） | `email-code/start`・`resend` が使うのは2つだけ | 33 |
| `lib/auth/amr.ts` の `totp`・`lib/auth/app-session.ts` の `mfa.verify` の記述 | 縮める | TOTP の確認が無くなる | 30 |
| `src/lib/auth-no-store-policy.ts`・`src/proxy.ts` の `mfa/*`・`login` の記述 | 縮める | 道筋の一覧から消した窓口を外す | 33 |
| `src/features/auth/return-intent/*` の `signup` の用途 | 消す（DB の CHECK は残す。作り手の判断7） | `confirm`・`register` だけが使う | 28 |
| `supabase/config.toml` の `[auth.mfa.totp]` | 手元で止める（`enroll_enabled = false`・`verify_enabled = false`）。本番はダッシュボード（手順書） | 設計 6-2 | 30 |
| `supabase/config.toml` の `[auth.email.notification.password_changed]`・`secure_password_change`・パスワードの長さ | 残す | GoTrue 自身の入口（`/recover`・`/signup`）が残るため。無害（フックが拒否）。Task 33 で理由を書く | 33 |
| `src/lib/audit.ts` の行為の名前 | 残す（注釈だけ） | 作り手の判断6 | 33 |

### DB の物（新しい移行が要るか）

| 物 | 判断 | 本番の状態 | 移行 |
| --- | --- | --- | --- |
| フックの旗 `private.passkey_staff_config.reject_customer_password`（A の表。初めは偽） | **真にする** | A を当てた後（A は未適用） | **J**（`UPDATE`・戻しは偽に戻す。A を直さない。理由: A は未適用だが、旗の既定は「段1〜3 は通す」の設計の決め。段4の切り替えは独立した移行にして、戻しを1行にする） |
| フック関数 `public.passkey_access_token_hook` | 触らない | B（未適用） | 無し（`reject_customer_password` を読む分岐が既にある。試験で確かめる） |
| `public.password_reset_tokens`（表・索引3・RLS3・権限）と `public.cleanup_password_reset_tokens(integer)` | 消す | 本番にある（`20260901102912_remote_schema.sql`）。呼び手は消す `password-reset` の窓口だけ（`vercel.json`・cron に無いことを Task 32 で再確認） | **K** |
| `public.password_change_challenges`（表・RLS・権限）と `public.issue_password_change_challenge`・`public.consume_password_change_challenge` | 消す | 本番にある（2026-11-01 に適用済み。ADR-0421） | **K** |
| `private.auth_return_intents`（`purpose in ('login','signup')`）と `public.create_auth_return_intent`・`consume_*` | 残す | 本番にある | 無し（作り手の判断7。`login` の用途が使う） |
| `rate_limit_counters` | 残す | 共有 | 無し |
| `audit_logs` ほか監査の表・行 | **消さない** | 本番にある | 無し（作り手の判断6） |
| `auth.mfa_factors`（GoTrue の表） | 触らない | 本番にある | 無し（作り手の判断5） |
| 関数・RLS が `aal2`・`aal` を読む物 | 触らない | `has_permission` は E（未適用）が置き換える。ほかに `aal2` を読む関数・方針は、段4の変更ではない。Task 33 で `grep -rn "aal2" supabase/migrations` を取り、**パスワード・TOTP だけの道に属する物が無い**ことを確かめて報告する | 無し |

---

## E2E の対応（1つの spec に1行。消す・書き直す・残す）

「消す」は spec ごと。「書き直す」は、残す流れ・消した物の404・旗を真にした後の拒否へ中身を替え、skip にしない。定義の数は3幅の繰り返しの前の数。

| spec | 試験の中身（要点） | 処置 | タスク |
| --- | --- | --- | --- |
| `FR-LOGIN-001-otp-turnstile` | パスワード＋コードのログイン | 消す | 28 |
| `FR-LOGIN-002-google-oauth` | Google の入口 | 残す（`/login` だけ。回帰に流す） | - |
| `FR-LOGIN-003-password-reset-link` | `/login/password` の再設定のリンク | 消す | 29 |
| `FR-LOGIN-005-metadata` | `/login` の metadata | 残す | - |
| `FR-LOGIN-006-otp-resend-countdown` | 旧の2段目の再送 | 消す | 28 |
| `FR-LOGIN-008-password-otp-2fa` | パスワード＋コードの2段 | 消す | 28 |
| `FR-LOGIN-009-auth-tabs`・`011`・`012`・`014`・`015`・`016`・`019`・`020`・`021`・`022`・`029` | `/login/password` のタブ・色・揃え・下線・階層 | 消す（画面ごと）。ただし「1画面に収まる・真ん中寄せ・階層」の AC は新しい `/login`・`/login/code` に移す（オーナーの答え3が A の時。`FR-LOGIN-079`。B の時は AC を廃止） | 28 |
| `FR-LOGIN-013-password-reset-link-placement` | 再設定のリンクの置き場所 | 消す | 29 |
| `FR-LOGIN-017-iphone-se-one-screen` | `/login/password` が1画面 | 消す。`/login` の1画面は 079 へ移す | 28 |
| `FR-LOGIN-018-verified-brand-design` | `/auth/verified` の見た目（5） | 消す | 30 |
| `FR-LOGIN-023-auth-viewport-centering`・`025-turnstile-width-fit`・`026-turnstile-token-single-use` | `/login/password` と `/auth/password-reset` の真ん中寄せ・Turnstile の幅・1回きり | 消す（`/login` の Turnstile は FR-LOGIN-057・055 が持つ。無ければ 079 へ移す） | 28・29 |
| `FR-LOGIN-024-register-no-account-enumeration` | `/api/auth/register` の列挙 | 消す（メールのコードの列挙の確かめは FR-LOGIN-055 が持つ） | 28 |
| `FR-LOGIN-027-otp-dedicated-screen`・`028-otp-verify-hardening`・`034-otp-verify-screen-entry-and-expiry`・`036-otp-verify-and-resend-pending-cookie`・`login-otp-resend-errors` | 旧の `/login/verify`・`otp/verify`・`login/resend` | 消す | 28 |
| `FR-LOGIN-030-session-cookies-and-responses`（7） | `login`・`otp/verify`・`mfa/*` と、`logout`・`me`・`refresh`・`/auth/callback` の Cookie・応答 | 書き直す: `login`・`otp/verify`・`mfa/*` の試験を消し、`logout`・`me`・`refresh`・`callback` は `loginAsMember`（メールのコード）で通す | 28・30 |
| `FR-LOGIN-031-supabase-direct-bypass`（19） | GoTrue を直に叩く道と窓口。`SEC-AUTH-015-AC-01〜05`・`SEC-AUTH-035-AC-01/02`（`/api/auth/login`・`register`）・`SEC-AUTH-031-AC-02`（`mfa/enroll-totp`）・`SEC-AUTH-011-AC-01`（`password_reset_tokens`） | **タスクで分けて直す**: 28 で `login`・`register` を叩く試験（`SEC-AUTH-035`）と `loginAsMemberLegacy` の呼びを消す。29 で再設定・変更の窓口を叩く分を消す（`SEC-AUTH-015` は GoTrue の直叩きの規則なので**廃止にせず残す**。作り手の判断9）。30 で `mfa/enroll-totp` の `SEC-AUTH-031-AC-02` を消す。32 で `grant_type=password` の「お客さんは通る」を「拒否される（`[customer-password-disabled]`）」に反転し、`SEC-AUTH-011-AC-01`（K で消す表）を書き直す。パスワード付きの会員は spec の中で作る。| 28・29・30・32 |
| `FR-LOGIN-032-admin-totp-aal2`（15。skip 6） | skip 6件は TOTP の確認・登録の窓口。通る3件（`FR-LOGIN-007-AC-02`・`FREQ-316-REQ-01-AC-01`・`REQ-03-AC-01`）は店員の入口の Cookie の確かめ | 書き直す: skip の6定義と、TOTP を呼ぶ試験を消す。残す試験は `FR-LOGIN-032-staff-entry-cookie-checks.spec.ts` に名前を変える（`git mv`）。ID は変えない | 30 |
| `FR-LOGIN-033-verify-screen-and-admin-refresh-mocks`（4） | `/auth/verified` の選択・管理の更新の抑制・一般の会員 | 書き直す: 画面の分を消し、更新の抑制（`/api/auth/refresh`）の分は `refresh` が残るので残す。無ければ消す | 30 |
| `FR-LOGIN-035-login-throttling-and-turnstile`（5） | `login` の回数の制限・Turnstile・`refresh` の送り元の数 | 書き直す: `login` の分を消し、`refresh` の分は残す | 28 |
| `FR-LOGIN-037-proxy-origin-csrf`（5） | `proxy.ts` の Origin の確かめ。例に `/api/auth/password-reset/confirm` | 書き直す: 例を残る POST（`/api/auth/email-code/start`）に替える | 29 |
| `FR-LOGIN-038-login-return-to`（14） | ログイン後の戻り先。旧の `/api/auth/login`・`otp/verify`・`confirm` を使う | 書き直す: `loginAsMember` と `/api/auth/post-login`・`oauth/start` で通す。`confirm`・`login/cancel` の分は消す | 28 |
| `FR-LOGIN-039-staff-passkey-entry-conditions`（4） | 管理の入口の条件 | 残す（`/auth/verified` を使わないことを確かめる。使っていれば Task 30 で書き直す） | 30 |
| `FR-LOGIN-040-staff-hook-gotrue-rejections`（4） | フックの拒否。:83 で「お客さんの password は通る」 | 書き直す: お客さんの `password` を「拒否される」に反転し、旗を戻した時（偽）は通る分を DB 結合へ移す。`FR-LOGIN-081` と重ならないよう、081 は窓口のない確かめ（旗の J を当てた手元の DB で、拒否の印と、ほかの方式が通ること）を持つ | 32 |
| `FR-LOGIN-055-email-code-api`、`057-login-screen`、`058-email-code-screen`、`059`、`060-account-passkeys` | 残す流れ | 残す。ただし `setLoginTwoFactorCookie`・`/login/password` を使う箇所（055・057・060 の `account/password` の確かめ）は、「消した窓口・画面へのリンクが無い」の確かめに書き直す | 28・29 |
| `FR-LOGIN-056-legacy-login-relocated`（8） | 旧画面の退避 | 消す。「404になる」の確かめは `FR-LOGIN-080` に作る | 28 |
| `FR-LOGIN-069-staff-other-paths-rejected`（5） | 店員のほかの道の拒否。`/api/auth/login`・`mfa/enroll-totp` を直に叩く分がある | 書き直す: 消した窓口を直に叩く分は消し、メールのコード・Google の分は残す | 28・30 |
| `FR-LOGIN-041〜054`・`061〜068`・`070〜077` | パスキー・知らせ・店員の運用 | 残す（`grant_type=password` を使う関数の権限の試験〔047・061・074・075・076〕は Task 27 で手助けを替える） | 27 |
| `FR-PWRESET-001〜010`（10本） | パスワードの再設定の画面・窓口・実メール | すべて消す。010 は `loginAsMemberLegacy` を使う | 29 |
| `FR-SIGNUP-001`（`register route removed`）・`002`・`003` | `/login/password?tab=register`・`/api/auth/register`・確認リンク | すべて消す（オーナーの答え1が B なら 003 は残して書き直す） | 28 |
| `FR-UI-008-status-messages`（5） | 操作の結果の案内。`/auth/password-reset`・`/login/password` を使う分がある | 書き直す: 残る画面（`/login/code` の案内）に替える。替えられない分は AC を廃止 | 28・29 |
| `FR-CHECKOUT-012-account-profile-defaults`（1） | `/login/password` で入ってから確かめる | 書き直す: `loginAsMember` で入る | 28 |
| `FR-ACCOUNT-046-password-change`（17） | パスワードの変更（ledger の `FR-AUTH-006-AC-06` を含む） | 消す | 29 |
| `FR-ACCOUNT-001〜029`（`loginAndOpenAccount` を使う16本） | アカウントの画面 | 残す（手助け `account-test-utils.ts` の `loginAndOpenAccount` を、`/login/password` から `loginAsMember` へ付け替える。ここは Task 28） | 28 |
| `FR-ADMIN-MISC-001`（`mfa/reset` の分） | 管理の窓口の認可 | 書き直す: `mfa/reset` の行を消す | 30 |
| `FR-ADMIN-MISC-003`（10） | 強制失効と MFA のやり直しの守り | 書き直す: `revoke-user-sessions` の分は残し、`mfa/reset` の分を消す | 30 |
| `FR-ADMIN-MISC-008-first-admin-bootstrap`（2。skip 1） | 最初の店長のコマンド | 消す（オーナーの答え2が A の時）。B の時は、skip を外して書き直す（コマンドが作る利用者・役割・TOTP 無しを DB で確かめる。ログインは確かめない） | 31 |
| 関数の権限の試験（`FR-LOGIN-047`・`061`・`074`・`075`・`076`、`FR-LOOK-SEC-002`、`FR-NEWS-SEC-002`・`004`、`FR-PRIVACY-007`、`FR-SEARCH-020`、`FR-STOCKIST-012`・`014`） | `anon.auth.signInWithPassword` で会員の JWT を取る | 書き直す: Task 27 の手助けで取る | 27 |
| 手助け | `e2e/member-session-helpers.ts`（`loginAsMemberLegacy`・`setLoginTwoFactorCookie`・`createTestMember` の `password`）、`auth-2fa-test-utils.ts`（消す）、`account-test-utils.ts`、`helpers.ts`（`registerUser`・`loginUser`）、`home-grant-test-utils.ts`、`news-test-utils.ts`、`passkey-hook-scenarios.ts`（`signInWithPasswordGrant` は 040・031 の拒否の確かめに使うので残す） | 呼びを外すのは各 spec のタスク、定義を消すのは Task 33（冒頭の表） | 27〜33 |

**skip の一覧（台帳 1-3）の最後**: skip は7定義（`FR-LOGIN-032` の6、`FR-ADMIN-MISC-008` の1）。032 の6定義は Task 30 で消す。008 の1定義は Task 31 で消す（オーナーの答え2が B なら書き直して外す）。**Task 36 で `grep -rn "test.skip(true" e2e` を取り、段4の理由（`段4で消す機能`）が0件であることを確かめる**。1つでも残れば止める。

## jest・DB 結合の対応（まとめ）

実行者は、各タスクで下のパターンの `grep -rl` を取り、結果を報告に貼り、**消す側と書き直す側に分ける**。

| 領域 | 探す物 | 処置 |
| --- | --- | --- |
| `tests/unit/api/auth/` | `login-{route,resend-route,cancel-route}`・`otp-verify-route`・`register-route`・`confirm-route`・`mfa-{enroll-totp,enroll-totp-retired,status,verify}-route`・`password-{change-start,change-confirm,reset-*}-route` | 消す |
| `tests/unit/features/auth/` | `password-change-schema`・`password-change-service`、`schemas/` の login・register・password 系、`services/` の `login-2fa`・`register` のうち旧の道 | 消す（`register` は残す関数の分を書き直す） |
| `tests/unit/app/{login,auth}/`・`tests/unit/components/` | `login-verify-page`・`password-reset-*`・`verified-page`・`LoginModal`・`AuthTabs`・`RegisterModal`・`AuthResultScreen`・`providers-auth-page` の旧の道・`login-page` の `/login/password` の分 | 消す。`login-page`・`LoginContext` は縮めて書き直す |
| `tests/unit/lib/auth/` | `authenticate`（`aal` を読む分があれば）・`service-role-auth-client`（`signInWithPassword`・`signUp` の分を消す）・`amr` | 縮める |
| `tests/integration/api/` | `auth-login-*`・`auth-otp-verify-api`・`auth-mfa-*`・`auth-admin-totp-flow`・`auth-password-*`・`auth-bot-rate-limit` の旧の分・`auth-architecture`・`auth-cookie-data`・`auth/{login,register,register-enumeration,password-change,password-reset,cookieFlags,site-url-guard}（`site-url-guard` の試験は消す窓口を通してしか確かめていない。**`ARC-AUTH-007` の最後の結合テスト**なので、`ARC-AUTH-007` の扱いは Task 29 の文書の行を見る）`・`auth.test.ts`・`admin-misc/admin-mfa-reset-api` | 消す（`auth-architecture`・`auth.test.ts`・`cookieFlags` は残る窓口の分が混ざるので、分けて書き直す） |
| `tests/integration/ui/` | `auth-login-{flow,tabs-screen,verify-screen,form-screen}`・`auth-register-*`・`auth-password-*`・`auth-verified-*` | 消す。`auth-header-*`・`auth-drawer-screen` は `LoginModal` を使う分を書き直す |
| `tests/integration/db/` | `admin-misc/admin_bootstrap`（Task 31）、`group_g3_postgrest_paths`・`group_g4_postgrest_paths`・`order_status_postgrest`（パスワードで JWT を取る。Task 27）、`auth_passkey_*`（旗・フックの分。Task 32）、パスワード表・関数を直に試す3本 `auth_password_change_challenges`・`auth_password_reset_token_state`・`auth_password_reset_tokens_table`（アプリの使い道が消える **Task 29 で消す**。`DATA-AUTH-002`・`009`・`010` の廃止と同じタスク）、表の権限の一覧を持つ物（`auth_grants_inventory` ほか。K まで表があるので Task 32） | 直す・消す |

---

## Tasks

### Task 26: 消す前の基準（残す流れの試験と、パスワードで作ったアカウントのメールのコードのログイン）

**Files:**
- Create: `e2e/FR-LOGIN-078-legacy-account-email-code-login.spec.ts`。Modify: `playwright.config.ts`（078 を `isolated-global` の `testIgnore`・`testMatch` に足す。旗を切り替える AC-03 が同時に流れる spec を壊さないため）
- 文書（同じコミット）: `docs/02_Requirements/areas/auth.md` に `SR-AUTH-030`・`FR-AUTH-054`（残す流れが動く。AC は 078 が名乗る。FR に構造設計の子は要らない）。基本設計・脅威の文書は触らない。IMPL は無し（試験だけ）。
- 基準の記録: `.superpowers/sdd/2026-11-20-passkey-stage4/baseline.md`（実行者が作る。コミットしない）

**Interfaces:**
- Consumes: 既存の `createTestMember`（今は `password` 付きだが、Task 33 で `password` を消す）。**078 は `createTestMember` に頼らず、spec の中で `createUser({ email, password, email_confirm: true })` で「パスワードで作ったアカウント」を作る**（Task 33 の後も意味が変わらないため）、`loginAsMember`（メールのコード。`/api/auth/email-code/{start,verify}`）、`readLatestCode`、`createAdminSessionActor`。
- Produces: `FR-LOGIN-078`（3幅）。AC は `FR-AUTH-054-AC-01`〜`03`:
  - AC-01 パスワード付きで作った確認済みのアカウントが、メールのコードで `/account` に入れる。
  - AC-02 同じアカウントに、鍵を足せる勧めの画面（`offerPasskey`）が出る（残す流れ）。
  - AC-03 店員（`provisionStaff` で作った店長）は、メールのコードで入ろうとすると断られ、固定の文「店員の方は、パスキーでログインしてください。」が出る（旗を真にしても変わらない。FR-LOGIN-069 と重ならない最小の1本）。

- [ ] **Step 1: 事実を測る（手元の GoTrue）** — 次の (a)〜(e) を実際に流して、結果を `baseline.md` と、後で ADR-0475 の「背景」に書く（推測で書かない）。(a) パスワード付き・確認済みのアカウントに `email-code/start` → 8桁のコードのメールが届き、`verify` で入れる。(b) パスワード付き・**確認前**（`email_confirm: false`）のアカウントに `email-code/start` → 届くのはコードか確認のリンクか（ADR-0469 は「確認のメール」と書く。実測する）。(c) 確認前のアカウントが、確認のリンクを開かずに入れる道があるか。**(d) 記録だけ取る（採るためではない）**: `supabase/config.toml` の `[auth.email] enable_signup = false` に変え、**`npx.cmd supabase stop` → `start` で設定を効かせて**（変えた後と、元に戻した後の両方で。`db reset` では効かない）、次が通るかを記録する: 登録済みの人への `signInWithOtp({ shouldCreateUser: false })`・`auth.admin.createUser`・店員の招待の道（`generateLink` の magiclink → `verifyOtp`）・Task 27 の手助け・Google の新規ログインの始め・直の `/auth/v1/signup`。記録を取った後、**元に戻して `stop` → `start` を済ませ**、(a) を流し直して元の状態に戻ったことを確かめる。見込みは、メールでのログインそのものが止まる（`email_provider_disabled`）。**どれか1つでも落ちたら、この案は採らない（旧の問1 の D）。全部通っても、オーナーへ聞き直すまで採らない**。**(e)** 確認メールの雛形（`supabase/templates/confirmation.html`）に `{{ .Token }}` を入れた手元（`stop` → `start` で効かせる。測り終わったら元に戻して `stop` → `start`）で、確認前のアカウントが `email-code/start` → 届いた8桁の数字を `email-code/verify`（`type: 'email'`）に入れて入れ、確認済みになるか（答え1・5 の A の前提）。**落ちたら、Task 28 を渡す前に調整役が答え1・5 を聞き直す**。
- [ ] **Step 2: 基準を取る** — 3000番を止め、残す流れの spec を3幅で流し、件数と結果を `baseline.md` に控える: `FR-LOGIN-002`・`044`・`048`・`050`・`055`・`057`・`058`・`060`・`064`・`065`・`066`・`068`・`069`・`070`・`072`。赤があれば「段4と無関係の既存の赤」として別に控え、段4の比較から外す。
- [ ] **Step 3: 基準の試験を書く**（RED は無い。実装を変えず、今の master で通る確かめを足すだけのため） — 078 を AC-01〜03 で書く。AC-01〜02 は今の master で通る（基準）。AC-03 は、フックの旗を真にした状態でも通ることを確かめる（旗を切り替える手助けを `e2e/passkey-hook-scenarios.ts` に1つ足し、`db` の `UPDATE private.passkey_staff_config` で切り替え、**始めに今の値を読み、`try/finally` でその値に戻す**（Task 26 の時点は偽。J の後に流れても真のまま戻る）。078 は `isolated-global` なので、ほかの spec と同時に流れない。Task 32 が同じ手助けを使う）。
- [ ] **Step 4: 通ることを確かめる** — 078 を3幅 PASS。`trace:report`・`validate-trace`・`test:trace-coverage`・`validate-docs`。
- [ ] **Step 5: コミット** — `test(auth): パスキー段4の基準（パスワードで作ったアカウントのメールのコードのログイン）を足す`

### Task 27: パスワードで JWT を取っている試験の手助けを、パスワード無しの道に替える

**Files:**
- Create: `e2e/customer-session-test-utils.ts`
- Modify: `e2e/FR-LOGIN-047-passkey-server-function-grants.spec.ts`・`061-…`・`074-…`・`075-…`・`076-…`、`e2e/FR-LOOK-SEC-002-postgrest-policies.spec.ts`、`e2e/FR-NEWS-SEC-002-direct-db-access.spec.ts`、`e2e/FR-NEWS-SEC-004-admin-api-access-control.spec.ts`、`e2e/FR-PRIVACY-007-settings-postgrest-access.spec.ts`、`e2e/FR-SEARCH-020-search-db-function-grants.spec.ts`、`e2e/FR-STOCKIST-012-public-screens-with-seeded-rows.spec.ts`、`e2e/FR-STOCKIST-014-admin-api-authn-authz-csrf.spec.ts`、`e2e/home-grant-test-utils.ts`、`e2e/news-test-utils.ts`
- Modify: `tests/integration/db/group_g3_postgrest_paths.integration.test.ts`、`group_g4_postgrest_paths.integration.test.ts`、`order_status_postgrest.integration.test.ts`
- 文書: 無し（試験の手助けは製品のコードでも要件でもないので、ID・追跡の項目を作らない）。

**Interfaces:**
- Produces（試験の手助け。製品のコードではないので `@impl` は付けない）: `signInCustomerWithoutPassword(email: string): Promise<{ accessToken: string; refreshToken: string; userId: string }>`。実装は `auth.admin.generateLink({ type: 'magiclink', email })` の `hashed_token` を、匿名の鍵のクライアントの `auth.verifyOtp({ token_hash, type: 'magiclink' })` に渡して session を得る（手元の GoTrue だけ。`isLocalUrl` の見張りを通す）。GoTrue の `authentication_method` は `password` 以外になる。フックはお客さんの `password` だけを拒否する（`20261116230000` の `IF NOT v_is_staff` の分岐）ので、旗が真でも拒否されない（レビューでコードを読んで確かめ済み）。`verifyOtp` の `type` は `'email'` でもよい。
- Consumes: 既存の `createClient`、`localAdmin()`、`requireLocalEnv`。

- [ ] **Step 1: 失敗する試験を書く** — (1) `signInCustomerWithoutPassword` が会員の `access_token` を返し、そのトークンで `authenticated` の PostgREST（自分の行）が読める（旗が偽の時）。(2) 旗が真の時も同じトークンが取れる。(3) 旗が真の時、`anon.auth.signInWithPassword` は拒否される（旗を真にしたら落ちる古い取り方の証拠）。**(2)(3) は旗を切り替えるので、DB 結合のこのファイルは `--runInBand` で流し、始めに今の値を読み、`finally` でその値に戻す（J の後は真。偽に決め打ちで戻すと、後に流れる `auth_passkey_*` と 081 が落ちる）**（E2E の spec とは同時に流さない）。置き場: `tests/integration/db/customer_session_helper.integration.test.ts`（`auth_` で始めない名前＝範囲の外）。
- [ ] **Step 2: 失敗を確かめる** — 手助けが無く FAIL。
- [ ] **Step 3: 実装する** — 手助けを作り、上の spec・DB 結合の `signInWithPassword` を1つずつ差し替える。`createTestMember` の `password` はまだ消さない（Task 33）。差し替えた後に `grep -rn "signInWithPassword\|grant_type=password" e2e tests/integration` を取り、残るのは `FR-LOGIN-031`・`040`・`passkey-hook-scenarios.ts`（拒否を確かめる側）と、消す物（Task 28〜31）だけであることを報告する。
- [ ] **Step 4: 通ることを確かめる** — 触った spec を3幅 PASS、DB 結合 PASS。**旗を真にした確かめ（調整役が流す）**: 手元の DB で `update private.passkey_staff_config set reject_customer_password = true;` を流し、対象の spec を `npx.cmd playwright test <spec> --workers=1` で3幅流し、終わったら必ず `update private.passkey_staff_config set reject_customer_password = false;` に戻す（途中で落ちても戻す。**この手動の確かめは J の前なので、偽に戻してよい**。J の後に同じ確かめをする時は、始めの値に戻す）。これは Task 32 の先取りの確かめで、ほかの spec を同時に流さない。`trace:report` ほか。
- [ ] **Step 5: コミット** — `test(auth): 会員の JWT をパスワード無しで取る試験の手助けに替える（段4の準備）`

### Task 28: お客さんのパスワードのログイン・会員登録・確認メールの窓口を消す

**Files:**
- Delete（呼び手が0であることを確かめてから）: `src/app/login/password/`、`src/app/login/verify/`、`src/app/api/auth/{login,otp,register,confirm}/`（`confirm` はオーナーの答え1で決まる）、`src/components/{AuthTabs,LoginModal,RegisterModal}.tsx`、`src/features/auth/schemas/{login,register}.ts`、`src/features/auth/services/login-2fa-session.ts`（共有部分を切り出した後）、`e2e` の「E2E の対応」表の Task 28 の行の「消す」、jest・DB 結合の対応表の該当
- Modify: `src/contexts/LoginContext.tsx`（`login`・`verifyOtp`・`register`・旧の再送・取りやめを消し、`loginWithGoogle`・`refreshAuthState`・`logout`・状態を残す）、`src/app/login/page.tsx`（旧の保留の Cookie の分岐〔`/login/verify` への転送〕と `login-2fa-session` の読みを消す）、`src/components/Header.tsx`（`LoginModal` の差し込みと `loginOpen` の状態を消す。ログインのリンクは `/login` へ）、`src/contexts/Providers.tsx`（`isAuthPage` から2つを外す）、`src/features/auth/services/register.ts`（旧の道だけが使う関数を消し、残る呼び手が使う関数だけにする）、`src/features/auth/services/email-code-session.ts`・`src/lib/orders/status/status-session.ts`（`login-2fa-session` から借りている物を自分の側へ移す）、`src/features/auth/return-intent/*`（`signup` の用途の関数を消す）、`src/lib/cookie.ts`（旧の保留の Cookie の名前は Task 33）
- Create: `e2e/FR-LOGIN-080-removed-auth-entries-gone.spec.ts`（この時点の分。Task 29・30 が足す）、`e2e/FR-LOGIN-079-login-screens-layout.spec.ts`（オーナーの答え3が A の時）
- Modify（試験の手助け・spec）: `e2e/account-test-utils.ts`（`loginAndOpenAccount` を `loginAsMember` へ付け替え。`/login/password`・`/login/verify` を呼ぶ道を消す）、「E2E の対応」表の Task 28 の「書き直す」の spec（`loginAsMemberLegacy`・`setLoginTwoFactorCookie` の**呼び**を外す）。**手助けの定義（`member-session-helpers.ts`・`auth-2fa-test-utils.ts`・`helpers.ts`）は消さない。Task 33 が消す**（冒頭の表）。ただし `loginAsMemberLegacy` は、**中身を `loginAsMember` に付け替える**（名前・引数は残す。5本が緑を保つため）
- Modify（確認メールの雛形・画面の文。オーナーの答え5）: `supabase/templates/confirmation.html`（リンクの先が `/api/auth/confirm`・本文が「最初に登録したときのパスワードをお使いください…」）、`supabase/config.toml` の `[auth.email.template.confirmation]` の注釈、`src/features/auth/passkey/components/EmailCodeEntry.tsx:282` の「コードの無い確認のメールが届いた時は、そのメールのリンクを押してから…」の1文。直し方は答え5（**答えが揃ってから Task 28 を渡す**。「答えの関所」）。答え5が A なら、雛形に8桁の数字（`{{ .Token }}`）を入れ、リンクの先は無くす（答え1が A の時）。画面の1文は、「確認のメールにも同じ8桁の数字があります」の趣旨の文に直す（文はオーナーが決める）。Task 26 の (e) の実測が前提
- 文書: `FR-AUTH-053`（親 `SR-AUTH-030`）、`THR-AUTH-059`→`SEC-AUTH-061`→`SEC-AUTH-061-AC-01`（`FR-LOGIN-080` が名乗る）を作る、**`SEC-AUTH-035-AC-01` を「captcha が有効でも、アプリのメールのコードの始めと再送が通る」に書き直し、`FR-LOGIN-055` の該当の試験に名乗らせる**（`SEC-AUTH-035` は `DD-AUTH-040`・`ADR-0420`＝captcha を免除される auth だけの client を残すので廃止にしない。`-AC-02` は実行者が `npm run trace -- SEC-AUTH-035-AC-02` で中身を読み、メールのコードの窓口に当てはまれば 055 に名乗らせ、当てはまらなければ廃止にする。どちらも、`FR-LOGIN-031` の2件を消す同じコミットで）、`ADR-0469`（「段4で消す一覧」を「消した」に直し、状態は今の「推定」のまま）、`ADR-0400`・`0401`・`0402`・`0404`・`0410`・`0413`（状態を「廃止」にし、置き換え先に ADR-0475 または ADR-0469 を書く）、`IMPL-AUTH-102・103・124・125・141・142・145・146・161・162・163・164・323` ほか消した単位の IMPL・DD・API・SCR を「廃止」（構造設計は手順6）、`DD-AUTH-061`（旧画面の退避）を廃止、`docs/04_DetailDesign/sequence/auth-registration.md`・`auth-login-mfa.md`（廃止の印）、`14_login.md`・`screen-list.md`・`screen-flow.md`・`api-spec.md`・`route-inventory.md`

**Interfaces:**
- Consumes: Task 26 の基準、Task 27 の手助け。
- Produces:
  - 消した窓口は404、消した画面も404。**どこからもリンクが無い**（`Header`・ログインの画面・メール・戻り先・`sitemap`）。
  - `LoginContext` の公開する型から `login`・`verifyOtp`・`register`・`resendOtp` などを外す。`useLogin()` を使う残りの呼び手（`EmailCodeEntry`・`LoginChoices`・`PasskeyOffer`・`StaffOneMoreKey`・`Header`・`checkout` ほか）が使う物は変えない。
  - `/login` の画面は、旧の保留の Cookie があっても何も特別にしない（`/login/verify` へ送らない）。古い Cookie は無視する（名前を知らない Cookie になる）。
  - **確認のメールのリンク（`/api/auth/confirm`）は、オーナーの答え1が A なら消す**。消すなら、`/login?registered=1` の案内（旧の登録の確認を別のブラウザで開いた人向け）も画面から消す。B なら窓口と案内を残し、Task 33 で再検討と書く。

- [ ] **Step 0: 消す物の一覧を作る** — 「消す物の一覧」の窓口・画面・サービスの各行について `graphify query` と `grep -rn` を取り、呼び手を報告に貼る。呼び手が消す物以外に残るなら、消さず縮める。
- [ ] **Step 1: 失敗する試験を書く（消した後の形）** — `FR-LOGIN-080`（3幅）: `GET /login/password`・`/login/verify` が404。`POST /api/auth/login`・`login/resend`・`login/cancel`・`otp/verify`・`register` が404（または405。実測して書く）。`/login` に「パスワード」欄・「会員登録」タブ・`/login/password` へのリンクが無い。ヘッダーのログインのリンクが `/login` へ向く。`FR-LOGIN-078`（Task 26）と `FR-LOGIN-057`・`055`・`058` が通る。jest: `LoginContext` が `login`・`register` を持たない、`login/page` が旧の Cookie で転送しない。
- [ ] **Step 2: 失敗を確かめる** — 080 は今 FAIL（窓口が生きている）。
- [ ] **Step 3: 実装する** — 先に呼び手を外し（`LoginContext`・`Header`・`login/page`・`Providers`・手助け）、次に窓口・画面・部品・schemas・サービスを消す。`login-2fa-session` は、`email-code-session`・`status-session` が借りている部分を先に移してから消す。試験の手助けと spec を「E2E の対応」表のとおりに直す・消す。オーナーの答え3が A なら、消す視覚の spec の「1画面に収まる・真ん中寄せ・階層」の AC のうち `/login`・`/login/code` に当てはまる物を 079 へ移す（同じ検査を、移し先の画面に向けて書き直す）。B なら AC を廃止にする。
- [ ] **Step 4: 通ることを確かめる** — `FR-LOGIN-080`・`078`・`079`・`055`・`057`・`058`・`002`・`044`・`048`・`050`・`060`・`FR-ACCOUNT-001〜011`（`loginAndOpenAccount` を使う）・`FR-HEADER-*`・`FR-CHECKOUT-012`・`FR-LOGIN-038`（書き直し後）を3幅 PASS。jest（触ったもの）と typecheck・lint。消えたテスト名の一覧が、消した定義と一致する（件数でなく名前の差）。`FR-LOGIN-032`・`033`・`FR-PWRESET-010`・`FR-ACCOUNT-046`・`FR-ADMIN-MISC-008`（`loginAsMemberLegacy` の呼び手）も流して、緑のままであることを確かめる。追跡: 廃止の項目を指す物が無い。`validate-trace` が終了コード0。**消した spec が持っていた基準の鍵が減るので、調整役が許可を得て基準を更新する**。減る件数は、テスト名の一覧の差（`npm run trace:compare-e2e` か JSON の差）で、消した定義と一致することを確かめる。
- [ ] **Step 5: コミット** — `feat(auth): お客さんのパスワードのログインと会員登録の画面・窓口・試験を消す（パスキー段4）`

### Task 29: パスワードの再設定・変更を消す

**Files:**
- Delete: `src/app/auth/password-reset/`（`page.tsx`・`verify/page.tsx`・`verify/VerifyClient.tsx`）、`src/app/account/password/`、`src/app/api/auth/password-reset/`、`src/app/api/auth/password/`、`src/components/AuthResultScreen.tsx`、`src/features/auth/services/{password-change,password-reset-session}.ts`、`src/features/auth/schemas/{password-change,password-reset}.ts`、`src/lib/pwned-password.ts`、jest・DB 結合・E2E の該当（`FR-PWRESET-001〜010`、`FR-LOGIN-003`・`013`、`FR-ACCOUNT-046`、`FR-LOGIN-023`・`025`・`026` の再設定の分）
- Modify: `src/features/auth/schemas/common.ts`（`passwordSchema` を消す。`emailSchema` は残す）、`src/features/auth/services/auth-admin-user.ts`（再設定だけが使う関数を消す）、`src/lib/cookie.ts`（再設定の Cookie は Task 33）、`scripts/trace/scope.json`（`password-change.ts`・`schemas/password-change.ts` の2行を外す）、`e2e/FR-LOGIN-037-proxy-origin-csrf.spec.ts`（例を `email-code/start` に替える）、`e2e/FR-LOGIN-060-account-passkeys.spec.ts`（`/account/password` の確かめを「404で、リンクが無い」に）、`FR-UI-008`（再設定の分）
- 文書: `ADR-0403`・`0405`・`0421`（状態を「廃止」。置き換え先は ADR-0475 の「パスワードを廃止」）、`SEC-AUTH-034`・`FR-AUTH-006`・`SR-AUTH-009` などパスワードの再設定・変更に属する要件・SEC・AC・IMPL（`IMPL-AUTH-104〜106`・`181〜184`・`229〜239`）・DD（`DD-AUTH-041`・`022`・`023`・`025` ほか）を「廃止」。**`SEC-AUTH-015` は GoTrue の直叩きの規則なので廃止にしない**（作り手の判断9）。**`SEC-AUTH-035` は廃止にしない**（Task 28 でメールのコードの AC に書き直し済み）。ここでの直しは、本文の「パスワード変更の現行パスワードの確かめ」の1か所だけ
  - **構造設計（手順6）**: `DATA-AUTH-002`（`password_reset_tokens`）・`DATA-AUTH-009`・`010`（パスワード変更の表と関数）は、下の DD が全部廃止になるので**ここで廃止にする**（表を消すのは K のまま。アプリの使い道が消えるのはこのタスク）。名乗る DB 結合 `auth_password_change_challenges`・`auth_password_reset_token_state`・`auth_password_reset_tokens_table` もここで消す。`ARC-AUTH-007`（16字のパスワードと、メールのリンクの住所）は、パスワードの分を廃止にし、`SEC-AUTH-019`（Host の偽りでリンクを外へ向けさせない。招待・知らせのメールで生き続ける）は、招待のメールの結合テストを持つ既存の構造設計へ付け替える（新しい構造設計は作らない。付け替え先は `npm run trace -- SEC-AUTH-019` と招待の ARC を見て決め、報告に書く）。`auth/site-url-guard.test.ts` は `ARC-AUTH-007` の最後の結合テストなので、消す前にこの付け替えを済ませる
  - `docs/04_DetailDesign/sequence/auth-password-reset.md`（廃止の印）、`docs/06_Operations/supabase-auth-config.md` の再設定・変更の雛形の節（残す物と分ける）、`FR-AUTH-053`。**廃止にする AC の名前を持つ spec（`FR-LOGIN-031` の該当分ほか）は、同じコミットで直す**
- `FR-LOGIN-080` に、再設定・変更の窓口と画面の404を足す。`src/lib/ops/site-url-alert.ts`・`ops-alert-mail.ts` の `siteUrlInvalidMail` は、呼び手が消えるので消す（`site-url-guard.ts` 自体は残す）。`scope.json` の、消すファイルを名指す型を1行ずつ外す（`password-change.ts`・`schemas/password-change.ts`・`AuthResultScreen` ほか。Task 28 は `LoginModal`・`RegisterModal`・`AuthTabs`・`AuthResultScreen` の4行、Task 30 は `mfa`・`verified` の型）。

**Interfaces:**
- Produces: `/auth/password-reset`・`/auth/password-reset/verify`・`/account/password`・`/api/auth/password-reset/*`・`/api/auth/password/change/*` が404。`/account` の画面に「パスワード」のリンクが無い。
- **GoTrue 自身の `/recover` は残る**（アプリの外。フックが `password` を拒否するので、再設定してもパスワードでは入れない）。これは手順書に1行書く（Task 35）。

- [ ] **Step 0: 消す物の一覧** — Task 28 と同じ。`auth-admin-user.ts` の呼び手（`admin/staff/invites`・`admin/orders/[id]/history`）が使う関数は残す。
- [ ] **Step 1: 失敗する試験を書く** — `FR-LOGIN-080` に追加（上の404）。`/account` の鍵の画面（`FR-LOGIN-060`）に、パスワードのリンクが無い確かめ。jest: `emailSchema` が残り `passwordSchema` が無いこと（型の確かめ）。
- [ ] **Step 2: 失敗を確かめる** — FAIL（窓口が生きている）。
- [ ] **Step 3: 実装する** — 呼び手を外し、窓口・画面・部品・schemas・サービスを消す。`scope.json` の2行を外す。`pwned-password` の呼び手が0であることを確かめてから消す。
- [ ] **Step 4: 通ることを確かめる** — `FR-LOGIN-080`・`078`・`037`・`060`・`057`・`FR-UI-008`（書き直し後）、`FR-ACCOUNT-*` を3幅 PASS。jest・typecheck・lint。追跡・`validate-trace`・`test:trace-coverage`。
- [ ] **Step 5: コミット** — `feat(auth): パスワードの再設定・変更の画面・窓口・試験を消す（パスキー段4）`

### Task 30: TOTP・MFA の窓口と `/auth/verified`・MFA のやり直しの窓口を消す

**Files:**
- Delete: `src/app/api/auth/mfa/`、`src/app/auth/verified/`、`src/app/api/admin/users/mfa/`、`e2e/FR-LOGIN-018-verified-brand-design.spec.ts`、`e2e/FR-LOGIN-033` の画面の分、`e2e/FR-LOGIN-032` の TOTP の分（skip の6定義を含む）、`tests/unit/api/auth/mfa-*`、`tests/unit/app/auth/verified-page.test.tsx`、`tests/integration/ui/auth-verified-*`、`tests/integration/api/auth-mfa-*`・`auth-admin-totp-flow`、`tests/unit/api/admin/mfa-reset-route.test.ts`、`tests/integration/api/admin-misc/admin-mfa-reset-api.test.ts`
- Rename: `e2e/FR-LOGIN-032-admin-totp-aal2.spec.ts` → `e2e/FR-LOGIN-032-staff-entry-cookie-checks.spec.ts`
- Modify: `src/app/api/auth/post-login/route.ts`・`src/features/auth/passkey/post-login.ts`・`src/features/auth/return-intent/return-intent-service.ts`（行き先に `/auth/verified` を返す所を、認めた鍵が足りない店員なら `/admin/passkeys?more=1`（1本）か `/login?error=staff_passkey_required`（それ以外）へ）、`src/app/api/auth/oauth/callback/route.ts`・`src/features/auth/services/session.ts`（`mfa.verify` の記述）、`src/features/auth/return-intent/staff-entry-hint.ts`、`src/lib/auth/amr.ts`（`totp` の記述）、`src/lib/auth/app-session.ts`（注釈）、`e2e/FR-LOGIN-030`・`038`・`069`・`FR-ADMIN-MISC-001`・`003`、`tests/integration/api/auth/post-login.test.ts`（`ARC-AUTH-015` を名乗る結合テスト。行き先の分）、`tests/unit/features/auth/passkey/post-login.test.ts`（`DD-AUTH-092` を名乗る単体）、`tests/unit/app/staff/passkeys-page.test.tsx`・`tests/unit/lib/auth/staff-passkey-page-guard.test.ts`（`/auth/verified` を指す分）、`supabase/config.toml`（`[auth.mfa.totp]` の `enroll_enabled`・`verify_enabled` を `false`）
- Create: `docs/03_BasicDesign/decisions/ADR-0475-passkey-stage4-remove-verified-and-totp.md`（上位 `SEC-AUTH-061`〔Task 28 で作成済み〕、構造設計の子 `ARC-AUTH-015`。`ARC-AUTH-015` もここで作り、上位は `SEC-AUTH-061` と `ADR-0475`。`DD-AUTH-060` の上位に `SEC-AUTH-061`・`ARC-AUTH-015` を足す）。内容: `/auth/verified` と TOTP を消す理由、行き先の付け替え、`mfaVerified` の名前を変えない決め（設計 7）、Shopify・業界との比較表と出典（`docs/superpowers/specs/2026-11-07-passkey-auth-design.md` の5章の出典を引く）、Task 26 の測った事実。
- 文書: `ADR-0409`・`0418`（aal2 の部分を置き換え済みに）、`ADR-0457`・`0461`（MFA のやり直しの窓口が `redo` に置き換わった旨）、`ADR-0463`・`ADR-0468`（「段4でまとめて直す」の文を「変えない」に。名前ごとの決めは作り手の判断2）、`IMPL-AUTH-121`（`/auth/verified`）を「廃止」、`SEC-AUTH-009・010-AC-02・030・031`・`FREQ-316-REQ-02`・`SR-AUTH-014` の TOTP の分、`IMPL-AUTH-203〜205`・`IMPL-ADMIN-105`・`DD-ADMIN-005` を「廃止」、`docs/04_DetailDesign/pages/16-2_admin_misc.md`

**Interfaces:**
- Produces: `/auth/verified`・`/api/auth/mfa/{enroll-totp,status,verify}`・`/api/admin/users/mfa/reset` が404。`/api/auth/me` の応答の形（`mfaVerified`）・`/api/auth/post-login` の `needsMfa` の名前は**そのまま**（意味は「店員の入口の条件を満たすか」）。
- 行き先の表（`post-login`・`return-intent`・`oauth/callback` が返す）: お客さんは戻り先かホーム。店員で入口の条件を満たす → 戻り先か `/admin`。店員で認めた鍵が1本 → `/admin/passkeys?more=1`。店員でそれ以外 → `/login?error=staff_passkey_required`。失敗の時（通信の失敗・2xx でない応答・読めない本文。`post-login.ts` の今の :36・:39・:42）は `/login`。**`/auth/verified` を返す所を0件にする**。

- [ ] **Step 0: `/auth/verified` を返す所の一覧** — `grep -rn "auth/verified" src e2e tests docs` を取り、全件を報告に貼る（`confirm`・`oauth/callback`・`return-intent`・`post-login`・`LoginContext`・メール・文書）。
- [ ] **Step 1: 失敗する試験を書く** — jest: `post-login` が各場合（お客さん／店員の条件を満たす／鍵1本／それ以外／通信の失敗・2xx でない・読めない本文）の行き先を上の表のとおり返し、`/auth/verified` を返さない。`FR-LOGIN-080` に、`/auth/verified`・`mfa/*`・`mfa/reset` の404を足す。`FR-LOGIN-054`（行き先）・`039`・`FR-LOGIN-069` が通る。
- [ ] **Step 2: 失敗を確かめる** — FAIL。
- [ ] **Step 3: 実装する** — 行き先の付け替えを先に、次に窓口・画面・試験を消す。032 の名前を変える（`git mv`）。`config.toml` を直したら `npm run db:reset` ではなく `npx.cmd supabase stop` → `start` で設定が効くことを確かめる（手元だけ）。
- [ ] **Step 4: 通ることを確かめる** — 触った spec・`FR-LOGIN-080`・`039`・`044`・`054`・`063`・`066`・`068`・`070`・`072`・`FR-ADMIN-MISC-001`・`003` を3幅 PASS。jest・typecheck・lint。追跡。**skip の6定義が無い**（`grep -c "test.skip(true" e2e/FR-LOGIN-032-*` が0）。
- [ ] **Step 5: コミット** — `feat(auth): 認証アプリ（TOTP）の窓口・画面と MFA のやり直しの窓口を消す（パスキー段4）`

### Task 31: 最初の店長のコマンド `admin:bootstrap` を消す（オーナーの答え2が A の時。B の時は下の「B の時」）

**Files:**
- Delete: `scripts/admin/bootstrap.ts`・`bootstrap-core.ts`・`bootstrap-deps.ts`、`tests/integration/db/admin-misc/admin_bootstrap.integration.test.ts`、`e2e/FR-ADMIN-MISC-008-first-admin-bootstrap.spec.ts`、`tests/unit/scripts/` の該当（探す）
- Modify: `package.json`（`admin:bootstrap` の行を消す。**実行者は足さない**。調整役が、Global Constraints の対話の無い手順で、その1行の削除だけをインデックスに入れる。オーナーの `--webpack` の変更は触らない）、`docs/06_Operations/first-admin-bootstrap.md`（コマンドの節を「廃止。最初の店長は招待で作る」に）、`docs/06_Operations/passkey-staff-recovery.md`、`docs/06_Operations/passkey-production-apply-runbook.md`（節4の (3b) の2つ目の枝と、節7の `admin:bootstrap` の行。Task 35）、`tests/unit/scripts/admin/bootstrap-*.test.ts`（消す）
- 文書: `IMPL-ADMIN-301〜303` を「廃止」、台帳の skip の一覧の最後の1定義

**B の時**: コマンドを残す。`FR-ADMIN-MISC-008` の skip 1定義を外して書き直す（コマンドが利用者・`admin` の役割・`app_metadata.role` を作り、TOTP の要素を作らないことを DB で確かめる。ログインは確かめない）。コマンドに `@remarks` で「パスキーの段4の後は、戻し方の手順書だけが使う」と書く。

- [ ] **Step 1: 確かめる（試験は足さない）** — ファイルや `package.json` の行の有無は試験にしない。`grep -rn "admin:bootstrap" . --include=*.md --include=*.ts --include=*.json --exclude-dir=graphify-out --exclude-dir=node_modules` の結果を報告に貼り、残りの文書の参照を Task 34・35 へ回す。
- [ ] **Step 2〜4: 失敗を確かめる→消す→通る** — 呼び手（`bootstrap-core` を import する物）が消す物だけであることを確かめ、消す。`grep -rn "admin:bootstrap" . --include=*.md --include=*.ts --include=*.json --exclude-dir=graphify-out --exclude-dir=node_modules` の結果を報告に貼り、残りは Task 34・35 の文書へ回す。
- [ ] **Step 5: コミット** — `feat(auth): 最初の店長のコマンド admin:bootstrap を消す（パスキー段4）`

### Task 32: 移行 J・K と、フックの試験の反転

**Files:**
- Create: `supabase/migrations/<時刻>_passkey_reject_customer_password.sql`（J）、**K は答え4で置き場が変わる**: 答え4が B（おすすめ）なら `supabase/pending-passkey-stage4/<時刻>_drop_password_auth_objects.sql`（`supabase/pending-wave5/`・`pending-wave6/` の前例。当てる時に新しい時刻の版で `supabase/migrations` へ移す。手元の `db reset` では表が残り、`supabase db push` に K が混ざらない）と `supabase/pending-passkey-stage4/README.md`（移す手順と、K を当てる時に書き直す残すテストの一覧）。A なら `supabase/migrations/<時刻>_drop_password_auth_objects.sql`。**どちらでも作る**: `e2e/FR-LOGIN-081-customer-password-rejected.spec.ts`、`tests/integration/db/auth_passkey_stage4_migrations.integration.test.ts`、`docs/03_BasicDesign/decisions/ADR-0476-passkey-reject-customer-password-and-drop-tables.md`
- Modify: `e2e/FR-LOGIN-031-supabase-direct-bypass.spec.ts`（`grant_type=password` の期待を反転）、`e2e/FR-LOGIN-040-staff-hook-gotrue-rejections.spec.ts`（:83 を反転）、`e2e/passkey-hook-scenarios.ts`（旗を切り替える手助けは Task 26 で作成済み）、`tests/integration/db/auth_passkey_access_token_hook.integration.test.ts`・`auth_passkey_foundation.integration.test.ts`・`auth_passkey_server_fns.integration.test.ts`・`auth_passkey_staff_entry_conditions.integration.test.ts`（旗の既定を前提にしている分）、`src/lib/auth/staff-passkey-defaults.ts`（`@remarks`: `rejectCustomerPassword` は**列の既定値**＝偽を表し、実際の行は J の後は真。ADR-0476 にも書く。`auth_passkey_staff_entry_conditions.integration.test.ts:130`・`auth_passkey_foundation.integration.test.ts:57・66`・`auth_passkey_access_token_hook.integration.test.ts:295` の「行の値」を比べる分は、「J の後は行が真・列の既定は偽」に直す）、`playwright.config.ts`（081 を `isolated-global` に）、**K で落ちる残すテストの書き直し（一覧から消した表・関数を外す。答え4が A の時だけこのタスクで直す。B の時は K が `pending` にあり、手元に表が残るので今は落ちない。書き直す一覧は `supabase/pending-passkey-stage4/README.md` に写し、K を移す時のコミットで直す）**: `tests/integration/db/auth_grants_inventory.integration.test.ts`（:38・:94・:95）、`group_g2_public_function_acl.integration.test.ts`（:14・:187・:195）、`home/home_items_grants.integration.test.ts`（:42）、`auth_db_functions.integration.test.ts`、`group_g2_migration_asserts.integration.test.ts`、`return-receive-per-item-migration.integration.test.ts`、`tests/unit/migrations/sec-password-change-challenges.test.ts`（消す。表と関数が無くなるため）、`docs/06_Operations/db-migrations.md`（J・K の節。大きさ・MD5・前の確かめ・戻し・当てる順）
- 文書: `FR-AUTH-055`（AC は `FR-LOGIN-081` が名乗る）、`THR-AUTH-058`→`SEC-AUTH-060`（AC-01・02。`FR-LOGIN-081` が名乗る）、DB 結合のテスト名は `DATA-AUTH-013`（フックの関数）を名乗る、`THR-AUTH-058`・`SEC-AUTH-060`・`ADR-0476` を作り、`ARC-AUTH-015` の上位に `ADR-0476` を足す（`DATA-AUTH-002`・`009`・`010` は Task 29 で廃止済み）。J・K の SQL に DD・IMPL は作らない（作り手の判断は「親の決め」）

**Interfaces:**
- **J**（旗）:
  - 前の確かめ（`DO $$`）: `private.passkey_staff_config` が1行あり、`public.passkey_access_token_hook` が存在し、`private.passkey_staff_settings()` が `reject_customer_password` を返す。無ければ `PASSKEY_MIGRATION_PRECHECK_FAILED`（A・B が先に当たっていない）。
  - 本体: `UPDATE private.passkey_staff_config SET reject_customer_password = true WHERE id;`。終わりの確かめ: 1行が真。
  - ヘッダー: `ROLLBACK: UPDATE private.passkey_staff_config SET reject_customer_password = false WHERE id;`。**これは、古いアプリ（`c336e0b5`）に戻す時の最初の手**（Task 35）。
  - 当てる順: A〜I の後・アプリのデプロイの後（デプロイ前に旗を真にしても、アプリは新しい物しか無いので害は無いが、手順書は「アプリが動いてから」とする。理由: 旗を真にしてからお客さんの入り方に問題が出ても、旗の戻しだけで済む）。
- **K**（表と関数）:
  - 前の確かめ: 対象の表・関数の存在（無くても `IF EXISTS` で通すが、**行数を `RAISE NOTICE` で出す**。`password_reset_tokens`・`password_change_challenges` の行数が多い時は止めない）。
  - 本体: `DROP FUNCTION IF EXISTS public.issue_password_change_challenge(...)`・`consume_password_change_challenge(...)`・`public.cleanup_password_reset_tokens(integer)`、`DROP TABLE IF EXISTS public.password_change_challenges`・`public.password_reset_tokens`。**`CASCADE` を付けない**（依存があれば止まる）。
  - ヘッダー: `ROLLBACK` は、**K を当てる前の手元の DB の最終の姿**で書く。後から締め直した権限が戻らないと、セキュリティが後戻りするため（`20260901102912` の文をそのまま流すと `password_reset_tokens` が `anon`・`authenticated` に GRANT されて戻る。`20260921011535`〔search_path〕・`20261024153505`〔関数の EXECUTE を外す〕・`20261026130200`〔権限の締め直し〕も戻らない）。作り方: K を書く前に手元で `npx.cmd supabase db dump --local --schema public`（`pg_dump` が手元に無いことがある）か `docker exec <db のコンテナ> pg_dump --schema-only -t public.password_reset_tokens -t public.password_change_challenges` と、3つの関数の `pg_get_functiondef`・`proacl`・`proconfig`、表の `relacl`・方針の数を控え、その控えを `ROLLBACK` に書く（表・制約・索引・RLS・方針・GRANT/REVOKE・関数）。**消した行は戻らない**の1文を添える。
  - 当てる順: J の後。アプリが消した窓口を呼ばないことを確かめた後（デプロイ後）。
  - **監査の表・行・`auth_return_intents`・`rate_limit_counters` は触らない**。

- [ ] **Step 1: 失敗する試験を書く（DB 結合・E2E）** — DB 結合（J の後の手元）: (1) 旗が真。(2) `authentication_method = 'password'` のお客さんの入力で、フックが拒否の印 `[customer-password-disabled]` を返し、店員の印 `[staff-...]` と違う。(3) お客さんの `otp`・`magiclink`・`oauth`・`passkey`・`token_refresh` は、`event` をそのまま返す。(4) 旗を偽にすると `password` が通る（戻しの確かめ。**始めに今の値を読み、`finally` でその値＝真に戻す**。偽に決め打ちで戻さない）。(5) 店員の `password` は旗に関係なく拒否される（回帰）。(6) K の後（K が `pending` にある時は、K のファイルを**取引の内側で流して最後に取り消す**形で）、対象の表・関数が無く、`audit_logs`・`auth_return_intents`・`rate_limit_counters` はある。(7) K の `ROLLBACK` の文を流すと表・関数が戻り、**戻した後の `relacl`・`proacl`・`proconfig`・方針の数が、K の前に控えた値と同じ**（`anon`・`authenticated` に権限が付いていない）。E2E `FR-LOGIN-081`（3幅）: 手元の GoTrue に `grant_type=password`（お客さん）を直に投げて、拒否される。`FR-LOGIN-031`・`040` の反転した期待が通る。
- [ ] **Step 2: 失敗を確かめる** — `db reset` の後、J・K が無く FAIL。
- [ ] **Step 3: 実装する** — J・K を書く。`db reset` で適用できること。`FR-LOGIN-031`・`040` の期待を反転する（お客さんの `password` が「通る」→「拒否される」）。旗を偽に戻す確かめは DB 結合へ。
- [ ] **Step 4: 通ることを確かめる** — DB 結合（`auth_passkey_*` 全部と新しい1本）PASS。**E2E は、旗が真の手元の DB で**、Task 26〜31 で触った spec と `FR-LOGIN-081`・`031`・`040`・`047`・`061`・`074〜076` を3幅 PASS（これが Review Focus 4 の本番の確かめ）。J・K の大きさと MD5 を `md5sum`・`wc -c` で測り、`db-migrations.md` へ。`supabase/migrations` の `schema-snapshot`（`scripts/schema-snapshot.mjs`）の差分が出るなら、その手順に従う。
- [ ] **Step 5: コミット** — `feat(auth): お客さんの password をフックで拒否し、使わない表と関数を消す移行 J・K を足す（手元だけ）`

### Task 33: 残りの掃き出し（部品の縮小・設定・参照の0件の確かめ）

**Files:**
- Modify: `src/lib/cookie.ts`（旧の保留・再設定の Cookie の名前を消す）、`src/lib/auth/service-role-auth-client.ts`（`signInWithPassword`・`signUp` を型と実体から外す）、`tests/unit/lib/auth/service-role-auth-client.test.ts`・`tests/unit/lib/supabase-client-isolation.test.ts`、`src/lib/auth-no-store-policy.ts`・`src/proxy.ts`（道筋の一覧から消した窓口を外す。`tests/unit/middleware/proxy-no-store.test.ts`）、`src/lib/audit.ts`（注釈だけ）、`supabase/config.toml`（残す設定の理由を1行ずつ）、`src/features/auth/design.md`、**古い試験の手助けの定義を消す**: `e2e/member-session-helpers.ts` の `loginAsMemberLegacy`・`setLoginTwoFactorCookie`・`createTestMember` の `password`、`e2e/auth-2fa-test-utils.ts`（ファイルごと）、`e2e/helpers.ts` の `registerUser`・`loginUser`（呼び手が0であることを grep で確かめてから）。`scripts/trace/scope.json` に残る、消した型の行（Task 28〜30 で外し切れなかった分）
- 文書: 関連する `IMPL`・`DD` の「関連」

- [ ] **Step 1: 失敗する試験を書く** — jest: `createServiceRoleAuthClient` が持つ関数が `signInWithOtp`・`resend` だけ（`signInWithPassword`・`signUp` が無い）。`auth-no-store-policy` の一覧に消した窓口が無い。
- [ ] **Step 2: 失敗を確かめる** — FAIL。
- [ ] **Step 3: 実装する** — 縮める。次の grep を取り、**0件であること**を報告に貼る（残る物は理由つきで列挙）: `grep -rnE "login-2fa|sb-login-2fa|login/password|login/verify|api/auth/(login|otp|register|confirm|mfa|password)|password-reset|account/password|AuthTabs|LoginModal|RegisterModal|passwordSchema|pwned|enroll-totp|loginAsMemberLegacy|setLoginTwoFactorCookie" src e2e tests scripts docs --include=*.ts --include=*.tsx --include=*.md --include=*.json --include=*.toml --exclude-dir=graphify-out --exclude-dir=node_modules --exclude-dir=.next`（`docs/superpowers/`・`.superpowers/`・廃止の印のある文書の過去の記録・ADR の廃止の節は除く）。`grep -rn "aal2" supabase/migrations` の結果を分類し、「パスワード・TOTP だけの道に属する物が無い」ことを報告する。`grep -rn "create-user" src e2e tests` が0件で、`src/app/api/admin/users/route.ts` が `GET`・`PATCH` だけ（パスワードで作る `POST` が無い）ことを確かめる。
- [ ] **Step 4: 通ることを確かめる** — jest・typecheck・lint。`FR-LOGIN-078`・`080`・`055` を3幅 PASS。
- [ ] **Step 5: コミット** — `chore(auth): パスワードと認証アプリの残りの部品・設定・参照を掃き出す（パスキー段4）`

### Task 34: 正本の文書と追跡の仕上げ

**Files:**
- Modify: `docs/02_Requirements/areas/auth.md`・`admin.md`、`docs/03_BasicDesign/areas/auth.md`・`admin.md`、`docs/03_BasicDesign/api/{api-spec,route-inventory}.md`、`ui/{screen-list,screen-flow}.md`、`architecture/system-overview.md`、`docs/04_DetailDesign/pages/{14_login,16-2_admin_misc}.md`、`docs/04_DetailDesign/sequence/auth-{registration,password-reset,login-mfa,session}.md`、`docs/05_Quality/security/threats/auth.md`、`docs/05_Quality/tests/test-spec.md`、台帳（4-2 の段4の行・skip の一覧・「段4へ」を「済み」に。1-3 を「skip は 0」に）、`docs/02_Requirements/areas/auth.md` の `SR-AUTH-022`（退避）を「廃止」、ADR の一覧（`docs/03_BasicDesign/decisions/README.md`）、`docs/README.md` の索引、`scripts/trace/baseline.json`（調整役が許可を得て `-- --update-baseline`）、`ADR-0463`・`ADR-0468`
- 各タスクで廃止にした物の取りこぼしを、`npm run trace -- <ID>` と `validate-trace` で探して直す。

- [ ] **Step 1: 失敗する検査** — `npm.cmd run validate-trace`・`test:trace-coverage`・`validate-docs` を流し、廃止にした物を指す `retired-reference`・`missing-child`・リンク切れを一覧にする。
- [ ] **Step 2: 直す** — 一覧のとおり。`mfaVerified` の名前の決めは ADR-0463・`api-spec.md`・`auth.md` で「変えない」に統一する。`trace:report` で `docs/05_Quality/reports/` を作り直す。
- [ ] **Step 3: 通ることを確かめる** — 3つが通り、`validate-trace` が終了コード0（基準に無い鍵が0件）。
- [ ] **Step 4: コミット** — `docs(auth): パスキー段4の正本の文書と追跡を仕上げる`

### Task 35: 手順書・戻し方・最初の店長の手順書の直し

**Files:**
- Modify: `docs/06_Operations/passkey-production-apply-runbook.md`、`docs/06_Operations/passkey-staff-recovery.md`、`docs/06_Operations/first-admin-bootstrap.md`、`docs/06_Operations/supabase-auth-config.md`、`docs/06_Operations/db-migrations.md`（J・K の節は Task 32。ここは当てる順と全体の表）

直す内容（手順書。**本番には何も流さない。当てるのは調整役だけでオーナーの許可を得てから**）:

1. **概要・節1**: 「A〜I の9本」を「A〜K の11本」に。節1に「10. 本番の `auth.users` の状態を読む（読むだけ）: お客さんの数・確認前のパスワード登録の数・店員の TOTP の要素の数」を足し、読む SQL を載せる。確認前のパスワード登録が1件でもあれば、**消すか確認を済ませるかをオーナーが決める**（オーナーの答え1が A の時の運用（確認メールに数字を入れる前提）。本番の4人は、役割の印が店長の試し用で、お客さんではない。パスワードだけのお客さんと確認前の登録は、記録の上では0人。読んで数える）。
2. **節2の当てる順**: 4の後（定期処理の登録）と5〜7（最初の店長・E・TOTP を止める）の後に、**8. J**（アプリのデプロイと、お客さんがメールのコードで入れることの確認の後。**調整役がオーナーの許可を得てから**）→ **9. K**（J の後。消した窓口を呼ぶ物が無いことの確認の後）を足す。節2の7（TOTP を止める）は、ダッシュボードの Multi-Factor の TOTP の Enroll・Verify を止める手順（段4のコードは TOTP を使わない）に昇格させ、店員の TOTP の要素の残りの扱い（H の取引・やり直しで消える。残りを読む SQL）を書く。
2b. **本番のダッシュボードの確認メールの雛形**を、オーナーの答え5に従って直す手順（雛形のリンクが `/api/auth/confirm` を指し、本文がパスワードを案内している。`supabase-auth-config.md` の確認の雛形の節。**変えるのはオーナー**。2026-11-06 の決定）。
2c. **答え5が A の時**: 本番のダッシュボードの確認メールの雛形に `{{ .Token }}`（8桁。有効期限・桁数はメールのコードと同じ）を入れる手順と、確認前のアカウントで数字を入れて入れることの確かめ（調整役がオーナーの許可を得てから。手元の Task 26 (e) と同じ確かめを、本番に当てる前に1回）。
2d. **本番の権限と手元の権限が同じか**を、当てる前に比べる読むだけの SQL を1行足す（K の戻しの正本は手元の最終の姿なので、本番の `relacl`・`proacl` が手元と同じことを確かめる）。
3. **節3の表**: J・K の行（前の確かめ・突き合わせ・戻し）。
4. **節4の戻し方**: 次の**新しい先頭**を足す。(0) **K を戻す**（K の `ROLLBACK` の文。K を当てる前の最終の姿＝締め直した権限を含む。戻した後に `relacl`・`proacl` を読んで確かめる）。(0b) **J を戻す**（`UPDATE private.passkey_staff_config SET reject_customer_password = false WHERE id;`。**古いアプリに戻す前にこれを済ませる**。済ませずに古いアプリへ戻すと、お客さんがパスワードで入れない）。その後に今の (1)〜(11)。(1) の「戻し先 `c336e0b5`」は、段4の後は**古いアプリがパスワードの窓口と窓口の表（K で消した表）を必要とする**ので、K を先に戻すことを書く。**お客さんへの影響**の文に、「段4の後にメールのコードで登録した（パスワードの無い）お客さんは、パスワードの再設定をするまで入れない」を足す（段2の文を段4にも当てはめる）。(3b) の2つ目の枝（`admin:bootstrap`）は、オーナーの答え2が A なら削り、「別のアドレスの店長が要るなら、ダッシュボードで作ってから1つ目の枝の SQL で有効にする」に替える。**「1つ目の枝の SQL」は、節4の (3b) の「上の1つ目に当てはまらないもの」の 1（取引の逆）の SQL を指す**（1つ目の枝そのものには SQL が無い）。**J を先に戻す理由**: (1) で古いアプリを出してから (2) でフックの登録を外すまでの間も、旗が効いたままだとお客さんが入れない。(2) でフックの登録を外せば旗は効かなくなるので、順番の理由はこの間を守るため。
5. **節7の残る危険**: 「`admin:bootstrap` が H の `STAFF_INVITE_REQUIRED` を効かせない（段4まで）」の行を消す（コマンドが無くなる）。GoTrue 自身の `/recover`・`/signup` が残ること（フックが `password` を拒否するので入れないこと）を1行足す。
6. **節9の開店前の残り**: 3b の持ち越し **M-3**（`hardDeadlineMs` の余裕。cron を本番で有効にする時に見直す）・**M-4 のコード側**（心拍の「予算で飛ばした」の扱い）・**M-6**（H のヘッダーの数。H を直す時だけ）を、理由つきで足す（段4では直さない。下の「持ち越しの着地」）。
7. **`passkey-staff-recovery.md`**: `admin:bootstrap` への言及を直す。
8. **`first-admin-bootstrap.md`**: 冒頭に「このコマンドは段4で消した（オーナーの答え2が A の時）。履歴のために残す」と書くか、文書ごと「廃止」の印にして `docs/README.md` から外す。
9. **`supabase-auth-config.md`**: パスワードの欄（最小16字など）・再設定・変更の雛形・TOTP の手順の節に「段4で要らなくなった」と書き、メールのコード（8桁・5分）の節は残す。TOTP を止める手順を足す。
10. 「確認日」を更新し、`validate-docs` を通す。

- [ ] **Step 1: 失敗する検査** — `grep -n "9本\|A〜I\|admin:bootstrap\|c336e0b5" docs/06_Operations/*.md` を取り、直す所の一覧を報告に貼る。
- [ ] **Step 2: 直す** — 上の1〜10。戻しの順を1か所の表にまとめ直し、調整役が1行ずつ追える形にする。
- [ ] **Step 3: 通ることを確かめる** — `validate-docs`。手順書の SQL は流さない（読むだけの `select` と、「調整役がオーナーの許可を得てから」付きの更新だけ）。レビュー担当（Opus）が、手順書の順で追って、途中で止まらずに戻せるかを紙の上で確かめる。
- [ ] **Step 4: コミット** — `docs(ops): パスキーの手順書と戻し方を段4（移行 J・K・パスワードの廃止）に合わせる`

### Task 36: 最終の確かめ

**Files:** 無し（確かめだけ。台帳の状態欄とオーナーへの一覧を直す）

- [ ] **Step 1: 掃き出しの確かめ** — (a) Task 33 の grep が0件。(b) `grep -rn "test.skip(true" e2e` に `段4で消す機能` が0件。(c) `grep -rn "signInWithPassword\|grant_type=password" e2e tests` の残りが、拒否を確かめる側（`FR-LOGIN-031`・`040`・`081`・`passkey-hook-scenarios.ts`）だけ。(d) `ls src/app/login src/app/auth src/app/account` に消した物が無い。
- [ ] **Step 2: 全体の確かめ（調整役）** — `npm run db:reset` → lint・typecheck・jest 全部。DB 結合（`--runInBand`）。**3000番を止めて、E2E を全件**（本番ビルド・3幅）。比べる元は 3b の `e2e-task25-full.json`。**件数でなく、テスト名の一覧の差**（`npm run trace:compare-e2e` か JSON の差）で比べ、消えた名前が消した定義と一致し、赤が増えない（3幅で回さない spec もあるため）。`trace:report`・`validate-trace`（終了コード0）・`test:trace-coverage`・`validate-docs`。
- [ ] **Step 3: 台帳とオーナーへの一覧** — 台帳の 4-2 の段4の行、1-3 の skip の一覧（0件）、「段4へ」を「済み」に。オーナーが確認する物（本番に当てる前の確認。J・K・手順書・消したことで変わるお客さんの入り方）の一覧を書く。
- [ ] **Step 4: コミット** — `docs(quality): パスキー段4の最終の確かめの結果を台帳に書く`

---

## 持ち越しの着地（段4で着地するか、理由つきで残す）

| 持ち越し | 出どころ | 着地 | 理由 |
| --- | --- | --- | --- |
| 段3b M-2（E2E が作る店長が手元の DB に溜まる） | 3b の最終レビュー | 残す（コードは直さない） | 本番の危険は無い。段4の最後の全件の前に `db:reset` を流す決めで避ける（Global Constraints・Task 36）。恒久の直し（teardown か E2E の規則への1行）は開店前の項目 |
| 段3b M-3（パスキーの行が遅いと、点検が60秒に近づく） | 同上 | 残す | 計画の判断で受け入れ済み。段4は worker を触らない。cron を本番で有効にする時に見直す（手順書の節9に足す。Task 35） |
| 段3b M-4 のコード側（「予算で飛ばした」時も心拍が成功） | 同上 | 残す（手順書の文は 3b で直し済み） | 条件がまれで、webhook の滞留の警告が先に出る。コードは直さない |
| 段3b M-6（H のヘッダーの私用の関数の数） | 同上 | 残す | 直すと H の MD5 が変わる。H を直す時だけ畳む。段4は H を直さない |
| 台帳 1-3 の skip の7定義 | 台帳 | 全部「消す機能と一緒に消す」 | 032 の6定義（Task 30）、ADMIN-MISC-008 の1定義（Task 31。オーナーの答え2が B なら書き直して外す） |
| ADR-0469 の「段4で消す一覧」の全項目 | ADR | 「消す物の一覧」の表で全項目を行に取った | 取りこぼしを足した物: `/auth/verified`（設計 7）、`mfa/reset`、`password-reset`・`password/change`・`pwned-password`・`passwordSchema`、`service-role-auth-client` の2関数、`auth_return_intents` の扱い（残す理由つき） |
| 段2の持ち越し「未確認の旧登録は確認メールが要る（段4まで）」 | ADR-0469 の「結果」 | オーナーの答え1 | 本番は試し用の4人だけ（設計 8-1）。手順書で読んで決める |
| 台帳 5章 W-06（法令対応） | 台帳 | 触らない | 監査の表・行を消さない（作り手の判断6） |

## セルフレビュー

- **範囲**: 設計 4-2 の段4の行（画面・窓口・表・試験を消す、フックの拒否を有効にする、文書の正本を直す）を、Task 28〜32・34 が1つずつ覆う。設計 7 の「消す」の行は全項目が表にある（`/admin/create-user` は既に無いことを確かめて書いた）。
- **逆向きの確かめ**: 消す物だけでなく、残す物（メールのコード・パスキー・Google・招待・アカウントの画面・更新・ログアウト）を、Task 26 の基準と Task 28〜32 の「3幅 PASS」の一覧で守る。
- **順番**: 試験の手助けを替える（27）→ 消す（28〜31）→ 旗を真にする（32）。旗を真にする前に、パスワードで JWT を取る試験が残っていないことを grep で確かめる（27・36）。消す前に旗を真にしない。
- **追跡**: 廃止は下から上の順で、同じコミットの中で指している側と、廃止にする AC の名前を持つ spec も直す。`validate-trace` は終了コード0（基準に無い鍵が0件）。新しい項目は、DD にコードの単位と単体テスト・AC に E2E が付く形だけを作る。
- **番号**: 空きは grep で確かめて予約した。3b の予約の使い残し（IMPL-AUTH-343〜346）は使わない。
- **本番**: 本番に触る手は無い。J・K・手順書の直しだけで、当てるのは調整役がオーナーの許可を得て、ドメインが決まった後。
- **穴として残る物**: (a) GoTrue 自身の `/signup`・`/recover` は残る。フックが `password` を拒否するので入れないが、確認のメールのリンクで session が作られる道（`FR-LOGIN-031` の既存の確かめ）は変わらない。(b) 試験の手助け `signInCustomerWithoutPassword` は手元の GoTrue 専用で、本番の道を作らない。(c) `createTestMember` から `password` を消す（Task 33）と、GoTrue の `/token` を直に叩く拒否の確かめ（031・040・081）は、パスワードを別に与える作り方が要る。Task 32 が、拒否の確かめ専用に `createUser({ password })` を使う（その spec の中だけ）。

## オーナーに聞くこと

重要な順。問2・4・6 は、各問いの「おすすめ」で進めてよい。**問1・3・5 は、答えが揃うまで Task 28 を始めない**（「答えの関所」）。答えが違えば、該当のタスクだけを直す。

1. **メールの確認がまだのお客さんの扱い**（Task 26・28・35）。
   - 事実（やさしい言葉で）: 新しい仕組みでは、お客さんはパスワードを使わず、メールに届く8桁の数字（コード）で入る。古い仕組みで作った登録のうち、メールの確認がまだの人には、数字ではなく「確認のメール」が届き、そのリンクを押すまで入れない。パスワードの登録をやめると、そのリンクの先も無くなる。本番にいる4人は、店長の印が付いた試し用で、お客さんではない。パスワードだけのお客さんは、記録の上では0人（当てる前に数える）。
   - A（おすすめ）: 確認のリンクの入口を消し、確認メールにも8桁の数字を入れる（問5の A と対）。確認がまだの人も、数字で入れる。他人が先に作った「確認がまだ」の登録でも、本当の持ち主は数字で入れる。先に手元で、数字で入れることを試す。
   - B: 確認のリンクの入口を、確認がまだの人がいなくなるまで残す（メールは今のまま）。
   - 見送った案: 店の画面の外から作れる「メールでの新規登録」の入口を閉じる案。調べると、その設定は「メールでのログインそのもの」のスイッチで、閉じると**全員のメールのコードのログインも止まってしまう**ため、採らない。
2. **`admin:bootstrap`（最初の店長を、パスワードと認証アプリで作る古い道具）**（Task 31・35）。新しい仕組みでは、これで作った店長は入れない。古い仕組みへ戻す時は、昔の版にこの道具が残っているので使える。
   - A（おすすめ）: 消す。戻す時の最後の手段は、ダッシュボードで店長のアカウントを作り、手順書の手順で役割を有効にする形。
   - B: 戻す時専用として残す（古い道具のコードが残り続ける）。
3. **古いログイン画面の「見た目の約束」を、新しいログイン画面に引き継ぐか**（Task 28）。古い画面には「1画面に収まる」「真ん中に寄る」「文字の濃さで読む順がわかる」などの約束（自動の試験）があった。
   - A（おすすめ）: 今の画面にも当てはまる約束だけを、新しい画面の試験に移す。
   - B: 古い画面と一緒に、約束も無くす。
4. **使わなくなった記録の入れ物（パスワードの再設定などの一時的な記録）を、データベースから消す時期**（Task 32・35）。「ドメインが決まるまで当てない」「他のパスキーの作業の後」は決定済み。消すと入れ物の中身は戻らず、開店前に古い仕組みへ戻す手順が1つ増える。得るのは、空の入れ物が無くなることだけ。
   - A: ほかの作業と一緒に、お客さんが数字で入れると確かめた後に消す。
   - B（おすすめ）: 古い仕組みへ戻す必要が無くなるまで（開店して一定の期間が過ぎるまで）消さずに置く。消す作業は「待ち」の置き場に入れ、他の作業に混ざって当たらないようにする。
   - C: 消さない（入れ物はずっと残る）。
5. **確認メールと、数字入力の画面の1文**（Task 28・35。お客さんに見える文が変わる。「新しい文は作らない」の例外。**文そのものも、この時に決める**）。今の確認メールは、押す先が消える入口で、本文が「最初に登録したときのパスワードをお使いください」と案内する。数字入力の画面にも「確認のメールが届いたら、そのリンクを押してから…」という1文がある。本番の雛形を変えるのはオーナー。
   - A（おすすめ）: メールに、ログインの数字と同じ8桁を入れる。パスワードの案内は消す。画面の1文も「確認のメールにも同じ8桁の数字があります」の趣旨に直す。問1の A と対。
   - B: メールも画面も、今のままにする（問1が B でリンクを残す時だけ選べる）。
6. **`package.json`（開発の設定ファイル）に残っているオーナーの書き換え**（Task 31）。オーナーが手元で書き換えた1行（開発用の画面の起動のしかた）が、消したい1行のすぐ隣にある。
   - A: 先にオーナーがその書き換えを保存（コミット）するか戻すかを決め、その後に1行を消す。
   - B（おすすめ）: オーナーの書き換えには触らず、こちらの1行の削除だけを保存する（安全な手順がある。オーナーの手は要らない）。

**答えが要る時期**: 問1・3・5 は Task 28 を始める前（文そのものを含めて決める）。問2・6 は Task 31 の前、問4 は Task 32 の前（おすすめで進めてよい）。

## 付録: 段4で新しく足す文面

無し。出す文は既存の物だけ（例: 「店員の方は、パスキーでログインしてください。」）。
