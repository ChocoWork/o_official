# ADR-0250 公開の取扱店は全件をサーバーで取り、地方・都道府県の絞り込みは画面の側で URL の pref から行う

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/stockist/page.tsx`、`src/features/stockist/components/PublicStockistGrid.tsx` | 基準コミット: `4facf63b`

## 概要

`/stockist` はサーバーで公開の店を全部1回で取り、地方・都道府県の絞り込みは画面の側の部品が URL の `pref` を読んで行う。選んだ県は URL に残し、共有と「戻る」に効かせる。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | FREQ-57-REQ-01、FR-STOCKIST-010、FR-STOCKIST-006、DRV-STOCKIST-008 |
| 対象のコード | `src/app/stockist/page.tsx`、`src/features/stockist/components/PublicStockistGrid.tsx` |
| 関連文書 | `docs/05_Quality/reviews/security/security_review_stockist.md`、`docs/03_BasicDesign/ui/screen-list.md` |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0250 公開の取扱店は全件をサーバーで取り、地方・都道府県の絞り込みは画面の側で URL の pref から行う

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-57-REQ-01、FR-STOCKIST-010、FR-STOCKIST-006、DRV-STOCKIST-008 |
| 根拠 | 絞った状態の URL を人に送れ、ブラウザの「戻る」で前の選択に戻れるようにしながら、店の数が少ないうちは DB への問い合わせを1回で済ませるため（推定。判断の記録は無い） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/features/stockist/components/PublicStockistGrid.tsx`）、git `bac0e071`（2026-06-27、絞り込みを足したコミット） |

#### 背景

- FREQ-57 で地方→都道府県の絞り込みを足した。見本の取扱店は6件で、店の数は少ない
- FR-STOCKIST-006 で、言葉の検索・並び替え・ページ分けは作らない（WONT）
- 県は DB の列でなく住所から決める（ADR-0251）ので、DB の条件では絞れない

#### 決定

- 頁はサーバーで公開の店を、件数の上限を付けずに1回取る（`src/app/stockist/page.tsx`）
- 絞り込みの部品は画面の側で動き、URL の `pref` を読んで47都道府県の名前だけを受ける（`PublicStockistGrid.tsx`）。店の住所の県と突き合わせて、出す店を決める
- 選ぶたびに URL を書き換えて履歴を1つ足し、画面の位置は動かさない
- 部品が URL の値を読むので、頁は `searchParams` を待って毎回サーバーで描く（`page.tsx`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `pref` をサーバーで読み、DB の条件で絞る | 県は DB の列でない（ADR-0251）。選ぶたびにサーバーへの往復が要る（推定） |
| 選んだ県を画面の中の状態だけに持つ | 絞った URL を送れず、「戻る」で前の選択に戻らない（DRV-STOCKIST-008） |

#### 結果

- 良くなること: 取り出しは1回で、絞り込みの切り替えに DB を使わない。絞った状態を URL で共有できる
- 悪くなること: 店が増えると、全部の店を毎回送る。公開の読み出しの件数に上限が無く、SEC-STOCKIST-018（件数の上限）の求める形と合わない
- 見直す条件: 店の数がページ分けを要するほど増えた時（FR-STOCKIST-006 の WONT を外す時）

## 未確認事項

- 全件を1回で取る形をユーザーが決めた記録（コミットの本文と仕様に理由が無い）
