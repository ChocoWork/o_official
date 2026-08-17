# 仕訳・元帳の月次累積収支推移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 仕訳・元帳のグラフを、勘定科目選択に依存せず、前年末累積収支を期首へ引き継ぐ1月から12月の月次累積収支推移へ変更する。

**Architecture:** 取引履歴から累積収支を算出する純粋関数を `src/lib/finance/` に置き、`CostProfitSection` は `cumulativeEntries` と選択年度を渡して描画だけを担当する。科目別元帳の `selectedLedger` は仕訳一覧・詳細・照合・CSVに残し、固定グラフの入力から分離する。既存APIが選択年度末までの全手動取引を返すため、APIとDBスキーマは変更しない。

**Tech Stack:** Next.js 16.3 App Router、React 19、TypeScript、Chart.js共通`Graph`、Jest、React Testing Library、Playwright

## Global Constraints

- 横軸は常に1月から12月の12点とする。
- 対象は取引管理へ入力された全収入・全支出とし、勘定科目、取引先、決済方法、シーズンタグで除外しない。
- 選択年の1月1日より前の全収入から全支出を引いた値を期首残高とする。前年以前の取引がない場合だけ0円とする。
- 勘定科目選択で変えるのは、仕訳一覧、仕訳詳細、照合結果、総勘定元帳CSVだけとする。
- 年度選択では月次累積収支推移とサマリーを更新する。
- 累積収支は現金預金残高、利益、純資産、科目別元帳残高ではなく管理指標である旨を表示する。
- 法定帳簿の仕訳、残高、訂正履歴、証憑関連付け、CSV算出ロジックは変更しない。
- 既存共通UIを使い、依存パッケージを追加しない。
- mobile 390px、tablet 768px、desktop 1280pxでページ全体の横スクロールを発生させない。
- 既存の未コミット変更を保持し、今回のhunkだけをstageする。

---

## File Structure

| ファイル | 責務 |
|---|---|
| `src/lib/finance/cumulative-balance-trend.ts` | 期首、当年収入・支出、12か月の累積収支を算出する純粋関数 |
| `tests/unit/lib/finance/cumulative-balance-trend.test.ts` | 年跨ぎ、全取引包含、空月、負数、将来取引除外の集計契約 |
| `src/components/CostProfitSection.tsx` | 固定グラフとサマリーを描画し、科目選択状態から分離する |
| `tests/unit/components/CostProfitSection.test.tsx` | 表示文言、集計値、科目変更時のグラフ不変性 |
| `e2e/FR-ADMIN-044-ledger-three-views.spec.ts` | 3ビューポートで固定グラフと科目別領域の独立性を検証 |
| `e2e/FR-ADMIN-032-ledger-trial-balance.spec.ts` | 旧科目別グラフ期待値を元帳・照合契約へ置換 |
| `e2e/FR-ADMIN-035-statements-from-real-balances.spec.ts` | 固定資産科目残高の検証先を照合結果へ変更 |
| `docs/2_Specs/spec.md` | FREQ-258-REQ/AC-02・03を固定グラフ契約へ同期 |

### Task 1: 月次累積収支の純粋集計

**Files:**

- Create: `src/lib/finance/cumulative-balance-trend.ts`
- Create: `tests/unit/lib/finance/cumulative-balance-trend.test.ts`

**Interfaces:**

- Consumes: `FinanceEntry[]`、`fiscalYear: number`
- Produces: `buildCumulativeBalanceTrend(entries: FinanceEntry[], fiscalYear: number): CumulativeBalanceTrend`
- Produces: `CumulativeBalanceTrend = { openingBalance; annualIncome; annualExpense; closingBalance; monthly }`

- [ ] **Step 1: 失敗する集計テストを書く**

`tests/unit/lib/finance/cumulative-balance-trend.test.ts` に以下を作る。

```typescript
import { buildCumulativeBalanceTrend } from '@/lib/finance/cumulative-balance-trend';
import type { FinanceEntry } from '@/lib/finance/journal';

const entry = (
  id: number,
  entryType: FinanceEntry['entryType'],
  date: string,
  amount: number,
  category: string,
  paymentMethod: string,
): FinanceEntry => ({
  id, entryType, date, amount, category, paymentMethod,
  item: `取引${id}`, partner: '', memo: '',
});

it('前年末累積収支を期首にして全収入・全支出の12か月推移を返す', () => {
  const result = buildCumulativeBalanceTrend([
    entry(1, 'income', '2025-12-20', 100_000, '売上高', '銀行'),
    entry(2, 'expense', '2025-12-25', 30_000, '広告宣伝費', 'クレジットカード'),
    entry(3, 'income', '2026-01-10', 20_000, '売上高', '現金'),
    entry(4, 'expense', '2026-03-15', 5_000, '旅費交通費', 'プライベート'),
    entry(5, 'income', '2027-01-01', 999_999, '売上高', '銀行'),
  ], 2026);

  expect(result.openingBalance).toBe(70_000);
  expect(result.annualIncome).toBe(20_000);
  expect(result.annualExpense).toBe(5_000);
  expect(result.closingBalance).toBe(85_000);
  expect(result.monthly).toHaveLength(12);
  expect(result.monthly[0]).toEqual({ month: 1, net: 20_000, balance: 90_000 });
  expect(result.monthly[1]).toEqual({ month: 2, net: 0, balance: 90_000 });
  expect(result.monthly[2]).toEqual({ month: 3, net: -5_000, balance: 85_000 });
  expect(result.monthly[11].balance).toBe(85_000);
});

it('前年以前の取引がなければ期首0円で負数も保持する', () => {
  const result = buildCumulativeBalanceTrend([
    entry(1, 'expense', '2026-02-01', 8_000, '消耗品費', '現金'),
  ], 2026);
  expect(result.openingBalance).toBe(0);
  expect(result.monthly[0].balance).toBe(0);
  expect(result.monthly[1].balance).toBe(-8_000);
});
```

- [ ] **Step 2: REDを確認する**

Run:

```powershell
npm.cmd test -- --runTestsByPath tests/unit/lib/finance/cumulative-balance-trend.test.ts --runInBand
```

Expected: 対象moduleが存在しないためFAIL。

- [ ] **Step 3: 最小実装を書く**

`src/lib/finance/cumulative-balance-trend.ts`:

```typescript
import type { FinanceEntry } from '@/lib/finance/journal';

export type CumulativeBalanceTrendPoint = {
  month: number;
  net: number;
  balance: number;
};

export type CumulativeBalanceTrend = {
  openingBalance: number;
  annualIncome: number;
  annualExpense: number;
  closingBalance: number;
  monthly: CumulativeBalanceTrendPoint[];
};

export function buildCumulativeBalanceTrend(
  entries: FinanceEntry[],
  fiscalYear: number,
): CumulativeBalanceTrend {
  const yearStart = `${fiscalYear}-01-01`;
  const yearEnd = `${fiscalYear}-12-31`;
  const monthlyNet = Array<number>(12).fill(0);
  let openingBalance = 0;
  let annualIncome = 0;
  let annualExpense = 0;

  for (const entry of entries) {
    const signed = entry.entryType === 'income' ? entry.amount : -entry.amount;
    if (entry.date < yearStart) {
      openingBalance += signed;
      continue;
    }
    if (entry.date > yearEnd) continue;
    const month = Number.parseInt(entry.date.slice(5, 7), 10);
    if (!Number.isInteger(month) || month < 1 || month > 12) continue;
    monthlyNet[month - 1] += signed;
    if (entry.entryType === 'income') annualIncome += entry.amount;
    else annualExpense += entry.amount;
  }

  let balance = openingBalance;
  const monthly = monthlyNet.map((net, index) => {
    balance += net;
    return { month: index + 1, net, balance };
  });
  return { openingBalance, annualIncome, annualExpense, closingBalance: balance, monthly };
}
```

- [ ] **Step 4: GREENと型検査を確認する**

```powershell
npm.cmd test -- --runTestsByPath tests/unit/lib/finance/cumulative-balance-trend.test.ts --runInBand
npm.cmd run typecheck
```

Expected: 2 tests PASS、typecheck exit 0。

- [ ] **Step 5: Task 1をコミットする**

```powershell
git -c safe.directory=C:/work/o_official add -- src/lib/finance/cumulative-balance-trend.ts tests/unit/lib/finance/cumulative-balance-trend.test.ts
git -c safe.directory=C:/work/o_official diff --cached --check
git -c safe.directory=C:/work/o_official commit -m "feat(accounting): calculate cumulative balance trend"
```

### Task 2: 固定グラフUIと科目選択の分離

**Files:**

- Modify: `src/components/CostProfitSection.tsx:1878-1894,7290-7350,7660-7735`
- Modify: `tests/unit/components/CostProfitSection.test.tsx`

**Interfaces:**

- Consumes: `buildCumulativeBalanceTrend(cumulativeEntries, fiscalYear)`
- Produces: region `月次累積収支推移`、graph name `${fiscalYear}年の月次累積収支推移`
- Produces: `期首残高`、`当年収入`、`当年支出`、`当年末残高`
- Preserves: `selectedLedger` for rows、detail、reconciliation、general-ledger CSV

- [ ] **Step 1: 失敗するコンポーネントテストを書く**

既存mockの`cumulativeEntries`へTask 1と同じ4取引を渡し、帳簿タブを開く。region `月次累積収支推移`内に70,000円、20,000円、5,000円、85,000円が表示されること、広告宣伝費をクリックした後も85,000円が残ることを`within(trend)`で検証する。既存ヘルパーの引数順は変えない。

- [ ] **Step 2: REDを確認する**

```powershell
npm.cmd test -- --runTestsByPath tests/unit/components/CostProfitSection.test.tsx --runInBand
```

Expected: 新regionまたは固定サマリーが存在せずFAIL。

- [ ] **Step 3: 集計状態を科目選択から分離する**

```typescript
import { buildCumulativeBalanceTrend } from '@/lib/finance/cumulative-balance-trend';

const cumulativeBalanceTrend = useMemo(
  () => buildCumulativeBalanceTrend(cumulativeEntries, fiscalYear),
  [cumulativeEntries, fiscalYear],
);
```

旧`ledgerMonthlyPoints`と`ledgerAnomalyMonths`を削除する。`ledgerClosingBalance`と`ledgerOpeningBalance`は照合など科目別領域に残す。

- [ ] **Step 4: グラフとサマリーを置換する**

```tsx
<Graph
  variant="line"
  size="2xs"
  plotHeight={220}
  unitLabel="（円）"
  className="font-acumin"
  ariaLabel={`${fiscalYear}年の月次累積収支推移`}
  categories={LEDGER_MONTH_LABELS}
  series={[{
    label: '累積収支',
    color: LEDGER_TREND_COLOR,
    values: cumulativeBalanceTrend.monthly.map((point) => point.balance),
  }]}
/>
```

Panel見出しと`aria-label`を`月次累積収支推移`へ変更する。右側は4サマリーへ置換し、末尾に次を表示する。

```tsx
<p className="mt-3 border-t border-[#ededed] pt-2 font-acumin text-[10px] leading-relaxed text-[#707070]">
  取引管理に入力した全収入・全支出による管理指標です。現金預金・利益・純資産・科目別元帳の残高ではありません。
</p>
```

科目未選択時でも表示できるよう、グラフを`selectedLedger`条件分岐から外す。

- [ ] **Step 5: GREEN、lint、型検査を確認する**

```powershell
npm.cmd test -- --runTestsByPath tests/unit/components/CostProfitSection.test.tsx tests/unit/lib/finance/cumulative-balance-trend.test.ts --runInBand
npx.cmd eslint src/components/CostProfitSection.tsx src/lib/finance/cumulative-balance-trend.ts tests/unit/components/CostProfitSection.test.tsx tests/unit/lib/finance/cumulative-balance-trend.test.ts
npm.cmd run typecheck
```

Expected: 対象tests PASS、ESLint 0 errors、typecheck exit 0。

- [ ] **Step 6: Task 2を部分stageしてコミットする**

両既存ファイルには着手前変更があるため、今回のhunkだけをstageする。

```powershell
git -c safe.directory=C:/work/o_official add -p -- src/components/CostProfitSection.tsx tests/unit/components/CostProfitSection.test.tsx
git -c safe.directory=C:/work/o_official diff --cached --check
git -c safe.directory=C:/work/o_official diff --cached
git -c safe.directory=C:/work/o_official commit -m "feat(accounting): fix cumulative trend across accounts"
```

### Task 3: E2E契約と仕様の同期

**Files:**

- Modify: `e2e/FR-ADMIN-044-ledger-three-views.spec.ts:216-238,288-310`
- Modify: `e2e/FR-ADMIN-032-ledger-trial-balance.spec.ts:166-183`
- Modify: `e2e/FR-ADMIN-035-statements-from-real-balances.spec.ts:159-176`
- Modify: `docs/2_Specs/spec.md:1443`

**Interfaces:**

- Consumes: Task 2の固定region、4サマリー、科目選択で不変な値
- Produces: FREQ-258-REQ/AC-02・03とE2Eが同じ契約を表す状態

- [ ] **Step 1: E2Eフィクスチャと失敗アサーションを書く**

`FR-ADMIN-044`の`cumulativeEntries`をTask 1と同じ4取引にする。新regionで期首70,000円と期末85,000円を確認し、普通預金と広告宣伝費を順に選択した後も期末85,000円が残ることを検証する。同時に仕訳一覧と照合結果が選択科目へ切り替わることを検証する。

- [ ] **Step 2: 旧科目別グラフの検証先を直す**

- `FR-ADMIN-032`: 現金選択後、region `照合結果`に元帳残高 `¥-27,000`が表示されることを検証する。
- `FR-ADMIN-035`: 工具器具備品選択後、region `照合結果`に科目名と`¥499,800`が表示されることを検証する。
- 旧region `残高推移`内へ科目別残高を求めるアサーションは削除する。

- [ ] **Step 3: FREQ-258を同期する**

`docs/2_Specs/spec.md`のFREQ-258だけを変更する。

- REQ-02: 全収入・全支出と前年末累積収支による1月から12月の固定グラフ。
- AC-02: region、4サマリー、管理指標注記。
- REQ-03: 科目選択は科目別領域だけを変更し、固定グラフは変更しない。
- AC-03: 二科目を選び、科目別領域だけが変わり固定グラフ値が同じこと。
- その他のFREQと既存未コミット変更は触らない。

- [ ] **Step 4: docs検証とE2E discoveryを実行する**

```powershell
npm.cmd run validate-docs
npx.cmd playwright test e2e/FR-ADMIN-044-ledger-three-views.spec.ts e2e/FR-ADMIN-032-ledger-trial-balance.spec.ts e2e/FR-ADMIN-035-statements-from-real-balances.spec.ts --list
```

Expected: docs validation exit 0、3ファイルが各projectでdiscoverされる。

- [ ] **Step 5: ポート3000で対象E2Eを実行する**

`test-e2e`手順に従いlistenerを確認し、未起動の場合だけサーバーを起動して終了後も稼働させる。

```powershell
npx.cmd playwright test e2e/FR-ADMIN-044-ledger-three-views.spec.ts e2e/FR-ADMIN-032-ledger-trial-balance.spec.ts e2e/FR-ADMIN-035-statements-from-real-balances.spec.ts --workers=1
```

Expected: 対象全project PASS。失敗時は代表1件をchromium・1 workerで再現し、DOM・response・listenerを確認してから変更する。

- [ ] **Step 6: Task 3を部分stageしてコミットする**

```powershell
git -c safe.directory=C:/work/o_official add -- e2e/FR-ADMIN-044-ledger-three-views.spec.ts e2e/FR-ADMIN-032-ledger-trial-balance.spec.ts e2e/FR-ADMIN-035-statements-from-real-balances.spec.ts
git -c safe.directory=C:/work/o_official add -p -- docs/2_Specs/spec.md
git -c safe.directory=C:/work/o_official diff --cached --check
git -c safe.directory=C:/work/o_official diff --cached
git -c safe.directory=C:/work/o_official commit -m "test(accounting): align cumulative trend contract"
```

### Task 4: 全体検証とGraphify更新

**Files:**

- Modify: `graphify-out/*` through `graphify update .`

**Interfaces:**

- Consumes: Tasks 1-3
- Produces: fresh verification evidence and current graph

- [ ] **Step 1: 対象Jestを再実行する**

```powershell
npm.cmd test -- --runTestsByPath tests/unit/lib/finance/cumulative-balance-trend.test.ts tests/unit/components/CostProfitSection.test.tsx --runInBand
```

Expected: 2 suites PASS、0 failures。

- [ ] **Step 2: 静的検証を実行する**

```powershell
npm.cmd run typecheck
npx.cmd eslint src/lib/finance/cumulative-balance-trend.ts src/components/CostProfitSection.tsx tests/unit/lib/finance/cumulative-balance-trend.test.ts tests/unit/components/CostProfitSection.test.tsx e2e/FR-ADMIN-044-ledger-three-views.spec.ts e2e/FR-ADMIN-032-ledger-trial-balance.spec.ts e2e/FR-ADMIN-035-statements-from-real-balances.spec.ts
npm.cmd run validate-docs
```

Expected: 全コマンドexit 0、ESLint 0 errors。

- [ ] **Step 3: セキュリティ監査を実行する**

```powershell
powershell -ExecutionPolicy Bypass -File .claude/skills/security-check/scripts/audit.ps1
```

Expected: Critical / High / Medium / Low がすべて0。環境要因があれば今回変更との因果関係を切り分ける。

- [ ] **Step 4: Graphifyを更新する**

```powershell
graphify update .
```

Expected: exit 0、新集計関数と画面の関係がグラフへ反映される。

- [ ] **Step 5: 最終差分と履歴を確認する**

```powershell
git -c safe.directory=C:/work/o_official status --short
git -c safe.directory=C:/work/o_official log -5 --oneline
git -c safe.directory=C:/work/o_official diff --check
```

Expected: 今回の実装ファイルに未コミット差分がなく、着手前の無関係な変更だけが残る。
