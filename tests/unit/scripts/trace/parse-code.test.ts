/** @jest-environment node */
import { parseCodeUnits } from '@/../scripts/trace/parse-code';

describe('parseCodeUnits', () => {
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

  it('route.ts はファイル単位で、コメントが無くても1つ返す', () => {
    const src = "export async function GET() { return new Response(); }\n";
    expect(parseCodeUnits('src/app/api/news/route.ts', src)).toEqual([
      { file: 'src/app/api/news/route.ts', line: 1, symbol: '<file>', unitKind: 'file',
        designIds: [], remarks: '' },
    ]);
  });

  it("'use server' の .ts は export された関数ごとで、クラスは数えない", () => {
    const src = "/** 見出し */\n'use server';\n\n/**\n * @impl IMPL-NEWS-104\n * @design DD-NEWS-004\n */\nexport async function save() {}\nexport class K {}\n";
    const units = parseCodeUnits('src/app/actions/news.ts', src);
    expect(units).toEqual([
      { file: 'src/app/actions/news.ts', line: 8, symbol: 'save', unitKind: 'function',
        implId: 'IMPL-NEWS-104', designIds: ['DD-NEWS-004'], remarks: '' },
    ]);
  });

  it('そのほかの .ts はクラスと function 式の const も数え、多行の @remarks と複数の @design を読む', () => {
    const src = "/**\n * @packageDocumentation\n * @impl IMPL-NEWS-900\n */\nexport class Repo {}\n/**\n * @impl IMPL-NEWS-105\n * @design DD-NEWS-005, DD-NEWS-006\n * @design DD-NEWS-007\n * @remarks 1行目\n *   2行目\n */\nexport const f = (async function () {}) as () => Promise<void>;\nexport function over(a: string): void;\nexport function over(a: unknown) {}\n";
    const units = parseCodeUnits('src/lib/news/repo.ts', src);
    expect(units.map((u) => [u.symbol, u.unitKind, u.line, u.implId])).toEqual([
      ['Repo', 'function', 5, undefined],
      ['f', 'function', 13, 'IMPL-NEWS-105'],
      ['over', 'function', 15, undefined],
    ]);
    expect(units[1].designIds).toEqual(['DD-NEWS-005', 'DD-NEWS-006', 'DD-NEWS-007']);
    expect(units[1].remarks).toBe('1行目 2行目');
  });

  it('@packageDocumentation の無い先頭のコメントはファイル単位として読まない', () => {
    const src = "/**\n * @impl IMPL-NEWS-106\n * @design DD-NEWS-006\n */\nexport function A() { return null; }\n";
    expect(parseCodeUnits('src/features/news/components/A.tsx', src)[0].implId).toBeUndefined();
  });

  it('ID の形でない @impl は読まない', () => {
    const src = "/**\n * @packageDocumentation\n * @impl TODO\n * @design 未定\n */\n";
    expect(parseCodeUnits('src/features/news/components/B.tsx', src)[0]).toMatchObject({
      implId: undefined, designIds: [],
    });
  });

  it('.ts・.tsx 以外と .d.ts は単位にしない', () => {
    expect(parseCodeUnits('src/a.js', 'export function a() {}\n')).toEqual([]);
    expect(parseCodeUnits('src/types/a.d.ts', 'export declare function a(): void;\n')).toEqual([]);
  });
});
