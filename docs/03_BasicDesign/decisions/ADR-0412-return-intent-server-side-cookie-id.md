# ADR-0412 戻り先はサーバーに控え、番号だけを HttpOnly の Cookie で渡す

> 状態: 推定 | 確認日: 2026-10-25 | 対象: `src/features/auth/return-intent/`、`src/app/api/auth/{login,register,oauth/start,oauth/callback,confirm,post-login}/route.ts`、`supabase/migrations/20261026010000_auth_return_intents.sql` | 基準コミット: `6074cfad`

## 概要

ログインの後の行き先は、URL の `next`・`redirect_to` で決めない。ログインを始める POST で確かめた戻り先をサーバーの表 `private.auth_return_intents` に控え、その番号だけを HttpOnly の Cookie `sb-return-intent` で端末に持たせる。ログインが確定する所で番号を 1 回だけ使い切り、出口でも役割と aal2 を含めて確かめ直す。表の関数は `public` に置くが、`PUBLIC`・`anon`・`authenticated` から EXECUTE を外し、service role にだけ付ける。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | FR-AUTH-005、SEC-AUTH-026、SEC-AUTH-032、THR-AUTH-026、THR-AUTH-032 |
| 対象のコード | `src/features/auth/return-intent/`、`src/app/api/auth/` の 8 本の窓口（`login`・`login/cancel`・`logout`・`register`・`oauth/start`・`oauth/callback`・`confirm`・`post-login`）、`src/lib/cookie.ts` |
| 関連文書 | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1a-decisions.md`（ユーザー承認 2026-10-25）、`.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md` の R1、`.superpowers/sdd/2026-10-25-security-gap-fixes/supabase-mcp-refs.md` |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-10-25（設計の時点。コードは同日の波 1-A で書いた） |

## 判断

### ADR-0412 戻り先はサーバーに控え、番号だけを HttpOnly の Cookie で渡す

| 属性 | 値 |
| --- | --- |
| 上位 | FR-AUTH-005、SEC-AUTH-026、SEC-AUTH-032 |
| 根拠 | `/auth/callback` の画面と共有関数 `sanitizeRedirectPath` に穴があり、URL の値で出口を決める作りは外の住所への迂回を生む（SEC-AUTH-026）。OWASP は「行き先を入力に使わない。使うなら番号など間接の参照にする」と勧める。ユーザーが 2026-10-25 に、サーバーに控えて番号だけを渡す方式を選んだ（SEC-AUTH-032） |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1a-decisions.md`、[OWASP Unvalidated Redirects and Forwards Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html)、[Supabase Securing your API](https://supabase.com/docs/guides/api/securing-your-api) |

#### 背景

比べた物は次のとおり。出典: Shopify は [Customer sign-in links and redirects](https://shopify.dev/docs/storefronts/themes/sign-in) と [Single sign-on](https://shopify.dev/docs/api/customer-authentication/single-sign-on)（`return_to` は同じ店の相対の道筋だけ）、OWASP は [Unvalidated Redirects and Forwards Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html)。

| 観点 | 今の私たち | Shopify | OWASP | 結論 |
| --- | --- | --- | --- | --- |
| 行き先の持ち方 | URL の `next`・`redirect_to` をそのまま確かめて使う | ログインの `return_to` は同じ店の相対の道筋だけを受ける | 入力で行き先を決めない。使うなら番号など間接の参照か許可リスト | 番号（間接の参照）で持ち、入口と出口の両方で許可リストにも通す |
| 確かめの場所 | 共有関数と画面の 2 か所。画面は先頭の字しか見ない | サーバー | サーバー。解釈した結果で比べる | 1 つの部品で入口と出口の両方。解釈し直した `pathname + search` だけを返す |
| 値が URL に載るか | 載る（メールのリンクや Referer を経て改ざん・流出する） | 載る | 載せない方がよい | 番号は HttpOnly の Cookie だけ。URL・本文・`Location` に出さない |
| 使い回し | 防げない | 防げない | 1 回限りが望ましい | 1 回の更新で使い切り、短い期限（login 15 分、signup 1 時間） |

関数の置き場の背景は次のとおり。サーバーは `supabase-js` の `rpc`（PostgREST）で関数を呼ぶので、関数は公開の schema `public` に置く必要がある。Supabase の公式の注意は SECURITY DEFINER を公開の schema に置かないことだが、Database Advisor の lint [`0028_anon_security_definer_function_executable`](https://supabase.com/docs/guides/database/database-advisors?lint=0028_anon_security_definer_function_executable) と [`0029_authenticated_security_definer_function_executable`](https://supabase.com/docs/guides/database/database-advisors?lint=0029_authenticated_security_definer_function_executable) の解決策は、`PUBLIC`・`anon`・`authenticated` から EXECUTE を外すこと（`PUBLIC` も外さないと既定の付与が残る）で、[Database Functions の「Function privileges」](https://supabase.com/docs/guides/database/functions#function-privileges)も同じ向きである（公式は既定の security invoker を最善とする。lint の解決策 2 も invoker にする案）。表は `private` に置いて PostgREST から見えなくし、関数だけを service role に開ける。先例は `20261022084844_order_status_links.sql`（E-5 に本番適用済み）。

#### 決定

- 戻り先は、ログインを始める POST（`/api/auth/login`・`/api/auth/oauth/start`・`/api/auth/register`）の成功した所で、戻り先の確かめに通った時だけ作る。GET では作らない
- 表 `private.auth_return_intents` には番号の sha256 だけを持つ。番号は 128 ビット以上の乱数（base64url）。Cookie `sb-return-intent` は HttpOnly・本番は Secure・SameSite=Lax・Path=/・`Max-Age` は期限と同じ
- 作る・使い切るの 2 本の関数を `public` に置く。`SECURITY DEFINER`・`search_path` は空・EXECUTE は service role だけ。使い切りは `UPDATE … WHERE consumed_at IS NULL AND expires_at > now() RETURNING` の 1 回
- 出口は 2 種類。サーバーが 303 で移す所（Google の戻り・確認のメールのリンク）はその場で使い切る。端末が移す所（確認コードの確定・TOTP の確定）は `POST /api/auth/post-login` が使い切って行き先を返す。管理者・サポーターは aal2 になるまで使い切らない
- 出口でも役割と aal2 を含めて確かめ直す。`/admin` は 2 段目を済ませた管理者・サポーターだけ
- Google の開始は `fetch` の POST で控えを作り、返った authorize の URL へ端末が移る。CSP の `form-action 'self'` がフォームの送信に続くリダイレクトの行き先にも当たるので、フォームの POST から外への 303 は使えない
- 戻りの URL（`/api/auth/oauth/callback`）と確認のメールのリンク（`/api/auth/confirm`）に `next`・番号を載せない

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| URL の `next` をそのまま使う（確かめだけ強くする） | OWASP の「行き先を入力に使わない」に反する。Shopify の `return_to` は相対だけ（[Customer sign-in links and redirects](https://shopify.dev/docs/storefronts/themes/sign-in)）だが、値そのものが URL に載り、確認のメールや Referer を経て改ざん・流出する。確かめの抜け（タブ・改行・`..`）が起きるたびに open redirect になる |
| 署名つきの戻り先を Cookie にだけ持つ | サーバーの側で失効させたり 1 回限りにしたりできない。署名の鍵の用途が増える（SEC-AUTH-027 は用途ごとに別の鍵を求める） |
| 署名つきの戻り先を URL に載せる | 値が URL に載る。メールのリンクや Referer を経て流出し、署名の鍵の用途も増える |
| 関数を SECURITY INVOKER にし、表の権限を service role に付ける | service role は RLS を通らないので動くが、表の権限を service role に残すことになる。DEFINER にして表の権限を service role からも外し、触る道を関数 2 本だけにする（先例 `order_status_links` と同じ形）。EXECUTE は service role だけなので、DEFINER の危険（公開の schema の関数を誰でも呼べる）は残らない |
| 関数を `private` に置き、`public` に包みを作らない | PostgREST は公開の schema の関数しか `rpc` で呼べないので、サーバーが呼べない |

#### 結果

- 良くなること: URL の値で出口が決まらないので、確かめの抜けがあっても外の住所へ出る道が減る。番号は盗みにくく、2 回は使えない。ログインを始めた頁と会員だけの頁へ戻れる
- 悪くなること: 表・関数 2 本・Cookie・毎日の掃除が増える。ログインを始める POST ごとに DB へ 1 回書く（今の回数の制限に乗る）。別のブラウザで確認のリンクを開いた人には戻り先が無く、`/` へ着く
- 見直す条件: 管理者・サポーターの戻り先を保持する時間が足りない時。Supabase の公開の schema の関数の扱いが変わる時

## 未確認事項

- 本番の Supabase の Redirect URLs に `/api/auth/oauth/callback`（クエリ無し）が載っているか
- 移行の本番への適用は G-3（発送）の本番適用の後。本番アプリは未公開
