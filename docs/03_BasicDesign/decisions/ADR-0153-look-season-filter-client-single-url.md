# ADR-0153 シーズンの絞り込みは1つだけを選び、画面の側で全件から絞って、URL の season に残す

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/look/page.tsx`、`src/features/look/components/PublicLookGrid.tsx`、`src/lib/look/public.ts` | 基準コミット: `4facf63b`

## 概要

`/look` のシーズンの絞り込み（ALL・SS・AW）は、複数選択の部品を使いながら最後に選んだ1つだけを残す。サーバーは公開の LOOK を全部渡し、画面の側の部品が季節で絞る。選んだ値は URL の `season` に書き、頁を開き直しても同じ絞りで始める。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の LOOK |
| 対応する ID | FR-LOOK-ALL-006、FREQ-51-REQ-01、DRV-LOOK-002 |
| 対象のコード | `src/app/look/page.tsx`、`src/features/look/components/PublicLookGrid.tsx`、`src/lib/look/public.ts` |
| 関連文書 | `docs/02_Requirements/requirements.md`、`docs/03_BasicDesign/ui/screen-list.md` |
| 要件の文書 | `docs/02_Requirements/areas/look.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0153 シーズンの絞り込みは1つだけを選び、画面の側で全件から絞って、URL の season に残す

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-ALL-006、FREQ-51-REQ-01、DRV-LOOK-002 |
| 根拠 | 選択肢が ALL・SS・AW の3つだけで、SS と AW を両方選ぶと ALL と同じになるため1つに絞った（推定）。NEWS の一覧と同じ置き場と部品（FREQ-51）にするため複数選択の部品を使い、値を1つに丸める。件数が少ないので全件を渡して画面で絞れば、切り替えのたびにサーバーへ行かずに済む。URL に残すと、絞った頁を送ったり「戻る」で前の選択に戻したりできる |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md` のレビューの注（MultiSelect で単一シーズンを切り替える）、git `b1f380b5`（2026-05-23、絞り込みを足したコミット）、実装から推定 |

#### 背景

- FR-LOOK-ALL-006 で ALL・SS・AW の絞り込みを足し、FREQ-51 で置き場を NEWS の一覧と同じ左のサイドバーと FILTER の引き出しにした
- 公開の LOOK は全件を1回で取る（ADR-0152）

#### 決定

- 頁は URL の `season` を読んで正しい値（ALL・SS・AW）に直し、初めの値として部品に渡す。LOOK は全件を渡す（`look/page.tsx`、`public.ts`）
- 部品は複数選択の値から最後の1つを残す（`public.ts`、`PublicLookGrid.tsx`）
- 選ぶたびに URL の `season` を書き換えて履歴を1つ足し、画面の位置は動かさない。ALL の時は `season` を消す（`PublicLookGrid.tsx`）
- 季節（SS・AW）だけで絞り、年は見ない（`public.ts`、`PublicLookGrid.tsx`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| SS と AW を同時に選べる複数選択 | 両方を選ぶと ALL と同じになり、選ぶ意味が無い（推定） |
| `season` をサーバーで読んで DB の条件で絞る | 切り替えのたびにサーバーへ行く。件数が少ないうちは要らない（推定） |
| 選んだ値を画面の中の状態だけに持つ | 絞った頁を送れず、「戻る」で前の選択に戻らない（DRV-LOOK-002） |

#### 結果

- 良くなること: 切り替えが速く、絞った状態を URL で共有できる
- 悪くなること: 「2026 SS」と「2027 SS」が同じ絞りに入る。年で絞りたいかは確かめていない。LOOK が増えると全件を毎回送る（ADR-0152）
- 見直す条件: シーズンの年でも絞りたくなった時、LOOK の数が全件を送れないほど増えた時

## 未確認事項

- 1つだけを選ぶ形と、年を見ない形をユーザーが決めた記録
