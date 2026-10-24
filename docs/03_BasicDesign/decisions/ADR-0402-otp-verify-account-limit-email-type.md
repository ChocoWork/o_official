# ADR-0402 確認コードの検証は保留の宛先で数え、上限で保留を捨て、コードの種類を email に固定する

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/app/api/auth/otp/verify/route.ts` | 基準コミット: `4facf63b`

## 概要

`/api/auth/otp/verify` は、IP 単位 30回／600秒の制限の後で保留の Cookie を確かめ、その Cookie の宛先でアカウント単位 5回／600秒を数える。上限に達したら保留の Cookie を消して `/login` からやり直させる。Supabase のコードの検証は種類を email の1つに固定する。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | FREQ-335-REQ-01、FREQ-335-REQ-02、FREQ-335-REQ-03、FREQ-336-REQ-03、SEC-AUTH-002 |
| 対象のコード | `src/app/api/auth/otp/verify/route.ts` |
| 関連文書 | `docs/superpowers/specs/2026-09-04-login-otp-dedicated-screen-design.md`（5.3）、`docs/05_Quality/reviews/security/security_review_login.md`、`docs/02_Requirements/requirements.md` の FREQ-335・FREQ-336 の行 |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0402 確認コードの検証は保留の宛先で数え、上限で保留を捨て、コードの種類を email に固定する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-335-REQ-01、FREQ-335-REQ-02、FREQ-335-REQ-03、FREQ-336-REQ-03、SEC-AUTH-002 |
| 根拠 | IP だけの制限では IP を替えた総当たりを止められない（ASVS V2.2.1、`security_review_login.md`）。数える宛先に送られてきた email を使うと、Cookie を持たない相手が他人の枠を潰せる。種類を総当たりすると、1回の入力で Supabase の検証を最大3回使い、別の目的で出したトークンまで2段目として受けうる（spec 5.3） |
| 状態 | 現行 |
| 出どころ | `docs/superpowers/specs/2026-09-04-login-otp-dedicated-screen-design.md` の 5.3、`docs/02_Requirements/requirements.md` の FREQ-335・FREQ-336 の行 |

#### 背景

- 以前の検証は IP 単位の制限だけで、コードの種類を email・magiclink・signup の順に試していた（spec の欠陥 4・5）
- 宛先は本文の email と保留の Cookie の宛先を照らしていた。FREQ-336 で本文から email を外した

#### 決定

- 処理の順は、IP 単位の制限 → 本文の形 → 保留の Cookie → アカウント単位の制限 → コードの検証（`otp/verify/route.ts`）
- アカウント単位の制限の数える先は Cookie の宛先にし、Cookie を確かめた後に置く（`otp/verify/route.ts`）
- 上限に達したら 429 と Retry-After を返し、保留の Cookie を消す（`otp/verify/route.ts`）。試行の窓を1回のログインの中に閉じる
- 宛先は Cookie から取り、本文から受け取らない（`otp/verify/route.ts`）
- Supabase の検証は種類を email に固定する（`otp/verify/route.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 送られてきた email で数える | Cookie を持たない相手が他人のアカウントの枠を故意に潰せる（spec 5.3、`otp/verify/route.ts`） |
| 上限に達しても Cookie を残す | 窓が明けてから同じログインの続きとして再開できる（`otp/verify/route.ts`） |
| 種類を email・magiclink・signup で総当たりする（前の形） | 1回の入力で検証を最大3回使い、別の目的のトークンも受けうる（spec 5.3） |

#### 結果

- 良くなること: IP を分けても1つのログインの試行は5回で止まる。登録の確認やマジックリンクのトークンを2段目に使えない
- 悪くなること: 上限に達した人はパスワードからやり直す
- 悪くなること: IP の段は送り元の見出しの先頭を信じる共有の回数の制限に頼る（SEC-AUTH-013）
- 見直す条件: Supabase のコードの桁や有効期限を変える時、回数の制限の数え方を変える時

## 未確認事項

- 本番の送り元の見出しを Vercel が上書きするか（本番は未デプロイ）
