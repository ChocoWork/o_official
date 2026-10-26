import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * FREQ-540-AC-15: G-1 から 410 を返すだけだった旧い発送・仕上がりの 6 つの窓口（7 メソッド）が src に残らない（G-4 Task 8）。
 * 窓口が無ければ、権限の確認を通らずに実行できる道も無い（無い窓口は Next が 404 を返し、何も実行しない）。
 * DB の旧い 4 関数が LEGACY_FULFILLMENT_DISABLED で断ることは group_g1_legacy_disabled の DB 結合が確かめる。
 *
 * G-4 Task 8 の走査は src だけだった。Task 12 で e2e と tests にも広げた（最後の describe）。e2e に残る importer は 0 件、
 * tests に残る importer・固定の記号は、止めた store の関数と固定の文の試験・DB の旧い関数の拒否の試験の明示の許可リストだけ。
 * legacy-fulfillment-disabled.ts は、その許可リストの試験が使うので残す（使われなくなった legacyFulfillmentDisabledBody だけを消した）。
 */
const ROOT = path.resolve(__dirname, '../../../..');
const SRC = path.join(ROOT, 'src');
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

/**
 * e2e と tests の走査（G-4 Task 12）。旧い窓口は無いので、書いてよいのは次の許可リストだけ。
 * - 旧い窓口の URL: 「窓口は存在しない（404）」を本物の HTTP で確かめる期待を書く試験の行（ファイルごとの行数まで固定する）
 * - 固定の記号 LEGACY_FULFILLMENT_DISABLED: DB の旧い関数の拒否の DB 結合（tests/integration/db）と、止めた store の関数・固定の文・
 *   その記号を投げる道具の試験
 */
describe('FREQ-540-AC-15: e2e と tests に、旧い窓口の URL・旧い停止の記号を書くのは許可リストの試験だけ', () => {
  const skip = new Set(['node_modules', 'test-results', 'playwright-report']);
  const scan = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      if (skip.has(name)) return [];
      const full = path.join(directory, name);
      return statSync(full).isDirectory() ? scan(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  const files = ['e2e', 'tests'].flatMap((directory) => scan(path.join(ROOT, directory))).map((file) => ({
    file: path.relative(ROOT, file).split(path.sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }));
  const countsOf = (pattern: RegExp): Record<string, number> =>
    Object.fromEntries(
      files
        .map(({ file, text }) => [file, text.split('\n').filter((line) => pattern.test(line)).length] as const)
        .filter(([, count]) => count > 0)
        .sort(([a], [b]) => a.localeCompare(b)),
    );

  /** 旧い6つの窓口の URL を書いてよい行の数。どれも本物の HTTP が 404 になることを期待する行（STOPPED_OPERATIONS など） */
  const ALLOWED_404_URL_LINES: Record<string, number> = {
    'e2e/FR-ADMIN-117-shipment-slip-actions.spec.ts': 4,
    'e2e/FR-ADMIN-123-group-g-permissions.spec.ts': 11,
  };
  /** 固定の記号を書いてよい試験（DB の旧い関数の拒否の DB 結合は tests/integration/db の下ならどれでもよい） */
  const ALLOWED_SYMBOL_FILES = [
    'e2e/group-g1-test-utils.ts',
    'e2e/order-email-test-utils.ts',
    'tests/unit/api/admin/legacy-fulfillment-routes-removed.test.ts',
    'tests/unit/components/AdminGroupG1LegacyStop.test.tsx',
    'tests/unit/docs/delivery-status-traceability.test.ts',
    'tests/unit/e2e/group-g1-test-utils.test.ts',
    'tests/unit/lib/orders/fulfillment/fulfillment-materials.test.ts',
    'tests/unit/lib/orders/fulfillment/fulfillment-store.test.ts',
    'tests/unit/lib/orders/shipment-slips/shipment-slip-types.test.ts',
    'tests/unit/lib/orders/tracking/delivery-store.test.ts',
  ];
  /** legacy-fulfillment-disabled を import してよい tests（止めた store の関数・固定の文の試験）。e2e は 1 件も無い */
  const ALLOWED_IMPORTERS = [
    'tests/integration/db/fulfillment_postgrest.integration.test.ts',
    'tests/unit/components/AdminGroupG1LegacyStop.test.tsx',
    'tests/unit/lib/orders/fulfillment/fulfillment-materials.test.ts',
    'tests/unit/lib/orders/fulfillment/fulfillment-store.test.ts',
    'tests/unit/lib/orders/shipment-slips/shipment-slip-types.test.ts',
  ];

  test('e2e と tests を走査できている', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some(({ file }) => file.startsWith('e2e/'))).toBe(true);
    expect(files.some(({ file }) => file.startsWith('tests/integration/db/'))).toBe(true);
  });

  test('旧い窓口の URL を書いた行は、404 を期待する許可リストの行だけ', () => {
    expect(countsOf(/orders\/\$\{[^}]*\}\/(completions|fulfillments)/)).toEqual(ALLOWED_404_URL_LINES);
    for (const file of Object.keys(ALLOWED_404_URL_LINES)) {
      // 許可した試験は、窓口が存在しない（404）ことを期待している
      expect({ file, expects404: /\b404\b/.test(files.find((entry) => entry.file === file)?.text ?? '') }).toEqual({ file, expects404: true });
    }
  });

  test('LEGACY_FULFILLMENT_DISABLED の記号を書くのは、DB の旧い関数の拒否の DB 結合と許可リストの試験だけ', () => {
    const written = Object.keys(countsOf(/LEGACY_FULFILLMENT_DISABLED/)).filter((file) => !file.startsWith('tests/integration/db/'));
    expect(written).toEqual([...ALLOWED_SYMBOL_FILES].sort());
  });

  test('legacy-fulfillment-disabled の importer は、e2e に無く、tests は許可リストだけ', () => {
    const importers = Object.keys(countsOf(/legacy-fulfillment-disabled['"]/));
    expect(importers.filter((file) => file.startsWith('e2e/'))).toEqual([]);
    expect(importers).toEqual([...ALLOWED_IMPORTERS].sort());
  });
});
