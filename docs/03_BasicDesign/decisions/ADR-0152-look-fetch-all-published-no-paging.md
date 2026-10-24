# ADR-0152 一覧と詳細の前後のナビは、公開の LOOK を件数の上限なしに全部取り、作った日時の新しい順の並びで決める

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/look/page.tsx`、`src/app/look/[id]/page.tsx`、`src/lib/look/server.ts` | 基準コミット: `4facf63b`

## 概要

`/look` は公開の LOOK を1回で全部取り、ページ分けも追加の読み込みもしない。詳細の頁も前後の LOOK を決めるために同じ全件を取り、その並びの中の位置で前と次を選ぶ。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の LOOK |
| 対応する ID | DRV-LOOK-001、FR-LOOK-DETAIL-003（FR-LOOK-ALL-003 はこの判断が退けた案なので上位にしない。「退けた案」と「結果」を参照） |
| 対象のコード | `src/app/look/page.tsx`、`src/app/look/[id]/page.tsx`、`src/lib/look/server.ts` |
| 関連文書 | `docs/04_DetailDesign/pages/07_look_detail.md`、`docs/05_Quality/reviews/security/security_review_look.md`、`docs/02_Requirements/requirements.md` |
| 要件の文書 | `docs/02_Requirements/areas/look.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0152 一覧と詳細の前後のナビは、公開の LOOK を件数の上限なしに全部取り、作った日時の新しい順の並びで決める

| 属性 | 値 |
| --- | --- |
| 上位 | DRV-LOOK-001、FR-LOOK-DETAIL-003 |
| 根拠 | LOOK はシーズンごとに数件ずつ増えるだけで件数が少なく、全部を1回で取れば一覧の絞り込み（ADR-0153）も詳細の前後も同じ並びから決められるため（推定）。LOOK の表に公開日の列が無いので、並びは作った日時の新しい順にした |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/lib/look/server.ts`、`src/app/look/[id]/page.tsx`）、`docs/04_DetailDesign/pages/07_look_detail.md`（「全件取得後にインデックスで前後ルックを特定」）。判断の記録は無い |

#### 背景

- FR-LOOK-ALL-003（COULD）は「ページングか無限スクロールで6件以上」を求めるが、実装していない（`requirements.md` のレビューの注は「未実装」）
- E2E の手元の見本は LOOK が7件（`docs/superpowers/plans/2026-10-05-e2e-local-supabase.md`）

#### 決定

- 一覧は件数の引数を渡さずに `getPublishedLooks` を呼び、公開の LOOK を全部取る（`look/page.tsx`、`server.ts`）
- 詳細も全件を取り、今の LOOK の位置を探して、1つ前を「前」、1つ後を「次」にする（`look/[id]/page.tsx`）。並びは作った日時の新しい順（`server.ts`）
- 頁の title などのメタ情報だけは、1件の取り出し `getPublishedLookById` を使う（`look/[id]/page.tsx`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 一覧にページ分けか追加の読み込みを付ける（FR-LOOK-ALL-003） | 件数が少ないうちは要らない（推定）。COULD のまま残っている |
| 詳細の前後を、作った日時の前後の1件ずつを DB に聞いて決める | 全件の並びと同じ結果を2回の問い合わせで出す手間が要る（推定。退けた記録は無い） |

#### 結果

- 良くなること: 一覧・絞り込み・前後の並びが1つの取り出しで揃う
- 悪くなること: LOOK が増えると、一覧も詳細も毎回全件と全部の画像の署名を作る（`security_review_look.md`、Open・Medium）。SEC-LOOK-009（件数の上限と要る項目だけ）と合わない。FR-LOOK-ALL-003（ページングか無限スクロール）も満たさないので、上位にしない。詳細の1回の表示で、メタ情報と本体が別々に取り出して署名する
- 見直す条件: 公開の LOOK の数が頁の速さに響くほど増えた時、FR-LOOK-ALL-003 を実装する時

## 未確認事項

- 全件を取る形をユーザーが決めた記録
- 並びを作った日時にしたこと（公開した日時ではない）でよいか
