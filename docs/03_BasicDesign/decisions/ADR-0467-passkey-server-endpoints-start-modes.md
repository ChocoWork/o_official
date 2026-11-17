# ADR-0467 パスキーのサーバーの窓口は、始めの2つの道を設定で切り替え、UV の門を窓口に置き、GoTrue は `fetch` で直に呼ぶ

> 状態: 推定 | 確認日: 2026-11-17 | 対象: `src/lib/auth/passkey-start-mode.ts`、`passkey-start-config.ts`、`passkey-uv.ts`、`passkey-gotrue.ts`、`src/features/auth/schemas/passkey.ts`、`src/lib/build-env-guard.ts`、`src/app/api/auth/passkey/login/start/route.ts`、`scripts/e2e/environment.ts` | 基準コミット: 4f3c67b4

## 概要

ログインの終わりは必ずアプリの窓口を通す。始めは、サーバーが `sb_secret_` の鍵で GoTrue を呼ぶ道 (a) と、ブラウザが直に呼ぶ道 (b) を、設定 `NEXT_PUBLIC_PASSKEY_START_MODE` で切り替える（既定は (a)）。UV の確かめはログインの終わりで GoTrue を呼ぶ前に行い、GoTrue へは supabase-js でなく `fetch` で直に呼ぶ。以降のタスクがこの文書に判断を足す。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SEC-AUTH-042、THR-AUTH-043、SEC-AUTH-044、DD-AUTH-051、DD-AUTH-052、DD-AUTH-055、FR-AUTH-016、FR-AUTH-019 |
| 対象のコード | `src/lib/auth/passkey-start-mode.ts`、`passkey-start-config.ts`、`passkey-uv.ts`、`passkey-gotrue.ts`、`src/features/auth/schemas/passkey.ts`、`src/lib/build-env-guard.ts` |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)（4-2・5-1・5-3）、[段1b の計画](../../superpowers/plans/2026-11-17-passkey-stage1b-server-endpoints.md)、[ADR-0464](ADR-0464-access-token-hook-single-gate.md) |
| 試験 | 単体 `tests/unit/lib/auth/passkey-*.test.ts`、`tests/unit/features/auth/schemas/passkey.test.ts`、`tests/unit/lib/build-env-guard.test.ts` |
| 調べた時点 | 2026-11-17（手元で単体の試験を流した。窓口の E2E は Task 3・6 で足す） |

## 判断

### ADR-0467 パスキーのサーバーの窓口は、始めの2つの道を設定で切り替え、UV の門を窓口に置き、GoTrue は `fetch` で直に呼ぶ

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-042 |
| 根拠 | ログインの終わりをブラウザの直の呼び出しにすると、UV の門・認めた鍵の確かめ・アプリのセッションの結び付けを通らずに入れる。始めは GoTrue の回数の制限をお客さんごとに掛けるために IP が要り、サーバーから呼ぶなら `sb_secret_` の鍵と `Sb-Forwarded-For` が要る。本番の鍵の形が分からないので、どちらの道でも作れるようにして切り替える（設計 5-1） |
| 状態 | 推定 |
| 出どころ | `docs/superpowers/specs/2026-11-07-passkey-auth-design.md`（5-1・5-3）、`.superpowers/sdd/2026-11-17-passkey-stage1b-server-endpoints/task-2-brief.md` |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| パスキーの終わりの確かめ | 無し（パスワード＋TOTP） | 確かめていない（Shopify の公式資料でスタッフのパスキーの実装を読んでいない） | サーバーが署名・`userVerification`・認めた鍵を確かめる（WebAuthn Level 2 の 7.2 の考え方） | 終わりは必ずアプリの窓口を通し、UV の印が無ければ GoTrue を呼ばずに断る |
| 始めの回数の制限 | 無し | - | 呼び手の IP ごとに数える | サーバーが IP を添える (a) か、見えない Turnstile を付けるブラウザの直の呼び出し (b) |

#### 決定

- 始めの切り替えは設定 `NEXT_PUBLIC_PASSKEY_START_MODE`（`server`｜`browser`、既定 `server`）の1つ。ブラウザの部品はビルドの時に埋め込まれた値を読み、サーバーの窓口は動いている時の環境変数を読む。Vercel ではどちらも変えるには再デプロイが要るので、同じ値のまま動く。食い違った時（ビルドの後に変数だけを変えた場合など）は、(b) の時に窓口が 409 で断り、画面は「使えない」の側に倒れる（閉じる側）
- 始め (a) の鍵は、新しい変数 `SUPABASE_SECRET_KEY` を先に、無ければ `SUPABASE_SERVICE_ROLE_KEY` が `sb_secret_` の形ならそれを使う。本番の鍵の形を読んでいなくても、どちらでも動く。別の窓口の鍵は今のまま
- 手元の開発用の IP `PASSKEY_START_DEV_IP` は、手元の Supabase の住所のときだけ使い、本番・プレビューに残れば `next build`・`next start` を止める
- GoTrue は supabase-js でなく `fetch` で直に呼ぶ。supabase-js のパスキーの関数は更新トークンつきの session をメモリに持たないと動かず、窓口は要求の Cookie のアクセストークンだけを持つため。路・本文の形は `@supabase/auth-js` の実装（2.119.0）から写し、誤りの本文の形を supabase-js とそろえるため `X-Supabase-Api-Version: 2024-01-01` を付ける
- 登録の終わりで UV の印を読むため、自前の小さな CBOR の読み取りを足す（外のライブラリを足さない）。これは安全の門でなく、PIN の無い鍵を2本登録して「数だけ2本で入れない」状態になるのを避ける使い勝手の守り
- 始め (a) の窓口（Task 3、DD-AUTH-052）: 順番は 設定が `browser` なら 409 → IP が取れなければ 503 → IP ごとに5分20回 → 鍵の確かめ（失敗は窓口だけの 503。アプリ全体は止めない）→ GoTrue。IP は `getClientIp` だけで、無い時だけ手元の開発用の IP。IP が取れない時は枠に入れず 503 にする（`enforceRateLimit` は IP が `null` だと「送り元が分からない全員が1つの枠」になり、1人で全員の始めを止められるため）。回数は GoTrue の制限（5分30回）の手前の20回で、正当なやり直し（認証器のキャンセルなど）は数回で達しにくい。設定が `browser` の時の (a) は 409 にする（2つの道が同時に動くと、本番で添え書きが効かず (b) に切り替えた後も古い画面が (a) を呼び続け、`sb_secret_` の確かめを通らない状態が見えにくくなるため）。共有の `enforceRateLimit` は変えない。手元の開発用の IP の時だけ枠の IP が `null`（手元の共有の枠）になる
- E2E は手元の `supabase status` の `SECRET_KEY`（`sb_secret_`）を `SUPABASE_SECRET_KEY` として E2E のアプリに常に渡し（無ければ空）、`PASSKEY_START_DEV_IP` は空にする。`.env.local` の本番の鍵や開発用の IP が E2E に届かないため。手元の GoTrue は `Sb-Forwarded-For` を数えないので、手元で確かめるのは「ヘッダーを付けて 200」まで。IP ごとに数えるか・本番で効くかは本番の確認（設計 8-2 の1）
- 始め (b)（Task 4、DD-AUTH-053）: 画面を持たない関数 `createPasskeyAuthenticationStarter`（`src/features/auth/passkey/browser-start.ts`）として1b で作り、ブラウザの WebAuthn の呼び出しと画面は段2に回す（画面を1b で作ると見た目・Turnstile のウィジェット・エラーの文言が段2と二重になるため）。(b) は見えない形の Turnstile のトークンを `captchaToken` で GoTrue に渡し、無ければ GoTrue を呼ばない。`userVerification` は (b) ではブラウザの側で `required` に書き換える（設計 5-3）
- 1つの設定を両方が読む理由: ブラウザの部品とサーバーの窓口が同じ名前の `NEXT_PUBLIC_PASSKEY_START_MODE` を読むので、通常は画面が (a) を呼ぶのに窓口が (b) を前提にする、といった食い違いが起きない（ブラウザはビルドの時の値、窓口は動いている時の値。Vercel では両方とも再デプロイで変わる）。万一食い違っても、窓口は (b) の時に 409 で断るので、使えない側に倒れる。ただしブラウザの束では `process.env.NEXT_PUBLIC_X` とそのまま書いた形だけが埋め込まれ、既定の引数 `process.env` は空になる。そこでブラウザの部品は `process.env.NEXT_PUBLIC_PASSKEY_START_MODE` を直に書いて値だけ `resolvePasskeyStartMode` に渡す
- CSP は変えない: `connect-src` には自分の Supabase の origin 1つと Turnstile が既に入っており、(b) に要る許可はそろっている。ワイルドカードは入れず、試験（単体とページの中からの `fetch`）で固定する
- (b) に切り替える時は、本番の GoTrue で captcha を有効にする（今は captcha の段階 B の待ち）
- ログインの終わり（Task 6、DD-AUTH-055）: `POST /api/auth/passkey/login/finish` は、回数の制限 → 本文の形（`id` と `rawId` の一致）→ UV の門 → GoTrue → 店員の確かめ → アプリのセッション、の順。UV の門は GoTrue の前、店員の確かめは GoTrue の後（`user.id` が GoTrue の応答でしか分からないため）。認めた鍵は `rawId` を `bytea` に直した値で引く（GoTrue が署名を確かめる鍵と同じにするため）。認めていない鍵で入った店員は、GoTrue のセッションを `revoke_auth_session` で終わらせてから 403 にする。理由: 終わらせないと、GoTrue の側に更新できる生きたセッションの行が残る。トークンはこの 403 の道では端末に返さないので漏れはないが、更新できるセッションを残さないために終わらせる（アプリの結び付けで API・RLS は通らないが、残さない）。失敗の本文は `passkey_login_failed` の1つ（鍵の有無の調べに使わせない）。`next` と、お客さんの注文・カートの引き継ぎは、今のログインの終わり（`otp/verify`）と同じく終わりの窓口で行う
- 登録の始め・終わり（Task 7、DD-AUTH-056）: 店員の登録に2つの道を作る。(1) 登録の窓の中（`window`。窓が自分のセッションで開いていて、認めた鍵が2本未満の間だけ）、(2) 5分以内のパスキーでの入り直し（`reauth`。本数の上限なし。ただし認めた鍵が1本以上ある店員だけ。0本の店員は窓だけ。設計 6-2）。窓の免除を2本未満に絞るのは、メールを読めた人が窓の残りの30分で3本目を認めさせないため（設計 5-5・10）。窓の外で3本目・差し替えを足す道が(2)。お客さんは10分以内のパスキーかメールのコード（Google は含めない。Google で入った人は、足す前にメールのコードで入り直す）。店員は、旗 `AUTH_REQUIRE_APP_SESSION` に関わらず `checkAuthSessionLiveness(session_id, true)` を通す（旗を切った間に結び付かないセッションで鍵を認めさせない）。条件は始めと終わりの両方でやり直す（共通の確かめは `passkey-registration-guard.ts`）。認めが落ちた時は、管理 API で今作られた鍵を消す補償を入れる（鍵は GoTrue にあるが認めの表に無く、数に入らないため）。窓を閉じる・セッションを終わらせるのは段3（招待の流れと一体。1b の窓は30分で自然に切れる）
- 一覧・名前の変更・削除（Task 8、DD-AUTH-057）: `GET /api/auth/passkey`・`PATCH`・`DELETE /api/auth/passkey/{id}` は本人のアクセストークンで GoTrue の `/passkeys` を呼ぶ（管理 API は使わない）。店員の削除の止めをサーバーでもかける（設計 6-2 は画面で止めると書くが、画面が無い1bの窓口が2本未満へ減らす抜け道になるため）: 消す鍵が認めた鍵で、認めた本数から1を引くと2未満になる時、GoTrue を呼ばずに 409 `staff_min_passkeys`。認めていない鍵は止めず、お客さんは最後の1本も消せる。同時に2つの削除が来ると両方が通りうる隙は、完全な排他を作らず受け入れる（下回った店員は管理の入口で止まり、引き金の知らせが出る。SEC-AUTH-046）。一覧は許可リスト方式で写し、他人の鍵と存在しない鍵は 404 にそろえる。名前の長さは1〜64字（設計に長さの決めが無く、GoTrue の側の上限は未確認。端末名の初期値より長い名前を使う理由が無い）。

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 始めを (b) だけにする | Turnstile の確かめが画面に出る。設計は (a) を既定にし、IP の信頼を `getClientIp` の1か所に置く |
| 古い `service_role` の JWT で (a) を呼ぶ | 添え書き `Sb-Forwarded-For` が効かず、全員が1つの IP になる |
| 設定を `server` 側と `NEXT_PUBLIC_` 側の2つにする | 2つの値が食い違い、画面とサーバーの道が別になる |
| 登録・一覧・削除も supabase-js で呼ぶ | session をメモリに持てず、アクセストークンだけでは動かない |
| 外の CBOR のライブラリを足す | 読む形が小さく、依存を増やす理由が無い |

#### 結果

- 良くなること: 鍵の形・IP・UV の読み方・GoTrue の呼び方が1か所にそろい、窓口は閉じる側に倒しやすい
- 悪くなること: 本番の `SUPABASE_SERVICE_ROLE_KEY` が JWT の形だと、`SUPABASE_SECRET_KEY` を足すまで (a) は動かない（閉じる側）。自前の CBOR の読み取りは小さいが、保守の対象が増える
- 見直す条件: 本番の鍵の形が分かった時（設計 8-2）。GoTrue の更新で路・本文が変わった時
