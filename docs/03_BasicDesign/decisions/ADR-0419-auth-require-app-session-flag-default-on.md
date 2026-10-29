# ADR-0419 結び付けの旗 AUTH_REQUIRE_APP_SESSION は既定で有効にする

> 状態: 現行（旗の判定、書く側、refresh の強制、読む側の生存の確認まで入った） | 確認日: 2026-10-29 | 対象: 環境変数 `AUTH_REQUIRE_APP_SESSION`、`src/lib/auth/app-session.ts`（`isAppSessionRequired`）、`refresh` の窓口、`persistSessionAndCookies`、`authenticate.ts` の `checkAuthSessionLiveness` | 基準コミット: `cc53258f`（作業ツリー）

## 概要

アプリの session への結び付け（ADR-0417）を強制するかを、環境変数 `AUTH_REQUIRE_APP_SESSION` で切り替える。値が `off`・`0`・`false`（大小文字を区別せず、前後の空白は無視）の時だけ無効で、未設定・空・その他は有効にする。旗は読む側（生存の確認と `refresh` の強制）だけを切り替え、書く側（ログイン・更新・昇格が `auth_session_id` を残すこと）は旗に関係なく常に書く。DB 側（`has_permission` と会員の表の方針。ADR-0418）に旗は置かない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SEC-AUTH-005、SEC-AUTH-031、SEC-AUTH-030 |
| 対象のコード | `src/lib/auth/app-session.ts`（`isAppSessionRequired`）、`src/app/api/auth/refresh/route.ts`、`src/features/auth/services/register.ts` の `persistSessionAndCookies`、`src/lib/auth/authenticate.ts` の `checkAuthSessionLiveness`（旗が有効な間 `is_app_session_active`、無効なら従来の `is_auth_session_active`） |
| 関連文書 | [ADR-0417](./ADR-0417-auth-bind-app-session-to-gotrue-session-id.md)、[AUTH の要件](../../02_Requirements/areas/auth.md)、[ログインと認証の詳細設計](../../04_DetailDesign/pages/14_login.md)（DD-AUTH-039）、`docs/superpowers/plans/2026-10-29-wave5-session-binding-aal2-db.md`（P12、ruling 1・3）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave5-decisions.md` |
| 試験 | `tests/unit/lib/auth/app-session.test.ts`、`tests/unit/api/auth/refresh-route.test.ts`、`tests/unit/services/register.test.ts`、`tests/unit/scripts/e2e/environment.test.ts`（E2E で `on` に固定）、`tests/unit/e2e/admin-session-test-utils.test.ts`（E2E の通行証を結び付ける道具） |
| 調べた時点 | 2026-10-29（単体の試験は流した） |

## 判断

### ADR-0419 結び付けの旗 AUTH_REQUIRE_APP_SESSION は既定で有効にする

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-005、SEC-AUTH-031 |
| 根拠 | 旗の既定を無効にすると、設定し忘れた環境で穴（anon キーで取ったパスワードだけ・OTP だけの通行証が会員の窓口を通る）が開いたままになる。本番のアプリは未デプロイで会員がほぼいないので、再ログインの費用が最小の今のうちに既定を有効にできる。手元・E2E・単体でも実際の道を毎回通せる |
| 状態 | 現行 |
| 出どころ | ユーザーの決定（2026-10-29「旗は最初からオン。off・0・false の時だけ外れる」）、`wave5-decisions.md`、計画の P12・ruling 1 |

#### 背景

| 観点 | 今の私たち（直す前） | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| 新しい守りの入れ方 | 旗は無く、守りは常に有効かまったく無いか | 確かめていない（公式資料で読んでいない） | 安全側に倒す設定を既定にし、無効化は明示の操作にする（secure by default） | 既定は有効。無効にするのは `off`・`0`・`false` を明示した時だけ |
| 段階的な有効化 | - | - | 先に無効で配備し、書き込みの状態を確かめてから有効にする | 段階が要る時だけ `off` で配備し、`select count(*) from public.sessions where auth_session_id is not null and revoked_at is null` で行ができたのを確かめてから外す |

#### 決定

- `isAppSessionRequired()` が 1 か所で環境変数を読む。値を小文字にして前後の空白を除き、`off`・`0`・`false` の時だけ偽にする。それ以外（未設定・空・`on`・`1`・`true`・綴り違いを含む）は真にする。綴り違いで無効にならないよう、無効にする語を限る
- 旗が影響するのは読む側だけ。有効な間は、`refresh` が結び付いていない行の refresh token を Supabase を呼ぶ前に断ち（SEC-AUTH-005-AC-05）、生存の確認は結び付き込みの RPC `is_app_session_active` に替わる（`checkAuthSessionLiveness`。名前・引数・戻り値は変えない）。無効な間は従来の動きに戻る
- 書く側（`persistSessionAndCookies`・`persistNewSession`）は旗に関係なく常に `auth_session_id` を残す。旗を後から有効にした時に、すでに行が結び付いている状態にするため。旗が有効な間だけ、`persistSessionAndCookies` は access token に `session_id` が無ければ行を作らず失敗にする
- DB 側に旗を置かない。DB は環境変数を読めず、設定表を置くと旗の改ざんの面が増える。M2 は当てた時に効き、戻すのは M2 の ROLLBACK
- jest の環境では旗を `off` にしない。単体でも実際の結び付けの道を通す。旗が無効の分岐は、その試験の中で `AUTH_REQUIRE_APP_SESSION` を明示して確かめる
- E2E の固定の環境に `AUTH_REQUIRE_APP_SESSION: 'on'` を入れる（Task 4）。手元の `.env.local` の `off` で E2E が偽の緑になるのを防ぐ

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 既定を無効にし、有効にする時に `on` を設定する | 設定し忘れた環境で穴が開いたままになる。決定文の「環境変数の旗で段階的に有効化」の字面には合うが、ユーザーが「最初からオン」と決めた |
| 有効にする語を限る（`on`・`1`・`true` の時だけ有効） | 綴り違い・空文字で守りが無効になる。無効にする語を限るほうが安全側に倒れる |
| DB に旗の表を置く | 旗の改ざんの面が増える。DB の守りは M2 を当てるかどうかで決める |
| 書く側も旗で切り替える | 旗を有効にした時点で結び付いた行がまだ無く、全員が再ログインになる範囲が広がる。常に書けば、無効の間にできた session は有効にした後も使える |

#### 結果

- 良くなること: 設定し忘れで穴が開かない。手元・E2E・単体が実際の道を通す
- 悪くなること: `AUTH_REQUIRE_APP_SESSION` を知らずに古い session を使う開発者は、`auth_session_id` を持たない既存の session の更新が 401 になり、再ログインになる。`persistSessionAndCookies` の行の書き込みに失敗して hash がずれた利用者も、再ログインになる（今までは Supabase が通していた）。意図した変更
- 前提: 移行 M1（`auth_session_id` 列）が当たっていること。無いと書く側が全ログインを落とす
- 見直す条件: 旗を外した配備が長く続くなら、旗そのものを廃止して常に有効にする

## 未確認事項

- 本番に設定する時の `off` の使い方（段階的な有効化の手順）は、開店前の本番の適用の時に controller が決める
- 旗の廃止の時期
