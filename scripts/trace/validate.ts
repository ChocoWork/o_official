// npm run validate-trace -- [AREA...]
// 引数の領域（無ければ scope.json の全部）を検査し、違反を `file:line [rule] message` で出す。
// 違反が1つでもあれば終了コード 1。

import { loadModel, loadScope } from './load';
import { checkModel } from './rules';

const names = process.argv.slice(2);
const all = loadScope();
const unknown = names.filter((n) => !all.some((a) => a.area === n));
if (unknown.length > 0) {
  console.error(`scope.json に無い領域: ${unknown.join(', ')}`);
  process.exit(2);
}
const areas = names.length > 0 ? all.filter((a) => names.includes(a.area)) : all;
const violations = checkModel(loadModel(areas));
for (const v of violations) console.log(`${v.file}:${v.line} [${v.rule}] ${v.message}`);
process.exitCode = violations.length > 0 ? 1 : 0;
