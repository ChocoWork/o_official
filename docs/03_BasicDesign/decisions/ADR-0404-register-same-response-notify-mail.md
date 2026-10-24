# ADR-0404 会員登録は登録済みの宛先でも同じ 202 を返し、登録済みであることは本人にだけメールで伝える

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/app/api/auth/register/route.ts`、`src/components/RegisterModal.tsx` | 基準コミット: `4facf63b`

## 概要

公開の会員登録は、新しい宛先でも登録済みの宛先でも、同じ本文の 202 を返す。登録済みなら「すでに登録されています」のメールを本人に送り、そのメールは応答の後に送って応答の時間をそろえる。この形は Supabase の確認メール（Confirm email）が ON であることを前提にする。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | FREQ-320-REQ-01、FREQ-320-REQ-03、FREQ-320-REQ-04（SEC-AUTH-016 は宛先単位の制限を満たさないので上位にしない） |
| 対象のコード | `src/app/api/auth/register/route.ts` |
| 関連文書 | `docs/02_Requirements/requirements.md` の FREQ-320 の行、`docs/05_Quality/reviews/security/security_review_signup.md`、git `e476b83e` |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0404 会員登録は登録済みの宛先でも同じ 202 を返し、登録済みであることは本人にだけメールで伝える

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-320-REQ-01、FREQ-320-REQ-03、FREQ-320-REQ-04 |
| 根拠 | 409 を返すと、宛先を投げるだけで会員かどうかが分かり、会員を狙った詐欺メールや漏れたメールとパスワードの組の絞り込みに使われる（OWASP WSTG-IDNT-04、`register/route.ts`、`security_review_signup.md`）。登録済みであることは、Supabase の既定の動きに合わせて本人へのメールだけで伝える（`register/route.ts`） |
| 状態 | 現行 |
| 出どころ | `docs/02_Requirements/requirements.md` の FREQ-320 の行、`src/app/api/auth/register/route.ts` のコメント |

#### 背景

- 以前の公開の登録は、登録済みなら 409 を返していた（`security_review_signup.md`）
- 登録済みかの照会は、以前は利用者の一覧の先頭 100 件だけを見ていて、101 人目からの重複を見落とした（`register/route.ts`）

#### 決定

- 登録済みかは DB の関数で1回引き、「見つかった」「無い」「引けなかった」の3つに分ける。引けなかったら 503 で止める（`register/route.ts`、FREQ-320-REQ-01）
- 見つかったら、本人に「すでに登録されています」とログインの入口をメールで送り、新しい登録と同じ本文の 202 を返す（`register/route.ts`）。Supabase の登録が重複で失敗した時も同じ
- 本人へのメールは応答の後に送り、送るかどうかで応答の時間が変わらないようにする（`register/route.ts`）
- 新しい宛先は Supabase の確認メールで登録を終える。確認が要る流れでは 202 を返す（`register/route.ts`）
- 登録の後の画面に「既に登録」の類を出さない（FREQ-320-REQ-04）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 登録済みなら 409 を返す（前の形） | 会員かどうかを外から判別できる（`register/route.ts`） |
| 照会を引けない時は登録へ進む | 重複の確かめが黙って消える（`register/route.ts`） |

#### 結果

- 良くなること: 公開の登録の応答から会員かどうかを知られない
- 悪くなること: Supabase の確認メールが OFF だと、新しい宛先は 201 とトークンを返し、登録済みは 202 になって判別できる（`register/route.ts`）。運用で ON を保つ必要がある
- 悪くなること: 手元の Supabase は確認メールが OFF（`supabase/config.toml`）で、手元の E2E・結合は 201 の道を通る。本番の前提を手元で確かめていない
- 悪くなること: 管理の作成の道（管理の鍵の見出し付き）は今も同じ窓口にあり、重複で 409 を返す（`register/route.ts`、SEC-AUTH-017）
- 悪くなること: 照会の DB の関数が除く宛先（SSO・停止・論理削除）は Supabase の重複の誤りで拾うので、照会と登録の2つに頼る
- 見直す条件: 確認メールの設定を変える時、管理の作成を別の窓口へ移す時

## 未確認事項

- 本番の Supabase の確認メールが ON か（memory の前提。ダッシュボードは見ていない）
