/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TraceItem } from '@/../scripts/trace/model';
import type { CodeUnit } from '@/../scripts/trace/parse-code';
import type { TraceModel } from '@/../scripts/trace/rules';
import { findUnused, renderUnused, seedNotes, type UnusedCandidate } from '@/../scripts/trace/unused';

let root: string;
function put(rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const item = (id: string, kind: TraceItem['kind'], parents: string[]): TraceItem => ({
  id, kind, title: 't', file: 'docs/a.md', line: 1, parents, outOfScopeParents: [], rationale: 'r', status: '現行', oldIds: [],
});
const unit = (file: string, symbol: string, designIds: string[] = []): CodeUnit => ({
  file, line: 1, symbol, unitKind: symbol === '<file>' ? 'file' : 'function', designIds, remarks: '',
});

function model(): TraceModel {
  return {
    items: [
      item('FREQ-31', 'REQUEST', []), item('FR-NEWS-ALL-001', 'REQ', ['FREQ-31']), item('API-NEWS-001', 'API', ['FR-NEWS-ALL-001']), item('DD-NEWS-001', 'DD', ['API-NEWS-001']),
      // 上位が範囲外の構造設計だけの DD と、範囲外の ID を（範囲外）の印なしで上位に書いた DD。
      { ...item('DD-NEWS-010', 'DD', []), outOfScopeParents: ['ARC-COMMON-001'] },
      item('DD-NEWS-011', 'DD', ['API-HOME-001']),
      item('DRV-NEWS-001', 'DRV', []), item('API-NEWS-002', 'API', ['DRV-NEWS-001']), item('DD-NEWS-012', 'DD', ['API-NEWS-002']),
    ],
    units: [
      unit('src/app/news/page.tsx', '<file>', ['DD-NEWS-001']),
      unit('src/lib/news-data.ts', 'used', ['DD-NEWS-001']),
      unit('src/lib/news-data.ts', 'unusedExport', ['DD-NEWS-001']),
      unit('src/lib/news-data.ts', 'orphan', ['DD-NEWS-999']),
      unit('src/lib/news-data.ts', 'viaCommon', ['DD-NEWS-010']),
      unit('src/lib/news-data.ts', 'otherArea', ['DD-HOME-001']),
      unit('src/lib/news-data.ts', 'viaHomeApi', ['DD-NEWS-011']),
      unit('src/lib/news-data.ts', 'derived', ['DD-NEWS-012']),
    ],
    tests: [],
    knownIdsOutsideScope: new Set(['DD-HOME-001', 'API-HOME-001']),
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-unused-'));
  put('src/app/news/page.tsx', "import { used, orphan } from '@/lib/news-data';\nimport type { Shape } from '../../types/shape';\nexport default function P() { return used() + orphan(); }\n");
  put('src/lib/news-data.ts', 'export function used() { return 1; }\nexport function unusedExport() { return 2; }\nexport function orphan() { return 3; }\nexport const NOTE = 1;\n');
  put('src/types/shape.ts', 'export type Shape = { a: 1 };\n');
  put('src/lib/dead.ts', 'export function dead() {}\n');
  put('src/lib/only-test.ts', 'export function t() {}\n');
  put('src/lib/by-script.ts', 'export function s() {}\n');
  put('src/lib/dynamic.ts', 'export function d() {}\n');
  put('src/lib/dir/index.ts', 'export function i() {}\n');
  put('src/proxy.ts', 'export function proxy() {}\n');
  put('src/app/api/x/route.ts', "import { d } from '@/lib/dir';\nexport async function GET() { return import('@/lib/dynamic').then(() => d); }\n");
  put('src/graphify-out/cache/x.ts', 'export const g = 1;\n');
  put('tests/unit/only.test.ts', "import { t } from '@/lib/only-test';\njest.mock('@/lib/dead');\n");
  put('scripts/s.ts', "import { s } from '../src/lib/by-script';\n");
  put('e2e/a.spec.ts', "test('x', () => {});\n");
  put('docs/a.md', 'lib/dead は使われていない。\n');
  put('docs/05_Quality/reports/unused-code.md', 'lib/dead\n');
  put('docs/superpowers/plans/p.md', 'lib/dead\n');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const keyOf = (c: UnusedCandidate) => `${c.file}|${c.symbol}|${c.finding}|${c.inScope ? 'in' : 'out'}`;

describe('findUnused', () => {
  it('どこからも import されないファイルと export、要件につながらない単位を返す', () => {
    const keys = findUnused(root, model()).map(keyOf);
    expect(keys).toEqual(
      expect.arrayContaining([
        'src/lib/news-data.ts|unusedExport|参照なし|in',
        'src/lib/news-data.ts|NOTE|参照なし|in',
        'src/lib/news-data.ts|orphan|要件につながらない|in',
      ]),
    );
    expect(keys).not.toContain('src/lib/news-data.ts|used|参照なし|in');
    expect(keys).not.toContain('src/lib/news-data.ts|orphan|参照なし|in');
    expect(keys.filter((k) => k.includes('要件につながらない'))).toEqual(['src/lib/news-data.ts|orphan|要件につながらない|in']);
  });

  it('jest.mock だけのファイルは参照ありとみなし、範囲外の候補は inScope: false で載せる', () => {
    const noRef = () => findUnused(root, model()).filter((c) => c.symbol === '<file>' && c.finding === '参照なし').map(keyOf);
    expect(noRef()).toEqual([]);
    fs.writeFileSync(path.join(root, 'tests/unit/only.test.ts'), "import { t } from '@/lib/only-test';\n");
    expect(noRef()).toEqual(['src/lib/dead.ts|<file>|参照なし|out']);
  });

  it('試験・道具からだけ指されるファイルと export は「試験だけが参照」で載せる（製品の中で使われないので）', () => {
    put('src/lib/shared.ts', 'export function both() {}\nexport function onlyTest() {}\nexport function unreferenced() {}\n');
    put('src/app/y/page.tsx', "import { both } from '@/lib/shared';\nexport default both;\n");
    put('tests/unit/shared.test.ts', "import { onlyTest } from '@/lib/shared';\nimport { both } from '@/lib/shared';\n");
    const m = model();
    m.units.push(unit('src/lib/shared.ts', 'both', ['DD-NEWS-001']));
    const keys = findUnused(root, m).map(keyOf);
    expect(keys).toEqual(expect.arrayContaining([
      'src/lib/only-test.ts|<file>|試験だけが参照|out',
      'src/lib/by-script.ts|<file>|試験だけが参照|out',
      'src/lib/shared.ts|onlyTest|試験だけが参照|in',
      'src/lib/shared.ts|unreferenced|参照なし|in',
    ]));
    expect(keys).not.toContain('src/lib/shared.ts|both|試験だけが参照|in');
    expect(keys).not.toContain('src/lib/shared.ts|<file>|試験だけが参照|in');
    expect(findUnused(root, m).find((c) => c.symbol === 'onlyTest')?.how).toContain('tests/unit/shared.test.ts');
  });

  it('参照なしのファイルには文字の検索と文書の参照を書く（生成物の一覧は数えない）', () => {
    fs.writeFileSync(path.join(root, 'tests/unit/only.test.ts'), "import { t } from '@/lib/only-test';\n");
    const dead = findUnused(root, model()).find((c) => c.file === 'src/lib/dead.ts');
    expect(dead?.how).toContain('「lib/dead」か「./dead」');
    expect(dead?.how).toContain('ほかのファイルに 0 件');
    expect(dead?.impact).toContain('docs/a.md');
    expect(dead?.impact).not.toContain('reports/unused-code.md');
    expect(dead?.impact).not.toContain('superpowers');
    put('scripts/odd.js', "const x = 'src/lib/dead.ts';\n");
    expect(findUnused(root, model()).find((c) => c.file === 'src/lib/dead.ts')?.how).toContain('ほかのファイルに 1 件（scripts/odd.js）');
  });

  it('上へのつながりが範囲外へ出る単位は、届かないと決めつけずに載せない', () => {
    const symbols = findUnused(root, model()).filter((c) => c.finding === '要件につながらない').map((c) => c.symbol);
    // 範囲外の ARC-COMMON-001 の下・別の領域の DD・範囲外の API の下は載せない。DRV の下はつながっている。
    expect(symbols).not.toContain('viaCommon');
    expect(symbols).not.toContain('otherArea');
    expect(symbols).not.toContain('viaHomeApi');
    expect(symbols).not.toContain('derived');
    expect(symbols).toEqual(['orphan']);
  });

  it('seedNotes: 最初の候補が参照されるようになった・無くなった時に知らせる', () => {
    put('src/components/ContactSection.tsx', 'export function C() { return null; }\n');
    put('src/app/x/page.tsx', "import { C } from '@/components/ContactSection';\nexport default C;\n");
    put('src/lib/cache/redis-cache.ts', 'export const r = 1;\n');
    const notes = seedNotes(findUnused(root, model()), root);
    expect(notes).toEqual([
      expect.stringContaining('src/components/ContactSection.tsx は今は参照されている'),
      expect.stringContaining('src/utils/supabase/server.ts が見つからない'),
    ]);
  });

  it('範囲外のファイルの export は調べない', () => {
    expect(findUnused(root, model()).map((c) => c.file)).not.toContain('src/types/shape.ts');
  });
});

describe('renderUnused', () => {
  const cand: UnusedCandidate = { file: 'src/lib/cache/index.ts', symbol: '<file>', finding: '参照なし', how: 'x', impact: 'なし', inScope: false };

  it('renderUnused は前の版の判断の列を残す', () => {
    const prev = '| 場所 | 記号 | 見つけ方 | 確かめた方法 | 消した時の影響 | 範囲 | 判断 |\n| --- | --- | --- | --- | --- | --- | --- |\n| src/lib/cache/index.ts | <file> | 参照なし | x | なし | 範囲外 | 消す |\n';
    const out = renderUnused([cand], prev);
    expect(out).toContain('| 消す |');
  });

  it('自分の出した表を前の版として読んでも判断が残り、| を含む中身は崩れない', () => {
    const first = renderUnused([{ ...cand, how: 'a|b' }]).replace(/\| 範囲外 \|  \|/, '| 範囲外 | 残す |');
    expect(first).toContain('a\\|b');
    expect(renderUnused([{ ...cand, how: 'a|b' }], first)).toContain('| 範囲外 | 残す |');
  });

  it('前の版に無い候補の判断は空、範囲内は「範囲内」と書く', () => {
    const out = renderUnused([{ ...cand, inScope: true }]);
    expect(out).toContain('| 範囲内 |  |');
    expect(out.split('\n')[0]).toBe('| 場所 | 記号 | 見つけ方 | 確かめた方法 | 消した時の影響 | 範囲 | 判断 |');
  });
});
