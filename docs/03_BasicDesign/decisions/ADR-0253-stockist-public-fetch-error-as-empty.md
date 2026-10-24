# ADR-0253 公開の取り出しが失敗した時は誤りにせず空の一覧として出す

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/features/stockist/services/public.ts`、`src/features/stockist/components/PublicStockistGrid.tsx` | 基準コミット: `4facf63b`

## 概要

公開の取扱店の取り出しで DB が誤りを返した時は、記録だけ残して空の一覧を返す。頁は「店が無い」時と同じ表示になる。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | FR-STOCKIST-003、DRV-STOCKIST-006、DRV-STOCKIST-007 |
| 対象のコード | `src/features/stockist/services/public.ts`、`src/features/stockist/components/PublicStockistGrid.tsx` |
| 関連文書 | `docs/02_Requirements/requirements.md`、`docs/03_BasicDesign/decisions/ADR-0017-error-text-red-exception.md`（NEWS の形） |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0253 公開の取り出しが失敗した時は誤りにせず空の一覧として出す

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-003、DRV-STOCKIST-006、DRV-STOCKIST-007 |
| 根拠 | DB が一時的に落ちてもホームと一覧の頁を誤りの画面にせず、取扱店の所だけが空になるようにするため。FR-STOCKIST-003 の「空状態またはエラーハンドリング」のうち空を選んだ（推定。選んだ記録は無い） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/features/stockist/services/public.ts`）、`docs/02_Requirements/requirements.md` |

#### 背景

- ホームと `/stockist` は同じ取り出しを使う（`public.ts`）。投げた誤りはホーム全体にも及ぶ

#### 決定

- DB の誤りはサーバーの記録に書き、空の一覧を返す（`public.ts`）
- 一覧は「該当する取扱店舗がございません。」と「すべて見る」を出す（`PublicStockistGrid.tsx`、DRV-STOCKIST-007）。ホームは店が無い時の案内と VIEW COLLECTION を出す（DRV-STOCKIST-006）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 誤りを投げ、頁の誤りの画面を出す | ホームも同じ取り出しを使うので、ホーム全体が誤りになる（推定） |
| 取り出しの失敗の文を出す（NEWS の ADR-0017 の形） | 取扱店は採っていない。理由の記録は無い |

#### 結果

- 良くなること: DB の一時の落ちでホームと一覧が止まらない
- 悪くなること: 閲覧者には「店が無い」のか「取れなかった」のか区別できない。NEWS（失敗の文を出す）とふるまいが違う

## 未確認事項

- 空にする形をユーザーが決めた記録
