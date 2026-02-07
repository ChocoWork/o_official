const fs = require('fs');
const path = require('path');

describe('migrations/003_profiles_trigger.sql', () => {
  const file = path.join(__dirname, '../../../migrations/003_profiles_trigger.sql');
  test('file exists', () => {
    expect(fs.existsSync(file)).toBe(true);
  });

  let sql = '';
  beforeAll(() => {
    sql = fs.readFileSync(file, 'utf8').toLowerCase();
  });

  test('creates function create_profile_for_new_auth_user', () => {
    expect(sql).toMatch(/create or replace function public.create_profile_for_new_auth_user\(\)/);
  });

  test('function inserts into public.profiles with on conflict do nothing', () => {
    expect(sql).toMatch(/insert into public.profiles\(user_id, created_at\)/);
    expect(sql).toMatch(/on conflict \(user_id\) do nothing/);
  });

  test('creates trigger on auth.users', () => {
    expect(sql).toMatch(/create trigger tr_create_profile_on_auth_user_insert/);
    expect(sql).toMatch(/after insert on auth.users/);
  });

  test('function returns trigger and is security definer and language plpgsql', () => {
    expect(sql).toMatch(/returns trigger/);
    expect(sql).toMatch(/security definer/);
    expect(sql).toMatch(/language plpgsql/);
  });

  test('trigger executes create_profile_for_new_auth_user and drop-if-exists', () => {
    expect(sql).toMatch(/execute procedure public.create_profile_for_new_auth_user\(\)/);
    expect(sql).toMatch(/drop trigger if exists tr_create_profile_on_auth_user_insert/);
  });
});
