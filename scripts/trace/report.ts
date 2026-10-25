// npm run trace:report
// scope.json の全領域から trace-matrix.md・test-gaps.md・unused-code.md を docs/05_Quality/reports/ に書く。
// 生成物は全領域をまとめた1つの一覧なので、領域名を渡しても全領域を書く（1つの領域だけで書き直すと、ほかの領域の行が消える）。
// 手書きの節（食い違い・届かない分岐）と判断の列は前の版から引き継ぐ。
// 設計: docs/superpowers/specs/2026-10-24-traceability-design.md の 6-1・7・8。

import fs from 'node:fs';
import path from 'node:path';
import { ancestorsOf } from './impact';
import { loadModel, loadScope } from './load';
import { kindOf, type TraceItem, type TraceKind } from './model';
import type { CodeUnit } from './parse-code';
import type { TestLevel, TestRef } from './parse-tests';
import type { TraceModel } from './rules';
import { findUnused, renderUnused, seedNotes } from './unused';

export interface UncoveredBranch { file: string; line: number; reason: string }

const STRUCT: readonly TraceKind[] = ['ARC', 'SCR', 'FLOW', 'STATE', 'API', 'DATA'];
const NONE = '（なし）';
const MISMATCH = '## 食い違い';
const UNCOVERED = '## 届かない分岐';
const GAPS = '## 試験の足りない項目';
const UNTAGGED = '## 名前に ID の無い試験';
const SKIPPED = '## 飛ばしている試験';
const UNCOVERED_NOTE = '手書きの節。分岐の網羅で届かない所を、1行に1件「- `場所:行` 理由。確認: 未」の形で書く。生成し直しても残る。';
const DERIVED = '（派生要件）';

const cell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
const row = (cells: string[]) => `| ${cells.map(cell).join(' | ')} |`;
const table = (header: string[], rows: string[][]) =>
  [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n') + '\n';
const or = (parts: string[], sep = '、') => (parts.length > 0 ? parts.join(sep) : NONE);

const named = (i: TraceItem) => `${i.id} ${i.title}`.trim();
const where = (t: { file: string; line: number }) => `\`${t.file}:${t.line}\``;
const unitName = (u: CodeUnit) => (u.symbol === '<file>' ? `\`${u.file}\`` : `\`${u.file}\` の ${u.symbol}`);

function index(model: TraceModel) {
  const live = model.items.filter((i) => i.status !== '廃止');
  const byId = new Map(model.items.map((i) => [i.id, i]));
  const childrenOf = (id: string, kinds: readonly TraceKind[]) => live.filter((c) => kinds.includes(c.kind) && c.parents.includes(id));
  // skip・todo・fixme の試験は確かめにならないので、「試験がある」に数えない（飛ばしている試験の節に出す）。
  const testsOf = (id: string, level: TestLevel) => model.tests.filter((t) => t.id === id && t.level === level && !t.skipped);
  /** 上位の欄の ID（範囲外は印を付ける）。 */
  const parentsOf = (i: TraceItem) => [...i.parents, ...i.outOfScopeParents.map((p) => `${p}（範囲外）`)];
  return { live, byId, childrenOf, testsOf, parentsOf };
}

function requirementRows(model: TraceModel): string[][] {
  const { live, byId, childrenOf, testsOf } = index(model);
  const rows: string[][] = [];
  const shown = new Set<string>();
  const addRequirement = (top: string, req: TraceItem) => {
    shown.add(req.id);
    const acs = childrenOf(req.id, ['AC']);
    if (acs.length === 0) rows.push([top, named(req), NONE, NONE]);
    for (const ac of acs) rows.push([top, named(req), named(ac), or(testsOf(ac.id, 'e2e').map(where), '<br>')]);
  };
  for (const top of live.filter((i) => i.kind === 'REQUEST' || i.kind === 'THR')) {
    const reqs = childrenOf(top.id, top.kind === 'REQUEST' ? ['REQ'] : ['SEC']);
    if (reqs.length === 0) rows.push([named(top), NONE, NONE, NONE]);
    for (const req of reqs) addRequirement(named(top), req);
  }
  // 範囲内の要求・脅威につながらない要件（範囲外の要求の下・上位なし）と、上位を持たない派生要件。
  for (const req of live.filter((i) => (i.kind === 'REQ' || i.kind === 'SEC' || i.kind === 'DRV') && !shown.has(i.id))) {
    const tops = [...req.parents.filter((p) => !byId.has(p)), ...req.outOfScopeParents].map((p) => `${p}（範囲外）`);
    addRequirement(req.kind === 'DRV' && tops.length === 0 ? DERIVED : or(tops), req);
  }
  return rows;
}

/** trace-matrix.md の本文。「食い違い」の節は空の見出しだけ（前の版の中身は report の main が戻す）。 */
export function renderMatrix(model: TraceModel): string {
  const { live, testsOf, parentsOf } = index(model);
  const structs = live.filter((i) => STRUCT.includes(i.kind));
  const dds = live.filter((i) => i.kind === 'DD');
  const unitsOf = (id: string) => model.units.filter((u) => u.designIds.includes(id));

  // 詳細設計の列の後ろに、上へたどった項目を種類ごとに並べる。
  const columns: [string, readonly TraceKind[]][] = [
    ['構造設計・ADR', [...STRUCT, 'ADR']],
    ['要件', ['REQ', 'SEC', 'DRV']],
    ['要求・脅威', ['REQUEST', 'THR']],
  ];
  const upRows = model.units.map((u) => {
    const chain = ancestorsOf(model, u.designIds);
    const ids = [...chain.map((i) => i.id), ...chain.flatMap((i) => i.outOfScopeParents.map((p) => `${p}（範囲外）`))];
    const inColumn = (kinds: readonly TraceKind[]) => ids.filter((id) => {
      const k = kindOf(id.replace(/（範囲外）$/, ''));
      return k !== null && kinds.includes(k);
    });
    // 詳細設計は @design に書かれたまま出す（範囲内に無い ID も見えるように）。
    return [unitName(u), u.implId ?? NONE, or(u.designIds), ...columns.map(([, kinds]) => or([...new Set(inColumn(kinds))]))];
  });

  return [
    '## 要求から下へ',
    '',
    '### 要求 → 要件 → 受け入れ条件 → E2E',
    '',
    table(['要求・脅威', '要件', '受け入れ条件', 'E2E'], requirementRows(model)),
    '### 構造設計 → 結合テスト',
    '',
    table(['構造設計', '上位', '結合テスト'], structs.map((s) => [named(s), or(parentsOf(s)), or(testsOf(s.id, 'integration').map(where), '<br>')])),
    '### 詳細設計 → コードの単位 → 単体テスト',
    '',
    table(
      ['詳細設計', '上位', 'コードの単位', '単体テスト'],
      dds.map((d) => [
        named(d),
        or(parentsOf(d)),
        or(unitsOf(d.id).map((u) => `${u.implId ?? '（@impl なし）'} ${unitName(u)}`), '<br>'),
        or(testsOf(d.id, 'unit').map(where), '<br>'),
      ]),
    ),
    '## 下から上へ',
    '',
    table(['コードの単位', '実装', '詳細設計', ...columns.map(([h]) => h)], upRows),
    MISMATCH,
    '',
    '（手書きの節。文書とコードが違う所を、どちらが正しいかを決めずに書く。生成し直しても残る）',
    '',
  ].join('\n');
}

/** test-gaps.md の本文。「届かない分岐」の節は uncovered から書く（前の版から読んだ物を渡す）。 */
export function renderTestGaps(model: TraceModel, uncovered: UncoveredBranch[]): string {
  const { live, testsOf } = index(model);
  const need: [(i: TraceItem) => boolean, TestLevel, string][] = [
    [(i) => i.kind === 'AC', 'e2e', 'E2E'],
    [(i) => STRUCT.includes(i.kind), 'integration', '結合テスト'],
    [(i) => i.kind === 'DD', 'unit', '単体テスト'],
  ];
  const gaps = live.flatMap((i) =>
    need.filter(([is, level]) => is(i) && testsOf(i.id, level).length === 0).map(([, , what]) => [named(i), what, where(i)]),
  );
  const untagged = model.tests.filter((t: TestRef) => t.id === null).map((t) => [t.level, where(t), t.title]);
  const skipped = model.tests.filter((t: TestRef) => t.skipped).map((t) => [t.level, where(t), t.id ?? NONE, t.title]);
  return [
    GAPS,
    '',
    gaps.length > 0 ? table(['項目', '足りない試験', '場所'], gaps) : `${NONE}\n`,
    UNTAGGED,
    '',
    untagged.length > 0 ? table(['段', '場所', '名前'], untagged) : `${NONE}\n`,
    SKIPPED,
    '',
    skipped.length > 0 ? table(['段', '場所', '指す項目', '名前'], skipped) : `${NONE}\n`,
    UNCOVERED,
    '',
    UNCOVERED_NOTE,
    '',
    ...(uncovered.length > 0 ? uncovered.map((u) => `- ${where(u)} ${u.reason}`) : [NONE]),
    '',
  ].join('\n');
}

/**
 * 見出しの行から、次の生成の見出し（stops のどれか）の手前までの範囲。無ければ null。
 * 手書きの節の中に人が書いた `## ` では切らない。
 */
function sectionOf(text: string, heading: string, stops: readonly string[]): { start: number; end: number } | null {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trimEnd() === heading);
  if (at < 0) return null;
  const next = lines.findIndex((l, i) => i > at && stops.includes(l.trimEnd()));
  const offset = (n: number) => lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0);
  return { start: offset(at), end: next < 0 ? text.length : offset(next) };
}

/** 「届かない分岐」の節の「- `file:line` 理由」を読む。 */
export function parseUncovered(text: string): UncoveredBranch[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const range = sectionOf(normalized, UNCOVERED, [GAPS, UNTAGGED, SKIPPED]);
  if (!range) return [];
  const out: UncoveredBranch[] = [];
  // 1行目は見出し。
  for (const line of normalized.slice(range.start, range.end).split('\n').slice(1)) {
    const m = /^\s*[-*]\s+`?([^`\s]+?):(\d+)`?\s*(?:[—–-]\s*)?(.*)$/.exec(line);
    if (m) out.push({ file: m[1], line: Number(m[2]), reason: m[3].trim() });
    else if (!['', UNCOVERED_NOTE, NONE].includes(line.trim())) {
      console.error(`警告: 「届かない分岐」の節の次の行を読めない（生成し直すと消える）: ${line}`);
    }
  }
  return out;
}

/** generated の heading の節を、previous に同じ節があればその中身に差し替える。 */
export function keepHandSection(generated: string, previous: string | undefined, heading: string): string {
  const prev = previous?.replace(/\r\n/g, '\n');
  // 生成が出す見出しだけで切る（前の版の中の、人が書いた見出しでは切らない）。
  const stops = generated.split('\n').filter((l) => l.startsWith('## ') && l.trimEnd() !== heading).map((l) => l.trimEnd());
  const from = prev ? sectionOf(prev, heading, stops) : null;
  const to = sectionOf(generated, heading, stops);
  if (!prev || !from || !to) return generated;
  const rest = generated.slice(to.end);
  return generated.slice(0, to.start) + prev.slice(from.start, from.end).trimEnd() + '\n' + (rest ? '\n' : '') + rest;
}

/** 生成物の先頭（題・メタの行・概要）。概要の節が無いと validate-docs が落ちる。 */
export function renderHead(title: string, summary: string, hand: string, areas: string[], date: string): string {
  return (
    `# ${title}\n\n> 状態: 自動生成 | 生成日: ${date} | 対象: ${areas.join('・')}\n\n` +
    `## 概要\n\n${summary}\n\n` +
    `\`npm run trace:report\` が作る。手で直さない（${hand}）。\n\n`
  );
}

const REPORTS = 'docs/05_Quality/reports';

function today(): string {
  const d = new Date();
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
}

function main(argv: string[]): number {
  const all = loadScope();
  const unknown = argv.filter((n) => !all.some((a) => a.area === n));
  if (unknown.length > 0) {
    console.error(`scope.json に無い領域: ${unknown.join(', ')}`);
    return 2;
  }
  if (argv.length > 0) console.error('注意: 一覧は全領域をまとめて作るので、領域名は使わずに全領域を書く');
  const areas = all;
  const root = process.cwd();
  const model = loadModel(areas, root);
  const head = (title: string, summary: string, hand: string) =>
    renderHead(title, summary, hand, areas.map((a) => a.area), today());
  const previous = (name: string) => {
    const file = path.join(root, REPORTS, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : undefined;
  };
  const unused = findUnused(root, model);
  const outputs: [string, string][] = [
    ['trace-matrix.md', keepHandSection(head('追跡の一覧', '要求から受け入れ条件・E2E・構造設計・詳細設計・コードの単位・単体テストまでのつながりを、上から下と下から上の両方で並べた表。', '「食い違い」の節だけは手で書き、生成し直しても残る') + renderMatrix(model), previous('trace-matrix.md'), MISMATCH)],
    ['test-gaps.md', head('試験の穴', '試験が足りない項目、名前に ID の無い試験、飛ばしている試験、分岐の網羅で届かない所を並べた表。', '「届かない分岐」の節だけは手で書き、生成し直しても残る') + renderTestGaps(model, parseUncovered(previous('test-gaps.md') ?? ''))],
    ['unused-code.md', head('使われていないコードの候補', 'どこからも呼ばれていないコードの候補と、残すか消すかの判断。', '「判断」の列だけはユーザーが書き、生成し直しても残る。候補は消さずに載せる') + renderUnused(unused, previous('unused-code.md'))],
  ];
  for (const note of seedNotes(unused, root)) console.error(note);
  fs.mkdirSync(path.join(root, REPORTS), { recursive: true });
  for (const [name, text] of outputs) {
    fs.writeFileSync(path.join(root, REPORTS, name), text);
    console.log(`${REPORTS}/${name} を書いた`);
  }
  console.log(`項目 ${model.items.length} 件・単位 ${model.units.length} 件・テスト ${model.tests.length} 件・使われていない候補 ${unused.length} 件`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
