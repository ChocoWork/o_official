/** @jest-environment node */
import { compareUncovered, uncoveredOf, type CoverageJson } from '@/../scripts/trace/check-coverage';

const branch = (line: number, armLine: number, counts: number[]) => ({
  b: { '0': counts },
  branchMap: { '0': { loc: { start: { line } }, locations: counts.map(() => ({ start: { line: armLine } })) } },
});
const cov = (file: string, b: ReturnType<typeof branch>): CoverageJson => ({ [file]: b });

describe('uncoveredOf', () => {
  it('count が 0 の枝だけを、枝の行と分岐の行の両方で返し、絶対パスは root からの / 区切りにする', () => {
    const root = process.platform === 'win32' ? 'C:\\w' : '/w';
    const abs = process.platform === 'win32' ? 'C:\\w\\src\\a.ts' : '/w/src/a.ts';
    const r = uncoveredOf(cov(abs, branch(10, 12, [3, 0])), root);
    expect(r.branches).toEqual([['src/a.ts:12', 'src/a.ts:10']]);
    expect([...r.files]).toEqual(['src/a.ts']);
  });
});

describe('compareUncovered', () => {
  const coverage = cov('src/a.ts', branch(10, 12, [1, 0]));

  it('節に載っている届かない分岐だけなら問題は無い（枝の行でも分岐の行でもよい）', () => {
    expect(compareUncovered(coverage, [{ file: 'src/a.ts', line: 12, reason: 'r' }])).toEqual({ unlisted: [], stale: [] });
    expect(compareUncovered(coverage, [{ file: 'src/a.ts', line: 10, reason: 'r' }])).toEqual({ unlisted: [], stale: [] });
  });

  it('節に無い届かない分岐は unlisted に出す（増えた）', () => {
    expect(compareUncovered(coverage, [])).toEqual({ unlisted: ['src/a.ts:12'], stale: [] });
  });

  it('節にあるのに今は届いている行は stale に出す（ずれた）', () => {
    const r = compareUncovered(coverage, [
      { file: 'src/a.ts', line: 12, reason: 'r' },
      { file: 'src/a.ts', line: 99, reason: '古い' },
    ]);
    expect(r).toEqual({ unlisted: [], stale: ['src/a.ts:99'] });
  });

  it('網羅の対象でない実行のファイル、「網羅の数には入らない」と書いた行は stale にしない', () => {
    const r = compareUncovered(coverage, [
      { file: 'src/a.ts', line: 12, reason: 'r' },
      { file: 'src/other.ts', line: 5, reason: 'r' },
      { file: 'src/a.ts', line: 50, reason: '通らない（分岐の網羅の数には入らない）' },
    ]);
    expect(r).toEqual({ unlisted: [], stale: [] });
  });
});
