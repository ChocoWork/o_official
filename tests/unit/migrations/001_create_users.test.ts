const fs = require('fs');
const path = require('path');

describe.skip('migrations/001_create_users.sql (DEPRECATED)', () => {
  const file = path.join(__dirname, '../../../migrations/001_create_users.sql');
  test('file exists', () => {
    expect(fs.existsSync(file)).toBe(true);
  });

  let sql = '';
  beforeAll(() => {
    sql = fs.readFileSync(file, 'utf8').toLowerCase();
  });

  test('creates users table', () => {
    expect(sql).toMatch(/create table if not exists users/);
  });

  test('has email unique not null', () => {
    expect(sql).toMatch(/email\s+text\s+unique\s+not null/);
  });

  test('has password_hash', () => {
    expect(sql).toMatch(/password_hash\s+text\s+not null/);
  });

  test('has address jsonb column', () => {
    expect(sql).toMatch(/address\s+jsonb/);
  });

  test('has created_at timestamptz default now', () => {
    expect(sql).toMatch(/created_at\s+timestamptz\s+default now\(\)/);
  });
});
