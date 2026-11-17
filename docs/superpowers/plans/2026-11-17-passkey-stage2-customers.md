# パスキー 段2（お客さん）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** パスキー置き換えの段2として、お客さんが画面からログインできるようにする。`/login` を「パスキー・Google・メールのコード」の画面に作り替え、メールのコードの流れ（予備と新規が同じ流れ）を作り、コードで入った人に「パスキーを作る / あとで」を出し、アカウントにパスキーの一覧・名前の変更・削除・追加を足し、パスキーの足し・消し・差し替えの知らせのメールを送る。1b の窓口を画面から呼び、本物のブラウザ（Playwright の仮想の認証器）で通して確かめる。パスワードの窓口・画面は段4まで残し、今の E2E を壊さない。

**Architecture:** (1) 画面より先に、メールのコードの窓口4本（始め・確定・再送・取りやめ）と専用の保留の Cookie を作る。パスワードの窓口とは別の名前にし、今の窓口と今の試験には触れない。(2) ブラウザの WebAuthn の部品と、1b の窓口を呼ぶ部品を、画面より先に作る（1b の持ち越し T2 M12・T2 M3・T7 M3 をここで片付ける）。(3) 今のログイン・登録の画面を `/login/password` に動かして今の試験を守り、そこから新しい画面を1つずつ足す（コード入力 → `/login` → パスキーを作る勧め → アカウント）。(4) 知らせは、1a の引き金が積む表に取り出し・完了・失敗の関数を足し（移行 G。手元だけ）、注文のメールと同じ送り手・同じ毎分の定期処理で送る。(5) E2E の会員のログインの手助け（`loginAsMember`）を新しい窓口に付け替える（作り直しの確認として、最後に近い独立のタスク）。(6) 運用の文書と全体の確かめ。

**Tech Stack:** Next.js App Router（Route Handler・Client Component）、`@supabase/supabase-js` 2.119.0（固定）、`zod`、Postgres 17（手元の Supabase）、GoTrue v2.196.0、Jest、React Testing Library、Playwright（本番ビルド・Chromium の CDP の仮想の認証器）、`tsx`。

**Spec:** [docs/superpowers/specs/2026-11-07-passkey-auth-design.md](../specs/2026-11-07-passkey-auth-design.md)（正本。特に 4-2 の段2の行と「段1で今のログインと試験を壊さない決め」、5-1、5-3、5-4、5-5、6-1、7、8-2、9、10、12、12-2）。1b の計画は [2026-11-17-passkey-stage1b-server-endpoints.md](2026-11-17-passkey-stage1b-server-endpoints.md)、1b の台帳は `.superpowers/sdd/2026-11-17-passkey-stage1b-server-endpoints/progress.md`・`final-review.md`。ブランドは `docs/01_Planning/brand.md`（CLAUDE.md が書く `docs/1_RequirementsDifinition/brand.md` は無い。本当の場所はこちら）。実行する人は、この計画と設計書の両方を読む。

## 分け方（段2が持つ範囲）

| 計画 | 中身 |
| --- | --- |
| 1a・1b（済み。push 済み） | 土台、DB の表・関数・引き金、フック、管理の入口の3つの条件、パスキーのサーバーの窓口（始め (a)(b)・ログインの終わり・登録・一覧・名前・削除・更新の拒否）、ソフトの認証器の試験の道具 |
| **段2（この文書）** | メールのコードの窓口4本と保留の Cookie（新規も同じ流れ）、ブラウザの WebAuthn の部品、`/login` の作り替え（旧画面は `/login/password` へ退避）、`/login/code`、`/login/passkey`（パスキーを作る勧め）、アカウントのパスキーの一覧・追加・名前・削除、知らせを送る処理（お客さん向けと店員向けの文面。移行 G は手元だけ）、`loginAsMember` の付け替え、1b からの持ち越し4件 |
| 段3（店員） | 招待・やり直し・登録の窓を閉じること・無操作1時間・Google の拒否の画面・店員の管理画面のパスキー・店長への知らせを「店員の機能として」仕上げること・店長の最後の手段。**段2の知らせの送り手は店員の文面も含む**（下の「作り手の判断 6」） |
| 段4（片付け） | パスワード・認証アプリの画面・窓口・表・試験を消す。**`/login/password`・`/login/verify`・`/api/auth/login/*`・`/api/auth/otp/verify`・`/api/auth/register`・`/account/password` の画面と窓口をここで消す**。お客さんの `password` の拒否を有効にする |

**1つの文を先に書く（本番の安全）**: 段2は本番の DB に何も当てない。この master（段2まで入った物）を、アプリとして本番に出してはいけない。出せるのは段3が済んでからである（パスワード＋認証アプリの店長が入れなくなるため。1a・1b と同じ）。

## 作り手の判断（この計画で私が決めた物と、理由の1行）

設計書が決めていない、または2つの文が食い違う点を、ここにまとめる。違えばオーナーが直す。

1. **`/account/password` の扱い（設計 6-1 と 4-2 の食い違い）**: 6-1 は「今の `/account/password` は消す」、4-2 の決めは「パスワードの窓口は段4まで残す」と書く。**段2は、アカウントの画面から「パスワードを変更」のリンクだけを外し、`/account/password` の画面と `/api/auth/password/change` は段4まで残す。画面と窓口を消すのは段4。** 理由: 窓口を残す決め（今のログインと E2E の `loginAsMember` を守る）が先に立ち、画面だけ消すと `FR-ACCOUNT-046`（パスワード変更の E2E）が段4より前に理由なく消える。お客さんの目に入る入口（リンク）だけを段2で消せば、設計の「お客さんにパスワードを見せない」という狙いは段2で満たせる。**リンクを外すと、受け入れ条件 `FR-AUTH-006-AC-01`（「会員ページのリンクから `/account/password` に着く」）と `FR-ACCOUNT-046` のその1本の期待が必ず変わる。Task 7 で、AC を「`/account/password` を直に開くと画面が使え、アカウントの画面に『パスワードを変更』のリンクが無い」に書き直し、試験も同じ形に直す。画面そのものが直 URL で今も動くことの試験は、段4まで残す。**
2. **旧ログイン・登録の画面は `/login/password` へ動かす（消さない）**: 今の E2E が約40本、`/login` の旧フォーム（Password 欄・会員登録タブ）を直に操作している（手助け `loginAndOpenAccount` を使う16本を含む）。段2で `/login` を作り替えると、これらが一斉に落ちる。旧画面を `/login/password`（検索に載せない・どこからもリンクしない）へ動かし、その E2E の URL だけを付け替えれば、中身は変えずに緑を保てる。段4で、旧画面と一緒にこれらの E2E を消す（設計 9）。**調整役の判断（I-2）: 動かした旧画面は、中で閉じた形に保つ。旧画面の中から旧画面へ戻る行き先（`/login/verify` の Cookie 無し・`VerifyOtpClient` の 401 と取りやめ・`RegisterModal` のログインへのリンク）は `/login/password` にする。お客さんに見せる行き先（`/api/auth/confirm` の `/login?registered=1`・パスワード再設定の後・パスワード変更の後）は新しい `/login` のままにする。** 理由: 旧の流れが新しい画面に飛ばされて旧フォームを探して落ちるのを防ぎ、段4で旧を丸ごと消せる。お客さんが見る行き先は新しい画面が正しい。新しい `/login` に着く試験の期待は Task 5 で直す。
3. **メールのコードで新規のお客さんを作る方法**: 手元の GoTrue は、未登録のアドレスで `signInWithOtp({ shouldCreateUser: true })` を呼ぶと、**確認メールの型（リンク型。今の `confirmation.html`）**で送る。この型は今の会員登録（`signUp`）も使うので、コードを足すと旧画面の確認メールが変わる。そこで次の形にする: **窓口が、先に `auth.admin.createUser({ email, email_confirm: true, app_metadata: { email_code_signup_pending: true } })`（パスワード無し）を呼び、全員に同じく `signInWithOtp({ shouldCreateUser: false })` を呼ぶ（今のログインのコードのメールの型 `magic_link.html` が使われ、コードだけが届く）**。既に登録があれば `createUser` は `email_exists` で断られるので握りつぶす。`email_address_invalid`（GoTrue がアドレスを断る）は形の誤りと同じ 400 にする（全員が入れない故障ではなく、列挙の手掛かりにもならない）。それ以外の失敗は 500。確定（コードが通った時）で、印 `email_code_signup_pending` が付いた利用者なら外す（`auth.admin.updateUserById`。失敗してもログインは成功のまま、監査に符号だけ残す）。理由: コードのメールの型を1つに保てる／**GoTrue の上では、作った時に確認済み（`email_confirmed_at`）になる。本人がメールを読めたかは、作った時には確かめていない。本人の確かめはコードの確定でだけ成り立ち、それまでのアカウントにはパスワードもパスキーも無いので、持ち主以外は使えない**／今の `/api/auth/login/resend` が既に `shouldCreateUser: false` で使っている形を変えない。`email_confirmed_at` を本人の確かめの印として読む所（`linkGuestOrdersByEmail` の門）は、今は確定・パスキー・確認の窓口の後でだけ呼ばれるので崩れない。この前提を `SEC-AUTH-048` に書く。**調整役の判断（I-8）: 一度も入らなかったアカウントの後始末の定期処理は、段2では作らない。** 理由: 本番の DB は試しの4人だけで公開前、削除はユーザーの連鎖（注文・`profiles`）の確かめが要る重い作業のため。代わりに、段2で印 `email_code_signup_pending` を必ず付けて確定で外す形にし（後始末が安全に選べる）、台帳の開店前の項目に「印が付いたまま24時間を過ぎ、注文の無い利用者を消す定期処理（選ぶ SQL を `docs/06_Operations/` に書く）」を足す（Task 11）。Task 1 の最初の確かめ（手元の GoTrue で実測）で、この組み合わせ（`createUser` → `signInWithOtp` → Mailpit のコード → `verifyOtp({ type: 'email' })`）に加え、**旧の会員登録（`signUp`）で作って確認していない既存のアドレス**を確かめる。通らなければ止めて調整役へ。
4. **保留の Cookie は新しく作る（名前 `sb-email-code-session`）**: 今の `sb-login-2fa-session` は `userId` を持つが、未登録のアドレスには `userId` が無い。`userId` を持たない（メールと、Cookie ごとの乱数 `jti` だけを持つ）Cookie にすれば、登録済みか未登録かを応答で見分けられない（SEC-AUTH-016 を保つ）。今の Cookie と窓口は旧画面が段4まで使うので、触らない。署名・期限（5分）・絶対の上限（30分）の作りは `login-2fa-session.ts` と同じにする。
5. **コード入力の部品は旧画面の部品を写して作る**: 旧 `VerifyOtpClient.tsx`（368行）は旧窓口の名前と `LoginContext.verifyOtp` に結ばれている。共有に直すと旧画面を触る。段4で旧を消すので、新しい `EmailCodeEntry.tsx` に必要な動き（8桁の入力・貼り付け・再送のカウントダウン・取りやめ）を写す。
6. **知らせの送り手は、お客さん向けと店員向けの文面を同じ段2で出す**: 1a の引き金は店員の行も積む。店員の行だけ送らず放っておくと、行が `pending` のまま溜まり、段3で一度に古い知らせが出る。送り手・宛先の関数は共通なので、文面を足す差は小さい。店員の文面は、ここでは「本人」と「有効な店長（admin）全員」に送る分だけ（設計 5-4）。段3は、招待・やり直しの流れの中の知らせ（店長への「やり直しを出した」など）を足す。
7. **E2E のファイル名はすべて `e2e/FR-LOGIN-NNN-*.spec.ts`**（アカウントのパスキーの試験も）: 追跡の範囲（`scripts/trace/scope.json` の AUTH）の E2E が `e2e/FR-LOGIN-*.spec.ts` だけを拾い、`FR-ACCOUNT-*` は `FR-ACCOUNT-046` だけが入っているため。ブリーフの案内（`FR-ACCOUNT-NNN`）より、範囲を足さずに済むほうを採った（`FR-ACCOUNT` にすると `scope.json` に1行足す手間が増えるだけで、追跡はどちらでも通る）。
8. **アカウントのパスキーは新しいタブ「ログイン方法」に置く（お客さんだけ）**: 既存の4タブ（お客様情報・配送情報・購入履歴・お問い合わせ）に1つ足す。店員は段2では見せない（店員の削除の下限・登録の窓・2本の規則の画面は段3）。
9. **パスキーを作る時の名前の初期値は「端末の種類」だけ**（`iPhone`・`Mac`・`Windows`・`Android`・`この端末`）: 作った後に PATCH で付ける。失敗しても作ったパスキーは残り、「名前は後から変えられます」と出す。
10. **T7 M3（登録の終わりで GoTrue の 4xx が 502 になる）の扱い**: 窓口は直さない。画面は 502 も 400 も「うまく作れませんでした。もう一度お試しください」に統一し、押し直すと**始めからやり直す**（新しい `challenge_id`）。期限切れでもサーバーの失敗でも、お客さんがする操作は同じなので、見分ける必要が無い。
11. **T2 M12（本物のブラウザの `toJSON()` が `authenticatorAttachment: null` を返しうる）**: 窓口のスキーマで `null` も受け（`.nullish()`）、GoTrue へ渡す前に `null` の項目を落とす。本物のブラウザ（仮想の認証器）の E2E で実際の形を確かめる。
12. **パスキーのボタンは、ブラウザが対応していない時は出さない**（`window.PublicKeyCredential` が無い）。代わりに一文「この端末ではパスキーを使えません。メールのコードか Google でログインできます」を出す。勧めの画面（Task 6）は、さらに `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` が偽（顔・指紋・PIN が無い端末）の時も出さず、店員（`role` が `user` でない）が来た時は勧めずに行き先へ送る。理由: 作れない勧め・お客さん向けの文を店員に出さないため。
13. **(b)（ブラウザから GoTrue を直に呼ぶ道）の画面の配線は段2で作るが、実機の確かめは本番の切り替え時**（設計 8-2）。単体の試験で `mode: 'browser'` を渡して通す。`@/lib/supabase/client`（読み込んだ時点で `detectSessionInUrl: true` の client を作る）は、`mode === 'browser'` の時だけ動的に読み込み、`server` の時は束にも初期化にも入れない。見えない形の Turnstile は、Cloudflare 側のサイトキーの種類で決まるので、コードでは今の `useTurnstileWidget` を使う。
14. **Google で入ったお客さんがパスキーを足す時**: 1b の取り決め（10分以内にパスキーかメールのコード）のまま。画面は、窓口の 403 `registration_not_allowed`（`reason: reauth_required`）を「安全のため、メールのコードでもう一度ログインしてから追加してください」と読み替え、コードのログインへ送るボタンを出す。
15. **`loginAsMember` の付け替えは段2に入れる**（段4に回さない）: 段2が新しい窓口を作るので、`loginAsMember` を使う E2E 17本と手助け2つ（`delivery-tracking-test-utils.ts`・`return-request-test-utils.ts`）の大半が新しい窓口を通ることが回帰の証拠になる。ただし旧の窓口の性質を確かめる試験は旧の道のまま残す（下の調整役の判断）。1つのファイルの変更で独立に戻せるように、最後のほうの別タスクにする。

## 調整役の判断（レビュー後に加えた物。理由つき）

1. **旧の窓口の性質を確かめる試験は、旧のパスワードの道のまま残す（I-9）**: `loginAsMember` を使う spec は17本と手助け2つ。うち `FR-LOGIN-030`・`031`・`032`・`033`・`FR-PWRESET-010`・`FR-ACCOUNT-046` は、旧の `login`・`otp/verify`・パスワードの窓口の性質（session の Cookie と応答・Supabase を直に叩く道・2段目・パスワード変更）そのものを確かめるので、旧のままにする。ほかで旧の窓口の性質を確かめる物（`FR-PRIVACY-006` の応答の見出しと Cookie、`FR-LOGIN-037` の Origin・CSRF、`FR-ADMIN-MISC-008`）は、実行者が1本ずつ中身を読んで、旧の窓口の性質を確かめていれば旧のまま、ログインを準備に使うだけなら新しい手助けにする（決めた結果を台帳に書く）。理由: 旧の窓口は段4まで残り、これらの試験はその窓口の確かめだから。準備にだけ使う試験（`FR-ACCOUNT-033`・`034`、`FR-CART-023`・`024`、`FR-CHECKOUT-046`・`047`、`FR-HOME-022`、`FR-WISHLIST-016`、2つの手助け）が新しい窓口に移る。
2. **旧画面の中の行き先（I-2）**: 判断2のとおり、旧の流れの中の戻り先だけ `/login/password` にし、お客さんに見せる行き先は新しい `/login` のまま。`src/contexts/Providers.tsx` の `isAuthPage`（`/login`・`/login/verify`・`/auth/password-reset` の完全一致）に `/login/password`・`/login/code`・`/login/passkey` を足す（足さないと真ん中寄せの枠にならず `FR-LOGIN-016`・`017`・`023` が落ちる）。
3. **メールのコードの回数の制限（I-7。設計 6-1 の「ADR-0400〜0402 を作り直す」の中身）**: ADR-0401 と同じく、**始めと再送は同じ名前の枠（`auth:email-code:send`）で数える**（分けると10分に10通送れてしまう）。IP は 50回/10分、宛先（メール）は 5回/10分。パスワードが要らなくなり、Turnstile を通せば**誰でも他人のアドレスの保留の Cookie を取れる**ので、確定の総当たりの枠は宛先だけで数えず、**保留の Cookie ごと**（Cookie に乱数 `jti` を持たせ、`subject = email + ':' + jti`）に 5回/10分、加えて**宛先ごとに緩い上限 20回/10分**を置く。これで他人が本人の確定の枠を使い切れない。8桁・5分のコードなら、宛先ごとの当て推量は、宛先ごとの上限があるので10分に最大 20回に収まる。宛先ごとの 20回は、始めを4回呼べば他人が使い切れる（5回×4。送りの枠の止め方に含まれ、`SEC-AUTH-049` の残る危険に1行書く）。残る止め方（他人が始めを5回呼んで、本人のコードを上書きし、始めの枠を使い切る）は、パスキーと Google が残ることを理由に `SEC-AUTH-049` に「残る危険」として書く。
4. **E2E を全件で流しても、知らせで溢れない（I-5）**: 知らせの宛先は「本人＋有効な admin 全員」。`provisionStaff` は役割を付ける**前**に鍵を登録して認めるので、その時の行は `subject_is_staff = false`（宛先は本人1人）。**店長全員へ広がる行**は、役割が有効になった**後**に鍵が足し引きされた時にできる（`elevateAdminSessionToAal2`・`addApprovedPasskey`・`addUnapprovedPasskey`、1b の `FR-LOGIN-051` の店員の登録、認めた鍵や利用者の削除）。このまま全件を流すと、有効な admin が数百になった時に、cron を呼ぶたびに行ごと数百通が Mailpit に出て、`loginAsMember`・注文のメールが待つメールを押し出す。そこで (a) `FR-LOGIN-062` は `playwright.config.ts` の `isolated-global`（直列）に入れる（`testIgnore` の正規表現にも足す）、(b) **鍵を足し引きする一番下の道具で、その `user_id` の `pending`・`retry_wait` の行を `skipped` にする**: `scripts/e2e/passkey-staff.ts` の `registerAndApprove`（`provisionPasskeyUser`・`addApprovedPasskey` の両方が通る）と `addUnapprovedPasskey` の終わり、および利用者・鍵を消す E2E の後始末（消す前に skip する1行。`deleteUser` の道具）。`keepNotifications: true` の口は `FR-LOGIN-062` だけが使う。手元の DB だけ、(c) `FR-LOGIN-062` は始めに待ちの行を `skipped` にし、試験が作った店員以外の E2E の admin（`user_roles.active` を `false` にする。他の試験が終わった後なので干渉しない）を外す、(d) worker は1行の宛先を送る間も予算を見て、越えたら残りの宛先を送らずその行を `fail` で次へ回す。**手元の送り手（`MAIL_PROVIDER=local`）は重複防止の鍵を使わないので、途中で切れた行は次の回に最初の宛先から送り直し、同じ宛先に重なる。宛先ごとの鍵で2通目が出ないのは Resend の時だけ**（E2E では (b)(c) で行を減らして防ぐ）。
5. **定期処理への足し方（I-6）**: 知らせの worker は、(a) 注文のメールの worker と同じ停止の決め（`orderEmailWorkerDisabledReason`。Vercel の preview・本番の DB を向いた `next dev` では動かない）を先に見て、止まる環境では呼ばない（`stopped: 'disabled'`）、(b) 置き場所は追跡の worker の**後**・点検の**前**、予算は残りから決める（`min(3000, 60_000 − 経過 − 15_000)`。1秒未満なら呼ばない。追跡の予算の計算は変えない。点検・見回りのために残す15秒を食わない）、(c) 毎分の定期処理の入口（`/api/cron/process-stripe-webhooks`）からだけ呼び、Stripe の知らせ1件ごとの `after()` からは呼ばない（`runWebhookWorker` に `{ passkeyNotifications: boolean }` を渡す。cron の入口だけ真）。理由は ADR-0470 に書く。
6. **`loginAsMember` の付け替えの形（I-9）**: 旧の道は `loginAsMemberLegacy`（今の `loginAsMember` の中身そのまま）として残し、上の6本が呼ぶ。`loginAsMember` は新しい窓口にする。段4で `loginAsMemberLegacy` を、使う6本と一緒に消す。

## Global Constraints

1a・1b の決まりを引き継ぎ、段2で足す物を書く。全部のタスクの要件に含まれる。

**本番の安全（オーナー決定 2026-11-16。段2にもそのまま効く）**

- **段2は本番の DB に何も当てない**。実行者は本番に一切触れない。Supabase の MCP（`apply_migration`・`execute_sql` など）も、`supabase config push` も使わない。`.env*` は読まない・表示しない・探さない。`graphify update` は流さない。
- 本番に当てるのは調整役だけで、段3、またはオーナーの許可を得た時に、1本ずつ MCP の `apply_migration`（名前はファイルの版と同じ）。当てた後は `md5(statements[1])` をファイルの MD5 と突き合わせ、ファイルの名前を当てた版に合わせて変える。**`supabase db push`（どの形でも）と GitHub の `workflow_dispatch` は動かさない**。
- パスキーの移行は今6本（1a の A〜E と 1b の F）。**段2の移行 G（Task 8）を7本目として、「段3まで `db push` しない」一覧（`docs/06_Operations/db-migrations.md`）に足す**。
- master への push は許される。push のたびに調整役がオーナーの許可を得る（実行者は push しない）。
- **この master を、アプリとして本番にデプロイしない。段3が済むまで**。パスワード＋認証アプリの店長が管理画面に入れなくなる（フックと管理の入口の条件が段1から店員のパスワードを拒否するため）。この一文を Task 11 で `db-migrations.md`・`first-admin-bootstrap.md` の該当箇所に書き足す。
- 移行の版（ファイル名の時刻）は**作る時の時刻**で付ける。`ls supabase/migrations | tail` で最新（今は `20261117123620_passkey_server_endpoint_fns.sql`）より後にする。この計画の `<時刻>` は仮。
- **`package.json` は触らない**（新しい npm のコマンド・依存を足さない。別の作業の `dev` の変更が残っているため）。触る必要が出たら、先に調整役へ知らせる。
- 実装者が足す環境変数は無い（`NEXT_PUBLIC_PASSKEY_START_MODE` は1bで追加済み）。値を文書に書かない決めは変わらない。

**手元の Supabase の扱い・E2E**

- 1b と同じ。実装者は1人ずつ、手元の `db reset` と DB 結合の試験を自分で流してよい（`DATABASE_URL` を手元に向ける。`describeLocalDb` が手元の DB だけを許す）。流す前に3000番のアプリを止める。**E2E の全件・push 前の確かめは調整役だけ**。
- E2E は必ず本番ビルド（`next build && next start`）・390・768・1280 の3幅。dev サーバーでは流さない。`retries` を上げて通さない。落ちたら「単独の再実行 → 他の幅 → `goto` のタイムアウトかアサーションか」の順で切り分ける。全件の赤は、**比べる元1つ**（`.superpowers/sdd/2026-11-17-passkey-stage1b-server-endpoints/` の 1b の全体の確かめの E2E の結果の JSON。無ければ調整役が1b の終わりの結果を探して決める）と比べる。
- メールは必ず手元の Mailpit（`MAIL_PROVIDER=local`）。E2E の見張り（`scripts/e2e/environment.ts`）が外へのメールを拒む。
- 手元の `supabase status -o json` を読む時は、鍵の値を画面に出さない。

**設計の守り（段2で足す物）**

- **メールのコードの流れは、登録済みかどうかで画面も応答も変えない**（設計 6-1、SEC-AUTH-016）。始めの窓口は、未登録・登録済み・店員のアドレスのどれでも、同じ状態・同じ本文・同じ Set-Cookie の名前と属性を返す。保留の Cookie は `userId` を持たない（メールだけ）。
- **ボット検査（Turnstile）は始めの窓口だけ**。アプリが `verifyTurnstile` で確かめてから、アカウントを作り・コードを送る（今の `login/route.ts` の順番と同じ。確かめの前にメール単位の枠を使わない）。GoTrue へは、captcha を免除される `createServiceRoleAuthClient` で呼ぶ。
- **コードの段の宛先は Cookie だけから取る**（クライアントのメールを信じない）。枠の作りは「調整役の判断 3」のとおり（始めと再送は共有の名前 `auth:email-code:send`、確定は保留の Cookie ごと＋宛先ごとの緩い上限）。枠を使い切ったら保留の Cookie を閉じる。
- **店員がメールのコードで入ろうとしたら、フックが拒否する**（1a）。確定の窓口は、フックの拒否の印（`isStaffPasskeyRequiredError(error)`。`{ status, message }` を丸ごと渡す。403 かつ印で始まる時だけ真。`error.message` だけを渡すと常に偽になる）を見分けて 403 `staff_passkey_required` にし、画面は「店員の方は、パスキーでログインしてください」と出す。Cookie（セッション）は作らない。
- **WebAuthn の応答（`credential`）は、ブラウザから1b の窓口にだけ送る**。GoTrue を画面から直に呼ぶのは、始めの (b) だけ（1b の部品）。`challenge_id`・`credential`・コード・トークンを、画面のログ・監査・メールに残さない。
- **UV は必須**（始め・登録の選択肢は1b の窓口が `required` にする）。画面はそれを書き換えない。
- **ログイン後の行き先は `POST /api/auth/post-login` が決める**（戻り先を使い切る）。パスキーを作る勧めの画面は、post-login を呼ぶ**前**に出す（戻り先を使い切らない）。
- **画面とメールの文は、ブランドの声に合わせる**: 静かで、説明は短く、煽らない（brand.md の「時を紡ぐ」。流行・急かし・感嘆符・絵文字を使わない）。丁寧語（です・ます）。専門語（WebAuthn・FIDO・認証器・UV）を画面に出さない。「パスキー」は一度「顔認証・指紋・PIN で入る方法」と言い換える。
- **アクセシビリティ**: 状態の変化は `LiveMessage`（`role="status"`/`alert`）で読ませる。ボタンはキーボードで押せる。送信中は `disabled` と `aria-busy`。フォーカスは、画面の切り替えのたびに見出しか最初の入力へ移す。色だけで状態を伝えない。タップの大きさは今の `Button`（高さ44px以上）に従う。
- すべての新しい窓口は `/api/auth` の下に置く（proxy が no-store・Origin の確かめを自動で付ける）。ログインした人が使う窓口は `requireCsrfOrDeny()`。ログイン前の窓口（始め・確定・再送・取りやめ）は、今の `login/*`・`otp/verify` と同じく CSRF の確かめは無い。
- 監査（`logAudit`）には、トークン・コード・鍵・認証器の応答・`challenge_id` を残さない。メールのアドレスは、今の `login/route.ts` と同じ扱い（`actor_email`）にとどめ、本文・詳細には載せない。

**リポジトリの決まり**

- 要求管理（範囲内の領域 AUTH）: 要求・要件・受け入れ条件は `docs/02_Requirements/areas/auth.md` に `SR-AUTH-NNN`・`FR-AUTH-NNN`（`requirements.md` には書かない）。基本設計は `docs/03_BasicDesign/areas/auth.md`、設計判断は `docs/03_BasicDesign/decisions/ADR-NNNN-<slug>.md`、脅威は `docs/05_Quality/security/threats/auth.md`、処理の詳細は `docs/04_DetailDesign/sequence/auth-*.md` の `DD-AUTH-NNN`、画面は `docs/04_DetailDesign/pages/14_login.md`・`15_account.md`。コードには TSDoc の `@impl IMPL-AUTH-NNN`・`@design DD-AUTH-NNN`。書式は `documentation-guide` スキルに従う。
- **文書と追跡は、そのタスクのコミットに入れる**。各タスクの「文書」の行の ID を同じコミットで足し、`npm.cmd run validate-trace`・`npm.cmd run test:trace-coverage`・`npm.cmd run validate-docs` が通ることを、コミットの前に確かめる。`scripts/trace/baseline.json` から増やさない。新しいコードの届かない分岐は `test-gaps.md` の節に書く。
- 番号の予約（着手時に `grep` で空きを確かめる。2026-11-17 の実測の最大は SR-AUTH-020、FR-AUTH-022、DD-AUTH-058、IMPL-AUTH-294、SEC-AUTH-047、DATA-AUTH-018、API-AUTH-028、ADR-0468 まで（0469 は帯の中で空き）、FR-LOGIN-054）: `SR-AUTH-021`〜`024`、`FR-AUTH-023`〜`033`、`API-AUTH-029`〜`032`、`DD-AUTH-059`〜`068`、`IMPL-AUTH-295`〜`325`、`SEC-AUTH-048`〜`051`、`DATA-AUTH-019`、`ADR-0469`（お客さんのログインの画面・メールのコードの流れ）・`ADR-0470`（知らせの送り手）、E2E は `e2e/FR-LOGIN-055`〜`064`。
- **追跡の範囲の足し方**（`scripts/trace/scope.json` の AUTH。足すたびに `validate-trace` と `test:trace-coverage` を流す）:
  - Task 1: `src` に `src/features/auth/services/email-code-*.ts`・`src/features/auth/schemas/email-code.ts`、`tests` に `tests/unit/features/auth/email-code-*.test.ts`
  - Task 2: `src` の `src/features/auth/passkey/**/*.ts` を `**/*.{ts,tsx}` にし、`tests` の `tests/unit/features/auth/passkey/**/*.test.ts` を `**/*.test.{ts,tsx}` にする（画面の部品を同じ置き場に置く）
  - Task 9: `docs` の `ADR-046[3-9]*.md` の隣に `ADR-0470*.md`（0470 は帯の外）。`decisions/README.md` の AUTH の帯の行も「0463〜0470」にそろえる
  - `src/app/login/**` は既に入っている（`/login/password`・`/login/code`・`/login/passkey` は自動で範囲に入る）。`src/app/account/page.tsx` は AUTH の外（変更は `15_account.md` と `docs/03_BasicDesign/ui/screen-list.md` に書く）
- 読みにくい漢字（ページを表す古い字）は使わず「ページ」と書く。文は設計書と同じやさしい日本語。
- master で直接作業する。タスクごとに1コミット。末尾に `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。**未追跡のファイルを `git add -A` で足さず、自分が作った物だけを名前で足す**（`.superpowers/`・`.claude/`・`.codex/`・`package.json`・stockist の差分は足さない）。
- モデル: 書き手は Sonnet、レビューは Opus（effort high）。

## Review Focus

先頭ほど起きやすい。

1. **メールのコードの始めの窓口**: 未登録・登録済み・店員のアドレスで、本文・状態・Set-Cookie の名前と属性が1文字も違わないか（時間の差は `SEC-AUTH-048` に残る差として書く）。Cookie に `userId` が入っていないか。Turnstile の確かめの前にアカウントを作っていないか・メール単位の枠を使っていないか。`createUser` の `email_exists`・`email_address_invalid` 以外の失敗を握りつぶしていないか（全員が入れなくなる故障を隠さない）。印 `email_code_signup_pending` を付け、確定で外すか（Task 1）
2. **コードの段**: 始めと再送が同じ名前の枠を共有し、他人が本人の確定の枠を使い切れないか（保留の Cookie ごとの枠）。宛先を Cookie だけから取っているか。枠を使い切ったら Cookie を閉じるか。店員のコードがフックで断られた時にセッション・Cookie が作られないか。新旧の Cookie が混ざらないか（旧画面の `sb-login-2fa-session` で新しい窓口が動かない・その逆も）（Task 1・4）
3. **旧画面の退避**: 動かしただけで中身を変えていないか。`/login/password` に旧フォームが残り、旧い保留の Cookie の道（`/login/verify`）が動くか。付け替えた E2E が、旧画面の URL以外の期待を変えていないか（Task 3）
4. **本物のブラウザのパスキー**: `toJSON()` の形（`authenticatorAttachment: null`・`id`＝`rawId`）で窓口が通るか。UV が付かない・途中で中止・対応していないブラウザで、画面が止まらず次の手段を示すか。勧めの画面で「あとで」を選んでも、戻り先が使い切られず行き先へ進むか（Task 2・5・6）
5. **知らせ**: 同じ行を2度送らないか（重複防止の鍵。ただし手元の送り手は鍵を使わないので、鍵の確かめは単体だけ）。1人の失敗が他の宛先への送りを止めないか／止めても再試行で2通目にならないか。お客さんの文面に、他の人のアドレスが入っていないか。E2E の全件で知らせが溢れないか・定期処理の予算が残りから決まり、注文のメールと追跡を遅らせないか（Task 8・9）

---

## ファイルの全体図

| 区分 | ファイル | タスク |
| --- | --- | --- |
| 作る | `src/features/auth/services/email-code-session.ts`、`src/features/auth/schemas/email-code.ts`、`src/app/api/auth/email-code/{start,verify,resend,cancel}/route.ts` | 1 |
| 変える | `src/lib/cookie.ts`（新しい Cookie の名前と属性）、`scripts/trace/scope.json` | 1・2・9 |
| 作る | `src/features/auth/passkey/webauthn-browser.ts`、`passkey-client.ts`、`device-name.ts`、`post-login.ts` | 2 |
| 変える | `src/features/auth/schemas/passkey.ts`（`authenticatorAttachment` の null）、窓口2本（null を落とす）、`src/lib/auth/passkey-gotrue.ts`（`server-only`） | 2 |
| 作る | `src/app/login/password/page.tsx`（旧画面の退避先） | 3 |
| 変える | `src/components/AuthTabs.tsx`（タブの URL）、`e2e/` の旧画面を操作する約30本（URL だけ）、単体の試験のうち旧の `page.tsx` を読む物 | 3 |
| 作る | `src/app/login/code/page.tsx`、`src/features/auth/passkey/components/EmailCodeEntry.tsx` | 4 |
| 作る | `src/features/auth/passkey/components/LoginChoices.tsx`、`EmailCodeStartForm.tsx` | 5 |
| 変える | `src/app/login/page.tsx`（新しい画面） | 5 |
| 作る | `src/app/login/passkey/page.tsx`、`src/features/auth/passkey/components/PasskeyOffer.tsx`、`e2e/passkey-virtual-authenticator.ts` | 6 |
| 作る | `src/features/auth/passkey/components/AccountPasskeys.tsx` | 7 |
| 変える | `src/app/account/page.tsx`（タブ追加・パスワードのリンクを外す） | 7 |
| 作る | `supabase/migrations/<時刻>_passkey_notification_sending.sql`（移行 G）、`src/lib/auth/passkey-notification-store.ts` | 8 |
| 作る | `src/lib/auth/passkey-notification-compose.ts`、`passkey-notification-worker.ts` | 9 |
| 変える | `src/lib/stripe/webhook-worker.ts`（定期処理に1段足す） | 9 |
| 変える | `e2e/member-session-helpers.ts`、`e2e/auth-2fa-test-utils.ts` | 10 |
| 変える（文書） | `docs/06_Operations/supabase-auth-config.md`・`db-migrations.md`・`first-admin-bootstrap.md`、`docs/03_BasicDesign/ui/screen-list.md`・`screen-flow.md`、台帳 | 11 |

---

### Task 1: メールのコードの窓口4本と、保留の Cookie

**Files:**
- Create: `src/features/auth/services/email-code-session.ts`（`login-2fa-session.ts` の写し。`userId` を持たない）、`src/features/auth/schemas/email-code.ts`、`src/app/api/auth/email-code/start/route.ts`、`verify/route.ts`、`resend/route.ts`、`cancel/route.ts`
- Modify: `src/lib/cookie.ts`（範囲の外。変更は `docs/04_DetailDesign/sequence/auth-passkey-customer-screens.md` に書く。`emailCodeSessionCookieName = 'sb-email-code-session'`、`cookieOptionsForEmailCode(maxAge)`。属性は `cookieOptionsForLoginTwoFactor` と同じ）、`scripts/trace/scope.json`（上の Task 1 の行）
- Test: `tests/unit/features/auth/email-code-session.test.ts`、`tests/unit/api/auth/email-code-{start,verify,resend,cancel}-route.test.ts`、**結合テスト `tests/integration/api/auth/email-code-{start,verify,resend,cancel}.test.ts`（`API-AUTH-029`〜`032` をテスト名の先頭に付ける。1b と同じ形。追跡の「構造設計に結合テスト」を満たすため）**、`e2e/FR-LOGIN-055-email-code-api.spec.ts`
- 文書（同じコミット）: `SR-AUTH-021`（メールのコードのログインと新規。要件 `FR-AUTH-023`）、`API-AUTH-029`〜`032`、`DD-AUTH-059`（`docs/04_DetailDesign/sequence/auth-passkey-customer-screens.md` を**作る**。以降のタスクが足す）、`IMPL-AUTH-295`〜`301`、`SEC-AUTH-048`・`049`・`051` の上位の `THR-AUTH-` は、着手時に既存から選ぶか、無ければ `THR-AUTH-049` 以降を起こす。`SEC-AUTH-048`（列挙の対策・パスワード無しの確認済みアカウント・`email_confirmed_at` を本人の確かめの印として読む所・新規と登録済みの時間の差）・`SEC-AUTH-049`（コードの段の総当たり・保留の Cookie ごとの枠・残る危険）、`ADR-0469`（お客さんのログイン: 画面の作り・メールのコードの流れ・旧画面の退避。以降のタスクで足す）、`docs/03_BasicDesign/areas/auth.md`、台帳

**Interfaces:**
- Produces（Task 4・5・6・10 が使う。名前・形を変えない）:
  - `POST /api/auth/email-code/start` — 本文 `{ email, turnstileToken?, next? }`（`email` は今の `LoginRequestSchema` のメールの規則）。順番: IP の枠（50回/10分、`auth:email-code:send`）→ 本文の形（400）→ Turnstile（403 `Bot detection failed`）→ メール単位の枠（**共有の名前 `auth:email-code:send`**、5回/10分、`subject: email`。IP の枠も同じ名前・50回/10分。調整役の判断 3）→ **登録の有無を調べずに**、`createServiceRoleAuthClient` で `admin.createUser({ email, email_confirm: true, app_metadata: { email_code_signup_pending: true } })`（`email_exists` は握る。`email_address_invalid` は形の誤りと同じ 400。それ以外の失敗は 500 と監査 `supabase_*` の符号）→ `signInWithOtp({ email, options: { shouldCreateUser: false } })`（captcha の拒否は 500、GoTrue の 429 は 429＋`Retry-After`、5xx は 503）→ 保留の Cookie と戻り先の控え（`issueReturnIntent` の `purpose: 'login'`）。**成功は常に 202 `{ step: 'code', message: '確認コードを送信しました。メールに届いたコードを入力してください。' }`**。登録済み・未登録で本文・状態・Set-Cookie の名前と属性が同じ
  - `POST /api/auth/email-code/verify` — 本文 `{ code }`（8桁。今の `OtpVerifyRequestSchema`）。順番: IP の枠（30回/10分、`auth:email-code:verify`）→ 本文（400）→ 保留の Cookie（無ければ 401。画面は「もう一度メールを入れてください」）→ **Cookie ごとの枠**（`auth:email-code:verify`、`subject = email + ':' + jti`、5回/10分）→ 宛先ごとの緩い上限（同じ名前、`subject = email`、20回/10分）。どちらかを使い切ったら Cookie を消して 429→ `createPublicClient().auth.verifyOtp({ email: pending.email, token: code, type: 'email' })`。フックの拒否の印（`isStaffPasskeyRequiredError(error)`）なら 403 `staff_passkey_required`（Cookie は残さず消す。セッション無し）。その他の失敗は 401 `認証コードが無効、または期限切れです。`。成功は `persistSessionAndCookies`（ゲストのカート・お気に入りの引き継ぎつき）→ 印 `email_code_signup_pending` があれば外す（`admin.updateUserById`。失敗は監査の符号だけで続行）→ `linkGuestOrdersByEmail`（今の `otp/verify` と同じ）→ 200 `{ user: { id, email, role }, offerPasskey: boolean, message }`。**`offerPasskey`** は、`role` が `user` で、`listPasskeys(accessToken)`（1b の `passkey-gotrue.ts`）が成功して0本の時だけ `true`（失敗・店員は `false`。閉じる側）。保留の Cookie は消す
  - `POST /api/auth/email-code/resend` — 本文なし。Cookie 必須（401）。IP の枠・メール単位の枠（**始めと同じ名前 `auth:email-code:send`**。10分に始め＋再送で5通まで）→ `signInWithOtp({ shouldCreateUser: false })`。成功は Cookie を新しい期限で付け直す（元の `iat` を引き継ぐ）→ 200。再送の待ちは画面の60秒（サーバーは枠で守る）
  - `POST /api/auth/email-code/cancel` — Cookie を消して 204（今の `login/cancel` と同じ）
  - `emailCodeSession`: `createEmailCodeSessionToken({ email, expiresInSeconds?, issuedAt?, jti? })`（`jti` は乱数。再送で引き継ぐ）、`verifyEmailCodeSessionToken(token)`（`{ purpose: 'email_code', email, jti, iat, exp } | null`）、`readEmailCodeSessionFromCookieHeader(header)`。署名鍵は今と同じ（`LOGIN_2FA_SESSION_SECRET` か `JWT_SECRET`）。`purpose` の値は旧と違うので、**旧い Cookie の値を新しい窓口に渡しても、その逆も `null`**
- **作り手の判断（Task 1）:** 保留の Cookie の名前・登録の流れ・`createUser` の使い方は、上の「作り手の判断 3・4」のとおり。

- [ ] **Step 0: 手元の GoTrue で組み合わせを確かめる（調査。コミットしない）** — 使い捨ての `tsx` スクリプトで、(1) 未登録のアドレスに `admin.createUser({ email_confirm: true })` → `signInWithOtp({ shouldCreateUser: false })` → Mailpit に8桁のコード1通が届く（件名・本文が `magic_link.html` の型）→ `verifyOtp({ type: 'email' })` でセッションが返る、(2) 登録済みのアドレスで `createUser` が `email_exists`（`error.code`）で断られ、続く `signInWithOtp` が同じく成功する、(3) `app_metadata.role` が付かない・`user_roles` の行が作られない（お客さん）、(4) **旧の会員登録（`signUp`）で作って確認していない既存のアドレス**で、`createUser` が `email_exists`、続く `signInWithOtp({ shouldCreateUser: false })` が通るか、届くのがコードかリンク（確認メール）か、を確かめる。リンクが届く場合は、暫定の扱い（「確認のメールのリンクを押してから、もう一度お試しください」を `/login/code` の案内に足し、旧の登録は段4まで残る旨を台帳に書く）を調整役に提案して止まる、を確かめる。**通らない項目があれば止まって調整役へ**（「作り手の判断 3」を組み直す）。結果を `.superpowers/sdd/2026-11-17-passkey-stage2-customers/task-1-spike.md` に控える（値・鍵・コードは書かない）
- [ ] **Step 1: 失敗する試験を書く** — 単体: 保留の Cookie の署名・期限・絶対の上限・旧い Cookie の値が `null`・`userId` を持たない。`start`: 未登録・登録済み（`email_exists`）・店員のアドレスの3つで**本文・状態・Set-Cookie の名前と属性が同じ**、`email_address_invalid` は 400、印 `email_code_signup_pending` が付く、始めと再送が同じ枠で合計5通で 429、Turnstile の失敗（403）で `createUser`・`signInWithOtp` が0回・メール単位の枠が0回、`createUser` の `email_exists` 以外の失敗（500）、captcha の拒否（500）、GoTrue の 429/5xx、戻り先の控えは Cookie だけ・本文に番号が出ない。`verify`: Cookie 無し 401、宛先は Cookie 由来（本文の `email` を無視）、**別の Cookie（別の `jti`）の失敗が本人の Cookie の枠を使わない**、枠を使い切ると Cookie を消して 429、成功で印が外れる（外す失敗でもログインは成功）、フックの拒否（印つき）で 403・Cookie 無し・`persistSessionAndCookies` 0回、コード違いは 401、成功で `offerPasskey`（0本 `true`・1本 `false`・店員 `false`・一覧の失敗 `false`）、`persist` の失敗は 500。`resend`: Cookie 無し 401、`iat`・`jti` の引き継ぎ、枠。`cancel`: 204 と Cookie 消去。E2E（`FR-LOGIN-055`、窓口を `request` で直に呼ぶ。3幅）: 未登録のアドレスで始め→Mailpit のコード→確定でログインでき `/api/auth/me` が本人を返す／同じアドレスをもう一度（登録済み）始めても応答が同じ／間違ったコードは 1〜5回目が 401、**6回目が 429**（窓口は「数えてから確かめる」ので、枠の上限 5 を超えた6回目で `enforceRateLimit` が 429 を返す。Cookie が消え、その後は 401 `セッションの有効期限が切れました。`）／店員（1b の `provisionStaff`）のアドレスで始めは同じ応答、確定は 403 `staff_passkey_required` で Cookie が付かない／旧い保留の Cookie（`setLoginTwoFactorCookie`）を持つ文脈で新しい `verify` が 401。窓口へは `origin: http://localhost:3000` と試験ごとに別の `x-real-ip` を付ける。Turnstile は、今の `FR-LOGIN-035` と同じ道具に合わせる
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/features/auth/email-code-session.test.ts tests/unit/api/auth/email-code-` → FAIL
- [ ] **Step 3: 実装する** — 上のとおり。`login/route.ts`・`otp/verify/route.ts`・`login/resend/route.ts`・`login/cancel/route.ts` の書き方を写す（順番・枠の値・監査の符号の形・`after()` を使わず直に待つ点まで）。旧い窓口・旧い Cookie には一切触れない。`scope.json` を直し `validate-trace` を通す
- [ ] **Step 4: 通ることを確かめる** — 単体・結合 PASS、`FR-LOGIN-055` を3幅 PASS（本番ビルド。3000番を止めてから）。`npm.cmd run typecheck`・`lint`・`npm.cmd test`（単体全件）が変更前と同じ結果。旧窓口の既存の E2E（`FR-LOGIN-008`・`034`・`036`）が緑のまま。**`validate-trace` が `baseline.json` から増えない**・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): メールのコードのログイン窓口を足す（新規も同じ流れ。保留の Cookie は別の名前）`

### Task 2: ブラウザの WebAuthn の部品と、1b の窓口を呼ぶ部品（持ち越し T2 M12・T2 M3・T7 M3）

**Files:**
- Create: `src/features/auth/passkey/webauthn-browser.ts`、`passkey-client.ts`、`device-name.ts`、`post-login.ts`
- Modify: `src/features/auth/schemas/passkey.ts`（`authenticatorAttachment` を `.nullish()`）、`src/app/api/auth/passkey/login/finish/route.ts`・`register/finish/route.ts`（GoTrue へ渡す前に `null` の項目を落とす。部品は `schemas/passkey.ts` に `dropNullFields(credential)` として置く）、`src/lib/auth/passkey-gotrue.ts`（先頭に `import 'server-only'`）、`scripts/trace/scope.json`
- Test: `tests/unit/features/auth/passkey/{webauthn-browser,passkey-client,device-name,post-login}.test.ts`、`tests/unit/features/auth/schemas/passkey.test.ts`（足す）、`passkey-gotrue` を読む既存の単体の試験（先頭に `jest.mock('server-only', () => ({}), { virtual: true })` を足す。`grep -rl "passkey-gotrue" tests` で探す）
- 追加の単体（T2 M3 の守り）: `tests/unit/features/auth/passkey/no-server-imports.test.ts` — `src/features/auth/passkey/**` の画面の部品が `@/lib/auth/passkey-gotrue`・`@/lib/auth/passkey-start-config` を import していないことを、ファイルの文字列を読んで確かめる（1b の `browser-start.ts` の決まりと同じ）
- 文書（同じコミット）: **新しい要件は起こさない**（追跡の決まり: 要件の受け入れ条件には E2E が要るが、Task 2 は E2E を持たない）。`SEC-AUTH-050`（応答の取り扱い・`null` の項目・ログ）と `DD-AUTH-060` は、**Task 2 の中で閉じる鎖**にする（1b の `DD-AUTH-052` の上位が `SEC-AUTH-042` なのと同じ形）: `SEC-AUTH-050` の上位は今ある `THR-AUTH-045`（UV の無い応答・`id` と `rawId` の食い違い。ブラウザの応答の扱いに一番近い。実行者が合わなければ別の既存の `THR-AUTH-` を選ぶ）、`DD-AUTH-060` の上位は `SEC-AUTH-050`。`SEC` に要る子は `DD-AUTH-060` で足り、`DD` に要る単体テストとコードの単位（`@design DD-AUTH-060`）は Task 2 が持つ。**Task 6 が起こす `FR-AUTH-028` とはつながない**（要件の下に DD・SEC は付けられず、Task 2 のコミットで `unknown-parent` になるため）。`IMPL-AUTH-302`〜`305`。`FR-AUTH-024` は欠番（使わない）

**Interfaces:**
- Produces（Task 5・6・7 が使う）:
  - `webauthn-browser.ts`（型 `PublicKeyCredentialRequestOptionsJSON` などは `import type` で `@supabase/supabase-js` の型から読む。`@/lib/auth/passkey-gotrue` を値でも型でも読まない。`server-only` を付けたため、読むとビルドが落ちる）: `isPasskeySupported(): boolean`（`window.PublicKeyCredential` と `navigator.credentials` の両方が在る）、`requestAssertion(options: PublicKeyCredentialRequestOptionsJSON): Promise<AssertionResult>`、`requestAttestation(options: PublicKeyCredentialCreationOptionsJSON): Promise<AttestationResult>`。`AssertionResult` は `{ ok: true; credential: AuthenticationResponseJSON } | { ok: false; reason: 'cancelled' | 'already_registered' | 'unsupported' | 'failed' }`（`AttestationResult` も同形）。`PublicKeyCredential.parseRequestOptionsFromJSON`・`parseCreationOptionsFromJSON` が在れば使い、無ければ自前で base64url を `ArrayBuffer` に直す（`challenge`・`allowCredentials[].id`・`excludeCredentials[].id`・`user.id`）。応答は `credential.toJSON()` が在れば使い、無ければ自前で組む。**どちらも `authenticatorAttachment` が `null` なら項目を落とす**。`NotAllowedError`（中止・時間切れ）→ `cancelled`、`InvalidStateError`（登録済みの鍵）→ `already_registered`、`NotSupportedError`・`SecurityError` → `unsupported`、それ以外 → `failed`。中身（`challenge`・応答）をログに出さない
  - `passkey-client.ts`（`'use client'` で使う関数。`fetch` は注入できる）:
    - `loginWithPasskey(deps: { start: ReturnType<typeof createPasskeyAuthenticationStarter>; assert: typeof requestAssertion; fetchApp?: typeof fetch; next?: string; captchaToken?: string }): Promise<LoginResult>` — 1b の `browser-start.ts` で始め → `assert` → `POST /api/auth/passkey/login/finish { challenge_id, credential, next }`。`LoginResult` は `{ ok: true; user: { id; email; role } } | { ok: false; reason: 'cancelled' | 'unsupported' | 'rate_limited' | 'unavailable' | 'captcha_required' | 'uv_required' | 'not_found' | 'staff_blocked' | 'failed'; retryAfterSeconds?: number }`（401 `passkey_login_failed` → `not_found`、400 `uv_required` → `uv_required`、403 `staff_passkey_required`・`passkey_not_approved` → `staff_blocked`、429 → `rate_limited`、503・502・409 → `unavailable`）
    - `registerPasskey(deps: { fetchApi: typeof clientFetch; create: typeof requestAttestation; deviceName: string }): Promise<RegisterResult>` — `POST /api/auth/passkey/register/start` → `create` → `POST register/finish` → 成功したら `PATCH /api/auth/passkey/{id} { friendly_name: deviceName }`（失敗は握り、`nameApplied: false`）。`RegisterResult` は `{ ok: true; passkey: { id; friendly_name; created_at }; nameApplied: boolean } | { ok: false; reason: 'cancelled' | 'already_registered' | 'unsupported' | 'reauth_required' | 'unauthorized' | 'rate_limited' | 'retry' | 'unavailable' | 'failed' }`（403 `registration_not_allowed` の `reason: reauth_required` → `reauth_required`、401 → `unauthorized`、**GoTrue の失敗に当たる 502・400（`uv_required` を含む）は `retry`、窓口の 503（`passkey_register_unavailable`）は `unavailable`**。上の判断10）
    - `listPasskeys()`・`renamePasskey(id, name)`・`deletePasskey(id)` — `clientFetch` で `GET`・`PATCH`・`DELETE`（CSRF は `clientFetch` が付ける）。戻りは `{ ok: true; ... } | { ok: false; reason: 'unauthorized' | 'not_found' | 'rate_limited' | 'unavailable' | 'failed' }`
  - `device-name.ts`: `deviceNameFromUserAgent(ua: string): string` — `iPhone`・`iPad`・`Android`・`Mac`・`Windows`・`Linux` を含む順に見て、無ければ `この端末`（長さは最大64字に切る）
  - `post-login.ts`: `resolvePostLoginPath(fetchApp?, origin?): Promise<string>` — 旧 `VerifyOtpClient` の同名の関数と同じ規則（401 は `/login`、失敗・読めない本文・`needsMfa` は `/auth/verified`、それ以外は `sanitizeReturnPath`）
- **作り手の判断（Task 2）:** `post-login.ts` を旧 `VerifyOtpClient` から切り出さず新しく置く（旧に触れない。段4で旧と一緒に重複が消える）。`passkey-client.ts` の関数は React を知らない純粋な関数にして、画面の部品が薄くなるようにする。

- [ ] **Step 1: 失敗する試験を書く** — `webauthn-browser`: `navigator.credentials.get/create` を差し替えて、(a) `parse*FromJSON` が在る環境と無い環境の両方で正しい `ArrayBuffer` に直る（既知の base64url で）、(b) **`toJSON()` が `authenticatorAttachment: null` を返しても、戻りの `credential` に `null` が残らない**、(c) 4つの `DOMException` の名前が `reason` に対応、(d) `PublicKeyCredential` が無い環境で `isPasskeySupported() === false`・`requestAssertion` は `unsupported`、(e) ログに `challenge` が出ない。`passkey-client`: 始めの結果ごと（`rate_limited`・`unavailable`・`captcha_required`）と終わりの状態ごとの `reason` の対応、`next` を終わりに渡す、`register` で 403・401・502・400 の対応、PATCH の失敗で `nameApplied: false` かつ `ok: true`、`list`・`rename`・`delete` の対応。`schemas/passkey.test.ts`: `authenticatorAttachment: null` を受け、`dropNullFields` が項目を落とす。`passkey-gotrue` を読む既存の試験が `server-only` を差し替えても通る
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/features/auth/passkey tests/unit/features/auth/schemas/passkey.test.ts` → FAIL
- [ ] **Step 3: 実装する** — 上のとおり。窓口2本は `dropNullFields` を1行足すだけ。`scope.json` を直す
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS。1b の `FR-LOGIN-050`・`051` の E2E（窓口を直に呼ぶ）が緑のまま（3幅。3000番を止めてから）。`typecheck`・`lint`・`npm.cmd test` が変更前と同じ結果。**`validate-trace` が `baseline.json` から増えない**・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): ブラウザのパスキーの部品と窓口を呼ぶ部品を足し、null の項目と server-only を直す`

### Task 3: 旧ログイン・登録の画面を `/login/password` へ退避し、今の試験を守る

**Files:**
- Create: `src/app/login/password/page.tsx`（今の `src/app/login/page.tsx` の中身をそのまま移す。`generateMetadata` の題を `LOGIN | Le Fil des Heures` のまま、`robots: { index: false, follow: false }` を足す）
- Modify: `src/components/AuthTabs.tsx`（`TABS` の `path` を `/login/password` に。タブを替えても URL は `/login/password` のまま）、`src/app/login/page.tsx`（**この段では一時的に旧と同じ中身のまま残す。Task 5 で作り替える**。重複は Task 5 までの間だけ）、旧画面を操作する E2E・単体の試験の URL
- 追加で変える（調整役の判断 2。I-2）: `src/contexts/Providers.tsx`（範囲の外。`isAuthPage` に `/login/password`・`/login/code`・`/login/passkey` を足す。変更は `14_login.md` と `screen-list.md` に書く）、`src/app/login/verify/page.tsx`（Cookie 無しの `redirect` を `/login/password` へ）、`src/app/login/verify/VerifyOtpClient.tsx`（401 と取りやめの `router.replace('/login')` を `/login/password` へ）、`src/components/RegisterModal.tsx`（ログインへのリンク `/login` を `/login/password` へ）、`e2e/account-test-utils.ts` の `loginAndOpenAccount`（`/login` を開いて旧フォームを操作する。16本の spec が使うので `/login/password` へ）、`e2e/helpers.ts` の `registerUser`・`loginUser`（今は使う spec が0本。同じく付け替える）。変えない（お客さんに見せる行き先）: `src/app/api/auth/confirm/route.ts` の `/login`・`/login?registered=1`、パスワード再設定・変更の後の `/login`
- Test: `e2e/FR-LOGIN-056-legacy-login-relocated.spec.ts`（新規。3幅）、`tests/unit/contexts/providers-auth-page.test.tsx`（`isAuthPage` が `/login/password`・`/login/code`・`/login/passkey` で真）、付け替える既存の試験（下の一覧）
- 文書（同じコミット）: `SR-AUTH-022`（ログイン画面。要件 `FR-AUTH-025` 旧画面の退避）、`DD-AUTH-061`、`IMPL-AUTH-306`、`ADR-0469` の足し（退避の理由・段4で消す一覧）、`docs/04_DetailDesign/pages/14_login.md`、台帳（段4の消す一覧）

**Interfaces:**
- Produces: `/login/password`（旧の画面と同じ。保留の旧い Cookie があれば `/login/verify` へ送る）。旧い窓口・`/login/verify`・旧い Cookie は変えない。
- 付け替える試験の見つけ方: `grep -ln "Confirm Password\|getByLabel('Password'\|#password\|会員登録' }\|getByRole('tab'" e2e/*.spec.ts` と、`goto('/login` を含む旧画面の操作の試験を、1本ずつ旧画面の期待かどうか見て決める。**URL を `/login` から `/login/password` に替える以外は、期待を変えない**。`/login?next=…` へ**送られる**ことを確かめる試験（ログインが要るページの行き先の確かめ）は、新しい `/login` に着くので替えない。`/login/password` に着くことを確かめる必要は無い。2026-11-17 に `grep` した旧画面を触る候補（約30本。**`goto(['"`]/login` を起点に1ファイルずつ見る形で確定する。大文字の `PASSWORD`・`EMAIL` のラベルを操作する物は上の grep に当たらない**）。レビューで見つかった漏れ: `FR-LOGIN-003`・`011`・`016`・`028`・`049`、`FR-CHECKOUT-012`、`FR-UI-008`、`login-otp-resend-errors.spec.ts`、手助け `loginAndOpenAccount`（これを使う16本の spec は手助けの直しだけで足りる）。`FR-LOGIN-016`・`017`・`023` は `isAuthPage` の直しで緑のまま。主な候補: `FR-LOGIN-001`・`002`（Google の試験は新しい `/login` に Google のボタンが残るので、先に Task 5 の後で見直す。ここでは触らない）・`006`・`008`・`009`・`012`・`013`・`014`・`015`・`017`・`019`・`020`・`021`・`022`・`023`・`024`・`025`・`026`・`027`・`029`・`031`・`032`・`034`・`035`・`036`・`038`、`FR-SIGNUP-001`〜`003`、`FR-PWRESET-001`・`002`・`009`・`010`（ログイン後の続きを旧画面で行う物）、`FR-CHECKOUT-015`（会員登録への案内の `href`）、`FR-ACCOUNT-046`（`/login` を経由するなら）、`FR-LOGIN-005`（題・説明の期待は Task 5 で扱う）。**実際の一覧は実行者が `grep` と単独の実行で確定し、台帳に書く**。
- **作り手の判断（Task 3）:** `src/app/login/page.tsx` を Task 3 では変えない（理由: 旧と新の切り替えを2つのコミットに分け、Task 3 を「動かして付け替えるだけ」にして差分を読みやすくする）。ただし Task 3 の終わりでは `/login` と `/login/password` が同じ中身になる。

- [ ] **Step 1: 失敗する試験を書く** — `FR-LOGIN-056`: **旧の流れが閉じていること — 旧い保留の Cookie が無い `/login/verify` は `/login/password` へ送られる／旧の入力画面で取りやめると `/login/password` へ戻る／旧の登録の完了画面の「ログインページへ」が `/login/password`**。`/login/password` が旧画面（`Email`・`Password` 欄・`ログイン` と `会員登録` のタブ）で、`tab=register` で会員登録タブが選ばれ、タブを替えても URL が `/login/password` のまま／検索に載らない（`meta robots` が `noindex`）／旧い保留の Cookie（`setLoginTwoFactorCookie`）を持つと `/login/verify` へ送られ、`/login/verify` で入力欄が出る／`/login/password?next=/account` の戻り先が旧のログイン窓口の本文に渡る（今の `FR-LOGIN-038` と同じ確かめ）。単体: `AuthTabs` の `history.replaceState` が `/login/password`、旧の `page.tsx` の単体の試験は新しい置き場を読む
- [ ] **Step 2: 失敗を確かめる** — `FR-LOGIN-056` → FAIL（`/login/password` が無い）
- [ ] **Step 3: 実装する** — 移して、`AuthTabs` を直し、旧画面を操作する試験の URL を付け替える（1本ずつ旧画面の期待かどうかを確かめる）
- [ ] **Step 4: 通ることを確かめる** — 付け替えた E2E と `loginAndOpenAccount` を使う16本を3幅で全部 PASS（本番ビルド。付け替え前の結果と同じ。比べる元は付け替える前の同じ試験の緑）。`FR-LOGIN-056` PASS。`npm.cmd test`・`typecheck`・`lint` が変更前と同じ。**`validate-trace` が `baseline.json` から増えない**・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `refactor(auth): 旧ログイン・登録の画面を /login/password へ退避し、旧画面の試験を付け替える`

### Task 4: コード入力の画面 `/login/code`

**Files:**
- Create: `src/app/login/code/page.tsx`（サーバーで保留の Cookie を確かめ、無ければ `/login` へ送る。確かめない人に HTML を見せない。旧 `login/verify/page.tsx` の書き方）、`src/features/auth/passkey/components/EmailCodeEntry.tsx`（`'use client'`。旧 `VerifyOtpClient.tsx` の動きを写し、窓口の名前だけを新しくする）
- Test: `tests/unit/app/login/code-page.test.tsx`、`tests/unit/features/auth/passkey/email-code-entry.test.tsx`、`e2e/FR-LOGIN-058-email-code-screen.spec.ts`
- 文書（同じコミット）: `FR-AUTH-026`（コード入力の画面。SR-AUTH-021 に属する）、`DD-AUTH-062`、`IMPL-AUTH-307`・`308`、`docs/04_DetailDesign/pages/14_login.md`

**Interfaces:**
- 画面の文（お客さんが読む。brand の声）:
  - 見出し: **「確認コードを入力してください」**
  - 説明: **「{マスクしたメール} に8桁のコードをお送りしました。5分以内に入力してください。」**（マスクは今の `maskEmail`）
  - 入力: 8つの1桁の欄（数字・貼り付けで8桁を割り振る・Backspace で前へ・`autoComplete="one-time-code"`・`inputMode="numeric"`）。ラベルは各欄に「確認コード {n}桁目」
  - ボタン: **「ログイン」**（8桁そろうまで `disabled`）、**「コードを再送する」**（60秒のカウントダウン `formatResendCountdown`。0になるまで `disabled`）、**「メールアドレスを入れ直す」**（取りやめ）
  - 失敗: 401 → **「確認コードが無効、または期限切れです。」**、429 → **「試行が集中しています。しばらくしてからやり直してください。」**（保留は閉じ、`/login` へ）、Cookie 切れ（401 `セッションの有効期限が切れました。`）→ **「時間がたちました。もう一度メールアドレスを入れてください。」** と `/login` へ、403 `staff_passkey_required` → **「店員の方は、パスキーでログインしてください。」**（再送・入力を止め、「ログイン画面へ戻る」だけ）
  - 成功: `offerPasskey && isPasskeySupported()` なら `router.replace('/login/passkey')`、それ以外は `resolvePostLoginPath()` で行き先へ（`router.replace`。戻るで入力画面へ戻れないように）。どちらも先に `refreshAuthState()`（`useLogin()`）で画面の状態を更新する
- フォーカス: 画面を開いたら最初の欄。エラーは `LiveMessage`。送信中は `aria-busy`。
- **作り手の判断（Task 4）:** 旧部品を共有に直さず写す（判断5）。成功の行き先の分岐に `offerPasskey` を使う（検索・一覧の別の呼び出しをせず、確定の窓口の応答だけで決める。理由: 窓口が失敗側に倒れた時に「勧めない」へ静かに退く）。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 8桁そろうまでログインが `disabled`、貼り付けの割り振り、確定の窓口の応答ごとの文言と行き先（401・429・Cookie 切れ・403 staff・`offerPasskey` の真偽・未対応のブラウザで勧めを飛ばす）、再送のカウントダウン（`jest.useFakeTimers`）、取りやめで `cancel` を呼んで `/login` へ。ページ: Cookie 無しで `/login` へ。E2E（`FR-LOGIN-058`、3幅）: `start` を `request` で呼んで Mailpit のコードを読み（`readLatestCode`）→ `/login/code` で入力 → 登録済みの会員は `/` か戻り先へ着く、`offerPasskey` の真偽は `/login/passkey` へ着くかで見る（**偽の側は、Playwright の Chromium では `isPasskeySupported()` が真なので、パスキーを1本持つお客さんを作る**。1a の `provisionPasskeyUser`（`appRole: 'user'`）を使う）（Task 6 が出来るまでは `/login/passkey` の着地だけを確かめ、画面の中身は Task 6）、間違ったコードのエラー、再送の `disabled` の間の表示、取りやめ、Cookie 無しで `/login` へ、390px で入力欄が横にはみ出さない。`loginAsMember` は使わない（この画面そのものを確かめる）
- [ ] **Step 2: 失敗を確かめる** — 単体・`FR-LOGIN-058` → FAIL
- [ ] **Step 3: 実装する** — 旧 `VerifyOtpClient.tsx` から入力・カウントダウンの動きを写し、窓口を `email-code/*` に、成功の行き先を `offerPasskey` の分岐にする。`/login/passkey` はまだ無いので、`offerPasskey` が真で着地する先は Task 6 まで 404 になる点を、この段の E2E では `offerPasskey` が偽の会員で確かめ、真の側は単体だけにする（Task 6 の E2E が通す）
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS、`FR-LOGIN-058` 3幅 PASS。`FR-LOGIN-027`・`034`・`036`（旧の入力画面）が緑のまま。`typecheck`・`lint`・`npm.cmd test`・**`validate-trace` が `baseline.json` から増えない**・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): メールのコードの入力画面 /login/code を足す`

### Task 5: 新しい `/login`（パスキー・Google・メールのコード）

**Files:**
- Modify: `src/app/login/page.tsx`（Task 3 の旧と同じ中身を、新しい画面に置き換える）
- Create: `src/features/auth/passkey/components/LoginChoices.tsx`（`'use client'`。3つの入口を並べる）、`EmailCodeStartForm.tsx`（メール欄・Turnstile・「メールでコードを受け取る」）
- Test: `tests/unit/app/login/page.test.tsx`、`tests/unit/features/auth/passkey/{login-choices,email-code-start-form}.test.tsx`、`e2e/FR-LOGIN-057-login-screen.spec.ts`。既存の `FR-LOGIN-002`（Google）・`FR-LOGIN-005`（題・説明）・`FR-LOGIN-038`（戻り先）を新しい画面に合わせて直す
- 文書（同じコミット）: `FR-AUTH-027`（新しい `/login`）、`DD-AUTH-063`、`IMPL-AUTH-309`〜`312`、`ADR-0469` の足し、`docs/04_DetailDesign/pages/14_login.md`、`docs/03_BasicDesign/ui/screen-list.md`・`screen-flow.md`

**Interfaces:**
- `page.tsx`（サーバー）: 新旧どちらかの保留の Cookie が有効なら、新→`/login/code`、旧→`/login/verify` へ `redirect`。`?next=`（`validateReturnPath` を通った物だけ）、`?email=`（メール欄の初期値。`tab=register` が付いていても同じ画面で、`tab` は読まない）、`?registered=1`（今の固定の案内の文。**確認のメールのリンクを別のブラウザで開いた人**用で、新画面でも出す）を渡す。題と説明: **`LOGIN | Le Fil des Heures`**・**「Le Fil des Heures のログインページです。パスキー、Google アカウント、メールで受け取るコードでサインインできます。」**（`FR-LOGIN-005` の期待を直す）
- 画面（上から。brand の声。見出しは今の画面に無いので足さず、`h1` を視覚的に隠した `ログイン` として置く）:
  1. **「パスキーでログイン」**（主のボタン。`ri-fingerprint-line`）。下に小さく **「この端末の顔認証・指紋・PIN で入れます。」**
  2. `OR`
  3. **「Googleでサインイン」**（今のボタンのまま。`FR-LOGIN-002` の文言を変えない）
  4. `OR`
  5. メール欄（`Email`）、Turnstile（`NEXT_PUBLIC_TURNSTILE_SITE_KEY` がある時）、ボタン **「メールでコードを受け取る」**。下に小さく **「はじめての方も、同じ方法でアカウントを作れます。」**。**オーナーの答え（「オーナーに聞くこと 3」）が (A) の時だけ、その下にもう1行「続けると、[利用規約](/terms) と [プライバシーポリシー](/privacy) に同意したものとします。」（チェック欄は置かない。リンクは `lk-text-xs`・下線）を足す。(B) なら足さない（案: (A)）**
- 状態と文言:
  - パスキー: 待ち（ボタンは `disabled`・`aria-busy`・文字は「確認しています…」）。結果の文（`LiveMessage`）— `cancelled`: **「パスキーでのログインを中止しました。」**（状態の知らせ。赤にしない）、`not_found`: **「このパスキーではログインできませんでした。メールのコードか Google でもログインできます。」**、`uv_required`: **「この端末で本人確認をしてから、もう一度お試しください。」**、`staff_blocked`: **「このパスキーはログインに使えません。」**、`rate_limited`: **「ログインの試行が集中しています。しばらくしてからお試しください。」**（`retryAfterSeconds` があれば「約 N 分後」を足す）、`unavailable`・`captcha_required`・`failed`: **「ただいまパスキーを使えません。メールのコードか Google でログインしてください。」**
  - 未対応のブラウザ（判断12）: ボタンを出さず、**「この端末ではパスキーを使えません。メールのコードか Google でログインできます。」** を一文出す。判定は描画後（`useEffect`）に行う（サーバーの描画と食い違わせない）
  - メール欄: 空・形の誤りは今の `LoginRequestSchema` のメールの規則で止める。送信中は `disabled`。**202 なら `router.replace('/login/code')`**。400 の本文は表示、403 `Bot detection failed` は **「ボット検証を完了してください」**（今と同じ文言）、429 は今の文言、5xx は **「確認コードを送れませんでした。時間をおいてやり直してください。」**。Turnstile は送信のたびに引き直す（ADR-0411）
  - 成功: `refreshAuthState()` → `resolvePostLoginPath()` → `router.replace`。**パスキーのログインでは勧めの画面を出さない**（すでに持っている）
- (b) の配線: `resolveBrowserStartMode() === 'browser'` の時だけ、`createPasskeyAuthenticationStarter({ mode: 'browser', supabase })` と Turnstile のトークンを使う。`server` なら窓口 (a)。単体で両方を通す（判断13）
- **作り手の判断（Task 5）:** 見出しを視覚的に隠すのは、今の画面がタブだけで見出しを持たないため。スクリーンリーダーのためにだけ足す。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 3つの入口と OR の並び、未対応のブラウザでボタンが出ない、パスキー押下から各 `reason` の文言、成功で post-login、`mode: 'browser'` で Turnstile のトークンが無ければ GoTrue を呼ばない、メール欄の送信の各応答、`?next`・`?email`・`?registered=1`、保留の Cookie（新・旧）の redirect。E2E（`FR-LOGIN-057`、3幅。**ここでは本物の仮想の認証器を使わず**、`page.addInitScript` で `navigator.credentials.get` を差し替える）: 3つの入口が見え、`aria-label`・タブ移動の順が正しい／パスキーを押すと `POST /api/auth/passkey/login/start` が1回呼ばれる／`navigator.credentials.get` が `NotAllowedError` で中止の文／`PublicKeyCredential` を消すとボタンが出ず一文が出る／メール欄に入れて送ると `/login/code` へ（`start` は本物。Mailpit にコードが届く）／Google のボタンが今と同じ／390px で一画面に収まり横スクロールが無い／`next` が戻り先として `start` の本文に渡る／旧画面（`/login/password`）が今のまま。**パスキーの本物の往復は Task 6**
- [ ] **Step 2: 失敗を確かめる** — 単体・`FR-LOGIN-057` → FAIL
- [ ] **Step 3: 実装する** — 旧 `LoginModal.tsx` の見た目の部品（`TextField`・`Button`・`LiveMessage`・`useTurnstileWidget`・`AuthForm.css`）を使い、旧 `AuthTabs` は使わない。`page.tsx` を置き換える。`FR-LOGIN-002`・`005`・`038` を新しい画面の期待に直す（Google のボタン・題・説明・戻り先）
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS、`FR-LOGIN-057` 3幅 PASS、直した3本 PASS。**新しい `/login` に着く試験のうち期待を直す物**（`/login?registered=1` の案内を新しい画面で確かめる `FR-SIGNUP-003`、再設定・変更の後に `/login` へ着く `FR-PWRESET-*`・`FR-ACCOUNT-046` など）を、`grep` で1本ずつ探して期待を直し、台帳に書く。旧画面を触る E2E（Task 3 で付け替えた物）が緑のまま。**T4 M1 を早めに確かめる**: `NEXT_PUBLIC_PASSKEY_START_MODE=browser` でビルドして束を調べる（手順は Task 12 Step 3。落ちたらこのタスクの中で直す）。`typecheck`・`lint`・`npm.cmd test`・**`validate-trace` が `baseline.json` から増えない**・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): /login をパスキー・Google・メールのコードの画面に作り替える`

### Task 6: パスキーを作る勧め `/login/passkey` と、本物のブラウザでの往復

**Files:**
- Create: `src/app/login/passkey/page.tsx`、`src/features/auth/passkey/components/PasskeyOffer.tsx`、`e2e/passkey-virtual-authenticator.ts`
- Test: `tests/unit/app/login/passkey-page.test.tsx`、`tests/unit/features/auth/passkey/passkey-offer.test.tsx`、`e2e/FR-LOGIN-059-passkey-offer-real-browser.spec.ts`
- 文書（同じコミット）: `SR-AUTH-023`（コードで入った後の勧めとアカウントのパスキー。要件 `FR-AUTH-028`。`DD-AUTH-064` の上位は、着手時に起こす構造設計（`API`・`DATA` など）か、`THR-AUTH-` の下の `SEC-AUTH-` の中から実行者が選ぶ。Task 2 の `DD-AUTH-060`・`SEC-AUTH-050` はこの要件の下に付けない）、`DD-AUTH-064`、`IMPL-AUTH-313`・`314`、`docs/04_DetailDesign/pages/14_login.md`

**Interfaces:**
- `e2e/passkey-virtual-authenticator.ts`（Playwright の CDP。Chromium だけ）: `addVirtualAuthenticator(page, opts?: { userVerified?: boolean }): Promise<{ authenticatorId: string; cdp: CDPSession; credentials(): Promise<Array<{ credentialId: string }>>; remove(): Promise<void> }>` — `page.context().newCDPSession(page)`、`WebAuthn.enable`、`WebAuthn.addVirtualAuthenticator({ options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: opts?.userVerified ?? true, automaticPresenceSimulation: true } })`。`getCredentials`・`removeVirtualAuthenticator`・`WebAuthn.disable` を包む。RP は `localhost`（手元の GoTrue の設定。1a）。鍵の中身を失敗の文面に出さない
- `page.tsx`: 画面を開いた時点でログインしていなければ `/login` へ（クライアントで `isAuthResolved && !isLoggedIn`）。ログイン済みなら `PasskeyOffer`。`robots: noindex`。
- 店員（`role` が `user` でない）が来た時は、勧めを出さずに `resolvePostLoginPath()` へ送る。`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` が偽の端末にも勧めを出さない（判断12）。失敗の文に、窓口の 503 の `unavailable` を足す: **「ただいまパスキーを作れません。時間をおいてお試しください。」**（Task 7 の追加も同じ文）
- 画面の文:
  - 見出し: **「パスキーを作りませんか」**
  - 説明: **「次回からは、この端末の顔認証・指紋・PIN でログインできます。メールでコードを待つ必要はありません。」** 下に小さく **「あとからでも、アカウントの「ログイン方法」で作れます。」**
  - ボタン: **「パスキーを作る」**（主）、**「あとで」**（副）
  - 作る間: ボタン `disabled`・`aria-busy`・「作成しています…」。成功: **「パスキーを作りました。」**（`LiveMessage`）→ 1.2秒後に自動で行き先へ（短く見せる。「続ける」ボタンも出す）。名前が付かなかった（`nameApplied: false`）なら **「名前は、アカウントのログイン方法から変えられます。」** を足す
  - 失敗の文: `cancelled`: **「パスキーの作成を中止しました。」**、`already_registered`: **「この端末のパスキーは、すでにアカウントに登録されています。」**（「あとで」と同じく先へ進めるボタンを出す）、`retry`・`failed`: **「うまく作れませんでした。もう一度お試しください。」**（「もう一度」で始めから）、`unsupported`: **「この端末ではパスキーを作れません。」**（先へ進むボタンだけ）、`reauth_required`・`unauthorized`: **「もう一度ログインしてください。」** と `/login` へ、`rate_limited`: 今の文言
  - 「あとで」・成功後・先へ進む: `resolvePostLoginPath()` → `router.replace`。毎回のコードのログインのたびに出す（設計 6-1。出さない設定は作らない）
  - 初期フォーカスは見出し（`tabIndex=-1`）
- **作り手の判断（Task 6）:** 自動で進むのを入れる理由は、成功の文を読ませてから先へ進むため。読む時間を奪わないよう「続ける」のボタンを同時に出す。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 各 `reason` の文言と先へ進む手段、`nameApplied`、未ログインで `/login` へ、「あとで」で `resolvePostLoginPath` が1回だけ、作成中の二重押しが1回。E2E（`FR-LOGIN-059`、3幅。**本物の仮想の認証器**）: ①メールのコードで新規のお客さん（未登録のアドレス）としてログイン → `/login/passkey` に着く → 「パスキーを作る」 → 仮想の認証器に鍵が1つ入る → 行き先へ着く ②ログアウト → `/login` → 「パスキーでログイン」 → 入った（**ここが T2 M12 と本物の `toJSON()` の形の証拠**。400 になったら Task 2 の `null` の扱いを直す）③鍵を持つお客さんが、もう一度メールのコードで入ると、勧めの画面が**出ない**（0本ではない）④仮想の認証器を `isUserVerified: false` にして作ると、ブラウザが応答を作らず `NotAllowedError` で止まる（設計 5-3）→ **`register/finish` への要求が0回**・画面は「パスキーの作成を中止しました。」（`cancelled`）・先へ進める。サーバーの UV の門（400 `uv_required`）は1b の `FR-LOGIN-051` が確かめているので、ここで重ねない。`retry` の読み替えは Task 2 の単体。⑤「あとで」で行き先に着き、戻り先（`next`）が使い切られていない状態から post-login が正しく返す⑥未対応のブラウザ（`PublicKeyCredential` を消す）でコードのログインをすると勧めを飛ばして行き先へ。会員ごとに別のアドレス・試験ごとに別の `x-real-ip`。仮想の認証器は試験の終わりで必ず外す。**Playwright の `trace` は `off`**（コード・Cookie が記録に残らないよう。`member-session-helpers.ts` の注意書きと同じ）
- [ ] **Step 2: 失敗を確かめる** — 単体・`FR-LOGIN-059` → FAIL
- [ ] **Step 3: 実装する** — 上のとおり。`FR-LOGIN-058` の `offerPasskey` が真の側の期待（勧めの画面へ着く）をここで足す
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS、`FR-LOGIN-059` 3幅 PASS（本番ビルド）、`FR-LOGIN-057`・`058` 緑。1b の `FR-LOGIN-050`〜`052` が緑のまま。`typecheck`・`lint`・`npm.cmd test`・**`validate-trace` が `baseline.json` から増えない**・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): コードで入った後のパスキーの勧めを足し、本物のブラウザでの往復を試験する`

### Task 7: アカウントのパスキー（一覧・追加・名前・削除）と、パスワードのリンクを外す

**Files:**
- Create: `src/features/auth/passkey/components/AccountPasskeys.tsx`
- Modify: `src/app/account/page.tsx`（`AccountTab` に `"security"` を足し、`normalizeAccountTab`・2つの `TabSegmentControl` の項目に **「ログイン方法」** を追加。お客さん（`userRole === 'user'`）だけに表示。「パスワードを変更」のリンク（`account-actions`）を外す）、`src/app/account/account.css`（必要なら）
- Test: `tests/unit/features/auth/passkey/account-passkeys.test.tsx`、`tests/unit/app/account/**`（既存のアカウントの画面の単体の試験を直す）、`e2e/FR-LOGIN-060-account-passkeys.spec.ts`、`FR-ACCOUNT-046-password-change.spec.ts`（**リンクを押して `/account/password` に着く1本（`FR-AUTH-006-AC-01`）は、期待が必ず変わる**。「アカウントの画面に『パスワードを変更』のリンクが無い」と「`/account/password` を直に開くと画面が使える」の2点に直す。ほかの本は直に開く形で、期待は変えない）
- 文書（同じコミット）: **`docs/02_Requirements/areas/auth.md` の `FR-AUTH-006-AC-01` を書き直す**（「会員ページのリンクから `/account/password` に着く」→「`/account/password` を直に開くと画面が使え、アカウントの画面に『パスワードを変更』のリンクが無い」。判断1）、`FR-AUTH-029`（アカウントのパスキー）、`DD-AUTH-065`、`IMPL-AUTH-315`・`316`、`docs/04_DetailDesign/pages/15_account.md`、`docs/03_BasicDesign/ui/screen-list.md`・`screen-flow.md`

**Interfaces:**
- 画面（タブ「ログイン方法」。`?tab=security`）:
  - 見出し: **「パスキー」**。説明: **「パスキーを登録すると、この端末の顔認証・指紋・PIN でログインできます。」**
  - 一覧（`<ul>`）: 各行に **名前**（なければ「名前なし」）、**「{YYYY年M月D日} に作成」**、使った日があれば **「最後に使った日: {YYYY年M月D日}」**、**「名前を変更」**・**「削除」** のボタン。日付は日本時間
  - 名前の変更: その場で入力欄に切り替え（1〜64字）。**「保存」**・**「キャンセル」**。保存の失敗は **「名前を変更できませんでした。もう一度お試しください。」**
  - 削除: 既存の `ConfirmDialog`。見出し **「このパスキーを削除しますか」**、本文 **「削除すると、このパスキーではログインできなくなります。」**。**最後の1本の時は本文に「最後のパスキーです。削除しても、メールのコードか Google でログインできます。」を足す**（設計 2-2・6-1。最後の1本も消せる）。失敗は **「削除できませんでした。もう一度お試しください。」**
  - 追加: **「パスキーを追加」**。押すと `registerPasskey`（Task 2）。成功は一覧を引き直して **「パスキーを追加しました。」**。`reauth_required`: **「安全のため、メールのコードでもう一度ログインしてから追加してください。」** と、**「メールのコードでログイン」**（`/login?next=%2Faccount%3Ftab%3Dsecurity` へ。今の `useLoginHref` が組む戻り先の形に合わせる）。`already_registered`・`cancelled`・`retry`・`unsupported`・`rate_limited` は Task 6 と同じ文
  - 空: **「パスキーはまだありません。作ると、メールのコードを待たずにログインできます。」** と「パスキーを追加」
  - 読み込み: 今の画面のスケルトン（`animate-pulse`）に合わせる。読み込みの失敗: **「パスキーの一覧を読み込めませんでした。」** と「再読み込み」。401 は今の未ログインのゲートに任せる
  - 対応していないブラウザ（`isPasskeySupported()` が偽）: 一覧と名前・削除は出すが、「パスキーを追加」は無効にして **「この端末ではパスキーを追加できません。」**
- 店員（`admin`・`supporter`）にはこのタブを出さない（判断8）。
- `FR-ACCOUNT-046` との関係: 「パスワードを変更」のリンクだけ外す。`/account/password` の画面と窓口は変えない。画面が直 URL で今も動くことの試験（`FR-ACCOUNT-046` の直に開く形）は段4まで残す（判断1）。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 一覧の描画（名前・日付・最後に使った日）、空・読み込みの失敗・対応していないブラウザ、名前の変更の成功・失敗・1〜64字の確かめ、削除の確認（最後の1本の追加文・失敗・成功で一覧が減る）、追加の各 `reason`、`reauth_required` のボタンの `href`、店員で非表示。アカウントの画面: 新しいタブが4つの隣にあり、`tab=security` で開き、「パスワードを変更」が無い。E2E（`FR-LOGIN-060`、3幅。仮想の認証器）: コードのログインで会員を作る→ `/account?tab=security` →空の文→「パスキーを追加」（**登録のための入り直しの規則（10分以内のコードのログイン）を満たす直後**）→一覧に1本→名前を変更→**2つ目の仮想の認証器を足し、1つ目を外してから**2本目を追加（同じ認証器では `excludeCredentials` で `InvalidStateError`（`already_registered`）になる。`addVirtualAuthenticator` は2つを同時に扱え、`remove()` で個別に外せる）→1本削除（確認の文）→最後の1本を削除（追加の文が出る）→空へ／**Google のログイン経由（`oauth`）の会員に近い状況**として、`amr` に `otp`・`passkey` が無い、または10分より古い会員で追加すると `reauth_required` の文とボタンが出る（古さは、`private`・ログインの時刻を作る道具で作れなければ、窓口の応答を `page.route` で差し替える）／390px で一覧の行が折り返して読め、ボタンが44px以上／`/account/password` が今も開く（リンクは無い）
- [ ] **Step 2: 失敗を確かめる** — 単体・`FR-LOGIN-060` → FAIL
- [ ] **Step 3: 実装する** — 上のとおり。アカウントの画面の変更は、タブの追加とリンクの削除の2点だけ（他を整えない）
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS、`FR-LOGIN-060` 3幅 PASS。アカウントの既存の E2E（`FR-ACCOUNT-*` のうち `/account` を開く物を `grep` で探して流す）と、直した `FR-ACCOUNT-046` が緑。`typecheck`・`lint`・`npm.cmd test`・**`validate-trace` が `baseline.json` から増えない**・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): アカウントにパスキーの一覧・追加・名前・削除を足し、パスワード変更のリンクを外す`

### Task 8: 知らせを送るための DB の関数（移行 G。手元だけ）

**Files:**
- Create: `supabase/migrations/<時刻>_passkey_notification_sending.sql`（移行 G）、`src/lib/auth/passkey-notification-store.ts`（RPC の薄い部品）
- Test: `tests/integration/db/auth_passkey_notification_sending.integration.test.ts`（`describeLocalDb`。1a の `auth_passkey_foundation.integration.test.ts` の書き方）、`tests/unit/lib/auth/passkey-notification-store.test.ts`、`e2e/FR-LOGIN-061-passkey-notification-function-grants.spec.ts`（PostgREST で `anon`・`authenticated` が呼べず `service_role` が呼べる。1a の `FR-LOGIN-045` と同じ形。3幅）
- 文書（同じコミット）: `SR-AUTH-024`（知らせを送る。要件 `FR-AUTH-030`）、`DATA-AUTH-019`、`DD-AUTH-066`、`IMPL-AUTH-317`（`passkey-notification-store.ts`）、`SEC-AUTH-051`、`docs/03_BasicDesign/areas/auth.md`、`docs/06_Operations/db-migrations.md`（移行 G の節に、ファイル・大きさ・MD5・戻し方・「本番未適用」。「段3まで `db push` しない」一覧に足す。これで7本）、台帳

**Interfaces:**
- Produces（Task 9 が使う。どれも `SECURITY DEFINER`・`SET search_path = ''`・持ち主 `postgres`・`service_role` だけが `execute`。`public`・`anon`・`authenticated` から外す）:
  - 表 `private.passkey_notification_outbox` に列を足す: `lease_token uuid`、`lease_expires_at timestamptz`、`last_error_code text`（`^[a-z0-9_]{1,64}$`）、`sent_at timestamptz`、`finished_at timestamptz`。`CHECK ((status = 'sending') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))`（今の表の `status` の取りうる値に `sending` が既に在る）。既存の行は `pending` のまま
  - `public.claim_passkey_notification(_lease_seconds integer) returns table (id uuid, seq bigint, user_id uuid, kind text, passkey_id uuid, friendly_name text, subject_is_staff boolean, notify_subject boolean, subject_email text, occurred_at timestamptz, attempts integer, lease_token uuid)` — 期限切れの担当（`sending` で `lease_expires_at <= now()`）を `retry_wait`（9回目なら `dead`）に戻してから、`status IN ('pending','retry_wait') AND next_attempt_at <= now()` の最古（`seq` 順）の1行を `FOR UPDATE SKIP LOCKED` で取り、`status = 'sending'`・`attempts + 1`・新しい `lease_token` を付けて返す。`_lease_seconds` は 30〜900（外は `22023`）
  - `public.complete_passkey_notification(_id uuid, _lease_token uuid) returns boolean` — 担当の印が合う時だけ `sent`・`sent_at`・`finished_at`。合わなければ `false`
  - `public.fail_passkey_notification(_id uuid, _lease_token uuid, _error_code text, _retry_after_seconds integer) returns boolean` — 担当の印が合う時だけ、`attempts` が9以上なら `dead`（`finished_at`）、そうでなければ `retry_wait`・`next_attempt_at = now() + max(_retry_after_seconds, 2^(attempts-1) 分)`（注文のメールの `order_email_retry_delay` と同じ考え。揺らぎは付けない）。`last_error_code` を書く
  - `public.skip_passkey_notification(_id uuid, _lease_token uuid, _reason text) returns boolean` — 宛先が無い行を `skipped`
  - `public.passkey_notification_recipients(_id uuid) returns table (email text, audience text)` — `audience` は `subject`（`notify_subject` が真で `subject_email` がある本人。**お客さんなら `subject_customer`・店員なら `subject_staff`**）と `admin`（`subject_is_staff` が真の時だけ、有効で期限内の `admin` の役割（`public.user_roles` と `public.roles`。サポーターは含めない）のメール。`auth.users` から読む）。同じアドレスは1つにまとめ、**`subject` を先に**（本人が店長でも `subject_staff` の文面が優先）。メールが空の行は返さない
- 前の確かめ（`DO`）: 1a の `private.passkey_notification_outbox`・`public.user_roles`・`public.roles`・`auth.users` が在る。末尾に権限・属性の確かめ（1a の移行 A と同じ形）。**戻し方**を頭に書く（列の `DROP COLUMN`・5つの関数の `DROP`）
- **作り手の判断（Task 8）:** 再試行の間隔は注文のメールと同じ考え（1・2・4…分）にし、揺らぎは付けない（理由: 宛先が少なく、同時の取り合いが無い）。死んだ行（`dead`）を店へ知らせる点検は、段2では作らない（段3の店長への知らせと同じ道で作る）。台帳の持ち越しに書く。

- [ ] **Step 1: 失敗する試験を書く** — DB 結合: (a) `claim` は最古（`seq` 順）の due の行だけを返し、`next_attempt_at` が未来の行・`sent`・`dead` を返さない、担当中の行を2回目の `claim` が返さない、期限切れの担当が戻って再び取れ、9回目で `dead` になる、`_lease_seconds` の範囲外が `22023`、(b) `complete` は印が合う時だけ `true`・合わない時は `false` で行が変わらない、(c) `fail` は `retry_wait`・`next_attempt_at` が `2^(attempts-1)` 分以上先、`_retry_after_seconds` が大きければそちら、9回目で `dead`、(d) `skip`、(e) `recipients`: お客さん（本人のメールだけ・`subject_customer`）、店員（本人 `subject_staff` ＋有効な全 admin、サポーター・期限切れ・`active=false` の admin は含まない、本人が admin なら1つ・`subject_staff`）、`notify_subject` が偽（ユーザー削除の連鎖）で本人が含まれない・admin だけ、メールが空の行を返さない、(f) 4つの関数が `anon`・`authenticated` で呼べず `service_role` で呼べる、関数の属性、(g) 1a の引き金が積んだ行（`INSERT`・`DELETE`）を `claim` で取れる。単体: 各 RPC が正しい名前・引数で呼ばれ、誤り・例外で `{ ok: false }`
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest --config jest.config.cjs tests/integration/db/auth_passkey_notification_sending.integration.test.ts` → FAIL
- [ ] **Step 3: 移行を書く** — 1取引。関数は `CREATE OR REPLACE`。サイズと MD5 を `db-migrations.md` に書く（LF・BOM なし・ASCII の確かめ）
- [ ] **Step 4: 通ることを確かめる** — `db reset` の後に同じ試験が PASS。1a・1b の `auth_passkey_*` の DB 結合が全部 PASS のまま。`FR-LOGIN-061` 3幅 PASS。**`validate-trace` が `baseline.json` から増えない**・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): パスキーの知らせを取り出して送るための DB の関数を足す（手元だけ）`

### Task 9: 知らせの文面と送り手を作り、毎分の定期処理につなぐ

**Files:**
- Create: `src/lib/auth/passkey-notification-compose.ts`、`src/lib/auth/passkey-notification-worker.ts`
- Modify: `src/lib/stripe/webhook-worker.ts`（範囲の外。追跡の worker の後・点検の前に、知らせの worker を1段足す。順番の変わりは `docs/04_DetailDesign/sequence/` の該当の文書に書く）、`src/app/api/cron/process-stripe-webhooks/route.ts`（`runWebhookWorker({ requestUrl, passkeyNotifications: true })`。`webhook/stripe` の `after()` は偽のまま）、`playwright.config.ts`（`FR-LOGIN-062` を `isolated-global` に入れ、chromium の `testIgnore` の正規表現にも足す）、`scripts/e2e/passkey-staff.ts`（`registerAndApprove`・`addUnapprovedPasskey` の終わりと、利用者・鍵を消す道具の前で、その利用者の知らせの行を `skipped` にする。`keepNotifications` の口）、`e2e/admin-session-test-utils.ts`・`e2e/news-test-utils.ts`（鍵を足す・消す道具が上の道具を通らない所があれば同じ1行）、`scripts/trace/scope.json`・`docs/03_BasicDesign/decisions/README.md`（上の Global Constraints の Task 9 の行）
- Test: `tests/unit/lib/auth/passkey-notification-{compose,worker}.test.ts`、`tests/unit/lib/stripe/webhook-worker*.test.ts`（既存の試験に足す）、`e2e/FR-LOGIN-062-passkey-notification-mail.spec.ts`
- 文書（同じコミット）: `FR-AUTH-031`（知らせを送る）、`DD-AUTH-067`、`IMPL-AUTH-318`〜`321`、`ADR-0470`（知らせの送り手: 注文のメールの送り手・定期処理を共用する／別の worker にする理由／宛先ごとの重複防止の鍵）、`SEC-AUTH-051` の足し、`docs/03_BasicDesign/areas/auth.md`、台帳

**Interfaces:**
- `passkey-notification-compose.ts`: `composePasskeyNotification(input: { kind: 'passkey_added' | 'passkey_removed' | 'passkey_key_replaced'; audience: 'subject_customer' | 'subject_staff' | 'admin'; friendlyName: string | null; occurredAt: Date; subjectEmail: string | null; contactUrl: string }): { subject: string; text: string }`。**テキストだけ**（HTML なし。注文のメールと同じ）。日時は日本時間 `YYYY年M月D日 H:mm（日本時間）`。名前が無ければ「名前なし」。`subjectEmail` は **`admin` の文面にだけ**入れる（お客さん・本人の文面には入れない）。文面（確定案。オーナーが「オーナーに聞くこと 1」で確かめる）:
  - **お客さん（`subject_customer`）**
    - `passkey_added`: 件名 **「パスキーが追加されました」**
      本文:
      ```
      Le Fil des Heures をご利用いただき、ありがとうございます。

      ご登録のアカウントに、パスキーが追加されました。

      名前: {名前}
      日時: {日時}

      ご自身で追加された場合は、このメールへのご対応は必要ありません。
      心当たりがない場合は、お手数ですが、すぐに次のお問い合わせからご連絡ください。
      {contactUrl}
      ```
    - `passkey_removed`: 件名 **「パスキーが削除されました」**、本文は上の「追加」を「削除」に（「ご登録のアカウントから、パスキーが削除されました。」「ご自身で削除された場合は…」）
    - `passkey_key_replaced`: 件名 **「パスキーの内容が変更されました」**、本文 **「ご登録のアカウントのパスキーの内容が、通常の操作では行われない方法で変更されました。」** 以降は同じ。心当たりが無い場合の案内は「すぐに」を保つ
  - **店員（`subject_staff`。本人）**: 件名と最初の文は同じ。末尾を **「ご自身で行われた操作でない場合は、すぐに店長へお知らせください。」** に替える（`contactUrl` は入れない）
  - **店長（`admin`）**: 件名 **「店員のパスキーが追加されました」**（`removed`: 「…削除されました」、`key_replaced`: 「店員のパスキーの内容が変更されました」）。本文は **「{subjectEmail} のパスキーが追加されました。」**・名前・日時・**「本人の操作か確認してください。心当たりがない場合は、そのアカウントのログインを止めてください。」**
  - すべて、絵文字・感嘆符・急かす言葉・専門語を使わない。署名は付けない（注文のメールの形に合わせる。実装者は `order-email-compose.ts` の宛名・結びの決まりを確かめ、注文のメールと違う宛名の使い方になっていれば揃えて調整役へ知らせる）
- `passkey-notification-worker.ts`: `runPasskeyNotificationWorker(options?: { budgetMs?: number; maxRows?: number; deps? }): Promise<{ claimed: number; sent: number; retried: number; dead: number; skipped: number; stopped: 'idle' | 'budget' | 'config' | 'disabled' | 'claim_error' }>`。既定の予算は **3秒・20行**（呼び手が残りから決めた値を渡す。調整役の判断 5）。順番: 注文のメールと同じ停止の決め（`orderEmailWorkerDisabledReason`）が真なら何も取らずに `stopped: 'disabled'`、`checkOrderEmailSendConfig()` が `null` でなければ `stopped: 'config'` → `claim` → `recipients` → 宛先ごとに `composePasskeyNotification` → **`sendOrderEmailMessage({ to, subject, text, idempotencyKey: 'passkey-notification/<行の id>/<宛先のアドレスの SHA-256 の先頭16文字>' })`**（注文のメールの送り手を共用。宛先ごとの鍵なので、再試行しても同じ宛先に2通目が出ない（Resend の24時間の重複防止の中）） → 全宛先が成功なら `complete`、宛先が0なら `skip`、1つでも**一時的な**失敗なら残りの宛先も試してから `fail`（`retryAfterSeconds` は最大の物、`error_code` は最初の失敗の符号）。**恒久の失敗（`classifyResendError` の分けで、宛先の誤りなど。送り直しても通らない物）はその宛先だけ飛ばし、一時的な失敗が無ければ行は `complete`**（壊れた1つの admin のアドレスで行が9回回って `dead` にならない）。**1行の宛先を送る間も予算を見て、越えたら残りの宛先を送らず、その行を `fail` で次へ回す**（Resend では宛先ごとの鍵があるので、次の回で送った分は2通目にならない。手元の送り手は鍵を使わないので、E2E では重なる。判断4）。`checkOrderEmailSendConfig` の失敗・送り手の `config` の失敗は、その場で止める（`stopped: 'config'`）。文面の `contactUrl` は `checkSiteUrlForEmail` を通した `/contact`（注文のメールの worker の書き方に合わせる）。例外は握り、`claim` の失敗は `claim_error`。ログに宛先のアドレス・本文を出さない
- `webhook-worker.ts`: **追跡の worker の後・点検の前**に、同じ形の `try/catch` で `runPasskeyNotificationWorker({ budgetMs: min(3000, 60_000 − 経過 − 15_000) })` を呼ぶ（1秒未満なら呼ばない。`passkeyNotifications` が真の時だけ。調整役の判断 5）。投げても点検を止めない。戻り値の型に `passkeyNotifications` を足す。**注文のメールの worker と追跡の worker の挙動・予算の計算は変えない**。`WORKER_TIME_BUDGET_MS` の注記に1行足す
- **作り手の判断（Task 9）:** 別の定期処理を作らず `process-stripe-webhooks` に1段足す（理由: 毎分の入口が既に在り、`pg_cron` の登録を増やさずに済む。本番の登録は段3で当てる移行 G と一緒に動くので、「本番に何も当てない」にも合う）。送り手（`sendOrderEmailMessage`）を共用する名前の引っかかり（`OrderEmail`）は、直さず ADR-0470 に書く（理由: 注文のメールの7つの試験に触れたくない）。

- [ ] **Step 1: 失敗する試験を書く** — 文面: 3つの種類×3つの宛先の9通りの件名・本文を**文字列で**固定（上の文面。`subjectEmail` がお客さん・本人の文面に出ない、`admin` の文面にだけ出る、日時が日本時間、名前が無い時の「名前なし」、制御文字・改行を含む名前が1行に収まる（`friendlyName` は GoTrue を直に叩けば店員が自由に書ける文で、店長あてのメールにも入る。**64字で切り、`schemas/passkey.ts` の `NAME_FORBIDDEN_CHARS` と同じ制御文字・表示の向きを変える文字を除き、改行を空白に替える**））。worker: 設定が無ければ `claim` が0回、宛先ごとの重複防止の鍵が行ごと・宛先ごとに固定で、**同じ宛先に2通目を出す呼び出しが再試行で同じ鍵**（鍵の確かめは単体だけ。手元の送り手 `MAIL_PROVIDER=local` は鍵を使わない）、恒久の失敗の宛先だけ飛ばして `complete`、1行の宛先を送る間の予算切れ、停止の決め（`disabled`）で `claim` が0回、全成功で `complete`、一部失敗で残りも試して `fail`（`retryAfterSeconds` の最大）、宛先0で `skip`、9回目の失敗で `dead`（`fail` の返し）、予算と最大行数で止まる、`claim` の失敗で `claim_error`、送り手の `config` で `config`、ログにアドレスが出ない。`webhook-worker`: 知らせの worker が投げても、注文のメールの worker・追跡の worker・点検が動く。**35秒＋10秒を使い切った時は知らせの worker を呼ばない**。`passkeyNotifications: false`（`after()` の道）では呼ばない。E2E（`FR-LOGIN-062`、3幅）: **`isolated-global`（直列）で流す**。**先に** 手元の DB だけ（`E2E_LOCAL_DB_URL`）で (a) `UPDATE private.passkey_notification_outbox SET status = 'skipped' WHERE status IN ('pending','retry_wait')`、(b) この試験が作る店員以外の E2E の admin（`passkey-staff-%@example.com`・`e2e-window-%@example.com` など）の `user_roles.active` を `false` にする（他の試験が終わった後なので干渉しない）→ お客さんがパスキーを追加（仮想の認証器。Task 6 と同じ入口）→ `POST /api/cron/process-stripe-webhooks`（`CRON_SECRET`。`e2e/order-email-test-utils.ts` の呼び方）→ Mailpit にそのアドレス宛の「パスキーが追加されました」が1通で、本文に名前・日時があり**他のアドレスが無い** → 名前を変えて削除 → 「パスキーが削除されました」が1通 → もう一度 cron を呼んでも2通目が出ない（行が `sent` のままで取り直されない。送り手の重複防止の鍵の確かめは単体だけ）／店員（1b の `provisionStaff` で admin 2人）の1人がパスキーを足すと、本人に店員の文面・もう1人の admin に店長の文面（本人のアドレス入り）が届き、**サポーターには届かない**／Mailpit 以外へは送られない（見張り）
- [ ] **Step 2: 失敗を確かめる** — 単体 → FAIL
- [ ] **Step 3: 実装する** — 上のとおり。`scope.json`・`decisions/README.md` を直す
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS、`FR-LOGIN-062` 3幅 PASS（3000番を止めてから）。注文のメールの既存の E2E（`e2e/order-email-test-utils.ts` を使う物。`grep` で探す）と、`loginAsMember` を使う代表の数本が、**広がる行をわざと作った状態**（役割を付けた店員に `elevateAdminSessionToAal2` で鍵を足し、さらに鍵を1本消す。skip の道具を通さずに作る）でも緑のまま。調整役の全件で、Mailpit の通数・知らせの行の数が溢れていないことを確かめる。`typecheck`・`lint`・`npm.cmd test`・**`validate-trace` が `baseline.json` から増えない**・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): パスキーの足し・消し・差し替えの知らせを送る（お客さん・店員・店長の文面）`

### Task 10: `loginAsMember` を新しいメールのコードの窓口に付け替える

**Files:**
- Modify: `e2e/member-session-helpers.ts`（**今の `loginAsMember` の中身を `loginAsMemberLegacy` として残す**。`loginAsMember` は `/api/auth/email-code/resend`・`/api/auth/email-code/verify`・新しい保留の Cookie にする）、旧の窓口の性質を確かめる6本（`FR-LOGIN-030`・`031`・`032`・`033`・`FR-PWRESET-010`・`FR-ACCOUNT-046`）の import を `loginAsMemberLegacy` に、`e2e/auth-2fa-test-utils.ts`（`setEmailCodeSessionCookie(page, email)` を足す。署名は `createEmailCodeSessionToken`。旧 `setLoginTwoFactorCookie` は旧画面の試験が使うので残す）
- Test: 付け替えの後に、代表の E2E 8本（下）を3幅で、続いて調整役が全件
- 文書（同じコミット）: **要件・DD・IMPL は起こさない**（試験の道具は要件ではなく、`e2e/member-session-helpers.ts` は AUTH の `src` の範囲の外のため。追跡の決まりを満たせない）。台帳と `docs/05_Quality/tests/test-spec.md` に書くだけにする。`FR-AUTH-032`・`DD-AUTH-068`・`IMPL-AUTH-322` は欠番（使わない）

**Interfaces:**
- `loginAsMember(page, member, forwardedFor?)` の**外から見える形は変えない**（`loginAsMember` を使う spec は17本と手助け2つ（`delivery-tracking-test-utils.ts`・`return-request-test-utils.ts`）: `FR-ACCOUNT-033`・`034`・`046`、`FR-ADMIN-MISC-008`、`FR-CART-023`・`024`、`FR-CHECKOUT-046`・`047`、`FR-HOME-022`、`FR-LOGIN-030`・`031`・`032`・`033`・`037`、`FR-PRIVACY-006`、`FR-PWRESET-010`、`FR-WISHLIST-016`）。中身だけ: `setEmailCodeSessionCookie` → `readMailpitMessages` → `email-code/resend` → `readLatestCode` → `email-code/verify`（`offerPasskey` は無視）→ Cookie 4つと `/api/auth/me` の確かめ（今のまま）。**`createTestMember` は変えない**（`password` 付きで作る。旧画面の試験が使う）。
- 代表の8本（実行者が流す）: **新しい `loginAsMember` の側**: `FR-CHECKOUT-046`（今の注意書きの対象）、`FR-ACCOUNT-033`、`FR-ACCOUNT-034`、`FR-CART-023`、`FR-LOGIN-055`。**旧のまま残す側（`loginAsMemberLegacy`）**: `FR-LOGIN-030`、`FR-ACCOUNT-046`、`FR-LOGIN-031`（付け替えの前後で緑のまま）。`FR-PRIVACY-006`・`FR-LOGIN-037`・`FR-ADMIN-MISC-008` は実行者が中身を読んで旧か新かを決め（調整役の判断 1）、台帳に書く。
- **作り手の判断（Task 10）:** 1つのコミットに分けて独立に戻せるようにする。全件で、付け替え前より悪くなるなら、このコミットだけを戻し、`loginAsMember` は段4で付け替える。

- [ ] **Step 1: 失敗する試験を書く** — `e2e/member-session-helpers.ts` に単体の試験は無い（試験の道具）。付け替え前の代表の8本が緑であることを先に記録する
- [ ] **Step 2: 付け替える** — 上のとおり
- [ ] **Step 3: 通ることを確かめる** — 代表の8本を3幅で PASS（本番ビルド。3000番を止めてから）。`npm.cmd run typecheck`・`lint`。**全件は調整役が流す**（比べる元と同じ集合の中に収まること）
- [ ] **Step 4: コミット** — `test(auth): 会員のログインの手助けを新しいメールのコードの窓口に付け替える`

### Task 11: 運用の文書・本番に出さない記録・要求の整理

**Files:**
- Modify: `docs/06_Operations/supabase-auth-config.md`（メールのコードの型 `magic_link` の本文に `{{ .Token }}` が在ること・8桁・5分に、新しい流れも頼っている旨。**手元の確認**: 新しい `createUser` → `signInWithOtp` の組み合わせが「Confirm email ON」のままで動く。本番で試す物は段3の確認の一覧に足す）、`docs/06_Operations/db-migrations.md`（Task 8 で書いた移行 G の確認と、「段3まで `db push` しない」一覧が7本であること）、`docs/06_Operations/first-admin-bootstrap.md`（この master を本番にデプロイしない旨の再確認）、`docs/02_Requirements/areas/auth.md`（`SR-AUTH-021`〜`024`・`FR-AUTH-023`・`025`〜`031`の各受け入れ条件を、試験の名前と合わせる。`FR-AUTH-024`・`032`・`033` は欠番）、`docs/05_Quality/security/threats/auth.md`（`SEC-AUTH-048`〜`051` の脅威の節）、`docs/03_BasicDesign/ui/screen-list.md`・`screen-flow.md`（`/login`・`/login/code`・`/login/passkey`・`/login/password`・アカウントのログイン方法）、`docs/05_Quality/tests/test-spec.md`（手で書く。新しい E2E を追加）、台帳 `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md` の状態欄と**段3・段4への持ち越し**（下）
- Test: なし（文書だけ）。`npm.cmd run validate-docs`・`validate-trace`・`test:trace-coverage`・`trace:report`（`docs/05_Quality/reports/` を作り直す）
- 文書（同じコミット）: **新しい要件は起こさない**（運用の決めには E2E の受け入れ条件を付けられない）。運用と本番に出さない決めは `ADR-0469` の「結果」と `docs/06_Operations/` に書く。範囲の外のファイル（`src/lib/cookie.ts`・`src/contexts/Providers.tsx`・`src/lib/stripe/webhook-worker.ts`）の変更の正本は `docs/04_DetailDesign/sequence/` の該当の文書に書く（CLAUDE.md の「範囲に入っていない領域」の表）

**台帳に書く、段2から先への持ち越し:**
- 段3へ: 店員のパスキーの画面（管理画面。登録の窓・2本・削除の下限の画面）、店長への「やり直しを出した」の知らせ、死んだ知らせ（`dead`）を店へ知らせる点検、本番の `pg_cron` と移行 G の適用、Google の拒否の画面、1b の `M-1`（昇格・入り直し）、**1b の最終レビュー M-2（ログインの終わりで `endAuthSession` の失敗を監査に残す。`src/app/api/auth/passkey/login/finish/route.ts`。任意の指摘で、段2の狙いと関係が無いので段2では取らない）**。**本番で確かめること**（8-2）に、今の `createUser` → `signInWithOtp` の組み合わせ、メールのコードの型、`(b)` の切り替えの実機の確認を足す。**8-2 に1行足す**: 段2からはサインイン・サインアップの IP ごとの枠（5分30回。`docs/06_Operations/supabase-auth-config.md` の「店の全員で分け合う」）がお客さんの新規と予備の主な道になるので、`/otp` にも `Sb-Forwarded-For` を添えられるか（`createServiceRoleAuthClient` は今 `SUPABASE_SERVICE_ROLE_KEY` を使う。`sb_secret_` に替える要否）を確かめる
- 開店前へ: **一度も入らなかったメールのコードのアカウントの後始末**（印 `email_code_signup_pending` が付いたまま24時間を過ぎ、**一度もログインしていない（`last_sign_in_at IS NULL`）**、注文の無い利用者を消す定期処理。印は確定でだけ外れ、外す失敗は続行する・印の付いた人が後で Google で入ると印が残るので、`last_sign_in_at IS NULL` が無いと本当のお客さんを消しうる。選ぶ SQL を `docs/06_Operations/` に書く。調整役の判断: 段2では作らない。理由は判断3）
- 段4へ: 消す物の一覧（`loginAsMemberLegacy`・`/login/password`・`/login/verify`・`/api/auth/login/{route,resend,cancel}`・`/api/auth/otp/verify`・`/api/auth/register`・`/api/auth/confirm` の登録の確認・`/account/password`・`/api/auth/password/*`・`AuthTabs`・`LoginModal`・`RegisterModal`・`VerifyOtpClient`・旧の保留の Cookie `sb-login-2fa-session`・`login-2fa-session.ts`・付け替えた約30本の E2E と `setLoginTwoFactorCookie`・`FR-ACCOUNT-046`・`FR-PWRESET-*`・`FR-SIGNUP-*`）。`createTestMember` の `password` 付きの作り方を外す

- [ ] **Step 1: 書く** — 上の文書を、実際のコードと試験の名前に合わせる（推測で書かない。各 ID は `grep` で在ることを確かめる）
- [ ] **Step 2: 確かめる** — `npm.cmd run validate-docs`・`validate-trace`・`test:trace-coverage`・`trace:report`。`docs/README.md` から新しい文書へのリンクが切れていない
- [ ] **Step 3: コミット** — `docs(auth): 段2の運用・要求・画面の文書を整え、段3・段4への持ち越しを台帳に書く`

### Task 12: 段2の全体の確かめ（持ち越し T4 M1 を含む）

**Files:** なし（確かめと記録だけ。直す物があれば、そのタスクの形でコミットを分ける）。結果を `.superpowers/sdd/2026-11-17-passkey-stage2-customers/final-check.md` に書く。

- [ ] **Step 1: 静的・単体・DB 結合** — `npm.cmd run typecheck`・`lint`・`npm.cmd test`（単体全件）・DB 結合（手元の Supabase を `db reset` した後。3000番を止める）。変更前と同じ結果
- [ ] **Step 2: 追跡・文書** — `npm.cmd run validate-trace`・`test:trace-coverage`・`validate-docs`・`trace:report`
- [ ] **Step 3: T4 M1（`NEXT_PUBLIC_PASSKEY_START_MODE=browser` がブラウザの束に入る）** — **別の `.next` で**確かめる。3000番を止め、`.next` を消す。`$env:NEXT_PUBLIC_PASSKEY_START_MODE='browser'; npm.cmd run build` の後、`.next/static/chunks/*.js` に `NEXT_PUBLIC_PASSKEY_START_MODE:"browser"`（ミニファイ後の形。ゆれがあれば、`passkey-start-mode` の呼び出しの引数の中に `"browser"` が入っている形）を `Select-String` で探す。見つかれば PASS。**見つからなければ T4 M1 は失敗**（`browser-start.ts` の読み方を直して、Task 5 のコミットとして直す）。環境変数を戻し、`.next` を消す。**設定が `server`（既定）のビルドで、同じ場所に `"browser"` が入らない**ことも確かめる
- [ ] **Step 4: E2E の全件（調整役のみ）** — 3000番を止め、`.next` を消し、`npm run test:e2e`（本番ビルド）。比べる元と比べる。**新しい赤が無い**こと。付け替えた旧画面の試験・`loginAsMember` を使う試験が緑のままであること。赤は、1つずつ「単独の再実行 → 他の幅 → 種類」の順で切り分けて記録する
- [ ] **Step 5: 本物の手元の確認（目で見る。調整役）** — 手元の Supabase とアプリで、(1) `/login` の3つの入口が390px・1280px で崩れていない、(2) メールのコードで新規のアドレスから入り、勧めの画面で作る→ログアウト→パスキーで入る（Chrome の本物の仮想の認証器でなく、開発の PC の顔認証・指紋・PIN（Windows Hello など）で1回。手元の RP は `localhost` でスマホは入れないので、別の端末での確かめは 8-2 の本番の住所の後）、(3) アカウントの「ログイン方法」、(4) Mailpit に知らせが届く、の4点。結果の記録だけ（本番には触れない）
- [ ] **Step 6: 記録** — `final-check.md` に、結果・比べた数・直した物・段3への持ち越しを書く。台帳の状態欄を更新する。**push は調整役がオーナーの許可を得て行う**

---

## セルフレビュー

**1. 設計書との対応（段2の行・6-1・5-4・5-5・9）**

| 設計書の要求 | タスク |
| --- | --- |
| 4-2 段2: ログインの画面（パスキーのボタン・Google・メールのコード） | 5 |
| 6-1: パスキーはボタンで始める（conditional UI を使わない）。Turnstile は付けない（(a)）。(b) の時だけ見えない形 | 2・5（(b) は配線と単体まで。判断13） |
| 6-1: メールのコード（メール → Turnstile → 8桁・5分 → ログイン）。未登録なら作る。応答を変えない（SEC-AUTH-016）。ADR-0400〜0402 を「コードの段だけ」に作り直す | 1・4・5 |
| 6-1: 今の登録の画面のパスワード以外の欄（同意など）をこの流れへ | 調べた結果、**今の登録画面にはメールとパスワード・確認以外の欄が無い**（`RegisterModal.tsx`、`RegisterRequestSchema`）。移す物は無し。台帳に1行書く（Task 11） |
| 6-1: コードで入って0本なら「作る / あとで」。毎回。UV 必須・名前は端末名 | 4・6（UV は1b の窓口が必須にする。名前は判断9） |
| 6-1: アカウントのパスキーの一覧・名前・削除・追加。最後の1本も消せる | 7 |
| 6-1: 今の `/account/password` は消す（4-2 は段4） | 判断1で決めた（リンクは段2、画面と窓口は段4） |
| 6-1: Google は今のまま（コード無し） | 5（ボタンは変えない）。`FR-LOGIN-002` の期待は変えない |
| 5-4: 知らせ（お客さん=本人、店員=本人＋有効な店長全員。文面は分ける。数分の遅れ） | 8・9（判断6） |
| 5-5: お客さんの登録は10分以内のパスキーかメールのコード | 1b の窓口（`amr` の `otp`）。画面は `reauth_required` を読み替える（Task 2・7。判断14） |
| 9: パスキーの E2E は Playwright の仮想の認証器。会員のログインの手助けをメールのコードの流れに | 6（仮想の認証器）、10（`loginAsMember`） |
| 3幅（390・768・1280）の E2E、命名 `FR-LOGIN-NNN` | すべての E2E |

**1b の持ち越しの着地**

| 持ち越し | 着地 |
| --- | --- |
| T2 M12 `authenticatorAttachment: null` | Task 2（スキーマと `null` を落とす）＋ Task 6（本物の仮想の認証器で往復して確かめる） |
| T4 M1 `NEXT_PUBLIC_PASSKEY_START_MODE=browser` が束に入るか | Task 12 Step 3（`browser` でビルドして束を調べる）。ブラウザの部品の最初の import は Task 5 |
| T7 M3 登録の終わりの GoTrue の 4xx が 502 | Task 2（`retry` に統一）・Task 6・7（判断10）。窓口は直さない（理由を判断10に書いた） |
| T2 M3 `passkey-gotrue.ts` に `server-only` | Task 2（`import 'server-only'` と、読む試験の差し替え） |

**2. 型・名前の一貫性:** `emailCodeSessionCookieName`・`createEmailCodeSessionToken`・`verifyEmailCodeSessionToken`（Task 1。Task 4・10 が使う）、`/api/auth/email-code/{start,verify,resend,cancel}`（Task 1）、`offerPasskey`（Task 1 が返し Task 4 が読む）、`requestAssertion`・`requestAttestation`・`isPasskeySupported`・`loginWithPasskey`・`registerPasskey`・`listPasskeys`・`renamePasskey`・`deletePasskey`・`resolvePostLoginPath`・`deviceNameFromUserAgent`（Task 2。Task 4・5・6・7 が使う）、`createPasskeyAuthenticationStarter`・`resolveBrowserStartMode`（1b。Task 5）、`claim/complete/fail/skip_passkey_notification`・`passkey_notification_recipients`（Task 8。Task 9）、`sendOrderEmailMessage`・`checkOrderEmailSendConfig`（既存。Task 9）、`addVirtualAuthenticator`（Task 6。Task 7・9 の E2E）。

**3. Review Focus:** 5行とも、Task 1・3・4・5・6・8・9 の試験に入れた。

**4. 実行順:** Task 1・2 は画面を作らず、今の画面を変えない（Task 2 は窓口2本に1行足し、スキーマを広げるだけ。1b の E2E が緑のまま）。Task 3 は旧画面を動かし、旧の流れの中の戻り先を `/login/password` に直し、`isAuthPage` を足す（それでも `/login` は旧と同じ中身のまま緑で終わる）。Task 4 は新しい `/login/code` を足す（`offerPasskey` が真の着地は Task 6 まで 404 なので、真の側の E2E は Task 6 が通す）。Task 5 で `/login` が変わる。旧画面の試験は Task 3 で付け替え済みなので緑のまま。新しい `/login` に着く試験（`registered=1`・再設定の後など）の期待は Task 5 で直す。Task 6・7 は新しい画面を足すだけ（Task 7 は `FR-ACCOUNT-046` のリンクの1本の期待と `FR-AUTH-006-AC-01` を直す）。Task 8 は手元の DB だけ。Task 9 は定期処理に1段足すが、前の段を変えない。Task 10 は独立に戻せる。Task 11・12 は文書と確認。どのタスクの終わりも、全部の既存の試験が緑（変更前と同じ結果）。

**5. 本番:** 段2は本番の DB・設定に何も当てない。移行 G は手元だけ（Task 8）。この master は段3が済むまでアプリとして本番に出さない（Global Constraints・Task 11）。

---

## オーナーに聞くこと

**オーナーの答え（2026-11-17）:** 計画はこのまま始めてよい。1 は (A) この文面で進める。2 は (A) 新しいタブ「ログイン方法」。3 は (A) 同意の一行を置く。

次の3つを、選んでいただく。どれも、お客さんが見る言葉・見た目が変わるため。

1. **お客さんに見える言葉の案（下の「付録」に全部まとめた）** — 選ぶ: (A) **この文面で進める（おすすめ）** / (B) 直したい所を伝える（場所を教えていただければ、実装の前に付録と計画の該当の行を直す）。付録は、ログイン画面・コード入力・パスキーを作る勧め・アカウントの「パスキー」・新しいお客さんが最初に受け取る「ログインの確認コード」のメール（今のまま）・お客さん向けの知らせのメール・店員本人と店長あての知らせのメール（オーナー本人が受け取る）。ブランドの声に合わせ、短く静か・丁寧語・専門語なし。
2. **アカウントの中の置き場所** — (A) 新しいタブ「ログイン方法」を足す（おすすめ。パスキー以外のログイン方法（Google・メール）の説明も将来ここに足せる） / (B) 「お客様情報」のタブの下に「パスキー」の区画を足す（タブは増えないが、お客様情報の画面が長くなる）。**おすすめ: (A)**。
3. **メール欄の下の「同意」の一行** — 初めての人は、メールのコードを入れた時にその場でアカウントが作られる。今の登録画面には同意の欄も規約へのリンクも無い。(A) メール欄の下に1行 **「続けると、利用規約とプライバシーポリシーに同意したものとします。」**（それぞれ `/terms`・`/privacy` へのリンク。チェック欄は置かない）を置く / (B) 今と同じく何も置かない。**おすすめ: (A)**（静かな1行で、アカウントを作る時の大事な説明になる）。

---

## 付録: お客さんに見える文面の案（オーナーが読む用。計画の本文と同じ内容）

**ログイン画面（`/login`。Task 5）**
- 見出し（目には見えない）: 「ログイン」
- ボタン: 「パスキーでログイン」。下の小さな字: 「この端末の顔認証・指紋・PIN で入れます。」
- 区切り: OR。ボタン: 「Googleでサインイン」（今のまま）。区切り: OR
- メール欄（Email）と、ボタン: 「メールでコードを受け取る」。下の小さな字: 「はじめての方も、同じ方法でアカウントを作れます。」（質問 3 が (A) なら、さらに「続けると、利用規約とプライバシーポリシーに同意したものとします。」）
- パスキーの結果の文: 中止「パスキーでのログインを中止しました。」／登録が無い・失敗「このパスキーではログインできませんでした。メールのコードか Google でもログインできます。」／本人確認なし「この端末で本人確認をしてから、もう一度お試しください。」／回数「ログインの試行が集中しています。しばらくしてからお試しください。」／使えない「ただいまパスキーを使えません。メールのコードか Google でログインしてください。」／未対応のブラウザ「この端末ではパスキーを使えません。メールのコードか Google でログインできます。」

**コード入力（`/login/code`。Task 4）**
- 見出し「確認コードを入力してください」。説明「{マスクしたメール} に8桁のコードをお送りしました。5分以内に入力してください。」
- ボタン: 「ログイン」「コードを再送する」「メールアドレスを入れ直す」
- 失敗: 「確認コードが無効、または期限切れです。」／「試行が集中しています。しばらくしてからやり直してください。」／「時間がたちました。もう一度メールアドレスを入れてください。」／店員「店員の方は、パスキーでログインしてください。」

**パスキーを作る勧め（`/login/passkey`。Task 6）**
- 見出し「パスキーを作りませんか」。説明「次回からは、この端末の顔認証・指紋・PIN でログインできます。メールでコードを待つ必要はありません。」小さな字「あとからでも、アカウントの「ログイン方法」で作れます。」
- ボタン: 「パスキーを作る」「あとで」。成功「パスキーを作りました。」（名前が付かなかった時は「名前は、アカウントのログイン方法から変えられます。」）
- 失敗: 「パスキーの作成を中止しました。」／「この端末のパスキーは、すでにアカウントに登録されています。」／「うまく作れませんでした。もう一度お試しください。」／「この端末ではパスキーを作れません。」／「ただいまパスキーを作れません。時間をおいてお試しください。」／「もう一度ログインしてください。」

**アカウントの「ログイン方法」（Task 7）**
- 見出し「パスキー」。説明「パスキーを登録すると、この端末の顔認証・指紋・PIN でログインできます。」。各行: 名前・「{日付} に作成」・「最後に使った日: {日付}」・「名前を変更」「削除」。ボタン「パスキーを追加」
- 削除の確認: 「このパスキーを削除しますか」「削除すると、このパスキーではログインできなくなります。」（最後の1本には「最後のパスキーです。削除しても、メールのコードか Google でログインできます。」を足す）
- 空: 「パスキーはまだありません。作ると、メールのコードを待たずにログインできます。」
- 追加の失敗: 「安全のため、メールのコードでもう一度ログインしてから追加してください。」（ボタン「メールのコードでログイン」）／「この端末ではパスキーを追加できません。」／そのほかは勧めの画面と同じ

**新しいお客さんが最初に受け取るメール（今の `supabase/templates/magic_link.html`。変えない）**
- 「ログインの確認コード: {8桁}」「有効期限は5分です。期限が切れた場合は再送してください。」

**お客さん向けの知らせのメール（Task 9）**
- 件名「パスキーが追加されました」。本文: 「Le Fil des Heures をご利用いただき、ありがとうございます。／ご登録のアカウントに、パスキーが追加されました。／名前: {名前}／日時: {日時（日本時間）}／ご自身で追加された場合は、このメールへのご対応は必要ありません。心当たりがない場合は、お手数ですが、すぐに次のお問い合わせからご連絡ください。{お問い合わせの URL}」
- 削除: 件名「パスキーが削除されました」。「ご登録のアカウントから、パスキーが削除されました。」「ご自身で削除された場合は…」（ほかは同じ）
- 差し替え: 件名「パスキーの内容が変更されました」。「ご登録のアカウントのパスキーの内容が、通常の操作では行われない方法で変更されました。」（ほかは同じ）

**店員本人あて**: 件名と最初の文はお客さんと同じ。末尾は「ご自身で行われた操作でない場合は、すぐに店長へお知らせください。」

**店長あて（オーナー本人が受け取る）**: 件名「店員のパスキーが追加されました」（削除「…削除されました」、差し替え「店員のパスキーの内容が変更されました」）。本文: 「{店員のメール} のパスキーが追加されました。／名前: {名前}／日時: {日時}／本人の操作か確認してください。心当たりがない場合は、そのアカウントのログインを止めてください。」
