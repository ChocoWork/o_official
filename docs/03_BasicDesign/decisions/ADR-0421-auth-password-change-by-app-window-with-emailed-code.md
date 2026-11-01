# ADR-0421 パスワード変更はアプリの窓口で、現行パスワードとアプリが送るコードを求め、全 session を失効して通知する

> 状態: 現行（アプリ側の窓口と部品と画面は入った。DB の表と関数〔M3〕は手元に適用済み〔2026-11-01 の `db reset`〕で本番は未適用〔Task 11〕、E2E `FR-ACCOUNT-046` は `e2e/` に在る、GoTrue 側の設定は手元に反映済みで本番は Task 11） | 確認日: 2026-11-01 | 対象: `src/app/api/auth/password/change/{start,confirm}/route.ts`、`src/features/auth/services/password-change.ts`、`src/features/auth/schemas/password-change.ts`、`supabase/migrations/20261101120000_sec_password_change_challenges.sql`（DATA-AUTH-009・010） | 基準コミット: `b26d7bb0`（作業ツリー）

## 概要

ログイン中の会員が自分でパスワードを変える窓口を作る。現行パスワードを確かめた後にアプリがメールで 8 桁のコードを送り、変更の確定で新しいパスワード（16 文字以上）とコードを求める。変更の後はこの端末を含む全 session を失効し、通知のメールを送る。コードは DB の表に鍵つきのハッシュで置く。GoTrue の設定（`secure_password_change`・現行パスワードの要求・変更通知・最小長 16）は直接の道に対する二重の守りとして並べる。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SEC-AUTH-015、SEC-AUTH-034 |
| 対象のコード | `src/app/api/auth/password/change/start/route.ts`・`confirm/route.ts`（API-AUTH-020・021）、`src/features/auth/services/password-change.ts`・`schemas/password-change.ts`、`supabase/migrations/20261101120000_sec_password_change_challenges.sql`（表 `public.password_change_challenges`、関数 `issue_password_change_challenge`・`consume_password_change_challenge`） |
| 関連文書 | [AUTH の構造設計](../areas/auth.md)（API-AUTH-020・021、DATA-AUTH-009・010）、[ログインと認証の詳細設計](../../04_DetailDesign/pages/14_login.md)（DD-AUTH-041）、`docs/superpowers/plans/2026-11-01-wave6-captcha-password-change-config.md`（Task 4・5、ruling 3〜5・9・17〜20）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave6-decisions.md`、`wave6-task0-report.md`、`wave6-research.md`（§2-3・§2-6・§2-7） |
| 試験 | `tests/unit/features/auth/password-change-schema.test.ts`・`password-change-service.test.ts`、`tests/unit/api/auth/password-change-start-route.test.ts`・`password-change-confirm-route.test.ts`、`tests/integration/api/auth/password-change.test.ts`、`tests/unit/migrations/sec-password-change-challenges.test.ts`、`tests/integration/db/auth_password_change_challenges.integration.test.ts`・`auth_grants_inventory` |
| 調べた時点 | 2026-11-01（窓口と部品の単体は流した。M3 を手元へ当てた後の DB 結合は 4715 件成功・0 件失敗。E2E `FR-ACCOUNT-046` は `e2e/` に移した後の全件実行が進行中で、結果は未確認） |

## 判断

### ADR-0421 パスワード変更は、現行パスワードとアプリが送るコードを求める 2 段の窓口で行い、コードは DB の表に鍵つきのハッシュで置く

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-015、SEC-AUTH-034 |
| 根拠 | 窓口も画面も無く、再設定でしか変えられなかった。GoTrue の `secure_password_change` は session の作成から 24 時間以内なら再認証なしで変更を許し、窓は設定で変えられない。盗んだ session の持ち主が、現行パスワードを知らなくても変えられてしまう。アプリの窓口で「現行パスワード＋アプリが送るコード＋全 session 失効＋通知＋回数」を求めれば、窓口を通る限りこれを守れる。コードは「単回使用」「間違いは 5 回まで」「新しいコードで前を無効にする」を保たねばならず、署名つき Cookie だけではどれも保てないので、表と、行を `FOR UPDATE` で取る関数に置く |
| 状態 | 現行 |
| 出どころ | ユーザーの決定（2026-11-01「パスワードの変更は提案どおり」）、計画の ruling 3〜5・17〜20 |

#### 背景

| 観点 | 今の私たち（直す前） | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| ログイン中のパスワード変更 | 窓口も画面も無い（再設定でしか変えられない） | 確かめていない（公式資料で読んでいない） | ASVS 4.0.3 V2.1.5「利用者がパスワードを変えられる」、V2.1.6「現行と新しいパスワードを求める」、V2.2.3「認証情報の更新の後に安全な通知を送る」、V3.3.3「パスワード変更の後、他の session を止める」 | 窓口を作る（決定） |
| 変更の本人確認 | - | 確かめていない | NIST SP 800-63B-4 5.2 は、認証要素を変える時に本人確認と通知を求める。メールの out-of-band は AAL2 に使えない（3.1.3.1）ので、会員の 2 段（パスワード＋メール OTP）は AAL2 とは呼ばない | 現行パスワードに加え、アプリが送るメールのコードを求める。AAL2 は名乗らない |
| 確認コードの置き場 | 再設定の印は DB の表 `password_reset_tokens`（ハッシュ・10 分・使い切り。ADR-0403） | 確かめていない | ASVS V2.7.2 は out-of-band の秘密の期限を 10 分、V2.7.3 は 1 回限りで元の要求にだけ使えるとする（V2.7.2 は調査 `wave6-research.md` §2-6 の引用。V2.7.3 は ASVS 4.0.3 の本文を読んだ記憶に基づくので、確かめる） | 再設定の印と同じ作りで DB の表に置く |
| コードの保存 | 再設定の印は sha256 のハッシュ（高エントロピーの乱数） | - | 短い数字のコードは総当たりできる桁数なので、鍵の無い単純なハッシュでは逆算できてしまう | 鍵つきのハッシュ（HMAC-SHA256、`JWT_SECRET`）を、利用者と session に結び付けて保存し、平文は置かない |
| 窓口を GoTrue に任せる場合 | - | - | GoTrue は `updateUser` の `password` をそのまま受け、`secure_password_change` は 24 時間以内の session に nonce を求めない。「現行パスワードを要求」も設定できるが、手元の CLI の設定ファイルには鍵が無い（計画の P9） | 窓口で守る。GoTrue 側の設定は、本番で読んで ON にし、直接の道への二重の守りにする |

- 表に置く（ruling 3）: 署名つき Cookie だけの案（移行が要らない）は、単回使用、間違いの回数の数え上げ、新しいコードで前を無効にすること、並列の推測の上限のどれも保てない。代償は移行 1 本と本番適用（オーナーの許可）
- コードは 8 桁を `crypto.randomInt` で作る。期限は 10 分、間違いは 5 回で使えなくなる。要求した時の GoTrue の session に結ぶので、別の session では使えない
- 8 桁（10^8 通り）は、5 回の上限・10 分の期限・本人ごとの回数の制限と組み合わせて強さを保つ。単独では強くない

#### 決定

- 窓口は 2 段にする（ruling 4）。`start` は現行パスワードを確かめてからコードをメールで送る。`confirm` はコードと新しいパスワードを受けて変える。「現行＋新＋コード」を 1 回にまとめる案は、`start` が現行パスワード無しでも呼べてしまい、盗んだ session の持ち主が本人のメールへコードを撒けるので採らない
- 現行パスワードの確かめは、captcha を免除される auth だけの client で `signInWithPassword` する（ADR-0420、ruling 5）。ハッシュは GoTrue の中にあり、自前で比べる道が無い。確かめるたびに GoTrue に増える session は、すぐ `revoke_auth_session` で消す
- 回数は、`start`・`confirm` それぞれに IP ごと 20 回／10 分、本人ごと 5 回／10 分（ruling 20）。本人ごとの枠は利用者の id を鍵にし、全 IP を合わせて数える。現行パスワードの総当たりの窓口にならないようにする
- `confirm` の順番は「書式の検査 → 漏洩確認 → コードの使い切り → パスワードの更新 → 全 session の失効 → 認証 Cookie の削除 → 通知」。コードは本人確認なので、弱いパスワードで弾かれた人のコードを焼かないよう、書式と漏洩確認を使い切りより前に置く（再設定の確定と順番が逆なのはこのため）。漏洩確認が外部の障害で使えない時は通し、監査に残す（ruling 19）
- 「新パスワードが現行と同じ」の確かめは置かない。ハッシュは GoTrue の中なので比べるには現行パスワードの確かめを呼ぶしかなく、コードを持たない `confirm` が現行パスワードの当否を明かす総当たりの窓口になる。`confirm` は GoTrue の `signInWithPassword` を一度も呼ばない。ASVS 4.0.3・NIST 800-63B-4 は「現行と同じ」の拒否を要求しない
- 変更の後は、この端末を含む全 session を失効し（ruling 18。決定）、認証 Cookie を消し、通知のメールを送る。失効の失敗は 200 のまま監査 `revoke_failed` に残す（パスワードは既に変わっている）が、この端末の Cookie は必ず消す。パスワードの更新の失敗は 500 で、コードは焼けたまま（もう一度 `start`）
- 管理者・サポーターは aal2 でなければ断る（ruling 17）。GoTrue も MFA 済みの利用者に aal2 を求めるので、直接の道と同じ強さにする
- メールが送れなかった時は、発行したコードを無効にして 500 を返す（送れていないコードを有効なままにしない）。無効にするのも失敗したら、監査の detail に `challenge_void_failed` を足す
- 通知は、アプリの通知（件名「パスワードを変更しました」）を送る。管理 API（`updateUserById`）で変えた時に GoTrue は変更通知を送らない（Task 0 の実測）ので、アプリの通知だけが届く。GoTrue の変更通知を有効にする時は、件名を「パスワードの変更を受け付けました」にして見分ける（ruling 9）
- GoTrue 側は、`secure_password_change`・「現行パスワードを要求」・変更通知・最小長 16 を ON にする（手元の設定は 2026-11-01 に反映済み、本番は Task 11）。窓口を通らない直接の道への二重の守りとして並べる
- 退けた案: ①GoTrue の `reauthenticate()`（nonce が 24 時間以内の session では検証されず、毎回必須にできない）、②コードを署名つき Cookie にだけ持つ案（単回使用・試行回数・「最新のコードだけ有効」が保てない）、③DB のトリガーで `auth.users.encrypted_password` の直接の変更を拒む案（GoTrue がログイン時にハッシュを書き換えるので、ログインを壊す）

#### 結果

- 残る危険は 2 つあり、狭める手段が別である（調査 `wave6-research.md` §2-7）。①現行パスワードを**知る**人が GoTrue を直に叩いて変える: その人は現行パスワードを送れるので、「現行パスワードを要求」では止まらない。captcha（人が解けば通る）と GoTrue の変更通知（本人が気付く）で狭め、ログインにメールのコードが要るので実害は小さい。②パスワードを知らずに access token だけを盗んだ人が `PUT /user` で変える: 本番で「現行パスワードを要求」を ON にして塞ぐ（`SEC-AUTH-015-AC-05`。Task 7・11）
- 窓口を 2 本、DB の表を 1 つ、関数を 2 つ足す。移行 M3 は本番で H の移行の後に当てるのが既定で、窓口と画面を動かす前に当てる必要がある（ruling 16）。表の古い行は `issue` が 1 日より古い物を消すので、掃除の定期処理は要らない
- 本番のアプリは未デプロイで会員は少なく、2 段の窓口の UX の代償（現行パスワード→メールのコード）は許容する

## 未確認事項

- M3 の時刻 `20261101120000` は暫定。手元へ動かす時と、本番へ当てる時（H の移行の後）に付け直す
- 本番で DB の試験を流していない。手元で M3 を当てた後に `auth_password_change_challenges` と `auth_grants_inventory` を流して確かめる
- ASVS V2.7.3 の本文は記憶に基づく記述で、調査文書の引用ではない（上の背景の表に明記した）。原文を確かめる
- 窓口を実 DB・実 GoTrue で通したことはまだ無い（単体はモック）。M3 を手元へ当てた後の E2E（`FR-ACCOUNT-046`。`e2e/` に在り、全件実行の中で流れる）で確かめる
