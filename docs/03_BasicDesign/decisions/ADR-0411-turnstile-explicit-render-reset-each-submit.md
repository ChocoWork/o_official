# ADR-0411 ボットの確かめ（Turnstile）は共通の部品で明示に描き、送るたびに成否によらずトークンを引き直す

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/hooks/useTurnstileWidget.ts`、`src/components/LoginModal.tsx`、`src/components/RegisterModal.tsx`、`src/app/auth/password-reset/page.tsx` | 基準コミット: `4facf63b`

## 概要

ログイン・会員登録・パスワード再設定の申請のフォームは、Turnstile を共通の部品 `useTurnstileWidget` で明示に描く。送った直後には、成功でも失敗でも部品のリセットを呼び、新しいトークンを出させる。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | FREQ-328-REQ-01、FREQ-328-REQ-02、FREQ-330-REQ-01、FREQ-330-REQ-02 |
| 対象のコード | `src/hooks/useTurnstileWidget.ts`、`src/components/LoginModal.tsx`、`src/components/RegisterModal.tsx`、`src/app/auth/password-reset/page.tsx` |
| 関連文書 | `docs/02_Requirements/requirements.md`（FREQ-328・FREQ-330 の行） |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0411 ボットの確かめ（Turnstile）は共通の部品で明示に描き、送るたびに成否によらずトークンを引き直す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-328-REQ-01、FREQ-328-REQ-02、FREQ-330-REQ-01、FREQ-330-REQ-02 |
| 根拠 | 自動の描画はスクリプトの読み込みの時にしか走らず、タブの切り替えなどで部品を付け直すと描かれない（FREQ-328、`useTurnstileWidget.ts`）。サーバーの確かめ（siteverify）はトークンを引き換えるので、同じトークンの2回目は 403 になり、失敗して同じ画面に留まった時の再試行が必ず断られる。リセットを呼ぶ側ごとに書くと漏れる（FREQ-330、Supabase の CAPTCHA の案内と Cloudflare の reset の案内） |
| 状態 | 現行 |
| 出どころ | `docs/02_Requirements/requirements.md`（FREQ-328・FREQ-330 の行） |

#### 背景

- ログインと会員登録はもとから明示の描画で、パスワード再設定だけが自動の描画だった（FREQ-328-REQ-01）
- トークンを送った後も同じトークンを持ち続ける作りでは、失敗の後の再試行が 403 になった（FREQ-330）

#### 決定

- 描画は共通の部品が受け持ち、フォームは描画とリセットの2つの手だけを使う（`useTurnstileWidget.ts`）
- 幅は `flexible` で入れ物に合わせ、下限の 300px を割る時は縮めて収める（`useTurnstileWidget.ts`、FREQ-328-REQ-02）
- 送った後は成否によらず、finally の中でリセットを呼ぶ（`LoginModal.tsx`、`RegisterModal.tsx`、`password-reset/page.tsx`）
- E2E がトークンを差し込むための入口を窓に置く（`useTurnstileWidget.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 自動の描画（`cf-turnstile` の印）を使う | スクリプトの読み込みの時にしか走らず、付け直した部品に描かれない（FREQ-328-REQ-01） |
| 成功した時だけリセットする | 失敗して同じ画面に留まる時こそ、再試行で同じトークンを使い回して断られる（FREQ-330-REQ-01） |
| 呼ぶ側ごとにリセットを書く | 当て漏れが起きる（FREQ-330-REQ-02） |

#### 結果

- 良くなること: どのフォームでも、失敗の後の再試行が 403 で断られない。狭い画面でもはみ出さない
- 悪くなること: 送るたびにボットの確かめを待つ
- 文書: FREQ-330-REQ-03 は「OTP の再送」にも当てると書くが、再送の窓口はトークンを受け取らない（ADR-0401。`docs/05_Quality/reports/trace-matrix.md` の「食い違い」節に載せる）
- 試験: 共通の部品に単体テストは無い。秘密の鍵が無い環境では確かめが省かれる（`src/lib/turnstile.ts`）ので、E2E はトークンの値が変わることで確かめる（FREQ-330-REQ-03）
- 見直す条件: Turnstile の描画の方式や、サーバーの確かめの使い回しの扱いが変わる時

## 未確認事項

- 本番の Turnstile の鍵の設定（未デプロイ）
