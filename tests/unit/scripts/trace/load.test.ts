/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModel, loadScope } from '@/../scripts/trace/load';

let root: string;

function put(rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const DOC = (id: string) => `### ${id} 題\n\n| 属性 | 値 |\n| --- | --- |\n| 状態 | 現行 |\n`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-load-'));
  put(
    'scope.json',
    '﻿' +
      JSON.stringify([
        {
          area: 'NEWS',
          docs: ['docs/in/a.md', 'docs/dec/*.md'],
          src: ['src/news/**/*.{ts,tsx}'],
          tests: ['tests/unit/**/*news*.test.ts', 'tests/unit/**/news/**/*.test.ts'],
          e2e: ['e2e/FR-NEWS-*.spec.ts'],
        },
      ]),
  );
  put('docs/in/a.md', DOC('DD-NEWS-001'));
  put('docs/dec/ADR-0001-x.md', DOC('ADR-0001'));
  put('docs/other.md', '範囲外の文書。FR-NEWS-ALL-001 と SEC-001 を書く。NEWS-X は ID でない。\n');
  put('docs/sub/b.md', DOC('API-HOME-001'));
  put('docs/graphify-out/c.md', 'SEC-777\n');
  put('src/news/a.ts', '/** @impl IMPL-NEWS-101\n * @design DD-NEWS-001 */\nexport function f() {}\n');
  put('src/news/v.tsx', 'export default function V() { return null; }\n');
  put('src/other/b.ts', 'export function g() {}\n');
  put('tests/unit/news/news.test.ts', "it('DD-NEWS-001 x', () => {});\n");
  put('tests/unit/other.test.ts', "it('DD-HOME-001 x', () => {});\n");
  put('e2e/FR-NEWS-ALL-001-x.spec.ts', "test('FR-NEWS-ALL-001-AC-01 x', async () => {});\n");
  put('e2e/FR-HOME-001-x.spec.ts', "test('FR-HOME-001-AC-01 x', async () => {});\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('loadScope', () => {
  it('BOM 付きの scope.json を読む', () => {
    expect(loadScope(path.join(root, 'scope.json')).map((a) => a.area)).toEqual(['NEWS']);
  });

  it('既定は scripts/trace/scope.json で、NEWS の領域を持つ', () => {
    const news = loadScope().find((a) => a.area === 'NEWS');
    expect(news?.tests).toEqual(expect.arrayContaining(['tests/unit/**/news/**/*.test.{ts,tsx}', 'tests/integration/**/news/**/*.test.{ts,tsx}']));
  });
});

describe('loadModel', () => {
  it('範囲内のファイルだけを読み、パスは root からの / 区切りにする', () => {
    const model = loadModel(loadScope(path.join(root, 'scope.json')), root);
    expect(model.items.map((i) => [i.id, i.file])).toEqual([
      ['DD-NEWS-001', 'docs/in/a.md'],
      ['ADR-0001', 'docs/dec/ADR-0001-x.md'],
    ]);
    expect(model.units.map((u) => [u.file, u.implId])).toEqual([
      ['src/news/a.ts', 'IMPL-NEWS-101'],
      ['src/news/v.tsx', undefined],
    ]);
    expect(model.tests.map((t) => [t.file, t.id, t.level])).toEqual([
      ['tests/unit/news/news.test.ts', 'DD-NEWS-001', 'unit'],
      ['e2e/FR-NEWS-ALL-001-x.spec.ts', 'FR-NEWS-ALL-001-AC-01', 'e2e'],
    ]);
  });

  it('docs/ の範囲外の文書に現れる ID を knownIdsOutsideScope に入れる', () => {
    const { knownIdsOutsideScope } = loadModel(loadScope(path.join(root, 'scope.json')), root);
    expect([...knownIdsOutsideScope].sort()).toEqual(['API-HOME-001', 'FR-NEWS-ALL-001', 'SEC-001']);
  });
});
