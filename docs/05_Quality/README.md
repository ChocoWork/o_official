# 品質管理

## 概要

このディレクトリは、現行のテスト方針と過去の検証記録をまとめる。テストの存在・検出と実行結果は別に扱い、合否は実行日時、対象リビジョン、コマンド、環境を伴う記録で判断する。

| 場所 | 内容 | 扱い |
| --- | --- | --- |
| `docs/05_Quality/tests/test-spec.md` | テスト範囲、要件との対応、実施・判定方針 | 現行の方針 |
| [作業と指摘の台帳](reviews/code/2026-09-25-working-diff-security-review.md) | 決済・注文まわりのグループ A〜H の状態、指摘の今の状態、判断待ち、開店の準備 | 更新し続ける管理表（最後に調べた日を冒頭に書く） |
| [脅威（範囲内の 9 領域）](../README.md#範囲内の領域の文書) | 領域ごとの脅威とセキュリティ要件（`security/threats/<area>.md`） | 現行の正本 |
| [追跡の一覧](reports/trace-matrix.md) | 要求から受け入れ条件・E2E・構造設計・詳細設計・コード・単体テストまでのつながりと、文書とコードの食い違い | 自動生成（手書きは「食い違い」の節だけ） |
| [試験の穴](reports/test-gaps.md) | 試験が足りない項目、名前に ID の無い試験、飛ばしている試験、届かない分岐 | 自動生成（手書きは「届かない分岐」の節だけ） |
| [使われていないコードの候補](reports/unused-code.md) | 参照なし・試験だけが参照・要件につながらないコードの候補と、残すか消すかの判断 | 自動生成（手書きは「判断」の列だけ） |
| `docs/05_Quality/reviews/code/` | 日付付きコードレビュー | 作成時点の記録（上の台帳を除く） |
| `docs/05_Quality/reviews/security/` | 画面・機能別セキュリティレビュー | 作成時点の記録 |
| `docs/05_Quality/reviews/uiux/` | 画面別 UI/UX レビュー | 作成時点の記録 |
| `docs/05_Quality/reviews/accounting/` | 会計・税務の方針文書のレビュー（[売上の計上の方針](../01_Planning/revenue-recognition-policy.md)の AI レビュー1〜5回目） | 作成時点の記録 |
| [要件ID参照状況](reports/traceability-report.md) | 現行の文字列参照集計。充足・実行結果ではない | 自動生成 |
| `docs/05_Quality/reports/coverage-report-2026-02-01.md` | 2026-02-01 の旧カバレッジ出力 | 履歴。現行の網羅率ではない |

現行のテストコマンドは `package.json`、Jest の対象は `jest.config.cjs`、Playwright の対象とサーバー設定は `playwright.config.ts` を参照する。レビュー文書にある未対応・対応済みの表示は、その記録時点の判断であり、現在のコードまたは実行結果の証明ではない。

[シーケンス・状態設計の実装照合レビュー](reviews/code/2026-10-04-sequence-state-review.md)は、2026-10-04の対象API・状態管理対象から確認した文書の正確性と網羅性の記録である。
