# 設計判断（ADR）の案内

> 状態: 文書索引 | 確認日: 2026-10-25 | 対象: `docs/03_BasicDesign/decisions/`

## 概要

範囲（`scripts/trace/scope.json`）に入っている 9 領域の設計判断を、1つの判断を1つのファイル（`ADR-NNNN-<slug>.md`）で置く。番号は領域ごとに帯を分け、振ったら変えない。書き方は [`documentation-guide` スキル](../../../.claude/skills/documentation-guide/SKILL.md)の ADR の型に従う。各領域の構造設計は[領域ごとの構造設計](../../README.md#範囲内の領域の文書)から探す。

## 番号の帯

| 領域 | ADR の番号 | 構造設計 |
| --- | --- | --- |
| NEWS | 0001〜0099 | [news](../areas/news.md) |
| HOME | 0100〜0149 | [home](../areas/home.md) |
| LOOK | 0150〜0199 | [look](../areas/look.md) |
| ABOUT | 0200〜0249 | [about](../areas/about.md) |
| STOCKIST | 0250〜0299 | [stockist](../areas/stockist.md) |
| SEARCH | 0300〜0349 | [search](../areas/search.md) |
| PRIVACY | 0350〜0399 | [privacy](../areas/privacy.md) |
| AUTH | 0400〜0449、0463〜0471（パスキー） | [auth](../areas/auth.md) |
| ADMIN | 0450〜0462 | [admin](../areas/admin.md) |

新しい領域を範囲に足すときは、空いている帯を `scope.json` の `docs` の型に合わせて決め、この表に足す。

パスキーの段1a で ADMIN の帯を `ADR-045*`・`ADR-046[0-2]*` に狭めた（`scripts/trace/scope.json`）。ADR-0470 は段2 Task 9 で AUTH の範囲に足した。ADR-0471〜0479 は段3a Task 2 で AUTH の範囲に足した（`ADR-047[1-9]*.md`）。ADR-0480 以後はどの範囲にも入らないので、足す時に `scripts/trace/scope.json` に範囲を足す。
