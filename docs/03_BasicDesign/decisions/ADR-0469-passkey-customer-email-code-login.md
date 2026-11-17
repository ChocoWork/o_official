# ADR-0469 お客さんのログインは、メールのコードを入口にし、新規は先に印つきで作ってから同じコードの流れに乗せる

> 状態: 推定 | 確認日: 2026-11-17 | 対象: `src/app/api/auth/email-code/{start,verify,resend,cancel}/route.ts`、`src/features/auth/services/email-code-session.ts`、`src/app/login/password/page.tsx`（旧画面の退避。Task 3）。新しい画面の作りは以降のタスクで足す

## 概要

お客さんのログインを、メールに届いた8桁のコードだけで入る形にする。新規のアドレスも同じ流れで作る。この ADR は Task 1（窓口と保留の Cookie）の判断を書く。画面の作りと旧画面の退避の判断は、以降のタスクが足す。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SR-AUTH-021、FR-AUTH-023、SEC-AUTH-048、SEC-AUTH-049、THR-AUTH-049、DD-AUTH-059、SR-AUTH-022、FR-AUTH-025、DD-AUTH-061、FR-AUTH-027、DD-AUTH-063 |
| 対象のコード | `src/app/api/auth/email-code/`、`src/features/auth/services/email-code-session.ts`、`src/app/login/password/page.tsx`、`src/components/AuthTabs.tsx`、`src/app/login/page.tsx`、`src/features/auth/passkey/components/LoginChoices.tsx`・`EmailCodeStartForm.tsx` |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)（6-1）、[段2の計画](../../superpowers/plans/2026-11-17-passkey-stage2-customers.md)、[お客さんのログインの詳細](../../04_DetailDesign/sequence/auth-passkey-customer-screens.md) |
| 調べた時点 | 2026-11-17（手元の GoTrue で、作成→コードの送信→確定の組み合わせを実測した） |

## 判断

### ADR-0469 お客さんのログインは、メールのコードを入口にし、新規は先に印つきで作ってから同じコードの流れに乗せる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-048、SEC-AUTH-049 |
| 根拠 | パスワードを覚えさせず、列挙もさせない入口にするため。手元の GoTrue は、未登録に `shouldCreateUser: true` で送ると確認メールの型（リンク）になり、旧の会員登録の確認メールも変わってしまう。先に確認済みで作ってから `shouldCreateUser: false` で送れば、ログインのコードのメールの型だけが使われる |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-11-17-passkey-stage2-customers/task-1-brief.md`、`docs/superpowers/specs/2026-11-07-passkey-auth-design.md`（6-1）、`docs/superpowers/plans/2026-11-17-passkey-stage2-customers.md`（Task 1）（作り手の判断 3・4、調整役の判断 3）。手元の GoTrue での実測は `.superpowers/sdd/2026-11-17-passkey-stage2-customers/task-1-spike.md` |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| お客さんのログイン | パスワード＋メールのコード（2段） | 顧客のアカウントは、メールに届くコードで入る形が標準（公式の説明を読んで確認していない部分あり） | パスワード無し（コード・マジックリンク・パスキー）の流れが増えている。列挙の対策は「登録の有無で応答を変えない」 | メールのコード1段にし、応答を同じにする。のちにパスキーを勧める |

#### 決定

- 始めは登録の有無を調べない。`admin.createUser`（確認済み・パスワード無し・印 `email_code_signup_pending`）を呼び、登録済みの断り（`email_exists`）は握りつぶし、全員にコードを送る。成功は常に 202
- 確定で、コードが通った時にだけ印を外す。確認済みの印（`email_confirmed_at`）は作った時から入るが、本人の確かめは確定でだけ成り立つ。それまでのアカウントにはパスワードもパスキーも無い
- 保留の Cookie は旧と別の名前（`sb-email-code-session`）・別の署名の目的（`email_code`）で、`userId` を持たない。確定の枠は Cookie の乱数（`jti`）ごとに数える
- 旧の会員登録で作って確認していないアドレスには、サーバーで確認済みにせず、確認メールが届くことを画面が常に案内する。旧の登録は段4まで残る
- 一度も入らなかったアカウントの後始末は、段2では作らない（印が付いたまま残るので、後で安全に選べる。開店前の項目）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 未登録に `signInWithOtp({ shouldCreateUser: true })` を呼ぶ | 確認メールの型（リンク）で送られ、コードが届かない。旧の会員登録の確認メールも変わる |
| 登録の有無を調べて応答を分ける | アドレスの列挙の道具になる（SEC-AUTH-016） |
| 未確認の旧の登録をサーバーで確認済みにする | パスワードを先に付けた他人が、その人のアドレスでログインできる |
| 確定の枠を宛先だけで数える | 他人が本人の枠を使い切れる |
| GoTrue の送信の間隔の 429 をそのまま 429 で返す | 直前に認証のメールを受けた既存のアドレスだけで起きるので、未登録と見分けがつく。202 に隠し、監査とログに残す |

#### 結果

- 良くなること: お客さんがパスワード無しで入れる。応答から登録の有無が分からない
- 悪くなること: 旧の未確認の登録は、確認のメールを押すまでコードで入れない（段4まで）。他人が始めを繰り返すと、本人はしばらくコードで入れない（パスキーと Google は残る）
- 見直す条件: 段4（旧の登録を消す時）、本番の GoTrue の設定を読んだ時

#### 旧画面の退避（Task 3。SR-AUTH-022・FR-AUTH-025・DD-AUTH-061）

根拠: `/login` を新しい画面に作り替えると、旧のフォーム（Password 欄・会員登録のタブ）を操作する E2E が約40本と、手助け `loginAndOpenAccount` を使う16本が一斉に落ちる。旧の画面を別の住所に動かして、その試験の URL だけを付け替えれば、中身を変えずに緑を保てる。パスワードの店員・お客さんの入口も段4まで残る。判断を書いた日と出どころ: 2026-11-17、`.superpowers/sdd/2026-11-17-passkey-stage2-customers/task-3-brief.md`、`docs/superpowers/plans/2026-11-17-passkey-stage2-customers.md`（Task 3。調整役の判断 2・I-2）。

##### 決定

- 旧の `/login` のページを `src/app/login/password/page.tsx` に移す。検索に載せない（`robots: noindex, nofollow`）。どこからもリンクしない（旧の流れの中の戻り先を除く）
- `src/app/login/page.tsx` は Task 3 では変えず、Task 5 で新しい画面に作り替えた（下の「新しい `/login`（Task 5）」）。Task 3 の終わりは `/login` と `/login/password` が同じ中身だった（旧と新の切り替えを2つのコミットに分け、Task 3 を動かして付け替えるだけにするため）
- 旧の流れの中の戻り先は `/login/password` に閉じる: `/login/verify` の保留の無い転送、`VerifyOtpClient` の再送・`post-login` の401と取りやめ、`RegisterModal` の「ログインページへ」のリンク
- お客さんに見せる行き先は新しい `/login` のまま: `/api/auth/confirm` の `/login`・`/login?registered=1`、「登録済み」のメールのリンク、`/auth/verified` の「ログインページへ」、`GuestRegisterPrompt` と注文の状態の案内の `/login?tab=register…`。ただし Task 5 の調整役の判断で、パスワードの再設定・変更の完了の後だけは `/login/password` に付け替えた（下の「新しい `/login`（Task 5）」）
- 共有の `src/contexts/Providers.tsx` の `isAuthPage` に `/login/password`・`/login/code`・`/login/passkey` を足す（範囲の外のファイル。変更は `14_login.md` と `screen-list.md` に書く）。足さないと真ん中寄せの枠にならない
- 旧画面を操作する E2E は、URL を `/login` から `/login/password` に替える以外は期待を変えない。戻り先の確かめ（`FR-LOGIN-038`）は、リンクが `/login?next=…` へ送ることを確かめた後、旧のフォームを使う所で `/login/password?next=…` へ移る

##### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 旧の画面を段2で消す | 旧のパスワードの窓口・試験は段4まで使う（設計 9）。お客さんの `password` の拒否を有効にする前に消すと、店員が入れなくなる |
| `/login` の中で新旧を出し分ける | 旧の試験が新しい画面の分岐に巻き込まれる。段4で旧だけ消すのも難しい |
| 旧の流れの戻り先を新しい `/login` のままにする | 旧の流れが新しい画面に飛ばされ、旧のフォームを探して落ちる。段4で旧を丸ごと消せない |

##### 結果

- 良くなること: 旧の試験を中身を変えずに緑のまま保てる。段4で旧の画面と試験を一緒に消せる
- 悪くなること: Task 3 の終わりから Task 5 までの間、`/login` と `/login/password` の中身が重なっていた

##### 段4で消す一覧

- 画面: `src/app/login/password/page.tsx`（旧の中身は Task 5 で `src/app/login/page.tsx` から消えたので、ここだけ）、`src/app/login/verify/`、`src/components/AuthTabs.tsx`・`LoginModal.tsx`・`RegisterModal.tsx`
- 共有: `src/contexts/Providers.tsx` の `isAuthPage` の `/login/verify`・`/login/password`
- 窓口: `/api/auth/login/*`・`/api/auth/otp/verify`・`/api/auth/register`、旧い保留の Cookie（`sb-login-2fa-session`）
- 試験: `/login/password` を開いて旧のフォームを操作する E2E（`FR-LOGIN-001`・`003`・`006`・`008`・`009`・`011`〜`017`・`019`〜`029`・`034`・`036`・`038`・`056`、`FR-CHECKOUT-012`、`FR-PWRESET-001`・`009`、`FR-SIGNUP-001`・`003`、`FR-UI-008`、`login-otp-resend-errors`）と手助け `e2e/account-test-utils.ts` の `loginAndOpenAccount`、`e2e/helpers.ts` の `registerUser`・`loginUser`（今は使う試験が0本）
- 旧の画面にだけ当てる jest の試験: `tests/unit/app/login/login-page.test.tsx` の `/login/password` の分、`login-verify-page`、`VerifyOtpClient`、`auth-tabs`、`register-modal`、`tests/integration/ui/auth-login-flow`・`auth-login-tabs-screen`・`auth-login-verify-screen`・`auth-register-flow`・`auth-register-form-screen`、`tests/unit/contexts/providers-auth-page.test.tsx` の旧の道（`/login/verify`・`/login/password`）の分
- 消す窓口の性質を確かめる E2E: `FR-LOGIN-030`・`031`・`035`、`FR-SIGNUP-002`（`/api/auth/login/*`・`/api/auth/register` を直に叩く。窓口と一緒に消す）
- 注: `loginAndOpenAccount` を使う16本の `FR-ACCOUNT-*` は消さない。手助けを新しい入口（`loginAsMember`）へ移して残す

#### 新しい `/login`（Task 5。FR-AUTH-027・DD-AUTH-063）

根拠: 旧の画面を `/login/password` に退避した（Task 3）ので、`/login` をパスキー・Google・メールのコードの3つの入口に作り替える。判断を書いた日と出どころ: 2026-11-18、`.superpowers/sdd/2026-11-17-passkey-stage2-customers/task-5-brief.md`、`docs/superpowers/plans/2026-11-17-passkey-stage2-customers.md`（Task 5。調整役の判断）。

##### 決定

- `/login` はパスキー・Google・メールのコードの順に並べる。メール欄の下の同意の1行（利用規約・プライバシーポリシーへのリンク付き、チェック欄なし）は、オーナーが案 (A) を選んだので入れる（2026-11-18）
- 見出しは視覚的に隠した「ログイン」にする。今の画面がタブだけで見出しを持たないため、スクリーンリーダーのためにだけ足す（作り手の判断 6）
- 保留の Cookie は新（`/login/code`）を先に、旧（`/login/verify`）を次に確かめる。問い合わせは `next`・`email`・`registered` だけ。`tab` は読まず、`tab=register` が付いていても同じ画面（注文の完了の案内・注文の状態の案内の `/login?tab=register&email=…` はそのままで、メール欄に値が入る。文言「会員登録へ進む」「会員登録して申し込む」は、メールのコードで同じ画面から作れるので変えない）
- 確認のメールのリンクを別のブラウザで開いた人（`/login?registered=1`）の案内は、新しい画面でも出す
- パスワードの再設定の完了（`/auth/password-reset` の「ログインへ」2か所、`verify/VerifyClient.tsx`）と、パスワードの変更の完了（`PasswordChangeForm.tsx` の `router.replace`）は `/login/password` へ移す。新しい `/login` からは旧の画面へリンクしない（どこからもリンクしない決め）ので、パスワードで入る人（店員を含む）は、段4まではこれらの行き先が入り方になる。`/auth/verified` の「ログインページへ」と「登録済み」のメールのリンク（`/api/auth/register` が送る `/login`）は `/login` のまま
- `FR-LOGIN-038` の AC-01・02 は、`/login?next=…` に着いた後、旧のフォームを使う所で `/login/password?next=…` へ移る今の形のままにする。新しい画面の `next` の確かめは `FR-LOGIN-057`（終わりの窓口の本文に渡ること）で持つ
- パスキーのログイン成功では、勧めの画面（`/login/passkey`）を出さない（すでに持っている）。メールのコードの成功だけが、確定の応答の `offerPasskey` で勧める（DD-AUTH-062）
- ボット検証の枠は1つで、パスキー（始めの方式が `browser` の時だけ）とメールで共有する。送るたびに引き直す（ADR-0411）。ウィジェットはメールの欄の中にあるので、始めの方式を `browser` にする時は `NEXT_PUBLIC_TURNSTILE_SITE_KEY` が要り、トークンが出る前にパスキーを押すと「ただいまパスキーを使えません。」になる（その時にウィジェットの置き場所を見直す）

##### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 旧のタブの画面へのリンクを新しい `/login` に置く | どこからもリンクしない決め（段4で旧を丸ごと消す）に反する |
| パスワードの再設定・変更の完了を `/login` のままにする | パスワードの利用者（店員を含む）が、パスワードで入れる画面に着けなくなる（段4まで） |
| 見出しを見える形で足す | 3つの入口だけで足りる画面に、題を足すと一画面に収まらない。brand の静けさにも合わない |

##### 結果

- 良くなること: お客さんが鍵・Google・メールのコードのどれでも、1つの画面から入れる。旧の試験は `/login/password` で緑のまま
- 悪くなること: 段4まで、パスワードで入る人は `/login/password` を直接開くか、パスワードの再設定・変更の完了から入る（店員は設定の説明から案内する）
- 見直す条件: 段4（旧の画面と窓口を消す時）、「会員登録へ進む」の文言を新しい画面に合わせて変えるか（開店前の項目）
