---
name: test-e2e
description: 'Playwright による E2E テストの実行スキル。常にポート3000を使用し、未起動ならサーバーを起動してから e2e/*.spec.ts を実行し、終了後もサーバーを稼働させたままにする。E2E テストを実行・デバッグする際には必ずこのスキルに従うこと。'
---

# E2E テスト実行スキル

`e2e/FR-{CATEGORY}-{NNN}-{description}.spec.ts` を Playwright で実行する手順。

## 鉄則

- 接続先には常に `http://localhost:3000` を使う。別ポートを使わない
- ポート3000が稼働中なら、その既存サーバーをそのまま使う
- ポート3000が未起動なら、テスト前にサーバーをポート3000で起動し、応答可能になるまで待つ
- テスト終了後もポート3000のプロセスをKillせず、稼働させたままにする
- 別ポートへの切り替え、既存プロセスの再起動、テスト後の停止を行わない

## 実行

`playwright.config.ts` の `baseURL` は常に `http://localhost:3000` を使用する。Playwrightの `webServer` 機能はテスト後にプロセスを停止する可能性があるため使わない。事前確認手順で必要な場合だけ、独立したバックグラウンドプロセスとして起動する。

```bash
npm run test:e2e                                  # 全件
npx playwright test e2e/FR-ADMIN-031              # ファイル指定
npx playwright test e2e/FR-ADMIN-03               # 前方一致で複数ファイル
npx playwright test --reporter=line               # 全件実行時はこちらが読みやすい
```

全件は 20 分超になる。`run_in_background` で回し、完了通知を待つ。

### 事前確認（必須）

ポート3000がListen中か確認する。未起動の場合だけ、リポジトリのルートで非表示の独立プロセスとして起動する。起動済みのPIDに対して `Stop-Process`、`taskkill`、その他の終了操作を行わない。

```powershell
$listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
  Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden
}
```

起動した場合は `http://localhost:3000` が応答するまで最大120秒待つ。応答しなければテストを実行せず、起動失敗として報告する。待機中も既存プロセスを停止しない。

```powershell
$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  try {
    Invoke-WebRequest -Uri 'http://localhost:3000' -Method Head -TimeoutSec 2 -UseBasicParsing | Out-Null
    $ready = $true
    break
  } catch {
    Start-Sleep -Seconds 2
  }
}
if (-not $ready) { throw 'Port 3000 server did not become ready within 120 seconds.' }
```

## 失敗の切り分け

原因を推測で断定しない。次の順で確認する。

### 1. エラーの種類を見る

| エラー | 意味 |
|---|---|
| `page.goto: Test timeout` / `net::ERR_ABORTED` | ページが返ってこない → サーバー側 |
| `locator.click: Test timeout`（要素が出ない） | ページが描画されていない → サーバー側の疑い |
| `expect(locator).toBeVisible() failed` | 要素は無いが描画は進んだ → 実装側の疑い |
| 期待値と実際値の不一致 | 実装側 |

### 2. 失敗したテストだけを単体で再実行する

パスするなら実装の欠陥ではない。

```bash
npx playwright test e2e/FR-ADMIN-024-cost-input-fields.spec.ts
```

### 3. 同一テストの他ビューポートを見る

mobile / tablet / desktop の 3 ビューポートで同じテストが走る。**同じ実行内で desktop だけ落ちて mobile/tablet が通っている**なら、環境由来の疑いが濃い。

### 4. 実行ごとに失敗する組が入れ替わるか見る

入れ替わるならフレーク。同じテストが毎回落ちるなら実装の欠陥。

### やってはいけないこと

- `retries` を上げて通す — 症状を隠すだけ
- 切り分けずに「フレークだろう」と断定する — 逆に本物のバグを見逃す
- 単体でパスしたことだけを根拠に「実装は正しい」と結論する — 上の 1〜4 を揃えて判断する

## テストを書くとき

`.claude/CLAUDE.md` の要求管理ルールに従う。

- 1 つの受け付け基準（AC）につき 1 つの `test()`。コメントに `// FREQ-XXX-AC-01` を書いて spec と対応付ける
- mobile（390px）/ tablet（768px）/ desktop（1280px）の 3 ビューポートで回す
- API は `page.route()` でモックする。実 DB に依存させない
- 各ファイルに横スクロール検証を 1 件入れる

```ts
const hasHorizontalOverflow = await page.evaluate(() => {
  const doc = document.documentElement;
  return doc.scrollWidth > doc.clientWidth + 1;
});
expect(hasHorizontalOverflow).toBe(false);
```

### ロケーターの注意点

実際に踏んだもの。

- `page.route()` の glob で `?` は**1 文字ワイルドカード**。`**/api/foo?**` はクエリ付き URL にマッチしない。`**/api/foo**` にして、ハンドラ内で `new URL(req.url())` を見て分岐する
- `getByRole(name)` は**部分一致**。`{ name: '勘定科目' }` は `aria-label="勘定科目で絞り込み"` にもマッチする。衝突するなら `exact: true` か、ラベル自体を重ならない文言にする

## 参考

- ブラウザを対話的に操作して調べる場合は `playwright-cli` スキル
- Jest（単体テスト）は `test-jest` スキル
