# ADR-0464 店員の入口の判断は1か所に置き、登録の窓は案 B、認めたパスキーはアプリの表で数える

> 状態: 推定（段1a の Task 4 で表・窓・認めたパスキーの判断を書き、Task 5 でフックの判断を足した） | 確認日: 2026-11-16 | 対象: `supabase/migrations/20261116215034_passkey_foundation_tables.sql`、`supabase/migrations/20261116230000_passkey_access_token_hook.sql`、`src/lib/auth/staff-passkey-defaults.ts`、`src/lib/auth/staff-passkey-reject.ts` | 基準コミット: `c336e0b5`（作業ツリー）

## 概要

店員（店長・サポーター）の入口の判断に使う値は、DB の `private` の4つの表と6つの関数に1か所で持つ。登録の窓は、アプリがセッションを作った後に、分かったセッションの番号で開ける（案 B）。「認めたパスキー」はアプリが自分の表に控え、数える時に鍵が実在する分だけを数える。フックが1か所であることの判断は、末尾の「Task 5 の追記」に書いた。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | FR-AUTH-007、FR-AUTH-008、SEC-AUTH-036、SEC-AUTH-037、THR-AUTH-036、THR-AUTH-037、DATA-AUTH-011、DATA-AUTH-012、DATA-AUTH-013、DATA-AUTH-015、DATA-AUTH-017、DD-AUTH-043、DD-AUTH-044、DD-AUTH-046、DD-AUTH-049 |
| 対象のコード | 移行 `supabase/migrations/20261116215034_passkey_foundation_tables.sql`・`20261116230000_passkey_access_token_hook.sql`、`src/lib/auth/staff-passkey-defaults.ts`・`staff-passkey-reject.ts` |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)（5-2・5-5・6-2・12 の18）、[計画](../../superpowers/plans/2026-11-16-passkey-stage1a-foundation.md)、[手元の試しの結果](../../superpowers/specs/2026-11-16-passkey-local-trial-results.md) |
| 試験 | DB 結合 `tests/integration/db/auth_passkey_foundation.integration.test.ts`、単体 `tests/unit/lib/auth/staff-passkey-defaults.test.ts`、E2E `e2e/FR-LOGIN-041-passkey-foundation-grants.spec.ts`、DB 結合 `tests/integration/db/auth_passkey_access_token_hook.integration.test.ts`、単体 `tests/unit/lib/auth/staff-passkey-reject.test.ts`、E2E `e2e/FR-LOGIN-042-passkey-hook-function-grants.spec.ts` |
| 調べた時点 | 2026-11-16（手元の Supabase で `db reset` の後に DB 結合を流した。E2E は書いただけで、調整役が流す） |

## 判断

### ADR-0464 店員の入口の判断は1か所に置き、登録の窓は案 B、認めたパスキーはアプリの表で数える

| 属性 | 値 |
| --- | --- |
| 上位 | FR-AUTH-007、FR-AUTH-008、SEC-AUTH-036、SEC-AUTH-037 |
| 根拠 | 店員の入口は、「パスキー」「24時間」「認めたパスキー2本」の3つを API と RLS の両方で同じに判断する必要がある（設計 5-2）。値と控えが複数の場所に散ると、片方だけ変わって食い違い、静かにお客さん扱いで通す穴になる。窓を `session_id` に結ぶ案 B は、手元の試し T6 で、案 A（フックが最初に来たセッションに結ぶ）が、窓が空の間に同じ人のメールのコードのセッションに結ばれて、パスキー無しで発行された事実から決まった（オーナーが 2026-11-16 に決定） |
| 状態 | 推定 |
| 出どころ | `docs/superpowers/specs/2026-11-07-passkey-auth-design.md`（5-2・5-5・6-2・12 の18）、ユーザーの決定 2026-11-16 |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| 店員の入口の条件 | `aal2`（TOTP）かどうかだけ | 確かめていない（Shopify の公式資料で店のスタッフの認証の設計を読んでいない） | 管理者には多要素を求め、要素の数を保存して判断する（NIST SP 800-63B の保証の水準の考え方） | パスキー・24時間・認めたパスキー2本を、DB で毎回数えて判断する |
| 設定の置き場 | コードの定数 | - | 設定は1か所に置く | DB の1行（`private.passkey_staff_config`）を `security definer` の関数で読ませる。TS の初めの値は単体テストで一致を確かめる |
| 窓の結び先 | なし | - | 発行したセッションの識別子に結ぶ | `(user_id, session_id)`。案 B |

#### 決定

- 設定は `private.passkey_staff_config`（1行・check で複数行を禁止）に置く。外へは `private.passkey_staff_settings()`（`security definer`・`stable`）だけで読ませ、`public`・`anon`・`authenticated` から `execute` を外す
- 認めたパスキーは `private.approved_passkeys` に控える。`user_id` に外部キーを張らない。利用者の削除の連鎖で認めの行が先に消えると、引き金が店員かを判れなくなるため。認めの行を消すのは Task 6 の引き金だけ
- `credential_id` は手元の `auth.webauthn_credentials.credential_id` を実測して `bytea` にした
- `passkey_approve` は、同じ鍵の2回目は何もしない。同じ `credential_id` が別の `passkey_id` で既に認められていれば、消さずに例外（`23505`、`passkey_approve: credential already approved under another passkey`）にする。認めの行を消すのはトリガー（Task 6）だけ
- 関数と表の所有者は `postgres` と移行に明記し、末尾の確かめで所有者・`SECURITY DEFINER`・`search_path` が空であることを見る
- 数え方は `passkey_approved_count`。認めの行と鍵の行を `c.id = ap.passkey_id and c.user_id = ap.user_id` でつなぎ、その行だけを数える。引き金が動かなかった時（`TRUNCATE`・`DISABLE TRIGGER`・引き金の例外の囲み）でも、消えた鍵・他人の鍵を指す認めは数えない
- 登録の窓は案 B。アプリが `auth.sessions` に在るセッションを確かめてから `passkey_window_open(user, session)` で開ける。同じ `session_id` の開いた窓は1つだけ（部分の一意の索引）で、2回目は既存の期限を返す
- `public.passkey_*` は全部 `service_role` だけが `execute` できる
- TS の `defaultStaffPasskeySettings()` の値と DB の設定の初めの値は同じにする。変える時は両方を同じコミットで変える（単体テストが移行の既定値との一致を、DB 結合テストが DB の設定の行との一致を確かめる）
- DB の設定の行は、動いている間に変えるつまみではない（最終レビュー M-2）。API は TS の定数で判定し、フックと RLS だけが行を読むので、SQL で行だけを変えると3か所の判定が割れる。変える時は、コードと同時（同じコミット）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 窓を `session_id` 無しで開け、フックが最初に来たセッションに結ぶ（案 A） | 窓が空の間に同じ人のメールのコードのセッションが先に来ると、そのセッションが窓に結ばれ、パスキー無しで発行された（T6）。メールのリンクとコードはフックでは区別できない |
| 認めの表の `user_id` に `auth.users` への外部キーを張る | 利用者の削除の連鎖で認めの行が先に消え、引き金が店員かを判れない |
| 数える時に認めの行だけを数える（鍵と突き合わせない） | 引き金が動かない道で鍵だけが消えると、数が実際より多くなり、管理の入口の3つ目の条件が緩む |
| 設定を JWT の中や環境変数に置く | 値の変更が複数の場所に散り、API と RLS で食い違う |

#### 結果

- 良くなること: 入口の値と控えが DB の1か所にあり、API と RLS が同じ答えを出せる。鍵が消えた認めは数えられない
- 悪くなること: `public.passkey_*` の関数が増える（`service_role` 専用）。移行は本番へ段1b と段3が済むまで当てない
- 見直す条件: パスキーが正式版になり GoTrue 側で同じ判断ができるようになった時。設定の値を変える時（TS と DB を同じコミットで）

#### Task 5 の追記（フックの関数。2026-11-16）

- フックは `public.passkey_access_token_hook(event jsonb)` の1本だけにする。店員の入口の判断（パスキー・24時間・窓）を、トークンを出す全部の道（ログイン時・更新時）で同じ関数が行う。アプリの窓口や別のフックに判断を分けない。処理は DD-AUTH-044、データは DATA-AUTH-013
- 窓は案 B のまま、フックは窓の表を書かない（読むだけ）。窓で通すのは方法が `otp`・`token_refresh`・`passkey` の時だけにした（招待の入口とその更新）。`oauth`・`password`・未知の方法は窓があっても拒否する。窓の中のセッションは `amr` に `passkey` が付かないので、管理の入口（API と RLS）は通れない
- `staff_passkeys_ok` は JWT に残すヒントで、判定には使わない（認めたパスキーの本数は API と RLS がその場で数える）。数え方は `public.passkey_approved_count` と同じで、フックはその関数を呼ぶ
- お客さんの `password` の拒否は設定の旗 `reject_customer_password`（初めは偽）が真の時だけ。有効にするのは段4。それまではお客さんのログインを変えない。拒否の文の印は店員と別の `[customer-password-disabled]`（403）にする。店員の印と同じだと、アプリがお客さんを「店員はパスキーで」の画面に送ってしまうため。`isStaffPasskeyRequiredError` はこの印では偽
- 「店員」は `user_roles` で有効（`active` で期限切れでない）な、役割の code が `admin` か `supporter` の人と決める。今の `has_permission` と合う理由: `user` の役割は権限が0件で、`admin_set_role_permissions` は他の役割への権限の付与を断る（`admin`・`supporter` 以外は権限を持たない）ので、「権限を持つ人」と「admin・supporter」は今は同じ集合になる。フックは役割の code で決め、権限の表は読まない。なお `has_permission` は、Task 8・9 で、`amr` の `passkey`・24時間・認めたパスキー2本の3つ（API と RLS）を求めるように変わるので、フックが通した店員でも、窓の中のセッションなど `amr` に `passkey` が無ければ管理の入口は通れない
- `staff_passkeys_ok` を数える関数が例外を出した時は、偽にして新しいパスキーの店員は通す（ヒントの失敗でログインを止めない）
- 失敗の倒し方: 例外は投げない。お客さんと判った後の失敗は入力を返し、店員の失敗と、店員かどうか判らない失敗（`user_id` が無い・不正）は拒否する。「判らなければお客さん扱いで通す」を避ける
- 拒否の印: 文の頭に `[staff-passkey-required]` を付け、HTTP 403（GoTrue は `code: unknown` で返す）。アプリは `isStaffPasskeyRequiredError`（`src/lib/auth/staff-passkey-reject.ts`）で見分ける。印は DB の関数と TS で同じ文字列で、単体テストが移行の文と一致を確かめる
- 権限: `execute` は `supabase_auth_admin` だけ（`public`・`anon`・`authenticated`・`service_role` から外す）。表の `select` は渡さない。関数が持ち主 `postgres` の権限で読む
- この移行ではフックを有効にしない（`config.toml` は触らない）。有効にするのは Task 9 で、本番へは段1b と段3が済むまで当てない
- 試験: DB 結合は、`postgres` が `supabase_auth_admin` になれないため、手元専用の `supabase_admin` の接続を別に開き `SET LOCAL ROLE supabase_auth_admin` で呼ぶ

## 未確認事項

- 本番の `auth.webauthn_credentials` の列の型（手元の GoTrue で実測した。本番はパスキーを有効にするまで表が無い可能性がある）
- 案 B の窓を開ける呼び出しと GoTrue のセッション作成の間の競り（Task 9 以降のアプリ側の窓口で確かめる）
