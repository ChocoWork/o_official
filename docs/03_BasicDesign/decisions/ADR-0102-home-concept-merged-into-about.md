# ADR-0102 ホームのブランドの考えと3本柱は ABOUT の区画にまとめ、独立した CONCEPT の区画を置かない

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/page.tsx` | 基準コミット: `a03beaff`

## 概要

ヒーローの直下に一度作った CONCEPT の区画をやめ、ブランドの考えの文・差別化の3本柱・READ OUR STORY のボタンを、ホームの ABOUT の区画1つにまとめた。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の HOME |
| 対応する ID | FR-HOME-003、DRV-HOME-002 |
| 対象のコード | `src/app/page.tsx` の `Home` の `section#about`（ABOUT の区画。考えの文・3本柱・READ OUR STORY・画像） |
| 関連文書 | `docs/05_Quality/reviews/uiux/uiux_review_home.md`、git `74fd4767`（2026-06-23「HOMEページにABOUTセクションを統合し、ブランドの差別化要素を明確化」） |
| 要件の文書 | `docs/02_Requirements/areas/home.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0102 ホームのブランドの考えと3本柱は ABOUT の区画にまとめ、独立した CONCEPT の区画を置かない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-HOME-003、DRV-HOME-002 |
| 根拠 | ヒーローを名前だけにした（ADR-0101）ので、考えと他との違い（天然繊維・受注生産・ユニセックス）はどこか1か所で伝える必要があった。CONCEPT と ABOUT の2つの区画に分けると同じ話が2回出るので、`/about` への導線を持つ ABOUT の区画1つに集めた（推定） |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_home.md`（2026-06-22「CONCEPT → ABOUT 統合」）。ユーザーが選んだ記録は無い |

#### 背景

- UI/UX レビュー H-7 は、ホームの ABOUT が概要だけで差別化が無いと指摘した（`uiux_review_home.md`）
- 2026-06-20 にヒーローを名前だけに決め、その直下に CONCEPT の区画を新しく作った（`uiux_review_home.md`）
- 2026-06-22 に CONCEPT の区画をやめ、ABOUT の区画へまとめた（`uiux_review_home.md`）

#### 決定

- ABOUT の区画に、考えの文2つ、3本柱（英字の題・日本語・説明）、READ OUR STORY（`/about`）、`/about.png` の画像を置く（`page.tsx`）
- 独立した CONCEPT の区画は置かない

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| ヒーローの直下に CONCEPT の区画を置く（2026-06-20 の形） | 2026-06-22 にやめた。理由は記録に無い（同じ話の重なりを避けたと推定） |
| 検索の窓の直後に薄い CONCEPT の抜粋を足す（H-8 の 2026-06-23 の対応） | レビューは「対応済」と書くが、今の頁に無い（`Home` の検索の窓と ITEM の区画の間に区画が無い）。足したのか、足して後で消したのかは記録に無い |

#### 結果

- 良くなること: 考えと3本柱が1か所にまとまり、そこから `/about` へ進める
- 悪くなること: ABOUT の区画は NEWS の下にあり、考えに共感して買う人には下すぎる（H-8 の懸念が残る）
- 3本柱の英字の題の1つが「TIMELSS」と綴られている（`src/app/page.tsx`。TM-HOME-17）

## 未確認事項

- CONCEPT を ABOUT にまとめた判断をユーザーが選んだか（記録は作業の反映だけ）
- H-8 の CONCEPT の抜粋の行方（レビューは対応済、今の頁には無い）
- 「TIMELSS」の綴りを直すか
