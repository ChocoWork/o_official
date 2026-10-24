# ADR-0264 店舗の削除は確かめの窓の後に行を消し、戻す手段を持たない

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/api/admin/stockists/[id]/route.ts`、`src/components/StockistSection.tsx` | 基準コミット: `4facf63b`

## 概要

管理の一覧で削除を押すと、ブラウザの確かめの窓で受けた時だけ窓口を呼び、DB の行を消す。消した印を付けて残す形（論理削除）は採らず、戻す手段は無い。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | DRV-STOCKIST-014、FR-ADMIN-006、SEC-STOCKIST-013 |
| 対象のコード | `src/app/api/admin/stockists/[id]/route.ts`、`src/components/StockistSection.tsx` |
| 関連文書 | `docs/03_BasicDesign/decisions/ADR-0023-news-hard-delete.md`（NEWS の同じ形） |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0264 店舗の削除は確かめの窓の後に行を消し、戻す手段を持たない

| 属性 | 値 |
| --- | --- |
| 上位 | DRV-STOCKIST-014、FR-ADMIN-006 |
| 根拠 | 外へ出したくない店は「非公開」への切り替えで隠せるので、削除は本当に要らない店を消すだけにし、消した印の列や戻す画面を持たないため（推定。判断の記録は無い）。押し間違いは確かめの窓で防ぐ |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/app/api/admin/stockists/[id]/route.ts`、`src/components/StockistSection.tsx`） |

#### 背景

- FR-ADMIN-006 は削除を求めるが、戻せるかは書かれていない
- 公開の状態の切り替えで、店を外から隠せる（ADR-0263）

#### 決定

- 画面は「このSTOCKISTを削除してもよろしいですか？」の窓で受けた時だけ窓口を呼ぶ（`StockistSection.tsx`）
- 窓口は id の行を DB から消す（`[id]/route.ts`）。監査の記録には消した id だけを書く

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 消した印を付けて残す（論理削除） | 非公開の切り替えで隠せるので要らない（推定）。表に消した印の列は無い |

#### 結果

- 良くなること: 表と取り出しの条件が簡単なまま
- 悪くなること: 誤って消した店は戻せない。監査の記録は id だけで、消した中身から作り直せない（SEC-STOCKIST-013 の求める形と合わない）。無い id を消しても DB は誤りを返さず、成功として記録される（推定）

## 未確認事項

- 削除を戻せなくてよいとユーザーが決めた記録
