# 要求文書

## 概要

このフォルダーは、事業上の要求、システム要件、主要ユースケースの入口をまとめる。要求の詳細と受け付け基準の正本は[要件定義書](requirements.md)であり、[ユースケース一覧](use-cases.md)は既存の要求IDを目的別に探すための索引である。

| 文書 | 用途 |
| --- | --- |
| [ステークホルダー要求](stakeholder-requirements.md) | 利用者と管理者が求める成果、事業上の目標 |
| [要件定義書](requirements.md) | 機能・非機能要件、優先度、受け付け基準 |
| [ユースケース一覧](use-cases.md) | 主要な利用者目的と要求IDの対応 |
| 範囲内の 9 領域（[news](areas/news.md)・[home](areas/home.md)・[look](areas/look.md)・[about](areas/about.md)・[stockist](areas/stockist.md)・[search](areas/search.md)・[privacy](areas/privacy.md)・[auth](areas/auth.md)・[admin](areas/admin.md)） | 要求・要件・受け入れ条件・セキュリティ要件・派生要件の項目（この領域の ID の定義の正本。`requirements.md` の写し元の行は定義に数えない。[領域の文書の一覧](../README.md#範囲内の領域の文書)） |

## 読み方

1. [ステークホルダー要求](stakeholder-requirements.md)で目的と利用者を確認する。
2. [ユースケース一覧](use-cases.md)で該当する要求IDを探す。
3. [要件定義書](requirements.md)で詳細条件と受け付け基準を確認する。

要件定義書には後続の個別節で同じ `FREQ` 番号が別文脈にも使われている箇所がある。参照時はIDだけで判断せず、要求文と節も確認する。コード上の入口を示すリンクは実装完了の判定ではない。
