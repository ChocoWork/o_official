import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * DD-HOME-004: ブラウザ側の zod は `jitless` にする。
 * zod 4 はスキーマを作る時に `new Function("")` で eval の可否を探り、CSP が `unsafe-eval` を許さない
 * ブラウザでは「eval を拒否した」という違反が記録される。`src/instrumentation-client.ts` は
 * Next が全頁のハイドレーションより前にブラウザで 1 回実行するので、そこで `jitless` にすれば
 * 以降の `z.object` は eval を探らない。
 */
const FILE = join(process.cwd(), "src", "instrumentation-client.ts");

/** `Function` コンストラクターの呼び出し回数を数える Proxy に差し替えて、`run` を実行する */
function countFunctionConstructions(run: () => void): number {
  const RealFunction = global.Function;
  let calls = 0;
  global.Function = new Proxy(RealFunction, {
    construct(target, args, newTarget) {
      calls += 1;
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    run();
  } finally {
    global.Function = RealFunction;
  }
  return calls;
}

describe("src/instrumentation-client.ts", () => {
  it("DD-HOME-004 対照: 読み込まないと、zod のスキーマを作る時に new Function が呼ばれる", () => {
    let calls = 0;
    jest.isolateModules(() => {
      calls = countFunctionConstructions(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { z } = require("zod") as typeof import("zod");
        z.object({ a: z.string() }).parse({ a: "x" });
      });
    });
    expect(calls).toBeGreaterThan(0);
  });

  it("DD-HOME-004 読み込んだ後は、zod のスキーマを作って parse しても new Function が呼ばれない", () => {
    let calls = -1;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("@/instrumentation-client");
      calls = countFunctionConstructions(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { z } = require("zod") as typeof import("zod");
        const parsed = z.object({ a: z.string() }).parse({ a: "x" });
        expect(parsed).toEqual({ a: "x" });
      });
    });
    expect(calls).toBe(0);
  });

  it("DD-HOME-004 zod の全体の設定の jitless が true になる", () => {
    let jitless: boolean | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("@/instrumentation-client");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { z } = require("zod") as typeof import("zod");
      jitless = z.core.globalConfig.jitless;
    });
    expect(jitless).toBe(true);
  });

  it("DD-HOME-004 ファイルは zod の import と z.config({ jitless: true }) を呼ぶ関数の定義と呼び出しだけを持つ", () => {
    const code = readFileSync(FILE, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter((line) => line !== "");
    expect(code).toEqual([
      "import { z } from 'zod';",
      "export function disableZodEval(): void {",
      "z.config({ jitless: true });",
      "}",
      "disableZodEval();",
    ]);
  });
});
