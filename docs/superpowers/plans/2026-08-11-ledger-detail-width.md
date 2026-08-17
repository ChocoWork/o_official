# 仕訳詳細幅・元帳見出し調整 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** デスクトップの仕訳一覧を左2列分へ広げ、仕訳詳細を右列で上下に連続表示する。

**Architecture:** 既存の`CostProfitSection`内の3列CSS Gridだけを変更し、データ構造やコンポーネント境界は維持する。Playwrightで見出しと列幅を画面上の実寸として検証する。

**Tech Stack:** Next.js 16、React 19.2、TypeScript、Tailwind CSS、Playwright

## Global Constraints

- 2XL以上では3列を「勘定科目 220px／残高推移 可変幅／仕訳詳細 307px」とする。
- 仕訳一覧は下段で左2列を占有し、仕訳詳細は右列で2段分を占有する。
- 2XL未満では既存の1列レイアウトを維持する。
- 見出しは常に「残高推移」「仕訳一覧」とする。
- 新しいコンポーネント、API、型、DB変更は追加しない。

---

### Task 1: 元帳レイアウトと汎用見出し

**Files:**

- Modify: `e2e/FR-ADMIN-044-ledger-three-views.spec.ts`
- Modify: `src/components/CostProfitSection.tsx`

**Interfaces:**

- Consumes: `Panel`の`aria-label`と既存の`ledgerView`
- Produces: 2XL時の220px／可変／307pxレイアウト、左2列の仕訳一覧、固定見出し

- [ ] **Step 1: 失敗するE2Eテストを書く**

```ts
test('ワイドデスクトップでは仕訳一覧を左2列へ広げて仕訳詳細を右列に通す', async ({ page }, testInfo) => {
  test.skip(testInfo.title.includes('(mobile)') || testInfo.title.includes('(tablet)'));
  await openLedgerTab(page);
  await expect(page.getByRole('heading', { name: '残高推移', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '仕訳一覧', exact: true })).toBeVisible();
  const detailBox = await page.getByRole('region', { name: '仕訳詳細' }).boundingBox();
  expect(detailBox?.width).toBeGreaterThanOrEqual(302);
  expect(detailBox?.width).toBeLessThanOrEqual(312);
  expect(Math.abs(listBox!.x - accountBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(listBox!.x + listBox!.width - trendBox!.x - trendBox!.width)).toBeLessThanOrEqual(1);
  expect(detailBox!.height).toBeGreaterThan(trendBox!.height);
});
```

- [ ] **Step 2: REDを確認する**

Run: `npx.cmd playwright test e2e/FR-ADMIN-044-ledger-three-views.spec.ts --project=chromium --workers=1 --grep "左2列"`

Expected: 仕訳一覧が中央列内に留まり、仕訳詳細が約460pxのためFAIL。

- [ ] **Step 3: 最小実装を行う**

```tsx
<div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-[220px_minmax(0,1fr)_307px]">
```

残高推移と仕訳一覧の`Panel`タイトルは条件分岐を削除し、それぞれ固定文字列にする。

- [ ] **Step 4: GREENと回帰を確認する**

Run: `npx.cmd playwright test e2e/FR-ADMIN-044-ledger-three-views.spec.ts --project=chromium --workers=1`

Expected: 3画面幅の全テストがPASSし、ページ全体の横スクロールが発生しない。

- [ ] **Step 5: 静的・セキュリティ検証を行う**

Run: `npx.cmd eslint src/components/CostProfitSection.tsx e2e/FR-ADMIN-044-ledger-three-views.spec.ts`

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .codex/skills/security-check/scripts/audit.ps1 --files-only src/components/CostProfitSection.tsx e2e/FR-ADMIN-044-ledger-three-views.spec.ts`

Expected: エラー0件、監査判定GO。

- [ ] **Step 6: Graphifyと差分を確認する**

Run: `graphify update .`

Run: `git -c safe.directory=C:/work/o_official diff --check`

Expected: Graphify更新成功、空白エラーなし。
