# Transaction Summary and Partner Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin の取引管理テーブルで摘要と取引先を独立列にし、全画面サイズで全文を非折り返し表示しつつ、狭い画面では横スクロールできるようにする。

**Architecture:** `CostProfitSection` の取引一覧用 `entryColumns` と当該 `DataTable` の局所クラスだけを変更する。共通 `DataTable`、API、保存データには手を加えず、既存の `overflow: auto` と内容幅に追従する table layout を利用する。

**Tech Stack:** Next.js 16 App Router、React 19.2、TypeScript、Tailwind CSS、Jest、React Testing Library

## 概要

取引一覧の複合列を分離し、`table-fixed` と省略表示を取り除く。回帰テストを先に失敗させ、最小実装、対象テスト、静的検証、Graphify 更新の順で完了させる。

## Global Constraints

- 列順は「選択／日付／種別／勘定科目／摘要／取引先／金額／証憑／更新履歴／状態／操作」とする。
- PC・タブレット・スマートフォンで同じ列構成を使用する。
- 全列の本文を折り返し禁止とし、摘要・取引先に省略記号を表示しない。
- 画面幅を超えた表は既存の `DataTable` コンテナ内で横スクロールさせる。
- 取引先未設定時は「取引先なし」と表示する。
- Supabase 注文の補足表示、行選択、証憑、状態確認、編集、削除を維持する。
- 共通 `DataTable`、データ取得、保存、状態判定、ページングは変更しない。
- 無関係な未コミット差分、特に既存の `graphify-out/` 差分を実装コミットへ混入させない。

---

### Task 1: 取引一覧の列分離とレスポンシブ横スクロール

**Files:**

- Modify: `tests/unit/components/CostProfitSection.test.tsx`
- Modify: `src/components/CostProfitSection.tsx:3913-4110`
- Modify: `src/components/CostProfitSection.tsx:5937-5948`

**Interfaces:**

- Consumes: `Expense.item: string`、`Expense.partner: string`、`Expense.source`、`Expense.readOnly`、既存の `DataTable<T>` props
- Produces: `entryColumns: Array<TableColumn<Expense>>` 内の `item`（摘要）列と `partner`（取引先）列、および取引一覧専用の非折り返し・内容幅・セル余白クラス

- [ ] **Step 1: 独立列、全文表示、内容幅を要求する失敗テストを書く**

`tests/unit/components/CostProfitSection.test.tsx` の取引管理テスト群へ次を追加する。

```tsx
it("取引一覧で摘要と取引先を独立列にして全文を非折り返し表示する", async () => {
  setupFinanceFetch([], undefined, false, {
    expenses: [
      {
        id: 1,
        entryType: "expense",
        date: "2026-05-24",
        category: "外注工賃",
        item: "サンプル制作と最終仕様確認",
        partner: "丸善テキスタイル株式会社",
        amount: 73_145,
        paymentMethod: "銀行",
        memo: "",
      },
    ],
  });

  render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
  await screen.findByText("同期済み");
  fireEvent.click(screen.getByRole("tab", { name: "取引管理" }));

  const summaryHeader = screen.getByRole("columnheader", { name: "摘要" });
  const table = summaryHeader.closest("table");
  expect(table).not.toBeNull();
  expect(
    within(table!).getByRole("columnheader", { name: "取引先" }),
  ).toBeInTheDocument();
  expect(
    within(table!).queryByRole("columnheader", { name: "摘要・取引先" }),
  ).not.toBeInTheDocument();

  const summary = within(table!).getByText("サンプル制作と最終仕様確認");
  const partner = within(table!).getByText("丸善テキスタイル株式会社");
  expect(summary.closest("td")).not.toBe(partner.closest("td"));
  expect(summary.closest("td")).toHaveClass("whitespace-nowrap");
  expect(partner.closest("td")).toHaveClass("whitespace-nowrap");
  expect(summary).not.toHaveClass("truncate");
  expect(partner).not.toHaveClass("truncate");
  expect(table).toHaveClass(
    "min-w-max",
    "!table-auto",
    "[&_td]:whitespace-nowrap",
  );
  expect(table!.parentElement).toHaveClass(
    "[--pad-x:calc(var(--table-font-size)/var(--phi))]",
  );
});

it("取引一覧で取引先未設定と注文補足を省略せず表示する", async () => {
  setupFinanceFetch([
    {
      id: -1,
      entryType: "income",
      date: "2026-08-01",
      category: "売上高",
      item: "オンラインストア注文 #1001",
      partner: "",
      amount: 73_145,
      refundedAmount: 5_000,
      paymentMethod: "Stripe",
      memo: "",
      source: "order",
      readOnly: true,
    },
  ]);

  render(<CostProfitSection fiscalYear={2026} fiscalYearLabel="2026年" />);
  await screen.findByText("同期済み");
  fireEvent.click(screen.getByRole("tab", { name: "取引管理" }));

  const summary = screen.getByText("オンラインストア注文 #1001");
  const row = summary.closest("tr");
  expect(row).not.toBeNull();
  expect(within(row!).getByText("取引先なし")).toBeInTheDocument();
  expect(within(row!).getByText("Supabase注文")).toBeInTheDocument();
  expect(within(row!).getByText("返金 ¥5,000")).toBeInTheDocument();
  expect(summary).not.toHaveClass("truncate");
});
```

- [ ] **Step 2: 対象テストを実行し、期待した理由で失敗することを確認する**

Run:

```powershell
npm.cmd test -- --runTestsByPath tests/unit/components/CostProfitSection.test.tsx --runInBand
```

Expected: FAIL。現在は「摘要」および「取引先」の独立した列見出しがなく、複合見出し「摘要・取引先」と `truncate`／`table-fixed` が残っていることを原因として失敗する。

- [ ] **Step 3: 摘要列と取引先列を最小実装で分離する**

`src/components/CostProfitSection.tsx` の既存 `item` 列を次の責務へ変更し、直後に `partner` 列を追加する。

```tsx
{
  key: "item",
  header: "摘要",
  cellClassName: "whitespace-nowrap",
  render: (entry) => {
    if (entry.readOnly || entry.source === "order") {
      return (
        <div className="whitespace-nowrap">
          <span className="block">{entry.item}</span>
          <span className="mt-0.5 flex flex-nowrap gap-1 text-2.5 text-[#707070]">
            <span>Supabase注文</span>
            {(entry.refundedAmount ?? 0) > 0 ? (
              <span>返金 {currency(entry.refundedAmount ?? 0)}</span>
            ) : null}
          </span>
        </div>
      );
    }
    return <span className="block">{entry.item}</span>;
  },
},
{
  key: "partner",
  header: "取引先",
  cellClassName: "whitespace-nowrap",
  render: (entry) => entry.partner || "取引先なし",
},
```

摘要から `max-w-*` と `truncate` を除去し、注文補足の `flex-wrap` を `flex-nowrap` に変更する。日付、種別、勘定科目、金額、更新履歴、状態、操作の既存挙動は変更しない。

- [ ] **Step 4: 取引一覧だけを内容幅・狭いセル余白へ変更する**

取引一覧の `DataTable` を次の局所クラスに変更する。

```tsx
<DataTable
  size="2xs"
  shape="rounded"
  hoverableRows
  columns={entryColumns}
  rows={pagedEntryRows}
  rowKey={(entry) => String(entry.id)}
  emptyLabel="該当する取引がありません。"
  tableClassName="min-w-max !table-auto [&_td]:whitespace-nowrap"
  containerClassName="font-acumin [--pad-x:calc(var(--table-font-size)/var(--phi))]"
/>
```

`DataTable.css` の既存 `overflow: auto` は変更しない。`min-w-max` とテーブル配下の全 `td` に適用する `whitespace-nowrap` により、狭い画面ではコンテナ内に横スクロールを発生させる。左右余白は既存の黄金比変数 `--phi` を使い、共通既定値より狭い `font-size / φ` とする。

- [ ] **Step 5: 対象テストを再実行して成功を確認する**

Run:

```powershell
npm.cmd test -- --runTestsByPath tests/unit/components/CostProfitSection.test.tsx --runInBand
```

Expected: PASS。警告、未処理 Promise、React `act` 警告が出ないことも確認する。

### Task 2: PC・タブレット・スマートフォンの実ブラウザ回帰検証

**Files:**

- Modify: `e2e/FR-ADMIN-043-transaction-workbench.spec.ts:184-199`
- Modify: `e2e/FR-ADMIN-043-transaction-workbench.spec.ts:412-444`
- Modify: `docs/superpowers/plans/2026-08-13-transaction-summary-partner-columns.md`

**Interfaces:**

- Consumes: Task 1 が生成する「摘要」「取引先」列と `DataTable` のスクロールコンテナ
- Produces: mobile 390px、tablet 768px、desktop 1280px、およびスクリーンショット用 1600px のレスポンシブ回帰テスト

- [ ] **Step 6: 既存E2Eの列見出し期待値を新仕様へ更新する**

`e2e/FR-ADMIN-043-transaction-workbench.spec.ts` の列見出し配列を次のように変更する。

```ts
for (const header of [
  "日付",
  "種別",
  "勘定科目",
  "摘要",
  "取引先",
  "金額",
  "証憑",
  "更新履歴",
  "状態",
  "操作",
]) {
  await expect(
    page.getByRole("columnheader", { name: header, exact: true }),
  ).toBeVisible();
}
await expect(
  page.getByRole("columnheader", { name: "摘要・取引先", exact: true }),
).toHaveCount(0);
```

- [ ] **Step 7: 各viewportで非折り返しとコンテナ横スクロールを検証する**

同じ viewport ループへ次のテストを追加する。

```ts
test("摘要と取引先を折り返さず、狭い画面では表内を横スクロールできる", async ({
  page,
}) => {
  await openEntries(page);

  const tableContainer = page.locator(
    '[aria-label="取引一覧"] [data-ui-data-table]',
  );
  const summary = tableContainer.getByText("生地・材料仕入", { exact: true });
  const partner = tableContainer.getByText("A社", { exact: true }).first();

  await expect(summary).toBeVisible();
  await expect(partner).toBeVisible();
  await expect(summary.locator("xpath=ancestor::td[1]")).not.toHaveCSS(
    "text-overflow",
    "ellipsis",
  );
  await expect(partner.locator("xpath=ancestor::td[1]")).not.toHaveCSS(
    "text-overflow",
    "ellipsis",
  );
  await expect(summary.locator("xpath=ancestor::td[1]")).toHaveCSS(
    "white-space",
    "nowrap",
  );
  await expect(partner.locator("xpath=ancestor::td[1]")).toHaveCSS(
    "white-space",
    "nowrap",
  );

  const dimensions = await tableContainer.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  if (viewport.name === "mobile" || viewport.name === "tablet") {
    expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
    const scrollLeft = await tableContainer.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      return element.scrollLeft;
    });
    expect(scrollLeft).toBeGreaterThan(0);
  }
});
```

既存の「横方向のページスクロールが発生しない」テストは維持する。横スクロールはページ全体ではなく、`DataTable` コンテナ内だけで発生させる。

- [ ] **Step 8: E2Eをlocalhost:3000で実行する**

`test-e2e` スキルを読み、`http://localhost:3000` が未起動なら開発サーバーをポート3000で起動して、終了後も稼働させたままにする。

```powershell
npx.cmd playwright test e2e/FR-ADMIN-043-transaction-workbench.spec.ts --project=chromium --workers=1
```

Expected: mobile、tablet、desktop、1280px、1600px の全ケースが PASS。ページ全体には横スクロールがなく、mobile／tablet のテーブルコンテナは実際に横スクロールできる。

- [ ] **Step 9: Next.js／TypeScript／Lint の関連検証を実行する**

実行前に、このリポジトリの Next.js 16 規約として `node_modules/next/dist/docs/01-app/01-getting-started/11-css.md` を読む。次に package scripts を確認し、既存の正確な script 名で型検査と lint を実行する。

```powershell
Get-Content -Raw -Encoding utf8 node_modules/next/dist/docs/01-app/01-getting-started/11-css.md
Get-Content -Raw -Encoding utf8 package.json
npm.cmd run typecheck
npm.cmd run lint
```

Expected: 各コマンドが exit code 0。既知の生成物・環境由来エラーが出た場合は、今回の変更との因果を切り分けて記録する。

- [ ] **Step 10: Graphify を更新し、最終差分を検査する**

```powershell
graphify update .
git -c safe.directory=C:/work/o_official diff --check
git -c safe.directory=C:/work/o_official diff -- src/components/CostProfitSection.tsx tests/unit/components/CostProfitSection.test.tsx e2e/FR-ADMIN-043-transaction-workbench.spec.ts
```

Expected: Graphify 更新が exit code 0、`diff --check` が無出力。差分が摘要・取引先列、取引一覧の局所レイアウト、対応テストに限定されている。

- [ ] **Step 11: 実装ファイルとテストだけをコミットする**

```powershell
git -c safe.directory=C:/work/o_official add -- src/components/CostProfitSection.tsx tests/unit/components/CostProfitSection.test.tsx e2e/FR-ADMIN-043-transaction-workbench.spec.ts docs/superpowers/plans/2026-08-13-transaction-summary-partner-columns.md
git -c safe.directory=C:/work/o_official diff --cached --check
git -c safe.directory=C:/work/o_official diff --cached --stat
git -c safe.directory=C:/work/o_official commit -m "feat(accounting): separate summary and partner columns"
```

Expected: `master` に対象4ファイルだけがコミットされ、無関係な `graphify-out/` 差分は含まれない。
