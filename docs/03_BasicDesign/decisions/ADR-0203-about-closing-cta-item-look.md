# ADR-0203 ABOUT の締めの CTA は商品と LOOK の2つにし、NEWS・CONTACT へは置かない

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/about/page.tsx` | 基準コミット: `a03beaff`

## 概要

ABOUT の最後は締めの一文の下に `VIEW COLLECTION`（`/item`）と `VIEW LOOKBOOK`（`/look`）の2つの CTA だけを置く。レビューが提案した NEWS への CTA と、FR-ABOUT-006 が挙げる CONTACT への CTA は置かない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の ABOUT |
| 対応する ID | FR-ABOUT-004、DRV-ABOUT-001 |
| 対象のコード | `src/app/about/page.tsx`（締めの一文と CTA 2つ。`/item` と `/look`） |
| 関連文書 | `docs/05_Quality/reviews/uiux/uiux_review_about.md`、`docs/02_Requirements/requirements.md` |
| 要件の文書 | `docs/02_Requirements/areas/about.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0203 ABOUT の締めの CTA は商品と LOOK の2つにし、NEWS・CONTACT へは置かない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ABOUT-004、DRV-ABOUT-001 |
| 根拠 | ページを読み終えた人が共感から服を見る行動へ進めるように、締めの一文の後に次の行動を置くため（uiux A-2 の「共感から購入への導線」）。行き先は服そのもの（商品）と着こなし（LOOK）に絞った |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_about.md`、`docs/superpowers/specs/2026-08-13-e2e-classification-5.md`（FR-ABOUT-004 をこの CTA の要件に置き換えた）、実装から推定 |

#### 背景

- uiux のレビューは、ページが結びの一文も次の行動も無く終わる、と指摘し、締めの文と CTA（`VIEW COLLECTION` → `/item`、`STORY/NEWS` → `/news`）を提案した（A-2、`uiux_review_about.md`）
- 2026-06-20 の直しでは、2つ目の CTA を NEWS でなく `LOOKBOOK` → `/look` にした（`uiux_review_about.md`）
- `requirements.md` の FR-ABOUT-006（COULD）は `COLLECTIONを見る`・`LOOKBOOKを見る`・`CONTACTする` の CTA を挙げる

#### 決定

- 締めの一文「時を超えて価値の続く服を。」の下に、CTA を2つだけ置く
- 主の CTA は `VIEW COLLECTION`（`/item`、primary）、2つ目は `VIEW LOOKBOOK`（`/look`、secondary）
- 390px では縦、640px 以上では横に並べる（`page.tsx` の `flex-col sm:flex-row`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 2つ目の CTA を NEWS（`/news`）にする（uiux A-2 の提案） | 直しで LOOK に変えた。理由の記録は無い（推定: 服へ近い行き先を優先した） |
| CONTACT（`/contact`）への CTA も置く（FR-ABOUT-006、COULD） | 置いていない。置かないと決めた記録は無い（推定） |

#### 結果

- 良くなること: 行き先が2つに絞られ、締めが簡潔になる。FR-ABOUT-004 と E2E FR-ABOUT-004 は今の CTA に合う（2026-10-24 の E2E 全件で通過）
- 悪くなること: 問い合わせへの入口が ABOUT に無い。FR-ABOUT-006 の文言と E2E FR-ABOUT-006 は今の CTA と合わず、2026-10-24 の E2E 全件で赤
- 食い違い: FR-ABOUT-004 と FR-ABOUT-006 は締めの CTA という同じ物を違う文言で求める。旧版（基準コミット `a03beaff` 時点）の `docs/04_DetailDesign/pages/08_about.md` は `/contact` への CTA を「済」と書いていた。今は書き直し済み（`08_about.md`）
- 見直す条件: FR-ABOUT-006 を「廃止」にして FR-ABOUT-004 にまとめるか、CONTACT を足すかをユーザーが決めた時

## 未確認事項

- NEWS から LOOK に変えた理由と、CONTACT を置かない理由（どちらも記録が無い）
