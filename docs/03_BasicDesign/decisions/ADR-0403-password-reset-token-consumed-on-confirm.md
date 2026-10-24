# ADR-0403 パスワード再設定の印は、リンクを開いた時ではなくパスワードを変える時に消費する

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/app/api/auth/password-reset/{request,link,confirm}/route.ts`、`src/app/auth/password-reset/verify/` | 基準コミット: `4facf63b`

## 概要

再設定のメールのリンクは、開いても消費しない。リンク先の画面が1回だけ link の POST を送り、印を確かめて 10 分の再設定の Cookie を出す。印を使用済みにするのは、新しいパスワードを確定する confirm の中だけで、未使用を条件に1つだけが勝つ。印の寿命は 10 分。新しく出す時は前の印を使用済みにするが、失敗しても新しい印を出すので、有効なリンクが最新の1本だけとは保証しない（SEC-AUTH-018 は満たさない）。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | FREQ-319-REQ-03、FREQ-332-REQ-01、FREQ-332-REQ-04（SEC-AUTH-018 は最新の1本だけを保証しない部分を満たさないので上位にしない） |
| 対象のコード | `src/app/api/auth/password-reset/request/route.ts`、`src/app/api/auth/password-reset/link/route.ts`、`src/app/api/auth/password-reset/confirm/route.ts`、`src/app/auth/password-reset/verify/page.tsx`、`src/app/auth/password-reset/verify/VerifyClient.tsx` |
| 関連文書 | `docs/02_Requirements/requirements.md` の FREQ-319・FREQ-332 の行、`docs/05_Quality/reviews/security/security_review_auth_password_reset.md` |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0403 パスワード再設定の印は、リンクを開いた時ではなくパスワードを変える時に消費する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-319-REQ-03、FREQ-332-REQ-01、FREQ-332-REQ-04 |
| 根拠 | 会社のメールのリンクの検査は受け取った時にリンクを開き、JS を動かす物は POST も送る。開いた時点で消費すると、利用者が開く前に印が潰れ、再送しても同じく潰れて永久に再設定できない（Supabase の Production Checklist・Delay Token Invalidation、OWASP Forgot Password Cheat Sheet。`link/route.ts`）。消費が完了の時なので、10 分の寿命がそのままリンクの漏れの窓になる（ASVS V2.7.2、`request/route.ts`） |
| 状態 | 現行 |
| 出どころ | `docs/02_Requirements/requirements.md` の FREQ-319・FREQ-332 の行、`src/app/api/auth/password-reset/link/route.ts` のコメント |

#### 背景

- 再設定は Supabase の再設定のメールではなく、アプリの表 `password_reset_tokens` に印のハッシュを持つ（`request/route.ts`）
- FREQ-319 の前は、リンク先で消費する作りで、500 にもなっていた
- FREQ-332 で、確認の画面を挟まず新しいパスワードの欄へ直に進むことにした

#### 決定

- 申請の時は、同じ宛先の未使用の印を使用済みにしてから新しい印を出す。使用済みにするのに失敗しても新しい印を出すので、最新の1本だけは保証しない（SEC-AUTH-018 は満たさない。`request/route.ts`）。寿命は 10 分
- メールのリンク先は副作用の無い画面 `/auth/password-reset/verify`（`request/route.ts`、`verify/page.tsx`）。link の GET は確認の画面へ送るだけ（`link/route.ts`）
- 画面は link の POST を1回だけ自動で送る。POST は印を読むだけで、10 分の再設定の Cookie を出す（`link/route.ts`）。同じ印から Cookie が複数出てもよい
- confirm は Cookie と未使用の印の行の両方を確かめる。期限はここで見ず、Cookie の 10 分に任せる（`confirm/route.ts`）
- 漏れたパスワードの照合の後で、未使用を条件に使用済みへ変える。0 行なら負けた側として断る（`confirm/route.ts`）。成功したら行を消し、全部のセッションを切る

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| リンクの GET で消費する（前の形） | 受信時のリンクの検査が先に踏んで潰す（`link/route.ts`、`request/route.ts`） |
| link の POST で消費する | JS を動かす検査（Safe Links など）も POST を送るので、確認の画面を挟んでも同じ袋小路に戻る（`link/route.ts`） |
| confirm で印の期限も見る | フォームを開いて入力している間にリンクの 10 分が切れて断られる（`confirm/route.ts`） |
| 漏洩の照合の前に消費する | 弱いパスワードで断られた人のリンクまで焼ける（`confirm/route.ts`） |

#### 結果

- 良くなること: 会社のメールでも再設定できる。同じリンクから出た複数の Cookie のうち、パスワードを変えられるのは1つだけ
- 悪くなること: 消費が遅いので、漏れたリンクは 10 分の間に使える。新しく申請すると前のリンクは普通は無効になるが、無効にするのに失敗した時は前のリンクも残る（最新の1本だけは保証しない。SEC-AUTH-018 は満たさない）
- 悪くなること: 使われずに期限が切れた行は残る。掃除の DB 関数はあるが呼ぶ所が無い（`supabase/migrations/20260901102912_remote_schema.sql`、台帳の W-06 は後回し）
- 見直す条件: Supabase の再設定のメールへ移る時、期限切れの行の掃除を入れる時

## 未確認事項

- 本番のメールの検査（Safe Links など）で実際に印が残るか
