// 速さを測る試験の名前はここだけで定める。
const suffix = '.timing.test.ts';

module.exports = {
  timingTestPattern: `${suffix.replace(/\./g, '\\.')}$`,
  timingTestMatch: [`**/tests/**/*${suffix}`],
};
