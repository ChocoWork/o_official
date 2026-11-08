import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const jest = require.resolve('jest/bin/jest');
const args = process.argv.slice(2);
// 設定を差し替える・終わらない・結果を上書きする引数は2段と合わないので止める。直に `npx jest` を使う。
const unsupported = args.filter((arg) => /^(-c|--config|--watch|--watchAll|--coverage|--collectCoverage)(=|$)/.test(arg));
if (unsupported.length > 0) {
  console.error(`npm test には ${unsupported.join(' ')} を渡せない。npx jest（速さの試験は npx jest -c jest.timing.config.cjs）を直に使う。`);
  process.exit(2);
}
const stages = [
  { label: '通常の試験（並列）', config: 'jest.config.cjs', args: [] },
  { label: '速さを測る試験（1本ずつ）', config: 'jest.timing.config.cjs', args: ['--runInBand', '--passWithNoTests'] },
];

for (const stage of stages) {
  console.log(`[test] ${stage.label}`);
  // Windows でもシェルを介さず、引数をそのまま Jest に渡す。
  const result = spawnSync(process.execPath, [
    jest,
    ...args,
    '--config', fileURLToPath(new URL(`../../${stage.config}`, import.meta.url)),
    ...stage.args,
  ], { stdio: 'inherit' });

  if (result.error) {
    console.error('Jest を起動できませんでした:', result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
