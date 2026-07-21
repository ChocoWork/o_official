const fs = require('fs');
const path = require('path');

// FREQ-186: POPULAR ITEMS の並び順（購入数降順）と権限は RPC 定義で担保する。
// 購入数は API に出さないため HTTP からは観測できず、ここで SQL 定義を検証する。
describe('migrations/060_create_get_popular_items_rpc.sql', () => {
  const file = path.join(__dirname, '../../../migrations/060_create_get_popular_items_rpc.sql');

  test('file exists', () => {
    expect(fs.existsSync(file)).toBe(true);
  });

  let sql = '';
  beforeAll(() => {
    sql = fs.readFileSync(file, 'utf8').toLowerCase();
  });

  test('creates get_popular_items with a limit_count argument', () => {
    expect(sql).toMatch(/create or replace function public\.get_popular_items/);
    expect(sql).toMatch(/limit_count\s+int/);
    expect(sql).toMatch(/limit limit_count/);
  });

  test('counts only paid orders as purchases', () => {
    expect(sql).toMatch(/sum\(oi\.quantity\)/);
    expect(sql).toMatch(/join orders as o on o\.id = oi\.order_id/);
    expect(sql).toMatch(/where o\.status = 'paid'/);
  });

  test('returns published items ordered by purchase count desc, then newest', () => {
    expect(sql).toMatch(/where i\.status = 'published'/);
    expect(sql).toMatch(/order by coalesce\(paid\.purchase_count, 0\) desc, i\.created_at desc/);
  });

  test('keeps items without purchases in the result via left join', () => {
    expect(sql).toMatch(/left join \(/);
    expect(sql).toMatch(/coalesce\(paid\.purchase_count, 0\)/);
  });

  test('grants execute to service_role only', () => {
    expect(sql).toMatch(/security invoker/);
    expect(sql).toMatch(/revoke all on function public\.get_popular_items\(int\) from public/);
    expect(sql).toMatch(/revoke execute on function public\.get_popular_items\(int\) from anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.get_popular_items\(int\) to service_role/);
  });
});
