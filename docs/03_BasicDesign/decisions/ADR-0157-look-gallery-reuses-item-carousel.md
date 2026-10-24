# ADR-0157 LOOK の詳細の画像のギャラリーは、ITEM の詳細のカルーセルの部品を使い回して同じ見せ方にする

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/features/look/components/LookImageGallery.tsx` | 基準コミット: `4facf63b`

## 概要

LOOK の詳細の画像は、ITEM の詳細と同じ3つの幅の見せ方（モバイルは端まで広げたスワイプ、タブレットはスワイプと送りのボタン、PC は左のサムネイルの列とメインの画像）にする。送りのボタン・線のインジケータ・位置の計算は、ITEM の部品から読み込んで使い回し、LOOK の側には並べ方だけを書く。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の LOOK |
| 対応する ID | FREQ-179-REQ-01、FREQ-179-REQ-02、FREQ-179-REQ-03 |
| 対象のコード | `src/features/look/components/LookImageGallery.tsx`、`src/features/items/components/ItemImageCarousel.tsx`（ITEM の部品。範囲外） |
| 関連文書 | `docs/02_Requirements/requirements.md` |
| 要件の文書 | `docs/02_Requirements/areas/look.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0157 LOOK の詳細の画像のギャラリーは、ITEM の詳細のカルーセルの部品を使い回して同じ見せ方にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-179-REQ-01、FREQ-179-REQ-02、FREQ-179-REQ-03 |
| 根拠 | FREQ-179 は LOOK の詳細の画像を「ITEM 詳細ページと同様に」と求める。部品を写すと、片方を直した時にもう片方とずれるので、送りのボタン・インジケータ・位置の計算を1か所にした（推定） |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`、`src/features/look/components/LookImageGallery.tsx` のコメント、git `11011ff9`（2026-07-20、ギャラリーを ITEM と同じにしたコミット） |

#### 背景

- それまでの LOOK の詳細は、全部の幅で「メインの画像と下に横並びのサムネイル」だった（FREQ-179 の文）
- ITEM の詳細には3つの幅の見せ方が既にあった

#### 決定

- 送りのボタン、線のインジケータ、スクロールの位置から添字を出す計算、添字へスクロールする関数を ITEM の部品から読み込む（`LookImageGallery.tsx`）
- 送りのボタンの大きさも ITEM と同じく画像の枠の幅に対する比で決める

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| LOOK 用に同じ作りの部品を写して持つ | ITEM の側を直した時にずれる（推定。退けた記録は無い） |
| 共通の部品として `components/ui` に移す | 退けた記録は無い。今は ITEM の部品の中にある |

#### 結果

- 良くなること: ITEM と LOOK の詳細の画像の動きがそろう
- 悪くなること: LOOK が ITEM の領域の部品に頼る。ITEM の側で名前や動きを変えると LOOK の詳細も変わる。E2E の部品 `e2e/look-detail-test-utils.ts` も ITEM の試験（FR-ITEM-DETAIL-041）から使われ、両方向に結びつく
- 見直す条件: ITEM と LOOK の見せ方を分けたくなった時、部品を共通の置き場へ移す時

## 未確認事項

- 部品を使い回す形をユーザーが決めた記録（要件は「同様に」と書くだけ）
