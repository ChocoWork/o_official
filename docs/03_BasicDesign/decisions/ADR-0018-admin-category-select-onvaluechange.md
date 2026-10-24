# ADR-0018 管理のニュースの分類の選択欄は選んだ値で受け、共通の選択欄の部品は変えない

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/app/admin/news/NewsForm.tsx` | 基準コミット: `a03beaff`

## 概要

管理のニュースの作成・編集の分類の選択欄は、dropdown の部品が渡す値の文字列（`onValueChange`）で受けて保存する。不具合は受ける側で直し、共通の `SingleSelect` は変えない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | FREQ-515-REQ-01（範囲外） |
| 対象のコード | `src/app/admin/news/NewsForm.tsx` |
| 関連文書 | `docs/superpowers/plans/2026-10-23-launch-fixes-wave1.md`、`docs/02_Requirements/requirements.md`（FREQ-515（範囲外）） |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0018 管理のニュースの分類の選択欄は選んだ値で受け、共通の選択欄の部品は変えない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-515-REQ-01（範囲外） |
| 根拠 | 選択欄の値の受け方を誤ると選んだ値と違う値が保存され、お知らせの分類もこの不具合の1つだったため、部品の種類（dropdown）に合った受け方にそろえた（FREQ-515（範囲外））。共通の `SingleSelect` はほかの35か所で正しく動いているので、受ける側だけを直す（計画 X-1） |
| 状態 | 現行 |
| 出どころ | `docs/superpowers/plans/2026-10-23-launch-fixes-wave1.md`、git `bf728a3c`（2026-10-23） |

#### 背景

開店前の直しの波1で、選択欄の受け渡しの食い違い（X-1・X-2）が見つかった。お知らせの作成・編集で選んだ分類が保存に届いていなかった。

#### 決定

- `NewsForm.tsx` の分類の選択欄は `onValueChange` で `category` を直接更新する（`NewsForm.tsx`）
- `SingleSelect` 自体と、正しく動いているほかの35か所は変えない

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 共通の `SingleSelect` の渡し方を変える | ほかの35か所は正しく動いている（計画は「変えない」と書く。影響が広いからという理由は推定） |

#### 結果

- 良くなること: 選んだ分類で保存される（`tests/unit/components/NewsForm.test.tsx`、E2E `e2e/FR-ADMIN-108-select-fields.spec.ts` は範囲外）
- 見直す条件: 共通の選択欄の部品の渡し方をそろえ直す時

## 未確認事項

- 無し
