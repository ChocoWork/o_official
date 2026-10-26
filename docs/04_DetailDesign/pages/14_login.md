# 1.14 ログインと認証（AUTH）詳細設計

> 状態: 推定 | 確認日: 2026-10-26 | 対象: ログイン `/login`・`/login/verify`、認証の画面 `/auth/*`、認証の窓口 `/api/auth/*`、サイト共通のヘッダーとドロワー、認証の部品 | 基準コミット: `4facf63b`（作業ツリーに別の作業の未コミットの差分あり）

## 概要

AUTH の領域のコードの単位を、詳細設計の項目（`DD-AUTH-001`〜`036`）で書く。`DD-AUTH-032`〜`036` はログインの戻り先（2026-10-25、波 1-A）の設計で、コードは同日に書いた。
中身は 2026-10-24 の作業ツリーのコードを読んで起こした今の動きで、ユーザーの確認を受けていないので全部「推定」にした。要件・構造設計とコードが食い違う所は決めずに今のコードの動きを書き、食い違いは `docs/05_Quality/reports/trace-matrix.md` の「食い違い」節に載せる。

| 範囲 | ID | 単位 |
| --- | --- | --- |
| 画面 | `DD-AUTH-001`〜`006` | `/login`、`/login/verify`、`/auth/password-reset`、`/auth/password-reset/verify`、`/auth/verified`、廃止した `/auth/callback` |
| 部品 | `DD-AUTH-007`〜`013` | ヘッダーとドロワー、ログインと会員登録のフォーム、タブ、結果の画面、Turnstile のフック、再送の残り時間の文 |
| ログインの窓口 | `DD-AUTH-014`〜`017` | `login`・`otp/verify`・`login/resend`・`login/cancel` |
| 会員登録の窓口 | `DD-AUTH-018`・`019` | `register`・`confirm` |
| Google の窓口 | `DD-AUTH-020`・`021` | `oauth/start`・`oauth/callback` |
| 再設定の窓口 | `DD-AUTH-022`〜`025` | `password-reset/request`・`link`・`session`・`confirm` |
| セッションの窓口 | `DD-AUTH-026`〜`028` | `me`・`refresh`・`logout` |
| TOTP の窓口 | `DD-AUTH-029`〜`031` | `mfa/status`・`mfa/enroll-totp`・`mfa/verify` |
| 戻り先の部品と窓口 | `DD-AUTH-032`〜`036` | 戻り先の確かめ、控えの保存、控えの開始と解決、`post-login`、入口のリンクの URL（ARC-AUTH-010） |

- 結論: 範囲の 33 の単位を 31 の項目へつないだ（`/login/verify` と `/auth/password-reset/verify` は頁と端末の部品の2単位を1項目にした）。各項目に入出力・正常と異常の流れ（分岐ごとに条件と動き）・状態と永続化・認証認可・単体テストの観点を書いた
- 単体テストは 5 本（`LoginModal`・`AuthResultScreen`・`VerifyOtpClient`・`verified-page`・`logout-guest-shopping`）しか無く、窓口の分岐は結合テスト（`tests/integration/api/auth/**`）だけが通す。分岐の網羅 100% にするには、テスト観点の表の「今のテスト」が無い行を単体テストで足す必要がある
- 前の版のこの頁は、古い作業の表（`IMPL-LOGIN-`・`IMPL-OAUTH-`・`IMPL-AUTH-` の番号）と、今のコードと違う計画の記述（`identify` の窓口、`oauth_requests` の表、リンクを開いた時の印の消費など）だった。範囲の単位に当たる番号は各項目の「旧番号」に移し、当たらない番号は「引き継がなかった古い番号」の表に理由を書いた。前の版の本文は基準コミットの git の履歴で読める

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 上位の文書 | [AUTH の構造設計](../../03_BasicDesign/areas/auth.md)（`ARC-`・`SCR-`・`FLOW-`・`STATE-`・`API-`・`DATA-AUTH-`）、[AUTH の要件](../../02_Requirements/areas/auth.md)（`SEC-AUTH-`） |
| 関連文書 | [AUTH の脅威](../../05_Quality/security/threats/auth.md)、`docs/03_BasicDesign/decisions/ADR-0400`〜`ADR-0412`、シーケンス [ログイン・追加認証](../sequence/auth-login-mfa.md)・[Google OAuth](../sequence/auth-oauth.md)・[パスワード再設定](../sequence/auth-password-reset.md)・[会員登録・確認](../sequence/auth-registration.md)・[セッション・API認可](../sequence/auth-session.md) |
| 対象のコード | 「実装の単位」の表の 33 単位 |
| 調べた時点 | 2026-10-24 の作業ツリー。コードは読んだだけで、動かしての確かめはしていない |
| 上位の決め方 | 項目の上位は、その単位が受け持つ構造設計と、その単位のコードが満たす `SEC-AUTH-` だけにした。満たさない `SEC-AUTH-` は上位にせず、本文の「認証認可」に「満たさない」と書いた（構造設計と同じ決め方）。要件・ADR・範囲外の ID は上位に書けないので、本文の「対応要件 ID」の括弧と根拠に書いた |

範囲外の共有部品は ID を持たないので、上位に書かず本文にファイルの道で書く（一覧は [AUTH の構造設計](../../03_BasicDesign/areas/auth.md) の「範囲と根拠」の表）。単体テストではこれらを差し替える。AUTH の作業でこれらの動きを変えない。

| 共有部品 | 道 | 詳細設計での扱い |
| --- | --- | --- |
| ログインの状態の文脈 | `src/contexts/LoginContext.tsx` | 画面から `login`・`register`・`verifyOtp`・`loginWithGoogle`・`refreshAuthState` を呼ぶ |
| 署名した保留・再設定の印 | `src/features/auth/services/login-2fa-session.ts`・`password-reset-session.ts` | 印の作り方・寿命・確かめ方は共有部品。項目は「有効か無効か」で分ける |
| セッションの保存 | `src/features/auth/services/register.ts` の `persistSessionAndCookies`、`session.ts` の `persistNewSession`・`findSessionByRefreshHash` | 結果の `ok` と例外で分ける |
| 回数の制限 | `src/features/auth/middleware/rateLimit.ts` の `enforceRateLimit` | 返り値の有無と例外で分ける |
| 認証の確かめ | `src/lib/auth/authenticate.ts` の `authenticateRequest`・`authFailureResponse`・`verifyAccessToken` | `ok` と理由で分ける |
| Cookie の名前と属性 | `src/lib/cookie.ts` | 名前と寿命を借りる |
| 住所・メール・照合・Turnstile・監査 | `src/lib/redirect.ts`・`site-url-guard.ts`・`mail.ts`・`pwned-password.ts`・`turnstile.ts`・`audit.ts`、`src/lib/ops/site-url-alert.ts` | 返り値で分ける。ログインの後の送り先の確かめは `src/features/auth/return-intent/return-path.ts`（DD-AUTH-032）に置き換え、共有関数 `sanitizeRedirectPath` は消す |
| ゲストの印・注文の紐付け | `src/features/cart/services/guest-shopping-token.ts`（H）、`src/lib/orders/link-guest-orders.ts`（注文まわりの作り直しが書き換え中） | 呼ぶだけ |

## 実装の単位

`scripts/trace/parse-code.ts` の `parseCodeUnits` で数えた範囲内の単位と、つなぐ詳細設計。1つの単位は1つの `DD-` にだけつなぐ。`@impl`・`@design` のコメントはこの表から付ける。

| ファイル | 単位（symbol） | DD |
| --- | --- | --- |
| `src/app/login/page.tsx` | `<file>` | DD-AUTH-001 |
| `src/app/login/verify/page.tsx` | `<file>` | DD-AUTH-002 |
| `src/app/login/verify/VerifyOtpClient.tsx` | `<file>` | DD-AUTH-002 |
| `src/app/auth/password-reset/page.tsx` | `<file>` | DD-AUTH-003 |
| `src/app/auth/password-reset/verify/page.tsx` | `<file>` | DD-AUTH-004 |
| `src/app/auth/password-reset/verify/VerifyClient.tsx` | `<file>` | DD-AUTH-004 |
| `src/app/auth/verified/page.tsx` | `<file>` | DD-AUTH-005 |
| `src/components/Header.tsx` | `<file>` | DD-AUTH-007 |
| `src/components/LoginModal.tsx` | `<file>` | DD-AUTH-008 |
| `src/components/RegisterModal.tsx` | `<file>` | DD-AUTH-009 |
| `src/components/AuthTabs.tsx` | `<file>` | DD-AUTH-010 |
| `src/components/AuthResultScreen.tsx` | `<file>` | DD-AUTH-011 |
| `src/hooks/useTurnstileWidget.ts` | `useTurnstileWidget` | DD-AUTH-012 |
| `src/lib/format-countdown.ts` | `formatResendCountdown` | DD-AUTH-013 |
| `src/app/api/auth/login/route.ts` | `<file>` | DD-AUTH-014 |
| `src/app/api/auth/otp/verify/route.ts` | `<file>` | DD-AUTH-015 |
| `src/app/api/auth/login/resend/route.ts` | `<file>` | DD-AUTH-016 |
| `src/app/api/auth/login/cancel/route.ts` | `<file>` | DD-AUTH-017 |
| `src/app/api/auth/register/route.ts` | `<file>` | DD-AUTH-018 |
| `src/app/api/auth/confirm/route.ts` | `<file>` | DD-AUTH-019 |
| `src/app/api/auth/oauth/start/route.ts` | `<file>` | DD-AUTH-020 |
| `src/app/api/auth/oauth/callback/route.ts` | `<file>` | DD-AUTH-021 |
| `src/app/api/auth/password-reset/request/route.ts` | `<file>` | DD-AUTH-022 |
| `src/app/api/auth/password-reset/link/route.ts` | `<file>` | DD-AUTH-023 |
| `src/app/api/auth/password-reset/session/route.ts` | `<file>` | DD-AUTH-024 |
| `src/app/api/auth/password-reset/confirm/route.ts` | `<file>` | DD-AUTH-025 |
| `src/app/api/auth/me/route.ts` | `<file>` | DD-AUTH-026 |
| `src/app/api/auth/refresh/route.ts` | `<file>` | DD-AUTH-027 |
| `src/app/api/auth/logout/route.ts` | `<file>` | DD-AUTH-028 |
| `src/app/api/auth/mfa/status/route.ts` | `<file>` | DD-AUTH-029 |
| `src/app/api/auth/mfa/enroll-totp/route.ts` | `<file>` | DD-AUTH-030 |
| `src/app/api/auth/mfa/verify/route.ts` | `<file>` | DD-AUTH-031 |
| `src/app/api/auth/post-login/route.ts` | `<file>` | DD-AUTH-035 |

- 戻り先の部品（`src/features/auth/return-intent/` の `return-path.ts`・`return-intent-store.ts`・`return-intent-service.ts`・`use-login-href.ts`）は、DD-AUTH-032・033・034・036 につなぐ。単位（symbol）はコードを書く時に確定する（コードはまだ無いので、この表には書かない）
- `src/app/` の `page`・`route` と `.tsx` はファイル全体で1つの単位なので、中の metadata の関数・Route Handler の関数・小さな関数・定数はその単位に含める。`.ts` の `useTurnstileWidget` と `formatResendCountdown` だけが関数の単位
- 新しい `@impl` は `IMPL-AUTH-101` から振る（前の版の `IMPL-AUTH-SEC-009` などと字の上で混ざらないようにするため）。33 の単位すべてに `@impl`（`IMPL-AUTH-101`〜`205`）と `@design` を付けた
- コメントを足す時の注意: `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts` が `LoginModal.tsx`・`RegisterModal.tsx` を字として読み、`e2e/FR-UI-003-lk-text-scale.spec.ts` が `src` の全部をコメントごと字として読む。TSDoc に字の大きさの指定の形（クラスの名前や数の px の指定）を書かない。`src/lib/format-countdown.ts` には既に JSDoc があり、`@impl`・`@design` を足す形になる

## 画面と部品の詳細設計

画面（`src/app/login/**`・`src/app/auth/**`）と部品（`src/components/*`・`src/hooks/*`・`src/lib/format-countdown.ts`）の項目。`.tsx` はファイル全体が1つの単位なので、中の関数・定数はその単位の項目に含める。画面の単体テストでは、共有の `LoginContext`・`next/navigation`・`fetch`・Turnstile を差し替える。

### DD-AUTH-001 /login の頁（保留の確かめ・タブの初めの値・metadata）

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-001、FLOW-AUTH-001、FLOW-AUTH-003、STATE-AUTH-001、SEC-AUTH-007 |
| 根拠 | 認証コードの入力の途中で戻ってきた人に資格情報のフォームを見せると、もう一度ログインを押して2通目のコードを送り、アカウント単位の枠（5回／600秒）を無駄に使う。保留の Cookie が有効なら描く前に `/login/verify` へ送る（SCR-AUTH-001、FLOW-AUTH-001、STATE-AUTH-001、`src/app/login/page.tsx`）。注文の完了からの案内（`?tab=register&email=`）を受けて会員登録のタブから始める（FREQ-266（範囲外））。題・説明・OG の画像をサーバーで返す（FR-LOGIN-005）。確認のメールのリンクを登録を始めたブラウザ以外で開いた人は `/login?registered=1` へ送られるので、固定の案内の文を渡して登録が終わったことを知らせる（SEC-AUTH-007、ADR-0413） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/login/page.tsx`） |
| 旧番号 | IMPL-LOGIN-001、IMPL-LOGIN-004 |
| 旧所在 | `docs/04_DetailDesign/pages/14_login.md`（基準コミットの版）の「機能要件対応表」の FR-LOGIN-001・FR-LOGIN-005 の行（「`LoginModal` の呼び出しのみ」は今の作りと違う） |

**対応要件 ID:** SCR-AUTH-001、FLOW-AUTH-001・003、STATE-AUTH-001、SEC-AUTH-007（その上は FR-LOGIN-005、FREQ-63-REQ-01、FREQ-334-REQ-03、ADR-0410、ADR-0413、FREQ-266-REQ-01（範囲外））

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `GET /login`。Cookie `sb-login-2fa-session`、問い合わせの `tab`・`email`・`next`（ログインの後の戻り先）・`registered` |
| 出力（頁） | 部品 `AuthTabs`（DD-AUTH-010）に初めのタブ（`register` か `login`）と初めのメール（文字列か空）、戻り先の確かめ（DD-AUTH-032）を通った道筋だけを `returnTo` として渡す。外れた値は画面に出さず捨てる。`registered` が文字列の `1` の時だけ、固定の案内の文「会員登録が完了しました。ログインしてください。」（案。ユーザーに画面を見せて確かめる）を `notice` として渡す。値そのものは画面に出さない |
| 出力（転送） | 保留が有効なら `/login/verify` へのサーバーの転送 |
| 出力（metadata） | title「LOGIN \| Le Fil des Heures」、description は固定の文、og:title・og:description は同じ字、og:image は `/mainphoto.png`（`src/app/login/page.tsx`） |

**正常フロー:**

1. metadata の関数は分岐を持たず、固定の値を返す（`src/app/login/page.tsx`）
2. 頁の関数は Cookie を読み、共有の `verifyLoginTwoFactorSessionToken` で保留を確かめる
3. 保留が無効なら問い合わせを待って読み、タブとメールの初めの値を決める
4. `AuthTabs` を描く

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 保留の印が有効 | `/login/verify` へ転送。問い合わせを読まない（`src/app/login/page.tsx`） |
| 保留の印が無い・偽り・期限切れ | 頁を描く |
| 問い合わせが無い | タブは `login`、メールは空 |
| `tab` が `register` | 会員登録のタブから |
| `tab` がほか・配列 | ログインのタブから |
| `email` が文字列 | その値 |
| `email` が配列・無い | 空 |
| `next` が確かめ（DD-AUTH-032）を通った | その道筋を `returnTo` に渡す |
| `next` が外れた・配列だった・無い | `returnTo` を渡さない |
| `registered` が `1` | 案内の文を `notice` に渡す |
| `registered` が `1` 以外（`0`・空・配列）・無い | `notice` を渡さない |

**状態・永続化:** 状態を持たず、書かない。保留の印の確かめは共有部品（署名・用途・期限・iat から 30 分、STATE-AUTH-001）。

**認証認可:** ログインを求めない。保留の Cookie は HttpOnly でサーバーだけが読む。`/register` の頁は無い（404。FREQ-63-AC-01）。

**テスト観点:**（単体テストは無い。E2E `e2e/FR-LOGIN-005`・`027` が一部を見る）

| # | 観点 |
| --- | --- |
| 1 | 保留が有効なら `/login/verify` へ転送し、`AuthTabs` を描かない |
| 2 | 保留が無効で `?tab=register&email=a@example.com` なら会員登録のタブとメール |
| 3 | 問い合わせが無ければログインのタブと空 |
| 4 | `email` が配列なら空、`tab` がほかの値ならログイン |
| 5 | metadata の関数が title・description・OG を返す |
| 6 | `registered=1` で案内の文を `notice` として渡す。`0`・空・配列・未指定では渡さない。メールなどほかの値を案内に混ぜない |

### DD-AUTH-002 /login/verify の頁と認証コードの入力の部品

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-004、FLOW-AUTH-001、STATE-AUTH-001 |
| 根拠 | 保留の判定をサーバーに置き、判定の前に入力の画面の HTML を送らない。保留が無い・偽り・期限切れを全部同じに `/login` へ送り、アカウントの有無を示さない（SCR-AUTH-004、`src/app/login/verify/page.tsx`）。入力の状態を Cookie だけに寄せ、再読み込みで資格情報のフォームへ戻って2通目のコードを送る道を閉じる（STATE-AUTH-001、`VerifyOtpClient.tsx`）。再送はパスワードも宛先も送らず、やり直しはサーバーに保留を捨てさせる（FREQ-334-REQ-05・06）。確定の後は役割で行き先を分ける（FLOW-AUTH-001） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/login/verify/page.tsx`、`src/app/login/verify/VerifyOtpClient.tsx`）、`docs/superpowers/specs/2026-09-04-login-otp-dedicated-screen-design.md` |
| 旧番号 | IMPL-LOGIN-005、IMPL-AUTH-OTP-02 |
| 旧所在 | `docs/04_DetailDesign/pages/14_login.md`（基準コミットの版）の「機能要件対応表」の FR-LOGIN-006 の行（`LoginModal` の `otpSentTime` は今の作りと違う）、「Passwordless / OTP フロー」の AUTH-01-IDF-11〜13 の行 |

**対応要件 ID:** SCR-AUTH-004、FLOW-AUTH-001、STATE-AUTH-001（その上は FREQ-334-REQ-01・04〜06、FR-LOGIN-006・008、DRV-AUTH-006、ADR-0400）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力（頁） | `GET /login/verify`。Cookie `sb-login-2fa-session` |
| 出力（頁） | 保留が有効なら部品へ保留のメールを渡す。無効なら `/login` へ転送。metadata は `robots: noindex, nofollow`（`src/app/login/verify/page.tsx`） |
| 入力（部品） | 保留のメール、8つの欄の入力、ボタンの操作 |
| 出力（部品） | 共有の `LoginContext` の `verifyOtp`（`POST /api/auth/otp/verify`、DD-AUTH-015）、`GET /api/auth/me`（DD-AUTH-026）、`POST /api/auth/login/resend`（DD-AUTH-016）、`POST /api/auth/login/cancel`（DD-AUTH-017）、`router.replace` での移動 |

**正常フロー:**

1. 頁は Cookie の保留を確かめ、有効なら部品を描く（`src/app/login/verify/page.tsx`）
2. 部品は見出し「認証コードを入力」、伏せたメール（共有の `maskEmail`）、「コードは5分間有効です」、8つの欄、「サインイン」、再送の待ちの文、「別のアドレスでやり直す」を出す（`VerifyOtpClient.tsx`）
3. 再送の待ちは今から 60 秒で始め、1秒ごとに経過の時刻から残りを引き直す
4. 欄は数字だけを受け、打つと次の欄へ、複数の数字は順に入れる
5. 8桁が揃うと送れる。送ると `verifyOtp` を呼び、成功なら `/api/auth/me` で行き先を決めて置き換える
6. 待ちが明けると「再送信」を出し、押すと再送の窓口を呼ぶ。成功なら欄を空にし、待ちを 60 秒に戻し、成功の文を出し、1つ目の欄へ移る
7. 「別のアドレスでやり直す」は取り消しの窓口を呼び（失敗は無視）、`/login` へ置き換える

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 頁で保留が無い・無効 | `/login` へ転送（`src/app/login/verify/page.tsx`） |
| 伏せたメールが空 | 宛先の文を出さない（`VerifyOtpClient.tsx`） |
| 入力に数字が無い | その欄を空にし、移らない |
| 入力の数字が欄の残りより多い | 8つ目で止める |
| 次の欄 | 入れた数の先、最後の欄で止める |
| Backspace で欄に数字がある | その欄を空にする |
| Backspace で欄が空、先頭でない | 前の欄を空にして前へ移る |
| Backspace で欄が空、先頭 | 何もしない |
| 左の矢印で先頭でない／右の矢印で最後でない | 前／次の欄へ |
| そのほかのキー | 何もしない |
| 貼り付けに数字が無い | 何もしない |
| 貼り付けの数字が多い | 8つ目で止める |
| 欄の参照が無い | 移らない |
| 残りが 0 | 時計を止め、「再送信」を出す |
| 送った時に8桁でない | 「認証コードは8桁で入力してください」 |
| `verifyOtp` が失敗 | 窓口の文、無ければ「認証コードの確認に失敗しました」 |
| `verifyOtp` が投げる | 「認証コードの確認に失敗しました」 |
| me が 200 以外・本文が JSON でない・`authenticated` が真でない | `/login` |
| me で役割が admin・supporter | `/auth/verified` |
| me で役割がほか | `/account` |
| me の通信が投げる | `/account` |
| 再送が 401 | `/login` へ置き換える |
| 再送が 429 で `Retry-After` が数字 | その秒数を待ちにする |
| 再送が 429 で `Retry-After` が日付 | 今との差を待ちにする |
| 再送が 429 で `Retry-After` が無い・壊れ・過去 | 60 秒を待ちにする |
| 再送が 429 | 「送信回数の上限に達しました。…」 |
| 再送が 503 | 「一時的に認証処理を利用できません。…」 |
| 再送がほかの失敗 | 「認証コードの送信に失敗しました」 |
| 再送の通信が投げる | 同じ文 |
| 送信中 | ボタンを押せない、「処理中...」 |

**状態・永続化:** 部品は欄・送信中・誤り・成功・再送の時刻・残りを React の状態に持つ。保留そのものは Cookie だけ（サーバーの状態、STATE-AUTH-001）。60 秒の待ちは画面だけが持ち、窓口は数えない。

**認証認可:** 頁は保留の Cookie をサーバーで確かめる。部品は送る時に保留のメールもパスワードも本文に入れない。読み上げは共有の `LiveMessage` に誤りと状態を分けて入れる。

**テスト観点:**（単体 `tests/unit/components/VerifyOtpClient.test.tsx` が7件で再送と確定の一部を見る。頁の単体テストは無い）

| # | 観点 | 今の単体テスト |
| --- | --- | --- |
| 1 | 頁で保留が無効なら `/login`、有効なら部品にメール | 無い |
| 2 | 再送の成功で欄を空にし成功の文 | 在る |
| 3 | 再送の 401 で `/login` | 在る |
| 4 | 再送の 429 で `Retry-After` の秒・日付・無し・不正・負 | 在る |
| 5 | 再送の 503・ほかの失敗・通信の例外 | 在る |
| 6 | 確定の成功で役割ごとの行き先（admin・user・未ログイン・me の例外） | 一部 |
| 7 | 8桁でない送信、`verifyOtp` の失敗（文の有り・無し）・例外 | 無い |
| 8 | 欄の入力（数字なし・複数・最後で止まる）、Backspace の3つ、矢印の端、貼り付け | 無い |
| 9 | 残りが 0 で「再送信」が出る、伏せたメールが空 | 無い |
| 10 | やり直しで取り消しを呼び、失敗しても `/login` | 無い |

### DD-AUTH-003 /auth/password-reset の頁（申請・新しいパスワード・結果）

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-005、FLOW-AUTH-004、STATE-AUTH-004 |
| 根拠 | 1つの道で、メールを送る前（申請）・リンクから来た後（新しいパスワード）・終わった後（結果）を出し分ける。どれかは HttpOnly の再設定の Cookie で決まるので、画面は窓口に聞く（SCR-AUTH-005、STATE-AUTH-004）。無効・期限切れのリンクは理由を出して URL から外す（FREQ-319-REQ-04）。送った後はフォームを畳み、宛先を出さない（FREQ-329-REQ-01・02）。一致の確かめを長さの後に置き、短いパスワードを2回同じに打った人に「一致しません」の後でまた長さで弾く二度手間をさせない（FREQ-333、`src/app/auth/password-reset/page.tsx`）。Turnstile のトークンは送った時点で使われるので、成否によらず引き直す（FREQ-330、ADR-0411） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/auth/password-reset/page.tsx`） |
| 旧番号 | IMPL-LOGIN-003 |
| 旧所在 | `docs/04_DetailDesign/pages/14_login.md`（基準コミットの版）の「機能要件対応表」の FR-LOGIN-003 の行 |

**対応要件 ID:** SCR-AUTH-005、FLOW-AUTH-004、STATE-AUTH-004（その上は FR-LOGIN-003、FREQ-92-REQ-01、FREQ-319-REQ-04、FREQ-323-REQ-04、FREQ-328-REQ-02〜04、FREQ-329-REQ-01〜05、FREQ-331-REQ-01〜07、FREQ-333-REQ-01〜04、ADR-0411）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `GET /auth/password-reset`。問い合わせの `error`（`link_expired`・そのほか）。環境変数 `NEXT_PUBLIC_TURNSTILE_SITE_KEY`。欄の入力 |
| 呼ぶ窓口 | `GET /api/auth/password-reset/session`（DD-AUTH-024）、`POST /api/auth/password-reset/request`（DD-AUTH-022）、`POST /api/auth/password-reset/confirm`（DD-AUTH-025） |
| 出力 | 申請のフォーム（EMAIL・Turnstile・「再設定メールを送信」）、新しいパスワードのフォーム（2つの欄・表示切替・「パスワードを更新」）、送った結果（`AuthResultScreen`、DD-AUTH-011）、変えた結果（同じ部品） |

**正常フロー:**

1. 描いた時に `error` を読み、理由の文を出し、URL を道だけに置き換える（`src/app/auth/password-reset/page.tsx`）
2. 再設定の Cookie の状態を聞き、`ready` なら新しいパスワードの見せ方にして宛先を持つ。聞き終わるまでボタンは「確認中...」で押せない
3. 申請: 形（共有の `ResetRequestSchema`）と Turnstile を確かめて申請を送る。成功なら送った時刻を刻み、60 秒の待ちを始める
4. 送った結果: 封筒の図・題・「メール内のリンクから…」・迷惑メールと前のリンクの無効の注意・再送の操作・「別のアドレスで送信」・「ログインへ」を出す。結果の時は頁の見出しを描かない
5. 再送: 待ちが明けたら Turnstile と「再送信する」を出し、押すと同じ申請を送る
6. 新しいパスワード: 形（共有の `ResetSessionConfirmSchema`、16 文字）と一致を確かめ、新しいパスワードだけを送る。成功なら変えた結果を出し、入力を消す
7. 変えた結果: 南京錠の図・「パスワードを更新しました」・「ログインへ」のボタン
8. 送るたびに、成否によらず Turnstile を引き直す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| `error` が無い | 何もしない（`src/app/auth/password-reset/page.tsx`） |
| `error` が `link_expired` | 「リンクの有効期限が切れているか、すでに使用されています。…」 |
| `error` がほか | 「リンクが正しくありません。…」 |
| 状態の窓口が 200 以外 | 申請の見せ方のまま |
| 本文が JSON でない、または頁が閉じた後 | 何もしない |
| `ready` が真 | 新しいパスワードの見せ方、宛先は文字列なら入れ、ほかは空 |
| `ready` が偽 | 申請の見せ方 |
| 通信が投げる | 頁が開いていれば申請の見せ方 |
| 聞き終わり | 頁が開いていれば「確認中」を外す |
| 待ちの時刻が無い | 時計を回さない |
| 待ちの残りが 0 | 上限の印を外し、時計を止める |
| 申請の応答が成功 | `ok: true` |
| 申請の応答が失敗 | 状態・`Retry-After`（正の数だけ、ほかは `null`）・本文の `error`（文字列だけ）を返す |
| 申請の形の誤り（zod の誤り・ほか） | 誤りの文を改行でつなぐ・「入力に誤りがあります」 |
| 鍵があり Turnstile が済んでいない | 「ボット検証を完了してください」 |
| 申請が 429 | 「送信回数の上限に達しました。…」 |
| 申請がほかの失敗 | 窓口の文、無ければ「送信に失敗しました」 |
| 申請の通信が投げる | 「送信に失敗しました」 |
| 再送が 429 | 上限の印を立て、`Retry-After`、無ければ 3600 秒を待ちにする |
| 再送がほかの失敗 | 窓口の文か「送信に失敗しました」 |
| 再送の通信が投げる | 「送信に失敗しました」 |
| 「別のアドレスで送信」 | 送った時刻・待ち・上限・誤り・Turnstile のトークンを消し、申請のフォームへ戻す |
| 新しいパスワードの形の誤り（zod・ほか） | 誤りの文・「入力に誤りがあります」 |
| 2つの欄が違う | 「パスワードが一致しません」 |
| 確定が失敗 | 窓口の文、無ければ「再設定に失敗しました」 |
| 確定の通信が投げる | 「再設定に失敗しました」 |
| 上限の印が立っている | 再送の操作を出さず、上限の文を出す |
| 待ちの残りがある | `formatResendCountdown` の文 |
| 鍵がある | Turnstile の Script と入れ物を描く。無ければ描かない |
| 結果を出す時 | 頁の見出しを描かない |
| 変えた後・送った後・どちらでもない | 変えた結果・送った結果・フォーム |
| 新しいパスワードの見せ方 | メールの欄を出さず、2つの欄を出す。送信は確定、ほかは申請 |
| 表示切替 | 欄の種類と読み上げの名前とアイコンを切り替える |
| ボタンを押せない時 | 送信中・確かめ中・（新しいパスワードなら2つのどちらかが空、申請ならメールが空） |
| ボタンの字 | 「確認中...」・「パスワードを更新」・「再設定メールを送信」 |
| 再送のボタンを押せない時 | 送信中、または鍵があり Turnstile が済んでいない。字は「送信中...」か「再送信する」 |

**状態・永続化:** 欄・誤り・見せ方・送った時刻・待ち・上限の印を React の状態に持つ。再設定の Cookie は HttpOnly で画面は読まず、窓口に聞く。宛先は新しいパスワードの見せ方の間だけ持ち、変えた後に消す。

**認証認可:** ログインを求めない。宛先を結果の画面に出さない。送る本文に確認の欄の値を入れない。

**テスト観点:**（単体テストは無い。E2E `e2e/FR-PWRESET-001`〜`006`・`008`、`FR-LOGIN-025`・`026` が見た目と流れを見る）

| # | 観点 |
| --- | --- |
| 1 | `?error=link_expired`・ほか・無しで文と URL の置き換え |
| 2 | 状態の窓口が `ready` 真（宛先が文字列・ほか）・偽・200 以外・JSON でない・投げる・閉じた後 |
| 3 | 申請の成功で送った結果・60 秒の待ち・見出しを描かない |
| 4 | 申請の形の誤り（zod・ほか）、Turnstile の未完了 |
| 5 | 申請の 429・ほか（文の有り・無し）・通信の例外 |
| 6 | 待ちが明けて再送の操作が出る、再送の成功・429（`Retry-After` の有り・無し・不正）・ほか・例外 |
| 7 | 上限の印で再送の操作を出さず文を出す |
| 8 | 「別のアドレスで送信」でフォームへ戻る |
| 9 | 新しいパスワードの形の誤り・不一致・成功・失敗（文の有り・無し）・例外 |
| 10 | 鍵の有り・無しで Turnstile を描くか、ボタンの押せない条件と字の3つ |
| 11 | 表示切替の2つの欄の両側 |
| 12 | 申請・再送の後に、成否によらず Turnstile を引き直す |

### DD-AUTH-004 /auth/password-reset/verify の頁とリンクの確かめの部品

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-006、FLOW-AUTH-004、STATE-AUTH-002 |
| 根拠 | メールのリンクの先では何も消費しない。開いた時に消費すると、企業のメールのリンクの検査が受け取った時に踏んで先に潰し、再送しても同じに潰れて再設定できなくなる（SCR-AUTH-006、STATE-AUTH-002、ADR-0403）。確かめの POST に副作用が無いので確認のボタンを挟まず、開いたら1回だけ自動で送り、新しいパスワードの欄へ進める（FREQ-332-REQ-01・02）。印は1回しか通らない前提なので、再描画や二重の実行で2回送らない印を持つ。通信の誤りの時だけ再試行の手段を出す（FREQ-332-REQ-03） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/auth/password-reset/verify/page.tsx`、`src/app/auth/password-reset/verify/VerifyClient.tsx`） |

**対応要件 ID:** SCR-AUTH-006、FLOW-AUTH-004、STATE-AUTH-002（その上は FREQ-332-REQ-01〜03、FREQ-319-REQ-03、ADR-0403）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力（頁） | `GET /auth/password-reset/verify`。問い合わせの `token` |
| 出力（頁） | `token` があれば部品に渡す。無ければ `/auth/password-reset?error=link_invalid` へ転送。metadata は `robots: noindex, nofollow` |
| 出力（部品） | `POST /api/auth/password-reset/link`（DD-AUTH-023）を `{ token }` で1回。結果で `router.replace` |

**正常フロー:**

1. 頁は問い合わせを待って `token` を読み、部品を描く（`src/app/auth/password-reset/verify/page.tsx`）
2. 部品は見出し「パスワード再設定」と「確認中...」を出す（`VerifyClient.tsx`）
3. 描いた後に、送った印が立っていなければ立てて確かめを送る
4. 成功なら `/auth/password-reset` へ置き換える（窓口の `redirectTo` は読まない）

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 頁で `token` が無い・空 | `?error=link_invalid` へ転送（`src/app/auth/password-reset/verify/page.tsx`） |
| 送った印が立っている | 送らない（`VerifyClient.tsx`） |
| 窓口が断る（200 以外） | `/auth/password-reset?error=link_expired` へ置き換える |
| 通信が投げる | 送った印を下ろし、「リンクの確認に失敗しました。…」と「もう一度試す」「ログインへ」を出す |
| 「もう一度試す」 | 印を立てて送り直す |
| 誤りが無い | 「確認中...」 |

**状態・永続化:** 部品は誤りの文と送った印（ref）だけを持つ。再設定の Cookie は窓口が付け、画面は読まない。

**認証認可:** ログインを求めない。印は問い合わせから本文へ移して送り、頁の側では消費も確かめもしない。

**テスト観点:**（単体テストは無い。E2E `e2e/FR-PWRESET-007`・`002`）

| # | 観点 |
| --- | --- |
| 1 | 頁の `token` の有り・無し |
| 2 | 窓口の成功で `/auth/password-reset`、断りで `?error=link_expired` |
| 3 | 二度の描画でも1回しか送らない |
| 4 | 通信の例外で文とボタン、「もう一度試す」で送り直す |

### DD-AUTH-005 /auth/verified の頁（役割の振り分けと TOTP の登録・確認）

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-007、STATE-AUTH-003、FLOW-AUTH-001、FLOW-AUTH-003、ARC-AUTH-010、SEC-AUTH-008、SEC-AUTH-026、SEC-AUTH-028 |
| 根拠 | 一般の会員を管理者用の確認に通さず、管理者とサポーターには TOTP の確認を必ず通す（SCR-AUTH-007、FLOW-AUTH-001・003、DRV-AUTH-009）。Google でログインした管理者もここを通るので、aal2 になるまで管理画面へ送らない（SEC-AUTH-008 の管理の部分）。振り分けは `/api/auth/me` の役割で行い、画面の判定は表示だけ（SEC-AUTH-028）。見せ方の移り変わりは1回の me の答えで決める（STATE-AUTH-003）。確認が通ったら全体のログインの状態を同期し直してから移る。省くと `/admin` が古い `mfaVerified` を読み、「2要素認証が必要です」を誤って出す（`src/app/auth/verified/page.tsx`） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/auth/verified/page.tsx`）、`docs/04_DetailDesign/sequence/auth-login-mfa.md` の「追加認証画面の入口と出口」 |

**対応要件 ID:** SCR-AUTH-007、STATE-AUTH-003、FLOW-AUTH-001・003、ARC-AUTH-010、SEC-AUTH-008・026・028（その上は FR-AUTH-005、FR-LOGIN-007、FREQ-73-REQ-01、DRV-AUTH-009、FREQ-515-REQ-01（FREQ-515-AC-02）、FREQ-377（範囲外））

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `GET /auth/verified`。認証の Cookie（窓口が読む）、コードの欄、要素の選択 |
| 呼ぶ窓口 | `GET /api/auth/me`（DD-AUTH-026）、`GET /api/auth/mfa/status`（DD-AUTH-029）、`POST /api/auth/mfa/enroll-totp`（DD-AUTH-030、本文なし）、`POST /api/auth/mfa/verify`（DD-AUTH-031）、`POST /api/auth/post-login`（DD-AUTH-035、本文なし）、共有の `LoginContext` の `refreshAuthState` |
| 出力 | 題「Le Fil des Heures」と糸のヘアライン、見せ方ごとの本文（読み込み・一般・未ログイン・TOTP）、誤りの文（共有の `LiveMessage`）。移動は、`post-login` が返した行き先を戻り先の確かめ（DD-AUTH-032、端末側の二重の確かめ）に通した道筋への `router.replace`（一般の会員は 0.8 秒後） |

**正常フロー:**

1. 読み込みの見せ方で「サインインを確認しています…」を出す（`src/app/auth/verified/page.tsx`）
2. me を聞く。未ログインなら未ログインの見せ方
3. 役割を読む（許可の3つでなければ `user`）。admin・supporter で aal2 済みなら `post-login` を呼び、返った行き先（戻り先か `/admin`）へ
4. admin・supporter で aal2 でなければ TOTP の状態を聞き、要素の一覧と選んだ要素を決め、TOTP の見せ方へ移る
5. 一般の会員なら同じ status の中身を「確認完了。移動します…」に替え、0.8 秒後に `post-login` が返した行き先（戻り先か `/`）へ。トップ（`/`）へのリンクも出す
6. TOTP の見せ方で要素が無く、まだ試していなければ、自動で1回だけ登録する。登録できたら QR（data URI の素の画像）と秘密・URI の手入力の案内を出す
7. コードを6〜8桁の数字で入れ、確認を送る。通ったら `refreshAuthState` の後に `post-login` を呼び、返った行き先（戻り先か `/admin`）へ

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| me が 200 以外・本文が JSON でない・`authenticated` が真でない | 閉じていなければ未ログインの見せ方、`/login` へのリンク（`src/app/auth/verified/page.tsx`） |
| 役割が許可の3つに無い | `user` |
| admin・supporter で `mfaVerified` が真 | 閉じていなければ文を替えて `post-login` の行き先へ |
| `post-login` の通信が失敗・200 以外 | 移動の保険として、admin・supporter は `/admin`、一般は `/` |
| `post-login` が `needsMfa: true` を返す（me の `mfaVerified` と、窓口が読む claims の aal が食い違った） | 移らない。`mfaVerified` の枝なら TOTP の状態を聞いて TOTP の見せ方へ、確認の後の枝なら誤りの文を出す |
| 返った行き先が戻り先の確かめに通らない | 一般は `/`、admin・supporter は `/admin` |
| admin・supporter で `mfaVerified` が真でない | 閉じていなければ TOTP の状態を聞く |
| 一般の会員 | 閉じていなければ一般の見せ方と 0.8 秒の時計 |
| me の通信・TOTP の状態が投げる | 閉じていなければ TOTP の見せ方と「認証状態の確認に失敗しました。…」（未ログインでも TOTP の見せ方になる。推定） |
| 頁が閉じた | 時計を止める |
| TOTP の状態が 200 以外 | 投げる（上の行へ） |
| 要素の名前が無い・種類も無い | 種類・`MFA Factor` を名前にする |
| 要素の一覧が無い | 空 |
| 選んでいた要素が一覧にある | そのまま。無ければ一覧の先頭、空なら `null` |
| 確かめ済みの要素がある | 「2要素認証コードを入力してください。」 |
| 確かめ済みの要素が無い | 「管理画面利用のために2要素認証（TOTP）を登録してください。」 |
| 自動の登録の条件 | TOTP の見せ方で、まだ試しておらず、処理中でなく、QR も登録の id も要素も無い時だけ |
| 自動の登録 | 「…セットアップ中です…」を出す |
| 登録が 200 以外・本文にデータが無い | 409 なら「既に2要素認証は登録済みです。…」、ほかは「2要素認証の登録に失敗しました。」 |
| 登録の通信が投げる | 誤りの文（`Error` でなければ決まりの文） |
| コードが6〜8桁の数字でない | 「認証コードは6〜8桁の数字で入力してください。」 |
| 確かめる要素が無い（登録の id も選んだ要素も無い） | 「検証対象のMFA要素がありません。…」 |
| 確認が 200 以外・`verified` が真でない | 「2要素認証コードの検証に失敗しました。」 |
| 確認の通信・同期が投げる | 誤りの文（`Error` でなければ決まりの文） |
| QR がある | 画像を出す |
| 秘密か URI がある | 手入力の案内。秘密・URI はある物だけ |
| QR も登録の id も要素も無い | 「2要素認証（TOTP）を登録」のボタン（処理中は「登録中...」で押せない） |
| 要素が2つ以上で登録の id が無い | 要素を選ぶ欄（共有の `SingleSelect`）。空を選ぶと `null` |
| 登録の id か要素がある | コードの欄（数字だけ、8桁まで）と「2要素認証を完了」（処理中は「検証中...」で押せない） |

**状態・永続化:** 見せ方・文・誤り・処理中・コード・登録の id・要素の一覧・選んだ要素・QR・秘密・URI・自動の登録を試した印を React の状態に持つ。秘密は画面の状態だけに置き、保存しない。aal2 の Cookie は確認の窓口が書き戻す。

**認証認可:** 判定は全部窓口（me・mfa・post-login）。ログインの後の行き先は `post-login`（サーバー）が決め、画面の確かめは二重の保険（SEC-AUTH-026）。画面の振り分けは表示だけで、管理画面の認可は範囲外の共有の `admin-rbac`。QR は外の画像の読み込み口へ秘密を渡さないよう素の画像で出す。

**テスト観点:**（単体 `tests/unit/app/auth/verified-page.test.tsx` が1件で、2つ目の要素を選んで確かめる道を見る。E2E `e2e/FR-LOGIN-018`）

| # | 観点 | 今の単体テスト |
| --- | --- | --- |
| 1 | 未ログイン（200 以外・JSON でない・偽）で未ログインの見せ方とリンク | 無い |
| 2 | admin で aal2 済みなら `post-login` の行き先（`/admin` か戻り先） | 無い |
| 3 | 一般の会員で文の差し替えと 0.8 秒後に `post-login` の行き先（戻り先か `/`）、閉じたら時計を止める | 無い |
| 4 | 役割が無い・知らない値で一般 | 無い |
| 5 | admin で要素ありの状態、要素が2つで選ぶ欄、2つ目を選んで確認が通り同期と `post-login` を呼んでから移る | 在る（`/admin` への移動の期待は直す） |
| 6 | 要素なしで自動の登録が1回だけ走り、QR・秘密・URI を出す | 無い |
| 7 | 登録の 409・ほかの失敗・データ無し・例外 | 無い |
| 8 | TOTP の状態が 200 以外・me が投げる時の誤りの文 | 無い |
| 9 | 名前の無い要素の名前の決め方、選んでいた要素が一覧に無い時 | 無い |
| 10 | コードの形の誤り、要素が無い、確認の失敗・例外 | 無い |
| 11 | 登録のボタンの手動の押下と処理中の字 | 無い |
| 12 | 頁が閉じた後に me の答えが来ても見せ方を変えない | 無い |
| 13 | `post-login` の失敗の保険・`needsMfa`・確かめに外れた行き先 | 無い |

### DD-AUTH-006 廃止: /auth/callback の頁（古い Google の戻り）

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-008 |
| 根拠 | 廃止。Google のログインの戻りを画面で受けて窓口へ渡すために作った古い画面だった（SCR-AUTH-008）。今の Google の流れは戻り先を窓口 `/api/auth/oauth/callback` に直に向けるので使われず、`next` を `/` で始まるかだけで見る open redirect の穴があったため、2026-10-25 に画面ごと削除した（SEC-AUTH-026、ADR-0412）。番号は使い回さない |
| 状態 | 廃止 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定（削除前の `src/app/auth/callback/page.tsx`）、`docs/05_Quality/reviews/security/security_review_auth_callback.md`、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave1a-decisions.md` |

**対応要件 ID:** SCR-AUTH-008（その上は FR-LOGIN-002）

**経緯:** 2026-10-25 に頁（`src/app/auth/callback/page.tsx`）と、その単体・結合試験を削除した。`/auth/callback` を開くと 404 になる。確かめは SEC-AUTH-026-AC-01 の E2E（`e2e/FR-LOGIN-030-session-cookies-and-responses.spec.ts`）。Google の戻りは `/api/auth/oauth/callback`（DD-AUTH-021）が受ける。

### DD-AUTH-007 サイト共通のヘッダーとドロワー

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-009、SCR-AUTH-010、STATE-AUTH-005、ARC-AUTH-008、SEC-AUTH-028 |
| 根拠 | どのページからも主なページと買い物の入口へ1回で移れるようにし、小さい画面では一覧を開く前に分類を選んで直に移れるようにする（SCR-AUTH-009・010、DRV-AUTH-002・003）。長いページで固定のヘッダーが画面の上を占めないよう下へ動くと隠し、上へ動くとすぐ出す（STATE-AUTH-005、DRV-AUTH-001）。同じ状態を `html` の印に書き、ほかの領域の固定の部品がヘッダーの下に付いて動けるようにする（ARC-AUTH-008）。管理の入口は役割で出すが表示だけで、入れるかはサーバーが決める（SEC-AUTH-028、DRV-AUTH-004）。管理画面では管理の板との重なり順を合わせるため地の板を分ける（DRV-AUTH-005） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/components/Header.tsx`） |

**対応要件 ID:** SCR-AUTH-009・010、STATE-AUTH-005、ARC-AUTH-008、SEC-AUTH-028（その上は DRV-AUTH-001〜005、FR-AUTH-001〜004、SR-AUTH-004〜007、FREQ-28-REQ-01、FREQ-29-REQ-01、FREQ-194-REQ-01、FREQ-239-REQ-01、FREQ-309-REQ-01〜05、FREQ-38-REQ-01（範囲外）、FREQ-76（範囲外））

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | 今の道（`usePathname`）、ログインの入口の URL（`useLoginHref`、DD-AUTH-036）、共有の `LoginContext` の `isLoggedIn`・`userRole`、共有の `CartContext` の `cartCount`、窓のスクロールの位置、NEWS の分類（`src/lib/news-data.ts`）、LOOK のシーズン（`src/lib/look/public`）、見せる SNS（`src/lib/social.ts`） |
| 出力 | 固定のヘッダー（題・ナビ・役割の入口・検索・お気に入り・カート・アカウントかログイン・ドロワーのボタン）、ドロワー（分類のアコーディオン・ほかのページ・役割の入口・SNS）、`html` の `data-header-visible` の `true`・`false`、使われないログインのモーダル |

**正常フロー:**

1. 描いた直後に1回スクロールの位置を見て、以後スクロールのたびに前の位置と比べて出し隠しを決める（`src/components/Header.tsx`）
2. 出し隠しが変わるたびに `html` の印へ書く
3. 題「Le Fil des Heures」を `/` へのリンクにする
4. ナビに NEWS・ITEM・LOOK・STOCKIST・ABOUT・CONTACT・UI を並べ、今のページ（下の階層を含む）の項目に下線を出す
5. 役割で LOADING（admin だけ）と MANAGE（admin・supporter）を足す
6. 検索・お気に入り・カートのアイコン、ログインしていれば `/account`、いなければ `useLoginHref()`（DD-AUTH-036）の `/login?next=…` のアイコン、ドロワーのボタンを出す
7. ドロワーは閉じるボタンだけの上の行、NEWS・ITEM・LOOK の分類のアコーディオン（1つずつ開く）、ほかのページ、役割の入口、SNS を出す。リンクを押すと閉じる
8. 分類のリンクは各一覧の `category`・`season` の付いた URL で、ALL は付けない

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 位置が 0 以下 | 出す（`src/components/Header.tsx`） |
| 下へ動き、位置が 50px より下 | 隠す |
| 上へ動く | 出す |
| 動かない・50px 以下で下へ | そのまま |
| 隠している | 印は `false`、ほかは `true` |
| 道が `/admin` で始まる | 白い地の板を別に描き、ヘッダーの重なり順を下げて地を外す |
| 隠している | ヘッダーと地の板を上へずらす |
| 項目の道が `/` | 道が `/` の時だけ今のページ（ナビに `/` が無いので届かない） |
| 道が項目の道と同じか、その下 | 下線を出し、ドロワーでは今のページの印を付ける |
| 役割が admin | LOADING をナビとドロワーに出す |
| 役割が admin・supporter | MANAGE をナビとドロワーに出す |
| カートの点数が 1 以上 | 読み上げの名前に点数を入れ、共有の `StatusBadge` の count・2xs を右上に重ねる（99 を超えた時の 99+ は部品の側） |
| カートの点数が 0 | 「カート」だけ、バッジを出さない |
| ログインしている | `/account`、いなければ `useLoginHref()`（DD-AUTH-036）の URL（ホーム `/` や確かめに外れた頁では `/login`） |
| 道が `/news`・`/item`・`/look` で始まる | その節を初めから開く。ほかは全部閉じる |
| 分類の値が ALL | 一覧の道だけ |
| 分類の値がほか | 問い合わせに値を入れる |
| ログインのモーダル | 開く所が無く、いつも閉じている（`setLoginOpen(true)` を呼ぶ所が無い） |

**状態・永続化:** ドロワーの開閉・出し隠し・前の位置を React の状態と ref に持つ。`html` の印は全部のページの CSS が読む。書く物は無い。

**認証認可:** 表示だけ。役割は共有の `LoginContext` の値（`/api/auth/me` の答え、DD-AUTH-026）で、管理画面・`/loading` の認可はそれぞれの頁と共有の認証の部品が決める。`/ui` を一般の利用者のナビに出す（要件が無い。推定で見本のページ）。

**テスト観点:**（単体テストは無い。E2E `e2e/FR-HEADER-001`〜`008` がドロワーの見た目とカートのバッジを見る）

| # | 観点 |
| --- | --- |
| 1 | 位置 0・下へ 60px・上へ・下へ 30px で出し隠しと `html` の印 |
| 2 | 道が `/admin` で地の板と重なり順、ほかで地なし |
| 3 | 道が `/news/1` で NEWS に下線とドロワーの今のページの印、`/newsx` では付かない |
| 4 | admin・supporter・user・未ログインで LOADING・MANAGE の有無（ナビとドロワー） |
| 5 | カートの点数 0・3 で読み上げの名前とバッジ |
| 6 | ログインの有無でアカウントとログインのアイコン（ログインのアイコンの `href` は `useLoginHref()` の値） |
| 7 | 道が `/news`・`/item`・`/look`・ほかでドロワーの初めに開く節 |
| 8 | 分類のリンクの ALL とほか（URL の形） |
| 9 | ドロワーの開閉（ボタン・閉じるボタン・リンク・SNS の押下で閉じる） |
| 10 | `/` の分岐は届かない（`test-gaps.md` の「届かない分岐」に理由を書く） |

### DD-AUTH-008 ログインのフォームの部品

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-002、FLOW-AUTH-001、FLOW-AUTH-002、ARC-AUTH-005 |
| 根拠 | 1段目の入力をここに集め、パスワードの確かめが通ったら認証コードの専用の画面へ置き換えて移る。`push` だと戻るで資格情報のフォームへ戻り、生きた保留の Cookie のまま2通目のコードを送れる（SCR-AUTH-002、FLOW-AUTH-001、`src/components/LoginModal.tsx`）。Turnstile のトークンは送った時点で使われるので、成否によらず引き直す（ARC-AUTH-005、ADR-0411）。Google の入口は窓口から始める（FLOW-AUTH-002） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/components/LoginModal.tsx`） |
| 旧番号 | IMPL-AUTH-OTP-09 |
| 旧所在 | `docs/04_DetailDesign/pages/14_login.md`（基準コミットの版）の「Passwordless / OTP フロー」の AUTH-01-IDF-09 の行（単体テストの記録） |

**対応要件 ID:** SCR-AUTH-002、FLOW-AUTH-001・002、ARC-AUTH-005（その上は FR-LOGIN-001・002・003、FREQ-65〜68・89-REQ-01、FREQ-328-REQ-01、FREQ-330-REQ-01・02、FREQ-334-REQ-02、ADR-0411）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | 部品の `open`（真の時だけ描く）・`onClose`（任意）・`returnTo`（任意。ログインの後の戻り先）。欄の EMAIL・パスワード、Turnstile のトークン、環境変数 `NEXT_PUBLIC_TURNSTILE_SITE_KEY` |
| 出力 | 共有の `LoginContext` の `login`（`POST /api/auth/login`、`{ next: returnTo }` 付き、DD-AUTH-014）・`loginWithGoogle`（`POST /api/auth/oauth/start` を `fetch` で呼ぶ。本文 `{ provider, next: returnTo }`。返った `url` へ移る、DD-AUTH-020）。成功で `router.replace('/login/verify')` |

**正常フロー:**

1. 鍵があれば Turnstile の Script を読み、読めたら描く（`src/components/LoginModal.tsx`、描き方は DD-AUTH-012）
2. EMAIL とパスワード（表示切替つき）、「パスワードをお忘れの方はこちら」（`/auth/password-reset`）、「ログイン」、OR、「Googleでサインイン」を出す
3. 送ると形（共有の `LoginRequestSchema`）と Turnstile を確かめ、`login` を呼ぶ
4. 成功なら `onClose` があれば呼び、`/login/verify` へ置き換える
5. 終わったら Turnstile を引き直す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| `open` が偽 | 何も描かない（`src/components/LoginModal.tsx`） |
| 形の誤り（zod の誤り・ほか） | 誤りの文を空白でつなぐ・「入力に誤りがあります」 |
| 鍵があり Turnstile が済んでいない | 「ボット検証を完了してください」 |
| `login` が失敗 | 窓口の文、無ければ「ログインに失敗しました」 |
| `onClose` が無い | 呼ばずに移る |
| `login` が投げる | 「ログインに失敗しました」 |
| Turnstile のトークンが空 | 送る時は渡さない |
| 鍵が無い | Script と入れ物を描かない |
| 表示切替 | 欄の種類・読み上げの名前・押した印・アイコンを切り替える |
| 送信中・メールが空・パスワードが空 | ボタンを押せない。送信中は「処理中...」 |

**状態・永続化:** 欄・表示切替・送信中・誤り・Turnstile のトークンを React の状態に持つ。書かない。

**認証認可:** ログインを求めない。パスワードは窓口へ送るだけで保持しない。

**テスト観点:**（単体 `tests/unit/components/LoginModal.test.tsx` が2件。E2E `e2e/FR-LOGIN-*` の多く）

| # | 観点 | 今の単体テスト |
| --- | --- | --- |
| 1 | Google のボタンと再設定のリンクが出る | 在る |
| 2 | 成功で `onClose` を呼んで `/login/verify` へ置き換える | 在る |
| 3 | `open` が偽で何も描かない | 無い |
| 4 | 形の誤り（zod・ほか）、鍵があり Turnstile が無い | 無い |
| 5 | `login` の失敗（文の有り・無し）・例外、`onClose` 無しでの成功 | 無い |
| 6 | 鍵の有り・無し、表示切替、ボタンの押せない条件 | 無い |
| 7 | Google のボタンで `loginWithGoogle` に `returnTo` を渡す（無ければ `next` も無し） | 無い |
| 8 | 成否によらず Turnstile を引き直す | 無い |

### DD-AUTH-009 会員登録のフォームの部品

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-003、FLOW-AUTH-003、ARC-AUTH-005、ARC-AUTH-006 |
| 根拠 | 登録の3つの欄をログインのタブと同じ下線とアイコンにし、並びを フォーム→OR→Google にそろえる（SCR-AUTH-003、FREQ-91-REQ-01）。登録済みかどうかを画面で判らせないため、送った後は誰にでも同じ確認のメールの案内を出す（ARC-AUTH-006、FREQ-320-REQ-04）。送るとフォームごと入れ替わって押したボタンが消えるので、完了の文へフォーカスを移して読ませる（FREQ-377（範囲外））。Turnstile は送るたびに引き直す（ARC-AUTH-005、ADR-0411）。確認のメールのリンクからログインへ進む（FLOW-AUTH-003） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/components/RegisterModal.tsx`） |

**対応要件 ID:** SCR-AUTH-003、FLOW-AUTH-003、ARC-AUTH-005・006（その上は FREQ-91-REQ-01、FREQ-320-REQ-04、FREQ-330-REQ-01、ADR-0411、FREQ-266-REQ-01（範囲外））

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | 部品の `onSwitchToLogin`（任意）・`initialEmail`（任意）・`returnTo`（任意。ログインの後の戻り先）。欄の EMAIL・パスワード・パスワード（確認）、Turnstile のトークン |
| 出力 | 共有の `LoginContext` の `register`（`POST /api/auth/register`、DD-AUTH-018）（`{ next: returnTo }` 付き）・`loginWithGoogle`（`next` は `returnTo`、無ければ付けない）。送った後の案内の画面 |

**正常フロー:**

1. メールの欄の初めの値は `initialEmail`、無ければ空（`src/components/RegisterModal.tsx`）
2. 鍵があれば Turnstile を描く
3. 送ると 16 文字・一致・Turnstile を確かめ、`register` を呼ぶ
4. 成功なら窓口の文、無ければ「確認メールを送信しました。メールのリンクから登録を完了してください。」を案内に入れる
5. 案内の画面: 完了の文（描いた時にフォーカスを移す）・迷惑メールの案内・「ログインページへ」
6. 終わったら Turnstile を引き直す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| パスワードが 16 文字未満 | 「パスワードは16文字以上で入力してください」（`src/components/RegisterModal.tsx`） |
| 2つが違う | 「パスワードが一致しません」 |
| 鍵があり Turnstile が済んでいない | 「ボット検証を完了してください」 |
| `register` が失敗 | 窓口の文、無ければ「登録に失敗しました」 |
| `register` が投げる | 「登録に失敗しました」 |
| 案内の文がある | フォームでなく案内の画面 |
| `onSwitchToLogin` がある | 「ログインページへ」はボタンで、押すとログインのタブへ |
| `onSwitchToLogin` が無い | `/login` へのリンク（呼び手の `AuthTabs` は必ず渡すので使われない） |
| 完了の文の要素が無い | フォーカスを移さない |
| 鍵が無い | Turnstile を描かない |
| 表示切替（2つの欄） | 欄の種類・読み上げの名前・アイコンを切り替える |
| 送信中・どれかの欄が空 | ボタンを押せない。送信中は「処理中...」、ほかは「登録して確認メールを受け取る」 |
| Google のボタン | `loginWithGoogle` に `returnTo`（無ければ `next` なし） |

**状態・永続化:** 欄・表示切替・送信中・誤り・案内の文・Turnstile のトークンを React の状態に持つ。書かない。

**認証認可:** ログインを求めない。16 文字の決まりは欄の placeholder に出さず、送った時の誤りの文にしか出ない（FREQ-323-REQ-04 は満たさない。SCR-AUTH-003）。

**テスト観点:**（単体テストは無い。E2E `e2e/FR-LOGIN-017`・`021`・`024` など）

| # | 観点 |
| --- | --- |
| 1 | `initialEmail` の有り・無しで欄の初めの値 |
| 2 | 15 文字・不一致・Turnstile の未完了の文 |
| 3 | 成功（窓口の文の有り・無し）で案内の画面とフォーカス |
| 4 | 失敗（文の有り・無し）・例外 |
| 5 | `onSwitchToLogin` の有り・無しで「ログインページへ」の形 |
| 6 | 鍵の有り・無し、表示切替の2つ、ボタンの押せない条件と字 |
| 7 | Google のボタンで `loginWithGoogle` に `returnTo` を渡す（無ければ `next` も無し） |
| 8 | 成否によらず Turnstile を引き直す |

### DD-AUTH-010 ログインと会員登録のタブの部品

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-001、SEC-AUTH-007 |
| 根拠 | ログインと会員登録を別のページにすると導線が分かれるので、`/login` の1つの画面のタブで切り替え、`/register` は置かない（SCR-AUTH-001、ADR-0410）。切り替えても URL は `/login` のままにする（FREQ-63-REQ-01）。左右の矢印で隣のタブへ移れる tablist にする。確認のリンクを別のブラウザで開いた人への案内（`notice`）を、URL の query が `replaceState` で消えても、タブを替えても残す（SEC-AUTH-007） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/components/AuthTabs.tsx`） |

**対応要件 ID:** SCR-AUTH-001（その上は FREQ-63-REQ-01、FREQ-90-REQ-01、ADR-0410）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | 部品の `initialTab`（`login`・`register`）・`initialEmail`（任意）・`returnTo`（任意。サーバーが確かめた戻り先）・`notice`（任意。案内の文）。タブの押下・左右の矢印 |
| 出力 | `notice` があれば tablist の上に `role="status"` の 1 行（初回の描画の値を state に固定し、タブを替えても・props が変わっても消さない）。tablist の2つのタブ（「ログイン」「会員登録」）と tabpanel。中身は `LoginModal`（DD-AUTH-008、いつも開いた形）か `RegisterModal`（DD-AUTH-009）で、どちらにも `returnTo` を渡し、タブを替えても保つ。切り替えで `history.replaceState` で URL を `/login` に置き換える |

**正常フロー:**

1. 初めのタブを状態に入れる（`src/components/AuthTabs.tsx`）
2. 2つのタブを描き、選んだタブだけを Tab キーで止まる所にする
3. 選んだタブの中身を描く。会員登録には「ログインへ戻る」とメールの初めの値を渡す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 押したタブが今のタブ | 何もしない（`src/components/AuthTabs.tsx`） |
| タブの道がある（今は両方 `/login` で常に真） | URL を道に置き換える。`?tab=`・`?email=` は消える |
| 左右の矢印以外のキー | 何もしない |
| 左右の矢印 | もう1つのタブへ切り替え、そのタブにフォーカス |
| 選んだタブ | 黒い太い下線・黒い文字・Tab で止まる。ほかは細い下線・グレーの文字・Tab で止まらない |
| 今のタブがログイン | `LoginModal`、ほかは `RegisterModal` |
| `notice` がある | `role="status"` で出す。タブを会員登録に替えても残す |
| `notice` が無い | 何も出さない |
| タブの参照が無い | フォーカスを移さない |

**状態・永続化:** 今のタブを React の状態に持つ。URL の問い合わせを消すので、再読み込みすると初めの値は戻らない。

**認証認可:** 表示だけ。

**テスト観点:**（単体テストは無い。E2E `e2e/FR-LOGIN-009`・`020`）

| # | 観点 |
| --- | --- |
| 1 | 初めのタブが `login`・`register` で中身が変わる |
| 2 | 会員登録のタブを押すと URL が `/login` になり中身が変わる、同じタブの押下では変わらない |
| 3 | 左右の矢印で切り替わりフォーカスが移る、ほかのキーでは変わらない |
| 4 | 選んだタブの aria-selected と tabIndex |
| 5 | 会員登録の中の「ログインページへ」でログインのタブへ戻る |
| 6 | 道が無いタブの分岐は届かない（`test-gaps.md` に理由を書く） |
| 7 | `notice` を `role="status"` で出す。無ければ出さない。タブを替えても・props が変わっても残る（単体 `tests/unit/components/auth-tabs.test.tsx`） |

### DD-AUTH-011 認証の結果の画面の部品

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-005 |
| 根拠 | 再設定のメールを送った後と、パスワードを変えた後の画面を、図・題・詳細・注意書き・操作の階層で一目で読めるようにする（SCR-AUTH-005、FREQ-331-REQ-01〜07）。結果はフォームと入れ替わって出て押したボタンが消えるので、見出しへフォーカスを移して読ませる。中身ごと差し込む status は読まれないことがあり、フォーカスと重ねると二重に読まれるので使わない（FREQ-377（範囲外）、`src/components/AuthResultScreen.tsx`） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/components/AuthResultScreen.tsx`） |

**対応要件 ID:** SCR-AUTH-005（その上は FREQ-329-REQ-05、FREQ-331-REQ-01〜07、FREQ-377（範囲外））

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `AuthResultScreen` の `icon`・`title`・`detail`（任意）・`note`（任意）・`action`（任意）・`links`（任意） |
| 出力 | 図と完了のバッジ（`CompletionBadge`）、h1 の題、詳細、情報のアイコンつきの注意書きのパネル、主の操作、補助のリンク。図の部品 `MailSentIcon`（封筒）・`PasswordUpdatedIcon`（南京錠）も同じファイルが出す |

**正常フロー:**

1. 描いた時に h1 へフォーカスを移す（`src/components/AuthResultScreen.tsx`）
2. 図と題を縦に並べ、詳細・注意書き・操作・リンクをある物だけ間隔の決まりで並べる

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 見出しの要素が無い | フォーカスを移さない（`src/components/AuthResultScreen.tsx`） |
| `detail` がある | 詳細を出す |
| `note` がある | 注意書きのパネルを出す |
| `action` がある | 主の操作を出す |
| `links` がある | 補助のリンクを出す |

**状態・永続化:** 持たない。

**認証認可:** 表示だけ。

**テスト観点:**（単体 `tests/unit/components/AuthResultScreen.test.tsx` が1件）

| # | 観点 | 今の単体テスト |
| --- | --- | --- |
| 1 | 描くと見出しにフォーカスが移り、status を置かない | 在る |
| 2 | `detail`・`note`・`action`・`links` の有り・無しの両方 | 一部（全部ありの形だけの見込み。推定） |
| 3 | `MailSentIcon`・`PasswordUpdatedIcon` を描ける | 無い |

### DD-AUTH-012 Turnstile の描画のフック

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-AUTH-005、SCR-AUTH-002、SCR-AUTH-003、SCR-AUTH-005 |
| 根拠 | 自動の描画は Script を読んだ時にしか走らず、タブの切り替えで部品が付け直されると Turnstile が出ないので、明示の描画にする（ARC-AUTH-005、`src/hooks/useTurnstileWidget.ts`）。トークンは使い捨てなので、送るたびに引き直す手段を1か所に集める（FREQ-330-REQ-01・02、ADR-0411）。Turnstile は幅 300px を下回れないので、狭い入れ物では等倍で縮め、ボタンだけが横に張り出すのを防ぐ（FREQ-328-REQ-02・03）。ログイン・会員登録・再設定の3つのフォームが使う（SCR-AUTH-002・003・005） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/hooks/useTurnstileWidget.ts`） |

**対応要件 ID:** ARC-AUTH-005、SCR-AUTH-002・003・005（その上は FREQ-328-REQ-01〜03、FREQ-330-REQ-01・02、ADR-0411）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | 引数の `siteKey`（空なら何もしない）・`onToken`（トークンを受ける関数）。窓の `turnstile`（Cloudflare の Script が置く） |
| 出力 | `containerRef`（入れ物に付ける）・`renderWidget`（Script の読み終わりに渡す）・`resetWidget`（送った後に呼ぶ）。窓の `onTurnstileSuccess`（E2E がトークンを入れるための口） |

**正常フロー:**

1. 入れ物を ref と状態の両方に持つ。`renderWidget` は初めの描画の関数を Script が掴むので、同じ関数のまま要素の差し替えに追う（`src/hooks/useTurnstileWidget.ts`）
2. 最新の `onToken` を ref に写す
3. 鍵・入れ物・窓の `turnstile` があり、まだ描いていなければ `flexible` で描く
4. 鍵があれば窓の `onTurnstileSuccess` を置き、外す時に消す
5. 入れ物が変わったら描き直し、外す時に消す
6. 入れ物の幅が 300px 未満なら等倍で縮め、高さを合わせる。大きさと子の変化を見張る
7. 引き直しはトークンを空にし、描いていれば窓の `turnstile` で引き直す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 鍵が無い・入れ物が無い・描いた後・窓の `turnstile` が無い | 描かない（`src/hooks/useTurnstileWidget.ts`） |
| 鍵が無い | `onTurnstileSuccess` を置かない |
| 外す時に `onTurnstileSuccess` がある | 消す |
| 引き直しで描いていない | トークンを空にするだけ |
| 引き直しで窓の `turnstile` が無い | 何もしない |
| 外す時に描いている | 消して id を戻す（窓の `turnstile` が無ければ id だけ戻す） |
| 鍵が無い・入れ物が無い | 縮めない |
| 入れ物の子が無い | 測らない |
| 高さか幅が 0 | 測らない（iframe の読み込みの前に高さを 0 で固めない） |
| 見張る子が変わった | 前の子の見張りを外し、新しい子を見張る |
| 幅が 300px 以上 | 縮めない（変形を消す） |
| 幅が 300px 未満 | 幅の比で縮める |
| 高さが同じ | 書かない |

**状態・永続化:** 入れ物と描いた id を ref と状態に持つ。入れ物の見た目の指定（はみ出しを隠す・最小の幅 0・高さ）を直に書く。

**認証認可:** なし。トークンの確かめはサーバーの共有の `src/lib/turnstile.ts`。

**テスト観点:**（単体テストは無い。E2E `e2e/FR-LOGIN-025`・`026`、`FR-PWRESET-004`）

| # | 観点 |
| --- | --- |
| 1 | 鍵・入れ物・窓の `turnstile` があり描く。2回目は描かない |
| 2 | 描いた後の `onToken` に最新の関数が呼ばれる |
| 3 | 鍵の有り・無しで `onTurnstileSuccess` を置き、外す時に消す（既に無い時も） |
| 4 | 引き直しで描いた・描いていない・窓の `turnstile` が無い |
| 5 | 外す時に描いた id を消す・描いていない |
| 6 | 幅 200px で縮める、320px で縮めない、子が無い、高さ 0、子が差し替わる、高さが同じ |

### DD-AUTH-013 再送の残り時間の文

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-004、STATE-AUTH-004 |
| 根拠 | ログインの認証コードの再送と、再設定のメールの再送で同じ語彙を使い、待ちの作法を1つにそろえる（SCR-AUTH-004、STATE-AUTH-004、FR-LOGIN-006）。文を変えると E2E `e2e/FR-LOGIN-006` と `e2e/FR-PWRESET-005` の両方が落ちる（`src/lib/format-countdown.ts`） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/lib/format-countdown.ts`） |

**対応要件 ID:** SCR-AUTH-004、STATE-AUTH-004（その上は FR-LOGIN-006、FREQ-329-REQ-03）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | 残りの秒数（数） |
| 出力 | 「<分>分 <秒（2桁）>秒後に再送可能」の文 |

**正常フロー:**

1. 分は秒数を 60 で割った商の切り捨て、秒は余り（`src/lib/format-countdown.ts`）
2. 秒を2桁にそろえて文にする

**分岐と異常フロー:** 分岐は無い。負の数や小数でも計算はそのまま進む（呼び手は 0 以上の整数だけを渡す）。

**状態・永続化:** 持たない。

**認証認可:** なし。

**テスト観点:**（単体テストは無い）

| # | 観点 |
| --- | --- |
| 1 | 60 で「1分 00秒後に再送可能」、59 で「0分 59秒後に再送可能」、3600 で「60分 00秒後に再送可能」 |

## 窓口の詳細設計

窓口（`src/app/api/auth/**/route.ts`）の項目。全部の窓口は Route Handler で、状態を変える `POST` は共有の proxy の Origin の確かめ（`src/proxy.ts`）を先に通る。回数の制限の呼び出し（共有の `enforceRateLimit`）は、返り値があればそのまま返し、例外は記録だけして先へ進む（数え場所の失敗の 503 は共有部品が返す、ADR-0009（範囲外））。例外は2つ。OTP の確かめの宛先単位の制限は、返り値を返さず新しい 429 を作り直し、数え場所の障害の 503 も 429 に変えて保留の Cookie を消す（`src/app/api/auth/otp/verify/route.ts`、DD-AUTH-015）。確認のリンクは、返り値が `Response` でなければ新しい 429 を作る（`src/app/api/auth/confirm/route.ts`）。単体テストでは、共有部品（Supabase の client・回数の制限・監査・Cookie・署名の印・メール）を全部差し替えて、窓口の分岐だけを通す。

### DD-AUTH-014 ログインの1段目の窓口（パスワードを確かめて確認コードを送る）

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-001、ARC-AUTH-002、ARC-AUTH-005、ARC-AUTH-010、DATA-AUTH-004、SEC-AUTH-001、SEC-AUTH-030、SEC-AUTH-032 |
| 根拠 | パスワードの段を通ったことだけを署名した Cookie に残し、トークンは2段目まで配らない（API-AUTH-001、ARC-AUTH-002、ADR-0400）。総当たりを IP とメールの2段で止め、メールの枠は Turnstile の後に数えて、他人のメールを送るだけで枠を潰させない（SEC-AUTH-001、ARC-AUTH-005）。成否を監査に残す（SEC-AUTH-030）。確認コードを送れた後に、ログインの後の戻り先を入口で確かめて控える（ARC-AUTH-010、SEC-AUTH-032）。パスワードの誤りやボットで表の行を増やさない |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/login/route.ts`）、`docs/04_DetailDesign/sequence/auth-login-mfa.md` の SQ-AUTH-LOGIN-PASSWORD |
| 旧番号 | IMPL-AUTH-LOGIN-01、IMPL-AUTH-OTP-01 |
| 旧所在 | `docs/04_DetailDesign/pages/14_login.md`（基準コミットの版）の「実装フェーズ 完了状況」の AUTH-01-06 の行、「Passwordless / OTP フロー」の AUTH-01-IDF-01〜08 の行 |

**対応要件 ID:** API-AUTH-001、ARC-AUTH-002・005・010、DATA-AUTH-004、SEC-AUTH-001・030・032（その上は FR-AUTH-005、FR-LOGIN-001、FREQ-58-REQ-01、ADR-0400、FREQ-360-REQ-02（範囲外））

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `POST /api/auth/login`。JSON の `email`・`password`・`turnstileToken`・`next`（任意。型は縛らず、戻り先の確かめが断る）（形は共有の `LoginRequestSchema`）。見出しの `x-forwarded-for` の先頭を Turnstile の IP に使う |
| 出力 200 | `{ step: 'otp', message }` と保留の Cookie `sb-login-2fa-session`（共有の `cookieOptionsForLoginTwoFactor`、5分）、戻り先の Cookie `sb-return-intent`（15 分。`next` が無い・外れた時・控えの作成の失敗は消す側） |
| 出力の失敗 | 400（形の誤りを `formatZodError` で）、401（「メールアドレスまたはパスワードが正しくありません。」）、403（`Bot detection failed`）、429（回数の制限の応答）、500（確認コードの送信の失敗・例外） |

**正常フロー:**

1. IP 単位の制限（`auth:login`、50回／600秒）を数える（`src/app/api/auth/login/route.ts`）
2. 本文を JSON で読み、形を確かめる
3. Turnstile を確かめる
4. メール単位の制限（`auth:login`、5回／600秒、`subject` はメール）を数える
5. 匿名の client（`createPublicClient`）でパスワードを確かめる。得た session は使わない
6. 同じ client で確認コードを送る。`shouldCreateUser: false` で新しい利用者を作らない
7. 戻り先を確かめて控える（`issueReturnIntent`、用途 `login`、DD-AUTH-034）
8. 利用者の id とメールで保留の印を作り、Cookie に入れ、戻り先の Cookie も付けて 200 を返す
9. `login` の `password_verified`（`otp_sent`）を監査に残す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| IP の制限が応答を返す | その応答を返す。本文を読まない（`src/app/api/auth/login/route.ts`） |
| IP の制限の呼び出しが投げる | 記録して先へ進む |
| 形が合わない | 400 |
| Turnstile が通らない | `login` の failure（`turnstile.error`、無ければ `turnstile_failed`）を残して 403 |
| メールの制限が応答を返す | その応答を返す |
| メールの制限の呼び出しが投げる | 記録して先へ進む |
| パスワードの確かめが誤り、または session か user が無い | `login` の failure（誤りの文、無ければ `invalid credentials`）を残して 401。どちらが誤りかは言わない |
| 確認コードの送信が誤り | `login` の error（`otp_send_failed`）を残して 500 |
| `x-forwarded-for` が無い・空 | Turnstile に IP を渡さない（`null`） |
| `next` が無い・確かめに外れる・控えの作成が失敗 | ログインは止めず 200。戻り先の Cookie を消す側（外れた時は理由の符号だけ監査） |
| パスワードの誤り・Turnstile・制限・確認コードの送信の失敗 | 戻り先を作らず、Cookie も付けない |
| 本文が JSON でない・そのほかの例外 | 500 `Internal server error` |

**状態・永続化:** 戻り先を控える時だけ `private.auth_return_intents` に 1 行書く（DATA-AUTH-005。Cookie の番号は STATE-AUTH-006）。ほかは DB の表に書かない。Supabase Auth の確認コードの発行と、保留の Cookie（利用者の id・メール・用途・発行の時刻を HMAC で署名した印、STATE-AUTH-001）だけが状態。保留の印の作り方と寿命は共有の `login-2fa-session.ts` が持つ。

**認証認可:** ログインを求めない公開の窓口。Origin は共有の proxy が確かめる。`no-store` を付けない（SEC-AUTH-022 は満たさない）。Supabase Auth を直接呼べばこの窓口を通らずにトークンを得られる（SEC-AUTH-005 は満たさない）。

**テスト観点:**（単体テストは無い。結合 `tests/integration/api/auth/login.test.ts` が 10 件で多くの道を通す）

| # | 観点 |
| --- | --- |
| 1 | 正しい資格で 200・`step: 'otp'`・保留の Cookie・`password_verified` の監査 |
| 2 | IP の制限の応答をそのまま返し、本文を読まない |
| 3 | IP の制限が投げても先へ進む |
| 4 | 形の誤りで 400 |
| 5 | Turnstile の失敗で 403。誤りの文の有り・無しの両方 |
| 6 | メールの制限の応答をそのまま返す。Turnstile の失敗では数えない |
| 7 | メールの制限が投げても先へ進む |
| 8 | 誤りの文の有る失敗・誤りの無い session 無しの両方で 401 |
| 9 | 確認コードの送信の失敗で 500 |
| 10 | `x-forwarded-for` の有り・無し |
| 11 | 本文が壊れていて 500 |
| 12 | `next` が有効で戻り先の Cookie（`Max-Age=900`・HttpOnly・SameSite=Lax）が付く。無い・外れる（`//evil.example`・数値・3000 字）・DB の失敗でも 200 で Cookie は消す側。401・403・500 の応答に Cookie が付かない。本文に番号・道筋が出ない |

### DD-AUTH-015 ログインの2段目の窓口（確認コードを確かめてログインを確定する）

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-002、ARC-AUTH-001、ARC-AUTH-002、STATE-AUTH-001、DATA-AUTH-001、DATA-AUTH-004、DATA-AUTH-006、SEC-AUTH-002、SEC-AUTH-003、SEC-AUTH-022、SEC-AUTH-030 |
| 根拠 | パスワードを通った署名した保留が無ければ断り、宛先も保留からだけ取って本文の値を信じない（SEC-AUTH-003、FREQ-336-REQ-03）。総当たりを保留の宛先単位で止め、上限で保留ごと捨てて窓を閉じる（SEC-AUTH-002、STATE-AUTH-001、ADR-0402）。コードは `type: 'email'` の1回だけで確かめ、別の用途の印を2要素目として受けない（FREQ-335-REQ-03）。確定したら認証の Cookie と `sessions` の行を作り、ゲストの注文・カートを会員へ合わせる（API-AUTH-002、DATA-AUTH-001） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/otp/verify/route.ts`）、`docs/04_DetailDesign/sequence/auth-login-mfa.md` の SQ-AUTH-LOGIN-OTP |

**対応要件 ID:** API-AUTH-002、ARC-AUTH-001・002、STATE-AUTH-001、DATA-AUTH-001・004・006、SEC-AUTH-002・003・022・030（その上は FR-LOGIN-001、FREQ-58-REQ-01、FREQ-335-REQ-01〜03、FREQ-336-REQ-03、ADR-0402、FREQ-265-REQ-01（範囲外）、FREQ-428-REQ-01（範囲外））

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `POST /api/auth/otp/verify`。JSON の `code`（形は共有の `OtpVerifyRequestSchema`。本文の `email` は読まない）と保留の Cookie |
| 出力 200 | `{ user: { id, email, role }, message: '認証に成功しました。' }`。`user` は Supabase の利用者の記録をそのまま返さず 3 つのキーだけにする（`role` は `app_metadata.role` から読み、`admin`・`supporter` 以外は `user`）。保留の Cookie を消し、共有の `persistSessionAndCookies` が access・refresh・CSRF・`session_id` の Cookie を入れる |
| 出力の失敗 | 400（形）、401（保留が無い・コードの誤りか期限切れ）、429（IP の制限の応答、または宛先単位の上限で保留の Cookie を消した 429）、500（保存の失敗・例外） |

**正常フロー:**

1. IP 単位の制限（`auth:otp:verify`、30回／600秒）を数える（`src/app/api/auth/otp/verify/route.ts`）
2. 本文の形を確かめ、`code` だけを取る
3. 保留の Cookie を読む
4. 保留の宛先単位の制限（5回／600秒、`subject` は保留のメール）を数える
5. 匿名の client で、保留のメールと `code` を `type: 'email'` で1回だけ確かめる
6. 200 の応答（`user` は `id`・`email`・`role` だけ）を作り、保留の Cookie を消す
7. ゲストのカート・お気に入りの印を読み、セッションを Cookie と表に保存する
8. ゲスト注文の紐付け（注文まわりの作り直しで書き換え中の共有の `linkGuestOrdersByEmail`）を呼ぶ
9. `auth.otp.verify` の success（`verified_type:email`）を残して返す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| IP の制限が応答を返す | その応答を返す（`src/app/api/auth/otp/verify/route.ts`） |
| IP の制限の呼び出しが投げる | 記録して先へ進む |
| 形が合わない | 400 |
| 保留が無い・署名の誤り・期限切れ | `auth.otp.verify` の failure（`missing_or_invalid_password_session`）を残して 401 |
| 宛先単位の上限、または数え場所の障害（503） | どちらも新しい 429 を作り、元の応答に `Retry-After` があれば写し、保留の Cookie を消し、failure（`account_rate_limited`）を残す |
| 宛先単位の制限の呼び出しが投げる | 記録して先へ進む |
| コードの確かめが誤り、または session か user が無い | failure（`invalid_or_expired_otp`）を残して 401。保留は消さない |
| セッションの保存が失敗（`ok` が偽か結果が無い） | error（`session_persist_failed`、理由が無ければ `unknown`）を残して 500 |
| 利用者のメールが無い | 監査と紐付けに保留のメールを使う |
| 利用者の確認の時刻が無い | 紐付けに `null` を渡す |
| 本文が JSON でない・そのほかの例外 | 500 |

**状態・永続化:** 保留の Cookie を消す。`sessions` の表への行の作成と認証の Cookie は共有の `persistSessionAndCookies`（DATA-AUTH-001・004）。ゲストのカート・お気に入りの合わせ（H）とゲスト注文の紐付け（注文まわりの作り直しで書き換え中）は共有の関数で、この窓口は呼ぶだけ。誤りのコードでは保留を残す（5回までは打ち直せる）。

**認証認可:** 公開の窓口。保留の Cookie が「パスワードを通った」唯一の根拠。応答の本文に Supabase の利用者の記録・トークンを入れない（SEC-AUTH-022 の本文の部分。2026-10-26）。`no-store` を付けない（波 3）。

**テスト観点:**（単体 `tests/unit/api/auth/otp-verify-route.test.ts`。結合 `tests/integration/api/auth/otp-verify.test.ts`・`otp-sdk-flow.test.ts`・`tests/integration/api/auth-otp-verify-api.test.ts`）

| # | 観点 |
| --- | --- |
| 1 | 正しいコードで 200・保留の Cookie の消去・保存・紐付け・success の監査 |
| 2 | IP の制限の応答と、呼び出しの例外 |
| 3 | 形の誤りで 400 |
| 4 | 保留が無くて 401 |
| 5 | 宛先単位の上限で 429・保留の消去。`Retry-After` の有り・無しの両方 |
| 6 | 宛先単位の制限の呼び出しが投げても先へ進む |
| 7 | 本文に別の `email` を書いても、確かめと数えは保留のメール |
| 8 | 確かめの誤り・session 無し・user 無しで 401 |
| 9 | 保存の失敗で 500。理由の有り・無し、結果が無い時 |
| 10 | 利用者のメール・確認の時刻が無い時に保留のメールと `null` を使う |
| 11 | 本文が壊れていて 500 |
| 12 | 成功の本文の `user` が `id`・`email`・`role` の 3 つだけで、`app_metadata` などの記録とトークンが無い。`role` は `admin`・`supporter`・それ以外は `user` |

### DD-AUTH-016 確認コードの再送の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-003、STATE-AUTH-001、DATA-AUTH-004、SEC-AUTH-003、SEC-AUTH-004 |
| 根拠 | パスワードを通ったことは保留の Cookie が示すので、再送にパスワードを求めず、宛先は Cookie から取って本文を見ない。本文のメールを信じると他人の宛先へ店のドメインからメールを送らせる（SEC-AUTH-003、API-AUTH-003）。1つのアカウントへ送る総量を抑えるため、ログインと同じ枠で IP とメールの2段で数える（ADR-0401）。作り直す印は元の発行の時刻を引き継ぎ、30分の上限を延ばさない（SEC-AUTH-004、STATE-AUTH-001） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/login/resend/route.ts`）、`docs/04_DetailDesign/sequence/auth-login-mfa.md` の SQ-AUTH-LOGIN-RESEND |

**対応要件 ID:** API-AUTH-003、STATE-AUTH-001、DATA-AUTH-004、SEC-AUTH-003・004（その上は FREQ-334-REQ-05、FREQ-336-REQ-01・02、ADR-0401）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `POST /api/auth/login/resend`。保留の Cookie だけ。本文は読まない |
| 出力 200 | `{ ok: true }`、`Cache-Control: no-store`。発行の時刻を引き継いだ保留の Cookie（5分） |
| 出力の失敗 | 401（「セッションの有効期限が切れました。…」）、429（回数の制限の応答）、500（送信の失敗） |

**正常フロー:**

1. 保留の Cookie を読む（`src/app/api/auth/login/resend/route.ts`）
2. IP 単位（`auth:login`、50回／600秒）と宛先単位（`auth:login`、5回／600秒、`subject` は保留のメール）を数える。枠の名前はログインと同じ
3. 匿名の client で保留のメールへ確認コードを送る（`shouldCreateUser: false`）
4. 200 を作り、`no-store` を付け、元の `iat` を渡して保留の印を作り直す
5. `login` の `otp_resent` を残して返す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 保留が無い・無効 | 401。回数を数えない（`src/app/api/auth/login/resend/route.ts`） |
| IP の制限が応答を返す | その応答を返す。宛先の枠は数えない |
| 宛先の制限が応答を返す | その応答を返す |
| 制限の呼び出しが投げる | 記録して送信へ進む |
| 送信が誤り | `login` の error（`otp_resend_failed`）を残して 500。保留の Cookie は作り直さない |

**状態・永続化:** 保留の Cookie を作り直すだけ（寿命は5分に戻るが、`iat` から30分の上限は動かない、STATE-AUTH-001）。60秒の再送の待ちは画面だけが持ち、この窓口は数えない。

**認証認可:** 公開の窓口。保留の Cookie が根拠。Turnstile を通さない（FREQ-330-REQ-03 の再送の部分は満たさない。ARC-AUTH-005）。

**テスト観点:**（単体テストは無い。結合 `tests/integration/api/auth/login-resend.test.ts`（8））

| # | 観点 |
| --- | --- |
| 1 | 保留ありで 200・`no-store`・作り直した Cookie・`otp_resent` |
| 2 | 保留なしで 401、回数を数えない |
| 3 | IP の制限で返す |
| 4 | 宛先の制限で返す。数える `subject` が保留のメール |
| 5 | 制限が投げても送る |
| 6 | 送信の失敗で 500 |
| 7 | 作り直した印の `iat` が元の印と同じ |

### DD-AUTH-017 保留の取り消しの窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-004、STATE-AUTH-001、STATE-AUTH-006、SEC-AUTH-030、SEC-AUTH-032 |
| 根拠 | 別の宛先でやり直す時に前の保留を残さない（API-AUTH-004、STATE-AUTH-001）。回数の制限の無い窓口なので、捨てる物が無い時に監査を書くと行を水増しできる。有効な保留を捨てた時だけ残す（FREQ-336-REQ-04、SEC-AUTH-030） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/login/cancel/route.ts`）、`docs/04_DetailDesign/sequence/auth-login-mfa.md` の SQ-AUTH-LOGIN-CANCEL |

**対応要件 ID:** API-AUTH-004、STATE-AUTH-001、SEC-AUTH-030（その上は FREQ-334-REQ-06、FREQ-336-REQ-04）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `POST /api/auth/login/cancel`。保留の Cookie（無くてもよい） |
| 出力 | いつも 200 `{ ok: true }`、`no-store`。保留の Cookie と戻り先の Cookie を消す（共有の `clearCookieOptions`） |

**正常フロー:**

1. 保留の Cookie を読む（`src/app/api/auth/login/cancel/route.ts`）
2. 200 を作り、`no-store` と Cookie の消去（保留と戻り先）を付ける
3. 保留が有効なら `login` の `cancelled`（`otp_step_abandoned`）を残す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 保留が有効 | 監査に残す（宛先は保留のメール）（`src/app/api/auth/login/cancel/route.ts`） |
| 保留が無い・無効 | 監査を書かずに同じ 200 |
| 監査が投げる | 例外がそのまま出る（`try` が無い）。共有の `logAudit` が投げるかは共有部品の作り次第 |

**状態・永続化:** 保留の Cookie と戻り先の Cookie を消すだけ。Supabase Auth の確認コードは取り消さない（5分で切れる）。戻り先の表の行も消さない（期限と毎日の掃除で消える。DATA-AUTH-005）。

**認証認可:** 公開の窓口。回数の制限を置かない。CSRF は共有の proxy の Origin の確かめに任せる。

**テスト観点:**（単体テストは無い。結合 `tests/integration/api/auth/login-cancel.test.ts`（3））

| # | 観点 |
| --- | --- |
| 1 | 保留ありで 200・Cookie の消去（戻り先の Cookie の消去を含む）・`cancelled` の監査 |
| 2 | 保留なしでも 200・Cookie の消去、監査を書かない |

### DD-AUTH-018 会員登録の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-005、ARC-AUTH-005、ARC-AUTH-006、ARC-AUTH-007、ARC-AUTH-010、DATA-AUTH-003、SEC-AUTH-007、SEC-AUTH-014、SEC-AUTH-016、SEC-AUTH-017、SEC-AUTH-019、SEC-AUTH-022、SEC-AUTH-026、SEC-AUTH-032 |
| 根拠 | 任意のメールで会員かどうかを調べさせないため、登録済みでも新規と同じ 202 を返し、登録済みは本人にだけ応答の外でメールで伝える（API-AUTH-005、ARC-AUTH-006、ADR-0404）。照会の失敗を「無い」に丸めず止める（FREQ-320-REQ-01、DATA-AUTH-003）。メール送信の手前に Turnstile を置いてボットに送信を叩かせない（ARC-AUTH-005）。16 文字以上で漏洩していないパスワードだけを受け、照合先が落ちたら止めずに監査に残す（SEC-AUTH-014、ARC-AUTH-007、ADR-0405）。確認のリンクは許可した住所でだけ作る（SEC-AUTH-019）。戻り先は Turnstile と漏洩の確かめの後で既存会員の照会の前に控え、3 つの 202 の枝で Cookie の形を同じにする（ARC-AUTH-010、SEC-AUTH-032）。控えは戻り先が無い・外れた時も既定の `/` で必ず作り、登録したメールに結ぶ。確認のリンクを登録を始めたブラウザで開いた時だけ session を作るため（SEC-AUTH-007、ADR-0413） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/register/route.ts`）、`docs/04_DetailDesign/sequence/auth-registration.md` の SQ-AUTH-REGISTER-PUBLIC |
| 旧番号 | IMPL-AUTH-REG-01 |
| 旧所在 | `docs/04_DetailDesign/pages/14_login.md`（基準コミットの版）の「Supabase Auth 必須対応」の AUTH-01-SUPA-01 の行、「実装フェーズ 完了状況」の AUTH-01-05 の行 |

**対応要件 ID:** API-AUTH-005、ARC-AUTH-005・006・007・010、DATA-AUTH-003、SEC-AUTH-007・014・016・017・019・022・026・032（その上は FR-AUTH-005、FREQ-320-REQ-01・03、FREQ-323-REQ-01〜03、ADR-0404・0405・0413）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `POST /api/auth/register`。JSON の `email`・`password`・`display_name`（任意）・`turnstileToken`・`next`（任意。型は縛らない。古い `redirect_to`・`emailRedirectTo` は読まない）。形は共有の `RegisterRequestSchema`（16 文字はここ）。`x-forwarded-for`。`x-admin-token`・Bearer は読まない |
| 出力 202 | `{ message: 'Confirmation email sent' }`（新規で確認が要る時・登録済み・除外の宛先）。戻り先の Cookie `sb-return-intent`（1 時間。`next` が無い・外れた時も既定の `/` で必ず付ける）は 3 つの枝で属性の並びが同じ |
| 出力 201 | Supabase が session を返した時（Confirm email が OFF）だけ。`{ user: { id, email } }` と認証の Cookie（`access_token`・利用者の記録は載せない） |
| 出力の失敗 | 400（形・漏洩）、403（Turnstile）、429（回数の制限。IP 単位と宛先単位）、500（作成・保存の失敗・例外）、503（住所の見張り・照会の失敗） |

**正常フロー（公開）:**

1. IP 単位の制限（`auth:register`、20回／3600秒）（`src/app/api/auth/register/route.ts`）
2. 本文の形を確かめる
3. Turnstile を確かめる
4. 要求から住所を作り、許可の一覧（共有の `isEmailOriginAllowed`）にあるか確かめる
5. 漏洩の照合（共有の `checkPwnedPassword`）
6. 宛先（メール）単位の制限（`auth:register`、5回／3600秒、subject は形を通った小文字のメール）。控えの作成と既存会員の照会より前
7. 戻り先を確かめて控える（`issueReturnIntent`、用途 `signup`、`bindTo` は小文字のメール、`alwaysCreate` は真。DD-AUTH-034）。戻り先が無い・外れた時も既定の `/` で作る。得た Cookie の動作を、下の 202 の 3 つの枝すべてに同じ形で付ける
8. service role の client でメールからアカウントを引く（共有の `findAuthUserIdByEmail`、DATA-AUTH-003）
9. 無ければ、利用者の session の client で登録する。確認のリンクは `/api/auth/confirm`（クエリを持たない）
10. session が無ければ `created_needs_confirmation` を残して 202

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| IP の制限が応答を返す・呼び出しが投げる | 返す・記録して進む（`src/app/api/auth/register/route.ts`） |
| `x-admin-token`・Bearer が付いている | 読まない。いつも公開の経路（鍵の設定の有無で動きを変えない。SEC-AUTH-017） |
| 宛先単位の制限が応答を返す | そのまま返す（429）。控え・照会・登録・メール送信へ進まない |
| 宛先単位の制限の呼び出しが投げる | 記録して進む |
| 形が合わない | 400 |
| `next` が無い・確かめに外れる | 戻り先を既定の `/` にして控えを作る（外れた理由の符号は監査に残す）。応答の形は変えない |
| 控えの作成が失敗 | 戻り先の Cookie を消す側にする。応答の形は変えない |
| Turnstile が通らない | failure（誤りの文、無ければ `turnstile_failed`）を残して 403 |
| `x-forwarded-for` が無い | Turnstile に `null` |
| 住所が許可の一覧に無い | 応答の外で運用へ知らせ、503 |
| 漏洩に当たる | failure（`pwned_password`）を残して 400 |
| 照合先が使えない | error（`pwned_check_unavailable`）を残して続ける |
| 照会が失敗 | error（`user_lookup_failed`）を残して 503 |
| 登録済み | conflict（`already_registered_notified`）を残し、応答の外で本人に `/login` のリンクのメールを送り、202 |
| `display_name` が無い | 登録の `data` を付けない |
| 登録が誤り・文に `already`・`duplicate`（除外の宛先） | conflict を残し、同じ通知と 202 |
| 登録がほかの誤り | error を残して 500 |
| session があり user が無い | error（`missing_user_after_signup`）を残して 500 |
| session があり保存が成功 | success を残して 201 `{ user: { id, email } }`。戻り先の Cookie は消す |
| session があり保存が失敗（`ok` が偽） | access・refresh・CSRF の Cookie を消し（消すのが投げても記録だけ）、error を残して 500 |
| session があり保存が投げる | 同じく Cookie を消し、error を残して 500 |
| 公開の経路の中の例外 | 500 |
| 本文が JSON でない・外側の例外 | 500 |

**状態・永続化:** 新規は Supabase Auth の `auth.users` に作る。session が返った時だけ共有の `persistSessionAndCookies` が `sessions` の行と認証の Cookie を作る（DATA-AUTH-001・004）。登録済みの通知と住所の見張りの知らせは `after` で応答の外。

**認証認可:** 公開の経路だけで、ログインを求めない。管理の鍵の枝は無い（SEC-AUTH-017。`ADMIN_API_KEY` を読む所は無い）。201 の本文は `{ user: { id, email } }` だけ（SEC-AUTH-022 の本文）。宛先単位の制限は 5 回／時で、Turnstile と漏洩の確かめを通った要求だけを数える（SEC-AUTH-016-AC-03）。列挙の対策は Confirm email が ON の前提で、OFF だと新規の 201 と登録済みの 202 で判別できる（SEC-AUTH-029）。応答の時間は、登録済みのメールを `after` に回してそろえる（SEC-AUTH-016 の時間の部分は確かめていない）。

**テスト観点:**（単体 `tests/unit/api/auth/register-route.test.ts`。結合 `tests/integration/api/auth/register.test.ts`（3）・`register-enumeration.test.ts`（4）・`auth-bot-rate-limit.test.ts`・`site-url-guard.test.ts`）

| # | 観点 |
| --- | --- |
| 1 | 新規で確認が要る時に 202・`created_needs_confirmation`・確認のリンクの送り先 |
| 2 | IP の制限の応答と例外 |
| 3 | 管理の見出し（`x-admin-token` と Bearer、鍵の設定が無い・違う・合う）を付けても `createUser` を呼ばず公開の登録として通る |
| 4 | 宛先単位の制限（小文字のメールを subject に 5 回／3600 秒。順番は Turnstile → 漏洩 → 枠 → 控え → 照会。超過で 429・照会以降へ進まない。Turnstile・漏洩で止まった要求は数えない。呼び出しが投げたら進む） |
| 5 | 形の誤りで 400 |
| 6 | `next` の有り・無し・外れ・型が文字列でない（無い・外れでも `/` で控えを作り、`bindTo` は小文字のメール）。古い `redirect_to`・`emailRedirectTo` を送っても読まない。確認のリンク（`emailRedirectTo`）にクエリが無い |
| 7 | Turnstile の失敗（誤りの文の有り・無し）、`x-forwarded-for` の有り・無し |
| 8 | 住所の見張りで 503 |
| 9 | 漏洩で 400、照合先が使えない時に続ける |
| 10 | 照会の失敗で 503 |
| 11 | 登録済みで 202 と通知（通知の送信の失敗を記録だけにする） |
| 12 | `display_name` の有り・無し |
| 13 | 登録の重複の文で 202、ほかの誤りで 500 |
| 14 | session があり user が無い・保存が成功（201 の本文が `{ user: { id, email } }` だけ）・保存が失敗・保存が投げる・Cookie の消去が投げる |
| 15 | 公開の経路の中の例外と、本文の壊れ |
| 16 | 新規・登録済み・重複の例外の 3 枝で、202・本文・戻り先の Cookie の属性の並びが同じ（`next` が無い・外れでも付く）。控えの作成の失敗でも 202 で Cookie は消す側。控えの作成が既存会員の照会より前で、Turnstile の失敗では呼ばれない |

### DD-AUTH-019 確認のメールのリンクの窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-006、ARC-AUTH-001、ARC-AUTH-010、FLOW-AUTH-003、DATA-AUTH-001、SEC-AUTH-006、SEC-AUTH-007、SEC-AUTH-026、SEC-AUTH-030、SEC-AUTH-032 |
| 根拠 | 会員登録を確認のリンクで終わらせ、登録を始めた端末ではそのままログインさせる入口（API-AUTH-006、FLOW-AUTH-003）。別の端末や別のメールの印では、メールの確認だけ済ませて session を作らない（攻撃者のリンクで被害者の端末を攻撃者のアカウントにログインさせないため。SEC-AUTH-007、ADR-0413）。印や理由を URL・応答に残さないよう、結び付いた成功は戻り先か `/`、結び付かない成功は `/login?registered=1`、失敗は固定の `/login` へ 303 で移し、理由は監査だけに残す（SEC-AUTH-030）。送り先はリンクの値を読まず、登録した端末の戻り先の控えだけで決める（SEC-AUTH-026、SEC-AUTH-032）。ログインしたらゲストの注文・カートを会員へ引き継ぐ（FREQ-265・428（範囲外）） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/confirm/route.ts`）、`docs/04_DetailDesign/sequence/auth-registration.md` の SQ-AUTH-REGISTER-CONFIRM |
| 旧番号 | IMPL-AUTH-CONF-01、IMPL-AUTH-CONF-02 |
| 旧所在 | `docs/04_DetailDesign/pages/14_login.md`（基準コミットの版）の「Supabase Auth 必須対応」の AUTH-01-SUPA-02・03 の行、「Confirm 後の UX」の節 |

**対応要件 ID:** API-AUTH-006、ARC-AUTH-001・010、FLOW-AUTH-003、DATA-AUTH-001、SEC-AUTH-006・007・026・030・032（その上は FR-AUTH-005、ADR-0413、FREQ-265-REQ-01（範囲外）、FREQ-428-REQ-01（範囲外））

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `GET /api/auth/confirm`。問い合わせの `token_hash`（無ければ `token`）・`type`（無い・空なら `signup`。`signup` 以外は受けない）と `sb-return-intent` の Cookie。`redirect_to` は読まない |
| 出力 | 303 で戻り先か `/`（結び付いた成功。管理者・サポーターは `/auth/verified`）、`/login?registered=1`（結び付かない成功。メールの確認のみ）、`/login`（失敗）へ。`Cache-Control: no-store`・`Referrer-Policy: no-referrer`。結び付いた成功なら認証の Cookie と、戻り先の Cookie の削除。結び付かない時は Cookie を何も書かず消さない |
| 出力の 429 | 回数の制限の応答。応答の型が `Response` でない時は `Retry-After: 600` の 429 を作る |

**正常フロー:**

1. IP 単位の制限（`auth:confirm`、50回／600秒）（`src/app/api/auth/confirm/route.ts`）
2. 住所・印・型を問い合わせから読む。印が無ければ `/login`
3. `type` が `signup` でなければ、`verifyOtp` を呼ばず `invalid_type` の failure を残して `/login`
4. 匿名の client で印を確かめる（`type: 'signup'` 固定）
5. 結び付けを確かめて控えを使い切る（`consumeSignupBinding`。Cookie の番号と、確認した利用者のメールを一緒にハッシュした印。用途 `signup`。DD-AUTH-034）。session を作る前に行う
6. 当たらなければ、`signOut({ scope: 'local' })` で GoTrue 側の session を失効させ、`auth.confirm` の success（detail `confirmed_without_session`、reason `no_binding`）を残して `/login?registered=1` へ 303（Cookie は書かず消さない）。ここで終わる
7. 当たれば、既定の行き先 `/` への 303 を作り、ゲストのカート・お気に入りの印を添えてセッションを保存する
8. ゲスト注文の紐付けを呼ぶ
9. 保存に成功したら、使い切った戻り先を出口の確かめに通し（`resolveStoredDestination`、DD-AUTH-034。管理者・サポーターは戻り先を捨てて `/auth/verified`）、`Location` を差し替えて戻り先の Cookie を消す
10. `auth.confirm` の success を残して返す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 回数の制限が `Response` を返す | そのまま返す（`src/app/api/auth/confirm/route.ts`） |
| 回数の制限が `Response` でない値を返す | 429 と `Retry-After: 600` を作って返す |
| 回数の制限の呼び出しが投げる | 記録して進む |
| `token_hash` が無く `token` がある | `token` を使う |
| `type` が無い・空 | `signup` |
| `type` が `signup` 以外（`email`・`magiclink`・`recovery`・不明・大文字違い） | `verifyOtp` を呼ばず（印を消費せず）、セッションも戻り先の控えも触らず、failure（`invalid_type`。値そのものは残さない）を残して `/login` へ 303 |
| 印が無い | failure（`missing_token`）を残して `/login` へ 303 |
| 確かめの誤り、または session か user が無い | 誤りの文を「期限切れ・無効・使用済み・不明」に分けた `reason` と固定の detail（`verify_failed`・`missing_session_or_user`）で failure を残し、`/login` へ 303。誤りの文は残さない |
| 保存が失敗 | error（固定の `session_persist_failed`。保存の誤りの文は残さない）を残し、作った 303（`/`）を返す。戻り先の Cookie は削除し、`verifyOtp` の session は `signOut({ scope: 'local' })` で失効させる（紐付け・出口の確かめは呼ばない。控えは既に使い切り済み） |
| 利用者のメールが無い | 結び付けの確かめに空の文字が渡り外れる（結び付かない扱い。監査の宛先は `null`） |
| `signOut` が失敗（`{ error }` で返る場合も、投げられる場合も） | 握る。`console.error` に符号（`error.code`、無ければ `status`）だけ。本文は残さない。応答は変えない |
| 例外 | error（detail・reason とも固定の `unexpected`。例外の文は残さない）を残して `/login` へ 303 |
| 戻り先の Cookie が無い（別のブラウザ）・番号が 2 つ・用途が違う・期限切れ・使用済み・別のメールの印・DB の失敗 | 結び付かない。session を作らず `/login?registered=1` へ 303。Cookie は書かず消さない |
| 結び付いて使い切れた | 出口の確かめ（役割・aal を渡す）に通した道筋へ 303。管理者・サポーターは `/auth/verified` |

**状態・永続化:** 成功で `sessions` の行と認証の Cookie（共有の `persistSessionAndCookies`、DATA-AUTH-001）。ゲスト注文の紐付けは冪等で、失敗しても次のログインで再び試す。

**認証認可:** 公開の入口。`signup` の印だけを受け、それ以外の型では `verifyOtp` を呼ばない（SEC-AUTH-006）。開いた端末を登録した人の端末に結ぶ（SEC-AUTH-007）。控えの番号とメールを一緒にハッシュするので、被害者の有効な Cookie と攻撃者のメールの印の組は外れる。結び付かない時に Cookie を消さないのは、攻撃者のリンクで被害者の進行中の登録の控えを壊させないため。残る穴: Cookie 名に `__Host-` の頭が無く、同じ親ドメインの別のサブドメインから控えを投げ込まれる余地がある（cookie tossing。波 1-A の設計のまま）。

**テスト観点:**（単体 `tests/unit/api/auth/confirm-route.test.ts`。結合 `tests/integration/api/auth/confirm.test.ts`（5））

| # | 観点 |
| --- | --- |
| 1 | 結び付いた正しい印で 303・Cookie・紐付け・success |
| 2 | 回数の制限が `Response` を返す・`Response` でない値を返す・投げる |
| 3 | `token_hash` が無く `token` で確かめる、`type` が無い・空・`signup`。`type` が `signup` 以外（`email`・`magiclink`・`recovery`・不明・`SIGNUP`）で `verifyOtp` が呼ばれず `/login`・Set-Cookie 無し・`invalid_type` |
| 4 | 印が無くて 303 と failure |
| 5 | 確かめの誤りの文が expired・invalid・used・どれでもない（detail は固定の `verify_failed` で、文が監査に無い）、誤りが無く session が無い |
| 6 | 保存の失敗で紐付けを呼ばずに 303（控えは保存の前に使い切り済み） |
| 7 | 利用者のメールが無い（使い切りに空の文字が渡り、結び付かない扱い） |
| 8 | 確かめが投げて 303 と error（detail は固定の `unexpected`） |
| 9 | `redirect_to`（`//evil.example`・`%2F%09%2Fevil.example`）を渡しても読まず、失敗は `/login`、成功は `/` へ。`Location` の origin が同じ |
| 10 | 結び付いて戻り先の Cookie があれば戻り先へ 303 し Cookie を消す。使い切りは保存の前。管理者・サポーターは `/auth/verified` |
| 11 | `type=magiclink` などでは `verifyOtp`・保存・戻り先の使い切りのどれも呼ばない。保存の失敗の前に使い切りは済んでいる（呼び出しの順は 使い切り → 保存 → 出口の確かめ） |
| 12 | 結び付かない（Cookie 無し・別のメールの印・用途違い・使用済み・番号が 2 つ）: `persistSessionAndCookies`・紐付けを呼ばず、`signOut({ scope: 'local' })` を 1 回呼び（reject しても 303 のまま）、`/login?registered=1`、Set-Cookie 無し（控えの Cookie も消さない）、監査 `confirmed_without_session` |

### DD-AUTH-020 Google のログインの開始の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-007、ARC-AUTH-010、FLOW-AUTH-002、SEC-AUTH-026、SEC-AUTH-030、SEC-AUTH-032 |
| 根拠 | Google のアカウントでログインする入口（API-AUTH-007、FLOW-AUTH-002）。PKCE の検証の値をライブラリが Cookie に持ち、戻りの窓口で交換するので、トークンを画面に渡さない。戻りの後の送り先は入口で確かめて控えた戻り先だけにし、戻りの URL に載せない（SEC-AUTH-026、SEC-AUTH-032）。控えを作れるのは POST だけ。共有の端末で前の人のアカウントに入らないよう、毎回アカウントを選ばせる（`prompt=select_account`）。成否を監査に残す（SEC-AUTH-030） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/oauth/start/route.ts`）、`docs/04_DetailDesign/sequence/auth-oauth.md` の SQ-AUTH-OAUTH-START |
| 旧番号 | IMPL-LOGIN-002、IMPL-OAUTH-001、IMPL-OAUTH-009 |
| 旧所在 | `docs/04_DetailDesign/pages/14_login.md`（基準コミットの版）の「機能要件対応表」の FR-LOGIN-002 の行、「Google OAuth 実装 (AUTH-02)」の AUTH-02-AC-001・010 の行 |

**対応要件 ID:** API-AUTH-007、ARC-AUTH-010、FLOW-AUTH-002、SEC-AUTH-026・030・032（その上は FR-AUTH-005、FR-LOGIN-002）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `GET` は問い合わせの `provider`（1文字以上）。`POST` は JSON の `provider`・`next`（任意。型は縛らない）。`redirect_to` は読まない。環境変数 `SUPABASE_URL`（無ければ `NEXT_PUBLIC_SUPABASE_URL`）・`NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| 出力 | GET は 302 で Google の同意の画面へ、POST は 200 `{ url }`（リダイレクトしない）。`no-store`・`no-referrer`。ライブラリ（`@supabase/ssr`）が書いた PKCE の Cookie をそのまま付ける。POST は戻り先の Cookie `sb-return-intent`（15 分）も付ける（GET は戻り先を作らず、残っている Cookie を消す） |
| 出力の失敗 | 400（形・`google` 以外・POST の本文が JSON でない）、429（回数の制限の応答）、500（環境変数・例外）、502（URL の生成の失敗） |

**正常フロー:**

1. 要求から住所を作る（`src/app/api/auth/oauth/start/route.ts`）
2. IP 単位の制限（`auth:oauth:start`、50回／600秒）
3. 問い合わせ（GET）か本文（POST）の形を確かめる
4. プロバイダが `google` か確かめる
5. 戻りの先を `/api/auth/oauth/callback`（クエリ無し）にする
6. 要求の Cookie を読む関数と、書く Cookie を溜める箱を渡して、PKCE の client を作る
7. `prompt: 'select_account'` を付けて同意の画面の URL を作る
8. GET は 302、POST は 200 `{ url }` を作り、溜めた Cookie を付ける。POST は `issueReturnIntent`（用途 `login`、DD-AUTH-034）で戻り先を控えて Cookie を付ける。GET は残っている戻り先の Cookie を消す。`auth.oauth.start` の success を残す（戻り先の道筋は残さない）

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 回数の制限が応答を返す・呼び出しが投げる | 返す・記録して進む（`src/app/api/auth/oauth/start/route.ts`） |
| `provider` が無い・空 | failure（`invalid_query`）を残して 400 |
| POST の `next` が無い・確かめに外れる・控えの作成が失敗 | URL は返し、戻り先の Cookie を消す側（外れた時は理由の符号だけ監査） |
| POST の本文が JSON でない | 400 |
| `google` 以外 | failure（`unsupported_provider`）を残して 400 |
| `SUPABASE_URL` が無い | `NEXT_PUBLIC_SUPABASE_URL` を使う |
| URL か anon の鍵が無い | error（`missing_supabase_env`）を残して 500 |
| 要求の Cookie が無い | 空の一覧を渡す |
| Cookie の1つに `=` が無い・先頭が `=` | その1つを捨てる |
| Cookie の値を URL の形で戻せない | 生の値を使う |
| URL の生成が誤り、または URL が無い | failure を残して 502 |
| 例外 | error を残して 500 |

**状態・永続化:** POST で戻り先を控える時だけ `private.auth_return_intents` に 1 行書く（DATA-AUTH-005）。PKCE の検証の値はライブラリの Cookie だけが持つ（属性はライブラリの既定。SEC-AUTH-023 は満たさない）。旧版の `oauth_requests` の表は使わない。

**認証認可:** 公開の窓口。`GET` は共有の proxy の Origin の確かめを受けないので戻り先を作らない。`POST` は受ける。始めるのを `fetch` の POST にするのは CSP の `form-action 'self'` のため（API-AUTH-007）。

**テスト観点:**（単体テストは無い。結合 `tests/integration/api/auth/oauth-start.test.ts`（3））

| # | 観点 |
| --- | --- |
| 1 | `google` で 302・`select_account`・戻り先の `next`・Cookie の付け替え・success |
| 2 | 回数の制限の応答と例外 |
| 3 | `provider` が無い・`google` 以外で 400 |
| 4 | POST の `next` の有り・無し・外れ（`//evil.example`）・型が文字列でない。GET の `redirect_to` は読まず、戻り先を作らない |
| 5 | 環境変数の `SUPABASE_URL` の有り・無し、どちらか欠けて 500 |
| 6 | Cookie の見出しが無い・`=` の無い項目・壊れた URL の値 |
| 7 | URL の生成の誤り・URL が無い時に 502 |
| 8 | client の作成が投げて 500 |
| 9 | POST で 200 `{ url }`・戻り先の Cookie・PKCE の Cookie があり、本文に番号が無く、`redirectTo` にクエリが無い |
| 10 | POST の本文が JSON でなくて 400、`provider` が `google` 以外で 400 |

### DD-AUTH-021 Google のログインの戻りの窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-008、ARC-AUTH-001、ARC-AUTH-010、FLOW-AUTH-002、DATA-AUTH-001、SEC-AUTH-026、SEC-AUTH-030、SEC-AUTH-032 |
| 根拠 | Google から戻った `code` をサーバーの中で session に替え、トークンを画面に渡さない（API-AUTH-008、FLOW-AUTH-002）。一般の会員は TOTP の画面を通さず戻り先か `/` へ送り、管理者とサポーターは `/auth/verified` で TOTP へ通す（DRV-AUTH-009）。送り先は入口で控えた戻り先だけで決め、`next` を読まない（SEC-AUTH-026、SEC-AUTH-032）。保存に失敗しても利用者を JSON で止めず 303 で進め、理由は監査に残す（SEC-AUTH-030） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/oauth/callback/route.ts`）、`docs/04_DetailDesign/sequence/auth-oauth.md` の SQ-AUTH-OAUTH-CALLBACK |
| 旧番号 | IMPL-OAUTH-002、IMPL-OAUTH-003、IMPL-OAUTH-004、IMPL-OAUTH-005、IMPL-OAUTH-006、IMPL-OAUTH-007、IMPL-OAUTH-008 |
| 旧所在 | `docs/04_DetailDesign/pages/14_login.md`（基準コミットの版）の「Google OAuth 実装 (AUTH-02)」の AUTH-02-AC-002〜008 の行 |

**対応要件 ID:** API-AUTH-008、ARC-AUTH-001・010、FLOW-AUTH-002、DATA-AUTH-001、SEC-AUTH-026・030・032（その上は FR-AUTH-005、FR-LOGIN-002、DRV-AUTH-009、FREQ-428-REQ-01（範囲外））

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `GET /api/auth/oauth/callback`。問い合わせの `code`（1文字以上）と PKCE の Cookie、`sb-return-intent` の Cookie。`next` は読まない。環境変数は DD-AUTH-020 と同じ |
| 出力 | 303 で戻り先か `/`（管理者・サポーターは `/auth/verified`）へ。`no-store`・`no-referrer`。ライブラリの Cookie と認証の Cookie。戻り先を使い切った時は戻り先の Cookie を消す |
| 出力の失敗 | 400（`code` が無い）、429（回数の制限の応答）、500（環境変数・例外）、502（交換の失敗・応答の形の誤り） |

**正常フロー:**

1. 住所を作り、IP 単位の制限（`auth:oauth:callback`、50回／600秒）を数える（`src/app/api/auth/oauth/callback/route.ts`）
2. 問い合わせの形を確かめる
3. PKCE の client を作り、`code` を session に替える
4. 応答の形（access・refresh token、利用者の id、メール）を確かめ、保存に渡す形に詰め直す
5. 既定の行き先を決める（admin・supporter は `/auth/verified`、一般は `/`）
6. 303 を作り、ライブラリの Cookie を付ける
7. ゲストのカート・お気に入りの印を添えてセッションを保存する
8. 保存に成功したら戻り先を使い切り（`resolveReturnDestination`、用途 `login`、DD-AUTH-034。管理者・サポーターは aal1 扱いで使い切らない）、`Location` を差し替えて戻り先の Cookie を消す
9. `auth.oauth.callback` の success を残す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 回数の制限が応答を返す・呼び出しが投げる | 返す・記録して進む（`src/app/api/auth/oauth/callback/route.ts`） |
| `code` が無い・空 | failure（`missing_code`）を残して 400 |
| `next`・`redirect_to` が付いている | 読まない |
| URL か anon の鍵が無い（`SUPABASE_URL` が無ければ公開の名前を使う） | error を残して 500 |
| 交換の誤り、または session か user が無い | failure（`token_exchange_failed`、誤りの文が無ければ `null`）を残して 502 |
| 応答の形が合わない | error（`invalid_token_response_shape`）を残して 502 |
| 役割が許可の3つに無い・無い | `user` とみなす |
| 一般で戻り先が使い切れた | 出口の確かめに通した戻り先 |
| 一般で戻り先の Cookie が無い・用途違い・期限切れ・使用済み・DB の失敗 | `/`。Cookie があれば消す |
| 管理者・サポーター | `/auth/verified`（戻り先は使い切らない。TOTP の後に `post-login` が使う） |
| 保存の結果が `ok` でない | error（理由が無ければ `unknown`）を残し、作った 303 を返す（戻り先は使い切らない） |
| 保存が投げる | error を残し、作った 303 を返す |
| 利用者のメールが無い | 監査は `null` |
| 要求の Cookie の読み方 | DD-AUTH-020 と同じ小さな関数（二重にある） |
| 例外 | error を残して 500 |

**状態・永続化:** 成功で `sessions` の行と認証の Cookie（共有の `persistSessionAndCookies`、DATA-AUTH-001）。ライブラリの session の Cookie を写した後も消さない（消すのはログアウト、DD-AUTH-028）。ゲスト注文の紐付けは呼ばない（メールの経路は呼ぶ）。戻り先を使い切る時は `private.auth_return_intents` を 1 行更新する（DATA-AUTH-005）。

**認証認可:** 公開の窓口。メールの確認コードの2段目を通らない（SEC-AUTH-008 の会員の部分は決めていない）。ライブラリの Cookie を HttpOnly にしない（SEC-AUTH-023 は満たさない。推定）。

**テスト観点:**（単体テストは無い。結合 `tests/integration/api/auth/oauth-callback.test.ts`（5。同じ名前のテストが2つある））

| # | 観点 |
| --- | --- |
| 1 | 一般の会員で戻り先が無ければ 303 `/`・Cookie・success |
| 2 | 管理者・サポーターなら `/auth/verified` で使い切らない。一般で戻り先があればその道へ 303 して Cookie を消す。古い `next` は無視する |
| 3 | 役割が無い・許可外 |
| 4 | 回数の制限の応答と例外 |
| 5 | `code` が無くて 400 |
| 6 | 環境変数が欠けて 500 |
| 7 | 交換の誤り（文の有り・無し）・session 無し・user 無しで 502 |
| 8 | 応答の形の誤りで 502 |
| 9 | 保存の結果が `ok` でない（理由の有り・無し）・保存が投げる |
| 10 | メールの無い利用者の success |
| 11 | Cookie の読み方の3つの道（DD-AUTH-020 の観点 6 と同じ） |
| 12 | client の作成が投げて 500 |

### DD-AUTH-022 パスワードの再設定の申請の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-009、ARC-AUTH-004、ARC-AUTH-005、ARC-AUTH-006、STATE-AUTH-002、DATA-AUTH-002、DATA-AUTH-003、SEC-AUTH-019 |
| 根拠 | パスワードを忘れた人の入口なのでログインを求められない。代わりに回数の制限と、アカウントの有無で応答を変えないことで濫用を止める（API-AUTH-009、ARC-AUTH-006）。アカウントが無い宛先には印もメールも作らず、店のドメインを第三者へのメールの踏み台にさせない（FREQ-319-REQ-02）。新しいリンクを出す時に前の印を使用済みにするが、最新の1本だけは保証しない（SEC-AUTH-018 は満たさない）。期限は 10 分（STATE-AUTH-002、ARC-AUTH-004）。リンクは許可した住所でだけ作る（SEC-AUTH-019） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/password-reset/request/route.ts`）、`docs/04_DetailDesign/sequence/auth-password-reset.md` の SQ-AUTH-RESET-REQUEST |
| 旧番号 | IMPL-AUTH-PWR-01 |
| 旧所在 | `docs/04_DetailDesign/pages/14_login.md`（基準コミットの版）の「実装フェーズ 完了状況」の AUTH-01-09 の行（「即時消費」の記述は今のコードと違う） |

**対応要件 ID:** API-AUTH-009、ARC-AUTH-004・005・006、STATE-AUTH-002、DATA-AUTH-002・003、SEC-AUTH-019（その上は FR-LOGIN-003、FREQ-319-REQ-01・02、FREQ-332-REQ-04）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `POST /api/auth/password-reset/request`。JSON の `email`（共有の `ResetRequestSchema` が空白を落として小文字にする）・`turnstileToken` |
| 出力 200 | `{ ok: true }`（アカウントの有無・住所の見張りによらない） |
| 出力の失敗 | 400（形）、403（Turnstile）、429（回数の制限の応答）、500（照会・保存の失敗・例外） |
| メール | アカウントが有る時だけ、応答の外で「Password reset」。リンクは `/auth/password-reset/verify?token=<印>`、本文に「10分間有効」 |

**正常フロー:**

1. IP 単位の制限（`auth:password_reset_request`、10回／3600秒）（`src/app/api/auth/password-reset/request/route.ts`）
2. 形を確かめる
3. Turnstile を確かめる
4. メール単位の制限（5回／3600秒）
5. 住所の見張り
6. service role の client でアカウントを引く
7. 有れば、同じ宛先の未使用の印を使用済みにし、32 バイトの乱数の印を作り、SHA-256 を期限 10 分で保存し、応答の外でメールを送る
8. `password_reset_request` の success（`no_account` か `mail_queued`）を残して 200

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| IP の制限が応答を返す・呼び出しが投げる | 返す・記録して進む（`src/app/api/auth/password-reset/request/route.ts`） |
| 形が合わない | 400 |
| `x-forwarded-for` が無い | Turnstile に `null` |
| Turnstile が通らない | failure（誤りの文、無ければ `turnstile_failed`）を残して 403 |
| メールの制限が応答を返す・呼び出しが投げる | 返す・記録して進む |
| 住所が許可の一覧に無い | 応答の外で運用へ知らせ、印もメールも作らずに同じ 200 |
| 照会が失敗 | error（`user_lookup_failed`）を残して 500 |
| アカウントが無い | 印もメールも作らず、`no_account` で 200 |
| 前の印を使用済みにするのが失敗 | 記録して続ける |
| 印の保存が失敗 | error（`token_persist_failed`）を残して 500。メールを送らない |
| メールの送信が失敗 | 記録だけ（応答は済んでいる） |
| 本文が JSON でない・例外 | 500 |

**状態・永続化:** `password_reset_tokens` に `user_id`・`email`・`token_hash`・`expires_at`（今から 10 分）・`used=false` の行を作り、同じ宛先の前の行を `used=true` にする（DATA-AUTH-002、STATE-AUTH-002）。生の印は DB に置かず、メールの URL にだけ入れる。全部 service role。

**認証認可:** 公開の窓口。アカウントが有る時だけ DB に書いてから返すので、応答の時間に差が出うる（SEC-AUTH-016 の時間は満たさない。推定）。

**テスト観点:**（単体テストは無い。結合 `tests/integration/api/auth/password-reset.test.ts` の申請の分・`site-url-guard.test.ts`）

| # | 観点 |
| --- | --- |
| 1 | アカウントありで 200・前の印の無効化・新しい印の保存・送信・`mail_queued` |
| 2 | アカウントなしで同じ 200・保存も送信もしない・`no_account` |
| 3 | IP とメールの制限の応答と例外 |
| 4 | 形の誤りで 400 |
| 5 | Turnstile の失敗（文の有り・無し）、`x-forwarded-for` の有り・無し |
| 6 | 住所の見張りで同じ 200・保存しない |
| 7 | 照会の失敗で 500 |
| 8 | 前の印の無効化の失敗で続ける |
| 9 | 保存の失敗で 500・送信しない |
| 10 | 送信の失敗を記録だけにする |
| 11 | 本文の壊れで 500 |

### DD-AUTH-023 再設定のリンクの確かめの窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-010、ARC-AUTH-004、STATE-AUTH-002、DATA-AUTH-002、DATA-AUTH-004、SEC-AUTH-030 |
| 根拠 | 企業のメールのリンクの検査は GET も JS つきの POST も踏むので、どちらでも印を消費しない（API-AUTH-010、ARC-AUTH-004、ADR-0403）。GET は確認の画面へ転送するだけ。POST は未使用かつ期限の内の行だけを有効とみなし、通ったら利用者・宛先・印の行を署名した 10 分の再設定の Cookie を出す（STATE-AUTH-002、DATA-AUTH-004）。利用者を引けなかっただけの時に「期限切れ」と言うと、まだ有効なリンクを捨てさせるので 500 にする（FREQ-319-REQ-04）。成否を監査に残す（SEC-AUTH-030） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/password-reset/link/route.ts`）、`docs/04_DetailDesign/sequence/auth-password-reset.md` の SQ-AUTH-RESET-LINK |

**対応要件 ID:** API-AUTH-010、ARC-AUTH-004、STATE-AUTH-002、DATA-AUTH-002・004、SEC-AUTH-030（その上は FREQ-319-REQ-03・04、FREQ-332-REQ-01・04、ADR-0403）

**入出力:**

| 向き | 中身 |
| --- | --- |
| GET の入力 | 問い合わせの `token` |
| GET の出力 | 303。有れば `/auth/password-reset/verify?token=<印>`、無ければ `/auth/password-reset?error=link_invalid`。`no-store`・`no-referrer` |
| POST の入力 | JSON の `token`（文字列でなければ無いとみなす） |
| POST の出力 200 | `{ ok: true, redirectTo: '/auth/password-reset' }` と再設定の Cookie `sb-password-reset-session`。`no-store`・`no-referrer` |
| POST の失敗 | 400 `link_invalid`（印が無い）・`link_expired`（行が無い・照会の誤り・利用者が居ない・例外）、429（回数の制限の応答）、500 `internal_error`（利用者の照会の失敗） |

**正常フロー（POST）:**

1. IP 単位の制限（`auth:password_reset_link`、20回／600秒）（`src/app/api/auth/password-reset/link/route.ts`）
2. 本文を読み、`token` が文字列か確かめる。JSON でなければ `null`
3. 印の SHA-256 で、未使用かつ期限の内の行を service role で引く
4. 行に利用者の id が無ければ、宛先のメールから引く
5. 200 と再設定の Cookie を作り、`password_reset_link` の success を残す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| GET で `token` が無い | failure（`missing_token`）を残して `?error=link_invalid` へ 303（`src/app/api/auth/password-reset/link/route.ts`） |
| GET で `token` がある | 確認の画面へ 303。印は確かめも消費もしない |
| POST で回数の制限が応答を返す・呼び出しが投げる | 返す・記録して進む |
| 本文が JSON でない、`token` が文字列でない・空 | failure（`missing_token`）を残して 400 `link_invalid` |
| 行の照会が誤り | error を残して 400 `link_expired` |
| 行が無い（使用済み・期限切れ・違う印） | failure（`invalid_or_expired_token`）を残して 400 `link_expired` |
| 行に利用者の id が無く、メールの照会が失敗 | error（`user_lookup_failed`）を残して 500 `internal_error` |
| 行に利用者の id が無く、メールのアカウントも無い | error（`user_not_found`）を残して 400 `link_expired` |
| 例外 | 400 `link_expired` |

**状態・永続化:** 行を読むだけで書かない。同じリンクから再設定の Cookie が何枚出ても、パスワードを変えられるのは確定の窓口で `used=false` を勝ち取った1つだけ（DD-AUTH-025）。再設定の Cookie の作り方と寿命は共有の `password-reset-session.ts`（10 分、SameSite=Strict）。

**認証認可:** 公開の窓口。印そのものが能力。GET には回数の制限が無い。

**テスト観点:**（単体テストは無い。結合 `tests/integration/api/auth/password-reset.test.ts` のリンクの分）

| # | 観点 |
| --- | --- |
| 1 | GET の `token` の有り・無し |
| 2 | POST の有効な印で 200・Cookie・success（行に利用者の id がある） |
| 3 | 行に利用者の id が無く、メールから引けて 200 |
| 4 | 回数の制限の応答と例外 |
| 5 | 本文が JSON でない・`token` が数字・空で 400 |
| 6 | 照会の誤り・行が無いで 400 |
| 7 | メールの照会の失敗で 500、アカウントが無くて 400 |
| 8 | 照会が投げて 400 |

### DD-AUTH-024 再設定の Cookie の状態の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-011、STATE-AUTH-004、DATA-AUTH-004 |
| 根拠 | 再設定のページは HttpOnly の Cookie を読めないので、新しいパスワードの見せ方にするかを窓口が答える（API-AUTH-011、STATE-AUTH-004）。新しいパスワードの見せ方ではメールの欄を出さないので、宛先は窓口が返す（FREQ-333-REQ-04）。無効な Cookie はその場で消し、次の読み込みで同じ判定を繰り返させない（DATA-AUTH-004） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/password-reset/session/route.ts`）、`docs/04_DetailDesign/sequence/auth-password-reset.md` の SQ-AUTH-RESET-RESUME |

**対応要件 ID:** API-AUTH-011、STATE-AUTH-004、DATA-AUTH-004（その上は FREQ-332-REQ-02、FREQ-333-REQ-04）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `GET /api/auth/password-reset/session`。再設定の Cookie |
| 出力 | いつも 200、`no-store`。有効なら `{ ready: true, email }`、無効なら `{ ready: false, email: null }` と Cookie の消去（寿命 0） |

**正常フロー:**

1. Cookie の見出しから再設定の印を読む（共有の `readPasswordResetSessionFromCookieHeader`）（`src/app/api/auth/password-reset/session/route.ts`）
2. 結果で本文を決め、`no-store` を付ける
3. 無効なら Cookie を消す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 印が有効 | `ready: true` と宛先（`src/app/api/auth/password-reset/session/route.ts`） |
| 印が無い・署名の誤り・期限切れ | `ready: false` と Cookie の消去 |

**状態・永続化:** DB を読まない。印の有効は署名と期限だけで決まり、行がまだ未使用かは確定の窓口が見る。

**認証認可:** 公開の窓口。回数の制限が無い。宛先は印を持つ人にだけ返す。

**テスト観点:**（単体テストは無い。結合 `tests/integration/api/auth/password-reset.test.ts`）

| # | 観点 |
| --- | --- |
| 1 | 有効な印で `ready: true`・宛先・`no-store`、Cookie を消さない |
| 2 | 印が無くて `ready: false`・Cookie の消去 |

### DD-AUTH-025 再設定の確定の窓口（新しいパスワードに変える）

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-012、ARC-AUTH-004、ARC-AUTH-007、STATE-AUTH-002、DATA-AUTH-001、DATA-AUTH-002、DATA-AUTH-003、SEC-AUTH-014、SEC-AUTH-018 |
| 根拠 | 印の消費をパスワードを変える直前まで遅らせ、`used=false` を条件に勝ち取った1つだけを通す（API-AUTH-012、STATE-AUTH-002、SEC-AUTH-018、ADR-0403）。署名した Cookie だけを能力にせず、行がまだ未使用かも確かめる。漏洩の照合は印を確かめた後に置き、偽の印で外の API を叩かせない（ARC-AUTH-007、SEC-AUTH-014、ADR-0405）。変えた後は乗っ取った人のセッションを残さないよう、自前と Supabase の全部を切り、この端末の認証の Cookie も消して本人に知らせる（FREQ-319-REQ-05、DATA-AUTH-001・003） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/password-reset/confirm/route.ts`）、`docs/04_DetailDesign/sequence/auth-password-reset.md` の SQ-AUTH-RESET-CONFIRM |

**対応要件 ID:** API-AUTH-012、ARC-AUTH-004・007、STATE-AUTH-002、DATA-AUTH-001・002・003、SEC-AUTH-014・018（その上は FREQ-319-REQ-03・05、FREQ-323-REQ-01〜03、ADR-0403・0405）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `POST /api/auth/password-reset/confirm`。JSON の `new_password`（共有の `ResetSessionConfirmSchema`。16 文字はここ。確認の欄の値は受けない）と再設定の Cookie |
| 出力 200 | `{ ok: true }`。再設定・access・refresh・CSRF の Cookie を消す |
| 出力の失敗 | 400（Cookie が無い・形・漏洩・行が無いか使用済み・勝ち取りに負けた。どれも `Invalid or expired reset session` か形・漏洩の文）、429（回数の制限の応答）、500（照会・勝ち取り・更新の失敗・例外） |
| メール | 応答の外で「パスワードを変更しました」（パスワードは本文に入れない） |

**正常フロー:**

1. IP 単位の制限（`auth:password_reset_confirm`、10回／3600秒）（`src/app/api/auth/password-reset/confirm/route.ts`）
2. 再設定の Cookie を読む
3. 本文の形を確かめる
4. Cookie の印の行が未使用かを service role で引く。期限は見ない
5. 漏洩の照合
6. `used=false` を条件に `used=true` へ更新し、1行を勝ち取る
7. service role の `updateUserById` でパスワードを変える
8. 行を消す
9. 自前の `sessions` の `revoked_at` と DB の関数 `revoke_auth_sessions_for_user` で全部のセッションを切る
10. 4つの Cookie を消し、応答の外で通知を送り、success を残して 200

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 回数の制限が応答を返す・呼び出しが投げる | 返す・記録して進む（`src/app/api/auth/password-reset/confirm/route.ts`） |
| 再設定の Cookie が無い・無効 | failure（`missing_reset_session`）を残して 400。本文を読まない |
| 形が合わない | 400 |
| 行の照会が誤り | error（`token_lookup_failed`）を残して 500 |
| 行が無い（使用済み・消えた） | failure（`invalid_or_consumed_token`）を残して 400 |
| 漏洩に当たる | failure（`pwned_password`）を残して 400。印は焼かない |
| 照合先が使えない | error（`pwned_check_unavailable`）を残して続ける |
| 勝ち取りの更新が誤り | error（`token_claim_failed`）を残して 500 |
| 勝ち取りに負けた（0行） | failure（`token_already_consumed`）を残して 400 |
| パスワードの更新が誤り | error を残して 500。印は使用済みのまま戻らない（推定） |
| 行の削除が誤り | 記録して続ける |
| 自前のセッションの失効が誤り | 記録して続ける（監査に残さない） |
| Supabase のセッションの失効が誤り | 記録して続ける（監査に残さない） |
| 通知の送信が失敗 | 記録だけ |
| 本文が JSON でない・例外 | 500 |

**状態・永続化:** `password_reset_tokens` の行を勝ち取って消す（STATE-AUTH-002、DATA-AUTH-002）。`sessions` の利用者の全行に `revoked_at` を付け、`auth.sessions` を DB の関数で消す（DATA-AUTH-001・003）。全部 service role。

**認証認可:** 公開の窓口。署名した Cookie と未使用の行の両方を能力にする。失効の失敗は成功で返し監査に残さない（SEC-AUTH-020 の失敗の監査は満たさない）。

**テスト観点:**（単体テストは無い。結合 `tests/integration/api/auth/password-reset.test.ts` の確定の分・`tests/integration/api/auth.test.ts`）

| # | 観点 |
| --- | --- |
| 1 | 有効な Cookie と行で 200・更新・行の削除・全部の失効・4つの Cookie の消去・通知・success |
| 2 | 回数の制限の応答と例外 |
| 3 | Cookie が無くて 400、本文を読まない |
| 4 | 形の誤り（15 文字）で 400 |
| 5 | 行の照会の誤りで 500、行が無くて 400 |
| 6 | 漏洩で 400・印を焼かない、照合先が使えない時に続ける |
| 7 | 勝ち取りの誤りで 500、負けて 400 |
| 8 | 更新の誤りで 500 |
| 9 | 行の削除・自前の失効・Supabase の失効の誤りでも 200 |
| 10 | 通知の送信の失敗を記録だけにする |
| 11 | 本文の壊れで 500 |

### DD-AUTH-026 ログインの状態を答える窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-013、ARC-AUTH-009、SEC-AUTH-028 |
| 根拠 | 画面の出し分けと窓口の認可の答えがずれないよう、共有の `authenticateRequest` で失効まで確かめ、aal2 も管理の認可と同じ JWT の `aal` で答える（API-AUTH-013、ARC-AUTH-009）。DB の一時の障害で全員をログアウトの見た目に落とさないよう、確かめられない時だけ 503 にして画面に前の状態を保たせる（ADR-0408、FREQ-324（範囲外））。役割は JWT の `app_metadata` からだけ読み、知らない値は `user` にする（SEC-AUTH-028）。全部の応答に `no-store`・`no-referrer` を1か所で付け、分岐を足した時の抜けを防ぐ |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/me/route.ts`）、`docs/04_DetailDesign/sequence/auth-session.md` の SQ-AUTH-SESSION-ME |

**対応要件 ID:** API-AUTH-013、ARC-AUTH-009、SEC-AUTH-028（その上は DRV-AUTH-007、ADR-0408、FREQ-324-REQ-03（範囲外））

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `GET /api/auth/me`。Bearer か access の Cookie（読み方は共有の `authenticateRequest`） |
| 出力 200 | ログイン中なら `{ authenticated: true, user: { id, role, mfaVerified } }`（メールの住所は返さない。2026-10-26）、未ログイン・失効・例外なら `{ authenticated: false }` |
| 出力 503 | `{ authenticated: false, reason: 'unavailable' }`、`Retry-After: 30` |
| 見出し | 全部の応答に `Cache-Control: no-store`・`Referrer-Policy: no-referrer`（`src/app/api/auth/me/route.ts`） |

**正常フロー:**

1. 共有の `authenticateRequest` で JWT と失効を確かめる（`src/app/api/auth/me/route.ts`）
2. 役割を `app_metadata.role` から読み、許可の3つでなければ `user`
3. `mfaVerified` を `aal === 'aal2'` で決める
4. 200 で返す。`user` は `id`・`role`・`mfaVerified` だけで、メールのクレームは返さない

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 確かめが通らず、理由が `unavailable` | 503 と `Retry-After: 30`（`src/app/api/auth/me/route.ts`） |
| 確かめが通らず、ほかの理由（無い・無効・失効） | 200 `{ authenticated: false }` |
| 役割が admin・supporter・user のどれか | その役割 |
| 役割が無い・ほかの値 | `user` |
| `aal` が `aal2` | `mfaVerified: true`、ほかは `false` |
| メールのクレームがある・無い | どちらも応答の `user` にメールの項目は無い |
| 例外 | 記録して 200 `{ authenticated: false }` |

**状態・永続化:** 書かない。失効の確かめは共有部品が DB の関数 `is_auth_session_active` を呼ぶ（DATA-AUTH-003）。

**認証認可:** ログインを求めない（答えるのはログインの有無）。回数の制限が無い。期限切れの token にも 200 を返すので、呼び手の画面からは refresh が起きない（`docs/04_DetailDesign/sequence/auth-session.md` の SQ-AUTH-SESSION-ME）。

**テスト観点:**（単体 `tests/unit/api/auth/me-route.test.ts`、結合 `tests/integration/api/auth/me.test.ts`）

| # | 観点 |
| --- | --- |
| 1 | 確かめが通り、役割 admin・aal2 で `mfaVerified: true` |
| 2 | 役割が無い・知らない値で `user`、aal1 で `false` |
| 3 | メールのクレームがあっても無くても、`user` のキーは `id`・`role`・`mfaVerified` ちょうどで、メールの字が応答に無い |
| 4 | 理由が `unavailable` で 503・`Retry-After`・`no-store`・`no-referrer` |
| 5 | 理由がほかで 200 `{ authenticated: false }` |
| 6 | 確かめが投げて 200 `{ authenticated: false }` |
| 7 | `isUserRole` の3つの値と、それ以外 |

### DD-AUTH-027 トークンの更新の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-014、ARC-AUTH-009、DATA-AUTH-001、DATA-AUTH-004、SEC-AUTH-022、SEC-AUTH-030 |
| 根拠 | access token の寿命が短いので、ログインしたままの利用者を切らずに新しいトークンへ替える（API-AUTH-014、ARC-AUTH-009）。門番は Supabase のトークンの交換にし、自前の表は明示の失効の印がある時だけ断る。行が無いだけで断ると取りこぼしで正しい利用者を締め出す（ADR-0406、DATA-AUTH-001）。交換に失敗した Cookie を残すと更新の失敗が続くので消す（DATA-AUTH-004）。行の保存に失敗しても発行済みのトークンは配る。前の refresh token はもう使えないので、500 にすると利用者が死んだトークンだけを持つ（`src/app/api/auth/refresh/route.ts`）。成否を監査に残す（SEC-AUTH-030） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/refresh/route.ts`）、`docs/04_DetailDesign/sequence/auth-session.md` の SQ-AUTH-SESSION-REFRESH |
| 旧番号 | IMPL-AUTH-REFRESH-01 |
| 旧所在 | `docs/04_DetailDesign/pages/14_login.md`（基準コミットの版）の「実装フェーズ 完了状況」の AUTH-01-07 の行（JTI の回転の記述は今のコードと違う） |

**対応要件 ID:** API-AUTH-014、ARC-AUTH-009、DATA-AUTH-001・004、SEC-AUTH-022・030（その上は DRV-AUTH-008、ADR-0406）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `POST /api/auth/refresh`。Cookie `sb-refresh-token`。環境変数 `SUPABASE_URL`（無ければ `NEXT_PUBLIC_SUPABASE_URL`）・`SUPABASE_SERVICE_ROLE_KEY` |
| 出力 200 | `{ ok: true }` だけ（トークンも利用者の記録も本文に載せない）。新しい認証の Cookie（共有の `persistNewSession`） |
| 出力の失敗 | 401（Cookie が無い `No refresh token`、失効の印 `Session revoked`、交換の失敗 `Failed to refresh token`。後の2つは refresh・access・CSRF の Cookie を消す）、429（回数の制限の応答）、500（環境変数・例外） |

**正常フロー:**

1. IP 単位の制限（`auth:refresh`、30回／600秒）（`src/app/api/auth/refresh/route.ts`）
2. refresh の Cookie を読む
3. 自前の `sessions` の行を refresh token のハッシュで引く。無くても続ける
4. 失効の印が無いことを確かめる
5. Supabase Auth の `/auth/v1/token?grant_type=refresh_token` を service role の鍵で呼ぶ
6. 応答から新しい access・refresh token と利用者を取り、本文が `{ ok: true }` の 200 を作る
7. 共有の `persistNewSession` で Cookie と行を差し替え、success を残す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 回数の制限が応答を返す・呼び出しが投げる | 返す・記録して進む（`src/app/api/auth/refresh/route.ts`） |
| refresh の Cookie が無い | 401。Cookie を消さない |
| 自前の行が無い | 警告を記録して続ける |
| 行に `revoked_at` がある | failure（`session_revoked`）を残し、3つの Cookie を消して 401 |
| URL か service role の鍵が無い | 500。監査に残さない |
| 交換の応答が成功でない | failure（`supabase_refresh_failed`、応答の状態を添える）を残し、3つの Cookie を消して 401 |
| 自前の行が無い時の利用者の id | 交換の応答の利用者の id を使う。前の行の id は `null` |
| 行の差し替えが投げる | error を残して 200 をそのまま返す |
| 例外（交換の応答が JSON でないなど） | 500 |

**状態・永続化:** 新しい `sessions` の行を作り、前の行を失効させるのは共有の `persistNewSession`（DATA-AUTH-001）。access・refresh・CSRF の Cookie を差し替える（DATA-AUTH-004）。

**認証認可:** 公開の窓口で、refresh の Cookie が根拠。応答の本文に access token と Supabase の利用者の記録を入れない（SEC-AUTH-022 の本文の部分。2026-10-26）。`no-store` は波 3。呼ぶのは共有の `client-fetch`（401 の時だけ、FREQ-316）。

**テスト観点:**（単体 `tests/unit/api/auth/refresh-route.test.ts`。結合 `tests/integration/api/auth/refresh.test.ts`・`cookieFlags.test.ts`・`tests/integration/auth-flow.test.ts`）

| # | 観点 |
| --- | --- |
| 1 | 行があり交換が成功で 200・差し替え・success |
| 2 | 行が無くても交換が成功で 200、利用者の id は応答から |
| 3 | 回数の制限の応答と例外 |
| 4 | Cookie が無くて 401 |
| 5 | 失効の印で 401・Cookie の消去・failure |
| 6 | `SUPABASE_URL` の有り・無し、鍵が欠けて 500 |
| 7 | 交換の失敗で 401・Cookie の消去 |
| 8 | 差し替えが投げても 200・error の監査 |
| 9 | 交換の応答が JSON でなくて 500 |
| 10 | 成功の本文が `{ ok: true }` ちょうどで、`access_token`・`refresh_token`・`app_metadata` の字が無い（Cookie には出る） |

### DD-AUTH-028 ログアウトの窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-015、ARC-AUTH-009、DATA-AUTH-001、DATA-AUTH-003、DATA-AUTH-004、SEC-AUTH-032 |
| 根拠 | 共有の端末や盗まれた refresh token で、ログアウトの後もログインを続けさせない。access token が期限切れでも署名を確かめた JWT の `session_id` でその1本を切り、取れなければ自前の行の利用者の全部を切る（ADR-0407、DATA-AUTH-003）。401 だと「まだ有効なセッション」を漏らすので常に 200 にし、CSRF の拒否でも Cookie は必ず消す（API-AUTH-015、FREQ-514（範囲外））。Google のログインでライブラリが書いた Cookie も消さないと、再読み込みで SSR が読み直してログアウトが効かない（DATA-AUTH-004）。この端末のゲストのカート・お気に入りの印も消す（FREQ-431（範囲外）） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/logout/route.ts`）、`docs/04_DetailDesign/sequence/auth-session.md` の SQ-AUTH-SESSION-LOGOUT |
| 旧番号 | IMPL-AUTH-LOGOUT-01 |
| 旧所在 | `docs/04_DetailDesign/pages/14_login.md`（基準コミットの版）の「実装フェーズ 完了状況」の AUTH-01-08 の行 |

**対応要件 ID:** API-AUTH-015、ARC-AUTH-009、DATA-AUTH-001・003・004（その上は FREQ-320-REQ-02、ADR-0407、FREQ-514-REQ-01（範囲外）、FREQ-431-REQ-01（範囲外））。refresh の Cookie が無い時に切らないのは SEC-AUTH-021 を満たさない

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `POST /api/auth/logout`。本文は読まない。Cookie の refresh token・CSRF の印（見出しと Cookie の二重送信、共有の `requireCsrfOrDeny` が読む）・access token（共有の `verifyAccessToken` が期限切れも許して読む） |
| 出力 200 | いつも `{ ok: true }`。`session_id`・refresh・access・CSRF・保留・再設定・戻り先（`sb-return-intent`）・カート・お気に入りの Cookie と、名前が `sb-…-auth-token`（後ろに `.数字` が付く物も）のライブラリの Cookie を消す |
| 出力 500 | 応答を作る所の例外だけ |

**正常フロー:**

1. refresh の Cookie を読む（`src/app/api/auth/logout/route.ts`）
2. 有れば、service role の client を作り、refresh token の SHA-256 を作り、CSRF を確かめる
3. CSRF が通れば、自前の行に `revoked_at` を付けて利用者の id を取り、Supabase のセッションを切る
4. Supabase のセッションを切る手順: JWT の `session_id` が取れれば `revoke_auth_session` で1本を切る。だめなら行の利用者で `revoke_auth_sessions_for_user` を呼び、全部を切ったことを success で残す
5. 200 を作り、印の回転が返っていれば新しい CSRF の Cookie を置く
6. 9つの Cookie を消す
7. ライブラリの Cookie を名前の形で探して消す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| refresh の Cookie が無い | サーバーのセッションに触れず、Cookie を消して 200（`src/app/api/auth/logout/route.ts`） |
| CSRF が断る（`Response` が返る。403 か照合の失敗の 500） | 行もセッションも切らず、Cookie を消して 200 |
| JWT が確かめられ `session_id` がある、関数が成功 | その1本を切って終わる |
| `revoke_auth_session` が誤り | 記録して、利用者の全部を切る道へ |
| JWT が確かめられない・`session_id` が無い | 利用者の全部を切る道へ |
| 更新した行が無い（利用者の id が取れない） | error（`auth_session_not_identified`）を残して終わる |
| `revoke_auth_sessions_for_user` が誤り | error（`auth_session_revocation_failed`）を残して終わる |
| `revoke_auth_sessions_for_user` が成功 | success（`revoked_all_sessions_session_id_unavailable`）を残す |
| 2〜4 のどこかが投げる | 記録して、Cookie を消して 200 |
| 回転した CSRF の印が返る | CSRF の Cookie に置く。ただし直後の消去の一覧にも CSRF の Cookie があり、後の書き込みで消える（推定） |
| 名前が `sb-…-auth-token` の形の Cookie がある | 消す。形が違えば残す |
| 応答を作る所の例外 | 500 |

**状態・永続化:** `sessions` の行に `revoked_at` を付ける（DATA-AUTH-001）。`auth.sessions` を DB の関数で消す（DATA-AUTH-003）。会員のカート・お気に入りはサーバーに残る。

**認証認可:** ログインを求めない（未ログインでも 200）。CSRF の印を共有の proxy の Origin に重ねる。NEWS の ADR-0019（範囲外）の「窓口で印を重ねない」と方針が違う。回数の制限が無い。

**テスト観点:**（単体 `tests/unit/api/auth/logout-guest-shopping.test.ts`（3）がカート・お気に入りの Cookie の消去を見る。結合 `tests/integration/api/auth/logout.test.ts`（5）・`csrf.test.ts`（2））

| # | 観点 | 今の単体テスト |
| --- | --- | --- |
| 1 | refresh の Cookie が無くても 200・9つの Cookie の消去（戻り先の Cookie を含む） | 在る（戻り先の分を足す） |
| 2 | CSRF が通り `session_id` で1本を切る | 無い |
| 3 | CSRF が断っても 200・Cookie の消去・行に触れない | 無い |
| 4 | `revoke_auth_session` が誤りで全部を切る道へ | 無い |
| 5 | `session_id` が無く、行の利用者で全部を切って success | 無い |
| 6 | 行が無くて `auth_session_not_identified` | 無い |
| 7 | 全部を切るのが誤りで `auth_session_revocation_failed` | 無い |
| 8 | service role の client の作成などが投げても 200 | 無い |
| 9 | 回転の印の有り・無し | 無い |
| 10 | ライブラリの Cookie の名前の形の一致・不一致（`.数字` 付きも） | 無い |
| 11 | 応答を作る所が投げて 500 | 無い |
| 12 | ゲストのカート・お気に入りの Cookie を消す | 在る |

### DD-AUTH-029 TOTP の状態の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-016、ARC-AUTH-003、SCR-AUTH-007 |
| 根拠 | `/auth/verified` が TOTP を登録させるか確認させるかを決めるため、確かめ済みの要素の有無を答える（API-AUTH-016、SCR-AUTH-007）。役割は自分のアカウントの見せ方の判断にしか使わず、管理の機能への出入りは共有の `admin-rbac` が DB の ACL で別に決めるので、JWT のクレームから読む（ARC-AUTH-003、ADR-0409） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/mfa/status/route.ts`）、`docs/04_DetailDesign/sequence/auth-login-mfa.md` の SQ-AUTH-MFA-STATUS |

**対応要件 ID:** API-AUTH-016、ARC-AUTH-003、SCR-AUTH-007（その上は FR-LOGIN-007、ADR-0409）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `GET /api/auth/mfa/status`。Bearer か access の Cookie |
| 出力 200 | `{ data: { role, isPrivileged, currentLevel, nextLevel, hasVerifiedFactor, needsChallenge, factors } }`。`factors` は TOTP と電話の確かめ済みの要素の `id`・`factorType`・`friendlyName` |
| 出力の失敗 | 共有の `authFailureResponse` の応答（401・503 など）、500（AAL・一覧の失敗・例外） |

**正常フロー:**

1. 利用者の session の client を作り、共有の `authenticateRequest` で確かめる（`src/app/api/auth/mfa/status/route.ts`）
2. 役割をクレームから読み、admin・supporter なら特権とする
3. AAL と要素の一覧を並べて引く
4. TOTP と電話の要素から確かめ済みの物を選び、要るかどうかを決めて返す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 確かめが通らない | 共有部品の失敗の応答（`src/app/api/auth/mfa/status/route.ts`） |
| 役割が許可の3つに無い | `user` |
| AAL の誤り | 500 |
| 一覧の誤り | 500 |
| TOTP・電話の一覧が無い | 空とみなす |
| 確かめ済みの要素がある | `hasVerifiedFactor: true` |
| AAL の今・次が無い | `null` |
| 特権かつ確かめ済みがあり、次が aal2 で今が aal2 でない | `needsChallenge: true`（4つの条件の論理積） |
| 要素の名前が無い | `null` |
| 例外 | 500 |

**状態・永続化:** 書かない。読むのは Supabase Auth の要素と AAL だけ。

**認証認可:** ログインした利用者だけ。一般の会員にも答える（特権の判定は答えの中身）。回数の制限が無い。`no-store` を付けない。画面が使うのは `hasVerifiedFactor` と `factors` だけで、ほかの欄は使われない（`src/app/auth/verified/page.tsx`）。

**テスト観点:**（単体テストも結合テストも無い）

| # | 観点 |
| --- | --- |
| 1 | 管理者で確かめ済みの TOTP があり aal1→aal2 で `needsChallenge: true` |
| 2 | 一般の会員で `isPrivileged: false`・`needsChallenge: false` |
| 3 | 要素が無い・未確認だけで `hasVerifiedFactor: false` |
| 4 | 今が aal2 で `needsChallenge: false`、次が aal1 で `false` |
| 5 | TOTP・電話の一覧が無い、AAL の値が無い、名前が無い |
| 6 | 確かめが通らず共有部品の応答 |
| 7 | AAL の誤り・一覧の誤りで 500 |
| 8 | 役割の3つの値とそれ以外 |
| 9 | client の作成が投げて 500 |

### DD-AUTH-030 TOTP の登録の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-017、ARC-AUTH-003、SCR-AUTH-007、SEC-AUTH-030、SEC-AUTH-031 |
| 根拠 | 管理者とサポーターが TOTP を使えるよう、認証アプリに読ませる QR と秘密を作る。一般の会員には作らせない（API-AUTH-017、ARC-AUTH-003）。確かめ済みの要素がある時は作り直さず、QR を出し直すには今の要素で aal2 を通った後にさせる（乗っ取った人に QR を取り直させない）。前の登録の途中で残った未確認の要素は外してから作る（SCR-AUTH-007 の自動の登録）。役割は JWT のクレームから読む（ADR-0409） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/mfa/enroll-totp/route.ts`）、`docs/04_DetailDesign/sequence/auth-login-mfa.md` の SQ-AUTH-MFA-ENROLL |

**対応要件 ID:** API-AUTH-017、ARC-AUTH-003、SCR-AUTH-007、SEC-AUTH-030・031（その上は FR-LOGIN-007、ADR-0409）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `POST /api/auth/mfa/enroll-totp`。Bearer か access の Cookie。JSON の `forceReEnroll`（任意の真偽。本文が JSON でなければ空とみなす。画面は送らない） |
| 出力 200 | `{ data: { factorId, friendlyName, qrCode, secret, uri } }`。`qrCode` は SVG の文字なら data URI に整える |
| 出力の失敗 | 400（形）、403（一般の会員・2 段目を通っていない通行証・確かめ済みがあり作り直しを求めた・`insufficient_aal`）、409（確かめ済みがある・名前の衝突）、429（回数の制限の応答）、500（一覧・登録の失敗・例外）、共有部品の失敗の応答 |

**正常フロー:**

1. IP 単位の制限（`auth:mfa:enroll-totp`、10回／600秒）（`src/app/api/auth/mfa/enroll-totp/route.ts`）
2. 利用者の session の client を作り、本文の形を確かめる
3. 共有の `authenticateRequest` で確かめ、役割が admin・supporter か見る
4. 通行証の `amr` に 2 段目を通った方法があることを共有の `hasSecondFactorAmr` で確かめる
5. 要素の一覧を引き、確かめ済みの TOTP が無いことを確かめる
6. 未確認の TOTP があれば外し、`mfa_factor_remove` を残す
7. TOTP を登録し、`mfa_enroll` の success を残して、QR を整えて返す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 回数の制限が応答を返す・呼び出しが投げる | 返す・記録して進む（`src/app/api/auth/mfa/enroll-totp/route.ts`） |
| 本文が JSON でない | 空の本文として確かめる |
| `forceReEnroll` が真偽でない | 400 |
| 確かめが通らない | 共有部品の失敗の応答 |
| 役割が admin・supporter でない（無い・知らない値は `user`） | 403。`mfa_enroll` の監査は書かない |
| `amr` に 2 段目の方法が無い（`password` だけ・`amr` が無い・空） | 403。`mfa_enroll` の denied（`second_factor_required`）を残す。要素の一覧も登録もしない |
| 一覧の誤り | 500 |
| 確かめ済みの TOTP があり、作り直しを求めない | 409 と今の要素の id・種類・名前（名前が無ければ `null`） |
| 確かめ済みの TOTP があり、作り直しを求めた | 403（aal2 で再設定するよう案内）。外して作り直しはしない |
| TOTP の一覧が無い | 空とみなす |
| 未確認の TOTP がある | 外す（誤りは登録を止めない）。`mfa_factor_remove`（外せたら success、誤りなら failure）を残す |
| 作り直しを求めた（確かめ済みが無い時） | 名前に `Admin TOTP` と時刻を付けて登録 |
| 登録の誤り・データが無い、符号が `insufficient_aal` | 403 |
| 登録の誤り、符号が `mfa_factor_name_conflict` | 409 |
| 登録のほかの誤り | 500 |
| QR が空・data URI・SVG・ほか | そのまま・そのまま・data URI に整える・そのまま |
| 登録の名前が無い | `null` |
| 例外 | 500 |

**状態・永続化:** Supabase Auth に TOTP の要素（未確認）を作る。確認は DD-AUTH-031。

**認証認可:** 管理者・サポーターだけ。秘密を登録の応答にだけ入れ、`no-store` を付けない（SEC-AUTH-022 の no-store は波 3）。成否を監査に残す（SEC-AUTH-030。2026-10-26）。通行証の `amr` に 2 段目を通った方法（`otp`・`magiclink`・`totp`・`oauth`・`sso/saml`・`email/signup`）が無ければ断る（SEC-AUTH-031 の局所の守り。2026-10-26）。残る穴: Supabase Auth へ OTP だけを直接送って得た通行証は通る・本人へのメールの通知が無い（波 5）。本物の通行証の `amr` の値は未実測（`magiclink` を数えるのはそのため）。

**テスト観点:**（単体 `tests/unit/api/auth/mfa-enroll-totp-route.test.ts`。結合 `tests/integration/api/auth-mfa-enroll-totp-api.test.ts`・`auth-admin-totp-flow.test.ts`）

| # | 観点 |
| --- | --- |
| 1 | 管理者で要素が無く、登録して 200・SVG の QR を data URI に |
| 2 | 回数の制限の応答と例外 |
| 3 | 本文が JSON でない、`forceReEnroll` が文字で 400 |
| 4 | 確かめが通らない |
| 5 | 一般の会員・役割が無い時に 403、supporter で通る |
| 6 | 一覧の誤りで 500 |
| 7 | 確かめ済みがあり 409（名前の有り・無し）、作り直しを求めて 403 |
| 8 | TOTP の一覧が無い |
| 9 | 未確認の要素を外してから登録 |
| 10 | 作り直しを求めて名前つきで登録 |
| 11 | 登録の誤り `insufficient_aal`・`mfa_factor_name_conflict`・ほか・データ無し |
| 12 | QR が空・data URI・SVG・ほかの文字 |
| 13 | 登録の名前が無い |
| 14 | client の作成が投げて 500 |
| 15 | `amr` が `password` だけ・空・無しの通行証は 403 で、登録せず denied を残す。`otp`・`magiclink`・`totp`・`oauth`・`sso/saml`・`email/signup` のどれかがあれば通る |
| 16 | 登録の成功が success（`totp_factor_enrolled`）で残り、秘密を含まない。未確認の要素の取り外しは `mfa_factor_remove` で、`enroll` の字を含む action は `mfa_enroll` だけ |

### DD-AUTH-031 TOTP の確認の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-018、ARC-AUTH-003、SCR-AUTH-007、DATA-AUTH-001、DATA-AUTH-004、SEC-AUTH-008、SEC-AUTH-009、SEC-AUTH-030 |
| 根拠 | 管理画面に入る前の3段目（API-AUTH-018、ARC-AUTH-003）。確認が通ると Supabase が aal2 のトークン対を返すので、Cookie と `sessions` の行に書き戻さないと管理の窓口の aal2 の判定を通れない（DATA-AUTH-001・004）。Google でログインした管理者もここで aal2 になる（SEC-AUTH-008 の管理の部分）。書き戻しの保存が失敗しても、aal2 はトークン自体が持つので配る（`src/app/api/auth/mfa/verify/route.ts`）。役割は JWT のクレームから読む（ADR-0409） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/auth/mfa/verify/route.ts`）、`docs/04_DetailDesign/sequence/auth-login-mfa.md` の SQ-AUTH-MFA-VERIFY |

**対応要件 ID:** API-AUTH-018、ARC-AUTH-003、SCR-AUTH-007、DATA-AUTH-001・004、SEC-AUTH-008・009・030（その上は FR-LOGIN-007、ADR-0409）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `POST /api/auth/mfa/verify`。Bearer か access の Cookie、refresh の Cookie。JSON の `factorId`（UUID）・`code`（6〜8桁の数字） |
| 出力 200 | `{ data: { role, currentLevel, nextLevel, verified: true } }` と aal2 の認証の Cookie |
| 出力の失敗 | 400（形の文をつないだ物・チャレンジの失敗・コードの誤り）、403（一般の会員）、404（要素が無い）、429（IP か利用者単位の回数の制限の応答）、500（例外）、共有部品の失敗の応答 |

**正常フロー:**

1. IP 単位の制限（`auth:mfa:verify`、20回／600秒）（`src/app/api/auth/mfa/verify/route.ts`）
2. 本文の形を確かめる
3. 利用者の session の client を作り、確かめる
4. 利用者単位の制限（`auth:mfa:verify`、5回／600秒、`subject` は検証済みの `claims.sub`）を数える。役割の確認より前
5. 役割を見る
6. チャレンジを作り、コードを確かめる
7. AAL を読み直し、200 を作る
8. 前の refresh の Cookie と、その行を引く
9. 共有の `persistNewSession` で aal2 のトークン対を Cookie と行に書き戻し、`mfa_verify` の success（`verified`）を残す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 回数の制限が応答を返す・呼び出しが投げる | 返す・記録して進む（`src/app/api/auth/mfa/verify/route.ts`） |
| 本文が JSON でない・形が合わない | 形の文をつないで 400 |
| 確かめが通らない | 共有部品の失敗の応答。利用者単位の制限は数えない（`sub` が無い） |
| 利用者単位の制限が応答を返す | `mfa_verify` の failure（`account_rate_limited`）を残してその応答（429）を返す。チャレンジを作らない |
| 利用者単位の制限の呼び出しが投げる | 記録して進む |
| 役割が admin・supporter でない | 403 |
| チャレンジの誤り・データが無く、文に `not found` | `mfa_verify` の failure（`factor_not_found`）を残して 404 |
| チャレンジのほかの誤り（文が無い時を含む） | failure（`challenge_failed`）を残して 400 |
| コードの誤り | failure（`invalid_code`）を残して 400。コードと誤りの文は残さない |
| AAL の読み直しが誤り | 記録して続け、今・次は `null` |
| 前の refresh の Cookie が無い | 前の行を引かない |
| 前の行が無い | 前の行の id は `null` |
| 書き戻しが投げる | `mfa_verify` の error（`session_persist_failed`。誤りの文は残さない）を残して 200 を返す。success は残さない |
| 例外 | 500 |

**状態・永続化:** 新しい `sessions` の行と aal2 の Cookie（共有の `persistNewSession`、DATA-AUTH-001・004）。Supabase Auth の session が aal2 になる。

**認証認可:** 管理者・サポーターだけ。回数の制限は IP 単位に加えて利用者単位（5回／600秒）で、コードの成否を監査に残す（SEC-AUTH-009。2026-10-26）。

**テスト観点:**（単体 `tests/unit/api/auth/mfa-verify-route.test.ts`。結合 `tests/integration/api/auth/mfa-verify.test.ts`・`tests/integration/api/auth-mfa-verify-api.test.ts`）

| # | 観点 |
| --- | --- |
| 1 | 管理者の正しいコードで 200・aal2・書き戻し |
| 2 | 回数の制限の応答と例外 |
| 3 | 本文が JSON でない・コードが5桁・`factorId` が UUID でない |
| 4 | 確かめが通らない |
| 5 | 一般の会員・役割が無い時に 403 |
| 6 | チャレンジの誤りの文が `not found`・ほか・文が無い、データが無い |
| 7 | コードの誤りで 400 |
| 8 | AAL の読み直しの誤りで `null` |
| 9 | 前の refresh の Cookie の有り・無し、前の行の有り・無し |
| 10 | 書き戻しが投げても 200・error の監査 |
| 11 | client の作成が投げて 500 |
| 12 | 利用者単位の制限は `claims.sub` を鍵に 5回／600秒。6 回目は challenge より前に 429 で `account_rate_limited` を残す。認証に失敗した要求は数えない |
| 13 | 成功は success（`verified`）、要素が無い・チャレンジの失敗・コードの誤りは failure、書き戻しの失敗は error。コードと誤りの文が監査に無い |

## 戻り先の詳細設計

ログインの戻り先（ARC-AUTH-010、FR-AUTH-005）の部品と窓口。2026-10-25（波 1-A）に実装した（計画は `docs/superpowers/plans/2026-10-25-wave1a-login-return-to.md`）。決定は `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1a-decisions.md`（ユーザー承認 2026-10-25）。

### DD-AUTH-032 戻り先の確かめ（return-path.ts）

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-AUTH-010、SEC-AUTH-026 |
| 根拠 | 先頭の字だけを見る確かめは、URL パーサーとの食い違い（タブ・改行の除去、円記号の読み替え、`..` の解決）で抜ける。入口と出口の両方で同じ 1 つの関数を通し、解釈した結果の道筋を許可リストと比べて、`pathname + search` だけを返す（SEC-AUTH-026、ARC-AUTH-010） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1a-decisions.md`、`docs/superpowers/plans/2026-10-25-wave1a-login-return-to.md` |

**対応要件 ID:** ARC-AUTH-010、SEC-AUTH-026（その上は FR-AUTH-005）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | 戻り先の候補（`unknown`）。基準の origin（省略時は環境変数のサイトの origin。要求の見出しは使わない）。出口では閲覧者の役割と aal |
| 出力 | 通った時は解釈し直した `pathname + search`（fragment は捨てる）。外れた時は理由の符号（`empty`・`too_long`・`forbidden_char`・`decode_failed`・`not_relative`・`origin_mismatch`・`userinfo`・`excluded_path`・`not_allowed_path`・`resolved_not_local`・`admin_requires_privileged_aal2`）。外れた時に既定の行き先を返す補助の関数も持つ（既定は `/`） |

**正常フロー:**

1. 文字列でない・空を断る。長さ 512 超を断る
2. 空白・制御文字・書式文字・`\` を含む値を断る（前後の空白も断る。切り詰めない）
3. `%` を 1 回デコードする（失敗は断る）。デコード後の文字列にも 1・2 と、次の 4 をもう一度かける
4. `/` で始まり、2 文字目が `/` でも `\` でもないことを確かめる
5. 基準の origin で `new URL` に解釈し、origin の一致と userinfo の無いことを確かめる
6. 解釈後の `pathname + search` が `//`・`/\` で始まらず、512 文字以内で、再解釈しても origin が変わらないことを確かめる
7. 除外の道筋（`/login`・`/register`・`/auth`・`/api` とその下）を断る。許可リスト（公開の `/`〔完全一致〕・`/item`・`/look`・`/news`・`/stockist`・`/about`・`/search`・`/privacy`・`/contact`、会員の `/account`・`/wishlist`・`/cart`・`/checkout`、管理の `/admin`）に当たらなければ断る。接頭辞は「完全一致か、接頭辞と `/` で始まる」。大文字小文字は区別する
8. `/admin` は、出口で閲覧者が渡された時に、役割が admin か supporter で aal が `aal2` の時だけ通す。入口（閲覧者なし）では通す
9. 解釈し直した `pathname + search` を返す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| `/%09/evil.example`・タブ・改行・`\`・`%5C` | 断る（`forbidden_char`） |
| `//evil.example`・`/%2F%2Fevil.example` | 断る（`not_relative`） |
| `/.//evil.example`・`/a/..//evil.example`・`/item/..//evil.example` | 断る（解釈後の道筋で比べるので通らない） |
| `/item/%2e%2e/api/x` | 断る（`excluded_path`） |
| `/item/3?color=red#x` | 通す。返すのは `/item/3?color=red` |
| `/itemx`・`/Item/3` | 断る（`not_allowed_path`） |
| `%` のデコードに失敗 | 断る（`decode_failed`） |
| 例外 | 投げない。断る側へ倒す |

**状態・永続化:** 持たない（純粋な関数）。サーバー専用の import をしない（端末の画面からも使う）。

**認証認可:** 閲覧者の役割と aal は呼ぶ側が渡す。`/admin` を役割と aal2 なしで通さない。

**テスト観点:**（単体 `tests/unit/features/auth/return-intent/return-path*.test.ts`。試験名の先頭は `DD-AUTH-032`）

| # | 観点 |
| --- | --- |
| 1 | 迂回の値（`//`・`\`・`%09`・`%5C`・`%2F%2F`・`..`・`@`・512 字超・デコード失敗）がすべて断られる |
| 2 | 除外の道筋（`/login`・`/register`・`/auth/*`・`/api/*`）が断られる |
| 3 | 許可リストの境界（`/itemx`・`/Item`）。通る値は解釈し直した形で返り、fragment が無い |
| 4 | `/admin` が入口では通り、出口では役割と aal2 が揃った時だけ通る |
| 5 | 通った全ての値が、同じ origin で `//`・`/\`・`#` で始まらない（不変条件）。例外を投げない（乱数の入力を含む） |
| 6 | 端末の環境（jsdom）で import でき、`origin` を渡して動く |

### DD-AUTH-033 戻り先の控えの保存（return-intent-store.ts）

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-AUTH-010、DATA-AUTH-005、SEC-AUTH-007、SEC-AUTH-032 |
| 根拠 | 番号を 128 ビット以上の乱数にし、DB には sha256 だけを渡して、平文の番号をサーバーの外へも DB へも出さない（SEC-AUTH-032）。登録の控えは番号と登録したメールを一緒にハッシュして結び、別のメールの印では行に当たらないようにする（SEC-AUTH-007、ADR-0413）。表は関数 2 本だけで触り、失敗は呼び出し元を止めない（null を返す）。ログに道筋・番号・ハッシュを出さない |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1a-decisions.md`、`docs/superpowers/plans/2026-10-25-wave1a-login-return-to.md` |

**対応要件 ID:** ARC-AUTH-010、DATA-AUTH-005、SEC-AUTH-007・032（その上は FR-AUTH-005、ADR-0412、ADR-0413）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | 作る時は戻り先の道筋と用途（`login`・`signup`）と、任意の `bindTo`（登録したメール）。使い切る時は番号・用途・利用者の id と、任意の `bindTo` |
| 出力 | 作る時は番号と Cookie の秒数（失敗は null）。使い切る時は戻り先の道筋（使えない・失敗は null）。番号の生成と sha256 の関数（`bindTo` を渡すと `sha256(番号 + "\n" + 小文字のメール)`）、メールの正規化（前後の空白を除いて小文字）、番号の形の正規表現も持つ |

**正常フロー:**

1. 番号を 32 バイトの乱数（base64url の 43 文字）で作り、sha256（16 進 64 桁）にする。`bindTo` があれば番号とメールを改行でつないでハッシュする（無ければ番号だけで、ログインは変わらない。列の型・関数の引数は同じなので移行は要らない）
2. service role の client で `create_auth_return_intent(_token_hash, _return_path, _purpose)` を呼び、戻りの秒数を Cookie の秒数にする
3. 使い切る時は `consume_auth_return_intent(_token_hash, _purpose, _user_id)` を呼び、返った道筋を返す

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 関数がエラーを返す・投げる・戻りが数値でない | null。エラーの符号だけを `console.error` に出す |
| 使い切りの戻りが NULL・エラー | null |

**状態・永続化:** `private.auth_return_intents`（DATA-AUTH-005）を関数 2 本でだけ触る。

**認証認可:** service role の client。表も関数も anon・authenticated には開いていない。

**テスト観点:**（単体 `tests/unit/features/auth/return-intent/return-intent-store.test.ts`。試験名の先頭は `DD-AUTH-033`）

| # | 観点 |
| --- | --- |
| 1 | 関数に渡す引数に平文の番号が無く、ハッシュが番号の sha256 と一致する。`bindTo` ありは `sha256(番号 + 改行 + 小文字のメール)`、メールの大文字小文字・前後の空白は無視、別のメール・別の番号なら別のハッシュ。作る時・使い切る時の両方で `bindTo` が rpc のハッシュに入る |
| 2 | 秒数が関数の戻りのまま。エラー・例外・数値でない戻りで null |
| 3 | ログに道筋・番号・ハッシュが出ない |
| 4 | 番号の形（43 文字・`+`・`/`・`=` なし）。1000 回で重複がない |
| 5 | 使い切りの戻りの文字列・NULL・エラー・例外 |

### DD-AUTH-034 戻り先の控えの開始と解決（return-intent-service.ts）

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-AUTH-010、STATE-AUTH-006、SEC-AUTH-007、SEC-AUTH-026、SEC-AUTH-032 |
| 根拠 | 入口では確かめに通った時だけ控え（登録だけは戻り先が無くても必ず控え、登録したメールに結ぶ。SEC-AUTH-007、ADR-0413）、出口では使い切った戻り先を役割と aal2 を含めて確かめ直す（SEC-AUTH-026）。管理者・サポーターは aal2 になるまで使い切らない。Cookie の動作（作る・消す・そのまま）を値で返し、呼び出し元がどの応答にも同じ形で付けられるようにする（登録の 3 つの 202 の同一性。ARC-AUTH-006）。ログインを止めないため、想定外の例外は捕まえて既定に倒す |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1a-decisions.md`、`docs/superpowers/plans/2026-10-25-wave1a-login-return-to.md` |

**対応要件 ID:** ARC-AUTH-010、STATE-AUTH-006、SEC-AUTH-007・026・032（その上は FR-AUTH-005、ADR-0412、ADR-0413）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力（開始） | 入口の `next`（`unknown`）、用途、任意の `bindTo`（登録したメール）と `alwaysCreate`（真なら戻り先が無い・外れでも `/` で作る） |
| 出力（開始） | Cookie の動作（`set`〔番号と秒数〕・`clear`・`keep`）と結果（`created`・`cleared`・`rejected`・`failed`） |
| 入力（解決） | Cookie の見出し、用途、閲覧者（id・役割・aal） |
| 出力（解決） | 行き先の道筋、`needsMfa`、Cookie の動作 |
| 入力（結び付け） | Cookie の見出し、確認した利用者のメールと id（`consumeSignupBinding`。`IMPL-AUTH-220`） |
| 出力（結び付け） | `{ bound: true, storedPath }` か `{ bound: false }`。例外を投げず、Cookie は触らない |
| 入力・出力（確かめ直し） | 使い切った戻り先、閲覧者（役割・aal）、origin を渡すと、出口の確かめを通した行き先と Cookie の動作（`clear`）を返す（`resolveStoredDestination`。`IMPL-AUTH-221`。非同期。外れた理由の符号を監査に残すため。`resolveReturnDestination` もこれを呼ぶ） |
| 補助 | Cookie の動作を応答に適用する関数（`set` は HttpOnly・Lax・Path=/・秒数・本番は Secure、`clear` は空の値と `maxAge` 0、`keep` は何もしない）。見出しから番号を取り出す関数（形に合う時だけ） |

**正常フロー（開始）:**

1. `next` が無い・空 → `clear`（監査なし）。ただし `alwaysCreate` なら戻り先 `/` で 3. へ進む
2. 戻り先の確かめ（DD-AUTH-032）。外れたら理由の符号だけの監査（`auth.return_intent` の rejected）を残し、`alwaysCreate` なら戻り先 `/` で 3. へ進む。そうでなければ `clear`
3. 保存（DD-AUTH-033。`bindTo` があれば渡す）。成功なら `set`、失敗なら `clear` と監査（create_failed）

**正常フロー（結び付け。確認のリンク）:**

1. 見出しの番号が無い・形が違う・複数 → `bound: false`（DB を呼ばない）。確認した利用者のメールが空でも `bound: false`
2. 番号があれば、用途 `signup`・`bindTo` に利用者のメールで使い切る（DD-AUTH-033）。null・例外 → `bound: false`
3. 戻り先が返れば `bound: true` と `storedPath`

**正常フロー（解決）:**

1. 管理者・サポーターで aal2 でない → `/auth/verified`・`needsMfa`・`keep`（使い切らない）
2. 見出しに `sb-return-intent` が無い → 既定・`keep`。あるが形に合わない（重複を含む）→ 既定・`clear`
3. 番号があれば使い切る（失敗・NULL でも `clear`）
4. 使い切れた戻り先を、閲覧者を渡して確かめ直す（`resolveStoredDestination`）。外れたら既定と、理由の符号だけの監査
5. 既定は、管理者・サポーター（aal2）は `/admin`、一般は `/`

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 一般の会員で保存された値が `/admin`（入口で通った古い控え） | 出口の確かめで外れ、`/`。監査は `admin_requires_privileged_aal2` |
| 保存の値が `//evil.example`・`/login`・`/api/…`・`/%09/evil.example`（DB の制約を外れた改ざん） | 既定。監査は理由の符号だけ |
| 保存・監査・使い切りが投げる | 例外にせず、開始は `clear`・`failed`、解決は既定・`needsMfa` なし・`clear` |

**状態・永続化:** 持たない。表への書き込みは DD-AUTH-033 を通す。道筋・メール・番号を監査に残さない。

**認証認可:** 役割と aal は呼び出した人のトークンの claims から呼ぶ側が渡す。

**テスト観点:**（単体 `tests/unit/features/auth/return-intent/return-intent-service.test.ts`。試験名の先頭は `DD-AUTH-034`）

| # | 観点 |
| --- | --- |
| 1 | 開始: 無い・外れ・通る・保存失敗・用途の受け渡し。監査に入力の値が入らない。`alwaysCreate` なら無い・空・外れでも `/` で作り（外れは監査 1 回）、`bindTo` を保存へ渡す。`alwaysCreate` 無し（ログイン）は今までどおり |
| 2 | 解決: 一般・番号あり／なし／形が違う／使い切れない。管理者・サポーターは aal1 で使い切らず `/auth/verified` |
| 3 | 管理者・サポーター（aal2）で戻り先なし・`/admin`。一般で保存が `/admin` は `/` |
| 4 | 改ざんされた保存の値が既定に倒れる。例外を投げない |
| 5 | Cookie の動作の適用（属性、本番だけ Secure、`clear`、`keep`） |
| 6 | 見出しからの番号の取り出し（他の Cookie が混ざる・形が違う・名前の重複） |
| 7 | 結び付け: Cookie 無し・複数・メールが空・使い切りが null・例外は `bound: false`（使い切りを呼ばない場合を含む）。当たれば `bound: true` と `storedPath`、使い切りが用途 `signup`・`bindTo` つきで呼ばれる |
| 8 | 確かめ直し: 一般の `/account` はそのまま、`/admin`・`//evil.example` は `/`、管理者 aal2 の `/admin` はそのまま。`resolveReturnDestination` の動きは変わらない |

### DD-AUTH-035 ログインの後の行き先の窓口（post-login/route.ts）

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-019、ARC-AUTH-010、SEC-AUTH-026、SEC-AUTH-032 |
| 根拠 | 確認コードの確定と TOTP の確定は端末が移るので、行き先をサーバーが決めて返す（API-AUTH-019）。役割と aal は呼び出した人のトークンの claims から読み、本文や見出しを信じない。使い切りは DD-AUTH-034 に任せ、2 回目は使えない（SEC-AUTH-032） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1a-decisions.md`、`docs/superpowers/plans/2026-10-25-wave1a-login-return-to.md` |

**対応要件 ID:** API-AUTH-019、ARC-AUTH-010、SEC-AUTH-026・032（その上は FR-AUTH-005）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | `POST /api/auth/post-login`。本文なし。認証の Cookie と戻り先の Cookie |
| 出力 200 | `{ redirectTo, needsMfa }`。`no-store`・`no-referrer`。使い切った時は戻り先の Cookie を消す |
| 出力の失敗 | 401（未ログイン）、503（認証を確かめられない。`Retry-After` つき）、429（回数の制限の応答） |

**正常フロー:**

1. IP 単位の制限（`auth:post-login`、60回／600秒）を数える
2. 認証を確かめる（共有の `authenticateRequest`）
3. 役割（admin・supporter 以外は `user`）と aal を claims から取る
4. 戻り先を解決する（DD-AUTH-034、用途 `login`）
5. 200 を作り、Cookie の動作を適用する

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| 制限が応答を返す | そのまま返す |
| 未ログイン | 401。戻り先を解決しない。Cookie に触れない |
| 認証を確かめられない | 503 と `Retry-After` |
| 管理者・サポーターで aal2 でない | `redirectTo: '/auth/verified'`・`needsMfa: true`。Cookie は触らない |
| 本文・見出しに役割を入れて送る | 無視する |

**状態・永続化:** 表への書き込みは DD-AUTH-034 を通す。

**認証認可:** ログインを求める窓口。Origin は共有の proxy が確かめる。

**テスト観点:**（単体 `tests/unit/api/auth/post-login-route.test.ts`。試験名の先頭は `DD-AUTH-035`）

| # | 観点 |
| --- | --- |
| 1 | 未ログインで 401、確かめを呼ばない。確かめられなくて 503 と `Retry-After` |
| 2 | 一般の会員で `redirectTo` と `needsMfa: false`。役割と aal が claims 由来で、`x-role` などの見出しを無視する |
| 3 | 管理者・サポーターで aal1 は `needsMfa: true`・`/auth/verified`・Cookie に触れない |
| 4 | 使い切った応答で戻り先の Cookie を消す。`no-store`。制限で 429 |

### DD-AUTH-036 ログインの入口のリンクの URL を作る（use-login-href.ts）

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-AUTH-010、SCR-AUTH-009 |
| 根拠 | ヘッダーのログインと会員だけの頁の門が、今いる頁を戻り先として `/login?next=` に載せる（ARC-AUTH-010）。載せる前に戻り先の確かめ（DD-AUTH-032）を通し、外れたら `next` を付けない。サーバーの描画と端末の最初の描画を一致させるため、初めは検索条件を含めず、効果の後に足す |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1a-decisions.md`、`docs/superpowers/plans/2026-10-25-wave1a-login-return-to.md` |

**対応要件 ID:** ARC-AUTH-010、SCR-AUTH-009（その上は FR-AUTH-005）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | 現在の道筋（`usePathname`）と、端末の検索条件 |
| 出力 | `/login?next=<エンコードした道筋と検索条件>`。確かめに外れた・ログインの画面や認証の画面にいる時は `/login` |

**正常フロー:**

1. `usePathname` で初期値を作る（サーバーの描画と一致させる）
2. マウント後と道筋の変化で、端末の検索条件を足して更新する（fragment は含まれない）
3. 戻り先の確かめに通った時だけ `next` に載せる

**分岐と異常フロー:**

| 条件 | 動き |
| --- | --- |
| `/login`・`/auth/*`・`/api/*`・許可リスト外 | `/login`（`next` なし） |
| `//evil.example` を渡す | `/login` |
| ホーム `/`（検索条件の無い時） | `/login`（ホームは戻り先を持たない扱い。管理者が戻り先なしなら管理の頁へ着く今の挙動を保つ） |
| 最初の描画 | 検索条件を含めない |

**状態・永続化:** React の状態に URL を持つ。保存しない。

**認証認可:** 表示だけ。戻り先はサーバーが入口で確かめ直す（DD-AUTH-034）。

**テスト観点:**（単体 `tests/unit/features/auth/return-intent/use-login-href.test.tsx`。試験名の先頭は `DD-AUTH-036`）

| # | 観点 |
| --- | --- |
| 1 | `/stockist` と `?from=e2e` で `next` に検索条件つきで載る。`/item/3` の `?color=red#x` は fragment を落とす |
| 2 | `/login`・`/auth/verified`・`/api/x`・`/unknown` では `/login`。ホーム `/` も `/login` |
| 3 | 初回の描画が検索条件を含まず、効果の後に含む。道筋が変わると更新する |
| 4 | 会員だけの頁の 3 つの門が `/login?next=<今の道>`（`account-login-gate.test.tsx`） |

## 引き継がなかった古い番号

前の版のこの頁の番号のうち、範囲の単位に当たらない物。番号は使い回さない。

| 古い番号 | 前の版の中身 | 引き継がなかった理由 |
| --- | --- | --- |
| IMPL-AUTH-SEC-001、IMPL-AUTH-SEC-009 | proxy の HSTS・nonce つき CSP | 共有の `src/proxy.ts`（範囲外） |
| IMPL-AUTH-SEC-007 | 秘密の運用の手順の文書 | コードでなく `docs/06_Operations/` の文書 |
| IMPL-AUTH-COOKIE-01 | Cookie の属性の統一 | 共有の `src/lib/cookie.ts`。属性の決まりは DATA-AUTH-004 |
| IMPL-AUTH-CSRF-01 | 二重送信の CSRF の印 | 共有の `src/lib/csrf.ts`・`csrfMiddleware.ts`。ログアウトでの使い方は DD-AUTH-028 |
| IMPL-AUTH-VAL-01、IMPL-AUTH-ZOD-01 | zod の形 | 共有の `src/features/auth/schemas/` |
| IMPL-AUTH-RATE-01 | 回数の制限 | 共有の `src/features/auth/middleware/rateLimit.ts`。窓口ごとの枠は ARC-AUTH-005 |
| IMPL-AUTH-AUDIT-01 | 監査の記録と掃除 | 共有の `src/lib/audit.ts` |
| IMPL-AUTH-JTI-01 | JTI の再利用の検出 | 共有の `src/features/auth/services/session.ts`。今の refresh は JTI を見ない（DD-AUTH-027） |
| IMPL-AUTH-TURNSTILE-01 | Turnstile のサーバーの確かめ | 共有の `src/lib/turnstile.ts`。画面の描画は DD-AUTH-012 |
| IMPL-AUTH-DB-01 | 古い `migrations/001`〜`005` | 今の DB は `supabase/migrations/`。表は DATA-AUTH-001・002 |
| IMPL-AUTH-ADMIN-01 | 管理のセッションの強制失効 | 管理の窓口（ADMIN の範囲） |
| IMPL-AUTH-ACCOUNT-01、IMPL-AUTH-ACCOUNT-02 | 会員ページのログインの判定とログアウトのボタン | `src/app/account/page.tsx`（範囲外）。ログアウトの窓口は DD-AUTH-028 |
| IMPL-AUTH-TEST-01、IMPL-AUTH-OTP-10 | 結合テスト・E2E の追加の記録 | テストの記録で、コードの単位でない |
| IMPL-AUTH-OTP-03 | `src/app/api/auth/identify/route.ts` の未登録の作成 | そのファイルが無い。ログインは未登録を作らない（DD-AUTH-014） |
| IMPL-AUTH-OTP-14 | Supabase のダッシュボードの確認コードの設定 | 設定でコードでない（未確認事項） |

前の版にあった計画の記述（SES での登録のメール、`email_confirmation_tokens`・`oauth_requests` の表、OAuth のアカウントの連携の提案の画面、掃除の定期処理、同時のセッションの上限 5、トークンの寿命の表）は、今のコードに無いか違う。今の動きは各項目と構造設計に書いた。

## 未確認事項

- 本番の Supabase Auth の設定（Email OTP Expiration 300 秒・8 桁・Confirm email・TOTP の有効・最小の長さ・Redirect URLs）。手元の `supabase/config.toml` は OTP 3600 秒・Confirm email 無効・TOTP 無効・最小 6 文字で、DD-AUTH-015・018・030・031 の本番の動きを手元で確かめられない（SEC-AUTH-029）
- 共有の `logAudit` が投げることがあるか。DD-AUTH-017 のように `try` の外で呼ぶ所は、投げると窓口の応答が 500 になる
- DD-AUTH-028 で回転した CSRF の印を置いた直後に、消去の一覧で同じ Cookie を消す。後の書き込みが勝つ前提で「回転は効かない」と読んだが、動かしては確かめていない
- DD-AUTH-005 で me の通信が投げた時に TOTP の見せ方へ移り、自動の登録が走る。未ログインの人に TOTP の登録の失敗の文が出るかは確かめていない
- `src/components/Header.tsx` の `/` の分岐と `src/components/AuthTabs.tsx` の偽の側は、今の定数では届かない。分岐の網羅 100% には `test-gaps.md` の「届かない分岐」に理由を書くか、ユーザーにコードの扱いを決めてもらう
- 窓口の単体テスト（`tests/unit/api/auth/**`）は `logout` の1本だけ。結合テストの道を単体テストへ写すかは次の段で決める
- この頁の項目は全部「推定」。ユーザーの確認を受けたら「現行」にする
