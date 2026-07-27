---
name: test-e2e
description: 'Playwright による E2E テストの実行スキル。本番ビルド（next build && next start）に対して e2e/*.spec.ts を実行し、失敗が実装由来か環境由来かを切り分ける。E2E テストを実行・デバッグする際には必ずこのスキルに従うこと。'
---

# E2E テスト実行スキル

`e2e/FR-{CATEGORY}-{NNN}-{description}.spec.ts` を Playwright で実行する手順。

## 鉄則

**E2E は本番ビルドに対して実行する。dev サーバーでは実行しない。**

dev サーバーはリクエストのたびにオンデマンドコンパイルする。件数が増えると `page.goto` が 30 秒返らない・要素が描画されないという、**実装とは無関係な失敗**を出す。実測で 288 件 22 分の直列実行で 9 件失敗し、同じテストを単体実行すると 111/111 パスした。

この偽の失敗を実装のバグと誤診すると、直す必要のないコードを触ることになる。

## 実行

`playwright.config.ts` の `webServer` が既定で `npm run build && npm run start` を起動する。通常は叩くだけでよい。

```bash
npm run test:e2e                                  # 全件
npx playwright test e2e/FR-ADMIN-031              # ファイル指定
npx playwright test e2e/FR-ADMIN-03               # 前方一致で複数ファイル
npx playwright test --reporter=line               # 全件実行時はこちらが読みやすい
```

全件は 20 分超になる。`run_in_background` で回し、完了通知を待つ。

### 事前確認（必須）

`reuseExistingServer: true` のため、**`npm run dev` が :3000 で動いたままだと Playwright はそれを再利用し、黙って dev サーバーに対してテストしてしまう**。実行前に必ず止める。

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
```

### dev サーバーで動かす場合

デバッグ中に再ビルドを避けたいときのみ。

```bash
E2E_DEV_SERVER=1 npx playwright test e2e/FR-ADMIN-031
```

**この結果を回帰の合否判断に使わない。** 通っても通らなくても、最終確認は本番ビルドでやり直す。

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
