# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Talking Style

### cavemanのルール（英語向け）

Drop: articles (a/an/the), filler (just/really/basically),
pleasantries (sure/certainly), hedging

### genshijinのルール（日本語向け）

削除対象:

- 敬語・丁寧語（です/ます/ございます → 体言止め・用言止め）
- クッション言葉（えーと/まあ/ちなみに/一応/基本的に）
- ぼかし（〜かもしれません/〜と思われます/おそらく）
- 冗長助詞（〜することができる→〜できる）
- 冗長接続（〜ということになりますので→だから）
- 自明な助詞（が/の/を/に/で/は/と/も）— 意味通じるなら省略
- 情報水増し — 聞かれたことだけ答える

## 前提条件

docs\1_RequirementsDifinition\brand.md に私の服のブランドのコンセプトとペルソナと世界観を記載しているので、作業前に理解すること。

### 要求管理ルール

ユーザーから機能・UI の変更・追加依頼を受けたら、実装と同時に以下をセットで作成する。

**1. docs\2_Specs\spec.md に追記**

トレーサビリティテーブルに1行追加：

```
| FREQ-XX | 要求の内容 | FREQ-XX-REQ-01 | 要件の内容 | FREQ-XX-AC-01 | 受け付け基準の内容 |
```

- FREQ-XX は既存の最大番号の次の番号
- 受け付け基準は「〇〇が表示されること」「〇〇が表示されないこと」など検証可能な形で書く

**2. e2e\FR-{CATEGORY}-{NNN}-{description}.spec.ts を作成**

- CATEGORY: HEADER / HOME / ITEM / LOOK / NEWS / ABOUT / CONTACT / STOCKIST / ACCOUNT / LOGIN / SEARCH / CHECKOUT / CART / WISHLIST 等
- NNN: そのカテゴリ内の連番（既存ファイルを確認して次の番号を使う）
- description: kebab-case の短い説明
- テスト内容は受け付け基準（AC）を検証するコードにする
- mobile（390px）/ tablet（768px）/ desktop（1280px）の3ビューポートでテストする

### E2E 実行ルール

**E2E は必ず本番ビルド（`next build && next start`）に対して実行する。dev サーバーでは実行しない。**

`playwright.config.ts` の `webServer` が既定で `npm run build && npm run start` を起動するので、通常は `npx playwright test`（または `npm run test:e2e`）を叩くだけでよい。

```bash
npm run test:e2e                      # 全件（本番ビルド）
npx playwright test e2e/FR-ADMIN-031  # 部分実行（本番ビルド）
```

**理由:** dev サーバーはリクエストのたびにオンデマンドコンパイルするため、件数が増えると `page.goto` が 30 秒返らない・要素が描画されない、という**実装とは無関係な失敗**を出す。実測で 288 件 22 分の直列実行で 9 件失敗し、同じテストを単体実行すると 111/111 パスした。この偽の失敗を実装のバグと誤診すると、直す必要のないコードを触ることになる。

**注意（必読）:** `reuseExistingServer: true` のため、**`npm run dev` が :3000 で動いたままだと Playwright はそれを再利用し、黙って dev サーバーに対してテストしてしまう**。E2E を回す前に dev サーバーを止めること。

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
```

意図的に dev サーバーで動かす場合のみ `E2E_DEV_SERVER=1` を付ける（デバッグ用途に限る。この結果を回帰の合否判断に使わない）。

**失敗したときの切り分け:** 失敗が実装由来か環境由来かを、原因を推測で断定せず次の順で確認する。

1. 失敗したテストだけを単体で再実行する → パスするなら実装の欠陥ではない
2. 同一テストの他ビューポートが同じ実行内でパスしているか見る → パスしていれば環境由来の疑いが濃い
3. エラーが `page.goto` / `locator.click` のタイムアウトか、アサーション内容の不一致かを区別する → 前者はサーバー側、後者は実装側

`retries` を上げて通すのは症状を隠すだけなので採らない。
