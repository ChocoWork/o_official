# ADR-0019 管理のニュースの書き換えは proxy の Origin の検査で守り、窓口で CSRF の token を重ねない

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/api/admin/news/route.ts`、`src/app/api/admin/news/[id]/route.ts`、`src/proxy.ts`（範囲外の共有部品） | 基準コミット: `a03beaff`

## 概要

管理のニュースの POST・PUT・PATCH・DELETE の CSRF の守りは、`/api` の下の書き換えを全部見る proxy の Origin・Referer の検査に任せ、窓口では CSRF の token を確かめない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | SEC-NEWS-014、FREQ-327-REQ-03（範囲外） |
| 対象のコード | `src/proxy.ts`（範囲外の共有部品）、`src/app/api/admin/news/route.ts`、`src/app/api/admin/news/[id]/route.ts` |
| 関連文書 | `docs/02_Requirements/requirements.md`（FREQ-327（範囲外））、`docs/05_Quality/reviews/security/security_review_overview.md` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0019 管理のニュースの書き換えは proxy の Origin の検査で守り、窓口で CSRF の token を重ねない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-014、FREQ-327-REQ-03（範囲外） |
| 根拠 | Origin の検査を窓口ごとに書くと、許可のオリジンが無い時の動きが経路ごとに食い違うため、proxy 1つにまとめる（FREQ-327-REQ-03（範囲外））。ただし NEWS の窓口が CSRF の token も確かめないのがこの決まりに従ったものかは記録が無い（推定） |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`（FREQ-327（範囲外））、実装から推定 |

#### 背景

CSRF の守りには、proxy の Origin の検査と、窓口ごとの `requireCsrfOrDeny`（token の確かめ）の2つの部品がある。

#### 決定

- `/api` の下の POST・PUT・PATCH・DELETE は `src/proxy.ts` が Origin・Referer を許可のオリジンと比べる。除くのは署名で発信元を確かめる経路だけ（`src/proxy.ts`）
- 管理のニュースの窓口は `requireCsrfOrDeny` を呼ばない

#### 退けた案

記録なし

#### 結果

- 良くなること: Origin の検査の動きが1か所で決まる
- 食い違い: ほかの管理の窓口（例 `src/app/api/admin/accounting/product-costs/route.ts`）は `requireCsrfOrDeny` を呼ぶ。NEWS だけが token を見ないのが抜けか決めた事か、決める必要がある
- 悪くなること: Origin も Referer も無い要求の扱いは proxy の決まりに頼る（SEC-NEWS-014-AC-02）

## 未確認事項

- 管理の窓口で CSRF の token を重ねる決まりがあるか（FREQ-327-REQ-03（範囲外） は Origin の検査だけを書く）
- 判断の理由はユーザーの確認を受けていない
