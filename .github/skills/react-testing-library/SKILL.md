---
name: react-testing-library
description: React コンポーネントテストを @testing-library/react と @testing-library/jest-dom で設計・実装・実行・改善するためのスキル。アクセシビリティに基づくクエリ選定、非同期 UI の待機、ユーザー操作テスト、モック方針、失敗解析、フレーク対策が必要なときに使用する。React テスト、Testing Library、jest-dom、コンポーネント単体テスト、UI テストの依頼時はこのスキルを優先する。
---

# react-testing-library Skill

## 概要

このスキルは、React コンポーネントをユーザー視点で検証するための実践ガイドです。`@testing-library/react` と `@testing-library/jest-dom` を使い、壊れにくく、読みやすく、保守しやすいテストを作成します。

| 項目 | 内容 |
|---|---|
| 対象 | React コンポーネントの単体テスト |
| 使用ライブラリ | `@testing-library/react`, `@testing-library/jest-dom` |
| 主目的 | 振る舞い検証、回帰防止、アクセシビリティ準拠の確認 |

## When to Use This Skill

- React コンポーネントのテストを新規作成するとき
- 既存テストが実装依存になっており、振る舞いベースへ改善したいとき
- `getByRole` などアクセシブルなクエリに統一したいとき
- 非同期 UI（ローディング、フェッチ後表示、トーストなど）の待機設計で悩むとき
- `toBeInTheDocument` や `toHaveTextContent` など `jest-dom` アサーションを適切に使いたいとき
- フレークしやすい UI テストの安定化が必要なとき

## Prerequisites

- Node.js と npm が利用可能
- Jest がプロジェクトで動作すること
- 次の依存が導入済みであること

```bash
npm install -D @testing-library/react @testing-library/jest-dom
```

- `jest-dom` の matcher が有効化済みであること

```ts
// 例: jest.setup.ts
import '@testing-library/jest-dom';
```

## Step-by-Step Workflow

1. テスト対象の公開契約を明確化する
- props に応じた表示変化
- ユーザー操作に対する反応
- ローディング/エラーなど状態遷移

2. 観測ポイントをユーザー視点で定義する
- 役割（role）、ラベル（label）、表示テキストを軸に確認する
- 実装詳細（内部 state、private 関数）には依存しない

3. テストケースを作成する
- 正常系
- 境界値
- エラー系
- 非同期反映の完了待機が必要なケース

4. テストを実装する
- Arrange / Act / Assert を分離
- クエリ優先順位は `getByRole` を最上位にする
- `screen` を一貫利用して可読性を高める

5. 非同期を正しく待機する
- 非同期表示は `findBy*` を優先
- 複数条件待機は `waitFor` を使用
- タイマー依存ロジックは fake timers を検討

6. 実行と安定化を行う
- 対象ファイル単体で実行し、失敗原因を局所化
- ランダム値、時刻、グローバル状態を固定
- 共有モック状態は各テストで初期化

## Query and Assertion Rules

- クエリ優先順
1. `getByRole`
2. `getByLabelText`
3. `getByText`
4. `getByTestId`（最終手段）

- `jest-dom` では曖昧判定より具体判定を優先
- 推奨アサーション例

```ts
expect(screen.getByRole('button', { name: /save/i })).toBeEnabled();
expect(screen.getByText('保存しました')).toBeInTheDocument();
expect(screen.getByRole('alert')).toHaveTextContent('エラーが発生しました');
```

## Anti-Patterns

- `container.querySelector` を主軸にした DOM 依存テスト
- 実装内部の関数呼び出し回数のみを検証して挙動を確認しないテスト
- `setTimeout` 任せで待つ固定 sleep
- すべてを `data-testid` に依存した検索
- `toBeTruthy` など意図の曖昧なアサーション

## Troubleshooting

| 問題 | 典型原因 | 対応 |
|---|---|---|
| `act(...)` 警告 | 状態更新の待機漏れ | `findBy*` または `waitFor` を使用 |
| ローカルでは通るが CI で失敗 | 実行速度差、時刻依存、競合 | 非同期待機を明示、時刻固定、依存の初期化 |
| 要素が見つからない | アクセシブルネームの不一致 | `getByRole` の `name` 条件を見直し、UI のラベルを確認 |
| 前テストの影響を受ける | モックやグローバル状態の汚染 | `beforeEach` / `afterEach` で `clearAllMocks` などを実施 |

## Output Expectations

このスキル使用時の出力は、次の順序で提示する。

1. テスト対象と観点の一覧
2. 追加・修正したテストコード
3. 実行コマンド
4. 失敗時の切り分け手順
5. 次の改善候補（不足ケース、安定化案）
