# ADR-0417 アプリの session に結び付ける（自前の sessions に GoTrue の session_id を残す）

> 状態: 現行（決定と、移行 M1 `sec_app_session_binding` の文面・試験まで。アプリの書く側・読む側・旗・DB の `has_permission` と会員の表の方針は波 5 の後続のタスクで入れる。M1 は `supabase/pending-wave5/` にあり、本番へは未適用） | 確認日: 2026-10-29 | 対象: `public.sessions.auth_session_id`、`private.app_session_is_live`、`public.is_app_session_active`、`private.is_app_bound_live_session` | 基準コミット: `0daeb6dc`（作業ツリー）

## 概要

ログインの流れ（パスワード → メール OTP → 必要なら TOTP）を通ってアプリが作った session だけを受ける。アプリは session を作った時に、GoTrue の `session_id` を自前の `public.sessions.auth_session_id` に残す。窓口（`authenticateRequest`）と DB（`has_permission`・会員の表の方針）は、JWT の `session_id` に当たる失効していない行が自前の `sessions` にあり、GoTrue の `auth.sessions` にも生きている時だけ通す。アプリを通らずに anon キーで取った通行証（パスワードだけ・メール OTP だけ）は、窓口で 401、PostgREST で 0 行になる。この ADR の範囲の移行 M1 は追加だけ（列・索引・関数 3 本）で、既存の挙動を変えない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SEC-AUTH-005、SEC-AUTH-010、SEC-AUTH-031、DATA-AUTH-007 |
| 対象のコード | 移行 `20261029120000_sec_app_session_binding.sql`（列・部分索引・関数 3 本）。アプリの書く側（`register.ts` の `persistSessionAndCookies`、`session.ts` の `persistNewSession`、`refresh`・`mfa/verify`）と読む側（`authenticate.ts`）は後続のタスク |
| 関連文書 | [AUTH の要件](../../02_Requirements/areas/auth.md)、[AUTH の脅威](../../05_Quality/security/threats/auth.md)、[AUTH の構造設計](../areas/auth.md)（DATA-AUTH-007）、`docs/superpowers/plans/2026-10-29-wave5-session-binding-aal2-db.md`、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave5-decisions.md`（Q30）、`wave5-q30-research.md` |
| 試験 | `tests/unit/migrations/sec-app-session-binding.test.ts`、`tests/integration/db/auth_app_session_binding.integration.test.ts`（DB 結合は手元の DB でまだ流していない） |
| 調べた時点 | 2026-10-29（移行の文面の単体の試験は流した。DB の試験・Task 0 の実測（refresh と TOTP の昇格で `session_id` が変わらないこと）は controller が流す） |

## 判断

### ADR-0417 アプリの session に結び付ける（自前の sessions に GoTrue の session_id を残す）

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-005、SEC-AUTH-010、SEC-AUTH-031 |
| 根拠 | anon キーは公開で、`/auth/v1/token?grant_type=password` や `/auth/v1/otp` → `/auth/v1/verify` でアプリを通らずに通行証が取れる。通行証の `amr` には OTP だけの道でも `otp` が入るので、`amr` を見る設計では断れない（NIST SP 800-63B-4 3.1.3.1 は、メールを out-of-band の認証器として使えないとする）。アプリが作った session に印を付ければ、アプリを通らない通行証は印が無いので断れる。session の寿命と失効は GoTrue が持ち続け、自前の表は印と失効の控えだけを持つ |
| 状態 | 現行 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave5-decisions.md`（Q30 のユーザーの決定 2026-10-29）、`wave5-q30-research.md`（NIST SP 800-63B-4・OWASP ASVS・Supabase の公式文書・Auth0・Shopify の一次資料）、`design-final.md`（R2・R3） |

#### 背景

| 観点 | 今の私たち（直す前） | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| 2 段のログインの強制 | 窓口は access token の署名と期限だけを見る。パスワードだけ・OTP だけの通行証でも会員の窓口が通る。管理側は `amr` に TOTP の印を見る | 確かめていない（Shopify の公式資料でこの点を読んでいない。ホスト型で店の側に選択が無いと推測するが、根拠にしない） | 2 段目を終えた session だけに「認証済み」の印を付け、サーバー側で session を検証する（OWASP Session Management / ASVS V3） | アプリが作った session だけに印を付け、窓口と DB が印を求める |
| session の寿命と失効 | GoTrue（`auth.sessions`）と自前の `sessions` の両方 | - | 失効はサーバー側の状態で即時に効かせる | 期限は GoTrue、失効は両方。判定は「GoTrue で生きている **かつ** 自前に失効していない行がある」 |
| 会員の 2 段の呼び名 | - | - | NIST の AAL2 は、メールを要素に数えない | **アプリ独自の方針の 2 段**と書き、AAL2 を名乗らない。管理者の TOTP が AAL2 側 |

#### 決定

- `public.sessions.auth_session_id uuid`（NULL 可）を足し、アプリが作った session の GoTrue の `session_id` を入れる。今ある行は NULL のまま（結び付いていない扱い）。`WHERE revoked_at IS NULL AND auth_session_id IS NOT NULL` の**一意でない**部分索引を付ける。更新は新しい行を先に入れて旧行を後で失効するので、同じ `auth_session_id` の生きた行が一時的に 2 本並ぶため
- 生存の判定 `private.app_session_is_live(uuid)`: `auth.sessions` に行があり `not_after` が空か未来、かつ `public.sessions` に `auth_session_id` と `user_id` が一致する失効していない行がある。`sessions.expires_at` は見ない（書き手によって access token の期限と 7 日で意味が違う。期限の権威は GoTrue）
- `public.is_app_session_active(uuid)` は service role 用の入口、`private.is_app_bound_live_session()` は JWT の `session_id` を形で確かめてから呼ぶ DB 用の入口（M2 の方針と `has_permission` が使う）。EXECUTE は最小にする（所有者だけ／service_role／authenticated と service_role）。`public.is_auth_session_active` は変えない
- 結び付けの強制は環境変数の旗で段階的に有効化し、既存の利用者は有効化の時に全員再ログインになる（開店前に入れる。旗の既定は ADR-0419）
- 会員の 2 段（パスワード＋メール OTP）は NIST の AAL2 ではなく、アプリ独自の方針の 2 段と要件に書く。Google のログインは 2 段目済みとして今の挙動を保つ（Q3）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| (b) `amr` に `otp`／`totp` があることだけを見る | OTP だけの通行証にも `otp` が入り、パスワード無しの道を断れない |
| (c) Custom Access Token Hook で `session_id` の印を JWT に載せる | 最初の通行証には付かない、障害面（Hook の失敗でログインが落ちる）が増える、失効が遅れる。RLS の検索が重いと実測で分かった時の上乗せにする |
| (d) 会員を Supabase の標準の MFA に移す | メールは MFA の要素ではない（TOTP・電話だけ）。会員に TOTP を強いることになり、決まった体験（メール OTP）と合わない |
| `auth_session_id` を一意にする | 更新の間は新旧 2 本の生きた行が並び、新しい行の insert が落ちる |
| 判定に `sessions.expires_at` を使う | 列の意味が書き手でずれる（access token の期限と 7 日）。NULL も許す列 |

#### 結果

- 良くなること: アプリを通らない通行証は、窓口で 401、PostgREST で 0 行になる。session の失効（ログアウト・強制失効・パスワード再設定）が自前の行と GoTrue の両方で効く
- 悪くなること: 有効化の時に既存の session は全部無効になり、全員が再ログインになる。生存の確認が `auth.sessions` と `public.sessions` の 2 表の結合になる（索引で抑える）。refresh の流れは、結び付いていない session を洗って結び付けてしまわないよう、前の行を確かめる作りに変わる（後続のタスク）
- 前提: refresh と TOTP の昇格で GoTrue の `session_id` が変わらないこと。波 5 の Task 0 で実測し、変わるなら設計を見直す
- 見直す条件: RLS の検索が重いと実測で分かった時（(c) を上乗せ）。refresh で `session_id` が変わると分かった時

## 未確認事項

- refresh と TOTP の昇格の前後で `session_id` が変わらないこと（Task 0 の実測）。ローカルは TOTP が無効で本物の `mfa.verify` が流せないので、本物の昇格は配備前の preview で 1 回確かめる
- `amr` の方法名（`otp` か `magiclink` か）の実測（`src/lib/auth/amr.ts` の注の直し）
- 移行 M1 の DB 結合試験と本番への適用（controller の手順。本番のアプリは未デプロイ）
