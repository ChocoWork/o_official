// npm run test:trace-coverage の後に流し、分岐の網羅で届かない所を test-gaps.md の「届かない分岐」の節と突き合わせる。
// 節に無い届かない分岐（増えた）と、節にあるのに今は届いている分岐（ずれた）があれば終了コード 1。
// 節の行に「分岐の網羅の数には入らない」と書いた物は、網羅の数に出ないので突き合わせから外す。

import fs from 'node:fs';
import path from 'node:path';
import { parseUncovered, type UncoveredBranch } from './report';

export interface BranchLocation { start: { line?: number } }
export interface FileCoverage {
  b: Record<string, number[]>;
  branchMap: Record<string, { loc: BranchLocation; locations: BranchLocation[] }>;
}
export type CoverageJson = Record<string, FileCoverage>;

const NOT_COUNTED = '網羅の数には入らない';
const unix = (p: string) => p.replace(/\\/g, '/');

/** 届いていない分岐の「file:line」。同じ分岐を、枝の行と分岐の文の行の両方で数える（節はどちらで書いてもよい）。 */
export function uncoveredOf(coverage: CoverageJson, root: string): { files: Set<string>; branches: string[][] } {
  const files = new Set<string>();
  const branches: string[][] = [];
  for (const [abs, cov] of Object.entries(coverage)) {
    const file = unix(path.isAbsolute(abs) ? path.relative(root, abs) : abs);
    files.add(file);
    for (const [id, counts] of Object.entries(cov.b)) {
      const map = cov.branchMap[id];
      counts.forEach((n, i) => {
        if (n !== 0) return;
        const arm = map.locations[i]?.start.line;
        const lines = new Set([arm, map.loc.start.line].filter((l): l is number => typeof l === 'number' && l > 0));
        branches.push([...lines].map((l) => `${file}:${l}`));
      });
    }
  }
  return { files, branches };
}

export interface CoverageProblems { unlisted: string[]; stale: string[] }

/** coverage の届かない分岐を、節（listed）と突き合わせる。 */
export function compareUncovered(coverage: CoverageJson, listed: UncoveredBranch[], root = process.cwd()): CoverageProblems {
  const { files, branches } = uncoveredOf(coverage, root);
  const listedKeys = new Set(listed.map((l) => `${unix(l.file)}:${l.line}`));
  const seen = new Set(branches.flat());
  const unlisted = branches.filter((keys) => !keys.some((k) => listedKeys.has(k))).map((keys) => keys[0]);
  // 今の網羅に出ていない（その実行の範囲外の）ファイルの行は、ずれとは言えないので見ない。
  const stale = listed
    .filter((l) => files.has(unix(l.file)) && !l.reason.includes(NOT_COUNTED) && !seen.has(`${unix(l.file)}:${l.line}`))
    .map((l) => `${unix(l.file)}:${l.line}`);
  return { unlisted: [...new Set(unlisted)], stale };
}

function main(argv: string[]): number {
  const coverageFile = argv[0] ?? 'coverage/coverage-final.json';
  const gapsFile = 'docs/05_Quality/reports/test-gaps.md';
  if (!fs.existsSync(coverageFile)) {
    console.error(`${coverageFile} が無い（先に npm run test:trace-coverage で網羅を測る）`);
    return 2;
  }
  const coverage = JSON.parse(fs.readFileSync(coverageFile, 'utf8')) as CoverageJson;
  const listed = parseUncovered(fs.readFileSync(gapsFile, 'utf8'));
  const { unlisted, stale } = compareUncovered(coverage, listed);
  for (const k of unlisted) console.log(`${k} 届かない分岐が ${gapsFile} の「届かない分岐」の節に無い`);
  for (const k of stale) console.log(`${k} 節にあるが、今は届いている（または行がずれた）。節を直す`);
  console.log(`届かない分岐: 節に無い ${unlisted.length} 件・ずれた ${stale.length} 件（節の行 ${listed.length} 件）`);
  return unlisted.length + stale.length > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
