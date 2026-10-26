# ADR-0413 確認リンクの結び付けは、控えの番号と登録したメールを一緒にハッシュする

> 状態: 推定（案内の文は案。ユーザーに画面を見せて確かめる） | 確認日: 2026-10-26 | 対象: `src/features/auth/return-intent/`、`src/app/api/auth/{register,confirm}/route.ts`、`src/app/login/page.tsx`、`src/components/AuthTabs.tsx` | 基準コミット: `77e7f844`

## 概要

会員登録の確認のメールのリンクは、登録を送ったブラウザで開いた時だけ session を作る。結び付けは、波 1-A の戻り先の控え（`private.auth_return_intents`・`sb-return-intent` Cookie、用途 `signup`）に乗せ、DB の変更なしで、控えの `token_hash` を `sha256(番号 + "\n" + 小文字のメール)` にして「番号が合い、かつ確認した利用者のメールが登録の時のメールと同じ」を条件にする。当たらない時は、メールの確認だけ済ませ、session を作らず、GoTrue 側の session を `signOut({ scope: 'local' })` で失効させ、Cookie は書かず消さずに `/login?registered=1` へ 303 で送る。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SEC-AUTH-007、SEC-AUTH-016、THR-AUTH-007、FR-AUTH-005 |
| 対象のコード | `src/features/auth/return-intent/return-intent-store.ts`・`return-intent-service.ts`、`src/app/api/auth/register/route.ts`・`confirm/route.ts`、`src/app/login/page.tsx`、`src/components/AuthTabs.tsx` |
| 関連文書 | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1b-decisions.md`（ユーザー承認 2026-10-25・10-26）、`docs/superpowers/plans/2026-10-26-wave1b-local-fixes.md` の P1〜P3 と Task 3、ADR-0412 |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-10-26 の作業ツリー（結合試験の写しで確かめた。本物の DB の関数との通しと E2E は未実行） |

## 判断

### ADR-0413 確認リンクの結び付けは、控えの番号と登録したメールを一緒にハッシュする

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-007、SEC-AUTH-016、FR-AUTH-005 |
| 根拠 | `/api/auth/confirm` は `GET` で、印が正しければ開いた端末に session の Cookie を書く。開いた人と印を作った人を結ぶ物が無いと、攻撃者が自分のアカウントの確認のリンクを被害者に開かせ、被害者の端末を攻撃者のアカウントでログインさせられる（login CSRF。THR-AUTH-007）。ユーザーが 2026-10-25・10-26 に「登録を送ったブラウザで開いた時だけログインさせる」と決めた。決定の「控えの Cookie が DB の行と合う」を、番号だけでなくメールまで合うと狭く読む（計画の P1） |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1b-decisions.md`、`docs/superpowers/plans/2026-10-26-wave1b-local-fixes.md`、[OWASP Cross-Site Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)（Login CSRF の節）、[Shopify Customer sign-in links and redirects](https://shopify.dev/docs/storefronts/themes/sign-in) |

#### 背景

比べた物は次のとおり。Shopify は、ログインのコードを要求したブラウザでそのコードを入れさせる（別のブラウザで開いたリンクでは、そのブラウザにログインを作らない）作りに寄せている。OWASP は、ログインの CSRF に対して、ログインを始めたブラウザに結んだ値（ログイン前に発行する推測できない値）を終わりで照らすことを勧める。

| 観点 | 今の私たち（波 1-A の暫定） | Shopify | OWASP | 結論 |
| --- | --- | --- | --- | --- |
| 開いた人と始めた人の結び付け | 無い。どのブラウザで開いても session を作る | 始めたブラウザでコードを入れる | ログインを始めたブラウザに結んだ値を終わりで照らす | 登録の送信でそのブラウザに控えの Cookie を置き、確認のリンクで照らす |
| 照らす値 | － | － | ブラウザに置いた推測できない値 | 番号だけでなく、確認した利用者のメールも一緒にハッシュに混ぜる（別のメールの印では必ず外れる） |
| 別のブラウザで開いた時 | session を作って `/` | その場でログインしない | ログインを作らない | メールの確認だけ済ませ、session を作らず `/login?registered=1` で案内する |
| 外れた時の控え | － | － | － | 消さない（攻撃者のリンクを開かせるだけで、被害者の進行中の登録の控えを壊させない） |

#### 決定

- 登録の送信（`/api/auth/register`）は、戻り先が無い・不正でも必ず控えを作る（戻り先は既定の `/`。不正の理由の監査は残す）。新規・登録済み・重複の例外の 3 つの 202 は、Set-Cookie の名前・属性・Max-Age まで同じにする（SEC-AUTH-016）。作成に失敗しても応答の形は変えない
- signup の控えの `token_hash` は `sha256(番号 + "\n" + 小文字のメール)`（前後の空白を除いて小文字）。login の控えは今までの `sha256(番号)` のまま。列の型・関数の引数は変わらないので移行は要らない
- `/api/auth/confirm` は、`verifyOtp` の結果の `data.user.email` で同じ式を作り、session を作る前に控えを使い切る。使い切りの結果が戻り先なら session を作り、戻り先へ送る（管理者・サポーターは使い切った戻り先を捨てて `/auth/verified`）
- 当たらない時（Cookie が無い・番号が合わない・使用済み・期限切れ・別のメールの印・利用者のメールが無い）は、`persistSessionAndCookies`・`linkGuestOrdersByEmail` を呼ばず、同じ client の `signOut({ scope: 'local' })` で `verifyOtp` が GoTrue 側に作った session（refresh token）だけを失効させ（失敗は握り、ログには符号だけ）、Cookie は書かず消さずに `/login?registered=1` へ 303 で送る。監査は success・`confirmed_without_session`・`no_binding`
- `/login?registered=1` は固定の案内の文を `role="status"` で出す。文は「会員登録が完了しました。ログインしてください。」（案。ユーザーに画面を見せて確かめる）。値そのものは画面に出さず、「このアカウントでログインしますか」の確かめの画面は出さない。タブを替えても案内は残る
- 控えの使い切りは session を作る前に行う（波 1-A の「保存の後に使い切る」を、signup の確認のリンクだけ逆にする）。使い切った後で保存が失敗すると戻り先は使用済みになるが、行き先は固定の `/`・戻り先の Cookie は削除・`verifyOtp` の session は失効、になるだけ

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 番号だけが行に当たる形（メールを混ぜない） | 被害者が自分の登録の途中（Cookie が有効）に、攻撃者のメールの確認のリンクを同じブラウザで開くと、被害者の Cookie が被害者の行に当たってしまい、攻撃者のアカウントでログインさせられる（login CSRF が残る） |
| 署名つき Cookie に `sha256(メール)` を入れる（`AUTH.md` の当初案） | 専用の署名の鍵（SEC-AUTH-027）が要る。波 1-A の控えの仕組みに乗せれば鍵を増やさずに同じ結び付きが取れる |
| PKCE の `code_verifier` を使う | 登録の作り（Supabase の signUp とメールの雛形）の変更が大きい |
| 確認の画面を挟み「このアカウントでログインしますか」と聞く | 被害者が騙されて「はい」を押すと、やはり攻撃者のアカウントでログインする。守りが弱い |
| DB の読み取りだけの確認の関数を足し、session を作った後に使い切る | 移行が要る。結び付けの成否は session を作る前に決めるしかない |

#### 結果

- 良くなること: 他人の端末で攻撃者の確認のリンクを開かせても、攻撃者のアカウントでログインしない。登録の途中の被害者のブラウザでも、メールが違えば外れる。移行も鍵の追加も要らない
- 悪くなること: 別のブラウザで確認のリンクを開いた人は、その場でログインできない（`/login` で手でログインする）。登録の後に別のログインを始めると Cookie（`sb-return-intent`、login と signup で名前が共通）が上書きされ、同じブラウザで開いても `/login?registered=1` になる（安全な側への劣化）。使い切りが session の前なので、保存の失敗で戻り先だけが使用済みになる
- 残る穴（直さない）: (1) Cookie の名前に `__Host-` の頭が無いので、同じ親ドメインの別のサブドメインを攻撃者が持つと、攻撃者のメールに結んだ控えを被害者のブラウザへ投げ込める（cookie tossing。波 1-A の設計のまま）。(2) 被害者のブラウザに攻撃者のメールで登録を送らせる道は、`proxy.ts` の Origin の確かめと Turnstile に頼っている
- 見直す条件: ユーザーが案内の文を変えたい時。Supabase が確認のリンクにブラウザへの結び付けを持つ時。Cookie の名前に `__Host-` を付ける時（波 1-A の設計の見直し）

## 未確認事項

- 案内の文「会員登録が完了しました。ログインしてください。」は案。ユーザーが画面を見て確かめる
- 本物の DB の関数との通し（`consume_auth_return_intent` に結び付けのハッシュを渡す形）と E2E は、書いただけで未実行
- 本番の確認メールの雛形が `token_hash` と `type=signup` を `/api/auth/confirm` へ渡しているか（開店前に本番のダッシュボードで確かめる）
