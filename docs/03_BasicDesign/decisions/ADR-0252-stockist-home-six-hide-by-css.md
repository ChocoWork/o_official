# ADR-0252 ホームの取扱店は DB から6件を取り、モバイルの3件は CSS で隠す

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/features/stockist/services/public.ts`、`src/features/stockist/components/PublicStockistGrid.tsx` | 基準コミット: `4facf63b`

## 概要

ホームの取扱店の節は、DB から6件を1回で取り、4件目からは 768px 未満で CSS で隠す。幅ごとに取り出しを分けない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | FR-STOCKIST-004 |
| 対象のコード | `src/features/stockist/services/public.ts`、`src/features/stockist/components/PublicStockistGrid.tsx` |
| 関連文書 | `docs/02_Requirements/requirements.md` |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0252 ホームの取扱店は DB から6件を取り、モバイルの3件は CSS で隠す

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-004 |
| 根拠 | サーバーは閲覧者の画面の幅を知らないので、件数は多い方の6件で取り、モバイルの3件は CSS で絞って、取り出しを1回にするため（推定。判断の記録は無い） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/features/stockist/services/public.ts`、`src/features/stockist/components/PublicStockistGrid.tsx`） |

#### 背景

- FR-STOCKIST-004 は、ホームは最大6件、モバイルは上の3件、タブレット以上で全部を求める
- ホームはサーバーで描く。描く時に画面の幅は分からない

#### 決定

- ホーム用の取り出しは、公開の店を id の順に6件まで取る（`public.ts`）
- 4件目から、768px 未満では隠す CSS の印を付ける（`PublicStockistGrid.tsx`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 幅ごとに件数を変えて取る | サーバーは描く時に幅を知らない（推定） |
| 画面の側で幅を測って3件に切る | 初めの描画と後の描画がずれ、カードが出てから消える（推定） |

#### 結果

- 良くなること: 取り出しは1回で、幅を変えても取り直さない
- 悪くなること: モバイルでも見えない3件分のカードを送る。どの店がホームに出るかは id の順（ADR-0257）で決まり、管理で選べない

## 未確認事項

- この形をユーザーが決めた記録
