# TODO: Copilot Custom Instructions Files

プロジェクトで使用されている言語ごとに `*.instructions.md` を作成し、カスタムインストラクションを設定するタスクです。

- [x] 1. このプロジェクトで使われている言語を洗い出す。

  **使用言語**
  - TypeScript / TSX (React components & server code)
  - SQL (migrations, queries)
  - JavaScript (tests, scripts, playwrigth helpers)
  - Shell scripting (bash/PowerShell) for build/test scripts
  - JSON / Markdown (configuration and documentation, not code but included for completeness)
- [x] 2. 各言語に対しての `<言語名>.instructions.md` を作成する

  生成したファイル:
  - `.github/instructions/typescript.instructions.md`
  - `.github/instructions/sql.instructions.md`
  - `.github/instructions/javascript.instructions.md`
  - `.github/instructions/shell.instructions.md`
- [x] 3. 各言語のコーディング規約とセキュアコーディング規約を調査し、その内容を `<言語名>.instructions.md` に記述する。

  コーディング/セキュリティ規約は各ファイルに記載済み。

進行状況はこのファイルで管理します。