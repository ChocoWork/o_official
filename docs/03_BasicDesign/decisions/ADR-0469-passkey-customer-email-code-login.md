# ADR-0469 お客さんのログインは、メールのコードを入口にし、新規は先に印つきで作ってから同じコードの流れに乗せる

> 状態: 推定 | 確認日: 2026-11-17 | 対象: `src/app/api/auth/email-code/{start,verify,resend,cancel}/route.ts`、`src/features/auth/services/email-code-session.ts`、`src/app/login/password/page.tsx`（旧画面の退避。Task 3）。新しい画面の作りは以降のタスクで足す

## 概要

お客さんのログインを、メールに届いた8桁のコードだけで入る形にする。新規のアドレスも同じ流れで作る。この ADR は Task 1（窓口と保留の Cookie）の判断を書く。画面の作りと旧画面の退避の判断は、以降のタスクが足す。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SR-AUTH-021、FR-AUTH-023、SEC-AUTH-048、SEC-AUTH-049、THR-AUTH-049、DD-AUTH-059、SR-AUTH-022、FR-AUTH-025、DD-AUTH-061 |
| 対象のコード | `src/app/api/auth/email-code/`、`src/features/auth/services/email-code-session.ts`、`src/app/login/password/page.tsx`、`src/components/AuthTabs.tsx` |
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

- 旧の `/login` の頁を `src/app/login/password/page.tsx` に移す。検索に載せない（`robots: noindex, nofollow`）。どこからもリンクしない（旧の流れの中の戻り先を除く）
- `src/app/login/page.tsx` は Task 3 では変えない。Task 3 の終わりは `/login` と `/login/password` が同じ中身。Task 5 で `/login` を新しい画面に作り替える（旧と新の切り替えを2つのコミットに分け、Task 3 を動かして付け替えるだけにするため）
- 旧の流れの中の戻り先は `/login/password` に閉じる: `/login/verify` の保留の無い転送、`VerifyOtpClient` の再送・`post-login` の401と取りやめ、`RegisterModal` の「ログインページへ」のリンク
- お客さんに見せる行き先は新しい `/login` のまま: `/api/auth/confirm` の `/login`・`/login?registered=1`、パスワードの再設定・変更の後の `/login`、`GuestRegisterPrompt` と注文の状態の案内の `/login?tab=register…`。新しい `/login` に着く試験の期待は Task 5 で直す
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
- 悪くなること: Task 5 までの間、`/login` と `/login/password` の中身が重なる

##### 段4で消す一覧

- 画面: `src/app/login/password/page.tsx`・`src/app/login/page.tsx` の旧の中身（Task 5 で作り替えた後は残らない）、`src/app/login/verify/`、`src/components/AuthTabs.tsx`・`LoginModal.tsx`・`RegisterModal.tsx`
- 共有: `src/contexts/Providers.tsx` の `isAuthPage` の `/login/verify`・`/login/password`
- 窓口: `/api/auth/login/*`・`/api/auth/otp/verify`・`/api/auth/register`、旧い保留の Cookie（`sb-login-2fa-session`）
- 試験: `/login/password` を開いて旧のフォームを操作する E2E（`FR-LOGIN-001`・`003`・`006`・`008`・`009`・`011`〜`017`・`019`〜`029`・`034`・`036`・`038`・`056`、`FR-CHECKOUT-012`、`FR-PWRESET-001`・`009`、`FR-SIGNUP-001`・`003`、`FR-UI-008`、`login-otp-resend-errors`）と手助け `e2e/account-test-utils.ts` の `loginAndOpenAccount`、`e2e/helpers.ts` の `registerUser`・`loginUser`（今は使う試験が0本）
