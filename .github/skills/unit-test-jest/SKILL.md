---
name: unit-test-jest
description: Jest を使ったユニットテストの設計・実装・実行・失敗解析のためのスキル。Jest、ts-jest、React Testing Library、モック、カバレッジ、非同期テスト、スナップショットの相談や実装時に使用する。ユニットテストを追加したい、壊れたテストを直したい、テスト戦略を見直したい場合に使う。
---

# unit-test-jest Skill

Jest を中心に、単体テストを安定して追加・保守するための実践ガイド。

## When to Use This Skill

- Jest でユニットテストを新規作成するとき
- 既存テストの失敗原因を切り分けるとき
- React コンポーネントを React Testing Library で検証するとき
- モック方針（`jest.mock` / `spyOn` / 手動モック）を決めたいとき
- カバレッジを確認し、重要経路の不足を埋めたいとき

## Prerequisites

- Node.js と npm が利用可能
- プロジェクトに Jest 設定があること（例: `jest.config.cjs`）
- TypeScript 使用時は `ts-jest` または同等のトランスパイル設定があること
- React UI テストでは `@testing-library/react` と `@testing-library/jest-dom` が導入済みであること

## Workflow

1. 対象の責務を定義する
- 何を守るテストかを先に固定する
- 実装詳細ではなく公開インターフェース基準で観測点を決める

2. テスト観点を分解する
- 正常系
- 境界値
- 異常系
- 依存失敗（API 失敗、タイムアウト、例外）

3. テストを配置する
- 既存プロジェクト規約に合わせる（同階層 `*.test.ts` または `tests/` 配下）
- 1 ファイル 1 主要責務を優先

4. 実装する
- Arrange / Act / Assert を明確に分離
- テスト名は期待結果を含む自然文にする
- 非同期は `async/await` を優先し、待機漏れを防ぐ

5. 実行する
- 全体実行: `npm test`
- 単体実行: `npx jest path/to/file.test.ts`
- 監視実行: `npx jest --watch`
- カバレッジ: `npx jest --coverage`

6. 失敗を解析する
- 再現性を確認（同条件で再実行）
- テストコードの非決定要素（時刻、乱数、グローバル状態）を排除
- 必要なら Fake Timers や `beforeEach/afterEach` で隔離

## Jest Design Rules

- 1 テストケース 1 振る舞い
- 外部依存は最小限のモックで固定し、ドメインロジックはモックしすぎない
- `toBeTruthy` など曖昧アサーションより、具体アサーションを優先
- スナップショットは UI 契約の固定に限定し、乱用しない
- フレーク対策として時間依存・順序依存・共有状態依存を避ける

## React Testing Library Rules

- 実装詳細よりユーザー視点のクエリを優先（`getByRole` など）
- `data-testid` は最後の手段として使用
- 非同期描画は `findBy*` / `waitFor` で待機を明示
- アクセシブルネームを含む検証を優先して壊れにくくする

## Troubleshooting

| 問題 | 典型原因 | 対応 |
|---|---|---|
| テストが CI でのみ失敗 | 環境差分、時刻/タイムゾーン依存 | 時刻固定、環境変数固定、ロケール固定 |
| `open handle` 警告 | 非同期リソース未解放 | `afterEach` でクリーンアップ、サーバー/タイマーを停止 |
| モックが次ケースへ漏れる | グローバルモック状態の残存 | `jest.clearAllMocks()` と `jest.restoreAllMocks()` を適用 |
| React の act 警告 | state 更新の待機漏れ | `await` と `waitFor` を使い、更新完了を待つ |

## Output Expectations

このスキルを使うときは、以下の順で成果物を返す。

1. テスト対象と観点一覧
2. 追加・修正したテストコード
3. 実行コマンド
4. 想定される失敗要因と対処
5. 必要に応じて次の改善候補（カバレッジ不足箇所など）
