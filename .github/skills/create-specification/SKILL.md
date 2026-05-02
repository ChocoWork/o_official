---
name: create-specification
description: 'Create a new specification as a GitHub Issue, optimized for Generative AI consumption.'
---

# Create Specification

現在のリポジトリで、`${input:SpecPurpose}` の新しい仕様を **GitHub Issue** として作成し、仕様に関するドキュメントを作成・更新することがあなたのゴールです。

仕様書は、ソリューションコンポーネントの要件、制約、インターフェースを、生成AIが効果的に利用できるように明確で曖昧さのない構造化された形で定義する必要があります。既存のドキュメント標準に従い、内容を機械可読かつ自己完結型にしてください。

## AI 向け仕様書のベストプラクティス

- 正確で明確、曖昧さのない言語を使用すること
- 要件、制約、推奨事項を明確に区別すること
- 見出し、リスト、表などの構造化フォーマットを使用して解析しやすくすること
- 慣用句、比喩、文脈依存の表現を避けること
- すべての略語およびドメイン固有の用語を定義すること
- 適用可能な場合は例やエッジケースを含めること
- ドキュメントが自己完結型であり、外部の文脈に依存しないことを確認すること

## Issue の作成方法

`gh` CLI を使用して GitHub Issue を作成する。

```bash
gh issue create --title "<タイトル>" --body "<Markdown 本文>"
```

- **タイトル規約**: `[SPEC] <目的カテゴリ>: <仕様の簡潔な説明>`
  - 目的カテゴリは `schema`, `tool`, `data`, `infrastructure`, `process`, `architecture`, `design` のいずれか
  - 例: `[SPEC] design: Web UI 画面設計仕様`、`[SPEC] architecture: 認証基盤設計`
- Issue 作成後、作成された Issue 番号をユーザーに報告すること

## Issue Body Template

Issue の body は以下のテンプレートに従い、すべてのセクションを適切に記述すること。

```md
# Introduction

[仕様書の簡潔な紹介と、その目的を記述します。]

## 1. Purpose & Scope

[仕様書の目的と適用範囲を明確かつ簡潔に記述します。対象読者や前提条件も明記します。]

## 2. Definitions

[この仕様書で使用されるすべての略語、頭字語、ドメイン固有の用語を定義します。]

## 3. Requirements, Constraints & Guidelines

[要件、制約、ルール、およびガイドラインを明確に列挙します。箇条書きや表を使用して明確にします。]

- **REQ-RR-SS**: Requirement 1
- **SEC-RR-SS**: Security Requirement 1
- **CON-RR-SS**: Constraint 1
- **GUD-RR-SS**: Guideline 1
- **PAT-RR-SS**: Pattern to follow 1
- **OTH-RR-SS**: Other Requirement 1

## 4. Interfaces & Data Contracts

[インターフェース、API、データ契約、または統合ポイントを記述します。スキーマや例を表やコードブロックで示します。]

## 5. Acceptance Criteria

[各要件に対して明確でテスト可能な受け入れ基準を定義します。適切な場合は Given-When-Then 形式を使用します。]

- **AC-01**: Given [context], When [action], Then [expected outcome]
- **AC-02**: The system shall [specific behavior] when [condition]
- **AC-03**: [Additional acceptance criteria as needed]

## 6. Test Automation Strategy

[テストアプローチ、フレームワーク、および自動化要件を定義します。]

- **Test Levels**: Unit, Integration, End-to-End
- **Frameworks**: Jest, @testing-library/react, @testing-library/jest-dom
- **Test Data Management**: [approach for test data creation and cleanup]
- **CI/CD Integration**: [automated testing in GitHub Actions pipelines]
- **Coverage Requirements**: 100%
- **Performance Testing**: [approach for load and performance testing]

## 7. Rationale & Context

[要件、制約、ガイドラインの背後にある理由を説明します。設計上の意思決定の文脈を提供します。]

## 8. Dependencies & External Integrations

[この仕様書に必要な外部システム、サービス、およびアーキテクチャ依存関係を定義します。**何が必要か**に焦点を当て、**どのように実装するか**には触れません。特定のパッケージやライブラリのバージョンは、アーキテクチャ上の制約を表す場合を除き避けてください。]

### External Systems
- **EXT-001**: [External system name] - [Purpose and integration type]

### Third-Party Services
- **SVC-001**: [Service name] - [Required capabilities and SLA requirements]

### Infrastructure Dependencies
- **INF-001**: [Infrastructure component] - [Requirements and constraints]

### Data Dependencies
- **DAT-001**: [External data source] - [Format, frequency, and access requirements]

### Technology Platform Dependencies
- **PLT-001**: [Platform/runtime requirement] - [Version constraints and rationale]

### Compliance Dependencies
- **COM-001**: [Regulatory or compliance requirement] - [Impact on implementation]

**Note**: This section should focus on architectural and business dependencies, not specific package implementations. For example, specify "OAuth 2.0 authentication library" rather than "Microsoft.AspNetCore.Authentication.JwtBearer v6.0.1".

## 9. Examples & Edge Cases

```code
// コードスニペットやデータ例を示し、ガイドラインの正しい適用方法を示します。エッジケースも含めます。
```

## 10. Validation Criteria

[この仕様書に準拠していることを確認するための基準やテストを列挙します。]

## 11. Related Specifications / Further Reading

[関連する仕様書 Issue や外部ドキュメントへのリンク]
```

## 要求仕様書の更新

- 要求仕様は docs/1_RequirementsDifinition/RequirementsDefinition.md を更新し、作成した仕様書 Issue へのリンクを追加すること。

### 要求仕様書ファイル構造

要求仕様書ファイルは、以下のテンプレートに厳密に従わなければなりません。各セクションは必須であり、具体的かつ実行可能な内容で埋める必要があります。AI エージェントは、実行前にテンプレート準拠を検証しなければなりません。

#### 要求仕様書テンプレート検証ルール

- すべてのフロントマター項目が存在し、正しい形式で記述されていること
- すべてのセクション見出しが完全一致していること（大文字・小文字を区別する）
- すべての識別子接頭辞が指定形式に従っていること
- 表には必須列がすべて含まれ、各タスクの詳細が具体的に記載されていること
- 最終出力にプレースホルダーテキストが残っていないこと

#### 要求ID凡例
| 要求ID | 意味 |
|---|---|
| **FREQ-RR** | 機能要求 |
| **NFREQ-RR** | 非機能要求 |

### 要求仕様書テンプレート

## 要件定義書の更新

- 要件定義は docs/2_Specs/spec.md を更新し、作成した仕様書 Issue へのリンクを追加すること。

### 要件定義書ファイル構造

要件定義書ファイルは、以下のテンプレートに厳密に従わなければなりません。各セクションは必須であり、具体的かつ実行可能な内容で埋める必要があります。AI エージェントは、実行前にテンプレート準拠を検証しなければなりません。

#### 要件定義書テンプレート検証ルール

- すべてのフロントマター項目が存在し、正しい形式で記述されていること
- すべてのセクション見出しが完全一致していること（大文字・小文字を区別する）
- すべての識別子接頭辞が指定形式に従っていること
- 表には必須列がすべて含まれ、各タスクの詳細が具体的に記載されていること
- 最終出力にプレースホルダーテキストが残っていないこと

#### 要件ID凡例

| 要件ID | 意味 |
|---|---|
| **REQ-RR-SS** | 要件 |
| **SEC-RR-SS** | セキュリティ要件 |
| **CON-RR-SS** | 制約 |
| **GUD-RR-SS** | ガイドライン |
| **PAT-RR-SS** | 準拠すべきパターン |
| **OTH-RR-SS** | その他の要件 |

### 要件定義書テンプレート

```md

## 凡例

### 要求ID凡例

| 要求ID | 意味 |
|---|---|
| **FREQ-RR-SS** | 機能要求 |
| **NFREQ-RR-SS** | 非機能要求 |

### 要件ID凡例

| 要件ID | 意味 |
|---|---|
| **REQ-RR-SS** | 要件 |
| **SEC-RR-SS** | セキュリティ要件 |
| **CON-RR-SS** | 制約 |
| **GUD-RR-SS** | ガイドライン |
| **PAT-RR-SS** | 準拠すべきパターン |
| **OTH-RR-SS** | その他の要件 |

## 要求と要件のトレーサビリティ

| 要求ID  | 要求の内容 | 要件ID      | 要件の内容    | 受け付け基準ID | 受け付け基準の内容 |
|---------|-----------|------------|---------------|----------------|------------------|
| FREQ-01-01 | ユーザーが基本機能を利用できること | REQ-01-01-01 | 基本機能の操作が正常に完了すること | FREQ-AC-01-01-01 | 基本機能でエラーが発生せず操作が完了すること |
| FREQ-01-02 | ユーザーの認証状態が維持されること | SEC-01-02-01 | 認証情報は安全に管理されること | FREQ-AC-01-02-01 | 認証後のセッションが適切に維持されること |
| FREQ-01-03 | システムが安定して応答すること | REQ-01-03-01 | 平常時のレスポンス性能を満たすこと | FREQ-AC-01-03-01 | 標準操作で応答時間が許容値以下であること |
| FREQ-01-03 | システムが安定して応答すること | CON-01-03-02 | 可用性の制約を満たすこと | NFREQ-AC-01-03-02 | 連続稼働の可用性が規定値以上であること |
| NFREQ-01-01 | 運用性が高いこと | GUD-01-01-01 | ログは追跡しやすく出力されること | NFREQ-AC-01-01-01 | すべてのエラーイベントが構造化ログとして出力されること |

```

