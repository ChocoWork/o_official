# ADR-0401 確認コードの再送は保留の Cookie だけで受け、ログインと同じアカウント単位の枠で数える

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/app/api/auth/login/resend/route.ts`、`src/app/login/verify/VerifyOtpClient.tsx` | 基準コミット: `4facf63b`

## 概要

`/login/verify` の再送は、パスワードも宛先も受け取らず、保留の Cookie の宛先にだけ送る。回数はログインと同じ枠の名前（`auth:login`）で、IP 単位 50回／600秒とアカウント単位 5回／600秒の2段で数える。ボットの確かめ（Turnstile）は求めない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | FREQ-334-REQ-05、FREQ-336-REQ-02、SEC-AUTH-004 |
| 対象のコード | `src/app/api/auth/login/resend/route.ts`、`src/app/login/verify/VerifyOtpClient.tsx`、`src/app/api/auth/login/route.ts` |
| 関連文書 | `docs/superpowers/specs/2026-09-04-login-otp-dedicated-screen-design.md`（5.2）、`docs/02_Requirements/requirements.md` の FREQ-334・FREQ-336・FREQ-330 の行 |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0401 確認コードの再送は保留の Cookie だけで受け、ログインと同じアカウント単位の枠で数える

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-334-REQ-05、FREQ-336-REQ-02、SEC-AUTH-004 |
| 根拠 | 専用の画面にパスワードは無く、持たせてもいけない。パスワードが通ったことは保留の Cookie が示す。本文の宛先を信じると、他人の宛先へ店のドメインからメールを送らせる道になる。抑えたいのは1つのアカウントへ送るメールの総量なので、ログインと枠を分けると 5 通 + 5 通で 10 通送れてしまう（spec 5.2、`resend/route.ts`） |
| 状態 | 現行 |
| 出どころ | `docs/superpowers/specs/2026-09-04-login-otp-dedicated-screen-design.md` の 5.2、`docs/02_Requirements/requirements.md` の FREQ-334・FREQ-336 の行 |

#### 背景

- 専用の画面より前の再送は、ログインの呼び出しをパスワードとボットの確かめ付きでやり直していた（spec 5.2）
- `/login/verify` に移すと、画面にパスワードが無くなる（ADR-0400）

#### 決定

- 再送の窓口は保留の Cookie を読み、無ければ 401 を返す（`resend/route.ts`）。本文は読まない
- 回数の制限はログインと同じ名前の枠で、IP 単位 50回／600秒、保留の宛先単位 5回／600秒（`resend/route.ts`、`login/route.ts`）。IP の段は FREQ-336 で足した（1つの IP から複数のアカウントの再送を回させない、`resend/route.ts`）
- 送れたら保留の Cookie を出し直して寿命を延ばすが、最初の発行時刻は引き継ぐ（`resend/route.ts`）
- ボットの確かめは求めない。Cookie の門とアカウント単位の制限で抑える（spec 5.2）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 再送でもパスワードを送らせる（前の形） | 専用の画面にパスワードは無く、持たせてもいけない（spec 5.2） |
| 本文の宛先へ送る | 他人の宛先へ店のドメインからメールを送らせる道になる（`resend/route.ts`） |
| 再送の枠をログインと分ける | ログイン 5 通と再送 5 通で 1 アカウントに 10 通送れる（spec 5.2、`resend/route.ts`） |
| 再送にもボットの確かめを課す | パスワードを通った Cookie が前提で、ボットの濫用は Cookie とアカウント単位の制限で抑える（spec 5.2） |

#### 結果

- 良くなること: 専用の画面からパスワード無しで再送できる。1 アカウントへ送るコードの総量が 10 分に 5 通で止まる
- 悪くなること: 再送が枠を使うので、再送を重ねた人はログインのやり直しも 10 分待たされる
- 文書: FREQ-330-REQ-03 は「OTP の再送」にもボットの確かめのトークンを使い捨てで当てると書くが、今の再送の窓口はトークンを受け取らない（`docs/05_Quality/reports/trace-matrix.md` の「食い違い」節に載せる）
- 見直す条件: 再送の濫用が見えた時、ボットの確かめの扱いを FREQ-330 と合わせる時

## 未確認事項

- FREQ-330-REQ-03 の「OTP の再送」が、専用の画面より前の再送（ログインのやり直し）を指していたのか
