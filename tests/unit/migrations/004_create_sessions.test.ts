const fs = require('fs');
const path = require('path');

describe('migrations/004_create_sessions.sql', () => {
  const file = path.join(__dirname, '../../../migrations/004_create_sessions.sql');
  test('file exists', () => {
    expect(fs.existsSync(file)).toBe(true);
  });

  let sql = '';
  beforeAll(() => {
    sql = fs.readFileSync(file, 'utf8').toLowerCase();
  });

  test('creates sessions table', () => {
    expect(sql).toMatch(/create table if not exists public\.sessions/);
  });

  test('has required columns', () => {
    expect(sql).toMatch(/id uuid primary key/);
    expect(sql).toMatch(/user_id uuid not null references auth.users\(id\)/);
    expect(sql).toMatch(/refresh_token_hash text not null/);
    expect(sql).toMatch(/current_jti text/);
    expect(sql).toMatch(/ip inet/);
    expect(sql).toMatch(/user_agent text/);
    expect(sql).toMatch(/device_name text/);
    expect(sql).toMatch(/created_at timestamptz not null default now\(\)/);
    expect(sql).toMatch(/expires_at timestamptz/);
    expect(sql).toMatch(/revoked_at timestamptz/);
    expect(sql).toMatch(/last_seen_at timestamptz/);
  });

  test('creates indexes', () => {
    expect(sql).toMatch(/create index if not exists idx_sessions_user_id on public\.sessions\(user_id\)/);
    expect(sql).toMatch(/create index if not exists idx_sessions_expires_at on public\.sessions\(expires_at\)/);
  });
});
