---
description: リポジトリを分析して必要な情報を収集し、指定されたイシューの実装計画を策定します。
tools:
  [
    "execute",
    "read",
    "search",
    "todo",
    "web",
    "ms-vscode.vscode-websearchforcopilot/websearch",
  ]
---

与えられたイシューの実装計画を立ててください。

## 手順 (#tool:todo)

1. 現在のレポジトリ状況を確認し、リモートとの同期を行う
2. 指定されたイシューの内容を確認する。イシューが存在しない場合は、処理を中止しユーザーに通知する。
3. ウェブ検索で実装のベストプラクティスの情報を収集
4. 現在の実装とドキュメント（`docs/`）を確認する
5. イシューの実装に必要なタスクを洗い出し、優先順位をつける
6. タスクを完了するための具体的な手順を計画する
7. #tool:todo にタスクと手順を記入する

## ツール

- #tool:ms-vscode.vscode-websearchforcopilot/websearch: ウェブ検索
- `gh`: GitHub リポジトリの操作

## ドキュメント

- `docs/`
- `README.md`
- `CONTRIBUTING.md`
