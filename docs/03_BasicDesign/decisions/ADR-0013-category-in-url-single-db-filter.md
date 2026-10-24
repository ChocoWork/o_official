# ADR-0013 選んだ分類は URL の category に持ち、サーバーは分類が1つの時だけ DB で絞る

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/news/page.tsx`、`src/app/news/[id]/page.tsx`、`src/features/news/components/PublicNewsGrid.tsx` | 基準コミット: `a03beaff`

## 概要

選んだ分類を URL の `category`（カンマ区切り）に持ち、詳細と前後の記事へ引き継ぐ。サーバーは正しい分類が1つの時だけ DB で絞り、複数や正しくない値の時は全部を取って画面で絞る。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | FR-NEWS-ALL-003、FR-NEWS-ALL-005、FR-NEWS-ALL-007、FR-NEWS-DETAIL-004 |
| 対象のコード | `src/app/news/page.tsx`、`src/app/news/[id]/page.tsx`、`src/features/news/components/PublicNewsGrid.tsx` |
| 関連文書 | `docs/03_BasicDesign/ui/screen-list.md`、`docs/04_DetailDesign/pages/02_news_list.md` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0013 選んだ分類は URL の category に持ち、サーバーは分類が1つの時だけ DB で絞る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-ALL-003、FR-NEWS-ALL-005、FR-NEWS-ALL-007、FR-NEWS-DETAIL-004 |
| 根拠 | 選んだ分類を URL に残せば、共有した URL で同じ絞り込みを開け、ブラウザの戻るで前の選択へ戻れるため（画面一覧）。サーバーで絞るのを1つの時だけにしたのは、取り出しの関数が1つの分類しか受けないためと読める（推定） |
| 状態 | 推定 |
| 出どころ | `docs/03_BasicDesign/ui/screen-list.md`、実装から推定 |

#### 背景

分類の絞り込みを複数選べる形にした（ADR-0012）。一方で、取り出しの関数 `getPublishedNews` は分類を1つだけ受ける（`src/features/news/services/public.ts`）。

#### 決定

- 一覧: 分類を変えると `router.push` で URL の `category` をカンマ区切りでそろえる（`PublicNewsGrid.tsx`）
- 一覧のページ: `category` を大文字にして許可の一覧と比べ、1つの正しい値ならその分類で DB を絞る。複数・正しくない値は ALL として全部を取り、画面で絞る（`src/app/news/page.tsx`）
- 詳細: `category` を確かめて前後の記事と一覧へ戻るリンクに引き継ぎ、正しくない値は ALL にする（`src/app/news/[id]/page.tsx`）

#### 退けた案

記録なし

#### 結果

- 良くなること: 絞り込みを URL で共有でき、戻るで前の選択に戻る
- 食い違い: FR-NEWS-ALL-005 は DB で絞ると書くが、複数の時は全部を取る
- 食い違い: 詳細では記事そのものの取り出しにも分類を渡すので、記事と違う1つの分類を URL に付けると 404 になる（推定。一覧からのリンクではそうならない）
- 悪くなること: 全部を取る時に件数の上限が無い（ADR-0021）
- 同じ中身の `resolveCategory` が一覧と詳細に2つある

## 未確認事項

- 要件の文（FR-NEWS-ALL-002・003・005、FR-NEWS-DETAIL-004）が1つの分類を前提にしているのか、複数を認めるのか
- 判断の理由はユーザーの確認を受けていない
