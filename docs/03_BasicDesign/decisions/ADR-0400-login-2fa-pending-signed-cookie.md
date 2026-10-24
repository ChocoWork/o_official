# ADR-0400 ログインの2段目の保留は署名した短命の Cookie に持ち、/login/verify はサーバーで門にする

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/app/api/auth/login/route.ts`、`src/app/login/page.tsx`、`src/app/login/verify/page.tsx`、`src/features/auth/services/login-2fa-session.ts`（範囲外の共有部品） | 基準コミット: `4facf63b`

## 概要

パスワードが通ったことを、画面の状態ではなく、サーバーが署名した短命の HttpOnly の Cookie（`sb-login-2fa-session`）で表す。メールの確認コードを入れる画面 `/login/verify` はサーバーでこの Cookie を確かめ、無効なら `/login` へ戻す。Cookie の寿命は Supabase のメールのコードの有効期限と同じ 300 秒で、最初の発行から 30 分の絶対の上限を持つ。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | FREQ-334-REQ-01、FREQ-334-REQ-03、FREQ-335-REQ-04、FREQ-336-REQ-01、SEC-AUTH-003、SEC-AUTH-004 |
| 対象のコード | `src/app/api/auth/login/route.ts`、`src/app/login/page.tsx`、`src/app/login/verify/page.tsx`、`src/features/auth/services/login-2fa-session.ts`（範囲外の共有部品）、`src/lib/cookie.ts`（範囲外の共有部品） |
| 関連文書 | `docs/superpowers/specs/2026-09-04-login-otp-dedicated-screen-design.md`（概要・1.2・5.4・7.1）、`docs/02_Requirements/requirements.md` の FREQ-334〜336 の行 |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0400 ログインの2段目の保留は署名した短命の Cookie に持ち、/login/verify はサーバーで門にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-334-REQ-01、FREQ-334-REQ-03、FREQ-335-REQ-04、FREQ-336-REQ-01、SEC-AUTH-003、SEC-AUTH-004 |
| 根拠 | 確認コードの段を画面の状態だけに持つと、再読み込み・戻る・タブの切り替えで入力が消え、生きた保留のまま2通目のコードを送ってアカウントの回数を使うため（spec の「解決する欠陥」1〜3）。パスワードを飛ばしたコードだけのログインも、署名した保留が無ければ断れる（SEC-AUTH-003） |
| 状態 | 現行 |
| 出どころ | `docs/superpowers/specs/2026-09-04-login-otp-dedicated-screen-design.md`、`docs/02_Requirements/requirements.md` の FREQ-334〜336 の行 |

#### 背景

- ログインはパスワードとメールの確認コードの2段（FREQ-58）。サーバーは前から2段に分かれ、`/api/auth/login` はパスワードを確かめてコードを送るだけで、ログインのセッションは出さない（`login/route.ts`）
- 2026-09-04 より前は、コードの段が `/login` のタブの中の画面の状態だった。再読み込みで資格情報の画面に戻り、もう一度押すと2通目のコードが飛んで、アカウント単位の枠（5回／600秒）を1回使った（spec の欠陥 1）
- 当時の Cookie は 10 分で、コードの 5 分より長く、コードが切れても入力の画面が生きている窓があった（spec 5.4）

#### 決定

- パスワードが通ったら、用途の印・利用者の ID・宛先・最初の発行時刻・期限を HMAC-SHA256 で署名した値を Cookie に置く（`login/route.ts`、`login-2fa-session.ts`）。Cookie は HttpOnly・SameSite=Strict（`src/lib/cookie.ts`）
- 寿命は 300 秒で、Supabase のメールのコードの有効期限に合わせる（`login-2fa-session.ts`）。再送で延びても、最初の発行から 30 分を過ぎたら無効にする（`login-2fa-session.ts`）
- `/login/verify` はサーバーの頁で Cookie を確かめ、無い・改ざん・期限切れを同じく `/login` へ戻す。判定の前に入力の画面の HTML を送らない（`verify/page.tsx`）
- 逆に、有効な Cookie を持って `/login` に来たら `/login/verify` へ送る（`login/page.tsx`）
- パスワードの確認は匿名の client で行い、ログインの Cookie を作らない。コードは未登録の利用者を作らない設定で送る（`login/route.ts`）
- 保留の署名は時間のぶれの無い比べ方で確かめる（`login-2fa-session.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| コードの段を画面の状態のまま持つ（前の形） | 再読み込み・戻る・タブで入力が消え、2通目のコードでアカウントの枠を使う（spec の欠陥 1〜3） |
| 画面の側で Cookie の有無を見て移す | 移る前の一瞬、入力の画面が見える（`verify/page.tsx`） |
| 保留を DB の行に持つ | 既にある署名した Cookie で足り、新しいサーバーの状態は要らない（spec 1.2） |
| Cookie を 10 分のまま残す | コードが切れているのに入力の画面が生きる窓ができる（spec 5.4、FREQ-335-REQ-04） |

#### 結果

- 良くなること: 再読み込みしても入力の画面が残る。URL で今どちらの段にいるか分かる。パスワードを通らずにコードだけで入る道が無い
- 悪くなること: Cookie の 300 秒は Supabase の設定と手で合わせる。設定を変えたら定数も変える（spec 5.4）。手元の Supabase は有効期限が 3600 秒（`supabase/config.toml`）で、本番の前提を手元で確かめられない
- 悪くなること: 署名の鍵は専用の環境変数が無ければ `JWT_SECRET` を使う（`login-2fa-session.ts`）。用途の印で取り違えは防ぐが、SEC-AUTH-027 の「用途ごとに別の鍵」とは合わない
- 悪くなること: E2E は本物の署名の Cookie を作って置くので、その道具が本番の鍵で動かないようにする（spec 7.1、FREQ-336-REQ-05）
- 範囲の外: Google のログインはこの門を通らない（spec 9、SEC-AUTH-008）
- 見直す条件: Supabase のコードの有効期限を変える時、保留の鍵を分ける時、Google の経路にも2段目を課す時

## 未確認事項

- 本番の Supabase のメールのコードの有効期限が 300 秒か（memory の前提。ダッシュボードは見ていない）
- 本番で `LOGIN_2FA_SESSION_SECRET` を別に置くか
