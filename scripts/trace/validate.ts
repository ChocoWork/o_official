// npm run validate-trace -- [AREA...] [--update-baseline] [--list-unmatched]
// 引数の領域（無ければ scope.json の全部）を検査し、違反を `file:line [rule] message` で出す。
// 既知の違反は scripts/trace/baseline.json の基準に持ち、基準より増えた違反があれば終了コード 1（基準にある物は「既知」と数えて出す）。
// --update-baseline は全領域の今の違反を基準に書く（直した後に基準を減らす時と、承認した違反を足す時に使う）。

import fs from 'node:fs';
import { diffViolations, violationKey, type Baseline } from './baseline';
import { loadModel, loadScope, unmatchedPatterns } from './load';
import { checkModel } from './rules';

export const BASELINE_FILE = 'scripts/trace/baseline.json';

export function readBaseline(file = BASELINE_FILE): Baseline {
  if (!fs.existsSync(file)) return { violations: [] };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<Baseline>;
  return { violations: raw.violations ?? [] };
}

function main(argv: string[]): number {
  const update = argv.includes('--update-baseline');
  const names = argv.filter((a) => !a.startsWith('--'));
  const all = loadScope();
  const unknown = names.filter((n) => !all.some((a) => a.area === n));
  if (unknown.length > 0) {
    console.error(`scope.json に無い領域: ${unknown.join(', ')}`);
    return 2;
  }
  if (update && names.length > 0) {
    console.error('--update-baseline は全領域の検査にだけ使える（領域を渡さない）');
    return 2;
  }
  const areas = names.length > 0 ? all.filter((a) => names.includes(a.area)) : all;
  // 将来のファイルの置き場として書いた型もあるので、件数だけ知らせる（--list-unmatched で一覧）。
  const unmatched = unmatchedPatterns(areas);
  if (unmatched.length > 0) console.error(`警告: どのファイルにも当たらない scope.json の型が ${unmatched.length} 個ある（打ち間違いなら直す。一覧は --list-unmatched）`);
  if (argv.includes('--list-unmatched')) for (const u of unmatched) console.log(`${u.area}: ${u.pattern}`);
  const violations = checkModel(loadModel(areas, process.cwd(), all));

  if (update) {
    const next: Baseline = { violations: violations.map(violationKey).sort() };
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 2) + '\n');
    console.log(`${BASELINE_FILE} に違反 ${next.violations.length} 件を書いた`);
    return 0;
  }

  const baseline = readBaseline();
  const { added, removed } = diffViolations(violations, baseline.violations);
  const addedSet = new Set(added);
  for (const v of violations) console.log(`${v.file}:${v.line} [${v.rule}] ${v.message}${addedSet.has(v) ? '' : '（既知）'}`);
  console.log(`違反 ${violations.length} 件（基準より増えた ${added.length} 件・既知 ${violations.length - added.length} 件）`);
  // 領域を絞ると、ほかの領域の基準は「減った」に見えるので、全領域の時だけ知らせる。
  if (names.length === 0 && removed.length > 0) {
    console.log(`基準にあって今は無い違反 ${removed.length} 件（直った。npm run validate-trace -- --update-baseline で基準から消す）`);
  }
  return added.length > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
