# 文書の案内

> 状態: 現行の文書体系 | 確認日: 2026-10-02 | 対象: `docs/` の追跡済み文書

## 概要

このディレクトリは、企画から運用までの**現在の判断に使う文書**を工程別に置く。要件と設計の正本、実装を調べる入口、過去のレビュー・作業記録を区別する。現行の振る舞いを判断するときは、要件、設計、対象コード、テストを照合する。日付付きのレビューや計画の「済」「Fixed」は記録時点の判断であり、現在の実装や本番状態を保証しない。

## 工程別の入口

| 工程 | 文書 | 正本として扱う内容 |
| --- | --- | --- |
| 企画 | [ブランド](01_Planning/brand.md)、[システムコンテキスト](01_Planning/system-context.md)、[KPI用語](01_Planning/kpi.md) | 目的、利用者、外部システム、事業上の前提 |
| 要件定義 | [要求の出所](02_Requirements/stakeholder-requirements.md)、[要件と受け入れ条件](02_Requirements/requirements.md)、[ユースケース](02_Requirements/use-cases.md) | 要求ID、要件ID、優先度、受け入れ条件 |
| 基本設計 | [画面一覧](03_BasicDesign/ui/screen-list.md)、[画面遷移](03_BasicDesign/ui/screen-flow.md)、[システム構成](03_BasicDesign/architecture/system-overview.md)、[ER図](03_BasicDesign/data/er.md)、[API概要](03_BasicDesign/api/api-spec.md)、[全ルート一覧](03_BasicDesign/api/route-inventory.md) | 境界、主要構成、画面・データ・APIの契約 |
| 詳細設計 | [詳細設計の案内](04_DetailDesign/README.md)、[認証シーケンス](04_DetailDesign/sequence/auth-login-mfa.md)、[注文・決済の状態](04_DetailDesign/states/order-payment.md) | ページ・処理・状態ごとの入出力と例外 |
| 品質確認 | [品質文書の案内](05_Quality/README.md)、[テスト仕様](05_Quality/tests/test-spec.md)、[要件ID参照状況](05_Quality/reports/traceability-report.md) | テスト観点、証跡、レビュー記録 |
| 運用 | [運用文書の案内](06_Operations/README.md)、[デプロイ・運用構成](06_Operations/deployment-topology.md) | 配置と運用手順。稼働状態は別途実測する |

## 文書の役割と更新規則

| 区分 | 更新規則 |
| --- | --- |
| 正本 | 現行の要求・契約・設計を記す。変更時に関連する要件、設計、テストを同時に確認する |
| 実装根拠 | ルート、型、マイグレーション、ワークフローなど確認可能なファイルを相対リンクで示す。実装から推定した内容は推定と明記する |
| 履歴記録 | 日付付きレビュー、カバレッジ報告、過去のマイグレーション手順は当時の記録として保持する。最新の正本へは必要な結論だけを反映する |
| 作業記録 | [`superpowers/`](superpowers/) の設計案と実装計画は作業過程の記録。現行契約を上書きしない |

要件ID・受け入れ条件IDは移動に伴って振り直さない。新しい文書を追加するときは、対応する要件ID、設計、テストをリンクで結び、重複した要件本文を別の正本として作らない。`docs/ui-mocks` は Git 管理外のローカル画像であり、今回の追跡済み文書体系には含めない。

## 共通フォーマット

すべての**新規・更新する正本文書**には次を使う。対象がない項目は省略できるが、空の見出しや根拠のない「実装済み」は置かない。

1. `#` 文書名。直後に状態、確認日、対象、必要なら基準コミットを記す。
2. `## 概要`。目的、対象範囲、読み手が得る結論を短く示す。
3. `## 範囲と根拠`。対応要件ID、対象コード、関連文書、調査時点と未確認範囲を示す。
4. 本文。図は Mermaid とし、図の境界、矢印の意味、例外を文章で補う。
5. `## 未確認事項`。実測していない本番設定や未定の契約を明示する。

| 文書種別 | 本文の最小構成 |
| --- | --- |
| 企画・コンテキスト | 目的、利用者・外部システム、境界、前提・制約、成功指標 |
| 要件・ユースケース | 安定ID、出所、利用者と目的、事前条件、通常・代替フロー、受け入れ／検証方法 |
| 基本設計 | 品質目標、制約、境界、主要構成、データとAPIの契約、重要な設計判断、リスク |
| 詳細設計 | 対応要件ID、入出力、正常・異常フロー、状態・永続化、認証認可、テスト観点 |
| テスト仕様 | 対象要件ID、レベル・環境、事前条件、入力・手順、期待結果、実行結果と証跡の参照 |
| レビュー記録 | 対象のリビジョンと範囲、観点、指摘ID・根拠・重大度・状態、再確認日 |
| 運用手順 | 発動条件、影響、担当、手順、成功確認、ロールバック、記録・連絡先の管理場所 |

これらはプロジェクトに合わせた書式であり、ISO や OpenAPI への形式的な準拠宣言ではない。APIの機械可読な完全契約を管理する場合は OpenAPI を正本とし、手書きの一覧との二重管理を避ける。現時点の [API一覧](03_BasicDesign/api/api-spec.md) はソースから確認した入口であり、全 Route Handler の OpenAPI 定義ではない。

## 採用した参考資料

- [NASA Requirements Management](https://www.nasa.gov/reference/6-2-requirements-management/)：要求の出所と双方向トレーサビリティ。
- [arc42](https://arc42.org/overview/)：目的、制約、構成、判断、品質、リスクを設計文書に合わせて取捨選択する考え方。
- [C4 model diagrams](https://c4model.com/diagrams)：コンテキスト図とコンテナ図によるシステム境界の表現。
- [OpenAPI Specification](https://spec.openapis.org/oas/latest.html)：HTTP APIの機械可読な契約。
- [ISTQB CTFL syllabus](https://istqb.org/wp-content/uploads/2024/11/ISTQB_CTFL_Syllabus_v4.0.1.pdf)：テスト計画の範囲、リスク、環境、開始・終了基準。
- [Google SRE: Effective Troubleshooting](https://sre.google/sre-book/effective-troubleshooting/)：運用時の観測、問題の切り分け、手順化。

## 保守時の確認

文書を移動・更新した後は `npm.cmd run validate-docs` で Markdown と相対リンクを確認する。設計やコードとの整合性を確認したうえで、必要なテストを実行し、`graphify update .` で知識グラフを更新する。テストの発見件数と実行成功件数は区別して記録する。
