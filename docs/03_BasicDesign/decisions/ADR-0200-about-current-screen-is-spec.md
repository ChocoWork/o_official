# ADR-0200 ABOUT は今の画面を正しい仕様とし、要件の文と E2E を画面に合わせる

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/about/page.tsx`、`e2e/FR-ABOUT-001`〜`004` | 基準コミット: `a03beaff`

## 概要

2026-06-28 の作り直しの後、要件の文と E2E が古い画面のままになっていた。2026-08-13 に「今の画面を正しい仕様とする」と決め、FR-ABOUT-002〜004 の文を置き換え、FR-ABOUT-001 の E2E の期待の文を今の文に合わせた。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の ABOUT |
| 対応する ID | FR-ABOUT-001、FR-ABOUT-002、FR-ABOUT-003、FR-ABOUT-004 |
| 対象のコード | `src/app/about/page.tsx`（4つの節と締めの CTA） |
| 関連文書 | `docs/superpowers/specs/2026-08-13-e2e-failure-triage.md`、`docs/superpowers/specs/2026-08-13-e2e-classification-5.md`、`docs/02_Requirements/requirements.md` の「1.8 アバウトページ（ABOUT）」節 |
| 要件の文書 | `docs/02_Requirements/areas/about.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0200 ABOUT は今の画面を正しい仕様とし、要件の文と E2E を画面に合わせる

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ABOUT-001、FR-ABOUT-002、FR-ABOUT-003、FR-ABOUT-004 |
| 根拠 | E2E の失敗が実装の欠陥か、要件と試験の古さかを決めないと直す先が決まらなかったため。失敗の仕分けで「本文の文とテストの期待が違い、どちらが正か判断が要る」とした FR-ABOUT-001 について、今の画面の文を正とした |
| 状態 | 推定 |
| 出どころ | `docs/superpowers/specs/2026-08-13-e2e-classification-5.md`、`docs/superpowers/specs/2026-08-13-e2e-failure-triage.md`、git `ed83933c`（2026-08-13） |

#### 背景

- git `cf822a96`（2026-06-28）で ABOUT を作り直し、節を Brand Philosophy・WHY WE MAKE・OUR COMMITMENTS・COLLECTION に変えた。要件の文と E2E は作り直しの前の画面（Quality & Craftsmanship の節、画像の2列など）を前提にしたままだった
- 2026-08-13 の E2E の失敗の仕分けで、FR-ABOUT-001 は「どちらの文言が正か」の判断が要る、と分けた（`2026-08-13-e2e-failure-triage.md`）

#### 決定

- 今の画面を正しい仕様とした（`2026-08-13-e2e-classification-5.md`）
- FR-ABOUT-002〜004 の文を `WHY WE MAKE`・`OUR COMMITMENTS`・`COLLECTION` と CTA の要件に置き換えた（`requirements.md` の「1.8 アバウトページ（ABOUT）」節）
- FR-ABOUT-001 の E2E の期待の文を今の文に合わせた。FR-ABOUT-001〜004 の4本・6件が通った
- FR-ABOUT-005 の h1 は SHOULD のまま残し、「別途判断」とした（決めていない）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 要件と E2E に合わせて画面を作り直し前に戻す | 作り直しで足したブランドの節（OUR COMMITMENTS など）を捨てることになる。仕分けの文書は今の画面を正とした（理由の詳しい記録は無い。推定） |

#### 結果

- 良くなること: FR-ABOUT-001〜004 の要件・E2E・画面がそろい、2026-10-24 の E2E 全件でも通っている
- 悪くなること: 置き換えたのは要件の文だけで、`requirements.md` の「1.8 アバウトページ（ABOUT）」節の「レビュー」の副行（画像の2列・Remixicon のアイコン）は古いまま
- 残り: FR-ABOUT-005〜008 は置き換えの対象にせず、今の画面と合わない（h1・CONTACT の CTA・アイコン・画像）。E2E 005〜008 は 2026-10-24 の E2E 全件で赤。h1 は「別途判断」のまま。画像とアイコンを置かない判断は ADR-0201、CTA の判断は ADR-0203

## 未確認事項

- 2026-08-13 の判断をユーザーがどう承認したかの記録（仕分けの文書は「判断により」とだけ書く）
