# ADR-0260 変更の窓口は proxy の Origin の確かめに加え、窓口でも CSRF の token を確かめる

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/app/api/admin/stockists/`、`src/features/stockist/services/admin-security.ts` | 基準コミット: `4facf63b`

## 概要

管理の取扱店を変える窓口（作る・直す・公開の切替・消す）は、proxy の Origin の確かめを通った上で、窓口の中でも CSRF の token を確かめ、合わなければ拒む。2026-04-18 のレビューの指摘で足した。NEWS の管理（ADR-0019、Origin だけ）とは形が違う。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | FREQ-327-REQ-01（範囲外）、NFR-SEC-003（範囲外） |
| 対象のコード | `src/app/api/admin/stockists/route.ts`、`src/app/api/admin/stockists/[id]/route.ts`、`src/features/stockist/services/admin-security.ts` |
| 関連文書 | `docs/05_Quality/reviews/code/2026-04-18-stockist-review.md`、`docs/05_Quality/reviews/security/security_review_stockist.md`、`src/proxy.ts`、`src/lib/csrfMiddleware.ts`、`docs/03_BasicDesign/decisions/ADR-0019-admin-news-csrf-origin-proxy.md` |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0260 変更の窓口は proxy の Origin の確かめに加え、窓口でも CSRF の token を確かめる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-327-REQ-01（範囲外）、NFR-SEC-003（範囲外） |
| 根拠 | 状態を変える管理の窓口の CSRF の守りを、Cookie の SameSite の属性だけに頼らないため。2026-04-18 のレビュー（Priority 1 の1）が変更の窓口に token の確かめを必須にするよう求め、後から /api の全部の変更に proxy の Origin の確かめが入った（FREQ-327（範囲外））。この判断が含む `toCsrfDenyResponse` は判定できない結果を通すので、SEC-STOCKIST-004 は満たさず、上位にしない |
| 状態 | 現行 |
| 出どころ | `docs/05_Quality/reviews/code/2026-04-18-stockist-review.md`、`docs/05_Quality/reviews/security/security_review_stockist.md`（CSRF 耐性、Fixed） |

#### 背景

- 管理の窓口は Cookie の access token も受けるので、別のサイトからの送信が届きうる（`2026-04-18-stockist-review.md`）
- proxy は /api の下の変更の要求を全部 Origin で確かめる（`src/proxy.ts`）

#### 決定

- 作る・直す・公開の切替・消すで、共有の CSRF の確かめを呼ぶ（`route.ts`、`[id]/route.ts`）。拒否の応答はそのまま返す（`admin-security.ts`）
- 管理の画面の送信の部品が token の見出しを付ける（`src/lib/client-fetch.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| Cookie の SameSite の属性だけに頼る | 防御が1層だけになる（`2026-04-18-stockist-review.md`） |
| proxy の Origin の確かめだけにし、窓口で token を重ねない（NEWS の ADR-0019 の形） | 取扱店は token の確かめを残している。両方を並べる理由の記録は無い（推定） |

#### 結果

- 良くなること: Origin と token の2段で、別のサイトからの変更を止める
- 悪くなること: 共有の CSRF の確かめは、refresh の Cookie が無い要求を確かめない（`csrfMiddleware.ts`）。`admin-security.ts` は、今はもう作られない token の回し（`csrfMiddleware.ts`）と、試験の作り物の応答の形（`admin-security.ts`）を受ける道を残す。NEWS の管理と守りの形がそろっていない

## 未確認事項

- NEWS と取扱店のどちらの形にそろえるか
