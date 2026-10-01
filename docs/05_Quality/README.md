# 品質管理

## 概要

このディレクトリは、現行のテスト方針と過去の検証記録をまとめる。テストの存在・検出と実行結果は別に扱い、合否は実行日時、対象リビジョン、コマンド、環境を伴う記録で判断する。

| 場所 | 内容 | 扱い |
| --- | --- | --- |
| `docs/05_Quality/tests/test-spec.md` | テスト範囲、要件との対応、実施・判定方針 | 現行の方針 |
| `docs/05_Quality/reviews/code/` | 日付付きコードレビュー | 作成時点の記録 |
| `docs/05_Quality/reviews/security/` | 画面・機能別セキュリティレビュー | 作成時点の記録 |
| `docs/05_Quality/reviews/uiux/` | 画面別 UI/UX レビュー | 作成時点の記録 |
| [要件ID参照状況](reports/traceability-report.md) | 現行の文字列参照集計。充足・実行結果ではない | 自動生成 |
| `docs/05_Quality/reports/coverage-report-2026-02-01.md` | 2026-02-01 の旧カバレッジ出力 | 履歴。現行の網羅率ではない |

現行のテストコマンドは `package.json`、Jest の対象は `jest.config.cjs`、Playwright の対象とサーバー設定は `playwright.config.ts` を参照する。レビュー文書にある未対応・対応済みの表示は、その記録時点の判断であり、現在のコードまたは実行結果の証明ではない。
