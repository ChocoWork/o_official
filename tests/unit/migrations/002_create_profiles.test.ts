const fs = require('fs');
const path = require('path');

describe('migrations/002_create_profiles.sql', () => {
  const file = path.join(__dirname, '../../../migrations/002_create_profiles.sql');
  test('file exists', () => {
    expect(fs.existsSync(file)).toBe(true);
  });

  let sql = '';
  beforeAll(() => {
    sql = fs.readFileSync(file, 'utf8').toLowerCase();
  });

  test('creates profiles table', () => {
    expect(sql).toMatch(/create table if not exists profiles/);
  });

  test('references auth.users', () => {
    expect(sql).toMatch(/references auth.users\(id\)/);
  });

  test('renames public.users to users_deprecated', () => {
    expect(sql).toMatch(/rename to users_deprecated/);
  });
});
