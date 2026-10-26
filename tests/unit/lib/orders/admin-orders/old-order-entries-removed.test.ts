import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * FREQ-540-AC-15: 旧い一覧・旧い CSV・旧い絞り込みの入口が src に残らない（G-4 Task 7）。
 * 旧い一覧の部品・窓口の呼出し・CSV の組立てが一つでも残れば、権限の確認を通らない道が残る。
 */
const SRC = path.resolve(__dirname, '../../../../../src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe('FREQ-540-AC-15: 旧い入口の名前が src に0件', () => {
  const files = sourceFiles(SRC).map((file) => ({ file: path.relative(SRC, file), text: readFileSync(file, 'utf8') }));
  const hits = (pattern: RegExp): string[] => files.filter(({ text }) => pattern.test(text)).map(({ file }) => file);

  test('src を走査できている', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.map(({ file }) => file)).toContain(path.join('app', 'admin', 'page.tsx'));
  });

  test.each([
    ['OrderSection（旧い一覧の部品）', /\bOrderSection\b/],
    ['handleExportOrdersCsv（旧CSV）', /\bhandleExportOrdersCsv\b/],
    ['ORDER_CSV_HEADERS（旧CSVの11列）', /\bORDER_CSV_HEADERS\b/],
    ['formatOrderItems（旧CSVの商品欄）', /\bformatOrderItems\b/],
    ['/api/admin/orders? の呼出し（旧い一覧の窓口）', /\/api\/admin\/orders\?/],
    ['ORDER_STATUS_FILTERS（旧い絞り込み）', /\bORDER_STATUS_FILTERS\b/],
    ['RETURN_FILTER_OPTIONS（旧い返品の絞り込み）', /\bRETURN_FILTER_OPTIONS\b/],
  ])('%s が0件', (_label, pattern) => {
    expect(hits(pattern)).toEqual([]);
  });

  test('旧い一覧の部品・窓口のファイルが無い。注文の詳細（/api/admin/orders/[id]）の窓口は残る', () => {
    expect(existsSync(path.join(SRC, 'components', 'OrderSection.tsx'))).toBe(false);
    expect(existsSync(path.join(SRC, 'app', 'api', 'admin', 'orders', 'route.ts'))).toBe(false);
    expect(existsSync(path.join(SRC, 'app', 'api', 'admin', 'orders', '[id]', 'route.ts'))).toBe(true);
    expect(existsSync(path.join(SRC, 'app', 'api', 'admin', 'order-items', 'route.ts'))).toBe(true);
  });
});
