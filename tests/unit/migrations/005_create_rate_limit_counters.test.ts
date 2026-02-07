const fs = require('fs');
const path = require('path');

describe('migrations/005_create_rate_limit_counters.sql', () => {
  const file = path.join(__dirname, '../../../migrations/005_create_rate_limit_counters.sql');
  test('file exists', () => {
    expect(fs.existsSync(file)).toBe(true);
  });

  let sql = '';
  beforeAll(() => {
    sql = fs.readFileSync(file, 'utf8').toLowerCase();
  });

  test('creates rate_limit_counters table with required columns and unique constraint', () => {
    expect(sql).toMatch(/create table if not exists public\.rate_limit_counters/);
    expect(sql).toMatch(/ip inet/);
    expect(sql).toMatch(/endpoint text not null/);
    expect(sql).toMatch(/bucket timestamptz not null/);
    expect(sql).toMatch(/count integer not null default 1/);
    expect(sql).toMatch(/constraint rate_limit_counters_unique unique\(ip, endpoint, bucket\)/);
  });

  test('creates indexes on (ip, endpoint, bucket) and bucket', () => {
    expect(sql).toMatch(/create index if not exists idx_rate_limit_ip_endpoint_bucket on public\.rate_limit_counters \(ip, endpoint, bucket\)/);
    expect(sql).toMatch(/create index if not exists idx_rate_limit_bucket on public\.rate_limit_counters \(bucket\)/);
  });
});
