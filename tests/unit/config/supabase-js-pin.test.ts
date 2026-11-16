/**
 * パスキー（ベータ）の型と関数は supabase-js 2.119.0 にだけある。
 * `^` を付けて上がると挙動が変わるので、版を固定したままか確かめる。
 */
import { createClient } from '@supabase/supabase-js';
import packageJson from '../../../package.json';

describe('supabase-js の固定（パスキー）', () => {
  it('DD-AUTH-043 package.json の supabase-js が 2.119.0 に固定されている（^ なし）', () => {
    expect(packageJson.dependencies['@supabase/supabase-js']).toBe('2.119.0');
  });

  it('DD-AUTH-043 パスキーの関数が使える', () => {
    const client = createClient('http://localhost:54321', 'k');
    expect(typeof client.auth.passkey.startRegistration).toBe('function');
    expect(typeof client.auth.admin.passkey.listPasskeys).toBe('function');
  });
});
