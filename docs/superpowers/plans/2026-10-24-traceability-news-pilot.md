# トレーサビリティの仕組みと NEWS の試し 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 要求からテストまでのつながりを検査・生成する道具と書式の決まりを作り、NEWS の領域を要求からテストまで全部つなぐ。

**Architecture:** `scripts/trace/` に TypeScript の道具を置く（`tsx` で動かす。既存の `scripts/e2e/*.ts` と同じ形）。文書の項目は「見出し＋属性の表」、コードは TSDoc の `@impl`・`@design`、テストは名前の先頭の ID から読む。範囲は `scripts/trace/scope.json` の領域の一覧で絞る。NEWS で書式と粒度をユーザーに確かめてもらってから、残りの領域の計画を別に作る。

**Tech Stack:** TypeScript 5、Node 24（`fs.globSync`）、`typescript` のコンパイラ API、Jest 29 + ts-jest、React Testing Library、Playwright、Supabase（手元）

**Spec:** [docs/superpowers/specs/2026-10-24-traceability-design.md](../specs/2026-10-24-traceability-design.md)

## Global Constraints

- 範囲外のファイルに手を入れない（設計書 3-2）。特に `requirements.md`・`api-spec.md`・`route-inventory.md`・`16_admin.md`・`er.md`・`screen-list.md`・`screen-flow.md`、`supabase/migrations/`・`supabase/pending/`、共有部品（`lib/auth/*`・`lib/csrf*`・`features/auth/**`・`lib/audit.ts`・`lib/supabase/*`・`lib/client-fetch.ts`・`components/ui/*`・`contexts/*`・`proxy.ts`・`app/layout.tsx`・`app/admin/page.tsx`）
- G-1 が同じ作業フォルダで並行して進んでいる。`git add -A`・`git add .` は使わず、自分が変えたファイルを名前で指定する。`git commit -- <paths>` で自分のファイルだけを入れる
- コードの変更はコメントだけ。動きを変えない。`'use client'`・`'use server'` の行より前にコメントを置いてよい（コメントは文ではない）が、その行自体は動かさない
- 既にある `FREQ-…`・`FR-…`・`NFR-…`・`SEC-NNN` は番号を変えない。新しい `FREQ-` は振らない。新しい要求は `SR-<AREA>-NNN`
- 既にある詳細設計の `IMPL-NEWS-LIST-NNN`・`IMPL-NEWS-DETAIL-NNN`・`IMPL-NEWS-NNN` は、新しい `DD-` の「旧番号」に移す（中身が要件ごとの実装の記録で、新しい体系の詳細設計にあたるため）。新しい `IMPL-NEWS-NNN` は、既にある最大の `IMPL-NEWS-NNN`（`IMPL-NEWS-003`）より後の 101 から振る（文字の上で混ざらないように）
- 根拠の欄に `仕様のため`・`要件のため`・`仕様どおり`・`必要なため` だけを書かない
- 実装から起こした内容は状態を「推定」にする
- 新しい E2E は mobile 390・tablet 768・desktop 1280 の3つの幅で試す（CLAUDE.md）。E2E は本番ビルドと手元の Supabase で流す
- DB を使う結合テストと E2E は、G-1 が試験を流していない時だけ流す。流す前に `Get-NetTCPConnection -LocalPort 3000 -State Listen` と `npx supabase status` で状態を確かめる。`db reset` はユーザーに確かめてから
- push はしない（ユーザーに確かめてから）
- 文書は `documentation-guide` スキル（Task 6 の後の版）に従う

## Review Focus

1. **BOM と CRLF の文書**: `requirements.md` などは先頭に BOM があり、改行が CRLF の物がある。見出しの ID が読めずに「定義が無い」と誤って落ちないこと → Task 1 の試験
2. **文中に出てくる ID と定義の取り違え**: 本文や表の中で ID を参照しているだけの所を定義と数えないこと。定義は `### <ID> <title>` の見出しだけ → Task 1 の試験
3. **テンプレート文字列の名前と入れ子の describe**: `` test(`FREQ-31-AC-01 … ${vp.name}`) `` のような名前から ID を読めること。describe の名前の ID は数えない → Task 2 の試験
4. **型だけの export と再 export**: `export type`・`export interface`・`export { x } from` は単位にしない。export された関数の値の `const` は単位にする → Task 2 の試験
5. **範囲外を指す参照と打ち間違い**: `SEC-001（範囲外）` は通すが、どの文書にも無い ID に「範囲外」を付けても通さないこと → Task 3 の試験

---

## File Structure

| ファイル | 役目 |
| --- | --- |
| `scripts/trace/model.ts` | 型、ID の種類の判定 `kindOf()` |
| `scripts/trace/parse-docs.ts` | 文書の項目の読み取り |
| `scripts/trace/parse-code.ts` | コードの単位と TSDoc の読み取り |
| `scripts/trace/parse-tests.ts` | 単体・結合・E2E のテスト名の ID の読み取り |
| `scripts/trace/rules.ts` | 検査の決まり |
| `scripts/trace/scope.json` | 範囲の領域の一覧 |
| `scripts/trace/load.ts` | 範囲を読んで全部の読み取りをまとめる |
| `scripts/trace/validate.ts` | `npm run validate-trace` の入口 |
| `scripts/trace/report.ts` | `trace-matrix.md`・`test-gaps.md`・`unused-code.md` の生成 |
| `scripts/trace/unused.ts` | 使われていないコードの候補の検出 |
| `scripts/trace/impact.ts` | `npm run trace -- <ID|path>` の入口 |
| `scripts/trace/compare-e2e.ts` | テスト名を変えた前後の E2E の比べ |
| `jest.trace.config.cjs` | 範囲内の分岐の網羅を測る Jest の設定 |
| `tests/unit/scripts/trace/*.test.ts` | 道具の単体テスト |
| `.claude/skills/documentation-guide/SKILL.md`（と `.codex/`・`.github/` の写し） | 書式の正本 |
| `docs/02_Requirements/areas/news.md` | NEWS の要求・要件・受け入れ条件・セキュリティ要件・派生要件 |
| `docs/05_Quality/security/threats/news.md` | NEWS の脅威 |
| `docs/03_BasicDesign/areas/news.md` | NEWS の構造設計（ARC・SCR・FLOW・STATE・API・DATA） |
| `docs/03_BasicDesign/decisions/ADR-NNNN-*.md` | 設計判断 |
| `docs/04_DetailDesign/pages/02_news_list.md`・`03_news_detail.md`（書き直し）、`16-1_admin_news.md`（新規） | NEWS の詳細設計 |
| `docs/05_Quality/reports/{trace-matrix,test-gaps,unused-code}.md` | 生成物 |

構造設計は種類ごとの既存の文書（`api-spec.md`・`er.md`・`screen-*.md`）が G-1 の作業と文書を固定する試験に触れるため、領域ごとの1ファイル `docs/03_BasicDesign/areas/<area>.md` にまとめる（設計書 6-1 の「該当する文書」の置き方をこの形に決めた）。

---

## 仕組み

### Task 1: 項目の型と文書の読み取り

**Files:**
- Create: `scripts/trace/model.ts`、`scripts/trace/parse-docs.ts`
- Test: `tests/unit/scripts/trace/parse-docs.test.ts`、`tests/unit/scripts/trace/model.test.ts`

**Interfaces:**
- Produces:

```ts
export type TraceKind =
  | 'REQUEST' | 'REQ' | 'AC' | 'SEC' | 'DRV' | 'THR' | 'ADR'
  | 'ARC' | 'SCR' | 'FLOW' | 'STATE' | 'API' | 'DATA' | 'DD' | 'IMPL';
export type ItemStatus = '現行' | '推定' | '廃止';
export interface TraceItem {
  id: string; kind: TraceKind; title: string; file: string; line: number;
  parents: string[]; outOfScopeParents: string[];
  rationale: string; status: ItemStatus | '';   // 空は表が無い・読めない（検査で落とす）
  verification?: string; source?: string; priority?: string;
  oldIds: string[]; oldLocation?: string;
}
export function kindOf(id: string): TraceKind | null;
export function parseDocItems(file: string, text: string): TraceItem[];
```

`kindOf` の決まり（上から順に当てる）:

| 形 | 種類 |
| --- | --- |
| `…-AC-NN` で終わる | `AC` |
| `FREQ-NN`、`SR-<AREA>-NNN` | `REQUEST` |
| `FREQ-NN-REQ-NN`、`FR-<AREA>-NNN`、`NFR-<AREA>-NNN` | `REQ` |
| `SEC-NNN`、`SEC-<AREA>-NNN` | `SEC` |
| `DRV-`・`THR-`・`ARC-`・`SCR-`・`FLOW-`・`STATE-`・`API-`・`DATA-`・`DD-`・`IMPL-` ＋ `<AREA>-NNN` | 同じ名前の種類 |
| `ADR-NNNN` | `ADR` |

`<AREA>` は `[A-Z]+(-[A-Z]+)*`（例: `NEWS-ALL`）。それ以外は `null`。

- [ ] **Step 1: 失敗する試験を書く**

```ts
it('kindOf は ID の形から種類を返す', () => {
  expect(kindOf('FR-NEWS-ALL-001-AC-01')).toBe('AC');
  expect(kindOf('FREQ-31-AC-01')).toBe('AC');
  expect(kindOf('FREQ-31')).toBe('REQUEST');
  expect(kindOf('SR-NEWS-001')).toBe('REQUEST');
  expect(kindOf('FR-NEWS-ALL-001')).toBe('REQ');
  expect(kindOf('SEC-001')).toBe('SEC');
  expect(kindOf('DD-NEWS-003')).toBe('DD');
  expect(kindOf('ADR-0001')).toBe('ADR');
  expect(kindOf('IMPL-NEWS-LIST-001')).toBe('IMPL');
  expect(kindOf('NEWS')).toBeNull();
});
it('見出しと属性の表から項目を読む（BOM・CRLF でも）', () => {
  const md = '﻿# 文書\r\n\r\n### DD-NEWS-003 一覧の取得\r\n\r\n| 属性 | 値 |\r\n| --- | --- |\r\n| 上位 | API-NEWS-002、SEC-001（範囲外） |\r\n| 根拠 | 下書きを外へ出さない |\r\n| 状態 | 推定 |\r\n| 旧番号 | IMPL-NEWS-LIST-001 |\r\n';
  const [item] = parseDocItems('x.md', md);
  expect(item).toMatchObject({
    id: 'DD-NEWS-003', kind: 'DD', title: '一覧の取得', line: 3,
    parents: ['API-NEWS-002'], outOfScopeParents: ['SEC-001'],
    rationale: '下書きを外へ出さない', status: '推定', oldIds: ['IMPL-NEWS-LIST-001'],
  });
});
it('本文や表の中の ID は定義にしない', () => {
  const md = '## 概要\n\nDD-NEWS-003 を参照する。\n\n| ID | 説明 |\n| --- | --- |\n| DD-NEWS-004 | x |\n';
  expect(parseDocItems('x.md', md)).toEqual([]);
});
it('見出しの次の属性の表が無い項目は状態を空にして返す（検査で落とす）', () => {
  const [item] = parseDocItems('x.md', '### DD-NEWS-009 表なし\n\n本文だけ\n');
  expect(item.rationale).toBe('');
  expect(item.parents).toEqual([]);
});
```

- [ ] **Step 2: 流して失敗を確かめる**

Run: `npx jest tests/unit/scripts/trace --runInBand`
Expected: FAIL（`Cannot find module '@/../scripts/trace/model'`）

- [ ] **Step 3: `kindOf` と `parseDocItems` を作る**

見出しは `###` と `####` の両方を読む（見出しの深さは文書による）。属性の表は見出しの直後の最初の表だけを読み、属性名は `上位`・`根拠`・`状態`・`確かめ方`・`出どころ`・`優先度`・`旧番号`・`旧所在`。値の中の ID は `kindOf` が `null` でない語を拾い、直後に `（範囲外）` があれば `outOfScopeParents` へ入れる。状態が無い・読めない時は空文字を入れる（検査の `missing-status` で落とすため）。

- [ ] **Step 4: 流して通るのを確かめる**

Run: `npx jest tests/unit/scripts/trace --runInBand`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add scripts/trace/model.ts scripts/trace/parse-docs.ts tests/unit/scripts/trace/model.test.ts tests/unit/scripts/trace/parse-docs.test.ts
git commit -m "feat(trace): 文書の項目と ID の種類を読む" -- scripts/trace tests/unit/scripts/trace
```

### Task 2: コードの単位とテスト名の読み取り

**Files:**
- Create: `scripts/trace/parse-code.ts`、`scripts/trace/parse-tests.ts`
- Test: `tests/unit/scripts/trace/parse-code.test.ts`、`tests/unit/scripts/trace/parse-tests.test.ts`

**Interfaces:**
- Consumes: `kindOf`（Task 1）
- Produces:

```ts
export interface CodeUnit {
  file: string; line: number; symbol: string;           // ファイル単位は symbol = '<file>'
  unitKind: 'file' | 'function';
  implId?: string; designIds: string[]; remarks: string;
}
export function parseCodeUnits(file: string, text: string): CodeUnit[];

export type TestLevel = 'unit' | 'integration' | 'e2e';
export interface TestRef { id: string | null; level: TestLevel; file: string; line: number; title: string }
export function levelOf(file: string): TestLevel;      // e2e/ → e2e、tests/integration/ → integration、他 → unit
export function parseTestRefs(file: string, text: string): TestRef[];
```

単位の決まり（設計書 5-3）:

| ファイル | 単位 |
| --- | --- |
| `src/app/**/{page,layout,route,loading,error,not-found}.{ts,tsx}`、その他の `.tsx` | ファイル（先頭の TSDoc ブロック。`@packageDocumentation` を付ける） |
| `'use server'` で始まる `.ts` | export された関数ごと |
| そのほかの `.ts` | export された関数・クラス・関数の値の `const` ごと |

`export type`・`export interface`・`export { … } from`・関数でない値の `const` は単位にしない。

- [ ] **Step 1: 失敗する試験を書く**

```ts
it('ファイル単位は先頭の TSDoc から @impl と @design を読む', () => {
  const src = "/**\n * 一覧の画面。\n *\n * @packageDocumentation\n * @impl IMPL-NEWS-101\n * @design DD-NEWS-001\n * @remarks 公開済みだけを出す。\n */\nimport x from 'y';\nexport default function Page() { return null; }\n";
  expect(parseCodeUnits('src/app/news/page.tsx', src)).toEqual([
    { file: 'src/app/news/page.tsx', line: 1, symbol: '<file>', unitKind: 'file',
      implId: 'IMPL-NEWS-101', designIds: ['DD-NEWS-001'], remarks: '公開済みだけを出す。' },
  ]);
});
it("'use client' より前のコメントもファイル単位として読む", () => {
  const src = "/**\n * @packageDocumentation\n * @impl IMPL-NEWS-102\n * @design DD-NEWS-002\n */\n'use client';\nexport function A() { return null; }\n";
  expect(parseCodeUnits('src/features/news/components/A.tsx', src)[0].implId).toBe('IMPL-NEWS-102');
});
it('.ts は export された関数ごとに単位にし、型と再 export は数えない', () => {
  const src = "export type T = string;\nexport interface I { a: string }\nexport { z } from './z';\nexport const LIMIT = 10;\n/**\n * @impl IMPL-NEWS-103\n * @design DD-NEWS-003\n */\nexport async function getPublishedNews() {}\nexport const toSlug = (s: string) => s;\n";
  const units = parseCodeUnits('src/features/news/services/public.ts', src);
  expect(units.map((u) => [u.symbol, u.implId])).toEqual([
    ['getPublishedNews', 'IMPL-NEWS-103'],
    ['toSlug', undefined],
  ]);
});
it('テスト名の先頭の ID を読み、describe の ID は数えない', () => {
  const src = "test.describe('FR-NEWS-ALL-001 一覧', () => {\n  test(`FR-NEWS-ALL-001-AC-01 新しい順 ${vp.name}`, async () => {});\n  test('名前に ID が無い', async () => {});\n});\n";
  expect(parseTestRefs('e2e/FR-NEWS-ALL-001-x.spec.ts', src)).toEqual([
    { id: 'FR-NEWS-ALL-001-AC-01', level: 'e2e', file: 'e2e/FR-NEWS-ALL-001-x.spec.ts', line: 2, title: 'FR-NEWS-ALL-001-AC-01 新しい順 ${vp.name}' },
    { id: null, level: 'e2e', file: 'e2e/FR-NEWS-ALL-001-x.spec.ts', line: 3, title: '名前に ID が無い' },
  ]);
});
it('levelOf は置き場で段を決める', () => {
  expect(levelOf('e2e/a.spec.ts')).toBe('e2e');
  expect(levelOf('tests/integration/ui/news.test.tsx')).toBe('integration');
  expect(levelOf('tests/unit/features/news/public.test.ts')).toBe('unit');
});
```

- [ ] **Step 2: 流して失敗を確かめる**

Run: `npx jest tests/unit/scripts/trace --runInBand`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: `parseCodeUnits`・`levelOf`・`parseTestRefs` を作る**

`typescript` の `createSourceFile` で読み、`getLeadingCommentRanges` で TSDoc を取る。テスト名は `test`・`it`・`test.only`・`test.skip`・`it.each(...)(…)` の最初の引数（文字列・テンプレート文字列）を読む。`describe`・`test.describe` は読まない。

- [ ] **Step 4: 流して通るのを確かめる**

Run: `npx jest tests/unit/scripts/trace --runInBand`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add scripts/trace/parse-code.ts scripts/trace/parse-tests.ts tests/unit/scripts/trace/parse-code.test.ts tests/unit/scripts/trace/parse-tests.test.ts
git commit -m "feat(trace): コードの単位とテスト名の ID を読む" -- scripts/trace tests/unit/scripts/trace
```

### Task 3: 検査の決まりと範囲と `validate-trace`

**Files:**
- Create: `scripts/trace/rules.ts`、`scripts/trace/scope.json`、`scripts/trace/load.ts`、`scripts/trace/validate.ts`
- Modify: `package.json`（`scripts` に `"validate-trace": "tsx scripts/trace/validate.ts"` を足すだけ。ほかの行は触らない。`package.json` は G-1 側も変更中なので、`git diff package.json` で自分の1行だけを入れる。混ざる時は `git add -p` が使えないので、ユーザーに確かめる）
- Test: `tests/unit/scripts/trace/rules.test.ts`、`tests/unit/scripts/trace/load.test.ts`

**Interfaces:**
- Consumes: Task 1・2 の型と関数
- Produces:

```ts
export interface Violation { rule: string; message: string; file: string; line: number }
export interface TraceModel {
  items: TraceItem[]; units: CodeUnit[]; tests: TestRef[];
  knownIdsOutsideScope: Set<string>;   // 範囲外の文書（docs/ 全体）に文字として現れる ID
}
export function checkModel(model: TraceModel): Violation[];

export interface AreaScope { area: string; docs: string[]; src: string[]; tests: string[]; e2e: string[] }
export function loadScope(path?: string): AreaScope[];          // 既定 scripts/trace/scope.json
export function loadModel(areas: AreaScope[], root?: string): TraceModel;
```

`scope.json` の NEWS の行（このまま書く）:

```json
[
  {
    "area": "NEWS",
    "docs": [
      "docs/02_Requirements/areas/news.md",
      "docs/05_Quality/security/threats/news.md",
      "docs/03_BasicDesign/areas/news.md",
      "docs/03_BasicDesign/decisions/*.md",
      "docs/04_DetailDesign/pages/02_news_list.md",
      "docs/04_DetailDesign/pages/03_news_detail.md",
      "docs/04_DetailDesign/pages/16-1_admin_news.md"
    ],
    "src": [
      "src/app/news/**/*.{ts,tsx}",
      "src/app/api/news/**/*.ts",
      "src/app/api/admin/news/**/*.ts",
      "src/app/admin/news/**/*.{ts,tsx}",
      "src/app/actions/news.ts",
      "src/components/NewsSection.tsx",
      "src/features/news/**/*.{ts,tsx}",
      "src/lib/news-data.ts",
      "src/lib/storage/news-images.ts",
      "src/types/news.ts"
    ],
    "tests": ["tests/unit/**/*news*.test.{ts,tsx}", "tests/unit/**/*News*.test.{ts,tsx}", "tests/integration/**/*news*.test.{ts,tsx}"],
    "e2e": ["e2e/FR-NEWS-*.spec.ts"]
  }
]
```

検査の決まり（`rule` の名前と落とす条件）:

| rule | 落とす条件 |
| --- | --- |
| `duplicate-id` | 同じ ID の項目が2つ以上 |
| `bad-id` | 見出しの ID の `kindOf` が `null` |
| `missing-status` | 状態が空 |
| `missing-rationale` | 根拠が空、または `仕様のため`・`要件のため`・`仕様どおり`・`必要なため` だけ |
| `missing-parent` | 上位が空（`REQUEST`・`DRV`・`THR` は除く） |
| `wrong-parent-kind` | 上位の種類が下の表に無い |
| `unknown-parent` | 上位の ID が範囲内に無い。`（範囲外）` 付きは `knownIdsOutsideScope` に無い時だけ |
| `missing-child` | 下の表の「要る子」が無い（状態「廃止」は除く） |
| `retired-reference` | 「廃止」の項目を、廃止でない項目・単位・テストが指す |
| `missing-impl` | 範囲内の単位に `@impl` が無い |
| `bad-design-link` | `@design` が1つでない、または `DD` でない、または範囲内に無い |
| `duplicate-impl` | 同じ `IMPL-` が2つ以上の単位にある |
| `untagged-test` | 範囲内のテストの名前に ID が無い |
| `wrong-test-level` | e2e が `AC` 以外、integration が構造設計（`ARC`・`SCR`・`FLOW`・`STATE`・`API`・`DATA`）以外、unit が `DD` 以外を指す |
| `unknown-test-id` | テストの ID が範囲内に無い |

上位と子の決まり:

| 種類 | 上位に書ける種類 | 要る子 |
| --- | --- | --- |
| `REQUEST` | なし | `REQ` が1つ以上 |
| `REQ` | `REQUEST` | `AC` が1つ以上 |
| `AC` | `REQ`・`SEC` | e2e テストが1つ以上 |
| `THR` | なし | `SEC` が1つ以上 |
| `SEC` | `THR` | `AC` または構造設計または `DD` が1つ以上 |
| `DRV` | なし | 構造設計または `DD` が1つ以上 |
| `ADR` | `REQ`・`SEC`・`DRV` | 構造設計が1つ以上 |
| 構造設計 | `REQ`・`SEC`・`DRV`・`ADR`（`REQ`・`SEC`・`DRV` のどれかが1つ以上） | integration テストが1つ以上、`DD` が1つ以上 |
| `DD` | 構造設計・`SEC` | unit テストが1つ以上、単位が1つ以上 |

- [ ] **Step 1: 失敗する試験を書く**（決まりごとに1つ。例を3つ示す。残りの決まりも同じ形で、上の表の1行ごとに通る例と落ちる例を書く）

```ts
const item = (o: Partial<TraceItem>): TraceItem => ({
  id: 'DD-NEWS-001', kind: 'DD', title: 't', file: 'd.md', line: 1, parents: ['API-NEWS-001'],
  outOfScopeParents: [], rationale: '下書きを出さない', status: '現行', oldIds: [], ...o,
});
it('範囲外の印は、ほかの文書に在る ID なら通し、無い ID なら落とす', () => {
  const base = { units: [], tests: [] };
  const ok = checkModel({ ...base, items: [item({ id: 'API-NEWS-001', kind: 'API', parents: [], outOfScopeParents: ['SEC-001'] })], knownIdsOutsideScope: new Set(['SEC-001']) });
  expect(ok.filter((v) => v.rule === 'unknown-parent')).toEqual([]);
  const ng = checkModel({ ...base, items: [item({ id: 'API-NEWS-001', kind: 'API', parents: [], outOfScopeParents: ['SEC-999'] })], knownIdsOutsideScope: new Set() });
  expect(ng.map((v) => v.rule)).toContain('unknown-parent');
});
it('根拠が決まり文句だけなら落とす', () => {
  const v = checkModel({ items: [item({ rationale: '仕様のため' })], units: [], tests: [], knownIdsOutsideScope: new Set() });
  expect(v.map((x) => x.rule)).toContain('missing-rationale');
});
it('単体テストが構造設計を指したら段の誤りで落とす', () => {
  const v = checkModel({
    items: [item({ id: 'API-NEWS-001', kind: 'API', parents: ['FR-NEWS-ALL-001'] })],
    units: [], knownIdsOutsideScope: new Set(),
    tests: [{ id: 'API-NEWS-001', level: 'unit', file: 'tests/unit/a.test.ts', line: 3, title: 'API-NEWS-001 x' }],
  });
  expect(v.map((x) => x.rule)).toContain('wrong-test-level');
});
```

`load.test.ts`: 一時ディレクトリに小さな `scope.json`・文書・コード・テストを置き、`loadModel` が範囲内のファイルだけを読み、`docs/` の範囲外の文書の ID を `knownIdsOutsideScope` に入れることを確かめる。

- [ ] **Step 2: 流して失敗を確かめる**

Run: `npx jest tests/unit/scripts/trace --runInBand`
Expected: FAIL

- [ ] **Step 3: `checkModel`・`loadScope`・`loadModel` と `validate.ts` を作る**

`validate.ts` は `npm run validate-trace -- [AREA...]`。引数が無ければ `scope.json` の全部の領域。違反を `file:line [rule] message` で1行ずつ出し、1つでもあれば終了コード 1。ファイルは `fs.globSync` で集める。

- [ ] **Step 4: 流して通るのを確かめる**

Run: `npx jest tests/unit/scripts/trace --runInBand`
Expected: PASS

Run: `npm run validate-trace -- NEWS`
Expected: 終了コード 1。NEWS の文書がまだ無いので `missing-impl`・`untagged-test` などが並ぶ（この時点の正しい結果）

- [ ] **Step 5: コミット**

```bash
git add scripts/trace/rules.ts scripts/trace/scope.json scripts/trace/load.ts scripts/trace/validate.ts tests/unit/scripts/trace/rules.test.ts tests/unit/scripts/trace/load.test.ts
git add package.json   # 自分の1行だけが差分なのを先に git diff で確かめる
git commit -m "feat(trace): つながりの検査と validate-trace を足す" -- scripts/trace tests/unit/scripts/trace package.json
```

### Task 4: 一覧の生成・使われていないコード・影響範囲・E2E の比べ

**Files:**
- Create: `scripts/trace/report.ts`、`scripts/trace/unused.ts`、`scripts/trace/impact.ts`、`scripts/trace/compare-e2e.ts`
- Modify: `package.json`（`"trace": "tsx scripts/trace/impact.ts"`、`"trace:report": "tsx scripts/trace/report.ts"`、`"trace:compare-e2e": "tsx scripts/trace/compare-e2e.ts"` の3行だけ）
- Test: `tests/unit/scripts/trace/report.test.ts`、`unused.test.ts`、`impact.test.ts`、`compare-e2e.test.ts`

**Interfaces:**
- Consumes: `TraceModel`・`loadModel`（Task 3）、`flattenPlaywrightJson`（`scripts/e2e/compare-baseline.ts` の export。ファイルは変えない）
- Produces:

```ts
export function renderMatrix(model: TraceModel): string;        // trace-matrix.md の本文
export function renderTestGaps(model: TraceModel, uncovered: UncoveredBranch[]): string;
export interface UncoveredBranch { file: string; line: number; reason: string }   // test-gaps.md の手書きの節から読む
export interface UnusedCandidate { file: string; symbol: string; finding: '参照なし' | '要件につながらない'; how: string; impact: string; inScope: boolean }
export function findUnused(root: string, model: TraceModel): UnusedCandidate[];
export function renderUnused(list: UnusedCandidate[], previous?: string): string;  // 前の版の「判断」の列を引き継ぐ
export interface Impact { upstream: TraceItem[]; downstream: TraceItem[]; units: CodeUnit[]; tests: TestRef[]; siblings: CodeUnit[] }
export function impactOf(model: TraceModel, target: string): Impact;   // target は ID かファイルの場所
export function renameMap(before: TestRef[], after: TestRef[]): Map<string, string>;  // 同じファイル・同じ行の近くで名前の頭の ID だけ変わった物
```

- `trace-matrix.md` の節: 「要求から下へ」（要求 → 要件 → 受け入れ条件 → E2E、構造設計 → 結合テスト、DD → 単位 → 単体テスト）、「下から上へ」（単位ごとに要求まで）、「食い違い」（手書きの節。生成のたびに残す）
- `unused-code.md` の列は設計書 8章（場所・見つけ方・確かめた方法・消した時の影響・判断）。`判断` の列は生成し直しても消さない。範囲外の候補は `inScope: false` で載せる。最初から載せる候補: `src/components/ContactSection.tsx`、`src/lib/cache`、`src/utils/supabase/server.ts`（2026-10-24 の調査で参照が無かった物。生成の時に検索し直して確かめる）
- 「参照なし」の判定: `src/`・`tests/`・`e2e/` のどこからも import されないファイル（Next.js の決まった名前 `page`・`layout`・`route`・`loading`・`error`・`not-found`・`proxy` は除く）と、どこからも import されない export
- `compare-e2e.ts` は `npm run trace:compare-e2e -- <前の JSON> <後の JSON>`。名前を `renameMap` で突き合わせ、前に通って後で落ちた物・新しい失敗が1件でもあれば終了コード 1

- [ ] **Step 1: 失敗する試験を書く**

```ts
it('impactOf は IMPL から要求までと、同じ DD の兄弟とテストを返す', () => {
  const m = fixtureModel();   // REQUEST FREQ-31 → FR-NEWS-ALL-001 → AC-01、API-NEWS-001 → DD-NEWS-001 ← IMPL-NEWS-101・102
  const r = impactOf(m, 'IMPL-NEWS-101');
  expect(r.upstream.map((i) => i.id)).toEqual(expect.arrayContaining(['DD-NEWS-001', 'API-NEWS-001', 'FR-NEWS-ALL-001', 'FREQ-31']));
  expect(r.siblings.map((u) => u.implId)).toEqual(['IMPL-NEWS-102']);
  expect(r.tests.map((t) => t.id)).toEqual(expect.arrayContaining(['DD-NEWS-001', 'API-NEWS-001', 'FR-NEWS-ALL-001-AC-01']));
});
it('impactOf はファイルの場所でも引ける', () => {
  expect(impactOf(fixtureModel(), 'src/features/news/services/public.ts').units.length).toBeGreaterThan(0);
});
it('renderUnused は前の版の判断の列を残す', () => {
  const prev = '| 場所 | 記号 | 見つけ方 | 確かめた方法 | 消した時の影響 | 範囲 | 判断 |\n| --- | --- | --- | --- | --- | --- | --- |\n| src/lib/cache/index.ts | <file> | 参照なし | x | なし | 範囲外 | 消す |\n';
  const out = renderUnused([{ file: 'src/lib/cache/index.ts', symbol: '<file>', finding: '参照なし', how: 'x', impact: 'なし', inScope: false }], prev);
  expect(out).toContain('| 消す |');
});
it('renameMap は頭に ID を足しただけの名前を同じテストとみなす', () => {
  const before = [{ id: null, level: 'e2e', file: 'e2e/a.spec.ts', line: 6, title: '公開日の新しい順' }] as TestRef[];
  const after = [{ id: 'FR-NEWS-ALL-001-AC-01', level: 'e2e', file: 'e2e/a.spec.ts', line: 6, title: 'FR-NEWS-ALL-001-AC-01 公開日の新しい順' }] as TestRef[];
  expect(renameMap(before, after).get('e2e/a.spec.ts::公開日の新しい順')).toBe('FR-NEWS-ALL-001-AC-01 公開日の新しい順');
});
```

- [ ] **Step 2: 流して失敗を確かめる**

Run: `npx jest tests/unit/scripts/trace --runInBand`
Expected: FAIL

- [ ] **Step 3: 4つのファイルを作る**

`report.ts` は `npm run trace:report -- [AREA...]` で3つの md を `docs/05_Quality/reports/` に書く。冒頭に `> 状態: 自動生成 | 生成日: YYYY-MM-DD | 対象: <領域>` を入れ、手で直さないことを書く。

- [ ] **Step 4: 流して通るのを確かめる**

Run: `npx jest tests/unit/scripts/trace --runInBand`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add scripts/trace/report.ts scripts/trace/unused.ts scripts/trace/impact.ts scripts/trace/compare-e2e.ts tests/unit/scripts/trace/*.test.ts
git add package.json   # 自分の3行だけなのを git diff で確かめる
git commit -m "feat(trace): 一覧の生成・使われていないコード・影響範囲・E2E の比べを足す" -- scripts/trace tests/unit/scripts/trace package.json
```

### Task 5: 範囲内の分岐の網羅を測る設定

**Files:**
- Create: `jest.trace.config.cjs`
- Modify: `package.json`（`"test:trace-coverage": "jest -c jest.trace.config.cjs --coverage"` の1行だけ）
- Test: `tests/unit/scripts/trace/coverage-config.test.ts`

**Interfaces:**
- Consumes: `scripts/trace/scope.json`
- Produces: `npm run test:trace-coverage -- <AREA>`（環境変数 `TRACE_AREAS=NEWS` でも可）。範囲内の `src` のファイルを `collectCoverageFrom` にし、`coverageThreshold` を `{ global: { branches: 100 } }`、`testMatch` を範囲内の `tests` にする。ほかは `jest.config.cjs` をそのまま引き継ぐ

- [ ] **Step 1: 失敗する試験を書く**

```ts
it('NEWS の範囲だけを集め、分岐 100% を求める', () => {
  process.env.TRACE_AREAS = 'NEWS';
  jest.isolateModules(() => {
    const cfg = require('@/../jest.trace.config.cjs');
    expect(cfg.collectCoverageFrom).toContain('src/features/news/**/*.{ts,tsx}');
    expect(cfg.coverageThreshold).toEqual({ global: { branches: 100 } });
    expect(cfg.moduleNameMapper['^@/(.*)$']).toBe('<rootDir>/src/$1');
  });
});
```

- [ ] **Step 2〜4: 失敗を確かめ、作り、通るのを確かめる**

Run: `npx jest tests/unit/scripts/trace/coverage-config.test.ts`
Expected: 作る前は FAIL、作った後は PASS

Run: `npm run test:trace-coverage`（`TRACE_AREAS=NEWS`）
Expected: 終了コード 1（まだ 100% でない。この時点の正しい結果）。出た分岐の網羅の率を Task 11 の始めの基準として控える

- [ ] **Step 5: コミット**

```bash
git add jest.trace.config.cjs tests/unit/scripts/trace/coverage-config.test.ts
git add package.json   # 自分の1行だけなのを確かめる
git commit -m "test(trace): 範囲内の分岐の網羅を測る設定を足す" -- jest.trace.config.cjs tests/unit/scripts/trace package.json
```

### Task 6: 書式の決まり（スキルと CLAUDE.md と docs の案内）

**Files:**
- Modify: `.claude/skills/documentation-guide/SKILL.md`、`.codex/skills/documentation-guide/SKILL.md`、`.github/skills/documentation-guide/SKILL.md`（3つは同じ中身）
- Modify: `.claude/CLAUDE.md`（「docs 文書の参照ルール」「docs 文書の更新ルール」の節だけ）
- Modify: `docs/README.md`（「共通フォーマット」「文書の役割と更新規則」の節だけ）
- Test: `tests/unit/scripts/trace/skill-sync.test.ts`

**Interfaces:**
- Produces: 書式の正本。Task 7〜9 の文書はこの書式で書く

スキルに足す節（今の 1〜5 の決まりは残す）:

1. **6. 文書の種類と最小構成**: `docs/README.md` の表を写し、領域ごとの置き場（`docs/02_Requirements/areas/`・`docs/03_BasicDesign/areas/`・`docs/03_BasicDesign/decisions/`・`docs/05_Quality/security/threats/`）を足す
2. **7. 項目の書き方**: 設計書 5-2 の見出し＋属性の表の形と、属性の一覧、根拠の禁止の言い方
3. **8. ID の体系**: 設計書 5-1 の表（既存の番号を変えない・新しい `FREQ-` を振らない・`<要件ID>-AC-NN`・`IMPL-` の番号の決まり）
4. **9. コードのコメント**: 設計書 5-3（単位の表、TSDoc の例、`@impl`・`@design` 必須、`@remarks` は「なぜ」、行コメントの決まり、テストの場所を書かない）
5. **10. テストのつなぎ方**: 設計書 5-4（E2E → 受け入れ条件、結合 → 構造設計、単体 → 詳細設計、名前の先頭に ID）
6. **11. 確かめ**: `npm run validate-trace`、`npm run trace:report`、`npm run test:trace-coverage`、`npm run validate-docs`
7. **12. 型**: ADR の型（状態・背景・決定・退けた案・結果・上位）と脅威の型（守るもの・脅威・起こり方・影響・対策の `SEC-`・ASVS の項目）

CLAUDE.md に足す行:

- 参照ルールの2の先頭に「範囲（`scripts/trace/scope.json`）に入っている領域は、まず `npm run trace -- <ID かファイル>` で上下と影響範囲を出す」
- 更新ルールの表の前に「書式は `documentation-guide` スキルに従う。コードを変えたら、その単位の `@impl`・`@design` と、つながる `DD-` を同じコミットで直す。範囲内の領域を変えたら `npm run validate-trace` と `npm run test:trace-coverage` を通す」

- [ ] **Step 1: 失敗する試験を書く**

```ts
it('documentation-guide の3つの写しは同じ中身', () => {
  const read = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const a = read('.claude/skills/documentation-guide/SKILL.md');
  expect(read('.codex/skills/documentation-guide/SKILL.md')).toBe(a);
  expect(read('.github/skills/documentation-guide/SKILL.md')).toBe(a);
  expect(a).toContain('## 9. コードのコメント');
  expect(a).toContain('@impl');
});
```

- [ ] **Step 2: 流して失敗を確かめる**

Run: `npx jest tests/unit/scripts/trace/skill-sync.test.ts`
Expected: FAIL（`## 9. コードのコメント` が無い）

- [ ] **Step 3: スキル・CLAUDE.md・docs/README.md を書く**

`.claude/CLAUDE.md` はこの作業の前から未コミットの変更（「0. Use LLM Models」の節）がある。自分の行だけを足し、その節には触らない。コミットに入れてよいかはユーザーに確かめる（入れない時は Task 6 のコミットから `.claude/CLAUDE.md` を外し、報告する）。

- [ ] **Step 4: 流して通るのを確かめる**

Run（順に）: `npx jest tests/unit/scripts/trace/skill-sync.test.ts`、`npm run validate-docs`
Expected: 試験は PASS。`validate-docs` は今ある40件の切れ（G-1 の計画など）以外に増えていない

- [ ] **Step 5: コミット**

```bash
git add .claude/skills/documentation-guide/SKILL.md .codex/skills/documentation-guide/SKILL.md .github/skills/documentation-guide/SKILL.md docs/README.md tests/unit/scripts/trace/skill-sync.test.ts
git commit -m "docs(skills): 文書の書式とつながりの決まりを documentation-guide にまとめる" -- .claude/skills/documentation-guide .codex/skills/documentation-guide .github/skills/documentation-guide docs/README.md tests/unit/scripts/trace/skill-sync.test.ts
```

---

## NEWS の試し

NEWS の範囲は Task 3 の `scope.json` の NEWS の行。管理のニュースの API は共有部品（`admin-rbac`・`csrf`・`audit`）を使うが、共有部品のファイルには手を入れない。設計の文書の上位に `（範囲外）` 付きで書く。

### Task 7: NEWS の要求・要件・受け入れ条件・脅威

**Files:**
- Create: `docs/02_Requirements/areas/news.md`、`docs/05_Quality/security/threats/news.md`
- 読むだけ: `docs/02_Requirements/requirements.md`（1.2・1.3 節と、NEWS にかかる `FREQ-` の行）、`stakeholder-requirements.md`、`use-cases.md`、`docs/04_DetailDesign/pages/02_news_list.md`・`03_news_detail.md`、`docs/05_Quality/reviews/security/security_review_news.md`・`security_review_news_id.md`、`docs/05_Quality/reviews/code/2026-04-18-news-review.md`・`2026-04-29-news-review.md`・`2026-04-29-news-id-additional-security-review.md`、`docs/superpowers/specs`・`plans` のうち NEWS にかかる物（`grep -il news` で探す）、`docs/01_Planning/brand.md`

**Interfaces:**
- Produces: `FREQ-NN`・`SR-NEWS-NNN`（要求）、`FR-NEWS-ALL-NNN`・`FR-NEWS-DETAIL-NNN`・`FREQ-NN-REQ-NN`（要件）、`<要件ID>-AC-NN`・`FREQ-NN-AC-NN`（受け入れ条件）、`THR-NEWS-NNN`、`SEC-NEWS-NNN`、`DRV-NEWS-NNN`。管理のニュース（作る・直す・消す・画像）の要件も入れる

- [ ] **Step 1: 範囲内の要件の一覧を作る**

Run: `rg -n "FR-NEWS|NEWS" docs/02_Requirements/requirements.md` と、`FREQ-` の行のうち要求・要件・受け入れ条件の文に「ニュース」「NEWS」を含む物
Expected: 一覧（1.2 節の `FR-NEWS-ALL-001〜`、1.3 節の `FR-NEWS-DETAIL-001〜`、`FREQ-31` など）。範囲内と範囲外にまたがる行も入れる

- [ ] **Step 2: `docs/02_Requirements/areas/news.md` を書く**

1つの要件を1つの項目（設計書 5-2 の形）にする。各項目に `旧所在`（例: `requirements.md 1.2 表示・絞り込み`）を書く。`FR-` に受け入れ条件が無ければ `<要件ID>-AC-NN` を起こし、検証できる形（「〜が表示されること」「〜が表示されないこと」）で書く。上の要求が無い `FR-` は `SR-NEWS-NNN` を起こして状態を「推定」にする。重複した `FREQ-` 番号が NEWS にあれば、2つ目を `SR-NEWS-NNN` に振り替えて `旧番号` に元の番号を書く。`requirements.md` の「レビュー:」の文は根拠や出どころの手掛かりにし、写さない。

- [ ] **Step 3: `docs/05_Quality/security/threats/news.md` を書き、`SEC-NEWS-` を要件のファイルに足す**

守るもの（下書きの記事・管理の操作・画像の置き場・記事の本文）ごとに `THR-NEWS-NNN` を起こす（下書きの漏れ、管理の権限の無い書き込み、CSRF、本文の HTML による XSS、画像の署名 URL の使い回し、id の総当たり など。過去のセキュリティレビューの指摘を出どころにする）。各脅威に対策の `SEC-NEWS-NNN` を起こし、中身の出どころに OWASP ASVS 4.0.3 の項目番号を書く。全体の `SEC-001〜012` で足りる物は `SEC-NNN（範囲外）` を上位にする。

- [ ] **Step 4: 検査を流す**

Run: `npm run validate-trace -- NEWS`
Expected: この2つの文書の `duplicate-id`・`bad-id`・`missing-status`・`missing-rationale`・`missing-parent`・`wrong-parent-kind`・`unknown-parent` が0件（下の段が無いための `missing-child` はまだ残ってよい）

- [ ] **Step 5: コミット**

```bash
git add docs/02_Requirements/areas/news.md docs/05_Quality/security/threats/news.md
git commit -m "docs(requirements): NEWS の要求・要件・受け入れ条件・脅威を領域のファイルにまとめる" -- docs/02_Requirements/areas/news.md docs/05_Quality/security/threats/news.md
```

### Task 8: NEWS の構造設計と設計判断

**Files:**
- Create: `docs/03_BasicDesign/areas/news.md`、`docs/03_BasicDesign/decisions/ADR-0001-*.md` から必要な数
- 読むだけ: `docs/03_BasicDesign/` の全部の文書の NEWS の部分、`supabase/migrations/` の `news` の表・RLS・Storage の定義、`src/` の NEWS の範囲

**Interfaces:**
- Consumes: Task 7 の ID
- Produces: `ARC-NEWS-NNN`・`SCR-NEWS-NNN`・`FLOW-NEWS-NNN`・`STATE-NEWS-NNN`・`API-NEWS-NNN`・`DATA-NEWS-NNN`・`ADR-NNNN`

- [ ] **Step 1: 書く物を決める**

| 種類 | 少なくとも書く物 |
| --- | --- |
| `SCR-` | `/news`、`/news/[id]`、管理のニュースの一覧・作成・編集 |
| `FLOW-` | 一覧 → 詳細 → 一覧（絞り込みの復元）、管理の一覧 → 作成・編集 → 一覧 |
| `STATE-` | 記事の公開の状態（`src/types/news.ts` の `NewsStatus`）とその移り変わり |
| `API-` | `GET /api/news`、`/api/admin/news`、`/api/admin/news/[id]`、Server Action `app/actions/news.ts` |
| `DATA-` | `news` の表・RLS・`news-images` の置き場と署名 URL |
| `ARC-` | 公開側（Server Component が読む）と管理側（Route Handler が書く）の分け方 |
| `ADR-` | 実装と過去の仕様から読み取れる判断（例: 画像を private の置き場に置いて署名 URL で出す、カテゴリの絞り込みを DB 側で行う）。退けた案が文書に無ければ「記録なし」と書き、状態を「推定」にする |

- [ ] **Step 2: `docs/03_BasicDesign/areas/news.md` と ADR を書く**

各項目の上位に Task 7 の要件・`SEC-`・ADR を書く。共有部品（権限・CSRF・監査）を使う所は、その設計の ID が範囲外の文書にあれば `（範囲外）` 付きで書き、無ければ根拠の欄に共有部品のファイルの場所を書く。

- [ ] **Step 3: 検査を流す**

Run: `npm run validate-trace -- NEWS`
Expected: 構造設計と ADR の `missing-parent`・`wrong-parent-kind`・`unknown-parent`・`missing-rationale` が0件

- [ ] **Step 4: コミット**

```bash
git add docs/03_BasicDesign/areas/news.md docs/03_BasicDesign/decisions/
git commit -m "docs(design): NEWS の構造設計と設計判断を書く" -- docs/03_BasicDesign/areas/news.md docs/03_BasicDesign/decisions
```

### Task 9: NEWS の詳細設計

**Files:**
- Modify（書き直し）: `docs/04_DetailDesign/pages/02_news_list.md`、`docs/04_DetailDesign/pages/03_news_detail.md`
- Create: `docs/04_DetailDesign/pages/16-1_admin_news.md`
- Modify: `docs/04_DetailDesign/README.md`（頁の一覧に `16-1_admin_news.md` の1行を足すだけ）

**Interfaces:**
- Consumes: Task 8 の ID
- Produces: `DD-NEWS-NNN`。Task 10 で、範囲内のコードの単位がどれかの `DD-` につながる

- [ ] **Step 1: 書き直す前に、文字を固定している試験が無いことを確かめる**

Run: `rg -n "02_news_list|03_news_detail" tests e2e scripts`
Expected: 0件（あれば、その試験の決まりを読み、ユーザーに報告してから進める）

- [ ] **Step 2: 詳細設計を書く**

範囲内のコードの単位（Task 2 の決まり）を全部並べ、どれも1つの `DD-` に入るように `DD-` を切る。1つの `DD-` に入るのは、同じ入出力の契約を共有する単位だけ。各 `DD-` の本文は設計書の「詳細設計」の最小構成（対応要件 ID・入出力・正常・異常フロー・状態・永続化・認証認可・テスト観点）。今の表の `IMPL-NEWS-LIST-NNN`・`IMPL-NEWS-DETAIL-NNN`・`IMPL-NEWS-NNN` は、対応する `DD-` の `旧番号` に移す。今の表の「実装ステータス」の「済」はコードで確かめ直し、確かめられない物は状態を「推定」にする。

- [ ] **Step 3: 検査を流す**

Run（順に）: `npm run validate-trace -- NEWS`、`npm run validate-docs`
Expected: `validate-trace` は `DD-` の上位と根拠の違反が0件（`missing-impl`・単体テストの `missing-child` は残る）。`validate-docs` は今ある40件以外に増えていない

- [ ] **Step 4: コミット**

```bash
git add docs/04_DetailDesign/pages/02_news_list.md docs/04_DetailDesign/pages/03_news_detail.md docs/04_DetailDesign/pages/16-1_admin_news.md docs/04_DetailDesign/README.md
git commit -m "docs(detail): NEWS の詳細設計を項目の形に書き直し、実装の単位につなぐ" -- docs/04_DetailDesign/pages/02_news_list.md docs/04_DetailDesign/pages/03_news_detail.md docs/04_DetailDesign/pages/16-1_admin_news.md docs/04_DetailDesign/README.md
```

### Task 10: NEWS のコードに実装 ID とコメントを入れる

**Files:**
- Modify（コメントだけ）: `scope.json` の NEWS の `src` の全部のファイル（18本）
- Modify: `docs/05_Quality/reports/unused-code.md`（生成）

**Interfaces:**
- Consumes: Task 9 の `DD-`
- Produces: `IMPL-NEWS-101` からの番号。Task 11 の単体テストは `DD-` を名前に付ける

- [ ] **Step 1: ソースを文字として読む試験が無いことを確かめる**

Run: `rg -n "readFileSync|readFile\(" tests e2e | rg -i "news"`
Expected: 0件（あれば、その試験が見ているファイルはコメントを入れる前に試験の決まりを読み、照合が崩れない場所に入れる）

- [ ] **Step 2: 前の全件の単体テストの結果を控える**

Run: `npx jest --json --outputFile="$env:TEMP\trace-news-unit-before.json"`
Expected: 結果のファイルができる（落ちている物があれば件数と名前を控える）

- [ ] **Step 3: コメントを入れる**

単位ごとに設計書 5-3 の TSDoc を入れる。`@remarks` は「なぜ」だけ。今あるコメントは消さず、`@remarks` と重なる物だけを TSDoc にまとめる。関数の中の行コメントは、読んだだけでは分からない理由がある所だけに足す。

- [ ] **Step 4: 動きが変わっていないことを確かめる**

Run: `git diff -U0 -- <NEWS の src> | rg "^[+-][^+-]" | rg -v "^\s*[+-]\s*(\*|/\*\*|\*/|//)"`
Expected: 0行（コメント以外の差分が無い）

Run（順に）: `npm run typecheck`、`npm run lint`、`npx jest --json --outputFile="$env:TEMP\trace-news-unit-after.json"`
Expected: typecheck・lint は前と同じ結果。単体テストは前と同じ件数が通る

Run: `npm run validate-trace -- NEWS`
Expected: `missing-impl`・`bad-design-link`・`duplicate-impl` が0件

- [ ] **Step 5: 使われていないコードの一覧を作る**

Run: `npm run trace:report -- NEWS`
Expected: `docs/05_Quality/reports/unused-code.md` に NEWS の候補と、範囲外の3件（`inScope: false`）が並ぶ。判断の列は空

- [ ] **Step 6: コミット**

```bash
git add <NEWS の src のファイルを名前で> docs/05_Quality/reports/unused-code.md docs/05_Quality/reports/trace-matrix.md docs/05_Quality/reports/test-gaps.md
git commit -m "docs(news): NEWS のコードに実装 ID とつながる詳細設計を書く" -- <同じファイル>
```

### Task 11: NEWS の単体テストを詳細設計につなぎ、分岐を 100% にする

**Files:**
- Modify: `tests/unit/components/NewsForm.test.tsx`、`NewsSection.test.tsx`、`PublicNewsGrid.test.tsx`、`tests/unit/lib/storage/news-images.test.ts`（名前の先頭に `DD-` を付ける。中身は変えない）
- Create: 足りない単体テスト。置き場は `tests/unit/` の今の形に合わせる（例: `tests/unit/features/news/public.test.ts`、`tests/unit/app/news/page.test.tsx`、`tests/unit/app/news/detail-page.test.tsx`、`tests/unit/api/news-route.test.ts`、`tests/unit/api/admin/news-routes.test.ts`、`tests/unit/app/actions/news.test.ts`、`tests/unit/components/ArticleBody.test.tsx`、`tests/unit/app/news/NewsCategoryTabs.test.tsx`、`tests/unit/lib/news-data.test.ts`）
- Modify: `docs/05_Quality/reports/test-gaps.md`（届かない分岐の節だけ手書き）

**Interfaces:**
- Consumes: Task 9 の `DD-`、Task 5 の `npm run test:trace-coverage`

- [ ] **Step 1: 網羅の穴を出す**

Run: `$env:TRACE_AREAS='NEWS'; npm run test:trace-coverage`
Expected: 終了コード 1。分岐の網羅が 100% でないファイルと行の一覧

- [ ] **Step 2: 1つの `DD-` ずつ、失敗するか穴を埋める単体テストを書く**

名前は `DD-NEWS-NNN <確かめること>`。Server Component の画面（`page.tsx`）は、データの取得（`features/news/services/public.ts`・`lib/storage/news-images.ts`）を `jest.mock` で差し替え、返した React の要素を `render` して確かめる。Route Handler は `tests/integration/api/profile.test.ts` と同じ形で `next/server`・`@/lib/supabase/server`・`@/lib/auth/authenticate`・`@/lib/csrfMiddleware` を差し替える。各 `DD-` の異常フロー（取得の失敗・見つからない・権限なし・CSRF の拒否・入力の誤り）を1つずつ試す。

- [ ] **Step 3: 流して通るのを確かめる**

Run: `$env:TRACE_AREAS='NEWS'; npm run test:trace-coverage`
Expected: 終了コード 0、branches 100%。届かない分岐があれば、`/* istanbul ignore next */` は使わず、`test-gaps.md` の「届かない分岐」の節に `file:line` と理由を1件ずつ書き、ユーザーの確認の印（`確認: 未`）を付ける。その分だけ 100% に届かない時は、終了コードの扱いを Task 14 でユーザーに確かめる

Run: `npm run validate-trace -- NEWS`
Expected: `DD-` の `missing-child`（unit テスト）・`untagged-test`（unit）・`wrong-test-level`（unit）が0件

- [ ] **Step 4: コミット**

```bash
git add <足した・変えた単体テストを名前で> docs/05_Quality/reports/test-gaps.md
git commit -m "test(news): NEWS の単体テストを詳細設計につなぎ、分岐をすべて通す" -- <同じファイル>
```

### Task 12: NEWS の結合テストを構造設計につなぐ

**Files:**
- Create: `tests/integration/ui/news-list.test.tsx`、`tests/integration/ui/news-detail.test.tsx`、`tests/integration/ui/admin-news.test.tsx`（`SCR-`・`FLOW-`）、`tests/integration/api/news.test.ts`（`API-`）、`tests/integration/db/news_rls.integration.test.ts`（`DATA-`・`STATE-`）
- 読むだけ: `tests/integration/db/helpers/local-db.ts`（`describeLocalDb`）

**Interfaces:**
- Consumes: Task 8 の構造設計の ID

- [ ] **Step 1: 構造設計の ID ごとに、結合テストの名前と確かめることを決める**

| 種類 | 確かめ方 |
| --- | --- |
| `SCR-` | 画面の部品を組み合わせて描画し（データの取得だけ差し替える）、要素と並びを確かめる |
| `FLOW-` | React Testing Library で操作し、`next/navigation` の差し替えで遷移の先と URL の `category` を確かめる |
| `API-` | Route Handler と Server Action を、`@/lib/supabase/server` だけを差し替えて呼び、権限・CSRF・入力の検査を本物の部品で通す |
| `DATA-`・`STATE-` | `describeLocalDb` で手元の Supabase に記事を入れ、匿名のクライアントで下書きが読めないこと・公開済みが読めること・状態の移り変わりを確かめる。入れた行はテストの最後に消す |
| `ARC-` | 公開側の読み取りの部品が書き込みの部品を import していないことを確かめる（import の検査） |

- [ ] **Step 2: テストを書く**

名前は `<構造設計の ID> <確かめること>`。

- [ ] **Step 3: 流して通るのを確かめる**

Run: `npx jest tests/integration/ui tests/integration/api/news.test.ts`
Expected: PASS

DB の結合テストは、Global Constraints の確かめ（G-1 が試験を流していない・手元の Supabase が動いている）をしてから:
Run: `npx jest tests/integration/db/news_rls.integration.test.ts --runInBand`
Expected: PASS

Run: `npm run validate-trace -- NEWS`
Expected: 構造設計の `missing-child`（integration）・`wrong-test-level`（integration）が0件

- [ ] **Step 4: コミット**

```bash
git add tests/integration/ui/news-list.test.tsx tests/integration/ui/news-detail.test.tsx tests/integration/ui/admin-news.test.tsx tests/integration/api/news.test.ts tests/integration/db/news_rls.integration.test.ts
git commit -m "test(news): NEWS の結合テストを構造設計につなぐ" -- tests/integration/ui tests/integration/api/news.test.ts tests/integration/db/news_rls.integration.test.ts
```

### Task 13: NEWS の E2E を受け入れ条件につなぐ

**Files:**
- Modify: `e2e/FR-NEWS-ALL-*.spec.ts`（18本）・`e2e/FR-NEWS-DETAIL-*.spec.ts`（8本）の `test()` の名前（先頭に受け入れ条件の ID を足すだけ。中身とファイル名は変えない）
- Create: 受け入れ条件に E2E が無い物の E2E（`e2e/FR-NEWS-ALL-018-….spec.ts` から。名前の決まりは CLAUDE.md。3つの幅）
- 読むだけ: `e2e/news-detail-test-utils.ts`

**Interfaces:**
- Consumes: Task 7 の受け入れ条件の ID、Task 4 の `trace:compare-e2e`

- [ ] **Step 1: 名前を変える前の基準を取る**

Global Constraints の確かめ（3000 番に E2E でないアプリが無い・G-1 が試験を流していない・手元の Supabase）をしてから:
Run: `$env:PLAYWRIGHT_JSON_OUTPUT_NAME="$env:TEMP\trace-news-e2e-before.json"; npx playwright test e2e/FR-NEWS --reporter=json`（`>` で書くと PowerShell の文字の形が変わるので使わない）
Expected: 結果のファイルができる。落ちた物は名前を控える（既にある赤）

- [ ] **Step 2: 名前に受け入れ条件の ID を足す**

1つの `test()` が確かめている受け入れ条件を読み、その ID を先頭に足す。1つの `test()` が2つ以上の受け入れ条件を確かめている時は、主な1つを名前に付け、残りは同じファイルに1つずつ `test()` を分けるか、Task 7 の受け入れ条件の切り方を見直す（どちらにしたかを計画のメモに書く）。

- [ ] **Step 3: 受け入れ条件に E2E が無い物の E2E を書く**

Run: `npm run validate-trace -- NEWS`
Expected の前: `AC` の `missing-child`（e2e）の一覧が出る。その1件ずつに、3つの幅で確かめる E2E を書く

- [ ] **Step 4: 前後を比べる**

Run: `$env:PLAYWRIGHT_JSON_OUTPUT_NAME="$env:TEMP\trace-news-e2e-after.json"; npx playwright test e2e/FR-NEWS --reporter=json` の後に `npm run trace:compare-e2e -- "$env:TEMP\trace-news-e2e-before.json" "$env:TEMP\trace-news-e2e-after.json"`
Expected: 終了コード 0（前に通って後で落ちた物が0、新しい失敗が0）。足した E2E は全部通る

Run: `npm run validate-trace -- NEWS`
Expected: 違反0件

- [ ] **Step 5: コミット**

```bash
git add <変えた・足した e2e のファイルを名前で>
git commit -m "test(news): NEWS の E2E を受け入れ条件につなぎ、足りない受け入れ条件の E2E を足す" -- <同じファイル>
```

### Task 14: NEWS の試しの仕上げと確かめ

**Files:**
- Modify: `docs/05_Quality/reports/{trace-matrix,test-gaps,unused-code}.md`（生成し直し）

- [ ] **Step 1: 全部の確かめを流す**

Run: `npm run validate-trace -- NEWS`
Expected: 違反0件

Run: `$env:TRACE_AREAS='NEWS'; npm run test:trace-coverage`
Expected: branches 100%（届かない分岐は `test-gaps.md` に理由つき）

Run: `npx jest --json --outputFile="$env:TEMP\trace-news-unit-final.json"` と、Task 10 の Step 2 の結果との比べ
Expected: 前に通っていて今落ちる試験が0件（ソースを文字として読む試験と、文書の文字を固定する試験 `tests/unit/docs/*` を含む）

Run: `npm run validate-docs`
Expected: 今ある40件以外の切れが0件

Run: `npm run trace -- IMPL-NEWS-101` と `npm run trace -- src/features/news/services/public.ts`
Expected: 上（要求まで）と下（テストまで）と兄弟の単位が出る

- [ ] **Step 2: 一覧を生成し直してコミット**

```bash
npm run trace:report -- NEWS
git add docs/05_Quality/reports/trace-matrix.md docs/05_Quality/reports/test-gaps.md docs/05_Quality/reports/unused-code.md
git commit -m "docs(quality): NEWS の試しのつながりの一覧を生成する" -- docs/05_Quality/reports/trace-matrix.md docs/05_Quality/reports/test-gaps.md docs/05_Quality/reports/unused-code.md
```

- [ ] **Step 3: 全体のレビュー**

Opus（エフォート high）のレビューを1本出す。見る点: 上の段と中身の一致（Automotive SPICE の一貫性）、根拠が「なぜ」になっているか、推定の印の付け方、セキュリティの脅威の抜け、コメント以外の差分の有無、範囲外のファイルへの変更の有無（`git log --stat` で確かめる）。

- [ ] **Step 4: ユーザーに見せる**

見せる物: `trace-matrix.md`、`docs/02_Requirements/areas/news.md` の数項目、`DD-` と `@impl` の付いたコードの例、`test-gaps.md`、`unused-code.md`、`npm run trace` の出力の例、「推定」の項目の一覧（ユーザーの確認待ち）、食い違いの一覧。聞くこと: 書式と粒度（実装 ID の単位、`DD-` の切り方）を残りの領域でもこのまま使ってよいか。

答えをもらったら、残りの領域（HOME・LOOK・ABOUT・STOCKIST・SEARCH・PRIVACY・AUTH・管理のそのほか）の計画を、この計画の Task 7〜14 の形で別に作る。
