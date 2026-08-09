# クロスプラットフォーム・セキュリティ監査設計

## 概要

既存の `audit.sh` がWSLまたはBashを必要とする問題を解消し、Windows、Git Bash、Linux/macOSで同じ監査ルールと終了コードを利用できるようにする。

## 設計

- Python標準ライブラリだけで監査本体 `audit.py` を実装する。
- `audit.sh` は利用可能なPythonランタイムを検出して `audit.py` を呼ぶ互換ラッパーにする。
- `audit.ps1` はWindowsの `py` または `python` を検出して `audit.py` を呼ぶ。
- `.codex` を正本とし、`.claude` 側のPythonエントリーポイントから正本を実行する。
- `--files-only`、`--json`、`--report FILE`、対象パス指定、重大度に応じた終了コードを維持する。
- ESLint、TypeScript、npm audit、gitleaks、Semgrepは存在する場合だけ実行する。

## エラー処理

- Pythonが見つからないラッパーは、インストール方法を示して終了コード2を返す。
- 対象が存在しない場合は終了コード2を返す。
- CriticalまたはHigh検出時は1、それ以外は0を返す。
- 外部ツールの起動不能は監査自体を中断せずInfo findingとして扱う。

## テスト

- 一時ディレクトリの安全なファイルと脆弱なファイルに対してPython監査を実行する。
- JSON形式、Markdownレポート、終了コード、`--files-only` を検証する。
- PowerShellラッパーから同じ結果が得られることをWindows上で検証する。
- Bashが利用可能な環境ではBashラッパーも同じ契約で動作させる。
