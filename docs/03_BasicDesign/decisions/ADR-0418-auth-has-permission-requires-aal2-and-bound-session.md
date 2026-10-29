# ADR-0418 has_permission に aal2 と結び付いた生きた session を求め、会員の本人の行の表は RESTRICTIVE にする

> 状態: 現行（決定と、移行 M2 `sec_has_permission_aal2_member_rls` の文面・試験まで。M2 は `supabase/pending-wave5/` にあり、本番にも手元の DB にも未適用。controller が M1・アプリのコードの後、全員がログインし直した後に当てる） | 確認日: 2026-10-29 | 対象: `public.has_permission`、`profiles`・`orders`・`order_items` の RLS の方針 | 基準コミット: `cc53258f`（作業ツリー）

## 概要

`public.has_permission(permission_code)` は今、ACL の表（`user_roles`・`roles`・`role_permissions`・`permissions`）だけを見る。アプリを通らずに anon キーで取った通行証（パスワードだけ・メール OTP だけ・任意の session）でも、その利用者に ACL の権限があれば、PostgREST から管理の表に届く。本体に「JWT の `aal` が `aal2`」と「`session_id` が結び付いた生きた session（ADR-0417）」の検査を足し、これを使う約 100 の RLS の方針を書き換えずに従わせる。`has_permission` を使わず `auth.uid() = user_id` で本人の行を返す `profiles`・`orders`・`order_items` には、結び付いた生きた session を求める `AS RESTRICTIVE` の方針を 1 本ずつ足す。ユーザーの決定は Q2 案 B（全部の表を一度に）。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH（DB の部品。NEWS・LOOK・STOCKIST・HOME・ADMIN の方針は `has_permission` 経由で効く） |
| 対応する ID | SEC-AUTH-005-AC-02、SEC-AUTH-010-AC-03、DATA-AUTH-008。ほか SEC-ADMIN-002、SEC-LOOK-003、SEC-NEWS-002、SEC-STOCKIST-003、SEC-HOME-003 |
| 対象のコード | 移行 `20261029120100_sec_has_permission_aal2_member_rls.sql`（`has_permission` の置き換え、会員の表の方針 3 本）。部品は M1（`private.app_session_is_live`・`private.is_app_bound_live_session`） |
| 関連文書 | [ADR-0417](./ADR-0417-auth-bind-app-session-to-gotrue-session-id.md)、[ADR-0419](./ADR-0419-auth-require-app-session-flag-default-on.md)、[AUTH の要件](../../02_Requirements/areas/auth.md)、[AUTH の構造設計](../areas/auth.md)（DATA-AUTH-008）、[AUTH の脅威](../../05_Quality/security/threats/auth.md)（THR-AUTH-010）、`docs/superpowers/plans/2026-10-29-wave5-session-binding-aal2-db.md`（Task 6、P1・P2・P14・P15）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave5-decisions.md`（Q2）、`design-final.md`（R3） |
| 試験 | `tests/unit/migrations/sec-has-permission-aal2.test.ts`、`tests/integration/db/auth_has_permission_aal2.integration.test.ts`（DB 結合は手元の DB でまだ流していない）、書き換えた既存の DB 結合（`search-functions`・`look_rls`・`news_articles_rls`・`stockist_rls`・`role_permissions`・`order_internal_columns` ほか。補助 `helpers/app-session.ts`）、E2E（`FR-LOGIN-031`・`FR-ADMIN-MISC-005`・`FR-HOME-024`・`FR-LOOK-SEC-002`・`FR-NEWS-SEC-002`・`FR-STOCKIST-016` の `test.fail` を外した。M2 を当てるまで赤。流すのは controller） |
| 調べた時点 | 2026-10-29（移行の文面の単体の試験は流した。DB の試験は M2 を当てた手元の DB で controller が流す） |

## 判断

### ADR-0418 has_permission に aal2 と結び付いた生きた session を求め、会員の本人の行の表は RESTRICTIVE にする

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-005、SEC-AUTH-010 |
| 根拠 | RLS は PostgREST の直叩きに対する最後の砦で、アプリの窓口（ADR-0417）だけが結び付きを求めても、anon キーで取った通行証が DB から直に管理の表に届く。`has_permission` は本体 1 本で、これを使う方針は約 100（本番の 180 本のうち 83 本）。本体を直せば方針を書き換えずに全部に効く。会員の本人の行は `has_permission` を通らないので別の方針で閉じる |
| 状態 | 現行 |
| 出どころ | ユーザーの決定（Q2 案 B「全部の表を一度に」、Q30 案 (a)）、`wave5-decisions.md`、`design-final.md`（R3）、計画の P14・P15 |

#### 背景

| 観点 | 今の私たち（直す前） | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| DB の権限判定 | ACL の表だけを見る。JWT の `aal` も session の生存も見ない | 確かめていない（公式資料で読んでいない。ホスト型で店の側が DB に触れないと推測するが、根拠にしない） | Supabase の公式文書は、MFA を求める RLS に `auth.jwt()->>'aal' = 'aal2'` を使う例を示す（Auth の MFA の章）。OWASP ASVS V4.3.1 は管理の機能に多要素を求める | `aal2` を求める。session の生存は Supabase 公式にない拡張なので、アプリの結び付き（ADR-0417）を足す |
| 判定の置き場 | - | - | 権限の判定を 1 か所の関数に集め、方針はその関数を呼ぶ | 本体 1 本を直す。方針の書き換えは 112 か所に及び、写し間違いが起きる |
| 公開の読み | 公開の行は一般の会員も読める | - | RESTRICTIVE を表全体に付けると、公開の読みも止まる | 公開の読みの方針には RESTRICTIVE を付けない |

#### 決定

- `public.has_permission` を `CREATE OR REPLACE` で置き換える。直前の本体（`20261023175712_group_g0_permissions.sql`）を写し、ACL の `EXISTS` は一字も変えない。検査の順は、(1) `auth.uid()` が空なら偽、(2) JWT の `aal` が `aal2` でなければ偽（`aal` が無いと `aal1` 扱い）、(3) ACL が偽なら偽、(4) ACL が真の時だけ `private.app_session_is_live(session_id)`。安い検査を先に置くので、会員（aal1）と anon は ACL の表を引く前に返り、今より軽くなる
- `session_id` は uuid の形を正規表現で確かめてからキャストする。形が悪い・無い場合は偽で、例外を出さない（PostgREST の応答を 500 にしない）
- `SECURITY DEFINER SET search_path = ''` を書き直す（書かないと設定が消える）。`CREATE OR REPLACE` は所有者と EXECUTE（`authenticated`・`service_role`・`postgres`。`anon` なし）を保つので、移行に GRANT・REVOKE を書かない
- `profiles`・`orders`・`order_items` に、`CREATE POLICY "require app bound live session" ... AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT private.is_app_bound_live_session())) WITH CHECK ((SELECT private.is_app_bound_live_session()))` を 1 本ずつ。先に `DROP POLICY IF EXISTS`。`anon` には付けない（ゲストの注文は `app.session_id` で読む。anon の道は変えない）
- 会員の本人の行を返す表はこの 3 表で全部。本番の `pg_policies` と移行を読み、`auth.uid()`・`auth.jwt()` を使う方針は `profiles`（4 本）・`orders`・`order_items` だけと確かめた。`carts`・`wishlists`・`checkout_drafts`・`contact_*`・`refresh_token_history`・`postal_code_cache` は直のクライアントを全拒否、`user_roles` は `has_permission('admin.users.read')`
- DB に旗は置かない（ADR-0419）。当てた瞬間に効き、戻すのは移行のヘッダーの ROLLBACK（G-0 の本体の全文と `DROP POLICY` 3 本）
- 当てる順は M1 → アプリの書く側・読む側 → 全員がログインし直す → M2。M1 が無い DB では、移行の冒頭で何も変えずに止まる
- G の書き手（`private.group_g_actor_has_permissions(_actor_id, ...)`）は `auth.uid()` にも `has_permission` にも依らず、service role から呼ぶので変えない

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 案 A: 6 つの表（管理の主な表）だけに RESTRICTIVE を付ける | 残りの約 100 の方針が開いたまま。新しい表を足すたびに足し忘れが起きる。ユーザーが案 B（全部の表を一度に）を選んだ |
| Custom Access Token Hook で結び付きを JWT に載せる | 最初の通行証には付かない。Hook の失敗でログインが落ちる。失効が遅れる（ADR-0417 と同じ理由） |
| 方針を表ごとに書き換えて `aal` と生存を書く（112 か所） | 写し間違いが起き、新しい方針が検査を忘れる。本体 1 本で全部に効く |
| 公開の読みの方針に RESTRICTIVE を付ける | 公開の商品・記事を読む一般の会員（aal1）が止まる。`status = 'published' OR has_permission(...)` の OR の枝が偽になるだけで足りる |
| 会員の表の方針を `anon` にも付ける | ゲストの注文を `app.session_id` で読む道が止まる |
| `has_permission` に GRANT・REVOKE を書き直す | `CREATE OR REPLACE` が権限を保つ。書くと `anon` の取り消しなどを取りこぼす |

#### 結果

- 良くなること: アプリを通らない通行証は、窓口で 401（ADR-0417）、PostgREST で管理の表と会員の行が 0 行（権限なし）になる。aal1 の管理者も DB では読めない。方針の書き換えなしで約 100 の方針に効く
- 悪くなること: 当てた瞬間に、結び付いていない session（既存のログイン済みの全員）は DB で 0 行・権限なしになる。再ログインが要る。`has_permission` を呼ぶたびに、ACL が真の時だけ `auth.sessions` と `public.sessions` の結合が増える（M1 の部分索引で抑える）。旗では戻せず、ROLLBACK の移行が要る
- 前提: M1 が当たっていること。アプリの書く側が `auth_session_id` を残していること。管理の E2E・DB 結合試験の通行証が結び付いた生きた session で作られること（`tests/integration/db/helpers/app-session.ts`、`e2e/admin-session-test-utils.ts` の `bindAppSession`）
- 見直す条件: 会員の本人の行を返す表を G-4・H が足した時（同じ方針を足す）。RLS の検索が重いと実測で分かった時（Custom Access Token Hook を上乗せする）
- 残る危険: パスワードとメールの受信箱の両方を盗まれた攻撃者が正規の 2 段を踏む場合（会員の 2 段はアプリ独自の方針で NIST の AAL2 ではない。管理者は TOTP が上乗せ）
- 関連する既存の ADR: ADR-0003・0005・0006（NEWS・ADMIN の DB の段は aal を見ない、と書いた当時の判断）は、M2 を当てた後は DB も aal2 と結び付いた生きた session を求める。各 ADR の「悪くなること」に追記した

## 未確認事項

- M2 の DB 結合試験を手元の使い捨て DB で流した結果（controller が M2 を当てた後に流す）
- 本番で M2 を当てる時期（G-1 の次の `db push --linked` と一緒の案。順序は M1 → アプリ → 全員が再ログイン → M2）。本番のアプリは未デプロイだが、普段の開発が本番の DB につながるので、当てると開発者も再ログインになる
- G-4・H が会員の行を PostgREST に返す新しい表を足すかどうか（足せば同じ RESTRICTIVE の方針が要る）
