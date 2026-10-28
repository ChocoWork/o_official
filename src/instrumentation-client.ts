/**
 * ブラウザ側の zod の設定（src/instrumentation-client.ts）。Next が全頁のハイドレーションより前にブラウザで 1 回実行する。
 *
 * @packageDocumentation
 */
import { z } from 'zod';

/**
 * ブラウザ側の zod を `jitless` にして、スキーマを作る時の eval の探りを止める。
 *
 * @impl IMPL-HOME-104
 * @design DD-HOME-004
 * @remarks zod 4 はスキーマを作る時に `new Function("")` で eval の可否を探り、CSP が `unsafe-eval` を許さないブラウザでは
 * 違反が記録される。探りは最初の `z.object` で走るので、それより前に `jitless` にする必要があり、zod を使う入口は 100 を超えるため、
 * 全頁より前に走るこのファイルに 1 か所だけ置く。関数に包むのは、トレースの検査が関数の無い `.ts` を単位に数えないため。
 */
export function disableZodEval(): void {
  z.config({ jitless: true });
}

disableZodEval();
