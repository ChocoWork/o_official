# 要件→チケット分割プロンプト

目的: 要件定義書（例: `docs/specs/*`）を読み、チケット単位に分割して `docs/tasks/` 配下にマークダウン形式で出力する。

使い方:
- 入力ファイル: 要件定義書（Markdown）を参照してください。複数ファイルがある場合は関連するファイルをすべて読みます。
- 出力先: `docs/tasks/` に各チケットを個別の Markdown ファイルとして出力してください。

出力フォーマット（必須）:
- ファイル名: 以下の優先ルールで決定してください。
	1. ソースファイルに基づく命名（優先）: 分割元の要件ファイルが `docs/specs/01_auth.md` のように与えられている場合、出力ファイルは `docs/tasks/01_auth_ticket.md` として保存してください。
		 - 1つの要件ファイルから複数チケットを生成する場合は連番サフィックスを付与します（例: `docs/tasks/01_auth_ticket-1.md`, `01_auth_ticket-2.md`）。
	2. チケット単位で命名する場合（フォールバック）: ソースファイル名が不明またはチケットID中心で管理する場合は `docs/tasks/<TICKET-ID>_<slug>.md` を使用してください（例: `docs/tasks/BE-01_user-auth.md`）。
- 内容: 下記テンプレート（`.github/prompts/templates/ticket_template.md`）を使ってください。YAML frontmatter を必ず含めること。

チケット設計ルール:
- チケットは1つの作業単位（開発者が自己完結して着手できる粒度）で作成する。
- 各チケットは「状態（Status）」「チケットID（Ticket ID）」「チケット名（Title）」「詳細（Description）」を必ず含む。
- 受け入れ条件（Acceptance Criteria）が明確でない場合は、要件に立ち戻り最小限の問い（何を満たせばDoneか）を3つ以内で定義する。曖昧点は必ず注記する。
- 優先度（Priority）、推定工数（Estimate）、依存関係（Dependencies）を可能な範囲で記載する。

管理ルール（ステータス）:
- ステータスは下記のいずれかを使用する: `todo`, `in-progress`, `review`, `blocked`, `done`。
- YAML frontmatter の `status:` を更新してステータス管理する（CI/ツールにより集計しやすくするため）。

出力例（ファイル最上部）:
```yaml
---
status: todo
id: BE-01
title: ユーザー認証の実装
priority: high
estimate: 3d
assignee: unassigned
dependencies: []
---
```

追加ガイド:
- 1要件に対して複数チケットが必要な場合は、優先度に基づき分割し、要件のどの部分を満たすかを Description に明確に書く。
- UI/UX 関連は `FE-`、バックエンドは `BE-`、ドキュメントは `DOC-` のようにプレフィックスを使って分類することを推奨する。
- 破壊的変更やDBスキーマの変更が想定されるチケットは、必ず `破壊的変更` タグを付与し、マイグレーション手順を要約する。

納品: 生成した各チケットは `docs/tasks/` にコミット可能な形で出力してください。ファイル名衝突がある場合は数値サフィックスを付ける（例: `BE-02_...-1.md`）。

注意: 仕様に無い挙動は勝手に追加しないこと。疑義がある場合は `TODO: question for product` を Description に残す。

---

プロンプト作成日: 2026-01-17
