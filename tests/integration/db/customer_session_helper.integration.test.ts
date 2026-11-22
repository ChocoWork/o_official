/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DUMMY_CAPTCHA_TOKEN } from '../../../e2e/captcha-test-utils';
import { bindAppSession } from '../../../e2e/admin-session-test-utils';
import { signInCustomerWithoutPassword } from '../../../e2e/customer-session-test-utils';
import { withCustomerPasswordFlag } from '../../../e2e/passkey-hook-scenarios';
import { describeLocalDb, isLocalDatabase } from './helpers/local-db';

const apiUrl = process.env.LOCAL_SUPABASE_URL;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
jest.setTimeout(60000);
// bindAppSession（E2E の道具）は NEXT_PUBLIC_*・SUPABASE_SERVICE_ROLE_KEY を読むので、手元の値を渡す
if (apiUrl && anonKey && serviceKey) {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= serviceKey;
}

describeLocalDb('customer session helper（パスワード無しで会員の JWT を取る試験の手助け）', (db) => {
  if (!apiUrl || !serviceKey || !anonKey) {
    test.skip('LOCAL_SUPABASE_URL / LOCAL_SUPABASE_SERVICE_ROLE_KEY / LOCAL_SUPABASE_ANON_KEY が未設定', () => {});
    return;
  }
  if (!isLocalDatabase(apiUrl)) {
    test('localhost 以外の API には接続しない', () => { throw new Error('CUSTOMER_SESSION_HELPER_LOCAL_API_REQUIRED'); });
    return;
  }
  const service = createClient(apiUrl, serviceKey, options);
  const email = `customer-session-helper-${randomUUID()}@example.com`;
  const password = `Pw-${randomUUID()}-aA1!`;
  let userId = '';

  beforeAll(async () => {
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error('CUSTOMER_SESSION_HELPER_CREATE_FAILED');
    userId = created.data.user.id;
    const profile = await service.from('profiles').upsert({ user_id: userId, display_name: 'helper' });
    if (profile.error) throw new Error('CUSTOMER_SESSION_HELPER_PROFILE_FAILED');
  });
  afterAll(async () => {
    if (userId) {
      await service.from('profiles').delete().eq('user_id', userId);
      await service.auth.admin.deleteUser(userId);
    }
  });

  /** 会員の表の方針は、アプリの sessions に結び付いた JWT だけを通す。結び付けてから自分の行を読む */
  const readOwnRow = async (session: { accessToken: string; refreshToken: string }): Promise<{ id: string | undefined; error: unknown }> => {
    await bindAppSession(db(), { userId, accessToken: session.accessToken, refreshToken: session.refreshToken });
    const authenticated: SupabaseClient = createClient(apiUrl, anonKey, { ...options, global: { headers: { Authorization: `Bearer ${session.accessToken}` } } });
    const own = await authenticated.from('profiles').select('user_id').eq('user_id', userId).maybeSingle();
    return { id: own.data?.user_id as string | undefined, error: own.error };
  };

  test('旗が偽の時、会員の access_token が取れ、authenticated の PostgREST で自分の行が読める', async () => {
    await withCustomerPasswordFlag(db(), false, async () => {
      const session = await signInCustomerWithoutPassword(email);
      expect(session.userId).toBe(userId);
      expect(session.refreshToken).toBeTruthy();
      const own = await readOwnRow(session);
      expect(own.error).toBeNull();
      expect(own.id).toBe(userId);
    });
  });

  test('旗が真の時も、同じ道で会員の access_token が取れる', async () => {
    await withCustomerPasswordFlag(db(), true, async () => {
      const session = await signInCustomerWithoutPassword(email);
      expect(session.userId).toBe(userId);
      const own = await readOwnRow(session);
      expect(own.error).toBeNull();
      expect(own.id).toBe(userId);
    });
  });

  test('旗が真の時、匿名の鍵の signInWithPassword は拒否される（古い取り方は通らない）', async () => {
    await withCustomerPasswordFlag(db(), true, async () => {
      const anon = createClient(apiUrl, anonKey, options);
      const signedIn = await anon.auth.signInWithPassword({ email, password, options: { captchaToken: DUMMY_CAPTCHA_TOKEN } });
      expect(signedIn.data.session).toBeNull();
      expect(signedIn.error).not.toBeNull();
    });
  });
});
