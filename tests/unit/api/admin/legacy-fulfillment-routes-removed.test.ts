import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * FREQ-540-AC-15: G-1 から 410 を返すだけだった旧い発送・仕上がりの 6 つの窓口（7 メソッド）が src に残らない（G-4 Task 8）。
 * 窓口が無ければ、権限の確認を通らずに実行できる道も無い（無い窓口は Next が 404 を返し、何も実行しない）。
 * DB の旧い 4 関数が LEGACY_FULFILLMENT_DISABLED で断ることは group_g1_legacy_disabled の DB 結合が確かめる。
 *
 * この Task の走査は src だけ。e2e と tests に残る importer・期待〔FR-ADMIN-069・070・117・123 と delivery-tracking-test-utils〕は
 * Task 10・12 が付け替え、legacy-fulfillment-disabled.ts を消せるかは Task 12 の最後に、src・e2e・tests の全部で決める。
 */
const SRC = path.resolve(__dirname, '../../../../src');
const ORDERS_API = path.join(SRC, 'app', 'api', 'admin', 'orders', '[id]');
const LEGACY_MODULE = 'lib/orders/fulfillment/legacy-fulfillment-disabled.ts';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const REMOVED_ROUTES = [
  ['completions', 'route.ts'],
  ['completions', '[completionId]', 'cancel', 'route.ts'],
  ['fulfillments', 'route.ts'],
  ['fulfillments', '[fulfillmentId]', 'cancel', 'route.ts'],
  ['fulfillments', '[fulfillmentId]', 'tracking', 'route.ts'],
  ['fulfillments', '[fulfillmentId]', 'delivered', 'route.ts'],
] as const;

test('FREQ-540-AC-15: 旧い窓口の6ファイルが存在しない', () => {
  for (const segments of REMOVED_ROUTES) {
    expect({ file: segments.join('/'), exists: existsSync(path.join(ORDERS_API, ...segments)) }).toEqual({ file: segments.join('/'), exists: false });
  }
  expect(existsSync(path.join(ORDERS_API, 'completions'))).toBe(false);
  expect(existsSync(path.join(ORDERS_API, 'fulfillments'))).toBe(false);
  // 残る窓口（注文の詳細・履歴・入替）は消えていない
  for (const kept of [['route.ts'], ['history', 'route.ts'], ['allocations', 'swap', 'route.ts'], ['status', 'route.ts']]) {
    expect(existsSync(path.join(ORDERS_API, ...kept))).toBe(true);
  }
});

describe('FREQ-540-AC-15: src に旧い窓口の URL・旧い停止文・旧クライアントの名前が無い', () => {
  const files = sourceFiles(SRC).map((file) => ({
    file: path.relative(SRC, file).split(path.sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }));
  const hits = (pattern: RegExp): string[] => files.filter(({ text }) => pattern.test(text)).map(({ file }) => file).sort();

  test('src を走査できている', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.map(({ file }) => file)).toContain(LEGACY_MODULE);
  });

  test('旧い窓口の URL（…/completions・…/fulfillments）が0件', () => {
    expect(hits(/\/(completions|fulfillments)\b/)).toEqual([]);
  });

  test.each([
    ['callFulfillmentApi', /\bcallFulfillmentApi\b/],
    ['fetchFulfillmentMaterials', /\bfetchFulfillmentMaterials\b/],
    ['submitTrackingEdit', /\bsubmitTrackingEdit\b/],
    ['submitManualDelivered', /\bsubmitManualDelivered\b/],
    ['COMPLETION_RECORDED_MESSAGE', /\bCOMPLETION_RECORDED_MESSAGE\b/],
    ['NO_COMPLETION_QUANTITY_MESSAGE', /\bNO_COMPLETION_QUANTITY_MESSAGE\b/],
  ])('旧クライアントの名前 %s が0件', (_name, pattern) => {
    expect(hits(pattern)).toEqual([]);
  });

  test('旧い停止文と 410 の本文の組立ては、定義の1ファイルの中だけにある（窓口が使っていない）', () => {
    expect(hits(/\b(LEGACY_FULFILLMENT_DISABLED_TEXT|MANUAL_COMPLETION_DISABLED_TEXT|legacyFulfillmentDisabledBody)\b/)).toEqual([LEGACY_MODULE]);
  });

  test('legacy-fulfillment-disabled を import するのは、DB を呼ばずに投げる fulfillment-materials.ts と fulfillment-store.ts だけ（明示の許可）', () => {
    expect(hits(/legacy-fulfillment-disabled['"]/)).toEqual([
      'lib/orders/fulfillment/fulfillment-materials.ts',
      'lib/orders/fulfillment/fulfillment-store.ts',
    ]);
  });
});
